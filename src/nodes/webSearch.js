/**
 * Web Search Node - Extracted with graceful degradation
 * 
 * Performs web search for factual queries.
 * Works with or without MCP adapter:
 * - With MCP: Uses web-search service
 * - Without MCP: Returns empty results
 */

const http = require('http');
const https = require('https');
const { SCRIPTURE_REF_RE } = require('../utils/textPatterns.cjs');

const WEB_SEARCH_PORT = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
const WS_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY || process.env.MCP_WEBSEARCH_API_KEY || process.env.MCP_API_KEY || '';

// SSE call to /web.search stream:true — progress events ({type:'engine'}
// chain transitions, {type:'items'} partial results) go to onEvent; resolves
// with the {type:'done'} payload ({results, aiOverview, provider, …}), which
// is the same shape mcpAdapter.callService returns under .data. Null on
// failure — the caller falls back to the adapter's plain-JSON path.
function _postSearchSse(payload, timeoutMs, onEvent) {
  return new Promise((resolve) => {
    if (!WS_API_KEY) return resolve(null);
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'web-search', action: 'web.search',
      payload, requestId: 'sg_ws_' + Date.now(), context: { userId: 'local_user' },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: WEB_SEARCH_PORT, path: '/web.search', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${WS_API_KEY}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.type === 'done') { req.destroy(); resolve(ev.data); return; }
              if (onEvent) onEvent(ev);
            } catch (_) {}
          }
        }
      });
      res.on('end', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// Scripture lookup fast path — bible-api.com (free, no key). Google's AI
// Overview only returns verse fragments for full-chapter asks; the API
// returns the complete passage deterministically. Null → normal SERP.
function _fetchBiblePassage(ref, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const url = `https://bible-api.com/${encodeURIComponent(String(ref).trim().slice(0, 40))}`;
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error || !j.text) return resolve(null);
          resolve(`${(j.reference || ref).trim()}\n\n${j.text.trim()}`);
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

module.exports = async function webSearch(state) {
  const { mcpAdapter, message } = state;
  const logger = state.logger || console;

  logger.debug('[Node:WebSearch] Performing web search...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:WebSearch] No MCP adapter - skipping web search');
    return {
      ...state,
      searchResults: [],
      contextDocs: []
    };
  }

  try {
    // Extract search query — prepend _dataPrefix (injected by multi-intent queue runner) if present
    let query = (state._dataPrefix ? state._dataPrefix + ' ' : '') +
                message.replace(/^(search for|search|find|look up|google)\s+/i, '').trim();

    // ── Screen follow-up: inject screen subject into query ───────────────────
    // classifyTask already resolved the concrete subject via LLM — trust it directly.
    // No regex: the isScreenFollowUp flag IS the signal. Prepend subject so search is concrete.
    // Guard: only use screen context when followUpTarget is explicitly resolved by the LLM.
    // If followUpTarget is null, the LLM could not identify a screen subject — do NOT fall back
    // to appName/windowTitle, which would inject unrelated context (e.g. "Warp" or "yarn")
    // into queries that are actually conversation follow-ups ("check for me now").
    const tc = state._taskClassification || {};
    if (tc.isScreenFollowUp && tc.followUpTarget) {
      query = `${tc.followUpTarget} ${query}`;
      logger.info(`[Node:WebSearch] isScreenFollowUp — prepended subject: "${query}"`);
    }

    // ── Conversation follow-up: replace query with resolved target ────────────
    // When the LLM resolved a concrete subject from conversation history
    // (e.g. "weather in russia" from "check for me now" after a Russia weather query),
    // use followUpTarget as the search query directly — the raw message has no topic signal.
    // GUARD: skip when intentPlan has multiple entries — decomposePrompt already produced
    // specific per-intent queries. Replacing them with the single followUpTarget would
    // cause every pipeline step to search for the same stale topic (e.g. all steps fire
    // "India weather" instead of China/America/India respectively).
    const isResolvedSubPrompt = Array.isArray(state.intentPlan) && state.intentPlan.length > 1;
    if (!tc.isScreenFollowUp && tc.isFollowUp && tc.followUpTarget && !isResolvedSubPrompt) {
      // If original message contains visual/show intent keywords, use it for web-search classification
      // The web-search service has its own intent classifier that detects images, art, etc.
      const visualIntentPattern = /\b(show|see|look|pics?|pictures?|images?|photos?|art|artwork|drawings?|visual|gallery)\b/i;
      if (visualIntentPattern.test(message)) {
        // Keep the visual phrasing (the service's classifier keys off it) but
        // prepend the resolved topic — the raw message ("show me some pics")
        // alone is context-free and returns random stock results.
        const cleanedMsg = message.replace(/^(search for|search|find|look up|google)\s+/i, '').trim();
        query = cleanedMsg.toLowerCase().includes(String(tc.followUpTarget).toLowerCase())
          ? cleanedMsg
          : `${tc.followUpTarget} ${cleanedMsg}`;
        logger.info(`[Node:WebSearch] isFollowUp with visual intent — query resolved to topic: "${query}"`);
      } else {
        query = tc.followUpTarget;
        logger.info(`[Node:WebSearch] isFollowUp — using followUpTarget as query: "${query}"`);
      }
    }

    // ── Media-listing hint (media-search guard in decomposePromptV2) ─────────
    // Image/video intents ride the SERP auto-chain — google-serp extracts
    // inline media cards (+tbm=isch hop for image intent). `intent` is sent as
    // a hint so the service-side classifier (English-regex) still fires the
    // image-grid hop for non-English queries its patterns can't match.
    const _mediaListing = state._mediaListing || (state._taskClassification || {}).mediaListing || 'none';
    const _intentHint = _mediaListing === 'video' ? 'video'
      : _mediaListing === 'image' ? 'image'
      : null;
    if (_mediaListing === 'video' && !/\b(videos?|tutorial|episode|sermon|clip)s?\b/i.test(query)) {
      query = `${query} videos`;
      logger.info(`[Node:WebSearch] mediaListing=video — appended video keyword: "${query}"`);
    }

    // ── Original-language search ────────────────────────────────────────────
    // comms-graph translates prompts to English before the handoff; searching
    // the translation returns English sources even for native speakers. When
    // a non-English original exists, search IT — the SERP skews to native
    // sources (Baidu/Temu-class domains) and the AI Overview arrives in the
    // user's language (making the answer-node overview short-circuit usable).
    const _searchLang = (state.detectedLanguage && state.detectedLanguage !== 'en')
      ? state.detectedLanguage : null;
    if (_searchLang && typeof state.originalPrompt === 'string' && state.originalPrompt.trim()) {
      // Follow-ups resolved via followUpTarget are context-free in ANY language —
      // prepend the resolved target so the query stays concrete.
      const _isFollowUp = tc.isFollowUp === true
        || (_mediaListing !== 'none' && tc.isScreenFollowUp !== true && /(images?|pictures?|photos?|videos?|clips?|tutorials?)/i.test(query));
      const _isResolvedSub = state._workflowPlan?.execution?.strategy === 'workflow_sequence';
      const _orig = (!tc.isScreenFollowUp && _isFollowUp && tc.followUpTarget && !_isResolvedSub)
        ? `${tc.followUpTarget} ${state.originalPrompt.trim()}`
        : state.originalPrompt.trim();
      if (_orig) {
        query = _orig;
        logger.info(`[Node:WebSearch] original-language query (${_searchLang}): "${query.slice(0, 80)}"`);
      }
    }

    logger.debug(`[Node:WebSearch] Query: "${query}"`);

    // Scripture lookup → bible-api.com fast path. Covers follow-ups the
    // express lane abstains on ("show full chapter") — the Overview only
    // returns verse fragments; the API returns the complete passage.
    const scriptureRef = query.match(SCRIPTURE_REF_RE);
    if (scriptureRef) {
      const passage = await _fetchBiblePassage(scriptureRef[0]);
      if (passage) {
        logger.info(`[Node:WebSearch] scripture → bible-api "${scriptureRef[0]}" (${passage.length} chars)`);
        return {
          ...state,
          searchResults: [],
          contextDocs: [],
          aiOverview: passage,
          searchProvider: 'bible-api',
        };
      }
      logger.warn(`[Node:WebSearch] bible-api miss for "${scriptureRef[0]}" — normal SERP`);
    }

    // Signal the overlay that a SERP fetch is in flight — the renderer shows
    // a loading engine chip until the real \x00ENGINE\x00 sentinel arrives.
    if (typeof state.streamCallback === 'function') {
      try { state.streamCallback('\x00SEARCHING\x00google-serp'); } catch (_) {}
    }

    // Call web-search service. NOTE: the route reads `maxResults` (not `limit`).
    // stream:true via SSE first — engine transitions + partial items ride
    // streamCallback as sentinels so favicon chips/cards appear mid-fetch.
    // Falls back to the adapter's plain-JSON call when SSE can't connect.
    const _searchArgs = () => ({
      query,
      limit: _mediaListing === 'video' ? 8 : 3,
      ...(_mediaListing === 'video' ? { maxResults: 8 } : {}),
      ...(_intentHint ? { intent: _intentHint } : {}),
      ...(_searchLang ? { lang: _searchLang } : {}),
      stream: true,
    });
    const _streamHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
    const _onSerpEvent = (ev) => {
      if (typeof state.streamCallback !== 'function') return;
      try {
        if (ev.type === 'engine' && ev.engine) {
          state.streamCallback('\x00SEARCHING\x00' + ev.engine);
        } else if (ev.type === 'items') {
          if (Array.isArray(ev.items) && ev.items.length) {
            const items = ev.items.map(r => ({
              title: r.title || undefined,
              url: (r.url || r.link || '').startsWith('http') ? (r.url || r.link) : undefined,
              thumbnail: (typeof r.thumbnail === 'string' ? r.thumbnail : r.thumbnail?.src) || undefined,
              imageUrl: r.imageUrl || undefined,
              snippet: r.snippet || r.description || undefined,
              hostname: r.displayDomain || _streamHost(r.url || r.link || '') || undefined,
              mediaType: r.type === 'video' ? 'video' : undefined,
              duration: r.duration || undefined,
              channel: r.channel || undefined,
            })).filter(i => i.url || i.imageUrl);
            if (items.length) state.streamCallback('\x00ITEMS\x00' + JSON.stringify(items));
          }
          const srcs = (Array.isArray(ev.sources) && ev.sources.length ? ev.sources
            : (Array.isArray(ev.items) ? ev.items : [])
              .filter(r => (r.url || r.link || '').startsWith('http'))
              .map(r => ({ url: r.url || r.link, hostname: r.displayDomain || _streamHost(r.url || r.link), title: r.title || '' })));
          if (srcs.length) state.streamCallback('\x00SOURCES\x00' + JSON.stringify(srcs));
        }
      } catch (_) {}
    };
    let result = await _postSearchSse(_searchArgs(), 20000, _onSerpEvent);
    if (!result) {
      const args = _searchArgs();
      delete args.stream;
      result = await mcpAdapter.callService('web-search', 'web.search', args);
    }

    // MCP protocol wraps response in 'data' field
    const searchData = result.data || result;
    const searchResults = searchData.results || [];
    
    logger.debug(`[Node:WebSearch] Found ${searchResults.length} results`);

    // Map search results to contextDocs, with special handling for image and
    // video results. Video results carry thumbnails + duration + channel that
    // the answer node emits as media cards via the \x00ITEMS\x00 sentinel.
    const contextDocs = searchResults.map(r => {
      // Legacy Brave shapes: 'image-result'/'video-result'. New SERP shapes:
      // 'image'/'video'/'news' with flat thumbnail/duration fields.
      const isImageResult = r.type === 'image-result' || r.type === 'image';
      const isVideoResult = r.type === 'video-result' || r.type === 'video';
      const imageUrl = isImageResult
        ? (r.metadata?.properties?.url || r.thumbnail || r.imageUrl || null) : null;
      const originalUrl = isImageResult
        ? (r.metadata?.properties?.originalUrl || r.originalUrl || null) : null;
      // Video results: thumbnail may be under metadata.thumbnail.src, r.thumbnail.src,
      // or (SERP) flat r.thumbnail
      const videoThumb = isVideoResult
        ? (r.metadata?.thumbnail?.src || r.thumbnail?.src || r.metadata?.properties?.thumbnail
            || (typeof r.thumbnail === 'string' ? r.thumbnail : null))
        : null;
      // News/article results also carry thumbnails sometimes.
      const articleThumb = (!isImageResult && !isVideoResult)
        ? (r.metadata?.thumbnail?.src || (typeof r.thumbnail === 'string' ? r.thumbnail : null))
        : null;
      const thumb = videoThumb || articleThumb;

      return {
        id: r.url || r.link,
        text: `${r.title}\n${r.snippet || r.description || ''}`,
        source: 'web_search',
        url: r.url || r.link,
        title: r.title || '',
        snippet: r.snippet || r.description || '',
        // Real destination host from the SERP cite row — r.url is often a
        // wrapped google.com/goto link whose hostname renders 'google.com'.
        ...(r.displayDomain && { displayDomain: r.displayDomain }),
        ...(r.rating !== undefined && { rating: r.rating, ratingMax: r.ratingMax }),
        ...(r.reviewCount !== undefined && { reviewCount: r.reviewCount }),
        ...(r.priceRange && { priceRange: r.priceRange }),
        // Include image URL for image search results so they can be displayed
        // imageUrl is the Brave thumbnail (reliable CDN), originalUrl is the source page
        ...(imageUrl && { imageUrl, isImage: true }),
        ...(originalUrl && { originalUrl }),
        // Video metadata — surfaced as media cards by the answer node.
        ...(isVideoResult && {
          mediaType: 'video',
          imageUrl: videoThumb || undefined,
          duration: r.metadata?.duration || r.duration || undefined,
          channel: r.metadata?.channel || r.channel || undefined,
        }),
        // Article thumbnails (non-image, non-video) — render as card images.
        ...(!isImageResult && !isVideoResult && articleThumb && { imageUrl: articleThumb }),
      };
    });

    // AI Overview (google-serp/bing-serp) — answer.js short-circuits on this.
    // When every free provider is down, the service returns searchUnavailable
    // + a connect-an-API guidance message — route it through the same
    // short-circuit so the user sees it verbatim instead of an LLM guess.
    let aiOverview = typeof searchData.aiOverview === 'string' && searchData.aiOverview.trim()
      ? searchData.aiOverview.trim() : null;
    if (!aiOverview && searchData.searchUnavailable && typeof searchData.userMessage === 'string' && searchData.userMessage.trim()) {
      aiOverview = searchData.userMessage.trim();
    }
    if (aiOverview) logger.info(`[Node:WebSearch] aiOverview captured (${aiOverview.length} chars)`);

    return {
      ...state,
      searchResults,
      contextDocs,
      aiOverview,
      // Serving engine — surfaced on the queue card's engine chip so the
      // user can see which provider answered (google/bing/copilot/brave…).
      searchProvider: typeof searchData.provider === 'string' ? searchData.provider : null,
    };
  } catch (error) {
    logger.error('[Node:WebSearch] Error:', error.message);
    return {
      ...state,
      searchResults: [],
      contextDocs: [],
      error: error.message
    };
  }
};

/**
 * Web Search Node - Extracted with graceful degradation
 * 
 * Performs web search for factual queries.
 * Works with or without MCP adapter:
 * - With MCP: Uses web-search service
 * - Without MCP: Returns empty results
 */

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

    // Call web-search service. NOTE: the route reads `maxResults` (not `limit`).
    const _searchArgs = () => ({
      query,
      limit: _mediaListing === 'video' ? 8 : 3,
      ...(_mediaListing === 'video' ? { maxResults: 8 } : {}),
      ...(_intentHint ? { intent: _intentHint } : {}),
      ...(_searchLang ? { lang: _searchLang } : {}),
    });
    let result = await mcpAdapter.callService('web-search', 'web.search', _searchArgs());

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
    const aiOverview = typeof searchData.aiOverview === 'string' && searchData.aiOverview.trim()
      ? searchData.aiOverview.trim() : null;
    if (aiOverview) logger.info(`[Node:WebSearch] aiOverview captured (${aiOverview.length} chars)`);

    return {
      ...state,
      searchResults,
      contextDocs,
      aiOverview
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

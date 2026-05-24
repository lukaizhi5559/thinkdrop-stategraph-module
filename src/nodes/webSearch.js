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
      query = tc.followUpTarget;
      logger.info(`[Node:WebSearch] isFollowUp — using followUpTarget as query: "${query}"`);
    }

    logger.debug(`[Node:WebSearch] Query: "${query}"`);

    // Call web-search service
    const result = await mcpAdapter.callService('web-search', 'web.search', {
      query: query,
      limit: 3
    });

    // MCP protocol wraps response in 'data' field
    const searchData = result.data || result;
    const searchResults = searchData.results || [];
    
    logger.debug(`[Node:WebSearch] Found ${searchResults.length} results`);

    return {
      ...state,
      searchResults,
      contextDocs: searchResults.map(r => ({
        id: r.url || r.link,
        text: `${r.title}\n${r.snippet || r.description || ''}`,
        source: 'web_search',
        url: r.url || r.link,
        title: r.title || '',
        snippet: r.snippet || r.description || ''
      }))
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

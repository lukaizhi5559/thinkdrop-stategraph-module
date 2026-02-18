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
    // Extract search query
    const query = message.replace(/^(search for|search|find|look up|google)\s+/i, '').trim();
    
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
        url: r.url || r.link
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

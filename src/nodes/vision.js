/**
 * Vision Node - Extracted with graceful degradation
 * 
 * Analyzes visual content using vision API.
 * Works with or without MCP adapter:
 * - With MCP: Uses vision service for image analysis
 * - Without MCP: Returns placeholder with intent info
 */

module.exports = async function vision(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;
  
  logger.debug('[Node:Vision] Analyzing visual content...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:Vision] No MCP adapter - vision analysis not available');
    return {
      ...state,
      answer: '[MCP not available - Vision analysis requires MCP services]',
      visualContext: null
    };
  }

  try {
    // Call vision service
    const result = await mcpAdapter.callService('vision', 'vision.analyze', {
      query: message,
      context: {
        userId: context?.userId,
        sessionId: context?.sessionId
      }
    });
    
    const resultData = result.data || result;
    
    const visualAnalysis = resultData.description || resultData.analysis || resultData.text || '[No analysis available]';
    
    logger.debug(`[Node:Vision] Analysis complete (${visualAnalysis.length} chars)`);
    
    return {
      ...state,
      answer: visualAnalysis,
      visualContext: visualAnalysis,
      confidence: resultData.confidence || 0.8
    };
    
  } catch (error) {
    logger.error('[Node:Vision] Error:', error.message);
    
    return {
      ...state,
      answer: `Error analyzing visual content: ${error.message}`,
      visualContext: null,
      error: error.message
    };
  }
};

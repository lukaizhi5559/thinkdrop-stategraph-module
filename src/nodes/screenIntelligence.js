/**
 * Screen Intelligence Node - Extracted with graceful degradation
 * 
 * Analyzes screen content with smart element extraction.
 * Works with or without MCP adapter:
 * - With MCP: Uses screen-intelligence service for analysis
 * - Without MCP: Returns placeholder with intent info
 */

module.exports = async function screenIntelligence(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;
  
  logger.debug('[Node:ScreenIntelligence] Analyzing screen context...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:ScreenIntelligence] No MCP adapter - screen analysis not available');
    return {
      ...state,
      answer: '[MCP not available - Screen intelligence requires MCP services]',
      screenContext: null
    };
  }

  try {
    // Call screen-intelligence service
    const result = await mcpAdapter.callService('screen-intelligence', 'screen.analyze', {
      query: message,
      context: {
        userId: context?.userId,
        sessionId: context?.sessionId
      }
    });
    
    const resultData = result.data || result;
    
    // Extract screen context
    const screenContext = {
      elements: resultData.elements || [],
      windows: resultData.windows || [],
      desktopItems: resultData.desktopItems || [],
      browserContent: resultData.browserContent || null,
      llmContext: resultData.llmContext || null
    };
    
    logger.debug(`[Node:ScreenIntelligence] Found ${screenContext.elements.length} elements`);
    
    // If using online mode with vision API
    if (state.useOnlineMode && resultData.analysis) {
      return {
        ...state,
        answer: resultData.analysis,
        screenContext: screenContext,
        visionAnalysis: resultData.analysis,
        provider: resultData.provider
      };
    }
    
    // Return screen context for LLM processing
    return {
      ...state,
      screenContext: screenContext,
      context: screenContext.llmContext || JSON.stringify(screenContext, null, 2)
    };
    
  } catch (error) {
    logger.error('[Node:ScreenIntelligence] Error:', error.message);
    
    // Fallback to vision service if screen-intelligence fails
    if (error.message.includes('not found') || error.message.includes('unavailable')) {
      logger.debug('[Node:ScreenIntelligence] Falling back to vision service...');
      
      try {
        const visionResult = await mcpAdapter.callService('vision', 'vision.analyze', {
          query: message,
          context: context
        });
        
        const visionData = visionResult.data || visionResult;
        
        return {
          ...state,
          answer: visionData.description || visionData.analysis || '[No vision analysis available]',
          screenContext: null,
          visionFallback: true
        };
      } catch (visionError) {
        logger.error('[Node:ScreenIntelligence] Vision fallback also failed:', visionError.message);
      }
    }
    
    return {
      ...state,
      answer: `Error analyzing screen: ${error.message}`,
      screenContext: null,
      error: error.message
    };
  }
};

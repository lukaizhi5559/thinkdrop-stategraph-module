/**
 * Parse Intent Node - Extracted with graceful degradation
 * 
 * Extracts intent and entities from user message.
 * Works with or without MCP adapter:
 * - With MCP: Uses phi4 service for ML-based classification
 * - Without MCP: Uses rule-based fallback classification
 */

module.exports = async function parseIntent(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;

  logger.debug('[Node:ParseIntent] Parsing intent...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:ParseIntent] No MCP adapter - using rule-based fallback');
    return fallbackIntentClassification(state);
  }

  try {
    // Try to use phi4 service for ML-based classification
    const result = await mcpAdapter.callService('phi4', 'intent.parse', {
      message: message,
      context: {
        sessionId: context?.sessionId,
        userId: context?.userId
      }
    });

    // MCP protocol wraps response in 'data' field
    const intentData = result.data || result;
    
    const finalIntent = intentData.intent || 'general_query';
    const finalConfidence = intentData.confidence || 0.5;
    
    logger.debug(`[Node:ParseIntent] Classified as: ${finalIntent} (confidence: ${finalConfidence.toFixed(2)})`);
    
    return {
      ...state,
      intent: {
        type: finalIntent,
        confidence: finalConfidence,
        entities: intentData.entities || [],
        requiresMemoryAccess: intentData.requiresMemoryAccess || false
      },
      metadata: {
        parser: 'phi4',
        processingTimeMs: intentData.metadata?.processingTimeMs || 0
      }
    };
  } catch (error) {
    logger.warn('[Node:ParseIntent] MCP call failed, using fallback:', error.message);
    return fallbackIntentClassification(state);
  }
};

/**
 * Fallback rule-based intent classification
 * Used when MCP adapter is unavailable
 */
function fallbackIntentClassification(state) {
  const { message } = state;
  const logger = state.logger || console;
  const msg = message.toLowerCase().trim();
  
  logger.debug('[Node:ParseIntent] Using rule-based classification');
  
  // Memory store patterns
  if (msg.match(/^(remember|save|store|note|keep in mind)/i)) {
    return {
      ...state,
      intent: { type: 'memory_store', confidence: 0.9, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Memory retrieve patterns
  if (msg.match(/^(what did i|recall|do i have|did i tell you)/i)) {
    return {
      ...state,
      intent: { type: 'memory_retrieve', confidence: 0.85, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Web search patterns
  if (msg.match(/(weather|news|current|latest|search|find|look up|google)/i)) {
    return {
      ...state,
      intent: { type: 'web_search', confidence: 0.8, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Command execution patterns
  if (msg.match(/^(open|close|launch|quit|start|stop|run|execute)/i)) {
    return {
      ...state,
      intent: { type: 'command_execute', confidence: 0.85, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Screen intelligence patterns
  if (msg.match(/(screen|see|showing|visible|display)/i)) {
    return {
      ...state,
      intent: { type: 'screen_intelligence', confidence: 0.75, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Greeting patterns
  if (msg.match(/^(hi|hello|hey|good morning|good afternoon|good evening)/i)) {
    return {
      ...state,
      intent: { type: 'greeting', confidence: 0.95, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Default to question
  return {
    ...state,
    intent: { type: 'question', confidence: 0.6, entities: [] },
    metadata: { parser: 'fallback', processingTimeMs: 0 }
  };
}

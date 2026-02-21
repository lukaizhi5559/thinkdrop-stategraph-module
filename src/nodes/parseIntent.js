/**
 * Parse Intent Node - Extracted with graceful degradation
 * 
 * Extracts intent and entities from user message.
 * Works with or without MCP adapter:
 * - With MCP: Uses phi4 service for ML-based classification
 * - Without MCP: Uses rule-based fallback classification
 */

module.exports = async function parseIntent(state) {
  const { mcpAdapter, message, resolvedMessage, carriedIntent, context } = state;
  const logger = state.logger || console;

  // Prefer coreference-resolved message for classification
  const classifyMessage = resolvedMessage || message;

  logger.debug('[Node:ParseIntent] Parsing intent...');
  if (resolvedMessage && resolvedMessage !== message) {
    logger.debug(`[Node:ParseIntent] Using resolved message: "${resolvedMessage}"`);
  }

  // Short-circuit: resolveReferences already determined intent via carryover
  if (carriedIntent) {
    logger.debug(`[Node:ParseIntent] Using carried intent from resolveReferences: ${carriedIntent}`);
    return {
      ...state,
      intent: {
        type: carriedIntent,
        confidence: 1.0,
        entities: [],
        requiresMemoryAccess: carriedIntent === 'memory_retrieve'
      },
      metadata: { parser: 'intent-carryover', processingTimeMs: 0 }
    };
  }

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:ParseIntent] No MCP adapter - using rule-based fallback');
    return fallbackIntentClassification(state);
  }

  try {
    // Try to use phi4 service for ML-based classification
    const result = await mcpAdapter.callService('phi4', 'intent.parse', {
      message: classifyMessage,
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
  
  // Command guide patterns (educational/tutorial) - check first
  if (msg.match(/^(show me how|teach me|how do i|how to|guide me|walk me through|explain how)/i)) {
    return {
      ...state,
      intent: { type: 'command_guide', confidence: 0.85, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Command automation patterns (multi-step, complex workflows) - check before web search
  // Look for UI element + action combinations
  if (msg.match(/(find|locate).+(button|link|field|menu|icon).+(and|then)?.+(click|press|select)/i) ||
      msg.match(/(find|locate).+(and|then).+(click|press|select|open)/i) ||
      msg.match(/(open|go to|navigate to).+(and|then).+(compose|create|enable|disable|click|type)/i) ||
      msg.match(/(click|press).+(and|then).+(type|enter|submit)/i)) {
    return {
      ...state,
      intent: { type: 'command_automate', confidence: 0.85, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Web search patterns - more specific to avoid false positives
  if (msg.match(/(weather|news|current|latest|search for|look up|google)/i) ||
      (msg.match(/find/i) && !msg.match(/(button|click|press|select|field|menu)/i))) {
    return {
      ...state,
      intent: { type: 'web_search', confidence: 0.8, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Command execution patterns (simple, single-step)
  if (msg.match(/^(open|close|launch|quit|start|stop|run|execute)\s+[a-z]/i)) {
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

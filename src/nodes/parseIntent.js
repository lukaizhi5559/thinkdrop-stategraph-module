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

  // Browser automation override — must run BEFORE phi4 ML call.
  // Detects by STRUCTURE, not by site name — works for any website or app, including new ones.
  //
  // Common English words that are NOT app/site destinations — used to avoid false positives
  // when "on/in/using" appears in normal sentences ("search for files on my computer").
  const NOT_A_SITE = /^(my|the|a|an|this|that|your|our|their|its|his|her|here|there|it|me|us|them|him|her|computer|mac|laptop|desktop|phone|device|system|machine|server|disk|drive|folder|file|screen|page|app|browser|internet|web|online|local|remote|cloud|network|home|work|office|school|store|shop|market|place|site|world|earth|time|day|week|month|year|morning|night|now|today|yesterday|tomorrow)$/i;
  const isDestinationWord = (word) => word && word.length >= 2 && !NOT_A_SITE.test(word);

  // Signal 1: URL in the message — any http/https/www or domain-like token
  const urlPattern = /\b(https?:\/\/|www\.)\S+|\b\S+\.(com|org|io|ai|app|net|co|dev|gov|edu)\b/i;

  // Signal 2: Navigation verb + destination — "go to X", "goto X", "navigate to X"
  //   Works for any destination word (lowercase or uppercase, any site name)
  const navVerbMatch = classifyMessage.match(/\b(go to|goto|navigate to|open|launch)\s+(\S+)/i);
  const navVerbDest = navVerbMatch ? navVerbMatch[2].replace(/[.,!?]+$/, '') : null;
  const hasNavVerb = navVerbDest && (urlPattern.test(navVerbDest) || isDestinationWord(navVerbDest));

  // Signal 3: Action verb + destination preposition + named target (any word, any case)
  //   "search for X on chatgpt", "search on gemini for X", "ask perplexity about X"
  //   "type into notion", "post on linkedin", "check github for issues"
  const destPrepMatch = classifyMessage.match(/\b(search|look up|ask|query|type|find|post|send|submit|check|browse|visit|go)\b.{0,50}\b(on|in|using|at|via|through|into)\s+(\S+)/i);
  const destPrepWord = destPrepMatch ? destPrepMatch[3].replace(/[.,!?]+$/, '') : null;
  const hasDestPrep = destPrepWord && isDestinationWord(destPrepWord);

  // Signal 4: "[verb] [site] for/about X" — verb directly before destination, then purpose
  //   "ask chatgpt for", "search gemini about", "check perplexity if"
  const verbSiteForMatch = classifyMessage.match(/\b(ask|search|check|query|browse|visit)\s+(\S+)\s+(for|about|if|whether|how|what|when|where|who)\b/i);
  const verbSiteDest = verbSiteForMatch ? verbSiteForMatch[2].replace(/[.,!?]+$/, '') : null;
  const hasVerbSiteFor = verbSiteDest && isDestinationWord(verbSiteDest);

  const isBrowserAutomation = urlPattern.test(classifyMessage) || hasNavVerb || hasDestPrep || hasVerbSiteFor;

  if (isBrowserAutomation) {
    logger.debug(`[Node:ParseIntent] Browser automation override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.97,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'browser-override', processingTimeMs: 0 }
    };
  }

  // Filesystem query override — must run BEFORE phi4 ML call.
  // "Do I have X files", "list all apps on my computer", "find files on my desktop" etc.
  // are always command_automate (mdfind/find/ls), never screen_intelligence or memory_retrieve.
  const fileSearchPattern = /\b(do i have|are there|have i got|find all|list all|show me all|what files|what apps|what applications)\b.*\b(files?|folders?|apps?|applications?|documents?|photos?|images?|pdfs?|spreadsheets?)\b/i;
  const fileSearchPattern2 = /\b(list|show|find|search for|do i have|are there)\b.*(files?|folders?|apps?|applications?)\b.*(on my|in my|computer|mac|desktop|laptop|downloads|documents|home)/i;
  if (fileSearchPattern.test(classifyMessage) || fileSearchPattern2.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Filesystem query override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.95,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'filesystem-override', processingTimeMs: 0 }
    };
  }

  // Temporal memory override — must run BEFORE phi4 ML call.
  // Queries with time references + recall verbs are always memory_retrieve,
  // regardless of what the ML model classifies (e.g. "list files yesterday" → command_automate).
  const temporalMemoryPattern = /\b(yesterday|last (week|month|night|year)|this (morning|week|month)|earlier today|a (few )?(days?|weeks?|months?) ago)\b/i;
  const recallVerbPattern = /\b(what|did|do|list|show|tell|recall|remember|find|which|how many|summarize|were|was|have)\b/i;
  if (temporalMemoryPattern.test(classifyMessage) && recallVerbPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Temporal memory override → memory_retrieve: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'memory_retrieve',
        confidence: 0.95,
        entities: [],
        requiresMemoryAccess: true
      },
      metadata: { parser: 'temporal-override', processingTimeMs: 0 }
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

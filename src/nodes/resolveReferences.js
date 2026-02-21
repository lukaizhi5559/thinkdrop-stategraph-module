/**
 * Resolve References Node
 *
 * Runs BEFORE parseIntent so the intent classifier sees a fully-resolved
 * message instead of ambiguous pronouns / follow-up fragments.
 *
 * Two-layer resolution:
 *
 * Layer 1 — JS intent carryover (fast, no network call):
 *   Detects short temporal/elliptical follow-ups and carries the previous
 *   intent directly by setting `carriedIntent` in state.
 *   Examples:
 *     "what about now"   → carriedIntent: 'screen_intelligence'
 *     "and now?"         → carriedIntent: 'screen_intelligence'
 *     "what about that"  → carriedIntent: <previous intent>
 *
 * Layer 2 — Python coreference service (pronoun resolution):
 *   Only called when the message contains actual pronouns (he/she/it/they/this/that)
 *   referring to named entities from conversation history.
 *   Examples:
 *     "can you explain it more"  → "can you explain <previous subject> more"
 *     "what did he say"          → "what did <person> say"
 *
 * Graceful degradation: if coreference service is down, falls back to original
 * message so the rest of the graph continues normally.
 */

function stripHtml(text) {
  return text ? text.replace(/<[^>]*>/g, '') : text;
}

// Intent label → human-readable topic for message expansion
const INTENT_TOPICS = {
  screen_intelligence: 'the screen',
  memory_retrieve:     'my activity history',
  web_search:          'that topic',
  command_execute:     'that command',
  command_automate:    'that task',
  general_knowledge:   'that topic'
};

/**
 * Layer 1: Detect short follow-up patterns and carry the previous intent.
 * Returns { carriedIntent, resolvedMessage } or null if no carryover applies.
 */
// Time words that indicate a temporal reference but no standalone intent topic
const TEMPORAL_WORDS = /\b(today|yesterday|now|this morning|this afternoon|this evening|this week|last week|earlier|recently|at noon|at midnight|around \d|at \d)\b/i;

// Words that indicate a clear standalone intent (not a follow-up)
const STANDALONE_INTENT_WORDS = /\b(search|find|look up|google|wikipedia|define|explain|how to|what is|who is|weather|news|open|run|execute|install|download|remind|schedule|email|message|call)\b/i;

function detectIntentCarryover(message, conversationHistory) {
  const msg = message.trim().toLowerCase().replace(/[?!.]+$/, '');

  // Pattern A: Exact short deictic follow-ups (no time word needed)
  const EXACT_FOLLOWUP_PATTERNS = [
    /^what about now$/,
    /^and now$/,
    /^now what$/,
    /^what now$/,
    /^how about now$/,
    /^what about that$/,
    /^and that$/,
    /^what about this$/,
    /^same question$/,
    /^again$/,
    /^one more time$/,
    /^still$/,
    /^still the same$/,
    /^what about the same$/
  ];

  const isExactFollowup = EXACT_FOLLOWUP_PATTERNS.some(p => p.test(msg));

  // Pattern B: Short temporal elliptical — message has a time word but no standalone intent topic
  // e.g. "anything yesterday", "what about today at noon", "what about yesterday", "how about earlier"
  const hasTemporalWord = TEMPORAL_WORDS.test(msg);
  const hasStandaloneIntent = STANDALONE_INTENT_WORDS.test(msg);
  const wordCount = msg.split(/\s+/).filter(Boolean).length;

  // Temporal elliptical: has time word, no standalone intent, and short (≤ 8 words)
  // Also must match an elliptical prefix pattern OR be very short
  const ELLIPTICAL_PREFIXES = /^(what about|anything|how about|and|what|show me|tell me about)\b/i;
  const isTemporalElliptical = hasTemporalWord && !hasStandaloneIntent &&
    (wordCount <= 6 || ELLIPTICAL_PREFIXES.test(msg));

  if (!isExactFollowup && !isTemporalElliptical) return null;

  // Find the most recent user intent from conversation history
  const recentUserMessages = conversationHistory
    .filter(m => m.role === 'user')
    .slice(-5)
    .reverse(); // most recent first

  const SCREEN_PATTERNS = /\b(screen|see|show|look|page|window|what.*(on|in).*screen|what do you see|what.*(visible|showing|displayed))\b/i;
  const MEMORY_PATTERNS = /\b(was i|did i|have i|what did i|what apps|what sites|history|activity|working on|looking at|using|worked)\b/i;

  let previousIntent = null;
  for (const m of recentUserMessages) {
    const content = m.content || '';
    if (SCREEN_PATTERNS.test(content)) {
      previousIntent = 'screen_intelligence';
      break;
    }
    if (MEMORY_PATTERNS.test(content)) {
      previousIntent = 'memory_retrieve';
      break;
    }
  }

  // For temporal ellipticals with no prior context, default to memory_retrieve
  // (time-based queries almost always mean "what was I doing at that time")
  if (!previousIntent && isTemporalElliptical) {
    previousIntent = 'memory_retrieve';
  }

  if (!previousIntent) return null;

  // Build an expanded message that the intent classifier can understand
  const topic = INTENT_TOPICS[previousIntent] || 'that';
  const isNowVariant = /\bnow\b/.test(msg);

  let resolvedMessage;
  if (previousIntent === 'screen_intelligence') {
    resolvedMessage = isNowVariant
      ? `what do you see on ${topic} right now`
      : `what do you see on ${topic}`;
  } else {
    // For memory_retrieve, preserve the temporal context in the resolved message
    // so parseDateRange in retrieveMemory can extract the date range
    resolvedMessage = message; // keep original — date parsing handles it
  }

  return { carriedIntent: previousIntent, resolvedMessage };
}

/**
 * Layer 2: Does this message contain pronouns that need Python coreference?
 * Only call the service when there's an actual pronoun to resolve.
 */
function needsPronounResolution(message) {
  return /\b(he|she|it|they|him|her|his|their|them|its|this|that|these|those)\b/i.test(message);
}

module.exports = async function resolveReferences(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;

  logger.debug('[Node:ResolveReferences] Resolving coreferences...');
  logger.debug(`[Node:ResolveReferences] Original: "${message}"`);

  // No MCP adapter → skip gracefully
  if (!mcpAdapter) {
    return {
      ...state,
      resolvedMessage: message,
      originalMessage: message,
      coreferenceReplacements: [],
      coreferenceMethod: 'no-adapter'
    };
  }

  // ── Fetch fresh conversation history ─────────────────────────────────────
  let conversationHistory = [];
  try {
    const sessionId = context?.sessionId;
    if (sessionId) {
      const histResult = await mcpAdapter.callService('conversation', 'message.list', {
        sessionId,
        limit: 10,
        direction: 'DESC'
      });
      const histData = histResult.data || histResult;
      conversationHistory = (histData.messages || [])
        .map(msg => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: stripHtml(msg.text || msg.content || ''),
          timestamp: msg.timestamp
        }))
        .reverse(); // chronological order
      logger.debug(`[Node:ResolveReferences] Fetched ${conversationHistory.length} messages for context`);
    }
  } catch (histErr) {
    logger.debug('[Node:ResolveReferences] Could not fetch history, proceeding without:', histErr.message);
  }

  // ── Layer 1: JS intent carryover (no network call) ────────────────────────
  const carryover = detectIntentCarryover(message, conversationHistory);
  if (carryover) {
    logger.debug(`[Node:ResolveReferences] Intent carryover: "${message}" → "${carryover.resolvedMessage}" (intent: ${carryover.carriedIntent})`);
    return {
      ...state,
      resolvedMessage: carryover.resolvedMessage,
      originalMessage: message,
      carriedIntent: carryover.carriedIntent,
      coreferenceReplacements: [],
      coreferenceMethod: 'intent-carryover'
    };
  }

  // ── Layer 2: Python coreference (pronoun resolution only) ─────────────────
  if (!needsPronounResolution(message)) {
    logger.debug('[Node:ResolveReferences] No pronouns detected, skipping coreference service');
    return {
      ...state,
      resolvedMessage: message,
      originalMessage: message,
      coreferenceReplacements: [],
      coreferenceMethod: 'none'
    };
  }

  try {
    const result = await mcpAdapter.callService('coreference', 'resolve', {
      message,
      conversationHistory: conversationHistory.slice(-10),
      options: {
        includeConfidence: true,
        method: 'auto'
      }
    });

    const data = result.data || result;
    let resolvedMessage = data.resolvedMessage || message;
    const replacements = data.replacements || [];
    const method = data.method || 'unknown';

    // Guard: reject bad simple_fallback resolutions that change meaning
    // (simple_fallback sometimes mangles messages — only accept if confidence is high)
    if (method === 'simple_fallback' && replacements.length > 0) {
      const allHighConfidence = replacements.every(r => (r.confidence || 0) >= 0.85);
      if (!allHighConfidence) {
        logger.debug('[Node:ResolveReferences] Rejecting low-confidence simple_fallback resolution, using original');
        resolvedMessage = message;
      }
    }

    if (resolvedMessage !== message) {
      logger.debug(`[Node:ResolveReferences] Resolved via ${method}: "${message}" → "${resolvedMessage}"`);
      replacements.forEach(r =>
        logger.debug(`  "${r.original}" → "${r.resolved}" (${Math.round((r.confidence || 0) * 100)}%)`)
      );
    } else {
      logger.debug('[Node:ResolveReferences] No references resolved, message unchanged');
    }

    return {
      ...state,
      resolvedMessage,
      originalMessage: message,
      coreferenceReplacements: replacements,
      coreferenceMethod: method
    };

  } catch (error) {
    logger.debug('[Node:ResolveReferences] Service unavailable, using original message:', error.message);
    return {
      ...state,
      resolvedMessage: message,
      originalMessage: message,
      coreferenceReplacements: [],
      coreferenceMethod: 'fallback'
    };
  }
};

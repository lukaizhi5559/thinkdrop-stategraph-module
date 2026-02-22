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
 * Layer 1: Detect follow-up messages and carry the previous intent forward.
 * Returns { carriedIntent, resolvedMessage } or null if no carryover applies.
 *
 * Principle: instead of maintaining an ever-growing list of exact regex patterns,
 * we classify follow-ups by four orthogonal signals and read prior intent from
 * conversation history directly. This is robust to new phrasings by design.
 *
 * Signal 1 — CONTINUATION: message is very short (≤4 words) with no standalone intent word.
 *   e.g. "anything else", "what else", "more", "go on", "continue", "and?", "ok so?"
 *
 * Signal 2 — TEMPORAL ELLIPTICAL: message has a time word but no standalone intent topic.
 *   e.g. "anything yesterday", "what about last week", "how about earlier"
 *
 * Signal 3 — DEICTIC MEMORY REF: message references retrieved content with an activity verb.
 *   e.g. "what was I doing with these files", "why did I have those open", "tell me about them"
 *
 * Signal 4 — SCREEN NOW: message is a short "now" variant after a screen_intelligence turn.
 *   e.g. "what about now", "and now?", "how about now"
 *
 * Prior intent is read from conversation history content heuristics (no stored metadata needed).
 */

// Words that indicate a clear standalone intent — message is NOT a follow-up if these appear.
const STANDALONE_INTENT_WORDS = /\b(search|look up|google|wikipedia|define|explain|how to|who is|weather|news|open|run|execute|install|download|remind|schedule|email|send|call|create|make|delete|move|copy|rename|launch|start|stop|close|write|generate|build|deploy|find me|show me how)\b/i;

// Time words that indicate a temporal reference
const TEMPORAL_WORDS = /\b(today|yesterday|now|this morning|this afternoon|this evening|this week|last week|last night|last month|earlier|recently|at noon|at midnight|around \d|at \d)\b/i;

// Deictic pronouns referring to prior retrieved content
const DEICTIC_MEMORY_REFS = /\b(these|those|them|the ones|the files|the apps|the sites|the messages|the results)\b/i;

// Activity verbs that pair with deictic refs to signal memory follow-up
const ACTIVITY_VERBS = /\b(doing|working|using|looking|opening|open|running|editing|writing|reading|viewing|accessing|with|for|about|saved|created|deleted|moved|closed|have|had|were|was)\b/i;

// Heuristics to classify prior user message intent from its content
const PRIOR_SCREEN_SIGNALS = /\b(screen|what do you see|what.*(on|in).*screen|what.*(visible|showing|displayed)|describe.*screen|analyze.*screen|look at.*screen)\b/i;
const PRIOR_MEMORY_SIGNALS = /\b(was i|did i|have i|what did i|what apps|what sites|what files|history|activity|working on|looking at|mentioned|files|yesterday|last week|last night|last month|earlier today|this morning|what were (we|you)|what did (we|you)|list.*i|show.*i (did|used|worked|opened))\b/i;
const PRIOR_COMMAND_SIGNALS = /\b(open|run|execute|create|make|delete|move|copy|click|press|type|scroll|launch|install|download|send|email)\b/i;
// Browser automation signals — navigation to a specific site/app
const PRIOR_BROWSER_SIGNALS = /\b(go to|goto|navigate to|open|launch|search.*on|ask.*on|type.*into|search.*in|search.*using|search.*via|search.*at)\b/i;

// Words that are NOT site/app names — same list as parseIntent
const NOT_A_SITE_WORD = /^(my|the|a|an|this|that|your|our|their|its|his|her|here|there|it|me|us|them|him|her|computer|mac|laptop|desktop|phone|device|system|machine|server|disk|drive|folder|file|screen|page|app|browser|internet|web|online|local|remote|cloud|network|home|work|office|school|store|shop|market|place|site|world|earth|time|day|week|month|year|morning|night|now|today|yesterday|tomorrow|for|and|or|but|the|in|on|at|to|of|with|by|from|up|about|into|through|during|before|after|above|below|between|out|off|over|under|again|further|then|once)$/i;

/**
 * Extract the destination site/app from a prior browser automation message.
 * e.g. "go to chatgpt and search for pizza" → "chatgpt"
 *      "search for vegan foods on gemini" → "gemini"
 *      "search gemini for soups" → "gemini"
 */
function extractPriorSite(content) {
  // Pattern: "go to X", "goto X", "navigate to X", "open X"
  const navMatch = content.match(/\b(go to|goto|navigate to|open|launch)\s+(\S+)/i);
  if (navMatch) {
    const word = navMatch[2].replace(/[.,!?]+$/, '');
    if (!NOT_A_SITE_WORD.test(word)) return word;
  }
  // Pattern: "search for X on [site]", "type into [site]", "ask [site] about X"
  const onMatch = content.match(/\b(on|in|using|at|via|through|into)\s+(\S+)\s*$/i);
  if (onMatch) {
    const word = onMatch[2].replace(/[.,!?]+$/, '');
    if (!NOT_A_SITE_WORD.test(word)) return word;
  }
  // Pattern: "search [site] for X" — site directly after verb
  const verbSiteMatch = content.match(/\b(search|ask|check|query|browse|visit)\s+(\S+)\s+(for|about|if|how|what)/i);
  if (verbSiteMatch) {
    const word = verbSiteMatch[2].replace(/[.,!?]+$/, '');
    if (!NOT_A_SITE_WORD.test(word)) return word;
  }
  return null;
}

function inferIntentFromContent(content) {
  if (PRIOR_SCREEN_SIGNALS.test(content)) return 'screen_intelligence';
  if (PRIOR_MEMORY_SIGNALS.test(content)) return 'memory_retrieve';
  if (PRIOR_BROWSER_SIGNALS.test(content)) return 'command_automate';
  if (PRIOR_COMMAND_SIGNALS.test(content)) return 'command_automate';
  return null;
}

function detectIntentCarryover(message, conversationHistory) {
  const msg = message.trim().toLowerCase().replace(/[?!.]+$/, '');
  const words = msg.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const hasStandaloneIntent = STANDALONE_INTENT_WORDS.test(msg);
  const hasTemporalWord = TEMPORAL_WORDS.test(msg);
  const hasDeiticRef = DEICTIC_MEMORY_REFS.test(msg);
  const hasActivityVerb = ACTIVITY_VERBS.test(msg);
  const hasNow = /\bnow\b/.test(msg);

  // Browser follow-up: "search for X now", "now search for X", "search for X again", "also search for X"
  // NOTE: intentionally does NOT check hasStandaloneIntent — "search" is a standalone word but
  // "search for X now" is still a browser follow-up when prior context was browser automation.
  // The guard is: prior history must contain a browser automation message.
  const BROWSER_FOLLOWUP_MARKERS = /\b(now|again|also|too|next|then|still|instead)\b/i;
  const SEARCH_VERB = /\b(search for|look up|find|ask about|query|type)\b/i;
  const hasBrowserFollowupShape = SEARCH_VERB.test(msg) && BROWSER_FOLLOWUP_MARKERS.test(msg);

  if (hasBrowserFollowupShape && conversationHistory.length > 0) {
    const recentUserMsgs = conversationHistory.filter(m => m.role === 'user').slice(-5).reverse();
    let priorSite = null;
    let priorIsBrowser = false;
    for (const m of recentUserMsgs) {
      const content = m.content || '';
      if (PRIOR_BROWSER_SIGNALS.test(content)) {
        priorIsBrowser = true;
        priorSite = extractPriorSite(content);
        if (priorSite) break;
      }
    }
    if (priorIsBrowser) {
      const enriched = priorSite ? `${message} on ${priorSite}` : message;
      return { carriedIntent: 'command_automate', resolvedMessage: enriched };
    }
  }

  // Signal 1: CONTINUATION — very short message (≤4 words), no standalone intent
  // Covers: "anything else", "what else", "more", "go on", "continue", "and?", "ok so?"
  // Excludes clear subject+verb sentences: "I like these", "these are interesting"
  const CLEAR_SUBJECT_VERB = /^(i |they |he |she |it |we |these |those |that |this )\w/i;
  const isContinuation = wordCount <= 4 && !hasStandaloneIntent && !CLEAR_SUBJECT_VERB.test(msg);

  // Signal 2: TEMPORAL ELLIPTICAL — has time word, no standalone intent, short or elliptical prefix
  const ELLIPTICAL_PREFIXES = /^(what about|anything|how about|and|what|show me|tell me about|anything about)\b/i;
  const isTemporalElliptical = hasTemporalWord && !hasStandaloneIntent &&
    (wordCount <= 7 || ELLIPTICAL_PREFIXES.test(msg));

  // Signal 3: DEICTIC MEMORY REF — references retrieved content with activity verb.
  // Note: does NOT check hasStandaloneIntent — deictic ref is the stronger signal.
  // "why did I have those open" has 'open' (standalone) but 'those' (deictic) wins.
  const isDeiticMemoryFollowup = hasDeiticRef && hasActivityVerb;

  // Signal 4: SCREEN NOW — short "now" variant (handled via continuation + prior intent)

  // Location-scoping fragments — "in the misc folder", "on the desktop", "in ~/Documents"
  // These are always command_automate refinements (narrow the search scope), never memory queries.
  const isLocationScope = /^(in|on|under|inside|within|at)\b.*(folder|directory|desktop|downloads|documents|home|drive|disk|path|dir|\~\/)/i.test(msg) ||
    /^(in|on)\s+the\s+\w+(\s+folder)?$/i.test(msg);
  if (isLocationScope) {
    return { carriedIntent: 'command_automate', resolvedMessage: message };
  }

  if (!isContinuation && !isTemporalElliptical && !isDeiticMemoryFollowup) return null;

  // ── Determine prior intent from conversation history ──────────────────────
  // Read the last 5 user messages, most recent first, and infer intent from content
  const recentUserMessages = conversationHistory
    .filter(m => m.role === 'user')
    .slice(-5)
    .reverse();

  let previousIntent = null;
  for (const m of recentUserMessages) {
    const content = m.content || '';
    const inferred = inferIntentFromContent(content);
    if (inferred) {
      previousIntent = inferred;
      break;
    }
  }

  // Defaults when no prior intent found:
  // - Deictic memory refs → memory_retrieve (user is asking about retrieved content)
  // - Temporal ellipticals → memory_retrieve (time-based = "what was I doing then")
  // - Pure continuations with no history → null (can't safely infer)
  if (!previousIntent && isDeiticMemoryFollowup) previousIntent = 'memory_retrieve';
  if (!previousIntent && isTemporalElliptical) previousIntent = 'memory_retrieve';
  if (!previousIntent) return null;

  // ── Build resolved message ────────────────────────────────────────────────
  const topic = INTENT_TOPICS[previousIntent] || 'that';
  let resolvedMessage;
  if (previousIntent === 'screen_intelligence') {
    resolvedMessage = hasNow
      ? `what do you see on ${topic} right now`
      : `what do you see on ${topic}`;
  } else {
    resolvedMessage = message; // preserve original for date parsing downstream
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
      coreferenceMethod: 'intent-carryover',
      conversationHistory
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
      coreferenceMethod: 'none',
      conversationHistory
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
      coreferenceMethod: method,
      conversationHistory
    };

  } catch (error) {
    logger.debug('[Node:ResolveReferences] Service unavailable, using original message:', error.message);
    return {
      ...state,
      resolvedMessage: message,
      originalMessage: message,
      coreferenceReplacements: [],
      coreferenceMethod: 'fallback',
      conversationHistory
    };
  }
};

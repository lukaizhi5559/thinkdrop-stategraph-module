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
// Also includes memory-recall patterns so they break command_automate carryover.
const STANDALONE_INTENT_WORDS = /\b(search|look up|google|wikipedia|define|explain|how to|who is|weather|news|open|run|execute|install|download|remind|schedule|email|send|call|create|make|delete|move|copy|rename|launch|start|stop|close|write|generate|build|deploy|find me|show me how)\b/i;

// Memory-recall question patterns — these should NEVER carry command_automate forward.
// e.g. "how have I", "list the email", "did I email", "what emails did I", "who did I"
const MEMORY_RECALL_QUESTION = /^(how (have|many|much|often)\b|did i\b|what (emails?|messages?|texts?|did i|have i)\b|who did i\b|list (the |those |all |my )?(emails?|messages?|texts?|addresses?|contacts?|history|activity|sms|chats?|entries|items|times|dates|records)\b|show (me )?(the |my )?(emails?|messages?|texts?|history|activity|list of emails?|list of messages?|entries|items|times|dates)\b|what.*(i (sent|emailed|texted|wrote|did))\b)/i;

// Time words that indicate a temporal reference
const TEMPORAL_WORDS = /\b(today|yesterday|now|this morning|this afternoon|this evening|this week|last week|last night|last month|earlier|recently|at noon|at midnight|around \d|at \d)\b/i;

// Deictic pronouns referring to prior retrieved content
// Includes singular web deictic NPs (the site, the page, the link, etc.) so that
// "goto the site and check" after a web search correctly signals intent carryover.
const DEICTIC_MEMORY_REFS = /\b(these|those|them|the ones|the files|the apps|the sites|the messages|the results|the entries|the items|the records|the data|the list|the site|the page|the link|the result|the article|the url)\b/i;

// Activity verbs that pair with deictic refs to signal memory follow-up
const ACTIVITY_VERBS = /\b(doing|working|using|looking|opening|open|running|editing|writing|reading|viewing|accessing|with|for|about|saved|created|deleted|moved|closed|have|had|were|was)\b/i;

// Heuristics to classify prior user message intent from its content
const PRIOR_SCREEN_SIGNALS = /\b(screen|what do you see|what.*(on|in).*screen|what.*(visible|showing|displayed)|describe.*screen|analyze.*screen|look at.*screen)\b/i;
const PRIOR_MEMORY_SIGNALS = /\b(was i|did i|have i|what did i|what apps|what sites|what files|history|activity|working on|looking at|mentioned|files|yesterday|last week|last night|last month|earlier today|this morning|what were (we|you)|what did (we|you)|list.*i|show.*i (did|used|worked|opened)|memories|memory|records|recall|my records|looking at my)\b/i;
const PRIOR_COMMAND_SIGNALS = /\b(open|run|execute|create|make|delete|move|copy|click|press|type|scroll|launch|install|download|send|email|comment|add comment|post comment|review|attach|upload|push|pull request|pr|commit|merge|deploy|build|compile|test|lint|format|fix|patch|update|edit|write|generate|publish|release|tag|branch|checkout|clone|fork|star|issue|ticket|task|assign|close|reopen|approve|reject|request changes)\b/i;
// NOTE: 'watch' intentionally excluded — it false-positives on media/movie phrasing (e.g. "watch die hard")
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

// Personal-attribute retrieval queries — must be tested BEFORE PRIOR_COMMAND_SIGNALS because
// words like "email", "send", "call" appear in both the query and command signals.
// e.g. "what's my email" → memory_retrieve, not command_automate.
const PERSONAL_ATTR_QUERY_RE = /^(what'?s|what is|whats|who is|who'?s|where is|where'?s)\s+my\b/i;

function inferIntentFromContent(content) {
  if (PRIOR_SCREEN_SIGNALS.test(content)) return 'screen_intelligence';
  // Personal-attribute queries come before command signals — "what's my email" must not
  // match PRIOR_COMMAND_SIGNALS (which contains 'email') and get classified as command_automate.
  if (PERSONAL_ATTR_QUERY_RE.test(content.trim())) return 'memory_retrieve';
  // Check command signals BEFORE memory signals — action verbs (create, push, comment, etc.)
  // are stronger indicators of prior automation than memory keywords like 'created' or 'was'.
  if (PRIOR_BROWSER_SIGNALS.test(content)) return 'command_automate';
  if (PRIOR_COMMAND_SIGNALS.test(content)) return 'command_automate';
  if (PRIOR_MEMORY_SIGNALS.test(content)) return 'memory_retrieve';
  return null;
}

function detectIntentCarryover(message, conversationHistory) {
  const msg = message.trim().toLowerCase().replace(/[?!.]+$/, '');

  // Hard ceiling: messages longer than 15 words have enough content for phi4 to classify
  // on their own — never treat them as follow-ups regardless of what words they contain.
  // Genuine conversational continuations ("anything else?", "what about now?") are always short.
  if (msg.split(/\s+/).length > 15) return null;

  // Memory-recall questions NEVER carry command_automate forward.
  // e.g. "how have I sent emails today", "list the email addresses I emailed"
  // These should always go to memory_retrieve, not re-trigger browser automation.
  if (MEMORY_RECALL_QUESTION.test(msg)) return null;

  // Correction messages NEVER carry over any prior intent — they must be re-classified fresh.
  // "no it's X", "no that's X", "actually it's X" = user correcting a prior wrong answer.
  // Carrying over command_automate here caused "no it's cakers5559@gmail.com" to open Gmail.
  const CORRECTION_CARRYOVER_RE = /^(no[,.]?\s+(it'?s|that'?s|it\s+is|the\s+(correct|right)\s+(one|answer)\s+is|i\s+mean)|nope[,.]?\s+(it'?s|that'?s)|actually[,.]?\s+(it'?s|that'?s|it\s+is))\b/i;
  if (CORRECTION_CARRYOVER_RE.test(message.trim())) return null;

  // Filesystem / capability action messages NEVER carry over any prior intent.
  // "I need you to scan the folder X", "scan folder X", "do you have a skill to X"
  // These are new commands, not follow-ups — parseIntent hard-overrides handle them.
  const FILESYSTEM_ACTION = /\b(scan|read|list|analyze|summarize|go through|look (at|through)|explore)\b.{0,60}\b(folder|directory|dir|file|files|screenshot|screenshots|image|images|photo|photos|desktop|downloads|documents|~\/)\b/i;
  const CAPABILITY_QUESTION = /\b(do you have (a skill|the ability|a way|a tool) to\b|can you (use|run|execute|do) .{0,40}\b(skill|command|shell|terminal|browser)\b|is there a skill (to|that|for)\b)/i;
  if (FILESYSTEM_ACTION.test(msg) || CAPABILITY_QUESTION.test(msg)) return null;

  // Screen-intelligence queries NEVER carry prior intent — they're always new requests.
  // "What's on my screen right now?" contains "now" (temporal word) which would incorrectly
  // trigger isTemporalElliptical carryover.  Guard = any direct screen-read phrasing.
  const SCREEN_QUERY_DIRECT = /\b(on\s+(my\s+)?(the\s+)?screen|my\s+screen|my\s+(display|monitor)|on\s+screen|what'?s?\s+on\s+my|what\s+is\s+on\s+my)\b/i;
  if (SCREEN_QUERY_DIRECT.test(msg)) return null;

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
  // Excludes greetings — these are never follow-ups to a prior command_automate
  const CLEAR_SUBJECT_VERB = /^(i |they |he |she |it |we |these |those |that |this )\w/i;
  const GREETING_RE = /^(hey|hi|hello|howdy|hiya|yo|sup|what'?s\s+up|whats\s+up|good\s+(morning|afternoon|evening|day|night)|greetings|salutations|morning|evening|afternoon|heya|helo)\b/i;
  const isGreeting = GREETING_RE.test(msg);
  const isContinuation = wordCount <= 4 && !hasStandaloneIntent && !CLEAR_SUBJECT_VERB.test(msg) && !isGreeting;

  // Signal 2: TEMPORAL ELLIPTICAL — has time word, no standalone intent, short or elliptical prefix
  // EXCEPTION: system-info queries like "what's today's date", "what time is it" must NEVER
  // carry over memory_retrieve — they need command_automate (shell.run date).
  const SYSTEM_INFO_QUERY = /\b(today'?s?\s*date|what('s| is)\s*(today'?s?|the\s*current|the)?\s*(date|time|day)|what\s*time\s*is\s*it|what\s*day\s*is\s*(today|it)|current\s*(date|time))\b/i;
  const ELLIPTICAL_PREFIXES = /^(what about|anything|how about|and|what|show me|tell me about|anything about)\b/i;
  const isTemporalElliptical = hasTemporalWord && !hasStandaloneIntent &&
    !SYSTEM_INFO_QUERY.test(msg) &&
    (wordCount <= 7 || ELLIPTICAL_PREFIXES.test(msg));

  // Signal 3: DEICTIC MEMORY REF — references retrieved content with activity verb.
  // Note: does NOT check hasStandaloneIntent — deictic ref is the stronger signal.
  // "why did I have those open" has 'open' (standalone) but 'those' (deictic) wins.
  // Long messages are already excluded by the 15-word ceiling above.
  const isDeiticMemoryFollowup = hasDeiticRef && hasActivityVerb;

  // Signal 4: SCREEN NOW — short "now" variant (handled via continuation + prior intent)

  // Location-scoping fragments — "in the misc folder", "on the desktop", "in ~/Documents"
  // These are always command_automate refinements (narrow the search scope), never memory queries.
  const isLocationScope = /^(in|on|under|inside|within|at)\b.*(folder|directory|desktop|downloads|documents|home|drive|disk|path|dir|\~\/)/i.test(msg) ||
    /^(in|on)\s+the\s+\w+(\s+folder)?$/i.test(msg);
  if (isLocationScope) {
    return { carriedIntent: 'command_automate', resolvedMessage: message };
  }

  // Signal 5: REFINEMENT — correction or addendum to a prior answer.
  // "dates as well not just times", "also include X", "not just X", "include dates too"
  // These are always follow-ups to the prior intent — the user is refining the output format.
  const REFINEMENT_MARKERS = /\b(as well|not just|also include|include .* too|instead of|rather than|add .* too|plus |and also|but also|in addition)\b/i;
  const isRefinement = REFINEMENT_MARKERS.test(msg) && wordCount <= 12 && !hasStandaloneIntent;

  // Signal 6: BROWSER NAV + DEICTIC — e.g. "goto the site and check", "visit the page"
  // These exceed the ≤4-word continuation ceiling but unambiguously refer to a prior web result.
  // The hasDeiticRef flag (set above from the expanded DEICTIC_MEMORY_REFS) must also be true.
  const BROWSER_NAV_DEICTIC_RE = /^(go\s+to|goto|visit|check|open|browse|navigate\s+to|look\s+at)\s+(the\s+)?(site|page|link|url|article|result)\b/i;
  const hasBrowserNavDeictic = BROWSER_NAV_DEICTIC_RE.test(msg) && hasDeiticRef;

  if (!isContinuation && !isTemporalElliptical && !isDeiticMemoryFollowup && !isRefinement && !hasBrowserNavDeictic) return null;

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
  // - Browser nav deictic → command_automate ("goto the site" is always a browser command
  //   regardless of what the prior turn was — even if inferIntentFromContent returned null
  //   because the prior question was a general knowledge query like "what's the weather in Ohio")
  // - Deictic ref + prior assistant had URLs → command_automate (web-search follow-up)
  //   "check those sites", "show me those pages" after a web search answer
  // - Pure continuations with no history → null (can't safely infer)
  if (!previousIntent && isDeiticMemoryFollowup) previousIntent = 'memory_retrieve';
  if (!previousIntent && isTemporalElliptical) previousIntent = 'memory_retrieve';
  if (!previousIntent && hasBrowserNavDeictic && conversationHistory.length > 0) previousIntent = 'command_automate';
  if (!previousIntent && hasDeiticRef) {
    const _lastAsst = conversationHistory.slice().reverse().find(m => m.role === 'assistant' && m.content);
    if (_lastAsst?.content && /https?:\/\//.test(_lastAsst.content)) {
      previousIntent = 'command_automate';
    }
  }
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

  // ── Web deictic enrichment: extract URLs from prior assistant message ─────
  // When the user says "goto the site", "check the page", etc. after a web search,
  // the planner has no idea what URL "the site" refers to — it defaults to example.com.
  // Extract URLs mentioned in the most recent assistant message and append them to
  // resolvedMessage so the planning LLM can reason about the correct target.
  // 1 URL → "(referring to: <url>)"
  // 2+ URLs → "(prior answer mentioned these sites: <url1>, <url2>, ...)"
  if (hasBrowserNavDeictic || (hasDeiticRef && /\b(site|page|link|url|article|result)\b/i.test(msg))) {
    const lastAssistantMsg = conversationHistory
      .slice()
      .reverse()
      .find(m => m.role === 'assistant' && m.content);
    if (lastAssistantMsg?.content) {
      const urlMatches = lastAssistantMsg.content.match(/https?:\/\/[^\s,)"'\]]+/g) || [];
      const uniqueUrls = [...new Set(urlMatches)].slice(0, 5); // cap at 5 to avoid prompt bloat
      if (uniqueUrls.length === 1) {
        resolvedMessage = `${message} (referring to: ${uniqueUrls[0]})`;
      } else if (uniqueUrls.length > 1) {
        resolvedMessage = `${message} (prior answer mentioned these sites: ${uniqueUrls.join(', ')})`;
      }
    }
  }

  return { carriedIntent: previousIntent, resolvedMessage };
}

/**
 * Layer 2: Does this message contain pronouns that need Python coreference?
 *
 * Only call the service when:
 *  1. The message contains a pronoun, AND
 *  2. The pronoun's referent is NOT already named in the same message.
 *
 * If the message names a concrete noun (file, app, person name, path) alongside
 * the pronoun, the pronoun refers to that noun — no external resolution needed.
 * Calling the coreference service in these cases causes it to latch onto the
 * previous conversation role ("Assistant") instead of the in-message noun.
 *
 * Examples that should SKIP coreference:
 *   "find the file cheese and tell me what it's about"  — "it" = cheese (named)
 *   "open notes.txt and read it"                        — "it" = notes.txt (named)
 *   "find cheese and analyze it"                        — "it" = cheese (named)
 *
 * Examples that should RUN coreference:
 *   "can you explain it more"                           — no referent in message
 *   "what did he say"                                   — no referent in message
 *   "tell me more about that"                           — no referent in message
 */
function needsPronounResolution(message) {
  if (!/\b(he|she|it|they|him|her|his|their|them|its|this|that|these|those)\b/i.test(message)) {
    return false;
  }

  // If the message already names a concrete noun that the pronoun can refer to,
  // skip the coreference service — the LLM planner will handle it in context.
  const hasConcreteReferent =
    // Named file or path (word.ext or bare noun near "file"/"folder"/"document")
    /\b\w+\.\w{1,6}\b/.test(message) ||
    /\b(file|folder|directory|document|doc|app|application|program|window|tab|page|script|command)\s+\w/i.test(message) ||
    // Verb followed by a concrete noun (≥4 chars) that is NOT a generic filler/adverb.
    // Generic words like 'again', 'more', 'that', 'this', 'now', 'back', 'here', 'away'
    // are NOT referents — they're modifiers. Require at least one non-generic noun.
    (/\b(find|open|read|close|analyze|summarize|scan|check|run|execute|launch|locate|search for)\b.{0,60}\b[a-z]{4,}\b/i.test(message) &&
     !/^(close|open|read|find|run|launch|execute|check|scan)\s+(it|this|that|them|again|more|now|back|here|up|down|away|there)\s*$/i.test(message.trim()));

  if (hasConcreteReferent) {
    return false;
  }

  return true;
}

module.exports = async function resolveReferences(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;

  // ── skill_build fast-path — skip all resolution for skill build requests ───
  if (state.skillBuildRequest && state.intent?.type === 'skill_build') {
    logger.info('[Node:ResolveReferences] skill_build passthrough — skipping coreference resolution');
    return state;
  }

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
    let sessionId = context?.sessionId;
    // No explicit sessionId (fresh prompt window) — route to get the active session
    if (!sessionId) {
      try {
        const routeResult = await mcpAdapter.callService('conversation', 'session.route', { text: message });
        sessionId = (routeResult.data || routeResult)?.sessionId || null;
        if (sessionId) logger.debug(`[Node:ResolveReferences] No sessionId in context, routed to: ${sessionId}`);
      } catch (_) {}
    }
    if (sessionId) {
      const histResult = await mcpAdapter.callService('conversation', 'message.list', {
        sessionId,
        limit: 20,
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
      // Reject if message starts with a communication/action verb — 'this/it' in these
      // messages refers to prior context (e.g. search results), not a proper noun.
      // e.g. "text this to me" → DO NOT resolve 'this' to 'Eats' or any prior noun.
      const COMM_ACTION_START = /^(text|send|email|call|message|share|forward|post|tweet|dm|ping|notify|alert|remind|tell)/i;
      if (COMM_ACTION_START.test(message.trim())) {
        logger.debug('[Node:ResolveReferences] Rejecting simple_fallback on communication-action message, using original');
        resolvedMessage = message;
      }
      // Also reject if any replacement modifies an adjective/determiner before a path/location noun
      // e.g. "that folder" → "Assistant folder" corrupts the folder name the user intended
      const PATH_NOUN = /\b(folder|directory|file|path|dir|desktop|document|screenshot|image|photo)\b/i;
      const corruptsPathContext = replacements.some(r => {
        if (!r.original || !r.resolved) return false;
        const origLower = String(r.original).toLowerCase().trim();
        const resolvedLower = String(r.resolved).toLowerCase().trim();
        // If the original was a determiner/pronoun and the replacement sits before a path noun
        const isDeterminer = /^(that|this|those|these|the|it|its)$/.test(origLower);
        const isBeforePathNoun = PATH_NOUN.test(resolvedMessage.toLowerCase().replace(resolvedLower, '').slice(resolvedMessage.toLowerCase().indexOf(resolvedLower)));
        return isDeterminer && isBeforePathNoun;
      });
      if (corruptsPathContext) {
        logger.debug('[Node:ResolveReferences] Rejecting simple_fallback that corrupts path/folder context, using original');
        resolvedMessage = message;
      }
    }

    // ── Cross-method guards (apply regardless of coreferee/simple_fallback) ─────
    if (replacements.length > 0 && resolvedMessage !== message) {
      // Guard A: close/quit/kill + pronoun resolved to anything other than last opened file.
      // Priority 1: use authoritative lastOpenedFilePath from state (set by executeCommand).
      // Priority 2: fall back to scanning conversation history for open <file> pattern.
      const CLOSE_VERB_START = /^(close|quit|kill|exit|stop|hide|minimize|terminate)\b/i;
      if (CLOSE_VERB_START.test(message.trim())) {
        const stateLastOpened = state.lastOpenedFilePath || null;
        if (stateLastOpened) {
          // Authoritative: state has the real path, reject any resolution not pointing to it
          const openedStem = require('path').basename(stateLastOpened, require('path').extname(stateLastOpened)).toLowerCase();
          const resolvedToOpenedFile = replacements.some(r =>
            String(r.resolved || '').toLowerCase().includes(openedStem)
          );
          if (!resolvedToOpenedFile) {
            logger.debug(`[Node:ResolveReferences] Rejecting ${method} close-verb resolution (state has lastOpenedFilePath="${stateLastOpened}")`);
            resolvedMessage = message;
          }
        } else {
          // Fallback: scan conversation history for open <file> pattern
          const openedFilePattern = /open\s+['"]?([^\s'"]+\.[a-zA-Z0-9]+)['"]?/i;
          const lastOpenMsg = conversationHistory.slice().reverse().find(
            m => m.role === 'user' && openedFilePattern.test(m.content || '')
          );
          if (lastOpenMsg) {
            const openedMatch = (lastOpenMsg.content || '').match(openedFilePattern);
            const openedFile = openedMatch ? openedMatch[1] : null;
            if (openedFile) {
              const resolvedToOpenedFile = replacements.some(r =>
                String(r.resolved || '').toLowerCase().includes(
                  openedFile.toLowerCase().replace(/\.[^.]+$/, '')
                )
              );
              if (!resolvedToOpenedFile) {
                logger.debug(`[Node:ResolveReferences] Rejecting ${method} close-verb resolution — artifact, not opened file "${openedFile}"`);
                resolvedMessage = message;
              }
            }
          }
        }
      }

      // Guard B: 'it/its/it's/this/that' resolves to a proper noun or bare capitalised word
      // with confidence < 0.90 — these are NER false positives or listing noise.
      // e.g. "did you find it" → "did you find Assistant" (proper noun substitution, wrong)
      // e.g. "what it's about" → "what Assistant's about" (possessive form, also wrong)
      // e.g. "close it" → "close Screenshot" (ls listing noise, wrong)
      if (resolvedMessage !== message) {
        const pronounReplacement = replacements.find(r =>
          /^(it|its|it's|this|that)$/i.test(String(r.original || '').trim())
        );
        if (pronounReplacement) {
          // Strip possessive 's from resolved value before checking (e.g. "Assistant's" → "Assistant")
          const resolved = String(pronounReplacement.resolved || '').trim().replace(/'s$/, '');
          // A bare capitalised word with no dot = likely a proper noun substitution or listing artifact
          const isProperNounSub = !resolved.includes('.') && /^[A-Z][a-zA-Z]+$/.test(resolved);
          if (isProperNounSub && (pronounReplacement.confidence || 0) < 0.90) {
            logger.debug(`[Node:ResolveReferences] Rejecting ${method} pronoun→proper-noun "${resolved}" (conf ${pronounReplacement.confidence})`);
            resolvedMessage = message;
          }
        }
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

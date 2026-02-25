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

  // ── Hard overrides — run BEFORE carriedIntent and BEFORE phi4 ML ──────────
  // These must never be bypassed by resolveReferences carryover.

  // Filesystem / folder action override:
  // "I need you to scan the folder X", "scan the folder X", "read the files in X",
  // "analyze the screenshots in X", "list files in X", "show me the files on my desktop"
  // These are always command_automate (fs.read / image.analyze), never memory_retrieve.
  if (/\b(scan|read|list|analyze|summarize|go through|look (at|through)|check|open|explore)\b.{0,60}\b(folder|directory|dir|path|file|files|screenshot|screenshots|image|images|photo|photos|desktop|downloads|documents|home directory|~\/)\b/i.test(classifyMessage) ||
      /\bI need you to\b.{0,80}\b(folder|directory|file|files|screenshot|desktop)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Filesystem action override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'filesystem-action-override', processingTimeMs: 0 } };
  }

  // Capability question override:
  // "Do you have a skill to X", "Can you X for me", "Is there a skill that X"
  // These mean "use a skill to do X" = command_automate, not screen_intelligence.
  if (/\b(do you have (a skill|the ability|a way|a tool) to\b|can you (use|run|execute|do) .{0,40}\b(skill|command|shell|terminal|browser)\b|is there a skill (to|that|for)\b)/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Capability-question override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'capability-question-override', processingTimeMs: 0 } };
  }

  // File tag override — [File: /path] tag from drag-and-drop or Shift+Cmd+C
  if (/\[File:\s*[^\]]+\]/.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] File tag override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'file-tag-override', processingTimeMs: 0 } };
  }

  // ── Skill-name direct invocation ─────────────────────────────────────────
  // Users can invoke skills directly by name: "file.bridge read", "fs.read explore ~/projects/myapp"
  // The word.word format is unique to ThinkDrop skills — no conflict with normal sentences.
  // Also catches: "list skills", "what skills are available", "show me the skills"
  const KNOWN_SKILLS = [
    'file.bridge', 'fs.read', 'file.watch',
    'shell.run', 'browser.act',
    'ui.axClick', 'ui.findAndClick', 'ui.moveMouse', 'ui.click', 'ui.typeText', 'ui.waitFor', 'ui.screen.verify',
    'image.analyze', 'needs_install', 'synthesize', 'schedule',
    'guide.step',
  ];

  const LIST_SKILLS_PATTERN = /^(list|show|what are( the)?|show me( the)?|tell me( the)?|what)\s+(skills|available skills|thinkdrop skills|all skills)/i;

  // Check if the message starts with or contains a known skill name
  const msgLower = classifyMessage.trim().toLowerCase();
  const invokedSkill = KNOWN_SKILLS.find(s => {
    const sl = s.toLowerCase();
    // Direct invocation: message starts with the skill name
    if (msgLower === sl || msgLower.startsWith(sl + ' ') || msgLower.startsWith(sl + ':')) return true;
    // Natural-language invocation: "use the shell.run", "use shell.run", "use the browser.act skill"
    // The dot-word pattern is unique to ThinkDrop skills — safe to match anywhere in the sentence
    const idx = msgLower.indexOf(sl);
    if (idx !== -1) {
      // Must be preceded by a word boundary (space or start)
      const before = idx === 0 ? '' : msgLower[idx - 1];
      const after = msgLower[idx + sl.length] || '';
      if ((before === '' || before === ' ' || before === '\t') &&
          (after === '' || after === ' ' || after === ':' || after === ',' || after === '.')) {
        return true;
      }
    }
    return false;
  });

  // Also catch natural-language references to skill categories without the dot-name:
  // "use a shell skill", "use the shell skill", "run a shell command", "use browser automation"
  const SKILL_CATEGORY_PATTERN = /\b(use (a |the |a |the )?shell (skill|command|run)|run (a |the )?shell|use (a |the )?browser (skill|automation|act)|use (a |the )?ui skill)\b/i;
  const naturalSkillInvocation = !invokedSkill && SKILL_CATEGORY_PATTERN.test(classifyMessage);

  if (invokedSkill || naturalSkillInvocation) {
    const skillHint = invokedSkill || (SKILL_CATEGORY_PATTERN.test(classifyMessage) && classifyMessage.match(/browser/i) ? 'browser.act' : 'shell.run');
    logger.debug(`[Node:ParseIntent] Skill-name invocation → command_automate: "${classifyMessage}" (skill: ${skillHint})`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: skillHint }], requiresMemoryAccess: false }, metadata: { parser: 'skill-name-invocation', processingTimeMs: 0 } };
  }

  if (LIST_SKILLS_PATTERN.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] list-skills override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'list_skills' }], requiresMemoryAccess: false }, metadata: { parser: 'list-skills-override', processingTimeMs: 0 } };
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

  // Past-tense action report override — must run BEFORE browser automation override.
  // "sent a message to X", "sent an email to X", "called X", "messaged X", "told X" etc.
  // User is reporting something they did → always memory_store.
  // Must come BEFORE browser override because "sent ... in slack" matches destPrepMatch.
  const pastTenseActionReport = /^(sent (a |an )?(message|email|text|slack|dm|note|reply|response|invite|request)|called |messaged |texted |emailed |told |informed |notified |pinged |dm'd |dmed )/i;
  if (pastTenseActionReport.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Past-tense action report override → memory_store: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'memory_store',
        confidence: 0.95,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'past-tense-action-override', processingTimeMs: 0 }
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

  // System-info override — "what's today's date", "what time is it", "what's my battery", etc.
  // These are trivially answerable by shell.run — must go to command_automate, not general_query.
  const sysInfoPattern = /\b(what('s| is)( the)?|tell me( the)?|show me( the)?|get( the)?)\s+(today'?s?|current|the)\s+(date|time|day|battery|wifi|disk|ip address|timezone|hostname|username)\b|\b(what('s| is)( today'?s?| the current| the)?)\s+(date|time|day)\b|\btoday'?s?\s+date\b|\bwhat day is (today|it)\b|\bwhat time is it\b/i;
  if (sysInfoPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] System-info override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'system-info-override', processingTimeMs: 0 } };
  }

  // IDE/bridge setup override — catches "I want my IDE to communicate with ThinkDrop",
  // "connect Cursor to ThinkDrop", "how do I link Warp to you", etc.
  // Must run BEFORE the how-to guard so these don't get swallowed by general_query.
  const ideSetupPattern = /\b(connect|setup|set up|link|integrate|configure|use|get|add|communicate|talk|work with)\b.{0,60}\b(ide|windsurf|cursor|warp|zed|vscode|vs code|copilot|editor|bridge|thinkdrop bridge)\b|\b(ide|windsurf|cursor|warp|zed|editor)\b.{0,60}\b(communicate|talk|connect|work with|integration|setup|set up|linked?|bridge)\b|\b(my|my\s+\w+)\s+(ide|editor|windsurf|cursor|warp)\b.{0,60}\b(communicate|talk|connect|to you|with you|thinkdrop)\b/i;
  if (ideSetupPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] IDE-setup override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'ide-setup-override', processingTimeMs: 0 } };
  }

  // How-to guard — must run BEFORE memory-query guard and browser override.
  // "How do I X", "how can I X", "how to X" are general_query (answer node decides
  // whether to answer or offer a guide). They are NOT browser automation or memory_retrieve.
  // EXCEPTION: IDE/bridge setup questions already handled above.
  const ideSetupException = ideSetupPattern;
  const howToPattern = /^(how (do|can|would|should|do you|can you|would you|to)|what('s| is) the (best |easiest |fastest )?way to|what steps|what are the steps)/i;
  if (howToPattern.test(classifyMessage.trim()) && !ideSetupException.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] How-to guard → general_query: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'general_query',
        confidence: 0.90,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'how-to-guard', processingTimeMs: 0 }
    };
  }

  // Memory-query guard — must run BEFORE browser automation override.
  // Questions like "did I visit amazon", "have I been to X", "over the week did I X"
  // are memory_retrieve even though they contain site names or visit verbs.
  // Pattern: question structure (did I / have I / was I) + optional time ref + any verb
  // NOTE: 'do i' removed — it matches "How do I..." which is a how-to question, not memory recall
  const memoryQueryPattern = /\b(did i|have i|was i|had i|have i ever|did i ever|when did i|how many times did i|how often did i)\b/i;
  const pastWeekPattern = /\b(over the (week|past week|last week|month|past month)|this week|last week|last month|yesterday|this morning|recently|lately|in the (past|last) \d+ (days?|weeks?|months?))\b/i;
  if (memoryQueryPattern.test(classifyMessage) || (pastWeekPattern.test(classifyMessage) && /\b(visit|go|went|use|open|check|browse|look at|view)\b/i.test(classifyMessage))) {
    logger.debug(`[Node:ParseIntent] Memory-query guard → memory_retrieve: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'memory_retrieve',
        confidence: 0.92,
        entities: [],
        requiresMemoryAccess: true
      },
      metadata: { parser: 'memory-query-guard', processingTimeMs: 0 }
    };
  }

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

  // UI mouse action override — must run BEFORE phi4 ML call.
  // "hover over X", "move mouse to X", "move the mouse to X", "mouse over X" → always command_automate.
  // These are direct UI testing/automation commands that phi4 would misclassify.
  const uiMouseActionPattern = /\b(hover over|hover on|move (the )?mouse (to|over|onto)|mouse over|point (the )?mouse (at|to|over)|move cursor (to|over)|position (the )?(mouse|cursor) (on|over|at|to))\b/i;
  if (uiMouseActionPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] UI mouse action override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.98,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'ui-mouse-action-override', processingTimeMs: 0 }
    };
  }

  // Guide-task guard — must run BEFORE action-request override AND phi4 ML call.
  // "renew X", "apply for X", "register for X", "sign up for X", "fill out X form"
  // are government/manual tasks that should flow through the answer node to get
  // the guide offer first — NOT directly to planSkills as command_automate.
  const guideTaskPattern = /\b(renew|apply for|register for|sign up for|fill out|complete|submit an? application|get a|obtain a|replace my|update my)\b.{0,60}\b(license|passport|id|permit|registration|visa|certificate|insurance|benefit|form|application|dmv|real id|driver|vehicle)\b/i;
  if (guideTaskPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Guide-task guard → general_query (answer node): "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'general_query',
        confidence: 0.90,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'guide-task-guard', processingTimeMs: 0 }
    };
  }

  // Action-request override — must run BEFORE phi4 ML call.
  // "I need to X", "I need you to X", "can you do X for me", "help me X", "do X for me"
  // where X is a task verb → always command_automate.
  // EXCLUDED: renew/apply/register/sign-up/fill out — handled by guide-task-guard above.
  const actionRequestPattern = /\b(i need (you to|to) (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|check|look up|navigate|find|search)|can you (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|navigate|find|search)|help me (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|navigate|find|search)|do this for me)\b/i;
  if (actionRequestPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Action-request override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.95,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'action-request-override', processingTimeMs: 0 }
    };
  }

  // File-write destination override — must run BEFORE phi4 ML call.
  // Any prompt containing a file-write instruction ("save to ~/Desktop/file.md",
  // "write to /tmp/out.txt") is always command_automate — the plan must write the file.
  const fileWriteDestPattern = (
    /\b(save|write|output|store|put)\b.{0,80}(to|into|as)\s+(~[/]|[/]|[.][/])[\w/.]+/i.test(classifyMessage) ||  // explicit path
    /\b(save|write|output|store|put)\b.{0,80}(to|into)\s+(a\s+)?(file|txt|text file|markdown file|md file|\.txt|\.md|\.csv|\.json)\b/i.test(classifyMessage) ||  // "save to a file"
    /\b(save|write|output)\b.{0,80}(on|in|to)\s+(my\s+)?(desktop|documents|downloads|home folder|home directory)\b/i.test(classifyMessage)  // "save to my desktop/documents"
  );
  if (fileWriteDestPattern) {
    logger.debug(`[Node:ParseIntent] File-write destination override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.97,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'file-write-override', processingTimeMs: 0 }
    };
  }

  // File bridge override — must run BEFORE phi4 ML call.
  // "write to windsurf", "tell windsurf to", "send to cursor", "check the bridge file",
  // "read what windsurf wrote", "poll for windsurf response" → always command_automate.
  const fileBridgePattern = /\b(write to (windsurf|cursor|warp|the bridge|bridge file)|tell (windsurf|cursor|warp) to|send (this |an? )?(instruction|message|task|result|context) to (windsurf|cursor|warp)|check (the )?bridge( file)?|act on (the )?bridge|execute (the |bridge )?(bridge )?instructions?|do what the bridge says|run the bridge task|read (what |the )?(windsurf|cursor|warp) (wrote|responded|said|returned)|poll (for )?(windsurf|cursor) (response|reply|result)|bridge (file|channel)|init(ialize)? (the )?bridge|clear (the )?bridge)/i;
  if (fileBridgePattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] File-bridge override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.97,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'file-bridge-override', processingTimeMs: 0 }
    };
  }

  // Codebase / file-read override — must run BEFORE phi4 ML call.
  // "read the codebase at X", "understand the app at ~/path", "explore ~/projects/foo",
  // "analyze the project", "read and understand X" → always command_automate (fs.read skill).
  // Also catches: watch a file, tail a log, show directory tree.
  const codebaseReadVerbPattern = /\b(read and understand|read.*codebase|understand.*codebase|explore.*codebase|analyze.*codebase|examine.*codebase|read the (app|project|repo|repository|code)|understand the (app|project|repo|repository|code)|explore the (app|project|repo|code)|analyze the (app|project|repo|code)|show me the (directory |folder |file )?structure|directory structure|folder structure|file tree|give me an overview of|map out the)\b/i;
  const codebaseReadPathPattern = /\b(read|understand|explore|analyze|examine|inspect|index|scan|overview of)\b.{0,80}(codebase|repo|repository)\b/i;
  const codebasePathPattern = /\b(read|understand|explore|analyze|examine)\b.{1,60}(~\/|\/Users\/|\/home\/)/;
  const fileWatchPattern = /\b(watch|monitor|tail|follow)\b.{0,60}\b(file|log|\.log)\b/i;
  const treePattern = /\b(show|list|print|display|map)\b.{0,40}\b(directory tree|folder tree|file tree|structure of|tree of)\b/i;
  if (codebaseReadVerbPattern.test(classifyMessage) || codebaseReadPathPattern.test(classifyMessage) || codebasePathPattern.test(classifyMessage) || fileWatchPattern.test(classifyMessage) || treePattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Codebase/file-read override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'command_automate',
        confidence: 0.97,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'codebase-read-override', processingTimeMs: 0 }
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
  const temporalMemoryPattern = /\b(yesterday|last (week|month|night|year)|this (morning|week|month)|earlier today|a (few )?(days?|weeks?|months?) ago|(\d+|one|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?|months?) ago)\b/i;
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

    // Post-phi4 correction: low-confidence memory_store with retrieval verbs → memory_retrieve.
    // phi4 sometimes misclassifies "give the date of that day", "tell me what X was" as memory_store.
    const lowConfRetrievalVerb = /^(give|tell|show|what|which|when|where|who|how|list|find|recall|describe|explain)\b/i;
    if (finalIntent === 'memory_store' && finalConfidence < 0.6 && lowConfRetrievalVerb.test(classifyMessage.trim())) {
      logger.debug(`[Node:ParseIntent] Post-phi4 correction: low-confidence memory_store + retrieval verb → memory_retrieve`);
      return {
        ...state,
        intent: {
          type: 'memory_retrieve',
          confidence: 0.80,
          entities: intentData.entities || [],
          requiresMemoryAccess: true
        },
        metadata: { parser: 'phi4-corrected-retrieve', processingTimeMs: intentData.metadata?.processingTimeMs || 0 }
      };
    }

    // Post-phi4 correction: low-confidence memory_store with action verbs → command_automate.
    // phi4 sometimes misclassifies "I need to renew/book/apply/fix..." as memory_store.
    const lowConfActionVerb = /\b(renew|book|apply|register|schedule|order|buy|purchase|sign up|fill out|submit|install|download|update|fix|set up|create|send|navigate|open|search|find|go to)\b/i;
    if (finalIntent === 'memory_store' && finalConfidence < 0.5 && lowConfActionVerb.test(classifyMessage)) {
      logger.debug(`[Node:ParseIntent] Post-phi4 correction: low-confidence memory_store + action verb → command_automate`);
      return {
        ...state,
        intent: {
          type: 'command_automate',
          confidence: 0.85,
          entities: intentData.entities || [],
          requiresMemoryAccess: false
        },
        metadata: { parser: 'phi4-corrected', processingTimeMs: intentData.metadata?.processingTimeMs || 0 }
      };
    }
    
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

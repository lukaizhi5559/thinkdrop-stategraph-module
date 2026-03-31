/**
 * Parse Intent Node - Extracted with graceful degradation
 * 
 * Extracts intent and entities from user message.
 * Works with or without MCP adapter:
 * - With MCP: Uses phi4 service for ML-based classification
 * - Without MCP: Uses rule-based fallback classification
                                                                                                                                                                                                                                                                                              *
 * NOTE: Project detection (launch/stop/edit of ~/.thinkdrop/projects) is handled
 * by the parseProject node, which runs AFTER enrichIntent routes app_control_start.
 * This keeps parseIntent lean — no LLM call on every message.
 */

module.exports = async function parseIntent(state) {
  const { mcpAdapter, message, resolvedMessage, carriedIntent, context, llmBackend, conversationHistory, activeBrowserSessionId, activeBrowserUrl } = state;
  const logger = state.logger || console;

  // ── skill_build fast-path: never re-classify skill build requests ──────────
  // main.js sets intent.type='skill_build' + skillBuildRequest before calling execute().
  // parseIntent must not overwrite this — phi4 would misclassify the synthetic message.
  if (state.skillBuildRequest && state.intent?.type === 'skill_build') {
    logger.info('[Node:ParseIntent] skill_build passthrough — preserving skill_build intent');
    return state;
  }

  // ── Multi-intent plan: process sub-prompts produced by decomposePrompt ──────
  // When decomposePrompt detected a complex/multi-intent message and produced an
  // intentPlan, we classify each sub-prompt independently:
  //   - Sub-prompt [0]: run through THIS full function (recursive, no intentPlan) so all
  //     hard overrides and DistilBERT operate on the clean, focused sub-prompt text.
  //   - Sub-prompts [1..N]: quick phi4 classification (already short, focused) → intentQueue.
  // The original message is preserved in state.originalPrompt for context/logging.
  if (state.intentPlan && Array.isArray(state.intentPlan) && state.intentPlan.length > 1) {
    logger.info(`[Node:ParseIntent] intentPlan detected (${state.intentPlan.length} sub-prompts) — processing multi-intent pipeline`);

    const firstSub = state.intentPlan[0];

    // Classify first sub-prompt through the full parseIntent logic
    const firstResult = await module.exports({
      ...state,
      message:        firstSub.text,
      resolvedMessage: firstSub.text,
      intentPlan:     null,   // prevent infinite recursion
      carriedIntent:  null,   // suppress prior carriedIntent — sub-prompts are self-contained
    });

    // Classify remaining sub-prompts via phi4 directly
    const intentQueue = [];
    for (const subPrompt of state.intentPlan.slice(1)) {
      let classifiedIntent = subPrompt.estimatedIntent;
      let classifiedConf   = 0.65;

      if (mcpAdapter) {
        try {
          const r = await mcpAdapter.callService('phi4', 'intent.parse', {
            message: subPrompt.text,
            context: { sessionId: state.context?.sessionId, userId: state.context?.userId },
          });
          const d = r?.data || r;
          if (d?.intent) {
            classifiedIntent = d.intent;
            classifiedConf   = d.confidence || 0.65;
          }
        } catch (e) {
          logger.debug(`[Node:ParseIntent] Sub-prompt [${subPrompt.order}] classification error: ${e.message}`);
        }
      }

      intentQueue.push({ ...subPrompt, intent: classifiedIntent, confidence: classifiedConf });
      logger.debug(`[Node:ParseIntent] Sub-prompt [${subPrompt.order}] "${subPrompt.text.slice(0, 60)}" → ${classifiedIntent} (${classifiedConf.toFixed(2)})`);
    }

    return {
      ...firstResult,
      intentQueue,
      intentResults:  [],
      dataContext:    {},
      isMultiIntent:  true,
      originalPrompt: state.message,
    };
  }

  // Prefer coreference-resolved message for classification
  // NOTE: declared as let so the non-English translation block can update it before phi4.
  let classifyMessage = resolvedMessage || message;

  logger.debug('[Node:ParseIntent] Parsing intent...');
  if (resolvedMessage && resolvedMessage !== message) {
    logger.debug(`[Node:ParseIntent] Using resolved message: "${resolvedMessage}"`);
  }

  // ── Hard overrides — run BEFORE carriedIntent and BEFORE phi4 ML ──────────
  // These must never be bypassed by resolveReferences carryover.

  // App control mode override — must beat carriedIntent entirely.
  // "turn on control mode", "control Slack", "exit control mode", etc.
  // These are NEVER command_automate / memory_retrieve — they are app_control_start.
  // carriedIntent from a prior command_automate run would completely suppress DistilBERT
  // for these phrases, so we intercept them here unconditionally.
  const APP_CONTROL_ENTER_RE = /\b(turn\s+on|enable|activate|enter|start|switch\s+to|app\s+control|control\s+mode\s+on)\b.{0,20}\bcontrol\s*(mode)?\b|\bcontrol\s+(slack|word|chrome|safari|firefox|figma|vscode|vs\s*code|notion|gmail|zoom|this\s+app|the\s+app|current\s+app)\b|\b(control\s+mode|app\s+control)\b|\b(start|begin)\s+controlling\s+\S+|\b(take|seize|grab)\s+(over|control\s+of)\s+\S+|\blet\s+me\s+take\s+(over|charge\s+of)\b/i;

  // App-launch override — BEFORE browser-override: "Open X", "Launch X", "Switch to X",
  // "Start X", "Pull up X" where X is a single app/tool name (not a URL, not a sentence).
  // Also catches voice split: "o pen day one jour nal app", "launch pen pot for de sign work".
  // These are ALWAYS app_control_start.
  // EXCLUDED: compound commands with "and" ("Open Notion and jump to my notes" = command_automate)
  // EXCLUDED: tutorial/cheat-sheet requests ("Open a Python cheat sheet")
  const appLaunchNaked = /^(open|launch|start|switch\s+to|pull\s+up|bring\s+up|o\s+pen|o pen)\s+(\w[\w\s.'\-]{0,40}?)\s*$/i;
  const appLaunchMatch = classifyMessage.trim().match(appLaunchNaked);
  if (appLaunchMatch) {
    const dest = appLaunchMatch[2].trim();
    // Exclude if destination looks like a full sentence, URL, compound command, or system resource
    const looksLikeApp = dest.length <= 60 &&
      !/https?:\/\/|www\./i.test(dest) &&
      !/\.(com|org|io|ai|app|net|co|dev|gov|edu)\b/i.test(dest) &&
      !/\bthe\s+(browser|screen|app|window|tab|page|file|folder|document)\b/i.test(dest) &&
      !/(my|a|an)\s+browser\b/i.test(dest) &&
      !/\bstatus\s+bar\b/i.test(dest) &&
      // Exclude deep-navigation / multi-step compound commands
      // "and jump to", "and go to", "and navigate to", "and play my X", "and run", "and create", "and show"
      !/\b(and|then)\s+(jump\s+to|go\s+to|navigate\s+to|scroll\s+to|click\s+on|run|install|create|show|deploy|launch)\b/i.test(dest) &&
      !/\band\s+play\s+(my|the|a)\b/i.test(dest) &&
      // Exclude "pull up" when destination is a retrieval phrase, not an app name
      // e.g. "pull up everything I've told you", "pull up all my notes about Nala"
      // Also handles voice-split: "pull up every thing I told you" = "everything"
      !(appLaunchMatch[1] && /pull\s+up/i.test(appLaunchMatch[1]) &&
        /^(every\s*thing|every thing|something|anything|what|all\s+(my|i|i've|the)|any|the\s+(last|full|all)|my\s+)/i.test(dest)) &&
      // Exclude tutorial/resource requests: "a Python cheat sheet", "up a guide"
      // Also excludes coding playgrounds / sandboxes (web resources, not installable apps)
      !/\b(cheat\s*sheet|guide|tutorial|documentation|docs|walkthrough|reference|example|playground|sandbox|fiddle|repl\.it|codepen|jsfiddle)\b/i.test(dest) &&
      // Exclude workspace/vault-specific destination (e.g. "Open Obsidian vault" = command_automate)
      !/\b(vault|workspace|project folder)\b/i.test(dest);
    if (looksLikeApp) {
      // Opening an app → command_automate so planSkills uses shell.run (open -a AppName).
      // app_control_start is reserved for explicit UI-control requests ("control Slack", "control mode").
      logger.debug(`[Node:ParseIntent] App-launch override → command_automate (shell.run): "${classifyMessage}"`);
      return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'app-launch-override', processingTimeMs: 0 } };
    }
  }

  // "Open [App] so I can X" / "Open [App] to X" — purpose suffix makes appLaunchNaked too short.
  // Catch before browser-override so navVerbMatch("open Spotify") doesn't route to browser.act.
  const appLaunchPurpose = classifyMessage.trim().match(/^(open|launch|start|pull\s+up)\s+(\w[\w\s.'\-]{1,30}?)\s+(so\s+(i|we|you)\s+(can|could)|to\s+(listen|watch|work|play|use|check|access|browse|read|write|edit)|for\s+(me\s+so|playing|listening|working|watching|music|streaming))\b/i);
  if (appLaunchPurpose) {
    const appName = appLaunchPurpose[2].trim();
    if (!/ \b(and|then)\b/i.test(appName) &&
        !/\.(com|org|io|ai|app|net|co|dev)\b/i.test(appName) &&
        appName.split(' ').length <= 4) {
      logger.debug(`[Node:ParseIntent] App-launch-purpose override → command_automate (shell.run): "${classifyMessage}"`);
      return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'app-launch-override', processingTimeMs: 0 } };
    }
  }

  // "Get [App] open so I can X" / "Pull up [App] so I can X" → command_automate (shell.run).
  // phi4/browser-override catches "Get Linear open so I can check the sprint board".
  const appGetOpenMatch = classifyMessage.trim().match(/^(get|pull\s+up|bring\s+up)\s+(\w[\w\s.'\-]{1,30}?)\s+(open|up|running|started|going)\b/i);
  if (appGetOpenMatch) {
    const appName = appGetOpenMatch[2].trim();
    if (!/\.(com|org|io|ai|app|net)\b/i.test(appName) && !/\bmy\s+(browser|screen|app)\b/i.test(appName)) {
      logger.debug(`[Node:ParseIntent] App-get-open override → command_automate (shell.run): "${classifyMessage}"`);
      return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'app-launch-override', processingTimeMs: 0 } };
    }
  }
  const APP_CONTROL_EXIT_RE = /\b(exit|stop|quit|turn\s+off|disable|deactivate|leave|end|release)\b.{0,20}\bcontrol(\s+mode)?\b|\bcontrol\s+mode\s+(off|done)\b/i;
  if (APP_CONTROL_ENTER_RE.test(classifyMessage) || APP_CONTROL_EXIT_RE.test(classifyMessage)) {
    logger.info(`[Node:ParseIntent] App control override → app_control_start: "${classifyMessage}"`);
    return { ...state, intent: { type: 'app_control_start', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'app-control-override', processingTimeMs: 0 } };
  }

  // Messaging verb override — HIGHEST PRIORITY: must beat carriedIntent + intent_override.search.
  // "text this to me", "send that info to me", "email me the results", "text me this info"
  // "text this info", "send that", "email these results" (bare messaging verbs)
  // These are ALWAYS command_automate (trigger SMS/email/skill), never screen_intelligence.
  // Destination fragment: "to me", "to my me" (typo), "to my phone/cell/number/email/inbox"
  const TO_ME_DEST = /to\s+(my\s+)?(me|phone|cell\s*phone?|number|email|inbox)\b/i;
  const MESSAGING_VERB_OVERRIDE =
    // "text this to me", "send that info to me", "text these to my me"
    new RegExp(`^(text|send|email|message|forward)\\s+(this|it|that|these|those)(\\s+\\w+)?\\s+${TO_ME_DEST.source}`, 'i')
    // "text the info to me", "send the results to my phone"
    || new RegExp(`^(text|send|email|message|forward)\\s+the\\s+\\w[\\w\\s]{0,30}\\s+${TO_ME_DEST.source}`, 'i')
    // verb + me + object: "text me this", "send me the results", "email me it"
    || /^(text|send|email|message|forward)\s+me\s+(this|it|that|these|the\s+\w+)/i
    // bare messaging verb + demonstrative: "text this info", "send that", "email these results"
    || /^(text|send|email|message|forward)\s+(this|it|that|these|those|the)\s+/i;
  if (MESSAGING_VERB_OVERRIDE.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Messaging verb override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'messaging-verb-override', processingTimeMs: 0 } };
  }

  // Lift/remove constraint overrides — must run BEFORE set_constraint to avoid
  // "allow me to X again" or "remove the rule" firing the add-constraint path.
  // "remove the rule about X", "lift the constraint on X", "allow me to delete again",
  // "forget the rule", "I changed my mind about the rule", "undo the block on X"
  if (
    /\b(lift|remove|delete|cancel|undo|clear|disable|drop)\s+(the\s+)?(constraint|rule|block|restriction|ban)\b/i.test(classifyMessage) ||
    /\b(forget|ignore|discard)\s+(the\s+)?(rule|constraint|block|restriction)\b/i.test(classifyMessage) ||
    /\bi\s+changed\s+my\s+mind\s+(about\s+(the\s+)?(rule|constraint|block)|and\s+want\s+to\s+allow)\b/i.test(classifyMessage) ||
    (
      // "allow/let me to DELETE/VISIT/... again" — the action verb + "again" signals constraint reversal
      // Guard: must NOT be preceded by "don't/never/not" (that would be adding a constraint)
      /\b(allow|let)\s+me\s+(to\s+)?(delete|remove|access|visit|browse|open|navigate|go\s+to|install|download|send|email|push|deploy|run|execute|move|copy)\b.{0,40}\bagain\b/i.test(classifyMessage) &&
      !/\b(don'?t|do\s*not|donot|never|not)\b.{0,30}\b(allow|let)\s+me\b/i.test(classifyMessage)
    ) ||
    /\b(i\s+want\s+to\s+be\s+able\s+to)\b.{0,40}\bagain\b/i.test(classifyMessage) ||
    /\b(stop|no\s+longer)\s+(blocking|restricting)\b/i.test(classifyMessage)
  ) {
    logger.debug(`[Node:ParseIntent] Lift-constraint override → lift_constraint: "${classifyMessage}"`);
    return { ...state, intent: { type: 'lift_constraint', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'lift-constraint-override', processingTimeMs: 0 } };
  }

  // Set-constraint overrides — "never let me...", "don't let me...", "prevent me from...", etc.
  // These must route to set_constraint so the rule is stored in user_constraints, NOT executed.
  if (
    /^(never|don'?t|do\s+not|please\s+(don'?t|never|do\s+not))\s+(let\s+me|allow\s+(me\s+to|me)|let\s+me)\s+/i.test(classifyMessage) ||
    /^(prevent|stop)\s+me\s+from\s+/i.test(classifyMessage) ||
    /^(always\s+)?block\s+(me\s+from|any\s+attempt\s+to)\s+/i.test(classifyMessage) ||
    /^make\s+sure\s+(i|you)\s+(never|don'?t|do\s+not)\s+/i.test(classifyMessage) ||
    /^(refuse|deny|disallow|forbid)\s+(any\s+)?(request\s+to|me\s+(from\s+|to\s+))\s*/i.test(classifyMessage) ||
    /\b(never\s+let\s+me|don'?t\s+let\s+me|prevent\s+me\s+from|stop\s+me\s+from|block\s+me\s+from)\b/i.test(classifyMessage) ||
    // "do not/don't/donot allow me to go/visit/access/browse/open X" — block-site type constraints
    /\b(don'?t|do\s*not|donot|never|not)\s+(allow|let)\s+me\s+(to\s+)?(go\s+to|goto|visit|access|browse|open|navigate)\b/i.test(classifyMessage) ||
    /\b(block|prevent|stop)\s+me\s+(from\s+)?(going|visiting|accessing|browsing|opening|navigating)\b/i.test(classifyMessage)
  ) {
    logger.debug(`[Node:ParseIntent] Set-constraint override → set_constraint: "${classifyMessage}"`);
    return { ...state, intent: { type: 'set_constraint', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'set-constraint-override', processingTimeMs: 0 } };
  }

  // Build/create/make app override — ALWAYS command_automate, never web_search.
  // "build a tic tac toe game", "create a todo app", "make me a calculator",
  // "build a script that X", "create a tool to X", "make a dashboard for X"
  // DistilBERT scores these ~0.39 for both web_search and command_automate — must hard-pin.
  if (/^(build|create|make|generate|write|code|develop|implement)\b.{0,60}\b(app|application|game|tool|script|widget|dashboard|cli|bot|program|site|website|webapp|web app|extension|plugin|utility|calculator|tracker|manager|timer|reminder|scheduler)\b/i.test(classifyMessage) ||
      /^(build|create|generate)\s+(me\s+)?(a|an|the)\s+/i.test(classifyMessage) ||
      /^make\s+(me\s+)?(a|an|the)\s+(?!note\b)/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Build/create override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'build-create-override', processingTimeMs: 0 } };
  }

  // "Remind me about [X]" / "Remind me about my X" → fetch stored info → memory_retrieve.
  // Also catches voice-split "re mind me a bout [topic]".
  // EXCLUDED: "remind me in 5 min" / "remind me at 7am" (those are schedule reminders → command_automate).
  if (/^(hey\s+)?(remind\s+me\s+about|can\s+you\s+remind\s+me\s+about|re\s+mind\s+me\s+a\s+bout)\b/i.test(classifyMessage.trim()) &&
      !/\b(in\s+\d+|at\s+\d{1,2}|tomorrow|tonight|later|soon|this\s+(morning|evening|afternoon)|before\s+I|after\s+I|when\s+I)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Remind-me-about-my override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'remind-me-about-my-override', processingTimeMs: 0 } };
  }

  // Reminder / timer / alarm / schedule override:
  // "remind me in 5 minutes to check the oven", "set a timer for 10 minutes",
  // "wake me up at 7am", "alert me in 30 seconds", "in 5 min remind me to X",
  // "remind me tomorrow to call the dentist", "remind me tonight"
  // These are always command_automate (schedule pseudo-skill), never memory_store.
  // EXCLUDED: messages starting with "remember" — those are memory_store declarations.
  if (!(/^remember\b/i.test(classifyMessage)) && (
    /\b(remind|reminder|ping\s+me|timer|alarm|alert|wake\s+me(\s+up)?|notify)\b.*\b(in\s+\d+\s+(mins?|minutes?|secs?|seconds?|hours?|hrs?)|at\s+\d{1,2}[:.]\d{2}|at\s+\d{1,2}\s*(am|pm))\b/i.test(classifyMessage) ||
    /\b(in\s+\d+\s+(mins?|minutes?|secs?|seconds?|hours?|hrs?))\b.*\b(remind|alert|notify|tell|wake\s+me|ping\s+me)\b/i.test(classifyMessage) ||
    /\b(set\s+a?\s*(timer|alarm|reminder))\b/i.test(classifyMessage) ||
    /\b(remind|reminder|alert|ping)\s+me\b.{0,80}\b(tomorrow|tonight|later|soon|at\s+\d{1,2}\s*(am|pm)|this\s+(morning|evening|afternoon|weekend)|before\s+(i|we)|after\s+(i|we)|when\s+i)\b/i.test(classifyMessage) ||
    /\b(remind|alert|notify|ping)\s+me\b.{0,80}\bin\s+(uh\s+|um\s+|er\s+)?(a\s+)?(couple\s+of|few|one|two|three|four|five|ten|fifteen|twenty|thirty|sixty)\s+(minutes?|mins?|hours?|hrs?)\b/i.test(classifyMessage)
  )) {
    logger.debug(`[Node:ParseIntent] Reminder/schedule override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'reminder-schedule-override', processingTimeMs: 0 } };
  }

  // "I mean [action]" / "I meant [action]" clarification guard — pre-DistilBERT.
  // User is clarifying or correcting a previous request (e.g. "I mean on the Revealing Truth
  // channel give me a list of videos less than 5 mins"). Without this guard DistilBERT
  // sees "I mean ... channel ... 5 mins" and classifies as memory_store.
  if (/^\s*i\s+(mean|meant)\b/i.test(classifyMessage) &&
    /\b(go|find|get|show|list|give|search|look|navigate|browse|open|play|watch|click|run|navigate|pull|bring|check)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] "I mean" clarification override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.92, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-mean-clarification-override', processingTimeMs: 0 } };
  }

  // Screenshot / screen-capture hard override — must run BEFORE DistilBERT early exit.
  // DistilBERT now classifies "take a screenshot" as screen_intelligence at 0.95 confidence,
  // which triggers early exit and bypasses the safety-net guard below. Move it here so it
  // always fires before the early exit.
  if (/\b(take|grab|capture|get)\s+(a\s+)?(screenshot|screen\s*shot|screen\s*grab|screen\s*capture)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Screenshot pre-guard override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'screenshot-override', processingTimeMs: 0 } };
  }

  // Filesystem / folder action override:
  // "I need you to scan the folder X", "scan the folder X", "read the files in X",
  // "analyze the screenshots in X", "list files in X", "show me the files on my desktop"
  // These are always command_automate (fs.read / image.analyze), never memory_retrieve.
if ((/\b(scan|read|list|analyze|summarize|go through|look (at|through)|check|open|explore|find|locate|search for|get)\b.{0,60}\b(folder|directory|dir|path|file|files|screenshot|screenshots|image|images|photo|photos|desktop|downloads|documents|home directory|~\/)\b/i.test(classifyMessage) ||
  /\bI need you to\b.{0,80}\b(folder|directory|file|files|screenshot|desktop)\b/i.test(classifyMessage)) &&
  !/(currently\s+have|i\s+have|i'?m\s+currently)\s+(open|viewing|editing|looking\s+at|working\s+on|visible|showing)/i.test(classifyMessage) &&
  !/\bi\s+have\s+(visible|showing|displayed)\b/i.test(classifyMessage) &&
  !/\bvisible\s+on\s+(my\s+)?screen\b/i.test(classifyMessage)) {
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
  // Single-word skills are too ambiguous to match embedded — only match at start.
  // Dot-notation skills (shell.run, browser.act, etc.) are unique enough for embedded matching.
  const START_ONLY_SKILLS = new Set(['schedule', 'synthesize', 'needs_install', 'guide.step']);
  const invokedSkill = KNOWN_SKILLS.find(s => {
    const sl = s.toLowerCase();
    // All skills: match at start of message (direct invocation)
    if (msgLower === sl || msgLower.startsWith(sl + ' ') || msgLower.startsWith(sl + ':')) return true;
    // Single-word / start-only skills: don't match embedded (too risky)
    if (START_ONLY_SKILLS.has(s)) return false;
    // Dot-notation skills: safe to match embedded (unique format)
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

  // External skill management overrides:
  //   "install skill at <path>" WITH path → command_automate (planner executes install)
  //   "install a skill" WITHOUT path → skill_clarify intent (answer node asks for path)
  //   "remove skill <name>" WITH name → command_automate
  //   "remove skill" WITHOUT name → skill_clarify (ask which skill)
  //   "list my skills" → command_automate
  const INSTALL_SKILL_WITH_PATH = /\b(install|add|register|load)\s+(a\s+)?(skill|external skill)\s+(at|from|in)\s*\S/i;
  const INSTALL_SKILL_INTENT   = /\b(install|add|register|load)\s+(a\s+|an\s+|my\s+)?(skill|external skill|custom skill)\b/i;
  const REMOVE_SKILL_WITH_NAME = /\b(remove|uninstall|delete|disable)\s+(skill|external skill)\s+\S/i;
  const REMOVE_SKILL_INTENT    = /\b(remove|uninstall|delete|disable)\s+(a\s+)?(skill|external skill|custom skill)\b/i;
  const MY_SKILLS_PATTERN      = /\b(list|show|what|which)\s+(my\s+)?(installed\s+)?(skills|external skills|custom skills)\b/i;
  const NEED_SKILL_INTENT      = /\b(i\s+)?(need|want|create|make|build)\s+(a\s+|an\s+|my\s+)?(skill|custom skill|external skill)\b/i;

  if (INSTALL_SKILL_WITH_PATH.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] install-skill override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'skill.install' }], requiresMemoryAccess: false }, metadata: { parser: 'install-skill-override', processingTimeMs: 0 } };
  }

  if (INSTALL_SKILL_INTENT.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] install-skill (no path yet) → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'skill.install' }], requiresMemoryAccess: false }, metadata: { parser: 'install-skill-intent', processingTimeMs: 0 } };
  }

  if (REMOVE_SKILL_WITH_NAME.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] remove-skill override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'skill.remove' }], requiresMemoryAccess: false }, metadata: { parser: 'remove-skill-override', processingTimeMs: 0 } };
  }

  if (REMOVE_SKILL_INTENT.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] remove-skill (no name yet) → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'skill.remove' }], requiresMemoryAccess: false }, metadata: { parser: 'remove-skill-intent', processingTimeMs: 0 } };
  }

  if (NEED_SKILL_INTENT.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] need-skill intent → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'skill.install' }], requiresMemoryAccess: false }, metadata: { parser: 'need-skill-intent', processingTimeMs: 0 } };
  }

  if (MY_SKILLS_PATTERN.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] my-skills override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [{ skill: 'skill.list' }], requiresMemoryAccess: false }, metadata: { parser: 'my-skills-override', processingTimeMs: 0 } };
  }

  // "Search for X on Google/Bing/..." → command_automate (browser automation), NOT web_search.
  // The phrase "on <search engine>" means the user wants the search performed IN the browser UI,
  // not via ThinkDrop's internal web.search MCP. DistilBERT scores this as web_search at 0.92
  // because it trained on "search for X" patterns without the browser-destination signal.
  // Must run BEFORE the DistilBERT early exit.
  const SEARCH_ENGINE_NAMES = /\b(google|bing|duckduckgo|yahoo|brave|ecosia|startpage|youtube|amazon|reddit|twitter|x\.com|github|stackoverflow|stack overflow|yelp|linkedin|instagram|facebook|pinterest|etsy|ebay|walmart|tripadvisor|zillow|redfin)\b/i;
  if (/\b(search|look|find|look\s+up|search\s+for)\b/i.test(classifyMessage) &&
      /\bon\s+/i.test(classifyMessage) &&
      SEARCH_ENGINE_NAMES.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Search-on-engine override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'search-on-engine-override', processingTimeMs: 0 } };
  }

  // Knowledge-question override — BEFORE phi4 and carriedIntent.
  // DistilBERT confuses "you know anything about X" / "do you know about X" with
  // memory_store because the phrasing sounds declarative. These are ALWAYS retrieval questions.
  // Also catches typos like "anythinng", "annything".
  if (/^(you (know|remember|recall)|do you (know|remember|recall|have)|have you (heard|seen|learned)|did you know|are you aware)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Knowledge-question override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'knowledge-question-override', processingTimeMs: 0 } };
  }

  // Personal-history-search override — BEFORE phi4 and carriedIntent.
  // "can you list out the times I've searched for X", "when did I search for X",
  // "times I looked up X" — these are memory queries about past activity, NOT live web searches.
  // DistilBERT over-weights 'search' and scores them as web_search.
  if (/\b(times?\s+i(?:'ve)?\s+(searched?|looked\s+up|browsed?|shopped?|been\s+looking|visited?|went\s+to|accessed?|viewed?|watched?|clicked?|used?|bought?))\b/i.test(classifyMessage) ||
      /\b(when\s+did\s+i\s+(search|look|browse|shop|visit|go|access|view|watch))\b/i.test(classifyMessage) ||
      /\b(my\s+(search|browsing|shopping|web|internet)\s+history)\b/i.test(classifyMessage) ||
      /\b(list\s+(out\s+)?(the\s+)?times?\s+i(?:'ve)?)\b/i.test(classifyMessage) ||
      /\b(give\s+me\s+(the\s+)?(times?\s+i|list\s+of\s+times?))\b/i.test(classifyMessage) ||
      /\bsearch\s+(for\s+)?my\b.{0,60}\b(notes?|records?|memories|appointments?|history|logs?|data)\b/i.test(classifyMessage) ||
      /\bpull\s+(up\s+)?my\s+(records?|notes?|memories|history|logs?)\b/i.test(classifyMessage) ||
      /\bthe\s+.{1,40}\b(i|that\s+i)\s+(saved|stored|noted|logged|added|recorded)\b/i.test(classifyMessage) ||
      /\b(think\s*drop\s+)?(fetch|pull\s+up)\s+(what\s+i\s+(been|was|have\s+been)|(my\s+)?(recent|latest|past)\s+activity)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Personal-history-search override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'personal-history-search-override', processingTimeMs: 0 } };
  }

  // System resource status queries → command_automate (phi4 misclassifies as memory_retrieve).
  // "What's my current CPU usage?", "Check RAM usage", etc.
  if (/\b(cpu|gpu|ram|memory usage|disk usage|battery|bandwidth|network speed|cpu usage|ram usage)\b/i.test(classifyMessage) &&
      /\b(what'?s|check|show|get|monitor|how\s+much|what\s+is|display)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] System resource override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'system-resource-override', processingTimeMs: 0 } };
  }

  // Personal-attribute retrieval override — must run BEFORE carriedIntent AND phi4.
  // Only fires for short terminal queries: "what's my name", "who is my wife",
  // "where is my gym", "what's my phone number".
  // Excluded: queries with action verbs after the noun ("where is my code going wrong",
  // "tell me my options for deploying") — those are general_query / command_automate.
  // Excluded: system resource queries like "what's my current CPU/RAM/disk usage".
  // Rule: "what's/who is/where is" + "my" + noun(s) + END (optionally with "?")
  const personalAttributeQuery = /^(what'?s|what is|whats|who is|who'?s|where is|where'?s)\s+my\s+[\w\s']{1,30}\??\s*$/i;
  const systemResourceQuery = /\b(cpu|gpu|ram|memory usage|disk usage|disk\s+space|free\s+storage|battery|bandwidth|network speed|cpu usage|ram usage|disk speed|read.?write speed|throughput)\b|\bc\.?\s*p\.?\s*u\b|\bg\.?\s*p\.?\s*u\b|\bwhat'?s\s+my\s+disk\b/i;
  if (personalAttributeQuery.test(classifyMessage.trim()) && !systemResourceQuery.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Personal-attribute retrieval override → memory_retrieve: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'memory_retrieve',
        confidence: 0.95,
        entities: [],
        requiresMemoryAccess: true,
      },
      metadata: { parser: 'personal-attribute-override', processingTimeMs: 0 },
    };
  }

  // System-resource query override — must run BEFORE phi4 ML call.
  // "what's my GPU temperature", "g p u temp", "disk read/write speed" → command_automate.
  // phi4 misclassifies these as memory_retrieve because they look like personal-attribute queries.
  const systemResourceActionQuery = /\b(what'?s|what is|show me|get|tell me|check|monitor)\b.{0,40}\b(cpu|gpu|ram|memory usage|disk usage|battery level|battery status|bandwidth|network speed|disk speed|read.?write speed|throughput|temperature|temp)\b/i;
  // Broader disk/storage catch: "What's my disk at?", "How much free storage do I have?"
  const diskStorageQuery = /\b(what'?s\s+my\s+disk|how\s+much\s+(free\s+)?(storage|disk\s+space|space)\s+(do\s+I\s+have|is\s+(left|remaining|available))|disk\s+(usage|at|space|level)|storage\s+(usage|at|level|left|available|remaining))\b/i;
  // Excluded: food/fermentation context — "fermentation temperature for kimchi" is gk, not ca.
  const isFoodTemperatureQuery = /\b(ferment|kimchi|sauerkraut|kombucha|kefir|miso|tempeh|yogurt|baking|brewing|cooking|oven|grill|food|recipe)\b/i.test(classifyMessage);
  if (!isFoodTemperatureQuery && (systemResourceActionQuery.test(classifyMessage) || diskStorageQuery.test(classifyMessage) || (systemResourceQuery.test(classifyMessage) && /\b(temperature|temp|speed|usage|level|status|throughput)\b/i.test(classifyMessage)))) {
    logger.debug(`[Node:ParseIntent] System-resource query override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'system-resource-override', processingTimeMs: 0 } };
  }

  // "Remember I ..." / "Remember my X is Y" declarative statements → memory_store (NOT memory_retrieve).
  // "Remember I switched to a standing desk", "Remember my sister's wedding is June 22nd"
  // These are personal fact declarations the user wants stored.
  // EXCLUDED: "remember" used as a retrieval request: "remember when I said X?", "remember that appointment"
  if (/^(hey\s+)?remember\s+(i|my|\w[\w']{1,20})\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?') &&
      !/^remember\s+i\s*(said|told|mentioned|asked|gave|showed|shared|sent)/i.test(classifyMessage.trim()) &&
      !/^remember\s+(when|that\s+time|the\s+time|the\s+day)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Remember-declaration override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'remember-i-declaration-override', processingTimeMs: 0 } };
  }

  // "Add to memory: ..." / "Bookmark X for later" / "Pin this for later" / "Put this in my memory" → memory_store.
  if (/^add\s+to\s+memory\s*:/i.test(classifyMessage.trim()) ||
      /^bookmark\s+.{1,80}\s+for\s+later\b/i.test(classifyMessage.trim()) ||
      /^pin\s+(this|it|that|the\s+\w+)\b.{0,60}\b(for\s+later|to\s+memory)\b/i.test(classifyMessage.trim()) ||
      /^put\s+(this|it|that)\s+(in|into)\s+(my\s+)?memory\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Add-to-memory/bookmark override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'add-to-memory-bookmark-override', processingTimeMs: 0 } };
  }

  // "I need to remember how/what/that I did X" → memory_store (storing a how-I-did-it note).
  if (/^i\s+need\s+to\s+remember\s+(how|what|that|the\s+(way|steps?|process))\s+i\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Need-to-remember-how override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'need-to-remember-override', processingTimeMs: 0 } };
  }

  // "note I prefer/like/want X" / "note my car insurance" / "note that my X" → memory_store.
  if (/^note\s+(that\s+)?i\b/i.test(classifyMessage.trim()) ||
      /^note\s+(that\s+)?my\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Note-I override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'note-i-override', processingTimeMs: 0 } };
  }

  // Personal lifestyle / event declarations → memory_store.
  // "I started cycling to work", "I'm learning Mandarin with X", "My marathon training kicks off April"
  // phi4 misclassifies these as memory_retrieve because they look like retrieval phrasing.
  // Also catches "I'm using X for Y" (e.g. "I'm using Anki for memorizing Rust syntax")
  // and "I'm journaling every evening now using Day One"
  if (!classifyMessage.trim().endsWith('?') && (
      /^(i\s+(started|began|commenced)\s+(cycling|running|swimming|walking|training|learning|studying|practicing|doing|taking|attending|going\s+to|seeing|working\s+with)\b)/i.test(classifyMessage.trim()) ||
      // "I'm learning Rust this quarter" / "I'm learning [X]" (no trailing condition needed)
      /^i'?m\s+(currently\s+)?(learning|studying|practicing|using|taking|doing|attending|going\s+through|working\s+through|training)\b.{0,80}\b(with\s+(the\s+)?\w|using|via|for|this\s+(quarter|week|month|year)|starting|now|today)/i.test(classifyMessage.trim()) ||
      // "I'm learning [thing]" without qualifier — at least 5 chars of topic
      /^i'?m\s+(currently\s+)?(learning|studying|practicing|using)\s+\w.{3}/i.test(classifyMessage.trim()) ||
      /^i'?m\s+(currently\s+)?reading\b/i.test(classifyMessage.trim()) ||
      /^i'?m\s+(journaling|blogging|meditating|tracking)\b/i.test(classifyMessage.trim()) ||
      /^(hey\s+)?(my|my\s+\w+)\s+(marathon|race|train(?:ing|\s+ing)|workout|class|lesson|course|therapy|session)\s+(plan\s+)?(kicks?\s+off|starts?|begins?|launches?)/i.test(classifyMessage.trim()) ||
      /^(hey\s+)?save\s+(um\s+|uh\s+|er\s+)?my\s+/i.test(classifyMessage.trim())
  )) {
    logger.debug(`[Node:ParseIntent] Personal-declaration override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'personal-declaration-override', processingTimeMs: 0 } };
  }

  // "I always order X", "I always prefer X" — habit/preference declaration → memory_store.
  if (/^i\s+always\s+\w/i.test(classifyMessage) && !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-always override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-always-override', processingTimeMs: 0 } };
  }

  // "I start the night shift rotation beginning next Wednesday" → personal schedule → memory_store.
  if (/^i\s+(start|begin|join|end|leave|finish|complete|graduate|take\s+on|take\s+over)\b.{0,80}\b(shift|rotation|role|position|job|class|course|program|project|duty|term)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-start-role override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-start-role-override', processingTimeMs: 0 } };
  }

  // "I have been [very/so] busy/tired/stressed this week" → personal state declaration → memory_store.
  // The temporal-override correctly excludes this (doesn't fire), but phi4 can still misclassify.
  if (/^i\s*('ve|have)\s+been\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?') &&
      !/\b(searching|looking|trying|working|thinking|wondering|attempting|waiting|struggling)\s+(for|to|on|at|with)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] I-have-been override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.94, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-have-been-override', processingTimeMs: 0 } };
  }

  // "when do I have an appointment/meeting?" / "when does my insurance renew?" → memory_retrieve.
  if (/\bwhen\s+(do\s+i|is\s+my|does\s+my)\b.{0,60}\b(appointment|meeting|session|call|check-?up|exam|visit|event|class|interview|reservation|consultation|insurance|subscription|lease|contract|membership|license|passport|visa)\b/i.test(classifyMessage) ||
      /\bwhen\s+does\s+my\b.{0,60}\b(renew|expire|end|start|begin|kick\s+in|take\s+effect)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] When-appointment override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'when-appointment-override', processingTimeMs: 0 } };
  }

  // Personal-fact declaration backstop — phi4 now handles these via seeds + score boost.
  // This regex only fires for unambiguous cases phi4 could still miss at startup
  // (before seeds are embedded) or in extreme edge cases.
  // Standard:  "my <role> is <value>"  — optional leading filler word stripped first.
  // Inverted:  "<Name> is my <known-role>"  — role must be a relationship/contact word.
  const PERSONAL_FACT_FILLER = /^(?:no|nope|yes|yeah|actually|well|wait|so|okay|right|anyway|hmm|um|uh|oh|ah),?\s+/i;
  const strippedMessage = classifyMessage.trim().replace(PERSONAL_FACT_FILLER, '').replace(PERSONAL_FACT_FILLER, '');
  const RELATIONSHIP_ROLES = /^(?:wife|husband|partner|mom|mother|dad|father|son|daughter|brother|sister|cousin|aunt|uncle|friend|coworker|colleague|boss|manager|doctor|dentist|vet|lawyer|therapist|trainer|coach|neighbor|roommate|mechanic|pastor|barber|stylist|tutor|mentor|landlord|landlady|accountant|realtor|agent|plumber|electrician|contractor)\b/i;
  const invertedMatch = classifyMessage.trim().match(/^[A-Z][\w\s.'-]{1,40}\s+(?:is|are|was)\s+my\s+(\w+)/);
  const isPersonalFact =
    /^my\s+[\w\s']{1,30}\s+(?:name\s+)?(?:is|are|was)\s+\S/i.test(strippedMessage) ||
    (invertedMatch && RELATIONSHIP_ROLES.test(invertedMatch[1])) ||
    /^I'm\s+[A-Z][a-z]{1,20}\s*$/.test(classifyMessage.trim());
  // Guard: never fire on question-word sentences (e.g. "When is my sister X's wedding?")
  const QUESTION_WORD_START = /^(?:when|where|who|what|which|how|is|are|was|were|did|do|does|has|have|had|can|could|would|should|will)\b/i;
  if (isPersonalFact && !QUESTION_WORD_START.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Personal-fact declaration override → memory_store: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'memory_store',
        confidence: 0.95,
        entities: [],
        requiresMemoryAccess: false,
        factDeclaration: true,
      },
      metadata: { parser: 'personal-fact-override', processingTimeMs: 0 }
    };
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

  // ── Learned intent override check (before phi4) ───────────────────────────
  // If the user has previously corrected a misclassification for a similar phrase,
  // use that stored correction directly. This prevents the same phrasing from ever
  // misclassifying again without burdening phi4.
  if (mcpAdapter) {
    try {
      const overrideResult = await mcpAdapter.callService('user-memory', 'intent_override.search', {
        prompt: classifyMessage
      });
      const match = overrideResult?.match;
      if (match?.correctIntent) {
        logger.info(`[Node:ParseIntent] Intent override match (sim=${match.similarity?.toFixed(3)}): "${classifyMessage.slice(0, 60)}" → ${match.correctIntent} (learned from: "${match.examplePrompt?.slice(0, 50)}")`);
        return {
          ...state,
          intent: {
            type: match.correctIntent,
            confidence: match.similarity,
            entities: [],
            requiresMemoryAccess: match.correctIntent === 'memory_retrieve'
          },
          metadata: { parser: 'intent-override', processingTimeMs: 0 }
        };
      }
    } catch (e) {
      logger.debug(`[Node:ParseIntent] intent_override.search skipped: ${e.message}`);
    }
  }

  // ── DistilBERT early classification ──────────────────────────────────────
  // All structural/meta guards above (app-launch, app-control, messaging verbs,
  // lift/set_constraint, skill invocations, carriedIntent, DuckDB self-corrections)
  // must always run unconditionally — they are correct by definition.
  //
  // Everything BELOW this point is a language-pattern safety net that was written
  // to compensate for the old cosine-similarity parser's mistakes. DistilBERT
  // (fine-tuned on 6,250 labelled examples) handles these patterns directly.
  //
  // Strategy: call the model here. If it is highly confident (>= MODEL_CONF_THRESHOLD)
  // return immediately and skip all the language-pattern guards below. If it is
  // uncertain the guards below run as a safety net — preserving existing behaviour.
  // Over time, as DistilBERT is retrained on edge cases collected via intent_override,
  // fewer and fewer prompts will need the safety net.
  const MODEL_CONF_THRESHOLD = 0.75;
  let earlyModelResult = null;
  if (mcpAdapter) {
    try {
      const _earlyCall = await mcpAdapter.callService('phi4', 'intent.parse', {
        message: classifyMessage,
        context: { sessionId: context?.sessionId, userId: context?.userId }
      });
      earlyModelResult = _earlyCall?.data || _earlyCall;
    } catch (e) {
      logger.debug(`[Node:ParseIntent] Early DistilBERT call skipped: ${e.message}`);
    }
  }

  if (earlyModelResult && (earlyModelResult.confidence ?? 0) >= MODEL_CONF_THRESHOLD) {
    const _eIntent = earlyModelResult.intent || 'general_query';
    const _eConf   = earlyModelResult.confidence;
    logger.debug(`[Node:ParseIntent] DistilBERT early → ${_eIntent} (${_eConf.toFixed(2)}): "${classifyMessage}"`);
    // Signal 1: record low-confidence candidates for self-repair review
    if (_eConf < 0.55) {
      mcpAdapter?.callService('user-memory', 'intent_override.upsert', {
        examplePrompt: classifyMessage, correctIntent: _eIntent, wrongIntent: null, source: 'low_confidence_candidate'
      }).catch(() => {});
    }

    // Browser-context override: DistilBERT says memory_store but there's an active browser
    // session on a video/streaming platform and the message looks like a refinement/follow-up
    // action rather than a genuine fact to store.
    // E.g. "this revealing truth channel less then 5 mins" (0.88 memory_store) when browser
    // is on YouTube — user is refining a previous browse request, not storing a memory.
    if (_eIntent === 'memory_store' && _eConf < 0.92 &&
        activeBrowserSessionId &&
        /\b(youtube|twitch|tiktok|vimeo|netflix|instagram|channel|video)\.?(com)?/i.test(activeBrowserUrl || '') &&
        /\b(channel|video|videos|list|less\s+than|under|min(ute)?s?|filter|shorts?|clips?)\b/i.test(classifyMessage) &&
        !/\b(remember|note|save|store|track|don.?t forget)\b/i.test(classifyMessage)) {
      logger.debug(`[Node:ParseIntent] Browser-context override: memory_store → command_automate (active video session, refinement pattern): "${classifyMessage}"`);
      return {
        ...state,
        intent: { type: 'command_automate', confidence: 0.85, entities: [], requiresMemoryAccess: false },
        metadata: { parser: 'browser-context-override', processingTimeMs: earlyModelResult.metadata?.processingTimeMs || 0 }
      };
    }

    return {
      ...state,
      intent: {
        type: _eIntent,
        confidence: _eConf,
        entities: earlyModelResult.entities || [],
        requiresMemoryAccess: earlyModelResult.requiresMemoryAccess || false
      },
      metadata: { parser: 'distilbert-early', processingTimeMs: earlyModelResult.metadata?.processingTimeMs || 0 }
    };
  }

  // DistilBERT was uncertain or unavailable — language-pattern safety nets follow.
  if (earlyModelResult) {
    logger.debug(`[Node:ParseIntent] DistilBERT uncertain (${earlyModelResult.confidence?.toFixed(2)}) — pattern guards active`);
  }

  // "I need you to [action]" / "I want you to [action]" / "Can you [action]" → command_automate.
  // NOTE: DistilBERT (retrained with R12) now handles these at 0.91-0.94 confidence → early exit.
  // This guard only fires for unusual action verbs that fall below the 0.75 confidence threshold.
  // Keep as a secondary safety net — not a primary classification path.
  if (/^(i\s+(need|want|would\s+like)\s+(you\s+to|for\s+you\s+to\s*)|can\s+you\s+|please\s+)(go\s+to|goto|navigate|watch|find|search|look\s+up|browse|open|play|visit|check\s+out|pull\s+up|bring\s+up|show\s+me|get\s+me|download|install|run|execute|send|email|text|create|make|draft|compose|book|reserve|schedule|click|fill|type|start|launch|switch|jump|take\s+me)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] I-need-you-to-action override (safety net) → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-need-you-to-action-override', processingTimeMs: 0 } };
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

  // "Our team/design team/company is [doing X]" → team/work event declaration → memory_store.
  // "Our design team is migrating from Figma to Penpot starting next sprint"
  if (/^(our|the)\s+(team|design\s+team|engineering\s+team|company|org|department)\s+(is|are|was|will\s+be)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Team-declaration override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'team-declaration-override', processingTimeMs: 0 } };
  }

  // "I signed up for/registered for/enrolled in/subscribed to/subscribed to X" → personal event declaration → memory_store.
  // phi4 confuses these with memory_retrieve because they share vocabulary with retrieval seeds.
  if (/^(hey\s+)?i\s+(signed\s+up|registered|enrolled|subscribed)\s+(for|in|to)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-signed-up override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-signed-up-override', processingTimeMs: 0 } };
  }

  // "my X is named/called Y" anywhere in the sentence → memory_store (naming declaration).
  // Catches sentences like "I'm making kombucha, my SCOBY is named Greta".
  if (/\bmy\s+\w[\w\s]{0,20}\s+is\s+(named|called)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] My-X-is-named override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'my-x-named-override', processingTimeMs: 0 } };
  }

  // "I got [name/pet] from [shelter/rescue/...]" → personal acquisition declaration → memory_store.
  // Catches: "I got Nala from a rescue shelter on Saturday".
  if (/^(hey\s+)?i\s+(got|picked\s+up|adopted|rescued)\s+\w[\w\s'-]{0,30}\s+from\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-got-from override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-got-from-override', processingTimeMs: 0 } };
  }

  // "[Name]'s [last/first] name is spelled/written/pronounced X" → correction declaration → memory_store.
  if (/\b\w+\s*'s?\s+(last\s+name|first\s+name|full\s+name|name|surname)\s+is\s+(spelled?|written|pronounced)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Name-spelling override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'name-spelling-override', processingTimeMs: 0 } };
  }

  // Voice-spaced "I'm train ing for X" / "I'm study ing X" → personal declaration → memory_store.
  // Voice transcription splits gerunds: "training" → "train ing", "studying" → "study ing".
  // Also catches voice-split past tense: "i start ed tak ing" = "i started taking".
  if ((!classifyMessage.trim().endsWith('?')) && (
      /^(i|im?|i'?m)\s+(train|study|learn|practice|cycl|run|climb|triathlon|workout)\s+ing\b/i.test(classifyMessage.trim()) ||
      /^i\s+start\s+ed\s+(tak|do|learn|practic|work|run|using)\s*(ing\b|ed\b)?/i.test(classifyMessage.trim())
  )) {
    logger.debug(`[Node:ParseIntent] Voice-gerund declaration override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'voice-gerund-override', processingTimeMs: 0 } };
  }

  // "I have a X every morning/day/week" → personal habit declaration → memory_store.
  // e.g. "I have a matcha latte every morning now instead of coffee"
  if (/^i\s+have\s+(a\s+|an\s+)?\w.{0,60}\b(every|each)\s+(morning|day|evening|night|week|meal)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-have-X-every override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-have-x-every-override', processingTimeMs: 0 } };
  }

  // "I have a X now instead of Y / rather than Y" (lifestyle switch) → memory_store.
  if (/^i\s+have\s+(a\s+|an\s+)?\w.{0,80}\b(instead\s+of|rather\s+than|in\s+place\s+of)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-have-X-instead override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-have-x-instead-override', processingTimeMs: 0 } };
  }

  // "New X: Y" telegraphic note → memory_store (e.g. "New dog: Nala", "New climbing shoes: Scarpa").
  // Supports multi-word descriptors before the colon: "New rescue dog: Aria", "New espresso machine: Breville".
  // EXCLUDED: "New branch: feature/..." → that's a git branch creation command → command_automate.
  if (/^new\s+(?:\w+\s+){0,3}\w+\s*:/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?') &&
      !/^new\s+branch\s*:/i.test(classifyMessage.trim()) &&
      !/^new\s+(pr|pull\s+request|tag|release|commit|repo|repository)\s*:/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] New-X-colon override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'new-x-colon-override', processingTimeMs: 0 } };
  }

  // "[App] instead of [App] now/these days" → app/tool switch declaration → memory_store.
  // Also catches voice split "in stead of X now".
  if ((/\binstead\s+of\b.{1,60}\b(now|these\s+days|recently|lately|going\s+forward|from\s+now)\b/i.test(classifyMessage.trim()) ||
      /\bin\s+stead\s+of\b.{1,60}\b(now|these\s+days|recently|lately|going\s+forward|from\s+now)\b/i.test(classifyMessage.trim())) &&
      !classifyMessage.trim().endsWith('?') &&
      !/^(which|what|why|when|is|are|how|should|can|would|who)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Instead-of-now override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'instead-of-now-override', processingTimeMs: 0 } };
  }

  // Month + move/relocation → personal plan declaration → memory_store.
  // "April move, north side", "March relocation to downtown"
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(move|relocation|apartment|place|house|flat)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Month-move override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'month-move-override', processingTimeMs: 0 } };
  }

  // Month/season + trip/event telegraphic note → memory_store.
  // "September Portugal trip, 10 days in Lisbon", "October Japan trip", "July Lisbon conference"
  if (/^(january|february|march|april|may|june|july|august|september|october|november|december|q1|q2|q3|q4|spring|summer|fall|winter)\s+([\w\s]+)?\s*(trip|travel|conference|summit|vacation|retreat|race|marathon|half\s*marathon|event)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Month-trip override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'month-trip-override', processingTimeMs: 0 } };
  }

  // Telegraphic topic note: "[Topic], [detail]" format → memory_store.
  // "Rust programming, chapter 4 this week", "Anki, 20 cards per day goal"
  // "Standing desk, 42 inches for standing"
  // Pattern: starts with a proper noun/topic word followed by comma + detail (no question mark).
  if (/^\w[\w\s.+-]{1,30},\s+[\w\s'.+-]{3,}/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?') &&
      // Must NOT look like a web search or general question
      !/^(best|top|how|what|why|when|where|who|is|are|can|should|will|does|did)\b/i.test(classifyMessage.trim()) &&
      // Must be short enough to be a note (< 80 chars)
      classifyMessage.trim().length < 80 &&
      // Must NOT be a sentence with a subject-verb (likely a ws or gk question)
      !/\b(is|are|was|were|will|does|did|can|should|would|have|has|had)\s+(you|they|it|the|a|an|there)\b/i.test(classifyMessage) &&
      // Require a personal-note keyword (chapter, goal, target, inches, session, dose, setting, version, etc.)
      // NOTE: 'day' intentionally excluded — too common ("Hello, I'm back for the day")
      /\b(chapter|goal|target|inch|inches|cm|mg|ml|session|dose|dosage|setting|version|release|mode|preset|plan|progress|level|stage|pace|score|rep|reps|set|sets|week|month|per\s+day|per\s+week|cards?\s+per|starting|done|today|this\s+(week|month|quarter)|daily|weekly|routine|streak)\b/i.test(classifyMessage) &&
      // Exclude greeting patterns
      !/^(hello|hi|hey|good\s+(morning|afternoon|evening)|yo|sup|howdy)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Telegraphic-note override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'telegraphic-note-override', processingTimeMs: 0 } };
  }

  // Finance/investment note (comma-separated telegraphic form) → memory_store.
  // "Index funds, DCA strategy", "Roth IRA, max contribution".
  // EXCLUDED: retrieval queries ("remind me about my index funds"),
  //           web_search queries ("current S&P 500 performance"), and question-word starts.
  if (/\b(index\s+fund|dca|dollar.?cost\s+averag|roth\s+ira|401k|etf\s+portf|brokerage\s+account|vanguard|fidelity\.com|\bhsa\b|keto\s+(diet|protocol|strict|plan|budget)|cold\s+plunge\s+(protocol|routine|schedule|temp)|ethereum\s*(,|\s+dca)|eth\s+dca)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?') &&
      !/^(what|how|why|when|is|are|explain|tell|show|which|should|can|would|remind|current|find|get|pull|check|look\s+up)\b/i.test(classifyMessage.trim()) &&
      !/\b(remind\s+me|current\s+\w+\s*(price|performance|rate|yield|return)|performance|year\s+to\s+date|ytd|I\s+R\s+S|irs|for\s+20\d\d\b|side\s+effects?|how\s+long|explained?|triple\s+tax|advantages?|vs\s+low|low.carb)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Finance-note override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'finance-note-override', processingTimeMs: 0 } };
  }

  // "My book club meets every Thursday evening" → recurring schedule declaration → memory_store.
  if (/^my\s+\w[\w\s']{0,30}\s+(meets?|runs?|starts?|happens?|falls?|takes\s+place|is\s+held)\s+(every|each|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\w+day)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] My-X-meets-every override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'my-x-meets-override', processingTimeMs: 0 } };
  }

  // "My [family member] [name] got married/graduated/got promoted" → personal life event → memory_store.
  // Catches "My sister Zoe got married last Saturday", voice split variants.
  if (/\bmy\s+(sister|brother|mom|dad|mother|father|friend|partner|spouse|wife|husband|colleague|teammate|co-?worker)\s+\w+\s+(got\s+married|graduated|is\s+engaged|got\s+engaged|got\s+promoted|had\s+a\s+baby|moved|passed\s+away|gave\s+birth)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Family-event override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'family-event-override', processingTimeMs: 0 } };
  }

  // "I officially joined X / signed up at X" → personal membership/enrollment → memory_store.
  if (/^(hey\s+)?i\s+(officially|recently|finally|just\s+)?(joined|enrolled\s+at|signed\s+up\s+at|became\s+a\s+member\s+of|started\s+at)\s+(the\s+)?/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?') &&
      !/\b(did|would|could|might|want|think|wonder|plan)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] I-joined override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-joined-override', processingTimeMs: 0 } };
  }

  // "I leased/bought/purchased a [vehicle/item]" → personal acquisition → memory_store.
  // Catches "I leased a Tesla Model Y last Tuesday", voice "i leas ed a tes la".
  if (/^(hey\s+)?i\s+(just\s+)?(leased|bought|purchased|hired|rented|traded\s+in|financed)\s+(a\s+)?(new\s+)?\w/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?') &&
      !/\b(did|would|could|might|think|want|wish|plan|wonder)\b/i.test(classifyMessage) &&
      !/^(did|would|could|have)\s+i\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] I-leased-bought override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-leased-bought-override', processingTimeMs: 0 } };
  }

  // "Search through what I've shared about X" → memory_retrieve (NOT phi4 memory_store).
  // phi4 misclassifies these as memory_store because they mention personal health topics.
  if (/^(search\s+through|dig\s+through|look\s+through|scan\s+through)\s+what\s+i'?ve?\s+(shared|told|said|mentioned|logged|saved|noted|recorded)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Search-through-shared override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'search-through-shared-override', processingTimeMs: 0 } };
  }

  // "[Name/Title] is my new [role]" → personal contact declaration → memory_store.
  // Catches "Dr. Reyes is my new GP", "Carlos is my new design lead".
  if (/\b\w[\w\s.'`-]{0,25}\s+is\s+my\s+(new|current)\s+(doctor|gp|dentist|therapist|physical\s+therapist|pt|trainer|barber|coach|boss|manager|pm|project\s+manager|design\s+lead|designer|vet|eye\s+doctor|dermatologist|primary\s+care|lead|tech\s+lead|engineering\s+manager|general\s+practitioner|data\s*en\s*gi\s*neer|data\s+engineer|da\s+ta\s+en\s+gi\s+neer|software\s+engineer|backend\s+engineer|frontend\s+engineer|director|cto|ceo|vp|head\s+of|intern|contractor)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Role-is-my-new override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'role-is-my-new-override', processingTimeMs: 0 } };
  }

  // "I opened/created/set up a new [vault/workspace/project]" → personal tool setup → memory_store.
  if (/^(hey\s+)?i\s+(just\s+)?(opened|created|set\s+up|made|built|started|launched|configured|initialized)\s+(a\s+)?(new\s+)?\w[\w\s-]{0,40}\s+(vault|workspace|project|board|spreadsheet|notebook|journal|directory|database)\b/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] I-opened-new-item override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'i-opened-new-item-override', processingTimeMs: 0 } };
  }

  // Medical/appointment declaration guard — runs BEFORE browser-override.
  // "I have a doctor's visit on Friday" → `visit` triggers destPrepMatch (visit + on + Friday).
  // But these are personal fact declarations the user wants stored, not browser nav.
  // Also covers "Mochi has a vet check at Dr. Osei's clinic" style 3rd-person declarations.
  // EXCLUDED: question form "Has X had Y yet?" / "Did X have Y?" — those are memory_retrieve.
  if (/\b((i|she|he|they|\w+)\s+(has?|have|had|got|have\s+a)\s+.{0,30}\b(appointment|visit|check-?up|consultation|session|procedure|surgery|exam|presentation|meeting|conference|webinar|vet\s+check))\b/i.test(classifyMessage) &&
      !/^(has|have|did|does)\s+/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] Medical appointment declaration → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'appointment-declaration-override', processingTimeMs: 0 } };
  }

  // "Store this: URL/info", "Save this: ...", "Log this: ..." → always memory_store even if
  // the message contains a URL or domain name (which would otherwise trigger browser-override).
  if (/^(store|save|log|record|note|remember)\s+(this|that|it|these|the\s+following)\s*[,:]\s*/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Explicit-store-command override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'explicit-store-command-override', processingTimeMs: 0 } };
  }


  // "Find/pull up a tutorial/guide/cheat sheet for X" → command_automate (open browser and navigate).
  // Must run BEFORE web-search-info-guard to claim tutorials before restaurants.
  // EXCLUDED: "look up [animal/creature] care guide" — informational web search about a living thing.
  if (/\b(find|pull\s+up|look\s+up|bring\s+up|fetch|get)\s+(me\s+)?(a|an|the|some)?\s*.{0,40}\b(tutorial|documentation|docs\b|guide|walkthrough|example|demo|sample|template|course|lesson|cheat\s*sheet|reference)\b/i.test(classifyMessage) &&
      !/\b(rabbit|dog|cat|hamster|bird|fish|reptile|turtle|guinea\s+pig|ferret|horse|pet|animal|plant|sourdough|recipe)\b.{0,60}\b(care|guide|tips|info|diet|health)/i.test(classifyMessage) &&
      !/\blook\s+up\s+.{0,80}\bcare\s+(guide|tips|info)/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Tutorial-find override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'tutorial-find-override', processingTimeMs: 0 } };
  }

  // Shopping/product search on e-commerce sites → web_search (NOT command_automate).
  // "amazon winter clothes deals", "walmart grocery prices" — user wants to browse/price-check.
  if (/^(amazon|walmart|ebay|target|etsy|aliexpress|best\s+buy|costco)\b.{3,100}\b(deal|sale|price|discount|coupon|promo|clearance|cheap|review|comparison|offer|code|refund)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] E-commerce search override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'ecommerce-search-override', processingTimeMs: 0 } };
  }

  // "Book a flight to/from X" / "Reserve a hotel in Y" → command_automate (booking action).
  // Must run BEFORE web-search-info-guard which catches flight/hotel searches as web_search.
  if (/^(book|reserve|cancel|reschedule|upgrade)\s+(a\s+|my\s+|the\s+)?(flight|ticket|seat|hotel|room|table|reservation|trip)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Book-reserve override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'book-reserve-override', processingTimeMs: 0 } };
  }

  // Web-search info pre-guard — must run BEFORE browser-override.
  // These patterns trigger hasDestPrep ("find ... in {city}", "look up ... in {city}")
  // but are clearly informational web searches, NOT browser navigation.
  const isWebSearchInfo =
    /\b(flights?|airfare|plane\s+tickets?)\b.{0,80}\b(from|to|between)\b/i.test(classifyMessage) ||
    /\bfind\s+(me\s+)?(a|an|the)?\s*.{0,40}\b(restaurant|hotel|motel|bar|cafe|coffee\s+shop|gym|store|shop|pharmacy|clinic|hospital|place\s+to\s+eat|sushi|pizza|ramen|burger|taco)\b/i.test(classifyMessage) && !/\bfind\s+my\s+saved\b/i.test(classifyMessage) ||
    /\b(look\s+up|search\s+for)\s+(the\s+)?(weather|news|prices?|costs?|scores?|flights?|exchange\s+rate|current|latest)\b/i.test(classifyMessage) ||
    /\b(what('s| is)\s+(the\s+)?(weather|whether|forecast|temperature))\b/i.test(classifyMessage) ||
    /\b(find|search|look\s+up)\s+(the\s+)?(latest|newest|current|recent)\s+(\w+\s+)?(research|news|updates?|information|info|headlines?)\b/i.test(classifyMessage) ||
    /\bwhat\s+time\s+does\s+[\w\s]+?\s+(open|close|start|end|begin)\b/i.test(classifyMessage) ||
    /\bwhat\s+(events?|concerts?|shows?|activities|things)\s+(are|is)\s+(happening|going\s+on|scheduled?)\s+(in|at|around)\b/i.test(classifyMessage) ||
    /\bwhat\s+(is|are)\s+the\s+(total\s+)?(area|size|population|currency|official\s+language|GDP)\s+of\s+(the\s+)?\w/i.test(classifyMessage) ||
    /\b(hey\s+)?search\s+(for\s+)?(.{0,40}\b)?(bars?|club|clubs|venue|venues|spots?|places?|restaurant|cafe)\s+(in|near|around)\s+\w/i.test(classifyMessage) ||
    /\bhow\s+many\s+(people|humans?|residents?|inhabitants?|citizens?|folks)\s+(live|lives|are)\s+(in|there\s+in|across)\b/i.test(classifyMessage) ||
    /^(best|top)\s+.{0,80}\b(bar|bars?|club|clubs?|speakeasy|speakeasies|pub|pubs?|cocktail\s+bars?|lounge|lounges?|venue|venues?|cafe|restaurant|ramen|sushi|pizza|brunch|nightlife|spot|spots?|place|places?)\b.{0,30}\b(in|near|around)\s+\w/i.test(classifyMessage) ||
    /\b(pollen\s+count|pollen\s+levels?|air\s+quality|uv\s+index|wind\s+speed|precipitation|visibility)\b.{0,50}\b(in|at|for|near)\s+\w/i.test(classifyMessage) ||
    /\b(hey\s+)?search\s+.{0,80}\b(in|near|around)\s+\w{3,}/i.test(classifyMessage) && !/\b(my|saved|stored|notes?|memory|records?)\b/i.test(classifyMessage) && !/\b(repository|repo|codebase|source\s+code|current\s+(repo|project|directory|folder)|TODO|FIXME|HACK|\bfiles?\b)\b/i.test(classifyMessage) ||
    /\b(look\s+up|find)\s+.{0,50}\b(bars?|pub|pubs?|clubs?|cocktail|speakeasy|speakeasies|venue|venues?|restaurant|cafe|sushi|ramen|pizza|dining|nightlife|spots?|places?)\b.{0,30}\b(in|near|around)\s+\w/i.test(classifyMessage) ||
    // "Find me gluten-free pasta alternatives" / "find me dairy-free X" — product/food search
    /\bfind\s+(me\s+)?.{0,60}\b(alternative|alternatives|option|options|substitute|substitutes|replacement|replacements?)\b/i.test(classifyMessage) && !/\b(my|saved|stored|notes?)\b/i.test(classifyMessage) ||
    // "look up best bakeries in SF" / "find top coworking spaces in Austin" → web_search not browser nav
    /\b(look\s+up|find|search\s+for)\s+(the\s+)?(best|top|good|great|nearest|local|nearby|popular|cheap|affordable)\b.{0,80}\b(in|near|around)\s+\w{3,}/i.test(classifyMessage) ||
    // Noun-phrase "Best X in City" — starts with best/top then X in city (no personal/memory context)
    // e.g. "Best sourdough bakeries in San Francisco", "Top coworking spaces in Austin"
    /^(best|top|good|great|cheap|affordable|popular|nearby|local)\s+[\w\s]{2,60}\b(in|near|around)\s+[A-Z][a-z]{2,}/i.test(classifyMessage) && !/\b(my|I've|I have|saved|stored|notes?|memory|records?)\b/i.test(classifyMessage) ||
    // "X open late/early in City" — noun phrase business-hours query
    // e.g. "Coworking spaces open late in Austin Texas"
    /^[\w][\w\s]{2,50}\b(open\s+(late|early|now|today|24\s*hours?))\s+(in|near|around)\s+[A-Z][a-z]{2,}/i.test(classifyMessage);
  if (isWebSearchInfo) {
    logger.debug(`[Node:ParseIntent] Web-search info pre-guard → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'web-search-info-guard', processingTimeMs: 0 } };
  }

  // Direct "search for" imperative → web_search (unless searching personal records).
  // "Search for gluten-free recipes" → web_search.
  // "Search for my dentist notes" → already caught by personal-history-search above.
  // EXCLUDED: "Search for all TODO comments in the current repository" — that's command_automate (code search).
  if (/^search\s+(for|the\s+web\s+for|google\s+for|online\s+for)\b/i.test(classifyMessage) &&
      !/\b(my|your|our|saved|stored|notes?|records?|memories|appointments?|history|logs?)\b/i.test(classifyMessage.slice(0, 60)) &&
      !/\b(repository|repo|codebase|source\s+code|current\s+(repo|project|directory|folder)|TODO|FIXME|HACK|files?|commits?|branches?)\b/i.test(classifyMessage) &&
      // "Search for X *on Google/Bing/etc.*" means open actual browser — not API web search
      !/\bon\s+(google|bing|duckduckgo|yahoo|brave|ecosia|startpage)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Direct search override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'direct-search-override', processingTimeMs: 0 } };
  }

  // Browser automation override — must run BEFORE phi4 ML call.
  // Detects by STRUCTURE, not by site name — works for any website or app, including new ones.
  //
  // Common English words that are NOT app/site destinations — used to avoid false positives
  // when "on/in/using" appears in normal sentences ("search for files on my computer").
  const NOT_A_SITE = /^(my|the|a|an|this|that|your|our|their|its|his|her|here|there|it|me|us|them|him|her|computer|mac|laptop|desktop|phone|device|system|machine|server|disk|drive|folder|file|screen|page|app|browser|internet|web|online|local|remote|cloud|network|home|work|office|school|store|shop|market|place|site|world|earth|time|day|week|month|year|morning|night|now|today|yesterday|tomorrow|on|in|at|for|of|to|with|by|from|into|through|about|right|left|up|down|just|still|already|back|out|off|yet|soon|again|all|any|each|every|both|few|many|much|most|other|some|such|no|not|something|anything|everything|nothing|new|old|good|best|top|late|early|quickly|later|next|first|last|nearby|close|fast|slow|hard|easy|big|small|long|short|high|low|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
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
  // 'type' removed from verbs — 'type I/II error in statistics' would false-trigger as browser nav
  // 'through' removed — 'search through what you know about my X' is memory_retrieve, not browser nav
  const destPrepMatch = classifyMessage.match(/\b(search|look up|ask|query|find|post|send|submit|check|browse|visit|go)\b.{0,50}\b(on|in|using|at|via|into)\s+(\S+)/i);
  const destPrepWord = destPrepMatch ? destPrepMatch[3].replace(/[.,!?]+$/, '') : null;
  // Also exclude 'work' as a destination when it follows 'at' — 'at work' is a location phrase
  const hasDestPrep = destPrepWord && isDestinationWord(destPrepWord) && !/^work$/i.test(destPrepWord);

  // Signal 4: "[verb] [site] for/about X" — verb directly before destination, then purpose
  //   "ask chatgpt for", "search gemini about", "check perplexity if"
  const verbSiteForMatch = classifyMessage.match(/\b(ask|search|check|query|browse|visit)\s+(\S+)\s+(for|about|if|whether|how|what|when|where|who)\b/i);
  const verbSiteDest = verbSiteForMatch ? verbSiteForMatch[2].replace(/[.,!?]+$/, '') : null;
  const hasVerbSiteFor = verbSiteDest && isDestinationWord(verbSiteDest);

  // Location-based time query — "what time is it in London" → web_search (not local system time).
  // Must run BEFORE system-info-override which has a \bwhat time is it\b pattern.
  if (/\bwhat time is it\b.{0,20}\b(in|at|for)\s+\w/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Location time query → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'location-time-override', processingTimeMs: 0 } };
  }

  // System-info override — "what's today's date", "what time is it", "what's my battery", etc.
  // These are trivially answerable by shell.run — must go to command_automate, not general_query.
  const sysInfoPattern = /\b(what('s| is)( the)?|tell me( the)?|show me( the)?|get( the)?)\s+(today'?s?|current|the)\s+(date|time|day|battery|wifi|disk|ip address|timezone|hostname|username)\b|\b(what('s| is)( today'?s?| the current| the)?)\s+(date|time|day)\b|\btoday'?s?\s+date\b|\bwhat day is (today|it)\b|\bwhat time is it\b|\btell me (what time|the time|the date|the day|today'?s date)\b|\b(do you know|can you tell me) what time\b|\bwhat'?s the time\b/i;
  if (sysInfoPattern.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] System-info override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'system-info-override', processingTimeMs: 0 } };
  }

  // IDE/bridge setup override — catches "I want my IDE to communicate with ThinkDrop",
  // "connect Cursor to ThinkDrop", "how do I link Warp to you", etc.
  // Must run BEFORE the how-to guard so these don't get swallowed by general_query.
  const ideSetupPattern = /\b(connect|setup|set up|link|integrate|configure|use|get|add|communicate|talk|work with)\b.{0,60}\b(ide|windsurf|cursor|warp|zed|vscode|vs code|copilot|editor|bridge|thinkdrop bridge)\b|\b(ide|windsurf|cursor|warp|zed|editor)\b.{0,60}\b(communicate|talk|connect|work with|integration|setup|set up|linked?|bridge)\b|\b(my|my\s+\w+)\s+(ide|editor|windsurf|cursor|warp)\b.{0,60}\b(communicate|talk|connect|to you|with you|thinkdrop)\b/i;
  // Exclude memory_retrieve phrasing: "What keybinding am I using in VS Code?" is retrieval, not setup command
  const ideSetupIsRetrieval = /\b(am\s+i\s+using|do\s+i\s+use|which\s+(ide|editor|keybinding|setup|config)|am\s+i\s+(on|connected|linked|using))\b/i.test(classifyMessage);
  if (ideSetupPattern.test(classifyMessage) && !ideSetupIsRetrieval) {
    logger.debug(`[Node:ParseIntent] IDE-setup override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'ide-setup-override', processingTimeMs: 0 } };
  }

  // Memory-retrieve override: "What [keybinding/theme/plugin/setup/config] am I using in [app]?"
  // phi4 misclassifies these as screen_intelligence because they mention VS Code / editor
  if (/\b(what|which)\s+(keybinding|theme|plugin|extension|setup|config|font|setting|shortcut|scheme)\s+(am\s+i\s+using|do\s+i\s+use|is\s+active|is\s+set|am\s+i\s+on)\b/i.test(classifyMessage) ||
      /\b(what|which)\s+\w[\w\s]{0,30}\s+(am\s+i\s+using|do\s+i\s+use)\s+(in|for|with|on)\s+(vs\s+code|vscode|cursor|windsurf|warp|zed|my\s+ide|my\s+editor)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] IDE-config retrieval override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'ide-config-retrieval-override', processingTimeMs: 0 } };
  }

  // "How-to" guard — must run BEFORE memory-query guard and browser override.
  // "How do I X", "how can I X", "how to X" are general_query (answer node decides
  // whether to answer or offer a guide). They are NOT browser automation or memory_retrieve.
  // EXCEPTION: IDE/bridge setup questions already handled above.
  const ideSetupException = ideSetupPattern;
  // Use \b after 'do' so 'how does' doesn't prefix-match as 'how do' (does starts with do)
  const howToPattern = /^(how\s+(do\b|can|would|should|do\s+you|can\s+you|would\s+you|to\s)|what('s| is) the (best |easiest |fastest )?way to|what steps|what are the steps)/i;
  // Exclude: "how would you describe me based on..." — that's memory_retrieve, not how-to
  const howToNotMemoryRetrieve = /\b(describe|characterize|summarize|tell)\s+(me|myself|who i am|what i('m| am) like|myself based)/i;

  // "Explain how CQRS works" / "What is the ketogenic diet?" / "How does cold water affect the nervous system?"
  // → general_knowledge (conceptual educational questions, not time-sensitive lookups).
  // phi4 with high confidence routes these to web_search.
  if (/^(explain(\s+(how|the|what|why|the\s+difference\s+between))?)\s+\w/i.test(classifyMessage.trim()) ||
      /^what\s+is\s+(the\s+|a\s+|an\s+)?\w[\w\s()-]{2,60}\s+(method|technique|concept|principle|architecture|pattern|diet|syndrome|advantage|rule|protocol|model|system|approach|formula|law|theorem)\b/i.test(classifyMessage.trim()) ||
      /^what\s+is\s+(a|an|the)\s+\w[\w\s()-]{2,60}\s+and\s+how\s+does\s+it\s+work\b/i.test(classifyMessage.trim()) ||
      /^how\s+does\s+\w[\w\s()-]{2,60}\s+(work|function|affect|compare|differ)\b/i.test(classifyMessage.trim()) ||
      /^what\s+is\s+the\s+(difference\s+between|relationship\s+between|distinction\s+between)\b/i.test(classifyMessage.trim()) ||
      /^what'?s\s+the\s+(difference\s+between|comparison\s+between)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Explain-concept override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.92, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'explain-concept-gk-override', processingTimeMs: 0 } };
  }

  // "Is Obsidian better than Notion for X?" / "Is X faster than Y in Z?" → general_knowledge.
  if (/^(is|are)\s+\w[\w\s-]{0,30}\s+(better|worse|faster|safer|easier|more\s+(powerful|suitable|popular|efficient))\s+than\s+\w[\w\s-]{0,30}\s+(for|in|when|at)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Is-X-better-than-Y override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.92, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'is-x-better-than-y-gk-override', processingTimeMs: 0 } };
  }

  // "What [programming/tech] language/framework/library is best/recommended for X?" → general_knowledge.
  // Extends beyond 'language' to cover framework, library, database, tool, tech, stack.
  if (/^(what|which)\s+(programming\s+)?(language|lang\s+uage|framework|library|tech(nology)?|database|tool|stack)\b.{0,100}\b(best|recommended|popular|good|dominant|used|suited)\b.{0,80}\b(for|in)\b/i.test(classifyMessage.trim()) ||
      /^best\s+\w[\w\s-]{0,40}\s+(language|lang\s+uage|framework|library|tech(nology)?|database|tool)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Best-language-for override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.92, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'best-language-gk-override', processingTimeMs: 0 } };
  }

  // Voice-spaced git commit → command_automate.
  // "com mit all staged changes" → phi4 routes to app_control_start.
  if (/^(com\s+mit|git\s+com\s*mit|commit)\b.{0,80}\b(staged|changes|commit|mes\s*sage|branch|push|pull|rebase)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Voice-git-commit override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'voice-git-commit-override', processingTimeMs: 0 } };
  }

  // Voice-spaced git push / branch creation → command_automate.
  // "push my loc al com mits to or i gin main" / "cre ate a new branch called..."
  if (/^push\b.{0,80}\b(commits?|com\s+mits?)\b/i.test(classifyMessage.trim()) ||
      /^push\b.{0,80}\b(to\s+origin|to\s+main|to\s+remote|to\s+or\s+i\s+gin)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Voice-git-push override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'voice-git-push-override', processingTimeMs: 0 } };
  }
  if (/^(create|cre\s+ate)\s+(a\s+)?(new\s+)?branch\b/i.test(classifyMessage.trim()) ||
      /^new\s+branch\s*[:/]\s*[\w/.\-]+/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Git-branch-create override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'git-branch-create-override', processingTimeMs: 0 } };
  }

  // "Send an email to [person] to/about X" → command_automate.
  // Messaging-verb-override only covers "send this/that to me" patterns.
  if (/^(send|email)\s+(an?\s+)?email\s+(to|about)\s+\w/i.test(classifyMessage.trim()) ||
      /^send\s+\w[\w\s.'-]{1,30}\s+(an?\s+)?(email|message|text|dm)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Send-email-to-person override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'send-email-override', processingTimeMs: 0 } };
  }

  // "Set a daily/weekly reminder at X to Y" → command_automate.
  // "Schedule a calendar event for X at Y" → command_automate.
  // phi4 confuses voice versions like "sched ule a cal en dar e vent" with general_knowledge.
  if (/^set\s+(a\s+)?(daily|weekly|hourly|reminder|re\s+mind\s+er|\w+\s*reminder)\b/i.test(classifyMessage.trim()) ||
      /\b(reminder|re\s+mind\s+er)\s+(at|for|every|each|on)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Set-reminder override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'set-reminder-override', processingTimeMs: 0 } };
  }
  if (/^(schedule|sched\s+ule)\s+(a\s+)?(new\s+)?(calendar\s+|cal\s+en\s+dar\s+)?(event|e\s+vent|appointment|meeting)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Schedule-event override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'schedule-event-override', processingTimeMs: 0 } };
  }

  // "How do you spell X's last/first/full name?" → memory_retrieve (stored contact's name).
  // Must run BEFORE how-to-guard which would swallow all "how do you..." patterns as gk.
  if (/\bhow\s+do\s+you\s+spell\b.{0,50}'s\s+(last|first|full|sur|given|family|middle)\s+name\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Spell-persons-name override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'spell-persons-name-override', processingTimeMs: 0 } };
  }

  if (howToPattern.test(classifyMessage.trim()) && !ideSetupException.test(classifyMessage) && !howToNotMemoryRetrieve.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] How-to guard → general_knowledge: "${classifyMessage}"`);
    return {
      ...state,
      intent: {
        type: 'general_knowledge',
        confidence: 0.90,
        entities: [],
        requiresMemoryAccess: false
      },
      metadata: { parser: 'how-to-guard', processingTimeMs: 0 }
    };
  }

  // "How does X [verb]..." → general_knowledge (not personal).
  // howToPattern misses "how does" (only covers "how do/can/would/to").
  // Exclude "How does my X" — that's mr (personal item query).
  // Exclude "How does [Person] prefer/like/X" — that's mr (contact preference query).
  if (/^how\s+does\s+(?!my\b|the\s+app\b|it\b|that\b|this\b)/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().endsWith('!') &&
      // Don't catch person-preference mr queries: "How does Lena prefer to receive updates?"
      !/^how\s+does\s+[A-Z][a-z]+\s+(prefer|like|want|need|tend|feel|think|handle|manage|usually|typically|normally)\b/i.test(classifyMessage.trim()) &&
      !/\b(prefer|usually\s+prefer|tend\s+to\s+(prefer|like|want))\.{0,30}\bthey\b/i.test(classifyMessage) &&
      !/\b(remind|store|save|remember|note|log|track)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] How-does-X guard → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'how-does-gk-override', processingTimeMs: 0 } };
  }

  // "How X works" / "How X fermentation works" → general_knowledge.
  // "How sourdough fermentation works" starts with "How [noun]" not "How [verb]".
  if (/^how\s+\w.{2,80}\bworks?\s*\??\s*$/i.test(classifyMessage.trim()) &&
      !/^how\s+(do|does|can|would|should|to)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] How-X-works guard → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'how-x-works-gk-override', processingTimeMs: 0 } };
  }

  // "X explained" / "X borrow checker explained" → general_knowledge.
  // EXCLUDED: programming language concept lookups starting with lang name (web search queries).
  if (/\w.{3,60}\s+explained\s*\??\s*$/i.test(classifyMessage.trim()) &&
      !classifyMessage.trim().startsWith('I') && !classifyMessage.trim().startsWith('My') &&
      !/^(what|how|when|where|why|who|can|did|does|is|are)\b/i.test(classifyMessage.trim()) &&
      !/^(Rust|Python|Go|TypeScript|JavaScript|Node\.?js|Swift|Kotlin|React|Vue|Angular|CSS|HTML|SQL|Git|Docker|Kubernetes)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] X-explained guard → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'x-explained-gk-override', processingTimeMs: 0 } };
  }

  // "[ProgrammingLang] [concept] AND [concept] explained" → web_search (multi-concept study guide).
  // e.g. "Rust ownership and borrowing explained"
  // EXCLUDED: single-concept explanations like "TypeScript generics explained" → those stay gk.
  if (/^(Rust|Python|Go|TypeScript|JavaScript|Node\.?js|Swift|Kotlin|React|CSS|HTML|SQL|Git|Docker)\s+\w[\w\s]{2,50}\s+and\s+\w[\w\s]{1,30}\s+explained\s*\??\s*$/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Tech-concept-study-lookup override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.91, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'tech-concept-search-override', processingTimeMs: 0 } };
  }

  // "What are the [benefits/principles/effects/advantages/drawbacks] of/for X" → general_knowledge.
  // phi4 routes these to web_search, but they are factual knowledge queries.
  // EXCLUDED: location/current-time queries ("What are the top spots near me right now?" = web_search).
  if ((/^what\s+are\s+the\s+(key\s+)?(ergonomic|health|main|core|basic|fundamental|common|known|general|primary|major)\b/i.test(classifyMessage.trim()) ||
      /^what\s+are\s+the\s+(key\s+)?(benefits?|principles?|effects?|advantages?|drawbacks?|pros?|cons?|risks?|symptoms?|signs?|causes?|types?|characteristics?|differences?|requirements?\s+for)\b/i.test(classifyMessage.trim())) &&
      // Exclude location/current-time queries
      !/\b(right\s+now|near\s+(me|here|us|my\s+area)|in\s+(my\s+(area|city|town|neighborhood)|the\s+area)|currently|today|this\s+week|this\s+month|at\s+[A-Z][a-z]+)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] What-are-the-benefits guard → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'what-are-benefits-gk-override', processingTimeMs: 0 } };
  }

  // "What is the recommended/standard/optimal/best X for Y" (non-personal) → general_knowledge.
  // e.g. "What is the recommended daily carb limit for ketosis?"
  if (/^what\s+is\s+the\s+(recommended|standard|optimal|ideal|best|typical|normal|maximum|minimum|average|general)\b/i.test(classifyMessage.trim()) &&
      !/\bmy\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] What-is-recommended guard → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'what-is-recommended-gk-override', processingTimeMs: 0 } };
  }

  // "What technology/skill/tool/stack should I learn/use/consider for X?" → general_knowledge (career/learning advice).
  if (/^what\s+(technology|tech|stack|skill|skills|tool|tools|language|framework|library|database)\b.{0,60}\bshould\s+I\s+(learn|use|study|consider|pick|choose|adopt|go\s+with)\b/i.test(classifyMessage.trim()) ||
      /^what\s+(technology|tech|stack|skill|skills|tool|tools|language|framework|library|database)\b.{0,60}\b(to\s+learn|is\s+best\s+for)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Tech-should-I-learn guard → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'tech-learn-gk-override', processingTimeMs: 0 } };
  }

  // "[X] technique/tips/guide for beginners" → web_search.
  // e.g. "Kettlebell swing technique for beginners"
  if (/\b(technique|tips|guide|tutorial|workout|routine|exercise|drill|method)s?\b.{0,50}\bfor\s+(beginners?|newbies?|novices?|starters?|first[- ]timers?)\b/i.test(classifyMessage) &&
      !/\b(my|i\s+(use|do|follow|found|like)|i've|you\s+saved)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Technique-for-beginners override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.92, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'technique-for-beginners-override', processingTimeMs: 0 } };
  }

  // "[place] day trip itinerary" / "itinerary for [place]" → web_search (travel lookup).
  if (/\bitinerary\b/i.test(classifyMessage) &&
      !/\b(my|our|saved|from\s+memory|you\s+saved|i\s+told|i\s+mentioned|what\s+i)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Itinerary web-search override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'itinerary-web-override', processingTimeMs: 0 } };
  }

  // "look up" + non-personal topic → web_search.
  // Distinguish from "look up what I told you" → mr (already handled by look-up-what-I-told-override).
  if (/^look\s+up\b/i.test(classifyMessage.trim()) &&
      !/\b(what\s+i|what\s+you|my\s+|your\s+(records?|notes?|memory)|i\s+(told|mentioned|said|saved))\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Look-up web search override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'look-up-web-override', processingTimeMs: 0 } };
  }

  // "Describe the layout/structure/interface of [current X]" → screen_intelligence.
  // MUST run BEFORE versus-comparison-override since "VS Code" contains "VS".
  // phi4 routes "Describe the layout of the current VS Code window" to web_search.
  if (/^(describe|explain|show|tell\s+me\s+about)\s+(the\s+)?(layout|structure|interface|contents?|view|appearance|state|design)\s+(of\s+)?(the\s+)?(current|active|open|visible)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Describe-screen-layout override → screen_intelligence: "${classifyMessage}"`);
    return { ...state, intent: { type: 'screen_intelligence', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'describe-screen-override', processingTimeMs: 0 } };
  }

  // Programming language vs comparison with "which is better" framing → general_knowledge.
  // e.g. "Rust vs Go — which is better for systems programming?"
  // EXCLUDED: simple comparisons or year-tagged searches → still web_search.
  if (/\b(ver\s*sus|versus|vs\.?)\b/i.test(classifyMessage) &&
      /^(Rust|Python|Go\b|TypeScript|JavaScript|Node\.?js|Swift|Kotlin|PHP|Ruby|Scala|Haskell|Dart|Elixir|C\+\+|C#|Java\b)\b/i.test(classifyMessage.trim()) &&
      /\bwhich\s+(is|one\s+is|would\s+you|do\s+you)\s+(better|recommend|choose|pick|prefer|suggest|use)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('!')) {
    logger.debug(`[Node:ParseIntent] Tech-language-vs override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'tech-language-vs-override', processingTimeMs: 0 } };
  }

  // Craft/material production comparison → general_knowledge.
  // e.g. "Zellige vs encaustic tile production methods"
  if (/\b(ver\s*sus|versus|vs\.?)\b/i.test(classifyMessage) &&
      /\b(tile|zellige|encaustic|terracotta|ceramic|porcelain|marble|stone|vinyl|laminate|concrete|granite|slate|plaster|limewash)\b/i.test(classifyMessage) &&
      /\b(production|manufacturing|making|method|technique|craft|process)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('!')) {
    logger.debug(`[Node:ParseIntent] Craft-material-vs override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'craft-material-vs-override', processingTimeMs: 0 } };
  }

  // Coffee/beverage brewing comparison → general_knowledge.
  // e.g. "Cold brew vs hot coffee fermentation differences"
  // EXCLUDED: caffeine/nutritional content comparisons → those are web_search facts.
  if (/\b(ver\s*sus|versus|vs\.?)\b/i.test(classifyMessage) &&
      /\b(cold\s+brew|drip\s+coffee|espresso|french\s+press|pour\s+over|filter\s+coffee|hot\s+coffee|aeropress|moka\s+pot)\b/i.test(classifyMessage) &&
      !/\b(caffeine|calorie|sugar|protein|fat|nutrition|content|mg|milligrams?|amount|grams?)\b/i.test(classifyMessage) &&
      !classifyMessage.trim().endsWith('!')) {
    logger.debug(`[Node:ParseIntent] Coffee-brewing-vs override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'coffee-brewing-vs-override', processingTimeMs: 0 } };
  }

  // "X ver sus Y" / "X versus Y" / "X vs Y" (comparison) → web_search.
  // "pen pot ver sus fig ma" = "Penpot versus Figma" → ws.
  // "Penpot vs Figma?" → ws.
  // EXCLUDED: "VS Code" / "VS Studio" / "Visual Studio" (product names where VS ≠ versus).
  // EXCLUDED: "X vs Y for [focus/health/energy]" → those are general_knowledge (substance comparisons).
  // EXCLUDED: fermentation/food science comparisons → general_knowledge.
  if (/\b(ver\s*sus|versus)\b/i.test(classifyMessage) ||
      (/\bvs\.?\b/i.test(classifyMessage) &&
       !/\bVS\s+(Code|Studio|Community|Enterprise|Professional)\b/i.test(classifyMessage) &&
       !/\bVisual\s+Studio\b/i.test(classifyMessage) &&
       !/\b\w+\s+vs\b.{0,60}\bfor\s+(focus|health|energy|adhd|concentration|sleep|performance|productivity|mood|alertness)\s*\??\s*$/i.test(classifyMessage) &&
       !/\b(ferment|fermentation|fermented|kimchi|sauerkraut|kombucha|kefir|miso|tempeh|bacteria|microbiome|probiotic|lactob|aerobic|anaerobic|metabolism|enzyme)\b/i.test(classifyMessage))) {
    if (!classifyMessage.trim().endsWith('!')) {
      logger.debug(`[Node:ParseIntent] Versus-comparison override → web_search: "${classifyMessage}"`);
      return { ...state, intent: { type: 'web_search', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'versus-comparison-override', processingTimeMs: 0 } };
    }
  }

  // "What [item] am I on?" / "What chapter am I on?" / "What Rust chapter am I on?" → memory_retrieve.
  // phi4 routes to command_automate because "on" triggers navVerb matching.
  // Allow one optional adjective/noun between "what" and the chapter/level keyword.
  if (/\bwhat\s+(\w+\s+)?(chapter|page|section|module|unit|level|lesson|episode|part|step|stage|item|task|problem|exercise|topic|book)\b.{0,40}\bam\s+i\s+on\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] What-X-am-I-on override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'what-am-i-on-override', processingTimeMs: 0 } };
  }

  // "Can you find what I told/said/mentioned/gave you about X?" → memory_retrieve.
  // phi4 routes to command_automate because "find" is a browser action word.
  if (/^(can\s+you\s+)?(find|look\s+up|search\s+for|dig\s+up|pull\s+up)\s+what\s+i\s+(told|said|mentioned|gave|shared|asked|noted|logged|recorded|saved)\s+(you\s+)?(about|on|regarding)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Find-what-I-told override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'find-what-i-told-override', processingTimeMs: 0 } };
  }

  // "Pull up [App] so I can X" / "Open [App] so I can X" → command_automate (shell.run open -a).
  // phi4 routes these to command_automate because "so I can X" looks like an automation task.
  // EXCEPTION: "so I can check/view/browse the/my [specific thing]" = complex multi-step navigation → command_automate.
  const pullUpSoICan = classifyMessage.trim().match(/^(pull\s+up|bring\s+up|open|get)\s+(\w[\w\s.'-]{1,25}?)\s+so\s+(I|we)\s+can\b/i);
  if (pullUpSoICan) {
    const appDest = pullUpSoICan[2].trim();
    if (!/\.(com|org|io|ai|app|net)\b/i.test(appDest) &&
        !/^(my|the|a|an|all|every)\b/i.test(appDest)) {
      // Opening an app → command_automate (shell.run open -a AppName).
      logger.debug(`[Node:ParseIntent] Pull-up-so-I-can override → command_automate (shell.run): "${classifyMessage}"`);
      return { ...state, intent: { type: 'command_automate', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'pull-up-so-ican-override', processingTimeMs: 0 } };
    }
  }


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

  // GitHub / code-hosting API query override — must run BEFORE browser automation check.
  // Questions like "is there a PR created in the last 2 hours", "list open issues on github",
  // "show me recent commits" are command_automate (shell.run GitHub API), NOT web_search.
  // EXCLUDED: personal log/memory queries like "show me my recent logs and what I saved".
  // EXCLUDED: "alternatives to X" queries — those are web searches, not git API calls.
  // Pattern: GitHub/git entity + temporal or list phrasing.
  const githubApiPattern = /\b(pull request|pr|issue|commit|branch|release|tag|merge|fork|repo|repository|workflow|action|check|run|deployment)\b.{0,80}\b(created|opened|merged|closed|pushed|within|in the (last|past)|recent|today|yesterday|this week|last \d+|list|show|any|all|find)\b|\b(list|show|find|any|are there|is there|was there|were there)\b.{0,60}\b(pull request|pr|issue|commit|branch|release|tag|open|closed|merged|recent)\b/i;
  if (githubApiPattern.test(classifyMessage) &&
      !/\b(what\s+i|i'?ve)\s+(saved|stored|noted|logged|added|recorded)\b/i.test(classifyMessage) &&
      !/\bmy\s+(recent\s+)?(logs?|entries|notes?|records?)\b/i.test(classifyMessage) &&
      // If the sentence is primarily about "alternatives", it's a web search
      !/\b(open\s+source|free|paid|cheap)\s+(alternative|alternatives|replacement|substitut)\b/i.test(classifyMessage) &&
      !/\b(alternative|alternatives|replacement|substitutes?)\s+(to|for)\s+/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] GitHub API query override → command_automate: "${classifyMessage}"`);
    return {
      ...state,
      intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false },
      metadata: { parser: 'github-api-override', processingTimeMs: 0 }
    };
  }

  // "look up" + "what I told/said/saved/mentioned" → memory_retrieve (NOT screen/web).
  if (/\blook\s+up\s+what\s+i\s+(told|said|mentioned|saved|noted|logged|shared|gave|asked|recorded)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Look-up-what-I-told override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'look-up-what-i-told-override', processingTimeMs: 0 } };
  }

  // "Search through what you know about my X" → memory_retrieve (NOT browser-override).
  // "Look back through your memory for X" → memory_retrieve.
  // Also catches "Dig through your records to find X".
  // Voice-split: "re cords" = "records", "mem or y" = "memory".
  if (/\b(search|look|dig)\s+(through|back\s+through|over)\s+(what\s+you\s+know|your\s+(memory|mem\s+or\s+y|re\s*cords?|records?|notes?|data)|my\s+(records?|notes?|memory|history|data))\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Search-through-memory override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'search-through-memory-override', processingTimeMs: 0 } };
  }

  // "Who do I ask/go to/contact for X?" → memory_retrieve (querying stored contact info).
  if (/^who\s+(do|should|can|would)\s+i\s+(ask|contact|go\s+to|talk\s+to|reach\s+out\s+to|email)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Who-do-I-ask override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'who-do-i-ask-override', processingTimeMs: 0 } };
  }

  // Calendar / schedule retrieval — "what's on my calendar", "what's coming up", "agenda" queries.
  // phi4 misclassifies these as general_knowledge / command_automate / screen_intelligence.
  if (/\b(what'?s\s+(coming\s+up|on\s+my\s+(calendar|agenda|plate|schedule|todo))|anything\s+(coming\s+up|scheduled?|on\s+my\s+calendar|upcoming)|what'?s\s+on\s+my\s+plate)\b/i.test(classifyMessage) ||
      /\bdo\s+i\s+have\s+anything\s+(scheduled?|coming\s+up|planned?|on\s+my\s+calendar)\b/i.test(classifyMessage) ||
      /\bwhat\s+(hotel|restaurant|place)\s+am\s+i\s+(staying|eating|going|booked)\s+(at|in|to)\b/i.test(classifyMessage) ||
      /\bwhat\s+hotel\s+am\s+i\s+booked\s+(at|in)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Calendar/schedule retrieval override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'calendar-retrieval-override', processingTimeMs: 0 } };
  }

  // "a summary of me" / "on my plate for [day]" / "on my agenda" → memory_retrieve.
  if (/\b(a\s+summary\s+of\s+me|summary\s+of\s+myself)\b/i.test(classifyMessage) ||
      /\bwhat'?s\s+on\s+my\s+plate\s+for\b/i.test(classifyMessage) ||
      /\bwhat'?s\s+on\s+my\s+agenda\s+(for|this|next|today|tomorrow)\b/i.test(classifyMessage) ||
      /\bgive\s+me\s+a\s+(short|quick|brief|full|complete)?\s*(profile|summary|overview)\s+(on|of|about)\s+me\b/i.test(classifyMessage) ||
     /\bgive\s+me\s+a\s+(short|quick|brief|full|complete)?\s*summary\s+of\s+who\s+i\s+am\b/i.test(classifyMessage) ||
     /\bsummarize\s+(who|what)\s+i\s+am\b/i.test(classifyMessage) ||
     /\bwho\s+i\s+am\s+based\s+on\s+(your|my)\s+(records?|data|notes?)\b/i.test(classifyMessage) ||
      /\beverything\s+i('ve|\s+have)?\s+(logged|entered|stored|saved|recorded|noted)\s+(so\s+far|this\s+(month|week|year)|today|recently|lately)\b/i.test(classifyMessage) ||
      /\blook\s+(through|over)\s+(my\s+)?(records?|notes?|entries|logs?|data|history)\b/i.test(classifyMessage) ||
      /\b(fetch|get|show\s+me)\s+(what\s+i\s+(been|have\s+been)|my\s+(recent|latest|past)\s+(activity|notes?|log|logs?|entries))\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Self-summary/plate retrieval override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'self-summary-retrieval-override', processingTimeMs: 0 } };
  }

  // "find my saved X" → memory_retrieve, NOT web_search (overrides the hotel/restaurant guard).
  if (/\bfind\s+(my\s+)?saved\b/i.test(classifyMessage) ||
      /\bmy\s+saved\s+(hotel|booking|reservation|flight|notes?|records?|info|details?|appointment)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Find-my-saved override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'find-my-saved-override', processingTimeMs: 0 } };
  }

  // "look up X recipe(s)" / "vegan/keto/gluten-free X recipes" / "high-protein meal ideas" → web_search.
  if (/\b(look\s+up|search\s+for|find)\s+.{0,60}\b(recipes?|meal\s+ideas?|food\s+ideas?|breakfast\s+ideas?|dinner\s+ideas?|lunch\s+ideas?|snack\s+ideas?|dish\s+ideas?)\b/i.test(classifyMessage) ||
      /\b(vegan|vegetarian|keto|paleo|gluten.?free|dairy.?free|low.?carb|high.?protein)\b.{0,60}\b(recipes?|meal\s+ideas?|food\s+ideas?|breakfast|dinner|lunch)\s+(ideas?|recipes?)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Recipe search override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'recipe-search-override', processingTimeMs: 0 } };
  }

  // "convert X to Y" file-format conversion → command_automate.
  if (/\bconvert\s+.{1,30}\s+to\s+(jpg|jpeg|png|gif|webp|pdf|mp4|mp3|wav|csv|json|xml|svg)\b/i.test(classifyMessage) ||
      /\bconvert\s+(this|the|a|an)\s+(image|file|photo|video|audio|document|png|jpg|pdf)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] File-convert override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'file-convert-override', processingTimeMs: 0 } };
  }

  // "summarize what I'm looking at" / "what am I reading right now" → screen_intelligence.
  if (/\b(summarize|describe|explain|read)\s+what\s+i'?m?\s+(looking\s+at|reading|watching|seeing)\b/i.test(classifyMessage) ||
      /\bwhat\s+am\s+i\s+(reading|looking\s+at)\s*(right\s+now|now|currently|at\s+the\s+moment)?\s*\??\s*$/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Summarize-looking-at override → screen_intelligence: "${classifyMessage}"`);
    return { ...state, intent: { type: 'screen_intelligence', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'summarize-looking-at-override', processingTimeMs: 0 } };
  }

  // Screen-intelligence screen-reading exclusion: queries about the CURRENT screen/page
  // that happen to mention "on/in my browser" are screen_intelligence, not browser automation.
  const isScreenReadQuery =
    /\b(what|which|how many|what's|whats|tell me|describe|summarize|read|give me)\b.{0,60}\b(on\s+(my\s+)?(current\s+)?(screen|display|monitor)|in\s+(my\s+)?(browser|tab|editor|terminal|window|front\s+of\s+me)|open\s+in\s+(my\s+)?(browser|tab)|on\s+my\s+screen|currently\s+(visible|showing|displayed|open))\b/i.test(classifyMessage) ||
    /\b(in\s+front\s+of\s+me|currently\s+on\s+my\s+(screen|display))\b/i.test(classifyMessage) ||
    /\bsummarize\s+(the|this|what's|what\s+is)\s+(document|page|file|content|text)\s+(open|showing|visible|in\s+front)\b/i.test(classifyMessage) ||
    /\b(what|which)\s+(url|website|page|app|application(s)?|window|tab)\s+(is|are)\s+(open|showing|visible|active|in\s+my\s+browser|in\s+front)\b/i.test(classifyMessage) ||
    /\bwhich\s+(apps?|applications?|windows?|programs?)\s+(are\s+)?(open|running|active|visible|in\s+front\s+of\s+me)\b/i.test(classifyMessage) ||
    /\bwhat\s+(is|are)\s+(the\s+)?\w[\w\s]{0,20}window\s+(showing|displaying|containing|saying|reading)\b/i.test(classifyMessage) ||
    /\btell\s+me\s+what\s+(is\s+)?on\s+(my\s+)?(current\s+)?(screen|display|monitor)\b/i.test(classifyMessage) ||
    /^(what\s+is\s+that|scan\s+this|scan\s+it)\s*\??\s*$/i.test(classifyMessage.trim()) ||
    // "Summarize the file I currently have open in VS Code" / "Describe the dashboard I have open right now"
    /\b(summarize|describe|read|explain|analyze|translate)\b.{0,50}\b(file|document|code|dashboard|page|window|tab|screen|image)\b.{0,40}\b(i\s+(currently\s+)?have|i'?m\s+currently)\s+(open|viewing|up|visible)\b/i.test(classifyMessage) ||
    /\b(file|document|code|dashboard|window|tab|screen)\b.{0,30}\b(i\s+have\s+open|i\s+currently\s+have\s+open)\b/i.test(classifyMessage) ||
    // "What X shown/displayed in VS Code's status bar" — UI element query
    /\b(what|which|how\s+many)\b.{0,60}\b(shown|displayed|showing|visible)\s+(in|on)\b.{0,50}\b(status\s+bar|toolbar|sidebar|panel|dock|taskbar|menu\s+bar)\b/i.test(classifyMessage) ||
    /\b(status\s+bar|toolbar|sidebar|panel|dock|taskbar)\b.{0,60}\b(say|show|display|indicate|tell)\b/i.test(classifyMessage) ||
    /\b(what|which)\b.{0,60}\b(status\s+bar|toolbar|sidebar|dock)\b/i.test(classifyMessage);

  // Direct screen-reading override: phi4 misclassifies "which apps are open in front of me" → memory_retrieve.
  if (isScreenReadQuery) {
    logger.debug(`[Node:ParseIntent] Screen-read query override → screen_intelligence: "${classifyMessage}"`);
    return { ...state, intent: { type: 'screen_intelligence', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'screen-read-override', processingTimeMs: 0 } };
  }

  // "Send [name] an email about X" / "Email [name] about X" → command_automate.
  // phi4 confuses email sending with memory_retrieve (contact lookup).
  if (/^(hey\s+)?(send|email|draft|write)\s+\w[\w\s'-]{0,30}\s+(an?\s+)?(email|message|msg)\s+(about|regarding|for|to\s+discuss|on|re:?)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Send-email override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'send-email-override', processingTimeMs: 0 } };
  }

  // "Take me to my X board/dashboard/project" → command_automate (browser nav, not app_control_start).
  if (/^(take\s+me\s+to|bring\s+me\s+to|go\s+to)\s+my\s+\w[\w\s-]{0,30}\s+(board|dashboard|project|page|channel|workspace|view)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Take-me-to-my-board override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'take-me-to-board-override', processingTimeMs: 0 } };
  }

  // "Push [feature] to production/staging" → command_automate.
  if (/\bpush\s+[\w\s-]{2,40}\s+to\s+(production|staging|prod|deploy|origin\s+main|origin\s+master)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Push-to-production override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'push-to-production-override', processingTimeMs: 0 } };
  }

  // "Look up [Yelp/reviews/location search] on [Street/platform]" → web_search (not browser nav).
  // browser-override fires destPrepMatch when "on" appears before a "destination" word.
  // Catch Yelp/review/rating/location searches BEFORE browser-override.
  if (/\b(yelp|google\s+maps?|tripadvisor|foursquare)\b/i.test(classifyMessage) ||
      /\b(review|reviews?|rating|ratings?)\b.{0,50}\b(on|for|in|near|about)\s+\w/i.test(classifyMessage) && /^(look\s+up|find|search)/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Yelp/review search override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'yelp-review-search-override', processingTimeMs: 0 } };
  }

  // "X is my go-to person/source for Y" → memory_store (NOT browser nav).
  // Voice renders "go-to" as "go to [next word]" which triggers hasNavVerb incorrectly.
  if (/\bis\s+my\s+(go\s*-?\s*to|go\s+to)\b/i.test(classifyMessage) && !classifyMessage.trim().endsWith('?')) {
    logger.debug(`[Node:ParseIntent] My-go-to-person override → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'my-go-to-override', processingTimeMs: 0 } };
  }

  // "Can you open/launch/start X for me [please]?" → app_control_start.
  // Polite phrasing gets caught by browser-override via navVerb. Must intercept first.
  // EXCLUDED: compound commands ("can you open X and create Y"), URLs.
  {
    const canYouOpenMatch = classifyMessage.trim().match(/^can\s+you\s+(open|launch|start|fire\s+up|pull\s+up|bring\s+up)\s+([\w][\w\s.'\-]{1,35}?)(\s+for\s+(me|us))?\s*(please)?\s*\??\s*$/i);
    if (canYouOpenMatch) {
      const dest = canYouOpenMatch[2].trim();
      if (!/ \b(and|then)\b/i.test(dest) &&
          !/\.(com|org|io|ai|app|net|co|dev)\b/i.test(dest) &&
          dest.split(' ').length <= 4) {
        // Opening an app → command_automate (shell.run open -a AppName).
        logger.debug(`[Node:ParseIntent] Can-you-open override → command_automate (shell.run): "${classifyMessage}"`);
        return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'can-you-open-override', processingTimeMs: 0 } };
      }
    }
  }

  // "Are there open source alternatives to X?", "open source alternatives to Y" → web_search.
  // The word "open" in navVerbMatch falsely triggers browser-override ("open" → navVerb, "source" → dest).
  if (/\b(open\s+source|free\s+and\s+open\s+source|foss)\s+(alternative|alternatives|replacement|replacements|substitute|substitutes)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Open-source-alternatives override → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'open-source-alternatives-override', processingTimeMs: 0 } };
  }

  // "Ping [name/host]" → command_automate (network or messaging ping).
  // phi4 sees stored contact names and routes to memory_retrieve.
  if (/^ping\s+\S+/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Ping override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'ping-override', processingTimeMs: 0 } };
  }

  // Identity/capability questions about the assistant → greeting.
  // "What's your name?" / "Who are you?" / "What are you capable of?" / "Who built you?"
  // phi4 confuses these with general_knowledge or memory_retrieve despite seeds.
  if (/^(what'?s|what is|who are|who'?s)\s+(you(r|rs?)|the\s+(ai|assistant|bot))\b/i.test(classifyMessage.trim()) ||
      /^what\s+are\s+you\s+(capable\s+of|able\s+to|designed\s+to|built\s+to|meant\s+to|supposed\s+to)\b/i.test(classifyMessage.trim()) ||
      /^(who\s+(built|made|created|developed|trained)\s+you|who\s+are\s+your\s+(creators?|developers?|makers?))/i.test(classifyMessage.trim()) ||
      /^(what\s+can\s+you\s+do|what\s+do\s+you\s+do|tell\s+me\s+about\s+yourself)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Identity-question override → greeting: "${classifyMessage}"`);
    return { ...state, intent: { type: 'greeting', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'identity-question-override', processingTimeMs: 0 } };
  }

  const isBrowserAutomation = !isScreenReadQuery && (urlPattern.test(classifyMessage) || hasNavVerb || hasDestPrep || hasVerbSiteFor);

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

  // Screenshot / screen-capture override — must run BEFORE phi4 ML call.
  // "take a screenshot" is a command action, not screen_intelligence (phi4 misclassifies it).
  if (/\b(take|grab|capture|get)\s+(a\s+)?(screenshot|screen\s*shot|screen\s*grab|screen\s*capture)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Screenshot override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'screenshot-override', processingTimeMs: 0 } };
  }

  // Download / install specific version override — imperative → command_automate.
  // "Download the latest version of Node.js" → phi4 misclassifies as web_search.
  if (/^(download|install)\b.{0,80}\b(latest|newest|current|stable|version\s+[\d.]+|v[\d.]+|release|binaries?|installer|package)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Download-version override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'download-version-override', processingTimeMs: 0 } };
  }

  // Add to calendar override — "add it/this to my calendar" → command_automate.
  // Also catches "block this off", "reserve this slot on my calendar".
  if (/\badd\s+(it|this|that|them|the\s+\w+[\w\s]{0,30})\s+to\s+(my\s+)?(calendar|agenda|events?|todo\s+list|task\s+list)\b/i.test(classifyMessage) ||
      /\bblock\s+.{0,30}(off|out)\s*(on|in|from)\s+(my\s+)?(calendar|schedule|agenda)\b/i.test(classifyMessage) ||
      /\b(reserve|book|schedule|hold|protect|save)\s+.{0,30}\b(slot|time\s+slot|spot|window|block)\b.{0,30}\b(on|in|for|at)\s+(my\s+)?(calendar|agenda|schedule)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Add-to-calendar override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'add-to-calendar-override', processingTimeMs: 0 } };
  }

  // Watch/play/stream movie/video → command_automate.
  // "watch Die Hard tonight" / "play Inception on HBO tonight" / "Stream Dune on Apple TV" → command_automate.
  if ((/^(i\s+(want|wanna)\s+to\s+|let'?s\s+|can\s+we\s+)?watch\b.{3,80}\b(tonight|now|today|this\s+(evening|weekend|afternoon|night)|for\s+me)\b/i.test(classifyMessage) ||
       /\b(play|stream|watch)\b.{0,80}\b(on\s+(netflix|hbo|hulu|disney\+?|amazon\s*prime|youtube|twitch|peacock|paramount|apple\s+tv))\b/i.test(classifyMessage) ||
       /^stream\b.{3,80}\b(this\s+(evening|night|afternoon|weekend)|now|tonight|for\s+me)\b/i.test(classifyMessage)) &&
      !/\b(how|what|why|when|my\s+(screen|monitor|display|window))\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Watch-media override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'watch-media-override', processingTimeMs: 0 } };
  }

  // Screen-intelligence structural overrides — before phi4.
  // "what does the current page say", "explain what I'm looking at" → screen_intelligence.
  if (/\b(current|active|this)\s+(page|window|tab|screen)\b.{0,60}\b(say|show|display|contain|have|read)\b/i.test(classifyMessage) ||
      /\bwhat\s+(does|is|'s)\s+(this|the\s+(current|active))\s+(page|screen|window|tab)\b/i.test(classifyMessage) ||
      /\b(explain|describe|tell\s+me\s+about)\s+what\s+i'?m\s+(looking\s+at|seeing|viewing|reading|watching)\b/i.test(classifyMessage) ||
      /\bwhat\s+am\s+i\s+(working\s+on|looking\s+at|reading|watching|viewing|doing)\s+(right\s+now|now|currently|at\s+the\s+moment)\b/i.test(classifyMessage) ||
      /\b(describe|tell\s+me\s+about)\s+(my\s+)?(current\s+)?(editor|browser|window|ide|terminal|screen|monitor)\s+(layout|state|content|view|setup|structure)\b/i.test(classifyMessage) ||
      /\b(give\s+me\s+a\s+(\w+\s+)?summary\s+of\s+the\s+\w[\w\s']{0,30}i'?m\s+(currently\s+)?(viewing|looking\s+at|reading))\b/i.test(classifyMessage) ||
      /\bcurrently\s+viewing\b/i.test(classifyMessage) ||
      // "Which Obsidian note do I currently have open?" / voice variant
      /\bcurrently\s+have\s+(open|visible|showing|active|running)\b/i.test(classifyMessage) ||
      /\bdo\s+i\s+currently\s+have\s+(open|visible|showing)\b/i.test(classifyMessage) ||
      // "Tell me all the text visible in my Arc browser tab right now"
      /\b(all\s+the\s+text\s+visible|text\s+visible\s+in\s+my|tell\s+me\s+all\s+the\s+text)\b/i.test(classifyMessage) ||
      // "Describe what my desktop looks like right now"
      /^(describe|tell\s+me)\s+what\s+my\s+(desktop|screen|display|monitor)\s+looks?\s+like\b/i.test(classifyMessage.trim()) ||
      /^describe\s+my\s+(desktop|screen|display)\b/i.test(classifyMessage.trim()) ||
      // "Tell me what error message is displayed in the current terminal window"
      /\b(error|warning|message)\s+(is\s+)?(displayed|shown|visible)\s+(in|on)\s+(the\s+)?(current\s+)?(terminal|window|editor|screen)\b/i.test(classifyMessage) ||
      /\bwhat\s+(error|warning|message)\s+is\s+(displayed|shown)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Screen-intelligence structural override: "${classifyMessage}"`);
    return { ...state, intent: { type: 'screen_intelligence', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'screen-structural-override', processingTimeMs: 0 } };
  }

  // Scientific/factual-constant override → general_knowledge.
  // "What is the boiling point of water?" — phi4 misclassifies as web_search.
  if (/\b(boiling\s+point|melting\s+point|freezing\s+point|atomic\s+(number|weight|mass)|speed\s+of\s+(light|sound)|molecular\s+weight|chemical\s+(formula|symbol)|half.?life|gravitational\s+constant|planck'?s\s+constant|avogadro'?s?\s+(number|constant)|boltzmann\s+constant|faraday\s+constant|gas\s+constant)\b/i.test(classifyMessage) ||
      /\b(avogadro|boltzmann|faraday|coulomb|hubble|newton'?s?|einstein'?s?|boyle'?s?|darwin'?s?|pascal'?s?|euler'?s?)\b.{0,30}\b(number|constant|law|principle|theorem|equation|formula|limit)\b/i.test(classifyMessage) ||
      /\bwhat\s+(are|is)\s+the\s+(common\s+|typical\s+|main\s+|possible\s+)?(symptoms?|signs?|causes?|treatment)\s+of\b/i.test(classifyMessage) ||
      /\bat\s+what\s+temperature\s+(does|will|would|can)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Scientific-constant override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'scientific-constant-override', processingTimeMs: 0 } };
  }

  // "give me a summary of this page/document/screen" → screen_intelligence.
  if (/\bgive\s+me\s+a\s+(quick\s+)?summary\s+of\s+(this|the|what\s+this)\s*(page|document|file|tab|content|text|screen|article|report)\b/i.test(classifyMessage) ||
      /\bgive\s+me\s+a\s+(quick\s+)?summary\s+of\s+what\s+this\s+(page|document|tab|article|report)\s+(is\s+about|says|contains)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Page-summary override → screen_intelligence: "${classifyMessage}"`);
    return { ...state, intent: { type: 'screen_intelligence', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'page-summary-override', processingTimeMs: 0 } };
  }

  // "What was the Marshall Plan?" / "What was the New Deal?" / "What was D-Day?" → general_knowledge.
  // phi4 misclassifies historical proper-noun questions as memory_retrieve (100% conf).
  if (/^what\s+was\s+(the\s+)?[A-Z][\w\s'-]{2,60}\??\s*$/i.test(classifyMessage.trim()) &&
      !/\b(my|your|our|i|we|you|he|she|they|it)\b/i.test(classifyMessage) &&
      !/\b\w+\s*'s?\s+(previous|former|last|old)\s+(office|job|role|company|team|position|title|department|location)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Historical-event override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'historical-event-override', processingTimeMs: 0 } };
  }

  // "What does the word X mean?" / "what does petrichor mean?" → general_knowledge.
  // Excluded: "What does this popup/dialog mean?" — that refers to a screen element (screen_intelligence).
  if (!/\bwhat\s+does\s+(this|that|the|it)\s+(popup|dialog|button|icon|badge|notification|error|warning|message|prompt|box|tooltip|modal|window)\b/i.test(classifyMessage) &&
      // "This error message — what does it mean?" / "This warning — what does it mean?" → screen_intelligence
      !/\b(this|that|the)\s+(error|warning|exception|crash|stack\s*trace)\s+(message|log)?\b.{0,30}\bwhat\s+does\s+it\s+mean\b/i.test(classifyMessage) &&
      !/^this\s+(error|warning|exception)\s*(message|—|-)?.{0,40}\bmean\b/i.test(classifyMessage.trim()) && (
      /\bwhat\s+(does\s+(the\s+(word|term|phrase)\s+)?|do\s+(the\s+(words?|terms?)\s+)?)["']?\w[\w\s-]{0,30}["']?\s+mean\b/i.test(classifyMessage) ||
      /\bwhat\s+is\s+the\s+(meaning|definition|etymology)\s+of\s+(the\s+(word|term)\s+)?["']?\w/i.test(classifyMessage) ||
      /\bdefine\s+(the\s+(word|term)\s+)?["']?\w[\w\s-]{0,30}["']?\s*\??\s*$/i.test(classifyMessage.trim()))) {
    logger.debug(`[Node:ParseIntent] Word-definition override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'word-definition-override', processingTimeMs: 0 } };
  }

  // "What is the X problem in Y" / "What is the Byzantine Generals problem" → general_knowledge.
  if (/\bwhat\s+is\s+(the\s+)?[A-Z][\w\s'-]{2,60}\s+(problem|paradox|dilemma|effect|theorem|algorithm|protocol|principle|attack|fallacy)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Technical-concept override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'technical-concept-override', processingTimeMs: 0 } };
  }

  // "What is the difference between X and Y" / "who invented X" / "what does X stand for" / recommendation queries → general_knowledge.
  if (/\bwhat\s+(is|are)\s+the\s+difference\s+between\b/i.test(classifyMessage) ||
      /\bwho\s+invented\s+(the\s+)?\w/i.test(classifyMessage) ||
      /\bwhat\s+(is|was)\s+the\s+(best\s+way|fastest\s+way|easiest\s+way|most\s+efficient\s+way)\s+to\b/i.test(classifyMessage) ||
      /\bwhat\s+(is|are)\s+the\s+best\b.{0,20}\b(approach|strategy|method|technique|practice)\s+(to|for)\b/i.test(classifyMessage) ||
      /\bwhat\s+(is|was)\.+\bbest\s+.{0,20}approach\b/i.test(classifyMessage) ||
      /\bcan\s+you\s+recommend\b.{0,60}\b(podcast|book|video|course|resource|article)\b/i.test(classifyMessage) ||
      /\bwhat\s+would\s+be\s+the\s+best\s+way\s+to\b/i.test(classifyMessage) ||
      /\bis\s+it\s+(medically|biologically|scientifically|technically|physically|theoretically|actually|really)\s+(possible|true|safe|dangerous)\s+(to|for)\b/i.test(classifyMessage) ||
      /\bwhat\s+does\b.{0,30}\bstand\s+for\b/i.test(classifyMessage) ||
      /\bwhat\s+(was|is)\s+(the\s+)?\w[\w\s'-]{0,40}\b(doctrine|theorem|principle|theory|paradigm|revolution|movement|amendment|constitution|declaration|treaty|accord|protocol|conjecture)\b/i.test(classifyMessage) ||
      /\bwhat\s+(is|are)\b.{0,60}\b(in\s+(economics|finance|accounting|law|physics|chemistry|biology|medicine|mathematics|math|statistics|philosophy|psychology))\b/i.test(classifyMessage) ||
      /\bwhich\s+(is|are)\s+(more|less|better|worse|faster|slower|more\s+efficient|more\s+effective)\b.{0,80}\bor\s+(a\s+|an\s+|the\s+)?\w/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Factual-comparison override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'factual-comparison-override', processingTimeMs: 0 } };
  }

  // Single-word continuation prompts → general_knowledge.
  if (/^(elaborate|continue|expand(\s+on\s+(that|this))?|clarify(\s+(please|that|this))?|go\s+on|tell\s+me\s+more|more\s+details?|give\s+me\s+more|keep\s+going)\s*[.!]?\s*$/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Continuation-prompt override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.90, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'continuation-prompt-override', processingTimeMs: 0 } };
  }

  // Technology/concept knowledge override → general_knowledge.
  // "Tell me about JavaScript frameworks" — phi4 misclassifies as web_search (100%).
  if (/^(tell\s+me\s+about|explain|describe|what\s+(is|are|'s))\b.{0,80}\b(javascript|typescript|python|ruby|golang|rust|swift|kotlin|react|angular|vue|nodejs|node\.?js|css|html|sql|mongodb|redis|docker|kubernetes|git\b|algorithm|machine\s+learning|deep\s+learning|neural\s+network|blockchain|api\b|rest\s+api|graphql|microservices|design\s+pattern|data\s+structure|oop|functional\s+programming|framework|library|serverless|idempotent|immutable|polymorphism|recursion|concurrency|async\/await|async\s+await|edge\s+computing)\b/i.test(classifyMessage) ||
      /\b(can\s+you\s+explain|please\s+explain|explain)\s+(uh\s+|um\s+|er\s+)?what\s+(a\s+|an\s+|the\s+)?[\w\s]{1,40}\s+(means?|is|are)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Tech-knowledge override → general_knowledge: "${classifyMessage}"`);
    return { ...state, intent: { type: 'general_knowledge', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'tech-knowledge-override', processingTimeMs: 0 } };
  }

  // Short informal greetings that phi4 misclassifies (evenin, mornin, howdy, rise and shine, etc.)
  if (/^(evenin'?|mornin'?|g'?day|howdy|hiya|aloha|ciao|salut|wassup|wazzup)\s*$/i.test(classifyMessage.trim()) ||
      /^hey\s+\w[\w\s]{0,20}\s+how\s+(you|are\s+you|you\s+doing)\b/i.test(classifyMessage.trim()) ||
      /^(rise\s+and\s+shine|wakey\s+wakey|good\s+night|sleep\s+tight|nighty\s+night|sweet\s+dreams)\s*[!.]?\s*$/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Informal greeting override → greeting: "${classifyMessage}"`);
    return { ...state, intent: { type: 'greeting', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'informal-greeting-override', processingTimeMs: 0 } };
  }

  // Greeting pre-phi4 override — "How are you?" and variants → greeting.
  // phi4 sometimes misclassifies these as general_knowledge.
  if (/^((hey|hi|hello|yo)\s+[\w\s]{1,25}\s+)?(how\s+are\s+you|how'?s\s+it\s+going|how\s+have\s+you\s+been|how\s+are\s+you\s+doing|how\s+do\s+you\s+do|good\s+(morning|afternoon|evening|night|day)|how\s+you\s+doing)\b/i.test(classifyMessage.trim()) ||
      /^(hello|hi|hey)\s+\w[\w\s]{0,20}[,!]?\s*(ready|here|let'?s|pleased|hope\s+you're|good\s+to\s+(see|meet))\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Greeting pre-phi4 override: "${classifyMessage}"`);
    return { ...state, intent: { type: 'greeting', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'greeting-override', processingTimeMs: 0 } };
  }

  // "What time am I supposed to be X by?" / "what time do I need to X?" → memory_retrieve.
  // phi4 misclassifies as command_automate because "time" looks like system-info.
  if (/\bwhat\s+time\s+(am\s+i\s+supposed\s+to|do\s+i\s+need\s+to|should\s+i|am\s+i\s+meant\s+to)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Scheduled-time memory override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'scheduled-time-memory-override', processingTimeMs: 0 } };
  }

  // "When is my sister Sofia's wedding?" / "when does my appointment start?" → memory_retrieve.
  // phi4 misclassifies as web_search (39% conf) because "when is" looks like a factual query.
  if (/\bwhen\s+is\s+my\s+.{1,60}\??\s*$/i.test(classifyMessage.trim()) ||
      /\bwhen\s+(does|do|did|was|will)\s+my\s+.{1,60}\??\s*$/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Personal-event-time override → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.95, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'personal-event-time-override', processingTimeMs: 0 } };
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

  // Service-automation override — must run BEFORE action-request and phi4 ML call.
  // "watch my Gmail", "monitor my inbox", "send me a daily text summary",
  // "check my calendar and remind me" etc. → command_automate (triggers needs_skill
  // in executeCommand so user gets directed to the Skill Store to install the right skill).
  const serviceAutomationPattern =
    /\b(watch|monitor|poll|track|check|fetch|sync|forward|filter|archive|summarize|notify|alert|read)\b.{0,100}\b(gmail|inbox|email|emails|mail|messages?|texts?|sms|slack|discord|telegram|whatsapp|calendar|google calendar|schedule|events?|appointments?|notion|airtable|jira|trello|asana|linear|hubspot|salesforce|sheets?|spreadsheet|drive|dropbox|twitter|instagram|linkedin|reddit)\b/i;
  const scheduledNotifyPattern =
    /\b(send|give|text|notify|alert)\b.{0,80}\b(daily|weekly|every night|every morning|each day|nightly|at \d|around \d|9 ?[ap]m|8 ?[ap]m|morning|evening|night)\b.{0,80}\b(summary|digest|briefing|reminder|alert|report|update)\b/i;
  if ((serviceAutomationPattern.test(classifyMessage) || scheduledNotifyPattern.test(classifyMessage)) &&
      !/\b(error|warning|on\s+(my\s+)?screen|screen\s+for\s+me|alert\s+message|notification\s+on\s+screen|pop\s*up|pop\s*ups?)\b/i.test(classifyMessage) &&
      !/\b(banner|top\s+of\s+(this\s+|the\s+)?page|at\s+the\s+top\s+of\s+(this|the)|on\s+this\s+(page|screen)|on\s+screen\s+right\s+now|currently\s+(showing|displaying|visible))\b/i.test(classifyMessage) &&
      // Exclude queries asking about current screen state — those are screen_intelligence
      !/\b(in\s+(my\s+)?(sidebar|status\s+bar|toolbar|panel|badge)|right\s+now|currently|at\s+the\s+moment)\b/i.test(classifyMessage) &&
      // Exclude screen-reading queries: "read the status bar text at the bottom of the screen"
      !/\bread\s+the\s+.{0,40}\b(screen|display|monitor|window|tab|page|bar|text)\b/i.test(classifyMessage) &&
      !/\b(at\s+the\s+bottom\s+of\s+(the\s+)?screen|on\s+screen|of\s+the\s+screen|on\s+the\s+screen)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Service-automation override → command_automate: "${classifyMessage}"`);
    return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'service-automation-override', processingTimeMs: 0 } };
  }

  // "Hello/Hi, [greeting context]" → greeting (even with embedded action phrase)
  // e.g. "Hello, I need to check something about Nadia's onboarding"
  // Must run BEFORE action-request-override.
  if (/^(hello|hi|hey)\b[,!]?\s*$/i.test(classifyMessage.trim()) ||
      (/^(hello|hi|hey)\b[,!]?\s+/i.test(classifyMessage.trim()) &&
        classifyMessage.trim().split(/\s+/).length <= 12 &&
        !/^(hello|hi|hey)\b.{0,20}(open|launch|start|find|search|book|buy|download|install|send|create|build|make|run|set up|schedule|remind|add|delete|remove|update|write|save|export|sync|fetch)\b/i.test(classifyMessage.trim()))) {
    logger.debug(`[Node:ParseIntent] Greeting-prefixed-message override → greeting: "${classifyMessage}"`);
    return { ...state, intent: { type: 'greeting', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'greeting-prefix-override', processingTimeMs: 0 } };
  }

  // Action-request override — must run BEFORE phi4 ML call.
  // "I need to X", "I need you to X", "can you do X for me", "help me X", "do X for me"
  // where X is a task verb → always command_automate.
  // EXCLUDED: renew/apply/register/sign-up/fill out — handled by guide-task-guard above.
  // EXCLUDED: "can you find what I told/said you" — those are memory_retrieve.
  const actionRequestPattern = /\b(i need (you to|to) (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|check|look up|navigate|find|search|watch|monitor|track|notify|summarize|poll|sync|fetch|forward)|can you (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|navigate|find|search|watch|monitor|track)|help me (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|navigate|find|search)|do this for me)\b/i;
  if (actionRequestPattern.test(classifyMessage) &&
      // Exclude greeting-prefixed messages ("Hello, I need to check X" → greeting)
      !/^(hello|hi|hey\b|good\s+(morning|afternoon|evening|day))\b/i.test(classifyMessage.trim()) &&
      // Exclude memory retrieval phrasing: "can you find what I told/said/saved about X"
      !/\bcan\s+you\s+find\s+what\s+i\s+(told|said|mentioned|saved|noted|shared|gave|asked|recorded|stored)\b/i.test(classifyMessage) &&
      !/\bcan\s+you\s+find\s+(what|anything|everything)\s+i\s+(told|said|mentioned|saved)\b/i.test(classifyMessage)) {
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
  if (temporalMemoryPattern.test(classifyMessage) && recallVerbPattern.test(classifyMessage) &&
      !/^i\s*('ve|have|had|was|am|'m)\s+been\b/i.test(classifyMessage) &&
      !/^(i\s+(am|was|'m)\s+|i\s+have\s+been\s+)\b/i.test(classifyMessage) &&
      // Exclude declarative sentences where user is reporting a habit/routine change with time ref
      !/^i\s+(have|had|got|take|took|drink|drank|eat|ate|use|used|started|switched)\b/i.test(classifyMessage) &&
      !/^remember\s+i\b/i.test(classifyMessage) &&
      !/^(note|log|save|keep|store|remember|record|add|write)\b/i.test(classifyMessage) &&
      !/\b(weather|whether|forecast|temperature|news|headlines|score|standings|stock|price|flight|flight status|concert|event)\b/i.test(classifyMessage)) {
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

  // Non-English translation — phi4/Xenova is English-only and misclassifies non-English
  // text. Detect non-Latin script or accent characters and translate to English first,
  // then feed the English translation to phi4 for accurate intent classification.
  // The ORIGINAL message is preserved in state.originalMessage so answer.js and
  // executeCommand.js respond in the user's actual language.
  {
    const _txt = classifyMessage;
    const _isNonEnglish = (
      /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(_txt) || // CJK/JP/KO
      /[\u0600-\u06FF]/.test(_txt) || // Arabic
      /[\u0400-\u04FF]/.test(_txt) || // Cyrillic
      /[\u0900-\u097F]/.test(_txt) || // Devanagari
      /[¿¡áéíóúüñàâçèêëîïôùûæœäöüßàèìòùã]/i.test(_txt) // Latin accents (ES/FR/DE/IT/PT)
    );

    if (_isNonEnglish && state.llmBackend) {
      try {
        const translated = await state.llmBackend.generateAnswer(
          _txt,
          {
            query: _txt,
            context: {
              systemInstructions: 'Translate the following text to English. Output ONLY the English translation, nothing else. No explanation, no preamble.',
              conversationHistory: [],
              intent: 'translate',
            },
            options: { maxTokens: 200, temperature: 0 },
          },
          { maxTokens: 200, temperature: 0 },
          null
        ).catch(() => null);

        if (translated && translated.trim()) {
          logger.info(`[Node:ParseIntent] Translated for phi4: "${_txt.substring(0, 60)}" → "${translated.trim().substring(0, 60)}"`);
          // Update classifyMessage so phi4 receives English (it's declared as let above).
          // Also propagate to state so downstream nodes carry the translation.
          // Store original so answer.js / executeCommand.js respond in user's language.
          classifyMessage = translated.trim();
          state = {
            ...state,
            message: translated.trim(),
            resolvedMessage: translated.trim(),
            originalMessage: state.originalMessage || message,
          };

          // Re-run critical overrides on the translated text — they ran earlier on the
          // original non-English text and could not match. Greetings like "How are you today?"
          // at the start of a multi-intent message must not pull the whole message into
          // memory_retrieve when the rest of it is a clear command_automate task.
          //
          // Strip leading social greeting before re-checking (e.g. "How are you today? Can you...")
          const _greetingStrip = /^(how are you[^?]*\?|hi[,!]?|hello[,!]?|hey[,!]?|good (morning|afternoon|evening)[,!]?|i'm (fine|good|ok|okay|great)[,!]?)\s*/i;
          const _strippedTranslated = classifyMessage.replace(_greetingStrip, '').trim();
          const _checkMsg = _strippedTranslated || classifyMessage;

          // File-write destination re-check
          const _fileWriteHit = (
            /\b(save|write|output|store|put)\b.{0,80}(to|into|as)\s+(~[/]|[/]|[.][/])[\w/.]+/i.test(_checkMsg) ||
            /\b(save|write|output|store|put)\b.{0,80}(to|into)\s+(a\s+)?(file|txt|text file|markdown file|md file|\.txt|\.md|\.csv|\.json)\b/i.test(_checkMsg) ||
            /\b(save|write|output)\b.{0,80}(on|in|to)\s+(my\s+)?(desktop|documents|downloads|home folder|home directory)\b/i.test(_checkMsg)
          );
          if (_fileWriteHit) {
            logger.debug(`[Node:ParseIntent] Post-translation file-write override → command_automate`);
            return { ...state, intent: { type: 'command_automate', confidence: 0.97, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'post-translation-file-write', processingTimeMs: 0 } };
          }

          // Action-request re-check on stripped message
          const _actionHit = /\b(i need (you to|to) (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|check|look up|navigate|find|search)|can you (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|navigate|find|search)|help me (do|go|open|create|send|submit|download|install|update|delete|remove|fix|set up|book|buy|schedule|order|navigate|find|search))\b/i.test(_checkMsg);
          if (_actionHit) {
            logger.debug(`[Node:ParseIntent] Post-translation action-request override → command_automate`);
            return { ...state, intent: { type: 'command_automate', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'post-translation-action-request', processingTimeMs: 0 } };
          }

          // Search-and-save pattern: "find X ... save/store/write it to ..."
          // Very common in Chinese: 帮我找X然后存到桌面
          const _searchSaveHit = /\b(find|search|look up|locate|search for)\b.{0,120}\b(save|store|write|output|put)\b/i.test(_checkMsg);
          if (_searchSaveHit) {
            logger.debug(`[Node:ParseIntent] Post-translation search-and-save override → command_automate`);
            return { ...state, intent: { type: 'command_automate', confidence: 0.96, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'post-translation-search-save', processingTimeMs: 0 } };
          }
        }
      } catch (_) {}
    }
  }

  // ─── Pre-phi4 guards for common model misclassifications ─────────────────
  // These run LAST before the ML call to catch patterns the fine-tuned model
  // consistently gets wrong. Keep them narrow and non-overlapping.

  // "X tips [for Y]" → web_search (topic lookup, no personal possessive)
  // e.g. "Greyhound anxiety around other dogs tips"
  if (/\btips(\s+for\s+\w[\w\s]{0,30})?\s*\??\s*$/.test(classifyMessage.trim()) &&
      !/\b(my|i |did i|have i|what i|our)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Tips-web-search guard → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.91, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'tips-web-search-override', processingTimeMs: 0 } };
  }

  // "[topic] ... online" → web_search (looking for online resources)
  // e.g. "Rust Book chapter 4 exercises online"
  if (/\bonline\s*\??\s*$/.test(classifyMessage.trim()) &&
      !/\b(my|i |meeting online|call online|class online|session online|working online)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] X-online web-search guard → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.91, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'x-online-web-override', processingTimeMs: 0 } };
  }

  // "[supplement/vitamin/mineral] deficiency/symptoms" → web_search (health info lookup)
  // e.g. "Vitamin D deficiency symptoms adults"
  if (/\b(vitamin\s+[a-z\d]+|magnesium|iron|zinc|calcium|omega|melatonin|collagen)\b.{0,40}\b(deficiency|toxicity|overdose)\b/i.test(classifyMessage) &&
      !/\b(my|i |am i|have i)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Supplement-deficiency web-search guard → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.91, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'supplement-deficiency-web-override', processingTimeMs: 0 } };
  }

  // "[accommodation type] in [place] [booking/reservation/view]" → web_search
  // e.g. "Riad in Marrakech with Atlas view booking"
  if (/\b(riad|hotel|hostel|airbnb|villa|apartment|guesthouse|inn|lodge|resort|cabin|chalet)\s+in\s+\w[\w\s]{1,25}\b/i.test(classifyMessage) &&
      !/\b(my|i booked|i stayed|i saved|i found|what i|did i)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Accommodation-search web guard → web_search: "${classifyMessage}"`);
    return { ...state, intent: { type: 'web_search', confidence: 0.91, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'accommodation-web-override', processingTimeMs: 0 } };
  }

  // "[Person Name] showed/taught/told us how to X" → memory_store (personal event/lesson note)
  // e.g. "Chef Benito showed us how to make fresh tagliatelle by hand today"
  if (/^[A-Z][\w]+(\s+[A-Z][\w]+)?\s+(showed|taught|demonstrated|told)\s+(us|me)\s+(how\s+to|that|about)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Teacher-event-note guard → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'teacher-event-note-override', processingTimeMs: 0 } };
  }

  // "[concept] clicked today" / "X finally makes sense" → memory_store (learning milestone)
  // e.g. "Rust ownership clicked today — borrowed references finally make sense"
  if (/\b(clicked(\s+today|\s+for\s+me)?|finally\s+makes?\s+sense|just\s+clicked|starting\s+to\s+click|suddenly\s+makes?\s+sense)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Learning-milestone guard → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'learning-milestone-override', processingTimeMs: 0 } };
  }

  // "The [item] arrived [condition]" → memory_store (delivery/event note)
  // e.g. "The zellige tiles arrived cracked — contractor says we need to reorder"
  if (/^the\s+\w[\w\s]{2,40}\s+(arrived|came|was\s+delivered|got\s+delivered)\b/i.test(classifyMessage.trim()) &&
      !/\b(when|what|where|why|how)\b/i.test(classifyMessage.trim().split(' ').slice(0, 3).join(' '))) {
    logger.debug(`[Node:ParseIntent] Delivery-note guard → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'delivery-note-override', processingTimeMs: 0 } };
  }

  // "Got a/the X installed/delivered/set up" → memory_store (past personal fact)
  // e.g. "Got a standing desk converter installed Tuesday"
  if (/^(got|i got|i had|had)\s+(a|the|an|my)\s+\w[\w\s]{2,40}\s+(installed|delivered|set\s+up|fitted|configured|repaired|adjusted)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Got-item-installed guard → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.93, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'got-item-installed-override', processingTimeMs: 0 } };
  }

  // "Set up X to try/use alongside/with Y" → memory_store (personal tool adoption note)
  // e.g. "Set up Roam Research to try alongside Obsidian for daily notes"
  if (/^set\s+up\b/i.test(classifyMessage.trim()) &&
      /\bto\s+(try|use|experiment|test|explore)\b/i.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntent] Setup-tool-trial guard → memory_store: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_store', confidence: 0.92, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'setup-tool-trial-override', processingTimeMs: 0 } };
  }

  // "What [dosage/frequency/amount] is [medicine] for my [condition/body part]?" → memory_retrieve
  // e.g. "What frequency is tretinoin for my skin?"
  if (/\bfor\s+my\s+(skin|scalp|face|nails|hair|eyes|acne|rash|joints?|knee|back|shoulder|hip|muscle)\b/i.test(classifyMessage) &&
      /^what\s+(dosage|frequency|dose|amount|schedule|timing|percentage|strength|concentration|formulation)\b/i.test(classifyMessage.trim())) {
    logger.debug(`[Node:ParseIntent] Medicine-for-my-skin guard → memory_retrieve: "${classifyMessage}"`);
    return { ...state, intent: { type: 'memory_retrieve', confidence: 0.93, entities: [], requiresMemoryAccess: true }, metadata: { parser: 'medicine-personal-override', processingTimeMs: 0 } };
  }

  // ─────────────────────────────────────────────────────────────────────────

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:ParseIntent] No MCP adapter - using rule-based fallback');
    return fallbackIntentClassification(state);
  }

  try {
    // Reuse the early DistilBERT result when available (model was called earlier
    // but was uncertain; all pattern guards fired without a match — use model's
    // best guess). Only call the service again if the early call was never attempted.
    const result = earlyModelResult
      ? { data: earlyModelResult }
      : await mcpAdapter.callService('phi4', 'intent.parse', {
          message: classifyMessage,
          context: { sessionId: context?.sessionId, userId: context?.userId }
        });

    // MCP protocol wraps response in 'data' field
    const intentData = result.data || result;
    
    const finalIntent = intentData.intent || 'general_query';
    const finalConfidence = intentData.confidence || 0.5;
    
    logger.debug(`[Node:ParseIntent] Classified as: ${finalIntent} (confidence: ${finalConfidence.toFixed(2)})`);

    // Low-confidence signal: phi4 was uncertain — record as self-repair candidate.
    // The stored entry marks this prompt for future human or automated review.
    // wrongIntent is null because we don't yet know what was wrong; source flags it as a candidate.
    const INTENT_SIGNAL_THRESHOLD = 0.55;
    if (finalConfidence < INTENT_SIGNAL_THRESHOLD) {
      mcpAdapter.callService('user-memory', 'intent_override.upsert', {
        examplePrompt: classifyMessage,
        correctIntent: finalIntent,
        wrongIntent: null,
        source: 'low_confidence_candidate'
      }).catch(() => {}); // fire-and-forget — never block intent resolution on this write
      logger.debug(`[Node:ParseIntent] Low-confidence signal recorded: "${classifyMessage.slice(0, 60)}" → ${finalIntent} (${finalConfidence.toFixed(2)})`);
    }

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
    // Exclude "book" when followed by club/shelf/store/fair (e.g. "reading for my book club").
    const lowConfActionVerb = /\b(renew|apply|register|schedule|order|buy|purchase|sign up|fill out|submit|install|download|update|fix|set up|create|send|navigate|open|search|find|go to)\b|\bbook(?!\s+(club|shelf|store|fair|review|summary|recommendation))\b/i;
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
      (msg.match(/find/i) && !msg.match(/(button|click|press|select|field|menu)/i) && !msg.match(/\b(file|folder|directory|document|the file|the folder)\b/i))) {
    return {
      ...state,
      intent: { type: 'web_search', confidence: 0.8, entities: [] },
      metadata: { parser: 'fallback', processingTimeMs: 0 }
    };
  }
  
  // Command execution patterns — always use command_automate so planSkills generates the right steps.
  // command_execute routes directly to executeCommand with no plan (0ms, does nothing).
  if (msg.match(/^(open|close|launch|quit|start|stop|run|execute)\s+[a-z]/i)) {
    return {
      ...state,
      intent: { type: 'command_automate', confidence: 0.85, entities: [] },
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

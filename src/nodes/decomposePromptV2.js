'use strict';

const fs   = require('fs');
const path = require('path');
const { parseLlmJson } = require('../utils/parseLlmJson');
const { suggestIntent } = require('../utils/routeTable');
// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
// Media routing uses the classifier's mediaListing flag (see media-search guard
// below), not the IMAGE_REQUEST_RES regexes in text-patterns.
const { SCREEN_OBSERVATION_RE, DEICTIC_CONTINUATION_RE, SCREEN_OUTPUT_RE, LOOKUP_THEN_DISPLAY_RE, DEVICE_STATE_RE, FILE_PATH_RE, SCREEN_CAPTURE_RE, inferScreenOutput } = require('../utils/textPatterns.cjs');
const { _classifyDeterministic } = require('../utils/localPlanTemplates.js');

// Spread helper — deterministic-plan state fields, including the external
// service tier (service templates pin an agent but keep normal preflight).
function _detState(tmpl) {
  if (!tmpl) return {};
  return {
    _deterministicPlan: tmpl.skillPlan,
    _deterministicTemplate: tmpl.template,
    _deterministicLowRisk: tmpl.lowRisk,
    ...(tmpl.external ? { _deterministicExternal: true, _deterministicServiceAgent: tmpl.serviceAgent } : {}),
  };
}

const INTENT_LOG_PATH = process.env.INTENT_LOG_PATH || path.join(process.cwd(), 'logs', 'intent-classifier.log');
let _intentLogDirEnsured = false;
function writeDecomposeLog(entry) {
  try {
    if (!_intentLogDirEnsured) { fs.mkdirSync(path.dirname(INTENT_LOG_PATH), { recursive: true }); _intentLogDirEnsured = true; }
    fs.appendFileSync(INTENT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  }
  catch (_) {}
}

// ── Emit intent:decided progress event so the renderer can play intent sounds ──
// Fires earlier than parseIntentV2 (decompose runs first), giving faster audio feedback.
// The renderer deduplicates: only the first intent:decided per task plays a sound.
function _emitIntentDecided(state, intent, confidence) {
  if (state && typeof state.progressCallback === 'function') {
    try {
      state.progressCallback({ type: 'intent:decided', intent, confidence });
    } catch (_) {}
  }
  // Stage E shadow mode: compare the deterministic routeTable suggestion
  // against the path that actually decided. Log-only — no behavior change.
  // Divergences here are the cutover dataset for replacing the LLM
  // number-call with the table.
  try {
    const shadow = suggestIntent(state._taskClassification, state.resolvedMessage || state.message);
    const log = state.logger || console;
    if (shadow && shadow.intent !== intent) {
      log.info(`[IntentShadow] DIVERGENCE: decided=${intent} table=${shadow.intent} rule=${shadow.rule} msg="${String(state.message || '').slice(0, 80)}"`);
    } else if (shadow) {
      log.debug?.(`[IntentShadow] agree: ${intent} (rule=${shadow.rule})`);
    }
  } catch (_) { /* shadow logging must never affect routing */ }
}

/**
 * decomposePromptV2
 *
 * Slim rewrite — single LLM call to split compound prompts into ordered sub-prompts.
 * All regex fast-paths removed. The LLM decides whether to split or pass through.
 *
 * Structural fast-paths kept (not NLU):
 *   - skillBuildRequest pass-through
 *   - _planFile / _skillPlan pass-through
 *   - _gatherQuestionPending pass-through
 *
 * Outputs: state.intentPlan[], state._decomposedIntent, state._decomposedBy
 */

const DECOMPOSE_SYSTEM_PROMPT = `You decompose a user message for an LLM intent classifier. Sub-prompts are executed by a downstream intent router:
- Each sub-prompt "text" must contain exactly ONE distinct action or intent
- Valid estimatedIntent values: command_automate, screen_intelligence, web_search, memory_store, memory_retrieve, general_knowledge, greeting, screen_display
- Mark isLongRunning:true ONLY for browser automation expected to take >30 seconds
- Mark dependsOn:[N] when this step requires the OUTPUT of step N
- CRITICAL: When dependsOn is non-empty, you MUST include dataTemplate with "{{result[N]}}" placeholders for each dependency index. Example: dataTemplate: "Using the result: {{result[0]}}"
- Return ONLY valid JSON — no markdown fences, no explanation
- CRITICAL: If ALL sub-prompts implement one artifact (skill, script, scheduled task), return ONE sub-prompt with the original text and estimatedIntent:'command_automate'. Only split when the user has multiple INDEPENDENT goals.
- CRITICAL: Do NOT split tasks that share data or target multiple agents/services for the SAME goal (e.g., "post on Twitter, then share the same post on Facebook and LinkedIn"). These are ONE command_automate step using the original full text — the downstream planner handles multiple agents in a single plan. Only split when sub-prompts are truly INDEPENDENT (different goals, no shared data, no "the same"/"it"/"that" references to prior steps).
- Navigation commands (goto, navigate to, open + specific site) → command_automate, NOT web_search
- Any task that involves interacting with a specific website or web service (sending, asking, navigating, posting, filling forms, etc.) → command_automate
- PRIORITY RULE - FILE/FOLDER ANALYSIS (takes precedence over user info rules): When the message starts with "[Folder:" or involves analyzing/listing/describing files/folders/images on the local filesystem (e.g., "[Folder: /path] tell me what files are here", "what are these images about", "analyze files in /path/to/folder"), use SINGLE command_automate step. This requires shell commands to list and read actual files, NOT memory_retrieve or web_search which will hallucinate.
- PRIORITY RULE - FILE/FOLDER WRITE (same precedence): When the message creates, writes, appends, renames, moves, copies, or deletes a local file/folder — especially with a literal path like /tmp/x.txt or ~/doc — use SINGLE command_automate step, even when the file's CONTENT mentions memory/search/display words ("create a file /tmp/notes.txt with the words remember milk" is a file write, NOT a memory store or web search). Shell file ops do the work; no retrieval step is needed to produce literal content.
- PRIORITY RULE - USER INFO WITH ACTION: When the request is about USER INFO (family, profile, personal data, relationships like mom/dad/wife/cousin, phone numbers, emails, addresses, contacts) AND also requires an external action (send, email, post, fill, submit, create, share), use SINGLE command_automate step. The user.agent skill retrieves the info internally.
- PRIORITY RULE - USER INFO ONLY: When the request is ONLY asking to show/list/tell/display USER INFO with NO external action (e.g. "who is my wife", "list my family", "what is my mom's phone", "tell me about my contacts"), use SINGLE memory_retrieve step. Do NOT use command_automate for pure info lookup.
- PRIORITY RULE - DEVICE TELEMETRY (overrides USER INFO ONLY): "my" + device/hardware state is NOT user info — battery percentage, disk space, storage, RAM/memory usage, uptime, wifi/bluetooth status, volume, brightness, CPU, IP address, hostname, OS version all require a live OS probe → command_automate. EXAMPLES: "what's my battery percentage" → command_automate | "how much disk space do I have" → command_automate | "is my wifi on" → command_automate | "check my uptime" → command_automate | "how much ram is free" → command_automate. These are never memory_retrieve or general_knowledge — nothing stored can answer them.
- EXAMPLES OF memory_retrieve: "who is my wife" → memory_retrieve | "list all info about my family" → memory_retrieve | "what do you know about my mom" → memory_retrieve | "tell me about my contacts" → memory_retrieve | "show my saved addresses" → memory_retrieve
- EXAMPLES of command_automate (user info + action): "send my family info via email" → command_automate | "email my wife's number to John" → command_automate | "post about my mom on Facebook" → command_automate | "share my contact list" → command_automate
- PRIORITY RULE - KNOWLEDGE vs SEARCH vs ACTION (when no specific website/tool is mentioned): For general questions without browser/tool interaction: Use general_knowledge for math/calculations ("convert 88s to minutes", "what is 5*7"), timeless facts ("who wrote Pride and Prejudice"), and definitions ("what is blockchain"). Use web_search for time-sensitive info (prices, news, "latest", "current"). Use command_automate ONLY when specific website interaction, tool usage, or external action is required.
- General rule: When a request combines data retrieval with an action (e.g., "send weather info via email"), split into TWO steps: (1) retrieve the data (memory_retrieve/web_search), (2) perform the action (command_automate with dependsOn:[0]).
- SCREEN DISPLAY: when a step asks to show/display/put content ON THE SCREEN (the user's desktop — "on the screen", "on my screen", "show it on screen"), use estimatedIntent:'screen_display'. As a dependent step it paints the previous step's output (use dependsOn + dataTemplate). MANDATORY: any message that ends with "…(and|then) show/display/put it on (the|my) screen" MUST end with a screen_display step depending on the fetch step — never a single-step intent. EXAMPLES: "find X and show it on the screen" → [web_search, screen_display dependsOn:[0]] | "look up the verse and put it on my screen" → [web_search, screen_display dependsOn:[0]]. "clear the screen"/"take that off the screen" → single screen_display step. NOT for reading the screen (screen_intelligence) or UI highlights (command_automate).
- PRIORITY RULE - EPISODIC MEMORY RETRIEVAL (check before NAMED SERVICE rule): When the user asks about PAST activity, screen history, or what they were doing on/in <appName> at a PRIOR time → memory_retrieve, NOT command_automate. Key signals: time references ("yesterday", "this morning", "this week", "recent", "earlier", "around 2 PM"), past tense ("was", "did", "were", "listening", "working"), or "what was on my screen". The user wants to recall past screen captures from episodic memory, not interact with the service now. EXAMPLES: "What was I working on in <appName> yesterday?" → memory_retrieve | "Show me my recent <appName> activity." → memory_retrieve | "Summarize my <appName> conversations from this morning." → memory_retrieve | "What did my <appName> look like this week?" → memory_retrieve | "What music was I listening to?" → memory_retrieve | "Find anything about the <topic> I saw earlier." → memory_retrieve | "What was on my screen around 2 PM today?" → memory_retrieve
- PRIORITY RULE - NAMED SERVICE/PLATFORM INTERACTION: When a user mentions a specific named service, website, platform, or application AND wants to find, search, locate, extract, or interact with content on that specific service → command_automate. Key distinction: "find workout videos" (general knowledge) vs "find workout videos on [named service]" (automation).
- PRIORITY RULE - CONTENT/LINK EXTRACTION: Any request to extract, retrieve, get, or obtain specific links, URLs, or structured content from a targeted source → command_automate.
- PRIORITY RULE - TARGETED INFORMATION RETRIEVAL: When the request specifies WHERE to find information (on a particular site, in a specific app, through a named service) rather than just asking WHAT information → command_automate.
- PRIORITY RULE - INTERACTIVE TASKS: Any request that implies interacting with a specific interface, form, or system to accomplish a goal → command_automate.
- PRIORITY RULE - ACCOUNT/PROFILE-BASED ACTIONS: Tasks that require accessing or managing information within a specific account, profile, or personalized system → command_automate.
- PRIORITY RULE - IMAGE/PICTURE/ICON SEARCH (high priority, checked before REAL-TIME DATA ACCESS): When the request is to show, find, display, look up, search for, or retrieve images/pictures/icons/logos/thumbnails/photos/artwork for something (app, product, person, place, concept, etc.) WITHOUT the user specifying a particular website to navigate TO or interact WITH, use web_search — NOT command_automate. The web_search intent handles image retrieval natively. ONLY use command_automate for image tasks when the user explicitly names a site to navigate to, download from, or interact with (e.g. "download from [some-site].com", "open flickr and find X", "log into X images"). EXAMPLES of web_search: "show picture of X app" → web_search | "find icon logos online" → web_search | "show me images for these apps" → web_search | "what does X look like" → web_search | "show me the image icons for each one" → web_search | "find some icon logo online so I can see the images" → web_search | "what about the icon logos for each show me images" → web_search | "can I see the app icon" → web_search.
- PRIORITY RULE - SCREEN INTELLIGENCE (check this BEFORE all other rules): When the user asks to SEE, SHOW, DESCRIBE, or IDENTIFY what is currently ON SCREEN — including the active app, window, UI elements, visible text, or current display state — use screen_intelligence. This is pure OBSERVATION with no action, navigation, or external service required. Key distinction: "what IS on screen now" → screen_intelligence. "DO something WITH the screen" → command_automate. EXAMPLES of screen_intelligence: "what app am I in" → screen_intelligence | "what type of app is this" → screen_intelligence | "what's on my screen" → screen_intelligence | "what am I looking at" → screen_intelligence | "what window is open" → screen_intelligence | "what's the active app" → screen_intelligence | "what app is currently open" → screen_intelligence | "describe what's on my screen" → screen_intelligence | "what is currently displayed" → screen_intelligence | "read what's on screen" → screen_intelligence | "what does my screen show" → screen_intelligence | "what app is focused" → screen_intelligence | "what program is running" → screen_intelligence | "which application am I using" → screen_intelligence | "what can you see on my screen" → screen_intelligence | "how does the <text/content/document/code/paragraph> on the screen look" → screen_intelligence | "what's wrong with this <text/content/document/code/paragraph> on the screen" → screen_intelligence | "check this visible <text/content/document/code/paragraph> for issues" → screen_intelligence | "does this <text/content/document/code/paragraph> on screen have errors" → screen_intelligence | "analyze the <text/content/document/code/paragraph> I can see" → screen_intelligence. EXAMPLES that are NOT screen_intelligence (have an action): "click the button on my screen" → command_automate | "type into the field I can see" → command_automate | "search for X in the app I'm using" → command_automate. CRITICAL EXCEPTION — spatial/layout/region analysis is NOT screen_intelligence even though it mentions the screen — use command_automate: "what regions are on my screen" → command_automate | "what sections can you see on screen" → command_automate | "describe the screen layout" → command_automate | "what areas/zones are visible on my screen" → command_automate | "what's the spatial grid on screen" → command_automate | "what UI zones are present" → command_automate | "show me the screen regions" → command_automate | "what regions can you see right now" → command_automate. These require a spatial grid analysis tool call (analyze_spatial_grid) that returns structured coordinate data — they are NOT plain passive observation. The distinction: asking WHAT CONTENT is on screen → screen_intelligence. Asking about the STRUCTURAL LAYOUT, REGIONS, or SECTIONS of the screen → command_automate.
- PRIORITY RULE - REAL-TIME DATA ACCESS: Requests for current, live, or real-time information from specific services that require navigation → command_automate.
- DATE RANGE EXTRACTION: If the message contains any temporal reference (e.g. "yesterday", "last week", "past 7 days", "over the past week", "a specific date", "this morning", "a couple days ago", "during the last month"), extract a dateRange object with startDate and endDate in "YYYY-MM-DD HH:MM:SS" format. startDate = beginning of the earliest referenced time, endDate = end of the latest referenced time. For relative ranges like "past week" or "last 7 days", startDate = 7 days ago at 00:00:00, endDate = today at 23:59:59. For single days like "a specific date", both start and end are that day. Set dateRange to null when NO temporal reference is present.

JSON shape: {"subPrompts":[{"text":"...","estimatedIntent":"command_automate","order":0,"dependsOn":[],"isLongRunning":false}],"dateRange":{"startDate":"2026-06-29 00:00:00","endDate":"2026-07-06 23:59:59"}}`;

function collapseLinearCAChain(plan, originalMessage, logger) {
  if (!Array.isArray(plan) || plan.length <= 1) return plan;

  const caSteps    = plan.filter(sp => sp.estimatedIntent === 'command_automate');
  const nonCaSteps = plan.filter(sp => sp.estimatedIntent !== 'command_automate');

  if (caSteps.length <= 1) return plan;

  const caOrderSet = new Set(caSteps.map(sp => sp.order));
  for (const ca of caSteps) {
    const caPredCount = ca.dependsOn.filter(d => caOrderSet.has(d)).length;
    const caSuccCount = caSteps.filter(other => other.dependsOn.includes(ca.order)).length;
    if (caPredCount > 1 || caSuccCount > 1) return plan;
  }

  const sortedCa = [...caSteps].sort((a, b) => a.order - b.order);
  let isLongRunning = false;
  let dataTemplate  = null;
  const externalDeps = [];
  for (const ca of sortedCa) {
    if (ca.isLongRunning) isLongRunning = true;
    if (!dataTemplate && ca.dataTemplate) dataTemplate = ca.dataTemplate;
    for (const dep of ca.dependsOn) {
      if (!caOrderSet.has(dep) && !externalDeps.includes(dep)) externalDeps.push(dep);
    }
  }

  const collapsedText = nonCaSteps.length === 0 ? originalMessage
    : sortedCa.map(c => c.text).join(' and ');

  const collapsedStep = {
    text: collapsedText, estimatedIntent: 'command_automate',
    order: sortedCa[0].order, dependsOn: externalDeps, isLongRunning, dataTemplate,
  };

  const newPlan = [...nonCaSteps, collapsedStep].sort((a, b) => a.order - b.order);
  const oldToNew = new Map();
  newPlan.forEach((sp, i) => {
    if (sp === collapsedStep) sortedCa.forEach(ca => oldToNew.set(ca.order, i));
    else oldToNew.set(sp.order, i);
  });

  const remapped = newPlan.map((sp, i) => ({
    ...sp, order: i,
    dependsOn: [...new Set(sp.dependsOn.map(d => oldToNew.get(d)).filter(d => d !== undefined && d < i))],
  }));

  logger.info(`[Node:DecomposePromptV2] Collapsed ${caSteps.length} linear CA steps → 1`);
  return remapped;
}

// ── Normalize user info queries ─────────────────────────────────────────────
// 1. If LLM creates memory_retrieve + command_automate for a user info query WITH an action → collapse to command_automate
// 2. If LLM creates command_automate for a pure info-only user info query (no real action) → reroute to memory_retrieve
function collapseUserInfoQuery(plan, originalMessage, logger) {
  if (!Array.isArray(plan)) return plan;

  const msgLower = originalMessage.toLowerCase();
  const userInfoKeywords = [
    'family', 'wife', 'husband', 'mom', 'dad', 'mother', 'father', 'cousin', 'sibling', 'brother', 'sister',
    'my info', 'my profile', 'personal data', 'contact', 'phone', 'email', 'address'
  ];
  const actionKeywords = [
    'send', 'email', 'post', 'fill', 'submit', 'create', 'share', 'write', 'compose', 'upload', 'message', 'text',
    'analyze', 'list', 'describe'  // filesystem actions
  ];
  const isUserInfoQuery = userInfoKeywords.some(kw => msgLower.includes(kw));
  const hasExternalAction = actionKeywords.some(kw => msgLower.includes(kw));

  if (!isUserInfoQuery) return plan;

  // Case 1: multi-step (2+) retrieve + command with action → collapse to single command_automate
  if (plan.length >= 2 && hasExternalAction) {
    const hasRetrieve = plan.some(sp => sp.estimatedIntent === 'memory_retrieve');
    const hasCommand = plan.some(sp => sp.estimatedIntent === 'command_automate');
    if (hasRetrieve && hasCommand) {
      logger.info(`[Node:DecomposePromptV2] Collapsing user info+action query (${plan.length} steps) to 1-step command_automate: ${originalMessage.slice(0, 80)}`);
      return [{
        text: originalMessage,
        estimatedIntent: 'command_automate',
        confidence: 0.85,
        order: 0,
        dependsOn: [],
        isLongRunning: false,
        dataTemplate: null
      }];
    }
  }

  // Case 2: single command_automate with no real external action → reroute to memory_retrieve
  if (plan.length === 1 && plan[0].estimatedIntent === 'command_automate' && !hasExternalAction) {
    logger.info(`[Node:DecomposePromptV2] Rerouting pure user info query to memory_retrieve: ${originalMessage.slice(0, 80)}`);
    return [{
      text: originalMessage,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null
    }];
  }

  // Case 3: pure info query (no action) but LLM hallucinated multi-step plan from conversation context
  // → strip all hallucinated steps, return single memory_retrieve for the original message
  if (!hasExternalAction && plan.length > 1) {
    logger.info(`[Node:DecomposePromptV2] Collapsing hallucinated ${plan.length}-step plan to 1-step memory_retrieve: ${originalMessage.slice(0, 80)}`);
    return [{
      text: originalMessage,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null
    }];
  }

  return plan;
}

// ── Fast number-based decision for decomposePromptV2 ─────────────────────────
// Modeled on browser.agent _decisionCall: "Return ONLY a single number".
// Returns 0–6 (single-step with that intent) or 7 (multi-step → full generation).
// Safe default on parse failure/timeout: 0 (command_automate — most common, safe single-step).
const _SINGLE_STEP_INTENTS = ['command_automate', 'screen_intelligence', 'web_search', 'memory_store', 'memory_retrieve', 'general_knowledge', 'greeting'];
function _decisionRoleLabel(m) {
  if (!(m.isThoughtCard || m.source === 'thought-attachment')) {
    return m.role === 'user' ? 'User' : 'Assistant';
  }
  return m.attachedToMessage
    ? 'Assistant (proactive card ATTACHED to the user\'s reply — the offer they are answering)'
    : 'Assistant (proactive card)';
}

async function _decomposeDecision(message, llmBackend, conversationHistory, logger, carriedHint = null) {
  const recentCtx = (conversationHistory || []).slice(-4)
    .map(m => `${_decisionRoleLabel(m)}: ${String(m.content || '').slice(0, 150)}`)
    .join('\n');
  const contextBlock = recentCtx ? `\nRecent conversation (for context only):\n${recentCtx}\n` : '';

  const systemPrompt = `You classify a user message for an LLM intent router.
Return ONLY a single number — nothing else:
  0 = command_automate (interact with a website/app/tool, external action, SCHEDULE a task/reminder/notification)
  1 = screen_intelligence (observe/describe what is currently on screen — no action)
  2 = web_search (find information online — no specific site interaction)
  3 = memory_store (save/store/remember/note a fact or preference for later retrieval)
  4 = memory_retrieve (recall past activity, user info, episodic memory — no external action)
  5 = general_knowledge (math, definitions, timeless facts — no tool needed)
  6 = greeting (hello, hi, how are you)
  7 = MULTI_STEP (the message contains 2+ truly independent goals that need separate sub-prompts)

DECISION RULES (check in order):
- "remind me to/in/at X" → 0 (scheduling a future action, NOT storing a memory)
- "send me a reminder/notification/alert" → 0 (external action to trigger a notification)
- "schedule/set up/create a reminder/task/timer" → 0 (external action)
- "remember that/note that my X is Y" → 3 (storing a fact for later retrieval)
- "save/store this" → 3 (storing information)
- "who is my wife/what is my mom's phone" → 4 (retrieving user info)
- "what did I do yesterday/recent activity" → 4 (retrieving past activity)
- "what is blockchain/what is 5*7" → 5 (general knowledge)
- "what app am I in/what's on my screen" → 1 (screen observation)
- "look online for X / find info about X / any new X out recently / what's the latest X" → 2 (web research with NO named site to interact with — NOT command_automate)
- "search the web / google X / look up X online" → 2 (web search — no site interaction)
- Naming a site to INTERACT with (post/send/create/add to cart/log in/fill a form) → 0; naming a site only to look something up on it → 2
- When in doubt → 0 (command_automate is the safest single-step default)
- PROACTIVE-CARD REPLY: a turn labeled "Assistant (proactive card)" is a popup offer the user saw; a turn labeled "ATTACHED to the user's reply" is the specific card they were looking at when they sent this message — treat the reply as answering THAT card. Classify by what the reply asks for given the card: conversational replies about it ("it already happened", "tell me more") → 5 general_knowledge, NOT 3 memory_store — unless the reply explicitly asks to remember/save something. Replies accepting an offered action ("sure", "yes", "do it") → the intent that action implies. Replies declining it ("no thanks") → 6 general_knowledge acknowledgment.
- Only return 7 when the user has MULTIPLE INDEPENDENT goals (e.g., "send an email AND schedule a meeting")
- Do NOT return 7 for multi-agent tasks that serve ONE goal (e.g., "post on Twitter, Facebook, and LinkedIn" → 0, the planner handles multiple agents)

EXAMPLES:
  "remind me in 5 minutes to take out the trash" → 0
  "send me a reminder to call mom tomorrow" → 0
  "schedule a reminder for 3pm" → 0
  "remember that my wife's name is Sarah" → 3
  "note that I prefer dark mode" → 3
  "save this conversation" → 3
  "who is my wife" → 4
  "what did I do yesterday" → 4
  "what is blockchain" → 5
  "what is 5*7" → 5
  "what app am I in" → 1
  "hello" → 6
  "post on Twitter and send an email" → 7`;

  // comms-graph's deterministic intentGuesser result travels with the handoff
  // (state._carriedHint). It is a prior, not an override: the LLM still decides,
  // but on parse failure / provider flake the hint beats the command_automate
  // default — a wrong automation plan is the most expensive misroute there is.
  const hintIdx = _SINGLE_STEP_INTENTS.indexOf(carriedHint);
  const hintLine = hintIdx >= 0
    ? `\nUpstream routing hint (deterministic comms-layer classifier): ${carriedHint} — use it unless the message clearly implies otherwise.`
    : '';
  const userPrompt = `Message: "${message}"${contextBlock}${hintLine}\nIntent? (0–7)`;

  // Parse contract: a bare digit is trusted; a single distinct digit embedded
  // in short text is extracted. Multiple distinct digits (enumerated echoes —
  // providers sometimes answer "0 = handoff, 1 = ...") or pure prose are
  // UNTRUSTED — concatenating their digits (the old /\D/g strip) produced
  // out-of-range garbage that fell through to command_automate.
  const _parseDecision = (raw) => {
    const trimmed = (raw || '').trim();
    const clean = trimmed.match(/^\s*([0-7])\s*$/);
    if (clean) return { num: parseInt(clean[1], 10), extracted: false };
    const digits = [...new Set(trimmed.match(/\d/g) || [])];
    if (digits.length === 1 && trimmed.length <= 60) {
      const n = parseInt(digits[0], 10);
      if (n <= 7) return { num: n, extracted: true };
    }
    return null;
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await llmBackend.generateAnswer(userPrompt, {
        query: userPrompt,
        context: { systemInstructions: systemPrompt },
      }, { maxTokens: 5, temperature: 0.1, fastMode: true, taskType: 'classification' });
      const parsed = _parseDecision(raw);
      if (parsed) {
        // Hint veto over bare 0: command_automate is the residual bucket —
        // "0" means "no better match", and the five-token call flakes on
        // ambiguous verbs while seeing the hint in its prompt. A confident
        // deterministic hint for a NON-automation intent beats the residual
        // (same rule as the comms keyword veto). Only 0 is vetoed — a
        // specific non-zero choice is the model affirmatively disagreeing.
        if (parsed.num === 0 && hintIdx > 0 && _SINGLE_STEP_INTENTS[hintIdx] !== 'command_automate') {
          logger.info(`[Node:DecomposePromptV2] _decomposeDecision: LLM returned residual 0 but hint=${carriedHint} claims ${_SINGLE_STEP_INTENTS[hintIdx]} — hint veto (raw="${(raw || '').trim()}"${attempt > 1 ? ` attempt=${attempt}` : ''})`);
          return hintIdx;
        }
        logger.info(`[Node:DecomposePromptV2] _decomposeDecision: intent=${parsed.num} (${_SINGLE_STEP_INTENTS[parsed.num] || 'MULTI_STEP'}) (raw="${(raw || '').trim()}" hint=${carriedHint || 'none'}${attempt > 1 ? ` attempt=${attempt}` : ''}${parsed.extracted ? ' extracted' : ''})`);
        return parsed.num;
      }
      lastErr = new Error(`unparseable: "${(raw || '').trim().slice(0, 80)}"`);
      logger.warn(`[Node:DecomposePromptV2] _decomposeDecision unparseable (attempt ${attempt}): "${(raw || '').trim().slice(0, 80)}"`);
    } catch (e) {
      lastErr = e;
      logger.warn(`[Node:DecomposePromptV2] _decomposeDecision attempt ${attempt} failed: ${e.message}`);
    }
  }
  const fallback = hintIdx >= 0 ? hintIdx : 0;
  logger.warn(`[Node:DecomposePromptV2] _decomposeDecision exhausted retries (${lastErr?.message}) — defaulting to ${fallback} (${_SINGLE_STEP_INTENTS[fallback]})`);
  return fallback;
}

async function llmDecompose(message, llmBackend, conversationHistory, logger, onParsed = null) {
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  const currentTime = now.toTimeString().split(' ')[0].substring(0, 5); // HH:MM format
  const recentCtx = (conversationHistory || []).slice(-4)
    .map(m => `${_decisionRoleLabel(m)}: ${String(m.content || '').slice(0, 150)}`)
    .join('\n');
  const contextBlock = recentCtx ? `\nRecent conversation (for context/grounding only - DO NOT include in decomposition):\n${recentCtx}\n` : '';
  const userPrompt = `CURRENT DATE AND TIME: ${currentDate} ${currentTime}\n\nDecompose ONLY the NEW user message below into ordered single-intent sub-prompts.${contextBlock}\nNEW MESSAGE TO DECOMPOSE:\n"${message}"`;

  let raw;
  try {
    raw = await llmBackend.generateAnswer(userPrompt, {
      query: userPrompt,
      context: { systemInstructions: DECOMPOSE_SYSTEM_PROMPT },
    }, { maxTokens: 400, temperature: 0.1, fastMode: true, taskType: 'classification' });
  } catch (e) {
    logger.warn(`[Node:DecomposePromptV2] LLM call failed: ${e.message}`);
    return null;
  }

  if (!raw) return null;
  logger.debug(`[Node:DecomposePromptV2] Raw LLM response: ${raw.slice(0, 200)}...`);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const sanitized = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
  logger.debug(`[Node:DecomposePromptV2] Cleaned response: ${sanitized.slice(0, 200)}...`);

  const parsed = parseLlmJson(sanitized, logger, 'Node:DecomposePromptV2');
  if (parsed) {
    logger.debug(`[Node:DecomposePromptV2] Parsed JSON: ${JSON.stringify(parsed).slice(0, 200)}...`);
    if (onParsed) onParsed(parsed); // Pass parsed JSON to main function
    // Models sometimes emit a bare array of sub-prompts instead of the
    // {"subPrompts":[...]} envelope — accept it (observed: remind prompts
    // silently lost intentPlan → rule-fallback guessed general_knowledge and
    // the answer hallucinated "I've scheduled a reminder").
    const subPrompts = parsed.subPrompts || parsed.sub_prompts
      || (Array.isArray(parsed) ? parsed : null);
    if (!Array.isArray(subPrompts) || subPrompts.length < 1) {
      logger.warn(`[Node:DecomposePromptV2] No valid subPrompts array found - parsed.subPrompts: ${JSON.stringify(parsed.subPrompts)}, parsed.sub_prompts: ${JSON.stringify(parsed.sub_prompts)}`);
      return null;
    }
    const llmDateRange = parsed.dateRange || null;
    if (llmDateRange) {
      logger.debug(`[Node:DecomposePromptV2] LLM extracted dateRange: ${JSON.stringify(llmDateRange)}`);
    }
    const mapped = subPrompts.map((sp, i) => ({
      text:            String(sp.text || '').trim().slice(0, 300),
      estimatedIntent: sp.estimatedIntent || sp.estimated_intent || 'general_knowledge',
      confidence:      typeof sp.confidence === 'number' ? sp.confidence : 0.70,
      order:           typeof sp.order === 'number' ? sp.order : i,
      dependsOn:       Array.isArray(sp.dependsOn || sp.depends_on) ? (sp.dependsOn || sp.depends_on) : [],
      isLongRunning:   Boolean(sp.isLongRunning || sp.is_long_running),
      dataTemplate:    sp.dataTemplate || sp.data_template || null,
    }));
    mapped._llmDateRange = llmDateRange;
    return mapped;
  }

  // parseLlmJson failed — attempt to extract intent from malformed JSON as fallback.
  // Handles: closed strings like "command_automate" AND truncated/unclosed strings like "command_automat
  // The regex allows an optional closing quote so truncated LLM responses are still recoverable.
  logger.warn(`[Node:DecomposePromptV2] JSON parse failed — attempting intent extraction fallback`);
  const intentMatch = sanitized.match(/["']estimatedIntent["']\s*[:=]\s*["']([^"'\n,}\]]{3,30})["']?/);
  if (intentMatch) {
    const extractedRaw = intentMatch[1].trim();
    // Snap to nearest known intent to handle partial truncation (e.g. "command_automat" → "command_automate")
    const KNOWN_INTENTS = ['command_automate', 'screen_intelligence', 'web_search', 'memory_store', 'memory_retrieve', 'general_knowledge', 'greeting', 'screen_display'];
    const extractedIntent = KNOWN_INTENTS.find(i => i.startsWith(extractedRaw) || extractedRaw.startsWith(i.slice(0, 10))) || extractedRaw;
    logger.info(`[Node:DecomposePromptV2] Extracted intent from malformed JSON: "${extractedRaw}" → "${extractedIntent}"`);
    return [{
      text: message,
      estimatedIntent: extractedIntent,
      confidence: 0.70,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
      _llmDateRange: null,
    }];
  }

  logger.warn(`[Node:DecomposePromptV2] Malformed JSON recovery failed — no estimatedIntent found in response snippet: ${sanitized.slice(0, 120)}`);
  return null;
}

module.exports = async function decomposePromptV2(state) {
  const { llmBackend, conversationHistory } = state;
  // resolvedMessage carries the clarify gate's merged answers when they exist —
  // it is the operative text for decomposition, guards, and sub-prompt content.
  const message = state.resolvedMessage || state.message;
  const logger = state.logger || console;

  // ── Structural fast-paths (not NLU — these are pipeline control signals) ──
  if (state.skillBuildRequest || state.intentPlan || state._planFile || state._skillPlan ||
      state._gatherQuestionPending || state.pendingQuestion?._isGatherPlanQuestion) {
    logger.debug('[Node:DecomposePromptV2] Structural fast-path — skipping decomposition');
    return state;
  }

  if (!message || !llmBackend) {
    logger.debug('[Node:DecomposePromptV2] No message or llmBackend — pass-through');
    return state;
  }

  // ── Surface progress before the LLM decomposition call (can take several seconds)
  if (state.progressCallback) {
    try { state.progressCallback({ type: 'planning', message: 'Breaking down your request…' }); }
    catch (_) { /* progress callback must never block execution */ }
  }

  const t0 = Date.now();
  let parsedJson = null; // Store parsed JSON for intent preservation

  // ── Local single-step short-circuit (no LLM call) ──────────────────────────
  // Use _taskClassification from resolveReferences to skip the LLM number call
  // for obvious single-step tasks. Falls through to the LLM fast decision when
  // the task type is ambiguous or the message shows multi-goal conjunctions.
  const _tc = state._taskClassification || {};
  // comms-graph's intentGuesser speaks comms vocabulary — normalize at the
  // seam. 'screen_analysis' was silently dropped (indexOf → -1) leaving
  // screen prompts hint-less at the number-call.
  const _HINT_VOCAB = { screen_analysis: 'screen_intelligence' };
  const _rawHint = typeof state._carriedHint === 'string' ? state._carriedHint : null;
  const _carriedHint = _rawHint ? (_HINT_VOCAB[_rawHint] || _rawHint) : null;
  const _msgLower = String(message || '').toLowerCase();
  // Plain "and" alone is not a multi-goal signal ("set volume and brightness"
  // is one goal) — but "and <action verb>" introduces an independent clause:
  // "set my volume to 30 AND open apple.com" was being swallowed whole by the
  // device-state guard, so the second goal got LLM-planned (and hallucinated a
  // clarify step) instead of splitting into sub-prompts.
  const _MULTI_GOAL_CONJUNCTIONS = /\b(and\s+then|also|after\s+that|additionally|plus|furthermore|then\s+also)\b|;\s*[a-z]|\band\s+(?:then\s+)?(?:open|launch|start|run|create|write|delete|remove|move|rename|copy|take|capture|grab|set|remind|schedule|send|post|tweet|email|text|message|search|find|look\s+up|check|list|show|tell|add|make|download|save|read|print|close|quit|restart|mute|shut)\b|\b(?:and\s+)?then\s+(?:open|launch|start|run|create|write|delete|remove|move|rename|copy|take|capture|grab|set|remind|schedule|send|post|tweet|email|text|message|search|find|look\s+up|check|list|show|tell|read|print|save|close|quit)\b|\band\s+(?:then\s+)?(?:how\s+(?:much|many|long|often|old|far)|what(?:'s|\s+is|\s+are|\s+was)|when|where|who|which)\b/i;
  // "open slack and send a message" / "open youtube and play X" are ONE
  // compound service task, not two goals — the second verb acts inside the
  // thing just opened. Only a real cross-domain conjunction counts.
  const _OPEN_THEN_SERVICE_ACTION = /\b(?:open|launch)\s+[^.]*?\band\s+(?:then\s+)?(?:play|send|post|tweet|email|text|message|search|find|watch|look\s+up|check|show|read)\b/i;
  // "read the file and tell me what it says" — anaphoric report-continuation
  // ("it"/"the result" refers back to clause 1's output), not a new goal.
  // "tell me how long my mac has been on" introduces NEW data → still multi.
  const _AND_REPORT_BACK = /\band\s+(?:then\s+)?(?:tell|show|read)\s+me\s+(?:what\s+(?:it|that|they|he|she)\b|if\s+(?:it|that|they)\b|the\s+(?:result|answer|output|results|top\s+\w+|findings|summary|answer)\b)/i;
  // "if X then Y" is a conditional, not sequencing — the then-clause is not a
  // second goal.
  const _IF_THEN = /\bif\b[^.;]*\bthen\b/i;
  const _hasMultiGoalConjunction = _MULTI_GOAL_CONJUNCTIONS.test(_msgLower) && !_OPEN_THEN_SERVICE_ACTION.test(_msgLower) && !_AND_REPORT_BACK.test(_msgLower) && !_IF_THEN.test(_msgLower);
  const _SINGLE_STEP_TASK_TYPES = new Set(['local_file', 'local_system', 'app_automation', 'browser']);
  const _ACTION_TASK_TYPES = new Set(['local_file', 'local_system', 'app_automation', 'browser', 'messaging', 'scheduling']);
  // Ambient-artifact misresolution: a bare-deictic continuation ("tell me
  // more about that", "when was that") can only refer to the conversation,
  // yet classifyTask sometimes resolves the deictic to the open file/url
  // (observed: activeDocRef:'file' + followUpTarget:'the plan file in Devin'
  // → general_knowledge answered about Devin planning instead of the prior
  // recall). Prompt rule 140 already bans the conflation — enforce it here:
  // the veto suppresses the query-follow-up web_search AND routes to
  // memory_retrieve via the unresolved-follow-up guard below.
  const _ambientMisref = DEICTIC_CONTINUATION_RE.test(message)
    && ['file', 'url'].includes(_tc.activeDocRef)
    // A deictic followed by an artifact/content noun ("that file", "this
    // error") legitimately resolves to the ambient referent — exempt it.
    && !/\b(?:that|this|it|those|them)\s+(?:file|page|site|website|tab|document|doc|folder|screen|window|app|dialog|error|link|article|video|song|post|image|photo|picture|recipe|message|email)\b/i.test(message);
  // ── Declined-ack guard — checked BEFORE every intent guard ───────────────
  // resolution==='declined_ack' means the user refused an attached card/offer —
  // a complete answer, not a task. Emit a single general_knowledge step; the
  // router sends it straight to 'answer', bypassing search/planning/execution.
  if (_tc.resolution === 'declined_ack') {
    logger.info('[Node:DecomposePromptV2] declined_ack — routing to answer (no tool execution)');
    const subPrompts = [{
      text: message,
      estimatedIntent: 'general_knowledge',
      confidence: 0.9,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'declined-ack-guard', intent: 'general_knowledge',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'general_knowledge', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'general_knowledge', 0.9);
    return {
      ...state,
      _decomposedIntent: 'general_knowledge',
      _decomposedBy: 'declined-ack-guard',
      intentPlan: subPrompts,
    };
  }
  // ── Screen-output guard — checked BEFORE every intent guard ──────────────
  // classifyTask sets isScreenOutput when the user wants content PAINTED onto
  // the screen surface (GhostLayer): "show it on the screen", "make it rain",
  // "clear the screen". Deterministic route to the screen_display intent →
  // screenOutput node → POST /screen/display|clear on the overlay server.
  // Multi-goal messages ("search X and show it on the screen") fall through to
  // the LLM decomposer, which can emit screen_display as a dependsOn step.
  //
  // isScreenOutput is one flaky classifyTask field — the utterance carries the
  // signal lexically (display verb → "on my screen" / clear / effect word), so
  // SCREEN_OUTPUT_RE fills the flag the classifier missed. Passive observation
  // questions are excluded via SCREEN_OBSERVATION_RE (they never mutate).
  const _lookupThenDisplay = LOOKUP_THEN_DISPLAY_RE.test(message);
  // A capture request is the opposite of display output — "take a screenshot
  // of my screen" flaked isScreenOutput:true and produced a
  // [web_search, screen_display] plan that hallucinated the capture.
  const _isScreenCapture = SCREEN_CAPTURE_RE.test(message);
  const _screenOutputLex = (SCREEN_OUTPUT_RE.test(message) || _lookupThenDisplay)
    && !SCREEN_OBSERVATION_RE.test(message) && !_isScreenCapture;
  // classifyTask flakes isScreenOutput on file-write phrasing ("create a file
  // at /tmp/x containing the text Y" → true). A literal path + file op is a
  // filesystem task — content goes to disk, never to the display surface.
  const _fileOpShape = FILE_PATH_RE.test(message)
    && (/\b(file|folder|directory)\b|\.\w{2,6}\b/i.test(message)
        || /\b(create|write|append|save|store|rename|move|copy|read|list)\b/i.test(message));
  if (_tc.isScreenOutput && _fileOpShape && !_screenOutputLex) {
    logger.info('[Node:DecomposePromptV2] isScreenOutput clamped — literal file path + file verb (classifier flake)');
  }
  const _screenOutFlag = (_tc.isScreenOutput && !_fileOpShape) || _screenOutputLex;
  if (_screenOutFlag && !_isScreenCapture
      && (!_hasMultiGoalConjunction || _lookupThenDisplay)) {
    logger.info(`[Node:DecomposePromptV2] Screen-output guard: routing to screen_display (action=${_tc.screenOutputAction || 'show'} kind=${_tc.screenOutputKind || 'text'}) — skipping command_automate short-circuit`);

    // Fetch→display: "show me john 3:16 on my screen" names fresh content to
    // look up — emit web_search → screen_display(dependsOn). Referential
    // phrasing ("show it/the whole chapter") resolves from history instead,
    // and kinds that carry their own content (emoji/effect/image/payload)
    // never need a fetch step.
    //
    // Kind/content resolution: classifyTask's screenOutputKind +
    // screenOutputContent fields flake independently ("make confetti appear"
    // → kind:'text' + no content → a spurious fetch step ran web_search and
    // its answer hallucinated the display). The utterance carries the kind
    // lexically — inferScreenOutput shares screenOutput.js's vocabulary — so
    // an inferred kind/content completes or corrects the flaky fields here
    // and is written back into _taskClassification for the screenOutput node.
    const _inferred = inferScreenOutput(message);
    const _kind = _inferred.kind
      || _tc.screenOutputKind
      || 'text';
    const _content = _tc.screenOutputContent || _inferred.content || null;
    const _action = _tc.screenOutputAction || 'show';
    const _REFERENTIAL_RE = /\b(it|that|this|them|those|the\s+(result|answer|chapter|verse|response|reply|output|list|chart|graph|data|one)|whole\s+\w+|above|previous|again)\b/i;
    const _needsFetch = _lookupThenDisplay
      || (_action === 'show'
        && ['text', 'chart'].includes(_kind)
        && !_content
        && !_tc.screenOutputPayload
        && !_REFERENTIAL_RE.test(message));

    const displayStep = {
      text: message,
      estimatedIntent: 'screen_display',
      confidence: 0.9,
      order: _needsFetch ? 1 : 0,
      dependsOn: _needsFetch ? [0] : [],
      isLongRunning: false,
      dataTemplate: null,
    };
    const subPrompts = _needsFetch
      ? [{
          text: message,
          estimatedIntent: 'web_search',
          confidence: 0.9,
          order: 0,
          dependsOn: [],
          isLongRunning: false,
          dataTemplate: null,
        }, displayStep]
      : [displayStep];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'screen-output-guard', intent: 'screen_display',
      subPromptCount: subPrompts.length, durationMs,
      subPrompts: subPrompts.map(s => ({ order: s.order, text: s.text, estimatedIntent: s.estimatedIntent, dependsOn: s.dependsOn, isLongRunning: false, dataTemplate: null })),
    });
    _emitIntentDecided(state, 'screen_display', 0.9);
    return {
      ...state,
      _decomposedIntent: 'screen_display',
      _decomposedBy: 'screen-output-guard',
      _taskClassification: {
        ..._tc,
        screenOutputKind: _kind,
        ...(_content && !_tc.screenOutputContent ? { screenOutputContent: _content } : {}),
      },
      intentPlan: subPrompts,
    };
  }
  // ── Media-search guard — checked BEFORE the command_automate short-circuit ──
  // classifyTask sets mediaListing when the user wants a SET of media results
  // (image carousel / video cards with links). The web_search intent handles
  // both natively — routing these to command_automate would build a web agent
  // + auth preflight + SERP crawl for a task a single search call answers.
  // This replaces the old IMAGE_REQUEST_RES regex guard: the classifier sees
  // conversation history, so media-less follow-ups ("pull list with links")
  // resolve correctly via followUpTarget.
  const _mediaListing = _tc.mediaListing || 'none';
  // Image requests on a NAMED site ("pics of baby clothes on amazon") stay
  // command_automate → site_search → web.crawl → extractItems (structured
  // product cards). Generic image queries route to web_search.
  // Video requests route to web_search even when a video platform is named —
  // Brave Video Search handles site-scoped queries and youtube SERP crawls
  // are bot-walled. Non-video sites stay command_automate.
  const _VIDEO_PLATFORMS = new Set(['youtube', 'yt', 'vimeo', 'tiktok', 'twitch', 'netflix', 'rumble', 'bitchute', 'dailymotion']);
  const _targetSvcLower = String(_tc.targetService || '').toLowerCase();
  const _routeMediaToWebSearch =
    !_hasMultiGoalConjunction &&
    _tc.webAccessMode !== 'interactive' &&
    (
      (_mediaListing === 'image' && !_tc.targetService) ||
      (_mediaListing === 'video' && (!_tc.targetService || _VIDEO_PLATFORMS.has(_targetSvcLower)))
    );
  if (_routeMediaToWebSearch) {
    logger.info(`[Node:DecomposePromptV2] Media-search guard: routing to web_search (mediaListing=${_mediaListing} taskType=${_tc.taskType} targetService=${_tc.targetService || 'none'}) — skipping command_automate short-circuit`);
    const subPrompts = [{
      text: message,
      estimatedIntent: 'web_search',
      confidence: 0.9,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'media-search-guard', intent: 'web_search',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'web_search', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'web_search', 0.9);
    return {
      ...state,
      _decomposedIntent: 'web_search',
      _decomposedBy: 'media-search-guard',
      _mediaListing,
      intentPlan: subPrompts,
    };
  }
  // ── Public-research guard — checked BEFORE the command_automate short-circuit ──
  // classifyTask marks "look online for X" / "any new X recently" as
  // taskType=browser + webAccessMode=public_read, which would otherwise
  // short-circuit to command_automate → resolveAgent → a fabricated browser agent
  // + auth preflight for a task that only needs a web search. When NO specific
  // site/service is named, route to the web_search intent (existing cheap path:
  // webSearch node → answer). Named-site research stays command_automate so the
  // planner can use web.agent preferDomain — but it still won't get an agent.
  // Exemption: a deterministic command_automate hint means the comms guesser
  // saw an imperative action ("open the Notes app" flaked to
  // webAccessMode:public_read once → routed to a useless web search). The
  // guesser's command_automate arms are action-verb-verified; a flaky
  // webAccessMode field cannot veto them.
  // A literal filesystem path means the task embeds a file op ("search the web
  // for X and save it to /tmp/y") — not pure public research. The path is
  // ground truth; let the decomposer/agent path see the save half.
  if (_tc.webAccessMode === 'public_read' && !_tc.targetService && !_hasMultiGoalConjunction
      && _carriedHint !== 'command_automate' && !FILE_PATH_RE.test(message)) {
    logger.info(`[Node:DecomposePromptV2] Public-research guard: routing to web_search (taskType=${_tc.taskType}) — skipping command_automate short-circuit`);
    const subPrompts = [{
      text: message,
      estimatedIntent: 'web_search',
      confidence: 0.9,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'public-research-guard', intent: 'web_search',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'web_search', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'web_search', 0.9);
    return {
      ...state,
      _decomposedIntent: 'web_search',
      _decomposedBy: 'public-research-guard',
      intentPlan: subPrompts,
    };
  }

  // Conversation follow-ups with a resolved topic are knowledge lookups, not
  // service automation. webSearch uses followUpTarget as the concrete query.
  // Only hijack to web_search when the classifier actually wants web access —
  // 'none' means the follow-up is about personal/local data and belongs in
  // memory_retrieve. Also never send a resolved *file path* to Brave.
  const _followUpTargetIsPath = typeof _tc.followUpTarget === 'string' && (
    /^~?\//.test(_tc.followUpTarget) ||
    /^[A-Za-z]:[\\/]/.test(_tc.followUpTarget) ||
    /\.(rtf|pdf|docx?|xlsx?|csv|txt|md|png|jpe?g|gif|mp4|mov|zip)$/i.test(_tc.followUpTarget)
  );
  if (
    _tc.taskType === 'query' &&
    _tc.isFollowUp &&
    _tc.followUpTarget &&
    !_followUpTargetIsPath &&
    _tc.webAccessMode !== 'none' &&
    !_tc.isScreenFollowUp &&
    !_tc.isConversationRecall &&
    !_tc.isActivityQuery &&
    !_tc.isAppUiInspection &&
    !_tc.isSpatialAnalysis &&
    !_tc.needsFreshScreen &&
    !_tc.targetService &&
    !_tc.requiresDOM &&
    !_ambientMisref &&
    !_hasMultiGoalConjunction
  ) {
    logger.info(`[Node:DecomposePromptV2] Query-follow-up guard: routing to web_search for resolved topic "${_tc.followUpTarget}"`);
    const subPrompts = [{
      text: message,
      estimatedIntent: 'web_search',
      confidence: 0.9,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'query-followup-guard', intent: 'web_search',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'web_search', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'web_search', 0.9);
    return {
      ...state,
      _decomposedIntent: 'web_search',
      _decomposedBy: 'query-followup-guard',
      intentPlan: subPrompts,
    };
  }
  // needsFreshScreen = classifier saw a deictic screen reference with no cached
  // context — observational by definition. Skip the automation short-circuit so
  // the LLM decision can apply its screen_intelligence priority rule instead of
  // forcing command_automate → app.agent clipboard scraping.
  // Disagreement check: the short-circuit trusts one classifyTask label to
  // skip ALL routing — and taskType flakes ("find me three ramen restaurants
  // in SF" → local_system → forced command_automate over a web_search hint).
  // When the deterministic comms-layer guesser claims a non-automation
  // intent, the signals disagree — get the number call's opinion instead of
  // trusting the label.
  const _hintDisagreesWithAutomation = _carriedHint
    && _carriedHint !== 'command_automate'
    && _SINGLE_STEP_INTENTS.includes(_carriedHint)
    // A literal path overrides the veto — "create a file /tmp/x.txt" drew a
    // web_search hint off the word "remember" and produced a
    // [web_search, screen_display] plan for a file write. The path token is
    // ground truth; the task touches the filesystem regardless of the hint.
    && !FILE_PATH_RE.test(message);
  // Device-state queries ("what's my battery percentage", "check disk space",
  // "is my wifi on") can ONLY be answered by an OS probe — there is no text
  // answer to hallucinate. This is as deterministic as the screen-output
  // guard: fire regardless of a disagreeing hint (the comms guesser emitted
  // 'general_knowledge' for battery because the phrasing has no action verb)
  // and regardless of taskType flakiness (classifyTask typed battery both
  // 'local_system' and 'query' across runs).
  if (DEVICE_STATE_RE.test(message) && !_hasMultiGoalConjunction) {
    logger.info('[Node:DecomposePromptV2] Device-state guard → single-step command_automate');
    const subPrompts = [{
      text: message, estimatedIntent: 'command_automate', confidence: 0.9,
      order: 0, dependsOn: [], isLongRunning: false, dataTemplate: null,
    }];
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'device-state-guard', intent: 'command_automate',
      subPromptCount: 1, durationMs: Date.now() - t0,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'command_automate', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'command_automate', 0.9);
    const _devTmpl = await _classifyDeterministic(message, _tc, state.llmBackend, logger);
    return { ...state, _decomposedIntent: 'command_automate', _decomposedBy: 'device-state-guard', intentPlan: subPrompts,
      ..._detState(_devTmpl) };
  }

  // Named-service site interaction ("search amazon for wireless headphones")
  // — taskType 'browser' + a resolved targetService + a site verb means a
  // real service-agent task (amazon.agent exists). The hint layer guesses
  // web_search for site-search shapes, and llmDecompose once chose
  // memory_retrieve off "show me the top results" — both hallucinate a
  // fetch that never ran. Site interaction is command_automate by design.
  if (_tc.taskType === 'browser' && _tc.targetService && !_hasMultiGoalConjunction
      && /\b(search|find|look\s+for|browse|shop|buy|order|get|open|go\s+to|navigate|check|compare|price|add\s+to\s+cart|cart|deal|result)/i.test(message)) {
    logger.info(`[Node:DecomposePromptV2] Named-service site guard → command_automate (service=${_tc.targetService})`);
    const subPrompts = [{
      text: message, estimatedIntent: 'command_automate', confidence: 0.88,
      order: 0, dependsOn: [], isLongRunning: false, dataTemplate: null,
    }];
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'site-service-guard', intent: 'command_automate',
      subPromptCount: 1, durationMs: Date.now() - t0,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'command_automate', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'command_automate', 0.88);
    // Adopt a force-classified plan when it hits — "open youtube.com" is a
    // plain url_open, not a service-agent task, and shouldn't pay for agent
    // selection + the full planning prompt.
    const _siteTmpl = await _classifyDeterministic(message, _tc, state.llmBackend, logger);
    return { ...state, _decomposedIntent: 'command_automate', _decomposedBy: 'site-service-guard', intentPlan: subPrompts,
      ..._detState(_siteTmpl) };
  }

  // Fetch+save composition ("search the web for X and save it to /path") —
  // the literal output path makes the second goal unambiguous. Emit the
  // two-intent shape directly instead of trusting llmDecompose, which has
  // collapsed this to a lone web_search and silently dropped the file write.
  const _fsPathGlobal = new RegExp(FILE_PATH_RE.source, 'g' + (FILE_PATH_RE.flags.includes('i') ? 'i' : ''));
  const _fetchSavePaths = [...String(message).matchAll(_fsPathGlobal)].map(m => m[0].trim());
  const _fetchSavePath = _fetchSavePaths[_fetchSavePaths.length - 1] || null;
  if (_fetchSavePath
      && /\b(search|look\s+up|find|google|fetch|check|get|what(?:'s| is| are)?|who|current|latest|when)\b/i.test(message)
      && /\b(save|write|store|put|record|download|export)\b/i.test(message)) {
    const _dst = _fetchSavePath.replace(/[.,;:'")\]]+$/, '');
    logger.info(`[Node:DecomposePromptV2] Fetch+save guard → [web_search, command_automate] (dst=${_dst})`);
    const subPrompts = [
      { text: message, estimatedIntent: 'web_search', confidence: 0.9,
        order: 0, dependsOn: [], isLongRunning: false, dataTemplate: null },
      { text: `Save the retrieved result to ${_dst}`, estimatedIntent: 'command_automate', confidence: 0.9,
        order: 1, dependsOn: [0], isLongRunning: false,
        dataTemplate: `Save this result to ${_dst}: {{result[0]}}` },
    ];
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'fetch-save-guard', intent: 'command_automate',
      subPromptCount: 2, durationMs: Date.now() - t0, subPrompts,
    });
    _emitIntentDecided(state, 'command_automate', 0.9);
    return { ...state, _decomposedIntent: 'command_automate', _decomposedBy: 'fetch-save-guard', intentPlan: subPrompts };
  }

  if (_SINGLE_STEP_TASK_TYPES.has(_tc.taskType) && !_tc.needsFreshScreen && !_hasMultiGoalConjunction && !_hintDisagreesWithAutomation) {
    logger.info(`[Node:DecomposePromptV2] Local short-circuit: single-step command_automate (taskType=${_tc.taskType}, no multi-goal conjunction) — skipping LLM decision`);
    const subPrompts = [{
      text: message,
      estimatedIntent: 'command_automate',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'local-short-circuit', intent: 'command_automate',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'command_automate', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'command_automate', 0.85);
    // Force-classified fast-path: one small call compiles the skillPlan for
    // unambiguous local ops — skips preflight/grill/the 84k plan prompt.
    const _localTmpl = await _classifyDeterministic(message, _tc, state.llmBackend, logger);
    return {
      ...state,
      _decomposedIntent: 'command_automate',
      _decomposedBy: 'local-short-circuit',
      intentPlan: subPrompts,
      ..._detState(_localTmpl),
    };
  }
  // Conversation-recall meta-questions → memory_retrieve (NOT general_knowledge)
  // These ask about prior chat turns — web search is irrelevant and produces noise.
  if (_tc.isConversationRecall && !_hasMultiGoalConjunction) {
    logger.info(`[Node:DecomposePromptV2] Local short-circuit: single-step memory_retrieve (isConversationRecall=true) — skipping LLM decision`);
    const subPrompts = [{
      text: message,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'local-short-circuit', intent: 'memory_retrieve',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'memory_retrieve', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'memory_retrieve', 0.85);
    return {
      ...state,
      _decomposedIntent: 'memory_retrieve',
      _decomposedBy: 'local-short-circuit',
      intentPlan: subPrompts,
    };
  }

  // ── Screen-observation guard — BEFORE the follow-up guard and number call ──
  // classifyTask marks live-screen questions with typed flags (activeDocRef:
  // 'screen', isScreenFollowUp, needsFreshScreen). The single-digit number call
  // flakes on these — "what's on my screen" drew command_automate (100s) one
  // run and screen_intelligence (18s) the next. The referent is structurally
  // known (the live screen), so route deterministically when taskType is
  // 'query' — imperative screen actions carry local_system/app_automation and
  // still need planning, never this guard.
  const _isLiveScreenQuery = (
      (_tc.taskType === 'query'
        && (_tc.activeDocRef === 'screen' || _tc.isScreenFollowUp === true || _tc.needsFreshScreen === true)
        // Hint veto: a lone flaky flag must not beat a contradictory comms
        // guess — "summarize what I worked on recently" drew
        // needsFreshScreen:true (hallucination) while the hint said
        // memory_retrieve (observed Stage-2 flake).
        && !(_carriedHint && _carriedHint !== 'screen_intelligence'))
      // Lexical arm: classifyTask's flags are LLM-derived and flaky — "what
      // app am I looking at" drew isFollowUp:true/activeDocRef:'file' with no
      // screen flags, falling through to the unresolved-follow-up guard →
      // memory_retrieve (observed Stage-2 flake). The message's own screen-
      // observation vocabulary is deterministic; trust it whenever the task
      // isn't classified as an action (imperatives still need planning).
      || (SCREEN_OBSERVATION_RE.test(message) && (!_tc.taskType || !_ACTION_TASK_TYPES.has(_tc.taskType)))
    ) && !_tc.isScreenOutput;
  if (_isLiveScreenQuery && !_hasMultiGoalConjunction) {
    logger.info('[Node:DecomposePromptV2] Screen-observation guard: routing to screen_intelligence (typed flags) — skipping number call');
    const subPrompts = [{
      text: message,
      estimatedIntent: 'screen_intelligence',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'screen-observation-guard', intent: 'screen_intelligence',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'screen_intelligence', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'screen_intelligence', 0.85);
    return {
      ...state,
      _decomposedIntent: 'screen_intelligence',
      _decomposedBy: 'screen-observation-guard',
      intentPlan: subPrompts,
    };
  }

  // ── Deictic-continuation guard — AFTER the screen guard, BEFORE the
  // follow-up guard and number call ─────────────────────────────────────────
  // A bare deictic ("tell me more about that", "when was that") carries its
  // referent entirely in the conversation transcript — memory_retrieve is the
  // only intent with transcript access. Left to the number call it flaked to
  // general_knowledge (observed Stage-3 runs 1-2: semanticCtx happened to
  // carry the topic so the answer looked right, but the route lacked the
  // transcript). A contradicting hint vetoes — an action/search deictic
  // ("do that again") asks to re-run a task, not recall it.
  if (DEICTIC_CONTINUATION_RE.test(message)
      && !_hasMultiGoalConjunction
      && (!_carriedHint || _carriedHint === 'memory_retrieve')) {
    logger.info('[Node:DecomposePromptV2] Deictic-continuation guard: bare deictic resolves via transcript — routing to memory_retrieve, skipping number call');
    const subPrompts = [{
      text: message,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'deictic-continuation-guard', intent: 'memory_retrieve',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'memory_retrieve', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'memory_retrieve', 0.85);
    return {
      ...state,
      _decomposedIntent: 'memory_retrieve',
      _decomposedBy: 'deictic-continuation-guard',
      intentPlan: subPrompts,
    };
  }

  // ── Unresolved-follow-up guard ────────────────────────────────────────────
  // When classifyTask flagged isFollowUp but could not resolve a concrete
  // followUpTarget, the message is a referent-less continuation (e.g. a bare
  // "yes you can" whose offer-resolution failed). Running web_search on the
  // literal text produces nonsense ("yes you can" → Yes You Can! brand results).
  // Route to memory_retrieve instead — the answer node gets the full recent
  // history and can respond from context or ask a clarifying question.
  // resolution==='needs_clarification' is the centralized version of the same
  // verdict: the clarify gate already ran (or was unavailable), so the message
  // is still unresolved — answer from context, never literal tool execution.
  // A screen-referential message ("read the text visible on my screen") is not
  // an unresolved follow-up even when classifyTask flags isFollowUp — the live
  // screen IS the resolved referent. Forcing memory_retrieve answers a
  // live-observation question from stale captures (or worse, nothing).
  const _screenReferent = _tc.activeDocRef === 'screen'
    || _tc.isScreenFollowUp === true
    || _tc.needsFreshScreen === true
    || SCREEN_OBSERVATION_RE.test(message);
  // An imperative action message carries its own referent — "text mom that
  // I'll be late" was flagged isFollowUp (busy history) with null target and
  // got routed to memory_retrieve, which then claimed "Message sent". When
  // the classifier's own fields name an action (command_automate suggestion,
  // resolved service, interactive actions), the isFollowUp flag is the flake,
  // not the intent.
  const _actionableMessage = _ACTION_TASK_TYPES.has(_tc.taskType)
    && (_tc.suggestedIntent === 'command_automate'
        || _tc.targetService
        || (_tc.interactiveActions && _tc.interactiveActions.length > 0));
  if (((_tc.isFollowUp && !_tc.followUpTarget) || _tc.resolution === 'needs_clarification' || _ambientMisref) && !_hasMultiGoalConjunction && !_screenReferent && !_actionableMessage) {
    logger.info(`[Node:DecomposePromptV2] Unresolved-follow-up guard: ${_ambientMisref ? 'bare deictic misresolved to ambient ' + _tc.activeDocRef : (_tc.resolution === 'needs_clarification' ? 'resolution=needs_clarification' : 'isFollowUp with null followUpTarget')} — routing to memory_retrieve (answer from history), skipping web_search on literal text`);
    const subPrompts = [{
      text: message,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.8,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'unresolved-followup-guard', intent: 'memory_retrieve',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'memory_retrieve', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, 'memory_retrieve', 0.8);
    return {
      ...state,
      _decomposedIntent: 'memory_retrieve',
      _decomposedBy: 'unresolved-followup-guard',
      intentPlan: subPrompts,
    };
  }

  // ── Thought-reply guard — checked BEFORE the LLM number-call ──────────────
  // A reply bound to an attached proactive card (isThoughtReply + resolved
  // followUpTarget) is a topical query about the card — never greeting or
  // chitchat. "let's chat about this" with a card attached must not reach the
  // 4-turn number-call, which lacks the card context and drifts.
  // Exemption: an imperative action message is not a card reply — "send an
  // email to myself" flaked isThoughtReply (busy history) and got buried as
  // memory_retrieve. Same action-evidence rule as the follow-up guard.
  const _actionableThought = _ACTION_TASK_TYPES.has(_tc.taskType)
    && (_tc.suggestedIntent === 'command_automate'
        || _tc.targetService
        || (_tc.interactiveActions && _tc.interactiveActions.length > 0)
        || _carriedHint === 'command_automate');
  if (_tc.isThoughtReply && _tc.followUpTarget && !_hasMultiGoalConjunction && !_actionableThought) {
    const _thoughtIntent = _tc.webAccessMode === 'none' ? 'memory_retrieve' : 'web_search';
    logger.info(`[Node:DecomposePromptV2] Thought-reply guard: routing to ${_thoughtIntent} for attached card "${String(_tc.followUpTarget).slice(0, 60)}"`);
    const subPrompts = [{
      text: message,
      estimatedIntent: _thoughtIntent,
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    const durationMs = Date.now() - t0;
    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'thought-reply-guard', intent: _thoughtIntent,
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: _thoughtIntent, dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    _emitIntentDecided(state, _thoughtIntent, 0.85);
    return {
      ...state,
      _decomposedIntent: _thoughtIntent,
      _decomposedBy: 'thought-reply-guard',
      intentPlan: subPrompts,
    };
  }

  // ── Fast number-based decision (single-step intent / multi-step) ──────────
  // Call the light model with "return ONLY a single number" to get a fast verdict.
  // If 0–6 (single-step), return a single sub-prompt with that intent — skip the
  // expensive 400-token JSON generation. Only on 7 (multi-step) do we run the full
  // llmDecompose to get the subPrompts array with dependencies.
  // Note: _llmDateRange is lost on the single-step path — retrieveMemory.js has a
  // 3-layer fallback (Layer 1: _llmDateRange, Layer 2: regex parseDateRange,
  // Layer 3: LLM fallback) so this is safe.
  // ── classifyTask/number-call merge ─────────────────────────────────────────
  // classifyTask's suggestedIntent was emitted by the same call that produced
  // the typed fields — it saw the 16-turn history, semantic context, and
  // ambient refs the 5-token number call lacks. When it concurs with the
  // carried hint (or the hint abstains), it IS the decision — the second
  // classification adds flake surface, not information (observed: identical
  // prompts alternating intents across runs). A contradicting hint sends the
  // question to the number call as tiebreaker — its internal hint-veto still
  // applies there. 'multi_step' skips straight to full decomposition.
  let _fastDecision;
  const _suggestedIntent = typeof _tc.suggestedIntent === 'string' ? _tc.suggestedIntent : null;
  const _suggestedIdx = _suggestedIntent ? _SINGLE_STEP_INTENTS.indexOf(_suggestedIntent) : -1;
  if (_suggestedIntent === 'multi_step') {
    logger.info('[Node:DecomposePromptV2] classifyTask suggestedIntent=multi_step — skipping number call, running full decomposition');
    _fastDecision = 7;
  } else if (_suggestedIdx >= 0 && (!_carriedHint || _carriedHint === _suggestedIntent)) {
    logger.info(`[Node:DecomposePromptV2] classifyTask suggestedIntent=${_suggestedIntent} (hint=${_carriedHint || 'none'} — concur/abstain) — skipping number call`);
    _fastDecision = _suggestedIdx;
  } else {
    _fastDecision = await _decomposeDecision(message, llmBackend, conversationHistory, logger, _carriedHint);
  }

  // Contradiction check: command_automate is the heaviest route (plan +
  // approval + tool exec). When classifyTask already typed the message as a
  // non-action task — no named service, no interactive actions — a bare 0
  // from the five-token number call contradicts the richer typed
  // classification (observed flakes: "find me three ramen restaurants",
  // "write a haiku", "summarize what I worked on recently" all cleanly
  // returned 0 and burned plan/gate minutes). Escalate to the full
  // llmDecompose prompt, which carries the detailed PRIORITY RULES, rather
  // than trusting the digit. Note taskType itself flakes between
  // 'query'/'ambiguous' — both are non-action, so the check is on
  // membership in the ACTION set, not equality with 'query'.
  if (_fastDecision === 0 && _tc.taskType && !_ACTION_TASK_TYPES.has(_tc.taskType)
      && !_tc.targetService && !(_tc.interactiveActions && _tc.interactiveActions.length)) {
    logger.info(`[Node:DecomposePromptV2] number-call chose command_automate but taskType='${_tc.taskType}' with no action signals — escalating to full llmDecompose`);
    _fastDecision = 7;
  }

  // Mirror check: a PASSIVE pick (general_knowledge/web_search/etc.) on an
  // action-typed task is the same contradiction, flipped. "read the file
  // /tmp/x.txt" came back taskType:'local_file' but the decision path picked
  // general_knowledge → the answer hallucinated "I can't read files". A
  // passive intent on an action type means one of the two signals is wrong —
  // escalate to the full decomposer which sees the file-path/action context.
  // Corroboration required: bare taskType is itself flaky ("ramen
  // restaurants" typed local_system → the hint veto deliberately overrides
  // it). Only escalate when the message or typed fields carry independent
  // action evidence — a literal path, a named service, interactive actions,
  // or expected file output. A bare label stays a coin flip the veto owns.
  const _corroboratesAction = _tc.targetService
    || (_tc.interactiveActions && _tc.interactiveActions.length > 0)
    || _tc.expectsFileOutput
    || _tc.activeDocRef === 'file'
    || FILE_PATH_RE.test(message);
  if (_fastDecision >= 0 && _fastDecision <= 6 && _corroboratesAction
      && _ACTION_TASK_TYPES.has(_tc.taskType)
      && ['general_knowledge', 'web_search', 'screen_intelligence', 'memory_retrieve', 'memory_store', 'greeting'].includes(_SINGLE_STEP_INTENTS[_fastDecision])) {
    logger.info(`[Node:DecomposePromptV2] decision chose ${_SINGLE_STEP_INTENTS[_fastDecision]} but taskType='${_tc.taskType}' carries corroborated action evidence — escalating to full llmDecompose`);
    _fastDecision = 7;
  }

  let subPrompts;
  if (_fastDecision >= 0 && _fastDecision <= 6) {
    logger.info(`[Node:DecomposePromptV2] Fast decision: single-step ${_SINGLE_STEP_INTENTS[_fastDecision]} — skipping full decomposition`);
    subPrompts = [{
      text: message,
      estimatedIntent: _SINGLE_STEP_INTENTS[_fastDecision],
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null,
    }];
    _emitIntentDecided(state, _SINGLE_STEP_INTENTS[_fastDecision], 0.85);
    // No _llmDateRange on fast path — retrieveMemory falls back to regex + LLM
  } else {
    logger.info('[Node:DecomposePromptV2] Fast decision: MULTI_STEP — running full decomposition');
    subPrompts = await llmDecompose(message, llmBackend, conversationHistory, logger, (parsed) => {
      parsedJson = parsed; // Capture the parsed JSON
    });
  }

  // Extract _llmDateRange from the subPrompts array (attached by llmDecompose)
  let llmDateRange = null;
  if (subPrompts && subPrompts._llmDateRange) {
    llmDateRange = subPrompts._llmDateRange;
    delete subPrompts._llmDateRange; // clean up — don't let it pollute the array
  }

  // Guard: llmDecompose returns null on LLM failure or JSON parse error — pass-through
  if (!subPrompts) {
    logger.debug('[Node:DecomposePromptV2] llmDecompose returned null — pass-through');
    return state;
  }

  // Force-collapse user info queries to 1-step (backup if LLM ignores prompt instruction)
  subPrompts = collapseUserInfoQuery(subPrompts, message, logger);

  // Guard: collapseUserInfoQuery can also return null for non-array input
  if (!subPrompts) {
    logger.debug('[Node:DecomposePromptV2] collapseUserInfoQuery returned null — pass-through');
    return state;
  }

  // Deterministic conjunction split — the conjunction detector fired but the
  // LLM still merged everything into one sub-prompt (observed: "set my volume
  // to 30 percent and open apple.com" → single passthrough → det classify miss
  // on the merged text → expensive/lossy LLM plan). Split at the conjunction
  // boundary so each clause takes its own deterministic template path.
  if (_hasMultiGoalConjunction && Array.isArray(subPrompts) && subPrompts.length === 1) {
    const parts = String(message).split(/\b(?:and|then)\s+(?=(?:then\s+)?(?:open|launch|start|run|create|write|delete|remove|move|rename|copy|take|capture|grab|set|remind|schedule|send|post|tweet|email|text|message|search|find|look\s+up|check|list|show|tell|add|make|download|save|read|print|close|quit|restart|mute|shut|how|what|when|where|who|which)\b)/i)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 3);
    if (parts.length > 1) {
      const inherited = subPrompts[0] && subPrompts[0].estimatedIntent;
      logger.info(`[Node:DecomposePromptV2] Conjunction split — LLM merged ${parts.length} goals into one sub-prompt; splitting deterministically`);
      subPrompts = parts.map((text, i) => ({
        text,
        estimatedIntent: inherited || null,
        confidence: 0.7,
        order: i,
        dependsOn: [],
        isLongRunning: false,
        dataTemplate: null,
      }));
    }
  }

  // Filter out sub-prompts that are just repeats of previous user messages (catch LLM hallucinations)
  // Only filter exact matches, not partial matches, to avoid filtering legitimate platform-specific queries
  // GRACE PERIOD: Don't filter if the similar message is >5 minutes old (user likely re-asking intentionally)
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const now = Date.now();
  // Exclude the CURRENT message — comms-graph logs quick-intent turns (and
  // session.route can persist the user text) before the stategraph runs, so the
  // live prompt is already the newest user entry in history. A single-step
  // sub-prompt that equals it is a legitimate pass-through, not a duplicate.
  const _currentMsgText = String(message || '').toLowerCase().trim();
  const recentUserMessages = (conversationHistory || [])
    .filter(m => m.role === 'user')
    .slice(-3)
    .filter(m => String(m.content || '').toLowerCase().trim() !== _currentMsgText)
    .map(m => ({
      text: String(m.content || '').toLowerCase().trim(),
      timestamp: m.timestamp || m.created_at || now // fallback to now if no timestamp
    }));

  subPrompts = subPrompts.filter(sp => {
    const spText = String(sp.text || '').toLowerCase().trim();
    const isDuplicate = recentUserMessages.some(prev => {
      const textMatch = spText === prev.text;
      if (!textMatch) return false;
      // Check age - if >5 minutes old, treat as intentional re-request, not duplicate
      const ageMs = now - (new Date(prev.timestamp).getTime() || now);
      if (ageMs > FIVE_MINUTES_MS) {
        logger.debug(`[Node:DecomposePromptV2] Similar message found but >5min old (${Math.round(ageMs/1000)}s) - treating as new request`);
        return false;
      }
      return true; // Recent duplicate
    });
    if (isDuplicate) {
      logger.info(`[Node:DecomposePromptV2] Filtered duplicate sub-prompt from history: ${sp.text.slice(0, 60)}`);
    }
    return !isDuplicate;
  });
  
  const durationMs = Date.now() - t0;

  if (!subPrompts || subPrompts.length === 0) {
    // If we filtered out duplicates but had original analysis, preserve the intent
    if (parsedJson && parsedJson.subPrompts && parsedJson.subPrompts.length > 0) {
      const originalIntent = parsedJson.subPrompts[0].estimatedIntent;
      logger.debug(`[Node:DecomposePromptV2] No sub-prompts after duplicate filtering - preserving _decomposedIntent: ${originalIntent}`);
      // Create an intentPlan so the router can still execute the intent (e.g., web_search)
      return { 
        ...state, 
        _decomposedIntent: originalIntent,
        ...(llmDateRange ? { _llmDateRange: llmDateRange } : {}),
        intentPlan: [{ text: message, estimatedIntent: originalIntent, order: 0, dependsOn: [], isLongRunning: false }]
      };
    }
    logger.debug('[Node:DecomposePromptV2] No sub-prompts returned — pass-through');
    return state;
  }

  // Single sub-prompt that matches original → pass-through (no multi-intent)
  if (subPrompts.length === 1) {
    const sp = subPrompts[0];
    const singleText = sp.text.toLowerCase().trim();
    const origText   = message.toLowerCase().trim();
    const isSame     = singleText === origText || origText.includes(singleText) || singleText.includes(origText);

    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: _carriedHint,
      parser: 'llm-decompose', intent: sp.estimatedIntent,
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: sp.text, estimatedIntent: sp.estimatedIntent, dependsOn: [], isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate }],
    });

    _emitIntentDecided(state, sp.estimatedIntent, sp.confidence || 0.85);
    // Single command_automate outcome via the LLM path — still adopt a
    // force-classified plan when the prefire/call hits (classifyTask flakes
    // around the local guards must not strand a valid compiled plan).
    const _llmTmpl = sp.estimatedIntent === 'command_automate'
      ? await _classifyDeterministic(message, _tc, state.llmBackend, logger)
      : null;
    return {
      ...state,
      _decomposedIntent: sp.estimatedIntent,
      _decomposedBy: 'llm',
      ...(llmDateRange ? { _llmDateRange: llmDateRange } : {}),
      intentPlan: [sp],
      ..._detState(_llmTmpl),
    };
  }

  // Multiple sub-prompts — collapse linear CA chains. Skip the collapse when a
  // real multi-goal conjunction was detected: ParseIntentV2's own grouping
  // merges consecutive CA sub-prompts AND tries per-part deterministic
  // composition (multi-compose), which the merged single text cannot hit —
  // observed: "set volume + open apple.com" collapsed to one → sel=0 → LLM
  // plan with a bogus ask_user step.
  const collapsed = _hasMultiGoalConjunction ? subPrompts : collapseLinearCAChain(subPrompts, message, logger);

  writeDecomposeLog({
    ts: new Date().toISOString(), message, carriedHint: _carriedHint,
    parser: 'llm-decompose', intent: collapsed[0]?.estimatedIntent,
    subPromptCount: collapsed.length, durationMs,
    subPrompts: collapsed.map(sp => ({ order: sp.order, text: sp.text, estimatedIntent: sp.estimatedIntent, dependsOn: sp.dependsOn, isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate })),
  });

  logger.info(`[Node:DecomposePromptV2] LLM decomposed into ${collapsed.length} sub-prompts in ${durationMs}ms`);
  collapsed.forEach((sp, i) => logger.info(`  [${i}] "${sp.text}" → ${sp.estimatedIntent}`));

  _emitIntentDecided(state, collapsed[0]?.estimatedIntent, collapsed[0]?.confidence || 0.85);
  // Same adoption for collapsed single-step command_automate outcomes.
  const _collapsedTmpl = (collapsed.length === 1 && collapsed[0]?.estimatedIntent === 'command_automate')
    ? await _classifyDeterministic(message, _tc, state.llmBackend, logger)
    : null;
  return {
    ...state,
    _decomposedIntent: collapsed[0]?.estimatedIntent,
    _decomposedBy: 'llm',
    ...(llmDateRange ? { _llmDateRange: llmDateRange } : {}),
    intentPlan: collapsed,
    ..._detState(_collapsedTmpl),
  };
};

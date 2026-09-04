'use strict';

const fs   = require('fs');
const path = require('path');
const { parseLlmJson } = require('../utils/parseLlmJson');

const INTENT_LOG_PATH = path.join(process.cwd(), 'logs', 'intent-classifier.log');
function writeDecomposeLog(entry) {
  try { fs.appendFileSync(INTENT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); }
  catch (_) {}
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
- Valid estimatedIntent values: command_automate, screen_intelligence, web_search, memory_store, memory_retrieve, general_knowledge, greeting
- Mark isLongRunning:true ONLY for browser automation expected to take >30 seconds
- Mark dependsOn:[N] when this step requires the OUTPUT of step N
- CRITICAL: When dependsOn is non-empty, you MUST include dataTemplate with "{{result[N]}}" placeholders for each dependency index. Example: dataTemplate: "Using the result: {{result[0]}}"
- Return ONLY valid JSON — no markdown fences, no explanation
- CRITICAL: If ALL sub-prompts implement one artifact (skill, script, scheduled task), return ONE sub-prompt with the original text and estimatedIntent:'command_automate'. Only split when the user has multiple INDEPENDENT goals.
- CRITICAL: Do NOT split tasks that share data or target multiple agents/services for the SAME goal (e.g., "post on Twitter, then share the same post on Facebook and LinkedIn"). These are ONE command_automate step using the original full text — the downstream planner handles multiple agents in a single plan. Only split when sub-prompts are truly INDEPENDENT (different goals, no shared data, no "the same"/"it"/"that" references to prior steps).
- Navigation commands (goto, navigate to, open + specific site) → command_automate, NOT web_search
- Any task that involves interacting with a specific website or web service (sending, asking, navigating, posting, filling forms, etc.) → command_automate
- PRIORITY RULE - FILE/FOLDER ANALYSIS (takes precedence over user info rules): When the message starts with "[Folder:" or involves analyzing/listing/describing files/folders/images on the local filesystem (e.g., "[Folder: /path] tell me what files are here", "what are these images about", "analyze files in /path/to/folder"), use SINGLE command_automate step. This requires shell commands to list and read actual files, NOT memory_retrieve or web_search which will hallucinate.
- PRIORITY RULE - USER INFO WITH ACTION: When the request is about USER INFO (family, profile, personal data, relationships like mom/dad/wife/cousin, phone numbers, emails, addresses, contacts) AND also requires an external action (send, email, post, fill, submit, create, share), use SINGLE command_automate step. The user.agent skill retrieves the info internally.
- PRIORITY RULE - USER INFO ONLY: When the request is ONLY asking to show/list/tell/display USER INFO with NO external action (e.g. "who is my wife", "list my family", "what is my mom's phone", "tell me about my contacts"), use SINGLE memory_retrieve step. Do NOT use command_automate for pure info lookup.
- EXAMPLES OF memory_retrieve: "who is my wife" → memory_retrieve | "list all info about my family" → memory_retrieve | "what do you know about my mom" → memory_retrieve | "tell me about my contacts" → memory_retrieve | "show my saved addresses" → memory_retrieve
- EXAMPLES of command_automate (user info + action): "send my family info via email" → command_automate | "email my wife's number to John" → command_automate | "post about my mom on Facebook" → command_automate | "share my contact list" → command_automate
- PRIORITY RULE - KNOWLEDGE vs SEARCH vs ACTION (when no specific website/tool is mentioned): For general questions without browser/tool interaction: Use general_knowledge for math/calculations ("convert 88s to minutes", "what is 5*7"), timeless facts ("who wrote Pride and Prejudice"), and definitions ("what is blockchain"). Use web_search for time-sensitive info (prices, news, "latest", "current"). Use command_automate ONLY when specific website interaction, tool usage, or external action is required.
- General rule: When a request combines data retrieval with an action (e.g., "send weather info via email"), split into TWO steps: (1) retrieve the data (memory_retrieve/web_search), (2) perform the action (command_automate with dependsOn:[0]).
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
async function _decomposeDecision(message, llmBackend, conversationHistory, logger) {
  const recentCtx = (conversationHistory || []).slice(-4)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 150)}`)
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
- When in doubt → 0 (command_automate is the safest single-step default)
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

  const userPrompt = `Message: "${message}"${contextBlock}\nIntent? (0–7)`;

  try {
    const raw = await llmBackend.generateAnswer(userPrompt, {
      query: userPrompt,
      context: { systemInstructions: systemPrompt },
    }, { maxTokens: 5, temperature: 0.1, fastMode: true, taskType: 'classification' });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    const result = (num >= 0 && num <= 7) ? num : 0;
    logger.info(`[Node:DecomposePromptV2] _decomposeDecision: intent=${result} (${result < 7 ? _SINGLE_STEP_INTENTS[result] : 'MULTI_STEP'}) (raw="${(raw || '').trim()}")`);
    return result;
  } catch (e) {
    logger.warn(`[Node:DecomposePromptV2] _decomposeDecision failed: ${e.message} — defaulting to 0 (command_automate)`);
    return 0;
  }
}

async function llmDecompose(message, llmBackend, conversationHistory, logger, onParsed = null) {
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  const currentTime = now.toTimeString().split(' ')[0].substring(0, 5); // HH:MM format
  const recentCtx = (conversationHistory || []).slice(-4)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 150)}`)
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
    const subPrompts = parsed.subPrompts || parsed.sub_prompts;
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
    const KNOWN_INTENTS = ['command_automate', 'screen_intelligence', 'web_search', 'memory_store', 'memory_retrieve', 'general_knowledge', 'greeting'];
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
  const { message, llmBackend, conversationHistory } = state;
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
  const _msgLower = String(message || '').toLowerCase();
  const _MULTI_GOAL_CONJUNCTIONS = /\b(and\s+then|also|after\s+that|additionally|plus|furthermore|then\s+also)\b|;\s*[a-z]/i;
  const _hasMultiGoalConjunction = _MULTI_GOAL_CONJUNCTIONS.test(_msgLower);
  const _SINGLE_STEP_TASK_TYPES = new Set(['local_file', 'local_system', 'app_automation', 'browser']);
  if (_SINGLE_STEP_TASK_TYPES.has(_tc.taskType) && !_hasMultiGoalConjunction) {
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
      ts: new Date().toISOString(), message, carriedHint: null,
      parser: 'local-short-circuit', intent: 'command_automate',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'command_automate', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    return {
      ...state,
      _decomposedIntent: 'command_automate',
      _decomposedBy: 'local-short-circuit',
      intentPlan: subPrompts,
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
      ts: new Date().toISOString(), message, carriedHint: null,
      parser: 'local-short-circuit', intent: 'memory_retrieve',
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: message, estimatedIntent: 'memory_retrieve', dependsOn: [], isLongRunning: false, dataTemplate: null }],
    });
    return {
      ...state,
      _decomposedIntent: 'memory_retrieve',
      _decomposedBy: 'local-short-circuit',
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
  const _fastDecision = await _decomposeDecision(message, llmBackend, conversationHistory, logger);
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

  // Filter out sub-prompts that are just repeats of previous user messages (catch LLM hallucinations)
  // Only filter exact matches, not partial matches, to avoid filtering legitimate platform-specific queries
  // GRACE PERIOD: Don't filter if the similar message is >5 minutes old (user likely re-asking intentionally)
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const now = Date.now();
  const recentUserMessages = (conversationHistory || [])
    .filter(m => m.role === 'user')
    .slice(-3)
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
      ts: new Date().toISOString(), message, carriedHint: null,
      parser: 'llm-decompose', intent: sp.estimatedIntent,
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: sp.text, estimatedIntent: sp.estimatedIntent, dependsOn: [], isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate }],
    });

    return {
      ...state,
      _decomposedIntent: sp.estimatedIntent,
      _decomposedBy: 'llm',
      ...(llmDateRange ? { _llmDateRange: llmDateRange } : {}),
      intentPlan: [sp],
    };
  }

  // Multiple sub-prompts — collapse linear CA chains
  const collapsed = collapseLinearCAChain(subPrompts, message, logger);

  writeDecomposeLog({
    ts: new Date().toISOString(), message, carriedHint: null,
    parser: 'llm-decompose', intent: collapsed[0]?.estimatedIntent,
    subPromptCount: collapsed.length, durationMs,
    subPrompts: collapsed.map(sp => ({ order: sp.order, text: sp.text, estimatedIntent: sp.estimatedIntent, dependsOn: sp.dependsOn, isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate })),
  });

  logger.info(`[Node:DecomposePromptV2] LLM decomposed into ${collapsed.length} sub-prompts in ${durationMs}ms`);
  collapsed.forEach((sp, i) => logger.info(`  [${i}] "${sp.text}" → ${sp.estimatedIntent}`));

  return {
    ...state,
    _decomposedIntent: collapsed[0]?.estimatedIntent,
    _decomposedBy: 'llm',
    ...(llmDateRange ? { _llmDateRange: llmDateRange } : {}),
    intentPlan: collapsed,
  };
};

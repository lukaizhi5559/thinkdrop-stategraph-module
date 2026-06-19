'use strict';

/**
 * classifyTask — LLM-based task classifier
 *
 * Replaces all per-node NLU regex guards (BYPASS_PATTERNS, _BROWSER_SERVICES,
 * _LOCAL_ACTION_VERBS, _BROWSE_VERB_RE, _RECURRING_SIGNALS_RE, etc.) with a
 * single cached LLM call that runs once per turn inside resolveReferencesV2.
 *
 * Result is attached to state._taskClassification and read by all downstream
 * nodes instead of each node running independent regex.
 *
 * Output shape:
 * {
 *   taskType: 'local_file' | 'local_system' | 'browser' | 'messaging' | 'scheduling' | 'query' | 'ambiguous',
 *   isFollowUp: boolean,           // message references prior turn ("that folder", "it", "the result")
 *   followUpTarget: string | null, // resolved concrete value from conversation history
 *   needsClarification: boolean,   // true only when a genuinely critical piece is missing
 *   targetService: string | null,  // named external service if present
 *   isRecurring: boolean,          // recurring/scheduled task signal
 *   isBrowseOnly: boolean,         // pure navigation — no messaging/send intent
 *   requiresDOM: boolean,           // browser task needing DOM access (form fill, login, scrape)
 * }
 *
 * Fails open: any error returns a safe default that never blocks execution.
 */

const CLASSIFY_SYSTEM_PROMPT = `You are a task classifier for a desktop automation assistant.

Given the user's message and recent conversation history, classify the task.

Output ONLY valid JSON with exactly these fields:
{
  "taskType": "local_file" | "local_system" | "browser" | "messaging" | "scheduling" | "query" | "ambiguous",
  "isFollowUp": true | false,
  "followUpTarget": "<resolved concrete value>" | null,
  "needsClarification": true | false,
  "targetService": "<service name>" | null,
  "isRecurring": true | false,
  "isBrowseOnly": true | false,
  "requiresDOM": true | false,
  "isScreenFollowUp": true | false,
  "needsFreshScreen": true | false,
  "isAppUiInspection": true | false,
  "isSpatialAnalysis": true | false
}

Field rules:
- taskType:
  - "local_file": create, open, rename, move, copy, delete, generate, write, export, convert, compress, find any local file or folder
  - "local_system": interrogate or control the local machine — check uptime, disk space, memory usage, CPU, battery, network interfaces, running processes, kill a process, system stats, hardware info, environment variables, hostname, OS version, run a shell command, check what is installed, list ports, ping a host. Use this whenever the task requires executing a shell command or querying the OS rather than reading/writing a file. ALSO use "local_system" for any imperative action targeting the current screen or active app UI — e.g. highlight elements, capture screenshot, scroll the screen, annotate, show bounding boxes, monitor screen activity, take a screenshot, zoom in. These execute against the running OS/app and are NOT "query" even if the user says "on my screen" or "on this page".
  - "browser": navigate, search, open a website, go to a URL, look something up online — ONLY for web browser tasks. NOT for tasks that inspect, use, or interact with a native desktop app's UI (e.g. Slack, Figma, Zoom, Discord) — those are "local_system" or "query" even if a service name is mentioned.
  - "messaging": send email, text, SMS, Slack, Discord, notify someone
  - "scheduling": set a reminder, schedule something, recurring alarm, cron task
  - "query": question, lookup, retrieve memory, general knowledge — includes asking about or locating UI elements in a desktop app ("show me where X is in Slack", "where is the toolbar in Figma"). Use for tasks that ask to find, describe, or explain something without sending or modifying anything. NOT "query" when the task is an imperative action ON the screen (highlight, scroll, capture, monitor, annotate) — those are "local_system".
  - "ambiguous": genuinely unclear even with history

- isFollowUp: true when message contains "that folder", "it", "the file", "there", "that one", "the result", "that directory", "that script", "that code", "that python", "the previous", or any pronoun/demonstrative referring to something established in RECENT CONVERSATION

- followUpTarget: if isFollowUp is true AND recent conversation clearly shows what it refers to, provide the resolved concrete subject. This includes: a file path from a prior command, a topic/subject discussed (e.g. "Vietnam weather", "the Python script", "SpaceX stock"), a named entity, or any other concrete referent established in the conversation. Set to null only when the referent genuinely cannot be determined from history.

- needsClarification: true ONLY when a truly critical piece is missing AND conversation history does NOT resolve it:
  - WHO to send to (messaging tasks with no recipient anywhere)
  - WHICH service (when multiple equally valid options exist and user gave no hint)
  - NEVER ask about file format, content, or preferences — the system can infer those
  - NEVER ask when taskType is local_file, local_system, browser, or scheduling — these are always clear enough
  - NEVER ask when isFollowUp is true and followUpTarget is resolved

- targetService: the specific external service named (e.g. "gmail", "github", "youtube"). null for local tasks.

- isRecurring: true for "every day", "daily", "weekly", "remind me every", "alarm", "recurring", "each morning"

- isBrowseOnly: true when taskType is "browser" AND there is no send/message/notify intent

- isAppUiInspection: true when taskType is "query" AND the task is specifically asking to locate, find, show, or identify a UI element WITHIN a named desktop app (e.g. "show me where the message input area is in Slack", "where is the toolbar in Figma", "find the send button in Discord", "locate the settings panel in Notion", "point me to the search bar in Slack"). These require app.agent to capture and analyze that specific app's screen. false for all other cases, including passive screen observations ("what's on my screen") and general knowledge questions.

- isSpatialAnalysis: true when the task is asking to identify, analyze, map, or describe the SPATIAL LAYOUT, REGIONS, or SECTIONS of the screen — such as headers, sidebars, footers, content areas, grid layout, bounding boxes, or UI zones. These require app.agent analyze_spatial_grid to return structured coordinate data, NOT plain OCR. Examples: "what regions are on my screen" → true | "what sections can you see" → true | "describe the screen layout" → true | "what areas are visible" → true | "show me the screen grid" → true | "what UI zones are present" → true. DISTINCTION: "what is ON my screen" (passive read of content) → false. "what REGIONS/SECTIONS/LAYOUT structure does my screen have" (spatial tool call) → true. false for all passive screen observation queries ("what app am I in", "what's on my screen", "read what's visible").

- requiresDOM: true when taskType is "browser" AND the task requires precise DOM-level interaction that keyboard shortcuts cannot do reliably:
  form fill, login/authentication/OAuth, structured data scraping, file upload via browser input, clicking specific page elements by selector, multi-step page flows (e.g. click button → wait → fill → submit).
  false for: navigate to URL, open new tab, scroll page, copy page content, find on page, back/forward, reload — all achievable via keyboard shortcuts.
  NEVER true for tasks that ask to visually locate, identify, or describe a UI element in a desktop app (e.g. "show me where the input area is in Slack", "find the toolbar in Figma") — those use screen capture/OCR, not DOM access. Always false when taskType is not "browser".
  NEVER true when the PRIMARY action is a GhostLayer screen highlight (e.g. "highlight [term]", "highlight all text", "show boundaries", "clear highlights", "highlight the term X and type Y") — these are handled entirely by app.agent using LiteParser + nutJS, not DOM access. Secondary words like "type", "input field", or "click" do not change this when highlighting is the leading intent.

- isScreenFollowUp: true when ALL of the following hold:
  1. A PRIOR SCREEN CONTEXT block is present in the prompt (see below)
  2. The user message refers to something on screen using a deictic ("this", "it", "that") OR asks for info/explanation without naming a new specific topic
  3. The message does NOT start a clearly unrelated new topic (e.g. "search for X", "open Y", "remind me to Z")
  4. The RECENT CONVERSATION does NOT contain a clear named topic that the message is more likely referring to (e.g. a country, city, person, product, service, website). If conversation history has an established subject and the message is a short follow-up ("check for me now", "what about that?", "do it"), set isScreenFollowUp:false — the follow-up is to the conversation, not the screen.
  Set false when no PRIOR SCREEN CONTEXT is present.

- needsFreshScreen: true when ALL of the following hold:
  1. isScreenFollowUp is false (no prior context block available)
  2. followUpTarget is null (referent NOT resolved from conversation history)
  3. isFollowUp is true (message uses deictic terms or refers to something from context without naming it) OR taskType is "ambiguous"
  This means: the user is referring to something they see on screen, but we have no cached screen data — we need to grab it.
  Set false when isScreenFollowUp is already true (we already have context), or when followUpTarget is already resolved from conversation history, or when the message has a concrete named subject.

No explanation. No markdown. Only the JSON object.`;

/**
 * Classify the user's task using the LLM.
 *
 * @param {string} userMessage
 * @param {Array}  conversationHistory — last N turns from resolveReferencesV2
 * @param {object} llmBackend — generateAnswer interface
 * @param {object} logger
 * @returns {Promise<object>} classification object (always resolves, never throws)
 */
async function classifyTask(userMessage, conversationHistory, llmBackend, logger, priorScreenSummary) {
  const _default = {
    taskType: 'ambiguous',
    isFollowUp: false,
    followUpTarget: null,
    needsClarification: false,
    targetService: null,
    isRecurring: false,
    isBrowseOnly: false,
    requiresDOM: false,
    isScreenFollowUp: false,
    needsFreshScreen: false,
    isAppUiInspection: false,
    isSpatialAnalysis: false,
  };

  if (!llmBackend || !userMessage) return _default;

  try {
    const recentCtx = (conversationHistory || []).slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 300)}`)
      .join('\n');

    const screenBlock = priorScreenSummary ? `\n\n${priorScreenSummary}` : '';
    const prompt = `RECENT CONVERSATION:\n${recentCtx || '(none)'}${screenBlock}\n\nCURRENT USER MESSAGE: "${userMessage}"`;

    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: CLASSIFY_SYSTEM_PROMPT },
    }, { maxTokens: 120, temperature: 0, fastMode: true });

    const text = typeof raw === 'string' ? raw : (raw?.text || raw?.content || '');
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*?\}/) || stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.debug('[classifyTask] No JSON in response — using default');
      return _default;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      taskType:            parsed.taskType           || _default.taskType,
      isFollowUp:          !!parsed.isFollowUp,
      followUpTarget:      parsed.followUpTarget      || null,
      needsClarification:  !!parsed.needsClarification,
      targetService:       parsed.targetService       || null,
      isRecurring:         !!parsed.isRecurring,
      isBrowseOnly:        !!parsed.isBrowseOnly,
      requiresDOM:         !!parsed.requiresDOM,
      isScreenFollowUp:    !!parsed.isScreenFollowUp,
      needsFreshScreen:    !!parsed.needsFreshScreen,
      isAppUiInspection:   !!parsed.isAppUiInspection,
      isSpatialAnalysis:   !!parsed.isSpatialAnalysis,
    };
  } catch (err) {
    logger.debug(`[classifyTask] Failed (non-fatal): ${err.message} — using default`);
    return _default;
  }
}

module.exports = { classifyTask };

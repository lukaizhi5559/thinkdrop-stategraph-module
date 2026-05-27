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
  "isScreenFollowUp": true | false,
  "needsFreshScreen": true | false
}

Field rules:
- taskType:
  - "local_file": create, open, rename, move, copy, delete, generate, write, export, convert, compress, find any local file or folder
  - "local_system": interrogate or control the local machine — check uptime, disk space, memory usage, CPU, battery, network interfaces, running processes, kill a process, system stats, hardware info, environment variables, hostname, OS version, run a shell command, check what is installed, list ports, ping a host. Use this whenever the task requires executing a shell command or querying the OS rather than reading/writing a file.
  - "browser": navigate, search, open a website, go to a URL, look something up online
  - "messaging": send email, text, SMS, Slack, Discord, notify someone
  - "scheduling": set a reminder, schedule something, recurring alarm, cron task
  - "query": question, lookup, retrieve memory, general knowledge — use ONLY for pure knowledge questions that do NOT require executing anything on the local machine
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
    isScreenFollowUp: false,
    needsFreshScreen: false,
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
      taskType:           parsed.taskType           || _default.taskType,
      isFollowUp:         !!parsed.isFollowUp,
      followUpTarget:     parsed.followUpTarget      || null,
      needsClarification: !!parsed.needsClarification,
      targetService:      parsed.targetService       || null,
      isRecurring:        !!parsed.isRecurring,
      isBrowseOnly:       !!parsed.isBrowseOnly,
      isScreenFollowUp:   !!parsed.isScreenFollowUp,
      needsFreshScreen:   !!parsed.needsFreshScreen,
    };
  } catch (err) {
    logger.debug(`[classifyTask] Failed (non-fatal): ${err.message} — using default`);
    return _default;
  }
}

module.exports = { classifyTask };

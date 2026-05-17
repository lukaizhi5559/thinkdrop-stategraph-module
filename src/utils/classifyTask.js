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
 *   taskType: 'local_file' | 'browser' | 'messaging' | 'scheduling' | 'query' | 'ambiguous',
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
  "taskType": "local_file" | "browser" | "messaging" | "scheduling" | "query" | "ambiguous",
  "isFollowUp": true | false,
  "followUpTarget": "<resolved concrete value>" | null,
  "needsClarification": true | false,
  "targetService": "<service name>" | null,
  "isRecurring": true | false,
  "isBrowseOnly": true | false
}

Field rules:
- taskType:
  - "local_file": create, open, rename, move, copy, delete, generate, write, export, convert, compress, find any local file or folder
  - "browser": navigate, search, open a website, go to a URL, look something up online
  - "messaging": send email, text, SMS, Slack, Discord, notify someone
  - "scheduling": set a reminder, schedule something, recurring alarm, cron task
  - "query": question, lookup, retrieve memory, general knowledge
  - "ambiguous": genuinely unclear even with history

- isFollowUp: true when message contains "that folder", "it", "the file", "there", "that one", "the result", "that directory", or any pronoun/demonstrative referring to something established in RECENT CONVERSATION

- followUpTarget: if isFollowUp is true AND recent conversation clearly shows what it refers to (e.g. a path from a prior mv/mkdir/rename command), provide the resolved value. Otherwise null.

- needsClarification: true ONLY when a truly critical piece is missing AND conversation history does NOT resolve it:
  - WHO to send to (messaging tasks with no recipient anywhere)
  - WHICH service (when multiple equally valid options exist and user gave no hint)
  - NEVER ask about file format, content, or preferences — the system can infer those
  - NEVER ask when taskType is local_file, browser, or scheduling — these are always clear enough
  - NEVER ask when isFollowUp is true and followUpTarget is resolved

- targetService: the specific external service named (e.g. "gmail", "github", "youtube"). null for local tasks.

- isRecurring: true for "every day", "daily", "weekly", "remind me every", "alarm", "recurring", "each morning"

- isBrowseOnly: true when taskType is "browser" AND there is no send/message/notify intent

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
async function classifyTask(userMessage, conversationHistory, llmBackend, logger) {
  const _default = {
    taskType: 'ambiguous',
    isFollowUp: false,
    followUpTarget: null,
    needsClarification: false,
    targetService: null,
    isRecurring: false,
    isBrowseOnly: false,
  };

  if (!llmBackend || !userMessage) return _default;

  try {
    const recentCtx = (conversationHistory || []).slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 300)}`)
      .join('\n');

    const prompt = `RECENT CONVERSATION:\n${recentCtx || '(none)'}\n\nCURRENT USER MESSAGE: "${userMessage}"`;

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
    };
  } catch (err) {
    logger.debug(`[classifyTask] Failed (non-fatal): ${err.message} — using default`);
    return _default;
  }
}

module.exports = { classifyTask };

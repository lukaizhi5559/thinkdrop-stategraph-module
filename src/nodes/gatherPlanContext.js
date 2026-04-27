/**
 * gatherPlanContext.js — StateGraph node
 *
 * Sits between resolveUserContext → planSkills.
 * For ambiguous command_automate requests, asks the user 1–3 targeted clarifying
 * questions BEFORE the LLM planner runs. This prevents wasted planning cycles on
 * under-specified tasks (missing recipient, service, schedule, etc.).
 *
 * Flow:
 *   1. Skip if not command_automate, already complete, or bypass flag set.
 *   2. Call LLM: "Is this task clear enough? If not, what is the one most important question?"
 *   3. LLM says complete  → enrich resolvedMessage, set planGatheringComplete=true → planSkills
 *   4. LLM says question  → set pendingQuestion._isGatherPlanQuestion → logConversation (pause)
 *   5. On resume: answer merged into planGatheringAnswers → loop back to step 2 (max 3 rounds)
 *
 * State inputs:
 *   state.intent.type            — must be 'command_automate' to activate
 *   state.message                — original user request
 *   state.resolvedMessage        — entity-resolved request
 *   state.planGatheringRound     — how many questions asked so far (0 on first entry)
 *   state.planGatheringAnswers   — [{question, answer}] from prior rounds
 *   state._bypassGatherPlan      — if true, skip entirely (user said "just do it")
 *
 * State outputs:
 *   state.planGatheringComplete  — true when ready for planSkills
 *   state.planGatheringSkipped   — true when node was a no-op
 *   state.planGatheringRound     — incremented each Q&A round
 *   state.planGatheringAnswers   — accumulated answers (unchanged here; answer appended by main.js)
 *   state.resolvedMessage        — enriched with gathered answers when complete
 *   state.pendingQuestion        — { question, _isGatherPlanQuestion } when waiting for user
 *   state.answer                 — question text (displayed to user via logConversation)
 */

'use strict';

const MAX_ROUNDS = 3;

// ── Bypass detection ──────────────────────────────────────────────────────────

const BYPASS_PATTERNS = [
  /\bjust do it\b/i,
  /\bskip[. ]*questions?\b/i,
  /\bjust.*proceed\b/i,
  /\bjust.*go ahead\b/i,
  /\bjust.*run\b/i,
  /\bno questions?\b/i,
  /\bdon'?t ask\b/i,
  /\bskip.*clarif/i,
];

function _wantsToBypass(msg) {
  return BYPASS_PATTERNS.some(re => re.test(msg));
}

// ── LLM system prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a task clarity assistant for a desktop automation system.

Analyze the user's automation request and determine if it contains enough information to execute.

Respond with ONLY valid JSON in exactly one of these two shapes:
{"complete": true}
{"complete": false, "question": "<one concise clarifying question>"}

CRITICAL CONTEXT:
You will see TWO pieces of information:
1. ORIGINAL USER REQUEST — the full multi-step automation the user wants
2. CURRENT SUB-TASK — the specific step being analyzed right now

Rules:
- ONLY ask questions about the CURRENT SUB-TASK, not the overall request.
- Return {"complete": true} if the sub-task is specific enough to act on as-is.
- Return {"complete": false, "question": "..."} ONLY when a truly critical piece is missing FOR THIS SPECIFIC STEP:
  * WHO to send to (only if THIS step involves messaging without a recipient)
  * WHICH service/app (only if THIS step needs it and multiple options exist)
  * WHAT schedule/time (only if THIS step implies scheduling)
- Do NOT ask about information that exists in OTHER steps of the overall request.
- Do NOT ask about credentials, optional preferences, or things the system can infer.
- Do NOT ask if the information is already present in the CURRENT SUB-TASK.
- Keep the question under 15 words.
- Ask only one question — never combine two into one.

CRITICAL ANTI-HALLUCINATION RULES — these override everything else:
- "where to find X", "where can I find X", "where to buy X", "where to get X" = a SEARCH intent. NEVER interpret these as needing a message recipient. Return {"complete": true}.
- If the task mentions a specific website or service by name (chatgpt, gemini, google, youtube, reddit, amazon, venice ai, etc.) the service is already specified — do NOT ask "which service".
- Navigate / browse / look up / search / find / check tasks on a named site NEVER need a recipient. Only tasks that explicitly say "send", "text me", "email me", or "message" need a recipient.
- If the task is "go to <site> and search/look up/find <topic>", return {"complete": true} immediately — no question needed.
- "where to find them/it" after a search request refers to physical or online locations for the searched item — it is part of the search query, NOT a recipient field.`;

// ── LLM call ──────────────────────────────────────────────────────────────────

async function _askLLM(llmBackend, userMessage, originalMessage, priorQA, logger) {
  const priorContext = priorQA.length > 0
    ? '\n\nPrior clarifications:\n' + priorQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')
    : '';

  const prompt = `ORIGINAL USER REQUEST: "${originalMessage}"

CURRENT SUB-TASK: "${userMessage}"${priorContext}

This is ONE STEP of a multi-step automation. Does THIS SPECIFIC SUB-TASK need clarification, or is it clear enough to execute?

Is this specific sub-task complete enough to automate without further clarification?`;

  try {
    const raw = await llmBackend.generateAnswer(SYSTEM_PROMPT, prompt, { maxTokens: 80, temperature: 0 });
    const text = (typeof raw === 'string' ? raw : raw?.text || raw?.content || '').trim();

    // Strip optional markdown code fence (```json ... ``` or ``` ... ```)
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // Try non-greedy match first, then greedy fallback to catch multi-line objects
    const jsonMatch = stripped.match(/\{[\s\S]*?\}/) || stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[Node:GatherPlanContext] No JSON found in LLM response: "${text.slice(0, 120)}" — treating as complete`);
      return { complete: true };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.complete !== 'boolean') throw new Error('missing "complete" key');
    return parsed;
  } catch (err) {
    logger.warn(`[Node:GatherPlanContext] LLM call failed (${err.message}) — passing through`);
    return { complete: true }; // fail-open: never block on LLM error
  }
}

// ── Main node ─────────────────────────────────────────────────────────────────

module.exports = async function gatherPlanContext(state) {
  const logger = state.logger || console;
  const { intent, message, resolvedMessage, llmBackend } = state;
  const progressCallback = state.progressCallback || null;

  // ── Skip: wrong intent ───────────────────────────────────────────────────────
  if (intent?.type !== 'command_automate') {
    return { ...state, planGatheringSkipped: true };
  }

  // ── Skip: already completed in a prior round ─────────────────────────────────
  if (state.planGatheringComplete) {
    return { ...state };
  }

  // ── Skip: bridge listener / cron source — action is pre-specified, not ambiguous ──
  if (state.context?.source === 'bridge_listener' || state.context?.source === 'bridge_startup') {
    logger.info('[Node:GatherPlanContext] Bridge source — skipping clarification');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  const userMsg = resolvedMessage || message || '';
  // Get original full message for context — this is the complete user request before decomposition
  const originalMsg = state.originalMessage || state.message || userMsg;

  // ── Skip: user asked to bypass ───────────────────────────────────────────────
  if (state._bypassGatherPlan || _wantsToBypass(userMsg)) {
    logger.info('[Node:GatherPlanContext] Bypass detected — passing through to planSkills');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: false };
  }

  // ── Skip: self-contained browser task (named service + browse verb) ───────────
  // These tasks are always fully specified — no LLM call needed, no false questions.
  const _BROWSER_SERVICES = /\b(chatgpt|gemini|google|bing|youtube|reddit|twitter|x\.com|instagram|facebook|linkedin|amazon|walmart|target|netflix|spotify|github|notion|slack|discord|venice\s*ai|perplexity|claude|copilot|openai|ebay|etsy|pinterest|tiktok|wikipedia)\b/i;
  const _BROWSE_VERBS     = /\b(go\s+to|goto|open|navigate|look\s+up|search|find|browse|check|visit|look\s+on|search\s+on|search\s+for|look\s+for)\b/i;
  if (_BROWSER_SERVICES.test(userMsg) && _BROWSE_VERBS.test(userMsg)) {
    logger.info(`[Node:GatherPlanContext] Self-contained browser task — skipping clarification for: "${userMsg.slice(0, 80)}"`);
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  // ── Skip: no LLM backend ─────────────────────────────────────────────────────
  if (!llmBackend) {
    logger.warn('[Node:GatherPlanContext] No llmBackend available — skipping');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  const priorAnswers = Array.isArray(state.planGatheringAnswers) ? state.planGatheringAnswers : [];
  const currentRound = typeof state.planGatheringRound === 'number' ? state.planGatheringRound : 0;

  // ── Skip: max rounds reached ─────────────────────────────────────────────────
  if (currentRound >= MAX_ROUNDS) {
    logger.info(`[Node:GatherPlanContext] Max rounds (${MAX_ROUNDS}) reached — passing through`);
    return { ...state, planGatheringComplete: true };
  }

  // ── LLM clarity check ─────────────────────────────────────────────────────────
  if (progressCallback) {
    progressCallback({ type: 'thinking', message: 'Checking task details…' });
  }
  logger.info(`[Node:GatherPlanContext] Round ${currentRound + 1}/${MAX_ROUNDS} — checking task clarity for: "${userMsg.slice(0, 80)}"`);

  const result = await _askLLM(llmBackend, userMsg, originalMsg, priorAnswers, logger);

  // ── Task is clear — enrich resolvedMessage with any gathered context and proceed ──
  if (result.complete) {
    let enriched = resolvedMessage || message || '';
    if (priorAnswers.length > 0) {
      const contextLines = priorAnswers.map(qa => `${qa.question}: ${qa.answer}`).join('; ');
      enriched = `${enriched}\n[Additional context: ${contextLines}]`;
      logger.info(`[Node:GatherPlanContext] Complete — enriched resolvedMessage with ${priorAnswers.length} answer(s)`);
    } else {
      logger.info('[Node:GatherPlanContext] Task is already fully specified — passing through');
    }
    return {
      ...state,
      resolvedMessage: enriched,
      planGatheringComplete: true,
      planGatheringRound: currentRound,
      // Clear gather resume flags — task is complete
      _gatherQuestionPending: false,
      _pendingIntent: undefined,
    };
  }

  // ── Ask clarifying question ───────────────────────────────────────────────────
  const question = result.question || 'Could you provide more details about this task?';
  logger.info(`[Node:GatherPlanContext] Asking Q${currentRound + 1}: "${question}"`);

  if (progressCallback) {
    progressCallback({ type: 'ask_user', question, source: 'gatherPlanContext' });
  }

  return {
    ...state,
    planGatheringRound: currentRound + 1,
    planGatheringAnswers: priorAnswers,
    planGatheringComplete: false,
    answer: question,           // displayed to user via logConversation → UI
    pendingQuestion: {
      question,
      _isGatherPlanQuestion: true,
      source: 'gatherPlanContext',
    },
    // NEW: Flags to signal this is a gather answer awaiting response
    _gatherQuestionPending: true,
    _pendingIntent: state.intent,
  };
};

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

Rules:
- Return {"complete": true} if the request is specific enough to act on as-is.
- Return {"complete": false, "question": "..."} ONLY when a truly critical piece is missing:
  * WHO to send to (when the task involves messaging someone without naming a recipient)
  * WHICH service/app (when multiple equally-valid services exist and the choice matters)
  * WHAT schedule/time (when recurring is implied but no interval is stated)
- Do NOT ask about credentials, optional preferences, or things the system can infer or look up.
- Do NOT ask if the information is already present in the message, even loosely stated.
- Keep the question under 15 words.
- Ask only one question — never combine two into one.`;

// ── LLM call ──────────────────────────────────────────────────────────────────

async function _askLLM(llmBackend, userMessage, priorQA, logger) {
  const priorContext = priorQA.length > 0
    ? '\n\nPrior clarifications:\n' + priorQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')
    : '';

  const prompt = `User request: "${userMessage}"${priorContext}

Is this request complete enough to automate without further clarification?`;

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

  // ── Skip: user asked to bypass ───────────────────────────────────────────────
  if (state._bypassGatherPlan || _wantsToBypass(userMsg)) {
    logger.info('[Node:GatherPlanContext] Bypass detected — passing through to planSkills');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: false };
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

  const result = await _askLLM(llmBackend, userMsg, priorAnswers, logger);

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
  };
};

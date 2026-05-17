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
 *   4. LLM says question  → emit ask_user via progressCallback, await answer inline via
 *      gatherAnswerCallback (graph stays alive — no pause/resume needed)
 *   5. Answer merged into planGatheringAnswers → loop back to step 2 (max 3 rounds)
 *
 * State inputs:
 *   state.intent.type            — must be 'command_automate' to activate
 *   state.message                — original user request
 *   state.resolvedMessage        — entity-resolved request
 *   state.gatherAnswerCallback   — async fn(question) that awaits user reply inline
 *   state._bypassGatherPlan      — if true, skip entirely (user said "just do it")
 *
 * State outputs:
 *   state.planGatheringComplete  — true when ready for planSkills (always set on exit)
 *   state.planGatheringSkipped   — true when node was a no-op
 *   state.planGatheringRound     — final round count
 *   state.planGatheringAnswers   — accumulated [{question, answer}] pairs
 *   state.resolvedMessage        — enriched with gathered answers when complete
 */

'use strict';

const MAX_ROUNDS = 3;

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
- "where to find them/it" after a search request refers to physical or online locations for the searched item — it is part of the search query, NOT a recipient field.
- EXTRACTION/RESEARCH TASKS: If the task specifies a website + topic + action (extract/get/find/download/save/export), it is COMPLETE. Examples that need NO clarification:
  * "get top 3 basketball players from wikipedia" — COMPLETE (site: wikipedia, topic: basketball players, action: get)
  * "extract information from wikipedia and save to file" — COMPLETE (site: wikipedia, action: extract + save)
  * "find the best restaurants from yelp and save" — COMPLETE (site: yelp, topic: best restaurants, action: find + save)
  * "download the report from [site]" — COMPLETE (site specified, action: download)
  * "get data from [site] and write to desktop" — COMPLETE (site + action + destination specified)
- NEVER ask "which items" or "what specific data" for extraction tasks — the LLM planner can determine that from the site content. Return {"complete": true} for all extraction tasks with a specified site.`;

// ── LLM call ──────────────────────────────────────────────────────────────────

async function _askLLM(llmBackend, userMessage, originalMessage, priorQA, conversationHistory, logger) {
  const priorContext = priorQA.length > 0
    ? '\n\nPrior clarifications:\n' + priorQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')
    : '';

  const recentCtx = (conversationHistory || []).slice(-4)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 200)}`)
    .join('\n');
  const historyBlock = recentCtx
    ? `\n\nRECENT CONVERSATION (resolve all references — "that folder", "it", "the result" — from this before deciding):\n${recentCtx}`
    : '';

  const prompt = `ORIGINAL USER REQUEST: "${originalMessage}"

CURRENT SUB-TASK: "${userMessage}"${priorContext}${historyBlock}

This is ONE STEP of a multi-step automation. Does THIS SPECIFIC SUB-TASK need clarification, or is it clear enough to execute?

If the RECENT CONVERSATION shows what "that", "it", "the folder", "the file" etc. refer to, the task IS complete — do NOT ask.

Is this specific sub-task complete enough to automate without further clarification?`;

  try {
    const raw = await llmBackend.generateAnswer(prompt, { query: prompt, context: { systemInstructions: SYSTEM_PROMPT } }, { maxTokens: 80, temperature: 0 });
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

  // ── Skip: plan correction mode — user is refining an existing plan ──────────
  if (state._planCorrectionMode) {
    logger.info('[Node:GatherPlanContext] Plan correction mode — skipping clarification');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  // ── Skip: pre-built skill plan (post-approval) — plan already decided ──────
  if (state._skillPlan) {
    logger.info('[Node:GatherPlanContext] _skillPlan pre-built — skipping clarification');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  // ── Skip: user asked to bypass ───────────────────────────────────────────────
  if (state._bypassGatherPlan) {
    logger.info('[Node:GatherPlanContext] Bypass flag set — passing through to planSkills');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: false };
  }

  // ── Read LLM task classification (set by resolveReferencesV2) ────────────────
  // Replaces all NLU regex guards — the LLM understands intent, task type, and
  // cross-turn references without a hardcoded word list.
  const tc = state._taskClassification || {};

  // ── Skip: classifier says no clarification needed ────────────────────────────
  // Covers: browser tasks, local file tasks, scheduling, bypass phrases, follow-ups
  if (tc.needsClarification === false && tc.taskType !== 'ambiguous') {
    const reason = tc.taskType === 'browser' ? 'browser task'
      : tc.taskType === 'local_file' ? 'local file task'
      : tc.taskType === 'scheduling' ? 'scheduling task'
      : tc.taskType === 'messaging' && tc.targetService ? 'messaging task with service'
      : tc.taskType === 'query' ? 'query task'
      : 'classifier: no clarification needed';
    logger.info(`[Node:GatherPlanContext] ${reason} — skipping clarification for: "${userMsg.slice(0, 80)}"`);

    // ── Inline follow-up resolution: inject resolved target into resolvedMessage ──
    // When the user says "that folder" / "it" / "the file", the classifier resolves
    // followUpTarget from conversation history. Inject it so planSkills has the
    // concrete value without asking the user.
    let enrichedMsg = resolvedMessage || message || '';
    if (tc.isFollowUp && tc.followUpTarget) {
      enrichedMsg = `${enrichedMsg}\n\n(Context from prior turn: ${tc.followUpTarget})`;
      logger.info(`[Node:GatherPlanContext] Follow-up resolved: "${tc.followUpTarget}"`);
    }

    return {
      ...state,
      resolvedMessage: enrichedMsg,
      planGatheringComplete: true,
      planGatheringSkipped: true,
    };
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

  // ── Follow-up resolution via classifier (fallback for ambiguous tasks) ─────────
  // If the classifier resolved a follow-up target, inject it before entering the
  // Q&A loop — the LLM clarity check may still mark this complete once it sees it.
  let userMsg_enriched = userMsg;
  if (tc.isFollowUp && tc.followUpTarget) {
    userMsg_enriched = `${userMsg}\n\n(Context from prior turn: ${tc.followUpTarget})`;
    logger.info(`[Node:GatherPlanContext] Follow-up target injected for ambiguous task: "${tc.followUpTarget}"`);
  }

  // ── Inline await Q&A loop ────────────────────────────────────────────────────
  // Uses gatherAnswerCallback to wait for user input inline (graph stays alive).
  // This eliminates the fragile pause/resume semantic classifier that misclassified
  // short answers like "by name" as fresh tasks.
  const gatherAnswerCallback = state.gatherAnswerCallback || null;
  const answers = [...priorAnswers];
  let round = currentRound;

  while (round < MAX_ROUNDS) {
    if (progressCallback) {
      progressCallback({ type: 'thinking', message: 'Checking task details…' });
    }
    logger.info(`[Node:GatherPlanContext] Round ${round + 1}/${MAX_ROUNDS} — checking task clarity for: "${userMsg_enriched.slice(0, 80)}"`);

    const result = await _askLLM(llmBackend, userMsg_enriched, originalMsg, answers, state.conversationHistory || [], logger);

    // ── Task is clear — done ──────────────────────────────────────────────────
    if (result.complete) {
      let enriched = resolvedMessage || message || '';
      if (answers.length > 0) {
        const contextLines = answers.map(qa => `${qa.question}: ${qa.answer}`).join('; ');
        enriched = `${enriched}\n[Additional context: ${contextLines}]`;
        logger.info(`[Node:GatherPlanContext] Complete — enriched resolvedMessage with ${answers.length} answer(s)`);
      } else {
        logger.info('[Node:GatherPlanContext] Task is already fully specified — passing through');
      }
      return {
        ...state,
        resolvedMessage: enriched,
        planGatheringComplete: true,
        planGatheringRound: round,
        planGatheringAnswers: answers,
      };
    }

    // ── Ask clarifying question inline ────────────────────────────────────────
    const question = result.question || 'Could you provide more details about this task?';
    logger.info(`[Node:GatherPlanContext] Asking Q${round + 1}: "${question}"`);

    if (progressCallback) {
      progressCallback({ type: 'ask_user', question, source: 'gatherPlanContext' });
    }

    // If no callback available, bail out — cannot gather inline
    if (!gatherAnswerCallback) {
      logger.warn('[Node:GatherPlanContext] No gatherAnswerCallback — cannot gather inline, passing through');
      return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
    }

    // Await user answer inline — graph stays alive
    try {
      const answer = await gatherAnswerCallback(question);
      if (answer) {
        answers.push({ question, answer });
        logger.info(`[Node:GatherPlanContext] Answer received for Q${round + 1}: "${String(answer).slice(0, 80)}"`);
      } else {
        // Timeout or null answer — proceed with what we have
        logger.warn(`[Node:GatherPlanContext] No answer received for Q${round + 1} — proceeding without`);
        break;
      }
    } catch (err) {
      logger.warn(`[Node:GatherPlanContext] gatherAnswerCallback threw: ${err.message} — proceeding`);
      break;
    }

    round++;
  }

  // ── Exited loop (max rounds or break) — proceed with gathered context ───────
  let enriched = resolvedMessage || message || '';
  if (answers.length > 0) {
    const contextLines = answers.map(qa => `${qa.question}: ${qa.answer}`).join('; ');
    enriched = `${enriched}\n[Additional context: ${contextLines}]`;
  }
  return {
    ...state,
    resolvedMessage: enriched,
    planGatheringComplete: true,
    planGatheringRound: round,
    planGatheringAnswers: answers,
  };
};

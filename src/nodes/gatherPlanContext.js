/**
 * gatherPlanContext.js — StateGraph node
 *
 * Sits between resolveUserContext → preflightAgents → planSkills.
 * For command_automate requests, asks the LLM one question: "Is anything critical
 * missing to execute this task?" If yes, asks the user inline (max 3 rounds).
 *
 * Design principle: delegate fully to the LLM. No classifier short-circuits,
 * no taskType-based skips, no regex guards. The LLM sees the request + known
 * facts + recent conversation and decides if it's ready to execute.
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

const { markAgentAuthed } = require('./preflightAgents');
const { formatHistoryTurns } = require('../utils/formatHistoryTurns');

const MAX_ROUNDS = 3;
const MAX_AUTH_ROUNDS = 10; // auth sign-ins don't count against Q&A budget

// ── Grill-Me Phase B: batched question constants ─────────────────────────────
const GRILL_MAX_ROUNDS = 5;
const GRILL_MODE = process.env.THINKDROP_GRILL_MODE === '1';

const SYSTEM_PROMPT = `You are a task readiness checker for a desktop automation system.

Given a user's request and what is already known, decide if the task is ready to execute — or if one critical piece of information is missing.

Respond with ONLY valid JSON in exactly one of these three shapes:
{"complete": true}
{"complete": false, "question": "<one concise question, 15 words max>"}
{"complete": false, "question": "<one concise question, 15 words max>", "authAgentId": "<agentId from UNAUTHENTICATED AGENTS>"}

Rules:
- Return {"complete": true} if the task can proceed as-is.
- Return {"complete": false, "question": "..."} ONLY when a single critical piece is missing:
  * Messaging tasks with NO named provider — ask which service (gmail, outlook, sendgrid, etc.)
  * Messaging tasks with NO recipient — ask for the address/number
  * Scheduling tasks with NO time or frequency specified
- NEVER ask about: timezone, credentials, optional preferences, or things the system can look up.
- NEVER ask "which service" if the user already named one (gmail, slack, twilio, mailgun, etc.).
- Browse / search / find / extract / navigate / look up tasks → always {"complete": true}.
- Extraction tasks with a named site + topic → always {"complete": true}.
- If KNOWN FACTS already answer what's missing → {"complete": true}.
- If RECENT CONVERSATION resolves any pronoun ("it", "that folder", "the file") → {"complete": true}.
- Ask only one question. Never combine two into one.
- CRITICAL AUTH RULE: If the task requires a service AND that service's agent appears in UNAUTHENTICATED AGENTS below (marked [NEEDS AUTH]), return {"complete": false, "question": "<service> requires sign-in. Sign in to <service>, or use a different provider?", "authAgentId": "<the exact agentId from the list e.g. gmail.agent>"}.
- If a required service is NOT listed under UNAUTHENTICATED AGENTS, you MUST return {"complete": true} and proceed — do NOT ask about sign-in, credentials, or authentication.
- When authAgentId is set, the system will show a dedicated sign-in button — keep the question short (under 12 words).`;

async function _askLLM(llmBackend, userMsg, originalMsg, priorQA, conversationHistory, resolvedSelfContext, preflightResult, logger, taskClassification = null) {
  const priorBlock = priorQA.length > 0
    ? '\n\nPrior clarifications:\n' + priorQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')
    : '';

  const isFollowUp = !!(taskClassification?.isFollowUp);
  const recentCtx = formatHistoryTurns(conversationHistory || [], { isFollowUp, maxTurns: 6 });
  const historyBlock = recentCtx
    ? `\n\nRECENT CONVERSATION (resolve pronouns from this before deciding):\n${recentCtx}`
    : '';

  const knownLines = [];
  if (resolvedSelfContext) {
    if (resolvedSelfContext.email) knownLines.push('- User email: already resolved');
    if (resolvedSelfContext.phone) knownLines.push('- User phone: already resolved');
    const memCtx = resolvedSelfContext.memories?.context || [];
    if (memCtx.length > 0) knownLines.push(`- User memory: ${memCtx.length} facts available`);
  }
  const knownBlock = knownLines.length > 0
    ? `\n\nKNOWN FACTS (do NOT ask about these):\n${knownLines.join('\n')}`
    : '';

  // Inject unauthenticated agents from preflightResult so the LLM can block on auth before planning
  const unauthedAgents = (preflightResult?.agents || [])
    .filter(a => a.authed === false && (a.type === 'browser' || a.type === 'cli'))
    .map(a => `- ${a.agentId} [NEEDS AUTH]`);
  const unauthedBlock = unauthedAgents.length > 0
    ? `\n\nUNAUTHENTICATED AGENTS (require sign-in before they can execute tasks):\n${unauthedAgents.join('\n')}`
    : '\n\nUNAUTHENTICATED AGENTS: none — all required services are authenticated or do not require auth.';

  logger.info(`[Node:GatherPlanContext] preflightResult.agents=${JSON.stringify(preflightResult?.agents?.map(a => ({ agentId: a.agentId, type: a.type, authed: a.authed })) || [])} | unauthedAgents=${JSON.stringify(unauthedAgents)}`);

  const tc = resolvedSelfContext?._taskClassification || {};
  const followUpTarget = tc.isFollowUp && !tc.isScreenFollowUp ? tc.followUpTarget : null;
  const followUpBlock = followUpTarget
    ? `\n\n(Context from prior turn: ${followUpTarget})`
    : '';

  const prompt = `REQUEST: "${originalMsg}"
TASK: "${userMsg}"${followUpBlock}${priorBlock}${historyBlock}${knownBlock}${unauthedBlock}

Is this task ready to execute, or is one critical piece missing?`;

  try {
    const raw = await llmBackend.generateAnswer(prompt, { query: prompt, context: { systemInstructions: SYSTEM_PROMPT } }, { maxTokens: 80, temperature: 0, taskType: 'classification' });
    const text = (typeof raw === 'string' ? raw : raw?.text || raw?.content || '').trim();
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*?\}/) || stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[Node:GatherPlanContext] No JSON in LLM response: "${text.slice(0, 100)}" — treating as complete`);
      return { complete: true };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.complete !== 'boolean') throw new Error('missing "complete" key');
    return parsed;
  } catch (err) {
    logger.warn(`[Node:GatherPlanContext] LLM call failed (${err.message}) — passing through`);
    return { complete: true };
  }
}

module.exports = async function gatherPlanContext(state) {
  const logger = state.logger || console;
  const { intent, message, resolvedMessage, llmBackend } = state;
  const progressCallback = state.progressCallback || null;

  // ── Skip: wrong intent ───────────────────────────────────────────────────────
  if (intent?.type !== 'command_automate') {
    return { ...state, planGatheringSkipped: true };
  }

  // ── Skip: already completed ───────────────────────────────────────────────────
  if (state.planGatheringComplete) return { ...state };

  // ── Skip: bridge / cron source — action is pre-specified ────────────────────
  if (state.context?.source === 'bridge_listener' || state.context?.source === 'bridge_startup') {
    logger.info('[Node:GatherPlanContext] Bridge source — skipping clarification');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  // ── Skip: plan correction / pre-built plan / bypass ──────────────────────────
  if (state._planCorrectionMode) {
    logger.info('[Node:GatherPlanContext] Plan correction mode — skipping clarification');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }
  if (state._skillPlan) {
    logger.info('[Node:GatherPlanContext] _skillPlan pre-built — skipping clarification');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }
  if (state._bypassGatherPlan) {
    logger.info('[Node:GatherPlanContext] Bypass flag — passing through to planSkills');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: false };
  }

  // ── Skip: no LLM backend ─────────────────────────────────────────────────────
  if (!llmBackend) {
    logger.warn('[Node:GatherPlanContext] No llmBackend — skipping');
    return { ...state, planGatheringComplete: true, planGatheringSkipped: true };
  }

  // ── Grill-Me Phase B: batched questioning path ──────────────────────────────
  // When THINKDROP_GRILL_MODE=1, use the new memory-first batched Q&A loop
  // instead of the legacy single-question loop. Falls back to legacy if the
  // grill loop fails for any reason.
  if (GRILL_MODE) {
    try {
      logger.info('[Node:GatherPlanContext] Grill-Me mode enabled — running batched Q&A loop');
      return await _runGrillLoop(state, logger);
    } catch (grillErr) {
      logger.warn(`[Node:GatherPlanContext] Grill-Me loop failed (${grillErr.message}) — falling back to legacy loop`);
      // Fall through to legacy loop
    }
  }

  // ── Inject follow-up target into resolvedMessage for downstream nodes ────────
  const tc = state._taskClassification || {};
  let baseMsg = resolvedMessage || message || '';
  if (tc.isFollowUp && tc.followUpTarget && !tc.isScreenFollowUp) {
    baseMsg = `${baseMsg}\n\n(Context from prior turn: ${tc.followUpTarget})`;
    logger.info(`[Node:GatherPlanContext] Follow-up target injected: "${tc.followUpTarget}"`);
  }

  const originalMsg = state.originalMessage || state.message || baseMsg;
  const priorAnswers = Array.isArray(state.planGatheringAnswers) ? state.planGatheringAnswers : [];
  const currentRound = typeof state.planGatheringRound === 'number' ? state.planGatheringRound : 0;
  const gatherAnswerCallback = state.gatherAnswerCallback || null;
  const answers = [...priorAnswers];
  let round = currentRound;
  let authRound = 0; // separate counter — auth sign-ins don't consume Q&A rounds

  // ── Inline Q&A loop (max MAX_ROUNDS) ─────────────────────────────────────────
  while (round < MAX_ROUNDS) {
    if (progressCallback) progressCallback({ type: 'thinking', message: 'Checking task details…' });
    logger.info(`[Node:GatherPlanContext] Round ${round + 1}/${MAX_ROUNDS} — checking clarity for: "${baseMsg.slice(0, 80)}"`);

    const result = await _askLLM(llmBackend, baseMsg, originalMsg, answers, state.conversationHistory || [], state.resolvedSelfContext || null, state.preflightResult || null, logger, state._taskClassification || null);

    // Defensive override: if the LLM returned an auth question for an agent that
    // preflight already marked as authed, treat the task as complete. This prevents
    // repeated sign-in prompts after the user has already authenticated.
    if (!result.complete && (result.authAgentId || result.question)) {
      const _agents = state.preflightResult?.agents || [];
      const _mentionedId = (result.authAgentId || '').replace('.agent', '').toLowerCase();
      const _questionLower = (result.question || '').toLowerCase();

      // Does the question reference any agent that is actually unauthed?
      const _matchingUnauthedAgent = _agents.find(a =>
        a.authed === false &&
        (a.type === 'browser' || a.type === 'cli') &&
        (
          a.agentId.replace('.agent', '').toLowerCase() === _mentionedId ||
          _questionLower.includes(a.agentId.replace('.agent', '').toLowerCase())
        )
      );

      // If no matching unauthed agent exists, the LLM is hallucinating an auth requirement
      if (!_matchingUnauthedAgent) {
        logger.warn(`[Node:GatherPlanContext] LLM asked auth question for ${result.authAgentId || result.question}, but no matching unauthed agent in preflight — overriding to complete=true`);
        result.complete = true;
      }
    }

    if (result.complete) {
      let enriched = baseMsg;
      if (answers.length > 0) {
        enriched = `${enriched}\n[Additional context: ${answers.map(qa => `${qa.question}: ${qa.answer}`).join('; ')}]`;
        logger.info(`[Node:GatherPlanContext] Complete — enriched with ${answers.length} answer(s)`);
      } else {
        logger.info('[Node:GatherPlanContext] Task fully specified — passing through');
      }
      return { ...state, resolvedMessage: enriched, planGatheringComplete: true, planGatheringRound: round, planGatheringAnswers: answers };
    }

    const question = result.question || 'Could you provide more details about this task?';
    logger.info(`[Node:GatherPlanContext] Asking Q${round + 1}: "${question}"`);

    // ── Auth-action card: if LLM returned authAgentId, match against preflightResult
    // and emit gather_auth_action instead of a plain text question so the UI can
    // show actionable sign-in / open-agents-tab buttons.
    const _authAgentId = result.authAgentId || null;
    const _agents = state.preflightResult?.agents || [];
    // Normalize both sides — strip .agent suffix so "gmail" matches "gmail.agent" and vice versa
    const _normalizedAuthId = (_authAgentId || '').replace('.agent', '').toLowerCase();
    const _unauthedAgent = _normalizedAuthId
      ? _agents.find(a => a.agentId.replace('.agent', '').toLowerCase() === _normalizedAuthId && a.authed === false)
      : _agents.find(a => a.authed === false && (a.type === 'browser' || a.type === 'cli') &&
          question.toLowerCase().includes(a.agentId.replace('.agent', '').toLowerCase()));

    if (_unauthedAgent && progressCallback) {
      const _authType = _unauthedAgent.type === 'cli' ? 'cli_token' : (_unauthedAgent.sessionStale ? 'browser_reauth' : 'browser_oauth');
      const _actions = _unauthedAgent.type === 'browser'
        ? [
            { label: `Sign in to ${_unauthedAgent.agentId.replace('.agent', '')}`, value: 'auth_browser', primary: true },
            { label: 'Use a different service', value: 'use_api', primary: false },
          ]
        : [
            { label: 'Open Agents tab to add credentials', value: 'open_agents_tab', primary: true },
            { label: 'Use a different service', value: 'use_api', primary: false },
          ];
      logger.info(`[Node:GatherPlanContext] Auth-action card for ${_unauthedAgent.agentId} (${_authType})`);
      if (progressCallback) progressCallback({
        type: 'gather_auth_action',
        question,
        agentId: _unauthedAgent.agentId,
        agentType: _unauthedAgent.type,
        authType: _authType,
        iconUrl: _unauthedAgent.iconUrl || null,
        startUrl: _unauthedAgent.startUrl || null,
        actions: _actions,
        source: 'gatherPlanContext',
      });
    } else {
      if (progressCallback) progressCallback({ type: 'ask_user', question, source: 'gatherPlanContext' });
    }

    if (!gatherAnswerCallback) {
      logger.warn('[Node:GatherPlanContext] No gatherAnswerCallback — passing through');
      return { ...state, resolvedMessage: baseMsg, planGatheringComplete: true, planGatheringSkipped: true };
    }

    try {
      const answer = await gatherAnswerCallback(question);
      if (answer === 'authenticated') {
        // User completed sign-in — mark only this specific agent as authed so the next
        // LLM round no longer sees it in UNAUTHENTICATED AGENTS. Other agents remain
        // unauthed and will each get their own sequential prompt.
        const agentLabel = _unauthedAgent?.agentId?.replace('.agent', '') || 'the service';
        logger.info(`[Node:GatherPlanContext] Auth completed for ${agentLabel} (authRound ${authRound + 1}) — re-checking task readiness`);
        if (state.preflightResult?.agents && _unauthedAgent) {
          const idx = state.preflightResult.agents.findIndex(
            a => a.agentId.toLowerCase() === _unauthedAgent.agentId.toLowerCase()
          );
          if (idx >= 0) state.preflightResult.agents[idx] = { ...state.preflightResult.agents[idx], authed: true };
        }
        // Persist auth in preflight's session-level cache so subsequent StateGraph runs
        // (e.g. follow-up prompts) don't re-trigger the sign-in card.
        if (_unauthedAgent) markAgentAuthed(_unauthedAgent.agentId);
        // Inject into priorQA so LLM sees explicit auth confirmation next round
        answers.push({ question, answer: `authenticated — ${agentLabel} is now signed in` });
        if (progressCallback) progressCallback({ type: 'gather_answer_received' });
        authRound++;
        if (authRound >= MAX_AUTH_ROUNDS) break; // safety ceiling
        // Do NOT increment round — auth doesn't count against Q&A budget
        continue;
      } else if (answer) {
        answers.push({ question, answer });
        logger.info(`[Node:GatherPlanContext] Answer Q${round + 1}: "${String(answer).slice(0, 80)}"`);
        if (progressCallback) progressCallback({ type: 'gather_answer_received' });
      } else {
        logger.warn(`[Node:GatherPlanContext] No answer for Q${round + 1} — proceeding`);
        break;
      }
    } catch (err) {
      logger.warn(`[Node:GatherPlanContext] gatherAnswerCallback threw: ${err.message} — proceeding`);
      break;
    }
    round++;
  }

  let enriched = baseMsg;
  if (answers.length > 0) {
    enriched = `${enriched}\n[Additional context: ${answers.map(qa => `${qa.question}: ${qa.answer}`).join('; ')}]`;
  }
  return { ...state, resolvedMessage: enriched, planGatheringComplete: true, planGatheringRound: round, planGatheringAnswers: answers };
};

// ─────────────────────────────────────────────────────────────────────────────
// Grill-Me Phase B: memory-first batched questioning
// ─────────────────────────────────────────────────────────────────────────────

const GRILL_SYSTEM_PROMPT = `You are a task readiness griller for a desktop automation system.

Your job: given a user's request, what's already known (memory, probes, route decision), and prior clarifications, generate the FRONTIER of questions — every question whose prerequisites are already settled. Don't ask questions that depend on answers you haven't heard yet.

Respond with ONLY valid JSON in exactly this shape:
{
  "complete": false,
  "requiredInputs": [
    { "name": "<input_slot>", "why": "<why needed>", "memoryQuery": "<search query for user-memory>" }
  ],
  "questions": [
    {
      "id": "q1",
      "text": "<question text, 15 words max>",
      "type": "confirm" | "text" | "choice",
      "options": [{ "label": "<short>", "value": "<value>", "primary": true|false, "description": "<optional>" }],
      "freeText": true|false,
      "memoryResolved": true|false,
      "memoryText": "<factual statement to store in memory if user confirms>",
      "memoryTextTemplate": "<factual statement with {answer} placeholder, for free-text questions>"
    }
  ],
  "routeConfirmation": {
    "service": "<service name>",
    "route": "<route from ROUTE DECISION>",
    "reason": "<human-readable reason>",
    "question": "<confirmation question, 12 words max>"
  }
}
OR: {"complete": true} when everything is resolved.

Rules:
- ALWAYS include routeConfirmation if a ROUTE DECISION is provided and hasn't been confirmed yet.
- ALWAYS include at least one question on round 1 — never return complete:true on the first round.
- For each requiredInput, the system has already run memoryQuery and attached results in MEMORY RESULTS. If memory found enough data, set memoryResolved:true and ask a CONFIRMATION question (e.g. "I found N songs in your memory. Use these?"). If memory found nothing or too little, ask a from-scratch question.
- CONFIRMATION questions (memoryResolved:true OR type "confirm") MUST have at least 2 options OR set freeText:true. Always give the user a way to accept the suggested value AND a way to reject or type a different value. For example: [{ "label": "Yes", "value": "<suggested value>", "primary": true }, { "label": "No, use different", "value": "use_different" }] with "freeText": true.
- BATCH AGGRESSIVELY: Ask ALL questions you need answered in ONE batch — even if some answers might influence other questions' context. The user can answer them all at once. Do NOT split related questions across multiple rounds.
- Questions about the same topic (e.g., playlist name, genre, artists, songs) MUST be in the same batch — never ask them one at a time.
- Only defer a question to a later round if it TRULY cannot be asked without a prior answer (e.g., "Which specific album by [artist]?" when you don't know the artist yet). Even then, prefer asking "Which artist and album?" as one question.
- NEVER ask about things the system can look up (timezone, credentials, installed apps, auth status — these are in PROBE RESULTS).
- NEVER ask about things already answered in PRIOR CLARIFICATIONS. Every entry in PRIOR CLARIFICATIONS is a SETTLED answer — do NOT re-ask it, even with different wording.
- If a PRIOR CLARIFICATION answer starts with "yes —", it is a CONFIRMED answer — do NOT ask that question again.
- If the ROUTE DECISION block is empty or all routes are marked [CONFIRMED], do NOT include a routeConfirmation. Confirmed routes are locked in.
- If ALL required inputs have been answered in PRIOR CLARIFICATIONS and all routes are confirmed, return {"complete": true}.
- Questions should be concise (15 words max). Options should be short labels.
- memoryText/memoryTextTemplate: a clean factual statement for future memory storage. Example: "User's preferred Spotify playlist name is '{answer}'". This will be stored as type 'gather_clarification' so future tasks can find it.
- Max 5 questions per batch.`;

/**
 * Phase B1: Search user-memory for each required input slot.
 * @param {array} requiredInputs - [{ name, memoryQuery }] from the LLM
 * @param {object} mcpAdapter
 * @param {string} userId
 * @param {object} logger
 * @returns {Promise<object>} { slotName: { found: number, snippets: string[] } }
 */
async function _resolveTaskInputsFromMemory(requiredInputs, mcpAdapter, userId, logger) {
  if (!requiredInputs || requiredInputs.length === 0) return {};
  const results = {};
  await Promise.all(requiredInputs.map(async (input) => {
    if (!input.memoryQuery) {
      results[input.name] = { found: 0, snippets: [] };
      return;
    }
    try {
      const res = await mcpAdapter.callService('user-memory', 'memory.search', {
        query: input.memoryQuery,
        userId,
        limit: 10,
        filters: {},
      }).catch(() => null);
      const data = res?.data || res;
      const hits = Array.isArray(data?.results) ? data.results : [];
      const snippets = hits.slice(0, 5).map(h => h.text || h.content || '').filter(t => t.length > 5);
      results[input.name] = { found: snippets.length, snippets };
      logger.info(`[Node:GatherPlanContext:Grill] Memory search for "${input.memoryQuery}" → ${snippets.length} hits`);
    } catch (e) {
      results[input.name] = { found: 0, snippets: [] };
      logger.debug(`[Node:GatherPlanContext:Grill] Memory search failed for "${input.memoryQuery}": ${e.message}`);
    }
  }));
  return results;
}

/**
 * Phase B2: Ask the LLM to generate a batch of questions (the frontier).
 */
async function _askLLMBatch(llmBackend, userMsg, originalMsg, priorQA, conversationHistory, resolvedSelfContext, preflightResult, routeDecision, memoryResults, logger, taskClassification) {
  const priorBlock = priorQA.length > 0
    ? '\n\nPRIOR CLARIFICATIONS:\n' + priorQA.map(qa => {
        const displayAnswer = qa.confirmed ? `yes — ${qa.answer}` : qa.answer;
        return `Q: ${qa.question}\nA: ${displayAnswer}`;
      }).join('\n')
    : '';

  const isFollowUp = !!(taskClassification?.isFollowUp);
  const recentCtx = formatHistoryTurns(conversationHistory || [], { isFollowUp, maxTurns: 6 });
  const historyBlock = recentCtx ? `\n\nRECENT CONVERSATION:\n${recentCtx}` : '';

  // Route decision block — show both pending (need user confirmation) and
  // confirmed routes so the LLM knows which routes are locked in and doesn't
  // re-generate routeConfirmation questions for them.
  const unconfirmedRoutes = routeDecision
    ? Object.entries(routeDecision).filter(([_, rd]) => !rd.confirmed)
    : [];
  const confirmedRoutes = routeDecision
    ? Object.entries(routeDecision).filter(([_, rd]) => rd.confirmed)
    : [];
  const routeBlock = (unconfirmedRoutes.length > 0 || confirmedRoutes.length > 0)
    ? '\n\nROUTE DECISION (from preflight probes — confirmed routes are locked in, do NOT re-confirm them):\n' +
      unconfirmedRoutes.map(([svc, rd]) =>
        `- ${svc}: route=${rd.route}, reason="${rd.reason}" [PENDING — confirm with user]`
      ).join('\n') +
      (unconfirmedRoutes.length > 0 && confirmedRoutes.length > 0 ? '\n' : '') +
      confirmedRoutes.map(([svc, rd]) =>
        `- ${svc}: route=${rd.route}, reason="${rd.reason}" [CONFIRMED]`
      ).join('\n')
    : '';

  // Memory results block
  const memoryBlock = memoryResults && Object.keys(memoryResults).length > 0
    ? '\n\nMEMORY RESULTS (already searched — use these, don\'t re-ask):\n' +
      Object.entries(memoryResults).map(([slot, mr]) =>
        `- ${slot}: ${mr.found} hit(s)${mr.snippets.length > 0 ? ` — ${mr.snippets.slice(0, 3).join(' | ').slice(0, 200)}` : ''}`
      ).join('\n')
    : '';

  // Unauthed agents (for auth questions)
  const unauthedAgents = (preflightResult?.agents || [])
    .filter(a => a.authed === false && (a.type === 'browser' || a.type === 'cli'))
    .map(a => `- ${a.agentId} [NEEDS AUTH]`);
  const unauthedBlock = unauthedAgents.length > 0
    ? `\n\nUNAUTHENTICATED AGENTS:\n${unauthedAgents.join('\n')}`
    : '';

  const prompt = `REQUEST: "${originalMsg}"
TASK: "${userMsg}"${priorBlock}${historyBlock}${routeBlock}${memoryBlock}${unauthedBlock}

Generate the frontier of questions for this task.`;

  try {
    const raw = await llmBackend.generateAnswer(prompt, { query: prompt, context: { systemInstructions: GRILL_SYSTEM_PROMPT } }, { maxTokens: 600, temperature: 0, taskType: 'super-heavy' });
    const text = (typeof raw === 'string' ? raw : raw?.text || raw?.content || '').trim();
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[Node:GatherPlanContext:Grill] No JSON in LLM response: "${text.slice(0, 100)}" — treating as complete`);
      return { complete: true };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.complete !== 'boolean' && !parsed.questions) throw new Error('invalid response shape');
    return parsed;
  } catch (err) {
    logger.warn(`[Node:GatherPlanContext:Grill] LLM call failed (${err.message}) — passing through`);
    return { complete: true };
  }
}

/**
 * Phase B5: Record gather answers to user-memory as clean factual statements.
 * Fire-and-forget — doesn't block planning.
 */
async function _recordGatherAnswersToMemory(questions, answers, mcpAdapter, userId, logger) {
  if (!questions || !answers || !mcpAdapter) return;
  for (const q of questions) {
    let answer = answers[q.id];
    if (answer == null) continue;
    // Coerce to string — answers may arrive as numbers/booleans from the UI
    // and .startsWith would throw TypeError on non-strings.
    answer = String(answer).trim();
    if (!answer || answer.startsWith('route_')) continue; // skip route confirmations
    let memoryText = q.memoryText || q.memoryTextTemplate;
    if (!memoryText) continue;
    if (memoryText.includes('{answer}')) {
      memoryText = memoryText.replace(/\{answer\}/g, answer);
    }
    // If memoryText is a fixed statement (confirm questions), only store if user confirmed
    const _confirmValue = q.options?.[0]?.value != null ? String(q.options[0].value) : '';
    if (q.memoryText && answer !== _confirmValue) continue;
    try {
      await mcpAdapter.callService('user-memory', 'memory.store', {
        text: memoryText,
        type: 'gather_clarification',
        userId,
        tags: ['gather', 'clarification'],
      }).catch(() => {});
      logger.info(`[Node:GatherPlanContext:Grill] Recorded to memory: "${memoryText.slice(0, 80)}"`);
    } catch (e) {
      logger.debug(`[Node:GatherPlanContext:Grill] memory.store failed: ${e.message}`);
    }
  }
}

/**
 * Phase B3: Run the batched Q&A loop (grill mode).
 */
async function _runGrillLoop(state, logger) {
  const { intent, message, resolvedMessage, llmBackend, mcpAdapter } = state;
  const progressCallback = state.progressCallback || null;
  const gatherAnswerCallback = state.gatherAnswerCallback || null;
  const userId = state.context?.userId || 'local_user';

  const tc = state._taskClassification || {};
  let baseMsg = resolvedMessage || message || '';
  if (tc.isFollowUp && tc.followUpTarget && !tc.isScreenFollowUp) {
    baseMsg = `${baseMsg}\n\n(Context from prior turn: ${tc.followUpTarget})`;
  }
  const originalMsg = state.originalMessage || state.message || baseMsg;
  const priorAnswers = Array.isArray(state.planGatheringAnswers) ? state.planGatheringAnswers : [];
  const answers = [...priorAnswers];
  const routeDecision = state.routeDecision || state.preflightResult?.routeDecision || {};
  let round = 0;
  let batchCounter = 0;
  let memoryResults = {}; // populated on round 0, used to substitute confirmation answers

  while (round < GRILL_MAX_ROUNDS) {
    if (progressCallback) progressCallback({ type: 'gathering', message: 'Checking task details…' });
    logger.info(`[Node:GatherPlanContext:Grill] Round ${round + 1}/${GRILL_MAX_ROUNDS} — checking clarity for: "${baseMsg.slice(0, 80)}"`);

    // B2: Ask LLM for the frontier of questions
    const result = await _askLLMBatch(
      llmBackend, baseMsg, originalMsg, answers,
      state.conversationHistory || [], state.resolvedSelfContext || null,
      state.preflightResult || null, routeDecision, null,
      logger, tc
    );

    if (result.complete) {
      logger.info('[Node:GatherPlanContext:Grill] Task fully specified — passing through');
      break;
    }

    // B1: Resolve required inputs from memory (first round only)
    // Keep memoryResults accessible throughout the loop so we can substitute
    // confirmation answers ("yes") with the actual memory data.
    if (round === 0 && result.requiredInputs && mcpAdapter) {
      memoryResults = await _resolveTaskInputsFromMemory(result.requiredInputs, mcpAdapter, userId, logger);
      // Re-ask with memory results so the LLM can generate memory-informed questions
      const resultWithMemory = await _askLLMBatch(
        llmBackend, baseMsg, originalMsg, answers,
        state.conversationHistory || [], state.resolvedSelfContext || null,
        state.preflightResult || null, routeDecision, memoryResults,
        logger, tc
      );
      if (!resultWithMemory.complete) {
        Object.assign(result, resultWithMemory);
      }
    }

    const questions = result.questions || [];
    let routeConfirmation = result.routeConfirmation || null;

    // Fix B: Strip routeConfirmation if all routes are already confirmed.
    // The LLM may still emit a routeConfirmation even though the route is
    // marked [CONFIRMED] in the prompt — don't trust it, check the code state.
    if (routeConfirmation) {
      const _unconfirmed = routeDecision
        ? Object.entries(routeDecision).filter(([_, rd]) => !rd.confirmed)
        : [];
      if (_unconfirmed.length === 0) {
        logger.info('[Node:GatherPlanContext:Grill] All routes confirmed — stripping LLM routeConfirmation');
        routeConfirmation = null;
      }
    }

    // Fix C: Force complete if there are no new questions to ask and no
    // unconfirmed routes. The LLM may keep generating questions that were
    // already answered — check if any question is truly new (not already in
    // prior answers by text similarity).
    if (questions.length > 0 && answers.length > 0) {
      const _newQuestions = questions.filter(q => {
        // A question is "new" if its text doesn't match any already-answered question
        const _qText = (q.text || '').toLowerCase().trim();
        return !answers.some(a => {
          const _aText = (a.question || '').toLowerCase().trim();
          // Match by exact text or by shared keywords (>60% word overlap)
          if (_qText === _aText) return true;
          const _qWords = new Set(_qText.split(/\s+/).filter(w => w.length > 3));
          const _aWords = new Set(_aText.split(/\s+/).filter(w => w.length > 3));
          if (_qWords.size === 0 || _aWords.size === 0) return false;
          let _overlap = 0;
          for (const w of _qWords) if (_aWords.has(w)) _overlap++;
          return _overlap / Math.min(_qWords.size, _aWords.size) > 0.6;
        });
      });
      if (_newQuestions.length === 0 && !routeConfirmation) {
        logger.info(`[Node:GatherPlanContext:Grill] All ${questions.length} LLM question(s) already answered — forcing complete`);
        break;
      }
      if (_newQuestions.length === 0 && routeConfirmation) {
        // Only the route confirmation is new — keep it, drop the duplicate questions
        logger.info(`[Node:GatherPlanContext:Grill] Dropping ${questions.length} duplicate question(s), keeping route confirmation`);
        questions.length = 0;
      }
    }

    if (questions.length === 0 && !routeConfirmation) {
      logger.info('[Node:GatherPlanContext:Grill] No questions to ask — complete');
      break;
    }

    // Emit batch to UI via gatherAnswerCallback (batch mode)
    if (!gatherAnswerCallback) {
      logger.warn('[Node:GatherPlanContext:Grill] No gatherAnswerCallback — passing through');
      break;
    }

    const batchId = `grill_${Date.now()}_${batchCounter++}`;
    logger.info(`[Node:GatherPlanContext:Grill] Asking batch ${batchId}: ${questions.length} question(s)${routeConfirmation ? ' + route confirmation' : ''}`);

    try {
      const batchAnswers = await gatherAnswerCallback({
        batch: true,
        batchId,
        questions,
        routeConfirmation,
      });

      if (!batchAnswers || Object.keys(batchAnswers).length === 0) {
        logger.warn('[Node:GatherPlanContext:Grill] Empty batch answers — proceeding');
        break;
      }

      // Process answers
      for (const q of questions) {
        let ans = batchAnswers[q.id];
        if (ans) {
          // B4: If this is a memory-resolved confirmation question and the user
          // confirmed, substitute the actual memory data instead of storing "yes"
          // as the answer. Keep the original answer for the LLM's prior
          // clarifications so it sees a clear "yes" and stops re-asking.
          //
          // Confirmation is detected when:
          //   - The answer matches the primary option's value (the "Yes, use this"
          //     button), OR
          //   - The answer text starts with yes/use_found/use_/confirm/accept/true
          let confirmed = false;
          if (q.memoryResolved) {
            const _primaryOpt = q.options?.find(o => o.primary) || q.options?.[0];
            const _primaryValue = _primaryOpt?.value;
            const _primaryMatch = _primaryValue != null && String(ans).trim() === String(_primaryValue).trim();
            const _yesMatch = /^(yes|use_found|use_|confirm|accept|true)/i.test(String(ans));
            if (_primaryMatch || _yesMatch) {
              confirmed = true;
              // Prefer memoryText (fixed factual statement with the value embedded),
              // fall back to joining memory snippets for the matching slot.
              if (q.memoryText) {
                ans = q.memoryText;
              } else if (q.memorySlot && memoryResults[q.memorySlot]?.snippets?.length > 0) {
                ans = memoryResults[q.memorySlot].snippets.join('; ');
              }
              logger.info(`[Node:GatherPlanContext:Grill] Memory-resolved ${q.id} — substituted actual value (confirmed via ${_primaryMatch ? 'primary option' : 'yes-match'})`);
            }
          }
          // Any non-empty answer is a settled answer — tell the next LLM round
          // not to re-ask it. The prompt shows "yes — <answer>" for confirmed answers.
          if (ans && String(ans).trim() !== '') {
            confirmed = true;
          }
          answers.push({ question: q.text, answer: ans, confirmed });
          logger.info(`[Node:GatherPlanContext:Grill] Answer ${q.id}: "${String(ans).slice(0, 80)}"${confirmed ? ' [confirmed]' : ''}`);
        }
      }

      // Handle route confirmation
      if (routeConfirmation && batchAnswers['__route__']) {
        const routeAns = batchAnswers['__route__'];
        if (routeAns.startsWith('route_reject:')) {
          const svc = routeAns.split(':')[1];
          logger.info(`[Node:GatherPlanContext:Grill] User rejected ${svc} route=${routeConfirmation.route} — will re-probe`);
          // Mark route as rejected — future rounds won't re-confirm this route
          if (routeDecision[svc]) {
            routeDecision[svc] = { ...routeDecision[svc], route: 'rejected_by_user' };
          }
          answers.push({ question: routeConfirmation.question, answer: 'rejected — user wants different route' });
        } else {
          // Mark this route as confirmed in routeDecision so it stops appearing
          // in the ROUTE DECISION block on future rounds.
          const svc = routeConfirmation.service;
          if (svc && routeDecision[svc]) {
            routeDecision[svc] = { ...routeDecision[svc], confirmed: true };
          }
          answers.push({ question: routeConfirmation.question, answer: routeConfirmation.route, confirmed: true });
        }
      }

      // B5: Record answers to memory (fire-and-forget)
      if (mcpAdapter) {
        _recordGatherAnswersToMemory(questions, batchAnswers, mcpAdapter, userId, logger).catch(e => {
          logger.warn(`[Node:GatherPlanContext:Grill] _recordGatherAnswersToMemory failed: ${e.message}`);
        });
      }

      if (progressCallback) progressCallback({ type: 'gather_answer_received' });
    } catch (err) {
      logger.warn(`[Node:GatherPlanContext:Grill] Batch callback threw: ${err.message} — proceeding`);
      break;
    }

    round++;
  }

  // B6: Enrich resolvedMessage
  let enriched = baseMsg;
  const enrichmentParts = [];
  if (Object.keys(routeDecision).length > 0) {
    const routeParts = Object.entries(routeDecision)
      .filter(([_, rd]) => rd.route && rd.route !== 'rejected_by_user')
      .map(([svc, rd]) => `${svc}: ${rd.route}`);
    if (routeParts.length > 0) enrichmentParts.push(`Route: ${routeParts.join(', ')}`);
  }
  if (answers.length > 0) {
    enrichmentParts.push(answers.map(qa => `${qa.question}: ${qa.answer}`).join('; '));
  }
  if (enrichmentParts.length > 0) {
    enriched = `${enriched}\n[Additional context: ${enrichmentParts.join('; ')}]`;
  }

  return {
    ...state,
    resolvedMessage: enriched,
    planGatheringComplete: true,
    planGatheringRound: round,
    planGatheringAnswers: answers,
    routeDecision,
  };
}

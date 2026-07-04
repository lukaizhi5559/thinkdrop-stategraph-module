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

const MAX_ROUNDS = 3;
const MAX_AUTH_ROUNDS = 10; // auth sign-ins don't count against Q&A budget

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
- CRITICAL AUTH RULE: If the task requires a service AND that service's agent appears in UNAUTHENTICATED AGENTS below (marked [NEEDS AUTH]), return {"complete": false, "question": "<service> requires sign-in. Sign in to <service>, or use a different provider?", "authAgentId": "<the exact agentId from the list e.g. gmail.agent>"} — NEVER assume it can run silently.
- When authAgentId is set, the system will show a dedicated sign-in button — keep the question short (under 12 words).`;

async function _askLLM(llmBackend, userMsg, originalMsg, priorQA, conversationHistory, resolvedSelfContext, preflightResult, logger) {
  const priorBlock = priorQA.length > 0
    ? '\n\nPrior clarifications:\n' + priorQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')
    : '';

  const recentCtx = (conversationHistory || []).slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 300)}`)
    .join('\n');
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
    : '';

  const tc = resolvedSelfContext?._taskClassification || {};
  const followUpTarget = tc.isFollowUp && !tc.isScreenFollowUp ? tc.followUpTarget : null;
  const followUpBlock = followUpTarget
    ? `\n\n(Context from prior turn: ${followUpTarget})`
    : '';

  const prompt = `REQUEST: "${originalMsg}"
TASK: "${userMsg}"${followUpBlock}${priorBlock}${historyBlock}${knownBlock}${unauthedBlock}

Is this task ready to execute, or is one critical piece missing?`;

  try {
    const raw = await llmBackend.generateAnswer(prompt, { query: prompt, context: { systemInstructions: SYSTEM_PROMPT } }, { maxTokens: 80, temperature: 0 });
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

    const result = await _askLLM(llmBackend, baseMsg, originalMsg, answers, state.conversationHistory || [], state.resolvedSelfContext || null, state.preflightResult || null, logger);

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

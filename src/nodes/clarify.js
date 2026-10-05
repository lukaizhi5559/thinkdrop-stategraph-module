'use strict';

/**
 * clarify.js — pre-routing clarification gate
 *
 * Sits between resolveReferences → decomposePrompt. When classifyTask's
 * resolution contract says 'needs_clarification' — the message is genuinely
 * unresolved (a bare ack with no referent, a card reply the classifier
 * couldn't attach, a hedged vague turn) — the pipeline asks the user instead
 * of guessing. It reuses the existing grill batch surface
 * (gatherAnswerCallback batch mode → gather:question_batch card UI), so
 * clarification works for ANY intent — not just command_automate slot-filling.
 *
 * On answers: merges them into resolvedMessage and re-runs classifyTask once,
 * so the clarified meaning flows through the normal classification contract
 * rather than bypassing it. _clarified caps the gate at one batch per run —
 * a still-unresolved result falls through to decomposePromptV2's unresolved
 * guard (memory_retrieve: answer from context) instead of re-asking.
 *
 * Pass-throughs (never blocks):
 *   - resolution !== 'needs_clarification'  (resolved / declined_ack)
 *   - already clarified this run (_clarified)
 *   - pipeline-control states (plan file, skill plan, correction, resume,
 *     pending gather/ask-user question, multi-intent continuation)
 *   - bridge/cron sources with no interactive user
 *   - no gatherAnswerCallback or no llmBackend (state stays unresolved;
 *     decomposePromptV2's guard still prevents literal tool execution)
 */

const { classifyTask, deriveResolution } = require('../utils/classifyTask');
const { parseLlmJson } = require('../utils/parseLlmJson');

const CLARIFY_SYSTEM_PROMPT = `You are a clarification engine for a desktop assistant.

The user's message could not be resolved to a concrete task — it is ambiguous, content-free (a bare "yes"/"sure"), or refers to something the system could not identify from context.

Generate a small batch of clarifying questions to pin down what the user actually wants.

Return ONLY valid JSON:
{
  "questions": [
    {
      "id": "q1",
      "text": "<concise question, 15 words max>",
      "type": "choice" | "confirm" | "text",
      "options": [{ "label": "<short>", "value": "<value>", "primary": true|false }],
      "freeText": true|false
    }
  ]
}
OR {"complete": true} if the message is actually clear enough to act on.

Rules:
- Prefer ONE well-formed question with concrete options over several vague ones.
- If an ATTACHED CARD or a prior assistant offer exists, the user is most likely replying to it — offer that interpretation as the primary option.
- For a bare reply ("yes", "sure", "ok"), ask what they want done — include the most plausible interpretations from context as options.
- Never ask about anything already stated in the message.
- "choice"/"confirm" questions MUST have options or freeText:true.
- Max 3 questions.`;

/**
 * Ask the LLM for the clarification batch. Returns a normalized question list
 * (empty when the LLM judges the message complete or generation fails).
 */
async function _generateClarifyQuestions(state, logger) {
  const { llmBackend, message, resolvedMessage, conversationHistory, _taskClassification: tc } = state;
  const cardText = state._thoughtAttachment?.text
    || (conversationHistory || []).find(m => m.attachedToMessage)?.content
    || '';
  const recentCtx = (conversationHistory || []).slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 150)}`)
    .join('\n');

  const prompt = `USER MESSAGE: "${message || resolvedMessage || ''}"
${cardText ? `ATTACHED CARD (on screen when the user replied): "${String(cardText).slice(0, 300)}"\n` : ''}${recentCtx ? `RECENT CONVERSATION:\n${recentCtx}\n` : ''}CLASSIFIER FLAGS: taskType=${tc?.taskType || '?'} isThoughtReply=${!!tc?.isThoughtReply} needsClarification=${!!tc?.needsClarification}

Generate clarifying questions.`;

  try {
    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: CLARIFY_SYSTEM_PROMPT },
    }, { maxTokens: 300, temperature: 0, taskType: 'classification' });
    const text = typeof raw === 'string' ? raw : (raw?.text || raw?.content || '');
    const parsed = parseLlmJson(text, logger, 'Node:Clarify');
    if (!parsed || parsed.complete === true || !Array.isArray(parsed.questions)) return [];

    // Normalize: ids + unanswerable-question coercion (same rules as the grill loop).
    return parsed.questions.slice(0, 3).map((q, i) => {
      const question = { ...q, id: q.id || `q${i + 1}` };
      const hasOptions = Array.isArray(question.options) && question.options.length > 0;
      if (question.type === 'text') {
        question.freeText = true;
      } else if (!hasOptions && question.freeText !== true) {
        question.freeText = true;
        delete question.options;
      } else if (question.type === 'confirm' && hasOptions && question.options.length === 1) {
        question.options.push({ label: 'No / different', value: 'no', primary: false });
      }
      return question;
    });
  } catch (e) {
    logger.warn(`[Node:Clarify] question generation failed: ${e.message}`);
    return [];
  }
}

module.exports = async function clarify(state) {
  const logger = state.logger || console;
  const tc = state._taskClassification || {};

  if (tc.resolution !== 'needs_clarification') return state;
  if (state._clarified) return state;

  // Pipeline-control states never clarify — they carry their own flow.
  if (state._planFile || state._skillPlan || state.skillBuildRequest || state.intentPlan ||
      state._planCorrectionMode || state._resumeContext || state._gatherQuestionPending ||
      state._planTask ||
      state.pendingQuestion) {
    return { ...state, _clarified: true, _clarifyOutcome: 'passthrough' };
  }
  // Non-interactive sources have no user to answer — bridges, cron/scheduled
  // runs, reminders, and internal dispatches proceed unresolved.
  const NON_INTERACTIVE_SOURCES = new Set([
    'bridge_listener', 'bridge_startup', 'cron', 'scheduled_task',
    'reminder_fired', 'local_scout', 'skill_store',
  ]);
  if (NON_INTERACTIVE_SOURCES.has(state.context?.source)) {
    return { ...state, _clarified: true, _clarifyOutcome: 'non_interactive' };
  }

  const cb = state.gatherAnswerCallback;
  if (typeof cb !== 'function' || !state.llmBackend) {
    logger.info(`[Node:Clarify] needs_clarification but ${typeof cb !== 'function' ? 'no gatherAnswerCallback' : 'no llmBackend'} — staying unresolved`);
    return { ...state, _clarified: true, _clarifyOutcome: typeof cb !== 'function' ? 'no_callback' : 'no_llm' };
  }

  const questions = await _generateClarifyQuestions(state, logger);
  if (!questions.length) {
    logger.info('[Node:Clarify] question generation produced nothing — staying unresolved');
    return { ...state, _clarified: true, _clarifyOutcome: 'no_questions' };
  }

  logger.info(`[Node:Clarify] needs_clarification — asking ${questions.length} question(s): "${String(state.message).slice(0, 60)}"`);
  try { state.progressCallback?.({ type: 'gathering', message: 'Clarifying your request…' }); } catch (_) { /* non-fatal */ }

  let answers = null;
  try {
    answers = await cb({ batch: true, batchId: `clarify_${Date.now()}`, questions, routeConfirmation: null });
  } catch (e) {
    logger.warn(`[Node:Clarify] gatherAnswerCallback threw: ${e.message}`);
  }

  const qaPairs = (answers && typeof answers === 'object')
    ? questions.map(q => ({ q: q.text || q.question || '', a: answers[q.id] })).filter(p => p.a)
    : [];
  if (!qaPairs.length) {
    logger.info('[Node:Clarify] no answers received (timeout/skip) — staying unresolved');
    return { ...state, _clarified: true, _clarifyOutcome: 'unanswered' };
  }

  // Fold answers into the operative text and re-classify once — the clarified
  // meaning flows through the same contract rather than bypassing it.
  const baseMsg = state.resolvedMessage || state.message || '';
  const enriched = `${baseMsg}\n[Additional context: ${qaPairs.map(p => `${p.q} ${p.a}`).join('; ')}]`;
  logger.info(`[Node:Clarify] ${qaPairs.length} answer(s) merged — re-classifying`);

  let newTc = tc;
  try {
    newTc = await classifyTask(enriched, state.conversationHistory || [], state.llmBackend, logger);
    // deriveResolution's ack-word test must see the user's literal text, not
    // the enriched message — "yes" stays an ack even once clarified.
    newTc.resolution = deriveResolution(newTc, state.message, !!state._thoughtAttachment);
  } catch (e) {
    logger.warn(`[Node:Clarify] re-classify failed: ${e.message} — keeping original classification`);
  }

  return {
    ...state,
    // Both fields carry the enriched text — downstream nodes split between
    // `message` (webSearch, planning, memory) and `resolvedMessage`
    // (decompose, answer). originalMessage still holds the user's literal text.
    message: enriched,
    resolvedMessage: enriched,
    _taskClassification: newTc,
    _clarified: true,
    _clarifyOutcome: 'answered',
    _clarifyAnswers: qaPairs,
  };
};

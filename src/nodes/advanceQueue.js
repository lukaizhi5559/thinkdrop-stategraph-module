'use strict';
/**
 * advanceQueue — multi-intent queue runner (extracted from the logConversation
 * edge, where it lived as a ~270-line orchestrator hidden inside a routing
 * function).
 *
 * Responsibilities after each intent step completes:
 *   1. Surface ask_user pauses (single-intent and mid-pipeline)
 *   2. Collect the finished step's result into intentResults / dataContext
 *   3. Pop the next queued step, resolve {{result[N]}} placeholders and
 *      dataTemplate / _dataFile propagation
 *   4. Dispatch long-running steps via taskRunner (async hold)
 *   5. Reset per-step state so step N's referent/output fields don't bleed
 *      into step N+1
 *
 * Contract: returns `{ _advanceRoute, ...patch }` — the advanceQueue edge is a
 * pure read of `_advanceRoute`. All state changes happen here, in a node.
 */

const extractStepResult = require('../utils/extractStepResult');

function emitAskUser(state, source) {
  if (typeof state.progressCallback !== 'function') return;
  const pq = state.pendingQuestion;
  try {
    state.progressCallback({
      type:    'ask_user',
      question: pq.question,
      options:  pq.options || [],
      stepIndex: pq.stepIndex,
      agentId:  pq.agentId || null,
      source,
      // Forward ALL pendingQuestion fields so the renderer can show
      // PartialFailureCard for agent failures (not just the generic banner).
      _isAgentAskUser: pq._isAgentAskUser === true,
      partialProgress: pq.partialProgress || null,
      currentUrl:      pq.currentUrl || null,
      keepSession:     pq.keepSession === true,
      originalTask:    pq.originalTask || null,
      skill:           pq.skill || null,
      freeText: true,
    });
  } catch (_) { /* progress callback must never block execution */ }
}

module.exports = async function advanceQueue(state) {
  const log = state.logger || console;

  // ── Single-intent ask_user pause (end-of-pipeline) ─────────────────────────
  // If a single-intent run escalated to ASK_USER, surface the question card
  // here before exiting to end. Otherwise the user gets a silent spinner.
  if (!state.isMultiIntent && state.recoveryAction === 'ask_user' && state.pendingQuestion) {
    log.info('[Node:AdvanceQueue] Single-intent ask_user pause — surfacing question');
    emitAskUser(state, 'single_intent_pause');
    return { _advanceRoute: 'end' };
  }

  // ── Multi-intent ask_user pause (mid-pipeline) ─────────────────────────────
  // If the current step ended with recoveryAction='ask_user' and there are
  // still steps in the queue, pause and surface the question. When the user
  // answers, the graph resumes with the pipeline state intact.
  if (state.isMultiIntent && state.recoveryAction === 'ask_user' && state.pendingQuestion) {
    log.info('[Node:AdvanceQueue] Multi-intent ask_user pause (mid-pipeline) — surfacing question');
    emitAskUser(state, 'multi_intent_pause');
    return { _advanceRoute: 'end' };
  }

  // ── More steps remain — execute next sub-intent ────────────────────────────
  if (state.isMultiIntent && Array.isArray(state.intentQueue) && state.intentQueue.length > 0) {

    // 1. Collect this step's result
    const completedStep = {
      step:      state.intentResults?.length ?? 0,
      intent:    state.intent?.type,
      subPrompt: state.intent?.subPrompt || state.message,
      result:    extractStepResult(state),
    };

    const intentResults = [...(state.intentResults || []), completedStep];
    const dataContext   = { ...(state.dataContext || {}), [completedStep.step]: completedStep.result };

    // Emit step-done progress event
    if (typeof state.progressCallback === 'function') {
      try {
        state.progressCallback({
          type:      'intent:pipeline_step',
          step:      completedStep.step + 1,
          total:     completedStep.step + 1 + state.intentQueue.length + 1,
          intent:    completedStep.intent,
          subPrompt: completedStep.subPrompt,
          result:    (typeof completedStep.result === 'string' ? completedStep.result : completedStep.result?.summary || '').slice(0, 100),
          status:    'done',
        });
      } catch (_) { /* progress callback must never block execution */ }
    }

    // 2. Pop next step
    const [nextStep, ...remaining] = state.intentQueue;

    // 3. Resolve {{result[N]}} placeholders in the sub-prompt text
    // dataContext[N] may be a plain string or { summary, file } object — use summary for text substitution
    let resolvedText = nextStep.text;
    for (const depIdx of (nextStep.dependsOn || [])) {
      const dep = dataContext[depIdx];
      const depResult = (dep && typeof dep === 'object') ? (dep.summary || '') : (dep || '');
      resolvedText = resolvedText.replace(
        new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
        depResult
      );
    }

    // 4. Resolve dataTemplate into _dataPrefix
    let dataPrefix = null;
    if (nextStep.dataTemplate) {
      dataPrefix = nextStep.dataTemplate;
      for (const depIdx of (nextStep.dependsOn || [])) {
        const dep = dataContext[depIdx];
        const depResult = (dep && typeof dep === 'object') ? (dep.summary || '') : (dep || '');
        dataPrefix = dataPrefix.replace(
          new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
          depResult
        );
      }
    }

    // Fallback: If no dataTemplate but has dependencies, auto-inject as prefix
    if (!dataPrefix && (nextStep.dependsOn || []).length > 0) {
      const depResults = (nextStep.dependsOn || []).map(depIdx => {
        const dep = dataContext[depIdx];
        return (dep && typeof dep === 'object') ? (dep.summary || '') : (dep || '');
      }).filter(Boolean);
      if (depResults.length > 0) {
        dataPrefix = `Context from previous step:\n${depResults.join('\n')}\n\n`;
      }
    }

    // Resolve _dataFile: carry the full-content buffer file from dependent steps (if any)
    let dataFile = null;
    for (const depIdx of (nextStep.dependsOn || [])) {
      const dep = dataContext[depIdx];
      if (dep && typeof dep === 'object' && dep.file) { dataFile = dep.file; break; }
    }

    // 5. Long-running async dispatch
    if (nextStep.isLongRunning) {
      const taskRunner = require('./taskRunner');
      const { randomUUID } = require('crypto');
      const taskId = (typeof randomUUID === 'function') ? randomUUID() : 'task_' + Date.now();

      // Parse completion signal from dataTemplate if present
      // e.g. dataTemplate: "waitForContent: Game build complete"
      let completionSignal = 'waitForContent';
      let completionArg    = 'complete';
      if (nextStep.dataTemplate) {
        const m = nextStep.dataTemplate.match(/^waitFor(Content|Selector):\s*(.+)$/i);
        if (m) {
          completionSignal = 'waitFor' + m[1];
          completionArg    = m[2].trim();
        }
      }

      await taskRunner.dispatch({
        taskId,
        subPrompt:        nextStep.text,
        intent:           nextStep.intent,
        stepOrder:        nextStep.order,
        completionSignal,
        completionArg,
        planContext: {
          intentResults,
          dataContext,
          intentQueue: remaining,
        },
        originalPrompt:   state.originalPrompt || state.message,
        sessionId:        (state.context && state.context.sessionId) || state.sessionId || null,
        onComplete: async (tid, result) => {
          log.info(`[Node:AdvanceQueue] Task ${tid} done — result ready for queue resume`);
          if (typeof state.progressCallback === 'function') {
            state.progressCallback({
              type:      'long_task_resume',
              taskId:    tid,
              stepOrder: nextStep.order,
              result:    result ? result.slice(0, 500) : '',
            });
          }
        },
        onTimeout: async (tid, pendingSteps, reason) => {
          log.warn(`[Node:AdvanceQueue] Task ${tid} timed out — surfacing ASK_USER`);
          state.answer              = `The task "${nextStep.text.slice(0, 80)}" didn't complete — ${reason}. Would you like to retry, skip this step, or cancel?`;
          state.askUserReason       = reason;
          state.pendingStepsAfterTimeout = pendingSteps;
          if (typeof state.progressCallback === 'function') {
            state.progressCallback({
              type:         'ask_user',
              question:     state.answer,
              options:      ['Retry', 'Skip this step', 'Cancel all'],
              taskId:       tid,
              pendingSteps: pendingSteps.length,
            });
          }
        },
        progressCallback: state.progressCallback || null,
        logger: log,
      });

      // Mark queue consumed up to this dispatched step, then hold: the graph
      // re-enters logConversation and the queue continues on resume.
      log.info(`[Node:AdvanceQueue] Async task ${taskId} dispatched — holding in logConversation`);
      return {
        _advanceRoute: 'logConversation',
        intentResults,
        dataContext,
        intentQueue:  remaining,
        _longTaskId:  taskId,
      };
    }

    log.info(`[Node:AdvanceQueue] Step ${completedStep.step + 1} done → executing step ${completedStep.step + 2}/${completedStep.step + 2 + remaining.length}: ${nextStep.intent} — "${resolvedText.slice(0, 60)}"`);

    // Emit step-starting progress event
    if (typeof state.progressCallback === 'function') {
      try {
        state.progressCallback({
          type:      'intent:pipeline_step',
          step:      completedStep.step + 2,
          total:     completedStep.step + 2 + remaining.length,
          intent:    nextStep.intent,
          subPrompt: nextStep.text,
          status:    'running',
        });
      } catch (_) { /* progress callback must never block execution */ }
    }

    // 6. Reset state for next step — clear previous step output to prevent bleed
    return {
      _advanceRoute:     'enrichIntent',
      message:           resolvedText,
      resolvedMessage:   resolvedText,
      _dataPrefix:       dataPrefix,
      _dataFile:         dataFile,
      intent: {
        type:       nextStep.intent,
        confidence: nextStep.confidence,
        subPrompt:  nextStep.text,
        entities:   [],
      },
      intentResults,
      dataContext,
      intentQueue:       remaining,
      conversationLogged: false,
      // Clear previous step's output so it doesn't bleed into this step
      answer:            null,
      filteredMemories:  [],
      contextDocs:       [],
      searchResults:     [],
      skillResults:      [],
      skillPlan:         null,
      skillCursor:       0,
      commandExecuted:   false,
      commandOutput:     null,
      executionResult:   null,
      failedStep:        null,
      recoveryAction:    null,
      carriedIntent:     null,
      enrichmentNeeded:  [],
      matchedSkillName:  null,
      // Referent + pause/verdict state from the previous step must not bleed
      // into the next one — a queued step is a fresh sub-intent, not a reply
      // to the same card/question.
      pendingQuestion:   null,
      reviewVerdict:     null,
      evaluationVerdict: null,
      evaluationFix:     null,
      recoveryContext:   null,
      singleStepReplan:  null,
      scoutPending:      false,
      _thoughtAttachment: null,
      _needsFreshScreen: false,
      _postScreenIntent: null,
      _taskClassification: state._taskClassification ? {
        ...state._taskClassification,
        isFollowUp:         false,
        isThoughtReply:     false,
        followUpTarget:     null,
        needsClarification: false,
        resolution:         'resolved',
      } : null,
    };
  }

  // ── Queue exhausted — collect final step and summarize ─────────────────────
  if (state.isMultiIntent && Array.isArray(state.intentResults) && state.intentResults.length > 0) {
    const finalStep = {
      step:      state.intentResults.length,
      intent:    state.intent?.type,
      subPrompt: state.intent?.subPrompt || state.message,
      result:    extractStepResult(state),
    };
    return {
      _advanceRoute: 'summarizeMultiIntent',
      intentResults: [...state.intentResults, finalStep],
      dataContext:   { ...state.dataContext, [finalStep.step]: finalStep.result },
    };
  }

  // ── Single-intent path — normal exit ───────────────────────────────────────
  return { _advanceRoute: 'end' };
};

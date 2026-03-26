'use strict';

/**
 * planDocument.js
 *
 * Writes a live, human-readable JSON plan document to disk during execution.
 * Inspired by TDD/BDD cucumber-style reporting: each step has a status, timing,
 * and output, providing a live audit trail of autonomous execution.
 *
 * File: ~/.thinkdrop/plans/active_plan.json  (overwritten on each update)
 * Archive: ~/.thinkdrop/plans/<planId>.plan.json  (written on completion/failure)
 *
 * Document schema:
 * {
 *   id:            string    — unique plan ID (date-based)
 *   goal:          string    — original user message
 *   status:        'running' | 'completed' | 'failed' | 'waiting'
 *   startedAt:     ISO timestamp
 *   updatedAt:     ISO timestamp
 *   completedAt?:  ISO timestamp
 *   subPlanDepth:  number    — current sub-plan nesting depth (0 = top-level)
 *   currentGoal:   string    — goal label of the active plan layer
 *   steps: [
 *     {
 *       index:       number   — 1-based
 *       skill:       string
 *       description: string
 *       status:      'pending' | 'running' | 'done' | 'failed' | 'skipped'
 *       startedAt?:  ISO
 *       completedAt? ISO
 *       durationMs?: number
 *       output?:     string   — stdout / summary (truncated to 500 chars)
 *       error?:      string
 *     }
 *   ]
 *   recovery?: {
 *     action:  string
 *     trigger: string
 *     count:   number
 *   }
 *   answer?:  string   — final synthesized answer
 * }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PLANS_DIR   = path.join(os.homedir(), '.thinkdrop', 'plans');
const ACTIVE_FILE = path.join(PLANS_DIR, 'active_plan.json');

// In-memory cache so we can compute step durations without re-reading disk
const _cache = {};

function ensurePlansDir() {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function truncate(str, max = 500) {
  if (!str || typeof str !== 'string') return str;
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Build a step entry from a skillPlan step + optional result.
 */
function buildStepEntry(stepObj, index, result) {
  const { skill = '', description = '', optional = false } = stepObj || {};
  const entry = {
    index,
    skill,
    description: description || skill,
    optional,
    status: 'pending',
  };
  if (result) {
    if (result.skipped) {
      entry.status = 'skipped';
    } else if (result.ok === false) {
      entry.status = 'failed';
      entry.error  = truncate(result.error || result.stderr || '');
    } else {
      entry.status = 'done';
    }
    if (result.stdout)      entry.output = truncate(result.stdout);
    if (result.completedAt) entry.completedAt = result.completedAt;
    if (result.startedAt)   entry.startedAt   = result.startedAt;
    if (result.durationMs !== undefined) entry.durationMs = result.durationMs;
  }
  return entry;
}

/**
 * Write (or update) the active plan document from the current execution state.
 *
 * Call at the START of each graph pass (before dispatch) for live status.
 * The function is intentionally synchronous and lightweight — we never want
 * document writes to block the execution pipeline.
 *
 * @param {object} state       Current stategraph state
 * @param {string} [phase]     'start' | 'step_done' | 'step_failed' | 'complete' | 'failed'
 */
function writePlanDoc(state, phase = 'start') {
  try {
    ensurePlansDir();

    const {
      skillPlan    = [],
      skillCursor  = 0,
      skillResults = [],
      subPlanStack = [],
      message,
      resolvedMessage,
      originalMessage,
      currentGoalLabel,
      replanCount  = 0,
      failedStep,
      answer,
    } = state;

    const goal = originalMessage || resolvedMessage || message || 'Unknown goal';
    const planId = state.planId || (state._planDocId || (_cache._planDocId = _cache._planDocId || `plan_${Date.now()}`));

    // Persist the planId back to state cache so it's stable across passes
    _cache._planDocId = planId;

    const subPlanDepth = Array.isArray(subPlanStack) ? subPlanStack.length : 0;
    const activeGoal   = currentGoalLabel || (subPlanDepth > 0 ? `sub-plan:${subPlanDepth}` : goal);

    // Build the step list — merge skillPlan with skillResults
    const steps = skillPlan.map((stepObj, idx) => {
      const result = skillResults.find(r => r.step === idx + 1) || null;
      const entry  = buildStepEntry(stepObj, idx + 1, result);

      // Mark the step currently executing as 'running'
      if (idx === skillCursor && phase === 'start' && !result) {
        entry.status = 'running';
      }
      return entry;
    });

    // Determine plan status
    let status = 'running';
    if (phase === 'complete' || (answer && skillCursor >= skillPlan.length)) {
      status = 'completed';
    } else if (phase === 'failed' || (failedStep && replanCount >= 3)) {
      status = 'failed';
    } else if (state.pendingQuestion) {
      status = 'waiting';
    }

    // Load existing doc to preserve startedAt and history
    let existingDoc = null;
    try { existingDoc = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')); } catch (_) {}

    const doc = {
      id:           planId,
      goal:         truncate(goal, 200),
      status,
      startedAt:    (existingDoc?.id === planId ? existingDoc.startedAt : null) || now(),
      updatedAt:    now(),
      subPlanDepth,
      currentGoal:  truncate(activeGoal, 120),
      steps,
    };

    if (status === 'completed' || status === 'failed') {
      doc.completedAt = now();
    }

    if (answer) {
      doc.answer = truncate(answer, 1000);
    }

    if (replanCount > 0 || failedStep) {
      doc.recovery = {
        action:  failedStep?.reason || 'replan',
        trigger: truncate(failedStep?.error || failedStep?.reason || '', 120),
        count:   replanCount,
      };
    }

    const json = JSON.stringify(doc, null, 2);

    // Write active_plan.json (atomic: write to temp then rename)
    const tmpFile = ACTIVE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, json, 'utf8');
    fs.renameSync(tmpFile, ACTIVE_FILE);

    // On completion/failure, also archive the plan
    if (status === 'completed' || status === 'failed') {
      const archiveFile = path.join(PLANS_DIR, `${planId}.plan.json`);
      try { fs.writeFileSync(archiveFile, json, 'utf8'); } catch (_) {}
      // Clear in-memory cache so the next run gets a fresh planId
      _cache._planDocId = null;
    }
  } catch (e) {
    // Plan document writes are best-effort — never crash execution
    if (state.logger) state.logger.warn(`[PlanDoc] write failed: ${e.message}`);
  }
}

/**
 * Clear the in-memory planId cache (call at the start of a fresh top-level plan).
 */
function resetPlanDoc() {
  _cache._planDocId = null;
}

module.exports = { writePlanDoc, resetPlanDoc };

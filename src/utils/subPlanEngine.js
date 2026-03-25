'use strict';

/**
 * subPlanEngine.js
 *
 * Plan-tree manager for ThinkDrop's autonomous execution engine.
 *
 * When a step fails due to a recoverable reason (e.g. login required),
 * the engine can "spawn" a sub-plan — a new set of steps inserted before
 * the failed step.  Once the sub-plan completes, execution resumes at the
 * failed step on the parent plan (so the step can be retried with fresh
 * auth state).
 *
 * Limits
 * ──────
 * MAX_DEPTH = 3  — hard cap on nested sub-plan levels.
 * Loop guard    — normalises goal strings and refuses to spawn a sub-plan
 *                 whose normalised goal matches any ancestor on the stack.
 *
 * Persistence
 * ───────────
 * Parent plan snapshots are written to ~/.thinkdrop/plans/<planId>.json
 * so they survive process crashes.  They are cleaned up on completion.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');
const MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensurePlansDir() {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

function planFilePath(planId) {
  return path.join(PLANS_DIR, `${planId}.json`);
}

function generatePlanId() {
  return `plan_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * Normalise a goal string for loop detection.
 * Strips punctuation, lowercases, collapses whitespace.
 */
function normaliseGoal(goal) {
  return String(goal || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return true if newGoal (normalised) matches any ancestor on the stack,
 * or matches the currently-executing sub-plan's own goal.
 * stack: Array<{ goalLabel: string }>
 * currentGoalLabel: string|null — the goal of the sub-plan currently running
 */
function isLoopDetected(newGoal, stack, currentGoalLabel) {
  const norm = normaliseGoal(newGoal);
  if (stack.some(entry => normaliseGoal(entry.goalLabel) === norm)) return true;
  if (currentGoalLabel && normaliseGoal(currentGoalLabel) === norm) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a sub-plan.
 *
 * Returns a partial state object that the caller should spread into the
 * current state:
 *   { subPlanStack, skillPlan, skillCursor, currentGoalLabel }
 *   or { planError } when spawn is blocked (depth / loop).
 *
 * Design note: cursor points to the FAILED step (not cursor+1) so that
 * after the sub-plan completes and the stack is popped, executeCommand
 * retries the original failed step with refreshed state (e.g. new session).
 *
 * @param {object} state        Current LangGraph state
 * @param {Array}  subSteps     Steps for the new sub-plan
 * @param {string} goalLabel    Human-readable label for the sub-plan goal
 * @returns {object}
 */
function spawnSubPlan(state, subSteps, goalLabel) {
  const stack = Array.isArray(state.subPlanStack) ? state.subPlanStack : [];

  if (stack.length >= MAX_DEPTH) {
    return {
      subPlanStack:     stack,
      skillPlan:        state.skillPlan,
      skillCursor:      state.skillCursor,
      planError:        `Sub-plan depth limit (${MAX_DEPTH}) reached — cannot spawn: "${goalLabel}"`,
    };
  }

  if (isLoopDetected(goalLabel, stack, state.currentGoalLabel)) {
    return {
      subPlanStack:     stack,
      skillPlan:        state.skillPlan,
      skillCursor:      state.skillCursor,
      planError:        `Loop detected — sub-plan goal matches an ancestor: "${goalLabel}"`,
    };
  }

  const planId     = generatePlanId();
  const parentEntry = {
    planId,
    skillPlan:    state.skillPlan   || [],
    skillCursor:  state.skillCursor ?? 0,   // keep at failed step for retry
    goalLabel:    state.currentGoalLabel || 'root',
    depth:        stack.length,
  };

  // Persist parent snapshot to disk (best-effort)
  try {
    ensurePlansDir();
    fs.writeFileSync(
      planFilePath(planId),
      JSON.stringify(parentEntry, null, 2),
      'utf8'
    );
  } catch (_) {}

  return {
    subPlanStack:     [...stack, parentEntry],
    skillPlan:        subSteps,
    skillCursor:      0,
    currentGoalLabel: goalLabel,
  };
}

/**
 * Complete the current sub-plan and resume the parent.
 *
 * Returns a partial state object ({ subPlanStack, skillPlan, skillCursor,
 * currentGoalLabel }) or {} when there is no parent to return to.
 *
 * @param {object} state  Current LangGraph state
 * @returns {object}
 */
function completeSubPlan(state) {
  const stack = Array.isArray(state.subPlanStack) ? [...state.subPlanStack] : [];
  if (stack.length === 0) return {};

  const parent = stack.pop();

  // Clean up disk snapshot (best-effort)
  try {
    const fp = planFilePath(parent.planId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}

  return {
    subPlanStack:     stack,
    skillPlan:        parent.skillPlan,
    skillCursor:      parent.skillCursor,  // retry failed step
    currentGoalLabel: parent.goalLabel,
  };
}

/**
 * Return true when currently executing a sub-plan (stack is non-empty)
 * AND all steps of the current sub-plan have been processed.
 */
function isSubPlanComplete(state) {
  if (!Array.isArray(state.subPlanStack) || state.subPlanStack.length === 0) {
    return false;
  }
  const plan   = state.skillPlan  || [];
  const cursor = state.skillCursor ?? 0;
  return cursor >= plan.length;
}

module.exports = { spawnSubPlan, completeSubPlan, isSubPlanComplete, MAX_DEPTH };

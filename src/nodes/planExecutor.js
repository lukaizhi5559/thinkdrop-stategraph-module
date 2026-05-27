'use strict';

/**
 * planExecutor.js
 *
 * StateGraph node: executes a plan.md file step by step.
 * Called when parseIntent detects state._planFile (set by plan:approve IPC).
 *
 * On each call to planExecutor, it:
 *   1. Reads the plan.md from disk
 *   2. Finds the next pending step (⬜ pending or ❌ failed with retry flag)
 *   3. Injects secret values from keytar/memory into the step action text
 *   4. Sets state to run that single step through the existing enrichIntent → node path
 *   5. Updates the plan.md with 🔄 running while the step executes
 *   6. After the step completes (via logConversation re-entry), writes ✅ done or ❌ failed
 *   7. If all steps are done → sets state.planComplete = true, clears _planMode
 *
 * Restart resume: on app restart, reads plan.md and skips all ✅ done steps,
 * resuming from the first ⬜ pending or ❌ failed step automatically.
 *
 * State inputs:
 *   state._planFile      — absolute path to plan.md
 *   state._planStepIndex — which step was just completed (set by logConversation re-entry)
 *   state._planResult    — result from the just-completed step (set by logConversation re-entry)
 *   state.llmBackend     — for injectSecrets
 *   state.mcpAdapter     — for injectSecrets memory lookups
 *   state.progressCallback
 *   state.context
 *
 * State outputs (for each step execution):
 *   state.message          — the step's action text (with secrets injected)
 *   state.resolvedMessage  — same
 *   state.intent           — { type: step.intent, ... }
 *   state._planMode        — true
 *   state._planFile        — preserved
 *   state._planStepNum     — current step number (1-based)
 *   state._planTotalSteps  — total step count
 *   state.planComplete     — true when all steps done
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const planScanner = require('../utils/planScanner');

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');

// ── Status constants ───────────────────────────────────────────────────────
const STATUS_PENDING     = '⬜ pending';
const STATUS_RUNNING     = '🔄 running';
const STATUS_DONE        = '✅ done';
const STATUS_FAILED      = '❌ failed';
const STATUS_SKIPPED     = '⏭ skipped';

// ── Helper: update frontmatter status in file ──────────────────────────────
function writePlanFile(planFile, content) {
  try {
    fs.writeFileSync(planFile, content, 'utf8');
  } catch (err) {
    throw new Error(`[PlanExecutor] Could not write plan file ${planFile}: ${err.message}`);
  }
}

// ── Helper: load plan file ─────────────────────────────────────────────────
function readPlanFile(planFile, logger) {
  try {
    return fs.readFileSync(planFile, 'utf8');
  } catch (err) {
    logger.error(`[Node:PlanExecutor] Could not read plan file: ${err.message}`);
    return null;
  }
}

// ── Helper: load secrets sidecar for this plan ────────────────────────────
function loadSecretsSidecar(planFile) {
  const sidecarPath = planFile.replace(/\.md$/, '.secrets.json');
  try {
    if (fs.existsSync(sidecarPath)) {
      return JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    }
  } catch (_) {}
  return {};
}

// ── Main export ────────────────────────────────────────────────────────────
module.exports = async function planExecutor(state) {
  const logger = state.logger || console;
  const {
    _planFile,
    _planStepNum,         // set when re-entering after a step completes
    _planStepResult,      // result from just-completed step  
    llmBackend,
    mcpAdapter,
    progressCallback,
    context,
  } = state;

  logger.info(`[Node:PlanExecutor] ENTRY — _planFile: ${_planFile} | re-entry step: ${_planStepNum != null ? _planStepNum : 'none (first entry)'}`);

  if (!_planFile) {
    logger.error('[Node:PlanExecutor] No _planFile in state — cannot execute plan');
    return { ...state, answer: 'No plan file found. Please try again.', _planMode: false };
  }

  // 1. Read the plan
  let content = readPlanFile(_planFile, logger);
  if (!content) {
    return {
      ...state,
      answer: `Could not read plan file at ${_planFile}. The file may have been moved or deleted.`,
      _planMode: false,
    };
  }

  // Extract skill_plan_json from frontmatter
  // let originalSkillPlan = null;
  // try {
  //   const frontmatterMatch = content.match(/^---\n(.*?)\n---/s);
  //   if (frontmatterMatch) {
  //     const frontmatter = frontmatterMatch[1];
  //     const skillPlanJsonMatch = frontmatter.match(/skill_plan_json:\s*'([^']+)'/);
  //     if (skillPlanJsonMatch) {
  //       const decoded = Buffer.from(skillPlanJsonMatch[1], 'base64').toString('utf8');
  //       originalSkillPlan = JSON.parse(decoded);
  //       logger.debug(`[Node:PlanExecutor] Extracted original skill plan with ${originalSkillPlan.length} steps`);
  //     }
  //   }
  // } catch (err) {
  //   logger.warn(`[Node:PlanExecutor] Failed to extract skill_plan_json: ${err.message}`);
  // }

  // 2. Handle re-entry after a step was just executed
  //    _planStepNum is set when logConversation's plan-mode handler calls back
  if (_planStepNum) {
    const succeeded = !state.failedStep && !state.planError;
    const result = _planStepResult || (succeeded ? (state.answer || '(done)') : (state.failedStep?.error || state.planError || '(failed)'));
    const newStatus = succeeded ? STATUS_DONE : STATUS_FAILED;

    content = planScanner.updateStepStatus(content, _planStepNum, newStatus, result);

    // Emit step completion event
    if (typeof progressCallback === 'function') {
      progressCallback({
        type: 'plan:step_done',
        stepNum: _planStepNum,
        status: newStatus,
        result: (result || '').slice(0, 200),
        planFile: _planFile,
      });
    }

    logger.info(`[Node:PlanExecutor] Step ${_planStepNum} marked ${newStatus}`);
  }

  // 3. Parse all steps and find the next pending one
  const steps = planScanner.parseSteps(content);
  const totalSteps = steps.length;

  const nextStep = steps.find(
    (s) => s.status === STATUS_PENDING || s.status === STATUS_FAILED
  );

  logger.info(`[Node:PlanExecutor] Steps parsed: ${totalSteps} total | Next pending: ${nextStep ? `Step ${nextStep.num} — status="${nextStep.status}" intent="${nextStep.intent}" action="${(nextStep.action || nextStep.title || '').slice(0, 60)}"` : 'NONE (all complete → emitting plan:complete)'}`);

  // 4. All steps complete
  if (!nextStep) {
    // Update frontmatter status → complete
    content = planScanner.updateFrontmatterStatus(content, 'complete');
    writePlanFile(_planFile, content);

    if (typeof progressCallback === 'function') {
      progressCallback({
        type: 'plan:complete',
        planFile: _planFile,
        totalSteps,
      });
    }

    logger.info(`[Node:PlanExecutor] All ${totalSteps} steps complete — plan done`);

    // Collect all results for a summary
    const allResults = steps
      .filter((s) => s.result)
      .map((s) => `[Step ${s.num} - ${s.intent}]: ${s.result}`)
      .join('\n\n');

    return {
      ...state,
      _planMode: false,
      _planCorrectionMode: false,
      _planCorrectionText: null,
      _planCorrectionSourcePrompt: null,
      _basePlanFile: null,
      _skillPlanFile: null,
      _skillPlanJson: null,
      planComplete: true,
      isMultiIntent: steps.length > 1,
      intentResults: steps.map((s) => ({
        step: s.num - 1,
        intent: s.intent,
        subPrompt: s.action || s.query || s.title,
        result: s.result || '',
      })),
      originalPrompt: state.originalPrompt || state.message,
    };
  }

  // 5. Resolve placeholder variables in the step action using keytar + memory
  const planId = path.basename(_planFile, '.md');
  const secretsMeta = loadSecretsSidecar(_planFile);

  let keytarGet = null;
  try {
    const keytar = require('keytar');
    keytarGet = (service, key) => keytar.getPassword(service, key);
  } catch (_) { /* keytar not available */ }

  let actionText = nextStep.action || nextStep.query || nextStep.title;

  try {
    actionText = await planScanner.injectSecrets(actionText, {
      keytarGet,
      mcpAdapter,
      logger,
    });
  } catch (err) {
    logger.warn(`[Node:PlanExecutor] Secret injection failed for step ${nextStep.num}: ${err.message}`);
  }

  // 6. Mark step as 🔄 running in plan file
  content = planScanner.updateStepStatus(content, nextStep.num, STATUS_RUNNING);
  // Update frontmatter to running if it was pending
  content = planScanner.updateFrontmatterStatus(content, 'running');
  writePlanFile(_planFile, content);

  // 7. Emit step:starting event
  if (typeof progressCallback === 'function') {
    progressCallback({
      type: 'plan:step_start',
      stepNum: nextStep.num,
      totalSteps,
      intent: nextStep.intent,
      title: nextStep.title,
      action: actionText,
      planFile: _planFile,
    });
  }

  logger.info(`[Node:PlanExecutor] Executing Step ${nextStep.num}/${totalSteps}: [${nextStep.intent}] "${actionText.slice(0, 80)}"`);

  // 8. Build the state for this single step execution.
  //    We set the message and intent, then return — the StateGraph routes this
  //    through enrichIntent → existing nodes (planSkills, retrieveMemory, etc.)
  //    exactly as if it were a fresh single-intent prompt.
  const stepState = {
    ...state,
    // Core routing fields
    message:          actionText,
    resolvedMessage:  actionText,
    intent: {
      type:       nextStep.intent,
      confidence: 1.0, // Maximum confidence to prevent override
      entities:   [],
      requiresMemoryAccess: nextStep.intent === 'memory_retrieve',
    },
    // Plan tracking fields
    _planMode:        true,
    _planFile,
    _planStepNum:     nextStep.num,
    _planTotalSteps:  totalSteps,
    // Clear step-level output fields so previous output doesn't bleed
    answer:           null,
    filteredMemories: [],
    contextDocs:      [],
    searchResults:    [],
    skillResults:     [],
    skillPlan: null,
    // skillPlan:        originalSkillPlan ? [originalSkillPlan[nextStep.num - 1]] : [{ // Use original skill plan or fallback
    //   skill: nextStep.skills?.[0] || 'shell.run',
    //   args: JSON.parse(nextStep.args || '{}'),
    //   description: nextStep.title || nextStep.action || 'Execute step',
    // }],
    skillCursor:      0,
    commandExecuted:  false,
    commandOutput:    null,
    executionResult:  null,
    failedStep:       null,
    planError:        null,
    recoveryAction:   null,
    enrichmentNeeded: [],
    matchedSkillName: null,
    conversationLogged: false,
    // Multi-intent fields — clear so single-step path is taken through existing nodes
    isMultiIntent:    false,
    intentQueue:      [],
    // Preserve original prompt for logging/summarization
    originalPrompt:   state.originalPrompt || state.message,
  };

  // Inject data from previously completed steps (dependency injection)
  if (nextStep.dependsOn && nextStep.dependsOn.length > 0) {
    const depResults = [];
    for (const depNum of nextStep.dependsOn) {
      const depStep = steps.find((s) => s.num === depNum);
      if (depStep && depStep.result) {
        depResults.push(depStep.result);
      }
    }
    if (depResults.length > 0) {
      stepState._dataPrefix = depResults.join('\n');
      logger.debug(`[Node:PlanExecutor] Injecting dependency data for step ${nextStep.num} from steps ${nextStep.dependsOn.join(', ')}`);
    }
  }

  return stepState;
};

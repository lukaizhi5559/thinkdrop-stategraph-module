'use strict';

/**
 * planExecutor.js — single-pass setup node.
 *
 * Reads ALL pending steps from plan.md, builds a complete skillPlan[] from
 * skill_plan_json, and hands off to planSkills → executeCommand in one pass
 * (~9 nodes regardless of step count). executeCommand emits plan:step_* events
 * via the _skillPlanFile fan-out and writes plan.md status back on completion.
 */

const fs   = require('fs');
const path = require('path');

const planScanner = require('../utils/planScanner');
const {
  extractPlanContext,
  getCurrentBrowserContext,
  contextMismatch,
  findHardcodedDesktopFilename,
  suggestFilenameFromTitle,
} = require('../utils/planCacheHelpers');

function readPlanFile(planFile, logger) {
  try { return fs.readFileSync(planFile, 'utf8'); }
  catch (err) { logger.error(`[Node:PlanExecutor] Cannot read plan file: ${err.message}`); return null; }
}

function extractOriginalPrompt(content) {
  const m = content.match(/^original_prompt:\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

// ── Main export ────────────────────────────────────────────────────────────
module.exports = async function planExecutor(state) {
  const logger = state.logger || console;
  const { _planFile, mcpAdapter } = state;

  logger.info(`[Node:PlanExecutor] ENTRY — _planFile: ${_planFile}`);

  if (!_planFile) {
    logger.error('[Node:PlanExecutor] No _planFile in state');
    return { ...state, answer: 'No plan file found. Please try again.' };
  }

  // 1. Read plan file
  const content = readPlanFile(_planFile, logger);
  if (!content) {
    return { ...state, answer: `Could not read plan file: ${_planFile}` };
  }

  // 2. Extract skill_plan_json — exact original { skill, args, description } per step
  let originalSkillPlan = null;
  try {
    const fm = content.match(/^---\n(.*?)\n---/s);
    if (fm) {
      const spMatch = fm[1].match(/skill_plan_json:\s*'([^']+)'/);
      if (spMatch) {
        originalSkillPlan = JSON.parse(Buffer.from(spMatch[1], 'base64').toString('utf8'));
        logger.info(`[Node:PlanExecutor] Extracted original skill plan with ${originalSkillPlan.length} steps`);
      }
    }
  } catch (err) {
    logger.warn(`[Node:PlanExecutor] Failed to extract skill_plan_json: ${err.message}`);
  }

  // 3. Parse steps — find all pending (supports partial resume after app restart)
  const steps = planScanner.parseSteps(content);
  const totalSteps = steps.length;
  const pendingSteps = steps.filter(s => s.status === '⬜ pending' || s.status === '❌ failed');

  logger.info(`[Node:PlanExecutor] Steps: ${totalSteps} total, ${pendingSteps.length} pending`);

  if (pendingSteps.length === 0) {
    logger.info('[Node:PlanExecutor] No pending steps — plan already complete');
    return { ...state, answer: 'All plan steps are already complete.', planComplete: true };
  }

  // 4. Build skillPlan[] for ALL pending steps
  let keytarGet = null;
  try {
    const keytar = require('keytar');
    keytarGet = (service, key) => keytar.getPassword(service, key);
  } catch (_) {}

  const skillPlan = [];
  for (const step of pendingSteps) {
    const originalEntry = originalSkillPlan ? originalSkillPlan[step.num - 1] : null;

    let actionText = step.action || step.query || step.title;
    try {
      actionText = await planScanner.injectSecrets(actionText, { keytarGet, mcpAdapter, logger });
    } catch (err) {
      logger.warn(`[Node:PlanExecutor] Secret injection failed for step ${step.num}: ${err.message}`);
    }

    if (originalEntry) {
      skillPlan.push({ ...originalEntry, description: actionText });
    } else {
      skillPlan.push({ skill: 'shell.run', args: { goal: actionText }, description: actionText });
    }
  }

  const originalPrompt = extractOriginalPrompt(content) || state.originalPrompt || state.message || '';

  // 4b. Detect context mismatch and ask for a filename when the cached plan
  //     hardcoded a name derived from a prior browser context.
  const planContext = extractPlanContext(content);
  const currentContext = getCurrentBrowserContext(state);
  const hardcodedFilename = findHardcodedDesktopFilename(skillPlan);

  if (hardcodedFilename && contextMismatch(planContext, currentContext)) {
    logger.info(`[Node:PlanExecutor] Context mismatch — cached filename ${hardcodedFilename} may be stale`);
    const gatherAnswerCallback = state.gatherAnswerCallback;
    if (typeof gatherAnswerCallback === 'function') {
      const currentTitle = currentContext.windowTitle || currentContext.contextText || 'this page';
      const suggested = suggestFilenameFromTitle(currentTitle, 'txt');
      const question = `I found a saved plan for this prompt, but the active page has changed to "${currentTitle}". What filename should I use on the Desktop? (suggested: ${suggested})`;
      try {
        let newFilename = await gatherAnswerCallback(question);
        if (newFilename && newFilename.trim()) {
          newFilename = newFilename.trim().replace(/[^\w\s._~/-]/g, '').replace(/\s+/g, '_');
          if (!newFilename.includes('/')) {
            if (!/\.[a-zA-Z0-9]{1,6}$/i.test(newFilename)) {
              newFilename += '.txt';
            }
            newFilename = `~/Desktop/${newFilename}`;
          }
          // Replace the stale filename in every affected shell.run step
          for (const step of skillPlan) {
            if (step.skill !== 'shell.run') continue;
            const argsJson = JSON.stringify(step.args);
            const replacedJson = argsJson.split(hardcodedFilename).join(newFilename);
            if (replacedJson !== argsJson) {
              step.args = JSON.parse(replacedJson);
            }
          }
          logger.info(`[Node:PlanExecutor] Replaced stale filename: ${hardcodedFilename} → ${newFilename}`);
        } else {
          logger.info('[Node:PlanExecutor] No filename provided — continuing with cached plan filename');
        }
      } catch (err) {
        logger.warn(`[Node:PlanExecutor] Filename ask failed: ${err.message} — continuing with cached plan filename`);
      }
    } else {
      logger.warn('[Node:PlanExecutor] No gatherAnswerCallback available — cannot ask for filename');
    }
  }

  logger.info(`[Node:PlanExecutor] Built skillPlan[${skillPlan.length}] — handing to planSkills → executeCommand`);

  // 5. Return setup state — planSkills passthrough → executeCommand runs all steps in one pass.
  //    _skillPlanFile = _planFile enables executeCommand's plan:step_done/plan:complete fan-out
  //    and writes plan.md status back on completion.
  return {
    ...state,
    // Skill execution
    skillPlan,
    skillCursor:    0,
    skillResults:   [],
    // Wire plan file into executeCommand's fan-out / status write-back
    _skillPlanFile: _planFile,
    // Routing
    _planMode:      false,
    intent: {
      type:       'command_automate',
      confidence: 1.0,
      entities:   [],
      requiresMemoryAccess: false,
    },
    message:        originalPrompt,
    resolvedMessage: originalPrompt,
    // Clear stale output fields
    answer:           null,
    commandExecuted:  false,
    commandOutput:    null,
    failedStep:       null,
    planError:        null,
    recoveryAction:   null,
    conversationLogged: false,
    isMultiIntent:    false,
    intentQueue:      [],
    originalPrompt,
  };
};

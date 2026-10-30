'use strict';
/**
 * flagStepFailure — builds recovery context for a failedStep that arrived
 * without a recoveryAction (extracted from the executeCommand edge, which
 * mutated state inside a routing function).
 */
module.exports = async function flagStepFailure(state) {
  const logger = state.logger || console;
  // A failed step without a recoveryAction means thin recovery declined —
  // the failure is localized to one step, so single-step replan (626ms path)
  // is the right first move, not a 54KB full-plan regen (observed: 147s).
  // replanCount still increments and the stall guard escalates to ask_user
  // if replacements keep failing — full replan remains reachable via
  // evaluateSkills FIX verdicts.
  logger.warn(`[Node:FlagStepFailure] failedStep without recoveryAction — defaulting to replan_step (skill: ${state.failedStep?.skill})`);
  return {
    recoveryAction: 'replan_step',
    recoveryContext: {
      failedSkill: state.failedStep.skill,
      failedStep: state.failedStep,
      failureReason: state.failedStep.error,
      succeededSteps: (state.skillResults || [])
        .filter(r => r.ok)
        .map(r => ({ step: r.step, skill: r.skill, description: r.description, result: (r.stdout || r.result || '').toString().slice(0, 200) })),
    },
  };
};

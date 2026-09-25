'use strict';
/**
 * flagStepFailure — builds recovery context for a failedStep that arrived
 * without a recoveryAction (extracted from the executeCommand edge, which
 * mutated state inside a routing function).
 */
module.exports = async function flagStepFailure(state) {
  const logger = state.logger || console;
  logger.warn(`[Node:FlagStepFailure] failedStep without recoveryAction — defaulting to replan (skill: ${state.failedStep?.skill})`);
  return {
    recoveryAction: 'replan',
    recoveryContext: {
      failedSkill: state.failedStep.skill,
      failureReason: state.failedStep.error,
      succeededSteps: (state.skillResults || [])
        .filter(r => r.ok)
        .map(r => ({ step: r.step, skill: r.skill, description: r.description, result: (r.stdout || r.result || '').toString().slice(0, 200) })),
    },
  };
};

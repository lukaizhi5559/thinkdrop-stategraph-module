'use strict';
/**
 * prepareReplan — marks replan mode before planSkills (extracted from the
 * evaluateSkills edge, which mutated `state.singleStepReplan` inside a
 * routing function).
 *
 * A single-step replan (recoveryAction='replan_step') preserves prior step
 * statuses; a full replan clears the flag.
 */
module.exports = async function prepareReplan(state) {
  const logger = state.logger || console;
  const single = state.recoveryAction === 'replan_step';
  logger.info(`[Node:PrepareReplan] ${single ? 'single-step' : 'full'} replan → planSkills (retry ${state.evaluationRetryCount || 0})`);
  return { singleStepReplan: single ? true : (state.singleStepReplan || null) };
};

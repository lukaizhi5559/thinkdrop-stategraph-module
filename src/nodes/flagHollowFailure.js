'use strict';
/**
 * flagHollowFailure — marks a hollow-result review verdict for replan
 * (extracted from the reviewExecution edge, which mutated recoveryAction and
 * recoveryContext inside a routing function).
 */
module.exports = async function flagHollowFailure(state) {
  const logger = state.logger || console;
  logger.info('[Node:FlagHollowFailure] reviewExecution FAILED — marking hollow-result replan');
  return {
    recoveryAction: 'replan',
    recoveryContext: { failureReason: 'Hollow result — review judged execution as FAILED' },
  };
};

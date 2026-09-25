'use strict';
/**
 * surfacePlanFailure — turns a planSkills error into a user-visible answer
 * (extracted from the planSkills edge, which set state.answer and emitted a
 * progress event inside a routing function).
 *
 * On total provider outage the answer explains why planning failed; other
 * planErrors route to logConversation with the error as-is.
 */
module.exports = async function surfacePlanFailure(state) {
  const logger = state.logger || console;
  const patch = {};

  if (state.planError && state.planError.includes('All LLM providers failed')) {
    patch.answer = "I'm unable to process your request right now because all AI providers are currently unavailable. This is likely due to rate limits or API key issues. Please check your provider settings or try again in a few minutes.";
    logger.info('[Node:SurfacePlanFailure] All providers failed — surfacing error to user');
    // Emit progress event to update UI immediately (don't leave it stuck on "Planning steps...")
    if (typeof state.progressCallback === 'function') {
      try {
        state.progressCallback({
          type: 'planning_failed',
          message: patch.answer,
          error: state.planError,
          source: 'planSkills'
        });
      } catch (err) {
        logger.warn('[Node:SurfacePlanFailure] Failed to emit planning_failed progress event:', err.message);
      }
    }
  }
  return patch;
};

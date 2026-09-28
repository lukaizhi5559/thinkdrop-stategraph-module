'use strict';
/**
 * preparePostScreen — lazy screen-grab handoff (extracted from the
 * screenIntelligence edge, where it mutated five state fields inside a
 * routing function).
 *
 * Runs when the classifier requested a fresh screen capture
 * (`_needsFreshScreen`) and screenIntelligence has put the capture in
 * `state.context`. Injects the capture into `_priorScreenContext` shape so
 * downstream nodes see it, marks the classification as a screen follow-up,
 * enriches resolvedMessage for automation intents, and sets `_advanceRoute`
 * to the post-screen destination.
 */
module.exports = async function preparePostScreen(state) {
  const logger = state.logger || console;
  logger.info(`[Node:PreparePostScreen] _needsFreshScreen — fresh context captured, routing based on postIntent: ${state._postScreenIntent}`);

  const postIntent = state._postScreenIntent || 'general_knowledge';
  const subject = state.screenContext?.windowTitle || state.screenContext?.appName || null;

  const patch = {
    // Inject fresh capture into _priorScreenContext shape so downstream nodes see it
    _priorScreenContext: {
      timestamp:   new Date().toISOString(),
      appName:     state.screenContext?.appName     || null,
      windowTitle: state.screenContext?.windowTitle || null,
      url:         state.screenContext?.url         || null,
      contextText: state.context,
    },
    _taskClassification: {
      ...(state._taskClassification || {}),
      isScreenFollowUp: true,
      followUpTarget:   state.screenContext?.windowTitle || state.screenContext?.appName || null,
    },
    // Clear flags so multi-intent queue steps don't re-trigger
    _needsFreshScreen: false,
    _postScreenIntent: null,
  };

  // command_automate / scheduling: enrich resolvedMessage, proceed through automation path
  if (postIntent === 'command_automate' || postIntent === 'scheduling') {
    if (subject && state.resolvedMessage) {
      patch.resolvedMessage = `[Screen context: ${subject}] ${state.resolvedMessage}`;
      logger.info(`[Node:PreparePostScreen] enriched resolvedMessage for ${postIntent}`);
    }
    patch._advanceRoute = 'resolveUserContext';
    return patch;
  }

  // memory intents: subject injected via _priorScreenContext, route normally
  if (postIntent === 'memory_retrieve') { patch._advanceRoute = 'retrieveMemory'; return patch; }
  if (postIntent === 'memory_store')    { patch._advanceRoute = 'storeMemory';    return patch; }

  // web_search: subject prepended by webSearch.js via _priorScreenContext
  if (postIntent === 'web_search') { patch._advanceRoute = 'webSearch'; return patch; }

  // screen_display: GhostLayer output is independent of the captured screen —
  // continue to the display node, not the generic answer path
  if (postIntent === 'screen_display') { patch._advanceRoute = 'screenOutput'; return patch; }

  // query / general_knowledge / ambiguous / greeting → answer with injected context
  patch._advanceRoute = 'answer';
  return patch;
};

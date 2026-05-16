'use strict';

/**
 * resolveReferencesV2
 *
 * Slim rewrite — removes all regex-based coreference logic and the Python
 * coreference service call. Single responsibility:
 *   1. Fetch conversation history from the conversation service
 *   2. Attach it to state.conversationHistory for all downstream nodes
 *   3. Pass the user message through verbatim
 *
 * Context resolution ("that folder", "it", "the result") is handled by the
 * planning LLM in planSkills via the conversationNote injection — exactly how
 * ChatGPT/Claude/Cursor work.
 */

function stripHtml(text) {
  return text ? text.replace(/<[^>]*>/g, '') : text;
}

module.exports = async function resolveReferencesV2(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;

  // ── skill_build pass-through ───────────────────────────────────────────────
  if (state.skillBuildRequest && state.intent?.type === 'skill_build') {
    return state;
  }

  if (!mcpAdapter) {
    return { ...state, resolvedMessage: message, originalMessage: message, conversationHistory: [] };
  }

  // ── Fetch conversation history (sliding window) ────────────────────────────
  let conversationHistory = [];
  try {
    let sessionId = context?.sessionId;

    if (!sessionId) {
      try {
        const routeResult = await mcpAdapter.callService('conversation', 'session.route', { text: message });
        sessionId = (routeResult.data || routeResult)?.sessionId || null;
        if (sessionId) logger.debug(`[Node:ResolveReferencesV2] Routed to session: ${sessionId}`);
      } catch (_) {}
    }

    if (sessionId) {
      const histResult = await mcpAdapter.callService('conversation', 'message.list', {
        sessionId,
        limit: 20,
        direction: 'DESC',
      });
      const histData = histResult.data || histResult;
      conversationHistory = (histData.messages || [])
        .filter(msg => msg.sender !== 'system')
        .map(msg => ({
          role:      msg.sender === 'user' ? 'user' : 'assistant',
          content:   stripHtml(msg.text || msg.content || ''),
          timestamp: msg.timestamp,
        }))
        .reverse();

      logger.debug(`[Node:ResolveReferencesV2] Fetched ${conversationHistory.length} messages for context window`);
    }
  } catch (err) {
    logger.debug('[Node:ResolveReferencesV2] Could not fetch history, proceeding without:', err.message);
  }

  return {
    ...state,
    resolvedMessage:        message,
    originalMessage:        message,
    conversationHistory,
    coreferenceMethod:      'none',
    coreferenceReplacements: [],
  };
};

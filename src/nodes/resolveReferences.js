/**
 * Resolve References Node
 *
 * Runs BEFORE parseIntent so the intent classifier sees a fully-resolved
 * message instead of ambiguous pronouns / follow-up fragments.
 *
 * Examples:
 *   "what about now"          → "what is on the screen now"
 *   "what about that"         → "what about <previous topic>"
 *   "can you explain it more" → "can you explain <previous subject> more"
 *
 * Calls the coreference-service (Python/FastAPI, port 3005) with:
 *   - message: raw user input
 *   - conversationHistory: last N messages from conversation-service
 *
 * Returns:
 *   - resolvedMessage: coreference-resolved text (used by parseIntent + answer)
 *   - originalMessage: original raw text (kept for debugging)
 *   - coreferenceReplacements: array of { original, resolved, confidence }
 *   - coreferenceMethod: 'coreferee' | 'neuralcoref' | 'rule_based' | 'fallback'
 *
 * Graceful degradation: if coreference service is down, falls back to original
 * message so the rest of the graph continues normally.
 */

function stripHtml(text) {
  return text ? text.replace(/<[^>]*>/g, '') : text;
}

module.exports = async function resolveReferences(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;

  logger.debug('[Node:ResolveReferences] Resolving coreferences...');
  logger.debug(`[Node:ResolveReferences] Original: "${message}"`);

  // No MCP adapter → skip gracefully
  if (!mcpAdapter) {
    return {
      ...state,
      resolvedMessage: message,
      originalMessage: message,
      coreferenceReplacements: [],
      coreferenceMethod: 'no-adapter'
    };
  }

  try {
    // ── Fetch fresh conversation history so coreference has full context ──────
    let conversationHistory = [];
    try {
      const sessionId = context?.sessionId;
      if (sessionId) {
        const histResult = await mcpAdapter.callService('conversation', 'message.list', {
          sessionId,
          limit: 10,
          direction: 'DESC'
        });
        const histData = histResult.data || histResult;
        conversationHistory = (histData.messages || [])
          .map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: stripHtml(msg.text || msg.content || ''),
            timestamp: msg.timestamp
          }))
          .reverse(); // chronological order for coreference context
        logger.debug(`[Node:ResolveReferences] Fetched ${conversationHistory.length} messages for context`);
      }
    } catch (histErr) {
      logger.debug('[Node:ResolveReferences] Could not fetch history, proceeding without:', histErr.message);
    }

    // ── Call coreference service ──────────────────────────────────────────────
    const result = await mcpAdapter.callService('coreference', 'resolve', {
      message,
      conversationHistory: conversationHistory.slice(-10),
      options: {
        includeConfidence: true,
        method: 'auto'
      }
    });

    const data = result.data || result;
    const resolvedMessage = data.resolvedMessage || message;
    const replacements = data.replacements || [];
    const method = data.method || 'unknown';

    if (replacements.length > 0) {
      logger.debug(`[Node:ResolveReferences] Resolved ${replacements.length} reference(s) via ${method}`);
      replacements.forEach(r =>
        logger.debug(`  "${r.original}" → "${r.resolved}" (${Math.round((r.confidence || 0) * 100)}%)`)
      );
      logger.debug(`[Node:ResolveReferences] Resolved message: "${resolvedMessage}"`);
    } else {
      logger.debug('[Node:ResolveReferences] No references resolved, message unchanged');
    }

    return {
      ...state,
      resolvedMessage,
      originalMessage: message,
      coreferenceReplacements: replacements,
      coreferenceMethod: method
    };

  } catch (error) {
    // Graceful fallback — coreference service down should never block the graph
    logger.debug('[Node:ResolveReferences] Service unavailable, using original message:', error.message);
    return {
      ...state,
      resolvedMessage: message,
      originalMessage: message,
      coreferenceReplacements: [],
      coreferenceMethod: 'fallback'
    };
  }
};

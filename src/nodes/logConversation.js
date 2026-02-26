/**
 * Log Conversation Node
 *
 * Persists the user message and assistant response to the conversation-service
 * for context/history. This node runs at the END of every graph execution,
 * regardless of intent type.
 *
 * Works with or without MCP adapter:
 * - With MCP: Stores both turns in conversation-service via message.add
 * - Without MCP: No-op (logs warning)
 *
 * Session handling:
 * - Uses context.sessionId if provided
 * - If no sessionId, calls session.route to auto-match or create a session
 */

module.exports = async function logConversation(state) {
  const { mcpAdapter, message, answer, context, intent } = state;
  const logger = state.logger || console;

  logger.debug('[Node:LogConversation] Logging conversation turn...');

  // Nothing to log if no message or answer
  if (!message && !answer) {
    logger.debug('[Node:LogConversation] No message/answer to log, skipping');
    return state;
  }

  // No-op without MCP adapter
  if (!mcpAdapter) {
    logger.warn('[Node:LogConversation] No MCP adapter - conversation not logged');
    return state;
  }

  try {
    // Resolve or create session
    let sessionId = context?.sessionId;

    if (!sessionId) {
      logger.debug('[Node:LogConversation] No sessionId - routing to session...');
      try {
        const routeResult = await mcpAdapter.callService('conversation', 'session.route', {
          text: message,
          userId: context?.userId,
          metadata: {
            intent: intent?.type,
            source: 'thinkdrop_electron'
          }
        });
        const routeData = routeResult.data || routeResult;
        sessionId = routeData.sessionId || routeData.session?.id;
        logger.debug(`[Node:LogConversation] Routed to session: ${sessionId}`);
      } catch (routeErr) {
        logger.warn('[Node:LogConversation] Session routing failed, trying session.create:', routeErr.message);
        try {
          const createResult = await mcpAdapter.callService('conversation', 'session.create', {
            userId: context?.userId || 'default_user',
            metadata: { source: 'thinkdrop_electron', intent: intent?.type }
          });
          const createData = createResult.data || createResult;
          sessionId = createData.sessionId || createData.session?.id || createData.id;
          logger.debug(`[Node:LogConversation] Created new session: ${sessionId}`);
        } catch (createErr) {
          logger.error('[Node:LogConversation] Could not create session:', createErr.message);
          return state;
        }
      }
    }

    if (!sessionId) {
      logger.error('[Node:LogConversation] No sessionId resolved, skipping log');
      return state;
    }

    // Store user message and assistant response in parallel
    const logPromises = [];

    if (message) {
      logPromises.push(
        mcpAdapter.callService('conversation', 'message.add', {
          sessionId,
          text: message,
          sender: 'user',
          metadata: {
            intent: intent?.type,
            intentConfidence: intent?.confidence,
            source: 'thinkdrop_electron',
            timestamp: new Date().toISOString()
          }
        }).catch(err => {
          logger.warn('[Node:LogConversation] Failed to log user message:', err.message);
        })
      );
    }

    // For command_automate: store rich skill output so follow-up prompts have real context.
    // commandOutput contains per-step summaries with actual stdout (fs.read tree, image.analyze
    // descriptions, shell output, etc.). answer alone is usually "All N steps completed."
    // which is useless for the next turn's planSkills conversationNote.
    const skillResults = state.skillResults || [];
    let richAssistantText = answer;
    if (intent?.type === 'command_automate' && skillResults.length > 0) {
      const keyOutputs = skillResults
        .filter(r => r.ok && r.stdout && r.stdout.trim().length > 0)
        .map(r => {
          const label = r.description || r.skill;
          // For fs.read: include full tree output (filenames are critical for follow-ups)
          // For others: truncate to 300 chars
          const out = r.skill === 'fs.read'
            ? r.stdout.trim()
            : r.stdout.trim().slice(0, 300);
          return `[${label}]:\n${out}`;
        });
      if (keyOutputs.length > 0) {
        richAssistantText = `${answer || 'Done.'}\n\nStep outputs:\n${keyOutputs.join('\n\n')}`;
      }
    }

    if (richAssistantText && typeof richAssistantText === 'string') {
      logPromises.push(
        mcpAdapter.callService('conversation', 'message.add', {
          sessionId,
          text: richAssistantText,
          sender: 'assistant',
          metadata: {
            intent: intent?.type,
            source: 'stategraph',
            timestamp: new Date().toISOString()
          }
        }).catch(err => {
          logger.warn('[Node:LogConversation] Failed to log assistant response:', err.message);
        })
      );
    }

    await Promise.all(logPromises);

    logger.debug(`[Node:LogConversation] Logged conversation turn to session: ${sessionId}`);

    return {
      ...state,
      conversationLogged: true,
      resolvedSessionId: sessionId
    };

  } catch (error) {
    logger.error('[Node:LogConversation] Error:', error.message);
    // Non-fatal - return state unchanged so the answer still reaches the user
    return state;
  }
};

/**
 * Answer Node - Extracted with graceful degradation
 * 
 * Generates answer using LLM with filtered context.
 * Works with or without MCP adapter:
 * - With MCP: Uses phi4 service for answer generation
 * - Without MCP: Returns placeholder with intent info
 */

module.exports = async function answer(state) {
  const { mcpAdapter, message, intent, context } = state;
  const logger = state.logger || console;
  
  logger.debug('[Node:Answer] Generating answer...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:Answer] No MCP adapter - returning placeholder answer');
    return {
      ...state,
      answer: `[MCP not available - Intent classified as: ${intent?.type || 'unknown'}]`,
      metadata: {
        ...state.metadata,
        answerSource: 'placeholder'
      }
    };
  }

  try {
    // Build context for LLM
    const conversationHistory = state.conversationHistory || [];
    const memories = state.filteredMemories || state.memories || [];
    const webResults = state.contextDocs || [];
    
    // Prepare payload for phi4
    const payload = {
      query: message,
      context: {
        conversationHistory: conversationHistory.map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        memories: memories.map(mem => ({
          text: mem.text,
          similarity: mem.similarity
        })),
        webSearchResults: webResults.map(doc => ({
          text: doc.text,
          source: doc.source,
          url: doc.url
        })),
        sessionId: context?.sessionId,
        userId: context?.userId,
        intent: intent?.type
      },
      options: {
        maxTokens: 500,
        temperature: 0.1
      }
    };

    // Call phi4 service for answer generation
    const result = await mcpAdapter.callService('phi4', 'chat.completion', payload);
    
    // MCP protocol wraps response in 'data' field
    const answerData = result.data || result;
    const finalAnswer = answerData.answer || answerData.text || '[No answer generated]';
    
    logger.debug(`[Node:Answer] Generated answer (${finalAnswer.length} chars)`);
    
    return {
      ...state,
      answer: finalAnswer,
      metadata: {
        ...state.metadata,
        answerSource: 'phi4',
        usage: answerData.usage
      }
    };
  } catch (error) {
    logger.error('[Node:Answer] Failed to generate answer:', error.message);
    
    // Return error state with intent info
    return {
      ...state,
      answer: `[Error generating answer: ${error.message}. Intent: ${intent?.type || 'unknown'}]`,
      error: error.message,
      metadata: {
        ...state.metadata,
        answerSource: 'error'
      }
    };
  }
};

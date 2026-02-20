/**
 * Retrieve Memory Node - Extracted with graceful degradation
 * 
 * Fetches conversation history and long-term memories.
 * Works with or without MCP adapter:
 * - With MCP: Fetches from conversation and user-memory services
 * - Without MCP: Returns empty arrays
 */

module.exports = async function retrieveMemory(state) {
  const { mcpAdapter, message, context, intent } = state;
  const logger = state.logger || console;

  logger.debug('[Node:RetrieveMemory] Fetching context...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:RetrieveMemory] No MCP adapter - skipping memory retrieval');
    return {
      ...state,
      conversationHistory: [],
      sessionFacts: [],
      sessionEntities: [],
      memories: [],
      rawMemoriesCount: 0
    };
  }

  try {
    // Parallel fetch: conversation history and memories
    const [conversationResult, memoriesResult] = await Promise.all([
      // Conversation history (only if sessionId is known)
      context?.sessionId
        ? mcpAdapter.callService('conversation', 'message.list', {
            sessionId: context.sessionId,
            limit: 10,
            direction: 'DESC'
          }).catch(err => {
            logger.warn('[Node:RetrieveMemory] Conversation fetch failed:', err.message);
            return { messages: [] };
          })
        : Promise.resolve({ messages: [] }),

      // Long-term memories (skip for meta-questions)
      intent?.type !== 'context_query' 
        ? mcpAdapter.callService('user-memory', 'memory.search', {
            query: message,
            limit: 5,
            userId: context?.userId,
            minSimilarity: 0.35
          }).catch(err => {
            logger.warn('[Node:RetrieveMemory] Memory search failed:', err.message);
            return { results: [] };
          })
        : Promise.resolve({ results: [] })
    ]);

    // MCP protocol wraps responses in 'data' field
    const conversationData = conversationResult.data || conversationResult;
    const memoriesData = memoriesResult.data || memoriesResult;

    // Process conversation history (reverse to chronological order)
    const conversationHistory = (conversationData.messages || [])
      .map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text,
        timestamp: msg.timestamp
      }))
      .reverse();

    // Process memories
    const memories = (memoriesData.results || []).map(mem => ({
      id: mem.id,
      text: mem.text,
      similarity: mem.similarity,
      entities: mem.entities || [],
      metadata: mem.metadata || {},
      created_at: mem.created_at
    }));

    logger.debug(`[Node:RetrieveMemory] Loaded ${conversationHistory.length} messages, ${memories.length} memories`);

    return {
      ...state,
      conversationHistory,
      sessionFacts: [],
      sessionEntities: [],
      memories,
      rawMemoriesCount: memories.length
    };
  } catch (error) {
    logger.error('[Node:RetrieveMemory] Failed:', error.message);
    
    // Return empty arrays on error
    return {
      ...state,
      conversationHistory: [],
      sessionFacts: [],
      sessionEntities: [],
      memories: [],
      rawMemoriesCount: 0,
      error: error.message
    };
  }
};

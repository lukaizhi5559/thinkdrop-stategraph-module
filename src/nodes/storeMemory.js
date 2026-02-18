/**
 * Store Memory Node - Extracted with graceful degradation
 * 
 * Stores user memory directly (for memory_store intent).
 * Works with or without MCP adapter:
 * - With MCP: Stores in user-memory service
 * - Without MCP: Returns success placeholder
 */

module.exports = async function storeMemory(state) {
  const { mcpAdapter, message, intent, context } = state;
  const logger = state.logger || console;

  logger.debug('[Node:StoreMemory] Storing memory...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:StoreMemory] No MCP adapter - memory not stored');
    return {
      ...state,
      memoryStored: false,
      answer: "[MCP not available - Memory would be stored: \"" + message + "\"]"
    };
  }

  try {
    // Extract entities if available
    const entities = intent?.entities || [];
    
    // Build tags
    const tags = ['user_memory', intent?.type || 'unknown'];
    if (entities.length > 0) {
      entities.forEach(e => {
        if (e.type) tags.push(e.type);
      });
    }

    // Store in user-memory service
    const result = await mcpAdapter.callService('user-memory', 'memory.store', {
      text: message,
      tags: tags,
      entities: entities,
      metadata: {
        source: 'user_input',
        intent: intent?.type,
        confidence: intent?.confidence,
        sessionId: context?.sessionId,
        userId: context?.userId,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });

    // MCP protocol wraps response in 'data' field
    const memoryData = result.data || result;

    logger.debug('[Node:StoreMemory] Memory stored successfully');

    return {
      ...state,
      memoryStored: true,
      memoryId: memoryData.id,
      answer: "Got it! I'll remember that."
    };
  } catch (error) {
    logger.error('[Node:StoreMemory] Error:', error.message);
    return {
      ...state,
      memoryStored: false,
      error: error.message,
      answer: "I had trouble storing that memory. Please try again."
    };
  }
};

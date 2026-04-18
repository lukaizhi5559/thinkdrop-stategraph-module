/**
 * Retrieve Memory Node - Extracted with graceful degradation
 * 
 * Fetches conversation history and long-term memories.
 * Works with or without MCP adapter:
 * - With MCP: Fetches from conversation and user-memory services
 * - Without MCP: Returns empty arrays
 */

const { parseDateRange } = require('../utils/parseDateRange');

/**
 * Build a clean semantic search query from the message.
 * For short elliptical follow-ups ("what about yesterday", "anything today"),
 * strip temporal noise and use a generic activity query so the date filter
 * does the heavy lifting instead of semantic similarity.
 */
function buildSearchQuery(message, resolvedMessage) {
  const q = (resolvedMessage || message || '').toLowerCase().trim();

  // Strip pure temporal/elliptical prefixes that add no semantic value
  const stripped = q
    .replace(/^(what about|anything|how about|tell me about|show me)\s+/i, '')
    .replace(/\b(today|yesterday|this morning|this afternoon|this evening|at noon|at midnight)\b/gi, '')
    .replace(/\b(around|about|at)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '')
    .replace(/\b(earlier|later|then|now|recently)\b/gi, '')
    .trim();

  // If nothing meaningful remains after stripping, use a broad activity query
  if (!stripped || stripped.length < 3) {
    return 'apps websites activity screen';
  }

  return resolvedMessage || message;
}

module.exports = async function retrieveMemory(state) {
  const { mcpAdapter, message, resolvedMessage, context, intent } = state;
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
    let dateRange = parseDateRange(resolvedMessage || message);

    // If no dateRange and this is a short continuation, inherit the dateRange from the
    // most recent prior user message that had one. This keeps follow-ups in the same
    // temporal context (e.g. "can you give me times" after "yesterday what did I do").
    //
    // Guards — do NOT inherit for:
    //   1. Profile/personality queries: "what's my name", "what type of person am I"
    //      These should search all history, not be limited to a prior time window.
    //   2. All-time / earliest-memory queries: "what's the first memory you have of me"
    //   3. Messages longer than 12 words — they carry enough context for their own parse.
    const PROFILE_QUERY_PATTERN = /^(what'?s|what is|who is|who'?s|where is)\s+(my|i am|am i)\b|^what (type|kind|sort) of (person|man|woman|human|individual)/i;
    const ALL_TIME_QUERY_PATTERN = /\b(first|earliest|ever|all time|oldest|very first|all history)\b/i;
    const msgWords = (resolvedMessage || message).trim().split(/\s+/).filter(Boolean).length;
    if (!dateRange && msgWords <= 12 && context?.sessionId &&
        !PROFILE_QUERY_PATTERN.test(resolvedMessage || message) &&
        !ALL_TIME_QUERY_PATTERN.test(resolvedMessage || message)) {
      try {
        const histResult = await mcpAdapter.callService('conversation', 'message.list', {
          sessionId: context.sessionId,
          limit: 10,
          direction: 'DESC'
        });
        const histData = histResult.data || histResult;
        const recentMsgs = (histData.messages || [])
          .filter(m => m.sender === 'user')
          .slice(0, 5); // most recent first (DESC)
        for (const m of recentMsgs) {
          const inherited = parseDateRange(m.text || m.content || '');
          if (inherited) {
            dateRange = inherited;
            logger.debug(`[Node:RetrieveMemory] Inherited dateRange from prior message: "${m.text || m.content}" → ${JSON.stringify(dateRange)}`);
            break;
          }
        }
      } catch (histErr) {
        logger.debug('[Node:RetrieveMemory] Could not fetch history for dateRange inheritance:', histErr.message);
      }
    }

    const searchQuery = buildSearchQuery(message, resolvedMessage);
    const minSimilarity = dateRange ? 0.1 : 0.25;

    logger.debug(`[Node:RetrieveMemory] Search query: "${searchQuery}" | dateRange: ${dateRange ? JSON.stringify(dateRange) : 'none'} | minSimilarity: ${minSimilarity}`);

    // Parallel fetch: current session history + cross-session date query + long-term memories
    const [conversationResult, crossSessionResult, memoriesResult] = await Promise.all([
      // Current session conversation history
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

      // Cross-session messages by date range (for "yesterday", "last week", etc.)
      dateRange
        ? mcpAdapter.callService('conversation', 'message.listByDate', {
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            limit: 30,
            userId: context?.userId
          }).catch(err => {
            logger.warn('[Node:RetrieveMemory] Cross-session fetch failed:', err.message);
            return { messages: [] };
          })
        : Promise.resolve({ messages: [] }),

      // Long-term memories (skip for meta-questions)
      intent?.type !== 'context_query'
        ? mcpAdapter.callService('user-memory', 'memory.search', {
            query: searchQuery,
            limit: 10,
            userId: context?.userId,
            minSimilarity,
            ...(dateRange || {})
          }).catch(err => {
            logger.warn('[Node:RetrieveMemory] Memory search failed:', err.message);
            return { results: [] };
          })
        : Promise.resolve({ results: [] })
    ]);

    // MCP protocol wraps responses in 'data' field
    const conversationData = conversationResult.data || conversationResult;
    const crossSessionData = crossSessionResult.data || crossSessionResult;
    const memoriesData = memoriesResult.data || memoriesResult;

    if (crossSessionData.messages?.length > 0) {
      logger.debug(`[Node:RetrieveMemory] Cross-session fetch: ${crossSessionData.messages.length} messages from date range`);
    }

    // When a date range is detected, use cross-session messages as the primary history.
    // If listByDate returned nothing, fall back to current session so the answer node
    // has at least the recent conversation to work with.
    const crossSessionMessages = crossSessionData.messages || [];
    const currentSessionMessages = conversationData.messages || [];
    const primaryMessages = dateRange
      ? (crossSessionMessages.length > 0 ? crossSessionMessages : currentSessionMessages)
      : (() => {
          // No date range: merge current session + any cross-session, deduplicate
          const allMessages = [
            ...(conversationData.messages || []),
            ...(crossSessionData.messages || [])
          ];
          const seenIds = new Set();
          return allMessages.filter(msg => {
            if (seenIds.has(msg.id)) return false;
            seenIds.add(msg.id);
            return true;
          });
        })();

    // Process conversation history (sort chronologically)
    // Preserve role:'system' for system-injected messages (e.g. skill deletions)
    // so downstream nodes (answer, planSkills) can surface them at highest priority.
    const conversationHistory = primaryMessages
      .map(msg => ({
        role: msg.sender === 'user' ? 'user' : (msg.sender === 'system' ? 'system' : 'assistant'),
        content: msg.text,
        timestamp: msg.timestamp
      }))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-30); // keep last 30 for date-range queries (more history needed)

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
      filteredMemories: memories,
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

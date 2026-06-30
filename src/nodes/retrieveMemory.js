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
 * Format an ISO timestamp into human-readable absolute + relative date
 * - Absolute: "March 8, 2026 at 7:04 PM"
 * - Relative: "(2 days ago)" or "(last Tuesday)"
 */
function formatTimestamp(isoTimestamp) {
  if (!isoTimestamp) return { absolute: 'Unknown date', relative: '' };
  
  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) return { absolute: String(isoTimestamp), relative: '' };
  
  // Format absolute: "March 8, 2026 at 7:04 PM"
  const absolute = date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  
  // Calculate relative time
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);
  
  let relative = '';
  if (diffSec < 60) {
    relative = '(just now)';
  } else if (diffMin < 60) {
    relative = `(${diffMin} minute${diffMin > 1 ? 's' : ''} ago)`;
  } else if (diffHour < 24) {
    relative = `(${diffHour} hour${diffHour > 1 ? 's' : ''} ago)`;
  } else if (diffDay < 7) {
    // Show day name for recent dates
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
    if (diffDay === 1) relative = '(yesterday)';
    else if (diffDay === 2) relative = `(two days ago, ${dayName})`;
    else relative = `(${diffDay} days ago, ${dayName})`;
  } else if (diffWeek < 4) {
    relative = `(${diffWeek} week${diffWeek > 1 ? 's' : ''} ago)`;
  } else if (diffMonth < 12) {
    relative = `(${diffMonth} month${diffMonth > 1 ? 's' : ''} ago)`;
  } else {
    relative = `(${diffYear} year${diffYear > 1 ? 's' : ''} ago)`;
  }
  
  return { absolute, relative, iso: isoTimestamp };
}

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

/**
 * Detect whether a message is asking for a known personal attribute.
 * Returns the normalized attribute name (e.g. 'name', 'email', 'phone') or null.
 */
function _detectPersonalAttribute(message) {
  const q = (message || '').toLowerCase().trim();

  // Direct identity questions
  if (/\b(what('?s|\s+is)\s+(my\s+name|your\s+name)|who\s+am\s+i|what\s+did\s+you\s+call\s+me|what\s+name\s+(did\s+you\s+say|do\s+you\s+have)\b)/i.test(q)) {
    return 'name';
  }

  const match = q.match(
    /\b(?:my|what(?:'s|\s+is)\s+my)\s+(name|email|e-mail|username|favorite\s*\w+|birthday|birthdate|date\s+of\s+birth|location|timezone|phone|phone\s+number|cell|cellphone|mobile|number|occupation|job|company|employer|github|git|language|home\s+address|work\s+address|address)\b/i
  );
  if (match) {
    let attr = match[1].toLowerCase().replace(/\s+/g, '_');
    if (attr === 'e-mail') attr = 'email';
    if (attr === 'phone_number' || attr === 'cell' || attr === 'cellphone' || attr === 'mobile') attr = 'phone';
    if (attr === 'birthdate' || attr === 'date_of_birth') attr = 'birthday';
    if (attr === 'employer') attr = 'company';
    if (attr === 'git') attr = 'github';
    if (attr === 'home_address' || attr === 'work_address') attr = 'address';
    return attr;
  }

  return null;
}

/**
 * Detect a canonical app name in the user's query so episodic search can
 * filter by appName when the user asks about a specific app (e.g. "VS Code",
 * "Chrome", "Slack"). This is much more reliable than BM25 keyword matching
 * because generic terms like "Code" otherwise match many unrelated captures.
 */
function _extractAppNameFilter(message) {
  const q = (message || '').toLowerCase();

  const appPatterns = [
    { aliases: ['vs code', 'visual studio code', 'vscode'], appName: 'VS Code' },
    { aliases: ['google chrome', 'chrome'], appName: 'Google Chrome' },
    { aliases: ['safari'], appName: 'Safari' },
    { aliases: ['firefox'], appName: 'Firefox' },
    { aliases: ['slack'], appName: 'Slack' },
    { aliases: ['spotify'], appName: 'Spotify' },
    { aliases: ['figma'], appName: 'Figma' },
    { aliases: ['warp'], appName: 'Warp' },
    { aliases: ['devin'], appName: 'Devin' },
    { aliases: ['calendar'], appName: 'Calendar' },
    { aliases: ['github'], appName: 'GitHub' },
    { aliases: ['terminal'], appName: 'Terminal' },
  ];

  for (const { aliases, appName } of appPatterns) {
    if (aliases.some(alias => q.includes(alias))) {
      return appName;
    }
  }
  return null;
}

/**
 * Map a normalized personal attribute to the structured user_profile key(s)
 * that storeMemory.js writes. Order matters — try the most specific first.
 */
function _profileKeysForAttribute(attribute) {
  switch (attribute) {
    case 'name':
      return ['self:name', 'self:first_name'];
    case 'email':
      return ['self:email'];
    case 'phone':
      return ['self:phone'];
    case 'address':
      return ['self:address', 'self:work_address'];
    case 'birthday':
      return ['self:birthday'];
    case 'location':
      return ['self:location'];
    case 'timezone':
      return ['self:timezone'];
    case 'company':
      return ['self:company', 'self:occupation'];
    case 'occupation':
      return ['self:occupation', 'self:company'];
    case 'github':
      return ['self:github'];
    case 'language':
      return ['self:language'];
    case 'username':
      return ['self:username'];
    default:
      return [`self:${attribute}`];
  }
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

    // ── Primary profile lookup for personal-attribute queries ───────────────
    // Before running noisy semantic search across thousands of screen captures,
    // check the structured user_profile KV store for known personal attributes.
    let profileFallback = null;
    const personalAttribute = _detectPersonalAttribute(resolvedMessage || message);
    if (personalAttribute && !dateRange) {
      const profileKeys = _profileKeysForAttribute(personalAttribute);
      for (const key of profileKeys) {
        try {
          const profileRes = await mcpAdapter.callService('user-memory', 'profile.get', {
            key,
            userId: context?.userId,
          }, { timeoutMs: 4000 });
          const profileData = profileRes?.data || profileRes;
          if (profileData?.valueRef) {
            profileFallback = { key, value: profileData.valueRef, attribute: personalAttribute };
            logger.info(`[Node:RetrieveMemory] Profile primary hit: ${key} = "${profileData.valueRef}"`);
            break;
          }
        } catch (e) {
          logger.debug(`[Node:RetrieveMemory] profile.get "${key}" failed: ${e.message}`);
        }
      }
    }

    // Parallel fetch: current session history + cross-session date query + long-term memories
    // For multi-intent pipelines (step 2+), reduce the history limit so prior steps'
    // logged answers don't bleed into the current step's LLM context.
    // Each completed step adds ~2 messages (user + assistant); subtract them from the limit.
    const completedIntentSteps = (state.isMultiIntent && Array.isArray(state.intentResults))
      ? state.intentResults.length
      : 0;
    const conversationHistoryLimit = Math.max(4, 20 - completedIntentSteps * 2);
    if (completedIntentSteps > 0) {
      logger.debug(`[Node:RetrieveMemory] Multi-intent step ${completedIntentSteps + 1}: capping history to ${conversationHistoryLimit} msgs (avoids prior-step answer bleed)`);
    }

    // Extract a canonical app name from the query so episodic search can filter
    // exactly when the user asks about a specific app (e.g. "VS Code yesterday").
    const episodicAppName = _extractAppNameFilter(resolvedMessage || message);

    const [conversationResult, crossSessionResult, memoriesResult, episodicResult] = await Promise.all([
      // Current session conversation history
      context?.sessionId
        ? mcpAdapter.callService('conversation', 'message.list', {
            sessionId: context.sessionId,
            limit: conversationHistoryLimit,
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

      // Semantic memory search (skip for meta-questions; screen captures live in episodic_memory)
      // For personal-attribute queries, exclude screen_capture noise so the
      // semantic search only scans user-declared facts.
      intent?.type !== 'context_query'
        ? mcpAdapter.callService('user-memory', 'memory.search', {
            query: searchQuery,
            limit: 10,
            userId: context?.userId,
            minSimilarity,
            filters: personalAttribute
              ? { excludeTypes: ['screen_capture'] }
              : {}
          }).catch(err => {
            logger.warn('[Node:RetrieveMemory] Memory search failed:', err.message);
            return { results: [] };
          })
        : Promise.resolve({ results: [] }),

      // Episodic memory search for date-range activity / screen capture queries
      dateRange && intent?.type !== 'context_query'
        ? mcpAdapter.callService('user-memory', 'episodic.search', {
            query: searchQuery,
            limit: 10,
            userId: context?.userId,
            startDate: dateRange.startDate,
            endDate: dateRange.endDate,
            filters: {
              type: 'screen_capture',
              excludeOverlay: true,
              ...(episodicAppName ? { appName: episodicAppName } : {})
            },
            dedup: true
          }).catch(err => {
            logger.warn('[Node:RetrieveMemory] Episodic search failed:', err.message);
            return { results: [] };
          })
        : Promise.resolve({ results: [] })
    ]);

    // MCP protocol wraps responses in 'data' field
    const conversationData = conversationResult.data || conversationResult;
    const crossSessionData = crossSessionResult.data || crossSessionResult;
    const memoriesData = memoriesResult.data || memoriesResult;
    const episodicData = episodicResult.data || episodicResult;

    // Merge episodic screen captures into memory results for date-range queries
    if (episodicData?.results?.length > 0) {
      const seenIds = new Set((memoriesData.results || []).map(m => m.id));
      for (const e of episodicData.results) {
        if (!seenIds.has(e.id)) {
          (memoriesData.results || []).push(e);
          seenIds.add(e.id);
        }
      }
    }

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

    // Process conversation history with formatted timestamps
    // Preserve role:'system' for system-injected messages (e.g. skill deletions)
    // so downstream nodes (answer, planSkills) can surface them at highest priority.
    const conversationHistory = primaryMessages
      .map(msg => {
        const formattedDate = formatTimestamp(msg.timestamp);
        return {
          role: msg.sender === 'user' ? 'user' : (msg.sender === 'system' ? 'system' : 'assistant'),
          content: msg.text,
          timestamp: msg.timestamp,
          formattedDate
        };
      })
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-30); // keep last 30 for date-range queries (more history needed)

    // Process memories with formatted timestamps
    const memories = (memoriesData.results || []).map(mem => {
      const formattedDate = formatTimestamp(mem.created_at);
      return {
        id: mem.id,
        text: mem.text,
        similarity: mem.similarity,
        entities: mem.entities || [],
        metadata: mem.metadata || {},
        created_at: mem.created_at,
        formattedDate
      };
    });

    logger.debug(`[Node:RetrieveMemory] Loaded ${conversationHistory.length} messages, ${memories.length} memories`);

    // ── Cross-session semantic search fallback ──────────────────────────────────
    // When no memories found and query looks like "what was that conversation about X",
    // try message.search across all sessions.
    let crossSessionSearchResults = [];
    if (memories.length === 0 && !dateRange && !profileFallback) {
      const CONV_RECALL_RE = /\b(conversation|chat|talk|discussed|talking)\s+(about|regarding|on|where)\b/i;
      if (CONV_RECALL_RE.test(resolvedMessage || message || '')) {
        try {
          const searchRes = await mcpAdapter.callService('conversation', 'message.search', {
            query: searchQuery,
            limit: 15,
            userId: context?.userId,
          });
          const searchData = searchRes?.data || searchRes;
          crossSessionSearchResults = (searchData?.messages || searchData?.results || []).map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: msg.text || msg.content,
            timestamp: msg.timestamp,
            formattedDate: formatTimestamp(msg.timestamp),
            sessionId: msg.sessionId,
          }));
          if (crossSessionSearchResults.length > 0) {
            logger.debug(`[Node:RetrieveMemory] Cross-session search found ${crossSessionSearchResults.length} messages`);
          }
        } catch (e) {
          logger.debug(`[Node:RetrieveMemory] message.search fallback failed: ${e.message}`);
        }
      }
    }

    // Merge cross-session search results into conversation history if primary is empty
    const finalHistory = conversationHistory.length > 0
      ? conversationHistory
      : (crossSessionSearchResults.length > 0 ? crossSessionSearchResults : conversationHistory);

    return {
      ...state,
      conversationHistory: finalHistory,
      sessionFacts: [],
      sessionEntities: [],
      memories,
      filteredMemories: memories,
      rawMemoriesCount: memories.length,
      ...(profileFallback ? { _profileFallback: profileFallback } : {}),
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

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
 * Extract topic keywords from recent user conversation history.
 * Used to enrich vague follow-up queries (e.g. "what about the 5th") that strip
 * down to nothing, but whose topic is clear from the prior user message.
 */
function extractTopicFromHistory(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) return null;
  const recentUserMsgs = conversationHistory
    .filter(m => m.role === 'user')
    .slice(-5)
    .reverse();
  for (const msg of recentUserMsgs) {
    const text = (msg.content || '').toLowerCase();
    const matches = text.match(/\b(video|videos|watch|watched|watching|youtube|netflix|movie|movies|show|shows|episode|stream|streaming|music|listen|listening|song|podcast|read|reading|article|browse|browsing|twitch|spotify)\b/g);
    if (matches) return [...new Set(matches)].slice(0, 3).join(' ');
  }
  return null;
}

/**
 * Build a cleaned keyword query for episodic BM25 ranking.
 * Strips temporal phrases, pronouns, articles and filler so that only
 * content-bearing keywords remain (e.g. "watch videos").  The date
 * filtering is handled separately by startDate/endDate in the WHERE
 * clause — this only affects relevance *ranking* within that window.
 */
function buildEpisodicSearchQuery(query) {
  let q = (query || '').toLowerCase().trim();
  q = q
    .replace(/\b(over|during|in|for)\s+(the\s+)?(past|last|next)\s+(\d+\s+)?(days?|weeks?|months?|hours?)\b/gi, '')
    .replace(/\b(the\s+)?(past|last|next)\s+(week|month|few\s+days?|couple\s+(of\s+)?days?)\b/gi, '')
    .replace(/\b(today|yesterday|this\s+(morning|afternoon|evening|week|month)|last\s+night|recently|lately)\b/gi, '')
    .replace(/\b(did|do|have|has|was|were|am|is|are)\s+i\b/gi, '')
    .replace(/\b(i|me|my|any|some|the|a|an|on|at|to|of|it|that|this|what|about|nothing|anything|something)\b/gi, '')
    .replace(/[?.!,]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!q || q.length < 3) return 'activity screen apps websites';

  return q;
}

/**
 * LLM-driven personal attribute detection.
 * Replaces the old regex + if/else chain with a single LLM call that can handle
 * any phrasing the user might use.
 * Only called on short messages containing "my" or "your" to avoid LLM calls on every message.
 * Returns the normalized attribute name (e.g. 'name', 'email', 'phone') or null.
 */
async function _llmDetectPersonalAttribute(message, llmBackend, logger) {
  const q = (message || '').trim();

  // Quick pre-filter: only run LLM on short messages with possessive pronouns
  if (!/\b(my|your)\b/i.test(q) || q.split(/\s+/).length > 15) {
    return null;
  }

  if (!llmBackend || !llmBackend.generateAnswer) return null;

  const prompt = `Extract personal attribute from this message. Return ONLY one of: name, email, phone, birthday, location, timezone, company, occupation, github, username, address, language, or null. Message: "${q}"`;
  try {
    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: 'You extract personal attributes. Return only the attribute name or null.' },
    }, { maxTokens: 50, temperature: 0, fastMode: true, taskType: 'classification' });
    if (!raw) return null;
    const cleaned = raw.trim().toLowerCase().replace(/^```.*\n?/gm, '').replace(/```$/g, '').trim();
    const validAttributes = ['name', 'email', 'phone', 'birthday', 'location', 'timezone', 'company', 'occupation', 'github', 'username', 'address', 'language'];
    if (validAttributes.includes(cleaned)) {
      logger.debug(`[Node:RetrieveMemory] LLM detected personal attribute: ${cleaned}`);
      return cleaned;
    }
    return null;
  } catch (e) {
    logger.debug(`[Node:RetrieveMemory] LLM personal attribute detection failed: ${e.message}`);
    return null;
  }
}

/**
 * Detect whether a message is asking about past screen activity / content consumption.
 * Covers any platform — YouTube, Netflix, Twitch, Spotify, Apple Music, podcasts, news, reading, browsing.
 * No platform names hardcoded; relies on generic activity verbs and nouns.
 */
function _isActivityQuery(message) {
  const q = (message || '').toLowerCase().trim();
  return /\b(watch|watched|watching|video|videos|stream|streaming|movie|movies|show|shows|episode|play|playing|listen|listening|music|song|podcast|read|reading|article|news|browse|browsing|what\s+did\s+i\s+do|what\s+was\s+i\s+doing|activity|screen)\b/i.test(q);
}

/**
 * Lightweight LLM fallback to extract a date range when regex and decompose LLM both return null.
 * Uses minimal tokens (maxTokens: 100, temperature: 0) to keep latency low.
 */
async function _llmDateFallback(message, llmBackend, logger) {
  if (!llmBackend || !llmBackend.generateAnswer) return null;
  const prompt = `Extract a date range from this message. Return ONLY JSON {"startDate":"YYYY-MM-DD HH:MM:SS","endDate":"YYYY-MM-DD HH:MM:SS"} or null if no date reference. For relative ranges like "past week" or "last 7 days", startDate = 7 days ago at 00:00:00, endDate = today at 23:59:59. For single days like "a specific date", both start and end are that day. Message: "${message}"`;
  try {
    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: 'You extract date ranges. Return only JSON or null.' },
    }, { maxTokens: 100, temperature: 0, fastMode: true, taskType: 'classification' });
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && parsed.startDate && parsed.endDate) {
      logger.debug(`[Node:RetrieveMemory] LLM fallback dateRange: ${JSON.stringify(parsed)}`);
      return parsed;
    }
    return null;
  } catch (e) {
    logger.debug(`[Node:RetrieveMemory] LLM date fallback failed: ${e.message}`);
    return null;
  }
}

/**
 * DB-driven app name discovery.
 * Queries episodic_memory for distinct app names the user has actually used,
 * then matches the user's message against them (case-insensitive substring).
 * Falls back to null on error — same as the old hardcoded list returning null.
 */
async function _extractAppNameFilter(message, mcpAdapter, dateRange, context, logger) {
  const q = (message || '').toLowerCase();
  if (!mcpAdapter) return null;

  // Use the date range if available, otherwise default to 30 days for activity queries
  let startDate = null;
  let endDate = null;
  if (dateRange) {
    startDate = dateRange.startDate;
    endDate = dateRange.endDate;
  } else {
    const s = new Date(); s.setDate(s.getDate() - 30);
    const pad = n => String(n).padStart(2, '0');
    startDate = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())} 00:00:00`;
    endDate = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())} 23:59:59`;
  }

  try {
    const result = await mcpAdapter.callService('user-memory', 'episodic.apps', {
      startDate,
      endDate,
      userId: context?.userId,
    }, { timeoutMs: 5000 });
    const data = result?.data || result;
    const apps = data?.apps || [];
    for (const appName of apps) {
      if (appName && q.includes(appName.toLowerCase())) {
        logger.debug(`[Node:RetrieveMemory] DB-driven app filter matched: ${appName}`);
        return appName;
      }
    }
    return null;
  } catch (e) {
    logger.debug(`[Node:RetrieveMemory] episodic.apps lookup failed: ${e.message}`);
    return null;
  }
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

  const now = new Date();

  try {
    // ── Layer 1: Use dateRange from decomposePromptV2 LLM call (zero latency) ──
    let dateRange = state._llmDateRange || null;
    logger.debug(`[Node:RetrieveMemory] Layer 1 - _llmDateRange from state: ${dateRange ? JSON.stringify(dateRange) : 'null'}`);
    logger.debug(`[Node:RetrieveMemory] State keys: ${Object.keys(state).filter(k => k.includes('Date') || k.includes('date')).join(', ')}`);
    
    // ── Layer 2: Regex fast-path ──
    if (!dateRange) {
      dateRange = parseDateRange(resolvedMessage || message);
      logger.debug(`[Node:RetrieveMemory] Layer 2 - parseDateRange result: ${dateRange ? JSON.stringify(dateRange) : 'null'}`);
    }

    // ── Layer 3: LLM fallback when both layers return null ──
    if (!dateRange && state.llmBackend) {
      dateRange = await _llmDateFallback(resolvedMessage || message, state.llmBackend, logger);
    }

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

    const isActivityQuery = _isActivityQuery(resolvedMessage || message);
    const searchQuery = buildSearchQuery(message, resolvedMessage);

    // If the query stripped down to the generic fallback, try to enrich it with the
    // topic from the prior user message (e.g. "what about the 5th" after "videos I watched")
    const isGenericFallback = searchQuery === 'apps websites activity screen';
    let enrichedSearchQuery = searchQuery;
    if (isGenericFallback && state.conversationHistory && state.conversationHistory.length > 0) {
      const topicFromHistory = extractTopicFromHistory(state.conversationHistory);
      if (topicFromHistory) {
        enrichedSearchQuery = topicFromHistory;
        logger.debug(`[Node:RetrieveMemory] Enriched vague query with topic from history: "${topicFromHistory}"`);
      }
    }

    const minSimilarity = (dateRange || isActivityQuery) ? 0.1 : 0.25;

    logger.debug(`[Node:RetrieveMemory] Search query: "${enrichedSearchQuery}" | dateRange: ${dateRange ? JSON.stringify(dateRange) : 'none'} | isActivityQuery: ${isActivityQuery} | minSimilarity: ${minSimilarity}`);

    // ── Primary profile lookup for personal-attribute queries ───────────────
    // Before running noisy semantic search across thousands of screen captures,
    // check the structured user_profile KV store for known personal attributes.
    let profileFallback = null;
    const personalAttribute = await _llmDetectPersonalAttribute(resolvedMessage || message, state.llmBackend, logger);
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
    // Now DB-driven: queries episodic_memory for actual app names the user has used.
    const episodicAppName = await _extractAppNameFilter(resolvedMessage || message, mcpAdapter, dateRange, context, logger);

    // ── DB keyword enrichment for BM25 ──────────────────────────────────────
    // Fetch top app/window pairs from the date range to enrich the BM25 query
    // with the actual vocabulary present in the data. This replaces hardcoded
    // platform names (YouTube, Netflix, etc.) with dynamic discovery.
    let dbKeywords = [];
    try {
      const episodicDateRangeForKeywords = dateRange || (isActivityQuery ? (() => {
        const s = new Date(now); s.setDate(s.getDate() - 30);
        const pad = n => String(n).padStart(2, '0');
        const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const e = new Date(now); e.setHours(23, 59, 59, 999);
        return { startDate: iso(s), endDate: iso(e) };
      })() : null);
      if (episodicDateRangeForKeywords) {
        const kwResult = await mcpAdapter.callService('user-memory', 'episodic.keywords', {
          startDate: episodicDateRangeForKeywords.startDate,
          endDate: episodicDateRangeForKeywords.endDate,
          userId: context?.userId,
          limit: 20,
        }, { timeoutMs: 5000 });
        const kwData = kwResult?.data || kwResult;
        dbKeywords = (kwData?.keywords || []).map(k => [k.appName, k.windowTitle]).flat().filter(Boolean);
      }
    } catch (e) {
      logger.debug(`[Node:RetrieveMemory] episodic.keywords lookup failed: ${e.message}`);
    }

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
            query: enrichedSearchQuery,
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
      // Also fires for activity queries (watch, listen, read, browse, etc.) with a 30-day default
      // window when no explicit dateRange was found — ensures content-consumption recall works
      // even when temporal phrasing isn't parsed by any layer.
      (() => {
        if (intent?.type === 'context_query') return Promise.resolve({ results: [] });
        const episodicDateRange = dateRange || (isActivityQuery ? (() => {
          const s = new Date(now); s.setDate(s.getDate() - 30);
          const pad = n => String(n).padStart(2, '0');
          const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          const e = new Date(now); e.setHours(23, 59, 59, 999);
          return { startDate: iso(s), endDate: iso(e) };
        })() : null);
        if (!episodicDateRange) return Promise.resolve({ results: [] });
        // For activity queries, use a broad query so BM25 doesn't filter out relevant captures.
        // The answer LLM will classify which captures match the user's intent (video, music, etc.)
        // from source_text, appName, windowTitle, and url — no keyword enumeration needed.
        const cleanedQuery = buildEpisodicSearchQuery(enrichedSearchQuery);
        const episodicQuery = isActivityQuery
          ? 'activity screen apps websites browser video music read'
          : (dbKeywords.length > 0 ? `${cleanedQuery} ${dbKeywords.join(' ')}` : cleanedQuery);
        const rangeMs = new Date(episodicDateRange.endDate) - new Date(episodicDateRange.startDate);
        const isWideRange = rangeMs > 86400000; // > 1 day
        let episodicLimit = 10;
        if (isActivityQuery) {
          const rangeDays = isWideRange ? Math.ceil(rangeMs / 86400000) : 0;
          if (rangeDays === 0) episodicLimit = 10;
          else if (rangeDays <= 7) episodicLimit = 100;  // Increased from 50 to ensure multi-day coverage
          else if (rangeDays <= 30) episodicLimit = 150; // Increased from 50
          else if (rangeDays <= 90) episodicLimit = 200; // Increased from 75
          else if (rangeDays <= 365) episodicLimit = 300; // Increased from 100
          else episodicLimit = 500; // Increased from 200
        }
        logger.debug(`[Node:RetrieveMemory] Episodic dateRange: start=${episodicDateRange.startDate} end=${episodicDateRange.endDate} | rangeMs=${rangeMs} (${Math.round(rangeMs/86400000)} days) | wideRange=${isWideRange} | limit=${episodicLimit}`);
        logger.debug(`[Node:RetrieveMemory] Episodic BM25 query: "${episodicQuery}" | limit: ${episodicLimit} | wideRange: ${isWideRange}`);
        return mcpAdapter.callService('user-memory', 'episodic.search', {
          query: episodicQuery,
          limit: episodicLimit,
          userId: context?.userId,
          startDate: episodicDateRange.startDate,
          endDate: episodicDateRange.endDate,
          filters: {
            type: 'screen_capture',
            excludeOverlay: true,
            ...(episodicAppName ? { appName: episodicAppName } : {})
          },
          dedup: true,
          diverseDays: isWideRange
        }).then(result => {
          // Log temporal diversity of retrieved memories
          if (result && result.data && result.data.results) {
            const uniqueDates = new Set();
            result.data.results.forEach(mem => {
              if (mem.created_at) {
                const date = mem.created_at.split(' ')[0]; // Extract YYYY-MM-DD
                uniqueDates.add(date);
              }
            });
            logger.debug(`[Node:RetrieveMemory] Retrieved ${result.data.results.length} memories spanning ${uniqueDates.size} unique dates: ${Array.from(uniqueDates).sort().join(', ')}`);
          }
          return result;
        }).catch(err => {
          logger.warn('[Node:RetrieveMemory] Episodic search failed:', err.message);
          return { results: [] };
        });
      })()
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

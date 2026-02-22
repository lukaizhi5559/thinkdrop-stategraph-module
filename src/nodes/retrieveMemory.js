/**
 * Retrieve Memory Node - Extracted with graceful degradation
 * 
 * Fetches conversation history and long-term memories.
 * Works with or without MCP adapter:
 * - With MCP: Fetches from conversation and user-memory services
 * - Without MCP: Returns empty arrays
 */

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

/**
 * Parse natural language date references from a query into {startDate, endDate} ISO strings.
 * Returns null if no date reference is found (no filter applied — full history).
 *
 * Handles:
 *   "today", "yesterday", "this morning/afternoon"
 *   "last N hours/days/weeks/months"
 *   "this week", "last week", "this month", "last month"
 *   "last year", "this year"
 *   "in January", "last January", "in Jan 2025"
 *   "January 10th - 15th", "Jan 10 to Jan 15"
 *   "last year in Jan between 10th and 15th"
 */
function parseDateRange(message) {
  const q = (message || '').toLowerCase();
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  // DB stores local timestamps (CURRENT_TIMESTAMP returns local time in this setup)
  const iso = (d) => { const pad = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const startOf = (d) => { const r = new Date(d); r.setHours(0,0,0,0); return r; };
  const endOf   = (d) => { const r = new Date(d); r.setHours(23,59,59,999); return r; };

  // Helper: parse a time-of-day from a query string, returns hour (0-23) or null
  // Checks noon/midnight keywords FIRST, then numeric time
  function parseTimeOfDay(str) {
    if (/\bnoon\b/.test(str)) return { hour: 12, minute: 0 };
    if (/\bmidnight\b/.test(str)) return { hour: 0, minute: 0 };
    const m = str.match(/\b(?:at|around|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!\s*(?:min|mins|minutes|hour|hours|hrs|ago|seconds?|sec))\b/);
    if (!m) return null;
    let hour = parseInt(m[1]);
    const minute = m[2] ? parseInt(m[2]) : 0;
    const meridiem = m[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    else if (meridiem === 'am' && hour === 12) hour = 0;
    else if (!meridiem && hour >= 1 && hour <= 6) hour += 12; // 1-6 without am/pm → pm
    return { hour, minute };
  }

  // before/until Xam/pm (e.g. "before 9am this morning", "until 10pm")
  const beforeTimeMatch = q.match(/\b(?:before|until|up to|prior to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (beforeTimeMatch) {
    let h = parseInt(beforeTimeMatch[1]);
    const min = beforeTimeMatch[2] ? parseInt(beforeTimeMatch[2]) : 0;
    const mer = beforeTimeMatch[3];
    if (mer === 'pm' && h < 12) h += 12;
    else if (mer === 'am' && h === 12) h = 0;
    const baseDate = /\byesterday\b/.test(q) ? new Date(now.getTime() - 86400000) : now;
    const start = new Date(baseDate); start.setHours(0, 0, 0, 0);
    const end   = new Date(baseDate); end.setHours(h, min, 0, 0);
    return { startDate: iso(start), endDate: iso(end) };
  }

  // today / this morning / this afternoon / this evening
  if (/\b(today|this morning|this afternoon|this evening)\b/.test(q)) {
    // Check for explicit time range first: "7 - 8:30 this morning", "9 to 11am today"
    const trm = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?\s*(?:to|and|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (trm) {
      let h1 = parseInt(trm[1]), m1 = trm[2] ? parseInt(trm[2]) : 0;
      let h2 = parseInt(trm[3]), m2 = trm[4] ? parseInt(trm[4]) : 59;
      const mer = trm[5] || (q.includes('morning') ? 'am' : null);
      if (mer === 'pm' && h2 < 12) { h1 += (h1 < 12 ? 12 : 0); h2 += 12; }
      const start = new Date(now); start.setHours(h1, m1, 0, 0);
      const end   = new Date(now); end.setHours(h2, m2, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    const tod = parseTimeOfDay(q);
    if (tod) {
      const windowMins = 30;
      const start = new Date(now); start.setHours(tod.hour, Math.max(0, tod.minute - windowMins), 0, 0);
      const end   = new Date(now); end.setHours(tod.hour, tod.minute + windowMins, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    return { startDate: iso(startOf(now)), endDate: iso(endOf(now)) };
  }

  // yesterday / anything yesterday / what about yesterday
  if (/\byesterday\b/.test(q)) {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    // Check for explicit time range first: "yesterday around 8 - 10am", "yesterday 9 to 11am"
    const trm = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?\s*(?:to|and|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (trm) {
      let h1 = parseInt(trm[1]), m1 = trm[2] ? parseInt(trm[2]) : 0;
      let h2 = parseInt(trm[3]), m2 = trm[4] ? parseInt(trm[4]) : 59;
      const mer = trm[5] || (q.includes('morning') ? 'am' : null);
      if (mer === 'pm' && h2 < 12) { h1 += (h1 < 12 ? 12 : 0); h2 += 12; }
      else if (mer === 'am') { /* keep as-is */ }
      else if (!mer && h1 >= 1 && h1 <= 6) { h1 += 12; h2 += (h2 < 12 ? 12 : 0); }
      const start = new Date(d); start.setHours(h1, m1, 0, 0);
      const end   = new Date(d); end.setHours(h2, m2, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    const tod = parseTimeOfDay(q);
    if (tod) {
      const windowMins = 30;
      const start = new Date(d); start.setHours(tod.hour, Math.max(0, tod.minute - windowMins), 0, 0);
      const end   = new Date(d); end.setHours(tod.hour, tod.minute + windowMins, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    return { startDate: iso(startOf(d)), endDate: iso(endOf(d)) };
  }

  // "around 3", "at 3pm", "at noon" (without today/yesterday — assume today)
  if (!q.match(/\b(today|yesterday|this|last|week|month|year)\b/)) {
    const tod = parseTimeOfDay(q);
    if (tod) {
      const windowMins = 30;
      const start = new Date(now); start.setHours(tod.hour, Math.max(0, tod.minute - windowMins), 0, 0);
      const end   = new Date(now); end.setHours(tod.hour, tod.minute + windowMins, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
  }

  // last N minutes / in last N minutes / past N minutes
  const minsMatch = q.match(/\b(?:last|past|in\s+(?:the\s+)?last)\s+(\d+)\s*(?:minute|min)s?\b/);
  if (minsMatch) {
    const mins = parseInt(minsMatch[1]);
    const start = new Date(now.getTime() - mins * 60 * 1000);
    return { startDate: iso(start), endDate: iso(now) };
  }

  // N minutes/mins ago (e.g. "15 mins ago", "1 minute ago", "what about 15 mins ago")
  // Extend endDate by 5 minutes to catch messages logged slightly after the referenced time
  const minsAgoMatch = q.match(/\b(\d+)\s*(?:minute|min)s?\s+ago\b/);
  if (minsAgoMatch) {
    const mins = parseInt(minsAgoMatch[1]);
    const start = new Date(now.getTime() - mins * 60 * 1000);
    const end = new Date(now.getTime() + 5 * 60 * 1000);
    return { startDate: iso(start), endDate: iso(end) };
  }

  // a couple minutes ago / a few minutes ago
  if (/\b(a\s+couple(?:\s+of)?|a\s+few)\s+minutes?\s+ago\b/.test(q)) {
    const start = new Date(now.getTime() - 5 * 60 * 1000);
    const end = new Date(now.getTime() + 5 * 60 * 1000);
    return { startDate: iso(start), endDate: iso(end) };
  }

  // N hours ago / an hour or 2 ago / a couple hours ago
  const hoursAgoMatch = q.match(/\b(\d+)\s*(?:hour|hr)s?\s+ago\b/);
  const anHourAgo = /\b(an?|one|a\s+couple(?:\s+of)?)\s+hours?\s+ago\b/.test(q);
  const hourOrTwoAgo = /\bhour\s+or\s+(?:two|2)\s+ago\b/.test(q);
  if (hoursAgoMatch) {
    const hrs = parseInt(hoursAgoMatch[1]);
    const start = new Date(now.getTime() - hrs * 3600 * 1000);
    return { startDate: iso(start), endDate: iso(now) };
  }
  if (anHourAgo || hourOrTwoAgo) {
    const hrs = hourOrTwoAgo ? 2 : 1;
    const start = new Date(now.getTime() - hrs * 3600 * 1000);
    return { startDate: iso(start), endDate: iso(now) };
  }

  // Time-of-day range: "6 to 9am", "around 6 to 9am", "between 6am and 9am", "9 - 11am"
  const timeRangeMatch = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?\s*(?:to|and|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (timeRangeMatch) {
    const h1 = parseInt(timeRangeMatch[1]);
    const m1 = timeRangeMatch[2] ? parseInt(timeRangeMatch[2]) : 0;
    const h2 = parseInt(timeRangeMatch[3]);
    const m2 = timeRangeMatch[4] ? parseInt(timeRangeMatch[4]) : 59;
    const meridiem = timeRangeMatch[5];
    const offset = meridiem === 'pm' && h2 < 12 ? 12 : 0;
    const start = new Date(now); start.setHours(h1 + offset, m1, 0, 0);
    const end = new Date(now); end.setHours(h2 + offset, m2, 59, 999);
    return { startDate: iso(start), endDate: iso(end) };
  }

  // last N hours
  const hoursMatch = q.match(/\blast\s+(\d+)\s+hours?\b/);
  if (hoursMatch || /\b(last hour|past hour|few hours)\b/.test(q)) {
    const hrs = hoursMatch ? parseInt(hoursMatch[1]) : 1;
    const start = new Date(now.getTime() - hrs * 3600 * 1000);
    return { startDate: iso(start), endDate: iso(now) };
  }

  // last N days
  const daysMatch = q.match(/\blast\s+(\d+)\s+days?\b/);
  if (daysMatch) {
    const start = new Date(now); start.setDate(start.getDate() - parseInt(daysMatch[1]));
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // last N weeks
  const weeksMatch = q.match(/\blast\s+(\d+)\s+weeks?\b/);
  if (weeksMatch) {
    const start = new Date(now); start.setDate(start.getDate() - parseInt(weeksMatch[1]) * 7);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // last N months
  const monthsMatch = q.match(/\blast\s+(\d+)\s+months?\b/);
  if (monthsMatch) {
    const start = new Date(now); start.setMonth(start.getMonth() - parseInt(monthsMatch[1]));
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // this week
  if (/\bthis week\b/.test(q)) {
    const start = new Date(now); start.setDate(start.getDate() - start.getDay());
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // last week
  if (/\blast week\b/.test(q)) {
    const start = new Date(now); start.setDate(start.getDate() - start.getDay() - 7);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(end)) };
  }

  // this month
  if (/\bthis month\b/.test(q)) {
    const start = new Date(y, m, 1);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // last month
  if (/\blast month\b/.test(q)) {
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(end)) };
  }

  // this year
  if (/\bthis year\b/.test(q)) {
    return { startDate: iso(new Date(y, 0, 1)), endDate: iso(endOf(now)) };
  }

  // last year
  if (/\blast year\b/.test(q)) {
    // Check if a specific month is also mentioned (e.g. "last year in Jan between 10th-15th")
    const monthIdx = MONTHS.findIndex(mn => q.includes(mn) || q.includes(mn.slice(0,3)));
    if (monthIdx >= 0) {
      const targetYear = y - 1;
      // Check for day range: "between 10th and 15th" / "10 to 15" / "10th - 15th"
      const rangeMatch = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|through|and|-)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
      if (rangeMatch) {
        const d1 = parseInt(rangeMatch[1]), d2 = parseInt(rangeMatch[2]);
        return {
          startDate: iso(startOf(new Date(targetYear, monthIdx, d1))),
          endDate:   iso(endOf(new Date(targetYear, monthIdx, d2)))
        };
      }
      return {
        startDate: iso(startOf(new Date(targetYear, monthIdx, 1))),
        endDate:   iso(endOf(new Date(targetYear, monthIdx + 1, 0)))
      };
    }
    return { startDate: iso(new Date(y - 1, 0, 1)), endDate: iso(new Date(y - 1, 11, 31, 23, 59, 59)) };
  }

  // Named month with optional year and optional day range
  // e.g. "in January", "last January", "in Jan 2025", "January 10-15", "Jan 10th to 15th"
  const monthIdx = MONTHS.findIndex(mn => q.includes(mn) || q.includes(mn.slice(0,3)));
  if (monthIdx >= 0) {
    const yearMatch = q.match(/\b(20\d{2})\b/);
    const targetYear = yearMatch ? parseInt(yearMatch[1]) : (monthIdx > m ? y - 1 : y);
    const rangeMatch = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|through|and|-)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (rangeMatch) {
      const d1 = parseInt(rangeMatch[1]), d2 = parseInt(rangeMatch[2]);
      return {
        startDate: iso(startOf(new Date(targetYear, monthIdx, d1))),
        endDate:   iso(endOf(new Date(targetYear, monthIdx, d2)))
      };
    }
    const singleDay = q.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (singleDay) {
      const d = parseInt(singleDay[1]);
      return {
        startDate: iso(startOf(new Date(targetYear, monthIdx, d))),
        endDate:   iso(endOf(new Date(targetYear, monthIdx, d)))
      };
    }
    return {
      startDate: iso(startOf(new Date(targetYear, monthIdx, 1))),
      endDate:   iso(endOf(new Date(targetYear, monthIdx + 1, 0)))
    };
  }

  return null; // No date reference — no filter, search full history
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

    // If no dateRange and this is a short continuation (≤4 words like "anything else", "what else",
    // "more", "go on"), inherit the dateRange from the most recent prior user message that had one.
    // This makes follow-ups stay in the same temporal context as the prior query.
    const msgWords = (resolvedMessage || message).trim().split(/\s+/).filter(Boolean).length;
    if (!dateRange && msgWords <= 4 && context?.sessionId) {
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
    const conversationHistory = primaryMessages
      .map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'assistant',
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

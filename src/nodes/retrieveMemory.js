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
    const m = str.match(/\b(?:at|around|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) return null;
    let hour = parseInt(m[1]);
    const minute = m[2] ? parseInt(m[2]) : 0;
    const meridiem = m[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    else if (meridiem === 'am' && hour === 12) hour = 0;
    else if (!meridiem && hour >= 1 && hour <= 6) hour += 12; // 1-6 without am/pm → pm
    return { hour, minute };
  }

  // today / this morning / this afternoon / this evening
  if (/\b(today|this morning|this afternoon|this evening)\b/.test(q)) {
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
  const minsAgoMatch = q.match(/\b(\d+)\s*(?:minute|min)s?\s+ago\b/);
  if (minsAgoMatch) {
    const mins = parseInt(minsAgoMatch[1]);
    const start = new Date(now.getTime() - mins * 60 * 1000);
    return { startDate: iso(start), endDate: iso(now) };
  }

  // a couple minutes ago / a few minutes ago
  if (/\b(a\s+couple(?:\s+of)?|a\s+few)\s+minutes?\s+ago\b/.test(q)) {
    const start = new Date(now.getTime() - 5 * 60 * 1000);
    return { startDate: iso(start), endDate: iso(now) };
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

  // Time-of-day range: "6 to 9am", "around 6 to 9am", "between 6am and 9am"
  const timeRangeMatch = q.match(/\b(\d{1,2})(?::\d{2})?\s*(?:am|pm)?\s*(?:to|and|-)\s*(\d{1,2})(?::\d{2})?\s*(am|pm)\b/);
  if (timeRangeMatch) {
    const h1 = parseInt(timeRangeMatch[1]);
    const h2 = parseInt(timeRangeMatch[2]);
    const meridiem = timeRangeMatch[3];
    const offset = meridiem === 'pm' && h2 < 12 ? 12 : 0;
    const start = new Date(now); start.setHours(h1 + offset, 0, 0, 0);
    const end = new Date(now); end.setHours(h2 + offset, 59, 59, 999);
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
        ? (() => {
            const dateRange = parseDateRange(resolvedMessage || message);
            const searchQuery = buildSearchQuery(message, resolvedMessage);
            // When a date range is applied, lower similarity threshold — the time filter
            // does the heavy lifting; we don't want to miss results due to semantic mismatch
            const minSimilarity = dateRange ? 0.1 : 0.25;
            logger.debug(`[Node:RetrieveMemory] Search query: "${searchQuery}" | dateRange: ${dateRange ? JSON.stringify(dateRange) : 'none'} | minSimilarity: ${minSimilarity}`);
            return mcpAdapter.callService('user-memory', 'memory.search', {
              query: searchQuery,
              limit: 10,
              userId: context?.userId,
              minSimilarity,
              ...(dateRange || {})
            }).catch(err => {
              logger.warn('[Node:RetrieveMemory] Memory search failed:', err.message);
              return { results: [] };
            });
          })()
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

'use strict';

/**
 * parseDateRange.js — shared natural-language date parser
 *
 * Parses date/time references from a query string into { startDate, endDate }
 * ISO-formatted strings suitable for DuckDB timestamp comparisons.
 * Returns null when no date hint is found (caller decides the fallback window).
 *
 * Handles:
 *   "today", "yesterday", "this morning/afternoon/evening"
 *   "last N minutes/hours/days/weeks/months", "past N …"
 *   "N minutes/hours/days/weeks/months/years ago"
 *   "this week/month/year", "last week/month/year"
 *   "in January", "last January", "in Jan 2025"
 *   "January 10th–15th", "Jan 10 to Jan 15"
 *   "last year in Jan between 10th and 15th"
 *   "3 years ago", "like 3 years ago"
 *   Word-form numbers: "three days ago", "a couple minutes ago"
 */

const MONTHS = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
];

const WORD_NUMBERS = {
  one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20,
  'twenty-one':21, 'twenty-two':22, 'twenty-three':23, 'twenty-four':24,
  'twenty-five':25, 'twenty-six':26, 'twenty-seven':27, 'twenty-eight':28,
  'twenty-nine':29, thirty:30,
};

function normaliseWordNumbers(str) {
  return str.replace(
    /\b(twenty-(?:one|two|three|four|five|six|seven|eight|nine)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)\b/gi,
    (m) => {
      const n = WORD_NUMBERS[m.toLowerCase()];
      return n !== undefined ? String(n) : m;
    },
  );
}

function parseDateRange(message) {
  const raw = (message || '').toLowerCase();
  const q = normaliseWordNumbers(raw);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const pad = n => String(n).padStart(2, '0');
  // iso() outputs UTC string to match DuckDB's UTC-stored timestamps (now() = UTC).
  // All date math is done in local time first, then converted to UTC for the DB query.
  const iso = d => d.toISOString().slice(0, 19).replace('T', ' ');
  const startOf = d => { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; };
  const endOf   = d => { const r = new Date(d); r.setHours(23, 59, 59, 999); return r; };

  function parseTimeOfDay(str) {
    if (/\bnoon\b/.test(str)) return { hour: 12, minute: 0 };
    if (/\bmidnight\b/.test(str)) return { hour: 0, minute: 0 };
    const tm = str.match(/\b(?:at|around|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!\s*(?:min|mins|minutes|hour|hours|hrs|ago|seconds?|sec))\b/);
    if (!tm) return null;
    let hour = parseInt(tm[1]);
    const minute = tm[2] ? parseInt(tm[2]) : 0;
    const meridiem = tm[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    else if (meridiem === 'am' && hour === 12) hour = 0;
    else if (!meridiem && hour >= 1 && hour <= 6) hour += 12;
    return { hour, minute };
  }

  // before/until Xam/pm
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
      const wm = 30;
      const start = new Date(now); start.setHours(tod.hour, Math.max(0, tod.minute - wm), 0, 0);
      const end   = new Date(now); end.setHours(tod.hour, tod.minute + wm, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    return { startDate: iso(startOf(now)), endDate: iso(endOf(now)) };
  }

  // yesterday
  if (/\byesterday\b/.test(q)) {
    const d = new Date(now); d.setDate(d.getDate() - 1);
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
      const wm = 30;
      const start = new Date(d); start.setHours(tod.hour, Math.max(0, tod.minute - wm), 0, 0);
      const end   = new Date(d); end.setHours(tod.hour, tod.minute + wm, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    return { startDate: iso(startOf(d)), endDate: iso(endOf(d)) };
  }

  // "at 3pm", "at noon" — no other temporal anchor — assume today
  if (!q.match(/\b(today|yesterday|this|last|week|month|year|ago)\b/)) {
    const tod = parseTimeOfDay(q);
    if (tod) {
      const wm = 30;
      const start = new Date(now); start.setHours(tod.hour, Math.max(0, tod.minute - wm), 0, 0);
      const end   = new Date(now); end.setHours(tod.hour, tod.minute + wm, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
  }

  // last N minutes / past N minutes
  const minsMatch = q.match(/\b(?:last|past|in\s+(?:the\s+)?last)\s+(\d+)\s*(?:minute|min)s?\b/);
  if (minsMatch) {
    const mins = parseInt(minsMatch[1]);
    return { startDate: iso(new Date(now.getTime() - mins * 60000)), endDate: iso(now) };
  }

  // N minutes ago
  const minsAgoMatch = q.match(/\b(\d+)\s*(?:minute|min)s?\s+ago\b/);
  if (minsAgoMatch) {
    const mins = parseInt(minsAgoMatch[1]);
    return {
      startDate: iso(new Date(now.getTime() - mins * 60000)),
      endDate:   iso(new Date(now.getTime() + 5 * 60000)),
    };
  }

  // a couple / a few minutes ago
  if (/\b(a\s+couple(?:\s+of)?|a\s+few)\s+minutes?\s+ago\b/.test(q)) {
    return {
      startDate: iso(new Date(now.getTime() - 5 * 60000)),
      endDate:   iso(new Date(now.getTime() + 5 * 60000)),
    };
  }

  // N hours ago
  const hoursAgoMatch = q.match(/\b(\d+)\s*(?:hour|hr)s?\s+ago\b/);
  const anHourAgo   = /\b(an?|one|a\s+couple(?:\s+of)?)\s+hours?\s+ago\b/.test(q);
  const hourOrTwoAgo = /\bhour\s+or\s+(?:two|2)\s+ago\b/.test(q);
  if (hoursAgoMatch) {
    const hrs = parseInt(hoursAgoMatch[1]);
    return { startDate: iso(new Date(now.getTime() - hrs * 3600000)), endDate: iso(now) };
  }
  if (anHourAgo || hourOrTwoAgo) {
    const hrs = hourOrTwoAgo ? 2 : 1;
    return { startDate: iso(new Date(now.getTime() - hrs * 3600000)), endDate: iso(now) };
  }

  // Time-of-day range (guard: no 'ago')
  const timeRangeMatch = !/\bago\b/.test(q) && q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?\s*(?:to|and|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (timeRangeMatch) {
    const h1 = parseInt(timeRangeMatch[1]), m1 = timeRangeMatch[2] ? parseInt(timeRangeMatch[2]) : 0;
    const h2 = parseInt(timeRangeMatch[3]), m2 = timeRangeMatch[4] ? parseInt(timeRangeMatch[4]) : 59;
    const meridiem = timeRangeMatch[5];
    const offset = meridiem === 'pm' && h2 < 12 ? 12 : 0;
    const start = new Date(now); start.setHours(h1 + offset, m1, 0, 0);
    const end   = new Date(now); end.setHours(h2 + offset, m2, 59, 999);
    return { startDate: iso(start), endDate: iso(end) };
  }

  // last N hours
  const hoursMatch = q.match(/\blast\s+(\d+)\s+hours?\b/);
  if (hoursMatch || /\b(last hour|past hour|few hours)\b/.test(q)) {
    const hrs = hoursMatch ? parseInt(hoursMatch[1]) : 1;
    return { startDate: iso(new Date(now.getTime() - hrs * 3600000)), endDate: iso(now) };
  }

  // last N days / past N days / over the past N days
  const daysMatch = q.match(/\b(?:last|past|over\s+(?:the\s+)?past|during\s+(?:the\s+)?(?:last|past)|in\s+(?:the\s+)?past)\s+(\d+)\s*days?\b/);
  if (daysMatch) {
    const start = new Date(now); start.setDate(start.getDate() - parseInt(daysMatch[1]));
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // N days ago
  const daysAgoMatch = q.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgoMatch[1]));
    const trm = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|and|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (trm) {
      let h1 = parseInt(trm[1]), m1 = trm[2] ? parseInt(trm[2]) : 0;
      let h2 = parseInt(trm[4]), m2 = trm[5] ? parseInt(trm[5]) : 59;
      const mer1 = trm[3], mer2 = trm[6], mer = mer2 || mer1;
      if (mer === 'pm' && h2 < 12) { if (h1 < 12 && !mer1) h1 += 12; h2 += 12; }
      else if (mer === 'am' && h1 === 12) h1 = 0;
      const start = new Date(d); start.setHours(h1, m1, 0, 0);
      const end   = new Date(d); end.setHours(h2, m2, 59, 999);
      return { startDate: iso(start), endDate: iso(end) };
    }
    const tod = parseTimeOfDay(q);
    if (tod && !/\bsame\b/.test(q)) {
      const wm = 30;
      const start = new Date(d); start.setHours(tod.hour, 0, 0, 0); start.setMinutes(tod.minute - wm);
      const end   = new Date(d); end.setHours(tod.hour, 0, 0, 0);   end.setMinutes(tod.minute + wm);
      end.setSeconds(59);
      return { startDate: iso(start), endDate: iso(end) };
    }
    return { startDate: iso(startOf(d)), endDate: iso(endOf(d)) };
  }

  // N weeks ago
  const weeksAgoMatch = q.match(/\b(\d+)\s+weeks?\s+ago\b/);
  if (weeksAgoMatch) {
    const d = new Date(now); d.setDate(d.getDate() - parseInt(weeksAgoMatch[1]) * 7);
    return { startDate: iso(startOf(d)), endDate: iso(endOf(d)) };
  }

  // N months ago
  const monthsAgoMatch = q.match(/\b(\d+)\s+months?\s+ago\b/);
  if (monthsAgoMatch) {
    const d = new Date(now); d.setMonth(d.getMonth() - parseInt(monthsAgoMatch[1]));
    return { startDate: iso(startOf(d)), endDate: iso(endOf(d)) };
  }

  // N years ago (e.g. "3 years ago", "like 3 years ago", "about 2 years ago")
  // Returns the entire calendar year that was N years back.
  const yearsAgoMatch = q.match(/\b(\d+)\s+years?\s+ago\b/);
  if (yearsAgoMatch) {
    const targetYear = now.getFullYear() - parseInt(yearsAgoMatch[1]);
    return {
      startDate: iso(new Date(targetYear, 0, 1, 0, 0, 0)),
      endDate:   iso(new Date(targetYear, 11, 31, 23, 59, 59)),
    };
  }

  // last N weeks / past N weeks / over the past N weeks
  const weeksMatch = q.match(/\b(?:last|past|over\s+(?:the\s+)?past)\s+(\d+)\s*weeks?\b/);
  if (weeksMatch) {
    const start = new Date(now); start.setDate(start.getDate() - parseInt(weeksMatch[1]) * 7);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // last N months / past N months / over the past N months
  const monthsMatch = q.match(/\b(?:last|past|over\s+(?:the\s+)?past)\s+(\d+)\s*months?\b/);
  if (monthsMatch) {
    const start = new Date(now); start.setMonth(start.getMonth() - parseInt(monthsMatch[1]));
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // past week / over the past week (no digit — defaults to 7 days)
  if (/\b(?:past|over\s+(?:the\s+)?past)\s+week\b/.test(q)) {
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(now)) };
  }

  // past few days / past couple of days / over the past few weeks (vague quantifiers)
  const fewMatch = q.match(/\b(?:past|over\s+(?:the\s+)?past)\s+(few|couple(?:\s+of)?)\s+(days?|weeks?)\b/);
  if (fewMatch) {
    const isFew = fewMatch[1] === 'few';
    const isWeeks = /week/.test(fewMatch[2]);
    const n = isWeeks ? (isFew ? 3 : 2) : (isFew ? 3 : 2);
    const start = new Date(now); start.setDate(start.getDate() - n * (isWeeks ? 7 : 1));
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
    return { startDate: iso(startOf(new Date(y, m, 1))), endDate: iso(endOf(now)) };
  }

  // last month
  if (/\blast month\b/.test(q)) {
    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m, 0);
    return { startDate: iso(startOf(start)), endDate: iso(endOf(end)) };
  }

  // this year
  if (/\bthis year\b/.test(q)) {
    return { startDate: iso(new Date(y, 0, 1)), endDate: iso(endOf(now)) };
  }

  // last year
  if (/\blast year\b/.test(q)) {
    const monthIdx = MONTHS.findIndex(mn => q.includes(mn) || q.includes(mn.slice(0, 3)));
    if (monthIdx >= 0) {
      const targetYear = y - 1;
      const rangeMatch = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|through|and|-)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
      if (rangeMatch) {
        const d1 = parseInt(rangeMatch[1]), d2 = parseInt(rangeMatch[2]);
        return {
          startDate: iso(startOf(new Date(targetYear, monthIdx, d1))),
          endDate:   iso(endOf(new Date(targetYear, monthIdx, d2))),
        };
      }
      return {
        startDate: iso(startOf(new Date(targetYear, monthIdx, 1))),
        endDate:   iso(endOf(new Date(targetYear, monthIdx + 1, 0))),
      };
    }
    return {
      startDate: iso(new Date(y - 1, 0, 1)),
      endDate:   iso(new Date(y - 1, 11, 31, 23, 59, 59)),
    };
  }

  // Named month with optional year and optional day range
  const monthIdx = MONTHS.findIndex(mn => q.includes(mn) || q.includes(mn.slice(0, 3)));
  if (monthIdx >= 0) {
    const yearMatch  = q.match(/\b(20\d{2})\b/);
    const targetYear = yearMatch ? parseInt(yearMatch[1]) : (monthIdx > m ? y - 1 : y);
    const rangeMatch = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|through|and|-)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (rangeMatch) {
      const d1 = parseInt(rangeMatch[1]), d2 = parseInt(rangeMatch[2]);
      return {
        startDate: iso(startOf(new Date(targetYear, monthIdx, d1))),
        endDate:   iso(endOf(new Date(targetYear, monthIdx, d2))),
      };
    }
    const singleDay = q.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (singleDay) {
      const multiDay = [...q.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)].map(m => parseInt(m[1]));
      if (multiDay.length > 1) {
        const d1 = Math.min(...multiDay), d2 = Math.max(...multiDay);
        return {
          startDate: iso(startOf(new Date(targetYear, monthIdx, d1))),
          endDate:   iso(endOf(new Date(targetYear, monthIdx, d2))),
        };
      }
      const d = parseInt(singleDay[1]);
      return {
        startDate: iso(startOf(new Date(targetYear, monthIdx, d))),
        endDate:   iso(endOf(new Date(targetYear, monthIdx, d))),
      };
    }
    return {
      startDate: iso(startOf(new Date(targetYear, monthIdx, 1))),
      endDate:   iso(endOf(new Date(targetYear, monthIdx + 1, 0))),
    };
  }

  return null; // No date reference found
}

module.exports = { parseDateRange, normaliseWordNumbers, MONTHS };

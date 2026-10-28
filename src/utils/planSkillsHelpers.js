'use strict';

const { parseLlmJson } = require('./parseLlmJson');

/**
 * planSkillsHelpers.js — contract-driven execution helpers extracted from planSkills.js
 *
 * Pure utility functions (no stategraph state, no side effects):
 *   - resolveDateRange        — NL date phrases → UTC ISO token set (no LLM)
 *   - extractMessageParams    — extract phone/email/url/amount from user message
 *   - buildRuntimeParams      — compose full param set (message + profile + prior body)
 *   - substituteTokens        — replace {{TOKEN}} placeholders in a code string
 */
function resolveDateRange(userMessage, now = new Date()) {
  const msg = userMessage.toLowerCase();
  const WORD_TO_N = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
  const msgN = msg.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => WORD_TO_N[w]);

  const p = n => String(n).padStart(2, '0');
  const iso = d => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
  const dateOnly = d => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const unix = d => Math.floor(d.getTime() / 1000);
  const startOfUTCDay = d => { const r = new Date(d); r.setUTCHours(0, 0, 0, 0); return r; };
  const endOfUTCDay = d => { const r = new Date(d); r.setUTCHours(23, 59, 59, 999); return r; };

  const pack = (s, e) => ({
    timeMin: iso(s), timeMax: iso(e),
    TIME_MIN: iso(s), TIME_MAX: iso(e),
    UNIX_MIN: unix(s), UNIX_MAX: unix(e),
    DATE_MIN: dateOnly(s), DATE_MAX: dateOnly(e),
  });

  // ── N-based patterns ──────────────────────────────────────────────────────────
  let m;
  m = msgN.match(/(\d+)\s+minutes?\s+ago/);
  if (m) { const s = new Date(now - m[1]*60000); return pack(s, now); }
  m = msgN.match(/(\d+)\s+hours?\s+ago/);
  if (m) { const s = new Date(now - m[1]*3600000); return pack(s, now); }
  m = msgN.match(/(\d+)\s+days?\s+ago/);
  if (m) { const s = startOfUTCDay(new Date(now - (m[1]-1)*86400000)); const e = endOfUTCDay(new Date(now - (m[1]-1)*86400000)); return pack(s, e); }
  m = msgN.match(/(\d+)\s+weeks?\s+ago/);
  if (m) { const anchor = new Date(now - m[1]*7*86400000); return pack(startOfUTCDay(anchor), endOfUTCDay(anchor)); }
  m = msgN.match(/(?:last|past)\s+(\d+)\s+minutes?/);
  if (m) { return pack(new Date(now - m[1]*60000), now); }
  m = msgN.match(/(?:last|past)\s+(\d+)\s+hours?/);
  if (m) { return pack(new Date(now - m[1]*3600000), now); }
  m = msgN.match(/(?:last|past)\s+(\d+)\s+days?/);
  if (m) { return pack(new Date(now - m[1]*86400000), now); }
  m = msgN.match(/(?:last|past)\s+(\d+)\s+weeks?/);
  if (m) { return pack(new Date(now - m[1]*7*86400000), now); }
  m = msgN.match(/(?:last|past)\s+(\d+)\s+months?/);
  if (m) { return pack(new Date(now - m[1]*30*86400000), now); }

  // ── Fixed-length fuzzy-count phrases ──────────────────────────────────────────
  if (/\ba\s+couple\s+(?:of\s+)?hours?\s+ago/.test(msg)) return pack(new Date(now - 2*3600000), now);
  if (/\ba\s+couple\s+(?:of\s+)?days?\s+ago/.test(msg)) return pack(new Date(now - 2*86400000), now);
  if (/\ba\s+few\s+hours?\s+ago/.test(msg)) return pack(new Date(now - 3*3600000), now);
  if (/\ba\s+few\s+days?\s+ago/.test(msg)) return pack(new Date(now - 3*86400000), now);
  if (/\ba\s+few\s+weeks?\s+ago/.test(msg)) return pack(new Date(now - 3*7*86400000), now);

  // ── Time-of-day phrases ───────────────────────────────────────────────────────
  if (/\bthis\s+morning/.test(msg)) { const s = startOfUTCDay(now); const e = new Date(now); e.setUTCHours(11,59,59,999); return pack(s, e); }
  if (/\bthis\s+afternoon/.test(msg)) { const s = new Date(now); s.setUTCHours(12,0,0,0); const e = new Date(now); e.setUTCHours(17,59,59,999); return pack(s, e); }
  if (/\bthis\s+evening/.test(msg)) { const s = new Date(now); s.setUTCHours(18,0,0,0); const e = endOfUTCDay(now); return pack(s, e); }

  // ── Named single-day phrases ──────────────────────────────────────────────────
  if (/\btoday/.test(msg)) return pack(startOfUTCDay(now), endOfUTCDay(now));
  if (/\byesterday/.test(msg)) { const y = new Date(now - 86400000); return pack(startOfUTCDay(y), endOfUTCDay(y)); }

  // ── Weekend phrases ───────────────────────────────────────────────────────────
  if (/\blast\s+weekend/.test(msg)) {
    const dow = now.getUTCDay();
    const daysToSat = dow === 0 ? 8 : (dow + 1);
    const sat = new Date(now - daysToSat*86400000);
    const sun = new Date(sat.getTime() + 86400000);
    return pack(startOfUTCDay(sat), endOfUTCDay(sun));
  }
  if (/\bthis\s+weekend/.test(msg)) {
    const dow = now.getUTCDay();
    const daysToSat = dow <= 6 ? (6 - dow) : 0;
    const sat = new Date(now.getTime() + daysToSat*86400000);
    const sun = new Date(sat.getTime() + 86400000);
    return pack(startOfUTCDay(sat), endOfUTCDay(sun));
  }

  // ── Week phrases ───────────────────────────────────────────────────────────────
  if (/\bthis\s+week/.test(msg)) {
    const dow = now.getUTCDay();
    const mon = new Date(now - (dow === 0 ? 6 : dow - 1)*86400000);
    const sun = new Date(mon.getTime() + 6*86400000);
    return pack(startOfUTCDay(mon), endOfUTCDay(sun));
  }
  if (/\blast\s+week/.test(msg)) {
    const dow = now.getUTCDay();
    const thisMon = new Date(now - (dow === 0 ? 6 : dow - 1)*86400000);
    const lastMon = new Date(thisMon.getTime() - 7*86400000);
    const lastSun = new Date(lastMon.getTime() + 6*86400000);
    return pack(startOfUTCDay(lastMon), endOfUTCDay(lastSun));
  }

  // ── Month phrases ─────────────────────────────────────────────────────────────
  if (/\bthis\s+month/.test(msg)) {
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    return pack(s, e);
  }
  if (/\blast\s+month/.test(msg)) {
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
    return pack(s, e);
  }

  // ── Year phrases ───────────────────────────────────────────────────────────────
  if (/\bthis\s+year/.test(msg)) {
    const s = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const e = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
    return pack(s, e);
  }
  if (/\blast\s+year/.test(msg)) {
    const y = now.getUTCFullYear() - 1;
    return pack(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)));
  }

  return null;
}

/**
 * Extract PII/contact params from a user message.
 * Returns { TO, PHONE, EMAIL, URL, AMOUNT, ZIP, FILENAME } or null.
 */
function extractMessageParams(userMessage) {
  if (!userMessage) return null;
  const params = {};
  const msg = userMessage.trim();

  const _toPhone = msg.match(/\bto\s+\+?1?\s*[-.]?\s*([2-9]\d{2})\s*[-.]?\s*(\d{3})\s*[-.]?\s*(\d{4})\b/i);
  if (_toPhone) {
    params.TO = `+1${_toPhone[1]}${_toPhone[2]}${_toPhone[3]}`;
    params.PHONE = params.TO;
  } else {
    const _e164 = msg.match(/(\+1[2-9]\d{9}|\+[2-9]\d{6,14})\b/);
    if (_e164) {
      params.TO = _e164[1]; params.PHONE = _e164[1];
    } else {
      const _bare10 = msg.match(/\b([2-9]\d{2})[.\-\s]?(\d{3})[.\-\s]?(\d{4})\b/);
      if (_bare10) { params.TO = `+1${_bare10[1]}${_bare10[2]}${_bare10[3]}`; params.PHONE = params.TO; }
    }
  }

  const _email = msg.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
  if (_email) { params.EMAIL = _email[1]; if (!params.TO) params.TO = _email[1]; }

  const _url = msg.match(/https?:\/\/[^\s"'<>]+/i);
  if (_url) params.URL = _url[0];

  const _amt = msg.match(/\$\s*(\d+(?:\.\d{1,2})?)\b/) || msg.match(/\b(\d+(?:\.\d{2}))\s*(?:dollars?|usd|eur|gbp)\b/i);
  if (_amt) params.AMOUNT = _amt[1];

  const _zip = msg.match(/\b(\d{5}(?:-\d{4})?)\b/);
  if (_zip) params.ZIP = _zip[1];

  const _file = msg.match(/\b([\w.\-]+\.(pdf|docx?|xlsx?|csv|txt|png|jpe?g|gif|mp3|mp4|zip))\b/i);
  if (_file) params.FILENAME = _file[1];

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Build the full set of runtime substitution params.
 * Combines extractMessageParams + profile facts fallback + shell-safe BODY.
 */
function buildRuntimeParams(userMessage, profileContext, priorSynthesizedContent) {
  const params = {};
  const msgParams = extractMessageParams(userMessage);
  if (msgParams) Object.assign(params, msgParams);
  if (!params.TO && profileContext?.facts) {
    const myPhone = profileContext.facts.find(f => f.field === 'my_phone');
    if (myPhone?.value) { params.TO = myPhone.value; params.PHONE = myPhone.value; }
    const myEmail = profileContext.facts.find(f => f.field === 'my_email');
    if (myEmail?.value && !params.MY_EMAIL) params.MY_EMAIL = myEmail.value;
  }
  if (priorSynthesizedContent && !params.BODY) {
    params.BODY = priorSynthesizedContent
      .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`')
      .replace(/\$/g, '\\$').replace(/\r/g, '').replace(/\n/g, '\\n')
      .slice(0, 1200);
  }
  return params;
}

/**
 * Substitute all {{TOKEN}} placeholders in `code` with values from `params`.
 * Uses split/join to avoid $-special-char issues in String.replace().
 */
function substituteTokens(code, params, logger) {
  if (!code || !code.includes('{{')) return code;
  let result = code;
  for (const [k, v] of Object.entries(params)) {
    const tok = `{{${k}}}`;
    if (result.includes(tok)) {
      result = result.split(tok).join(String(v));
      if (logger) logger.info(`[planSkillsHelpers:substituteTokens] resolved {{${k}}}`);
    }
  }
  return result;
}


module.exports = {
  resolveDateRange,
  extractMessageParams,
  buildRuntimeParams,
  substituteTokens,
};

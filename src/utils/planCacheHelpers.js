'use strict';

/**
 * planCacheHelpers.js
 *
 * Shared plan-cache utilities used by planSkills.js and checkPlanCache.js.
 * Exported as a module singleton so the in-memory session cache (_SESSION_CACHE)
 * is shared between both callers regardless of which one populates it first.
 *
 * Cache strategy (industry-standard):
 *   - Exact normalized match   → auto-execute immediately, no modal
 *   - Semantic cosine ≥ 0.85   → show approval modal (suggest, never silently execute)
 *   - Semantic cosine 0.50–0.84 → show approval modal (lower confidence)
 *   - Semantic cosine < 0.50   → no cache hit, plan fresh
 *   - Dot-syntax named recall  → auto-execute (explicit user intent)
 *
 * Responsibilities:
 *   - normalizePrompt()         — canonical exact-match key
 *   - cosineDistance()          — pure JS cosine similarity on float arrays
 *   - findSimilarCompletePlan() — async: exact session hit OR semantic disk search
 *   - Session LRU cache         — zero-disk-I/O exact-repeat cache
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

/**
 * Cache-complete test: a plan file is reusable content when status is
 * 'complete' — OR it's a completed comms-graph task plan (status 'done' +
 * kind: task_plan) whose flattened skill_plan_json was bridged in by
 * planRunner on terminal write. Task plans keep 'done' for the Plans UI;
 * skill_plan_json presence is what certifies the file as a compiled,
 * replayable procedure.
 */
function _isCacheCompleteContent(content, status) {
  if (status === 'complete') return true;
  if (status !== 'done') return false;
  return /kind:\s*task_plan/.test(content) && /skill_plan_json:\s*'/.test(content);
}

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');
const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

// ── Semantic similarity thresholds ────────────────────────────────────────────
/** Minimum cosine similarity to surface a plan as a suggestion (modal). */
const SEMANTIC_SUGGEST_THRESHOLD = 0.50;
/**
 * Cosine threshold for slot-gated auto-execute. A semantic match at/above this
 * AND identical extracted slots (emails/URLs/paths/quotes/numbers) means the
 * prompt is a paraphrase of the cached one — safe to run without the modal.
 * Below it, or with any slot mismatch, the hit stays a suggestion modal.
 */
const SLOT_AUTOEXECUTE_THRESHOLD = 0.90;

// ── Slot extraction for one-to-one cache safety ───────────────────────────────
// "Goto Amazon and add baby wipes" vs "On Amazon add baby wipes to my cart" —
// same slots (none) → paraphrase → auto-exec. "Email somebody@gmail.com" vs
// "Email dentist info to jake@gmail.com" — recipient slots differ → never
// auto-exec, or the plan would run with the wrong address.
const _SLOT_RES = {
  emails: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi,
  urls: /https?:\/\/[^\s"'<>)\]]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|co|edu|gov|info|me|us|uk|de|fr|jp|au|ca)(?:\/[^\s"'<>)\]]*)?/gi,
  filePaths: /~\/[^\s"']+|\/(?:Users|home|tmp|var|opt|etc)\/[^\s"']+|[\w.-]+\/[\w./-]+/g,
  quotedStrings: /"([^"\n]{1,120})"|'([^'\n]{1,120})'|“([^”\n]{1,120})”/g,
  numbers: /\b\d+(?:[.,:]\d+)*\b/g,
};

function extractSlots(text) {
  const slots = {};
  // Emails overlap the URL regex — strip them first so they don't double-count.
  const stripped = String(text || '').replace(_SLOT_RES.emails, ' ');
  for (const [key, re] of Object.entries(_SLOT_RES)) {
    const src = key === 'emails' ? String(text || '') : stripped;
    re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = (m[1] || m[2] || m[3] || m[0]).toLowerCase().trim();
      if (val) hits.push(val);
    }
    slots[key] = [...new Set(hits)].sort();
  }
  return slots;
}

function slotSetsEqual(a, b) {
  const sa = typeof a === 'string' ? extractSlots(a) : a;
  const sb = typeof b === 'string' ? extractSlots(b) : b;
  for (const key of Object.keys(_SLOT_RES)) {
    const A = sa[key] || [], B = sb[key] || [];
    if (A.length !== B.length) return false;
    if (!A.every((v, i) => v === B[i])) return false;
  }
  return true;
}

// Slots must be extracted from arg VALUES, not JSON.stringify(args) — the
// serialized form puts every key/string in quotes, polluting quotedStrings
// with JSON syntax ('"cmd"', '"git"'…) that no real prompt ever carries,
// which makes every argv-literal plan ambiguous against any new prompt.
function _slotText(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => _slotText(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => _slotText(x, out));
  return out.join(' ');
}

function extractSlotsFromArgs(args) {
  return extractSlots(_slotText(args));
}

// Raw-case extraction for rebinding — extractSlots lowercases for equality
// semantics, but a substituted path must keep the prompt's original case or
// the rebound plan points at a path that doesn't exist on case-sensitive FS.
function _extractSlotsRaw(text) {
  const slots = {};
  const stripped = String(text || '').replace(_SLOT_RES.emails, ' ');
  for (const [key, re] of Object.entries(_SLOT_RES)) {
    const src = key === 'emails' ? String(text || '') : stripped;
    re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const val = (m[1] || m[2] || m[3] || m[0]).trim();
      if (val) hits.push(val);
    }
    slots[key] = [...new Set(hits)];
  }
  return slots;
}

// ── Parameterized plan replay ─────────────────────────────────────────────────
// Saved plans are the user-skill store — replaying them literally is wrong when
// the new request names different targets ("commit thinkdrop" → replay for
// "commit my-api"). rebindPlanSlots substitutes the plan's slot values with the
// new prompt's same-type values (positional, both sides sorted → deterministic),
// generalizing planExecutor's one-off stale-filename replace.
//
// Safety contract — rebind only produces auto-execute-safe output when:
//   - every differing slot binds 1:1 positionally (count mismatch → ambiguous)
//   - every resulting filePaths value exists on disk (corrupted/moved → reject)
// numbers are never rebound (a bare "5" would corrupt ports/versions — a diff
// there just keeps the hit at suggestion level).
const _REBIND_TYPES = new Set(['filePaths', 'urls', 'emails', 'quotedStrings']);

function _expandTilde(p) {
  return typeof p === 'string' ? p.replace(/^~(?=\/|$)/, os.homedir()) : p;
}

/**
 * Merge extractSlots output across a plan's step args — used to write the
 * slots_json frontmatter manifest at save time.
 */
function mergePlanSlots(skillPlan) {
  const merged = {};
  for (const step of (Array.isArray(skillPlan) ? skillPlan : [])) {
    const s = extractSlotsFromArgs(step?.args || {});
    for (const [k, vals] of Object.entries(s)) {
      if (!Array.isArray(vals) || vals.length === 0) continue;
      merged[k] = [...new Set([...(merged[k] || []), ...vals])].sort();
    }
  }
  return merged;
}

/**
 * Rebind a cached plan's slot values to the new prompt's targets.
 * @param {Array}  skillPlan  decoded step array
 * @param {string} newPrompt  the fresh request text
 * @param {object} opts       { logger, refsPaths: string[] }
 * @returns {{ ok:boolean, skillPlan:Array, bindings:Array, reason:string|null }}
 */
function rebindPlanSlots(skillPlan, newPrompt, opts = {}) {
  const { logger = null, refsPaths = [] } = opts;
  const out = { ok: false, skillPlan, bindings: [], reason: null };
  if (!Array.isArray(skillPlan) || skillPlan.length === 0) return out;

  const newSlots = _extractSlotsRaw(newPrompt || '');
  if (refsPaths.length) {
    const extra = refsPaths.map(p => String(p).trim()).filter(Boolean);
    newSlots.filePaths = [...new Set([...(newSlots.filePaths || []), ...extra])];
  }

  const planJson = JSON.stringify(skillPlan);
  const planSlots = _extractSlotsRaw(_slotText(skillPlan.map(s => s?.args)));
  let reboundJson = planJson;
  let ambiguous = null;
  const bindings = [];

  for (const [type, oldVals] of Object.entries(planSlots)) {
    const newVals = newSlots[type] || [];
    const oldLow = new Set(oldVals.map(v => v.toLowerCase()));
    const newLow = new Set(newVals.map(v => v.toLowerCase()));
    // Non-rebindable slot types (numbers): any diff makes the hit ambiguous —
    // a bare "5" can't be positionally substituted without corrupting ports,
    // versions, and counts embedded in args.
    if (!_REBIND_TYPES.has(type)) {
      const _differ = oldVals.length !== newVals.length
        || !oldVals.every((v, i) => v.toLowerCase() === (newVals[i] || '').toLowerCase());
      if (_differ && oldVals.length && newVals.length) {
        ambiguous = `${type}: plan ${JSON.stringify(oldVals)} vs prompt ${JSON.stringify(newVals)}`;
      }
      continue;
    }
    // Values the plan carries that the new prompt doesn't name → candidates
    // for replacement; values the new prompt adds beyond the plan → sources.
    // Diff is case-insensitive (a URL typed differently is still the same
    // target) but substitution preserves the prompt's raw case.
    const toReplace = oldVals.filter(v => !newLow.has(v.toLowerCase()));
    const sources   = newVals.filter(v => !oldLow.has(v.toLowerCase()));
    if (toReplace.length === 0) continue;
    if (toReplace.length !== sources.length) {
      ambiguous = `${type}: ${toReplace.length} plan value(s) vs ${sources.length} new value(s)`;
      continue;
    }
    for (let i = 0; i < toReplace.length; i++) {
      reboundJson = reboundJson.split(toReplace[i]).join(sources[i]);
      bindings.push({ type, from: toReplace[i], to: sources[i] });
    }
  }

  if (ambiguous) {
    out.reason = `ambiguous rebind — ${ambiguous}`;
    logger && logger.info(`[PlanCache] rebindPlanSlots rejected: ${out.reason}`);
    return out;
  }

  // Path-existence gate — a bound (or saved) path that no longer exists means
  // a corrupted or moved target; never auto-execute against it.
  const reboundPlan = JSON.parse(reboundJson);
  const boundPaths = _extractSlotsRaw(_slotText(reboundPlan.map(s => s?.args))).filePaths || [];
  const missing = boundPaths.filter(p => {
    const expanded = _expandTilde(p);
    try { return !fs.existsSync(expanded); } catch (_) { return true; }
  });
  if (missing.length) {
    out.reason = `bound path(s) missing on disk: ${missing.slice(0, 2).join(', ')}`;
    logger && logger.info(`[PlanCache] rebindPlanSlots rejected: ${out.reason}`);
    return out;
  }

  out.ok = true;
  out.skillPlan = reboundPlan;
  out.bindings = bindings;
  if (bindings.length) {
    logger && logger.info(`[PlanCache] rebindPlanSlots rebound ${bindings.length} slot(s): ${bindings.map(b => `${b.from}→${b.to}`).join('; ')}`);
  }
  return out;
}

// ── Cache invalidation: deprecated browser.act plans for named services ───────
const _NAMED_SERVICE_RE = /\b(google|biblegateway|wikipedia|duckduckgo|reddit|youtube|stackoverflow|amazon|ebay|twitter|x\.com|facebook|instagram|pinterest|linkedin|yelp|tripadvisor|imdb|spotify|netflix|hulu|twitch|tiktok|chatgpt|gemini|perplexity|claude|grok|deepseek|mistral|copilot|midjourney|suno|notion|slack|discord|telegram|whatsapp|github|gitlab|bitbucket)\b/i;

function _isStaleBrowserActPlan(skillPlan, prompt) {
  if (!Array.isArray(skillPlan) || skillPlan.length === 0) return false;
  if (!_NAMED_SERVICE_RE.test(prompt)) return false;
  const hasBrowserAgent = skillPlan.some(s => s.skill === 'browser.agent');
  const hasOnlyBrowserAct = !hasBrowserAgent && skillPlan.some(s => s.skill === 'browser.act');
  return hasOnlyBrowserAct;
}

// ── Cache invalidation: plans referencing deleted skills ──────────────────────
/**
 * Validate cached plans referencing external.skill steps.
 * external.skill now resolves trained recipes only (recipe.run) — a cached
 * plan step stays valid only while its recipe file still exists on disk.
 * Returns { valid: boolean, missing: string[] }.
 */
function _validatePlanSkills(skillPlan) {
  if (!Array.isArray(skillPlan)) return { valid: false, missing: [] };

  const missing = [];
  for (const step of skillPlan) {
    if (step.skill !== 'external.skill') continue;
    const name = step.args?.name;
    if (!name) { missing.push('external.skill'); continue; }
    const variants = [name, name.replace(/\./g, '_'), name.replace(/\./g, '-')];
    const found = variants.some(v =>
      fs.existsSync(path.join(SKILLS_DIR, v, 'skill.json')) ||
      fs.existsSync(path.join(SKILLS_DIR, v, 'recipe.json'))
    ) || (() => {
      try {
        for (const dir of fs.readdirSync(SKILLS_DIR)) {
          for (const v of variants) {
            if (fs.existsSync(path.join(SKILLS_DIR, dir, `${v}.skill.json`)) ||
                fs.existsSync(path.join(SKILLS_DIR, dir, `${v}.json`))) return true;
          }
        }
      } catch (_) {}
      return false;
    })();
    if (!found) missing.push(name);
  }

  return { valid: missing.length === 0, missing };
}

// ── Context mismatch detection for cached plans ─────────────────────────────────

const _COMMON_TITLE_WORDS = new Set([
  'google', 'search', 'bing', 'yahoo', 'duckduckgo', 'homepage', 'home',
  'welcome', 'loading', 'error', '404', 'page', 'new', 'tab', 'untitled',
]);

function _normalizeContextWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !_COMMON_TITLE_WORDS.has(w));
}

function _wordOverlapScore(a, b) {
  const wordsA = new Set(_normalizeContextWords(a));
  const wordsB = _normalizeContextWords(b);
  if (wordsA.size === 0) return wordsB.size === 0 ? 1 : 0;
  let hits = 0;
  for (const w of wordsB) {
    if (wordsA.has(w)) hits++;
  }
  return hits / wordsA.size;
}

function _stripCommonSuffixes(title) {
  return (title || '')
    .replace(/\s*[-|]\s*(Google Search|Bing Search|Yahoo Search|DuckDuckGo Search|Search Results)\s*$/i, '')
    .replace(/\s*[-|]\s*(Google|Bing|Yahoo|DuckDuckGo|Search)\s*$/i, '')
    .replace(/\s*[-|]\s*[^a-zA-Z0-9]*\s*$/i, '')
    .trim();
}

function extractPlanContext(content) {
  const promptMatch = content.match(/^original_prompt:\s*"([^"]+)"/m);
  const prompt = promptMatch ? promptMatch[1] : '';
  const contextMatch = prompt.match(/\(Context from prior turn:\s*(.*?)\s*\)/i);
  const rawTitle = contextMatch ? _stripCommonSuffixes(contextMatch[1]) : null;
  const urlMatch = prompt.match(/(https?:\/\/[^\s"]+)/);

  // Gate 3a: Only set title from actual "(Context from prior turn: ...)" markers
  // — NOT from the prompt string fallback. A plan with no context marker is not
  // browser-derived, so there is no browser page title to compare.
  //
  // Gate 3b: If the extracted title is a file path (starts with / or ~), it is
  // NOT a browser page title — it's a local file context. File paths can't go
  // stale relative to the browser, so there is no mismatch to detect. This
  // handles mixed plans (browser + shell.run) generated from local file context.
  let title = null;
  if (rawTitle && !/^(\/[A-Za-z0-9_/.-]+|~\/[A-Za-z0-9_/.-]+)/.test(rawTitle.trim())) {
    title = rawTitle;
  }

  return {
    prompt,
    title,
    url: urlMatch ? urlMatch[1] : null,
  };
}

function getCurrentBrowserContext(state) {
  const ctx = state._priorScreenContext || state.screenContext || {};
  return {
    appName: ctx.appName || null,
    windowTitle: ctx.windowTitle || null,
    url: ctx.url || null,
    contextText: ctx.contextText || (typeof state.context === 'string' ? state.context : null),
  };
}

function contextMismatch(planContext, currentContext) {
  if (!planContext || !currentContext) return false;

  // URL comparison is authoritative when both are present
  if (planContext.url && currentContext.url) {
    try {
      const a = new URL(planContext.url);
      const b = new URL(currentContext.url);
      const sameHost = a.hostname.toLowerCase() === b.hostname.toLowerCase();
      const samePath = a.pathname === b.pathname;
      const sameSearch = a.search === b.search;
      if (sameHost && samePath && sameSearch) return false;
      // Different page → stale context
      return true;
    } catch (_) { /* fall through to title comparison */ }
  }

  // Gate 4: If planContext.title is null, the plan was not generated from a
  // browser page context (no context marker, or the marker was a file path).
  // There is no browser page title to compare — return false (no mismatch).
  if (!planContext.title) return false;

  const planTitle = _stripCommonSuffixes(planContext.title);
  const currentTitle = _stripCommonSuffixes(
    currentContext.windowTitle || currentContext.contextText || ''
  );

  // No current browser context to compare — cannot determine mismatch
  if (!currentTitle.trim()) return false;

  // Same title (after stripping search-engine suffixes) → context unchanged
  if (planTitle.toLowerCase() === currentTitle.toLowerCase()) return false;

  // If titles share enough uncommon words, treat as same context
  const overlap = _wordOverlapScore(planTitle, currentTitle);
  return overlap < 0.3;
}

function findHardcodedDesktopFilename(skillPlan) {
  if (!Array.isArray(skillPlan)) return null;
  for (const step of skillPlan) {
    if (step.skill !== 'shell.run') continue;
    const text = JSON.stringify(step.args || {});
    // Only match Desktop paths that look like output FILES (have an extension).
    // Input directories like ~/Desktop/screenshots-for-trigger-concept-dicussion
    // have no extension and should not be treated as hardcoded output filenames.
    const match = text.match(/(?:~|\/Users\/[^/]+)\/Desktop\/([^"'\s]+\.[a-zA-Z0-9]{1,10})/i);
    if (match) return match[0];
  }
  return null;
}

function suggestFilenameFromTitle(title, ext = 'txt') {
  const base = _stripCommonSuffixes(title || 'saved_content')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 60) || 'saved_content';
  return `${base}.${ext}`;
}

// ── In-memory session cache (exact-match only) ────────────────────────────────
// Shared singleton Map — because Node caches module instances, both planSkills
// and checkPlanCache reference the same Map object.
const _SESSION_CACHE       = new Map();
const SESSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_CACHE_MAX    = 50;

/**
 * Canonical normalisation for exact-match cache keys.
 * Lowercases, collapses whitespace, strips leading/trailing punctuation.
 * Also strips run-injected metadata blocks — "[Additional context: Route: x]",
 * "[Additional context: question: answer; …]" and similar enrichment gathered
 * per-run — which vary between identical re-runs and previously broke
 * exact-match plan caching. User-authored bracket text is left alone.
 */
function normalizePrompt(text) {
  return (text || '')
    .replace(/\[\s*additional context:[^\]]*\]/gi, ' ')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _sessionCacheKey(message, sessionId = null) {
  const normalizedMessage = normalizePrompt(message);
  // Include session ID in cache key to ensure plans are cached per session
  return sessionId ? `${sessionId}:${normalizedMessage}` : normalizedMessage;
}

function _sessionCacheSet(key, skillPlan) {
  if (_SESSION_CACHE.size >= SESSION_CACHE_MAX) {
    _SESSION_CACHE.delete(_SESSION_CACHE.keys().next().value); // evict oldest
  }
  _SESSION_CACHE.set(key, { skillPlan, timestamp: Date.now() });
}

function _sessionCacheGet(key) {
  const entry = _SESSION_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SESSION_CACHE_TTL_MS) {
    _SESSION_CACHE.delete(key);
    return null;
  }
  return entry;
}

/**
 * Clear cache entries for a specific session, or clear entire cache
 * @param {string} sessionId optional: clear only entries for this session
 */
function _clearSessionCache(sessionId = null) {
  if (sessionId) {
    // Clear only entries for this session
    const keysToDelete = [];
    for (const key of _SESSION_CACHE.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      _SESSION_CACHE.delete(key);
    }
  } else {
    // Clear entire cache
    _SESSION_CACHE.clear();
  }
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two equal-length float arrays.
 * Returns a value in [0, 1]. Returns 0 if either vector is zero-length.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Dot-syntax plan name helpers ────────────────────────────────────────────

const DOT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const MAX_DOT_SEGMENTS = 5;

/**
 * Returns true if a string is a valid dot-syntax plan name.
 * Rules: lowercase letters/digits + dots only, 2-5 segments, no spaces/dashes/underscores.
 */
function isValidDotName(name) {
  if (!name || typeof name !== 'string') return false;
  if (!DOT_NAME_RE.test(name)) return false;
  const segments = name.split('.');
  return segments.length >= 2 && segments.length <= MAX_DOT_SEGMENTS;
}

/**
 * Derive a dot-syntax plan name suggestion from a plan title string.
 * e.g. "Check Perplexity History for vegan" → "perplexity.history.vegan"
 */
function deriveDotName(title) {
  const stopWords = new Set(['a','an','the','for','to','in','on','at','of','and','or','with','from','by','check','find','get','run','go']);
  const words = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))
    .slice(0, 5);
  if (words.length < 2) return '';
  const candidate = words.join('.');
  return isValidDotName(candidate) ? candidate : '';
}

/**
 * Extract a dot-syntax plan name token from a user prompt.
 * Matches patterns like "run perplexity.history.vegan", "repeat gmail.send.weekly", etc.
 */
function extractDotNameFromPrompt(prompt) {
  // Match explicit dot-syntax token in the prompt
  const match = (prompt || '').match(/\b([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,4})\b/);
  if (match && isValidDotName(match[1])) return match[1];
  return null;
}

/**
 * Find a completed plan by its user-assigned dot-syntax name.
 * Exact match only — returns same shape as findSimilarCompletePlan.
 */
function findPlanByName(planName, logger) {
  if (!isValidDotName(planName)) return null;
  try {
    if (!fs.existsSync(PLANS_DIR)) return null;
    const files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md') && f.startsWith('plan'))
      .sort().reverse()
      .slice(0, 50);

    for (const file of files) {
      const planPath = path.join(PLANS_DIR, file);
      try {
        const content = fs.readFileSync(planPath, 'utf8');
        const statusMatch = content.match(/^status:\s*(.+)/m);
        if (!statusMatch || !_isCacheCompleteContent(content, statusMatch[1].trim())) continue;
        const nameMatch = content.match(/^name:\s*([^\s]+)/m);
        if (!nameMatch || nameMatch[1].trim() !== planName) continue;
        const jsonMatch = content.match(/^skill_plan_json:\s*'([^']+)'/m);
        if (!jsonMatch) continue;
        const titleMatch = content.match(/^# Plan:\s*(.+)/m);
        const decoded = Buffer.from(jsonMatch[1], 'base64').toString('utf8');
        const skillPlan = JSON.parse(decoded);
        // Validate skills exist - delete stale plan if skills missing
        const validation = _validatePlanSkills(skillPlan);
        if (!validation.valid) {
          logger && logger.info(`[PlanCache] Plan "${planName}" references deleted skills: ${validation.missing.join(', ')}. Deleting stale plan.`);
          try { fs.unlinkSync(planPath); } catch (_) {}
          continue;
        }
        logger && logger.info(`[PlanCache] Exact name match found: ${planName} → ${file}`);
        return {
          planFile: planPath,
          title: titleMatch?.[1]?.trim() || planName,
          file,
          similarity: 1.0,
          skillPlan,
          autoExecute: true,
          anchors: new Set(),
          planName,
        };
      } catch (_) { continue; }
    }
  } catch (err) {
    logger && logger.warn(`[PlanCache] findPlanByName error: ${err.message}`);
  }
  return null;
}

// ── Disk-based plan similarity search (semantic embeddings) ──────────────────

// ── Dead-plan sweep (housekeeping) ───────────────────────────────────────────
// Plans that never finished stay 'pending'/'failed' forever — invisible to the
// cache but cluttering ~/.thinkdrop/plans. Sweep them once an hour; 'complete'
// plans are cache content and are NEVER touched.
let _lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_PLAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sweepStalePlans(logger, maxAgeMs = STALE_PLAN_MAX_AGE_MS) {
  const t = Date.now();
  if (t - _lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  _lastSweepAt = t;
  if (!fs.existsSync(PLANS_DIR)) return 0;
  let removed = 0;
  try {
    for (const file of fs.readdirSync(PLANS_DIR)) {
      if (!file.endsWith('.md') || !file.startsWith('plan')) continue;
      const planPath = path.join(PLANS_DIR, file);
      try {
        const st = fs.statSync(planPath);
        if (t - st.mtimeMs < maxAgeMs) continue;
        const head = fs.readFileSync(planPath, 'utf8').slice(0, 800);
        const statusMatch = head.match(/^status:\s*(.+)/m);
        const status = statusMatch ? statusMatch[1].trim() : 'pending';
        if (_isCacheCompleteContent(head, status)) continue; // cache content — never delete
        fs.unlinkSync(planPath);
        removed++;
      } catch (_) {}
    }
    if (removed) logger && logger.info(`[PlanCache] Swept ${removed} stale pending/failed plan(s)`);
  } catch (_) {}
  return removed;
}

/**
 * Collect candidate completed plans from disk.
 * Returns array of { planPath, file, title, planPrompt, jsonMatch } for scoring.
 * @param {string} sessionId optional: scope search to current session only
 * @returns {Array}
 */
function _collectCandidatePlans(sessionId = null) {
  sweepStalePlans(null);
  if (!fs.existsSync(PLANS_DIR)) return [];
  let files = fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.md') && f.startsWith('plan'))
    .sort().reverse();
  
  // If sessionId is provided, only search plans from current session
  if (sessionId) {
    // Plans are stored with timestamps, so we need to filter by session context
    // For now, we'll limit to recent plans to approximate session scoping
    // TODO: Implement proper session-scoped plan storage
    files = files.slice(0, 50);
  } else {
    files = files.slice(0, 50);
  }

  const candidates = [];
  for (const file of files) {
    const planPath = path.join(PLANS_DIR, file);
    try {
      const content = fs.readFileSync(planPath, 'utf8');
      const statusMatch = content.match(/^status:\s*(.+)/m);
      if (!statusMatch || !_isCacheCompleteContent(content, statusMatch[1].trim())) continue;
      const jsonMatch = content.match(/^skill_plan_json:\s*'([^']+)'/m);
      if (!jsonMatch) continue;
      const titleMatch  = content.match(/^# Plan:\s*(.+)/m);
      const promptMatch = content.match(/^original_prompt:\s*"([^"]+)"/m);
      const planPrompt  = promptMatch ? promptMatch[1] : (titleMatch ? titleMatch[1] : '');
      if (!planPrompt) continue;
      candidates.push({
        planPath,
        file,
        title: titleMatch?.[1]?.trim() || file,
        planPrompt,
        jsonMatch,
        content,
      });
    } catch (_) { /* skip unreadable */ }
  }
  return candidates;
}

/**
 * Call /memory.embed on the user-memory service (port 3001) to get vectors.
 * Falls back gracefully if the service is unavailable.
 * @param {string[]} texts
 * @param {object} mcpAdapter
 * @returns {Promise<number[][]>}  one vector per text, or []
 */
async function _getEmbeddings(texts, mcpAdapter) {
  if (!mcpAdapter || !Array.isArray(texts) || texts.length === 0) return [];
  try {
    const result = await mcpAdapter.callService('user-memory', 'memory.embed', { texts }, { timeoutMs: 8000 });
    if (result && Array.isArray(result.embeddings)) return result.embeddings;
  } catch (_) {}
  return [];
}

/**
 * Find the most similar previously-completed plan on disk using semantic embeddings.
 *
 * Industry-standard rules:
 *   - Exact normalized prompt match → autoExecute: true (returned directly, no embedding call)
 *   - Semantic cosine ≥ 0.50       → autoExecute: false (caller shows approval modal)
 *   - Semantic cosine < 0.50       → null (no cache hit)
 *   - Never auto-executes on fuzzy similarity — only exact match or dot-name recall
 *
 * @param {string} prompt        user message
 * @param {object} mcpAdapter    MCP adapter for embedding call
 * @param {object} logger
 * @param {string} sessionId     optional: scope search to current session only
 * @returns {Promise<{ planFile, title, file, similarity, skillPlan, autoExecute } | null>}
 */
async function findSimilarCompletePlan(prompt, mcpAdapter, logger, sessionId = null, opts = {}) {
  // Fast path: dot-syntax named recall → always auto-execute
  const _dotName = extractDotNameFromPrompt(prompt);
  if (_dotName) {
    const _byName = findPlanByName(_dotName, logger);
    if (_byName) return _byName;
  }

  try {
    const candidates = _collectCandidatePlans(sessionId);
    if (candidates.length === 0) return null;

    // ── Exact normalized match → auto-execute immediately (zero network call) ──
    const normalizedPrompt = normalizePrompt(prompt);
    for (const c of candidates) {
      if (normalizePrompt(c.planPrompt) === normalizedPrompt) {
        try {
          const decoded   = Buffer.from(c.jsonMatch[1], 'base64').toString('utf8');
          const skillPlan = JSON.parse(decoded);
          if (_isStaleBrowserActPlan(skillPlan, prompt)) continue;
          // Validate skills exist - delete stale plan if skills missing
          const validation = _validatePlanSkills(skillPlan);
          if (!validation.valid) {
            logger && logger.info(`[PlanCache] Plan references deleted skills: ${validation.missing.join(', ')}. Deleting stale plan.`);
            try { fs.unlinkSync(c.planPath); } catch (_) {}
            continue;
          }
          logger && logger.info(`[PlanCache] Exact prompt match → auto-execute: ${c.file}`);
          return {
            planFile: c.planPath,
            title: c.title,
            file: c.file,
            similarity: 1.0,
            skillPlan,
            autoExecute: true,
          };
        } catch (_) { continue; }
      }
    }

    // ── Semantic similarity via embeddings → suggestion modal only ─────────────
    if (!mcpAdapter) return null;

    const texts    = [prompt, ...candidates.map(c => c.planPrompt)];
    const vectors  = await _getEmbeddings(texts, mcpAdapter);
    if (vectors.length < 2) return null;

    const promptVec = vectors[0];
    let bestScore   = 0;
    let bestIdx     = -1;

    for (let i = 0; i < candidates.length; i++) {
      const score = cosineDistance(promptVec, vectors[i + 1]);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestScore < SEMANTIC_SUGGEST_THRESHOLD || bestIdx < 0) return null;

    const best = candidates[bestIdx];
    try {
      const decoded   = Buffer.from(best.jsonMatch[1], 'base64').toString('utf8');
      const skillPlan = JSON.parse(decoded);
      if (_isStaleBrowserActPlan(skillPlan, prompt)) return null;
      // Validate skills exist - delete stale plan if skills missing
      const validation = _validatePlanSkills(skillPlan);
      if (!validation.valid) {
        logger && logger.info(`[PlanCache] Plan references deleted skills: ${validation.missing.join(', ')}. Deleting stale plan.`);
        try { fs.unlinkSync(best.planPath); } catch (_) {}
        return null;
      }
      // Slot-gated auto-execute: a near-identical paraphrase (cosine ≥ 0.90)
      // whose extracted slots are identical is the same plan re-asked — run it
      // without the modal. Slot differences mean different args — attempt a
      // positional rebind to the new prompt's targets; ambiguous binding or a
      // missing bound path keeps the hit at suggestion level (never silent).
      const _slotsEqual = slotSetsEqual(best.planPrompt, prompt);
      let _plan = skillPlan;
      let _clean = _slotsEqual;
      let _rebindNote = '';
      if (!_slotsEqual) {
        const _rb = rebindPlanSlots(skillPlan, prompt, { logger, refsPaths: opts.refsPaths || [] });
        if (_rb.ok) {
          _plan = _rb.skillPlan;
          _clean = true;
          _rebindNote = _rb.bindings.length ? ` (rebound ${_rb.bindings.length} slot(s))` : '';
        }
      }
      const _autoExec = bestScore >= SLOT_AUTOEXECUTE_THRESHOLD && _clean;
      logger && logger.info(
        `[PlanCache] Semantic match found (cosine=${bestScore.toFixed(3)}, slots=${_slotsEqual ? 'equal' : 'DIFFER'}, rebind=${_clean && !_slotsEqual ? 'ok' : 'n/a'}, autoExecute=${_autoExec}): ${best.file}`
      );
      return {
        planFile: best.planPath,
        title: best.title,
        file: best.file,
        similarity: bestScore,
        skillPlan: _plan,
        autoExecute: _autoExec,
        rebound: _rebindNote || undefined,
        content: best.content,
      };
    } catch (_) { return null; }

  } catch (err) {
    logger && logger.warn(`[PlanCache] findSimilarCompletePlan error: ${err.message}`);
  }
  return null;
}

// ── Follow-up plan correction helpers ─────────────────────────────────────────

const DOMAIN_ALIASES = {
  'x.com': 'twitter',
  'twitter.com': 'twitter',
  'twitter': 'twitter',
  'tweet': 'twitter',
  'gmail.com': 'email',
  'gmail': 'email',
  'outlook': 'email',
  'mail': 'email',
  'email': 'email',
  'github.com': 'github',
  'github': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'facebook.com': 'facebook',
  'facebook': 'facebook',
  'instagram.com': 'instagram',
  'instagram': 'instagram',
  'linkedin.com': 'linkedin',
  'linkedin': 'linkedin',
  'reddit.com': 'reddit',
  'reddit': 'reddit',
  'youtube.com': 'youtube',
  'youtube': 'youtube',
  'tiktok.com': 'tiktok',
  'tiktok': 'tiktok',
  'slack.com': 'slack',
  'slack': 'slack',
  'discord.com': 'discord',
  'discord.gg': 'discord',
  'discord': 'discord',
  'telegram': 'telegram',
  'whatsapp': 'whatsapp',
  'notion.so': 'notion',
  'notion': 'notion',
  'spotify.com': 'spotify',
  'spotify': 'spotify',
  'netflix.com': 'netflix',
  'netflix': 'netflix',
  'twitch.tv': 'twitch',
  'twitch': 'twitch',
  'amazon.com': 'amazon',
  'amazon': 'amazon',
  'ebay.com': 'ebay',
  'ebay': 'ebay',
  'pinterest.com': 'pinterest',
  'pinterest': 'pinterest',
  'yelp.com': 'yelp',
  'yelp': 'yelp',
  'tripadvisor.com': 'tripadvisor',
  'tripadvisor': 'tripadvisor',
  'imdb.com': 'imdb',
  'imdb': 'imdb',
  'chatgpt': 'chatgpt',
  'gemini': 'gemini',
  'perplexity': 'perplexity',
  'claude': 'claude',
  'grok': 'grok',
  'deepseek': 'deepseek',
  'mistral': 'mistral',
  'copilot': 'copilot',
  'midjourney': 'midjourney',
  'suno': 'suno',
  'biblegateway': 'biblegateway',
  'wikipedia': 'wikipedia',
  'duckduckgo': 'duckduckgo',
  'stackoverflow': 'stackoverflow',
  'google': 'google',
  'bing': 'bing',
  'yahoo': 'yahoo',
};

const _ACTION_VERBS = [
  'post', 'send', 'tweet', 'email', 'message', 'share', 'publish',
  'search', 'find', 'look', 'check', 'browse', 'open', 'navigate',
  'create', 'write', 'generate', 'make', 'build', 'edit', 'update',
  'delete', 'remove', 'rename', 'move', 'copy', 'download', 'upload',
  'schedule', 'remind', 'set', 'get', 'read', 'view', 'watch',
];

function _extractDomainTokens(text) {
  if (!text || typeof text !== 'string') return new Set();
  const lower = text.toLowerCase();
  const tokens = new Set();
  for (const [alias, canonical] of Object.entries(DOMAIN_ALIASES)) {
    if (lower.includes(alias)) tokens.add(canonical);
  }
  return tokens;
}

function _extractActionVerbs(text) {
  if (!text || typeof text !== 'string') return new Set();
  const lower = text.toLowerCase();
  const verbs = new Set();
  for (const verb of _ACTION_VERBS) {
    const re = new RegExp(`\\b${verb}\\b`, 'i');
    if (re.test(lower)) verbs.add(verb);
  }
  return verbs;
}

function domainsMatch(followUpTarget, targetService, previousPlan) {
  if (!previousPlan) return false;

  const fuText = `${followUpTarget || ''} ${targetService || ''}`;
  const fuDomains = _extractDomainTokens(fuText);

  const planPrompt = previousPlan.originalPrompt || '';
  const planStepsText = Array.isArray(previousPlan.skillPlan)
    ? previousPlan.skillPlan.map(s => `${s.skill || ''} ${JSON.stringify(s.args || {})}`).join(' ')
    : '';
  const planText = `${planPrompt} ${planStepsText}`;
  const planDomains = _extractDomainTokens(planText);

  if (fuDomains.size === 0 || planDomains.size === 0) return false;

  let domainOverlap = false;
  for (const d of fuDomains) {
    if (planDomains.has(d)) { domainOverlap = true; break; }
  }
  if (!domainOverlap) return false;

  const fuVerbs = _extractActionVerbs(fuText);
  const planVerbs = _extractActionVerbs(planText);

  if (fuVerbs.size === 0 || planVerbs.size === 0) return true;

  let verbOverlap = false;
  for (const v of fuVerbs) {
    if (planVerbs.has(v)) { verbOverlap = true; break; }
  }
  return verbOverlap;
}

const CORRECTION_SIGNALS = [
  'actually', 'should be', 'change it to', 'no wait', 'update the',
  'the actual', 'i meant', 'instead of', 'replace', 'use a different',
  'make it', 'rewrite', 'shorter', 'longer', 'replace the',
  "don't use", 'try again with', 'wrong', 'fix the', 'not that',
];

const CHAINED_ACTION_SIGNALS = [
  'also', 'then', 'after that', 'now also', 'and also', 'plus',
  'additionally', 'as well',
];

function isCorrectionSignal(message) {
  if (!message || typeof message !== 'string') return false;
  const lower = message.toLowerCase();

  const hasCorrection = CORRECTION_SIGNALS.some(s => lower.includes(s));
  if (hasCorrection) return true;

  const hasChained = CHAINED_ACTION_SIGNALS.some(s => lower.includes(s));
  if (hasChained) return false;

  return true;
}

function findMostRecentPlanInSession(sessionId, logger, maxAgeMinutes = 10) {
  try {
    if (!fs.existsSync(PLANS_DIR)) return null;
    let files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md') && f.startsWith('plan'))
      .sort().reverse();

    if (sessionId) {
      const sessionMatches = [];
      const others = [];
      for (const file of files) {
        const planPath = path.join(PLANS_DIR, file);
        try {
          const content = fs.readFileSync(planPath, 'utf8');
          const sidMatch = content.match(/^session_id:\s*(.+)/m);
          const sid = sidMatch ? sidMatch[1].trim() : '';
          if (sid === sessionId) {
            sessionMatches.push({ file, planPath, content });
          } else {
            others.push({ file, planPath, content });
          }
        } catch (_) { /* skip */ }
      }
      const ordered = sessionMatches.length > 0 ? sessionMatches : others.slice(0, 10);
      return _findPendingPlanFromList(ordered, maxAgeMinutes, logger);
    }

    const candidates = files.slice(0, 20).map(file => {
      const planPath = path.join(PLANS_DIR, file);
      try {
        const content = fs.readFileSync(planPath, 'utf8');
        return { file, planPath, content };
      } catch (_) { return null; }
    }).filter(Boolean);

    return _findPendingPlanFromList(candidates, maxAgeMinutes, logger);
  } catch (err) {
    logger && logger.warn(`[PlanCache] findMostRecentPlanInSession error: ${err.message}`);
    return null;
  }
}

function _findPendingPlanFromList(items, maxAgeMinutes, logger) {
  const now = Date.now();
  const maxAgeMs = maxAgeMinutes * 60 * 1000;

  for (const item of items) {
    try {
      const { content, planPath, file } = item;
      const statusMatch = content.match(/^status:\s*(.+)/m);
      if (!statusMatch) continue;
      const status = statusMatch[1].trim();
      if (status !== 'pending') continue;

      const createdMatch = content.match(/^created:\s*(.+)/m);
      if (createdMatch) {
        const created = new Date(createdMatch[1].trim()).getTime();
        if (isNaN(created) || (now - created) > maxAgeMs) continue;
      }

      const jsonMatch = content.match(/^skill_plan_json:\s*'([^']+)'/m);
      if (!jsonMatch) continue;
      const decoded = Buffer.from(jsonMatch[1], 'base64').toString('utf8');
      const skillPlan = JSON.parse(decoded);

      const titleMatch = content.match(/^# Plan:\s*(.+)/m);
      const promptMatch = content.match(/^original_prompt:\s*"([^"]+)"/m);
      const sidMatch = content.match(/^session_id:\s*(.+)/m);

      logger && logger.info(`[PlanCache] findMostRecentPlanInSession: found pending plan ${file}`);
      return {
        planFile: planPath,
        title: titleMatch ? titleMatch[1].trim() : file,
        skillPlan,
        originalPrompt: promptMatch ? promptMatch[1] : '',
        sessionId: sidMatch ? sidMatch[1].trim() : 'unknown',
        status,
        createdAt: createdMatch ? createdMatch[1].trim() : null,
      };
    } catch (_) { continue; }
  }
  return null;
}

/**
 * Downgrade a plan file's frontmatter status to `failed` so the plan cache
 * (which only auto-executes `status: complete` files) stops re-serving a plan
 * that review found hollow or contradicted. A later honest success can still
 * flip it back — executeCommand's status write covers pending→complete.
 * @param {string} filePath — plan_*.md path
 * @param {string} [reason] — logged context
 * @param {object} [log] — optional logger
 * @returns {boolean} true when the file was demoted
 */
function demotePlanFile(filePath, reason = '', log = null) {
  if (!filePath) return false;
  try {
    const md = fs.readFileSync(filePath, 'utf8');
    const updated = md.replace(/^(status:\s*)(complete|pending|running)(\s*)$/m, '$1failed$3');
    if (updated === md) return false;
    fs.writeFileSync(filePath, updated, 'utf8');
    if (log && log.info) log.info(`[planCacheHelpers] Plan file demoted to failed (${reason || 'review rejected'}): ${filePath}`);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  SEMANTIC_SUGGEST_THRESHOLD,
  SLOT_AUTOEXECUTE_THRESHOLD,
  extractSlots,
  slotSetsEqual,
  mergePlanSlots,
  rebindPlanSlots,
  sweepStalePlans,
  normalizePrompt,
  cosineDistance,
  findSimilarCompletePlan,
  findPlanByName,
  isValidDotName,
  deriveDotName,
  extractDotNameFromPrompt,
  _SESSION_CACHE,
  _sessionCacheKey,
  _sessionCacheGet,
  _sessionCacheSet,
  _clearSessionCache,
  _isStaleBrowserActPlan,
  _validatePlanSkills,
  extractPlanContext,
  getCurrentBrowserContext,
  contextMismatch,
  findHardcodedDesktopFilename,
  suggestFilenameFromTitle,
  findMostRecentPlanInSession,
  domainsMatch,
  isCorrectionSignal,
  DOMAIN_ALIASES,
  demotePlanFile,
  _isCacheCompleteContent,
};

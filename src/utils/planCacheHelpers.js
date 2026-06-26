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

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');
const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

// ── Semantic similarity thresholds ────────────────────────────────────────────
/** Minimum cosine similarity to surface a plan as a suggestion (modal). */
const SEMANTIC_SUGGEST_THRESHOLD = 0.50;

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
 * Validate that all external.skill steps in a plan reference existing skills.
 * Returns { valid: boolean, missing: string[] } with names of missing skills.
 */
function _validatePlanSkills(skillPlan) {
  if (!Array.isArray(skillPlan)) return { valid: false, missing: [] };

  const missing = [];
  for (const step of skillPlan) {
    const skillName = step.skill;
    // Skip built-in skills that don't need files
    if (skillName === 'browser.act' || skillName === 'browser.agent' ||
        skillName === 'cli.agent' || skillName === 'shell.run' ||
        skillName === 'creator.agent' || skillName === 'reviewer.agent' ||
        skillName === 'skillCreator.skill' || skillName === 'system.introspect') {
      continue;
    }
    // Check external.skill references
    if (skillName === 'external.skill' && step.args?.name) {
      const skillDir = path.join(SKILLS_DIR, step.args.name);
      const indexPath = path.join(skillDir, 'index.cjs');
      if (!fs.existsSync(indexPath)) {
        missing.push(step.args.name);
      }
    }
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
  const title = contextMatch ? _stripCommonSuffixes(contextMatch[1]) : null;
  const urlMatch = prompt.match(/(https?:\/\/[^\s"]+)/);
  return {
    prompt,
    title: title || prompt || null,
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

  const planTitle = _stripCommonSuffixes(planContext.title || planContext.prompt || '');
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
    const match = text.match(/(?:~|\/Users\/[^/]+)\/Desktop\/([^"'\s]+)/);
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
 */
function normalizePrompt(text) {
  return (text || '').toLowerCase().replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
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
      .filter(f => f.endsWith('.md') && f.startsWith('plan-'))
      .sort().reverse()
      .slice(0, 50);

    for (const file of files) {
      const planPath = path.join(PLANS_DIR, file);
      try {
        const content = fs.readFileSync(planPath, 'utf8');
        const statusMatch = content.match(/^status:\s*(.+)/m);
        if (!statusMatch || statusMatch[1].trim() !== 'complete') continue;
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

/**
 * Collect candidate completed plans from disk.
 * Returns array of { planPath, file, title, planPrompt, jsonMatch } for scoring.
 * @param {string} sessionId optional: scope search to current session only
 * @returns {Array}
 */
function _collectCandidatePlans(sessionId = null) {
  if (!fs.existsSync(PLANS_DIR)) return [];
  let files = fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.md') && f.startsWith('plan-'))
    .sort().reverse();
  
  // If sessionId is provided, only search plans from current session
  if (sessionId) {
    // Plans are stored with timestamps, so we need to filter by session context
    // For now, we'll limit to recent plans (last 10) to approximate session scoping
    // TODO: Implement proper session-scoped plan storage
    files = files.slice(0, 10);
  } else {
    files = files.slice(0, 20);
  }

  const candidates = [];
  for (const file of files) {
    const planPath = path.join(PLANS_DIR, file);
    try {
      const content = fs.readFileSync(planPath, 'utf8');
      const statusMatch = content.match(/^status:\s*(.+)/m);
      if (!statusMatch || statusMatch[1].trim() !== 'complete') continue;
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
async function findSimilarCompletePlan(prompt, mcpAdapter, logger, sessionId = null) {
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
      logger && logger.info(
        `[PlanCache] Semantic match found (cosine=${bestScore.toFixed(3)}, autoExecute=false): ${best.file}`
      );
      return {
        planFile: best.planPath,
        title: best.title,
        file: best.file,
        similarity: bestScore,
        skillPlan,
        autoExecute: false,
        content: best.content,
      };
    } catch (_) { return null; }

  } catch (err) {
    logger && logger.warn(`[PlanCache] findSimilarCompletePlan error: ${err.message}`);
  }
  return null;
}

module.exports = {
  SEMANTIC_SUGGEST_THRESHOLD,
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
};

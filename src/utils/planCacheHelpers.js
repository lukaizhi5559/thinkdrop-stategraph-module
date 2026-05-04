'use strict';

/**
 * planCacheHelpers.js
 *
 * Shared plan-cache utilities used by planSkills.js and checkPlanCache.js.
 * Exported as a module singleton so the in-memory session cache (_SESSION_CACHE)
 * is shared between both callers regardless of which one populates it first.
 *
 * Responsibilities:
 *   - extractEntityAnchors()    — extract identity tokens from a user message
 *   - anchorSetsMatch()         — symmetric anchor comparison (prevents false positives)
 *   - findSimilarCompletePlan() — disk-based plan similarity search
 *   - Session LRU cache         — zero-disk-I/O exact-repeat cache
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');

// ── Constants ─────────────────────────────────────────────────────────────────
/** Jaccard similarity threshold above which a plan auto-executes (no modal). */
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

// ── In-memory session cache ───────────────────────────────────────────────────
// Shared singleton Map — because Node caches module instances, both planSkills
// and checkPlanCache reference the same Map object.
const _SESSION_CACHE       = new Map();
const SESSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_CACHE_MAX    = 50;

function _sessionCacheKey(message) {
  return message.toLowerCase().replace(/\s+/g, ' ').trim();
}

function _sessionCacheSet(key, skillPlan, anchors) {
  if (_SESSION_CACHE.size >= SESSION_CACHE_MAX) {
    _SESSION_CACHE.delete(_SESSION_CACHE.keys().next().value); // evict oldest
  }
  _SESSION_CACHE.set(key, { skillPlan, timestamp: Date.now(), anchors });
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

// ── Entity-anchor extraction ──────────────────────────────────────────────────
// Proper nouns, emails, URLs, and phone numbers that uniquely identify WHAT the
// plan operates on.  If two messages differ on any anchor, they target different
// entities and must NOT auto-execute the same cached plan.

const _STOP_NOUNS = new Set([
  'I', 'The', 'A', 'An', 'This', 'That', 'My', 'Your', 'Please',
  'Hi', 'Hello', 'Ok', 'Okay', 'Can', 'Could', 'Would', 'Should',
  'Just', 'Using', 'With', 'From', 'Send', 'Get', 'Go', 'Do',
]);

/**
 * Extract identity-bearing anchor tokens from a message string.
 * @param {string} text
 * @returns {Set<string>}  lowercased anchor values
 */
function extractEntityAnchors(text) {
  if (!text) return new Set();
  const anchors = new Set();
  let m;

  // Email addresses
  const emailRe = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
  while ((m = emailRe.exec(text)) !== null) anchors.add(m[0].toLowerCase());

  // URLs — keep hostname only to avoid query-string noise
  const urlRe = /https?:\/\/[^\s]+/g;
  while ((m = urlRe.exec(text)) !== null) {
    try {
      anchors.add(new URL(m[0]).hostname.replace(/^www\./, '').toLowerCase());
    } catch (_) {
      anchors.add(m[0].toLowerCase());
    }
  }

  // Phone numbers (normalised to digits only)
  const phoneRe = /(?<!\d)(\+?1?\s*[\(]?\d{3}[\)\-\s]?\d{3}[\-\s]?\d{4})(?!\d)/g;
  while ((m = phoneRe.exec(text)) !== null) anchors.add(m[0].replace(/\D/g, ''));

  // Capitalised proper nouns — filter out stop-words and sentence-start capitals.
  // Strategy: split on sentence boundaries, then skip the first word of each chunk.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const nounRe = /\b[A-Z][a-z]{1,}\b/g;
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    // Skip index 0 (sentence-start capital) — start from index 1
    for (let i = 1; i < words.length; i++) {
      const match = words[i].match(/^[A-Z][a-z]{1,}$/);
      if (match && !_STOP_NOUNS.has(words[i])) {
        anchors.add(words[i].toLowerCase());
      }
    }
  }

  // Also catch standalone capitalized words not caught by sentence splitting
  nounRe.lastIndex = 0;
  // (already handled above)

  return anchors;
}

/**
 * Returns true when two anchor sets are "compatible" — both empty, or symmetric match.
 * Asymmetric presence → false (plan targeted "Sarah", new request names "John").
 * @param {Set<string>} anchorsA
 * @param {Set<string>} anchorsB
 * @returns {boolean}
 */
function anchorSetsMatch(anchorsA, anchorsB) {
  if (anchorsA.size === 0 && anchorsB.size === 0) return true;
  if (anchorsA.size !== anchorsB.size) return false;
  for (const a of anchorsA) {
    if (!anchorsB.has(a)) return false;
  }
  return true;
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

// ── Disk-based plan similarity search ────────────────────────────────────────

/**
 * Find the most similar previously-completed plan on disk.
 * Only considers plans with status: complete and a stored skill_plan_json.
 * Applies entity-anchor guard: plans with different anchors are flagged
 * autoExecute: false even if their Jaccard score exceeds the threshold.
 *
 * @param {string} prompt   user message
 * @param {object} logger
 * @returns {{ planFile, title, file, similarity, skillPlan, autoExecute, anchors } | null}
 */
function findSimilarCompletePlan(prompt, logger) {
  // Fast path: check for exact dot-syntax name in the prompt first
  const _dotName = extractDotNameFromPrompt(prompt);
  if (_dotName) {
    const _byName = findPlanByName(_dotName, logger);
    if (_byName) return _byName;
  }

  try {
    if (!fs.existsSync(PLANS_DIR)) return null;
    const files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md') && f.startsWith('plan-'))
      .sort().reverse()
      .slice(0, 20);

    const promptWords = new Set(
      prompt.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4)
    );
    const promptAnchors = extractEntityAnchors(prompt);

    for (const file of files) {
      const planPath = path.join(PLANS_DIR, file);
      try {
        const content = fs.readFileSync(planPath, 'utf8');

        // Only match 100% successfully completed plans
        const statusMatch = content.match(/^status:\s*(.+)/m);
        if (!statusMatch || statusMatch[1].trim() !== 'complete') continue;

        // Must have stored skill_plan_json to be reusable
        const jsonMatch = content.match(/^skill_plan_json:\s*'([^']+)'/m);
        if (!jsonMatch) continue;

        const titleMatch  = content.match(/^# Plan:\s*(.+)/m);
        const promptMatch = content.match(/^original_prompt:\s*"([^"]+)"/m);
        const planRawPrompt = promptMatch ? promptMatch[1] : '';
        const planText = ((titleMatch ? titleMatch[1] : '') + ' ' + planRawPrompt)
          .toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        const planWords   = new Set(planText.split(/\s+/).filter(w => w.length > 4));
        const planAnchors = extractEntityAnchors(planRawPrompt + ' ' + (titleMatch ? titleMatch[1] : ''));

        const intersection = [...promptWords].filter(w => planWords.has(w));
        const union        = new Set([...promptWords, ...planWords]);
        const similarity   = union.size > 0 ? intersection.length / union.size : 0;

        if (similarity >= 0.3) {
          try {
            const decoded  = Buffer.from(jsonMatch[1], 'base64').toString('utf8');
            const skillPlan = JSON.parse(decoded);
            const anchorsOk   = anchorSetsMatch(promptAnchors, planAnchors);
            const autoExecute = similarity >= HIGH_CONFIDENCE_THRESHOLD && anchorsOk;
            logger.info(
              `[PlanCache] Similar completed plan found ` +
              `(${Math.round(similarity * 100)}% match, anchorsOk=${anchorsOk}, autoExecute=${autoExecute}): ${file}`
            );
            return {
              planFile: planPath,
              title: titleMatch?.[1]?.trim() || file,
              file,
              similarity,
              skillPlan,
              autoExecute,
              anchors: promptAnchors,
            };
          } catch (_) { continue; }
        }
      } catch (_) { /* skip unreadable */ }
    }
  } catch (err) {
    logger.warn(`[PlanCache] findSimilarCompletePlan error: ${err.message}`);
  }
  return null;
}

module.exports = {
  HIGH_CONFIDENCE_THRESHOLD,
  extractEntityAnchors,
  anchorSetsMatch,
  findSimilarCompletePlan,
  findPlanByName,
  isValidDotName,
  deriveDotName,
  extractDotNameFromPrompt,
  _SESSION_CACHE,
  _sessionCacheKey,
  _sessionCacheGet,
  _sessionCacheSet,
};

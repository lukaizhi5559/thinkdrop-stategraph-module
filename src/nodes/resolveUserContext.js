/**
 * resolveUserContext.js — StateGraph node
 *
 * Runs between enrichIntent → planSkills.
 * General-purpose pre-planning context hydrator. Mirrors user.agent's 3-layer
 * fallback strategy (user_profile → user_memory.memory → conversation_messages)
 * to resolve self-referential context gaps BEFORE the planner generates a plan.
 *
 * Handles two concerns:
 *   1. SMS gateway resolution — resolves phone + carrier → smsGatewayTarget
 *      for both external contacts ("text John") and self-directed SMS
 *      ("send me a daily SMS", "text me my family info")
 *   2. General self context — resolves facts needed by the task
 *      (my email, my favorite X, recent purchases, family info, etc.)
 *      and injects them as resolvedSelfContext for planSkills to use
 *
 * State inputs (from enrichIntent):
 *   state.domainTags      — { tags, services } from phi4 domain extraction
 *   state.entities        — resolved entities array
 *   state.resolvedMessage — fully resolved command text
 *   state.context.userId
 *
 * State outputs:
 *   state.smsGatewayTarget    — { name, phone, carrier, email } when SMS resolved
 *   state.resolvedSelfContext — { phone?, email?, memories?, conversation? }
 *   state.resolveUserContextDone — boolean flag
 */

'use strict';

const { lookupCarrier, getGatewayEmail, CARRIER_OPTIONS } = require('../utils/carrierGateways');
const { parseDateRange } = require('../utils/parseDateRange');

const MEMORY_URL = process.env.MCP_USER_MEMORY_URL    || 'http://127.0.0.1:3001';
const MEMORY_KEY = process.env.MCP_USER_MEMORY_API_KEY || '';
const CONV_URL   = process.env.MCP_CONVERSATION_URL   || 'http://127.0.0.1:3004';
const CONV_KEY   = process.env.MCP_CONVERSATION_API_KEY || '';

/**
 * Does this state have any self-referential context that needs pre-resolution?
 * Checks domainTags AND a broad heuristic so neither alone is a bottleneck.
 */
function _hasSelfReferentialContext(state, msg) {
  // Fast path: NLI signal preserved by enrichIntent (covers all SMS/email phrasings)
  if (state._smsTagSignal || state._emailTagSignal) return true;

  const tags = state.domainTags?.tags || [];
  const SMS_RELATED = new Set(['sms', 'text', 'text message', 'text-message', 'text_message', 'messaging', 'email']);

  if (tags.some(t => SMS_RELATED.has(t.toLowerCase()))) return true;
  if (state.intent?.type === 'sms_send') return true;

  // Broad heuristic — covers "text me", "email me", "my favorite X",
  // "my family", recent purchases, document lookups, etc.
  if (/\b(text me|sms me|send me (a |an )?(text|sms|email)|email me|my (phone|number|cell|email|favorite|family|contacts?)|bought last|ordered last|proposal i|report i|document i)\b/i.test(msg)) return true;

  return false;
}

// ── External contact name resolution ────────────────────────────────────────

function _extractTargetName(state) {
  // Entity PERSON only — no regex fallback to avoid false positives like
  // "text message at night" matching "at" as a name.
  const entities = Array.isArray(state.entities) ? state.entities : [];
  for (const ent of entities) {
    if ((ent.entity_type || ent.type || '').toUpperCase() === 'PERSON') {
      return ent.value || ent.text || null;
    }
  }
  return null;
}

// ── 3-layer field resolver (mirrors user.agent.resolveForm) ─────────────────

/**
 * Resolve a single field using: user_profile → memory → conversation
 * Lazy back-fills hits to user_profile so subsequent calls are O(1).
 *
 * @param {object} mcpAdapter
 * @param {string} profileKey   — e.g. 'self:phone'
 * @param {string} searchQuery  — e.g. 'my phone number'
 * @param {string} userId
 * @param {object} logger
 * @returns {Promise<string|null>}
 */
async function _resolveField(mcpAdapter, profileKey, searchQuery, userId, logger, resolvedMsg) {
  // ── Layer 1: user_profile (O(1)) ──────────────────────────────────────
  let value = await _profileGet(mcpAdapter, profileKey, userId, logger);
  if (value) return value;

  // ── Layer 2: user_memory.memory semantic search ───────────────────────
  value = await _memorySearch(mcpAdapter, searchQuery, 'personal_profile', userId, logger);
  if (value) {
    logger.info(`[Node:ResolveUserContext] "${profileKey}" found in memory — backfilling to profile`);
    await _profileSet(mcpAdapter, profileKey, value, userId, logger);
    return value;
  }

  // ── Layer 3: conversation_messages by date (cross-session) ─────────────
  const snippets = await _conversationSearchByDate(mcpAdapter, resolvedMsg || searchQuery, userId, logger);
  const _isPhoneQ = searchQuery.toLowerCase().includes('phone');
  const _isEmailQ = searchQuery.toLowerCase().includes('email');
  for (const snippet of snippets) {
    if (_isPhoneQ) {
      // Area code must start with 2-9 — prevents timestamp false-matches (e.g. 11644473600)
      const pm = snippet.match(/(\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (pm) { value = pm[0].trim(); break; }
      continue; // no valid phone in this snippet — try next
    }
    if (_isEmailQ) {
      const em = snippet.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (em) { value = em[0]; break; }
      continue; // no valid email in this snippet — try next
    }
    if (snippet.length > 5) { value = snippet.slice(0, 400); break; }
  }
  if (value) {
    logger.info(`[Node:ResolveUserContext] "${profileKey}" found in conversation — backfilling to profile`);
    await _profileSet(mcpAdapter, profileKey, value, userId, logger);
    return value;
  }

  return null;
}

// ── MCP helpers ──────────────────────────────────────────────────────────────

async function _profileGet(mcpAdapter, key, userId, logger) {
  try {
    const result = await mcpAdapter.callService('user-memory', 'profile.get', { key, userId }, { timeoutMs: 3000 });
    return result?.data?.valueRef || result?.valueRef || null;
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] profile.get "${key}" failed: ${e.message}`);
    return null;
  }
}

async function _profileSet(mcpAdapter, key, value, userId, logger) {
  try {
    await mcpAdapter.callService('user-memory', 'profile.set', { key, valueRef: value, userId }, { timeoutMs: 3000 });
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] profile.set "${key}" failed: ${e.message}`);
  }
}

/**
 * Search user_memory.memory for a value.
 * Extracts the first matching value pattern or returns the raw top-hit text.
 */
async function _memorySearch(mcpAdapter, query, type, userId, logger) {
  try {
    const result = await mcpAdapter.callService('user-memory', 'memory.search', {
      query,
      userId,
      filters: type ? { type } : {},
      limit: 8,
    }, { timeoutMs: 5000 });

    // Service maps DB column source_text → text in response
    const memories = result?.data?.results || result?.data?.memories || result?.results || [];
    const isPhoneQ = query.toLowerCase().includes('phone');
    const isEmailQ = query.toLowerCase().includes('email');
    for (const mem of memories) {
      const text = mem.text || mem.source_text || mem.extractedText || '';
      if (!text) continue;

      if (isPhoneQ) {
        // Area code must start with 2-9 — prevents timestamp false-matches (e.g. 11644473600)
        const phoneMatch = text.match(/(\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
        if (phoneMatch) return phoneMatch[0].trim();
        continue; // no valid phone in this memory entry — try next
      }

      if (isEmailQ) {
        const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) return emailMatch[0];
        continue; // no valid email in this memory entry — try next
      }

      // Generic topic query (not phone/email) — return raw snippet for LLM
      if (text.length > 5) return text.slice(0, 400);
    }
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] memory.search failed (${query}): ${e.message}`);
  }
  return null;
}

/**
 * Bulk memory search — returns an array of text snippets for a topic.
 * Used for richer context topics (family info, document content, etc.)
 */
async function _memorySearchBulk(mcpAdapter, query, userId, logger, limit = 8) {
  try {
    const result = await mcpAdapter.callService('user-memory', 'memory.search', {
      query,
      userId,
      filters: {},
      limit,
    }, { timeoutMs: 5000 });
    // Service maps DB column source_text → text in response
    const memories = result?.data?.results || result?.data?.memories || result?.results || [];
    return memories
      .map(m => m.text || m.source_text || m.extractedText || '')
      .filter(Boolean)
      .map(t => t.slice(0, 300));
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] memory bulk search failed (${query}): ${e.message}`);
    return [];
  }
}

/**
 * Cross-session conversation search using message.listByDate.
 * Parses a date hint from the message, falls back to last 12 months.
 * Returns raw text snippets (no session-scoped IDs needed).
 */
async function _conversationSearchByDate(mcpAdapter, msg, userId, logger) {
  try {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    let dateRange = parseDateRange(msg);
    if (!dateRange) {
      const start = new Date(now); start.setFullYear(start.getFullYear() - 1);
      dateRange = { startDate: iso(start), endDate: iso(now) };
    }
    const result = await mcpAdapter.callService('conversation', 'message.listByDate', {
      startDate: dateRange.startDate,
      endDate:   dateRange.endDate,
      userId,
      limit: 50,
    }, { timeoutMs: 5000 });
    const messages = result?.data?.messages || result?.messages || [];
    return messages
      .map(m => m.text || m.content || '')
      .filter(Boolean)
      .map(t => t.slice(0, 300));
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] conversation.listByDate failed: ${e.message}`);
    return [];
  }
}

// ── Carrier detection ────────────────────────────────────────────────────────

async function _autoDetectCarrier(phone, logger) {
  try {
    const carrier = await lookupCarrier(phone);
    logger.info(`[Node:ResolveUserContext] Numverify detected carrier "${carrier}" for ${phone}`);
    return carrier;
  } catch (e) {
    logger.warn(`[Node:ResolveUserContext] Numverify lookup failed: ${e.message}`);
    return null;
  }
}

/**
 * Resolve phone + carrier for a given profile-key prefix.
 * Handles both external contacts (prefix = 'contact:john') and self ('self').
 * Returns { phone, carrier } or null if phone cannot be found.
 */
async function _resolvePhoneAndCarrier(mcpAdapter, profilePrefix, searchQuery, userId, logger, resolvedMsg) {
  const phoneKey   = `${profilePrefix}:phone`;
  const carrierKey = `${profilePrefix}:phone_carrier`;
  const lookupFlag = `${profilePrefix}:phone_carrier_lookup_needed`;

  // ── Phone ──────────────────────────────────────────────────────────────
  let phone = await _resolveField(mcpAdapter, phoneKey, searchQuery, userId, logger, resolvedMsg);
  if (!phone) return null;

  // ── Carrier ───────────────────────────────────────────────────────────
  let carrier = await _profileGet(mcpAdapter, carrierKey, userId, logger);
  if (!carrier) {
    const alreadyTried = await _profileGet(mcpAdapter, lookupFlag, userId, logger);
    if (alreadyTried !== 'done') {
      carrier = await _autoDetectCarrier(phone, logger);
      if (carrier) await _profileSet(mcpAdapter, carrierKey, carrier, userId, logger);
      await _profileSet(mcpAdapter, lookupFlag, 'done', userId, logger);
    }
  }

  return { phone, carrier };
}

// ── Main node ────────────────────────────────────────────────────────────────

module.exports = async function resolveUserContext(state) {
  const { mcpAdapter, logger: _logger } = state;
  const logger = _logger || console;
  const userId = state.context?.userId || 'local_user';

  const msg = state.resolvedMessage || state.message || '';

  // ── Quick-exit: nothing self-referential in this message ─────────────────
  if (!_hasSelfReferentialContext(state, msg)) {
    logger.debug('[Node:ResolveUserContext] No self-referential context needed — pass-through');
    return { ...state, resolveUserContextDone: true };
  }

  logger.info('[Node:ResolveUserContext] Self-referential context detected — resolving');

  if (!mcpAdapter) {
    logger.warn('[Node:ResolveUserContext] No MCP adapter — skipping context resolution');
    return { ...state, resolveUserContextDone: true };
  }

  // Derive context needs from NLI signals + light regex (no topic bucketing)
  const needsSmsPhone = !!(state._smsTagSignal ||
    /\b(text me|sms me|send me a (text|sms)|my phone|my number|my cell|daily sms|sms summary|sms update|sms report|sms alert)\b/i.test(msg));
  const needsEmail = !!(state._emailTagSignal ||
    /\b(email me|send me an email|mail me|my email)\b/i.test(msg));
  const resolvedSelfContext = {};
  let smsGatewayTarget = state.smsGatewayTarget || null;

  // ── 1. Identify SMS recipient — external contact OR self ─────────────────
  const targetName = _extractTargetName(state);

  if (targetName) {
    // External contact SMS: resolve contact:<name>:phone
    logger.info(`[Node:ResolveUserContext] External SMS target: "${targetName}"`);
    const normalizedName = targetName.toLowerCase().replace(/\s+/g, '_');
    const phoneResult = await _resolvePhoneAndCarrier(
      mcpAdapter,
      `contact:${normalizedName}`,
      `phone number of ${targetName}`,
      userId,
      logger,
      msg,
    );

    if (phoneResult?.phone) {
      const gatewayEmail = phoneResult.carrier ? getGatewayEmail(phoneResult.phone, phoneResult.carrier) : null;
      smsGatewayTarget = {
        name: targetName,
        phone: phoneResult.phone,
        carrier: phoneResult.carrier || null,
        email: gatewayEmail,
        ...(!gatewayEmail && { carrierOptions: CARRIER_OPTIONS }),
      };
      if (gatewayEmail) logger.info(`[Node:ResolveUserContext] External contact gateway: ${gatewayEmail}`);
    } else {
      logger.info(`[Node:ResolveUserContext] Could not resolve phone for "${targetName}"`);
    }
  } else if (needsSmsPhone) {
    // SHORT-CIRCUIT: if the gateway email is already on state (passed by main.js __sms_gateway__
    // handler), skip the profile re-lookup entirely. _profileSave is fire-and-forget so
    // self:phone_carrier may not have committed yet — a fresh lookup would overwrite the good
    // email with null, causing the scout card to re-appear on every run.
    if (smsGatewayTarget?.email) {
      logger.info(`[Node:ResolveUserContext] SMS gateway already resolved on state: ${smsGatewayTarget.email} — skipping re-lookup`);
      if (smsGatewayTarget.phone) resolvedSelfContext.phone = smsGatewayTarget.phone;
    } else {
      // Self-directed SMS: resolve self:phone
      logger.info('[Node:ResolveUserContext] Self-SMS detected — resolving self:phone');
      const phoneResult = await _resolvePhoneAndCarrier(
        mcpAdapter,
        'self',
        'my phone number',
        userId,
        logger,
        msg,
      );

      if (phoneResult?.phone) {
        resolvedSelfContext.phone = phoneResult.phone;
        const gatewayEmail = phoneResult.carrier ? getGatewayEmail(phoneResult.phone, phoneResult.carrier) : null;
        smsGatewayTarget = {
          name: 'me',
          phone: phoneResult.phone,
          carrier: phoneResult.carrier || null,
          email: gatewayEmail,
          ...(!gatewayEmail && { carrierOptions: CARRIER_OPTIONS }),
        };
        if (gatewayEmail) logger.info(`[Node:ResolveUserContext] Self SMS gateway: ${gatewayEmail}`);
      } else {
        logger.info('[Node:ResolveUserContext] self:phone not found in profile, memory, or conversation');
      }
    }
  }

  // ── 2. Resolve self:email if needed ──────────────────────────────────────
  if (needsEmail) {
    const email = await _resolveField(mcpAdapter, 'self:email', 'my email address', userId, logger, msg);
    if (email) {
      resolvedSelfContext.email = email;
      logger.info('[Node:ResolveUserContext] self:email resolved');
    }
  }

  // ── 3 + 4. Broad parallel context search (memory + conversation) ──────────
  // Single broad semantic search covers ALL user context topics in one call:
  // favourites, family, proposals, purchases, preferences, work, etc.
  // No topic bucketing needed — the LLM reads raw snippets.
  const [memSnippets, convSnippets] = await Promise.all([
    _memorySearchBulk(mcpAdapter, msg, userId, logger, 8),
    _conversationSearchByDate(mcpAdapter, msg, userId, logger),
  ]);
  if (memSnippets.length > 0) {
    resolvedSelfContext.memories = { context: memSnippets };
    logger.info(`[Node:ResolveUserContext] Broad memory search: ${memSnippets.length} snippet(s)`);
  }
  if (convSnippets.length > 0) {
    resolvedSelfContext.conversation = { context: convSnippets };
    logger.info(`[Node:ResolveUserContext] Broad conversation search: ${convSnippets.length} snippet(s)`);
  }

  return {
    ...state,
    resolveUserContextDone: true,
    ...(smsGatewayTarget && { smsGatewayTarget }),
    ...(Object.keys(resolvedSelfContext).length > 0 && { resolvedSelfContext }),
  };
};

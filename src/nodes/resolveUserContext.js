/**
 * resolveUserContext.js — StateGraph node
 *
 * Runs between enrichIntent → planSkills.
 * Currently scoped to SMS-domain tasks: looks up the target person's phone
 * number and carrier from user_profile / memory, calls Numverify once to
 * auto-detect the carrier when needed, builds the SMS gateway email address,
 * and injects it into state so planSkills can route the send via gmail.agent
 * instead of a paid SMS API.
 *
 * State inputs (from enrichIntent):
 *   state.domainTags      — tags like { tags: ['sms', 'messaging'], services: [...] }
 *   state.chosenService   — e.g. 'twilio', 'gmail' (set by enrichIntent)
 *   state.entities        — resolved entities array
 *   state.resolvedMessage — fully resolved command text
 *   state.context.userId
 *
 * State outputs:
 *   state.smsGatewayTarget — { name, phone, carrier, email } — set when the
 *                             SMS can be routed via free email gateway
 *   state.resolveUserContextDone — boolean flag
 *
 * Non-SMS intents: this node is a no-op pass-through (returns state unchanged).
 */

'use strict';

const { lookupCarrier, getGatewayEmail, CARRIER_OPTIONS } = require('../utils/carrierGateways');

// Domain tags that signal an SMS send intent
const SMS_TAGS = new Set(['sms', 'text', 'text message', 'text_message', 'messaging']);

// Profile keys used for target contact phone lookup
const CONTACT_PHONE_PATTERN = /^contact:([^:]+):phone$/;

/**
 * Quick check: does this state look like an SMS send request?
 */
function _isSmsIntent(state) {
  const tags   = state.domainTags?.tags  || [];
  const intent = state.intent?.type      || '';
  const msg    = (state.resolvedMessage || state.message || '').toLowerCase();

  if (intent === 'sms_send') return true;
  if (tags.some(t => SMS_TAGS.has(t.toLowerCase()))) return true;
  // Heuristic: message contains "text <name>" or "send a text"
  if (/\b(send\s+(a\s+)?text|text\s+message|send\s+sms)\b/i.test(msg)) return true;
  return false;
}

/**
 * Resolve the target person's name from entities or message text.
 * Returns a lowercase display name or null.
 */
function _extractTargetName(state) {
  const entities = Array.isArray(state.entities) ? state.entities : [];
  // Prefer PERSON entities that appear to be recipients
  for (const ent of entities) {
    if ((ent.entity_type || ent.type || '').toUpperCase() === 'PERSON') {
      return ent.value || ent.text || null;
    }
  }
  // Fallback: match "text <Name>" pattern in the resolved message
  const msg = state.resolvedMessage || state.message || '';
  const m = msg.match(/\b(?:text|message|sms)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  return m ? m[1] : null;
}

/**
 * Look up a profile key via the user-memory MCP service.
 * Returns the value string or null on miss/error.
 */
async function _profileGet(mcpAdapter, key, userId, logger) {
  try {
    const result = await mcpAdapter.callService('user-memory', 'profile.get', {
      key,
      userId,
    }, { timeoutMs: 3000 });
    return result?.data?.valueRef || result?.valueRef || null;
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] profile.get "${key}" failed: ${e.message}`);
    return null;
  }
}

/**
 * Persist a carrier name to user_profile so we never call Numverify again
 * for the same number.
 */
async function _profileSet(mcpAdapter, key, value, userId, logger) {
  try {
    await mcpAdapter.callService('user-memory', 'profile.set', {
      key,
      value,
      userId,
    }, { timeoutMs: 3000 });
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] profile.set "${key}" failed: ${e.message}`);
  }
}

/**
 * Search the memory table for a phone number associated with a person name.
 * Returns { phone, carrierHint } or null.
 */
async function _memorySearchForPhone(mcpAdapter, personName, userId, logger) {
  try {
    const result = await mcpAdapter.callService('user-memory', 'memory.search', {
      query: `phone number of ${personName}`,
      userId,
      filters: { type: 'personal_profile' },
      limit: 5,
    }, { timeoutMs: 5000 });

    const memories = result?.data?.memories || result?.memories || [];
    for (const mem of memories) {
      const text = mem.source_text || mem.extracted_text || '';
      // Look for a US phone number in the memory text
      const phoneMatch = text.match(/\b(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/);
      if (phoneMatch) {
        return { phone: phoneMatch[1], carrierHint: null };
      }
    }
  } catch (e) {
    logger.debug(`[Node:ResolveUserContext] memory.search for phone failed: ${e.message}`);
  }
  return null;
}

/**
 * Attempt to auto-detect carrier via Numverify.
 * Returns carrier string or null on any error (API key missing, timeout, etc.)
 */
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

// ── Main node ────────────────────────────────────────────────────────────────

module.exports = async function resolveUserContext(state) {
  const { mcpAdapter, logger: _logger } = state;
  const logger = _logger || console;
  const userId = state.context?.userId || 'local_user';

  // ── Non-SMS intent: pass through unchanged ───────────────────────────────
  if (!_isSmsIntent(state)) {
    logger.debug('[Node:ResolveUserContext] Not an SMS intent — pass-through');
    return { ...state, resolveUserContextDone: true };
  }

  logger.info('[Node:ResolveUserContext] SMS intent detected — resolving target contact');

  if (!mcpAdapter) {
    logger.warn('[Node:ResolveUserContext] No MCP adapter — skipping context resolution');
    return { ...state, resolveUserContextDone: true };
  }

  // ── 1. Identify target person ────────────────────────────────────────────
  const targetName = _extractTargetName(state);
  if (!targetName) {
    logger.info('[Node:ResolveUserContext] No target contact name found — pass-through');
    return { ...state, resolveUserContextDone: true };
  }

  const normalizedName = targetName.toLowerCase().replace(/\s+/g, '_');
  logger.info(`[Node:ResolveUserContext] Target contact: "${targetName}"`);

  // ── 2. Look up phone in user_profile (primary: O(1) key lookup) ──────────
  let phone = await _profileGet(mcpAdapter, `contact:${normalizedName}:phone`, userId, logger);

  // ── 3. Fallback: semantic memory search ──────────────────────────────────
  if (!phone) {
    logger.debug(`[Node:ResolveUserContext] Profile miss — trying memory search for "${targetName}"`);
    const memResult = await _memorySearchForPhone(mcpAdapter, targetName, userId, logger);
    if (memResult?.phone) {
      phone = memResult.phone;
      // Lazy backfill: write to user_profile for next time
      await _profileSet(mcpAdapter, `contact:${normalizedName}:phone`, phone, userId, logger);
      logger.info(`[Node:ResolveUserContext] Phone found in memory table — backfilled to profile key`);
    }
  }

  if (!phone) {
    logger.info(`[Node:ResolveUserContext] Could not find phone for "${targetName}" — SMS gateway cannot be resolved`);
    return { ...state, resolveUserContextDone: true };
  }

  // ── 4. Look up carrier in user_profile ───────────────────────────────────
  let carrier = await _profileGet(mcpAdapter, `contact:${normalizedName}:phone_carrier`, userId, logger);

  // ── 5. Auto-detect carrier via Numverify (once per number, then cached) ──
  if (!carrier) {
    const needsLookup = await _profileGet(mcpAdapter, `contact:${normalizedName}:phone_carrier_lookup_needed`, userId, logger);
    // Always try if not previously attempted; `phone_carrier_lookup_needed` prevents re-calling
    if (needsLookup !== 'done') {
      carrier = await _autoDetectCarrier(phone, logger);
      if (carrier) {
        await _profileSet(mcpAdapter, `contact:${normalizedName}:phone_carrier`, carrier, userId, logger);
      }
      // Mark lookup as attempted so we don't burn API quota on repeated calls
      await _profileSet(mcpAdapter, `contact:${normalizedName}:phone_carrier_lookup_needed`, 'done', userId, logger);
    }
  }

  // ── 6. Build gateway email ───────────────────────────────────────────────
  const gatewayEmail = carrier ? getGatewayEmail(phone, carrier) : null;

  if (!gatewayEmail) {
    logger.info(`[Node:ResolveUserContext] No gateway email (carrier: ${carrier || 'unknown'}) — SMS will need manual routing`);
    return {
      ...state,
      resolveUserContextDone: true,
      smsGatewayTarget: {
        name: targetName,
        phone,
        carrier: carrier || null,
        email: null,
        carrierOptions: CARRIER_OPTIONS,  // expose for UI when carrier is unknown
      },
    };
  }

  logger.info(`[Node:ResolveUserContext] SMS gateway resolved: ${gatewayEmail} (carrier: ${carrier})`);

  return {
    ...state,
    resolveUserContextDone: true,
    smsGatewayTarget: {
      name:    targetName,
      phone,
      carrier,
      email:   gatewayEmail,
    },
  };
};

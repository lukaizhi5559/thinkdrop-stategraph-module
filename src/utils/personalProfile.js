/**
 * Shared helpers for personal_profile storage and dual-write to user_profile.
 * Used by storeMemory.js and logConversation.js (auto-extraction).
 */

const SELF_FIELD_MAP = {
  user_name:    'self:first_name',  // full name stored too; split is best-effort
  my_phone:     'self:phone',
  my_email:     'self:email',
  home_address: 'self:address',
  work_address: 'self:work_address',
};

/**
 * Derive one or more profile keys from a parsed personal fact.
 * Returns an array of { key, value } pairs to write to user_profile.
 */
function profileKeysFrom(parsed) {
  const pairs = [];

  // ── Self scalar fields (name, phone, email, address) ─────────────────────
  const selfKey = SELF_FIELD_MAP[parsed.field];
  if (selfKey) {
    pairs.push({ key: selfKey, value: parsed.value });

    // Best-effort first/last split for names
    if (parsed.field === 'user_name') {
      const parts = parsed.value.trim().split(/\s+/);
      if (parts.length >= 2) {
        pairs.push({ key: 'self:first_name', value: parts[0] });
        pairs.push({ key: 'self:last_name',  value: parts.slice(1).join(' ') });
      } else {
        pairs.push({ key: 'self:first_name', value: parsed.value });
      }
      // Also store as full name
      pairs.push({ key: 'self:name', value: parsed.value });
    }

    // Phone: also store carrier lookup opportunity flag
    if (parsed.field === 'my_phone') {
      pairs.push({ key: 'self:phone_carrier_lookup_needed', value: '1' });
    }
    return pairs;
  }

  // ── Contact / relationship fields (wife, boss, dentist, etc.) ─────────────
  // field = 'wife', label = 'wife', value = 'Sarah'  → contact:wife:name
  // field = 'dentist_phone', label = 'dentist phone' → contact:dentist:phone
  const label  = (parsed.label || parsed.field || '').toLowerCase().trim();
  const fieldLC = parsed.field.toLowerCase();

  // If the field ends with a known sub-field type, use contact:<role>:<type>
  const subFieldMap = { phone: 'phone', email: 'email', address: 'address', number: 'phone' };
  for (const [suffix, subKey] of Object.entries(subFieldMap)) {
    if (fieldLC.endsWith(`_${suffix}`)) {
      const role = fieldLC.slice(0, fieldLC.length - suffix.length - 1).replace(/_/g, ' ');
      pairs.push({ key: `contact:${role}:${subKey}`, value: parsed.value });
      return pairs;
    }
  }

  // Default: store as contact:<label>:name
  if (label) {
    pairs.push({ key: `contact:${label.replace(/\s+/g, '_')}:name`, value: parsed.value });
  }
  return pairs;
}

/**
 * Fire-and-forget profile dual-write. Never throws — callers must not fail
 * just because user_profile is unreachable.
 */
async function dualWriteProfile(mcpAdapter, profilePairs, userId, logger) {
  for (const { key, value } of profilePairs) {
    try {
      await mcpAdapter.callService('user-memory', 'profile.set', {
        key,
        valueRef: value,
        userId,
      }, { timeoutMs: 4000 });
      logger.debug(`[PersonalProfile] profile.set key="${key}"`);
    } catch (e) {
      logger.warn(`[PersonalProfile] profile.set failed for key="${key}": ${e.message}`);
    }
  }
}

/**
 * Upsert a personal_profile memory row by field.
 * If a row already exists with the same user/type/field, UPDATE it so that
 * "My name is Sam" followed by "My name is Armis" leaves only one row.
 * Falls back to INSERT when no matching row exists.
 */
async function upsertPersonalProfile(mcpAdapter, parsed, userId, context, logger) {
  try {
    const listRes = await mcpAdapter.callService('user-memory', 'memory.list', {
      filters: { type: 'personal_profile' },
      limit: 1000,
      userId,
    }, { timeoutMs: 4000 });
    const listData = listRes?.data || listRes;
    const existing = (listData?.memories || []).find(
      m => m.metadata?.field === parsed.field || m.metadata?.metadata?.field === parsed.field
    );

    if (existing?.id) {
      logger.info(`[PersonalProfile] Updating existing personal_profile field="${parsed.field}" id="${existing.id}"`);
      const updateRes = await mcpAdapter.callService('user-memory', 'memory.update', {
        memoryId: existing.id,
        updates: {
          text: parsed.memText,
          entities: parsed.entityType
            ? [{ type: parsed.label, value: parsed.value, entity_type: parsed.entityType }]
            : [],
          metadata: {
            source: 'fact_declaration',
            field: parsed.field,
            sessionId: context?.sessionId,
            timestamp: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
        userId,
      }, { timeoutMs: 8000 });
      return updateRes?.data || updateRes || { memoryId: existing.id, updated: true };
    }
  } catch (e) {
    logger.warn(`[PersonalProfile] personal_profile upsert lookup failed: ${e.message} — falling back to INSERT`);
  }
  return null;
}

/**
 * Store a parsed personal_profile fact using upsert + dual-write.
 * This is the canonical write path shared by storeMemory and auto-extraction.
 */
async function storePersonalProfileFact(mcpAdapter, parsed, userId, context, logger, source = 'auto_extraction') {
  // Try upsert first
  let result = await upsertPersonalProfile(mcpAdapter, parsed, userId, context, logger);

  // Fall back to insert if no existing row was found
  if (!result) {
    result = await mcpAdapter.callService('user-memory', 'memory.store', {
      text: parsed.memText,
      type: 'personal_profile',
      userId,
      entities: parsed.entityType
        ? [{ type: parsed.label, value: parsed.value, entity_type: parsed.entityType }]
        : [],
      metadata: {
        source,
        field: parsed.field,
        sessionId: context?.sessionId,
        timestamp: new Date().toISOString(),
      },
    }, { timeoutMs: 8000 });
  }

  // Dual-write to user_profile for fast O(1) lookup
  const profilePairs = profileKeysFrom(parsed);
  if (profilePairs.length > 0) {
    dualWriteProfile(mcpAdapter, profilePairs, userId, logger).catch(() => {});
  }

  return result;
}

module.exports = {
  SELF_FIELD_MAP,
  profileKeysFrom,
  dualWriteProfile,
  upsertPersonalProfile,
  storePersonalProfileFact,
};

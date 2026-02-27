/**
 * Store Memory Node - Extracted with graceful degradation
 *
 * Stores user memory directly (for memory_store intent).
 * Works with or without MCP adapter:
 * - With MCP: Stores in user-memory service
 * - Without MCP: Returns success placeholder
 *
 * Personal-fact declarations (intent.factDeclaration = true) are stored with
 * proper type + entities so enrichIntent can find them later via memory.search.
 */

// ── Personal-fact parser ─────────────────────────────────────────────────────
// Detects the shape of a personal fact declaration and returns structured data.
// e.g. "My name is Sam"           → { memType: 'personal_profile', field: 'user_name',    label: 'name',   value: 'Sam',     entityType: 'PERSON' }
// e.g. "My wife is Sarah"         → { memType: 'personal_profile', field: 'wife',          label: 'wife',   value: 'Sarah',   entityType: 'PERSON' }
// e.g. "My dentist is Dr. Jones"  → { memType: 'personal_profile', field: 'dentist',       label: 'dentist',value: 'Dr. Jones',entityType: 'PERSON' }
// e.g. "My dentist office address is 123 Main" → { memType: 'place_entity', ... }
// e.g. "My hammer is in the garage" → { memType: 'thing_entity', ... }

const SCALAR_FIELDS = {
  name: 'user_name', phone: 'my_phone', number: 'my_phone', cell: 'my_phone',
  email: 'my_email', address: 'home_address', home: 'home_address',
  'home address': 'home_address', 'work address': 'work_address',
  office: 'work_address',
};

const PLACE_WORDS = /\b(office|clinic|hospital|gym|school|church|temple|synagogue|pharmacy|store|shop|restaurant|bar|salon|barbershop|library|bank|studio|warehouse|garage|lab|headquarters)\b/i;
const THING_WORDS = /\b(hammer|wrench|drill|saw|computer|laptop|tablet|phone|camera|bag|wallet|keys|car|truck|bike|bicycle|watch|glasses|charger|cable|router|keyboard|mouse|printer)\b/i;

function parsePersonalFact(text) {
  const t = text.trim();

  // "I am Sam" / "I'm Sam"
  const iAmMatch = t.match(/^i\s+(?:am|'m)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\s*$/i);
  if (iAmMatch) {
    return {
      memType: 'personal_profile',
      field: 'user_name',
      label: 'name',
      value: iAmMatch[1].trim(),
      entityType: 'PERSON',
      memText: `My name is ${iAmMatch[1].trim()}`,
    };
  }

  // Inverted: "Chris Akers is my cousin", "John is my boss"
  // Must appear before myMatch since this starts with a capital/name, not "my"
  const invertedMatch = t.match(/^([A-Z][\w\s.'-]{1,40})\s+(?:is|are|was)\s+my\s+([\w\s']+?)\s*$/i);
  if (invertedMatch) {
    const value = invertedMatch[1].trim().replace(/[.!?]+$/, '');
    const rawLabel = invertedMatch[2].trim().toLowerCase();
    return {
      memType: 'personal_profile',
      field: rawLabel.replace(/\s+/g, '_'),
      label: rawLabel,
      value,
      entityType: 'PERSON',
      memText: `My ${rawLabel} is ${value}`,
    };
  }

  // "My <role/field> [name] is/are <value>"
  const myMatch = t.match(/^my\s+([\w\s']+?)\s+(?:name\s+)?(?:is|are|was)\s+(.+)$/i);
  if (myMatch) {
    const rawLabel = myMatch[1].trim().toLowerCase();
    const value = myMatch[2].trim().replace(/[.!?]+$/, '');

    // Scalar: my name, my phone, my email, my address
    if (SCALAR_FIELDS[rawLabel]) {
      const field = SCALAR_FIELDS[rawLabel];
      const templates = {
        user_name:    (v) => `My name is ${v}`,
        my_phone:     (v) => `My phone number is ${v}`,
        my_email:     (v) => `My email address is ${v}`,
        home_address: (v) => `My home address is ${v}`,
        work_address: (v) => `My work address is ${v}`,
      };
      return {
        memType: 'personal_profile',
        field,
        label: rawLabel,
        value,
        entityType: null,
        memText: templates[field] ? templates[field](value) : `My ${rawLabel} is ${value}`,
      };
    }

    // Place: "my dentist office", "my gym", "my doctor's office"
    if (PLACE_WORDS.test(rawLabel)) {
      return {
        memType: 'place_entity',
        field: rawLabel.replace(/\s+/g, '_'),
        label: rawLabel,
        value,
        entityType: 'PLACE',
        memText: `My ${rawLabel} — ${value}`,
      };
    }

    // Thing: "my hammer", "my car"
    if (THING_WORDS.test(rawLabel)) {
      return {
        memType: 'thing_entity',
        field: rawLabel.replace(/\s+/g, '_'),
        label: rawLabel,
        value,
        entityType: 'THING',
        memText: `My ${rawLabel} — ${value}`,
      };
    }

    // Person relationship: "my wife", "my cousin", "my boss", etc.
    return {
      memType: 'personal_profile',
      field: rawLabel.replace(/\s+/g, '_'),
      label: rawLabel,
      value,
      entityType: 'PERSON',
      memText: `My ${rawLabel} — ${value}`,
    };
  }

  return null;
}

// ── Main node ────────────────────────────────────────────────────────────────

module.exports = async function storeMemory(state) {
  const { mcpAdapter, message, resolvedMessage, intent, context } = state;
  const logger = state.logger || console;
  const userId = context?.userId || 'local_user';
  const text = (resolvedMessage || message || '').trim();

  logger.debug('[Node:StoreMemory] Storing memory...');

  if (!mcpAdapter) {
    logger.warn('[Node:StoreMemory] No MCP adapter - memory not stored');
    return {
      ...state,
      memoryStored: false,
      answer: `[MCP not available — Memory would be stored: "${text}"]`,
    };
  }

  try {
    // ── Personal-fact declaration path ───────────────────────────────────────
    if (intent?.factDeclaration) {
      const parsed = parsePersonalFact(text);
      if (parsed) {
        logger.info(`[Node:StoreMemory] Personal-fact declaration — field: ${parsed.field}, value: "${parsed.value}", type: ${parsed.memType}`);

        const entities = parsed.entityType
          ? [{ type: parsed.label, value: parsed.value, entity_type: parsed.entityType }]
          : [];

        const result = await mcpAdapter.callService('user-memory', 'memory.store', {
          text: parsed.memText,
          type: parsed.memType,
          userId,
          entities,
          metadata: {
            source: 'fact_declaration',
            field: parsed.field,
            sessionId: context?.sessionId,
            timestamp: new Date().toISOString(),
          },
        }, { timeoutMs: 8000 });

        const memoryData = result?.data || result;
        logger.info(`[Node:StoreMemory] Stored ${parsed.memType}: "${parsed.memText}"`);

        return {
          ...state,
          memoryStored: true,
          memoryId: memoryData?.id,
          answer: `Got it — I'll remember that your ${parsed.label} is ${parsed.value}.`,
        };
      }
    }

    // ── General memory store path ────────────────────────────────────────────
    const entities = intent?.entities || [];
    const tags = ['user_memory', intent?.type || 'unknown'];
    entities.forEach(e => { if (e.type) tags.push(e.type); });

    const result = await mcpAdapter.callService('user-memory', 'memory.store', {
      text,
      type: 'user_memory',
      userId,
      tags,
      entities,
      metadata: {
        source: 'user_input',
        intent: intent?.type,
        confidence: intent?.confidence,
        sessionId: context?.sessionId,
        userId,
        timestamp: new Date().toISOString(),
      },
    }, { timeoutMs: 8000 });

    const memoryData = result?.data || result;
    logger.debug('[Node:StoreMemory] Memory stored successfully');

    return {
      ...state,
      memoryStored: true,
      memoryId: memoryData?.id,
      answer: "Got it! I'll remember that.",
    };
  } catch (error) {
    logger.error('[Node:StoreMemory] Error:', error.message);
    return {
      ...state,
      memoryStored: false,
      error: error.message,
      answer: "I had trouble storing that memory. Please try again.",
    };
  }
};

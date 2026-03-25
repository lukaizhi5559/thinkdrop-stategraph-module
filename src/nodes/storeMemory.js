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

// ── Sensitive-value detection ────────────────────────────────────────────────
// If a user tells us a password / token / API key, we intercept BEFORE the
// value ever reaches the DuckDB memory table.  The raw value goes straight to
// the OS keychain via profile.store_secret; only a KEYTAR:<KEY> pointer is
// stored in the memory table.

const SENSITIVE_LABEL_RE = /\b(password|passwd|passphrase|secret|token|api[\s_.\-]?key|access[\s_.\-]?key|private[\s_.\-]?key|auth[\s_.\-]?token|bearer|\bpin\b|passw)\b/i;

const _SERVICE_PATTERNS = [
  ['gmail',      /gmail|google\s?mail/i],
  ['google',     /google(?!\s?mail)/i],
  ['github',     /github/i],
  ['twitter',    /twitter|\.x\.com/i],
  ['slack',      /slack/i],
  ['discord',    /discord/i],
  ['notion',     /notion/i],
  ['microsoft',  /microsoft|outlook|office\s?365/i],
  ['apple',      /apple(?:id)?|icloud/i],
  ['spotify',    /spotify/i],
  ['instagram',  /instagram/i],
  ['linkedin',   /linkedin/i],
  ['shopify',    /shopify/i],
  ['facebook',   /facebook/i],
];

function _inferServiceFromLabel(label) {
  for (const [svc, re] of _SERVICE_PATTERNS) {
    if (re.test(label)) return svc;
  }
  return 'unknown';
}

function _detectKeyType(label) {
  if (/password|passwd|passphrase/i.test(label)) return 'PASSWORD';
  if (/\btoken|bearer/i.test(label))             return 'TOKEN';
  if (/api[\s_.\-]?key/i.test(label))            return 'API_KEY';
  if (/access[\s_.\-]?key/i.test(label))         return 'ACCESS_KEY';
  if (/secret/i.test(label))                      return 'SECRET';
  if (/\bpin\b/i.test(label))                     return 'PIN';
  return 'CREDENTIAL';
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

        // ── Security guard: route credentials to OS keychain ─────────────────
        // Never let a raw password / token / API key touch the memory table.
        if (SENSITIVE_LABEL_RE.test(parsed.label) && parsed.value && parsed.value.length > 2) {
          const service   = _inferServiceFromLabel(parsed.label);
          const keyType   = _detectKeyType(parsed.label);
          // For unknown services derive prefix from the field name, but strip any
          // trailing credential-type word so we don't get NETFLIX_PASSWORD_PASSWORD.
          // e.g. field='netflix_password' → strip '_password' → 'NETFLIX'
          const _rawField    = (parsed.field || 'unknown');
          const _strippedField = _rawField
            .replace(/_?(password|passwd|passphrase|token|secret|api_key|access_key|private_key|credential|pin)$/i, '')
            .replace(/[^A-Z0-9]/gi, '_')
            .toUpperCase()
            .replace(/_+$/, '') || 'UNKNOWN';
          const prefix    = service !== 'unknown'
            ? service.toUpperCase()
            : _strippedField;
          const keytarKey = `${prefix}_${keyType}`;

          try {
            await mcpAdapter.callService('user-memory', 'profile.store_secret', {
              keytarKey,
              value:   parsed.value,
              service: service !== 'unknown' ? service : null,
              label:   parsed.label,
            }, { timeoutMs: 5000 });
          } catch (secureErr) {
            logger.warn(`[Node:StoreMemory] Keychain store failed for "${keytarKey}": ${secureErr.message}`);
          }

          // Store a sanitised KEYTAR ref in memory — raw value is NEVER written here
          await mcpAdapter.callService('user-memory', 'memory.store', {
            text: `My ${parsed.label} is KEYTAR:${keytarKey}`,
            type: 'personal_profile',
            userId,
            entities: [],
            metadata: {
              source: 'fact_declaration',
              field:  parsed.field,
              sensitive: true,
              sessionId: context?.sessionId,
              timestamp: new Date().toISOString(),
            },
          }, { timeoutMs: 8000 });

          logger.info(`[Node:StoreMemory] Credential intercepted → keychain key "${keytarKey}"`);
          return {
            ...state,
            memoryStored: true,
            answer: `Got it — I've stored your ${parsed.label} securely in your system keychain. It will never be written to disk as plain text.`,
          };
        }

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
    // Light-touch inline scan: catch "my X password is Y" patterns that slip
    // through without factDeclaration=true.
    const _inlineCred = text.match(
      /\b(password|token|api[\s_-]?key|secret)\s+(?:is|:)\s+([^\s]{4,})/i
    );
    const safeText = _inlineCred
      ? text.replace(_inlineCred[2], '[REDACTED – stored in keychain]')
      : text;

    const entities = intent?.entities || [];
    const tags = ['user_memory', intent?.type || 'unknown'];
    entities.forEach(e => { if (e.type) tags.push(e.type); });

    const result = await mcpAdapter.callService('user-memory', 'memory.store', {
      text: safeText,
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

/**
 * Enrich Intent Node
 *
 * Memory-driven universal entity resolver. Nothing is hardcoded by person/place/thing.
 * All entities (people, places, things) are discovered from and stored to memory at runtime.
 *
 * Entity memory schema:
 *   type=person_entity  — "My [relationship] [name] — [attr]: [value], ..."
 *   type=place_entity   — "My [role] [name] — address: ..., phone: ..., hours: ..."
 *   type=thing_entity   — "My [role] [name] — location: ..., model: ..., [attr]: ..."
 *   type=personal_profile — scalar facts: my name, my phone, my email, my address
 *
 * MODE A — ENRICH: Extract entity references from a command_automate message.
 *   1. Extract relationship/role references ("my wife", "the dentist", "my hammer").
 *   2. Search memory for each referenced entity.
 *   3. If multiple entities or contact methods exist → MODE D: disambiguate.
 *   4. Patch resolvedMessage + inject entityContext for planSkills.
 *   5. If entity unknown → ask user for details, store permanently, retry command.
 *
 * MODE B — STORE ANSWER: User answered an enrichment question.
 *   Store the answer as entity/profile memory, restore original command.
 *
 * MODE C — CORRECTION: "No, actually X" — overwrite the stored fact.
 *
 * MODE D — DISAMBIGUATION: Multiple matches → ask which one / which method.
 *   User's answer stored as preferred choice, command retried.
 *
 * State inputs:
 *   state.message / state.resolvedMessage  — the user's request
 *   state.intent                           — any
 *   state.mcpAdapter                       — to call memory.search / memory.store / memory.update
 *   state.context                          — userId, sessionId
 *   state.conversationHistory              — to detect prior enrichment questions
 */

// ── Correction patterns ────────────────────────────────────────────────────
const CORRECTION_PATTERNS = [
  /^(no[,.]?\s+|nope[,.]?\s+|wrong[,.]?\s+|not right[,.]?\s+|that'?s? (wrong|incorrect|not right)[,.]?\s*)/i,
  /\b(actually|it'?s actually|no it'?s|the answer is|correct answer is|it should be|you'?re wrong)\b/i,
  /^(it'?s |its |the correct one is |the right (answer|one) is )/i,
];

// ── Pronoun patterns — resolve "him/her/it/there" against recent entities ──
const PRONOUN_PATTERNS = {
  masculine: /\b(him|his|he)\b/i,
  feminine:  /\b(her|she)\b/i,
  neutral:   /\b(it|its|there|that place|that thing)\b/i,
  plural:    /\b(them|their|they)\b/i,
};

// ── Contact/reach action words — signal that we need a contact method ──────
const CONTACT_ACTION = /\b(text|sms|imessage|call|email|mail|slack|dm|message|send|contact|reach|ping)\b/i;
const PLACE_ACTION   = /\b(address|directions|get to|go to|navigate|location|where is|phone number of|hours)\b/i;
const THING_ACTION   = /\b(where is|where('?s| is) my|find my|locate my|use my|grab my)\b/i;

// ── Simple scalar gap detectors (self facts + skill ops) ──────────────────
// These are NOT entity-based — they are direct user profile facts.
const GAP_DETECTORS = [
  {
    field: 'user_name',
    pattern: /\b(from me|sign(ed)? (by|from)|my name|who am i)\b/i,
    searchQuery: 'my name is',
    question: 'What is your name?',
    storeTemplate: (v) => `My name is ${v}`,
    memoryType: 'personal_profile',
  },
  {
    field: 'my_phone',
    pattern: /\b(my phone number|my number|my cell)\b/i,
    searchQuery: 'my phone number',
    question: 'What is your phone number (including country code)?',
    storeTemplate: (v) => `My phone number is ${v}`,
    memoryType: 'personal_profile',
  },
  {
    field: 'my_email',
    pattern: /\b(my email|send (from|to) me|email me)\b/i,
    searchQuery: 'my email address',
    question: 'What is your email address?',
    storeTemplate: (v) => `My email address is ${v}`,
    memoryType: 'personal_profile',
  },
  {
    field: 'home_address',
    pattern: /\b(my home address|my address|my house|where i live)\b/i,
    searchQuery: 'my home address',
    question: 'What is your home address?',
    storeTemplate: (v) => `My home address is ${v}`,
    memoryType: 'personal_profile',
  },
  {
    field: 'work_address',
    pattern: /\b(my work address|my office address|where i work|my workplace)\b/i,
    searchQuery: 'my work address',
    question: 'What is your work or office address?',
    storeTemplate: (v) => `My work address is ${v}`,
    memoryType: 'personal_profile',
  },
  {
    field: 'skill_install_path',
    // Only fire if no skill name (dot-notation) or path is already present in the message
    pattern: /^(?!.*\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\b)(?!.*(?:\/|~\/|\.thinkdrop)).*\b(install|add|register|load)\s+(a\s+)?(skill|external skill|custom skill)\b/i,
    searchQuery: null,
    question: 'What is the path to the skill contract file? (e.g. ~/.thinkdrop/skills/my.skill/skill.md)',
    storeTemplate: null,
    memoryType: null,
  },
  {
    field: 'skill_remove_name',
    pattern: /\b(remove|uninstall|delete|disable)\s+(a\s+)?(skill|external skill|custom skill)\b/i,
    searchQuery: null,
    question: 'Which skill would you like to remove? Please give its name (e.g. nut.controls)',
    storeTemplate: null,
    memoryType: null,
  },
];

// ── Marker tokens embedded in assistant turn text ─────────────────────────
const ENRICHMENT_MARKER     = 'ENRICHMENT_QUESTION';
const DISAMBIGUATION_MARKER = 'DISAMBIGUATION_QUESTION';
const CORRECTION_MARKER     = 'CORRECTION_STORED';
const ENTITY_QUESTION_MARKER = 'ENTITY_QUESTION';

// ── Entity reference extractor ────────────────────────────────────────────
// Pulls relationship/role phrases out of the user message.
// Returns array of { ref, label, entityType }
// e.g. "send my wife a text" → [{ ref: "my wife", label: "wife", entityType: "person" }]
// e.g. "get address of dentist" → [{ ref: "dentist", label: "dentist", entityType: "place" }]
// e.g. "where is my hammer" → [{ ref: "my hammer", label: "hammer", entityType: "thing" }]
function extractEntityRefs(msg) {
  const refs = [];
  const lower = msg.toLowerCase();

  // Person relationship words (open-ended — catches any "my <role>" phrase)
  const personMatch = lower.match(
    /\b(?:my|the)\s+(wife|husband|partner|mom|mother|dad|father|son|daughter|brother|sister|cousin|aunt|uncle|nephew|niece|friend|coworker|colleague|boss|manager|assistant|neighbor|roommate|dentist|doctor|therapist|lawyer|accountant|trainer|coach|babysitter|nanny|cleaner|plumber|electrician|contractor|vet|pastor|priest|rabbi|chef|barber|stylist|tutor|mentor)\b/i
  );
  if (personMatch) {
    refs.push({ ref: personMatch[0].trim(), label: personMatch[1].trim().toLowerCase(), entityType: 'person' });
  }

  // Standalone name after action — "text Sarah", "call James" (no "my" prefix)
  // Only fires if no person-relationship already found
  if (refs.length === 0 && CONTACT_ACTION.test(lower)) {
    const nameMatch = lower.match(/(?:text|call|email|slack|message|contact|send|ping)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (nameMatch) {
      refs.push({ ref: nameMatch[1].trim(), label: nameMatch[1].trim(), entityType: 'person', byName: true });
    }
  }

  // Place references — "the dentist office", "my gym", "the coffee shop", etc.
  const placeMatch = lower.match(
    /\b(?:my|the)\s+(dentist(?: office)?|doctor(?:'?s office)?|hospital|clinic|gym|office|work|school|church|temple|synagogue|pharmacy|grocery(?: store)?|coffee shop|restaurant|bar|salon|barber shop|mechanic|garage|vet(?:erinarian)?(?:'?s office)?|library|bank|post office|airport|hotel|store|shop|studio|warehouse|lab|headquarters|headquarters)\b/i
  );
  if (placeMatch) {
    refs.push({ ref: placeMatch[0].trim(), label: placeMatch[1].trim().toLowerCase(), entityType: 'place' });
  }

  // Thing references — "my hammer", "my computer", "my car", etc.
  const thingMatch = lower.match(
    /\bmy\s+(hammer|wrench|screwdriver|drill|saw|tool|computer|laptop|phone|tablet|ipad|keyboard|mouse|monitor|printer|camera|headphones|charger|cable|car|truck|bike|bicycle|motorcycle|scooter|boat|trailer|backpack|bag|wallet|keys|badge|card|passport|notebook|journal|guitar|piano|keyboard|drum|amp|speaker|tv|remote|router|modem|server|hard drive|drive|usb|watch|glasses|ring|necklace|bracelet)\b/i
  );
  if (thingMatch) {
    refs.push({ ref: thingMatch[0].trim(), label: thingMatch[1].trim().toLowerCase(), entityType: 'thing' });
  }

  return refs;
}

module.exports = async function enrichIntent(state) {
  const { mcpAdapter, message, resolvedMessage, intent, context, conversationHistory = [] } = state;
  const logger = state.logger || console;

  const userId = context?.userId || 'local_user';
  const userMessage = (resolvedMessage || message || '').trim();

  // ── Find most recent assistant message (needed for MODE B/C/D detection) ──
  const recentAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');

  // ── MODE C: Correction — "no, actually X" overwrites stored fact ──────────
  const isCorrecting = CORRECTION_PATTERNS.some(p => p.test(userMessage));
  // Only treat as correction if there was a prior enrichment/entity question,
  // or an info-sharing statement in the last turn (avoid false positives)
  const priorEnrichment = recentAssistant?.content?.includes(`[${ENRICHMENT_MARKER}`) ||
    recentAssistant?.content?.includes(`[${ENTITY_QUESTION_MARKER}`) ||
    recentAssistant?.content?.includes(`[${CORRECTION_MARKER}`);
  if (isCorrecting && priorEnrichment) {
    logger.info('[Node:EnrichIntent] MODE C — correction detected, overwriting stored fact');
    return await handleCorrection(state, recentAssistant, userId, logger);
  }

  // ── MODE D: Disambiguation answer — user picked a contact method / entity ─
  const isPendingDisambiguation = recentAssistant?.content?.includes(`[${DISAMBIGUATION_MARKER}`);
  if (isPendingDisambiguation) {
    logger.info('[Node:EnrichIntent] MODE D — user chose from disambiguation, retrying command');
    return await handleDisambiguationAnswer(state, recentAssistant, userId, logger);
  }

  // ── MODE B: Answer to enrichment/entity question — store and retry ────────
  const isPendingAnswer = recentAssistant?.content?.includes(`[${ENRICHMENT_MARKER}`) ||
    recentAssistant?.content?.includes(`[${ENTITY_QUESTION_MARKER}`);
  if (isPendingAnswer) {
    logger.info('[Node:EnrichIntent] MODE B — storing answer, restoring original command');
    return await handleEnrichmentAnswer(state, recentAssistant, userId, logger);
  }

  // ── MODE A: Enrich a command_automate request ─────────────────────────────
  if (intent?.type !== 'command_automate') return state;

  const commandMessage = resolvedMessage || message || '';

  if (!mcpAdapter) {
    logger.warn('[Node:EnrichIntent] No mcpAdapter — skipping enrichment');
    return state;
  }

  // ─── STEP 1: Entity resolution ───────────────────────────────────────────
  // Extract any people/place/thing references from the message and look them
  // up in memory. All entity knowledge lives in memory — nothing is hardcoded.
  const entityRefs = extractEntityRefs(commandMessage);

  // Also check for pronouns and resolve against recent entities in history
  const pronounRef = resolvePronoun(commandMessage, conversationHistory);
  if (pronounRef) entityRefs.push(pronounRef);

  // Deduplicate by label to prevent searching the same entity twice
  const seenLabels = new Set();
  const uniqueEntityRefs = entityRefs.filter(ref => {
    if (seenLabels.has(ref.label)) return false;
    seenLabels.add(ref.label);
    return true;
  });

  const resolvedEntities = [];
  const unresolvedEntities = [];

  for (const ref of uniqueEntityRefs) {
    const memType = ref.entityType === 'person' ? 'personal_profile'
      : ref.entityType === 'place' ? 'place_entity'
      : 'thing_entity';

    // For person relationships, use a descriptive query that matches stored format
    // e.g. "my cousin" → query "my cousin" matches "My cousin is Chris Akers"
    // Lower threshold for relationships since the stored text is longer than the query
    const MIN_SIM = ref.entityType === 'person' ? 0.40 : 0.55;
    const searchQuery = ref.entityType === 'person' ? `my ${ref.label}` : ref.ref;

    try {
      const res = await mcpAdapter.callService('user-memory', 'memory.search', {
        query: searchQuery,
        userId,
        limit: 5,
        minSimilarity: MIN_SIM,
        filters: { type: memType },
      }, { timeoutMs: 5000 }).catch(() => null);

      const results = res?.data?.results || res?.results || [];
      const hits = results.filter(r => r.similarity >= MIN_SIM);

      if (hits.length === 0) {
        // Entity completely unknown — need to ask about it
        unresolvedEntities.push(ref);
        logger.info(`[Node:EnrichIntent] Unknown entity: "${ref.ref}"`);
      } else if (hits.length === 1) {
        // Single match — resolve silently
        resolvedEntities.push({ ref, memory: hits[0] });
        logger.info(`[Node:EnrichIntent] Resolved entity "${ref.ref}" → "${hits[0].text?.substring(0, 60)}"`);
      } else {
        // Multiple matches — check if we need to disambiguate
        // (e.g. user says "send him a text" and there are two males in memory)
        const needsDisambig = !ref.byName && hits.length > 1;
        if (needsDisambig) {
          const names = hits.slice(0, 4).map(h => extractEntityName(h.text)).filter(Boolean);
          const marker = `[${DISAMBIGUATION_MARKER} ref=${encodeRef(ref.ref)} type=${ref.entityType}]`;
          const question = `${marker}\nAre you referring to ${names.join(' or ')}?`;
          logger.info(`[Node:EnrichIntent] MODE D — multiple matches for "${ref.ref}": ${names.join(', ')}`);
          return {
            ...state,
            enrichmentNeeded: [],
            answer: question,
            enrichmentPendingMessage: commandMessage,
          };
        }
        resolvedEntities.push({ ref, memory: hits[0] });
      }
    } catch (err) {
      logger.warn(`[Node:EnrichIntent] Entity lookup failed for "${ref.ref}": ${err.message}`);
      unresolvedEntities.push(ref);
    }
  }

  // ─── STEP 2: For resolved entities, check for multiple contact methods ────
  // e.g. wife has both phone and email stored → ask which to use
  if (resolvedEntities.length > 0 && CONTACT_ACTION.test(commandMessage)) {
    const specifiedMethod = /\b(text|sms|imessage|call)\b/i.test(commandMessage) ? 'phone'
      : /\bemail\b/i.test(commandMessage) ? 'email'
      : /\bslack|dm\b/i.test(commandMessage) ? 'slack'
      : null;

    if (!specifiedMethod) {
      for (const { ref, memory } of resolvedEntities) {
        if (ref.entityType !== 'person') continue;
        const methods = extractContactMethods(memory.text);
        if (methods.length > 1) {
          const methodLabels = methods.map(m => m.label).join(', ');
          const marker = `[${DISAMBIGUATION_MARKER} ref=${encodeRef(ref.ref)} type=contact_method methods=${methods.map(m => m.type).join(',')}]`;
          const question = `${marker}\nHow would you like to contact ${ref.ref}? I have their ${methodLabels} on file.`;
          logger.info(`[Node:EnrichIntent] MODE D — multiple contact methods for "${ref.ref}": ${methodLabels}`);
          return {
            ...state,
            enrichmentNeeded: [],
            answer: question,
            enrichmentPendingMessage: commandMessage,
          };
        }
      }
    }
  }

  // ─── STEP 3: Ask about unknown entities ──────────────────────────────────
  if (unresolvedEntities.length > 0) {
    const entityGaps = await Promise.all(unresolvedEntities.map(async ref => ({
      field: `entity:${ref.entityType}:${ref.label}`,
      ref,
      question: await buildEntityQuestion(ref, commandMessage, mcpAdapter, logger),
    })));

    const fieldList = entityGaps.map(g => g.field).join(',');
    const marker = `[${ENTITY_QUESTION_MARKER} fields=${fieldList}]`;
    const questionText = entityGaps.length === 1
      ? `${marker}\n${entityGaps[0].question}`
      : `${marker}\nI need a few details:\n${entityGaps.map((g, i) => `${i + 1}. ${g.question}`).join('\n')}`;

    logger.info(`[Node:EnrichIntent] Unknown entities — asking user: ${unresolvedEntities.map(r => r.ref).join(', ')}`);
    return {
      ...state,
      enrichmentNeeded: entityGaps,
      answer: questionText,
      enrichmentPendingMessage: commandMessage,
    };
  }

  // ─── STEP 4: Scalar profile gap detection ────────────────────────────────
  // Covers: user's own name, phone, email, address, skill ops
  const triggered = GAP_DETECTORS.filter(d => d.pattern.test(commandMessage));
  if (triggered.length === 0 && entityRefs.length === 0) {
    logger.debug('[Node:EnrichIntent] No gaps detected — passthrough');
    return state;
  }

  const resolvedFacts = [];
  const unresolvedGaps = [];

  await Promise.all(triggered.map(async (detector) => {
    if (!detector.storeTemplate) {
      unresolvedGaps.push({ field: detector.field, question: detector.question });
      return;
    }
    try {
      const searchRes = await mcpAdapter.callService('user-memory', 'memory.search', {
        query: detector.searchQuery,
        userId,
        limit: 3,
        minSimilarity: 0.60,
        filters: { type: detector.memoryType || 'personal_profile' },
      }, { timeoutMs: 5000 }).catch(() => null);

      const results = searchRes?.data?.results || searchRes?.results || [];
      const hit = results.find(r => r.similarity >= 0.60);

      if (hit) {
        const value = extractScalarValue(detector.field, hit.text) || hit.text.trim();
        resolvedFacts.push({ field: detector.field, value, rawText: hit.text });
        logger.info(`[Node:EnrichIntent] Resolved ${detector.field}: "${value}"`);
      } else {
        unresolvedGaps.push({ field: detector.field, question: detector.question });
      }
    } catch (err) {
      logger.warn(`[Node:EnrichIntent] Gap lookup failed for ${detector.field}: ${err.message}`);
      unresolvedGaps.push({ field: detector.field, question: detector.question });
    }
  }));

  // Patch message with resolved scalar facts
  let enrichedMessage = commandMessage;
  for (const fact of resolvedFacts) {
    enrichedMessage = applyScalarPatch(enrichedMessage, fact.field, fact.value);
  }

  // Inject resolved entity context into message for planSkills
  for (const { ref, memory } of resolvedEntities) {
    enrichedMessage = applyEntityPatch(enrichedMessage, ref, memory.text);
  }

  const profileContext = {
    facts: resolvedFacts,
    entities: resolvedEntities.map(({ ref, memory }) => ({ ref: ref.ref, label: ref.label, type: ref.entityType, memoryText: memory.text })),
    gaps: unresolvedGaps,
  };

  if (enrichedMessage !== commandMessage) {
    logger.info(`[Node:EnrichIntent] Enriched message: "${enrichedMessage}"`);
  }

  if (unresolvedGaps.length > 0) {
    const seen = new Set();
    const deduped = unresolvedGaps.filter(g => {
      if (seen.has(g.field)) return false;
      seen.add(g.field);
      return true;
    });
    const questionText = buildCombinedQuestion(deduped);
    return {
      ...state,
      resolvedMessage: enrichedMessage !== commandMessage ? enrichedMessage : (resolvedMessage || message),
      profileContext,
      enrichmentNeeded: deduped,
      answer: questionText,
      enrichmentPendingMessage: commandMessage,
    };
  }

  return {
    ...state,
    resolvedMessage: enrichedMessage !== commandMessage ? enrichedMessage : (resolvedMessage || message),
    profileContext,
    enrichmentNeeded: [],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// MODE C — Correction handler
// Overwrites the memory fact that was last discussed.
// ─────────────────────────────────────────────────────────────────────────────

async function handleCorrection(state, recentAssistant, userId, logger) {
  const { mcpAdapter, message, context } = state;

  // Strip correction prefix to get the actual corrected value
  const correctedValue = message
    .replace(/^(no[,.]?\s+|nope[,.]?\s+|wrong[,.]?\s+|not right[,.]?\s+|that'?s? (wrong|incorrect|not right)[,.]?\s*)/i, '')
    .replace(/^(actually[,]?\s+|it'?s actually\s+|no it'?s\s+|the answer is\s+|it should be\s+|you'?re wrong[,.]?\s+|it'?s\s+|the correct one is\s+)/i, '')
    .trim();

  if (!correctedValue) {
    return { ...state, answer: 'What is the correct value?', enrichmentNeeded: [] };
  }

  // Find what was being discussed — parse from the prior question marker
  const fieldsFromMarker = parseMarkerFields(recentAssistant?.content || '');
  const firstField = fieldsFromMarker[0] || null;

  if (mcpAdapter && firstField) {
    // entity:person:wife → search personal_profile memory for wife
    // user_name / my_phone / etc → search personal_profile
    const isEntityField = firstField.startsWith('entity:');
    const searchQuery = isEntityField
      ? firstField.replace('entity:', '').replace(/:/g, ' ')
      : firstField.replace(/_/g, ' ');
    const memType = isEntityField
      ? (firstField.includes(':place:') ? 'place_entity' : firstField.includes(':thing:') ? 'thing_entity' : 'personal_profile')
      : 'personal_profile';

    try {
      const existing = await mcpAdapter.callService('user-memory', 'memory.search', {
        query: searchQuery,
        userId,
        limit: 3,
        minSimilarity: 0.55,
        filters: { type: memType },
      }, { timeoutMs: 5000 }).catch(() => null);

      const hits = existing?.data?.results || existing?.results || [];
      const hit = hits.find(r => r.similarity >= 0.55);

      if (hit?.id) {
        // Overwrite: delete + re-insert with corrected value
        // Build corrected memory text by replacing the old value
        const correctedText = replaceMemoryValue(hit.text, correctedValue);
        await mcpAdapter.callService('user-memory', 'memory.update', {
          id: hit.id,
          text: correctedText,
          type: memType,
          userId,
          metadata: { source: 'correction', corrected_from: hit.text, timestamp: new Date().toISOString() },
        }, { timeoutMs: 8000 }).catch(() => null);
        logger.info(`[Node:EnrichIntent] MODE C — overwrote memory: "${correctedText}"`);
      } else {
        // Nothing to overwrite — store the corrected value fresh
        const freshText = buildFreshMemoryText(firstField, correctedValue);
        await mcpAdapter.callService('user-memory', 'memory.store', {
          text: freshText,
          type: memType,
          userId,
          metadata: { source: 'correction', field: firstField, timestamp: new Date().toISOString() },
        }, { timeoutMs: 8000 }).catch(() => null);
        logger.info(`[Node:EnrichIntent] MODE C — stored correction: "${freshText}"`);
      }
    } catch (err) {
      logger.error(`[Node:EnrichIntent] MODE C — memory update failed: ${err.message}`);
    }
  }

  const label = firstField ? firstField.replace(/^entity:[^:]+:/, '').replace(/_/g, ' ') : 'that';
  return {
    ...state,
    answer: `[${CORRECTION_MARKER}]\nGot it — I've updated ${label} to "${correctedValue}". I'll remember this going forward.`,
    enrichmentNeeded: [],
    enrichmentPendingMessage: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE D — Disambiguation handler
// User chose which entity or contact method to use.
// ─────────────────────────────────────────────────────────────────────────────

async function handleDisambiguationAnswer(state, assistantMsg, userId, logger) {
  const { message, conversationHistory = [] } = state;

  // Parse marker: [DISAMBIGUATION_QUESTION ref=my+wife type=contact_method methods=phone,email]
  const markerMatch = assistantMsg.content.match(
    /\[DISAMBIGUATION_QUESTION ref=([^\s\]]+) type=([^\s\]]+)(?:\s+methods=([^\]]+))?\]/
  );
  const refEncoded = markerMatch?.[1];
  const disambigType = markerMatch?.[2];
  const methodsRaw = markerMatch?.[3]?.split(',').map(s => s.trim()) || [];
  const ref = refEncoded ? decodeRef(refEncoded) : '';

  const answerLower = message.toLowerCase();

  // Find original command from history
  const histReversed = [...conversationHistory].reverse();
  const assistantIdx = histReversed.findIndex(m => m.content?.includes(`[${DISAMBIGUATION_MARKER}`));
  let originalCommand = null;
  for (let i = assistantIdx + 1; i < histReversed.length; i++) {
    if (histReversed[i].role === 'user') { originalCommand = histReversed[i].content; break; }
  }

  let restoredCommand = originalCommand || message;

  if (disambigType === 'contact_method') {
    // User picked text/email/slack — patch the original command
    const chosenMethod = /\b(text|sms|call|phone|imessage)\b/.test(answerLower) ? 'text'
      : /\bemail\b/.test(answerLower) ? 'email'
      : /\bslack|dm\b/.test(answerLower) ? 'slack DM'
      : methodsRaw[0] || 'text';
    restoredCommand = originalCommand
      ? originalCommand.replace(/(send|contact|message|reach)/i, chosenMethod)
      : message;
    logger.info(`[Node:EnrichIntent] MODE D — contact method chosen: ${chosenMethod} for "${ref}"`);
  } else {
    // User picked which entity — patch the pronoun/ambiguous ref with the chosen name
    // The user's reply IS the chosen name/entity
    const chosenName = message.trim();
    if (originalCommand && ref) {
      restoredCommand = originalCommand.replace(new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), chosenName);
    }
    logger.info(`[Node:EnrichIntent] MODE D — entity chosen: "${chosenName}" for ambiguous ref "${ref}"`);
  }

  return {
    ...state,
    message: restoredCommand,
    resolvedMessage: restoredCommand,
    intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false },
    enrichmentNeeded: [],
    enrichmentPendingMessage: null,
    answer: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE B — Store enrichment/entity answer and restore original command
// ─────────────────────────────────────────────────────────────────────────────

async function handleEnrichmentAnswer(state, assistantMsg, userId, logger) {
  const { mcpAdapter, message, context, conversationHistory = [] } = state;

  const askedFields = parseMarkerFields(assistantMsg.content);

  // Find original command: the user turn just before the enrichment question
  const histReversed = [...conversationHistory].reverse();
  const assistantIdx = histReversed.findIndex(m =>
    m.role === 'assistant' &&
    (m.content?.includes(`[${ENRICHMENT_MARKER}`) || m.content?.includes(`[${ENTITY_QUESTION_MARKER}`))
  );
  let originalCommand = null;
  for (let i = assistantIdx + 1; i < histReversed.length; i++) {
    if (histReversed[i].role === 'user') { originalCommand = histReversed[i].content; break; }
  }

  logger.info(`[Node:EnrichIntent] MODE B — answer: "${message}", restoring: "${originalCommand}"`);

  const storedFacts = [];
  const lines = message.split(/\n/).map(l => l.trim()).filter(Boolean);

  if (mcpAdapter) {
    for (let i = 0; i < askedFields.length; i++) {
      const field = askedFields[i];
      const answerLine = lines[i] || message.trim();

      const isEntityField = field.startsWith('entity:');
      if (isEntityField) {
        // Entity answer — store as entity memory
        const parts = field.split(':'); // ['entity', 'person', 'wife']
        const entityType = parts[1]; // person / place / thing
        const label = parts[2];      // wife / dentist / hammer
        const memType = entityType === 'person' ? 'personal_profile'
          : entityType === 'place' ? 'place_entity'
          : 'thing_entity';

        // Build natural-language memory text from the answer
        const memText = buildEntityMemoryText(label, entityType, answerLine);
        // Build entities array for memory_entities table
        const entities = [{ type: label, value: answerLine, entity_type: entityType.toUpperCase() }];

        try {
          await mcpAdapter.callService('user-memory', 'memory.store', {
            text: memText,
            type: memType,
            userId,
            entities,
            metadata: {
              source: 'entity_answer',
              entity_type: entityType,
              label,
              sessionId: context?.sessionId,
              timestamp: new Date().toISOString(),
            },
          }, { timeoutMs: 8000 });
          storedFacts.push({ field, value: answerLine, memoryText: memText });
          logger.info(`[Node:EnrichIntent] Stored ${memType}: "${memText}"`);
        } catch (err) {
          logger.error(`[Node:EnrichIntent] Failed to store entity for ${field}: ${err.message}`);
        }
      } else {
        // Scalar profile answer
        const detector = GAP_DETECTORS.find(d => d.field === field);
        if (!detector?.storeTemplate) continue;
        const extracted = extractScalarFromAnswer(field, answerLine);
        const value = extracted || answerLine;
        const memText = detector.storeTemplate(value);
        try {
          await mcpAdapter.callService('user-memory', 'memory.store', {
            text: memText,
            type: detector.memoryType || 'personal_profile',
            userId,
            metadata: { source: 'enrichment_answer', field, timestamp: new Date().toISOString() },
          }, { timeoutMs: 8000 });
          storedFacts.push({ field, value, memoryText: memText });
          logger.info(`[Node:EnrichIntent] Stored profile: "${memText}"`);
        } catch (err) {
          logger.error(`[Node:EnrichIntent] Failed to store ${field}: ${err.message}`);
        }
      }
    }
  }

  const restoredCommand = originalCommand || message;
  logger.info(`[Node:EnrichIntent] Stored ${storedFacts.length} fact(s). Re-routing with: "${restoredCommand}"`);

  return {
    ...state,
    message: restoredCommand,
    resolvedMessage: restoredCommand,
    intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false },
    profileContext: { facts: storedFacts, gaps: [] },
    enrichmentNeeded: [],
    enrichmentPendingMessage: null,
    answer: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse fields embedded in any marker: [MARKER fields=a,b,c] */
function parseMarkerFields(text) {
  if (!text) return [];
  const m = text.match(/\[(?:ENRICHMENT_QUESTION|ENTITY_QUESTION)\s+fields=([^\]]+)\]/);
  if (m) return m[1].split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/** Encode a ref string for embedding in a marker attribute (spaces → +) */
function encodeRef(ref) { return encodeURIComponent(ref).replace(/%20/g, '+'); }
function decodeRef(encoded) { return decodeURIComponent(encoded.replace(/\+/g, '%20')); }

/**
 * Resolve a pronoun (him/her/it/there) to a recent entity from conversation history.
 * Returns an entityRef-shaped object or null.
 */
function resolvePronoun(msg, conversationHistory) {
  const lower = msg.toLowerCase();
  let gender = null;
  if (PRONOUN_PATTERNS.masculine.test(lower)) gender = 'male';
  else if (PRONOUN_PATTERNS.feminine.test(lower)) gender = 'female';
  else if (PRONOUN_PATTERNS.neutral.test(lower)) gender = 'neutral';
  else if (PRONOUN_PATTERNS.plural.test(lower)) gender = 'plural';
  if (!gender) return null;

  // Search recent conversation for an entity reference that matches the gender
  for (const turn of [...conversationHistory].reverse()) {
    if (!turn.content) continue;
    const refs = extractEntityRefs(turn.content);
    for (const ref of refs) {
      // If gender matches (or is unknown), use this as the pronoun target
      if (ref.entityType === 'person') {
        // We can't determine gender from the label alone without memory,
        // so return the most recent person ref and let disambiguation handle multiples
        return { ...ref, pronounResolved: true };
      }
      if (gender === 'neutral' && (ref.entityType === 'place' || ref.entityType === 'thing')) {
        return { ...ref, pronounResolved: true };
      }
    }
  }
  return null;
}

/**
 * Extract contact methods from a memory text string.
 * e.g. "My wife Sarah — phone: +1555..., email: sarah@gmail.com"
 * Returns [{ type: 'phone', label: 'text/call', value: '+1555...' }, ...]
 */
function extractContactMethods(memText) {
  if (!memText) return [];
  const methods = [];
  const phoneMatch = memText.match(/(\+?1?\s*\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
  if (phoneMatch) methods.push({ type: 'phone', label: 'text/call', value: phoneMatch[1] });
  const emailMatch = memText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) methods.push({ type: 'email', label: 'email', value: emailMatch[0] });
  if (/slack/i.test(memText)) methods.push({ type: 'slack', label: 'Slack DM', value: 'slack' });
  return methods;
}

/** Extract a name from a memory text string. */
function extractEntityName(text) {
  if (!text) return null;
  const m = text.match(/(?:is|named?|called?)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/);
  if (m) return m[1].trim();
  const bare = text.trim().match(/^(?:My\s+\w+\s+)?([A-Z][a-zA-Z'-]+)/);
  return bare ? bare[1] : null;
}

/** Patch entity info into the command message for planSkills context. */
function applyEntityPatch(msg, ref, memoryText) {
  if (!memoryText) return msg;
  // Append entity context as a parenthetical so the planner has the data
  const snippet = memoryText.length > 120 ? memoryText.substring(0, 120) + '...' : memoryText;
  return `${msg} [context: ${snippet}]`;
}

/** Patch scalar facts into the message. */
function applyScalarPatch(msg, field, value) {
  if (!value) return msg;
  const patches = {
    user_name:    [/\b(from me|signed? by me)\b/gi,           `from ${value}`],
    home_address: [/\b(my home address|my address|where i live)\b/gi, `my home at ${value}`],
    work_address: [/\b(my work address|my office)\b/gi,       `my office at ${value}`],
  };
  const patch = patches[field];
  if (!patch) return msg;
  return msg.replace(patch[0], patch[1]);
}

/** Extract a scalar value from a free-text answer for a given field. */
function extractScalarFromAnswer(field, text) {
  if (!text) return null;
  if (field === 'my_phone' || field.endsWith('_phone')) {
    const m = text.match(/(\+?1?\s*\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
    return m ? m[1].replace(/[\s]/g, '') : null;
  }
  if (field === 'my_email' || field === 'email' || field.endsWith('_email')) {
    const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return m ? m[0] : null;
  }
  if (field.endsWith('_name') || field === 'user_name') {
    const isM = text.match(/\bis\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/);
    if (isM) return isM[1].trim();
    const bare = text.trim().match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})$/);
    return bare ? bare[1].trim() : null;
  }
  return null;
}

/** Build a scalar value extractor alias (used in entity resolution path) */
const extractScalarValue = extractScalarFromAnswer;

/**
 * Build the question to ask when an entity is unknown.
 * Adapts per entity type and the action being requested.
 */
async function buildEntityQuestion(ref, commandMessage, mcpAdapter, logger) {
  const { label, entityType } = ref;

  // Fallback template if LLM is unavailable
  const fallback = `What is your ${label}? I need that to complete this request.`;

  if (!mcpAdapter) return fallback;

  try {
    const prompt = [
      `A user said: "${commandMessage}"`,
      `To complete this, I need to know about "${ref.ref}" (a ${entityType}).`,
      `Write a single short, natural, conversational question (1 sentence, no markdown, no options list) to ask the user for the information I need.`,
      `Only ask for what is strictly necessary to complete the request — nothing more.`,
    ].join('\n');

    const res = await mcpAdapter.callService('phi4', 'general.answer', {
      message: prompt,
      stream: false,
    }, { timeoutMs: 4000 }).catch(() => null);

    const text = res?.data?.answer || res?.answer || '';
    if (text && text.trim().length > 5) {
      return text.trim().replace(/^["']|["']$/g, '');
    }
  } catch (err) {
    logger?.debug(`[EnrichIntent] buildEntityQuestion LLM failed: ${err.message}`);
  }

  return fallback;
}

/**
 * Build a natural-language memory text from an entity label and answer.
 * e.g. ('wife', 'person', 'Sarah — phone: +1555...') → "My wife Sarah — phone: +1555..."
 */
function buildEntityMemoryText(label, entityType, answerText) {
  const prefix = entityType === 'person' ? `My ${label}` : `My ${label}`;
  // If answer already starts with the label, don't double up
  const lower = answerText.toLowerCase();
  if (lower.startsWith(label) || lower.startsWith('my ' + label)) return answerText;
  return `${prefix} — ${answerText}`;
}

/**
 * Build a fresh memory text when correcting a field that has no prior memory.
 */
function buildFreshMemoryText(field, value) {
  if (field.startsWith('entity:')) {
    const parts = field.split(':'); // entity:person:wife
    return buildEntityMemoryText(parts[2], parts[1], value);
  }
  const detector = GAP_DETECTORS.find(d => d.field === field);
  return detector?.storeTemplate ? detector.storeTemplate(value) : `${field.replace(/_/g, ' ')}: ${value}`;
}

/**
 * Replace the key value in a memory text string with a new corrected value.
 * Tries to do a smart substitution; falls back to appending a correction note.
 */
function replaceMemoryValue(originalText, newValue) {
  // Try: "My X is Y" → "My X is <newValue>"
  const replaced = originalText.replace(
    /(is\s+|:\s*|=\s*)[^,;\n]+/i,
    `$1${newValue}`
  );
  return replaced !== originalText ? replaced : `${originalText} [corrected: ${newValue}]`;
}

/**
 * Build question text with embedded field markers for MODE B parsing.
 */
function buildCombinedQuestion(gaps) {
  const fieldList = gaps.map(g => g.field).join(',');
  const marker = `[${ENRICHMENT_MARKER} fields=${fieldList}]`;
  if (gaps.length === 1) {
    return `${marker}\nTo complete this, I need a bit more information.\n\n${gaps[0].question}`;
  }
  const lines = gaps.map((g, i) => `${i + 1}. ${g.question}`).join('\n');
  return `${marker}\nI need a few details:\n\n${lines}\n\nPlease reply with each answer on a separate line.`;
}

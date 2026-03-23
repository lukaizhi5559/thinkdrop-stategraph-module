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

/**
 * Extract domain tags from a user message via the phi4-service /domain.extract endpoint.
 * Uses zero-shot NLI classification (@xenova/transformers) + compromise NLP fallback.
 * Returns { tags: string[], services: string[], skillHints: string[] } or null on failure.
 *
 * @param {string} message
 * @param {object} mcpAdapter  — state.mcpAdapter, used to call phi4.domain.extract
 * @param {object} logger
 */
async function extractDomainTags(message, mcpAdapter, logger) {
  try {
    const response = await mcpAdapter.callService('phi4', 'domain.extract', { message });
    const data = response?.data || response;
    if (data && data.tags && data.tags.length > 0) {
      return {
        tags: data.tags,
        services: data.services || [],
        skillHints: data.skillHints || [],
      };
    }
  } catch (err) {
    logger.warn(`[Node:EnrichIntent] domain.extract MCP call failed: ${err.message}`);
  }
  return null;
}

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
    pattern: /\b(my phone number|my number|my cell|text me|sms me|send me a (text|sms|message))\b/i,
    searchQuery: 'my phone number',
    question: 'What is your phone number?',
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
    // Only fire if no skill name (dot-notation) or path is already present in the message.
    // Also skip if the message contains creation verbs (need/want/create/make/build) —
    // those mean "build a new skill via bootstrap", not "install existing skill from path".
    pattern: /^(?!.*\b(need|want|create|make|build)\b)(?!.*\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\b)(?!.*(?:\/|~\/|\.thinkdrop)).*\b(install|add|register|load)\s+(a\s+)?(skill|external skill|custom skill)\b/i,
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

// ── Language detection (same heuristics as answer.js) ────────────────────────
function _detectEnrichLang(text) {
  if (!text || text.length < 2) return null;
  const cjk = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g) || []).length;
  const hiragana = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  const hangul = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
  const total = text.replace(/\s/g, '').length || 1;
  if (cjk / total > 0.15) return hiragana > cjk * 0.3 ? 'ja' : 'zh';
  if (hangul / total > 0.15) return 'ko';
  if (arabic / total > 0.15) return 'ar';
  if (cyrillic / total > 0.15) return 'ru';
  if (devanagari / total > 0.15) return 'hi';
  // Latin-script heuristics — order matters: most-distinctive chars first
  if (/[¿¡áéíóúüñ]/i.test(text)) return 'es';         // Spanish-unique: ¿¡ñ
  if (/[àâçèéêëîïôùûüæœ]/i.test(text)) return 'fr';   // French-unique: œæç
  if (/[àèìòùâêîôûã]/i.test(text)) return 'pt';        // Portuguese: ã nasal
  if (/[äöüß]/i.test(text)) return 'de';                // German: äöüß
  if (/[àèìòùé]/i.test(text)) return 'it';              // Italian (lowest priority)
  return null;
}

const _ENRICH_LANG_NAMES = { zh: 'Chinese (Mandarin)', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', hi: 'Hindi', it: 'Italian' };

module.exports = async function enrichIntent(state) {
  const { mcpAdapter, message, resolvedMessage, intent, context, conversationHistory = [] } = state;
  const llmBackend = state.llmBackend || null;
  const logger = state.logger || console;

  const userId = context?.userId || 'local_user';
  const userMessage = (resolvedMessage || message || '').trim();

  // Detect user language so clarification questions are asked in their language
  // Mirrors answer.js: voice → journal sessionLanguage, text → script heuristics
  const _rawMsg = state.originalMessage || message || '';
  const _isVoiceEnrich = context?.source === 'voice';
  let _userLang = null;
  if (_isVoiceEnrich) {
    try {
      const _os = require('os');
      const _path = require('path');
      const _fs = require('fs');
      const _jPath = _path.join(_os.homedir(), '.thinkdrop', 'voice-state.json');
      const _jState = JSON.parse(_fs.readFileSync(_jPath, 'utf8'));
      const _sl = _jState?.voice?.sessionLanguage;
      if (_sl && _sl !== 'en') _userLang = _sl;
    } catch (_) {}
  }
  if (!_userLang) _userLang = _detectEnrichLang(_rawMsg) || null;
  const _langName = _userLang ? (_ENRICH_LANG_NAMES[_userLang] || _userLang) : null;
  const _langInstruction = _langName ? `\n\nIMPORTANT: Ask this question in ${_langName} only. Do NOT use English.` : '';

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
      question: await buildEntityQuestion(ref, commandMessage, llmBackend, logger, _langInstruction),
    })));

    const fieldList = entityGaps.map(g => g.field).join(',');
    const marker = `[${ENTITY_QUESTION_MARKER} fields=${fieldList}]`;
    const questionText = entityGaps.length === 1
      ? `${marker}\n${entityGaps[0].question}`
      : `${marker}\n${entityGaps.map((g, i) => `${i + 1}. ${g.question}`).join('\n')}`;

    logger.info(`[Node:EnrichIntent] Unknown entities — asking user: ${unresolvedEntities.map(r => r.ref).join(', ')}`);
    return {
      ...state,
      enrichmentNeeded: entityGaps,
      answer: questionText,
      enrichmentPendingMessage: commandMessage,
    };
  }

  // ─── STEP 3b: Domain keyword extraction ─────────────────────────────────
  // Run domain.extract only when there is a genuine outbound-delivery ambiguity:
  // "text this to me" → which SMS provider? (twilio vs clicksend vs sinch)
  //
  // The service picker UI should ONLY appear for known outbound messaging/notification
  // providers. phi4 regularly hallucinates unrelated services (discord, postgres,
  // homekit, salesforce) for tasks unrelated to service selection.
  //
  // SEED set — well-known providers. Extended at runtime by:
  //   (a) services the user has previously chosen (from phrase_preference table)
  //   (b) services the user mentions EXPLICITLY by name in this message
  // This means ThinkDrop can learn any new provider the user teaches it.
  const MESSAGING_PROVIDERS_SEED = new Set([
    'twilio', 'clicksend', 'sinch', 'vonage', 'messagebird', 'plivo',
    'sendgrid', 'mailgun', 'ses', 'postmark', 'sparkpost', 'mailchimp',
    'pushover', 'pushbullet', 'onesignal', 'firebase', 'apns',
    'slack', 'discord', 'telegram', 'whatsapp',
    'zapier', 'make', 'n8n', 'ifttt',
  ]);

  // Extend with any services the user has previously taught us via phrase_preference
  let MESSAGING_PROVIDERS = new Set(MESSAGING_PROVIDERS_SEED);
  try {
    const learnedList = await mcpAdapter.callService('user-memory', 'phrase_preference.list', {});
    const learnedResults = learnedList?.results || learnedList?.data?.results || [];
    for (const pref of learnedResults) {
      if (pref.service) MESSAGING_PROVIDERS.add(pref.service.toLowerCase());
    }
    if (learnedResults.length > 0) {
      logger.debug(`[Node:EnrichIntent] Extended MESSAGING_PROVIDERS with ${learnedResults.length} learned service(s)`);
    }
  } catch (_e) {
    // Non-fatal — fall back to seed set only
  }

  // Run domain.extract, then validate the result is actually relevant to this message.
  // phi4 (3B local model) hallucinates messaging/API services for unrelated tasks like
  // browser navigation. Instead of hardcoding patterns to skip, we ask the LLM backend
  // (the capable model) to confirm whether the returned tags genuinely apply.
  // This is self-healing: no list to maintain, any false-positive gets discarded.
  let domainTags = state.matchedSkillName
    ? null
    : await extractDomainTags(commandMessage, mcpAdapter, logger);

  if (domainTags && domainTags.services?.length > 0 && llmBackend) {
    try {
      const _validationPrompt = `A task classification model returned these service tags for a user message. Answer YES if the tags genuinely apply (the task requires contacting or using these services), or NO if they are false positives (the task is unrelated — e.g. browser navigation, file operation, search).

User message: "${commandMessage}"
Returned tags: ${domainTags.tags.join(', ')}
Returned services: ${domainTags.services.join(', ')}

Answer with exactly one word: YES or NO.`;
      const _validationAnswer = await llmBackend.generateAnswer(_validationPrompt, {
        query: _validationPrompt,
        context: { systemInstructions: 'You are a classification validator. Answer only YES or NO.', conversationHistory: [], intent: 'validate_tags' },
        options: { maxTokens: 5, temperature: 0.0, fastMode: true }
      }, { maxTokens: 5, temperature: 0.0, fastMode: true }, null).catch(() => 'YES');
      if (_validationAnswer && _validationAnswer.trim().toUpperCase().startsWith('NO')) {
        logger.info(`[Node:EnrichIntent] domain.extract tags discarded (LLM validation: false positive) — tags: [${domainTags.tags.join(', ')}]`);
        domainTags = null;
      }
    } catch (_ve) {
      // Non-fatal — keep domainTags as-is if validation fails
    }
  }

  // ── Local recurring reminder guard ────────────────────────────────────────
  // "Schedule my cold plunge every morning at 6am" requires a macOS launchd
  // alarm — there is NO external messaging/notification API involved.
  // phi4 frequently hallucinates "discord", "telegram", "slack" etc. as domain
  // services for recurring local-reminder requests. If the message clearly
  // describes a recurring local reminder AND does NOT explicitly name an
  // external delivery channel, discard domainTags entirely so planSkills
  // receives a clean slate and can use the launchd/node-cron pattern.
  const _LOCAL_RECURRING_RE = /\b(every\s+(morning|day|night|evening|week|month|hour|\d)|daily|weekly|monthly|each\s+(morning|day|night|evening|week)|remind\s+me\s+(daily|every)|recurring|repeat(ing)?|on\s+a\s+(daily|weekly|\w+)\s+schedule|alarm)\b/i;
  const _EXPLICIT_EXTERNAL_SVC_RE = /\b(discord|telegram|slack|twilio|clicksend|sendgrid|mailgun|pushover|pushbullet|onesignal|whatsapp|sms\s+me|text\s+me)\b/i;
  if (_LOCAL_RECURRING_RE.test(commandMessage) && !_EXPLICIT_EXTERNAL_SVC_RE.test(commandMessage)) {
    logger.info(`[Node:EnrichIntent] Local recurring reminder guard — clearing domain tags for: "${commandMessage.substring(0, 60)}"`);
    domainTags = null;
  }

  // Filter phi4 results to real messaging providers (seed + learned)
  // ALSO: if the user explicitly named a service in the message, include it
  // even if phi4 didn't return it — this covers unknown providers the user mentions.
  const _phi4Services = domainTags
    ? domainTags.services.filter(s => MESSAGING_PROVIDERS.has(s.toLowerCase()))
    : [];

  // Extract any service explicitly named in the message (e.g. "via Pushbullet", "using Gotify")
  // This allows ThinkDrop to work with ANY provider the user mentions by name,
  // not just the ones phi4 knows about.
  const _explicitMention = commandMessage.match(
    /\b(?:via|using|with|through|on|by)\s+([A-Za-z][A-Za-z0-9._-]{2,30})\b/i
  );
  const _explicitService = _explicitMention ? _explicitMention[1].toLowerCase() : null;
  // Only add explicit service if it looks like a delivery channel:
  // - not a common English word
  // - phi4 also returned at least one real messaging service (guards against
  //   "on sale", "on Yahoo", "by me" being treated as provider names when
  //   the message has no messaging intent at all)
  const _COMMON_WORDS = new Set(['email', 'text', 'message', 'phone', 'web', 'browser', 'app', 'the', 'my', 'your', 'me', 'sale', 'it']);
  const _explicitValid = _explicitService
    && !_COMMON_WORDS.has(_explicitService)
    && _phi4Services.length > 0; // only valid when phi4 already confirmed messaging intent
  const _messagingServices = [...new Set([
    ..._phi4Services,
    ...(_explicitValid ? [_explicitService] : []),
  ])];

  if (domainTags) {
    logger.info(`[Node:EnrichIntent] Domain tags: [${domainTags.tags.join(', ')}] → phi4 services: [${_phi4Services.join(', ')}] → explicit: [${_explicitService || 'none'}] → final: [${_messagingServices.join(', ')}]`);
  }

  // ─── STEP 3c: Service choice — learning loop ─────────────────────────────
  // 1. If user already chose a service this session, reuse it.
  // 2. Check phrase_preference memory — did the user EVER tell us which service
  //    they prefer for phrasing like this? (semantic similarity match)
  //    If yes → auto-select silently, never ask again.
  // 3. If 1 real messaging provider → auto-select.
  // 4. If 2+ real messaging providers AND no learned preference → ask the user,
  //    then STORE their answer so we never ask again for similar phrases.
  // 5. If 0 real messaging providers → skip service selection entirely.
  let chosenService = state.chosenService || null;
  const progressCallback = state.progressCallback || null;
  const gatherAnswerCallback = state.gatherAnswerCallback || null;

  const SERVICE_DISPLAY_NAMES = {
    twilio: 'Twilio', clicksend: 'ClickSend', sinch: 'Sinch', vonage: 'Vonage',
    mailgun: 'Mailgun', sendgrid: 'SendGrid', pushover: 'Pushover', slack: 'Slack',
    discord: 'Discord', telegram: 'Telegram', zapier: 'Zapier', onesignal: 'OneSignal',
    messagebird: 'MessageBird', plivo: 'Plivo', make: 'Make', n8n: 'n8n', ifttt: 'IFTTT',
  };

  if (!chosenService && _messagingServices.length > 0) {
    // Step 1: Check learned phrase preferences before asking anything
    let learnedPref = null;
    try {
      const prefResult = await mcpAdapter.callService('user-memory', 'phrase_preference.search', {
        phrase: commandMessage,
      });
      learnedPref = prefResult?.match || null;
    } catch (_e) {
      logger.debug('[Node:EnrichIntent] phrase_preference.search unavailable (non-fatal)');
    }

    if (learnedPref?.service) {
      chosenService = learnedPref.service;
      logger.info(`[Node:EnrichIntent] Learned preference hit — auto-selected: "${chosenService}" (sim=${learnedPref.similarity?.toFixed(3)})`);
    } else if (_messagingServices.length === 1) {
      // Single provider — auto-select, no question needed
      chosenService = _messagingServices[0];
      logger.info(`[Node:EnrichIntent] Single messaging provider auto-selected: "${chosenService}"`);
    } else if (_messagingServices.length > 1 && gatherAnswerCallback) {
      // Multiple providers — ask once, then remember forever
      const serviceOptions = _messagingServices.map(s =>
        SERVICE_DISPLAY_NAMES[s.toLowerCase()] || (s.charAt(0).toUpperCase() + s.slice(1))
      );

      logger.info(`[Node:EnrichIntent] Multiple messaging providers, no learned preference — asking: ${serviceOptions.join(', ')}`);

      if (progressCallback) {
        progressCallback({
          type: 'gather_question',
          id: 'service_choice',
          question: `How would you like me to reach you for this?`,
          hint: `I found ${serviceOptions.length} options. Pick one and I'll remember it for next time.`,
          inputType: 'choice',
          options: serviceOptions,
          links: [],
        });
      }

      let answer = await gatherAnswerCallback();

      // ── "I don't know" path ─────────────────────────────────────────────────────
      // If user says they don't know, query api_rules in the DB for services
      // that have known endpoints matching the task domain. The DB is the
      // authoritative service catalog — no LLM call needed here.
      // phi4/Ollama is a 3B local model and cannot reliably suggest services.
      const _dontKnowPhrases = /\b(don'?t know|not sure|no idea|unsure|idk|help|suggest|recommend|what.?s best|you choose|you pick)\b/i;
      if (answer && _dontKnowPhrases.test(answer)) {
        logger.info('[Node:EnrichIntent] User unsure — querying api_rules DB for service suggestions');

        let suggestedServices = [];
        try {
          // Fetch all services that have endpoint rules (i.e. known, actionable APIs)
          const rulesRes = await mcpAdapter.callService('user-memory', 'api_rule.list', {
            ruleType: 'endpoint',
            limit: 50,
          });
          const allEndpointServices = (rulesRes?.results || rulesRes?.data?.results || [])
            .map(r => r.service)
            .filter((s, i, a) => s && a.indexOf(s) === i); // unique

          // Score by overlap with domain tags from this message
          const domainTagsLower = (domainTags?.tags || []).map(t => t.toLowerCase());
          const domainTagsSet = new Set(domainTagsLower);

          // Prefer services whose name or rules relate to the current domain tags
          // (e.g. tags=[sms,notify] → twilio, clicksend rank high)
          const scored = allEndpointServices.map(s => {
            const sl = s.toLowerCase();
            const inTags = domainTagsSet.has(sl) ? 3 : 0;
            const tagOverlap = domainTagsLower.filter(t => sl.includes(t) || t.includes(sl)).length;
            return { s, score: inTags + tagOverlap };
          });
          scored.sort((a, b) => b.score - a.score);

          // Return top 5 — if none scored, just return first 5 alphabetically
          suggestedServices = scored.slice(0, 5).map(x => x.s);
          if (suggestedServices.length === 0) suggestedServices = allEndpointServices.slice(0, 5);
        } catch (_e) {
          logger.debug('[Node:EnrichIntent] api_rule.list failed (non-fatal)');
        }

        // Fallback: if DB has no endpoint rules yet, fall back to MESSAGING_PROVIDERS seed
        if (suggestedServices.length === 0) {
          suggestedServices = [...MESSAGING_PROVIDERS].slice(0, 5);
        }

        if (suggestedServices.length > 0) {
          const suggestOptions = suggestedServices.map(s =>
            SERVICE_DISPLAY_NAMES[s] || (s.charAt(0).toUpperCase() + s.slice(1))
          );

          logger.info(`[Node:EnrichIntent] DB suggested services: ${suggestOptions.join(', ')}`);

          if (progressCallback) {
            progressCallback({
              type: 'gather_question',
              id: 'service_choice_suggested',
              question: `Here are some options that could handle this. Which would you prefer?`,
              hint: `These are services I know how to integrate. Pick one and I'll set it up automatically.`,
              inputType: 'choice',
              options: suggestOptions,
              links: [],
            });
          }
          answer = await gatherAnswerCallback();
          // Merge suggested services into the candidate pool for resolution below
          for (const s of suggestedServices) {
            if (!_messagingServices.includes(s)) _messagingServices.push(s);
          }
        }
      }
      // ── End "I don't know" path ─────────────────────────────────────────────

      if (answer) {
        const picked = answer.trim().toLowerCase();
        chosenService = _messagingServices.find(s =>
          s.toLowerCase() === picked ||
          s.toLowerCase() === picked.replace(/\s+/g, '') ||
          picked.includes(s.toLowerCase())
        ) || picked; // if still no match, trust the user's literal answer as the service name
        logger.info(`[Node:EnrichIntent] User chose: "${answer}" → resolved: "${chosenService}"`);

        // Store the learned preference — next time this phrase won't ask again.
        // Delivery defaults to 'webhook' for unknown services — planSkills crawls
        // the docs to figure out the actual integration pattern. No category
        // hardcoding — services can be anything (SMS, IoT, car, desktop, etc.)
        let _deliveryForStore = 'webhook';
        try {
          const _existingPref = await mcpAdapter.callService('user-memory', 'phrase_preference.list', { service: chosenService });
          const _existingResults = _existingPref?.results || _existingPref?.data?.results || [];
          if (_existingResults.length > 0 && _existingResults[0].delivery) {
            _deliveryForStore = _existingResults[0].delivery;
          }
        } catch (_e) { /* non-fatal */ }
        try {
          await mcpAdapter.callService('user-memory', 'phrase_preference.upsert', {
            examplePhrase: commandMessage,
            delivery: _deliveryForStore,
            service: chosenService,
            source: 'user_answer',
          });
          logger.info(`[Node:EnrichIntent] Stored phrase preference: "${commandMessage.slice(0, 60)}" → ${chosenService} (${_deliveryForStore})`);
        } catch (_e) {
          logger.debug('[Node:EnrichIntent] phrase_preference.upsert unavailable (non-fatal)');
        }
      } else {
        // Timeout/no answer — default to first option
        chosenService = _messagingServices[0];
        logger.info(`[Node:EnrichIntent] Service choice timed out — defaulting to: "${chosenService}"`);
      }
    }
  }

  // ─── STEP 4: Scalar profile gap detection ────────────────────────────────
  // Covers: user's own name, phone, email, address, skill ops
  // SKIP when message was auto-translated: translation artifacts (e.g. "near my house"
  // from "在我家很近") falsely fire address/phone/name detectors.
  const _wasTranslated = state.originalMessage && state.originalMessage !== commandMessage;
  const triggered = _wasTranslated ? [] : GAP_DETECTORS.filter(d => d.pattern.test(commandMessage));
  if (triggered.length === 0 && entityRefs.length === 0) {
    logger.debug('[Node:EnrichIntent] No gaps detected — passthrough');
    return { ...state, domainTags: domainTags || state.domainTags, chosenService: chosenService || state.chosenService };
  }

  const resolvedFacts = [];
  const unresolvedGaps = [];

  await Promise.all(triggered.map(async (detector) => {
    if (!detector.storeTemplate) {
      const q = await translateQuestion(detector.question, _langInstruction, llmBackend, logger);
      unresolvedGaps.push({ field: detector.field, question: q });
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
        const q = await translateQuestion(detector.question, _langInstruction, llmBackend, logger);
        unresolvedGaps.push({ field: detector.field, question: q });
      }
    } catch (err) {
      logger.warn(`[Node:EnrichIntent] Gap lookup failed for ${detector.field}: ${err.message}`);
      const q = await translateQuestion(detector.question, _langInstruction, llmBackend, logger);
      unresolvedGaps.push({ field: detector.field, question: q });
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
    const questionText = buildCombinedQuestion(deduped, _langInstruction);
    return {
      ...state,
      resolvedMessage: enrichedMessage !== commandMessage ? enrichedMessage : (resolvedMessage || message),
      profileContext,
      domainTags: domainTags || state.domainTags,
      chosenService: chosenService || state.chosenService,
      enrichmentNeeded: deduped,
      answer: questionText,
      enrichmentPendingMessage: commandMessage,
    };
  }

  return {
    ...state,
    resolvedMessage: enrichedMessage !== commandMessage ? enrichedMessage : (resolvedMessage || message),
    profileContext,
    domainTags: domainTags || state.domainTags,
    chosenService: chosenService || state.chosenService,
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
 * Translate a hardcoded English question into the user's language via phi4.
 * Falls back to the original English if LLM is unavailable or langInstruction is empty.
 */
async function translateQuestion(englishQuestion, langInstruction, llmBackend, logger) {
  if (!langInstruction || !llmBackend) return englishQuestion;
  try {
    const prompt = `Translate this question into the target language specified below. Output only the translated question, nothing else.\n\nQuestion: "${englishQuestion}"${langInstruction}`;
    const text = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: {},
      options: { maxTokens: 200, temperature: 0.1 },
    }, { maxTokens: 200, temperature: 0.1 }, null).catch(() => '');
    if (text && text.trim().length > 3) return text.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    logger?.debug(`[EnrichIntent] translateQuestion failed: ${err.message}`);
  }
  return englishQuestion;
}

/**
 * Build the question to ask when an entity is unknown.
 * Adapts per entity type and the action being requested.
 */
async function buildEntityQuestion(ref, commandMessage, llmBackend, logger, langInstruction = '') {
  const { label, entityType } = ref;

  // Fallback template if LLM is unavailable
  const fallback = `What is your ${label}? I need that to complete this request.`;

  if (!llmBackend) return fallback;

  try {
    const prompt = [
      `A user said: "${commandMessage}"`,
      `To complete this, I need to know about "${ref.ref}" (a ${entityType}).`,
      `Write a single short, natural, conversational question (1 sentence, no markdown, no options list) to ask the user for the information I need.`,
      `Only ask for what is strictly necessary to complete the request — nothing more.`,
      langInstruction,
    ].filter(Boolean).join('\n');

    const text = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: {},
      options: { maxTokens: 200, temperature: 0.3 },
    }, { maxTokens: 200, temperature: 0.3 }, null).catch(() => '');

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
function buildCombinedQuestion(gaps, langInstruction = '') {
  const fieldList = gaps.map(g => g.field).join(',');
  const marker = `[${ENRICHMENT_MARKER} fields=${fieldList}]`;
  if (gaps.length === 1) {
    return `${marker}\n${gaps[0].question}`;
  }
  const lines = gaps.map((g, i) => `${i + 1}. ${g.question}`).join('\n');
  return `${marker}\n${lines}`;
}

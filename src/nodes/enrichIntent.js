/**
 * Enrich Intent Node
 *
 * Runs for ALL intents but only acts on command_automate or when processing
 * answers to a previous enrichment question.
 *
 * Two modes:
 *
 * MODE A — ENRICH: Incoming message is a command_automate request.
 *   1. Detect profile gaps (who is "my wife", what is her phone number, etc.)
 *   2. Search memory (type=personal_profile) to resolve them.
 *   3. Patch resolvedMessage + inject profileContext into state for planSkills.
 *   4. If gaps remain → ask_user (sets state.answer with combined question,
 *      sets state.enrichmentPendingMessage to preserve original command).
 *
 * MODE B — STORE ANSWER: Previous turn was an enrichment question and user replied.
 *   1. Detect that conversationHistory contains a recent enrichment question.
 *   2. Parse the user's answer into individual profile facts.
 *   3. Store each fact as memory type=personal_profile.
 *   4. Restore the original command (from enrichmentPendingMessage in history)
 *      and re-route to planSkills by setting intent=command_automate.
 *
 * State inputs:
 *   state.message / state.resolvedMessage  — the user's request
 *   state.intent                           — any
 *   state.mcpAdapter                       — to call memory.search / memory.store
 *   state.context                          — userId, sessionId
 *   state.conversationHistory              — to detect prior enrichment questions
 *
 * State outputs (MODE A - enriched):
 *   state.resolvedMessage   — patched message with real profile values
 *   state.profileContext    — { facts, gaps } injected into planSkills
 *   state.enrichmentNeeded  — [] (all resolved)
 *
 * State outputs (MODE A - gap):
 *   state.answer            — combined question for the user
 *   state.enrichmentNeeded  — Array<{ field, question }>
 *   state.enrichmentPendingMessage — original command to retry after answers
 *
 * State outputs (MODE B - answer stored):
 *   state.message / state.resolvedMessage — restored original command
 *   state.intent                          — { type: 'command_automate', ... }
 *   state.profileContext                  — newly stored facts
 *   state.enrichmentNeeded               — [] (cleared)
 */

// ── Gap detector table (shared between MODE A and MODE B) ────────────────────
const GAP_DETECTORS = [
  {
    field: 'user_name',
    pattern: /\b(from me|sign(ed)? (by|from)|my name|who am i)\b/i,
    searchQuery: 'my name is',
    question: 'What is your name?',
    storeTemplate: (v) => `My name is ${v}`,
  },
  {
    field: 'wife_name',
    pattern: /\b(my wife|wife'?s?\s*name)\b/i,
    searchQuery: "my wife's name",
    question: "What is your wife's name?",
    storeTemplate: (v) => `My wife's name is ${v}`,
  },
  {
    field: 'husband_name',
    pattern: /\b(my husband|husband'?s?\s*name)\b/i,
    searchQuery: "my husband's name",
    question: "What is your husband's name?",
    storeTemplate: (v) => `My husband's name is ${v}`,
  },
  {
    field: 'partner_name',
    pattern: /\b(my partner|partner'?s?\s*name)\b/i,
    searchQuery: "my partner's name",
    question: "What is your partner's name?",
    storeTemplate: (v) => `My partner's name is ${v}`,
  },
  {
    field: 'mom_name',
    pattern: /\b(my mom|my mother|mom'?s?\s*name|mother'?s?\s*name)\b/i,
    searchQuery: "my mom's name",
    question: "What is your mom's name?",
    storeTemplate: (v) => `My mom's name is ${v}`,
  },
  {
    field: 'dad_name',
    pattern: /\b(my dad|my father|dad'?s?\s*name|father'?s?\s*name)\b/i,
    searchQuery: "my dad's name",
    question: "What is your dad's name?",
    storeTemplate: (v) => `My dad's name is ${v}`,
  },
  {
    field: 'wife_phone',
    pattern: /\b(text|message|call|sms|imessage|send).{0,40}(my wife|wife)\b/i,
    searchQuery: "my wife's phone number",
    question: "What is your wife's phone number (including country code, e.g. +15551234567)?",
    storeTemplate: (v) => `My wife's phone number is ${v}`,
  },
  {
    field: 'husband_phone',
    pattern: /\b(text|message|call|sms|imessage|send).{0,40}(my husband|husband)\b/i,
    searchQuery: "my husband's phone number",
    question: "What is your husband's phone number (including country code, e.g. +15551234567)?",
    storeTemplate: (v) => `My husband's phone number is ${v}`,
  },
  {
    field: 'partner_phone',
    pattern: /\b(text|message|call|sms|imessage|send).{0,40}(my partner|partner)\b/i,
    searchQuery: "my partner's phone number",
    question: "What is your partner's phone number (including country code, e.g. +15551234567)?",
    storeTemplate: (v) => `My partner's phone number is ${v}`,
  },
  {
    field: 'mom_phone',
    pattern: /\b(text|message|call|sms|imessage|send).{0,40}(my mom|my mother|mom|mother)\b/i,
    searchQuery: "my mom's phone number",
    question: "What is your mom's phone number (including country code, e.g. +15551234567)?",
    storeTemplate: (v) => `My mom's phone number is ${v}`,
  },
  {
    field: 'dad_phone',
    pattern: /\b(text|message|call|sms|imessage|send).{0,40}(my dad|my father|dad|father)\b/i,
    searchQuery: "my dad's phone number",
    question: "What is your dad's phone number (including country code, e.g. +15551234567)?",
    storeTemplate: (v) => `My dad's phone number is ${v}`,
  },
  {
    field: 'my_phone',
    pattern: /\b(my phone number|my number|my cell)\b/i,
    searchQuery: 'my phone number',
    question: 'What is your phone number (including country code)?',
    storeTemplate: (v) => `My phone number is ${v}`,
  },
  {
    field: 'home_address',
    pattern: /\b(my home address|my address|my house|where i live)\b/i,
    searchQuery: 'my home address',
    question: 'What is your home address?',
    storeTemplate: (v) => `My home address is ${v}`,
  },
  {
    field: 'work_address',
    pattern: /\b(my work address|my office address|where i work|my workplace)\b/i,
    searchQuery: 'my work address',
    question: 'What is your work or office address?',
    storeTemplate: (v) => `My work address is ${v}`,
  },
  {
    field: 'email',
    pattern: /\b(my email|send (from|to) me|email me)\b/i,
    searchQuery: 'my email address',
    question: 'What is your email address?',
    storeTemplate: (v) => `My email address is ${v}`,
  },
];

// Marker prefix embedded in enrichment questions so MODE B can detect them reliably
const ENRICHMENT_MARKER = 'ENRICHMENT_QUESTION';

module.exports = async function enrichIntent(state) {
  const { mcpAdapter, message, resolvedMessage, intent, context, conversationHistory = [] } = state;
  const logger = state.logger || console;

  const userId = context?.userId || 'local_user';

  // ── MODE B: Detect if this is a user answer to a prior enrichment question ──
  // Look back through conversation history for the most recent assistant message
  // that contains the enrichment marker. If found, this message is the user's answer.
  const recentAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
  const isPendingAnswer = recentAssistant?.content?.includes(`[${ENRICHMENT_MARKER}`);

  if (isPendingAnswer) {
    logger.info('[Node:EnrichIntent] MODE B — detected answer to enrichment question, storing profile facts');
    return await handleEnrichmentAnswer(state, recentAssistant, userId, logger);
  }

  // ── MODE A: Enrich a command_automate request ─────────────────────────────
  if (intent?.type !== 'command_automate') {
    return state;
  }

  const userMessage = resolvedMessage || message || '';

  // Find which gap detectors fire on this message
  const triggered = GAP_DETECTORS.filter(d => d.pattern.test(userMessage));
  if (triggered.length === 0) {
    logger.debug('[Node:EnrichIntent] No profile gaps detected — passthrough');
    return state;
  }

  logger.info(`[Node:EnrichIntent] Detected ${triggered.length} profile gap(s): ${triggered.map(d => d.field).join(', ')}`);

  if (!mcpAdapter) {
    logger.warn('[Node:EnrichIntent] No mcpAdapter — skipping enrichment, continuing');
    return state;
  }

  // ── Memory lookup for each triggered gap ─────────────────────────────────
  const resolvedFacts = [];
  const unresolvedGaps = [];

  await Promise.all(triggered.map(async (detector) => {
    try {
      const searchRes = await mcpAdapter.callService('user-memory', 'memory.search', {
        query: detector.searchQuery,
        userId,
        limit: 3,
        minSimilarity: 0.60,
        filters: { type: 'personal_profile' },
      }, { timeoutMs: 5000 }).catch(() => null);

      const results = searchRes?.data?.results || searchRes?.results || [];
      const hit = results.find(r => r.similarity >= 0.60);

      if (hit) {
        const extracted = extractProfileValue(detector.field, hit.text);
        const value = extracted || hit.text.trim();
        resolvedFacts.push({ field: detector.field, value, rawText: hit.text, similarity: hit.similarity });
        logger.info(`[Node:EnrichIntent] Resolved ${detector.field}: "${value}" (sim: ${hit.similarity.toFixed(3)})`);
      } else {
        if (detector.question) {
          unresolvedGaps.push({ field: detector.field, question: detector.question });
        }
        logger.debug(`[Node:EnrichIntent] No profile memory for "${detector.field}"`);
      }
    } catch (err) {
      logger.warn(`[Node:EnrichIntent] Memory search failed for ${detector.field}: ${err.message}`);
      if (detector.question) {
        unresolvedGaps.push({ field: detector.field, question: detector.question });
      }
    }
  }));

  // ── Patch resolvedMessage with found name facts ───────────────────────────
  let enrichedMessage = userMessage;
  for (const fact of resolvedFacts) {
    enrichedMessage = applyProfilePatch(enrichedMessage, fact.field, fact.value);
  }

  const profileContext = { facts: resolvedFacts, gaps: unresolvedGaps };

  if (enrichedMessage !== userMessage) {
    logger.info(`[Node:EnrichIntent] Patched message: "${enrichedMessage}"`);
  }

  // ── Handle unresolved gaps → ASK_USER ────────────────────────────────────
  if (unresolvedGaps.length > 0) {
    const seen = new Set();
    const deduped = unresolvedGaps.filter(g => {
      if (seen.has(g.field)) return false;
      seen.add(g.field);
      return true;
    });

    logger.info(`[Node:EnrichIntent] ${deduped.length} gap(s) unresolved — asking user`);
    const questionText = buildCombinedQuestion(deduped);

    return {
      ...state,
      resolvedMessage: enrichedMessage !== userMessage ? enrichedMessage : (resolvedMessage || message),
      profileContext,
      enrichmentNeeded: deduped,
      answer: questionText,
      enrichmentPendingMessage: userMessage,
    };
  }

  // All gaps resolved
  return {
    ...state,
    resolvedMessage: enrichedMessage !== userMessage ? enrichedMessage : (resolvedMessage || message),
    profileContext,
    enrichmentNeeded: [],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// MODE B handler — store user's answers and restore the original command
// ─────────────────────────────────────────────────────────────────────────────

async function handleEnrichmentAnswer(state, assistantMsg, userId, logger) {
  const { mcpAdapter, message, context, conversationHistory = [] } = state;

  // Parse which fields were asked from the assistant message
  const askedFields = parseAskedFields(assistantMsg.content);

  // Find the original command: search backwards for the user message BEFORE the
  // enrichment question was asked. It will be the user message just before the
  // assistant enrichment message.
  const assistantIdx = [...conversationHistory].reverse().findIndex(m =>
    m.role === 'assistant' && m.content?.includes(`[${ENRICHMENT_MARKER}`)
  );
  const histReversed = [...conversationHistory].reverse();
  // The user message immediately before the assistant enrichment question
  let originalCommand = null;
  for (let i = assistantIdx + 1; i < histReversed.length; i++) {
    if (histReversed[i].role === 'user') {
      originalCommand = histReversed[i].content;
      break;
    }
  }

  logger.info(`[Node:EnrichIntent] Restoring original command: "${originalCommand}"`);
  logger.info(`[Node:EnrichIntent] User answer: "${message}"`);

  // ── Parse the user's answer into individual fact values ───────────────────
  // The user's message may be multi-line or contain all answers in one line.
  // Strategy: for each asked field, try to extract the value from the answer text.
  const storedFacts = [];

  if (mcpAdapter) {
    for (const field of askedFields) {
      const detector = GAP_DETECTORS.find(d => d.field === field);
      if (!detector) continue;

      const extracted = extractAnswerForField(field, message, askedFields);
      if (!extracted) {
        logger.warn(`[Node:EnrichIntent] Could not extract value for field "${field}" from answer`);
        continue;
      }

      const memoryText = detector.storeTemplate(extracted);
      try {
        await mcpAdapter.callService('user-memory', 'memory.store', {
          text: memoryText,
          type: 'personal_profile',
          userId,
          metadata: {
            source: 'enrichment_answer',
            field,
            sessionId: context?.sessionId,
            userId,
            timestamp: new Date().toISOString(),
          },
        }, { timeoutMs: 8000 });

        storedFacts.push({ field, value: extracted, memoryText });
        logger.info(`[Node:EnrichIntent] Stored personal_profile: "${memoryText}"`);
      } catch (err) {
        logger.error(`[Node:EnrichIntent] Failed to store profile fact for ${field}: ${err.message}`);
      }
    }
  }

  // ── Restore original command and re-route to planSkills ───────────────────
  const restoredCommand = originalCommand || message;

  logger.info(`[Node:EnrichIntent] Stored ${storedFacts.length} fact(s). Re-routing to planSkills with: "${restoredCommand}"`);

  return {
    ...state,
    message: restoredCommand,
    resolvedMessage: restoredCommand,
    intent: { type: 'command_automate', confidence: 0.99, entities: [], requiresMemoryAccess: false },
    profileContext: { facts: storedFacts, gaps: [] },
    enrichmentNeeded: [],
    enrichmentPendingMessage: null,
    // Clear answer so the graph routes through planSkills → executeCommand, not logConversation
    answer: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse which fields were embedded in the enrichment question text.
 * We embed field names as hidden hints in the question marker comment.
 */
function parseAskedFields(assistantText) {
  if (!assistantText) return [];
  // Format: [ENRICHMENT_QUESTION fields=wife_name,wife_phone]
  const m = assistantText.match(/\[ENRICHMENT_QUESTION\s+fields=([^\]]+)\]/);
  if (m) return m[1].split(',').map(s => s.trim()).filter(Boolean);
  // Fallback: match known field names mentioned in the question text
  return GAP_DETECTORS
    .filter(d => assistantText.toLowerCase().includes(d.field.replace(/_/g, ' ')))
    .map(d => d.field);
}

/**
 * Extract a specific field's value from the user's free-text answer.
 *
 * Handles:
 *   Single-field answers:   "Sarah"  or  "+15551234567"
 *   Multi-line answers:     "Sarah\n+15551234567"
 *   Labelled answers:       "Wife's name: Sarah\nPhone: +15551234567"
 *   Comma-separated:        "Sarah, +15551234567"
 *
 * For single-field ask, the whole answer (trimmed) is the value.
 * For multi-field, try to pick the right line/segment based on field type.
 */
function extractAnswerForField(field, answerText, allFields) {
  const text = answerText.trim();
  if (!text) return null;

  const lines = text.split(/\n|,/).map(l => l.trim()).filter(Boolean);

  // Single field asked → full answer is the value
  if (allFields.length === 1) {
    return extractProfileValue(field, text) || text;
  }

  // Multiple fields → try label matching first
  const fieldIndex = allFields.indexOf(field);

  // Try to find a line that explicitly labels this field
  for (const line of lines) {
    const lineLower = line.toLowerCase();
    if (field.endsWith('_phone') || field === 'my_phone') {
      if (/phone|number|cell|mobile|\+1|\+\d/.test(lineLower)) {
        const extracted = extractProfileValue(field, line);
        if (extracted) return extracted;
      }
    }
    if (field.endsWith('_name') || field === 'user_name') {
      if (/name|called|i'?m|i am/.test(lineLower)) {
        const extracted = extractProfileValue(field, line);
        if (extracted) return extracted;
      }
    }
    if (field === 'email') {
      const m = line.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (m) return m[0];
    }
  }

  // Positional fallback: answers often come in the same order as questions
  if (fieldIndex >= 0 && fieldIndex < lines.length) {
    const candidate = lines[fieldIndex];
    return extractProfileValue(field, candidate) || candidate;
  }

  // Last resort: scan all lines for a match
  for (const line of lines) {
    const extracted = extractProfileValue(field, line);
    if (extracted) return extracted;
  }

  return null;
}

/**
 * Extract a concrete value from a personal_profile memory text.
 */
function extractProfileValue(field, text) {
  if (!text) return null;

  if (field.endsWith('_phone') || field === 'my_phone') {
    const m = text.match(/(\+?1?\s*\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
    return m ? m[1].replace(/[\s]/g, '') : null;
  }

  if (field === 'email') {
    const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return m ? m[0] : null;
  }

  if (field.endsWith('_name') || field === 'user_name') {
    // "My wife's name is Sarah" → "Sarah"
    // Also handle bare names like "Sarah" or "Sarah Johnson"
    const isMatch = text.match(/\bis\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/);
    if (isMatch) return isMatch[1].trim();
    // Bare capitalised name (1-3 words, no punctuation)
    const bareMatch = text.trim().match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})$/);
    if (bareMatch) return bareMatch[1].trim();
    return null;
  }

  if (field.endsWith('_address')) {
    const m = text.match(/\b(?:is|at)\s+(.+?)(?:\.|$)/i);
    return m ? m[1].trim() : text.trim();
  }

  return null;
}

/**
 * Apply a resolved name fact inline to the message text.
 * Phone/email/address facts go into profileContext — planSkills reads them there.
 */
function applyProfilePatch(msg, field, value) {
  if (!value) return msg;
  const patches = {
    wife_name:    [/\bmy wife\b/gi,               `my wife ${value}`],
    husband_name: [/\bmy husband\b/gi,             `my husband ${value}`],
    partner_name: [/\bmy partner\b/gi,             `my partner ${value}`],
    mom_name:     [/\b(my mom|my mother)\b/gi,     `my mom ${value}`],
    dad_name:     [/\b(my dad|my father)\b/gi,     `my dad ${value}`],
    home_address: [/\b(my home address|my address|my house|where i live)\b/gi, `my home at ${value}`],
    work_address: [/\b(my work address|my office address|where i work)\b/gi,   `my office at ${value}`],
  };
  const patch = patches[field];
  if (!patch) return msg;
  return msg.replace(patch[0], patch[1]);
}

/**
 * Build the combined question text with embedded field hints for MODE B parsing.
 */
function buildCombinedQuestion(gaps) {
  const fieldList = gaps.map(g => g.field).join(',');
  const marker = `[${ENRICHMENT_MARKER} fields=${fieldList}]`;

  if (gaps.length === 1) {
    return `${marker}\nTo complete this task, I need a bit more information.\n\n${gaps[0].question}`;
  }

  const lines = gaps.map((g, i) => `${i + 1}. ${g.question}`).join('\n');
  return `${marker}\nTo complete this task, I need a few pieces of information:\n\n${lines}\n\nPlease reply with each answer on a separate line.`;
}

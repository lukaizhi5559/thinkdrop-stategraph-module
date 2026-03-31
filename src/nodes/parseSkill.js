/**
 * ParseSkill Node
 *
 * Runs AFTER resolveReferences, BEFORE parseIntent.
 *
 * Purpose: detect whether the user's (resolved) message directly invokes
 * an installed external skill by name, and short-circuit the intent pipeline.
 *
 * Two matching strategies:
 *
 * 1. EXACT NAME MATCH — tokenizes the message and checks if it starts with or
 *    contains a registered skill name from the installed_skills DB.
 *    e.g. "check.weather.daily New York" → matches "check.weather.daily"
 *
 * 2. NATURAL LANGUAGE MATCH — checks if the message contains the skill name
 *    as a phrase, handling dot → space variations and common prefixes.
 *    e.g. "run check weather daily for NYC" → matches "check.weather.daily"
 *
 * On match: sets state.matchedSkillName + intent=command_automate so planSkills
 * can inject the skill contract as RAG context.
 *
 * On no match: passes through unchanged so resolveReferences → parseIntent
 * handles classification as normal.
 *
 * Graceful degradation: if user-memory service is unavailable, passes through.
 */

const SEMANTIC_SYSTEM_PROMPT = `You are a strict skill-matching assistant. Given a user's request and a list of installed skills, determine if any skill EXACTLY matches what the user wants to do.

Rules:
- Only match if the skill's purpose DIRECTLY covers the user's request — same service, same action type, same intent.
- Do NOT match on loose thematic similarity. Sharing a general domain does NOT qualify.
- IMPORTANT: Even if the user says "I need to create" or "I want to build" a skill, if an existing installed skill ALREADY covers the described capability, return that skill name.

## Recurring vs one-off — CRITICAL distinction:
- A skill that creates ONE Google Calendar event (gcal.event) does NOT match requests for recurring local reminders like "every morning", "daily at 6am", "remind me every day".
- Recurring/scheduled tasks that don't explicitly say "Google Calendar" or "add to my calendar" should NOT match calendar event creation skills.
- Only match a calendar skill if the user explicitly mentions Google Calendar, or says "add/create a calendar event/appointment".

## Matching examples:
- "Schedule my cold plunge every morning at 6am" → null (local recurring reminder, not a calendar event)
- "Add a dentist appointment to my Google Calendar" → gcal.event ✅
- "Remind me daily at 7am" → null (local OS reminder, not a calendar event)
- "Create a calendar event for the team meeting on Friday" → gcal.event ✅
- "Send Sarah a text" → sms/clicksend skill if installed ✅
- "Check the weather" → weather skill if installed ✅

Output format — ONLY these two formats, nothing else:
skill-name|HIGH
null

Return "null" when there is NO clear match or when confidence is not HIGH. Never return MEDIUM or LOW matches.`;

// Signals that the user wants a recurring/background task (not a one-off event)
const RECURRING_SIGNALS_RE = /\b(every\s+(morning|day|night|evening|week|month|hour|\d)|daily|weekly|monthly|alarm|each\s+(morning|day|night|evening|week)|remind\s+me\s+(daily|every)|recurring|repeat(ing)?|on\s+a\s+(daily|weekly|\w+)\s+schedule|at\s+\d{1,2}(:\d{2})?\s*(am|pm)\s+(every|daily|each))\b/i;
// Skill name fragments that indicate a one-shot event-creation skill (not a daemon)
const ONE_SHOT_EVENT_MARKERS = ['calendar', '.event', 'booking', 'meeting', 'webex', 'zoom.schedule'];

// Patterns that indicate the user wants to CREATE a skill (phrasing, not intent)
const WANTS_TO_CREATE_RE = /\b(create|build|make|write|add|install|set up|setup)\b.{0,40}\b(skill|ability|feature|capability|automation|tool)\b|\bneed (a |to )?(create|build|make|have)\b|\bdon't have\b|\bdoesn'?t exist\b/i;

module.exports = async function parseSkill(state) {
  const { mcpAdapter, message, resolvedMessage, llmBackend } = state;
  const logger = state.logger || console;

  const classifyMessage = (resolvedMessage || message || '').trim();

  if (!classifyMessage) return state;

  // No adapter → pass through
  if (!mcpAdapter) {
    logger.debug('[Node:ParseSkill] No mcpAdapter — skipping');
    return state;
  }

  let installedSkills = [];
  try {
    const result = await mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 3000 });
    const data = result?.data || result;
    installedSkills = data?.results || [];
  } catch (err) {
    logger.debug(`[Node:ParseSkill] Could not fetch installed skills: ${err.message} — skipping`);
    return state;
  }

  if (installedSkills.length === 0) {
    logger.debug('[Node:ParseSkill] No installed skills — skipping');
    return state;
  }

  const msgLower = classifyMessage.toLowerCase();

  for (const skill of installedSkills) {
    const skillName = skill.name; // e.g. "check.weather.daily"
    const skillLower = skillName.toLowerCase();

    // Strategy 1: exact dot-name match — message starts with or contains "check.weather.daily"
    if (
      msgLower === skillLower ||
      msgLower.startsWith(skillLower + ' ') ||
      msgLower.startsWith(skillLower + ':') ||
      msgLower.startsWith('run ' + skillLower) ||
      msgLower.startsWith('use ' + skillLower) ||
      msgLower.startsWith('execute ' + skillLower)
    ) {
      logger.debug(`[Node:ParseSkill] Exact match: "${classifyMessage}" → skill "${skillName}"`);
      return _matchedState(state, skillName);
    }

    // Strategy 2: natural language — dot replaced by spaces
    // "check.weather.daily" → "check weather daily"
    const skillPhrase = skillLower.replace(/\./g, ' ');
    if (msgLower.includes(skillPhrase)) {
      // Confirm word boundaries on each end of the phrase
      const idx = msgLower.indexOf(skillPhrase);
      const before = idx === 0 ? '' : msgLower[idx - 1];
      const after = msgLower[idx + skillPhrase.length] || '';
      const boundaryBefore = before === '' || before === ' ' || before === '\t';
      const boundaryAfter = after === '' || after === ' ' || after === ',' || after === '.' || after === ':';
      if (boundaryBefore && boundaryAfter) {
        logger.debug(`[Node:ParseSkill] Natural-language match: "${classifyMessage}" → skill "${skillName}"`);
        return _matchedState(state, skillName);
      }
    }
  }

  // ── Strategy 2.5: capability-keyword match ───────────────────────────────────
  // Catches "send me a text", "send an email", etc. when an installed skill covers
  // that capability — prevents parseIntent from misclassifying as memory_store.
  // Guard: only match if (a) a phone/email address is present, OR (b) the prompt
  // is short (≤120 chars) and SMS/email is clearly the primary intent.
  // Long multi-step prompts with "send a text" as a trailing clause must NOT match
  // here — they need the full planning pipeline.
  const hasPhoneNumber = /\b\d{10,11}\b|\+1\d{10}/.test(classifyMessage);
  const isShortPrompt  = classifyMessage.trim().length <= 120;
  const CAPABILITY_PATTERNS = [
    { keywords: /\b(send|text|sms|message)\b.*\b(text|sms|message)\b|\b(send|text)\b.*\b\d{10,11}\b|\btext (me|him|her|them|us)\b|\btext (this|that|it) to (me|him|her|them|us|\d{7,})\b/i, capability: 'sms',   requiresPhoneOrShort: true },
    { keywords: /\b(send|compose|write)\b.*\b(email|mail)\b/i,                                                                capability: 'email', requiresPhoneOrShort: false },
  ];
  for (const pattern of CAPABILITY_PATTERNS) {
    if (pattern.keywords.test(classifyMessage)) {
      // For SMS: only match if there's a phone number OR it's a short focused prompt
      if (pattern.requiresPhoneOrShort && !hasPhoneNumber && !isShortPrompt) continue;
      // Find an installed skill whose name contains the capability
      const capSkill = installedSkills.find(s => s.name.toLowerCase().includes(pattern.capability));
      if (capSkill) {
        logger.info(`[Node:ParseSkill] Capability-keyword match: "${classifyMessage.substring(0,60)}" → skill "${capSkill.name}"`);
        return _matchedState(state, capSkill.name);
      }
    }
  }

  // ── Strategy 2.7: description-keyword overlap match ─────────────────────────
  // Deterministic fallback before the LLM: extract meaningful capability words
  // from the user message and check if any installed skill's description contains
  // a critical mass of them. This catches "scroll / type / shortcut / app control"
  // requests matching browser.act without relying on the LLM.
  const userWantsToCreate = WANTS_TO_CREATE_RE.test(classifyMessage);
  {
    // Capability keyword groups — each group is a set of synonyms for one concept.
    // A skill description must contain at least MIN_GROUPS_MATCHED groups to match.
    const CAPABILITY_GROUPS = [
      { words: ['scroll', 'scrolling', 'scroll up', 'scroll down', 'scrolls'] },
      { words: ['type', 'typing', 'type text', 'type chars', 'keypress'] },
      { words: ['keyboard', 'keystroke', 'shortcut', 'shortcuts', 'hotkey', 'key combination', 'ctrl+', 'cmd+', 'command+'] },
      { words: ['click', 'clicking', 'mouse click'] },
      { words: ['mouse', 'cursor', 'move mouse', 'drag', 'right-click', 'double-click', 'mouse button'] },
      { words: ['app control', 'control app', 'interact with app', 'application control', 'desktop automation', 'ui automation', 'automate app'] },
      { words: ['playwright', 'nut-js', 'nut.js', 'robotjs', 'pyautogui', 'xdotool'] },
      { words: ['window', 'windows', 'active window', 'current app'] },
      { words: ['foreground', 'foreground app', 'bring to front', 'bring to foreground', 'focus window', 'focus app', 'activate window'] },
    ];
    const MIN_GROUPS_MATCHED = 2; // user message must hit ≥2 groups to qualify

    const msgWords = msgLower;

    // How many capability groups does the user message touch?
    const userGroupHits = CAPABILITY_GROUPS.filter(g => g.words.some(w => msgWords.includes(w))).length;

    if (userGroupHits >= MIN_GROUPS_MATCHED) {
      // Now check installed skills — find one whose description also hits ≥2 of the same groups
      for (const skill of installedSkills) {
        const descLower = (skill.description || skill.summary || '').toLowerCase();
        if (!descLower) continue;
        const descGroupHits = CAPABILITY_GROUPS.filter(g => g.words.some(w => descLower.includes(w))).length;
        if (descGroupHits >= MIN_GROUPS_MATCHED) {
          logger.info(`[Node:ParseSkill] Description-keyword match (${userGroupHits}/${descGroupHits} groups): "${classifyMessage.substring(0, 60)}" → skill "${skill.name}"${userWantsToCreate ? ' (userWantsToCreate)' : ''}`);
          return _matchedState(state, skill.name, userWantsToCreate);
        }
      }
    }
  }

  // ── Strategy 2.8: diagnostic/repair intent → prefer debug/repair skills ──────────
  // "why is my calendar broken" must route to oauth.debug, NOT gcal.event.
  // The LLM semantic match (Strategy 3) misroutes these because the service keyword
  // ("calendar") dominates over the diagnostic intent. Catch them deterministically:
  // if the message signals that something is broken/needs fixing, AND an installed
  // skill whose name contains "debug"/"repair"/"diagnose"/"health" has at least one
  // meaningful word in common with the message, prefer that skill.
  {
    const DIAGNOSTIC_INTENT_RE = /\b(why\s+(is|are|isn'?t|aren'?t|won'?t|doesn'?t|can'?t)|broken[\s?!]|(isn'?t|not|won'?t|doesn'?t)\s+work(ing)?|fix\s+(my|this|the)|debug\s+(my|this|the)|diagnose|repair\s+(my|this|the)|what'?s\s+wrong|something'?s\s+(wrong|off|broken)|keep(s)?\s+(failing|breaking|erroring|looping))\b/i;
    const DIAGNOSTIC_NAME_MARKERS = ['debug', 'repair', 'diagnose', 'health'];

    if (DIAGNOSTIC_INTENT_RE.test(classifyMessage) && !userWantsToCreate) {
      const diagSkills = installedSkills.filter(s =>
        DIAGNOSTIC_NAME_MARKERS.some(m => s.name.toLowerCase().includes(m))
      );
      if (diagSkills.length > 0) {
        const msgTokens = new Set(
          classifyMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3)
        );
        const scored = diagSkills.map(s => {
          const descWords = (s.description || s.summary || '').toLowerCase().split(/\W+/);
          const overlap = descWords.filter(w => w.length > 3 && msgTokens.has(w)).length;
          return { skill: s, overlap };
        }).sort((a, b) => b.overlap - a.overlap);

        if (scored[0] && scored[0].overlap >= 1) {
          const best = scored[0].skill;
          logger.info(`[Node:ParseSkill] Diagnostic-intent match: "${classifyMessage.substring(0, 60)}" → skill "${best.name}" (overlap=${scored[0].overlap})`);
          return _matchedState(state, best.name);
        }
      }
    }
  }

  // ── Strategy 3: LLM semantic match ──────────────────────────────────────────
  // Only fires when both string strategies miss AND we have an LLM backend.
  // Builds a compact skill menu (name + description) and asks the LLM for a
  // clear match. Falls through gracefully on timeout, missing backend, or null.
  if (!llmBackend) {
    logger.debug(`[Node:ParseSkill] No skill match (no llmBackend for semantic fallback): "${classifyMessage.substring(0, 80)}"`);
    return state;
  }

  // Only attempt if at least some skills have descriptions — otherwise the LLM
  // has nothing useful to compare against.
  let skillsWithDesc = installedSkills.filter(s => s.description || s.summary);
  if (skillsWithDesc.length === 0) {
    logger.debug(`[Node:ParseSkill] No skill match (no descriptions for semantic match): "${classifyMessage.substring(0, 80)}"`);
    return state;
  }

  // ── Pre-LLM guard: recurring request → exclude one-shot calendar/event skills ──
  // Prevents "cold plunge every morning" from matching gcal.event.
  // Only filters when the message has clear recurring signals AND does NOT
  // explicitly mention Google Calendar or "calendar event".
  const hasRecurringSignal = RECURRING_SIGNALS_RE.test(classifyMessage);
  const hasExplicitCalendar = /\b(google calendar|my calendar|calendar event|add to (my )?calendar|create (a |an )?event|make (a |an )?appointment)\b/i.test(classifyMessage);
  if (hasRecurringSignal && !hasExplicitCalendar) {
    const beforeFilter = skillsWithDesc.length;
    skillsWithDesc = skillsWithDesc.filter(s => {
      const nameLow = s.name.toLowerCase();
      return !ONE_SHOT_EVENT_MARKERS.some(m => nameLow.includes(m));
    });
    if (skillsWithDesc.length < beforeFilter) {
      logger.info(`[Node:ParseSkill] Pre-LLM guard: excluded ${beforeFilter - skillsWithDesc.length} one-shot event skill(s) — recurring request detected ("${classifyMessage.substring(0, 60)}")`);
    }
    if (skillsWithDesc.length === 0) {
      logger.debug(`[Node:ParseSkill] Semantic skipped — all candidates excluded by recurring guard`);
      return state;
    }
  }

  const skillMenu = skillsWithDesc
    .map(s => `- ${s.name}: ${(s.description || s.summary || '').slice(0, 120)}`)
    .join('\n');

  const semanticPrompt = `User request: "${classifyMessage}"\n\nInstalled skills:\n${skillMenu}\n\nDoes any skill clearly match this request? Return "skill-name|HIGH" or "null".
Examples: "gcal.event|HIGH" or "null"`;

  try {
    const raw = await Promise.race([
      llmBackend.generateAnswer(semanticPrompt, {
        systemInstructions: SEMANTIC_SYSTEM_PROMPT,
        conversationHistory: [],
        intent: 'command_automate'
      }, { maxTokens: 60, temperature: 0, fastMode: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('semantic timeout')), 5000)),
    ]);

    // Parse format: "skill-name|HIGH" or legacy plain "skill-name" or "null"
    const rawTrimmed = (raw || '').trim().replace(/^["`']|["`']$/g, '');
    // Split on pipe — if HIGH confidence declared, take it; otherwise plain name treated as HIGH (backwards compat)
    const [candidatePart, confidencePart] = rawTrimmed.split('|').map(p => p.trim().toLowerCase());
    const candidate = candidatePart;
    const confidence = confidencePart || 'high'; // legacy responses without pipe treated as HIGH

    if (confidence !== 'high') {
      logger.debug(`[Node:ParseSkill] Semantic LLM returned confidence "${confidence}" — skipping (only HIGH accepted)`);
    } else if (candidate && candidate !== 'null' && candidate !== 'none' && candidate !== '') {
      // Verify the returned name is actually an ALLOWED candidate (not filtered out by recurring guard)
      const confirmed = skillsWithDesc.find(s => s.name.toLowerCase() === candidate);
      if (confirmed) {
        logger.info(`[Node:ParseSkill] Semantic match: "${classifyMessage.substring(0, 60)}" → skill "${confirmed.name}"${userWantsToCreate ? ' (userWantsToCreate)' : ''}`);
        return _matchedState(state, confirmed.name, userWantsToCreate);
      } else {
        logger.debug(`[Node:ParseSkill] Semantic LLM returned unknown skill "${candidate}" — ignoring`);
      }
    } else {
      logger.debug(`[Node:ParseSkill] Semantic LLM returned null — no match`);
    }
  } catch (e) {
    logger.debug(`[Node:ParseSkill] Semantic match skipped: ${e.message}`);
  }

  logger.debug(`[Node:ParseSkill] No skill match for: "${classifyMessage.substring(0, 80)}"`);
  return state;
};

function _matchedState(state, skillName, userWantsToCreate = false) {
  return {
    ...state,
    matchedSkillName: skillName,
    matchedSkillUserWantsToCreate: userWantsToCreate,
    intent: {
      type: 'command_automate',
      confidence: 1.0,
      entities: [{ skill: 'external.skill', name: skillName }],
      requiresMemoryAccess: false
    },
    metadata: { parser: 'parseSkill-exact', processingTimeMs: 0 }
  };
}

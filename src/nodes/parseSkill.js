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

const SEMANTIC_SYSTEM_PROMPT = `You are a skill-matching assistant. Given a user's request and a list of installed skills (with names and descriptions), determine if any skill clearly matches what the user wants to do.

Rules:
- Only match if the skill's purpose CLEARLY covers the user's request — same service, same action type.
- Do NOT match on loose similarity (e.g. "weather" skill does not match "check my email").
- If the user is asking to BUILD or CREATE something new, return null — do not match an existing skill.
- Return ONLY the exact skill name string (e.g. "gmail.daily.summary") or the word null.
- No explanation, no punctuation, no quotes around the name.`;

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
  const skillsWithDesc = installedSkills.filter(s => s.description || s.summary);
  if (skillsWithDesc.length === 0) {
    logger.debug(`[Node:ParseSkill] No skill match (no descriptions for semantic match): "${classifyMessage.substring(0, 80)}"`);
    return state;
  }

  const skillMenu = skillsWithDesc
    .map(s => `- ${s.name}: ${(s.description || s.summary || '').slice(0, 120)}`)
    .join('\n');

  const semanticPrompt = `User request: "${classifyMessage}"\n\nInstalled skills:\n${skillMenu}\n\nDoes any skill clearly match this request? Return the exact skill name or null.`;

  try {
    const raw = await Promise.race([
      llmBackend.generateAnswer(SEMANTIC_SYSTEM_PROMPT, semanticPrompt, { temperature: 0 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('semantic timeout')), 5000)),
    ]);

    const candidate = (raw || '').trim().replace(/^["']|["']$/g, '').toLowerCase();

    if (candidate && candidate !== 'null' && candidate !== 'none' && candidate !== '') {
      // Verify the returned name is actually an installed skill (LLM can hallucinate)
      const confirmed = installedSkills.find(s => s.name.toLowerCase() === candidate);
      if (confirmed) {
        logger.info(`[Node:ParseSkill] Semantic match: "${classifyMessage.substring(0, 60)}" → skill "${confirmed.name}"`);
        return _matchedState(state, confirmed.name);
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

function _matchedState(state, skillName) {
  return {
    ...state,
    matchedSkillName: skillName,
    intent: {
      type: 'command_automate',
      confidence: 1.0,
      entities: [{ skill: 'external.skill', name: skillName }],
      requiresMemoryAccess: false
    },
    metadata: { parser: 'parseSkill-exact', processingTimeMs: 0 }
  };
}

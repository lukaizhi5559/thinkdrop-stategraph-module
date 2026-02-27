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

module.exports = async function parseSkill(state) {
  const { mcpAdapter, message, resolvedMessage } = state;
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

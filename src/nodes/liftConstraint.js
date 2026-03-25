/**
 * Lift Constraint Node
 *
 * Handles lift_constraint intent: finds the best-matching stored constraint
 * by keyword overlap and removes it.
 *
 * Examples handled:
 *   "Remove the rule about not deleting my Documents folder"
 *   "Lift the constraint on visiting YouTube"
 *   "Allow me to delete files again"
 *   "Forget the rule about installing packages"
 *   "Remove rule 2"
 *   "Remove all constraints"
 */

'use strict';

// Strip the "lift preamble" to get the subject the user is talking about
const LIFT_PREAMBLE = /^(?:lift|remove|delete|cancel|undo|clear|disable|drop)\s+(?:the\s+)?(?:constraint|rule|block|restriction|ban)\s*(?:on|about|for|regarding)?\s*/i;
const ALLOW_AGAIN_PREAMBLE = /^(?:allow|let)\s+me\s+(?:to\s+)?(?:now\s+)?(?:be\s+able\s+to\s+)?/i;
const MIND_PREAMBLE = /^i\s+changed\s+my\s+mind\s+(?:about|and)[,\s]*/i;
const WANT_PREAMBLE = /^i\s+want\s+to\s+be\s+able\s+to\s+/i;

function extractSubject(text) {
  return text
    .replace(LIFT_PREAMBLE, '')
    .replace(ALLOW_AGAIN_PREAMBLE, '')
    .replace(MIND_PREAMBLE, '')
    .replace(WANT_PREAMBLE, '')
    .replace(/\bagain\b/gi, '')
    .replace(/\bthe\s+rules?\b/gi, '')
    .replace(/\bthe\s+constraints?\b/gi, '')
    .replace(/^(?:on|about|for|regarding)\s+/i, '')
    .trim();
}

const STOP_WORDS = new Set([
  'the', 'and', 'from', 'that', 'this', 'with', 'not', 'let', 'can', 'you',
  'for', 'are', 'was', 'its', 'all', 'any', 'but', 'our', 'they', 'been',
  'have', 'has', 'will', 'would', 'could', 'should', 'never', 'dont', 'also',
  'just', 'make', 'sure', 'please', 'allow', 'me', 'to', 'a', 'an', 'is',
  'it', 'my', 'no', 'in', 'on', 'at', 'by', 'be', 'do',
]);

function keywords(text) {
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

module.exports = async function liftConstraintNode(state) {
  const { mcpAdapter, message, resolvedMessage, logger } = state;
  const text = (resolvedMessage || message || '').trim();

  if (!mcpAdapter) {
    return { ...state, answer: 'I need the memory service to manage constraints.' };
  }

  // Fetch all constraints
  let constraints = [];
  try {
    const listResult = await mcpAdapter.callService('user-memory', 'constraint.list', {});
    constraints = listResult?.data?.constraints || listResult?.constraints || [];
  } catch (err) {
    logger.error('[Node:LiftConstraint] Failed to list constraints:', err?.message);
    return { ...state, answer: 'I had trouble reading your stored rules. Please try again.' };
  }

  if (constraints.length === 0) {
    return {
      ...state,
      answer: "You don't have any active rules set up, so there's nothing to remove.",
    };
  }

  // ── "remove all constraints" / "clear all rules" ───────────────────────────
  if (/\b(all|every)\s+(?:constraints?|rules?|blocks?|restrictions?)\b/i.test(text)) {
    try {
      for (const c of constraints) {
        await mcpAdapter.callService('user-memory', 'constraint.remove', { id: c.id });
      }
      logger.info(`[Node:LiftConstraint] Removed all ${constraints.length} constraints`);
      return {
        ...state,
        answer: `Done — I've removed all ${constraints.length} of your rules. No restrictions are active.`,
      };
    } catch (err) {
      logger.error('[Node:LiftConstraint] Failed to remove all constraints:', err?.message);
      return { ...state, answer: 'I had trouble removing your rules. Please try again.' };
    }
  }

  // ── Numeric reference: "remove rule 2" ────────────────────────────────────
  const numRef = text.match(/\b(?:rule|number|no\.?|#)\s*(\d+)\b/i) || text.match(/^(\d+)\s*$/);
  if (numRef) {
    const idx = parseInt(numRef[1], 10) - 1;
    if (idx >= 0 && idx < constraints.length) {
      const target = constraints[idx];
      try {
        await mcpAdapter.callService('user-memory', 'constraint.remove', { id: target.id });
        logger.info(`[Node:LiftConstraint] Removed constraint #${idx + 1} id=${target.id}`);
        return {
          ...state,
          answer: `Done — rule ${idx + 1} has been removed: "${target.rule}" no longer applies.`,
        };
      } catch (err) {
        logger.error('[Node:LiftConstraint] Failed to remove constraint:', err?.message);
        return { ...state, answer: 'I had trouble removing that rule. Please try again.' };
      }
    }
  }

  // ── Keyword matching ───────────────────────────────────────────────────────
  const subject    = extractSubject(text);
  const subjectKws = keywords(subject.length > 3 ? subject : text);

  let bestMatch = null;
  let bestScore = 0;

  for (const c of constraints) {
    const ruleKws = keywords(c.rule);
    const overlap = ruleKws.filter(w => subjectKws.includes(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestMatch = c;
    }
  }

  // Require at least 1 content keyword overlap unless there's only one constraint
  if (!bestMatch || (bestScore < 1 && constraints.length > 1)) {
    const ruleList = constraints
      .map((c, i) => `${i + 1}. "${c.rule}"${c.pinProtected ? ' 🔒' : ''}`)
      .join('\n');
    return {
      ...state,
      answer: `I wasn't sure which rule you meant. Here are your active rules:\n\n${ruleList}\n\nTell me which one to remove (e.g. "remove rule 2") or describe it more specifically.`,
    };
  }

  // If only one constraint and no keyword match, still remove it (unambiguous)
  const target = bestMatch || constraints[0];

  try {
    await mcpAdapter.callService('user-memory', 'constraint.remove', { id: target.id });
    logger.info(`[Node:LiftConstraint] Removed constraint id=${target.id}: "${target.rule}"`);
    return {
      ...state,
      answer: `Done — I've removed that rule. "${target.rule}" no longer applies.`,
    };
  } catch (err) {
    logger.error('[Node:LiftConstraint] Failed to remove constraint:', err?.message);
    return { ...state, answer: 'I had trouble removing that rule. Please try again.' };
  }
};

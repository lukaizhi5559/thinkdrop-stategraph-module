/**
 * Store Constraint Node
 *
 * Handles set_constraint intent: parses the user's rule, derives action glob
 * patterns, calls constraint.add via MCP, and returns a confirmation message.
 *
 * Examples handled:
 *   "Never let me delete anything in my Documents folder"
 *   "Don't let me push to main without confirmation"
 *   "Prevent me from running rm -rf"
 *   "Block me from installing new packages"
 */

'use strict';

// ---------------------------------------------------------------------------
// Verb → action glob patterns mapping
// When a constraint is stored, these patterns go into the `blocks` array so
// planSkills can match them via constraint.check later.
// ---------------------------------------------------------------------------
const VERB_PATTERNS = [
  { verbs: /\b(delete|rm|remove|del|unlink|wipe|erase|purge|trash|clear\s+all|unlink)\b/i,
    patterns: ['shell.run.*'] },
  { verbs: /\b(format|fdisk|mkfs)\b/i,
    patterns: ['format.*', 'shell.run.*'] },
  { verbs: /\b(git.{0,10}push|force.{0,6}push|push\s+to)\b/i,
    patterns: ['git.push.*', 'shell.run.*'] },
  { verbs: /\b(install|brew\s+install|npm\s+install|pip\s+install|apt\s+install)\b/i,
    patterns: ['install.*', 'shell.run.*', 'brew.*', 'npm.*'] },
  { verbs: /\b(uninstall|remove\s+package|brew\s+uninstall)\b/i,
    patterns: ['uninstall.*', 'shell.run.*'] },
  { verbs: /\b(publish|npm\s+publish|deploy\s+to\s+prod)\b/i,
    patterns: ['publish.*', 'npm.*', 'shell.run.*'] },
  { verbs: /\b(drop\s+(table|database|db|schema)|truncate)\b/i,
    patterns: ['db.*', 'sql.*', 'shell.run.*'] },
  { verbs: /\b(chmod|chown|sudo|su\s+root)\b/i,
    patterns: ['shell.run.*'] },
  { verbs: /\b(send|email|text|message|tweet|post|share)\b/i,
    patterns: ['messaging.*', 'browser.act.*', 'api.*'] },
  { verbs: /\b(download|curl\s+.*-o|wget)\b/i,
    patterns: ['download.*', 'shell.run.*', 'browser.act.*'] },
];

/**
 * Derive action glob patterns from the constraint text.
 * Always returns at least ['shell.run.*'] as a broad catch-all.
 */
function deriveBlockPatterns(text) {
  const found = new Set();
  for (const { verbs, patterns } of VERB_PATTERNS) {
    if (verbs.test(text)) {
      patterns.forEach(p => found.add(p));
    }
  }
  if (found.size === 0) {
    // Broad fallback — any shell or browser action
    found.add('shell.run.*');
  }
  return [...found];
}

/**
 * Strip the constraint preamble from the message to extract just the rule intent.
 * "Never let me delete anything in my Documents folder"
 *   → "delete anything in my Documents folder"
 */
function extractRuleCore(text) {
  return text
    .replace(/^(never|don'?t|do\s+not|please\s+(don'?t|never|do\s+not))\s+(let\s+me|allow\s+(me\s+to|me))\s+/i, '')
    .replace(/^(prevent|stop)\s+me\s+from\s+/i, '')
    .replace(/^(always\s+)?block\s+(me\s+from|any\s+attempt\s+to)\s+/i, '')
    .replace(/^make\s+sure\s+(i|you)\s+(never|don'?t|do\s+not)\s+/i, '')
    .replace(/^(refuse|deny|disallow|forbid)\s+(any\s+)?(request\s+to|me\s+(from\s+|to\s+))\s*/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------
module.exports = async function storeConstraintNode(state) {
  const { mcpAdapter, message, resolvedMessage, logger } = state;
  const isCapturedCorrection = !!state._capturedCorrection;
  const text = (resolvedMessage || message || '').trim();

  // Extract optional PIN: "... unless (the) secret/password/pin/code (is) ABC123"
  // The PIN suffix is stripped from the stored rule text.
  const PIN_RE = /\b(?:unless|except)\s+(?:with\s+)?(?:the\s+)?(?:secret|password|pin|code)\s+(?:is\s+)?([A-Z0-9]{3,20})\b|\b(?:secret|pin|password|code)\s+(?:is\s+)?([A-Z0-9]{3,20})\s*$/i;
  const pinMatch = text.match(PIN_RE);
  const pin = pinMatch ? (pinMatch[1] || pinMatch[2]).toUpperCase() : null;

  // Store the rule WITHOUT the pin suffix (the pin is stored hashed separately)
  const ruleText = pin ? text.replace(PIN_RE, '').replace(/[,.\s]+$/, '').trim() : text;
  const ruleCore  = extractRuleCore(ruleText);
  const blocks    = deriveBlockPatterns(ruleText);

  logger.info(`[Node:StoreConstraint] Storing constraint: "${ruleText}" → blocks: [${blocks.join(', ')}]`);

  if (!mcpAdapter) {
    logger.warn('[Node:StoreConstraint] MCP not available — constraint not persisted');
    return {
      ...state,
      answer: `Got it — I'll enforce that rule going forward (note: rule storage unavailable without MCP).`,
    };
  }

  try {
    const result = await mcpAdapter.callService('user-memory', 'constraint.add', {
      rule:     ruleText,
      scope:    'global',
      blocks,
      severity: 'hard',
      pin,
    });

    if (result?.data?.id || result?.id) {
      const ruleId = result?.data?.id || result?.id;
      logger.info(`[Node:StoreConstraint] Constraint stored with id=${ruleId} pin=${pin ? 'yes' : 'no'} correction=${isCapturedCorrection}`);
      return {
        ...state,
        answer: isCapturedCorrection
          ? `Understood — I've noted that and saved it as a permanent rule so I won't repeat that behaviour.`
          : pin
            ? `Got it — I've set a PIN-protected rule. I'll block any attempt to ${ruleCore} unless you include the correct secret in your message.`
            : `Got it — I've set a rule to prevent that. I'll block any attempt to ${ruleCore} going forward.`,
      };
    }

    // Stored but no id returned — still success
    logger.warn('[Node:StoreConstraint] Constraint.add returned unexpected shape:', JSON.stringify(result));
    return {
      ...state,
      answer: isCapturedCorrection
        ? `Understood — I've noted that as a rule for future tasks.`
        : `Got it — I've stored that as a rule. I'll refuse any attempt to ${ruleCore} from now on.`,
    };

  } catch (err) {
    logger.error('[Node:StoreConstraint] Failed to store constraint:', err?.message);
    return {
      ...state,
      answer: `I had trouble saving that rule. Please try again.`,
    };
  }
};

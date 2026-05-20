'use strict';

/**
 * executeSettings node
 *
 * Handles system_settings intents — parses natural-language setting changes
 * (e.g. "set plan approval to auto") and writes them to ~/.thinkdrop/settings.json.
 * Returns confirmation text via _forceAnswerContext for the answer node to summarize.
 *
 * Route: enrichIntent → executeSettings → answer → logConversation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_FILE = path.join(os.homedir(), '.thinkdrop', 'settings.json');

// ── Supported settings ──────────────────────────────────────────────────────
// Each entry: { key, detect(msg), resolve(msg), display }
const SETTINGS = [
  {
    key: 'planApprovalMode',
    label: 'Plan Approval Mode',
    detect: /plan\s*approval|auto[\s-]?approv|always\s*approv/i,
    resolve(msg) {
      const lower = msg.toLowerCase();
      if (/\b(auto|off|disable|skip|none|no\s*approval)\b/.test(lower))   return 'auto';
      if (/\b(always|all|every|on|enable)\b/.test(lower))                 return 'always';
      if (/\b(multi|2\+?|two|multiple|multi[\s-]?step)\b/.test(lower))   return 'multi_step';
      return null;
    },
    display: { always: 'Always approve', multi_step: 'Multi-step plans only', auto: 'Auto-approve all' },
    valid: ['always', 'multi_step', 'auto'],
    default: 'multi_step',
  },
];

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = async function executeSettings(state) {
  const { message } = state;
  const logger = state.logger || console;

  logger.info(`[Node:ExecuteSettings] message: "${(message || '').slice(0, 80)}"`);

  if (!message) {
    return {
      ...state,
      _forceAnswerContext: '## Settings\n\nNo setting change was specified. Try: "Set plan approval to auto" or "Change plan approval to always".',
    };
  }

  // Detect which setting the user wants to change
  let matched = null;
  for (const setting of SETTINGS) {
    if (setting.detect.test(message)) {
      matched = setting;
      break;
    }
  }

  if (!matched) {
    const available = SETTINGS.map(s => `- **${s.label}**: ${s.valid.map(v => `\`${v}\``).join(', ')}`).join('\n');
    return {
      ...state,
      _forceAnswerContext: `## Settings\n\nI couldn't determine which setting to change from your message.\n\nAvailable settings:\n${available}\n\nExample: "Set plan approval to auto"`,
    };
  }

  // Resolve the new value
  const newValue = matched.resolve(message);
  if (!newValue || !matched.valid.includes(newValue)) {
    const options = matched.valid.map(v => `\`${v}\` — ${matched.display[v]}`).join('\n- ');
    return {
      ...state,
      _forceAnswerContext: `## Settings — ${matched.label}\n\nCouldn't determine the desired value. Options:\n- ${options}\n\nExample: "Set plan approval to auto"`,
    };
  }

  // Read current, apply, save
  const data = loadSettings();
  const oldValue = data[matched.key] || matched.default;
  data[matched.key] = newValue;
  saveSettings(data);

  const oldLabel = matched.display[oldValue] || oldValue;
  const newLabel = matched.display[newValue] || newValue;

  logger.info(`[Node:ExecuteSettings] ${matched.key}: "${oldValue}" → "${newValue}"`);

  return {
    ...state,
    _forceAnswerContext: `## Settings Updated\n\n**${matched.label}** changed from **${oldLabel}** to **${newLabel}**.\n\nThis takes effect immediately for all future plans.`,
  };
};

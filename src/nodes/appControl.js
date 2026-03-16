/**
 * App Control Node
 *
 * Handles app_control_start intent — enters or exits persistent app control mode.
 *
 * State inputs:
 *   state.message / state.resolvedMessage  — user request
 *   state.intent.type                      — must be 'app_control_start'
 *   state.appControlMode                   — current mode state (null or { active, app })
 *
 * State outputs:
 *   state.appControlMode   — { active: bool, app: string|null, enteredAt: ISO }
 *   state.answer           — confirmation message shown to user
 */

const EXIT_PATTERNS = /\b(stop|exit|quit|done|off|disable|deactivate|leave|end|release)\b/i;
// Match "control Slack", "take control of Chrome" etc — but NOT "control mode" or "turn on control mode"
const APP_NAME_RE = /\b(?:controlling|start\s+controlling|take\s+control\s+of|control(?!\s+mode))\s+([a-zA-Z][a-zA-Z0-9\s\-\.]{1,30})/i;
const CONTROL_MODE_TOGGLE_RE = /\b(turn\s+on|turn\s+off|enable|disable|activate|deactivate|enter|exit|start|stop)\s+control(?:\s+mode)?\b/i;

module.exports = async function appControl(state) {
  const logger = state.logger || console;
  const msg = (state.resolvedMessage || state.message || '').trim();
  const lower = msg.toLowerCase();
  const current = state.appControlMode || { active: false, app: null };

  // ── Exit control mode ────────────────────────────────────────────────────
  const isExit = EXIT_PATTERNS.test(lower) &&
    !/control (slack|word|chrome|figma|vscode|vs code|the app|this app|current app)/i.test(lower);

  if (isExit && current.active) {
    logger.info(`[Node:AppControl] Exiting control mode (was: ${current.app || 'unknown'})`);
    return {
      ...state,
      appControlMode: { active: false, app: null, enteredAt: null },
      answer: `Control mode deactivated. You're back to normal mode.`,
    };
  }

  if (isExit && !current.active) {
    return {
      ...state,
      answer: `Control mode isn't active — nothing to stop.`,
    };
  }

  // ── Enter / toggle control mode ──────────────────────────────────────────
  // Only extract app name if this is NOT a bare toggle phrase ("turn on control mode")
  const isToggleOnly = CONTROL_MODE_TOGGLE_RE.test(lower) && !APP_NAME_RE.test(lower);
  const appMatch = isToggleOnly ? null : msg.match(APP_NAME_RE);
  const targetApp = appMatch ? appMatch[1].trim() : null;

  logger.info(`[Node:AppControl] Entering control mode${targetApp ? ` for "${targetApp}"` : ''}`);

  return {
    ...state,
    appControlMode: {
      active: true,
      app: targetApp,
      enteredAt: new Date().toISOString(),
    },
    answer: targetApp
      ? `Control mode active for **${targetApp}**. Say commands — scroll up/down, press enter, etc. Say **stop** to deactivate.`
      : `Control mode active. Say commands — scroll up/down, press enter, type text. Say **stop** to deactivate.`,
  };
};

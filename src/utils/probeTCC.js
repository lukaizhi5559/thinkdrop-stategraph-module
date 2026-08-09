'use strict';

/**
 * probeTCC.js — macOS TCC Automation permission probe
 *
 * macOS requires Automation permission (kTCCServiceAppleEvents) for osascript
 * to control other applications. If Electron (the ThinkDrop app) hasn't been
 * granted this permission, AppleScript commands to other apps (e.g. Spotify,
 * Music) silently fail with error -1743 (errAEEventNotPermitted) or trigger
 * a system permission dialog on first use.
 *
 * This probe runs a benign System Events query to check if automation permission
 * has been granted. If the query succeeds, TCC is granted. If it fails with a
 * permission error, TCC is not granted. If a system dialog appears (first run),
 * we mark needsPrompt=true so the caller can warn the user.
 *
 * Used by preflightAgents (Phase A2) before deciding the desktop route.
 *
 * Returns:
 *   { granted: boolean, needsPrompt: boolean, evidence: string }
 */

const { execSync } = require('child_process');

// TCC permission cache — avoids re-probing on every preflight run within a session
let _cachedResult = null;

/**
 * Probe macOS TCC Automation permission by running a benign System Events query.
 * @param {object} [logger] - optional logger
 * @returns {Promise<{ granted: boolean, needsPrompt: boolean, evidence: string }>}
 */
async function probeTCC(logger = console) {
  // Return cached result if available (TCC state doesn't change within a session)
  if (_cachedResult) {
    logger.debug?.(`[probeTCC] cached: granted=${_cachedResult.granted}, needsPrompt=${_cachedResult.needsPrompt}`);
    return _cachedResult;
  }

  if (process.platform !== 'darwin') {
    const result = { granted: true, needsPrompt: false, evidence: 'non-darwin — TCC not applicable' };
    _cachedResult = result;
    return result;
  }

  // Benign System Events query — doesn't control another app, just queries process info.
  // If TCC Automation is granted, this succeeds. If not, it fails with -1743 or triggers a dialog.
  const script = 'tell application "System Events" to get name of first application process';
  try {
    const result = execSync(`osascript -e '${script}'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    // If we got a non-empty response, TCC is granted for System Events at minimum.
    // Full automation of OTHER apps (Spotify, Music) may still need a separate TCC grant,
    // but System Events access is a strong signal that automation is generally permitted.
    const granted = result.length > 0;
    const tccResult = {
      granted,
      needsPrompt: false,
      evidence: `System Events query succeeded: "${result.slice(0, 60)}"`,
    };
    _cachedResult = tccResult;
    logger.info?.(`[probeTCC] granted=${granted}, evidence=${tccResult.evidence}`);
    return tccResult;
  } catch (err) {
    const errMsg = String(err.message || '');

    // Error -1743 = errAEEventNotPermitted — TCC not granted
    if (errMsg.includes('-1743') || errMsg.includes('not authorized') || errMsg.includes('not permitted')) {
      const tccResult = {
        granted: false,
        needsPrompt: false, // already denied — user would need to go to System Settings
        evidence: `TCC denied: ${errMsg.slice(0, 100)}`,
      };
      _cachedResult = tccResult;
      logger.info?.(`[probeTCC] granted=false (denied), evidence=${tccResult.evidence}`);
      return tccResult;
    }

    // Timeout or other error — likely a permission dialog appeared (first run)
    // or the user dismissed it. Mark as needsPrompt so the caller can warn.
    const tccResult = {
      granted: false,
      needsPrompt: true,
      evidence: `TCC probe failed (may need permission dialog): ${errMsg.slice(0, 100)}`,
    };
    _cachedResult = tccResult;
    logger.info?.(`[probeTCC] granted=false, needsPrompt=true, evidence=${tccResult.evidence}`);
    return tccResult;
  }
}

/**
 * Clear the cached TCC result. Useful for testing or if the user grants permission
 * mid-session (e.g. via System Settings).
 */
function clearTCCCache() {
  _cachedResult = null;
}

module.exports = { probeTCC, clearTCCCache };

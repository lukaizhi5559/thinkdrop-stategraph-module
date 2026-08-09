'use strict';

/**
 * probeDesktopApp.js — deterministic desktop app capability probe
 *
 * Used by preflightAgents (Phase A1) to determine if a service's desktop app
 * is installed, supports AppleScript automation, and whether the user is
 * logged in. Results feed into resolveRoute.js for the CLI > desktop > browser
 * route decision.
 *
 * Three checks:
 *   1. Installed? — osascript System Events process check + /Applications fallback
 *   2. AppleScript capability? — per-service capability map (desktop-capabilities.json)
 *   3. Logged in? — run the service's loginProbe AppleScript (if defined)
 *
 * Returns:
 *   { installed, capability, applescriptSupported, loggedIn, evidence }
 *   - capability: 'full' | 'partial' | 'none'
 *   - loggedIn: true | false | null (null = unknown / app not running)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _capabilityMap = null;

function _loadCapabilityMap() {
  if (_capabilityMap) return _capabilityMap;
  try {
    const p = path.resolve(__dirname, '..', 'data', 'desktop-capabilities.json');
    _capabilityMap = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    _capabilityMap = {};
  }
  return _capabilityMap;
}

/**
 * Check if a desktop app is installed on macOS.
 * Strategy: osascript System Events process list (fast, no launch) → /Applications ls fallback.
 * @param {string} appName - e.g. "Spotify", "Music"
 * @returns {{ installed: boolean, evidence: string }}
 */
function _checkInstalled(appName) {
  if (!appName || process.platform !== 'darwin') {
    return { installed: false, evidence: 'no appName or non-darwin' };
  }

  // Strategy 1: osascript System Events — checks running processes
  try {
    const script = `tell application "System Events" to (name of every process) contains "${appName}"`;
    const result = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      timeout: 3000,
    }).trim().toLowerCase();
    if (result === 'true') {
      return { installed: true, evidence: `process running: ${appName}` };
    }
  } catch (_) {
    // Process not running or osascript failed — fall through to /Applications check
  }

  // Strategy 2: ls /Applications — checks if app is installed (even if not running)
  try {
    const apps = execSync('ls /Applications 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\.app$`, 'i');
    if (apps.split('\n').some(line => re.test(line.trim()))) {
      return { installed: true, evidence: `found in /Applications: ${appName}.app` };
    }
  } catch (_) {}

  // Strategy 3: ls ~/Applications (user-level installs)
  try {
    const apps = execSync('ls ~/Applications 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\.app$`, 'i');
    if (apps.split('\n').some(line => re.test(line.trim()))) {
      return { installed: true, evidence: `found in ~/Applications: ${appName}.app` };
    }
  } catch (_) {}

  return { installed: false, evidence: `${appName} not found in /Applications or ~/Applications` };
}

/**
 * Check if the user is logged into the desktop app via AppleScript loginProbe.
 * Only runs if the app is installed AND has a loginProbe defined.
 * @param {object} capEntry - capability map entry for the service
 * @param {string} appName - app name for activation
 * @returns {{ loggedIn: boolean|null, evidence: string }}
 */
function _checkLoggedIn(capEntry, appName) {
  if (!capEntry?.loginProbe) {
    return { loggedIn: null, evidence: 'no loginProbe defined — login state unknown' };
  }

  // Activate the app first (AppleScript queries fail if app isn't frontmost or running)
  try {
    execSync(`osascript -e 'tell application "${appName}" to activate'`, {
      encoding: 'utf8',
      timeout: 3000,
    });
  } catch (_) {
    // App may not be running — try to open it
    try {
      execSync(`open -a "${appName}"`, { encoding: 'utf8', timeout: 3000 });
    } catch (_) {
      return { loggedIn: false, evidence: `could not activate/open ${appName}` };
    }
  }

  // Small delay to let the app respond
  try { execSync('sleep 1', { timeout: 2000 }); } catch (_) {}

  // Run the loginProbe
  try {
    const probe = capEntry.loginProbe;
    const result = execSync(`osascript -e '${probe.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim().toLowerCase();

    const successValues = (capEntry.loginSuccessValues || []).map(v => v.toLowerCase());
    if (successValues.length === 0) {
      // No success values defined — any non-empty response means logged in
      return { loggedIn: result.length > 0, evidence: `loginProbe returned: "${result}"` };
    }
    if (successValues.includes(result)) {
      return { loggedIn: true, evidence: `loginProbe returned: "${result}" (logged in)` };
    }
    return { loggedIn: false, evidence: `loginProbe returned: "${result}" (not logged in)` };
  } catch (err) {
    return { loggedIn: false, evidence: `loginProbe failed: ${err.message.slice(0, 100)}` };
  }
}

/**
 * Main probe entry point.
 * @param {string} serviceName - lowercase service key (e.g. "spotify", "apple_music")
 * @param {object} [logger] - optional logger
 * @returns {Promise<{ installed: boolean, capability: string, applescriptSupported: boolean, loggedIn: boolean|null, evidence: string }>}
 */
async function probeDesktopApp(serviceName, logger = console) {
  const capMap = _loadCapabilityMap();
  const entry = capMap[serviceName];

  // No entry in capability map → desktop route not viable for in-app control
  if (!entry) {
    return {
      installed: false,
      capability: 'none',
      applescriptSupported: false,
      loggedIn: null,
      evidence: `no capability map entry for "${serviceName}"`,
    };
  }

  const appName = entry.appName;

  // No appName → no desktop app (web-only service)
  if (!appName) {
    return {
      installed: false,
      capability: 'none',
      applescriptSupported: false,
      loggedIn: null,
      evidence: `service "${serviceName}" has no desktop app`,
    };
  }

  // Check 1: installed?
  const { installed, evidence: installEvidence } = _checkInstalled(appName);
  if (!installed) {
    return {
      installed: false,
      capability: 'none',
      applescriptSupported: !!entry.applescript,
      loggedIn: null,
      evidence: installEvidence,
    };
  }

  // Check 2: AppleScript capability
  const applescriptSupported = !!entry.applescript;
  const verbs = entry.verbs || [];
  let capability = 'none';
  if (applescriptSupported && verbs.length > 0) {
    capability = 'full';
  } else if (applescriptSupported) {
    capability = 'partial';
  }

  if (!applescriptSupported) {
    return {
      installed: true,
      capability: 'none',
      applescriptSupported: false,
      loggedIn: null,
      evidence: `${installEvidence}; no AppleScript support`,
    };
  }

  // Check 3: logged in?
  const { loggedIn, evidence: loginEvidence } = _checkLoggedIn(entry, appName);

  logger.info?.(`[probeDesktopApp] ${serviceName}: installed=${installed}, capability=${capability}, loggedIn=${loggedIn}, evidence=${installEvidence}; ${loginEvidence}`);

  return {
    installed: true,
    capability,
    applescriptSupported: true,
    loggedIn,
    evidence: `${installEvidence}; ${loginEvidence}`,
  };
}

module.exports = { probeDesktopApp, _loadCapabilityMap, _checkInstalled, _checkLoggedIn };

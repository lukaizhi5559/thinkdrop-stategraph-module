'use strict';

/**
 * resolveRoute.js — authoritative execution route decision
 *
 * Determines the best execution route for a service task, in priority order:
 *   CLI > desktop > browser > unknown
 *
 * Techie users prefer CLI (most accurate, scriptable, no UI dependency).
 * 70-80% of users fall through to desktop (if app installed + capable + logged in + TCC granted).
 * Browser is the universal fallback.
 *
 * This replaces the loose preflightRouteChoice/singleRouteMandate with a single
 * authoritative decision the planner MUST follow.
 *
 * Inputs:
 *   serviceName — lowercase service key (e.g. "spotify")
 *   desktopProbe — result of probeDesktopApp() { installed, capability, applescriptSupported, loggedIn }
 *   tccProbe — result of probeTCC() { granted, needsPrompt }
 *   cliProbe — result from cli.agent preflight_check (or null) { cli, installed, authed, authStatus }
 *   registeredAgents — array of registered agents for this service [{ id, type, authed }]
 *   browserServices — Set of known browser service keys (from browser-services.json)
 *   taskClassification — state._taskClassification (for task-type-aware routing)
 *
 * Output:
 *   { route, agentId, reason, probes, createAgent }
 *   route: 'cli' | 'desktop' | 'desktop_needs_login' | 'desktop_needs_tcc' | 'browser' | 'unknown'
 *   agentId: string | null (null for desktop — handled by shell.run + osascript)
 *   createAgent: boolean (true if browser agent needs to be built)
 */

const fs = require('fs');
const path = require('path');

let _browserServicesSet = null;

function _loadBrowserServices() {
  if (_browserServicesSet) return _browserServicesSet;
  try {
    const p = path.resolve(__dirname, '..', 'data', 'browser-services.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    _browserServicesSet = new Set([...(data.tierA || []), ...(data.tierB || [])]);
  } catch (e) {
    _browserServicesSet = new Set();
  }
  return _browserServicesSet;
}

/**
 * Resolve the execution route for a service.
 * @param {object} params
 * @param {string} params.serviceName - lowercase service key
 * @param {object|null} params.desktopProbe - probeDesktopApp result
 * @param {object|null} params.tccProbe - probeTCC result
 * @param {object|null} params.cliProbe - cli.agent preflight result for this service
 * @param {array} params.registeredAgents - registered agents for this service
 * @param {Set<string>} [params.browserServices] - browser service registry (auto-loaded if omitted)
 * @param {object} [params.taskClassification] - task classification
 * @param {object} [logger] - optional logger
 * @returns {{ route: string, agentId: string|null, reason: string, probes: object, createAgent: boolean }}
 */
function resolveRoute({
  serviceName,
  desktopProbe = null,
  tccProbe = null,
  cliProbe = null,
  registeredAgents = [],
  browserServices,
  taskClassification = null,
}, logger = console) {
  const svc = (serviceName || '').toLowerCase();
  const browserSet = browserServices || _loadBrowserServices();
  const probes = { desktop: desktopProbe, tcc: tccProbe, cli: cliProbe };

  // ── Priority 1: CLI ──────────────────────────────────────────────────────
  // Techie users get the most accurate route. CLI must be installed AND authed.
  if (cliProbe && cliProbe.cli && cliProbe.installed && cliProbe.authed) {
    const cliAgent = registeredAgents.find(a => a.type === 'cli' && a.id?.toLowerCase().includes(svc));
    const result = {
      route: 'cli',
      agentId: cliAgent?.id || `${svc}.agent`,
      reason: `CLI tool "${cliProbe.cli}" is installed and authenticated`,
      probes,
      createAgent: false,
    };
    logger.info?.(`[resolveRoute] ${svc}: route=cli — ${result.reason}`);
    return result;
  }

  // ── Priority 2: Desktop ──────────────────────────────────────────────────
  // Desktop app must be installed, AppleScript-capable, logged in, and TCC granted.
  if (desktopProbe && desktopProbe.installed && desktopProbe.applescriptSupported && desktopProbe.capability !== 'none') {
    // Check TCC permission
    if (tccProbe && !tccProbe.granted) {
      const result = {
        route: 'desktop_needs_tcc',
        agentId: null,
        reason: `Desktop app installed but macOS Automation permission not granted${tccProbe.needsPrompt ? ' (permission dialog may appear)' : ''}`,
        probes,
        createAgent: false,
      };
      logger.info?.(`[resolveRoute] ${svc}: route=desktop_needs_tcc — ${result.reason}`);
      return result;
    }

    // Check login state
    if (desktopProbe.loggedIn === false) {
      const result = {
        route: 'desktop_needs_login',
        agentId: null,
        reason: `Desktop app installed but user not logged in`,
        probes,
        createAgent: false,
      };
      logger.info?.(`[resolveRoute] ${svc}: route=desktop_needs_login — ${result.reason}`);
      return result;
    }

    // loggedIn === true OR loggedIn === null (unknown — proceed but may need login)
    const result = {
      route: 'desktop',
      agentId: null, // desktop route uses shell.run + osascript, no service agent
      reason: `Desktop app installed, AppleScript capable${desktopProbe.loggedIn === true ? ', logged in' : ' (login state unknown — proceeding)'}`,
      probes,
      createAgent: false,
    };
    logger.info?.(`[resolveRoute] ${svc}: route=desktop — ${result.reason}`);
    return result;
  }

  // ── Priority 3: Browser ──────────────────────────────────────────────────
  // Check for registered browser/app agent first, then browser-services registry.
  const browserAgent = registeredAgents.find(a =>
    (a.type === 'browser' || a.type === 'app') && a.id?.toLowerCase().includes(svc)
  );

  if (browserAgent) {
    const result = {
      route: 'browser',
      agentId: browserAgent.id,
      reason: `Registered browser agent: ${browserAgent.id}`,
      probes,
      createAgent: false,
    };
    logger.info?.(`[resolveRoute] ${svc}: route=browser — ${result.reason}`);
    return result;
  }

  if (browserSet.has(svc)) {
    const result = {
      route: 'browser',
      agentId: `${svc}.agent`,
      reason: `Service in browser-services registry — will create browser agent`,
      probes,
      createAgent: true,
    };
    logger.info?.(`[resolveRoute] ${svc}: route=browser (create) — ${result.reason}`);
    return result;
  }

  // ── Priority 4: Unknown ──────────────────────────────────────────────────
  const result = {
    route: 'unknown',
    agentId: null,
    reason: `No CLI, desktop app, or browser service found for "${svc}"`,
    probes,
    createAgent: false,
  };
  logger.info?.(`[resolveRoute] ${svc}: route=unknown — ${result.reason}`);
  return result;
}

module.exports = { resolveRoute, _loadBrowserServices };

'use strict';

/**
 * grill-me.test.js — Unit tests for Grill-Me Phase A (probes + route decision)
 *
 * Tests:
 *   1. probeDesktopApp — capability map loading, installed/not-installed, AppleScript support
 *   2. probeTCC — TCC permission probe (cached, non-darwin passthrough)
 *   3. resolveRoute — CLI > desktop > browser > unknown priority
 *   4. resolveRoute — desktop_needs_login / desktop_needs_tcc fallback states
 *   5. resolveRoute — browser agent creation when no desktop/CLI
 *
 * Run with: node stategraph-module/test/grill-me.test.js
 */

const path = require('path');

// ─── Minimal test harness ────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    _failed++;
    _failures.push({ label, err: err.message });
    console.log(`  ✗ ${label}`);
    console.log(`    → ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected "${expected}", got "${actual}"`);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('probeDesktopApp — capability map', () => {
  const { _loadCapabilityMap } = require('../src/utils/probeDesktopApp');

  it('loads desktop-capabilities.json with spotify entry', () => {
    const map = _loadCapabilityMap();
    assert(map.spotify, 'spotify entry missing');
    assertEqual(map.spotify.appName, 'Spotify', 'spotify appName');
    assert(map.spotify.applescript === true, 'spotify applescript should be true');
    assert(Array.isArray(map.spotify.verbs) && map.spotify.verbs.length > 0, 'spotify verbs array');
    assert(map.spotify.loginProbe, 'spotify loginProbe should be defined');
  });

  it('returns {} for unknown service', () => {
    const map = _loadCapabilityMap();
    assert(!map.nonexistent_service, 'unknown service should not be in map');
  });

  it('youtube has no desktop app (web-only)', () => {
    const map = _loadCapabilityMap();
    assert(map.youtube, 'youtube entry missing');
    assertEqual(map.youtube.appName, null, 'youtube appName');
    assert(map.youtube.applescript === false, 'youtube applescript should be false');
  });
});

describe('probeDesktopApp — main probe function', () => {
  const { probeDesktopApp } = require('../src/utils/probeDesktopApp');

  it('returns none for unknown service', async () => {
    const result = await probeDesktopApp('nonexistent_service');
    assertEqual(result.installed, false, 'installed');
    assertEqual(result.capability, 'none', 'capability');
    assertEqual(result.applescriptSupported, false, 'applescriptSupported');
  });

  it('returns none for web-only service (youtube)', async () => {
    const result = await probeDesktopApp('youtube');
    assertEqual(result.installed, false, 'installed');
    assertEqual(result.capability, 'none', 'capability');
    assertEqual(result.applescriptSupported, false, 'applescriptSupported');
  });
});

describe('probeTCC — TCC permission probe', () => {
  const { probeTCC, clearTCCCache } = require('../src/utils/probeTCC');

  it('returns an object with granted and needsPrompt fields', async () => {
    clearTCCCache();
    const result = await probeTCC();
    assert(typeof result.granted === 'boolean', 'granted should be boolean');
    assert(typeof result.needsPrompt === 'boolean', 'needsPrompt should be boolean');
    assert(typeof result.evidence === 'string', 'evidence should be string');
  });

  it('caches result on second call', async () => {
    const result1 = await probeTCC();
    const result2 = await probeTCC();
    assertEqual(result1.granted, result2.granted, 'cached granted matches');
  });

  it('clearTCCCache forces re-probe', async () => {
    const result1 = await probeTCC();
    clearTCCCache();
    const result2 = await probeTCC();
    // After clearing cache, it should still return a valid result
    assert(typeof result2.granted === 'boolean', 'granted after cache clear');
  });
});

describe('resolveRoute — CLI > desktop > browser > unknown priority', () => {
  const { resolveRoute } = require('../src/utils/resolveRoute');

  it('chooses CLI when installed + authed (priority 1)', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: true },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: { cli: 'spotify', installed: true, authed: true },
      registeredAgents: [{ id: 'spotify.agent', type: 'cli', authed: true }],
    });
    assertEqual(result.route, 'cli', 'route should be cli');
    assert(result.agentId, 'agentId should be set for CLI');
  });

  it('chooses desktop when CLI not available (priority 2)', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: true },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'desktop', 'route should be desktop');
    assertEqual(result.agentId, null, 'agentId should be null for desktop');
  });

  it('chooses browser when no CLI or desktop (priority 3)', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: false, capability: 'none', applescriptSupported: false, loggedIn: null },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [{ id: 'spotify.agent', type: 'browser', authed: false }],
    });
    assertEqual(result.route, 'browser', 'route should be browser');
    assertEqual(result.agentId, 'spotify.agent', 'agentId');
  });

  it('marks createAgent=true when browser service in registry but no registered agent', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: false, capability: 'none', applescriptSupported: false, loggedIn: null },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'browser', 'route should be browser');
    assertEqual(result.createAgent, true, 'createAgent should be true');
  });

  it('returns unknown when no routes available', () => {
    const result = resolveRoute({
      serviceName: 'totally_unknown_service_xyz',
      desktopProbe: null,
      tccProbe: null,
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'unknown', 'route should be unknown');
  });
});

describe('resolveRoute — desktop fallback states', () => {
  const { resolveRoute } = require('../src/utils/resolveRoute');

  it('returns desktop_needs_login when app installed but not logged in', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: false },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'desktop_needs_login', 'route');
  });

  it('returns desktop_needs_tcc when TCC not granted', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: true },
      tccProbe: { granted: false, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'desktop_needs_tcc', 'route');
  });

  it('falls through to browser when desktop not installed', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: false, capability: 'none', applescriptSupported: false, loggedIn: null },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'browser', 'route should fall through to browser');
    assertEqual(result.createAgent, true, 'createAgent');
  });

  it('proceeds with desktop when loggedIn is null (unknown)', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: null },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: null,
      registeredAgents: [],
    });
    assertEqual(result.route, 'desktop', 'route should be desktop (login unknown — proceeding)');
  });
});

describe('resolveRoute — CLI priority over desktop', () => {
  const { resolveRoute } = require('../src/utils/resolveRoute');

  it('CLI wins over desktop even when desktop is fully ready', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: true },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: { cli: 'spotify', installed: true, authed: true },
      registeredAgents: [
        { id: 'spotify.agent', type: 'cli', authed: true },
        { id: 'spotify.browser.agent', type: 'browser', authed: true },
      ],
    });
    assertEqual(result.route, 'cli', 'CLI should win over desktop');
  });

  it('falls to desktop when CLI exists but not authed', () => {
    const result = resolveRoute({
      serviceName: 'spotify',
      desktopProbe: { installed: true, capability: 'full', applescriptSupported: true, loggedIn: true },
      tccProbe: { granted: true, needsPrompt: false },
      cliProbe: { cli: 'spotify', installed: true, authed: false },
      registeredAgents: [],
    });
    assertEqual(result.route, 'desktop', 'should fall to desktop when CLI not authed');
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`  Tests: ${_passed} passed, ${_failed} failed`);
if (_failures.length > 0) {
  console.log('  Failures:');
  _failures.forEach(f => console.log(`    - ${f.label}: ${f.err}`));
}
console.log('═'.repeat(70));
process.exit(_failed > 0 ? 1 : 0);

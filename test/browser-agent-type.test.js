'use strict';
/**
 * browser-agent-type.test.js
 *
 * Unit tests for deriveAgentType() — the pure type-derivation function added
 * to fix gemini.agent (and all consumer AI apps) being built as type=api_key.
 *
 * Run with: node test/browser-agent-type.test.js
 *        or: yarn test:type
 */

// ── Load deriveAgentType ──────────────────────────────────────────────────────
let deriveAgentType;
let lookupBrowserService;

try {
  const mod = require('../../mcp-services/command-service/src/skills/browser.agent.cjs');
  if (typeof mod._deriveAgentType === 'function') {
    deriveAgentType = mod._deriveAgentType;
    // lookupBrowserService is not exported directly; reconstruct via KNOWN_BROWSER_SERVICES
    const { KNOWN_BROWSER_SERVICES } = mod;
    lookupBrowserService = (service) => {
      const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const entry = KNOWN_BROWSER_SERVICES[key];
      if (!entry) return null;
      if (!entry.capabilities) return { ...entry, capabilities: ['navigate', 'interact'] };
      return entry;
    };
    console.log('  [source] Using real _deriveAgentType export from browser.agent.cjs\n');
  } else {
    throw new Error('_deriveAgentType not exported');
  }
} catch (e) {
  // Inline reference — mirrors the implementation in browser.agent.cjs
  deriveAgentType = function deriveAgentType(meta) {
    if (meta?.type) return meta.type;
    if (meta?.isOAuth === true) return 'browser';
    const caps = Array.isArray(meta?.capabilities) ? meta.capabilities : [];
    if (caps.some(c => c === 'navigate' || c === 'interact')) return 'browser';
    return 'api_key';
  };
  lookupBrowserService = () => null; // seed map not available inline
  console.log(`  [source] Using inline reference (export not available: ${e.message})\n`);
}

// ── Minimal harness ───────────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}\n     ${e.message}`);
  }
}

function section(label) {
  console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`);
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeNull() {
      if (actual !== null)
        throw new Error(`Expected null but got "${actual}"`);
    },
    toNotBe(unexpected) {
      if (actual === unexpected)
        throw new Error(`Expected NOT "${unexpected}" but it was`);
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 1 — explicit type field wins (highest priority)
// ══════════════════════════════════════════════════════════════════════════════
section('1. Explicit type field wins over all other signals');

it('type:browser explicit → browser', () => {
  expect(deriveAgentType({ type: 'browser', isOAuth: false, capabilities: [] })).toBe('browser');
});

it('type:api_key explicit → api_key even if isOAuth:true', () => {
  expect(deriveAgentType({ type: 'api_key', isOAuth: true })).toBe('api_key');
});

it('type:api_key explicit → api_key even with navigate caps', () => {
  expect(deriveAgentType({ type: 'api_key', capabilities: ['navigate', 'interact'] })).toBe('api_key');
});

it('type:bearer explicit → bearer', () => {
  expect(deriveAgentType({ type: 'bearer' })).toBe('bearer');
});

it('type:basic explicit → basic', () => {
  expect(deriveAgentType({ type: 'basic' })).toBe('basic');
});

// ══════════════════════════════════════════════════════════════════════════════
//  Section 2 — isOAuth:true → browser (second priority)
// ══════════════════════════════════════════════════════════════════════════════
section('2. isOAuth:true → browser (second priority, no explicit type)');

it('isOAuth:true, no type, no caps → browser', () => {
  expect(deriveAgentType({ isOAuth: true })).toBe('browser');
});

it('isOAuth:true, no type, empty caps → browser', () => {
  expect(deriveAgentType({ isOAuth: true, capabilities: [] })).toBe('browser');
});

it('OAuth services: gmail-like entry → browser', () => {
  const gmailMeta = {
    startUrl: 'https://mail.google.com',
    signInUrl: 'https://accounts.google.com/signin/v2/identifier',
    authSuccessPattern: 'mail.google.com',
    isOAuth: true,
    capabilities: ['navigate', 'interact'],
  };
  expect(deriveAgentType(gmailMeta)).toBe('browser');
});

// ══════════════════════════════════════════════════════════════════════════════
//  Section 3 — navigate/interact capabilities → browser (third priority)
// ══════════════════════════════════════════════════════════════════════════════
section('3. navigate/interact capabilities → browser (third priority)');

it('isOAuth:false + caps:[navigate] → browser (THE BUG FIX)', () => {
  expect(deriveAgentType({ isOAuth: false, capabilities: ['navigate', 'interact'] })).toBe('browser');
});

it('isOAuth:false + caps:[interact] only → browser', () => {
  expect(deriveAgentType({ isOAuth: false, capabilities: ['interact'] })).toBe('browser');
});

it('isOAuth:false + caps:[navigate] only → browser', () => {
  expect(deriveAgentType({ isOAuth: false, capabilities: ['navigate'] })).toBe('browser');
});

it('no isOAuth field + caps:[navigate,interact] → browser', () => {
  expect(deriveAgentType({ capabilities: ['navigate', 'interact'] })).toBe('browser');
});

it('caps includes navigate among others → browser', () => {
  expect(deriveAgentType({ isOAuth: false, capabilities: ['read', 'navigate', 'write'] })).toBe('browser');
});

// ══════════════════════════════════════════════════════════════════════════════
//  Section 4 — default fallback: api_key
// ══════════════════════════════════════════════════════════════════════════════
section('4. Default fallback → api_key');

it('null meta → api_key', () => {
  expect(deriveAgentType(null)).toBe('api_key');
});

it('undefined meta → api_key', () => {
  expect(deriveAgentType(undefined)).toBe('api_key');
});

it('empty object meta → api_key', () => {
  expect(deriveAgentType({})).toBe('api_key');
});

it('isOAuth:false, no type, empty caps → api_key', () => {
  expect(deriveAgentType({ isOAuth: false, capabilities: [] })).toBe('api_key');
});

it('isOAuth:false, no type, no caps field → api_key', () => {
  expect(deriveAgentType({ isOAuth: false })).toBe('api_key');
});

it('pure REST platform with empty caps → api_key (correct for API consoles using curl)', () => {
  // e.g. a service meta resolved with caps=[] from an API-only service
  expect(deriveAgentType({ isOAuth: false, capabilities: [] })).toBe('api_key');
});

// ══════════════════════════════════════════════════════════════════════════════
//  Section 5 — Level 10 regression: consumer AI apps must be browser
// ══════════════════════════════════════════════════════════════════════════════
section('5. Level 10 regression — consumer AI chat apps must be type=browser');

const consumerAppServices = ['gemini', 'geminiai', 'googleai', 'chatgpt', 'claude'];

for (const svcKey of consumerAppServices) {
  it(`lookupBrowserService("${svcKey}") + deriveAgentType → browser`, () => {
    if (!lookupBrowserService) {
      throw new Error('lookupBrowserService not available — run with real export');
    }
    const meta = lookupBrowserService(svcKey);
    if (meta === null) {
      throw new Error(`"${svcKey}" not found in KNOWN_BROWSER_SERVICES`);
    }
    const result = deriveAgentType(meta);
    if (result !== 'browser') {
      throw new Error(
        `"${svcKey}" should be browser but deriveAgentType returned "${result}"` +
        ` (meta.type=${meta.type}, meta.isOAuth=${meta.isOAuth}, caps=${JSON.stringify(meta.capabilities)})`
      );
    }
  });
}

it('gemini seed meta has capabilities injected by lookupBrowserService', () => {
  if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
  const meta = lookupBrowserService('gemini');
  if (meta === null) throw new Error('"gemini" not found in seed map');
  const caps = meta.capabilities;
  if (!Array.isArray(caps) || caps.length === 0)
    throw new Error(`Expected capabilities array but got: ${JSON.stringify(caps)}`);
  if (!caps.some(c => c === 'navigate' || c === 'interact'))
    throw new Error(`Expected navigate/interact in caps but got: ${JSON.stringify(caps)}`);
});

it('googleai is the canonical service alias for gemini.google.com', () => {
  if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
  const meta = lookupBrowserService('googleai');
  if (meta === null) throw new Error('"googleai" not found in seed map');
  if (!meta.startUrl.includes('gemini.google.com'))
    throw new Error(`Expected startUrl to include gemini.google.com but got: ${meta.startUrl}`);
  expect(deriveAgentType(meta)).toBe('browser');
});

// ══════════════════════════════════════════════════════════════════════════════
//  Section 6 — additional consumer AI apps
// ══════════════════════════════════════════════════════════════════════════════
section('6. Additional consumer AI app aliases → browser');

const additionalApps = [
  'grok', 'copilotmsft', 'deepseekchat', 'mistralchat', 'qwen', 'perplexitychat',
];

for (const svcKey of additionalApps) {
  it(`lookupBrowserService("${svcKey}") → browser`, () => {
    if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
    const meta = lookupBrowserService(svcKey);
    if (meta === null) throw new Error(`"${svcKey}" not found in KNOWN_BROWSER_SERVICES`);
    const result = deriveAgentType(meta);
    if (result !== 'browser') {
      throw new Error(
        `"${svcKey}" should be browser but got "${result}"` +
        ` (meta.type=${meta.type}, meta.isOAuth=${meta.isOAuth}, caps=${JSON.stringify(meta.capabilities)})`
      );
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 7 — self-heal detection: stale api_key entries for browser services
// ══════════════════════════════════════════════════════════════════════════════
section('7. Self-heal detection — stale api_key entries for known browser services');

it('gemini stored as api_key → self-heal should trigger (deriveAgentType returns browser)', () => {
  if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
  // Simulates what actionRun self-heal checks:
  const storedType  = 'api_key';          // stale entry in DuckDB
  const svcKey      = 'gemini';
  const seedMeta    = lookupBrowserService(svcKey);
  const expectedType = deriveAgentType(seedMeta);

  // Self-heal condition: stored=api_key but expected=browser
  const shouldSelfHeal = storedType === 'api_key' && expectedType === 'browser';
  if (!shouldSelfHeal)
    throw new Error(`Expected self-heal to trigger but: expectedType=${expectedType}`);
});

it('googleai stored as api_key → self-heal should trigger', () => {
  if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
  const svcKey = 'googleai';
  const seedMeta = lookupBrowserService(svcKey);
  expect(deriveAgentType(seedMeta)).toBe('browser');
});

it('unknown service (not in seed map) → no self-heal (seedMeta is null)', () => {
  if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
  // An unknown service has no seed entry — self-heal should NOT trigger blindly
  const seedMeta = lookupBrowserService('some_unknown_service_xyz');
  if (seedMeta !== null)
    throw new Error('Expected null for unknown service');
  // self-heal condition: seedMeta !== null → false → does not trigger ✓
});

it('chatgpt stored as api_key → self-heal should trigger', () => {
  if (!lookupBrowserService) throw new Error('lookupBrowserService not available');
  const svcKey = 'chatgpt';
  const seedMeta = lookupBrowserService(svcKey);
  const expectedType = deriveAgentType(seedMeta);
  if (expectedType !== 'browser')
    throw new Error(`chatgpt should be browser but got "${expectedType}"`);
  // self-heal: storedType=api_key, expectedType=browser → should rebuild ✓
});

// ══════════════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`  Results: ${_passed} passed, ${_failed} failed`);
if (_failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of _failures) console.log(`    ❌ ${f.label}\n       ${f.error}`);
}
console.log(`${'═'.repeat(72)}\n`);
process.exit(_failed > 0 ? 1 : 0);

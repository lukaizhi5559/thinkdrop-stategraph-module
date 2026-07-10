'use strict';
/**
 * destination-resolver.test.js
 *
 * Regression tests for the intent classifier and URL type classifier in
 * mcp-services/command-service/src/skill-helpers/destination-resolver.cjs.
 *
 * Run from repo root or stategraph-module with:
 *   node stategraph-module/test/destination-resolver.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_LLM_PATH = path.join(REPO_ROOT, 'mcp-services/command-service/src/skill-helpers/skill-llm.cjs');
const DEST_RESOLVER_PATH = path.join(REPO_ROOT, 'mcp-services/command-service/src/skill-helpers/destination-resolver.cjs');

// Mock skill-llm so the public classifier falls back to the deterministic
// regex patterns. This keeps the test fast and independent of LLM availability.
require.cache[SKILL_LLM_PATH] = {
  id: SKILL_LLM_PATH,
  filename: SKILL_LLM_PATH,
  loaded: true,
  exports: {
    ask: async () => 'invalid-intent',
  },
};

// Clear destination-resolver so it picks up the mocked skill-llm.
for (const key of Object.keys(require.cache)) {
  if (key === DEST_RESOLVER_PATH) {
    delete require.cache[key];
  }
}

const destinationResolver = require(DEST_RESOLVER_PATH);
const { classifyTaskIntent, classifyUrlType, INTENTS } = destinationResolver;

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'destination-resolver.intents.json'), 'utf8'));

let _passed = 0;
let _failed = 0;
const _failures = [];

async function it(label, fn) {
  try {
    await fn();
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

async function runTests() {
  section('Intent classification (regex fallback)');
  for (const [intent, phrases] of Object.entries(fixture.classifyTaskIntent)) {
    for (const phrase of phrases) {
      await it(`"${phrase}" → ${intent}`, async () => {
        const result = await classifyTaskIntent(phrase);
        if (result !== intent) {
          throw new Error(`Expected "${intent}" but got "${result}"`);
        }
      });
    }
  }

  section('Intent negative classification (regex fallback)');
  for (const [wrongIntent, phrases] of Object.entries(fixture.classifyTaskIntentNegative)) {
    for (const phrase of phrases) {
      await it(`"${phrase}" is NOT ${wrongIntent}`, async () => {
        const result = await classifyTaskIntent(phrase);
        if (result === wrongIntent) {
          throw new Error(`Expected anything except "${wrongIntent}" but got "${result}"`);
        }
      });
    }
  }

  section('URL type classification');
  for (const [urlType, urls] of Object.entries(fixture.classifyUrlType)) {
    for (const url of urls) {
      await it(`"${url}" → ${urlType}`, () => {
        const result = classifyUrlType(url);
        if (result !== urlType) {
          throw new Error(`Expected "${urlType}" but got "${result}"`);
        }
      });
    }
  }

  await it('exports all 16 intent constants', () => {
    const expected = [
      'chat', 'research', 'search', 'docs', 'console', 'settings', 'mail',
      'social', 'commerce', 'content_create', 'scheduling', 'maps', 'download',
      'support', 'dashboard', 'home',
    ];
    const values = Object.values(INTENTS);
    for (const v of expected) {
      if (!values.includes(v)) {
        throw new Error(`Missing intent "${v}"`);
      }
    }
  });

  console.log(`\n${'─'.repeat(72)}`);
  if (_failed === 0) {
    console.log(`✅ All ${_passed} tests passed.`);
  } else {
    console.log(`❌ ${_passed} passed, ${_failed} failed.`);
    for (const f of _failures) {
      console.log(`   - ${f.label}: ${f.error}`);
    }
    process.exitCode = 1;
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exitCode = 1;
});

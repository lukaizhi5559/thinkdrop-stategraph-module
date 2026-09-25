'use strict';
/**
 * run-all.js — curated hermetic test suite runner
 *
 * Runs every test file that is self-contained (scripted mocks, no live
 * services, no cross-repo imports) and reports per-file + total results.
 * Exits non-zero if any file fails.
 *
 * Deliberately EXCLUDED:
 *   - intent-classifier.test.js    — stale intent taxonomy expectations
 *   - parse-skill.test.js          — requires live MCP skill services
 *   - preflightAgents.test.js      — env-dependent (credential callbacks, auth state)
 *   - destination-resolver.test.js — 1 stale expectation ("google cheap flights")
 *   - browser-count-grounding.manual.js — imports command-service skill internals
 *     (skill-db opens a handle; the process never exits)
 *   - *.bench.js / gen-*.py        — benchmarks & fixtures, not tests
 *
 * Run with: node test/run-all.js   (or: npm test)
 */

const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  'clarify-gate.test.js',
  'golden-journeys.test.js',
  'recall-context.test.js',
  'continue-thread-context.test.js',
  'follow-up-correction.test.js',
  'media-search-guard.test.js',
  'state-patterns.test.js',
  'resolve-user-context.test.js',
  'grill-me.test.js',
  'public-web-routing.test.js',
  'read-extraction-classification.test.js',
  'url-first-regression.test.js',
  'gmail-compose-url-regression.test.js',
  'plan-helpers.test.js',
  'resolveAgent.test.js',
  'active-doc-routing.test.js',
  'phase2-multiintent.test.js',
  'stage-c-stability.test.js',
  'route-table.test.js',
  'engine-execute.test.js',
  'phase3-longrunning.test.js',
  'tab-flow-tab-map.test.js',
  'lint-synthesize-ordering.test.js',
  'reviewExecution.test.js',
  'reliability.test.js',
  'unit.test.js',
];

let pass = 0, fail = 0;
const failedFiles = [];

for (const file of TESTS) {
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    env: { ...process.env, TZ: 'UTC' },
    stdio: 'pipe',
    timeout: 120000,
    encoding: 'utf8',
  });
  const ok = res.status === 0 && !res.error;
  if (ok) { pass++; console.log(`  ✅ ${file}`); }
  else {
    fail++;
    failedFiles.push(file);
    console.log(`  ❌ ${file}${res.error ? ` (${res.error.message})` : ` (exit ${res.status})`}`);
    const tail = (res.stderr || res.stdout || '').split('\n').filter(l => /❌|FAIL|Error/.test(l)).slice(0, 5);
    tail.forEach(l => console.log(`       ${l.trim()}`));
  }
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Files: ${pass} passed, ${fail} failed (${TESTS.length} total)`);
if (failedFiles.length) console.log(`  Failing: ${failedFiles.join(', ')}`);
console.log('═'.repeat(60));
process.exit(fail ? 1 : 0);

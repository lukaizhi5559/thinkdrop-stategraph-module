'use strict';

// Regression tests for planHelpers.parsePlan structural normalization:
// the planner can emit `[{},[{s},{s}]]` (empty object + nested array) — those
// used to reach execution as "undefined" steps and die on "skill is required".

const { parsePlan } = require('../src/utils/planHelpers');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {} };

const STEP_A = { skill: 'edit.agent', args: { goal: 'fix', filePath: '/tmp/a.md' }, description: 'edit' };
const STEP_B = { skill: 'synthesize', args: { prompt: 'confirm' }, description: 'confirm' };

console.log('\n--- nested/empty normalization ---');
let r = parsePlan(JSON.stringify([{}, [STEP_A, STEP_B]]), logger);
check('empty obj + nested array → 2 real steps', Array.isArray(r) && r.length === 2 && r[0].skill === 'edit.agent' && r[1].skill === 'synthesize', JSON.stringify(r));

r = parsePlan(JSON.stringify([STEP_A, {}]), logger);
check('trailing {} dropped → 1 step', Array.isArray(r) && r.length === 1 && r[0].skill === 'edit.agent', JSON.stringify(r));

r = parsePlan(JSON.stringify([[STEP_A, STEP_B]]), logger);
check('fully nested array → flattened to 2 steps', Array.isArray(r) && r.length === 2, JSON.stringify(r));

r = parsePlan(JSON.stringify([STEP_A, 42, 'oops', null, [STEP_B]]), logger);
check('junk entries dropped → 2 steps', Array.isArray(r) && r.length === 2, JSON.stringify(r));

console.log('\n--- all-invalid → null (triggers plan retry) ---');
r = parsePlan(JSON.stringify([{}]), logger);
check('only {} → null', r === null, JSON.stringify(r));

r = parsePlan(JSON.stringify([42, 'x', null]), logger);
check('only junk → null', r === null, JSON.stringify(r));

r = parsePlan(JSON.stringify([{ description: 'no skill field' }]), logger);
check('object without skill → null', r === null, JSON.stringify(r));

console.log('\n--- valid plans untouched ---');
r = parsePlan(JSON.stringify([STEP_A]), logger);
check('normal 1-step plan passes', Array.isArray(r) && r.length === 1 && r[0].skill === 'edit.agent');

r = parsePlan('```json\n' + JSON.stringify([STEP_A, STEP_B]) + '\n```', logger);
check('fenced JSON still parses', Array.isArray(r) && r.length === 2);

r = parsePlan(JSON.stringify({ steps: [STEP_A] }), logger);
check('{"steps":[...]} wrapper unwraps', Array.isArray(r) && r.length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
process.exit(failed ? 1 : 0);

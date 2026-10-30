'use strict';
/**
 * step-failure-recovery.test.js — regression tests for step-failure routing.
 *
 * 1. flagStepFailure defaults to 'replan_step' (single-step, 626ms path) not
 *    full 'replan' (54KB prompt, observed 147s) — a failed step is localized.
 * 2. executeCommand skip/superseded path no longer TDZ-crashes on
 *    `stepContracts` (const hoisted above the early return).
 *
 * Run from repo root: node stategraph-module/test/step-failure-recovery.test.js
 */

const path = require('path');
const flagStepFailure = require(path.resolve(__dirname, '../src/nodes/flagStepFailure.js'));
const executeCommand  = require(path.resolve(__dirname, '../src/nodes/executeCommand.js'));

let passed = 0, failed = 0;
async function it(label, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${label}`); }
  catch (e) { failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'expected'} '${b}' got '${a}'`); }

const _mcpStub = { callService: async () => ({ ok: true }) };
const _silentLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

(async () => {
  console.log('\nstep-failure recovery routing\n');

  await it('flagStepFailure defaults to replan_step (not full replan)', async () => {
    const out = await flagStepFailure({
      logger: _silentLog,
      failedStep: { skill: 'turn.loop.agent', error: 'turn_loop_exhausted' },
      skillResults: [{ step: 1, skill: 'url.first.agent', ok: true, stdout: 'nav ok' }],
    });
    eq(out.recoveryAction, 'replan_step', 'recoveryAction');
    ok(out.recoveryContext, 'recoveryContext present');
    eq(out.recoveryContext.failedSkill, 'turn.loop.agent', 'failedSkill');
    ok(out.recoveryContext.failedStep, 'failedStep carried for generateSingleStep');
    eq(out.recoveryContext.succeededSteps.length, 1, 'succeededSteps summarized');
  });

  await it('executeCommand skipped step does not TDZ-crash on stepContracts', async () => {
    const state = {
      logger: _silentLog,
      intent: { type: 'command_automate' },
      mcpAdapter: _mcpStub,
      skillPlan: [
        { skill: 'dom.act', args: { goal: 'click' }, skipped: true, skipReason: 'superseded by replan' },
      ],
      skillCursor: 0,
      skillResults: [],
      // NOTE: stepContracts intentionally absent — the late `const` left the
      // skip path in a TDZ before the hoist fix.
    };
    const out = await executeCommand(state);
    ok(out, 'returned state');
    eq(out.skillCursor, 1, 'cursor advanced past skipped step');
    ok(Array.isArray(out.stepContracts), 'stepContracts written');
    eq(out.stepContracts.length, 1, 'one contract for the skipped step');
    ok(out.skillResults[0].skipped, 'result marked skipped');
    ok(out.skillResults[0].ok, 'skipped result ok');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('suite error:', e); process.exit(1); });

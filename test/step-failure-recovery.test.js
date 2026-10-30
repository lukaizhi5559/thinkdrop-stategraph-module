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

  // ── step_recovering emission ──────────────────────────────────────────────
  // The wrapper around _thinPostFailureHandlerImpl emits step_recovering once
  // per chosen recovery path so the renderer shows "trying another way"
  // instead of a pinned red failure (observed: a commit run sat all-red while
  // cli.agent was actively fixing each step).

  const _failState = (over) => ({
    logger: _silentLog,
    intent: { type: 'command_automate' },
    mcpAdapter: _mcpStub,
    skillPlan: [
      { skill: 'form.fill.agent', args: {}, description: 'Fill the form' },
      { skill: 'synthesize', args: { prompt: 'answer' }, description: 'Answer' },
    ],
    skillCursor: 0,
    skillResults: [],
    patchHistory: [],
    ...over,
  });

  await it('missing-information → step_recovering (replan_step)', async () => {
    const events = [];
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: e => events.push(e),
      failedStep: { step: 1, skill: 'form.fill.agent', description: 'Fill the form',
        reason: 'missing-information', missingInputs: [{ field: 'email', label: 'email' }],
        error: 'missing email' },
    }));
    eq(out.recoveryAction, 'replan_step', 'impl chose replan_step');
    const evt = events.filter(e => e.type === 'step_recovering');
    eq(evt.length, 1, 'exactly one step_recovering');
    eq(evt[0].action, 'replan_step', 'event action');
    eq(evt[0].skill, 'form.fill.agent', 'event carries failed skill');
    eq(evt[0].stepIndex, 0, 'event stepIndex = skillCursor');
    ok(/missing email/.test(evt[0].error), 'event carries original error');
  });

  await it('missing-information on a plan task → step_recovering (replan) + plan mirror', async () => {
    const events = [];
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: e => events.push(e),
      _planId: 'plan_test',
      _skillPlanFile: '/tmp/plan.md',
      failedStep: { step: 1, skill: 'form.fill.agent', description: 'Fill the form',
        reason: 'missing-information', missingInputs: [{ field: 'email' }],
        error: 'missing email' },
    }));
    ok(out._planUpdate, 'plan_update returned');
    const evt = events.filter(e => e.type === 'step_recovering');
    eq(evt.length, 1, 'one step_recovering');
    eq(evt[0].action, 'replan', 'plan_update surfaces as replan');
    ok(/missing-information/.test(evt[0].note), 'note carries the plan-update reason');
    eq(events.filter(e => e.type === 'plan:step_recovering').length, 1, 'plan: mirror emitted for authored plans');
  });

  await it('internal executor error → step_recovering (ask_user, needsUser)', async () => {
    const events = [];
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: e => events.push(e),
      failedStep: { step: 1, skill: 'shell.run', description: 'Run git',
        error: 'ReferenceError: foo is not defined', _internalError: true },
    }));
    eq(out.recoveryAction, 'ask_user', 'internal error asks the user');
    const evt = events.filter(e => e.type === 'step_recovering');
    eq(evt.length, 1, 'one step_recovering');
    eq(evt[0].action, 'ask_user', 'ask_user action surfaced');
    eq(evt[0].needsUser, true, 'needsUser flag set');
  });

  await it('auto-skip emits step_skipped — never a phantom step_recovering', async () => {
    const events = [];
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: e => events.push(e),
      skillPlan: [
        { skill: 'fs.read', args: { path: '/x' }, description: 'Read file' },
        { skill: 'synthesize', args: { prompt: 'answer' }, description: 'Answer' },
      ],
      failedStep: { step: 1, skill: 'fs.read', description: 'Read file', error: 'ENOENT' },
    }));
    eq(out.skillCursor, 1, 'auto-skip advanced the cursor');
    eq(events.filter(e => e.type === 'step_skipped').length, 1, 'step_skipped emitted by the skip path itself');
    eq(events.filter(e => e.type === 'step_recovering').length, 0, 'no step_recovering on top of the skip');
  });

  // ── missing-path gate ────────────────────────────────────────────────────
  // Dispatch-time verification fails steps with reason:'missing-path' — the
  // gate must route to grounded replan (or plan_update/ask_user), never to a
  // generic cli.agent "does not exist" loop.

  await it('missing-path → step_recovering (replan_step, path named)', async () => {
    const events = [];
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: e => events.push(e),
      failedStep: { step: 1, skill: 'shell.run', description: 'Commit repo',
        reason: 'missing-path', missingPaths: ['/Users/x/skill-runtime'],
        error: 'path does not exist: /Users/x/skill-runtime' },
    }));
    eq(out.recoveryAction, 'replan_step', 'impl chose replan_step');
    ok(/skill-runtime/.test(out.recoveryContext.failureReason), 'failureReason names the missing path');
    const evt = events.filter(e => e.type === 'step_recovering');
    eq(evt.length, 1, 'one step_recovering');
    eq(evt[0].action, 'replan_step', 'event action');
  });

  await it('missing-path on a plan task → plan_update loop-back', async () => {
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: () => {},
      _planId: 'plan_test',
      _skillPlanFile: '/tmp/plan.md',
      failedStep: { step: 1, skill: 'shell.run', description: 'Commit repo',
        reason: 'missing-path', missingPaths: ['/Users/x/execution-planner'],
        error: 'path does not exist: /Users/x/execution-planner' },
    }));
    ok(out._planUpdate, 'plan_update returned');
    ok(/execution-planner/.test(out._planUpdate.reason), 'plan_update reason names the path');
    eq(out._planUpdate.planId, 'plan_test', 'planId carried');
  });

  await it('missing-path repeat signature → ask_user (no endless replan)', async () => {
    const _err = 'path does not exist: /Users/x/skill-runtime';
    const _sig = `shell.run::${_err}`;
    const out = await executeCommand._thinPostFailureHandler(_failState({
      progressCallback: () => {},
      patchHistory: [{ action: 'MISSING_PATH', sig: _sig, attempt: 1 }],
      failedStep: { step: 1, skill: 'shell.run', description: 'Commit repo',
        reason: 'missing-path', missingPaths: ['/Users/x/skill-runtime'],
        error: _err },
    }));
    eq(out.recoveryAction, 'ask_user', 'repeat sig escalates to ask_user');
    ok(/skill-runtime/.test(out.pendingQuestion.question), 'question names the path');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('suite error:', e); process.exit(1); });

'use strict';

// Regression: commit d71dc6f dropped the `_normalizedResult` declaration while
// retiring external.skill but left three references in the post-dispatch tail
// (captureAs, generateStepContract, completion triggers). Every normally-
// executed step threw `ReferenceError: _normalizedResult is not defined` —
// the skill call had already succeeded, so work was done but reported failed,
// and recovery burned cli.agent loops re-executing completed mutations.
//
//   1. A successful shell.run step must record ok:true (exercises the tail).
//   2. An ok result carrying `output` but no `stdout` (recipe.run shape) gets
//      the output→stdout mirror so synthesize sees real output.
//   3. A step flagged _internalError (JS engine error from the executor, not
//      the skill) goes straight to ask_user — no cli.agent substitution, no
//      replan: code defects can't be repaired by re-execution.

const path = require('path');
const executeCommand = require('../src/nodes/executeCommand');
const { _thinPostFailureHandler } = executeCommand;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function mcpStub(payload) {
  return { callService: async () => payload };
}

async function run() {
  // ── 1. Successful shell.run step records ok:true (ReferenceError path) ────
  {
    const state = {
      intent: { type: 'command_automate' },
      mcpAdapter: mcpStub({ ok: true, stdout: 'created', exitCode: 0 }),
      skillPlan: [{ skill: 'shell.run', args: { cmd: 'mkdir', argv: ['-p', '/tmp/x'] }, description: 'Create dir' }],
      skillCursor: 0,
      skillResults: [],
      message: 'create the dir',
      logger,
    };
    const out = await executeCommand(state);
    const r = (out.skillResults || [])[0] || {};
    check('step result recorded', !!r);
    check('step result ok:true (no _normalizedResult crash)', r.ok === true, JSON.stringify(r.error || ''));
    check('stdout preserved', r.stdout === 'created', r.stdout);
  }

  // ── 2. output-only ok result (recipe.run shape) mirrors into stdout ───────
  {
    const state = {
      intent: { type: 'command_automate' },
      mcpAdapter: mcpStub({ ok: true, output: 'Completed 3 waypoints', exitCode: 0 }),
      skillPlan: [{ skill: 'recipe.run', args: { name: 'demo' }, description: 'Run recipe' }],
      skillCursor: 0,
      skillResults: [],
      message: 'run the recipe',
      logger,
    };
    const out = await executeCommand(state);
    const r = (out.skillResults || [])[0] || {};
    check('recipe result ok:true', r.ok === true, JSON.stringify(r.error || ''));
    check('output mirrored to stdout', r.stdout === 'Completed 3 waypoints', JSON.stringify(r.stdout));
  }

  // ── 3. _internalError → ask_user, no escalation, no replan ────────────────
  {
    const state = {
      failedStep: {
        skill: 'shell.run',
        args: { cmd: 'bash', argv: ['-c', 'mkdir -p ~/ws'] },
        error: '_normalizedResult is not defined',
        description: 'Create the workspace directory',
        _internalError: true,
      },
      skillPlan: [{ skill: 'shell.run', args: {}, description: 'Create the workspace directory' }],
      skillCursor: 0,
      patchHistory: [],
      message: 'scaffold the workspace',
      logger,
    };
    const out = await _thinPostFailureHandler(state);
    check('internal error → ask_user', out.recoveryAction === 'ask_user', out.recoveryAction);
    check('INTERNAL_ERROR patch recorded', (out.patchHistory || []).some(p => p.action === 'INTERNAL_ERROR'));
    check('question names the defect', /runtime error|defect/i.test(out.pendingQuestion?.question || ''));
    check('plan NOT rewritten to cli.agent', out.skillPlan?.[0]?.skill === 'shell.run', out.skillPlan?.[0]?.skill);
    check('no replan', !out.recoveryContext && out.recoveryAction !== 'replan_step');
  }

  // ── 4. Ordinary step failure still reaches the normal recovery paths ──────
  {
    const state = {
      failedStep: {
        skill: 'fs.read',
        args: { action: 'read', path: '/x' },
        error: 'ENOENT: no such file',
        description: 'Read the file',
      },
      skillPlan: [{ skill: 'fs.read', args: {} }, { skill: 'synthesize', args: {} }],
      skillCursor: 0,
      patchHistory: [],
      message: 'read the file',
      logger,
    };
    const out = await _thinPostFailureHandler(state);
    check('non-internal failure does not take INTERNAL_ERROR path',
      !(out.patchHistory || []).some(p => p.action === 'INTERNAL_ERROR'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });

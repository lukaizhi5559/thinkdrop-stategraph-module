'use strict';

// Regression: a sandbox-denied write to an attached file must reroute to
// edit.agent BEFORE the universal cli.agent fallbacks get the step — and the
// cli.agent patches must carry protectedPaths so the seatbelt survives the
// substitution. Previously TERMINAL_DEBUG ran first, replayed the write in an
// unseatbelted PTY, and appended bytes past an RTF's closing brace.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _thinPostFailureHandler } = require('../src/nodes/executeCommand');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

// getProtectedPaths resolves via realpathSync — the attachment must exist.
const ATTACHED = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-')), 'kids-appts.rtf');
fs.writeFileSync(ATTACHED, '{\\rtf1 hi}');
const MSG = `[File: ${ATTACHED}]\n\nadd the following to this file. Wife appt nov 11th 8:45am`;
const hasPath = (list) => Array.isArray(list) && list.some(p => String(p.resolved || p.original || p).includes('kids-appts.rtf'));

async function run() {
  // ── 1. Denied content-write → edit.agent, before any cli.agent fallback ──
  {
    const state = {
      failedStep: {
        skill: 'shell.run',
        args: { cmd: 'bash', argv: ['-c', `printf '%s' x | base64 -d >> '${ATTACHED}'`] },
        error: `sandbox-exec: deny file-write* ${ATTACHED} (EPERM)`,
        description: `Append to ${ATTACHED}`,
        _sandboxDeniedPath: ATTACHED,
        sandboxed: true,
      },
      skillPlan: [{ skill: 'shell.run', args: {}, description: `Append to ${ATTACHED}` }],
      skillCursor: 0,
      patchHistory: [],
      message: MSG,
      logger,
      // NO llmBackend — proves the reroute precedes the "no LLM" ask_user exit.
    };
    const out = await _thinPostFailureHandler(state);
    check('denied write → auto_patch', out.recoveryAction === 'auto_patch', out.recoveryAction);
    check('step rerouted to edit.agent', out.skillPlan[0].skill === 'edit.agent', out.skillPlan[0].skill);
    check('edit.agent targets the denied path', out.skillPlan[0].args.filePath === ATTACHED);
    check('goal carries the step intent', /append/i.test(out.skillPlan[0].args.goal || ''), out.skillPlan[0].args.goal);
    check('patch recorded once-per-cursor', out.patchHistory.some(p => p.action === 'SANDBOX_REROUTE' && p.cursor === 0));
  }

  // ── 2. Denied non-write op (mv) → NOT edit.agent — honest recovery ────────
  {
    const state = {
      failedStep: {
        skill: 'shell.run',
        args: { cmd: 'bash', argv: ['-c', `mv '${ATTACHED}' /tmp/moved.rtf`] },
        error: `sandbox-exec: deny file-write* ${ATTACHED} (EPERM)`,
        description: `Move ${ATTACHED}`,
        _sandboxDeniedPath: ATTACHED,
        sandboxed: true,
      },
      skillPlan: [{ skill: 'shell.run', args: {}, description: `Move ${ATTACHED}` }],
      skillCursor: 0,
      patchHistory: [],
      message: MSG,
      logger,
    };
    const out = await _thinPostFailureHandler(state);
    check('denied mv not substituted to edit.agent', !(out.skillPlan || [])[0] || out.skillPlan[0].skill !== 'edit.agent', out.skillPlan?.[0]?.skill);
    check('no SANDBOX_REROUTE patch recorded', !(out.patchHistory || []).some(p => p.action === 'SANDBOX_REROUTE'));
  }

  // ── 3. Second denial on same cursor → falls through (no infinite loop) ────
  {
    const state = {
      failedStep: {
        skill: 'shell.run',
        args: { cmd: 'bash', argv: ['-c', `cat x >> '${ATTACHED}'`] },
        error: 'EPERM',
        description: `Append to ${ATTACHED}`,
        _sandboxDeniedPath: ATTACHED,
      },
      skillPlan: [{ skill: 'shell.run', args: {} }],
      skillCursor: 0,
      patchHistory: [{ action: 'SANDBOX_REROUTE', cursor: 0, note: 'edit.agent', attempt: 1 }],
      message: MSG,
      logger,
    };
    const out = await _thinPostFailureHandler(state);
    check('repeat denial does not re-reroute', !(out.skillPlan || [])[0] || out.skillPlan[0].skill !== 'edit.agent', out.skillPlan?.[0]?.skill);
  }

  // ── 4. TERMINAL_DEBUG patch carries protectedPaths ─────────────────────────
  {
    const state = {
      failedStep: { skill: 'fs.read', args: { action: 'read', path: '/x' }, error: 'ENOENT', description: 'Read the file' },
      skillPlan: [{ skill: 'fs.read', args: {} }],
      skillCursor: 0,
      patchHistory: [],
      message: MSG,
      logger,
    };
    const out = await _thinPostFailureHandler(state);
    check('fs.read failure → cli.agent run loop', out.skillPlan?.[0]?.skill === 'cli.agent', out.skillPlan?.[0]?.skill);
    check('cli.agent args carry protectedPaths',
      hasPath(out.skillPlan?.[0]?.args?.protectedPaths),
      JSON.stringify(out.skillPlan?.[0]?.args?.protectedPaths));
  }

  // ── 5. AGENT_ESCALATE (install-shaped) patch carries protectedPaths ────────
  {
    const state = {
      failedStep: {
        skill: 'shell.run',
        args: { cmd: 'npm', argv: ['install', '-g', 'foo-cli'] },
        error: 'E404 not found',
        description: 'Install foo-cli',
      },
      skillPlan: [{ skill: 'shell.run', args: {} }],
      skillCursor: 0,
      patchHistory: [],
      message: MSG,
      logger,
    };
    const out = await _thinPostFailureHandler(state);
    check('install failure → cli.agent', out.skillPlan?.[0]?.skill === 'cli.agent', out.skillPlan?.[0]?.skill);
    check('escalated args carry protectedPaths', hasPath(out.skillPlan?.[0]?.args?.protectedPaths),
      JSON.stringify(out.skillPlan?.[0]?.args?.protectedPaths));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });

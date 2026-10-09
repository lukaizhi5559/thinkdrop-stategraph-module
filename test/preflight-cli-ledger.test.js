'use strict';

// preflightAgents CLI-ledger consult — the observed failure: `nylas auth
// status` proved auth but the CLI probe couldn't run it (verifyCmd
// undiscovered → 'no_auth_check'), so preflight parked the task
// auth-required forever even though the ledger already said authed:true.
//
// Invariants under test (newest-evidence-wins):
//   1. ledger authed:true + inconclusive probe ⇒ trusted (authed)
//   2. ledger authed:false / lastAuthFailedAt newer ⇒ failed wins
//   3. markAgentAuthed after a failure flips back to authed
//   4. markAgentAuthFailed after a success flips to failed
//   5. no ledger entry ⇒ neither authed nor failed

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-auth-ledger-'));
process.env.THINKDROP_PREFLIGHT_AUTH_CACHE = path.join(TMP, 'preflight-auth-cache.json');

const preflight = require('../src/nodes/preflightAgents.js');
const { _cliLedgerAuth, markAgentAuthed, markAgentAuthFailed, _getLedgerAuth } = preflight;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

// 1. Ledger authed:true (the nylas case) → trusted.
markAgentAuthed('nylas.agent');
{
  const r = _cliLedgerAuth('nylas.agent');
  check('ledger authed:true → trusted', r.authed === true && r.failed === false,
    JSON.stringify(r));
}

// 2. A later failure invalidates it.
markAgentAuthFailed('nylas.agent', 'preflight probe: not_authenticated');
{
  const r = _cliLedgerAuth('nylas.agent');
  check('failure after success → failed wins', r.authed === false && r.failed === true,
    JSON.stringify(r));
}

// 3. Newer success supersedes older failure.
markAgentAuthed('nylas.agent');
{
  const r = _cliLedgerAuth('nylas.agent');
  check('success after failure → authed wins', r.authed === true && r.failed === false,
    JSON.stringify(r));
}

// 4. Unknown agent → neither.
{
  const r = _cliLedgerAuth('neverseen.agent');
  check('no ledger entry → neither authed nor failed',
    r.authed === false && r.failed === false, JSON.stringify(r));
}

// 5. Persisted to the env-isolated file — survives a "restart" (fresh read).
{
  const disk = JSON.parse(fs.readFileSync(process.env.THINKDROP_PREFLIGHT_AUTH_CACHE, 'utf8'));
  check('ledger persisted authed:true to disk',
    disk['nylas.agent'] && disk['nylas.agent'].authed === true,
    JSON.stringify(disk['nylas.agent']));
}

// 6. Case-insensitive agent ids (ledger keys are lowercased).
{
  const r = _cliLedgerAuth('Nylas.Agent');
  check('agentId case-insensitive', r.authed === true, JSON.stringify(r));
}

// 7. A stale authed:true entry with a NEWER lastAuthFailedAt → failed.
//    (Write directly — markAgentAuthFailed stamps ts=now so order is real,
//    but hand-craft the stale shape seen on disk pre-fix.)
{
  const file = process.env.THINKDROP_PREFLIGHT_AUTH_CACHE;
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk['stale.agent'] = { ts: 1000, authed: true, lastAuthFailedAt: 2000, lastAuthFailedReason: 'probe' };
  fs.writeFileSync(file, JSON.stringify(disk));
  // Bust the module's lazy-loaded snapshot so it re-reads the file.
  const r = _cliLedgerAuth('stale.agent');
  check('authed:true + newer lastAuthFailedAt → failed',
    r.authed === false && r.failed === true, JSON.stringify(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('failures:', failures.join('; ')); process.exit(1); }
process.exit(0);

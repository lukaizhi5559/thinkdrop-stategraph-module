'use strict';

// Regression: classifyTask.js required '../../../shared/decision-state.cjs'
// unguarded inside the adaptive-mode check. That path resolves to repo/shared
// in-place but to node_modules/@thinkdrop/shared under the rsync'd package —
// which was never synced. Under the synced copy the require threw before
// adaptiveEnabled() could evaluate, classifyTask fell to _default for every
// task, and follow-up pronouns ("how many season of this" → Wingfeather Saga)
// went to the webSearch node unresolved — Google answered about "This Is Us".
//
// The fix: shared/ is synced next to the package AND the require is guarded —
// a missing module skips adaptive mode instead of killing classification.
//
// The stub askDecision is REQUIRED to reproduce the path: _decOn is only true
// when options.askDecision is a function (in production it's the phi4
// decision.answer client). Without it the buggy require is never reached.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const HISTORY = [
  { role: 'user',      content: 'in the wingfeather saga does the child return back to human' },
  { role: 'assistant', content: 'Yes — Kalmar is restored to human form by the end of the saga.' },
];
const FOLLOWUP_MSG = 'how many season of this';
const REMOTE_JSON = '{"taskType":"query","isFollowUp":true,"followUpTarget":"The Wingfeather Saga seasons","needsClarification":false,"targetService":null,"webAccessMode":"public_read","interactiveActions":[],"mediaListing":"none","suggestedIntent":null}';

function makeStubs() {
  return {
    // Local leg returns null (no taskType answer) → remote leg runs — same
    // fail-open behavior as a slow/absent phi4 decision model.
    askDecision: async () => ({ answers: {} }),
    llmBackend: { generateAnswer: async () => REMOTE_JSON },
  };
}

async function classifyWith(mod, label) {
  const { askDecision, llmBackend } = makeStubs();
  const out = await mod.classifyTask(FOLLOWUP_MSG, HISTORY, llmBackend, logger, null, null, { askDecision });
  check(`${label}: isFollowUp resolved`, out.isFollowUp === true, JSON.stringify({ isFollowUp: out.isFollowUp, followUpTarget: out.followUpTarget }));
  check(`${label}: followUpTarget names the saga`, /wingfeather/i.test(out.followUpTarget || ''), out.followUpTarget);
  check(`${label}: taskType query`, out.taskType === 'query', out.taskType);
}

async function run() {
  // ── 1. Source copy (in-place: ../../../shared → repo/shared) ───────────────
  await classifyWith(require('../src/utils/classifyTask.js'), 'src');

  // ── 2. Synced package copy (../../../shared → node_modules/@thinkdrop/shared)
  // Only exists in dev-synced environments — skip cleanly otherwise.
  const syncedPath = path.resolve(__dirname, '../../node_modules/@thinkdrop/stategraph/src/utils/classifyTask.js');
  if (fs.existsSync(syncedPath)) {
    check('synced shared/ present', fs.existsSync(path.resolve(__dirname, '../../node_modules/@thinkdrop/shared/decision-state.cjs')));
    await classifyWith(require(syncedPath), 'synced');
  } else {
    console.log('  (skipped synced-package checks — node_modules/@thinkdrop/stategraph not present)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });

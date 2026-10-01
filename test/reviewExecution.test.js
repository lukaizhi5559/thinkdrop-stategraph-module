'use strict';

// Regression: an edit.agent step that succeeded (draft or applied) used to fall
// through to the browser-only fulfillment check — empty synthesize output +
// null snapshot → LLM judged NOT_FULFILLED → hollow → replan that produced
// app.agent keystroke macros against the user's live document.
// ok:true from edit.agent is self-verifying → VERIFIED.

const reviewExecution = require('../src/nodes/reviewExecution');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const _failLlm = { complete: async () => { throw new Error('LLM must not be called'); } };

(async () => {
  // Draft-mode success → VERIFIED, no LLM/backend needed.
  let r = await reviewExecution({
    message: 'update the file', skillPlan: [{ skill: 'edit.agent' }],
    skillResults: [{ step: 1, skill: 'edit.agent', ok: true, draftPath: '/tmp/d.txt', mode: 'draft' }],
    logger, llmBackend: _failLlm, mcpAdapter: null,
  });
  check('edit.agent draft → VERIFIED', r.reviewVerdict === 'VERIFIED', r.reviewVerdict);

  // Applied success → VERIFIED.
  r = await reviewExecution({
    message: 'update the file', skillPlan: [{ skill: 'edit.agent' }],
    skillResults: [{ step: 1, skill: 'edit.agent', ok: true, appliedEdits: 1, backupPath: '/b', mode: 'inplace' }],
    logger, llmBackend: _failLlm, mcpAdapter: null,
  });
  check('edit.agent applied → VERIFIED', r.reviewVerdict === 'VERIFIED', r.reviewVerdict);

  // No-change success → VERIFIED (file already satisfies the goal).
  r = await reviewExecution({
    message: 'fix typos', skillPlan: [{ skill: 'edit.agent' }],
    skillResults: [{ step: 1, skill: 'edit.agent', ok: true, changed: false, stdout: 'No changes needed' }],
    logger, llmBackend: _failLlm, mcpAdapter: null,
  });
  check('edit.agent no-change → VERIFIED', r.reviewVerdict === 'VERIFIED', r.reviewVerdict);

  // A FAILED edit.agent step must not short-circuit.
  r = await reviewExecution({
    message: 'update the file', skillPlan: [{ skill: 'edit.agent' }],
    skillResults: [{ step: 1, skill: 'edit.agent', ok: false, error: 'region_not_found' }],
    logger, llmBackend: null, mcpAdapter: null,
  });
  check('edit.agent failure not short-circuited', r.reviewVerdict !== 'VERIFIED', r.reviewVerdict);

  // Empty results → UNVERIFIABLE passthrough (unchanged behavior).
  r = await reviewExecution({ message: 'x', skillPlan: [], skillResults: [], logger });
  check('empty results → UNVERIFIABLE', r.reviewVerdict === 'UNVERIFIABLE', r.reviewVerdict);

  // Deterministic plan + synthesize → answer is the synth text, not the
  // "Done.\n\nStep outputs:" debug blob (regression: "what's this article
  // about" showed the blob as the visible answer).
  r = await reviewExecution({
    message: "what's this article about",
    skillPlan: [{ skill: 'app.agent' }, { skill: 'synthesize' }],
    _deterministicPlan: [{ skill: 'app.agent' }, { skill: 'synthesize' }],
    skillResults: [
      { step: 1, skill: 'app.agent', args: { action: 'scan_page' }, ok: true },
      { step: 2, skill: 'synthesize', ok: true, stdout: 'The article covers new Trump photos.' },
    ],
    logger, llmBackend: _failLlm, mcpAdapter: null,
  });
  check('deterministic + synthesize → answer is synth text',
    r.answer === 'The article covers new Trump photos.', JSON.stringify(r.answer).slice(0, 80));

  // Deterministic plan without synthesize keeps the Step outputs blob.
  r = await reviewExecution({
    message: 'open notes',
    skillPlan: [{ skill: 'shell.run' }],
    _deterministicPlan: [{ skill: 'shell.run' }],
    skillResults: [{ step: 1, skill: 'shell.run', ok: true }],
    logger, llmBackend: _failLlm, mcpAdapter: null,
  });
  check('deterministic no-synth → Step outputs blob',
    /Step outputs:/.test(r.answer || ''), JSON.stringify(r.answer).slice(0, 80));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

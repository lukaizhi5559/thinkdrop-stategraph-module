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

  // ── 3. Provider-down elliptical fallback ────────────────────────────────
  // A short continuation must not become a screen/command task merely because
  // the remote classifier is unavailable. The prior user turn supplies the
  // referent and the activity lane.
  const offline = {
    generateAnswer: async () => { throw new Error('provider unavailable'); },
  };
  const fallback = await require('../src/utils/classifyTask.js').classifyTask(
    'summarize the second one',
    [{ role: 'user', content: 'what videos did I watch yesterday' }],
    offline,
    logger,
  );
  check('offline elliptical follow-up isFollowUp=true', fallback.isFollowUp === true, JSON.stringify(fallback));
  check('offline elliptical follow-up uses memory_retrieve', fallback.suggestedIntent === 'memory_retrieve', fallback.suggestedIntent);
  check('offline elliptical follow-up clears screen referent', fallback.activeDocRef === null, fallback.activeDocRef);

  // ── 4. Live-surface asks are not elliptical follow-ups ───────────────────
  // "what do you see on the screen" / "on the web page…" carry their own
  // referent — the floor must not bind them to the prior turn (observed:
  // injected suggestedIntent=web_search + a careers-question target demoted
  // a screen/page handoff into a garbage SERP).
  const liveSurface = await require('../src/utils/classifyTask.js').classifyTask(
    'what do you see on the screen right here can you tell me about these all events',
    HISTORY,
    offline,
    logger,
  );
  check('live-surface prompt does NOT floor to web_search', liveSurface.suggestedIntent !== 'web_search', liveSurface.suggestedIntent);
  const livePage = await require('../src/utils/classifyTask.js').classifyTask(
    'on the web page here I need you to help me figure out what this is all about',
    HISTORY,
    offline,
    logger,
  );
  check('live-page prompt does NOT floor to web_search', livePage.suggestedIntent !== 'web_search', livePage.suggestedIntent);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });

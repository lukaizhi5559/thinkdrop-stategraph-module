'use strict';
/**
 * tab-flow-tab-map.test.js
 *
 * Regression tests for the Tab-Flow → Tab-Map single-session fix:
 *   1. _splitCompoundAction + _inheritFragmentVerbs — verb-less split fragments
 *      get their verb back ("'Subject' with 'X'" → "fill 'Subject' with 'X'")
 *   2. _tier4RunHint — contiguous tier-4 flow steps batch into one hint so the
 *      runner scans/plans once per dialog instead of once per field
 *   3. _subPlanStepMatchesFlowStep / _resyncFlowIndex / _reconcileFlowIndex —
 *      matchers handle verb-less fragments and `with 'value'` syntax
 *   4. _mergeConversationHistory — recent + semantic history merged and sorted
 *      chronologically so slice(-N) consumers get the actual latest turns
 *
 * Run with: node test/tab-flow-tab-map.test.js
 */

// ─── Minimal test harness (matches unit.test.js style) ───────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}`);
    console.log(`     ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertDeepEq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

// ─── Load modules ────────────────────────────────────────────────────────────
const runner = require('../../mcp-services/command-service/src/skills/instruction.runner.cjs');
const browserAgent = require('../../mcp-services/command-service/src/skills/browser.agent.cjs');
const resolveReferencesV2 = require('../src/nodes/resolveReferencesV2.js');

const {
  _tier4RunHint, _subPlanStepMatchesFlowStep, _resyncFlowIndex, _reconcileFlowIndex,
} = runner;
const { _splitCompoundAction, _inheritFragmentVerbs } = browserAgent;
const { _mergeConversationHistory } = resolveReferencesV2;

// ══════════════════════════════════════════════════════════════════════════════
//  1. Compound tier-4 splitting + verb inheritance
// ══════════════════════════════════════════════════════════════════════════════
describe('_splitCompoundAction + _inheritFragmentVerbs (verb-less fragments)', () => {

  it('splits compound fill action on commas outside quotes', () => {
    const parts = _splitCompoundAction(
      "fill 'To' with 'bob@example.com', 'Subject' with 'Location Addresses', and body with 'the location addresses', then click 'Send'"
    );
    assertDeepEq(parts, [
      "fill 'To' with 'bob@example.com'",
      "'Subject' with 'Location Addresses'",
      "and body with 'the location addresses'",
      "click 'Send'",
    ]);
  });

  it('does not split on commas inside quotes', () => {
    const parts = _splitCompoundAction("type 'Hello, world' into body, then click 'Send'");
    assertEq(parts.length, 2);
    assert(parts[0].includes('Hello, world'), `first fragment should keep quoted comma: ${parts[0]}`);
  });

  it('inherits the verb for verb-less fragments', () => {
    const out = _inheritFragmentVerbs([
      "fill 'To' with 'bob@example.com'",
      "'Subject' with 'Location Addresses'",
      "and body with 'the location addresses'",
      "click 'Send'",
    ]);
    assertDeepEq(out, [
      "fill 'To' with 'bob@example.com'",
      "fill 'Subject' with 'Location Addresses'",
      "fill body with 'the location addresses'",
      "click 'Send'",
    ]);
  });

  it('does not prepend a verb when the first fragment has none', () => {
    const out = _inheritFragmentVerbs(["'Subject' with 'X'", "click 'Send'"]);
    assertEq(out[0], "'Subject' with 'X'"); // no prior verb — stays as-is
    assertEq(out[1], "click 'Send'");
  });

  it('switches inherited verb when a fragment introduces a new one', () => {
    const out = _inheritFragmentVerbs([
      "fill 'To' with 'a'", "'Subject' with 'b'", "press 'Enter'", "'confirmation' field",
    ]);
    assertEq(out[1], "fill 'Subject' with 'b'");
    assertEq(out[3], "press 'confirmation' field");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  2. _tier4RunHint — batching contiguous tier-4 flow steps
// ══════════════════════════════════════════════════════════════════════════════
describe('_tier4RunHint (batch contiguous tier-4 steps into one hint)', () => {

  const gmailFlow = [
    { tier: 4, action: "fill 'To' with 'bob@example.com'" },
    { tier: 4, action: "fill 'Subject' with 'Location Addresses'" },
    { tier: 4, action: "fill body with 'the location addresses'" },
    { tier: 4, action: "click 'Send'" },
    { tier: 0, action: 'done' },
  ];

  it('joins the whole contiguous tier-4 run into one hint', () => {
    const hint = _tier4RunHint(gmailFlow, 0);
    assertEq(hint,
      "fill 'To' with 'bob@example.com'; fill 'Subject' with 'Location Addresses'; fill body with 'the location addresses'; click 'Send'");
  });

  it('starts the run at the current flow index', () => {
    const hint = _tier4RunHint(gmailFlow, 1);
    assertEq(hint, "fill 'Subject' with 'Location Addresses'; fill body with 'the location addresses'; click 'Send'");
  });

  it('stops at the first non-tier-4 step', () => {
    const flow = [
      { tier: 4, action: "fill 'A' with '1'" },
      { tier: 3, action: 'press c' },
      { tier: 4, action: "fill 'B' with '2'" },
    ];
    assertEq(_tier4RunHint(flow, 0), "fill 'A' with '1'");
  });

  it('returns empty for non-tier-4 or out-of-range index', () => {
    assertEq(_tier4RunHint(gmailFlow, 4), '');
    assertEq(_tier4RunHint(gmailFlow, 99), '');
    assertEq(_tier4RunHint(null, 0), '');
  });

  it('strips "scan the page and" style prefixes from hint parts', () => {
    const flow = [
      { tier: 4, action: "scan the page and fill 'To' with 'a@b.com'" },
      { tier: 4, action: "look at the page and click 'Send'" },
    ];
    assertEq(_tier4RunHint(flow, 0), "fill 'To' with 'a@b.com'; click 'Send'");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  3. Flow-index matchers — verb-less fragments + `with` syntax
// ══════════════════════════════════════════════════════════════════════════════
describe('_subPlanStepMatchesFlowStep (verb-less flow fragments)', () => {

  it('matches sub-plan type step against verb-less "field with value" fragment', () => {
    const ok = _subPlanStepMatchesFlowStep(
      { action: 'type', target: 'Subject', value: 'Location Addresses' },
      { tier: 4, action: "'Subject' with 'Location Addresses'" }
    );
    assert(ok, 'expected match on value overlap');
  });

  it('matches on target-word overlap for verb-less fragments', () => {
    const ok = _subPlanStepMatchesFlowStep(
      { action: 'type', target: 'message body', value: 'hi' },
      { tier: 4, action: "body with 'hi'" }
    );
    assert(ok, 'expected match on target/flow word overlap');
  });

  it('still rejects genuine verb mismatches', () => {
    const ok = _subPlanStepMatchesFlowStep(
      { action: 'click', target: 'Save' },
      { tier: 4, action: "type 'hello' into the notes field" }
    );
    assert(!ok, 'click vs type flow step should not match');
  });

  it('matches click sub-steps to click/send flow steps', () => {
    const ok = _subPlanStepMatchesFlowStep(
      { action: 'click', target: "button 'Send'" },
      { tier: 4, action: "click 'Send'" }
    );
    assert(ok, 'expected click/send word overlap match');
  });
});

describe('_resyncFlowIndex (with-syntax fills)', () => {

  const flow = [
    { tier: 4, action: "fill 'To' with 'bob@example.com'" },
    { tier: 4, action: "'Subject' with 'Location Addresses'" },   // verb-less cached fragment
    { tier: 4, action: "body with the location addresses" },       // unquoted with-value
    { tier: 4, action: "click 'Send'" },
    { tier: 0, action: 'done' },
  ];

  it('advances past a `with \'value\'` fill when the value is in filledFields', () => {
    const idx = _resyncFlowIndex(flow, 1,
      [{ label: 'Subject', value: 'Location Addresses' }], [], _noopLogger);
    assertEq(idx, 2);
  });

  it('advances past unquoted "with <text>" fragments via fuzzy value match', () => {
    const idx = _resyncFlowIndex(flow, 2,
      [{ label: 'body', value: 'the location addresses' }], [], _noopLogger);
    assertEq(idx, 3);
  });

  it('advances past multiple satisfied fill steps in one pass', () => {
    const idx = _resyncFlowIndex(flow, 0, [
      { label: 'To', value: 'bob@example.com' },
      { label: 'Subject', value: 'Location Addresses' },
      { label: 'body', value: 'the location addresses' },
    ], ["click 'Send' → ok"], _noopLogger);
    assertEq(idx, 5, `expected flow fully resynced to done, got ${idx}`);
  });

  it('stops at an unsatisfied fill step', () => {
    const idx = _resyncFlowIndex(flow, 1, [], [], _noopLogger);
    assertEq(idx, 1, 'unsatisfied Subject fill should not advance');
  });

  it('matches on field label when planned value differs from filled value', () => {
    const idx = _resyncFlowIndex(flow, 1,
      [{ label: 'Subject', value: 'Store Locations' }], [], _noopLogger);
    assertEq(idx, 2, 'label match should advance even when value differs');
  });
});

describe('_reconcileFlowIndex (quoted-phrase + fill/enter keywords)', () => {

  it('advances tier-4 step when last action contains a quoted flow phrase', () => {
    const flow = [{ tier: 4, action: "'Subject' with 'Location Addresses'" }];
    const idx = _reconcileFlowIndex(flow, 0, 'https://mail.google.com/x', 'https://mail.google.com/x',
      _noopLogger, ['type "Location Addresses" into Subject → ok'], null, null, 0, 'agent', 'sess');
    assertEq(idx, 1);
  });

  it('advances on fill-keyword match', () => {
    const flow = [{ tier: 4, action: "fill 'Subject' with 'X'" }];
    const idx = _reconcileFlowIndex(flow, 0, 'u', 'u',
      _noopLogger, ["typed 'X' into subject field → ok"], null, null, 0, 'a', 's');
    assertEq(idx, 1);
  });

  it('does not advance when last action is unrelated', () => {
    const flow = [{ tier: 4, action: "fill 'Subject' with 'Location Addresses'" }];
    const idx = _reconcileFlowIndex(flow, 0, 'u', 'u',
      _noopLogger, ["click 'Compose' → ok"], null, null, 0, 'a', 's');
    assertEq(idx, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  4. _mergeConversationHistory — chronological merge of recent + semantic
// ══════════════════════════════════════════════════════════════════════════════
describe('_mergeConversationHistory (chronological ordering)', () => {

  it('sorts merged history chronologically so slice(-N) gets the latest turns', () => {
    const recent = [
      { id: 'r1', role: 'user', timestamp: '2026-09-16T01:00:00Z' },
      { id: 'r2', role: 'assistant', timestamp: '2026-09-16T01:05:00Z', content: 'Target at 123 Main St, Walmart at 456 Oak Ave' },
    ];
    const semantic = [
      { id: 's1', role: 'user', timestamp: '2026-05-23T10:00:00Z', source: 'semantic', content: 'where am I located?' },
      { id: 's2', role: 'user', timestamp: '2026-05-23T10:01:00Z', source: 'semantic', content: 'whats name' },
    ];
    const merged = _mergeConversationHistory(recent, semantic);
    const tail = merged.slice(-2);
    assertEq(tail[0].id, 'r1');
    assertEq(tail[1].id, 'r2', 'last message must be the most recent assistant turn, not a semantic match');
  });

  it('deduplicates messages by id across recent and semantic', () => {
    const recent = [{ id: 'r1', timestamp: '2026-09-16T01:00:00Z' }];
    const semantic = [{ id: 'r1', timestamp: '2026-09-16T01:00:00Z', source: 'semantic' }];
    const merged = _mergeConversationHistory(recent, semantic);
    assertEq(merged.length, 1);
  });

  it('handles missing timestamps without crashing', () => {
    const merged = _mergeConversationHistory(
      [{ id: 'a' }],
      [{ id: 'b', timestamp: '2026-01-01T00:00:00Z', source: 'semantic' }]
    );
    assertEq(merged.length, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  5. Merged sub-plan steps — type satisfies click-field, click satisfies send
// ══════════════════════════════════════════════════════════════════════════════
describe('_subPlanStepMatchesFlowStep (merged sub-plan semantics)', () => {

  it('type sub-step satisfies a "click <field>" flow step (click folded into type)', () => {
    const ok = _subPlanStepMatchesFlowStep(
      { action: 'type', target: 'To recipients', value: 'bob@example.com' },
      { tier: 4, action: "click the 'To recipients' field" }
    );
    assert(ok, 'typing focuses the field — merged click+type should match');
  });

  it('click Send satisfies a "press Ctrl+Enter to send" flow step', () => {
    const ok = _subPlanStepMatchesFlowStep(
      { action: 'click', target: 'Send' },
      { tier: 4, action: "press 'Ctrl+Enter' to send the email" }
    );
    assert(ok, 'click send is a valid submit path for a press-send flow step');
  });
});

describe('_resyncFlowIndex (submit-by-any-means + merged click-field)', () => {

  const gmailFlow = [
    { tier: 4, action: "click the 'To recipients' field" },
    { tier: 4, action: "fill 'Subject' with 'Sourdough'" },
    { tier: 4, action: "click 'Send'" },
    { tier: 0, action: 'done' },
  ];

  it('advances a click-field step when the named field was filled', () => {
    const idx = _resyncFlowIndex(gmailFlow, 0,
      [{ label: 'To recipients', value: 'bob@x.com' }], [], _noopLogger);
    assertEq(idx, 1);
  });

  it('"click Send" satisfied by a Ctrl+Enter shortcut in history', () => {
    const idx = _resyncFlowIndex(gmailFlow, 2, [],
      ["Shortcut 'Control+Enter' → ok"], _noopLogger);
    assertEq(idx, 4, 'modifier+Enter is a submit accelerator — satisfies click Send');
  });

  it('"press Ctrl+Enter to send" satisfied by a click Send in history', () => {
    const flow = [
      { tier: 4, action: "press 'Ctrl+Enter' to send the email" },
      { tier: 0, action: 'done' },
    ];
    const idx = _resyncFlowIndex(flow, 0, [],
      ["click 'Send' → page changed"], _noopLogger);
    assertEq(idx, 2, 'quoted key-combo target must not block the submit-by-any-means check');
  });

  it('does not advance submit steps on unrelated history', () => {
    const idx = _resyncFlowIndex(gmailFlow, 2, [],
      ["click 'Archive' → ok"], _noopLogger);
    assertEq(idx, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  6. _selectPriorSynthesis — plain-prose fallback (follow-up email body)
// ══════════════════════════════════════════════════════════════════════════════
describe('_selectPriorSynthesis (plain assistant-prose fallback)', () => {

  let _selectPriorSynthesis;
  try {
    _selectPriorSynthesis = require('../src/nodes/planSkillsV2.js')._selectPriorSynthesis;
  } catch (e) {
    console.log(`  [skip] planSkillsV2 not loadable: ${e.message}`);
  }

  if (_selectPriorSynthesis) {
    it('falls back to recent assistant prose when no "Step outputs:" marker exists', () => {
      const hist = [
        { role: 'user', content: 'what the best way to make sourdough bread?' },
        { role: 'assistant', content: 'To make great sourdough bread you need a mature starter, strong bread flour, and an autolyse rest. Mix 500g flour with 350g water, fold every 30 minutes for 4 hours, then shape and cold-proof overnight before baking at 450°F in a Dutch oven.' },
      ];
      const out = _selectPriorSynthesis(hist);
      assert(out && out.includes('sourdough'), 'expected the sourdough answer to be selected');
    });

    it('prefers "Step outputs:" syntheses over plain prose', () => {
      const hist = [
        { role: 'assistant', content: 'Some earlier plain answer about the weather being nice today for a walk.' },
        { role: 'user', content: 'find stores' },
        { role: 'assistant', content: 'Step outputs:\n[synthesize]:\nTarget at 123 Main St, Walmart at 456 Oak Ave\n' },
      ];
      const out = _selectPriorSynthesis(hist);
      assert(out && out.includes('Target at 123 Main St'), `expected structured synthesis, got: ${out}`);
    });

    it('skips send-confirmation messages', () => {
      const hist = [
        { role: 'user', content: 'send that to bob@x.com' },
        { role: 'assistant', content: 'Confirmed sent — the email was sent successfully to bob@x.com with all of the requested content included.' },
      ];
      const out = _selectPriorSynthesis(hist);
      assert(!out || !/confirmed sent/i.test(out), `should not return the confirmation itself, got: ${out}`);
    });

    it('skips acknowledgements and short replies', () => {
      const hist = [
        { role: 'assistant', content: 'Got it! I understand what you need.' },
        { role: 'assistant', content: 'Here is the real content: the quarterly revenue grew 12% year over year to $4.2M, driven mostly by enterprise contracts.' },
      ];
      const out = _selectPriorSynthesis(hist);
      assert(out && out.includes('quarterly revenue'), `expected substantive prose, got: ${out}`);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  7. Send-API detection — Gmail nested endpoints + correlated fallback
// ══════════════════════════════════════════════════════════════════════════════
describe('_SEND_ENDPOINT_RE / _detectSuccessfulSend', () => {

  const { _SEND_ENDPOINT_RE, _SEND_EXCLUDE_RE, _detectSuccessfulSend, _markSubmitAttempt, _clearSubmitMarker } = browserAgent;
  const browserEngine = require('../../mcp-services/command-service/src/skills/browser-engine.cjs');
  const _origGetNetLog = browserEngine.getNetLog;

  it('matches Gmail nested send path /sync/u/0/i/s', () => {
    assert(_SEND_ENDPOINT_RE.test('https://mail.google.com/sync/u/0/i/s?rt=c'));
    assert(_SEND_ENDPOINT_RE.test('/sync/u/0/i/s'));
    assert(_SEND_ENDPOINT_RE.test('/sync/u/12/i/s'));
  });

  it('does NOT match the draft autosave endpoint /sync/u/0/i/d', () => {
    assert(!_SEND_ENDPOINT_RE.test('https://mail.google.com/sync/u/0/i/d?rt=c'));
  });

  it('_SEND_EXCLUDE_RE excludes draft/label/read mutations', () => {
    assert(_SEND_EXCLUDE_RE.test('/sync/u/0/i/d'));
    assert(_SEND_EXCLUDE_RE.test('https://mail.google.com/sync/u/0/labels'));
    assert(_SEND_EXCLUDE_RE.test('/sync/u/0/read'));
    assert(!_SEND_EXCLUDE_RE.test('/sync/u/0/i/s'));
  });

  it('detects send via named endpoint without a submit marker', () => {
    browserEngine.getNetLog = () => [
      { method: 'POST', status: 200, url: 'https://mail.google.com/sync/u/0/i/s?rt=c', ts: Date.now() },
    ];
    try {
      assert(_detectSuccessfulSend('sess-x'), 'named endpoint → send detected');
    } finally { browserEngine.getNetLog = _origGetNetLog; }
  });

  it('detects send via submit-correlated 2xx POST to the same host', () => {
    _markSubmitAttempt('sess-y', 'mail.google.com');
    browserEngine.getNetLog = () => [
      { method: 'POST', status: 200, url: 'https://mail.google.com/some/renamed/rpc', ts: Date.now() },
    ];
    try {
      assert(_detectSuccessfulSend('sess-y'), 'correlated POST after submit marker → send detected');
    } finally {
      browserEngine.getNetLog = _origGetNetLog;
      _clearSubmitMarker('sess-y');
    }
  });

  it('does NOT correlate draft autosaves to the submit marker', () => {
    _markSubmitAttempt('sess-z', 'mail.google.com');
    browserEngine.getNetLog = () => [
      { method: 'POST', status: 200, url: 'https://mail.google.com/sync/u/0/i/d', ts: Date.now() },
    ];
    try {
      assert(!_detectSuccessfulSend('sess-z'), 'draft save must not count as a send');
    } finally {
      browserEngine.getNetLog = _origGetNetLog;
      _clearSubmitMarker('sess-z');
    }
  });

  it('does NOT correlate POSTs to a different host', () => {
    _markSubmitAttempt('sess-w', 'mail.google.com');
    browserEngine.getNetLog = () => [
      { method: 'POST', status: 200, url: 'https://analytics.example.com/beacon', ts: Date.now() },
    ];
    try {
      assert(!_detectSuccessfulSend('sess-w'), 'cross-host POST must not count');
    } finally {
      browserEngine.getNetLog = _origGetNetLog;
      _clearSubmitMarker('sess-w');
    }
  });

  it('ignores non-2xx and non-mutation entries', () => {
    browserEngine.getNetLog = () => [
      { method: 'GET', status: 200, url: 'https://mail.google.com/sync/u/0/i/s', ts: Date.now() },
      { method: 'POST', status: 403, url: 'https://mail.google.com/sync/u/0/i/s', ts: Date.now() },
    ];
    try {
      assert(!_detectSuccessfulSend('sess-v'), 'GET/403 must not count');
    } finally { browserEngine.getNetLog = _origGetNetLog; }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(70)}`);
console.log(`  Results: ${_passed} passed, ${_failed} failed`);
if (_failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of _failures) console.log(`    ❌ ${f.label}\n       ${f.error}`);
}
console.log(`${'═'.repeat(70)}\n`);
process.exit(_failed > 0 ? 1 : 0);

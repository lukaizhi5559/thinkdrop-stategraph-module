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

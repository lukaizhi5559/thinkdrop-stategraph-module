'use strict';
/**
 * carried-hint.test.js — comms-graph's deterministic intentGuesser verdict
 * (state._carriedHint) must reach the decompose number-call:
 *
 *   - On parse failure / provider flake, a valid hint beats the
 *     command_automate default (a wrong automation plan is the most
 *     expensive misroute).
 *   - The hint appears in the decision prompt as a prior, not an override.
 *   - No hint → legacy behavior (default 0) is preserved.
 *
 * Regression for: "what's my name" — memory_quick escalated with
 * guessedIntent=memory_retrieve, the hint was dropped at the handoff seam,
 * and the number-call's parse failure defaulted to command_automate (121s).
 *
 * Run: node stategraph-module/test/carried-hint.test.js
 */

const { describe, it } = require('node:test');

function fail(e) { console.error(e); process.exitCode = 1; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');

const _decompose = (message, backend, extra = {}) => decomposePromptV2({
  message,
  conversationHistory: [],
  logger: _noopLogger,
  llmBackend: backend,
  _taskClassification: {},
  ...extra,
});

describe('decomposePromptV2 — carriedHint channel', () => {
  it('parse-garbage + memory_retrieve hint → memory_retrieve (not command_automate)', async () => {
    const r = await _decompose("what's my name",
      { generateAnswer: async () => 'let me think about that…' },
      { _carriedHint: 'memory_retrieve' });
    assertEq(r._decomposedIntent, 'memory_retrieve');
    assertEq(r.intentPlan[0].estimatedIntent, 'memory_retrieve');
  });

  it('llm throw + web_search hint → web_search fallback', async () => {
    const r = await _decompose('look up the weather online',
      { generateAnswer: async () => { throw new Error('provider timeout'); } },
      { _carriedHint: 'web_search' });
    assertEq(r._decomposedIntent, 'web_search');
  });

  it('llm throw + no hint → command_automate (legacy default preserved)', async () => {
    const r = await _decompose('do something with a file',
      { generateAnswer: async () => { throw new Error('provider timeout'); } });
    assertEq(r._decomposedIntent, 'command_automate');
  });

  it('clear signal overrides hint — specific non-zero verdict wins over prior', async () => {
    // hint says memory_retrieve but the model affirmatively returns web_search
    const r = await _decompose("what's my name",
      { generateAnswer: async () => '2' },
      { _carriedHint: 'memory_retrieve' });
    assertEq(r._decomposedIntent, 'web_search');
  });

  it('bare 0 is residual — non-command hint vetoes it', async () => {
    // 0 = command_automate is also the "when in doubt" bucket per the decision
    // prompt, so a bare 0 can't express a confident automation verdict. A
    // deterministic non-command hint beats it (mirrors the comms keyword veto).
    const r = await _decompose("what's my name",
      { generateAnswer: async () => '0' },
      { _carriedHint: 'memory_retrieve' });
    assertEq(r._decomposedIntent, 'memory_retrieve');
  });

  it('hint appears in the decision prompt as a prior', async () => {
    let seenPrompt = '';
    await _decompose("what's my name",
      { generateAnswer: async (p) => { seenPrompt = String(p); return '4'; } },
      { _carriedHint: 'memory_retrieve' });
    assert(seenPrompt.includes('memory_retrieve'), 'hint text missing from decision prompt');
  });

  it('unknown hint value falls back to 0 (not an invalid index)', async () => {
    const r = await _decompose('do something',
      { generateAnswer: async () => { throw new Error('x'); } },
      { _carriedHint: 'not_a_real_intent' });
    assertEq(r._decomposedIntent, 'command_automate');
  });
});

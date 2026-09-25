'use strict';
/**
 * screen-output.test.js
 *
 * Regression tests for the GhostLayer "screen as an output" pipeline:
 *   - classifyTask emits + sanitizes the screenOutput* fields
 *   - decomposePromptV2 screen-output guard routes isScreenOutput → screen_display
 *   - routeTable suggests screen_display (shadow mode)
 *   - routeIntent maps screen_display → screenOutput node
 *   - screenOutput node POSTs to /screen/display|clear with resolved content
 *
 * Run from repo root with:
 *   node stategraph-module/test/screen-output.test.js
 */

let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  const done = () => { _passed++; console.log(`  ✅ ${label}`); };
  const fail = (e) => {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}`);
    console.log(`     ${e.message}`);
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(done, fail);
    done();
  } catch (e) { fail(e); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

const { classifyTask } = require('../src/utils/classifyTask.js');
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');
const routeIntent = require('../src/nodes/routeIntent.js');
const { suggestIntent } = require('../src/utils/routeTable.js');
const screenOutput = require('../src/nodes/screenOutput.js');

const _decompose = (message, tc, extra = {}) => decomposePromptV2({
  message,
  conversationHistory: [],
  logger: _noopLogger,
  llmBackend: { generateAnswer: async () => '0' },
  _taskClassification: tc,
  ...extra,
});

// ── fetch capture harness for the screenOutput node ──────────────────────────
// The `it` harness runs callbacks concurrently — global.fetch can't be safely
// mocked per-test, so the node tests run sequentially inside one `it` via this
// helper which installs a mock, runs the callback, and restores.
const _realFetch = global.fetch;
async function _withMockFetch(handler, fn) {
  const posted = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    posted.push({ url, body });
    const out = handler ? handler(url, body) : { ok: true, id: 'so_test_1' };
    return { ok: true, status: 200, json: async () => out };
  };
  try { await fn(posted); } finally { global.fetch = _realFetch; }
}

describe('classifyTask — screenOutput* fields', () => {
  it('passes through valid screenOutput fields', async () => {
    const r = await classifyTask(
      'show it on the screen',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'query', isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'text' }) },
      _noopLogger,
    );
    assertEq(r.isScreenOutput, true);
    assertEq(r.screenOutputAction, 'show');
    assertEq(r.screenOutputKind, 'text');
  });

  it('sanitizes invalid values to safe defaults', async () => {
    const r = await classifyTask(
      'what time is it',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'local_system', isScreenOutput: 'yes', screenOutputAction: 'explode', screenOutputKind: 'hologram', screenOutputMood: 'angry' }) },
      _noopLogger,
    );
    assertEq(r.isScreenOutput, true); // 'yes' is truthy → coerced boolean
    assertEq(r.screenOutputAction, null);
    assertEq(r.screenOutputKind, null);
    assertEq(r.screenOutputMood, null);
  });

  it('defaults when fields absent', async () => {
    const r = await classifyTask(
      'hello',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'query' }) },
      _noopLogger,
    );
    assertEq(r.isScreenOutput, false);
    assertEq(r.screenOutputAction, null);
    assertEq(r.screenOutputKind, null);
    assertEq(r.screenOutputContent, null);
  });
});

describe('classifyTask — phantom targetService guard', () => {
  it('drops a service the user never named (public_read)', async () => {
    const r = await classifyTask(
      'pull up John 3:16 for me',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'browser', targetService: 'biblegateway', webAccessMode: 'public_read' }) },
      _noopLogger,
    );
    assertEq(r.targetService, null);
  });

  it('keeps an explicitly-named service', async () => {
    const r = await classifyTask(
      'search youtube for sermons',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'browser', targetService: 'youtube', webAccessMode: 'public_read' }) },
      _noopLogger,
    );
    assertEq(r.targetService, 'youtube');
  });

  it('keeps an inferred service for interactive tasks (planner needs a target)', async () => {
    const r = await classifyTask(
      'log in and post a status update',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'browser', targetService: 'facebook', webAccessMode: 'interactive', interactiveActions: ['post'] }) },
      _noopLogger,
    );
    assertEq(r.targetService, 'facebook');
  });
});

describe('classifyTask — deterministic screen-output detector', () => {
  const _falseLLM = { generateAnswer: async () => JSON.stringify({ taskType: 'local_system', isScreenOutput: false }) };

  it('"show on my screen" forces isScreenOutput even when LLM says false', async () => {
    const r = await classifyTask('show on my screen', [], _falseLLM, _noopLogger);
    assertEq(r.isScreenOutput, true);
    assertEq(r.screenOutputAction, 'show');
    assertEq(r.screenOutputKind, 'text');
  });

  it('"clear the screen" forces action=clear', async () => {
    const r = await classifyTask('clear the screen', [], _falseLLM, _noopLogger);
    assertEq(r.isScreenOutput, true);
    assertEq(r.screenOutputAction, 'clear');
  });

  it('"what\'s on my screen" does NOT trigger (reading, not displaying)', async () => {
    const r = await classifyTask("what's on my screen", [], _falseLLM, _noopLogger);
    assertEq(r.isScreenOutput, false);
  });

  it('detector survives a total LLM failure', async () => {
    const r = await classifyTask('show it on the screen', [], { generateAnswer: async () => { throw new Error('down'); } }, _noopLogger);
    assertEq(r.isScreenOutput, true);
    assertEq(r.screenOutputAction, 'show');
  });
});

describe('answer — _directAnswer short-circuit', () => {
  it('returns the direct answer without calling the LLM backend', async () => {
    const answer = require('../src/nodes/answer.js');
    const r = await answer({
      logger: _noopLogger,
      message: 'show it on the screen',
      _directAnswer: '## Screen\n\nOn screen.',
      llmBackend: { generateAnswer: async () => { throw new Error('LLM must not be called'); } },
      conversationHistory: [],
    });
    assertEq(r.answer, '## Screen\n\nOn screen.');
    assertEq(r.metadata.answerSource, 'direct');
  });
});

describe('decomposePromptV2 — screen-output guard', () => {
  it('isScreenOutput → screen_display single-step', async () => {
    const r = await _decompose('show it on the screen', {
      taskType: 'query', isScreenOutput: true, screenOutputAction: 'show',
    });
    assertEq(r._decomposedIntent, 'screen_display');
    assertEq(r._decomposedBy, 'screen-output-guard');
    assertEq(r.intentPlan[0].estimatedIntent, 'screen_display');
  });

  it('clear action also routes to screen_display', async () => {
    const r = await _decompose('clear the screen', {
      taskType: 'local_system', isScreenOutput: true, screenOutputAction: 'clear',
    });
    assertEq(r._decomposedIntent, 'screen_display');
    assertEq(r._decomposedBy, 'screen-output-guard');
  });

  it('multi-goal screen request falls through to normal pipeline', async () => {
    const r = await _decompose('find the weather and also show it on the screen', {
      taskType: 'query', isScreenOutput: true, screenOutputAction: 'show',
    });
    // hasMultiGoal → guard skipped → fast decision '0' → command_automate
    assert(r._decomposedBy !== 'screen-output-guard', `guard should not fire on multi-goal (got ${r._decomposedBy})`);
  });

  it('isScreenOutput false → guard does not fire', async () => {
    const r = await _decompose('what time is it', { taskType: 'local_system' });
    assert(r._decomposedBy !== 'screen-output-guard', `guard fired unexpectedly (got ${r._decomposedBy})`);
  });

  it('non-referential fetch content → web_search → screen_display two-step', async () => {
    const r = await _decompose('show me john 3:16 on my screen', {
      taskType: 'browser', webAccessMode: 'public_read', isScreenOutput: true, screenOutputAction: 'show',
    });
    assertEq(r._decomposedBy, 'screen-output-guard');
    assertEq(r.intentPlan.length, 2);
    assertEq(r.intentPlan[0].estimatedIntent, 'web_search');
    assertEq(r.intentPlan[1].estimatedIntent, 'screen_display');
    assertEq(r.intentPlan[1].dependsOn[0], 0);
  });

  it('referential phrasing stays single-step', async () => {
    const r = await _decompose('show the whole chapter on my screen', {
      taskType: 'local_system', isScreenOutput: true, screenOutputAction: 'show',
    });
    assertEq(r._decomposedBy, 'screen-output-guard');
    assertEq(r.intentPlan.length, 1);
    assertEq(r.intentPlan[0].estimatedIntent, 'screen_display');
  });

  it('inline literal content stays single-step', async () => {
    const r = await _decompose('show hello world on the screen', {
      taskType: 'local_system', isScreenOutput: true, screenOutputAction: 'show', screenOutputContent: 'hello world',
    });
    assertEq(r.intentPlan.length, 1);
  });

  it('effect kind never gets a fetch step', async () => {
    const r = await _decompose('make fireworks on my screen', {
      taskType: 'local_system', isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'effect',
    });
    assertEq(r.intentPlan.length, 1);
  });
});

describe('routeTable — screen-output shadow rule', () => {
  it('isScreenOutput → screen_display', () => {
    const s = suggestIntent({ isScreenOutput: true, screenOutputAction: 'show' }, 'show it on the screen');
    assertEq(s && s.intent, 'screen_display');
    assertEq(s && s.rule, 'screen-output');
  });

  it('declined-ack still wins over screen-output', () => {
    const s = suggestIntent({ resolution: 'declined_ack', isScreenOutput: true }, 'no thanks');
    assertEq(s && s.intent, 'general_knowledge');
  });

  it('no isScreenOutput → null (no opinion)', () => {
    const s = suggestIntent({ taskType: 'ambiguous' }, 'hello there friend');
    assertEq(s, null);
  });
});

describe('routeIntent — screen_display route', () => {
  it('screen_display → screenOutput node', async () => {
    const r = await routeIntent({
      logger: _noopLogger,
      intent: { type: 'screen_display', confidence: 0.9 },
      _taskClassification: { isScreenOutput: true },
    });
    assertEq(r._advanceRoute, 'screenOutput');
  });
});

describe('screenOutput node', () => {
  // All node cases run sequentially inside one `it` — they share global.fetch.
  it('clear/show/content-resolution/error paths', async () => {
    // clear → POST /screen/clear
    await _withMockFetch(null, async (posted) => {
      const r = await screenOutput({
        logger: _noopLogger,
        message: 'clear the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'clear' },
      });
      assertEq(posted.length, 1);
      assert(posted[0].url.endsWith('/screen/clear'), `expected /screen/clear, got ${posted[0].url}`);
      assert(/cleared/i.test(r._directAnswer), 'ack missing');
    });

    // show + explicit content → POST /screen/display with literal text
    await _withMockFetch(null, async (posted) => {
      const r = await screenOutput({
        logger: _noopLogger,
        message: 'show hello world on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'text', screenOutputContent: 'hello world' },
        conversationHistory: [],
      });
      assertEq(posted.length, 1);
      assert(posted[0].url.endsWith('/screen/display'));
      assertEq(posted[0].body.kind, 'text');
      assertEq(posted[0].body.text, 'hello world');
      assert(/on screen/i.test(r._directAnswer));
    });

    // show with no explicit content → last assistant message
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'show it on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show' },
        conversationHistory: [
          { role: 'user', content: 'pull up john 3:16' },
          { role: 'assistant', content: 'For God so loved the world…' },
        ],
      });
      assertEq(posted[0].body.text, 'For God so loved the world…');
    });

    // prefers non-card assistant turn over a thought card
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'show it on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show' },
        conversationHistory: [
          { role: 'assistant', content: 'The verse is John 3:16.' },
          { role: 'assistant', content: 'Card offer text', isThoughtCard: true },
        ],
      });
      assertEq(posted[0].body.text, 'The verse is John 3:16.');
    });

    // multi-step dependency result wins over conversation history
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'show on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show' },
        intentResults: [{ step: 0, intent: 'web_search', result: 'Step result text' }],
        conversationHistory: [{ role: 'assistant', content: 'Old answer' }],
      });
      assertEq(posted[0].body.text, 'Step result text');
    });

    // effect kind → effect name extracted from message
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'make it rain on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'effect' },
        conversationHistory: [],
      });
      assertEq(posted[0].body.kind, 'effect');
      assertEq(posted[0].body.effect, 'rain');
    });

    // emoji kind → glyph extracted from message
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'put a 🔥 emoji on my screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'emoji' },
        conversationHistory: [],
      });
      assertEq(posted[0].body.kind, 'emoji');
      assertEq(posted[0].body.emoji, '🔥');
    });

    // chart kind → classifier payload passthrough
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'pie chart: apples 5, bananas 3 on the screen',
        _taskClassification: {
          isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'chart',
          screenOutputPayload: { chart: { type: 'pie', data: [{ label: 'apples', value: 5 }], xKey: 'label', yKey: 'value' } },
        },
        conversationHistory: [],
      });
      assertEq(posted[0].body.kind, 'chart');
      assertEq(posted[0].body.chart.type, 'pie');
      assertEq(posted[0].body.chart.data.length, 1);
      // Interactive by default — the ant charts need real mouse events.
      assertEq(posted[0].body.blocking, true);
    });

    // explicit blocking:false in the classifier payload is respected
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'ambient pie chart on the screen',
        _taskClassification: {
          isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'chart',
          screenOutputPayload: { chart: { type: 'pie', data: [{ label: 'a', value: 1 }] }, blocking: false },
        },
        conversationHistory: [],
      });
      assertEq(posted[0].body.blocking, false);
    });

    // chart kind → step-result object supplies the chart
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'show that as a chart on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'chart' },
        intentResults: [{ step: 0, intent: 'memory_retrieve', result: { chart: { type: 'bar', data: [{ d: 'Mon', v: 2 }] } } }],
        conversationHistory: [],
      });
      assertEq(posted[0].body.chart.type, 'bar');
    });

    // alert kind → blocking + manual dismiss defaults, severity from message
    await _withMockFetch(null, async (posted) => {
      await screenOutput({
        logger: _noopLogger,
        message: 'block this site on the screen, it is not for children',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'alert', screenOutputContent: 'Not for children' },
        conversationHistory: [],
      });
      assertEq(posted[0].body.severity, 'block');
      assertEq(posted[0].body.blocking, true);
      assertEq(posted[0].body.dismiss, 'manual');
      assertEq(posted[0].body.text, 'Not for children');
    });

    // deck kind → no slides → honest failure, no POST
    await _withMockFetch(null, async (posted) => {
      const r = await screenOutput({
        logger: _noopLogger,
        message: 'show a presentation on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputKind: 'deck' },
        conversationHistory: [],
      });
      assertEq(posted.length, 0);
      assert(/no slides/i.test(r._directAnswer));
    });

    // nothing to display → honest failure, no POST
    await _withMockFetch(null, async (posted) => {
      const r = await screenOutput({
        logger: _noopLogger,
        message: 'show it on the screen',
        _taskClassification: { isScreenOutput: true, screenOutputAction: 'show' },
        conversationHistory: [{ role: 'user', content: 'hi' }],
      });
      assertEq(posted.length, 0);
      assert(/nothing on hand/i.test(r._directAnswer));
    });

    // server unreachable → honest failure
    {
      const posted = [];
      global.fetch = async () => { throw new Error('ECONNREFUSED'); };
      try {
        const r = await screenOutput({
          logger: _noopLogger,
          message: 'show hi on the screen',
          _taskClassification: { isScreenOutput: true, screenOutputAction: 'show', screenOutputContent: 'hi' },
          conversationHistory: [],
        });
        assert(/couldn't/i.test(r._directAnswer), `expected failure ack, got: ${r._directAnswer}`);
      } finally { global.fetch = _realFetch; }
    }
  });
});

setTimeout(() => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${_passed} passed, ${_failed} failed`);
  if (_failures.length) {
    console.log('  Failures:');
    _failures.forEach(f => console.log(`    - ${f.label}: ${f.error}`));
  }
  console.log('═'.repeat(70));
  process.exit(_failed ? 1 : 0);
}, 50);

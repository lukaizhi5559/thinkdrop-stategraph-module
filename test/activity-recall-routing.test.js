'use strict';
/**
 * activity-recall-routing.test.js — first-person past-activity questions must
 * reach memory_retrieve deterministically.
 *
 * Regression for: "what videos have I been watch today" (task_c6b69a65) —
 * classifyTask returned isActivityQuery:false + suggestedIntent:null on the
 * ungrammatical phrasing, the decompose number-call picked command_automate,
 * and planSkills ran `shell.run "Query Chrome history"` → terminal garbage →
 * "None found" even though matching audio_journal rows sat in episodic memory.
 *
 * Layers pinned here:
 *   1. classifyTask deterministic pre-check (ACTIVITY_RECALL_RE) repairs the
 *      envelope — isActivityQuery:true + suggestedIntent:'memory_retrieve'
 *      WITHOUT calling the LLM.
 *   2. decomposePromptV2 activity-recall guard routes on the typed flag alone
 *      (covers LLM-flagged-but-suggestedIntent-null envelopes).
 *   3. The bound-referent veto exempts isActivityQuery — recall of past
 *      activity is never answerable from a bound live tab.
 *
 * Run from repo root: node --test stategraph-module/test/activity-recall-routing.test.js
 */

const { describe, it } = require('node:test');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const { classifyTask } = require('../src/utils/classifyTask.js');
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');
const { suggestIntent } = require('../src/utils/routeTable.js');

const _decompose = (message, backend, extra = {}) => decomposePromptV2({
  message,
  conversationHistory: [],
  logger: _noopLogger,
  llmBackend: backend,
  _taskClassification: {},
  ...extra,
});

describe('classifyTask — deterministic activity-recall pre-check', () => {
  const _countingBackend = () => {
    let calls = 0;
    return {
      get calls() { return calls; },
      generateAnswer: async () => { calls++; return JSON.stringify({ taskType: 'query' }); },
    };
  };

  for (const msg of [
    'what videos have I been watch today',      // the observed failure (ungrammatical)
    'what videos have I been watching today',
    'what did I watch yesterday',
    'what have i been listening to',
    'what was I working on this morning',
    'what was on my screen',
    'what apps did i use today',
    'did i watch the game last night',
    'how long was i on youtube',
  ]) {
    it(`"${msg}" → isActivityQuery:true + suggestedIntent:memory_retrieve (no LLM call)`, async () => {
      const b = _countingBackend();
      const tc = await classifyTask(msg, [], b, _noopLogger);
      assertEq(tc.taskType, 'query');
      assertEq(tc.isActivityQuery, true);
      assertEq(tc.suggestedIntent, 'memory_retrieve');
      assertEq(tc.isConversationRecall, false);
      assertEq(b.calls, 0, 'pre-check must not consult the LLM');
    });
  }

  it('imperative "watch this video" still reaches the LLM — no pre-check', async () => {
    const b = _countingBackend();
    const tc = await classifyTask('watch this video', [], b, _noopLogger);
    assertEq(b.calls, 1);
    assertEq(tc.isActivityQuery, false);
  });

  it('transcript-meta "what did i say" stays isConversationRecall (checked first)', async () => {
    const b = _countingBackend();
    const tc = await classifyTask('what did i say', [], b, _noopLogger);
    assertEq(tc.isConversationRecall, true);
    assertEq(tc.isActivityQuery, false);
  });

  it('live "what\'s on my screen" is not activity recall', async () => {
    const b = _countingBackend();
    const tc = await classifyTask("what's on my screen", [], b, _noopLogger);
    assertEq(b.calls, 1);
    assertEq(tc.isActivityQuery, false);
  });
});

describe('decomposePromptV2 — activity-recall guard (typed flag)', () => {
  it('isActivityQuery:true + null suggestedIntent → memory_retrieve, LLM never consulted', async () => {
    let calls = 0;
    const r = await _decompose('what did i watch', {
      generateAnswer: async () => { calls++; return '0'; },
    }, { _taskClassification: { taskType: 'query', isActivityQuery: true } });
    assertEq(r._decomposedIntent, 'memory_retrieve');
    assertEq(r._decomposedBy, 'activity-recall-guard');
    assertEq(calls, 0);
  });

  it('isActivityQuery:true + suggestedIntent:memory_retrieve → memory_retrieve', async () => {
    const r = await _decompose('what did i watch', {
      generateAnswer: async () => '0',
    }, { _taskClassification: { taskType: 'query', isActivityQuery: true, suggestedIntent: 'memory_retrieve' } });
    assertEq(r._decomposedIntent, 'memory_retrieve');
  });

  it('no flag → guard does not fire (number call decides)', async () => {
    const r = await _decompose('what is the capital of france', {
      generateAnswer: async () => '2',
    }, { _taskClassification: { taskType: 'query', isActivityQuery: false } });
    assertEq(r._decomposedIntent, 'web_search');
    assert(r._decomposedBy !== 'activity-recall-guard');
  });

  it('contradicting hint vetoes the guard', async () => {
    const r = await _decompose('what was the video about', {
      generateAnswer: async () => '2',
    }, {
      _taskClassification: { taskType: 'query', isActivityQuery: true },
      _carriedHint: 'web_search',
    });
    assertEq(r._decomposedIntent, 'web_search');
  });

  it('multi-goal conjunction skips the guard', async () => {
    const r = await _decompose('what did i watch and then order a pizza', {
      generateAnswer: async () => '2',
    }, { _taskClassification: { taskType: 'query', isActivityQuery: true } });
    assert(r._decomposedBy !== 'activity-recall-guard');
  });

  it('bound-referent veto EXEMPTS isActivityQuery — recall survives a bound tab', async () => {
    const r = await _decompose('what was the video about', {
      generateAnswer: async () => '4',
    }, {
      _taskClassification: { taskType: 'query', isActivityQuery: true },
      _carriedHint: 'web_search', // vetoes the guard so the decision reaches the bound veto
      _onScreenRef: { url: 'https://www.youtube.com/watch?v=abc', sessionId: 's1' },
    });
    assertEq(r._decomposedIntent, 'memory_retrieve');
  });

  it('bound-referent veto still fires WITHOUT isActivityQuery', async () => {
    // Number call picks memory_retrieve ('4') → bound veto flips to
    // command_automate → taskType=query contradiction check escalates to the
    // full llmDecompose, which must return valid plan JSON (second call).
    let calls = 0;
    const r = await _decompose('what was the video about', {
      generateAnswer: async () => (++calls === 1
        ? '4'
        : JSON.stringify({ subPrompts: [{ text: 'act on the video', estimatedIntent: 'command_automate', order: 0 }] })),
    }, {
      _taskClassification: { taskType: 'query', isActivityQuery: false },
      _carriedHint: 'web_search',
      _onScreenRef: { url: 'https://www.youtube.com/watch?v=abc', sessionId: 's1' },
    });
    assert(r._decomposedIntent !== 'memory_retrieve', 'vetoed memory_retrieve must not stand on a bound tab');
    assertEq(r._decomposedIntent, 'command_automate');
  });
});

describe('routeTable — activity-recall rule', () => {
  it('isActivityQuery → memory_retrieve (even with flaky webAccessMode)', () => {
    const s = suggestIntent({ taskType: 'query', isActivityQuery: true, webAccessMode: 'public_read' }, 'what did i watch');
    assertEq(s && s.intent, 'memory_retrieve');
    assertEq(s && s.rule, 'activity-recall');
  });
  it('multi-goal leaves the table silent', () => {
    const s = suggestIntent({ taskType: 'query', isActivityQuery: true }, 'what did i watch and then order a pizza');
    assertEq(s, null);
  });
});

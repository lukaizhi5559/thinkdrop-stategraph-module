'use strict';
/**
 * retrieve-activity-window.test.js
 *
 * Regression tests for the activity-recall retrieval fix:
 *   1. Window padding — a parsed 1-day "today" range (5am→5am local) drops
 *      last-night's audio journals; activity queries pad startDate back ~30h
 *      for the fetch while leaving limit/diverseDays on the pre-pad range.
 *   2. audio_journal side-fetch — the boilerplate BM25 query at limit=10
 *      drowns transcript-type rows under the screen-capture flood; activity
 *      queries run a dedicated type:['audio_journal'] fetch with the real
 *      query terms and merge via id-dedup.
 *   3. Non-activity queries unchanged — no pad, no second fetch.
 *
 * Run with: node test/retrieve-activity-window.test.js
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
const retrieveMemory = require('../src/nodes/retrieveMemory.js');

// The parsed "today" window observed in the live failure (5am→5am local).
const TODAY_RANGE = { startDate: '2026-11-06 05:00:00', endDate: '2026-11-07 04:59:59' };

function makeAdapter(mainRows, audioRows) {
  const calls = [];
  return {
    calls,
    async callService(service, action, payload) {
      calls.push({ key: `${service}.${action}`, payload });
      if (action === 'episodic.search') {
        const types = payload?.filters?.type || [];
        if (types.length === 1 && types[0] === 'audio_journal') {
          return { data: { results: audioRows } };
        }
        return { data: { results: mainRows } };
      }
      if (action === 'episodic.keywords') return { data: { keywords: [] } };
      if (action === 'episodic.apps') return { data: { apps: [] } };
      return { data: { messages: [], results: [] } };
    }
  };
}

function makeState(adapter, overrides = {}) {
  return {
    mcpAdapter: adapter,
    message: 'what videos have I been watch today',
    context: { userId: 'local_user', sessionId: 'sess_test' },
    intent: { type: 'memory_retrieve' },
    _taskClassification: { isActivityQuery: true, isFollowUp: false, isConversationRecall: false },
    _llmDateRange: { ...TODAY_RANGE },
    conversationHistory: [],
    logger: _noopLogger,
    ...overrides
  };
}

const SCREEN_ROW = id => ({ id, type: 'screen_capture', text: 'browser capture', created_at: '2026-11-06 20:00:00', metadata: {} });
const AUDIO_ROW = id => ({ id, type: 'audio_journal', text: 'sermon transcript chunk', created_at: '2026-11-06 03:40:00', metadata: {} });

describe('activity-recall retrieval window + audio side-fetch', () => {

  it('pads a short activity window ~30h so last-night journals are inside it', async () => {
    const adapter = makeAdapter([SCREEN_ROW('s1')], []);
    const out = await retrieveMemory(makeState(adapter));
    const episodic = adapter.calls.filter(c => c.key === 'user-memory.episodic.search');
    assert(episodic.length >= 1, 'expected at least one episodic.search call');
    // Nov-6 05:00 minus 30h = Nov-4 23:00 (local-naive, TZ-independent)
    assertEq(episodic[0].payload.startDate, '2026-11-04 23:00:00', 'padded startDate');
    assertEq(episodic[0].payload.endDate, '2026-11-07 04:59:59', 'endDate unchanged');
  });

  it('runs a dedicated type:[audio_journal] fetch with real query terms', async () => {
    const adapter = makeAdapter([SCREEN_ROW('s1')], [AUDIO_ROW('a1')]);
    await retrieveMemory(makeState(adapter));
    const episodic = adapter.calls.filter(c => c.key === 'user-memory.episodic.search');
    assertEq(episodic.length, 2, 'expected main + audio_journal episodic.search calls');
    const side = episodic.find(c => (c.payload.filters?.type || []).length === 1);
    assert(side, 'no audio_journal-filtered call found');
    assertEq(JSON.stringify(side.payload.filters.type), '["audio_journal"]', 'side-fetch type filter');
    assertEq(side.payload.startDate, '2026-11-04 23:00:00', 'side-fetch uses same padded range');
    assert(side.payload.query && side.payload.query !== 'activity screen apps websites browser video music read',
      `side-fetch should use real query terms, got "${side.payload.query}"`);
  });

  it('merges audio_journal rows into memories via id-dedup', async () => {
    const adapter = makeAdapter([SCREEN_ROW('s1'), SCREEN_ROW('s2')], [AUDIO_ROW('a1'), AUDIO_ROW('s1')]);
    const out = await retrieveMemory(makeState(adapter));
    const ids = (out.memories || []).map(m => m.id);
    assert(ids.includes('a1'), `audio row a1 missing from memories: ${ids.join(',')}`);
    assertEq(ids.filter(i => i === 's1').length, 1, 'duplicate id leaked through merge');
    const a1 = (out.memories || []).find(m => m.id === 'a1');
    assertEq(a1?.type, 'audio_journal', 'row type must survive formatting — answer.js labels from it');
  });

  it('non-activity queries: no pad, no side-fetch', async () => {
    const adapter = makeAdapter([SCREEN_ROW('s1')], [AUDIO_ROW('a1')]);
    await retrieveMemory(makeState(adapter, {
      message: 'summarize my notes from today',
      _taskClassification: { isActivityQuery: false, isFollowUp: false, isConversationRecall: false }
    }));
    const episodic = adapter.calls.filter(c => c.key === 'user-memory.episodic.search');
    assertEq(episodic.length, 1, `expected exactly one episodic.search call, got ${episodic.length}`);
    assertEq(episodic[0].payload.startDate, '2026-11-06 05:00:00', 'unpadded startDate');
  });
});

process.on('beforeExit', () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${_passed} passed, ${_failed} failed`);
  if (_failures.length) {
    console.log('  Failures:');
    _failures.forEach(f => console.log(`    - ${f.label}: ${f.error}`));
  }
  process.exitCode = _failed ? 1 : 0;
});

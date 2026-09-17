'use strict';
/**
 * recall-context.test.js
 *
 * Regression tests for the cross-session recall fix:
 *   1. parseDateRange word-boundary month matching — "walmart" must NOT
 *      parse as "march" (substring match bug searched the wrong month)
 *   2. CONV_RECALL_QUERY_RE — recall queries ("did I send messages…",
 *      "list my last 8 prompts") trigger cross-session fetches even with
 *      no explicit date range
 *   3. _selectPriorSynthesis — skips send-confirmation syntheses so
 *      "email me these addresses" picks the content-producing synthesis
 *   4. _collectSessionResults — pulls each contributing session's last
 *      assistant synthesis so task RESULTS (not just matching user
 *      prompts) enter the context
 *
 * Run with: node test/recall-context.test.js
 */

// ─── Minimal test harness (matches tab-flow-tab-map.test.js style) ───────────
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

// ─── Load modules ────────────────────────────────────────────────────────────
const { parseDateRange } = require('../src/utils/parseDateRange');
const retrieveMemory = require('../src/nodes/retrieveMemory.js');
const planSkillsV2 = require('../src/nodes/planSkillsV2.js');
const resolveReferencesV2 = require('../src/nodes/resolveReferencesV2.js');
const answer = require('../src/nodes/answer.js');
const synthesize = require('../src/nodes/synthesize.js');

const { _selectPriorSynthesis } = planSkillsV2;
const { _collectSessionResults } = resolveReferencesV2;
const { CONV_RECALL_QUERY_RE } = retrieveMemory;
const { _buildRecallHistoryBlock } = answer;
const { _hasBounceMarker } = synthesize;
const { classifyTask } = require('../src/utils/classifyTask.js');
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');

// ─── parseDateRange — word-boundary month matching ───────────────────────────

describe('parseDateRange — month false positives', () => {
  it('"did I send any messages regarding target or walmart" → null (walmart ≠ march)', () => {
    const r = parseDateRange('did I send any messages regarding target or walmart');
    assertEq(r, null);
  });

  it('"walmart" alone → null', () => {
    assertEq(parseDateRange('walmart'), null);
  });

  it('"emails from walmart last week" still parses last week (not march)', () => {
    const r = parseDateRange('emails from walmart last week');
    assert(r && r.startDate, 'expected a date range for "last week"');
    const start = new Date(r.startDate);
    // "last week" is a ~7-day window, NOT a month boundary
    assert(new Date(r.endDate) - start <= 8 * 86400000, 'last-week window should be ~7 days');
  });

  it('"what did I do in march" → March range (real month still parses)', () => {
    const r = parseDateRange('what did I do in march');
    assert(r && r.startDate && r.endDate, 'expected a March range');
    assert(new Date(r.startDate).getMonth() === 2, 'startDate should be March (month index 2)');
  });

  it('"what did we discuss in january" → January range', () => {
    const r = parseDateRange('what did we discuss in january');
    assert(r && r.startDate, 'expected a January range');
    assert(new Date(r.startDate).getMonth() === 0, 'startDate should be January');
  });

  it('"yesterday" still parses', () => {
    const r = parseDateRange('what did I do yesterday');
    assert(r && r.startDate && r.endDate, 'expected a yesterday range');
  });
});

// ─── CONV_RECALL_QUERY_RE — recall-query detection ───────────────────────────

describe('CONV_RECALL_QUERY_RE — recall detection', () => {
  it('"Did I send any messages regarding target or walmart" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('Did I send any messages regarding target or walmart'));
  });

  it('"list my last 8 prompts" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('list my last 8 prompts'));
  });

  it('"what did we discuss about the project" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('what did we discuss about the project'));
  });

  it('"what were my recent searches" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('what were my recent searches'));
  });

  it('"repeat my last request" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('repeat my last request'));
  });

  it('"what was the last thing i asked" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('what was the last thing i asked'));
  });

  it('"show me my earlier questions" → true', () => {
    assert(CONV_RECALL_QUERY_RE.test('show me my earlier questions'));
  });

  it('"what was the last movie i watched" → false (activity, not recall)', () => {
    assert(!CONV_RECALL_QUERY_RE.test('what was the last movie i watched'));
  });

  it('"what\'s my name" → false (profile query, not recall)', () => {
    assert(!CONV_RECALL_QUERY_RE.test("what's my name"));
  });

  it('"email me these addresses" → false (command, not recall)', () => {
    assert(!CONV_RECALL_QUERY_RE.test('email me these addresses'));
  });

  it('"search for walmart stores near me" → false (web search, not recall)', () => {
    assert(!CONV_RECALL_QUERY_RE.test('search for walmart stores near me'));
  });
});

// ─── _selectPriorSynthesis — skip send-confirmations ─────────────────────────

const _SYNTH = (body) => `Step outputs:\n[synthesize]:\n${body}`;

describe('_selectPriorSynthesis — confirmation skipping', () => {
  it('picks the content synthesis over a later send-confirmation', () => {
    const history = [
      { role: 'user', content: 'find target and walmart addresses near me' },
      { role: 'assistant', content: _SYNTH('Target: 123 Main St. Walmart: 456 Oak Ave.') },
      { role: 'user', content: 'email me these addresses' },
      { role: 'assistant', content: _SYNTH('Confirmed sent — the email was sent to you.') },
    ];
    const picked = _selectPriorSynthesis(history);
    assert(picked && picked.includes('Target: 123 Main St'), `expected store addresses, got: ${picked}`);
  });

  it('falls back to the confirmation when it is the only synthesis', () => {
    const history = [
      { role: 'user', content: 'send the report' },
      { role: 'assistant', content: _SYNTH('Confirmed sent.\nBody Content: quarterly numbers') },
    ];
    const picked = _selectPriorSynthesis(history);
    assert(picked && picked.includes('quarterly numbers'), `expected fallback content, got: ${picked}`);
  });

  it('returns null when no synthesis exists', () => {
    assertEq(_selectPriorSynthesis([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]), null);
  });

  it('finds synthesis in older (semantic-result) messages, not just the last 5 turns', () => {
    const history = [
      { role: 'assistant', content: _SYNTH('store list: T@1 First St, W@2 Second St'), source: 'semantic-result' },
      // many unrelated recent turns push the synthesis out of a last-5 window
      ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `unrelated ${i}` })),
    ];
    const picked = _selectPriorSynthesis(history);
    assert(picked && picked.includes('store list'), `expected older synthesis, got: ${picked}`);
  });
});

// ─── _collectSessionResults — session synthesis enrichment ───────────────────

describe('_collectSessionResults — session result enrichment', () => {
  it('fetches the last synthesis per contributing session, skipping the current one', async () => {
    const calls = [];
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        calls.push({ action, payload });
        if (action === 'message.list') {
          const sid = payload.sessionId;
          if (sid === 'sess-old') {
            return { messages: [
              { id: 'm3', sender: 'assistant', text: 'Step outputs:\n[synthesize]:\nTarget: 123 Main St', timestamp: '2026-09-15 10:00:00' },
              { id: 'm2', sender: 'user', text: 'find addresses', timestamp: '2026-09-15 09:59:00' },
            ] };
          }
          if (sid === 'sess-other') {
            return { messages: [
              { id: 'm9', sender: 'assistant', text: 'plain reply, no synthesis', timestamp: '2026-09-14 10:00:00' },
            ] };
          }
        }
        return { messages: [] };
      },
    };
    const results = await _collectSessionResults(mcpAdapter, ['sess-old', 'sess-current', 'sess-other'], 'sess-current', _noopLogger);
    assertEq(results.length, 2, 'one result per non-current session');
    const old = results.find(r => r.sessionId === 'sess-old');
    assert(old && old.content.includes('Target: 123 Main St'), 'expected the synthesis message');
    assertEq(old.source, 'semantic-result');
    assert(old.id === 'm3', 'should pick the assistant synthesis, not the user prompt');
    // never fetched the current session
    assert(!calls.some(c => c.payload.sessionId === 'sess-current'), 'must not query current session');
  });

  it('caps at 3 sessions and returns [] on empty input', async () => {
    let callCount = 0;
    const mcpAdapter = { callService: async () => { callCount++; return { messages: [{ id: 'x', sender: 'assistant', text: 's' }] }; } };
    const r1 = await _collectSessionResults(mcpAdapter, [], 'cur', _noopLogger);
    assertEq(r1.length, 0);
    assertEq(callCount, 0);
    await _collectSessionResults(mcpAdapter, ['a', 'b', 'c', 'd', 'e'], 'cur', _noopLogger);
    assertEq(callCount, 3, 'should cap at 3 session fetches');
  });
});

// ─── classifyTask — screen clarification follow-up regression ────────────────

describe('classifyTask — screen clarification follow-up', () => {
  const history = [
    { role: 'user', content: 'what this here' },
    { role: 'assistant', content: 'This is a Copilot Screen Assistant snippet comparing AI models for planning.' },
    { role: 'user', content: 'do you agree with the response or not?' },
    { role: 'assistant', content: 'There are caveats to that recommendation.' },
    { role: 'user', content: 'why not' },
    { role: 'assistant', content: 'Because the task complexity matters.' },
    { role: 'user', content: 'what would you suggest' },
    { role: 'assistant', content: 'Use the engineering-focused model for architecture.' },
  ];

  it('exposes the full context window + clarification signal to the LLM', async () => {
    let prompt = '', sysPrompt = '';
    await classifyTask(
      'are you referring to the models still',
      history,
      { generateAnswer: async (p, opts) => { prompt = p; sysPrompt = opts?.context?.systemInstructions || ''; return JSON.stringify({ taskType: 'query', isFollowUp: true, followUpTarget: 'the AI model comparison', isScreenFollowUp: false, webAccessMode: 'none' }); } },
      _noopLogger,
      'PRIOR SCREEN CONTEXT (captured 1 min ago): App: Google Chrome, Window: Google AI Mode',
    );
    assert(prompt.includes('what this here'), 'classifier prompt should retain the original screen question');
    assert(prompt.includes('what would you suggest'), 'classifier prompt should retain intervening turns');
    assert(prompt.includes('PRIOR SCREEN CONTEXT'), 'classifier prompt should carry the prior screen block');
    assert(/are you referring to/i.test(sysPrompt), 'system prompt should list clarification phrasing as a follow-up signal');
  });

  it('passes the LLM-resolved follow-up through without forcing', async () => {
    const result = await classifyTask(
      'are you referring to the models still',
      history,
      { generateAnswer: async () => JSON.stringify({ taskType: 'query', isFollowUp: true, followUpTarget: 'the AI model comparison', isScreenFollowUp: false, webAccessMode: 'none' }) },
      _noopLogger,
      'PRIOR SCREEN CONTEXT (captured 1 min ago): App: Google Chrome, Window: Google AI Mode',
    );
    assert(result.isFollowUp, 'LLM-resolved follow-up should pass through');
    assertEq(result.followUpTarget, 'the AI model comparison', 'resolved referent should pass through');
    assert(!result.isScreenFollowUp, 'conversation referent should not force screen context');
  });

  it('does not turn a standalone still-model definition into a follow-up', async () => {
    const result = await classifyTask(
      'what is a still model',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'query', isFollowUp: false, followUpTarget: null, isScreenFollowUp: false, webAccessMode: 'none' }) },
      _noopLogger,
    );
    assert(!result.isFollowUp, 'standalone definition should not be a follow-up');
    assert(!result.isScreenFollowUp, 'standalone definition should not use screen context');
  });
});

// ─── decomposePromptV2 — screen-observation short-circuit guard ──────────────
// Regression: passive screen reads classified local_system were force-routed to
// command_automate by the single-step short-circuit, skipping the LLM decision
// whose screen_intelligence rule would have caught them. needsFreshScreen must
// bypass the short-circuit; plain local_system must not.

describe('decomposePromptV2 — screen-observation guard', () => {
  it('needsFreshScreen + local_system skips the command_automate short-circuit', async () => {
    const result = await decomposePromptV2({
      message: 'sum this up for me on the screen',
      conversationHistory: [],
      logger: _noopLogger,
      llmBackend: { generateAnswer: async () => '1' }, // fast decision → screen_intelligence
      _taskClassification: { taskType: 'local_system', needsFreshScreen: true },
    });
    assert(result._decomposedBy !== 'local-short-circuit', 'must not short-circuit to command_automate');
    assertEq(result._decomposedIntent, 'screen_intelligence', 'LLM decision should route to screen_intelligence');
  });

  it('local_system without screen flags still short-circuits to command_automate', async () => {
    let llmCalled = false;
    const result = await decomposePromptV2({
      message: 'take a screenshot',
      conversationHistory: [],
      logger: _noopLogger,
      llmBackend: { generateAnswer: async () => { llmCalled = true; return '0'; } },
      _taskClassification: { taskType: 'local_system' },
    });
    assertEq(result._decomposedIntent, 'command_automate');
    assertEq(result._decomposedBy, 'local-short-circuit');
    assert(!llmCalled, 'LLM decision should not be called on the short-circuit');
  });

  it('needsFreshScreen + query does not get captured by the query-follow-up guard', async () => {
    const result = await decomposePromptV2({
      message: 'what does this mean',
      conversationHistory: [{ role: 'user', content: 'look at the error dialog' }, { role: 'assistant', content: 'I see a dialog.' }],
      logger: _noopLogger,
      llmBackend: { generateAnswer: async () => '1' },
      _taskClassification: { taskType: 'query', isFollowUp: true, followUpTarget: 'the error dialog', needsFreshScreen: true },
    });
    assert(result._decomposedIntent !== 'web_search', 'screen deictic must not route to web_search');
  });
});

// ─── _buildRecallHistoryBlock — recall answer window ─────────────────────────

describe('_buildRecallHistoryBlock — recall window + prompts section', () => {
  const _mkHistory = (n) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg ${i}`,
    timestamp: `2026-09-15 ${String(10 + Math.floor(i / 2)).padStart(2, '0')}:00:00`,
    formattedDate: { absolute: `Sep 15 ${i}` },
  }));

  it('recall: interleaved block shows up to 30 messages (not 12)', () => {
    const text = _buildRecallHistoryBlock(_mkHistory(40), true);
    const entries = (text.match(/Previous AI Response|User:/g) || []).length;
    assert(entries >= 29, `expected ~30 entries in interleaved block, got ${entries}`);
  });

  it('recall: RECENT USER PROMPTS section lists up to 40 user prompts with dates', () => {
    const text = _buildRecallHistoryBlock(_mkHistory(80), true);
    assert(text.includes('=== RECENT USER PROMPTS'), 'missing prompts section');
    const section = text.split('=== RECENT USER PROMPTS')[1].split('=== END USER PROMPTS')[0];
    const lines = section.trim().split('\n').filter(l => /^\[\d+\]/.test(l));
    assertEq(lines.length, 40, 'prompts section should hold the last 40 user prompts');
    assert(lines[0].includes('msg 0'), 'oldest first');
    assert(lines[lines.length - 1].includes('msg 78'), 'newest last');
    assert(lines[0].includes('Sep 15'), 'entries carry dates');
  });

  it('non-recall: keeps the -5 slice and no prompts section', () => {
    const text = _buildRecallHistoryBlock(_mkHistory(40), false);
    const entries = (text.match(/\[\d+\]/g) || []).length;
    assertEq(entries, 5, 'non-recall should show last 5 only');
    assert(!text.includes('RECENT USER PROMPTS'), 'no prompts section for non-recall');
  });
});

// ─── _hasBounceMarker — strong/weak bounce gating ────────────────────────────

describe('_hasBounceMarker — bounce detection', () => {
  it('strong marker alone → true', () => {
    assert(_hasBounceMarker('From: Mail Delivery Subsystem — Address not found', 'confirm email sent'));
  });

  it('"address not found" in a store-locator context → false (generic phrase)', () => {
    const ctx = 'Target store locator: no results — address not found for ZIP 99999';
    assert(!_hasBounceMarker(ctx, 'summarize the store locations'));
  });

  it('weak marker + mail context + send prompt → true', () => {
    const ctx = 'Sent Mail — Location Addresses — delivery report: address not found';
    assert(_hasBounceMarker(ctx, 'confirm the email was sent'));
  });

  it('weak marker + mail context + non-send prompt → false', () => {
    const ctx = 'Inbox: delivery report — address not found (gmail)';
    assert(!_hasBounceMarker(ctx, 'summarize my inbox'));
  });

  it('no bounce markers → false', () => {
    assert(!_hasBounceMarker('Email sent successfully to bob@example.com', 'confirm email sent'));
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

(async () => {
  // async `it` calls above have already resolved by the time we reach here in
  // practice for sync describes; the async ones are awaited via their promises.
  setImmediate(() => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${_passed} passed, ${_failed} failed`);
    console.log('═'.repeat(70));
    if (_failures.length > 0) {
      _failures.forEach(f => console.log(`  FAILED: ${f.label} — ${f.error}`));
      process.exit(1);
    }
    process.exit(0);
  });
})();

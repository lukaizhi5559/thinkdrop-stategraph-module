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

// ─── parseDateRange — vague relative quantifiers ────────────────────────────
// Regression: "the last couple days" returned null → fell through to the LLM
// fallback which hallucinated 2023 dates and searched an empty window.

describe('parseDateRange — couple/few/several phrasings', () => {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  it('"the last couple days" → ~2-day window ending today', () => {
    const r = parseDateRange('No what have we been chatting about for the last couple days');
    assert(r && r.startDate && r.endDate, 'expected a range');
    const spanDays = (new Date(r.endDate) - new Date(r.startDate)) / 86400000;
    assert(spanDays >= 1.5 && spanDays <= 4, `expected ~2-3 day window, got ${spanDays} days`);
    assert(new Date(r.endDate) >= todayStart, 'endDate must reach today');
  });

  it('"last few days" → ~3-day window', () => {
    const r = parseDateRange('what did we talk about over the last few days');
    assert(r && r.startDate, 'expected a range');
    const spanDays = (new Date(r.endDate) - new Date(r.startDate)) / 86400000;
    assert(spanDays >= 2.5 && spanDays <= 5, `expected ~3-4 day window, got ${spanDays} days`);
  });

  it('"a couple days ago" → non-null window ending today', () => {
    const r = parseDateRange('what did I ask you a couple days ago');
    assert(r && r.startDate && r.endDate, 'expected a range');
    assert(new Date(r.endDate) >= todayStart, 'endDate must reach today');
  });

  it('"a few days ago" → non-null', () => {
    const r = parseDateRange('the prompt I sent a few days ago');
    assert(r && r.startDate, 'expected a range');
  });

  it('"several days ago" → ~4-day window', () => {
    const r = parseDateRange('what did we discuss several days ago');
    assert(r && r.startDate, 'expected a range');
    const spanDays = (new Date(r.endDate) - new Date(r.startDate)) / 86400000;
    assert(spanDays >= 3.5 && spanDays <= 6, `expected ~4-5 day window, got ${spanDays} days`);
  });

  it('"the other day" → recent window', () => {
    const r = parseDateRange('that article I saw the other day');
    assert(r && r.startDate, 'expected a range');
    assert(new Date(r.endDate) >= todayStart, 'endDate must reach today');
  });

  it('"a day or two ago" → ~2-day window', () => {
    const r = parseDateRange('the file from a day or two ago');
    assert(r && r.startDate, 'expected a range');
  });

  it('"last couple of weeks" → ~14-day window', () => {
    const r = parseDateRange('what was I working on the last couple of weeks');
    assert(r && r.startDate, 'expected a range');
    const spanDays = (new Date(r.endDate) - new Date(r.startDate)) / 86400000;
    assert(spanDays >= 10 && spanDays <= 21, `expected ~14 day window, got ${spanDays} days`);
  });

  it('numeric "last 2 days" still parses (regression)', () => {
    const r = parseDateRange('what did we talk about the last 2 days');
    assert(r && r.startDate, 'expected a range');
  });

  it('"past couple of days" still parses (regression)', () => {
    const r = parseDateRange('what happened over the past couple of days');
    assert(r && r.startDate, 'expected a range');
  });
});

// ─── _llmDateFallback — stale-range guard + today anchor ─────────────────────
// Regression: the fallback prompt never stated today's date, so the LLM
// returned Oct-2023 for "the last couple days" and recall searched an empty
// window. Now: prompt carries CURRENT DATE AND TIME, and relative-phrased
// queries discard ranges that end before today.

const { _llmDateFallback } = retrieveMemory;

describe('_llmDateFallback — stale-range guard', () => {
  const staleLLM = { generateAnswer: async () => '{"startDate":"2023-10-22 00:00:00","endDate":"2023-10-24 23:59:59"}' };

  it('discards a stale LLM range for relative phrasing ("last couple days")', async () => {
    const r = await _llmDateFallback('what have we been chatting about for the last couple days', staleLLM, _noopLogger);
    assertEq(r, null, 'stale 2023 range must be discarded for relative phrasing');
  });

  it('keeps a stale range for absolute phrasing ("in october 2023")', async () => {
    const r = await _llmDateFallback('what did I do in october 2023', staleLLM, _noopLogger);
    assert(r && r.startDate === '2023-10-22 00:00:00', 'absolute dates must pass through untouched');
  });

  it('keeps a fresh range for relative phrasing', async () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const s = new Date(now); s.setDate(s.getDate() - 2); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 0);
    const freshLLM = { generateAnswer: async () => `{"startDate":"${fmt(s)}","endDate":"${fmt(e)}"}` };
    const r = await _llmDateFallback('what did we talk about lately', freshLLM, _noopLogger);
    assert(r && r.startDate === fmt(s), 'a range ending today must be kept');
  });

  it('prompt carries the current date so the LLM can anchor "ago/last"', async () => {
    let seenPrompt = '';
    const capLLM = { generateAnswer: async (p) => { seenPrompt = p; return null; } };
    await _llmDateFallback('what did we discuss last week', capLLM, _noopLogger);
    const yr = new Date().getFullYear();
    assert(seenPrompt.includes('CURRENT DATE AND TIME'), 'prompt must anchor the current date');
    assert(seenPrompt.includes(String(yr)), `prompt must include current year ${yr}`);
  });
});

// ─── retrieveMemory — cross-session message.search wiring ────────────────────
// Regression: the recall path called message.search without sessionId or
// searchAllSessions → the endpoint 500s, silently killing topical recall across
// older sessions.

describe('retrieveMemory — message.search passes searchAllSessions', () => {
  it('cross-session semantic search is enabled for recall queries', async () => {
    const calls = [];
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        calls.push({ svc, action, payload });
        if (action === 'message.list' || action === 'message.listByDate') return { messages: [] };
        if (action === 'message.search') {
          if (!payload.searchAllSessions) throw new Error('sessionId is required (or set searchAllSessions=true)');
          return { messages: [] };
        }
        return { results: [], apps: [], keywords: [] };
      },
    };
    await retrieveMemory({
      message: 'what did we talk about earlier this week',
      resolvedMessage: 'what did we talk about earlier this week',
      intent: { type: 'memory_retrieve' },
      context: { sessionId: 'sess-current', userId: 'local_user' },
      mcpAdapter,
      logger: _noopLogger,
      conversationHistory: [],
      _taskClassification: { isConversationRecall: true },
    });
    const searchCalls = calls.filter(c => c.action === 'message.search');
    assert(searchCalls.length > 0, 'message.search should be called for a recall query');
    for (const c of searchCalls) {
      assertEq(c.payload.searchAllSessions, true, 'searchAllSessions must be true');
      assertEq(c.payload.sessionId, 'sess-current', 'sessionId should be forwarded');
    }
  });
});

// ─── retrieveMemory — unconditional cross-session search for memory_retrieve ──
// Regression: recall phrasings ("remember when I asked you about X",
// "that time we chatted about Y") matched NO recall regex and the LLM
// isConversationRecall flag came back false, so message.search / listByDate /
// episodic never ran and topical recall silently returned nothing. Retrieval
// breadth is now driven by the intent classifier, not secondary NLU patterns.

describe('retrieveMemory — memory_retrieve triggers all recall sources without flags', () => {
  const recallPhrasings = [
    'remember when I asked you about president trump',
    'what about that time we chatted about the flower project',
    'do you remember that appointment I had at the dentist',
  ];

  for (const phrase of recallPhrasings) {
    it(`"${phrase}" → message.search fires (scanAllSessions) despite no recall flags`, async () => {
      const calls = [];
      const mcpAdapter = {
        callService: async (svc, action, payload) => {
          calls.push({ svc, action, payload });
          if (action === 'message.list' || action === 'message.listByDate') return { messages: [] };
          if (action === 'message.search') return { messages: [] };
          return { results: [], apps: [], keywords: [] };
        },
      };
      await retrieveMemory({
        message: phrase,
        resolvedMessage: phrase,
        intent: { type: 'memory_retrieve' },
        context: { sessionId: 'sess-current', userId: 'local_user' },
        mcpAdapter,
        logger: _noopLogger,
        conversationHistory: [],
        _taskClassification: { isConversationRecall: false, isFollowUp: false, isActivityQuery: false },
      });
      const searchCalls = calls.filter(c => c.action === 'message.search');
      assert(searchCalls.length > 0, `message.search should fire for "${phrase}"`);
      for (const c of searchCalls) {
        assertEq(c.payload.searchAllSessions, true, 'searchAllSessions must be true');
        assertEq(c.payload.scanAllSessions, true, 'scanAllSessions must be true (bypass tier-1 topic filter)');
      }
      const crossCalls = calls.filter(c => c.action === 'message.listByDate');
      assert(crossCalls.length > 0, 'cross-session listByDate should fire for memory_retrieve');
      const episodicCalls = calls.filter(c => c.action === 'episodic.search');
      assert(episodicCalls.length > 0, 'wide-window episodic.search should fire for memory_retrieve with no dateRange');
    });
  }

  it('semantic hits expose source/similarity/sessionTitle and exclude the self-match', async () => {
    const phrase = 'remember when I asked you about president trump';
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        if (action === 'message.list' || action === 'message.listByDate') return { messages: [] };
        if (action === 'message.search') return {
          messages: [
            // The just-logged current user turn — must be filtered out.
            { id: 'm1', sessionId: 'sess-current', text: phrase, sender: 'user', timestamp: new Date().toISOString(), similarity: 1.0, sessionTitle: 'current' },
            { id: 'm2', sessionId: 'old-sess', text: 'show me picture of president trump', sender: 'user', timestamp: '2026-09-19T23:11:21.361Z', similarity: 0.47, sessionTitle: 'Old session' },
          ],
        };
        return { results: [], apps: [], keywords: [] };
      },
    };
    const out = await retrieveMemory({
      message: phrase,
      resolvedMessage: phrase,
      intent: { type: 'memory_retrieve' },
      context: { sessionId: 'sess-current', userId: 'local_user' },
      mcpAdapter,
      logger: _noopLogger,
      conversationHistory: [],
      _taskClassification: { isConversationRecall: false },
    });
    assert(Array.isArray(out.semanticMatches), 'semanticMatches should be an array');
    assertEq(out.semanticMatches.length, 1, 'self-match must be excluded from semanticMatches');
    assertEq(out.semanticMatches[0].id, 'm2');
    assertEq(out.semanticMatches[0].source, 'semantic', 'source marker must be preserved');
    assert(out.semanticMatches[0].similarity > 0, 'similarity must be preserved');
    assertEq(out.semanticMatches[0].sessionTitle, 'Old session', 'sessionTitle must be preserved');
    assert(Array.isArray(out.taskMatches), 'taskMatches should always be an array');
  });
});

// ─── searchTaskJournal — queue journal keyword search ─────────────────────────

describe('searchTaskJournal — keyword search over the queue journal', () => {
  it('matches tasks by prompt keywords and returns metadata', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `td-journal-test-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify([
      { id: 'task_a', prompt: 'review the flowers project folder and make a pdf', status: 'done', createdAt: Date.now() - 86400000, result: 'PDF created at ~/Desktop/flowers.pdf' },
      { id: 'task_b', prompt: 'unrelated grocery list task', status: 'done', createdAt: Date.now() - 172800000, result: null },
    ]));
    process.env.TASK_JOURNAL_PATH = tmp;
    try {
      const { searchTaskJournal } = require('../src/utils/taskJournalSearch.cjs');
      const hits = searchTaskJournal('what about that time we chatted about the flower project');
      assert(hits.length > 0, 'expected at least one journal hit');
      assertEq(hits[0].id, 'task_a', 'flower task should rank first (plural stem flower↔flowers)');
      assert(hits[0].formattedDate, 'hit should carry a formatted date');
      assertEq(hits[0].status, 'done');
    } finally {
      delete process.env.TASK_JOURNAL_PATH;
      fs.unlinkSync(tmp);
    }
  });

  it('missing journal file → []', () => {
    process.env.TASK_JOURNAL_PATH = '/tmp/definitely-not-here-td.json';
    try {
      const { searchTaskJournal } = require('../src/utils/taskJournalSearch.cjs');
      assertEq(searchTaskJournal('anything at all').length, 0, 'missing file must return []');
    } finally {
      delete process.env.TASK_JOURNAL_PATH;
    }
  });
});

// ─── resolveReferencesV2 — prior-session fallback for empty sessions ─────────
// Regression: "how many unread" 2 min after a Gmail task was routed into a
// brand-new empty session (sessionRouter age-rotated the just-reactivated
// session). With 0 recent messages, only stale cross-session semantic hits
// remained and classifyTask resolved followUpTarget to an unrelated file path.
// Fix: when the routed session is empty, pull the most recent other session's
// tail as source:'prior-session' context.

describe('resolveReferencesV2 — prior-session fallback for empty sessions', () => {
  const BASE_CLASSIFY_JSON = JSON.stringify({
    taskType: 'query', isFollowUp: true, followUpTarget: 'gmail emails',
    needsClarification: false, targetService: 'gmail', isRecurring: false,
    isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
    needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
    isImageAnalysis: false, isConversationRecall: false, isActivityQuery: false,
    webAccessMode: 'none', interactiveActions: [], expectsFileOutput: false,
    activeDocRef: null, activeDocTarget: null,
  });

  it('empty routed session pulls the previous session tail as prior-session context', async () => {
    const calls = [];
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        calls.push({ svc, action, payload });
        if (action === 'message.list') {
          if (payload.sessionId === 'sess-new') return { messages: [] };
          if (payload.sessionId === 'sess-gmail') return {
            messages: [
              { id: 'g2', sender: 'assistant', text: 'Found 3 emails from Pastor Wendal', timestamp: '2026-09-24T03:31:00Z' },
              { id: 'g1', sender: 'user', text: 'check if any no emails from pastor wendal has been sent to my gmail account', timestamp: '2026-09-24T03:29:23Z' },
            ],
          };
          return { messages: [] };
        }
        if (action === 'message.search') return { messages: [] };
        if (action === 'session.list') return {
          sessions: [{ id: 'sess-new' }, { id: 'sess-gmail' }],
        };
        return {};
      },
    };
    const llmBackend = { generateAnswer: async () => BASE_CLASSIFY_JSON };
    const out = await resolveReferencesV2({
      message: 'how many unread',
      mcpAdapter,
      llmBackend,
      context: { sessionId: 'sess-new' },
      logger: _noopLogger,
    });
    const prior = (out.conversationHistory || []).filter(m => m.source === 'prior-session');
    assert(prior.length === 2, `expected 2 prior-session messages, got ${prior.length}`);
    assert(prior.some(m => /pastor wendal/i.test(m.content)), 'prior-session msgs must include the gmail turn');
    assert((out.semanticHistory || []).some(m => m.source === 'prior-session'),
      'semanticHistory should expose prior-session msgs');
  });

  it('non-empty session does NOT pull prior-session context', async () => {
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        if (action === 'message.list') return {
          messages: [{ id: 'r1', sender: 'user', text: 'earlier same-session turn', timestamp: '2026-09-24T03:30:00Z' }],
        };
        if (action === 'message.search') return { messages: [] };
        if (action === 'session.list') throw new Error('session.list must not be called when recent exists');
        return {};
      },
    };
    const llmBackend = { generateAnswer: async () => BASE_CLASSIFY_JSON };
    const out = await resolveReferencesV2({
      message: 'how many unread',
      mcpAdapter,
      llmBackend,
      context: { sessionId: 'sess-has-history' },
      logger: _noopLogger,
    });
    assert(!(out.conversationHistory || []).some(m => m.source === 'prior-session'),
      'prior-session fallback must not fire when recent history exists');
  });
});

// ─── Thought-card reply handling ─────────────────────────────────────────────
// Regression: a reply to a proactive card arrived as "[Thought: …] + reply" —
// the tag poisoned webSearch queries, decompose picked memory_store off the
// card blob, and the card never existed as a labeled conversation turn. Fix:
// structured thoughtContext metadata + tag strip + labeled synthetic turn +
// post-classify lifecycle reporting.

describe('resolveReferencesV2 — proactive card replies', () => {
  const CARD = 'The Bible study discussion on Samuel 25:3-30:5 is starting soon. Want a summary?';
  const TAG = `[Thought: ${CARD}]`;

  const makeAdapter = (over = {}) => {
    const calls = [];
    return {
      calls,
      callService: async (svc, action, payload) => {
        calls.push({ svc, action, payload });
        if (action === 'message.list') return { messages: over.recent || [] };
        if (action === 'message.search') return { messages: [] };
        if (action === 'session.list') return { sessions: [] };
        return {};
      },
    };
  };
  const classifyWith = (fields) => JSON.stringify({
    taskType: 'query', isFollowUp: false, followUpTarget: null,
    needsClarification: false, targetService: null, isRecurring: false,
    isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
    needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
    isImageAnalysis: false, isConversationRecall: false, isActivityQuery: false,
    webAccessMode: 'none', interactiveActions: [], expectsFileOutput: false,
    activeDocRef: null, activeDocTarget: null, ...fields,
  });
  const llm = (fields = {}) => ({ generateAnswer: async () => classifyWith(fields) });

  it('thoughtContext metadata: tag stripped, card injected labeled, thought.update=responded', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nthis bible study happen already`,
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: true }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_1', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(out.message, 'this bible study happen already', 'message must be reply-only');
    assertEq(out.resolvedMessage, 'this bible study happen already');
    assert(!String(out.message).includes('[Thought:'), 'tag must be stripped');
    assertEq(out._thoughtAttachment?.id, 'th_1');
    const card = (out.conversationHistory || []).find(m => m.isThoughtCard);
    assert(card, 'a labeled card turn should be in conversationHistory');
    assertEq(card.source, 'thought-attachment');
    const upd = adapter.calls.find(c => c.action === 'thought.update');
    assert(upd, 'thought.update should fire');
    assertEq(upd.payload.id, 'th_1');
    assertEq(upd.payload.updates.outcomeText, 'user responded');
  });

  it('isThoughtReply:false on an attached card → outcome "dismissed — user engaged elsewhere"', async () => {
    const adapter = makeAdapter();
    await resolveReferencesV2({
      message: `${TAG}\n\nfind Roses not just all Flowers`,
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: false, isFollowUp: true, followUpTarget: 'roses for mom' }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_9', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    const upd = adapter.calls.find(c => c.action === 'thought.update');
    assert(upd, 'thought.update should fire for the attached card');
    assertEq(upd.payload.updates.outcomeText, 'dismissed — user engaged elsewhere');
  });

  it('tag-only fallback (no metadata): parses the card, strips the tag', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nyes`,
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: true }),
      context: { sessionId: 'sess-1' },
      logger: _noopLogger,
    });
    assertEq(out.message, 'yes');
    assert(out._thoughtAttachment && out._thoughtAttachment.text === CARD, 'fallback should populate _thoughtAttachment');
    assert((out.conversationHistory || []).some(m => m.isThoughtCard), 'card turn should be injected');
  });

  it('[Context:] wins over [Thought:] — card ignored but tag still stripped', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `[Context: some isolated body]\n${TAG}\n\nuse this`,
      mcpAdapter: adapter,
      llmBackend: llm({}),
      context: { sessionId: 'iso_x' },
      _thoughtAttachment: { id: 'th_iso', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(out._thoughtAttachment, null, 'isolation must drop thought handling');
    assert(!String(out.message).includes('[Thought:'), 'tag should still be stripped');
    assert(!(adapter.calls || []).some(c => c.action === 'thought.update'), 'no lifecycle update under isolation');
  });

  it('persisted card row dedupes the synthetic turn and adopts its thoughtId', async () => {
    const persisted = {
      id: 'db_card', sender: 'assistant', text: CARD, timestamp: '2026-09-24T10:00:00Z',
      metadata: { source: 'thought_engine', thoughtId: 'th_persisted' },
    };
    const adapter = makeAdapter({ recent: [persisted] });
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nyes`,
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: true }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: null, text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    const cards = (out.conversationHistory || []).filter(m => m.isThoughtCard);
    assertEq(cards.length, 1, 'no duplicate card turn — persisted row should be reused');
    const upd = adapter.calls.find(c => c.action === 'thought.update');
    assert(upd, 'thought.update should fire');
    assertEq(upd.payload.id, 'th_persisted', 'adopted the persisted row thoughtId');
    assertEq(upd.payload.updates.outcomeText, 'user responded');
  });

  it('delayed re-engagement: no attachment + isThoughtReply → newest card row updated', async () => {
    const persisted = {
      id: 'db_card2', sender: 'assistant', text: 'I scanned your coding project. Fix issues?', timestamp: '2026-09-24T10:00:00Z',
      metadata: { source: 'thought_engine', thoughtId: 'th_delayed' },
    };
    const adapter = makeAdapter({ recent: [persisted] });
    await resolveReferencesV2({
      message: 'speaking about that coding project, fix the issues',
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: true, isFollowUp: true, followUpTarget: 'coding project issues' }),
      context: { sessionId: 'sess-1' },
      logger: _noopLogger,
    });
    const upd = adapter.calls.find(c => c.action === 'thought.update');
    assert(upd, 'delayed re-engagement should update the persisted card');
    assertEq(upd.payload.id, 'th_delayed');
    assertEq(upd.payload.updates.outcomeText, 'responded (delayed)');
  });

  // ── attachedToMessage flag + ack floor + nudge cap ──────────────────────────

  it('attached card gets attachedToMessage (dedupe path AND injected path)', async () => {
    const persisted = {
      id: 'db_card3', sender: 'assistant', text: CARD, timestamp: '2026-09-24T10:00:00Z',
      metadata: { source: 'thought_engine', thoughtId: 'th_flag' },
    };
    const adapter = makeAdapter({ recent: [persisted] });
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nsure`,
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: true }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: null, text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    const cards = (out.conversationHistory || []).filter(m => m.isThoughtCard);
    assertEq(cards.length, 1);
    assert(cards[0].attachedToMessage === true, 'deduped persisted row must be flagged attachedToMessage');
  });

  it('ack floor: "sure" + attached card + LLM no-resolution → isThoughtReply/isFollowUp', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nsure`,
      mcpAdapter: adapter,
      llmBackend: llm({}), // isFollowUp:false, isThoughtReply:false, needsClarification:false
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_ack', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(out._taskClassification.isThoughtReply, true, 'floor must set isThoughtReply');
    assertEq(out._taskClassification.isFollowUp, true, 'affirmative floor must set isFollowUp');
    assertEq(out._taskClassification.followUpTarget, CARD, 'affirmative floor resolves target to the card');
    const upd = adapter.calls.find(c => c.action === 'thought.update');
    assert(upd && upd.payload.updates.outcomeText === 'user responded', 'lifecycle must report responded');
  });

  it('ack floor: "no thanks" + attached card + LLM no-resolution → declined', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nno thanks`,
      mcpAdapter: adapter,
      llmBackend: llm({}),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_no', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(out._taskClassification.isThoughtReply, true);
    assertEq(out._taskClassification.isFollowUp, false, 'negative ack declines — no follow-up target');
    assertEq(out._taskClassification.followUpTarget, null);
  });

  it('ack floor does NOT fire when the LLM produced a resolution', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nsure`,
      mcpAdapter: adapter,
      llmBackend: llm({ isFollowUp: true, followUpTarget: 'the file update', isThoughtReply: false }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_keep', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(out._taskClassification.isThoughtReply, false, 'floor must not override an LLM judgment');
    assertEq(out._taskClassification.followUpTarget, 'the file update');
  });

  it('ack floor does NOT fire on topical replies (LLM output preserved)', async () => {
    const adapter = makeAdapter();
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nfind Roses not just all Flowers`,
      mcpAdapter: adapter,
      llmBackend: llm({ isFollowUp: true, followUpTarget: 'roses for mom' }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_top', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(out._taskClassification.isThoughtReply, false);
    assertEq(out._taskClassification.followUpTarget, 'roses for mom');
  });

  it('thought-nudge cap: >3 card rows trimmed to newest 3, attached row preserved', async () => {
    const mk = (i, txt) => ({
      id: `th_r${i}`, sender: 'assistant', text: txt || `nudge ${i}`, timestamp: `2026-09-24T09:0${i}:00Z`,
      metadata: { source: 'thought_engine', thoughtId: `th_r${i}` },
    });
    const adapter = makeAdapter({
      recent: [mk(0), mk(1), mk(2), mk(3), mk(4), mk(5, CARD)],
    });
    const out = await resolveReferencesV2({
      message: `${TAG}\n\nsure`,
      mcpAdapter: adapter,
      llmBackend: llm({ isThoughtReply: true }),
      context: { sessionId: 'sess-1' },
      _thoughtAttachment: { id: 'th_r5', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    const cards = (out.conversationHistory || []).filter(m => m.isThoughtCard);
    assertEq(cards.length, 4, `expected newest 3 + attached = 4 cards, got ${cards.length}`);
    assert(cards.some(m => m.attachedToMessage), 'attached card must survive the cap');
    assert(!cards.some(m => m.content === 'nudge 0'), 'oldest nudges must be dropped');
  });
});

// ─── classifyTask — card labeling + isThoughtReply passthrough ────────────────

describe('classifyTask — proactive card context', () => {
  it('renders isThoughtCard turns with the proactive-card label', async () => {
    let captured = '';
    const llmBackend = {
      generateAnswer: async (p) => { captured = p; return JSON.stringify({ taskType: 'query', isFollowUp: false, followUpTarget: null, isThoughtReply: true }); },
    };
    await classifyTask('yes', [
      { role: 'user', content: 'search for flowers for my mom', timestamp: '2026-09-24T10:00:00Z' },
      { role: 'assistant', content: 'Here are flower results', timestamp: '2026-09-24T10:01:00Z' },
      { role: 'assistant', content: 'I scanned your coding project. Fix issues?', timestamp: '2026-09-24T10:02:00Z', isThoughtCard: true },
    ], llmBackend, _noopLogger);
    assert(/Assistant \(proactive card shown to user earlier, not a spoken reply\): I scanned your coding project/.test(captured),
      'non-attached card turn must render with the earlier-card label');
    assert(/Assistant: Here are flower results/.test(captured), 'real assistant turns keep the plain label');
  });

  it('renders the attached card with the privileged ATTACHED label', async () => {
    let captured = '';
    const llmBackend = {
      generateAnswer: async (p) => { captured = p; return JSON.stringify({ taskType: 'query', isFollowUp: true, followUpTarget: 'card offer', isThoughtReply: true }); },
    };
    await classifyTask('sure', [
      { role: 'assistant', content: 'Earlier card', timestamp: '2026-09-24T10:01:00Z', isThoughtCard: true },
      { role: 'assistant', content: 'Want me to share Dee-1 music?', timestamp: '2026-09-24T10:02:00Z', isThoughtCard: true, attachedToMessage: true },
    ], llmBackend, _noopLogger);
    assert(/ATTACHED to the user's reply/.test(captured), 'attached card must carry the privileged label');
    assert(/ATTACHED to the user's reply[^:]*: Want me to share Dee-1 music\?/.test(captured),
      'ATTACHED label must sit on the attached card, not the earlier one');
    assert(/proactive card shown to user earlier/.test(captured), 'non-attached card keeps the earlier label');
  });

  it('parses isThoughtReply through to the output', async () => {
    const out = await classifyTask('yes', [], {
      generateAnswer: async () => JSON.stringify({ taskType: 'query', isFollowUp: true, followUpTarget: 'card offer', isThoughtReply: true }),
    }, _noopLogger);
    assertEq(out.isThoughtReply, true);
  });

  it('defaults isThoughtReply to false when the model omits it', async () => {
    const out = await classifyTask('hello there', [], {
      generateAnswer: async () => JSON.stringify({ taskType: 'ambiguous' }),
    }, _noopLogger);
    assertEq(out.isThoughtReply, false);
  });
});

// ─── retrieveMemory — transcript-meta queries skip the episodic dump ──────────
// Regression: "remember what" (isConversationRecall) pulled a 365-day screen-
// capture window (50 results) + memory-table noise, and the answer summarized
// unrelated activity instead of the last conversation turns.

describe('retrieveMemory — isConversationRecall skips episodic.search', () => {
  it('"remember what" → episodic.search NOT called; transcript sources still run', async () => {
    const calls = [];
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        calls.push({ svc, action, payload });
        if (action === 'message.list' || action === 'message.listByDate') return { messages: [] };
        if (action === 'message.search') return { messages: [] };
        return { results: [], apps: [], keywords: [] };
      },
    };
    await retrieveMemory({
      message: 'remember what',
      resolvedMessage: 'remember what',
      intent: { type: 'memory_retrieve' },
      context: { sessionId: 'sess-current', userId: 'local_user' },
      mcpAdapter,
      logger: _noopLogger,
      conversationHistory: [],
      _taskClassification: { isConversationRecall: true },
    });
    assert(!calls.some(c => c.action === 'episodic.search'),
      'episodic.search must not fire for transcript-meta questions');
    assert(calls.some(c => c.action === 'message.search'),
      'message.search should still run for transcript recall');
    assert(calls.some(c => c.action === 'message.listByDate'),
      'cross-session listByDate should still run');
  });

  it('topical recall (isConversationRecall:false) still fires episodic.search', async () => {
    const calls = [];
    const mcpAdapter = {
      callService: async (svc, action, payload) => {
        calls.push({ svc, action, payload });
        if (action === 'message.list' || action === 'message.listByDate') return { messages: [] };
        if (action === 'message.search') return { messages: [] };
        return { results: [], apps: [], keywords: [] };
      },
    };
    await retrieveMemory({
      message: 'remember when I asked you about president trump',
      resolvedMessage: 'remember when I asked you about president trump',
      intent: { type: 'memory_retrieve' },
      context: { sessionId: 'sess-current', userId: 'local_user' },
      mcpAdapter,
      logger: _noopLogger,
      conversationHistory: [],
      _taskClassification: { isConversationRecall: false },
    });
    assert(calls.some(c => c.action === 'episodic.search'),
      'wide episodic window must still fire for topical recall');
  });
});

// ─── answer.js — transcript recall prompt rules ───────────────────────────────

describe('answer._buildRecallHistoryBlock — card labels + recency rule', () => {
  it('renders card turns labeled and includes the recency-first rule for recall', () => {
    const text = _buildRecallHistoryBlock([
      { role: 'user', content: 'this bible study happen already', timestamp: '2026-09-24T10:00:00Z' },
      { role: 'assistant', content: 'Got it! I will remember that.', timestamp: '2026-09-24T10:00:30Z' },
      { role: 'assistant', content: 'Bible study is starting soon', timestamp: '2026-09-24T09:59:00Z', isThoughtCard: true },
    ], true);
    assert(text.includes('RECENCY-FIRST RULE'), 'recency-first instruction must be present for isConversationRecall');
    assert(text.includes('Proactive card shown to user'), 'card turns must render labeled');
    assert(!text.includes('Previous AI Response (may contain errors): Bible study is starting soon'),
      'card turn must NOT render as a generic AI response');
  });

  it('non-recall blocks do not get the recency-first rule', () => {
    const text = _buildRecallHistoryBlock([
      { role: 'user', content: 'hi', timestamp: '2026-09-24T10:00:00Z' },
    ], false);
    assert(!text.includes('RECENCY-FIRST RULE'), 'recency rule is recall-only');
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

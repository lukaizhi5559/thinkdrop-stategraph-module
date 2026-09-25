'use strict';
/**
 * golden-journeys.test.js — routing contract tests
 *
 * Drives the real node pipeline (resolveReferences → clarify → decomposePrompt
 * → parseIntent) end-to-end with scripted service/LLM mocks, and pins the
 * ROUTING DECISION for each canonical journey. These are the tests that make
 * structural refactors safe: if a change alters which intent a classification
 * produces, a journey fails — regardless of how the code is organized.
 *
 * The mock LLM is a dispatcher keyed on prompt markers:
 *   'CURRENT USER MESSAGE'        → classifyTask JSON (scripted per journey)
 *   'Intent? (0–7)'               → _decomposeDecision number
 *   'NEW MESSAGE TO DECOMPOSE'    → llmDecompose JSON
 *   'Generate clarifying questions' → clarify question batch
 *
 * Run with: node test/golden-journeys.test.js
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

const resolveReferencesV2 = require('../src/nodes/resolveReferencesV2.js');
const clarify = require('../src/nodes/clarify.js');
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');
const parseIntentV2 = require('../src/nodes/parseIntentV2.js');

// ─── Mocks ──────────────────────────────────────────────────────────────────

const CLASSIFY_BASE = {
  taskType: 'ambiguous', isFollowUp: false, followUpTarget: null,
  needsClarification: false, targetService: null, isRecurring: false,
  isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
  needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
  isImageAnalysis: false, isConversationRecall: false, isActivityQuery: false,
  isThoughtReply: false,
  webAccessMode: 'none', interactiveActions: [], expectsFileOutput: false,
  activeDocRef: null, activeDocTarget: null, mediaListing: 'none',
};

function makeAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    callService: async (svc, action, payload) => {
      calls.push({ svc, action, payload });
      if (action === 'session.route') return { sessionId: 'sess-golden' };
      if (action === 'message.list') return { messages: overrides.recent || [] };
      if (action === 'message.search') return { messages: [] };
      if (action === 'session.list') return { sessions: [] };
      if (action === 'memory.getRecentOcr') return { available: false };
      if (action === 'memory.getActiveAppContext') return {};
      if (action === 'thought.update') return {};
      if (svc === 'phi4' && action === 'intent.classify') {
        return { topIntent: overrides.phi4Intent || 'general_knowledge', topConfidence: 0.7 };
      }
      return {};
    },
  };
}

const DEFAULT_CLARIFY_QUESTIONS = { questions: [{
  id: 'q1', text: 'What did you mean?', type: 'text', freeText: true,
}] };

function makeLlm(opts = {}) {
  const calls = [];
  let classifyCalls = 0;
  return {
    calls,
    generateAnswer: async (prompt) => {
      calls.push(prompt);
      if (/Generate clarifying questions/i.test(prompt)) {
        return JSON.stringify(opts.clarifyQuestions ?? DEFAULT_CLARIFY_QUESTIONS);
      }
      if (/Intent\? \(0–7\)/.test(prompt)) return String(opts.decision ?? '5');
      if (/NEW MESSAGE TO DECOMPOSE/i.test(prompt)) {
        return JSON.stringify(opts.decompose ?? { subPrompts: [{ text: 'step', estimatedIntent: 'web_search' }] });
      }
      if (/CURRENT USER MESSAGE/i.test(prompt)) {
        classifyCalls++;
        const fields = (classifyCalls > 1 && opts.reclassify) ? opts.reclassify : opts.classify;
        return JSON.stringify({ ...CLASSIFY_BASE, ...(fields || {}) });
      }
      return 'ok';
    },
  };
}

/** Drive the real four-node routing span. */
async function runPipeline(state) {
  let s = await resolveReferencesV2(state);
  s = await clarify(s);
  s = await decomposePromptV2(s);
  s = await parseIntentV2(s);
  return s;
}

function baseState(over = {}) {
  return {
    message: over.message || 'test message',
    mcpAdapter: over.adapter || makeAdapter(),
    llmBackend: over.llm || makeLlm(),
    context: { sessionId: over.sessionId || 'sess-golden' },
    logger: _noopLogger,
    ...over.extra,
  };
}

// ─── Journeys ───────────────────────────────────────────────────────────────

describe('golden journeys — routing contract', () => {

  it('public research → web_search (public-research guard)', async () => {
    const out = await runPipeline(baseState({
      message: 'look online for cheap exercise equipment',
      llm: makeLlm({ classify: { taskType: 'browser', webAccessMode: 'public_read' } }),
    }));
    assertEq(out.intent?.type, 'web_search');
    assertEq(out._decomposedBy, 'public-research-guard');
    assertEq(out._taskClassification.resolution, 'resolved');
  });

  it('local system task → command_automate (local short-circuit)', async () => {
    const out = await runPipeline(baseState({
      message: 'take a screenshot',
      llm: makeLlm({ classify: { taskType: 'local_system' } }),
    }));
    assertEq(out.intent?.type, 'command_automate');
    assertEq(out._decomposedBy, 'local-short-circuit');
  });

  it('conversation recall → memory_retrieve (recall guard)', async () => {
    const out = await runPipeline(baseState({
      message: 'what did we talk about earlier',
      llm: makeLlm({ classify: { taskType: 'query', isConversationRecall: true } }),
    }));
    assertEq(out.intent?.type, 'memory_retrieve');
  });

  it('scheduling → command_automate (decision → parseIntent override)', async () => {
    const out = await runPipeline(baseState({
      message: 'remind me to call mom tomorrow at 3pm',
      llm: makeLlm({ classify: { taskType: 'scheduling' }, decision: '4' }),
    }));
    // decision 4 → memory_retrieve from decompose, but parseIntent's scheduling
    // override must force command_automate.
    assertEq(out.intent?.type, 'command_automate');
  });

  it('image listing → web_search (media-search guard)', async () => {
    const out = await runPipeline(baseState({
      message: 'show me pictures of red pandas',
      llm: makeLlm({ classify: { taskType: 'query', mediaListing: 'image', webAccessMode: 'public_read' } }),
    }));
    assertEq(out.intent?.type, 'web_search');
    assertEq(out._decomposedBy, 'media-search-guard');
  });

  it('greeting → greeting (via _decomposeDecision 6)', async () => {
    const out = await runPipeline(baseState({
      message: 'hello',
      llm: makeLlm({ classify: { taskType: 'query' }, decision: '6' }),
    }));
    assertEq(out.intent?.type, 'greeting');
  });

  it('unresolved follow-up (no hedge) → memory_retrieve (unresolved guard)', async () => {
    const out = await runPipeline(baseState({
      message: 'check for me now',
      llm: makeLlm({ classify: { taskType: 'query', isFollowUp: true, followUpTarget: null } }),
    }));
    assertEq(out.intent?.type, 'memory_retrieve');
    assertEq(out._decomposedBy, 'unresolved-followup-guard');
  });

  it('hedged vague message + no callback → stays unresolved → memory_retrieve (never literal search)', async () => {
    const adapter = makeAdapter();
    const out = await runPipeline(baseState({
      message: 'that thing we discussed',
      adapter,
      llm: makeLlm({ classify: { taskType: 'ambiguous', needsClarification: true, isFollowUp: true } }),
      // no gatherAnswerCallback — clarify cannot ask
    }));
    assertEq(out._clarifyOutcome, 'no_callback');
    assertEq(out.intent?.type, 'memory_retrieve');
    assertEq(out._decomposedBy, 'unresolved-followup-guard');
    // The literal vague text must not be a web_search query anywhere.
    const searches = adapter.calls.filter(c => c.action === 'web.search' || c.action === 'search');
    assertEq(searches.length, 0);
  });

  it('multi-intent conjunction → isMultiIntent + queue', async () => {
    const out = await runPipeline(baseState({
      message: 'search for Bryce Crawford and then email me the results',
      llm: makeLlm({
        classify: { taskType: 'browser', webAccessMode: 'public_read', targetService: 'gmail' },
        decision: '7',
        decompose: { subPrompts: [
          { text: 'search for Bryce Crawford', estimatedIntent: 'web_search', order: 0, dependsOn: [] },
          { text: 'email me the results', estimatedIntent: 'command_automate', order: 1, dependsOn: [0] },
        ] },
      }),
    }));
    assert(out.isMultiIntent === true, 'expected isMultiIntent');
    assertEq((out.intentQueue || []).length, 1);
    assertEq(out.intentQueue[0].intent, 'command_automate');
  });

  it('bare "yes" + attached card + hedged → clarify → answered → reclassified resolved', async () => {
    const CARD = 'Bryce Crawford just went live. Want me to look him up?';
    let batch = null;
    const llm = makeLlm({
      classify: { isThoughtReply: true, needsClarification: true },
      reclassify: { taskType: 'query', isFollowUp: true, isThoughtReply: true, followUpTarget: 'Bryce Crawford', webAccessMode: 'public_read' },
      clarifyQuestions: { questions: [{
        id: 'q1', text: 'Look up Bryce Crawford?', type: 'confirm',
        options: [{ label: 'Yes', value: 'yes look him up', primary: true }], freeText: true,
      }] },
    });
    const out = await runPipeline({
      message: `yes`,
      mcpAdapter: makeAdapter(),
      llmBackend: llm,
      context: { sessionId: 'sess-golden' },
      _thoughtAttachment: { id: 'th_1', text: CARD, tag: `[Thought: ${CARD}]` },
      gatherAnswerCallback: async (arg) => { batch = arg; return { q1: 'yes, look him up' }; },
      logger: _noopLogger,
    });
    assert(batch?.batch === true, 'clarify must emit a question batch');
    assertEq(out._clarifyOutcome, 'answered');
    assertEq(out._taskClassification.resolution, 'resolved');
    assertEq(out._taskClassification.followUpTarget, 'Bryce Crawford');
    // Resolved follow-up with webAccessMode=public_read → web_search intent
    // (public-research or query-followup guard — either way webSearch uses
    // followUpTarget as the query, so the literal "yes" never reaches Brave).
    assertEq(out.intent?.type, 'web_search');
    assert(/guard/.test(out._decomposedBy), `expected a guard route, got ${out._decomposedBy}`);
  });

  it('bare "no" + attached card → declined_ack → general_knowledge, no question asked', async () => {
    const CARD = 'Bryce Crawford just went live. Want me to look him up?';
    let cbCalled = false;
    const out = await runPipeline({
      message: 'no',
      mcpAdapter: makeAdapter(),
      llmBackend: makeLlm({ classify: { isThoughtReply: true } }),
      context: { sessionId: 'sess-golden' },
      _thoughtAttachment: { id: 'th_2', text: CARD, tag: `[Thought: ${CARD}]` },
      gatherAnswerCallback: async () => { cbCalled = true; return {}; },
      logger: _noopLogger,
    });
    assertEq(out._taskClassification.resolution, 'declined_ack');
    assertEq(cbCalled, false, 'decline must never trigger a question');
    assertEq(out._decomposedBy, 'declined-ack-guard');
    assertEq(out.intent?.type, 'general_knowledge');
  });

  it('bare "yes" opener with no card/history → needs_clarification (orphan ack)', async () => {
    let batch = null;
    const out = await runPipeline(baseState({
      message: 'yes',
      llm: makeLlm({ classify: { taskType: 'ambiguous' } }),
      extra: { gatherAnswerCallback: async (arg) => { batch = arg; return { q1: 'I meant my earlier request' }; } },
    }));
    assert(batch?.batch === true, 'orphan ack must trigger a clarification batch');
    assertEq(out._clarifyOutcome, 'answered');
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
process.on('beforeExit', () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${_passed} passed, ${_failed} failed`);
  if (_failures.length) {
    for (const f of _failures) console.log(`    FAIL: ${f.label} — ${f.error}`);
  }
  console.log('═'.repeat(70));
  process.exitCode = _failed ? 1 : 0;
});

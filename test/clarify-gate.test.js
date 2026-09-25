'use strict';
/**
 * clarify-gate.test.js
 *
 * Regression tests for the resolution contract + clarify gate:
 *   Bryce bug — a bare "yes" replying to a proactive card was classified as
 *   ambiguous/needsClarification but NOTHING consumed the signal, so it fell
 *   through to _decomposeDecision → general_knowledge → literal web search
 *   ("yes" → YES band results). The fix: an explicit `resolution` contract
 *   (resolved | needs_clarification | declined_ack) + a clarify gate that asks
 *   the user via the existing grill batch surface and re-classifies once.
 *
 *   1. deriveResolution — the contract matrix
 *   2. bare "yes" + attached card → needs_clarification → batch emitted →
 *      answers merged → re-classified → resolved
 *   3. bare "no" + attached card → declined_ack → NO question, NO search
 *   4. needs_clarification without gatherAnswerCallback → stays unresolved,
 *      decompose guard routes to memory_retrieve (never literal search)
 *   5. _clarified caps the gate at one batch per run
 *
 * Run with: node test/clarify-gate.test.js
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

const { deriveResolution } = require('../src/utils/classifyTask.js');
const resolveReferencesV2 = require('../src/nodes/resolveReferencesV2.js');
const clarify = require('../src/nodes/clarify.js');
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');

// ─── deriveResolution — the contract matrix ──────────────────────────────────

describe('deriveResolution — contract', () => {
  const tc = (over = {}) => ({
    taskType: 'ambiguous', isFollowUp: false, followUpTarget: null,
    needsClarification: false, isThoughtReply: false, isScreenFollowUp: false,
    needsFreshScreen: false, activeDocRef: null, ...over,
  });

  it('bare "yes" + attached card + hedged ambiguous → needs_clarification (the Bryce case)', () => {
    assertEq(deriveResolution(tc({ isThoughtReply: true, needsClarification: true }), 'yes', true), 'needs_clarification');
  });

  it('bare "yes" + card + isFollowUp:true + resolved target → resolved', () => {
    assertEq(deriveResolution(tc({ isThoughtReply: true, isFollowUp: true, followUpTarget: 'Bryce Crawford', taskType: 'query' }), 'yes', true), 'resolved');
  });

  it('bare "no" + attached card → declined_ack', () => {
    assertEq(deriveResolution(tc({ isThoughtReply: true }), 'no', true), 'declined_ack');
    assertEq(deriveResolution(tc({ isThoughtReply: true }), 'no thanks', true), 'declined_ack');
    assertEq(deriveResolution(tc({ isThoughtReply: true }), 'nah.', true), 'declined_ack');
  });

  it('bare "yes" opener with no card and no follow-up → needs_clarification (orphan ack)', () => {
    assertEq(deriveResolution(tc({ taskType: 'query' }), 'yes', false), 'needs_clarification');
  });

  it('normal resolved request → resolved', () => {
    assertEq(deriveResolution(tc({ taskType: 'browser', webAccessMode: 'public_read' }), 'search for Bryce Crawford', false), 'resolved');
  });

  it('isFollowUp:true with resolved target → resolved even on vague wording', () => {
    assertEq(deriveResolution(tc({ isFollowUp: true, followUpTarget: 'Vietnam weather', taskType: 'query' }), 'what about that', false), 'resolved');
  });

  it('needsClarification on a concrete taskType (scheduling) → resolved (slot-fillers own it)', () => {
    assertEq(deriveResolution(tc({ taskType: 'scheduling', needsClarification: true }), 'remind me to call mom', false), 'resolved');
  });

  it('activeDocRef counts as a referent → resolved', () => {
    assertEq(deriveResolution(tc({ taskType: 'query', activeDocRef: 'file' }), 'explain this file', false), 'resolved');
  });

  it('decline WITHOUT card context is not declined_ack', () => {
    const r = deriveResolution(tc({ taskType: 'ambiguous', needsClarification: true }), 'no', false);
    assert(r !== 'declined_ack', `expected non-declined, got ${r}`);
  });
});

// ─── Full resolveReferences → clarify flow ───────────────────────────────────

describe('resolveReferences → clarify — proactive card replies', () => {
  const CARD = 'Bryce Crawford just went live on YouTube. Want me to look him up?';
  const TAG = `[Thought: ${CARD}]`;

  const makeAdapter = () => {
    const calls = [];
    return {
      calls,
      callService: async (svc, action, payload) => {
        calls.push({ svc, action, payload });
        if (action === 'message.list') return { messages: [] };
        if (action === 'message.search') return { messages: [] };
        if (action === 'session.list') return { sessions: [] };
        return {};
      },
    };
  };

  const classifyJson = (fields) => JSON.stringify({
    taskType: 'ambiguous', isFollowUp: false, followUpTarget: null,
    needsClarification: false, targetService: null, isRecurring: false,
    isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
    needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
    isImageAnalysis: false, isConversationRecall: false, isActivityQuery: false,
    isThoughtReply: false,
    webAccessMode: 'none', interactiveActions: [], expectsFileOutput: false,
    activeDocRef: null, activeDocTarget: null, mediaListing: 'none', ...fields,
  });

  // Scripted LLM: clarify question-gen prompts ask for questions; classifyTask
  // prompts contain CURRENT USER MESSAGE. The re-classification sees the
  // enriched message and resolves the target.
  const makeLlm = ({ clarified = false } = {}) => {
    const prompts = [];
    return {
      prompts,
      generateAnswer: async (prompt) => {
        prompts.push(prompt);
        if (/Generate clarifying questions/i.test(prompt)) {
          return JSON.stringify({ questions: [{
            id: 'q1', text: 'Do you want me to look up Bryce Crawford?',
            type: 'confirm',
            options: [{ label: 'Yes, look him up', value: 'yes look him up', primary: true }, { label: 'No', value: 'no' }],
            freeText: true,
          }] });
        }
        // classifyTask calls — second call sees the merged answer.
        if (clarified && /Additional context:/i.test(prompt)) {
          return classifyJson({ taskType: 'query', isFollowUp: true, followUpTarget: 'Bryce Crawford', isThoughtReply: true });
        }
        // First pass: the exact contradictory hedge from the Bryce trace.
        return classifyJson({ isThoughtReply: true, needsClarification: true });
      },
    };
  };

  it('bare "yes" + card → needs_clarification → batch emitted → merged → re-classified resolved', async () => {
    const adapter = makeAdapter();
    const llm = makeLlm({ clarified: true });
    let capturedBatch = null;
    const gatherAnswerCallback = async (arg) => {
      capturedBatch = arg;
      return { q1: 'yes, look up Bryce Crawford' };
    };

    const resolved = await resolveReferencesV2({
      message: `${TAG}\n\nyes`,
      mcpAdapter: adapter,
      llmBackend: llm,
      context: { sessionId: 'sess-clarify' },
      _thoughtAttachment: { id: 'th_bryce', text: CARD, tag: TAG },
      logger: _noopLogger,
    });

    assertEq(resolved.message, 'yes', 'message must be reply-only');
    assertEq(resolved._taskClassification.resolution, 'needs_clarification',
      'hedged ambiguous card reply must be needs_clarification');

    const out = await clarify({ ...resolved, gatherAnswerCallback });

    assert(capturedBatch && capturedBatch.batch === true, 'clarify must emit a batch question');
    assert(Array.isArray(capturedBatch.questions) && capturedBatch.questions.length > 0, 'batch must carry questions');
    assertEq(out._clarifyOutcome, 'answered');
    assert(out._clarified === true, '_clarified flag must be set');
    assert(/Additional context:/i.test(out.resolvedMessage), 'answers must merge into resolvedMessage');
    assert(/Bryce Crawford/i.test(out.resolvedMessage), 'merged answer must reach resolvedMessage');
    assertEq(out._taskClassification.followUpTarget, 'Bryce Crawford', 're-classification must resolve the target');
    assertEq(out._taskClassification.resolution, 'resolved', 're-classified message must be resolved');

    // The literal "yes" must never reach web search: decompose routes the
    // resolved follow-up to web_search with followUpTarget as the query.
    const dec = await decomposePromptV2({ ...out, llmBackend: llm, logger: _noopLogger });
    const step = (dec.intentPlan || [])[0];
    assert(step, 'decompose must produce a sub-prompt');
    assert(step.estimatedIntent !== 'general_knowledge' || /Bryce/i.test(step.text),
      `clarified step must carry context, got ${step.estimatedIntent}: ${step.text}`);
  });

  it('bare "no" + card → declined_ack → NO batch → general_knowledge → answer', async () => {
    const adapter = makeAdapter();
    const llm = makeLlm();
    let callbackCalled = false;
    const gatherAnswerCallback = async () => { callbackCalled = true; return {}; };

    const resolved = await resolveReferencesV2({
      message: `${TAG}\n\nno`,
      mcpAdapter: adapter,
      llmBackend: llm,
      context: { sessionId: 'sess-decline' },
      _thoughtAttachment: { id: 'th_bryce2', text: CARD, tag: TAG },
      logger: _noopLogger,
    });

    assertEq(resolved._taskClassification.resolution, 'declined_ack',
      'bare "no" + attached card must be declined_ack');

    const out = await clarify({ ...resolved, gatherAnswerCallback });
    assertEq(callbackCalled, false, 'declined_ack must NEVER ask a question');
    assert(!out._clarified, 'declined_ack passes through untouched');

    const dec = await decomposePromptV2({ ...out, llmBackend: llm, logger: _noopLogger });
    const step = (dec.intentPlan || [])[0];
    assertEq(dec._decomposedBy, 'declined-ack-guard');
    assertEq(step?.estimatedIntent, 'general_knowledge', 'decline routes to a single general_knowledge step → answer, never web_search');
  });

  it('needs_clarification without gatherAnswerCallback → stays unresolved → memory_retrieve guard', async () => {
    const adapter = makeAdapter();
    const llm = makeLlm();

    const resolved = await resolveReferencesV2({
      message: `${TAG}\n\nyes`,
      mcpAdapter: adapter,
      llmBackend: llm,
      context: { sessionId: 'sess-nocb' },
      _thoughtAttachment: { id: 'th_nocb', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    assertEq(resolved._taskClassification.resolution, 'needs_clarification');

    const out = await clarify({ ...resolved }); // no callback
    assertEq(out._clarifyOutcome, 'no_callback');
    assertEq(out._taskClassification.resolution, 'needs_clarification', 'still unresolved');

    // The safety net: literal "yes" must NOT reach _decomposeDecision / web_search.
    const dec = await decomposePromptV2({ ...out, llmBackend: llm, logger: _noopLogger });
    assertEq(dec._decomposedBy, 'unresolved-followup-guard');
    assertEq(dec.intentPlan[0].estimatedIntent, 'memory_retrieve',
      'unresolved text must route to memory_retrieve — never a literal "yes" web search');
  });

  it('_clarified caps the gate — a second clarify run does not re-ask', async () => {
    const adapter = makeAdapter();
    const llm = makeLlm({ clarified: true });
    let calls = 0;
    const gatherAnswerCallback = async () => { calls++; return { q1: 'still vague' }; };

    const resolved = await resolveReferencesV2({
      message: `${TAG}\n\nyes`,
      mcpAdapter: adapter,
      llmBackend: llm,
      context: { sessionId: 'sess-cap' },
      _thoughtAttachment: { id: 'th_cap', text: CARD, tag: TAG },
      logger: _noopLogger,
    });
    const once = await clarify({ ...resolved, gatherAnswerCallback });
    const twice = await clarify({ ...once, gatherAnswerCallback });
    assertEq(calls, 1, 'clarify must ask at most once per run');
    assertEq(twice._clarified, true);
  });

  it('resolved message → clarify passes straight through', async () => {
    let callbackCalled = false;
    const state = {
      message: 'search for Bryce Crawford',
      resolvedMessage: 'search for Bryce Crawford',
      _taskClassification: { taskType: 'query', resolution: 'resolved' },
      llmBackend: makeLlm(),
      gatherAnswerCallback: async () => { callbackCalled = true; return {}; },
      logger: _noopLogger,
    };
    const out = await clarify(state);
    assertEq(out, state, 'resolved state must pass through unchanged');
    assertEq(callbackCalled, false);
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

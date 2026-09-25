'use strict';
/**
 * Stage C — loop detection + multi-intent state-reset completeness
 *
 * 1. core/StateGraph: the old `visited` check keyed on `${node}_${iteration}`
 *    (unique every pass — dead code). Now a node entered >5 times trips a
 *    real 'Loop detected' abort long before maxIterations=50.
 *
 * 2. logConversation queue-runner edge: the per-step reset previously missed
 *    referent/pause/verdict fields, so step N+1 inherited step N's
 *    _taskClassification (isThoughtReply, followUpTarget, resolution),
 *    pendingQuestion, reviewVerdict etc.
 *
 * Run: node stategraph-module/test/stage-c-stability.test.js
 */

const StateGraph = require('../src/core/StateGraph');
const StateGraphBuilder = require('../src/StateGraphBuilder');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

let passed = 0, failed = 0;
function assert(cond, label, detail) {
  if (cond) { console.log('  PASS:', label, detail !== undefined ? '— ' + detail : ''); passed++; }
  else { console.error('  FAIL:', label, detail !== undefined ? '— ' + detail : ''); failed++; }
}

// ── 1. Loop detection ────────────────────────────────────────────────────────
async function testLoopDetection() {
  console.log('\n--- Loop detection: A⇄B cycle aborts early ---');
  const graph = new StateGraph(
    { a: async s => s, b: async s => s },
    { start: 'a', a: 'b', b: 'a' },
    { logger: silentLogger }
  );
  const result = await graph.execute({});
  assert(/Loop detected/.test(result.error || ''), 'error reports loop detection', result.error);
  assert(result.iterations < 50, 'aborts before maxIterations', `iterations=${result.iterations}`);
  assert(result.failedNode === 'a', 'failedNode is the re-entered node', result.failedNode);
}

async function testRecoveryCyclesAllowed() {
  console.log('\n--- Legit revisits under threshold still complete ---');
  // a → b → a → b → end : node 'a' entered twice — under the 5-visit cap.
  const graph = new StateGraph(
    {
      a: async s => ({ ...s, aCount: (s.aCount || 0) + 1 }),
      b: async s => s,
    },
    { start: 'a', a: 'b', b: s => (s.aCount >= 2 ? 'end' : 'a') },
    { logger: silentLogger }
  );
  const result = await graph.execute({});
  assert(!result.error, 'no loop error for ≤5 revisits', result.error);
  assert(result.success === true, 'run completes successfully');
}

// ── 2. Multi-intent per-step reset ───────────────────────────────────────────
function buildFullGraph() {
  // full() only needs mcpAdapter OR llmBackend — the edge under test never
  // touches either; stub adapter keeps the factory happy.
  return StateGraphBuilder.full({
    logger: silentLogger,
    mcpAdapter: { callService: async () => null },
  });
}

async function testQueueResetClearsReferentState() {
  console.log('\n--- Multi-intent reset clears referent/pause/verdict state ---');
  const graph = buildFullGraph();
  const edge = graph.edges.logConversation;

  const state = {
    isMultiIntent: true,
    intent: { type: 'web_search', subPrompt: 'Search for Bryce Crawford', confidence: 0.9 },
    message: 'Search for Bryce Crawford',
    answer: 'Bryce Crawford is a Christian artist.',
    searchResults: [{ title: 'x' }],
    skillResults: [{ skill: 'web.search', ok: true }],
    skillPlan: [{ skill: 'web.search' }],
    skillCursor: 1,
    recoveryAction: null,
    // Referent state left over from step 1 — must NOT bleed into step 2.
    _taskClassification: {
      taskType: 'query',
      isThoughtReply: true,
      isFollowUp: true,
      followUpTarget: 'Bryce Crawford',
      needsClarification: true,
      resolution: 'needs_clarification',
      activeDocRef: 'doc-123',
    },
    _thoughtAttachment: { thoughtId: 't-1', title: 'Bryce Crawford' },
    pendingQuestion: { question: 'pick one', options: ['a', 'b'] },
    reviewVerdict: 'CORRECTED',
    evaluationVerdict: 'FIX',
    evaluationFix: 'retry step',
    recoveryContext: { rule: 'x' },
    singleStepReplan: true,
    scoutPending: true,
    _needsFreshScreen: true,
    _postScreenIntent: 'web_search',
    intentQueue: [
      { intent: 'memory_store', text: 'Remember the result', confidence: 0.9, order: 1 },
    ],
    intentResults: [],
    dataContext: {},
    progressCallback: () => {},
    logger: silentLogger,
  };

  const next = await edge(state);
  assert(next === 'enrichIntent', 'routes to enrichIntent for next queued step', next);
  assert(state.intent?.type === 'memory_store', 'intent switched to next step', state.intent?.type);

  // Referent fields cleared — this is the regression the fix addresses
  const tc = state._taskClassification || {};
  assert(tc.isThoughtReply === false, 'isThoughtReply cleared');
  assert(tc.isFollowUp === false, 'isFollowUp cleared');
  assert(tc.followUpTarget === null, 'followUpTarget cleared');
  assert(tc.needsClarification === false, 'needsClarification cleared');
  assert(tc.resolution === 'resolved', 'resolution reset to resolved', tc.resolution);
  assert(tc.taskType === 'query', 'durable fields (taskType) preserved', tc.taskType);
  assert(tc.activeDocRef === 'doc-123', 'ambient doc ref preserved', tc.activeDocRef);

  assert(state._thoughtAttachment === null, '_thoughtAttachment cleared');
  assert(state.pendingQuestion === null, 'pendingQuestion cleared');
  assert(state.reviewVerdict === null, 'reviewVerdict cleared');
  assert(state.evaluationVerdict === null, 'evaluationVerdict cleared');
  assert(state.evaluationFix === null, 'evaluationFix cleared');
  assert(state.recoveryContext === null, 'recoveryContext cleared');
  assert(state.singleStepReplan === null, 'singleStepReplan cleared');
  assert(state.scoutPending === false, 'scoutPending cleared');
  assert(state._needsFreshScreen === false, '_needsFreshScreen cleared');
  assert(state._postScreenIntent === null, '_postScreenIntent cleared');

  // Pre-existing reset behavior — pin it so the fix doesn't regress it
  assert(state.answer === null, 'answer cleared');
  assert(Array.isArray(state.searchResults) && state.searchResults.length === 0, 'searchResults cleared');
  assert(Array.isArray(state.skillResults) && state.skillResults.length === 0, 'skillResults cleared');
  assert(state.intentQueue.length === 0, 'queue popped');
  assert(state.intentResults.length === 1, 'step result collected');
  assert(state.message === 'Remember the result', 'message swapped to next sub-prompt', state.message);
}

async function testResultPlaceholderStillResolves() {
  console.log('\n--- {{result[N]}} placeholder still resolves after reset ---');
  const graph = buildFullGraph();
  const edge = graph.edges.logConversation;

  const state = {
    isMultiIntent: true,
    intent: { type: 'web_search', subPrompt: 'Search X', confidence: 0.9 },
    message: 'Search X',
    answer: 'RESULT_ALPHA',
    intentQueue: [
      { intent: 'general_knowledge', text: 'Summarize {{result[0]}}', confidence: 0.9, order: 1, dependsOn: [0] },
    ],
    intentResults: [],
    dataContext: {},
    progressCallback: () => {},
    logger: silentLogger,
  };

  const next = await edge(state);
  assert(next === 'enrichIntent', 'routes to enrichIntent');
  assert(/RESULT_ALPHA/.test(state.message || ''), 'placeholder resolved in next sub-prompt', state.message);
}

(async () => {
  await testLoopDetection();
  await testRecoveryCyclesAllowed();
  await testQueueResetClearsReferentState();
  await testResultPlaceholderStillResolves();
  console.log(`\n${'='.repeat(60)}\n  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}\n${'='.repeat(60)}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

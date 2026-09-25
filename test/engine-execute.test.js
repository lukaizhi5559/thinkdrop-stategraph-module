'use strict';
/**
 * engine-execute.test.js — patch-only node returns must not crash the engine.
 *
 * Regression: core/StateGraph.execute() did `updatedState.trace.push(...)`
 * unconditionally. Nodes that return a minimal patch (no `trace` field) —
 * all Stage D extracted nodes (routeIntent, advanceQueue, preparePostScreen,
 * prepareReplan, flagHollowFailure, flagStepFailure, surfacePlanFailure) —
 * crashed every run that reached them: "Cannot read properties of undefined
 * (reading 'push')", silently killing the pipeline mid-flight.
 *
 * Run: node stategraph-module/test/engine-execute.test.js
 */

const StateGraph = require('../src/core/StateGraph');
const StateGraphBuilder = require('../src/StateGraphBuilder');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

let passed = 0, failed = 0;
function assert(cond, label, detail) {
  if (cond) { console.log('  PASS:', label, detail !== undefined ? '— ' + detail : ''); passed++; }
  else { console.error('  FAIL:', label, detail !== undefined ? '— ' + detail : ''); failed++; }
}

// ── 1. Patch-only node survives execute() ────────────────────────────────────
async function testPatchOnlyNode() {
  console.log('\n--- Patch-only node return (no trace field) ---');
  const graph = new StateGraph(
    {
      a: async () => ({ _advanceRoute: 'b' }),   // bare patch — no ...state spread
      b: async () => ({ done: true }),
    },
    { start: 'a', a: s => s._advanceRoute || 'end', b: 'end' },
    { logger: silentLogger }
  );
  const result = await graph.execute({});
  assert(!result.error, 'no error from patch-only node', result.error);
  assert(result.done === true, 'reached second node');
  assert(result.trace.length === 2, 'trace recorded both nodes', `trace=${result.trace.length}`);
  assert(result.trace[0].node === 'a' && result.trace[1].node === 'b', 'trace order correct');
}

// ── 2. Real routeIntent node through the engine loop ─────────────────────────
async function testRouteIntentThroughEngine() {
  console.log('\n--- Real routeIntent node through engine.execute() ---');
  const full = StateGraphBuilder.full({
    logger: silentLogger,
    mcpAdapter: { callService: async () => null },
  });

  // Drive just the tail: routeIntent → (webSearch stub) → end
  const reached = [];
  const graph = new StateGraph(
    {
      routeIntent: full.nodes.routeIntent,
      webSearch: async s => { reached.push('webSearch'); return s; },
    },
    { start: 'routeIntent', routeIntent: s => s._advanceRoute || 'end', webSearch: 'end' },
    { logger: silentLogger }
  );

  const result = await graph.execute({
    intent: { type: 'web_search', confidence: 0.9, entities: [] },
    _taskClassification: { taskType: 'browser', webAccessMode: 'public_read', resolution: 'resolved' },
    message: 'find videos from mike winger Christ in the old testament',
    logger: silentLogger,
  });
  assert(!result.error, 'routeIntent did not crash the engine', result.error);
  assert(reached.includes('webSearch'), 'routed to webSearch via _advanceRoute');
}

// ── 3. Real advanceQueue node through the engine loop (single-intent exit) ───
async function testAdvanceQueueThroughEngine() {
  console.log('\n--- Real advanceQueue node through engine.execute() ---');
  const full = StateGraphBuilder.full({
    logger: silentLogger,
    mcpAdapter: { callService: async () => null },
  });

  const graph = new StateGraph(
    { advanceQueue: full.nodes.advanceQueue },
    { start: 'advanceQueue', advanceQueue: s => s._advanceRoute || 'end' },
    { logger: silentLogger }
  );

  const result = await graph.execute({
    isMultiIntent: false,
    intent: { type: 'general_knowledge' },
    message: 'hi',
    answer: 'hello',
    logger: silentLogger,
  });
  assert(!result.error, 'advanceQueue did not crash the engine', result.error);
  assert(result.success === true, 'run completed successfully');
}

// ── 4. Queue-step path through the engine (patch merge) ──────────────────────
async function testAdvanceQueueNextStep() {
  console.log('\n--- advanceQueue pops next step → enrichIntent route ---');
  const full = StateGraphBuilder.full({
    logger: silentLogger,
    mcpAdapter: { callService: async () => null },
  });

  const reached = [];
  const graph = new StateGraph(
    {
      advanceQueue: full.nodes.advanceQueue,
      enrichIntent: async s => { reached.push(s.intent?.type); return s; },
    },
    { start: 'advanceQueue', advanceQueue: s => s._advanceRoute || 'end', enrichIntent: 'end' },
    { logger: silentLogger }
  );

  const result = await graph.execute({
    isMultiIntent: true,
    intent: { type: 'web_search', subPrompt: 'Search X' },
    message: 'Search X',
    answer: 'RESULT',
    intentQueue: [{ intent: 'memory_store', text: 'Remember it', confidence: 0.9, order: 1 }],
    intentResults: [],
    dataContext: {},
    progressCallback: () => {},
    logger: silentLogger,
  });
  assert(!result.error, 'no crash on queue advance', result.error);
  assert(reached[0] === 'memory_store', 'next step intent propagated', reached[0]);
  assert(result.message === 'Remember it', 'merged patch swapped message', result.message);
  assert(result._taskClassification == null || result._taskClassification?.resolution === 'resolved',
    'classification reset survived merge');
}

(async () => {
  await testPatchOnlyNode();
  await testRouteIntentThroughEngine();
  await testAdvanceQueueThroughEngine();
  await testAdvanceQueueNextStep();
  console.log(`\n${'='.repeat(60)}\n  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}\n${'='.repeat(60)}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

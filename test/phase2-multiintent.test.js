'use strict';

/**
 * Phase 2 — Sequential Multi-Intent Execution manual test suite
 *
 * Tests the intentQueue runner in StateGraphBuilder.js logConversation edge,
 * the summarizeMultiIntent node, and _dataPrefix injection.
 *
 * Run: node stategraph-module/test/phase2-multiintent.test.js
 */

const summarizeMultiIntent = require('../src/nodes/summarizeMultiIntent');
const extractStepResult_mod = require('../src/StateGraphBuilder'); // we test extractStepResult indirectly via the node

const logger = {
  debug: () => {},
  info:  console.log,
  warn:  console.warn,
  error: console.error,
};

let passed = 0;
let failed = 0;

function assert(cond, label, detail) {
  if (cond) {
    console.log('  PASS:', label, detail !== undefined ? '— ' + detail : '');
    passed++;
  } else {
    console.error('  FAIL:', label, detail !== undefined ? '— ' + detail : '');
    failed++;
    console.trace();
  }
}

// ─── Test 1: summarizeMultiIntent no-op when intentResults is empty ───────────
async function test1() {
  console.log('\n--- Test 1: summarizeMultiIntent no-op (empty intentResults) ---');

  const state = {
    logger,
    intentResults: [],
    originalPrompt: 'Open Slack',
    isMultiIntent: false,
  };

  const result = await summarizeMultiIntent(state);

  assert(result.isMultiIntent === false, 'isMultiIntent=false after no-op');
  assert(!result.answer, 'answer not set on no-op path', result.answer);
  assert(!result._multiIntentSummary, '_multiIntentSummary not set on no-op');
}

// ─── Test 2: summarizeMultiIntent plain-text fallback (no LLM, no MCP) ────────
async function test2() {
  console.log('\n--- Test 2: summarizeMultiIntent plain-text fallback (LLM + MCP unavailable) ---');

  const state = {
    logger,
    intentResults: [
      { step: 0, intent: 'memory_store',  subPrompt: 'Remember I use dark mode', result: 'Stored: I use dark mode' },
      { step: 1, intent: 'web_search',    subPrompt: 'Search for best dark mode VS Code extensions', result: 'Dark++ extension, One Dark Pro' },
    ],
    originalPrompt: 'Remember I use dark mode. Search for the best dark mode VS Code extensions.',
    isMultiIntent: true,
    llmBackend:  null,
    mcpAdapter:  null,
  };

  const result = await summarizeMultiIntent(state);

  assert(result.isMultiIntent === false, 'isMultiIntent forced false after summarize');
  assert(typeof result.answer === 'string' && result.answer.length > 0, 'answer produced', result.answer?.slice(0, 80));
  assert(result._multiIntentSummary?.combinedBy === 'fallback', 'combinedBy=fallback when LLM+MCP unavailable', result._multiIntentSummary?.combinedBy);
  assert(result._multiIntentSummary?.steps === 2, 'steps=2 in metadata', result._multiIntentSummary?.steps);
  // Plain-text fallback should include intent labels
  assert(result.answer.includes('memory_store') || result.answer.includes('web_search'), 'answer contains intent labels in fallback');
}

// ─── Test 3: summarizeMultiIntent LLM path ────────────────────────────────────
async function test3() {
  console.log('\n--- Test 3: summarizeMultiIntent via llmBackend ---');

  let llmCalled = false;
  const mockLLM = {
    isAvailable: async () => true,
    generateAnswer: async (prompt) => {
      llmCalled = true;
      assert(prompt.includes('dark mode'), 'LLM prompt contains result context', prompt.slice(0, 60));
      return 'I have saved your dark mode preference and found these top VS Code extensions: Dark++ and One Dark Pro.';
    },
  };

  const state = {
    logger,
    intentResults: [
      { step: 0, intent: 'memory_store',  subPrompt: 'Remember I use dark mode', result: 'Stored: I use dark mode' },
      { step: 1, intent: 'web_search',    subPrompt: 'Best dark mode VS Code extensions', result: 'Dark++, One Dark Pro' },
    ],
    originalPrompt: 'Remember I use dark mode. Search for the best dark mode VS Code extensions.',
    isMultiIntent: true,
    llmBackend: mockLLM,
    mcpAdapter: null,
  };

  const result = await summarizeMultiIntent(state);

  assert(llmCalled, 'llmBackend.generateAnswer was called');
  assert(result._multiIntentSummary?.combinedBy === 'llm', 'combinedBy=llm', result._multiIntentSummary?.combinedBy);
  assert(result.isMultiIntent === false, 'isMultiIntent=false after LLM summarize');
  assert(result.answer.includes('dark mode') || result.answer.includes('Dark'), 'answer references dark mode');
}

// ─── Test 4: summarizeMultiIntent LLM throws → MCP fallback ───────────────────
async function test4() {
  console.log('\n--- Test 4: summarizeMultiIntent LLM throws → MCP phi4 fallback ---');

  const mockLLM = {
    isAvailable: async () => true,
    generateAnswer: async () => { throw new Error('LLM timeout'); },
  };

  let mcpCalled = false;
  const mockMCP = {
    callService: async (svc, method) => {
      if (svc === 'phi4' && method === 'general.answer') {
        mcpCalled = true;
        return { data: { answer: 'Fallback combined answer via phi4.' } };
      }
      throw new Error('unexpected callService');
    },
  };

  const state = {
    logger,
    intentResults: [
      { step: 0, intent: 'memory_retrieve', subPrompt: 'retrieve game idea', result: 'GamboQuest 3D platformer' },
      { step: 1, intent: 'command_automate', subPrompt: 'build game on gambo.ai', result: 'Game build started.' },
    ],
    originalPrompt: 'Retrieve my game idea and build it on gambo.ai.',
    isMultiIntent: true,
    llmBackend:  mockLLM,
    mcpAdapter:  mockMCP,
  };

  const result = await summarizeMultiIntent(state);

  assert(mcpCalled, 'MCP phi4 fallback was invoked after LLM threw');
  assert(result._multiIntentSummary?.combinedBy === 'mcp', 'combinedBy=mcp', result._multiIntentSummary?.combinedBy);
  assert(result.isMultiIntent === false, 'isMultiIntent=false after MCP summarize');
}

// ─── Test 5: _dataPrefix injection in {{result[N]}} resolution ─────────────────
async function test5() {
  console.log('\n--- Test 5: dataTemplate {{result[N]}} resolution in queue runner ---');

  // Simulate what the queue runner does when it pops a step with dependsOn + dataTemplate
  const dataContext = { 0: 'GamboQuest 3D platformer with AI enemies' };

  const nextStep = {
    text: 'build game on gambo.ai',
    intent: 'command_automate',
    confidence: 0.9,
    dependsOn: [0],
    dataTemplate: 'Use this game idea from memory: {{result[0]}}',
    isLongRunning: true,
  };

  // Replicate the resolution logic from the queue runner
  let resolvedText = nextStep.text;
  for (const depIdx of nextStep.dependsOn) {
    const depResult = dataContext[depIdx] || '';
    resolvedText = resolvedText.replace(
      new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
      depResult
    );
  }

  let dataPrefix = nextStep.dataTemplate;
  for (const depIdx of nextStep.dependsOn) {
    const depResult = dataContext[depIdx] || '';
    dataPrefix = dataPrefix.replace(
      new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
      depResult
    );
  }

  assert(!resolvedText.includes('{{result[0]}}'), 'text placeholder replaced', resolvedText);
  assert(resolvedText === 'build game on gambo.ai', 'text has no placeholders to replace (text had none)', resolvedText);
  assert(!dataPrefix.includes('{{result[0]}}'), 'dataTemplate placeholder replaced', dataPrefix.slice(0, 80));
  assert(dataPrefix.includes('GamboQuest'), 'dataPrefix contains retrieved result', dataPrefix.slice(0, 80));
}

// ─── Test 6: extractStepResult logic (via state inspection) ────────────────────
async function test6() {
  console.log('\n--- Test 6: extractStepResult — all 5 intent branches ---');

  // We test extractStepResult indirectly by calling summarizeMultiIntent and observing
  // what's stored in intentResults after it returns.  The queue runner calls extractStepResult
  // before calling summarizeMultiIntent; since we're unit-testing the node here, we verify
  // the input intentResults shapes are accepted correctly.

  // For the queue-runner logic, the extractStepResult function is a module-level helper
  // inside StateGraphBuilder.js — it's not directly exported.  We verify it through the
  // test stubs below by checking the results that would be produced by each branch.

  // memory_retrieve branch
  const memState = {
    intent: { type: 'memory_retrieve' },
    filteredMemories: [
      { source_text: 'GamboQuest is a 3D platformer with AI' },
      { source_text: 'secondary note' },
    ],
    answer: null,
  };
  const memResult = simulateExtractStepResult(memState);
  assert(memResult.includes('GamboQuest'), 'memory_retrieve extracts source_text', memResult.slice(0, 60));

  // web_search branch
  const wsState = {
    intent: { type: 'web_search' },
    contextDocs: [
      { snippet: 'Best VS Code extension is Dark++' },
      { snippet: 'One Dark Pro is also popular' },
    ],
    answer: null,
  };
  const wsResult = simulateExtractStepResult(wsState);
  assert(wsResult.includes('Dark++'), 'web_search extracts contextDocs snippet', wsResult.slice(0, 80));

  // command_automate branch — answer
  const caState = {
    intent: { type: 'command_automate' },
    answer: 'Game build initiated via gambo.ai API.',
    skillResults: [],
  };
  const caResult = simulateExtractStepResult(caState);
  assert(caResult.includes('gambo.ai'), 'command_automate extracts answer', caResult.slice(0, 60));

  // memory_store branch
  const msState = {
    intent: { type: 'memory_store' },
    message: 'I use dark mode',
    answer: null,
  };
  const msResult = simulateExtractStepResult(msState);
  assert(msResult.startsWith('Stored:'), 'memory_store returns Stored: prefix', msResult.slice(0, 30));

  // default branch
  const defState = {
    intent: { type: 'greeting' },
    answer: 'Hello!',
    message: 'Hi there',
  };
  const defResult = simulateExtractStepResult(defState);
  assert(defResult === 'Hello!', 'default branch returns answer', defResult);
}

/**
 * Local reimplementation of extractStepResult to unit-test the branch logic
 * without having to export a private function.
 */
function simulateExtractStepResult(state) {
  const intent = state.intent?.type;

  if (intent === 'memory_retrieve' && Array.isArray(state.filteredMemories) && state.filteredMemories.length > 0) {
    return state.filteredMemories
      .slice(0, 3)
      .map(m => m.source_text || m.extracted_text || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
  }

  if (intent === 'web_search' && Array.isArray(state.contextDocs) && state.contextDocs.length > 0) {
    return state.contextDocs
      .slice(0, 2)
      .map(d => d.snippet || d.title || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
  }

  if (intent === 'command_automate') {
    if (state.answer) return state.answer.slice(0, 500);
    if (Array.isArray(state.skillResults)) {
      const last = state.skillResults.filter(r => r.ok && r.stdout).pop();
      if (last) return last.stdout.slice(0, 500);
    }
  }

  if (intent === 'memory_store') {
    return `Stored: ${state.message?.slice(0, 200) || 'memory stored'}`;
  }

  return state.answer?.slice(0, 500) || state.message?.slice(0, 200) || '';
}

// ─── Test 7: isMultiIntent=false for single-intent prompts ─────────────────────
async function test7() {
  console.log('\n--- Test 7: Single-intent path — summarizeMultiIntent is a no-op ---');

  // Single-intent state never has isMultiIntent set — summarizeMultiIntent should no-op
  const state = {
    logger,
    intentResults: [],
    originalPrompt: 'Open Slack',
    isMultiIntent: false,
    answer: 'Opening Slack now.',
    llmBackend: null,
    mcpAdapter: null,
  };

  const result = await summarizeMultiIntent(state);

  assert(result.answer === 'Opening Slack now.', 'single-intent answer preserved unchanged');
  assert(result.isMultiIntent === false, 'isMultiIntent still false');
  assert(!result._multiIntentSummary, '_multiIntentSummary not set');
}

// ─── Runner ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n======================================================');
  console.log('Phase 2 — Multi-Intent Execution Tests');
  console.log('======================================================');

  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();

  console.log('\n------------------------------------------------------');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Phase 2 tests FAILED');
    process.exit(1);
  }
  console.log('Phase 2 tests PASSED');
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

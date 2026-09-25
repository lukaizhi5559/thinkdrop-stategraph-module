'use strict';
/**
 * synthesize-crossturn-guard.test.js — synthesize must not attach prior-session
 * step outputs to a fresh, self-contained task.
 *
 * Regression (observed in e2e preflight): prompt "create a file called
 * e2e-preflight.txt on my desktop with the text hello world" planned a single
 * synthesize step; with empty skillResults the cross-turn fallback attached
 * the last assistant "Step outputs" message from an unrelated proofreading
 * run, and the LLM wrote a summary of THAT into the file.
 *
 * The gate: cross-turn fallback is only valid when the current task is
 * referential — isFollowUp / followUpTarget / isConversationRecall.
 *
 * Run: node stategraph-module/test/synthesize-crossturn-guard.test.js
 */

const executeCommand = require('../src/nodes/executeCommand');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, log() {} };

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

const PRIOR = 'Step outputs:\n[1] fix spelling and grammar — output: FIXED: proofreading_test_hugh_file.txt';

function baseState(taskClassification) {
  return {
    intent: { type: 'command_automate' },
    message: 'create a file called x.txt with the text hello world',
    resolvedMessage: 'create a file called x.txt with the text hello world',
    skillPlan: [{ skill: 'synthesize', args: { prompt: 'hello world' }, description: 'Create file content' }],
    skillCursor: 0,
    skillResults: [],
    conversationHistory: [{ role: 'assistant', content: PRIOR, timestamp: Date.now() - 60000 }],
    _taskClassification: taskClassification,
    context: {},
    logger: silentLogger,
    mcpAdapter: { callService: async () => null },
  };
}

async function run(taskClassification) {
  const captured = [];
  const llmBackend = {
    generateAnswer: async (query, payload) => {
      captured.push(query);
      return 'CAPTURED_SYNTHESIS_OUTPUT';
    },
  };
  const state = { ...baseState(taskClassification), llmBackend };
  const result = await executeCommand(state);
  return { captured, result };
}

async function main() {
  // ── Non-referential task: prior outputs must NOT reach the LLM ─────────────
  {
    const { captured } = await run({ taskType: 'local_file', isFollowUp: false, followUpTarget: null, isConversationRecall: false });
    ok(captured.length > 0, 'synthesize ran the LLM');
    const joined = captured.join('\n');
    ok(!joined.includes('Step outputs') && !joined.includes('proofreading'), 'non-referential task: no prior step outputs in synthesis prompt');
  }

  // ── Referential task (isFollowUp): prior outputs ARE legitimate context ────
  {
    const { captured } = await run({ taskType: 'local_file', isFollowUp: true, followUpTarget: 'the proofreading results', isConversationRecall: false });
    const joined = captured.join('\n');
    ok(joined.includes('Step outputs') || joined.includes('proofreading'), 'follow-up task: prior step outputs reach the synthesis prompt');
  }

  // ── Referential via followUpTarget only ────────────────────────────────────
  {
    const { captured } = await run({ taskType: 'local_file', isFollowUp: false, followUpTarget: 'earlier results', isConversationRecall: false });
    const joined = captured.join('\n');
    ok(joined.includes('Step outputs') || joined.includes('proofreading'), 'followUpTarget alone also admits cross-turn context');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });

'use strict';
const decompose = require('../src/nodes/decomposePrompt');

const logger = { debug: console.log, info: console.log, warn: console.warn };

async function run() {
  let passed = 0;
  let failed = 0;

  function assert(cond, label, detail) {
    if (cond) {
      console.log('  PASS:', label, detail ? '— ' + detail : '');
      passed++;
    } else {
      console.error('  FAIL:', label, detail ? '— ' + detail : '');
      failed++;
    }
  }

  console.log('\n--- Test 1: Simple prompt (single word) ---');
  const t1 = await decompose({ message: 'Open Slack', logger });
  assert(!t1.intentPlan, 'no intentPlan on simple prompt');

  console.log('\n--- Test 2: Long but single-intent (only 1 signal = length) ---');
  const t2 = await decompose({ message: 'What is the best programming language for building a scalable backend API in modern 2026 production applications?', logger });
  assert(!t2.intentPlan, 'no intentPlan — one signal (length) is not enough');

  console.log('\n--- Test 3: Multi-intent with temporal connectors (heuristic path, no LLM) ---');
  const t3msg = 'Remember I had that gambo ai game idea last week. Then go to gambo.ai and build it. Text me when done.';
  const t3 = await decompose({ message: t3msg, logger });
  assert(Array.isArray(t3.intentPlan), 'intentPlan is an array');
  assert(t3.intentPlan && t3.intentPlan.length >= 2, 'at least 2 sub-prompts', t3.intentPlan ? t3.intentPlan.length + ' found' : 'none');
  assert(t3._decomposedBy === 'heuristic', 'decomposedBy=heuristic (no LLM injected)', t3._decomposedBy);
  if (t3.intentPlan) t3.intentPlan.forEach((sp, i) => console.log('    [' + i + '] "' + sp.text.slice(0, 70) + '"'));

  console.log('\n--- Test 4: playwright-cli prompt (length + multi_class signals) ---');
  const t4msg = 'If I generate an image or video with kaze ai ro google genie AI does playwright-cli have a page watch feature to know when the AI has completed?';
  const t4 = await decompose({ message: t4msg, logger });
  const t4signals = t4._decomposedBy || 'not decomposed';
  console.log('  Result:', t4.intentPlan ? 'decomposed into ' + t4.intentPlan.length + ' sub-prompts via ' + t4._decomposedBy : 'simple path (acceptable — question has no action verbs requiring different nodes)');
  if (t4.intentPlan) t4.intentPlan.forEach((sp, i) => console.log('    [' + i + '] "' + sp.text.slice(0, 70) + '"'));

  console.log('\n--- Test 5: skill_build passthrough guard ---');
  const t5 = await decompose({ message: 'Build a skill for gmail', skillBuildRequest: true, logger });
  assert(!t5.intentPlan, 'skillBuildRequest skips decomposition');

  console.log('\n--- Test 6: Memory + automation + notification (3 signals) ---');
  const t6msg = 'What ideas did I note down for my app last week? And then search for the best implementation approaches. After that text me the summary.';
  const t6 = await decompose({ message: t6msg, logger });
  assert(Array.isArray(t6.intentPlan), 'intentPlan set for 3-intent message');
  assert(t6.intentPlan && t6.intentPlan.length >= 2, '2+ sub-prompts', t6.intentPlan ? t6.intentPlan.length + ' found' : 'none');
  if (t6.intentPlan) t6.intentPlan.forEach((sp, i) => console.log('    [' + i + '] "' + sp.text.slice(0, 70) + '"'));

  console.log('\n-------------------------------------------------');
  console.log('Results:', passed, 'passed,', failed, 'failed');
  if (failed > 0) process.exit(1);
  console.log('Phase 1 decomposePrompt unit tests PASSED');
}

run().catch(e => { console.error('Test error:', e); process.exit(1); });

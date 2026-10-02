'use strict';
/**
 * parse-skill-env-gate.test.js
 *
 * The Strategy-3 semantic LLM match in parseSkill.js is gated behind
 * THINKDROP_SKILL_SEMANTIC_MATCH=1 (default off — it costs ~1–2s and virtually
 * always returns -1 for ordinary service-routed tasks). These tests pin the
 * gate behavior: off → never reaches the LLM; on → reaches it.
 *
 * Run: node stategraph-module/test/parse-skill-env-gate.test.js
 */

const parseSkill = require('../src/nodes/parseSkill.js');

let _passed = 0, _failed = 0;
async function it(label, fn) {
  try { await fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}

// A skill that would semantically match — LLM mock returns its name so a hit
// is only possible when Strategy 3 actually runs.
const SKILLS = [
  { name: 'clicksend.send.sms', description: 'Send SMS text messages via ClickSend.', summary: 'SMS sender.', execPath: __filename },
];
const adapter = {
  callService: async (svc, action) => action === 'skill.listNames' ? { data: { results: SKILLS } } : { data: { results: [] } },
};
const _logs = [];
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeState(message, llmBackend) {
  return {
    message, resolvedMessage: message,
    intent: { type: 'command_automate', confidence: 0.95 },
    mcpAdapter: adapter, llmBackend, logger,
  };
}

async function run() {
  let llmCalls = 0;
  // Prompt that matches nothing deterministically — only Strategy 3 could hit.
  const state = makeState('frobnicate the gizmo with semantic precision', {
    generateAnswer: async () => { llmCalls++; return 'clicksend.send.sms'; },
  });
  const result = await parseSkill(state);
  return { result, llmCalls };
}

async function main() {
  console.log('\n  parseSkill Strategy-3 env gate\n' + '─'.repeat(60));

  await it('default (unset): skips Strategy-3 — zero LLM calls, no match', async () => {
    delete process.env.THINKDROP_SKILL_SEMANTIC_MATCH;
    const { result, llmCalls } = await run();
    if (llmCalls !== 0) throw new Error(`Expected 0 LLM calls with gate off, got ${llmCalls}`);
    if (result.matchedSkillName) throw new Error(`Expected no match with gate off, got ${result.matchedSkillName}`);
  });

  await it('explicit off value: still skips Strategy-3', async () => {
    process.env.THINKDROP_SKILL_SEMANTIC_MATCH = '0';
    const { llmCalls } = await run();
    if (llmCalls !== 0) throw new Error(`Expected 0 LLM calls with gate=0, got ${llmCalls}`);
  });

  await it('THINKDROP_SKILL_SEMANTIC_MATCH=1: reaches the semantic LLM', async () => {
    process.env.THINKDROP_SKILL_SEMANTIC_MATCH = '1';
    const { llmCalls } = await run();
    if (llmCalls < 1) throw new Error(`Expected ≥1 LLM call with gate=1, got ${llmCalls}`);
  });

  delete process.env.THINKDROP_SKILL_SEMANTIC_MATCH;
  console.log(`\n${_passed} passed, ${_failed} failed.`);
  if (_failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

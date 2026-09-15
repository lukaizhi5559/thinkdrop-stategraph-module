'use strict';
/**
 * public-web-routing.test.js
 *
 * Regression tests for routing public web search/extract tasks to
 * web.agent + web.crawl instead of browser.agent.
 *
 * Run from repo root with:
 *   node stategraph-module/test/public-web-routing.test.js
 */

const fs = require('fs');
const path = require('path');

const { classifyTask } = require(path.resolve(__dirname, '..', 'src/utils/classifyTask'));
const planSkillsV2 = require(path.resolve(__dirname, '..', 'src/nodes/planSkillsV2'));

let _passed = 0;
let _failed = 0;
const _failures = [];

async function it(label, fn) {
  try {
    await fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}\n     ${e.message}`);
  }
}

function section(label) {
  console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`);
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e)
        throw new Error(`Expected ${e} but got ${a}`);
    },
  };
}

const etsyPrompt = "Open Etsy and search for 'wooden cross wall art' then click the first result.";

(async () => {
// ═══════════════════════════════════════════════════════════════════════════════
section('1 — classifyTask forces public_read for search-to-extract prompts');
// ═══════════════════════════════════════════════════════════════════════════════

await it('forces public_read when LLM incorrectly returns interactive for Etsy prompt', async () => {
  const llmBackend = {
    generateAnswer: async () => JSON.stringify({
      taskType: 'browser',
      targetService: 'etsy',
      requiresDOM: true,
      webAccessMode: 'interactive',
      interactiveActions: [],
    }),
  };
  const result = await classifyTask(etsyPrompt, [], llmBackend, console);
  expect(result.webAccessMode).toBe('public_read');
  expect(result.requiresDOM).toBe(false);
  expect(result.interactiveActions).toEqual([]);
});

await it('keeps interactive when a mutation action is present', async () => {
  const llmBackend = {
    generateAnswer: async () => JSON.stringify({
      taskType: 'browser',
      targetService: 'amazon',
      requiresDOM: true,
      webAccessMode: 'interactive',
      interactiveActions: ['add_to_cart'],
    }),
  };
  const result = await classifyTask('Search Amazon for X then click the first result and add to cart', [], llmBackend, console);
  expect(result.webAccessMode).toBe('interactive');
});

// ═══════════════════════════════════════════════════════════════════════════════
section('2 — planSkillsV2 post-parse backstop rewrites browser.agent → web skills');
// ═══════════════════════════════════════════════════════════════════════════════

await it('rewrites browser.agent plan to web.agent + web.crawl for public_read', async () => {
  const rawPlan = JSON.stringify([{
    skill: 'browser.agent',
    args: { action: 'run', agentId: 'etsy.agent', task: etsyPrompt },
    description: 'Open Etsy search',
  }]);
  const state = {
    message: etsyPrompt,
    resolvedMessage: etsyPrompt,
    intent: { type: 'command_automate' },
    _taskClassification: {
      taskType: 'browser',
      targetService: 'etsy',
      webAccessMode: 'public_read',
      requiresDOM: false,
      interactiveActions: [],
    },
    conversationHistory: [],
    preflightResult: {},
    logger: console,
    llmBackend: {
      generateAnswer: async () => rawPlan,
    },
  };
  const result = await planSkillsV2(state);
  if (!result._skillPlanFile || !fs.existsSync(result._skillPlanFile)) {
    throw new Error('Plan file was not written');
  }
  const md = fs.readFileSync(result._skillPlanFile, 'utf8');
  const fmMatch = md.match(/^---\n(.*?)\n---/s);
  if (!fmMatch) throw new Error('No frontmatter in plan file');
  const jsonMatch = fmMatch[1].match(/skill_plan_json:\s*'([^']+)'/);
  if (!jsonMatch) throw new Error('No skill_plan_json frontmatter');
  const plan = JSON.parse(Buffer.from(jsonMatch[1], 'base64').toString('utf8'));

  if (plan.some(s => s.skill === 'browser.agent')) {
    throw new Error(`Plan still contains browser.agent: ${JSON.stringify(plan)}`);
  }
  if (!plan.some(s => s.skill === 'web.agent' && s.args?.action === 'site_search')) {
    throw new Error(`Plan missing web.agent site_search: ${JSON.stringify(plan)}`);
  }
  if (!plan.some(s => s.skill === 'web.crawl' && s.args?.extractItems === true)) {
    throw new Error(`Plan missing web.crawl extractItems: ${JSON.stringify(plan)}`);
  }
  if (!plan.some(s => s.skill === 'web.crawl' && s.args?.hidden === true)) {
    throw new Error(`Plan missing web.crawl hidden:true: ${JSON.stringify(plan)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n❌ ${_failed} failed, ✅ ${_passed} passed`);
if (_failed > 0) {
  for (const f of _failures) console.log(`  - ${f.label}: ${f.error}`);
  process.exit(1);
}
})();

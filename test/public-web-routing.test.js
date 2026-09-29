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
section('3 — real-browser lane survives the public_read backstop');
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: run planSkillsV2 with a stub LLM emitting rawPlan, read back the
// parsed skill_plan_json frontmatter from the written plan file.
async function planViaStub(rawPlan, tcOverrides = {}) {
  const state = {
    message: 'what is on this page',
    resolvedMessage: 'what is on this page',
    intent: { type: 'command_automate' },
    _taskClassification: {
      taskType: 'query', targetService: null, webAccessMode: 'public_read',
      requiresDOM: false, interactiveActions: [], activeDocRef: 'url',
      activeDocTarget: 'https://example.com/page',
      ...tcOverrides,
    },
    conversationHistory: [],
    preflightResult: {},
    logger: console,
    llmBackend: { generateAnswer: async () => JSON.stringify(rawPlan) },
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
  return JSON.parse(Buffer.from(jsonMatch[1], 'base64').toString('utf8'));
}

await it('keeps app.agent scan_page on public_read (this-page question)', async () => {
  const plan = await planViaStub([
    { skill: 'app.agent', args: { action: 'scan_page' }, description: 'Copy the open page text' },
    { skill: 'synthesize', args: { prompt: 'Answer from the page copy' }, description: 'Answer' },
  ]);
  if (!plan.some(s => s.skill === 'app.agent' && s.args?.action === 'scan_page')) {
    throw new Error(`scan_page was rewritten: ${JSON.stringify(plan.map(s => s.skill))}`);
  }
  if (plan.some(s => s.skill === 'web.agent' || s.skill === 'web.crawl')) {
    throw new Error(`web steps injected over scan_page: ${JSON.stringify(plan.map(s => s.skill))}`);
  }
});

await it('keeps navigate_url + scan_page on public_read (goto-and-read)', async () => {
  const plan = await planViaStub([
    { skill: 'app.agent', args: { action: 'navigate_url', url: 'https://www.google.com/search?q=x' }, description: 'Open search' },
    { skill: 'app.agent', args: { action: 'scan_page' }, description: 'Copy page' },
    { skill: 'synthesize', args: { prompt: 'Summarize' }, description: 'Answer' },
  ]);
  const appSteps = plan.filter(s => s.skill === 'app.agent').map(s => s.args?.action);
  if (!appSteps.includes('navigate_url') || !appSteps.includes('scan_page')) {
    throw new Error(`real-browser lane rewritten: ${JSON.stringify(plan.map(s => s.skill))}`);
  }
});

await it('still rewrites non-lane app.agent actions on public_read', async () => {
  const plan = await planViaStub([
    { skill: 'app.agent', args: { action: 'type_text', text: 'hello' }, description: 'Type text' },
    { skill: 'synthesize', args: { prompt: 'Summarize' }, description: 'Answer' },
  ]);
  if (plan.some(s => s.skill === 'app.agent')) {
    throw new Error(`type_text survived: ${JSON.stringify(plan.map(s => s.skill))}`);
  }
  if (!plan.some(s => s.skill === 'web.agent')) {
    throw new Error(`missing web.agent rewrite: ${JSON.stringify(plan.map(s => s.skill))}`);
  }
});

await it('download mode still rewrites scan_page', async () => {
  const plan = await planViaStub([
    { skill: 'app.agent', args: { action: 'scan_page' }, description: 'Copy page' },
    { skill: 'synthesize', args: { prompt: 'Confirm' }, description: 'Answer' },
  ], { webAccessMode: 'download', activeDocRef: null, activeDocTarget: null });
  if (plan.some(s => s.skill === 'app.agent')) {
    throw new Error(`scan_page survived on download mode: ${JSON.stringify(plan.map(s => s.skill))}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n❌ ${_failed} failed, ✅ ${_passed} passed`);
if (_failed > 0) {
  for (const f of _failures) console.log(`  - ${f.label}: ${f.error}`);
  process.exit(1);
}
})();

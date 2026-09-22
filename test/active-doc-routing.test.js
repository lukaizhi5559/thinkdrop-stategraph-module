'use strict';
/**
 * active-doc-routing.test.js
 *
 * Regression tests for the deterministic active-document flow:
 *   1. classifyTask activeDocRef/activeDocTarget — LLM resolves the KIND of
 *      referent; the concrete path/url is attached deterministically by
 *      resolveReferencesV2 from live context (no hallucinated paths)
 *   2. Downgrade: activeDocRef='file' with a missing path → 'screen'
 *   3. parseIntentV2 override — screen_intelligence + file/url doc ref →
 *      command_automate; 'screen' ref stays OCR
 *   4. _sanitizeSkillPlan — fills edit.agent.filePath / fs.read.path /
 *      web.crawl.url from _priorScreenContext
 *
 * Run with: node test/active-doc-routing.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let _passed = 0, _failed = 0;
const _failures = [];

async function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  await fn();
}
function check(name, cond, extra = '') {
  if (cond) { _passed++; console.log(`  ✓ ${name}`); }
  else { _failed++; _failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const resolveReferencesV2 = require('../src/nodes/resolveReferencesV2');
const parseIntentV2 = require('../src/nodes/parseIntentV2');
const { _sanitizeSkillPlan } = require('../src/nodes/planSkillsV2');

const _logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

// ── mcpAdapter stub — canned responses per service/method ────────────────────
function makeMcp({ app }) {
  return {
    callService: async (_svc, method) => {
      if (method === 'session.route') return { sessionId: 'sess-1' };
      if (method === 'message.list') return { messages: [] };
      if (method === 'message.search') return { messages: [] };
      if (method === 'memory.getRecentOcr') return { available: false };
      if (method === 'memory.getActiveAppContext') return { app };
      return {};
    },
  };
}

function makeLlm(payload) {
  return { generateAnswer: async () => JSON.stringify(payload) };
}

const BASE_CLASSIFY = {
  taskType: 'local_file', isFollowUp: false, followUpTarget: null,
  needsClarification: false, targetService: null, isRecurring: false,
  isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
  needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
  isImageAnalysis: false, isConversationRecall: false, isActivityQuery: false,
  webAccessMode: 'none', interactiveActions: [], expectsFileOutput: false,
};

async function main() {

  // ── 1. activeDocRef=file → deterministic target from live context ──────────
  await describe('resolveReferencesV2 — activeDocRef resolution', async () => {
    const tmpFile = path.join(os.tmpdir(), `td-doc-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# hello\n');

    let out = await resolveReferencesV2({
      message: 'fix the typo in this file',
      mcpAdapter: makeMcp({ app: { appName: 'TextEdit', category: 'editor', filePath: tmpFile, source: 'live', timestamp: new Date().toISOString() } }),
      llmBackend: makeLlm({ ...BASE_CLASSIFY, activeDocRef: 'file' }),
      context: { sessionId: 'sess-1' },
      logger: _logger,
    });
    check('file ref → activeDocRef stays file', out._taskClassification.activeDocRef === 'file');
    check('file ref → activeDocTarget = live filePath', out._taskClassification.activeDocTarget === tmpFile);

    // ── 2. Missing file → downgrade to screen ────────────────────────────────
    const ghost = '/nonexistent/path/to/file.md';
    out = await resolveReferencesV2({
      message: 'fix the typo in this file',
      mcpAdapter: makeMcp({ app: { appName: 'TextEdit', category: 'editor', filePath: ghost, source: 'live', timestamp: new Date().toISOString() } }),
      llmBackend: makeLlm({ ...BASE_CLASSIFY, activeDocRef: 'file' }),
      context: { sessionId: 'sess-1' },
      logger: _logger,
    });
    check('missing file → downgraded to screen', out._taskClassification.activeDocRef === 'screen',
      `got ${out._taskClassification.activeDocRef}`);

    // ── 3. URL ref → target = live url ───────────────────────────────────────
    out = await resolveReferencesV2({
      message: "what's this page about",
      mcpAdapter: makeMcp({ app: { appName: 'Google Chrome', category: 'browser', url: 'https://example.com/recipe', source: 'live', timestamp: new Date().toISOString() } }),
      llmBackend: makeLlm({ ...BASE_CLASSIFY, taskType: 'query', activeDocRef: 'url' }),
      context: { sessionId: 'sess-1' },
      logger: _logger,
    });
    check('url ref → activeDocRef stays url', out._taskClassification.activeDocRef === 'url');
    check('url ref → activeDocTarget = live url', out._taskClassification.activeDocTarget === 'https://example.com/recipe');

    // ── 4. No doc referent → null ────────────────────────────────────────────
    out = await resolveReferencesV2({
      message: 'what time is it',
      mcpAdapter: makeMcp({ app: { appName: 'Google Chrome', category: 'browser', url: 'https://example.com', source: 'live', timestamp: new Date().toISOString() } }),
      llmBackend: makeLlm({ ...BASE_CLASSIFY, taskType: 'local_system', activeDocRef: null }),
      context: { sessionId: 'sess-1' },
      logger: _logger,
    });
    check('no referent → activeDocRef null', out._taskClassification.activeDocRef == null);

    fs.unlinkSync(tmpFile);
  });

  // ── 5. parseIntentV2 — activeDocRef override ───────────────────────────────
  await describe('parseIntentV2 — screen_intelligence → command_automate', async () => {
    const mkState = (ref) => ({
      message: "what's this page about",
      intentPlan: [{ order: 0, text: "what's this page about", estimatedIntent: 'screen_intelligence', confidence: 0.9, dependsOn: [] }],
      _taskClassification: { ...BASE_CLASSIFY, activeDocRef: ref },
      logger: _logger,
    });

    let out = await parseIntentV2(mkState('url'));
    check('url ref → command_automate', out.intent.type === 'command_automate', `got ${out.intent.type}`);

    out = await parseIntentV2(mkState('file'));
    check('file ref → command_automate', out.intent.type === 'command_automate', `got ${out.intent.type}`);

    out = await parseIntentV2(mkState('screen'));
    check('screen ref → stays screen_intelligence', out.intent.type === 'screen_intelligence', `got ${out.intent.type}`);

    out = await parseIntentV2(mkState(null));
    check('null ref → stays screen_intelligence', out.intent.type === 'screen_intelligence', `got ${out.intent.type}`);
  });

  // ── 6. _sanitizeSkillPlan — doc-target fill ────────────────────────────────
  await describe('_sanitizeSkillPlan — fills targets from _priorScreenContext', () => {
    const ctx = { filePath: '/Users/x/notes.md', url: 'https://example.com/page', appName: 'TextEdit' };

    let plan = _sanitizeSkillPlan([
      { skill: 'edit.agent', args: { goal: 'fix typos' }, description: 'edit' },
      { skill: 'fs.read', args: {}, description: 'read' },
      { skill: 'web.crawl', args: {}, description: 'crawl' },
      { skill: 'fs.read', args: { path: '/explicit/path.md' }, description: 'read' },
      { skill: 'web.crawl', args: { url: 'https://explicit.com' }, description: 'crawl' },
    ], { _priorScreenContext: ctx });

    check('edit.agent.filePath filled', plan[0].args.filePath === '/Users/x/notes.md');
    check('fs.read.path filled', plan[1].args.path === '/Users/x/notes.md');
    check('web.crawl.url filled', plan[2].args.url === 'https://example.com/page');
    check('explicit fs.read.path untouched', plan[3].args.path === '/explicit/path.md');
    check('explicit web.crawl.url untouched', plan[4].args.url === 'https://explicit.com');

    // No context → no fill (downstream ask_user/error paths unchanged)
    plan = _sanitizeSkillPlan([
      { skill: 'edit.agent', args: { goal: 'fix typos' } },
    ], { _priorScreenContext: null });
    check('no context → no fill', !plan[0].args.filePath);
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${_passed} passed, ${_failed} failed`);
  if (_failures.length) console.log(`  Failures: ${_failures.join(', ')}`);
  console.log('═'.repeat(70));
  process.exit(_failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

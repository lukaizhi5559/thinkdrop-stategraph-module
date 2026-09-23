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
const { _sanitizeSkillPlan, _resolveCtxUrlTokens } = require('../src/nodes/planSkillsV2');
const { _stripAttachmentTags } = require('../src/utils/classifyTask');

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
      mcpAdapter: makeMcp({ app: { appName: 'Google Chrome', category: 'browser', url: 'https://example.com/recipe', windowId: 4242, source: 'live', timestamp: new Date().toISOString() } }),
      llmBackend: makeLlm({ ...BASE_CLASSIFY, taskType: 'query', activeDocRef: 'url' }),
      context: { sessionId: 'sess-1' },
      logger: _logger,
    });
    check('url ref → activeDocRef stays url', out._taskClassification.activeDocRef === 'url');
    check('url ref → activeDocTarget = live url', out._taskClassification.activeDocTarget === 'https://example.com/recipe');
    check('url flows into _priorScreenContext', out._priorScreenContext?.url === 'https://example.com/recipe');
    check('windowId flows into _priorScreenContext', out._priorScreenContext?.windowId === 4242);

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
    // Anti-hallucination guard: a URL literal that is neither the context URL
    // nor user-typed is substituted with the context URL when one exists.
    check('invented web.crawl.url → substituted with context URL', plan[4].args.url === 'https://example.com/page');

    // No context → no fill (downstream ask_user/error paths unchanged)
    plan = _sanitizeSkillPlan([
      { skill: 'edit.agent', args: { goal: 'fix typos' } },
    ], { _priorScreenContext: null });
    check('no context → no fill', !plan[0].args.filePath);
  });

  // ── 6b. _sanitizeSkillPlan — invented-URL guard ────────────────────────────
  await describe('_sanitizeSkillPlan — invented URL guard', () => {
    // The real incident: "print this page" with no URL in context produced a
    // Chrome --print-to-pdf step pointing at https://www.google.com.
    let plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'f="/tmp/p.pdf"; chrome --print-to-pdf="$f" "https://www.google.com" && lp "$f"'] }, description: 'print' },
    ], { _priorScreenContext: { appName: 'Google Chrome' }, message: 'print this page for me' });
    check('invented URL + no context URL → ask_user inserted before step', plan[0].skill === 'ask_user');
    check('ask_user carries a question', typeof plan[0].args?.question === 'string' && plan[0].args.question.length > 0);
    check('ask_user collects into varName', typeof plan[0].args?.varName === 'string' && plan[0].args.varName.length > 0);
    // The original step survives — invented literal rewritten to the gather
    // token so the plan pauses for the answer, then runs it.
    check('original step kept with {{_ctx_url}} token',
      plan[1]?.skill === 'shell.run' && plan[1].args.argv[1].includes(`{{${plan[0].args.varName}}}`)
        && !plan[1].args.argv[1].includes('google.com'));

    // Context URL present → invented literal is substituted in place.
    plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'chrome --print-to-pdf=/tmp/p.pdf "https://www.google.com" && lp /tmp/p.pdf'] }, description: 'print' },
    ], { _priorScreenContext: { appName: 'Google Chrome', url: 'https://www.seriouseats.com/recipe' }, message: 'print this page' });
    check('invented URL → substituted with context URL',
      plan[0].skill === 'shell.run' && plan[0].args.argv[1].includes('https://www.seriouseats.com/recipe')
        && !plan[0].args.argv[1].includes('google.com'));

    // User-typed URL → allowed through untouched.
    plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'curl -sL "https://news.ycombinator.com" -o /tmp/hn.html'] }, description: 'fetch' },
    ], { _priorScreenContext: null, message: 'download https://news.ycombinator.com for me' });
    check('user-typed URL → untouched',
      plan[0].skill === 'shell.run' && plan[0].args.argv[1].includes('news.ycombinator.com'));

    // Context URL itself → allowed.
    plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'chrome --print-to-pdf=/tmp/p.pdf "https://www.seriouseats.com/recipe" && lp /tmp/p.pdf'] }, description: 'print' },
    ], { _priorScreenContext: { url: 'https://www.seriouseats.com/recipe' }, message: 'print this page' });
    check('context URL → untouched',
      plan[0].skill === 'shell.run' && plan[0].args.argv[1].includes('seriouseats.com'));
  });

  // ── 6c. _resolveCtxUrlTokens — resume-time context reconciliation ──────────
  // The plan was built when no URL existed (ask_user + {{_ctx_url_N}} token).
  // By approval time the live URL resolved — the token should substitute and
  // the paired ask_user step should drop out.
  await describe('_resolveCtxUrlTokens — fresh context resolves pending tokens', () => {
    const mkPausedPlan = () => [
      { skill: 'ask_user', args: { question: 'Which page?', varName: '_ctx_url_0', options: [] }, description: 'Clarify' },
      { skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'chrome --print-to-pdf=/tmp/p.pdf "{{_ctx_url_0}}" && lp /tmp/p.pdf'] }, description: 'print' },
      { skill: 'synthesize', args: {}, description: 'report' },
    ];

    let out = _resolveCtxUrlTokens(mkPausedPlan(), 'https://www.seriouseats.com/recipe', {}, { info: () => {} });
    check('fresh context URL → token substituted',
      out.find(s => s.skill === 'shell.run')?.args.argv[1].includes('https://www.seriouseats.com/recipe'));
    check('satisfied ask_user removed',
      out.length === 2 && !out.some(s => s.skill === 'ask_user'));

    // User already answered the question → their answer beats context.
    out = _resolveCtxUrlTokens(mkPausedPlan(), 'https://www.seriouseats.com/recipe',
      { _ctx_url_0: 'https://example.com/user-typed' }, { info: () => {} });
    check('answered varName → token left for _gatheredVars',
      out.find(s => s.skill === 'shell.run')?.args.argv[1].includes('{{_ctx_url_0}}')
        && out.length === 3);

    // No context URL → plan untouched.
    out = _resolveCtxUrlTokens(mkPausedPlan(), null, {}, { info: () => {} });
    check('no context URL → plan untouched',
      out.length === 3 && out[1].args.argv[1].includes('{{_ctx_url_0}}'));
  });

  // ═══ Attachment-tag stripping (overlay injects [Thought:…] etc. before the
  // ═══ user's text — they must not reach the classifier) ═════════════════════
  await describe('_stripAttachmentTags — overlay attachment tags', () => {
    check('leading [Thought:] block stripped',
      _stripAttachmentTags('[Thought: You recently viewed a recipe?]\n\nprint this page for me')
        === 'print this page for me');
    check('stacked tags all stripped',
      _stripAttachmentTags('[File: /tmp/a.txt]\n[Highlighted: some code]\nprint this page')
        === 'print this page');
    check('multi-line [Highlighted:] block stripped',
      _stripAttachmentTags('[Highlighted: line one\nline two]\n\nwhat does this do')
        === 'what does this do');
    check('plain message untouched',
      _stripAttachmentTags('print this page for me') === 'print this page for me');
    check('tag mid-message preserved',
      _stripAttachmentTags('what does [Thought: x] mean') === 'what does [Thought: x] mean');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${_passed} passed, ${_failed} failed`);
  if (_failures.length) console.log(`  Failures: ${_failures.join(', ')}`);
  console.log('═'.repeat(70));
  process.exit(_failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

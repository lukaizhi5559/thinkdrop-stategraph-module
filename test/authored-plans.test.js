'use strict';
/**
 * authored-plans.test.js
 *
 * Phase-5 coverage for the authored-plan architecture:
 *   - slot extraction + positional rebinding (rebindPlanSlots / mergePlanSlots)
 *   - shared cache-complete predicate (_isCacheCompleteContent)
 *   - machine-checkable skill contracts (validatePlanSteps)
 *   - task-plan → skill_plan_json bridge (planRunner._writePlanStatus)
 *   - needs_plan gate (gatherPlanContext no-coverage escalation)
 *
 * Run: node stategraph-module/test/authored-plans.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractSlots,
  slotSetsEqual,
  mergePlanSlots,
  rebindPlanSlots,
  _isCacheCompleteContent,
} = require('../src/utils/planCacheHelpers.js');
const { validatePlanSteps, contractFor, listSkills } = require('../../shared/skill-contracts.cjs');
const gatherPlanContext = require('../src/nodes/gatherPlanContext.js');

let _passed = 0, _failed = 0;
const _failures = [];
async function it(label, fn) {
  try { await fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push(label); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'mismatch'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

// ── 1. Slot extraction ───────────────────────────────────────────────────────
(async () => {
console.log('\n─ slots: extractSlots / slotSetsEqual / mergePlanSlots ─');

await it('extractSlots finds emails, urls, paths, quotes, numbers', () => {
  const s = extractSlots('commit /Users/me/repo to https://github.com/x and email a@b.com — "msg 42"');
  assert(s.emails.includes('a@b.com'), 'email missing');
  assert(s.urls.some(u => u.includes('github.com')), 'url missing');
  // extractSlots lowercases for equality semantics
  assert(s.filePaths.some(p => p.includes('/users/me/repo')), `path missing: ${JSON.stringify(s.filePaths)}`);
  assert(s.quotedStrings.length === 1, 'quote missing');
  assert(s.numbers.includes('42'), 'number missing');
});

await it('slotSetsEqual distinguishes paraphrase from different target', () => {
  assert(slotSetsEqual('commit /tmp/a', 'commit /tmp/a'), 'same slots should be equal');
  assert(!slotSetsEqual('commit /tmp/a', 'commit /tmp/b'), 'different paths should differ');
});

await it('mergePlanSlots merges args across steps', () => {
  const plan = [
    { skill: 'shell.run', args: { cmd: 'git', argv: ['-C', '/Users/me/repo', 'add', '-A'] } },
    { skill: 'synthesize', args: { prompt: 'write a message for /Users/me/repo' } },
  ];
  const m = mergePlanSlots(plan);
  assert((m.filePaths || []).some(p => p.includes('/users/me/repo')), `merged path missing: ${JSON.stringify(m.filePaths)}`);
});

// ── 2. rebindPlanSlots ───────────────────────────────────────────────────────
console.log('\n─ rebindPlanSlots ─');

const REAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rebind-a-'));
const OTHER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rebind-b-'));

await it('rebinds a 1:1 path substitution', () => {
  const plan = [{ skill: 'shell.run', args: { cmd: 'git', argv: ['-C', REAL_DIR, 'commit', '-m', 'x'] } }];
  const r = rebindPlanSlots(plan, `commit ${OTHER_DIR}`, { logger });
  assert(r.ok, `rebind failed: ${r.reason}`);
  assertEq(r.bindings.length, 1, 'expected one binding');
  // Rebound plan must preserve the prompt's original case (case-sensitive FS).
  assert(JSON.stringify(r.skillPlan).includes(OTHER_DIR), `plan did not rebind: ${JSON.stringify(r.skillPlan)}`);
});

await it('rejects ambiguous rebind (count mismatch)', () => {
  const plan = [{ skill: 'shell.run', args: { cmd: 'git', argv: ['-C', REAL_DIR, 'status'] } }];
  const r = rebindPlanSlots(plan, `commit ${OTHER_DIR} and /tmp/extra-dir-here`, { logger });
  assert(!r.ok, 'ambiguous rebind should fail');
  assert(/ambiguous/.test(r.reason || ''), 'reason should say ambiguous');
});

await it('rejects rebind when bound path does not exist', () => {
  const plan = [{ skill: 'shell.run', args: { cmd: 'git', argv: ['-C', REAL_DIR, 'status'] } }];
  const r = rebindPlanSlots(plan, 'commit /definitely/not/a/real/path-xyz-123', { logger });
  assert(!r.ok, 'missing path should be rejected');
  assert(/missing/.test(r.reason || ''), 'reason should mention missing');
});

await it('no-op when slots already match', () => {
  const plan = [{ skill: 'shell.run', args: { cmd: 'git', argv: ['-C', REAL_DIR, 'status'] } }];
  const r = rebindPlanSlots(plan, `check status in ${REAL_DIR}`, { logger });
  assert(r.ok, `should be ok: ${r.reason}`);
  assertEq(r.bindings.length, 0, 'no bindings expected');
});

// ── 3. _isCacheCompleteContent ───────────────────────────────────────────────
console.log('\n─ _isCacheCompleteContent ─');

await it('status:complete is cache-complete', () => {
  assert(_isCacheCompleteContent('---\nname: x\n---', 'complete'), 'complete status rejected');
});

await it('done task_plan WITH skill_plan_json is cache-complete (bridge)', () => {
  const content = 'kind: task_plan\nskill_plan_json: \'abc==\'\n';
  assert(_isCacheCompleteContent(content, 'done'), 'bridged done plan rejected');
});

await it('done WITHOUT skill_plan_json is NOT cache-complete', () => {
  assert(!_isCacheCompleteContent('kind: task_plan\n', 'done'), 'unbridged done plan accepted');
});

await it('other statuses are not cache-complete', () => {
  for (const st of ['running', 'failed', 'draft', 'unverified']) {
    assert(!_isCacheCompleteContent('skill_plan_json: \'x\'', st), `${st} should not qualify`);
  }
});

// ── 4. validatePlanSteps (contract registry) ────────────────────────────────
console.log('\n─ validatePlanSteps ─');

await it('registry covers the catalog vocabulary', () => {
  const names = listSkills();
  for (const s of ['shell.run', 'cli.agent', 'browser.agent', 'url.first.agent', 'synthesize', 'web.agent']) {
    assert(names.includes(s), `missing contract for ${s}`);
  }
});

await it('flags cli.agent wildcard task string', () => {
  const v = validatePlanSteps([{ skill: 'cli.agent', args: { action: 'run', agentId: 'git.agent', task: 'commit stuff' } }]);
  assert(v.violations.some(x => x.msg.startsWith('wildcard:')), 'wildcard not flagged');
});

await it('flags shell.run goal-mode wildcard', () => {
  const v = validatePlanSteps([{ skill: 'shell.run', args: { goal: 'find and commit repos' } }]);
  assert(v.violations.some(x => x.msg.startsWith('wildcard:')), 'goal wildcard not flagged');
});

await it('accepts argv-literal shell.run', () => {
  const v = validatePlanSteps([{ skill: 'shell.run', args: { cmd: 'git', argv: ['-C', '/tmp', 'status'] } }]);
  const hard = v.violations.filter(x => !x.msg.startsWith('wildcard:'));
  assertEq(hard.length, 0, `hard violations: ${JSON.stringify(hard)}`);
});

await it('flags missing required arg and unknown skill/arg', () => {
  const v = validatePlanSteps([
    { skill: 'doc.read', args: {} },
    { skill: 'does.not.exist', args: {} },
    { skill: 'shell.run', args: { cmd: 'ls', bogus: 1 } },
  ]);
  const msgs = v.violations.map(x => x.msg).join(' | ');
  assert(/required arg/.test(msgs), 'required-arg violation missing');
  assert(/unknown skill/.test(msgs), 'unknown-skill violation missing');
  assert(/unknown arg/.test(msgs), 'unknown-arg violation missing');
});

await it('flags session-bound step with no agentId/service/sessionId/url', () => {
  const c = contractFor('dom.act');
  assert(c && c.sessionBound === true, 'dom.act should be session-bound in registry');
  const v = validatePlanSteps([{ skill: 'dom.act', args: { action: 'click', goal: 'click x' } }]);
  assert(v.violations.some(x => /session-bound/.test(x.msg)), 'session-bound violation missing');
});

// ── 5. planRunner bridge — task_plan → skill_plan_json ──────────────────────
console.log('\n─ planRunner bridge ─');

await it('done task plan with compiled steps writes skill_plan_json + slots_json', () => {
  const { _writePlanStatus } = require('../../src/main/planRunner.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-'));
  const planPath = path.join(tmpDir, 'plan_x.md');
  fs.writeFileSync(planPath, '---\nkind: task_plan\nstatus: running\nname: test.bridge\n---\n\n# Tasks\n');
  const run = {
    planId: 'plan_x', planPath, status: 'running',
    tasks: [
      { num: 1, title: 'step a', status: 'done', steps: [{ skill: 'shell.run', args: { cmd: 'git', argv: ['-C', REAL_DIR, 'status'] } }] },
      { num: 2, title: 'step b', status: 'done', steps: null },
    ],
  };
  _writePlanStatus(run, 'done');
  const md = fs.readFileSync(planPath, 'utf8');
  assert(/status:\s*done/.test(md), 'status not written');
  const m = md.match(/skill_plan_json:\s*'([^']+)'/);
  assert(m, 'skill_plan_json missing');
  const plan = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  assertEq(plan.length, 1, 'flattened plan should have 1 step');
  assertEq(plan[0].skill, 'shell.run', 'step skill wrong');
  const sm = md.match(/slots_json:\s*'([^']+)'/);
  assert(sm, 'slots_json missing');
  const slots = JSON.parse(Buffer.from(sm[1], 'base64').toString('utf8'));
  assert((slots.filePaths || []).some(p => p.includes('rebind')), 'slot manifest missing path');
});

await it('contract-invalid steps do NOT bridge', () => {
  const { _writePlanStatus } = require('../../src/main/planRunner.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-bad-'));
  const planPath = path.join(tmpDir, 'plan_y.md');
  fs.writeFileSync(planPath, '---\nkind: task_plan\nstatus: running\n---\n\n# Tasks\n');
  const run = {
    planId: 'plan_y', planPath, status: 'running',
    tasks: [{ num: 1, title: 't', status: 'done', steps: [{ skill: 'totally.bogus', args: {} }] }],
  };
  _writePlanStatus(run, 'done');
  const md = fs.readFileSync(planPath, 'utf8');
  assert(!/skill_plan_json/.test(md), 'invalid plan should not bridge');
});

await it('non-done statuses do not bridge', () => {
  const { _writePlanStatus } = require('../../src/main/planRunner.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-fail-'));
  const planPath = path.join(tmpDir, 'plan_z.md');
  fs.writeFileSync(planPath, '---\nkind: task_plan\nstatus: running\n---\n\n# Tasks\n');
  const run = {
    planId: 'plan_z', planPath, status: 'running',
    tasks: [{ num: 1, title: 't', status: 'done', steps: [{ skill: 'shell.run', args: { cmd: 'ls' } }] }],
  };
  _writePlanStatus(run, 'failed');
  const md = fs.readFileSync(planPath, 'utf8');
  assert(!/skill_plan_json/.test(md), 'failed plan should not bridge');
});

// ── 6. needs_plan gate (gatherPlanContext) ──────────────────────────────────
console.log('\n─ needs_plan gate ─');

const _stubBackend = { generateAnswer: async () => '{"complete":true}' };

await it('no coverage → _needsPlan no_skill_coverage', async () => {
  const out = await gatherPlanContext({
    intent: { type: 'command_automate' },
    message: 'organize my downloads by file type',
    resolvedMessage: 'organize my downloads by file type',
    llmBackend: _stubBackend,
    logger,
    _taskClassification: { taskType: 'local_file' },
    conversationHistory: [],
  });
  assert(out._needsPlan, 'needsPlan not set');
  assertEq(out._needsPlan.reason, 'no_skill_coverage', 'wrong reason');
  assert(out.planGatheringComplete === true, 'gather not marked complete');
});

await it('_allowPlannerFallback skips the gate', async () => {
  const out = await gatherPlanContext({
    intent: { type: 'command_automate' },
    message: 'organize my downloads by file type',
    resolvedMessage: 'organize my downloads by file type',
    llmBackend: _stubBackend,
    logger,
    _allowPlannerFallback: true,
    _taskClassification: { taskType: 'local_file' },
    conversationHistory: [],
  });
  assert(!out._needsPlan, 'fallback should bypass needs_plan');
});

await it('deterministic plan present → no escalation', async () => {
  const out = await gatherPlanContext({
    intent: { type: 'command_automate' },
    message: 'list files',
    resolvedMessage: 'list files',
    llmBackend: _stubBackend,
    logger,
    _deterministicPlan: [{ skill: 'shell.run', args: { cmd: 'ls' } }],
    _taskClassification: { taskType: 'local_file' },
    conversationHistory: [],
  });
  assert(!out._needsPlan, 'deterministic plan should cover');
});

await it('non-automate intents skip the gate entirely', async () => {
  const out = await gatherPlanContext({
    intent: { type: 'answer' },
    message: 'what time is it',
    llmBackend: _stubBackend,
    logger,
  });
  assert(!out._needsPlan, 'answer intent must not escalate');
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${_passed} passed, ${_failed} failed`);
if (_failures.length) console.log(`  FAILING: ${_failures.join(', ')}`);
console.log(`${'═'.repeat(60)}`);
process.exit(_failed ? 1 : 0);
})();

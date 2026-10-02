'use strict';
/**
 * plan-cache-normalize.test.js
 *
 * Plan-cache exact-match must ignore run-injected metadata. Stored plans embed
 * the enriched prompt — e.g. `[Additional context: Route: google_docs: unknown]`
 * — which previously made normalizePrompt() never match the identical re-run
 * (the raw prompt lacks the enrichment). This pins the strip + the match.
 *
 * Run: node stategraph-module/test/plan-cache-normalize.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizePrompt, findSimilarCompletePlan } = require('../src/utils/planCacheHelpers.js');

let _passed = 0, _failed = 0;
async function it(label, fn) {
  try { await fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}
const expect = (v, msg) => { if (!v) throw new Error(msg); };

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');
const RAW = 'Open FakeSite and do the widget thing';
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function _writePlan(prompt) {
  const skillPlan = [{ step: 1, skill: 'browser.agent', args: { task: prompt }, description: 'do the thing' }];
  const b64 = Buffer.from(JSON.stringify(skillPlan)).toString('base64');
  const id = `plan_zzcachetest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const file = path.join(PLANS_DIR, `${id}.md`);
  const safePrompt = String(prompt).replace(/"/g, '\\"').slice(0, 300);
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(file, [
    '---',
    `id: ${id}`,
    `created: ${new Date().toISOString()}`,
    'status: complete',
    `original_prompt: "${safePrompt}"`,
    'session_id: test',
    'skill_plan: true',
    `skill_plan_json: '${b64}'`,
    '---',
    '',
    `# Plan: ${safePrompt.split(/\s+/).slice(0, 6).join(' ')}`,
  ].join('\n'), 'utf8');
  return file;
}

async function main() {
  console.log('\n  plan-cache normalization\n' + '─'.repeat(60));

  await it('normalizePrompt strips [Additional context: ...] blocks', async () => {
    const a = normalizePrompt(RAW);
    const b = normalizePrompt(`${RAW}\n[Additional context: Route: fakesite: unknown]`);
    const c = normalizePrompt(`${RAW} [Additional context: Route: fakesite: browser]`);
    expect(a === b, `enriched stored prompt did not normalize to raw: "${b}"`);
    expect(a === c, `differing enrichment broke the match: "${c}"`);
  });

  await it('normalizePrompt preserves user-authored brackets', async () => {
    const d = normalizePrompt('add item [urgent] to my list');
    expect(d.includes('urgent'), `user bracket content lost: "${d}"`);
  });

  let planFile = null;
  await it('findSimilarCompletePlan hits a stored prompt with different injected context', async () => {
    planFile = _writePlan(`${RAW}\n[Additional context: Route: fakesite: unknown]`);
    const hit = await findSimilarCompletePlan(RAW, null, logger, null);
    expect(hit, 'expected a cache hit for the raw prompt');
    expect(hit.autoExecute === true, `expected autoExecute on exact normalized match, got ${hit.autoExecute}`);
  });

  try { if (planFile) fs.unlinkSync(planFile); } catch (_) {}

  console.log(`\n${_passed} passed, ${_failed} failed.`);
  if (_failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

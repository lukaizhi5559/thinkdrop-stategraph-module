'use strict';

/**
 * plan-skill-gates.test.js
 *
 * Regression tests for the reminder-run failure chain:
 *
 *   1. A graph node name ('evaluate_skills') reached dispatch as a plan step
 *      → 'Unknown skill' → a second recovery loop. _sanitizeSkillPlan must
 *      mark non-dispatchable skills skipped before they can dispatch.
 *   2. generateSingleStep echoed 'evaluate_skills' as the replacement step's
 *      skill with no validation — it must signal _needsFullReplan instead.
 *   3. The flight follow-up emitted `shell.run open <google-flights-url>`
 *      with a past year and NO read step → 'ambiguous' answer. Sanitize
 *      must repair the stale year and append a scan_page verify step
 *      (browser-off canon).
 *   4. The app.agent contract rejected `task` (the arg run_agent actually
 *      requires) as unknown — validatePlanSteps must accept it.
 *
 * USAGE: node test/plan-skill-gates.test.js
 */

const { _sanitizeSkillPlan } = require('../src/nodes/planSkillsV2');
const { validatePlanSteps } = require('../../shared/skill-contracts.cjs');
const { generateSingleStep } = require('../src/utils/singleStepPlanner');

let total = 0, passed = 0, failed = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — ${detail}`); }
}

const quietState = { logger: { info() {}, warn() {}, error() {}, debug() {} } };

// ── 1. Dispatchable-skill gate ───────────────────────────────────────────────
{
  const plan = _sanitizeSkillPlan([
    { skill: 'evaluate_skills', args: {}, description: 'phantom step' },
    { skill: 'synthesize', args: { prompt: 'done' }, description: 'report' },
  ], quietState);
  const phantom = plan.find(s => s.skill === 'evaluate_skills');
  check('evaluate_skills step is marked skipped', phantom && phantom.skipped === true);
  check('skip reason is honest', phantom && /not dispatchable/i.test(phantom.skipReason || ''), phantom?.skipReason);
  check('synthesize survives untouched', plan.some(s => s.skill === 'synthesize' && !s.skipped));
}
{
  // graph-internal pseudo-skills (ask_user, schedule) are handled by
  // executeCommand directly — never dispatched — the gate must not flag them
  const plan = _sanitizeSkillPlan([
    { skill: 'ask_user', args: { question: 'which?' }, description: 'clarify' },
    { skill: 'schedule', args: { time: '08:00' }, description: 'wait' },
  ], quietState);
  check('ask_user pseudo-skill not flagged', !plan[0].skipped);
  check('schedule pseudo-skill not flagged', !plan[1].skipped);
}

// ── 2. generateSingleStep — non-dispatchable emit → full replan ──────────────
(async () => {
  const stubBackend = {
    generateAnswer: async () => JSON.stringify({ skill: 'evaluate_skills', args: {}, description: 'x' }),
  };
  const out = await generateSingleStep({
    failedStep: { skill: 'app.agent', error: 'task or (filePath + prompt) is required' },
    failedSkill: 'app.agent',
    failedArgs: { action: 'run_agent', appName: 'Reminders' },
    suggestion: 'fix args',
    userMessage: 'add the dentist appointment',
    llmBackend: stubBackend,
  });
  check('non-dispatchable emitted skill → _needsFullReplan', out?._needsFullReplan === true && out?._invalidSkill === 'evaluate_skills', JSON.stringify(out));

  // A dispatchable emit still passes through
  const okBackend = { generateAnswer: async () => JSON.stringify({ skill: 'shell.run', args: { goal: 'list reminders' }, description: 'probe' }) };
  const out2 = await generateSingleStep({
    failedStep: { skill: 'app.agent', error: 'x' }, failedSkill: 'app.agent', failedArgs: {},
    userMessage: 'x', llmBackend: okBackend,
  });
  check('dispatchable emitted skill passes through', out2?.skill === 'shell.run', JSON.stringify(out2));

  // No-backend fallback with a non-dispatchable failedSkill → full replan
  const out3 = await generateSingleStep({ failedSkill: 'evaluate_skills', failedArgs: {}, userMessage: 'x' });
  check('non-dispatchable failedSkill fallback → _needsFullReplan', out3?._needsFullReplan === true, JSON.stringify(out3));
})().then(() => {

// ── 3. Browser-off read-back + stale-year URL repair ────────────────────────
  process.env.THINKDROP_BROWSER_AUTOMATION = 'off';
  const _yr = new Date().getFullYear();
  const pastUrl = `https://www.google.com/travel/flights?q=flights%20from%20JFK%20to%20HKG%20on%20${_yr - 1}-12-12%20returning%20${_yr}-01-01`;
  {
    // The URL rides in the message the way the real follow-up carried it
    // (prior web_search results put the flights URL in context) — otherwise
    // the invented-URL guard fires first, correctly, before year repair.
    const plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'open', argv: [pastUrl] }, description: 'Open Google Flights' },
      { skill: 'synthesize', args: { prompt: 'report' }, description: 'report' },
    ], { ...quietState, message: `show me the flight or take me to the site ${pastUrl}`, resolvedMessage: `show me the flight or take me to the site ${pastUrl}` });
    const openStep = plan.find(s => s.skill === 'shell.run');
    const urlText = JSON.stringify(openStep?.args?.argv || []);
    check('past-year in open URL rewritten to current year', !urlText.includes(`${_yr - 1}-12-12`) && urlText.includes(`${_yr}-12-12`), urlText);
    check('current-year return date untouched', urlText.includes(`${_yr}-01-01`), urlText);
    const scanIdx = plan.findIndex(s => s.skill === 'app.agent' && s.args?.action === 'scan_page');
    const openIdx = plan.findIndex(s => s.skill === 'shell.run');
    check('scan_page appended right after shell.run open', scanIdx === openIdx + 1, `scan@${scanIdx} open@${openIdx}`);
  }
  {
    // user typed the past year themselves → intent, not invention
    const userUrl = `https://example.com/fares?dep=${_yr - 1}-12-12`;
    const plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'open', argv: [userUrl] }, description: 'open' },
    ], { ...quietState, message: `open my ${_yr - 1} fare history ${userUrl}`, resolvedMessage: `open my ${_yr - 1} fare history ${userUrl}` });
    const step = plan.find(s => s.skill === 'shell.run');
    check('user-mentioned past year preserved', JSON.stringify(step?.args?.argv || []).includes(`${_yr - 1}-12-12`), JSON.stringify(step?.args?.argv));
  }
  {
    // open <file> (no URL) → no scan_page appended
    const plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'open', argv: ['/tmp/notes.txt'] }, description: 'open file' },
      { skill: 'synthesize', args: { prompt: 'x' }, description: 'x' },
    ], quietState);
    check('open <file> gets no scan_page', !plan.some(s => s.skill === 'app.agent' && s.args?.action === 'scan_page'));
  }
  {
    // existing read step after open → no duplicate scan_page
    const plan = _sanitizeSkillPlan([
      { skill: 'shell.run', args: { cmd: 'open', argv: ['https://example.com/page'] }, description: 'open' },
      { skill: 'app.agent', args: { action: 'scan_page', preferOs: true }, description: 'read page' },
      { skill: 'synthesize', args: { prompt: 'x' }, description: 'x' },
    ], { ...quietState, message: 'open https://example.com/page', resolvedMessage: 'open https://example.com/page' });
    const scans = plan.filter(s => s.skill === 'app.agent' && s.args?.action === 'scan_page');
    check('no duplicate scan_page when one already follows', scans.length === 1, `${scans.length} scans`);
  }

// ── 4. app.agent contract — run_agent takes `task` ──────────────────────────
  {
    const v = validatePlanSteps([{ skill: 'app.agent', args: { action: 'run_agent', appName: 'Notes', task: 'open x and edit' } }]);
    const taskViolation = v.violations.find(x => x.field === 'task' && /unknown arg/.test(x.msg));
    check('run_agent {task} no longer an unknown-arg violation', !taskViolation, JSON.stringify(v.violations));
  }
  {
    const v = validatePlanSteps([{ skill: 'app.agent', args: { action: 'check_installed', appName: 'Reminders' } }]);
    check('check_installed is a valid contract step', !v.violations.some(x => /unknown skill/.test(x.msg)), JSON.stringify(v.violations));
  }

  console.log(`\n${passed}/${total} passed`);
  process.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });

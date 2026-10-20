'use strict';

// Tests for the form-fill feature: field mapping, no-submit policy,
// live-page routing patterns, user.agent result extraction, and the
// {{user.agent.resolved.*}} placeholder whitelist.

const path = require('path');
const { labelToKey, widgetKind, valueNormalize, isFillableEntry, isRequiredEntry } = require(
  path.resolve(__dirname, '../../mcp-services/command-service/src/skills/lib/browserCore/formFields.cjs')
);
const {
  _noSubmitGoalRe, _broadSubmitLabels, _goalCompletionRejectReason, _submitLabels,
} = require(
  path.resolve(__dirname, '../../mcp-services/command-service/src/skills/lib/browserCore/tabMap.cjs')
);
const { LIVE_PAGE_REF_RE, SCREEN_OBSERVATION_RE } = require(
  path.resolve(__dirname, '../../shared/text-patterns.cjs')
);
const { extractUserAgentResult } = require(
  path.resolve(__dirname, '../../shared/skill-contract.cjs')
);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

console.log('\n--- labelToKey (deterministic field mapping) ---');
check('"First Name" → first_name', labelToKey('First Name') === 'first_name');
check('"first_name" → first_name', labelToKey('first_name') === 'first_name');
check('"Last Name" → last_name', labelToKey('Last Name') === 'last_name');
check('"Email Address" → email', labelToKey('Email Address') === 'email');
check('"Your email" → email', labelToKey('Your email') === 'email');
check('"Phone Number" → phone', labelToKey('Phone Number') === 'phone');
check('"Company" → company', labelToKey('Company') === 'company');
check('"Company Name" → company', labelToKey('Company Name') === 'company');
check('"Street Address" → address', labelToKey('Street Address') === 'address');
check('"City" → city', labelToKey('City') === 'city');
check('"ZIP Code" → zip', labelToKey('ZIP Code') === 'zip');
check('"Message" → message', labelToKey('Message') === 'message');
check('"Tell us about your project" → message', labelToKey('Tell us about your project') === 'message');
check('"Full Name" → full_name (longer kw beats name)', labelToKey('Full Name') === 'full_name');
check('"Username" → NOT full_name (word boundary)', labelToKey('Username') !== 'full_name');
check('"Last four digits of card" → NOT last_name', labelToKey('Last four digits of card') !== 'last_name');
check('"Statement date" → NOT state', labelToKey('Statement date') !== 'state');
check('"Rider number" → null (unmatched → LLM path)', labelToKey('Rider number') === null);

console.log('\n--- widgetKind / isFillableEntry ---');
check('input text → text', widgetKind({ tag: 'input', type: 'text' }) === 'text');
check('input email → text', widgetKind({ tag: 'input', type: 'email' }) === 'text');
check('select → select', widgetKind({ tag: 'select' }) === 'select');
check('checkbox → checkbox', widgetKind({ tag: 'input', type: 'checkbox' }) === 'checkbox');
check('radio → radio', widgetKind({ tag: 'input', type: 'radio' }) === 'radio');
check('date → date', widgetKind({ tag: 'input', type: 'date' }) === 'date');
check('combobox role → combobox', widgetKind({ tag: 'div', role: 'combobox' }) === 'combobox');
check('contenteditable → combobox', widgetKind({ tag: 'div', isContentEditable: true }) === 'combobox');
check('submit input NOT fillable', !isFillableEntry({ tag: 'input', type: 'submit' }));
check('hidden input NOT fillable', !isFillableEntry({ tag: 'input', type: 'hidden' }));
check('button NOT fillable', !isFillableEntry({ tag: 'button' }));
check('anchor NOT fillable', !isFillableEntry({ tag: 'a' }));
check('text input IS fillable', isFillableEntry({ tag: 'input', type: 'text' }));
check('contenteditable IS fillable', isFillableEntry({ tag: 'div', isContentEditable: true }));

console.log('\n--- widgetKind v2 (dropdown/picker/masked/chip/number) ---');
check('antd select input → dropdown', widgetKind({ tag: 'input', type: 'search', role: 'combobox', isDropdown: true }) === 'dropdown');
check('aria-haspopup listbox → dropdown', widgetKind({ tag: 'input', type: 'text', isDropdown: true }) === 'dropdown');
check('ant-picker → date', widgetKind({ tag: 'input', type: 'text', isPicker: true }) === 'date');
check('native date → date', widgetKind({ tag: 'input', type: 'date' }) === 'date');
check('masked phone → masked', widgetKind({ tag: 'input', type: 'text', mask: 'xxx-xxx-xxxx' }) === 'masked');
check('pattern input → masked', widgetKind({ tag: 'input', type: 'text', pattern: '[0-9]{3}' }) === 'masked');
check('inputmode numeric → number', widgetKind({ tag: 'input', type: 'text', inputmode: 'numeric' }) === 'number');
check('type=number → number', widgetKind({ tag: 'input', type: 'number' }) === 'number');
check('chip container → chip', widgetKind({ tag: 'input', type: 'text', isChip: true }) === 'chip');
check('plain text stays text', widgetKind({ tag: 'input', type: 'text' }) === 'text');

console.log('\n--- valueNormalize ---');
check('masked phone digits-match', valueNormalize('5550134', 'masked') === valueNormalize('555-0134', 'masked'));
check('number strips formatting', valueNormalize('$1,234.50', 'number') === '1234.50');
check('date keeps separators', valueNormalize('10/15/1990', 'date') === '10/15/1990');
check('text passthrough', valueNormalize('  Hello World ', 'text') === 'Hello World');

console.log('\n--- form.fill.agent stdout extractor ---');
{
  const { canonicalizeSkillResult } = require('../../shared/skill-contract.cjs');
  const c = canonicalizeSkillResult('form.fill.agent', {
    ok: true, status: 'partial',
    filledFields: [{ key: 'email', label: 'email', value: 'kai' }],
    validationIssues: [{ key: 'email', label: 'Email Address', messages: ['Not a valid email address'], current: 'kai' }],
    missingFields: [{ key: 'dob', label: 'birthday', required: true }],
  });
  const s = JSON.parse(c.stdout);
  check('stdout carries status', s.status === 'partial');
  check('stdout carries validation message', s.validationIssues[0].message === 'Not a valid email address');
  check('stdout carries missing', s.missing[0].field === 'birthday');
  check('ok:true preserved for partial', c.ok === true);
}

console.log('\n--- no-submit goal detection ---');
check('"fill this form but don\'t submit it"', _noSubmitGoalRe.test("fill out this form on my screen but don't submit it"));
check('"do not submit"', _noSubmitGoalRe.test('fill the form and do not submit'));
check('"without submitting"', _noSubmitGoalRe.test('fill the form without submitting it'));
check('"fill only"', _noSubmitGoalRe.test('fill only the required fields'));
check('"leave it ready"', _noSubmitGoalRe.test('fill the form and leave it ready'));
check('"fill and submit" NOT detected', !_noSubmitGoalRe.test('fill the form and submit it'));
check('"send the email" NOT detected', !_noSubmitGoalRe.test('compose and send the email'));

console.log('\n--- _goalCompletionRejectReason — negated submit goals ---');
(async () => {
  // A no-submit goal must NOT be rejected for lacking a submit action
  const r1 = await _goalCompletionRejectReason("fill out this form but don't submit it", [], null);
  check('no-submit goal + no submit action → done allowed', r1 === null, `got: ${r1}`);
  // A real submit goal with no submit action still rejects
  const r2 = await _goalCompletionRejectReason('fill the form and submit it', ['Type "x" into "Name" → ok'], null);
  check('submit goal + no submit action → rejected', typeof r2 === 'string' && /submit/i.test(r2), `got: ${r2}`);

  console.log('\n--- broad submit labels (hard gate) ---');
  check('"Submit" is submit-class', _broadSubmitLabels.test('Submit'));
  check('"Place Order" is submit-class', _broadSubmitLabels.test('Place Order'));
  check('"Sign Up" is submit-class', _broadSubmitLabels.test('Sign Up'));
  check('"Continue" is submit-class', _broadSubmitLabels.test('Continue'));
  check('"Next" is submit-class', _broadSubmitLabels.test('Next'));
  check('"Subscribe" is submit-class', _broadSubmitLabels.test('Subscribe'));
  check('"Company Name" NOT submit-class', !_broadSubmitLabels.test('Company Name'));
  check('"Email" NOT submit-class', !_broadSubmitLabels.test('Email'));

  console.log('\n--- LIVE_PAGE_REF_RE (form on my screen) ---');
  check('"fill out this form on my screen"', LIVE_PAGE_REF_RE.test('I need you to fill out this form on my screen'));
  check('"the form"', LIVE_PAGE_REF_RE.test('fill out the form and leave it ready'));
  check('"this page"', LIVE_PAGE_REF_RE.test('what does this page say'));
  check('"form on my browser"', LIVE_PAGE_REF_RE.test('fill the form on my browser'));
  check('bare "on my screen" NOT live-page ref (screen observation stays)', !LIVE_PAGE_REF_RE.test("what's on my screen"));
  check('"what\'s on my screen" still screen observation', SCREEN_OBSERVATION_RE.test("what's on my screen") || !LIVE_PAGE_REF_RE.test("what's on my screen"));

  console.log('\n--- extractUserAgentResult ---');
  const raw = { ok: true, action: 'resolve_form', resolved: { email: 'a@b.c', first_name: 'Jo' }, missingFields: ['phone'], sources: ['user_profile'], summary: 'User context:\nemail: a@b.c' };
  const e1 = extractUserAgentResult(raw);
  check('direct shape → resolved preserved', e1.resolved.email === 'a@b.c' && e1.missingFields[0] === 'phone');
  const e2 = extractUserAgentResult({ data: { result: raw } });
  check('{data:{result}} envelope unwrapped', e2.resolved.first_name === 'Jo');
  const e3 = extractUserAgentResult({ stdout: JSON.stringify(raw) });
  check('JSON stdout unwrapped', e3.resolved.email === 'a@b.c');
  const e4 = extractUserAgentResult(null);
  check('null → empty shape', e4.resolved && Object.keys(e4.resolved).length === 0);

  console.log('\n--- _repairStepPlaceholders: {{user.agent.resolved.*}} whitelist ---');
  const { _repairStepPlaceholders } = require('../src/nodes/planSkillsV2.js');
  const logger2 = { info: () => {}, warn: () => {}, debug: () => {} };
  const plan1 = [
    { skill: 'user.agent', args: { action: 'resolve_form' }, description: 'resolve' },
    { skill: 'form.fill.agent', args: { task: 'fill email {{user.agent.resolved.email}}' }, description: 'fill' },
  ];
  const repaired1 = _repairStepPlaceholders(plan1, { logger: logger2 });
  check('user.agent.resolved.* preserved (no ask_user inserted)',
    repaired1.length === 2 && repaired1.every(s => s.skill !== 'ask_user'),
    repaired1.map(s => s.skill).join(','));
  check('token survives verbatim',
    repaired1[1].args.task.includes('{{user.agent.resolved.email}}'));

  const plan2 = [
    { skill: 'dom.act', args: { task: 'fill {{user.agent.resolved.email}}' }, description: 'fill' },
  ];
  const repaired2 = _repairStepPlaceholders(plan2, { logger: logger2 });
  check('orphan user.agent token (no producer) still inserts ask_user',
    repaired2.some(s => s.skill === 'ask_user'),
    repaired2.map(s => s.skill).join(','));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
})();

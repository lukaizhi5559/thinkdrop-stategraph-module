'use strict';

// Regression tests for the atomic-browser plan lint + LLM decision parser.
// Root cause being guarded: a prompt like "Create a Google Doc titled X. Then
// add a calendar event... and a spreadsheet..." produced a plan of three
// url.first.agent steps (navigation only) that was reported as success.

const { lintAtomicBrowserPlan, hasMutationResidue } = require('../src/utils/planHelpers');
const { parseNumberDecision } = require('../src/utils/parseLlmJson');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {} };
const skills = (plan) => plan.map(s => s.skill + (s.args?.action ? ':' + s.args.action : '') + (s.args?.mode ? ':' + s.args.mode : '')).join(' → ');

console.log('\n--- hasMutationResidue ---');
check('"titled \'Vacation Itinerary\'" is residue', hasMutationResidue("Create a new Google Doc titled 'Vacation Itinerary'"));
check('"with columns for item" is residue', hasMutationResidue("a spreadsheet named 'Trip Budget' with columns for item, estimated cost, and actual cost"));
check('"add a calendar event" is residue', hasMutationResidue("add a calendar event for July 15th called 'Flight to Denver'"));
check('"open gmail" is NOT residue', !hasMutationResidue('open gmail'));
check('"go to example.com" is NOT residue', !hasMutationResidue('go to https://example.com'));

console.log('\n--- mutation residue → dom.act spliced (the failing plan) ---');
let plan = [
  { skill: 'url.first.agent', args: { agentId: 'google.agent', task: "Create a new Google Doc titled 'Vacation Itinerary'" }, runGroup: 'g1', description: 'doc' },
  { skill: 'url.first.agent', args: { agentId: 'google.agent', task: "add a calendar event for July 15th called 'Flight to Denver'" }, runGroup: 'g1', description: 'cal' },
  { skill: 'url.first.agent', args: { agentId: 'google.agent', task: "a spreadsheet named 'Trip Budget' with columns for item, estimated cost, and actual cost" }, runGroup: 'g1', description: 'sheet' },
  { skill: 'synthesize', args: {}, description: 'confirm' },
];
let r = lintAtomicBrowserPlan(plan, logger, {});
check('3 dom.act spliced, one per nav step', skills(r.plan) === 'url.first.agent → dom.act → url.first.agent → dom.act → url.first.agent → dom.act → synthesize', skills(r.plan));
check('spliced dom.act inherits agentId/runGroup', r.plan[1].args.agentId === 'google.agent' && r.plan[1].runGroup === 'g1');
check('spliced dom.act carries the mutation task', /Trip Budget/.test(r.plan[5].args.task || r.plan[5].args.goal || ''));
check('navOnlyPlan is false after repair', r.navOnlyPlan === false);

console.log('\n--- pure navigation → app.agent navigate_url ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'gmail.agent', url: 'https://mail.google.com', task: 'open gmail' }, description: 'open gmail' },
], logger, {});
check('lone pure-nav url.first.agent becomes app.agent', skills(r.plan) === 'app.agent:navigate_url', skills(r.plan));
check('url preserved', r.plan[0].args.url === 'https://mail.google.com');
check('not nav-only (nav lane satisfied by app.agent)', r.navOnlyPlan === false);

console.log('\n--- turn.loop.agent act satisfies the lane; verify does not ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'amazon.agent', task: 'add an item to my cart' }, runGroup: 'g1' },
  { skill: 'turn.loop.agent', args: { agentId: 'amazon.agent', goal: 'add the item to cart', mode: 'act' }, runGroup: 'g1' },
  { skill: 'synthesize', args: {} },
], logger, {});
check('url.first + turn.loop act → unchanged', r.rewrites.length === 0 && skills(r.plan).startsWith('url.first.agent → turn.loop.agent:act'), skills(r.plan));

r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'amazon.agent', task: 'add an item to my cart' }, runGroup: 'g1' },
  { skill: 'turn.loop.agent', args: { agentId: 'amazon.agent', goal: 'item is in cart', mode: 'verify' }, runGroup: 'g1' },
  { skill: 'synthesize', args: {} },
], logger, {});
check('verify-only does NOT satisfy → dom.act inserted before verify', skills(r.plan) === 'url.first.agent → dom.act → turn.loop.agent:verify → synthesize', skills(r.plan));

console.log('\n--- observe-only follow-ons do not satisfy the lane ---');
for (const obs of ['tab.map.agent', 'meta.find.agent']) {
  r = lintAtomicBrowserPlan([
    { skill: 'url.first.agent', args: { agentId: 'x.agent', task: 'create a doc titled Q' }, runGroup: 'g1' },
    { skill: obs, args: { agentId: 'x.agent' }, runGroup: 'g1' },
    { skill: 'synthesize', args: {} },
  ], logger, {});
  check(`${obs} after nav → dom.act inserted`, r.plan[1].skill === 'dom.act', skills(r.plan));
}

console.log('\n--- unresolved nav-only stays flagged ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'x.agent', task: 'open the dashboard' } },
], logger, {});
check('no url → kept as url.first.agent and flagged', r.plan[0].skill === 'url.first.agent' && r.navOnlyPlan === true, skills(r.plan));

console.log('\n--- same-host url.first under no departure → bound-tab select ---');
// The LinkedIn incident: the Sharmila messaging thread was bound, the prompt
// never said "this page", and a linkedin url.first moved the real tab to /feed.
const _liCtx = {
  prompt: "in write a message come with a response to Sharmila but don't submit",
  extConnected: true,
  extSessions: [{ sessionId: 'ext:linkedin_agent', url: 'https://www.linkedin.com/messaging/thread/sharmila', title: 'LinkedIn Messaging', lastSeen: 1 }],
  boundSession: 'ext:linkedin_agent',
  boundUrl: 'https://www.linkedin.com/messaging/thread/sharmila',
};
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'linkedin.agent', task: 'open linkedin messages' }, description: 'nav to linkedin' },
  { skill: 'dom.act', args: { agentId: 'linkedin.agent', task: 'type the reply into the Write a message field' }, description: 'type reply' },
  { skill: 'synthesize', args: {} },
], logger, _liCtx);
check('same-host url.first → browser.act:tab-select', skills(r.plan).startsWith('browser.act:tab-select'), skills(r.plan));
check('tab-select carries the bound session', r.plan[0].args.sessionId === 'ext:linkedin_agent');
check('dom.act follower stamped with bound session', r.plan[1].args.sessionId === 'ext:linkedin_agent');

console.log('\n--- departure keeps url.first ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'linkedin.agent', task: 'open linkedin' }, description: 'go to linkedin' },
  { skill: 'synthesize', args: {} },
], logger, { ..._liCtx, prompt: 'go to linkedin' });
check('"go to" prompt keeps url.first', r.plan[0].skill === 'url.first.agent', skills(r.plan));

console.log('\n--- different-service url.first untouched ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'gmail.agent', task: 'open gmail' }, description: 'open gmail' },
  { skill: 'synthesize', args: {} },
], logger, _liCtx);
check('foreign-service url.first not rewritten to tab-select', r.plan[0].skill !== 'browser.act', skills(r.plan));

console.log('\n--- no-submit prompt drops pure-submit steps ---');
r = lintAtomicBrowserPlan([
  { skill: 'form.fill.agent', args: { task: 'write the reply into the message box' }, description: 'fill message' },
  { skill: 'dom.act', args: { task: 'click the Send button' }, description: 'send it' },
  { skill: 'synthesize', args: {} },
], logger, { ..._liCtx, prompt: "write a reply to Sharmila but don't submit" });
check('pure "click Send" step dropped under don\'t-submit', !r.plan.some(s => /send button/i.test(s.args?.task || '')), skills(r.plan));
check('the fill step is kept', r.plan.some(s => s.skill === 'form.fill.agent'));

r = lintAtomicBrowserPlan([
  { skill: 'dom.act', args: { task: 'type the reply then click send' }, description: 'type and send' },
], logger, { prompt: "write a reply but don't send", extConnected: false });
check('mixed type+send step kept (skill-layer guard owns the send)', r.plan.length === 1 && r.plan[0].skill === 'dom.act');

console.log('\n--- web step on the bound host → bound-tab read ---');
r = lintAtomicBrowserPlan([
  { skill: 'web.crawl', args: { url: 'https://www.linkedin.com/messaging/thread/sharmila' }, description: 'crawl thread' },
  { skill: 'synthesize', args: {} },
], logger, _liCtx);
check('web.crawl same-host → browser.act:getPageText', skills(r.plan).startsWith('browser.act:getPageText'), skills(r.plan));
check('the read carries the bound session', r.plan[0].args.sessionId === 'ext:linkedin_agent');

console.log('\n--- bare history nav collapses to browser.act:back (the Amazon bug) ---');
// "go back for me on this page" used to match the named-destination go-back
// rule via step text like "go back to the previous page" → tab-select on a
// dead session → resolveTab minted a fresh Amazon tab. Bare history must be
// history.back() on the on-screen tab, never a tab select.
const _amznCtx = {
  prompt: 'go back for me on this page',
  extConnected: true,
  extSessions: [{ sessionId: 'ext:amazon_agent', url: 'https://www.amazon.com/dp/B0XXXX', title: 'Amazon product', lastSeen: 1 }],
  boundSession: 'ext:amazon_agent',
  boundUrl: 'https://www.amazon.com/dp/B0XXXX',
};
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'amazon.agent', task: 'go back to the previous page' }, description: 'navigate back' },
  { skill: 'turn.loop.agent', args: { agentId: 'amazon.agent', goal: 'previous page is displayed', mode: 'act' } },
  { skill: 'synthesize', args: {} },
], logger, _amznCtx);
check('bare "go back" collapses to a single browser.act:back', skills(r.plan) === 'browser.act:back', skills(r.plan));
check('…on the bound session (no minting)', r.plan[0].args.sessionId === 'ext:amazon_agent');
check('history rewrite logged', r.rewrites.some(w => /history-nav/.test(w.kind)));

r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'amazon.agent', task: 'go back to the previous page' }, description: 'back' },
], logger, { ..._amznCtx, prompt: 'go back to the previous page' });
check('"go back to the previous page" is history, not a destination', skills(r.plan) === 'browser.act:back', skills(r.plan));

r = lintAtomicBrowserPlan([
  { skill: 'browser.act', args: { action: 'navigate', url: 'https://x.com' }, description: 'nav' },
], logger, { ..._amznCtx, prompt: 'reload this page' });
check('"reload this page" → browser.act:reload', skills(r.plan) === 'browser.act:reload', skills(r.plan));

console.log('\n--- named-destination "go back to my X tab" still tab-selects ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'ebay.agent', task: 'open ebay' }, description: 'nav ebay' },
], logger, {
  prompt: 'go back to my ebay tab',
  extConnected: true,
  extSessions: [{ sessionId: 'ext:ebay_agent', url: 'https://www.ebay.com/myb', title: 'eBay', lastSeen: 1 }],
});
check('"go back to my ebay tab" → tab-select', skills(r.plan) === 'browser.act:tab-select', skills(r.plan));
check('…bound ebay session', r.plan[0].args.sessionId === 'ext:ebay_agent');

console.log('\n--- parseNumberDecision: the "115" bug ---');
check('decision "1" + "July 15th" prose → 1 (was 115)', parseNumberDecision('1\n\nThe calendar event on July 15th is missing a time.') === 1);
check('bare "2" → 2', parseNumberDecision('2') === 2);
check('prose with one digit → that digit', parseNumberDecision('I pick option 3 because reasons') === 3);
check('empty → NaN', Number.isNaN(parseNumberDecision('')));
check('no digit → NaN', Number.isNaN(parseNumberDecision('cannot decide')));

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
process.exit(failed ? 1 : 0);

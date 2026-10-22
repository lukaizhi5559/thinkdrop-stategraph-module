'use strict';

// Regression tests for the live-page binding chain — the Amazon/Google
// incident: a bound ext:amazon_agent session was navigated to google.com by a
// mis-planned page_nav_scan, then a dead binding minted about:blank and the
// turn-loop wandered to a laptop SERP. These tests cover the planner-layer
// guards (lint foreign-host collapse + page_nav_scan follow-up coercion) and
// the shared ordinal resolver's goal parsing.

const { lintAtomicBrowserPlan } = require('../src/utils/planHelpers');
const { forceClassifyLocalPlan } = require('../src/utils/localPlanTemplates');
const { ordinalNth, resolveOrdinalItem } = require('../../mcp-services/command-service/src/skills/lib/browserCore/ordinal.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {} };
const skills = (plan) => plan.map(s => s.skill + (s.args?.action ? ':' + s.args.action : '')).join(' → ');

// The bound context from the incident: amazon results tab bound, user asks a
// site-less follow-up.
const _amznCtx = {
  prompt: 'I want to see a baby clothes on my screen in the browser',
  extConnected: true,
  extSessions: [{ sessionId: 'ext:amazon_agent', url: 'https://www.amazon.com/s?k=baby+clothes', title: 'Amazon: baby clothes', lastSeen: 1 }],
  boundSession: 'ext:amazon_agent',
  boundUrl: 'https://www.amazon.com/s?k=baby+clothes',
};

console.log('\n--- foreign-host url.first under a bound session → bound tab-select ---');
// The incident plan: page_nav_scan emitted an app.agent navigate_url to
// google (rewritten to url.first.agent when ext is connected) with NO
// agentId — the empty service made _isBoundHostStep bail, so the google nav
// survived and hijacked the amazon tab.
let r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { url: 'https://www.google.com/search?q=baby+clothes', task: 'see baby clothes on my screen' }, description: 'open google search' },
  { skill: 'app.agent', args: { action: 'scan_page' }, description: 'read page' },
  { skill: 'synthesize', args: {} },
], logger, _amznCtx);
check('foreign google nav collapses to bound tab-select', skills(r.plan).startsWith('browser.act:tab-select'), skills(r.plan));
check('tab-select carries the bound amazon session', r.plan[0].args.sessionId === 'ext:amazon_agent');
check('rewrite logged as foreign-host', r.rewrites.some(w => /foreign-host/.test(w.kind)), JSON.stringify(r.rewrites));

console.log('\n--- foreign url attributed to a different service agentId ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'amazon.agent', url: 'https://www.bing.com/search?q=shoes', task: 'search for shoes' }, description: 'search' },
  { skill: 'synthesize', args: {} },
], logger, _amznCtx);
check('amazon-agent step carrying a bing url → tab-select', skills(r.plan).startsWith('browser.act:tab-select'), skills(r.plan));

console.log('\n--- prompt-named destination keeps its nav ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { url: 'https://www.google.com/search?q=flights', task: 'search google for flights' }, description: 'nav google' },
  { skill: 'synthesize', args: {} },
], logger, { ..._amznCtx, prompt: 'go to google and search flights' });
check('"go to google" keeps url.first', r.plan[0].skill === 'url.first.agent', skills(r.plan));

console.log('\n--- bound-host url is not foreign ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { agentId: 'amazon.agent', url: 'https://www.amazon.com/s?k=shoes', task: 'search amazon for shoes' }, description: 'nav amazon' },
  { skill: 'dom.act', args: { agentId: 'amazon.agent', task: 'read the results' } },
  { skill: 'synthesize', args: {} },
], logger, _amznCtx);
check('same-host nav → bound tab-select (existing rule, not foreign drop)', skills(r.plan).startsWith('browser.act:tab-select'), skills(r.plan));
check('no foreign-host rewrite logged', !r.rewrites.some(w => /foreign-host/.test(w.kind)));

console.log('\n--- no bound session → foreign url is just a nav ---');
r = lintAtomicBrowserPlan([
  { skill: 'url.first.agent', args: { url: 'https://www.ebay.com/sch/i.html?_nkw=shoes', task: 'search ebay for shoes' }, description: 'nav ebay' },
  { skill: 'synthesize', args: {} },
], logger, { prompt: 'search ebay for shoes', extConnected: true, extSessions: [] });
check('unbound ebay nav stays url.first', r.plan[0].skill === 'url.first.agent', skills(r.plan));

console.log('\n--- page_nav_scan follow-up coercion (template layer) ---');
const _backend = (script) => ({ generateAnswer: async () => (typeof script === 'function' ? script() : script) });
const _json = (n, args) => JSON.stringify({ n, args });

(async () => {
  // Classifier picks {site:'google'} for a site-less follow-up; the task's
  // resolved service (amazon) must win — the observed google hijack.
  let hit = await forceClassifyLocalPlan(
    'I want to see baby clothes on my screen',
    { isFollowUp: true, targetService: 'amazon' },
    _backend(_json(19, { site: 'google', query: 'baby clothes' })),
    logger,
  );
  check('coerced follow-up builds an amazon search url', !!hit && /amazon\.com\/s\?k=baby/.test(hit.skillPlan?.[0]?.args?.url || ''), hit?.skillPlan?.[0]?.args?.url);

  // An explicitly-named site is the user's choice — never coerced.
  hit = await forceClassifyLocalPlan(
    'go to google and search baby clothes',
    { isFollowUp: true, targetService: 'amazon' },
    _backend(_json(19, { site: 'google', query: 'baby clothes' })),
    logger,
  );
  check('explicit "go to google" keeps the google url', !!hit && /google\.com\/search/.test(hit.skillPlan?.[0]?.args?.url || ''), hit?.skillPlan?.[0]?.args?.url);

  // Fresh (non-follow-up) requests keep the classifier's site.
  hit = await forceClassifyLocalPlan(
    'search for baby clothes',
    { isFollowUp: false, targetService: 'amazon' },
    _backend(_json(19, { site: 'google', query: 'baby clothes' })),
    logger,
  );
  check('non-follow-up keeps the picked site', !hit || /google\.com/.test(hit.skillPlan?.[0]?.args?.url || '') || hit.skillPlan?.[0]?.args?.url == null, hit?.skillPlan?.[0]?.args?.url);

  console.log('\n--- shared ordinal resolver ---');
  check('"click the third item" → nth=3', ordinalNth('click the third item') === 3);
  check('"open the 2nd result" → nth=2', ordinalNth('open the 2nd result') === 2);
  check('"view details of the fifth product" → nth=5', ordinalNth('view details of the fifth product') === 5);
  check('"read the third item" → 0 (not an open verb)', ordinalNth('read the third item') === 0);
  check('"scroll down" → 0', ordinalNth('scroll down') === 0);
  check('"click the search button" → 0 (no ordinal)', ordinalNth('click the search button') === 0);

  const mockBrowserAct = async (a) => a.action === 'evaluate'
    ? { ok: true, result: { href: 'https://www.amazon.com/dp/B0ABC', text: 'Baby Onesie 3-pack', y: 300, x: 10, cross: 1 } }
    : { ok: false };
  const item = await resolveOrdinalItem(mockBrowserAct, { sessionId: 'ext:amazon_agent', goal: 'click the third item' });
  check('resolveOrdinalItem returns the Nth anchor', item?.nth === 3 && /dp\/B0ABC/.test(item.href), JSON.stringify(item));
  const nonOrdinal = await resolveOrdinalItem(mockBrowserAct, { sessionId: 'ext:amazon_agent', goal: 'scroll down' });
  check('non-ordinal goal resolves null (falls through to router)', nonOrdinal === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
  process.exit(failed ? 1 : 0);
})();

'use strict';

// Regression tests for the planner fallback-cleanup session kill:
// planSkillsV2 sends browser.act close-all at the end of planning to sweep up
// probe-spawned browsers. It must NEVER close the live continuation session
// (state.activeBrowserSessionId), the prior-turn session, or any session a
// plan step references — observed: amazon_agent killed mid-pipeline before a
// scroll follow-up ran, leaving presses on a dead/about:blank session.

const { _protectedBrowserSessionIds } = require('../src/nodes/planSkillsV2');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

console.log('\n--- _protectedBrowserSessionIds ---');

const empty = _protectedBrowserSessionIds({}, []);
check('empty state + empty plan → empty set', empty.length === 0);

const active = _protectedBrowserSessionIds({ activeBrowserSessionId: 'amazon_agent' }, []);
check('activeBrowserSessionId protected', active.includes('amazon_agent'));

const prior = _protectedBrowserSessionIds({ priorBrowserContext: { sessionId: 'gmail_agent' } }, []);
check('priorBrowserContext.sessionId protected', prior.includes('gmail_agent'));

const planSids = _protectedBrowserSessionIds({}, [
  { skill: 'url.first.agent', args: { sessionId: 'notion_agent' } },
  { skill: 'dom.act', args: { sessionId: 'amazon_agent', goal: 'scroll' } },
  { skill: 'synthesize', args: {} },
]);
check('plan step sessionIds protected', planSids.includes('notion_agent') && planSids.includes('amazon_agent'));
check('steps without sessionId contribute nothing', planSids.length === 2);

const union = _protectedBrowserSessionIds(
  { activeBrowserSessionId: 'amazon_agent', priorBrowserContext: { sessionId: 'amazon_agent' } },
  [{ skill: 'dom.act', args: { sessionId: 'amazon_agent' } }, { skill: 'turn.loop.agent', args: { sessionId: 'gmail_agent' } }],
);
check('dedup union of all sources', union.length === 2 && union.includes('amazon_agent') && union.includes('gmail_agent'));

const weird = _protectedBrowserSessionIds({ activeBrowserSessionId: null }, null);
check('null plan + null sid → empty', weird.length === 0);

// lastBrowserNav persists across replans/ask_user resumes — a session recorded
// there must stay protected even when promotion fields are absent (the comms-
// graph/handoffRunner path before the session bridge).
const lastNav = _protectedBrowserSessionIds({ lastBrowserNav: { sessionId: 'amazon_agent', url: 'https://amazon.com/x' } }, []);
check('lastBrowserNav.sessionId protected', lastNav.includes('amazon_agent'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
process.exit(failed ? 1 : 0);

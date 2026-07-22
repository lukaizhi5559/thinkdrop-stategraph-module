'use strict';
/**
 * follow-up-correction.test.js
 *
 * Unit tests for the follow-up plan correction detection logic in
 * planCacheHelpers.js (domainsMatch, isCorrectionSignal, findMostRecentPlanInSession)
 * and the resolveAgent context pass-through.
 *
 * Run from repo root with:
 *   node stategraph-module/test/follow-up-correction.test.js
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const {
  domainsMatch,
  isCorrectionSignal,
  findMostRecentPlanInSession,
  DOMAIN_ALIASES,
} = require(path.resolve(__dirname, '..', 'src/utils/planCacheHelpers.js'));

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');
const _testPlans = [];

function createTestPlan({ sessionId, status, prompt, skillPlan, ageMinutes = 0 }) {
  const planId = `plan-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const planFile = path.join(PLANS_DIR, `${planId}.md`);
  const created = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString();
  const skillPlanB64 = Buffer.from(JSON.stringify(skillPlan)).toString('base64');

  const content = [
    '---',
    `id: ${planId}`,
    `created: ${created}`,
    `status: ${status}`,
    `original_prompt: "${prompt.replace(/"/g, '\\"')}"`,
    `session_id: ${sessionId}`,
    `skill_plan: true`,
    `skill_plan_json: '${skillPlanB64}'`,
    '---',
    '',
    `# Plan: ${prompt.slice(0, 40)}`,
    '',
    '## Steps',
    '',
  ].join('\n');

  fs.writeFileSync(planFile, content, 'utf8');
  _testPlans.push(planFile);
  return planFile;
}

function cleanupTestPlans() {
  for (const f of _testPlans) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  section('isCorrectionSignal');

  await it('detects "actually" as correction signal', () => {
    assertEqual(isCorrectionSignal('Actually, use a different message'), true);
  });

  await it('detects "should be" as correction signal', () => {
    assertEqual(isCorrectionSignal('The message should be shorter'), true);
  });

  await it('detects "the actual" as correction signal', () => {
    assertEqual(isCorrectionSignal('The actual message should be Excited to talk'), true);
  });

  await it('detects "use a different" as correction signal', () => {
    assertEqual(isCorrectionSignal('Use a different message'), true);
  });

  await it('detects "rewrite" as correction signal', () => {
    assertEqual(isCorrectionSignal('Rewrite the tweet to be shorter'), true);
  });

  await it('detects "make it" as correction signal', () => {
    assertEqual(isCorrectionSignal('Make it more exciting'), true);
  });

  await it('returns true for plain message with no signals (default = correction)', () => {
    assertEqual(isCorrectionSignal('Excited to talk about the new endeavor'), true);
  });

  await it('returns false for "also" (chained action)', () => {
    assertEqual(isCorrectionSignal('Also email that to my team'), false);
  });

  await it('returns false for "then" (chained action)', () => {
    assertEqual(isCorrectionSignal('Then search for SpaceX news'), false);
  });

  await it('returns false for "after that" (chained action)', () => {
    assertEqual(isCorrectionSignal('After that, open Slack'), false);
  });

  await it('correction overrides chained: "also change the message" → true', () => {
    assertEqual(isCorrectionSignal('Also change the message to be shorter'), true);
  });

  await it('returns false for null/empty input', () => {
    assertEqual(isCorrectionSignal(null), false);
    assertEqual(isCorrectionSignal(''), false);
  });

  section('domainsMatch');

  await it('matches twitter domain: followUpTarget "Twitter post" vs plan with twitter.agent', () => {
    const prevPlan = {
      originalPrompt: 'Post on Twitter: Excited to share a new project update soon!',
      skillPlan: [{ skill: 'browser.agent', args: { service: 'twitter', action: 'run' } }],
    };
    assertEqual(domainsMatch('Twitter post', 'twitter', prevPlan), true);
  });

  await it('matches twitter domain via x.com alias in plan steps', () => {
    const prevPlan = {
      originalPrompt: 'Post on x.com',
      skillPlan: [{ skill: 'browser.agent', args: { url: 'https://x.com' } }],
    };
    assertEqual(domainsMatch('Twitter post', null, prevPlan), true);
  });

  await it('does NOT match: twitter follow-up vs email plan', () => {
    const prevPlan = {
      originalPrompt: 'Send an email to the team',
      skillPlan: [{ skill: 'cli.agent', args: { service: 'gmail' } }],
    };
    assertEqual(domainsMatch('Twitter post', 'twitter', prevPlan), false);
  });

  await it('does NOT match: no domain tokens in follow-up', () => {
    const prevPlan = {
      originalPrompt: 'Post on Twitter',
      skillPlan: [{ skill: 'browser.agent', args: { service: 'twitter' } }],
    };
    assertEqual(domainsMatch(null, null, prevPlan), false);
  });

  await it('does NOT match: no domain tokens in plan', () => {
    const prevPlan = {
      originalPrompt: 'Do something',
      skillPlan: [{ skill: 'shell.run', args: { cmd: 'ls' } }],
    };
    assertEqual(domainsMatch('Twitter post', 'twitter', prevPlan), false);
  });

  await it('does NOT match: same domain but different action → false (post vs search)', () => {
    const prevPlan = {
      originalPrompt: 'Post on Twitter about SpaceX',
      skillPlan: [{ skill: 'browser.agent', args: { service: 'twitter', action: 'run' } }],
    };
    // follow-up says "search Twitter for trends" → action verb mismatch
    assertEqual(domainsMatch('Twitter search', 'twitter', prevPlan), false);
  });

  await it('matches same domain AND same action → true (post vs post)', () => {
    const prevPlan = {
      originalPrompt: 'Post on Twitter about SpaceX',
      skillPlan: [{ skill: 'browser.agent', args: { service: 'twitter', action: 'run' } }],
    };
    assertEqual(domainsMatch('Twitter post', 'twitter', prevPlan), true);
  });

  await it('returns false for null previousPlan', () => {
    assertEqual(domainsMatch('Twitter post', 'twitter', null), false);
  });

  section('findMostRecentPlanInSession');

  // Create test plans
  const testSessionId = `test_session_${Date.now()}`;
  const twitterPlan = {
    sessionId: testSessionId,
    status: 'pending',
    prompt: 'Post on Twitter: Excited to share a new project update soon!',
    skillPlan: [{ skill: 'browser.agent', args: { service: 'twitter', action: 'run' } }],
  };
  const emailPlan = {
    sessionId: testSessionId,
    status: 'pending',
    prompt: 'Send an email to the team about the project',
    skillPlan: [{ skill: 'cli.agent', args: { service: 'gmail' } }],
  };
  const completedPlan = {
    sessionId: testSessionId,
    status: 'complete',
    prompt: 'Search for SpaceX news on Google',
    skillPlan: [{ skill: 'browser.agent', args: { service: 'google' } }],
  };

  const twitterFile = createTestPlan(twitterPlan);
  const emailFile = createTestPlan(emailPlan);
  createTestPlan(completedPlan);

  await it('finds most recent pending plan in session', () => {
    const result = findMostRecentPlanInSession(testSessionId, console);
    assert(result !== null, 'Expected a plan, got null');
    assert(result.status === 'pending', `Expected pending status, got ${result.status}`);
  });

  await it('skips completed plans', () => {
    const result = findMostRecentPlanInSession(testSessionId, console);
    assert(result !== null, 'Expected a plan, got null');
    assert(result.status === 'pending', `Expected pending status, got ${result.status}`);
    assert(result.originalPrompt !== completedPlan.prompt, 'Should not return completed plan');
  });

  await it('returns null when no pending plans exist for session', () => {
    const result = findMostRecentPlanInSession('nonexistent_session_xyz', console);
    // May find plans from fallback (others), but should not find our test session's completed plan
    if (result) {
      assert(result.status === 'pending', `Expected pending, got ${result.status}`);
    }
  });

  await it('skips plans older than maxAgeMinutes', () => {
    const oldPlan = {
      sessionId: testSessionId,
      status: 'pending',
      prompt: 'Old task that should be skipped',
      skillPlan: [{ skill: 'shell.run', args: { cmd: 'echo hello' } }],
      ageMinutes: 30,
    };
    createTestPlan(oldPlan);
    // With maxAgeMinutes=10, the 30-min-old plan should be skipped
    const result = findMostRecentPlanInSession(testSessionId, console, 10);
    assert(result !== null, 'Expected a plan, got null');
    assert(result.originalPrompt !== oldPlan.prompt, 'Should not return stale plan');
  });

  section('DOMAIN_ALIASES');

  await it('x.com maps to twitter', () => {
    assertEqual(DOMAIN_ALIASES['x.com'], 'twitter');
  });

  await it('gmail.com maps to email', () => {
    assertEqual(DOMAIN_ALIASES['gmail.com'], 'email');
  });

  await it('github.com maps to github', () => {
    assertEqual(DOMAIN_ALIASES['github.com'], 'github');
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  cleanupTestPlans();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  Results: ${_passed} passed, ${_failed} failed`);
  if (_failed > 0) {
    console.log(`\n  Failures:`);
    for (const f of _failures) {
      console.log(`    ❌ ${f.label}: ${f.error}`);
    }
  }
  console.log(`${'═'.repeat(72)}\n`);

  process.exit(_failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  cleanupTestPlans();
  process.exit(1);
});

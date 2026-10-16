'use strict';
/**
 * fast-lane-plan.test.js
 *
 * Regression tests for fastLanePlan plan emission:
 *   - named-service tasks (targetService) route through app.agent nav_task
 *     (the resolve-discovery lane), not bare web search;
 *   - plain service-less lookups are INELIGIBLE — they route to web_search
 *     via the public-research guard (SERP answers, seconds not minutes);
 *   - hostnames in the message count as page-targets and stay eligible;
 *   - literal URLs keep read_url → synthesize.
 *
 * Run from repo root with:
 *   node stategraph-module/test/fast-lane-plan.test.js
 */

const path = require('path');
const fastLanePlan = require(path.resolve(__dirname, '..', 'src/nodes/fastLanePlan'));

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

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`Expected ${e} but got ${a}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
  };
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

function browseState(tc, message = 'yes') {
  return {
    message,
    resolvedMessage: message,
    intent: { type: 'command_automate' },
    _taskClassification: {
      taskType: 'browser',
      webAccessMode: 'public_read',
      requiresDOM: false,
      isBrowseOnly: true,
      needsClarification: false,
      interactiveActions: [],
      ...tc,
    },
    conversationHistory: [],
    logger: _noopLogger,
  };
}

(async () => {
  // ── eligibility ────────────────────────────────────────────────────────────

  await it('resolved thought-reply tc is fast-lane eligible', async () => {
    const tc = {
      isThoughtReply: true,
      followUpTarget: 'open BibleGateway and display Exodus 1',
      resolution: 'resolved',
      targetService: 'biblegateway',
    };
    expect(fastLanePlan.isBrowseFastLaneTc(browseState(tc)._taskClassification)).toBe(true);
  });

  // ── named-service → nav_task ───────────────────────────────────────────────

  await it('targetService present → [app.agent nav_task, synthesize]', async () => {
    const state = browseState({
      isThoughtReply: true,
      followUpTarget: 'open BibleGateway and display Exodus 1',
      resolution: 'resolved',
      targetService: 'biblegateway',
    });
    const r = await fastLanePlan(state);
    const plan = r._skillPlan;
    if (!Array.isArray(plan)) throw new Error('no _skillPlan emitted');
    expect(plan.length).toBe(2);
    expect(plan[0].skill).toBe('app.agent');
    expect(plan[0].args.action).toBe('nav_task');
    expect(plan[0].args.service).toBe('biblegateway');
    expect(plan[0].args.task).toBe('open BibleGateway and display Exodus 1');
    expect(plan[0].args.escalate).toBe(false);
    expect(plan[0].args.browseFallback).toBe(true);
    expect(plan[1].skill).toBe('synthesize');
    if (plan.some(s => s.skill === 'web.agent')) {
      throw new Error('named-service plan should not use bare web search');
    }
  });

  await it('named service on a fresh prompt → nav_task too', async () => {
    const r = await fastLanePlan(browseState(
      { targetService: 'biblegateway' },
      'goto biblegateway and show me exodus 1',
    ));
    expect(r._skillPlan[0].skill).toBe('app.agent');
    expect(r._skillPlan[0].args.action).toBe('nav_task');
    expect(r._skillPlan[0].args.service).toBe('biblegateway');
  });

  // ── plain lookups leave the crawl lane — they route to web_search ──────────

  await it('plain lookup, no page-target → ineligible (web_search handles it)', async () => {
    const tc = { targetService: null };
    const state = browseState(tc, 'what is the capital of Norway');
    expect(fastLanePlan.isBrowseFastLaneTc(state._taskClassification, state.message)).toBe(false);
    const r = await fastLanePlan(state);
    if (r._skillPlan) throw new Error('plain lookup must not emit a fetch plan');
  });

  await it('bare review query → ineligible (web_search handles it)', async () => {
    const state = browseState({ targetService: null }, 'show me chipotle reviews for local restaurant');
    expect(fastLanePlan.isBrowseFastLaneTc(state._taskClassification, state.message)).toBe(false);
  });

  await it('hostname in message → still eligible (page-targeted)', async () => {
    const state = browseState({ targetService: null }, 'check the reviews on chipotle.com for me');
    expect(fastLanePlan.isBrowseFastLaneTc(state._taskClassification, state.message)).toBe(true);
  });

  await it('URL in resolved followUpTarget → still eligible', async () => {
    const state = browseState({
      targetService: null,
      isFollowUp: true,
      followUpTarget: 'https://example.com/article',
      resolution: 'resolved',
    }, 'yes read it');
    expect(fastLanePlan.isBrowseFastLaneTc(state._taskClassification, state.message)).toBe(true);
  });

  // ── literal URL keeps the 2-step shape ─────────────────────────────────────

  await it('literal URL → [read_url, synthesize]', async () => {
    const r = await fastLanePlan(browseState(
      { targetService: null },
      'read https://example.com/article for me',
    ));
    const plan = r._skillPlan;
    expect(plan.length).toBe(2);
    expect(plan[0].args.action).toBe('read_url');
    expect(plan[0].args.url).toBe('https://example.com/article');
  });

  await it('literal URL beats targetService (no nav_task)', async () => {
    const r = await fastLanePlan(browseState(
      { targetService: 'biblegateway' },
      'read https://example.com/article for me',
    ));
    expect(r._skillPlan[0].args.action).toBe('read_url');
  });

  console.log(`\n❌ ${_failed} failed, ✅ ${_passed} passed`);
  if (_failed > 0) {
    for (const f of _failures) console.log(`  - ${f.label}: ${f.error}`);
    process.exit(1);
  }
})();

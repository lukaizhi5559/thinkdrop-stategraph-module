'use strict';
/**
 * fast-lane-plan.test.js
 *
 * Regression tests for fastLanePlan plan emission:
 *   - named-service tasks (targetService) route through app.agent nav_task
 *     (the resolve-discovery lane), not bare web search;
 *   - service-less searches keep the web.agent → read_url → synthesize shape;
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

  // ── service-less search keeps the 3-step shape ─────────────────────────────

  await it('no targetService → [search_and_navigate, read_url, synthesize]', async () => {
    const r = await fastLanePlan(browseState({ targetService: null }, 'what is the capital of Norway'));
    const plan = r._skillPlan;
    expect(plan.length).toBe(3);
    expect(plan[0].skill).toBe('web.agent');
    expect(plan[0].args.action).toBe('search_and_navigate');
    expect(plan[0].args.preferDomain).toBe(undefined);
    expect(plan[1].skill).toBe('app.agent');
    expect(plan[1].args.action).toBe('read_url');
    expect(plan[2].skill).toBe('synthesize');
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

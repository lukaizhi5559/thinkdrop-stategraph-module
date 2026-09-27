'use strict';
/**
 * decompose-decision.test.js — regression coverage for the Stage-2 flakes:
 *
 *   1. Old parser `replace(/\D/g,'')` concatenated ALL digits: provider prose
 *      like "4 or maybe 5" became 45 → out of range → silent default to
 *      command_automate (the heaviest route: plan + approval + tool exec).
 *      New contract: bare digit trusted; single distinct digit in short text
 *      extracted; multi-digit/prose output is unparseable → retry → fallback.
 *
 *   2. A clean-but-wrong 0 on a non-action task (classifyTask says
 *      query/ambiguous, no targetService/interactiveActions) is a
 *      contradiction — escalate to the richer llmDecompose prompt instead of
 *      trusting the five-token verdict. Observed: "find me three ramen
 *      restaurants", "write a haiku", "summarize what I worked on recently".
 *
 *   3. carriedHint remains the fallback when retries are exhausted.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');

// Mock backend: script responses by maxTokens — 5 = number call, 400 = plan.
const _backend = (numberCall, planCall) => ({
  generateAnswer: async (prompt, opts, params) => {
    // The deterministic fast-path classify call is neither the number call
    // nor the plan call — discriminate on its prompt preamble so it never
    // counts as either.
    if (typeof prompt === 'string' && /Pick the single (local-automation )?template/.test(prompt)) return '{"n":0,"args":{}}';
    const mt = (params && params.maxTokens) || (opts && opts.maxTokens) || 0;
    if (mt <= 10) return typeof numberCall === 'function' ? numberCall() : numberCall;
    return typeof planCall === 'function' ? planCall() : planCall;
  },
});

const _plan = (intent) => JSON.stringify({
  subPrompts: [{ text: 'q', estimatedIntent: intent, order: 0, dependsOn: [] }],
});

const _decompose = (message, backend, tc, hint) => decomposePromptV2({
  message,
  conversationHistory: [],
  logger: _noopLogger,
  llmBackend: backend,
  _taskClassification: tc || {},
  ...(hint ? { _carriedHint: hint } : {}),
});

describe('_decomposeDecision — numeric parse contract', () => {
  it('clean single digit routes directly', async () => {
    const r = await _decompose('explain tcp vs udp', _backend('5'));
    assert.equal(r._decomposedIntent, 'general_knowledge');
  });

  it('single distinct digit in short prose is extracted', async () => {
    const r = await _decompose('bitcoin price', _backend('2'));
    assert.equal(r._decomposedIntent, 'web_search');
  });

  it('multi-digit prose "4 or maybe 5" is unparseable → falls back, never concatenates to 45', async () => {
    // Old bug: /\D/g strip → "45" → out of range → default 0 → command_automate.
    // New: unparseable → retry → carriedHint wins when valid.
    const r = await _decompose('what did I do yesterday', _backend('4 or maybe 5'), {}, 'memory_retrieve');
    assert.equal(r._decomposedIntent, 'memory_retrieve');
  });

  it('multi-digit "45" with no hint → unparseable, retried once, never parsed as an intent', async () => {
    // Old bug: /\D/g strip already produced "45"; the NEW bug would be treating
    // "45" as a bare match. Distinct digits {4,5} → unparseable → one retry →
    // no hint → declared fallback 0. tc={} keeps taskType unset so the
    // post-fallback contradiction guard stays out of the way.
    let calls = 0;
    const r = await _decompose('do the thing', _backend(() => { calls++; return '45'; }), {});
    assert.equal(calls, 2, 'unparseable must trigger exactly one retry');
    assert.equal(r._decomposedIntent, 'command_automate');
  });

  it('unparseable on attempt 1, clean digit on retry → retry wins', async () => {
    let calls = 0;
    const r = await _decompose('latest news', _backend(() => (++calls === 1 ? 'the intents are 0-7' : '2')));
    assert.equal(calls, 2);
    assert.equal(r._decomposedIntent, 'web_search');
  });

  it('both attempts unparseable + valid hint → hint wins over 0', async () => {
    const r = await _decompose("what's the latest on spacex", _backend('hmm the intents are 0 through 7'), {}, 'web_search');
    assert.equal(r._decomposedIntent, 'web_search');
  });
});

describe('_decomposeDecision — hint veto over residual 0', () => {
  it('clean 0 + non-automation hint → hint wins (ramen case)', async () => {
    const r = await _decompose('find me three highly rated ramen restaurants in San Francisco',
      _backend('0'), { taskType: 'ambiguous' }, 'web_search');
    assert.equal(r._decomposedIntent, 'web_search');
  });

  it('clean 0 + screen hint → screen_intelligence, never command_automate', async () => {
    const r = await _decompose('read the text visible on my screen',
      _backend('0'), { taskType: 'ambiguous' }, 'screen_analysis'); // comms vocab — normalized
    assert.equal(r._decomposedIntent, 'screen_intelligence');
  });

  it('specific non-zero choice is NOT vetoed by hint (model affirmatively disagreed)', async () => {
    const r = await _decompose('explain quantum computing',
      _backend('5'), { taskType: 'query' }, 'web_search');
    assert.equal(r._decomposedIntent, 'general_knowledge');
  });

  it('command_automate hint is never veto-target (hintIdx 0 has no veto power)', async () => {
    // taskType 'query' so the number call actually runs (action types
    // short-circuit earlier); a clean 2 stands over the automation hint.
    const r = await _decompose('do a thing',
      _backend('2'), { taskType: 'query' }, 'command_automate');
    assert.equal(r._decomposedIntent, 'web_search');
  });
});

describe('decomposePromptV2 — local short-circuit vs hint disagreement', () => {
  it('action taskType + disagreeing hint → short-circuit skipped, hint veto applies', async () => {
    // "find me three ramen restaurants" classified local_system — the label
    // alone must not force command_automate over a web_search hint.
    const r = await _decompose('find me three highly rated ramen restaurants in San Francisco',
      _backend('0'), { taskType: 'local_system' }, 'web_search');
    assert.equal(r._decomposedBy !== 'local-short-circuit', true);
    assert.equal(r._decomposedIntent, 'web_search');
  });

  it('action taskType + agreeing/null hint → short-circuit still fires', async () => {
    const r = await _decompose('move this file to the trash',
      _backend('5'), { taskType: 'local_system' });
    assert.equal(r._decomposedIntent, 'command_automate');
    assert.equal(r._decomposedBy, 'local-short-circuit');
  });

  it('action taskType + command_automate hint → short-circuit fires (signals agree)', async () => {
    const r = await _decompose('open slack and send a message',
      _backend('5'), { taskType: 'app_automation' }, 'command_automate');
    assert.equal(r._decomposedBy, 'local-short-circuit');
  });
});

describe('decomposePromptV2 — command_automate contradiction guard', () => {
  it('number-call 0 + taskType "query" → escalates to llmDecompose', async () => {
    let planCalls = 0;
    const r = await _decompose('summarize what I worked on recently',
      _backend('0', () => { planCalls++; return _plan('memory_retrieve'); }),
      { taskType: 'query', isActivityQuery: true });
    assert.equal(planCalls, 1, 'full decompose must run once');
    assert.equal(r._decomposedIntent, 'memory_retrieve');
  });

  it('number-call 0 + taskType "ambiguous" → also escalates', async () => {
    const r = await _decompose('find me three ramen restaurants in sf',
      _backend('0', _plan('web_search')),
      { taskType: 'ambiguous' });
    assert.equal(r._decomposedIntent, 'web_search');
  });

  it('action taskType "local_system" → deterministic local short-circuit (number call never runs)', async () => {
    let calls = 0;
    const r = await _decompose('move this file to the trash',
      _backend(() => { calls++; return '0'; }, _plan('general_knowledge')),
      { taskType: 'local_system' });
    assert.equal(calls, 0, 'local_system bypasses the number call entirely');
    assert.equal(r._decomposedIntent, 'command_automate');
    assert.equal(r._decomposedBy, 'local-short-circuit');
  });

  it('number-call 0 + action taskType "messaging" → trusted, no escalation', async () => {
    // messaging/scheduling aren't in _SINGLE_STEP_TASK_TYPES so they DO reach
    // the number call — a 0 there must be honored without escalation.
    let planCalls = 0;
    const r = await _decompose('send the reminder text to mom',
      _backend('0', () => { planCalls++; return _plan('general_knowledge'); }),
      { taskType: 'messaging' });
    assert.equal(planCalls, 0);
    assert.equal(r._decomposedIntent, 'command_automate');
  });

  it('number-call 0 + targetService present → trusted (named service implies action)', async () => {
    const r = await _decompose('post this on linkedin',
      _backend('0', _plan('general_knowledge')),
      { taskType: 'query', targetService: 'linkedin' });
    assert.equal(r._decomposedIntent, 'command_automate');
  });

  it('escalated llmDecompose throwing → null → state pass-through, not a crash', async () => {
    const r = await _decompose('write a haiku about debugging',
      _backend('0', () => { throw new Error('provider flap'); }),
      { taskType: 'query' });
    assert.equal(r._decomposedIntent, undefined, 'pass-through leaves state untouched');
    assert.equal(r.intentPlan, undefined);
  });
});

describe('_decomposeDecision — backend failure fallback', () => {
  it('both attempts throw + hint → hint', async () => {
    const r = await _decompose('screen check',
      _backend(() => { throw new Error('down'); }), {}, 'screen_intelligence');
    assert.equal(r._decomposedIntent, 'screen_intelligence');
  });

  it('both attempts throw + no hint → 0 (command_automate), taskType absent so no escalation', async () => {
    const r = await _decompose('do x', _backend(() => { throw new Error('down'); }), {});
    assert.equal(r._decomposedIntent, 'command_automate');
  });
});

describe('_decomposeDecision — capture vs display (Stage 5 regression)', () => {
  it('"take a screenshot of my screen" is NOT screen_display even when isScreenOutput flakes true', async () => {
    // Bug: screen-output-guard emitted [web_search, screen_display] which
    // hallucinated a captured screenshot. Capture is a local OS action.
    const r = await _decompose('take a screenshot of my screen',
      _backend('0', _plan('command_automate')),
      { taskType: 'local_system', isScreenOutput: true, screenOutputKind: 'image' });
    assert.notEqual(r._decomposedBy, 'screen-output-guard');
    assert.equal(r._decomposedIntent, 'command_automate');
  });

  it('real display prompts still route to screen_display', async () => {
    const r = await _decompose('show fireworks on my screen',
      _backend('0', _plan('web_search')),
      { taskType: 'query', isScreenOutput: true, screenOutputKind: 'effect' });
    assert.equal(r._decomposedBy, 'screen-output-guard');
    assert.equal(r._decomposedIntent, 'screen_display');
  });
});

describe('_decomposeDecision — public-research path exemption (Stage 5 regression)', () => {
  it('"search the web for X and save it to /tmp/y" does not collapse to single web_search', async () => {
    // Bug: public-research-guard swallowed the file-write half — plan was a
    // lone web_search and nothing got saved.
    const r = await _decompose('search the web for the current time in Tokyo and save it to /tmp/e2e/tokyo.txt',
      _backend('0', _plan('command_automate')),
      { taskType: 'browser', webAccessMode: 'public_read', targetService: null });
    assert.notEqual(r._decomposedBy, 'public-research-guard');
    assert.equal(r._decomposedIntent, 'command_automate');
  });

  it('pure public research (no path) still routes to web_search', async () => {
    const r = await _decompose('look online for reviews of the new iphone',
      _backend('0', _plan('command_automate')),
      { taskType: 'browser', webAccessMode: 'public_read', targetService: null });
    assert.equal(r._decomposedBy, 'public-research-guard');
    assert.equal(r._decomposedIntent, 'web_search');
  });
});

'use strict';
/**
 * screen-referent-routing.test.js — live-screen questions must reach
 * screen_intelligence, not get stolen by follow-up/inspection false-positives.
 *
 * Regression (Stage-2 live run):
 *   - "read the text visible on my screen" — classifyTask flagged
 *     isFollowUp:true (deictic "the text") → unresolved-followup guard →
 *     memory_retrieve. A self-contained screen question was answered from
 *     stale captures instead of a fresh capture.
 *   - "is there an error dialog visible on my screen" — isAppUiInspection:true
 *     with NO named app (spec violation) → parseIntentV2 override →
 *     command_automate → plan + clarify gate → 241s waiting-for-input timeout.
 *
 * Fixes under test:
 *   decomposePromptV2: unresolved-followup guard skips when the
 *     classification already resolved the referent to the live screen
 *     (activeDocRef:'screen' | isScreenFollowUp | needsFreshScreen).
 *   parseIntentV2: isAppUiInspection override requires targetService — the
 *     flag's spec demands a NAMED app; without one the flag is a false
 *     positive and must not reroute.
 *
 * Run: node stategraph-module/test/screen-referent-routing.test.js
 */

const { describe, it } = require('node:test');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');
const parseIntentV2 = require('../src/nodes/parseIntentV2.js');

// _decomposeDecision is a number-call (0-6 single-step): 1 = screen_intelligence
const _SCREEN_NUMBER_BACKEND = { generateAnswer: async () => '1' };

const _decompose = (message, backend, tc, hint) => decomposePromptV2({
  message,
  conversationHistory: [],
  logger: _noopLogger,
  llmBackend: backend || _SCREEN_NUMBER_BACKEND,
  _taskClassification: tc,
  _carriedHint: hint,
});

const _parse = (message, tc, estimatedIntent = 'screen_intelligence', hint) => parseIntentV2({
  message,
  logger: _noopLogger,
  intentPlan: [{ text: message, estimatedIntent, order: 0, dependsOn: [], isLongRunning: false }],
  _taskClassification: tc,
  _carriedHint: hint,
});

describe('decomposePromptV2 — screen referent routing', () => {
  it('isFollowUp+isScreenFollowUp+query → deterministic screen_intelligence', async () => {
    const r = await _decompose('read the text visible on my screen', null,
      { taskType: 'query', isFollowUp: true, followUpTarget: null, isScreenFollowUp: true, activeDocRef: 'screen' });
    assertEq(r._decomposedIntent, 'screen_intelligence');
    assertEq(r._decomposedBy, 'screen-observation-guard');
  });

  it('needsFreshScreen+query → screen_intelligence without the number call', async () => {
    const r = await _decompose('check the chart on my screen', null,
      { taskType: 'query', needsFreshScreen: true });
    assertEq(r._decomposedIntent, 'screen_intelligence');
    assertEq(r._decomposedBy, 'screen-observation-guard');
  });

  it('imperative screen action (taskType local_system) skips the guard', async () => {
    const r = await _decompose('click the button on my screen',
      { generateAnswer: async () => '0' },
      { taskType: 'local_system', isScreenFollowUp: true, activeDocRef: 'screen' });
    assert(r._decomposedBy !== 'screen-observation-guard', 'guard must not fire on imperative tasks');
  });

  it('carriedHint "screen_analysis" (comms vocab) maps to screen_intelligence on LLM failure', async () => {
    const r = await decomposePromptV2({
      message: "what's on my screen", conversationHistory: [], logger: _noopLogger,
      llmBackend: { generateAnswer: async () => { throw new Error('provider down'); } },
      _taskClassification: {}, _carriedHint: 'screen_analysis',
    });
    assertEq(r._decomposedIntent, 'screen_intelligence');
  });

  it('true referent-less follow-up still routes memory_retrieve (guard intact)', async () => {
    const r = await _decompose('yes you can', null,
      { isFollowUp: true, followUpTarget: null });
    assertEq(r._decomposedIntent, 'memory_retrieve');
    assertEq(r._decomposedBy, 'unresolved-followup-guard');
  });

  it('needs_clarification with screen referent also skips the guard', async () => {
    const r = await _decompose('is there an error on my screen', null,
      { resolution: 'needs_clarification', activeDocRef: 'screen' });
    assert(r._decomposedBy !== 'unresolved-followup-guard', 'guard must not fire');
  });
});

describe('parseIntentV2 — isAppUiInspection override precondition', () => {
  it('isAppUiInspection without targetService → no override (screen_intelligence kept)', async () => {
    const r = await _parse('is there an error dialog visible on my screen',
      { isAppUiInspection: true, targetService: null, isScreenFollowUp: true });
    assertEq(r.intent.type, 'screen_intelligence');
  });

  it('isAppUiInspection WITH named app → override still fires (command_automate)', async () => {
    const r = await _parse('show me where the input area is in Slack',
      { isAppUiInspection: true, targetService: 'slack' });
    assertEq(r.intent.type, 'command_automate');
  });

  it('isSpatialAnalysis still overrides (unchanged path)', async () => {
    const r = await _parse('what regions are on my screen',
      { isSpatialAnalysis: true });
    assertEq(r.intent.type, 'command_automate');
  });

  it('plain screen question → screen_intelligence unaffected', async () => {
    const r = await _parse("what's on my screen", {});
    assertEq(r.intent.type, 'screen_intelligence');
  });
});

describe('decomposePromptV2 — screen guard vs carried hint', () => {
  it('needsFreshScreen flag + memory hint → hint wins (hallucinated flag)', async () => {
    // classifyTask hallucinated needsFreshScreen:true on "summarize what I
    // worked on recently" — zero screen referent. The comms guesser's
    // memory_retrieve hint is the deterministic signal; the lone flag must
    // not override it (observed Stage-2 flake → screen_intelligence + OCR).
    // With the guard vetoed, the number call (4 = memory_retrieve) decides.
    const r = await _decompose('summarize what I worked on recently',
      { generateAnswer: async () => '4' },
      { taskType: 'query', needsFreshScreen: true },
      'memory_retrieve');
    assertEq(r._decomposedIntent, 'memory_retrieve');
    assertEq(r._decomposedBy === 'screen-observation-guard', false, 'guard must not fire on vetoed flag');
  });

  it('screen-observation lexicon + no screen flags → screen_intelligence', async () => {
    // "what app am I looking at" drew isFollowUp:true/activeDocRef:'file'
    // with NO screen flags — the message vocabulary is the deterministic
    // signal (observed Stage-2 flake → unresolved-followup → memory_retrieve).
    const r = await _decompose('what app am I looking at',
      _SCREEN_NUMBER_BACKEND,
      { taskType: 'query', isFollowUp: true, followUpTarget: null, activeDocRef: 'file' },
      'screen_intelligence');
    assertEq(r._decomposedIntent, 'screen_intelligence');
  });

  it('screen flags + screen hint → screen_intelligence (agreement)', async () => {
    const r = await _decompose("what's on my screen",
      _SCREEN_NUMBER_BACKEND,
      { taskType: 'query', isScreenFollowUp: true },
      'screen_intelligence');
    assertEq(r._decomposedIntent, 'screen_intelligence');
  });
});

describe('parseIntentV2 — app_automation override convergence check', () => {
  it('taskType=app_automation + non-auto decompose+hint concurrence → no override', async () => {
    // classifyTask hallucinated taskType:'app_automation' + targetService
    // 'Devin' on "summarize what I worked on recently" (the open app leaked
    // into the label). Decompose+hint both said memory_retrieve — the bare
    // label must not flip it to command_automate (observed Stage-2 flake →
    // plan+preflight failure on a memory question).
    const r = await _parse('summarize what I worked on recently',
      { taskType: 'app_automation', targetService: 'Devin', requiresDOM: true },
      'memory_retrieve', 'memory_retrieve');
    assertEq(r.intent.type, 'memory_retrieve');
  });

  it('taskType=app_automation + no hint → override still fires', async () => {
    const r = await _parse('in Devin use the AI to add tests',
      { taskType: 'app_automation', targetService: 'Devin' },
      'memory_retrieve');
    assertEq(r.intent.type, 'command_automate');
  });

  it('taskType=app_automation + disagreeing hint (command_automate) → override fires', async () => {
    const r = await _parse('open slack and send the file',
      { taskType: 'app_automation', targetService: 'Slack' },
      'memory_retrieve', 'command_automate');
    assertEq(r.intent.type, 'command_automate');
  });
});

describe('parseIntentV2 — activeDocRef override precondition', () => {
  it('activeDocRef=url + message names the screen → no override (screen referent is explicit)', async () => {
    // classifyTask conflated "the text" with the open Chrome URL —
    // activeDocRef:'url' on a message whose referent is explicitly the screen
    // contradicts the message itself (observed: "read the text visible on my
    // screen" → command_automate → file-extract plan → 99s failure).
    const r = await _parse('read the text visible on my screen',
      { activeDocRef: 'url', isFollowUp: true, followUpTarget: 'the text' });
    assertEq(r.intent.type, 'screen_intelligence');
  });

  it('activeDocRef=file + screen-observation phrasing (no surface word) → no override', async () => {
    // "what app am I looking at" never names a surface, but the referent is
    // the live screen — classifyTask hallucinated activeDocRef:'file' from
    // the focused editor tab (observed Stage-2 flake: screen_intelligence →
    // command_automate → plan+clarify → 103s).
    const r = await _parse('what app am I looking at',
      { activeDocRef: 'file' });
    assertEq(r.intent.type, 'screen_intelligence');
  });

  it('activeDocRef=file + no screen word → override still fires', async () => {
    const r = await _parse('explain this file to me',
      { activeDocRef: 'file' });
    assertEq(r.intent.type, 'command_automate');
  });
});

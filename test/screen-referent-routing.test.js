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

describe('decomposePromptV2 — ambient-artifact misresolution guard', () => {
  it('bare deictic + activeDocRef:file → memory_retrieve (conversational referent)', async () => {
    // classifyTask resolved "that" in "tell me more about that" to the open
    // Devin plan file (activeDocRef:'file', followUpTarget:'the plan file in
    // Devin') instead of the prior recall turn — general_knowledge then
    // answered about Devin planning (observed Stage-3 failure). A bare
    // deictic can only refer to the conversation → memory_retrieve.
    const r = await _decompose('tell me more about that',
      { generateAnswer: async () => '5' },
      { taskType: 'query', isFollowUp: true, followUpTarget: 'the plan file in Devin', activeDocRef: 'file' },
      'memory_retrieve');
    assertEq(r._decomposedIntent, 'memory_retrieve');
    // The deictic-continuation guard (runs earlier) now claims bare deictics;
    // unresolved-followup remains the fallback for the hint-vetoed case.
    assertEq(r._decomposedBy, 'deictic-continuation-guard');
  });

  it('deictic naming an artifact noun is NOT misresolved', async () => {
    // "tell me more about that file" names an artifact — the ambient-file
    // referent is legitimate; the guard must not claim it.
    const r = await _decompose('tell me more about that file',
      { generateAnswer: async () => '5' },
      { taskType: 'query', isFollowUp: true, followUpTarget: 'plan.md', activeDocRef: 'file' });
    assertEq(r._decomposedBy !== 'unresolved-followup-guard', true, 'artifact noun → guard must not fire');
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

  it('activeDocRef=file + window-chrome question → no override (ambient file misref)', async () => {
    // "read the title of that window" — classifyTask resolved "that window"
    // to the open plan file (activeDocRef:'file', isFollowUp:true,
    // followUpTarget:"the title of the window"); the number call correctly
    // picked screen_intelligence, then the file override clobbered it to
    // command_automate (observed Stage-3 run-3 flake → plan approval).
    const r = await _parse('read the title of that window',
      { activeDocRef: 'file', isFollowUp: true, followUpTarget: 'the title of the window' });
    assertEq(r.intent.type, 'screen_intelligence');
  });
});

describe('decomposePromptV2 — deictic-continuation guard', () => {
  it('window-chrome question routes via screen guard even without typed flags', async () => {
    // "read the title of that window" named no surface word — the shared
    // window-chrome vocabulary is the lexical signal (taskType query).
    const r = await _decompose('read the title of that window', null,
      { taskType: 'query', isFollowUp: true, followUpTarget: 'the title of the window', activeDocRef: 'file', webAccessMode: 'none' });
    assertEq(r._decomposedIntent, 'screen_intelligence');
    assertEq(r._decomposedBy, 'screen-observation-guard');
  });

  it('bare deictic + concurring memory hint → memory_retrieve, skipping number call', async () => {
    // Stage-3 flake: hint said memory_retrieve but the number call picked
    // general_knowledge (semanticCtx happened to carry the topic — luck, not
    // design). A bare deictic's referent lives only in the transcript.
    const backend = { generateAnswer: async () => { throw new Error('number call must not run'); } };
    const r = await _decompose('tell me more about that', backend,
      { taskType: 'query', isFollowUp: true, followUpTarget: 'the prior topic', webAccessMode: 'none' },
      'memory_retrieve');
    assertEq(r._decomposedIntent, 'memory_retrieve');
    assertEq(r._decomposedBy, 'deictic-continuation-guard');
  });

  it('bare deictic + no hint → memory_retrieve (transcript is the referent)', async () => {
    const backend = { generateAnswer: async () => { throw new Error('number call must not run'); } };
    const r = await _decompose('when was that', backend,
      { taskType: 'query' });
    assertEq(r._decomposedIntent, 'memory_retrieve');
    assertEq(r._decomposedBy, 'deictic-continuation-guard');
  });

  it('bare deictic + contradicting hint defers to normal flow', async () => {
    // An action/search hint vetoes — "do that again" asks to re-run a task.
    const r = await _decompose('when was that', null,
      { taskType: 'query', isFollowUp: true, followUpTarget: 'the search' },
      'web_search');
    assert(r._decomposedBy !== 'deictic-continuation-guard', 'guard must defer when hint disagrees');
  });

  it('deictic naming a screen surface stays screen_intelligence (guard order)', async () => {
    // "what's that on my screen" matches both vocabularies — the referent is
    // the live screen, so the screen guard must win (runs earlier).
    const r = await _decompose('what is that on my screen', null,
      { taskType: 'query' });
    assertEq(r._decomposedIntent, 'screen_intelligence');
    assertEq(r._decomposedBy, 'screen-observation-guard');
  });
});

describe('decomposePromptV2 — classifyTask suggestedIntent merge', () => {
  // The merge replaces the redundant second classifier: classifyTask saw the
  // full context the 5-token number call lacks, so a suggestedIntent that
  // concurs with (or is unopposed by) the carried hint IS the decision.
  const _noCall = { generateAnswer: async () => { throw new Error('number call must not run'); } };

  it('suggestedIntent unopposed → decision without the number call', async () => {
    const r = await _decompose('explain the difference between TCP and UDP', _noCall,
      { taskType: 'query', suggestedIntent: 'general_knowledge' });
    assertEq(r._decomposedIntent, 'general_knowledge');
  });

  it('suggestedIntent + concurring hint → decision without the number call', async () => {
    const r = await _decompose('who is my wife', _noCall,
      { taskType: 'query', suggestedIntent: 'memory_retrieve' },
      'memory_retrieve');
    assertEq(r._decomposedIntent, 'memory_retrieve');
  });

  it('contradicting hint → number call arbitrates', async () => {
    // classifyTask said web_search but comms' deterministic hint says
    // general_knowledge — disagreement escalates to the number call.
    let calls = 0;
    const r = await _decompose('explain how photosynthesis works',
      { generateAnswer: async () => { calls++; return '5'; } },
      { taskType: 'query', suggestedIntent: 'web_search' },
      'general_knowledge');
    assertEq(calls, 1, 'number call must run on hint conflict');
    assertEq(r._decomposedIntent, 'general_knowledge');
  });

  it('suggestedIntent=multi_step → full decomposition, no number call', async () => {
    const plan = [{ text: 'find X', estimatedIntent: 'web_search', order: 0, dependsOn: [], isLongRunning: false },
                  { text: 'email it', estimatedIntent: 'command_automate', order: 1, dependsOn: [0], isLongRunning: false }];
    const backend = { generateAnswer: async () => JSON.stringify({ subPrompts: plan }) };
    const r = await _decompose('find X and email it to me', backend,
      { taskType: 'query', suggestedIntent: 'multi_step' });
    assertEq(r.intentPlan.length, 2);
    assertEq(r._decomposedBy, 'llm');
  });

  it('no suggestedIntent → number call runs as before', async () => {
    const r = await _decompose('what is the capital of France',
      { generateAnswer: async () => '5' },
      { taskType: 'query' });
    assertEq(r._decomposedIntent, 'general_knowledge');
  });
});

describe('decomposePromptV2 — screen-output guard lexical completion', () => {
  const _tc = (extra) => ({ taskType: 'local_system', isScreenOutput: true, screenOutputAction: 'show', ...extra });
  const _noCall = { generateAnswer: async () => { throw new Error('must not be called'); } };

  it('effect kind inferred lexically — no fetch step even when classifier omits it', async () => {
    // Flaky path observed in E2E: classifier emitted kind 'text' + no content
    // → guard added web_search sub → search answer hallucinated the display.
    const r = await _decompose('make confetti appear on my screen', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r._decomposedIntent, 'screen_display');
    assertEq(r.intentPlan.length, 1, 'effect must not emit a fetch step');
    assertEq(r.intentPlan[0].estimatedIntent, 'screen_display');
    assertEq(r._taskClassification.screenOutputKind, 'effect');
  });

  it('emoji kind inferred from the pictograph itself', async () => {
    const r = await _decompose('put a 🎉 emoji on my screen', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r.intentPlan.length, 1);
    assertEq(r._taskClassification.screenOutputKind, 'emoji');
  });

  it('image kind inferred from an image URL in the message', async () => {
    const r = await _decompose('show this image on my screen: https://example.com/cat.png', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r.intentPlan.length, 1);
    assertEq(r._taskClassification.screenOutputKind, 'image');
  });

  it('quoted content extracted — no fetch step for literal display', async () => {
    const r = await _decompose('show "meeting at 3pm" on my screen', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r.intentPlan.length, 1, 'quoted content must not emit a fetch step');
    assertEq(r._taskClassification.screenOutputContent, 'meeting at 3pm');
  });

  it('literal-payload lead ("the word X") extracted as content', async () => {
    const r = await _decompose('put the word DONE on the screen', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r.intentPlan.length, 1);
    assertEq(r._taskClassification.screenOutputContent, 'DONE');
  });

  it('fetchable referent still gets the fetch → display chain', async () => {
    const r = await _decompose('show me john 3:16 on my screen', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r.intentPlan.length, 2, 'fresh-content request keeps the fetch step');
    // Scripture refs route to the deterministic bible_verse plan
    // (command_automate), not web_search — ranked snippets painted junk.
    assertEq(r.intentPlan[0].estimatedIntent, 'command_automate');
    assertEq(r.intentPlan[1].estimatedIntent, 'screen_display');
    assertEq(r.intentPlan[1].dependsOn[0], 0);
  });

  it('referential display ("show that") never fetches', async () => {
    const r = await _decompose('show that on my screen', _noCall,
      _tc({ screenOutputKind: 'text' }));
    assertEq(r.intentPlan.length, 1);
    assertEq(r._taskClassification.screenOutputContent ?? null, null,
      'bare referential must not become literal content');
  });
});

describe('decomposePromptV2 — screen-output lexical fallback (isScreenOutput flake)', () => {
  const _noCall = { generateAnswer: async () => { throw new Error('must not be called'); } };

  it('lexical display signal routes when isScreenOutput flag is absent', async () => {
    // Observed flake: "look up the current bitcoin price and show it on my
    // screen" → classifyTask omitted isScreenOutput → llmDecompose chose
    // command_automate (109s plan+preflight for a display request).
    const r = await _decompose('show fireworks on the screen', _noCall,
      { taskType: 'query' });  // no isScreenOutput
    assertEq(r._decomposedIntent, 'screen_display');
    assertEq(r._decomposedBy, 'screen-output-guard');
  });

  it('lookup+display conjunction emits deterministic web_search→screen_display', async () => {
    const r = await _decompose('look up the current bitcoin price and show it on my screen', _noCall,
      { taskType: 'query' });  // no isScreenOutput
    assertEq(r.intentPlan.length, 2);
    assertEq(r.intentPlan[0].estimatedIntent, 'web_search');
    assertEq(r.intentPlan[1].estimatedIntent, 'screen_display');
    assertEq(r.intentPlan[1].dependsOn[0], 0);
  });

  it('observation questions still excluded from the display fallback', async () => {
    const r = await _decompose("what's on my screen", _noCall,
      { taskType: 'query' });
    assertEq(r._decomposedIntent, 'screen_intelligence');
    assertEq(r._decomposedBy, 'screen-observation-guard');
  });
});

describe('classifyTask/decompose — action-passive coherence', () => {
  it('action taskType + passive suggestedIntent → suggestion dropped, escalates', async () => {
    // "read the file /tmp/x and tell me what it says" emitted
    // taskType:'local_file' + suggestedIntent:'general_knowledge' and the
    // merge amplified it into a "I can't read files" hallucination.
    const backend = {
      generateAnswer: async (q) => {
        if (/subPrompts/i.test(String(q))) {
          return JSON.stringify({ subPrompts: [{ text: 'read the file /tmp/e2e/hello.txt', estimatedIntent: 'command_automate', order: 0, dependsOn: [], isLongRunning: false }] });
        }
        return '4'; // number call: general_knowledge — wrong on purpose
      },
    };
    const r = await _decompose('read the file /tmp/e2e/hello.txt and tell me what it says', backend,
      { taskType: 'local_file', activeDocRef: 'file', followUpTarget: '/tmp/e2e/hello.txt', isFollowUp: true, suggestedIntent: 'general_knowledge' });
    // The contradiction must NOT be silently trusted — either the suggestion
    // was nulled upstream (classifyTask coherence) or the decision site
    // escalates a passive pick on an action taskType to full decompose.
    assertEq(r._decomposedIntent, 'command_automate');
  });

  it('passive taskType + command_automate suggestedIntent → classifyTask nulls it', async () => {
    const { classifyTask } = require('../src/utils/classifyTask');
    const tc = await classifyTask('what is photosynthesis', [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'query', suggestedIntent: 'command_automate' }) },
      { info() {}, debug() {}, warn() {}, error() {} });
    assertEq(tc.suggestedIntent, null);
  });

  it('action taskType + passive suggestedIntent → classifyTask nulls it', async () => {
    const { classifyTask } = require('../src/utils/classifyTask');
    const tc = await classifyTask('read the file /tmp/x.txt', [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'local_file', suggestedIntent: 'general_knowledge' }) },
      { info() {}, debug() {}, warn() {}, error() {} });
    assertEq(tc.suggestedIntent, null);
  });

  it('coherent action pair (local_file + command_automate) survives', async () => {
    const { classifyTask } = require('../src/utils/classifyTask');
    const tc = await classifyTask('read the file /tmp/x.txt', [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'local_file', suggestedIntent: 'command_automate' }) },
      { info() {}, debug() {}, warn() {}, error() {} });
    assertEq(tc.suggestedIntent, 'command_automate');
  });
});

describe('decompose — device-state guard', () => {
  it('battery question → command_automate even when hint disagrees', async () => {
    const r = await _decompose("what's my battery percentage",
      { generateAnswer: async () => '4' },
      { taskType: 'local_system', suggestedIntent: 'command_automate', webAccessMode: 'none' },
      'general_knowledge');
    assertEq(r._decomposedIntent, 'command_automate');
    assertEq(r._decomposedBy, 'device-state-guard');
  });

  it('device-state with flaky query taskType still → command_automate', async () => {
    const r = await _decompose('how much disk space do I have',
      { generateAnswer: async () => '4' },
      { taskType: 'query', suggestedIntent: 'general_knowledge', webAccessMode: 'none' },
      'general_knowledge');
    assertEq(r._decomposedIntent, 'command_automate');
  });
});

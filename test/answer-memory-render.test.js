'use strict';
/**
 * answer-memory-render.test.js — audio_journal rows must be identifiable
 *
 * Regression: retrieveMemory merges audio_journal episodic rows, but the
 * SCREEN ACTIVITY & MEMORIES block labeled them "(memory)" and hid their
 * metadata behind a screen_capture-only metaLine — the LLM saw anonymous
 * transcript fragments and answered "no record" despite 6 merged rows
 * (observed: "which videos did I watch" → "I don't see any record").
 *
 * Asserts the prompt block carries the audio_journal type label plus the
 * media title/URL/app from metadata.
 *
 * Run with: node test/answer-memory-render.test.js
 */
const answer = require('../src/nodes/answer.js');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const AUDIO_MEM = {
  id: 'mem_audio_1',
  type: 'audio_journal',
  text: '[2026-11-06T04:32:18.527Z] Exercise, the reason why people\'s urine changes color when it dehydrates. '.repeat(8),
  created_at: '2026-11-06T04:36:16.144Z',
  formattedDate: { absolute: 'November 5, 2026 at 11:36 PM', relative: '(1 day ago)' },
  metadata: {
    appName: 'web',
    title: 'NYC Marathon Runner Dies at 24: Was It Really Rhabdo?',
    url: 'https://www.youtube.com/watch?v=RlUPXKqes8s'
  }
};

function makeState(memories) {
  const captured = {};
  return {
    captured,
    state: {
      message: 'which videos did I watch',
      intent: { type: 'memory_retrieve' },
      filteredMemories: memories,
      conversationHistory: [],
      logger: silentLogger,
      context: { userId: 'local_user', sessionId: 'sess_t' },
      llmBackend: {
        getInfo: () => ({ name: 'mock' }),
        isAvailable: async () => true,
        generateAnswer: async (query, payload) => {
          captured.systemInstructions = payload?.context?.systemInstructions || '';
          return 'stub answer';
        },
      },
    },
  };
}

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

(async () => {
  console.log('\nanswer memory-block render — audio_journal visibility');

  {
    const { state, captured } = makeState([AUDIO_MEM]);
    await answer(state);
    const si = captured.systemInstructions;
    check('row labeled (audio_journal), not (memory)', si.includes('(audio_journal)'));
    check('video title rendered in metaLine', si.includes('NYC Marathon Runner Dies at 24'));
    check('media URL rendered', si.includes('youtube.com/watch?v=RlUPXKqes8s'));
    check('appName rendered', si.includes('App: web'));
    check('transcript gets the 500-char budget (not 200)', (si.match(/urine changes color/g) || []).length >= 4);
  }

  {
    // windowTitle absent → metadata.title must back-fill the Window: line
    const noWin = { ...AUDIO_MEM, id: 'm2', metadata: { appName: 'web', title: 'Sermon Clip Title', url: 'https://youtu.be/x' } };
    const { state, captured } = makeState([noWin]);
    await answer(state);
    check('title back-fills Window when windowTitle absent', captured.systemInstructions.includes('Window: Sermon Clip Title'));
  }

  {
    // non-audio/non-screen rows keep the compact 200-char render
    const note = { id: 'm3', type: 'user_memory', text: 'x'.repeat(400), created_at: '2026-11-06', formattedDate: { absolute: 'Nov 6' }, metadata: {} };
    const { state, captured } = makeState([note]);
    await answer(state);
    check('user_memory rows still capped at 200 chars', captured.systemInstructions.includes('x'.repeat(200)) && !captured.systemInstructions.includes('x'.repeat(201)));
  }

  {
    // The post-hoc URL guard was removed — an answer containing a URL streams
    // verbatim. (It nuked a correct 6-URL answer: allowlist scanned mem.text
    // while audio_journal links live in metadata.url.)
    const urlAnswer = 'You watched:\n- NYC Marathon Runner Dies at 24 — https://www.youtube.com/watch?v=RlUPXKqes8s';
    const { state, captured } = makeState([AUDIO_MEM]);
    state.llmBackend.generateAnswer = async (q, p) => { captured.systemInstructions = p?.context?.systemInstructions || ''; return urlAnswer; };
    const res = await answer(state);
    check('URL-bearing answer passes through unmodified', res.answer === urlAnswer);
    check('no "Search Issue Detected" template in output', !String(res.answer).includes('Search Issue Detected'));
  }

  {
    // Source lint — the guard must stay gone (lint-test convention in this repo).
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/nodes/answer.js'), 'utf8');
    check('_YOUTUBE_URL_REGEX not reintroduced', !src.includes('_YOUTUBE_URL_REGEX'));
    check('Search Issue Detected template not reintroduced', !src.includes('Search Issue Detected'));
  }

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})();

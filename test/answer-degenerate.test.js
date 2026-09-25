'use strict';
/**
 * answer-degenerate.test.js — blank-line-loop guard
 *
 * Regression: providers occasionally emit a valid intro then loop newlines
 * until the token cap (observed live: "Here are some jokes…" + ~250 blank
 * lines, 42s). The guard retries once unstreamed (provider chain rotates)
 * and collapses pathological blank runs; clean answers pass through
 * untouched.
 */
const answer = require('../src/nodes/answer.js');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const SPAM = 'Here are some jokes for you to tell your friends:' + '\n'.repeat(250);
const CLEAN = 'Why did the chicken cross the road? To get to the other side.';

function makeState(script) {
  const calls = [];
  return {
    state: {
      message: 'tell me a joke',
      intent: { type: 'general_knowledge' },
      logger: silentLogger,
      llmBackend: {
        getInfo: () => ({ name: 'mock' }),
        isAvailable: async () => true,
        generateAnswer: async () => { calls.push(1); return script[Math.min(calls.length - 1, script.length - 1)]; },
      },
    },
    calls,
  };
}

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

(async () => {
  console.log('\nanswer degenerate-output guard');

  {
    const { state, calls } = makeState([SPAM, CLEAN]);
    const res = await answer(state);
    check('degenerate answer retried → clean retry wins', res.answer === CLEAN);
    check('exactly one retry issued', calls.length === 2);
  }

  {
    const { state, calls } = makeState([SPAM, SPAM]);
    const res = await answer(state);
    check('double-degenerate → sanitized original kept', res.answer === 'Here are some jokes for you to tell your friends:');
    check('still only one retry', calls.length === 2);
    check('no residual blank runs', !/(\n\s*){3,}/.test(res.answer));
  }

  {
    const { state, calls } = makeState([CLEAN]);
    const res = await answer(state);
    check('clean answer passes through, no retry', res.answer === CLEAN && calls.length === 1);
  }

  {
    const mild = 'Line one.\n\n\n\nLine two.';
    const { state, calls } = makeState([mild]);
    const res = await answer(state);
    check('3+ blank runs collapsed without retry', res.answer === 'Line one.\n\nLine two.' && calls.length === 1);
  }

  {
    // REPLACE sentinel: streamed spam must be replaced by corrected text
    const chunks = [];
    const { state, calls } = makeState([SPAM, CLEAN]);
    state.streamCallback = (c) => chunks.push(c);
    const res = await answer(state);
    const replace = chunks.find(c => typeof c === 'string' && c.startsWith('\x00REPLACE\x00'));
    check('REPLACE sentinel emitted after streamed spam', !!replace);
    check('REPLACE carries the corrected answer', replace && replace.includes(CLEAN));
    check('retry ran unstreamed (no raw retry tokens streamed)', calls.length === 2);
  }

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

'use strict';
/**
 * classify-injected-blocks.test.js — deterministic guards in classifyTask run
 * on user-authored text only. Injected pipeline metadata — "(Resolved
 * referent — …)", "[Resolved file path: …]", "(Context from prior turn: …)" —
 * is a system annotation for the LLM prompt, not user text, so lexical
 * guards (literal-path coercion, service recovery, mutation cues) must not
 * pattern-match it.
 *
 * Observed bug: "polish a response" carried a bogus "(Resolved referent —
 * message (titled "nothing to commit, working tree clean,") created by shell
 * (task task_x) — <prompt slice with /Users/… path>)" blob. FILE_PATH_RE
 * fired on the injected path → taskType coerced to local_file → heavy
 * filesystem automation for a drafting request.
 *
 * Run: node stategraph-module/test/classify-injected-blocks.test.js
 */
const { classifyTask } = require('../src/utils/classifyTask');

const _noop = { info() {}, warn() {}, debug() {}, error() {} };
const _backend = (json) => ({ generateAnswer: async () => JSON.stringify(json) });
const _classify = (message, json, opts = {}) =>
  classifyTask(message, [], _backend(json), _noop, null, null, opts);

let passed = 0, failed = 0;
function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log('  PASS:', label); }
  else { failed++; console.error(`  FAIL: ${label} ${extra}`); }
}

(async () => {
  // ── Injected referent blob must not feed lexical guards ────────────────────

  let tc = await _classify(
    'polish this response (Resolved referent — message (titled "nothing to commit, working tree clean,") created by shell (task task_9f2a) — commit the file /Users/luka/work/log.txt)',
    { taskType: 'query' },
  );
  ok(tc.taskType === 'query', 'injected referent path does NOT coerce taskType to local_file', `taskType=${tc.taskType}`);

  // Same shape with the bracketed variants.
  tc = await _classify(
    'polish this response\n[Resolved file path: /Users/luka/work/log.txt]',
    { taskType: 'query' },
  );
  ok(tc.taskType === 'query', 'injected [Resolved file path] does NOT coerce to local_file', `taskType=${tc.taskType}`);

  tc = await _classify(
    'polish this response (Context from prior turn: edited /Users/luka/work/log.txt yesterday)',
    { taskType: 'query' },
  );
  ok(tc.taskType === 'query', 'injected (Context from prior turn) does NOT coerce to local_file', `taskType=${tc.taskType}`);

  // ── A real user-authored path still coerces ────────────────────────────────

  tc = await _classify('read /tmp/real-check-file.txt', { taskType: 'query' });
  ok(tc.taskType === 'local_file', 'verbatim path still coerces query → local_file', `taskType=${tc.taskType}`);

  // ── Service recovery is gated on a service-capable taskType ───────────────

  tc = await _classify('check youtube for mike winger videos', { taskType: 'query' });
  ok(tc.targetService === null || tc.targetService === undefined,
    'query taskType never recovers a lexical service', `targetService=${tc.targetService}`);

  tc = await _classify('goto youtube and look for mike winger', { taskType: 'browser', webAccessMode: 'interactive' });
  ok(tc.targetService === 'youtube', 'browser taskType recovers the named service', `targetService=${tc.targetService}`);

  // ── Email addresses are recipients, not service mentions ──────────────────

  tc = await _classify('polish the reply to notifications@github.com', { taskType: 'browser', webAccessMode: 'interactive' });
  ok(tc.targetService === null || tc.targetService === undefined,
    '@github.com inside an email address does not recover github', `targetService=${tc.targetService}`);

  // Phantom-service drop-guard still works on the injected corpus (a
  // legitimately bound referent names its service — keep that behavior).
  tc = await _classify(
    'delete it (Resolved referent — event created by nylas.agent (task task_2) — create a calendar event)',
    { taskType: 'scheduling', targetService: 'nylas', webAccessMode: 'none' },
  );
  ok(tc.targetService === 'nylas', 'referent-named service survives the drop-guard', `targetService=${tc.targetService}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

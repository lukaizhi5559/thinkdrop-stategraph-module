'use strict';
/**
 * history-request-scope.test.js — Phase 4.7: judgments read the ask, not the paste
 *
 * Regression: a clarify turn asked "the YouTube notification rule, or just the
 * emoji?" and WebSearch resolved followUpTarget to the pasted rule — history
 * turns carried paste+question unscoped, so judgments judged the paste.
 *
 *   - _historyEntry: user entries carry requestText (persisted metadata wins;
 *     legacy rows fall back to derived ask); assistant rows never get it
 *   - classifyTask: the decision-model state renders user turns via
 *     requestText — a pasted rule in history cannot leak into the judgment
 *
 * Run: node stategraph-module/test/history-request-scope.test.js
 */

const { _historyEntry } = require('../src/nodes/resolveReferencesV2');
const { classifyTask } = require('../src/utils/classifyTask');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

const PASTE = 'Here is my ThinkDrop rule — set it up last week and reviewing before adding more like it. Rule: when a new video drops on a watched YouTube channel, show a happy emoji on my screen. It watches the channel, polls periodically, and displays an overlay.';
const ASK = 'Can you explain what this rule actually does?';

// ── _historyEntry ─────────────────────────────────────────────────────
{
  const e = _historyEntry(
    { sender: 'user', text: `${PASTE} ${ASK}`, id: 'm1', timestamp: 1 },
    { requestText: ASK },
    'recent'
  );
  ok(e.requestText === ASK, 'persisted metadata.requestText wins for user turns');
  ok(e.role === 'user' && e.content.includes('happy emoji'), 'raw content preserved (answer nodes keep the paste)');
}
{
  const e = _historyEntry(
    { sender: 'user', text: `${PASTE} ${ASK}`, id: 'm2', timestamp: 2 },
    {},
    'recent'
  );
  ok(e.requestText === ASK, 'legacy rows (no metadata) fall back to derived ask');
}
{
  const e = _historyEntry(
    { sender: 'user', text: 'short plain turn', id: 'm3', timestamp: 3 },
    null,
    'recent'
  );
  ok(e.requestText === 'short plain turn', 'short turns keep full text');
}
{
  const e = _historyEntry(
    { sender: 'assistant', text: 'some assistant reply', id: 'm4', timestamp: 4 },
    {},
    'recent'
  );
  ok(e.requestText === undefined, 'assistant turns never carry requestText');
}

// ── classifyTask: decision state sees the ask, not the paste ───────────
(async () => {
  let captured = '';
  const askDecision = async (qs, { state } = {}) => {
    captured += '\n' + String(state || '');
    return { answers: { taskType: { index: 6 }, suggestedIntent: { index: 0 }, isFollowUp: { bool: true } } };
  };
  const llmBackend = { generateAnswer: async () => '{}' };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  const history = [
    { role: 'user', content: `${PASTE} ${ASK}`, requestText: ASK, timestamp: 1 },
    { role: 'assistant', content: 'That rule watches a YouTube channel and shows an emoji.', timestamp: 2 },
    { role: 'user', content: 'ok thanks', timestamp: 3 },
  ];

  await classifyTask('show a happy emoji on my screen', history, llmBackend, logger, null, null, { askDecision });

  ok(captured.includes(ASK), 'decision state contains the scoped ask');
  ok(!captured.includes('watched YouTube channel'), 'pasted rule body stays out of the decision state');
  ok(captured.includes('watches a YouTube channel'), 'assistant turns still render verbatim');

  // Legacy caller rows (no requestText) — content renders as-is (fallback).
  captured = '';
  const legacyHistory = [
    { role: 'user', content: 'find the thinkdrop folder', timestamp: 1 },
  ];
  await classifyTask('now open it', legacyHistory, llmBackend, logger, null, null, { askDecision });
  ok(captured.includes('find the thinkdrop folder'), 'legacy rows fall back to content');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

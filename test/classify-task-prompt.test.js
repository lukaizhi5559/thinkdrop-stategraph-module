'use strict';
/**
 * classify-task-prompt.test.js — guards the CLASSIFY_SYSTEM_PROMPT few-shot
 * contract so examples can't silently teach the wrong taskType.
 *
 * Regression: "what time is it" was taught as taskType:"local_system" → the
 * decompose local-short-circuit sent a trivial time question down
 * command_automate (65KB plan prompt + approval gate + shell.run). The answer
 * node already injects CURRENT LOCAL TIME — temporal questions are "query".
 *
 * Run: node stategraph-module/test/classify-task-prompt.test.js
 */

const { CLASSIFY_SYSTEM_PROMPT } = require('../src/utils/classifyTask');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

const P = CLASSIFY_SYSTEM_PROMPT;

// Extract the taskType a few-shot example assigns to a user message.
// Matches lines like:  User: "what time is it" → {"taskType":"query",...}
function exampleTaskType(userText) {
  const re = new RegExp(`User:\\s*"${userText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*→\\s*\\{\\s*"taskType"\\s*:\\s*"([a-z_]+)"`, 'i');
  const m = P.match(re);
  return m ? m[1] : null;
}

// ── Temporal questions → query (answered from injected CURRENT LOCAL TIME) ──
ok(exampleTaskType('what time is it') === 'query', '"what time is it" → query, not local_system');
ok(exampleTaskType('what day is today') === 'query', '"what day is today" → query');
ok(exampleTaskType("what's the date") === 'query', '"what\'s the date" → query');

// ── Real OS probes stay local_system ─────────────────────────────────────────
ok(exampleTaskType('check my disk space') === 'local_system', '"check my disk space" → local_system');
ok(exampleTaskType('how much memory is this process using') === 'local_system', '"how much memory…" → local_system');

// ── Passive screen observation stays query (not local_system) ────────────────
ok(/PASSIVE (SCREEN )?OBSERVATION/i.test(P), 'prompt still teaches passive-observation → query rule');

// ── Every example maps to a declared taskType value ──────────────────────────
const declared = ['local_file', 'local_system', 'app_automation', 'browser', 'messaging', 'scheduling', 'query', 'ambiguous'];
const examples = [...P.matchAll(/User:\s*"[^"]+"\s*→\s*\{\s*"taskType"\s*:\s*"([a-z_]+)"/gi)].map(m => m[1]);
ok(examples.length >= 20, `prompt has ${examples.length} taskType examples (≥20 expected)`);
const bad = examples.filter(t => !declared.includes(t));
ok(bad.length === 0, `all example taskTypes are declared values (bad: ${bad.join(',') || 'none'})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

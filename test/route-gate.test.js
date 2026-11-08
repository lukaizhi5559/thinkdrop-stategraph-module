'use strict';
/**
 * route-gate.test.js — the authoritative route gate in decomposePromptV2.
 *
 * Precedence under test (post-collapse):
 *   1. suggestIntent() table fires → binding (_decomposedBy=route-<rule>)
 *   2. else tc.suggestedIntent binds (_decomposedBy=route-envelope)
 *   3. compounds NEVER bind the envelope (multi-goal keeps decompose path)
 *
 * States reaching the gate return before any LLM call — a stub backend that
 * throws proves the deterministic lane never consults the model.
 *
 * Run: node stategraph-module/test/route-gate.test.js
 */

const decompose = require('../src/nodes/decomposePromptV2.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

const _throwBackend = {
  generateAnswer: async () => { throw new Error('LLM must not be consulted on a bound route'); },
};

const _state = (tc, message, extra = {}) => ({
  message,
  resolvedMessage: message,
  _taskClassification: tc,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  llmBackend: _throwBackend,
  mcpAdapter: { callService: async () => ({}) },
  ...extra,
});

async function main() {
  // 1. Table wins — activity-recall binds memory_retrieve even when the
  //    envelope suggested something else (observed: ar-04 flake, decided
  //    web_search over an envelope+table memory_retrieve verdict).
  let s = await decompose(_state(
    { taskType: 'query', isActivityQuery: true, suggestedIntent: 'web_search' },
    'what were the videos about yesterday'
  ));
  ok(s._decomposedIntent === 'memory_retrieve', 'table beats suggestedIntent — activity-recall → memory_retrieve');
  ok(s._decomposedBy === 'activity-recall', `decomposedBy records table rule (got ${s._decomposedBy})`);
  ok(s.intentPlan?.[0]?.estimatedIntent === 'memory_retrieve', 'intentPlan carries the bound intent');

  // 2. Table wins — public-research binds web_search over an abstaining
  //    envelope (observed: "search for hotels" ran command_automate 3/3 runs).
  s = await decompose(_state(
    { taskType: 'query', webAccessMode: 'public_read', suggestedIntent: null },
    'search for hotels in hong kong'
  ));
  ok(s._decomposedIntent === 'web_search', 'public-research → web_search (no more command_automate misroute)');
  ok(s._decomposedBy === 'public-research', `rule recorded (got ${s._decomposedBy})`);

  // 3. Envelope binds when the table abstains — a suggestedIntent the table
  //    doesn't cover is still authoritative.
  s = await decompose(_state(
    { taskType: 'query', suggestedIntent: 'status_check' },
    'how is the plan doing'
  ));
  ok(s._decomposedIntent === 'status_check', 'suggestedIntent binds on table-abstain');
  ok(s._decomposedBy === 'envelope', `envelope source recorded (got ${s._decomposedBy})`);

  // 4. Compound never binds the envelope — multi-goal prompts keep the
  //    decompose path even when suggestedIntent is set.
  s = await decompose(_state(
    { taskType: 'query', webAccessMode: 'public_read', suggestedIntent: 'web_search' },
    'search for flights and then take a screenshot of the results'
  ));
  ok(s._decomposedBy !== 'envelope',
    `compound prompt does not bind via gate (got ${s._decomposedBy}/${s._decomposedIntent})`);

  // 5. planShape 'complex' also keeps the envelope from binding.
  s = await decompose(_state(
    { taskType: 'query', suggestedIntent: 'web_search', planShape: 'complex' },
    'check the weather then summarize it'
  ));
  ok(s._decomposedBy !== 'envelope', `planShape complex skips envelope bind (got ${s._decomposedBy})`);

  // 6. Generative asks abstain — "help me write a haiku" must not bind
  //    command_automate (observed: local-short-circuit vs general_knowledge).
  s = await decompose(_state(
    { taskType: 'local_file', suggestedIntent: 'command_automate' },
    'help me write a haiku about coffee'
  ));
  ok(s._decomposedBy !== 'route-local-short-circuit' && s._decomposedBy !== 'envelope',
    `generative ask is not force-bound to command_automate (got ${s._decomposedBy}/${s._decomposedIntent})`);

  // 7. Screenshot asks bind command_automate, not screen_display
  //    (observed: table said screen_display, runtime command_automate).
  s = await decompose(_state(
    { taskType: 'local_system', isScreenOutput: true, suggestedIntent: 'command_automate' },
    'take a screenshot'
  ));
  ok(s._decomposedIntent === 'command_automate', 'screenshot → command_automate (not screen_display)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('harness error:', e); process.exit(1); });

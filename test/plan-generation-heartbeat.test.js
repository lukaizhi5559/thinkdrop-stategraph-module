'use strict';

/**
 * Regression for plan generation being invisible to the executor stall
 * watchdog. The wrapper must emit periodic planning progress while the LLM
 * promise is pending and stop emitting once it settles.
 */

const assert = require('assert');
const planSkills = require('../src/nodes/planSkillsV2.js');

(async () => {
  let ticks = 0;
  const value = await planSkills._runWithPlanningHeartbeat(
    new Promise(resolve => setTimeout(() => resolve('plan'), 35)),
    () => { ticks++; },
    10,
  );
  assert.strictEqual(value, 'plan');
  assert(ticks >= 2, `expected at least 2 planning heartbeats, got ${ticks}`);

  const before = ticks;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(ticks, before, 'heartbeat stops after plan promise settles');
  console.log(`plan-generation heartbeat: ${ticks} ticks, passed`);
})().catch(err => {
  console.error(err.stack || err);
  process.exit(1);
});

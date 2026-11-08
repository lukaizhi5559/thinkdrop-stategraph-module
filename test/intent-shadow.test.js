'use strict';
/**
 * intent-shadow.test.js — Stage E shadow verdicts must land in
 * intent-classifier.log as structured JSONL (parser:'intent-shadow'), so the
 * cutover dataset covers the live path regardless of which logger sink the
 * process uses. Electron-log-only sampling missed the comms-graph path that
 * produced task_fb887853.
 *
 * INTENT_LOG_PATH is read at module load — set it before requiring.
 *
 * Run: node --test stategraph-module/test/intent-shadow.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(os.tmpdir(), `intent-shadow-${Date.now()}.log`);
process.env.INTENT_LOG_PATH = LOG;

const { describe, it, after } = require('node:test');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');

function shadowEntries() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(e => e && e.parser === 'intent-shadow');
}

after(() => { try { fs.unlinkSync(LOG); } catch (_) {} });

describe('intent-shadow JSONL verdicts', () => {
  it('writes parser:intent-shadow entry with decided/table/rule/agree', async () => {
    const r = await decomposePromptV2({
      message: 'what videos have i been watch today',
      conversationHistory: [],
      logger: _noopLogger,
      llmBackend: { generateAnswer: async () => { throw new Error('no LLM'); } },
      _taskClassification: { taskType: 'query', isActivityQuery: true, suggestedIntent: 'memory_retrieve' },
    });
    assertEq(r._decomposedIntent, 'memory_retrieve');
    const entries = shadowEntries();
    assert(entries.length >= 1, 'expected ≥1 intent-shadow entry');
    const e = entries[entries.length - 1];
    assertEq(e.decided, 'memory_retrieve');
    assertEq(e.table, 'memory_retrieve');
    assertEq(e.rule, 'activity-recall');
    assertEq(e.agree, true);
    assertEq(e.tc.taskType, 'query');
    assertEq(e.tc.suggestedIntent, 'memory_retrieve');
    assert('ctx' in e, 'entry carries the runtime ctx');
  });

  it('ctx reflects bound sessions — public-research suppression visible', async () => {
    // Bound ext session + in-page follow-up + public_read → table must NOT
    // suggest web_search (the "click the first result" divergence fix).
    const r = await decomposePromptV2({
      message: 'click the first result',
      conversationHistory: [],
      logger: _noopLogger,
      llmBackend: { generateAnswer: async () => '0' },
      _taskClassification: { taskType: 'browser', isFollowUp: true, followUpTarget: 'Amazon page', webAccessMode: 'public_read', suggestedIntent: 'command_automate' },
      _extSessions: [{ sessionId: 'ext:amazon:1', alive: true, url: 'https://www.amazon.com/dp/B123' }],
    });
    const e = shadowEntries().pop();
    assert(e, 'shadow entry written');
    assertEq(e.ctx.boundSession, true);
    assert(e.table !== 'web_search', `table must not suggest web_search on bound in-page follow-up (got ${e.table})`);
  });
});

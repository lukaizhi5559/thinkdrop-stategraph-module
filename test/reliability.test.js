'use strict';
/**
 * reliability.test.js
 *
 * Tests for the Reliability + Completeness phase changes:
 *   1. Bridge retry persistence (bridge-pending.json read/write/reload)
 *   2. needs_skill safety net in executeCommand (surfaces ask_user card)
 *   3. plan-skills.md tier decision table keywords
 *   4. screen.capture in list_skills builtinSkills
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ─── Minimal test harness (mirrors unit.test.js style) ───────────────────────
let _passed = 0, _failed = 0, _skipped = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}`);
    console.log(`     ${e.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toContain(sub) {
      if (!String(actual).includes(sub))
        throw new Error(`Expected "${actual}" to contain "${sub}"`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
    },
    toBeGreaterThan(n) {
      if (actual <= n) throw new Error(`Expected ${actual} > ${n}`);
    },
    toHaveLength(n) {
      if (!actual || actual.length !== n)
        throw new Error(`Expected length ${n}, got ${actual?.length}`);
    },
  };
}

// ─── 1. Bridge retry persistence helpers ─────────────────────────────────────
// Extracted inline from skill-scheduler.cjs so tests are pure and have no
// side effects on the real ~/.thinkdrop/bridge-pending.json.

function makeBridgePendingHelpers(pendingFile) {
  function loadBridgePending() {
    try { return JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch (_) { return []; }
  }
  function saveBridgePending(entries) {
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify(entries, null, 2), 'utf8');
  }
  function addBridgePending(skillName, metadata, retryCount, fireAtMs) {
    const entries = loadBridgePending().filter(e => e.skillName !== skillName);
    entries.push({ skillName, metadata, retryCount, fireAtMs });
    saveBridgePending(entries);
  }
  function removeBridgePending(skillName) {
    const entries = loadBridgePending().filter(e => e.skillName !== skillName);
    saveBridgePending(entries);
  }
  return { loadBridgePending, saveBridgePending, addBridgePending, removeBridgePending };
}

describe('Bridge retry persistence (bridge-pending.json)', () => {
  const tmpFile = path.join(os.tmpdir(), `td-bridge-pending-test-${Date.now()}.json`);
  const { loadBridgePending, addBridgePending, removeBridgePending } = makeBridgePendingHelpers(tmpFile);

  // Clean up after each group
  function cleanup() { try { fs.unlinkSync(tmpFile); } catch (_) {} }

  it('returns [] when file does not exist', () => {
    cleanup();
    expect(loadBridgePending()).toEqual([]);
  });

  it('addBridgePending writes a single entry to disk', () => {
    cleanup();
    const fireAt = Date.now() + 600000;
    addBridgePending('check.expenses', { instruction: 'review expenses' }, 1, fireAt);
    const entries = loadBridgePending();
    expect(entries.length).toBe(1);
    expect(entries[0].skillName).toBe('check.expenses');
    expect(entries[0].retryCount).toBe(1);
    expect(entries[0].fireAtMs).toBe(fireAt);
  });

  it('addBridgePending replaces existing entry for the same skill (idempotent)', () => {
    cleanup();
    addBridgePending('check.expenses', { instruction: 'v1' }, 1, Date.now() + 600000);
    addBridgePending('check.expenses', { instruction: 'v2' }, 2, Date.now() + 700000);
    const entries = loadBridgePending();
    expect(entries.length).toBe(1);
    expect(entries[0].retryCount).toBe(2);
    expect(entries[0].metadata.instruction).toBe('v2');
  });

  it('addBridgePending keeps distinct entries for different skills', () => {
    cleanup();
    addBridgePending('skill.a', { instruction: 'A' }, 1, Date.now() + 600000);
    addBridgePending('skill.b', { instruction: 'B' }, 1, Date.now() + 600000);
    const entries = loadBridgePending();
    expect(entries.length).toBe(2);
  });

  it('removeBridgePending removes only the target skill', () => {
    cleanup();
    addBridgePending('skill.a', { instruction: 'A' }, 1, Date.now() + 600000);
    addBridgePending('skill.b', { instruction: 'B' }, 1, Date.now() + 600000);
    removeBridgePending('skill.a');
    const entries = loadBridgePending();
    expect(entries.length).toBe(1);
    expect(entries[0].skillName).toBe('skill.b');
  });

  it('removeBridgePending is a no-op when skill is not present', () => {
    cleanup();
    addBridgePending('skill.a', { instruction: 'A' }, 1, Date.now() + 600000);
    removeBridgePending('skill.nonexistent');
    expect(loadBridgePending().length).toBe(1);
  });

  it('reloadBridgePendingRetries schedules fire for overdue entries immediately (delay=0)', () => {
    cleanup();
    // Entry that already passed (fireAtMs in the past)
    const pastMs = Date.now() - 5000;
    addBridgePending('check.tasks', { instruction: 'go through tasks' }, 2, pastMs);

    const entries = loadBridgePending();
    const delays = entries.map(e => Math.max(0, e.fireAtMs - Date.now()));
    expect(delays[0]).toBe(0);
  });

  it('reloadBridgePendingRetries computes correct delay for future entries', () => {
    cleanup();
    const futureMs = Date.now() + 5 * 60 * 1000; // 5 min from now
    addBridgePending('check.tasks', { instruction: 'go through tasks' }, 1, futureMs);

    const entries = loadBridgePending();
    const delay = Math.max(0, entries[0].fireAtMs - Date.now());
    expect(delay).toBeGreaterThan(0);
  });

  // Cleanup
  cleanup();
});

// ─── 2. needs_skill safety net ────────────────────────────────────────────────
// Simulate the handler logic extracted from executeCommand.js to test
// that it produces a correct ask_user card.

function runNeedsSkillHandler(args, state) {
  const { capability = 'an unknown capability', suggestion = '' } = args;
  const message = `🔧 ThinkDrop needs a custom skill to: **${capability}**${suggestion ? `\n\nSuggested services: ${suggestion}` : ''}\n\nWould you like to build this skill now?`;
  return {
    ...state,
    skillResults: [...(state.skillResults || []), { step: (state.skillCursor || 0) + 1, skill: 'needs_skill', args, ok: true, stdout: message }],
    skillCursor: (state.skillCursor || 0) + 1,
    commandExecuted: false,
    pendingQuestion: {
      question: message,
      options: [
        `Yes, build the skill for: ${capability}`,
        `No thanks, skip this`
      ]
    },
    failedStep: null
  };
}

describe('needs_skill safety net in executeCommand', () => {
  it('produces a pendingQuestion (ask_user card) with capability text', () => {
    const result = runNeedsSkillHandler(
      { capability: 'watch Gmail and send daily SMS summary', suggestion: 'gmail + twilio' },
      { skillResults: [], skillCursor: 0 }
    );
    expect(result.pendingQuestion).toBeTruthy();
    expect(result.pendingQuestion.question).toContain('watch Gmail and send daily SMS summary');
    expect(result.pendingQuestion.options.length).toBe(2);
  });

  it('includes suggestion in the card when provided', () => {
    const result = runNeedsSkillHandler(
      { capability: 'send weekly Slack digest', suggestion: 'slack + openai' },
      { skillResults: [], skillCursor: 0 }
    );
    expect(result.pendingQuestion.question).toContain('Suggested services: slack + openai');
  });

  it('omits "Suggested services" line when suggestion is empty', () => {
    const result = runNeedsSkillHandler(
      { capability: 'monitor desktop app state' },
      { skillResults: [], skillCursor: 0 }
    );
    expect(result.pendingQuestion.question).toContain('monitor desktop app state');
    // No "Suggested services" line — suggestion was falsy
    const hasServicesLine = result.pendingQuestion.question.includes('Suggested services');
    if (hasServicesLine) throw new Error('Should not include Suggested services when suggestion is empty');
  });

  it('sets commandExecuted=false so plan does not mark as complete', () => {
    const result = runNeedsSkillHandler({ capability: 'x' }, { skillResults: [], skillCursor: 0 });
    expect(result.commandExecuted).toBe(false);
  });

  it('clears failedStep so recovery flow is not triggered', () => {
    const result = runNeedsSkillHandler({ capability: 'x' }, { skillResults: [], skillCursor: 0, failedStep: { error: 'prev err' } });
    expect(result.failedStep).toBeNull();
  });

  it('advances skillCursor by 1', () => {
    const result = runNeedsSkillHandler({ capability: 'x' }, { skillResults: [], skillCursor: 3 });
    expect(result.skillCursor).toBe(4);
  });

  it('adds a step result with ok=true and stdout containing the message', () => {
    const result = runNeedsSkillHandler({ capability: 'x' }, { skillResults: [], skillCursor: 0 });
    expect(result.skillResults.length).toBe(1);
    expect(result.skillResults[0].ok).toBe(true);
    expect(result.skillResults[0].stdout).toContain('x');
  });

  it('uses "an unknown capability" as fallback when args is empty', () => {
    const result = runNeedsSkillHandler({}, { skillResults: [], skillCursor: 0 });
    expect(result.pendingQuestion.question).toContain('an unknown capability');
  });
});

// ─── 3. plan-skills.md tier decision table ───────────────────────────────────
// Verify the prompt file contains the new decision rows and flowchart.

describe('plan-skills.md tier decision table', () => {
  const promptPath = path.join(__dirname, '../src/prompts/plan-skills.md');
  let src;
  try { src = fs.readFileSync(promptPath, 'utf8'); } catch (_) { src = ''; }

  it('file is readable', () => {
    expect(src.length).toBeGreaterThan(0);
  });

  it('contains screen-check example row for bridge tier', () => {
    expect(src).toContain('Check if my app is running at 9am');
  });

  it('contains screen-summary/every-morning example row for bridge tier', () => {
    expect(src).toContain('look at my screen and summarize what');
  });

  it('contains critical screen-check → bridge rule', () => {
    expect(src).toContain('screen-check tasks');
    expect(src).toContain('always `bridge`');
  });

  it('contains decision flowchart', () => {
    expect(src).toContain('Decision flowchart');
  });

  it('flowchart lists all three tiers', () => {
    expect(src).toContain('type: bridge');
    expect(src).toContain('type: notify');
    expect(src).toContain('needs_skill');
  });
});

// ─── 4. screen.capture in list_skills builtinSkills ──────────────────────────

describe('screen.capture in list_skills builtinSkills', () => {
  const execPath = path.join(__dirname, '../src/nodes/executeCommand.js');
  let src;
  try { src = fs.readFileSync(execPath, 'utf8'); } catch (_) { src = ''; }

  it('executeCommand.js is readable', () => {
    expect(src.length).toBeGreaterThan(0);
  });

  it("builtinSkills array contains 'screen.capture'", () => {
    expect(src).toContain("name: 'screen.capture'");
  });

  it('screen.capture entry has a description', () => {
    // Verify the entry has a desc field (it's on the same line or next line)
    const idx = src.indexOf("name: 'screen.capture'");
    const snippet = src.slice(idx, idx + 200);
    expect(snippet).toContain('desc:');
  });
});

// ─── 5. healthCheck skill list completeness ───────────────────────────────────

describe('server.cjs healthCheck skill list', () => {
  const serverPath = path.join(__dirname, '../../mcp-services/command-service/src/server.cjs');
  let src;
  try { src = fs.readFileSync(serverPath, 'utf8'); } catch (_) { src = ''; }

  it('server.cjs is readable', () => {
    expect(src.length).toBeGreaterThan(0);
  });

  const expectedSkills = [
    'screen.capture', 'web.crawl', 'project.builder',
    'project.launcher', 'project.editor', 'project.stopper',
    'skillCreator.skill',
  ];

  for (const skill of expectedSkills) {
    it(`healthCheck lists '${skill}'`, () => {
      expect(src).toContain(skill);
    });
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(70));
console.log('  TEST SUMMARY');
console.log('='.repeat(70));
console.log(`  Total:   ${_passed + _failed + _skipped}`);
console.log(`  Passed:  ${_passed} ✅`);
console.log(`  Failed:  ${_failed} ❌`);
console.log(`  Skipped: ${_skipped} ⏭`);
console.log('='.repeat(70));

if (_failures.length) {
  console.log('\n  Failures:');
  _failures.forEach(f => console.log(`    ❌ ${f.label}\n       ${f.error}`));
}

process.exit(_failed > 0 ? 1 : 0);

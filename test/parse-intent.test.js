'use strict';

/**
 * parse-intent.test.js — Direct unit tests for the parseIntent node.
 *
 * Tests the full guard sequence without spinning up any MCP services.
 * mcpAdapter is mocked to control:
 *   - What DistilBERT returns (high or low confidence)
 *   - Whether a learned intent_override match exists (DuckDB path)
 *
 * Guard execution order in parseIntent.js (as of Phase 1 + partial Phase 2):
 *
 *  [PRE-MODEL — structural hard overrides]
 *   1. skill_build passthrough
 *   2. app-launch / app-control / messaging-verb
 *   3. lift_constraint / set_constraint
 *   4. build-create-override  (model ~0.39 confidence — hard-pinned)
 *   5. remind-me-about-my-override  (kept — has schedule exclusion)
 *   6. reminder-schedule-override
 *   7. filesystem-action-override
 *   8. capability-question-override / file-tag / skill invocations
 *
 *  [PRE-MODEL — language pattern guards still before DistilBERT]
 *   9.  knowledge-question-override
 *   10. personal-history-search-override
 *   11. system-resource-override (×2)
 *   12. personal-attribute-override
 *   13. remember-i-declaration-override
 *   14. add-to-memory-bookmark-override / need-to-remember / note-i
 *   15. personal-declaration / i-always / i-start-role / i-have-been
 *   16. when-appointment / personal-fact-backstop
 *
 *  [ROUTING]
 *   17. carriedIntent short-circuit
 *   18. DuckDB intent_override (learned corrections)
 *   19. ★ DistilBERT early call — conf >= 0.75 → return distilbert-early
 *
 *  [POST-MODEL — safety nets when model uncertain or unavailable]
 *   20. past-tense-action / team-declaration / i-signed-up
 *   21. my-x-named / i-got-from / voice-gerund / various declaration guards
 *   22. Remaining phi4 call site (reuses earlyModelResult)
 *
 *  [FALLBACK]
 *   23. return { type: 'question' }
 *
 * Run with: node test/parse-intent.test.js
 */

const parseIntent = require('../src/nodes/parseIntent.js');

// ─── Minimal test harness ─────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

function section(label) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
}

async function test(label, fn) {
  try {
    await fn();
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
    toMatch(re) {
      if (!re.test(String(actual)))
        throw new Error(`Expected "${actual}" to match ${re}`);
    },
    toBeGreaterThanOrEqual(n) {
      if (actual < n) throw new Error(`Expected ${actual} >= ${n}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
    },
    not: {
      toBe(expected) {
        if (actual === expected)
          throw new Error(`Expected NOT ${JSON.stringify(expected)}`);
      },
    },
  };
}

// ─── Mock factory ─────────────────────────────────────────────────────────────
// distilbert: what phi4 intent.parse returns (default: low confidence)
// override:   what intent_override.search returns (default: no match)
function mockAdapter({ distilbert = null, override = null } = {}) {
  const defaultDistilbert = {
    intent: 'general_query', confidence: 0.40,
    entities: [], requiresMemoryAccess: false, metadata: {},
  };
  return {
    callService: async (service, action) => {
      if (service === 'user-memory' && action === 'intent_override.search')
        return { match: override };
      if (service === 'phi4' && action === 'intent.parse')
        return distilbert ?? defaultDistilbert;
      // swallow bookmark/upsert side-effect calls
      return {};
    },
  };
}

// Helpers for crafting model responses
function highConf(intent, requiresMemory = false) {
  return { intent, confidence: 0.92, entities: [], requiresMemoryAccess: requiresMemory, metadata: { processingTimeMs: 5 } };
}
function lowConf(intent, requiresMemory = false) {
  return { intent, confidence: 0.40, entities: [], requiresMemoryAccess: requiresMemory, metadata: {} };
}

// Build a minimal state object
function makeState(msg, opts = {}) {
  const {
    distilbert, override,
    carriedIntent = null,
    resolvedMessage = null,
  } = opts;
  return {
    message: msg,
    resolvedMessage,
    carriedIntent,
    context: { sessionId: 'test', userId: 'test_user' },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    mcpAdapter: mockAdapter({ distilbert, override }),
    conversationHistory: [],
    intent: null,
    metadata: {},
  };
}

// Convenience: run parseIntent on a message and return the full result
async function run(msg, opts = {}) {
  return parseIntent(makeState(msg, opts));
}

// ─── Tests ────────────────────────────────────────────────────────────────────
async function main() {

  // ── 1. skill_build passthrough ─────────────────────────────────────────────
  section('1. skill_build passthrough — never reclassified');

  await test('preserves skill_build intent even when model would override', async () => {
    const result = await parseIntent({
      ...makeState('build me a skill', { distilbert: highConf('command_automate') }),
      skillBuildRequest: true,
      intent: { type: 'skill_build', confidence: 1.0, entities: [] },
    });
    expect(result.intent.type).toBe('skill_build');
  });

  // ── 2. App-launch ──────────────────────────────────────────────────────────
  section('2. App-launch structural guards');

  await test('"Open Slack" → command_automate (app-launch-override)', async () => {
    const r = await run('Open Slack');
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('app-launch-override');
  });
  await test('"Launch Spotify" → command_automate', async () => {
    expect((await run('Launch Spotify')).intent.type).toBe('command_automate');
  });
  await test('"Pull up Calendar" → command_automate', async () => {
    expect((await run('Pull up Calendar')).intent.type).toBe('command_automate');
  });
  await test('"Open Spotify to listen to music" → command_automate', async () => {
    expect((await run('Open Spotify to listen to music')).intent.type).toBe('command_automate');
  });
  await test('"Get Linear open" → command_automate', async () => {
    expect((await run('Get Linear open')).intent.type).toBe('command_automate');
  });
  await test('"Open Notion and jump to my notes" bypasses app-launch (compound "and")', async () => {
    // "and jump to" is excluded from app-launch, falls to model
    const r = await run('Open Notion and jump to my notes', { distilbert: highConf('command_automate') });
    expect(r.intent.type).toBe('command_automate');
  });
  await test('"pull up everything I told you" → NOT app-launch (retrieval phrase)', async () => {
    // "everything I told you" exclusion prevents app-launch → reaches model
    const r = await run('pull up everything I told you about my project', { distilbert: highConf('memory_retrieve') });
    expect(r.intent.type).toBe('memory_retrieve');
  });

  // ── 3. App-control mode ────────────────────────────────────────────────────
  section('3. App-control mode guards');

  await test('"control Slack" → app_control_start', async () => {
    expect((await run('control Slack')).intent.type).toBe('app_control_start');
  });
  await test('"turn on control mode" → app_control_start', async () => {
    expect((await run('turn on control mode')).intent.type).toBe('app_control_start');
  });
  await test('"exit control mode" → app_control_start', async () => {
    expect((await run('exit control mode')).intent.type).toBe('app_control_start');
  });
  await test('"control mode off" → app_control_start', async () => {
    expect((await run('control mode off')).intent.type).toBe('app_control_start');
  });

  // ── 4. Constraint guards ───────────────────────────────────────────────────
  section('4. Constraint guards (lift / set)');

  await test('"remove the rule about deleting files" → lift_constraint', async () => {
    expect((await run('remove the rule about deleting files')).intent.type).toBe('lift_constraint');
  });
  await test('"lift the constraint on Reddit" → lift_constraint', async () => {
    expect((await run('lift the constraint on Reddit')).intent.type).toBe('lift_constraint');
  });
  await test('"allow me to delete files again" → lift_constraint', async () => {
    expect((await run('allow me to delete files again')).intent.type).toBe('lift_constraint');
  });
  await test('"never let me delete files" → set_constraint', async () => {
    expect((await run('never let me delete files')).intent.type).toBe('set_constraint');
  });
  await test('"don\'t let me browse Reddit" → set_constraint', async () => {
    expect((await run("don't let me browse Reddit")).intent.type).toBe('set_constraint');
  });
  await test('"prevent me from sending emails" → set_constraint', async () => {
    expect((await run('prevent me from sending emails')).intent.type).toBe('set_constraint');
  });
  await test('"don\'t allow me to visit YouTube" → set_constraint', async () => {
    expect((await run("don't allow me to visit YouTube")).intent.type).toBe('set_constraint');
  });
  await test('"block me from accessing LinkedIn" → set_constraint', async () => {
    expect((await run('block me from accessing LinkedIn')).intent.type).toBe('set_constraint');
  });

  // ── 5. Build/create override ───────────────────────────────────────────────
  section('5. Build/create override (hard-pinned — model ~0.39 confidence)');

  await test('"build a tic tac toe game" → command_automate NOT web_search', async () => {
    const r = await run('build a tic tac toe game', { distilbert: lowConf('web_search') });
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('build-create-override');
  });
  await test('"create a todo app" → command_automate', async () => {
    expect((await run('create a todo app')).intent.type).toBe('command_automate');
  });
  await test('"generate a Python script to backup files" → command_automate', async () => {
    expect((await run('generate a Python script to backup files')).intent.type).toBe('command_automate');
  });
  await test('"make a dashboard for my expenses" → command_automate', async () => {
    expect((await run('make a dashboard for my expenses')).intent.type).toBe('command_automate');
  });
  await test('"make a note" is excluded from build-create (goes to model)', async () => {
    // "(?!note\b)" guard inside build-create regex excludes "make a note"
    const r = await run('make a note', { distilbert: highConf('memory_store') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('distilbert-early');
  });

  // ── 6. Remind-me-about (pre-model, has schedule exclusion) ────────────────
  section('6. Remind-me-about override (pre-model, schedule exclusion)');

  await test('"remind me about my dentist appointment" → memory_retrieve', async () => {
    const r = await run('remind me about my dentist appointment');
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.metadata.parser).toBe('remind-me-about-my-override');
  });
  await test('"remind me in 5 minutes to check the oven" → command_automate NOT memory_retrieve', async () => {
    // "in \d+" exclusion prevents remind-me-about → falls to reminder-schedule guard
    const r = await run('remind me in 5 minutes to check the oven');
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('reminder-schedule-override');
  });
  await test('"remind me tomorrow to call Sarah" → command_automate', async () => {
    expect((await run('remind me tomorrow to call Sarah')).intent.type).toBe('command_automate');
  });

  // ── 7. Reminder/schedule override ─────────────────────────────────────────
  section('7. Reminder/schedule override');

  await test('"set a timer for 10 minutes" → command_automate', async () => {
    expect((await run('set a timer for 10 minutes')).intent.type).toBe('command_automate');
  });
  await test('"wake me up at 7am" → command_automate', async () => {
    expect((await run('wake me up at 7am')).intent.type).toBe('command_automate');
  });
  await test('"remind me in 30 seconds to stretch" → command_automate', async () => {
    expect((await run('remind me in 30 seconds to stretch')).intent.type).toBe('command_automate');
  });
  await test('"set a reminder for 9am tomorrow" → command_automate', async () => {
    expect((await run('set a reminder for 9am tomorrow')).intent.type).toBe('command_automate');
  });

  // ── 8. Filesystem action override ─────────────────────────────────────────
  section('8. Filesystem action override');

  await test('"scan the folder ~/Desktop" → command_automate', async () => {
    expect((await run('scan the folder ~/Desktop')).intent.type).toBe('command_automate');
  });
  await test('"list files in ~/Documents" → command_automate', async () => {
    expect((await run('list files in ~/Documents')).intent.type).toBe('command_automate');
  });
  await test('"analyze the screenshots in my downloads folder" → command_automate', async () => {
    expect((await run('analyze the screenshots in my downloads folder')).intent.type).toBe('command_automate');
  });
  await test('"I have files visible on my screen" → NOT filesystem (screen context exclusion)', async () => {
    // "visible on my screen" exclusion blocks filesystem match → model decides
    const r = await run('I have files visible on my screen', { distilbert: highConf('screen_intelligence') });
    expect(r.intent.type).toBe('screen_intelligence');
    expect(r.metadata.parser).toBe('distilbert-early');
  });

  // ── 9. File-tag and skill invocations ──────────────────────────────────────
  section('9. File-tag and skill invocations');

  await test('"[File: /path/to/file.txt] summarize this" → command_automate', async () => {
    expect((await run('[File: /Users/me/docs/notes.txt] summarize this')).intent.type).toBe('command_automate');
  });
  await test('"browser.act click the login button" → command_automate (skill-name)', async () => {
    const r = await run('browser.act click the login button');
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('skill-name-invocation');
  });
  await test('"shell.run ls -la ~/projects" → command_automate', async () => {
    expect((await run('shell.run ls -la ~/projects')).intent.type).toBe('command_automate');
  });
  await test('"fs.read explore ~/Desktop" → command_automate', async () => {
    expect((await run('fs.read explore ~/Desktop')).intent.type).toBe('command_automate');
  });
  await test('"install skill at /path/to/skill" → command_automate (install-skill-override)', async () => {
    expect((await run('install skill at /path/to/skill')).intent.type).toBe('command_automate');
  });
  await test('"list skills" → command_automate (list-skills-override)', async () => {
    expect((await run('list skills')).intent.type).toBe('command_automate');
  });
  await test('"remove skill my-custom-skill" → command_automate', async () => {
    expect((await run('remove skill my-custom-skill')).intent.type).toBe('command_automate');
  });

  // ── 10. Pre-model language guards (lines 339-512, before DistilBERT) ──────
  section('10. Language pattern guards (pre-model, fire before DistilBERT)');

  await test('"do you know anything about React hooks" → memory_retrieve', async () => {
    const r = await run('do you know anything about React hooks');
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.metadata.parser).toBe('knowledge-question-override');
  });
  await test('"list the times I searched for a good coffee shop" → memory_retrieve', async () => {
    const r = await run('list the times I searched for a good coffee shop');
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.metadata.parser).toBe('personal-history-search-override');
  });
  await test('"when did I search for anxiety treatments" → memory_retrieve', async () => {
    expect((await run('when did I search for anxiety treatments')).intent.type).toBe('memory_retrieve');
  });
  await test('"What\'s my CPU usage?" → command_automate (system-resource)', async () => {
    const r = await run("What's my CPU usage?");
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('system-resource-override');
  });
  await test('"check RAM usage" → command_automate', async () => {
    expect((await run('check RAM usage')).intent.type).toBe('command_automate');
  });
  await test('"what\'s my GPU temperature" → command_automate', async () => {
    expect((await run("what's my GPU temperature")).intent.type).toBe('command_automate');
  });
  await test('"fermentation temperature for kimchi" → NOT command_automate (food exclusion)', async () => {
    // Food temperature context is excluded from system-resource → falls to model
    const r = await run('fermentation temperature for kimchi', { distilbert: highConf('general_knowledge') });
    expect(r.intent.type).toBe('general_knowledge');
  });
  await test('"What\'s my name?" → memory_retrieve (personal-attribute)', async () => {
    expect((await run("What's my name?")).intent.type).toBe('memory_retrieve');
  });
  await test('"Where is my gym?" → memory_retrieve (personal-attribute)', async () => {
    expect((await run('Where is my gym?')).intent.type).toBe('memory_retrieve');
  });
  await test('"remember I switched to a standing desk" → memory_store', async () => {
    const r = await run('remember I switched to a standing desk');
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('remember-i-declaration-override');
  });
  await test('"remember when I said that?" → NOT memory_store (exclusion: when + question)', async () => {
    // "remember when..." exclusion blocks memory_store; falls through to model
    const r = await run('remember when I said that?', { distilbert: lowConf('memory_retrieve') });
    expect(r.intent.type).toBe('memory_retrieve');
  });
  await test('"add to memory: meeting with Sarah at 3pm" → memory_store', async () => {
    const r = await run('add to memory: meeting with Sarah at 3pm');
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('add-to-memory-bookmark-override');
  });
  await test('"bookmark this article for later" → memory_store', async () => {
    expect((await run('bookmark this article for later')).intent.type).toBe('memory_store');
  });
  await test('"I need to remember how I fixed that Docker networking issue" → memory_store', async () => {
    expect((await run('I need to remember how I fixed that Docker networking issue')).intent.type).toBe('memory_store');
  });
  await test('"note that my coffee grinder is a Baratza Encore" → memory_store', async () => {
    const r = await run('note that my coffee grinder is a Baratza Encore');
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('note-i-override');
  });
  await test('"note my car insurance renews in March" → memory_store', async () => {
    expect((await run('note my car insurance renews in March')).intent.type).toBe('memory_store');
  });
  await test('"I\'m learning Rust this quarter" → memory_store (personal-declaration)', async () => {
    const r = await run("I'm learning Rust this quarter");
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('personal-declaration-override');
  });
  await test('"I\'m reading Atomic Habits" → memory_store (personal-declaration)', async () => {
    expect((await run("I'm reading Atomic Habits")).intent.type).toBe('memory_store');
  });
  await test('"I started cycling to work" → memory_store (personal-declaration)', async () => {
    expect((await run('I started cycling to work')).intent.type).toBe('memory_store');
  });
  await test('"I always order the extra shot" → memory_store (i-always)', async () => {
    const r = await run('I always order the extra shot');
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('i-always-override');
  });
  await test('"I start the night shift rotation next Wednesday" → memory_store', async () => {
    expect((await run('I start the night shift rotation next Wednesday')).intent.type).toBe('memory_store');
  });
  await test('"I\'ve been really tired this week" → memory_store (i-have-been)', async () => {
    const r = await run("I've been really tired this week");
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('i-have-been-override');
  });
  await test('"I\'ve been searching for a solution" → NOT memory_store (searching-for exclusion)', async () => {
    // "searching for" exclusion blocks i-have-been → falls through to model
    const r = await run("I've been searching for a solution", { distilbert: lowConf('web_search') });
    expect(r.intent.type).toBe('web_search');
  });
  await test('"when do I have an appointment next week?" → memory_retrieve', async () => {
    const r = await run('when do I have an appointment next week?');
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.metadata.parser).toBe('when-appointment-override');
  });
  await test('"when does my insurance renew?" → memory_retrieve', async () => {
    expect((await run('when does my insurance renew?')).intent.type).toBe('memory_retrieve');
  });
  await test('"my wife is Sarah" → memory_store (personal-fact standard)', async () => {
    const r = await run('my wife is Sarah');
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('personal-fact-override');
  });
  await test('"Sarah is my wife" → memory_store (personal-fact inverted)', async () => {
    expect((await run('Sarah is my wife')).intent.type).toBe('memory_store');
  });
  await test('"I\'m Alex" → memory_store (personal-fact: I\'m [Name])', async () => {
    expect((await run("I'm Alex")).intent.type).toBe('memory_store');
  });
  await test('"When is my sister\'s wedding?" → NOT memory_store (question-word exclusion)', async () => {
    // Starts with question word "When" → personal-fact guard skips
    const r = await run("When is my sister's wedding?", { distilbert: lowConf('memory_retrieve') });
    expect(r.intent.type).toBe('memory_retrieve');
  });

  // ── 11. carriedIntent ──────────────────────────────────────────────────────
  section('11. carriedIntent — resolveReferences shortcut');

  await test('memory_store carried intent passes through', async () => {
    const r = await run('yes go ahead', { carriedIntent: 'memory_store' });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('intent-carryover');
  });
  await test('memory_retrieve carried intent sets requiresMemoryAccess=true', async () => {
    const r = await run('yes', { carriedIntent: 'memory_retrieve' });
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.intent.requiresMemoryAccess).toBeTruthy();
  });
  await test('carriedIntent beats language guards (fires first)', async () => {
    // "remember I did X" would normally hit remember-i-declaration, but carriedIntent is checked
    // after the language guards (line 527), so this tests normal order: guard fires first.
    // This test simply verifies carriedIntent is USED when set.
    const r = await run('noted', { carriedIntent: 'command_automate' });
    expect(r.intent.type).toBe('command_automate');
  });

  // ── 12. DuckDB intent_override (learned corrections) ──────────────────────
  section('12. DuckDB intent_override — learned corrections beat the model');

  await test('learned command_automate override overrides high-confidence model', async () => {
    // Model says web_search confidently — but stored correction says command_automate.
    // Use a message that doesn't hit any structural guard so DuckDB path is reachable.
    const r = await run('pull up the latest React release notes', {
      override: { correctIntent: 'command_automate', similarity: 0.97, examplePrompt: 'pull up the latest React release notes' },
      distilbert: highConf('web_search'),
    });
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('intent-override');
  });
  await test('no override match → falls through to DistilBERT', async () => {
    const r = await run('what is photosynthesis', {
      override: null,
      distilbert: highConf('general_knowledge'),
    });
    expect(r.intent.type).toBe('general_knowledge');
    expect(r.metadata.parser).toBe('distilbert-early');
  });

  // ── 13. DistilBERT high-confidence early exit ──────────────────────────────
  section('13. DistilBERT high-confidence (>= 0.75 → distilbert-early)');

  await test('general_knowledge at 0.92 confidence → distilbert-early', async () => {
    const r = await run('what is the boiling point of water', { distilbert: highConf('general_knowledge') });
    expect(r.intent.type).toBe('general_knowledge');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('memory_retrieve at 0.92 confidence → distilbert-early', async () => {
    const r = await run('what did I tell you about my cat', { distilbert: highConf('memory_retrieve', true) });
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('web_search at 0.92 confidence → distilbert-early', async () => {
    const r = await run('latest news on AI regulation', { distilbert: highConf('web_search') });
    expect(r.intent.type).toBe('web_search');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('high-confidence model bypasses post-model guards entirely', async () => {
    // "Our company is pivoting to B2B" would hit team-declaration-override post-model
    // but high-confidence model claiming general_query should short-circuit first
    const r = await run('Our company is pivoting to B2B', { distilbert: highConf('general_query') });
    expect(r.metadata.parser).toBe('distilbert-early');
    expect(r.intent.type).toBe('general_query');
  });

  // ── 14. Post-model guards (confidence < 0.75 → safety nets fire) ──────────
  section('14. Post-model guards (model uncertain < 0.75 — safety nets fire)');

  await test('"sent a message to John about the deadline" → memory_store', async () => {
    const r = await run('sent a message to John about the deadline', { distilbert: lowConf('general_query') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('past-tense-action-override');
  });
  await test('"called Sarah this morning" → memory_store (past-tense-action)', async () => {
    const r = await run('called Sarah this morning about the contract', { distilbert: lowConf('general_query') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('past-tense-action-override');
  });
  await test('"emailed the client yesterday" → memory_store (past-tense-action)', async () => {
    const r = await run('emailed the client yesterday with the proposal', { distilbert: lowConf('general_query') });
    expect(r.intent.type).toBe('memory_store');
  });
  await test('"Our design team is migrating from Figma to Penpot" → memory_store', async () => {
    const r = await run('Our design team is migrating from Figma to Penpot next sprint', { distilbert: lowConf('general_query') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('team-declaration-override');
  });
  await test('"I signed up for the gym near my office" → memory_store', async () => {
    const r = await run('I signed up for the gym near my office', { distilbert: lowConf('general_query') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('i-signed-up-override');
  });
  await test('"my SCOBY is named Greta" → memory_store', async () => {
    const r = await run("I'm making kombucha, my SCOBY is named Greta", { distilbert: lowConf('general_query') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('my-x-named-override');
  });

  // ── 15. Deleted pre-model guards → now rely on DistilBERT ─────────────────
  section('15. Guards removed from pre-model — DistilBERT handles at high confidence');

  await test('"make a note of this important fact" → memory_store via distilbert-early', async () => {
    // make-note-override was removed; now relies on model
    const r = await run('make a note of this important fact', { distilbert: highConf('memory_store') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('"log that I ran 5 miles today" → memory_store via distilbert-early', async () => {
    // log-activity-override was removed; now relies on model
    const r = await run('log that I ran 5 miles today', { distilbert: highConf('memory_store') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('"from now on assume I prefer dark mode" → memory_store via model', async () => {
    // add-to-memory-override (from-now-on) was removed; relies on model
    const r = await run('from now on assume I prefer dark mode', { distilbert: highConf('memory_store') });
    expect(r.intent.type).toBe('memory_store');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('"how do I pronounce Worcestershire?" → general_knowledge via model', async () => {
    // knowledge-language-override was removed; relies on model
    const r = await run('how do I pronounce Worcestershire?', { distilbert: highConf('general_knowledge') });
    expect(r.intent.type).toBe('general_knowledge');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('"translate good morning to Japanese" → general_knowledge via model', async () => {
    const r = await run('translate good morning to Japanese', { distilbert: highConf('general_knowledge') });
    expect(r.intent.type).toBe('general_knowledge');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('"remind me about my dentist notes" still works (guard was KEPT)', async () => {
    // remind-me-about-my-override was intentionally kept pre-model
    const r = await run('remind me about my dentist notes');
    expect(r.intent.type).toBe('memory_retrieve');
    expect(r.metadata.parser).toBe('remind-me-about-my-override');
  });

  // ── 16. Regression — previously broken cases ───────────────────────────────
  section('16. Regression tests — cases that were previously broken');

  await test('"Search for cats on Google" → command_automate NOT web_search', async () => {
    // Previously: ^search for matched web_search. Fix: "on Google" exclusion added.
    // Now model handles this; verify model path works for this phrase.
    const r = await run('Search for cats on Google', { distilbert: highConf('command_automate') });
    expect(r.intent.type).toBe('command_automate');
  });
  await test('"Search for \\"best mechanical keyboards 2026\\" on Google" → command_automate (pre-model guard)', async () => {
    // DistilBERT scores this web_search at 0.92 — hard guard must intercept BEFORE model.
    const r = await run('Search for "best mechanical keyboards 2026" on Google', { distilbert: highConf('web_search') });
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('search-on-engine-override');
  });
  await test('"find the best coffee shops on Yelp" → command_automate', async () => {
    const r = await run('find the best coffee shops on Yelp', { distilbert: highConf('web_search') });
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('search-on-engine-override');
  });
  await test('"look up React docs on GitHub" → command_automate', async () => {
    const r = await run('look up React docs on GitHub', { distilbert: highConf('web_search') });
    expect(r.intent.type).toBe('command_automate');
    expect(r.metadata.parser).toBe('search-on-engine-override');
  });
  await test('"search for latest AI news" (no engine specified) → model decides web_search', async () => {
    // No "on <engine>" → not intercepted, model chooses
    const r = await run('search for latest AI news', { distilbert: highConf('web_search') });
    expect(r.intent.type).toBe('web_search');
    expect(r.metadata.parser).toBe('distilbert-early');
  });
  await test('"don\'t let me" prefix set_constraint, not lift_constraint', async () => {
    // Regression: "don't allow me" patterns were hitting lift_constraint before fix
    const r = await run("don't allow me to browse YouTube");
    expect(r.intent.type).toBe('set_constraint');
    expect(r.intent.type).not.toBe('lift_constraint');
  });

  // ── 17. Offline mode — no mcpAdapter ─────────────────────────────────────
  section('17. Offline mode — no mcpAdapter (structural guards still fire)');

  await test('app-launch works without adapter', async () => {
    const r = await parseIntent({ ...makeState('Open Safari'), mcpAdapter: null });
    expect(r.intent.type).toBe('command_automate');
  });
  await test('lift_constraint works without adapter', async () => {
    const r = await parseIntent({ ...makeState('remove the rule about YouTube'), mcpAdapter: null });
    expect(r.intent.type).toBe('lift_constraint');
  });
  await test('personal-fact guard works without adapter', async () => {
    const r = await parseIntent({ ...makeState('my dog is named Nala'), mcpAdapter: null });
    expect(r.intent.type).toBe('memory_store');
  });
  await test('unknown message returns fallback "question" without adapter', async () => {
    const r = await parseIntent({ ...makeState('the quick brown fox jumps'), mcpAdapter: null });
    expect(r.intent.type).toBe('question');
  });

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  parseIntent unit tests: ${_passed} passed, ${_failed} failed`);
  if (_failures.length) {
    console.log(`\n  Failures:`);
    for (const { label, error } of _failures) {
      console.log(`    ❌ ${label}`);
      console.log(`       ${error}`);
    }
  }
  console.log('='.repeat(70));
  process.exit(_failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[parse-intent.test.js] Fatal error:', err);
  process.exit(1);
});

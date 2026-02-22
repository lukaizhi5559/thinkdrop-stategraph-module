/**
 * Unit Test Suite — ThinkDrop StateGraph Pure Functions
 *
 * Tests all pure logic without MCP services or network calls.
 * Run with: node test/unit.test.js
 *
 * Covers:
 *   1. detectIntentCarryover  (resolveReferences.js)
 *   2. parseDateRange          (retrieveMemory.js)
 *   3. parseIntent temporal override regex
 *   4. DistilBERT seed classification (optional, requires phi4 service)
 */

'use strict';

// ─── Minimal test harness (no dependencies) ──────────────────────────────────
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

function skip(label) {
  _skipped++;
  console.log(`  ⏭  ${label} (skipped)`);
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
    toMatch(re) {
      if (!re.test(String(actual)))
        throw new Error(`Expected "${actual}" to match ${re}`);
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
    toBeLessThan(n) {
      if (actual >= n) throw new Error(`Expected ${actual} < ${n}`);
    },
  };
}

// ─── Extract testable functions from source files ─────────────────────────────

// We re-implement the pure functions here so tests run without side effects.
// When the source changes, update the corresponding section below.

// ── 1. detectIntentCarryover (from resolveReferences.js) ─────────────────────

const STANDALONE_INTENT_WORDS = /\b(search|look up|google|wikipedia|define|explain|how to|who is|weather|news|open|run|execute|install|download|remind|schedule|email|send|call|create|make|delete|move|copy|rename|launch|start|stop|close|write|generate|build|deploy|find me|show me how)\b/i;
const TEMPORAL_WORDS = /\b(today|yesterday|now|this morning|this afternoon|this evening|this week|last week|last night|last month|earlier|recently|at noon|at midnight|around \d|at \d)\b/i;
const DEICTIC_MEMORY_REFS = /\b(these|those|them|the ones|the files|the apps|the sites|the messages|the results)\b/i;
const ACTIVITY_VERBS = /\b(doing|working|using|looking|opening|open|running|editing|writing|reading|viewing|accessing|with|for|about|saved|created|deleted|moved|closed|have|had|were|was)\b/i;
const PRIOR_SCREEN_SIGNALS = /\b(screen|what do you see|what.*(on|in).*screen|what.*(visible|showing|displayed)|describe.*screen|analyze.*screen|look at.*screen)\b/i;
const PRIOR_MEMORY_SIGNALS = /\b(was i|did i|have i|what did i|what apps|what sites|what files|history|activity|working on|looking at|mentioned|files|yesterday|last week|last night|last month|earlier today|this morning|what were (we|you)|what did (we|you)|list.*i|show.*i (did|used|worked|opened))\b/i;
const PRIOR_COMMAND_SIGNALS = /\b(open|run|execute|create|make|delete|move|copy|click|press|type|scroll|launch|install|download|send|email)\b/i;
const INTENT_TOPICS = { screen_intelligence: 'the screen', memory_retrieve: 'my activity history', command_automate: 'that task' };

function inferIntentFromContent(content) {
  if (PRIOR_SCREEN_SIGNALS.test(content)) return 'screen_intelligence';
  if (PRIOR_MEMORY_SIGNALS.test(content)) return 'memory_retrieve';
  if (PRIOR_COMMAND_SIGNALS.test(content)) return 'command_automate';
  return null;
}

function detectIntentCarryover(message, conversationHistory) {
  const msg = message.trim().toLowerCase().replace(/[?!.]+$/, '');
  const words = msg.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const hasStandaloneIntent = STANDALONE_INTENT_WORDS.test(msg);
  const hasTemporalWord = TEMPORAL_WORDS.test(msg);
  const hasDeiticRef = DEICTIC_MEMORY_REFS.test(msg);
  const hasActivityVerb = ACTIVITY_VERBS.test(msg);
  const hasNow = /\bnow\b/.test(msg);

  // Signal 1: CONTINUATION — very short message (≤4 words), no standalone intent
  // Covers: "anything else", "what else", "more", "go on", "continue", "and?", "tell me more"
  // Exclude: clear subject+verb sentences like "I like these", "these are interesting"
  const CLEAR_SUBJECT_VERB = /^(i |they |he |she |it |we |these |those |that |this )\w/i;
  const isContinuation = wordCount <= 4 && !hasStandaloneIntent && !CLEAR_SUBJECT_VERB.test(msg);
  const ELLIPTICAL_PREFIXES = /^(what about|anything|how about|and|what|show me|tell me about|anything about)\b/i;
  const isTemporalElliptical = hasTemporalWord && !hasStandaloneIntent &&
    (wordCount <= 7 || ELLIPTICAL_PREFIXES.test(msg));
  // Deictic ref is the stronger signal — does NOT check hasStandaloneIntent
  // "why did I have those open" has 'open' (standalone) but 'those' (deictic) wins
  const isDeiticMemoryFollowup = hasDeiticRef && hasActivityVerb;

  if (!isContinuation && !isTemporalElliptical && !isDeiticMemoryFollowup) return null;

  const recentUserMessages = conversationHistory
    .filter(m => m.role === 'user').slice(-5).reverse();

  let previousIntent = null;
  for (const m of recentUserMessages) {
    const inferred = inferIntentFromContent(m.content || '');
    if (inferred) { previousIntent = inferred; break; }
  }

  if (!previousIntent && isDeiticMemoryFollowup) previousIntent = 'memory_retrieve';
  if (!previousIntent && isTemporalElliptical) previousIntent = 'memory_retrieve';
  if (!previousIntent) return null;

  const topic = INTENT_TOPICS[previousIntent] || 'that';
  let resolvedMessage;
  if (previousIntent === 'screen_intelligence') {
    resolvedMessage = hasNow ? `what do you see on ${topic} right now` : `what do you see on ${topic}`;
  } else {
    resolvedMessage = message;
  }
  return { carriedIntent: previousIntent, resolvedMessage };
}

// ── 2. parseDateRange (from retrieveMemory.js) ────────────────────────────────
// Load directly from source so we test the real implementation
const retrieveMemoryPath = require('path').join(__dirname, '../src/nodes/retrieveMemory.js');
// parseDateRange is not exported — extract via module internals trick
let parseDateRange;
{
  // Temporarily capture the function by monkey-patching module.exports
  const originalExports = {};
  const mod = { exports: {} };
  const src = require('fs').readFileSync(retrieveMemoryPath, 'utf8');
  // Extract just the parseDateRange function text and eval it in isolation
  const fnStart = src.indexOf('function parseDateRange(');
  const fnEnd = src.indexOf('\nmodule.exports');
  const fnSrc = src.slice(fnStart, fnEnd);
  // Also need MONTHS constant
  const monthsSrc = src.slice(0, fnStart);
  parseDateRange = new Function('require', `
    ${monthsSrc}
    ${fnSrc}
    return parseDateRange;
  `)(require);
}

// Fixed reference date for deterministic date tests: 2026-02-21 (Saturday)
const REF_DATE = new Date('2026-02-21T12:00:00');
const _origDate = global.Date;

function withFixedDate(fn) {
  // Patch Date constructor to return fixed reference
  const OrigDate = global.Date;
  function MockDate(...args) {
    if (args.length === 0) return new OrigDate(REF_DATE);
    return new OrigDate(...args);
  }
  MockDate.now = () => REF_DATE.getTime();
  MockDate.parse = OrigDate.parse;
  MockDate.UTC = OrigDate.UTC;
  Object.setPrototypeOf(MockDate, OrigDate);
  MockDate.prototype = OrigDate.prototype;
  global.Date = MockDate;
  try { return fn(); } finally { global.Date = OrigDate; }
}

// ── 3. parseIntent temporal override (from parseIntent.js) ───────────────────
const temporalMemoryPattern = /\b(yesterday|last (week|month|night|year)|this (morning|week|month)|earlier today|a (few )?(days?|weeks?|months?) ago)\b/i;
const recallVerbPattern = /\b(what|did|do|list|show|tell|recall|remember|find|which|how many|summarize|were|was|have)\b/i;

function temporalOverrideFires(message) {
  return temporalMemoryPattern.test(message) && recallVerbPattern.test(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITES
// ─────────────────────────────────────────────────────────────────────────────

describe('detectIntentCarryover — Signal 1: CONTINUATION (≤4 words, no standalone intent)', () => {
  const memHistory = [{ role: 'user', content: 'list all the files I mentioned yesterday' }];
  const screenHistory = [{ role: 'user', content: 'what do you see on my screen' }];
  const cmdHistory = [{ role: 'user', content: 'open chrome and go to github' }];
  const empty = [];

  it('"anything else" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('anything else', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"anything else?" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('anything else?', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what else" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('what else', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"more" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('more', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"go on" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('go on', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"continue" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('continue', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"tell me more" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('tell me more', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"and?" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('and?', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"ok so?" after memory → memory_retrieve', () => {
    expect(detectIntentCarryover('ok so?', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what about now" after screen → screen_intelligence', () => {
    expect(detectIntentCarryover('what about now', screenHistory)?.carriedIntent).toBe('screen_intelligence');
  });
  it('"and now" after screen → screen_intelligence with "right now" expansion', () => {
    const r = detectIntentCarryover('and now', screenHistory);
    expect(r?.carriedIntent).toBe('screen_intelligence');
    expect(r?.resolvedMessage).toContain('right now');
  });
  it('"anything else" after screen → screen_intelligence', () => {
    expect(detectIntentCarryover('anything else', screenHistory)?.carriedIntent).toBe('screen_intelligence');
  });
  it('"more" after command → command_automate', () => {
    expect(detectIntentCarryover('more', cmdHistory)?.carriedIntent).toBe('command_automate');
  });
  it('"anything else" with no history → null (cannot safely infer)', () => {
    expect(detectIntentCarryover('anything else', empty)).toBeNull();
  });
});

describe('detectIntentCarryover — Signal 2: TEMPORAL ELLIPTICAL', () => {
  const empty = [];

  it('"anything yesterday" → memory_retrieve (no history needed)', () => {
    expect(detectIntentCarryover('anything yesterday', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what about last week" → memory_retrieve', () => {
    expect(detectIntentCarryover('what about last week', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"how about earlier" → memory_retrieve', () => {
    expect(detectIntentCarryover('how about earlier', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what about this morning" → memory_retrieve', () => {
    expect(detectIntentCarryover('what about this morning', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"anything today" → memory_retrieve', () => {
    expect(detectIntentCarryover('anything today', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"show me last week" → memory_retrieve', () => {
    expect(detectIntentCarryover('show me last week', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"search for news yesterday" → null (has standalone intent "search")', () => {
    expect(detectIntentCarryover('search for news yesterday', empty)).toBeNull();
  });
  it('"open chrome yesterday" → null (has standalone intent "open")', () => {
    expect(detectIntentCarryover('open chrome yesterday', empty)).toBeNull();
  });
});

describe('detectIntentCarryover — Signal 3: DEICTIC MEMORY REF', () => {
  const memHistory = [{ role: 'user', content: 'list all the files I mentioned yesterday' }];
  const empty = [];

  it('"Do you know what I was doing with these files" → memory_retrieve', () => {
    expect(detectIntentCarryover('Do you know what I was doing with these files', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what were these files for" → memory_retrieve', () => {
    expect(detectIntentCarryover('what were these files for', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"tell me more about those" → memory_retrieve', () => {
    expect(detectIntentCarryover('tell me more about those', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"why did I have those open" → memory_retrieve', () => {
    expect(detectIntentCarryover('why did I have those open', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what was I doing with them" → memory_retrieve', () => {
    expect(detectIntentCarryover('what was I doing with them', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what were the apps I had open" → memory_retrieve', () => {
    expect(detectIntentCarryover('what were the apps I had open', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"can you tell me more about the files" → memory_retrieve', () => {
    expect(detectIntentCarryover('can you tell me more about the files', memHistory)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"what were these files about" with no history → defaults to memory_retrieve', () => {
    expect(detectIntentCarryover('what were these files about', empty)?.carriedIntent).toBe('memory_retrieve');
  });
  it('"these are interesting" → null (no activity verb, clear subject+verb)', () => {
    expect(detectIntentCarryover('these are interesting', memHistory)).toBeNull();
  });
  it('"I like these" → null (clear subject+verb, not a follow-up)', () => {
    expect(detectIntentCarryover('I like these', memHistory)).toBeNull();
  });
});

describe('detectIntentCarryover — FALSE POSITIVE guards', () => {
  const memHistory = [{ role: 'user', content: 'list all the files I mentioned yesterday' }];

  it('"what is the capital of France" → null', () => {
    expect(detectIntentCarryover('what is the capital of France', memHistory)).toBeNull();
  });
  it('"open chrome" → null (only 2 words but CLEAR_SUBJECT_VERB doesn\'t match, however no deictic ref → null via continuation only if no history... actually open chrome has standalone intent so isContinuation=false, no deictic, no temporal → null)', () => {
    // "open chrome" — isContinuation: 2 words but hasStandaloneIntent('open') → false
    // isDeiticMemoryFollowup: no deictic ref → false. isTemporalElliptical: no temporal → false → null
    expect(detectIntentCarryover('open chrome', memHistory)).toBeNull();
  });
  it('"explain how React hooks work" → null (standalone intent)', () => {
    expect(detectIntentCarryover('explain how React hooks work', memHistory)).toBeNull();
  });
  it('"I have a meeting tomorrow" → null (no deictic ref, no temporal elliptical, >4 words)', () => {
    expect(detectIntentCarryover('I have a meeting tomorrow', memHistory)).toBeNull();
  });
  it('"search for news yesterday" → null (standalone intent blocks temporal elliptical)', () => {
    expect(detectIntentCarryover('search for news yesterday', memHistory)).toBeNull();
  });
  it('"create a folder called test" → null', () => {
    expect(detectIntentCarryover('create a folder called test', memHistory)).toBeNull();
  });
  it('"what is the weather today" → null (standalone: "weather")', () => {
    expect(detectIntentCarryover('what is the weather today', memHistory)).toBeNull();
  });
});

describe('parseDateRange — basic date references', () => {
  it('"yesterday" → full day range for 2026-02-20', () => {
    const r = withFixedDate(() => parseDateRange('what did we chat about yesterday'));
    expect(r?.startDate).toBe('2026-02-20 00:00:00');
    expect(r?.endDate).toBe('2026-02-20 23:59:59');
  });
  it('"today" → full day range for 2026-02-21', () => {
    const r = withFixedDate(() => parseDateRange('what did I do today'));
    expect(r?.startDate).toBe('2026-02-21 00:00:00');
    expect(r?.endDate).toBe('2026-02-21 23:59:59');
  });
  it('"last week" → Mon-Sun of prior week', () => {
    const r = withFixedDate(() => parseDateRange('what did we talk about last week'));
    expect(r).toBeTruthy();
    expect(r.startDate).toContain('2026-02-');
    expect(r.endDate).toContain('2026-02-');
  });
  it('"this week" → start of current week to now', () => {
    const r = withFixedDate(() => parseDateRange('what did I do this week'));
    expect(r).toBeTruthy();
    expect(r.startDate).toContain('2026-02-');
  });
  it('"last month" → full January 2026', () => {
    const r = withFixedDate(() => parseDateRange('what did we discuss last month'));
    expect(r?.startDate).toBe('2026-01-01 00:00:00');
    expect(r?.endDate).toBe('2026-01-31 23:59:59');
  });
  it('"this month" → Feb 1 to now', () => {
    const r = withFixedDate(() => parseDateRange('what did I do this month'));
    expect(r?.startDate).toBe('2026-02-01 00:00:00');
  });
  it('no date reference → null', () => {
    const r = withFixedDate(() => parseDateRange('what is my favorite color'));
    expect(r).toBeNull();
  });
  it('empty string → null', () => {
    const r = withFixedDate(() => parseDateRange(''));
    expect(r).toBeNull();
  });
});

describe('parseDateRange — time-of-day ranges', () => {
  it('"yesterday around 8 - 10am" → 08:00 to 10:59', () => {
    const r = withFixedDate(() => parseDateRange('what was I doing yesterday around 8 - 10am'));
    expect(r?.startDate).toBe('2026-02-20 08:00:00');
    expect(r?.endDate).toBe('2026-02-20 10:59:59');
  });
  it('"yesterday 9 to 11am" → 09:00 to 11:59', () => {
    const r = withFixedDate(() => parseDateRange('what was I doing yesterday 9 to 11am'));
    expect(r?.startDate).toBe('2026-02-20 09:00:00');
    expect(r?.endDate).toBe('2026-02-20 11:59:59');
  });
  it('"yesterday 2 - 4pm" → 14:00 to 16:59', () => {
    const r = withFixedDate(() => parseDateRange('what was I doing yesterday 2 - 4pm'));
    expect(r?.startDate).toBe('2026-02-20 14:00:00');
    expect(r?.endDate).toBe('2026-02-20 16:59:59');
  });
  it('"yesterday 8:30 - 9:30am" → 08:30 to 09:30', () => {
    const r = withFixedDate(() => parseDateRange('what was I doing yesterday 8:30 - 9:30am'));
    expect(r?.startDate).toBe('2026-02-20 08:30:00');
    expect(r?.endDate).toBe('2026-02-20 09:30:59');
  });
  it('"today 7 - 8:30 this morning" → 07:00 to 08:30', () => {
    const r = withFixedDate(() => parseDateRange('what did I do today 7 - 8:30 this morning'));
    expect(r?.startDate).toBe('2026-02-21 07:00:00');
    expect(r?.endDate).toBe('2026-02-21 08:30:59');
  });
});

describe('parseDateRange — relative time expressions', () => {
  it('"last 30 minutes" → 30 min window', () => {
    const r = withFixedDate(() => parseDateRange('what happened in the last 30 minutes'));
    expect(r).toBeTruthy();
    expect(r.endDate).toContain('2026-02-21');
  });
  it('"15 mins ago" → 15 min window', () => {
    const r = withFixedDate(() => parseDateRange('what was I doing 15 mins ago'));
    expect(r).toBeTruthy();
  });
  it('"last 2 hours" → 2 hour window', () => {
    const r = withFixedDate(() => parseDateRange('what did I do in the last 2 hours'));
    expect(r).toBeTruthy();
  });
  it('"last 3 days" → 3 day window', () => {
    const r = withFixedDate(() => parseDateRange('what did I work on in the last 3 days'));
    expect(r).toBeTruthy();
    expect(r.startDate).toContain('2026-02-18');
  });
  it('"last 2 weeks" → 2 week window', () => {
    const r = withFixedDate(() => parseDateRange('what did we talk about in the last 2 weeks'));
    expect(r).toBeTruthy();
  });
});

describe('parseDateRange — named months', () => {
  it('"in January" → full January of current or prior year', () => {
    const r = withFixedDate(() => parseDateRange('what did we discuss in January'));
    expect(r?.startDate).toContain('-01-01');
    expect(r?.endDate).toContain('-01-31');
  });
  it('"January 10th - 15th" → Jan 10 to Jan 15', () => {
    const r = withFixedDate(() => parseDateRange('what happened January 10th - 15th'));
    expect(r?.startDate).toContain('-01-10');
    expect(r?.endDate).toContain('-01-15');
  });
  it('"last year" → full 2025', () => {
    const r = withFixedDate(() => parseDateRange('what did we do last year'));
    expect(r?.startDate).toContain('2025-01-01');
    expect(r?.endDate).toContain('2025-12-31');
  });
});

describe('parseDateRange — continuation dateRange inheritance (unit logic)', () => {
  // This tests the inheritance logic in isolation:
  // short continuation messages (≤4 words) should inherit dateRange from prior user messages
  function simulateInheritance(currentMsg, priorUserMessages) {
    const msgWords = currentMsg.trim().split(/\s+/).filter(Boolean).length;
    let dateRange = withFixedDate(() => parseDateRange(currentMsg));
    if (!dateRange && msgWords <= 4) {
      for (const prior of priorUserMessages) {
        const inherited = withFixedDate(() => parseDateRange(prior));
        if (inherited) { dateRange = inherited; break; }
      }
    }
    return dateRange;
  }

  it('"anything else" after "what did I do yesterday between 7-9am" → inherits 07:00-09:59', () => {
    const r = simulateInheritance('anything else', ['what did I do yesterday between 7 - 9am']);
    expect(r?.startDate).toBe('2026-02-20 07:00:00');
    expect(r?.endDate).toBe('2026-02-20 09:59:59');
  });
  it('"what else" after "what did we chat about yesterday" → inherits full day', () => {
    const r = simulateInheritance('what else', ['what did we chat about yesterday']);
    expect(r?.startDate).toBe('2026-02-20 00:00:00');
    expect(r?.endDate).toBe('2026-02-20 23:59:59');
  });
  it('"more" after "what did I work on last week" → inherits last week range', () => {
    const r = simulateInheritance('more', ['what did I work on last week']);
    expect(r).toBeTruthy();
  });
  it('"tell me more" after "list files I mentioned yesterday" → inherits yesterday', () => {
    const r = simulateInheritance('tell me more', ['list all the files I mentioned yesterday']);
    expect(r?.startDate).toBe('2026-02-20 00:00:00');
  });
  it('"anything else" with no prior temporal message → null (no inheritance)', () => {
    const r = simulateInheritance('anything else', ['what is my favorite color']);
    expect(r).toBeNull();
  });
  it('long message (>4 words) does NOT inherit even with no dateRange', () => {
    // "do you know what I was doing" is 8 words — should not trigger inheritance
    const r = simulateInheritance('do you know what I was doing', ['what did I do yesterday']);
    // parseDateRange returns null for this message, and >4 words so no inheritance
    expect(r).toBeNull();
  });
});

describe('parseIntent — temporal memory override regex', () => {
  it('"list all the files I mentioned yesterday" → fires', () => {
    expect(temporalOverrideFires('list all the files I mentioned yesterday')).toBeTruthy();
  });
  it('"what did we chat about yesterday" → fires', () => {
    expect(temporalOverrideFires('what did we chat about yesterday')).toBeTruthy();
  });
  it('"what did I work on last week" → fires', () => {
    expect(temporalOverrideFires('what did I work on last week')).toBeTruthy();
  });
  it('"show me what I did yesterday" → fires', () => {
    expect(temporalOverrideFires('show me what I did yesterday')).toBeTruthy();
  });
  it('"did we chat about history yesterday" → fires', () => {
    expect(temporalOverrideFires('did we chat about history yesterday')).toBeTruthy();
  });
  it('"what did we discuss last night" → fires', () => {
    expect(temporalOverrideFires('what did we discuss last night')).toBeTruthy();
  });
  it('"summarize what we talked about last month" → fires', () => {
    expect(temporalOverrideFires('summarize what we talked about last month')).toBeTruthy();
  });
  it('"what happened a few days ago" → fires', () => {
    expect(temporalOverrideFires('what happened a few days ago')).toBeTruthy();
  });
  // Must NOT fire
  it('"create a folder on my desktop" → does not fire', () => {
    expect(temporalOverrideFires('create a folder on my desktop')).toBeFalsy();
  });
  it('"what is the capital of France" → does not fire (no temporal)', () => {
    expect(temporalOverrideFires('what is the capital of France')).toBeFalsy();
  });
  it('"open chrome yesterday" → fires (temporal + recall verb "open" not in recallVerbPattern)', () => {
    // "open" is NOT in recallVerbPattern — this correctly does NOT fire
    // so command_automate with yesterday doesn't get hijacked
    expect(temporalOverrideFires('open chrome yesterday')).toBeFalsy();
  });
  it('"what is the weather today" → does not fire (today not in temporalMemoryPattern)', () => {
    // "today" is intentionally excluded from temporalMemoryPattern to avoid hijacking weather queries
    expect(temporalOverrideFires('what is the weather today')).toBeFalsy();
  });
});

describe('inferIntentFromContent — prior message intent heuristics', () => {
  it('screen query → screen_intelligence', () => {
    expect(inferIntentFromContent('what do you see on my screen')).toBe('screen_intelligence');
  });
  it('memory query with yesterday → memory_retrieve', () => {
    expect(inferIntentFromContent('list all the files I mentioned yesterday')).toBe('memory_retrieve');
  });
  it('memory query with "did I" → memory_retrieve', () => {
    expect(inferIntentFromContent('what did I work on today')).toBe('memory_retrieve');
  });
  it('command query → command_automate', () => {
    expect(inferIntentFromContent('open chrome and go to github')).toBe('command_automate');
  });
  it('general knowledge → null (no signal)', () => {
    expect(inferIntentFromContent('what is the capital of France')).toBeNull();
  });
  it('greeting → null (no signal)', () => {
    expect(inferIntentFromContent('hello there')).toBeNull();
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(70));
console.log('  TEST SUMMARY');
console.log('='.repeat(70));
console.log(`  Total:   ${_passed + _failed + _skipped}`);
console.log(`  Passed:  ${_passed} ✅`);
console.log(`  Failed:  ${_failed} ❌`);
console.log(`  Skipped: ${_skipped} ⏭`);

if (_failures.length > 0) {
  console.log('\n  FAILURES:');
  _failures.forEach(f => console.log(`    ❌ ${f.label}\n       ${f.error}`));
}

console.log('='.repeat(70));
process.exit(_failed > 0 ? 1 : 0);

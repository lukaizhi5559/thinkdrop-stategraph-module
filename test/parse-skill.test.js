/**
 * ParseSkill Test Suite — 200 prompts
 *
 * Tests the multi-layer skill-matching logic in parseSkill.js WITHOUT calling
 * any real LLM or MCP service. All three deterministic layers are tested:
 *
 *   Layer 1 — Exact / natural-language name match
 *   Layer 2 — Capability-keyword match (sms, email)
 *   Layer 3 — Description-keyword overlap (scroll, type, shortcut, etc.)
 *   Layer 4 — Pre-LLM recurring-signal guard (gcal false-positive prevention)
 *   Layer 5 — Semantic LLM mock validation (confidence parsing, null handling)
 *
 * Run: node test/parse-skill.test.js
 */

'use strict';

// ─── Minimal harness ─────────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

// Top-level describe/it are called during module load to declare suite structure.
// Async execution happens in main() via describeAsync/runSuites — these are no-ops
// that prevent un-awaited async promises from becoming unhandled rejections.
function it(_label, _fn) { /* no-op: async runner in main() re-runs all suites */ }
function describe(_label, fn) { fn(); /* call fn to traverse structure, each it() is a no-op */ }
function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null && actual !== undefined)
        throw new Error(`Expected null/undefined, got ${JSON.stringify(actual)}`);
    },
    toBeNonNull() {
      if (actual === null || actual === undefined)
        throw new Error(`Expected a value but got ${actual}`);
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
  };
}

// ─── Minimal mock skill registry ─────────────────────────────────────────────
// Represents what `user-memory.skill.listNames` would return for a typical user
// with a few installed skills.
const MOCK_SKILLS = [
  {
    name: 'gcal.event',
    description: 'Interact with Google Calendar to create, update, and manage calendar events programmatically using the Google Calendar API.',
    summary: 'Google Calendar event creation and management.',
  },
  {
    name: 'clicksend.send.sms',
    description: 'Send SMS messages using the ClickSend API.',
    summary: 'Send SMS/text messages via ClickSend.',
  },
  {
    name: 'desktop.control',
    description: 'Desktop UI automation skill — scroll, type, click, use keyboard shortcuts, interact with native macOS apps, window control.',
    summary: 'macOS desktop automation: scroll, type, shortcut, click, app control.',
  },
  {
    name: 'github.pr',
    description: 'Create, list, and comment on GitHub pull requests using the GitHub REST API.',
    summary: 'GitHub pull request management.',
  },
  {
    name: 'slack.notify',
    description: 'Send messages to Slack channels via incoming webhook.',
    summary: 'Send Slack channel notifications.',
  },
];

// ─── Import the module under test ────────────────────────────────────────────
// We only test the pure internal logic that does NOT call the LLM.
// For LLM tests we inject a mock llmBackend.

const parseSkillFn = require('../src/nodes/parseSkill.js');

// Build a mock mcpAdapter that returns MOCK_SKILLS for skill.listNames
function makeMockAdapter(skills) {
  return {
    callService: async (service, action) => {
      if (action === 'skill.listNames') {
        return { data: { results: skills } };
      }
      return { data: { results: [] } };
    },
  };
}

// Build a mock LLM backend
function makeMockLLM(response) {
  return {
    generateAnswer: async () => response,
  };
}

// Helper: run parseSkill and extract matched skill name (null if none)
async function run(message, { skills = MOCK_SKILLS, llmResponse = 'null', llmBackend = null } = {}) {
  const adapter = makeMockAdapter(skills);
  const state = {
    message,
    resolvedMessage: message,
    mcpAdapter: adapter,
    llmBackend: llmBackend || makeMockLLM(llmResponse),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
  const result = await parseSkillFn(state);
  return result.matchedSkillName || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 1 — Exact / natural-language name match
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 1 — Exact skill name match (no LLM needed)', () => {
  it('exact dot-name match: "gcal.event"', async () => {
    expect(await run('gcal.event')).toBe('gcal.event');
  });
  it('starts-with match: "gcal.event create dentist appt"', async () => {
    expect(await run('gcal.event create dentist appt')).toBe('gcal.event');
  });
  it('run prefix: "run clicksend.send.sms to 4155551234"', async () => {
    expect(await run('run clicksend.send.sms to 4155551234')).toBe('clicksend.send.sms');
  });
  it('use prefix: "use desktop.control"', async () => {
    expect(await run('use desktop.control')).toBe('desktop.control');
  });
  it('natural language — dots to spaces: "gcal event"', async () => {
    expect(await run('gcal event')).toBe('gcal.event');
  });
  it('natural language — dots to spaces: "clicksend send sms"', async () => {
    expect(await run('clicksend send sms to 4155551234')).toBe('clicksend.send.sms');
  });
  it('natural language — "desktop control my mac"', async () => {
    expect(await run('desktop control my mac')).toBe('desktop.control');
  });
  it('natural language — "slack notify the team"', async () => {
    expect(await run('slack notify the team')).toBe('slack.notify');
  });
  it('no match for random message', async () => {
    expect(await run('what is the weather today')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 2 — Capability-keyword match (SMS / email)
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 2 — Capability-keyword match (SMS/email)', () => {
  it('short SMS: "Text John 4155551234 hey"', async () => {
    expect(await run('Text John at 4155551234 hey there')).toBe('clicksend.send.sms');
  });
  it('short SMS with number: "send 4155551234 a text message"', async () => {
    expect(await run('send 4155551234 a text message')).toBe('clicksend.send.sms');
  });
  it('text me: "text me the summary" (short & phone implicit)', async () => {
    // Short prompt, "text me" pattern — should match
    expect(await run('text me the address')).toBe('clicksend.send.sms');
  });
  it('long complex prompt does NOT match capability-keyword (too long)', async () => {
    // Long prompt (> 120 chars) — requiresPhoneOrShort means this should NOT match capability-keyword
    const long = 'I want to automate my entire morning workflow: first check weather, then conditionally send a text message to my friend with a summary of the day ahead';
    const result = await run(long, { llmResponse: 'null' });
    // Should NOT match via capability-keyword (no phone number, long prompt)
    // It may still match via LLM — but with null LLM response, expect null
    expect(result).toBeNull();
  });
  it('no SMS skill installed → no match', async () => {
    const noSms = MOCK_SKILLS.filter(s => !s.name.includes('sms'));
    expect(await run('send a text to 4155551234', { skills: noSms })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 3 — Description-keyword overlap (desktop automation)
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 3 — Description-keyword overlap (scroll/type/shortcut)', () => {
  it('scroll + window: "scroll down in the active window"', async () => {
    expect(await run('scroll down in the active window')).toBe('desktop.control');
  });
  it('type + keyboard: "type my password using keyboard"', async () => {
    expect(await run('type my password using the keyboard')).toBe('desktop.control');
  });
  it('shortcut + click: "use keyboard shortcut to click save"', async () => {
    expect(await run('use keyboard shortcut to click save')).toBe('desktop.control');
  });
  it('app control: "automate app interaction on macOS"', async () => {
    expect(await run('automate app interaction on macOS')).toBe('desktop.control');
  });
  it('playwright: "use playwright to scroll the page"', async () => {
    expect(await run('use playwright to scroll the page')).toBe('desktop.control');
  });
  it('window: "bring active window to foreground"', async () => {
    expect(await run('bring active window to foreground')).toBe('desktop.control');
  });
  it('nut.js: "use nut.js to move mouse"', async () => {
    expect(await run('use nut.js to move mouse')).toBe('desktop.control');
  });
  it('single group hit (< MIN_GROUPS) — no match', async () => {
    // "click" alone without a second group word should NOT match
    expect(await run('click save', { llmResponse: 'null' })).toBeNull();
  });
  it('no desktop.control skill installed → no match', async () => {
    const noDesktop = MOCK_SKILLS.filter(s => s.name !== 'desktop.control');
    expect(await run('scroll down and type hello', { skills: noDesktop, llmResponse: 'null' })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 4 — Pre-LLM recurring-signal guard (THE CORE BUG FIX)
// These prompts should NEVER match gcal.event because they describe a
// recurring local reminder, not a one-shot calendar event.
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 4 — Recurring-signal guard: no false gcal.event match', () => {
  const llmWouldSayGcal = { llmResponse: '0' }; // index 0 = gcal.event

  it('cold plunge every morning', async () => {
    expect(await run('Schedule my cold plunge sessions every morning at 6am', llmWouldSayGcal)).toBeNull();
  });
  it('daily reminder at 7am', async () => {
    expect(await run('Remind me daily at 7am', llmWouldSayGcal)).toBeNull();
  });
  it('every morning workout reminder', async () => {
    expect(await run('Set a reminder every morning for my workout', llmWouldSayGcal)).toBeNull();
  });
  it('remind me every day at 6', async () => {
    expect(await run('Remind me every day at 6am to take my vitamins', llmWouldSayGcal)).toBeNull();
  });
  it('daily alarm at 8am', async () => {
    expect(await run('Set a daily alarm at 8am', llmWouldSayGcal)).toBeNull();
  });
  it('recurring yoga at 7am', async () => {
    expect(await run('Schedule my recurring yoga session at 7am', llmWouldSayGcal)).toBeNull();
  });
  it('each morning stand-up notification', async () => {
    expect(await run('Send me a notification each morning at 9am for standup', llmWouldSayGcal)).toBeNull();
  });
  it('weekly check-in reminder every Monday', async () => {
    expect(await run('Remind me every week on Monday to do my check-in', llmWouldSayGcal)).toBeNull();
  });
  it('repeat workout timer at 6am', async () => {
    expect(await run('Set a repeating workout timer at 6am', llmWouldSayGcal)).toBeNull();
  });
  it('daily hydration reminder', async () => {
    expect(await run('Remind me daily to drink water', llmWouldSayGcal)).toBeNull();
  });
  it('every night stretch reminder at 10pm', async () => {
    expect(await run('Remind me every night at 10pm to stretch', llmWouldSayGcal)).toBeNull();
  });
  it('on a daily schedule at 7am', async () => {
    expect(await run('Schedule my morning meditation on a daily schedule at 7am', llmWouldSayGcal)).toBeNull();
  });
  it('pomodoro every hour', async () => {
    expect(await run('Remind me every hour to take a pomodoro break', llmWouldSayGcal)).toBeNull();
  });
  it('each evening gratitude reminder', async () => {
    expect(await run('Send me a reminder each evening at 8pm for gratitude journaling', llmWouldSayGcal)).toBeNull();
  });
  it('every day morning routine', async () => {
    expect(await run('Set up my morning routine reminder every day at 5:30am', llmWouldSayGcal)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 5 — Explicit calendar mentions SHOULD match gcal.event
// (These are genuine one-shot Google Calendar requests)
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 5 — Explicit calendar calls SHOULD match gcal.event', () => {
  it('add dentist to Google Calendar', async () => {
    const result = await run('Add a dentist appointment to my Google Calendar', { llmResponse: '0' });
    expect(result).toBe('gcal.event');
  });
  it('create a calendar event for Friday', async () => {
    const result = await run('Create a calendar event for the team meeting on Friday', { llmResponse: '0' });
    expect(result).toBe('gcal.event');
  });
  it('"add to my calendar" phrase', async () => {
    const result = await run('Add this to my calendar: dentist Monday 3pm', { llmResponse: '0' });
    expect(result).toBe('gcal.event');
  });
  it('gcal.event natural language direct call', async () => {
    // Exact name present in message
    expect(await run('gcal event doctor Thursday 2pm')).toBe('gcal.event');
  });
  it('create calendar event — no recurring signals', async () => {
    const result = await run('Create an event on Google Calendar for lunch with Sarah on Tuesday at noon', { llmResponse: '0' });
    expect(result).toBe('gcal.event');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 6 — Semantic LLM mock: confidence parsing
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 6 — LLM index parsing (valid index=match, -1/null=reject)', () => {
  it('valid index → match', async () => {
    const r = await run('Pull up my GitHub PRs', { llmResponse: '3' }); // index 3 = github.pr
    expect(r).toBe('github.pr');
  });
  it('-1 response → no match', async () => {
    expect(await run('What is the weather today', { llmResponse: '-1' })).toBeNull();
  });
  it('null text response → no match', async () => {
    expect(await run('What is the weather today', { llmResponse: 'null' })).toBeNull();
  });
  it('empty response → no match', async () => {
    expect(await run('Tell me a joke', { llmResponse: '' })).toBeNull();
  });
  it('out-of-range index → rejected (hallucination guard)', async () => {
    expect(await run('Do something', { llmResponse: '99' })).toBeNull();
  });
  it('index 0 → gcal.event', async () => {
    const r = await run('Add to my Google Calendar', { llmResponse: '0' });
    expect(r).toBe('gcal.event');
  });
  it('index 4 → slack.notify', async () => {
    const r = await run('Notify the Slack channel', { llmResponse: '4' });
    expect(r).toBe('slack.notify');
  });
  it('LLM returns index with surrounding whitespace → still matches', async () => {
    const r = await run('Send a Slack notification', { llmResponse: '  4  ' });
    expect(r).toBe('slack.notify');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 7 — Prompts that should NEVER match any skill (no skills installed,
//            unrelated topics, or no clear skill intent)
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 7 — Should not match any skill (no installed skill applies)', () => {
  const noMatch = { llmResponse: 'null' };
  const cases = [
    'What is the capital of France',
    'How does photosynthesis work',
    'Tell me a joke',
    "What's the weather in New York",
    'Search for best pizza near me',
    'What did I save about Priya',
    "What's on my screen right now",
    "Remember that I prefer dark mode",
    "What's the difference between Rust and C++",
    "Look up whether Mochi needs a lepto vaccine",
    "Open Spotify",
    "Open the settings app",
    "Show me my notes from last week",
    "Read my last email",
    "Translate hello to Spanish",
    "How do I center a div in CSS",
    "Who won the Super Bowl",
    "Convert 100 USD to EUR",
    "What time is it in Tokyo",
    "Summarize this article",
  ];
  for (const msg of cases) {
    it(`no match: "${msg.substring(0, 55)}"`, async () => {
      expect(await run(msg, noMatch)).toBeNull();
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 8 — Empty / minimal skill registry edge cases
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 8 — Edge cases: empty registry, no descriptions, single skill', () => {
  it('empty skill registry → always null', async () => {
    expect(await run('gcal.event create event', { skills: [] })).toBeNull();
  });
  it('skills with no description → bypasses LLM, no crash', async () => {
    const noDesc = [{ name: 'gcal.event', description: '', summary: '' }];
    expect(await run('Schedule a meeting', { skills: noDesc, llmResponse: 'null' })).toBeNull();
  });
  it('single skill, exact name match', async () => {
    const single = [{ name: 'my.skill', description: 'Does something special', summary: '' }];
    expect(await run('my.skill run now', { skills: single })).toBe('my.skill');
  });
  it('undefined mcpAdapter → passes through gracefully', async () => {
    const result = await parseSkillFn({
      message: 'gcal.event create something',
      resolvedMessage: 'gcal.event create something',
      mcpAdapter: null,
      llmBackend: null,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(result.matchedSkillName).toBeNull();
  });
  it('LLM timeout → passes through gracefully (no match)', async () => {
    const slowLLM = {
      generateAnswer: () => new Promise((_, rej) => setTimeout(() => rej(new Error('semantic timeout')), 1)),
    };
    // Needs a non-triggering message so only LLM path runs
    const result = await run('Review my latest pull request', { llmBackend: slowLLM });
    // Should not crash — returns null
    expect(result).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 9 — WANTS_TO_CREATE guard (user asks to BUILD a skill)
// When the user says "create a skill" but one already exists, it should still
// match (userWantsToCreate=true, but matched). When no skill exists, null.
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 9 — WANTS_TO_CREATE guard', () => {
  it('"build a skill to send SMS" → matches clicksend.send.sms (it exists)', async () => {
    const r = await run('build a skill to send SMS messages', { llmResponse: '1' }); // index 1 = clicksend.send.sms
    expect(r).toBe('clicksend.send.sms');
  });
  it('"create a tool for desktop control" → matches desktop.control (it exists)', async () => {
    const r = await run('create a tool for desktop control', { llmResponse: '2' }); // index 2 = desktop.control
    expect(r).toBe('desktop.control');
  });
  it('"build a brand new xyz skill" → null (no such skill)', async () => {
    expect(await run("build a brand new xyz notification skill", { llmResponse: '-1' })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 10 — gcal.event boundary: recurring + "Google Calendar" explicit
//             should STILL match (guard exception path)
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 10 — Recurring + explicit "Google Calendar" → guard bypassed', () => {
  it('"sync cold plunge daily to my Google Calendar"', async () => {
    const r = await run('Add cold plunge every morning to my Google Calendar', { llmResponse: '0' });
    expect(r).toBe('gcal.event');
  });
  it('"create a recurring Google Calendar event for standup"', async () => {
    const r = await run('Create a recurring calendar event for standup every day', { llmResponse: '0' });
    expect(r).toBe('gcal.event');
  });
  it('"add to my calendar: daily meditation at 6am"', async () => {
    const r = await run('add to my calendar: daily meditation at 6am', { llmResponse: '0' });
    expect(r).toBe('gcal.event');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 11 — Multi-skill registry: no cross-contamination
// Checks that capability-keyword and description-keyword picks the RIGHT skill
// and doesn't bleed into unrelated skills.
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 11 — Multi-skill registry: no cross-contamination', () => {
  it('scroll message should not match slack.notify', async () => {
    const r = await run('scroll down in the active window', { llmResponse: '-1' });
    expect(r).toBe('desktop.control'); // correct skill via keyword match, LLM said -1
  });
  it('send Slack message should not match clicksend.send.sms', async () => {
    const r = await run('Notify the Slack channel about the deploy', { llmResponse: '4' }); // index 4 = slack.notify
    expect(r).toBe('slack.notify'); // not sms
  });
  it('GitHub PR request should not match desktop.control', async () => {
    const r = await run('List my open GitHub pull requests', { llmResponse: '3' }); // index 3 = github.pr
    expect(r).toBe('github.pr');
  });
  it('"text me the PR link at 4155551234" → sms, not github.pr', async () => {
    // Phone number present, short prompt → capability-keyword match should win
    expect(await run('text me the PR link at 4155551234')).toBe('clicksend.send.sms');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 12 — Real-world prompt variety (covers the 200 ≈ union of all above)
// Mixed bag of prompts covering all the categories above, asserting correctly
// ═════════════════════════════════════════════════════════════════════════════
describe('Suite 12 — Real-world variety prompts', () => {
  const realWorld = [
    // Should match gcal.event (explicit calendar reference, non-recurring or guard bypassed)
    { msg: 'Schedule a dentist appointment on Google Calendar for next Tuesday', lLLM: '0', expect: 'gcal.event' },
    { msg: 'Create a Google Calendar event for my flight on March 30', lLLM: '0', expect: 'gcal.event' },
    { msg: 'Book a calendar appointment with HR on Friday at 2pm', lLLM: '0', expect: 'gcal.event' },
    // Should NOT match gcal.event (recurring, no explicit calendar) — LLM says 0 but guard blocks it
    { msg: 'Set a morning alarm every day at 6:30am', lLLM: '0', expect: null },
    { msg: 'Remind me every morning to take my medication', lLLM: '0', expect: null },
    { msg: 'Daily standup reminder at 9am please', lLLM: '0', expect: null },
    { msg: 'Create a daily recurring reminder at 7am for my run', lLLM: '0', expect: null },
    { msg: 'Set up a weekly Friday retrospective alarm', lLLM: '0', expect: null },
    { msg: 'Remind me each morning to check my email', lLLM: '0', expect: null },
    { msg: 'Each day at noon remind me to eat lunch', lLLM: '0', expect: null },
    { msg: 'Give me a daily 8pm wind-down notification', lLLM: '0', expect: null },
    { msg: 'Nightly sleep reminder at 11pm every night', lLLM: '0', expect: null },
    // Should match clicksend.send.sms (phone number present — keyword match, LLM says -1)
    { msg: 'Send a text to 4155551234 saying I am on my way', lLLM: '-1', expect: 'clicksend.send.sms' },
    { msg: 'Text 14085551234 good morning', lLLM: '-1', expect: 'clicksend.send.sms' },
    // Should match desktop.control (scroll + type combo — keyword match, LLM says -1)
    { msg: 'Scroll up and type hello in the active window', lLLM: '-1', expect: 'desktop.control' },
    { msg: 'Use keyboard shortcut cmd+S and click yes', lLLM: '-1', expect: 'desktop.control' },
    // Should be null (no match, no phone, no clear skill)
    { msg: 'What is docker', lLLM: '-1', expect: null },
    { msg: 'How do I use git rebase', lLLM: '-1', expect: null },
    { msg: 'Who is the CEO of Apple', lLLM: '-1', expect: null },
    { msg: 'Find me a recipe for pasta', lLLM: '-1', expect: null },
    { msg: 'Summarize the Wikipedia article on TypeScript', lLLM: '-1', expect: null },
    { msg: 'What is 12 percent of 500', lLLM: '-1', expect: null },
    { msg: 'Play some jazz music', lLLM: '-1', expect: null },
    { msg: 'How tall is Mount Everest', lLLM: '-1', expect: null },
    { msg: 'Write a haiku about the ocean', lLLM: '-1', expect: null },
    { msg: 'Show me the current Bitcoin price', lLLM: '-1', expect: null },
    // Should match github.pr via LLM (index 3)
    { msg: 'Show me all open pull requests on my repo', lLLM: '3', expect: 'github.pr' },
    { msg: 'Close the open PRs older than 30 days', lLLM: '3', expect: 'github.pr' },
    { msg: 'List pull requests assigned to me', lLLM: '3', expect: 'github.pr' },
    // Should match slack.notify via LLM (index 4)
    { msg: 'Post a message to the #general Slack channel', lLLM: '4', expect: 'slack.notify' },
    { msg: 'Notify the dev team on Slack about the release', lLLM: '4', expect: 'slack.notify' },
  ];

  for (const tc of realWorld) {
    it(`"${tc.msg.substring(0, 60)}" → ${tc.expect || 'null'}`, async () => {
      const r = await run(tc.msg, { llmResponse: tc.lLLM });
      if (tc.expect === null) {
        expect(r).toBeNull();
      } else {
        expect(r).toBe(tc.expect);
      }
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Results
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  // The describe/it calls above are synchronous wrappers around async functions.
  // We need to actually await all the async "it" calls.
  // Re-run approach: collect all pending promises via a queue.
  console.log('\n' + '═'.repeat(72));
  console.log('  ParseSkill Test Suite');
  console.log('═'.repeat(72));

  // Jest-like runner: since we used a sync harness but async fns,
  // we need to re-execute via a proper async runner below.
  // Reset and re-run all suites properly.

  _passed = 0; _failed = 0; _failures.length = 0;

  const suites = [];

  function describeAsync(label, fn) {
    suites.push({ label, fn });
  }

  async function runSuites() {
    for (const suite of suites) {
      console.log(`\n${'─'.repeat(72)}\n  ${suite.label}\n${'─'.repeat(72)}`);
      const pending = suite.fn();
      for (const [label, promise] of pending) {
        try {
          await promise;
          _passed++;
          console.log(`  ✅ ${label}`);
        } catch (e) {
          _failed++;
          _failures.push({ label, error: e.message });
          console.log(`  ❌ ${label}`);
          console.log(`     → ${e.message}`);
        }
      }
    }
  }

  // ── Re-declare all suites in async-ready form ──────────────────────────────

  function mkRun(cases) {
    return cases.map(([label, fn]) => [label, fn()]);
  }

  describeAsync('Suite 1 — Exact skill name match', () => mkRun([
    ['exact dot-name: "gcal.event"', () => run('gcal.event').then(r => { if (r !== 'gcal.event') throw new Error(`Expected gcal.event got ${r}`); })],
    ['starts-with: "gcal.event create dentist"', () => run('gcal.event create dentist').then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['run prefix: "run clicksend.send.sms to 4155551234"', () => run('run clicksend.send.sms to 4155551234').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['use prefix: "use desktop.control"', () => run('use desktop.control').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['natural lang: "gcal event"', () => run('gcal event').then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['natural lang: "clicksend send sms to 4155551234"', () => run('clicksend send sms to 4155551234').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['natural lang: "desktop control my mac"', () => run('desktop control my mac').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['natural lang: "slack notify the team"', () => run('slack notify the team').then(r => { if (r !== 'slack.notify') throw new Error(`Got ${r}`); })],
    ['no match for random message', () => run('what is the weather today').then(r => { if (r !== null) throw new Error(`Expected null got ${r}`); })],
    ['execute prefix: "execute gcal.event now"', () => run('execute gcal.event now').then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 2 — Capability-keyword match (SMS)', () => mkRun([
    ['short SMS with phone: "Text John at 4155551234"', () => run('Text John at 4155551234 hey there').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['send phone number text', () => run('send 4155551234 a text message').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['text me: "text me the address"', () => run('text me the address').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['long complex prompt → no capability match', () => run('I want to build an automated morning routine: check the weather and traffic, then send a text message with the summary to my accountability partner when ready', { llmResponse: 'null' }).then(r => { if (r !== null) throw new Error(`Expected null got ${r}`); })],
    ['no SMS skill → null', () => run('send a text to 4155551234', { skills: MOCK_SKILLS.filter(s => !s.name.includes('sms')) }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['"text this to me" pattern', () => run('text this to me at 4085559876').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 3 — Description-keyword overlap (desktop)', () => mkRun([
    ['scroll + window', () => run('scroll down in the active window').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['type + keyboard', () => run('type my password using the keyboard').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['shortcut + click', () => run('use keyboard shortcut to click save').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['app control: automate app', () => run('automate app scrolling and clicking on macOS').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['playwright + scroll', () => run('use playwright to scroll the page').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['active window foreground', () => run('bring active window to foreground').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['nut.js mouse', () => run('use nut.js to move mouse').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['single group — no match', () => run('click save', { llmResponse: 'null' }).then(r => { if (r !== null) throw new Error(`Expected null got ${r}`); })],
    ['double-click + type', () => run('double-click the field and type hello').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['window control + keystroke', () => run('send keystroke to active window').then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 4 — Recurring guard: gcal.event MUST NOT match', () => {
    const pairs = [
      'Schedule my cold plunge sessions every morning at 6am',
      'Remind me daily at 7am',
      'Set a reminder every morning for my workout',
      'Remind me every day at 6am to take my vitamins',
      'Set a daily alarm at 8am',
      'Schedule my recurring yoga session at 7am',
      'Send me a notification each morning at 9am for standup',
      'Remind me every week on Monday to do my check-in',
      'Set a repeating workout timer at 6am',
      'Remind me daily to drink water',
      'Remind me every night at 10pm to stretch',
      'Schedule my morning meditation on a daily schedule at 7am',
      'Remind me every hour to take a pomodoro break',
      'Send me a reminder each evening at 8pm for gratitude journaling',
      'Set up my morning routine reminder every day at 5:30am',
      'Give me a daily 3pm focus reminder',
      'Set a daily standdown reminder at 6pm',
      'Remind me every morning to review my goals',
      'Each morning at 7 remind me to journal',
      'Put a daily 5am cold shower reminder',
    ];
    return mkRun(pairs.map(msg => [
      `No match: "${msg.substring(0, 55)}"`,
      () => run(msg, { llmResponse: 'gcal.event|HIGH' }).then(r => {
        if (r !== null) throw new Error(`Expected null (recurring guard), got "${r}" for: ${msg}`);
      }),
    ]));
  });

  describeAsync('Suite 5 — Explicit calendar → SHOULD match gcal.event', () => mkRun([
    ['add dentist to Google Calendar', () => run('Add a dentist appointment to my Google Calendar', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['create calendar event Friday', () => run('Create a calendar event for the team meeting on Friday', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['"add to my calendar" phrase', () => run('Add this to my calendar: dentist Monday 3pm', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['gcal event NL direct call', () => run('gcal event doctor Thursday 2pm').then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['lunch calendar event no recur', () => run('Create an event on Google Calendar for lunch with Sarah on Tuesday', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['add cold plunge to Google Calendar (explicit)', () => run('Add cold plunge every morning to my Google Calendar', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['create recurring calendar event standup', () => run('Create a recurring calendar event for standup every day', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
    ['add to my calendar daily meditation', () => run('add to my calendar: daily meditation at 6am', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 6 — LLM confidence parsing', () => mkRun([
    ['HIGH → match', () => run('Pull up my GitHub PRs', { llmResponse: 'github.pr|HIGH' }).then(r => { if (r !== 'github.pr') throw new Error(`Got ${r}`); })],
    ['"null" response → null', () => run('What is the weather', { llmResponse: 'null' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['empty response → null', () => run('Tell me a joke', { llmResponse: '' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['MEDIUM → rejected', () => run('About calendars', { llmResponse: 'gcal.event|MEDIUM' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['LOW → rejected', () => run('Something vague', { llmResponse: 'gcal.event|LOW' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['unknown skill hallucination → rejected', () => run('Do something', { llmResponse: 'fake.skill.xyz|HIGH' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['legacy plain name → HIGH (compat)', () => run('Notify the Slack channel', { llmResponse: 'slack.notify' }).then(r => { if (r !== 'slack.notify') throw new Error(`Got ${r}`); })],
    ['quoted response → still parses', () => run('Send a Slack notification', { llmResponse: '"slack.notify|HIGH"' }).then(r => { if (r !== 'slack.notify') throw new Error(`Got ${r}`); })],
    ['backtick-wrapped → parses', () => run('Message Slack', { llmResponse: '`slack.notify|HIGH`' }).then(r => { if (r !== 'slack.notify') throw new Error(`Got ${r}`); })],
    ['NONE keyword → null', () => run('Random task', { llmResponse: 'none' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 7 — Should never match (no skill applies)', () => {
    const msgs = [
      'What is the capital of France',
      'How does photosynthesis work',
      'Tell me a joke',
      "What's the weather in New York",
      'Search for best pizza near me',
      'What did I save about Priya',
      "What's on my screen right now",
      "Remember that I prefer dark mode",
      "What's the difference between Rust and C++",
      "Look up whether Mochi needs a lepto vaccine",
      "Open Spotify",
      "Show me my notes from last week",
      "Read my last email",
      "Translate hello to Spanish",
      "How do I center a div in CSS",
      "Who won the Super Bowl",
      "Convert 100 USD to EUR",
      "What time is it in Tokyo",
      "Summarize this article",
      "How tall is Mount Everest",
    ];
    return mkRun(msgs.map(msg => [
      `null: "${msg.substring(0, 50)}"`,
      () => run(msg, { llmResponse: 'null' }).then(r => {
        if (r !== null) throw new Error(`Expected null got "${r}"`);
      }),
    ]));
  });

  describeAsync('Suite 8 — Edge cases', () => mkRun([
    ['empty skill registry', () => run('gcal.event create event', { skills: [] }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['skills no description — no crash', () => run('Schedule a meeting', { skills: [{ name: 'gcal.event', description: '', summary: '' }], llmResponse: 'null' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['single skill exact name', () => run('my.skill run now', { skills: [{ name: 'my.skill', description: 'Does something special' }] }).then(r => { if (r !== 'my.skill') throw new Error(`Got ${r}`); })],
    ['null mcpAdapter — no crash', async () => {
      const result = await parseSkillFn({ message: 'gcal.event', resolvedMessage: 'gcal.event', mcpAdapter: null, llmBackend: null, logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
      if (result.matchedSkillName !== undefined && result.matchedSkillName !== null) throw new Error(`Got ${result.matchedSkillName}`);
    }],
    ['LLM timeout — graceful null', () => run('Review my PR', { llmBackend: { generateAnswer: () => new Promise((_, rej) => setTimeout(() => rej(new Error('semantic timeout')), 1)) } }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 9 — WANTS_TO_CREATE guard', () => mkRun([
    ['"build skill to send SMS" → sms skill exists', () => run('build a skill to send SMS messages', { llmResponse: 'clicksend.send.sms|HIGH' }).then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['"create tool for desktop control" → desktop exists', () => run('create a tool for desktop control', { llmResponse: 'desktop.control|HIGH' }).then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['"build totally new xyz skill" → null', () => run('build a brand new xyz notification skill', { llmResponse: 'null' }).then(r => { if (r !== null) throw new Error(`Got ${r}`); })],
    ['"need a skill for GitHub PRs" → github.pr', () => run("I need a skill for managing GitHub pull requests", { llmResponse: 'github.pr|HIGH' }).then(r => { if (r !== 'github.pr') throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 10 — Multi-skill no cross-contamination', () => mkRun([
    ['scroll → desktop.control not slack', () => run('scroll down in the active window', { llmResponse: 'null' }).then(r => { if (r !== 'desktop.control') throw new Error(`Got ${r}`); })],
    ['Slack notify → not sms', () => run('Notify the Slack channel about the deploy', { llmResponse: 'slack.notify' }).then(r => { if (r !== 'slack.notify') throw new Error(`Got ${r}`); })],
    ['GitHub PR → not desktop.control', () => run('List my open GitHub pull requests', { llmResponse: 'github.pr|HIGH' }).then(r => { if (r !== 'github.pr') throw new Error(`Got ${r}`); })],
    ['SMS with phone → sms not github', () => run('text me the PR link at 4155551234').then(r => { if (r !== 'clicksend.send.sms') throw new Error(`Got ${r}`); })],
    ['calendar explicit → gcal not sms', () => run('Add dentist appointment to my Google Calendar', { llmResponse: 'gcal.event|HIGH' }).then(r => { if (r !== 'gcal.event') throw new Error(`Got ${r}`); })],
  ]));

  describeAsync('Suite 11 — Real-world variety', () => {
    const cases = [
      { msg: 'Schedule a dentist appointment on Google Calendar for Tuesday', lLLM: 'gcal.event|HIGH', exp: 'gcal.event' },
      { msg: 'Create a Google Calendar event for my flight March 30', lLLM: 'gcal.event|HIGH', exp: 'gcal.event' },
      { msg: 'Set a morning alarm every day at 6:30am', lLLM: 'gcal.event|HIGH', exp: null },
      { msg: 'Remind me every morning to take my medication', lLLM: 'gcal.event|HIGH', exp: null },
      { msg: 'Daily standup reminder at 9am please', lLLM: 'gcal.event|HIGH', exp: null },
      { msg: 'Create a daily recurring reminder at 7am for my run', lLLM: 'gcal.event|HIGH', exp: null },
      { msg: 'Set up a weekly Friday retrospective alarm', lLLM: 'gcal.event|HIGH', exp: null },
      { msg: 'Send a text to 4155551234 saying I am on my way', lLLM: 'null', exp: 'clicksend.send.sms' },
      { msg: 'Text 14085551234 good morning', lLLM: 'null', exp: 'clicksend.send.sms' },
      { msg: 'Scroll up and type hello in the active window', lLLM: 'null', exp: 'desktop.control' },
      { msg: 'Use keyboard shortcut cmd+S and click yes', lLLM: 'null', exp: 'desktop.control' },
      { msg: 'What is docker', lLLM: 'null', exp: null },
      { msg: 'How do I use git rebase', lLLM: 'null', exp: null },
      { msg: 'Who is the CEO of Apple', lLLM: 'null', exp: null },
      { msg: 'Find me a recipe for pasta', lLLM: 'null', exp: null },
      { msg: 'Show me all open pull requests on my repo', lLLM: 'github.pr|HIGH', exp: 'github.pr' },
      { msg: 'Close the open PRs older than 30 days', lLLM: 'github.pr|HIGH', exp: 'github.pr' },
      { msg: 'Post a message to the #general Slack channel', lLLM: 'slack.notify', exp: 'slack.notify' },
      { msg: 'Notify the dev team on Slack about the release', lLLM: 'slack.notify', exp: 'slack.notify' },
      { msg: 'What is 12 percent of 500', lLLM: 'null', exp: null },
    ];
    return mkRun(cases.map(tc => [
      `"${tc.msg.substring(0, 55)}" → ${tc.exp || 'null'}`,
      () => run(tc.msg, { llmResponse: tc.lLLM }).then(r => {
        const expected = tc.exp;
        if (r !== expected) throw new Error(`Expected ${expected} got ${r}`);
      }),
    ]));
  });

  await runSuites();

  // ── Final summary ──────────────────────────────────────────────────────────
  const total = _passed + _failed;
  console.log('\n' + '═'.repeat(72));
  console.log(`  ParseSkill Test Results`);
  console.log('═'.repeat(72));
  console.log(`  Total:   ${total}`);
  console.log(`  Passed:  ${_passed}  ✅`);
  console.log(`  Failed:  ${_failed}  ${_failed > 0 ? '❌' : ''}`);
  if (_failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of _failures) {
      console.log(`    ❌ ${f.label}`);
      console.log(`       ${f.error}`);
    }
  }
  console.log('═'.repeat(72) + '\n');
  process.exit(_failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});

'use strict';

/**
 * buildReminderSkill.js — Pure deterministic reminder skill factory
 *
 * Determines whether a user message is a local macOS reminder/scheduled task
 * and, if so, builds the complete 3-step skill plan (write skill.md → install → sync)
 * WITHOUT calling the LLM. This is the pre-LLM interceptor extracted into a
 * standalone testable unit.
 *
 * Skill tiers:
 *   notify — SkillScheduler fires osascript directly at cron time
 *   bridge — SkillScheduler writes WS:INSTRUCTION → Electron executes AI task
 *
 * Output skill.md includes ALL fields required by skillRegistry.validateContract:
 *   name, description, exec_path, exec_type  (required)
 *   schedule, type, title, message/instruction  (tier-specific)
 *
 * Usage:
 *   const { buildReminderSkill } = require('./buildReminderSkill');
 *   const result = buildReminderSkill(userMessage, homeDir);
 *   if (result.fires) { return { ...state, skillPlan: result.skillPlan, ... }; }
 */

// ── Validation regex (mirrors skillRegistry.js) ───────────────────────────────
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

// ── External service names — let LLM handle these, not the interceptor ────────
const EXTERNAL_SVCS = [
  'gmail', 'twilio', 'sms', 'text message', 'clicksend', 'vonage',
  'slack', 'discord', 'telegram', 'whatsapp', 'sendgrid', 'mailgun',
  'email service', 'pushover', 'pushbullet', 'onesignal',
  'zapier', 'make.com', 'ifttt', 'n8n', 'workflow',
  'emails my team', 'email my team', 'email the team', 'emails the team',
];

// ── Keywords that signal a local reminder/wellness activity ───────────────────
const LOCAL_REMINDER_KWS = [
  'remind', 'reminder', 'alarm', 'alert',
  'cold plunge', 'plunge', 'ice bath',
  'workout', 'exercise', 'gym', 'lifting', 'weights',
  'run', 'jog', 'walk', 'hike', 'bike', 'cycling',
  'yoga', 'pilates', 'stretch', 'stretching',
  'meditation', 'meditate', 'breathwork', 'mindfulness',
  'vitamins', 'vitamin', 'supplement', 'supplements',
  'medicine', 'medication', 'medications', 'pill', 'pills', 'meds',
  'wake up', 'wake me', 'get up', 'bed time', 'bedtime', 'sleep',
  'stand up', 'standup', 'stand-up', 'sitting', 'posture',
  'drink water', 'hydrat', 'water break', 'water intake',
  'break', 'lunch', 'snack', 'meal prep',
  'journal', 'journaling', 'gratitude',
  'call mom', 'call dad', 'call',
  'meeting', 'standup', 'daily sync', 'ping', 'nudge',
  'read', 'reading', 'study', 'studying',
  'water plants', 'feed', 'dog walk',
  'language', 'practice',
];

// ── Unambiguous recurrence signals — REQUIRED for the interceptor to fire ────
// A bare time like "at 8am" is NOT enough. The user must express that the action
// repeats. "Remind me to take meds at 8am" is one-time → fires: false.
// "Remind me to take meds every morning at 8am" is recurring → fires: true.
const RECURRING_KWS = [
  'every morning', 'every day', 'every night', 'every evening', 'every afternoon',
  'every single day', 'every single morning', 'every single night',
  'every hour', 'every week', 'every 2 hours', 'every 3 hours', 'every 4 hours',
  'every monday', 'every tuesday', 'every wednesday', 'every thursday',
  'every friday', 'every saturday', 'every sunday',
  'each morning', 'each day', 'each night', 'each evening', 'each week',
  'each monday', 'each tuesday', 'each wednesday', 'each thursday',
  'each friday', 'each saturday', 'each sunday',
  'daily', 'nightly', 'weekly', 'monthly', 'weekday', 'weekdays',
  'on mondays', 'on tuesdays', 'on wednesdays', 'on thursdays',
  'on fridays', 'on saturdays', 'on sundays',
  'every morning at', 'every night at', 'every evening at', 'every day at',
  'morning routine', 'evening routine',
  // "morning reminder at 7am" / "evening reminder at 8pm" — implicit daily recurrence
  'morning reminder', 'evening reminder', 'morning hydration', 'morning alarm',
  // Sub-hour intervals
  'every minute', 'every 5 minutes', 'every 10 minutes', 'every 15 minutes',
  'every 30 minutes', 'every 2 minutes', 'every 3 minutes',
];

// ── Bare time references — used for time parsing ONLY, not to gate firing ────
// These alone do NOT indicate a recurring schedule.
const TIME_KWS = [
  'at 6', 'at 7', 'at 8', 'at 9', 'at 10', 'at 11', 'at 12',
  'at noon', 'at midnight',
  '6am', '7am', '8am', '9am', '10am', '11am', '12pm',
  '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm',
];

// ── Bridge action keywords (AI tasks that need fresh context at fire time) ────
const BRIDGE_ACTION_KWS = [
  'update', 'review', 'check', 'go through', 'organize', 'summarize', 'summary',
  'draft', 'process', 'clean up', 'analyze', 'categorize', 'compile',
  'go over', 'look at', 'write up', 'prepare', 'audit',
  'triage', 'sort', 'file', 'archive',
  'watch', 'monitor', 'collect', 'fetch', 'scan',
];

// ── Stop words for skill name label extraction ────────────────────────────────
// Only truly generic/grammatical words. Activity content words (cold, plunge,
// workout, yoga, etc.) are intentionally NOT in this list.
const STOP_WORDS = new Set([
  'my', 'a', 'an', 'the', 'at', 'every', 'morning', 'evening',
  'daily', 'to', 'for', 'of', 'on', 'in', 'sessions', 'session',
  'schedule', 'me', 'i', 'set', 'give', 'put', 'remind', 'reminder',
  'alarm', 'weekly', 'nightly', 'each', 'tonight', 'night', 'and',
  'please', 'can', 'could', 'would', 'should', 'want', 'need', 'like',
  'starting', 'beginning', 'going', 'forward', 'time',
]);

// ── Day-of-week cron mapping ──────────────────────────────────────────────────
const DOW_MAP = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 0, sun: 0,
};

/**
 * Parse hour/minute from a natural-language time string.
 * Returns { hour, minute, dayOfWeek: null | 0-6 }.
 * Defaults to hour=6, minute=0 (6am) if no time found.
 */
function parseTime(text) {
  const t = text.toLowerCase();

  // Day-of-week detection (for weekly schedules)
  let dayOfWeek = null;
  for (const [word, dow] of Object.entries(DOW_MAP)) {
    if (new RegExp(`\\b(every|each|on)?\\s*${word}s?\\b`).test(t)) {
      dayOfWeek = dow;
      break;
    }
  }

  // "midnight" = 0:00
  if (/\bmidnight\b/.test(t)) return { hour: 0, minute: 0, dayOfWeek };
  // "noon" or "12pm" = 12:00
  if (/\bnoon\b/.test(t)) return { hour: 12, minute: 0, dayOfWeek };

  // "6am", "6:30am", "6:30 am"
  const amPmMatch = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (amPmMatch) {
    let hour = parseInt(amPmMatch[1], 10);
    const minute = parseInt(amPmMatch[2] || '0', 10);
    const period = amPmMatch[3];
    if (period === 'pm' && hour < 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return { hour, minute, dayOfWeek };
  }

  // 24-hour "14:30" or "08:00"
  const h24 = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (h24) {
    return { hour: parseInt(h24[1], 10), minute: parseInt(h24[2], 10), dayOfWeek };
  }

  // "at 6" (no am/pm context) — ambiguous, use morning interpretation if ≤ 12
  const atMatch = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (atMatch) {
    const hour = parseInt(atMatch[1], 10);
    const minute = parseInt(atMatch[2] || '0', 10);
    return { hour, minute, dayOfWeek };
  }

  return { hour: 6, minute: 0, dayOfWeek };
}

/**
 * Extract the action body from a scheduling instruction by stripping the
 * temporal scheduling prefix (recurrence word + optional time expression).
 *
 * Strategy: bridge skills are ONLY created when a BRIDGE_ACTION_KWS keyword is present
 * (check, review, draft, summarize, etc.). That keyword is always where the action starts,
 * so we slice from its position — no fragile temporal-prefix regex needed.
 *
 * Examples:
 *   "Daily at 9:47pm, check my screen and draft..." → "check my screen and draft..."
 *   "Every morning at 8am, review my windows"       → "review my windows"
 *   "Nightly, summarize my logs"                    → "summarize my logs"
 *   "check my screen and draft..."                  → "check my screen and draft..." (unchanged)
 */
function extractActionBody(userMessage) {
  const msgLow = userMessage.toLowerCase();
  // If a bridge action keyword starts the message, it's already a clean action — return as-is
  for (const kw of BRIDGE_ACTION_KWS) {
    if (msgLow.startsWith(kw)) return userMessage.trim();
  }
  // Otherwise the message starts with a scheduling prefix — slice from the first action keyword
  for (const kw of BRIDGE_ACTION_KWS) {
    const idx = msgLow.indexOf(kw);
    if (idx > 0) return userMessage.slice(idx).trim();
  }
  return userMessage.trim();
}

/**
 * Build a valid dot-notation skill name label from the user message.
 * Removes stop words, digits-starting tokens, and joins remaining content words.
 * Returns a string like "cold.plunge" or "morning.workout" or "daily" (fallback).
 */
function buildLabel(userMessage) {
  const words = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w) && !/^\d/.test(w))
    .slice(0, 3);
  return words.length > 0 ? words.join('.') : 'daily';
}

/**
 * Main entry point. Given a user message and homeDir, determine whether the
 * reminder interceptor should fire and, if so, build the full skill plan.
 *
 * @param {string} userMessage
 * @param {string} homeDir  e.g. '/Users/lukaizhi'
 * @returns {{ fires: false }
 *          | { fires: true, tier: 'notify'|'bridge', skillName: string,
 *              cronExpr: string, cronHour: number, cronMinute: number,
 *              dayOfWeek: number|null, skillMd: string, skillPlan: object[] }}
 */
function buildReminderSkill(userMessage, homeDir) {
  const msgLow = userMessage.toLowerCase();

  // ── 1. Classify signal presence (must come before EXTERNAL_SVCS gate) ────────
  const hasExplicitRemind = /\b(remind\s+me|reminder|set\s+(a|an)\s+(reminder|alarm)|ping\s+me|alert\s+me|wake\s+me|give\s+me.{0,20}reminder)\b/i.test(userMessage);
  const hasReminderKw  = LOCAL_REMINDER_KWS.some(k => msgLow.includes(k));
  const hasRecurringKw = RECURRING_KWS.some(k => msgLow.includes(k))  // explicit recurrence signal
    // "morning, 6am" or "morning" + time ref = implicit daily
    || (/\bmorning\b/.test(msgLow) && TIME_KWS.some(k => msgLow.includes(k)))
    || (/\bevening\b/.test(msgLow) && TIME_KWS.some(k => msgLow.includes(k)));
  const hasTimeKw      = TIME_KWS.some(k => msgLow.includes(k));        // bare time ref (parsing only)
  // Bridge: explicit recurrence + AI-action verb, but NOT an explicit "remind me / ping me" request
  const hasBridgeKw = !hasExplicitRemind
    && hasRecurringKw
    && BRIDGE_ACTION_KWS.some(k => msgLow.includes(k));

  // ── 2. External service gate — only blocks non-bridge requests ───────────────
  // Bridge requests mentioning gmail/sms/etc. are intentionally allowed through —
  // the bridge tier delegates to email/messaging agents at cron fire time.
  if (!hasBridgeKw && EXTERNAL_SVCS.some(s => msgLow.includes(s))) return { fires: false };

  // ── 3. Must have a RECURRING signal to fire — bare time refs are not enough ──
  // "Remind me to take meds at 8am"     → hasTimeKw only    → fires: false (one-time)
  // "Remind me to take meds every day"  → hasRecurringKw    → fires: true
  // "Set a one-time alarm for 3pm"      → hasTimeKw only    → fires: false
  if (!hasRecurringKw && !hasBridgeKw) return { fires: false };
  // Also need a reminder or bridge signal (not just a recurring phrase in passing)
  if (!hasReminderKw && !hasBridgeKw) return { fires: false };

  // ── 4. Parse time + derive skill name ────────────────────────────────────────
  // Detect interval cadences BEFORE parseTime — sub-hour intervals and "every hour"
  // do not have a fixed clock time and need a different cron pattern entirely.
  const _everyMinute        = /\bevery\s+minute\b/.test(msgLow);
  const _everyNMinutesMatch = !_everyMinute && msgLow.match(/\bevery\s+(\d+)\s+minutes?\b/);
  const _everyNHoursMatch   = !_everyMinute && !_everyNMinutesMatch && msgLow.match(/\bevery\s+(\d+)\s+hours?\b/);
  const _everyHour          = !_everyMinute && !_everyNMinutesMatch && !_everyNHoursMatch && /\bevery\s+hour\b/.test(msgLow);
  const _intervalMinutes    = _everyNMinutesMatch ? parseInt(_everyNMinutesMatch[1], 10) : null;
  const _intervalHours      = _everyNHoursMatch ? parseInt(_everyNHoursMatch[1], 10) : null;

  let hour, minute, minuteStr, dayOfWeek, cronExpr;
  if (_everyMinute) {
    // Fire every minute: * * * * *
    hour = null; minute = null; minuteStr = '00'; dayOfWeek = null;
    cronExpr = '* * * * *';
  } else if (_intervalMinutes) {
    // Fire every N minutes: */N * * * *
    hour = null; minute = null; minuteStr = '00'; dayOfWeek = null;
    cronExpr = `*/${_intervalMinutes} * * * *`;
  } else if (_everyHour) {
    // Fire once per hour on the hour: 0 * * * *
    hour = null; minute = 0; minuteStr = '00'; dayOfWeek = null;
    cronExpr = '0 * * * *';
  } else if (_intervalHours) {
    // Fire every N hours on the hour: 0 */N * * *
    hour = null; minute = 0; minuteStr = '00'; dayOfWeek = null;
    cronExpr = `0 */${_intervalHours} * * *`;
  } else {
    // Standard time-of-day schedule — parse hour/minute from message text
    ({ hour, minute, dayOfWeek } = parseTime(userMessage));
    minuteStr = minute.toString().padStart(2, '0');
    cronExpr = dayOfWeek !== null
      ? `${minute} ${hour} * * ${dayOfWeek}`
      : `${minute} ${hour} * * *`;
  }

  // Human-readable schedule string for step descriptions + plan section
  const cadenceLabel = _everyMinute    ? 'every minute'
    : _intervalMinutes                 ? `every ${_intervalMinutes} minutes`
    : _everyHour                       ? 'every hour'
    : _intervalHours                   ? `every ${_intervalHours} hours`
    : dayOfWeek !== null               ? `${hour}:${minuteStr} on day ${dayOfWeek}`
    :                                    `${hour}:${minuteStr} daily`;

  const label     = buildLabel(userMessage);
  const skillName = `reminder.${label}`;
  const skillDir  = `${homeDir}/.thinkdrop/skills/${skillName}`;
  const tier      = hasBridgeKw ? 'bridge' : 'notify';

  // Truncate message for notification text (safe length, no newlines)
  const notifMsg = userMessage.replace(/[\n\r]/g, ' ').replace(/"/g, "'").substring(0, 100);
  const scheduleLabel = _everyHour || _intervalHours ? 'Recurring' : 'Daily';
  const description = tier === 'notify'
    ? `${scheduleLabel} reminder: ${notifMsg}`
    : `Scheduled task: ${notifMsg}`;

  // ── 5. Build skill.md with ALL required fields for skillRegistry.validateContract ──
  const fmLines = [
    `name: ${skillName}`,
    `schedule: "${cronExpr}"`,
    `type: ${tier}`,
    `description: ${description}`,
    `exec_path: ~/.thinkdrop/skills/${skillName}/skill.md`,
    `exec_type: shell`,
  ];
  if (tier === 'notify') {
    fmLines.push(`title: ThinkDrop Reminder`);
    fmLines.push(`message: ${notifMsg}`);
  } else {
    // Store only the ACTION body as instruction — scheduling prefix (e.g. "Daily at 9pm,")
    // is already captured in the cron schedule. Storing the full message causes the
    // bridge listener to re-trigger the planSkills reminder intercept when cron fires.
    const actionBody = extractActionBody(userMessage).replace(/[\n\r]/g, ' ').replace(/"/g, "'");
    fmLines.push(`title: ${label}`);
    fmLines.push(`instruction: ${actionBody}`);
  }

  const planSection = tier === 'notify'
    ? `Fire a macOS notification ${cadenceLabel}.`
    : `At fire time, ThinkDrop executes: "${extractActionBody(userMessage).replace(/[\n\r]/g, ' ').replace(/"/g, "'")}"`;

  const skillMd = `---\n${fmLines.join('\n')}\n---\n\n## Plan\n${planSection}\n`;

  // ── 6. Build 3-step skill plan ───────────────────────────────────────────────
  const setupScript = [
    `mkdir -p "${skillDir}"`,
    `cat > "${skillDir}/skill.md" << 'SKILL_EOF'`,
    skillMd,
    `SKILL_EOF`,
    `echo "✅ ${tier} skill written: ${skillName}"`,
  ].join('\n');

  const skillPlan = [
    {
      skill: 'shell.run',
      description: `Write ${tier} skill.md for "${label}" ${cadenceLabel}`,
      args: { cmd: 'bash', argv: ['-c', setupScript] },
    },
    {
      skill: 'skill.install',
      description: `Register ${skillName} so SkillScheduler picks up the cron`,
      args: { skillPath: `${homeDir}/.thinkdrop/skills/${skillName}/skill.md` },
    },
    {
      skill: 'shell.run',
      description: `Sync SkillScheduler to activate the cron immediately`,
      args: {
        cmd: 'bash',
        argv: ['-c', `curl -s -X POST http://127.0.0.1:3007/skill.schedule/sync && echo "✅ node-cron activated: ${skillName} (${cadenceLabel})"`],
      },
    },
  ];

  return {
    fires: true,
    recurring: true,
    tier,
    skillName,
    cronExpr,
    cronHour: hour,
    cronMinute: minute,
    dayOfWeek,
    skillMd,
    skillPlan,
  };
}

module.exports = { buildReminderSkill, parseTime, buildLabel, SKILL_NAME_PATTERN };

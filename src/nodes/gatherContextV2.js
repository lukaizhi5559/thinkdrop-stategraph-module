'use strict';

const fs   = require('fs');
const path = require('path');

const MAX_ROUNDS     = 4;
const GATHER_TIMEOUT = 10 * 60 * 1000;

function loadPrompt(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts', filename), 'utf8').trim();
  } catch (_) { return null; }
}

function parseJson(raw) {
  try {
    const text = (raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
    const start = text.indexOf('{');
    return start !== -1 ? JSON.parse(text.slice(start)) : null;
  } catch (_) { return null; }
}

/**
 * gatherContextV2
 *
 * Slim rewrite — only runs for BUILD tasks (scheduled skills requiring credentials)
 * or grill-mode (high-risk operations). EXECUTE tasks pass through immediately.
 *
 * The distinction:
 *   EXECUTE — run-now one-shot task: planSkills LLM resolves all context from
 *             conversationNote (sliding window). No Q&A needed.
 *   BUILD   — recurring scheduled skill with persistent API credentials:
 *             needs credential capture before planSkills can generate a skill file.
 *
 * Removed from original gatherContext.js:
 *   - Multi-round LLM extract → gap analysis for EXECUTE tasks
 *   - Registry scout / CLI/API matching
 *   - Service provider pre-selection
 *
 * What's kept:
 *   - EXECUTE/BUILD classifier LLM call
 *   - Explicit skill-build intent detection
 *   - Credential capture loop (keytar) for BUILD tasks
 *   - Grill-mode pass-through (high-risk questions handled by gatherPlanContext)
 */

const CLASSIFIER_SYS = `You are a task classifier. Decide: EXECUTE (do it right now) or BUILD (new recurring background skill needing persistent API credentials).

EXECUTE: any task doable in one browser/shell session — browse, search, navigate, click, rename, move, open, read, summarize, screenshot, compare, download. When in doubt → EXECUTE.

BUILD: ONLY when the task is BOTH (a) recurring on a schedule AND (b) requires storing API credentials (Twilio, Gmail OAuth, Slack token, Stripe key, etc.).

Respond with ONLY valid JSON: {"type":"EXECUTE"} or {"type":"BUILD"}`;

const SKILL_BUILD_SIGNALS = [
  /\bi\s+need\s+a\s+skill\b/i, /\bbuild\s+(me\s+)?a\s+(new\s+)?skill\b/i,
  /\bcreate\s+(me\s+)?a\s+(new\s+)?skill\b/i, /\bmake\s+(me\s+)?a\s+(new\s+)?skill\b/i,
  /\bset\s+up\s+a\s+skill\b/i, /\bwrite\s+(me\s+)?a\s+skill\b/i,
  /\b(build|create|make|write)\s+(a\s+)?skill\s+(that|for|to)\b/i,
];

const SCHEDULE_SIGNALS = [
  /\bevery\s+(day|morning|night|evening|hour|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bdaily\b/i, /\bnightly\b/i, /\bweekly\b/i, /\bhourly\b/i, /\bmonthly\b/i,
  /\bon\s+a\s+(daily|weekly|monthly|hourly|\w+)\s+schedule\b/i,
  /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b/i, /\bevery\s+\d+\s+(minutes?|hours?)\b/i,
];

const CREDENTIAL_SIGNALS = [
  /\b(twilio|sendgrid|mailgun|ses|postmark|clicksend|sinch|vonage)\b/i,
  /\b(slack\s+bot|discord\s+bot|telegram\s+bot)\b/i,
  /\b(stripe|paypal|square|braintree)\b/i,
  /\b(gmail\s+oauth|gmail\s+api|google\s+api)\b/i,
  /\b(api\s+key|api\s+token|access\s+token|bearer\s+token|secret\s+key)\b/i,
];

function hasScheduleSignal(msg) { return SCHEDULE_SIGNALS.some(r => r.test(msg)); }
function hasCredentialSignal(msg) { return CREDENTIAL_SIGNALS.some(r => r.test(msg)); }

async function classifyTask(userMessage, llmBackend, logger) {
  if (SKILL_BUILD_SIGNALS.some(r => r.test(userMessage))) return 'BUILD';
  if (!hasScheduleSignal(userMessage) || !hasCredentialSignal(userMessage)) return 'EXECUTE';

  try {
    const raw = await llmBackend.generateAnswer(
      `Classify this task:\n"${userMessage}"`,
      { context: { systemInstructions: CLASSIFIER_SYS } },
      { maxTokens: 20, temperature: 0, fastMode: true }
    );
    const parsed = parseJson(raw);
    return parsed?.type === 'BUILD' ? 'BUILD' : 'EXECUTE';
  } catch (e) {
    logger.warn(`[Node:GatherContextV2] classifier failed: ${e.message} — defaulting EXECUTE`);
    return 'EXECUTE';
  }
}

module.exports = async function gatherContextV2(state) {
  const { intent, message, resolvedMessage, llmBackend, progressCallback,
    gatherAnswerCallback, gatherCredentialCallback, keytarCheckCallback } = state;
  const logger = state.logger || console;

  if (intent?.type !== 'command_automate') return state;

  // Skip if already gathered (recovery replan) or grill-mode (handled by gatherPlanContext)
  if (state.recoveryContext || state.gatheredContext || state.gatherContextSkipped) {
    logger.debug('[Node:GatherContextV2] skipping — already gathered');
    return state;
  }

  // Grill mode: high-risk questions are handled downstream by gatherPlanContext
  if (state._grillMode) {
    logger.info('[Node:GatherContextV2] grill-mode active — deferring to gatherPlanContext');
    return { ...state, gatherContextSkipped: true };
  }

  if (!llmBackend) {
    return { ...state, gatherContextSkipped: true };
  }

  const userMessage = resolvedMessage || message || '';

  // ── Classify EXECUTE vs BUILD ──────────────────────────────────────────────
  const taskType = await classifyTask(userMessage, llmBackend, logger);
  logger.info(`[Node:GatherContextV2] Task type: ${taskType} for: "${userMessage.slice(0, 80)}"`);

  // ── EXECUTE: pass through — planSkills LLM handles context from conversationNote ──
  if (taskType === 'EXECUTE' && !state.forceSkillBuild) {
    logger.info('[Node:GatherContextV2] EXECUTE task — skipping gather, planSkills handles context');
    return {
      ...state,
      gatherContextSkipped: true,
      gatheredContext: {
        services: [],
        timezone: null,
        schedule: null,
        resolvedFacts: {},
        knownSecrets: [],
        links: [],
        resolvedAnswers: {},
        buildOnly: false,
      },
    };
  }

  // ── BUILD: credential capture loop ────────────────────────────────────────
  logger.info('[Node:GatherContextV2] BUILD task — starting credential capture');

  if (progressCallback) progressCallback({ type: 'thinking', message: 'Checking task details...' });

  const GAPS_PROMPT = loadPrompt('gather-gaps.md');
  if (!GAPS_PROMPT || !gatherAnswerCallback) {
    logger.warn('[Node:GatherContextV2] Missing prompt or callback — skipping BUILD gather');
    return { ...state, gatherContextSkipped: true };
  }

  const resolvedAnswers = {};
  const knownSecrets = [];
  const services = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let raw;
    try {
      raw = await llmBackend.generateAnswer(
        `Task: "${userMessage}"\n\nResolved so far: ${JSON.stringify(resolvedAnswers)}\n\nWhat single credential or piece of information is still missing to set up this background task? If nothing is missing, respond with: {"done":true}`,
        { context: { systemInstructions: GAPS_PROMPT } },
        { maxTokens: 200, temperature: 0 }
      );
    } catch (e) {
      logger.warn(`[Node:GatherContextV2] Gap LLM call failed round ${round}: ${e.message}`);
      break;
    }

    const parsed = parseJson(raw);
    if (!parsed || parsed.done) break;

    const question = parsed.question || parsed.ask;
    const field    = parsed.field || parsed.key;
    const isSecret = parsed.isSecret || parsed.is_secret || parsed.credential || false;

    if (!question || !field) break;

    if (progressCallback) progressCallback({ type: 'ask_user', question, source: 'gatherContextV2' });
    logger.info(`[Node:GatherContextV2] Round ${round + 1}: asking "${question}"`);

    let answer;
    try {
      answer = await Promise.race([
        gatherAnswerCallback(question),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), GATHER_TIMEOUT)),
      ]);
    } catch (e) {
      logger.warn(`[Node:GatherContextV2] Answer timeout/error: ${e.message}`);
      break;
    }

    if (!answer || String(answer).trim() === '') break;

    if (isSecret && gatherCredentialCallback) {
      try {
        await gatherCredentialCallback(field, String(answer).trim());
        knownSecrets.push(field);
        resolvedAnswers[field] = `[stored in keytar as "${field}"]`;
      } catch (e) {
        resolvedAnswers[field] = String(answer).trim();
      }
    } else {
      resolvedAnswers[field] = String(answer).trim();
    }
  }

  const _hasPhoneNumber = /\b\d{10,}\b/.test(userMessage);
  const _hasEmailTarget = /\bto\s+[\w._%+-]+@[\w.-]+\.[a-z]{2,}/i.test(userMessage);
  const _hasSayContent  = /\bsay(ing)?\s+["']?.{3,}/i.test(userMessage);
  const _hasAndSend     = /\band\s+(send|text|email|notify|tell|say)/i.test(userMessage);
  const buildOnly       = !(_hasPhoneNumber || _hasEmailTarget || _hasSayContent || _hasAndSend);

  const gatheredContext = {
    services,
    timezone: null,
    schedule: null,
    resolvedFacts: {},
    knownSecrets,
    links: [],
    resolvedAnswers,
    buildOnly,
  };

  logger.info('[Node:GatherContextV2] Context gathered', {
    resolvedAnswers: Object.keys(resolvedAnswers).length,
    knownSecrets: knownSecrets.length,
    buildOnly,
  });

  return { ...state, gatheredContext };
};

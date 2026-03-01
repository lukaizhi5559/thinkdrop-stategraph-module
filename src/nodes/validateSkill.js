/**
 * validateSkill Node — Validator Agent
 *
 * Reviews the draft .cjs skill from buildSkill with three layers:
 *
 *   1. STATIC CHECKS — fast regex rules (security, contract, placeholder detection)
 *   2. INTENT FULFILLMENT — LLM judges whether the code actually does what the user asked
 *      (semantic check: does it watch Gmail? does it send SMS? does it run on schedule?)
 *   3. CORRECTIVE FEEDBACK — not just a list of issues, but precise implementation
 *      instructions telling buildSkill exactly HOW to fix each problem. Optionally
 *      researches unknown APIs via browser.act before generating fix instructions.
 *
 * The feedback injected back into buildSkill mirrors the pattern from evaluateSkills →
 * planSkills: rich, actionable, implementation-level instructions — not vague complaints.
 *
 * State in:
 *   skillBuildDraft    — .cjs source string to validate
 *   skillBuildRequest  — { name, description, category, originalRequest? }
 *   skillBuildRound    — current cycle number
 *   skillBuildRounds   — history array of { round, issues, fixed }
 *   mcpAdapter         — optional, used for browser.act research
 *
 * State out (PASS):
 *   skillBuildPhase    — 'installing'
 *
 * State out (FAIL):
 *   skillBuildPhase    — 'fixing'  (if round < MAX_BUILD_ROUNDS)
 *                      — 'error'   (if round >= MAX_BUILD_ROUNDS)
 *   skillBuildFeedback — rich corrective instructions for Creator Agent
 *   skillBuildRounds   — updated with this round's result
 */

'use strict';

const https = require('https');

const MAX_BUILD_ROUNDS = 5;
const RESEARCH_TIMEOUT_MS = 15000;

// ── Layer 1: Static checks ────────────────────────────────────────────────────
// Fast regex rules — no LLM needed. Catch obvious problems immediately.

const STATIC_RULES = [
  {
    id: 'no-hardcoded-secrets',
    severity: 'error',
    test: (code) => {
      // Allow long strings that are clearly code patterns (URLs, base64 fragments in comments)
      const hardcoded = code.match(/(?:const|let|var)\s+\w*(?:key|token|secret|password|api_key|apikey)\w*\s*=\s*['"`][A-Za-z0-9_\-]{20,}['"`]/i);
      return !!hardcoded && !code.includes('keytar');
    },
    message: 'Hardcoded secret detected. Use keytar.getPassword(\'thinkdrop\', \'skill:<name>:<KEY>\') instead.',
  },
  {
    id: 'no-eval',
    severity: 'error',
    test: (code) => /\beval\s*\(/.test(code),
    message: 'eval() is forbidden in ThinkDrop skills — security violation.',
  },
  {
    id: 'no-new-function',
    severity: 'error',
    test: (code) => /new\s+Function\s*\(/.test(code),
    message: 'new Function() is forbidden — security violation.',
  },
  {
    id: 'must-export-function',
    severity: 'error',
    test: (code) => !/module\.exports\s*=/.test(code),
    message: 'Skill must export a function via module.exports = async (args) => ...',
  },
  {
    id: 'no-process-exit',
    severity: 'warning',
    test: (code) => /process\.exit\s*\(/.test(code),
    message: 'Do not call process.exit() — it will kill the ThinkDrop process.',
  },
  {
    id: 'timeout-present',
    severity: 'warning',
    test: (code) => {
      const hasNetwork = code.includes('http.') || code.includes('https.') || code.includes('fetch(');
      const hasTimeout = /setTimeout|timeoutMs|TIMEOUT_MS|AbortSignal/.test(code);
      return hasNetwork && !hasTimeout;
    },
    message: 'Network calls found but no timeout — add setTimeout or timeoutMs to prevent hanging.',
  },
  // ── Placeholder / stub detection ──────────────────────────────────────────
  {
    id: 'no-placeholder-hostname',
    severity: 'error',
    test: (code) => /example\.com|placeholder\.com|your-api\.com|api\.example|sms-api\.|fake-api\.|dummy\.api/i.test(code),
    message: 'Placeholder hostname detected (e.g. example.com, sms-api.example.com). Replace with the real API endpoint.',
  },
  {
    id: 'no-todo-stubs',
    severity: 'error',
    test: (code) => /\/\/\s*TODO|\/\*\s*TODO|\/\/\s*FIXME|\/\/\s*implement this|\/\/\s*add your/i.test(code),
    message: 'TODO/stub comment found — the implementation is incomplete. Replace all TODOs with working code.',
  },
  {
    id: 'no-fetch-in-cjs',
    severity: 'error',
    test: (code) => /\bfetch\s*\(/.test(code) && !code.includes('require(\'node-fetch\')') && !code.includes('require("node-fetch")'),
    message: 'fetch() is not available in Node CJS. Use const https = require(\'https\') for HTTP requests instead.',
  },
];

function runStaticChecks(code) {
  const issues = [];
  for (const rule of STATIC_RULES) {
    if (rule.test(code)) {
      issues.push({ severity: rule.severity, id: rule.id, message: rule.message });
    }
  }
  return issues;
}

// ── Layer 2: Intent fulfillment analysis ─────────────────────────────────────
// Extracts the capabilities the user's original request requires, then checks
// whether the draft code actually implements each one.

const INTENT_ANALYZER_PROMPT = `You are ThinkDrop's Skill Intent Analyzer. Your job is to compare what the user ASKED FOR against what the skill code ACTUALLY DOES.

Given the original user request and the skill code, determine:
1. What capabilities does the user need? (e.g. read Gmail, send SMS via Twilio, run on cron schedule, monitor files, etc.)
2. Does the code actually implement each capability? Be specific — check for real API usage, not just variable names.
3. Are there placeholder hostnames, fake URLs, or TODO stubs blocking functionality?
4. Are critical packages missing? (e.g. user wants SMS but code uses https to a fake endpoint instead of twilio)
5. Is scheduling/monitoring logic actually present if needed?

Output ONLY valid JSON:
{
  "requiredCapabilities": ["<capability 1>", "<capability 2>", ...],
  "implementedCapabilities": ["<capability 1>", ...],
  "missingCapabilities": ["<capability that is missing or broken>", ...],
  "placeholderIssues": ["<description of any fake URL/stub found>", ...],
  "verdict": "PASS" | "FAIL",
  "summary": "<one sentence overall assessment>"
}

PASS only if ALL required capabilities are implemented with real code (no placeholders, no TODOs, no fake hostnames).
FAIL if any required capability is missing, stubbed, or using a placeholder.`;

// ── Layer 3: Corrective feedback generator ────────────────────────────────────
// Given the list of failures from intent analysis + static checks, generates
// precise implementation instructions — not vague complaints but real code patterns.

const CORRECTIVE_FEEDBACK_PROMPT = `You are ThinkDrop's Skill Fix Advisor. A skill draft failed validation.

Your job is to produce PRECISE, ACTIONABLE implementation instructions that will allow the Creator Agent to fix every problem in one rewrite. Do NOT just list problems — provide the exact fix for each one, including:
- Which npm package to use (that IS pre-installed in ThinkDrop runtime)
- The exact require() call and API usage pattern
- The exact keytar key names to use for secrets
- Any cron schedule strings, API endpoint URLs, method signatures

## ThinkDrop pre-installed packages (Creator Agent can require these):
- keytar — macOS Keychain
- node-cron — cron scheduling
- googleapis — Google APIs (Gmail, Drive, Calendar)
- twilio — SMS via Twilio
- nodemailer — email sending
- axios — HTTP client
- All Node.js built-ins (fs, path, os, http, https, crypto, child_process, etc.)

## Output format
Output ONLY a structured fix brief — plain text, no JSON. Start each fix with "FIX [CATEGORY]:".
Be specific enough that the Creator Agent can implement directly without any guesswork.
Example:
FIX [SMS]: Replace the https request to sms-api.example.com with Twilio. Use:
  const twilio = require('twilio');
  const client = twilio(accountSid, authToken);
  await client.messages.create({ body: message, from: fromNumber, to: args.phoneNumber });
  Keytar keys: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

FIX [SCHEDULING]: Add node-cron for daily execution. Use:
  const cron = require('node-cron');
  let _job = null;
  // At top of module (outside exported function):
  // In exported function:
  if (_job) _job.stop();
  _job = cron.schedule(args.schedule || '0 21 * * *', async () => { /* main logic here */ });
  return { ok: true, output: 'Monitoring started — runs daily at 9pm' };`;

// ── Optional: Research via browser.act ───────────────────────────────────────
// When the validator identifies a missing capability and mcpAdapter is available,
// it can look up the correct API pattern online and inject it into the fix brief.

async function researchApiPattern(mcpAdapter, query, logger) {
  if (!mcpAdapter) return null;
  try {
    logger.info(`[Node:ValidateSkill] Researching: ${query}`);
    const sessionId = `validate-research-${Date.now()}`;

    // Use DuckDuckGo for quick lookups — no auth needed, reliable results
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query + ' nodejs example site:npmjs.com OR site:github.com OR site:stackoverflow.com')}&ia=web`;

    const navRes = await mcpAdapter.callService('command', 'command.automate', {
      skill: 'browser.act',
      args: { action: 'navigate', url: searchUrl, sessionId, timeoutMs: 10000 }
    }, { timeoutMs: 12000 }).catch(e => ({ ok: false, error: e.message }));

    const nav = navRes?.data || navRes;
    if (nav?.ok === false) return null;

    // Get page text
    const textRes = await mcpAdapter.callService('command', 'command.automate', {
      skill: 'browser.act',
      args: { action: 'getPageText', sessionId, timeoutMs: 8000 }
    }, { timeoutMs: 10000 }).catch(() => null);

    const text = textRes?.data?.result || textRes?.result || '';
    if (!text || text.length < 100) return null;

    // Return first 1500 chars of page text as research context
    return text.slice(0, 1500);
  } catch (err) {
    logger.warn(`[Node:ValidateSkill] Research failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ── Node ──────────────────────────────────────────────────────────────────────

async function validateSkill(state) {
  const logger = state.logger || console;
  const {
    skillBuildDraft,
    skillBuildRequest,
    skillBuildRound = 1,
    skillBuildRounds = [],
    progressCallback,
    mcpAdapter,
  } = state;

  const name = skillBuildRequest?.name || 'unknown';
  const originalRequest = skillBuildRequest?.originalRequest || skillBuildRequest?.description || '';
  logger.info(`[Node:ValidateSkill] Validating skill "${name}" (round ${skillBuildRound})`);

  if (!skillBuildDraft) {
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'No skill draft to validate.' };
  }

  if (progressCallback) {
    progressCallback({ type: 'skill_build_phase', phase: 'validating', skillName: name, round: skillBuildRound });
  }

  // ── Layer 1: Static checks ─────────────────────────────────────────────────
  const staticIssues = runStaticChecks(skillBuildDraft);
  logger.info(`[Node:ValidateSkill] Static checks: ${staticIssues.length} issue(s)`);

  const llm = state.llmBackend;
  if (!llm) {
    logger.warn('[Node:ValidateSkill] No llmBackend — using static checks only');
    return buildFailOrPassResult(state, staticIssues, staticIssues, 'Static checks only (no LLM)', name, skillBuildRound, skillBuildRounds, progressCallback, logger);
  }

  // ── Layer 2: Intent fulfillment analysis ───────────────────────────────────
  let intentVerdict = 'PASS';
  let missingCapabilities = [];
  let placeholderIssues = [];
  let intentSummary = '';
  let requiredCapabilities = [];

  try {
    const intentQuery = `Original user request: "${originalRequest}"\n\nSkill name: "${name}"\nSkill description: "${skillBuildRequest?.description || ''}"\n\nSkill code:\n\`\`\`js\n${skillBuildDraft.slice(0, 4000)}\n\`\`\``;
    const intentPayload = {
      query: intentQuery,
      context: {
        systemInstructions: INTENT_ANALYZER_PROMPT,
        sessionId: state.context?.sessionId,
        userId: state.context?.userId || 'default_user',
      },
    };
    const raw = await llm.generateAnswer(intentQuery, intentPayload, { maxTokens: 800, temperature: 0.1 });
    const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      intentVerdict = parsed.verdict || 'PASS';
      missingCapabilities = Array.isArray(parsed.missingCapabilities) ? parsed.missingCapabilities : [];
      placeholderIssues = Array.isArray(parsed.placeholderIssues) ? parsed.placeholderIssues : [];
      intentSummary = parsed.summary || '';
      requiredCapabilities = Array.isArray(parsed.requiredCapabilities) ? parsed.requiredCapabilities : [];
      logger.info(`[Node:ValidateSkill] Intent: ${intentVerdict} — ${intentSummary}`);
      if (missingCapabilities.length > 0) {
        logger.info(`[Node:ValidateSkill] Missing: ${missingCapabilities.join(', ')}`);
      }
    }
  } catch (err) {
    logger.warn(`[Node:ValidateSkill] Intent analysis failed: ${err.message}`);
  }

  // Build intent issues to merge with static issues
  const intentIssues = [
    ...missingCapabilities.map(cap => ({ severity: 'error', id: 'missing-capability', message: `Missing capability: ${cap}` })),
    ...placeholderIssues.map(ph => ({ severity: 'error', id: 'placeholder-detected', message: `Placeholder/stub: ${ph}` })),
  ];

  const allIssues = [
    ...staticIssues,
    ...intentIssues.filter(i => !staticIssues.some(s => s.message === i.message)),
  ];

  const hasErrors = allIssues.some(i => i.severity === 'error');
  const verdict = (hasErrors || intentVerdict === 'FAIL') ? 'FAIL' : 'PASS';

  logger.info(`[Node:ValidateSkill] Verdict: ${verdict} (${allIssues.length} issue(s))`);

  // Record this round
  const thisRound = { round: skillBuildRound, issues: allIssues, fixed: verdict === 'PASS' };
  const updatedRounds = [...skillBuildRounds, thisRound];

  if (progressCallback) {
    progressCallback({
      type: 'skill_validate_result',
      skillName: name,
      round: skillBuildRound,
      verdict,
      issues: allIssues,
      summary: intentSummary,
    });
  }

  if (verdict === 'PASS') {
    logger.info(`[Node:ValidateSkill] PASS — skill fulfills intent: ${intentSummary}`);
    return {
      ...state,
      skillBuildPhase: 'installing',
      skillBuildRounds: updatedRounds,
      skillBuildFeedback: null,
      skillBuildError: null,
    };
  }

  // ── FAIL path: generate corrective feedback ────────────────────────────────
  if (skillBuildRound >= MAX_BUILD_ROUNDS) {
    const errorSummary = allIssues
      .filter(i => i.severity === 'error')
      .map(i => `• ${i.message}`)
      .join('\n');
    logger.warn(`[Node:ValidateSkill] Max rounds (${MAX_BUILD_ROUNDS}) reached — aborting`);
    return {
      ...state,
      skillBuildPhase: 'error',
      skillBuildRounds: updatedRounds,
      skillBuildError: `Skill could not be validated after ${MAX_BUILD_ROUNDS} rounds.\n\nUnresolved errors:\n${errorSummary}`,
    };
  }

  // ── Layer 3: Research + generate rich corrective feedback ──────────────────
  // For each missing capability, optionally research the correct API pattern.
  let researchContext = '';
  if (mcpAdapter && missingCapabilities.length > 0) {
    // Research the most critical missing capability (first error)
    const primaryMissing = missingCapabilities[0];
    const researchQuery = `${primaryMissing} nodejs code example ${skillBuildRequest?.description || ''}`;
    const research = await researchApiPattern(mcpAdapter, researchQuery, logger);
    if (research) {
      researchContext = `\n\n## Research findings for "${primaryMissing}":\n${research}`;
      logger.info(`[Node:ValidateSkill] Research injected (${research.length} chars)`);
    }
  }

  // Build the fix brief — rich corrective instructions, not just an issue list
  let richFeedback = '';
  try {
    const allErrorMessages = allIssues
      .filter(i => i.severity === 'error')
      .map(i => `- ${i.message}`)
      .join('\n');

    const fixQuery = `The skill "${name}" failed validation with these errors:\n${allErrorMessages}\n\nOriginal user request: "${originalRequest}"\nSkill description: "${skillBuildRequest?.description || ''}"\n\nRequired capabilities: ${requiredCapabilities.join(', ') || 'see description'}\nMissing/broken: ${[...missingCapabilities, ...placeholderIssues].join(', ') || 'see errors above'}${researchContext}\n\nCurrent draft (first 3000 chars):\n\`\`\`js\n${skillBuildDraft.slice(0, 3000)}\n\`\`\``;

    const fixPayload = {
      query: fixQuery,
      context: {
        systemInstructions: CORRECTIVE_FEEDBACK_PROMPT,
        sessionId: state.context?.sessionId,
        userId: state.context?.userId || 'default_user',
      },
    };
    richFeedback = await llm.generateAnswer(fixQuery, fixPayload, { maxTokens: 1000, temperature: 0.1 });
    richFeedback = (richFeedback || '').trim();
    logger.info(`[Node:ValidateSkill] Generated ${richFeedback.length} chars of corrective feedback`);
  } catch (err) {
    logger.warn(`[Node:ValidateSkill] Fix brief generation failed: ${err.message} — using flat issue list`);
    // Fallback to flat issue list
    richFeedback = allIssues
      .map(i => `[${i.severity.toUpperCase()}]: ${i.message}`)
      .join('\n');
  }

  return {
    ...state,
    skillBuildPhase: 'fixing',
    skillBuildFeedback: richFeedback,
    skillBuildRound: skillBuildRound + 1,
    skillBuildRounds: updatedRounds,
    skillBuildError: null,
  };
}

// ── Helper: build PASS or static-only FAIL result ─────────────────────────────

function buildFailOrPassResult(state, staticIssues, allIssues, summary, name, skillBuildRound, skillBuildRounds, progressCallback, logger) {
  const hasErrors = allIssues.some(i => i.severity === 'error');
  const verdict = hasErrors ? 'FAIL' : 'PASS';
  const thisRound = { round: skillBuildRound, issues: allIssues, fixed: verdict === 'PASS' };
  const updatedRounds = [...skillBuildRounds, thisRound];

  if (progressCallback) {
    progressCallback({ type: 'skill_validate_result', skillName: name, round: skillBuildRound, verdict, issues: allIssues, summary });
  }

  if (verdict === 'PASS') {
    return { ...state, skillBuildPhase: 'installing', skillBuildRounds: updatedRounds, skillBuildFeedback: null, skillBuildError: null };
  }

  if (skillBuildRound >= MAX_BUILD_ROUNDS) {
    const errorSummary = allIssues.filter(i => i.severity === 'error').map(i => `• ${i.message}`).join('\n');
    return { ...state, skillBuildPhase: 'error', skillBuildRounds: updatedRounds, skillBuildError: `Skill could not be validated after ${MAX_BUILD_ROUNDS} rounds.\n\nUnresolved errors:\n${errorSummary}` };
  }

  const feedback = allIssues.map(i => `[${i.severity.toUpperCase()}]: ${i.message}`).join('\n');
  return { ...state, skillBuildPhase: 'fixing', skillBuildFeedback: feedback, skillBuildRound: skillBuildRound + 1, skillBuildRounds: updatedRounds, skillBuildError: null };
}

module.exports = { run: validateSkill };

/**
 * validateSkill Node — Validator Agent
 *
 * Reviews the draft .cjs skill from buildSkill. Checks:
 *   - Security: no hardcoded secrets, no eval/new Function, no path traversal
 *   - Contract compliance: correct export shape, args validation, error returns
 *   - Code quality: no infinite loops, timeouts present, keytar used for secrets
 *   - Dependency safety: only allowed built-ins + keytar
 *
 * State in:
 *   skillBuildDraft    — .cjs source string to validate
 *   skillBuildRequest  — { name, description, category, ... }
 *   skillBuildRound    — current cycle number
 *   skillBuildRounds   — history array of { round, issues, fixed }
 *
 * State out (PASS):
 *   skillBuildPhase    — 'installing'
 *
 * State out (FAIL — issues found):
 *   skillBuildPhase    — 'fixing'  (if round < MAX_BUILD_ROUNDS)
 *                      — 'error'   (if round >= MAX_BUILD_ROUNDS)
 *   skillBuildFeedback — formatted issue list string for Creator Agent
 *   skillBuildRounds   — updated with this round's result
 */

'use strict';

const MAX_BUILD_ROUNDS = 4;

// ── Static security checks (fast, no LLM needed) ─────────────────────────────

const STATIC_RULES = [
  {
    id: 'no-hardcoded-secrets',
    severity: 'error',
    pattern: /(['"`])[A-Za-z0-9_\-]{20,}['"`]/,
    message: 'Possible hardcoded secret or API key detected. Use keytar instead.',
    skip: (code) => code.includes('keytar') && !code.match(/const\s+\w*[Kk]ey\w*\s*=\s*['"`][A-Za-z0-9]{20,}['"`]/),
  },
  {
    id: 'no-eval',
    severity: 'error',
    pattern: /\beval\s*\(/,
    message: 'eval() is forbidden in ThinkDrop skills — security violation.',
  },
  {
    id: 'no-new-function',
    severity: 'error',
    pattern: /new\s+Function\s*\(/,
    message: 'new Function() is forbidden — security violation.',
  },
  {
    id: 'no-dynamic-require',
    severity: 'error',
    pattern: /require\s*\(\s*(?!['"`])/,
    message: 'Dynamic require() with variable input is forbidden.',
  },
  {
    id: 'must-export-function',
    severity: 'error',
    pattern: /module\.exports\s*=/,
    negate: true,
    message: 'Skill must export a function via module.exports = async (args) => ...',
  },
  {
    id: 'no-process-exit',
    severity: 'warning',
    pattern: /process\.exit\s*\(/,
    message: 'Do not call process.exit() — it will kill the ThinkDrop process.',
  },
  {
    id: 'no-fs-outside-home',
    severity: 'warning',
    pattern: /(?:readFileSync|writeFileSync|unlinkSync|rmSync)\s*\(\s*['"`]\/(?!Users|home)/,
    message: 'Accessing system paths outside home directory is discouraged.',
  },
  {
    id: 'timeout-present',
    severity: 'warning',
    pattern: /setTimeout|timeoutMs|TIMEOUT/,
    negate: true,
    message: 'No timeout found — add a default timeout to prevent hanging.',
    skip: (code) => !code.includes('http.') && !code.includes('https.') && !code.includes('fetch'),
  },
];

function runStaticChecks(code) {
  const issues = [];
  for (const rule of STATIC_RULES) {
    if (rule.skip && rule.skip(code)) continue;
    const matches = rule.negate ? !rule.pattern.test(code) : rule.pattern.test(code);
    if (matches) {
      issues.push({ severity: rule.severity, message: rule.message });
    }
  }
  return issues;
}

// ── LLM deep-review prompt ────────────────────────────────────────────────────

const VALIDATOR_SYSTEM_PROMPT = `You are ThinkDrop's Skill Validator Agent. Review the provided .cjs skill code for issues.

Check all of the following:
1. SECURITY: No hardcoded secrets/API keys/passwords. Secrets must use keytar.getPassword('thinkdrop', 'skill:<name>:<KEY>').
2. SECURITY: No eval(), new Function(), or dynamic require() with user input.
3. SECURITY: No path traversal outside args-provided paths.
4. CONTRACT: module.exports must be an async function accepting (args).
5. CONTRACT: Must return a string or { ok: boolean, output: string } shape on success.
6. CONTRACT: Must return { ok: false, error: '...' } on failure — never throw unhandled.
7. QUALITY: All network calls must have a timeout default (e.g. 10000ms).
8. QUALITY: All args must be validated before use.
9. QUALITY: No infinite loops or retry logic without a cap.
10. DEPENDENCY: Only require() built-in Node modules + keytar. No npm packages that aren't pre-installed.

Output ONLY valid JSON in this exact shape:
{
  "verdict": "PASS" | "FAIL",
  "issues": [
    { "severity": "error" | "warning" | "info", "line": <number or null>, "message": "<short description>" }
  ],
  "summary": "<one sentence — what the skill does and overall quality assessment>"
}

If verdict is PASS, issues array must be empty or contain only "info" items.
If verdict is FAIL, issues must contain at least one "error" item.`;

function buildValidatorPrompt(draft, request) {
  return `Review this ThinkDrop skill:\n\nSkill name: "${request.name}"\nDescription: "${request.description}"\n\n\`\`\`js\n${draft}\n\`\`\``;
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
  } = state;

  const name = skillBuildRequest?.name || 'unknown';
  logger.info(`[Node:ValidateSkill] Validating skill "${name}" (round ${skillBuildRound})`);

  if (!skillBuildDraft) {
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'No skill draft to validate.' };
  }

  if (progressCallback) {
    progressCallback({ type: 'skill_build_phase', phase: 'validating', skillName: name, round: skillBuildRound });
  }

  // Step 1: fast static checks
  const staticIssues = runStaticChecks(skillBuildDraft);
  logger.info(`[Node:ValidateSkill] Static checks: ${staticIssues.length} issues`);

  // Step 2: LLM deep review
  let llmVerdict = 'PASS';
  let llmIssues = [];
  let llmSummary = '';

  try {
    const llm = state.llmBackend;
    if (!llm) throw new Error('No llmBackend in state');
    const validatorQuery = buildValidatorPrompt(skillBuildDraft, skillBuildRequest);
    const validatorPayload = {
      query: validatorQuery,
      context: {
        systemInstructions: VALIDATOR_SYSTEM_PROMPT,
        sessionId: state.context?.sessionId,
        userId: state.context?.userId || 'default_user',
      },
    };
    const raw = await llm.generateAnswer(validatorQuery, validatorPayload, { maxTokens: 600, temperature: 0.1 });
    // Extract JSON (may be wrapped in markdown fences)
    const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      llmVerdict = parsed.verdict || 'PASS';
      llmIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
      llmSummary = parsed.summary || '';
    }
  } catch (err) {
    logger.warn(`[Node:ValidateSkill] LLM review failed: ${err.message} — using static checks only`);
  }

  // Combine issues — static errors take precedence
  const allIssues = [
    ...staticIssues,
    ...llmIssues.filter(i => !staticIssues.some(s => s.message === i.message)),
  ];

  const hasErrors = allIssues.some(i => i.severity === 'error');
  const verdict = (staticIssues.some(i => i.severity === 'error') || llmVerdict === 'FAIL') ? 'FAIL' : 'PASS';

  logger.info(`[Node:ValidateSkill] Verdict: ${verdict} (${allIssues.length} issues, ${hasErrors ? 'has errors' : 'no errors'})`);
  if (llmSummary) logger.info(`[Node:ValidateSkill] Summary: ${llmSummary}`);

  // Record this round
  const thisRound = {
    round: skillBuildRound,
    issues: allIssues,
    fixed: verdict === 'PASS',
  };
  const updatedRounds = [...skillBuildRounds, thisRound];

  if (progressCallback) {
    progressCallback({
      type: 'skill_validate_result',
      skillName: name,
      round: skillBuildRound,
      verdict,
      issues: allIssues,
      summary: llmSummary,
    });
  }

  if (verdict === 'PASS') {
    return {
      ...state,
      skillBuildPhase: 'installing',
      skillBuildRounds: updatedRounds,
      skillBuildFeedback: null,
      skillBuildError: null,
    };
  }

  // FAIL path
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

  // Format feedback for Creator Agent
  const feedback = allIssues
    .map(i => `[${i.severity.toUpperCase()}]${i.line != null ? ` L${i.line}` : ''}: ${i.message}`)
    .join('\n');

  return {
    ...state,
    skillBuildPhase: 'fixing',
    skillBuildFeedback: feedback,
    skillBuildRound: skillBuildRound + 1,
    skillBuildRounds: updatedRounds,
    skillBuildError: null,
  };
}

module.exports = { run: validateSkill };

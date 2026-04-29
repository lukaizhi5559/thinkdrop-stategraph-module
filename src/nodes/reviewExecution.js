/**
 * Review Execution Node
 *
 * Post-run outcome reviewer. Sits between executeCommand and evaluateSkills.
 * Catches false-positive step completions that fooled exit-code checks —
 * e.g. `gh repo view ... && echo 'done' || gh repo star ...` where the
 * mutation (||) branch never fires because the read command always exits 0.
 *
 * Flow:
 *   1. LLM analysis — inspect all skillResults, flag suspicious steps
 *   2. Shell verification — for each flagged step, run a follow-up command
 *      to confirm or disprove the stated outcome in actual system state
 *   3. Route:
 *      UNVERIFIABLE / VERIFIED  → evaluateSkills (normal path)
 *      FAILED (first pass)      → patch args, reset cursor, back to executeCommand
 *      FAILED (second pass)     → buildPartialSummary → logConversation (ASK_USER)
 *      TOO_MANY_SUSPICIOUS      → buildPartialSummary → logConversation (ASK_USER)
 *      ASK_USER (no patch)      → buildPartialSummary → logConversation
 *
 * State inputs:
 *   state.skillPlan        — full plan array
 *   state.skillResults     — accumulated results from executeCommand
 *   state.reviewRetryCount — how many times this node has patched already (default 0)
 *
 * State outputs:
 *   state.reviewVerdict    — 'UNVERIFIABLE' | 'VERIFIED' | 'FAILED' | 'ASK_USER'
 *   On FAILED:
 *     state.skillPlan      — patched with corrected command at stepIndex
 *     state.skillCursor    — reset to patched step index
 *     state.skillResults   — trimmed to steps before the patched step
 *     state.commandExecuted / state.answer — cleared
 *   On ASK_USER:
 *     state.answer         — structured partial summary for the user
 */

const fs = require('fs');
const path = require('path');

function loadReviewPrompt() {
  try {
    return fs.readFileSync(
      path.join(__dirname, '../prompts/review-execution.md'),
      'utf8'
    ).trim();
  } catch (_) { return null; }
}

const REVIEW_SYSTEM_PROMPT = loadReviewPrompt() ||
  `You are an automation step reviewer. Analyze all step results and determine whether each step's output proves its action was performed. Output ONLY valid JSON.`;

// Auto-patch is only safe for a small number of suspicious steps.
// If more than this many steps look wrong, the plan is likely broken at a higher
// level and the user needs to be informed rather than the system patching blindly.
const MAX_AUTO_PATCH_COUNT = 2;

/**
 * Build a human-readable partial result summary from skillResults.
 * Pure JS — no LLM call, never fails.
 */
function buildPartialSummary(userMessage, skillResults, suspiciousDetails) {
  const confirmed = [];
  const suspicious = [];

  for (const r of (skillResults || [])) {
    const label = `${r.skill}${r.args?.action ? '/' + r.args.action : ''}`;
    const output = String(r.stdout || r.result || '').trim();
    const sd = (suspiciousDetails || []).find(s => s.stepIndex === (r.step - 1));

    if (sd) {
      const preview = output ? ` — output was: "${output.slice(0, 150)}"` : '';
      suspicious.push(`• Step ${r.step} (${label}): ${sd.reason}${preview}`);
    } else if (r.ok !== false) {
      const preview = output ? ` — "${output.slice(0, 120)}"` : '';
      confirmed.push(`• Step ${r.step} (${label}): completed${preview}`);
    }
  }

  const lines = [
    `I ran the task but could not confirm all actions were completed successfully.`,
    '',
  ];

  if (confirmed.length > 0) {
    lines.push(`**Confirmed completed:**`);
    lines.push(...confirmed);
    lines.push('');
  }

  if (suspicious.length > 0) {
    lines.push(`**Could not verify:**`);
    lines.push(...suspicious);
    lines.push('');
  }

  lines.push(`Please check the current state and let me know how you'd like to proceed.`);
  return lines.join('\n');
}

/**
 * Ask the LLM to judge whether the user's goal was fulfilled,
 * given the current page ARIA snapshot, synthesize summary, and original prompt.
 * Returns { fulfilled: boolean, reason: string } or null if the LLM call fails.
 */
async function assessBrowserFulfillment(userMessage, synthesizeOutput, snapshot, llmBackend, context, logger) {
  const snapshotExcerpt = snapshot ? snapshot.slice(0, 3000) : '(no page content available)';
  const synthExcerpt = synthesizeOutput ? synthesizeOutput.slice(0, 2000) : '(none)';

  const query = `USER GOAL: "${userMessage}"

CURRENT PAGE TEXT CONTENT:
${snapshotExcerpt}

SYNTHESIZE OUTPUT (what the system reported back):
${synthExcerpt}

Based on the current page content and synthesize output, was the user's goal FULFILLED?
Rules:
- If the page shows a sign-in page, login form, or auth wall → NOT fulfilled
- If the page and synthesize output clearly contain the specific data the user asked for → FULFILLED
- If the synthesize output is vague/hollow ("no information available", "could not retrieve", etc.) → NOT fulfilled
- If the page text doesn't match what was asked (e.g. user asked for channel videos but page shows search results) → NOT fulfilled
- If the synthesize output is a plausible answer AND the page confirms the right content is showing → FULFILLED

Output ONLY valid JSON: { "fulfilled": true, "reason": "one sentence" }
or: { "fulfilled": false, "reason": "one sentence explaining why not" }`;

  try {
    const raw = await llmBackend.generateAnswer(query, {
      query,
      context: {
        systemInstructions: 'You are a task fulfillment judge. Evaluate whether the user\'s goal was achieved based on the current page state and the system\'s summary. Output ONLY valid JSON.',
        sessionId: context?.sessionId,
        userId: context?.userId || 'default_user',
      },
    }, { maxTokens: 150, temperature: 0.1, fastMode: true });

    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('no JSON in response');
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.fulfilled !== 'boolean') throw new Error('missing fulfilled field');
    return { fulfilled: parsed.fulfilled, reason: String(parsed.reason || '') };
  } catch (err) {
    logger.warn(`[Node:ReviewExecution] assessBrowserFulfillment failed: ${err.message} — falling back to regex`);
    return null;
  }
}

module.exports = async function reviewExecution(state) {
  const {
    mcpAdapter, llmBackend,
    message, resolvedMessage,
    skillPlan = [], skillResults = [],
    reviewRetryCount = 0,
    progressCallback, context,
  } = state;

  const logger = state.logger || console;
  const userMessage = resolvedMessage || message;

  // Nothing to review
  if (!skillResults || skillResults.length === 0) {
    logger.info('[Node:ReviewExecution] No skill results — skipping');
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  // ── Multi-intent queue: skip deep review for intermediate steps ────────────
  // When more sub-intents are queued, suppress ASK_USER/retry loops so the
  // pipeline keeps moving. Issues surface in summarizeMultiIntent at the end.
  const isQueuedStep = state.isMultiIntent &&
    Array.isArray(state.intentQueue) &&
    state.intentQueue.length > 0;
  if (isQueuedStep) {
    logger.info('[Node:ReviewExecution] Mid-queue step — skipping deep review to keep pipeline moving');
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  // Second pass — a patch was applied last time but re-verification still failed.
  // Don't loop: surface what we know to the user.
  if (reviewRetryCount > 0) {
    logger.info(`[Node:ReviewExecution] Second pass (retryCount=${reviewRetryCount}) — surfacing to user`);
    const answer = buildPartialSummary(userMessage, skillResults, []);
    return { ...state, reviewVerdict: 'ASK_USER', answer };
  }

  // ── Browser-only fulfillment check ─────────────────────────────────────────────
  // For browser-only plans: capture the current page ARIA snapshot via playwright-cli,
  // then pass (original user goal + synthesize output + snapshot) to the LLM to judge
  // whether the task was actually fulfilled.
  // Regex hollow patterns serve as a fast-path fallback when the LLM is unavailable.
  // cli.agent results carry exitCode/stdout/ok just like shell.run — include them
  // so CLI-only plans route to the LLM shell-review path, not the browser-snapshot path.
  const shellSteps = skillResults.filter(r => r.skill === 'shell.run' || r.skill === 'cli.agent');
  if (shellSteps.length === 0) {
    // Extract synthesize output
    const synthesizeStep = skillResults.find(r => r.skill === 'synthesize' && r.ok !== false);
    const synthesizeOutput = synthesizeStep
      ? String(synthesizeStep.stdout || synthesizeStep.result || '')
      : '';

    // Regex fast-path — obvious hollow signals, no LLM call needed
    const HOLLOW = [
      /no information available/,
      /sign.?in page/,
      /login page/,
      /not logged in/,
      /no access to (the )?inbox/,
      /could not (retrieve|access|find|get)/,
      /unable to (retrieve|access|find|get)/,
      /no (email|content|data|result).{0,40}(found|retrieved|available)/,
      /extraction.{0,40}not possible/,
    ];
    const regexHollow = synthesizeOutput
      ? HOLLOW.some(p => p.test(synthesizeOutput.toLowerCase()))
      : false;

    let isHollow = regexHollow;
    let hollowReason = 'Synthesize reported it could not retrieve the requested information (possibly stuck on a login page or auth wall)';

    // LLM + snapshot — primary judge when backend is available
    if (mcpAdapter && llmBackend) {
      // Derive sessionId from the last browser.act step
      const browserSessionId = state.activeBrowserSessionId
        || skillResults.slice().reverse().find(r => r.skill === 'browser.act' && r.args?.sessionId)?.args?.sessionId;

      // Capture current page text for fulfillment judgment.
      // getPageText returns visible page content (vs. ARIA tree from scanCurrentPage which
      // is often only a few hundred chars and too sparse for the LLM to judge correctly).
      let snapshot = null;
      if (browserSessionId) {
        try {
          const snapRes = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'browser.act',
            args: { action: 'getPageText', sessionId: browserSessionId },
          }, { timeoutMs: 12000 });
          const snapData = snapRes?.data || snapRes;
          const rawSnap = snapData?.result?.stdout || snapData?.stdout || snapData?.result || null;
          snapshot = rawSnap ? String(rawSnap) : null;
          // If snapshot is suspiciously small (< 300 chars) it's likely just chrome UI chrome — treat as unavailable
          if (snapshot && snapshot.length < 300) {
            logger.warn(`[Node:ReviewExecution] Page text too small (${snapshot.length} chars) — treating as unavailable`);
            snapshot = null;
          }
          logger.info(`[Node:ReviewExecution] Page text captured for session=${browserSessionId} (${(snapshot || '').length} chars)`);
        } catch (snapErr) {
          logger.warn(`[Node:ReviewExecution] Page text capture failed: ${snapErr.message}`);
        }
      }

      // Ask LLM: was the goal fulfilled given prompt + synthesize + current page snapshot?
      const judgment = await assessBrowserFulfillment(
        userMessage, synthesizeOutput, snapshot, llmBackend, context, logger
      );

      if (judgment !== null) {
        // LLM judgment overrides regex
        isHollow = !judgment.fulfilled;
        hollowReason = judgment.reason || hollowReason;
      }
      // If judgment is null (LLM error), regexHollow from above remains the fallback
    }

    if (isHollow) {
      if (reviewRetryCount === 0) {
        // First pass: give recoverSkill a chance to REPLAN with a better strategy.
        // Build a synthetic failedStep from the last browser/agent step so recoverSkill
        // has enough context to produce a useful REPLAN suggestion.
        const lastBrowserStep = skillResults.slice().reverse().find(
          r => r.skill === 'playwright.agent' || r.skill === 'browser.agent' || r.skill === 'browser.act'
        ) || skillResults[skillResults.length - 1];

        const syntheticFailedStep = {
          step: lastBrowserStep?.step || skillResults.length,
          skill: lastBrowserStep?.skill || 'playwright.agent',
          args: lastBrowserStep?.args || {},
          error: hollowReason,
          exitCode: 0,
          stderr: '',
          _hollowResult: true,
        };

        logger.warn(`[Node:ReviewExecution] Hollow result (pass 1) — routing to recoverSkill for REPLAN: ${hollowReason}`);
        return {
          ...state,
          reviewVerdict: 'FAILED',
          reviewRetryCount: 1,
          failedStep: syntheticFailedStep,
        };
      }

      // Second pass: still hollow after retry — surface to user
      logger.warn(`[Node:ReviewExecution] Task not fulfilled after retry — routing to ASK_USER: ${hollowReason}`);
      const synthIdx = skillResults.findIndex(r => r.skill === 'synthesize');
      const answer = buildPartialSummary(userMessage, skillResults, [{
        stepIndex: synthIdx >= 0 ? synthIdx : skillResults.length - 1,
        reason: hollowReason,
      }]);
      return { ...state, reviewVerdict: 'ASK_USER', answer };
    }

    logger.info('[Node:ReviewExecution] Browser-only plan — task fulfilled (snapshot+LLM check passed)');
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  if (!llmBackend) {
    logger.warn('[Node:ReviewExecution] No llmBackend — skipping review');
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  if (progressCallback) progressCallback({ type: 'reviewing', message: 'Verifying step outcomes...' });

  // ── Phase 1: LLM analysis ────────────────────────────────────────────────────

  const stepLog = skillResults.map((r, i) => {
    const lines = [
      `Step ${i + 1} (index ${i}): ${r.skill}${r.args?.action ? '/' + r.args.action : ''} | ok=${r.ok !== false}`,
    ];
    if (r.args) lines.push(`  intent: ${JSON.stringify(r.args).slice(0, 250)}`);
    if (r.exitCode != null) lines.push(`  exitCode: ${r.exitCode}`);
    const out = String(r.stdout || r.result || '').trim();
    lines.push(`  stdout: ${out ? out.slice(0, 400) : '(empty)'}`);
    if (r.error) lines.push(`  error: ${String(r.error).slice(0, 200)}`);
    return lines.join('\n');
  }).join('\n\n');

  const reviewQuery = `USER GOAL: "${userMessage}"

STEP RESULTS:
${stepLog}

Output ONLY valid JSON.`;

  let raw = '';
  try {
    raw = await llmBackend.generateAnswer(reviewQuery, {
      query: reviewQuery,
      context: {
        systemInstructions: REVIEW_SYSTEM_PROMPT,
        sessionId: context?.sessionId,
        userId: context?.userId || 'default_user',
      }
    }, { maxTokens: 600, temperature: 0.1, fastMode: false });
  } catch (llmErr) {
    logger.warn(`[Node:ReviewExecution] LLM call failed (non-fatal): ${llmErr.message} — skipping`);
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  let review;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON found');
    review = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    logger.warn(`[Node:ReviewExecution] JSON parse failed: ${parseErr.message} — skipping`);
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  const suspiciousCount = Array.isArray(review.suspiciousSteps) ? review.suspiciousSteps.length : 0;
  logger.info(`[Node:ReviewExecution] LLM verdict: ${review.verdict}${suspiciousCount ? ` (${suspiciousCount} suspicious steps)` : ''}`);

  if (review.verdict === 'PASS' || suspiciousCount === 0) {
    logger.info('[Node:ReviewExecution] LLM says all steps verified → UNVERIFIABLE (pass-through)');
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  const suspiciousSteps = review.suspiciousSteps;

  // Too many suspicious steps — auto-patching N commands is risky and signals
  // a structurally broken plan. Surface everything to the user instead.
  const tooMany = suspiciousSteps.length > MAX_AUTO_PATCH_COUNT ||
    suspiciousSteps.length >= Math.ceil(skillResults.length / 2);

  if (tooMany) {
    logger.warn(`[Node:ReviewExecution] ${suspiciousSteps.length}/${skillResults.length} steps flagged — too many to auto-patch → ASK_USER`);
    const answer = buildPartialSummary(userMessage, skillResults, suspiciousSteps);
    return { ...state, reviewVerdict: 'ASK_USER', answer };
  }

  // ── Phase 2: Shell verification ────────────────────────────────────────────

  const failedChecks = [];

  for (const s of suspiciousSteps) {
    if (!s.verificationCmd || !Array.isArray(s.verificationArgv)) {
      logger.info(`[Node:ReviewExecution] Step ${s.stepIndex + 1}: no verificationCmd — skipping shell check`);
      continue;
    }

    try {
      const argvPreview = s.verificationArgv.join(' ').slice(0, 100);
      logger.info(`[Node:ReviewExecution] Verifying step ${s.stepIndex + 1}: ${s.verificationCmd} ${argvPreview}`);

      const result = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'shell.run',
        args: { cmd: s.verificationCmd, argv: s.verificationArgv }
      }, { timeoutMs: 15000 });

      const raw = result?.data || result;
      const stdout = String(raw?.stdout || raw?.result || '').trim();
      const verified = s.expectedPattern
        ? stdout.includes(s.expectedPattern)
        : raw?.ok !== false;

      logger.info(`[Node:ReviewExecution] Step ${s.stepIndex + 1} check: stdout="${stdout.slice(0, 120)}" verified=${verified}`);

      if (!verified) {
        failedChecks.push({ ...s, actualStdout: stdout });
      }
    } catch (verErr) {
      logger.warn(`[Node:ReviewExecution] Step ${s.stepIndex + 1} verification error: ${verErr.message} — skipping`);
    }
  }

  if (failedChecks.length === 0) {
    logger.info('[Node:ReviewExecution] All suspicious steps verified OK → VERIFIED');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── Phase 3: Patch and re-execute ─────────────────────────────────────────

  const toFix = failedChecks[0];
  const stepIdx = toFix.stepIndex;

  // If the LLM couldn't provide a patch, surface to user with full summary
  if (toFix.patchedCmd == null || !Array.isArray(toFix.patchedArgv)) {
    logger.warn(`[Node:ReviewExecution] Step ${stepIdx + 1} failed verification but no patchedCmd provided → ASK_USER`);
    const answer = buildPartialSummary(userMessage, skillResults, failedChecks);
    return { ...state, reviewVerdict: 'ASK_USER', answer };
  }

  const patchPreview = toFix.patchedArgv.join(' ').slice(0, 120);
  logger.info(`[Node:ReviewExecution] Patching step ${stepIdx + 1}: ${toFix.patchedCmd} ${patchPreview}`);

  // Apply the LLM's corrected command into the plan at the failing step index
  const patchedPlan = skillPlan.map((step, i) => {
    if (i !== stepIdx) return step;
    return {
      ...step,
      args: {
        ...step.args,
        cmd: toFix.patchedCmd,
        argv: toFix.patchedArgv,
      },
      _reviewPatched: true,
    };
  });

  // Trim skillResults to only steps before the patched step, then reset cursor.
  // executeCommand will re-run from stepIdx with the corrected command.
  const trimmedResults = (skillResults || []).filter(r => (r.step - 1) < stepIdx);

  return {
    ...state,
    reviewVerdict: 'FAILED',
    reviewRetryCount: reviewRetryCount + 1,
    skillPlan: patchedPlan,
    skillCursor: stepIdx,
    skillResults: trimmedResults,
    commandExecuted: false,
    answer: undefined,
    failedStep: null,
  };
};

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
 *      CORRECTED                → logConversation (answer corrected from page text, no replan)
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
 *   state.reviewVerdict    — 'UNVERIFIABLE' | 'VERIFIED' | 'FAILED' | 'ASK_USER' | 'CORRECTED'
 *   On CORRECTED:
 *     state.answer         — corrected answer generated from fresh page text
 *     state.skillResults   — synthesize result replaced with corrected answer
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
const { parseLlmJson } = require('../utils/parseLlmJson');

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
 * Detect answer-only contradictions: the page text contains the real answer
 * but the synthesize output disagrees. If detected, generate a corrected
 * synthesis directly from the page text — no replan needed.
 * Returns { corrected: boolean, answer: string, reason: string } or null.
 *
 * Uses the single-number pattern: fast call returns 0 (no contradiction) or 1 (contradiction).
 * Only on 1 (contradiction) does it run the full JSON generation to extract correctedAnswer.
 * Safe default on failure: null (caller falls through to replan, same as existing fail-open).
 */
async function assessAnswerContradiction(userMessage, synthesizeOutput, pageText, llmBackend, context, logger) {
  if (!pageText || pageText.length < 50) return null;
  if (!synthesizeOutput || synthesizeOutput.length < 5) return null;

  // ── Fast decision: is there a contradiction? ─────────────────────────────
  const decisionSystemPrompt = `You are a fact-checking judge. Compare the synthesized answer against fresh page text.
Return ONLY a single number — nothing else:
  0 = NO CONTRADICTION (synthesize output agrees with page text, or both are empty/vague)
  1 = CONTRADICTION (page text has the real answer but synthesize output disagrees, is wrong, or is hollow)

Decision rules:
- If the user asked "how many" and the page shows a different count than synthesized → 1
- If the user asked for specific data and the page has it but synthesis reported wrong data → 1
- If the synthesize output is vague/hollow but the page text contains the actual answer → 1
- If both agree → 0
- When in doubt → 0`;

  const decisionUserPrompt = `USER GOAL: "${userMessage}"

CURRENT PAGE TEXT (freshly captured from browser):
${pageText.slice(0, 4000)}

SYNTHESIZE OUTPUT (what the system reported to the user):
${synthesizeOutput.slice(0, 2000)}

Contradiction? (0 or 1)`;

  let hasContradiction = false;
  try {
    const raw = await llmBackend.generateAnswer(decisionUserPrompt, {
      query: decisionUserPrompt,
      context: {
        systemInstructions: decisionSystemPrompt,
        sessionId: context?.sessionId,
        userId: context?.userId || 'default_user',
      },
    }, { maxTokens: 5, temperature: 0.1, fastMode: true, taskType: 'classification' });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    hasContradiction = num === 1;
    logger.info(`[Node:ReviewExecution] assessAnswerContradiction decision: ${hasContradiction ? 'CONTRADICTION' : 'NO_CONTRADICTION'} (raw="${(raw || '').trim()}")`);
  } catch (err) {
    logger.warn(`[Node:ReviewExecution] assessAnswerContradiction decision failed: ${err.message}`);
    return null;
  }

  if (!hasContradiction) {
    return { corrected: false, reason: 'no contradiction detected' };
  }

  // ── Generation: extract the corrected answer from page text ──────────────
  const genQuery = `USER GOAL: "${userMessage}"

CURRENT PAGE TEXT (freshly captured from browser):
${pageText.slice(0, 4000)}

SYNTHESIZE OUTPUT (what the system reported to the user):
${synthesizeOutput.slice(0, 2000)}

A CONTRADICTION was detected. Write the CORRECT answer based ONLY on the page text.

Output ONLY valid JSON:
{ "contradiction": true, "correctedAnswer": "<the correct answer based on page text>", "reason": "<one sentence>" }`;

  try {
    const raw = await llmBackend.generateAnswer(genQuery, {
      query: genQuery,
      context: {
        systemInstructions: 'You are a fact-checking judge. A contradiction was detected between the synthesized answer and the page text. Produce the correct answer from the page text only. Output ONLY valid JSON.',
        sessionId: context?.sessionId,
        userId: context?.userId || 'default_user',
      },
    }, { maxTokens: 300, temperature: 0.1, fastMode: true, taskType: 'classification' });

    const parsed = parseLlmJson(raw, logger, 'Node:ReviewExecution:assessAnswer');
    if (!parsed) throw new Error('no JSON in response');
    if (parsed.contradiction === true && parsed.correctedAnswer) {
      return { corrected: true, answer: String(parsed.correctedAnswer), reason: String(parsed.reason || '') };
    }
    return { corrected: false, reason: String(parsed.reason || '') };
  } catch (err) {
    logger.warn(`[Node:ReviewExecution] assessAnswerContradiction generation failed: ${err.message}`);
    return null;
  }
}

/**
 * Ask the LLM to judge whether the user's goal was fulfilled,
 * given the current page ARIA snapshot, synthesize summary, and original prompt.
 * Returns { fulfilled: boolean, reason: string } or null if the LLM call fails.
 *
 * Uses the single-number pattern: LLM returns 0 (FULFILLED) or 1 (NOT_FULFILLED).
 * Safe default on failure: null (caller falls back to regex hollow check).
 */
async function assessBrowserFulfillment(userMessage, synthesizeOutput, snapshot, llmBackend, context, logger) {
  const snapshotExcerpt = snapshot ? snapshot.slice(0, 3000) : '(no page content available)';
  const synthExcerpt = synthesizeOutput ? synthesizeOutput.slice(0, 2000) : '(none)';

  const systemPrompt = `You are a task fulfillment judge. Evaluate whether the user's goal was achieved based on the current page state and the system's summary.
Return ONLY a single number — nothing else:
  0 = FULFILLED (goal achieved — page shows the right content, synthesize output is a real answer)
  1 = NOT_FULFILLED (auth wall, wrong page, hollow/vague output, page doesn't match what was asked)

Decision rules:
- If the page shows a sign-in page, login form, or auth wall → 1
- If the page and synthesize output clearly contain the specific data the user asked for → 0
- If the synthesize output is vague/hollow ("no information available", "could not retrieve", etc.) → 1
- If the page text doesn't match what was asked (e.g. user asked for channel videos but page shows search results) → 1
- If the synthesize output is a plausible answer AND the page confirms the right content is showing → 0`;

  const userPrompt = `USER GOAL: "${userMessage}"

CURRENT PAGE TEXT CONTENT:
${snapshotExcerpt}

SYNTHESIZE OUTPUT (what the system reported back):
${synthExcerpt}

Fulfilled? (0 or 1)`;

  try {
    const raw = await llmBackend.generateAnswer(userPrompt, {
      query: userPrompt,
      context: {
        systemInstructions: systemPrompt,
        sessionId: context?.sessionId,
        userId: context?.userId || 'default_user',
      },
    }, { maxTokens: 5, temperature: 0.1, fastMode: true, taskType: 'classification' });

    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (isNaN(num) || (num !== 0 && num !== 1)) {
      throw new Error(`invalid response: "${(raw || '').trim()}"`);
    }
    const fulfilled = num === 0;
    logger.info(`[Node:ReviewExecution] assessBrowserFulfillment: fulfilled=${fulfilled} (raw="${(raw || '').trim()}")`);
    return { fulfilled, reason: fulfilled ? 'goal achieved' : 'not fulfilled' };
  } catch (err) {
    logger.warn(`[Node:ReviewExecution] assessBrowserFulfillment failed: ${err.message} — falling back to regex`);
    return null;
  }
}

/**
 * Fast number-based LLM decision (PASS/VERIFY_NEEDED) for reviewExecution.
 * Modeled on browser.agent _decisionCall: "Return ONLY a single number".
 * Replaces the 300-token JSON review call for the common PASS case.
 * Only when VERIFY_NEEDED (1) is returned does the caller run the full JSON
 * generation to extract suspiciousSteps.
 * Safe default on parse failure/timeout: 0 (PASS) — matches existing fail-open.
 */
async function _reviewDecision(llmBackend, userMessage, stepLog, context, state, logger) {
  const systemPrompt = `You are an automation step reviewer. Did all steps produce output that proves their actions were performed correctly?
Return ONLY a single number — nothing else:
  0 = PASS (all steps verified — outputs match intended actions, no suspicious results)
  1 = VERIFY_NEEDED (one or more steps have hollow/missing/contradictory output that needs verification)

Decision rules:
- If all step outputs are non-empty and consistent with the intended action → 0
- If any step output is empty, hollow, or contradicts the expected result → 1
- If the user goal was clearly achieved by the step results → 0
- When in doubt → 0`;

  const userPrompt = `USER GOAL: "${userMessage}"

STEP RESULTS:
${stepLog}

Verdict? (0 or 1)`;

  try {
    const raw = await llmBackend.generateAnswer(userPrompt, {
      query: userPrompt,
      context: {
        systemInstructions: systemPrompt,
        sessionId: context?.sessionId,
        userId: context?.userId || 'default_user',
        intent: state.intent?.type || 'command_automate',
      }
    }, { maxTokens: 5, temperature: 0.1, fastMode: true, taskType: 'classification' });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    const result = (num === 0 || num === 1) ? num : 0;
    logger.info(`[Node:ReviewExecution] _reviewDecision: verdict=${result === 0 ? 'PASS' : 'VERIFY_NEEDED'} (raw="${(raw || '').trim()}")`);
    return result;
  } catch (e) {
    logger.warn(`[Node:ReviewExecution] _reviewDecision failed: ${e.message} — defaulting to 0 (PASS)`);
    return 0;
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

  // ── external.skill short-circuit ────────────────────────────────────────────
  // external.skill returns a structured object (e.g. { success: true, navigatedTo: "..." }).
  // It does NOT produce page text — content-based hollow checks must never fire on these
  // results. If any external.skill step succeeded, treat the plan as VERIFIED.
  const _hasExternalSkillSuccess = skillResults.some(r =>
    r.skill === 'external.skill' && (r.success === true || r.ok === true)
  );
  if (_hasExternalSkillSuccess) {
    logger.info('[Node:ReviewExecution] external.skill step succeeded — skipping hollow check (structured result, no page text)');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── meta-skill short-circuit ──────────────────────────────────────────────
  // api_suggest, needs_skill, schedule, ask_user are UI card primitives — they surface
  // a question/offer to the user and return ok:true. They produce no browser page output
  // by design. If the entire plan consists of meta-skills and at least one api_suggest or
  // needs_skill card was successfully surfaced, the task is VERIFIED (the card IS the result).
  const _META_SKILLS_SET = new Set(['synthesize', 'ask_user', 'schedule', 'needs_skill', 'api_suggest', 'project.launcher', 'project.stopper']);
  const _allMetaSkills = skillResults.length > 0 && skillResults.every(r => _META_SKILLS_SET.has(r.skill));
  const _hasUiCardSuccess = skillResults.some(r => (r.skill === 'api_suggest' || r.skill === 'needs_skill') && r.ok !== false);
  if (_allMetaSkills && _hasUiCardSuccess) {
    logger.info('[Node:ReviewExecution] api_suggest/needs_skill surfaced successfully — skipping hollow check (UI card, no page output expected)');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── video.agent short-circuit ─────────────────────────────────────────────
  // video.agent returns a structured result (transcript, steps, stdout) — not browser
  // page text. Content-based hollow checks must never fire on these results.
  // A successful run with non-empty stdout is sufficient to treat as VERIFIED.
  const _hasVideoAgentSuccess = skillResults.some(r =>
    r.skill === 'video.agent' && r.ok === true && String(r.stdout || '').trim().length > 0
  );
  if (_hasVideoAgentSuccess) {
    logger.info('[Node:ReviewExecution] video.agent step succeeded — skipping hollow check (structured transcript result, no page text)');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── schedule short-circuit ────────────────────────────────────────────────
  // schedule steps produce no page content by design — the deferred steps run
  // later via the skill-scheduler when the reminder fires.
  // Content-based hollow checks must NEVER fire on schedule-only results.
  const _hasScheduleSuccess = skillResults.some(r =>
    r.skill === 'schedule' && r.ok !== false
  );
  if (_hasScheduleSuccess) {
    logger.info('[Node:ReviewExecution] schedule step succeeded — skipping hollow check (deferred execution, no page text)');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── Synthesize/notification short-circuit ───────────────────────────────────
  // For scheduling tasks (reminders, alerts, notifications), a synthesize step
  // that produces a non-empty message IS the deliverable. There is no browser
  // page to verify and no shell output to inspect. Treat it as VERIFIED to avoid
  // a false-hollow REPLAN loop.
  //
  // Broadened to fire whenever ALL of the following hold (independent of
  // _taskClassification, which may be re-derived to local_system/local_file in
  // the deferred reminder run):
  //   1. A synthesize step produced non-empty stdout, AND
  //   2. No browser.act / browser.agent step exists in the plan, AND
  //   3. No getPageText / waitForStableText / get_recent_ocr result is present.
  // This prevents REPLAN loops for reminder/notification/file-write tasks whose
  // deliverable is the synthesize message itself.
  const _synthStep = skillResults.find(r => r.skill === 'synthesize' && r.ok !== false);
  const _synthOutput = String(_synthStep?.stdout || _synthStep?.result || '').trim();
  if (_synthStep && _synthOutput.length > 0) {
    const _hasBrowserStep = (skillPlan || []).some(s => s.skill === 'browser.act' || s.skill === 'browser.agent');
    const _hasPageTextResult = skillResults.some(r =>
      r.skill === 'browser.act' && (
        r.args?.action === 'getPageText' ||
        r.args?.action === 'waitForStableText' ||
        r.args?.action === 'get_recent_ocr'
      )
    );
    if (!_hasBrowserStep && !_hasPageTextResult) {
      logger.info('[Node:ReviewExecution] synthesize produced a non-empty message with no browser steps to verify — skipping hollow check (message is the deliverable)');
      return { ...state, reviewVerdict: 'VERIFIED' };
    }
    // Original narrow gate kept as a fallback for plans that DO have browser steps
    // but are genuinely scheduling tasks (rare).
    if (state._taskClassification?.taskType === 'scheduling') {
      logger.info('[Node:ReviewExecution] synthesize produced a scheduling/notification message — skipping hollow check (scheduling taskType)');
      return { ...state, reviewVerdict: 'VERIFIED' };
    }
  }

  // ── browser.agent short-circuit ───────────────────────────────────────────
  // If browser.agent reports success with action-completion signals in the result,
  // trust it without requiring page snapshot verification. This prevents false-hollow
  // detection when the agent completed its task but the page snapshot is unavailable.
  const _hasBrowserAgentSuccess = skillResults.some(r =>
    r.skill === 'browser.agent' && r.ok !== false &&
    /\b(sent|submitted|saved|completed|done|confirmed|created|updated|deleted|navigated|opened|filled|clicked|sent successfully|message sent|email sent|task completed)\b/i.test(String(r.result || ''))
  );
  if (_hasBrowserAgentSuccess) {
    logger.info('[Node:ReviewExecution] browser.agent reported action-completion — skipping hollow check (result-based verification)');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── app.agent state-change short-circuit ────────────────────────────────
  // State-changing actions such as search_and_click detect a meaningful UI
  // change by comparing a fresh baseline capture to a post-action capture.
  // result.stateChanged is direct evidence of success, so we do not need a
  // browser page snapshot or synthesize output to confirm fulfillment.
  const _hasAppAgentStateChange = skillResults.some(r =>
    r.skill === 'app.agent' &&
    r.ok === true &&
    (r.stateChanged === true || r.result?.stateChanged === true)
  );
  if (_hasAppAgentStateChange) {
    logger.info('[Node:ReviewExecution] app.agent reported a successful UI state change — skipping hollow check');
    return { ...state, reviewVerdict: 'VERIFIED' };
  }

  // ── app.agent GhostLayer short-circuit ───────────────────────────────────
  // Highlight and clear actions produce no text output by design — they are
  // visual overlay operations that either succeed or throw. If ok=true, treat
  // as UNVERIFIABLE (success assumed) to prevent a false hollow-result loop.
  const _GHOSTLAYER_ACTIONS = new Set([
    'highlight_all', 'highlight_search', 'highlight_boundaries',
    'highlight_assets', 'clear_highlights', 'highlight_elements',
  ]);
  const _hasGhostLayerSuccess = skillResults.some(r =>
    r.skill === 'app.agent' &&
    _GHOSTLAYER_ACTIONS.has(r.args?.action) &&
    r.ok !== false
  );
  if (_hasGhostLayerSuccess) {
    logger.info('[Node:ReviewExecution] app.agent GhostLayer action succeeded — skipping hollow check (visual overlay, no page text)');
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

    let snapshot = null;
    // LLM + snapshot — primary judge when backend is available
    if (mcpAdapter && llmBackend) {
      // Derive sessionId from the last browser.act step, or from browser.agent as fallback
      const browserSessionId = state.activeBrowserSessionId
        || skillResults.slice().reverse().find(r => r.skill === 'browser.act' && r.args?.sessionId)?.args?.sessionId
        || (() => {
          // Fallback: browser.agent steps don't have sessionId in args, but we can derive from agentId
          const r = skillResults.slice().reverse().find(s => s.skill === 'browser.agent' && s.args?.agentId);
          return r ? `${r.args.agentId.replace('.agent', '')}_agent` : null;
        })();

      // Capture current page text for fulfillment judgment.
      // getPageText returns visible page content (vs. ARIA tree from scanCurrentPage which
      // is often only a few hundred chars and too sparse for the LLM to judge correctly).
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
      // ── Answer-only contradiction check ──────────────────────────────────────
      // Before triggering a replan, check if the page text actually contains the
      // answer the user asked for but the synthesis got it wrong. If so, correct
      // the answer directly from page text — no replan needed.
      if (snapshot && llmBackend && synthesizeOutput) {
        let contradiction = await assessAnswerContradiction(
          userMessage, synthesizeOutput, snapshot, llmBackend, context, logger
        );
        if (contradiction?.corrected) {
          logger.info(`[Node:ReviewExecution] Answer-only contradiction detected — correcting synthesis from page text: ${contradiction.reason}`);

          // ── Truncation recovery ──────────────────────────────────────────
          // If the corrected answer indicates the AI response was truncated/incomplete
          // ("has not yet been generated", "cuts off at", etc.), the initial page text
          // capture may have been too early. Wait a few seconds, re-capture getPageText,
          // and re-run the contradiction check with the fresh text. One-shot — no loop.
          const TRUNCATION_INDICATORS = /has not yet been generated|cuts off at|not yet been generated|still generating|still streaming|response is incomplete|partially generated|hasn't been generated|not yet generated|response hasn't/i;

          if (TRUNCATION_INDICATORS.test(contradiction.answer) && browserSessionId && mcpAdapter) {
            logger.info(`[Node:ReviewExecution] Truncation detected in corrected answer — waiting 5s and re-capturing page text`);
            await new Promise(r => setTimeout(r, 5000));
            try {
              const reSnapRes = await mcpAdapter.callService('command', 'command.automate', {
                skill: 'browser.act',
                args: { action: 'getPageText', sessionId: browserSessionId },
              }, { timeoutMs: 12000 });
              const reSnapData = reSnapRes?.data || reSnapRes;
              const reSnapRaw = reSnapData?.result?.stdout || reSnapData?.stdout || reSnapData?.result || null;
              const reSnapshot = reSnapRaw ? String(reSnapRaw) : null;

              if (reSnapshot && reSnapshot.length > (snapshot || '').length) {
                logger.info(`[Node:ReviewExecution] Re-captured page text: ${reSnapshot.length} chars (was ${(snapshot || '').length} chars) — re-running contradiction check`);
                const reContradiction = await assessAnswerContradiction(
                  userMessage, synthesizeOutput, reSnapshot, llmBackend, context, logger
                );
                if (reContradiction?.corrected && !TRUNCATION_INDICATORS.test(reContradiction.answer)) {
                  logger.info(`[Node:ReviewExecution] Re-capture recovery succeeded — full response obtained`);
                  contradiction = reContradiction;
                  snapshot = reSnapshot;
                }
              }
            } catch (reSnapErr) {
              logger.warn(`[Node:ReviewExecution] Re-capture failed: ${reSnapErr.message}`);
            }
          }

          // Replace the stale synthesize result with the (possibly recovered) corrected answer
          const _synthIdx = skillResults.findIndex(r => r.skill === 'synthesize');
          if (_synthIdx >= 0) {
            skillResults[_synthIdx] = {
              ...skillResults[_synthIdx],
              stdout: contradiction.answer,
              result: contradiction.answer,
              _correctedByReview: true,
            };
          }
          return {
            ...state,
            reviewVerdict: 'CORRECTED',
            answer: contradiction.answer,
            skillResults,
          };
        }
      }

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
        if (progressCallback) {
          progressCallback({
            type: 'replanning',
            message: `Task partially completed but verification found issues — re-planning to fix: ${hollowReason}`,
          });
        }
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

  // ── Fast-pass: shell-only plan where every step exited cleanly ───────────────
  // When all steps are shell.run/cli.agent and every step exited with ok=true and
  // exitCode 0 — the LLM review would return PASS 100% of the time.
  // Skip the ~2s roundtrip. The LLM path still runs if any step failed or exited non-zero.
  const _allShellOrCli = skillResults.every(r => r.skill === 'shell.run' || r.skill === 'cli.agent' || r.skill === 'synthesize');
  const _hasRealShell  = skillResults.some(r => r.skill === 'shell.run' || r.skill === 'cli.agent');
  if (_allShellOrCli && _hasRealShell) {
    const _allClean = skillResults
      .filter(r => r.skill === 'shell.run' || r.skill === 'cli.agent')
      .every(r => {
        // exit 0 + ok=true IS the definitive success signal for shell commands.
        // Silent stdout is normal Unix behaviour — many commands (open, mv, mkdir,
        // osascript, launchctl, defaults, killall, …) produce no output on success.
        // A hardcoded isFileOp list can never be exhaustive, so we rely solely on
        // the exit code contract instead.
        return r.ok !== false && (r.exitCode == null || r.exitCode === 0);
      });
    if (_allClean) {
      logger.info('[Node:ReviewExecution] Shell-only plan — all steps exited cleanly, skipping LLM review');
      return { ...state, reviewVerdict: 'UNVERIFIABLE' };
    }
  }

  if (progressCallback) progressCallback({ type: 'reviewing', message: 'Verifying step outcomes...' });

  // ── Phase 1: LLM analysis ────────────────────────────────────────────────────

  // Dedup skillResults by step index — keep only the last result per step.
  // AUTO_PATCH retries append a new entry for the same step index; the LLM
  // should only see the final (successful) attempt, not the failed first one.
  const dedupedResults = Object.values(
    skillResults.reduce((acc, r) => {
      acc[r.step ?? r.stepIndex ?? 0] = r;
      return acc;
    }, {})
  );

  const stepLog = dedupedResults.map((r, i) => {
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

  // ── Fast number-based decision (PASS/VERIFY_NEEDED) ─────────────────────
  // Call the light model with "return ONLY a single number" to get a fast verdict.
  // If PASS (0), return immediately — skip the expensive 300-token JSON generation.
  // If VERIFY_NEEDED (1), fall through to the full JSON generation to get
  // the suspiciousSteps array with verification commands.
  const _fastVerdict = await _reviewDecision(llmBackend, userMessage, stepLog, context, state, logger);
  if (_fastVerdict === 0) {
    logger.info('[Node:ReviewExecution] Fast verdict: PASS — skipping full JSON generation → UNVERIFIABLE (pass-through)');
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }
  logger.info('[Node:ReviewExecution] Fast verdict: VERIFY_NEEDED — running full JSON generation for suspiciousSteps');

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
        intent: state.intent?.type || 'command_automate',
      }
    }, { maxTokens: 300, temperature: 0.1, fastMode: false, taskType: 'complex' });
  } catch (llmErr) {
    logger.warn(`[Node:ReviewExecution] LLM call failed (non-fatal): ${llmErr.message} — skipping`);
    return { ...state, reviewVerdict: 'UNVERIFIABLE' };
  }

  let review;
  try {
    review = parseLlmJson(raw, logger, 'Node:ReviewExecution');
    if (!review) throw new Error('no JSON found');
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
  // Use skillPlan.length (planned steps) not skillResults.length (which includes
  // retry attempts from AUTO_PATCH recovery, inflating the count).
  const planStepCount = Math.max(skillPlan.length, 1);
  const tooMany = suspiciousSteps.length > MAX_AUTO_PATCH_COUNT ||
    suspiciousSteps.length >= Math.ceil(planStepCount / 2);

  if (tooMany) {
    logger.warn(`[Node:ReviewExecution] ${suspiciousSteps.length}/${planStepCount} plan steps flagged — too many to auto-patch → ASK_USER`);
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

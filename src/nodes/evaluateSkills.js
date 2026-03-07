/**
 * Evaluate Skills Node
 *
 * Post-run LLM judge. Decides if result satisfied user intent.
 * PASS → logConversation
 * FIX  → store context_rule to DuckDB + retry planSkills (up to MAX_EVAL_RETRIES)
 * ASK_USER → surface to user
 */

const fs = require('fs');
const path = require('path');
const MAX_EVAL_RETRIES = 2;

function loadEvalPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/evaluate-skills.md'), 'utf8').trim();
  } catch (_) { return null; }
}

const EVAL_SYSTEM_PROMPT = loadEvalPrompt() || `You are an automation quality judge. Did the result satisfy the user's intent?
Output ONLY valid JSON: { "verdict": "PASS"|"FIX"|"ASK_USER", "reason": "...", "contextKey": "hostname-or-app", "contextType": "site"|"app", "category": "navigation|content|interaction|timing|auth|general", "ruleText": "fix instruction <200 chars", "retryHint": "what to do differently" }`;

// Failure-path system prompt — used when called from recoverSkill REPLAN
const FAILURE_EVAL_SYSTEM_PROMPT = `You are an automation failure analyst. A browser automation step failed repeatedly.
Your job: analyze WHY it failed and derive a permanent FIX rule to save so this never loops again.
Always output FIX (save a rule) or ASK_USER (if human input is truly needed). Never output PASS for a failure.
Output ONLY valid JSON: { "verdict": "FIX"|"ASK_USER", "reason": "...", "contextKey": "hostname", "contextType": "site"|"app", "category": "interaction|auth|navigation|timing|content|general", "ruleText": "permanent rule <200 chars", "retryHint": "what to do differently next time" }`;

module.exports = async function evaluateSkills(state) {
  const {
    mcpAdapter, llmBackend, useOnlineMode = false,
    message, resolvedMessage,
    skillPlan = [], skillResults = [], answer,
    evaluationRetryCount = 0, context, progressCallback,
    evaluationFromFailure = false, recoveryContext
  } = state;

  const logger = state.logger || console;
  const userMessage = resolvedMessage || message;

  // examine blocked: executeCommand already set answer + examineBlocked=true — skip eval entirely
  if (state.examineBlocked) {
    logger.info(`[Node:EvaluateSkills] examineBlocked — skipping evaluation, surfacing user message`);
    return { ...state, evaluationVerdict: 'ASK_USER' };
  }

  // Failure path: called from recoverSkill REPLAN — skip PASS shortcut, always judge the failure
  if (!evaluationFromFailure) {
    if (!skillPlan || skillPlan.length === 0) return state;
    if (evaluationRetryCount >= MAX_EVAL_RETRIES) {
      logger.info(`[Node:EvaluateSkills] Retry cap reached — passing through`);
      return { ...state, evaluationVerdict: 'PASS' };
    }
    // Skip post-run evaluation when the plan already went through recovery (replanCount > 0)
    // and all steps passed — the task survived its own recovery cycle, no need to re-judge.
    const replanCount = state.replanCount || 0;
    const allStepsPassed = Array.isArray(skillResults) && skillResults.length > 0 && skillResults.every(r => r.ok !== false);
    if (replanCount > 0 && allStepsPassed) {
      logger.info(`[Node:EvaluateSkills] Skipping post-run eval — task succeeded after recovery (replanCount=${replanCount})`);
      return { ...state, evaluationVerdict: 'PASS' };
    }
    // Skip re-evaluation when synthesize already ran and saved output WITH real content.
    // BUT: if all browser data-collection steps returned auth walls or empty results,
    // the synthesize output is hollow — force evaluation so the LLM judge can write
    // context_rule fixes (e.g. wrong URL, login-required site, selector mismatch).
    const synthesizeResult = Array.isArray(skillResults) && skillResults.find(r => r.skill === 'synthesize' && r.ok);
    if (synthesizeResult) {
      // Check data quality: count browser steps that had real content vs auth walls / empty
      const browserDataSteps = skillResults.filter(r =>
        r.skill === 'browser.act' &&
        (r.args?.action === 'waitForStableText' || r.args?.action === 'getPageText')
      );
      const AUTH_WALL_MARKER = /\[auth wall|not logged in|no data collected\]/i;
      const HOLLOW_CONTENT = /no relevant .{0,60} information|couldn't find .{0,60} data|no .{0,60} results/i;
      const badDataSteps = browserDataSteps.filter(r => {
        const out = String(r.stdout || r.result || '');
        return !out || out.trim().length < 20 || AUTH_WALL_MARKER.test(out);
      });
      const synthesizeOutput = String(synthesizeResult.stdout || synthesizeResult.result || '');
      const allHollow = browserDataSteps.length > 0 && badDataSteps.length === browserDataSteps.length;
      const outputIsHollow = HOLLOW_CONTENT.test(synthesizeOutput);

      if (allHollow || outputIsHollow) {
        logger.info(`[Node:EvaluateSkills] Synthesize ran but output is hollow (${badDataSteps.length}/${browserDataSteps.length} data steps were auth walls/empty) — forcing evaluation for self-healing`);
        // Fall through to evaluation — do NOT skip
      } else {
        logger.info(`[Node:EvaluateSkills] Skipping post-run eval — synthesize completed with real content`);
        return { ...state, evaluationVerdict: 'PASS' };
      }
    }
    // Skip evaluation for guide.step plans — user hasn't acted yet, nothing to judge
    const hasGuideStep = skillPlan.some(s => s.skill === 'guide.step');
    if (hasGuideStep) {
      logger.info(`[Node:EvaluateSkills] Skipping — plan contains guide.step (user interaction pending)`);
      return { ...state, evaluationVerdict: 'PASS' };
    }
  }

  const isFailurePath = evaluationFromFailure === true;
  if (progressCallback) progressCallback({ type: 'evaluating', message: isFailurePath ? 'Analyzing failure...' : 'Evaluating result...' });
  logger.info(`[Node:EvaluateSkills] ${isFailurePath ? 'Failure-path evaluation' : 'Post-run evaluation'} (retry ${evaluationRetryCount}/${MAX_EVAL_RETRIES})`);

  const backend = llmBackend;
  if (!backend) { logger.warn('[Node:EvaluateSkills] No llmBackend in state — skipping'); return state; }

  // Build rich step log — mirrors the field descriptions in evaluate-skills.md
  const stepLogs = skillResults.map((r, i) => {
    const lines = [
      `--- Step ${i + 1}: ${r.skill}${r.args?.action ? '/' + r.args.action : ''} | status: ${r.ok ? 'OK' : 'FAILED'}`,
    ];
    // Intended args (what the LLM planned)
    if (r.args) lines.push(`  args: ${JSON.stringify(r.args).slice(0, 300)}`);
    // Actual URL the browser was on (may differ from args.url due to redirect)
    if (r.url) lines.push(`  url: ${r.url}`);
    // Browser tab title — reveals index pages, login pages, etc.
    if (r.title) lines.push(`  title: ${r.title}`);
    // Shell exit code
    if (r.exitCode != null && r.exitCode !== 0) lines.push(`  exitCode: ${r.exitCode}`);
    // Error message
    if (r.error) lines.push(`  error: ${String(r.error).slice(0, 300)}`);
    // Actual result content — up to 600 chars so judge can assess quality
    const resultText = r.result || r.stdout || r._raw?.result || '';
    if (resultText) lines.push(`  result (${String(resultText).length} chars): ${String(resultText).slice(0, 600)}`);
    else lines.push(`  result: (empty)`);
    return lines.join('\n');
  }).join('\n\n');

  // Pull warn/error lines from the run log — debug/info noise excluded to save tokens.
  // runLog is populated by the capturing logger proxy in StateGraph.execute().
  const rawRunLog = Array.isArray(state.runLog) ? state.runLog : [];
  const filteredLog = rawRunLog
    .filter(line => line.startsWith('[WARN]') || line.startsWith('[ERROR]'))
    .slice(-80) // last 80 warn/error lines
    .join('\n');

  const systemPrompt = isFailurePath ? FAILURE_EVAL_SYSTEM_PROMPT : EVAL_SYSTEM_PROMPT;

  const failureSection = isFailurePath && recoveryContext ? `
FAILURE ANALYSIS:
  failedSkill: ${recoveryContext.failedSkill}
  failureReason: ${recoveryContext.failureReason}
  suggestion: ${recoveryContext.suggestion}
  replanCount: ${state.replanCount || 0}` : '';

  const evalQuery = `ORIGINAL REQUEST: "${userMessage}"
${failureSection}
STEP LOG:
${stepLogs}

WARN/ERROR LOG (from execution):
${filteredLog || '(no warnings or errors)'}

FINAL ANSWER SHOWN TO USER: ${String(answer || '(none)').slice(0, 500)}

retryCount: ${evaluationRetryCount}

Output ONLY valid JSON.`;

  const evalPayload = {
    query: evalQuery,
    context: {
      systemInstructions: systemPrompt,
      sessionId: context?.sessionId,
      userId: context?.userId || 'default_user'
    }
  };

  let raw = '';
  try {
    raw = await backend.generateAnswer(evalQuery, evalPayload, {
      maxTokens: 400,
      temperature: 0.1,
      fastMode: false
    });
  } catch (llmErr) {
    logger.warn(`[Node:EvaluateSkills] LLM failed (non-fatal): ${llmErr.message}`);
    return { ...state, evaluationVerdict: 'PASS' };
  }

  // Parse JSON from LLM output
  let verdict;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON found');
    verdict = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    logger.warn(`[Node:EvaluateSkills] JSON parse failed: ${parseErr.message} — treating as PASS`);
    return { ...state, evaluationVerdict: 'PASS' };
  }

  logger.info(`[Node:EvaluateSkills] Verdict: ${verdict.verdict} — ${verdict.reason}`);

  if (verdict.verdict === 'PASS') {
    // On failure path a PASS means evaluateSkills couldn't derive a rule — still route to planSkills
    // (recoveryContext is already set by recoverSkill for the replan)
    return { ...state, evaluationVerdict: 'PASS', evaluationFromFailure: false };
  }

  if (verdict.verdict === 'ASK_USER') {
    return {
      ...state,
      evaluationVerdict: 'ASK_USER',
      answer: `I completed the task but the result may not be what you expected: ${verdict.reason}`
    };
  }

  // FIX: store context rule + trigger replan
  if (verdict.verdict === 'FIX' && verdict.contextKey && verdict.ruleText) {
    if (mcpAdapter) {
      try {
        await mcpAdapter.callService('user-memory', 'context_rule.upsert', {
          contextKey: verdict.contextKey,
          ruleText: verdict.ruleText,
          contextType: verdict.contextType || 'site',
          category: verdict.category || 'general',
          source: 'evaluate_skills_auto'
        }, { timeoutMs: 5000 });
        logger.info(`[Node:EvaluateSkills] Stored fix rule for "${verdict.contextKey}": ${verdict.ruleText}`);
      } catch (storeErr) {
        logger.warn(`[Node:EvaluateSkills] Failed to store rule: ${storeErr.message}`);
      }
    }

    if (progressCallback) progressCallback({
      type: 'retrying_with_fix',
      message: `Adjusting approach for ${verdict.contextKey} and retrying...`
    });

    // Reset plan state for replan — planSkills will pick up new context rule
    return {
      ...state,
      evaluationVerdict: 'FIX',
      evaluationFix: verdict,
      evaluationFromFailure: false,
      // On failure path: reset counter so the post-run evaluator starts fresh after replan.
      // On success path: increment to track how many post-run retries have been used.
      evaluationRetryCount: isFailurePath ? 0 : evaluationRetryCount + 1,
      // Clear plan state so planSkills reruns fresh with the new rule injected
      skillPlan: null,
      skillCursor: 0,
      skillResults: [],
      failedStep: null,
      answer: undefined,
      recoveryContext: {
        failedSkill: isFailurePath ? (recoveryContext?.failedSkill || 'evaluate_skills') : 'evaluate_skills',
        failedStep: (skillPlan || []).length,
        failureReason: verdict.reason,
        suggestion: verdict.retryHint || 'Apply the stored context rule and retry',
        constraint: verdict.ruleText
      }
    };
  }

  // Fallback
  return { ...state, evaluationVerdict: 'PASS' };
};

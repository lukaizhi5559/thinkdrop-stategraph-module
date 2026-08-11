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
const MAX_EVAL_RETRIES = 4;

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

// ── Answer-type validation ─────────────────────────────────────────────────
// Reads outputSchema from the synthesize step in the plan (set by LLM during
// planning). Falls back to conservative regex inference only if the plan
// didn't set it. Returns an array of type strings (normalized).
function _getExpectedAnswerTypes(skillPlan, userMessage) {
  // Primary: read from plan's synthesize step args
  if (Array.isArray(skillPlan)) {
    for (let i = skillPlan.length - 1; i >= 0; i--) {
      if (skillPlan[i].skill === 'synthesize' && skillPlan[i].args?.outputSchema?.type) {
        const t = skillPlan[i].args.outputSchema.type;
        return Array.isArray(t) ? t : [t];
      }
    }
  }
  // Fallback: conservative regex inference (only obvious single-type patterns)
  const msg = userMessage || '';
  if (/\b(how many|count the|number of|how much|how long)\b/i.test(msg)) return ['INTEGER'];
  if (/\b(is there|are there|check if|can i|do i have)\b/i.test(msg)) return ['BOOLEAN'];
  if (/\b(list all|list every|show all|show me all|enumerate|find all|name all)\b/i.test(msg)) return ['ARRAY'];
  return null;
}

function _validateSingleType(answer, type) {
  const text = String(answer || '').trim();
  if (!text) return false;
  switch (type) {
    case 'INTEGER':
      if (/^\d+\s*$/.test(text)) return true;
      if (text.length < 200 && /\b\d+\b/.test(text)) return true;
      return false;
    case 'BOOLEAN':
      return /^(yes|no|true|false)\b/i.test(text);
    case 'ARRAY':
      return /^\s*[-•*]\s/m.test(text) || /^\s*\d+\.\s/m.test(text) || /^none found/i.test(text);
    case 'OBJECT':
      return /.+:\s*.+/m.test(text);
    case 'STRING':
      return true;
    default:
      return true;
  }
}

function validateAnswerTypes(answer, expectedTypes) {
  if (!expectedTypes || expectedTypes.length === 0) return true;
  // ALL types must pass — answer must satisfy every expected type
  return expectedTypes.every(type => _validateSingleType(answer, type));
}

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

  // ── Answer-type validation bypass ──────────────────────────────────────────
  // Read expected types from the plan's outputSchema (set by LLM during planning).
  // If the answer doesn't match ANY expected type, force LLM evaluation.
  const _expectedAnswerTypes = _getExpectedAnswerTypes(skillPlan, userMessage);
  let _answerTypeValid = true; // default: no type check = allow skips
  if (_expectedAnswerTypes && _expectedAnswerTypes.length > 0 && !evaluationFromFailure) {
    _answerTypeValid = validateAnswerTypes(answer, _expectedAnswerTypes);
    if (!_answerTypeValid) {
      logger.info(`[Node:EvaluateSkills] Answer-type mismatch: expected [${_expectedAnswerTypes.join(',')}], answer doesn't match — forcing evaluation (bypassing skip conditions)`);
    } else {
      logger.info(`[Node:EvaluateSkills] Answer-type validation passed: expected [${_expectedAnswerTypes.join(',')}]`);
    }
  }
  const _bypassSkips = _expectedAnswerTypes && _expectedAnswerTypes.length > 0 && !_answerTypeValid;

  // Failure path: called from recoverSkill REPLAN — skip PASS shortcut, always judge the failure
  if (!_bypassSkips && !evaluationFromFailure) {
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
    // Skip post-run evaluation when the last completed step was browser.agent or cli.agent
    // returning ok:true. These sub-agents run their own internal reasoning loop (playwright.agent)
    // and verify outcomes before returning. The raw delegation text they produce is NOT a
    // reliable signal for the LLM judge — it contains internal orchestration prose like
    // "I see the Gmail inbox is loaded..." rather than a clean confirmation, which causes the
    // judge to fire FIX even on fully successful tasks (e.g. email sent, PR created).
    // Note: skillResults may contain earlier failed+recovered steps (ok:false) from the same run,
    // so we check the last step specifically rather than relying on allStepsPassed.
    const _lastCompletedStep = Array.isArray(skillResults) && skillResults.length > 0
      ? [...skillResults].reverse().find(r => r.ok !== false)
      : null;
    const _isAgentLastStep = _lastCompletedStep &&
      (_lastCompletedStep.skill === 'browser.agent' || _lastCompletedStep.skill === 'cli.agent');
    if (_isAgentLastStep) {
      logger.info(`[Node:EvaluateSkills] Skipping post-run eval — last completed step was ${_lastCompletedStep.skill} ok:true (agent verified outcome internally)`);
      return { ...state, evaluationVerdict: 'PASS' };
    }
    // Skip post-run evaluation when the last shell.run step confirms task completion in stdout.
    // Shell exit 0 + explicit confirmation text is ground truth — the LLM judge must not
    // override it (doing so causes false FIX verdicts that trigger needless replan cycles).
    const lastShellOk = Array.isArray(skillResults) && [...skillResults].reverse().find(r => r.skill === 'shell.run' && r.ok === true);
    const SHELL_CONFIRMED = /\brenamed\b|\balready done\b|\bmoved\b|\bRenaming:\s|\bmv:\s|\bcreated\b|\bmkdir\b|\binstalled\b|\bcopied\b/i;
    if (lastShellOk && SHELL_CONFIRMED.test(String(lastShellOk.stdout || ''))) {
      logger.info(`[Node:EvaluateSkills] Skipping post-run eval — last shell.run confirmed task completion in stdout`);
      return { ...state, evaluationVerdict: 'PASS' };
    }
    // Skip post-run evaluation for pure interaction tasks (navigate + click/fill/examine)
    // when ALL steps passed — there's no content to judge, only actions. The LLM tends to
    // hallucinate URL mismatches (e.g. chatgpt.com vs chat.openai.com) on these tasks.
    const CONTENT_ACTIONS = new Set(['getPageText', 'waitForStableText', 'getText', 'scanCurrentPage']);
    const hasContentStep = skillResults.some(r => CONTENT_ACTIONS.has(r.args?.action));
    if (!hasContentStep && allStepsPassed) {
      logger.info(`[Node:EvaluateSkills] Skipping post-run eval — pure interaction task, all steps OK (no content to judge)`);
      return { ...state, evaluationVerdict: 'PASS' };
    }
    // Skip evaluation when the plan was a search/navigation task:
    // interaction steps (fill/press/click/navigate) ALL passed + content step returned ok:true.
    // waitForStableText may return sparse content on pages with dynamic ads — that's not a failure.
    // The LLM judge reliably FIXes on empty waitForStableText even when the search succeeded.
    const INTERACTION_ACTIONS = new Set(['fill', 'press', 'click', 'navigate', 'goto', 'type', 'examine']);
    const interactionSteps = skillResults.filter(r => INTERACTION_ACTIONS.has(r.args?.action));
    const contentSteps = skillResults.filter(r => CONTENT_ACTIONS.has(r.args?.action));
    const allInteractionPassed = interactionSteps.length > 0 && interactionSteps.every(r => r.ok !== false);
    const allContentOk = contentSteps.length > 0 && contentSteps.every(r => r.ok !== false);
    if (allInteractionPassed && allContentOk && evaluationRetryCount === 0) {
      // Before skipping, check whether a synthesize step produced a hollow/failure output.
      // If synthesize says "no information available" or "sign-in page", all steps being
      // ok:true just means playwright exited 0 — it doesn't mean the task succeeded.
      const synthStep = skillResults.find(r => r.skill === 'synthesize' && r.ok !== false);
      if (synthStep) {
        const synthOut = String(synthStep.stdout || synthStep.result || '').toLowerCase();
        const HOLLOW_SYNTH = [
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
        if (HOLLOW_SYNTH.some(p => p.test(synthOut))) {
          logger.info(`[Node:EvaluateSkills] Synthesize output signals task failure despite ok:true steps — forcing evaluation`);
          // Fall through to LLM evaluation — do NOT skip
        } else {
          logger.info(`[Node:EvaluateSkills] Skipping post-run eval — all interaction+content steps OK (interaction task with content polling)`);
          return { ...state, evaluationVerdict: 'PASS' };
        }
      } else {
        logger.info(`[Node:EvaluateSkills] Skipping post-run eval — all interaction+content steps OK (interaction task with content polling)`);
        return { ...state, evaluationVerdict: 'PASS' };
      }
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

  }

  // ── Self-healing: detect playwright tool errors and auto-diagnose ──────────
  // When a browser.act step fails with a known tool-level error (not a page
  // state error), call browser.act diagnose to probe playwright-cli and write
  // a permanent context_rule fix — so the system repairs itself without looping.
  const TOOL_ERROR_PATTERNS = [
    /TypeError: result is not a function/i,
    /page\._evaluateFunction/i,
    /UtilityScript\.evaluate/i,
    /unexpected token/i,
    /is not a (function|constructor)/i,
    /Failed to deserialize|Serialization Error/i,
  ];
  const failedBrowserSteps = skillResults.filter(r =>
    (r.skill === 'browser.act' || r.skill === 'browser.agent' || r.skill === 'cli.agent') && !r.ok &&
    TOOL_ERROR_PATTERNS.some(p => p.test(String(r.error || r.result || r.stdout || '')))
  );
  if (failedBrowserSteps.length > 0 && evaluationRetryCount === 0) {
    const failedStep = failedBrowserSteps[0];
    const errorText  = String(failedStep.error || failedStep.result || failedStep.stdout || '').slice(0, 300);
    const failedAction = failedStep.args?.action || '';
    logger.info(`[Node:EvaluateSkills] Tool error detected in "${failedAction}" — triggering self-heal diagnose`);
    try {
      const diagResult = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.act',
        args: {
          action: 'diagnose',
          failedAction,
          errorText,
          sessionId: failedStep.args?.sessionId || 'default',
        },
      });
      const diag = diagResult?.data || diagResult?.raw || diagResult || {};
      if (diag.fixes && diag.fixes.length > 0) {
        logger.info(`[Node:EvaluateSkills] Self-heal diagnose: ${diag.fixes[0].slice(0, 120)}`);
        // Inject fix into state context so planSkills replan has it
        const healContext = `TOOL FIX (auto-diagnosed): ${diag.fixes.join(' | ')}`;
        return {
          ...state,
          evaluationVerdict: 'FIX',
          evaluationRetryCount: evaluationRetryCount + 1,
          context: [...(Array.isArray(state.context) ? state.context : []), healContext],
        };
      }
    } catch (diagErr) {
      logger.warn(`[Node:EvaluateSkills] Self-heal diagnose failed: ${diagErr.message}`);
    }
  }

  const isFailurePath = evaluationFromFailure === true;

  // Failure-path retry cap — after MAX_EVAL_RETRIES FIX cycles, escalate to ASK_USER
  // (the non-failure-path cap lives in the `if (!evaluationFromFailure)` block above)
  if (isFailurePath && evaluationRetryCount >= MAX_EVAL_RETRIES) {
    logger.warn(`[Node:EvaluateSkills] Failure-path retry cap reached (${evaluationRetryCount}/${MAX_EVAL_RETRIES}) — escalating to ASK_USER`);
    return {
      ...state,
      evaluationVerdict: 'ASK_USER',
      evaluationFromFailure: false,
      recoveryAction: 'ask_user',
      pendingQuestion: {
        question: `I tried ${evaluationRetryCount} different approaches but couldn't resolve this automatically. Please try a different approach or check the task manually.`,
        options: []
      },
      answer: `I tried ${evaluationRetryCount} different approaches but couldn't resolve this automatically. Please try a different approach or check the task manually.`,
    };
  }

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
      conversationHistory: (state.conversationHistory || []).slice(-6),
      sessionId: context?.sessionId,
      userId: context?.userId || 'default_user',
      intent: 'command_automate'
    }
  };

  let raw = '';
  try {
    raw = await backend.generateAnswer(evalQuery, evalPayload, {
      maxTokens: 400,
      temperature: 0.1,
      fastMode: false,
      taskType: 'classification'
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
    // Agent-aware ASK_USER: if the failure was on a browser.agent/cli.agent step,
    // include the agentId + train options so the user can correct or train the
    // agent (same UX as a hard failure). Free-text answers route through the
    // _isAgentAskUser resume path (re-run same agent with [Resume context: Q&A]).
    const _failedStep = state.failedStep || {};
    const _failedAgentId = _failedStep.args?.agentId || _failedStep.args?.agent || null;
    const _failedSkill = _failedStep.skill || null;
    const _isAgentFailure = _failedAgentId && (_failedSkill === 'browser.agent' || _failedSkill === 'cli.agent' || _failedSkill === 'playwright.agent');
    const _baseQuestion = `I ran into an issue and need your help: ${verdict.reason}`;
    return {
      ...state,
      evaluationVerdict: 'ASK_USER',
      recoveryAction: 'ask_user',
      pendingQuestion: _isAgentFailure ? {
        question: `${verdict.reason}\n\nWhat would you like to do? You can also type what went wrong and I'll retry with your correction.`,
        options: [
          { label: 'Try again', value: 'try_again' },
          { label: 'Correct and retry (tell me what was missed)', value: 'correct_and_retry' },
          { label: 'Record recipe from beginning', value: 'record_recipe' },
        ],
        _isAgentAskUser: true,
        agentId: _failedAgentId,
        skill: _failedSkill,
        stepIndex: state.skillCursor ?? 0,
        uiStepIndex: state._resumeStepIndex ?? state.skillCursor ?? 0,
        originalTask: _failedStep.args?.task || _failedStep.args?.goal || state.message || null,
        trainingHandoff: true,
      } : { question: verdict.reason, options: [] },
      answer: _baseQuestion
    };
  }

  // FIX: store context rule + trigger replan
  if (verdict.verdict === 'FIX' && verdict.contextKey && verdict.ruleText) {
    // Gate: never write a context rule when the failure was a hollow-detection artifact.
    // The _hollowResult flag is set by reviewExecution when it falsely detects hollow
    // (e.g., browser.agent succeeded but page snapshot was unavailable). Writing a rule
    // based on this artifact poisons the context for future runs.
    const isHollowArtifact = state.failedStep?._hollowResult === true;

    // Bad-rule guard: if the rule recommends a tool that the failure itself reports as missing/unavailable,
    // skip writing it — it would cement the wrong approach into DuckDB and cause the next retry
    // to be pre-poisoned with a known-broken strategy.
    const failedStderr = String(state.failedStep?.stderr || '').toLowerCase();
    const failedStdout = String(state.failedStep?.stdout || '').toLowerCase();
    const failedOutput = failedStderr + ' ' + failedStdout;
    const BAD_RULE_SIGNALS = /no available formula|no such formula|command not found|modulenotfounderror|no module named|cannot find module|not found|error: no formula/i;
    const ruleToolWords = verdict.ruleText.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,}\b/g) || [];
    const ruleRecommendsBrokenTool = ruleToolWords.some(word =>
      word.length > 3 && failedOutput.includes(word) && BAD_RULE_SIGNALS.test(failedOutput)
    );
    if (ruleRecommendsBrokenTool) {
      logger.warn(`[Node:EvaluateSkills] Bad-rule guard: skipping DuckDB write — rule recommends a tool that failed in this very run. ruleText: "${verdict.ruleText.slice(0, 120)}"`);
    }

    if (isHollowArtifact || ruleRecommendsBrokenTool) {
      if (isHollowArtifact) logger.info(`[Node:EvaluateSkills] Skipping context rule write — failure was a hollow-detection artifact (not a real execution failure)`);
    } else if (mcpAdapter) {
      // Collect ALL hostnames touched during this run (planned + actual redirects).
      // Write the rule under every hostname so planSkills finds it regardless of
      // which domain it searches — this is the dynamic alias solution.
      const ruleKeys = new Set([verdict.contextKey]);
      for (const r of (skillResults || [])) {
        if (r.url) { try { ruleKeys.add(new URL(r.url).hostname.replace(/^www\./, '')); } catch (_) {} }
        if (r.args?.url) { try { ruleKeys.add(new URL(r.args.url).hostname.replace(/^www\./, '')); } catch (_) {} }
      }
      for (const key of ruleKeys) {
        try {
          await mcpAdapter.callService('user-memory', 'context_rule.upsert', {
            contextKey: key,
            ruleText: verdict.ruleText,
            contextType: verdict.contextType || 'site',
            category: verdict.category || 'general',
            source: 'evaluate_skills_auto'
          }, { timeoutMs: 5000 });
          logger.info(`[Node:EvaluateSkills] Stored fix rule for "${key}": ${verdict.ruleText}`);
        } catch (storeErr) {
          logger.warn(`[Node:EvaluateSkills] Failed to store rule for "${key}": ${storeErr.message}`);
        }
      }
    }

    if (progressCallback) progressCallback({
      type: 'retrying_with_fix',
      message: `Adjusting approach for ${verdict.contextKey} and retrying...`,
      ruleText: verdict.ruleText,
      contextKey: verdict.contextKey,
      category: verdict.category || 'general',
    });

    // Reset plan state for replan — planSkills will pick up new context rule
    return {
      ...state,
      evaluationVerdict: 'FIX',
      evaluationFix: verdict,
      evaluationFromFailure: false,
      // Always increment so the failure-path cap fires after MAX_EVAL_RETRIES cycles.
      evaluationRetryCount: evaluationRetryCount + 1,
      // At retry 3+, signal recoverSkill to trigger web.agent discovery — LLM-only guesses exhausted.
      _needsWebDiscovery: (evaluationRetryCount + 1) >= 3,
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
        constraint: verdict.ruleText,
        // Include the actual URL reached so planSkills knows the real page state
        actualUrl: (() => {
          const lastWithUrl = [...(skillResults || [])].reverse().find(r => r.url);
          return lastWithUrl?.url || state.activeBrowserUrl || null;
        })()
      }
    };
  }

  // Fallback
  return { ...state, evaluationVerdict: 'PASS' };
};

// Export helper functions for testing
module.exports._getExpectedAnswerTypes = _getExpectedAnswerTypes;
module.exports._validateSingleType = _validateSingleType;
module.exports.validateAnswerTypes = validateAnswerTypes;

/**
 * Recover Skill Node
 *
 * Called when a skill step fails during executeCommand. The LLM reasons about
 * the failure and decides one of three outcomes:
 *
 *   1. AUTO_PATCH   — fix the args and retry the same step immediately
 *   2. REPLAN       — the failure changes the whole approach; re-run planSkills
 *   3. ASK_USER     — cannot recover without human input; surface a question
 *
 * This node is what makes the system adaptive — like Windsurf/Warp recovering
 * from a permission error by suggesting an alternative path.
 *
 * State inputs:
 *   state.failedStep       — { step, skill, args, error, exitCode, stderr }
 *   state.skillPlan        — the full plan array
 *   state.skillCursor      — index of the failed step
 *   state.skillResults     — results so far
 *   state.message          — original user request
 *   state.llmBackend / state.mcpAdapter
 *
 * State outputs (one of):
 *
 *   AUTO_PATCH:
 *     state.recoveryAction  = 'auto_patch'
 *     state.skillPlan       = updated plan with patched step args
 *     state.skillCursor     = same cursor (retry the step)
 *     state.recoveryNote    = human-readable explanation of the patch
 *
 *   REPLAN:
 *     state.recoveryAction  = 'replan'
 *     state.recoveryContext = { failedSkill, failedStep, failureReason, suggestion, alternativeCwd, constraint }
 *     (planSkills node will consume recoveryContext to guide the new plan)
 *
 *   ASK_USER:
 *     state.recoveryAction  = 'ask_user'
 *     state.pendingQuestion = { question, options?, context }
 *     state.commandExecuted = false
 *     state.answer          = the question surfaced to the user
 */

const fs = require('fs');
const MCPLLMBackend = require('../backends/MCPLLMBackend');
const VSCodeLLMBackend = require('../backends/VSCodeLLMBackend');

function loadRecoveryPrompt() {
  const path = require('path');
  const isWindows = process.platform === 'win32';
  const promptFile = isWindows ? 'recover-skill-windows.md' : 'recover-skill.md';
  const promptPath = path.join(__dirname, '../prompts', promptFile);
  try {
    return fs.readFileSync(promptPath, 'utf8').trim();
  } catch (_) {
    // Fallback to macOS prompt if platform-specific file missing
    try {
      return fs.readFileSync(path.join(__dirname, '../prompts/recover-skill.md'), 'utf8').trim();
    } catch (__) {
      return null;
    }
  }
}

const RECOVERY_SYSTEM_PROMPT = loadRecoveryPrompt() || `You are an automation recovery agent. A skill step failed.
Decide: AUTO_PATCH (fix args inline), REPLAN (rebuild plan), or ASK_USER (need human input).
Be conservative: prefer ASK_USER over guessing.

AUTO_PATCH: { "action": "AUTO_PATCH", "patchedArgs": {...}, "note": "one-line explanation" }
REPLAN: { "action": "REPLAN", "suggestion": "what to do differently", "alternativeCwd": "/path", "constraint": "what to avoid" }
ASK_USER: { "action": "ASK_USER", "question": "clear question", "options": ["option A", "option B"] }

Output ONLY valid JSON. No explanation, no markdown fences.`;

module.exports = async function recoverSkill(state) {
  const {
    mcpAdapter,
    llmBackend,
    useOnlineMode = false,
    failedStep,
    skillPlan,
    skillCursor,
    skillResults = [],
    stepRetryCount = 0,
    message,
    resolvedMessage,
    context
  } = state;

  const logger = state.logger || console;

  if (!failedStep) {
    logger.warn('[Node:RecoverSkill] No failedStep in state — nothing to recover');
    return state;
  }

  logger.debug(`[Node:RecoverSkill] Recovering from: ${failedStep.skill} — ${failedStep.error}`);

  // ── Resolve LLM backend ──────────────────────────────────────────────────────
  let backend = llmBackend;

  if (!backend && useOnlineMode) {
    backend = new VSCodeLLMBackend({
      wsUrl:             process.env.WEBSOCKET_URL     || 'ws://localhost:4000/ws/stream',
      apiKey:            process.env.WEBSOCKET_API_KEY || 'test-api-key-123',
      userId:            context?.userId               || 'default_user',
      connectTimeoutMs:  5000,
      responseTimeoutMs: 30000,
    });
  }

  if (!backend && mcpAdapter) {
    backend = new MCPLLMBackend(mcpAdapter);
  }

  // ── Fast-path: known recoverable patterns (no LLM call needed) ──────────────
  const fastRecovery = tryFastRecovery(failedStep, skillPlan, skillCursor, stepRetryCount, logger);
  if (fastRecovery) {
    return applyRecovery(fastRecovery, state, skillPlan, skillCursor, stepRetryCount, logger);
  }

  // ── LLM-based recovery ───────────────────────────────────────────────────────
  if (!backend) {
    logger.warn('[Node:RecoverSkill] No LLM backend — defaulting to ASK_USER');
    return {
      ...state,
      recoveryAction: 'ask_user',
      pendingQuestion: {
        question: `Step ${failedStep.step} (${failedStep.skill}) failed: ${failedStep.error}. How would you like to proceed?`,
        options: ['Skip this step', 'Abort the task', 'Try a different approach'],
        context: failedStep
      },
      commandExecuted: false,
      answer: `I hit a problem at step ${failedStep.step}: ${failedStep.error}\n\nHow would you like to proceed?`
    };
  }

  const completedSteps = skillResults
    .filter(r => r.ok)
    .map(r => `  ✓ Step ${r.step}: ${r.skill}`)
    .join('\n') || '  (none)';

  const remainingSteps = skillPlan
    .slice(skillCursor + 1)
    .map((s, i) => `  Step ${skillCursor + 2 + i}: ${s.skill} — ${s.description || JSON.stringify(s.args)}`)
    .join('\n') || '  (none)';

  const recoveryQuery = `Original user request: "${resolvedMessage || message}"

Failed step:
  Step number: ${failedStep.step}
  Skill: ${failedStep.skill}
  Args: ${JSON.stringify(failedStep.args, null, 2)}
  Error: ${failedStep.error}
  Exit code: ${failedStep.exitCode ?? 'N/A'}
  Stderr: ${failedStep.stderr || '(none)'}

Completed steps so far:
${completedSteps}

Remaining steps (not yet executed):
${remainingSteps}

OS: ${process.platform}
Home: ${process.env.HOME || process.env.USERPROFILE || '/Users/unknown'}

Decide the recovery strategy.`;

  const payload = {
    query: recoveryQuery,
    context: {
      systemInstructions: RECOVERY_SYSTEM_PROMPT,
      sessionId: context?.sessionId,
      userId: context?.userId,
      intent: 'command_automate'
    },
    options: {
      maxTokens: 400,
      temperature: 0.1,
      fastMode: false
    }
  };

  try {
    const available = await backend.isAvailable().catch(() => false);
    if (!available) {
      throw new Error('LLM backend unavailable');
    }

    const rawDecision = await backend.generateAnswer(recoveryQuery, payload, payload.options, null);
    logger.debug(`[Node:RecoverSkill] LLM decision: ${rawDecision.substring(0, 300)}`);

    const decision = parseDecision(rawDecision, logger);

    if (!decision) {
      throw new Error('Could not parse recovery decision from LLM');
    }

    return applyRecovery(decision, state, skillPlan, skillCursor, stepRetryCount, logger);

  } catch (error) {
    logger.error('[Node:RecoverSkill] Recovery LLM failed:', error.message);

    // Safe fallback: always ask the user
    return {
      ...state,
      recoveryAction: 'ask_user',
      pendingQuestion: {
        question: `Step ${failedStep.step} (${failedStep.skill}) failed: "${failedStep.error}". What should I do?`,
        options: ['Skip this step and continue', 'Abort the task', 'Try a different approach'],
        context: failedStep
      },
      commandExecuted: false,
      answer: `I ran into a problem at step ${failedStep.step} (${failedStep.skill}):\n\n> ${failedStep.error}\n\nWhat would you like me to do?`
    };
  }
};

// ---------------------------------------------------------------------------
// Fast-path recovery: handle well-known failure patterns without an LLM call
// ---------------------------------------------------------------------------

function tryFastRecovery(failedStep, skillPlan, cursor, stepRetryCount, logger) {
  const { skill, args, error = '', stderr = '' } = failedStep;
  const combinedError = `${error} ${stderr}`.toLowerCase();

  // Skill not yet implemented — no amount of replanning will fix this
  if (combinedError.includes('not yet implemented')) {
    logger.debug(`[Node:RecoverSkill] Fast-path: ${skill} not yet implemented → ASK_USER`);
    return {
      action: 'ASK_USER',
      question: `The "${skill}" skill isn't available yet in this version of Thinkdrop. Would you like me to try a different approach using only shell commands?`,
      options: ['Yes, try with shell commands only', 'Cancel this task']
    };
  }

  // browser.act failures
  if (skill === 'browser.act') {
    const action = args.action || '';

    // No input found — use page text to detect what's actually on the page (works for any site)
    if (combinedError.includes('no visible input elements')) {
      const sessionId = args.sessionId || 'default';
      const currentUrl = failedStep.url || '';
      const pageContext = (failedStep.pageContext || '').toLowerCase();

      // Detect login/auth/marketing page from actual page content — no hardcoded URL map needed
      const isLoginPage = pageContext.includes('sign in') || pageContext.includes('log in') ||
        pageContext.includes('login') || pageContext.includes('create account') ||
        pageContext.includes('continue with google') || pageContext.includes('continue with email') ||
        pageContext.includes('enter your email') || pageContext.includes('get started') ||
        pageContext.includes('sign up') || pageContext.includes('register');

      if (isLoginPage && stepRetryCount === 0) {
        logger.debug(`[Node:RecoverSkill] Fast-path: page text indicates login/marketing page (${currentUrl}) → ASK_USER`);
        return {
          action: 'ASK_USER',
          question: `The browser landed on a login or sign-up page instead of the app. Please log in to "${currentUrl}" in the browser, then reply "continue" to resume.`,
          options: ['I am now logged in — continue', 'Abort the task']
        };
      }

      // No login signals detected, or second failure — generic ask
      if (stepRetryCount >= 1) {
        logger.debug(`[Node:RecoverSkill] Fast-path: no input found (retry ${stepRetryCount}) → ASK_USER`);
        return {
          action: 'ASK_USER',
          question: `The browser couldn't find a text input on the page at "${currentUrl}". The page may require login or the site may have changed its layout.`,
          options: ['I am logged in — skip this step and continue', 'Abort the task']
        };
      }
    }

    // Selector not found — REPLAN: replace waitForSelector+type with smartType (auto-discovers input)
    if (combinedError.includes('timeout') && (combinedError.includes('selector') || args.selector)) {
      if (stepRetryCount === 0) {
        logger.debug(`[Node:RecoverSkill] Fast-path: browser.act selector timeout → REPLAN with smartType`);
        return {
          action: 'REPLAN',
          suggestion: `The selector "${args.selector}" was not found — the page likely uses a contenteditable div or a different input type. Replace any waitForSelector + type steps with a single smartType step, which auto-discovers the correct input element (works for input, textarea, and contenteditable divs).`,
          constraint: `Replace the failed step with: { "skill": "browser.act", "args": { "action": "smartType", "text": "<the text to type>", "sessionId": "${args.sessionId || 'default'}" } }. Do NOT use waitForSelector before smartType — it handles waiting internally. Use the same sessionId as the rest of the plan.`
        };
      }
      // Second failure after smartType also failed — ask user
      logger.debug(`[Node:RecoverSkill] Fast-path: browser.act selector timeout (retry ${stepRetryCount}) → ASK_USER`);
      return {
        action: 'ASK_USER',
        question: `The browser couldn't find any input element on the page to type into. Would you like me to take a screenshot so you can see what's visible?`,
        options: ['Yes, take a screenshot', 'Cancel']
      };
    }

    // Navigation failed (wrong URL, network error)
    if (action === 'navigate' && (combinedError.includes('net::err') || combinedError.includes('failed to navigate'))) {
      logger.debug(`[Node:RecoverSkill] Fast-path: browser.act navigate failed → ASK_USER`);
      return {
        action: 'ASK_USER',
        question: `The browser couldn't load "${args.url}". Is the URL correct, or would you like to try a different address?`,
        options: ['Try a different URL', 'Cancel']
      };
    }

    // Browser/target closed unexpectedly — retry by reopening session
    if (combinedError.includes('target closed') || combinedError.includes('browser closed') || combinedError.includes('browser has been closed')) {
      if (stepRetryCount === 0) {
        logger.debug(`[Node:RecoverSkill] Fast-path: browser.act browser closed → REPLAN with new sessionId`);
        return {
          action: 'REPLAN',
          suggestion: `The browser session was closed unexpectedly. Restart the task with a new sessionId.`,
          constraint: `Use a new sessionId (e.g. "s${Date.now()}") — the previous session is gone.`
        };
      }
      // Second attempt still failing — browser context is truly dead, ask user to restart
      logger.debug(`[Node:RecoverSkill] Fast-path: browser.act browser closed (retry ${stepRetryCount}) → ASK_USER`);
      return {
        action: 'ASK_USER',
        question: `The browser keeps closing unexpectedly. Please restart the app and try again.`,
        options: ['Restart and retry', 'Cancel']
      };
    }
  }

  // mkdir on root → suggest Desktop
  if (skill === 'shell.run' && args.cmd === 'mkdir') {
    if (combinedError.includes('permission denied') || combinedError.includes('read-only')) {
      const desktopPath = `${process.env.HOME || '/Users/unknown'}/Desktop`;
      logger.debug('[Node:RecoverSkill] Fast-path: mkdir permission denied → ASK_USER with Desktop option');
      return {
        action: 'ASK_USER',
        question: `I don't have permission to create a folder there (${args.cwd || 'that location'}). Would you like me to create it on your Desktop instead?`,
        options: [`Yes, use Desktop (${desktopPath})`, 'Choose a different location', 'Cancel']
      };
    }
  }

  // Command not found
  if (combinedError.includes('command not found') || combinedError.includes('no such file or directory')) {
    if (skill === 'shell.run') {
      logger.debug('[Node:RecoverSkill] Fast-path: command not found → ASK_USER');
      return {
        action: 'ASK_USER',
        question: `The command "${args.cmd}" wasn't found on your system. Is it installed? Would you like me to try installing it first?`,
        options: [`Install ${args.cmd} via brew`, 'Skip this step', 'Cancel']
      };
    }
  }

  // Search returned no results (mdfind/find/grep returned empty stdout)
  if (combinedError.includes('search_no_results')) {
    const cmd = args.cmd || 'mdfind';
    // Extract the search term from argv (value after -name flag, or first arg)
    const nameIdx = (args.argv || []).indexOf('-name');
    const searchTerm = nameIdx >= 0 ? args.argv[nameIdx + 1] : (args.argv?.[0] || '');
    // Extract search directory from argv (-onlyin value, or positional path arg, or cwd)
    const onlyInIdx = (args.argv || []).indexOf('-onlyin');
    const positionalPath = (args.argv || []).find(a => a.startsWith('/'));
    const searchDir = onlyInIdx >= 0 ? args.argv[onlyInIdx + 1]
      : (positionalPath && positionalPath !== searchTerm ? positionalPath : null)
      || args.cwd
      || `${process.env.HOME || '/Users/unknown'}/Desktop`;

    if (cmd === 'mdfind') {
      logger.debug(`[Node:RecoverSkill] Fast-path: mdfind no results → REPLAN with find in ${searchDir}`);
      return {
        action: 'REPLAN',
        suggestion: `mdfind (Spotlight) returned no results for "${searchTerm}" — Spotlight may not have indexed this file yet. Use find instead: find "${searchDir}" -name "${searchTerm}" -maxdepth 5`,
        constraint: `Search in "${searchDir}" using find, not mdfind. Set timeoutMs: 30000.`
      };
    }

    // find also returned nothing — widen the search scope
    if (cmd === 'find') {
      const home = process.env.HOME || '/Users/unknown';
      logger.debug(`[Node:RecoverSkill] Fast-path: find no results → REPLAN widening scope to ~`);
      return {
        action: 'REPLAN',
        suggestion: `find returned no results in "${searchDir}" for "${searchTerm}". Widen the search to the home directory: find "${home}" -name "${searchTerm}" -maxdepth 6`,
        constraint: `Search all of home directory using find. Set timeoutMs: 60000.`
      };
    }
  }

  // Timeout — smart recovery based on what timed out
  if (combinedError.includes('timed out') || combinedError.includes('timeout')) {
    // find timeout → REPLAN to use mdfind (macOS Spotlight) — instant, no directory scan
    if (skill === 'shell.run' && args.cmd === 'find' && stepRetryCount === 0) {
      const nameArg = args.argv?.find((a, i) => args.argv[i - 1] === '-name') || '';
      logger.debug('[Node:RecoverSkill] Fast-path: find timeout → REPLAN with mdfind (Spotlight)');
      return {
        action: 'REPLAN',
        suggestion: `The find command timed out scanning a large directory. Use mdfind (macOS Spotlight) instead — it is instant: mdfind -name "${nameArg || args.argv?.join(' ') || 'filename'}"`,
        constraint: 'Do not use find with a broad cwd like ~ or /Users. Use mdfind for file searches on macOS.'
      };
    }

    // Other commands: silent AUTO_PATCH with backoff (2x then 3x timeout)
    const retryAttempt = stepRetryCount + 1;
    const currentTimeout = args.timeoutMs || 10000;
    const multipliers = [2, 3]; // retry 1 → 2x, retry 2 → 3x

    if (retryAttempt <= multipliers.length) {
      const newTimeout = currentTimeout * multipliers[retryAttempt - 1];
      logger.debug(`[Node:RecoverSkill] Fast-path: timeout retry ${retryAttempt} → AUTO_PATCH timeoutMs ${currentTimeout}ms → ${newTimeout}ms`);
      return {
        action: 'AUTO_PATCH',
        patchedArgs: { timeoutMs: newTimeout },
        note: `Timeout retry ${retryAttempt}: increasing timeoutMs from ${currentTimeout}ms to ${newTimeout}ms`,
        _isTimeoutRetry: true
      };
    }

    // Exhausted silent retries → ask user
    logger.debug(`[Node:RecoverSkill] Fast-path: timeout exhausted ${multipliers.length} retries → ASK_USER`);
    return {
      action: 'ASK_USER',
      question: `"${args.cmd || skill}" timed out after ${multipliers.length + 1} attempts. Would you like to skip it or try a different approach?`,
      options: ['Skip this step and continue', 'Try a different approach', 'Cancel']
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Apply a recovery decision to state
// ---------------------------------------------------------------------------

function applyRecovery(decision, state, skillPlan, cursor, stepRetryCount, logger) {
  const { failedStep } = state;

  switch (decision.action) {
    case 'AUTO_PATCH': {
      logger.debug(`[Node:RecoverSkill] AUTO_PATCH: ${decision.note}`);
      const patchedPlan = skillPlan.map((step, i) => {
        if (i === cursor) {
          return { ...step, args: { ...step.args, ...decision.patchedArgs } };
        }
        return step;
      });
      // Increment retry count for timeout retries; reset for other patches
      const nextRetryCount = decision._isTimeoutRetry ? stepRetryCount + 1 : 0;
      return {
        ...state,
        recoveryAction: 'auto_patch',
        skillPlan: patchedPlan,
        skillCursor: cursor,   // retry same step with patched args
        failedStep: null,
        stepRetryCount: nextRetryCount,
        recoveryNote: decision.note
      };
    }

    case 'REPLAN': {
      logger.debug(`[Node:RecoverSkill] REPLAN: ${decision.suggestion}`);
      return {
        ...state,
        recoveryAction: 'replan',
        recoveryContext: {
          failedSkill: failedStep.skill,
          failedStep: failedStep.step,
          failureReason: failedStep.error,
          suggestion: decision.suggestion,
          alternativeCwd: decision.alternativeCwd || null,
          constraint: decision.constraint || null
        },
        failedStep: null,
        skillPlan: null,
        skillCursor: 0,
        stepRetryCount: 0
      };
    }

    case 'ASK_USER': {
      logger.debug(`[Node:RecoverSkill] ASK_USER: ${decision.question}`);
      const optionsList = (decision.options || [])
        .map((o, i) => `${i + 1}. ${o}`)
        .join('\n');
      return {
        ...state,
        recoveryAction: 'ask_user',
        pendingQuestion: {
          question: decision.question,
          options: decision.options || [],
          context: failedStep
        },
        commandExecuted: false,
        stepRetryCount: 0,
        answer: decision.options?.length
          ? `${decision.question}\n\n${optionsList}`
          : decision.question
      };
    }

    default:
      logger.warn(`[Node:RecoverSkill] Unknown action: ${decision.action} — defaulting to ASK_USER`);
      return {
        ...state,
        recoveryAction: 'ask_user',
        pendingQuestion: { question: `Step failed: ${failedStep.error}`, options: [], context: failedStep },
        commandExecuted: false,
        answer: `Step ${failedStep.step} failed: ${failedStep.error}`
      };
  }
}

// ---------------------------------------------------------------------------
// Parse LLM JSON decision
// ---------------------------------------------------------------------------

function parseDecision(raw, logger) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const start = text.indexOf('{');
  if (start !== -1) text = text.substring(start);

  try {
    return JSON.parse(text);
  } catch (e) {
    logger.warn('[Node:RecoverSkill] JSON parse failed:', e.message);
    return null;
  }
}

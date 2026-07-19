/**
 * Search for a service's canonical sign-in page URL using the web-search MCP.
 * Returns the first result URL that looks like a login page, or null on failure.
 * Non-fatal — any error silently falls through to knownUrl → rawLoginUrl.
 *
 * @param {string} service — normalized service name, e.g. 'gmail'
 * @param {string} fallbackUrl — the app URL we already have (for context only)
 * @param {object} mcpAdapter
 * @param {object} logger
 * @returns {Promise<string|null>}
 */
async function searchForLoginUrl(service, fallbackUrl, mcpAdapter, logger) {
  if (!mcpAdapter || !service || service === 'unknown') return null;
  try {
    const query = `${service} official sign in login page site:${service}.com OR site:accounts.${service}.com`;
    const res = await mcpAdapter.callService('web-search', 'web.search', {
      query:      `${service} official sign in login page`,
      maxResults: 5,
      provider:   'auto',
    }, { timeoutMs: 6000 });

    const data    = res?.data || res;
    const results = Array.isArray(data?.results) ? data.results : [];

    // The { isLoginSignal } helper considers URL path + subdomain patterns
    const { isLoginSignal } = require('../utils/buildLoginSubPlan');

    // Accept a result if its URL looks like an auth page OR the hostname contains
    // the service name — avoids accepting blog/article URLs about the service.
    const serviceSlug = service.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const r of results) {
      const url = String(r.url || r.link || '');
      if (!url.startsWith('http')) continue;
      let hostname = '';
      try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) { continue; }
      const looksLikeAuth    = isLoginSignal(url);
      const hostnameMatches  = hostname.includes(serviceSlug) || hostname.includes('accounts') || hostname.includes('login') || hostname.includes('auth');
      if (looksLikeAuth && hostnameMatches) {
        logger.info(`[Node:RecoverSkill] searchForLoginUrl: found "${url}" for service="${service}" (query result)`);
        return url;
      }
    }

    logger.info(`[Node:RecoverSkill] searchForLoginUrl: no clean auth URL found for "${service}" in ${results.length} results — using fallback`);
    return null;
  } catch (err) {
    logger.warn(`[Node:RecoverSkill] searchForLoginUrl failed (non-fatal): ${err.message}`);
    return null;
  }
}

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
const path = require('path');

function loadRecoveryPrompt() {
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
Decide: AUTO_PATCH (fix args inline), REPLAN_STEP (regenerate just this step), REPLAN (rebuild entire plan), or ASK_USER (need human input).
Be conservative: prefer ASK_USER over guessing.

AUTO_PATCH: { "action": "AUTO_PATCH", "patchedArgs": {...}, "note": "one-line explanation" }
REPLAN_STEP: { "action": "REPLAN_STEP", "suggestion": "what to do differently for this step", "constraint": "what to avoid", "category": "PATH|TOOL_SUB|AGENT_SUB|EXEC_MODE|TIMEOUT|GENERAL" }
REPLAN: { "action": "REPLAN", "suggestion": "what to do differently", "alternativeCwd": "/path", "constraint": "what to avoid" }
ASK_USER: { "action": "ASK_USER", "question": "clear question", "options": ["option A", "option B"] }

WHEN TO USE EACH:
- AUTO_PATCH: Fix a specific arg (path, timeout, flag). Same skill, same approach.
- REPLAN_STEP: Prior steps succeeded, only this step needs a different approach. Keeps completed work, regenerates just this step.
- REPLAN: The whole strategy is wrong - rebuild entire plan from scratch.
- ASK_USER: Need human input to proceed.

Prefer REPLAN_STEP over REPLAN when prior steps completed successfully — this avoids re-running work already done.

ESCALATION RULE: If the "Previous recovery attempts" list shows 2 or more entries with the same error class (same keyword repeating — e.g. "No such file or directory", "exit code 1", "ENOENT", "permission denied"), and your new suggestion would NOT fix the root cause (e.g. you don't know the correct path, or the fix requires user input), output ASK_USER — not REPLAN. REPLAN is only appropriate when you have a genuinely different strategy. Repeating REPLAN with minor variations while the same error recurs is always wrong.

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
    replanCount = 0,
    patchHistory = [],
    message,
    resolvedMessage,
    context
  } = state;

  const logger = state.logger || console;

  if (!failedStep) {
    logger.warn('[Node:RecoverSkill] No failedStep in state — nothing to recover');
    return state;
  }

  // ── OAuth failure short-circuit ───────────────────────────────────────────
  // When a skill fails because it has no token or the wrong scopes, the LLM
  // cannot auto-patch it — only reconnecting via the Skills tab can fix it.
  // Skip the full recover pipeline and surface a direct actionable message.
  // Also return triggerOAuthRepair so main.js auto-runs the scope repair.
  if (failedStep.needsOAuth) {
    const skillLabel = failedStep.args?.name
      || (failedStep.skill === 'external.skill' ? null : failedStep.skill)
      || 'this skill';
    const oauthMsg = `I\'ve started scanning **${skillLabel}** to detect the required OAuth permissions. Once the repair finishes:\n\n1. Open the **Skills** tab\n2. Find **${skillLabel}** — the scopes should now be populated\n3. Click **Reconnect** to grant access, then try again`;
    logger.info(`[Node:RecoverSkill] OAuth failure for "${skillLabel}" — triggering auto-repair + surfacing Skills tab guidance`);
    return {
      ...state,
      recoveryAction: 'ask_user',
      triggerOAuthRepair: { skillName: skillLabel },
      pendingQuestion: {
        question: oauthMsg,
        _isOAuthGuidance: true,
      },
      commandExecuted: false,
    };
  }

  // ── shell.run 403 OAuth scope error ──────────────────────────────────────
  // When shell.run exits 0 but the API returns 403 "insufficient authentication
  // scopes", the token exists but was granted too few scopes. The LLM cannot
  // fix this — only a reconnect with the correct scopes can.
  // Extract the skill name from the bash command's token-file path reference.
  const isShellRun403 =
    failedStep.skill === 'shell.run' &&
    /403|insufficient.*scope|invalid authentication credentials/i.test(failedStep.error || '');
  if (isShellRun403) {
    const argv = (failedStep.args?.argv || []).join(' ');
    const tokenMatch = argv.match(/tokens\/([a-zA-Z0-9._-]+)\.json/) ||
                       argv.match(/skill:([a-zA-Z0-9._-]+):/);
    const skillLabel = tokenMatch ? tokenMatch[1] : (state.matchedSkillName || 'this skill');
    const oauthMsg = `I've started scanning **${skillLabel}** to detect the required OAuth permissions. Once the repair finishes:\n\n1. Open the **Skills** tab\n2. Find **${skillLabel}** — the scopes should now be populated\n3. Click **Reconnect** to grant access with the detected permissions, then try again`;
    logger.info(`[Node:RecoverSkill] shell.run 403 OAuth scope error for "${skillLabel}" — triggering auto-repair`);
    return {
      ...state,
      recoveryAction: 'ask_user',
      triggerOAuthRepair: { skillName: skillLabel },
      pendingQuestion: {
        question: oauthMsg,
        _isOAuthGuidance: true,
      },
      commandExecuted: false,
    };
  }

  // ── Chrome crash detection ───────────────────────────────────────────────
  // When playwright.agent reports chromeCrash: true, this is a browser crash
  // not an auth/connection issue. The browser needs to be restarted.
  const isChromeCrash = 
    (failedStep.skill === 'playwright.agent' || failedStep.skill === 'browser.agent') &&
    (failedStep.result?.chromeCrash || /Chrome.*crashed|about:blank|browser crashed/i.test(failedStep.error || ''));
  
  if (isChromeCrash) {
    logger.info(`[Node:RecoverSkill] Chrome crash detected for ${failedStep.skill} — triggering browser restart instead of auth repair`);
    
    // Extract agent name from the failure for better error messaging
    const agentName = failedStep.error?.match(/([a-zA-Z]+\.agent)/)?.[1] || 
                     failedStep.result?.debugContext?.sessionId?.replace(/_/g, '.') || 
                     'the browser agent';
    
    const crashMsg = `**Chrome browser crashed** during automation with **${agentName}**. This is a technical issue, not an authentication problem.\n\n**What happened:**\n• Chrome window unexpectedly closed or crashed to "about:blank"\n• Debugging data was captured to help diagnose the issue\n\n**To continue:**\n1. Try your request again — a fresh browser session will start automatically\n2. If crashes persist, restart the ThinkDrop app to clear any browser state issues\n\n**Debugging info captured:**\n• Session duration and action history\n• Network and console errors\n• Trace and video recordings (if available)`;
    
    return {
      ...state,
      recoveryAction: 'ask_user',
      pendingQuestion: {
        question: crashMsg,
        _isChromeCrash: true,
        context: failedStep.result?.debugContext
      },
      commandExecuted: false,
      answer: crashMsg
    };
  }

  logger.debug(`[Node:RecoverSkill] Recovering from: ${failedStep.skill} — ${failedStep.error}`);

  // Update plan document to reflect the failed step and recovery attempt
  try {
    const { writePlanDoc } = require('../utils/planDocument');
    writePlanDoc(state, 'step_failed');
  } catch (_) {}

  // ── Runtime failure feedback → agent failure_log ─────────────────────────
  // When a skill that uses an agent fails, write the error back to the agent's
  // failure_log in DuckDB so validate_agent sees real production failures,
  // not just version drift or CLI health. This is the human feedback loop.
  if (mcpAdapter && failedStep.skill) {
    try {
      // Detect agent service from the skill name or args
      const _agentFromStep = (step) => {
        if (!step) return null;
        // external.skill with a known service in the name (e.g. github-pr-notifier)
        const skillLower = (step.skill || '').toLowerCase();
        const AGENT_SERVICES = [
          'github','twilio','aws','stripe','heroku','netlify','vercel','firebase',
          'gcloud','fly','doctl','docker','terraform','kubectl','shopify','supabase',
          'railway','render','planetscale','neon','doppler','turso','gmail','himalaya',
          'slack','discord','notion','airtable','openai','anthropic','linear','sendgrid',
          'mailgun','pinecone','cohere','huggingface',
        ];
        const matched = AGENT_SERVICES.find(svc =>
          skillLower.includes(svc) ||
          (step.args?.service || '').toLowerCase().includes(svc) ||
          (step.args?.agentId || '').toLowerCase().includes(svc)
        );
        if (!matched) return null;
        const agentId = step.args?.agentId || `${matched}.agent`;
        const agentType = ['gmail','slack','discord','notion','airtable'].includes(matched) ? 'browser' : 'cli';
        return { agentId, agentType };
      };

      const agentInfo = _agentFromStep(failedStep);
      if (agentInfo) {
        const { agentId, agentType } = agentInfo;
        const failureEntry = JSON.stringify({
          ts: new Date().toISOString(),
          skill: failedStep.skill,
          error: failedStep.error || 'unknown',
          stderr: (failedStep.stderr || '').slice(0, 400),
          exitCode: failedStep.exitCode,
        });
        const skillName = agentType === 'browser' ? 'browser.agent' : 'cli.agent';
        mcpAdapter.callService('command', 'command.automate', {
          skill: skillName,
          args: { action: 'record_failure', id: agentId, failureEntry },
        }, { timeoutMs: 3000 }).catch(() => {}); // fire-and-forget
        logger.debug(`[Node:RecoverSkill] Wrote runtime failure to ${agentId} failure_log`);
      }
    } catch (_) { /* non-fatal — never block recovery */ }
  }

  // ── Resolve LLM backend ──────────────────────────────────────────────
  const backend = llmBackend;

  // ── Replan limit: abort after too many replans to prevent infinite loops ─────
  // Guide flows legitimately navigate multiple pages (each triggers one replan),
  // so the limit must be high enough to cover a full multi-step guide journey.
  const MAX_REPLANS = 10;
  if (replanCount >= MAX_REPLANS) {
    logger.warn(`[Node:RecoverSkill] Replan limit reached (${replanCount}/${MAX_REPLANS}) — aborting`);
    return {
      ...state,
      recoveryAction: 'ask_user',
      pendingQuestion: {
        question: `I tried ${replanCount} different approaches but couldn't complete: "${resolvedMessage || message}". The step that kept failing was: ${failedStep.skill} — ${failedStep.error || 'no details'}. What would you like to do?`,
        options: ['Try again from scratch', 'Cancel this task'],
        context: failedStep
      },
      commandExecuted: false,
      answer: `I tried ${replanCount} different approaches but couldn't complete the task.\n\nFailing step: ${failedStep.skill}\nError: ${failedStep.error || 'unknown'}\n\nWhat would you like to do?`
    };
  }

  // ── Fast-path: known recoverable patterns (no LLM call needed) ──────────────
  const fastRecovery = tryFastRecovery(failedStep, skillPlan, skillCursor, stepRetryCount, logger, skillResults, state.activeBrowserUrl, replanCount, state.creatorSkillPath, state.webAgentBestUrl || null, patchHistory);
  if (fastRecovery) {
    return applyRecovery(fastRecovery, state, skillPlan, skillCursor, stepRetryCount, replanCount, logger);
  }

  // ── Emit progress event so UI reflects recovery state ───────────────────────
  if (typeof state.progressCallback === 'function') {
    try {
      state.progressCallback({
        type: 'recovering',
        skill: failedStep.skill,
        attempt: replanCount + 1,
        error: failedStep.error || 'unknown error',
        description: `Attempt ${replanCount + 1}: recovering from ${failedStep.skill} failure`,
      });
      // Also emit analyzing event for more granular UI feedback
      state.progressCallback({
        type: 'recovery:analyzing',
        skill: failedStep.skill,
        attempt: replanCount + 1,
        message: `Analyzing ${failedStep.skill} failure...`,
      });
    } catch (_) { /* never block recovery on progress callback errors */ }
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

  // ── Per-skill diagnostic context ─────────────────────────────────────────
  // Each skill type gets relevant evidence injected so the LLM can reason
  // about the actual failure rather than guessing from the error string alone.
  let skillContextSection = '';

  // ── browser.act: live page snapshot (visible inputs, buttons, URL) ───────
  if (failedStep.skill === 'browser.act' && mcpAdapter && failedStep.args?.sessionId) {
    try {
      const snapshotRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.act',
        args: { action: 'snapshot', sessionId: failedStep.args.sessionId }
      }, { timeoutMs: 8000 });
      const snapshotResult = snapshotRes?.data || snapshotRes;
      if (snapshotResult?.ok && snapshotResult?.result) {
        skillContextSection = `\nLive page snapshot at time of failure:\n${String(snapshotResult.result).substring(0, 1200)}\n`;
        logger.debug(`[Node:RecoverSkill] browser.act page snapshot captured (${String(snapshotResult.result).length} chars)`);
      }
    } catch (snapErr) {
      logger.debug(`[Node:RecoverSkill] browser.act page snapshot failed (non-fatal): ${snapErr.message}`);
    }
  }

  // ── shell.run: stdout/stderr preview + cwd existence + cmd availability ──
  if (failedStep.skill === 'shell.run') {
    const fsSync = require('fs');
    const { execFileSync } = require('child_process');
    const lines = [];

    // Auth-timeout hint (set by fast-path when curl+auth times out)
    if (failedStep._authTimeoutHint) {
      lines.push(`⚠️  AUTH TIMEOUT DIAGNOSIS:\n${failedStep._authTimeoutHint}`);
    }

    // Stdout preview (first 600 chars — often contains the real error message)
    const stdout = (failedStep.stdout || '').trim();
    if (stdout) lines.push(`stdout (first 600 chars):\n${stdout.substring(0, 600)}`);

    // Stderr preview (first 600 chars)
    const stderr = (failedStep.stderr || '').trim();
    if (stderr) lines.push(`stderr (first 600 chars):\n${stderr.substring(0, 600)}`);

    // Exit code meaning
    const exitCode = failedStep.exitCode;
    if (exitCode !== undefined && exitCode !== null) {
      const exitMeaning = exitCode === 1 ? 'general error' : exitCode === 2 ? 'misuse of shell command' :
        exitCode === 126 ? 'command not executable' : exitCode === 127 ? 'command not found' :
        exitCode === 130 ? 'terminated by Ctrl+C' : exitCode === 137 ? 'killed (OOM or SIGKILL)' :
        exitCode === 139 ? 'segfault' : exitCode === 255 ? 'exit status out of range / SSH error' :
        exitCode === -1 ? 'process killed by timeout — command did not finish in time' : '';
      lines.push(`Exit code: ${exitCode}${exitMeaning ? ` (${exitMeaning})` : ''}`);
    }

    // cwd existence check
    const cwd = failedStep.args?.cwd;
    if (cwd) {
      const cwdExists = fsSync.existsSync(cwd);
      lines.push(`cwd "${cwd}": ${cwdExists ? 'EXISTS' : 'DOES NOT EXIST — this is likely the cause'}`);
    }

    // cmd availability check (skip shell interpreters — always present)
    const cmd = failedStep.args?.cmd;
    const SHELL_CMDS = new Set(['bash', 'sh', 'zsh', 'python3', 'python', 'node', 'ruby', 'perl']);
    if (cmd && !SHELL_CMDS.has(cmd)) {
      try {
        const which = execFileSync('which', [cmd], { timeout: 2000, encoding: 'utf8' }).trim();
        lines.push(`"${cmd}" binary: found at ${which}`);
      } catch (_) {
        lines.push(`"${cmd}" binary: NOT FOUND on PATH — install it or use a different command`);
      }
    }

    // Prior successful shell.run stdout (gives LLM context about what was found/built before)
    const priorShellOutputs = skillResults
      .filter(r => r.skill === 'shell.run' && r.ok && r.stdout?.trim())
      .slice(-2)
      .map(r => `  Step ${r.step} stdout: ${String(r.stdout).trim().substring(0, 200)}`);
    if (priorShellOutputs.length) lines.push(`Prior shell.run outputs:\n${priorShellOutputs.join('\n')}`);

    // Python fallback hint — injected when the failure looks like a bash file/data op
    // that is better handled by Python (avoids quoting issues, encoding problems, sed/awk fragility).
    // Gives the recovery LLM a concrete suggestion instead of defaulting to ASK_USER.
    const _bashScript = (failedStep.args?.cmd === 'bash' && Array.isArray(failedStep.args?.argv))
      ? (failedStep.args.argv.find(a => typeof a === 'string' && a !== '-c') || '')
      : '';
    const _isBashFileOp = _bashScript.length > 0 && (
      /\bsed\b/.test(_bashScript) || /\bawk\b/.test(_bashScript) ||
      /\bjq\b/.test(_bashScript)  || /echo\s+.*>/.test(_bashScript) ||
      /\btee\b/.test(_bashScript) || /cat\s*>/.test(_bashScript) ||
      /\bwhile\b.*\b(mv|cp)\b/.test(_bashScript) ||
      /\bfind\b.*-exec\s+(mv|cp)\b/.test(_bashScript)
    );
    const _isQuotingError = (exitCode === 2) && (failedStep.args?.cmd === 'bash');
    if (_isBashFileOp || _isQuotingError) {
      lines.push(
        'PYTHON FALLBACK AVAILABLE: This failure (bash file edit / quoting error) is best resolved by switching to Python.\n' +
        '  Inline (<3 lines): bash -c "python3 -c \'import pathlib; p=pathlib.Path(FILE); p.write_text(p.read_text().replace(OLD,NEW))\'"\n' +
        '  Script (>3 lines): synthesize(saveToFile=/tmp/thinkdrop_task.py) then shell.run bash -c "python3 /tmp/thinkdrop_task.py"\n' +
        '  Packages needed: pip3 install pip-audit --quiet --user; pip-audit 2>/dev/null || true; pip3 install PACKAGE --quiet --user'
      );
      logger.debug('[Node:RecoverSkill] Python fallback hint injected');
    }

    // ── Web discovery: after 2+ failed replans, use web.agent to find current best approach ──
    // This is exhaustive recovery — like a human Googling when their first two guesses fail.
    // Fires when: replanCount >= 2 OR evaluateSkills flagged _needsWebDiscovery (retry 3+).
    if ((replanCount >= 2 || state._needsWebDiscovery) && mcpAdapter) {
      try {
        const taskDescription = (resolvedMessage || message || '').slice(0, 120);
        const webQuery = `${taskDescription} macOS terminal command 2024`;
        logger.info(`[Node:RecoverSkill] Web discovery triggered (replanCount=${replanCount}): "${webQuery.slice(0, 80)}"`);
        const webRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'web.agent',
          args: { action: 'get_tutorial_steps', query: webQuery }
        }, { timeoutMs: 10000 });
        const webData = webRes?.data || webRes;
        if (webData?.ok && Array.isArray(webData.mergedSteps) && webData.mergedSteps.length > 0) {
          const stepLines = webData.mergedSteps.slice(0, 8).map((s, i) => `  ${i + 1}. ${s.text || s}`).join('\n');
          lines.push(`\nWEB-DISCOVERED APPROACH (live search — use this instead of guessing):\n${stepLines}`);
          logger.info(`[Node:RecoverSkill] Web discovery injected ${webData.mergedSteps.length} steps`);
        } else if (webData?.ok && Array.isArray(webData.tutorials) && webData.tutorials.length > 0) {
          const snippet = webData.tutorials[0].rawSnippet || '';
          if (snippet) lines.push(`\nWEB-DISCOVERED APPROACH (live search):\n  ${snippet.slice(0, 400)}`);
        }
      } catch (webErr) {
        logger.debug(`[Node:RecoverSkill] Web discovery failed (non-fatal): ${webErr.message}`);
      }
    }

    if (lines.length) {
      skillContextSection = `\nshell.run diagnostic context:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
      logger.debug(`[Node:RecoverSkill] shell.run context injected (${lines.length} items)`);
    }
  }

  // ── image.analyze: file existence, size, extension ───────────────────────
  if (failedStep.skill === 'image.analyze') {
    const fsSync = require('fs');
    const path = require('path');
    const rawFilePath = failedStep.args?.filePath;
    // filePath may be an Array when LLM patches it with multiple files — normalize to string for diagnostics
    const filePath = Array.isArray(rawFilePath) ? rawFilePath[0] : rawFilePath;
    const lines = [];
    if (Array.isArray(rawFilePath)) {
      lines.push(`filePath is an Array (${rawFilePath.length} files) — image.analyze only accepts a single string path; plan must loop over each file separately`);
      lines.push(`Files: ${rawFilePath.slice(0, 5).join(', ')}${rawFilePath.length > 5 ? ` ... (${rawFilePath.length - 5} more)` : ''}`);
    }
    if (filePath) {
      const exists = fsSync.existsSync(filePath);
      lines.push(`filePath "${filePath}": ${exists ? 'EXISTS' : 'DOES NOT EXIST'}`);
      if (exists) {
        try {
          const stat = fsSync.statSync(filePath);
          lines.push(`File size: ${stat.size} bytes`);
        } catch (_) {}
      }
      const ext = path.extname(filePath).toLowerCase();
      const SUPPORTED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif']);
      lines.push(`Extension "${ext}": ${SUPPORTED.has(ext) ? 'supported' : 'NOT SUPPORTED — use a supported image format'}`);
    }
    if (lines.length) {
      skillContextSection = `\nimage.analyze diagnostic context:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
      logger.debug(`[Node:RecoverSkill] image.analyze context injected`);
    }
  }

  // ── skill.install: read the actual skill.md so the recovery LLM can see ─────
  // what fields are invalid or missing. Without this, the LLM only sees the HTTP
  // 400 error string and cannot generate a correct REPLAN fix.
  if (failedStep.skill === 'skill.install') {
    const fsSync = require('fs');
    const path = require('path');
    const skillPath = failedStep.args?.skillPath
      ? failedStep.args.skillPath.replace(/^~/, process.env.HOME || '')
      : null;
    const lines = [];

    if (skillPath) {
      lines.push(`skillPath: "${skillPath}"`);
      if (fsSync.existsSync(skillPath)) {
        try {
          const content = fsSync.readFileSync(skillPath, 'utf8').trim();
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            lines.push(`Current skill.md frontmatter:\n${fmMatch[1].split('\n').map(l => `    ${l}`).join('\n')}`);
          } else {
            lines.push(`skill.md content (first 500 chars):\n${content.substring(0, 500).split('\n').map(l => `    ${l}`).join('\n')}`);
          }
        } catch (readErr) {
          lines.push(`Could not read skill.md: ${readErr.message}`);
        }

        // Validate required fields and report which are missing
        const REQUIRED = ['name', 'description', 'exec_path', 'exec_type'];
        const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
        try {
          const raw = fsSync.readFileSync(skillPath, 'utf8');
          const fmMatch2 = raw.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch2) {
            const fm = fmMatch2[1];
            const missing = REQUIRED.filter(f => !new RegExp(`^${f}:`, 'm').test(fm));
            if (missing.length) lines.push(`MISSING required fields: ${missing.join(', ')}`);

            const nameMatch = fm.match(/^name:\s*(.+)$/m);
            if (nameMatch) {
              const skillName = nameMatch[1].trim();
              if (!SKILL_NAME_PATTERN.test(skillName)) {
                lines.push(`INVALID skill name "${skillName}" — must match /^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$/ (no hyphens, no digit-start segments)`);
              }
            }
          }
        } catch (_) {}
      } else {
        lines.push(`skill.md does NOT exist at path — shell.run write step may have failed silently`);
      }
    } else {
      lines.push(`No skillPath in args — cannot diagnose`);
    }

    lines.push(`REQUIRED frontmatter fields: name, description, exec_path, exec_type`);
    lines.push(`exec_type must be one of: python, node, shell`);
    lines.push(`name must match: /^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$/ (e.g. markdown.image.analyzer)`);
    lines.push(`exec_path must be inside ~/.thinkdrop/skills/<name>/`);
    lines.push(`CORRECT PATTERN: synthesize(saveToFile: "~/.thinkdrop/skills/[name]/skill.md") → skill.install(skillPath: same path)`);
    lines.push(`NEVER use shell.run to create skill.md files — always use synthesize with saveToFile`);
    lines.push(`NEVER use /Users/[user]/skill.md — always use ~/.thinkdrop/skills/[name]/skill.md`);

    skillContextSection = `\nskill.install diagnostic context:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
    logger.debug(`[Node:RecoverSkill] skill.install context injected (skillPath: ${skillPath})`);
  }

  // ── browser.agent: inject failure context for recovery LLM ──────────────────
  // Without this, the LLM only sees "playwright.agent delegation failed: X" with no
  // evidence about why — login wall, bot block, wrong domain, etc.
  if (failedStep.skill === 'browser.agent') {
    const lines = [];
    const result = failedStep.result || {};
    if (result.agentId)              lines.push(`agentId: ${result.agentId}`);
    if (failedStep.args?.url)        lines.push(`URL attempted: ${failedStep.args.url}`);
    if (result.loginWall)            lines.push(`Login wall detected — agent blocked by auth`);
    if (result.botBlock)             lines.push(`Bot block / CAPTCHA detected`);
    if (result.wrongDomain)          lines.push(`Wrong domain / parking page`);
    if (result.researchContentEmpty) lines.push(`Content extraction empty — likely CAPTCHA or bot block`);
    if (failedStep.error)            lines.push(`Error: ${failedStep.error}`);
    if (lines.length) {
      skillContextSection = `\nbrowser.agent diagnostic context:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
      logger.debug(`[Node:RecoverSkill] browser.agent diagnostic context injected`);
    }
  }

  const patchHistorySection = patchHistory.length
    ? `\nPrevious recovery attempts (already tried — DO NOT repeat these):\n${patchHistory.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}\n`
    : '';

  // Add DevTools debugging data if available
  const devToolsSection = failedStep.result?.debugContext?.devToolsData 
    ? `\nDevTools debugging data:
  Network requests (${failedStep.result.debugContext.devToolsData.networkRequests.length}):
${failedStep.result.debugContext.devToolsData.networkRequests.slice(-5).map(r => 
    `    • ${r.method} ${r.url} (${r.status}) - ${r.duration}ms`).join('\n') || '    (none)'}
  Console logs (${failedStep.result.debugContext.devToolsData.consoleLogs.length}):
${failedStep.result.debugContext.devToolsData.consoleLogs.slice(-3).map(l => 
    `    • ${l}`).join('\n') || '    (none)'}
  DevTools WebSocket: ${failedStep.result.debugContext.devToolsUrl || 'N/A'}
`
    : '';

  // Include recent conversation history so the LLM knows what was completed in prior turns
  const recentHistory = (state.conversationHistory || [])
    .filter(m => m.role === 'assistant')
    .slice(-3)
    .map(m => `- ${String(m.content || '').slice(0, 200)}`)
    .join('\n');
  const conversationContextSection = recentHistory
    ? `\nRecent conversation (what was already accomplished):\n${recentHistory}\n`
    : '';

  const recoveryQuery = `${conversationContextSection}Original user request: "${resolvedMessage || message}"

Failed step:
  Step number: ${failedStep.step}
  Skill: ${failedStep.skill}
  Args: ${JSON.stringify(failedStep.args, null, 2)}
  Error: ${failedStep.error}
  Exit code: ${failedStep.exitCode ?? 'N/A'}
  Stderr: ${failedStep.stderr || '(none)'}
${skillContextSection}${patchHistorySection}${devToolsSection}
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
      conversationHistory: (state.conversationHistory || []).slice(-6),
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

    let rawDecision = await backend.generateAnswer(recoveryQuery, payload, payload.options, null);
    logger.debug(`[Node:RecoverSkill] LLM decision: ${rawDecision.substring(0, 300)}`);

    let decision = parseDecision(rawDecision, logger);

    // Retry once with a stricter prompt if the LLM returned plain text (e.g. "I apologize...")
    if (!decision) {
      logger.warn('[Node:RecoverSkill] LLM returned non-JSON — retrying with strict JSON prompt');
      const retryPayload = {
        ...payload,
        query: `${recoveryQuery}\n\nYou MUST respond with ONLY a JSON object. No apologies, no explanation, no markdown. Pick one:\n{"action":"ASK_USER","question":"${failedStep.skill} step failed: ${(failedStep.error || 'unknown error').replace(/"/g, "'")}. How would you like to proceed?","options":["Skip this step","Abort the task","Try a different approach"]}\nor\n{"action":"REPLAN","suggestion":"try a different approach","alternativeCwd":null,"constraint":"avoid the same error"}\nor\n{"action":"AUTO_PATCH","patchedArgs":{},"note":"patched"}`,
        context: {
          ...payload.context,
          systemInstructions: 'Output ONLY valid JSON. One of: AUTO_PATCH, REPLAN, or ASK_USER. No text before or after the JSON object.'
        }
      };
      rawDecision = await backend.generateAnswer(retryPayload.query, retryPayload, retryPayload.options, null).catch(() => null);
      if (rawDecision) {
        logger.debug(`[Node:RecoverSkill] Retry LLM decision: ${rawDecision.substring(0, 300)}`);
        decision = parseDecision(rawDecision, logger);
      }
    }

    // If still no valid JSON after retry, default to ASK_USER rather than throwing
    if (!decision) {
      logger.warn('[Node:RecoverSkill] LLM still non-JSON after retry — defaulting to ASK_USER');
      decision = {
        action: 'ASK_USER',
        question: `Step ${failedStep.step} (${failedStep.skill}) failed: ${failedStep.error || 'unknown error'}. How would you like to proceed?`,
        options: ['Skip this step and continue', 'Abort the task', 'Try a different approach']
      };
    }

    return applyRecovery(decision, state, skillPlan, skillCursor, stepRetryCount, replanCount, logger);

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

// Extract a normalised error class fingerprint from an error string.
// Returns a short keyword used to detect repeated identical failures in patchHistory.
// Returns null for unknown error classes — those are left to MAX_REPLANS.
function _errorFingerprint(error) {
  const e = (error || '').toLowerCase();
  if (/no such file|not found|does not exist/.test(e)) return 'no such file';
  if (/permission denied/.test(e))                     return 'permission denied';
  if (/enoent/.test(e))                                return 'enoent';
  if (/cannot move.*into itself/.test(e))              return 'cannot move into itself';
  if (/invalid argument/.test(e))                      return 'invalid argument';
  if (/agentic loop reached max_turns|max_turns.*without completing|reached max_turns/i.test(e)) return 'max_turns_exhausted';
  return null;
}

function tryFastRecovery(failedStep, skillPlan, cursor, stepRetryCount, logger, skillResults, activeBrowserUrl, replanCount = 0, creatorSkillPath = null, webAgentBestUrl = null, patchHistory = []) {
  const { skill, args = {}, error = '', stderr = '' } = failedStep;
  const combinedError = `${error} ${stderr}`.toLowerCase();

  // ── app.agent monitor timeout → ASK_USER (never concurrent retry) ───────────
  // A monitor (monitor_with_backoff etc.) runs a single long-lived server-side
  // loop. The generic 2×/3× timeoutMs retry would relaunch the monitor while the
  // first loop may still be tearing down — spawning concurrent capture loops that
  // taint OCR and never stop. The right outcome when a monitor times out is to
  // ask the user how to proceed, not to silently relaunch it.
  const MONITOR_ACTIONS = new Set([
    'monitor_with_backoff', 'monitor_file_upload',
    'monitor_build_completion', 'monitor_form_submission',
  ]);
  if (skill === 'app.agent' && MONITOR_ACTIONS.has(args.action)) {
    // A clean abort (client disconnect / superseded) is not a failure to recover.
    if (failedStep.aborted) {
      logger.info('[Node:RecoverSkill] app.agent monitor aborted — surfacing as ASK_USER (no relaunch)');
    }
    const isTimeout = failedStep.aborted || /monitoring timeout|timed out|timeout/i.test(combinedError) || !error;
    if (isTimeout) {
      logger.info('[Node:RecoverSkill] Fast-path: app.agent monitor timeout → ASK_USER (no concurrent relaunch)');
      return {
        action: 'ASK_USER',
        question: `I waited but couldn't confirm the task finished. It may still be running. How would you like to proceed?`,
        options: ['Keep waiting (check again)', 'It finished — continue', 'Cancel this task'],
      };
    }
  }

  // ── Progress-aware stuck detection ──────────────────────────────────────────
  // If patchHistory already contains 2+ entries matching the same error fingerprint,
  // recovery is cycling without progress — escalate to ASK_USER immediately.
  // This is NOT a fixed replan count: different errors on each attempt → fingerprints
  // differ → no escalation. Same error every time → escalate.
  const fingerprint = _errorFingerprint(error);
  // MAX_TURNS exhaustion special case: escalate after just 1 prior match.
  // Hitting MAX_TURNS twice is definitively unrecoverable without user input —
  // the agent will keep exhausting turns on every retry.
  if (fingerprint === 'max_turns_exhausted' && patchHistory.length >= 1) {
    const exhaustedCount = patchHistory.filter(p => p.toLowerCase().includes('max_turns_exhausted')).length;
    if (exhaustedCount >= 1) {
      logger.info(`[Node:RecoverSkill] MAX_TURNS exhausted twice — escalating to ASK_USER immediately`);
      return {
        action: 'ASK_USER',
        question: `The agent ran out of steps (MAX_TURNS) twice trying to complete this task. It may need to be broken into smaller pieces. What would you like to do?`,
        options: ['Break it into smaller steps', 'Try a different approach', 'Cancel this task'],
      };
    }
  }
  if (fingerprint && fingerprint !== 'max_turns_exhausted' && patchHistory.length >= 2) {
    const sameErrorCount = patchHistory.filter(p => p.toLowerCase().includes(fingerprint)).length;
    if (sameErrorCount >= 2) {
      logger.info(`[Node:RecoverSkill] Stuck detection: error fingerprint "${fingerprint}" found in ${sameErrorCount}/${patchHistory.length} prior attempts — escalating to ASK_USER`);
      return {
        action: 'ASK_USER',
        question: `I've tried ${patchHistory.length} approaches but keep hitting the same issue: "${(error || '').slice(0, 120)}". I need your input to proceed — what would you like to do?`,
        options: ['Give me the correct path or value', 'Skip this step', 'Cancel this task'],
      };
    }
  }

  // ── shell.run exit 1: path not found → search common locations → AUTO_PATCH ──
  // When the command fails because a folder/file path doesn't exist, extract the bad
  // path from the command, search Desktop/Documents/Downloads/home for the name, and
  // AUTO_PATCH the step with the real path — no LLM call needed, no user prompt.
  if (skill === 'shell.run' && failedStep.exitCode === 1) {
    const _combinedOut = ((failedStep.stdout || '') + ' ' + (failedStep.stderr || '')).toLowerCase();
    const _isPathMissing = _combinedOut.includes('no such file or directory') || _combinedOut.includes('does not exist');
    if (_isPathMissing) {
      // Extract all absolute paths from the bash script
      const _bashScript = args.cmd === 'bash' ? (Array.isArray(args.argv) ? args.argv.join(' ') : (args.argv || '')) : '';
      const _goalStr = args.goal || '';
      const _allText = _bashScript + ' ' + _goalStr;
      // Match /Users/... or ~/... paths, grab the leaf folder name
      const _pathMatches = _allText.match(/(?:\/Users\/[^\s"'\\]+|~\/[^\s"'\\]+)/g) || [];
      const _badPaths = _pathMatches.filter(p => {
        try {
          const _resolved = p.replace(/^~/, process.env.HOME || '/Users/' + (process.env.USER || 'unknown'));
          return !require('fs').existsSync(_resolved);
        } catch (_) { return false; }
      });
      if (_badPaths.length > 0) {
        const _badPath = _badPaths[0];
        const _folderName = require('path').basename(_badPath);
        const _homeDir = process.env.HOME || ('/Users/' + (process.env.USER || 'unknown'));
        // Search Desktop, Documents, Downloads, home (maxdepth 2)
        try {
          const { execSync } = require('child_process');
          const _searchCmd = `find "${_homeDir}/Desktop" "${_homeDir}/Documents" "${_homeDir}/Downloads" "${_homeDir}" -maxdepth 2 -name "${_folderName}" -type d 2>/dev/null | head -5`;
          const _found = execSync(_searchCmd, { timeout: 3000, encoding: 'utf8' }).trim();
          const _candidates = _found ? _found.split('\n').filter(Boolean) : [];
          if (_candidates.length === 1) {
            const _realPath = _candidates[0];
            const _resolved = _badPath.replace(/^~/, _homeDir);
            const _newGoal = _goalStr
              ? _goalStr.replace(new RegExp(_folderName, 'g'), _realPath)
              : null;
            const _patchedArgs = _newGoal
              ? { goal: _newGoal }
              : {
                  argv: Array.isArray(args.argv)
                    ? args.argv.map(a => a.split(_resolved).join(_realPath))
                    : args.argv
                };
            logger.info(`[Node:RecoverSkill] Fast-path: folder "${_folderName}" not at "${_resolved}" — found at "${_realPath}" → AUTO_PATCH`);
            return {
              action: 'AUTO_PATCH',
              patchedArgs: _patchedArgs,
              note: `Folder "${_folderName}" is at "${_realPath}", not "${_resolved}" — corrected path`,
            };
          } else if (_candidates.length > 1) {
            const _opts = _candidates.slice(0, 4).map(c => `Use "${c}"`);
            logger.info(`[Node:RecoverSkill] Fast-path: folder "${_folderName}" found in ${_candidates.length} locations → ASK_USER`);
            return {
              action: 'ASK_USER',
              question: `I found "${_folderName}" in multiple locations. Which one did you mean?`,
              options: [..._opts, 'Cancel'],
            };
          } else {
            logger.info(`[Node:RecoverSkill] Fast-path: folder "${_folderName}" not found anywhere under Desktop/Documents/Downloads/home → ASK_USER`);
            return {
              action: 'ASK_USER',
              question: `I couldn't find a folder named "${_folderName}" on your Mac. Would you like to:`,
              options: [
                `Search your entire home folder for "${_folderName}"`,
                `Enter the full path manually`,
                'Cancel',
              ],
            };
          }
        } catch (_searchErr) {
          logger.debug(`[Node:RecoverSkill] Fast-path: path-search execSync failed (non-fatal): ${_searchErr.message}`);
        }
      }
    }
  }

  // ── shell.run bash exit 1 after prior attempt → switch to goal mode ───────
  // When bash generates exit code 1 and has already been attempted/patched once,
  // escalate to REPLAN using args.goal. The shell executor's expert LLM (SHELL_RUN_SYSTEM)
  // will then pick the correct tool (python3/bash/osascript) rather than planSkills
  // generating raw argv that bypasses all safety rules.
  if (skill === 'shell.run' && failedStep.exitCode === 1) {
    const priorAttempts = patchHistory.filter(p => /AUTO_PATCH|REPLAN/i.test(p)).length;
    if (priorAttempts >= 1) {
      logger.info(`[Node:RecoverSkill] Fast-path: shell.run bash exit 1 after ${priorAttempts} prior attempt(s) — escalating to goal-mode REPLAN`);
      return {
        action: 'REPLAN',
        suggestion: `Bash command failed ${priorAttempts + 1} times. Switch to args.goal mode — describe the task in plain English and let the shell executor pick the correct tool (python3, bash, osascript, etc.).`,
        constraint: 'USE GOAL MODE: Do NOT generate args.cmd or args.argv. Emit { "skill": "shell.run", "args": { "goal": "<plain English description of the task>" } } only. The executor will generate a safe, correct command.',
      };
    }
  }

  // ── shell.run: Force Python after 2+ bash failures ────────────────────────
  // Track execution mode attempts and escalate to EXEC_MODE category to force
  // python3 execution when bash keeps failing (GNU vs BSD command differences, etc.)
  if (skill === 'shell.run' && failedStep.exitCode === 1 && args?.cmd === 'bash') {
    // Count bash attempts from patch history (look for bash in the patched commands)
    const bashAttempts = patchHistory.filter(p => {
      if (typeof p !== 'string') return false;
      // Check if this was a bash-related patch/replan
      return p.includes('bash') || p.includes('shell.run');
    }).length + 1; // +1 for current failed attempt
    
    if (bashAttempts >= 2) {
      logger.info(`[Node:RecoverSkill] Fast-path: ${bashAttempts} bash attempts failed — escalating to EXEC_MODE (force Python)`);
      // Emit mode switch event for UI visibility
      if (typeof state.progressCallback === 'function') {
        try {
          state.progressCallback({
            type: 'recovery:mode_switch',
            skill: failedStep.skill,
            fromMode: 'bash',
            toMode: 'python3',
            message: `Switching from bash to Python3 after ${bashAttempts} failures`,
          });
        } catch (_) {}
      }
      return {
        action: 'REPLAN',
        category: 'EXEC_MODE',
        suggestion: `Bash command failed ${bashAttempts} times. This is likely due to GNU vs BSD command differences on macOS (e.g., 'find -printf' not available). Switch to Python3 for cross-platform compatibility.`,
        constraint: 'USE PYTHON3: Emit shell.run with "cmd": "python3", "argv": ["-c", "python_script_here"]. Use pathlib for file operations, os.stat for file info. Do NOT use bash.',
      };
    }
  }

  // ── browser.agent run: wrong destination ─ auto-correct surfaced as ASK_USER ──
  // browser.agent returned {wrongDestination:true} when the pre-navigation resolver
  // detected the configured startUrl doesn't match the task intent and no high-confidence
  // correction existed. Surface the exact question the resolver built so the user can
  // pick the right endpoint. On resume, browser.agent injects the answer as resume context
  // and re-runs without prompting again.
  if (skill === 'browser.agent' && failedStep.wrongDestination) {
    const agentId     = args?.agentId || '';
    const question    = failedStep.question || `Which version of ${agentId.replace(/\.agent$/, '')} would you like to open?`;
    const options     = Array.isArray(failedStep.options) ? failedStep.options : [];
    logger.info(`[Node:RecoverSkill] Fast-path: ${skill} wrong-destination for "${agentId}" → ASK_USER`);
    return {
      action:   'ASK_USER',
      question,
      options,
      _isAgentAskUser: true,
      agentId,
    };
  }

  // ── browser.agent run: wrong domain (squatter/parking page self-heal failed) ─
  // browser.agent landed on a domain squatter and web.agent could not find the
  // correct URL internally. Replan using web.agent at the plan level to find
  // a direct URL and navigate to it, bypassing the incorrect agent altogether.
  if (skill === 'browser.agent' && failedStep.wrongDomain) {
    const agentId      = args?.agentId || '';
    const serviceName  = failedStep.expectedService?.replace(/\.agent$/, '') || agentId.replace(/\.agent$/, '') || 'this service';
    const taskDesc     = args?.task || '';
    const landedUrl    = failedStep.landedUrl || 'unknown';
    logger.info(`[Node:RecoverSkill] Fast-path: ${skill} wrongDomain for "${agentId}" (landed=${landedUrl}) → REPLAN via web.agent`);
    return {
      action: 'REPLAN',
      suggestion: `${agentId} navigated to a domain parking/squatter page (${landedUrl}). Use web.agent to find the correct URL for "${serviceName}", then navigate directly.`,
      constraint: `MUST replace the failing ${agentId} step with these steps in order:
1. { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "${serviceName} official website ${taskDesc.replace(/"/g, '').slice(0, 60)}", "preferDomain": "${serviceName}" }, "description": "Find correct URL for ${serviceName} via web search" }
2. { "skill": "browser.act", "args": { "action": "navigate", "url": "{{bestUrl}}", "sessionId": "browser" }, "description": "Navigate directly to correct URL" }
3. { "skill": "browser.act", "args": { "action": "getPageText", "sessionId": "browser" }, "description": "Read page content" }
Then keep any synthesize step that follows. Do NOT use browser.agent for this — navigate directly via browser.act.`,
    };
  }

  // ── browser.agent run: research content empty (login/nav page) ──────────
  // browser.agent returned {researchContentEmpty:true} when the page loaded but
  // contained only navigation/welcome content instead of actual research data.
  //
  // Auto-fallback chain (transparent to the user until all options are exhausted):
  //   0. Any service other than web/googleaimode/duckduckgo → try web.agent first
  //      (finds a direct article URL, bypasses CAPTCHA-triggering search forms)
  //   1. web.agent failed/unavailable → try Google AI Mode
  //   2. googleaimode.agent failed    → try DuckDuckGo
  //   3. duckduckgo.agent failed      → ASK_USER (all auto-fallbacks done)
  if (skill === 'browser.agent' && failedStep.researchContentEmpty) {
    const agentId     = args?.agentId || '';
    const agentBase   = agentId.replace(/\.agent$/, '').toLowerCase();
    const serviceName = agentId.replace(/\.agent$/, '') || 'this service';
    const taskDesc    = args?.task || '';

    if (agentBase !== 'webagent' && agentBase !== 'googleaimode' && agentBase !== 'duckduckgo') {
      // First fallback: use web.agent to find a direct URL to the content
      // (like a human Googling to find the specific article URL, bypassing bot-blocking search forms)
      logger.info(`[Node:RecoverSkill] Fast-path: ${skill} research-content-empty for "${agentId}" → auto-REPLAN web.agent search_and_navigate`);
      const _escapedTask = taskDesc.replace(/"/g, '').slice(0, 80);
      return {
        action: 'REPLAN',
        suggestion: `${serviceName} returned a navigation/welcome page (likely CAPTCHA or bot detection). Using web.agent to find a direct article URL, then navigating to it directly to bypass the search form.`,
        constraint: `MUST replace the failing ${agentId} step with these steps in order:
1. { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "${_escapedTask} site:${serviceName.toLowerCase()}.com", "preferDomain": "${serviceName.toLowerCase()}" }, "description": "Find direct URL for the content via web search" }
2. { "skill": "browser.act", "args": { "action": "navigate", "url": "{{bestUrl}}", "sessionId": "browser" }, "description": "Navigate directly to content URL (no CAPTCHA)" }
3. { "skill": "browser.act", "args": { "action": "getPageText", "sessionId": "browser" }, "description": "Read page content" }
Then keep any synthesize step that follows. The {{bestUrl}} token in the navigate step will be automatically resolved to the URL returned by web.agent.`,
      };
    }

    if (agentBase === 'googleaimode') {
      // Second fallback: try DuckDuckGo automatically
      logger.info(`[Node:RecoverSkill] Fast-path: googleaimode.agent research-content-empty → auto-REPLAN duckduckgo.agent`);
      return {
        action: 'REPLAN',
        suggestion: `Google AI Mode also returned a navigation page. Automatically retrying with DuckDuckGo.`,
        constraint: `Replace the failing googleaimode.agent step with a duckduckgo.agent step: { "skill": "browser.agent", "args": { "action": "run", "agentId": "duckduckgo.agent", "task": "${taskDesc.replace(/"/g, '\\"')}" } }. Keep all other plan steps unchanged.`,
      };
    }

    // All auto-fallbacks exhausted — ask the user
    logger.info(`[Node:RecoverSkill] Fast-path: duckduckgo.agent research-content-empty → ASK_USER (all fallbacks exhausted)`);
    return {
      action: 'ASK_USER',
      question: `All automatic search fallbacks failed (tried ${serviceName}, web.agent, Google AI Mode, and DuckDuckGo) — each returned a navigation/welcome page instead of results.\n\nHow would you like to proceed?`,
      options: ['Try a different source (specify below)', 'Skip this research step', 'Cancel task'],
    };
  }

  // ── browser.agent run: auth timeout or login wall ─────────────────────────
  // When waitForAuth times out or a login wall is detected, the failure is
  // user-correctable (they need to sign in) — NOT plan-correctable. Falling
  // through to the LLM causes a REPLAN → same step → 120s timeout → REPLAN
  // loop (up to MAX_REPLANS=10, ~20 min). Surface as ASK_USER immediately.
  if (skill === 'browser.agent' && (
    failedStep.loginWallDetected ||
    /auth failed|waitforauth.*timed out|auth.*timed out|authentication not completed/i.test(combinedError)
  )) {
    const agentId     = args?.agentId || '';
    const serviceName = agentId.replace(/\.agent$/, '') || 'this service';
    logger.info(`[Node:RecoverSkill] Fast-path: ${skill} auth timeout/login-wall for "${agentId}" → ASK_USER`);
    return {
      action: 'ASK_USER',
      question: `I was unable to sign in to **${serviceName}** automatically — the browser window should be open at the login page.\n\nPlease sign in, then click **"I signed in — retry"** to continue.`,
      options: ['I signed in — retry', 'Skip this step', 'Cancel task'],
    };
  }

  // ── browser.agent run: agent not found (needsBuild) ──────────────────────
  // browser.agent.cjs auto-builds the agent inline during run. If it still returns
  // needsBuild:true it means the auto-build itself failed (no KNOWN_BROWSER_SERVICES
  // entry, network error, etc.). REPLAN with an explicit build_agent step rather than
  // falling through to the LLM which always defaults to ASK_USER for this pattern.
  if (skill === 'browser.agent' && failedStep.needsBuild) {
    const agentId    = args.agentId || '';
    const serviceKey = agentId.replace(/\.agent$/, '');
    logger.debug(`[Node:RecoverSkill] Fast-path: browser.agent needsBuild for "${agentId}" → REPLAN`);
    return {
      action: 'REPLAN',
      suggestion: `Agent "${agentId}" could not be auto-built. Add an explicit browser.agent build_agent step for service "${serviceKey}" immediately before the run step.`,
      constraint: `MUST insert: { "skill": "browser.agent", "args": { "action": "build_agent", "service": "${serviceKey}" } } immediately before the failing run step. Do NOT use action:run for an agent that does not exist.`,
    };
  }

  // ── payload.check: LLM already classified the failure — dispatch directly ──
  // _payloadCheckResult is set inline in executeCommand after a semantic payload
  // check fails. The reason is already known, so skip the LLM recovery round-trip.
  if (failedStep._payloadCheckResult) {
    const { reason, explanation, suggestion } = failedStep._payloadCheckResult;
    if (reason === 'ask_user') {
      logger.debug(`[Node:RecoverSkill] Fast-path: payload.check user_correctable → ASK_USER`);
      return {
        action: 'ASK_USER',
        question: explanation + (suggestion ? `\n\nSuggestion: ${suggestion}` : ''),
      };
    }
    // system_issue or any other reason → replan
    logger.debug(`[Node:RecoverSkill] Fast-path: payload.check system_issue → REPLAN`);
    return {
      action: 'REPLAN',
      reason: explanation,
    };
  }

  // shell.run: full shell string passed as cmd instead of splitting cmd + argv.
  // Caught either early by validate() (_shellStringInCmd) or at spawn time (ENOENT on spaces/globs).
  // AUTO_PATCH: globs/operators → bash -c; plain spaces → split into cmd + argv (no bash wrapper).
  const isShellStringError = failedStep._shellStringInCmd ||
    (skill === 'shell.run' && /spawn .+ ENOENT/i.test(error));
  if (isShellStringError) {
    const rawCmd = (args?.cmd || '').trim();
    if (rawCmd && /\s/.test(rawCmd)) {
      const needsShell = /[*?|;&$`"']/.test(rawCmd);
      logger.info(`[Node:RecoverSkill] Fast-path: shell.run shell string in cmd (needsShell=${needsShell}) → AUTO_PATCH`);
      if (needsShell) {
        return {
          action: 'AUTO_PATCH',
          patchedArgs: { cmd: 'bash', argv: ['-c', rawCmd] },
          note: `Rewrote shell string with globs/operators as bash -c: "${rawCmd.slice(0, 60)}..."`,
        };
      } else {
        const parts = rawCmd.split(/\s+/);
        return {
          action: 'AUTO_PATCH',
          patchedArgs: { cmd: parts[0], argv: parts.slice(1) },
          note: `Split full shell string into cmd + argv: cmd="${parts[0]}", argv=${JSON.stringify(parts.slice(1))}`,
        };
      }
    }
  }

  // shell.run: command not allowlisted yet — ask user to allow and retry.
  // The write to ~/.thinkdrop/allowed-commands.json is handled in main.js on explicit user consent.
  if (skill === 'shell.run' && failedStep.userAllowlistHint && failedStep.commandName) {
    const cmdName = String(failedStep.commandName).trim();
    logger.debug(`[Node:RecoverSkill] Fast-path: shell.run allowlist gate for "${cmdName}" → ASK_USER`);
    return {
      action: 'ASK_USER',
      question: `"${cmdName}" is not in your trusted command allowlist yet. Allow it and retry this step?`,
      options: [
        `Allow "${cmdName}" and retry`,
        'Cancel',
      ],
    };
  }

  // shell.run: output verification failed — branch by tool + stderr hints.
  if (skill === 'shell.run' && failedStep.missingPath) {
    const toolName = String(failedStep.toolName || failedStep.args?.cmd || '').toLowerCase();
    const stderrHint = String(failedStep.stderrHint || failedStep.stderr || failedStep.error || '');
    const stderrLow = stderrHint.toLowerCase();

    if (toolName === 'pandoc') {
      if (/pdflatex|xelatex|lualatex|latex|texlive|pdf engine|no such file or directory/i.test(stderrHint)) {
        logger.debug('[Node:RecoverSkill] Fast-path: pandoc missing PDF engine → REPLAN');
        return {
          action: 'REPLAN',
          suggestion: `Pandoc failed to generate ${failedStep.missingPath} because the default PDF engine is unavailable. Retry using wkhtmltopdf and verify output existence after conversion.`,
          constraint: 'Before pandoc conversion, check wkhtmltopdf availability and install if missing: command -v wkhtmltopdf >/dev/null 2>&1 || brew install wkhtmltopdf. Then run pandoc with --pdf-engine=wkhtmltopdf and verify the output file exists.',
        };
      }
      if (/wkhtmltopdf|no pdf engine/i.test(stderrLow)) {
        logger.debug('[Node:RecoverSkill] Fast-path: pandoc still missing engine after retry → ASK_USER');
        return {
          action: 'ASK_USER',
          question: `I could not create ${failedStep.missingPath} because no working PDF engine is installed. Would you like me to install wkhtmltopdf and retry, switch to HTML output, or stop here?`,
          options: [
            'Install wkhtmltopdf and retry',
            'Switch to HTML output instead',
            'Cancel',
          ],
        };
      }
    }

    if (toolName === 'curl' || toolName === 'wget') {
      logger.debug('[Node:RecoverSkill] Fast-path: download output missing → ASK_USER');
      return {
        action: 'ASK_USER',
        question: `The download did not produce ${failedStep.missingPath}. This may be a bad URL, blocked request, or auth issue. What would you like to do?`,
        options: [
          'Retry with the same URL',
          'Provide a different URL',
          'Cancel',
        ],
      };
    }

    if (toolName === 'mkdir' && /permission denied|operation not permitted/i.test(stderrLow)) {
      logger.debug('[Node:RecoverSkill] Fast-path: mkdir permission error → ASK_USER');
      return {
        action: 'ASK_USER',
        question: `Could not create ${failedStep.missingPath} due to permissions. Choose a writable location to continue.`,
        options: [
          'Use Desktop instead',
          'Use Documents instead',
          'Use /tmp instead',
          'Cancel',
        ],
      };
    }
  }

  // Cannot find module '<pkg>' on external.skill — auto-install the missing package
  // This fires when a generated skill requires a npm package that isn't installed yet.
  // We inject a shell.run npm install step immediately before the failing step and retry.
  if (skill === 'external.skill' && (combinedError.includes('cannot find module') || combinedError.includes("module not found"))) {
    const path = require('path');
    // Extract module name: "Cannot find module 'node-fetch'" → 'node-fetch'
    const moduleMatch = (error + ' ' + stderr).match(/cannot find module ['"]((?:@[^/"']+\/)?[^/"'@][^"']*)['"]?/i);
    const missingPkg = moduleMatch ? moduleMatch[1] : null;

    if (missingPkg && stepRetryCount === 0) {
      // Packages that ship only TypeScript source — npm install succeeds but require() fails
      // because there is no compiled api.js / index.js. These MUST be replaced with native https.
      const BROKEN_TS_ONLY_PACKAGES = ['clicksend'];
      if (BROKEN_TS_ONLY_PACKAGES.includes(missingPkg)) {
        logger.debug(`[Node:RecoverSkill] Fast-path: '${missingPkg}' is a TS-only package (no compiled JS) → REPLAN with https`);
        return {
          action: 'REPLAN',
          suggestion: `The package '${missingPkg}' ships only TypeScript source and cannot be required in Node.js. Rewrite the skill to use Node.js built-in 'https' module to call the ${missingPkg} REST API directly instead of using the npm package.`,
          constraint: `NEVER require('${missingPkg}'). Use 'https.request()' with Basic Auth (Buffer.from('username:apiKey').toString('base64')) to call the REST endpoint. Get username and apiKey from context.secrets.`,
        };
      }

      // Derive the skill directory: prefer creatorSkillPath (most reliable), then args, then skill name
      const skillPath = creatorSkillPath || args.skillPath || args.path || null;
      const skillName = args.name || args.skillName || null;
      const skillDir = skillPath
        ? path.dirname(skillPath)
        : skillName
          ? path.join(process.env.HOME || '/Users/unknown', '.thinkdrop', 'skills', skillName)
          : null;

      if (skillDir) {
        logger.debug(`[Node:RecoverSkill] Fast-path: Cannot find module '${missingPkg}' → INSTALL_AND_RETRY in ${skillDir}`);
        return {
          action: 'INSTALL_AND_RETRY',
          missingPkg,
          skillDir,
          note: `Auto-installing missing dependency '${missingPkg}' in ${skillDir}`,
        };
      }
    }

    // Can't determine skill dir — replan with install instruction
    if (missingPkg) {
      logger.debug(`[Node:RecoverSkill] Fast-path: Cannot find module '${missingPkg}' (no skillDir) → REPLAN`);
      return {
        action: 'REPLAN',
        suggestion: `The skill failed because '${missingPkg}' is not installed. Add a shell.run step to run 'npm install ${missingPkg}' in the skill directory before running the skill.`,
        constraint: `Before external.skill, add: shell.run { cmd: 'npm', argv: ['install', '${missingPkg}'], cwd: '~/.thinkdrop/skills', timeoutMs: 60000 }. Then retry external.skill.`
      };
    }
  }

  // Skill not yet implemented — no amount of replanning will fix this
  if (combinedError.includes('not yet implemented')) {
    logger.debug(`[Node:RecoverSkill] Fast-path: ${skill} not yet implemented → ASK_USER`);
    return {
      action: 'ASK_USER',
      question: `The "${skill}" skill isn't available yet in this version of Thinkdrop. Would you like me to try a different approach using only shell commands?`,
      options: ['Yes, try with shell commands only', 'Cancel this task']
    };
  }

  // ── macOS Automation / Apple Events permission denial ─────────────────────
  // osascript attempting to control apps via Apple Events fails with error -1743
  // ("not allowed to send Apple events to X") when macOS Automation permission
  // hasn't been granted. The LLM cannot fix this — only the user can grant access.
  if (skill === 'shell.run' && (
    combinedError.includes('not allowed to send apple events') ||
    combinedError.includes('not authorized to send apple events') ||
    combinedError.includes('sending apple events to') ||
    /-1743/.test(combinedError)
  )) {
    logger.debug(`[Node:RecoverSkill] Fast-path: Apple Events permission denied → ASK_USER`);
    // Extract the target app name from the error if possible (e.g. "not allowed to send Apple events to Terminal")
    const appMatch = combinedError.match(/(?:apple events to|send apple events to)\s+([a-z][a-z\s]+?)(?:\.|,|$)/i);
    const appName = appMatch ? appMatch[1].trim() : 'the target app';
    return {
      action: 'ASK_USER',
      question: `macOS blocked ThinkDrop from sending Apple Events to **${appName}** — this requires Automation permission.\n\n**To fix this:**\n1. Open **System Settings → Privacy & Security → Automation**\n2. Enable ThinkDrop access for **${appName}**\n3. Try again\n\nOr I can run the command directly without opening a Terminal window (no AppleScript needed).`,
      options: ['Open System Settings → Automation', 'Run without Terminal window', 'Skip this step'],
    };
  }

  // ── Auth wall fast-path ─────────────────────────────────────────────────
  // executeCommand.js sets failedStep.reason = 'auth_wall' when waitForStableText
  // (or a navigate/examine) detects that the page is a login/auth wall.
  //
  // Strategy:
  //   1. Check if a saved session file exists on disk — pass hasSession:true if so
  //      (buildLoginSubPlan will try state-load FIRST before filling credentials)
  //   2. Derive the expected KEYTAR keys for this service (e.g. GMAIL_EMAIL, GMAIL_PASSWORD)
  //   3. Check macOS keychain for each key — build missingCredentialKeys list
  //   4. SPAWN_SUBPLAN with buildLoginSubPlan (passing missingCredentialKeys so it prepends
  //      ask_user + profile.store_secret steps for any missing credentials)
  //
  // If all credentials are present and the session still hit an auth wall, the sub-plan
  // will still run the full form-fill flow using KEYTAR refs (session may have expired).
  if (failedStep.reason === 'auth_wall') {
    const { inferService, deriveCredentialKeys } = require('../utils/buildLoginSubPlan');
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');

    const authService  = failedStep.service  || inferService(failedStep.loginUrl || failedStep.url || '');
    const loginUrl     = failedStep.loginUrl || failedStep.url || '';
    const sessionId    = failedStep.sessionId || state.activeBrowserSessionId || null;

    // Check if a saved session file exists (written by the state-save step after last login).
    // If so, pass hasSession:true so buildLoginSubPlan prepends a state-load attempt.
    let hasSession = false;
    if (sessionId) {
      const sessionFile = path.join(
        os.homedir(), '.thinkdrop', 'browser-sessions',
        `${sessionId.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`
      );
      try {
        const stat = fs.statSync(sessionFile);
        // Only treat as valid if the file is less than 7 days old (sessions expire)
        const ageMs = Date.now() - stat.mtimeMs;
        hasSession = ageMs < 7 * 24 * 60 * 60 * 1000;
        if (hasSession) logger.info(`[Node:RecoverSkill] Found saved session file (${Math.round(ageMs / 60000)}m old): ${sessionFile}`);
      } catch (_) { /* no session file */ }
    }

    // Derive the KEYTAR keys expected for this service
    const { usernameKey, passwordKey } = deriveCredentialKeys(authService, loginUrl, {});

    // Treat both keys as missing — we're here because resolveStepCredentials already
    // returned null for this token (SERVICE_CRED_TOKEN guard fired), so the credential
    // is definitely not available in _gatheredVars or keychain.
    // DO NOT use the `security` CLI to probe keychain — it triggers a macOS keychain
    // access dialog asking for the login keychain password, which is confusing to users.
    const missingCredentialKeys = [usernameKey, passwordKey];

    logger.info(`[Node:RecoverSkill] Fast-path: auth_wall on "${authService}" (session=${sessionId}, saved=${hasSession}) → SPAWN_SUBPLAN; missing keys: [${missingCredentialKeys.join(', ')}]`);

    // Compute the original destination URL from the parent plan (last navigate step before cursor)
    // so the login sub-plan can navigate back after authenticating.
    const parentPlan   = skillPlan || [];
    const parentCursor = cursor ?? 0;
    let destinationUrl = '';
    for (let i = 0; i < parentCursor; i++) {
      const step = parentPlan[i];
      if (step && step.args && step.args.action === 'navigate' && step.args.url) {
        destinationUrl = step.args.url;
      }
    }
    if (destinationUrl) {
      logger.info(`[Node:RecoverSkill] destinationUrl after login: ${destinationUrl}`);
    }

    // Compute resumeCursor: skip past consecutive auth-form steps in the parent plan
    // (fill {{service:*}}, press Enter, click submit/next/sign-in) that will be
    // redundant after a fresh login. This prevents re-entering the auth_wall loop.
    let resumeCursor = parentCursor;
    const authFillPattern  = /^\{\{[a-zA-Z0-9_]+:(username|email|password|user|pass)[^}]*\}\}$/i;
    const authSkillPattern = /^browser\.act$/;
    while (resumeCursor < parentPlan.length) {
      const step       = parentPlan[resumeCursor];
      const stepSkill  = step && step.skill;
      const stepAction = step && step.args && step.args.action;
      const stepValue  = step && step.args && (step.args.value || step.args.text || step.args.key || '');
      const isFillAuth = stepSkill === 'browser.act' && stepAction === 'fill' && authFillPattern.test(stepValue.trim());
      const isPressEnter = stepSkill === 'browser.act' && stepAction === 'press' && String(stepValue).toLowerCase() === 'enter';
      const isClickAuth  = stepSkill === 'browser.act' && stepAction === 'click' &&
        /\b(sign.?in|login|log.?in|submit|next|continue|proceed)\b/i.test(step.args.selector || step.args.label || '');
      if (isFillAuth || isPressEnter || isClickAuth) {
        resumeCursor++;
      } else {
        break;
      }
    }
    if (resumeCursor > parentCursor) {
      logger.info(`[Node:RecoverSkill] resumeCursor: skipping ${resumeCursor - parentCursor} redundant auth steps (cursor ${parentCursor} → ${resumeCursor})`);
    }

    return {
      action:               'SPAWN_SUBPLAN',
      goalLabel:            `login:${authService}`,
      loginUrl,
      service:              authService,
      credentials:          {},
      missingCredentialKeys,
      hasSession,
      sessionId,
      onComplete:           'retry',
      destinationUrl,
      resumeCursor:         resumeCursor > parentCursor ? resumeCursor : null,
    };
  }

  // browser.act failures
  if (skill === 'browser.act') {
    const action = args.action || '';

    // ── Unresolved {{bestUrl}} template in navigate url ────────────────────────
    // web.agent returned a bestUrl but it was never substituted because the LLM
    // used {{bestUrl}} as a literal template placeholder in the plan step args.
    // If we have the real URL in state, AUTO_PATCH it directly — no LLM round-trip needed.
    if (action === 'navigate' && /\{\{best\.?url\}\}/i.test(args.url || '')) {
      if (webAgentBestUrl) {
        logger.info(`[Node:RecoverSkill] Fast-path: browser.act navigate has unresolved {{bestUrl}} — AUTO_PATCH with ${webAgentBestUrl}`);
        return {
          action: 'AUTO_PATCH',
          patchedArgs: { url: webAgentBestUrl },
          note: `Resolved {{bestUrl}} placeholder to ${webAgentBestUrl} from prior web.agent result`,
        };
      }
      // No bestUrl in state — the web.agent step likely failed or was skipped.
      // Replan: run web.agent first, then navigate using {{bestUrl}}.
      logger.info(`[Node:RecoverSkill] Fast-path: browser.act navigate has unresolved {{bestUrl}} but no webAgentBestUrl in state → REPLAN`);
      const sessionId = args.sessionId || 'browser';
      const taskHint = (skillPlan[cursor] || {}).description || 'the required content';
      return {
        action: 'REPLAN',
        suggestion: `The browser.act navigate step used {{bestUrl}} as the URL but no web.agent search_and_navigate step produced a real URL. Add a web.agent step first to find the correct URL, then navigate to it.`,
        constraint: `MUST add a web.agent step before the failing navigate step: { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "${taskHint.replace(/"/g, '').slice(0, 80)}" }, "description": "Find correct URL" }. Then the browser.act navigate step MUST use {{bestUrl}} as its url — it will be auto-resolved at runtime.`,
      };
    }

    // Element not found on click — the selector didn't match any link/button on the page.
    // Fast-path: take a fresh snapshot, then replan with examine + click using the exact snapshot label.
    // This avoids the LLM guessing ASK_USER and instead self-heals with a new snapshot pass.
    if ((action === 'click' || action === 'dblclick') &&
        (combinedError.includes('element not found') || combinedError.includes('could not locate'))) {
      const sessionId = args.sessionId || 'default';
      const originalSelector = args.selector || '';

      // Hard loop-break: after 2 replans we've already tried snapshot + examine twice — ask user
      if (replanCount >= 2) {
        logger.debug(`[Node:RecoverSkill] Fast-path: element not found after ${replanCount} replans → ASK_USER (loop break)`);
        return {
          action: 'ASK_USER',
          question: `I can't find "${originalSelector}" on the page after ${replanCount} attempts. The element label in the snapshot might differ. Can you tell me the exact text as it appears on the page?`,
          options: ['Tell me the exact label text', 'Skip this step', 'Cancel']
        };
      }

      // First or second failure: take snapshot, use examine to identify real label, replan click
      logger.debug(`[Node:RecoverSkill] Fast-path: element not found "${originalSelector}" → REPLAN with snapshot+examine`);
      return {
        action: 'REPLAN',
        suggestion: `The element "${originalSelector}" was not found on the page. The actual label in the accessibility tree may differ in case or wording (e.g. "Lemans" vs "LeMans"). Take a fresh snapshot to get real element labels, run examine to identify the correct element, then click using the EXACT label from the snapshot.`,
        constraint: `CRITICAL: Do NOT use "${originalSelector}" as the selector again — it failed. Steps: (1) browser.act snapshot sessionId="${sessionId}", (2) browser.act examine intent="click ${originalSelector}" sessionId="${sessionId}", (3) browser.act click with the EXACT label text from the snapshot (match case exactly). The sidebar project list uses the exact name as stored — look for case-insensitive variants like "${originalSelector.toLowerCase()}", "${originalSelector.charAt(0).toUpperCase() + originalSelector.slice(1).toLowerCase()}".`
      };
    }

    // smartFill misuse on non-email pages: smartFill is ONLY for email compose (Gmail/Outlook).
    // If the LLM uses it for a search box or maps input, it always fails with "requires at least one of: to, subject, body".
    // Break the loop immediately — replan with smartType.
    if (combinedError.includes('smartfill requires at least one of')) {
      const sessionId = args.sessionId || 'default';
      logger.debug(`[Node:RecoverSkill] Fast-path: smartFill misuse on non-email page → REPLAN with smartType`);
      return {
        action: 'REPLAN',
        suggestion: `smartFill was used on a non-email page — it only works for Gmail/Outlook compose. Replace it with smartType to type into the search or input field.`,
        constraint: `NEVER use smartFill on search boxes, maps inputs, or any non-email page. Use smartType instead: { "skill": "browser.act", "args": { "action": "smartType", "text": "<text to enter>", "sessionId": "${sessionId}" } }. Do NOT use waitForSelector before smartType. Do NOT use smartFill again in this plan.`
      };
    }

    // GitHub API fast-path: browser.act cannot post comments/reviews on github.com because the
    // browser session has no GitHub login cookies. Detect this early and switch to curl + keychain.
    const sessionUrl = (failedStep.url || args.url || '').toLowerCase();
    const isGitHubPage = sessionUrl.includes('github.com') ||
      (activeBrowserUrl || '').toLowerCase().includes('github.com');
    const isInputFailure = combinedError.includes('no visible input elements') ||
      combinedError.includes('no matching field found') ||
      combinedError.includes('smartfill requires') ||
      (combinedError.includes('timeout') && (combinedError.includes('textarea') || combinedError.includes('comment')));

    if (isGitHubPage && isInputFailure) {
      // Extract PR/issue number and owner/repo from the URL in skillResults navigate step
      const navigateStep = skillResults.find(r => r.skill === 'browser.act' && r.action === 'navigate');
      const prUrlMatch = (navigateStep?.url || activeBrowserUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      const owner = prUrlMatch ? prUrlMatch[1] : '<owner>';
      const repo = prUrlMatch ? prUrlMatch[2] : '<repo>';
      const prNumber = prUrlMatch ? prUrlMatch[3] : '<number>';

      logger.debug(`[Node:RecoverSkill] Fast-path: browser.act input failure on GitHub (${owner}/${repo}#${prNumber}) → REPLAN with GitHub REST API`);
      return {
        action: 'REPLAN',
        suggestion: `browser.act cannot interact with GitHub — the isolated browser has no login session. Switch to the GitHub REST API via shell.run curl with the token from macOS keychain. To post a comment on PR #${prNumber}: POST to https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments with body {"body":"<comment text>"}. To review PR files: GET https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
        constraint: `NEVER use browser.act for any GitHub action (comment, review, merge, label, etc.) — the browser has no GitHub session. ALWAYS use shell.run curl with: TOKEN=$(security find-internet-password -s github.com -w 2>/dev/null | head -1). Use the GitHub REST API v3 (Accept: application/vnd.github.v3+json).`
      };
    }

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

      if (isLoginPage) {
        logger.debug(`[Node:RecoverSkill] Fast-path: page text indicates login/auth page (${currentUrl}) → SPAWN_SUBPLAN`);
        const { isLoginSignal } = require('../utils/buildLoginSubPlan');
        return {
          action: 'SPAWN_SUBPLAN',
          goalLabel: `login:${currentUrl || 'unknown'}`,
          loginUrl:   currentUrl,
          service:    null,  // inferService() picks up from URL inside buildLoginSubPlan
          credentials: {},
          hasSession: false,
        };
      }

      // If we've already replanned twice for the same error, stop looping — ask the user.
      // replanCount persists across replans (unlike stepRetryCount which resets each replan).
      if (replanCount >= 2) {
        logger.debug(`[Node:RecoverSkill] Fast-path: no input found after ${replanCount} replans → ASK_USER (loop break)`);
        return {
          action: 'ASK_USER',
          question: `The browser couldn't find a text input on "${currentUrl}" after ${replanCount} attempts. The page may require login or have changed its layout. Please check the browser and log in if needed, then reply "continue" to resume.`,
          options: ['I am logged in — continue', 'Abort the task']
        };
      }
    }

    // Selector not found — distinguish between input fields and buttons
    if (combinedError.includes('timeout') && (combinedError.includes('selector') || args.selector)) {
      const isClickAction = action === 'click';
      const isTypeAction = action === 'type' || action === 'waitForSelector' || action === 'smartType';

      // Hard loop-break: if we've already replanned 3+ times for selector timeouts, stop.
      // This prevents the LLM from endlessly guessing new selectors for non-existent elements.
      if (replanCount >= 3 && isTypeAction) {
        logger.debug(`[Node:RecoverSkill] Fast-path: selector timeout after ${replanCount} replans → ASK_USER (loop break)`);
        return {
          action: 'ASK_USER',
          question: `The browser couldn't find the input element after ${replanCount} attempts. The page at "${failedStep.url || args.sessionId}" may require login or the site layout may have changed.`,
          options: ['I am logged in — continue', 'Try a completely different approach', 'Abort the task']
        };
      }

      // Click timeout: the button/element wasn't visible — suggest keyboard shortcut or better selector
      if (isClickAction) {
        // Hard loop-break: stepRetryCount resets to 0 on every replan so the retry guard below
        // never fires across replans. After 2 replans, stop looping and ask the user.
        if (replanCount >= 2) {
          logger.debug(`[Node:RecoverSkill] Fast-path: browser.act click timeout after ${replanCount} replans → ASK_USER (loop break)`);
          return {
            action: 'ASK_USER',
            question: `I tried ${replanCount} different selectors to click the button but it isn't responding. Some buttons (like audio/listen buttons) require a real user click. Would you like to click it yourself in the browser?`,
            options: ['I clicked it — continue', 'Try a completely different approach', 'Cancel this task']
          };
        }
        if (stepRetryCount === 0) {
          logger.debug(`[Node:RecoverSkill] Fast-path: browser.act click timeout → REPLAN with waitForSelector + better selector`);
          return {
            action: 'REPLAN',
            suggestion: `The click selector "${args.selector}" timed out — the element may not be visible or enabled yet. Add a waitForSelector step before the click to wait for the element to appear, then try a different selector. For Gmail Send, use Meta+Enter keyboard shortcut instead of clicking.`,
            constraint: `Before the click step, add a waitForSelector: { "skill": "browser.act", "args": { "action": "waitForSelector", "selector": "${args.selector || 'button'}", "timeoutMs": 10000, "sessionId": "${args.sessionId || 'default'}" } }. If this is Gmail, use Meta+Enter keyboard shortcut.`
          };
        }
        // Second click failure on same step — ask user
        logger.debug(`[Node:RecoverSkill] Fast-path: browser.act click timeout (retry ${stepRetryCount}) → ASK_USER`);
        return {
          action: 'ASK_USER',
          question: `The browser couldn't click "${args.selector}" — the element was not visible or enabled. Would you like me to try a keyboard shortcut instead?`,
          options: ['Yes, try a keyboard shortcut', 'Cancel']
        };
      }

      // waitForSelector timeout: the element wasn't found in time.
      // Detect email compose context (Gmail/Outlook) vs generic search/form context.
      if (action === 'waitForSelector') {
        const selector = (args.selector || '').toLowerCase();
        const isEmailCompose = selector.includes('compose') || selector.includes('subject') ||
          selector.includes('to=') || selector.includes('[name="to"]') ||
          (args.sessionId || '').toLowerCase().includes('gmail') ||
          (args.sessionId || '').toLowerCase().includes('mail');

        // Hard loop-break: waitForSelector keeps getting re-added by LLM across replans
        if (replanCount >= 2 && !isEmailCompose) {
          logger.debug(`[Node:RecoverSkill] Fast-path: waitForSelector re-failed after ${replanCount} replans → ASK_USER`);
          return {
            action: 'ASK_USER',
            question: `The browser couldn't find the input "${args.selector}" after multiple attempts. The page may require login or have changed its layout. Please check the browser, then reply "continue" to resume.`,
            options: ['I am logged in — continue', 'Abort the task']
          };
        }

        if (stepRetryCount === 0) {
          if (isEmailCompose) {
            logger.debug(`[Node:RecoverSkill] Fast-path: browser.act waitForSelector timeout (email compose) → REPLAN skip wait, keep smartFill`);
            return {
              action: 'REPLAN',
              suggestion: `The waitForSelector for "${args.selector}" timed out — the compose window may already be open with a different DOM structure. Remove the failed waitForSelector step and proceed directly to the smartFill step. Do NOT replace smartFill with smartType or individual type steps.`,
              constraint: `Remove the waitForSelector step that failed. Keep the smartFill step exactly as-is (with to, subject, body, sessionId). smartFill inspects the live DOM itself and does not need a prior waitForSelector. Use the same sessionId as the rest of the plan.`
            };
          } else {
            logger.debug(`[Node:RecoverSkill] Fast-path: browser.act waitForSelector timeout (non-email) → REPLAN skip wait, use smartType`);
            return {
              action: 'REPLAN',
              suggestion: `The waitForSelector for "${args.selector}" timed out — the element may have a different selector on this page. Remove the failed waitForSelector step and use smartType to type directly into the page's active input. Do NOT use smartFill (it is for email compose only).`,
              constraint: `Remove the waitForSelector step. Use smartType with the text to enter, and the same sessionId. Example: { "skill": "browser.act", "args": { "action": "smartType", "text": "<text>", "sessionId": "${args.sessionId || 'default'}" } }. Do NOT use smartFill. Do NOT use waitForSelector again.`
            };
          }
        }
        // Second waitForSelector failure
        if (isEmailCompose) {
          logger.debug(`[Node:RecoverSkill] Fast-path: browser.act waitForSelector timeout (email, retry ${stepRetryCount}) → ASK_USER`);
          return {
            action: 'ASK_USER',
            question: `The compose window doesn't seem to be opening. Is the email compose window visible in the browser?`,
            options: ['Yes, compose is open', 'No, try again', 'Cancel']
          };
        }
        logger.debug(`[Node:RecoverSkill] Fast-path: browser.act waitForSelector timeout (non-email, retry ${stepRetryCount}) → REPLAN smartType`);
        return {
          action: 'REPLAN',
          suggestion: `waitForSelector for "${args.selector}" failed again. Skip all waitForSelector steps and use smartType to type directly.`,
          constraint: `Remove all remaining waitForSelector steps. Use smartType to enter text. Do NOT use smartFill. Use the same sessionId: "${args.sessionId || 'default'}".`
        };
      }

      // Type timeout: input field not found — suggest smartType
      if (isTypeAction) {
        if (stepRetryCount === 0) {
          logger.debug(`[Node:RecoverSkill] Fast-path: browser.act type selector timeout → REPLAN with smartType`);
          return {
            action: 'REPLAN',
            suggestion: `The selector "${args.selector}" was not found for typing — the page likely uses a contenteditable div or a different input type. Replace the failed type step with a smartType step, which auto-discovers the correct input element (works for input, textarea, and contenteditable divs).`,
            constraint: `Replace the failed type step with: { "skill": "browser.act", "args": { "action": "smartType", "text": "<the text to type>", "sessionId": "${args.sessionId || 'default'}" } }. Do NOT use waitForSelector before smartType — it handles waiting internally. Use the same sessionId as the rest of the plan.`
          };
        }
        // Second failure after smartType also failed — ask user
        logger.debug(`[Node:RecoverSkill] Fast-path: browser.act type selector timeout (retry ${stepRetryCount}) → ASK_USER`);
        return {
          action: 'ASK_USER',
          question: `The browser couldn't find any input element on the page to type into. Would you like me to take a screenshot so you can see what's visible?`,
          options: ['Yes, take a screenshot', 'Cancel']
        };
      }
    }

    // guide.step navigated to a new page — replan remaining steps with real page elements.
    // The new activeBrowserPageElements are already in state from the post-nav rescan.
    if (combinedError.includes('replan_after_navigation')) {
      // Extract "user clicked X on prevUrl and navigated to newUrl" from error message
      const clickMatch = combinedError.match(/user clicked "([^"]+)" on ([^\s]+) and navigated to ([^\s]+)/);
      const completedLabel = clickMatch ? clickMatch[1] : null;
      const fromUrl = clickMatch ? clickMatch[2] : null;
      const toUrl = clickMatch ? clickMatch[3] : (activeBrowserUrl || null);
      logger.debug(`[Node:RecoverSkill] Fast-path: replan_after_navigation from ${fromUrl} → ${toUrl} (completed: "${completedLabel}")`);
      return {
        action: 'REPLAN',
        suggestion: `The user just clicked "${completedLabel || 'a link'}" and the browser navigated from ${fromUrl || 'the previous page'} to ${toUrl || 'a new page'}. Plan the NEXT steps from this new page using ONLY the CURRENT PAGE ELEMENTS listed in the prompt.`,
        constraint: `CRITICAL: Do NOT highlight or guide the user to click "${completedLabel}" again — that step is already DONE. The new page may have a sidebar or nav with links from the old page — IGNORE those. Focus only on the main content of the new page (${toUrl || 'current page'}) and use only exact labels from CURRENT PAGE ELEMENTS.`
      };
    }

    // Navigate landed on 404 page — REPLAN with correct URL hint
    if (combinedError.includes('navigate_404')) {
      const badUrl = args.url || '';
      const domain = badUrl ? (() => { try { return new URL(badUrl).hostname; } catch (_) { return ''; } })() : '';
      logger.debug(`[Node:RecoverSkill] Fast-path: navigate_404 ${badUrl} → REPLAN with URL correction`);
      return {
        action: 'REPLAN',
        suggestion: `The URL "${badUrl}" returned a 404 Page Not Found. Choose a correct URL for this task. For travel.state.gov passport tasks use https://travel.state.gov/content/travel/en/passports.html as the starting point — do NOT invent sub-paths. Navigate from the main section page using the site's own links.`,
        constraint: `Do NOT use "${badUrl}" — it is a 404 page. Start from the top-level section page of ${domain || 'the site'} and navigate from there.`
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

    // Browser/target closed — distinguish transient navigation from truly dead browser.
    // "Target page, context or browser has been closed" fires transiently when a guide.step
    // user click navigates the page and the next step hits mid-navigation context.
    // In that case AUTO_PATCH (retry same step after a short wait) — do NOT replan.
    if (combinedError.includes('target closed') || combinedError.includes('target page') || combinedError.includes('browser closed') || combinedError.includes('browser has been closed')) {
      const isTransientNavigation = (action === 'highlight' || action === 'evaluate') && stepRetryCount === 0;
      if (isTransientNavigation) {
        logger.debug(`[Node:RecoverSkill] Fast-path: browser.act ${action} hit mid-navigation context close → AUTO_PATCH retry after wait`);
        return {
          action: 'AUTO_PATCH',
          patchedArgs: { ...args, _waitBeforeMs: 1500 },
          note: `Page navigated — retrying ${action} after 1.5s for page to settle`,
          _isTimeoutRetry: true
        };
      }
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

  // curl network errors (exit 52=empty reply, exit 92=HTTP/2 stream error) — not fixable by retry.
  // Skip AUTO_PATCH and go straight to REPLAN with browser.act instead.
  if (skill === 'shell.run' && (args.cmd === 'curl' || (args.cmd === 'bash' && (args.argv || []).some(a => String(a).includes('curl'))))) {
    const exitCode = failedStep.exitCode;
    const isCurlNetworkError = exitCode === 52 || exitCode === 92 || exitCode === 6 || exitCode === 7 || exitCode === 35;
    if (isCurlNetworkError) {
      const exitMeanings = { 52: 'empty reply from server', 92: 'HTTP/2 stream error', 6: 'could not resolve host', 7: 'failed to connect', 35: 'SSL handshake failed' };
      const url = (args.argv || []).find(a => String(a).startsWith('http')) || args.argv?.slice(-1)[0] || '';
      logger.debug(`[Node:RecoverSkill] Fast-path: curl exit ${exitCode} (${exitMeanings[exitCode]}) → REPLAN with browser.act`);
      return {
        action: 'REPLAN',
        suggestion: `curl failed with exit code ${exitCode} (${exitMeanings[exitCode] || 'network error'}) on "${url}". curl cannot reach this endpoint. Use browser.act navigate + getPageText instead to fetch the content.`,
        constraint: `Do NOT retry curl. Use browser.act: navigate to "${url || 'the target URL'}", then waitForContent, then getPageText.`
      };
    }
  }

  // gh CLI "unknown command" — gh repo star, gh star, etc. don't exist in gh v2+.
  // Detect immediately from stderr and replan to use `gh api` REST calls instead.
  if (skill === 'shell.run' && failedStep.exitCode === 1) {
    const combinedOut = ((failedStep.stdout || '') + ' ' + (failedStep.stderr || '')).toLowerCase();
    const bashScript = args.cmd === 'bash' ? (Array.isArray(args.argv) ? args.argv.join(' ') : '') : '';
    const isGhUnknownCmd = /\bgh\b/.test(bashScript) &&
      (combinedOut.includes('unknown command') || combinedOut.includes('no such command') ||
       combinedOut.includes('unknown subcommand') || combinedOut.includes("could not find command"));
    if (isGhUnknownCmd) {
      // Extract owner/repo if present for a more specific constraint
      const repoMatch = bashScript.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
      const ownerRepo = repoMatch ? repoMatch[1] : 'OWNER/REPO';
      const isStarAction = /\b(star|unstar)\b/i.test(bashScript);
      logger.debug(`[Node:RecoverSkill] Fast-path: gh unknown command → REPLAN with gh api`);
      return {
        action: 'REPLAN',
        suggestion: isStarAction
          ? `The gh CLI does not have a "star" subcommand in v2+. Use the REST API: \`gh api -X PUT /user/starred/${ownerRepo} --silent\` to star, or \`gh api -X DELETE /user/starred/${ownerRepo} --silent\` to unstar. Check if already starred: \`gh api /user/starred/${ownerRepo} --silent 2>/dev/null && echo starred || echo not_starred\`.`
          : `The gh CLI command failed with "unknown command". Use \`gh api\` or the GitHub REST API via curl with \`gh auth token\` to get the token. Never use \`gh repo star\`, \`gh star\`, or other non-existent subcommands.`,
        constraint: `NEVER use gh repo star, gh star, or gh unstar — these subcommands do not exist. Use \`gh api -X PUT /user/starred/${ownerRepo}\` for starring.`,
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

  // mv/cp with wildcards that include the destination directory → REPLAN with safe find command
  if (skill === 'shell.run' && failedStep.exitCode === 1) {
    const bashScript = args.cmd === 'bash' ? (Array.isArray(args.argv) ? args.argv.join(' ') : '') : '';
    const isMvOrCp = /\b(mv|cp)\b/.test(bashScript);
    const hasWildcard = bashScript.includes('/* ') || bashScript.includes('/*\t');
    const hasDirIntoItselfError = combinedError.includes('into itself') || combinedError.includes('cannot move') || combinedError.includes('cannot copy');
    
    if (isMvOrCp && hasWildcard && hasDirIntoItselfError) {
      // Extract source and dest paths from the command
      const match = bashScript.match(/(mv|cp)\s+(.+?)\s+(.+)$/);
      if (match) {
        const srcDir = match[2].replace(/\/\*$/, '').replace(/\*$/, '');
        const destDir = match[3].trim();
        logger.info(`[Node:RecoverSkill] Fast-path: mv/cp wildcard includes destination → REPLAN with find command`);
        return {
          action: 'REPLAN',
          suggestion: `The command tried to move/copy files using a wildcard (*) that includes the destination directory, causing "cannot move a directory into itself". Use find with -type f and -not -path to exclude the destination: bash -c "find ${srcDir} -maxdepth 1 -type f ! -path '*${path.basename(destDir)}*' -exec mv {} ${destDir} +"`,
          constraint: `NEVER use wildcards like "*" that include the destination directory in mv/cp commands. Use find with file type filter and exclusion.`
        };
      }
    }
  }

  // Command not found — only when the actual binary is missing, not when bash runs a failing script
  // bash/sh/zsh are always present on macOS — never ask to install them
  // Guard: args.cmd only exists for shell.run — other skills (skill.install, browser.act, etc.) don't have it
  if (skill === 'shell.run' && args.cmd) {
    const SHELL_INTERPRETERS = ['bash', 'sh', 'zsh', 'python3', 'python', 'node', 'ruby', 'perl'];
    const isShellInterpreter = SHELL_INTERPRETERS.includes(args.cmd);
    if (combinedError.includes('command not found') && !isShellInterpreter) {
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

    // ── Interactive / stdin-blocking CLI commands ─────────────────────────────
    // These commands block indefinitely waiting for stdin — no timeout increase
    // will fix them. We SPAWN_SUBPLAN with onComplete:'skip' so that:
    //   1. The sub-plan handles auth in total isolation (checks status + auths
    //      non-interactively via $TOKEN env var, or no-ops if already logged in).
    //   2. On sub-plan completion, the cursor advances PAST the bad step (skip),
    //      so the interactive command is never re-run.
    //   3. Already-completed steps (install, etc.) stay in skillResults — no
    //      expensive replan from scratch.
    if (skill === 'shell.run') {
      const bashScript = (args.cmd === 'bash' && Array.isArray(args.argv))
        ? (args.argv.find(a => typeof a === 'string' && a !== '-c') || '')
        : '';
      const fullCmd = `${args.cmd || ''} ${(args.argv || []).join(' ')} ${bashScript}`.toLowerCase();

      // Detect interactive CLI auth run WITHOUT a piped token
      const isInteractiveCli = /\b(gh auth login|stripe login|heroku login|fly auth login|vercel login|netlify login|wrangler login|supabase login)\b/.test(fullCmd)
        && !fullCmd.includes('echo') && !fullCmd.includes('printf')
        && !fullCmd.includes(' | ') && !fullCmd.includes("'|'");

      if (isInteractiveCli) {
        const cliMatch = fullCmd.match(/\b(gh|stripe|heroku|fly|vercel|netlify|wrangler|supabase)\b/);
        const cliName = cliMatch ? cliMatch[1] : 'cli';
        const TOKEN_MAP = { gh: 'GITHUB_TOKEN', stripe: 'STRIPE_API_KEY', heroku: 'HEROKU_API_KEY', vercel: 'VERCEL_TOKEN', fly: 'FLY_API_TOKEN' };
        const tokenEnvVar = TOKEN_MAP[cliName] || 'TOKEN';

        // Self-contained auth sub-plan:
        //   Step A — check status (no-op if already logged in)
        //   Step B — non-interactive auth via env token if available, else report
        //            what the parent plan should do (browser.act fallback)
        const authCheckScript = `${cliName} auth status 2>&1 | head -5`;
        const authLoginScript = [
          `if ${cliName} auth status 2>&1 | grep -q "Logged in"; then`,
          `  echo "ALREADY_AUTHENTICATED"`,
          `elif [ -n "$${tokenEnvVar}" ]; then`,
          `  echo "$${tokenEnvVar}" | ${cliName} auth login --with-token && echo "AUTH_SUCCESS"`,
          `else`,
          `  echo "NO_TOKEN_AVAILABLE"`,
          `fi`,
        ].join(' ');

        logger.info(`[Node:RecoverSkill] Fast-path: interactive stdin-blocking auth (${cliName}) → SPAWN_SUBPLAN onComplete:skip`);
        return {
          action: 'SPAWN_SUBPLAN',
          goalLabel: `cli-auth:${cliName}`,
          onComplete: 'skip',   // advance past the bad interactive-auth step on resume
          subPlanSteps: [
            {
              skill: 'shell.run',
              args: { cmd: 'bash', argv: ['-c', authCheckScript], timeoutMs: 10000 },
              description: `Check ${cliName} authentication status`,
            },
            {
              skill: 'shell.run',
              args: { cmd: 'bash', argv: ['-c', authLoginScript], timeoutMs: 30000 },
              description: `Authenticate ${cliName} non-interactively (via $${tokenEnvVar} or skip if already logged in)`,
              optional: true,   // if this fails, continue — main task will surface the real error
            },
          ],
          // Fallback if sub-plan depth cap blocks spawn: REPLAN with constraint
          fallbackAction: 'REPLAN',
          fallbackConstraint: `NEVER run "${cliName} auth login" without piping a token — it reads from stdin and hangs. Check "${cliName} auth status 2>&1" first; if not authenticated and $${tokenEnvVar} is set, use "echo \\"$${tokenEnvVar}\\" | ${cliName} auth login --with-token". If no token: use browser.act to do the task on the website instead.`,
          fallbackSuggestion: `${cliName} auth login hangs on stdin. Sub-plan spawn was blocked — replan with non-interactive auth.`,
        };
      }
    }

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

    // curl with Authorization/token header timed out → likely an empty or invalid token,
    // NOT a real network timeout. Increasing the timeout will just hang longer for nothing.
    // Route to the LLM with evidence so it can detect the empty-token root cause and replan.
    if (skill === 'shell.run') {
      const bashArgStr = args.cmd === 'bash' ? (Array.isArray(args.argv) ? args.argv.join(' ') : '') : '';
      const isCurlWithAuth = (args.cmd === 'curl' || bashArgStr.includes('curl ')) &&
        /Authorization|Bearer|token\s+\$|: token|: Bearer/i.test(bashArgStr || JSON.stringify(args.argv || []));
      const isSecurityKeychain = bashArgStr.includes('security find-generic-password') ||
        bashArgStr.includes('security find-internet-password');
      if (isCurlWithAuth || isSecurityKeychain) {
        logger.debug('[Node:RecoverSkill] Fast-path: curl-with-auth or keychain call timed out → route to LLM (auth issue, not timeout)');
        // Do NOT auto-patch timeout — fall through to LLM recovery below.
        // Add a diagnostic hint to the failedStep so the LLM has the evidence.
        if (!failedStep._authTimeoutHint) {
          failedStep._authTimeoutHint =
            'IMPORTANT: This curl command timed out. The most likely cause is an EMPTY or INVALID auth token. ' +
            'security find-generic-password returns empty string when the key does not exist, ' +
            'and curl with an empty "Authorization: token " header hangs waiting for GitHub to respond. ' +
            'DO NOT increase the timeout. Instead: (1) switch to `gh api` which uses its own managed token, ' +
            'or (2) use `gh auth token` to get the token and validate it is non-empty before calling curl.';
        }
        return null; // fall through to LLM
      }
    }

    // Other commands: silent AUTO_PATCH with backoff (2x then 3x timeout)
    // shell.run service rejects timeoutMs > 300000 — never patch beyond that
    const MAX_TIMEOUT = 300000;
    const retryAttempt = stepRetryCount + 1;
    const currentTimeout = args.timeoutMs || 10000;
    const multipliers = [2, 3]; // retry 1 → 2x, retry 2 → 3x

    if (retryAttempt <= multipliers.length && currentTimeout < MAX_TIMEOUT) {
      const newTimeout = Math.min(currentTimeout * multipliers[retryAttempt - 1], MAX_TIMEOUT);
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

  // ── Runtime JS error fast-path (playwright.agent / browser.act / browser.agent) ──
  // ReferenceError, TypeError, SyntaxError etc. are code bugs in the skill layer,
  // not user-correctable issues. REPLAN_STEP: try a different approach for this
  // step while preserving completed prior work.  No LLM round-trip needed.
  if ((skill === 'playwright.agent' || skill === 'browser.act' || skill === 'browser.agent') &&
      /\b(ReferenceError|TypeError|SyntaxError|RangeError|EvalError|URIError)\b/.test(combinedError)) {
    logger.info(`[Node:RecoverSkill] Fast-path: runtime JS error in ${skill} → REPLAN_STEP`);
    return {
      action: 'REPLAN_STEP',
      suggestion: `${skill} crashed with a JavaScript runtime error: ${combinedError.slice(0, 200)}. This is an internal code bug. Try a different approach for this step.`,
      constraint: `The previous approach using ${skill} hit a code-level crash. Use browser.agent { action: "run" } to handle this task — it manages sessions, auth, and error recovery internally.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Strategy categorization based on failed step and output contract
// ---------------------------------------------------------------------------

/**
 * Determine the strategy category for a failed step based on its output contract.
 * Categories: PATH, TOOL_SUB, AGENT_SUB, EXEC_MODE, TIMEOUT
 */
function _determineStrategyCategory(failedStep, contract, suggestion = '') {
  const { skill, error = '', args = {} } = failedStep;
  const suggestionLower = suggestion.toLowerCase();
  const errorLower = error.toLowerCase();

  // Check contract outputs for specific failure patterns
  const outputs = contract?.outputs || {};

  // TIMEOUT: Explicit timeout errors or long execution time
  if (/timeout|timed out|exceeded.*time|took too long/i.test(errorLower) ||
      suggestionLower.includes('timeout') ||
      suggestionLower.includes('increase timeout')) {
    return 'TIMEOUT';
  }

  // PATH: File not found, path errors, missing resources
  if (/no such file|not found|does not exist|path.*not.*found|cannot find|missing.*file/i.test(errorLower) ||
      outputs.missingPath?.value ||
      (outputs.exitCode?.value === 1 && /file|path|directory/i.test(errorLower))) {
    return 'PATH';
  }

  // TOOL_SUB: Tool execution failures, command not found, tool errors
  if (/command not found|not recognized|tool.*failed|execution.*failed|cannot execute/i.test(errorLower) ||
      suggestionLower.includes('different tool') ||
      suggestionLower.includes('try') && suggestionLower.includes('instead') ||
      /try (python|osascript|bash|zsh)/i.test(suggestion)) {
    return 'TOOL_SUB';
  }

  // AGENT_SUB: Agent failures, connection issues, auth problems
  if (/agent.*failed|connection.*refused|cannot connect|unauthorized|authentication|login|sign in/i.test(errorLower) ||
      skill.includes('agent') && /failed|error|timeout/i.test(errorLower) ||
      suggestionLower.includes('different agent') ||
      suggestionLower.includes('browser.agent') ||
      suggestionLower.includes('cli.agent')) {
    return 'AGENT_SUB';
  }

  // EXEC_MODE: Execution mode changes (bash vs python vs osascript)
  if (/syntax error|interpreter|script.*failed|bash.*error|python.*error/i.test(errorLower) ||
      suggestionLower.includes('bash') ||
      suggestionLower.includes('python') ||
      suggestionLower.includes('osascript') ||
      args.cmd === 'bash' && /script|syntax/i.test(errorLower)) {
    return 'EXEC_MODE';
  }

  // Default to PATH for most file/location related errors
  if (/file|path|directory|location|folder/i.test(errorLower)) {
    return 'PATH';
  }

  // Default to TOOL_SUB for command/tool errors
  if (/command|tool|execute|run/i.test(errorLower)) {
    return 'TOOL_SUB';
  }

  // Fallback: categorize based on skill type
  if (skill === 'shell.run') return 'TOOL_SUB';
  if (skill === 'browser.agent' || skill === 'browser.act') return 'AGENT_SUB';
  if (skill === 'cli.agent') return 'AGENT_SUB';

  return 'PATH'; // Default fallback
}

// ---------------------------------------------------------------------------
// Apply a recovery decision to state
// ---------------------------------------------------------------------------

async function applyRecovery(decision, state, skillPlan, cursor, stepRetryCount, replanCount, logger) {
  const { failedStep } = state;

  switch (decision.action) {
    case 'INSTALL_AND_RETRY': {
      logger.debug(`[Node:RecoverSkill] INSTALL_AND_RETRY: ${decision.note}`);
      // Inject npm install step immediately before the failing cursor step
      const installStep = {
        skill: 'shell.run',
        args: {
          cmd: 'bash',
          argv: ['-c', `cd "${decision.skillDir}" && [ ! -f package.json ] && echo '{"name":"skill","version":"1.0.0"}' > package.json; npm install --save ${decision.missingPkg}`],
          timeoutMs: 90000,
        },
        description: `Install missing dependency '${decision.missingPkg}'`,
      };
      const patchedPlan = [
        ...skillPlan.slice(0, cursor),
        installStep,
        ...skillPlan.slice(cursor),
      ];
      return {
        ...state,
        recoveryAction: 'auto_patch',
        skillPlan: patchedPlan,
        skillCursor: cursor,   // retry from the install step (one before the original failing step)
        failedStep: null,
        stepRetryCount: stepRetryCount + 1,
        recoveryNote: decision.note,
      };
    }

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
      // Accumulate patch history so next recovery sees what was already tried
      const updatedPatchHistory = [
        ...(state.patchHistory || []),
        decision.note ? `AUTO_PATCH: ${decision.note} (patchedArgs: ${JSON.stringify(decision.patchedArgs)})` : `AUTO_PATCH: ${JSON.stringify(decision.patchedArgs)}`
      ].slice(-8); // keep last 8 attempts

      // ── Patch history forwarded on state ──────────────────────────────────
      // updatedPatchHistory is set above and written to state below.
      // ── Self-heal write-back ──────────────────────────────────────────────
      // Persist this patch as a skill_prompt rule so planSkills injects it
      // next time a similar task is planned — closing the learn loop.
      // Only write back meaningful notes (skip generic timeout retries).
      if (state.mcpAdapter && decision.note && !decision._isTimeoutRetry) {
        const failedSkill = failedStep.skill || 'shell.run';
        const originalRequest = state.resolvedMessage || state.message || '';
        const ruleText = `When planning ${failedSkill} steps for tasks like "${originalRequest.slice(0, 80)}": ${decision.note}. Patched args: ${JSON.stringify(decision.patchedArgs).slice(0, 200)}`;
        state.mcpAdapter.callService('user-memory', 'skill_prompt.upsert', {
          tags: [failedSkill, 'auto_patch', 'self_heal'],
          promptText: ruleText
        }, { timeoutMs: 3000 }).then(() => {
          logger.info(`[Node:RecoverSkill] Self-heal: wrote AUTO_PATCH rule to skill_prompt DB`);
        }).catch(err => {
          logger.debug(`[Node:RecoverSkill] Self-heal write-back failed (non-fatal): ${err.message}`);
        });
      }
      // ── End self-heal write-back ──────────────────────────────────────────

      return {
        ...state,
        recoveryAction: 'auto_patch',
        skillPlan: patchedPlan,
        skillCursor: cursor,   // retry same step with patched args
        failedStep: null,
        stepRetryCount: nextRetryCount,
        recoveryNote: decision.note,
        patchHistory: updatedPatchHistory,
      };
    }

    case 'REPLAN_STEP': {
      // Single-step replan: regenerate only the failed step, keep prior successful steps
      const suggestion = decision.suggestion || 'Retry with different approach';
      const constraint = decision.constraint || null;
      const failureReason = failedStep.error || failedStep.reason || 'Step failed';

      logger.debug(`[Node:RecoverSkill] REPLAN_STEP (attempt ${replanCount + 1}): ${suggestion}`);

      // Emit progress event for UI visibility
      if (typeof state.progressCallback === 'function') {
        try {
          state.progressCallback({
            type: 'step_replanning',
            stepIndex: cursor,
            skill: failedStep.skill,
            message: `Replanning step ${cursor + 1} with new approach...`,
            attempt: replanCount + 1,
            suggestion: suggestion.slice(0, 100),
          });
        } catch (_) { /* never block recovery on progress callback errors */ }
      }

      return {
        ...state,
        recoveryAction: 'replan_step',
        replanCount: replanCount + 1,
        // CRITICAL: Keep existing plan intact - don't null it out
        skillPlan: skillPlan,
        skillCursor: cursor,   // Stay at failed step position
        stepRetryCount: stepRetryCount + 1,
        recoveryContext: {
          failedSkill: failedStep.skill,
          failedStep: failedStep.step,
          failureReason,
          suggestion,
          constraint,
          // Signal that this is a single-step replan, not full replan
          replanMode: 'single_step',
          // Pass the failed step's args so planSkills can generate replacement
          failedStepArgs: failedStep.args,
          // Include strategy category if available
          strategyCategory: decision.category || 'GENERAL',
        },
        failedStep: null,
      };
    }

    case 'REPLAN': {
      const suggestion = decision.suggestion || 'Retry the previous step with a more specific element label or different approach.';
      const constraint = decision.constraint || null;
      const failureReason = failedStep.error || failedStep.reason || 'Step did not produce the expected result.';

      // ── Contract-aware strategy categorization ─────────────────────────────
      // Analyze the failed step's output contract to categorize the failure
      const stepContracts = state.stepContracts || [];
      const failedContract = stepContracts.length > cursor ? stepContracts[cursor] : null;
      const strategyCategory = _determineStrategyCategory(failedStep, failedContract, suggestion);

      // Track replan history with categories
      const updatedReplenHistory = [
        ...(state.replanHistory || []),
        {
          attempt: replanCount + 1,
          category: strategyCategory,
          skill: failedStep.skill,
          error: failureReason.slice(0, 200),
          suggestion: suggestion.slice(0, 200),
          timestamp: Date.now()
        }
      ].slice(-10); // Keep last 10 replan attempts

      // Check if all 5 strategy categories have been exhausted
      const usedCategories = new Set(updatedReplenHistory.map(h => h.category));
      const allCategories = ['PATH', 'TOOL_SUB', 'AGENT_SUB', 'EXEC_MODE', 'TIMEOUT'];
      const exhaustedCategories = allCategories.filter(c => usedCategories.has(c));
      const isExhausted = exhaustedCategories.length >= 5 && replanCount >= 4;

      if (isExhausted) {
        logger.info(`[Node:RecoverSkill] All 5 strategy categories exhausted after ${replanCount + 1} replans — escalating to ASK_USER`);
        return {
          ...state,
          recoveryAction: 'ask_user',
          pendingQuestion: {
            question: `I've tried all available recovery strategies (${exhaustedCategories.join(', ')}) but the step keeps failing. The error is: "${failureReason.slice(0, 120)}". What would you like to do?`,
            options: ['Try a completely different approach', 'Skip this step', 'Cancel this task'],
            context: { failedStep, exhaustedCategories, replanHistory: updatedReplenHistory }
          },
          replanHistory: updatedReplenHistory,
          commandExecuted: false
        };
      }

      logger.debug(`[Node:RecoverSkill] REPLAN (attempt ${replanCount + 1}, category: ${strategyCategory}): ${suggestion}`);
      // If the browser was closed, clear the persisted session so main.js doesn't
      // inject the dead sessionId into the next initialState.
      const isBrowserClosed = suggestion.includes('browser session was closed') || constraint?.includes('new sessionId');
      return {
        ...state,
        recoveryAction: 'replan',
        replanCount: replanCount + 1,
        replanHistory: updatedReplenHistory,
        evaluationFromFailure: true,
        recoveryContext: {
          failedSkill: failedStep.skill,
          failedStep: failedStep.step,
          failureReason,
          suggestion,
          alternativeCwd: decision.alternativeCwd || null,
          constraint,
          strategyCategory,  // Pass category to planSkills for smarter replanning
          failedContract    // Pass contract for context-aware replanning
        },
        failedStep: null,
        skillPlan: null,
        skillCursor: 0,
        stepRetryCount: 0,
        ...(isBrowserClosed ? { activeBrowserSessionId: null, activeBrowserUrl: null } : {})
      };
    }

    case 'ASK_USER': {
      logger.debug(`[Node:RecoverSkill] ASK_USER: ${decision.question}`);

      // Offer "Train this path" when the failure is from a browser.agent task
      const _isBrowserFailure = failedStep && (
        failedStep.skill === 'browser.agent' ||
        failedStep.skill === 'playwright.agent' ||
        (failedStep.args?.agentId && failedStep.args.agentId.endsWith('.agent'))
      );
      let options = decision.options || [];
      if (_isBrowserFailure && !options.some(o => {
        const txt = typeof o === 'string' ? o : (o?.label || o?.value || '');
        return /train/i.test(txt) || txt === 'open_agents_training';
      })) {
        options = [...options, { label: 'Train me to navigate this path', value: 'open_agents_training' }];
      }

      const optionsList = options
        .map((o, i) => `${i + 1}. ${typeof o === 'string' ? o : (o?.label || o?.value || String(o))}`)
        .join('\n');
      // Emit immediately so the UI shows the question card in real-time,
      // without waiting for the full graph to exit and main.js finalState handler.
      if (typeof state.progressCallback === 'function') {
        try {
          state.progressCallback({
            type: 'ask_user',
            question: decision.question,
            options,
            offerTraining: _isBrowserFailure,
            agentId: failedStep?.args?.agentId,
          });
        } catch (_) {}
      }
      return {
        ...state,
        recoveryAction: 'ask_user',
        pendingQuestion: {
          question: decision.question,
          options,
          context: failedStep,
          offerTraining: _isBrowserFailure,
          trainingHandoff: _isBrowserFailure,
          agentId: failedStep?.args?.agentId,
        },
        commandExecuted: false,
        stepRetryCount: 0,
        answer: options.length
          ? `${decision.question}\n\n${optionsList}`
          : decision.question
      };
    }

    case 'SPAWN_SUBPLAN': {
      logger.debug(`[Node:RecoverSkill] SPAWN_SUBPLAN: goal="${decision.goalLabel}" service="${decision.service || 'unknown'}"`);
      const { spawnSubPlan }      = require('../utils/subPlanEngine');
      const { buildLoginSubPlan } = require('../utils/buildLoginSubPlan');

      // Two sub-plan types:
      // 1. CLI auth sub-plan: decision.subPlanSteps provided directly (deterministic)
      // 2. Browser login sub-plan: built via buildLoginSubPlan (legacy)
      let subSteps;
      if (Array.isArray(decision.subPlanSteps) && decision.subPlanSteps.length > 0) {
        // CLI / generic sub-plan — steps provided directly
        subSteps = decision.subPlanSteps;
        logger.debug(`[Node:RecoverSkill] SPAWN_SUBPLAN: using ${subSteps.length} provided steps for "${decision.goalLabel}"`);
      } else {
        // Browser login sub-plan — resolve the canonical sign-in URL via web search,
        // then fall back to KNOWN_AUTH_URLS → rawLoginUrl.
        const loginUrlRaw = decision.loginUrl || (failedStep?.args?.url) || '';
        const resolvedLoginUrl = await searchForLoginUrl(
          decision.service || 'unknown',
          loginUrlRaw,
          state.mcpAdapter,
          logger,
        );
        subSteps = buildLoginSubPlan({
          loginUrl:              loginUrlRaw,
          service:               decision.service     || null,
          credentials:           decision.credentials || {},
          hasSession:            !!decision.hasSession,
          sessionId:             decision.sessionId   || state.activeBrowserSessionId || null,
          loginError:            failedStep?.error    || '',
          missingCredentialKeys: Array.isArray(decision.missingCredentialKeys) ? decision.missingCredentialKeys : [],
          resolvedLoginUrl,    // null → falls back to knownUrl → rawLoginUrl inside factory
          destinationUrl:        decision.destinationUrl || '',
        });
      }

      // Try to spawn; honours depth cap and loop guard
      const spawnResult = spawnSubPlan(state, subSteps, decision.goalLabel || `login:${decision.service || 'unknown'}`, {
        onComplete:    decision.onComplete || 'retry',
        resumeCursor:  decision.resumeCursor != null ? decision.resumeCursor : undefined,
      });

      if (spawnResult.planError) {
        // Sub-plan blocked (depth cap or loop guard) — fall back to fallbackAction or ASK_USER
        logger.warn(`[Node:RecoverSkill] SPAWN_SUBPLAN blocked: ${spawnResult.planError}`);
        if (decision.fallbackAction === 'REPLAN' && decision.fallbackConstraint) {
          logger.info(`[Node:RecoverSkill] SPAWN_SUBPLAN fallback: REPLAN with constraint for "${decision.goalLabel}"`);
          return {
            ...state,
            recoveryAction:  'replan',
            recoveryContext: {
              failedSkill:    failedStep.skill,
              failedStep:     failedStep.step,
              failureReason:  failedStep.error || 'unknown',
              suggestion:     decision.fallbackSuggestion || decision.fallbackConstraint,
              constraint:     decision.fallbackConstraint,
            },
            commandExecuted: false,
            stepRetryCount:  0,
            replanCount:     replanCount + 1,
            failedStep:      null,
          };
        }
        return {
          ...state,
          recoveryAction: 'ask_user',
          pendingQuestion: {
            question: `Cannot auto-handle "${decision.goalLabel}": ${spawnResult.planError}. Please complete the step manually and try again.`,
            options:  [],
            context:  failedStep,
          },
          commandExecuted: false,
          stepRetryCount:  0,
          failedStep:      null,
          answer: `Sub-plan blocked: ${spawnResult.planError}`,
        };
      }

      logger.info(`[Node:RecoverSkill] SPAWN_SUBPLAN spawned ${subSteps.length} steps for "${decision.goalLabel || decision.service || 'unknown'}"`);
      return {
        ...state,
        ...spawnResult,          // subPlanStack, skillPlan (sub steps), skillCursor=0, currentGoalLabel
        recoveryAction:  'auto_patch',
        commandExecuted: false,
        stepRetryCount:  0,
        failedStep:      null,
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

// Attach test helper AFTER main export so it is not clobbered.
module.exports._tryFastRecovery = tryFastRecovery;

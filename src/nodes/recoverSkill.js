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
    replanCount = 0,
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
  const fastRecovery = tryFastRecovery(failedStep, skillPlan, skillCursor, stepRetryCount, logger, skillResults, state.activeBrowserUrl, replanCount);
  if (fastRecovery) {
    return applyRecovery(fastRecovery, state, skillPlan, skillCursor, stepRetryCount, replanCount, logger);
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
        args: { action: 'getPageSnapshot', sessionId: failedStep.args.sessionId, maxChars: 1200 }
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
        exitCode === 139 ? 'segfault' : exitCode === 255 ? 'exit status out of range / SSH error' : '';
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

  // ── ui.findAndClick / ui.click / ui.typeText / ui.waitFor ────────────────
  // Inject the last successful step's stdout (often contains what was visible
  // on screen) and the prior ui step results for context.
  if (['ui.findAndClick', 'ui.click', 'ui.typeText', 'ui.waitFor', 'ui.moveMouse', 'ui.screen.verify'].includes(failedStep.skill)) {
    const lines = [];

    // What the prior ui step saw/did
    const priorUiSteps = skillResults
      .filter(r => r.skill?.startsWith('ui.') && r.ok)
      .slice(-3)
      .map(r => `  Step ${r.step} (${r.skill}): ${r.args?.label || r.args?.text || r.args?.condition || JSON.stringify(r.args).substring(0, 80)} → ${r.stdout ? String(r.stdout).trim().substring(0, 120) : 'ok'}`);
    if (priorUiSteps.length) lines.push(`Prior ui.* steps:\n${priorUiSteps.join('\n')}`);

    // Stderr from the failed step (OmniParser/vision errors often appear here)
    const stderr = (failedStep.stderr || '').trim();
    if (stderr) lines.push(`stderr: ${stderr.substring(0, 400)}`);

    // Specific context for findAndClick
    if (failedStep.skill === 'ui.findAndClick' && failedStep.args?.label) {
      lines.push(`Attempted to click label: "${failedStep.args.label}"`);
      lines.push(`Hint: if this label is not visible, the window may be minimized, behind another window, or the label text may differ from what is shown on screen.`);
    }

    if (lines.length) {
      skillContextSection = `\nui skill diagnostic context:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
      logger.debug(`[Node:RecoverSkill] ui.* context injected (${failedStep.skill})`);
    }
  }

  const recoveryQuery = `Original user request: "${resolvedMessage || message}"

Failed step:
  Step number: ${failedStep.step}
  Skill: ${failedStep.skill}
  Args: ${JSON.stringify(failedStep.args, null, 2)}
  Error: ${failedStep.error}
  Exit code: ${failedStep.exitCode ?? 'N/A'}
  Stderr: ${failedStep.stderr || '(none)'}
${skillContextSection}
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

function tryFastRecovery(failedStep, skillPlan, cursor, stepRetryCount, logger, skillResults, activeBrowserUrl, replanCount = 0) {
  const { skill, args, error = '', stderr = '' } = failedStep;
  const combinedError = `${error} ${stderr}`.toLowerCase();

  // ui.screen.verify: failed for any reason (vision LLM said verified=false, or the call itself failed)
  if (skill === 'ui.screen.verify') {
    const reasoning  = failedStep.reasoning  || (failedStep.error ? `Vision check error: ${failedStep.error}` : 'Visual verification could not confirm success.');
    const visionSuggestion = failedStep.suggestion || '';

    // Look back at the preceding ui.findAndClick step to build a specific constraint
    const precedingClick = (skillResults || []).slice().reverse().find(r => r.skill === 'ui.findAndClick');
    let clickContext = '';
    if (precedingClick) {
      clickContext = ` The preceding click was ui.findAndClick with label="${precedingClick.args?.label}" — this click did NOT produce the expected result.`;
    }

    // Detect if the failing click was a DM/messaging sidebar click — suggest keyboard shortcut
    const precedingLabel = (precedingClick?.args?.label || '').toLowerCase();
    const isDmClick = precedingLabel.includes('dm') || precedingLabel.includes('direct message') ||
      precedingLabel.includes('conversation') || precedingLabel.includes('sidebar');

    let constraint;
    let suggestion;
    if (isDmClick) {
      const nameMatch = (precedingClick?.args?.label || '').match(/^(\w+)/);
      const personName = nameMatch ? nameMatch[1] : 'the person';
      constraint = `Visual verification failed after clicking a DM/sidebar row.${clickContext} Vision LLM reported: "${reasoning}". Clicking sidebar rows in messaging apps opens profile cards, NOT DM threads. Use the keyboard shortcut instead: (1) ui.typeText {CMD+K} to open the quick switcher, (2) ui.typeText the person's name, (3) ui.typeText {ENTER} to open the DM. Do NOT use ui.findAndClick on the sidebar for DMs.`;
      suggestion = `Use keyboard shortcut to open DM: ui.typeText {CMD+K}, then type "${personName}", then {ENTER}. Do NOT click the sidebar row.`;
    } else {
      constraint = `Visual verification failed after the click step.${clickContext} Vision LLM reported: "${reasoning}"${visionSuggestion ? ` Suggestion: ${visionSuggestion}` : ''}. Try a DIFFERENT approach — use a more specific label, a different element, or add a settleMs delay. Do NOT repeat the same label that just failed.`;
      suggestion = visionSuggestion || `The click on "${precedingClick?.args?.label || 'the element'}" did not produce the expected result. Try a different label or approach.`;
    }

    logger.debug(`[Node:RecoverSkill] Fast-path: ui.screen.verify failed → REPLAN`, { verified: failedStep.verified, error: failedStep.error, precedingLabel: precedingClick?.args?.label, isDmClick });
    return {
      action: 'REPLAN',
      constraint,
      suggestion,
      note: `ui.screen.verify: ${reasoning}`
    };
  }

  // ui.findAndClick: OmniParser unavailable or low confidence — ask user to do it manually
  // The ResultsWindow confirm button lets the user signal "done" and resume the plan
  if (skill === 'ui.findAndClick' && failedStep.needsManualStep) {
    const instruction = failedStep.instruction || `Please click "${args.label}" on screen, then confirm when done.`;
    const reason = failedStep.reason ? ` (${failedStep.reason})` : '';
    logger.debug(`[Node:RecoverSkill] Fast-path: ui.findAndClick needsManualStep → ASK_USER`);
    return {
      action: 'ASK_USER',
      question: `${instruction}${reason}`,
      options: ['Done, I clicked it', 'Skip this step', 'Cancel']
    };
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

  // browser.act failures
  if (skill === 'browser.act') {
    const action = args.action || '';

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
        logger.debug(`[Node:RecoverSkill] Fast-path: page text indicates login/marketing page (${currentUrl}) → ASK_USER`);
        return {
          action: 'ASK_USER',
          question: `The browser landed on a login or sign-up page instead of the app. Please log in to "${currentUrl}" in the browser, then reply "continue" to resume.`,
          options: ['I am now logged in — continue', 'Abort the task']
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

  // Command not found — only when the actual binary is missing, not when bash runs a failing script
  // bash/sh/zsh are always present on macOS — never ask to install them
  const SHELL_INTERPRETERS = ['bash', 'sh', 'zsh', 'python3', 'python', 'node', 'ruby', 'perl'];
  const isShellInterpreter = SHELL_INTERPRETERS.includes(args.cmd);
  if (combinedError.includes('command not found') && !isShellInterpreter) {
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

  return null;
}

// ---------------------------------------------------------------------------
// Apply a recovery decision to state
// ---------------------------------------------------------------------------

function applyRecovery(decision, state, skillPlan, cursor, stepRetryCount, replanCount, logger) {
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
      const suggestion = decision.suggestion || 'Retry the previous step with a more specific element label or different approach.';
      const constraint = decision.constraint || null;
      const failureReason = failedStep.error || failedStep.reason || 'Step did not produce the expected result.';
      logger.debug(`[Node:RecoverSkill] REPLAN (attempt ${replanCount + 1}): ${suggestion}`);
      // If the browser was closed, clear the persisted session so main.js doesn't
      // inject the dead sessionId into the next initialState.
      const isBrowserClosed = suggestion.includes('browser session was closed') || constraint?.includes('new sessionId');
      return {
        ...state,
        recoveryAction: 'replan',
        replanCount: replanCount + 1,
        evaluationFromFailure: true,
        recoveryContext: {
          failedSkill: failedStep.skill,
          failedStep: failedStep.step,
          failureReason,
          suggestion,
          alternativeCwd: decision.alternativeCwd || null,
          constraint
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

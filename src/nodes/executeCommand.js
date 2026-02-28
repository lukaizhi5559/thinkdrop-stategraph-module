/**
 * Execute Command Node — single-step cycle dispatcher
 *
 * Executes ONE skill step per graph pass, then signals the graph to:
 *   - Loop back here if more steps remain (skillCursor < skillPlan.length)
 *   - Route to recoverSkill if the step failed (failedStep is set)
 *   - Finish if all steps are done (commandExecuted = true)
 *
 * This single-step design enables the adaptive cycle:
 *   planSkills → executeCommand → recoverSkill → (auto_patch → executeCommand)
 *                                              → (replan    → planSkills)
 *                                              → (ask_user  → surface to user)
 *
 * State inputs:
 *   state.skillPlan    — Array<{ skill, args, optional?, description? }>
 *   state.skillCursor  — index of the current step to execute (default 0)
 *   state.skillResults — accumulated results from previous steps
 *   state.mcpAdapter   — MCP adapter for calling command-service
 *   state.intent       — must include type 'command_automate'
 *
 * State outputs (success):
 *   state.skillCursor    — advanced by 1
 *   state.skillResults   — appended with this step's result
 *   state.commandExecuted — true when all steps complete
 *   state.answer          — summary when done
 *
 * State outputs (failure):
 *   state.failedStep     — { step, skill, args, error, exitCode, stderr }
 *   state.skillResults   — appended with failed result
 *   (graph routes to recoverSkill)
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// Read sessionLanguage from voice journal (single source of truth).
// Returns e.g. 'zh', 'es', or 'en'. Never throws.
function _readSessionLanguage() {
  try {
    const journalPath = path.join(os.homedir(), '.thinkdrop', 'voice-state.json');
    const raw = fs.readFileSync(journalPath, 'utf8');
    return JSON.parse(raw)?.voice?.sessionLanguage || 'en';
  } catch (_) { return 'en'; }
}

const _LANG_NAMES = { zh: 'Chinese (Mandarin)', es: 'Spanish', fr: 'French', pt: 'Portuguese', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', de: 'German', it: 'Italian', ru: 'Russian' };

// Persistent scheduler — writes pending-schedule.json + launchd plist
// so macOS can relaunch the app at the target time if it was closed.
let _scheduler = null;
function getScheduler() {
  if (!_scheduler) {
    try {
      _scheduler = require(path.join(__dirname, '../../../src/main/scheduler.js'));
    } catch (_) {
      // Not available in test/non-Electron environments — no-op
      _scheduler = { registerSchedule: () => {}, clearPendingSchedule: () => {} };
    }
  }
  return _scheduler;
}

function loadSmartFillPrompt() {
  const promptPath = path.join(__dirname, '../prompts/smart-fill.md');
  try {
    return fs.readFileSync(promptPath, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

const SMART_FILL_SYSTEM_PROMPT = loadSmartFillPrompt() || 'You are a DOM field mapper. Output only valid JSON mapping role names to CSS selectors. No explanation.';

module.exports = async function executeCommand(state) {
  const {
    mcpAdapter,
    skillPlan,
    skillCursor = 0,
    skillResults = [],
    intent
  } = state;

  const logger = state.logger || console;
  const progressCallback = state.progressCallback || null;

  if (intent?.type !== 'command_automate') {
    return state;
  }

  if (!mcpAdapter) {
    logger.warn('[Node:ExecuteCommand] No MCP adapter available');
    return {
      ...state,
      commandExecuted: false,
      answer: '[MCP not available — skill plan could not be dispatched]'
    };
  }

  if (!Array.isArray(skillPlan) || skillPlan.length === 0) {
    logger.warn('[Node:ExecuteCommand] No skill plan — planSkills must run first');
    return {
      ...state,
      commandExecuted: false,
      answer: '[No skill plan found — ensure planSkills node runs before executeCommand]'
    };
  }

  // All steps done
  if (skillCursor >= skillPlan.length) {
    const completedCount = skillResults.filter(r => r.ok).length;
    logger.debug(`[Node:ExecuteCommand] All ${skillPlan.length} steps complete`);

    // ── Final overlay cleanup ─────────────────────────────────────────────
    // Remove all ThinkDrop highlight overlays and data-td-target attributes
    // from the page so the browser layout is not corrupted after automation.
    const lastGuideSessionId = state.activeBrowserSessionId
      || skillResults.slice().reverse().find(r => r.skill === 'browser.act' && r.args?.sessionId)?.args?.sessionId
      || null;
    if (lastGuideSessionId && mcpAdapter) {
      mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.act',
        args: { action: 'highlight', sessionId: lastGuideSessionId, clear: true }
      }, { timeoutMs: 5000 }).catch(() => {});
    }

    // Collect file paths written during this plan for the UI "Open file" link.
    // Primary source: accumulated state.savedFilePaths set by synthesize steps (explicit saveToFile arg).
    // Fallback: detect shell.run write patterns (cat >, tee, mv destination).
    const savedFilePaths = [...(state.savedFilePaths || [])];

    // Fallback: shell.run bash scripts with write patterns
    // Handles both absolute paths (/Users/...) and home-relative paths (~/...)
    const homeDir = require('os').homedir();
    skillResults.forEach((r) => {
      if (r.skill === 'shell.run' && r.ok && r.args?.cmd === 'bash') {
        // argv is ['-c', 'script...'] — the script is always at index 1, not the first string
        const argv = r.args?.argv || [];
        const script = argv[1] || argv.find(a => typeof a === 'string' && a !== '-c') || '';
        // Match destination path in write patterns — handles both /abs/path and ~/rel/path
        // Covers: echo/printf/cat > file, tee file, cp src dest, mv src dest
        const writeMatch = script.match(/(?:echo\s[^>]*>+|printf\s[^>]*>+|cat\s*>+|tee\s+|cp\s+\S+\s+|mv\s+\S+\s+)\s*['"]?((?:~|\/)[^\s'"]+\.[a-zA-Z0-9]+)['"]?/);
        if (writeMatch && writeMatch[1]) {
          const rawPath = writeMatch[1];
          const absPath = rawPath.startsWith('~/') ? rawPath.replace('~', homeDir) : rawPath;
          if (!savedFilePaths.includes(absPath)) savedFilePaths.push(absPath);
        }
      }
    });

    logger.info(`[Node:ExecuteCommand] all_done: savedFilePaths=${JSON.stringify([...new Set(savedFilePaths)])} (from state: ${JSON.stringify(state.savedFilePaths || [])}, skillResults: ${skillResults.length})`);
    skillResults.forEach((r, i) => {
      if (r.skill === 'shell.run' && r.args?.cmd === 'bash') {
        const script = (r.args?.argv || []).find(a => typeof a === 'string') || '';
        logger.info(`[Node:ExecuteCommand] all_done step[${i}] script: ${script.substring(0, 120)}`);
      }
    });
    if (progressCallback) progressCallback({ type: 'all_done', completedCount, totalCount: skillPlan.length, skillResults, savedFilePaths: [...new Set(savedFilePaths)] });

    // Build a rich commandOutput summary for the answer node to interpret
    const stepSummaries = skillResults.map((r, i) => {
      const label = r.description || r.skill;
      const status = r.ok ? '✓' : '✗';
      const detail = r.result
        ? (typeof r.result === 'object' ? JSON.stringify(r.result) : String(r.result))
        : r.stdout
          ? r.stdout.trim().slice(0, 300)
          : r.error
            ? `Error: ${r.error}`
            : null;
      return `Step ${i + 1} [${status}] ${label}${detail ? `: ${detail}` : ''}`;
    }).join('\n');

    // Build a meaningful answer without needing the LLM answer node
    const failedCount = skillResults.filter(r => !r.ok).length;
    const hasBrowserSteps = skillResults.some(r => r.skill === 'browser.act');
    const lastBrowserResult = hasBrowserSteps
      ? [...skillResults].reverse().find(r => r.skill === 'browser.act' && r.ok)
      : null;

    // Check if any image.analyze step produced a description — surface it directly
    const imageAnalyzeResult = [...skillResults].reverse().find(r => r.skill === 'image.analyze' && r.ok && r.stdout);

    let answer;
    if (failedCount === 0) {
      if (imageAnalyzeResult) {
        answer = imageAnalyzeResult.stdout;
      } else if (hasBrowserSteps && lastBrowserResult?.url) {
        const title = lastBrowserResult.title ? ` — "${lastBrowserResult.title}"` : '';
        answer = `Done! Browser is open at ${lastBrowserResult.url}${title}`;
      } else {
        answer = `All ${completedCount} step${completedCount !== 1 ? 's' : ''} completed successfully.`;
      }
    } else {
      const imageAnalyzeFailure = skillResults.find(r => r.skill === 'image.analyze' && !r.ok);
      answer = imageAnalyzeFailure
        ? `Image analysis failed: ${imageAnalyzeFailure.error || 'unknown error'}`
        : `Completed ${completedCount}/${skillPlan.length} steps (${failedCount} failed).`;
    }

    // Preserve the last active browser sessionId so follow-up tasks reuse the same tab
    const lastBrowserStep = [...skillResults].reverse().find(r => r.skill === 'browser.act' && r.ok);
    const activeBrowserSessionId = lastBrowserStep?.args?.sessionId || state.activeBrowserSessionId || null;

    // Stream the answer to the UI — answer node is bypassed for command_automate,
    // so we push the execution result here via streamCallback for the Results window.
    const streamCallback = state.streamCallback || null;
    if (answer && typeof streamCallback === 'function') {
      logger.info(`[Node:ExecuteCommand] Streaming execution answer (${answer.length} chars)`);
      streamCallback(answer);
    }

    return {
      ...state,
      commandExecuted: true,
      failedStep: null,
      commandOutput: stepSummaries,
      activeBrowserSessionId,
      answer
    };
  }

  const step = skillPlan[skillCursor];
  const { skill, args = {}, optional = false, description } = step;

  // ── Guide cancellation check — runs before EVERY step ────────────────────
  // Checked here so Stop Guide aborts immediately at the start of any step,
  // not just after waitForTrigger resolves. Covers browser.act highlight steps
  // between guide.step entries that previously kept running after cancel.
  const isGuideCancelledEarly = typeof state.isGuideCancelled === 'function' ? state.isGuideCancelled : () => false;
  if (isGuideCancelledEarly()) {
    logger.info(`[Node:ExecuteCommand] Guide cancelled — aborting at step ${skillCursor + 1} (${skill})`);
    const cancelSessionId = state.activeBrowserSessionId
      || skillResults.slice().reverse().find(r => r.skill === 'browser.act' && r.args?.sessionId)?.args?.sessionId
      || null;
    if (cancelSessionId && mcpAdapter) {
      mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.act',
        args: { action: 'highlight', sessionId: cancelSessionId, clear: true }
      }, { timeoutMs: 5000 }).catch(() => {});
    }
    if (progressCallback) progressCallback({ type: 'all_done', totalCount: skillResults.length, skillResults });
    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill, args, description, ok: true, stdout: 'Guide cancelled by user' }],
      skillCursor: skillPlan.length,
      commandExecuted: true,
      failedStep: null,
      activeBrowserSessionId: null,
      activeBrowserUrl: null
    };
  }

  // ── schedule pseudo-skill ────────────────────────────────────────────────
  // Defers the remaining plan steps until a specific clock time or after a
  // delay. Shows a live countdown in the UI via 'schedule_tick' progress events.
  // Args: { time?: string (e.g. "8:00 PM"), delayMs?: number, label?: string }
  if (skill === 'schedule') {
    const { time, delayMs: rawDelayMs, label = 'Waiting...' } = args;

    // Resolve target time → ms from now
    let waitMs = 0;
    if (rawDelayMs && typeof rawDelayMs === 'number' && rawDelayMs > 0) {
      waitMs = rawDelayMs;
    } else if (time && typeof time === 'string') {
      // Parse "8:00 PM", "20:00", "9:30 AM", "21:00" etc.
      const now = new Date();
      const timeStr = time.trim().toUpperCase();
      const match12 = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
      const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      let targetDate = null;
      if (match12) {
        let hours = parseInt(match12[1], 10);
        const mins = parseInt(match12[2] || '0', 10);
        const meridiem = match12[3];
        if (meridiem === 'PM' && hours < 12) hours += 12;
        if (meridiem === 'AM' && hours === 12) hours = 0;
        targetDate = new Date(now);
        targetDate.setHours(hours, mins, 0, 0);
      } else if (match24) {
        const hours = parseInt(match24[1], 10);
        const mins = parseInt(match24[2], 10);
        targetDate = new Date(now);
        targetDate.setHours(hours, mins, 0, 0);
      }
      if (targetDate) {
        // If target time already passed today, schedule for tomorrow
        if (targetDate <= now) targetDate.setDate(targetDate.getDate() + 1);
        waitMs = targetDate.getTime() - now.getTime();
      }
    }

    if (waitMs <= 0) {
      // Already past target time or no valid time given — skip immediately
      logger.info(`[Node:ExecuteCommand] schedule: no valid future time — skipping`);
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'schedule', description: description || 'Schedule: skipped (time already passed)', stdout: 'Skipped' });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'schedule', args, description, ok: true, stdout: 'Skipped — time already passed' }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    }

    const targetIso = new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    logger.info(`[Node:ExecuteCommand] schedule: waiting ${Math.round(waitMs / 1000)}s until ${targetIso} — "${label}"`);

    // Register a persistent launchd task so macOS launches ThinkDrop at the
    // target time even if the user closes the app before the countdown ends.
    const scheduleId = `sched_${Date.now()}`;
    const remainingSteps = skillPlan.slice(skillCursor + 1); // steps after this schedule step
    try {
      getScheduler().registerSchedule({
        id: scheduleId,
        targetMs: Date.now() + waitMs,
        label,
        prompt: state.message || '',
        skillPlan: remainingSteps,
      });
    } catch (schedErr) {
      logger.warn(`[Node:ExecuteCommand] schedule: launchd registration failed (non-fatal): ${schedErr.message}`);
    }

    if (progressCallback) progressCallback({
      type: 'schedule_start',
      stepIndex: skillCursor,
      totalSteps: skillPlan.length,
      skill: 'schedule',
      description: description || label,
      waitMs,
      targetTime: targetIso,
      label
    });

    // Live countdown — tick every second
    await new Promise((resolve) => {
      let remaining = waitMs;
      const TICK = 1000;
      const interval = setInterval(() => {
        remaining -= TICK;
        if (remaining <= 0) {
          clearInterval(interval);
          resolve(undefined);
          return;
        }
        const secsLeft = Math.ceil(remaining / 1000);
        const minsLeft = Math.floor(secsLeft / 60);
        const secs = secsLeft % 60;
        const countdownLabel = minsLeft > 0
          ? `${minsLeft}m ${secs}s until ${targetIso}`
          : `${secs}s until ${targetIso}`;
        if (progressCallback) progressCallback({
          type: 'schedule_tick',
          stepIndex: skillCursor,
          totalSteps: skillPlan.length,
          skill: 'schedule',
          description: `${label} — ${countdownLabel}`,
          remainingMs: remaining,
          targetTime: targetIso,
          label
        });
      }, TICK);
      // Also schedule the final resolve at exactly waitMs
      setTimeout(() => { clearInterval(interval); resolve(undefined); }, waitMs);
    });

    logger.info(`[Node:ExecuteCommand] schedule: wait complete — continuing plan`);
    // App stayed open — clear the launchd plist so macOS doesn't relaunch later
    try { getScheduler().clearPendingSchedule(scheduleId); } catch (_) {}
    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'schedule', description: description || `Scheduled wait complete — running now`, stdout: `Waited until ${targetIso}` });

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'schedule', args, description, ok: true, stdout: `Waited until ${targetIso}` }],
      skillCursor: skillCursor + 1,
      commandExecuted: false
    };
  }

  // ── needs_install pseudo-skill ───────────────────────────────────────────
  // Checks if a CLI tool is installed. If missing, pauses the plan and emits
  // a 'needs_install' progress event so the UI can show a confirmation card.
  // Waits for the user to confirm (install) or skip before continuing.
  if (skill === 'needs_install') {
    const { tool, installCmd, reason, source = 'brew', description: toolDescription } = args;

    if (!tool || !installCmd) {
      logger.warn('[Node:ExecuteCommand] needs_install: missing tool or installCmd — skipping');
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_install', args, description, ok: true, stdout: 'Skipped (missing args)' }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    }

    // Check if already installed
    const { execSync } = require('child_process');
    let alreadyInstalled = false;
    try {
      execSync(`which ${tool}`, { stdio: 'ignore' });
      alreadyInstalled = true;
    } catch (_) {
      alreadyInstalled = false;
    }

    if (alreadyInstalled) {
      logger.debug(`[Node:ExecuteCommand] needs_install: ${tool} already installed — skipping prompt`);
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'needs_install', description: description || `${tool} already installed`, stdout: `${tool} is already installed` });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_install', args, description, ok: true, stdout: `${tool} is already installed` }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    }

    // Tool is missing — emit needs_install event and wait for user confirmation
    logger.info(`[Node:ExecuteCommand] needs_install: ${tool} not found — requesting user confirmation`);
    if (progressCallback) progressCallback({
      type: 'needs_install',
      stepIndex: skillCursor,
      totalSteps: skillPlan.length,
      tool,
      installCmd,
      reason,
      source,
      toolDescription: toolDescription || null,
      description: description || `Install ${tool}?`
    });

    // Wait for confirmation via confirmInstallCallback (injected by main.js into state)
    const confirmInstallCallback = state.confirmInstallCallback || null;
    let confirmed = false;
    if (typeof confirmInstallCallback === 'function') {
      try {
        confirmed = await confirmInstallCallback(tool);
      } catch (err) {
        logger.warn(`[Node:ExecuteCommand] needs_install: confirmation timed out or errored — skipping: ${err.message}`);
        confirmed = false;
      }
    } else {
      logger.warn('[Node:ExecuteCommand] needs_install: no confirmInstallCallback in state — auto-skipping');
      confirmed = false;
    }

    if (!confirmed) {
      logger.info(`[Node:ExecuteCommand] needs_install: user skipped install of ${tool}`);
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'needs_install', description: description || `Skipped install of ${tool}`, stdout: `Skipped — ${tool} not installed` });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_install', args, description, ok: true, stdout: `Skipped — ${tool} not installed`, skipped: true }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    }

    // User confirmed — run the install command with live stdout streaming
    logger.info(`[Node:ExecuteCommand] needs_install: installing ${tool} via: ${installCmd}`);
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'needs_install', description: `Installing ${tool}...` });

    try {
      const { spawn } = require('child_process');
      const installOk = await new Promise((resolve) => {
        const child = spawn('bash', ['-c', installCmd], {
          env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_EMOJI: '1' },
          timeout: 300000,
        });
        const allLines = [];
        const emit = (line) => {
          if (!line.trim()) return;
          allLines.push(line);
          if (progressCallback) progressCallback({ type: 'install_output', tool, line: line.trimEnd() });
        };
        let stdoutBuf = '', stderrBuf = '';
        child.stdout.on('data', (chunk) => {
          stdoutBuf += chunk.toString();
          const parts = stdoutBuf.split('\n');
          stdoutBuf = parts.pop();
          parts.forEach(emit);
        });
        child.stderr.on('data', (chunk) => {
          stderrBuf += chunk.toString();
          const parts = stderrBuf.split('\n');
          stderrBuf = parts.pop();
          parts.forEach(emit);
        });
        child.on('close', (code) => {
          if (stdoutBuf.trim()) emit(stdoutBuf);
          if (stderrBuf.trim()) emit(stderrBuf);
          resolve(code === 0);
        });
        child.on('error', (err) => {
          emit(`Error: ${err.message}`);
          resolve(false);
        });
      });
      const installStdout = installOk ? `${tool} installed successfully` : `Install failed`;

      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'needs_install', description: `Installed ${tool}`, stdout: installStdout });
      logger.info(`[Node:ExecuteCommand] needs_install: install ${installOk ? 'succeeded' : 'failed'} for ${tool}`);

      // If install succeeded and no more steps follow, stream a "skill ready" confirmation
      // so the user knows the tool is available and how to use it.
      const isLastStep = skillCursor + 1 >= skillPlan.length;
      if (installOk && isLastStep) {
        const toolDescription = args.description || '';
        const confirmation = `✅ **${tool} is now installed!**${toolDescription ? '\n\n' + toolDescription : ''}\n\nYou can now use it — just ask me naturally (e.g. "use ${tool} to...")`;
        if (typeof state.streamCallback === 'function') {
          state.streamCallback(confirmation);
        } else if (progressCallback) {
          progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'needs_install', description: confirmation, stdout: confirmation });
        }
      }

      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_install', args, description, ok: installOk, stdout: installStdout }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    } catch (err) {
      logger.error(`[Node:ExecuteCommand] needs_install: install threw: ${err.message}`);
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill: 'needs_install', description: `Install of ${tool} failed`, error: err.message });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_install', args, description, ok: false, error: err.message }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    }
  }

  // ── needs_skill pseudo-skill ─────────────────────────────────────────────
  // Emitted by the planner when ThinkDrop cannot fulfill a request natively
  // and no installed external skill matches. Tells the user what capability
  // is missing and where to find the scaffolded starter skill contract.
  if (skill === 'needs_skill') {
    const { capability, suggestion } = args;

    const message = [
      `I don't have a native skill for: **${capability || 'this request'}**.`,
      suggestion ? `\n\n${suggestion}` : '',
      '\n\nOnce you\'ve edited the starter files, say: **"install skill at ~/.thinkdrop/skills/<name>/skill.md"** to activate it.'
    ].join('');

    logger.info(`[Node:ExecuteCommand] needs_skill: capability gap — ${capability}`);
    if (progressCallback) progressCallback({
      type: 'step_done',
      stepIndex: skillCursor,
      totalSteps: skillPlan.length,
      skill: 'needs_skill',
      description: description || `Capability gap: ${capability}`,
      stdout: message
    });

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_skill', args, description, ok: true, stdout: message }],
      skillCursor: skillCursor + 1,
      commandExecuted: false
    };
  }

  // ── api_suggest pseudo-skill ─────────────────────────────────────────────
  // Pauses the plan and surfaces an API-first offer to the user.
  // The LLM uses this when a task is better served by an app's API (e.g. Slack,
  // Gmail, Notion) than by UI automation. Emits ask_user with two choices:
  //   1. "Set up [App] API" — user wants the API/webhook approach
  //   2. "Show me how (guided)" — user wants a step-by-step guided walkthrough
  //   3. "Try shortcuts anyway" — user wants to attempt keyboard automation
  //
  // Args:
  //   app         {string}  App name (e.g. "Slack", "Gmail")
  //   reason      {string}  Why API is recommended
  //   apiDocsUrl  {string}  Link to API docs / token setup page
  //   apiSetupPrompt {string} Follow-up prompt to send if user picks "Set up API"
  //   guidePrompt {string}  Follow-up prompt to send if user picks "Show me how"
  if (skill === 'api_suggest') {
    const { app: suggestApp, reason: suggestReason, apiDocsUrl, apiSetupPrompt, guidePrompt } = args;

    const question = `💡 The best way to automate this with **${suggestApp || 'this app'}** is via its API — it's faster, more reliable, and works even when the app is closed.\n\n${suggestReason || ''}\n\nHow would you like to proceed?`;
    const options = [
      apiSetupPrompt || `Set up ${suggestApp || 'app'} API`,
      guidePrompt   || `Show me how to do it manually (guided)`,
      `Try keyboard shortcuts anyway`
    ];

    logger.info(`[Node:ExecuteCommand] api_suggest: surfacing API offer for ${suggestApp}`);
    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'api_suggest', description: description || `API recommendation for ${suggestApp}`, stdout: question });

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'api_suggest', args, description, ok: true, stdout: question }],
      skillCursor: skillCursor + 1,
      commandExecuted: false,
      pendingQuestion: { question, options },
      failedStep: null
    };
  }

  // ── guide.step pseudo-skill ──────────────────────────────────────────────
  // Pauses the plan and shows the user a guided instruction card.
  // Supports two resume modes:
  //
  // MODE 1 — Page-event mode (preferred, when sessionId is provided):
  //   The highlight action injects a click listener on the target element that
  //   sets window.__tdGuideTriggered = true on the page. guide.step polls this
  //   flag via mcpAdapter (browser.act evaluate). When the user clicks the
  //   highlighted element in the browser, the plan auto-advances — no button needed.
  //
  // MODE 2 — IPC fallback (when no sessionId):
  //   Shows "✓ Done — Continue" button in ResultsWindow. User clicks it,
  //   guide:continue IPC fires, confirmGuideCallback Promise resolves.
  //
  // Args:
  //   instruction {string}  What the user needs to do (shown in card + browser bubble)
  //   sessionId   {string}  Playwright session to poll for page-event trigger
  //   url         {string}  Optional URL context shown in card
  //   timeoutMs   {number}  Max wait time (default: 5 minutes)
  if (skill === 'guide.step') {
    const { instruction, sessionId: guideSessionId_llm, url: guideUrl, timeoutMs: guideTimeout = 300000 } = args;
    // Prefer the sessionId from the most recent browser.act step — the LLM may generate
    // a different name (e.g. "webBrowsingSession") than what navigate actually used
    // (derived from hostname, e.g. "www.google.com"). Mismatched sessionId → about:blank tab.
    const lastBrowserResult = skillResults.slice().reverse().find(r => r.skill === 'browser.act' && r.args?.sessionId);
    const guideSessionId = lastBrowserResult?.args?.sessionId || guideSessionId_llm;

    if (!instruction) {
      logger.warn('[Node:ExecuteCommand] guide.step: missing instruction — skipping');
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'guide.step', description: description || 'Guide step', stdout: 'Skipped (no instruction)' });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'Skipped (no instruction)' }],
        skillCursor: skillCursor + 1,
        commandExecuted: false
      };
    }

    logger.info(`[Node:ExecuteCommand] guide.step: showing instruction — mode=${guideSessionId ? 'page-event' : 'ipc-fallback'}`);
    if (progressCallback) progressCallback({
      type: 'guide_step',
      stepIndex: skillCursor,
      totalSteps: skillPlan.length,
      instruction,
      sessionId: guideSessionId || null,
      url: guideUrl || null,
      description: description || 'Follow the steps below',
      mode: guideSessionId ? 'page_event' : 'ipc'
    });

    let continued = false;

    if (guideSessionId && mcpAdapter) {
      // ── MODE 1: waitForTrigger — CDP exposeBinding, CSP-safe, event-driven ──
      // The highlight overlay attaches blur/change/click listener per element type.
      // When the user interacts, listener calls window.__tdTrigger() — a CDP binding
      // registered once per session in getSession(). No eval, no polling, no CSP issues.
      logger.info(`[Node:ExecuteCommand] guide.step: waiting for page trigger on session=${guideSessionId}`);
      let triggered = false;

      try {
        await mcpAdapter.callService('command', 'command.automate', {
          skill: 'browser.act',
          args: { action: 'waitForTrigger', sessionId: guideSessionId, timeoutMs: guideTimeout }
        }, { timeoutMs: guideTimeout + 5000 });
        triggered = true;
      } catch (err) {
        triggered = true;
        logger.info(`[Node:ExecuteCommand] guide.step: waitForTrigger ended (${err.message?.slice(0, 60)}) — auto-continuing`);
      }

      continued = true;
      logger.info(`[Node:ExecuteCommand] guide.step: page trigger fired — continuing`);

      // Check if user clicked "Stop Guide" — if so, abort cleanly instead of continuing.
      const isGuideCancelled = typeof state.isGuideCancelled === 'function' ? state.isGuideCancelled : () => false;
      if (isGuideCancelled()) {
        logger.info(`[Node:ExecuteCommand] guide.step: guide cancelled by user — aborting`);
        if (progressCallback) progressCallback({ type: 'all_done', totalCount: skillResults.length, skillResults });
        return {
          ...state,
          skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'Guide cancelled by user' }],
          skillCursor: skillPlan.length,
          commandExecuted: true,
          failedStep: null,
          activeBrowserSessionId: null,
          activeBrowserUrl: null
        };
      }

      // Wait for navigation to settle — user click likely triggered a page change.
      // Use waitForNavigation (load state) which handles the new page properly.
      try {
        await mcpAdapter.callService('command', 'command.automate', {
          skill: 'browser.act',
          args: { action: 'waitForNavigation', sessionId: guideSessionId, waitUntil: 'domcontentloaded', timeoutMs: 8000 }
        }, { timeoutMs: 12000 });
      } catch (_) {
        // No navigation happened or already settled — brief pause for JS to render
        await new Promise(r => setTimeout(r, 800));
      }

      // ── Post-navigation rescan ──────────────────────────────────────────────
      // Scan the new page and patch the NEXT highlight step with real labels.
      // This prevents the LLM's pre-planned labels from being wrong after navigation.
      const nextHighlightIdx = skillPlan.findIndex(
        (s, i) => i > skillCursor && s.skill === 'browser.act' && s.args?.action === 'highlight'
      );
      if (nextHighlightIdx !== -1) {
        try {
          const rescanResult = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'browser.act',
            args: { action: 'scanCurrentPage', sessionId: guideSessionId }
          }, { timeoutMs: 8000 });
          const rescan = rescanResult?.data || rescanResult;

          if (rescan?.ok && rescan?.result?.elements?.length > 0) {
            const newPageUrl = rescan.result.url;
            const els = rescan.result.elements;
            logger.info(`[Node:ExecuteCommand] Post-nav rescan: ${els.length} elements on ${newPageUrl}`);

            // Track what the user just clicked so planSkills can filter it out
            // of future element lists — prevents the LLM from re-planning it.
            const clickedLabel = args.label || description || null;
            const prevUrl = state.activeBrowserUrl || '';
            const existingCompleted = state.completedGuideSteps || [];
            const completedGuideSteps = clickedLabel
              ? [...existingCompleted, { label: clickedLabel, url: prevUrl }]
              : existingCompleted;

            // Detect whether this is a real page change or just a hash/anchor scroll.
            // Hash-only changes (e.g. /renew.html → /renew.html#Step%20One) stay on the
            // same page — same content, same elements — no replan needed.
            const isSamePagePath = (() => {
              try {
                const prev = new URL(prevUrl);
                const next = new URL(newPageUrl);
                return prev.hostname === next.hostname && prev.pathname === next.pathname;
              } catch (_) { return false; }
            })();

            if (isSamePagePath) {
              // Same page (hash scroll or no navigation) — just continue the existing plan.
              logger.info(`[Node:ExecuteCommand] Post-nav rescan: same page path (hash change only) — continuing plan`);
              return {
                ...state,
                skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'User action detected — continuing' }],
                skillCursor: skillCursor + 1,
                activeBrowserUrl: newPageUrl,
                activeBrowserPageElements: { url: newPageUrl, elements: els },
                completedGuideSteps,
                commandExecuted: false
              };
            }

            // Real page change — force a replan with real elements from the new page.
            const updatedResults = [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'User action detected — continuing' }];
            const replanSignal = {
              step: skillCursor + 1,
              skill: 'guide.step',
              args,
              ok: false,
              error: `replan_after_navigation: user clicked "${clickedLabel || 'a link'}" on ${prevUrl || 'previous page'} and navigated to ${newPageUrl} — replan remaining steps with real page elements from the new page`
            };
            logger.info(`[Node:ExecuteCommand] Post-nav rescan: forcing replan with ${els.length} real elements from ${newPageUrl}`);
            return {
              ...state,
              skillResults: updatedResults,
              skillCursor: skillCursor + 1,
              failedStep: replanSignal,
              activeBrowserSessionId: guideSessionId,
              activeBrowserUrl: newPageUrl,
              activeBrowserPageElements: { url: newPageUrl, elements: els },
              completedGuideSteps,
              commandExecuted: false
            };
          }
        } catch (rescanErr) {
          logger.debug(`[Node:ExecuteCommand] Post-nav rescan failed (non-fatal): ${rescanErr.message}`);
        }
      }

    } else {
      // ── MODE 2: IPC fallback — wait for guide:continue from ResultsWindow ──
      const confirmGuideCallback = state.confirmGuideCallback || null;
      if (typeof confirmGuideCallback === 'function') {
        try {
          continued = await confirmGuideCallback();
        } catch (err) {
          logger.warn(`[Node:ExecuteCommand] guide.step: IPC timed out — auto-continuing: ${err.message}`);
          continued = true;
        }
      } else {
        logger.warn('[Node:ExecuteCommand] guide.step: no confirmGuideCallback — auto-continuing');
        continued = true;
      }
    }

    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'guide.step', description: description || 'Guide step', stdout: 'User action detected — continuing' });

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'User action detected — continuing' }],
      skillCursor: skillCursor + 1,
      commandExecuted: false
    };
  }

  // ── smartFill pseudo-skill ───────────────────────────────────────────────
  // Universal form-filling: snapshot the live DOM, ask the LLM to identify
  // which visible input maps to each role (to/subject/body or any field map),
  // then type into the exact selectors the LLM resolved.
  // Works for any web form — email compose, social media, banking, sign-up forms.
  //
  // Args:
  //   sessionId:  string  — browser session to inspect
  //   fields:     object  — { roleName: "value to type", ... }
  //               e.g. { to: "user@example.com", subject: "Hello", body: "..." }
  //   sendSelector: string (optional) — click this after filling (e.g. Send button)
  if (skill === 'smartFill') {
    const sessionId = args.sessionId || 'default';
    const fieldMap  = args.fields || {
      ...(args.to      ? { to:      args.to      } : {}),
      ...(args.subject ? { subject: args.subject } : {}),
      ...(args.body    ? { body:    args.body    } : {}),
    };
    const sendSelector = args.sendSelector || null;

    logger.debug(`[Node:ExecuteCommand] smartFill step — sessionId=${sessionId} fields=${Object.keys(fieldMap).join(',')}`);
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'smartFill', description: description || 'Inspecting form and filling fields...' });

    // ── Step 1: Snapshot the live DOM ────────────────────────────────────────
    let pageSnapshot = '';
    try {
      const snapResult = await mcpAdapter.call('command.command.automate', {
        skill: 'browser.act',
        args: { action: 'getPageSnapshot', sessionId, maxChars: 1500 }
      });
      if (snapResult?.ok && snapResult?.result) {
        pageSnapshot = String(snapResult.result);
        logger.debug(`[Node:ExecuteCommand] smartFill: snapshot captured (${pageSnapshot.length} chars)`);
      }
    } catch (snapErr) {
      logger.warn(`[Node:ExecuteCommand] smartFill: snapshot failed — ${snapErr.message}`);
    }

    if (!pageSnapshot) {
      const errResult = { step: skillCursor + 1, skill: 'smartFill', args, description, ok: false, error: 'Could not capture page snapshot — browser session may not be open' };
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill: 'smartFill', description: description || 'smartFill', error: errResult.error });
      return { ...state, skillResults: [...skillResults, errResult], skillCursor, failedStep: errResult, commandExecuted: false };
    }

    // ── Step 2: LLM maps field roles → exact CSS selectors ───────────────────
    const llmBackend = state.llmBackend;
    const context    = state.context;
    let resolvedSelectors = {}; // { roleName: selector }

    const fieldRoles = Object.keys(fieldMap).map(role => `  "${role}": "${fieldMap[role].substring(0, 60)}"`).join('\n');
    const fieldMapQuery = `Page snapshot:\n${pageSnapshot}\n\nFields to fill:\n${fieldRoles}`;

    if (llmBackend) {
      try {
        const raw = await llmBackend.generateAnswer(fieldMapQuery, {
          query: fieldMapQuery,
          context: { systemInstructions: SMART_FILL_SYSTEM_PROMPT, sessionId: context?.sessionId, userId: context?.userId, intent: 'command_automate' },
          options: { maxTokens: 300, temperature: 0.0, fastMode: true }
        }, { maxTokens: 300, temperature: 0.0, fastMode: true }, null);

        logger.debug(`[Node:ExecuteCommand] smartFill: LLM selector map raw: ${raw.substring(0, 300)}`);

        // Parse JSON — strip markdown fences if present
        const jsonStr = raw.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace  = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          resolvedSelectors = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
          logger.debug(`[Node:ExecuteCommand] smartFill: resolved selectors: ${JSON.stringify(resolvedSelectors)}`);
        }
      } catch (llmErr) {
        logger.warn(`[Node:ExecuteCommand] smartFill: LLM field mapping failed — ${llmErr.message}. Falling back to heuristics.`);
      }
    }

    // ── Step 3: Heuristic fallback if LLM failed or returned nulls ───────────
    // Parse the snapshot to extract field descriptors and score them per role
    const snapshotLines = pageSnapshot.split('\n');
    const inputLines = snapshotLines.filter(l => l.trim().startsWith('<input') || l.trim().startsWith('<textarea') || l.trim().startsWith('<div') || l.trim().startsWith('<span'));

    const heuristicSelector = (role) => {
      // Broad keyword map covering email, social, forms, banking, sign-up, etc.
      const keywords = {
        // ── Email compose ──────────────────────────────────────────────────
        to:           ['to recipients', 'recipient', 'addressee', '"to"', 'send to', 'email to'],
        subject:      ['subject', 'subjectbox', 'email subject', 're:'],
        body:         ['message body', 'compose', 'message body', 'email body', 'write here'],
        // ── Social media ───────────────────────────────────────────────────
        post:         ['what\'s on your mind', 'start a post', 'compose tweet', 'what\'s happening', 'create post', 'write a post', 'share something'],
        caption:      ['caption', 'add a caption', 'write a caption'],
        comment:      ['add a comment', 'write a comment', 'leave a comment', 'reply'],
        // ── Generic forms ──────────────────────────────────────────────────
        name:         ['full name', 'your name', 'first name', 'last name', 'display name'],
        firstname:    ['first name', 'given name', 'forename'],
        lastname:     ['last name', 'surname', 'family name'],
        email:        ['email address', 'your email', 'enter email', 'email'],
        phone:        ['phone number', 'mobile', 'telephone', 'cell'],
        password:     ['password', 'create password', 'new password'],
        username:     ['username', 'user name', 'handle', 'screen name'],
        address:      ['street address', 'address line', 'mailing address'],
        city:         ['city', 'town'],
        zip:          ['zip', 'postal code', 'postcode'],
        message:      ['message', 'your message', 'write your message', 'description', 'details'],
        search:       ['search', 'find', 'look up', 'query'],
        // ── Banking / checkout ─────────────────────────────────────────────
        cardnumber:   ['card number', 'credit card', 'debit card', 'card no'],
        expiry:       ['expiry', 'expiration', 'exp date', 'mm/yy', 'mm/yyyy'],
        cvv:          ['cvv', 'cvc', 'security code', 'card code'],
        amount:       ['amount', 'transfer amount', 'payment amount', 'how much'],
      };
      const kws = keywords[role.toLowerCase()] || [role.toLowerCase()];

      // Pass 1: keyword match against aria-label, name, placeholder in snapshot lines
      for (const line of inputLines) {
        const lower = line.toLowerCase();
        // Skip search boxes for non-search roles
        if (role !== 'search' && (lower.includes('name="q"') || lower.includes('aria-label="search') || lower.includes('placeholder="search'))) continue;
        for (const kw of kws) {
          if (lower.includes(kw)) {
            const ariaMatch  = line.match(/aria-label="([^"]+)"/);
            if (ariaMatch)  return `[aria-label="${ariaMatch[1]}"]`;
            const nameMatch  = line.match(/name="([^"]+)"/);
            if (nameMatch)  return `[name="${nameMatch[1]}"]`;
            const tidMatch   = line.match(/data-testid="([^"]+)"/);
            if (tidMatch)   return `[data-testid="${tidMatch[1]}"]`;
            const phMatch    = line.match(/placeholder="([^"]+)"/);
            if (phMatch)    return `[placeholder="${phMatch[1]}"]`;
          }
        }
      }

      // Pass 2: positional fallback — map role index to DOM order
      // e.g. for { to, subject, body }: first input = to, second = subject, third = body (contenteditable)
      const roleKeys = Object.keys(fieldMap);
      const roleIndex = roleKeys.indexOf(role);
      if (roleIndex !== -1 && roleIndex < inputLines.length) {
        const line = inputLines[roleIndex];
        const ariaMatch = line.match(/aria-label="([^"]+)"/);
        if (ariaMatch) return `[aria-label="${ariaMatch[1]}"]`;
        const nameMatch = line.match(/name="([^"]+)"/);
        if (nameMatch) return `[name="${nameMatch[1]}"]`;
        const tidMatch  = line.match(/data-testid="([^"]+)"/);
        if (tidMatch)  return `[data-testid="${tidMatch[1]}"]`;
      }

      return null;
    };

    for (const role of Object.keys(fieldMap)) {
      if (!resolvedSelectors[role]) {
        const fallback = heuristicSelector(role);
        if (fallback) {
          resolvedSelectors[role] = fallback;
          logger.debug(`[Node:ExecuteCommand] smartFill: heuristic fallback for "${role}": ${fallback}`);
        }
      }
    }

    // ── Step 4: Type into each resolved field ─────────────────────────────────
    const filled = [];
    const errors = [];

    for (const role of Object.keys(fieldMap)) {
      const selector = resolvedSelectors[role];
      const value    = fieldMap[role];
      if (!selector) { errors.push(`${role}: no selector found`); continue; }

      // For "to" field: append {TAB} to confirm recipient chip (not {ENTER} which triggers search)
      const textToType = role === 'to' ? `${value}{TAB}` : value;
      // For "body": click first to focus, then type
      const needsClick = role === 'body';

      try {
        if (needsClick) {
          await mcpAdapter.call('command.command.automate', {
            skill: 'browser.act',
            args: { action: 'click', selector, sessionId }
          });
        }
        await mcpAdapter.call('command.command.automate', {
          skill: 'browser.act',
          args: { action: 'type', selector, text: textToType, sessionId, clear: true }
        });
        filled.push(`${role} → ${selector}`);
        logger.debug(`[Node:ExecuteCommand] smartFill: filled "${role}" with selector "${selector}"`);
      } catch (typeErr) {
        errors.push(`${role} (${selector}): ${typeErr.message}`);
        logger.warn(`[Node:ExecuteCommand] smartFill: failed to fill "${role}": ${typeErr.message}`);
      }
    }

    const allFailed = filled.length === 0 && errors.length > 0;
    const stdout = `Filled: ${filled.join(', ')}${errors.length ? ` | Errors: ${errors.join(', ')}` : ''}`;

    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'smartFill', description: description || 'Fill form fields', stdout });

    const stepResult = { step: skillCursor + 1, skill: 'smartFill', args, description, ok: !allFailed, result: { filled, errors, selectors: resolvedSelectors }, stdout };

    if (allFailed) {
      return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
    }

    return {
      ...state,
      skillResults: [...skillResults, stepResult],
      skillCursor: skillCursor + 1,
      failedStep: null,
      commandExecuted: false,
      answer: undefined
    };
  }

  // ── skill.install pseudo-skill ───────────────────────────────────────────
  // Reads a skill contract .md file from disk and registers it in the skill registry.
  // Args: { skillPath: string } — absolute path to the skill.md file.
  if (skill === 'skill.install') {
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: description || 'Installing skill...' });

    const rawPath = args.skillPath || args.path || args.contractPath || '';
    const skillPath = rawPath.replace(/~/g, require('os').homedir());

    if (!skillPath) {
      const errMsg = 'skill.install requires a skillPath argument (absolute path to the skill.md file)';
      logger.warn(`[Node:ExecuteCommand] skill.install: ${errMsg}`);
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: 'Install failed', error: errMsg });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'skill.install', args, description, ok: false, error: errMsg }],
        skillCursor: skillCursor + 1,
        failedStep: { skill: 'skill.install', error: errMsg, stepIndex: skillCursor },
      };
    }

    try {
      const fs = require('fs');
      if (!fs.existsSync(skillPath)) {
        throw new Error(`Skill contract file not found: ${skillPath}`);
      }
      const contractMd = fs.readFileSync(skillPath, 'utf8');

      const installRes = await mcpAdapter.callService('user-memory', 'skill.install', { contractMd }, { timeoutMs: 10000 });
      const raw = installRes?.data || installRes;
      const skillName = raw?.name || rawPath.split('/').slice(-2, -1)[0] || 'skill';
      const created = raw?.created !== false;
      const resultMsg = created ? `✅ Skill **${skillName}** installed successfully` : `✅ Skill **${skillName}** updated`;

      logger.info(`[Node:ExecuteCommand] skill.install: ${created ? 'installed' : 'updated'} ${skillName}`);
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: resultMsg, stdout: resultMsg });
      if (typeof state.streamCallback === 'function') state.streamCallback(resultMsg);

      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'skill.install', args, description, ok: true, result: raw, stdout: resultMsg }],
        skillCursor: skillCursor + 1,
        failedStep: null,
      };
    } catch (err) {
      const errMsg = err.message || 'skill.install failed';
      logger.error(`[Node:ExecuteCommand] skill.install error: ${errMsg}`);
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: 'Install failed', error: errMsg });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'skill.install', args, description, ok: false, error: errMsg }],
        skillCursor: skillCursor + 1,
        failedStep: { skill: 'skill.install', error: errMsg, stepIndex: skillCursor },
      };
    }
  }

  // ── list_skills pseudo-skill ─────────────────────────────────────────────
  // Invoked when user says "list skills" or "what skills are available"
  // Returns a formatted list of all registered skills with one-line descriptions.
  if (skill === 'list_skills') {
    const builtinSkills = [
      { name: 'file.bridge',       desc: 'Bidirectional .md file channel between ThinkDrop and Windsurf/Cursor. Actions: read, write, poll, status, clear, init, watch' },
      { name: 'fs.read',           desc: 'Read files and explore codebases. Actions: read, tree, search, explore, tail, stat' },
      { name: 'file.watch',        desc: 'Watch files for changes. Actions: start, stop, list, poll, read' },
      { name: 'shell.run',         desc: 'Run shell commands, scripts, and CLI tools' },
      { name: 'browser.act',       desc: 'Control a browser: navigate, click, type, scan, scrape, screenshot. Actions: navigate, smartClick, smartType, getPageText, scanCurrentPage, screenshot, ...' },
      { name: 'image.analyze',     desc: 'Analyze a screenshot or image file with vision AI' },
      { name: 'ui.axClick',        desc: 'Click UI elements via macOS Accessibility (no browser needed)' },
      { name: 'ui.findAndClick',   desc: 'Find and click a UI element by label or description' },
      { name: 'ui.typeText',       desc: 'Type text into the focused UI element' },
      { name: 'ui.moveMouse',      desc: 'Move the mouse cursor to a position' },
      { name: 'ui.waitFor',        desc: 'Wait for a UI condition (element appears, text changes, etc.)' },
      { name: 'ui.screen.verify',  desc: 'Verify what is on screen using vision AI' },
      { name: 'schedule',          desc: 'Schedule a task to run at a future time or after a delay' },
      { name: 'synthesize',        desc: 'Run an inline LLM call to summarize, compare, or analyze results from prior steps' },
      { name: 'guide.step',        desc: 'Interactive step-by-step browser guide with visual highlights and user prompts' },
    ];

    // Fetch installed user skills from MCP
    // skill.listNames returns { data: { results: [{ name, description }] } } via MCP wrapper
    let installedSkills = [];
    try {
      const listRes = await mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 5000 });
      const raw = listRes?.data || listRes;
      const names = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
      installedSkills = names
        .filter(s => s && (typeof s === 'string' || s.name))
        .map(s => ({
          name: typeof s === 'string' ? s : s.name,
          desc: (typeof s === 'object' && s.description) ? s.description : 'Installed skill',
        }));
    } catch (_e) {
      // non-fatal — skip installed skills section if MCP unavailable
    }

    const outputParts = [
      '## ThinkDrop Skills',
      '',
      'Say a skill name directly to invoke it. Example: `file.bridge read` or `fs.read tree ~/projects/myapp`',
      '',
      '### Built-in Skills',
      ...builtinSkills.map(s => `**\`${s.name}\`** — ${s.desc}`),
    ];

    if (installedSkills.length > 0) {
      outputParts.push('', '### Installed Skills', ...installedSkills.map(s => `**\`${s.name}\`** — ${s.desc}`));
    }

    outputParts.push('', 'Tip: Add arguments after the skill name, e.g. `file.bridge write Tell Windsurf to refactor LoginForm.tsx`');

    const output = outputParts.join('\n');
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'list_skills', description: 'Listing available skills' });
    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'list_skills', description: 'Available skills', stdout: output });
    if (typeof state.streamCallback === 'function') state.streamCallback(output);
    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'list_skills', args, description, ok: true, result: output, stdout: output }],
      skillCursor: skillCursor + 1,
      failedStep: null,
    };
  }

  // ── synthesize pseudo-skill ──────────────────────────────────────────────
  // Runs the LLM synthesis INLINE so the answer is in state before any
  // subsequent steps execute. This allows post-synthesize steps to use
  // {{synthesisAnswer}} in their args (e.g. smartType the comparison into Google).
  if (skill === 'synthesize') {
    logger.debug(`[Node:ExecuteCommand] synthesize step — running LLM inline`);
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'synthesize', description: description || 'Comparing results...' });

    // Gather all getPageText results from prior steps
    logger.debug(`[Node:ExecuteCommand] synthesize: skillResults has ${skillResults.length} entries`);
    skillResults.forEach((r, i) => {
      logger.debug(`[Node:ExecuteCommand]   [${i}] skill=${r.skill} action=${r.args?.action} ok=${r.ok} result=${r.result ? String(r.result).substring(0, 80) : 'null'}`);
    });
    const pageTextResults = skillResults
      .filter(r => r.skill === 'browser.act' && r.args?.action === 'getPageText' && r.ok && r.result)
      .map(r => ({ source: r.args?.sessionId || 'unknown', url: r.url || '', text: r.result }));
    logger.debug(`[Node:ExecuteCommand] synthesize: found ${pageTextResults.length} getPageText results`);

    // Include shell.run stdout (e.g. cat file output) as well as browser getPageText results
    const shellStdoutResults = skillResults
      .filter(r => r.skill === 'shell.run' && r.ok && r.stdout && r.stdout.trim().length > 0)
      .map(r => `=== Shell output (${r.description || r.args?.cmd || 'shell.run'}) ===\n${r.stdout}`);

    // Include file.bridge read results — extract blocks array and format as readable text
    const fileBridgeResults = skillResults
      .filter(r => r.skill === 'file.bridge' && r.ok && r.args?.action === 'read')
      .map(r => {
        const raw = r._raw || {};
        const blocks = raw.blocks || [];
        if (blocks.length === 0) return `=== Bridge file (${raw.bridgeFile || '~/.thinkdrop/bridge.md'}) ===\n(No blocks found)`;
        const blockText = blocks.map(b =>
          `--- ${b.prefix}:${b.type} [id=${b.id}] [status=${b.status}]${b.refId ? ` [ref=${b.refId}]` : ''} [ts=${b.ts}] ---\n${b.body}`
        ).join('\n\n');
        return `=== Bridge file: ${blocks.length} block(s) (${raw.bridgeFile || '~/.thinkdrop/bridge.md'}) ===\n\n${blockText}`;
      });

    // Include fs.read results — tree, file content, search matches
    const fsReadResults = skillResults
      .filter(r => r.skill === 'fs.read' && r.ok)
      .map(r => {
        const raw = r._raw || {};
        const action = r.args?.action || 'read';
        if (action === 'tree') return `=== Directory tree: ${raw.path} ===\n${raw.tree || ''}`;
        if (action === 'search') return `=== Search results (pattern: ${raw.pattern}) ===\n${raw.output || ''}`;
        if (action === 'tail') return `=== File tail: ${raw.path} ===\n${raw.content || ''}`;
        if (action === 'stat') return `=== File stat: ${raw.path} ===\n${JSON.stringify(raw, null, 2)}`;
        // read or explore
        const parts = [];
        if (raw.tree) parts.push(`Directory tree:\n${raw.tree}`);
        const files = [...(raw.keyFiles || []), ...(raw.entryPoints || []), ...(raw.files || [])];
        files.forEach(f => parts.push(`--- File: ${f.path} (${f.lines} lines) ---\n${f.content}`));
        return `=== fs.read (${action}: ${raw.path}) ===\n${parts.join('\n\n')}`;
      });

    // Include image.analyze results — each entry includes the file path and the vision description
    const imageAnalyzeResults = skillResults
      .filter(r => r.skill === 'image.analyze' && r.ok && r.stdout && r.stdout.trim())
      .map(r => {
        const filePath = r.args?.filePath || 'unknown file';
        return `=== Image analysis: ${filePath} ===\n${r.stdout.trim()}`;
      });

    const allContextParts = [
      ...pageTextResults.map(p => `=== Source: ${p.url || p.source} ===\n${p.text}`),
      ...shellStdoutResults,
      ...fileBridgeResults,
      ...fsReadResults,
      ...imageAnalyzeResults,
    ];

    // If no within-run context, check conversationHistory for prior image.analyze / skill output
    // This handles cross-turn synthesis: "put this in a text document" after a previous analysis run.
    const conversationHistory = state.conversationHistory || [];
    let crossTurnContext = '';
    if (allContextParts.length === 0 && conversationHistory.length > 0) {
      // Find the most recent assistant message that contains step outputs
      const recentOutputMsg = [...conversationHistory].reverse()
        .find(m => m.role === 'assistant' && m.content && m.content.includes('Step outputs:'));
      if (recentOutputMsg) {
        crossTurnContext = recentOutputMsg.content;
        logger.debug(`[Node:ExecuteCommand] synthesize: using cross-turn context from conversation history (${crossTurnContext.length} chars)`);
      }
    }

    const synthesisContext = allContextParts.length > 0
      ? allContextParts.join('\n\n')
      : crossTurnContext || skillResults.filter(r => r.ok && r.result).map(r => String(r.result)).join('\n\n');

    const synthesisPrompt = args.prompt || description || 'Compare and summarize the results from each source.';
    let synthesisFilePath = args.saveToFile || null;

    // If saveToFile contains {{prev_stdout}}, resolve it now using the previous step's stdout
    if (synthesisFilePath && synthesisFilePath.includes('{{prev_stdout}}')) {
      const prevStep = skillResults[skillResults.length - 1];
      const prevStdout = prevStep?.stdout?.trim() || '';
      synthesisFilePath = synthesisFilePath.replace(/\{\{prev_stdout\}\}/g, prevStdout);
      logger.debug(`[Node:ExecuteCommand] synthesize: resolved saveToFile via {{prev_stdout}}: ${synthesisFilePath}`);
    }

    // Expand ~/path → absolute path (Node.js fs does not expand ~)
    if (synthesisFilePath && synthesisFilePath.startsWith('~/')) {
      synthesisFilePath = synthesisFilePath.replace('~', os.homedir());
      logger.debug(`[Node:ExecuteCommand] synthesize: expanded ~ in saveToFile: ${synthesisFilePath}`);
    }

    // If saveToFile is still relative/missing but a prior shell.run step output a single absolute path,
    // use that path's directory (handles single-pipeline find+read where stdout = file content, not path)
    if (!synthesisFilePath || (!synthesisFilePath.startsWith('/') && !synthesisFilePath.startsWith(os.homedir()))) {
      const pathMod = require('path');
      // Look for a pure-find step whose stdout is a single absolute file path
      const purePathStep = skillResults.find(r =>
        r.skill === 'shell.run' && r.ok && r.stdout &&
        /^\/[^\n]+\.[a-zA-Z0-9]+$/.test(r.stdout.trim())
      );
      if (purePathStep) {
        const foundPath = purePathStep.stdout.trim();
        const dir = pathMod.dirname(foundPath);
        const base = pathMod.basename(foundPath, pathMod.extname(foundPath));
        synthesisFilePath = pathMod.join(dir, base + '.txt');
        logger.debug(`[Node:ExecuteCommand] synthesize: saveToFile from pure-find step stdout: ${synthesisFilePath}`);
      }
    }

    // Run LLM inline
    const llmBackend = state.llmBackend;
    const streamCallback = state.streamCallback;
    const context = state.context;
    let synthesisAnswer = '[Synthesis unavailable — no LLM backend]';

    if (llmBackend) {
      const isStreaming = typeof streamCallback === 'function';
      // Use file-editing instructions when shell stdout is present (file content), otherwise use web research instructions
      const hasFileContent = shellStdoutResults.length > 0;
      const hasImageAnalysis = imageAnalyzeResults.length > 0 || crossTurnContext.includes('Image analysis:');
      const synthesisQuery = hasFileContent
        ? `${synthesisPrompt}\n\nHere is the current file content:\n\n${synthesisContext}`
        : `${synthesisPrompt}\n\nHere is the content collected from each source:\n\n${synthesisContext}`;
      // Detect response language from the original user message (same approach as answer.js).
      // Voice: read sessionLanguage from journal. Text: detect from script/accent heuristics.
      const _SYNTH_LANG_NAMES = { zh: 'Chinese (Mandarin)', es: 'Spanish', fr: 'French', pt: 'Portuguese', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', de: 'German', it: 'Italian', ru: 'Russian' };
      const _synthSourceText = state.originalMessage || state.resolvedMessage || state.message || '';
      function _synthDetectLang(text) {
        if (!text || text.length < 3) return null;
        const cjk = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g) || []).length;
        const hiragana = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
        const hangul = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length;
        const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
        const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
        const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
        const total = text.replace(/\s/g, '').length || 1;
        if (cjk / total > 0.15) return hiragana > cjk * 0.3 ? 'ja' : 'zh';
        if (hangul / total > 0.15) return 'ko';
        if (arabic / total > 0.15) return 'ar';
        if (cyrillic / total > 0.15) return 'ru';
        if (devanagari / total > 0.15) return 'hi';
        if (/[¿¡áéíóúüñ]/i.test(text)) return 'es';
        if (/[àâçèéêëîïôùûüæœ]/i.test(text)) return 'fr';
        if (/[àèìòùâêîôûã]/i.test(text)) return 'pt';
        if (/[äöüß]/i.test(text)) return 'de';
        if (/[àèìòùé]/i.test(text)) return 'it';
        return null;
      }
      let _synthLang = null;
      if (state.context?.source === 'voice') {
        try {
          const _voiceJournalPath = require('path').join(require('os').homedir(), '.thinkdrop', 'voice-state.json');
          const _voiceJournal = JSON.parse(require('fs').readFileSync(_voiceJournalPath, 'utf8'));
          const sl = _voiceJournal?.voice?.sessionLanguage;
          if (sl && sl !== 'en') _synthLang = sl;
        } catch (_) {}
      }
      if (!_synthLang) _synthLang = _synthDetectLang(_synthSourceText);
      const _synthLangSuffix = (_synthLang && _synthLang !== 'en')
        ? `\n\nIMPORTANT: The user wrote in ${_SYNTH_LANG_NAMES[_synthLang] || _synthLang}. You MUST respond entirely in ${_SYNTH_LANG_NAMES[_synthLang] || _synthLang}.`
        : '';
      const synthesisInstructions = (hasFileContent
        ? `You are a file editing assistant. The user has asked you to modify a file. You have been given the current file content. Your job is to output the COMPLETE updated file content with ONLY the requested changes applied. Output the full file text only — no preamble, no explanation, no markdown code fences, no commentary. Preserve all existing structure, headings, and formatting. Only change what was explicitly requested.`
        : hasImageAnalysis
        ? `You are a report writer. The user has analyzed a folder of images/screenshots and wants a summary. You have been given the vision AI analysis of each image. Write a clear, structured report using ONLY the actual file names and descriptions provided — do NOT invent or guess file names, sizes, or content. Use the exact file path from each "Image analysis: <path>" heading as the file name.`
        : `You are a research assistant. The user asked you to compare or summarize information from multiple websites. You have been given the text content from each site. Provide a clear, structured comparison or summary that directly answers the user's request. Use headings for each source if comparing. Be concise and factual.`) + _synthLangSuffix;
      const synthPayload = {
        query: synthesisQuery,
        context: {
          conversationHistory: [],
          systemInstructions: synthesisInstructions,
          sessionId: context?.sessionId,
          userId: context?.userId,
          intent: 'command_automate'
        },
        options: { maxTokens: 1500, temperature: 0.2, fastMode: false }
      };
      try {
        synthesisAnswer = await llmBackend.generateAnswer(synthesisQuery, synthPayload, synthPayload.options, isStreaming ? streamCallback : null);
        logger.debug(`[Node:ExecuteCommand] synthesize: LLM answer generated (${synthesisAnswer.length} chars)`);
        if (!isStreaming && typeof streamCallback === 'function' && synthesisAnswer) streamCallback(synthesisAnswer);
      } catch (err) {
        logger.error('[Node:ExecuteCommand] synthesize LLM call failed:', err.message);
        synthesisAnswer = `[Synthesis failed: ${err.message}]`;
      }
    } else {
      logger.warn('[Node:ExecuteCommand] synthesize: no llmBackend in state — skipping LLM call');
    }

    const fs = require('fs');
    const path = require('path');

    // Write to explicit saveToFile if requested
    if (synthesisFilePath && synthesisAnswer && !synthesisAnswer.startsWith('[')) {
      try {
        // Strip internal === Shell output (...) === markers that executeCommand injects for LLM context
        // but must never appear in saved files (e.g. skill.md contracts, text files, etc.)
        const cleanedAnswer = synthesisAnswer.replace(/^=== Shell output \(.*?\) ===\s*/gm, '').trim();
        fs.writeFileSync(synthesisFilePath, cleanedAnswer, 'utf8');
        logger.debug(`[Node:ExecuteCommand] synthesize: saved to ${synthesisFilePath}`);
      } catch (writeErr) {
        logger.warn(`[Node:ExecuteCommand] synthesize: could not write file: ${writeErr.message}`);
      }
    }

    // Always write to a temp file so shell.run steps can use {{synthesisAnswerFile}}
    let synthesisAnswerFile = '';
    try {
      synthesisAnswerFile = path.join(os.tmpdir(), `thinkdrop_synthesis_${Date.now()}.txt`);
      fs.writeFileSync(synthesisAnswerFile, synthesisAnswer, 'utf8');
      logger.debug(`[Node:ExecuteCommand] synthesize: temp file at ${synthesisAnswerFile}`);
    } catch (tmpErr) {
      logger.warn(`[Node:ExecuteCommand] synthesize: could not write temp file: ${tmpErr.message}`);
    }

    // Emit step_done with the actual answer as stdout (and savedFilePath if written)
    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'synthesize', description: description || 'Comparing results...', stdout: synthesisAnswer, savedFilePath: synthesisFilePath || null });

    // Accumulate explicit saveToFile paths across multiple synthesize steps
    const prevSavedFiles = state.savedFilePaths || [];
    const newSavedFiles = synthesisFilePath && !synthesisAnswer.startsWith('[')
      ? [...prevSavedFiles, synthesisFilePath]
      : prevSavedFiles;

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'synthesize', args, description, ok: true, result: synthesisAnswer, stdout: synthesisAnswer }],
      skillCursor: skillCursor + 1,
      failedStep: null,
      synthesisAnswer,          // available as {{synthesisAnswer}} in subsequent step args
      synthesisAnswerFile,      // available as {{synthesisAnswerFile}} — use in shell.run for full bash power
      savedFilePaths: newSavedFiles,  // accumulated explicit saveToFile paths for UI file links
      needsSynthesis: false,
      commandExecuted: false,
      answer: undefined
    };
  }

  // Substitute template variables in step args so steps can reference prior results:
  //   {{synthesisAnswer}}     — full text output of the last synthesize step
  //   {{synthesisAnswerFile}} — temp file path containing synthesisAnswer
  //   {{prev_stdout}}         — stdout of the immediately preceding step (enables find→read→write chains)
  //   {{prev_watchId}}        — watchId from the last file.watch start step
  const synthesisAnswer = state.synthesisAnswer || '';
  const synthesisAnswerFile = state.synthesisAnswerFile || '';
  const prevStdout = skillResults.length > 0 ? (skillResults[skillResults.length - 1].stdout || '').trim() : '';
  // Resolve prev_watchId: find the most recent file.watch step that returned a watchId
  const prevWatchId = (() => {
    for (let i = skillResults.length - 1; i >= 0; i--) {
      const r = skillResults[i];
      if (r.skill === 'file.watch' && r.watchId) return r.watchId;
    }
    return '';
  })();
  let resolvedArgs = args;
  if (synthesisAnswer || synthesisAnswerFile || prevStdout || prevWatchId) {
    let argsJson = JSON.stringify(args);
    if (synthesisAnswer) {
      argsJson = argsJson.replace(/\{\{synthesisAnswer\}\}/g, synthesisAnswer.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'));
    }
    if (synthesisAnswerFile) {
      argsJson = argsJson.replace(/\{\{synthesisAnswerFile\}\}/g, synthesisAnswerFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
    if (prevStdout) {
      argsJson = argsJson.replace(/\{\{prev_stdout\}\}/g, prevStdout.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'));
    }
    if (prevWatchId) {
      argsJson = argsJson.replace(/\{\{prev_watchId\}\}/g, prevWatchId.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
    resolvedArgs = JSON.parse(argsJson);
  }

  // Expand ~ in shell.run argv — the LLM may generate paths with single-quoted tilde
  // (e.g. '~/.thinkdrop/...') which bash cannot expand. Pre-expand here unconditionally.
  if (skill === 'shell.run' && Array.isArray(resolvedArgs.argv)) {
    const _homeDir = require('os').homedir();
    resolvedArgs = {
      ...resolvedArgs,
      argv: resolvedArgs.argv.map(a => typeof a === 'string' ? a.replace(/~/g, _homeDir) : a),
    };
  }

  logger.debug(`[Node:ExecuteCommand] Step ${skillCursor + 1}/${skillPlan.length}: ${skill}${description ? ` — ${description}` : ''}`);
  if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill });

  // Handle _waitBeforeMs injected by recoverSkill AUTO_PATCH for mid-navigation retries
  if (resolvedArgs._waitBeforeMs) {
    logger.debug(`[Node:ExecuteCommand] Waiting ${resolvedArgs._waitBeforeMs}ms before retry (page navigation settle)`);
    await new Promise(r => setTimeout(r, resolvedArgs._waitBeforeMs));
    // Strip the internal flag before sending to MCP
    const { _waitBeforeMs, ...cleanArgs } = resolvedArgs;
    resolvedArgs = cleanArgs;
  }

  // Use the step's timeoutMs (may have been patched by recoverSkill AUTO_PATCH) as the HTTP timeout.
  // Special case: file.bridge poll uses pollTimeoutMs for the internal poll duration — the HTTP
  // timeout must be longer than that or the MCPClient kills the request before the poll completes.
  let stepTimeoutMs = resolvedArgs.timeoutMs || 60000;
  if (skill === 'file.bridge' && resolvedArgs.action === 'poll' && resolvedArgs.pollTimeoutMs) {
    stepTimeoutMs = Math.max(stepTimeoutMs, resolvedArgs.pollTimeoutMs + 10000);
  }

  try {
    const result = await mcpAdapter.callService('command', 'command.automate', {
      skill,
      args: resolvedArgs
    }, { timeoutMs: stepTimeoutMs });

    const raw = result.data || result;

    // For ui.waitFor steps: synthesize a human-readable stdout from matched condition
    let waitForStdout = null;
    if (skill === 'ui.waitFor' && raw.success) {
      const parts = [];
      if (raw.matched) {
        parts.push(`Matched: ${raw.condition}="${raw.value}"`);
        if (raw.appName && raw.appName !== 'unknown') parts.push(`app=${raw.appName}`);
        if (raw.url) parts.push(raw.url);
        if (raw.windowTitle && raw.windowTitle !== 'unknown') parts.push(`"${raw.windowTitle}"`);
        parts.push(`(${raw.elapsed}ms, ${raw.pollCount} polls)`);
      } else {
        parts.push(`Timed out waiting for ${raw.condition}="${raw.value}"`);
      }
      waitForStdout = parts.join(' — ');
    }

    // For browser.act steps: synthesize a human-readable stdout from url+title+result
    // so the UI step list shows something meaningful instead of "No output"
    let browserStdout = null;
    if (skill === 'browser.act' && raw.ok) {
      const parts = [];
      if (raw.url) parts.push(raw.url);
      if (raw.title) parts.push(`"${raw.title}"`);
      if (raw.result !== undefined && raw.result !== null) {
        const resultStr = typeof raw.result === 'object' ? JSON.stringify(raw.result) : String(raw.result);
        if (resultStr.length < 200) parts.push(resultStr);
      }
      if (parts.length) browserStdout = parts.join(' — ');
    }

    // ui.screen.verify ok logic:
    //   verified: true  → real pass
    //   verified: null  → degraded (vision unavailable) → treat as pass (skip verification)
    //   verified: false → real failure → trigger recoverSkill
    const verifyOk = raw.success === true && (raw.verified === true || raw.verified === null);
    if (skill === 'ui.screen.verify' && raw.degraded) {
      logger.warn('[Node:ExecuteCommand] ui.screen.verify degraded — vision unavailable, skipping verification', { reasoning: raw.reasoning });
    }

    // For fs.read tree/explore: synthesize stdout from the tree string so
    // (a) priorResultsNote in planSkills gets real filenames on replan,
    // (b) the post-fs.read plan patch can read it from stepResult.stdout as fallback.
    let fsReadStdout = null;
    if (skill === 'fs.read' && raw.ok) {
      if (raw.tree) {
        fsReadStdout = raw.tree;
      } else if (raw.result?.tree) {
        fsReadStdout = raw.result.tree;
      } else if (raw.files && Array.isArray(raw.files)) {
        fsReadStdout = raw.files.map(f => f.path || f).join('\n');
      }
    }

    const stepResult = {
      step: skillCursor + 1,
      skill,
      args: resolvedArgs,
      description: description || null,
      ok: skill === 'ui.screen.verify'
        ? verifyOk
        : (raw.ok ?? raw.success ?? false),
      stdout: raw.stdout || waitForStdout || browserStdout || fsReadStdout || null,
      stderr: raw.stderr || null,
      exitCode: raw.exitCode ?? null,
      result: raw.result ?? (skill === 'file.watch' ? raw : null),
      watchId: skill === 'file.watch' ? (raw.watchId || null) : null,
      _raw: (skill === 'file.bridge' || skill === 'fs.read') ? raw : undefined,
      url: raw.url ?? null,
      pageContext: raw.pageContext ?? null,
      error: raw.error || null,
      executionTime: raw.executionTime || null,
      needsManualStep: raw.needsManualStep || false,
      instruction: raw.instruction || null,
      reason: raw.reason || null,
      verified: raw.verified !== undefined ? raw.verified : null,
      reasoning: raw.reasoning || null,
      suggestion: raw.suggestion || null
    };

    // Detect shell.run search commands that returned no results — treat as soft failure
    // so recoverSkill can REPLAN with a different search strategy (e.g. mdfind → find)
    // NOTE: only applies to shell.run, never browser.act
    // NOTE: bash scripts that also contain write/edit ops (sed -i, cp, mv, echo >, tee, cat >)
    //       are NOT pure searches — no output is expected and is a success.
    const SEARCH_CMDS = ['mdfind', 'find', 'grep', 'locate'];
    const WRITE_OPS = ['sed -i', 'sed -E -i', 'cp ', 'mv ', 'echo ', 'tee ', 'cat >', 'cat>',
                       'printf ', 'write ', 'rm ', 'mkdir ', 'touch ', 'chmod ', 'chown '];
    const bashScript = args.cmd === 'bash' && Array.isArray(args.argv)
      ? args.argv.find(a => typeof a === 'string') || ''
      : '';
    const isBashSearchScript = bashScript.length > 0 &&
      SEARCH_CMDS.some(sc => bashScript.includes(sc)) &&
      !WRITE_OPS.some(wo => bashScript.includes(wo));
    const isSearchCmd = skill === 'shell.run' && (SEARCH_CMDS.includes(args.cmd) || isBashSearchScript);
    const noOutput = !stepResult.stdout || stepResult.stdout.trim().length === 0;

    if (isSearchCmd && noOutput && (stepResult.ok || stepResult.exitCode === 1)) {
      stepResult.ok = false;
      stepResult.error = `search_no_results: search returned no results for the given query`;
    }

    const updatedResults = [...skillResults, stepResult];

    if (!stepResult.ok && !optional) {
      // Step failed and is not optional — hand off to recoverSkill
      logger.warn(`[Node:ExecuteCommand] Step ${skillCursor + 1} failed: ${stepResult.error}`);
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill, error: stepResult.error, stderr: stepResult.stderr });
      return {
        ...state,
        skillResults: updatedResults,
        skillCursor,           // cursor stays at failed step
        failedStep: stepResult,
        commandExecuted: false
      };
    }

    if (!stepResult.ok && optional) {
      logger.debug(`[Node:ExecuteCommand] Optional step ${skillCursor + 1} failed (skipping): ${stepResult.error}`);
    }

    if (stepResult.ok || optional) {
      if (skill === 'image.analyze') {
        logger.info(`[Node:ExecuteCommand] image.analyze step_done stdout length: ${stepResult.stdout?.length ?? 'null'}, preview: ${String(stepResult.stdout || '').slice(0, 80)}`);
      }
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill, stdout: stepResult.stdout, exitCode: stepResult.exitCode });
    }

    // Track the active browser sessionId and URL for follow-up tasks
    const activeBrowserSessionId = skill === 'browser.act' && stepResult.ok && args.sessionId
      ? args.sessionId
      : state.activeBrowserSessionId || null;
    const activeBrowserUrl = skill === 'browser.act' && stepResult.ok && raw.url
      ? raw.url
      : state.activeBrowserUrl || null;

    // ── Post-navigate scan ────────────────────────────────────────────────────
    // After a successful navigate, scan the live page and patch the next highlight
    // step with real element labels from the actual loaded page (handles redirects,
    // 404s, and dynamic content — no URL guessing needed).
    if (skill === 'browser.act' && resolvedArgs.action === 'navigate' && stepResult.ok && resolvedArgs.sessionId && mcpAdapter) {
      const navSessionId = resolvedArgs.sessionId;
      const nextHighlightIdx = skillPlan.findIndex(
        (s, i) => i > skillCursor && s.skill === 'browser.act' && s.args?.action === 'highlight'
      );
      if (nextHighlightIdx !== -1) {
        try {
          const scanRes = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'browser.act',
            args: { action: 'scanCurrentPage', sessionId: navSessionId }
          }, { timeoutMs: 8000 });
          const scan = scanRes?.data || scanRes;

          // 404 detection — scanCurrentPage returns ok:false + errorType:'page_not_found'
          if (!scan?.ok && scan?.errorType === 'page_not_found') {
            const badUrl = scan?.url || resolvedArgs.url;
            logger.warn(`[Node:ExecuteCommand] Navigate landed on 404 (${badUrl}) — marking step failed for replan`);
            const failedNav = { ...stepResult, ok: false, error: `navigate_404: ${badUrl} is a 404 page. Use a different URL.` };
            if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill, error: failedNav.error });
            return {
              ...state,
              skillResults: [...skillResults, failedNav],
              skillCursor,
              failedStep: failedNav,
              commandExecuted: false
            };
          }

          if (scan?.ok && scan?.result?.elements?.length > 0) {
            const els = scan.result.elements;
            const actualUrl = scan.result.url;
            logger.info(`[Node:ExecuteCommand] Post-navigate scan: ${els.length} elements on ${actualUrl}`);
            // Store real page elements in state — planSkills injects these into the LLM prompt
            // on replan so it picks exact labels instead of guessing.
            return {
              ...state,
              skillResults: updatedResults,
              skillCursor: skillCursor + 1,
              failedStep: null,
              activeBrowserSessionId,
              activeBrowserUrl: actualUrl || activeBrowserUrl,
              activeBrowserPageElements: { url: actualUrl, elements: els },
              commandExecuted: false,
              answer: undefined
            };
          }
        } catch (scanErr) {
          logger.debug(`[Node:ExecuteCommand] Post-navigate scan failed (non-fatal): ${scanErr.message}`);
        }
      }
    }

    // ── Post-fs.read plan patch ───────────────────────────────────────────────
    // planSkills runs BEFORE fs.read executes, so the LLM can only invent placeholder
    // filenames (Screenshot1.png, image1.png, etc.). Once fs.read succeeds and returns
    // real paths, patch any downstream image.analyze steps that reference non-existent
    // files with the actual paths found in the directory listing.
    let patchedSkillPlan = skillPlan;
    if (skill === 'fs.read' && stepResult.ok) {
      const fsRaw = stepResult._raw || {};
      const fsAction = resolvedArgs.action;
      const fsBasePath = resolvedArgs.path ? String(resolvedArgs.path).replace(/^~/, require('os').homedir()) : null;

      // Extract real image paths from tree or explore stdout
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif']);
      let realImagePaths = [];

      // tree output: "/base/path/\n├── file1.png (123KB)\n└── file2.jpg (456KB)"
      const treeStr = fsRaw.tree || fsRaw.result?.tree || '';
      if ((fsAction === 'tree' || fsAction === 'explore') && treeStr && fsBasePath) {
        const pathMod = require('path');
        const lines = treeStr.split('\n');
        for (const line of lines) {
          // Strip tree drawing chars and extract filename
          const name = line.replace(/^[│├└─\s]+/, '').replace(/\s*\([\d.]+[KMB]+\)\s*$/, '').trim();
          if (!name || name.endsWith('/')) continue;
          const ext = pathMod.extname(name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            realImagePaths.push(pathMod.join(fsBasePath, name));
          }
        }
      }

      // Also check fs.read result.files array (explore action returns this)
      const resultFiles = fsRaw.result?.files || [];
      if (resultFiles.length > 0) {
        for (const f of resultFiles) {
          const fp = f.path || f;
          if (typeof fp === 'string') {
            const ext = require('path').extname(fp).toLowerCase();
            if (IMAGE_EXTS.has(ext) && !realImagePaths.includes(fp)) {
              realImagePaths.push(fp);
            }
          }
        }
      }

      if (realImagePaths.length > 0) {
        logger.info(`[Node:ExecuteCommand] fs.read patch: found ${realImagePaths.length} real image paths — patching downstream image.analyze steps`);

        // Find all downstream image.analyze steps
        const downstreamAnalyzeIdxs = [];
        for (let i = skillCursor + 1; i < skillPlan.length; i++) {
          if (skillPlan[i].skill === 'image.analyze') downstreamAnalyzeIdxs.push(i);
        }

        if (downstreamAnalyzeIdxs.length > 0) {
          const pathMod = require('path');
          const fsSync = require('fs');
          const newPlan = [...skillPlan];

          if (downstreamAnalyzeIdxs.length === realImagePaths.length) {
            // 1:1 mapping — replace each placeholder with the real path
            downstreamAnalyzeIdxs.forEach((planIdx, i) => {
              const oldPath = newPlan[planIdx].args?.filePath;
              newPlan[planIdx] = {
                ...newPlan[planIdx],
                args: { ...newPlan[planIdx].args, filePath: realImagePaths[i] },
                description: `Analyze ${pathMod.basename(realImagePaths[i])}`
              };
              logger.info(`[Node:ExecuteCommand] fs.read patch: step[${planIdx + 1}] "${oldPath}" → "${realImagePaths[i]}"`);
            });
            patchedSkillPlan = newPlan;
          } else {
            // Mismatch — rebuild: remove all placeholder image.analyze steps, insert
            // one real step per discovered file before the first synthesize/other step
            const synthesizeIdx = newPlan.findIndex((s, i) => i > skillCursor && s.skill === 'synthesize');
            const insertBefore = synthesizeIdx !== -1 ? synthesizeIdx : newPlan.length;

            // Remove all old image.analyze steps from plan
            const withoutOldAnalyze = newPlan.filter((s, i) => i <= skillCursor || s.skill !== 'image.analyze');

            // Build new image.analyze steps with real paths
            const newAnalyzeSteps = realImagePaths.map((fp, i) => ({
              skill: 'image.analyze',
              args: { filePath: fp, query: newPlan[downstreamAnalyzeIdxs[0]]?.args?.query || 'Describe what is shown in this screenshot in detail.' },
              description: `Analyze ${pathMod.basename(fp)}`
            }));

            // Find new insertBefore in withoutOldAnalyze
            const newInsertBefore = withoutOldAnalyze.findIndex((s, i) => i > skillCursor && s.skill === 'synthesize');
            const insertIdx = newInsertBefore !== -1 ? newInsertBefore : withoutOldAnalyze.length;

            patchedSkillPlan = [
              ...withoutOldAnalyze.slice(0, insertIdx),
              ...newAnalyzeSteps,
              ...withoutOldAnalyze.slice(insertIdx)
            ];
            logger.info(`[Node:ExecuteCommand] fs.read patch: rebuilt plan with ${newAnalyzeSteps.length} real image.analyze steps`);
          }
        }
      }
    }

    const isLastStep = skillCursor + 1 >= (patchedSkillPlan || skillPlan).length;

    // If this was the last step, emit all_done now (the graph routes to logConversation
    // immediately — it never loops back for a second executeCommand pass, so the
    // skillCursor >= skillPlan.length block at the top is never reached).
    let lastStepAnswer;
    if (isLastStep) {
      const finalSavedPaths = [...(state.savedFilePaths || [])];
      const finalHomeDir = require('os').homedir();
      updatedResults.forEach((r) => {
        if (r.skill === 'shell.run' && r.ok && r.args?.cmd === 'bash') {
          const argv = r.args?.argv || [];
          const script = argv[1] || argv.find(a => typeof a === 'string' && a !== '-c') || '';
          const wm = script.match(/(?:echo\s[^>]*>+|printf\s[^>]*>+|cat\s*>+|tee\s+|cp\s+\S+\s+|mv\s+\S+\s+)\s*['"']?((?:~|\/)[^\s'"']+\.[a-zA-Z0-9]+)['"']?/);
          if (wm && wm[1]) {
            const rawPath = wm[1];
            const abs = rawPath.startsWith('~/') ? rawPath.replace('~', finalHomeDir) : rawPath;
            if (!finalSavedPaths.includes(abs)) finalSavedPaths.push(abs);
          }
        }
      });
      const completedCount = updatedResults.filter(r => r.ok).length;
      const failedCount = updatedResults.filter(r => !r.ok).length;
      const hasBrowserSteps = updatedResults.some(r => r.skill === 'browser.act');
      const lastBrowserResult = hasBrowserSteps
        ? [...updatedResults].reverse().find(r => r.skill === 'browser.act' && r.ok)
        : null;
      const imageAnalyzeResult = [...updatedResults].reverse().find(r => r.skill === 'image.analyze' && r.ok && r.stdout);

      if (imageAnalyzeResult) {
        lastStepAnswer = imageAnalyzeResult.stdout;
      } else if (hasBrowserSteps && lastBrowserResult?.url) {
        const title = lastBrowserResult.title ? ` — "${lastBrowserResult.title}"` : '';
        lastStepAnswer = `Done! Browser is open at ${lastBrowserResult.url}${title}`;
      } else if (failedCount === 0) {
        lastStepAnswer = `All ${completedCount} step${completedCount !== 1 ? 's' : ''} completed successfully.`;
      } else {
        lastStepAnswer = `Completed ${completedCount}/${skillPlan.length} steps (${failedCount} failed).`;
      }

      logger.info(`[Node:ExecuteCommand] last-step all_done: savedFilePaths=${JSON.stringify(finalSavedPaths)}`);
      if (progressCallback) progressCallback({ type: 'all_done', completedCount, totalCount: skillPlan.length, skillResults: updatedResults, savedFilePaths: finalSavedPaths });

      // Translate last-step answer to sessionLanguage if non-English.
      // These are short status strings ("Done!", "All 3 steps completed") that need translation.
      const _lastStepLang = (state.context?.source === 'voice') ? _readSessionLanguage() : 'en';
      if (_lastStepLang && _lastStepLang !== 'en' && lastStepAnswer && state.llmBackend) {
        try {
          const langName = _LANG_NAMES[_lastStepLang] || _lastStepLang;
          const translated = await state.llmBackend.generateAnswer(
            lastStepAnswer,
            { query: lastStepAnswer, context: { systemInstructions: `Translate the following text to ${langName}. Output ONLY the translation, nothing else.`, conversationHistory: [], intent: 'command_automate' }, options: { maxTokens: 100, temperature: 0 } },
            { maxTokens: 100, temperature: 0 },
            null
          ).catch(() => lastStepAnswer);
          if (translated && translated.trim()) lastStepAnswer = translated.trim();
        } catch (_) {}
      }

      // Stream answer to Results window immediately — graph won't loop back here
      if (lastStepAnswer && typeof state.streamCallback === 'function') {
        logger.info(`[Node:ExecuteCommand] Streaming last-step answer (${lastStepAnswer.length} chars)`);
        state.streamCallback(lastStepAnswer);
      }
    }

    // Step succeeded (or was optional) — advance cursor
    return {
      ...state,
      skillPlan: patchedSkillPlan,   // carry forward the (possibly patched) plan with real image paths
      skillResults: updatedResults,
      skillCursor: skillCursor + 1,
      failedStep: null,
      activeBrowserSessionId,
      activeBrowserUrl,
      commandExecuted: isLastStep,
      answer: lastStepAnswer  // set so voice service _stategraphLaneResponse gets it for TTS
    };

  } catch (error) {
    // Check if this is a search command that exited with code 1 (no results) — treat as soft failure
    const SEARCH_CMDS_CATCH = ['mdfind', 'find', 'grep', 'locate'];
    const isBashSearchCatch = args.cmd === 'bash' && Array.isArray(args.argv) &&
      args.argv.some(a => typeof a === 'string' && SEARCH_CMDS_CATCH.some(sc => a.includes(sc)));
    const isSearchExit1 = (SEARCH_CMDS_CATCH.includes(args.cmd) || isBashSearchCatch) &&
      error.message && error.message.includes('code 1');

    const stepResult = {
      step: skillCursor + 1,
      skill,
      args,
      ok: false,
      error: isSearchExit1 ? 'search_no_results: search returned no results for the given query' : error.message
    };

    if (!isSearchExit1) {
      logger.error('[Node:ExecuteCommand] Unexpected error:', error.message);
    } else {
      logger.debug('[Node:ExecuteCommand] Search returned no results (exit 1), treating as soft failure');
    }
    if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill, error: stepResult.error, stderr: null });

    return {
      ...state,
      skillResults: [...skillResults, stepResult],
      skillCursor,
      failedStep: stepResult,
      commandExecuted: false
    };
  }
};

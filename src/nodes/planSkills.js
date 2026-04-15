/**
 * Plan Skills Node
 *
 * Converts a user intent (command_automate) into a structured skill plan.
 * The LLM produces an ordered array of { skill, args, optional? } steps.
 * No natural language ever reaches the command-service — only structured calls.
 *
 * State inputs:
 *   state.message / state.resolvedMessage  — user's request
 *   state.intent.type                      — must be 'command_automate'
 *   state.llmBackend / state.mcpAdapter    — LLM backend (same as answer node)
 *   state.context                          — session context (os, userId, etc.)
 *   state.skillPlan                        — if already set (re-plan after recovery), preserved
 *   state.skillCursor                      — current step index (reset to 0 on fresh plan)
 *   state.recoveryContext                  — set by recoverSkill node to guide re-planning
 *
 * State outputs:
 *   state.skillPlan     — Array<{ skill, args, optional?, description? }>
 *   state.skillCursor   — 0 (reset for fresh execution)
 *   state.planError     — string if planning failed
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { jsonrepair } = require('jsonrepair');
const { buildReminderSkill } = require('../utils/buildReminderSkill');

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');

/**
 * Find a similar previously-run plan that completed 100% successfully.
 * Only returns plans with status: complete — never pending or failed.
 * Returns { planFile, title, file, similarity, skillPlan } or null.
 */
function findSimilarCompletePlan(prompt, logger) {
  try {
    if (!fs.existsSync(PLANS_DIR)) return null;
    const files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md') && f.startsWith('plan-'))
      .sort().reverse().slice(0, 20);

    const promptWords = new Set(
      prompt.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4)
    );

    for (const file of files) {
      const planPath = path.join(PLANS_DIR, file);
      try {
        const content = fs.readFileSync(planPath, 'utf8');
        // Only match 100% successfully completed plans
        const statusMatch = content.match(/^status:\s*(.+)/m);
        const status = statusMatch ? statusMatch[1].trim() : '';
        if (status !== 'complete') continue;

        // Must have stored skill_plan_json to be reusable
        const jsonMatch = content.match(/^skill_plan_json:\s*'([^']+)'/m);
        if (!jsonMatch) continue;

        const titleMatch = content.match(/^# Plan:\s*(.+)/m);
        const promptMatch = content.match(/^original_prompt:\s*"([^"]+)"/m);
        const planText = ((titleMatch ? titleMatch[1] : '') + ' ' + (promptMatch ? promptMatch[1] : '')).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        const planWords = new Set(planText.split(/\s+/).filter(w => w.length > 4));

        const intersection = [...promptWords].filter(w => planWords.has(w));
        const union = new Set([...promptWords, ...planWords]);
        const similarity = union.size > 0 ? intersection.length / union.size : 0;

        if (similarity >= 0.3) {
          try {
            const decoded = Buffer.from(jsonMatch[1], 'base64').toString('utf8');
            const skillPlan = JSON.parse(decoded);
            logger.info(`[Node:PlanSkills] Similar completed plan found (${Math.round(similarity * 100)}% match): ${file}`);
            return { planFile: planPath, title: titleMatch?.[1]?.trim() || file, file, similarity, skillPlan };
          } catch (_) { continue; }
        }
      } catch (_) { /* skip unreadable */ }
    }
  } catch (err) {
    logger.warn(`[Node:PlanSkills] findSimilarCompletePlan error: ${err.message}`);
  }
  return null;
}

/**
 * Serialize a JSON skill plan to a human-readable .md file.
 * Stores skill_plan_json (base64) in frontmatter so future similarity matches
 * can reuse the exact steps without re-invoking the LLM.
 * Status starts as 'pending' — only updated to 'complete' by executeCommand
 * after ALL steps succeed.
 */
function serializeSkillPlanToMd(skillPlan, originalPrompt, planId, sessionId) {
  const now = new Date().toISOString();
  const safePrompt = (originalPrompt || '').replace(/"/g, '\\"').slice(0, 300);
  const shortTitle = (originalPrompt || '').split(/\s+/).slice(0, 6).join(' ');
  const skillPlanB64 = Buffer.from(JSON.stringify(skillPlan)).toString('base64');

  const lines = [
    '---',
    `id: ${planId}`,
    `created: ${now}`,
    `status: pending`,
    `original_prompt: "${safePrompt}"`,
    `session_id: ${sessionId || 'unknown'}`,
    `skill_plan: true`,
    `skill_plan_json: '${skillPlanB64}'`,
    '---',
    '',
    `# Plan: ${shortTitle}`,
    '',
    '## Steps',
    '',
  ];

  skillPlan.forEach((step, i) => {
    const num = i + 1;
    const desc = step.description || buildStepDescription(step);
    lines.push(`### Step ${num} — ${desc}`);
    lines.push(`- **Skill**: ${step.skill}`);
    if (step.args) {
      const argsStr = JSON.stringify(step.args, null, 0).slice(0, 200);
      lines.push(`- **Args**: \`${argsStr}\``);
    }
    lines.push(`- **Status**: ⬜ pending`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Build a human-readable description for a plan step.
 * e.g. { skill: 'browser.act', args: { action: 'navigate', url: 'https://www.perplexity.ai', sessionId: 'perplexity' } }
 * → "browser.act — navigate (perplexity)"
 */
function buildStepDescription(step) {
  const { skill, args = {} } = step;
  if (skill === 'browser.act') {
    const action = args.action || '';
    const session = args.sessionId || '';
    const urlHost = args.url ? (() => { try { return new URL(args.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })() : '';
    const label = session || urlHost;
    return label ? `browser.act — ${action} (${label})` : `browser.act — ${action}`;
  }
  if (skill === 'shell.run') {
    const cmd = args.cmd || args.command || '';
    const argv0 = Array.isArray(args.argv) ? args.argv[0] : '';
    return cmd ? `shell.run — ${cmd}${argv0 ? ' ' + argv0 : ''}` : 'shell.run';
  }
  if (skill === 'synthesize') {
    const p = (args.prompt || '').slice(0, 40);
    return p ? `synthesize — ${p}…` : 'synthesize';
  }
  if (skill === 'external.skill') return `external.skill — ${args.name || ''}`;
  if (skill === 'guide.step') return `guide.step — ${(args.instruction || '').slice(0, 40)}`;
  return skill;
}

function loadSystemPrompt() {
  const path = require('path');
  const isWindows = process.platform === 'win32';
  const isAgentBrowser = process.env.THINKDROP_CLI_DRIVER === 'agentbrowser';
  const promptFile = isAgentBrowser ? 'plan-skills-agentbrowser.md' : (isWindows ? 'plan-skills-windows.md' : 'plan-skills.md');
  const promptPath = path.join(__dirname, '../prompts', promptFile);
  try {
    return fs.readFileSync(promptPath, 'utf8').trim();
  } catch (_) {
    // Fallback to macOS prompt if platform-specific file missing
    try {
      return fs.readFileSync(path.join(__dirname, '../prompts/plan-skills.md'), 'utf8').trim();
    } catch (__) {
      return null;
    }
  }
}

const SKILL_SYSTEM_PROMPT_FALLBACK = `You are an automation planner. Convert the user's request into an ordered list of skill steps.

Available skills: shell.run, browser.act, ui.axClick, ui.moveMouse, ui.click, ui.typeText, ui.waitFor, api_suggest, guide.step, needs_install

shell.run|args:{cmd,argv[],cwd?,timeoutMs?,dryRun?,stdin?}
browser.act|args:{action,url?,selector?,text?,sessionId?,timeoutMs?}
ui.axClick|args:{app,label,role?,button?,settleMs?,timeoutMs?}|clicks_native_app_element_via_OS_accessibility_API
ui.moveMouse|args:{label,settleMs?,confidence?,timeoutMs?}|OmniParser_LAST_RESORT_only
ui.click|args:{button?,modifier?,x?,y?,settleMs?}|use_after_ui.moveMouse
ui.typeText|args:{text,delayMs?}|tokens:{ENTER}{TAB}{ESC}{CMD+K}{CMD+C}{CMD+V}{BACKSPACE}{UP}{DOWN}
ui.waitFor|args:{condition,value?,timeoutMs?}|conditions:text,app,url,windowTitle

Priority: shell.run > browser.act > keyboard shortcuts (ui.typeText) > ui.axClick (native only) > ui.moveMouse+ui.click (last resort).
ui.findAndClick does NOT exist — never use it.
ui.axClick ONLY works for true native macOS apps (TextEdit, Calendar, Finder, Mail, Safari). It does NOT work for Electron apps (Slack, Discord, VS Code, Cursor, Figma) — use keyboard shortcuts instead.
For Slack: always use osascript activate + {CMD+K} + type + {DOWN}{ENTER}. Never use ui.axClick for Slack.
For dropdown/switcher results after typing: use {DOWN} then {ENTER}, never any click skill.
After switch                                                                                          ing Slack workspace with {ENTER}, always add ui.waitFor + osascript activate before the next {CMD+K}.
api_suggest: use as FIRST step when task is RECURRING or programmatic AND the service has an API. Almost all SaaS/cloud services have APIs (Slack, Gmail, Discord, Notion, GitHub, Twilio, n8n, Stripe, Zapier, OpenAI, etc.). Do NOT use for one-off tasks.
guide.step: use for ANY task where the user must act manually step by step (government sites, DMV, forms, license renewal, API token setup, CAPTCHAs, login walls). MANDATORY pattern: browser.act navigate URL (sessionId) → browser.act highlight (label, instruction, sessionId) → guide.step (instruction, sessionId) → repeat highlight+guide.step for each step. Playwright opens a VISIBLE Chrome Testing window. highlight injects glow + speech bubble; guide.step polls window.__tdGuideTriggered and auto-advances when user clicks highlighted element. sessionId is REQUIRED in guide.step.
Policy: no sudo/su/passwd. argv is string[] — no shell interpolation.
Output ONLY a valid JSON array. No explanation, no markdown fences.
For synthesize steps: keep prompt strings UNDER 200 chars. If the prompt needs to be longer, write "{{EXPAND:<brief intent>}}" (e.g. "{{EXPAND:write skill.md for github from crawled docs}}") and the system will expand it in a follow-up call.
If the request cannot be safely automated, output: { "error": "explain why it cannot be done" }`;

module.exports = async function planSkills(state) {
  const SKILL_SYSTEM_PROMPT = loadSystemPrompt() || SKILL_SYSTEM_PROMPT_FALLBACK;
  const {
    mcpAdapter,
    llmBackend,
    useOnlineMode = false,
    message,
    resolvedMessage,
    intent,
    context,
    recoveryContext,
    conversationHistory = [],
    activeBrowserSessionId = null,
    activeBrowserPageElements = null,
    completedGuideSteps = [],
    profileContext = null,
    domainTags = null,
    chosenService = null
  } = state;

  const logger = state.logger || console;
  const progressCallback = state.progressCallback || null;
  // Prepend _dataPrefix (injected by multi-intent queue runner) when a prior step's result
  // needs to be visible to the LLM planner (e.g. memory retrieved in step 0 informs step 1).
  // If _dataFile is set, append a note pointing to the full-content buffer file.
  const _dataFileSuffix = state._dataFile
    ? `\n[Full content available at: ${state._dataFile} — read with fs.readFileSync if needed]`
    : '';
  const userMessage = (state._dataPrefix ? state._dataPrefix + '\n' : '') + (resolvedMessage || message) + _dataFileSuffix;

  // ── Project skill plan passthrough ────────────────────────────────────────
  // If parseIntent already classified this as a project command and set projectSkillPlan,
  // use it directly and skip all LLM planning.
  if (state.projectSkillPlan && Array.isArray(state.projectSkillPlan) && state.projectSkillPlan.length > 0) {
    logger.info(`[Node:PlanSkills] Using project skill plan from parseIntent: ${state.projectSkillPlan[0].skill}`);
    if (progressCallback) {
      progressCallback({ 
        type: 'plan_ready', 
        steps: state.projectSkillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })), 
        intent: 'command_automate' 
      });
    }
    return { 
      ...state, 
      skillPlan: state.projectSkillPlan, 
      skillCursor: 0, 
      planError: null, 
      recoveryContext: null 
    };
  }

  if (intent?.type !== 'command_automate') {
    return state;
  }

  // ── Pre-approved skill plan fast-path: skip all LLM planning ─────────────────
  // When main.js re-enqueues after user approval, _skillPlan contains the already-
  // generated step array. Copy to skillPlan and hand off to executeCommand directly.
  if (state._skillPlan && Array.isArray(state._skillPlan) && state._skillPlan.length > 0) {
    logger.info(`[Node:PlanSkills] _skillPlan pre-built — skipping LLM planning (${state._skillPlan.length} steps)`);
    const prebuiltPlan = state._skillPlan;
    // Emit plan_ready so AutomationProgress initialises its step list.
    // PlanPanel ignores plan_ready (it only handles plan: prefixed events), so this is safe
    // for both ASK_USER recovery re-runs and PlanPanel-approved plan re-runs.
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: prebuiltPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || s.args?.task || s.skill, args: s.args })) });
    return { ...state, skillPlan: prebuiltPlan, skillCursor: 0, _skillPlan: null, recoveryContext: null, planError: null };
  }

  // ── Login resume: skip replanning, return existing plan as-is ────────────────
  // When the user confirmed a login (resumeFromLogin=true), the existing skillPlan
  // is still valid — just continue from skillCursor. No LLM call needed.
  if (state.resumeFromLogin && Array.isArray(state.skillPlan) && state.skillPlan.length > 0) {
    logger.info(`[Node:PlanSkills] resumeFromLogin=true — skipping replan, resuming existing plan at step ${state.skillCursor + 1}/${state.skillPlan.length}`);
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: state.skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })) });
    return { ...state, resumeFromLogin: false };
  }

  // ── Creator shortcut: skill was already built by creatorPlanning ─────────────
  // If creatorPlanning ran successfully and skillCreator produced a .skill.cjs,
  // skip all LLM planning — the skill IS the plan. Return a single external.skill
  // step so executeCommand runs it directly with no confirm-build prompt.
  // Exception: when evaluateSkills flagged a FIX (the skill was wrong for the task),
  // skip the fast-path so the LLM can replan with the stored fix context_rule.
  if (state.creatorSkillName && state.creatorSkillPath && !state.evaluationFix) {
    const fs = require('fs');
    if (fs.existsSync(state.creatorSkillPath)) {
      const buildOnly = state.gatheredContext?.buildOnly === true;
      logger.info(`[Node:PlanSkills] Creator skill ready — ${buildOnly ? 'build-only setup, not auto-executing' : `running "${state.creatorSkillName}" directly`}`);
      const secretKeys = Array.isArray(state.creatorSkillSecrets) ? state.creatorSkillSecrets : [];

      // ── Credential gate: collect missing secrets before running ─────────────
      // If the skill requires API credentials that are not yet in keytar, prompt
      // for them now. This prevents the skill from auto-executing with missing creds.
      const gatherCredentialCallback = state.gatherCredentialCallback || null;
      const keytarCheckCallback      = state.keytarCheckCallback      || null;
      if (secretKeys.length > 0 && gatherCredentialCallback) {
        const skillName = state.creatorSkillName;
        for (const secretKey of secretKeys) {
          // Check if this secret already exists in keytar
          let alreadyStored = false;
          if (keytarCheckCallback) {
            try {
              const checkResult = await keytarCheckCallback(secretKey);
              alreadyStored = checkResult?.found === true;
            } catch (_) {}
          }
          if (!alreadyStored) {
            logger.info(`[Node:PlanSkills] Skill "${skillName}" needs credential "${secretKey}" — prompting user before execution`);
            // Emit gather_credential so the UI shows the masked input card
            if (progressCallback) progressCallback({
              type: 'gather_credential',
              credentialKey: secretKey,
              question: `Enter your ${secretKey} for the "${skillName}" skill`,
              hint: `This will be stored securely in your keychain`,
              helpUrl: null,
            });
            try {
              const credResult = await gatherCredentialCallback(secretKey);
              if (credResult?.stored) {
                logger.info(`[Node:PlanSkills] Credential "${secretKey}" stored for "${skillName}"`);
                if (progressCallback) progressCallback({ type: 'gather_credential_stored', credentialKey: secretKey });
              } else {
                logger.warn(`[Node:PlanSkills] Credential "${secretKey}" was not stored (user skipped or timed out)`);
              }
            } catch (credErr) {
              logger.warn(`[Node:PlanSkills] Credential prompt for "${secretKey}" failed/skipped: ${credErr?.message}`);
            }
          }
        }
      }
      // ── End credential gate ──────────────────────────────────────────────────

      // Build-only: user set up the skill (e.g. "I need to send text messages from here")
      // but didn't ask to run it right now. Tell them it's ready and stop.
      if (buildOnly) {
        const readyMsg = `Skill "${state.creatorSkillName}" is set up and ready. Just say something like "send a text to [number] saying [message]" to use it.`;
        logger.info(`[Node:PlanSkills] Build-only — skill ready, not executing: "${state.creatorSkillName}"`);
        if (progressCallback) progressCallback({ type: 'skill_setup_complete', skillName: state.creatorSkillName, message: readyMsg });
        return {
          ...state,
          skillPlan: [],
          skillCursor: 0,
          commandExecuted: true,
          answer: readyMsg,
          recoveryContext: null,
          planError: null,
        };
      }

      const skillPlan = [{
        skill: 'external.skill',
        args:  { name: state.creatorSkillName, secretKeys },
        description: `Run "${state.creatorSkillName}" (built by creator.agent)`,
      }];
      if (progressCallback) progressCallback({ type: 'plan_ready', steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })) });
      return { ...state, skillPlan, skillCursor: 0, recoveryContext: null, planError: null };
    }
    logger.warn(`[Node:PlanSkills] Creator skill file missing at "${state.creatorSkillPath}" — falling through to LLM plan with name constraint`);
  }

  // ── Constraint gate ─────────────────────────────────────────────────────────
  // Before invoking the LLM, check stored user_constraints against the raw
  // message.  Use mcpAdapter (handles auth + MCP envelope) not raw HTTP.
  // No verb-to-pattern mapping needed here — that's the constraint service's job.
  try {
    // Derive minimal action pattern hints from the message verb so pattern-based
    // matching works alongside text-keyword matching in the constraint service.
    const _actionHints = (() => {
      const v = (userMessage || '').toLowerCase();
      if (/\bdelete\b|\btrashe?s?\b|\brm\b|\bunlink\b|\berase\b|\bwipe\b/.test(v)) return ['delete.*', 'shell.fs.*', 'shell.run.*'];
      if (/\bsend\b|\bpost\b|\bpublish\b|\bshare\b|\bupload\b/.test(v))           return ['send.*', 'post.*', 'share.*', 'publish.*'];
      if (/\binstall\b|\bsetup\b|\bexecute\b|\brun\b|\blaunch\b/.test(v))         return ['shell.run.*', 'install.*'];
      return [];
    })();

    // Try to extract an explicit PIN from the message (for PIN-protected constraints).
    // Only matches deliberate "secret/pin/password/code ABC123" patterns — not random words.
    const _pinAttempt = (() => {
      const m = (userMessage || '').match(/\b(?:secret|pin|password|code)\s*[:\s]+([A-Z0-9]{3,20})\b/i);
      return m ? m[1].toUpperCase() : null;
    })();

    const _constraintCheck = await mcpAdapter.callService(
      'user-memory',
      'constraint.check',
      { message: userMessage, actionPatterns: _actionHints, pinAttempt: _pinAttempt },
      { timeoutMs: 2000 }
    ).catch(() => null);

    const _hardBlocks = _constraintCheck?.data?.hardBlocks || [];
    const _pinProtectedBlocks = _constraintCheck?.data?.pinProtectedBlocks || [];
    if (_hardBlocks.length > 0) {
      logger.info(`[Node:PlanSkills] Hard constraint blocked: ${_hardBlocks[0]}`);

      // Signal 3 — constraint gate mismatch: the message was classified as command_automate
      // but a stored constraint blocked it, meaning it should have been set_constraint.
      // Write a correction so intent_override.search catches this phrasing next time,
      // before phi4 ever runs. Fire-and-forget — never block the deny response on this write.
      if (state.intent?.type === 'command_automate' && mcpAdapter) {
        mcpAdapter.callService('user-memory', 'intent_override.upsert', {
          examplePrompt: userMessage,
          correctIntent: 'set_constraint',
          wrongIntent: 'command_automate',
          source: 'constraint_gate_mismatch'
        }).catch(() => {});
        logger.debug(`[Node:PlanSkills] Signal 3: constraint-gate mismatch recorded for "${userMessage?.slice(0, 60)}"`);
      }

      // Build deny prompt — if the block is PIN-protected, give the user a hint
      const _isPinProtectedDeny = _pinProtectedBlocks.includes(_hardBlocks[0]);
      const _pinHint = _isPinProtectedDeny
        ? `\n\nThis rule is PIN-protected. If you know the secret, include it in your message (e.g. say your original request followed by "secret ABC123") to proceed.`
        : '';

      const _denyStep = {
        skill: 'synthesize',
        args: {
          prompt: `The user asked: "${userMessage}"\n\nThis was blocked by their configured rule: "${_hardBlocks[0]}"${_pinHint}\n\nRespond naturally: explain the action is blocked by their own safety rule. Keep it brief.`,
        },
        description: 'Explain constraint block',
      };
      if (progressCallback) progressCallback({ type: 'plan_ready', steps: [{ index: 0, skill: 'synthesize', description: _denyStep.description, args: _denyStep.args }] });
      return { ...state, skillPlan: [_denyStep], skillCursor: 0, recoveryContext: null, planError: null };
    }
  } catch (_constraintGateErr) {
    logger.warn('[Node:PlanSkills] Constraint gate error:', _constraintGateErr?.message);
  }
  // ── End constraint gate ──────────────────────────────────────────────────────

  // ── Existing plan similarity check ───────────────────────────────────────────
  // Before invoking the LLM, check for a previously completed identical/similar plan.
  // Only offers reuse when the plan ran 100% successfully (status: complete).
  // Guards: skip when replanning after failure, multi-intent queue, or _forceNewPlan.
  if (!recoveryContext && !state.isMultiIntent && !state._forceNewPlan) {
    const similarPlan = findSimilarCompletePlan(userMessage, logger);
    if (similarPlan) {
      const skillPlanB64 = Buffer.from(JSON.stringify(similarPlan.skillPlan)).toString('base64');
      if (progressCallback) {
        let existingContent = '';
        try { existingContent = fs.readFileSync(similarPlan.planFile, 'utf8'); } catch (_) {}
        progressCallback({
          type: 'plan:found_existing',
          planFile: similarPlan.planFile,
          title: similarPlan.title,
          file: similarPlan.file,
          similarity: similarPlan.similarity,
          content: existingContent,
          skillPlanJson: skillPlanB64,
        });
      }
      return {
        ...state,
        awaitingPlanApproval: true,
        _skillPlanFile: similarPlan.planFile,
        skillPlan: null,
        skillCursor: 0,
        recoveryContext: null,
        planError: null,
      };
    }
  }

  logger.debug('[Node:PlanSkills] Planning skill steps...');
  if (progressCallback) progressCallback({ type: 'planning', message: 'Generating skill plan...' });

  // ── Resolve LLM backend ──────────────────────────────────────────────────────
  const backend = llmBackend;

  if (!backend) {
    logger.warn('[Node:PlanSkills] No llmBackend in state — cannot plan skills');
    return {
      ...state,
      planError: 'No LLM backend available for skill planning'
    };
  }

  const os = process.platform;

  // ── Creator planning context (injected by creatorPlanning node) ────────────
  // When creator.agent ran before us, inject its structured plan.md + agents.md
  // so the LLM skill planner has a richer, pre-validated architecture to work from.
  const creatorPlanMd   = state.creatorPlanMd   || null;
  const creatorAgentsMd = state.creatorAgentsMd || null;
  const creatorBddTests = state.creatorBddTests || null;
  let creatorContextNote = '';
  if (creatorPlanMd || creatorAgentsMd) {
    const parts = [];
    if (creatorPlanMd)   parts.push('## Project Plan (from creator.agent)\n' + creatorPlanMd.slice(0, 2000));
    if (creatorAgentsMd) parts.push('## Agent Specs (from creator.agent)\n' + creatorAgentsMd.slice(0, 1500));
    if (creatorBddTests) parts.push('## BDD Acceptance Tests\n' + creatorBddTests.slice(0, 800));
    creatorContextNote = '\n\nCREATOR PLAN CONTEXT (pre-validated architecture — use this to inform your skill plan):\n' + parts.join('\n\n');
    logger.info('[Node:PlanSkills] Creator context injected', { planLen: creatorPlanMd?.length, agentsLen: creatorAgentsMd?.length });
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/Users/unknown';

  // Build recovery context suffix if re-planning after failure
  let recoveryNote = '';
  if (recoveryContext) {
    recoveryNote = `

RECOVERY CONTEXT (previous attempt failed — DO NOT repeat the same plan):
- Failed step: ${recoveryContext.failedSkill} (step ${recoveryContext.failedStep})
- Failure reason: ${recoveryContext.failureReason}
- Actual URL reached: ${recoveryContext.actualUrl || 'unknown'}
- Suggestion: ${recoveryContext.suggestion}
- Constraint: ${recoveryContext.constraint || 'none'}
${recoveryContext.alternativeCwd ? `- Use cwd: "${recoveryContext.alternativeCwd}" instead` : ''}
You MUST produce a DIFFERENT plan than the one that just failed. Use the actual URL above to understand what page is currently loaded. If the search failed, try a different selector, use examine first to identify the correct input, or navigate to a specific search URL directly.`;
  }

  // Build prior results context so LLM can resolve references like "that file"
  const skillResults = state.skillResults || [];
  let priorResultsNote = '';
  if (skillResults.length > 0) {
    const resultLines = skillResults
      .filter(r => r.ok && r.stdout && r.stdout.trim())
      .map(r => {
        const lines = r.stdout.trim().split('\n');
        // For fs.read results — include ALL lines so LLM gets every real filename
        const isFs = r.skill === 'fs.read';
        const snippet = isFs ? lines.join('\n') : lines.slice(0, 3).join('; ');
        return `- ${r.skill || 'shell.run'} output:\n${snippet}`;
      });
    if (resultLines.length > 0) {
      // Check if any fs.read result is present — add strong instruction to use real paths
      const hasFsRead = skillResults.some(r => r.skill === 'fs.read' && r.ok);
      const fsNote = hasFsRead
        ? '\nIMPORTANT: The fs.read result above contains the EXACT file paths in the folder. Use ONLY these real paths in image.analyze steps — do NOT invent placeholder names like image1.png, image2.png. Each image.analyze step must use ONE real path string (not an array).'
        : '';
      priorResultsNote = `\n\nPREVIOUS STEP RESULTS (use these to resolve references like "that file", "it", "the result"):${fsNote}\n${resultLines.join('\n')}`;
    }
  }

  // Build conversation history context so LLM can resolve cross-turn references
  // e.g. "that file", "add more to it" when the file path was mentioned in a prior turn
  let conversationNote = '';
  let priorSynthesizedContent = '';
  let cacheShortCircuitNote = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const recentTurns = conversationHistory.slice(-6); // last 3 exchanges

    // System event messages (skill deletions, capability changes) are surfaced
    // separately and given highest priority — the LLM must treat these as facts,
    // not as prior chat context.  Pull them from the full history (not just recent).
    const systemEvents = conversationHistory
      .filter(m => m.role === 'system' || m.sender === 'system')
      .slice(-5); // last 5 system events

    let systemNote = '';
    if (systemEvents.length > 0) {
      const eventLines = systemEvents.map(m => `  • ${(m.content || m.text || '').trim()}`);
      systemNote = `\n\n⚠️ SYSTEM EVENTS (treat as current facts — highest priority):\n${eventLines.join('\n')}`;
    }

    const turnLines = recentTurns
      .filter(m => (m.role !== 'system' && m.sender !== 'system') && m.content && m.content.trim())
      .map(m => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = m.content.trim();
        // Assistant messages with step outputs (from logConversation richAssistantText)
        // contain critical filenames/paths — include up to 2000 chars for those.
        // User messages: 300 chars is plenty.
        const limit = (m.role === 'assistant' && content.includes('Step outputs:')) ? 2000 : 300;
        return `${role}: ${content.substring(0, limit)}`;
      });
    if (turnLines.length > 0 || systemNote) {
      conversationNote = `${systemNote}\n\nRECENT CONVERSATION (use this to resolve references like "that file", "it", "the result"):\n${turnLines.join('\n')}`;
    }

    // Extract the last synthesized answer from conversation history so that
    // follow-up messaging tasks ("text this to me", "email this info") use the
    // actual prior content as the message body — not a placeholder.
    // IMPORTANT: scan ALL recent assistant messages for a [synthesize]: section, not just
    // the last one. Example scenario: gcal query → failed SMS attempt → user resumes with
    // phone number. The last assistant message is the SMS error (no [synthesize]:) so a
    // naive lastMsg search would inject the error JSON as the message body instead of the
    // calendar synthesis from 2 turns earlier.
    // [DEBUG DIAG] Remove after BODY fix confirmed — confirms whether [synthesize]: is in history
    logger.info(`[Node:PlanSkills] priorBody scan: history=${conversationHistory.length} recent=${recentTurns.length} asst=[${recentTurns.filter(m=>m.role==='assistant').map(m=>(m.content||'').slice(0,120).replace(/\n/g,'↵')).join(' || ')}]`);
    const lastSynthMsg = recentTurns.slice().reverse().find(m =>
      m.role === 'assistant' && m.content?.includes('[synthesize]:'));
    if (lastSynthMsg?.content) {
      const stepOutputsIdx = lastSynthMsg.content.indexOf('Step outputs:');
      if (stepOutputsIdx !== -1) {
        const stepOutputsContent = lastSynthMsg.content.slice(stepOutputsIdx + 'Step outputs:'.length).trim();
        const synthSectionMatch = stepOutputsContent.match(/\[synthesize\]:\n([\s\S]+?)(?=\n\[|$)/);
        if (synthSectionMatch) {
          priorSynthesizedContent = synthSectionMatch[1].trim().slice(0, 2000);
        }
      }
    } else {
      // Fallback: no [synthesize]: found anywhere in recent history — use last assistant
      // step outputs (raw shell/API output). Better than nothing for non-synthesized results.
      const lastAssistantMsg = recentTurns.slice().reverse().find(m => m.role === 'assistant');
      if (lastAssistantMsg?.content) {
        const stepOutputsIdx = lastAssistantMsg.content.indexOf('Step outputs:');
        if (stepOutputsIdx !== -1) {
          const stepOutputsContent = lastAssistantMsg.content.slice(stepOutputsIdx + 'Step outputs:'.length).trim();
          priorSynthesizedContent = stepOutputsContent.slice(0, 2000);
        }
      }
      // Last-resort: no 'Step outputs:' section either — the prior answer itself may be the body.
      // Handles: gcal query stored without Step outputs: when skillResults was empty.
      if (!priorSynthesizedContent && lastAssistantMsg?.content) {
        const _rawPrior = lastAssistantMsg.content.trim();
        if (_rawPrior.length > 50 && !/^(error|failed|sorry|i couldn)/i.test(_rawPrior)) {
          priorSynthesizedContent = _rawPrior.slice(0, 2000);
        }
      }
    }

    // ── Prior synthesis cache short-circuit note ─────────────────────────────
    // When freshly synthesized data exists in recent history (< 30 min), tell
    // the planner it MAY skip redundant browser.agent scraping steps and use
    // the cached synthesis directly. The LLM decides semantic relevance.
    if (priorSynthesizedContent && lastSynthMsg?.timestamp) {
      const _cacheAgeMs = Date.now() - new Date(lastSynthMsg.timestamp).getTime();
      const _cacheAgeMin = Math.round(_cacheAgeMs / 60000);
      const _CACHE_TTL_MIN = 360; // 6 hours
      if (_cacheAgeMin < _CACHE_TTL_MIN) {
        const _cachePreview = priorSynthesizedContent.slice(0, 1500).replace(/\n/g, ' ');
        const _cacheAgeLabel = _cacheAgeMin < 60 ? `${_cacheAgeMin} min ago` : `${Math.round(_cacheAgeMin / 60 * 10) / 10} hr ago`;
        cacheShortCircuitNote = `\n\n💾 PRIOR SYNTHESIS CACHE (${_cacheAgeLabel}):\nThe following data was synthesized ${_cacheAgeLabel} from browser agent results for a prior run:\n---\n${_cachePreview}${priorSynthesizedContent.length > 1500 ? '...(truncated)' : ''}\n---\nINSTRUCTION: If the cached content above clearly covers the data needed for the CURRENT request (same topic, same entities, same scope), you MAY replace browser.agent scraping steps with a synthesize step whose description starts with "[cached]". The synthesize engine will automatically use this cached content. Only skip browser.agent steps when the cache is clearly applicable — do NOT skip when the user explicitly asks for a fresh lookup, live data, news, real-time info, or when the topic differs materially.`;
        logger.info(`[Node:PlanSkills] Cache short-circuit available: ${_cacheAgeLabel} old, ${priorSynthesizedContent.length} chars`);

        // ── Service mismatch guard ─────────────────────────────────────────────
        // If the user explicitly names AI services (Grok, Qwen, etc.) that differ
        // from what appears in the cached content (ChatGPT, Gemini, etc.), the
        // cache is NOT applicable for agent selection. Append a hard warning so
        // the LLM cannot silently inherit the wrong agent IDs from prior context.
        const _AI_SERVICES = [
          'chatgpt', 'gemini', 'grok', 'claude', 'qwen', 'deepseek',
          'perplexity', 'mistral', 'llama', 'cohere', 'copilot', 'openai',
          'bing', 'bingchat', 'you', 'phind', 'poe', 'together',
        ];
        const _userServices  = _AI_SERVICES.filter(s => new RegExp(`\\b${s}\\b`, 'i').test(userMessage));
        const _cacheServices = _AI_SERVICES.filter(s => new RegExp(`\\b${s}\\b`, 'i').test(priorSynthesizedContent));
        const _mismatchedServices = _userServices.filter(s => !_cacheServices.includes(s));
        if (_userServices.length > 0 && _mismatchedServices.length > 0) {
          const _requiredAgents = _userServices.map(s => `${s}.agent`).join(', ');
          cacheShortCircuitNote += `\n\n⚠️ SERVICE MISMATCH — CACHE NOT APPLICABLE FOR AGENT SELECTION:\nThe user explicitly named: ${_userServices.join(', ')}. The cached data is from: ${_cacheServices.length > 0 ? _cacheServices.join(', ') : 'different services'}. These are DIFFERENT services — do NOT inherit agent IDs from the cache. You MUST plan fresh browser.agent steps using: ${_requiredAgents}. The cache content above is irrelevant for choosing which agents to call.`;
          logger.info(`[Node:PlanSkills] Service mismatch detected: user=[${_userServices.join(',')}] cache=[${_cacheServices.join(',')}] — cache note flagged as non-applicable`);
        }
      }
    }
  }

  // ── Messaging body injection ─────────────────────────────────────────────────
  // When the user says "text this info to me", "email this to my phone", etc.,
  // the LLM has no idea what "this info" is unless we explicitly provide it.
  // Inject the prior synthesized content as the EXACT message body to send.
  let messagingBodyNote = '';
  const isMessagingTask = /^(text|send|email|message|forward|share|ping|tell|notify)/i.test(userMessage.trim()) ||
    /\b(text|sms|send.*message|email.*me|message.*me)\b/i.test(userMessage);
  if (isMessagingTask && priorSynthesizedContent) {
    // Sanitize: if the prior content is a raw JSON fallback (from the synthesis apology
    // path), extract a human-readable summary from the calendar/API items so we don't
    // inject broken JSON as a message body.
    let _sanitizedBody = priorSynthesizedContent;
    if (/^here is the raw data returned/i.test(_sanitizedBody.trim()) ||
        /^\[shell\.run\]:\s*[\[{]/m.test(_sanitizedBody)) {
      // Try to parse calendar events out of any embedded JSON and format them as plain text
      const _jsonMatch = _sanitizedBody.match(/```json\n([\s\S]*?)\n```/) ||
                         _sanitizedBody.match(/\[shell\.run\]:\n*([\s\S]+)/);
      if (_jsonMatch) {
        try {
          const _parsed = JSON.parse(_jsonMatch[1].trim());
          const _items = Array.isArray(_parsed) ? _parsed : (_parsed?.items || []);
          if (_items.length > 0) {
            const _lines = _items.map(item => {
              const start = item.start?.dateTime || item.start?.date || '';
              const title = item.summary || item.title || 'Untitled';
              if (start) {
                const d = new Date(start);
                const timeStr = !isNaN(d.getTime())
                  ? d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                  : start;
                return `• ${title} at ${timeStr}`;
              }
              return `• ${title}`;
            }).join('\n');
            _sanitizedBody = `Today's calendar events:\n${_lines}`;
            logger.info('[Node:PlanSkills] Sanitized raw JSON fallback to plain text for messaging body');
          }
        } catch (_) {}
      }
    }
    messagingBodyNote = `\n\n⚠️ MESSAGE BODY — CRITICAL:\nThe user said "${userMessage}". The content they want sent is from the PREVIOUS task. Use this EXACT content as the message body (do not summarize or replace with a placeholder):\n---\n${_sanitizedBody}\n---\nIMPORTANT: Use this text as the message body string. When building a JSON payload in a shell command, ALWAYS use jq to safely encode the body to avoid escaping errors (example: \`jq -n --arg body "$MSG" --arg to "+15551234567" '{"messages":[{"source":"sdk","body":$body,"to":$to}]}'\`). Never embed raw text or JSON objects directly inside a shell string literal.`;
    logger.info('[Node:PlanSkills] Injected prior synthesized content as messaging body');
  }

  // ── Close/quit file context injection ────────────────────────────────────────
  // When the user says "close it", "close this", "close the file", etc., use the
  // lastOpenedFilePath tracked explicitly by executeCommand (set when `open` succeeds).
  // This is authoritative — no pattern matching or extension guessing.
  let closeFileContextNote = '';
  const isCloseVerbTask = /^(close|quit|exit|hide|minimize|stop)\b/i.test(userMessage.trim());
  const lastOpenedFilePath = state.lastOpenedFilePath || null;
  if (isCloseVerbTask && lastOpenedFilePath) {
    const _closePath = require('path');
    const openedFileName = _closePath.basename(lastOpenedFilePath);
    const openedExt = _closePath.extname(lastOpenedFilePath).toLowerCase();
    const openedStem = _closePath.basename(openedFileName, openedExt);
    closeFileContextNote = `\n\n⚠️ CLOSE TARGET — CRITICAL:\nThe user recently opened "${openedFileName}" (${lastOpenedFilePath}). "${userMessage}" means close that file.\nUse osascript to close it by document name in the app that owns it (use \`mdls -name kMDItemLastUsedApp "${lastOpenedFilePath}"\` to find the app if unknown, or infer from extension).\nDo NOT close Terminal, Warp, browser, or any other unrelated app. Target only the file "${openedStem}".`;
    logger.info(`[Node:PlanSkills] Injected close-file context from state: "${lastOpenedFilePath}"`);
  }

  // If there's an active browser session from a prior task, tell the LLM to reuse it
  // Also inject real scanned elements so the LLM plans with exact labels — no guessing.
  let browserSessionNote = '';
  if (activeBrowserSessionId) {
    const activeUrl = state.activeBrowserUrl || null;
    const activeUrlNote = activeUrl ? ` Currently on: ${activeUrl}.` : '';
    browserSessionNote = `\n\nACTIVE BROWSER SESSION: sessionId="${activeBrowserSessionId}" is already open.${activeUrlNote} Use this EXACT sessionId for all browser.act steps. If the task targets a DIFFERENT website than the current URL, include a browser.act navigate step first. If the task is a follow-up on the SAME site, skip navigate.`;
    if (activeBrowserPageElements?.elements?.length > 0) {
      const elList = activeBrowserPageElements.elements
        .slice(0, 60)
        .map(e => `  - [${e.ref || ''}] ${e.tag} "${e.label}"${e.href ? ` → ${e.href}` : ''}`)
        .join('\n');
      const hasRefs = activeBrowserPageElements.elements.some(e => e.ref);
      browserSessionNote += `\n\nCURRENT PAGE ELEMENTS (${activeBrowserPageElements.url}):\n${hasRefs ? 'Use the [eN] ref as the selector value for click/fill/hover — do NOT use the label text as selector when a ref is provided. Skip examine steps — refs are already known.' : 'Use ONLY these exact labels as selectors — do not invent labels.'}\n${elList}`;
    }
  }

  // Include any tagged context (highlighted text or [File: /path] tags from Shift+Cmd+C)
  const selectedText = state.selectedText || '';
  let taggedContextNote = '';
  if (selectedText && selectedText.trim()) {
    taggedContextNote = `\n\nTAGGED CONTEXT (user highlighted this before asking):\n${selectedText.trim()}\n\nIf the tagged context contains a [File: /path/to/file] tag, the user is referring to that file. Plan steps to read it using the appropriate command for its file type (see skill rules).`;
  }

  // Inject resolved personal profile facts (phone numbers, names, addresses) from enrichIntent
  let profileContextNote = '';
  if (profileContext?.facts?.length > 0) {
    const factLines = profileContext.facts.map(f => {
      if (f.field === 'my_phone') return `- User's phone number: ${f.value} — use this as the "to" number for ANY SMS/text step. NEVER use a placeholder like +1234567890.`;
      if (f.field === 'my_email') return `- User's email: ${f.value} — use this as the recipient for any email step.`;
      return `- ${f.field}: ${f.value}`;
    }).join('\n');
    profileContextNote = `\n\n⚠️ USER PROFILE — MANDATORY (never substitute placeholders):\n${factLines}`;
    logger.info(`[Node:PlanSkills] Injecting ${profileContext.facts.length} profile fact(s) into planning query`);
  }

  // ── Credential intelligence pre-scan ────────────────────────────────────────
  // Detect referenced services in the user message, check credential store for
  // KEYTAR refs and user constraints (hard/soft).  Runs with a 1.5 s timeout so
  // it never blocks planning.  Raw secrets are NEVER fetched here.
  let credentialContextNote = '';
  try {
    const { gatherCredentialIntelligence } = require('../utils/credentialIntelligence');
    const credCtx = await Promise.race([
      gatherCredentialIntelligence(userMessage, { mcpAdapter }),
      new Promise(r => setTimeout(() => r(null), 1500)),
    ]);

    if (credCtx?.detectedServices?.length > 0) {
      const lines = [];

      // CLI-managed OAuth services (gh, gcloud, az, etc.) must NOT use KEYTAR
      // credential refs — they manage their own tokens internally and calling
      // `security find-generic-password` triggers macOS keychain dialogs.
      // `cliAuthServices` is populated dynamically from cli-registry.json by
      // credentialIntelligence.js, so no hardcoded service list is needed here.
      const cliAuthServices = credCtx.cliAuthServices || [];
      const cliManagedNames = new Set(cliAuthServices.map(s => s.service));

      const displayableCreds = credCtx.availableCredentials.filter(
        c => !cliManagedNames.has(c.service)
      );

      if (displayableCreds.length > 0) {
        lines.push('Available credentials (use KEYTAR refs, never hardcode secrets):');
        for (const c of displayableCreds) {
          lines.push(`  - ${c.key}: ${c.valueRef}${c.label ? ` (${c.label})` : ''}`);
        }
      }

      // For each CLI-managed OAuth service, inject the specific tokenCmd hint.
      for (const { service, tool, tokenCmd } of cliAuthServices) {
        if (tokenCmd) {
          lines.push(`${service.charAt(0).toUpperCase() + service.slice(1)} token: use \`${tokenCmd}\` — do NOT use security find-generic-password for ${service}.`);
        }
      }

      const missingServices = credCtx.detectedServices.filter(
        s => !cliManagedNames.has(s) && !credCtx.availableCredentials.some(c => c.service === s)
      );
      if (missingServices.length > 0) {
        lines.push(`Missing credentials for: ${missingServices.join(', ')} — use a needs_skill or ask_user step to obtain them before proceeding.`);
      }

      if (credCtx.hardConstraints.length > 0) {
        lines.push('\n⛔ HARD CONSTRAINTS — MUST NOT violate under any circumstances:');
        credCtx.hardConstraints.forEach(c => lines.push(`  - ${c}`));
      }

      if (credCtx.softConstraints.length > 0) {
        lines.push('\n⚠️  SOFT CONSTRAINTS — warn user and confirm before proceeding:');
        credCtx.softConstraints.forEach(c => lines.push(`  - ${c}`));
      }

      credentialContextNote = `\n\n[CREDENTIAL CONTEXT]\n${lines.join('\n')}`;
      logger.info(`[Node:PlanSkills] Injected credential context for: ${credCtx.detectedServices.join(', ')}`);
    }
  } catch (_credErr) {
    logger.debug('[Node:PlanSkills] Credential intelligence skipped:', _credErr?.message);
  }

  // ── Two-phase guide planning: scan first, plan with real elements ───────────
  // For fresh guide tasks (no active session, no existing page elements):
  //   Phase 1: Ask LLM for just the starting URL — one fast LLM call.
  //   Navigate + scan that URL — get the real interactive elements.
  //   Phase 2: Ask LLM for the full plan injecting the real element list.
  // This eliminates all label guessing on the first plan.
  let livePageElements = activeBrowserPageElements;
  let livePageUrl = state.activeBrowserUrl || null;
  // Pre-scan fires for interactive browser tasks — skip for pure content-extraction tasks.
  // Content-only tasks (research, find info, summarize, save to file) only use
  // navigate + getPageText + synthesize — no element interaction needed, so pre-scan
  // just wastes 5-10s and opens an extra Chrome window for no reason.
  const CONTENT_ONLY_TASK = /\b(find (all |the )?(info|information|details|facts|data) (about|on)|research|look up|tell me (all |everything )?about|gather (info|information|facts)|summarize|what (is|are|was|were)|who (is|was|are|were)|history of|biography|explain)\b/i;
  const PURE_LOCAL_TASK = /\b(file\.bridge|fs\.read|file\.watch|check the bridge|the bridge|bridge file|watch the|tail -f|directory listing|repo structure|npm install|git (commit|push|pull|clone|status)|python\s|bash\s|shell\s|convert (this|the) file|read (the|this) file|write (the|this) file)\b/i;
  // Service-automation tasks require a skill to be installed — they can NEVER be done
  // via browser.act. Skip pre-scan entirely so the LLM goes straight to needs_skill.
  // IMPORTANT: Only match PERSISTENT/RECURRING patterns, not one-off actions.
  // "watch my Gmail" = background daemon (needs_skill) ✓
  // "summarize this Notion page" = one-off browser task — must NOT match ✗
  // "notify Slack about this PR" = one-off API call — must NOT match ✗
  const SERVICE_AUTOMATION_TASK =
    // Pattern A: persistent monitoring verb + service (watch/monitor/poll are unambiguously background)
    /\b(watch|monitor|poll|keep checking|continuously check)\b.{0,100}\b(gmail|inbox|email|emails|mail|messages?|texts?|sms|slack|discord|telegram|whatsapp|calendar|google calendar|events?|appointments?|airtable|jira|trello|asana|linear|hubspot|salesforce)\b/i;
  // Pattern B: action verb + recurring time signal + service
  // Requires ALL THREE: an outbound-action verb (send/text/notify/...) + a recurring time word + a service name.
  // This prevents false positives like "daily standup in Slack" or "my daily calendar has a meeting".
  const SCHEDULED_SERVICE_TASK =
    /\b(send|text|notify|alert|give|deliver|forward|email)\b.{0,120}\b(every (day|night|morning|evening|week|hour)|daily|weekly|nightly|each (day|morning|night)|each week)\b.{0,120}\b(gmail|inbox|email|mail|sms|text|slack|discord|calendar|summary|digest|briefing|reminder)\b|\b(send|text|notify|alert|give|deliver|forward|email)\b.{0,60}\b(daily|weekly|nightly|every (day|night|morning|week))\b.{0,60}\b(summary|digest|briefing|reminder|update|report)\b/i;
  const isServiceAutomation = SERVICE_AUTOMATION_TASK.test(userMessage) || SCHEDULED_SERVICE_TASK.test(userMessage);
  // A task is a browser task if it mentions any URL, site name, navigation verb, or web concept
  const HAS_BROWSER_SIGNAL = /\b(https?:\/\/|\.com|\.ai|\.org|\.io|\.gov|go to|navigate|open|website|online|web|internet|search|look up|find|research|browse|perplexity|deepseek|chatgpt|claude|gemini|grok|copilot|google|youtube|github\.com|twitter|instagram|facebook|linkedin|reddit|amazon|netflix|spotify|maps|register|apply|passport|visa|dmv|form|portal|login|account|sign up|enroll|appointment|verify|lookup|renew|permit|license)\b/i;
  // Pre-scan is disabled: playwright-cli's snapshot command captures precise YAML
  // element refs (e1, e21, etc.) on-demand during execution — far better than a
  // pre-flight scan taken 30s before interaction when page state may have changed.
  // Plans use navigate → snapshot → interact with live refs at execution time.
  const isGuideTask = false;

  if (isGuideTask) {
    try {
      const available = await backend.isAvailable().catch(() => false);
      if (available) {
        // Phase 1: get starting URL only
        const urlQuery = `What is the correct starting URL for this task? Reply with ONLY a JSON object: {"url": "https://...", "sessionId": "guideSession"}
Task: "${userMessage}"`;
        const urlRaw = await backend.generateAnswer(urlQuery, {
          query: urlQuery,
          context: { systemInstructions: 'You are a URL resolver. Output only {"url":"...","sessionId":"..."}. No markdown, no explanation.', conversationHistory: [], intent: 'command_automate' },
          options: { maxTokens: 80, temperature: 0.0, fastMode: true }
        }, { maxTokens: 80, temperature: 0.0, fastMode: true }, null);

        let startUrl = null;
        let startSessionId = 'guideSession';
        try {
          const m = urlRaw.match(/\{[^}]+\}/);
          if (m) { const p = JSON.parse(m[0]); startUrl = p.url; startSessionId = p.sessionId || 'guideSession'; }
        } catch (_) {}

        if (startUrl) {
          logger.info(`[Node:PlanSkills] Two-phase guide: navigating to ${startUrl} for pre-scan`);
          if (progressCallback) progressCallback({ type: 'planning', message: 'Scanning page...' });

          // Navigate
          const navRes = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'browser.act', args: { action: 'navigate', url: startUrl, sessionId: startSessionId }
          }, { timeoutMs: 35000 }).catch(e => ({ ok: false, error: e.message }));
          const nav = navRes?.data || navRes;

          if (nav?.ok !== false) {
            // Scan
            const scanRes = await mcpAdapter.callService('command', 'command.automate', {
              skill: 'browser.act', args: { action: 'scanCurrentPage', sessionId: startSessionId }
            }, { timeoutMs: 10000 }).catch(e => ({ ok: false, error: e.message }));
            const scan = scanRes?.data || scanRes;

            if (scan?.ok && scan?.result?.elements?.length > 0) {
              livePageElements = { url: scan.result.url, elements: scan.result.elements };
              livePageUrl = scan.result.url;
              logger.info(`[Node:PlanSkills] Pre-scan: ${scan.result.elements.length} elements on ${scan.result.url}`);
              // Store the session so executeCommand knows it's already open
              state = { ...state, activeBrowserSessionId: startSessionId, activeBrowserUrl: livePageUrl, activeBrowserPageElements: livePageElements };
            }
          }
        }
      }
    } catch (preScanErr) {
      logger.warn(`[Node:PlanSkills] Pre-scan failed (non-fatal): ${preScanErr.message}`);
    }
  }

  // Rebuild browserSessionNote with live elements (may have just been populated above).
  // Filter out any elements that match already-completed guide steps so the LLM
  // doesn't re-plan steps the user already did.
  if (livePageElements?.elements?.length > 0) {
    const sid = state.activeBrowserSessionId || 'guideSession';
    const effectiveCompleted = state.completedGuideSteps || completedGuideSteps || [];
    const completedLabels = new Set(
      effectiveCompleted.map(s => s.label?.toLowerCase().trim()).filter(Boolean)
    );
    const filteredEls = livePageElements.elements.filter(e => {
      if (!e.label) return true;
      return !completedLabels.has(e.label.toLowerCase().trim());
    });
    const elList = filteredEls
      .slice(0, 60)
      .map(e => `  - [${e.ref || ''}] ${e.tag} "${e.label}"${e.href ? ` → ${e.href}` : ''}`)
      .join('\n');
    const hasRefs = filteredEls.some(e => e.ref);
    const doneNote = effectiveCompleted.length > 0
      ? `\nALREADY COMPLETED (do NOT repeat these): ${effectiveCompleted.map(s => `"${s.label}"`).join(', ')}`
      : '';
    browserSessionNote = `\n\nACTIVE BROWSER SESSION: sessionId="${sid}" is already open at ${livePageUrl}. Use this EXACT sessionId for all browser.act steps. If this task targets the SAME site, skip navigate. If it targets a DIFFERENT site, include a navigate step first.${doneNote}\n\nCURRENT PAGE ELEMENTS (${livePageUrl}):\n${hasRefs ? 'Use the [eN] ref as the selector value for click/fill/hover — do NOT use the label text as selector when a ref is provided. Skip examine steps — refs are already known.' : 'Use ONLY these exact labels as selectors — do not invent labels.'}\n${elList}`;
  }

  // ── RAG: fetch relevant skill prompt snippets from DuckDB ───────────────────
  // Search skill_prompts table for snippets matching the user's request.
  // Matched snippets are injected at the top of the system prompt so the LLM
  // gets precise, focused guidance without loading the full plan-skills.md rules.
  let skillPromptSnippets = [];
  let skillPromptMatched = false;
  if (mcpAdapter && userMessage) {
    try {
      const spRes = await mcpAdapter.callService('user-memory', 'skill_prompt.search', {
        query: userMessage,
        topK: 3
      }, { timeoutMs: 3000 }).catch(() => null);
      const results = spRes?.data?.results || spRes?.results || [];
      if (results.length > 0) {
        skillPromptSnippets = results;
        skillPromptMatched = true;
        logger.debug(`[Node:PlanSkills] RAG: ${results.length} skill prompt snippet(s) matched (top score: ${results[0].similarity})`);
      } else {
        logger.debug('[Node:PlanSkills] RAG: no skill prompt snippets matched — using full plan-skills.md');
      }
    } catch (spErr) {
      logger.warn(`[Node:PlanSkills] RAG skill_prompt.search failed (non-fatal): ${spErr.message}`);
    }
  }

  // ── Context rules: fetch per-site/app prompt rules from DuckDB ─────────────
  // Extracts hostnames from URLs in the message + active browser URL (context_type=site)
  // and app names from state.activeAppName / message keywords (context_type=app).
  // Injected as a block into the LLM prompt — lightweight exact-match, no embeddings.
  // ThinkDrop AI writes rules via context_rule.upsert after diagnosing failures.
  let siteRulesBlock = '';
  if (mcpAdapter && (userMessage || state.activeBrowserUrl || state.activeAppName)) {
    try {
      const contextKeys = new Set();

      // Extract hostnames from full URLs (https?://) in the message and active browser URL
      const urlRegex = /https?:\/\/([a-zA-Z0-9.-]+)/g;
      const searchText = `${userMessage || ''} ${state.activeBrowserUrl || ''}`;
      let m;
      while ((m = urlRegex.exec(searchText)) !== null) {
        contextKeys.add(m[1].toLowerCase().replace(/^www\./, ''));
      }
      if (state.activeBrowserUrl) {
        try {
          const h = new URL(state.activeBrowserUrl).hostname.toLowerCase().replace(/^www\./, '');
          if (h) contextKeys.add(h);
        } catch (_) {}
      }
      // Also extract bare domain names (no protocol) from the message text
      // e.g. "go to github.com and star" → "github.com"
      const bareDomainRegex = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:com|io|org|net|dev|app|ai|co|gov|edu|us|me))\b/g;
      const bareDomainText = userMessage || '';
      let bd;
      while ((bd = bareDomainRegex.exec(bareDomainText)) !== null) {
        contextKeys.add(bd[1].toLowerCase());
      }

      // Include recovery context key — when replanning after a failure, the error was
      // diagnosed against a specific contextKey (e.g. "github.com") that holds the fix rule.
      // skillResults is cleared on replan so the URL scan above finds nothing — add it directly.
      if (state.recoveryContext?.contextKey) {
        contextKeys.add(String(state.recoveryContext.contextKey).toLowerCase());
      }

      // Add active app name for native app rules (e.g. 'slack', 'excel', 'discord')
      if (state.activeAppName) {
        contextKeys.add(state.activeAppName.toLowerCase().trim());
      }
      // Also detect common app names mentioned in the message
      const APP_KEYWORDS = ['slack', 'discord', 'excel', 'outlook', 'teams', 'notion', 'figma', 'zoom', 'xcode', 'vscode', 'terminal', 'finder'];
      const msgLower = (userMessage || '').toLowerCase();
      for (const app of APP_KEYWORDS) {
        if (msgLower.includes(app)) contextKeys.add(app);
      }
      // Also scan actual visited URLs from prior skillResults — rules may have been
      // written under the redirect target (e.g. chatgpt.com) not the planned URL.
      // This is the dynamic alias fix: no hardcoded pairs needed.
      const priorResults = Array.isArray(state.skillResults) ? state.skillResults : [];
      for (const r of priorResults) {
        if (r.url) {
          try { contextKeys.add(new URL(r.url).hostname.toLowerCase().replace(/^www\./, '')); } catch (_) {}
        }
        if (r.args?.url) {
          try { contextKeys.add(new URL(r.args.url).hostname.toLowerCase().replace(/^www\./, '')); } catch (_) {}
        }
      }

      const keys = [...contextKeys];
      if (keys.length > 0) {
        const crRes = await mcpAdapter.callService('user-memory', 'context_rule.search', {
          contextKeys: keys
        }, { timeoutMs: 3000 }).catch(() => null);
        const crResults = crRes?.data?.results || crRes?.results || [];
        if (crResults.length > 0) {
          const ruleLines = crResults
            .map(r => `- [${r.contextKey}${r.category !== 'general' ? ` / ${r.category}` : ''}] ${r.ruleText}`)
            .join('\n');
          siteRulesBlock = `\n\nSITE/APP-SPECIFIC RULES (learned from prior interactions — follow exactly):\n${ruleLines}`;
          logger.info(`[Node:PlanSkills] Context rules: ${crResults.length} rule(s) injected for [${keys.join(', ')}]`);
        } else {
          logger.debug(`[Node:PlanSkills] Context rules: none found for [${keys.join(', ')}]`);
        }
      }
    } catch (crErr) {
      logger.warn(`[Node:PlanSkills] context_rule.search failed (non-fatal): ${crErr.message}`);
    }
  }

  // Fetch installed user skills — inject into prompt so LLM uses external.skill instead of needs_skill
  let installedSkillsNote = '';
  let installedSkillsList = []; // kept in outer scope for scout intercept dedup check below
  let shellSkillNames = new Set(); // names of shell/contract skills — used in post-plan guard
  if (mcpAdapter) {
    try {
      const isRes = await mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 3000 }).catch(() => null);
      const isRaw = isRes?.data || isRes;
      const isNames = Array.isArray(isRaw?.results) ? isRaw.results : [];
      installedSkillsList = isNames; // save for scout intercept check
      if (isNames.length > 0) {
        const isMdSkill = s => s.execType === 'shell' || (s.execPath || '').endsWith('.md');
        // Exclude registered projects — they should only be launchable when the user
        // explicitly references the project name. Including them causes the LLM to
        // shortcut to project.launcher for generic capability requests.
        const isProject = s => s.execType === 'project' || s.projectDir || s.type === 'project';
        const nodeSkills  = isNames.filter(s => !isMdSkill(s) && !isProject(s));
        const shellSkills = isNames.filter(s =>  isMdSkill(s) && !isProject(s));
        const noteParts = [];
        if (nodeSkills.length > 0) {
          const lines = nodeSkills.map(s => `  - ${s.name}: ${s.description || 'no description'}`).join('\n');
          noteParts.push(`INSTALLED SKILLS (use external.skill ONLY when the skill's purpose DIRECTLY matches the task — do NOT use as a fallback for vaguely related tasks):\n${lines}\n  Usage: { "skill": "external.skill", "args": { "name": "<skill-name>", ...args } }\n  RULE: If the task cannot be fulfilled by one of these skills exactly, use shell.run or needs_skill instead. Never pick an installed skill just because it seems related.`);
        }
        if (shellSkills.length > 0) {
          const lines = shellSkills.map(s => `  - ${s.name}: ${s.description || 'no description'}`).join('\n');
          noteParts.push(`SHELL-PLAN SKILLS (contract_md defines steps — generate shell.run steps directly, do NOT use external.skill):\n${lines}\n  RULE: Only use these when the task directly matches the skill's stated purpose.`);
          shellSkills.forEach(s => shellSkillNames.add(s.name));
        }
        if (noteParts.length > 0) installedSkillsNote = '\n\n' + noteParts.join('\n\n');
      }
    } catch (_) { /* non-fatal */ }
  }

  // ── "You already have this" short-circuit ────────────────────────────────────
  // parseSkill matched an existing skill BUT the user asked to CREATE/BUILD it.
  // Don't rebuild — surface a friendly "you already have X" response immediately.
  if (state.matchedSkillName && state.matchedSkillUserWantsToCreate) {
    const existingName = state.matchedSkillName;
    logger.info(`[Node:PlanSkills] matchedSkillUserWantsToCreate=true — short-circuit for "${existingName}"`);
    const alreadyHavePlan = [{
      skill: 'synthesize',
      description: `You already have ${existingName}`,
      args: {
        prompt: `The user asked to create a skill for app control / automation but they already have an installed skill called "${existingName}" that covers exactly this capability. Tell them they already have it, briefly describe what it can do (scroll, type, use shortcuts, interact with any app), and give 2-3 example prompts they can use right now. Be concise and helpful.`,
        savedFilePath: null,
      },
    }];
    if (progressCallback) progressCallback({
      type: 'plan_ready',
      steps: alreadyHavePlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })),
      intent: 'command_automate',
    });
    return {
      ...state,
      skillPlan: alreadyHavePlan,
      skillCursor: 0,
      planError: null,
      recoveryContext: null,
    };
  }

  // ── Skill contract injection ─────────────────────────────────────────────────
  // When parseSkill matched an installed skill, fetch its full contract_md from DB
  // and inject it as planning context. This replaces the old creatorPlanning code-gen
  // pipeline: skill.md IS the plan — shell.run/curl steps are derived from it directly.
  let skillContractNote = '';
  let _shellContractMd = null; // contractMd for matched non-node (shell) skill — used in post-plan guard
  if (state.matchedSkillName && mcpAdapter) {
    try {
      const scRes = await mcpAdapter.callService('user-memory', 'skill.get', {
        name: state.matchedSkillName
      }, { timeoutMs: 3000 }).catch(() => null);
      const scData = scRes?.data || scRes;
      const contractMd = scData?.contractMd || scData?.contract_md || '';
      if (contractMd && contractMd.trim()) {
        // Detect exec_type from frontmatter — node skills must use external.skill, not shell.run
        const _fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
        const _isNodeSkill = _fmMatch && /exec_type:\s*node\b/i.test(_fmMatch[1]);

        if (_isNodeSkill) {
          skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. This is a Node.js runtime skill (exec_type: node). Generate a SINGLE step: { "skill": "external.skill", "args": { "name": "${state.matchedSkillName}" } }\n2. You MAY include additional args to pass context (e.g. { "name": "${state.matchedSkillName}", "action": "diagnose" }).\n3. FORBIDDEN: Do NOT generate shell.run or curl steps — this skill runs as a Node.js module.\n4. FORBIDDEN: Do NOT use "${state.matchedSkillName}" directly as the skill type in any step.\n\n${contractMd.slice(0, 2000)}`;
        } else {
          skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. You MUST generate shell.run steps with curl commands from the ## Commands or ## Plan section below.\n2. FORBIDDEN: Do NOT use "${state.matchedSkillName}" as a skill name in any step. It is NOT a dispatchable skill.\n3. FORBIDDEN: Do NOT use external.skill for this.\n4. The ONLY way to execute this skill is via shell.run with the curl command shown in the contract.\n\n${contractMd.slice(0, 3000)}`;
          _shellContractMd = contractMd; // save for post-plan guard
          shellSkillNames.add(state.matchedSkillName); // ensure guarded even if listNames had stale execType
        }
        logger.info(`[Node:PlanSkills] Injected contract_md for matched skill "${state.matchedSkillName}" (${contractMd.length} chars, exec_type: ${_isNodeSkill ? 'node' : 'shell'})`);
      }
    } catch (scErr) {
      logger.warn(`[Node:PlanSkills] Could not fetch contract_md for "${state.matchedSkillName}": ${scErr.message}`);
    }
  }

  // ── CLI pre-flight check: detect required CLIs, check brew/curl + install/auth status ──
  // Calls cli.agent preflight_check BEFORE the LLM prompt is built so the LLM gets
  // accurate tool availability context and can plan the right install/auth steps upfront.
  // Only fires when there are no active skillResults (fresh plan, not a recovery replan).
  // Kept fast via a tight 5s timeout — never blocks planning if cli.agent is unavailable.
  let _preflightCliMap = {}; // service → { hasCli: bool } — hoisted for agentTypeHint below
  let cliPreflightNote = '';
  const isRecoveryReplan = !!recoveryContext;
  if (mcpAdapter && !isRecoveryReplan) {
    try {
      const pfRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'cli.agent',
        args: { action: 'preflight_check', task: userMessage },
      }, { timeoutMs: 5000 }).catch(() => null);

      const pf = pfRes?.data || pfRes;

      if (pf?.ok) {
        const lines = [];

        // Bootstrap tools
        if (!pf.brew?.installed) {
          lines.push('brew: NOT INSTALLED — install first: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
        } else {
          lines.push('brew: installed ✓');
        }
        if (!pf.curl?.installed) {
          lines.push('curl: NOT INSTALLED — cannot use curl-based API calls until installed');
        } else {
          lines.push('curl: installed ✓');
        }

        // Per-CLI status
        if (Array.isArray(pf.detectedClis) && pf.detectedClis.length > 0) {
          for (const c of pf.detectedClis) {
            _preflightCliMap[c.service.toLowerCase()] = { hasCli: !!c.cli };
            if (!c.cli) {
              if (c.isOAuth)  lines.push(`${c.service}: OAuth-based service — no CLI, browser or API flow required`);
              else if (c.isApiKey) lines.push(`${c.service}: API key required (${c.apiKeyEnvVar || 'check service settings'}) — no CLI binary; use browser.agent { action: 'build_agent' } then { action: 'run' } — the api_key loop handles credential injection and curl automatically (do NOT use shell.run)`);
              continue;
            }
            if (!c.installed) {
              const installCmd = c.installMethod === 'npm'
                ? `npm install -g ${c.installPkg}`
                : `brew install ${c.installPkg || c.cli}`;
              lines.push(`${c.cli} (${c.service}): NOT INSTALLED — MUST install before use: ${installCmd}`);
            } else if (c.authStatus === 'not_authenticated') {
              lines.push(`${c.cli} (${c.service}): installed v${c.version} — NOT AUTHENTICATED. Run \`${c.cli} auth login\` or equivalent before use.`);
            } else if (c.authStatus === 'authenticated') {
              lines.push(`${c.cli} (${c.service}): installed v${c.version} — authenticated ✓ — use directly, skip auth setup steps`);
            } else {
              lines.push(`${c.cli} (${c.service}): installed v${c.version} — auth status unknown`);
            }
          }
        }

        if (lines.length > 0) {
          cliPreflightNote = `\n\nCLI PRE-FLIGHT STATUS (verified at plan time — use this to decide whether to add install/auth steps):\n${lines.map(l => `- ${l}`).join('\n')}`;
          logger.info(`[Node:PlanSkills] CLI pre-flight: ${pf.detectedClis?.length || 0} CLI(s) checked`);
        }
      }
    } catch (pfErr) {
      logger.warn(`[Node:PlanSkills] CLI pre-flight check failed (non-fatal): ${pfErr.message}`);
    }
  }

  // ── Agent registry: inject healthy agent descriptors into planning context ──
  // Query the agent registry (cli.agent + browser.agent) for all healthy agents.
  // Their descriptors tell the LLM which services have resolved auth, CLI tools,
  // and navigation patterns — so it doesn't plan redundant auth steps or prompt
  // the user for credentials that are already available.
  let agentContextNote = '';
  let discoveryNote = '';
  if (mcpAdapter) {
    try {
      const agentRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'cli.agent',
        args: { action: 'list_agents' },
      }, { timeoutMs: 4000 }).catch(() => null);

      const agentRows = agentRes?.data?.agents || agentRes?.agents || [];
      const healthyAgents = agentRows.filter(a => a.status === 'healthy' || a.status === 'degraded');

      if (healthyAgents.length > 0) {
        const agentLines = healthyAgents.map(a => {
          const caps = Array.isArray(a.capabilities) ? a.capabilities.slice(0, 6).join(', ') : '';
          const typeTag = a.type === 'browser' ? '[browser]' : (a.type === 'api_key' || a.type === 'bearer' || a.type === 'basic') ? '[api_key]' : '[cli]';
          return `  - ${typeTag} ${a.id} (service: ${a.service}, tool: ${a.cliTool || 'browser'}) — capabilities: ${caps || 'see descriptor'}`;
        }).join('\n');

        agentContextNote = `\n\nAVAILABLE AGENTS (already configured — the sub-agent owns auth, credentials, and execution end-to-end):\n${agentLines}\n  When a task uses one of these services, emit ONE delegation step — do NOT plan individual shell.run/curl steps for registered services:\n  - [cli] agent: { "skill": "cli.agent", "args": { "action": "run", "agentId": "<id>", "task": "<plain-language goal>" } }\n  - [browser] agent: { "skill": "browser.agent", "args": { "action": "run", "agentId": "<id>", "task": "<plain-language goal>" } } — add \"requiresAuth\": true to args ONLY when the user's explicit goal is to log in / sign in / connect an account to the service; omit it for all other tasks\n  - [api_key] agent: { "skill": "browser.agent", "args": { "action": "run", "agentId": "<id>", "task": "<plain-language goal>" } } — DEVELOPER API ONLY. If the task is TALKING TO / USING an AI service interactively (ChatGPT, Gemini, Claude, Grok, Suno, Midjourney, etc.), use the [browser] consumer-site agent for that service instead.\n  The sub-agent reads its own descriptor, resolves credentials, infers the correct commands, and executes — you do NOT need to add auth setup steps or inline shell commands.\n  For recurring/background tasks using these services, use needs_skill to build the automation skill.\n  ⚠️ HARD RULE: For every [browser] agent listed above, you MUST use browser.agent { action: "run" } — NEVER playwright.agent. playwright.agent bypasses the OAuth flow that browser.agent manages — it will see a login page and immediately fail.\n  ⚠️ [api_key] AGENTS CANNOT NAVIGATE: [api_key] agents (openai.agent, anthropic.agent, mistral.agent, etc.) are DEVELOPER API consoles — they have NO browser and CANNOT fulfill any task that says "goto", "go to", "open", "visit", or "navigate to" a service. ANY navigation-verb task unconditionally requires a [browser] agent. If the AVAILABLE AGENTS list above has no [browser] match for the desired service, emit { "skill": "browser.agent", "args": { "action": "build_agent", "service": "<service-name>" } } as the first step to create it at runtime — do NOT substitute a [api_key] agent. [api_key] agents are for programmatic API calls ONLY (sending data, querying an API programmatically — not browsing, chatting interactively, or navigating).`;

        logger.debug(`[Node:PlanSkills] Agent context: ${healthyAgents.length} healthy agent(s) injected`);
      }

      // ── Discovery note: guide LLM to plan build_agent when service has no agent ──
      // Detects services the user wants that aren't covered by any agent row (healthy or not).
      // Injects a structured setup flow so the LLM plans build_agent → run, not a broken
      // shell.run/curl attempt with placeholder credentials.
      const coveredServiceIds = new Set(
        agentRows.map(a => (a.service || a.id.replace('.agent', '')).toLowerCase())
      );
      // Gather services the user wants (from enrichIntent domainTags)
      const wantedServices = [
        ...(domainTags?.services || []),
        ...(domainTags?.tags   || []),
      ].map(s => s.toLowerCase()).filter(s => s.length >= 3);

      const missingService = wantedServices.find(svc =>
        !coveredServiceIds.has(svc) &&
        !agentRows.some(a => (a.id || '').toLowerCase().includes(svc))
      );

      if (missingService) {
        // Use preflight CLI data as the authoritative signal — c.cli is null when no binary exists.
        // Fall back to browser.agent when the service was not in the preflight scan:
        // browser.agent handles both REST/api_key and OAuth paths, so it is always safe.
        // cli.agent only works when a real binary is installed.
        const preflightEntry = _preflightCliMap[missingService.toLowerCase()];
        const agentTypeHint = preflightEntry
          ? (preflightEntry.hasCli ? 'cli.agent' : 'browser.agent')
          : 'browser.agent'; // default: browser.agent is safe for any REST/OAuth service
        discoveryNote = `\n\nNO AGENT CONFIGURED FOR "${missingService.toUpperCase()}" — the user does not have this service set up yet.` +
          ` Plan a discovery and setup flow — do NOT plan shell.run, curl, or skill.bootstrap steps:` +
          `\n  Step 1: { "skill": "synthesize", "args": { "prompt": "You don't have ${missingService} set up yet. I can configure it for you in a moment." } }` +
          `\n  Step 2: { "skill": "${agentTypeHint}", "args": { "action": "build_agent", "service": "${missingService}" } }` +
          `\n  Step 3: { "skill": "${agentTypeHint}", "args": { "action": "run", "agentId": "${missingService}.agent", "task": "<repeat the user's original request verbatim>" } }` +
          `\n  If the service type is ambiguous: use cli.agent for cloud/devops/API-key services, browser.agent for OAuth/social/ecommerce services.` +
          `\n  If you don't know the service: emit { "skill": "web.search", "args": { "query": "${missingService} CLI or REST API setup" } } before build_agent.`;
        logger.info(`[Node:PlanSkills] Discovery note injected for uncovered service: "${missingService}" (agent type hint: ${agentTypeHint})`);
      }
    } catch (_) { /* non-fatal */ }
  }

  // Build injected snippets block — placed at top of system prompt for maximum LLM attention
  let ragSnippetsBlock = '';
  if (skillPromptSnippets.length > 0) {
    const snippetLines = skillPromptSnippets
      .map((s, i) => `### Pattern ${i + 1} [${(s.tags || []).join(', ')}] (relevance: ${s.similarity})\n${s.promptText}`)
      .join('\n\n');
    ragSnippetsBlock = `## RETRIEVED SKILL PATTERNS — follow these exactly for this task\n\n${snippetLines}\n\n---\n\n`;
  }

  const effectiveSystemPrompt = ragSnippetsBlock
    ? ragSnippetsBlock + SKILL_SYSTEM_PROMPT
    : SKILL_SYSTEM_PROMPT;

  // ── Domain context note from enrichIntent keyword extraction ──────────────
  // enrichIntent runs DOMAIN_TAXONOMY against the raw message and outputs
  // tags + preferred services + skill hints. Inject this so the LLM knows
  // exactly what service to bootstrap even when the user message is ambiguous
  // (e.g. "text these to me" → tags: sms, services: twilio, skillHint: twilio.sms).
  // Known docs URLs — loaded from api_rules DB (rule_type='endpoint').
  // Seeded by database.js seedApiRules() on first boot — no hardcoded map here.
  // Any new service can be added via api_rule.upsert without a code deploy.
  // For unknown services, planSkills instructs the LLM to web-search for docs.
  let KNOWN_DOCS_URLS = {};
  try {
    const endpointRules = await mcpAdapter.callService('user-memory', 'api_rule.list', {
      ruleType: 'endpoint',
      limit: 200,
    });
    const endpointResults = endpointRules?.results || endpointRules?.data?.results || [];
    for (const rule of endpointResults) {
      if (rule.service && rule.rule_text) {
        // rule_text stores the docs URL for endpoint rules
        KNOWN_DOCS_URLS[rule.service.toLowerCase()] = rule.rule_text;
      }
    }
    if (endpointResults.length > 0) {
      logger.debug(`[Node:PlanSkills] Loaded ${endpointResults.length} endpoint docs URLs from api_rules DB`);
    }
  } catch (_e) {
    logger.debug('[Node:PlanSkills] api_rule.list(endpoint) unavailable (non-fatal)');
  }

  // ── Pre-LLM guard: strip erroneous messaging domain context for local recurring reminders ──
  // phi4 can hallucinate "discord"/"telegram"/"slack" as domain services for requests like
  // "Schedule my cold plunge every morning at 6am" — a local macOS alarm that needs NO API.
  // If enrichIntent leaked a chosenService or domainTags from a phi4 false-positive, clear
  // them before the domain context note is built, so the LLM sees a clean message and
  // respects the launchd/node-cron pattern in plan-skills.md.
  {
    const _PRE_LLM_RECURRING_RE = /\b(every\s+(morning|day|night|evening|week|month|hour|\d)|daily|weekly|monthly|each\s+(morning|day|night|evening|week)|remind\s+me\s+(daily|every)|recurring|repeat(ing)?|on\s+a\s+(daily|weekly|\w+)\s+schedule|alarm)\b/i;
    const _PRE_LLM_EXPLICIT_SVC_RE = /\b(discord|telegram|slack|twilio|clicksend|sendgrid|mailgun|pushover|pushbullet|onesignal|whatsapp)\b/i;
    if (_PRE_LLM_RECURRING_RE.test(userMessage) && !_PRE_LLM_EXPLICIT_SVC_RE.test(userMessage)) {
      if (chosenService || domainTags) {
        logger.info(`[Node:PlanSkills] Local recurring reminder pre-LLM guard: cleared chosenService="${chosenService}" and domainTags for: "${userMessage.substring(0, 60)}"`);
        chosenService = null;
        domainTags = null;
      }
    }
  }

  let domainContextNote = '';
  if (domainTags && (domainTags.tags?.length > 0 || domainTags.skillHints?.length > 0)) {
    const parts = [];
    if (domainTags.tags?.length > 0) parts.push(`Domain: ${domainTags.tags.join(', ')}`);

    // If user already chose a specific service, lock it in — single target, not a list
    if (chosenService) {
      const svcLower = chosenService.toLowerCase();
      const docsUrl = KNOWN_DOCS_URLS[svcLower];
      // Reuse a previously derived skill name (from a prior plan/replan) so duplicate
      // skills never get created under different names for the same task.
      // Only derive a new name if one has never been set for this task.
      let skillName = state.pendingSkillName || null;
      if (!skillName) {
        // Derive skill name from: service + what the user actually asked to do.
        // Extract the core action from the user message or skill hints.
        // Format: <service>.<capability>.<action> — e.g. clicksend.sms.send
        const msgLower = (state.message || state.resolvedMessage || '').toLowerCase();
        const hints = (domainTags?.skillHints || []).map(h => h.toLowerCase());
        // If skillHints already provide a dotted name that belongs to this service, use it.
        // MUST start with svcLower — reject unrelated hints like 'twitter.post' when service='clicksend'.
        const dottedHint = hints.find(h => h.includes('.') && h.startsWith(svcLower));
        if (dottedHint) {
          skillName = dottedHint;
        } else {
          // Build from the first skill hint or first domain tag + a verb from the user message.
          // Use only simple (non-dotted) hints — dotted hints like 'twitter.post' are cross-service
          // noise that must not bleed into the capability token.
          const _NOISE_TAGS = new Set(['social-media', 'smart-home', 'billing', 'scheduling', 'vehicle']);
          const simpleHints = hints.filter(h => !h.includes('.') && !_NOISE_TAGS.has(h));
          const capability = simpleHints[0]
            || (domainTags?.tags || []).find(t => !_NOISE_TAGS.has(t))?.toLowerCase().replace(/[^a-z0-9]/g, '')
            || 'api';
          // Extract verb: match common action words near the start of the message
          const verbMatch = msgLower.match(/\b(send|check|get|create|list|delete|update|monitor|watch|read|write|track|schedule|cancel|search|play|control|open|close|turn|set|move|find|book|order|pay|call|text|email|push|notify|forward|upload|download|sync|backup|export|import|analyze|convert|translate|generate|summarize|record|stream)\b/);
          const action = verbMatch ? verbMatch[1] : 'send';
          skillName = `${svcLower}.${capability}.${action}`;
        }
      }
      parts.push(`Chosen service: ${chosenService} (user selected)`);
      if (docsUrl) {
        parts.push(`API docs URL: ${docsUrl}`);
      } else {
        parts.push(`API docs URL: unknown — you must discover it`);
      }
      parts.push(`Skill name to create: ${skillName}`);
      const crawlInstruction = docsUrl
        ? `web.crawl("${docsUrl}")`
        : `web.crawl("https://www.google.com/search?q=${encodeURIComponent(chosenService + ' API documentation send notification')}") to discover the real docs URL, then web.crawl that URL`;
      domainContextNote = `\n\n⚠️ DOMAIN CONTEXT — READ BEFORE PLANNING:\n${parts.map(p => `- ${p}`).join('\n')}\n- REQUIRED: Use browser.agent to register and execute — step 1: { "skill": "browser.agent", "args": { "action": "build_agent", "service": "${svcLower}" } }, step 2: { "skill": "browser.agent", "args": { "action": "run", "agentId": "${svcLower}.agent", "task": "<repeat the full user request verbatim>" } }.\n- FORBIDDEN: Do NOT use skill.bootstrap — it is not a registered skill and will always fail with "Unknown skill: skill.bootstrap".\n- FORBIDDEN: Do NOT use shell.run with placeholder credentials. Credentials are handled automatically via keychain.\n- FORBIDDEN: Do NOT use api_suggest — the service is already chosen.\n- OUTPUT: A valid JSON array only. No prose, no markdown outside the array.`;
      logger.info(`[Node:PlanSkills] Domain context (chosen service): ${chosenService} → ${skillName}`);
      // Store the locked skill name back on state so subsequent replans reuse the exact same name
      state = { ...state, pendingSkillName: skillName };
    } else {
      if (domainTags.services?.length > 0) parts.push(`Target services (in priority order): ${domainTags.services.join(', ')}`);
      if (domainTags.skillHints?.length > 0) parts.push(`Suggested skill name: ${domainTags.skillHints[0]}`);

      // Built-in skills (browser.act, shell.run, ui.*, etc.) don't need the skill.bootstrap
      // pipeline — they are already available. Only force skillCreator for external API services.
      const BUILTIN_SKILLS = new Set(['browser.act', 'shell.run', 'ui.axClick', 'ui.typeText', 'ui.click', 'ui.moveMouse', 'ui.waitFor', 'ui.screen.verify', 'image.analyze', 'fs.read', 'web.crawl', 'screen.capture']);
      const firstHint = (domainTags.skillHints?.[0] || '').toLowerCase();
      const isBuiltin = BUILTIN_SKILLS.has(firstHint) || [...BUILTIN_SKILLS].some(b => firstHint.startsWith(b));

      if (isBuiltin) {
        // Built-in skill — just inject domain context as info, don't force skillCreator
        domainContextNote = `\n\n⚠️ DOMAIN CONTEXT:\n${parts.map(p => `- ${p}`).join('\n')}\n- This capability is provided by the built-in "${firstHint}" skill — do NOT use skill.bootstrap pattern.\n- If the user is asking to CREATE or BUILD a new skill/tool for this capability, output: [{"skill":"needs_skill","args":{"capability":"<describe what they want>","suggestion":"${firstHint}"}}]\n- OUTPUT: A valid JSON array only.`;
        logger.info(`[Node:PlanSkills] Domain context injected (builtin): ${domainTags.tags?.join(', ')} → ${firstHint}`);
      } else {
        domainContextNote = `\n\n⚠️ DOMAIN CONTEXT — READ BEFORE PLANNING:\n${parts.map(p => `- ${p}`).join('\n')}\n- REQUIRED: Because this is a messaging/API task with a known target API service, use browser.agent — { "skill": "browser.agent", "args": { "action": "build_agent", "service": "<detected-service>" } } to register, then { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "<full user request verbatim>" } } to execute.\n- FORBIDDEN: Do NOT use skill.bootstrap — it is not a registered skill and will always fail with "Unknown skill: skill.bootstrap".\n- FORBIDDEN: Do NOT use shell.run with placeholder credentials like <TWILIO_ACCOUNT_SID> or <API_KEY>. Credentials are handled automatically via keychain — never hardcode them.\n- FORBIDDEN: Do NOT use api_suggest — the service is already identified above.\n- OUTPUT: A valid JSON array only. No prose, no markdown outside the array.`;
        logger.info(`[Node:PlanSkills] Domain context injected: ${domainTags.tags?.join(', ')} → ${domainTags.skillHints?.[0]}`);
      }
    }
  }

  // ── Pre-LLM recurring reminder intercept ─────────────────────────────────────
  // Delegate to buildReminderSkill — a pure, independently-tested helper that
  // detects local macOS reminders/schedules and builds a deterministic notify/bridge
  // skill plan without touching the LLM.
  // SKIP if the prompt came from the Bridge Listener — that source already has
  // a real action to execute and should never be re-intercepted as a new reminder.
  {
    const _isBridgeListenerSource = state.context?.source === 'bridge_listener' || state.context?.source === 'bridge_startup';
    if (_isBridgeListenerSource) {
      logger.info(`[Node:PlanSkills] Bridge source detected (${state.context?.source}) — skipping reminder intercept`);
    }
    const _reminderResult = _isBridgeListenerSource ? null : buildReminderSkill(userMessage, homeDir);
    if (_reminderResult && _reminderResult.fires) {
      logger.info(`[Node:PlanSkills] Pre-LLM recurring reminder intercept [${_reminderResult.tier}]: "${_reminderResult.skillName}" cron="${_reminderResult.cronExpr}"`);
      if (progressCallback) progressCallback({
        type: 'plan_ready',
        steps: _reminderResult.skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })),
        intent: state.intent?.type || 'command_automate',
      });
      return {
        ...state,
        skillPlan: _reminderResult.skillPlan,
        skillCursor: 0,
        planError: null,
        recoveryContext: null,
        pendingSkillName: _reminderResult.skillName,
      };
    }
  }

  const planningQuery = `TASK: Convert the following user request into a JSON skill plan.
OS: ${os}
Home directory: ${homeDir}
User request: "${userMessage}"${domainContextNote}${skillContractNote}${installedSkillsNote}${cliPreflightNote}${agentContextNote}${discoveryNote}${siteRulesBlock}${recoveryNote}${profileContextNote}${credentialContextNote}${browserSessionNote}${priorResultsNote}${messagingBodyNote}${closeFileContextNote}${cacheShortCircuitNote}${conversationNote}${taggedContextNote}${creatorContextNote}`;

  // ── Contract-driven fast path ───────────────────────────────────────────────
  // When parseSkill matched a shell skill whose contract has a ## Commands section,
  // skip free-form LLM plan generation entirely. Instead:
  //   1. Parse command templates from the contract (no LLM)
  //   2. One small focused LLM call to pick the template + fill params
  //   3. Assemble steps deterministically — no jsonrepair, no truncation risk
  // Falls through to the existing LLM path if the contract lacks ## Commands or
  // if this is a recovery replan (recoveryContext is set) — let full planning handle it.
  if (_shellContractMd && !recoveryContext && !state.forceSkillBuild) {
    const _contractParsed = parseContractCommands(_shellContractMd);
    if (_contractParsed && _contractParsed.commands.length > 0) {
      logger.info(`[Node:PlanSkills] Contract fast path: ${_contractParsed.commands.length} template(s) for "${state.matchedSkillName}"`);

      // PII stays out of the LLM — only need the template index back.
      // Phone/email/body are resolved deterministically after the LLM call.
      const _sel = await selectCommandTemplate(_contractParsed.commands, userMessage, backend);

      if (_sel !== null) {
        // ── Deterministic date resolution ────────────────────────────────────────
        // Convert natural-language temporal phrases ("last week", "3 hours ago", etc.)
        // into concrete UTC ISO ranges before applyContractParams runs.
        // When a phrase is found, params.timeMin/timeMax override $(date ...) in the URL.
        // The {{TOKEN}} variants (TIME_MIN, UNIX_MIN, DATE_MIN etc.) handle non-gcal APIs.
        // When no phrase is found, resolveDateRange returns null and $(date ...) is left
        // untouched so bash evaluates it at runtime (correct for "upcoming" queries).
        const _resolvedDates = resolveDateRange(userMessage);
        if (_resolvedDates) {
          _sel.params.timeMin = _resolvedDates.timeMin;
          _sel.params.timeMax = _resolvedDates.timeMax;
          Object.assign(_sel.params, {
            TIME_MIN: _resolvedDates.TIME_MIN,
            TIME_MAX: _resolvedDates.TIME_MAX,
            UNIX_MIN: _resolvedDates.UNIX_MIN,
            UNIX_MAX: _resolvedDates.UNIX_MAX,
            DATE_MIN: _resolvedDates.DATE_MIN,
            DATE_MAX: _resolvedDates.DATE_MAX,
          });
          logger.info(`[Node:PlanSkills] resolveDateRange: timeMin=${_resolvedDates.timeMin} timeMax=${_resolvedDates.timeMax}`);
        }
        // ─────────────────────────────────────────────────────────────────────────

        // ── Deterministic param resolution (phone, email, body) ─────────────────
        // Merge runtime params into _sel.params — dates from resolveDateRange already set.
        // buildRuntimeParams handles: extractMessageParams + profile fallback + BODY escape.
        Object.assign(_sel.params, buildRuntimeParams(userMessage, profileContext, priorSynthesizedContent));
        logger.info(`[Node:PlanSkills] fast path _sel.params keys: ${JSON.stringify(Object.keys(_sel.params))}`);
        // ─────────────────────────────────────────────────────────────────────────

        const _chosenTemplate = _contractParsed.commands[_sel.index];
        logger.info(`[Node:PlanSkills] template code preview: ${(_chosenTemplate.code || '').slice(0, 120)}`);
        // substituteTokens handles applyContractParams output + any remaining {{TOKEN}};
        // uses split/join throughout to avoid String.replace $-special-char issues.
        let _filledCode = substituteTokens(applyContractParams(_chosenTemplate.code, _sel), _sel.params, logger);
        logger.info(`[Node:PlanSkills] _filledCode after substituteTokens (preview): ${_filledCode.slice(0, 200)}`);

        // Build the deterministic plan
        const _contractPlan = [];

        // Step 1: auth check (always, if contract has an ## Auth block)
        if (_contractParsed.authScript) {
          _contractPlan.push({
            skill: 'shell.run',
            args: { cmd: 'bash', argv: ['-c', _contractParsed.authScript] },
            description: `Check ${state.matchedSkillName} auth`,
          });
        }

        // Step 2: the selected command
        _contractPlan.push({
          skill: 'shell.run',
          args: { cmd: 'bash', argv: ['-c', _filledCode] },
          description: _chosenTemplate.heading,
        });

        // Step 3: synthesize
        _contractPlan.push({
          skill: 'synthesize',
          args: { prompt: userMessage },
          description: 'Summarize result',
        });

        logger.info(`[Node:PlanSkills] Contract fast path: built ${_contractPlan.length}-step plan (template: "${_chosenTemplate.heading}")`);
        if (progressCallback) progressCallback({
          type: 'plan_ready',
          steps: _contractPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })),
          intent: state.intent?.type || 'command_automate',
        });

        return {
          ...state,
          skillPlan: _contractPlan,
          skillCursor: 0,
          recoveryContext: null,
          planError: null,
        };
      }
      logger.warn('[Node:PlanSkills] Contract fast path: template selection failed — falling through to LLM planning');
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  const payload = {
    query: planningQuery,
    context: {
      systemInstructions: effectiveSystemPrompt,
      conversationHistory: [],
      sessionId: context?.sessionId,
      userId: context?.userId,
      intent: 'command_automate'
    },
    options: {
      maxTokens: 3600,
      temperature: 0.1,
      fastMode: false
    }
  };

  try {
    const available = await backend.isAvailable().catch(() => false);
    if (!available) {
      return {
        ...state,
        planError: 'LLM backend unavailable for skill planning'
      };
    }

    let rawPlan = await backend.generateAnswer(planningQuery, payload, payload.options, null);
    logger.debug(`[Node:PlanSkills] Raw LLM output: ${rawPlan.substring(0, 300)}...`);

    // Parse the JSON plan from LLM output
    let skillPlan = parsePlan(rawPlan, logger);

    // Retry once if LLM returned a refusal/apology instead of JSON
    if (!skillPlan) {
      logger.warn('[Node:PlanSkills] Parse failed — retrying once...');
      if (progressCallback) progressCallback({ type: 'planning', message: 'Retrying plan generation...' });
      // On retry: enforce JSON-only output by prepending a strict instruction
      const retryPayload = {
        ...payload,
        messages: [
          ...(payload.messages || []),
          { role: 'user', content: 'IMPORTANT: Output ONLY a valid JSON array. No explanation, no prose, no markdown fences, no comments.' },
        ],
      };
      rawPlan = await backend.generateAnswer(planningQuery, retryPayload, payload.options, null);
      logger.debug(`[Node:PlanSkills] Retry output: ${rawPlan.substring(0, 300)}...`);
      skillPlan = parsePlan(rawPlan, logger);
    }

    if (!skillPlan) {
      if (progressCallback) progressCallback({ type: 'plan_error', error: 'Could not generate a skill plan for this request.' });
      return {
        ...state,
        planError: `Failed to parse skill plan from LLM output: ${rawPlan.substring(0, 200)}`
      };
    }

    // If LLM returned a single step object instead of an array, wrap it
    if (!Array.isArray(skillPlan) && skillPlan && typeof skillPlan === 'object' && skillPlan.skill) {
      logger.debug(`[Node:PlanSkills] LLM returned single-step object — wrapping in array`);
      skillPlan = [skillPlan];
    }

    // ── Hard guard: contract-based (shell) skills must never use external.skill ──
    // The LLM sometimes ignores FORBIDDEN instructions and emits external.skill for
    // shell contract skills (exec_type:shell / .md exec_path). When detected, retry
    // once with a very targeted override before hard-failing.
    if (Array.isArray(skillPlan) && shellSkillNames.size > 0) {
      const contractViolation = skillPlan.find(
        s => s.skill === 'external.skill' && s.args?.name && shellSkillNames.has(s.args.name)
      );
      if (contractViolation) {
        const badName = contractViolation.args.name;
        const cMd = _shellContractMd || '';
        logger.warn(`[Node:PlanSkills] Contract guard: LLM emitted external.skill for shell skill "${badName}" — retrying with targeted override`);
        const forceMsg = [
          `CRITICAL CORRECTION: You generated { "skill": "external.skill", "args": { "name": "${badName}" } } — this is WRONG.`,
          `"${badName}" is a shell contract skill (exec_type: shell). It is NOT a Node.js module.`,
          `You MUST generate shell.run steps with curl commands from the contract below.`,
          `Do NOT use external.skill. Output ONLY a valid JSON array with shell.run (and optionally synthesize) steps.`,
          cMd ? `\nCONTRACT:\n${cMd.slice(0, 2500)}` : '',
        ].filter(Boolean).join('\n');
        const retryPayload2 = {
          ...payload,
          messages: [...(payload.messages || []), { role: 'user', content: forceMsg }],
        };
        const rawRetry2 = await backend.generateAnswer(planningQuery, retryPayload2, payload.options, null);
        const retryPlan2 = parsePlan(rawRetry2, logger);
        if (
          retryPlan2 &&
          !retryPlan2.find(s => s.skill === 'external.skill' && shellSkillNames.has(s.args?.name))
        ) {
          skillPlan = retryPlan2;
          logger.info(`[Node:PlanSkills] Contract guard: retry succeeded for "${badName}"`);
        } else {
          logger.error(`[Node:PlanSkills] Contract guard: retry still emitted external.skill for "${badName}" — blocking execution`);
          if (progressCallback) progressCallback({ type: 'plan_error', error: `Skill "${badName}" is a shell contract and cannot run via external.skill. Please try again.` });
          return {
            ...state,
            planError: `Contract skill "${badName}" cannot be executed via external.skill. Please rephrase your request and try again.`,
          };
        }
      }
    }

    // ── Phase 2: Segment expansion ─────────────────────────────────────────
    // Scan for {{EXPAND:<intent>}} placeholders in synthesize prompt strings.
    // Each placeholder gets its own focused LLM call to generate the full prompt,
    // so the plan skeleton stays small and never truncates.
    if (Array.isArray(skillPlan)) {
      const EXPAND_RE = /^\{\{EXPAND:(.+)\}\}$/;
      for (let i = 0; i < skillPlan.length; i++) {
        const step = skillPlan[i];
        if (step.skill !== 'synthesize' || !step.args?.prompt) continue;
        const match = step.args.prompt.match(EXPAND_RE);
        if (!match) continue;

        const expandIntent = match[1].trim();
        logger.debug(`[Node:PlanSkills] Phase 2 expand: step ${i + 1} — "${expandIntent}"`);

        // Build context from the plan: what comes before and after this step
        const priorSteps = skillPlan.slice(0, i).map((s, j) =>
          `Step ${j + 1}: ${s.skill}${s.args?.url ? ` (${s.args.url})` : ''}${s.description ? ` — ${s.description}` : ''}`
        ).join('\n');
        const saveToFile = step.args.saveToFile || '';

        const expandQuery = `Write a detailed synthesize prompt for this task.

Context — this is step ${i + 1} in a plan:
${priorSteps}

Intent for this step: ${expandIntent}
${saveToFile ? `Output will be saved to: ${saveToFile}` : ''}
User request: "${userMessage}"

Write ONLY the prompt text (no JSON, no fences). The prompt should tell the LLM exactly what to produce.
If writing a skill.md: start with --- frontmatter (name, description, secrets, schedule:null, tags, version), then sections for What this skill does, Auth, Commands (real curl from docs), Plan (numbered steps). Do NOT wrap in fences.
CRITICAL rules for skill.md:
- secrets: list ALL auth credentials (username, API key, account SID, auth token). NOT runtime args (phone, message).
- schedule: must be null (not false, not "false").
- oauth: if the provider uses OAuth (google, github, microsoft, slack, spotify, dropbox, discord, zoom, atlassian, notion, linkedin, salesforce, hubspot), add "oauth: <provider>" frontmatter field. This lets ThinkDrop auto-supply tokens from the user's global Connections tab.
- oauth_scopes: add "oauth_scopes: <provider>=<scope1> <scope2>" if specific scopes are needed (e.g. google=https://www.googleapis.com/auth/calendar for gcal skills).
- Keytar retrieval: security find-generic-password -s thinkdrop -a "skill:<skillName>:<SECRET_KEY>" -w 2>/dev/null. NEVER use -s <service-name>. Always -s thinkdrop -a "skill:<name>:<key>".
- Commands curl: use keytar retrieval for credentials, real endpoint/headers from docs.`;

        try {
          const expandedPrompt = await backend.generateAnswer(expandQuery, {
            query: expandQuery,
            context: { systemInstructions: 'You write precise LLM prompts. Output only the prompt text, nothing else.', conversationHistory: [], intent: 'command_automate' },
            options: { maxTokens: 800, temperature: 0.1, fastMode: true }
          }, { maxTokens: 800, temperature: 0.1, fastMode: true }, null);

          if (expandedPrompt && expandedPrompt.trim().length > 20) {
            // Strip any markdown fences the LLM might wrap around the prompt
            const cleaned = expandedPrompt.trim()
              .replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\n```\s*$/, '').trim();
            skillPlan[i].args.prompt = cleaned;
            logger.info(`[Node:PlanSkills] Phase 2 expanded step ${i + 1}: ${cleaned.length} chars`);
          } else {
            // Fallback: use the intent as a short prompt
            skillPlan[i].args.prompt = expandIntent;
            logger.warn(`[Node:PlanSkills] Phase 2 expand failed for step ${i + 1} — using intent as fallback`);
          }
        } catch (expandErr) {
          skillPlan[i].args.prompt = expandIntent;
          logger.warn(`[Node:PlanSkills] Phase 2 expand error for step ${i + 1}: ${expandErr.message} — using intent as fallback`);
        }
      }
    }

    // Check if LLM returned a clarifying question instead of a plan
    if (!Array.isArray(skillPlan) && skillPlan.ask) {
      const question = skillPlan.ask;
      const options = Array.isArray(skillPlan.options) ? skillPlan.options : [];
      logger.debug(`[Node:PlanSkills] LLM needs clarification: ${question}`);
      if (progressCallback) progressCallback({ type: 'plan_error', error: question });
      return {
        ...state,
        recoveryAction: 'ask_user',
        pendingQuestion: { question, options, context: null },
        commandExecuted: false,
        answer: question
      };
    }

    // Check if LLM returned an error object instead of a plan
    if (!Array.isArray(skillPlan) && skillPlan.error) {
      const errMsg = skillPlan.error;
      // Detect placeholder/template errors like { "error": "reason" } — retry with enriched context
      const isPlaceholder = !errMsg || errMsg === 'reason' || errMsg.length < 10;
      if (isPlaceholder) {
        logger.warn('[Node:PlanSkills] LLM returned placeholder error — retrying with enriched context...');
        if (progressCallback) progressCallback({ type: 'planning', message: 'Retrying with more context...' });
        const enrichedQuery = `${planningQuery}\n\nIMPORTANT: You MUST output a valid JSON array of skill steps. If the request references a file or path from a previous step, use the PREVIOUS STEP RESULTS above to resolve it. Do NOT output { "error": ... } unless the task is truly impossible.`;
        const retryRaw = await backend.generateAnswer(enrichedQuery, payload, payload.options, null);
        const retryPlan = parsePlan(retryRaw, logger);
        if (retryPlan && Array.isArray(retryPlan)) {
          logger.debug(`[Node:PlanSkills] Retry succeeded: ${retryPlan.length} steps`);
          if (progressCallback) progressCallback({ type: 'plan_ready', steps: retryPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })), intent: state.intent?.type || 'command_automate' });
          return { ...state, skillPlan: retryPlan, skillCursor: 0, recoveryContext: null, planError: null };
        }
      }
      const humanError = isPlaceholder
        ? 'I need more context to complete this — try being more specific (e.g. include the full file path).'
        : `Cannot automate this: ${errMsg}`;
      if (progressCallback) progressCallback({ type: 'plan_error', error: humanError });
      return {
        ...state,
        planError: humanError,
        commandExecuted: false,
        answer: humanError
      };
    }

    // ── URL hallucination guard ─────────────────────────────────────────────
    // The LLM sometimes echoes a previously-visited wrong URL (e.g. "bibegateway.com")
    // from conversation history even when the user typed the correct name this time.
    // Heuristic: planned navigate host-base not found in user message → check if
    // activeBrowserSessionId is a better match for what the user said this turn.
    if (Array.isArray(skillPlan) && userMessage) {
      const navIdx = skillPlan.findIndex(s => s.skill === 'browser.act' && s.args?.action === 'navigate' && s.args?.url);
      if (navIdx !== -1) {
        try {
          const navUrl = skillPlan[navIdx].args.url;
          const plannedHost = new URL(navUrl).hostname.replace(/^www\./, '');
          const plannedBase = plannedHost.split('.')[0]; // e.g. "bibegateway"
          const msgLow = userMessage.toLowerCase();
          // If the planned base does not appear verbatim in the user message,
          // and the active session is also that old base — the LLM hallucinated from history.
          const oldSessionBase = (state.activeBrowserSessionId || '').split('.')[0].toLowerCase();
          if (!msgLow.includes(plannedBase) && oldSessionBase === plannedBase) {
            // Extract site-name words (4+ chars) from user message that could be a hostname
            const siteWords = (msgLow.match(/\b[a-z]{4,}\b/g) || []).filter(w =>
              !['goto', 'open', 'navigate', 'look', 'find', 'search', 'first', 'john', 'and', 'with', 'that', 'this', 'then', 'when', 'from', 'into', 'about', 'over', 'some', 'have', 'been', 'will', 'your', 'they', 'them', 'what', 'which', 'also', 'just', 'like', 'well', 'very', 'make', 'need', 'want', 'take', 'give', 'come', 'here', 'there', 'where', 'while'].includes(w)
            );
            // The correct site name is the siteWord that shares most characters with plannedBase
            let bestWord = null, bestScore = 0;
            for (const w of siteWords) {
              // Simple overlap: count shared chars at start
              let shared = 0;
              const minLen = Math.min(w.length, plannedBase.length);
              for (let i = 0; i < minLen; i++) {
                if (w[i] === plannedBase[i]) shared++;
                else break;
              }
              if (shared > bestScore) { bestScore = shared; bestWord = w; }
            }
            if (bestWord && bestScore >= 4 && bestWord !== plannedBase) {
              // Build a corrected URL using the user's typed site name
              const tld = plannedHost.includes('.') ? plannedHost.slice(plannedBase.length) : '.com';
              const correctedUrl = `https://www.${bestWord}${tld}`;
              try {
                new URL(correctedUrl); // validate
                logger.info(`[Node:PlanSkills] URL hallucination guard: corrected "${navUrl}" → "${correctedUrl}" (user said "${bestWord}", LLM echoed old session "${plannedBase}")`);
                skillPlan = skillPlan.map((s, i) => {
                  if (i !== navIdx) return s;
                  return { ...s, args: { ...s.args, url: correctedUrl } };
                });
              } catch (_) { /* invalid URL — leave as-is */ }
            }
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    // ── Enforce active browser session (single-site follow-ups only) ────────
    // Only reuse the active session when the plan targets a SINGLE sessionId.
    // Multi-tab plans (distinct sessionIds per site) are intentional — don't touch them.
    // Use state.activeBrowserSessionId (not destructured) — pre-scan may have updated it.
    const effectiveSessionId = state.activeBrowserSessionId || activeBrowserSessionId;
    if (effectiveSessionId && Array.isArray(skillPlan)) {
      const browserSteps = skillPlan.filter(s => s.skill === 'browser.act');
      if (browserSteps.length > 0) {
        // Collect distinct sessionIds the LLM chose
        const plannedSessionIds = new Set(browserSteps.map(s => s.args?.sessionId).filter(Boolean));
        const isMultiTab = plannedSessionIds.size > 1;

        if (isMultiTab) {
          // Multi-site plan — LLM used separate sessionIds (= separate windows). Consolidate
          // everything into the FIRST sessionId, converting subsequent navigate steps to tab-new.
          const [primarySession] = [...plannedSessionIds];
          let firstNavigateSeen = false;
          skillPlan = skillPlan.map(step => {
            if (step.skill !== 'browser.act') return step;
            const action = step.args?.action;
            // Rewrite this step to use the primary session
            const unified = { ...step, args: { ...step.args, sessionId: primarySession } };
            if (action === 'navigate') {
              if (!firstNavigateSeen) {
                // Keep the first navigate as-is (just unify the sessionId)
                firstNavigateSeen = true;
                return unified;
              }
              // Subsequent navigates from other sessions → convert to tab-new
              return { ...unified, args: { ...unified.args, action: 'tab-new', url: step.args.url } };
            }
            return unified;
          });
          logger.debug(`[Node:PlanSkills] Multi-tab plan cold: ${plannedSessionIds.size} sessions → 1 session "${primarySession}" (subsequent navigates → tab-new)`);
        } else {
          // Check if the navigate step goes to the same domain as the active session
          const navigateStep = skillPlan.find(s => s.skill === 'browser.act' && s.args?.action === 'navigate');
          const activeBrowserUrl = state.activeBrowserUrl || null;

          // Normalize known domain aliases (e.g. chat.openai.com ↔ chatgpt.com)
          const DOMAIN_ALIASES = {
            'chat.openai.com': 'chatgpt.com',
            'chatgpt.com': 'chat.openai.com',
            'www.google.com': 'google.com',
            'google.com': 'www.google.com',
          };
          const normalizeDomain = (h) => DOMAIN_ALIASES[h] ? [h, DOMAIN_ALIASES[h]] : [h];

          const isSameDomain = navigateStep && activeBrowserUrl
            ? (() => {
                try {
                  const navHost = new URL(navigateStep.args.url).hostname;
                  const activeHost = new URL(activeBrowserUrl).hostname;
                  return normalizeDomain(navHost).includes(activeHost);
                } catch (_) { return false; }
              })()
            : false;

          const isEvalRetry = (state.evaluationRetryCount || 0) > 0;

          if (isSameDomain && !isEvalRetry) {
            // Same domain — enforce active session and strip redundant navigate
            skillPlan = skillPlan.map(step => {
              if (step.skill !== 'browser.act') return step;
              return { ...step, args: { ...step.args, sessionId: effectiveSessionId } };
            });
            const withoutNavigate = skillPlan.filter(s => !(s.skill === 'browser.act' && s.args?.action === 'navigate'));
            if (withoutNavigate.length > 0) {
              skillPlan = withoutNavigate;
              logger.debug(`[Node:PlanSkills] Reused active session "${effectiveSessionId}" — stripped navigate (same domain), ${skillPlan.length} steps remain`);
            }
          } else if (isSameDomain && isEvalRetry) {
            // Same domain eval retry — keep navigate but enforce session
            skillPlan = skillPlan.map(step => {
              if (step.skill !== 'browser.act') return step;
              return { ...step, args: { ...step.args, sessionId: effectiveSessionId } };
            });
            logger.debug(`[Node:PlanSkills] Eval retry ${state.evaluationRetryCount} — keeping navigate despite same domain`);
          } else if (navigateStep) {
            // Different domain — reuse the SAME active session so the URL loads in the existing
            // window instead of spawning a new Chrome window. Site-named sessions ("youtube",
            // "amazon") each cold-start a new window which clutters the desktop.
            skillPlan = skillPlan.map(step => {
              if (step.skill !== 'browser.act') return step;
              return { ...step, args: { ...step.args, sessionId: effectiveSessionId } };
            });
            logger.debug(`[Node:PlanSkills] Different domain — reusing active session "${effectiveSessionId}" (navigate in same window)`);
          } else {
            // No navigate — keep active session
            skillPlan = skillPlan.map(step => {
              if (step.skill !== 'browser.act') return step;
              return { ...step, args: { ...step.args, sessionId: effectiveSessionId } };
            });
            logger.debug(`[Node:PlanSkills] Reused active session "${effectiveSessionId}" — no navigate step`);
          }
        }
      }
    }

    // ── Stamp missing sessionIds ────────────────────────────────────────────
    // Priority 1: if a pre-scan already opened guideSession at the same URL as
    // the plan's first navigate step, reuse guideSession so executeCommand calls
    // 'goto' (reuses the existing window) instead of 'open' (spawns a new one).
    // Priority 2: fall back to hostname derived from navigate URL.
    if (Array.isArray(skillPlan)) {
      const navigateStep = skillPlan.find(s => s.skill === 'browser.act' && s.args?.action === 'navigate' && s.args?.url);
      const existingSessionIds = new Set(skillPlan.filter(s => s.skill === 'browser.act').map(s => s.args?.sessionId).filter(Boolean));
      const isMultiTab = existingSessionIds.size > 1;
      if (!isMultiTab && navigateStep && !navigateStep.args?.sessionId) {
        // Check if guideSession pre-scan already opened this URL
        const preScanSessionId = state.activeBrowserSessionId;
        const preScanUrl = state.activeBrowserUrl;
        let derivedSession = null;
        if (preScanSessionId && preScanUrl && navigateStep.args?.url) {
          try {
            const preScanHost = new URL(preScanUrl).hostname;
            const navHost = new URL(navigateStep.args.url).hostname;
            if (preScanHost === navHost) {
              derivedSession = preScanSessionId;
              logger.info(`[Node:PlanSkills] Stamped missing sessionIds with "${derivedSession}" (reusing pre-scan session — avoids new window)`);
            }
          } catch (_) {}
        }
        // Fallback: always use the canonical "browser" session — never derive from hostname.
        // Hostname-derived sessions (youtube, wikipedia, amazon) each cold-start a new Chrome window.
        // A single "browser" session reuses the existing window for all sites.
        if (!derivedSession) {
          derivedSession = 'browser';
          logger.info(`[Node:PlanSkills] Stamped missing sessionIds with "browser" (canonical session — avoids new window per site)`);
        }
        if (derivedSession) {
          skillPlan = skillPlan.map(step => {
            if (step.skill !== 'browser.act' || step.args?.sessionId) return step;
            return { ...step, args: { ...step.args, sessionId: derivedSession } };
          });
        }
      }
    }

    // ── Final session normalization ──────────────────────────────────────────
    // The LLM sometimes explicitly generates site-named sessionIds like "youtube", "amazon", etc.
    // These cold-start a new Chrome window per site. When it's a single-session plan (all steps
    // share one sessionId) and that sessionId is not "browser", rewrite it to "browser" so
    // all navigation stays in the same window regardless of whether a prior active session exists.
    if (Array.isArray(skillPlan)) {
      const browserStepsForNorm = skillPlan.filter(s => s.skill === 'browser.act');
      if (browserStepsForNorm.length > 0) {
        const sessionIdsUsed = new Set(browserStepsForNorm.map(s => s.args?.sessionId).filter(Boolean));
        const isSingleSession = sessionIdsUsed.size === 1;
        const [onlySession] = [...sessionIdsUsed];
        if (isSingleSession && onlySession && onlySession !== 'browser') {
          skillPlan = skillPlan.map(step => {
            if (step.skill !== 'browser.act') return step;
            return { ...step, args: { ...step.args, sessionId: 'browser' } };
          });
          logger.info(`[Node:PlanSkills] Normalized sessionId "${onlySession}" → "browser" (canonical single-session)`);
        }
      }
    }

    logger.debug(`[Node:PlanSkills] Plan ready: ${skillPlan.length} steps`);
    skillPlan.forEach((s, i) =>
      logger.debug(`  Step ${i + 1}: ${s.skill} — ${s.description || JSON.stringify(s.args)}`)
    );

    // ── Guard: spurious project.launcher plans ────────────────────────────────
    // The LLM may suggest project.launcher when it sees a previously-built project
    // in conversation history, even when the user just asked for a task (not to open
    // a specific project). Only allow project.launcher when the user explicitly
    // references a project by name ("open project X" / "launch project X").
    const projectLauncherStep = skillPlan.length === 1 && skillPlan[0].skill === 'project.launcher' ? skillPlan[0] : null;
    if (projectLauncherStep) {
      const msgLower = (userMessage || '').toLowerCase();
      const explicitProjectRef = /\b(open|launch|start|run|show)\b.{0,30}\bproject\b/i.test(userMessage) ||
        (projectLauncherStep.args?.projectName && msgLower.includes(projectLauncherStep.args.projectName.toLowerCase()));
      if (!explicitProjectRef) {
        logger.info(`[Node:PlanSkills] Guard: project.launcher suggested without explicit project reference — converting to needs_skill for scout`);
        skillPlan = [{
          skill: 'needs_skill',
          args: { capability: userMessage, suggestion: null },
          description: 'needs_skill',
        }];
      }
    }

    // ── Scout intercept: replace needs_skill with a provider-select card ────────
    // If the LLM returned needs_skill, check the CLI/API registries before falling
    // through to recoverSkill → ASK_USER. If we find a match, emit scout_match and
    // pause so the user picks a provider in the Results Window. After they pick,
    // main.js resumes with cliMatch/apiMatch set → creatorPlanning fast-path runs.
    const needsSkillStep = skillPlan.find(s => s.skill === 'needs_skill');
    if (needsSkillStep) {
      // forceSkillBuild: user already selected a provider from the scout card.
      // Skip registry scout and LLM replan — directly generate an external.skill step
      // using the chosen provider so executeCommand triggers the creator build pipeline.
      if (state.forceSkillBuild && (state.gatheredContext?.apiMatch || state.gatheredContext?.cliMatch)) {
        const chosenMatch = state.gatheredContext.apiMatch || state.gatheredContext.cliMatch;
        const capability = chosenMatch.capability || needsSkillStep.args?.capability || userMessage;
        const provider = chosenMatch.provider;
        // Use dot notation (e.g. 'sendgrid.email') to match how skills are registered/discovered.
        // Hyphens would generate 'sendgrid-email' which external.skill can't find after build.
        const skillName = `${provider}.${capability.replace(/[^a-z0-9.]+/gi, '-').toLowerCase()}`.slice(0, 60);
        logger.info(`[Node:PlanSkills] forceSkillBuild: generating external.skill plan for "${capability}" via "${provider}" (skillName: "${skillName}")`);
        const plan = [{
          skill: 'external.skill',
          args: { name: skillName, capability, provider, apiMatch: state.gatheredContext.apiMatch, cliMatch: state.gatheredContext.cliMatch },
          description: `Build skill: ${capability} using ${provider}`,
        }];
        return { ...state, skillPlan: plan, skillCursor: 0, scoutPending: false, forceSkillBuild: false };
      }

      // forceBrowserFallback: user already acknowledged needs_skill and said "build it".
      // Skip registry matching (avoid re-showing the same scout card) and convert directly
      // to browser.act so the task is attempted via the web browser instead of looping.
      if (state.forceBrowserFallback) {
        const capability = needsSkillStep.args?.capability || needsSkillStep.args?.name || userMessage;
        logger.info(`[Node:PlanSkills] forceBrowserFallback: converting needs_skill → browser.act for "${capability}"`);
        const browserPlan = [{
          skill: 'browser.act',
          args: { task: capability },
          description: capability,
        }];
        return { ...state, skillPlan: browserPlan, skillCursor: 0, scoutPending: false, forceBrowserFallback: false };
      }

      const path = require('path');
      const capability = needsSkillStep.args?.capability || needsSkillStep.args?.name || '';
      const suggestion  = needsSkillStep.args?.suggestion || '';
      const searchMsg   = [userMessage, capability].join(' ').toLowerCase();

      // Walk up from __dirname to find the command-service src directory
      function findRegistryDir() {
        let dir = __dirname;
        for (let i = 0; i < 8; i++) {
          const candidate = path.join(dir, 'mcp-services', 'command-service', 'src');
          if (fs.existsSync(path.join(candidate, 'cli-registry.json'))) return candidate;
          dir = path.dirname(dir);
        }
        return null;
      }

      // Skip registry matching entirely when the LLM suggestion is a built-in skill
      // (browser.act, shell.run, ui.*, etc.) — those don't have CLI/API providers and
      // any keyword match would be spurious (e.g. 'slack' as an example word in the message).
      // Declared here (outside if(regDir)) so it's also accessible in the dynamic-discovery block below.
      const BUILTIN_SUGGESTIONS = new Set(['browser.act', 'shell.run', 'ui.axclick', 'ui.typetext', 'ui.click', 'ui.movemouse', 'ui.waitfor', 'ui.screen.verify']);
      const suggestionIsBuiltin = BUILTIN_SUGGESTIONS.has((suggestion || '').toLowerCase());

      // Shared service-name extraction — used by both dynamic discovery and the browser.agent fallback.
      // Strips filler/action words to isolate the key service noun (e.g. "gmail", "slack", "stripe").
      const SCOUT_FILLER_WORDS = new Set([
        'a','an','the','send','get','fetch','create','build','make','add','post',
        'use','using','via','with','from','to','for','of','on','in','at','by',
        'my','me','this','that','some','new','about','through','into','can',
        'message','messages','email','emails','sms','text','notification','notifications',
        'retrieve','read','open','check','access','find','list','show','view',
        'subject','latest','unread','recent','last','first','old',
        'tell','give','display','return','pull','load','look','search',
        'api','service','app','tool','integration','and','the',
      ]);
      const extractScoutServiceName = (str) => (str || '').toLowerCase().split(/\s+/)
        .map(w => w.replace(/[^a-z0-9\-]/g, '')).filter(w => w.length >= 3 && !SCOUT_FILLER_WORDS.has(w));

      const regDir = findRegistryDir();
      if (regDir) {
        let cliRegistry = {}, apiRegistry = {};
        try { cliRegistry = JSON.parse(fs.readFileSync(path.join(regDir, 'cli-registry.json'), 'utf8')); } catch (_) {}
        try { apiRegistry = JSON.parse(fs.readFileSync(path.join(regDir, 'api-registry.json'), 'utf8')); } catch (_) {}

        // Generic English words that appear in registry keywords but are too ambiguous
        // to use as scout triggers on their own (e.g. "todo" in "create a todo app",
        // "task" in "build a task manager", "mail" in "send mail", "merge" in "merge data").
        // These keywords only count as a match when accompanied by a service-specific term
        // in the same registry entry — so we skip them as standalone triggers.
        const GENERIC_KW_BLOCKLIST = new Set([
          'todo', 'task', 'to-do list', 'mail', 'merge', 'branch', 'commit',
          'issue', 'repo', 'repository', 'messaging', 'email', 'payment',
          'billing', 'checkout', 'invoice', 'subscription',
        ]);

        // Find all matching capabilities across both registries
        // Uses whole-word boundary matching to avoid false positives (e.g. 'slack' as an example).
        function findMatches(registry, regType) {
          if (suggestionIsBuiltin) return [];
          const matches = [];
          for (const [cap, entry] of Object.entries(registry)) {
            const kws = entry.keywords || [];
            const hasMatch = kws.some(kw => {
              const kwLower = kw.toLowerCase();
              // Skip generic words — they must not be the sole reason for a match
              if (GENERIC_KW_BLOCKLIST.has(kwLower)) return false;
              const idx = searchMsg.indexOf(kwLower);
              if (idx === -1) return false;
              // Whole-word boundary check
              const before = idx === 0 ? '' : searchMsg[idx - 1];
              const after = searchMsg[idx + kwLower.length] || '';
              const atEnd = idx + kwLower.length === searchMsg.length;
              const wordBefore = idx === 0 || /[\s,.(\["']/.test(before);
              const wordAfter  = atEnd || /[\s,.)\]"']/.test(after);
              return wordBefore && wordAfter;
            });
            if (hasMatch) {
              const providers = entry.providers || {};
              for (const [providerName, config] of Object.entries(providers)) {
                matches.push({ capability: cap, provider: providerName, config, type: regType, defaultProvider: entry.defaultProvider });
              }
            }
          }
          return matches;
        }

        const cliMatches = findMatches(cliRegistry, 'cli');
        const apiMatches = findMatches(apiRegistry, 'api');
        const allMatches = [...cliMatches, ...apiMatches];

        if (allMatches.length > 0) {
          // ── Already-installed check ───────────────────────────────────────────
          // If any matched provider already has an installed skill (e.g. sendgrid.email),
          // skip the scout card entirely and use that skill directly.
          const alreadyInstalled = installedSkillsList.find(s => {
            const nameLower = s.name.toLowerCase();
            return allMatches.some(m => {
              const provLower = m.provider.toLowerCase();
              return nameLower === provLower ||
                     nameLower.startsWith(provLower + '.') ||
                     nameLower.startsWith(provLower + '-');
            });
          });
          if (alreadyInstalled) {
            logger.info(`[Node:PlanSkills] Scout intercept: "${alreadyInstalled.name}" already installed — using directly, skipping scout card`);
            const directPlan = [{
              skill: 'external.skill',
              args: { name: alreadyInstalled.name },
              description: `Run installed skill: ${alreadyInstalled.name}`,
            }];
            return { ...state, skillPlan: directPlan, skillCursor: 0, scoutPending: false };
          }

          logger.info(`[Node:PlanSkills] Scout intercept: ${allMatches.length} provider(s) found for "${capability || userMessage}" — emitting scout_match`);

          if (progressCallback) progressCallback({
            type: 'plan_ready',
            steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })),
            intent: state.intent?.type || 'command_automate',
          });
          if (progressCallback) progressCallback({
            type: 'scout_match',
            capability: capability || userMessage,
            suggestion,
            matches: allMatches,
          });

          // Pause state — main.js will resume with scout:select IPC carrying chosen match
          return {
            ...state,
            skillPlan,
            skillCursor: 0,
            scoutPending: true,
            scoutCapability: capability || userMessage,
            scoutMatches: allMatches,
            recoveryAction: 'scout_select',
            pendingQuestion: {
              question: `I found ${allMatches.length} tool${allMatches.length > 1 ? 's' : ''} that can handle "${capability || userMessage}". Which would you like to use?`,
              options: allMatches.map(m => `${m.provider} (${m.type})`),
              context: { scoutMatches: allMatches, capability: capability || userMessage },
              _isScoutSelect: true,
            },
            commandExecuted: false,
          };
        }

      }

      // ── Dynamic discovery via skill-scout (LLM + web-search driven) ──────────
      // Static keywords didn't match — try live discovery before falling back to
      // project_build. skill-scout.discover() does: npm search → brew search →
      // LLM validates best candidate → writes result back to registry for caching.
      //
      // BROWSER-ONLY SERVICES: OAuth/web services that have no installable CLI/npm
      // package. Dynamic discovery will always fail for these — skip it entirely
      // and fall straight through to the browser.act navigate+snapshot+synthesize plan.
      const BROWSER_ONLY_SERVICES = new Set([
        'gmail','google','googlemail','slack','discord','telegram','whatsapp',
        'notion','figma','linear','jira','confluence','airtable','hubspot','salesforce',
        'twitter','x','facebook','instagram','linkedin','reddit','youtube',
        'openai','chatgpt','anthropic','claude','gemini','perplexity',
        'amazon','netflix','spotify','trello','asana','monday','clickup',
        'dropbox','gdrive','googledrive','onedrive','icloud',
      ]);
      if (regDir && !suggestionIsBuiltin) {
        try {
          const scoutPath = path.join(regDir, 'skill-scout.cjs');
          if (fs.existsSync(scoutPath)) {
            // Extract the service name: strip filler words to get the key noun
            // e.g. "send a slack message" → "slack", "stripe payment" → "stripe",
            //      "tic tac toe game" → "tic" (length <4 → skipped → project_build)
            // Priority: use the LLM suggestion first (most accurate), then fall back to capability words.
            // (SCOUT_FILLER_WORDS and extractScoutServiceName are declared above, in outer scope)
            const suggestionWords = extractScoutServiceName(suggestion);
            const capabilityWords = extractScoutServiceName(capability || userMessage);
            const serviceName = (suggestionWords[0] || capabilityWords[0] || '');
            if (serviceName.length >= 3) {
              if (BROWSER_ONLY_SERVICES.has(serviceName)) {
                logger.info(`[Node:PlanSkills] Scout intercept: "${serviceName}" is a browser-only service — skipping dynamic discovery, using browser.act directly`);
              } else {
              logger.info(`[Node:PlanSkills] Scout intercept: static miss — trying dynamic discovery for "${serviceName}"`);
              const { discover } = require(scoutPath);
              const { cliMatch, apiMatch } = await discover(serviceName, capability || userMessage);
              const dynamicMatch = cliMatch || apiMatch;
              if (dynamicMatch) {
                logger.info(`[Node:PlanSkills] Scout intercept: dynamic discovery found "${dynamicMatch.provider}" (${dynamicMatch.type}) for "${serviceName}"`);
                const dynamicMatches = [dynamicMatch];
                if (progressCallback) progressCallback({
                  type: 'plan_ready',
                  steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })),
                  intent: state.intent?.type || 'command_automate',
                });
                if (progressCallback) progressCallback({
                  type: 'scout_match',
                  capability: capability || userMessage,
                  suggestion,
                  matches: dynamicMatches,
                });
                return {
                  ...state,
                  skillPlan,
                  skillCursor: 0,
                  scoutPending: true,
                  scoutCapability: capability || userMessage,
                  scoutMatches: dynamicMatches,
                  recoveryAction: 'scout_select',
                  pendingQuestion: {
                    question: `I found a tool that can handle "${capability || userMessage}". Would you like to use it?`,
                    options: dynamicMatches.map(m => `${m.provider} (${m.type})`),
                    context: { scoutMatches: dynamicMatches, capability: capability || userMessage },
                    _isScoutSelect: true,
                  },
                  commandExecuted: false,
                };
              }
              logger.info(`[Node:PlanSkills] Scout intercept: dynamic discovery found nothing for "${serviceName}" — falling through to browser.act`);
              } // end !BROWSER_ONLY_SERVICES check
            }
          }
        } catch (scoutErr) {
          logger.warn(`[Node:PlanSkills] skill-scout dynamic discovery error (non-fatal): ${scoutErr.message}`);
        }
      }

      // ── Local recurring reminder shortcut (node-cron via SkillScheduler) ──────
      // If the LLM returned needs_skill for a local macOS reminder (no external API),
      // create a minimal notification skill with a cron schedule in its frontmatter
      // and install it. The SkillScheduler daemon (already running in command-service)
      // reads the schedule field and registers a node-cron job automatically.
      //
      // Architecture: skill.md (schedule: "0 6 * * *") + index.cjs (osascript notify)
      //               → skill.install → curl /skill.schedule/sync → SkillScheduler picks up
      {
        const capLow = (capability || userMessage).toLowerCase();
        const sugLow = (suggestion || '').toLowerCase();
        const msgLow = userMessage.toLowerCase();
        const EXTERNAL_SVC = ['gmail', 'twilio', 'sms', 'text message', 'clicksend', 'vonage', 'slack', 'discord', 'telegram', 'whatsapp', 'sendgrid', 'mailgun', 'email service'];
        const isExternalSvc = EXTERNAL_SVC.some(s => sugLow.includes(s) || capLow.includes(s));
        const LOCAL_REMINDER_KWS = ['remind', 'reminder', 'alarm', 'cold plunge', 'plunge', 'workout', 'exercise', 'meditation', 'wake up', 'stand up', 'break', 'hydrat', 'drink water', 'stretch'];
        const SCHEDULE_KWS = ['every morning', 'every day', 'every night', 'daily', 'weekly', 'at 6', 'at 7', 'at 8', 'at 9', 'at 10', 'at 11', 'at 12', 'am', 'pm'];
        // Bridge action keywords: tasks requiring AI reasoning at fire time (access current state/data).
        // "remind me to X" stays notify even if X contains these words — explicit "remind" overrides.
        const BRIDGE_ACTION_KWS = ['update', 'review', 'check', 'go through', 'organize', 'summarize', 'draft', 'process', 'clean up', 'analyze', 'categorize', 'compile', 'go over', 'look at', 'write up'];
        const hasExplicitRemind = /\b(remind\s+me|reminder|set\s+(a|an)\s+(reminder|alarm))\b/i.test(userMessage);
        const hasReminderKw = LOCAL_REMINDER_KWS.some(k => capLow.includes(k) || msgLow.includes(k));
        const hasScheduleKw = SCHEDULE_KWS.some(k => capLow.includes(k) || msgLow.includes(k));
        const hasBridgeKw   = !hasExplicitRemind && BRIDGE_ACTION_KWS.some(k => capLow.includes(k) || msgLow.includes(k));

        // ── Tier classification ────────────────────────────────────────────────
        // notify: pure nudge — user does the action, ThinkDrop just beeps
        // bridge: ThinkDrop executes an agentic task at fire time (needs fresh context)
        // script: deterministic code that can be fully pre-written (handled elsewhere)
        const reminderTier = hasBridgeKw ? 'bridge' : 'notify';

        if (!isExternalSvc && (hasReminderKw || hasScheduleKw || hasBridgeKw)) {
          // ── Parse time ──────────────────────────────────────────────────────
          const fullText = `${userMessage} ${capability || ''}`;
          const timeMatch = fullText.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
                         || fullText.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/i);
          let hour = 6; let minute = 0;
          if (timeMatch) {
            hour = parseInt(timeMatch[1], 10);
            minute = parseInt(timeMatch[2] || '0', 10);
            const period = (timeMatch[3] || '').toLowerCase();
            if (period === 'pm' && hour < 12) hour += 12;
            if (period === 'am' && hour === 12) hour = 0;
          }
          const minuteStr = minute.toString().padStart(2, '0');

          // ── Build skill name + label ────────────────────────────────────────
          const STOP_WORDS = new Set(['my','a','an','the','at','every','morning','evening','daily','to','for','of','on','in','sessions','session','schedule','me','i','set','give','put','remind','reminder','alarm','weekly','nightly','each','tonight','night']);
          const labelWords = (capability || userMessage).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w) && !/^\d/.test(w)).slice(0, 3);
          const label = labelWords.length > 0 ? labelWords.join('.') : 'daily';
          const skillName = `reminder.${label}`;
          const skillDir = `$HOME/.thinkdrop/skills/${skillName}`;

          // ── cron expression: "minute hour * * *" (daily) ───────────────────
          const cronExpr = `${minute} ${hour} * * *`;

          // ── Human-readable title & notification message ─────────────────────
          const notifTitle = `ThinkDrop Reminder`;
          const notifMsg   = (capability || userMessage).split(' ').slice(0, 8).join(' ');

          // ── Build skill.md based on tier ────────────────────────────────────
          let skillMd, setupScript, reminderPlan;

          if (reminderTier === 'notify') {
            // ── NOTIFY tier: SkillScheduler fires osascript directly, no index.cjs ──
            skillMd = [
              `---`,
              `name: ${skillName}`,
              `schedule: "${cronExpr}"`,
              `type: notify`,
              `title: ${notifTitle}`,
              `message: ${notifMsg}`,
              `description: Daily reminder — ${notifMsg}`,
              `---`,
              ``,
              `## Plan`,
              `Fire a macOS notification every day at ${hour}:${minuteStr}.`,
            ].join('\n');

            setupScript = [
              `mkdir -p "${skillDir}"`,
              `cat > "${skillDir}/skill.md" << 'SKILL_EOF'`,
              skillMd,
              `SKILL_EOF`,
              `echo "✅ Reminder skill (notify) written: ${skillName}"`,
            ].join('\n');

            reminderPlan = [
              {
                skill: 'shell.run',
                description: `Write notify skill.md for "${label}" (fires osascript at ${hour}:${minuteStr} daily)`,
                args: { cmd: 'bash', argv: ['-c', setupScript] },
              },
              {
                skill: 'skill.install',
                description: `Register ${skillName} so SkillScheduler picks up the cron`,
                args: { skillPath: `${homeDir}/.thinkdrop/skills/${skillName}/skill.md` },
              },
              {
                skill: 'shell.run',
                description: `Sync SkillScheduler to activate the cron immediately`,
                args: { cmd: 'bash', argv: ['-c', `curl -s -X POST http://127.0.0.1:3007/skill.schedule/sync && echo "✅ node-cron activated: ${skillName} at ${hour}:${minuteStr} daily"`] },
              },
            ];

            logger.info(`[Node:PlanSkills] Local reminder intercept [notify]: "${label}" cron="${cronExpr}"`);

          } else {
            // ── BRIDGE tier: SkillScheduler writes WS:INSTRUCTION → Electron executes ──
            // Full user message becomes the instruction so the AI has complete context at fire time.
            const bridgeInstruction = userMessage;

            skillMd = [
              `---`,
              `name: ${skillName}`,
              `schedule: "${cronExpr}"`,
              `type: bridge`,
              `title: ${label}`,
              `instruction: ${bridgeInstruction}`,
              `description: Scheduled task — ${notifMsg}`,
              `---`,
              ``,
              `## Plan`,
              `At fire time, ThinkDrop executes: "${bridgeInstruction}"`,
            ].join('\n');

            setupScript = [
              `mkdir -p "${skillDir}"`,
              `cat > "${skillDir}/skill.md" << 'SKILL_EOF'`,
              skillMd,
              `SKILL_EOF`,
              `echo "✅ Bridge skill written: ${skillName}"`,
            ].join('\n');

            reminderPlan = [
              {
                skill: 'shell.run',
                description: `Write bridge skill.md for "${label}" (AI task at ${hour}:${minuteStr} daily)`,
                args: { cmd: 'bash', argv: ['-c', setupScript] },
              },
              {
                skill: 'skill.install',
                description: `Register ${skillName} so SkillScheduler picks up the cron`,
                args: { skillPath: `${homeDir}/.thinkdrop/skills/${skillName}/skill.md` },
              },
              {
                skill: 'shell.run',
                description: `Sync SkillScheduler to activate the cron immediately`,
                args: { cmd: 'bash', argv: ['-c', `curl -s -X POST http://127.0.0.1:3007/skill.schedule/sync && echo "✅ node-cron activated: ${skillName} at ${hour}:${minuteStr} daily"`] },
              },
            ];

            logger.info(`[Node:PlanSkills] Local reminder intercept [bridge]: "${label}" cron="${cronExpr}"`);
          }

          if (progressCallback) progressCallback({
            type: 'plan_ready',
            steps: reminderPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })),
            intent: state.intent?.type || 'command_automate',
          });
          return {
            ...state,
            skillPlan: reminderPlan,
            skillCursor: 0,
            planError: null,
            recoveryContext: null,
            pendingSkillName: skillName,
          };
        }
      }

      // ── No CLI/API match (static or dynamic) — re-ask the LLM with browser.act context ──
      // The LLM returned needs_skill, but scout found no installable CLI or API.
      // Re-invoke the LLM with an explicit note that no CLI/API exists so it plans
      // using browser.act + playwright-cli directly, exactly like "go to ChatGPT and
      // search for X". The LLM decides the steps — we don't hardcode them here.
      logger.info(`[Node:PlanSkills] Scout intercept: no CLI/API match — re-planning with browser.act hint for "${capability || userMessage}"`);
      const browserHintQuery = `TASK: Convert the following user request into a JSON skill plan.
OS: ${os}
Home directory: ${homeDir}
User request: "${userMessage}"
IMPORTANT: No CLI binary or installable npm/API package was found for this task. Do NOT output needs_skill. Use browser.act with playwright-cli to accomplish the task directly in the browser (navigate, snapshot, interact, synthesize). Plan it exactly like you would for "go to ChatGPT and search for X".${domainContextNote}${installedSkillsNote}${cliPreflightNote}${agentContextNote}${discoveryNote}${siteRulesBlock}${recoveryNote}${profileContextNote}${credentialContextNote}${browserSessionNote}${priorResultsNote}${conversationNote}${taggedContextNote}`;

      const browserHintPayload = {
        query: browserHintQuery,
        context: {
          systemInstructions: effectiveSystemPrompt,
          conversationHistory: [],
          sessionId: context?.sessionId,
          userId: context?.userId,
          intent: 'command_automate',
        },
        options: { maxTokens: 2400, temperature: 0.1, fastMode: false },
      };
      let browserFallbackRaw;
      try {
        browserFallbackRaw = await backend.generateAnswer(browserHintQuery, browserHintPayload, browserHintPayload.options, null);
      } catch (llmErr) {
        logger.warn(`[Node:PlanSkills] browser.act re-plan LLM call failed: ${llmErr.message}`);
        browserFallbackRaw = null;
      }
      const browserFallbackPlan = browserFallbackRaw ? parsePlan(browserFallbackRaw, logger) : null;
      if (browserFallbackPlan && Array.isArray(browserFallbackPlan) && browserFallbackPlan.length > 0 &&
          !browserFallbackPlan.some(s => s.skill === 'needs_skill')) {
        logger.info(`[Node:PlanSkills] Scout intercept: browser.act re-plan produced ${browserFallbackPlan.length} steps`);
        if (progressCallback) progressCallback({
          type: 'plan_ready',
          steps: browserFallbackPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })),
          intent: state.intent?.type || 'command_automate',
        });
        return {
          ...state,
          skillPlan: browserFallbackPlan,
          skillCursor: 0,
          scoutPending: false,
          planError: null,
          recoveryContext: null,
        };
      }
      // LLM still returned needs_skill or failed — nothing more we can do in this node
      logger.warn(`[Node:PlanSkills] Scout intercept: browser.act re-plan returned no usable steps — passing through`);
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // Only emit plan_ready when NOT gating for approval — otherwise PlanPanel and
    // AutomationProgress both activate simultaneously.
    if (!(!recoveryContext && skillPlan.length >= 2)) {
      if (progressCallback) progressCallback({ type: 'plan_ready', steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })), intent: state.intent?.type || 'command_automate', recoveryReplan: !!recoveryContext });
    }

    // ── RAG learn: if no snippet matched, extract a reusable pattern and save it ─
    // This is fire-and-forget — it runs async after the plan is returned.
    // Skip for recovery replans (recoveryContext set) — those are one-off patches, not reusable.
    // Skip short plans (1-step) — not worth storing.
    if (!skillPromptMatched && !recoveryContext && mcpAdapter && skillPlan.length >= 2) {
      setImmediate(async () => {
        try {
          // Ask LLM to extract a short, reusable skill pattern from the plan
          const extractQuery = `Given this user task and the skill plan generated for it, write a concise reusable skill pattern (2-5 sentences max) that captures HOW to accomplish this type of task. Focus on which skills to use, in what order, and any critical args or constraints. Do NOT include specific values (URLs, filenames, names) — keep it generic so it applies to similar future tasks.

User task: "${userMessage}"
Generated plan summary: ${skillPlan.slice(0, 4).map(s => `${s.skill}(${s.description || JSON.stringify(s.args).substring(0, 60)})`).join(' → ')}

Output ONLY the pattern text. No markdown, no explanation.`;

          const patternRaw = await backend.generateAnswer(extractQuery, {
            query: extractQuery,
            context: { systemInstructions: 'You extract reusable skill patterns from task examples. Be concise and generic.', conversationHistory: [], intent: 'extract_pattern' },
            options: { maxTokens: 150, temperature: 0.1, fastMode: true }
          }, { maxTokens: 150, temperature: 0.1, fastMode: true }, null).catch(() => null);

          if (patternRaw && patternRaw.trim().length > 20) {
            // Derive tags from skills used and key words in the user message
            const skillsUsed = [...new Set(skillPlan.map(s => s.skill))];
            const taskWords = userMessage.toLowerCase().match(/\b(github|git|pr|pull request|slack|gmail|jira|linear|notion|file|image|email|message|calendar|weather|search|browser|install|build|deploy|convert|compress|rename|move|delete)\b/g) || [];
            const tags = [...new Set([...skillsUsed, ...taskWords])].slice(0, 6);

            await mcpAdapter.callService('user-memory', 'skill_prompt.upsert', {
              tags,
              promptText: patternRaw.trim()
            }, { timeoutMs: 5000 }).catch(e => logger.warn(`[Node:PlanSkills] RAG save failed: ${e.message}`));

            logger.info(`[Node:PlanSkills] RAG: saved new skill pattern (tags: ${tags.join(', ')})`);
          }
        } catch (learnErr) {
          logger.warn(`[Node:PlanSkills] RAG learn failed (non-fatal): ${learnErr.message}`);
        }
      });
    }

    // ── Post-LLM-plan token resolution ───────────────────────────────────────
    // The LLM may copy {{TO}}/{{BODY}} tokens literally from a contract template.
    // Resolve all runtime params and substitute them into any shell.run steps.
    if (Array.isArray(skillPlan)) {
      const _rtParams = buildRuntimeParams(userMessage, profileContext, priorSynthesizedContent);
      if (Object.keys(_rtParams).length > 0) {
        skillPlan = skillPlan.map(step => {
          if (step.skill !== 'shell.run') return step;
          const _cmd = step.args?.argv?.[1];
          if (!_cmd || !_cmd.includes('{{')) return step;
          const _resolved = substituteTokens(_cmd, _rtParams, logger);
          if (_resolved !== _cmd) {
            logger.info(`[Node:PlanSkills] Post-plan token substitution applied to shell.run step`);
            return { ...step, args: { ...step.args, argv: [step.args.argv[0], _resolved] } };
          }
          return step;
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── {{synthesisAnswer}} order validation + auto-fix ───────────────────────
    // INVARIANT: any step whose serialized args contain '{{synthesisAnswer}}' MUST
    // appear AFTER the synthesize step that produces it.  If the LLM got the order
    // wrong (consumer before producer), auto-reorder rather than silently fail at
    // runtime with a literal '{{synthesisAnswer}}' typed into a form field.
    if (Array.isArray(skillPlan)) {
      const _argsStr = s => JSON.stringify(s.args || {});
      if (skillPlan.some(s => _argsStr(s).includes('{{synthesisAnswer}}'))) {
        // A consumer step is only "bad" if NO synthesize step exists BEFORE it.
        // Multi-stage pipelines (e.g. read email → synthesize → ask AI with {{synthesisAnswer}}
        // → synthesize → reply with {{synthesisAnswer}}) are intentionally interleaved and must
        // NOT be reordered — each {{synthesisAnswer}} consumer follows its own preceding synthesize.
        const _bad = skillPlan.filter((s, i) => {
          if (!_argsStr(s).includes('{{synthesisAnswer}}')) return false;
          // Bad only if there is no synthesize at any earlier index
          return !skillPlan.slice(0, i).some(p => p.skill === 'synthesize');
        });
        if (_bad.length > 0) {
          logger.warn(`[Node:PlanSkills] {{synthesisAnswer}} order violation: ${_bad.length} consumer step(s) appear before any synthesize — auto-reordering`);
          const _consumers = skillPlan.filter(s => _argsStr(s).includes('{{synthesisAnswer}}'));
          const _producers = skillPlan.filter(s => !_argsStr(s).includes('{{synthesisAnswer}}'));
          // producers already contain the synthesize step; consumers go after all producers
          skillPlan = [..._producers, ..._consumers];
          logger.info(`[Node:PlanSkills] Plan reordered: [${_producers.map(s => s.skill).join(' → ')}] → [${_consumers.map(s => s.skill).join(' → ')}]`);
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Approval gate: multi-step plans require user review before execution ──
    // Only fires for fresh LLM-generated plans (not recovery replans, not
    // single-step plans, not multi-intent stacks). Writes a .md file with the
    // serialized skill plan so the PlanPanel can render it for approval, and so
    // executeCommand can mark it 'complete' after 100% successful execution.
    if (!recoveryContext && skillPlan.length >= 2) {
      const _ts = Date.now();
      const _planId = `plan-${_ts}`;
      const _planFile = path.join(PLANS_DIR, `${_planId}.md`);
      const _mdContent = serializeSkillPlanToMd(skillPlan, state.message || userMessage, _planId, state.context?.sessionId);
      try {
        fs.mkdirSync(PLANS_DIR, { recursive: true });
        fs.writeFileSync(_planFile, _mdContent, 'utf8');
        logger.info(`[Node:PlanSkills] Approval gate: plan written to ${_planFile}`);
      } catch (_writeErr) {
        logger.warn(`[Node:PlanSkills] Approval gate: failed to write plan file: ${_writeErr.message}`);
      }
      const _skillPlanB64 = Buffer.from(JSON.stringify(skillPlan)).toString('base64');
      if (progressCallback) progressCallback({
        type: 'plan:generated',
        planFile: _planFile,
        planId: _planId,
        content: _mdContent,
        title: (userMessage || '').split(/\s+/).slice(0, 6).join(' '),
        skillPlanJson: _skillPlanB64,
        generatedBy: 'planSkills',
      });
      return {
        ...state,
        awaitingPlanApproval: true,
        _skillPlanFile: _planFile,
        skillPlan: null,
        skillCursor: 0,
        recoveryContext: null,
        planError: null,
        pendingSkillName: state.pendingSkillName || null,
      };
    }

    return {
      ...state,
      skillPlan,
      skillCursor: 0,          // Always reset cursor on a fresh/re-plan
      recoveryContext: null,   // Clear recovery context after re-plan
      planError: null,
      // Persist the locked skill name so replans use the same name (prevents duplicate skills)
      pendingSkillName: state.pendingSkillName || null,
      // Clear stale skillResults from the failed attempt so the all_done failedCount is 0.
      // skillResults was already read above (priorResultsNote) before this return so LLM had
      // the prior step outputs as context — it's safe to reset for the fresh execution.
      skillResults: recoveryContext ? [] : state.skillResults,
    };

  } catch (error) {
    logger.error('[Node:PlanSkills] Error:', error.message);
    if (progressCallback) progressCallback({ type: 'plan_error', error: error.message });
    return {
      ...state,
      planError: `Skill planning failed: ${error.message}`
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Contract-driven execution helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the ## Auth block and all ## Commands code blocks from a skill.md contract.
 *
 * Returns:
 *   {
 *     authScript: string | null,   — full bash code from the ## Auth section
 *     commands: [{ heading, code }] — one entry per ### heading + fenced bash block
 *   }
 * or null if the contract has no ## Commands section or no parseable code blocks.
 */
function parseContractCommands(contractMd) {
  if (!contractMd || typeof contractMd !== 'string') return null;

  // Extract ## Auth bash block — only from the text BETWEEN ## Auth and the next ## section.
  // Without the boundary, the regex greedily matches into ## Commands and picks up the SMS template.
  let authScript = null;
  const authSectionBody = contractMd.match(/##\s+Auth\s*\n([\s\S]*?)(?=\n##\s)/i);
  if (authSectionBody) {
    const authCodeBlock = authSectionBody[1].match(/```(?:bash|sh)?\s*\n([\s\S]*?)\n```/i);
    if (authCodeBlock) authScript = authCodeBlock[1].trim();
  }

  // Find the ## Commands section
  const cmdSectionMatch = contractMd.match(/##\s+Commands\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/i);
  if (!cmdSectionMatch) return null;

  const cmdSection = cmdSectionMatch[1];

  // Extract each ### <heading> + fenced code block pair
  const commands = [];
  const cmdBlockRe = /###\s+(.+?)\n[\s\S]*?```(?:bash|sh)?\s*\n([\s\S]*?)\n```/gi;
  let m;
  while ((m = cmdBlockRe.exec(cmdSection)) !== null) {
    commands.push({ heading: m[1].trim(), code: m[2].trim() });
  }

  // Fallback: fenced blocks without a ### heading
  if (commands.length === 0) {
    const rawBlockRe = /```(?:bash|sh)?\s*\n([\s\S]*?)\n```/gi;
    let idx = 0;
    while ((m = rawBlockRe.exec(cmdSection)) !== null) {
      commands.push({ heading: `Command ${++idx}`, code: m[1].trim() });
    }
  }

  if (commands.length === 0) return null;

  return { authScript, commands };
}

/**
 * Deterministically resolve natural-language temporal phrases in a user message into
 * concrete UTC ISO 8601 date ranges.  Zero LLM involvement — uses only new Date().
 *
 * Returns an object with 8 tokens when a phrase is matched, or null otherwise.
 * When null is returned, $(date ...) expressions stay in the template and bash
 * evaluates them at runtime (correct "from now" behaviour for unqualified queries).
 *
 * Token map:
 *   timeMin / timeMax  — ISO UTC string  — replaces $(date ...) in applyContractParams
 *   TIME_MIN / TIME_MAX — same             — replaces {{TIME_MIN}} / {{TIME_MAX}} in templates
 *   UNIX_MIN / UNIX_MAX — unix seconds    — replaces {{UNIX_MIN}} / {{UNIX_MAX}} (Slack etc.)
 *   DATE_MIN / DATE_MAX — 'YYYY-MM-DD'   — replaces {{DATE_MIN}} / {{DATE_MAX}}
 */
function resolveDateRange(userMessage, now = new Date()) {
  const msg = userMessage.toLowerCase();

  // Normalize English word-numbers to digits so phrases like "two weeks ago",
  // "three days ago", "a couple of hours" all hit the numeric regex paths below.
  const WORD_TO_N = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
  const msgN = msg.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => WORD_TO_N[w]);

  // Helper: pad to 2 digits
  const p = n => String(n).padStart(2, '0');

  // Helper: ISO UTC string from a Date object
  const iso = d => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;

  // Helper: date-only string from a Date object
  const dateOnly = d => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;

  // Helper: unix epoch seconds from a Date
  const unix = d => Math.floor(d.getTime() / 1000);

  // Helper: start of a UTC day (midnight)
  const startOfUTCDay = d => {
    const r = new Date(d);
    r.setUTCHours(0, 0, 0, 0);
    return r;
  };

  // Helper: end of a UTC day (23:59:59)
  const endOfUTCDay = d => {
    const r = new Date(d);
    r.setUTCHours(23, 59, 59, 999);
    return r;
  };

  // Helper: build the 8-token result from two Date objects
  const result = (minDate, maxDate) => ({
    timeMin:  iso(minDate),
    timeMax:  iso(maxDate),
    TIME_MIN: iso(minDate),
    TIME_MAX: iso(maxDate),
    UNIX_MIN: unix(minDate),
    UNIX_MAX: unix(maxDate),
    DATE_MIN: dateOnly(minDate),
    DATE_MAX: dateOnly(maxDate),
  });

  // ── N-based patterns (check before named patterns to avoid partial mismatches) ──

  // "N hours ago" / "last N hours" / "past N hours"
  let m = msgN.match(/\b(\d+)\s+hours?\s+ago\b/) ||
          msgN.match(/\b(?:last|past)\s+(\d+)\s+hours?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const min = new Date(now.getTime() - n * 3600 * 1000);
    return result(min, now);
  }

  // "last N days" / "past N days"
  m = msgN.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const min = new Date(now.getTime() - n * 86400 * 1000);
    return result(min, now);
  }

  // "N days ago" → the entire named day
  m = msgN.match(/\b(\d+)\s+days?\s+ago\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const target = new Date(now.getTime() - n * 86400 * 1000);
    return result(startOfUTCDay(target), endOfUTCDay(target));
  }

  // "N weeks ago" → the full ISO week that was N weeks back
  m = msgN.match(/\b(\d+)\s+weeks?\s+ago\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const anchor = new Date(now.getTime() - n * 7 * 86400 * 1000);
    const anchorDow = anchor.getUTCDay();
    const anchorDsm = (anchorDow + 6) % 7; // days since Monday
    const weekStart = new Date(anchor.getTime() - anchorDsm * 86400 * 1000);
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400 * 1000);
    return result(startOfUTCDay(weekStart), endOfUTCDay(weekEnd));
  }

  // "last N weeks" / "past N weeks"
  m = msgN.match(/\b(?:last|past)\s+(\d+)\s+weeks?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const min = new Date(now.getTime() - n * 7 * 86400 * 1000);
    return result(min, now);
  }

  // "last N months" / "past N months"
  m = msgN.match(/\b(?:last|past)\s+(\d+)\s+months?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const min = new Date(now);
    min.setUTCMonth(min.getUTCMonth() - n);
    return result(min, now);
  }

  // ── Fixed-length fuzzy-count phrases ──────────────────────────────────────────

  if (/\ba\s+couple\s+(?:of\s+)?hours?\b/.test(msg) || /\bcouple\s+(?:of\s+)?hours?\b/.test(msg)) {
    return result(new Date(now.getTime() - 2 * 3600 * 1000), now);
  }
  if (/\ba?\s*few\s+hours?\b/.test(msg)) {
    return result(new Date(now.getTime() - 3 * 3600 * 1000), now);
  }
  if (/\ba\s+couple\s+(?:of\s+)?days?\b/.test(msg) || /\bcouple\s+(?:of\s+)?days?\b/.test(msg)) {
    return result(new Date(now.getTime() - 2 * 86400 * 1000), now);
  }
  if (/\ba?\s*few\s+days?\b/.test(msg)) {
    return result(new Date(now.getTime() - 3 * 86400 * 1000), now);
  }

  // ── Time-of-day phrases ───────────────────────────────────────────────────────

  if (/\bthis\s+morning\b/.test(msg)) {
    const min = startOfUTCDay(now); // 00:00
    const max = new Date(now); max.setUTCHours(12, 0, 0, 0);
    return result(min, max);
  }
  if (/\bthis\s+afternoon\b/.test(msg)) {
    const min = new Date(now); min.setUTCHours(12, 0, 0, 0);
    const max = new Date(now); max.setUTCHours(18, 0, 0, 0);
    return result(min, max);
  }
  if (/\btonight\b|\bthis\s+evening\b/.test(msg)) {
    const min = new Date(now); min.setUTCHours(18, 0, 0, 0);
    const max = endOfUTCDay(now);
    return result(min, max);
  }

  // ── Named single-day phrases ──────────────────────────────────────────────────

  if (/\byesterday\b/.test(msg)) {
    const d = new Date(now.getTime() - 86400 * 1000);
    return result(startOfUTCDay(d), endOfUTCDay(d));
  }
  if (/\btoday\b/.test(msg)) {
    return result(startOfUTCDay(now), endOfUTCDay(now));
  }
  if (/\btomorrow\b/.test(msg)) {
    const d = new Date(now.getTime() + 86400 * 1000);
    return result(startOfUTCDay(d), endOfUTCDay(d));
  }

  // ── Weekend phrases ───────────────────────────────────────────────────────────

  // Weekday numbers: Sun=0, Mon=1, ..., Sat=6 (getUTCDay)
  // Days-since-Saturday: (dayOfWeek + 1) % 7
  if (/\blast\s+weekend\b/.test(msg)) {
    const dow = now.getUTCDay(); // 0=Sun
    const daysSinceLastSun = dow === 0 ? 7 : dow;
    const lastSun = new Date(now.getTime() - daysSinceLastSun * 86400 * 1000);
    const lastSat = new Date(lastSun.getTime() - 86400 * 1000);
    return result(startOfUTCDay(lastSat), endOfUTCDay(lastSun));
  }
  if (/\b(?:this|next)\s+weekend\b/.test(msg) || /\bthe\s+weekend\b/.test(msg)) {
    const dow = now.getUTCDay();
    const daysUntilSat = (6 - dow + 7) % 7 || 7; // days until next Saturday (min 1)
    const sat = new Date(now.getTime() + daysUntilSat * 86400 * 1000);
    const sun = new Date(sat.getTime() + 86400 * 1000);
    return result(startOfUTCDay(sat), endOfUTCDay(sun));
  }

  // ── Week phrases (ISO: Mon–Sun) ───────────────────────────────────────────────

  // Days-since-Monday: (dayOfWeek + 6) % 7 (Sun=0 → 6, Mon=1 → 0, ..., Sat=6 → 5)
  const dowNow = now.getUTCDay();
  const daysSinceMon = (dowNow + 6) % 7;

  if (/\blast\s+week\b/.test(msg)) {
    const thisMonday = new Date(now.getTime() - daysSinceMon * 86400 * 1000);
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400 * 1000);
    const lastSunday = new Date(thisMonday.getTime() - 86400 * 1000);
    return result(startOfUTCDay(lastMonday), endOfUTCDay(lastSunday));
  }
  if (/\bthis\s+week\b/.test(msg)) {
    const thisMonday = new Date(now.getTime() - daysSinceMon * 86400 * 1000);
    const thisSunday = new Date(thisMonday.getTime() + 6 * 86400 * 1000);
    return result(startOfUTCDay(thisMonday), endOfUTCDay(thisSunday));
  }
  if (/\bnext\s+week\b/.test(msg)) {
    const thisMonday = new Date(now.getTime() - daysSinceMon * 86400 * 1000);
    const nextMonday = new Date(thisMonday.getTime() + 7 * 86400 * 1000);
    const nextSunday = new Date(nextMonday.getTime() + 6 * 86400 * 1000);
    return result(startOfUTCDay(nextMonday), endOfUTCDay(nextSunday));
  }

  // ── Month phrases ─────────────────────────────────────────────────────────────

  if (/\blast\s+month\b/.test(msg)) {
    const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const mo = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
    const first = new Date(Date.UTC(y, mo, 1));
    const last = new Date(Date.UTC(y, mo + 1, 0, 23, 59, 59, 999));
    return result(first, last);
  }
  if (/\bthis\s+month\b/.test(msg)) {
    const y = now.getUTCFullYear(), mo = now.getUTCMonth();
    const first = new Date(Date.UTC(y, mo, 1));
    const last = new Date(Date.UTC(y, mo + 1, 0, 23, 59, 59, 999));
    return result(first, last);
  }
  if (/\bnext\s+month\b/.test(msg)) {
    const y = now.getUTCFullYear(), mo = now.getUTCMonth();
    const nextMo = (mo + 1) % 12;
    const nextY = mo === 11 ? y + 1 : y;
    const first = new Date(Date.UTC(nextY, nextMo, 1));
    const last = new Date(Date.UTC(nextY, nextMo + 1, 0, 23, 59, 59, 999));
    return result(first, last);
  }

  // ── Year phrases ──────────────────────────────────────────────────────────────

  if (/\blast\s+year\b/.test(msg)) {
    const y = now.getUTCFullYear() - 1;
    return result(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)));
  }
  if (/\bthis\s+year\b/.test(msg)) {
    const y = now.getUTCFullYear();
    return result(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)));
  }
  if (/\bnext\s+year\b/.test(msg)) {
    const y = now.getUTCFullYear() + 1;
    return result(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)));
  }

  // No temporal phrase matched → return null so $(date ...) stays untouched
  return null;
}

/**
 * Extract recipient, address, amount, and other runtime parameters from the user message.
 * Acts as the messaging/location/payment counterpart to resolveDateRange().
 * Returns a flat params object (Token → value) or null if nothing useful was found.
 *
 * Supported tokens:
 *   TO       — E.164 phone number of the primary recipient (or email if no phone given)
 *   PHONE    — alias for TO (some templates prefer PHONE over TO)
 *   EMAIL    — recipient email address
 *   URL      — URL mentioned in the message
 *   AMOUNT   — monetary amount (digits, optional decimals)
 *   ZIP      — ZIP code
 *   FILENAME — filename mentioned in the message
 */
function extractMessageParams(userMessage) {
  if (!userMessage) return null;
  const params = {};
  const msg = userMessage.trim();

  // ── Phone number extraction (priority order) ───────────────────────────────
  // 1. "to <10-digit US>" with optional separators
  const _toPhone = msg.match(/\bto\s+\+?1?\s*[-.]?\s*([2-9]\d{2})\s*[-.]?\s*(\d{3})\s*[-.]?\s*(\d{4})\b/i);
  if (_toPhone) {
    params.TO = `+1${_toPhone[1]}${_toPhone[2]}${_toPhone[3]}`;
    params.PHONE = params.TO;
  } else {
    // 2. Bare E.164 already in message
    const _e164 = msg.match(/(\+1[2-9]\d{9}|\+[2-9]\d{6,14})\b/);
    if (_e164) {
      params.TO = _e164[1];
      params.PHONE = _e164[1];
    } else {
      // 3. Bare 10-digit US number (no country code)
      const _bare10 = msg.match(/\b([2-9]\d{2})[.\-\s]?(\d{3})[.\-\s]?(\d{4})\b/);
      if (_bare10) {
        params.TO = `+1${_bare10[1]}${_bare10[2]}${_bare10[3]}`;
        params.PHONE = params.TO;
      }
    }
  }

  // ── Email extraction ───────────────────────────────────────────────────────
  const _email = msg.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
  if (_email) {
    params.EMAIL = _email[1];
    if (!params.TO) params.TO = _email[1]; // use email as TO when no phone given
  }

  // ── URL extraction ─────────────────────────────────────────────────────────
  const _url = msg.match(/https?:\/\/[^\s"'<>]+/i);
  if (_url) params.URL = _url[0];

  // ── Monetary amount ────────────────────────────────────────────────────────
  const _amt = msg.match(/\$\s*(\d+(?:\.\d{1,2})?)\b/)
    || msg.match(/\b(\d+(?:\.\d{2}))\s*(?:dollars?|usd|eur|gbp)\b/i);
  if (_amt) params.AMOUNT = _amt[1];

  // ── ZIP code ───────────────────────────────────────────────────────────────
  const _zip = msg.match(/\b(\d{5}(?:-\d{4})?)\b/);
  if (_zip) params.ZIP = _zip[1];

  // ── Filename ──────────────────────────────────────────────────────────────
  const _file = msg.match(/\b([\w.\-]+\.(pdf|docx?|xlsx?|csv|txt|png|jpe?g|gif|mp3|mp4|zip))\b/i);
  if (_file) params.FILENAME = _file[1];

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Build the full set of runtime substitution params for a user message.
 * Combines extractMessageParams (phone/email/url), profile facts fallback,
 * and shell-safe BODY from priorSynthesizedContent.
 *
 * Does NOT overwrite an existing value — callers can pre-seed the object.
 */
function buildRuntimeParams(userMessage, profileContext, priorSynthesizedContent) {
  const params = {};
  const msgParams = extractMessageParams(userMessage);
  if (msgParams) Object.assign(params, msgParams);
  if (!params.TO && profileContext?.facts) {
    const myPhone = profileContext.facts.find(f => f.field === 'my_phone');
    if (myPhone?.value) { params.TO = myPhone.value; params.PHONE = myPhone.value; }
    const myEmail = profileContext.facts.find(f => f.field === 'my_email');
    if (myEmail?.value && !params.EMAIL) params.EMAIL = myEmail.value;
  }
  if (priorSynthesizedContent && !params.BODY) {
    params.BODY = priorSynthesizedContent
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n')
      .slice(0, 1200);
  }
  // ── DEBUG (remove after fix confirmed) ──────────────────────────────────────
  console.info(
    '[buildRuntimeParams] msg="%s" | TO=%s | BODY_LEN=%d | profileFacts=%d | priorBodyLen=%d',
    (userMessage || '').slice(0, 80),
    params.TO ?? '(none)',
    params.BODY?.length ?? 0,
    profileContext?.facts?.length ?? 0,
    priorSynthesizedContent?.length ?? 0
  );
  // ────────────────────────────────────────────────────────────────────────────
  return params;
}

/**
 * Substitute all {{TOKEN}} placeholders in `code` with values from `params`.
 * Uses split/join instead of String.replace() to avoid $-special-char issues
 * (e.g. $& or $1 in replacement strings when values contain $ characters).
 */
function substituteTokens(code, params, logger) {
  if (!code || !code.includes('{{')) return code;
  let result = code;
  for (const [k, v] of Object.entries(params)) {
    const tok = `{{${k}}}`;
    if (result.includes(tok)) {
      result = result.split(tok).join(String(v));
      if (logger) logger.info(`[Node:PlanSkills] substituteTokens: resolved {{${k}}}`);
    }
  }
  return result;
}

/**
 * Ask the LLM to pick the right command template by index only.
 * PII (phone, email, message body) is NOT sent to the LLM — all substitutions
 * are applied deterministically after this call via extractMessageParams() and
 * priorSynthesizedContent in applyContractParams / the split/join safety pass.
 *
 * Returns { index: number, substitutions: [], params: {} } or null on failure.
 */
async function selectCommandTemplate(commands, userMessage, backend) {
  // Scrub PII from the message before it touches the LLM.
  // Replace phone numbers, emails, and URLs with neutral placeholders.
  const _scrubbedMsg = userMessage
    .replace(/\+?1?[\s.-]?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[PHONE]')
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/https?:\/\/\S+/g, '[URL]');

  const commandList = commands
    .map((c, i) => `--- Template ${i}: ${c.heading} ---`)
    .join('\n');

  const query = `User request: "${_scrubbedMsg}"

Available command templates:
${commandList}

Output ONLY valid JSON with the best matching template index (0-based):
{ "index": <number> }`;

  try {
    const raw = await backend.generateAnswer(query, {
      query,
      context: { conversationHistory: [], systemInstructions: 'You are a command template selector. Pick the best matching template index and output only { "index": N }. Do not output anything else.', intent: 'command_automate' },
      options: { maxTokens: 20, temperature: 0, fastMode: true },
    }, { maxTokens: 20, temperature: 0, fastMode: true }, null);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.index !== 'number' || parsed.index < 0 || parsed.index >= commands.length) return null;
    // Return empty substitutions — all token replacement is done post-LLM
    return { index: parsed.index, substitutions: [], params: {} };
  } catch (_) {
    return null;
  }
}

/**
 * Substitute parameter values into a command template.
 * Replaces $(date ...) subshells with pre-computed ISO strings when the LLM
 * supplied timeMin/timeMax/date params, and splices in any other key=value pairs.
 */
function applyContractParams(code, sel) {
  let result = code;

  // ── Primary: literal find/replace substitutions from LLM ──────────────────
  const substitutions = Array.isArray(sel.substitutions) ? sel.substitutions : [];
  const sorted = [...substitutions]
    .filter(s => s && typeof s.find === 'string' && s.find.length > 0 && s.replace !== undefined)
    .filter(s => !/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(s.find.trim())) // never strip shell $VAR / ${VAR} env references
    .filter(s => !/^\$\(date\b/.test(s.find.trim())) // never replace $(date ...) — bash evaluates at runtime
    .sort((a, b) => b.find.length - a.find.length); // longest match first
  for (const { find, replace } of sorted) {
    result = result.split(find).join(String(replace));
  }

  // ── Fallback: legacy params-based date expansion ───────────────────────────
  const params = sel.params || {};
  if (params.timeMin) {
    result = result.replace(/\$\(date[^)]*%Y-%m-%dT%H:%M:%SZ[^)]*\)/g, params.timeMin);
    result = result.replace(/\$\(date[^)]*%Y-%m-%dT00:00:00Z[^)]*\)/g, params.timeMin);
    result = result.replace(/\$\(date[^)]*%Y-%m-%dT[^)]*\)/g, params.timeMin);
  }
  if (params.timeMax) {
    result = result.replace(/(\?|&)(timeMax=)[^&"\s]*/g, `$1$2${params.timeMax}`);
    if (!result.includes('timeMax=')) result = result.replace(/(\?[^"]*)(")/, `$1&timeMax=${params.timeMax}$2`);
  }
  if (params.date) result = result.replace(/\$\(date[^)]*\)/g, params.date);
  for (const [k, v] of Object.entries(params)) {
    if (k === 'timeMin' || k === 'timeMax' || k === 'date') continue;
    // split/join avoids String.replace() $-special-character substitution issues
    // (e.g. $& or $1 in replacement string when body/phone contains $ characters)
    const _tok = `{{${k}}}`;
    if (result.includes(_tok)) result = result.split(_tok).join(String(v));
  }

  return result;
}

/**
 * Extract and parse a JSON array/object from LLM output.
 * Uses jsonrepair to handle the full spectrum of LLM JSON pathologies:
 * control characters, bad escapes, trailing commas, missing quotes,
 * truncated output, markdown fences, smart quotes, JS comments, etc.
 */
function parsePlan(raw, logger) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  const _fenceMatch = text.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\s*```/);
  if (_fenceMatch) {
    text = _fenceMatch[1].trim();
  } else {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  // Narrow to the first JSON array or object to drop any prose prefix/suffix
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    text = text.substring(arrayStart);
  } else if (objectStart !== -1) {
    text = text.substring(objectStart);
  } else {
    logger.warn('[Node:PlanSkills] JSON parse failed: no [ or { found in output');
    return null;
  }

  try {
    // jsonrepair handles control chars, bad escapes, trailing commas, truncation,
    // smart-quotes, missing brackets, JS comments — anything the LLM throws.
    return JSON.parse(jsonrepair(text));
  } catch (e) {
    logger.warn('[Node:PlanSkills] JSON parse failed:', e.message);
    return null;
  }
}

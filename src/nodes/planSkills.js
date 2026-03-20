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
  const promptFile = isWindows ? 'plan-skills-windows.md' : 'plan-skills.md';
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
  const userMessage = resolvedMessage || message;

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
  // Allow creator fast-path even during recovery replans — creatorSkillName is the
  // ground truth and must NOT be overridden by LLM hallucination during recovery.
  if (state.creatorSkillName && state.creatorSkillPath) {
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
  if (conversationHistory && conversationHistory.length > 0) {
    const recentTurns = conversationHistory.slice(-6); // last 3 exchanges
    const turnLines = recentTurns
      .filter(m => m.content && m.content.trim())
      .map(m => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = m.content.trim();
        // Assistant messages with step outputs (from logConversation richAssistantText)
        // contain critical filenames/paths — include up to 2000 chars for those.
        // User messages: 300 chars is plenty.
        const limit = (m.role === 'assistant' && content.includes('Step outputs:')) ? 2000 : 300;
        return `${role}: ${content.substring(0, limit)}`;
      });
    if (turnLines.length > 0) {
      conversationNote = `\n\nRECENT CONVERSATION (use this to resolve references like "that file", "it", "the result"):\n${turnLines.join('\n')}`;
    }

    // Extract the last synthesized answer from conversation history so that
    // follow-up messaging tasks ("text this to me", "email this info") use the
    // actual prior content as the message body — not a placeholder.
    const lastAssistantMsg = recentTurns.slice().reverse().find(m => m.role === 'assistant');
    if (lastAssistantMsg?.content) {
      const stepOutputsIdx = lastAssistantMsg.content.indexOf('Step outputs:');
      if (stepOutputsIdx !== -1) {
        priorSynthesizedContent = lastAssistantMsg.content.slice(stepOutputsIdx + 'Step outputs:'.length).trim().slice(0, 2000);
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
    messagingBodyNote = `\n\n⚠️ MESSAGE BODY — CRITICAL:\nThe user said "${userMessage}". The content they want sent is from the PREVIOUS task. Use this EXACT content as the message body (do not summarize or replace with a placeholder):\n---\n${priorSynthesizedContent}\n---\nIMPORTANT: Use this full text as the MSG/body variable in your shell.run command. Do NOT use "Here is the information you requested." or any other placeholder.`;
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

      // Extract hostnames from URLs in the message and active browser URL
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
  if (mcpAdapter) {
    try {
      const isRes = await mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 3000 }).catch(() => null);
      const isRaw = isRes?.data || isRes;
      const isNames = Array.isArray(isRaw?.results) ? isRaw.results : [];
      if (isNames.length > 0) {
        const isMdSkill = s => s.execType === 'shell' || (s.execPath || '').endsWith('.md');
        const nodeSkills  = isNames.filter(s => !isMdSkill(s));
        const shellSkills = isNames.filter(s =>  isMdSkill(s));
        const noteParts = [];
        if (nodeSkills.length > 0) {
          const lines = nodeSkills.map(s => `  - ${s.name}: ${s.description || 'no description'}`).join('\n');
          noteParts.push(`INSTALLED SKILLS (use external.skill ONLY when the skill's purpose DIRECTLY matches the task — do NOT use as a fallback for vaguely related tasks):\n${lines}\n  Usage: { "skill": "external.skill", "args": { "name": "<skill-name>", ...args } }\n  RULE: If the task cannot be fulfilled by one of these skills exactly, use shell.run or needs_skill instead. Never pick an installed skill just because it seems related.`);
        }
        if (shellSkills.length > 0) {
          const lines = shellSkills.map(s => `  - ${s.name}: ${s.description || 'no description'}`).join('\n');
          noteParts.push(`SHELL-PLAN SKILLS (contract_md defines steps — generate shell.run steps directly, do NOT use external.skill):\n${lines}\n  RULE: Only use these when the task directly matches the skill's stated purpose.`);
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
  if (state.matchedSkillName && mcpAdapter) {
    try {
      const scRes = await mcpAdapter.callService('user-memory', 'skill.get', {
        name: state.matchedSkillName
      }, { timeoutMs: 3000 }).catch(() => null);
      const scData = scRes?.data || scRes;
      const contractMd = scData?.contractMd || scData?.contract_md || '';
      if (contractMd && contractMd.trim()) {
        skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. You MUST generate shell.run steps with curl commands from the ## Commands or ## Plan section below.\n2. FORBIDDEN: Do NOT use "${state.matchedSkillName}" as a skill name in any step. It is NOT a dispatchable skill.\n3. FORBIDDEN: Do NOT use external.skill for this.\n4. The ONLY way to execute this skill is via shell.run with the curl command shown in the contract.\n\n${contractMd.slice(0, 3000)}`;
        logger.info(`[Node:PlanSkills] Injected contract_md for matched skill "${state.matchedSkillName}" (${contractMd.length} chars)`);
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
            if (!c.cli) {
              if (c.isOAuth)  lines.push(`${c.service}: OAuth-based service — no CLI, browser or API flow required`);
              else if (c.isApiKey) lines.push(`${c.service}: API key required (${c.apiKeyEnvVar || 'check service settings'}) — use shell.run curl with the key`);
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
          const typeTag = a.type === 'browser' ? '[browser]' : '[cli]';
          return `  - ${typeTag} ${a.id} (service: ${a.service}, tool: ${a.cliTool || 'browser'}) — capabilities: ${caps || 'see descriptor'}`;
        }).join('\n');

        agentContextNote = `\n\nAVAILABLE AGENTS (already configured — auth/credentials resolved, no user prompt needed):\n${agentLines}\n  When a task uses one of these services, assume credentials are available and plan skill steps that use the service directly. Do NOT add auth setup steps for these services. For recurring/background tasks using these services, use needs_skill to build the automation skill.`;

        logger.debug(`[Node:PlanSkills] Agent context: ${healthyAgents.length} healthy agent(s) injected`);
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
      domainContextNote = `\n\n⚠️ DOMAIN CONTEXT — READ BEFORE PLANNING:\n${parts.map(p => `- ${p}`).join('\n')}\n- REQUIRED: Use the skill.bootstrap pattern — ${crawlInstruction} → synthesize skill.md as "${skillName}" → skill.install.\n- FORBIDDEN: Do NOT use shell.run with placeholder credentials. Credentials are handled automatically via keychain.\n- FORBIDDEN: Do NOT use api_suggest — the service is already chosen.\n- OUTPUT: A valid JSON array only. No prose, no markdown outside the array.`;
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
        domainContextNote = `\n\n⚠️ DOMAIN CONTEXT — READ BEFORE PLANNING:\n${parts.map(p => `- ${p}`).join('\n')}\n- REQUIRED: Because this is a messaging/API task with a known target service, you MUST use the skill.bootstrap pattern (web.crawl docs → synthesize skill.md → skill.install).\n- FORBIDDEN: Do NOT use shell.run with placeholder credentials like <TWILIO_ACCOUNT_SID> or <API_KEY>. Credentials are handled automatically via keychain — never hardcode them.\n- FORBIDDEN: Do NOT use api_suggest — the service is already identified above.\n- OUTPUT: A valid JSON array only. No prose, no markdown outside the array.`;
        logger.info(`[Node:PlanSkills] Domain context injected: ${domainTags.tags?.join(', ')} → ${domainTags.skillHints?.[0]}`);
      }
    }
  }

  const planningQuery = `TASK: Convert the following user request into a JSON skill plan.
OS: ${os}
Home directory: ${homeDir}
User request: "${userMessage}"${domainContextNote}${skillContractNote}${installedSkillsNote}${cliPreflightNote}${agentContextNote}${siteRulesBlock}${recoveryNote}${profileContextNote}${browserSessionNote}${priorResultsNote}${messagingBodyNote}${closeFileContextNote}${conversationNote}${taggedContextNote}${creatorContextNote}`;

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
      maxTokens: 2400,
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
      rawPlan = await backend.generateAnswer(planningQuery, payload, payload.options, null);
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
          logger.debug(`[Node:PlanSkills] Multi-tab plan consolidated: ${plannedSessionIds.size} sessions → 1 session "${primarySession}" (subsequent navigates → tab-new)`);
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

    // ── Scout intercept: replace needs_skill with a provider-select card ────────
    // If the LLM returned needs_skill, check the CLI/API registries before falling
    // through to recoverSkill → ASK_USER. If we find a match, emit scout_match and
    // pause so the user picks a provider in the Results Window. After they pick,
    // main.js resumes with cliMatch/apiMatch set → creatorPlanning fast-path runs.
    const needsSkillStep = skillPlan.find(s => s.skill === 'needs_skill');
    if (needsSkillStep) {
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
      if (regDir && !suggestionIsBuiltin) {
        try {
          const scoutPath = path.join(regDir, 'skill-scout.cjs');
          if (fs.existsSync(scoutPath)) {
            // Extract the service name: strip filler words to get the key noun
            // e.g. "send a slack message" → "slack", "stripe payment" → "stripe",
            //      "tic tac toe game" → "tic" (length <4 → skipped → project_build)
            const FILLER_WORDS = new Set([
              'a','an','the','send','get','fetch','create','build','make','add','post',
              'use','using','via','with','from','to','for','of','on','in','at','by',
              'my','me','this','that','some','new','about','through','into','can',
              'message','messages','email','emails','sms','text','notification','notifications',
            ]);
            const capWords = (capability || userMessage).toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9\-]/g, '')).filter(w => w.length >= 2 && !FILLER_WORDS.has(w));
            const serviceName = capWords[0] || '';
            if (serviceName.length >= 3) {
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
              logger.info(`[Node:PlanSkills] Scout intercept: dynamic discovery found nothing for "${serviceName}" — routing to project_build`);
            }
          }
        } catch (scoutErr) {
          logger.warn(`[Node:PlanSkills] skill-scout dynamic discovery error (non-fatal): ${scoutErr.message}`);
        }
      }

      // ── No CLI/API match (static or dynamic) — route to project builder ──────
      // This capability requires a full app (not a CLI command or REST API call).
      // Build a self-contained Vite+React+Express project via project.builder.
      logger.info(`[Node:PlanSkills] Scout intercept: no CLI/API match for "${capability || userMessage}" — routing to project_build`);
      const projectBuildPlan = [{
        skill: 'project_build',
        description: `Building project for: ${capability || userMessage}`,
        args: {
          capability: capability || userMessage,
          description: userMessage,
          suggestion,
        },
      }];
      if (progressCallback) progressCallback({
        type: 'plan_ready',
        steps: projectBuildPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args })),
        intent: state.intent?.type || 'command_automate',
      });
      if (progressCallback) progressCallback({
        type: 'project_build_start',
        capability: capability || userMessage,
        message: 'No CLI or API available — building a custom app for this capability.',
      });
      return {
        ...state,
        skillPlan: projectBuildPlan,
        skillCursor: 0,
        planError: null,
        recoveryContext: null,
        pendingSkillName: state.pendingSkillName || null,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────────

    if (progressCallback) progressCallback({ type: 'plan_ready', steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args })), intent: state.intent?.type || 'command_automate' });

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

    return {
      ...state,
      skillPlan,
      skillCursor: 0,          // Always reset cursor on a fresh/re-plan
      recoveryContext: null,   // Clear recovery context after re-plan
      planError: null,
      // Persist the locked skill name so replans use the same name (prevents duplicate skills)
      pendingSkillName: state.pendingSkillName || null
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

/**
 * Extract and parse a JSON array from LLM output.
 * LLMs sometimes wrap JSON in markdown fences or append trailing explanation text.
 * This parser finds the outermost [ ] or { } and extracts only that balanced block.
 */
function parsePlan(raw, logger) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();

  // Find first [ or { — prefer [ (array) over { (object) when both present
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');

  let open, close;
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    open = '['; close = ']';
    text = text.substring(arrayStart);
  } else if (objectStart !== -1) {
    open = '{'; close = '}';
    text = text.substring(objectStart);
  } else {
    logger.warn('[Node:PlanSkills] JSON parse failed: no [ or { found in output');
    return null;
  }

  // Walk the string to find the matching closing bracket (handles nested objects/arrays)
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }

  const jsonStr = endIdx !== -1 ? text.substring(0, endIdx + 1) : text;

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    logger.warn('[Node:PlanSkills] JSON parse failed:', e.message);

    // ── Truncation recovery ──────────────────────────────────────────────
    // When maxTokens cuts the LLM output mid-JSON, the string is truncated
    // inside a synthesize prompt or similar long value. Attempt to close
    // open strings/objects/arrays and salvage the completed steps.
    if (open === '[' && /unterminated string/i.test(e.message)) {
      logger.debug('[Node:PlanSkills] Attempting truncation recovery...');
      // Strategy: find the last complete object in the array (last "},")
      // and close the array after it.
      const lastCompleteObj = jsonStr.lastIndexOf('},');
      if (lastCompleteObj > 0) {
        const recovered = jsonStr.substring(0, lastCompleteObj + 1) + ']';
        try {
          const plan = JSON.parse(recovered);
          if (Array.isArray(plan) && plan.length > 0) {
            logger.info(`[Node:PlanSkills] Truncation recovery: salvaged ${plan.length} complete step(s) from truncated output`);
            return plan;
          }
        } catch (_) { /* recovery failed, fall through */ }
      }
      // Strategy 2: close the current string + all open brackets
      let repaired = jsonStr;
      if (inString) repaired += '"';
      // Close remaining depth
      for (let d = depth; d > 0; d--) {
        // Heuristic: alternate } and ] based on depth (innermost is likely an object)
        repaired += d === depth ? '}' : (d % 2 === 0 ? ']' : '}');
      }
      repaired += ']';
      try {
        const plan = JSON.parse(repaired);
        if (Array.isArray(plan) && plan.length > 0) {
          logger.info(`[Node:PlanSkills] Truncation recovery (bracket-close): salvaged ${plan.length} step(s)`);
          return plan;
        }
      } catch (_) { /* recovery failed */ }

      logger.debug('[Node:PlanSkills] Truncation recovery failed — returning null');
    }

    return null;
  }
}

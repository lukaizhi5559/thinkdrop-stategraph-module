'use strict';

/**
 * planSkillsV2.js — clean rewrite of planSkills.js
 *
 * Architectural improvements:
 *   1. PROMPT TIER SELECTION — URL-presence check replaces regex stacking.
 *      Slim browser prompt fires ONLY when message has an explicit URL/hostname
 *      AND no filesystem/OS context from upstream nodes.
 *   2. EXTRACTED UTILITIES — helpers live in src/utils/ and are imported.
 *   3. SAME RUNTIME BEHAVIOUR — all fast-paths, LLM call, post-processing guards
 *      are preserved exactly as in planSkills.js.
 *
 * Rollback: change StateGraphBuilder.js back to require('./nodes/planSkills')
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { parsePlan, buildStepDescription, serializeSkillPlanToMd } = require('../utils/planHelpers');
const {
  parseContractCommands,
  resolveDateRange,
  buildRuntimeParams,
  substituteTokens,
  selectCommandTemplate,
  applyContractParams,
  detectSaveSkillIntent,
  deriveSkillName,
} = require('../utils/planSkillsHelpers');
const { buildBridgeReminderPlan } = require('../utils/buildBridgeReminderPlan');
const { findSimilarCompletePlan }  = require('../utils/planCacheHelpers');
const { buildReminderSkill }       = require('../utils/buildReminderSkill');

// ─────────────────────────────────────────────────────────────────────────────
// Prompt loader
// ─────────────────────────────────────────────────────────────────────────────

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

function _loadPromptFile(filename) {
  try {
    const p = path.join(PROMPTS_DIR, filename);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt tier selection — V2 architecture
//
// BEFORE: regex stacking — "open" verb triggers slim → "open my-folder" fires slim
// AFTER:  URL presence check — slim fires ONLY when message has a URL/hostname
//         "open my-folder for me" has no URL → full prompt, always correct
// ─────────────────────────────────────────────────────────────────────────────

const _URL_RE = /https?:\/\/\S+|(?:^|\s)(?:www\.)\S+\.\w{2,}/i;
const _PUBLIC_HOST_RE = /\b(?:google|youtube|github|twitter|linkedin|reddit|facebook|instagram|amazon|netflix|spotify|wikipedia|stackoverflow|medium|notion|slack|discord|twitch|pinterest|tiktok|bing|yahoo|duckduckgo|perplexity|openai|anthropic|mistral|deepseek|gemini|grok|suno|midjourney|runway|figma|canva|zoom|teams|outlook|gmail|dropbox|drive\.google|icloud|onedrive|salesforce|hubspot|stripe|shopify|paypal|venmo|etsy|airbnb|uber|lyft|doordash|grubhub|yelp|tripadvisor)\.(?:com|ai|org|net|io|co|app|dev|me|uk|us)\b/i;

function _buildSystemPrompt(userMessage, state) {
  const isWindows = process.platform === 'win32';

  const _hasUrl = _URL_RE.test(userMessage) || _PUBLIC_HOST_RE.test(userMessage);
  const _hasLocalSignals = !!(
    state.grilledConstraints ||
    state.activeBrowserSessionId ||
    state.creatorSkillName ||
    state.projectSkillPlan ||
    state.matchedSkillName ||
    state.matchedSkillDomain
  );
  const canUseSlim = userMessage && _hasUrl && !_hasLocalSignals
    && !state.recoveryContext
    && state.intent?.type !== 'command_automate';

  if (canUseSlim) {
    const slim = _loadPromptFile('plan-skills-browser.md');
    if (slim) {
      console.info('[Node:PlanSkillsV2] system prompt: plan-skills-browser.md (URL-present, no local signals)');
      return slim;
    }
  }

  const baseFile = isWindows ? 'plan-skills-windows.md' : 'plan-skills.md';
  const _skipReason = _hasUrl && !canUseSlim ? ` (slim skipped: ${state.recoveryContext ? 'recovery' : 'command_automate'})` : '';
  console.info(`[Node:PlanSkillsV2] system prompt: ${baseFile}${_skipReason}`);
  const base = _loadPromptFile(baseFile) || _loadPromptFile('plan-skills.md');
  if (!base) return null;

  let result = base;

  if (state.grilledConstraints) {
    result += `\n\n## GRILLED CONSTRAINTS (User Confirmed)\n\nThese constraints were confirmed through detailed questioning. You MUST follow them:\n\n\`\`\`json\n${JSON.stringify(state.grilledConstraints, null, 2)}\n\`\`\``;
  }

  const _grillAnswers = state.gatheredContext?.resolvedAnswers;
  if (_grillAnswers && Object.keys(_grillAnswers).length > 0) {
    const _lines = Object.entries(_grillAnswers).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    result += `\n\n## PRE-FLIGHT RESOLVED FACTS (user confirmed — use these exact values)\n\n${_lines}`;
  }

  // Inject resolved user context (from resolveUserContext node) so planner knows what's available.
  // resolvedSelfContext has FLAT keys: { email, phone, memories, conversation }
  // (resolvedSelfContext.self is never populated — flat keys are the real data)
  const _resolvedContext = state.resolvedSelfContext;
  if (_resolvedContext) {
    const _ctxLines = [];

    // ── Flat scalar fields (email, phone, address) set by resolveUserContext ──
    const _FLAT_FIELD_LABELS = { email: 'User email', phone: 'User phone', address: 'User address' };
    for (const [key, label] of Object.entries(_FLAT_FIELD_LABELS)) {
      if (_resolvedContext[key] && typeof _resolvedContext[key] === 'string') {
        _ctxLines.push(`${label}: ${_resolvedContext[key]}`);
      }
    }

    // ── Legacy sub-object (user.agent resolve_form output) ───────────────────
    if (_resolvedContext.self && Object.keys(_resolvedContext.self).length > 0) {
      _ctxLines.push('User Profile:\n' + Object.entries(_resolvedContext.self)
        .map(([k, v]) => `  ${k}: ${v}`).join('\n'));
    }
    if (_resolvedContext.contacts && Object.keys(_resolvedContext.contacts).length > 0) {
      for (const [label, fields] of Object.entries(_resolvedContext.contacts)) {
        _ctxLines.push(`Contact — ${label}:\n` + Object.entries(fields)
          .map(([k, v]) => `  ${k}: ${v}`).join('\n'));
      }
    }

    // ── Memory snippets (broad context: favorites, family, preferences, etc.) ─
    const _memSnippets = _resolvedContext.memories?.context || (_resolvedContext.memories && Array.isArray(_resolvedContext.memories) ? _resolvedContext.memories : []);
    if (_memSnippets.length > 0) {
      _ctxLines.push('Known facts from memory:\n' + _memSnippets.slice(0, 5).map(m => `  • ${String(m).slice(0, 200)}`).join('\n'));
    }

    // ── Conversation snippets (cross-session context) ────────────────────────
    const _convSnippets = _resolvedContext.conversation?.context || [];
    if (_convSnippets.length > 0) {
      _ctxLines.push('Recent context from conversations:\n' + _convSnippets.slice(0, 3).map(m => `  • ${String(m).slice(0, 200)}`).join('\n'));
    }

    if (_ctxLines.length > 0) {
      result += `\n\n## RESOLVED USER CONTEXT (already retrieved — use this data directly, do NOT re-fetch):\n\n${_ctxLines.join('\n\n')}`;
    }
  }

  // Inject data from previous pipeline steps (from dataTemplate resolution)
  const _dataPrefix = state._dataPrefix;
  if (_dataPrefix && typeof _dataPrefix === 'string' && _dataPrefix.length > 0) {
    result += `\n\n## CONTEXT FROM PREVIOUS STEP (data to use in your plan):\n\n${_dataPrefix}`;
  }

  // ── Install scoring policy ──────────────────────────────────────────────
  // Injected for all local_file tasks (create, convert, export, generate, write).
  // Uses _taskClassification from the LLM classifier — no regex.
  if (state._taskClassification?.taskType === 'local_file') {
    result += `\n\n## INSTALL POLICY — ALWAYS FOLLOW THIS

When a task requires installing a tool or generating a document on macOS, score and pick the LOWEST available tier:

| Tier | Criteria | Examples |
|---|---|---|
| T1 \u2014 Zero-install | Already on macOS, no install needed | cupsfilter, osascript, /usr/bin/python3, open, textutil, sips |
| T2 \u2014 Lightweight | < 50 MB, fast install, actively maintained | pandoc (brew install pandoc ~50 MB), wkhtmltopdf, weasyprint |
| T3 \u2014 Standard | Industry standard, ~200 MB | pdflatex / BasicTeX (NOT full MacTeX) |
| T4 \u2014 Heavy | > 500 MB, slow, requires sudo installer | Full MacTeX (4 GB), texlive-full — NEVER use unless user explicitly requests |

**Timeout policy for install steps:**
- Any \`brew install\` step MUST include \`"timeoutMs": 300000\` (5 minutes) in the shell.run args — brew installs take 60-120 seconds and will fail with the default 30s timeout.

**sudo policy:**
- If a step requires sudo, mention it in the step description so the user is aware
- Never use sudo rm, sudo dd, sudo mkfs — these are forbidden
- sudo installer and sudo softwareupdate are allowed when necessary

**When multiple tiers can accomplish the task:** always go T1 → T2, document WHY in a synthesize step if you use T3+.`;
  }

  // ── Multi-step data pipeline rules ──────────────────────────────────────
  // Always-on: injected for every plan so the planner knows how to wire steps.
  result += `\n\n## MULTI-STEP DATA PIPELINE — MANDATORY RULES

When a step produces content (text, markdown, JSON, file list, etc.) that a LATER step must USE directly, you MUST wire the steps using the correct placeholder:

| Next step | Placeholder to use | Where to put it |
|---|---|---|
| shell.run | \`{{PREV_OUTPUT}}\` | Inside the \`goal\` string |
| cli.agent | \`{{PREV_OUTPUT}}\` | Inside the \`goal\` string |
| browser.agent | \`{{PREV_OUTPUT_FILE}}\` | Inside the \`task\` string |

**Examples:**
- browser.agent fetches ChatGPT markdown → shell.run goal: \`"Write the following markdown to /tmp/content.md and convert to PDF:\\n{{PREV_OUTPUT}}"\`
- shell.run reads a file → cli.agent goal: \`"Create a GitHub issue with this content as the body:\\n{{PREV_OUTPUT}}"\`
- shell.run extracts PDF text → browser.agent task: \`"Open ChatGPT and paste the content of {{PREV_OUTPUT_FILE}} as a prompt"\`

**FORBIDDEN — these cause silent failures:**
- NEVER use \`pbpaste\` — it reads the user's clipboard, which is unrelated to automation output
- NEVER emit \`{{prev_stdout}}\` as a URL or file path — it must only appear inside goal/task strings
- NEVER assume content from a browser step is "already on disk" unless a prior shell.run step explicitly wrote it
- NEVER hardcode placeholder text like "This is a template for ChatGPT responses" — use the actual prior step output via \`{{PREV_OUTPUT}}\``;

  // ── File context injection ───────────────────────────────────────────────
  // Scan the user message for file paths and inject real filesystem metadata
  // so the LLM can reason about format compatibility (e.g. .md vs .pdf) without
  // needing hardcoded rules. Only active for local_file tasks.
  if (state._taskClassification?.taskType === 'local_file') {
    try {
      const homeDir = os.homedir();
      // Match: absolute paths, ~/... paths, and bare filenames with extensions
      const _pathRe = /(?:~\/[^\s"'`,]+|\/[^\s"'`,]+|[a-zA-Z0-9_\-. ]+\.(?:pdf|md|docx?|xlsx?|csv|txt|html?|png|jpg|jpeg|mp4|mov|zip|json|yaml|yml))/gi;
      const _rawMessage = (state.resolvedMessage || state.message || userMessage);
      const _matches = [...new Set((_rawMessage.match(_pathRe) || []))];
      const _FORMAT_MAP = {
        pdf: 'PDF (binary — cannot append text directly)',
        md: 'Markdown (plain text)',
        markdown: 'Markdown (plain text)',
        txt: 'Plain text',
        docx: 'Word document (Office binary)',
        doc: 'Word document (Office binary)',
        xlsx: 'Excel spreadsheet (Office binary)',
        xls: 'Excel spreadsheet (Office binary)',
        csv: 'CSV (plain text)',
        html: 'HTML (plain text)',
        htm: 'HTML (plain text)',
        json: 'JSON (plain text)',
        yaml: 'YAML (plain text)',
        yml: 'YAML (plain text)',
        png: 'PNG image (binary)',
        jpg: 'JPEG image (binary)',
        jpeg: 'JPEG image (binary)',
        mp4: 'MP4 video (binary)',
        mov: 'QuickTime video (binary)',
        zip: 'ZIP archive (binary)',
      };
      const _fileRows = [];
      for (const _raw of _matches) {
        const _expanded = _raw.startsWith('~/') ? path.join(homeDir, _raw.slice(2)) : _raw;
        const _ext = path.extname(_expanded).replace('.', '').toLowerCase();
        if (!_ext) continue;
        const _format = _FORMAT_MAP[_ext] || `${_ext.toUpperCase()} file`;
        let _exists = false, _sizeStr = 'unknown';
        try {
          const _st = fs.statSync(_expanded);
          _exists = true;
          _sizeStr = _st.size < 1024 ? `${_st.size} B` : _st.size < 1048576 ? `${Math.round(_st.size / 1024)} KB` : `${(_st.size / 1048576).toFixed(1)} MB`;
        } catch (_) {}
        _fileRows.push(`| \`${_raw}\` | ${_exists ? '✅ exists' : '❌ not found'} | ${_sizeStr} | ${_format} |`);
      }
      if (_fileRows.length > 0) {
        result += `\n\n## FILE CONTEXT (detected from your request)\n\n| Path | Status | Size | Format |\n|---|---|---|---|\n${_fileRows.join('\n')}\n\nUse this to plan correct conversion steps — e.g. if source is Markdown and target is PDF (binary), you must convert the markdown to PDF first, then merge the PDFs.`;
      }
    } catch (_) {}
  }

  return result;
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

Priority: shell.run > browser.act > keyboard shortcuts > ui.axClick (native only) > ui.moveMouse+ui.click (last resort).
ui.findAndClick does NOT exist. ui.axClick ONLY works for true native macOS apps.
For Slack: always use osascript activate + {CMD+K} + type + {DOWN}{ENTER}. Never ui.axClick.
api_suggest: use as FIRST step when task is RECURRING or programmatic AND the service has an API.
guide.step: use for ANY task where the user must act manually step by step.
Policy: no sudo/su/passwd. argv is string[] — no shell interpolation.
Output ONLY a valid JSON array. No explanation, no markdown fences.
For synthesize steps: keep prompt strings UNDER 200 chars. Use {{EXPAND:<intent>}} for longer prompts.
If the request cannot be safely automated, output: { "error": "explain why it cannot be done" }`;

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');

// ─────────────────────────────────────────────────────────────────────────────
// Main node
// ─────────────────────────────────────────────────────────────────────────────

async function planSkillsV2(state) {
  const {
    mcpAdapter,
    llmBackend,
    message,
    resolvedMessage,
    intent,
    context,
    recoveryContext,
    conversationHistory = [],
    activeBrowserSessionId = null,
    profileContext = null,
  } = state;

  const logger = state.logger || console;
  const progressCallback = state.progressCallback || null;
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/Users/unknown';

  const _dataFileSuffix = state._dataFile
    ? `\n[Full content available at: ${state._dataFile} — read with fs.readFileSync if needed]`
    : '';

  // Sanitize _dataPrefix: strip raw HTML / Gist embed boilerplate that leaks from web-search
  // results into the planning query. We only want clean URLs and factual snippets — not full
  // page HTML which causes the planner to misread the task (e.g. "Clone this repository").
  let _sanitizedDataPrefix = '';
  if (state._dataPrefix) {
    const _raw = String(state._dataPrefix);
    const _hasHtmlNoise = /&amp;|&lt;|&gt;|&quot;|<script|Clone via HTTPS|Save .+ to your computer/i.test(_raw);
    if (_hasHtmlNoise) {
      // Extract plain URLs and keep only those as context
      const _urlMatches = _raw.match(/https?:\/\/[^\s"'<>]+/g) || [];
      const _uniqueUrls = [...new Set(_urlMatches)].slice(0, 5);
      _sanitizedDataPrefix = _uniqueUrls.length > 0
        ? `URL from previous step: ${_uniqueUrls[0]}`
        : '';
      if (_sanitizedDataPrefix) {
        logger.info(`[Node:PlanSkillsV2] _dataPrefix sanitized (HTML stripped) → "${_sanitizedDataPrefix.slice(0, 80)}"`);
      }
    } else {
      _sanitizedDataPrefix = _raw;
    }
  }

  const userMessage = (_sanitizedDataPrefix ? _sanitizedDataPrefix + '\n' : '') + (resolvedMessage || message) + _dataFileSuffix;

  const correctionSourcePrompt = state._planCorrectionMode && state._planCorrectionSourcePrompt
    ? String(state._planCorrectionSourcePrompt) : '';
  const runtimeParamMessage = correctionSourcePrompt
    ? `${correctionSourcePrompt}\n${userMessage}`
    : userMessage;

  let SKILL_SYSTEM_PROMPT = _buildSystemPrompt(userMessage, state) || SKILL_SYSTEM_PROMPT_FALLBACK;

  // ── Project skill plan passthrough ────────────────────────────────────────
  if (state.projectSkillPlan && Array.isArray(state.projectSkillPlan) && state.projectSkillPlan.length > 0) {
    logger.info(`[Node:PlanSkillsV2] Using project skill plan: ${state.projectSkillPlan[0].skill}`);
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: state.projectSkillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description, args: s.args, runGroup: s.runGroup || undefined })), intent: 'command_automate' });
    return { ...state, skillPlan: state.projectSkillPlan, skillCursor: 0, planError: null, recoveryContext: null };
  }

  // ── Named plan recall fast-path ───────────────────────────────────────────
  if (state._recallPlanName) {
    const { findPlanByName } = require('../utils/planCacheHelpers');
    const recalled = findPlanByName(state._recallPlanName, PLANS_DIR, logger);
    if (recalled && Array.isArray(recalled.plan) && recalled.plan.length > 0) {
      logger.info(`[Node:PlanSkillsV2] Named plan recall: "${state._recallPlanName}" → ${recalled.plan.length} steps`);
      if (progressCallback) progressCallback({ type: 'plan:found_existing', planName: state._recallPlanName });
      return { ...state, skillPlan: recalled.plan, skillCursor: 0, planError: null, recoveryContext: null, _skillPlanFile: recalled.planFile };
    }
    logger.warn(`[Node:PlanSkillsV2] Named plan recall: "${state._recallPlanName}" not found — falling through to LLM`);
  }

  // ── Pre-approved skill plan fast-path ─────────────────────────────────────
  // _skillPlan may be either a JS array (decoded by main.js plan:approve before enqueue)
  // or a base64 string (legacy path / direct enqueue). Handle both to avoid silent failures.
  if (state._skillPlan && !recoveryContext) {
    try {
      const decoded = Array.isArray(state._skillPlan)
        ? state._skillPlan
        : JSON.parse(Buffer.from(state._skillPlan, 'base64').toString('utf8'));
      if (Array.isArray(decoded) && decoded.length > 0) {
        // Check if this is a multi-service comparison task that needs parallel execution
        const _multiServicePattern = /\b(perplexity|chatgpt|gemini|claude|google|amazon|ebay|etsy|stackoverflow|youtube|twitter|x|reddit)\b.*\b(perplexity|chatgpt|gemini|claude|google|amazon|ebay|etsy|stackoverflow|youtube|twitter|x|reddit)\b/i;
        const _isMultiService = _multiServicePattern.test(state.originalPrompt || state.message || '');
        const _hasRunGroup = decoded.some(s => s.runGroup);
        if (_isMultiService && !_hasRunGroup) {
          logger.info(`[Node:PlanSkillsV2] Multi-service task detected but no runGroup in cached plan — forcing regeneration`);
          // Fall through to LLM planning to get proper runGroup assignment
        } else {
          logger.info(`[Node:PlanSkillsV2] Pre-approved skill plan: ${decoded.length} steps`);
          if (progressCallback) progressCallback({ type: 'plan_ready', steps: decoded.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args, runGroup: s.runGroup || undefined })), intent: state.intent?.type || 'command_automate' });
          return { ...state, skillPlan: decoded, skillCursor: 0, planError: null, recoveryContext: null };
        }
      }
    } catch (err) {
      logger.warn(`[Node:PlanSkillsV2] _skillPlan fast-path decode failed: ${err.message} — falling through to LLM`);
    }
  }

  // ── Login resume fast-path ────────────────────────────────────────────────
  if (state._loginResumeSkillPlan && !recoveryContext) {
    logger.info('[Node:PlanSkillsV2] Login resume: returning existing plan as-is');
    return { ...state, skillPlan: state._loginResumeSkillPlan, skillCursor: 0, planError: null };
  }

  // ── Creator shortcut: skill already built by creatorPlanning ─────────────
  if (state.creatorSkillName && !recoveryContext && !state.forceSkillBuild) {
    const _csName = state.creatorSkillName;
    const SKILLS_DIR = path.join(homeDir, '.thinkdrop', 'skills');
    const _csPath = path.join(SKILLS_DIR, _csName.replace(/\./g, '_'), 'index.cjs');
    if (fs.existsSync(_csPath)) {
      logger.info(`[Node:PlanSkillsV2] Creator shortcut: ${_csName}`);
      const plan = [{ skill: 'external.skill', description: `Run ${_csName}`, args: { name: _csName } }];
      if (progressCallback) progressCallback({ type: 'plan_ready', steps: plan.map((s, i) => ({ index: i, ...s })), intent: 'command_automate' });
      return { ...state, skillPlan: plan, skillCursor: 0, planError: null, recoveryContext: null };
    }
  }

  // ── LLM backend ──────────────────────────────────────────────────────────
  const backend = llmBackend;
  if (!backend) {
    logger.warn('[Node:PlanSkillsV2] No llmBackend — cannot plan skills');
    return { ...state, planError: 'No LLM backend available for skill planning' };
  }

  const _osName  = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const _agentIdentity = `AGENT IDENTITY: You are ThinkDrop, a desktop automation agent running on ${_osName} (${os.release()}). You have FULL system access: shell commands, filesystem read/write, app control, and native ${_osName} APIs. You are NOT a web chatbot. Your job is to output a JSON skill plan.`;

  // ── Creator planning context ──────────────────────────────────────────────
  let creatorContextNote = '';
  if (state.creatorPlanMd || state.creatorAgentsMd) {
    const parts = [];
    if (state.creatorPlanMd)   parts.push('## Project Plan (from creator.agent)\n' + state.creatorPlanMd.slice(0, 2000));
    if (state.creatorAgentsMd) parts.push('## Agent Specs (from creator.agent)\n' + state.creatorAgentsMd.slice(0, 1500));
    if (state.creatorBddTests) parts.push('## BDD Acceptance Tests\n' + state.creatorBddTests.slice(0, 800));
    creatorContextNote = '\n\nCREATOR PLAN CONTEXT (pre-validated architecture):\n' + parts.join('\n\n');
  }

  // ── Recovery / correction notes ───────────────────────────────────────────
  let recoveryNote = '';
  if (recoveryContext) {
    recoveryNote = `\n\nRECOVERY CONTEXT (previous attempt failed — DO NOT repeat the same plan):\n- Failed step: ${recoveryContext.failedSkill} (step ${recoveryContext.failedStep})\n- Failure reason: ${recoveryContext.failureReason}\n- Actual URL reached: ${recoveryContext.actualUrl || 'unknown'}\n- Suggestion: ${recoveryContext.suggestion}\n- Constraint: ${recoveryContext.constraint || 'none'}\nYou MUST produce a DIFFERENT plan. RECOVERY TOOL CONSTRAINT: Any step that previously used browser.agent { action: "run" } MUST continue to use browser.agent { action: "run" } in the recovery plan.`;
    if (recoveryContext.constraint?.includes('USE GOAL MODE')) {
      recoveryNote += '\n⚠️ GOAL MODE REQUIRED: For any shell.run step, emit { "skill": "shell.run", "args": { "goal": "<plain English description>" } }. Do NOT write args.cmd or args.argv.';
    }
  }

  let correctionNote = '';
  if (state._planCorrectionMode && state._planCorrectionText) {
    correctionNote = `\n\nPLAN CORRECTION MODE (user is revising a pending plan):\n- Feedback: "${String(state._planCorrectionText).replace(/"/g, '\\"').slice(0, 400)}"\n- Base plan file: ${state._basePlanFile || state._skillPlanFile || 'unknown'}\nApply this correction directly. Keep the same overall goal and only adjust strategy/skills needed.`;
    if (correctionSourcePrompt) correctionNote += `\n- Original request: "${correctionSourcePrompt.replace(/"/g, '\\"').slice(0, 500)}"`;
    if (state._skillPlanJson) {
      try {
        const parsedBase = JSON.parse(Buffer.from(state._skillPlanJson, 'base64').toString('utf8'));
        if (Array.isArray(parsedBase) && parsedBase.length > 0) {
          const summary = parsedBase.slice(0, 12).map((s, i) => `  ${i + 1}. ${s?.skill || 'unknown'}${s?.description ? ` — ${String(s.description).slice(0, 80)}` : ''}`).join('\n');
          correctionNote += `\nPrevious draft steps:\n${summary}`;
        }
      } catch (_) {}
    }
  }

  // ── Prior step results context ────────────────────────────────────────────
  const skillResults = state.skillResults || [];
  let priorResultsNote = '';
  let priorSynthesizedContent = '';
  if (skillResults.length > 0) {
    const resultLines = skillResults
      .filter(r => r.ok && r.stdout && r.stdout.trim())
      .map(r => {
        const lines = r.stdout.trim().split('\n');
        const snippet = r.skill === 'fs.read' ? lines.join('\n') : lines.slice(0, 3).join('; ');
        return `- ${r.skill || 'shell.run'} output:\n${snippet}`;
      });
    if (resultLines.length > 0) {
      const hasFsRead = skillResults.some(r => r.skill === 'fs.read' && r.ok);
      const fsNote = hasFsRead ? '\nIMPORTANT: The fs.read result above contains EXACT file paths. Use ONLY these real paths.' : '';
      priorResultsNote = `\n\nPREVIOUS STEP RESULTS (use to resolve references like "that file", "it", "the result"):${fsNote}\n${resultLines.join('\n')}`;
    }
  }

  // ── Conversation history context ──────────────────────────────────────────
  let conversationNote = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const recentTurns = conversationHistory.slice(-10);
    const systemEvents = conversationHistory.filter(m => m.role === 'system' || m.sender === 'system').slice(-5);
    let systemNote = '';
    if (systemEvents.length > 0) {
      systemNote = `\n\n⚠️ SYSTEM EVENTS (treat as current facts):\n${systemEvents.map(m => `  • ${(m.content || m.text || '').trim()}`).join('\n')}`;
    }

    const _POISON = /^(got\s+it\b|i'?ll\s+(use|try|search|go\s+to|open|run|look)|i\s+understand\b|based\s+on\b|understood\b|sure[,!\s]|of\s+course[,!\s]|happy\s+to\b)/i;
    const _RECOVERY_CONTENT = /returned a navigation\/welcome page|requires login or redirected|automatic search fallbacks failed/i;

    // During recovery replanning, exclude all assistant turns — they may contain
    // hallucinated intermediate pipeline answers (e.g. "I have created the issue...")
    // that would corrupt the planner's understanding of what still needs to be done.
    // User turns are kept so the planner always has the original request.
    const historyTurnsForPlanning = recoveryContext
      ? recentTurns.filter(m => m.role === 'user' || m.role === 'system' || m.sender === 'system')
      : recentTurns;

    const turnLines = historyTurnsForPlanning
      .filter(m => (m.role !== 'system' && m.sender !== 'system') && m.content?.trim())
      .filter(m => {
        if (m.role !== 'assistant') return true;
        const c = (m.content || '').trim();
        if (c.includes('Step outputs:')) return true;
        return !_POISON.test(c) && !_RECOVERY_CONTENT.test(c);
      })
      .map(m => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const limit = m.role === 'assistant' && m.content?.includes('Step outputs:') ? 2000 : 300;
        return `${role}: ${(m.content || '').trim().substring(0, limit)}`;
      });
    if (turnLines.length > 0 || systemNote) {
      conversationNote = `${systemNote}\n\nRECENT CONVERSATION:\n${turnLines.join('\n')}`;
    }

    const lastSynthMsg = recentTurns.slice().reverse().find(m => m.role === 'assistant' && m.content?.includes('[synthesize]:'));
    const lastSynthSource = lastSynthMsg || recentTurns.slice().reverse().find(m => m.role === 'assistant');
    if (lastSynthSource?.content) {
      const soIdx = lastSynthSource.content.indexOf('Step outputs:');
      if (soIdx !== -1) {
        const after = lastSynthSource.content.slice(soIdx + 'Step outputs:'.length).trim();
        const synthMatch = after.match(/\[synthesize\]:\n([\s\S]+?)(?=\n\[|$)/);
        priorSynthesizedContent = (synthMatch ? synthMatch[1] : after).trim().slice(0, 2000);
      }
    }
  }

  // ── Constraint gate ───────────────────────────────────────────────────────
  const constraints = state.constraints || [];
  if (Array.isArray(constraints) && constraints.length > 0) {
    const active = constraints.filter(c => c.active !== false);
    if (active.length > 0) {
      const cLines = active.map(c => `- [${c.type || 'rule'}] ${c.description || c.rule || JSON.stringify(c)}`).join('\n');
      SKILL_SYSTEM_PROMPT += `\n\n## ACTIVE CONSTRAINTS (MUST FOLLOW):\n\n${cLines}`;
    }
  }

  // ── Semantic cache check ──────────────────────────────────────────────────
  const isRecurring = /\b(every|daily|weekly|each\s+morning|each\s+evening|at\s+\d+\s*(am|pm)|cron|recurring)\b/i.test(userMessage);
  if (!recoveryContext && !state._planCorrectionMode && !isRecurring) {
    try {
      const cached = await findSimilarCompletePlan(userMessage, PLANS_DIR, logger);
      if (cached && Array.isArray(cached.plan) && cached.plan.length > 0) {
        logger.info(`[Node:PlanSkillsV2] Semantic cache hit: "${cached.planFile}"`);
        if (progressCallback) progressCallback({ type: 'plan:found_existing', planFile: cached.planFile });
        return { ...state, skillPlan: cached.plan, skillCursor: 0, planError: null, recoveryContext: null, _skillPlanFile: cached.planFile };
      }
    } catch (_e) { logger.debug(`[Node:PlanSkillsV2] Cache check error: ${_e.message}`); }
  }

  // ── Pre-LLM recurring reminder intercept ─────────────────────────────────
  if (!recoveryContext) {
    try {
      const reminderResult = buildReminderSkill(userMessage, state, logger);
      if (reminderResult && Array.isArray(reminderResult.plan) && reminderResult.plan.length > 0) {
        logger.info(`[Node:PlanSkillsV2] Reminder skill intercept: ${reminderResult.plan.length} steps`);
        if (progressCallback) progressCallback({ type: 'plan_ready', steps: reminderResult.plan.map((s, i) => ({ index: i, ...s })), intent: 'command_automate' });
        return { ...state, skillPlan: reminderResult.plan, skillCursor: 0, planError: null, recoveryContext: null };
      }
    } catch (_) {}
  }

  // ── Parallel pre-LLM fetches ──────────────────────────────────────────────
  let skillContractNote = '';
  let _shellContractMd = null;
  let _preflightCliMap = {};
  let cliPreflightNote = '';
  let agentContextNote = '';
  let _registeredAgentServiceMap = {};
  const shellSkillNames = new Set();
  let installedSkillsList = [];

  if (mcpAdapter) {
    await Promise.all([
      // ── Skill contract ────────────────────────────────────────────────────
      (async () => {
        if (!state.matchedSkillName) return;
        try {
          const scRes = await mcpAdapter.callService('user-memory', 'skill.get', { name: state.matchedSkillName }, { timeoutMs: 3000 }).catch(() => null);
          const scData = scRes?.data || scRes;
          const contractMd = scData?.contractMd || scData?.contract_md || '';
          if (contractMd?.trim()) {
            const _fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
            const _isNodeSkill = _fmMatch && /exec_type:\s*node\b/i.test(_fmMatch[1]);
            if (_isNodeSkill) {
              skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. This is a Node.js runtime skill (exec_type: node). Generate a SINGLE step: { "skill": "external.skill", "args": { "name": "${state.matchedSkillName}" } }\n3. FORBIDDEN: Do NOT generate shell.run or curl steps.\n\n${contractMd.slice(0, 2000)}`;
            } else {
              skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. You MUST generate shell.run steps with curl commands from the ## Commands section below.\n2. FORBIDDEN: Do NOT use "${state.matchedSkillName}" as a skill name in any step.\n3. FORBIDDEN: Do NOT use external.skill for this.\n\n${contractMd.slice(0, 3000)}`;
              _shellContractMd = contractMd;
              shellSkillNames.add(state.matchedSkillName);
            }
          }
        } catch (_) {}
      })(),

      // ── CLI pre-flight ────────────────────────────────────────────────────
      (async () => {
        if (recoveryContext) return;
        try {
          const pfRes = await mcpAdapter.callService('command', 'command.automate', { skill: 'cli.agent', args: { action: 'preflight_check', task: userMessage } }, { timeoutMs: 5000 }).catch(() => null);
          const pf = pfRes?.data || pfRes;
          if (pf?.ok) {
            const lines = [];
            if (!pf.brew?.installed) lines.push('brew: NOT INSTALLED — install first');
            else lines.push('brew: installed ✓');
            if (!pf.curl?.installed) lines.push('curl: NOT INSTALLED');
            else lines.push('curl: installed ✓');
            if (Array.isArray(pf.detectedClis)) {
              for (const c of pf.detectedClis) {
                _preflightCliMap[c.service.toLowerCase()] = { hasCli: !!c.cli };
                if (!c.cli) {
                  const provider = c.isOAuth ? 'OAuth-based' : c.isApiKey ? 'API key required' : 'unknown';
                  lines.push(`${c.service}: ${provider} — use browser.agent { action: 'build_agent' } then { action: 'run' }`);
                  continue;
                }
                if (!c.installed) {
                  const installCmd = c.installMethod === 'npm' ? `npm install -g ${c.installPkg}` : `brew install ${c.installPkg || c.cli}`;
                  lines.push(`${c.service}: ${c.cli} NOT INSTALLED — install: ${installCmd}`);
                } else {
                  const authNote = c.authUser ? ` — authenticated as ${c.authUser}` : (c.authStatus === 'authenticated' ? ' — authenticated' : '');
                  lines.push(`${c.service}: ${c.cli} installed${authNote} ✓ — use cli.agent { action: 'run', agentId: '${c.service}.agent', task: '...' }`);
                }
              }
            }
            if (lines.length > 0) cliPreflightNote = `\n\nCLI PRE-FLIGHT:\n${lines.join('\n')}`;
          }
        } catch (_) {}
      })(),

      // ── Agent registry ────────────────────────────────────────────────────
      (async () => {
        try {
          const agRes = await mcpAdapter.callService('user-memory', 'agent.list', {}, { timeoutMs: 3000 }).catch(() => null);
          const agents = agRes?.data || agRes || [];
          if (Array.isArray(agents) && agents.length > 0) {
            const agentLines = agents.map(a => `- ${a.id}: ${a.type} agent${a.start_url ? ` (starts at ${a.start_url})` : ''}${Array.isArray(a.capabilities) ? ` — capabilities: ${a.capabilities.slice(0, 5).join(', ')}` : ''}`);
            agentContextNote = `\n\nREGISTERED AGENTS (use browser.agent { action: "run", agentId: "<id>", task: "..." } for these — do NOT use raw browser.act navigate):\n${agentLines.join('\n')}`;
            for (const a of agents) {
              const svc = (a.id || '').replace('.agent', '').toLowerCase();
              if (svc) _registeredAgentServiceMap[svc] = a.id;
            }
          }
        } catch (_) {}
      })(),

      // ── Installed skills list ─────────────────────────────────────────────
      (async () => {
        try {
          const ilRes = await mcpAdapter.callService('user-memory', 'skill.list', {}, { timeoutMs: 3000 }).catch(() => null);
          const il = ilRes?.data || ilRes || [];
          if (Array.isArray(il)) installedSkillsList = il;
        } catch (_) {}
      })(),
    ]);
  }

  // ── Date range resolution (deterministic) ─────────────────────────────────
  let dateRangeNote = '';
  const dateRange = resolveDateRange(userMessage);
  if (dateRange) {
    dateRangeNote = `\n\nDATE RANGE RESOLVED (use THESE values in shell.run commands — do NOT compute dates yourself):\n- timeMin: ${dateRange.timeMin}\n- timeMax: ${dateRange.timeMax}\n- UNIX_MIN: ${dateRange.UNIX_MIN}\n- UNIX_MAX: ${dateRange.UNIX_MAX}\n- DATE_MIN: ${dateRange.DATE_MIN}\n- DATE_MAX: ${dateRange.DATE_MAX}`;
  }

  // ── Domain skill fast-path ────────────────────────────────────────────────
  if (state.matchedSkillType === 'domain' && state.matchedSkillName && !recoveryContext) {
    logger.info(`[Node:PlanSkillsV2] Domain skill fast-path: ${state.matchedSkillName}`);
    const domainPlan = [{
      skill: 'external.skill',
      description: `Run domain skill: ${state.matchedSkillName}`,
      args: { name: state.matchedSkillName, ...(state.matchedSkillParams || {}) },
    }];
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: domainPlan.map((s, i) => ({ index: i, ...s })), intent: 'command_automate' });
    return { ...state, skillPlan: domainPlan, skillCursor: 0, planError: null, recoveryContext: null, domainSkillFastPath: true };
  }

  // ── Contract-driven fast-path (shell skills) ──────────────────────────────
  if (_shellContractMd && state.matchedSkillName && !recoveryContext) {
    const parsed = parseContractCommands(_shellContractMd);
    if (parsed && parsed.commands?.length > 0) {
      logger.info(`[Node:PlanSkillsV2] Contract fast-path: ${parsed.commands.length} templates for "${state.matchedSkillName}"`);
      try {
        const runtimeParams = buildRuntimeParams(runtimeParamMessage || userMessage, profileContext, priorSynthesizedContent);
        const sel = parsed.commands.length === 1
          ? { index: 0, substitutions: [], params: {} }
          : await selectCommandTemplate(parsed.commands, userMessage, backend);

        if (sel !== null) {
          const selectedCmd = parsed.commands[sel.index];
          let code = applyContractParams(selectedCmd.code, sel);
          const mergedParams = { ...runtimeParams, ...(dateRange || {}) };
          code = substituteTokens(code, mergedParams, logger);

          const contractPlan = [];
          if (parsed.authScript) {
            contractPlan.push({ skill: 'shell.run', description: 'Authenticate', args: { cmd: 'bash', argv: ['-c', parsed.authScript] } });
          }
          contractPlan.push({ skill: 'shell.run', description: selectedCmd.heading, args: { cmd: 'bash', argv: ['-c', code] } });

          if (progressCallback) progressCallback({ type: 'plan_ready', steps: contractPlan.map((s, i) => ({ index: i, ...s })), intent: 'command_automate' });
          return { ...state, skillPlan: contractPlan, skillCursor: 0, planError: null, recoveryContext: null };
        }
      } catch (_) {}
    }
  }

  // ── Build the LLM planning query ──────────────────────────────────────────
  const runtimeNote = buildRuntimeParams(runtimeParamMessage || userMessage, profileContext, priorSynthesizedContent)
    ? (() => {
        const rp = buildRuntimeParams(runtimeParamMessage || userMessage, profileContext, priorSynthesizedContent);
        const hints = Object.entries(rp).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${k === 'BODY' ? v.slice(0, 60) + '…' : v}`).join('\n');
        return hints ? `\n\nEXTRACTED PARAMS (use these in commands):\n${hints}` : '';
      })()
    : '';

  // ── Messaging body injection (follow-up: "email/text this info to me") ─────
  // When the user says "email this to me", "text this info", etc. and prior
  // synthesized content exists, inject it explicitly so the LLM doesn't plan
  // a user.agent/browser step to re-fetch content that's already available.
  // Uses exact same regex + sanitizer as planSkills.js (battle-tested).
  let messagingBodyNote = '';
  const isMessagingTask = !isRecurring && (
    /^(text|send|email|message|forward|share|ping|tell|notify)/i.test(userMessage.trim()) ||
    /\b(text|sms|send.*message|email.*me|message.*me)\b/i.test(userMessage)
  );
  const _hasExplicitBody = /\b(say|saying|with\s+message|body\s*:|message\s*:|tell\s+(?:them|him|her|me)\s+(?:that\s+)?")/i.test(userMessage)
    || /"[^"]{2,}"/.test(userMessage)
    || /'[^']{2,}'/.test(userMessage);
  if (isMessagingTask && priorSynthesizedContent && !_hasExplicitBody) {
    let _sanitizedBody = priorSynthesizedContent;
    if (/^here is the raw data returned/i.test(_sanitizedBody.trim()) ||
        /^\[shell\.run\]:\s*[\[{]/m.test(_sanitizedBody)) {
      const _jsonMatch = _sanitizedBody.match(/```json\n([\s\S]*?)\n```/) ||
                         _sanitizedBody.match(/\[shell\.run\]:\n*([\s\S]+)/);
      if (_jsonMatch) {
        try {
          const _parsed = JSON.parse(_jsonMatch[1].trim());
          const _items = Array.isArray(_parsed) ? _parsed : (_parsed?.items || []);
          if (_items.length > 0) {
            _sanitizedBody = _items.map(item => `• ${item.summary || item.title || JSON.stringify(item)}`).join('\n');
          }
        } catch (_) {}
      }
    }
    messagingBodyNote = `\n\n⚠️ MESSAGE BODY — CRITICAL:\nThe user said "${userMessage}". The content they want sent is from the PREVIOUS task. Use this EXACT content as the message body (do not summarize or replace with a placeholder):\n---\n${_sanitizedBody}\n---\nDo NOT add a user.agent step to re-fetch this content — it is already provided above. Only add steps to resolve the recipient address (if unknown) and to send the email.`;
    logger.info(`[Node:PlanSkillsV2] Injected prior synthesized content as messaging body (${priorSynthesizedContent.length} chars)`);
  }

  // ── SMS gateway injection ─────────────────────────────────────────────────
  let smsGatewayNote = '';
  if (state.smsGatewayTarget) {
    const gwt = state.smsGatewayTarget;
    const isMms = gwt.mode === 'mms' && gwt.mmsEmail;
    const activeEmail = isMms ? gwt.mmsEmail : gwt.email;
    if (activeEmail) {
      const maxChars = isMms ? 1600 : 160;
      smsGatewayNote = `\n\n⚠️ SMS GATEWAY ROUTE: To send an SMS/text message, send an email to "${activeEmail}" via gmail.agent (action: "run", agentId: "gmail.agent"). NEVER use Twilio, ClickSend, or any paid SMS API. Keep message body under ${maxChars} chars. The carrier gateway converts email→SMS automatically.`;
    }
  }

  // ── Parallel runGroup instruction ─────────────────────────────────────────
  // When steps are clearly independent (e.g. scraping two sites, resolving user
  // info while browsing), instruct the LLM to mark them with the same runGroup
  // value so executeCommand.js can fan them out with Promise.allSettled.
  const parallelNote = `\n\n## PARALLEL EXECUTION (runGroup)
When two or more steps are completely independent (no data dependency between them), add "runGroup": "<group_id>" to each step in the group. Steps sharing the same runGroup value will be executed in parallel.

Rules:
- Use short IDs like "g1", "g2" etc.
- Only group steps that do NOT depend on each other's output
- Grouped steps MUST be consecutive in the plan array
- Do NOT group synthesize, schedule, or shell.run steps
- Example: comparing prices on site A AND site B, plus resolving user email → all three can be "runGroup": "g1" since none depend on each other

Example:
[
  { "skill": "browser.agent", "args": { "agentId": "amazon.agent", ... }, "runGroup": "g1", "description": "Search Amazon" },
  { "skill": "browser.agent", "args": { "agentId": "ebay.agent", ... },   "runGroup": "g1", "description": "Search eBay" },
  { "skill": "user.agent",    "args": { ... },                             "runGroup": "g1", "description": "Resolve user email" },
  { "skill": "synthesize",    "args": { "prompt": "Compare and email results" } }
]`;

  const planningQuery = [
    _agentIdentity,
    SKILL_SYSTEM_PROMPT,
    creatorContextNote,
    recoveryNote,
    correctionNote,
    priorResultsNote,
    conversationNote,
    skillContractNote,
    cliPreflightNote,
    agentContextNote,
    smsGatewayNote,
    dateRangeNote,
    runtimeNote,
    messagingBodyNote,
    parallelNote,
    `\n\nUser request: "${(runtimeParamMessage || userMessage).replace(/"/g, '\\"').slice(0, 2000)}"`,
  ].filter(Boolean).join('\n');

  // ── LLM call ──────────────────────────────────────────────────────────────
  if (progressCallback) progressCallback({ type: 'planning', message: 'Planning steps…' });

  const _maxTokens = Math.min(3000, Math.max(800, 4000 - Math.round(planningQuery.length / 4)));
  const payload = {
    query: planningQuery,
    context: {
      systemInstructions: SKILL_SYSTEM_PROMPT,
      conversationHistory: [],
      intent: intent?.type || 'command_automate',
    },
    options: { maxTokens: _maxTokens, temperature: 0.1 },
    messages: [{ role: 'user', content: planningQuery }],
  };

  let rawPlan;
  try {
    rawPlan = await backend.generateAnswer(planningQuery, payload, payload.options, null);
  } catch (err) {
    logger.error(`[Node:PlanSkillsV2] LLM call failed: ${err.message}`);
    return { ...state, planError: `LLM planning failed: ${err.message}` };
  }

  if (!rawPlan || typeof rawPlan !== 'string' || rawPlan.trim().length === 0) {
    logger.warn('[Node:PlanSkillsV2] LLM returned empty response');
    return { ...state, planError: 'LLM returned empty response — please try again' };
  }

  // ── Parse + retry ─────────────────────────────────────────────────────────
  let skillPlan = parsePlan(rawPlan, logger);
  if (!skillPlan) {
    logger.warn('[Node:PlanSkillsV2] Initial parse failed — retrying with enriched context');
    if (progressCallback) progressCallback({ type: 'planning', message: 'Retrying plan generation…' });
    const enrichedQuery = `${planningQuery}\n\nIMPORTANT: You MUST output a valid JSON array of skill steps. Do NOT output prose or { "error": ... } unless the task is truly impossible.`;
    try {
      const rawRetry = await backend.generateAnswer(enrichedQuery, payload, payload.options, null);
      skillPlan = parsePlan(rawRetry, logger);
    } catch (_) {}
  }

  if (!skillPlan) {
    return { ...state, planError: `Failed to parse skill plan from LLM output: ${rawPlan.substring(0, 200)}` };
  }

  // ── Normalize single-step object ──────────────────────────────────────────
  if (!Array.isArray(skillPlan) && skillPlan && typeof skillPlan === 'object') {
    if (skillPlan.skill) skillPlan = [skillPlan];
    else if (Array.isArray(skillPlan.steps)) skillPlan = skillPlan.steps;
    else {
      for (const v of Object.values(skillPlan)) {
        if (Array.isArray(v) && v.length > 0 && typeof v[0]?.skill === 'string') { skillPlan = v; break; }
      }
    }
    if (!Array.isArray(skillPlan)) return { ...state, planError: `Cannot parse skill plan — no step array found` };
  }

  // ── Clarification / error objects from LLM ────────────────────────────────
  if (!Array.isArray(skillPlan) && skillPlan?.ask) {
    const { ask: question, options: opts = [] } = skillPlan;
    logger.debug(`[Node:PlanSkillsV2] LLM needs clarification: ${question}`);
    if (progressCallback) progressCallback({ type: 'plan_error', error: question });
    return { ...state, recoveryAction: 'ask_user', pendingQuestion: { question, options: opts, context: null }, commandExecuted: false, answer: question };
  }
  if (!Array.isArray(skillPlan) && skillPlan?.error) {
    const errMsg = skillPlan.error;
    const isPlaceholder = !errMsg || errMsg === 'reason' || errMsg.length < 10;
    if (isPlaceholder) {
      logger.warn('[Node:PlanSkillsV2] LLM returned placeholder error — retrying');
      if (progressCallback) progressCallback({ type: 'planning', message: 'Retrying with more context…' });
      const enrichedQuery = `${planningQuery}\n\nIMPORTANT: You MUST output a valid JSON array of skill steps. Do NOT output { "error": ... } unless the task is truly impossible.`;
      try {
        const retryRaw = await backend.generateAnswer(enrichedQuery, payload, payload.options, null);
        const retryPlan = parsePlan(retryRaw, logger);
        if (retryPlan && Array.isArray(retryPlan)) {
          if (progressCallback) progressCallback({ type: 'plan_ready', steps: retryPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args, runGroup: s.runGroup || undefined })), intent: state.intent?.type || 'command_automate' });
          return { ...state, skillPlan: retryPlan, skillCursor: 0, recoveryContext: null, planError: null };
        }
      } catch (_) {}
    }
    const humanError = isPlaceholder
      ? 'I need more context — try being more specific (e.g. include the full file path).'
      : `Cannot automate this: ${errMsg}`;
    if (progressCallback) progressCallback({ type: 'plan_error', error: humanError });
    return { ...state, planError: humanError, commandExecuted: false, answer: humanError };
  }

  // ── Contract guard: shell skills must not use external.skill ─────────────
  if (Array.isArray(skillPlan) && shellSkillNames.size > 0) {
    const contractViolation = skillPlan.find(s => s.skill === 'external.skill' && s.args?.name && shellSkillNames.has(s.args.name));
    if (contractViolation) {
      const badName = contractViolation.args.name;
      logger.warn(`[Node:PlanSkillsV2] Contract guard: retrying for shell skill "${badName}"`);
      const forceMsg = [
        `CRITICAL CORRECTION: You generated { "skill": "external.skill", "args": { "name": "${badName}" } } — this is WRONG.`,
        `"${badName}" is a shell contract skill (exec_type: shell). It is NOT a Node.js module.`,
        `You MUST generate shell.run steps with curl commands from the contract below.`,
        `Do NOT use external.skill. Output ONLY a valid JSON array with shell.run (and optionally synthesize) steps.`,
        _shellContractMd ? `\nCONTRACT:\n${_shellContractMd.slice(0, 2500)}` : '',
      ].filter(Boolean).join('\n');
      const retryPayload2 = { ...payload, messages: [...(payload.messages || []), { role: 'user', content: forceMsg }] };
      try {
        const rawRetry2 = await backend.generateAnswer(planningQuery, retryPayload2, payload.options, null);
        const retryPlan2 = parsePlan(rawRetry2, logger);
        if (retryPlan2 && !retryPlan2.find(s => s.skill === 'external.skill' && shellSkillNames.has(s.args?.name))) {
          skillPlan = retryPlan2;
          logger.info(`[Node:PlanSkillsV2] Contract guard: retry succeeded for "${badName}"`);
        } else {
          if (progressCallback) progressCallback({ type: 'plan_error', error: `Skill "${badName}" is a shell contract and cannot run via external.skill.` });
          return { ...state, planError: `Contract skill "${badName}" cannot be executed via external.skill.` };
        }
      } catch (_) {}
    }
  }

  // ── browser.act bypass detector ───────────────────────────────────────────
  const _BYPASS_GUARD_SERVICES = new Set(['perplexity','grok','claude','deepseek','mistral','copilot','suno','midjourney','runway','chatgpt','gemini','openai']);
  const _NAV_ACTIONS = new Set(['navigate','tab-new','newPage']);

  if (Array.isArray(skillPlan) && !state.domainSkillFastPath) {
    const _collectBypasses = (plan) => {
      const found = [];
      for (const s of plan) {
        if (s.skill !== 'browser.act' || !_NAV_ACTIONS.has(s.args?.action) || !s.args?.url) continue;
        let host = '';
        try { host = new URL(s.args.url).hostname.replace(/^www\./, ''); } catch (_e) { continue; }
        const bare = host.replace(/\.(ai|com|io|org|net|co|app|dev|me|us|uk)(\.[a-z]{2})?$/, '');
        const matched = _registeredAgentServiceMap[bare] || _registeredAgentServiceMap[host];
        if (matched && !found.some(b => b.agentId === matched)) { found.push({ service: bare || host, agentId: matched, needsBuild: false }); continue; }
        const guardKey = bare || host.split('.')[0];
        if (_BYPASS_GUARD_SERVICES.has(guardKey) && !found.some(b => b.service === guardKey)) { found.push({ service: guardKey, agentId: `${guardKey}.agent`, needsBuild: true }); }
        const sid = (s.args?.sessionId || '').toLowerCase();
        if (sid && _registeredAgentServiceMap[sid] && !found.some(b => b.agentId === _registeredAgentServiceMap[sid])) { found.push({ service: sid, agentId: _registeredAgentServiceMap[sid], needsBuild: false }); }
        else if (sid && _BYPASS_GUARD_SERVICES.has(sid) && !found.some(b => b.service === sid)) { found.push({ service: sid, agentId: `${sid}.agent`, needsBuild: true }); }
      }
      return found;
    };

    const bypasses = _collectBypasses(skillPlan);
    if (bypasses.length > 0) {
      logger.warn(`[Node:PlanSkillsV2] browser.act bypass detected: [${bypasses.map(b => b.service).join(', ')}] — rewriting`);
      const bypassKeys = new Set(bypasses.map(b => b.service));
      const rewritten = [];
      let i = 0;
      while (i < skillPlan.length) {
        const s = skillPlan[i];
        let clusterSvc = null;
        if (s.skill === 'browser.act') {
          let url = s.args?.url || '';
          let cHost = '';
          try { cHost = new URL(url).hostname.replace(/^www\./, ''); } catch (_e) {}
          const cBare = cHost.replace(/\.(ai|com|io|org|net|co|app|dev|me|us|uk)(\.[a-z]{2})?$/, '');
          const cSid = (s.args?.sessionId || '').toLowerCase();
          if (bypassKeys.has(cBare)) clusterSvc = cBare;
          else if (bypassKeys.has(cHost.split('.')[0])) clusterSvc = cHost.split('.')[0];
          else if (bypassKeys.has(cSid)) clusterSvc = cSid;
        }
        if (clusterSvc) {
          const cluster = [];
          let j = i;
          while (j < skillPlan.length && skillPlan[j].skill === 'browser.act') { cluster.push(skillPlan[j]); j++; }
          const typeAction = cluster.find(c => ['type','fill','keyboard-type'].includes(c.args?.action) && c.args?.text);
          const taskStr = typeAction?.args?.text || userMessage;
          const bEntry = bypasses.find(b => b.service === clusterSvc);
          if (bEntry?.needsBuild) rewritten.push({ skill: 'browser.agent', args: { action: 'build_agent', service: clusterSvc }, description: `Set up ${clusterSvc} agent` });
          rewritten.push({ skill: 'browser.agent', args: { action: 'run', agentId: bEntry?.agentId || `${clusterSvc}.agent`, task: taskStr }, description: `Research on ${clusterSvc}` });
          i = j;
        } else {
          rewritten.push(s);
          i++;
        }
      }
      skillPlan = rewritten;
      logger.info(`[Node:PlanSkillsV2] Bypass rewrite complete — ${skillPlan.length} steps`);
    }
  }

  // ── Phase 2: {{EXPAND}} placeholder expansion ─────────────────────────────
  if (Array.isArray(skillPlan)) {
    const EXPAND_RE = /^\{\{EXPAND:(.+)\}\}$/;
    for (let i = 0; i < skillPlan.length; i++) {
      const step = skillPlan[i];
      if (step.skill !== 'synthesize' || !step.args?.prompt) continue;
      const match = step.args.prompt.match(EXPAND_RE);
      if (!match) continue;
      const expandIntent = match[1].trim();
      logger.debug(`[Node:PlanSkillsV2] Phase 2 expand: step ${i + 1} — "${expandIntent}"`);
      const priorSteps = skillPlan.slice(0, i).map((s, j) => `Step ${j + 1}: ${s.skill}${s.args?.url ? ` (${s.args.url})` : ''}${s.description ? ` — ${s.description}` : ''}`).join('\n');
      const expandQuery = `Write a detailed synthesize prompt for this task.\n\nContext — this is step ${i + 1} in a plan:\n${priorSteps}\n\nIntent: ${expandIntent}\nUser request: "${userMessage}"\n\nWrite ONLY the prompt text (no JSON, no fences).`;
      try {
        const expanded = await backend.generateAnswer(expandQuery, { query: expandQuery, context: { systemInstructions: 'You write precise LLM prompts. Output only the prompt text, nothing else.', conversationHistory: [], intent: 'command_automate' }, options: { maxTokens: 800, temperature: 0.1, fastMode: true } }, { maxTokens: 800, temperature: 0.1, fastMode: true }, null);
        if (expanded && expanded.trim().length > 20) {
          skillPlan[i].args.prompt = expanded.trim().replace(/^```[a-zA-Z]*\r?\n/, '').replace(/\n```\s*$/, '').trim();
          logger.info(`[Node:PlanSkillsV2] Phase 2 expanded step ${i + 1}: ${skillPlan[i].args.prompt.length} chars`);
        } else {
          skillPlan[i].args.prompt = expandIntent;
        }
      } catch (_) { skillPlan[i].args.prompt = expandIntent; }
    }
  }

  // ── URL hallucination guard ───────────────────────────────────────────────
  if (Array.isArray(skillPlan) && userMessage) {
    const navIdx = skillPlan.findIndex(s => s.skill === 'browser.act' && s.args?.action === 'navigate' && s.args?.url);
    if (navIdx !== -1) {
      try {
        const navUrl = skillPlan[navIdx].args.url;
        const plannedHost = new URL(navUrl).hostname.replace(/^www\./, '');
        const plannedBase = plannedHost.split('.')[0];
        const msgLow = userMessage.toLowerCase();
        const oldSessionBase = (state.activeBrowserSessionId || '').split('.')[0].toLowerCase();
        if (!msgLow.includes(plannedBase) && oldSessionBase === plannedBase) {
          const siteWords = (msgLow.match(/\b[a-z]{4,}\b/g) || []).filter(w => !['goto','open','navigate','look','find','search','first','john','and','with','that','this','then','when','from','into','about','over','some','have','been','will','your','they','them','what','which','also','just','like','well','very','make','need','want','take','give','come','here','there','where','while'].includes(w));
          let bestWord = null, bestScore = 0;
          for (const w of siteWords) {
            let shared = 0;
            const minLen = Math.min(w.length, plannedBase.length);
            for (let i = 0; i < minLen; i++) { if (w[i] === plannedBase[i]) shared++; else break; }
            if (shared > bestScore) { bestScore = shared; bestWord = w; }
          }
          if (bestWord && bestScore >= 4 && bestWord !== plannedBase) {
            const tld = plannedHost.includes('.') ? plannedHost.slice(plannedBase.length) : '.com';
            const corrected = `https://www.${bestWord}${tld}`;
            try { new URL(corrected); skillPlan = skillPlan.map((s, i) => i !== navIdx ? s : { ...s, args: { ...s.args, url: corrected } }); logger.info(`[Node:PlanSkillsV2] URL hallucination guard: "${navUrl}" → "${corrected}"`); } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }

  // ── Active browser session enforcement ────────────────────────────────────
  const effectiveSessionId = state.activeBrowserSessionId || activeBrowserSessionId;
  if (effectiveSessionId && Array.isArray(skillPlan)) {
    const browserSteps = skillPlan.filter(s => s.skill === 'browser.act');
    if (browserSteps.length > 0) {
      const plannedSessionIds = new Set(browserSteps.map(s => s.args?.sessionId).filter(Boolean));
      const isMultiTab = plannedSessionIds.size > 1;
      if (isMultiTab) {
        const [primarySession] = [...plannedSessionIds];
        let firstNavSeen = false;
        skillPlan = skillPlan.map(step => {
          if (step.skill !== 'browser.act') return step;
          const unified = { ...step, args: { ...step.args, sessionId: primarySession } };
          if (step.args?.action === 'navigate') {
            if (!firstNavSeen) { firstNavSeen = true; return unified; }
            return { ...unified, args: { ...unified.args, action: 'tab-new', url: step.args.url } };
          }
          return unified;
        });
        logger.debug(`[Node:PlanSkillsV2] Multi-tab: ${plannedSessionIds.size} sessions → 1 session "${primarySession}"`);
      } else {
        const navStep = skillPlan.find(s => s.skill === 'browser.act' && s.args?.action === 'navigate');
        const activeBrowserUrl = state.activeBrowserUrl || null;
        const DOMAIN_ALIASES = { 'chat.openai.com': 'chatgpt.com', 'chatgpt.com': 'chat.openai.com', 'www.google.com': 'google.com', 'google.com': 'www.google.com' };
        const normalizeDomain = h => DOMAIN_ALIASES[h] ? [h, DOMAIN_ALIASES[h]] : [h];
        const isSameDomain = navStep && activeBrowserUrl ? (() => { try { return normalizeDomain(new URL(navStep.args.url).hostname).includes(new URL(activeBrowserUrl).hostname); } catch (_) { return false; } })() : false;
        const isEvalRetry = (state.evaluationRetryCount || 0) > 0;
        if (isSameDomain && !isEvalRetry) {
          skillPlan = skillPlan.map(s => s.skill !== 'browser.act' ? s : { ...s, args: { ...s.args, sessionId: effectiveSessionId } });
          const withoutNav = skillPlan.filter(s => !(s.skill === 'browser.act' && s.args?.action === 'navigate'));
          if (withoutNav.length > 0) { skillPlan = withoutNav; logger.debug(`[Node:PlanSkillsV2] Reused active session "${effectiveSessionId}" — stripped navigate (same domain)`); }
        } else {
          skillPlan = skillPlan.map(s => s.skill !== 'browser.act' ? s : { ...s, args: { ...s.args, sessionId: effectiveSessionId } });
          logger.debug(`[Node:PlanSkillsV2] Enforced active session "${effectiveSessionId}"`);
        }
      }
    }
  }

  // ── Stamp missing sessionIds ──────────────────────────────────────────────
  if (Array.isArray(skillPlan)) {
    const navStep = skillPlan.find(s => s.skill === 'browser.act' && s.args?.action === 'navigate' && s.args?.url);
    const existingSessions = new Set(skillPlan.filter(s => s.skill === 'browser.act').map(s => s.args?.sessionId).filter(Boolean));
    if (existingSessions.size <= 1 && navStep && !navStep.args?.sessionId) {
      let derived = null;
      if (state.activeBrowserSessionId && state.activeBrowserUrl && navStep.args?.url) {
        try {
          if (new URL(state.activeBrowserUrl).hostname === new URL(navStep.args.url).hostname) derived = state.activeBrowserSessionId;
        } catch (_) {}
      }
      if (!derived) derived = 'browser';
      skillPlan = skillPlan.map(s => s.skill !== 'browser.act' || s.args?.sessionId ? s : { ...s, args: { ...s.args, sessionId: derived } });
      logger.info(`[Node:PlanSkillsV2] Stamped missing sessionIds with "${derived}"`);
    }
  }

  // ── Final session normalization ───────────────────────────────────────────
  if (Array.isArray(skillPlan)) {
    const bSteps = skillPlan.filter(s => s.skill === 'browser.act');
    if (bSteps.length > 0) {
      const sessionIds = new Set(bSteps.map(s => s.args?.sessionId).filter(Boolean));
      if (sessionIds.size === 1) {
        const [onlySession] = [...sessionIds];
        if (onlySession && onlySession !== 'browser') {
          const isRegisteredAgent = !!_registeredAgentServiceMap[onlySession.toLowerCase()];
          const BROWSER_PROFILES_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
          const profileDir = onlySession.endsWith('_agent') ? onlySession : `${onlySession}_agent`;
          const hasProfile = fs.existsSync(path.join(BROWSER_PROFILES_DIR, profileDir));
          if (isRegisteredAgent || hasProfile) {
            logger.info(`[Node:PlanSkillsV2] Skipping sessionId normalization — "${onlySession}" has persisted profile`);
          } else {
            skillPlan = skillPlan.map(s => s.skill !== 'browser.act' ? s : { ...s, args: { ...s.args, sessionId: 'browser' } });
            logger.info(`[Node:PlanSkillsV2] Normalized sessionId "${onlySession}" → "browser"`);
          }
        }
      }
    }
  }

  // ── project.launcher guard ────────────────────────────────────────────────
  const projectLauncherStep = skillPlan.length === 1 && skillPlan[0].skill === 'project.launcher' ? skillPlan[0] : null;
  if (projectLauncherStep) {
    const msgLower = (userMessage || '').toLowerCase();
    const explicit = /\b(open|launch|start|run|show)\b.{0,30}\bproject\b/i.test(userMessage) || (projectLauncherStep.args?.projectName && msgLower.includes(projectLauncherStep.args.projectName.toLowerCase()));
    if (!explicit) {
      logger.info('[Node:PlanSkillsV2] Guard: project.launcher without explicit reference — converting to needs_skill');
      skillPlan = [{ skill: 'needs_skill', args: { capability: userMessage, suggestion: null }, description: 'needs_skill' }];
    }
  }

  // ── needs_skill intercept ─────────────────────────────────────────────────
  const needsSkillStep = skillPlan.find(s => s.skill === 'needs_skill');
  if (needsSkillStep) {
    const capability = needsSkillStep.args?.capability || userMessage;
    if (progressCallback) progressCallback({ type: 'needs_skill', capability });
    logger.info(`[Node:PlanSkillsV2] needs_skill: "${capability}"`);
  }

  // ── Save skill intent detection ───────────────────────────────────────────
  if (detectSaveSkillIntent(userMessage) && state._lastShellRun) {
    const { lastExecution } = state;
    if (lastExecution?.skill === 'shell.run') {
      const pythonCode = (lastExecution.args?.cmd === 'python3' && Array.isArray(lastExecution.args?.argv))
        ? lastExecution.args.argv.slice(1).join(' ')
        : null;
      if (pythonCode) {
        const skillName = deriveSkillName(userMessage.replace(/save this|as a skill|make this reusable/gi, '').trim() || capability);
        logger.info(`[Node:PlanSkillsV2] Save skill intent: "${skillName}"`);
        skillPlan = [{
          skill: 'skillCreator.skill',
          description: `Save script as ${skillName}`,
          args: { name: skillName, code: pythonCode, language: 'python' },
        }];
      }
    }
  }

  // ── Save plan to disk ─────────────────────────────────────────────────────
  let _skillPlanFile = state._skillPlanFile || null;
  let _planId = null;
  try {
    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
    _planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const planMd = serializeSkillPlanToMd(skillPlan, userMessage, _planId, state.sessionId || 'unknown');
    _skillPlanFile = path.join(PLANS_DIR, `${_planId}.md`);
    fs.writeFileSync(_skillPlanFile, planMd, 'utf8');
    logger.info(`[Node:PlanSkillsV2] Plan saved: ${_skillPlanFile}`);
  } catch (_) {}

  // ── Plan approval gate ──────────────────────────────────────────────────────
  // Read planApprovalMode from settings: "always" | "multi_step" (default) | "auto"
  let _planApprovalMode = 'multi_step';
  try {
    const _settingsPath = path.join(os.homedir(), '.thinkdrop', 'settings.json');
    if (fs.existsSync(_settingsPath)) {
      const _sd = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
      if (_sd.planApprovalMode && ['always', 'multi_step', 'auto'].includes(_sd.planApprovalMode)) {
        _planApprovalMode = _sd.planApprovalMode;
      }
    }
  } catch (_) {}

  const _needsApproval = _planApprovalMode === 'always' ||
    (_planApprovalMode === 'multi_step' && skillPlan.length >= 2);

  if (_needsApproval) {
    logger.info(`[Node:PlanSkillsV2] Plan approval required (mode=${_planApprovalMode}, steps=${skillPlan.length})`);
    const planContent = _skillPlanFile ? fs.readFileSync(_skillPlanFile, 'utf8') : '';
    const skillPlanJson = Buffer.from(JSON.stringify(skillPlan)).toString('base64');
    if (progressCallback) {
      progressCallback({
        type: 'plan:generated',
        planFile: _skillPlanFile,
        planId: _planId,
        content: planContent,
        skillPlanJson,
      });
    }
    return {
      ...state,
      awaitingPlanApproval: true,
      _skillPlanFile,
      skillPlan: null,
      skillCursor: 0,
      planError: null,
      recoveryContext: null,
    };
  }

  // ── Auto-execute: emit plan_ready ─────────────────────────────────────────
  logger.debug(`[Node:PlanSkillsV2] Plan ready (auto-execute, mode=${_planApprovalMode}): ${skillPlan.length} steps`);
  skillPlan.forEach((s, i) => logger.debug(`  Step ${i + 1}: ${s.skill} — ${s.description || JSON.stringify(s.args)}`));

  if (progressCallback) {
    progressCallback({
      type: 'plan_ready',
      steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args, runGroup: s.runGroup || undefined })),
      intent: state.intent?.type || 'command_automate',
    });
  }

  return {
    ...state,
    skillPlan,
    skillCursor: 0,
    planError: null,
    recoveryContext: null,
    _skillPlanFile,
  };
}

module.exports = planSkillsV2;

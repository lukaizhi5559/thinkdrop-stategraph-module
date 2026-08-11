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
const { formatHistoryTurns } = require('../utils/formatHistoryTurns');

/**
 * Analyzes a skill plan and adds runGroup properties for parallel execution.
 * Only called for plans with 3+ steps to avoid unnecessary LLM overhead.
 * 
 * @param {Array} skillPlan - The generated skill plan
 * @param {string} userMessage - Original user request
 * @param {Object} backend - LLM backend instance
 * @param {Object} logger - Logger instance
 * @returns {Array} - Plan with runGroup properties added where appropriate
 */
async function analyzeAndAddParallelGroups(skillPlan, userMessage, backend, logger) {
  try {
    logger.info(`[Node:PlanSkillsV2] Analyzing ${skillPlan.length} steps for parallel execution opportunities`);
    
    // Create a numbered list of steps for the LLM
    const stepsList = skillPlan.map((step, i) => {
      const desc = step.description || buildStepDescription(step);
      return `${i + 1}. ${step.skill} — ${desc}`;
    }).join('\n');
    
    const analysisPrompt = `Analyze this skill plan and identify which steps can run in parallel.

USER REQUEST: "${userMessage}"

PLAN STEPS:
${stepsList}

ORIGINAL PLAN STRUCTURE (preserve exactly, only add runGroup):
${JSON.stringify(skillPlan, null, 2)}

RULES:
- Steps can run in parallel ONLY if they don't depend on each other's output
- Independent searches, fetches, or data gathering steps are good candidates
- synthesize, schedule, and shell.run steps should NOT be parallelized
- Group consecutive independent steps with the same runGroup ID (g1, g2, etc.)
- If no steps can be parallelized, return the plan unchanged
- CRITICAL: Preserve ALL fields exactly as they are, only ADD runGroup where appropriate
- DO NOT modify args, skill, description, or any other existing fields
- IMPORTANT: Do NOT group steps that use template variables (like {{bestUrl}}, {{result}}, etc.) from previous steps
- IMPORTANT: If a step's args contain {{variable}} patterns, it depends on the previous step and cannot be parallel

Return the plan as a JSON array with runGroup properties added where appropriate.
The output must be a valid JSON array starting with [ and ending with ].
Example: [{"skill": "web.agent", "args": {"action": "...", "query": "..."}, "runGroup": "g1"}, ...]`;

    const response = await backend.generateAnswer(analysisPrompt, {
      query: analysisPrompt,
      context: {
        systemInstructions: 'You are a parallel execution optimizer. Return only valid JSON arrays.',
        conversationHistory: [],
        intent: 'command_automate'
      },
      options: { maxTokens: 1000, temperature: 0.1 }
    }, { maxTokens: 1000, temperature: 0.1, taskType: 'classification' });
    
    if (!response) {
      logger.warn('[Node:PlanSkillsV2] Parallel analysis returned empty response');
      return skillPlan;
    }
    
    // Try to parse the response
    let analyzedPlan;
    try {
      analyzedPlan = parsePlan(response, logger);
    } catch (parseErr) {
      logger.warn(`[Node:PlanSkillsV2] Failed to parse parallel analysis response: ${parseErr.message}`);
      return skillPlan;
    }
    
    if (!Array.isArray(analyzedPlan) || analyzedPlan.length !== skillPlan.length) {
      logger.warn('[Node:PlanSkillsV2] Parallel analysis returned invalid plan structure');
      return skillPlan;
    }
    
    // Validate that args objects are preserved correctly
    const corruptedArgs = analyzedPlan.filter((step, i) => {
      const originalArgs = skillPlan[i].args;
      const newArgs = step.args;
      // Check if args was converted from object to string
      return (typeof originalArgs === 'object' && originalArgs !== null) && 
             (typeof newArgs !== 'object' || newArgs === null);
    });
    
    if (corruptedArgs.length > 0) {
      logger.warn(`[Node:PlanSkillsV2] Parallel analysis corrupted ${corruptedArgs.length} args fields - falling back to original plan`);
      return skillPlan;
    }
    
    // Hard guard: strip runGroup from skills that must never run in parallel,
    // regardless of what the LLM returned
    const SEQUENTIAL_ONLY_SKILLS = new Set(['synthesize', 'schedule', 'shell.run']);
    analyzedPlan = analyzedPlan.map(step =>
      SEQUENTIAL_ONLY_SKILLS.has(step.skill) ? { ...step, runGroup: undefined } : step
    );

    // Deterministic merge: if every step is independent (no {{variable}} dependencies)
    // and none are sequential-only, collapse all parallelizable steps into a single
    // runGroup. This guarantees that independent multi-agent plans execute concurrently
    // regardless of how the LLM split runGroups (e.g. g1, g2, g1 → all g1).
    const hasTemplateDeps = analyzedPlan.some(step => {
      const stepText = JSON.stringify(step.args || {}) + ' ' + (step.description || '');
      return /\{\{[^}]+\}\}/.test(stepText);
    });
    const hasSequentialOnly = analyzedPlan.some(step => SEQUENTIAL_ONLY_SKILLS.has(step.skill));

    if (!hasTemplateDeps && !hasSequentialOnly && analyzedPlan.length > 1) {
      analyzedPlan = analyzedPlan.map(step =>
        SEQUENTIAL_ONLY_SKILLS.has(step.skill) ? step : { ...step, runGroup: 'g1' }
      );
      logger.info('[Node:PlanSkillsV2] Deterministic merge: all independent steps collapsed into runGroup g1');
    }

    // Count how many runGroups were added
    const runGroupsAdded = analyzedPlan.filter(s => s.runGroup).length;
    if (runGroupsAdded > 0) {
      logger.info(`[Node:PlanSkillsV2] Added ${runGroupsAdded} steps to parallel groups`);
      return analyzedPlan;
    } else {
      logger.info('[Node:PlanSkillsV2] No parallel execution opportunities identified');
      return skillPlan;
    }
    
  } catch (err) {
    logger.error(`[Node:PlanSkillsV2] Error in parallel analysis: ${err.message}`);
    return skillPlan;
  }
}
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
const { findSimilarCompletePlan, findMostRecentPlanInSession, domainsMatch, isCorrectionSignal }  = require('../utils/planCacheHelpers');
const { buildReminderSkill }       = require('../utils/buildReminderSkill');

// ─────────────────────────────────────────────────────────────────────────────
// Prompt loader
// ─────────────────────────────────────────────────────────────────────────────

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// Module-level cache for prompt files. Keyed by absolute path; invalidated when
// the file's mtime changes so edits to prompt files are picked up without a
// restart. Saves repeated disk I/O for the hot plan-skills* files.
const _promptFileCache = new Map();

function _loadPromptFile(filename) {
  try {
    const p = path.join(PROMPTS_DIR, filename);
    if (!fs.existsSync(p)) return null;
    const mtime = fs.statSync(p).mtimeMs;
    const cached = _promptFileCache.get(p);
    if (cached && cached.mtime === mtime) return cached.content;
    const content = fs.readFileSync(p, 'utf8');
    _promptFileCache.set(p, { mtime, content });
    return content;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// App descriptor loader for app.agent tasks
// Reads the per-app skill descriptor so the planner can use discovered shortcuts
// instead of guessing.
// ─────────────────────────────────────────────────────────────────────────────

function _extractAppNameFromMessage(userMessage, screenCtx) {
  if (screenCtx?.appName) return screenCtx.appName;

  const patterns = [
    /in\s+(?:the\s+)?([a-z][a-z0-9]*)\s+app/i,
    /using\s+(?:the\s+)?([a-z][a-z0-9]*)\s+app/i,
    /via\s+(?:the\s+)?([a-z][a-z0-9]*)\s+app/i,
    /open\s+(?:the\s+)?([a-z][a-z0-9]*)\s+app/i,
    /([a-z][a-z0-9]*)\s+app\b/i,
  ];

  for (const pattern of patterns) {
    const match = userMessage.match(pattern);
    if (match) {
      return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    }
  }

  return null;
}

function _readAppDescriptorForPlanner(appName) {
  try {
    const safe = appName.replace(/\s+/g, '_').toLowerCase();
    const descriptorPath = path.join(os.homedir(), '.thinkdrop', 'agents', `${safe}.app.agent.md`);
    if (!fs.existsSync(descriptorPath)) return null;

    const content = fs.readFileSync(descriptorPath, 'utf8');
    const shortcutsMatch = content.match(/## Shortcuts\n([\s\S]*?)(?=\n## |$)/);
    if (!shortcutsMatch) return null;

    const tableLines = shortcutsMatch[1].trim().split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
    const shortcuts = tableLines.slice(1).map(line => {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 2) return { action: cols[0], shortcut: cols[1], context: cols[2] || '' };
      return null;
    }).filter(Boolean);

    return { appName, shortcuts, descriptorPath };
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt tier selection — V2 architecture
//
// BEFORE: regex stacking — "open" verb triggers slim → "open my-folder" fires slim
// AFTER:  URL presence check — slim fires ONLY when message has a URL/hostname
//         "open my-folder for me" has no URL → full prompt, always correct
// ─────────────────────────────────────────────────────────────────────────────

const _URL_RE = /https?:\/\/\S+/i;

// ---------------------------------------------------------------------------
// CLI registry keyword detection — used to decide whether to append the
// CLI-first appendix. Reads the same cli-registry.json that cli.agent.cjs
// loads, so phrases like "convert to pdf" trigger CLI-first planning.
// ---------------------------------------------------------------------------

function _loadCliRegistryForConversionDetection() {
  try {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'mcp-services', 'command-service', 'src', 'cli-registry.json');
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      }
      dir = path.dirname(dir);
    }
  } catch (_) {}
  return null;
}

function _registryKeywordMatch(userMessage) {
  const registry = _loadCliRegistryForConversionDetection();
  if (!registry) return false;
  const msg = userMessage.toLowerCase();
  for (const serviceDef of Object.values(registry)) {
    const keywords = Array.isArray(serviceDef.keywords) ? serviceDef.keywords : [];
    if (keywords.some(k => k && msg.includes(k.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

// If preflight already detected a CLI tool (registry, seed map, or LLM-discovered),
// make sure the planner loads the CLI-first appendix.
function _preflightImpliesCli(state) {
  const map = state?.preflightResult?.preflightCliMap;
  if (!map || typeof map !== 'object') return false;
  return Object.values(map).some(entry => entry?.hasCli);
}

function _inferOutputSchemaFallback(userMessage) {
  const msg = userMessage || '';
  // Only infer for very obvious single-type patterns.
  // Multi-type detection is left to the LLM — the regex is intentionally conservative
  // to avoid false positives that would enforce the wrong type.
  if (/\b(how many|count the|number of|how much|how long)\b/i.test(msg))
    return { type: 'INTEGER' };
  if (/\b(is there|are there|check if|can i|do i have)\b/i.test(msg))
    return { type: 'BOOLEAN' };
  if (/\b(list all|list every|show all|show me all|enumerate|find all|name all)\b/i.test(msg))
    return { type: 'ARRAY' };
  return null;
}

function _buildSystemPrompt(userMessage, state) {
  const isWindows = process.platform === 'win32';

  const _hasExplicitUrl = _URL_RE.test(userMessage);
  const _hasLocalSignals = !!(
    state.grilledConstraints ||
    state.activeBrowserSessionId ||
    state.creatorSkillName ||
    state.projectSkillPlan ||
    state.matchedSkillName ||
    state.matchedSkillDomain
  );
  const _tc = state._taskClassification;
  const _screenCtx = state._priorScreenContext;

  // Is a browser app currently in focus (live Chrome/Safari/Firefox window)?
  const _browserIsOpen = _screenCtx?.category === 'browser' && !!_screenCtx?.appName;

  // ── Determine which domain appendices are relevant ──────────────────────
  // The base prompt is always loaded; selected appendices are concatenated so
  // cross-domain tasks (e.g. browser extraction + file save) see the full toolset.
  const _needsBrowser = (_tc?.requiresDOM === true) || (_hasExplicitUrl && !_browserIsOpen);

  const _isNativeDesktopTask = _tc?.taskType !== 'browser'
    && !(_tc?.taskType === 'query' && !_tc?.targetService && !_tc?.isAppUiInspection); // exclude pure abstract knowledge Q (but not named-app UI inspection)

  const _isBrowserNavTask = _tc?.taskType === 'browser'
    && !_tc?.requiresDOM; // simple nav (Cmd+L, Cmd+T, scroll) — app.agent handles this

  // In-page click/select/open of a visible text element in the current browser window
  // is handled by app.agent search_and_click, not browser.agent.
  const _isBrowserInPageClick = _tc?.taskType === 'browser'
    && _browserIsOpen
    && /\b(click|open|select|tap|activate)\b/i.test(userMessage || '');

  const _needsApp = _isNativeDesktopTask || _isBrowserNavTask || _isBrowserInPageClick || _tc?.taskType === 'app_automation';

  const _needsShell = _tc?.taskType === 'local_file'
    || (_tc?.taskType !== 'app_automation' && ['file', 'copy', 'save', 'write', 'export', 'convert', 'move', 'delete', 'find'].some(k =>
      _tc?.taskType?.includes(k) || _tc?.intent?.includes(k) || userMessage.toLowerCase().includes(k)
    ));

  const _needsCli = _tc?.taskType === 'cli'
    || _tc?.targetService?.startsWith('cli:')
    || ['gh', 'aws', 'yt-dlp', 'ffmpeg', 'pandoc', 'imagemagick'].some(t =>
      userMessage.toLowerCase().includes(t)
    )
    || _registryKeywordMatch(userMessage)
    || _preflightImpliesCli(state);

  const _isMacOS = process.platform === 'darwin';

  // ── Prompt tier selection ────────────────────────────────────────────────
  // Tier 1 (simple): core prompt only — pure query/knowledge tasks with no
  //   follow-up, recurrence, named service, recovery, or creator context.
  // Tier 2 (standard, default): core prompt + relevant domain appendices.
  // Tier 3 (complex/recovery): full original plan-skills.md + appendices —
  //   byte-identical to pre-tier behavior. Used for recovery, creator, and
  //   plan-correction flows where the full reference catalog is valuable.
  // Windows always uses Tier 3 (no windows core variant). Any ambiguity or
  // core-file load failure falls back to the full original prompt (Tier 3).
  const _isRecoveryOrComplex = !!(
    state.recoveryContext ||
    state.creatorPlanMd ||
    state.creatorAgentsMd ||
    state._planCorrectionMode
  );
  const _isSimpleQuery = !!(
    _tc?.taskType === 'query' &&
    !_tc?.isFollowUp &&
    !_tc?.isRecurring &&
    !_tc?.targetService &&
    !_tc?.requiresDOM &&
    !_tc?.isAppUiInspection &&
    !_tc?.isSpatialAnalysis
  );

  let _promptTier;
  let baseFile;
  let _skipAppendices = false;
  if (isWindows || _isRecoveryOrComplex) {
    _promptTier = 3;
    baseFile = isWindows ? 'plan-skills-windows.md' : 'plan-skills.md';
  } else if (_isSimpleQuery && !_hasLocalSignals) {
    _promptTier = 1;
    baseFile = 'plan-skills-core.md';
    _skipAppendices = true; // simple single-intent query — no domain appendices needed
  } else {
    _promptTier = 2;
    baseFile = 'plan-skills-core.md';
  }

  // Load base; if the core file is missing, fall back to the full original prompt.
  let base = _loadPromptFile(baseFile);
  if (!base && baseFile === 'plan-skills-core.md') {
    _promptTier = 3;
    baseFile = isWindows ? 'plan-skills-windows.md' : 'plan-skills.md';
    base = _loadPromptFile(baseFile);
  }
  base = base || _loadPromptFile('plan-skills.md');
  if (!base) return null;
  state._promptTier = _promptTier;

  let result = `## PRIMACY RULE\nThe CURRENT USER REQUEST below is the source of truth. Prior conversation and screen context are provided ONLY for pronoun resolution ("it", "that", "this"). If the current request names a specific task, service, or topic, plan for THAT task — do not continue prior tasks.\n\n` + base;
  const appendices = [];

  // Domain appendices are appended in skill-preference order: shell/CLI → app → browser.
  // Skip them when local signals or recovery context are present to avoid confusing the
  // planner with extra context during complex flows; the base prompt still applies.
  if (!_skipAppendices && !_hasLocalSignals && !state.recoveryContext && !isWindows) {
    if (_needsShell) appendices.push('plan-skills-shell.md');
    if (_needsCli) appendices.push('plan-skills-cli-first.md');
    if (_isMacOS) appendices.push('plan-skills-macos.md');
    if (_needsApp) appendices.push('plan-skills-app.md');
    if (_needsBrowser) appendices.push('plan-skills-browser.md');
  }

  for (const filename of appendices) {
    const appendix = _loadPromptFile(filename);
    if (appendix) {
      result += `\n\n---\n\n${appendix}`;
    }
  }

  // Inject discovered app shortcuts for native desktop tasks so the planner
  // does not guess the wrong keys (e.g., Cmd+Shift+A for AI instead of Cmd+L).
  if (_needsApp || _tc?.taskType === 'app_automation') {
    const _appName = _extractAppNameFromMessage(userMessage, _screenCtx);
    if (_appName) {
      const _descriptor = _readAppDescriptorForPlanner(_appName);
      if (_descriptor && _descriptor.shortcuts.length > 0) {
        const _shortcutLines = _descriptor.shortcuts
          .map(s => `- ${s.action}: ${s.shortcut}${s.context ? ` (${s.context})` : ''}`)
          .join('\n');
        result += `\n\n## DISCOVERED SHORTCUTS FOR ${_appName}\n\nThe user is interacting with ${_appName}. Use these semantic action names, not hardcoded keys. The app.agent will resolve each action to the correct shortcut:\n\n${_shortcutLines}\n\nFor "open a file and use the app's AI assistant" tasks, use the \`app.agent\` \`run_agent\` action with \`appName: "${_appName}"\`, \`filePath: "<absolute path from user message>"\`, and \`prompt: "<AI instruction only, no boilerplate>"\`.`;
      }
    }
  }

  // CRITICAL: app-automation tasks must never be answered by synthesizing or shell-editing;
  // the named app owns the content and the save action.
  if (_tc?.taskType === 'app_automation') {
    result += `\n\n## CRITICAL: APP-AI AUTOMATION\n\nThis task asks to use a named app's built-in AI assistant. You MUST produce exactly ONE \`app.agent\` step with \`action: "run_agent"\`. Pass the file path from the user message as \`filePath\` and the AI instruction as \`prompt\`. Do NOT use \`synthesize\`, \`shell.run\`, or any other skill to perform the edit. The target app owns the file and its save shortcut.\n`;
  }

  const _skipReason = _skipAppendices ? ' (appendices skipped: tier1_simple)' : _hasLocalSignals ? ' (appendices skipped: local_signals)' : state.recoveryContext ? ' (appendices skipped: recovery)' : '';
  console.info(`[Node:PlanSkillsV2] system prompt: ${baseFile} tier:${_promptTier}${_skipReason} appendices:[${appendices.join(',')}] taskType:${_tc?.taskType || 'unknown'}`);

  if (state.grilledConstraints) {
    result += `\n\n## GRILLED CONSTRAINTS (User Confirmed)\n\nThese constraints were confirmed through detailed questioning. You MUST follow them:\n\n\`\`\`json\n${JSON.stringify(state.grilledConstraints, null, 2)}\n\`\`\``;
  }

  const _grillAnswers = state.gatheredContext?.resolvedAnswers;
  if (_grillAnswers && Object.keys(_grillAnswers).length > 0) {
    const _lines = Object.entries(_grillAnswers).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    result += `\n\n## PRE-FLIGHT RESOLVED FACTS (user confirmed — use these exact values)\n\n${_lines}`;
  }

  // ── Grill-Me: inject batched Q&A answers + route decision ────────────────
  // The grill loop stores answers as [{ question, answer }] in planGatheringAnswers
  // and route decisions in routeDecision. Inject both so the planner generates
  // step-by-step browser agent tasks using the confirmed values.
  const _planGatheringAnswers = state.planGatheringAnswers;
  if (Array.isArray(_planGatheringAnswers) && _planGatheringAnswers.length > 0) {
    const _qaLines = _planGatheringAnswers.map(qa => `- ${qa.question}: ${qa.answer}`).join('\n');
    result += `\n\n## USER-CONFIRMED DETAILS (from pre-planning Q&A — use these exact values)\n\n${_qaLines}`;
  }
  const _routeDecision = state.routeDecision;
  if (_routeDecision && Object.keys(_routeDecision).length > 0) {
    const _rdLines = Object.entries(_routeDecision)
      .filter(([_, rd]) => rd.route && rd.route !== 'rejected_by_user')
      .map(([svc, rd]) => `- ${svc}: route=${rd.route} (${rd.reason})`);
    if (_rdLines.length > 0) {
      result += `\n\n## ROUTE DECISIONS (from preflight probes — mandatory)\n\n${_rdLines.join('\n')}`;
    }
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

  // Inject live screen context so the planner knows which app is actually active.
  // _screenContextNote is built by resolveReferencesV2 from getRecentOcr and contains
  // the real focused app name, category, window title, and URL (if any).
  // Skip when the active window is ThinkDrop itself — the window title may contain
  // plan file names that leak stale context into the planning prompt.
  const _screenNote = state._screenContextNote;
  const _screenIsStale = state._priorScreenContext && (
    state._priorScreenContext.appName === 'Electron' ||
    state._priorScreenContext.appName === 'ThinkDrop' ||
    (state._priorScreenContext.windowTitle || '').toLowerCase().includes('thinkdrop —')
  );
  if (_screenNote && !_screenIsStale && typeof _screenNote === 'string' && _screenNote.length > 0) {
    result += `\n\n## ACTIVE SCREEN CONTEXT (live — use this app as the target for screen-related tasks)\n\n${_screenNote}`;
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

Available skills: shell.run, browser.act, api_suggest, needs_install

shell.run|args:{cmd,argv[],cwd?,timeoutMs?,dryRun?,stdin?}
browser.act|args:{action,url?,selector?,text?,sessionId?,timeoutMs?}

Priority: shell.run > browser.act > keyboard shortcuts.
api_suggest: use as FIRST step when task is RECURRING or programmatic AND the service has an API.
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
  
  // Debug logging for single-step replan
  if (state.singleStepReplan || recoveryContext?.replanMode === 'single_step') {
    logger.info(`[Node:PlanSkillsV2] DEBUG: singleStepReplan=${state.singleStepReplan}, recoveryMode=${recoveryContext?.replanMode}`);
    logger.info(`[Node:PlanSkillsV2] DEBUG: skillPlan exists=${!!state.skillPlan}, skillPlan length=${state.skillPlan?.length || 0}, skillCursor=${state.skillCursor}`);
    logger.info(`[Node:PlanSkillsV2] DEBUG: recoveryAction=${state.recoveryAction}, recoveryContext exists=${!!recoveryContext}`);
  }

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

  // ── planExecutor single-pass: skillPlan[] already built for all steps ────────
  // planExecutor sets _skillPlanFile=_planFile and builds the complete skillPlan[].
  // Skip all LLM planning — pass straight to executeCommand.
  // GUARD: must NOT fire during singleStepReplan recovery (recoveryContext set or singleStepReplan=true),
  // otherwise recovery resets skillCursor to 0 and re-runs already-completed steps.
  const _isRecoveryPath = !!recoveryContext || !!state.singleStepReplan;
  if (!_isRecoveryPath &&
      state._skillPlanFile && state._planFile && state._skillPlanFile === state._planFile &&
      Array.isArray(state.skillPlan) && state.skillPlan.length > 0) {
    logger.info(`[Node:PlanSkillsV2] planExecutor passthrough — ${state.skillPlan.length} steps pre-built, skipping planning`);
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: state.skillPlan.map((s, i) => ({ index: i, ...s })), intent: 'command_automate' });
    return { ...state, skillCursor: 0, planError: null, awaitingPlanApproval: false, recoveryContext: null };
  }

  // ── planMode fast-path: planExecutor dispatched this step (legacy) ─────────
  // _planMode=true means planExecutor set message+intent for a single plan step.
  if (state._planMode && state._planFile) {
    const _stepMsg = state.resolvedMessage || state.message || '';
    const _stepPlan = (Array.isArray(state.skillPlan) && state.skillPlan.length > 0)
      ? state.skillPlan
      : [{ skill: 'shell.run', description: _stepMsg, args: { goal: _stepMsg } }];
    logger.info(`[Node:PlanSkillsV2] _planMode fast-path — skipping planning for: "${_stepMsg.slice(0, 60)}" (skill: ${_stepPlan[0]?.skill})`);
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: _stepPlan.map((s, i) => ({ index: i, ...s })), intent: state.intent?.type || 'command_automate' });
    return { ...state, skillPlan: _stepPlan, skillCursor: 0, planError: null, awaitingPlanApproval: false, recoveryContext: null };
  }

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
        logger.info(`[Node:PlanSkillsV2] Pre-approved skill plan: ${decoded.length} steps`);
        if (progressCallback) progressCallback({ type: 'plan_ready', steps: decoded.map((s, i) => ({ index: i, skill: s.skill, description: s.description || buildStepDescription(s), args: s.args, runGroup: s.runGroup || undefined })), intent: state.intent?.type || 'command_automate', isResume: state._skillPlanIsResume === true });
        return { ...state, skillPlan: decoded, skillCursor: 0, planError: null, recoveryContext: null, _skillPlanIsResume: false };
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
      
      // ── Agent-first: ensure parent agent exists ──────────────────────────────
      const _domainFromSkill = _csName.split('.')[0];
      const _agentName = `${_domainFromSkill}.agent`;
      const _agentPath = path.join(os.homedir(), '.thinkdrop', 'agents', `${_agentName}.md`);
      const _needsBrowserAgent = _csName.includes('.') && !fs.existsSync(_agentPath);
      
      const plan = [];
      if (_needsBrowserAgent) {
        logger.info(`[Node:PlanSkillsV2] Creator shortcut: ${_agentName} not found, prepending build_agent step`);
        plan.push({
          skill: 'browser.agent',
          args: { action: 'build_agent', service: _domainFromSkill },
          description: `Build ${_agentName} for ${_domainFromSkill} domain`,
        });
      }
      
      plan.push({ skill: 'external.skill', description: `Run ${_csName}`, args: { name: _csName } });
      
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
  const _now = new Date();
  const _currentDate = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const _agentIdentity = `AGENT IDENTITY: You are ThinkDrop, a desktop automation agent running on ${_osName} (${os.release()}). You have FULL system access: shell commands, filesystem read/write, app control, and native ${_osName} APIs. You are NOT a web chatbot. Your job is to output a JSON skill plan.\n\nCURRENT DATE: ${_currentDate} — always use the current year (${_now.getFullYear()}) when generating dates for calendar events, deadlines, or any time-sensitive commands. Never use past years.`;

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
    const _isMetaSkillFailure = ['api_suggest', 'needs_skill'].includes(recoveryContext.failedSkill);
    if (_isMetaSkillFailure) {
      // api_suggest/needs_skill are UI card primitives — "no page content" is expected, not a real failure.
      // The previous plan correctly avoided [NEEDS AUTH] agents. Do NOT fall back to a browser agent that
      // requires authentication. Use a REST API alternative (build_agent) or surface the offer again.
      recoveryNote = `\n\nRECOVERY CONTEXT:\n- Previous plan used ${recoveryContext.failedSkill} (a UI information card — NOT a task executor). The card surfaced correctly; the plan is not truly failed.\n- Failure reason reported: ${recoveryContext.failureReason}\n⚠️ CRITICAL AUTH CONSTRAINT: The registered browser agents for this service are marked [NEEDS AUTH] and cannot execute tasks. DO NOT use browser.agent { action: "run" } with any [NEEDS AUTH] agent. You MUST use browser.agent { action: "build_agent", service: "sendgrid" } (or mailgun) to set up a REST API sender, OR surface api_suggest again if the user has not yet chosen a provider.`;
    } else {
      recoveryNote = `\n\nRECOVERY CONTEXT (previous attempt failed — DO NOT repeat the same plan):\n- Failed step: ${recoveryContext.failedSkill} (step ${recoveryContext.failedStep})\n- Failure reason: ${recoveryContext.failureReason}\n- Actual URL reached: ${recoveryContext.actualUrl || 'unknown'}\n- Suggestion: ${recoveryContext.suggestion}\n- Constraint: ${recoveryContext.constraint || 'none'}\nYou MUST produce a DIFFERENT plan. RECOVERY TOOL CONSTRAINT: Any step that previously used browser.agent { action: "run" } MUST continue to use browser.agent { action: "run" } in the recovery plan.`;
    }
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
    const recentTurns = conversationHistory.slice(-5);
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

    // Apply node-specific filters (poison/recovery) before formatting with timestamps
    const filteredTurns = historyTurnsForPlanning
      .filter(m => (m.role !== 'system' && m.sender !== 'system') && m.content?.trim())
      .filter(m => {
        if (m.role !== 'assistant') return true;
        const c = (m.content || '').trim();
        if (c.includes('Step outputs:')) return true;
        return !_POISON.test(c) && !_RECOVERY_CONTENT.test(c);
      });

    const _isFollowUp = !!(state._taskClassification?.isFollowUp);
    const turnLinesStr = formatHistoryTurns(filteredTurns, { isFollowUp: _isFollowUp, maxTurns: 5 });
    const turnLines = turnLinesStr ? turnLinesStr.split('\n').filter(Boolean) : [];
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

  // ── Follow-up plan correction fast-path (3 guards) ────────────────────────
  // When a follow-up message is detected as a correction to a recent pending plan,
  // activate _planCorrectionMode so the existing correction logic at line ~779
  // rewrites the plan in place instead of generating a fresh one.
  if (!recoveryContext && !state._planCorrectionMode && state._taskClassification?.isFollowUp) {
    try {
      const sessionId = state.context?.sessionId || null;
      const prevPlan = findMostRecentPlanInSession(sessionId, logger);
      if (prevPlan) {
        const _followUpTarget = state._taskClassification.followUpTarget || null;
        const _targetService = state._taskClassification.targetService || null;
        // Guard 2: domain + action-type match
        if (domainsMatch(_followUpTarget, _targetService, prevPlan)) {
          // Guard 3: correction signal vs chained action
          if (isCorrectionSignal(userMessage)) {
            logger.info(`[Node:PlanSkillsV2] Follow-up correction detected — activating plan correction mode for: ${prevPlan.planFile}`);
            const _skillPlanJson = Buffer.from(JSON.stringify(prevPlan.skillPlan)).toString('base64');
            state = {
              ...state,
              _planCorrectionMode: true,
              _planCorrectionText: userMessage,
              _planCorrectionSourcePrompt: prevPlan.originalPrompt,
              _basePlanFile: prevPlan.planFile,
              _skillPlanJson,
            };
          } else {
            logger.info(`[Node:PlanSkillsV2] Follow-up domain match but chained-action signal — treating as new request`);
          }
        } else {
          logger.info(`[Node:PlanSkillsV2] Follow-up domain mismatch — treating as new request`);
        }
      }
    } catch (_e) { logger.debug(`[Node:PlanSkillsV2] Follow-up correction check error: ${_e.message}`); }
  }

  // ── Semantic cache check ──────────────────────────────────────────────────
  // Use _taskClassification.isRecurring (LLM-based, from resolveReferencesV2) instead of
  // regex on userMessage — regex matched adjectives like "daily" in "my daily notes".
  const isRecurring = !!state._taskClassification?.isRecurring;
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

  // ── Read preflight results from preflightAgents node ──────────────────────
  // preflightAgents node runs between gatherPlanContext → planSkills and populates
  // state.preflightResult with skill contracts, CLI checks, agent registry, trained recipes.
  // Fallback: if preflightResult is missing (e.g. recovery path skipped preflight), do inline fetch.
  let skillContractNote = '';
  let _shellContractMd = null;
  let _preflightCliMap = {};
  let cliPreflightNote = '';
  let agentContextNote = '';
  let discoveredToolNote = '';
  let orphanedSkillsNote = '';
  let _registeredAgentServiceMap = {};
  const shellSkillNames = new Set();
  let installedSkillsList = [];
  let _trainedRecipeMap = {};

  if (state.preflightResult) {
    // ── Fast path: use preflightAgents results ──────────────────────────────
    const pf = state.preflightResult;
    skillContractNote = pf.skillContractNote || '';
    _shellContractMd = pf.shellContractMd || null;
    cliPreflightNote = pf.cliPreflightNote || '';
    agentContextNote = pf.agentContextNote || '';
    discoveredToolNote = pf.discoveredToolNote || '';
    orphanedSkillsNote = pf.orphanedSkillsNote || '';
    _preflightCliMap = pf.preflightCliMap || {};
    _registeredAgentServiceMap = pf.registeredAgentServiceMap || {};
    _trainedRecipeMap = pf.trainedRecipeMap || {};
    installedSkillsList = pf.installedSkillsList || [];
    for (const name of (pf.shellSkillNames || [])) shellSkillNames.add(name);
    const mapSize = Object.keys(_trainedRecipeMap).length;
    logger.info(`[Node:PlanSkillsV2] Preflight result found: ${mapSize} recipe variants, ${Object.keys(_registeredAgentServiceMap).length} registered agents`);
    if (mapSize > 0) {
      state._trainedRecipeMap = _trainedRecipeMap;
    }
  } else if (mcpAdapter) {
    // ── Fallback: inline preflight fetches (recovery path or skipped preflight) ──
    logger.info('[Node:PlanSkillsV2] No preflightResult — running inline preflight fetches');
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
            const _isPythonSkill = _fmMatch && /exec_type:\s*python\b/i.test(_fmMatch[1]);
            const _isShellContract = !_isNodeSkill && !_isPythonSkill;
            if (_isNodeSkill || _isPythonSkill) {
              const _runtimeType = _isPythonSkill ? 'Python' : 'Node.js';
              skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. This is a ${_runtimeType} runtime skill (exec_type: ${_isPythonSkill ? 'python' : 'node'}). Generate a SINGLE step: { "skill": "external.skill", "args": { "name": "${state.matchedSkillName}" } }\n2. FORBIDDEN: Do NOT generate shell.run or curl steps.\n3. FORBIDDEN: Do NOT expand the implementation — just call external.skill.\n\n${contractMd.slice(0, 2000)}`;
            } else if (_isShellContract) {
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
          const agRes = await mcpAdapter.callService('command', 'agent.list', {}, { timeoutMs: 3000 }).catch(() => null);
          const agents = agRes?.data || agRes || [];
          if (Array.isArray(agents) && agents.length > 0) {
            const agentLines = [];
            const trainedRecipeLines = [];

            for (const a of agents) {
              const canonicalAgentId = (typeof a.id === 'string' && a.id)
                ? (a.id.endsWith('.agent') ? a.id : `${a.id}.agent`)
                : a.id;
              const baseLine = `- ${canonicalAgentId}: ${a.type} agent${a.start_url ? ` (starts at ${a.start_url})` : ''}${Array.isArray(a.capabilities) ? ` — capabilities: ${a.capabilities.slice(0, 5).join(', ')}` : ''}`;
              agentLines.push(baseLine);
              const svc = (canonicalAgentId || '').replace('.agent', '').toLowerCase();
              if (svc) _registeredAgentServiceMap[svc] = canonicalAgentId;

              if (a.type === 'browser' || a.type === 'cli') {
                try {
                  const tsRes = await mcpAdapter.callService('command', 'command.automate', {
                    skill: 'trainer.agent',
                    args: { action: 'list_skills', agentId: svc }
                  }, { timeoutMs: 3000 }).catch(() => null);
                  const skills = tsRes?.data?.skills || tsRes?.skills || [];
                  if (skills.length > 0) {
                    const skillNames = skills.map(s => s.name).join(', ');
                    const agentTypeSkill = a.type === 'cli' ? 'cli.agent' : 'browser.agent';
                    trainedRecipeLines.push(`- ${canonicalAgentId}: [${skillNames}] → use ${agentTypeSkill} { action: "run", agentId: "${canonicalAgentId}" }`);

                    for (const s of skills) {
                      const baseName = s.name.toLowerCase();
                      const variants = [
                        baseName,
                        baseName.replace(/_/g, '.'),
                        baseName.replace(/\./g, ' '),
                        baseName.replace(/_/g, ' '),
                        baseName.replace(/\./g, '_'),
                        baseName.replace(/^[^.]+\./, ''),
                      ];
                      for (const v of variants) {
                        if (!_trainedRecipeMap[v]) {
                          _trainedRecipeMap[v] = { agentId: canonicalAgentId, skillName: s.name, agentType: a.type === 'cli' ? 'cli.agent' : 'browser.agent' };
                        }
                      }
                    }
                  }
                } catch (err) {
                  logger.warn(`[Node:PlanSkillsV2] trainer.agent call failed for ${svc}: ${err.message}`);
                }
              }
            }

            agentContextNote = `\n\nREGISTERED AGENTS (use browser.agent { action: "run", agentId: "<id>", task: "..." } for these — do NOT use raw browser.act navigate):\n${agentLines.join('\n')}`;

            if (trainedRecipeLines.length > 0) {
              agentContextNote += `\n\nTRAINED RECIPES (when user mentions these, use browser.agent/cli.agent — NOT external.skill):\n${trainedRecipeLines.join('\n')}`;
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

    // ── Disk-scan fallback ────────────────────────────────────────────────────
    try {
      const skillsRoot = path.join(os.homedir(), '.thinkdrop', 'skills');
      if (fs.existsSync(skillsRoot)) {
        let diskCount = 0;
        const agentDirs = fs.readdirSync(skillsRoot).filter(d => {
          try { return fs.statSync(path.join(skillsRoot, d)).isDirectory(); } catch (_) { return false; }
        });
        for (const agentDir of agentDirs) {
          const recipeDir = path.join(skillsRoot, agentDir);
          let recipeFiles;
          try { recipeFiles = fs.readdirSync(recipeDir).filter(f => f.endsWith('.recipe.json')); }
          catch (_) { continue; }
          for (const recipeFile of recipeFiles) {
            try {
              const recipe = JSON.parse(fs.readFileSync(path.join(recipeDir, recipeFile), 'utf8'));
              if (!recipe.name) continue;
              const inferredRawAgentId = recipe.agentId || `${agentDir}.agent`;
              const inferredAgentId = inferredRawAgentId.endsWith('.agent') ? inferredRawAgentId : `${inferredRawAgentId}.agent`;
              const agentType = 'browser.agent';
              const baseName = recipe.name.toLowerCase();
              const variants = [
                baseName,
                baseName.replace(/_/g, '.'),
                baseName.replace(/\./g, ' '),
                baseName.replace(/_/g, ' '),
                baseName.replace(/\./g, '_'),
                baseName.replace(/^[^.]+\./, ''),
              ];
              for (const v of variants) {
                if (!_trainedRecipeMap[v]) {
                  _trainedRecipeMap[v] = { agentId: inferredAgentId, skillName: recipe.name, agentType };
                  diskCount++;
                }
              }
            } catch (_) { /* skip unreadable recipe */ }
          }
        }
        if (diskCount > 0) {
          logger.info(`[Node:PlanSkillsV2] Disk-scan added ${diskCount} recipe variant(s) (DB had ${Object.keys(_trainedRecipeMap).length - diskCount})`);
        }
      }
    } catch (diskErr) {
      logger.warn(`[Node:PlanSkillsV2] Disk-scan fallback error: ${diskErr.message}`);
    }

    const mapSize = Object.keys(_trainedRecipeMap).length;
    logger.info(`[Node:PlanSkillsV2] Trained recipe map built: ${mapSize} variants`);
    if (mapSize > 0) {
      state._trainedRecipeMap = _trainedRecipeMap;
      logger.info(`[Node:PlanSkillsV2] Trained recipes loaded: ${Object.keys(_trainedRecipeMap).slice(0, 5).join(', ')}...`);
    } else {
      logger.warn(`[Node:PlanSkillsV2] No trained recipes loaded — trainer.agent calls may have failed or returned empty (check for database lock conflicts)`);
    }
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
    
    // ── Agent-first: ensure parent agent exists before running skill ─────────
    const _domainFromSkill = state.matchedSkillName.split('.')[0];
    const _agentName = `${_domainFromSkill}.agent`;
    const _agentPath = path.join(os.homedir(), '.thinkdrop', 'agents', `${_agentName}.md`);
    const _needsBrowserAgent = state.matchedSkillName.includes('.') && !fs.existsSync(_agentPath);
    
    const domainPlan = [];
    if (_needsBrowserAgent) {
      logger.info(`[Node:PlanSkillsV2] Agent-first: ${_agentName} not found, prepending build_agent step`);
      domainPlan.push({
        skill: 'browser.agent',
        args: { action: 'build_agent', service: _domainFromSkill },
        description: `Build ${_agentName} for ${_domainFromSkill} domain`,
      });
    }
    
    domainPlan.push({
      skill: 'external.skill',
      description: `Run domain skill: ${state.matchedSkillName}`,
      args: { name: state.matchedSkillName, ...(state.matchedSkillParams || {}) },
    });
    
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

  // ── Trained recipe fuzzy match fast-path ──────────────────────────────────
  // If user message directly matches a trained recipe name, short-circuit to agent
  const _recipeMap = state._trainedRecipeMap || {};
  const recipeMapSize = Object.keys(_recipeMap).length;
  logger.info(`[Node:PlanSkillsV2] Fast-path check: ${recipeMapSize} recipes, recovery=${!!recoveryContext}, msg="${userMessage.slice(0, 60)}"`);
  
  if (!recoveryContext && recipeMapSize > 0 && !state._taskClassification?.isScreenFollowUp) {
    const messageLower = userMessage.toLowerCase();
    let matchedRecipe = null;
    let matchedVariant = null;
    
    // Strategy 1: Exact phrase match (longer matches prioritized)
    const sortedVariants = Object.keys(_recipeMap).sort((a, b) => b.length - a.length);
    for (const variant of sortedVariants) {
      if (messageLower.includes(variant)) {
        matchedRecipe = _recipeMap[variant];
        matchedVariant = variant;
        break;
      }
    }
    
    // Strategy 2: Scoring-based fuzzy matching with multi-signal confidence
    if (!matchedRecipe) {
      const stopWords = new Set(['use', 'the', 'with', 'for', 'to', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'from', 'by', 'my', 'me', 'i', 'you', 'it', 'this', 'that', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'however', 'whatever', 'whenever', 'wherever', 'whether', 'although', 'though', 'because', 'since', 'unless', 'until', 'while', 'before', 'after', 'once', 'when', 'where', 'why', 'what', 'who', 'which', 'whom', 'whose', 'how', 'via', 'using', 'through', 'about', 'into', 'onto', 'upon', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'now']);
      
      // Clean message: remove stopwords, short words, extract meaningful tokens
      const msgTokens = messageLower
        .replace(/[^a-z0-9._\s]/g, ' ')  // remove punctuation except ._ 
        .split(/\s+/)
        .filter(w => w.length >= 4 && !stopWords.has(w));
      
      let bestMatch = null;
      let bestScore = 0;
      const SCORE_THRESHOLD = 0.3; // minimum match quality
      
      for (const [variant, info] of Object.entries(_recipeMap)) {
        const skillName = info.skillName.toLowerCase();
        const skillTokens = skillName.split(/[._]/).filter(w => w.length >= 3);
        
        let score = 0;
        const matchedTokens = [];
        
        // 1. Exact token matches (highest weight: 1.0)
        for (const token of msgTokens) {
          if (skillTokens.includes(token)) {
            score += 1.0;
            matchedTokens.push(token);
          }
        }
        
        // 2. Substring matches (weight: 0.7 for msg ⊂ skill, 0.5 for skill ⊂ msg)
        for (const msgToken of msgTokens) {
          for (const skillToken of skillTokens) {
            if (msgToken === skillToken) continue; // already counted above
            // msgToken is substring of skillToken (e.g., "editor" in "theeditor")
            if (skillToken.includes(msgToken) && msgToken.length >= 5) {
              score += 0.7 * (msgToken.length / skillToken.length);
              matchedTokens.push(`${msgToken}⊂${skillToken}`);
            }
            // skillToken is substring of msgToken (e.g., "schools" in "w3schoolsplatform")
            else if (msgToken.includes(skillToken) && skillToken.length >= 4) {
              score += 0.5 * (skillToken.length / msgToken.length);
              matchedTokens.push(`${skillToken}⊂${msgToken}`);
            }
          }
        }
        
        // 3. Prefix/suffix matches (weight: 0.4) - for compound words
        for (const msgToken of msgTokens) {
          for (const skillToken of skillTokens) {
            if (msgToken === skillToken) continue;
            // Common prefix (e.g., "gmail" matches "gmailcompose" or "compose" matches "gmailcompose")
            let commonPrefix = 0;
            for (let i = 0; i < Math.min(msgToken.length, skillToken.length); i++) {
              if (msgToken[i] === skillToken[i]) commonPrefix++;
              else break;
            }
            if (commonPrefix >= 4) {
              score += 0.4 * (commonPrefix / Math.max(msgToken.length, skillToken.length));
              matchedTokens.push(`prefix:${commonPrefix}`);
            }
          }
        }
        
        // Normalize by token count to avoid bias toward longer skill names
        const normalizedScore = score / Math.max(skillTokens.length, msgTokens.length * 0.5);
        
        // Boost if domain word appears in message (strong signal)
        const domainBoost = skillTokens.some(st => 
          msgTokens.some(mt => mt === st || mt.includes(st) || st.includes(mt))
        ) ? 0.2 : 0;
        
        const finalScore = normalizedScore + domainBoost;
        
        if (finalScore > bestScore && finalScore >= SCORE_THRESHOLD) {
          bestScore = finalScore;
          bestMatch = { info, matchedTokens: [...new Set(matchedTokens)], score: finalScore };
        }
      }
      
      if (bestMatch) {
        matchedRecipe = bestMatch.info;
        matchedVariant = `${bestMatch.matchedTokens.join(',')}=${bestMatch.score.toFixed(2)}`;
      }
    }
    
    if (matchedRecipe) {
      logger.info(`[Node:PlanSkillsV2] Trained recipe fast-path: "${matchedVariant}" → ${matchedRecipe.agentId} (${matchedRecipe.skillName})`);
      const normalizedMatchedAgentId =
        (typeof matchedRecipe.agentId === 'string' && matchedRecipe.agentId)
          ? (matchedRecipe.agentId.endsWith('.agent') ? matchedRecipe.agentId : `${matchedRecipe.agentId}.agent`)
          : matchedRecipe.agentId;
      const fastPlan = [{
        skill: matchedRecipe.agentType,
        args: { action: 'run', agentId: normalizedMatchedAgentId, task: userMessage },
        description: `Execute trained recipe: ${matchedRecipe.skillName}`
      }];
      if (progressCallback) progressCallback({ type: 'plan_ready', steps: fastPlan.map((s, i) => ({ index: i, ...s })), intent: 'command_automate' });
      return { ...state, skillPlan: fastPlan, skillCursor: 0, planError: null, recoveryContext: null, _trainedRecipeMap };
    } else {
      logger.info(`[Node:PlanSkillsV2] No trained recipe match found, falling through to LLM planning`);
    }
  } else if (recipeMapSize === 0) {
    logger.info(`[Node:PlanSkillsV2] No trained recipes available in map`);
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
  // Use _taskClassification.taskType === 'messaging' (LLM-based) instead of regex —
  // regex matched nouns like "text" in "visible text on my screen" causing plan poisoning.
  let messagingBodyNote = '';
  const isMessagingTask = state._taskClassification?.taskType === 'messaging';
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
When 2+ steps are independent (no {{variable}} dependency between them), add the same "runGroup": "<id>" (e.g. "g1") to each so they execute in parallel via Promise.allSettled. Any plan with 3+ steps MUST be analyzed for parallel opportunities (multiple distinct requests, independent searches/lookups, data from different sources).
RULES: only group steps with NO {{variable}} references to each other; grouped steps MUST be consecutive; do NOT group synthesize/schedule/shell.run (sequential). When in doubt, parallelize independent steps.
EXAMPLE: [ { "skill": "web.agent", "args": { "action": "search", "query": "A reviews" }, "runGroup": "g1" }, { "skill": "web.agent", "args": { "action": "search", "query": "B reviews" }, "runGroup": "g1" }, { "skill": "synthesize", "args": { "prompt": "Compare A and B" } } ]`;

  // ── Route choice constraint from preflightAgents ───────────────────────────
  let routeChoiceNote = '';
  const preflightRouteChoice = state.preflightRouteChoice || state.preflightResult?.routeChoice || {};
  if (Object.keys(preflightRouteChoice).length > 0) {
    const choiceLines = [];
    for (const [svc, route] of Object.entries(preflightRouteChoice)) {
      if (route === 'cli_api') {
        choiceLines.push(`- ${svc}: User selected CLI/API route. Use cli.agent or shell.run with API calls. Do NOT use browser.agent for ${svc}.`);
      } else if (route === 'browser') {
        choiceLines.push(`- ${svc}: User selected Browser Agent route. Use browser.agent { action: "run", agentId: "${svc}.agent", task: "..." }. Do NOT use api_suggest or cli.agent for ${svc}.`);
      } else if (route === 'app') {
        choiceLines.push(`- ${svc}: User selected Desktop App route. Use app.agent { action: "run_agent", appName: "${svc}", task: "..." }. Do NOT use browser.agent or api_suggest for ${svc}.`);
      }
    }
    routeChoiceNote = `\n\n⚠️ ROUTE CHOICE — USER SELECTED EXECUTION ROUTE (MANDATORY):\nThe user explicitly chose the following execution routes during preflight. You MUST use the selected route and MUST NOT use alternative routes or api_suggest for these services:\n${choiceLines.join('\n')}\n\nDo NOT generate api_suggest steps for services listed above — the user already chose their preferred route.`;
    logger.info(`[Node:PlanSkillsV2] Route choice constraint injected: ${JSON.stringify(preflightRouteChoice)}`);
  }

  // ── Single-route mandate from preflightAgents ─────────────────────────────
  let singleRouteNote = '';
  const singleRouteMandate = state?.preflightResult?.singleRouteMandate || {};
  if (Object.keys(singleRouteMandate).length > 0) {
    const mandateLines = [];
    for (const [svc, m] of Object.entries(singleRouteMandate)) {
      if (m.route === 'cli_api') {
        mandateLines.push(`- ${svc}: The only available and authenticated route is CLI/API via ${m.agentId}. You MUST use cli.agent { action: 'run', agentId: '${m.agentId}', task: '...' }. FORBIDDEN: api_suggest, browser.agent, browser.act, app.agent, or any other route for ${svc}.`);
      } else if (m.route === 'browser') {
        mandateLines.push(`- ${svc}: The only available and authenticated route is ${m.agentId} (browser). You MUST use browser.agent { action: 'run', agentId: '${m.agentId}', task: '...' }. FORBIDDEN: api_suggest, browser.act, cli.agent, app.agent, or raw API calls for ${svc}.`);
      } else if (m.route === 'app') {
        mandateLines.push(`- ${svc}: The only available and authenticated route is desktop app via ${m.agentId}. You MUST use app.agent { action: 'run_agent', appName: '${svc}', task: '...' }. FORBIDDEN: api_suggest, browser.agent, browser.act, cli.agent, or any other route for ${svc}.`);
      }
    }
    singleRouteNote = `\n\n⚠️ SINGLE-ROUTE MANDATE — MANDATORY ROUTE FOR THESE SERVICES:\n${mandateLines.join('\n')}\n\nThese services have only one authenticated route available. You MUST use that route and MUST NOT generate api_suggest or alternative routes for them.\n`;
    logger.info(`[Node:PlanSkillsV2] Single-route mandate injected: ${JSON.stringify(singleRouteMandate)}`);
  }

  // ── External skill prohibition (when parseSkill found no match) ─────────────
  let externalSkillProhibition = '';
  if (state._noInstalledSkillMatch && !recoveryContext) {
    externalSkillProhibition = `

⚠️ CRITICAL SKILL CONSTRAINT — NO INSTALLED SKILL MATCH:
The user's request does NOT match any installed skill.

**FORBIDDEN:** You MUST NOT use "external.skill" — it will fail because no such skill is installed.

**USE INSTEAD:**
- **browser.agent** — For web-based services (w3schools, perplexity, gmail, etc.)
- **cli.agent** — For command-line tools (git, npm, docker, etc.)
- **shell.run** — For one-off shell commands

**WHY:** external.skill only works for pre-installed Node.js/Python skills with an index.cjs file. It CANNOT auto-install or create skills.`;
    logger.info(`[Node:PlanSkillsV2] Injecting external.skill prohibition (no installed skill match)`);
  }

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
    discoveredToolNote,
    orphanedSkillsNote,
    externalSkillProhibition,
    routeChoiceNote,
    singleRouteNote,
    smsGatewayNote,
    dateRangeNote,
    runtimeNote,
    messagingBodyNote,
    parallelNote,
    `\n\nUser request: "${(runtimeParamMessage || userMessage).replace(/"/g, '\\"').slice(0, 2000)}"`,
  ].filter(Boolean).join('\n');

  // ── Single-step replan mode ───────────────────────────────────────────────
  // When recoverSkill decides only the failed step needs regeneration, we generate
  // a replacement step instead of rebuilding the entire plan.
  logger.debug(`[Node:PlanSkillsV2] Single-step replan check: recoveryContext?.replanMode=${recoveryContext?.replanMode}, state.singleStepReplan=${state.singleStepReplan}, state.skillPlan=${!!state.skillPlan}, skillCursor=${state.skillCursor}`);
  
  // Check if we should do single-step replan
  const shouldSingleStepReplan = (recoveryContext?.replanMode === 'single_step' || state.singleStepReplan);
  
  if (shouldSingleStepReplan) {
    // Try to get the skill plan from various sources
    let skillPlanToUse = state.skillPlan;
    
    // If no skillPlan in state (e.g. evaluateSkills FIX verdict cleared it),
    // reconstruct from the plan file's skill_plan_json frontmatter so we can
    // splice in just the replacement step without a full LLM replan.
    if (!skillPlanToUse && (state._skillPlanFile || state._planFile)) {
      const planFilePath = state._skillPlanFile || state._planFile;
      try {
        const planContent = fs.readFileSync(planFilePath, 'utf8');
        const fmMatch = planContent.match(/^---\n(.*?)\n---/s);
        if (fmMatch) {
          const spMatch = fmMatch[1].match(/skill_plan_json:\s*'([^']+)'/);
          if (spMatch) {
            const decoded = JSON.parse(Buffer.from(spMatch[1], 'base64').toString('utf8'));
            if (Array.isArray(decoded) && decoded.length > 0) {
              skillPlanToUse = decoded;
              logger.info(`[Node:PlanSkillsV2] Single-step replan: recovered skillPlan[${decoded.length}] from plan file frontmatter`);
            }
          }
        }
      } catch (e) {
        logger.warn(`[Node:PlanSkillsV2] Single-step replan: failed to recover skillPlan from plan file — ${e.message}`);
      }
    }
    
    if (skillPlanToUse && Array.isArray(skillPlanToUse)) {
      logger.info(`[Node:PlanSkillsV2] Single-step replan: regenerating step ${state.skillCursor} (${recoveryContext?.failedSkill || 'unknown skill'})`);
      
      const { generateSingleStep } = require('../utils/singleStepPlanner');
      
      const replacementStep = await generateSingleStep({
        failedStep: recoveryContext?.failedStep || skillPlanToUse[state.skillCursor],
        failedSkill: recoveryContext?.failedSkill || skillPlanToUse[state.skillCursor]?.skill,
        failedArgs: recoveryContext?.failedStepArgs || skillPlanToUse[state.skillCursor]?.args,
        suggestion: recoveryContext?.suggestion,
        constraint: recoveryContext?.constraint,
        priorResults: skillResults,
        userMessage: resolvedMessage || message,
        llmBackend: backend,
      });
      
      // Replace only the failed step, keep rest of plan
      const newPlan = [
        ...skillPlanToUse.slice(0, state.skillCursor),
        replacementStep,
        ...skillPlanToUse.slice(state.skillCursor + 1),
      ];
      
      logger.info(`[Node:PlanSkillsV2] Single-step replan complete: replaced step ${state.skillCursor} with new ${replacementStep.skill}`);
      
      // Emit plan_ready with single-step replan flag so UI merges instead of replaces
      if (progressCallback) {
        progressCallback({
          type: 'plan_ready',
          steps: newPlan.map((s, i) => ({
            index: i,
            skill: s.skill,
            description: s.description || buildStepDescription(s),
            args: s.args,
            runGroup: s.runGroup || undefined,
          })),
          intent: intent?.type || 'command_automate',
          singleStepReplan: true,  // Signal this is a single-step replan (preserve prior step statuses)
        });
      }
      
      return {
        ...state,
        skillPlan: newPlan,
        skillCursor: state.skillCursor,  // Stay at same position
        planError: null,
        recoveryContext: null,  // Clear after use
      };
    } else {
      logger.warn(`[Node:PlanSkillsV2] Single-step replan requested but no valid skillPlan found - falling back to full replan`);
    }
  }

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

  // ── Inject direct deep-link URLs from preflight ───────────────────────────
  // If preflight resolved a task-specific URL for a browser agent, pass it as
  // the url arg so the browser starts at the right page.
  if (Array.isArray(skillPlan)) {
    const deepLinkMap = new Map();
    const pfAgents = state?.preflightResult?.agents || [];
    for (const a of pfAgents) {
      if (a?.agentId && a?.deepLinkUrl) {
        deepLinkMap.set(a.agentId.toLowerCase(), { url: a.deepLinkUrl, source: a.deepLinkSource || null });
      }
    }

    for (const step of skillPlan) {
      if (step.skill === 'browser.agent' && step.args?.action === 'run' && step.args?.agentId && !step.args.url) {
        const dl = deepLinkMap.get(step.args.agentId.toLowerCase());
        if (dl?.url) {
          step.args.url = dl.url;
          logger.info(`[Node:PlanSkillsV2] Injected deep-link URL for ${step.args.agentId}: ${dl.url} (source=${dl.source || 'unknown'})`);
        }
      }
    }
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
        const expanded = await backend.generateAnswer(expandQuery, { query: expandQuery, context: { systemInstructions: 'You write precise LLM prompts. Output only the prompt text, nothing else.', conversationHistory: [], intent: 'command_automate' }, options: { maxTokens: 800, temperature: 0.1, fastMode: true } }, { maxTokens: 800, temperature: 0.1, fastMode: true, taskType: 'classification' }, null);
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
    // Use only the args-based check — the regex branch matched "project" as a generic word
    // (e.g. "show me the project files") and caused false positives.
    const explicit = !!(projectLauncherStep.args?.projectName && msgLower.includes(projectLauncherStep.args.projectName.toLowerCase()));
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

  // ── Conditional parallel execution analysis ───────────────────────────────
  // Only analyze plans with 3+ steps for parallel execution opportunities
  if (Array.isArray(skillPlan) && skillPlan.length >= 3 && backend) {
    skillPlan = await analyzeAndAddParallelGroups(skillPlan, userMessage, backend, logger);
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

  // ── Fallback browser cleanup ──────────────────────────────────────────────
  // Close any Playwright browsers left open by preflight auth probes or deep-link
  // resolution. The persistent profile retains cookies; only the browser process is killed.
  if (mcpAdapter) {
    try {
      await mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.act',
        args: { action: 'close-all' },
      }, { timeoutMs: 8000 }).catch(() => {});
      logger.debug('[Node:PlanSkillsV2] Fallback browser cleanup: close-all sent');
    } catch (_) {}
  }

  // ── Date year fixer ────────────────────────────────────────────────────────
  // Deterministic safety net: replace past years in date-like strings within the plan
  // with the current year. Catches cases where the LLM generates "2023-07-15" instead of "2026-07-15".
  {
    const _currentYear = new Date().getFullYear();
    const _pastYearRe = new RegExp(`\\b(20[0-9]{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12][0-9]|3[01])\\b`, 'g');
    for (const step of skillPlan) {
      if (!step.args) continue;
      for (const key of ['task', 'goal', 'cmd', 'command']) {
        if (typeof step.args[key] === 'string') {
          step.args[key] = step.args[key].replace(_pastYearRe, (match, year, mo, day) => {
            const y = parseInt(year, 10);
            if (y < _currentYear && y >= 2020) {
              const fixed = `${_currentYear}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`;
              logger.info(`[Node:PlanSkillsV2] Date fixer: ${match} → ${fixed} in step.args.${key}`);
              return fixed;
            }
            return match;
          });
        }
      }
    }
  }

  // ── Output schema fallback ────────────────────────────────────────────────
  // If the LLM didn't set outputSchema on the synthesize step, try to infer it
  // from the user's prompt as a conservative safety net.
  // The regex is intentionally limited to obvious patterns — if neither the LLM
  // nor the regex sets outputSchema, no enforcement happens (backward compatible).
  if (Array.isArray(skillPlan)) {
    for (let i = skillPlan.length - 1; i >= 0; i--) {
      if (skillPlan[i].skill === 'synthesize') {
        if (!skillPlan[i].args?.outputSchema) {
          const _fallback = _inferOutputSchemaFallback(userMessage);
          if (_fallback) {
            skillPlan[i].args = skillPlan[i].args || {};
            skillPlan[i].args.outputSchema = _fallback;
            logger.info(`[Node:PlanSkillsV2] Output schema fallback: ${_fallback.type} → synthesize step ${i + 1}`);
          }
        } else {
          logger.info(`[Node:PlanSkillsV2] Output schema already set by LLM: ${JSON.stringify(skillPlan[i].args.outputSchema.type)} → synthesize step ${i + 1}`);
        }
        break;
      }
    }
  }

  // ── Save plan to disk ─────────────────────────────────────────────────────
  let _skillPlanFile = state._skillPlanFile || null;
  let _planId = null;
  try {
    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
    _planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const planMd = serializeSkillPlanToMd(skillPlan, userMessage, _planId, state.context?.sessionId || 'unknown');
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
        // Preserve multi-intent context so plan:approve can restore the queue
        // after the graph exits at the approval gate (planApprovalMode: 'always').
        isMultiIntent: state.isMultiIntent || false,
        intentQueue:   state.intentQueue || [],
        intentResults: state.intentResults || [],
        dataContext:   state.dataContext || {},
        // Preserve priorSynthesizedContent so executeCommand can substitute
        // {{BODY}} (and other buildRuntimeParams tokens) in agent-path steps
        // after the plan:approve round-trip.
        priorSynthesizedContent: priorSynthesizedContent || '',
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
      priorSynthesizedContent: priorSynthesizedContent || '',
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
      singleStepReplan: state.singleStepReplan || false,  // Preserve single-step replan context for UI
    });
  }

  return {
    ...state,
    skillPlan,
    skillCursor: 0,
    planError: null,
    recoveryContext: null,
    _skillPlanFile,
    priorSynthesizedContent: priorSynthesizedContent || '',
  };
}

module.exports = planSkillsV2;
module.exports._inferOutputSchemaFallback = _inferOutputSchemaFallback;

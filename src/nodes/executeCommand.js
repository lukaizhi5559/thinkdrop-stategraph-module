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

function _extractMissingPathFromError(errorText) {
  if (typeof errorText !== 'string' || !errorText.trim()) return null;
  const match = errorText.match(/(?:Output not created|file not found)\s*:\s*(~\/[^\s]+|\/[^\s]+)/i);
  if (!match || !match[1]) return null;
  const rawPath = match[1].trim();
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

function _enrichFailureContext(stepResult) {
  if (!stepResult || stepResult.ok) return stepResult;

  const enriched = { ...stepResult };
  if (!enriched.missingPath && typeof enriched.error === 'string') {
    enriched.missingPath = _extractMissingPathFromError(enriched.error);
  }
  if (!enriched.toolName && enriched.skill === 'shell.run') {
    enriched.toolName = enriched.args?.cmd || null;
  }
  if (!enriched.stderrHint && typeof enriched.stderr === 'string') {
    enriched.stderrHint = enriched.stderr.trim().slice(0, 300) || null;
  }
  return enriched;
}

/**
 * Analyze page content to detect if it has substantive content vs just UI/auth wall.
 * Uses positive validation (content density, structure) not just negative filtering.
 * Returns analysis with confidence score and reasoning.
 */
function analyzePageContent(text, url = '', agentId = '') {
  if (!text || text.length < 50) {
    return { hasContent: false, confidence: 0, reason: 'text_too_short', contentDensity: 0 };
  }

  // Extract domain context
  let domain = '';
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch (_) {}

  // Check for ERROR PAGES (clear failures)
  const ERROR_PATTERNS = [
    /404\s+not\s+found/i,
    /403\s+forbidden/i,
    /500\s+internal\s+server\s+error/i,
    /access\s+denied/i,
    /that's an error/i,
    /something\s+went\s+wrong/i,
    /page\s+not\s+found/i,
    /error\s+\d{3}/i,
  ];
  const isErrorPage = ERROR_PATTERNS.some(p => p.test(text.slice(0, 2000)));

  // Check for AUTH WALLS (login required)
  const AUTH_WALL_PATTERNS = [
    /sign\s+in\s+to\s+continue/i,
    /please\s+log\s+in.*to\s+view/i,
    /authentication\s+required/i,
    /login\s+required/i,
    /create\s+an?\s+account\s+to/i,
    /join\s+now\s+to\s+continue/i,
  ];
  const isAuthWall = AUTH_WALL_PATTERNS.some(p => p.test(text.slice(0, 1500)));

  // CONTENT DENSITY ANALYSIS (positive signal)
  const wordCount = text.split(/\s+/).filter(w => w.length > 2).length;
  const paragraphCount = text.split(/\n\s*\n/).filter(p => p.length > 100).length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const avgSentenceLength = sentences.reduce((a, s) => a + s.length, 0) / Math.max(1, sentences.length);
  const punctuationDensity = (text.match(/[.!?;:]/g) || []).length / Math.max(1, wordCount);

  // Density thresholds
  const hasSubstantialText = wordCount >= 100;
  const hasParagraphStructure = paragraphCount >= 2;
  const hasPunctuation = punctuationDensity > 0.05;

  // CONTENT MARKERS (positive signals)
  const CONTENT_MARKERS = [
    { pattern: /#{1,3}\s+\d+[).:]?\s+[A-Z]/, weight: 3, name: 'numbered_heading' },
    { pattern: /^[\s]*[-•*]\s+[A-Z][a-z]{2,}/m, weight: 2, name: 'bullet_content' },
    { pattern: /\*\*[A-Z][a-z]+.*?\*\*/, weight: 2, name: 'bold_section' },
    { pattern: /[A-Z][^.]{80,200}[.][\s]+[A-Z]/, weight: 3, name: 'substantive_paragraph' },
    { pattern: /\n\n[A-Z][^.]{100,}\.\n\n[A-Z]/, weight: 4, name: 'multi_para_section' },
    { pattern: /(Summary|Overview|Introduction|Conclusion|Analysis|Key Points|Findings)/i, weight: 3, name: 'section_keyword' },
    { pattern: /From:\s*\S+@\S+/i, weight: 3, name: 'email_from' },
    { pattern: /Subject:\s*\S+/i, weight: 3, name: 'email_subject' },
  ];

  let contentScore = 0;
  const matchedSignals = [];
  CONTENT_MARKERS.forEach(marker => {
    if (marker.pattern.test(text)) {
      contentScore += marker.weight;
      matchedSignals.push(marker.name);
    }
  });

  // UI CHROME DETECTION
  const UI_CHROME_PATTERNS = [
    /^Skip to content/i,
    /^(Chat history|New chat|Search chats|Images|Apps|Deep research)/im,
    /^(Home|About|Contact|Menu|Navigation)/im,
    /^(Inbox|Sent|Drafts|Trash|Compose)/im,
  ];
  const hasUiChrome = UI_CHROME_PATTERNS.some(p => p.test(text.slice(0, 800)));

  // DECISION LOGIC
  if (isErrorPage) {
    return { hasContent: false, confidence: 0.95, reason: 'error_page_detected', contentDensity: 0 };
  }
  if (isAuthWall && wordCount < 150) {
    return { hasContent: false, confidence: 0.9, reason: 'auth_wall_detected', contentDensity: 0 };
  }

  const hasRealContent = (contentScore >= 5) || (hasSubstantialText && hasParagraphStructure) || (hasSubstantialText && contentScore >= 3);
  const confidence = Math.min(0.95, 0.5 + (contentScore * 0.05) + (hasParagraphStructure ? 0.15 : 0));

  return {
    hasContent: hasRealContent,
    confidence,
    reason: hasRealContent ? 'content_markers_present' : 'insufficient_content',
    contentScore,
    contentDensity: wordCount / 1000,
    wordCount,
    paragraphCount,
    avgSentenceLength: Math.round(avgSentenceLength),
    punctuationDensity: Math.round(punctuationDensity * 100) / 100,
    uiChromeDetected: hasUiChrome,
    authWallDetected: isAuthWall,
    errorPageDetected: isErrorPage,
    matchedSignals: matchedSignals.slice(0, 5),
    domain,
    agentId,
  };
}

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

/**
 * Inline skill.md repair agent.
 * Validates a skill contract string and repairs it using the LLM if issues are found.
 * Runs synchronously in the synthesize write path — prevents skill.install rejection
 * without needing a full recoverSkill → evaluateSkills → replan loop.
 *
 * Checks performed (in order, fast static checks first):
 *   1. Outer markdown fence wrapping  — strip ``` yaml/markdown/``` wrapper
 *   2. YAML frontmatter present        — must start with '---'
 *   3. Required fields present         — name, description, secrets, schedule
 *   4. Frontmatter closed properly     — second '---' exists
 *   5. ## Plan section present         — skill executor needs it
 *
 * Phase 1: Deterministic static fixes (no LLM).
 * Phase 2: LLM-driven quality review with context (crawled docs, user message, known patterns).
 *
 * Returns the (possibly repaired) skill.md string.
 */
async function _repairSkillMd(content, llmBackend, logger, filePath, context = {}) {
  const _path = require('path');
  const dirName = filePath ? _path.basename(_path.dirname(filePath)) : null;

  // ── _applyStaticFixes: deterministic fixes that must ALWAYS be applied ───────
  // Called both before Phase 2 (Phase 1) AND after Phase 2 LLM output to ensure
  // name/schedule/exec_path are correct regardless of what the LLM generates.
  function _applyStaticFixes(str) {
    // Strip outer fence
    str = str.replace(/^```[a-zA-Z]*\r?\n([\s\S]*)\n```\s*$/, '$1').trim();
    const fm = str.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fm) return str; // no frontmatter — can't fix deterministically without LLM
    let fmBody = fm[1];
    let changed = false;

    // Fix name: if the value has spaces or uppercase it is a human-readable title
    // (e.g. "ClickSend SMS API") — always replace with the directory name.
    // Simple space/uppercase check avoids false-negatives from strict dot-notation regex.
    const nameMatch = fmBody.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) {
      const cur = nameMatch[1].trim();
      const isTitle = /\s/.test(cur) || /[A-Z]/.test(cur);
      if (isTitle && dirName) {
        logger.info(`[skill.md repair] Static fix: name "${cur}" → "${dirName}"`);
        fmBody = fmBody.replace(/^(name:\s*)["']?.*?["']?\s*$/m, `$1${dirName}`);
        changed = true;
      }
    } else if (dirName) {
      // name field missing entirely — inject it
      fmBody = `name: ${dirName}\n` + fmBody;
      changed = true;
    }

    // Fix schedule: false / "false" → null
    if (/^schedule:\s*(false|"false")\s*$/m.test(fmBody)) {
      fmBody = fmBody.replace(/^schedule:\s*(false|"false")\s*$/m, 'schedule: null');
      changed = true;
    }

    // Inject exec_path / exec_type if missing
    if (!/^exec_path\s*:/m.test(fmBody) && dirName) {
      fmBody += `\nexec_path: ~/.thinkdrop/skills/${dirName}/skill.md`;
      changed = true;
    }
    if (!/^exec_type\s*:/m.test(fmBody)) {
      // _applyStaticFixes is only called on .md skill repair — default to shell
      fmBody += `\nexec_type: shell`;
      changed = true;
    }

    // Cross-field consistency: exec_type must match exec_path extension
    const _execTypeM = fmBody.match(/^exec_type:\s*(\S+)/m);
    const _execPathM = fmBody.match(/^exec_path:\s*(\S+)/m);
    if (_execTypeM && _execPathM) {
      const _isMdPath   = /\.md$/i.test(_execPathM[1]);
      const _isNodePath = /\.(cjs|js)$/i.test(_execPathM[1]);
      if (_execTypeM[1] === 'node' && _isMdPath) {
        fmBody = fmBody.replace(/^exec_type:\s*\S+/m, 'exec_type: shell');
        changed = true;
      } else if (_execTypeM[1] === 'shell' && _isNodePath) {
        fmBody = fmBody.replace(/^exec_type:\s*\S+/m, 'exec_type: node');
        changed = true;
      }
    }

    if (changed) str = `---\n${fmBody.trim()}\n---` + str.slice(fm[0].length);
    return str;
  }

  let s = content.trim();
  s = s.replace(/^```[a-zA-Z]*\r?\n([\s\S]*)\n```\s*$/, '$1').trim();

  // ── Phase 1: Apply deterministic fixes ──────────────────────────────────────
  s = _applyStaticFixes(s);

  // ── Phase 2: LLM-driven quality review ──────────────────────────────────────
  const issues = [];
  if (!s.startsWith('---')) issues.push('Missing YAML frontmatter opening (file must start with ---)');
  if (s.startsWith('---')) {
    const fmEnd = s.indexOf('\n---', 3);
    if (fmEnd === -1) {
      issues.push('Frontmatter block is not closed (missing second ---)');
    } else {
      const fm = s.slice(0, fmEnd);
      if (!/^name:/m.test(fm))        issues.push('Frontmatter missing required field: name');
      if (!/^description:/m.test(fm)) issues.push('Frontmatter missing required field: description');
      if (!/^secrets:/m.test(fm))     issues.push('Frontmatter missing required field: secrets');
      if (!/^schedule:/m.test(fm))    issues.push('Frontmatter missing required field: schedule');

      // Empty secrets when context suggests auth is needed
      const secretsMatch = fm.match(/^secrets:\s*\[\s*\]\s*$/m);
      if (secretsMatch && (context.crawledDocs || context.userMessage)) {
        issues.push('Secrets list is empty but this service requires authentication credentials (API key, username, etc.)');
      }
    }
  }

  if (!/^##\s+Plan/m.test(s)) issues.push('Missing ## Plan section (required for execution)');
  if (!/curl\s+/i.test(s) && !/shell\.run\s+bash/i.test(s)) {
    issues.push('Missing actionable command example (curl or shell.run bash) in ## Commands or ## Plan');
  }
  if (!/security\s+find-generic-password\s+-s\s+thinkdrop/i.test(s)) {
    issues.push('Auth section missing correct keytar retrieval format: security find-generic-password -s thinkdrop -a "skill:<name>:<KEY>" -w');
  }

  if (issues.length === 0) return s;

  logger.info(`[skill.md repair] Found ${issues.length} quality issue(s): ${issues.join('; ')}`);

  const KNOWN_API_PATTERNS = {
    'clicksend': { secrets: ['CLICKSEND_USERNAME', 'CLICKSEND_API_KEY'], auth: 'Basic auth (-u username:api_key)' },
    'twilio':    { secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], auth: 'Basic auth (-u account_sid:auth_token)' },
    'mailgun':   { secrets: ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN'], auth: 'Basic auth (-u api:key)' },
    'pushover':  { secrets: ['PUSHOVER_USER_KEY', 'PUSHOVER_APP_TOKEN'], auth: 'POST params' },
    'sendgrid':  { secrets: ['SENDGRID_API_KEY'], auth: 'Bearer token' },
    'vonage':    { secrets: ['VONAGE_API_KEY', 'VONAGE_API_SECRET'], auth: 'POST params' }
  };

  const service = dirName ? dirName.split('.')[0] : 'unknown';
  const pattern = KNOWN_API_PATTERNS[service] || null;

  const repairPrompt = `You are a skill contract repair agent. The following skill.md file has issues that will prevent it from being installed or used. Fix ALL listed issues and output the complete corrected skill.md.

CONTEXT:
- Skill Name (MUST be used verbatim as the name: field value): ${dirName || 'unknown'}
- User Request: ${context.userMessage || 'unknown'}
${pattern ? `- Known API Pattern for "${service}": Secrets=[${pattern.secrets.join(', ')}], Auth=${pattern.auth}` : ''}
${context.crawledDocs ? `- Crawled API Docs:\n${context.crawledDocs.slice(0, 2000)}` : ''}

ISSUES TO FIX:
${issues.map((iss, i) => `${i + 1}. ${iss}`).join('\n')}

RULES:
- CRITICAL: The frontmatter \`name:\` field MUST be exactly "${dirName || 'skill.name'}" — not a human-readable title.
- The file MUST start with a YAML frontmatter block (---).
- Required frontmatter fields: name, description, secrets (array of credential key names), schedule (null).
- \`## Auth\` section must show: security find-generic-password -s thinkdrop -a "skill:${dirName || '<name>'}:<KEY>" -w 2>/dev/null
- \`## Commands\` section must contain a REAL curl example using creds retrieved from keychain.
- \`## Plan\` section must list actionable steps: (1) shell.run bash to get secrets, (2) shell.run bash with curl, (3) synthesize to confirm.
- Do NOT wrap output in markdown code fences. Output ONLY the raw corrected skill.md content.

BROKEN CONTENT:
${s}`;

  try {
    const repaired = await llmBackend.generateAnswer(repairPrompt, {
      query: repairPrompt,
      context: { systemInstructions: `You are a skill contract repair agent. The skill name MUST be exactly "${dirName || 'skill.name'}" in the frontmatter. Output ONLY the corrected skill.md — no fences, no explanation.`, conversationHistory: [], intent: 'repair_skill' },
      options: { maxTokens: 2000, temperature: 0.1, fastMode: false }
    }, { maxTokens: 2000, temperature: 0.1, fastMode: false }, null).catch(() => null);

    if (repaired && repaired.trim().length > 100) {
      let cleaned = repaired.trim();

      // Step 1: strip if entire string is wrapped in a single fence
      cleaned = cleaned.replace(/^```[a-zA-Z]*\r?\n([\s\S]*)\n```\s*$/, '$1').trim();

      // Step 2: LLM prefixed with prose then a fence — extract content from first code block
      // that begins with --- (e.g. "Here is the corrected file:\n```yaml\n---\n...\n```")
      if (!cleaned.startsWith('---')) {
        const innerFence = cleaned.match(/```[a-zA-Z]*\r?\n(---[\s\S]*?)\n```/);
        if (innerFence) cleaned = innerFence[1].trim();
      }

      // Step 3: strip any remaining leading prose before the first --- delimiter
      if (!cleaned.startsWith('---')) {
        const fmIdx = cleaned.search(/^---$/m);
        if (fmIdx > 0) cleaned = cleaned.slice(fmIdx).trim();
      }

      // Step 4: apply deterministic fixes (name, schedule, exec_path, exec_type)
      cleaned = _applyStaticFixes(cleaned);

      // Step 5: if the LLM STILL didn't produce a frontmatter block, build one from context.
      // The body content (markdown sections) is still useful — just prepend correct frontmatter.
      if (!cleaned.startsWith('---')) {
        logger.warn(`[skill.md repair] Phase 2: LLM output lacks frontmatter — injecting from context`);
        const svc = dirName ? dirName.split('.')[0] : 'unknown';
        const pat = KNOWN_API_PATTERNS[svc];
        const secretsList = pat ? `[${pat.secrets.map(k => `'${k}'`).join(', ')}]` : '[]';
        // Try to pull a short description from the first non-heading sentence in the body
        const descMatch = cleaned.match(/^(?:#+\s+.+\n+)*([A-Z][^.\n]{10,100}\.)/m);
        const autoDesc = descMatch ? descMatch[1].trim() : `${svc} skill — send messages via API`;
        const injectedFm = `---\nname: ${dirName || 'skill.name'}\ndescription: ${autoDesc}\nsecrets: ${secretsList}\nschedule: null\nexec_path: ~/.thinkdrop/skills/${dirName}/skill.md\nexec_type: shell\n---\n\n`;
        cleaned = injectedFm + cleaned;
      }

      logger.info(`[skill.md repair] Phase 2: Repaired successfully (${cleaned.length} chars, has_frontmatter=${cleaned.startsWith('---')})`);
      return cleaned;
    }
  } catch (repairErr) {
    logger.warn(`[skill.md repair] Phase 2: LLM repair failed: ${repairErr.message}`);
  }

  // Phase 2 did not return usable content — apply the same frontmatter injection to Phase 1 result
  if (!s.startsWith('---') && dirName) {
    logger.warn(`[skill.md repair] Phase 1 fallback: injecting minimal frontmatter for ${dirName}`);
    const svc = dirName.split('.')[0];
    const pat = { 'clicksend': ['CLICKSEND_USERNAME', 'CLICKSEND_API_KEY'], 'twilio': ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], 'mailgun': ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN'], 'sendgrid': ['SENDGRID_API_KEY'], 'vonage': ['VONAGE_API_KEY', 'VONAGE_API_SECRET'] }[svc];
    const secretsList = pat ? `[${pat.map(k => `'${k}'`).join(', ')}]` : '[]';
    const fallbackFm = `---\nname: ${dirName}\ndescription: ${svc} skill\nsecrets: ${secretsList}\nschedule: null\nexec_path: ~/.thinkdrop/skills/${dirName}/skill.md\nexec_type: shell\n---\n\n`;
    s = fallbackFm + s;
  }
  return s;
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
  const _rawProgressCallback = state.progressCallback || null;
  // When a skill plan file is tracked, fan-out plan:* mirror events alongside native events
  const progressCallback = (_rawProgressCallback && state._skillPlanFile)
    ? (event) => {
        _rawProgressCallback(event);
        if (event.type === 'step_done')    _rawProgressCallback({ ...event, type: 'plan:step_done' });
        if (event.type === 'step_skipped') _rawProgressCallback({ ...event, type: 'plan:step_done' });
        if (event.type === 'step_failed')  _rawProgressCallback({ ...event, type: 'plan:step_failed' });
        if (event.type === 'all_done')     _rawProgressCallback({ ...event, type: 'plan:complete' });
      }
    : _rawProgressCallback;

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

  // Write live plan document on every pass so the UI / debugging tools can track progress
  const { writePlanDoc } = require('../utils/planDocument');
  writePlanDoc(state, 'start');

  // All steps done
  if (skillCursor >= skillPlan.length) {
    // ── Sub-plan completion check ───────────────────────────────────────────
    // If we're inside a sub-plan (subPlanStack non-empty), pop back to the
    // parent plan so execution resumes at the step that triggered the sub-plan
    // (e.g. the authenticated request that triggered the login sub-plan).
    const subPlanStackCheck = Array.isArray(state.subPlanStack) ? state.subPlanStack : [];
    if (subPlanStackCheck.length > 0) {
      const { completeSubPlan } = require('../utils/subPlanEngine');
      const resumed = completeSubPlan(state);
      logger.info(`[Node:ExecuteCommand] Sub-plan complete — resuming parent plan at cursor ${resumed.skillCursor}`);
      return {
        ...state,
        ...resumed,           // subPlanStack (popped), skillPlan (parent), skillCursor (failed step)
        commandExecuted: false,
        failedStep:      null,
        activeBrowserSessionId: state.activeBrowserSessionId || null,
      };
    }

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
    // Update skill plan file status on completion
    if (state._skillPlanFile) {
      try {
        const _planMd = fs.readFileSync(state._skillPlanFile, 'utf8');
        const _allOk = skillResults.every(r => r.ok);
        const _newStatus = _allOk ? 'complete' : 'failed';
        const _updatedMd = _planMd.replace(/^(status:\s*)(pending|failed)(\s*)$/m, `$1${_newStatus}$3`);
        fs.writeFileSync(state._skillPlanFile, _updatedMd, 'utf8');
        logger.info(`[Node:ExecuteCommand] Plan file status updated to ${_newStatus}: ${state._skillPlanFile}`);
      } catch (_planErr) {
        logger.warn(`[Node:ExecuteCommand] Could not update plan file status: ${_planErr.message}`);
      }
    }

    if (progressCallback) progressCallback({ type: 'all_done', completedCount, totalCount: skillPlan.length, skillResults, savedFilePaths: [...new Set(savedFilePaths)], planFile: state._skillPlanFile || null });

    // ── Composite agent synthesis (Part 3) ───────────────────────────────────
    // After a fully successful multi-step plan with 2+ consecutive same-domain
    // external.skill steps, synthesize a composite [name].agent skill so future
    // runs can use a single step instead of the full sequence.
    const _allOkForComposite = skillResults.every(r => r.ok || r.skipped);
    if (_allOkForComposite && skillResults.length >= 2) {
      try {
        // Find consecutive runs of external.skill steps from the same domain
        const _externalSteps = skillResults
          .filter(r => r.skill === 'external.skill' && r.ok && r.args?.name)
          .map(r => ({ skillName: r.args.name, args: r.args }));

        if (_externalSteps.length >= 2) {
          // Group by hostname prefix (e.g. 'perplexity_ai_click_history' → 'perplexity_ai')
          const _hostname = (() => {
            const firstName = _externalSteps[0].skillName;
            // Try to extract domain from skill name (e.g. perplexity_ai → perplexity.ai)
            const parts = firstName.split('_');
            // Walk forward while parts match a domain-like segment
            for (let n = parts.length - 1; n >= 2; n--) {
              const candidate = parts.slice(0, n).join('.');
              if (/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(candidate.replace(/_/g, '.'))) {
                return parts.slice(0, n).join('_');
              }
            }
            return parts.slice(0, 2).join('_');
          })();

          const _allSameDomain = _externalSteps.every(s => s.skillName.startsWith(_hostname));
          if (_allSameDomain) {
            const { generateCompositeAgentSkill } = require('../../mcp-services/command-service/src/skills/explore.agent.cjs');
            const _orderedActions = _externalSteps.map(s => {
              const skillParts = s.skillName.replace(_hostname + '_', '').split('_');
              return {
                actionKey: s.skillName,
                interaction: skillParts[0] || 'click',
                locators: { primary: s.args?.selector || '', fallback_1: '', fallback_2: '' },
                followUp: null,
              };
            });
            const _domainHostname = _hostname.replace(/_/g, '.');
            const _agentName = `${_hostname}_agent`;
            const _composite = generateCompositeAgentSkill(_domainHostname, _agentName, _orderedActions);
            if (_composite && !_composite.error) {
              // Register the composite skill asynchronously (non-blocking)
              const { _registerSkill } = require('../../mcp-services/command-service/src/skills/explore.agent.cjs');
              if (typeof _registerSkill === 'function') {
                _registerSkill(_composite).catch(() => {});
              } else {
                // Fallback: write directly to skills dir
                const _os = require('os');
                const _fs = require('fs');
                const _path = require('path');
                const _skillDir = _path.join(_os.homedir(), '.thinkdrop', 'skills', _agentName);
                _fs.mkdirSync(_skillDir, { recursive: true });
                _fs.writeFileSync(_path.join(_skillDir, 'index.cjs'), _composite.code, 'utf8');
              }
              logger.info(`[Node:ExecuteCommand] Composite agent synthesized: ${_agentName} (${_orderedActions.length} steps)`);
            }
          }
        }
      } catch (_compositeErr) {
        logger.warn(`[Node:ExecuteCommand] Composite agent synthesis failed (non-fatal): ${_compositeErr.message}`);
      }
    }

    // Archive the completed plan document
    writePlanDoc({ ...state, skillResults, skillCursor }, 'complete');

    // Build a rich commandOutput summary for the answer node to interpret
    const stepSummaries = skillResults.map((r, i) => {
      const label = r.description || r.skill;
      const status = r.skipped ? '⚠️' : (r.ok ? '✓' : '✗');
      const detail = r.skipped && r.skipReason
        ? `Skipped: ${r.skipReason}`
        : r.result
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

    // Last getPageText result — the actual page content the user asked for.
    // Prefer getPageText (explicit canonical read); fall back to waitForStableText
    // only for older plans that lack an explicit getPageText step.
    const _getPageTextResult = [...skillResults].reverse().find(r =>
      r.skill === 'browser.act' && r.ok && r.args?.action === 'getPageText' && (r.result || r.stdout)
    );
    const pageTextResult = _getPageTextResult || [...skillResults].reverse().find(r =>
      r.skill === 'browser.act' && r.ok && r.args?.action === 'waitForStableText' && (r.result || r.stdout)
    );
    const pageTextContent = pageTextResult
      ? (typeof pageTextResult.result === 'string' && pageTextResult.result ? pageTextResult.result : pageTextResult.stdout)
      : null;

    let answer;
    if (imageAnalyzeResult) {
      answer = imageAnalyzeResult.stdout;
    } else if (pageTextContent) {
      answer = pageTextContent.trim();
    } else if (hasBrowserSteps && lastBrowserResult?.url) {
      const title = lastBrowserResult.title ? ` — "${lastBrowserResult.title}"` : '';
      answer = `Done! Browser is open at ${lastBrowserResult.url}${title}`;
    } else {
      answer = `All ${completedCount} step${completedCount !== 1 ? 's' : ''} completed successfully.`;
      answer = imageAnalyzeFailure
        ? `Image analysis failed: ${imageAnalyzeFailure.error || 'unknown error'}`
        : `Completed ${completedCount}/${skillPlan.length} steps (${failedCount} failed).`;
    }

    // Preserve the last active browser sessionId so follow-up tasks reuse the same tab
    const lastBrowserStep = [...skillResults].reverse().find(r => r.skill === 'browser.act' && r.ok);
    const activeBrowserSessionId = lastBrowserStep?.args?.sessionId || state.activeBrowserSessionId || null;

    // Collect sessionFileCreations from skill results (for "newly created file" references)
    let sessionFileCreations = skillResults
      .filter(r => r.ok && r.sessionFileCreations?.length > 0)
      .flatMap(r => r.sessionFileCreations);
    
    // Also generate sessionFileCreations from shell skills that create files
    // This handles synthesize skills and other shell-based file creators
    const shellCreatedFiles = [];
    skillResults.forEach((r, idx) => {
      if (r.skill === 'shell.run' && r.ok && r.args?.cmd === 'bash') {
        const argv = r.args?.argv || [];
        const script = argv[1] || argv.find(a => typeof a === 'string' && a !== '-c') || '';
        const writeMatch = script.match(/(?:echo\s[^>]*>+|printf\s[^>]*>+|cat\s*>+|tee\s+|cp\s+\S+\s+|mv\s+\S+\s+)\s*['"]?((?:~|\/)[^\s'"]+\.[a-zA-Z0-9]+)['"]?/);
        if (writeMatch && writeMatch[1]) {
          const rawPath = writeMatch[1];
          const absPath = rawPath.startsWith('~/') ? rawPath.replace('~', homeDir) : rawPath;
          shellCreatedFiles.push({
            timestamp: new Date().toISOString(),
            operationId: `shell_${idx}_${Date.now()}`,
            type: 'single_file',
            description: `Created file via shell command`,
            primaryPath: absPath,
            allPaths: [absPath],
            fileCount: 1
          });
        }
      }
    });
    
    // Merge shell-created files with skill-reported creations
    if (shellCreatedFiles.length > 0) {
      sessionFileCreations = [...sessionFileCreations, ...shellCreatedFiles];
    }
    
    if (sessionFileCreations.length > 0) {
      logger.info(`[Node:ExecuteCommand] Collected ${sessionFileCreations.length} file creation operation(s) from skill results`);
    }

    // Stream the answer to the UI — answer node is bypassed for command_automate,
    // so we push the execution result here via streamCallback for the Results window.
    // Guard: skip if answer node already streamed tokens (_answerStreamed=true) to
    // prevent the full answer being sent a second time after live streaming completed.
    const streamCallback = state.streamCallback || null;
    if (answer && typeof streamCallback === 'function' && !state._answerStreamed) {
      logger.info(`[Node:ExecuteCommand] Streaming execution answer (${answer.length} chars)`);
      streamCallback(answer);
    }

    return {
      ...state,
      commandExecuted: true,
      failedStep: null,
      commandOutput: stepSummaries,
      activeBrowserSessionId,
      answer,
      sessionFileCreations
    };
  }

  const step = skillPlan[skillCursor];
  const { skill, optional = false, description } = step;

  // ── {{PREV_OUTPUT}} template injection ───────────────────────────────────
  // Allows multi-step plans to pass data from one step to the next.
  // The previous step's primary output is injected into any arg string containing
  // the {{PREV_OUTPUT}} or {{prev_stdout}} marker at dispatch time (not at plan-write time).
  // browser.agent stores page text in .result (not .stdout) — read both fields.
  let args = step.args || {};
  if (skillCursor > 0 && skillResults.length > 0) {
    const _prev = skillResults[skillResults.length - 1];
    const _prevResultStr = typeof _prev?.result === 'object' && _prev?.result !== null
      ? JSON.stringify(_prev.result)
      : (_prev?.result || '');
    const prevStdout = (_prev?.stdout || _prevResultStr || '').slice(0, 12000);
    if (prevStdout) {
      // Case-insensitive: match {{PREV_OUTPUT}} and {{prev_stdout}} (planner sometimes emits lowercase)
      const injectPrev = (val) => typeof val === 'string'
        ? val.replace(/\{\{PREV_OUTPUT\}\}/gi, prevStdout).replace(/\{\{prev_stdout\}\}/gi, prevStdout)
        : val;
      const newArgs = {};
      for (const [k, v] of Object.entries(args)) newArgs[k] = injectPrev(v);
      args = newArgs;
    }

    // ── {{PREV_OUTPUT_FILE}} — for browser.agent steps that need bulk content ──
    // browser.agent task strings are capped at 300 chars, so we can't inline content.
    // Write the prior step's output to a temp file and substitute the path marker.
    if (skill === 'browser.agent' && prevStdout) {
      const _tmpFile = `/tmp/thinkdrop_pipe_${Date.now()}.txt`;
      try {
        require('fs').writeFileSync(_tmpFile, prevStdout, 'utf8');
        const injectFile = (val) => typeof val === 'string' ? val.replace(/\{\{PREV_OUTPUT_FILE\}\}/g, _tmpFile) : val;
        const fileArgs = {};
        for (const [k, v] of Object.entries(args)) fileArgs[k] = injectFile(v);
        args = { ...fileArgs, _prevOutputFile: _tmpFile };
      } catch (_) {}
    }
  }

  // ── {{user.agent.resolved.*}} — substitute resolved user context fields ──────
  // When the plan uses {{user.agent.resolved.email}}, {{user.agent.resolved.name}},
  // etc., find the most recent user.agent result and substitute from its resolved
  // object before the step args reach playwright.agent / browser.act.
  if (skillCursor > 0) {
    const _prevUserAgent = [...skillResults].reverse().find(r => r.skill === 'user.agent' && r.ok);
    if (_prevUserAgent) {
      const _uaResolved = _prevUserAgent?.result?.resolved || _prevUserAgent?.resolved || {};
      logger.info(`[Node:ExecuteCommand] user.agent resolved keys: ${JSON.stringify(Object.keys(_uaResolved))} | result keys: ${JSON.stringify(Object.keys(_prevUserAgent?.result || {}))}`);
      const _uaFlat = {};
      if (_uaResolved.self) Object.entries(_uaResolved.self).forEach(([k, v]) => { _uaFlat[k] = String(v); });
      if (_uaResolved.email) _uaFlat.email = String(_uaResolved.email);
      if (_uaResolved.name) _uaFlat.name = String(_uaResolved.name);
      // Fallback 1: extract email from summary text
      const _uaSummary = _prevUserAgent?.result?.summary || _prevUserAgent?.summary || '';
      if (!_uaFlat.email && _uaSummary) {
        const _emailMatch = _uaSummary.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
        if (_emailMatch) _uaFlat.email = _emailMatch[1];
      }
      // Fallback 2: scan full serialized result for any email address
      if (!_uaFlat.email) {
        const _uaResultStr = JSON.stringify(_prevUserAgent?.result || _prevUserAgent || '');
        const _emailMatch2 = _uaResultStr.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
        if (_emailMatch2) {
          _uaFlat.email = _emailMatch2[1];
          logger.info(`[Node:ExecuteCommand] user.agent email extracted from serialized result: ${_uaFlat.email}`);
        }
      }
      logger.info(`[Node:ExecuteCommand] user.agent _uaFlat: ${JSON.stringify(_uaFlat)}`);
      if (Object.keys(_uaFlat).length > 0) {
        const _hasUaToken = (val) => typeof val === 'string' && val.includes('{{user.agent.');
        const _injectUa = (val) => {
          if (!_hasUaToken(val)) return val;
          let result = val;
          for (const [k, v] of Object.entries(_uaFlat)) {
            result = result.replace(new RegExp(`\\{\\{user\\.agent\\.resolved\\.${k}\\}\\}`, 'gi'), v);
          }
          return result;
        };
        const _uaArgs = {};
        for (const [k, v] of Object.entries(args)) _uaArgs[k] = _injectUa(v);
        if (JSON.stringify(_uaArgs) !== JSON.stringify(args)) {
          logger.info(`[Node:ExecuteCommand] Substituted {{user.agent.resolved.*}} tokens from prior user.agent result`);
          args = _uaArgs;
        } else if (Object.values(args).some(v => typeof v === 'string' && v.includes('{{user.agent.'))) {
          logger.warn(`[Node:ExecuteCommand] {{user.agent.resolved.*}} token found in args but no substitution made — _uaFlat may be missing the key`);
        }
      }
    } else {
      // Log when token is present but no user.agent result found
      if (Object.values(args).some(v => typeof v === 'string' && v.includes('{{user.agent.'))) {
        logger.warn(`[Node:ExecuteCommand] {{user.agent.resolved.*}} token in args but no prior user.agent result found in skillResults`);
      }
    }
  }

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

  // Emit plan:step_start for PlanPanel step tracking
  if (_rawProgressCallback && state._skillPlanFile) {
    _rawProgressCallback({ type: 'plan:step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description });
  }

  // ── schedule pseudo-skill (NON-BLOCKING) ─────────────────────────────────
  // Registers a one-shot reminder with command-service /reminder.register,
  // then returns immediately. No blocking setTimeout countdown.
  if (skill === 'schedule') {
    const { time, delayMs: rawDelayMs, label = 'Waiting...' } = args;
    let waitMs = 0;
    if (rawDelayMs && typeof rawDelayMs === 'number' && rawDelayMs > 0) {
      waitMs = rawDelayMs;
    } else if (time && typeof time === 'string') {
      const now = new Date();
      const ts = time.trim().toUpperCase();
      const m12 = ts.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
      const m24 = ts.match(/^(\d{1,2}):(\d{2})$/);
      let td = null;
      if (m12) {
        let h = parseInt(m12[1], 10); const mn = parseInt(m12[2] || '0', 10);
        if (m12[3] === 'PM' && h < 12) h += 12;
        if (m12[3] === 'AM' && h === 12) h = 0;
        td = new Date(now); td.setHours(h, mn, 0, 0);
      } else if (m24) {
        td = new Date(now); td.setHours(parseInt(m24[1], 10), parseInt(m24[2], 10), 0, 0);
      }
      if (td) { if (td <= now) td.setDate(td.getDate() + 1); waitMs = td.getTime() - now.getTime(); }
    }
    if (waitMs <= 0) {
      logger.info('[Node:ExecuteCommand] schedule: no valid future time — skipping');
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'schedule', description: 'Schedule: skipped', stdout: 'Skipped' });
      return { ...state, skillResults: [...skillResults, { step: skillCursor + 1, skill: 'schedule', args, description, ok: true, stdout: 'Skipped — time already passed' }], skillCursor: skillCursor + 1, commandExecuted: false };
    }
    const targetIso = new Date(Date.now() + waitMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const reminderId = `reminder_${Date.now()}`;
    // Determine pending steps to execute when reminder fires.
    // Notification-only steps (osascript/display notification) are excluded because main.js
    // already shows a dialog + Electron Notification on every reminder fire.
    // Real action steps (browser.act, non-notification shell.run, etc.) are serialized and
    // executed directly via command-service when the reminder fires — no stategraph re-run.
    // Re-running the original prompt causes an infinite loop for time-delay reminders.
    const remainingSteps = skillPlan.slice(skillCursor + 1);
    const isNotificationStep = (s) => s.skill === 'synthesize' ||
      (s.skill === 'shell.run' && (
        s.args?.cmd === 'osascript' ||
        (s.args?.cmd === 'bash' && String(s.args?.argv || '').includes('osascript')) ||
        String(s.args?.argv || '').includes('display notification')
      ));
    const pendingRealSteps = remainingSteps.filter(s => !isNotificationStep(s));
    const triggerIntent = pendingRealSteps.length > 0 ? 'execute_steps' : 'notify';
    // Always use a clean human-readable message for the dialog/notification shown on fire.
    // Never use state.message (the raw user prompt) — that causes infinite loops when re-run.
    const synthStep = remainingSteps.find(s => s.skill === 'synthesize');
    let notifyMessage = synthStep?.args?.prompt || '';
    if (!notifyMessage) {
      const cleanLabel = (label || '').replace(/^remind(er)?(\s+to)?\s*/i, '').replace(/^check\s+/i, 'check ');
      notifyMessage = cleanLabel ? `It's time to ${cleanLabel}!` : label;
    }
    const triggerPrompt = notifyMessage;
    const pendingSteps = pendingRealSteps.length > 0 ? JSON.stringify(pendingRealSteps) : null;
    // POST to command-service /reminder.register (non-blocking)
    const cmdPort = 3007;
    try {
      const http = require('http');
      const payload = JSON.stringify({ id: reminderId, delayMs: waitMs, label, triggerIntent, triggerPrompt, pendingSteps });
      const req = http.request({ hostname: '127.0.0.1', port: cmdPort, path: '/reminder.register', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 5000 });
      req.on('error', (e) => logger.warn(`[Node:ExecuteCommand] schedule: reminder register failed: ${e.message}`));
      req.write(payload);
      req.end();
    } catch (e) { logger.warn(`[Node:ExecuteCommand] schedule: reminder register error: ${e.message}`); }
    logger.info(`[Node:ExecuteCommand] schedule: registered reminder "${label}" → fires at ${targetIso} (intent=${triggerIntent})`);
    if (progressCallback) progressCallback({ type: 'schedule_registered', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'schedule', description: `⏰ Reminder set — ${label} at ${targetIso}`, targetTime: targetIso, label, reminderId });
    // Return immediately — skip all remaining steps (they'll run when the reminder fires)
    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'schedule', args, description, ok: true, stdout: `Reminder set for ${targetIso} — "${label}"` }],
      skillCursor: skillPlan.length, // skip to end — remaining steps fire on reminder
      commandExecuted: true,
      answer: `⏰ Reminder set: "${label}" at ${targetIso}`,
    };
  }


  // ── ask_user pseudo-skill ────────────────────────────────────────────────
  // Used by buildLoginSubPlan (and general sub-plans) to collect credentials
  // or other user input mid-execution, then store the answer in state so the
  // next profile.store_secret step can persist it to keychain safely.
  //
  // Uses guide.step style: shows an instruction card with an input field.
  // The answer is stored in state._gatheredVars[args.varName] for the
  // following profile.store_secret step to read.
  if (skill === 'ask_user') {
    const {
      question: askQuestion = 'Please provide the required information.',
      inputHint = 'Your answer',
      varName,
      sensitive = false,
    } = args;

    logger.info(`[Node:ExecuteCommand] ask_user: "${askQuestion.slice(0, 80)}"`);

    const gatherCredentialCallback = state.gatherCredentialCallback || null;
    let gathered = null;

    if (typeof gatherCredentialCallback === 'function') {
      try {
        // Emit gather_credential to show the masked input card in the Queue tab UI
        // (same pattern as planSkills.js credential gate)
        if (progressCallback) progressCallback({
          type: 'gather_credential',
          credentialKey: varName || inputHint,
          question: askQuestion,
          hint: inputHint,
          sensitive,
          optional: args.optional || false,
          stepIndex: skillCursor,
          totalSteps: skillPlan.length,
        });
        // gatherCredentialCallback waits for the user to submit via IPC gather:credential
        // and returns { stored: boolean, value: string | null }
        const result = await gatherCredentialCallback(varName || inputHint, {
          question: askQuestion,
          hint: inputHint,
          sensitive,
        });
        gathered = result?.value ?? null;
        if (gathered !== null) {
          logger.info(`[Node:ExecuteCommand] ask_user: credential received for "${varName}"`);
          if (progressCallback) progressCallback({ type: 'gather_credential_stored', credentialKey: varName || inputHint });
        }
      } catch (cbErr) {
        logger.warn(`[Node:ExecuteCommand] ask_user: gatherCredentialCallback threw: ${cbErr.message}`);
      }
    }

    if (gathered === null) {
      // No callback — surface as a pendingQuestion (IPC fallback) and pause execution
      logger.info(`[Node:ExecuteCommand] ask_user: no gatherCredentialCallback — surfacing pendingQuestion`);
      if (progressCallback) progressCallback({
        type: 'guide_step',
        stepIndex: skillCursor,
        totalSteps: skillPlan.length,
        instruction: askQuestion,
        inputHint,
        sensitive,
        varName,
      });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'ask_user', args, description, ok: true, stdout: `[Waiting for user input: ${askQuestion.slice(0, 60)}]` }],
        skillCursor: skillCursor + 1,
        commandExecuted: false,
        pendingQuestion: {
          question: askQuestion,
          inputHint,
          sensitive,
          varName,
          options: [],
        },
        failedStep: null,
      };
    }

    // Store gathered value in transient state for profile.store_secret
    const updatedGatheredVars = { ...(state._gatheredVars || {}), [varName]: gathered };
    if (progressCallback) progressCallback({
      type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length,
      skill: 'ask_user', description: description || `Collected: ${inputHint}`,
      stdout: sensitive ? '[credential collected]' : gathered,
    });
    return {
      ...state,
      _gatheredVars: updatedGatheredVars,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'ask_user', args, description, ok: true, stdout: sensitive ? '[credential collected]' : `Collected: ${inputHint}` }],
      skillCursor: skillCursor + 1,
      failedStep: null,
    };
  }

  // ── profile.store_secret pseudo-skill ────────────────────────────────────
  // Persists a credential collected by ask_user to macOS keychain AND writes a
  // KEYTAR:<key> pointer to user-memory profile DB. After storing, the value is
  // accessible via KEYTAR resolution in subsequent browser.act fill steps.
  //
  // Args:
  //   keytarKey  {string}  Key under which to store in keychain (e.g. GMAIL_EMAIL)
  //   valueVar   {string}  _gatheredVars key where the plaintext value lives
  //   service    {string}  Service label (e.g. 'gmail') for profile pointer
  //   label      {string}  Human-readable label (e.g. 'Gmail email')
  if (skill === 'profile.store_secret') {
    const { keytarKey, valueVar, service: secretService = '', label: secretLabel = '' } = args;
    const gatheredVars = state._gatheredVars || {};
    const secretValue = gatheredVars[valueVar];

    if (!secretValue || !keytarKey) {
      logger.warn(`[Node:ExecuteCommand] profile.store_secret: missing keytarKey="${keytarKey}" or valueVar="${valueVar}" not in _gatheredVars`);
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'profile.store_secret', args, description, ok: true, stdout: `[Skipped — no value for ${valueVar}]` }],
        skillCursor: skillCursor + 1,
        failedStep: null,
      };
    }

    try {
      const { spawnSync } = require('child_process');

      // 1. Store in macOS keychain under thinkdrop service
      const keychainResult = spawnSync(
        'security',
        ['add-generic-password', '-s', 'thinkdrop', '-a', keytarKey, '-w', secretValue, '-U'],
        { encoding: 'utf8', timeout: 10000 }
      );
      if (keychainResult.status !== 0) {
        logger.warn(`[Node:ExecuteCommand] profile.store_secret: keychain write failed for "${keytarKey}": ${keychainResult.stderr?.trim?.()}`);
      } else {
        logger.info(`[Node:ExecuteCommand] profile.store_secret: stored "${keytarKey}" in keychain`);
      }

      // 2. Write KEYTAR pointer to user-memory profile DB (standard <service>:* key format)
      if (mcpAdapter && secretService) {
        // Derive standard service key from keytarKey (e.g. GMAIL_EMAIL → gmail:username)
        const normalKey = keytarKey.toLowerCase();
        const profileKey = normalKey.includes('email') || normalKey.includes('username')
          ? `${secretService.toLowerCase()}:username`
          : normalKey.includes('password')
            ? `${secretService.toLowerCase()}:password`
            : `${secretService.toLowerCase()}:${normalKey.replace(/^[a-z]+_/, '')}`;

        await mcpAdapter.callService('user-memory', 'profile.set', {
          key:      keytarKey,
          valueRef: `KEYTAR:${keytarKey}`,
          service:  secretService,
          label:    secretLabel || keytarKey,
        }, { timeoutMs: 5000 }).catch(e => logger.warn(`[Node:ExecuteCommand] profile.store_secret: profile.set failed: ${e.message}`));

        // Also write standard <service>:username / <service>:password pointer
        if (profileKey !== keytarKey) {
          await mcpAdapter.callService('user-memory', 'profile.set', {
            key:      profileKey,
            valueRef: `KEYTAR:${keytarKey}`,
            service:  secretService,
            label:    secretLabel || profileKey,
          }, { timeoutMs: 5000 }).catch(e => logger.warn(`[Node:ExecuteCommand] profile.store_secret: profile.set (alias) failed: ${e.message}`));
        }
      }

      if (progressCallback) progressCallback({
        type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length,
        skill: 'profile.store_secret', description: description || `Stored: ${keytarKey}`,
        stdout: `[credential stored securely: ${keytarKey}]`,
      });
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'profile.store_secret', args, description, ok: true, stdout: `[credential stored securely: ${keytarKey}]` }],
        skillCursor: skillCursor + 1,
        failedStep: null,
      };
    } catch (storeErr) {
      logger.error(`[Node:ExecuteCommand] profile.store_secret threw: ${storeErr.message}`);
      // Non-fatal — continue execution even if store failed
      return {
        ...state,
        skillResults: [...skillResults, { step: skillCursor + 1, skill: 'profile.store_secret', args, description, ok: true, stdout: `[credential store failed: ${storeErr.message}]` }],
        skillCursor: skillCursor + 1,
        failedStep: null,
      };
    }
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

  // ── needs_skill safety net ───────────────────────────────────────────────
  // If needs_skill bypasses the scout intercept (e.g. during a recovery replan),
  // it would normally hit the MCP dispatcher with no handler and fail silently.
  // Surface a clear ask_user card instead.
  if (skill === 'needs_skill') {
    const { capability = 'an unknown capability', suggestion = '' } = args;
    // If planSkills already set a scout selection card (_isScoutSelect:true), preserve it —
    // don't overwrite with a plain "Yes, build the skill" card.  The scout card has the
    // full provider list and will route to the correct provider-selection flow in main.js.
    if (state.pendingQuestion?._isScoutSelect) {
      logger.info(`[Node:ExecuteCommand] needs_skill: scout card already pending — preserving scout pendingQuestion for "${capability}"`);
      return { ...state, commandExecuted: false };
    }
    const message = `🔧 ThinkDrop needs a custom skill to: **${capability}**${suggestion ? `\n\nSuggested services: ${suggestion}` : ''}\n\nWould you like to build this skill now?`;
    logger.info(`[Node:ExecuteCommand] needs_skill: surfacing capability gap for "${capability}"`);
    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'needs_skill', description: description || `Skill needed: ${capability}`, stdout: message });
    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'needs_skill', args, description, ok: true, stdout: message }],
      skillCursor: skillCursor + 1,
      commandExecuted: false,
      pendingQuestion: {
        question: message,
        options: [
          `Yes, build the skill for: ${capability}`,
          `No thanks, skip this`
        ]
      },
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
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'guide.step', description: description || 'Guide step', stdout: 'Skipped (no instruction)', instruction: '' });
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

    // ── Session validation guard ──────────────────────────────────────────────
    // Only use page-event mode if a preceding browser.act step actually opened
    // a browser session (navigate/goto). If the sessionId was invented by the LLM
    // (e.g. "desktop_prefs" for System Settings) without a real browser.act navigate,
    // there is no Playwright session to poll — fall back to IPC mode immediately.
    const hasRealBrowserSession = skillResults.some(
      r => r.skill === 'browser.act' && r.ok && r.args?.sessionId &&
        (r.args.action === 'navigate' || r.args.action === 'goto' || r.args.url)
    );
    const usePageEventMode = guideSessionId && mcpAdapter && hasRealBrowserSession;

    if (!hasRealBrowserSession && guideSessionId) {
      logger.warn(`[Node:ExecuteCommand] guide.step: sessionId="${guideSessionId}" has no matching browser.act navigate — falling back to IPC mode`);
    }

    if (usePageEventMode) {
      // ── MODE 1: waitForTrigger — CDP exposeBinding, CSP-safe, event-driven ──
      // The highlight overlay attaches blur/change/click listener per element type.
      // When the user interacts, listener calls window.__tdTrigger() — a CDP binding
      // registered once per session in getSession(). No eval, no polling, no CSP issues.
      logger.info(`[Node:ExecuteCommand] guide.step: waiting for page trigger on session=${guideSessionId}`);
      let triggered = false;
      let waitTriggerRaw = null;

      try {
        const waitTriggerRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'browser.act',
          args: { action: 'waitForTrigger', sessionId: guideSessionId, timeoutMs: guideTimeout }
        }, { timeoutMs: guideTimeout + 5000 });
        waitTriggerRaw = waitTriggerRes?.data || waitTriggerRes;
        triggered = true;
      } catch (err) {
        const errMsg = err.message || '';
        // If the session doesn't exist or playwright-cli is not running, do NOT
        // auto-approve. Fall back to IPC mode so user must explicitly continue.
        if (/no active browser session|playwright-cli is not running|session was never opened/i.test(errMsg)) {
          logger.warn(`[Node:ExecuteCommand] guide.step: waitForTrigger failed — no browser session "${guideSessionId}" — falling back to IPC mode`);
          triggered = false;
        } else {
          // Genuine timeout or expected error (e.g. page closed) — auto-continue
          triggered = true;
          logger.info(`[Node:ExecuteCommand] guide.step: waitForTrigger ended (${errMsg.slice(0, 60)}) — auto-continuing`);
        }
      }

      // ── Auth wall detection ─────────────────────────────────────────────────
      // waitForTrigger is aliased to waitForStableText in the command service.
      // When the browser is on a login/redirect page, waitForStableText returns
      // quickly with authRequired:true (stable login-page text). This is NOT
      // a real user interaction — surface it to the user immediately instead of
      // continuing through guide steps that do nothing.
      if (triggered && waitTriggerRaw?.authRequired) {
        let friendlyHost = 'the site';
        try {
          friendlyHost = new URL(state.activeBrowserUrl || guideUrl || '').hostname.replace(/^www\./, '');
        } catch (_) {}
        logger.info(`[Node:ExecuteCommand] guide.step: auth wall on session=${guideSessionId} (${friendlyHost}) — surfacing login requirement`);
        if (progressCallback) progressCallback({ type: 'all_done', totalCount: skillResults.length + 1, skillResults });
        return {
          ...state,
          answer: `I need you to sign in to **${friendlyHost}** first. The browser opened the login page — please enter your credentials there. Once you're logged in, ask me to retry.`,
          examineBlocked: true,
          skillCursor: skillPlan.length,
          commandExecuted: true,
          failedStep: null,
          skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: false, stdout: '[auth wall — login required]', authWall: true }],
        };
      }

      if (!triggered) {
        // waitForTrigger failed due to non-existent session — fall through to IPC mode below
        logger.info(`[Node:ExecuteCommand] guide.step: page-event mode failed — falling through to IPC mode`);
      }

      if (triggered) {
        continued = true;
        logger.info(`[Node:ExecuteCommand] guide.step: page trigger fired — continuing`);
      }

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

      // Only do post-trigger navigation/rescan when the page-event actually fired.
      // If triggered=false, we're falling through to IPC mode — no browser interaction happened.
      if (!triggered) {
        // Skip nav wait + rescan — fall through to IPC fallback below
      } else {

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
                skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'User action detected — continuing', instruction: instruction || '' }],
                skillCursor: skillCursor + 1,
                activeBrowserUrl: newPageUrl,
                activeBrowserPageElements: { url: newPageUrl, elements: els },
                completedGuideSteps,
                commandExecuted: false
              };
            }

            // Real page change — force a replan with real elements from the new page.
            const updatedResults = [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'User action detected — continuing', instruction: instruction || '' }];
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

      } // end else (triggered=true post-trigger logic)
    } // end if (usePageEventMode)

    // ── MODE 2: IPC fallback — wait for guide:continue from ResultsWindow ──
    // Falls through here if: (a) usePageEventMode is false, or (b) page-event
    // mode failed (triggered=false → continued still false).
    if (!continued) {
      const confirmGuideCallback = state.confirmGuideCallback || null;
      if (typeof confirmGuideCallback === 'function') {
        logger.info(`[Node:ExecuteCommand] guide.step: IPC mode — waiting for user to click Continue`);
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

    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'guide.step', description: description || 'Guide step', stdout: 'User action detected — continuing', instruction: instruction || '' });

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'guide.step', args, description, ok: true, stdout: 'User action detected — continuing', instruction: instruction || '' }],
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
    const _homedir = require('os').homedir();
    const skillPath = rawPath
      .replace(/~/g, _homedir)
      .replace(/\$HOME\b/g, _homedir)
      .replace(/\$USERPROFILE\b/g, _homedir);

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
      const path = require('path');
      const os = require('os');

      // Resolve contractMd: prefer inline arg, then file on disk, then auto-scaffold
      let contractMd = args.contractMd || null;
      if (!contractMd) {
        if (skillPath && fs.existsSync(skillPath)) {
          contractMd = fs.readFileSync(skillPath, 'utf8');
          // Inject exec_path and exec_type if missing — the skill.install MCP requires them
          // but the LLM-synthesized skill.md often omits them.
          const fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            let fmBody = fmMatch[1];
            const skillDir = path.dirname(skillPath);
            const inferName = path.basename(skillDir);
            // Extract body once from original contractMd so all reconstructions use the
            // correct offset regardless of how fmBody length changes.
            const bodyAfterFm = contractMd.slice(fmMatch[0].length);
            // Fix name: field — if the value has spaces or uppercase it's a human-readable
            // title (e.g. "ClickSend SMS API"). Replace with the directory-derived name.
            const nameMatch = fmBody.match(/^name:\s*["']?(.+?)["']?\s*$/m);
            if (nameMatch) {
              const curName = nameMatch[1].trim();
              const isTitle = /\s/.test(curName) || /[A-Z]/.test(curName);
              if (isTitle && inferName) {
                logger.info(`[Node:ExecuteCommand] skill.install: fixing invalid name "${curName}" → "${inferName}"`);
                fmBody = fmBody.replace(/^(name:\s*)["']?.*?["']?\s*$/m, `$1${inferName}`);
              }
            }
            if (!/^exec_path\s*:/m.test(fmBody)) {
              fmBody += `\nexec_path: ~/.thinkdrop/skills/${inferName}/skill.md`;
              logger.debug(`[Node:ExecuteCommand] skill.install: injected exec_path for ${inferName}`);
            }
            if (!/^exec_type\s*:/m.test(fmBody)) {
              // Derive from exec_path: .md → shell, .cjs/.js → node
              const _ep = (fmBody.match(/^exec_path:\s*(\S+)/m) || [])[1] || '';
              fmBody += `\nexec_type: ${/\.(cjs|js)$/i.test(_ep) ? 'node' : 'shell'}`;
              logger.debug(`[Node:ExecuteCommand] skill.install: injected exec_type for ${inferName}`);
            }
            contractMd = `---\n${fmBody}\n---` + bodyAfterFm;
            // Write corrected contract back to disk so the file matches what we register
            try { fs.writeFileSync(skillPath, contractMd, 'utf8'); } catch (_) {}
          }
        } else {
          // No file on disk — check if a prior synthesize step should have created it.
          // Only auto-scaffold if a prior synthesize step with saveToFile ran in this plan
          // (on-demand build flow). Otherwise fail so recoverSkill can replan with the
          // full bootstrap (web.crawl → synthesize → skill.install).
          const hadPriorSynthesize = skillResults.some(r =>
            r.skill === 'synthesize' && r.ok && r.args?.saveToFile
          );
          if (!hadPriorSynthesize) {
            const errMsg = `Skill contract not found at ${skillPath}. The bootstrap plan must include web.crawl + synthesize steps before skill.install to create the skill.md file.`;
            logger.warn(`[Node:ExecuteCommand] skill.install: ${errMsg}`);
            if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: 'Install failed', error: errMsg });
            return {
              ...state,
              skillResults: [...skillResults, { step: skillCursor + 1, skill: 'skill.install', args, description, ok: false, error: errMsg }],
              skillCursor: skillCursor + 1,
              failedStep: { skill: 'skill.install', error: errMsg, stepIndex: skillCursor },
            };
          }

          // Prior synthesize ran but file is missing — auto-scaffold as fallback
          const inferredName = args.name || args.skillName ||
            (skillPath ? path.basename(path.dirname(skillPath)) : null) ||
            'unknown.skill';
          logger.info(`[Node:ExecuteCommand] skill.install: no file at ${skillPath || '(none)'} — auto-scaffolding contract for "${inferredName}"`);
          const scaffoldDir = path.join(os.homedir(), '.thinkdrop', 'skills', inferredName);
          const scaffoldFile = path.join(scaffoldDir, 'skill.md');
          contractMd = [
            '---',
            `name: ${inferredName}`,
            `description: ${args.description || inferredName + ' skill (auto-scaffolded)'}`,
            `exec_path: ~/.thinkdrop/skills/${inferredName}/index.cjs`,
            'exec_type: node',
            'version: 1.0.0',
            `trigger: ${inferredName}`,
            'schedule: on_demand',
            'secrets: ',
            '---',
            '',
            `# ${inferredName}`,
            '',
            args.description || `Auto-scaffolded skill. Replace this with the real implementation.`,
          ].join('\n');
          // Persist scaffold so future skill.install calls can load it
          fs.mkdirSync(scaffoldDir, { recursive: true });
          fs.writeFileSync(scaffoldFile, contractMd, 'utf8');
          logger.info(`[Node:ExecuteCommand] skill.install: scaffold written to ${scaffoldFile}`);
        }
      }

      // ── Pre-flight: validate + auto-patch skill.md before the HTTP call ─────
      // Mirrors skillRegistry.validateContract so errors are caught locally, with
      // clear fixes applied inline, rather than returned as an opaque HTTP 400.
      const REQUIRED_FM_FIELDS = ['name', 'description', 'exec_path', 'exec_type'];
      const VALID_EXEC_TYPES = new Set(['node', 'shell']);
      const SKILL_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
      {
        const fmPreflight = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmPreflight) {
          let fm = fmPreflight[1];
          const bodyAfterFm = contractMd.slice(fmPreflight[0].length);
          let patched = false;

          // 1. Missing description — derive from message or name
          if (!/^description\s*:/m.test(fm)) {
            const nameM = fm.match(/^name:\s*(.+)$/m);
            const derivedName = (nameM ? nameM[1].trim() : 'skill').replace(/\./g, ' ');
            fm += `\ndescription: ${derivedName} (auto-generated)`;
            patched = true;
            logger.info(`[Node:ExecuteCommand] skill.install pre-flight: injected missing description`);
          }

          // 2. exec_type missing or invalid
          const execTypeM = fm.match(/^exec_type\s*:\s*(.+)$/m);
          if (!execTypeM) {
            fm += `\nexec_type: shell`;
            patched = true;
            logger.info(`[Node:ExecuteCommand] skill.install pre-flight: injected missing exec_type`);
          } else if (!VALID_EXEC_TYPES.has(execTypeM[1].trim())) {
            fm = fm.replace(/^exec_type\s*:.+$/m, `exec_type: shell`);
            patched = true;
            logger.info(`[Node:ExecuteCommand] skill.install pre-flight: fixed invalid exec_type "${execTypeM[1].trim()}" → shell`);
          } else {
            // Cross-field consistency: exec_type: node requires a .cjs/.js exec_path, not .md
            const execPathInFm = fm.match(/^exec_path\s*:\s*(\S+)/m);
            if (execPathInFm && execTypeM[1].trim() === 'node' && /\.md$/i.test(execPathInFm[1].trim())) {
              fm = fm.replace(/^exec_type\s*:.+$/m, `exec_type: shell`);
              patched = true;
              logger.info(`[Node:ExecuteCommand] skill.install pre-flight: fixed exec_type node→shell for .md exec_path`);
            }
          }

          // 3. exec_path missing — derive from skillPath
          if (!/^exec_path\s*:/m.test(fm)) {
            const inferredDirName = skillPath ? path.basename(path.dirname(skillPath)) : null;
            if (inferredDirName) {
              fm += `\nexec_path: ~/.thinkdrop/skills/${inferredDirName}/skill.md`;
              patched = true;
              logger.info(`[Node:ExecuteCommand] skill.install pre-flight: injected missing exec_path for ${inferredDirName}`);
            }
          }

          // 4. Invalid skill name — fix hyphens, uppercase, digit-start segments
          const nameLineM = fm.match(/^name:\s*(.+)$/m);
          if (nameLineM) {
            const rawName = nameLineM[1].trim();
            if (!SKILL_NAME_RE.test(rawName)) {
              const fixed = rawName
                .toLowerCase()
                .replace(/[^a-z0-9.]/g, '.')
                .replace(/\.+/g, '.')
                .replace(/^\.|\.$/, '')
                .split('.')
                .filter(seg => seg.length > 0 && !/^\d/.test(seg))
                .join('.');
              const validFixed = SKILL_NAME_RE.test(fixed) ? fixed : null;
              if (validFixed) {
                fm = fm.replace(/^name:\s*.+$/m, `name: ${validFixed}`);
                patched = true;
                logger.info(`[Node:ExecuteCommand] skill.install pre-flight: fixed invalid name "${rawName}" → "${validFixed}"`);
              } else {
                const preflightErr = `skill.md has invalid name "${rawName}" and could not be auto-fixed. Must match /^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$/`;
                logger.warn(`[Node:ExecuteCommand] skill.install pre-flight: ${preflightErr}`);
                if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: 'Pre-flight failed', error: preflightErr });
                return {
                  ...state,
                  skillResults: [...skillResults, { step: skillCursor + 1, skill: 'skill.install', args, description, ok: false, error: preflightErr }],
                  skillCursor: skillCursor + 1,
                  failedStep: { skill: 'skill.install', step: skillCursor + 1, error: preflightErr, args, stderr: preflightErr },
                };
              }
            }
          }

          // 5. Any remaining missing required fields (catch-all after patches above)
          const stillMissing = REQUIRED_FM_FIELDS.filter(f => !new RegExp(`^${f}\\s*:`, 'm').test(fm));
          if (stillMissing.length > 0) {
            const preflightErr = `skill.md is missing required field(s): ${stillMissing.join(', ')}. Cannot install.`;
            logger.warn(`[Node:ExecuteCommand] skill.install pre-flight: ${preflightErr}`);
            if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'skill.install', description: 'Pre-flight failed', error: preflightErr });
            return {
              ...state,
              skillResults: [...skillResults, { step: skillCursor + 1, skill: 'skill.install', args, description, ok: false, error: preflightErr }],
              skillCursor: skillCursor + 1,
              failedStep: { skill: 'skill.install', step: skillCursor + 1, error: preflightErr, args, stderr: preflightErr },
            };
          }

          if (patched) {
            contractMd = `---\n${fm}\n---` + bodyAfterFm;
            // Write patched contract back to disk so it matches what we register
            try { if (skillPath && fs.existsSync(path.dirname(skillPath))) fs.writeFileSync(skillPath, contractMd, 'utf8'); } catch (_) {}
            logger.info(`[Node:ExecuteCommand] skill.install pre-flight: patched contract written`);
          }
        }
      }
      // ── End pre-flight ────────────────────────────────────────────────────────

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
      { name: 'screen.capture',    desc: 'Take a live screenshot + OCR — returns visible screen text. Use when user asks to save what\'s on screen or read current screen.' },
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
    const _isCachedStep = /^\[cached\]/i.test(description || '');
    if (_isCachedStep) {
      logger.info(`[Node:ExecuteCommand] synthesize [CACHED] — skipping live scrape, will use cross-turn context from conversation history`);
    } else {
      logger.debug(`[Node:ExecuteCommand] synthesize step — running LLM inline`);
    }
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'synthesize', description: description || 'Comparing results...' });

    // Gather all getPageText results from prior steps
    logger.debug(`[Node:ExecuteCommand] synthesize: skillResults has ${skillResults.length} entries`);
    skillResults.forEach((r, i) => {
      logger.debug(`[Node:ExecuteCommand]   [${i}] skill=${r.skill} action=${r.args?.action} ok=${r.ok} stdout_len=${r.stdout?.length ?? 'null'} result=${r.result ? String(r.result).substring(0, 80) : 'null'}`);
    });
    // Scope to results AFTER the last synthesize step so each synthesize in a
    // multi-stage pipeline (e.g. read email → synthesize → ask AI → synthesize → reply)
    // only sees the extraction results that belong to IT, not results from earlier stages.
    const lastSynthesizeStep = [...skillResults].reduceRight(
      (found, r) => found || (r.skill === 'synthesize' ? r.step : 0), 0
    );
    logger.debug(`[Node:ExecuteCommand] synthesize: scoping to results after step ${lastSynthesizeStep} (last synthesize)`);
    const pageTextResults = skillResults
      .filter(r => (
        (r.skill === 'browser.act' && (r.args?.action === 'getPageText' || r.args?.action === 'waitForStableText')) ||
        (r.skill === 'browser.agent' && r.result && typeof r.result === 'string' && r.result.trim().length > 50 && !r.result.startsWith('Completed:'))
      ) && r.ok && r.result && typeof r.result === 'string' && r.result.trim().length > 0
        && r.step > lastSynthesizeStep)
      .map(r => {
        const analysis = analyzePageContent(r.result, r.url, r.args?.agentId);
        let processedText = r.result;
        
        // If we have UI chrome but also real content, add clarifying note
        if (analysis.uiChromeDetected && analysis.hasContent) {
          processedText = `[PAGE NOTE: Navigation UI detected at start, but ${analysis.contentScore} content sections found below. Extract substantive content.]\n\n${r.result}`;
        }
        
        // If auth wall detected AND no real content, mark clearly as login-blocked
        // If authWallDetected but hasContent is true, the page loaded nav/sign-in chrome
        // alongside the actual AI response — treat as UI chrome, not a true block.
        if (analysis.authWallDetected && !analysis.hasContent) {
          processedText = `[AUTH WALL: Login required]\n\n${r.result}`;
        } else if (analysis.authWallDetected && analysis.hasContent) {
          processedText = `[PAGE NOTE: Sign-in nav detected but page has content below. Extract substantive content.]\n\n${r.result}`;
        }
        
        return { 
          source: r.args?.sessionId || r.args?.agentId || 'browser.agent', 
          url: r.url || '', 
          text: processedText,
          _analysis: analysis // for debugging
        };
      });
    logger.debug(`[Node:ExecuteCommand] synthesize: found ${pageTextResults.length} getPageText/waitForStableText results`);
    const skippedStepNotes = skillResults
      .filter(r => r.skipped && r.skipReason && r.step > lastSynthesizeStep)
      .map(r => `- Step ${r.step} (${r.description || r.skill}): ${r.skipReason}`);

    // Include shell.run stdout (e.g. cat file output) as well as browser getPageText results
    const shellStdoutResults = skillResults
      .filter(r => r.skill === 'shell.run' && r.ok && r.stdout && r.stdout.trim().length > 0)
      .map(r => `=== Shell output (${r.description || r.args?.cmd || 'shell.run'}) ===\n${r.stdout}`);

    // ── Full-fidelity API response handling ──────────────────────────────────
    // Never truncate — write every large JSON response to ~/.thinkdrop/tmp/ in
    // full so no data is ever lost. Then use a size-gated strategy for context:
    //   Small  (<  5K): use raw string — no processing needed
    //   Medium (5K–60K): field-prune in JS to strip universal noise fields
    //   Large  (> 60K): write to disk, preview first 50 items here, then run
    //                   an async chunk+filter LLM pass inside if(llmBackend)
    const _synthFs   = require('fs');
    const _synthPath = require('path');
    const _synthOs   = require('os');
    const _apiTmpDir = _synthPath.join(_synthOs.homedir(), '.thinkdrop', 'tmp');

    // Ensure tmp dir exists
    try { if (!_synthFs.existsSync(_apiTmpDir)) _synthFs.mkdirSync(_apiTmpDir, { recursive: true }); } catch (_) {}

    // Lazy cleanup: remove api-*, raw-*, payload-*.json files older than 30 minutes on each run
    try {
      const _ttlCutoff = Date.now() - 30 * 60 * 1000;
      _synthFs.readdirSync(_apiTmpDir)
        .filter(f => (f.startsWith('api-') || f.startsWith('raw-') || f.startsWith('payload-')) && f.endsWith('.json'))
        .forEach(f => {
          try {
            const _fp = _synthPath.join(_apiTmpDir, f);
            if (_synthFs.statSync(_fp).mtimeMs < _ttlCutoff) {
              _synthFs.unlinkSync(_fp);
              logger.debug(`[synthesize] tmp cleanup: deleted ${f}`);
            }
          } catch (_) {}
        });
    } catch (_e) { logger.warn('[synthesize] tmp cleanup error:', _e.message); }

    // Recursively strip universally noisy API metadata fields + overly-long strings
    const _PRUNED_FIELDS = new Set([
      'etag', 'kind', 'iCalUID', 'htmlLink', 'selfLink', 'calendarId',
      'recurringEventId', 'originalStartTime', 'visibility', 'guestsCanInviteOthers',
      'guestsCanModify', 'guestsCanSeeOtherGuests', 'reminders', 'eventType',
      'sequence', 'created', 'updated', 'creator', 'organizer',
      'conferenceData', 'extendedProperties',
    ]);
    const _KEEP_LONG_FIELDS = new Set([
      'summary', 'title', 'description', 'body', 'name',
      'displayName', 'text', 'content', 'subject', 'message',
    ]);
    function _pruneApiObject(obj) {
      if (Array.isArray(obj)) return obj.map(_pruneApiObject);
      if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (_PRUNED_FIELDS.has(k)) continue;
          if (typeof v === 'string' && v.length > 400 && !_KEEP_LONG_FIELDS.has(k)) continue;
          out[k] = _pruneApiObject(v);
        }
        return out;
      }
      return obj;
    }

    const _SMALL_THRESHOLD  =  5000; // < 5K: use raw
    const _MEDIUM_THRESHOLD = 60000; // 5K–60K: field prune; > 60K: chunk+filter
    const _CHUNK_PAGE_SIZE  =    50; // items per LLM filter page

    // Populated below for large responses — consumed in the if(llmBackend) block
    const _shellTmpFiles = [];

    // Helper: extract the primary items array from a plain array or wrapped object
    function _extractItemsArray(p) {
      if (Array.isArray(p)) return p;
      const k = Object.keys(p).find(key => Array.isArray(p[key]) && p[key].length > 0);
      return k ? p[k] : null;
    }

    const processedShellResults = shellStdoutResults.map(s => {
      const headerMatch = s.match(/^(=== Shell output[^\n]*\n)([\s\S]*)$/);
      if (!headerMatch) return s;
      const header = headerMatch[1];
      const body   = headerMatch[2].trim();

      if (!body.startsWith('[') && !body.startsWith('{')) return s; // not JSON

      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { return s; }

      const rawSize = body.length;

      // Write full response to disk for any non-trivial JSON (zero data loss)
      let tmpFilePath = null;
      if (rawSize > _SMALL_THRESHOLD) {
        try {
          const rawSlug = (header.match(/\(([^)]+)\)/) || ['', 'api'])[1]
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
          tmpFilePath = _synthPath.join(_apiTmpDir, `api-${rawSlug}-${Date.now()}.json`);
          _synthFs.writeFileSync(tmpFilePath, body, 'utf8');
          logger.debug(`[synthesize] wrote API response (${rawSize} chars) → ${tmpFilePath}`);
        } catch (e) { logger.warn('[synthesize] tmp write failed:', e.message); }
      }

      if (rawSize <= _SMALL_THRESHOLD) return s; // Small: use raw, no processing

      if (rawSize <= _MEDIUM_THRESHOLD) {
        // Medium: field-prune in JS — keeps all items, just removes metadata fat
        try {
          const pruned    = _pruneApiObject(parsed);
          const prunedStr = JSON.stringify(pruned, null, 2);
          logger.debug(`[synthesize] field-pruned: ${rawSize} → ${prunedStr.length} chars`);
          return header + prunedStr;
        } catch (_) { return s; }
      }

      // Large: preview first 50 pruned items now; schedule remaining for async chunk+filter
      const items = _extractItemsArray(parsed);
      if (items && items.length > 0) {
        const totalItems = items.length;
        const preview    = _pruneApiObject(items.slice(0, _CHUNK_PAGE_SIZE));
        const previewStr = JSON.stringify(preview, null, 2);
        if (totalItems > _CHUNK_PAGE_SIZE && tmpFilePath) {
          _shellTmpFiles.push({ path: tmpFilePath, parsed, header, totalItems });
        }
        const note = totalItems > _CHUNK_PAGE_SIZE
          ? `\n\n// Large response: ${totalItems} items total — previewing first ${_CHUNK_PAGE_SIZE}; additional relevant items injected via chunk+filter pass below`
          : '';
        return header + previewStr + note;
      }

      // Large non-array object: field-prune best-effort
      try {
        return header + JSON.stringify(_pruneApiObject(parsed), null, 2);
      } catch (_) { return s; }
    });

    // Include web.crawl results — the crawled page content is essential for
    // synthesize steps that generate skill.md from API documentation
    const webCrawlResults = skillResults
      .filter(r => r.skill === 'web.crawl' && r.ok && r.stdout && r.stdout.trim().length > 0)
      .map(r => `=== Crawled page (${r.url || r.args?.url || 'web.crawl'}) ===\n${r.stdout}`);

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

    // Include user.agent results — resolve_context/resolve_form return summary + resolved data
    const userAgentResults = skillResults
      .filter(r => r.skill === 'user.agent' && r.ok && (r.result?.summary || r.result?.resolved || r.summary || r.resolved))
      .map(r => {
        const summary = r.result?.summary || r.summary || '';
        const resolved = r.result?.resolved || r.resolved || {};
        // Build context from summary + key resolved fields
        const parts = [];
        if (summary) parts.push(summary);
        // Add specific resolved data sections for richer context
        if (resolved.self && Object.keys(resolved.self).length > 0) {
          parts.push('User Profile:\n' + Object.entries(resolved.self)
            .map(([k, v]) => `  ${k}: ${v}`).join('\n'));
        }
        if (resolved.contacts && Object.keys(resolved.contacts).length > 0) {
          for (const [label, fields] of Object.entries(resolved.contacts)) {
            parts.push(`Contact — ${label}:\n` + Object.entries(fields)
              .map(([k, v]) => `  ${k}: ${v}`).join('\n'));
          }
        }
        if (resolved.memories?.length > 0) {
          parts.push('Memories:\n' + resolved.memories.slice(0, 5).map(m => `  • ${m.slice(0, 200)}`).join('\n'));
        }
        return `=== User Context (from ${r.action || 'user.agent'}) ===\n${parts.join('\n\n')}`;
      });

    // Include cli.agent results — CLI automation stdout
    const cliAgentResults = skillResults
      .filter(r => r.skill === 'cli.agent' && r.ok && r.stdout)
      .map(r => `=== CLI Output (${r.args?.agentId || r.args?.cli || 'cli.agent'}) ===\n${r.stdout}`);

    // Include playwright.agent results — browser automation final result
    const playwrightAgentResults = skillResults
      .filter(r => r.skill === 'playwright.agent' && r.ok && r.result)
      .map(r => `=== Browser Automation (${r.args?.goal?.slice(0, 60) || 'playwright.agent'}) ===\n${r.result}`);

    // Include web.agent results — web search results
    const webAgentResults = skillResults
      .filter(r => r.skill === 'web.agent' && r.ok && r.results)
      .map(r => `=== Web Search Results ===\n${r.results.map((res, i) => `${i+1}. ${res.title || res.url}\n   ${res.snippet || ''}`).join('\n\n')}`);

    // Include video.agent results — video transcript/content
    const videoAgentResults = skillResults
      .filter(r => r.skill === 'video.agent' && r.ok && r.stdout)
      .map(r => `=== Video Content (${r.args?.videoUrl || 'video.agent'}) ===\n${r.stdout}`);

    // Include screen.capture results — screen OCR text
    const screenCaptureResults = skillResults
      .filter(r => r.skill === 'screen.capture' && r.success && r.text)
      .map(r => `=== Screen Capture (${r.appName || 'OCR'}) ===\n${r.text}`);

    // Include file.watch results — file watch events
    const fileWatchResults = skillResults
      .filter(r => r.skill === 'file.watch' && r.ok && (r.events || r.matches))
      .map(r => `=== File Watch Events ===\n${(r.events || r.matches || []).join('\n')}`);

    // Include system.introspect results — system information (agents, skills, databases)
    const systemIntrospectResults = skillResults
      .filter(r => r.skill === 'system.introspect' && r.ok && r.result)
      .map(r => `=== System Information (${r.args?.query || 'introspect'}) ===\n${JSON.stringify(r.result, null, 2)}`);

    // Include external.skill results — external skill execution output
    const externalSkillResults = skillResults
      .filter(r => r.skill === 'external.skill' && r.ok && r.output)
      .map(r => `=== External Skill (${r.skillName || 'external'}) ===\n${r.output}`);

    const allContextParts = [
      ...pageTextResults.map(p => `=== Source: ${p.url || p.source} ===\n${p.text}`),
      ...processedShellResults,
      ...webCrawlResults,
      ...fileBridgeResults,
      ...fsReadResults,
      ...imageAnalyzeResults,
      ...userAgentResults,
      ...cliAgentResults,
      ...playwrightAgentResults,
      ...webAgentResults,
      ...videoAgentResults,
      ...screenCaptureResults,
      ...fileWatchResults,
      ...systemIntrospectResults,
      ...externalSkillResults,
    ];

    // ── Prior synthesize results as fallback context ─────────────────────────
    // When a downstream synthesize step (e.g. "write email comparing prices") finds
    // no raw page-text results in its scope (because scraping happened before the
    // previous synthesize), inject the prior synthesize output(s) as context so the
    // LLM has the actual data instead of producing an apology.
    // Only fires when allContextParts is empty to avoid double-counting.
    if (allContextParts.length === 0) {
      const priorSynthResults = skillResults
        .filter(r => r.skill === 'synthesize' && r.ok && r.result && typeof r.result === 'string' && r.result.trim().length > 50 && r.step < skillCursor + 1)
        .map(r => `=== Prior Analysis (step ${r.step}) ===\n${r.result.trim()}`);
      if (priorSynthResults.length > 0) {
        allContextParts.push(...priorSynthResults);
        logger.info(`[Node:ExecuteCommand] synthesize: no fresh page-text — injecting ${priorSynthResults.length} prior synthesize result(s) as context`);
      }
    }

    // If no within-run context, check conversationHistory for prior image.analyze / skill output
    // This handles cross-turn synthesis: "put this in a text document" after a previous analysis run.
    // GUARD: Do NOT fall back to conversation history when the current run has browser/agent results
    // that simply weren't captured by the filters above — prevents cross-turn context pollution
    // (e.g. BibleGateway results leaking into a DuckDuckGo synthesis after recovery replan).
    const conversationHistory = state.conversationHistory || [];
    const hasBrowserResults = skillResults.some(r =>
      (r.skill === 'browser.act' || r.skill === 'browser.agent') && r.ok && r.step > lastSynthesizeStep
    );
    let crossTurnContext = '';
    if (allContextParts.length === 0 && !hasBrowserResults && conversationHistory.length > 0) {
      // Find the most recent assistant message that contains step outputs
      const recentOutputMsg = [...conversationHistory].reverse()
        .find(m => m.role === 'assistant' && m.content && m.content.includes('Step outputs:'));
      if (recentOutputMsg) {
        crossTurnContext = recentOutputMsg.content;
        logger.debug(`[Node:ExecuteCommand] synthesize: using cross-turn context from conversation history (${crossTurnContext.length} chars)`);
      }
    }

    const _rawSynthesisContext = allContextParts.length > 0
      ? allContextParts.join('\n\n')
      : crossTurnContext || skillResults.filter(r => r.ok && (r.result || r.stdout)).map(r => String(r.result || r.stdout)).join('\n\n');
    // Cap context to ~60k chars (~15k tokens) to prevent LLM context overflow on large fs.read/explore results.
    // Trim from the middle so we keep the directory tree (start) and most recent file content (end).
    const _SYNTH_CTX_LIMIT = 60000;
    // Note: kept as `let` so the chunk+filter pass below can append filtered items
    let synthesisContext = _rawSynthesisContext.length > _SYNTH_CTX_LIMIT
      ? (() => {
          const half = Math.floor(_SYNTH_CTX_LIMIT / 2);
          const trimmed = _rawSynthesisContext.slice(0, half) + '\n\n[... content truncated for length ...]\n\n' + _rawSynthesisContext.slice(_rawSynthesisContext.length - half);
          logger.warn(`[Node:ExecuteCommand] synthesize: context truncated from ${_rawSynthesisContext.length} → ${trimmed.length} chars`);
          return trimmed;
        })()
      : _rawSynthesisContext;

    const synthesisPrompt = args.prompt || description || 'Compare and summarize the results from each source.';
    const skippedStepsNote = skippedStepNotes.length > 0
      ? `\n\nNOTE — The following steps were skipped because the service was unavailable or not ready:\n${skippedStepNotes.join('\n')}\nPlease acknowledge these gaps in the summary.`
      : '';
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

    // NOTE: Do NOT auto-assign synthesisFilePath from a prior find/mdfind step stdout.
    // That would silently overwrite the found file with synthesis output (e.g. overwriting cheese.txt
    // with an analysis summary). saveToFile must always be explicitly set in the synthesize step args.

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
      const _editKeywords = /\b(edit|modify|update|change|replace|rewrite|add|remove|delete|insert|append|fix|correct|rename|move|sort|format|clean up)\b/i;
      const isFileEdit = hasFileContent && _editKeywords.test(synthesisPrompt);
      // Detect when shell output is raw JSON from an API call (e.g. GitHub REST API, curl)
      // — needs different synthesis instructions than plain file content
      const _isJsonShellOutput = shellStdoutResults.some(s => /=== Shell output[^\n]*\n\s*[\[{]/.test(s));

      // ── User question — used by chunk+filter pass and synthesis prompt ────
      const _userQuestion = state.originalMessage || state.resolvedMessage || state.message || synthesisPrompt;

      // ── Chunk+filter pass for large API responses (> 60K) ─────────────────
      // Pages through items that didn't fit in the initial 50-item preview and
      // asks the LLM (fast mode) which ones are relevant to the user's question.
      // Only runs when _shellTmpFiles was populated in the processedShellResults pass.
      if (_shellTmpFiles.length > 0) {
        for (const { parsed, header, totalItems } of _shellTmpFiles) {
          const items = _extractItemsArray(parsed);
          if (!items) continue;
          const _relevantItems = [];
          // Start from _CHUNK_PAGE_SIZE — the first page is already in the preview
          for (let _ci = _CHUNK_PAGE_SIZE; _ci < items.length; _ci += _CHUNK_PAGE_SIZE) {
            const page      = items.slice(_ci, _ci + _CHUNK_PAGE_SIZE);
            const prunedPg  = _pruneApiObject(page);
            const filterPmt = `The user asked: "${_userQuestion}"\n\nBelow are ${page.length} items (items ${_ci}–${_ci + page.length - 1} of ${totalItems} total) from an API response. Return ONLY the JSON array of items from this page that are relevant to the user's question. If none are relevant return []. Output ONLY valid JSON, no explanation.\n\n${JSON.stringify(prunedPg, null, 2)}`;
            try {
              const filterResult = await llmBackend.generateAnswer(filterPmt, {
                query: filterPmt,
                context: { conversationHistory: [], systemInstructions: 'You are a JSON filter. Output only a valid JSON array, no explanation.', intent: 'command_automate' },
                options: { maxTokens: 2000, temperature: 0, fastMode: true }
              }, { maxTokens: 2000, temperature: 0, fastMode: true }, null);
              const jMatch = filterResult.match(/\[[\s\S]*\]/);
              if (jMatch) _relevantItems.push(...JSON.parse(jMatch[0]));
            } catch (e) {
              logger.warn(`[synthesize] chunk+filter page ${_ci} failed:`, e.message);
              _relevantItems.push(...prunedPg); // fallback: include all on error
            }
          }
          if (_relevantItems.length > 0) {
            const filteredStr = JSON.stringify(_relevantItems, null, 2);
            synthesisContext += `\n\n${header}(Chunk+filter pass — ${_relevantItems.length} additional relevant items from ${totalItems} total)\n${filteredStr}`;
            logger.debug(`[synthesize] chunk+filter: appended ${_relevantItems.length} relevant items to context`);
          }
        }
      }

      const synthesisQuery = hasFileContent
        ? `${synthesisPrompt}${skippedStepsNote}\n\nHere is the current file content:\n\n${synthesisContext}`
        : `${synthesisPrompt}${skippedStepsNote}\n\nHere is the content collected from each source:\n\n${synthesisContext}`;
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
      const synthesisInstructions = (isFileEdit
        ? `You are a file editing assistant. The user has asked you to modify a file. You have been given the current file content. Your job is to output the COMPLETE updated file content with ONLY the requested changes applied. Output the full file text only — no preamble, no explanation, no markdown code fences, no commentary. Preserve all existing structure, headings, and formatting. Only change what was explicitly requested.`
        : _isJsonShellOutput
        ? `You are a technical analyst. You have been given data returned by a shell command or API call.\n\nThe user asked: "${_userQuestion}"\n\nAnswer their specific question directly and concisely using ONLY the relevant data. Format output in markdown — use bold for names/titles, bullet points for lists, and human-readable dates (e.g. "Monday, Jan 20 at 3:00 PM"). Skip internal IDs, raw URLs, and low-level metadata unless the user explicitly asked for them. Do NOT output raw JSON or JSON field names verbatim.`
        : hasFileContent
        ? `You are a document analyst. The user has asked you to analyze, summarize, or explain the contents of one or more files. You have been given the raw file content. Your job is to provide a clear, well-structured explanation of what the file(s) contain — describe the purpose, key information, structure, and any notable details. Do NOT just repeat or list the raw content. Write in plain prose with headings where helpful. Be concise and informative.`
        : hasImageAnalysis
        ? `You are a report writer. The user has analyzed a folder of images/screenshots and wants a summary. You have been given the vision AI analysis of each image. Write a clear, structured report using ONLY the actual file names and descriptions provided — do NOT invent or guess file names, sizes, or content. Use the exact file path from each "Image analysis: <path>" heading as the file name.`
        : `You are a research assistant. The user asked you to compare or summarize information from multiple websites. You have been given the text content from each site. Provide a clear, structured comparison or summary that directly answers the user's request. Use headings for each source if comparing. Be concise and factual. Never ask the user for clarification or additional information — produce the best-effort response using only the provided content. Do not output a question as your answer.

⚠️ ANTI-HALLUCINATION RULE: If the content from a source clearly shows a login page, sign-in form, or authentication wall (e.g. it contains phrases like "Sign in", "Log in", "Create account", "Welcome back" with minimal substantive content), you MUST explicitly state that [service] required login and could not be queried. Do NOT use your internal training knowledge to invent or simulate what that service would have said — only report from actual scraped content. A fabricated AI response is worse than an honest "login required" note.`) + _synthLangSuffix;
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
        // Always generate silently first (pass null for streamCallback) so we can
        // inspect the answer before streaming. Streaming the apology text to the UI
        // and then correcting it on retry causes the Summary panel to show "I apologize"
        // even when the retry succeeds. We stream the final confirmed answer below.
        synthesisAnswer = await llmBackend.generateAnswer(synthesisQuery, synthPayload, synthPayload.options, null);
        logger.debug(`[Node:ExecuteCommand] synthesize: LLM answer generated (${synthesisAnswer.length} chars)`);
      } catch (err) {
        logger.error('[Node:ExecuteCommand] synthesize LLM call failed:', err.message);
        synthesisAnswer = `[Synthesis failed: ${err.message}]`;
      }

      // ── Apology / refusal fallback: retry then pretty-print raw JSON ────────
      // When the LLM returns a refusal or apology instead of a summary, first
      // retry with a simpler direct prompt. Only fall back to raw JSON if the
      // retry also fails/apologises.
      const _APOLOGY_RE = /^(i apologize|i'm sorry|i'm unable|i cannot|i was unable|unfortunately,|i am sorry|i am unable)/i;
      if (_APOLOGY_RE.test(synthesisAnswer.trim())) {
        logger.warn('[Node:ExecuteCommand] synthesize: LLM returned apology — retrying with simplified prompt');
        let _retrySucceeded = false;
        try {
          const _retrySysInstr = `You are a helpful assistant. The user asked: "${_userQuestion}". Use the data below to answer directly in plain text with markdown formatting. Do not apologise or refuse.`;
          const _retryQuery = `${_userQuestion}\n\nData:\n${synthesisContext.slice(0, 6000)}`;
          const _retryAnswer = await llmBackend.generateAnswer(_retryQuery, {
            query: _retryQuery,
            context: { conversationHistory: [], systemInstructions: _retrySysInstr, intent: 'command_automate' },
            options: { maxTokens: 1500, temperature: 0.3, fastMode: false },
          }, { maxTokens: 1500, temperature: 0.3 }, null);
          if (_retryAnswer && !_APOLOGY_RE.test(_retryAnswer.trim())) {
            synthesisAnswer = _retryAnswer;
            _retrySucceeded = true;
            logger.info('[Node:ExecuteCommand] synthesize: retry succeeded');
          } else {
            logger.warn('[Node:ExecuteCommand] synthesize: retry also returned apology — falling back to pretty-printed JSON');
          }
        } catch (_retryErr) {
          logger.warn('[Node:ExecuteCommand] synthesize retry failed:', _retryErr.message);
        }

        if (!_retrySucceeded) {
          const _jsonResult = skillResults.find(
            r => r.skill === 'shell.run' && r.ok && r.stdout && /^\s*[\[{]/.test(r.stdout.trim())
          );
          if (_jsonResult) {
            try {
              const _parsedJson = JSON.parse(_jsonResult.stdout.trim());
              // Prune noise fields for readability
              const _prettyJson = JSON.stringify(_pruneApiObject(_parsedJson), null, 2);
              // Write to a named temp file the user can open
              const _rawSlug = (_jsonResult.description || _jsonResult.skill || 'api')
                .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
              const _jsonTmpPath = require('path').join(require('os').homedir(), '.thinkdrop', 'tmp', `raw-${_rawSlug}-${Date.now()}.json`);
              try {
                require('fs').mkdirSync(require('path').dirname(_jsonTmpPath), { recursive: true });
                require('fs').writeFileSync(_jsonTmpPath, _prettyJson, 'utf8');
                logger.info(`[Node:ExecuteCommand] synthesize: raw JSON saved to ${_jsonTmpPath}`);
              } catch (_) {}
              synthesisAnswer = `Here is the raw data returned — the summary could not be generated:\n\n\`\`\`json\n${_prettyJson.slice(0, 12000)}${_prettyJson.length > 12000 ? '\n// ... truncated' : ''}\n\`\`\`${_jsonTmpPath ? `\n\n📄 Full JSON saved to: \`${_jsonTmpPath}\`` : ''}`;
            } catch (_parseErr) {
              // Not valid JSON — just show raw stdout
              synthesisAnswer = `Here is the raw output:\n\n\`\`\`\n${_jsonResult.stdout.slice(0, 8000)}\n\`\`\``;
            }
          }
        } // end if (!_retrySucceeded)
      }

      // ── Stream the final confirmed answer ─────────────────────────────────
      // We deliberately held back the streamCallback above to avoid streaming
      // an apology that the retry then corrects. Now that synthesisAnswer is final,
      // stream it unconditionally (whether it came from the initial call or the retry).
      if (typeof streamCallback === 'function' && synthesisAnswer && !synthesisAnswer.startsWith('[Synthesis')) {
        streamCallback(synthesisAnswer);
      }
    } else {
      logger.warn('[Node:ExecuteCommand] synthesize: no llmBackend in state — skipping LLM call');
    }

    const fs = require('fs');
    const path = require('path');

    // Write to explicit saveToFile if requested
    if (synthesisFilePath && synthesisAnswer && !synthesisAnswer.startsWith('[')) {
      try {
        // Auto-create missing parent directories — LLM may generate paths like ~/temp/ that don't exist
        const parentDir = path.dirname(synthesisFilePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
          logger.debug(`[Node:ExecuteCommand] synthesize: created directory ${parentDir}`);
        }
        // Strip internal === Shell output (...) === markers that executeCommand injects for LLM context
        // but must never appear in saved files (e.g. skill.md contracts, text files, etc.)
        let cleanedAnswer = synthesisAnswer.replace(/^=== Shell output \(.*?\) ===\s*/gm, '').trim();
        // Strip outer markdown fences — LLM often wraps skill.md in ```yaml/```markdown/``` blocks.
        // skill.install rejects any file that doesn't start with '---' (YAML frontmatter).
        // IMPORTANT: match only the OUTERMOST wrapping fence, not inner ```bash blocks inside ## Commands.
        // Strategy: if the entire string starts with ``` and ends with ```, strip only those two lines.
        cleanedAnswer = cleanedAnswer.replace(/^```[a-zA-Z]*\r?\n([\s\S]*)\n```\s*$/, '$1').trim();

        // ── Inline skill.md repair agent ─────────────────────────────────────
        // If the target file is a skill contract (skill.md), validate and repair
        // it before writing to disk. This prevents skill.install SKILL_INSTALL_FAILED
        // without needing a full recoverSkill → evaluateSkills → replan loop.
        // Checks: frontmatter exists, required fields present, no wrapping fences remain.
        if (synthesisFilePath.endsWith('skill.md') && llmBackend) {
          const repairContext = {
            skillName: path.basename(path.dirname(synthesisFilePath)),
            crawledDocs: webCrawlResults.join('\n\n'),
            userMessage: state.message || state.originalMessage || '',
          };
          cleanedAnswer = await _repairSkillMd(cleanedAnswer, llmBackend, logger, synthesisFilePath, repairContext);
        }

        // ── Format dispatch ──────────────────────────────────────────────────
        // Route to the right conversion engine based on target extension.
        // Supported rich formats: .pdf .docx .pptx .xlsx .html .epub .rtf .odt
        // Plain/data formats (.csv .md .txt .json and anything else) → write as-is.
        const { execSync: _execSync } = require('child_process');
        const _fmtExt = path.extname(synthesisFilePath).toLowerCase();
        const _tmpMdPath = path.join(os.tmpdir(), `thinkdrop_synthesis_${Date.now()}.md`);
        // Helper: try a shell command, return true on success
        const _tryCmd = (cmd, timeoutMs = 30000) => {
          try { _execSync(`${cmd} 2>&1`, { timeout: timeoutMs }); return true; }
          catch (_) { return false; }
        };
        // One-time pandoc availability check — warn early so user knows to install
        let _pandocAvailable;
        try { _execSync('which pandoc 2>&1', { timeout: 3000 }); _pandocAvailable = true; }
        catch (_) { _pandocAvailable = false; }
        if (!_pandocAvailable && ['.pdf', '.docx', '.pptx', '.epub', '.rtf', '.odt', '.html'].includes(_fmtExt)) {
          logger.warn(`[Node:ExecuteCommand] synthesize: pandoc not installed — ${_fmtExt} will use Node.js fallback. Install with: brew install pandoc`);
        }
        // Strip markdown syntax for plain-text rendering in Node.js fallbacks
        const _plainText = cleanedAnswer
          .replace(/#{1,6}\s?/g, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/^[-*+]\s/gm, '  • ');
        // Format registry — each entry is an async function(tmpMd, outPath) → boolean (success)
        const _FORMAT_HANDLERS = {
          '.pdf': async (src, out) => {
            // Write markdown to temp file, try pandoc engines, then AppleScript
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            for (const _engine of ['wkhtmltopdf', 'pdflatex', 'weasyprint', '']) {
              const _flag = _engine ? `--pdf-engine=${_engine} ` : '';
              if (_tryCmd(`pandoc "${src}" -o "${out}" ${_flag}--standalone`)) {
                logger.debug(`[Node:ExecuteCommand] synthesize: PDF written via pandoc${_engine ? `+${_engine}` : ''} → ${out}`);
                return true;
              }
            }
            // AppleScript Print-to-PDF fallback (macOS only)
            const _htmlPath = src.replace(/\.md$/, '.html');
            if (_tryCmd(`pandoc "${src}" -o "${_htmlPath}" --standalone`, 15000)) {
              const _as = `set htmlFile to POSIX file "${_htmlPath}"\nset pdfOut to POSIX file "${out}"\ntell application "Safari"\nactivate\nopen htmlFile\ndelay 2\nprint with properties {target printer:"PDF", job disposition:"save", save path:pdfOut}\nend tell`;
              if (_tryCmd(`osascript -e '${_as.replace(/'/g, "'\\''")}' `, 45000)) {
                logger.debug(`[Node:ExecuteCommand] synthesize: PDF written via AppleScript → ${out}`);
                return true;
              }
            }
            // pdfkit Node.js fallback — zero system dependencies
            try {
              const PDFDocument = require('pdfkit');
              await new Promise((resolve, reject) => {
                const _doc = new PDFDocument({ margin: 50 });
                const _chunks = [];
                _doc.on('data', c => _chunks.push(c));
                _doc.on('end', () => {
                  try { fs.writeFileSync(out, Buffer.concat(_chunks)); resolve(); }
                  catch (we) { reject(we); }
                });
                _doc.on('error', reject);
                _doc.fontSize(12).text(_plainText, { paragraphGap: 6, lineGap: 2 });
                _doc.end();
              });
              logger.info(`[Node:ExecuteCommand] synthesize: PDF written via pdfkit fallback → ${out}`);
              return true;
            } catch (_pdfkitErr) {
              logger.warn(`[Node:ExecuteCommand] synthesize: pdfkit fallback failed: ${_pdfkitErr.message}`);
            }
            return false;
          },
          '.docx': async (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            if (_tryCmd(`pandoc "${src}" -o "${out}" --standalone`)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: DOCX written via pandoc → ${out}`);
              return true;
            }
            // docx npm package fallback — pure JS, no binary needed
            try {
              const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
              const _paras = cleanedAnswer.split('\n').map(line => {
                const _headMatch = line.match(/^(#{1,6})\s+(.+)$/);
                if (_headMatch) {
                  const _lvl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
                    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][_headMatch[1].length - 1];
                  return new Paragraph({ heading: _lvl, children: [new TextRun(_headMatch[2])] });
                }
                if (line.trim() === '') return new Paragraph({ children: [new TextRun('')] });
                return new Paragraph({ children: [new TextRun(line.replace(/^[-*+]\s/, ''))] });
              });
              const _wordDoc = new Document({ sections: [{ children: _paras }] });
              const _buf = await Packer.toBuffer(_wordDoc);
              fs.writeFileSync(out, _buf);
              logger.info(`[Node:ExecuteCommand] synthesize: DOCX written via docx fallback → ${out}`);
              return true;
            } catch (_docxErr) {
              logger.warn(`[Node:ExecuteCommand] synthesize: docx fallback failed: ${_docxErr.message}`);
            }
            return false;
          },
          '.pptx': (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            // pandoc → pptx (requires reference pptx, attempt anyway)
            if (_tryCmd(`pandoc "${src}" -o "${out}" --standalone`)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: PPTX written via pandoc → ${out}`);
              return true;
            }
            // LibreOffice fallback
            const _tmpOdpPath = src.replace(/\.md$/, '.odp');
            if (_tryCmd(`pandoc "${src}" -o "${_tmpOdpPath}" --standalone`) &&
                _tryCmd(`soffice --headless --convert-to pptx "${_tmpOdpPath}" --outdir "${path.dirname(out)}"`, 60000)) {
              // soffice writes <name>.pptx alongside the source; rename if needed
              const _sofficeOut = path.join(path.dirname(out), path.basename(_tmpOdpPath, '.odp') + '.pptx');
              if (_sofficeOut !== out) { try { fs.renameSync(_sofficeOut, out); } catch (_) {} }
              logger.debug(`[Node:ExecuteCommand] synthesize: PPTX written via LibreOffice → ${out}`);
              return true;
            }
            return false;
          },
          '.xlsx': (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            // ssconvert (Gnumeric) can convert CSV → xlsx
            const _csvPath = src.replace(/\.md$/, '.csv');
            fs.writeFileSync(_csvPath, cleanedAnswer, 'utf8');
            if (_tryCmd(`ssconvert "${_csvPath}" "${out}"`, 30000)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: XLSX written via ssconvert → ${out}`);
              return true;
            }
            if (_tryCmd(`soffice --headless --convert-to xlsx "${_csvPath}" --outdir "${path.dirname(out)}"`, 60000)) {
              const _sofficeOut = path.join(path.dirname(out), path.basename(_csvPath, '.csv') + '.xlsx');
              if (_sofficeOut !== out) { try { fs.renameSync(_sofficeOut, out); } catch (_) {} }
              logger.debug(`[Node:ExecuteCommand] synthesize: XLSX written via LibreOffice → ${out}`);
              return true;
            }
            return false;
          },
          '.html': (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            if (_tryCmd(`pandoc "${src}" -o "${out}" --to=html5 --standalone`)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: HTML written via pandoc → ${out}`);
              return true;
            }
            return false;
          },
          '.epub': (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            if (_tryCmd(`pandoc "${src}" -o "${out}" --standalone`)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: EPUB written via pandoc → ${out}`);
              return true;
            }
            return false;
          },
          '.rtf': (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            if (_tryCmd(`pandoc "${src}" -o "${out}" --standalone`)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: RTF written via pandoc → ${out}`);
              return true;
            }
            return false;
          },
          '.odt': (src, out) => {
            fs.writeFileSync(src, cleanedAnswer, 'utf8');
            if (_tryCmd(`pandoc "${src}" -o "${out}" --standalone`)) {
              logger.debug(`[Node:ExecuteCommand] synthesize: ODT written via pandoc → ${out}`);
              return true;
            }
            return false;
          },
        };

        const _handler = _FORMAT_HANDLERS[_fmtExt];
        if (_handler) {
          const _requestedPath = synthesisFilePath;
          const _fmtDone = await _handler(_tmpMdPath, synthesisFilePath);
          if (!_fmtDone) {
            // All conversion engines failed (including Node.js fallbacks) — save as .txt
            const _txtPath = synthesisFilePath.replace(/\.[^.]+$/, '.txt');
            fs.writeFileSync(_txtPath, cleanedAnswer, 'utf8');
            logger.warn(`[Node:ExecuteCommand] synthesize: all ${_fmtExt} engines failed — saved as plain text to ${_txtPath}`);
            synthesisFilePath = _txtPath;
            // Emit degradation event so UI can surface it and downstream steps know the real path
            if (progressCallback) progressCallback({
              type: 'file_format_degraded',
              requestedPath: _requestedPath,
              actualPath: _txtPath,
              reason: `No conversion engine available for ${_fmtExt} — saved as plain text`,
            });
          }
          try { fs.unlinkSync(_tmpMdPath); } catch (_) {}
        } else {
          // Plain / data format (.csv .md .txt .json etc.) — write directly
          fs.writeFileSync(synthesisFilePath, cleanedAnswer, 'utf8');
        }
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
  //   {{bestUrl}}             — bestUrl returned by the last web.agent search_and_navigate step
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
  // Resolve bestUrl: URL returned by the last successful web.agent search_and_navigate step
  const webAgentBestUrl = state.webAgentBestUrl || '';
  let resolvedArgs = args;
  if (synthesisAnswer || synthesisAnswerFile || prevStdout || prevWatchId || webAgentBestUrl) {
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
    if (webAgentBestUrl) {
      argsJson = argsJson.replace(/\{\{bestUrl\}\}/gi, webAgentBestUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
    resolvedArgs = JSON.parse(argsJson);
  }

  // ── Guard: fail fast if a URL arg still contains an unresolved template token ─────────────
  // Prevents navigating to literal "{{prev_stdout}}" when the prior step returned nothing.
  // Regex catches template variables including dot notation (e.g., {{prev_stdout.besturl}})
  if (typeof resolvedArgs.url === 'string' && /\{\{[a-zA-Z_0-9.]+\}\}/.test(resolvedArgs.url)) {
    const unresolvedToken = (resolvedArgs.url.match(/\{\{[a-zA-Z_0-9.]+\}\}/) || [])[0];
    throw new Error(`Unresolved template variable ${unresolvedToken} in URL — prior step returned no output. Check that the preceding step succeeded and produced a URL.`);
  }

  // ── browser.agent task-description cap ───────────────────────────────────────
  // The {{synthesisAnswer}} token expands to the full prior synthesize output, which
  // may include failure diagnostics, markdown reports, or [DATA FROM PRIOR STEP]
  // blocks.  These are injected into the browser.agent `task` string that playwright.agent
  // sees as its planning goal — long or contradictory narratives cause the LLM to
  // skip steps like pasteAttachment. Cap the task field at 300 chars for browser.agent
  // steps so the planner sees only the intent, not the full payload.
  // The actual email body content is delivered via the `type` step at runtime.
  if (skill === 'browser.agent' && resolvedArgs && typeof resolvedArgs.task === 'string') {
    let _task = resolvedArgs.task;
    // Strip [DATA FROM PRIOR STEP] and [CONTENT OF ...] injection blocks
    _task = _task.replace(/\[DATA FROM PRIOR STEP\][^[]*?(?=\[|$)/gs, '').trim();
    _task = _task.replace(/\[CONTENT OF [^\]]*\][^[]*?(?=\[|$)/gs, '').trim();
    // Cap remaining task description at 300 chars
    if (_task.length > 300) {
      _task = _task.slice(0, 297) + '...';
      logger.debug(`[Node:ExecuteCommand] browser.agent task description capped at 300 chars`);
    }
    if (_task !== resolvedArgs.task) {
      resolvedArgs = { ...resolvedArgs, task: _task };
    }
  }

  // Guard: if {{synthesisAnswer}} survived unsubstituted, synthesize hasn't run yet —
  // the plan order is wrong.  Abort immediately with a clear error rather than
  // typing the literal placeholder into a form field.
  if (JSON.stringify(resolvedArgs).includes('{{synthesisAnswer}}')) {
    const _planOrderError = 'Plan ordering error: a step references {{synthesisAnswer}} before the synthesize step that produces it. Please retry.';
    logger.error(`[Node:ExecuteCommand] Step ${skillCursor + 1} (${skill}) uses {{synthesisAnswer}} but no synthesize step has run yet — plan order is wrong`);
    return {
      ...state,
      planError: _planOrderError,
      failedStep: { step: skillCursor + 1, skill, description, error: _planOrderError, args: args || {} },
      commandExecuted: false,
    };
  }

  // Resolve {{service:field}} / {{_varName}} credential tokens and KEYTAR pointer values.
  // Resolution order: _gatheredVars (in-memory) → keychain template tokens → KEYTAR pointers.
  // Must run AFTER synthesisAnswer/prev_stdout substitution and BEFORE dispatch.
  // Never log resolvedArgs after this point as it may contain plaintext credentials.
  {
    const { resolveStepCredentials } = require('../utils/resolveStepCredentials');
    resolvedArgs = await resolveStepCredentials(
      { ...step, args: resolvedArgs },
      mcpAdapter,
      state._gatheredVars || {}
    );
  }

  // Normalize shell.run args: LLM sometimes generates 'command' instead of 'cmd'.
  // The validator rejects anything without 'cmd', so remap before it reaches MCP.
  if (skill === 'shell.run' && resolvedArgs.command && !resolvedArgs.cmd) {
    resolvedArgs = { ...resolvedArgs, cmd: resolvedArgs.command };
    delete resolvedArgs.command;
  }

  // If shell.run has both goal and cmd/argv, strip cmd/argv — goal mode always wins.
  // planSkills LLM sometimes emits both in the same step. When cmd is present,
  // _isGoalModeStep is false and the pre-built (potentially wrong-path) argv runs directly,
  // bypassing SHELL_RUN_SYSTEM and its mdfind / safe-path logic entirely.
  if (skill === 'shell.run' && resolvedArgs.goal && resolvedArgs.cmd) {
    const { cmd: _dropCmd, argv: _dropArgv, ...goalOnlyArgs } = resolvedArgs;
    resolvedArgs = goalOnlyArgs;
    logger.debug('[Node:ExecuteCommand] shell.run: stripped cmd/argv — goal mode takes precedence');
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

  // Fix apostrophes in single-quoted bash variable assignments.
  // LLMs consistently generate broken quoting like: MSG='what's up'
  // which ends the single-quoted string at the apostrophe (exit code 2).
  // Fix: find MSG/BODY/TEXT-like var assignments, extract raw text, re-wrap
  // in double quotes. Simple string scan — no fragile regex.
  if (skill === 'shell.run' && resolvedArgs.cmd === 'bash' && Array.isArray(resolvedArgs.argv)) {
    const _MSG_VAR_NAMES = ['MSG', 'MESSAGE', 'BODY', 'TEXT', 'CONTENT', 'SUBJECT'];
    const _fixedArgv = resolvedArgs.argv.map(a => {
      if (typeof a !== 'string') return a;
      let result = a;
      for (const vn of _MSG_VAR_NAMES) {
        // Find VAR= (case insensitive) followed by a quote
        const patterns = [`${vn}='`, `${vn}="`, `${vn.toLowerCase()}='`, `${vn.toLowerCase()}="`];
        for (const pat of patterns) {
          const idx = result.indexOf(pat);
          if (idx === -1) continue;
          const afterEq = idx + vn.length + 1; // position of the opening quote char
          const openQuote = result[afterEq];
          if (openQuote === '"') continue; // already double-quoted — leave alone
          // Single-quoted assignment: find the text between = and the next '; '
          // The '; ' delimiter separates the assignment from the next command (curl, etc.)
          const searchFrom = afterEq + 1; // skip the opening '
          const semiIdx = result.indexOf('; ', searchFrom);
          if (semiIdx === -1) continue;
          // Extract raw value between the opening quote and '; '
          let rawVal = result.substring(searchFrom, semiIdx);
          // Strip trailing quote if present
          if (rawVal.endsWith("'")) rawVal = rawVal.slice(0, -1);
          // Clean up all LLM quoting artifacts to get the actual user text
          rawVal = rawVal
            .replace(/'"'"'/g, "'")    // '"'"' → '
            .replace(/"'"'/g, "'")     // "'"' → '
            .replace(/'"'/g, "'")      // '"' → '
            .replace(/\\'/g, "'")      // \' → '
            .replace(/\\\\/g, '\\');   // \\\\ → \\
          // Rebuild with double quotes (apostrophes are safe inside double quotes)
          const varPart = result.substring(idx, idx + vn.length);
          result = result.substring(0, idx) + `${varPart}="${rawVal}"` + result.substring(semiIdx);
          break; // only fix first match per var name
        }
      }
      return result;
    });
    if (JSON.stringify(_fixedArgv) !== JSON.stringify(resolvedArgs.argv)) {
      logger.info('[Node:ExecuteCommand] shell.run: fixed message var quoting (apostrophe fix)');
    }
    resolvedArgs = { ...resolvedArgs, argv: _fixedArgv };
  }

  // Fix osascript -e quoting: LLMs wrap the AppleScript body in extra single quotes.
  // e.g. argv: ["-e", "'tell application \"TextEdit\" to close...'"] → strip outer quotes.
  // osascript -e receives the quotes as literal characters → syntax error (exit code 1).
  if (skill === 'shell.run' && resolvedArgs.cmd === 'osascript' && Array.isArray(resolvedArgs.argv)) {
    const _fixedOsaArgv = resolvedArgs.argv.map((a, idx, arr) => {
      if (typeof a !== 'string') return a;
      if (arr[idx - 1] === '-e' && a.startsWith("'") && a.endsWith("'")) {
        const stripped = a.slice(1, -1);
        logger.info('[Node:ExecuteCommand] osascript: stripped extra single quotes from -e script');
        return stripped;
      }
      return a;
    });
    resolvedArgs = { ...resolvedArgs, argv: _fixedOsaArgv };
  }

  // ── POSIX file clipboard-copy guard ─────────────────────────────────────────
  // Before any shell.run that copies a file to the OS clipboard via osascript
  // "POSIX file" pattern, verify the file actually exists on disk.
  // osascript exits 0 silently when the file is missing — clipboard stays empty
  // and downstream attach/paste steps fail without a clear error.
  //
  // Resolution order:
  //   1. File exists               → pass through unchanged
  //   2. File missing, stem match in savedFilePaths → auto-substitute actual path
  //   3. File missing, no match    → fail fast → recoverSkill → replan
  {
    const _osaScript = (skill === 'shell.run' && Array.isArray(resolvedArgs.argv))
      ? resolvedArgs.argv.find(a => typeof a === 'string' && a.includes('POSIX file'))
      : null;
    if (_osaScript) {
      // Extract the file path from: set the clipboard to (POSIX file "/path/to/file")
      // or: POSIX file "/path/to/file"
      const _posixMatch = _osaScript.match(/POSIX\s+file\s+["']([^"']+)["']/i);
      if (_posixMatch) {
        const _clipPath = _posixMatch[1];
        if (!fs.existsSync(_clipPath)) {
          // Try to find a saved file with the same basename stem (different extension)
          const _pathMod = require('path');
          const _stem = _pathMod.basename(_clipPath, _pathMod.extname(_clipPath)).toLowerCase();
          const _savedPaths = state.savedFilePaths || [];
          const _substitute = _savedPaths.find(p =>
            _pathMod.basename(p, _pathMod.extname(p)).toLowerCase() === _stem && fs.existsSync(p)
          );
          if (_substitute) {
            logger.warn(`[Node:ExecuteCommand] clipboard guard: "${_clipPath}" missing — substituting "${_substitute}"`);
            const _fixedArgv = resolvedArgs.argv.map(a =>
              typeof a === 'string' ? a.split(_clipPath).join(_substitute) : a
            );
            resolvedArgs = { ...resolvedArgs, argv: _fixedArgv };
          } else {
            const _guardErr = `File '${_clipPath}' does not exist — cannot copy to clipboard. The synthesize step may have failed to produce the requested format.`;
            logger.warn(`[Node:ExecuteCommand] clipboard guard: ${_guardErr}`);
            const _guardResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: _guardErr };
            if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill, error: _guardErr });
            return {
              ...state,
              skillResults: [...skillResults, _guardResult],
              skillCursor,
              failedStep: _guardResult,
              commandExecuted: false,
            };
          }
        }
      }
    }
  }

  // Fix multi-line file content in curl JSON bodies.
  // LLMs generate: MSG=$(cat file.txt); curl ... -d '{"body":"'$MSG'"}'
  // Multi-line content with newlines, quotes, markdown breaks the JSON (exit code 3).
  // Fix: rewrite to use jq for proper JSON construction when MSG is loaded from cat/file.
  if (skill === 'shell.run' && resolvedArgs.cmd === 'bash' && Array.isArray(resolvedArgs.argv)) {
    const _fixedArgv = resolvedArgs.argv.map(a => {
      if (typeof a !== 'string') return a;
      // Detect pattern: VAR=$(cat 'path') or VAR=$(cat "path") or VAR=$(cat path)
      const catMatch = a.match(/\b(MSG|MESSAGE|BODY|TEXT|CONTENT)=\$\(cat\s+['"]?([^'")\s]+)['"]?\)/i);
      if (!catMatch) return a;
      // Check if curl uses this variable in a JSON body
      const varName = catMatch[1];
      const filePath = catMatch[2];
      const hasCurl = a.includes('curl ') && (a.includes(`$${varName}`) || a.includes(`\${${varName}}`));
      if (!hasCurl) return a;

      // Extract the curl command portion to find the JSON template and phone/to field
      const toMatch = a.match(/["\\']+to["\\']+\s*:\s*["\\']+([^"'\\\s}]+)["\\']+/);
      let toNumber = toMatch ? toMatch[1] : '';
      // Apply E.164 normalization inline — detect country from locale and prepend dial code
      if (toNumber && !toNumber.startsWith('+')) {
        try {
          const _locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
          const _cc2 = (_locale.split('-').pop() || '').toUpperCase();
          const _dialCodes = { US:'1',CA:'1',GB:'44',AU:'61',DE:'49',FR:'33',JP:'81',CN:'86',IN:'91',BR:'55',MX:'52' };
          const _dc = _dialCodes[_cc2];
          if (_dc) { toNumber = `+${_dc}${toNumber}`; }
        } catch (_) {}
      }

      // Rewrite: read file → truncate to SMS limit → use jq to build valid JSON → curl
      // ClickSend SMS body limit is 918 chars (6 SMS segments). Truncate to be safe.
      const rewritten = [
        `${varName}=$(cat '${filePath}' | head -c 900)`,
        `USERNAME=$(security find-generic-password -s thinkdrop -a "skill:clicksend.send.sms:CLICKSEND_USERNAME" -w 2>/dev/null)`,
        `API_KEY=$(security find-generic-password -s thinkdrop -a "skill:clicksend.send.sms:CLICKSEND_API_KEY" -w 2>/dev/null)`,
        toNumber
          ? `JSON=$(jq -n --arg body "$${varName}" --arg to "${toNumber}" '{"messages":[{"source":"sdk","body":$body,"to":$to}]}')`
          : `JSON=$(jq -n --arg body "$${varName}" '{"messages":[{"source":"sdk","body":$body}]}')`,
        `curl -s -X POST https://rest.clicksend.com/v3/sms/send -u "$USERNAME:$API_KEY" -H "Content-Type: application/json" -d "$JSON"`,
      ].join('; ');

      logger.info(`[Node:ExecuteCommand] shell.run: rewrote cat+curl to jq JSON construction for file: ${filePath}`);
      return rewritten;
    });
    resolvedArgs = { ...resolvedArgs, argv: _fixedArgv };
  }

  // Normalize bare phone numbers to E.164 (+<cc>XXXXXXXXXX) in shell.run scripts.
  // Users rarely add country codes. We detect the country from the macOS system locale
  // and prepend the correct dialing code. Only fires for "to" fields in SMS payloads
  // where the number has no + prefix already.
  if (skill === 'shell.run' && Array.isArray(resolvedArgs.argv)) {
    // Country code lookup from ISO 3166-1 alpha-2 → ITU-T E.164 dialing prefix.
    // Only includes countries where the national number length is unambiguous enough
    // to avoid false positives. Covers ~95% of global SMS traffic.
    const _COUNTRY_DIAL_CODES = {
      US: '1', CA: '1', GB: '44', AU: '61', NZ: '64', IE: '353',
      DE: '49', FR: '33', ES: '34', IT: '39', NL: '31', BE: '32', AT: '43', CH: '41',
      PT: '351', SE: '46', NO: '47', DK: '45', FI: '358', PL: '48',
      JP: '81', KR: '82', CN: '86', TW: '886', HK: '852', SG: '65',
      IN: '91', PH: '63', TH: '66', MY: '60', ID: '62', VN: '84',
      BR: '55', MX: '52', AR: '54', CO: '57', CL: '56',
      ZA: '27', NG: '234', KE: '254', EG: '20',
      IL: '972', AE: '971', SA: '966', TR: '90', RU: '7',
    };
    // National number lengths per country (min digits a local number can be).
    // Used to avoid matching short strings that aren't phone numbers.
    const _NATIONAL_MIN_DIGITS = {
      US: 10, CA: 10, GB: 10, AU: 9, NZ: 8, IE: 9,
      DE: 10, FR: 9, ES: 9, IT: 9, NL: 9, BE: 9, AT: 10, CH: 9,
      PT: 9, SE: 9, NO: 8, DK: 8, FI: 9, PL: 9,
      JP: 10, KR: 10, CN: 11, TW: 9, HK: 8, SG: 8,
      IN: 10, PH: 10, TH: 9, MY: 9, ID: 10, VN: 9,
      BR: 10, MX: 10, AR: 10, CO: 10, CL: 9,
      ZA: 9, NG: 10, KE: 9, EG: 10,
      IL: 9, AE: 9, SA: 9, TR: 10, RU: 10,
    };

    let _detectedCountry = null;
    try {
      // Intl.DateTimeFormat().resolvedOptions().locale gives e.g. 'en-US', 'zh-CN', 'fr-FR'
      const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
      const parts = locale.split('-');
      _detectedCountry = (parts[parts.length - 1] || '').toUpperCase();
      // Validate it's a real 2-letter country code in our table
      if (!_COUNTRY_DIAL_CODES[_detectedCountry]) _detectedCountry = null;
    } catch (_) {}

    if (_detectedCountry) {
      const _cc = _COUNTRY_DIAL_CODES[_detectedCountry];
      const _minDigits = _NATIONAL_MIN_DIGITS[_detectedCountry] || 8;
      // Build regex: match bare digits (min length) without a + prefix, inside "to" fields
      // Anchored to "to" key in JSON to avoid mangling non-phone numbers
      const _digitPattern = `(\\d{${_minDigits},15})`;
      const _toE164 = (str) => str
        // JSON-escaped variant: \"to\":\"123456789\"
        .replace(new RegExp(`\\\\"to\\\\":\\\\"${_digitPattern}\\\\"`, 'g'), (_m, n) =>
          n.startsWith(_cc) ? _m : `\\"to\\":\\"+${_cc}${n}\\"`)
        // Unescaped double-quote: "to":"123456789"
        .replace(new RegExp(`"to":"${_digitPattern}"`, 'g'), (_m, n) =>
          n.startsWith(_cc) ? _m : `"to":"+${_cc}${n}"`)
        // Single-quote: 'to':'123456789'
        .replace(new RegExp(`'to':'${_digitPattern}'`, 'g'), (_m, n) =>
          n.startsWith(_cc) ? _m : `'to':'+${_cc}${n}'`);

      const _normalizedArgv = resolvedArgs.argv.map(a => typeof a === 'string' ? _toE164(a) : a);
      if (JSON.stringify(_normalizedArgv) !== JSON.stringify(resolvedArgs.argv)) {
        logger.info(`[Node:ExecuteCommand] shell.run: normalized phone number to E.164 (+${_cc}, country=${_detectedCountry})`);
      }
      resolvedArgs = { ...resolvedArgs, argv: _normalizedArgv };
    }
  }

  // ── Session inheritance: browser.act steps with no sessionId inherit from last navigate ──
  // Without this, actions like waitForStableText/getPageText with no sessionId open a new
  // blank tab instead of targeting the page that was just navigated to.
  // Derive session from: (1) last navigate args.sessionId, (2) last navigate returned URL
  // hostname (command service derives session from hostname when no sessionId given),
  // (3) state.activeBrowserSessionId from prior steps.
  if (skill === 'browser.act' && !resolvedArgs.sessionId && resolvedArgs.action !== 'navigate') {
    const lastNavigate = [...skillResults].reverse().find(r => r.skill === 'browser.act' && r.args?.action === 'navigate' && r.ok);
    let inheritedSession = lastNavigate?.args?.sessionId || state.activeBrowserSessionId || null;
    if (!inheritedSession && lastNavigate?.url) {
      // Derive hostname-based session the same way the command service does
      try {
        inheritedSession = new URL(lastNavigate.url).hostname;
      } catch (_) {}
    }
    if (inheritedSession) {
      resolvedArgs = { ...resolvedArgs, sessionId: inheritedSession };
      logger.info(`[Node:ExecuteCommand] Session inherit: "${inheritedSession}" → ${resolvedArgs.action} (lastNavigate.url=${lastNavigate?.url})`);
    } else {
      logger.info(`[Node:ExecuteCommand] Session inherit: no session found for ${resolvedArgs.action} (lastNavigate=${JSON.stringify(lastNavigate?.url)}, active=${state.activeBrowserSessionId})`);
    }
  }

  const externalSkillName = skill === 'external.skill' && resolvedArgs.name ? resolvedArgs.name : null;
  // Build a human-readable label: "browser.act — navigate (perplexity)", "shell.run — bash", etc.
  function buildRichDescription(sk, args) {
    if (description) return description;
    if (sk === 'browser.act') {
      const action = args.action || '';
      const session = args.sessionId || '';
      const urlHost = args.url ? (() => { try { return new URL(args.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })() : '';
      const label = session || urlHost;
      return label ? `browser.act — ${action} (${label})` : `browser.act — ${action}`;
    }
    if (sk === 'shell.run') {
      const cmd = args.cmd || args.command || '';
      const argv0 = Array.isArray(args.argv) ? args.argv[0] : '';
      return cmd ? `shell.run — ${cmd}${argv0 ? ' ' + argv0 : ''}` : 'shell.run';
    }
    if (sk === 'synthesize') {
      const p = (args.prompt || '').slice(0, 40);
      return p ? `synthesize — ${p}…` : 'synthesize';
    }
    if (sk === 'web.crawl') {
      const u = (args.url || '').replace(/^https?:\/\//, '').slice(0, 50);
      return u ? `Crawling ${u}…` : 'web.crawl';
    }
    if (externalSkillName) return `external.skill — ${externalSkillName}`;
    return sk;
  }
  const stepStartDescription = buildRichDescription(skill, resolvedArgs);
  logger.debug(`[Node:ExecuteCommand] Step ${skillCursor + 1}/${skillPlan.length}: ${stepStartDescription}`);
  if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: stepStartDescription });

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
  // browser.act actions need at least 30s: smartType has a 5×1s retry loop, waitForContent
  // polls up to 45s, and any LLM-supplied timeoutMs:5000 would kill these before they finish.
  if (skill === 'browser.act') {
    stepTimeoutMs = Math.max(stepTimeoutMs, 30000);
  }
  // web.crawl launches playwright-cli, navigates, waits for JS render — needs at least 45s.
  if (skill === 'web.crawl') {
    stepTimeoutMs = Math.max(stepTimeoutMs, 45000);
  }
  // project_build can take several minutes (npm install + vite build + Playwright tests × 5 retries)
  if (skill === 'project_build') {
    stepTimeoutMs = Math.max(stepTimeoutMs, 600000); // 10 min max
  }
  // project_launch: start server + open browser — give it 30s
  if (skill === 'project_launch') {
    stepTimeoutMs = Math.max(stepTimeoutMs, 30000);
  }
  // browser.agent / cli.agent: pipeline is waitForAuth (up to 120s) + playwright.agent
  // (up to 15 turns × ~3s each). 60s default kills the task mid-execution and causes
  // a retry that hijacks the same Chrome session, corrupting in-progress automation.
  if (skill === 'browser.agent' || skill === 'cli.agent') {
    stepTimeoutMs = Math.max(stepTimeoutMs, 300000); // 5 min
  }
  // ── project_build: route to project.builder MCP skill ──────────────────────
  if (skill === 'project_build') {
    if (progressCallback) progressCallback({
      type: 'project_build_start',
      capability: resolvedArgs.capability || resolvedArgs.description || '',
      projectName: resolvedArgs.projectName || '',
    });

    try {
      const buildResult = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'project.builder',
        args: {
          capability:   resolvedArgs.capability || resolvedArgs.description || '',
          description:  resolvedArgs.description || state.resolvedMessage || state.message || '',
          projectName:  resolvedArgs.projectName || null,
        },
      }, { timeoutMs: stepTimeoutMs });

      const raw = buildResult?.data || buildResult || {};
      const ok  = raw.ok === true || raw.success === true;

      if (ok) {
        // Emit file-creation events (Windsurf-style visibility) for key source files
        if (progressCallback && raw.projectDir) {
          try {
            const fsSync = require('fs');
            const pathSync = require('path');
            const SHOW_FILES = [
              'package.json', 'vite.config.js', 'tailwind.config.js',
              path.join('server', 'index.js'), path.join('server', 'app.js'),
              path.join('client', 'App.jsx'), path.join('client', 'main.jsx'),
              path.join('public', 'index.html'),
            ];
            for (const rel of SHOW_FILES) {
              const abs = pathSync.join(raw.projectDir, rel);
              if (fsSync.existsSync(abs)) {
                progressCallback({ type: 'project_file_created', file: rel, projectDir: raw.projectDir });
              }
            }
          } catch (_) {}
        }
        if (progressCallback) progressCallback({ type: 'project_build_pass', projectName: raw.projectName, projectDir: raw.projectDir, iterations: raw.iterations });
        const stepResult = {
          step: skillCursor + 1, skill, args: resolvedArgs, description,
          ok: true,
          output:     raw.output || `Project "${raw.projectName}" built successfully.`,
          projectName: raw.projectName,
          projectDir:  raw.projectDir,
          port:        raw.port,
          iterations:  raw.iterations,
          stdout:      raw.output || '',
        };
        const updatedResults = [...skillResults, stepResult];
        const nextCursor = skillCursor + 1;
        if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: stepStartDescription, stdout: stepResult.stdout });
        if (nextCursor >= skillPlan.length) {
          const answer = `Project "${raw.projectName}" has been built and registered. You can now use it as a skill.`;
          return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: true, answer, failedStep: null };
        }
        return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: false, failedStep: null };
      } else {
        const errMsg = raw.error || 'project.builder returned failure';
        if (progressCallback) progressCallback({ type: 'project_build_fail', error: errMsg });
        const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
        if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
        return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
      }
    } catch (buildErr) {
      const errMsg = buildErr.message || 'project.builder threw an error';
      if (progressCallback) progressCallback({ type: 'project_build_fail', error: errMsg });
      const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
      return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
    }
  }

  // ── project_launch: route to project.launcher MCP skill ────────────────────
  if (skill === 'project_launch') {
    try {
      const launchResult = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'project.launcher',
        args: {
          projectName: resolvedArgs.projectName || resolvedArgs.name || '',
          port:        resolvedArgs.port || null,
        },
      }, { timeoutMs: stepTimeoutMs });

      const raw = launchResult?.data || launchResult || {};
      const ok  = raw.ok === true || raw.success === true;

      if (ok) {
        const stepResult = {
          step: skillCursor + 1, skill, args: resolvedArgs, description,
          ok: true,
          output: raw.output || `Project "${raw.projectName}" is running at ${raw.url}.`,
          projectName: raw.projectName,
          projectDir:  raw.projectDir,
          port:        raw.port,
          url:         raw.url,
          stdout:      raw.output || '',
        };
        const updatedResults = [...skillResults, stepResult];
        const nextCursor = skillCursor + 1;
        if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: stepStartDescription, stdout: stepResult.stdout });
        if (nextCursor >= skillPlan.length) {
          const answer = raw.output || `"${raw.projectName}" is running at ${raw.url} and has been opened in your browser.`;
          return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: true, answer, failedStep: null };
        }
        return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: false, failedStep: null };
      } else {
        const errMsg = raw.error || 'project.launcher returned failure';
        const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
        if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
        return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
      }
    } catch (launchErr) {
      const errMsg = launchErr.message || 'project.launcher threw an error';
      const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
      return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
    }
  }

  // ── project_edit: route to project.editor MCP skill ────────────────────────
  if (skill === 'project_edit') {
    stepTimeoutMs = Math.max(stepTimeoutMs, 120000); // 2 min for LLM + rebuild
    try {
      const editResult = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'project.editor',
        args: {
          projectName: resolvedArgs.projectName || resolvedArgs.name || '',
          prompt:      resolvedArgs.prompt || resolvedArgs.editPrompt || '',
          port:        resolvedArgs.port || null,
        },
      }, { timeoutMs: stepTimeoutMs });

      const raw = editResult?.data || editResult || {};
      const ok  = raw.ok === true || raw.success === true;

      if (ok) {
        const stepResult = {
          step: skillCursor + 1, skill, args: resolvedArgs, description,
          ok: true,
          output: raw.output || `Updated ${(raw.changedFiles || []).join(' and ')}.`,
          changedFiles: raw.changedFiles,
          stdout: raw.output || '',
        };
        const updatedResults = [...skillResults, stepResult];
        const nextCursor = skillCursor + 1;
        if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: stepStartDescription, stdout: stepResult.stdout });
        if (nextCursor >= skillPlan.length) {
          return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: true, answer: raw.output, failedStep: null };
        }
        return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: false, failedStep: null };
      } else {
        const errMsg = raw.error || 'project.editor returned failure';
        const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
        if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
        return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
      }
    } catch (editErr) {
      const errMsg = editErr.message || 'project.editor threw an error';
      const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
      return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
    }
  }

  // ── project_stop: route to project.stopper MCP skill ───────────────────────
  if (skill === 'project_stop') {
    try {
      const stopResult = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'project.stopper',
        args: {
          projectName: resolvedArgs.projectName || resolvedArgs.name || '',
          port:        resolvedArgs.port || null,
        },
      }, { timeoutMs: 10000 });

      const raw = stopResult?.data || stopResult || {};
      const ok  = raw.ok === true || raw.success === true;
      const stepResult = {
        step: skillCursor + 1, skill, args: resolvedArgs, description,
        ok,
        output: raw.output || (ok ? 'Stopped.' : raw.error),
        stdout: raw.output || '',
        error: ok ? undefined : raw.error,
      };
      const updatedResults = [...skillResults, stepResult];
      const nextCursor = skillCursor + 1;
      if (ok) {
        if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: stepStartDescription, stdout: stepResult.stdout });
        if (nextCursor >= skillPlan.length) {
          return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: true, answer: raw.output, failedStep: null };
        }
        return { ...state, skillResults: updatedResults, skillCursor: nextCursor, commandExecuted: false, failedStep: null };
      } else {
        if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: raw.error });
        return { ...state, skillResults: updatedResults, skillCursor, failedStep: stepResult, commandExecuted: false };
      }
    } catch (stopErr) {
      const errMsg = stopErr.message || 'project.stopper threw an error';
      const stepResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: false, error: errMsg };
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: stepStartDescription, error: errMsg });
      return { ...state, skillResults: [...skillResults, stepResult], skillCursor, failedStep: stepResult, commandExecuted: false };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Unresolved credential token guard ────────────────────────────────────────
  // If a browser.act fill step still has a {{service:field}} token in value/text
  // after resolveStepCredentials ran (meaning the key is NOT in the keychain),
  // we must NOT type the literal token text into the page.  Instead, treat it
  // exactly like an auth_wall — spawn a login sub-plan that will ask the user for
  // credentials, store them, then retry the fill.
  // Note: {{_varName}} gathered-var tokens are intentionally excluded — those are
  // handled by the ask_user step and will be resolved when the sub-plan runs.
  {
    const SERVICE_CRED_TOKEN = /\{\{[a-z0-9_.-]+:[a-z0-9_]+\}\}/i;
    const fillVal = resolvedArgs.value ?? resolvedArgs.text ?? '';
    if (
      skill === 'browser.act' &&
      resolvedArgs.action === 'fill' &&
      typeof fillVal === 'string' &&
      SERVICE_CRED_TOKEN.test(fillVal)
    ) {
      const tokenMatch = fillVal.match(/\{\{([a-z0-9_.-]+):([a-z0-9_]+)\}\}/i);
      const credService  = tokenMatch?.[1] || 'unknown';
      const authLoginUrl = state.activeBrowserUrl || resolvedArgs.url || '';
      logger.warn(`[Node:ExecuteCommand] Unresolved credential token "${tokenMatch?.[0]}" in fill step — routing to auth_wall sub-plan for "${credService}"`);
      if (progressCallback) progressCallback({
        type:    'auth_wall_detected',
        stepIndex: skillCursor,
        service: credService,
        message: `Credentials not found for ${credService} — asking user`,
      });
      const credFailedStep = {
        step: skillCursor + 1, skill, args: resolvedArgs, description,
        ok: false,
        reason:    'auth_wall',
        service:   credService,
        loginUrl:  authLoginUrl,
        sessionId: resolvedArgs.sessionId || state.activeBrowserSessionId || null,
        error:     `unresolved_credential: ${tokenMatch?.[0]} not in keychain`,
      };
      return {
        ...state,
        skillResults:           [...skillResults, credFailedStep],
        skillCursor,
        failedStep:             credFailedStep,
        commandExecuted:        false,
        activeBrowserSessionId: resolvedArgs.sessionId || state.activeBrowserSessionId || null,
        activeBrowserUrl:       authLoginUrl || state.activeBrowserUrl,
      };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── skipIfEmpty / skipIfPrevEmpty guard ──────────────────────────────────────
  // Some steps emitted by buildLoginSubPlan are marked optional and should be
  // quietly skipped when a value was not collected (e.g. 2FA code left blank).
  //
  //   step.skipIfEmpty  = true        → skip if resolvedArgs.value is empty/blank
  //   step.args.skipIfEmpty = true    → same (canonical location)
  //   step.skipIfPrevEmpty = varName  → skip if state._gatheredVars[varName] is empty
  //   step.args.skipIfPrevEmpty = v   → same
  {
    const gatheredVars = state._gatheredVars || {};
    const skipIfEmpty = step.skipIfEmpty || args.skipIfEmpty;
    const skipIfPrevEmpty = step.skipIfPrevEmpty || args.skipIfPrevEmpty;

    const shouldSkipByEmpty = skipIfEmpty &&
      (!resolvedArgs.value || String(resolvedArgs.value).trim() === '' ||
       // still has unresolved template token (value was not in gatheredVars or keychain)
       /^\{\{/.test(String(resolvedArgs.value)));

    const shouldSkipByPrev = skipIfPrevEmpty &&
      (!gatheredVars[skipIfPrevEmpty] || String(gatheredVars[skipIfPrevEmpty]).trim() === '');

    if (shouldSkipByEmpty || shouldSkipByPrev) {
      const whySkipped = shouldSkipByEmpty ? 'value is empty' : `"${skipIfPrevEmpty}" not collected`;
      logger.info(`[Node:ExecuteCommand] Skipping optional step ${skillCursor + 1} (${skill}): ${whySkipped}`);
      if (progressCallback) progressCallback({
        type: 'step_skipped', stepIndex: skillCursor, totalSteps: skillPlan.length,
        skill, description: description || skill, reason: whySkipped,
      });
      const skippedResult = { step: skillCursor + 1, skill, args: resolvedArgs, description, ok: true, skipped: true, stdout: `[Skipped: ${whySkipped}]` };
      const nextCursor = skillCursor + 1;
      if (nextCursor >= skillPlan.length) {
        const subPlanStackNow = Array.isArray(state.subPlanStack) ? state.subPlanStack : [];
        if (subPlanStackNow.length > 0) {
          const { completeSubPlan } = require('./subPlanEngine');
          const resumed = completeSubPlan({ ...state, skillResults: [...skillResults, skippedResult], skillCursor: nextCursor });
          return { ...state, ...resumed, commandExecuted: false, failedStep: null };
        }
        return { ...state, skillResults: [...skillResults, skippedResult], skillCursor: nextCursor, commandExecuted: true, failedStep: null };
      }
      return { ...state, skillResults: [...skillResults, skippedResult], skillCursor: nextCursor, commandExecuted: false, failedStep: null };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── runGroup parallel dispatch ────────────────────────────────────────────────
  // When the current step has a runGroup property, collect all consecutive steps
  // sharing the same group ID and fire them in parallel via Promise.allSettled.
  // Results are merged into skillResults and cursor advances past all group steps.
  if (step.runGroup) {
    const groupId = step.runGroup;
    // Collect all consecutive steps in this group starting from skillCursor
    const groupSteps = [];
    for (let gi = skillCursor; gi < skillPlan.length; gi++) {
      if (skillPlan[gi].runGroup === groupId) groupSteps.push({ idx: gi, step: skillPlan[gi] });
      else break;
    }
    logger.info(`[Node:ExecuteCommand] runGroup "${groupId}": dispatching ${groupSteps.length} steps in parallel`);

    // Emit step_start for all group steps
    for (const { idx, step: gs } of groupSteps) {
      if (progressCallback) progressCallback({
        type: 'step_start', stepIndex: idx, totalSteps: skillPlan.length,
        skill: gs.skill, description: gs.description || gs.skill, runGroup: groupId,
      });
      if (_rawProgressCallback && state._skillPlanFile) {
        _rawProgressCallback({ type: 'plan:step_start', stepIndex: idx, totalSteps: skillPlan.length, skill: gs.skill, description: gs.description });
      }
    }

    // Helper: dispatch a single group step (with automatic retry for Chrome crashes)
    const _dispatchGroupStep = async ({ idx, step: gs }) => {
      const gsArgs = gs.args || {};
      const _isAgent = gs.skill === 'cli.agent' || gs.skill === 'browser.agent';
      const _callArgs = _isAgent
        ? { ...gsArgs, _progressCallbackUrl: `http://127.0.0.1:${process.env.OVERLAY_CONTROL_PORT || 3010}/agent-turn`, _stepIndex: idx, context: { ...(gsArgs.context || {}), _dataFile: state.synthesisAnswerFile || null } }
        : gsArgs;
      // Shorter timeout for parallel browser steps to prevent indefinite hanging
      const stepTimeoutMs = gs.skill === 'browser.agent' ? 120000 : 300000; // 2 min for browser, 5 min for CLI

      // Inner function to attempt step with optional retry
      const attemptStep = async (isRetry = false) => {
        try {
          const res = await mcpAdapter.callService('command', 'command.automate', { skill: gs.skill, args: _callArgs }, { timeoutMs: stepTimeoutMs });
          const raw = res?.data || res;

          // If browser crashed and this is first attempt, retry once immediately
          if (raw?.ok === false && raw?.chromeCrash === true && !isRetry) {
            logger.warn(`[Node:ExecuteCommand] runGroup step ${idx} (${gs.skill}) crashed, retrying once...`);
            // Small delay to let Chrome cleanup before retry
            await new Promise(r => setTimeout(r, 1000));
            return attemptStep(true); // Retry with isRetry=true
          }

          // Send immediate progress for failed steps before Promise.allSettled completes
          if (raw?.ok === false && progressCallback) {
            logger.warn(`[Node:ExecuteCommand] runGroup step ${idx} (${gs.skill}) failed: ${raw?.error || 'unknown error'}`);
            progressCallback({
              type: 'step_failed',
              stepIndex: idx,
              totalSteps: skillPlan.length,
              skill: gs.skill,
              description: gs.description,
              error: raw?.error || 'Step failed',
              runGroup: groupId,
            });
          }
          return { idx, step: gs, ok: raw?.ok !== false, result: raw?.result ?? raw?.stdout ?? null, stdout: raw?.stdout ?? null, raw };
        } catch (err) {
          // On exception, also retry once if first attempt
          if (!isRetry) {
            logger.warn(`[Node:ExecuteCommand] runGroup step ${idx} (${gs.skill}) threw error, retrying once: ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
            return attemptStep(true);
          }
          // Retry failed - send final failure
          logger.error(`[Node:ExecuteCommand] runGroup step ${idx} (${gs.skill}) threw error after retry: ${err.message}`);
          if (progressCallback) {
            progressCallback({
              type: 'step_failed',
              stepIndex: idx,
              totalSteps: skillPlan.length,
              skill: gs.skill,
              description: gs.description,
              error: err.message,
              runGroup: groupId,
            });
          }
          return { idx, step: gs, ok: false, error: err.message, result: null, stdout: null, raw: null };
        }
      };

      return attemptStep(false); // Start with isRetry=false
    };

    let settled = await Promise.allSettled(groupSteps.map(_dispatchGroupStep));

    // ── Parallel login wall detection ─────────────────────────────────────────
    // If any step hit a login wall (loginWallDetected or askUser+needsCredentials),
    // pause and ask the user how to handle each blocked service before continuing.
    // Also catches researchContentEmpty (sparse content / quality gate failures) which
    // often indicate login-required pages that bypassed the login wall detector.
    const parallelLoginCallback = state.parallelLoginCallback;
    const loginWallSteps = settled
      .filter(o => o.status === 'fulfilled')
      .map(o => o.value)
      .filter(r => !r.ok && (
        r.raw?.loginWallDetected === true ||
        (r.raw?.askUser === true && r.raw?.needsCredentials === true) ||
        r.raw?.researchContentEmpty === true
      ));

    if (loginWallSteps.length > 0 && typeof parallelLoginCallback === 'function') {
      logger.info(`[Node:ExecuteCommand] runGroup "${groupId}" — ${loginWallSteps.length} login wall(s) detected, pausing for user decision`);

      // Build service list for the UI card
      const loginServices = loginWallSteps.map(r => ({
        stepIdx: r.idx,
        agentId: r.raw?.agentId || r.step?.args?.agentId || r.step?.skill,
        service: (r.raw?.agentId || r.step?.args?.agentId || r.step?.skill || '').replace(/\.agent$/, ''),
        description: r.step?.description || r.step?.skill || '',
      }));

      // Emit UI event so the card renders
      if (progressCallback) progressCallback({
        type: 'parallel_login_required',
        services: loginServices,
        runGroup: groupId,
      });

      // Await per-service decisions: { [agentId]: 'login' | 'try_without' | 'skip' }
      let decisions = {};
      try {
        decisions = await parallelLoginCallback(loginServices, progressCallback) || {};
      } catch (cbErr) {
        logger.warn(`[Node:ExecuteCommand] parallelLoginCallback threw: ${cbErr.message} — skipping all login walls`);
        loginServices.forEach(s => { decisions[s.agentId] = 'skip'; });
      }

      // Re-dispatch steps based on decisions
      const reDispatchResults = await Promise.allSettled(loginWallSteps.map(async (r) => {
        const svc = loginServices.find(s => s.stepIdx === r.idx);
        const decision = decisions[svc?.agentId] || 'skip';
        const gs = r.step;

        if (decision === 'skip') {
          logger.info(`[Node:ExecuteCommand] parallel login: skipping ${svc?.agentId}`);
          return { idx: r.idx, step: gs, ok: false, skipped: true, result: null, stdout: null, error: 'Skipped by user', raw: null };
        }

        // 'login' or 'try_without' — re-dispatch with appropriate flags
        const gsArgs = gs.args || {};
        const _isAgent = gs.skill === 'cli.agent' || gs.skill === 'browser.agent';
        const extraArgs = decision === 'try_without' ? { skipAuth: true } : {};
        const _callArgs = _isAgent
          ? { ...gsArgs, ...extraArgs, _progressCallbackUrl: `http://127.0.0.1:${process.env.OVERLAY_CONTROL_PORT || 3010}/agent-turn`, _stepIndex: r.idx, context: { ...(gsArgs.context || {}), _dataFile: state.synthesisAnswerFile || null } }
          : { ...gsArgs, ...extraArgs };

        logger.info(`[Node:ExecuteCommand] parallel login: re-dispatching ${svc?.agentId} (decision=${decision})`);
        try {
          const res = await mcpAdapter.callService('command', 'command.automate', { skill: gs.skill, args: _callArgs }, { timeoutMs: 300000 });
          const raw = res?.data || res;
          return { idx: r.idx, step: gs, ok: raw?.ok !== false, result: raw?.result ?? raw?.stdout ?? null, stdout: raw?.stdout ?? null, raw };
        } catch (err) {
          return { idx: r.idx, step: gs, ok: false, error: err.message, result: null, stdout: null, raw: null };
        }
      }));

      // Merge re-dispatch results back into settled array
      const reDispatchMap = new Map();
      for (const o of reDispatchResults) {
        const r = o.status === 'fulfilled' ? o.value : { ok: false };
        if (r.idx != null) reDispatchMap.set(r.idx, o);
      }
      settled = settled.map(o => {
        const r = o.status === 'fulfilled' ? o.value : null;
        if (r && reDispatchMap.has(r.idx)) return reDispatchMap.get(r.idx);
        return o;
      });
    }

    const groupResults = [];
    let firstFailure = null;
    for (const outcome of settled) {
      const r = outcome.status === 'fulfilled' ? outcome.value : { ...outcome.reason, ok: false };
      const stepEntry = {
        step: r.idx + 1,
        skill: r.step?.skill,
        args: r.step?.args || {},
        description: r.step?.description,
        ok: r.ok,
        skipped: r.skipped || false,
        result: r.result,
        stdout: r.stdout,
        error: r.error || null,
        runGroup: groupId,
      };
      groupResults.push(stepEntry);
      if (progressCallback) progressCallback({
        type: r.ok ? 'step_done' : r.skipped ? 'step_skipped' : 'step_failed',
        stepIndex: r.idx, totalSteps: skillPlan.length,
        skill: r.step?.skill, description: r.step?.description,
        stdout: r.stdout, error: r.error, runGroup: groupId,
      });
      if (_rawProgressCallback && state._skillPlanFile) {
        _rawProgressCallback({ type: r.ok ? 'plan:step_done' : 'plan:step_done', stepIndex: r.idx, totalSteps: skillPlan.length, skill: r.step?.skill, description: r.step?.description });
      }
      if (!r.ok && !r.skipped && !r.step?.optional && !firstFailure) firstFailure = stepEntry;
    }

    const newResults = [...skillResults, ...groupResults];
    const nextCursor = skillCursor + groupSteps.length;
    const succeededCount = groupResults.filter(r => r.ok).length;
    const skippedCount = groupResults.filter(r => r.skipped).length;
    logger.info(`[Node:ExecuteCommand] runGroup "${groupId}" complete — ${succeededCount}/${groupResults.length} succeeded (${skippedCount} skipped), cursor → ${nextCursor}`);

    if (firstFailure && succeededCount === 0) {
      // All steps failed — route to recovery
      return {
        ...state,
        skillResults: newResults,
        skillCursor: nextCursor,
        commandExecuted: false,
        failedStep: firstFailure,
      };
    }
    // Partial or full success — advance cursor; synthesize will work with whatever results exist
    return {
      ...state,
      skillResults: newResults,
      skillCursor: nextCursor,
      commandExecuted: nextCursor >= skillPlan.length,
      failedStep: null,
    };
  }
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    // For cli.agent / browser.agent: inject _progressCallbackUrl so the agent can POST
    // real-time turn updates back to the Electron overlay server → renderer (AutomationProgress).
    const _isAgentSkill = skill === 'cli.agent' || skill === 'browser.agent';
    // Guard: planSkills LLM sometimes emits browser.agent/cli.agent steps without an
    // explicit `action` field.  The agent's switch statement hits the default case and
    // returns { ok: false, error: "Unknown action: \"undefined\"" }, triggering an
    // unnecessary recoverSkill retry loop.  Default to 'run' here so the step succeeds
    // on the first attempt without any recovery overhead.
    if (skill === 'browser.agent' && resolvedArgs && !resolvedArgs.action) {
      resolvedArgs = { action: 'run', ...resolvedArgs };
      logger.debug('[Node:ExecuteCommand] browser.agent: defaulted missing action to \'run\'');
    }
    if (skill === 'cli.agent' && resolvedArgs && !resolvedArgs.action) {
      resolvedArgs = { action: 'run', ...resolvedArgs };
      logger.debug('[Node:ExecuteCommand] cli.agent: defaulted missing action to \'run\'');
    }
    // For all shell.run steps: inject _progressCallback so that:
    //   - goal-mode resolution surfaces thinking events ('Generating shell command…')
    //   - live stdout chunks stream to the UI terminal panel (shell:stdout_chunk)
    //   - sudo operations show a password warning before execution (shell:sudo_required)
    const _isShellRunStep = skill === 'shell.run';
    const _callArgs = _isAgentSkill
      ? { ...resolvedArgs, _progressCallbackUrl: `http://127.0.0.1:${process.env.OVERLAY_CONTROL_PORT || 3010}/agent-turn`, _stepIndex: skillCursor, context: { ...(resolvedArgs.context || {}), _dataFile: state.synthesisAnswerFile || null } }
      : _isShellRunStep
        ? { ...resolvedArgs, _progressCallback: (evt) => {
            if (!progressCallback) return;
            if (evt.type === 'shell:goal_resolving') {
              const thinking = evt.attempt > 1
                ? `Retrying command generation (${evt.attempt}/${evt.maxAttempts})…`
                : 'Generating shell command…';
              progressCallback({ type: 'step_thinking', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'shell.run', thinking });
            } else if (evt.type === 'shell:stdout_chunk') {
              progressCallback({ type: 'step_output', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'shell.run', text: evt.text });
            } else if (evt.type === 'shell:sudo_required') {
              progressCallback({ type: 'step_sudo_required', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'shell.run', message: evt.message, cmd: evt.cmd });
            }
          }}
        : resolvedArgs;

    const result = await mcpAdapter.callService('command', 'command.automate', {
      skill,
      args: _callArgs
    }, { timeoutMs: stepTimeoutMs });

    const raw = result.data || result;

    // ── Sub-agent turn visibility ─────────────────────────────────────────────
    // cli.agent { action: run, agentId } and browser.agent { action: run } both return
    // { agentId, task, transcript: [...], turns } when running agentically.
    // playwright.agent self-emits agent:turn_live + agent:turn live inside its step loop,
    // so post-hoc replay would wipe live turns (via turns_reset) and replace them with
    // a burst at the end. Skip reset+replay for self-emitting agents; only emit agent:complete.
    if (progressCallback && raw.agentId) {
      const selfEmitsLive = raw.agentId === 'playwright.agent';
      if (!selfEmitsLive) {
        // cli.agent and others: post-hoc replay is the only source of turn data
        progressCallback({
          type:      'agent:turns_reset',
          stepIndex: skillCursor,
        });
        if (Array.isArray(raw.transcript) && raw.transcript.length > 0) {
          for (const entry of raw.transcript) {
            progressCallback({
              type:        'agent:turn',
              agentId:     raw.agentId,
              turn:        entry.turn || 0,
              maxTurns:    raw.turns || raw.transcript.length,
              action:      entry.action,
              outcome:     entry.outcome,
              observation: entry.observation,
              thoughts:    entry.thoughts,
              stepIndex:   skillCursor,
            });
          }
        }
      }
      progressCallback({
        type:        'agent:complete',
        agentId:     raw.agentId,
        task:        raw.task,
        totalTurns:  raw.turns || (raw.transcript?.length || 0),
        done:        raw.done ?? raw.ok,
        result:      raw.result || raw.stdout || '',
        reasoning:   raw.reasoning,
        ok:          raw.ok,
        stepIndex:   skillCursor,
      });
      if (raw.savedRule) {
        progressCallback({ type: 'agent:rule_learned', stepIndex: skillCursor, agentId: raw.agentId, rule: raw.savedRule });
      }
    }

    // ── Credential gather card path ───────────────────────────────────────────
    // When browser.agent returns needsCredentials: true, show the gather_credential
    // UI card directly (instead of a plain text question). The user types the value,
    // it gets stored encrypted, then we retry the same step automatically.
    if (raw.agentId && raw.askUser === true && raw.needsCredentials && raw.credentialKey && typeof gatherCredentialCallback === 'function') {
      logger.info(`[Node:ExecuteCommand] credential gate: gathering ${raw.credentialKey} for ${raw.agentId}`);
      try {
        if (progressCallback) progressCallback({
          type:          'gather_credential',
          credentialKey: raw.credentialKey,
          question:      raw.question,
          hint:          `Stored securely for future logins to ${raw.agentId}.`,
          sensitive:     false,
          optional:      true,
          stepIndex:     skillCursor,
          totalSteps:    skillPlan?.length || 1,
        });
        const _gathered = await gatherCredentialCallback(raw.credentialKey, {
          question:  raw.question,
          sensitive: false,
        });
        if (_gathered?.stored) {
          logger.info(`[Node:ExecuteCommand] credential gate: stored ${raw.credentialKey} — retrying step`);
          if (progressCallback) progressCallback({ type: 'gather_credential_stored', credentialKey: raw.credentialKey });
          // Retry the same step: keep skillCursor unchanged, clear failure state
          return {
            ...state,
            skillResults,
            skillCursor,
            failedStep:      null,
            pendingQuestion: null,
            recoveryAction:  null,
            commandExecuted: false,
          };
        }
        // User skipped or gather timed out — fall through to plain ask_user text prompt
        logger.info(`[Node:ExecuteCommand] credential gate: skipped or error — falling through to ask_user`);
      } catch (_gatherErr) {
        logger.warn(`[Node:ExecuteCommand] credential gate error: ${_gatherErr.message}`);
      }
    }

    // ── Login wall normalization ─────────────────────────────────────────────
    // browser.agent returns loginWallDetected: true when auth is needed but may
    // omit askUser/question.  Normalize so the ask_user short-circuit below fires.
    if (raw.loginWallDetected === true && !raw.askUser) {
      raw.askUser = true;
      raw.question = raw.question || `${(raw.agentId || skill).replace('.agent', '')} requires sign-in. A browser window has been opened — please sign in there.`;
      raw.options = raw.options || [];
      logger.info(`[Node:ExecuteCommand] normalized loginWallDetected → askUser for ${raw.agentId || skill}`);
    }

    // ── Agent ask_user short-circuit ──────────────────────────────────────────
    // When cli.agent (or browser.agent api_key path) returns askUser: true, surface
    // the agent's exact question directly without routing through recoverSkill.
    // recoverSkill would call the LLM independently and generate a different question.
    if (raw.agentId && raw.askUser === true && raw.question) {
      logger.info(`[Node:ExecuteCommand] agent ask_user: "${String(raw.question).slice(0, 80)}"`);
      const askUserStep = {
        step: skillCursor + 1, skill, args: resolvedArgs, description,
        ok: false, askUser: true, error: raw.question,
      };
      if (progressCallback) {
        // Emit ask_user (amber question card) instead of step_failed (red error badge).
        // The question is an expected clarification request, not a system failure.
        progressCallback({
          type: 'ask_user',
          question: raw.question,
          options: raw.options || [],
          stepIndex: skillCursor,
          skill,
          description: description || skill,
          source: 'agent_ask_user',
        });
      }
      return {
        ...state,
        skillResults: [...skillResults, askUserStep],
        skillCursor,
        failedStep: null,
        recoveryAction: 'ask_user',
        pendingQuestion: {
          question: raw.question,
          options:  raw.options || [],
          context:  `${description || skill} (step ${skillCursor + 1})`,
          _isAgentAskUser: true,
          agentId: raw.agentId || null,
          needsCredentials: raw.needsCredentials || false,
        },
        commandExecuted: false,
      };
    }

    // ── Wrong-destination gate ─────────────────────────────────────────────────
    // browser.agent pre-navigation resolver detected a mismatch between task intent
    // and configured startUrl, and no high-confidence auto-correction was available.
    // Propagate the resolver's question verbatim so recoverSkill picks it up as a
    // fast-path ASK_USER without calling the LLM.
    if (skill === 'browser.agent' && raw.askUser === true && raw.wrongDestination) {
      logger.info(`[Node:ExecuteCommand] wrong-destination: "${raw.agentId}" — routing to recoverSkill fast-path`);
      const wdStep = {
        step: skillCursor + 1, skill, args: resolvedArgs, description,
        ok: false, error: raw.question || 'Wrong destination detected',
        wrongDestination: true,
        question:  raw.question,
        options:   raw.options || [],
      };
      if (progressCallback) progressCallback({
        type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill,
        error: wdStep.error,
      });
      return {
        ...state,
        skillResults: [...skillResults, wdStep],
        skillCursor,
        failedStep: wdStep,
        commandExecuted: false,
      };
    }

    // ── OAuth gate ────────────────────────────────────────────────────────────
    // external.skill returns needsOAuth when a declared provider has no stored token.
    // Pause execution, show the OAuth connect modal, and retry the same step once
    // the user has connected. Mirrors the gather:credential pattern.
    if (raw.needsOAuth && raw.needsOAuth.provider) {
      const { provider, providers, tokenKey, scopes } = raw.needsOAuth;
      const skillLabel = skill === 'external.skill' ? (resolvedArgs.name || '') : skill;
      logger.warn(`[Node:ExecuteCommand] OAuth required for skill "${skillLabel}" — provider: ${provider}`);
      if (progressCallback) progressCallback({
        type:       'gather_oauth',
        provider,
        tokenKey:   tokenKey || `oauth:${provider}`,
        scopes:     scopes || '',
        skillName:  skillLabel,
        stepIndex:  skillCursor,
        totalSteps: skillPlan.length,
        message:    raw.error || `Connect ${provider} to continue`,
      });
      const gatherOAuthCallback = state.gatherOAuthCallback || null;
      if (typeof gatherOAuthCallback === 'function') {
        let oauthResult;
        try { oauthResult = await gatherOAuthCallback(provider, tokenKey || `oauth:${provider}`); } catch (_) {}
        if (oauthResult?.connected) {
          // Token now in keytar — retry this step by returning without advancing cursor
          logger.info(`[Node:ExecuteCommand] OAuth connected for ${provider} — retrying step ${skillCursor + 1}`);
          return { ...state, skillResults, skillCursor, commandExecuted: false, failedStep: null };
        }
      }
      // User skipped or no callback — surface as a failed step
      const oauthFailStep = {
        step: skillCursor + 1, skill, args: resolvedArgs, description,
        ok: false, needsOAuth: true,
        error: raw.error || `OAuth connection required: ${providers ? providers.join(', ') : provider}`,
      };
      if (progressCallback) progressCallback({
        type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill,
        error: oauthFailStep.error,
      });
      return { ...state, skillResults: [...skillResults, oauthFailStep], skillCursor, failedStep: oauthFailStep, commandExecuted: false };
    }
    // ─────────────────────────────────────────────────────────────────────────

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
      stdout: raw.stdout || raw.output || waitForStdout || browserStdout || fsReadStdout || null,
      stderr: raw.stderr || null,
      exitCode: raw.exitCode ?? null,
      result: raw.result
        ?? (skill === 'user.agent' ? { resolved: raw.resolved, summary: raw.summary, action: raw.action } : null)
        ?? (skill === 'file.watch' ? raw : null),
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
      suggestion: raw.suggestion || null,
      output: raw.output || null,
      missingPath: raw.missingPath || null,
      toolName: raw.toolName || null,
      stderrHint: raw.stderrHint || null,
      userAllowlistHint: !!raw.userAllowlistHint,
      commandName: raw.commandName || null,
      userAllowlistPath: raw.userAllowlistPath || null,
      cmd: raw.cmd || null,
    };

    // Detect shell.run search commands that returned no results — treat as soft failure
    // so recoverSkill can REPLAN with a different search strategy (e.g. mdfind → find)
    // NOTE: only applies to shell.run, never browser.act
    // NOTE: bash scripts that also contain write/edit ops (sed -i, cp, mv, echo >, tee, cat >)
    //       are NOT pure searches — no output is expected and is a success.
    const SEARCH_CMDS = ['mdfind', 'find', 'grep', 'locate'];
    const WRITE_OPS = ['sed -i', 'sed -E -i', 'cp ', 'mv ', 'echo ', 'tee ', 'cat >', 'cat>',
                       'printf ', 'write ', 'rm ', 'mkdir ', 'touch ', 'chmod ', 'chown '];
    const isGoalMode = skill === 'shell.run' && !!args.goal && !args.cmd;
    const bashScript = !isGoalMode && args.cmd === 'bash' && Array.isArray(args.argv)
      ? args.argv.find(a => typeof a === 'string') || ''
      : '';
    const isBashSearchScript = bashScript.length > 0 &&
      SEARCH_CMDS.some(sc => bashScript.includes(sc)) &&
      !WRITE_OPS.some(wo => bashScript.includes(wo));
    const isSearchCmd = !isGoalMode && skill === 'shell.run' && (SEARCH_CMDS.includes(args.cmd) || isBashSearchScript);
    const noOutput = !stepResult.stdout || stepResult.stdout.trim().length === 0;

    if (isSearchCmd && noOutput && (stepResult.ok || stepResult.exitCode === 1)) {
      stepResult.ok = false;
      stepResult.error = `search_no_results: search returned no results for the given query`;
    }

    let enrichedStepResult = stepResult;

    // ── shell.run curl: detect HTTP API error responses ──────────────────────
    // curl returns exit code 0 even on HTTP 4xx/5xx errors. Check stdout for
    // common API error patterns so we don't report false success to the user.
    if (skill === 'shell.run' && stepResult.ok && stepResult.stdout) {
      const out = stepResult.stdout.trim();
      const isCurlStep = !isGoalMode && ((args.cmd === 'curl') ||
        (args.cmd === 'bash' && Array.isArray(args.argv) && args.argv.some(a => typeof a === 'string' && a.includes('curl '))));
      if (isCurlStep) {
        // Match JSON error responses: {"http_code":401,...}, {"error":...}, {"response_code":"UNAUTHORIZED",...}
        const httpCodeMatch = out.match(/"http_code"\s*:\s*(\d+)/);
        const httpCode = httpCodeMatch ? parseInt(httpCodeMatch[1], 10) : 0;
        const hasErrorField = /"error"\s*:/i.test(out) || /"response_code"\s*:\s*"(?!SUCCESS)/i.test(out);
        const hasAuthError = /UNAUTHORIZED|FORBIDDEN|invalid.{0,20}(key|token|credential|auth)/i.test(out);
        // Google-style: {"error":{"code":403,...}} — JSON body with numeric HTTP status code >= 400
        const jsonErrorCodeMatch = out.match(/"code"\s*:\s*(\d{3})/);
        const jsonErrorCode = jsonErrorCodeMatch ? parseInt(jsonErrorCodeMatch[1], 10) : 0;
        // Google-style status strings: PERMISSION_DENIED, NOT_FOUND, SERVICE_DISABLED, UNAUTHENTICATED, etc.
        const hasApiStatusError = /"status"\s*:\s*"(PERMISSION_DENIED|NOT_FOUND|SERVICE_DISABLED|UNAUTHENTICATED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|INVALID_ARGUMENT|UNAVAILABLE)"/i.test(out);

        if ((httpCode >= 400) || (hasErrorField && hasAuthError) || (hasErrorField && jsonErrorCode >= 400) || hasApiStatusError) {
          const briefError = out.length > 200 ? out.slice(0, 200) + '...' : out;
          stepResult.ok = false;
          stepResult.error = `API error (HTTP ${httpCode || '4xx'}): ${briefError}`;
          logger.warn(`[Node:ExecuteCommand] shell.run curl returned API error: ${briefError}`);
        }
      }
    }

    // ── shell.run credential guard: bash scripts that check creds and echo a guard message ──
    // When bash does `if [ -n "$VAR" ]; then curl ...; else echo 'Missing credentials'; fi`
    // and $VAR is empty, exit code is 0 but the curl never ran. Detect this pattern and
    // treat it as a credential failure so recoverSkill can surface the right message.
    if (skill === 'shell.run' && stepResult.ok && stepResult.stdout) {
      const _out = stepResult.stdout.trim();
      const _isMissingCred = /^(missing credentials?|no credentials?|credentials? not found|credentials? (are )?missing|credentials? empty|please (set|add|enter|provide) (your )?(credentials?|api key|username|password))/i.test(_out);
      if (_isMissingCred) {
        stepResult.ok = false;
        stepResult.error = `Missing credentials: ${_out} — please enter your API credentials in the Skills tab`;
        logger.warn(`[Node:ExecuteCommand] shell.run credential guard fired: ${_out}`);
      }
    }

    // ── shell.run curl: write full payload to ~/.thinkdrop/tmp/ + inline payload.check ──
    // For any curl-based shell.run step that returns valid JSON and is still ok=true at
    // this point, write the raw payload to disk and run an LLM semantic check. This
    // catches application-level failures (e.g. INVALID_RECIPIENT nested inside messages[])
    // that the HTTP-level curl guard above cannot see.
    {
      const _isCurlForPayload = !isGoalMode && skill === 'shell.run' && stepResult.ok && stepResult.stdout &&
        ((args.cmd === 'curl') ||
         (args.cmd === 'bash' && Array.isArray(args.argv) && args.argv.some(a => typeof a === 'string' && a.includes('curl '))));

      if (_isCurlForPayload && /^\s*[\[{]/.test(stepResult.stdout.trim())) {
        // Sub-change B: write raw payload to tmp file
        try {
          const _pcFs   = require('fs');
          const _pcPath = require('path');
          const _pcOs   = require('os');
          const _pcTmpDir = _pcPath.join(_pcOs.homedir(), '.thinkdrop', 'tmp');
          if (!_pcFs.existsSync(_pcTmpDir)) _pcFs.mkdirSync(_pcTmpDir, { recursive: true });
          const _pcSlug = (description || args.cmd || 'api')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
          const _pcTmpPath = _pcPath.join(_pcTmpDir, `payload-${_pcSlug}-${Date.now()}.json`);
          _pcFs.writeFileSync(_pcTmpPath, stepResult.stdout, 'utf8');
          stepResult._tmpPayloadFile = _pcTmpPath;
          logger.debug(`[Node:ExecuteCommand] payload.check: wrote ${stepResult.stdout.length} chars → ${_pcTmpPath}`);
        } catch (_pcWriteErr) {
          logger.warn(`[Node:ExecuteCommand] payload.check: tmp write failed: ${_pcWriteErr.message}`);
        }

        // Sub-change C: inline LLM semantic check
        const _pcLlm = state.llmBackend;
        if (_pcLlm && stepResult._tmpPayloadFile) {
          try {
            const _pcFs2    = require('fs');
            const _pcPath2  = require('path');
            const _payloadStr = _pcFs2.readFileSync(stepResult._tmpPayloadFile, 'utf8');
            const _pcPromptRaw = _pcFs2.readFileSync(
              _pcPath2.join(__dirname, '../prompts/payload-check.md'), 'utf8'
            );
            const _pcContext = description || step.description || 'API call via curl';
            const _pcPrompt  = _pcPromptRaw
              .replace('{{context}}', _pcContext)
              .replace('{{payload}}', _payloadStr);

            const _pcRaw = await _pcLlm.generateAnswer(_pcPrompt, {
              query: _pcPrompt,
              context: {
                conversationHistory: [],
                systemInstructions: 'You are a strict JSON API response validator. Output only valid JSON, no explanation.',
                intent: 'command_automate',
              },
              options: { maxTokens: 300, temperature: 0, fastMode: true },
            }, { maxTokens: 300, temperature: 0, fastMode: true }, null);

            // Parse — must be valid JSON; on any error we fail open (no-op)
            const _jsonMatch = _pcRaw.match(/\{[\s\S]*\}/);
            if (_jsonMatch) {
              const _pcVerdict = JSON.parse(_jsonMatch[0]);
              logger.debug(`[Node:ExecuteCommand] payload.check verdict: ${_pcVerdict.verdict} (${_pcVerdict.errorType || 'none'})`);

              if (_pcVerdict.verdict === 'APP_ERROR') {
                stepResult.ok    = false;
                stepResult.error = _pcVerdict.explanation || 'API call returned an application-level error';
                stepResult._payloadCheckResult = {
                  reason:       _pcVerdict.errorType === 'user_correctable' ? 'ask_user' : 'replan',
                  explanation:  _pcVerdict.explanation  || '',
                  suggestion:   _pcVerdict.suggestion   || '',
                  affectedField: _pcVerdict.affectedField || null,
                };
                logger.warn(`[Node:ExecuteCommand] payload.check flagged APP_ERROR (${_pcVerdict.errorType}): ${_pcVerdict.explanation}`);
              }
            }
          } catch (_pcErr) {
            // Never block on LLM failure — log and continue
            logger.warn(`[Node:ExecuteCommand] payload.check LLM call failed (non-blocking): ${_pcErr.message}`);
          }
        }
      }
    }

    enrichedStepResult = _enrichFailureContext(stepResult);

    // ── browser.act examine: NEEDS_USER / authRequired → fail fast with user message ──
    // When the page examiner detects a condition the user must fix (not logged in,
    // element doesn't exist, paywall, etc.) surface the message immediately and
    // halt — no point retrying, the issue requires human action.
    if (skill === 'browser.act' && resolvedArgs?.action === 'examine' && raw.needsUser) {
      const examineMsg = raw.userMessage || raw.issue || 'The page is not in the right state to complete this task.';
      const examineExtras = [];
      if (raw.missingElements?.length) examineExtras.push(`Missing: ${raw.missingElements.join(', ')}`);
      if (raw.availableAlternatives?.length) examineExtras.push(`Available: ${raw.availableAlternatives.join(', ')}`);
      const fullMsg = examineExtras.length ? `${examineMsg} (${examineExtras.join(' | ')})` : examineMsg;
      logger.warn(`[Node:ExecuteCommand] examine NEEDS_USER: ${fullMsg}`);
      if (progressCallback) progressCallback({
        type: 'step_failed',
        stepIndex: skillCursor,
        skill,
        description: description || skill,
        error: fullMsg,
        needsUser: true,
      });
      return {
        ...state,
        skillResults: [...skillResults, { ...enrichedStepResult, ok: false, error: fullMsg }],
        skillCursor,
        failedStep: _enrichFailureContext({ ...enrichedStepResult, ok: false, error: fullMsg }),
        commandExecuted: false,
        answer: fullMsg,
        examineBlocked: true,
      };
    }

    // Normalise external.skill result: copy `output` → `stdout` so review/synthesize nodes
    // can treat it the same as shell.run output without special-casing.
    const _normalizedResult = (skill === 'external.skill' && enrichedStepResult.ok && enrichedStepResult.output && !enrichedStepResult.stdout)
      ? { ...enrichedStepResult, stdout: enrichedStepResult.output }
      : enrichedStepResult;

    const updatedResults = [...skillResults, _normalizedResult];

    // ── BLOCKED: OAuth token-file read — inline auto-patch, silent retry ───────
    // When validate() rejects a shell.run because the script reads from
    // ~/.thinkdrop/tokens/, don't route to recoverSkill (LLM round-trip + red X).
    // Strip the token-reading preamble, replace $ACCESS_TOKEN with the correct
    // $<PROVIDER>_ACCESS_TOKEN env var, and silently retry the same step.
    if (
      skill === 'shell.run' &&
      !enrichedStepResult.ok &&
      typeof enrichedStepResult.error === 'string' &&
      enrichedStepResult.error.startsWith('BLOCKED:') &&
      !resolvedArgs._blockedPatched
    ) {
      const _rawArgv = resolvedArgs.argv || [];
      const _PROVIDER_MAP = {
        gcal: 'GOOGLE', google: 'GOOGLE', gmail: 'GOOGLE', gsheets: 'GOOGLE', gdrive: 'GOOGLE',
        ms: 'MICROSOFT', msft: 'MICROSOFT', outlook: 'MICROSOFT', onedrive: 'MICROSOFT',
        spotify: 'SPOTIFY', dropbox: 'DROPBOX', zoom: 'ZOOM',
        slack: 'SLACK', github: 'GITHUB', notion: 'NOTION',
        atlassian: 'ATLASSIAN', jira: 'ATLASSIAN', confluence: 'ATLASSIAN',
        hubspot: 'HUBSPOT',
      };
      const _patchedArgv = _rawArgv.map(a => {
        if (typeof a !== 'string') return a;
        // Derive provider from token file path (e.g. "gcal.event" → "GOOGLE")
        const _providerMatch = a.match(/\.thinkdrop\/tokens\/([a-zA-Z0-9]+)/);
        const _firstSeg = _providerMatch ? _providerMatch[1].toLowerCase() : 'google';
        const _provider = _PROVIDER_MAP[_firstSeg] || _firstSeg.toUpperCase();
        const _envVar = `$${_provider}_ACCESS_TOKEN`;
        let _patched = a;
        // Remove: TOKEN_FILE="..." followed by ; and/or newline (all separator variants)
        _patched = _patched.replace(/TOKEN_FILE="[^"]*"[;\s\n]*/g, '');
        // Remove the ACCESS_TOKEN=$(python3...) or ACCESS_TOKEN=$(cat...) assignment segment
        // Split on both '; ' and '\n' to handle all LLM output formats
        _patched = _patched.split(/;\s*|\n/).filter(seg => {
          const t = seg.trim();
          return t.length > 0 &&
            !t.startsWith('ACCESS_TOKEN=$(') &&
            !t.startsWith('ACCESS_TOKEN=') &&
            !t.startsWith('ACCESS_TOKEN =') &&
            !t.startsWith('TOKEN_FILE=');
        }).join('; ');
        // Remove: if [ -z "$ACCESS_TOKEN" ]; then ... exit 1; fi
        _patched = _patched.replace(/if\s*\[\s*-z\s*['"]\$ACCESS_TOKEN['"]\s*\].*?fi\s*;?\s*/gs, '');
        // Replace remaining $ACCESS_TOKEN / ${ACCESS_TOKEN} refs
        _patched = _patched.replace(/\$\{?ACCESS_TOKEN\}?/g, _envVar);
        // Clean up any leading "; " artifact from the split/join
        _patched = _patched.replace(/^;\s*/, '').trim();
        return _patched;
      });
      const _patchedStep = { ...skillPlan[skillCursor], args: { ...resolvedArgs, argv: _patchedArgv, _blockedPatched: true } };
      const _patchedPlan = skillPlan.map((s, i) => i === skillCursor ? _patchedStep : s);
      logger.info('[Node:ExecuteCommand] BLOCKED token-read auto-patched → retrying with injected env var');
      // Re-emit step_start so the step stays running (no red X shown to user)
      if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill });
      return {
        ...state,
        skillPlan:    _patchedPlan,
        skillResults,         // don't persist the failed result
        skillCursor,          // stay at same step for retry
        failedStep:   null,
        commandExecuted: false,
      };
    }

    // ── CLI / API Scout execution ────────────────────────────────────────────
    // If this step is external.skill AND the skill dir has cli.json or api.json
    // (written by creatorPlanning Scout fast-path), route to the universal runners
    // instead of doing code-gen or failing. Only fires when the MCP call FAILED
    // (external.skill.cjs now handles api.json/cli.json routing internally).
    if (skill === 'external.skill' && !stepResult.ok) {
      const SKILLS_DIR = require('path').join(require('os').homedir(), '.thinkdrop', 'skills');
      const stepSkillName = resolvedArgs.name || args.name;
      if (stepSkillName) {
        const skillDir    = require('path').join(SKILLS_DIR, stepSkillName);
        const cliJsonPath = require('path').join(skillDir, 'cli.json');
        const apiJsonPath = require('path').join(skillDir, 'api.json');
        const hasCli = require('fs').existsSync(cliJsonPath);
        const hasApi = !hasCli && require('fs').existsSync(apiJsonPath);

        if (hasCli || hasApi) {
          const runnerType = hasCli ? 'CLI' : 'API';
          const logger = state.logger || console;
          logger.info(`[Node:ExecuteCommand] ${runnerType} Scout skill detected — routing to runner`, { skillName: stepSkillName });

          if (progressCallback) progressCallback({
            type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length,
            skill: hasCli ? 'skill-cli-runner' : 'skill-api-runner',
            description: `Running "${stepSkillName}" via ${runnerType} runner…`,
          });

          try {
            // Resolve runner path — walk up from __dirname to find command-service/src.
            // Works from both stategraph-module/src/nodes/ and node_modules/@thinkdrop/stategraph/src/nodes/
            function findCommandServiceSrc() {
              const _path = require('path');
              const _fs   = require('fs');
              let dir = __dirname;
              for (let i = 0; i < 8; i++) {
                const candidate = _path.join(dir, 'mcp-services', 'command-service', 'src');
                if (_fs.existsSync(candidate)) return candidate;
                dir = _path.dirname(dir);
              }
              return null;
            }
            const cmdSvcSrc = findCommandServiceSrc();
            const runnerFile = hasCli ? 'skill-cli-runner.cjs' : 'skill-api-runner.cjs';
            const runnerPath = cmdSvcSrc
              ? require('path').join(cmdSvcSrc, runnerFile)
              : require('path').join(__dirname, '../../../../mcp-services/command-service/src', runnerFile);

            const runner = require(runnerPath);
            const runArgs = { ...(resolvedArgs || {}), ...(args || {}) };
            delete runArgs.name; delete runArgs.secretKeys;

            let runResult = await runner.run(stepSkillName, runArgs, {
              dryRun: runArgs.dryRun === true,
            });

            // ── CLI→API runtime fallback ─────────────────────────────────────
            // If the CLI runner reports the binary is unavailable after install,
            // check if an api.json exists for the same skill and retry via the
            // API runner — no user interaction needed.
            let effectiveRunnerType = runnerType;
            if (!runResult.ok && runResult.cliNotAvailable && hasCli) {
              const _logger = state.logger || console;
              const apiFallbackPath = require('path').join(skillDir, 'api.json');
              if (require('fs').existsSync(apiFallbackPath)) {
                _logger.info(`[Node:ExecuteCommand] CLI→API fallback: "${runResult.error}" — retrying via API runner`, { skillName: stepSkillName });
                if (progressCallback) progressCallback({
                  type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length,
                  skill: 'skill-api-runner',
                  description: `CLI unavailable — retrying "${stepSkillName}" via API runner…`,
                });
                const apiRunnerPath = cmdSvcSrc
                  ? require('path').join(cmdSvcSrc, 'skill-api-runner.cjs')
                  : require('path').join(__dirname, '../../../../mcp-services/command-service/src/skill-api-runner.cjs');
                try {
                  const apiRunner = require(apiRunnerPath);
                  runResult = await apiRunner.run(stepSkillName, runArgs, { dryRun: runArgs.dryRun === true });
                  effectiveRunnerType = 'API';
                } catch (apiFallbackErr) {
                  _logger.warn(`[Node:ExecuteCommand] API fallback runner threw: ${apiFallbackErr.message}`);
                }
              }
            }

            const scoutStepResult = {
              skill,
              args: resolvedArgs,
              ok: runResult.ok,
              result: runResult.result || runResult.output || null,
              error: runResult.error || null,
              runnerType: effectiveRunnerType,
            };

            if (progressCallback) progressCallback({
              type: runResult.ok ? 'step_done' : 'step_error',
              stepIndex: skillCursor,
              totalSteps: skillPlan.length,
              skill: `skill-${effectiveRunnerType.toLowerCase()}-runner`,
              result: scoutStepResult,
            });

            const scoutResults = [...skillResults, scoutStepResult];

            if (!runResult.ok && !optional) {
              return {
                ...state,
                skillResults: scoutResults,
                failedStep: { step: skillCursor, skill, args: resolvedArgs, error: runResult.error, runnerType: effectiveRunnerType },
                skillCursor,
                skillPlan,
              };
            }

            if (skillCursor + 1 >= skillPlan.length) {
              return {
                ...state,
                skillResults: scoutResults,
                skillCursor: skillCursor + 1,
                commandExecuted: true,
                answer: runResult.result || `${runnerType} skill "${stepSkillName}" completed.`,
              };
            }
            return { ...state, skillResults: scoutResults, skillCursor: skillCursor + 1, skillPlan };

          } catch (runnerErr) {
            const logger = state.logger || console;
            logger.warn(`[Node:ExecuteCommand] ${runnerType} runner threw — falling through to code-gen`, { error: runnerErr.message });
            // Fall through to normal missing-skill handling below
          }
        }
      }
    }

    if (!stepResult.ok && !optional) {
      // ── Missing external skill — trigger build pipeline ─────────────────────
      // When external.skill fails because the skill file doesn't exist, don't
      // send to recoverSkill (which has no way to build code). Instead, kick off
      // the skill build pipeline so buildSkill → validateSkill → installSkill runs.
      const isMissingSkill = skill === 'external.skill' &&
        typeof enrichedStepResult.error === 'string' &&
        (enrichedStepResult.error.includes('Skill file not found') ||
         enrichedStepResult.error.includes('No installed skill named'));

      if (isMissingSkill && !!state.creatorProjectId && !state.skillCreatorRegenAttempted && !state.skillCreatorBuildAttempted && mcpAdapter) {
        // Creator skill missing — re-run skillCreator silently before failing (once only)
        const missingSkillName = resolvedArgs.name || args.name;
        logger.info(`[Node:ExecuteCommand] Creator skill "${missingSkillName}" missing — re-running skillCreator silently`);
        if (progressCallback) progressCallback({
          type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length,
          skill: 'skillCreator', description: `Re-generating skill "${missingSkillName}"…`,
        });
        try {
          const regenRes = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'skillCreator.skill',
            args: { action: 'generate_skill', projectId: state.creatorProjectId },
          }, { timeoutMs: 300000 }).catch(e => ({ ok: false, error: e.message }));
          const regen = regenRes?.data || regenRes;
          if (regen?.ok && regen?.skillPath) {
            logger.info(`[Node:ExecuteCommand] skillCreator re-gen succeeded: ${regen.skillPath}`);
            return {
              ...state,
              creatorSkillName: regen.skillName || missingSkillName,
              creatorSkillPath: regen.skillPath,
              skillCreatorRegenAttempted: true,
              skillPlan,
              skillCursor,
              skillResults: updatedResults.slice(0, -1),
            };
          }
          logger.warn(`[Node:ExecuteCommand] skillCreator re-gen failed: ${regen?.error}`);
        } catch (regenErr) {
          logger.warn(`[Node:ExecuteCommand] skillCreator re-gen threw: ${regenErr.message}`);
        }
      }

      // ── No creatorProjectId — skill was installed as a stub but never built ──
      // Kick off creator.agent create_project → skillCreator generate_skill to
      // actually build the index.cjs file, install deps, and register the skill.
      // After a successful build, retry the external.skill step (once only).
      //
      // GUARD: Do NOT build on-demand if the skill name looks like a capability
      // that gatherContext+creatorPlanning owns (sms, email, payment, etc.).
      // Those need provider-specific context the gatherContext pipeline collects.
      // Building here would produce generic/wrong code (e.g. hardcoded Twilio).
      const _missingName = (resolvedArgs.name || args.name || '').toLowerCase();
      const _capabilityPrefixes = ['sms', 'email', 'send', 'message', 'text', 'payment', 'storage', 'notify', 'call', 'voice', 'mail', 'push'];
      const _nameSegments = _missingName.split('.');
      const _isCapabilitySkill = _capabilityPrefixes.some(p =>
        _nameSegments.includes(p) || _missingName.startsWith(p + '.') || _missingName === p || _missingName.startsWith(p + '_')
      );
      // Also block creator.agent when user explicitly asked to install/create a skill — bootstrap flow should handle it
      const _userMsg = (state.message || state.resolvedMessage || '').toLowerCase();
      const _isInstallRequest = /\b(install|create|add|build|need|want)\b.*\bskill\b/i.test(_userMsg);
      if (isMissingSkill && (_isCapabilitySkill || _isInstallRequest)) {
        logger.warn(`[Node:ExecuteCommand] Blocking on-demand build for "${_missingName}" — ${_isInstallRequest ? 'install request → bootstrap flow' : 'capability skill → gatherContext pipeline'}`);
        // Fall through to recoverSkill with a clear error
      }
      if (isMissingSkill && !_isCapabilitySkill && !_isInstallRequest && !state.creatorProjectId && !state.skillCreatorBuildAttempted && mcpAdapter) {
        const missingSkillName = resolvedArgs.name || args.name;
        // Build a focused skill description from the step args — NOT the full user task message.
        // The full message (e.g. "research photosynthesis and text me") describes the overall task,
        // not what the missing skill should do. Use the step args to describe the skill's purpose.
        const stepArgsDesc = Object.entries(resolvedArgs.args || resolvedArgs || {})
          .filter(([k]) => k !== 'name')
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120)}`)
          .join(', ');
        const skillPrompt = `Create a ThinkDrop skill named "${missingSkillName}" that: ${stepArgsDesc || `implements the ${missingSkillName} capability`}. The skill should be a standalone Node.js CommonJS module that accepts runtime args and uses REST APIs or npm packages to accomplish its task. It must NOT use any relative require() paths or command-service internal files.`;
        logger.info(`[Node:ExecuteCommand] Skill "${missingSkillName}" has no index.cjs — kicking off creator.agent + skillCreator build pipeline`);
        logger.debug(`[Node:ExecuteCommand] creator.agent prompt: ${skillPrompt.slice(0, 200)}`);

        if (progressCallback) progressCallback({
          type: 'skill_build_phase',
          phase: 'planning',
          skillName: missingSkillName,
          round: 1,
        });

        try {
          // Step 1: creator.agent create_project — BDD, plan.md, agents.md
          logger.info(`[Node:ExecuteCommand] creator.agent create_project for "${missingSkillName}"`);
          if (progressCallback) progressCallback({
            type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length,
            skill: 'creator.agent', description: `Planning skill "${missingSkillName}"…`,
          });

          const createRes = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'creator.agent',
            args: { action: 'create_project', prompt: skillPrompt, name: missingSkillName },
          }, { timeoutMs: 360000 }).catch(e => ({ ok: false, error: e.message }));
          const created = createRes?.data || createRes;

          if (!created?.ok || !created?.id) {
            logger.warn(`[Node:ExecuteCommand] creator.agent create_project failed: ${created?.error}`);
            // Fall through to recoverSkill
          } else {
            // Step 2: skillCreator generate_skill — generates index.cjs, installs deps
            logger.info(`[Node:ExecuteCommand] skillCreator generate_skill for project "${created.id}"`);
            if (progressCallback) progressCallback({
              type: 'skill_build_phase',
              phase: 'generating',
              skillName: missingSkillName,
              round: 1,
            });

            const genRes = await mcpAdapter.callService('command', 'command.automate', {
              skill: 'skillCreator.skill',
              args: { action: 'generate_skill', projectId: created.id, projectDir: created.dir },
            }, { timeoutMs: 360000 }).catch(e => ({ ok: false, error: e.message }));
            const generated = genRes?.data || genRes;

            if (generated?.ok && generated?.skillPath) {
              logger.info(`[Node:ExecuteCommand] Skill "${missingSkillName}" built at ${generated.skillPath} — retrying external.skill step`);
              if (progressCallback) progressCallback({
                type: 'skill_build_phase',
                phase: 'complete',
                skillName: generated.skillName || missingSkillName,
                round: 1,
              });
              // Retry the failed external.skill step (cursor stays, remove failed result)
              return {
                ...state,
                creatorProjectId: created.id,
                creatorSkillName: generated.skillName || missingSkillName,
                creatorSkillPath: generated.skillPath,
                skillCreatorBuildAttempted: true,
                skillPlan,
                skillCursor,
                skillResults: updatedResults.slice(0, -1), // remove the failed step so it retries
                failedStep: null,
              };
            }
            logger.warn(`[Node:ExecuteCommand] skillCreator generate_skill failed: ${generated?.error}`);
          }
        } catch (buildErr) {
          logger.warn(`[Node:ExecuteCommand] creator.agent/skillCreator build threw: ${buildErr.message}`);
        }
        // Build failed — fall through to recoverSkill
      }

      // ── Pre-recoverSkill: open <file> with wrong extension → glob for real file ──
      // When `open <path>` or `open -a <App> <path>` fails with exit code 1, the most
      // common cause is a wrong extension guess (e.g. prompts.txt vs prompts.rtf).
      // Before escalating to recoverSkill (which asks the user), glob-search the
      // directory for any file whose stem matches. If found, auto-patch and retry.
      if (skill === 'shell.run' && (stepResult.exitCode === 1 || stepResult.exitCode === 3)) {
        const _argv = resolvedArgs?.argv || [];
        const _script = (resolvedArgs?.cmd === 'bash' && Array.isArray(_argv))
          ? (_argv.find(a => typeof a === 'string' && a !== '-c') || '')
          : _argv.join(' ');
        // Extract file path from: open '/path/to/file' or open -a App '/path/to/file'
        const _openPathMatch = _script.match(/\bopen\b(?:\s+-a\s+\S+)?\s+['"]?([^\s'"]+)['"']?\s*$/);
        if (_openPathMatch) {
          const _failedPath = _openPathMatch[1];
          const _pathModule = require('path');
          const _fsModule = require('fs');
          const _dir = _pathModule.dirname(_failedPath);
          const _stem = _pathModule.basename(_failedPath, _pathModule.extname(_failedPath));
          try {
            const _entries = _fsModule.readdirSync(_dir);
            const _match = _entries.find(e => {
              const eStem = _pathModule.basename(e, _pathModule.extname(e));
              return eStem.toLowerCase() === _stem.toLowerCase() && e !== _pathModule.basename(_failedPath);
            });
            if (_match) {
              const _fixedPath = _pathModule.join(_dir, _match);
              logger.info(`[Node:ExecuteCommand] open file: auto-patching extension "${_failedPath}" → "${_fixedPath}"`);
              // Rebuild the argv with corrected path
              const _fixedArgv = _argv.map(a => {
                if (typeof a !== 'string') return a;
                return a.split(_failedPath).join(_fixedPath);
              });
              const _patchedPlan = skillPlan.map((s, i) =>
                i === skillCursor ? { ...s, args: { ...s.args, argv: _fixedArgv } } : s
              );
              // Remove the failed result so it retries cleanly
              return {
                ...state,
                skillPlan: _patchedPlan,
                skillResults: updatedResults.slice(0, -1),
                skillCursor,
                failedStep: null,
                commandExecuted: false,
              };
            }
          } catch (_e) {
            // readdirSync failed (dir doesn't exist, permissions) — fall through to recoverSkill
          }
        }
      }

      // Step failed and is not optional — hand off to recoverSkill
      logger.warn(`[Node:ExecuteCommand] Step ${skillCursor + 1} failed: ${enrichedStepResult.error}`);
      if (progressCallback) progressCallback({
        type: 'step_failed',
        stepIndex: skillCursor,
        skill,
        description: description || skill,
        error: enrichedStepResult.error,
        stderr: enrichedStepResult.stderr,
        userAllowlistHint: enrichedStepResult.userAllowlistHint || false,
        commandName: enrichedStepResult.commandName || null,
      });
      return {
        ...state,
        skillResults: updatedResults,
        skillCursor,           // cursor stays at failed step
        failedStep: enrichedStepResult,
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
      // web.crawl: synthesize a human-readable stdout from title + content length
      if (skill === 'web.crawl' && raw.ok) {
        const crawlTitle = raw.title ? `"${raw.title}"` : resolvedArgs.url || '';
        const crawlChars = raw.contentLength ? ` — ${raw.contentLength.toLocaleString()} chars` : '';
        const crawlTrunc = raw.truncated ? ' (truncated)' : '';
        stepResult.stdout = `Crawled ${crawlTitle}${crawlChars}${crawlTrunc}\n\n${raw.content || ''}`;
        logger.info(`[Node:ExecuteCommand] web.crawl done: ${crawlTitle}${crawlChars}${crawlTrunc}`);
      }
      // web.agent: synthesize a human-readable stdout so synthesize/reviewExecution can read the result
      if (skill === 'web.agent' && raw.ok && raw.bestUrl) {
        const webAgentTitle = raw.title ? ` — "${raw.title}"` : '';
        stepResult.stdout = `Best URL: ${raw.bestUrl}${webAgentTitle}`;
        if (raw.snippet) stepResult.stdout += `\n${raw.snippet}`;
        logger.info(`[Node:ExecuteCommand] web.agent search_and_navigate: bestUrl=${raw.bestUrl}`);
      } else if (skill === 'web.agent' && raw.ok && !raw.bestUrl) {
        // web.agent succeeded but found no URL (score=0) — still set stdout so {{prev_stdout}}
        // is never empty, preventing downstream steps from navigating to a literal token.
        const fallbackText = raw.snippet || raw.query || resolvedArgs.query || 'No URL found';
        stepResult.stdout = `web.agent: no URL found. Query: ${fallbackText}`;
        logger.info(`[Node:ExecuteCommand] web.agent search_and_navigate: no bestUrl — stdout set to fallback`);
      }
      const resolvedSkillName = skill === 'external.skill'
        ? (stepResult.skillName || resolvedArgs.name || 'external.skill')
        : null;
      const stepDoneDescription = description || (resolvedSkillName ? `external.skill — ${resolvedSkillName}` : skill);
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: stepDoneDescription, stdout: stepResult.stdout || stepResult.output, exitCode: stepResult.exitCode });

      // ── Auth wall detected by waitForStableText or navigate ─────────────────
      // When waitForStableText (or navigate cold-start) returns authRequired:true
      // the page is a login wall. Spawn a login sub-plan rather than silently
      // skipping — this gives the engine a chance to authenticate autonomously
      // (using stored credentials) or ask the user for credentials (guide.step)
      // before retrying the original task.
      const isAuthWallResult = raw.authRequired && (
        resolvedArgs.action === 'waitForStableText' ||
        resolvedArgs.action === 'navigate'
      );
      if (skill === 'browser.act' && isAuthWallResult) {
        const authSessionId = resolvedArgs.sessionId || '';
        // Derive the original URL (the service we actually wanted to reach)
        const navStep = [...skillResults].reverse().find(
          r => r.skill === 'browser.act' && r.args?.action === 'navigate' && r.args?.sessionId === authSessionId
        );
        const authLoginUrl = navStep?.args?.url || resolvedArgs.url || state.activeBrowserUrl || '';
        const authSite = (() => {
          try { return new URL(authLoginUrl).hostname.replace(/^www\./, ''); }
          catch (_) { return authSessionId || 'this site'; }
        })();

        logger.info(`[Node:ExecuteCommand] Auth wall on ${authSite} (session=${authSessionId}) — routing to login sub-plan`);

        const authWallFailedStep = {
          step:        skillCursor + 1,
          skill,
          args:        resolvedArgs,
          description,
          ok:          false,
          reason:      'auth_wall',
          service:     authSite,
          loginUrl:    authLoginUrl,
          sessionId:   authSessionId,
          error:       `auth_wall_detected: login required for ${authSite}`,
          pageContext:  raw.authWallText || raw.result || '',
        };

        if (progressCallback) progressCallback({
          type:      'auth_wall_detected',
          stepIndex: skillCursor,
          service:   authSite,
          message:   `Login required for ${authSite} — spawning login sub-plan`,
        });

        return {
          ...state,
          skillResults:            [...skillResults, authWallFailedStep],
          skillCursor,
          failedStep:              authWallFailedStep,
          commandExecuted:         false,
          activeBrowserSessionId:  authSessionId || state.activeBrowserSessionId,
          activeBrowserUrl:        authLoginUrl  || state.activeBrowserUrl,
        };
      }
    }

    // Track the active browser sessionId and URL for follow-up tasks
    // Extend tracking to browser.agent steps: derive sessionId from agentId
    const activeBrowserSessionId =
      (skill === 'browser.act' && stepResult.ok && args.sessionId)
        ? args.sessionId
      : (skill === 'browser.agent' && stepResult.ok && args.agentId)
        ? `${args.agentId.replace('.agent', '')}_agent`
        : state.activeBrowserSessionId || null;
    const activeBrowserUrl = skill === 'browser.act' && stepResult.ok && raw.url
      ? raw.url
      : state.activeBrowserUrl || null;

    // ── Post-navigate scan ────────────────────────────────────────────────────
    // After every successful navigate OR press Enter (form submit → navigation),
    // scan the live page to get real elements for the next step.
    const isPressEnter = skill === 'browser.act' && resolvedArgs.action === 'press' && /^(Enter|Return)$/i.test(resolvedArgs.key || resolvedArgs.text || '');
    // Skip scan when the next plan step is already snapshot/examine/scanCurrentPage —
    // running scanCurrentPage + snapshot concurrently on the same playwright-cli session
    // causes a race that kills the session ("Session closed" error).
    const nextPlanStep = skillPlan[skillCursor + 1];
    const nextIsSnapshot = nextPlanStep?.skill === 'browser.act' &&
      ['snapshot', 'examine', 'scanCurrentPage'].includes(nextPlanStep?.args?.action);
    if (skill === 'browser.act' && (resolvedArgs.action === 'navigate' || isPressEnter) && stepResult.ok && resolvedArgs.sessionId && mcpAdapter && !nextIsSnapshot) {
      const navSessionId = resolvedArgs.sessionId;
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

          // ── Login page detection ──────────────────────────────────────────
          // Only trigger on definitive auth/login URL patterns — never on page labels.
          // Label matching ("Log in", "Sign in") causes false positives on sites like
          // chatgpt.com that show these buttons even when the page is fully accessible.
          // Definitive login URLs: Google accounts, /login, /signin, /sign-in paths, OAuth endpoints.
          const isLoginUrl = /accounts\.google\.com\/|\/login(\?|$|\/)|\/signin(\?|$|\/)|\/sign-in(\?|$|\/)|\/sign_in(\?|$|\/)|\/oauth\/|\/sso(\?|$|\/)|\/auth\/login|\/auth\/signin/i.test(actualUrl);

          if (isLoginUrl) {
            // Check if the NEXT step in the plan is waitForAuth — if so, skip ahead
            // to the ASK_USER so the user can log in. waitForAuth timeout was 60s+ and hung.
            const nextStep = skillPlan[skillCursor + 1];
            const nextIsWaitForAuth = nextStep?.skill === 'browser.act' && nextStep?.args?.action === 'waitForAuth';
            const targetSite = (() => { try { return new URL(resolvedArgs.url || actualUrl).hostname; } catch (_) { return actualUrl; } })();

            logger.info(`[Node:ExecuteCommand] Post-navigate: login page detected on ${actualUrl} — surfacing ASK_USER${nextIsWaitForAuth ? ' (skipping queued waitForAuth)' : ''}`);
            return {
              ...state,
              skillResults: updatedResults,
              // Skip past the waitForAuth step if it's next — user will confirm when done
              skillCursor: nextIsWaitForAuth ? skillCursor + 2 : skillCursor + 1,
              failedStep: null,
              activeBrowserSessionId,
              activeBrowserUrl: actualUrl || activeBrowserUrl,
              activeBrowserPageElements: { url: actualUrl, elements: els },
              recoveryAction: 'ask_user',
              pendingQuestion: {
                question: `The browser landed on the login page for **${targetSite}**. Please log in, then click "I'm logged in — continue".`,
                options: ["I'm logged in — continue", 'Skip this site', 'Abort the task'],
                context: { loginUrl: actualUrl }
              },
              commandExecuted: false,
              answer: `I need you to log in to **${targetSite}** in the browser. Once you're signed in, click "I'm logged in — continue" below.`
            };
          }

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

    // ── Sub-plan last-step pop ────────────────────────────────────────────────
    // When inside a sub-plan (subPlanStack non-empty) and the last step just
    // finished, pop back to the parent plan immediately instead of routing to
    // reviewExecution/all_done.  The parent plan resumes at the step that
    // originally triggered the sub-plan.
    if (isLastStep && Array.isArray(state.subPlanStack) && state.subPlanStack.length > 0) {
      const { completeSubPlan } = require('../utils/subPlanEngine');
      const resumed = completeSubPlan({ ...state, skillResults: updatedResults });
      logger.info(`[Node:ExecuteCommand] Sub-plan last-step complete — resuming parent plan at cursor ${resumed.skillCursor}`);
      return {
        ...state,
        ...resumed,        // subPlanStack (popped), skillPlan (parent), skillCursor (retry step)
        skillResults:      updatedResults,
        commandExecuted:   false,
        failedStep:        null,
        activeBrowserSessionId,
        activeBrowserUrl,
      };
    }

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
      // external.skill result — the Node.js skill returned a string in the `output` field.
      // Must be checked before the shell.run fallback — external.skill produces rich markdown reports.
      const lastExternalSkillResult = [...updatedResults].reverse().find(r => r.skill === 'external.skill' && r.ok && r.output?.trim());
      // Last getPageText result — the actual page content the user asked for.
      // Prefer getPageText (explicit canonical read); fall back to waitForStableText
      // only for older plans that lack an explicit getPageText step.
      const _getPageTextResult2 = [...updatedResults].reverse().find(r =>
        r.skill === 'browser.act' && r.ok && r.args?.action === 'getPageText' && (r.result || r.stdout)
      );
      const pageTextResult = _getPageTextResult2 || [...updatedResults].reverse().find(r =>
        r.skill === 'browser.act' && r.ok && r.args?.action === 'waitForStableText' && (r.result || r.stdout)
      );
      const pageTextContent = pageTextResult
        ? (typeof pageTextResult.result === 'string' && pageTextResult.result ? pageTextResult.result : pageTextResult.stdout)
        : null;

      if (imageAnalyzeResult) {
        lastStepAnswer = imageAnalyzeResult.stdout;
      } else if (lastExternalSkillResult) {
        // Node.js skill returned a string report — stream it directly.
        lastStepAnswer = lastExternalSkillResult.output;
        logger.debug(`[Node:ExecuteCommand] synthesize: external.skill answer (${lastStepAnswer.length} chars) from "${lastExternalSkillResult.skillName || lastExternalSkillResult.args?.name || 'unknown'}"`);
      } else if (pageTextContent) {
        // Raw innerText may have literal "\n" escape sequences (from JSON serialization) — convert to real newlines.
        // Also collapse runs of 3+ blank lines into 2 so the output isn't excessively spaced.
        const cleanedPageText = pageTextContent
          .replace(/\\n/g, '\n')       // literal \n → real newline
          .replace(/\\t/g, '\t')       // literal \t → real tab
          .replace(/\n{3,}/g, '\n\n')  // 3+ blank lines → 2
          .trim();
        // Synthesize a concise answer via LLM instead of dumping raw page text.
        // Truncate page content to ~8k chars for the LLM context window.
        if (state.llmBackend && cleanedPageText.length > 50) {
          try {
            const truncatedText = cleanedPageText.slice(0, 8000);
            const originalPrompt = state.message || '';
            const synthesized = await state.llmBackend.generateAnswer(
              truncatedText,
              {
                query: `Summarize the browser page content that was retrieved for: "${originalPrompt}"`,
                context: {
                  systemInstructions: `You are a helpful assistant. A browser automation task has already been completed — the browser navigated to a website and extracted the page text shown below. Your job is ONLY to summarize that extracted content in response to the user's original request: "${originalPrompt}". IMPORTANT: Do NOT say you cannot access the internet, perform searches, or retrieve real-time data — the browser task is already done and the results are in the text below. Provide a concise summary (2–5 sentences or a short bullet list) focusing on what directly answers the user's request. Do not repeat the full page text verbatim.`,
                  conversationHistory: [],
                  intent: 'command_automate',
                },
                options: { maxTokens: 300, temperature: 0.3 },
              },
              { maxTokens: 300, temperature: 0.3 },
              null
            ).catch(() => null);
            if (synthesized && synthesized.trim()) {
              lastStepAnswer = synthesized.trim();
            } else {
              lastStepAnswer = cleanedPageText;
            }
          } catch (_) {
            lastStepAnswer = cleanedPageText;
          }
        } else {
          lastStepAnswer = cleanedPageText;
        }
      } else if ([...updatedResults].reverse().find(r => (r.skill === 'cli.agent' || r.skill === 'browser.agent') && r.ok && (r.result || r.stdout))) {
        // ── cli.agent / browser.agent returned an answer — use it as the summary ─
        const _agentRes = [...updatedResults].reverse().find(r => (r.skill === 'cli.agent' || r.skill === 'browser.agent') && r.ok && (r.result || r.stdout));
        const _agentText = _agentRes.result || _agentRes.stdout;
        lastStepAnswer = typeof _agentText === 'string' ? _agentText : JSON.stringify(_agentText);
        logger.debug(`[Node:ExecuteCommand] isLastStep: using ${_agentRes.skill} result as answer (${lastStepAnswer.length} chars)`);
      } else if (hasBrowserSteps && lastBrowserResult?.url) {
        const title = lastBrowserResult.title ? ` — "${lastBrowserResult.title}"` : '';
        lastStepAnswer = `Done! Browser is open at ${lastBrowserResult.url}${title}`;
      } else {
        // ── shell.run readable output: use stdout directly as the answer ─────────
        // When the last step is shell.run and stdout looks like human-readable content
        // (file listing, command output, status check, etc.) rather than a raw JSON
        // API response, stream it directly instead of the generic completion message.
        // Exclusions:
        //   - stdout is a JSON object/array (API response — fire-and-forget, not for display)
        //   - stdout > 4000 chars (should have had a synthesize step; truncate + summarize)
        //   - failedCount > 0 (partial failure message is more useful)
        // Also consider stderr — e.g. brew writes progress/warnings to stderr, not stdout.
        const lastShellResult = failedCount === 0
          ? [...updatedResults].reverse().find(r => r.skill === 'shell.run' && r.ok && (r.stdout?.trim() || r.stderr?.trim()))
          : null;
        if (lastShellResult) {
          const out = (lastShellResult.stdout?.trim() || lastShellResult.stderr?.trim() || '');
          const looksLikeJson = /^\s*[\[{]/.test(out);
          const looksLikeHttpCode = /"http_code"\s*:\s*\d+/.test(out);
          const isReadable = !looksLikeJson && !looksLikeHttpCode && out.length > 0;
          if (isReadable) {
            // Short output (≤4000 chars): show directly
            // Long output: LLM-synthesize a concise summary
            if (out.length <= 4000) {
              lastStepAnswer = out;
            } else if (state.llmBackend) {
              try {
                const originalPrompt = state.message || '';
                const summarized = await state.llmBackend.generateAnswer(
                  out.slice(0, 8000),
                  {
                    query: originalPrompt,
                    context: {
                      systemInstructions: `You are a helpful assistant. The user asked: "${originalPrompt}"\n\nBelow is the terminal output. Summarize the key information concisely. Do not repeat everything verbatim.`,
                      conversationHistory: [],
                      intent: 'command_automate',
                    },
                    options: { maxTokens: 400, temperature: 0.2 },
                  },
                  { maxTokens: 400, temperature: 0.2 },
                  null
                ).catch(() => null);
                lastStepAnswer = (summarized && summarized.trim()) ? summarized.trim() : out.slice(0, 4000);
              } catch (_) {
                lastStepAnswer = out.slice(0, 4000);
              }
            } else {
              lastStepAnswer = out.slice(0, 4000);
            }
          }
        }
        if (!lastStepAnswer) {
          if (failedCount === 0) {
            // Use step descriptions for a more informative completion message
            // rather than the generic "All N steps completed successfully."
            // Silent commands (e.g. `open -a Spotify`) produce no stdout but the
            // plan description ("Open Spotify application") is always available.
            const effectivePlan = patchedSkillPlan || skillPlan;
            const descriptions = effectivePlan.map(s => s.description).filter(Boolean);
            if (descriptions.length === 1) {
              lastStepAnswer = `Done! ${descriptions[0]}`;
            } else if (descriptions.length > 1) {
              lastStepAnswer = descriptions.map(d => `✓ ${d}`).join('\n');
            } else {
              lastStepAnswer = `All ${completedCount} step${completedCount !== 1 ? 's' : ''} completed successfully.`;
            }
          } else {
            lastStepAnswer = `Completed ${completedCount}/${skillPlan.length} steps (${failedCount} failed).`;
          }
        }
      }

      logger.info(`[Node:ExecuteCommand] last-step all_done: savedFilePaths=${JSON.stringify(finalSavedPaths)}`);
      // Update skill plan file status on completion (mirrors early-exit path at line ~550)
      if (state._skillPlanFile) {
        try {
          const _planMd2 = fs.readFileSync(state._skillPlanFile, 'utf8');
          // Deduplicate: when recoverSkill retried a step that originally failed,
          // updatedResults contains both the ok:false first attempt and the ok:true
          // retry for the same step index.  Keep only the best (ok:true) record per
          // step so the plan is correctly marked 'complete' when all retries succeeded.
          const _deduped2 = updatedResults.reduce((acc, r) => {
            const idx = acc.findIndex(x => x.step === r.step);
            if (idx === -1) { acc.push(r); }
            else if (r.ok && !acc[idx].ok) { acc[idx] = r; }
            return acc;
          }, []);
          const _allOk2 = _deduped2.every(r => r.ok);
          const _newStatus2 = _allOk2 ? 'complete' : 'failed';
          const _updatedMd2 = _planMd2.replace(/^(status:\s*)(pending|failed)(\s*)$/m, `$1${_newStatus2}$3`);
          fs.writeFileSync(state._skillPlanFile, _updatedMd2, 'utf8');
          logger.info(`[Node:ExecuteCommand] Plan file status updated to ${_newStatus2}: ${state._skillPlanFile}`);
        } catch (_planErr2) {
          logger.warn(`[Node:ExecuteCommand] Could not update plan file status: ${_planErr2.message}`);
        }
      }
      if (progressCallback) progressCallback({ type: 'all_done', completedCount, totalCount: skillPlan.length, skillResults: updatedResults, savedFilePaths: finalSavedPaths, planFile: state._skillPlanFile || null });

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

      // Note: do NOT re-send lastStepAnswer here via streamCallback.
      // The synthesize LLM call above (line ~2219) passes streamCallback directly to
      // generateAnswer which streams every token live. Sending the full answer again
      // here would duplicate content in the UI.
    }

    // ── Track last opened file path for close-verb context in planSkills ────────
    // When `open <file>` succeeds, store the real path in state so "close it/this/the file"
    // has an authoritative target — no pattern matching or extension guessing needed.
    let lastOpenedFilePath = state.lastOpenedFilePath || null;
    if (skill === 'shell.run' && stepResult.ok) {
      const _trackArgv = resolvedArgs?.argv || [];
      const _trackScript = (resolvedArgs?.cmd === 'bash' && Array.isArray(_trackArgv))
        ? (_trackArgv.find(a => typeof a === 'string' && a !== '-c') || '')
        : _trackArgv.join(' ');
      const _openMatch = _trackScript.match(/\bopen\b(?:\s+-a\s+\S+)?\s+['"]?([^\s'"]+\.[a-zA-Z0-9]+)['"]?\s*$/);
      if (_openMatch) {
        lastOpenedFilePath = _openMatch[1];
        logger.info(`[Node:ExecuteCommand] Tracked lastOpenedFilePath: "${lastOpenedFilePath}"`);
      }
    }

    // Step succeeded (or was optional) — advance cursor
    // Capture bestUrl from web.agent so {{bestUrl}} resolves in subsequent steps
    const newWebAgentBestUrl = (skill === 'web.agent' && stepResult.ok && raw.bestUrl)
      ? raw.bestUrl
      : (state.webAgentBestUrl || null);
    return {
      ...state,
      skillPlan: patchedSkillPlan,   // carry forward the (possibly patched) plan with real image paths
      skillResults: updatedResults,
      skillCursor: skillCursor + 1,
      failedStep: null,
      activeBrowserSessionId,
      activeBrowserUrl,
      lastOpenedFilePath,
      webAgentBestUrl: newWebAgentBestUrl,
      commandExecuted: isLastStep,
      answer: lastStepAnswer  // set so voice service _stategraphLaneResponse gets it for TTS
    };

  } catch (error) {
    // Check if this is a search command that exited with code 1 (no results) — treat as soft failure
    const SEARCH_CMDS_CATCH = ['mdfind', 'find', 'grep', 'locate'];
    const _isGoalModeCatch = skill === 'shell.run' && !!args.goal && !args.cmd;
    const isBashSearchCatch = !_isGoalModeCatch && args.cmd === 'bash' && Array.isArray(args.argv) &&
      args.argv.some(a => typeof a === 'string' && SEARCH_CMDS_CATCH.some(sc => a.includes(sc)));
    const isSearchExit1 = !_isGoalModeCatch && (SEARCH_CMDS_CATCH.includes(args.cmd) || isBashSearchCatch) &&
      error.message && error.message.includes('code 1');

    // ── Catch path: open <file> wrong extension → glob for real file ──────────
    // command.automate throws 'Process exited with code 1' when `open <file>` can't
    // find the file. The patch block in the normal path is bypassed when an exception
    // is thrown. Intercept here: glob for the stem name in the same dir and retry.
    if (skill === 'shell.run' && !isSearchExit1 && error.message && error.message.includes('code 1')) {
      const _catchArgv = (args?.argv) || [];
      const _catchScript = (args?.cmd === 'bash' && Array.isArray(_catchArgv))
        ? (_catchArgv.find(a => typeof a === 'string' && a !== '-c') || '')
        : _catchArgv.join(' ');
      const _catchOpenMatch = _catchScript.match(/\bopen\b(?:\s+-a\s+\S+)?\s+['"]?([^\s'"]+)['"']?\s*$/);
      if (_catchOpenMatch) {
        const _catchFailedPath = _catchOpenMatch[1];
        const _catchPathMod = require('path');
        const _catchFsMod = require('fs');
        const _catchDir = _catchPathMod.dirname(_catchFailedPath);
        const _catchStem = _catchPathMod.basename(_catchFailedPath, _catchPathMod.extname(_catchFailedPath));
        try {
          const _catchEntries = _catchFsMod.readdirSync(_catchDir);
          const _catchMatch = _catchEntries.find(e => {
            const eStem = _catchPathMod.basename(e, _catchPathMod.extname(e));
            return eStem.toLowerCase() === _catchStem.toLowerCase() && e !== _catchPathMod.basename(_catchFailedPath);
          });
          if (_catchMatch) {
            const _catchFixedPath = _catchPathMod.join(_catchDir, _catchMatch);
            logger.info(`[Node:ExecuteCommand] catch: open file auto-patching "${_catchFailedPath}" → "${_catchFixedPath}"`);
            const _catchFixedArgv = _catchArgv.map(a =>
              typeof a === 'string' ? a.split(_catchFailedPath).join(_catchFixedPath) : a
            );
            const _catchPatchedPlan = skillPlan.map((s, i) =>
              i === skillCursor ? { ...s, args: { ...s.args, argv: _catchFixedArgv } } : s
            );
            return {
              ...state,
              skillPlan: _catchPatchedPlan,
              skillResults,  // don't append failed result
              skillCursor,
              failedStep: null,
              commandExecuted: false,
            };
          }
        } catch (_ce) {
          // readdirSync failed — fall through to normal error handling
        }
      }
    }

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

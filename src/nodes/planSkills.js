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
After switching Slack workspace with {ENTER}, always add ui.waitFor + osascript activate before the next {CMD+K}.
api_suggest: use as FIRST step when task is RECURRING or programmatic AND the service has an API. Almost all SaaS/cloud services have APIs (Slack, Gmail, Discord, Notion, GitHub, Twilio, n8n, Stripe, Zapier, OpenAI, etc.). Do NOT use for one-off tasks.
guide.step: use for ANY task where the user must act manually step by step (government sites, DMV, forms, license renewal, API token setup, CAPTCHAs, login walls). MANDATORY pattern: browser.act navigate URL (sessionId) → browser.act highlight (label, instruction, sessionId) → guide.step (instruction, sessionId) → repeat highlight+guide.step for each step. Playwright opens a VISIBLE Chrome Testing window. highlight injects glow + speech bubble; guide.step polls window.__tdGuideTriggered and auto-advances when user clicks highlighted element. sessionId is REQUIRED in guide.step.
Policy: no sudo/su/passwd. argv is string[] — no shell interpolation.
Output ONLY a valid JSON array. No explanation, no markdown fences.
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
    profileContext = null
  } = state;

  const logger = state.logger || console;
  const progressCallback = state.progressCallback || null;

  if (intent?.type !== 'command_automate') {
    return state;
  }

  // ── Login resume: skip replanning, return existing plan as-is ────────────────
  // When the user confirmed a login (resumeFromLogin=true), the existing skillPlan
  // is still valid — just continue from skillCursor. No LLM call needed.
  if (state.resumeFromLogin && Array.isArray(state.skillPlan) && state.skillPlan.length > 0) {
    logger.info(`[Node:PlanSkills] resumeFromLogin=true — skipping replan, resuming existing plan at step ${state.skillCursor + 1}/${state.skillPlan.length}`);
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: state.skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || s.skill, args: s.args })) });
    return { ...state, resumeFromLogin: false };
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

  const userMessage = resolvedMessage || message;
  const os = process.platform;
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/Users/unknown';

  // Build recovery context suffix if re-planning after failure
  let recoveryNote = '';
  if (recoveryContext) {
    recoveryNote = `

RECOVERY CONTEXT (previous attempt failed):
- Failed step: ${recoveryContext.failedSkill} (step ${recoveryContext.failedStep})
- Failure reason: ${recoveryContext.failureReason}
- Suggestion: ${recoveryContext.suggestion}
- Constraint: ${recoveryContext.constraint || 'none'}
${recoveryContext.alternativeCwd ? `- Use cwd: "${recoveryContext.alternativeCwd}" instead` : ''}
Adjust the plan to avoid the same failure.`;
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
        .slice(0, 40)
        .map(e => `  - [${e.tag}] "${e.label}"${e.href ? ` → ${e.href}` : ''}`)
        .join('\n');
      browserSessionNote += `\n\nCURRENT PAGE ELEMENTS (${activeBrowserPageElements.url}):\nUse ONLY these exact labels in highlight steps — do not invent labels:\n${elList}`;
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
    const factLines = profileContext.facts.map(f => `- ${f.field}: ${f.value}`).join('\n');
    profileContextNote = `\n\nUSER PROFILE FACTS (use these exact values — do NOT substitute placeholders):\n${factLines}`;
    logger.debug(`[Node:PlanSkills] Injecting ${profileContext.facts.length} profile fact(s) into planning query`);
  }

  // ── Two-phase guide planning: scan first, plan with real elements ───────────
  // For fresh guide tasks (no active session, no existing page elements):
  //   Phase 1: Ask LLM for just the starting URL — one fast LLM call.
  //   Navigate + scan that URL — get the real interactive elements.
  //   Phase 2: Ask LLM for the full plan injecting the real element list.
  // This eliminates all label guessing on the first plan.
  let livePageElements = activeBrowserPageElements;
  let livePageUrl = state.activeBrowserUrl || null;
  // Pre-scan fires for ALL browser tasks — skip only for pure shell/file/memory tasks.
  // Rule: if the task has NO browser signal AND is clearly a local/shell/file task → skip.
  // Otherwise always pre-scan so the LLM knows real page elements (inputs, buttons, links)
  // before generating the plan — eliminates selector guessing entirely.
  const PURE_LOCAL_TASK = /\b(file\.bridge|fs\.read|file\.watch|check the bridge|the bridge|bridge file|watch the|tail -f|directory listing|repo structure|npm install|git (commit|push|pull|clone|status)|python\s|bash\s|shell\s|convert (this|the) file|read (the|this) file|write (the|this) file)\b/i;
  // A task is a browser task if it mentions any URL, site name, navigation verb, or web concept
  const HAS_BROWSER_SIGNAL = /\b(https?:\/\/|\.com|\.ai|\.org|\.io|\.gov|go to|navigate|open|website|online|web|internet|search|look up|find|research|browse|perplexity|deepseek|chatgpt|claude|gemini|grok|copilot|google|youtube|github\.com|twitter|instagram|facebook|linkedin|reddit|amazon|netflix|spotify|maps|register|apply|passport|visa|dmv|form|portal|login|account|sign up|enroll|appointment|verify|lookup|renew|permit|license)\b/i;
  const isGuideTask = !activeBrowserPageElements && !recoveryContext && mcpAdapter &&
    HAS_BROWSER_SIGNAL.test(userMessage) && !PURE_LOCAL_TASK.test(userMessage);

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
          }, { timeoutMs: 15000 }).catch(e => ({ ok: false, error: e.message }));
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
      .slice(0, 40)
      .map(e => `  - [${e.tag}] "${e.label}"${e.href ? ` → ${e.href}` : ''}`)
      .join('\n');
    const doneNote = effectiveCompleted.length > 0
      ? `\nALREADY COMPLETED (do NOT repeat these): ${effectiveCompleted.map(s => `"${s.label}"`).join(', ')}`
      : '';
    browserSessionNote = `\n\nACTIVE BROWSER SESSION: sessionId="${sid}" is already open at ${livePageUrl}. Use this EXACT sessionId for all browser.act steps. If this task targets the SAME site, skip navigate. If it targets a DIFFERENT site, include a navigate step first.${doneNote}\n\nCURRENT PAGE ELEMENTS (${livePageUrl}):\nUse ONLY these exact labels in highlight steps — do not invent labels:\n${elList}`;
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
        const lines = isNames.map(s => `  - name: ${s.name} — ${s.description || 'no description'}`).join('\n');
        installedSkillsNote = `\n\nINSTALLED SKILLS (MUST use external.skill for these — NEVER use needs_skill):\n${lines}\n  Usage: { "skill": "external.skill", "args": { "name": "<skill-name>", ...skillArgs } }`;
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

  const planningQuery = `TASK: Convert the following user request into a JSON skill plan.
OS: ${os}
Home directory: ${homeDir}
User request: "${userMessage}"${installedSkillsNote}${siteRulesBlock}${recoveryNote}${profileContextNote}${browserSessionNote}${priorResultsNote}${conversationNote}${taggedContextNote}`;

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
      maxTokens: 600,
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
          if (progressCallback) progressCallback({ type: 'plan_ready', steps: retryPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || s.skill, args: s.args })), intent: state.intent?.type || 'command_automate' });
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
          // Multi-site comparison plan — leave all sessionIds and navigates intact
          logger.debug(`[Node:PlanSkills] Multi-tab plan detected (${plannedSessionIds.size} sessions) — preserving all navigates`);
        } else {
          // Single-site follow-up — enforce active sessionId and strip redundant navigate
          skillPlan = skillPlan.map(step => {
            if (step.skill !== 'browser.act') return step;
            return { ...step, args: { ...step.args, sessionId: effectiveSessionId } };
          });

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
            const withoutNavigate = skillPlan.filter(s => !(s.skill === 'browser.act' && s.args?.action === 'navigate'));
            if (withoutNavigate.length > 0) {
              skillPlan = withoutNavigate;
              logger.debug(`[Node:PlanSkills] Reused active session "${activeBrowserSessionId}" — stripped navigate (same domain), ${skillPlan.length} steps remain`);
            }
          } else if (isSameDomain && isEvalRetry) {
            logger.debug(`[Node:PlanSkills] Eval retry ${state.evaluationRetryCount} — keeping navigate despite same domain (fix rule may change URL)`);
          } else if (navigateStep) {
            logger.debug(`[Node:PlanSkills] Reused active session "${activeBrowserSessionId}" — kept navigate (different/unknown domain)`);
          } else {
            logger.debug(`[Node:PlanSkills] Reused active session "${activeBrowserSessionId}" — no navigate step`);
          }
        }
      }
    }

    // ── Stamp missing sessionIds from navigate URL ──────────────────────────
    // When the LLM generates browser.act steps with no sessionId (common for
    // single-site tasks), derive it from the navigate step's URL hostname —
    // the same derivation the command service uses. This prevents subsequent
    // steps (waitForStableText, smartType, etc.) from falling back to 'default'
    // and opening a blank tab instead of reusing the page just navigated to.
    if (Array.isArray(skillPlan)) {
      const navigateStep = skillPlan.find(s => s.skill === 'browser.act' && s.args?.action === 'navigate' && s.args?.url);
      const existingSessionIds = new Set(skillPlan.filter(s => s.skill === 'browser.act').map(s => s.args?.sessionId).filter(Boolean));
      const isMultiTab = existingSessionIds.size > 1;
      if (!isMultiTab && navigateStep && !navigateStep.args?.sessionId) {
        let derivedSession = null;
        try { derivedSession = new URL(navigateStep.args.url).hostname; } catch (_) {}
        if (derivedSession) {
          skillPlan = skillPlan.map(step => {
            if (step.skill !== 'browser.act' || step.args?.sessionId) return step;
            return { ...step, args: { ...step.args, sessionId: derivedSession } };
          });
          logger.info(`[Node:PlanSkills] Stamped missing sessionIds with "${derivedSession}" (derived from navigate URL)`);
        }
      }
    }

    logger.debug(`[Node:PlanSkills] Plan ready: ${skillPlan.length} steps`);
    skillPlan.forEach((s, i) =>
      logger.debug(`  Step ${i + 1}: ${s.skill} — ${s.description || JSON.stringify(s.args)}`)
    );
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || s.skill, args: s.args })), intent: state.intent?.type || 'command_automate' });

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
      planError: null
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
    return null;
  }
}

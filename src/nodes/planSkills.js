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
const MCPLLMBackend = require('../backends/MCPLLMBackend');
const VSCodeLLMBackend = require('../backends/VSCodeLLMBackend');

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

Available skills: shell.run, browser.act, ui.findAndClick, ui.typeText, ui.waitFor

shell.run|args:{cmd,argv[],cwd?,timeoutMs?,dryRun?,stdin?}
browser.act|args:{action,url?,selector?,text?,sessionId?,timeoutMs?,headless?}
ui.findAndClick|args:{label,app?,confidence?,timeoutMs?}
ui.typeText|args:{text,delayMs?}|tokens:{ENTER}{TAB}{ESC}{CMD+K}{CMD+C}{CMD+V}{BACKSPACE}
ui.waitFor|args:{condition,value?,timeoutMs?,pollIntervalMs?}|conditions:textIncludes,textRegex,appIsActive,titleIncludes,urlIncludes,changed

Policy: no sudo/su/passwd. argv is string[] — no shell interpolation. Always specify cwd when creating files.
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
    conversationHistory = []
  } = state;

  const logger = state.logger || console;
  const progressCallback = state.progressCallback || null;

  if (intent?.type !== 'command_automate') {
    return state;
  }

  logger.debug('[Node:PlanSkills] Planning skill steps...');
  if (progressCallback) progressCallback({ type: 'planning', message: 'Generating skill plan...' });

  // ── Resolve LLM backend (same priority as answer node) ──────────────────────
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

  if (!backend) {
    logger.warn('[Node:PlanSkills] No LLM backend — cannot plan skills');
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
      .map(r => `- ${r.skill || 'shell.run'} output: ${r.stdout.trim().split('\n').slice(0, 3).join('; ')}`);
    if (resultLines.length > 0) {
      priorResultsNote = `\n\nPREVIOUS STEP RESULTS (use these to resolve references like "that file", "it", "the result"):\n${resultLines.join('\n')}`;
    }
  }

  // Build conversation history context so LLM can resolve cross-turn references
  // e.g. "that file", "add more to it" when the file path was mentioned in a prior turn
  let conversationNote = '';
  if (conversationHistory && conversationHistory.length > 0) {
    const recentTurns = conversationHistory.slice(-6); // last 3 exchanges
    const turnLines = recentTurns
      .filter(m => m.content && m.content.trim())
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim().substring(0, 200)}`);
    if (turnLines.length > 0) {
      conversationNote = `\n\nRECENT CONVERSATION (use this to resolve references like "that file", "it", "the result"):\n${turnLines.join('\n')}`;
    }
  }

  const planningQuery = `TASK: Convert the following user request into a JSON skill plan.
OS: ${os}
Home directory: ${homeDir}
User request: "${userMessage}"${recoveryNote}${priorResultsNote}${conversationNote}`;

  const payload = {
    query: planningQuery,
    context: {
      systemInstructions: SKILL_SYSTEM_PROMPT,
      conversationHistory: [],
      sessionId: context?.sessionId,
      userId: context?.userId,
      intent: 'command_automate'
    },
    options: {
      maxTokens: 1000,
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
          if (progressCallback) progressCallback({ type: 'plan_ready', steps: retryPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || s.skill, args: s.args })) });
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

    logger.debug(`[Node:PlanSkills] Plan ready: ${skillPlan.length} steps`);
    skillPlan.forEach((s, i) =>
      logger.debug(`  Step ${i + 1}: ${s.skill} — ${s.description || JSON.stringify(s.args)}`)
    );
    if (progressCallback) progressCallback({ type: 'plan_ready', steps: skillPlan.map((s, i) => ({ index: i, skill: s.skill, description: s.description || s.skill, args: s.args })) });

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
 * LLMs sometimes wrap JSON in markdown fences — strip them.
 */
function parsePlan(raw, logger) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Find the first [ or { to start parsing
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');

  let jsonStr = text;
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    jsonStr = text.substring(arrayStart);
  } else if (objectStart !== -1) {
    jsonStr = text.substring(objectStart);
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    logger.warn('[Node:PlanSkills] JSON parse failed:', e.message);
    return null;
  }
}

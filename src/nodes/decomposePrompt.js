'use strict';

const fs   = require('fs');
const path = require('path');

// Structured JSON Lines log — one record per decomposition/classification decision.
const INTENT_LOG_PATH = path.join(process.cwd(), 'logs', 'intent-classifier.jsonl');
function writeDecomposeLog(entry) {
  try { fs.appendFileSync(INTENT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); }
  catch (_) { /* never throw — logging must never block decomposition */ }
}

/**
 * decomposePrompt node
 *
 * Breaks every user prompt into an ordered plan of single-intent sub-prompts via
 * the LLM backend.  Falls back to a heuristic splitter when the LLM is unavailable.
 * If neither produces ≥2 sub-prompts the message passes through unchanged.
 *
 * Sets state.intentPlan when decomposition fires:
 *   [{ text, estimatedIntent, order, dependsOn: number[], isLongRunning: bool, dataTemplate?: string }]
 */

// ── Lightweight intent classifier for heuristic-split sub-prompts ─────────────
// Used when the LLM decompose call fails — detects action/navigation verbs that
// signal command_automate so the downstream skill router is correctly invoked.
function classifyHeuristicIntent(text) {
  if (/\b(goto|go\s+to|navigate\s+to|open|visit|send|email|compose|draft|reply|click|check|search|find|look\s+up|compare|create|make|download|install|run|execute|text|book|reserve|schedule|fill|type|start|launch|switch|get\s+me|show\s+me|bring\s+up|pull\s+up|ask|query|summarize|compile|gather)\b/i.test(text)) {
    return 'command_automate';
  }
  return 'general_knowledge';
}

// ── Heuristic clause splitter (no LLM needed) ────────────────────────────────
function heuristicSplit(message) {
  const chunks = message
    .split(/[?]+\s+(?=[A-Z])|\.\s+(?=[A-Z])|\s+(?:and then|then|after that|after you|followed by)\s+/i)
    .map(s => s.trim())
    .filter(s => s.length > 10)
    .slice(0, 5);

  if (chunks.length <= 1) return null;

  return chunks.map((text, i) => ({
    text,
    estimatedIntent: classifyHeuristicIntent(text),
    confidence:      0.65,
    order: i,
    dependsOn: [],
    isLongRunning: false,
    dataTemplate: null,
  }));
}

// TODO: app_control_start excluded from decomposition — reserved for real-time voice/UI screen control, handled via a separate pipeline path
// ── LLM decomposition system prompt ──────────────────────────────────────────
const DECOMPOSE_SYSTEM_PROMPT = `You decompose a user message for an LLM intent classifier. Sub-prompts are executed by a downstream intent router:
- Each sub-prompt "text" must contain exactly ONE distinct action or intent — include enough context for accurate classification
- Keep "text" fields focused on the specific intent of that step; avoid combining multiple actions
- Valid estimatedIntent values: command_automate, screen_intelligence, web_search, memory_store, memory_retrieve, general_knowledge, greeting
- Mark isLongRunning:true ONLY for steps involving a browser automation task expected to take more than 30 seconds (e.g. AI generation, filling a long form)
- Mark dependsOn:[N] when this step requires the OUTPUT of step N to execute correctly
- Use dataTemplate (optional) with "{{result[N]}}" as a placeholder where step N's result should be injected at execution time — omit if no dependency
- Return ONLY valid JSON — no markdown fences, no explanation
- Correction messages that start with "no it's", "no that's", "actually it's", or "nope it's" where the value corrects a prior answer (e.g. "no it's cakers5559@gmail.com" after a wrong email was stated) should use estimatedIntent:'memory_store', NOT command_automate — even if the value contains a domain name like gmail.com
- CRITICAL: If ALL proposed sub-prompts are implementation steps toward a single artifact (a skill, script, automation, cron job, scheduled task, or workflow), return ONE sub-prompt using the original user message text with estimatedIntent:'command_automate'. Only split into multiple sub-prompts when the user clearly expresses multiple INDEPENDENT goals they want executed separately (e.g. answering a question AND performing an unrelated action).

IMPORTANT: Navigation vs Search Classification
- When users say "go online", "goto", "navigate to", "open", "visit" + specific websites (ChatGPT, Perplexity, Grok, etc.), they want BROWSER AUTOMATION (command_automate), not web search
- Examples of navigation → command_automate:
  * "go online and goto perplexity and look up X" → command_automate
  * "navigate to chatgpt and ask about Y" → command_automate
  * "goto grok and research Z" → command_automate
- Only use web_search for general web search WITHOUT specific website navigation
- Research via specific websites should be command_automate, not web_search

JSON shape (example):
{"subPrompts":[{"text":"retrieve game idea for gambo ai","estimatedIntent":"memory_retrieve","order":0,"dependsOn":[],"isLongRunning":false},{"text":"build game on gambo ai using idea","estimatedIntent":"command_automate","order":1,"dependsOn":[0],"isLongRunning":true,"dataTemplate":"Use this game idea from memory: {{result[0]}}"},{"text":"text me when the game is done","estimatedIntent":"command_automate","order":2,"dependsOn":[1],"isLongRunning":false}]}`;

// ── Single-artifact keyword guard (Layer 3) ─────────────────────────────────
// Skip decomposition entirely when the message is asking to build ONE artifact
// (skill, cron, scheduled task, background job) with no obvious multi-goal connector.
const SINGLE_ARTIFACT_RE = /\b(create|build|write|make|generate|set up|setup)\b.{0,80}\b(skill|cron job|scheduled (script|task|job)|background (script|task|job)|automation that runs|script that runs)\b/i;
const MULTI_GOAL_CONNECTOR_RE = /\b(and (?:also|then)|after that|also|additionally|plus)\b.{0,30}\b(open|search|email|text|send|message|call|look|find|go to|navigate|check|tweet|post)\b/i;

// ── Layer 4: single-intent fast-path ─────────────────────────────────────────
// Prompts that are obviously one intent never benefit from LLM decomposition —
// the LLM always returns 1 sub-prompt equal to the original (wasting ~2s).
// Detect them upfront and skip the LLM call entirely.

// Patterns that reliably indicate a single intent (no multi-step):
const SINGLE_QUESTION_RE   = /^(what|who|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|have|has|had|tell me|show me|explain|give me|find me|what'?s|who'?s|what is|what are|what was)\b/i;
const SINGLE_MEMORY_RE     = /^(remember|my name|what'?s my|what is my|who am i|remind me|what did i|do you know my|what do you know|recall|look up my|retrieve my)\b/i;
// Temporal/elliptical memory queries — e.g., "anything in march", "what about last week"
const SINGLE_TEMPORAL_MEMORY_RE = /^(anything|something|what)\s+(about|in|from|during)\s+(the\s+)?(month\s+of\s+|week\s+of\s+|day\s+of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|last\s+week|last\s+month|last\s+year|yesterday|today|this\s+week|this\s+month)\b/i;
// Conservative fast-path for short, unambiguous navigation commands.
// Only fires when: (1) starts with a clear browse verb, (2) task remainder after site
// name is short (≤40 chars), (3) no multi-step connectors present.
// Examples that fire: "goto biblegateway look up romans 1", "visit arxiv.org"
// Examples that DON'T fire: "goto gmail open the first email from John and summarize it"
const SINGLE_COMMAND_RE    = /^(goto|go\s+to|navigate\s+to|visit)\s+\S+/i;
// Multi-step connectors that REQUIRE LLM decomposition (fast-path must not fire if present)
const MULTI_STEP_SIGNAL_RE = /\b(and then|after that|after you|followed by|then (?:also|after|open|go|send|email|text|search|find|create|navigate|check|make)|also (?:send|text|email|open|go|search|find|check)|additionally|first .{0,60} then|step 1|step one|part 1|part one)\b/i;

// Action verbs that indicate the user wants to DO something (not retrieve memory)
// These disqualify a query from temporal memory fast-path
const ACTION_VERBS_RE = /\b(go|goto|navigate|open|visit|search|find|look\s+up|check|create|make|build|write|send|email|text|call|schedule|plan|book|reserve|download|install|run|execute|start|launch|switch|get\s+me|show\s+me|bring\s+up|pull\s+up|ask|query|summarize|compile|gather)\b/i;

// Maximum length for elliptical temporal memory queries
// Longer queries likely have additional context that needs LLM decomposition
const ELLIPTICAL_MAX_LENGTH = 80;

// ── Linear CA-chain collapse (Layer 2) ───────────────────────────────────────
// After LLM decomposes, detect and collapse command_automate steps that form a
// fully-linear dependency chain (no branching). This prevents implementation-step
// enumeration ("create script → log to file → schedule it") from being executed
// as 3 separate planSkills roundtrips.
function collapseLinearCAChain(plan, originalMessage, logger) {
  if (!Array.isArray(plan) || plan.length <= 1) return plan;

  const caSteps    = plan.filter(sp => sp.estimatedIntent === 'command_automate');
  const nonCaSteps = plan.filter(sp => sp.estimatedIntent !== 'command_automate');

  if (caSteps.length <= 1) return plan; // nothing to collapse

  const caOrderSet = new Set(caSteps.map(sp => sp.order));

  // Linearity check: each CA node may have at most 1 CA predecessor and 1 CA successor.
  for (const ca of caSteps) {
    const caPredCount = ca.dependsOn.filter(d => caOrderSet.has(d)).length;
    const caSuccCount = caSteps.filter(other => other.dependsOn.includes(ca.order)).length;
    if (caPredCount > 1 || caSuccCount > 1) {
      logger.debug(`[Node:DecomposePrompt] CA chain branches at step [${ca.order}] — skipping collapse`);
      return plan;
    }
  }

  // Collect properties of the collapsed CA step
  const sortedCa   = [...caSteps].sort((a, b) => a.order - b.order);
  const externalDeps = [];
  let isLongRunning  = false;
  let dataTemplate   = null;
  const caTexts      = [];

  for (const ca of sortedCa) {
    caTexts.push(ca.text);
    if (ca.isLongRunning) isLongRunning = true;
    for (const dep of ca.dependsOn) {
      if (!caOrderSet.has(dep) && !externalDeps.includes(dep)) externalDeps.push(dep);
    }
    if (!dataTemplate && ca.dataTemplate) dataTemplate = ca.dataTemplate;
  }

  // Use the original message when all steps were CA (no non-CA steps)
  const collapsedText = nonCaSteps.length === 0 ? originalMessage : caTexts.join(' and ');

  const collapsedStep = {
    text:            collapsedText,
    estimatedIntent: 'command_automate',
    order:           sortedCa[0].order, // temporary; re-indexed below
    dependsOn:       externalDeps,
    isLongRunning,
    dataTemplate,
  };

  // Sort the new plan and build old-order → new-index map
  const newPlanUnsorted = [...nonCaSteps, collapsedStep].sort((a, b) => a.order - b.order);

  const oldToNewIdx = new Map();
  newPlanUnsorted.forEach((sp, i) => {
    if (sp === collapsedStep) {
      sortedCa.forEach(ca => oldToNewIdx.set(ca.order, i));
    } else {
      oldToNewIdx.set(sp.order, i);
    }
  });

  // Re-index orders and remap dependsOn references
  const remapped = newPlanUnsorted.map((sp, i) => ({
    ...sp,
    order:     i,
    dependsOn: [...new Set(
      sp.dependsOn
        .map(d => oldToNewIdx.get(d))
        .filter(d => d !== undefined && d < i)
    )],
  }));

  logger.info(`[Node:DecomposePrompt] Collapsed ${caSteps.length} linear CA steps → 1 (plan: ${plan.length} → ${remapped.length} sub-prompts)`);
  return remapped;
}

// ── LLM decompose call ────────────────────────────────────────────────────────
async function llmDecompose(message, llmBackend, carriedIntent, logger) {
  const continuationHint = carriedIntent
    ? `\nContext: the previous message intent was "${carriedIntent}" — this may be a continuation or a topic pivot.`
    : '';
  const userPrompt = `Decompose this user message into ordered single-intent sub-prompts.${continuationHint}\n\n"${message}"`;

  let raw;
  try {
    raw = await llmBackend.generateAnswer(
      userPrompt,
      {
        query: userPrompt,
        context: { systemInstructions: DECOMPOSE_SYSTEM_PROMPT },
      },
      { maxTokens: 400, temperature: 0.1, fastMode: true }
    );
  } catch (e) {
    logger.warn(`[Node:DecomposePrompt] LLM call failed: ${e.message}`);
    return null;
  }

  if (!raw) return null;

  // Strip markdown code fence if the LLM wrapped its response
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    const subPrompts = parsed.subPrompts || parsed.sub_prompts;

    if (!Array.isArray(subPrompts) || subPrompts.length < 1) {
      logger.debug(`[Node:DecomposePrompt] LLM returned no sub-prompts`);
      return null;
    }

    // Validate and normalise each entry
    return subPrompts.map((sp, i) => ({
      text:             String(sp.text || '').trim().slice(0, 300),
      estimatedIntent:  sp.estimatedIntent || sp.estimated_intent || 'general_knowledge',
      confidence:       typeof (sp.confidence) === 'number' ? sp.confidence : 0.70,
      order:            typeof sp.order === 'number' ? sp.order : i,
      dependsOn:        Array.isArray(sp.dependsOn || sp.depends_on) ? (sp.dependsOn || sp.depends_on) : [],
      isLongRunning:    Boolean(sp.isLongRunning || sp.is_long_running),
      dataTemplate:     sp.dataTemplate || sp.data_template || null,
    }));
  } catch (e) {
    logger.warn(`[Node:DecomposePrompt] JSON parse failed: ${e.message} — raw (first 120 chars): "${cleaned.slice(0, 120)}"`);
    return null;
  }
}

// Exported for unit testing — does not affect runtime behavior.
// Set BEFORE main export so TS/Node treats this file as a plain function export;
// the property is re-attached below after the function is assigned.

// ── Main node ─────────────────────────────────────────────────────────────────
module.exports = async function decomposePrompt(state) {
  const { message, llmBackend, carriedIntent } = state;
  const logger = state.logger || console;

  // Pass-through: no message, skill_build fast-path, or already decomposed
  if (!message || state.skillBuildRequest || state.intentPlan) {
    return state;
  }

  // Plan execution fast-path: skip decomposition when executing an approved plan
  if (state._planFile) {
    logger.info('[Node:DecomposePrompt] _planFile detected — skipping decomposition (plan execute passthrough)');
    return state;
  }

  // Skill plan fast-path: skip decomposition when _skillPlan array is already built
  if (state._skillPlan && Array.isArray(state._skillPlan)) {
    logger.info('[Node:DecomposePrompt] _skillPlan detected — skipping decomposition (skill plan passthrough)');
    return state;
  }

  // Plan correction fast-path: keep the correction prompt intact for replanning.
  if (state._planCorrectionMode) {
    logger.info('[Node:DecomposePrompt] _planCorrectionMode detected — skipping decomposition');
    return state;
  }

  // Gather answer fast-path: don't decompose answers to gather questions
  if (state._gatherQuestionPending || state.pendingQuestion?._isGatherPlanQuestion) {
    logger.info('[Node:DecomposePrompt] Gather answer detected — skipping decomposition');
    return state;
  }

  logger.debug(`[Node:DecomposePrompt] Attempting decomposition: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`)

  // ── Layer 4: single-intent fast-path ────────────────────────────────────
  // Skip the LLM call for prompts that are obviously a single intent with no
  // multi-step connectors. The LLM always collapses these to 1 sub-prompt anyway.
  if (!MULTI_STEP_SIGNAL_RE.test(message) && (SINGLE_QUESTION_RE.test(message) || SINGLE_MEMORY_RE.test(message) || SINGLE_TEMPORAL_MEMORY_RE.test(message))) {
    // Temporal memory queries need extra validation to avoid false positives
    let fastIntent;
    if (SINGLE_TEMPORAL_MEMORY_RE.test(message)) {
      // Hardening: must be short (elliptical) AND not contain action verbs
      const isShortEnough = message.length <= ELLIPTICAL_MAX_LENGTH;
      const hasNoActionVerbs = !ACTION_VERBS_RE.test(message);
      
      if (isShortEnough && hasNoActionVerbs) {
        fastIntent = 'memory_retrieve';
        logger.debug(`[Node:DecomposePrompt] Temporal memory fast-path — validated (short=${isShortEnough}, noActions=${hasNoActionVerbs})`);
      } else {
        // Failed validation — let LLM decompose this one
        logger.debug(`[Node:DecomposePrompt] Temporal pattern matched but failed validation (short=${isShortEnough}, noActions=${hasNoActionVerbs}) — using LLM decomposition`);
        // Continue to LLM decomposition below (don't return here)
        // Fall through to regular processing
      }
    }
    
    // If we determined a fast intent above, use it; otherwise use heuristic classifier
    if (!fastIntent) {
      fastIntent = classifyHeuristicIntent(message);
    }
    
    logger.debug(`[Node:DecomposePrompt] Single-intent fast-path — skipping LLM (intent=${fastIntent}): "${message.slice(0, 60)}"`);
    writeDecomposeLog({ ts: new Date().toISOString(), message, parser: 'fast-path', intent: fastIntent, subPromptCount: 1, durationMs: 0, subPrompts: [] });
    if (fastIntent && fastIntent !== 'general_knowledge') {
      return { ...state, _decomposedIntent: fastIntent };
    }
    return state;
  };

  // ── Layer 4c: pure greeting/acknowledgement fast-path ─────────────────────
  // Greetings and short acknowledgements ("hello", "thanks", "ok", "sounds good")
  // always decompose to exactly 1 sub-prompt equal to the original — the LLM call
  // (3–4s) adds zero value. Detect them upfront with a tight regex and skip entirely.
  // Guard: no action verbs present (catches "ok go ahead" / "yes do that now" correctly —
  // those contain action verbs and fall through to Layer 4b or the LLM).
  const GREETING_FAST_PATH_RE = /^(hi+|hello+|hey+|howdy|yo|sup|good\s+(morning|afternoon|evening|night)|thanks?|thank\s+you|ok|okay|sure|great|got\s+it|sounds\s+good|perfect|cool|awesome|nice|alright|yep|yup|no+|nope)[\s!.?]*$/i;
  if (GREETING_FAST_PATH_RE.test(message.trim())) {
    logger.debug(`[Node:DecomposePrompt] Greeting fast-path — skipping LLM: "${message.slice(0, 40)}"`);
    writeDecomposeLog({ ts: new Date().toISOString(), message, parser: 'greeting-fast-path', intent: 'greeting', subPromptCount: 1, durationMs: 0, subPrompts: [] });
    return { ...state, _decomposedIntent: 'greeting' };
  }

  // ── Layer 4b: conservative navigation fast-path ───────────────────────────
  // Short browse-verb prompts (goto/go to/navigate to/visit + site) with no
  // multi-step connectors are always single-intent command_automate.
  // Guard: only fires when task text after the site name is ≤40 chars.
  if (!MULTI_STEP_SIGNAL_RE.test(message) && SINGLE_COMMAND_RE.test(message)) {
    // Measure text after the first two tokens (verb + site name)
    const _tokens = message.trim().split(/\s+/);
    const _verbTokens = /^go\s+to$/i.test(_tokens.slice(0, 2).join(' ')) ? 2 : 1;
    const _afterSite = _tokens.slice(_verbTokens + 1).join(' ');
    if (_afterSite.length <= 40) {
      logger.info(`[Node:DecomposePrompt] Navigation fast-path — skipping LLM (command_automate): "${message.slice(0, 60)}"`);
      writeDecomposeLog({ ts: new Date().toISOString(), message, parser: 'nav-fast-path', intent: 'command_automate', subPromptCount: 1, durationMs: 0, subPrompts: [] });
      return { ...state, _decomposedIntent: 'command_automate' };
    }
  }

  // ── Layer 3: single-artifact keyword guard ────────────────────────────────
  // If the message is requesting one artifact (skill/cron/scheduled job) with no
  // multi-goal connectors, skip decomposition and let the creator handle it whole.
  if (SINGLE_ARTIFACT_RE.test(message) && !MULTI_GOAL_CONNECTOR_RE.test(message)) {
    logger.debug('[Node:DecomposePrompt] Single-artifact request detected — passing through as atomic');
    return state;
  }

  let plan = null;
  let decomposedBy = 'heuristic';

  // ── Try LLM backend first ─────────────────────────────────────────────────
  if (llmBackend) {
    let available = false;
    try { available = await llmBackend.isAvailable(); } catch (_) { /* backend probe failed */ }

    if (available) {
      const startMs = Date.now();
      plan = await llmDecompose(message, llmBackend, carriedIntent, logger);

      if (plan) {
        decomposedBy = 'llm';
        writeDecomposeLog({
          ts:             new Date().toISOString(),
          message,
          carriedHint:    carriedIntent || null,
          parser:         'llm-decompose',
          intent:         plan[0].estimatedIntent,
          subPromptCount: plan.length,
          durationMs:     Date.now() - startMs,
          subPrompts:     plan.map(sp => ({
            order:           sp.order,
            text:            sp.text,
            estimatedIntent: sp.estimatedIntent,
            dependsOn:       sp.dependsOn,
            isLongRunning:   sp.isLongRunning,
            dataTemplate:    sp.dataTemplate || null,
          })),
        });
        logger.info(`[Node:DecomposePrompt] LLM decomposed into ${plan.length} sub-prompts in ${Date.now() - startMs}ms`);
        plan.forEach((sp, i) =>
          logger.debug(`  [${i}] "${sp.text}" → ${sp.estimatedIntent}${sp.isLongRunning ? ' [LONG_RUNNING]' : ''}${sp.dependsOn.length ? ` dependsOn:[${sp.dependsOn.join(',')}]` : ''}`)
        );
      }
    } else {
      logger.debug('[Node:DecomposePrompt] LLM backend unavailable — using heuristic fallback');
    }
  }

  // ── Heuristic fallback ────────────────────────────────────────────────────
  if (!plan) {
    plan = heuristicSplit(message);
    if (plan) {
      logger.info(`[Node:DecomposePrompt] Heuristic split into ${plan.length} sub-prompts`);
    }
  }

  // ── Could not decompose — treat as simple ────────────────────────────────
  if (!plan) {
    logger.debug('[Node:DecomposePrompt] Could not produce a meaningful split — treating as simple prompt');
    return state;
  }

  // ── Layer 2: collapse linear CA chains ───────────────────────────────────
  plan = collapseLinearCAChain(plan, message, logger);

  // If collapse reduced everything to 1 sub-prompt, treat as simple.
  // Preserve the LLM's estimatedIntent as _decomposedIntent so parseIntent can use
  // it as a soft signal — the full intentPlan is not useful but the intent label is.
  if (plan.length === 1 && plan[0].text === message) {
    const collapsedIntent = plan[0].estimatedIntent;
    if (collapsedIntent && collapsedIntent !== 'general_knowledge') {
      logger.debug(`[Node:DecomposePrompt] Post-collapse single sub-prompt equals original — preserving _decomposedIntent=${collapsedIntent}`);
      return { ...state, _decomposedIntent: collapsedIntent };
    }
    logger.debug('[Node:DecomposePrompt] Post-collapse single sub-prompt equals original — treating as simple prompt');
    return state;
  }

  return {
    ...state,
    intentPlan:     plan,
    _decomposedBy:  decomposedBy,
    _decomposedAt:  Date.now(),
  };
};

// Attach test helper AFTER the main export assignment to avoid being clobbered.
module.exports._classifyHeuristicIntent = classifyHeuristicIntent;

'use strict';

/**
 * decomposePrompt node
 *
 * Detects complex/multi-intent prompts and breaks them into an ordered plan of
 * single-intent sub-prompts that DistilBERT can accurately classify (128-token max).
 *
 * SIMPLE path (fewer than 2 complexity signals) → state unchanged, zero added latency.
 * COMPLEX path → calls state.llmBackend to decompose, falls back to heuristic splitter.
 *
 * Sets state.intentPlan when decomposition fires:
 *   [{ text, estimatedIntent, order, dependsOn: number[], isLongRunning: bool, dataTemplate?: string }]
 *
 * Complexity requires 2+ independent signals to avoid false triggers on long-but-simple queries:
 *   - length      : message > 100 characters
 *   - sentence_boundary : 1+ sentence endings followed by new content (". X", "? X")
 *   - temporal_connector: "and then", "after that", "when done", "text me when", etc.
 *   - multi_class_signals: 2+ distinct intent-class keywords matched (memory + automation, etc.)
 */

// ── Intent-signal word lists (one per DistilBERT class) ──────────────────────
const INTENT_SIGNALS = {
  memory:     /\b(remember|recall|note|save|store|keep track|what did i|do you remember|i told you|my preference|note that|i had (an |a |that )idea)\b/i,
  automation: /\b(open|launch|go to|goto|navigate|click|fill|send|create|make|book|schedule|text me|call me|email|start|run|execute|download|install|type|press|submit|build|generate|play)\b/i,
  search:     /\b(search|look up|find|google|what'?s the|best|latest|current|who is|when is|where is|top|price of|news about|does .{1,40} have)\b/i,
  screen:     /\b(on my screen|read this|screenshot|screen capture|summarize this|what does (it|this|the screen) say)\b/i,
};

// ── Temporal / sequencing connectors ─────────────────────────────────────────
const TEMPORAL_RE = /\b(and then|then|after that|when done|when (it'?s|you'?re|that'?s) (done|finished|complete[d]?)|once (done|finished|complete[d]?)|text me when|let me know when|notify me when|after you|followed by|first[,\s]|second[,\s])\b/i;

// ── Sentence boundary counter ─────────────────────────────────────────────────
function countSentenceBoundaries(msg) {
  // Matches ". X" or "? X" where X starts a new clause (capital or common word)
  return (msg.match(/[.?]\s+[A-Za-z]/g) || []).length;
}

// ── Complexity check — requires 2+ independent signals ───────────────────────
function checkComplexity(message) {
  const signals = [];

  if (message.length > 100) signals.push('length');
  if (countSentenceBoundaries(message) >= 1) signals.push('sentence_boundary');
  if (TEMPORAL_RE.test(message)) signals.push('temporal_connector');

  // Count how many distinct intent classes are signalled
  const matchedClasses = Object.entries(INTENT_SIGNALS)
    .filter(([, re]) => re.test(message))
    .map(([cls]) => cls);

  if (matchedClasses.length >= 2) signals.push('multi_class_signals');

  return { isComplex: signals.length >= 2, signals, matchedClasses };
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
    estimatedIntent: 'general_knowledge', // DistilBERT will refine
    order: i,
    dependsOn: [],
    isLongRunning: false,
    dataTemplate: null,
  }));
}

// ── LLM decomposition system prompt ──────────────────────────────────────────
const DECOMPOSE_SYSTEM_PROMPT = `You decompose a user message for a DistilBERT intent classifier with these strict constraints:
- Each sub-prompt "text" must be ≤128 tokens, containing exactly ONE distinct action or intent
- Keep "text" fields SHORT and action-focused — these are used for intent CLASSIFICATION only, not for execution
- Valid estimatedIntent values: command_automate, app_control_start, screen_intelligence, web_search, memory_store, memory_retrieve, general_knowledge, greeting
- Mark isLongRunning:true ONLY for steps involving a browser automation task expected to take more than 30 seconds (e.g. AI generation, filling a long form)
- Mark dependsOn:[N] when this step requires the OUTPUT of step N to execute correctly
- Use dataTemplate (optional) with "{{result[N]}}" as a placeholder where step N's result should be injected at execution time — omit if no dependency
- Return ONLY valid JSON — no markdown fences, no explanation

JSON shape (example):
{"subPrompts":[{"text":"retrieve game idea for gambo ai","estimatedIntent":"memory_retrieve","order":0,"dependsOn":[],"isLongRunning":false},{"text":"build game on gambo ai using idea","estimatedIntent":"command_automate","order":1,"dependsOn":[0],"isLongRunning":true,"dataTemplate":"Use this game idea from memory: {{result[0]}}"},{"text":"text me when the game is done","estimatedIntent":"command_automate","order":2,"dependsOn":[1],"isLongRunning":false}]}`;

// ── LLM decompose call ────────────────────────────────────────────────────────
async function llmDecompose(message, llmBackend, logger) {
  const userPrompt = `Decompose this user message into ordered single-intent sub-prompts:\n\n"${message}"`;

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

    if (!Array.isArray(subPrompts) || subPrompts.length < 2) {
      logger.debug(`[Node:DecomposePrompt] LLM returned <2 sub-prompts — treating as simple`);
      return null;
    }

    // Validate and normalise each entry
    return subPrompts.map((sp, i) => ({
      text:             String(sp.text || '').trim().slice(0, 300),
      estimatedIntent:  sp.estimatedIntent || sp.estimated_intent || 'general_knowledge',
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

// ── Main node ─────────────────────────────────────────────────────────────────
module.exports = async function decomposePrompt(state) {
  const { message, llmBackend } = state;
  const logger = state.logger || console;

  // Pass-through: no message, skill_build fast-path, or already decomposed
  if (!message || state.skillBuildRequest || state.intentPlan) {
    return state;
  }

  const check = checkComplexity(message);

  logger.debug(`[Node:DecomposePrompt] complexity — signals: [${check.signals.join(', ')}]${check.matchedClasses.length ? `, classes: [${check.matchedClasses.join(', ')}]` : ''}, isComplex: ${check.isComplex}`);

  if (!check.isComplex) {
    // Simple prompt — parseIntent handles it at full speed
    return state;
  }

  logger.info(`[Node:DecomposePrompt] Complex prompt detected (${check.signals.join(', ')}) — decomposing: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`);

  let plan = null;
  let decomposedBy = 'heuristic';

  // ── Try LLM backend first ─────────────────────────────────────────────────
  if (llmBackend) {
    let available = false;
    try { available = await llmBackend.isAvailable(); } catch (_) { /* backend probe failed */ }

    if (available) {
      const startMs = Date.now();
      plan = await llmDecompose(message, llmBackend, logger);

      if (plan) {
        decomposedBy = 'llm';
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

  return {
    ...state,
    intentPlan:     plan,
    _decomposedBy:  decomposedBy,
    _decomposedAt:  Date.now(),
  };
};

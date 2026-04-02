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
    estimatedIntent: 'general_knowledge', // LLM will classify at parseIntent time (heuristic path)
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

JSON shape (example):
{"subPrompts":[{"text":"retrieve game idea for gambo ai","estimatedIntent":"memory_retrieve","order":0,"dependsOn":[],"isLongRunning":false},{"text":"build game on gambo ai using idea","estimatedIntent":"command_automate","order":1,"dependsOn":[0],"isLongRunning":true,"dataTemplate":"Use this game idea from memory: {{result[0]}}"},{"text":"text me when the game is done","estimatedIntent":"command_automate","order":2,"dependsOn":[1],"isLongRunning":false}]}`;

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
  const { message, llmBackend, carriedIntent } = state;
  const logger = state.logger || console;

  // Pass-through: no message, skill_build fast-path, or already decomposed
  if (!message || state.skillBuildRequest || state.intentPlan) {
    return state;
  }

  logger.debug(`[Node:DecomposePrompt] Attempting decomposition: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`);

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

  return {
    ...state,
    intentPlan:     plan,
    _decomposedBy:  decomposedBy,
    _decomposedAt:  Date.now(),
  };
};

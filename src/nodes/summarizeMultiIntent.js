'use strict';

/**
 * summarizeMultiIntent node
 *
 * Combines the results of all executed sub-intent steps into one coherent
 * response for the user.  Called by the logConversation queue runner once
 * state.intentQueue is exhausted and state.intentResults contains ≥1 entry.
 *
 * Sets:
 *   state.answer            — combined / synthesised response
 *   state.isMultiIntent     — forced to false so logConversation exits normally
 *   state._multiIntentSummary — debug metadata { steps, combinedBy }
 *
 * Inputs from state:
 *   state.intentResults[]   — { step, intent, subPrompt, result }
 *   state.originalPrompt    — user's full original message
 *   state.llmBackend        — preferred LLM
 *   state.mcpAdapter        — phi4 fallback
 */

const COMBINE_SYSTEM_PROMPT = `You are combining the results of a multi-step task into one coherent response for the user.
Each step's result is labeled below. Synthesise them into a single, natural response.
Do NOT say "Step 1", "Step 2" etc. in the final answer — write as if it flows naturally.
Be concise. If some steps retrieved data that fed into a later step, only mention the final outcome.
CRITICAL: If any step FAILED or returned "(no result)" or an error, you MUST report the failure accurately. NEVER claim success for a step that failed. State clearly what went wrong and what the user may need to do.`;

module.exports = async function summarizeMultiIntent(state) {
  const logger = state.logger || console;
  const { intentResults, originalPrompt, llmBackend, mcpAdapter } = state;

  // No-op: nothing to combine (single-intent path reached here somehow)
  if (!Array.isArray(intentResults) || intentResults.length === 0) {
    logger.debug('[Node:SummarizeMultiIntent] No intentResults — skipping (no-op)');
    return {
      ...state,
      isMultiIntent: false,
    };
  }

  logger.info(`[Node:SummarizeMultiIntent] Combining ${intentResults.length} step results`);

  // ── Build the labelled sections block ─────────────────────────────────────
  const sections = intentResults
    .map((r) => {
      const result = r.result || '(no result)';
      const isFailed = !r.result || r.failed || /could not|error|failed|not found/i.test(result);
      const prefix = isFailed ? '[FAILED] ' : '';
      return `${prefix}[Step ${r.step + 1} - ${r.intent}]: ${result}`;
    })
    .join('\n\n');

  const originalRequest = originalPrompt || state.message || '';
  const systemInstructions = COMBINE_SYSTEM_PROMPT;
  const userPrompt = `The user's original request was: "${originalRequest}"\n\nStep results:\n\n${sections}`;

  let combinedAnswer = null;
  let combinedBy = 'fallback';

  // ── Path 1: llmBackend ─────────────────────────────────────────────────────
  if (llmBackend) {
    let available = false;
    try { available = await llmBackend.isAvailable(); } catch (_) { /* probe failed */ }

    if (available) {
      try {
        combinedAnswer = await llmBackend.generateAnswer(
          userPrompt,
          {
            query: userPrompt,
            context: { systemInstructions },
          },
          { maxTokens: 500, temperature: 0.1 }
        );
        if (combinedAnswer) {
          combinedBy = 'llm';
          logger.info('[Node:SummarizeMultiIntent] Combined via llmBackend');
        }
      } catch (e) {
        logger.warn(`[Node:SummarizeMultiIntent] llmBackend.generateAnswer failed: ${e.message}`);
      }
    }
  }

  // ── Path 2: MCP phi4 fallback ─────────────────────────────────────────────
  if (!combinedAnswer && mcpAdapter) {
    try {
      const response = await mcpAdapter.callService('phi4', 'general.answer', {
        query: userPrompt,
        context: { systemInstructions },
        options: { maxTokens: 500, temperature: 0.1 },
      });
      const text = response?.data?.answer || response?.answer || null;
      if (text) {
        combinedAnswer = text;
        combinedBy = 'mcp';
        logger.info('[Node:SummarizeMultiIntent] Combined via MCP phi4 fallback');
      }
    } catch (e) {
      logger.warn(`[Node:SummarizeMultiIntent] MCP phi4 fallback failed: ${e.message}`);
    }
  }

  // ── Path 3: plain-text concatenation ──────────────────────────────────────
  if (!combinedAnswer) {
    combinedAnswer = intentResults
      .map((r) => `**${r.intent}**: ${r.result || '(no result)'}`)
      .join('\n\n');
    combinedBy = 'fallback';
    logger.warn('[Node:SummarizeMultiIntent] Both LLM and MCP unavailable — using plain-text fallback');
  }

  logger.debug(`[Node:SummarizeMultiIntent] combinedBy="${combinedBy}", answer length=${combinedAnswer.length}`);

  return {
    ...state,
    answer:             combinedAnswer,
    isMultiIntent:      false,   // prevent logConversation re-entry loop
    _multiIntentSummary: {
      steps:      intentResults.length,
      combinedBy,
    },
  };
};

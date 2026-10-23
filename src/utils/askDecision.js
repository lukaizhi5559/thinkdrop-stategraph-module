'use strict';

/**
 * askDecision adapter for stategraph nodes.
 *
 * Wraps mcpAdapter.callService('phi4', 'decision.answer', …) into the
 * (questions, {state, image, timeoutMs}) → {answers, model, elapsedMs}|null
 * contract that classifyTask's local decision path consumes. Returns null
 * when mcpAdapter is absent or the service reports an error — callers treat
 * null as "use the remote path".
 *
 * Kill switches (read by callers):
 *   DECISION_LOCAL=0   — don't call at all
 *   DECISION_SHADOW=1  — caller runs remote too and logs agreement
 */

function makeAskDecision(mcpAdapter) {
  if (!mcpAdapter || process.env.DECISION_LOCAL === '0') return null;
  return async (questions, opts = {}) => {
    try {
      const r = await mcpAdapter.callService('phi4', 'decision.answer', {
        state: opts.state || '',
        questions,
        ...(opts.image ? { image: opts.image } : {}),
      }, { timeoutMs: opts.timeoutMs || 2500 });
      const data = r?.data || r;
      if (r?.status === 'error' || !data || typeof data.answers !== 'object') return null;
      return { answers: data.answers, model: data.model, elapsedMs: data.elapsedMs };
    } catch (_) {
      return null;
    }
  };
}

module.exports = { makeAskDecision };

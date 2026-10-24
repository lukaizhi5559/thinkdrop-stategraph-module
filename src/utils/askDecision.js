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

// DECISION_SHADOW_SITES — comma list ("prefix*" wildcard): when set, only the
// listed sites run shadow; all other sites go authoritative-local (fail-open
// remote on error/low-confidence). Unset → DECISION_SHADOW=1 shadows all.
function shadowSite(site) {
  if (process.env.DECISION_SHADOW !== '1') return false;
  const list = (process.env.DECISION_SHADOW_SITES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.some(pat => pat.endsWith('*')
    ? String(site || '').startsWith(pat.slice(0, -1))
    : String(site || '') === pat);
}

function makeAskDecision(mcpAdapter) {
  if (!mcpAdapter || process.env.DECISION_LOCAL === '0') return null;
  return async (questions, opts = {}) => {
    try {
      // Timeout scales with batch size — a 23-question classifyTask batch
      // can't fit in the old flat 2500ms on tev1:0.8b (~60-120ms/question).
      // noCircuit: a slow local model is not a dead phi4 — the fail-open
      // design already falls back; don't let it trip the shared breaker.
      const _n = Array.isArray(questions) ? questions.length : 1;
      const r = await mcpAdapter.callService('phi4', 'decision.answer', {
        state: opts.state || '',
        questions,
        ...(opts.image ? { image: opts.image } : {}),
      }, {
        timeoutMs: opts.timeoutMs
          || (process.env.DECISION_TIMEOUT_MS ? Number(process.env.DECISION_TIMEOUT_MS) : Math.min(6000 + 400 * _n, 15000)),
        noCircuit: true,
      });
      const data = r?.data || r;
      if (r?.status === 'error' || !data || typeof data.answers !== 'object') return null;
      return { answers: data.answers, model: data.model, elapsedMs: data.elapsedMs };
    } catch (_) {
      return null;
    }
  };
}

/**
 * boundedDecision — P2 shared helper for migrating bounded classification
 * call sites. Centralizes DECISION_LOCAL / DECISION_SHADOW so each migrated
 * site is a one-line swap.
 *
 * @param {object}   cfg
 *   askDecision    fn | null      — from makeAskDecision(mcpAdapter) or
 *                                   options.askDecision; null → remote path
 *   site           string         — shadow-log label, e.g. 'executeCommand.thinRecovery'
 *   questions      array          — systemone questions [{id,type,question,options?}]
 *   state          string|object  — decision context (prompt-state text or JSON)
 *   local          fn(answers)→any — build the site value from answers; return
 *                                   undefined/null to force remote fallback
 *   remote         fn()→any       — existing production path (async ok)
 *   logger         object         — optional; gets info/debug lines
 *   minConfidence  number         — optional floor on answer.confidence
 *                                   (choice/score only); below → remote
 * @returns remote value in shadow/disabled/fail modes; local value otherwise
 */
async function boundedDecision(cfg) {
  const { site, questions, state, local, remote, logger, minConfidence } = cfg;
  const askDecision = cfg.askDecision;
  const enabled = typeof askDecision === 'function' && process.env.DECISION_LOCAL !== '0';
  const shadow = enabled && shadowSite(site);

  if (!enabled) return remote();

  const runLocal = async () => {
    const r = await askDecision(questions, { state });
    if (!r?.answers) return { value: null, ms: null };
    // Confidence floor — low-confidence choice/score answers abstain to remote
    if (minConfidence != null) {
      for (const q of questions) {
        const a = r.answers[q.id];
        if (a && typeof a.confidence === 'number' && a.confidence < minConfidence) {
          return { value: null, ms: r.elapsedMs, lowConf: true };
        }
      }
    }
    const v = local(r.answers);
    return { value: v == null ? null : v, ms: r.elapsedMs, model: r.model };
  };

  if (shadow) {
    const remoteP = Promise.resolve().then(remote);
    let lv = null, lms = null, lerr = '';
    try { const l = await runLocal(); lv = l.value; lms = l.ms; }
    catch (e) { lerr = e.message; }
    const rv = await remoteP;
    const agree = lv != null && rv != null && JSON.stringify(lv) === JSON.stringify(rv);
    (logger || console).info?.(`[DecisionShadow] site=${site} agree=${agree} local=${JSON.stringify(lv)?.slice(0, 120)} remote=${JSON.stringify(rv)?.slice(0, 120)} localMs=${lms}${lerr ? ` err=${lerr}` : ''}`);
    return rv;
  }

  try {
    const l = await runLocal();
    if (l.value != null) {
      (logger || console).info?.(`[Decision] site=${site} local ${l.ms}ms model=${l.model || '?'}`);
      return l.value;
    }
    if (l.lowConf) (logger || console).debug?.(`[Decision] site=${site} low-confidence — remote fallback`);
  } catch (e) {
    (logger || console).debug?.(`[Decision] site=${site} failed: ${e.message} — remote fallback`);
  }
  return remote();
}

module.exports = { makeAskDecision, boundedDecision, shadowSite };

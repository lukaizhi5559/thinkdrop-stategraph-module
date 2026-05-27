'use strict';

/**
 * checkPlanCache Node
 *
 * Runs immediately after parseIntent for command_automate requests.
 * Performs an in-memory exact-match check AND a semantic disk search.
 *
 * Cache strategy (industry-standard):
 *   - Exact session cache hit    → inject _skillPlan, auto-execute (zero disk I/O)
 *   - Exact disk match           → inject _skillPlan, auto-execute, warm session cache
 *   - Semantic cosine ≥ 0.50    → set _cachedPlanSuggestion (picked up by planSkills
 *                                  which shows the approval modal — NEVER auto-executes)
 *   - No match                   → fall through to normal LLM planning
 *
 * State inputs:
 *   state.intent.type          — must be 'command_automate' to act
 *   state.message / resolvedMessage
 *   state.mcpAdapter           — used for semantic embedding call
 *   state._forceNewPlan        — if true, skip cache entirely
 *   state.recoveryContext      — if set, skip cache (re-plan after failure)
 *   state.isMultiIntent        — if true, skip cache
 *
 * State outputs:
 *   state._skillPlan             — exact match: pre-built plan array
 *   state._checkPlanCacheHit     — true (debug flag)
 *   state._cachedPlanSuggestion  — semantic match: { planFile, title, similarity, skillPlan, content }
 */

const {
  findSimilarCompletePlan,
  _sessionCacheKey,
  _sessionCacheGet,
  _sessionCacheSet,
  _isStaleBrowserActPlan,
} = require('../utils/planCacheHelpers');

module.exports = async function checkPlanCache(state) {
  const logger = state.logger || console;

  // Only act on command_automate — all other intents route differently
  if (state.intent?.type !== 'command_automate') {
    return state;
  }

  // Skip when guards are set (recovery, multi-intent, force-new)
  if (state._forceNewPlan || state.recoveryContext || state.isMultiIntent || state._planCorrectionMode) {
    return state;
  }

  // Skip if a plan is already injected upstream
  if (state._skillPlan && Array.isArray(state._skillPlan) && state._skillPlan.length > 0) {
    return state;
  }

  const userMessage = state.resolvedMessage || state.message || '';
  if (!userMessage) return state;

  // ── 1. In-memory session cache — exact-match only (zero disk I/O) ─────────
  const sessionId = state.context?.sessionId || null;
  const cacheKey = _sessionCacheKey(userMessage, sessionId);
  const cached   = _sessionCacheGet(cacheKey);
  if (cached) {
    if (_isStaleBrowserActPlan(cached.skillPlan, userMessage)) {
      logger.info(`[Node:CheckPlanCache] Session cache invalidated — stale browser.act plan for named service`);
    } else {
      logger.info(`[Node:CheckPlanCache] Session cache hit (exact) — injecting _skillPlan instantly`);
      return {
        ...state,
        _skillPlan:         cached.skillPlan,
        _checkPlanCacheHit: true,
        _cacheSource:       'session',
      };
    }
  }

  // ── 2. Disk search: exact match → auto-execute; semantic → suggestion only ──
  const mcpAdapter = state.mcpAdapter || null;
  const similarPlan = await findSimilarCompletePlan(userMessage, mcpAdapter, logger, sessionId);

  if (!similarPlan) return state;

  if (similarPlan.autoExecute) {
    logger.info(
      `[Node:CheckPlanCache] Disk exact match → auto-execute: ${similarPlan.file}`
    );
    _sessionCacheSet(cacheKey, similarPlan.skillPlan);
    return {
      ...state,
      _skillPlan:         similarPlan.skillPlan,
      _checkPlanCacheHit: true,
      _cacheSource:       'disk',
      _cachedPlanFile:    similarPlan.planFile,
      _cachedPlanTitle:   similarPlan.title,
      _cachedSimilarity:  similarPlan.similarity,
    };
  }

  // Semantic hit — surface as suggestion, never auto-execute
  logger.info(
    `[Node:CheckPlanCache] Semantic match (cosine=${similarPlan.similarity.toFixed(3)}) → approval modal via planSkills`
  );
  return {
    ...state,
    _cachedPlanSuggestion: {
      planFile:   similarPlan.planFile,
      title:      similarPlan.title,
      file:       similarPlan.file,
      similarity: similarPlan.similarity,
      skillPlan:  similarPlan.skillPlan,
      content:    similarPlan.content || '',
    },
  };
};

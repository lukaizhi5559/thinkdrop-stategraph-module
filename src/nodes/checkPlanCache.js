'use strict';

/**
 * checkPlanCache Node
 *
 * Runs immediately after parseIntent for command_automate requests.
 * Performs a pure in-memory + disk cache check BEFORE parseSkill,
 * enrichIntent, or any phi4 MCP calls execute.
 *
 * On a high-confidence hit the node sets state._skillPlan so that
 * parseSkill → enrichIntent → resolveUserContext all take their
 * existing fast-paths and skip every network call.
 *
 * Wall-time budget: < 5 ms (no network, no LLM).
 *
 * State inputs:
 *   state.intent.type          — must be 'command_automate' to act
 *   state.message / resolvedMessage
 *   state._forceNewPlan        — if true, skip cache entirely
 *   state.recoveryContext      — if set, skip cache (re-plan after failure)
 *   state.isMultiIntent        — if true, skip cache
 *
 * State outputs (on cache hit):
 *   state._skillPlan           — pre-built plan array → planSkills fast-paths on this
 *   state._checkPlanCacheHit   — true (debug flag)
 */

const {
  findSimilarCompletePlan,
  _sessionCacheKey,
  _sessionCacheGet,
  extractEntityAnchors,
  _sessionCacheSet,
  _isStaleBrowserActPlan,
  HIGH_CONFIDENCE_THRESHOLD,
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

  // ── 1. In-memory session cache (zero disk I/O) ────────────────────────────
  const cacheKey = _sessionCacheKey(userMessage);
  const cached   = _sessionCacheGet(cacheKey);
  if (cached) {
    // Invalidate stale browser.act plans for named-service tasks
    if (_isStaleBrowserActPlan(cached.skillPlan, userMessage)) {
      logger.info(`[Node:CheckPlanCache] Session cache invalidated — stale browser.act plan for named service`);
    } else {
      logger.info(`[Node:CheckPlanCache] Session cache hit — injecting _skillPlan instantly`);
      return {
        ...state,
        _skillPlan:          cached.skillPlan,
        _checkPlanCacheHit:  true,
        _cacheSource:        'session',
      };
    }
  }

  // ── 2. Disk-based plan match with entity-anchor guard ─────────────────────
  const similarPlan = findSimilarCompletePlan(userMessage, logger);
  if (similarPlan && similarPlan.autoExecute) {
    logger.info(
      `[Node:CheckPlanCache] Disk cache hit — injecting _skillPlan ` +
      `(${Math.round(similarPlan.similarity * 100)}% match, anchors verified)`
    );
    // Warm the session cache so the next identical request is instant
    _sessionCacheSet(cacheKey, similarPlan.skillPlan, similarPlan.anchors);
    return {
      ...state,
      _skillPlan:         similarPlan.skillPlan,
      _checkPlanCacheHit: true,
      _cacheSource:       'disk',
      // Pass metadata so planSkills can emit the right progress event if it runs
      _cachedPlanFile:    similarPlan.planFile,
      _cachedPlanTitle:   similarPlan.title,
      _cachedSimilarity:  similarPlan.similarity,
    };
  }

  // No high-confidence hit — fall through to normal planning pipeline
  return state;
};

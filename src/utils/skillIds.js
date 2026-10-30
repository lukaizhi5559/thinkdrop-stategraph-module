'use strict';

/**
 * Dispatchable-skill awareness — tells *.agent SKILL ids (executed through
 * command-service's command.automate dispatch: edit.agent, browser.agent,
 * video.agent, …) from registry AGENT ids (external service agents that need
 * onboarding/auth: youtube.agent, biblehub.agent, …).
 *
 * Preflight's registry readiness check must never gate on a dispatchable
 * skill — observed: a plan pinning edit.agent escalated needs_plan
 * (agent_not_onboarded) for a task that could have run directly.
 *
 * Two sources, unioned:
 *   1. POST /skill.list on command-service — the runtime dispatch table
 *      (authoritative, covers skills outside the contract vocabulary).
 *   2. shared/skill-contracts.cjs CONTRACTS — the compiler's own stepgen
 *      vocabulary; the offline fallback when command-service is unreachable.
 */

let _cache = { at: 0, ids: null };
const _TTL_MS = 60000;

function _contractSkillIds() {
  try {
    const { CONTRACTS } = require('../../../shared/skill-contracts.cjs');
    return Object.keys(CONTRACTS || {}).map(s => String(s).toLowerCase());
  } catch (_) {
    return [];
  }
}

/**
 * @param {Object} mcpAdapter — state.mcpAdapter (callService interface)
 * @returns {Promise<Set<string>>} lowercase dispatchable skill ids; never null
 *   (falls back to the contract set on fetch failure — the common case:
 *   edit.agent et al. are all contract skills).
 */
async function dispatchableSkills(mcpAdapter) {
  const base = new Set(_contractSkillIds());
  if (!mcpAdapter || typeof mcpAdapter.callService !== 'function') return base;
  if (_cache.ids && Date.now() - _cache.at < _TTL_MS) {
    for (const id of _cache.ids) base.add(id);
    return base;
  }
  const res = await mcpAdapter
    .callService('command', 'skill.list', {}, { timeoutMs: 3000 })
    .catch(() => null);
  const list = res?.data?.skills || res?.skills || (Array.isArray(res?.data) ? res.data : null) || (Array.isArray(res) ? res : null);
  if (Array.isArray(list) && list.length) {
    _cache = { at: Date.now(), ids: new Set(list.map(s => String(s).toLowerCase())) };
    for (const id of _cache.ids) base.add(id);
  }
  return base;
}

/** Synchronous contract-vocabulary check — no network. Use where an async
 *  fetch isn't already in flight. */
function isContractSkill(id) {
  if (!id) return false;
  return _contractSkillIds().includes(String(id).toLowerCase());
}

/** Test hook — reset the TTL cache between cases. */
function _resetCache() { _cache = { at: 0, ids: null }; }

module.exports = { dispatchableSkills, isContractSkill, _resetCache };

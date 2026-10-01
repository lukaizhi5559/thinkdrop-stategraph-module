'use strict';

/**
 * fastLanePlan Node — browse-answer fast lane
 *
 * Runs right after checkPlanCache. When taskClassification (resolveReferencesV2)
 * already proves the request is a simple public-web lookup — browse-only, no
 * DOM interaction, no login, no clarification needed — inject a fixed
 * [web.agent → app.agent read_url → synthesize] plan as _skillPlan instead of
 * paying for the full PlanSkillsV2 LLM planning pass (a ~78k-char prompt for
 * what is always the same 3 steps).
 *
 * read_url is the tiered fetch: invisible HTTP (~1s) → real-browser copy
 * (~5s, dodges bot walls via the user's session) → web.crawl playwright
 * fallback — so the plan stays 3 steps while the retry ladder lives inside
 * the skill.
 *
 * The injected _skillPlan rides the existing pre-built-plan machinery:
 * parseSkill/enrichIntent pass through, routeIntent skips resolveUserContext /
 * resolveAgent / preflightAgents / gatherPlanContext straight to planSkills,
 * and planSkillsV2's `_skillPlan` fast-path adopts it without an LLM call and
 * without an approval modal (read-only public fetches are low-risk, same as
 * the deterministic localPlanTemplates' lowRisk plans).
 *
 * Cache ordering: checkPlanCache runs first, so an exact/slot-matched cached
 * plan wins over the fixed fast-lane plan.
 */

const ABS_URL_RE = /(https?:\/\/[^\s"'<>)\]]+)/i;
const HOST_RE = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|co|edu|gov|info|me|us|uk|de|fr|jp|au|ca))((?:\/|#|\?)[^\s"'<>)\]]*)?/i;

function _extractUrl(message) {
  const m = message.match(ABS_URL_RE);
  if (m) return m[1];
  const h = message.match(HOST_RE);
  if (h) return `https://${h[1]}${h[2] || ''}`;
  return null;
}

// taskClassification-only eligibility — shared with decomposePromptV2, which
// short-circuits its LLM call when this passes (the gate can't drift apart or
// decompose would skip the call for prompts the lane then rejects).
function isBrowseFastLaneTc(tc) {
  if (!tc) return false;
  if (tc.isBrowseOnly !== true) return false;
  if (tc.requiresDOM === true) return false;
  if (tc.webAccessMode !== 'public_read') return false;
  if (tc.needsClarification === true) return false;
  // Resolved browse follow-ups ("yes, look up the Greek words" → followUpTarget
  // resolves to a concrete topic) are just as fixed-shape as fresh lookups —
  // the veto stays only for follow-ups whose referent never resolved.
  const _resolvedFollowUp = !!(tc.followUpTarget)
    && (!tc.resolution || tc.resolution === 'resolved');
  if ((tc.isFollowUp === true || tc.isThoughtReply === true) && !_resolvedFollowUp) return false;
  if (tc.resolution && tc.resolution !== 'resolved') return false;
  // Any screen/identity/content nuance needs the full planner.
  if (tc.isScreenFollowUp || tc.needsFreshScreen || tc.isAppUiInspection ||
      tc.isSpatialAnalysis || tc.isImageAnalysis || tc.isConversationRecall ||
      tc.isActivityQuery) return false;
  if (tc.expectsFileOutput === true) return false;
  if (tc.mediaListing && tc.mediaListing !== 'none') return false;
  if (Array.isArray(tc.interactiveActions) && tc.interactiveActions.length > 0) return false;
  return true;
}

function _eligible(state) {
  if (state.intent?.type !== 'command_automate') return false;
  // A pre-built plan (cache hit, resume, approval round-trip) always wins.
  if (state._skillPlan?.length || state._planFile || state._forceNewPlan) return false;
  if (state.recoveryContext || state.isMultiIntent || state._planCorrectionMode) return false;
  return isBrowseFastLaneTc(state._taskClassification);
}

module.exports = async function fastLanePlan(state) {
  const logger = state.logger || console;
  if (!_eligible(state)) return state;

  const message = (state.resolvedMessage || state.message || '').trim();
  if (!message) return state;

  const url = _extractUrl(message);
  const fetchStep = {
    skill: 'app.agent',
    args: {
      action: 'read_url',
      url: url || '{{bestUrl}}',
      fallbackUrls: url ? undefined : '{{fallbackUrls}}',
      cleanup: 'deselect',        // keep the tab open, clear the select-all highlight
      httpFirst: true,
      crawlFallback: true,
    },
    description: url ? `Read ${url.slice(0, 80)}` : 'Read the resolved page',
  };
  const synthStep = {
    skill: 'synthesize',
    args: {
      prompt: `Answer the user's request using the fetched page content. If the page content is missing or does not answer the question, say so plainly — do not invent facts. User asked: "${message.slice(0, 300)}"`,
    },
    description: 'Answer from fetched page content',
  };

  // Resolved follow-up targets are cleaner queries than the raw continuation
  // message; targetService biases the domain ranking ("biblehub look up…"
  // once returned a YouTube Short because preferDomain was null).
  const _tc2 = state._taskClassification || {};
  const _searchQuery = String(_tc2.followUpTarget || message).trim() || message;
  // Named-service tasks go through nav_task's resolve-discovery ladder
  // (KNOWN_BROWSER_SERVICES → deep-link discovery → read_url) instead of a
  // bare search — search_and_navigate's preferDomain is only a scoring bias
  // and picked a dcbridges.org mirror for a "biblegateway" task. browseFallback
  // keeps the search+read floor when the service isn't registered.
  const plan = url
    ? [fetchStep, synthStep]
    : _tc2.targetService
      ? [
          {
            skill: 'app.agent',
            args: {
              action: 'nav_task',
              service: _tc2.targetService,
              task: _searchQuery,
              escalate: false,
              browseFallback: true,
              timeoutMs: 120000,
            },
            description: `${_tc2.targetService}: ${_searchQuery.slice(0, 80)}`,
          },
          synthStep,
        ]
      : [
          {
            skill: 'web.agent',
            args: { action: 'search_and_navigate', query: _searchQuery },
            description: `Search the web for: "${_searchQuery.slice(0, 80)}"`,
          },
          fetchStep,
          synthStep,
        ];

  logger.info(`[Node:FastLanePlan] Browse fast-lane → ${plan.length}-step injected plan (url=${url ? 'literal' : _tc2.targetService ? `service:${_tc2.targetService}` : 'search'}) for: "${message.slice(0, 70)}"`);
  if (typeof state.progressCallback === 'function') {
    try {
      state.progressCallback({ type: 'node', node: 'fastLanePlan', label: 'Fast lane — direct web lookup', icon: 'bolt' });
    } catch (_) {}
  }

  // The executing plan is the injected fast-lane plan, not whatever
  // deterministic template decomposePromptV2 matched upstream (e.g.
  // bible_verse) — clear those flags so their per-step timeout cap and
  // answer-branch assumptions don't leak into this run.
  return {
    ...state,
    _skillPlan: plan,
    _fastLane: true,
    _deterministicPlan: null,
    _deterministicTemplate: null,
    _deterministicLowRisk: null,
    _deterministicExternal: null,
    _deterministicServiceAgent: null,
  };
};

module.exports.isBrowseFastLaneTc = isBrowseFastLaneTc;

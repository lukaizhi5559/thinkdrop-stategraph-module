'use strict';

/**
 * fastLanePlan Node — browse-answer fast lane
 *
 * Runs right after checkPlanCache. When taskClassification (resolveReferencesV2)
 * already proves the request is a simple public-web lookup — browse-only, no
 * DOM interaction, no login, no clarification needed — inject a fixed
 * [web.agent → web.crawl → synthesize] plan as _skillPlan instead of paying for
 * the full PlanSkillsV2 LLM planning pass (a ~78k-char prompt for what is
 * always the same 3 steps).
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

function _eligible(state) {
  if (state.intent?.type !== 'command_automate') return false;
  // A pre-built plan (cache hit, resume, approval round-trip) always wins.
  if (state._skillPlan?.length || state._planFile || state._forceNewPlan) return false;
  if (state.recoveryContext || state.isMultiIntent || state._planCorrectionMode) return false;

  const tc = state._taskClassification;
  if (!tc) return false;
  if (tc.isBrowseOnly !== true) return false;
  if (tc.requiresDOM === true) return false;
  if (tc.webAccessMode !== 'public_read') return false;
  if (tc.needsClarification === true) return false;
  if (tc.isFollowUp === true || tc.isThoughtReply === true) return false;
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

module.exports = async function fastLanePlan(state) {
  const logger = state.logger || console;
  if (!_eligible(state)) return state;

  const message = (state.resolvedMessage || state.message || '').trim();
  if (!message) return state;

  const url = _extractUrl(message);
  const synthStep = {
    skill: 'synthesize',
    stepType: 'verify',
    args: {
      prompt: `Answer the user's request using the fetched page content. If the page content is missing or does not answer the question, say so plainly — do not invent facts. User asked: "${message.slice(0, 300)}"`,
    },
    description: 'Answer from fetched page content',
  };

  const plan = url
    ? [
        {
          skill: 'web.crawl',
          args: { url, maxChars: 14000, hidden: true, extractItems: true },
          description: `Fetch ${url.slice(0, 80)}`,
        },
        synthStep,
      ]
    : [
        {
          skill: 'web.agent',
          args: { action: 'search_and_navigate', query: message },
          description: `Search the web for: "${message.slice(0, 80)}"`,
        },
        {
          skill: 'web.crawl',
          args: { url: '{{bestUrl}}', fallbackUrls: '{{fallbackUrls}}', maxChars: 14000, hidden: true, extractItems: true },
          description: 'Fetch the resolved page',
        },
        synthStep,
      ];

  logger.info(`[Node:FastLanePlan] Browse fast-lane → ${plan.length}-step injected plan (url=${url ? 'literal' : 'search'}) for: "${message.slice(0, 70)}"`);
  if (typeof state.progressCallback === 'function') {
    try {
      state.progressCallback({ type: 'node', node: 'fastLanePlan', label: 'Fast lane — direct web lookup', icon: 'bolt' });
    } catch (_) {}
  }
  return { ...state, _skillPlan: plan, _fastLane: true };
};

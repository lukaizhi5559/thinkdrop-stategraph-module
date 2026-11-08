'use strict';
/**
 * routeTable — deterministic intent suggestion from structured
 * _taskClassification fields (the LLM's semantic output), NOT from raw text.
 *
 * This is the guard chain in decomposePromptV2 expressed as a data table.
 * Each rule is (fields → intent) and enumerable/testable; the rules are in
 * the SAME precedence order as the guards they encode.
 *
 * Currently used in SHADOW MODE: decomposePromptV2 logs intent_shadow
 * divergences between the table's suggestion and the LLM decision. A null
 * return means "the table has no opinion — the LLM decides" (the map only
 * covers cases the codebase already decided deterministically).
 *
 * If shadow data shows agreement, the guards can collapse to this table and
 * the LLM number-call shrinks to the one question it must still answer:
 * single-step vs multi-step.
 */

const MULTI_GOAL_CONJUNCTIONS = /\b(and\s+then|also|after\s+that|additionally|plus|furthermore|then\s+also)\b|;\s*[a-z]/i;

const VIDEO_PLATFORMS = new Set(['youtube', 'yt', 'vimeo', 'tiktok', 'twitch', 'netflix', 'rumble', 'bitchute', 'dailymotion']);

const SINGLE_STEP_TASK_TYPES = new Set(['local_file', 'local_system', 'app_automation', 'browser']);

// Action taskTypes — the decompose guards' _ACTION_TASK_TYPES (SINGLE_STEP +
// messaging/scheduling). Single source of truth for both layers.
const ACTION_TASK_TYPES = new Set([...SINGLE_STEP_TASK_TYPES, 'messaging', 'scheduling']);

// Canonical shared patterns — the same imports decomposePromptV2 uses, so the
// table mirrors the guards' message-level exclusions instead of re-inventing
// them (a divergence dataset is only useful when the table is faithful).
const { SCREEN_OBSERVATION_RE, FILE_PATH_RE, EXPLICIT_FILE_PATH_RE, LOCAL_FS_PROBE_RE, DEICTIC_CONTINUATION_RE, DEICTIC_ARTIFACT_RE, SCREEN_CAPTURE_RE, GENERATIVE_TEXT_RE } = require('./textPatterns.cjs');

const FOLLOW_UP_TARGET_PATH = /^~?\//;
const FOLLOW_UP_TARGET_WINPATH = /^[A-Za-z]:[\\/]/;
const FOLLOW_UP_TARGET_FILE_EXT = /\.(rtf|pdf|docx?|xlsx?|csv|txt|md|png|jpe?g|gif|mp4|mov|zip)$/i;

/**
 * @param {Object} tc  state._taskClassification
 * @param {string} message  resolved message text (used for the multi-goal
 *                          conjunction check and the same canonical message
 *                          patterns the runtime guards apply)
 * @param {Object} [ctx]  runtime context the guards also read but tc doesn't
 *                          carry — { carriedHint, boundSession,
 *                          hasHighlightContext }. Absent ctx = no hint, no
 *                          bound session, no highlight (pure-field behavior,
 *                          kept for tests and offline replay).
 * @returns {{intent: string, rule: string} | null}
 */
function suggestIntent(tc, message, ctx) {
  if (!tc || typeof tc !== 'object') return null;
  ctx = ctx || {};
  const hasMultiGoal = MULTI_GOAL_CONJUNCTIONS.test(String(message || '').toLowerCase());

  // 1. declined-ack — user refused a card/offer → acknowledgement only
  if (tc.resolution === 'declined_ack') {
    return { intent: 'general_knowledge', rule: 'declined-ack' };
  }

  // 1b. screen-output — user wants content painted onto the screen surface
  //     (GhostLayer): "show it on the screen", "make it rain", "clear the screen"
  //     SCREEN_CAPTURE_RE suppresses: "take a screenshot" is a local capture
  //     action, not a display payload — classifyTask's isScreenOutput flag
  //     over-fires on it (observed divergence: table screen_display vs
  //     runtime command_automate — the runtime was right).
  if (tc.isScreenOutput && !hasMultiGoal && !SCREEN_CAPTURE_RE.test(message)) {
    return { intent: 'screen_display', rule: 'screen-output' };
  }

  // 1c. activity-recall — first-person past activity/consumption ("what did I
  //     watch", "what was I working on") is answered from episodic memory,
  //     never public research or automation. Mirrors the decompose
  //     activity-recall guard; a flaky webAccessMode must not leak it to
  //     web_search.
  if (tc.isActivityQuery && !hasMultiGoal) {
    return { intent: 'memory_retrieve', rule: 'activity-recall' };
  }

  // 2. media-search — image/video listing without a named site (or a video
  //    platform) routes to web_search instead of browser automation
  const mediaListing = tc.mediaListing || 'none';
  const targetSvc = String(tc.targetService || '').toLowerCase();
  if (
    !hasMultiGoal &&
    tc.webAccessMode !== 'interactive' &&
    (
      (mediaListing === 'image' && !tc.targetService) ||
      (mediaListing === 'video' && (!tc.targetService || VIDEO_PLATFORMS.has(targetSvc)))
    )
  ) {
    return { intent: 'web_search', rule: 'media-search' };
  }

  // 3. public-research — public web access, no named service → web_search.
  //    Mirrors decomposePromptV2's public-research guard: carriedHint veto,
  //    file/fs-path messages, live-surface vocabulary, in-page follow-ups on
  //    a bound tab, and activeDocRef all suppress it — the shadow dataset
  //    showed the unguarded rule diverging on "click the first result"
  //    (bound Amazon tab) into a Brave query the runtime never would run.
  const _inPageFollowUp = tc.isFollowUp === true && !!tc.followUpTarget && !!ctx.boundSession;
  if (tc.webAccessMode === 'public_read' && !tc.targetService && !hasMultiGoal
      && ctx.carriedHint !== 'command_automate'
      && !FILE_PATH_RE.test(message)
      && !LOCAL_FS_PROBE_RE.test(message)
      && !SCREEN_OBSERVATION_RE.test(message)
      && !_inPageFollowUp
      && !tc.activeDocRef) {
    return { intent: 'web_search', rule: 'public-research' };
  }

  // 4. query-followup — resolved topic + wants web access → web_search
  const followUpTargetIsPath = typeof tc.followUpTarget === 'string' && (
    FOLLOW_UP_TARGET_PATH.test(tc.followUpTarget) ||
    FOLLOW_UP_TARGET_WINPATH.test(tc.followUpTarget) ||
    FOLLOW_UP_TARGET_FILE_EXT.test(tc.followUpTarget)
  );
  if (
    tc.taskType === 'query' &&
    tc.isFollowUp &&
    tc.followUpTarget &&
    !followUpTargetIsPath &&
    tc.webAccessMode !== 'none' &&
    !tc.isScreenFollowUp &&
    !tc.isConversationRecall &&
    !tc.isActivityQuery &&
    !tc.isAppUiInspection &&
    !tc.isSpatialAnalysis &&
    !tc.needsFreshScreen &&
    !tc.targetService &&
    !tc.requiresDOM &&
    !hasMultiGoal
  ) {
    return { intent: 'web_search', rule: 'query-followup' };
  }

  // 5. local short-circuit — obvious single-step local/app tasks
  //    generativeOnly suppresses: "help me write a haiku" is one-shot text
  //    generation, not a local task — classifyTask's taskType buckets it as
  //    single-step anyway (observed divergence: table command_automate vs
  //    runtime general_knowledge — the runtime was right). File-targeted
  //    generation ("write a poem to poem.txt") stays task-shaped.
  if (SINGLE_STEP_TASK_TYPES.has(tc.taskType) && !tc.needsFreshScreen && !hasMultiGoal && !generativeOnly(message)) {
    return { intent: 'command_automate', rule: 'local-short-circuit' };
  }

  // 6. conversation-recall — meta-questions about prior turns → memory_retrieve
  if (tc.isConversationRecall && !hasMultiGoal) {
    return { intent: 'memory_retrieve', rule: 'conversation-recall' };
  }

  // 7. unresolved follow-up / needs_clarification — answer from context,
  //    never literal tool execution on ack text. Mirrors the decompose
  //    unresolved-follow-up guard: screen referents, action-shaped messages
  //    and highlight context suppress it; a bare deictic misresolved to an
  //    ambient doc is an extra trigger. (_correctionResolves — the installed-
  //    app filesystem probe — stays runtime-only: too heavy for the table.)
  const _screenReferent = tc.activeDocRef === 'screen'
    || tc.isScreenFollowUp === true
    || tc.needsFreshScreen === true
    || SCREEN_OBSERVATION_RE.test(message);
  const _actionable = ACTION_TASK_TYPES.has(tc.taskType)
    && (tc.suggestedIntent === 'command_automate'
        || tc.targetService
        || (tc.interactiveActions && tc.interactiveActions.length > 0));
  const _ambientMisref = DEICTIC_CONTINUATION_RE.test(message)
    && !ctx.hasHighlightContext
    && ['file', 'url'].includes(tc.activeDocRef)
    && !DEICTIC_ARTIFACT_RE.test(message);
  if ((tc.isFollowUp && !tc.followUpTarget) || tc.resolution === 'needs_clarification' || _ambientMisref) {
    if (!hasMultiGoal && !_screenReferent && !_actionable && !ctx.hasHighlightContext) {
      return { intent: 'memory_retrieve', rule: 'unresolved-followup' };
    }
  }

  // 8. thought-reply — reply bound to an attached card is a topical query
  //    about the card (grounded by search unless web access is off)
  if (tc.isThoughtReply && tc.followUpTarget && !hasMultiGoal) {
    return { intent: tc.webAccessMode === 'none' ? 'memory_retrieve' : 'web_search', rule: 'thought-reply' };
  }

  return null;
}

/** Shared suppressor: pure-text generative ask with no file target — never
 *  bind an executor lane (table or envelope) to it. */
function generativeOnly(message) {
  const m = String(message || '');
  return GENERATIVE_TEXT_RE.test(m) && !FILE_PATH_RE.test(m) && !EXPLICIT_FILE_PATH_RE.test(m);
}

module.exports = { suggestIntent, generativeOnly, MULTI_GOAL_CONJUNCTIONS, VIDEO_PLATFORMS, SINGLE_STEP_TASK_TYPES, ACTION_TASK_TYPES };

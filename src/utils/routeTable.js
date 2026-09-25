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

const FOLLOW_UP_TARGET_PATH = /^~?\//;
const FOLLOW_UP_TARGET_WINPATH = /^[A-Za-z]:[\\/]/;
const FOLLOW_UP_TARGET_FILE_EXT = /\.(rtf|pdf|docx?|xlsx?|csv|txt|md|png|jpe?g|gif|mp4|mov|zip)$/i;

/**
 * @param {Object} tc  state._taskClassification
 * @param {string} message  resolved message text (only used for the
 *                          multi-goal-conjunction check — a structural
 *                          property of the prompt, not NLU)
 * @returns {{intent: string, rule: string} | null}
 */
function suggestIntent(tc, message) {
  if (!tc || typeof tc !== 'object') return null;
  const hasMultiGoal = MULTI_GOAL_CONJUNCTIONS.test(String(message || '').toLowerCase());

  // 1. declined-ack — user refused a card/offer → acknowledgement only
  if (tc.resolution === 'declined_ack') {
    return { intent: 'general_knowledge', rule: 'declined-ack' };
  }

  // 1b. screen-output — user wants content painted onto the screen surface
  //     (GhostLayer): "show it on the screen", "make it rain", "clear the screen"
  if (tc.isScreenOutput && !hasMultiGoal) {
    return { intent: 'screen_display', rule: 'screen-output' };
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

  // 3. public-research — public web access, no named service → web_search
  if (tc.webAccessMode === 'public_read' && !tc.targetService && !hasMultiGoal) {
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
  if (SINGLE_STEP_TASK_TYPES.has(tc.taskType) && !tc.needsFreshScreen && !hasMultiGoal) {
    return { intent: 'command_automate', rule: 'local-short-circuit' };
  }

  // 6. conversation-recall — meta-questions about prior turns → memory_retrieve
  if (tc.isConversationRecall && !hasMultiGoal) {
    return { intent: 'memory_retrieve', rule: 'conversation-recall' };
  }

  // 7. unresolved follow-up / needs_clarification — answer from context,
  //    never literal tool execution on ack text
  if ((tc.isFollowUp && !tc.followUpTarget) || tc.resolution === 'needs_clarification') {
    if (!hasMultiGoal) {
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

module.exports = { suggestIntent, MULTI_GOAL_CONJUNCTIONS, VIDEO_PLATFORMS, SINGLE_STEP_TASK_TYPES };

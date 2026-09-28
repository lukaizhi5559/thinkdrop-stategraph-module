'use strict';
/**
 * routeIntent — post-enrichment routing decision (extracted from the
 * enrichIntent edge, a ~170-line function that mutated state inside a routing
 * function).
 *
 * Responsibilities, in original order:
 *   1. Clear plan-correction fields when a new session replaced the plan
 *   2. Inject prior screen context for isScreenFollowUp
 *   3. Override low-confidence command_automate → answer for screen queries
 *   4. Lazy screen grab handoff (needsFreshScreen)
 *   5. Unresolved enrichment gaps → logConversation (ask user)
 *   6. skill_creation follow-up → createSkillFromHistory
 *   7. Resume fast-paths → planSkills
 *   8. command_automate → resolveUserContext (with installed-skill check)
 *   9. intent → destination map
 *
 * Contract: returns `{ _advanceRoute, ...patch }` — the routeIntent edge is a
 * pure read of `_advanceRoute`.
 */
module.exports = async function routeIntent(state) {
  const logger = state.logger || console;
  const patch = {};
  const intentType = state.intent?.type || 'general_query';

  // Disable plan correction mode if a new session was created AND this is a new prompt (not plan execution)
  // Plan execution requests (with _planFile) should still work even with new sessions
  if (state._newSessionCreated && state._planCorrectionMode && !state._planFile) {
    logger.info('[Node:RouteIntent] New session created for new prompt - disabling plan correction mode');
    patch._planCorrectionMode = false;
    patch._planCorrectionText = null;
    patch._basePlanFile = null;
    patch._skillPlanJson = null;
    patch._planCorrectionSourcePrompt = null;
  }

  logger.info(`[Node:RouteIntent] enrichIntent exit — intent: ${intentType} | _planFile: ${!!state._planFile} | _planMode: ${!!state._planMode}`);

  // ── Screen follow-up: inject prior screen context before routing ─────────
  // When classifyTask detected isScreenFollowUp=true and we have a recent
  // screen context file, attach the OCR text to state.context so answer.js
  // injects it into systemInstructions regardless of which intent was classified.
  if (state._taskClassification?.isScreenFollowUp && state._priorScreenContext?.contextText) {
    logger.info(`[Node:RouteIntent] isScreenFollowUp=true — injecting prior screen context (${state._priorScreenContext.contextText.length} chars)`);
    patch.context = state._priorScreenContext.contextText;
    patch.screenContext = state._priorScreenContext;
    patch._needsContextInterpretation = true;
  }

  // ── Screen follow-up knowledge query: bypass automation entirely ──────────
  // classifyTask already classified this as taskType='query' — the user is
  // asking a knowledge question about what's on screen, not requesting an action.
  // Route directly to answer which already has state.context (OCR text) injected above.
  // BUT: Don't override if decomposePromptV2 clearly identified command_automate
  // with high confidence - this indicates a genuine automation request.
  if (
    state._taskClassification?.isScreenFollowUp &&
    state._taskClassification?.taskType === 'query' &&
    !state._taskClassification?.isAppUiInspection && // Never override named-app UI inspection tasks
    intentType === 'command_automate' &&
    (!state.intent || state.intent.confidence < 0.65) && // Only override genuinely absent/uncertain intents (0.7 is decompose default, not low-confidence)
    !state._planMode // Don't override during plan execution
  ) {
    logger.info(`[Node:RouteIntent] isScreenFollowUp+query — overriding low-confidence command_automate → answer`);
    patch.intent = { type: 'general_knowledge', confidence: 0.95, entities: [], requiresMemoryAccess: false };
    patch._advanceRoute = 'answer';
    return patch;
  }

  // ── Lazy screen grab: referential message but no screen context available ──
  // classifyTask set needsFreshScreen=true: message is deictic/ambiguous but
  // there is no PRIOR SCREEN CONTEXT block. Capture fresh screen content first,
  // then route to the correct handler with enriched context.
  // Guard: !state._needsFreshScreen prevents re-triggering after the grab completes.
  // screen_display never needs screen OCR — the payload renders on GhostLayer,
  // the capture just stalls the display and (worse) preparePostScreen used to
  // reroute it into answer ("display a spinning cube" → LLM answered with
  // terminal commands instead of painting WebGL).
  if (state._taskClassification?.needsFreshScreen && !state._needsFreshScreen && intentType !== 'screen_display') {
    logger.info(`[Node:RouteIntent] needsFreshScreen=true — auto-capturing screen before routing (intent: ${intentType})`);
    patch._needsFreshScreen = true;
    patch._postScreenIntent = intentType;
    patch._advanceRoute = 'screenIntelligence';
    return patch;
  }

  // Enrichment gaps remain — ask user first (surface the question via logConversation)
  if (Array.isArray(state.enrichmentNeeded) && state.enrichmentNeeded.length > 0) {
    logger.debug('[Node:RouteIntent] enrichIntent: gaps unresolved — asking user');
    patch._advanceRoute = 'logConversation';
    return patch;
  }

  // ── Skill creation from conversation history ───────────────────────────────
  // classifyTask detected skill_creation intent — user wants to turn code/script
  // from previous conversation into a reusable skill. Route to createSkillFromHistory.
  // CRITICAL: Only route to skill creation if it's a follow-up referring to previous code
  if (state._taskClassification?.taskType === 'skill_creation' &&
      state._taskClassification?.isFollowUp === true) {
    logger.info('[Node:RouteIntent] skill_creation + isFollowUp detected — routing to createSkillFromHistory');
    patch._advanceRoute = 'createSkillFromHistory';
    return patch;
  }

  // ── _skillPlan resume fast-path ────────────────────────────────────────────
  // Plan is pre-built (e.g. ask_user resume) — skip resolveUserContext,
  // resolveAgent, preflightAgents, gatherPlanContext and go straight to planSkills.
  // Also fast-route on _skipTrainingGate (proceed_anyway resume) so planSkills
  // generates a real plan without re-running preflight/gather nodes.
  if (intentType === 'command_automate' && (state._skillPlan || state._skipTrainingGate) && !state.recoveryContext) {
    logger.debug('[Node:RouteIntent] _skillPlan/_skipTrainingGate resume — skipping to planSkills');
    patch._advanceRoute = 'planSkills';
    return patch;
  }

  // ── planMode step short-circuit ────────────────────────────────────────────
  // planExecutor already set intent+message for this step — skip
  // resolveUserContext, gatherPlanContext and go straight to planSkills.
  if (intentType === 'command_automate' && state._planMode && state._planFile) {
    logger.debug('[Node:RouteIntent] _planMode step — skipping to planSkills');
    patch._advanceRoute = 'planSkills';
    return patch;
  }

  if (intentType === 'command_automate') {
    // Skill already installed (parseSkill matched) — skip creatorPlanning,
    // go straight to resolveUserContext → gatherPlanContext → planSkills.
    // BUT: if the skill is a stub (no index.cjs on disk), we must go through gatherContext
    // first so credentials/service info are collected before the skill build kicks off.
    if (state.matchedSkillName) {
      const _fs = require('fs');
      const _os = require('os');
      const _path = require('path');
      const _dotName = state.matchedSkillName;
      const _underscoreName = _dotName.replace(/\./g, '_');
      // Check both dot-notation and underscore directories
      const _candidates = [_dotName, _underscoreName].filter((v, i, a) => a.indexOf(v) === i);
      let _found = false;
      for (const _dirName of _candidates) {
        const _skillDir = _path.join(_os.homedir(), '.thinkdrop', 'skills', _dirName);
        const _skillExec = _path.join(_skillDir, 'index.cjs');
        const _skillMd   = _path.join(_skillDir, 'skill.md');
        const _apiJson   = _path.join(_skillDir, 'api.json');
        const _cliJson   = _path.join(_skillDir, 'cli.json');
        if (_fs.existsSync(_skillExec) || _fs.existsSync(_skillMd) || _fs.existsSync(_apiJson) || _fs.existsSync(_cliJson)) {
          logger.debug(`[Node:RouteIntent] matchedSkillName="${_dotName}" is installed (dir=${_dirName}) — skipping to resolveUserContext`);
          _found = true;
          break;
        }
      }
      if (_found) {
        patch._advanceRoute = 'resolveUserContext';
        return patch;
      }
      // Stub-only: no index.cjs on disk — fall through to resolveUserContext which handles it
      logger.debug(`[Node:RouteIntent] matchedSkillName="${_dotName}" is stub — routing to resolveUserContext`);
      patch.matchedSkillName = null;
      // fall through below
    }
    // gatherContext + creatorPlanning both bypassed — route to resolveUserContext → planSkills
    logger.debug('[Node:RouteIntent] command_automate — resolveUserContext');
    patch._advanceRoute = 'resolveUserContext';
    return patch;
  }

  // All other intents: route the same as parseIntent used to
  const INTENT_ROUTES = {
    set_constraint:     'storeConstraint',
    lift_constraint:    'liftConstraint',
    memory_store:       'storeMemory',
    memory_retrieve:    'retrieveMemory',
    command_execute:    'executeCommand',
    command_guide:      'executeCommand',
    plan_execute:       'planExecutor',
    screen_intelligence:'screenIntelligence',
    system_settings:    'executeSettings',
    system_introspect:  'executeIntrospect',
    app_control_start:  'parseProject',
    web_search:         'webSearch',
    question:           'webSearch',
    general_knowledge:  'webSearch',
    greeting:           'answer',
    screen_display:     'screenOutput',
  };
  patch._advanceRoute = INTENT_ROUTES[intentType] || 'retrieveMemory';
  return patch;
};

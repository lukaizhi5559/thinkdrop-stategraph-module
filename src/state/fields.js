'use strict';
/**
 * fields.js — registry of the `state._*` side-channel fields.
 *
 * The stategraph passes a single mutable-ish state bag through every node;
 * `state._x` fields are the de-facto IPC between nodes. This registry is the
 * contract: who WRITES each field, who READS it, and when it dies (lifecycle).
 *
 * lifecycle values:
 *   'run'     — set once, lives for the whole graph run
 *   'step'    — meaningful only within the current intent step; cleared by
 *               advanceQueue's per-step reset
 *   'routing' — produced by one node, consumed by the very next edge/node
 *   'session' — survives across runs (persisted / carried via resume)
 *
 * Not executable — documentation-as-code. Add new _fields here first.
 *
 * Node contract: a node may return a partial patch — the engine merges it via
 * Object.assign and records trace from `updatedState.trace || state.trace`.
 * Nodes do NOT need to spread `...state` just to preserve trace.
 */
module.exports = {
  // ── Classification / resolution (resolveReferencesV2 + clarify) ──────────
  _taskClassification: { writer: 'resolveReferencesV2/classifyTask', readers: 'everywhere', lifecycle: 'run', note: 'LLM classification artifact; referent fields cleared per queued step by advanceQueue. Subfields include isScreenOutput + screenOutputAction/Kind/Content/Mood → screen_display intent → screenOutput node (GhostLayer paint channel)' },
  _thoughtAttachment:  { writer: 'main.js initialState', readers: 'resolveReferencesV2, clarify', lifecycle: 'step', note: 'proactive card the user replied to' },
  _clarified:          { writer: 'clarify', readers: 'clarify', lifecycle: 'run', note: 'one-shot cap — clarification runs at most once per run' },
  _advanceRoute:       { writer: 'advanceQueue / preparePostScreen', readers: 'advanceQueue, preparePostScreen edges', lifecycle: 'routing', note: 'keeps edges pure — node computes, edge reads' },
  _decomposedBy:       { writer: 'decomposePromptV2', readers: 'tests, logs', lifecycle: 'run', note: 'which guard/path produced the intentPlan' },
  _decomposedIntent:   { writer: 'decomposePromptV2', readers: 'parseIntentV2', lifecycle: 'run' },
  _forceAnswerContext: { writer: 'resolveReferencesV2', readers: 'answer', lifecycle: 'step' },
  _llmDateRange:       { writer: 'resolveReferencesV2', readers: 'retrieveMemory', lifecycle: 'step' },
  _profileFallback:    { writer: 'retrieveMemory', readers: 'extractStepResult', lifecycle: 'step' },

  // ── Screen intelligence ──────────────────────────────────────────────────
  _needsFreshScreen:   { writer: 'resolveReferencesV2', readers: 'screenIntelligence edge, preparePostScreen', lifecycle: 'step' },
  _postScreenIntent:   { writer: 'resolveReferencesV2', readers: 'preparePostScreen', lifecycle: 'routing' },
  _priorScreenContext: { writer: 'preparePostScreen / main.js', readers: 'answer, webSearch, planSkillsV2', lifecycle: 'run' },
  _screenContextNote:  { writer: 'resolveReferencesV2', readers: 'answer', lifecycle: 'step' },

  // ── Planning / execution ─────────────────────────────────────────────────
  _skillPlan:          { writer: 'planSkillsV2', readers: 'executeCommand', lifecycle: 'step' },
  _skillPlanFile:      { writer: 'planSkillsV2', readers: 'executeCommand', lifecycle: 'step' },
  _skillPlanJson:      { writer: 'planSkillsV2', readers: 'executeCommand', lifecycle: 'step' },
  _skillPlanIsResume:  { writer: 'main.js resume', readers: 'planSkillsV2, executeCommand', lifecycle: 'session' },
  _planFile:           { writer: 'planExecutor/planSkillsV2', readers: 'executeCommand, _contract', lifecycle: 'step' },
  _planStepNum:        { writer: 'planExecutor', readers: '_contract', lifecycle: 'step' },
  _planMode:           { writer: 'planSkillsV2', readers: 'executeCommand', lifecycle: 'step' },
  _planCorrectionMode: { writer: 'gatherPlanContext/planSkillsV2', readers: 'planSkillsV2', lifecycle: 'step' },
  _planCorrectionSourcePrompt: { writer: 'gatherPlanContext', readers: 'planSkillsV2', lifecycle: 'step' },
  _planCorrectionText: { writer: 'gatherPlanContext', readers: 'planSkillsV2', lifecycle: 'step' },
  _basePlanFile:       { writer: 'planSkillsV2', readers: 'executeCommand', lifecycle: 'step' },
  _cachedPlanSuggestion: { writer: 'checkPlanCache', readers: 'planSkillsV2', lifecycle: 'step' },
  _checkPlanCacheHit:  { writer: 'checkPlanCache', readers: 'planSkillsV2', lifecycle: 'routing' },
  _recallPlanName:     { writer: 'resolveReferencesV2', readers: 'planSkillsV2', lifecycle: 'step' },
  _forceNewPlan:       { writer: 'resolveReferencesV2', readers: 'checkPlanCache', lifecycle: 'step' },
  _noInstalledSkillMatch: { writer: 'parseSkill', readers: 'planSkillsV2', lifecycle: 'routing' },
  _promptTier:         { writer: 'planSkillsV2', readers: 'logs', lifecycle: 'step' },
  _protectedPaths:     { writer: 'preflightAgents', readers: 'executeCommand', lifecycle: 'step' },
  _proceedAgentId:     { writer: 'resolveAgent', readers: 'executeCommand', lifecycle: 'step' },
  _proceedDeepLinkUrl: { writer: 'resolveAgent', readers: 'executeCommand', lifecycle: 'step' },
  _trainedRecipeMap:   { writer: 'parseSkill', readers: 'planSkillsV2', lifecycle: 'step' },
  _deliveryChannelResolved: { writer: 'gatherPlanContext', readers: 'executeCommand', lifecycle: 'step' },
  _emailTagSignal:     { writer: 'enrichIntentV2', readers: 'planSkillsV2', lifecycle: 'step' },
  _smsTagSignal:       { writer: 'enrichIntentV2', readers: 'planSkillsV2', lifecycle: 'step' },
  _mediaListing:       { writer: 'resolveReferencesV2', readers: 'decomposePromptV2, webSearch', lifecycle: 'step' },
  _needsWebDiscovery:  { writer: 'enrichIntentV2', readers: 'planSkillsV2', lifecycle: 'step' },
  _needsContextInterpretation: { writer: 'resolveReferencesV2', readers: 'answer', lifecycle: 'step' },

  // ── Clarification / gather ───────────────────────────────────────────────
  _bypassGatherPlan:   { writer: 'gatherPlanContext', readers: 'planSkillsV2', lifecycle: 'step' },
  _gatherQuestionPending: { writer: 'gatherPlanContext', readers: 'main.js', lifecycle: 'session', note: 'in-flight grill question' },
  _gatheredVars:       { writer: 'gatherPlanContext', readers: 'planSkillsV2, executeCommand', lifecycle: 'step' },
  _pendingPlanSecrets: { writer: 'gatherPlanContext', readers: 'main.js', lifecycle: 'session' },
  _pendingIntent:      { writer: 'main.js', readers: 'resolveReferencesV2', lifecycle: 'session', note: 'plan-approval intercept carry-over' },
  _capturedCorrection: { writer: 'gatherPlanContext', readers: 'planSkillsV2', lifecycle: 'step' },

  // ── Resume / session ─────────────────────────────────────────────────────
  _resumeContext:      { writer: 'main.js resume', readers: 'parseIntentV2, planSkillsV2', lifecycle: 'session' },
  _resumeDataContext:  { writer: 'main.js resume', readers: 'advanceQueue', lifecycle: 'session' },
  _resumeIntentQueue:  { writer: 'main.js resume', readers: 'advanceQueue', lifecycle: 'session' },
  _resumeIntentResults:{ writer: 'main.js resume', readers: 'advanceQueue', lifecycle: 'session' },
  _resumeMultiIntent:  { writer: 'main.js resume', readers: 'advanceQueue', lifecycle: 'session' },
  _resumePriorSynthesizedContent: { writer: 'main.js resume', readers: 'synthesize', lifecycle: 'session' },
  _resumeStepIndex:    { writer: 'main.js resume', readers: 'executeCommand', lifecycle: 'session' },
  _loginResumeSkillPlan: { writer: 'preflightAgents', readers: 'main.js', lifecycle: 'session' },
  _authContinueQueued: { writer: 'preflightAgents', readers: 'main.js', lifecycle: 'session' },
  _newSessionCreated:  { writer: 'executeCommand', readers: 'main.js', lifecycle: 'session' },
  _handoffTaskId:      { writer: 'handoffRunner', readers: 'executeCommand', lifecycle: 'run' },

  // ── Output / reporting ───────────────────────────────────────────────────
  _contract:           { writer: 'core/StateGraph.execute', readers: 'main.js planStepDispatcher', lifecycle: 'run', note: 'typed output contract' },
  _dataPrefix:         { writer: 'advanceQueue', readers: 'enrichIntentV2/answer', lifecycle: 'step' },
  _dataFile:           { writer: 'advanceQueue/extractStepResult', readers: 'executeCommand', lifecycle: 'step' },
  _multiIntentSummary: { writer: 'summarizeMultiIntent', readers: 'main.js', lifecycle: 'run' },
  _answerStreamed:     { writer: 'answer', readers: 'main.js', lifecycle: 'step' },
  _synthThinking:      { writer: 'synthesize', readers: 'main.js', lifecycle: 'step' },
  _fileResolution:     { writer: 'resolveReferencesV2', readers: 'executeCommand', lifecycle: 'step' },
  _isAgentAskUser:     { writer: 'executeCommand', readers: 'advanceQueue/progressCallback', lifecycle: 'step' },
  _lastShellRun:       { writer: 'executeCommand', readers: 'answer', lifecycle: 'step' },
  _skipTrainingGate:   { writer: 'parseSkill', readers: 'planSkillsV2', lifecycle: 'routing' },
  _skipUserLog:        { writer: 'logConversation', readers: 'main.js', lifecycle: 'run' },
};

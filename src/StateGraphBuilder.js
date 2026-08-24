/**
 * StateGraphBuilder - Factory for creating configured StateGraph instances
 * 
 * Provides progressive enhancement levels:
 * - minimal(): Intent classification only (no MCP required)
 * - basic(): Intent + mock responses (no MCP required)
 * - standard(): Intent + real LLM answers (phi4 required)
 * - full(): All nodes enabled (all MCP services required)
 */

const StateGraph = require('./core/StateGraph');
const MockMCPAdapter = require('./adapters/MockMCPAdapter');
const decomposePromptNode = require('./nodes/decomposePromptV2');
const parseIntentNode = require('./nodes/parseIntentV2');
const answerNode = require('./nodes/answer');
const retrieveMemoryNode = require('./nodes/retrieveMemory');
const storeMemoryNode = require('./nodes/storeMemory');
const webSearchNode = require('./nodes/webSearch');
const executeCommandNode = require('./nodes/executeCommand');
const planSkillsNode = require('./nodes/planSkillsV2');
const screenIntelligenceNode = require('./nodes/screenIntelligence');
const logConversationNode = require('./nodes/logConversation');
const resolveReferencesNode = require('./nodes/resolveReferencesV2');
const parseSkillNode = require('./nodes/parseSkill');
const checkPlanCacheNode = require('./nodes/checkPlanCache');
const synthesizeNode = require('./nodes/synthesize');
const enrichIntentNode = require('./nodes/enrichIntentV2');
const evaluateSkillsNode = require('./nodes/evaluateSkills');
const reviewExecutionNode = require('./nodes/reviewExecution');
const creatorPlanningNode = require('./nodes/creatorPlanning');
const appControlNode = require('./nodes/appControl');
const storeConstraintNode = require('./nodes/storeConstraint');
const liftConstraintNode  = require('./nodes/liftConstraint');
const parseProjectNode = require('./nodes/parseProject');
const summarizeMultiIntentNode = require('./nodes/summarizeMultiIntent');
const resolveUserContextNode = require('./nodes/resolveUserContext');
const gatherPlanContextNode = require('./nodes/gatherPlanContext');
const executeIntrospectNode = require('./nodes/executeIntrospect');
const executeSettingsNode = require('./nodes/executeSettings');
const createSkillFromHistoryNode = require('./nodes/createSkillFromHistory');
const planExecutorNode = require('./nodes/planExecutor');
const preflightAgentsNode = require('./nodes/preflightAgents');
const resolveAgentNode = require('./nodes/resolveAgent');

// assessRisk and detectOperationType removed — grill-mode pipeline deleted

/**
 * Extract the most useful short result string from a completed intent step.
 * Used to populate state.dataContext[N] for injection into dependent steps.
 *
 * Returns either a plain string (≤2000 chars) or an object { summary, file }
 * when the full result exceeds 2000 chars and was written to a pipeline buffer file.
 */
function extractStepResult(state) {
  const intent = state.intent?.type;
  const logger = state.logger || console;

  // Debug logging
  logger.info(`[extractStepResult] intent=${intent}, filteredMemories=${Array.isArray(state.filteredMemories) ? state.filteredMemories.length : 'N/A'}`);
  if (Array.isArray(state.filteredMemories) && state.filteredMemories.length > 0) {
    logger.info(`[extractStepResult] First memory keys: ${Object.keys(state.filteredMemories[0]).join(', ')}`);
  }

  // memory_retrieve: use first memory's text (field is 'text', not 'source_text')
  if (intent === 'memory_retrieve' && Array.isArray(state.filteredMemories) && state.filteredMemories.length > 0) {
    const result = state.filteredMemories
      .slice(0, 3)
      .map(m => m.text || m.source_text || m.extracted_text || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
    logger.info(`[extractStepResult] Extracted ${result.length} chars from ${state.filteredMemories.length} memories`);
    return result;
  }

  // memory_retrieve with profile fallback (when semantic search returns nothing but profile has the data)
  if (intent === 'memory_retrieve' && state._profileFallback) {
    const result = `Profile: ${state._profileFallback.key} = ${state._profileFallback.value}`;
    logger.info(`[extractStepResult] Extracted profile fallback: ${result.slice(0, 100)}...`);
    return result;
  }

  // memory_retrieve with conversation history (when no memories but conversation has relevant info)
  if (intent === 'memory_retrieve' && Array.isArray(state.conversationHistory) && state.conversationHistory.length > 0) {
    const result = state.conversationHistory
      .slice(0, 5)
      .map(m => m.content || m.text || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
    logger.info(`[extractStepResult] Extracted ${result.length} chars from ${state.conversationHistory.length} conversation messages`);
    return result;
  }

  // web_search: use top result snippet
  if (intent === 'web_search' && Array.isArray(state.contextDocs) && state.contextDocs.length > 0) {
    return state.contextDocs
      .slice(0, 2)
      .map(d => d.snippet || d.title || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
  }

  // command_automate: use answer or last skill stdout — buffer to file if > 2000 chars
  if (intent === 'command_automate') {
    const raw = state.answer || (() => {
      if (Array.isArray(state.skillResults)) {
        const last = state.skillResults.filter(r => r.ok && r.stdout).pop();
        return last ? last.stdout : null;
      }
      return null;
    })();
    if (raw) {
      if (raw.length <= 2000) return raw;
      // Write full content to a pipeline buffer file; return summary + file ref
      try {
        const _fs = require('fs');
        const _os = require('os');
        const _path = require('path');
        const runId  = state._runId || state.sessionId || `run_${Date.now()}`;
        const stepN  = state.intentResults ? state.intentResults.length : 0;
        const bufDir = _path.join(_os.homedir(), '.thinkdrop', 'pipeline', runId);
        _fs.mkdirSync(bufDir, { recursive: true });
        const filePath = _path.join(bufDir, `step_${stepN}.md`);
        _fs.writeFileSync(filePath, raw, 'utf8');
        return { summary: raw.slice(0, 2000), file: filePath };
      } catch (_) {
        return raw.slice(0, 2000); // fallback: truncate if file write fails
      }
    }
  }

  // memory_store: use the answer set by storeMemory node
  if (intent === 'memory_store') {
    return state.answer?.slice(0, 2000) || `Got it! I'll remember that.`;
  }

  // Default: use state.answer if available
  return state.answer?.slice(0, 2000) || state.message?.slice(0, 200) || '';
}

class StateGraphBuilder {
  /**
   * Create a minimal graph for intent classification testing
   * No MCP services required - uses rule-based fallback
   * 
   * @param {Object} options - Configuration options
   * @param {Object} options.logger - Custom logger (default: console)
   * @param {Object} options.mcpAdapter - MCP adapter (default: null for fallback)
   * @returns {StateGraph} Configured graph
   */
  static minimal(options = {}) {
    const logger = options.logger || console;
    const mcpAdapter = options.mcpAdapter || null; // No adapter = fallback mode
    const llmBackend = options.llmBackend || null;
    
    logger.debug('[StateGraphBuilder] Creating MINIMAL graph (intent classification only)');
    
    // Minimal nodes: just parseIntent → answer
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter, llmBackend })
    };
    
    // Simple linear flow
    const edges = {
      start: 'parseIntent',
      parseIntent: 'answer',
      answer: 'end'
    };
    
    return new StateGraph(nodes, edges, {
      logger,
      mcpAdapter,
      debug: options.debug || false
    });
  }

  /**
   * Create a basic graph with mock responses
   * No MCP services required - uses MockMCPAdapter
   * 
   * @param {Object} options - Configuration options
   * @returns {StateGraph} Configured graph
   */
  static basic(options = {}) {
    const logger = options.logger || console;
    const mcpAdapter = options.mcpAdapter || new MockMCPAdapter({ logger });
    const llmBackend = options.llmBackend || null;
    
    logger.debug('[StateGraphBuilder] Creating BASIC graph (intent + mock responses)');
    
    // Basic nodes: parseIntent → answer with mock data
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter, llmBackend })
    };
    
    const edges = {
      start: 'parseIntent',
      parseIntent: 'answer',
      answer: 'end'
    };
    
    return new StateGraph(nodes, edges, {
      logger,
      mcpAdapter,
      debug: options.debug || false
    });
  }

  /**
   * Create a standard graph with real LLM answers
   * Requires phi4 MCP service
   * 
   * @param {Object} options - Configuration options
   * @param {Object} options.mcpAdapter - MCP adapter (required)
   * @returns {StateGraph} Configured graph
   */
  static standard(options = {}) {
    const logger = options.logger || console;
    const mcpAdapter = options.mcpAdapter;
    const llmBackend = options.llmBackend || null;
    
    if (!mcpAdapter && !llmBackend) {
      throw new Error('[StateGraphBuilder] standard() requires mcpAdapter or llmBackend');
    }
    
    logger.debug('[StateGraphBuilder] Creating STANDARD graph (intent + real LLM + conversation log)');
    
    // Standard nodes: parseIntent → retrieveMemory → answer → logConversation
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      retrieveMemory: (state) => retrieveMemoryNode({ ...state, logger, mcpAdapter }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter, llmBackend }),
      logConversation: (state) => logConversationNode({ ...state, logger, mcpAdapter, llmBackend })
    };
    
    const edges = {
      start: 'parseIntent',
      parseIntent: 'retrieveMemory',
      retrieveMemory: 'answer',
      answer: 'logConversation',
      logConversation: 'end'
    };
    
    return new StateGraph(nodes, edges, {
      logger,
      mcpAdapter,
      debug: options.debug || false
    });
  }

  /**
   * Create a full-featured graph with all nodes
   * Requires all MCP services
   * 
   * @param {Object} options - Configuration options
   * @param {Object} options.mcpAdapter - MCP adapter (required)
   * @param {Array<string>} options.enabledNodes - Nodes to enable (default: all)
   * @returns {StateGraph} Configured graph
   */
  static full(options = {}) {
    const logger = options.logger || console;
    const mcpAdapter = options.mcpAdapter;
    const llmBackend = options.llmBackend || null;
    
    if (!mcpAdapter && !llmBackend) {
      throw new Error('[StateGraphBuilder] full() requires mcpAdapter or llmBackend');
    }
    
    logger.debug(`[StateGraphBuilder] Creating FULL graph (all nodes enabled, llmBackend: ${llmBackend ? llmBackend.getInfo().name : 'MCPLLMBackend/phi4'})`);
    
    // Full nodes with intent-based routing
    const nodes = {
      decomposePrompt: (state) => decomposePromptNode({ ...state, logger, llmBackend }),
      resolveReferences: (state) => resolveReferencesNode({ ...state, logger, mcpAdapter, llmBackend }),
      parseSkill: (state) => parseSkillNode({ ...state, logger, mcpAdapter, llmBackend }),
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      checkPlanCache: (state) => checkPlanCacheNode({ ...state, logger }),
      enrichIntent: (state) => enrichIntentNode({ ...state, logger, mcpAdapter }),
      resolveUserContext: (state) => resolveUserContextNode({ ...state, logger, mcpAdapter }),
      gatherPlanContext: (state) => gatherPlanContextNode({ ...state, logger, mcpAdapter, llmBackend }),
      retrieveMemory: (state) => retrieveMemoryNode({ ...state, logger, mcpAdapter }),
      storeMemory: (state) => storeMemoryNode({ ...state, logger, mcpAdapter }),
      storeConstraint: (state) => storeConstraintNode({ ...state, logger, mcpAdapter }),
      liftConstraint:  (state) => liftConstraintNode({ ...state, logger, mcpAdapter }),
      webSearch: (state) => webSearchNode({ ...state, logger, mcpAdapter }),
      gatherContext: (state) => gatherPlanContextNode({ ...state, logger, mcpAdapter, llmBackend }),
      creatorPlanning: (state) => creatorPlanningNode({ ...state, logger, mcpAdapter }),
      resolveAgent: (state) => resolveAgentNode({ ...state, logger, mcpAdapter, llmBackend }),
      preflightAgents: (state) => preflightAgentsNode({ ...state, logger, mcpAdapter }),
      planSkills: (state) => planSkillsNode({ ...state, logger, mcpAdapter, llmBackend }),
      executeCommand: (state) => executeCommandNode({ ...state, logger, mcpAdapter, llmBackend }),
      evaluateSkills: (state) => evaluateSkillsNode({ ...state, logger, mcpAdapter, llmBackend }),
      reviewExecution: (state) => reviewExecutionNode({ ...state, logger, mcpAdapter, llmBackend }),
      screenIntelligence: (state) => screenIntelligenceNode({ ...state, logger, mcpAdapter }),
      synthesize: (state) => synthesizeNode({ ...state, logger, mcpAdapter, llmBackend }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter, llmBackend }),
      appControl: (state) => appControlNode({ ...state, logger }),
      parseProject: (state) => parseProjectNode({ ...state, logger, llmBackend }),
      logConversation: (state) => logConversationNode({ ...state, logger, mcpAdapter, llmBackend }),
      summarizeMultiIntent: (state) => summarizeMultiIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      executeIntrospect: (state) => executeIntrospectNode({ ...state, logger, mcpAdapter }),
      executeSettings: (state) => executeSettingsNode({ ...state, logger }),
      createSkillFromHistory: (state) => createSkillFromHistoryNode({ ...state, logger, mcpAdapter, llmBackend }),
      planExecutor: (state) => planExecutorNode({ ...state, logger, mcpAdapter, llmBackend }),
    };
    
    // Intent-based routing (matches DistilBERT classifier intents)
    const edges = {
      start: 'resolveReferences',
      resolveReferences: 'decomposePrompt',
      decomposePrompt: 'parseIntent',
      parseIntent: 'checkPlanCache',
      checkPlanCache: 'parseSkill',
      parseSkill: (state) => {
        // parseIntent has already run upstream — always proceed to enrichIntent.
        // parseSkill may have set matchedSkillName via strategies 1/2 (exact/phrase match)
        // or strategy 2.5/2.7/3 (gated on command_automate). Intent is preserved either way.
        if (state.matchedSkillName) {
          logger.debug(`[StateGraph:Router] parseSkill matched "${state.matchedSkillName}" — routing to enrichIntent`);
        } else {
          logger.debug(`[StateGraph:Router] parseSkill no match — routing to enrichIntent (intent: ${state.intent?.type})`);
        }
        return 'enrichIntent';
      },

      // enrichIntent router: handles MODE B re-routing + MODE A gap/resolve routing
      enrichIntent: async (state) => {
        const intentType = state.intent?.type || 'general_query';
        
        // Disable plan correction mode if a new session was created AND this is a new prompt (not plan execution)
        // Plan execution requests (with _planFile) should still work even with new sessions
        if (state._newSessionCreated && state._planCorrectionMode && !state._planFile) {
          logger.info('[StateGraph:Router] New session created for new prompt - disabling plan correction mode');
          state._planCorrectionMode = false;
          state._planCorrectionText = null;
          state._basePlanFile = null;
          state._skillPlanJson = null;
          state._planCorrectionSourcePrompt = null;
        }
        
        logger.info(`[StateGraph:Router] enrichIntent exit — intent: ${intentType} | _planFile: ${!!state._planFile} | _planMode: ${!!state._planMode}`);

        // ── Screen follow-up: inject prior screen context before routing ─────
        // When classifyTask detected isScreenFollowUp=true and we have a recent
        // screen context file, attach the OCR text to state.context so answer.js
        // injects it into systemInstructions regardless of which intent was classified.
        if (state._taskClassification?.isScreenFollowUp && state._priorScreenContext?.contextText) {
          logger.info(`[StateGraph:Router] isScreenFollowUp=true — injecting prior screen context (${state._priorScreenContext.contextText.length} chars)`);
          state.context = state._priorScreenContext.contextText;
          state.screenContext = state._priorScreenContext;
          state._needsContextInterpretation = true;
        }

        // ── Screen follow-up knowledge query: bypass automation entirely ────────
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
          logger.info(`[StateGraph:Router] isScreenFollowUp+query — overriding low-confidence command_automate → answer`);
          state.intent = { type: 'general_knowledge', confidence: 0.95, entities: [], requiresMemoryAccess: false };
          return 'answer';
        }

        // ── Lazy screen grab: referential message but no screen context available ───
        // classifyTask set needsFreshScreen=true: message is deictic/ambiguous but
        // there is no PRIOR SCREEN CONTEXT block. Capture fresh screen content first,
        // then route to the correct handler with enriched context.
        // Guard: !state._needsFreshScreen prevents re-triggering after the grab completes.
        if (state._taskClassification?.needsFreshScreen && !state._needsFreshScreen) {
          logger.info(`[StateGraph:Router] needsFreshScreen=true — auto-capturing screen before routing (intent: ${intentType})`);
          state._needsFreshScreen = true;
          state._postScreenIntent = intentType;
          return 'screenIntelligence';
        }

        // Enrichment gaps remain — ask user first (surface the question via logConversation)
        if (Array.isArray(state.enrichmentNeeded) && state.enrichmentNeeded.length > 0) {
          logger.debug('[StateGraph:Router] enrichIntent: gaps unresolved — asking user');
          return 'logConversation';
        }

        // ── Skill creation from conversation history ───────────────────────────
        // classifyTask detected skill_creation intent — user wants to turn code/script
        // from previous conversation into a reusable skill. Route to createSkillFromHistory.
        // CRITICAL: Only route to skill creation if it's a follow-up referring to previous code
        if (state._taskClassification?.taskType === 'skill_creation' && 
            state._taskClassification?.isFollowUp === true) {
          logger.info('[StateGraph:Router] skill_creation + isFollowUp detected — routing to createSkillFromHistory');
          return 'createSkillFromHistory';
        }

        // ── _skillPlan resume fast-path ──────────────────────────────────────
        // Plan is pre-built (e.g. ask_user resume) — skip resolveUserContext,
        // resolveAgent, preflightAgents, gatherPlanContext and go straight to planSkills.
        // Also fast-route on _skipTrainingGate (proceed_anyway resume) so planSkills
        // generates a real plan without re-running preflight/gather nodes.
        if (intentType === 'command_automate' && (state._skillPlan || state._skipTrainingGate) && !state.recoveryContext) {
          logger.debug('[StateGraph:Router] enrichIntent: _skillPlan/_skipTrainingGate resume — skipping to planSkills');
          return 'planSkills';
        }

        // ── planMode step short-circuit ────────────────────────────────────
        // planExecutor already set intent+message for this step — skip
        // resolveUserContext, gatherPlanContext and go straight to planSkills.
        if (intentType === 'command_automate' && state._planMode && state._planFile) {
          logger.debug('[StateGraph:Router] enrichIntent: _planMode step — skipping to planSkills');
          return 'planSkills';
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
                logger.debug(`[StateGraph:Router] enrichIntent: matchedSkillName="${_dotName}" is installed (dir=${_dirName}) — skipping to resolveUserContext`);
                _found = true;
                break;
              }
            }
            if (_found) return 'resolveUserContext';
            // Stub-only: no index.cjs on disk — fall through to resolveUserContext which handles it
            logger.debug(`[StateGraph:Router] enrichIntent: matchedSkillName="${_dotName}" is stub — routing to resolveUserContext`);
            state.matchedSkillName = null;
            // fall through below
          }
          // gatherContext + creatorPlanning both bypassed — route to resolveUserContext → planSkills
          logger.debug('[StateGraph:Router] enrichIntent: command_automate — resolveUserContext');
          return 'resolveUserContext';
        }

        // All other intents: route the same as parseIntent used to
        if (intentType === 'set_constraint') {
          return 'storeConstraint';
        }
        if (intentType === 'lift_constraint') {
          return 'liftConstraint';
        }
        if (intentType === 'memory_store') {
          return 'storeMemory';
        }
        if (intentType === 'memory_retrieve') {
          return 'retrieveMemory';
        }
        if (intentType === 'command_execute' || intentType === 'command_guide') {
          return 'executeCommand';
        }
        if (intentType === 'plan_execute') {
          return 'planExecutor';
        }
        if (intentType === 'screen_intelligence') {
          return 'screenIntelligence';
        }
        if (intentType === 'system_settings') {
          return 'executeSettings';
        }
        if (intentType === 'system_introspect') {
          return 'executeIntrospect';
        }
        if (intentType === 'app_control_start') {
          return 'parseProject';
        }
        if (intentType === 'web_search' || intentType === 'question' || intentType === 'general_knowledge') {
          return 'webSearch';
        }
        if (intentType === 'greeting') {
          return 'answer';
        }
        return 'retrieveMemory';
      },

      // Introspection path: executeIntrospect → answer → logConversation
      executeIntrospect: 'answer',

      // Settings path: executeSettings → answer → logConversation
      executeSettings: 'answer',

      // Memory store path: store → logConversation → end
      storeMemory: 'logConversation',
      // Constraint store path: storeConstraint → logConversation → end
      storeConstraint: 'logConversation',
      // Constraint lift path: liftConstraint → logConversation → end
      liftConstraint: 'logConversation',

      // Skill creation from history → logConversation → end
      createSkillFromHistory: 'logConversation',

      // resolveUserContext → resolveAgent → preflightAgents → gatherPlanContext → planSkills
      // resolveAgent picks the agents; preflightAgents checks their auth status
      resolveUserContext: 'resolveAgent',

      // resolveAgent: selects agents, then proceeds to preflightAgents
      resolveAgent: () => {
        logger.debug('[StateGraph:Router] resolveAgent → preflightAgents');
        return 'preflightAgents';
      },

      // preflightAgents: proceeds to gatherPlanContext (with auth data now in state)
      preflightAgents: (state) => {
        if (state.planError) {
          logger.info('[StateGraph:Router] preflightAgents has planError → logConversation');
          return 'logConversation';
        }
        logger.debug('[StateGraph:Router] preflightAgents → gatherPlanContext');
        return 'gatherPlanContext';
      },

      // gatherPlanContext: now auth-aware — proceeds to planSkills
      gatherPlanContext: () => {
        logger.debug('[StateGraph:Router] gatherPlanContext → planSkills');
        return 'planSkills';
      },

      // gatherContext node (alias for gatherPlanContext — retained for compat)
      gatherContext: () => 'planSkills',
      creatorPlanning: () => 'planSkills',

      // planSkills → end (awaiting approval) or executeCommand (plan ready) or logConversation (plan error)
      planSkills: (state) => {
        if (state.awaitingPlanApproval) {
          logger.info('[StateGraph:Router] planSkills: awaitingPlanApproval=true — exiting for user review');
          return 'end';
        }
        if (state.planError && !state.skillPlan) {
          logger.debug(`[StateGraph:Router] planSkills failed: ${state.planError}`);
          // If all providers failed, surface this to the user instead of silent fallback
          if (state.planError.includes('All LLM providers failed')) {
            state.answer = "I'm unable to process your request right now because all AI providers are currently unavailable. This is likely due to rate limits or API key issues. Please check your provider settings or try again in a few minutes.";
            logger.info('[StateGraph:Router] All providers failed — surfacing error to user');
            // Emit progress event to update UI immediately (don't leave it stuck on "Planning steps...")
            if (typeof state.progressCallback === 'function') {
              try {
                state.progressCallback({
                  type: 'planning_failed',
                  message: state.answer,
                  error: state.planError,
                  source: 'planSkills'
                });
              } catch (err) {
                logger.warn('[StateGraph:Router] Failed to emit planning_failed progress event:', err.message);
              }
            }
          }
          return 'logConversation';
        }
        return 'executeCommand';
      },

      // executeCommand cycle: next step, recover on failure, or done
      executeCommand: (state) => {
        // Thin recovery handler already ran inline in executeCommand and set recoveryAction.
        // Route based on recoveryAction instead of going through recoverSkill node.
        if (state.recoveryAction === 'auto_patch') {
          logger.debug('[StateGraph:Router] executeCommand: auto_patch → retry executeCommand');
          return 'executeCommand';
        }
        if (state.recoveryAction === 'replan' || state.recoveryAction === 'replan_step') {
          logger.debug(`[StateGraph:Router] executeCommand: ${state.recoveryAction} → evaluateSkills (failure judge) → planSkills`);
          return 'evaluateSkills';
        }
        if (state.recoveryAction === 'ask_user') {
          logger.debug('[StateGraph:Router] executeCommand: ask_user → logConversation');
          return 'logConversation';
        }
        // Fallback: failedStep set without recoveryAction (e.g. smartFill, project.builder)
        // Route to evaluateSkills for default recovery/replan
        if (state.failedStep) {
          logger.warn(`[StateGraph:Router] executeCommand: failedStep without recoveryAction → evaluateSkills (fallback)`);
          state.recoveryAction = 'replan';
          state.recoveryContext = { failedSkill: state.failedStep.skill, failureReason: state.failedStep.error };
          return 'evaluateSkills';
        }
        // Scout card is waiting for user provider selection — stop looping, surface ASK_USER
        if (state.scoutPending || state.pendingQuestion?._isScoutSelect || state.pendingQuestion?._isAgentAskUser) {
          return 'logConversation';
        }
        // Plan ordering error — route to evaluateSkills for replan
        if (state.planError) {
          logger.warn(`[StateGraph:Router] executeCommand planError → evaluateSkills: ${state.planError}`);
          return 'evaluateSkills';
        }
        // More steps remaining — loop back
        if (Array.isArray(state.skillPlan) && state.skillCursor < state.skillPlan.length) {
          return 'executeCommand';
        }
        // All steps done — review outcomes before quality evaluation
        if (state.commandExecuted || state.answer) {
          return 'reviewExecution';
        }
        return 'reviewExecution';
      },

      // reviewExecution: FAILED → evaluateSkills (hollow result replan), ASK_USER → surface to user, CORRECTED → done with corrected answer, else → evaluateSkills
      reviewExecution: (state) => {
        const verdict = state.reviewVerdict;
        if (verdict === 'FAILED') {
          logger.info(`[StateGraph:Router] reviewExecution FAILED → evaluateSkills (hollow result — attempt REPLAN)`);
          state.recoveryAction = 'replan';
          state.recoveryContext = { failureReason: 'Hollow result — review judged execution as FAILED' };
          return 'evaluateSkills';
        }
        if (verdict === 'ASK_USER') {
          logger.info('[StateGraph:Router] reviewExecution ASK_USER → logConversation');
          return 'logConversation';
        }
        if (verdict === 'CORRECTED') {
          logger.info('[StateGraph:Router] reviewExecution CORRECTED → logConversation (answer corrected from page text, no replan)');
          return 'logConversation';
        }
        // UNVERIFIABLE or VERIFIED — proceed to content quality evaluation
        return 'evaluateSkills';
      },

      // evaluateSkills: PASS/ASK_USER → done, FIX → replan with stored context rule
      // Special case: failure-path PASS (no rule derived) still routes to planSkills
      // because recoveryContext from recoverSkill is still set for the replan.
      evaluateSkills: (state) => {
        const verdict = state.evaluationVerdict;
        if (verdict === 'FIX' && state.evaluationFix) {
          // CRITICAL FIX: Preserve singleStepReplan context when routing to planSkills
          // This prevents full replan when only one step failed
          if (state.recoveryAction === 'replan_step') {
            logger.info(`[StateGraph:Router] evaluateSkills FIX → planSkills (single-step replan, retry ${state.evaluationRetryCount})`);
            // Preserve singleStepReplan flag in state for planSkillsV2 to detect
            state.singleStepReplan = true;
          } else {
            logger.info(`[StateGraph:Router] evaluateSkills FIX → planSkills (full replan, retry ${state.evaluationRetryCount})`);
          }
          return 'planSkills';
        }
        // recoverSkill set recoveryAction='replan' or 'replan_step' — evaluateSkills was inserted in that path.
        // If no FIX rule was derived (PASS fallback), still continue to planSkills with recoveryContext.
        if (verdict === 'PASS' && (state.recoveryAction === 'replan' || state.recoveryAction === 'replan_step') && state.recoveryContext) {
          // Also preserve singleStepReplan for PASS path
          if (state.recoveryAction === 'replan_step') {
            logger.debug(`[StateGraph:Router] evaluateSkills PASS (failure path) → planSkills with recoveryContext (single-step replan)`);
            state.singleStepReplan = true;
          } else {
            logger.debug(`[StateGraph:Router] evaluateSkills PASS (failure path) → planSkills with recoveryContext (full replan)`);
          }
          return 'planSkills';
        }
        return 'logConversation';
      },

      
      // Screen intelligence path
      screenIntelligence: (state) => {
        // If already has answer (from vision API), log and end
        if (state.answer && !state._needsFreshScreen) {
          return 'logConversation';
        }

        // ── Lazy screen grab cycle: fresh context captured, route to original intent ──
        if (state._needsFreshScreen && state.context) {
          logger.info(`[StateGraph:Router] _needsFreshScreen — fresh context captured, routing based on postIntent: ${state._postScreenIntent}`);

          // Inject fresh capture into _priorScreenContext shape so downstream nodes see it
          state._priorScreenContext = {
            timestamp:   new Date().toISOString(),
            appName:     state.screenContext?.appName     || null,
            windowTitle: state.screenContext?.windowTitle || null,
            url:         state.screenContext?.url         || null,
            contextText: state.context,
          };
          state._taskClassification = {
            ...(state._taskClassification || {}),
            isScreenFollowUp: true,
            followUpTarget: state.screenContext?.windowTitle || state.screenContext?.appName || null,
          };

          // Clear flags so multi-intent queue steps don't re-trigger
          state._needsFreshScreen = false;
          const postIntent = state._postScreenIntent || 'general_knowledge';
          state._postScreenIntent = null;

          // command_automate / scheduling: enrich resolvedMessage, proceed through automation path
          if (postIntent === 'command_automate' || postIntent === 'scheduling') {
            const subject = state.screenContext?.windowTitle || state.screenContext?.appName || '';
            if (subject && state.resolvedMessage) {
              state.resolvedMessage = `[Screen context: ${subject}] ${state.resolvedMessage}`;
              logger.info(`[StateGraph:Router] _needsFreshScreen — enriched resolvedMessage for ${postIntent}`);
            }
            return 'resolveUserContext';
          }

          // memory intents: subject injected via _priorScreenContext, route normally
          if (postIntent === 'memory_retrieve') return 'retrieveMemory';
          if (postIntent === 'memory_store') return 'storeMemory';

          // web_search: subject prepended by webSearch.js via _priorScreenContext
          if (postIntent === 'web_search') return 'webSearch';

          // query / general_knowledge / ambiguous / greeting → answer with injected context
          return 'answer';
        }

        // Otherwise, process with LLM
        return 'answer';
      },
      
      // Web search path
      webSearch: 'retrieveMemory',
      
      // parseProject: matched → command_automate → planSkills; no match → appControl
      parseProject: (state) => {
        if (state.projectSkillPlan && state.projectSkillPlan.length > 0) {
          logger.debug(`[StateGraph:Router] parseProject matched — routing to planSkills`);
          return 'planSkills';
        }
        logger.debug('[StateGraph:Router] parseProject no match — routing to appControl');
        return 'appControl';
      },

      // Plan executor — after building skillPlan[], route directly to planSkills (passthrough)
      planExecutor: 'planSkills',

      // App control mode — routes to logConversation to persist state + show answer
      appControl: 'logConversation',

      // Standard path: all roads lead to logConversation before end
      retrieveMemory: 'answer',
      answer: 'logConversation',
      synthesize: 'logConversation',
      summarizeMultiIntent: 'logConversation',
      // Multi-intent queue runner.
      // Each time logConversation completes for a step, this conditional checks whether
      // more steps remain in intentQueue and loops back through enrichIntent.
      // Once the queue is empty and isMultiIntent=true it routes to summarizeMultiIntent.
      // summarizeMultiIntent sets isMultiIntent=false so the final logConversation exits here.
      logConversation: async (state) => {
        // ── Single-intent ask_user pause (end-of-pipeline) ────────────────────
        // If a single-intent run escalated to ASK_USER, surface the question card
        // here before exiting to end. Otherwise the user gets a silent spinner.
        if (!state.isMultiIntent && state.recoveryAction === 'ask_user' && state.pendingQuestion) {
          logger.info('[StateGraph:Router] Single-intent ask_user pause — surfacing question');
          if (typeof state.progressCallback === 'function') {
            try {
              const _pqOpts = state.pendingQuestion.options || [];
              state.progressCallback({
                type:    'ask_user',
                question: state.pendingQuestion.question,
                options:  _pqOpts,
                stepIndex: state.pendingQuestion.stepIndex,
                agentId: state.pendingQuestion.agentId || null,
                source:  'single_intent_pause',
                // Forward ALL pendingQuestion fields so the renderer can show
                // PartialFailureCard for agent failures (not just the generic banner).
                _isAgentAskUser: state.pendingQuestion._isAgentAskUser === true,
                partialProgress: state.pendingQuestion.partialProgress || null,
                currentUrl: state.pendingQuestion.currentUrl || null,
                keepSession: state.pendingQuestion.keepSession === true,
                originalTask: state.pendingQuestion.originalTask || null,
                skill: state.pendingQuestion.skill || null,
                freeText: true,
              });
            } catch (_) {}
          }
          return 'end';
        }

        // ── Multi-intent ask_user pause (mid-pipeline) ─────────────────────────
        // If the current step ended with recoveryAction='ask_user' and there are
        // still steps in the queue, pause and surface the question. When the user
        // answers, the graph resumes with the pipeline state intact.
        if (state.isMultiIntent && state.recoveryAction === 'ask_user' && state.pendingQuestion) {
          logger.info('[StateGraph:Router] Multi-intent ask_user pause (mid-pipeline) — surfacing question');
          if (typeof state.progressCallback === 'function') {
            try {
              const _mqOpts = state.pendingQuestion.options || [];
              state.progressCallback({
                type:    'ask_user',
                question: state.pendingQuestion.question,
                options:  _mqOpts,
                stepIndex: state.pendingQuestion.stepIndex,
                agentId: state.pendingQuestion.agentId || null,
                source:  'multi_intent_pause',
                _isAgentAskUser: state.pendingQuestion._isAgentAskUser === true,
                partialProgress: state.pendingQuestion.partialProgress || null,
                currentUrl: state.pendingQuestion.currentUrl || null,
                keepSession: state.pendingQuestion.keepSession === true,
                originalTask: state.pendingQuestion.originalTask || null,
                skill: state.pendingQuestion.skill || null,
                freeText: true,
              });
            } catch (_) {}
          }
          return 'end';
        }

        // ── More steps remain — execute next sub-intent ──────────────────────
        if (state.isMultiIntent && Array.isArray(state.intentQueue) && state.intentQueue.length > 0) {

          // 1. Collect this step's result
          const completedStep = {
            step:      state.intentResults?.length ?? 0,
            intent:    state.intent?.type,
            subPrompt: state.intent?.subPrompt || state.message,
            result:    extractStepResult(state),
          };

          state.intentResults = [...(state.intentResults || []), completedStep];
          state.dataContext   = { ...(state.dataContext || {}), [completedStep.step]: completedStep.result };

          // Emit step-done progress event
          if (typeof state.progressCallback === 'function') {
            try {
              state.progressCallback({
                type:      'intent:pipeline_step',
                step:      completedStep.step + 1,
                total:     completedStep.step + 1 + state.intentQueue.length + 1,
                intent:    completedStep.intent,
                subPrompt: completedStep.subPrompt,
                result:    (completedStep.result || '').slice(0, 100),
                status:    'done',
              });
            } catch (_) { /* progress callback must never block execution */ }
          }

          // 2. Pop next step
          const [nextStep, ...remaining] = state.intentQueue;

          // 3. Resolve {{result[N]}} placeholders in the sub-prompt text
          // dataContext[N] may be a plain string or { summary, file } object — use summary for text substitution
          let resolvedText = nextStep.text;
          for (const depIdx of (nextStep.dependsOn || [])) {
            const dep = state.dataContext[depIdx];
            const depResult = (dep && typeof dep === 'object') ? (dep.summary || '') : (dep || '');
            resolvedText = resolvedText.replace(
              new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
              depResult
            );
          }

          // 4. Resolve dataTemplate into _dataPrefix
          let dataPrefix = null;
          if (nextStep.dataTemplate) {
            dataPrefix = nextStep.dataTemplate;
            for (const depIdx of (nextStep.dependsOn || [])) {
              const dep = state.dataContext[depIdx];
              const depResult = (dep && typeof dep === 'object') ? (dep.summary || '') : (dep || '');
              dataPrefix = dataPrefix.replace(
                new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
                depResult
              );
            }
          }

          // Fallback: If no dataTemplate but has dependencies, auto-inject as prefix
          if (!dataPrefix && (nextStep.dependsOn || []).length > 0) {
            const depResults = (nextStep.dependsOn || []).map(depIdx => {
              const dep = state.dataContext[depIdx];
              return (dep && typeof dep === 'object') ? (dep.summary || '') : (dep || '');
            }).filter(Boolean);
            if (depResults.length > 0) {
              dataPrefix = `Context from previous step:\n${depResults.join('\n')}\n\n`;
            }
          }

          // Resolve _dataFile: carry the full-content buffer file from dependent steps (if any)
          let dataFile = null;
          for (const depIdx of (nextStep.dependsOn || [])) {
            const dep = state.dataContext[depIdx];
            if (dep && typeof dep === 'object' && dep.file) { dataFile = dep.file; break; }
          }

          // 5. Phase 3: Long-running async dispatch
          if (nextStep.isLongRunning) {
            const taskRunner = require('./nodes/taskRunner');
            const { randomUUID } = require('crypto');
            const taskId = (typeof randomUUID === 'function') ? randomUUID() : 'task_' + Date.now();

            // Parse completion signal from dataTemplate if present
            // e.g. dataTemplate: "waitForContent: Game build complete"
            let completionSignal = 'waitForContent';
            let completionArg    = 'complete';
            if (nextStep.dataTemplate) {
              const m = nextStep.dataTemplate.match(/^waitFor(Content|Selector):\s*(.+)$/i);
              if (m) {
                completionSignal = 'waitFor' + m[1];
                completionArg    = m[2].trim();
              }
            }

            await taskRunner.dispatch({
              taskId,
              subPrompt:        nextStep.text,
              intent:           nextStep.intent,
              stepOrder:        nextStep.order,
              completionSignal,
              completionArg,
              planContext: {
                intentResults: state.intentResults || [],
                dataContext:   state.dataContext   || {},
                intentQueue:   remaining,
              },
              originalPrompt:   state.originalPrompt || state.message,
              sessionId:        (state.context && state.context.sessionId) || state.sessionId || null,
              onComplete: async (tid, result) => {
                logger.info(`[StateGraph:LongTask] Task ${tid} done — result ready for queue resume`);
                if (typeof state.progressCallback === 'function') {
                  state.progressCallback({
                    type:      'long_task_resume',
                    taskId:    tid,
                    stepOrder: nextStep.order,
                    result:    result ? result.slice(0, 500) : '',
                  });
                }
              },
              onTimeout: async (tid, pendingSteps, reason) => {
                logger.warn(`[StateGraph:LongTask] Task ${tid} timed out — surfacing ASK_USER`);
                state.answer              = `The task "${nextStep.text.slice(0, 80)}" didn't complete — ${reason}. Would you like to retry, skip this step, or cancel?`;
                state.askUserReason       = reason;
                state.pendingStepsAfterTimeout = pendingSteps;
                if (typeof state.progressCallback === 'function') {
                  state.progressCallback({
                    type:         'ask_user',
                    question:     state.answer,
                    options:      ['Retry', 'Skip this step', 'Cancel all'],
                    taskId:       tid,
                    pendingSteps: pendingSteps.length,
                  });
                }
              },
              progressCallback: state.progressCallback || null,
              logger,
            });

            // Update state — mark queue consumed up to this dispatched step
            state.intentQueue  = remaining;
            state._longTaskId  = taskId;
            logger.info(`[StateGraph:LongTask] Async task ${taskId} dispatched — holding in logConversation`);
            // Hold here: graph stays alive; taskRunner fires completion async via IPC
            return 'logConversation';
          }

          logger.info(`[StateGraph:IntentQueue] Step ${completedStep.step + 1} done → executing step ${completedStep.step + 2}/${completedStep.step + 2 + remaining.length}: ${nextStep.intent} — "${resolvedText.slice(0, 60)}"`);

          // Emit step-starting progress event
          if (typeof state.progressCallback === 'function') {
            try {
              state.progressCallback({
                type:      'intent:pipeline_step',
                step:      completedStep.step + 2,
                total:     completedStep.step + 2 + remaining.length,
                intent:    nextStep.intent,
                subPrompt: nextStep.text,
                status:    'running',
              });
            } catch (_) { /* progress callback must never block execution */ }
          }

          // 6. Reset state for next step — clear previous step output to prevent bleed
          Object.assign(state, {
            message:          resolvedText,
            resolvedMessage:  resolvedText,
            _dataPrefix:      dataPrefix,
            _dataFile:        dataFile,
            intent: {
              type:       nextStep.intent,
              confidence: nextStep.confidence,
              subPrompt:  nextStep.text,
              entities:   [],
            },
            intentQueue:       remaining,
            conversationLogged: false,
            // Clear previous step's output so it doesn't bleed into this step
            answer:            null,
            filteredMemories:  [],
            contextDocs:       [],
            searchResults:     [],
            skillResults:      [],
            skillPlan:         null,
            skillCursor:       0,
            commandExecuted:   false,
            commandOutput:     null,
            executionResult:   null,
            failedStep:        null,
            recoveryAction:    null,
            carriedIntent:     null,
            enrichmentNeeded:  [],
            matchedSkillName:  null,
          });

          return 'enrichIntent';
        }

        // ── Queue exhausted — collect final step and summarize ────────────────
        if (state.isMultiIntent && Array.isArray(state.intentResults) && state.intentResults.length > 0) {
          const finalStep = {
            step:      state.intentResults.length,
            intent:    state.intent?.type,
            subPrompt: state.intent?.subPrompt || state.message,
            result:    extractStepResult(state),
          };
          state.intentResults = [...state.intentResults, finalStep];
          state.dataContext   = { ...state.dataContext, [finalStep.step]: finalStep.result };
          return 'summarizeMultiIntent';
        }

        // ── Single-intent path — normal exit ─────────────────────────────────
        return 'end';
      },
    };
    
    return new StateGraph(nodes, edges, {
      logger,
      mcpAdapter,
      debug: options.debug || false
    });
  }

  /**
   * Create a custom graph with user-provided nodes and edges
   * 
   * @param {Object} nodes - Node implementations
   * @param {Object} edges - Edge routing
   * @param {Object} options - Configuration options
   * @returns {StateGraph} Configured graph
   */
  static custom(nodes, edges, options = {}) {
    const logger = options.logger || console;
    const mcpAdapter = options.mcpAdapter;
    const llmBackend = options.llmBackend || null;
    
    logger.debug('[StateGraphBuilder] Creating CUSTOM graph');
    
    // Inject logger, mcpAdapter, and llmBackend into all nodes
    const wrappedNodes = {};
    for (const [name, fn] of Object.entries(nodes)) {
      wrappedNodes[name] = (state) => fn({ ...state, logger, mcpAdapter, llmBackend });
    }
    
    return new StateGraph(wrappedNodes, edges, {
      logger,
      mcpAdapter,
      debug: options.debug || false
    });
  }
}

module.exports = StateGraphBuilder;

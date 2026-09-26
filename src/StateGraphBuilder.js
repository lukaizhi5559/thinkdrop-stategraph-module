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
const clarifyNode = require('./nodes/clarify');
const advanceQueueNode = require('./nodes/advanceQueue');
const preparePostScreenNode = require('./nodes/preparePostScreen');
const prepareReplanNode = require('./nodes/prepareReplan');
const flagHollowFailureNode = require('./nodes/flagHollowFailure');
const flagStepFailureNode = require('./nodes/flagStepFailure');
const surfacePlanFailureNode = require('./nodes/surfacePlanFailure');
const routeIntentNode = require('./nodes/routeIntent');
const extractStepResult = require('./utils/extractStepResult');
const executeIntrospectNode = require('./nodes/executeIntrospect');
const executeSettingsNode = require('./nodes/executeSettings');
const createSkillFromHistoryNode = require('./nodes/createSkillFromHistory');
const planExecutorNode = require('./nodes/planExecutor');
const preflightAgentsNode = require('./nodes/preflightAgents');
const resolveAgentNode = require('./nodes/resolveAgent');
const screenOutputNode = require('./nodes/screenOutput');

// assessRisk and detectOperationType removed — grill-mode pipeline deleted

// extractStepResult lives in ./utils/extractStepResult — shared with the
// advanceQueue node (the queue runner extracted from the logConversation edge).

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
      clarify: (state) => clarifyNode({ ...state, logger, mcpAdapter, llmBackend }),
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
      advanceQueue: (state) => advanceQueueNode({ ...state, logger, mcpAdapter, llmBackend }),
      preparePostScreen: (state) => preparePostScreenNode({ ...state, logger, mcpAdapter }),
      prepareReplan: (state) => prepareReplanNode({ ...state, logger }),
      flagHollowFailure: (state) => flagHollowFailureNode({ ...state, logger }),
      flagStepFailure: (state) => flagStepFailureNode({ ...state, logger }),
      surfacePlanFailure: (state) => surfacePlanFailureNode({ ...state, logger }),
      routeIntent: (state) => routeIntentNode({ ...state, logger }),
      screenOutput: (state) => screenOutputNode({ ...state, logger }),
    };
    
    // Intent-based routing (matches DistilBERT classifier intents)
    const edges = {
      // Resume fast-path: an approved/stored plan re-enters with _planFile —
      // go straight to planExecutor instead of re-running the full
      // classify/decompose/agent/plan chain (which burned ~15–30s per resume
      // on dead-endpoint enrich calls and repeat LLM passes).
      start: (state) => state._planFile ? 'planExecutor' : 'resolveReferences',
      // clarify is the pre-routing resolution gate: needs_clarification → ask
      // the user (grill batch) + re-classify once; resolved/declined_ack pass.
      resolveReferences: 'clarify',
      clarify: 'decomposePrompt',
      decomposePrompt: 'parseIntent',
      parseIntent: (state) => {
        // declined_ack — user refused a card/offer. The decompose guard emitted
        // a general_knowledge step; route straight to answer. No plan cache,
        // skill parse, search, or execution — the offered action never runs.
        if (state._taskClassification?.resolution === 'declined_ack') {
          logger.info('[StateGraph:Router] declined_ack — routing to answer (acknowledgement only)');
          return 'answer';
        }
        return 'checkPlanCache';
      },
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

      // enrichIntent → routeIntent: all post-enrichment routing decisions
      // (screen follow-up injection, lazy grab, resume fast-paths, intent map)
      // live in the routeIntent node. This edge is pure.
      enrichIntent: 'routeIntent',
      routeIntent: (state) => state._advanceRoute || 'retrieveMemory',

      // Introspection path: executeIntrospect → answer → logConversation
      executeIntrospect: 'answer',

      // Settings path: executeSettings → answer → logConversation
      executeSettings: 'answer',

      // Screen-output path: screenOutput → answer → logConversation
      // (the GhostLayer display itself is fire-and-forget — the answer node
      // shows the brief ack in the overlay)
      screenOutput: 'answer',

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
      resolveAgent: (state) => {
        // Provider outage — resolveAgent produced a clean reply; skip planning
        if (state.providerOutage) {
          logger.info('[StateGraph:Router] resolveAgent: providerOutage — exiting to logConversation');
          return 'logConversation';
        }
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
          logger.debug(`[StateGraph:Router] planSkills failed: ${state.planError} → surfacePlanFailure`);
          return 'surfacePlanFailure';
        }
        return 'executeCommand';
      },
      // Provider outage → answer + progress event, then logConversation
      surfacePlanFailure: 'logConversation',

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
        // flagStepFailure builds recoveryContext, then → evaluateSkills
        if (state.failedStep) {
          logger.warn(`[StateGraph:Router] executeCommand: failedStep without recoveryAction → flagStepFailure (fallback)`);
          return 'flagStepFailure';
        }
        // Any pendingQuestion means "pause for user input" — scout-select,
        // agent ask_user, or a bare question from an ask_user/guard step.
        // Without this, the loop continues and later steps run with unresolved
        // {{_ctx_*}} tokens (the literal token reached Chrome as a URL once).
        if (state.scoutPending || state.pendingQuestion) {
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
          // Hollow result — flagHollowFailure sets recoveryAction/Context, then → evaluateSkills
          logger.info(`[StateGraph:Router] reviewExecution FAILED → flagHollowFailure (hollow result — attempt REPLAN)`);
          return 'flagHollowFailure';
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
          // Replan needed — prepareReplan sets singleStepReplan (edge stays pure)
          logger.info(`[StateGraph:Router] evaluateSkills FIX → prepareReplan (${state.recoveryAction === 'replan_step' ? 'single-step' : 'full'}, retry ${state.evaluationRetryCount})`);
          return 'prepareReplan';
        }
        // recoverSkill set recoveryAction='replan' or 'replan_step' — evaluateSkills was inserted in that path.
        // If no FIX rule was derived (PASS fallback), still continue to planSkills with recoveryContext.
        if (verdict === 'PASS' && (state.recoveryAction === 'replan' || state.recoveryAction === 'replan_step') && state.recoveryContext) {
          logger.debug(`[StateGraph:Router] evaluateSkills PASS (failure path) → prepareReplan (${state.recoveryAction === 'replan_step' ? 'single-step' : 'full'})`);
          return 'prepareReplan';
        }
        return 'logConversation';
      },

      
      // Screen intelligence path — pure edge. The lazy screen-grab prep
      // (state injection + postIntent routing decision) lives in the
      // preparePostScreen node.
      screenIntelligence: (state) => {
        // If already has answer (from vision API), log and end
        if (state.answer && !state._needsFreshScreen) {
          return 'logConversation';
        }
        // Lazy screen grab cycle: fresh context captured → prepare handoff
        if (state._needsFreshScreen && state.context) {
          return 'preparePostScreen';
        }
        // Otherwise, process with LLM
        return 'answer';
      },
      preparePostScreen: (state) => state._advanceRoute || 'answer',
      // Replan prep — sets singleStepReplan before planSkills (pure edge below)
      prepareReplan: 'planSkills',
      flagHollowFailure: 'evaluateSkills',
      flagStepFailure: 'evaluateSkills',
      
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
      // Multi-intent queue runner lives in the advanceQueue node — this edge
      // is a pure read of the route it computes (_advanceRoute).
      // Each time logConversation completes for a step, advanceQueue checks
      // whether more steps remain in intentQueue and routes back through
      // enrichIntent. Once the queue is empty it routes to summarizeMultiIntent.
      logConversation: 'advanceQueue',
      advanceQueue: (state) => state._advanceRoute || 'end',
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

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
const parseIntentNode = require('./nodes/parseIntent');
const answerNode = require('./nodes/answer');
const retrieveMemoryNode = require('./nodes/retrieveMemory');
const storeMemoryNode = require('./nodes/storeMemory');
const webSearchNode = require('./nodes/webSearch');
const executeCommandNode = require('./nodes/executeCommand');
const planSkillsNode = require('./nodes/planSkills');
const recoverSkillNode = require('./nodes/recoverSkill');
const screenIntelligenceNode = require('./nodes/screenIntelligence');
const logConversationNode = require('./nodes/logConversation');
const resolveReferencesNode = require('./nodes/resolveReferences');
const parseSkillNode = require('./nodes/parseSkill');
const synthesizeNode = require('./nodes/synthesize');
const enrichIntentNode = require('./nodes/enrichIntent');
const evaluateSkillsNode = require('./nodes/evaluateSkills');
const creatorPlanningNode = require('./nodes/creatorPlanning');
const gatherContextNode = require('./nodes/gatherContext');

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
      logConversation: (state) => logConversationNode({ ...state, logger, mcpAdapter })
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
      resolveReferences: (state) => resolveReferencesNode({ ...state, logger, mcpAdapter }),
      parseSkill: (state) => parseSkillNode({ ...state, logger, mcpAdapter, llmBackend }),
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      enrichIntent: (state) => enrichIntentNode({ ...state, logger, mcpAdapter }),
      retrieveMemory: (state) => retrieveMemoryNode({ ...state, logger, mcpAdapter }),
      storeMemory: (state) => storeMemoryNode({ ...state, logger, mcpAdapter }),
      webSearch: (state) => webSearchNode({ ...state, logger, mcpAdapter }),
      gatherContext: (state) => gatherContextNode({ ...state, logger, mcpAdapter, llmBackend }),
      creatorPlanning: (state) => creatorPlanningNode({ ...state, logger, mcpAdapter }),
      planSkills: (state) => planSkillsNode({ ...state, logger, mcpAdapter, llmBackend }),
      executeCommand: (state) => executeCommandNode({ ...state, logger, mcpAdapter, llmBackend }),
      recoverSkill: (state) => recoverSkillNode({ ...state, logger, mcpAdapter, llmBackend }),
      evaluateSkills: (state) => evaluateSkillsNode({ ...state, logger, mcpAdapter, llmBackend }),
      screenIntelligence: (state) => screenIntelligenceNode({ ...state, logger, mcpAdapter }),
      synthesize: (state) => synthesizeNode({ ...state, logger, mcpAdapter, llmBackend }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter, llmBackend }),
      logConversation: (state) => logConversationNode({ ...state, logger, mcpAdapter })
    };
    
    // Intent-based routing (matches DistilBERT classifier intents)
    const edges = {
      start: 'resolveReferences',
      resolveReferences: 'parseSkill',
      parseSkill: (state) => {
        // If parseSkill matched an installed skill, skip parseIntent entirely
        if (state.matchedSkillName) {
          logger.debug(`[StateGraph:Router] parseSkill matched "${state.matchedSkillName}" — skipping to enrichIntent`);
          return 'enrichIntent';
        }
        return 'parseIntent';
      },
      parseIntent: 'enrichIntent',

      // enrichIntent router: handles MODE B re-routing + MODE A gap/resolve routing
      enrichIntent: (state) => {
        const intentType = state.intent?.type || 'general_query';
        logger.debug(`[StateGraph:Router] enrichIntent exit — intent: ${intentType}`);

        // Enrichment gaps remain — ask user first (surface the question via logConversation)
        if (Array.isArray(state.enrichmentNeeded) && state.enrichmentNeeded.length > 0) {
          logger.debug('[StateGraph:Router] enrichIntent: gaps unresolved — asking user');
          return 'logConversation';
        }

        // MODE B re-route: enrichIntent stored answers and set intent=command_automate
        // or MODE A success: command_automate with profile complete — proceed to plan
        if (intentType === 'command_automate') {
          // Skill already installed (parseSkill matched) — skip gatherContext + creatorPlanning,
          // go straight to planSkills which will emit external.skill as the only step.
          if (state.matchedSkillName) {
            logger.debug(`[StateGraph:Router] enrichIntent: matchedSkillName="${state.matchedSkillName}" — skipping to planSkills`);
            return 'planSkills';
          }
          logger.debug('[StateGraph:Router] enrichIntent: command_automate, no skill match — gatherContext');
          return 'gatherContext';
        }

        // All other intents: route the same as parseIntent used to
        if (intentType === 'memory_store') {
          return 'storeMemory';
        }
        if (intentType === 'memory_retrieve') {
          return 'retrieveMemory';
        }
        if (intentType === 'command_execute' || intentType === 'command_guide') {
          return 'executeCommand';
        }
        if (intentType === 'screen_intelligence') {
          return 'screenIntelligence';
        }
        if (intentType === 'web_search' || intentType === 'question' || intentType === 'general_knowledge') {
          return 'webSearch';
        }
        if (intentType === 'greeting') {
          return 'answer';
        }
        return 'retrieveMemory';
      },

      // Memory store path: store → logConversation → end
      storeMemory: 'logConversation',
      
      // gatherContext → creatorPlanning (always, gather is non-blocking if skipped)
      gatherContext: (state) => {
        return 'creatorPlanning';
      },

      // creatorPlanning → planSkills (pass/warnings) or logConversation (reviewer fail)
      creatorPlanning: (state) => {
        if (state.planError) {
          logger.debug(`[StateGraph:Router] creatorPlanning reviewer blocked: ${state.planError}`);
          return 'logConversation';
        }
        return 'planSkills';
      },

      // planSkills → executeCommand (plan ready) or logConversation (plan error)
      planSkills: (state) => {
        if (state.planError && !state.skillPlan) {
          logger.debug(`[StateGraph:Router] planSkills failed: ${state.planError}`);
          return 'logConversation';
        }
        return 'executeCommand';
      },

      // executeCommand cycle: next step, recover on failure, or done
      executeCommand: (state) => {
        // Step failed — route to recovery
        if (state.failedStep) {
          return 'recoverSkill';
        }
        // More steps remaining — loop back
        if (Array.isArray(state.skillPlan) && state.skillCursor < state.skillPlan.length) {
          return 'executeCommand';
        }
        // All steps done — evaluate result quality before logging
        if (state.commandExecuted || state.answer) {
          return 'evaluateSkills';
        }
        return 'evaluateSkills';
      },

      // evaluateSkills: PASS/ASK_USER → done, FIX → replan with stored context rule
      // Special case: failure-path PASS (no rule derived) still routes to planSkills
      // because recoveryContext from recoverSkill is still set for the replan.
      evaluateSkills: (state) => {
        const verdict = state.evaluationVerdict;
        if (verdict === 'FIX' && state.evaluationFix) {
          logger.info(`[StateGraph:Router] evaluateSkills FIX → planSkills (retry ${state.evaluationRetryCount})`);
          return 'planSkills';
        }
        // recoverSkill set recoveryAction='replan' — evaluateSkills was inserted in that path.
        // If no FIX rule was derived (PASS fallback), still continue to planSkills with recoveryContext.
        if (verdict === 'PASS' && state.recoveryAction === 'replan' && state.recoveryContext) {
          logger.debug('[StateGraph:Router] evaluateSkills PASS (failure path) → planSkills with recoveryContext');
          return 'planSkills';
        }
        return 'logConversation';
      },

      // recoverSkill → retry step, replan (via evaluateSkills for FIX rule), or surface question to user
      recoverSkill: (state) => {
        const action = state.recoveryAction;
        if (action === 'auto_patch') {
          logger.debug('[StateGraph:Router] Recovery: auto_patch → retry executeCommand');
          return 'executeCommand';
        }
        if (action === 'replan') {
          // Route through evaluateSkills so it can judge the failure and save a context rule.
          // evaluateSkills detects evaluationFromFailure=true and uses the failure-path prompt.
          // From there: FIX → planSkills (with saved rule), PASS → planSkills, ASK_USER → logConversation.
          logger.debug('[StateGraph:Router] Recovery: replan → evaluateSkills (failure judge) → planSkills');
          return 'evaluateSkills';
        }
        // ask_user: state.answer is already set with the question
        logger.debug('[StateGraph:Router] Recovery: ask_user → logConversation');
        return 'logConversation';
      },
      
      // Screen intelligence path
      screenIntelligence: (state) => {
        // If already has answer (from vision API), log and end
        if (state.answer) {
          return 'logConversation';
        }
        // Otherwise, process with LLM
        return 'answer';
      },
      
      // Web search path
      webSearch: 'retrieveMemory',
      
      // Standard path: all roads lead to logConversation before end
      retrieveMemory: 'answer',
      answer: 'logConversation',
      synthesize: 'logConversation',
      logConversation: 'end'
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

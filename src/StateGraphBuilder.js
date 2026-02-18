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
    
    logger.debug('[StateGraphBuilder] Creating MINIMAL graph (intent classification only)');
    
    // Minimal nodes: just parseIntent → answer
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter })
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
    
    logger.debug('[StateGraphBuilder] Creating BASIC graph (intent + mock responses)');
    
    // Basic nodes: parseIntent → answer with mock data
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter })
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
    
    if (!mcpAdapter) {
      throw new Error('[StateGraphBuilder] standard() requires mcpAdapter');
    }
    
    logger.debug('[StateGraphBuilder] Creating STANDARD graph (intent + real LLM)');
    
    // Standard nodes: parseIntent → retrieveMemory → answer
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter }),
      retrieveMemory: (state) => retrieveMemoryNode({ ...state, logger, mcpAdapter }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter })
    };
    
    const edges = {
      start: 'parseIntent',
      parseIntent: 'retrieveMemory',
      retrieveMemory: 'answer',
      answer: 'end'
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
    
    if (!mcpAdapter) {
      throw new Error('[StateGraphBuilder] full() requires mcpAdapter');
    }
    
    logger.debug('[StateGraphBuilder] Creating FULL graph (all nodes enabled)');
    
    // Full nodes with intent-based routing
    const nodes = {
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter }),
      retrieveMemory: (state) => retrieveMemoryNode({ ...state, logger, mcpAdapter }),
      storeMemory: (state) => storeMemoryNode({ ...state, logger, mcpAdapter }),
      webSearch: (state) => webSearchNode({ ...state, logger, mcpAdapter }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter })
    };
    
    // Intent-based routing
    const edges = {
      start: 'parseIntent',
      
      // Router: Route based on intent type
      parseIntent: (state) => {
        const intentType = state.intent?.type || 'general_query';
        logger.debug(`[StateGraph:Router] Intent: ${intentType}`);
        
        // Memory store: save information
        if (intentType === 'memory_store') {
          return 'storeMemory';
        }
        
        // Web search: time-sensitive queries
        if (intentType === 'web_search' || intentType === 'question' || intentType === 'general_knowledge') {
          return 'webSearch';
        }
        
        // Default: retrieve memory and answer
        return 'retrieveMemory';
      },
      
      // Memory store path
      storeMemory: 'end',
      
      // Web search path
      webSearch: 'retrieveMemory',
      
      // Standard path
      retrieveMemory: 'answer',
      answer: 'end'
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
    
    logger.debug('[StateGraphBuilder] Creating CUSTOM graph');
    
    // Inject logger and mcpAdapter into all nodes
    const wrappedNodes = {};
    for (const [name, fn] of Object.entries(nodes)) {
      wrappedNodes[name] = (state) => fn({ ...state, logger, mcpAdapter });
    }
    
    return new StateGraph(wrappedNodes, edges, {
      logger,
      mcpAdapter,
      debug: options.debug || false
    });
  }
}

module.exports = StateGraphBuilder;

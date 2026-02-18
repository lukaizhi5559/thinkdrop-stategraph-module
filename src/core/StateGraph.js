/**
 * StateGraph - Graph-based workflow orchestration
 * 
 * Refactored for standalone use with:
 * - Pluggable logger
 * - Pluggable MCP adapter
 * - Graceful degradation when services unavailable
 * - Full state trace for debugging
 */

class StateGraph {
  constructor(nodes = {}, edges = {}, options = {}) {
    this.nodes = nodes;
    this.edges = edges;
    this.startNode = edges.start || 'start';
    
    // Pluggable dependencies
    this.logger = options.logger || console;
    this.mcpAdapter = options.mcpAdapter || null;
    this.debug = options.debug || false;
    
    // Caching layer (disabled by default)
    this.cache = new Map();
    this.cacheStats = { hits: 0, misses: 0 };
    this.cacheTTL = options.cacheTTL || 300000; // 5 minutes
    this.cacheEnabled = options.cacheEnabled || false;
  }

  /**
   * Execute the graph workflow
   * @param {Object} initialState - Starting state
   * @param {Function} onProgress - Optional callback for progress updates (nodeName, state, duration)
   * @returns {Object} Final state with trace
   */
  async execute(initialState, onProgress = null) {
    const state = {
      ...initialState,
      trace: [],
      startTime: Date.now(),
      currentNode: this.startNode,
      mcpAdapter: this.mcpAdapter // Inject adapter into state for nodes
    };

    let currentNode = this.startNode;
    const visited = new Set();
    const maxIterations = 50; // Prevent infinite loops
    let iterations = 0;

    while (currentNode && currentNode !== 'end' && iterations < maxIterations) {
      iterations++;

      // Check for infinite loops
      const visitKey = `${currentNode}_${iterations}`;
      if (visited.has(visitKey) && iterations > 10) {
        this.logger.warn(`[StateGraph] Possible infinite loop detected at node: ${currentNode}`);
        state.error = `Infinite loop detected at node: ${currentNode}`;
        break;
      }
      visited.add(visitKey);

      // Execute node
      const nodeStartTime = Date.now();
      if (this.debug) {
        this.logger.debug(`[StateGraph] Executing node: ${currentNode}`);
      }

      // Call progress callback before node execution
      if (onProgress && typeof onProgress === 'function') {
        try {
          await onProgress(currentNode, state, 0, 'started');
        } catch (err) {
          this.logger.warn('[StateGraph] Progress callback error:', err.message);
        }
      }

      try {
        const nodeFunction = this.nodes[currentNode];
        if (!nodeFunction) {
          throw new Error(`Node not found: ${currentNode}`);
        }

        // Capture input state for trace
        const inputSnapshot = this._captureStateSnapshot(state);

        // Execute node
        const updatedState = await nodeFunction(state);

        // Capture output state for trace
        const outputSnapshot = this._captureStateSnapshot(updatedState);

        // Record trace
        const duration = Date.now() - nodeStartTime;
        updatedState.trace.push({
          node: currentNode,
          duration,
          timestamp: new Date().toISOString(),
          input: inputSnapshot,
          output: outputSnapshot,
          success: true
        });

        if (this.debug) {
          this.logger.debug(`[StateGraph] Node ${currentNode} completed in ${duration}ms`);
        }

        // Update state
        Object.assign(state, updatedState);

        // Call progress callback after node completion
        if (onProgress && typeof onProgress === 'function') {
          try {
            await onProgress(currentNode, state, duration, 'completed');
          } catch (err) {
            this.logger.warn('[StateGraph] Progress callback error:', err.message);
          }
        }

        // Determine next node
        const nextNode = this._getNextNode(currentNode, state);
        if (this.debug) {
          this.logger.debug(`[StateGraph] Routing: ${currentNode} → ${nextNode}`);
        }

        currentNode = nextNode;

      } catch (error) {
        this.logger.error(`[StateGraph] Node ${currentNode} failed:`, error.message);
        if (this.debug) {
          this.logger.error(`[StateGraph] Error stack:`, error.stack);
        }

        // Record error in trace
        state.trace.push({
          node: currentNode,
          duration: Date.now() - nodeStartTime,
          timestamp: new Date().toISOString(),
          error: error.message,
          stack: error.stack,
          success: false
        });

        state.error = error.message;
        state.failedNode = currentNode;
        break;
      }
    }

    // Finalize state
    state.elapsedMs = Date.now() - state.startTime;
    state.iterations = iterations;
    state.success = !state.error;

    if (this.debug) {
      this.logger.debug(`[StateGraph] Workflow completed in ${state.elapsedMs}ms (${iterations} iterations)`);
    }

    return state;
  }

  /**
   * Get the next node based on edges configuration
   * @param {string} currentNode - Current node name
   * @param {Object} state - Current state
   * @returns {string} Next node name
   */
  _getNextNode(currentNode, state) {
    const edge = this.edges[currentNode];

    // No edge defined = end
    if (!edge) {
      return 'end';
    }

    // Static edge (string)
    if (typeof edge === 'string') {
      return edge;
    }

    // Dynamic edge (function)
    if (typeof edge === 'function') {
      return edge(state);
    }

    // Invalid edge
    this.logger.warn(`[StateGraph] Invalid edge for node ${currentNode}`);
    return 'end';
  }

  /**
   * Execute multiple nodes in parallel
   * @param {Array<string>} nodeNames - Node names to execute
   * @param {Object} state - Current state
   * @param {Function} onProgress - Optional progress callback
   * @returns {Object} Merged state from all nodes
   */
  async executeParallel(nodeNames, state, onProgress = null) {
    if (this.debug) {
      this.logger.debug(`[StateGraph:Parallel] Executing ${nodeNames.length} nodes: ${nodeNames.join(', ')}`);
    }
    
    const promises = nodeNames.map(async (nodeName) => {
      const nodeFunction = this.nodes[nodeName];
      
      if (!nodeFunction) {
        throw new Error(`Node not found: ${nodeName}`);
      }
      
      const nodeStartTime = Date.now();
      
      // Call progress callback before node execution
      if (onProgress && typeof onProgress === 'function') {
        try {
          await onProgress(nodeName, state, 0, 'started');
        } catch (err) {
          this.logger.warn('[StateGraph] Progress callback error:', err.message);
        }
      }
      
      try {
        const inputSnapshot = this._captureStateSnapshot(state);
        const result = await nodeFunction(state);
        const duration = Date.now() - nodeStartTime;
        const outputSnapshot = this._captureStateSnapshot(result);
        
        if (this.debug) {
          this.logger.debug(`[StateGraph:Parallel] Node ${nodeName} completed in ${duration}ms`);
        }
        
        // Call progress callback after completion
        if (onProgress && typeof onProgress === 'function') {
          try {
            await onProgress(nodeName, result, duration, 'completed');
          } catch (err) {
            this.logger.warn('[StateGraph] Progress callback error:', err.message);
          }
        }
        
        return { 
          success: true, 
          nodeName, 
          result, 
          duration,
          trace: {
            node: nodeName,
            duration,
            timestamp: new Date().toISOString(),
            input: inputSnapshot,
            output: outputSnapshot,
            success: true
          }
        };
        
      } catch (error) {
        const duration = Date.now() - nodeStartTime;
        this.logger.error(`[StateGraph:Parallel] Node ${nodeName} failed:`, error.message);
        
        return { 
          success: false, 
          nodeName, 
          error: error.message,
          duration,
          trace: {
            node: nodeName,
            duration,
            timestamp: new Date().toISOString(),
            error: error.message,
            success: false
          }
        };
      }
    });
    
    const results = await Promise.all(promises);
    
    // Merge all results into state
    const mergedState = { ...state };
    const parallelTraces = [];
    
    for (const { success, nodeName, result, error, trace } of results) {
      parallelTraces.push(trace);
      
      if (success) {
        // Merge successful result into state
        Object.assign(mergedState, result);
      } else {
        this.logger.warn(`[StateGraph:Parallel] Skipping failed parallel node: ${nodeName}`);
        mergedState.parallelErrors = mergedState.parallelErrors || [];
        mergedState.parallelErrors.push({ nodeName, error });
      }
    }
    
    // Add all parallel traces to state
    mergedState.trace = mergedState.trace || [];
    mergedState.trace.push(...parallelTraces);
    
    const totalDuration = Math.max(...results.map(r => r.duration));
    if (this.debug) {
      this.logger.debug(`[StateGraph:Parallel] All nodes completed in ${totalDuration}ms`);
    }
    
    return mergedState;
  }

  /**
   * Capture a snapshot of relevant state for tracing
   * @param {Object} state - Current state
   * @returns {Object} State snapshot
   */
  _captureStateSnapshot(state) {
    return {
      intentType: state.intent?.type,
      intentConfidence: state.intent?.confidence,
      memoriesCount: state.memories?.length || 0,
      filteredMemoriesCount: state.filteredMemories?.length || 0,
      contextDocsCount: state.contextDocs?.length || 0,
      hasAnswer: !!state.answer,
      answerLength: state.answer?.length || 0,
      needsRetry: state.needsRetry,
      retryCount: state.retryCount || 0,
      error: state.error
    };
  }

  /**
   * Add a node to the graph
   * @param {string} name - Node name
   * @param {Function} fn - Node function
   */
  addNode(name, fn) {
    this.nodes[name] = fn;
  }

  /**
   * Add an edge to the graph
   * @param {string} from - Source node
   * @param {string|Function} to - Target node or routing function
   */
  addEdge(from, to) {
    this.edges[from] = to;
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    return {
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      size: this.cache.size,
      hitRate: total > 0 ? (this.cacheStats.hits / total * 100).toFixed(2) + '%' : '0%'
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
    if (this.debug) {
      this.logger.debug('[StateGraph] Cache cleared');
    }
  }
}

module.exports = StateGraph;

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
  async execute(initialState, onProgress = null, abortSignal = null) {
    // ── Capturing logger proxy ───────────────────────────────────────────────
    // Wraps the real logger so every info/warn/error line is ALSO appended to
    // state.runLog[]. evaluateSkills reads runLog and sends it to the LLM judge
    // so it can diagnose failures from actual log output — not just skillResults.
    // Max 200 entries (ring buffer) to keep LLM context manageable.
    const RUN_LOG_MAX = 200;
    const runLog = [];
    const baseLogger = this.logger;
    const capturingLogger = {
      debug: (...args) => { baseLogger.debug(...args); },
      info:  (...args) => { baseLogger.info(...args);  if (runLog.length < RUN_LOG_MAX) runLog.push(`[INFO]  ${args.join(' ')}`); },
      warn:  (...args) => { baseLogger.warn(...args);  if (runLog.length < RUN_LOG_MAX) runLog.push(`[WARN]  ${args.join(' ')}`); },
      error: (...args) => { baseLogger.error(...args); if (runLog.length < RUN_LOG_MAX) runLog.push(`[ERROR] ${args.join(' ')}`); },
      log:   (...args) => { baseLogger.log?.(...args); }
    };

    const state = {
      ...initialState,
      trace: [],
      startTime: Date.now(),
      currentNode: this.startNode,
      mcpAdapter: this.mcpAdapter, // Inject adapter into state for nodes
      logger: capturingLogger,     // Override with capturing proxy
      runLog,                      // Shared reference — nodes append via logger, evaluateSkills reads
      // Expose the abort signal so long-running nodes (executeCommand) can
      // thread it into MCP callService options — destroying the in-flight
      // HTTP request when the user cancels, instead of waiting for a timeout.
      abortSignal: abortSignal || null,
    };

    // Start edge may be a function (same contract as conditional edges) —
    // e.g. routing resumed plans (_planFile) straight to planExecutor.
    let currentNode = typeof this.startNode === 'function' ? await this.startNode(state) : this.startNode;
    state.currentNode = currentNode;
    // Per-node visit tracking for real loop detection, keyed on a progress
    // marker rather than raw count: a sequential plan legitimately re-enters
    // executeCommand once per step (observed: a 6-step plan aborted on the
    // 6th entry even though every visit made progress). Only repeated entry
    // with NO state progress counts toward the abort — a genuine cycle
    // (A⇄B with unchanged cursor/results/plan) still trips the limit.
    const visits = new Map(); // node → { count, marker }
    const MAX_NODE_VISITS = 5;
    const _progressMarker = (s) => [
      s.skillCursor, s.skillResults?.length, s.skillPlan?.length,
      s.evaluationRetryCount, s._skillPlanFile,
    ].join(':');
    const maxIterations = 50; // Hard bound — safety net behind loop detection
    let iterations = 0;

    while (currentNode && currentNode !== 'end' && iterations < maxIterations) {
      iterations++;

      // Check abort signal between nodes
      if (abortSignal && abortSignal.aborted) {
        this.logger.info('[StateGraph] Aborted by signal — stopping before node:', currentNode);
        state.error = 'Cancelled by user';
        state.cancelled = true;
        break;
      }

      // Loop detection: a node re-entered more than MAX_NODE_VISITS times
      // *with no progress* means an edge cycle is stuck (e.g. recovery
      // ping-pong). Progress = any change to the plan cursor, results count,
      // plan length, retry count, or installed plan file — sequential steps
      // and fresh replans reset the counter instead of tripping it.
      const marker = _progressMarker(state);
      const rec = visits.get(currentNode);
      const stallCount = (rec && rec.marker === marker) ? rec.count + 1 : 1;
      visits.set(currentNode, { count: stallCount, marker });
      if (stallCount > MAX_NODE_VISITS) {
        this.logger.warn(`[StateGraph] Loop detected: node "${currentNode}" entered ${stallCount} times with no progress — aborting run`);
        state.error = `Loop detected: node "${currentNode}" entered ${stallCount} times with no progress`;
        state.failedNode = currentNode;
        break;
      }

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

        // Record trace. Nodes may return a partial patch (no `trace` field) —
        // fall back to the live state.trace array instead of assuming the
        // node spread `...state` through.
        const duration = Date.now() - nodeStartTime;
        const traceArr = Array.isArray(updatedState.trace) ? updatedState.trace : state.trace;
        traceArr.push({
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

        // Determine next node (edge functions may be async — always await)
        const nextNode = await this._getNextNode(currentNode, state);
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

    // Attach typed output contract — consumed by main.js planStepDispatcher and session routing
    state._contract = {
      sessionId:    state.resolvedSessionId || state.context?.sessionId || null,
      intent:       state.intent?.type || 'unknown',
      answer:       state.answer || null,
      skillResults: (state.skillResults || []).map(r => ({ skill: r.skill, ok: r.ok, stdout: (r.stdout || '').slice(0, 200) })),
      planFile:     state._planFile || null,
      planStepNum:  state._planStepNum || null,
      planComplete: state.planComplete || false,
      elapsedMs:    state.elapsedMs,
      success:      state.success,
      error:        state.error || null,
      ts:           Date.now(),
    };

    return state;
  }

  /**
   * Get the next node based on edges configuration
   * @param {string} currentNode - Current node name
   * @param {Object} state - Current state
   * @returns {string} Next node name
   */
  async _getNextNode(currentNode, state) {
    const edge = this.edges[currentNode];

    // No edge defined = end
    if (!edge) {
      return 'end';
    }

    // Static edge (string)
    if (typeof edge === 'string') {
      return edge;
    }

    // Dynamic edge (function — may be sync or async)
    if (typeof edge === 'function') {
      return await edge(state);
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

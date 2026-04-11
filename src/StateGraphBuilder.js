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
const decomposePromptNode = require('./nodes/decomposePrompt');
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
const reviewExecutionNode = require('./nodes/reviewExecution');
const creatorPlanningNode = require('./nodes/creatorPlanning');
const gatherContextNode = require('./nodes/gatherContext');
const appControlNode = require('./nodes/appControl');
const storeConstraintNode = require('./nodes/storeConstraint');
const liftConstraintNode  = require('./nodes/liftConstraint');
const parseProjectNode = require('./nodes/parseProject');
const summarizeMultiIntentNode = require('./nodes/summarizeMultiIntent');




/**
 * Extract the most useful short result string from a completed intent step.
 * Used to populate state.dataContext[N] for injection into dependent steps.
 */
function extractStepResult(state) {
  const intent = state.intent?.type;

  // memory_retrieve: use first memory's source text
  if (intent === 'memory_retrieve' && Array.isArray(state.filteredMemories) && state.filteredMemories.length > 0) {
    return state.filteredMemories
      .slice(0, 3)
      .map(m => m.source_text || m.extracted_text || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
  }

  // web_search: use top result snippet
  if (intent === 'web_search' && Array.isArray(state.contextDocs) && state.contextDocs.length > 0) {
    return state.contextDocs
      .slice(0, 2)
      .map(d => d.snippet || d.title || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
  }

  // command_automate: use answer or last skill stdout
  if (intent === 'command_automate') {
    if (state.answer) return state.answer.slice(0, 500);
    if (Array.isArray(state.skillResults)) {
      const last = state.skillResults.filter(r => r.ok && r.stdout).pop();
      if (last) return last.stdout.slice(0, 500);
    }
  }

  // memory_store: confirm text
  if (intent === 'memory_store') {
    return `Stored: ${state.message?.slice(0, 200) || 'memory stored'}`;
  }

  // Default: use state.answer if available
  return state.answer?.slice(0, 500) || state.message?.slice(0, 200) || '';
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
      decomposePrompt: (state) => decomposePromptNode({ ...state, logger, llmBackend }),
      resolveReferences: (state) => resolveReferencesNode({ ...state, logger, mcpAdapter }),
      parseSkill: (state) => parseSkillNode({ ...state, logger, mcpAdapter, llmBackend }),
      parseIntent: (state) => parseIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
      enrichIntent: (state) => enrichIntentNode({ ...state, logger, mcpAdapter }),
      retrieveMemory: (state) => retrieveMemoryNode({ ...state, logger, mcpAdapter }),
      storeMemory: (state) => storeMemoryNode({ ...state, logger, mcpAdapter }),
      storeConstraint: (state) => storeConstraintNode({ ...state, logger, mcpAdapter }),
      liftConstraint:  (state) => liftConstraintNode({ ...state, logger, mcpAdapter }),
      webSearch: (state) => webSearchNode({ ...state, logger, mcpAdapter }),
      gatherContext: (state) => gatherContextNode({ ...state, logger, mcpAdapter, llmBackend }),
      creatorPlanning: (state) => creatorPlanningNode({ ...state, logger, mcpAdapter }),
      planSkills: (state) => planSkillsNode({ ...state, logger, mcpAdapter, llmBackend }),
      executeCommand: (state) => executeCommandNode({ ...state, logger, mcpAdapter, llmBackend }),
      recoverSkill: (state) => recoverSkillNode({ ...state, logger, mcpAdapter, llmBackend }),
      evaluateSkills: (state) => evaluateSkillsNode({ ...state, logger, mcpAdapter, llmBackend }),
      reviewExecution: (state) => reviewExecutionNode({ ...state, logger, mcpAdapter, llmBackend }),
      screenIntelligence: (state) => screenIntelligenceNode({ ...state, logger, mcpAdapter }),
      synthesize: (state) => synthesizeNode({ ...state, logger, mcpAdapter, llmBackend }),
      answer: (state) => answerNode({ ...state, logger, mcpAdapter, llmBackend }),
      appControl: (state) => appControlNode({ ...state, logger }),
      parseProject: (state) => parseProjectNode({ ...state, logger, llmBackend }),
      logConversation: (state) => logConversationNode({ ...state, logger, mcpAdapter }),
      summarizeMultiIntent: (state) => summarizeMultiIntentNode({ ...state, logger, mcpAdapter, llmBackend }),
    };
    
    // Intent-based routing (matches DistilBERT classifier intents)
    const edges = {
      start: 'decomposePrompt',
      decomposePrompt: 'resolveReferences',
      resolveReferences: 'parseIntent',
      parseIntent: 'parseSkill',
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
      enrichIntent: (state) => {
        const intentType = state.intent?.type || 'general_query';
        logger.info(`[StateGraph:Router] enrichIntent exit — intent: ${intentType} | _planFile: ${!!state._planFile} | _planMode: ${!!state._planMode}`);

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
          // BUT: if the skill is a stub (no index.cjs on disk), we must go through gatherContext
          // first so credentials/service info are collected before the skill build kicks off.
          if (state.matchedSkillName) {
            const _fs = require('fs');
            const _os = require('os');
            const _path = require('path');
            const _dotName = state.matchedSkillName;
            const _skillDir = _path.join(_os.homedir(), '.thinkdrop', 'skills', _dotName);
            const _skillExec = _path.join(_skillDir, 'index.cjs');
            const _skillMd   = _path.join(_skillDir, 'skill.md');
            const _apiJson   = _path.join(_skillDir, 'api.json');
            const _cliJson   = _path.join(_skillDir, 'cli.json');
            if (_fs.existsSync(_skillExec) || _fs.existsSync(_skillMd) || _fs.existsSync(_apiJson) || _fs.existsSync(_cliJson)) {
              logger.debug(`[StateGraph:Router] enrichIntent: matchedSkillName="${_dotName}" is installed — skipping to planSkills`);
              return 'planSkills';
            }
            // Stub-only: no index.cjs on disk — fall through to planSkills which handles it
            logger.debug(`[StateGraph:Router] enrichIntent: matchedSkillName="${_dotName}" is stub — routing to planSkills`);
            state.matchedSkillName = null;
            // fall through below
          }
          // gatherContext + creatorPlanning both bypassed — route direct to planSkills
          logger.debug('[StateGraph:Router] enrichIntent: command_automate — planSkills (creator pipeline bypassed)');
          return 'planSkills';
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
        if (intentType === 'screen_intelligence') {
          return 'screenIntelligence';
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

      // Memory store path: store → logConversation → end
      storeMemory: 'logConversation',
      // Constraint store path: storeConstraint → logConversation → end
      storeConstraint: 'logConversation',
      // Constraint lift path: liftConstraint → logConversation → end
      liftConstraint: 'logConversation',
      
      // gatherContext bypassed — kept for future re-enable
      // gatherContext: () => 'creatorPlanning',
      // creatorPlanning → planSkills (pass/warnings) or logConversation (reviewer fail)
      // creatorPlanning: (state) => {
      //   if (state.planError) {
      //     logger.debug(`[StateGraph:Router] creatorPlanning reviewer blocked: ${state.planError}`);
      //     return 'logConversation';
      //   }
      //   return 'planSkills';
      // },
      // gatherContext + creatorPlanning both bypassed — kept for future re-enable
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
        // Scout card is waiting for user provider selection — stop looping, surface ASK_USER
        // Also short-circuit for CLI/browser agent ask_user so recoverSkill is not invoked.
        if (state.scoutPending || state.pendingQuestion?._isScoutSelect || state.pendingQuestion?._isAgentAskUser) {
          return 'logConversation';
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

      // reviewExecution: FAILED → re-execute patched step, ASK_USER → surface to user, else → evaluateSkills
      reviewExecution: (state) => {
        const verdict = state.reviewVerdict;
        if (verdict === 'FAILED') {
          logger.info(`[StateGraph:Router] reviewExecution FAILED → executeCommand (retry with patch)`);
          return 'executeCommand';
        }
        if (verdict === 'ASK_USER') {
          logger.info('[StateGraph:Router] reviewExecution ASK_USER → logConversation');
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
      
      // parseProject: matched → command_automate → planSkills; no match → appControl
      parseProject: (state) => {
        if (state.projectSkillPlan && state.projectSkillPlan.length > 0) {
          logger.debug(`[StateGraph:Router] parseProject matched — routing to planSkills`);
          return 'planSkills';
        }
        logger.debug('[StateGraph:Router] parseProject no match — routing to appControl');
        return 'appControl';
      },

      // App control mode — routes to logConversation to persist state + show answer
      appControl: 'logConversation',

      // Standard path: all roads lead to logConversation before end
      retrieveMemory: 'answer',
      answer: 'logConversation',
      synthesize: 'logConversation',
      summarizeMultiIntent: 'logConversation',
      // planExecutor loops back through its own edge (above)

      // Multi-intent queue runner.
      // Each time logConversation completes for a step, this conditional checks whether
      // more steps remain in intentQueue and loops back through enrichIntent.
      // Once the queue is empty and isMultiIntent=true it routes to summarizeMultiIntent.
      // summarizeMultiIntent sets isMultiIntent=false so the final logConversation exits here.
      logConversation: async (state) => {
        // ── Plan mode: step just completed — hand back to planExecutor ────────
        // _planMode is set by planExecutor for each step it dispatches.
        // After the step runs through the normal node pipeline and reaches
        // logConversation, we capture the result and re-enter planExecutor.
        if (state._planMode && state._planFile) {
          const stepResult = state.answer || state.commandOutput || '';
          if (typeof state.progressCallback === 'function') {
            try {
              state.progressCallback({
                type: 'plan:step_done',
                stepNum: state._planStepNum,
                totalSteps: state._planTotalSteps,
                intent: state.intent?.type,
                result: (stepResult || '').slice(0, 200),
                status: (state.failedStep || state.planError) ? '❌ failed' : '✅ done',
                planFile: state._planFile,
              });
            } catch (_) {}
          }
          // Re-enter planExecutor with the completed step result
          Object.assign(state, {
            _planStepResult: stepResult,
            conversationLogged: false,
            answer: null,
            filteredMemories: [],
            contextDocs: [],
            searchResults: [],
            skillResults: [],
            skillPlan: null,
            skillCursor: 0,
            commandExecuted: false,
            commandOutput: null,
            executionResult: null,
            failedStep: null,
            planError: null,
            recoveryAction: null,
            enrichmentNeeded: [],
            matchedSkillName: null,
          });
          return 'planExecutor';
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
          let resolvedText = nextStep.text;
          for (const depIdx of (nextStep.dependsOn || [])) {
            const depResult = state.dataContext[depIdx] || '';
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
              const depResult = state.dataContext[depIdx] || '';
              dataPrefix = dataPrefix.replace(
                new RegExp(`\\{\\{result\\[${depIdx}\\]\\}\\}`, 'g'),
                depResult
              );
            }
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

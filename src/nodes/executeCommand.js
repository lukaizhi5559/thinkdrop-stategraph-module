/**
 * Execute Command Node — single-step cycle dispatcher
 *
 * Executes ONE skill step per graph pass, then signals the graph to:
 *   - Loop back here if more steps remain (skillCursor < skillPlan.length)
 *   - Route to recoverSkill if the step failed (failedStep is set)
 *   - Finish if all steps are done (commandExecuted = true)
 *
 * This single-step design enables the adaptive cycle:
 *   planSkills → executeCommand → recoverSkill → (auto_patch → executeCommand)
 *                                              → (replan    → planSkills)
 *                                              → (ask_user  → surface to user)
 *
 * State inputs:
 *   state.skillPlan    — Array<{ skill, args, optional?, description? }>
 *   state.skillCursor  — index of the current step to execute (default 0)
 *   state.skillResults — accumulated results from previous steps
 *   state.mcpAdapter   — MCP adapter for calling command-service
 *   state.intent       — must include type 'command_automate'
 *
 * State outputs (success):
 *   state.skillCursor    — advanced by 1
 *   state.skillResults   — appended with this step's result
 *   state.commandExecuted — true when all steps complete
 *   state.answer          — summary when done
 *
 * State outputs (failure):
 *   state.failedStep     — { step, skill, args, error, exitCode, stderr }
 *   state.skillResults   — appended with failed result
 *   (graph routes to recoverSkill)
 */

module.exports = async function executeCommand(state) {
  const {
    mcpAdapter,
    skillPlan,
    skillCursor = 0,
    skillResults = [],
    intent
  } = state;

  const logger = state.logger || console;
  const progressCallback = state.progressCallback || null;

  if (intent?.type !== 'command_automate') {
    return state;
  }

  if (!mcpAdapter) {
    logger.warn('[Node:ExecuteCommand] No MCP adapter available');
    return {
      ...state,
      commandExecuted: false,
      answer: '[MCP not available — skill plan could not be dispatched]'
    };
  }

  if (!Array.isArray(skillPlan) || skillPlan.length === 0) {
    logger.warn('[Node:ExecuteCommand] No skill plan — planSkills must run first');
    return {
      ...state,
      commandExecuted: false,
      answer: '[No skill plan found — ensure planSkills node runs before executeCommand]'
    };
  }

  // All steps done
  if (skillCursor >= skillPlan.length) {
    const completedCount = skillResults.filter(r => r.ok).length;
    logger.debug(`[Node:ExecuteCommand] All ${skillPlan.length} steps complete`);
    if (progressCallback) progressCallback({ type: 'all_done', completedCount, totalCount: skillPlan.length, skillResults });
    return {
      ...state,
      commandExecuted: true,
      failedStep: null,
      answer: `Completed ${completedCount}/${skillPlan.length} skill steps successfully.`
    };
  }

  const step = skillPlan[skillCursor];
  const { skill, args = {}, optional = false, description } = step;

  logger.debug(`[Node:ExecuteCommand] Step ${skillCursor + 1}/${skillPlan.length}: ${skill}${description ? ` — ${description}` : ''}`);
  if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill });

  try {
    const result = await mcpAdapter.callService('command', 'command.automate', {
      skill,
      args
    });

    const raw = result.data || result;

    const stepResult = {
      step: skillCursor + 1,
      skill,
      args,
      description: description || null,
      ok: raw.ok ?? raw.success ?? false,
      stdout: raw.stdout || null,
      stderr: raw.stderr || null,
      exitCode: raw.exitCode ?? null,
      result: raw.result || null,
      error: raw.error || null,
      executionTime: raw.executionTime || null
    };

    // Detect search commands that returned no results — treat as soft failure
    // so recoverSkill can REPLAN with a different search strategy (e.g. mdfind → find)
    const SEARCH_CMDS = ['mdfind', 'find', 'grep', 'locate'];
    const isBashSearchScript = args.cmd === 'bash' && Array.isArray(args.argv) &&
      args.argv.some(a => typeof a === 'string' && SEARCH_CMDS.some(sc => a.includes(sc)));
    const isSearchCmd = skill === 'shell.run' && (SEARCH_CMDS.includes(args.cmd) || isBashSearchScript);
    const noOutput = !stepResult.stdout || stepResult.stdout.trim().length === 0;

    if (isSearchCmd && noOutput && (stepResult.ok || stepResult.exitCode === 1)) {
      stepResult.ok = false;
      stepResult.error = `search_no_results: search returned no results for the given query`;
    }

    const updatedResults = [...skillResults, stepResult];

    if (!stepResult.ok && !optional) {
      // Step failed and is not optional — hand off to recoverSkill
      logger.warn(`[Node:ExecuteCommand] Step ${skillCursor + 1} failed: ${stepResult.error}`);
      if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill, error: stepResult.error, stderr: stepResult.stderr });
      return {
        ...state,
        skillResults: updatedResults,
        skillCursor,           // cursor stays at failed step
        failedStep: stepResult,
        commandExecuted: false
      };
    }

    if (!stepResult.ok && optional) {
      logger.debug(`[Node:ExecuteCommand] Optional step ${skillCursor + 1} failed (skipping): ${stepResult.error}`);
    }

    if (stepResult.ok || optional) {
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill, stdout: stepResult.stdout, exitCode: stepResult.exitCode });
    }

    // Step succeeded (or was optional) — advance cursor
    return {
      ...state,
      skillResults: updatedResults,
      skillCursor: skillCursor + 1,
      failedStep: null,
      commandExecuted: skillCursor + 1 >= skillPlan.length,
      answer: skillCursor + 1 >= skillPlan.length
        ? `Completed ${updatedResults.filter(r => r.ok).length}/${skillPlan.length} skill steps successfully.`
        : undefined
    };

  } catch (error) {
    // Check if this is a search command that exited with code 1 (no results) — treat as soft failure
    const SEARCH_CMDS_CATCH = ['mdfind', 'find', 'grep', 'locate'];
    const isBashSearchCatch = args.cmd === 'bash' && Array.isArray(args.argv) &&
      args.argv.some(a => typeof a === 'string' && SEARCH_CMDS_CATCH.some(sc => a.includes(sc)));
    const isSearchExit1 = (SEARCH_CMDS_CATCH.includes(args.cmd) || isBashSearchCatch) &&
      error.message && error.message.includes('code 1');

    const stepResult = {
      step: skillCursor + 1,
      skill,
      args,
      ok: false,
      error: isSearchExit1 ? 'search_no_results: search returned no results for the given query' : error.message
    };

    if (!isSearchExit1) {
      logger.error('[Node:ExecuteCommand] Unexpected error:', error.message);
    } else {
      logger.debug('[Node:ExecuteCommand] Search returned no results (exit 1), treating as soft failure');
    }
    if (progressCallback) progressCallback({ type: 'step_failed', stepIndex: skillCursor, skill, description: description || skill, error: stepResult.error, stderr: null });

    return {
      ...state,
      skillResults: [...skillResults, stepResult],
      skillCursor,
      failedStep: stepResult,
      commandExecuted: false
    };
  }
};

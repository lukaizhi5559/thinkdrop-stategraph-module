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

    // Collect file paths written during this plan for the UI "Open file" link.
    // Primary source: accumulated state.savedFilePaths set by synthesize steps (explicit saveToFile arg).
    // Fallback: detect shell.run write patterns (cat >, tee, mv destination).
    const savedFilePaths = [...(state.savedFilePaths || [])];

    // Fallback: shell.run bash scripts with write patterns
    skillResults.forEach((r) => {
      if (r.skill === 'shell.run' && r.ok && r.args?.cmd === 'bash') {
        const script = (r.args?.argv || []).find(a => typeof a === 'string') || '';
        const writeMatch = script.match(/(?:cat\s*>+|tee\s+|cp\s+\S+\s+|mv\s+\S+\s+)['"]?([^\s'"]+\.[a-zA-Z0-9]+)['"]?/);
        if (writeMatch && writeMatch[1] && writeMatch[1].startsWith('/')) {
          savedFilePaths.push(writeMatch[1]);
        }
      }
    });

    logger.debug(`[Node:ExecuteCommand] all_done: savedFilePaths=${JSON.stringify([...new Set(savedFilePaths)])}`);
    if (progressCallback) progressCallback({ type: 'all_done', completedCount, totalCount: skillPlan.length, skillResults, savedFilePaths: [...new Set(savedFilePaths)] });

    // Build a rich commandOutput summary for the answer node to interpret
    const stepSummaries = skillResults.map((r, i) => {
      const label = r.description || r.skill;
      const status = r.ok ? '✓' : '✗';
      const detail = r.result
        ? (typeof r.result === 'object' ? JSON.stringify(r.result) : String(r.result))
        : r.stdout
          ? r.stdout.trim().slice(0, 300)
          : r.error
            ? `Error: ${r.error}`
            : null;
      return `Step ${i + 1} [${status}] ${label}${detail ? `: ${detail}` : ''}`;
    }).join('\n');

    // Build a meaningful answer without needing the LLM answer node
    const failedCount = skillResults.filter(r => !r.ok).length;
    const hasBrowserSteps = skillResults.some(r => r.skill === 'browser.act');
    const lastBrowserResult = hasBrowserSteps
      ? [...skillResults].reverse().find(r => r.skill === 'browser.act' && r.ok)
      : null;

    // Check if any image.analyze step produced a description — surface it directly
    const imageAnalyzeResult = [...skillResults].reverse().find(r => r.skill === 'image.analyze' && r.ok && r.stdout);

    let answer;
    if (failedCount === 0) {
      if (imageAnalyzeResult) {
        answer = imageAnalyzeResult.stdout;
      } else if (hasBrowserSteps && lastBrowserResult?.url) {
        const title = lastBrowserResult.title ? ` — "${lastBrowserResult.title}"` : '';
        answer = `Done! Browser is open at ${lastBrowserResult.url}${title}`;
      } else {
        answer = `All ${completedCount} step${completedCount !== 1 ? 's' : ''} completed successfully.`;
      }
    } else {
      const imageAnalyzeFailure = skillResults.find(r => r.skill === 'image.analyze' && !r.ok);
      answer = imageAnalyzeFailure
        ? `Image analysis failed: ${imageAnalyzeFailure.error || 'unknown error'}`
        : `Completed ${completedCount}/${skillPlan.length} steps (${failedCount} failed).`;
    }

    // Preserve the last active browser sessionId so follow-up tasks reuse the same tab
    const lastBrowserStep = [...skillResults].reverse().find(r => r.skill === 'browser.act' && r.ok);
    const activeBrowserSessionId = lastBrowserStep?.args?.sessionId || state.activeBrowserSessionId || null;

    // Stream the answer to the UI if it contains meaningful content (e.g. image.analyze result).
    // The answer node is bypassed for command_automate, so we push it here via streamCallback.
    const streamCallback = state.streamCallback || null;
    logger.info(`[Node:ExecuteCommand] image.analyze all_done: hasStreamCallback=${typeof streamCallback === 'function'}, answerLength=${answer?.length ?? 'null'}, imageAnalyzeResult=${!!imageAnalyzeResult}`);
    if (imageAnalyzeResult && answer && typeof streamCallback === 'function') {
      logger.info(`[Node:ExecuteCommand] Streaming image.analyze answer (${answer.length} chars)`);
      streamCallback(answer);
    }

    return {
      ...state,
      commandExecuted: true,
      failedStep: null,
      commandOutput: stepSummaries,
      activeBrowserSessionId,
      answer
    };
  }

  const step = skillPlan[skillCursor];
  const { skill, args = {}, optional = false, description } = step;

  // ── synthesize pseudo-skill ──────────────────────────────────────────────
  // Runs the LLM synthesis INLINE so the answer is in state before any
  // subsequent steps execute. This allows post-synthesize steps to use
  // {{synthesisAnswer}} in their args (e.g. smartType the comparison into Google).
  if (skill === 'synthesize') {
    logger.debug(`[Node:ExecuteCommand] synthesize step — running LLM inline`);
    if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'synthesize', description: description || 'Comparing results...' });

    // Gather all getPageText results from prior steps
    logger.debug(`[Node:ExecuteCommand] synthesize: skillResults has ${skillResults.length} entries`);
    skillResults.forEach((r, i) => {
      logger.debug(`[Node:ExecuteCommand]   [${i}] skill=${r.skill} action=${r.args?.action} ok=${r.ok} result=${r.result ? String(r.result).substring(0, 80) : 'null'}`);
    });
    const pageTextResults = skillResults
      .filter(r => r.skill === 'browser.act' && r.args?.action === 'getPageText' && r.ok && r.result)
      .map(r => ({ source: r.args?.sessionId || 'unknown', url: r.url || '', text: r.result }));
    logger.debug(`[Node:ExecuteCommand] synthesize: found ${pageTextResults.length} getPageText results`);

    // Include shell.run stdout (e.g. cat file output) as well as browser getPageText results
    const shellStdoutResults = skillResults
      .filter(r => r.skill === 'shell.run' && r.ok && r.stdout && r.stdout.trim().length > 0)
      .map(r => `=== Shell output (${r.description || r.args?.cmd || 'shell.run'}) ===\n${r.stdout}`);

    const synthesisContext = pageTextResults.length > 0
      ? [...pageTextResults.map(p => `=== Source: ${p.url || p.source} ===\n${p.text}`), ...shellStdoutResults].join('\n\n')
      : shellStdoutResults.length > 0
        ? shellStdoutResults.join('\n\n')
        : skillResults.filter(r => r.ok && r.result).map(r => String(r.result)).join('\n\n');

    const synthesisPrompt = args.prompt || description || 'Compare and summarize the results from each source.';
    let synthesisFilePath = args.saveToFile || null;

    // If saveToFile contains {{prev_stdout}}, resolve it now using the previous step's stdout
    if (synthesisFilePath && synthesisFilePath.includes('{{prev_stdout}}')) {
      const prevStep = skillResults[skillResults.length - 1];
      const prevStdout = prevStep?.stdout?.trim() || '';
      synthesisFilePath = synthesisFilePath.replace(/\{\{prev_stdout\}\}/g, prevStdout);
      logger.debug(`[Node:ExecuteCommand] synthesize: resolved saveToFile via {{prev_stdout}}: ${synthesisFilePath}`);
    }

    // If saveToFile is still relative/missing but a prior shell.run step output a single absolute path,
    // use that path's directory (handles single-pipeline find+read where stdout = file content, not path)
    if (!synthesisFilePath || !synthesisFilePath.startsWith('/')) {
      const pathMod = require('path');
      // Look for a pure-find step whose stdout is a single absolute file path
      const purePathStep = skillResults.find(r =>
        r.skill === 'shell.run' && r.ok && r.stdout &&
        /^\/[^\n]+\.[a-zA-Z0-9]+$/.test(r.stdout.trim())
      );
      if (purePathStep) {
        const foundPath = purePathStep.stdout.trim();
        const dir = pathMod.dirname(foundPath);
        const base = pathMod.basename(foundPath, pathMod.extname(foundPath));
        synthesisFilePath = pathMod.join(dir, base + '.txt');
        logger.debug(`[Node:ExecuteCommand] synthesize: saveToFile from pure-find step stdout: ${synthesisFilePath}`);
      }
    }

    // Run LLM inline
    const llmBackend = state.llmBackend;
    const streamCallback = state.streamCallback;
    const context = state.context;
    let synthesisAnswer = '[Synthesis unavailable — no LLM backend]';

    if (llmBackend) {
      const isStreaming = typeof streamCallback === 'function';
      // Use file-editing instructions when shell stdout is present (file content), otherwise use web research instructions
      const hasFileContent = shellStdoutResults.length > 0;
      const synthesisQuery = hasFileContent
        ? `${synthesisPrompt}\n\nHere is the current file content:\n\n${synthesisContext}`
        : `${synthesisPrompt}\n\nHere is the content collected from each source:\n\n${synthesisContext}`;
      const synthesisInstructions = hasFileContent
        ? `You are a file editing assistant. The user has asked you to modify a file. You have been given the current file content. Your job is to output the COMPLETE updated file content with ONLY the requested changes applied. Output the full file text only — no preamble, no explanation, no markdown code fences, no commentary. Preserve all existing structure, headings, and formatting. Only change what was explicitly requested.`
        : `You are a research assistant. The user asked you to compare or summarize information from multiple websites. You have been given the text content from each site. Provide a clear, structured comparison or summary that directly answers the user's request. Use headings for each source if comparing. Be concise and factual.`;
      const synthPayload = {
        query: synthesisQuery,
        context: {
          conversationHistory: [],
          systemInstructions: synthesisInstructions,
          sessionId: context?.sessionId,
          userId: context?.userId,
          intent: 'command_automate'
        },
        options: { maxTokens: 1500, temperature: 0.2, fastMode: false }
      };
      try {
        synthesisAnswer = await llmBackend.generateAnswer(synthesisQuery, synthPayload, synthPayload.options, isStreaming ? streamCallback : null);
        logger.debug(`[Node:ExecuteCommand] synthesize: LLM answer generated (${synthesisAnswer.length} chars)`);
        if (!isStreaming && typeof streamCallback === 'function' && synthesisAnswer) streamCallback(synthesisAnswer);
      } catch (err) {
        logger.error('[Node:ExecuteCommand] synthesize LLM call failed:', err.message);
        synthesisAnswer = `[Synthesis failed: ${err.message}]`;
      }
    } else {
      logger.warn('[Node:ExecuteCommand] synthesize: no llmBackend in state — skipping LLM call');
    }

    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    // Write to explicit saveToFile if requested
    if (synthesisFilePath && synthesisAnswer && !synthesisAnswer.startsWith('[')) {
      try {
        fs.writeFileSync(synthesisFilePath, synthesisAnswer, 'utf8');
        logger.debug(`[Node:ExecuteCommand] synthesize: saved to ${synthesisFilePath}`);
      } catch (writeErr) {
        logger.warn(`[Node:ExecuteCommand] synthesize: could not write file: ${writeErr.message}`);
      }
    }

    // Always write to a temp file so shell.run steps can use {{synthesisAnswerFile}}
    let synthesisAnswerFile = '';
    try {
      synthesisAnswerFile = path.join(os.tmpdir(), `thinkdrop_synthesis_${Date.now()}.txt`);
      fs.writeFileSync(synthesisAnswerFile, synthesisAnswer, 'utf8');
      logger.debug(`[Node:ExecuteCommand] synthesize: temp file at ${synthesisAnswerFile}`);
    } catch (tmpErr) {
      logger.warn(`[Node:ExecuteCommand] synthesize: could not write temp file: ${tmpErr.message}`);
    }

    // Emit step_done with the actual answer as stdout (and savedFilePath if written)
    if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill: 'synthesize', description: description || 'Comparing results...', stdout: synthesisAnswer, savedFilePath: synthesisFilePath || null });

    // Accumulate explicit saveToFile paths across multiple synthesize steps
    const prevSavedFiles = state.savedFilePaths || [];
    const newSavedFiles = synthesisFilePath && !synthesisAnswer.startsWith('[')
      ? [...prevSavedFiles, synthesisFilePath]
      : prevSavedFiles;

    return {
      ...state,
      skillResults: [...skillResults, { step: skillCursor + 1, skill: 'synthesize', args, description, ok: true, result: synthesisAnswer, stdout: synthesisAnswer }],
      skillCursor: skillCursor + 1,
      failedStep: null,
      synthesisAnswer,          // available as {{synthesisAnswer}} in subsequent step args
      synthesisAnswerFile,      // available as {{synthesisAnswerFile}} — use in shell.run for full bash power
      savedFilePaths: newSavedFiles,  // accumulated explicit saveToFile paths for UI file links
      needsSynthesis: false,
      commandExecuted: false,
      answer: undefined
    };
  }

  // Substitute template variables in step args so steps can reference prior results:
  //   {{synthesisAnswer}}     — full text output of the last synthesize step
  //   {{synthesisAnswerFile}} — temp file path containing synthesisAnswer
  //   {{prev_stdout}}         — stdout of the immediately preceding step (enables find→read→write chains)
  const synthesisAnswer = state.synthesisAnswer || '';
  const synthesisAnswerFile = state.synthesisAnswerFile || '';
  const prevStdout = skillResults.length > 0 ? (skillResults[skillResults.length - 1].stdout || '').trim() : '';
  let resolvedArgs = args;
  if (synthesisAnswer || synthesisAnswerFile || prevStdout) {
    let argsJson = JSON.stringify(args);
    if (synthesisAnswer) {
      argsJson = argsJson.replace(/\{\{synthesisAnswer\}\}/g, synthesisAnswer.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'));
    }
    if (synthesisAnswerFile) {
      argsJson = argsJson.replace(/\{\{synthesisAnswerFile\}\}/g, synthesisAnswerFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
    if (prevStdout) {
      argsJson = argsJson.replace(/\{\{prev_stdout\}\}/g, prevStdout.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'));
    }
    resolvedArgs = JSON.parse(argsJson);
  }

  logger.debug(`[Node:ExecuteCommand] Step ${skillCursor + 1}/${skillPlan.length}: ${skill}${description ? ` — ${description}` : ''}`);
  if (progressCallback) progressCallback({ type: 'step_start', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill });

  // Use the step's timeoutMs (may have been patched by recoverSkill AUTO_PATCH) as the HTTP timeout
  const stepTimeoutMs = resolvedArgs.timeoutMs || 60000;

  try {
    const result = await mcpAdapter.callService('command', 'command.automate', {
      skill,
      args: resolvedArgs
    }, { timeoutMs: stepTimeoutMs });

    const raw = result.data || result;

    // For ui.waitFor steps: synthesize a human-readable stdout from matched condition
    let waitForStdout = null;
    if (skill === 'ui.waitFor' && raw.success) {
      const parts = [];
      if (raw.matched) {
        parts.push(`Matched: ${raw.condition}="${raw.value}"`);
        if (raw.appName && raw.appName !== 'unknown') parts.push(`app=${raw.appName}`);
        if (raw.url) parts.push(raw.url);
        if (raw.windowTitle && raw.windowTitle !== 'unknown') parts.push(`"${raw.windowTitle}"`);
        parts.push(`(${raw.elapsed}ms, ${raw.pollCount} polls)`);
      } else {
        parts.push(`Timed out waiting for ${raw.condition}="${raw.value}"`);
      }
      waitForStdout = parts.join(' — ');
    }

    // For browser.act steps: synthesize a human-readable stdout from url+title+result
    // so the UI step list shows something meaningful instead of "No output"
    let browserStdout = null;
    if (skill === 'browser.act' && raw.ok) {
      const parts = [];
      if (raw.url) parts.push(raw.url);
      if (raw.title) parts.push(`"${raw.title}"`);
      if (raw.result !== undefined && raw.result !== null) {
        const resultStr = typeof raw.result === 'object' ? JSON.stringify(raw.result) : String(raw.result);
        if (resultStr.length < 200) parts.push(resultStr);
      }
      if (parts.length) browserStdout = parts.join(' — ');
    }

    // ui.screen.verify ok logic:
    //   verified: true  → real pass
    //   verified: null  → degraded (vision unavailable) → treat as pass (skip verification)
    //   verified: false → real failure → trigger recoverSkill
    const verifyOk = raw.success === true && (raw.verified === true || raw.verified === null);
    if (skill === 'ui.screen.verify' && raw.degraded) {
      logger.warn('[Node:ExecuteCommand] ui.screen.verify degraded — vision unavailable, skipping verification', { reasoning: raw.reasoning });
    }

    const stepResult = {
      step: skillCursor + 1,
      skill,
      args,
      description: description || null,
      ok: skill === 'ui.screen.verify'
        ? verifyOk
        : (raw.ok ?? raw.success ?? false),
      stdout: raw.stdout || waitForStdout || browserStdout || null,
      stderr: raw.stderr || null,
      exitCode: raw.exitCode ?? null,
      result: raw.result ?? null,
      url: raw.url ?? null,
      pageContext: raw.pageContext ?? null,
      error: raw.error || null,
      executionTime: raw.executionTime || null,
      needsManualStep: raw.needsManualStep || false,
      instruction: raw.instruction || null,
      reason: raw.reason || null,
      verified: raw.verified !== undefined ? raw.verified : null,
      reasoning: raw.reasoning || null,
      suggestion: raw.suggestion || null
    };

    // Detect shell.run search commands that returned no results — treat as soft failure
    // so recoverSkill can REPLAN with a different search strategy (e.g. mdfind → find)
    // NOTE: only applies to shell.run, never browser.act
    // NOTE: bash scripts that also contain write/edit ops (sed -i, cp, mv, echo >, tee, cat >)
    //       are NOT pure searches — no output is expected and is a success.
    const SEARCH_CMDS = ['mdfind', 'find', 'grep', 'locate'];
    const WRITE_OPS = ['sed -i', 'sed -E -i', 'cp ', 'mv ', 'echo ', 'tee ', 'cat >', 'cat>',
                       'printf ', 'write ', 'rm ', 'mkdir ', 'touch ', 'chmod ', 'chown '];
    const bashScript = args.cmd === 'bash' && Array.isArray(args.argv)
      ? args.argv.find(a => typeof a === 'string') || ''
      : '';
    const isBashSearchScript = bashScript.length > 0 &&
      SEARCH_CMDS.some(sc => bashScript.includes(sc)) &&
      !WRITE_OPS.some(wo => bashScript.includes(wo));
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
      if (skill === 'image.analyze') {
        logger.info(`[Node:ExecuteCommand] image.analyze step_done stdout length: ${stepResult.stdout?.length ?? 'null'}, preview: ${String(stepResult.stdout || '').slice(0, 80)}`);
      }
      if (progressCallback) progressCallback({ type: 'step_done', stepIndex: skillCursor, totalSteps: skillPlan.length, skill, description: description || skill, stdout: stepResult.stdout, exitCode: stepResult.exitCode });
    }

    // Track the active browser sessionId and URL for follow-up tasks
    const activeBrowserSessionId = skill === 'browser.act' && stepResult.ok && args.sessionId
      ? args.sessionId
      : state.activeBrowserSessionId || null;
    const activeBrowserUrl = skill === 'browser.act' && stepResult.ok && raw.url
      ? raw.url
      : state.activeBrowserUrl || null;

    // Step succeeded (or was optional) — advance cursor
    return {
      ...state,
      skillResults: updatedResults,
      skillCursor: skillCursor + 1,
      failedStep: null,
      activeBrowserSessionId,
      activeBrowserUrl,
      commandExecuted: skillCursor + 1 >= skillPlan.length,
      answer: undefined  // answer is built in the 'all steps done' block on the next pass
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

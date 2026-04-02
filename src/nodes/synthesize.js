/**
 * Synthesize Node — LLM comparison/summary of multi-source browser content
 *
 * Runs as a first-class StateGraph node (not buried in answer.js).
 * Receives synthesisContext + synthesisPrompt from executeCommand's synthesize step.
 * Streams the answer like any other node, writes to synthesisFilePath if set,
 * and returns state with `answer` set so downstream nodes (logConversation,
 * or any future chained task like Gemini) can consume it.
 */

const fs = require('fs');

module.exports = async function synthesizeNode(state) {
  const {
    logger,
    llmBackend,
    synthesisContext,
    synthesisPrompt,
    synthesisFilePath,
    queryMessage,
    context,
    streamCallback,
    progressCallback,
  } = state;

  logger.debug('[Node:Synthesize] Starting synthesis');

  if (!synthesisContext) {
    logger.warn('[Node:Synthesize] No synthesisContext — nothing to synthesize');
    return { ...state, answer: '[No content collected for synthesis]', needsSynthesis: false };
  }

  if (!llmBackend) {
    logger.error('[Node:Synthesize] No llmBackend available');
    return { ...state, answer: '[Synthesis failed: no LLM backend]', needsSynthesis: false };
  }

  const isStreaming = typeof streamCallback === 'function';

  const synthesisQuery = `${synthesisPrompt || queryMessage}\n\nHere is the content collected from each source:\n\n${synthesisContext}`;
  const _todayISO = new Date().toISOString().slice(0, 10);
  const synthesisInstructions = `You are a helpful assistant. Today's date is ${_todayISO}. The user asked you to summarize or analyze data from API responses or web sources. You have been given the content. Provide a clear, concise answer that directly addresses the user's request. When the user's question references a time period (e.g. "last week", "yesterday", "two weeks ago"), reason relative to today (${_todayISO}). Do not assume a date from your training data.`;

  const synthPayload = {
    query: synthesisQuery,
    context: {
      conversationHistory: [],
      systemInstructions: synthesisInstructions,
      sessionId: context?.sessionId,
      userId: context?.userId,
      intent: 'command_automate'
    },
    // Skill contract writes need more room — a full skill.md with ## Auth,
    // ## Commands, curl examples etc. easily exceeds 1500 tokens and gets
    // truncated mid-code-block, producing corrupted stored contracts.
    options: { maxTokens: synthesisFilePath?.endsWith('.md') ? 4096 : 1500, temperature: 0.2, fastMode: false }
  };

  try {
    const synthesisAnswer = await llmBackend.generateAnswer(
      synthesisQuery,
      synthPayload,
      synthPayload.options,
      isStreaming ? streamCallback : null
    );

    logger.debug(`[Node:Synthesize] Answer generated (${synthesisAnswer.length} chars)`);

    if (!isStreaming && typeof streamCallback === 'function' && synthesisAnswer) {
      streamCallback(synthesisAnswer);
    }

    // Write to file if requested via synthesize args.saveToFile
    // (shell.run can't do this — it runs before synthesis generates the text)
    if (synthesisFilePath) {
      try {
        fs.writeFileSync(synthesisFilePath, synthesisAnswer, 'utf8');
        logger.debug(`[Node:Synthesize] Saved to: ${synthesisFilePath}`);
      } catch (writeErr) {
        logger.warn(`[Node:Synthesize] Could not write file: ${writeErr.message}`);
      }
    }

    // Emit step_done with the answer as stdout so the UI shows the synthesis output
    if (progressCallback) {
      progressCallback({
        type: 'step_done',
        stepIndex: state.synthesisStepIndex ?? -1,
        totalSteps: state.synthesisTotalSteps ?? 0,
        skill: 'synthesize',
        description: state.synthesisStepDescription || 'Compare results from all sources',
        stdout: synthesisAnswer,
        isSynthesisResult: true
      });
    }

    return {
      ...state,
      answer: synthesisAnswer,
      synthesisAnswer,        // keep for downstream chaining
      needsSynthesis: false,
      commandExecuted: true,  // signal logConversation to proceed
      metadata: {
        ...state.metadata,
        answerSource: llmBackend.getInfo().type,
        llmBackend: llmBackend.getInfo()
      }
    };
  } catch (error) {
    logger.error('[Node:Synthesize] Failed:', error.message);
    return { ...state, answer: `[Synthesis failed: ${error.message}]`, needsSynthesis: false };
  }
};

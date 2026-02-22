/**
 * Answer Node - Pluggable LLM backend
 * 
 * Generates answer using a swappable LLM backend strategy.
 * Backend is selected via state.llmBackend (injected by StateGraphBuilder).
 * 
 * Backend priority:
 *   1. state.llmBackend   - explicitly injected backend (from StateGraphService/Builder)
 *   2. useOnlineMode=true - VSCodeLLMBackend (bibscrip-backend ws://localhost:4000/ws/stream)
 *   3. mcpAdapter present - MCPLLMBackend (local phi4 service)
 *   4. Placeholder        - graceful degradation when nothing is available
 * 
 * Online mode fallback: if WebSocket backend is unavailable, falls back to MCPLLMBackend.
 * 
 * Mirrors the dual-mode pattern in the original answer.cjs:
 *   - Streaming: onToken callback forwarded token-by-token
 *   - Blocking:  full answer returned at once
 */

const fs = require('fs');
const path = require('path');
const MCPLLMBackend = require('../backends/MCPLLMBackend');
const VSCodeLLMBackend = require('../backends/VSCodeLLMBackend');

// Load intent rules from answer.md at startup — editable without touching code
function loadAnswerPrompts() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../prompts/answer.md'), 'utf8');
    const rules = {};
    let base = '';
    let commandOutputLine = '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.includes('|') && (trimmed.startsWith('Answer') || (base === '' && !trimmed.startsWith('Command')))) {
        base = base || trimmed;
        continue;
      }
      if (trimmed.startsWith('Command output interpretation')) {
        commandOutputLine = trimmed;
        continue;
      }
      if (trimmed.includes('|')) {
        const parts = trimmed.split('|');
        const intent = parts[0];
        const ruleLines = parts.slice(1).map(r => `\n- ${r}`);
        rules[intent] = ruleLines.join('');
      }
    }
    return { base, rules, commandOutputLine };
  } catch (_) {
    return null;
  }
}

module.exports = async function answer(state) {
  const ANSWER_PROMPTS = loadAnswerPrompts();
  const {
    mcpAdapter,
    llmBackend,           // Injected pluggable backend (optional)
    useOnlineMode = false, // 🌐 Use bibscrip-backend WebSocket instead of local phi4
    message,
    resolvedMessage,      // Coreference-resolved message (preferred)
    intent,
    context,
    conversationHistory = [],
    sessionFacts = [],
    sessionEntities = [],
    filteredMemories = [],
    contextDocs = [],     // Web search results
    streamCallback = null,
    retryCount = 0,
    commandOutput = null,
    executedCommand = null,
    needsInterpretation = false
  } = state;

  const logger = state.logger || console;

  // Use resolved message if available (coreference resolution)
  let queryMessage = resolvedMessage || message;
  if (typeof queryMessage !== 'string') {
    queryMessage = typeof queryMessage === 'object'
      ? JSON.stringify(queryMessage)
      : String(queryMessage);
  }

  // Only stream on first attempt - retries would cause double responses
  const isStreaming = typeof streamCallback === 'function' && retryCount === 0;

  logger.debug(`[Node:Answer] Generating answer (streaming: ${isStreaming}, retry: ${retryCount})`);

  // ─── Resolve which backend to use ───────────────────────────────────────────
  // Priority:
  //   1. Explicitly injected llmBackend (from StateGraphService / StateGraphBuilder)
  //   2. useOnlineMode=true → VSCodeLLMBackend (bibscrip-backend WebSocket)
  //   3. mcpAdapter present → MCPLLMBackend (local phi4)
  //   4. Placeholder
  let backend = llmBackend;

  if (!backend && useOnlineMode) {
    backend = new VSCodeLLMBackend({
      wsUrl:             process.env.WEBSOCKET_URL     || 'ws://localhost:4000/ws/stream',
      apiKey:            process.env.WEBSOCKET_API_KEY || 'test-api-key-123',
      userId:            context?.userId               || 'default_user',
      connectTimeoutMs:  5000,
      responseTimeoutMs: 60000,
    });
    logger.debug(`[Node:Answer] Using VSCodeLLMBackend (online mode) → ${backend.wsUrl}`);
  }

  if (!backend && mcpAdapter) {
    backend = new MCPLLMBackend(mcpAdapter);
    logger.debug('[Node:Answer] Using MCPLLMBackend (phi4)');
  }

  if (!backend) {
    logger.warn('[Node:Answer] No LLM backend available - returning placeholder');
    return {
      ...state,
      answer: `[No LLM backend configured - Intent: ${intent?.type || 'unknown'}]`,
      metadata: { ...state.metadata, answerSource: 'placeholder' }
    };
  }

  // ─── Check availability ──────────────────────────────────────────────────────
  const available = await backend.isAvailable().catch(() => false);
  if (!available) {
    const info = backend.getInfo();
    logger.warn(`[Node:Answer] Backend unavailable: ${info.name}`);

    // Online mode: fall back to MCPLLMBackend (phi4) if WebSocket is down
    if (useOnlineMode && mcpAdapter) {
      logger.debug('[Node:Answer] Online backend unavailable, falling back to MCPLLMBackend (phi4)');
      backend = new MCPLLMBackend(mcpAdapter);
      const fallbackAvailable = await backend.isAvailable().catch(() => false);
      if (!fallbackAvailable) {
        return {
          ...state,
          answer: `[Both online backend and local phi4 are unavailable]`,
          metadata: { ...state.metadata, answerSource: 'unavailable' }
        };
      }
    } else {
      return {
        ...state,
        answer: `[${info.name} is not available]`,
        metadata: { ...state.metadata, answerSource: 'unavailable' }
      };
    }
  }

  // ─── Build system instructions (intent-driven) ───────────────────────────────
  const intentType = intent?.type || 'question';

  const baseInstruction = ANSWER_PROMPTS?.base || 'Answer using the provided context. Be direct and natural.';
  let systemInstructions = `${baseInstruction}\n\nContext:`;

  const contextSources = [];
  if (filteredMemories.length > 0) contextSources.push(`- ${filteredMemories.length} user memories`);
  if (contextDocs.length > 0) contextSources.push(`- ${contextDocs.length} web search results`);
  if (state.screenContext) contextSources.push('- Screen content analysis');
  if (conversationHistory.length > 0) contextSources.push(`- ${conversationHistory.length} conversation messages`);

  systemInstructions += contextSources.length > 0
    ? '\n' + contextSources.join('\n')
    : '\n- No additional context';

  systemInstructions += '\n\nRules:';

  // Load intent-specific rules from answer.md, fall back to inline defaults
  const intentRules = ANSWER_PROMPTS?.rules;
  if (intentRules?.[intentType]) {
    systemInstructions += intentRules[intentType];
  } else if (intentRules?.['default']) {
    systemInstructions += intentRules['default'];
  } else {
    // Inline fallback if .md not loaded
    if (intentType === 'web_search' || intentType === 'search') {
      systemInstructions += '\n- Answer using the web search results\n- Be factual and direct';
    } else if (intentType === 'screen_intelligence' || intentType === 'vision') {
      systemInstructions += '\n- Describe the screen content\n- Be specific about visible elements';
    } else if (intentType === 'command_execute' || intentType === 'command_guide') {
      systemInstructions += '\n- Interpret the command output as human-readable information\n- Be clear, concise, and helpful';
    } else if (intentType === 'command_automate') {
      systemInstructions += '\n- Summarize what was automated and the outcome of each step\n- If any step failed or was skipped, explain clearly\n- Be concise — one line per step';
    } else if (intentType === 'memory_store' || intentType === 'memory_retrieve') {
      systemInstructions += '\n- Answer using the provided Conversation History and Screen Activity & User Memories\n- The Conversation History contains the actual chat messages — use these to answer questions about past conversations\n- The Memories contain screen captures and activity — use these to answer questions about what the user was doing\n- Be specific: quote or summarize actual messages/topics from the history\n- Do NOT say you lack information if Conversation History or Memories are present in the prompt';
    } else {
      systemInstructions += '\n- Use the provided context\n- Be helpful and concise';
    }
  }

  if (needsInterpretation) {
    const cmdOutputLine = ANSWER_PROMPTS?.commandOutputLine ||
      'Command output interpretation: Answer in 1 sentence based on the command output below.';
    systemInstructions += `\n\n${cmdOutputLine}`;
  }

  // Inject screen context into system instructions (not into the user query)
  if (state.context && typeof state.context === 'string') {
    const truncated = state.context.length > 6000
      ? state.context.substring(0, 6000) + '\n...(truncated)'
      : state.context;
    systemInstructions += `\n\n${truncated}`;
  }

  // ─── Build final query ───────────────────────────────────────────────────────
  // IMPORTANT: Do NOT concatenate screen/visual context into the user query string.
  // Screen context is already in systemInstructions above. Concatenating it into
  // the query causes the raw OCR blob to appear verbatim in the results window.
  let finalQuery = queryMessage;

  if (state.visualContext && intentType === 'vision') {
    // Vision context: append directly to query (small, structured)
    finalQuery = `${queryMessage}\n\n${state.visualContext}`;
  }

  // ─── Build phi4-compatible payload ──────────────────────────────────────────
  const isCommandWithOutput = needsInterpretation && commandOutput;

  const payload = {
    query: isCommandWithOutput
      ? `Interpret this command output:\n\n${String(commandOutput).substring(0, 5000)}`
      : finalQuery,
    context: {
      conversationHistory: isCommandWithOutput ? [] : conversationHistory,
      sessionFacts: isCommandWithOutput ? [] : sessionFacts,
      sessionEntities: isCommandWithOutput ? [] : sessionEntities,
      memories: isCommandWithOutput ? [] : filteredMemories,
      webSearchResults: isCommandWithOutput ? [] : contextDocs,
      systemInstructions,
      sessionId: context?.sessionId,
      userId: context?.userId,
      intent: intentType,
      ...(isCommandWithOutput && {
        commandContext: { originalQuery: queryMessage, executedCommand }
      })
    },
    options: {
      maxTokens: 500,
      temperature: 0.1,
      fastMode: filteredMemories.length === 0 && contextDocs.length === 0 && conversationHistory.length <= 2
    }
  };

  // ─── Generate answer ─────────────────────────────────────────────────────────
  logger.debug(`[Node:Answer] systemInstructions preview: ${systemInstructions.substring(0, 300)}`);
  logger.debug(`[Node:Answer] conversationHistory: ${conversationHistory.length} msgs, memories: ${filteredMemories.length}`);

  try {
    const finalAnswer = await backend.generateAnswer(
      finalQuery,
      payload,
      payload.options,
      isStreaming ? streamCallback : null
    );

    logger.debug(`[Node:Answer] Answer generated (${finalAnswer.length} chars) via ${backend.getInfo().name}`);

    // In non-streaming mode, still emit via streamCallback so UI receives it
    if (!isStreaming && typeof streamCallback === 'function' && finalAnswer) {
      streamCallback(finalAnswer);
    }

    return {
      ...state,
      answer: finalAnswer,
      metadata: {
        ...state.metadata,
        answerSource: backend.getInfo().type,
        llmBackend: backend.getInfo()
      }
    };

  } catch (error) {
    logger.error('[Node:Answer] Failed to generate answer:', error.message);

    return {
      ...state,
      answer: `[Error generating answer: ${error.message}. Intent: ${intentType}]`,
      error: error.message,
      metadata: { ...state.metadata, answerSource: 'error' }
    };
  }
};

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
    needsInterpretation = false,
    needsSynthesis = false,
    synthesisContext = null,
    synthesisPrompt = null
  } = state;

  const logger = state.logger || console;

  // Use originalMessage when parseIntent translated non-English input for phi4 classification.
  // originalMessage holds the user's actual words; message/resolvedMessage hold the English
  // translation that was only used for intent classification — not for answering.
  let queryMessage = state.originalMessage || resolvedMessage || message;
  if (typeof queryMessage !== 'string') {
    queryMessage = typeof queryMessage === 'object'
      ? JSON.stringify(queryMessage)
      : String(queryMessage);
  }

  // Only stream on first attempt - retries would cause double responses
  const isStreaming = typeof streamCallback === 'function' && retryCount === 0;

  logger.debug(`[Node:Answer] Generating answer (streaming: ${isStreaming}, retry: ${retryCount})`);

  // ─── Resolve which backend to use ───────────────────────────────────────────
  const backend = llmBackend;

  if (!backend) {
    logger.warn('[Node:Answer] No llmBackend in state — returning placeholder');
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
    return {
      ...state,
      answer: `[${info.name} is not available]`,
      metadata: { ...state.metadata, answerSource: 'unavailable' }
    };
  }

  // ─── Resolve response language FIRST so it prefixes the entire system prompt ──
  const LANG_NAMES = { zh: 'Chinese (Mandarin)', es: 'Spanish', fr: 'French', pt: 'Portuguese', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', de: 'German', it: 'Italian', ru: 'Russian' };
  const _isVoiceSource = context?.source === 'voice';

  function _detectTextLanguage(text) {
    if (!text || text.length < 3) return null;
    const cjk     = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g) || []).length;
    const hiragana = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const hangul   = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length;
    const arabic   = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
    const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
    const total = text.replace(/\s/g, '').length || 1;
    if (cjk / total > 0.15) return hiragana > cjk * 0.3 ? 'ja' : 'zh';
    if (hangul / total > 0.15) return 'ko';
    if (arabic / total > 0.15) return 'ar';
    if (cyrillic / total > 0.15) return 'ru';
    if (devanagari / total > 0.15) return 'hi';
    if (/[¿¡áéíóúüñ]/i.test(text)) return 'es';
    if (/[àâçèéêëîïôùûüæœ]/i.test(text)) return 'fr';
    if (/[àèìòùâêîôûã]/i.test(text)) return 'pt';
    if (/[äöüß]/i.test(text)) return 'de';
    if (/[àèìòùé]/i.test(text)) return 'it';
    return null;
  }

  let resolvedResponseLanguage = (state.responseLanguage && state.responseLanguage !== 'en') ? state.responseLanguage : null;
  if (!resolvedResponseLanguage && _isVoiceSource) {
    try {
      const os = require('os');
      const journalPath = path.join(os.homedir(), '.thinkdrop', 'voice-state.json');
      const journalRaw = fs.readFileSync(journalPath, 'utf8');
      const journalState = JSON.parse(journalRaw);
      const sl = journalState?.voice?.sessionLanguage;
      if (sl && sl !== 'en') resolvedResponseLanguage = sl;
    } catch (_) {}
  }
  if (!resolvedResponseLanguage && !_isVoiceSource) {
    resolvedResponseLanguage = _detectTextLanguage(queryMessage) || null;
  }

  // Build language override prefix — placed at TOP of system prompt so it cannot be overridden
  // by dense English context that follows (Rules, memories, history are all in English).
  let langOverridePrefix = '';
  if (resolvedResponseLanguage) {
    const langName = LANG_NAMES[resolvedResponseLanguage] || resolvedResponseLanguage;
    logger.info(`[Node:Answer] detectedLanguage=${resolvedResponseLanguage} (source: ${_isVoiceSource ? 'voice-journal' : 'text-detect'}) — injecting ${langName} instruction`);
    langOverridePrefix = `LANGUAGE OVERRIDE: The user's message is in ${langName}. You MUST write your ENTIRE response in ${langName} only. Do NOT use English under any circumstance.\n\n`;
  }

  // ─── Build system instructions (intent-driven) ───────────────────────────────
  const intentType = intent?.type || 'question';

  const baseInstruction = ANSWER_PROMPTS?.base || 'Answer using the provided context. Be direct and natural.';
  let systemInstructions = `${langOverridePrefix}${baseInstruction}\n\nContext:`;

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

  // Language detection and injection already handled above (langOverridePrefix at top of systemInstructions).

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

    // ── Guide offer extraction ────────────────────────────────────────────────
    // The LLM may append a guide offer question to its answer (per answer.md rules).
    // Detect it, strip it from the displayed text, and surface it as a pendingQuestion
    // so the UI renders clickable option buttons instead of raw text.
    //
    // The LLM is instructed to add a separator line before the question, so we split on
    // common separator patterns ("---", "***", blank line before "Would you like").
    let displayAnswer = finalAnswer;
    let pendingQuestion = null;

    const GUIDE_OFFER_RE = /(?:^|\n)[-*]{3,}\n?(Would you like me to [^?\n]{5,}\?)/im;
    const simpleGuideRE = /\n\n(Would you like me to [^?\n]{5,}\?)\s*$/i;

    const match = finalAnswer.match(GUIDE_OFFER_RE) || finalAnswer.match(simpleGuideRE);
    if (match && (intentType === 'web_search' || intentType === 'general_knowledge' || intentType === 'screen_intelligence' || intentType === 'general_query')) {
      const questionText = match[1].trim();
      // Strip the separator + question from the displayed answer
      displayAnswer = finalAnswer.slice(0, finalAnswer.lastIndexOf(match[0])).trimEnd();

      pendingQuestion = {
        question: questionText,
        options: [
          `Walk me through it step by step`,
          `Let's do it together — guide me`,
          `No thanks, the explanation is enough`
        ],
        _guideContext: (queryMessage.length > 80 ? queryMessage.substring(0, 77) + '...' : queryMessage),
        _isGuideOffer: true
      };

      logger.debug(`[Node:Answer] Guide offer extracted from LLM response — surfacing as pendingQuestion`);

      // Re-emit the trimmed answer via streamCallback so UI doesn't show the question as text
      if (typeof streamCallback === 'function' && displayAnswer !== finalAnswer) {
        streamCallback('\x00REPLACE\x00' + displayAnswer);
      }
    }

    // ── Intent correction detection ───────────────────────────────────────────
    // If the user's current message is correcting a previous misclassification,
    // extract the wrong intent + correct intent and store an intent_override so
    // the same phrasing never misclassifies again.
    // Patterns: "no I meant command", "not a web search, go to the webpage",
    //           "I wanted you to open the browser", "that should have been automate"
    const CORRECTION_PATTERNS = /\b(no[,\s]+(i meant|i wanted|that should|that was supposed|it should|you should have)|not (a |an )?(web.?search|memory|search|lookup|look.?up)|i (meant|wanted you to|need you to)\s+(go to|open|navigate|automate|do it as|run it as)|that (should|was supposed to) (be|have been)\s+(a\s+)?(command|automate|browser|navigate))\b/i;

    if (CORRECTION_PATTERNS.test(queryMessage) && mcpAdapter && conversationHistory.length >= 2) {
      try {
        // Find the last user message before this one — that's the misclassified prompt
        const prevUserMsgs = conversationHistory.filter(m => m.role === 'user');
        const prevPrompt = prevUserMsgs.length > 0 ? prevUserMsgs[prevUserMsgs.length - 1]?.content : null;

        if (prevPrompt && prevPrompt !== queryMessage) {
          // Determine the correct intent from the correction text
          const correctionText = queryMessage.toLowerCase();
          let correctIntent = null;
          let wrongIntent = intent?.type || null;

          if (/\b(go to|open|navigate|browser|webpage|web page|automate|command|run it|do it)\b/.test(correctionText)) {
            correctIntent = 'command_automate';
          } else if (/\b(memory|remember|recall|history|what i did|what i was)\b/.test(correctionText)) {
            correctIntent = 'memory_retrieve';
          } else if (/\b(search|look up|web search|find online)\b/.test(correctionText)) {
            correctIntent = 'web_search';
          }

          if (correctIntent && correctIntent !== wrongIntent) {
            logger.info(`[Node:Answer] Intent correction detected: "${prevPrompt.slice(0, 60)}" was ${wrongIntent} → should be ${correctIntent}`);
            mcpAdapter.callAction('user-memory', 'intent_override.upsert', {
              examplePrompt: prevPrompt,
              correctIntent,
              wrongIntent,
              source: 'user_correction'
            }).then(() => {
              logger.info(`[Node:Answer] Intent override stored for future: "${prevPrompt.slice(0, 60)}" → ${correctIntent}`);
            }).catch(e => {
              logger.debug(`[Node:Answer] intent_override.upsert failed (non-fatal): ${e.message}`);
            });
          }
        }
      } catch (e) {
        logger.debug(`[Node:Answer] Correction detection failed (non-fatal): ${e.message}`);
      }
    }

    return {
      ...state,
      answer: displayAnswer,
      ...(pendingQuestion ? { pendingQuestion } : {}),
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

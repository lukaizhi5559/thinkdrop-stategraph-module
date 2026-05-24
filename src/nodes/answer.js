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
  // Prepend _dataPrefix (injected by multi-intent queue runner) when context from a prior
  // step should be visible to the answer LLM (e.g. memory result feeding into a follow-up).
  if (state._dataPrefix) {
    queryMessage = `${state._dataPrefix}\n\n${queryMessage}`;
  }
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

  // ─── Detect intermediate multi-intent pipeline step ─────────────────────────
  // When isMultiIntent=true and intentQueue still has remaining steps, this node
  // is executing an intermediate step (e.g. step 1 of 3). Injecting a structural
  // pipeline context block prevents the LLM from synthesising a false "I have
  // completed the task" answer before downstream steps have even run.
  const isIntermediatePipelineStep = !!(
    state.isMultiIntent &&
    Array.isArray(state.intentQueue) && state.intentQueue.length > 0
  );

  let pipelineContextBlock = '';
  if (isIntermediatePipelineStep) {
    const stepN = (state.intentResults?.length ?? 0) + 1;
    const stepM = stepN + state.intentQueue.length;
    const remainingDescriptions = state.intentQueue
      .map((s, i) => `  ${stepN + i + 1}. ${s.text || s.intent || 'next step'}`)
      .join('\n');
    pipelineContextBlock =
      `PIPELINE CONTEXT — Step ${stepN} of ${stepM}\n` +
      `You are executing step ${stepN} of a ${stepM}-step pipeline. More steps will follow.\n` +
      `Your ONLY job is to extract and report the data found in this step.\n` +
      `DO NOT claim the overall task is complete. DO NOT say "I have created...", "I have done...", "I successfully...", or similar completion phrases.\n` +
      `Remaining steps after this one:\n${remainingDescriptions}\n` +
      `Output: Return only the raw data found (URLs, file paths, IDs, content). Keep it factual and brief.\n\n`;
  }

  // ─── Build system instructions (intent-driven) ───────────────────────────────
  const intentType = intent?.type || 'question';

  const baseInstruction = ANSWER_PROMPTS?.base || 'Answer using the provided context. Be direct and natural.';
  let systemInstructions = `${langOverridePrefix}${pipelineContextBlock}${baseInstruction}\n\nContext:`;

  const contextSources = [];
  if (filteredMemories.length > 0) contextSources.push(`- ${filteredMemories.length} user memories`);
  if (contextDocs.length > 0) contextSources.push(`- ${contextDocs.length} web search results`);
  if (state.screenContext) contextSources.push('- Screen content analysis');
  if (conversationHistory.length > 0) contextSources.push(`- ${conversationHistory.length} conversation messages`);

  systemInstructions += contextSources.length > 0
    ? '\n' + contextSources.join('\n')
    : '\n- No additional context';

  // ── Inject conversation history for ambiguous follow-up interpretation ─────────
  // When _needsContextInterpretation is set (e.g., "what about them?" after file analysis),
  // OR when classifyTask identified this as a conversation follow-up (isFollowUp:true),
  // include the actual conversation history so LLM can resolve ambiguous references.
  // This is critical for queries like "check for me now" where the raw message has no topic
  // signal and the LLM must rely on prior turns to understand what is being asked.
  const _isConversationFollowUp = !!(state._taskClassification?.isFollowUp && state._taskClassification?.followUpTarget);
  if ((state._needsContextInterpretation || _isConversationFollowUp) && conversationHistory.length > 0) {
    const recentHistory = conversationHistory.slice(-5); // Last 5 messages
    const historyBlock = recentHistory.map((msg, i) => {
      const role = msg.role === 'assistant' ? 'ThinkDrop' : 'User';
      return `[${i + 1}] ${role}: ${msg.content?.substring(0, 300) || 'No content'}`;
    }).join('\n');
    systemInstructions += `\n\n=== RECENT CONVERSATION HISTORY ===\n${historyBlock}\n=== END HISTORY ===`;
  }

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
      systemInstructions += '\n- Answer using the provided Conversation History and Screen Activity & User Memories\n- The Conversation History contains the actual chat messages — use these to answer questions about past conversations\n- The Memories contain screen captures and activity — use these to answer questions about what the user was doing\n- Be specific: quote or summarize actual messages/topics from the history\n- Do NOT say you lack information if Conversation History or Memories are present in the prompt\n- When referencing specific memories, ALWAYS cite the date using the formattedDate field (e.g., "On March 8, 2026 at 7:04 PM (two days ago), you viewed...")\n- Each memory has a formattedDate with "absolute" (human-readable) and "relative" (e.g., "2 days ago") - use both for temporal context\n- IMPORTANT: Cite EACH memory individually with its specific timestamp. Do NOT aggregate multiple memories into time ranges like "between 5:24-7:35 PM".';
      
      // Inject formatted memories directly into system instructions so LLM sees them
      if (filteredMemories && filteredMemories.length > 0) {
        const memoryBlock = filteredMemories.map((mem, i) => {
          const date = mem.formattedDate?.absolute || mem.created_at || 'Unknown date';
          const rel = mem.formattedDate?.relative || '';
          return `[${i + 1}] ${date}${rel ? ' ' + rel : ''}: ${mem.text?.substring(0, 200) || 'No text'}`;
        }).join('\n');
        systemInstructions += `\n\n=== SCREEN ACTIVITY & MEMORIES ===\n${memoryBlock}\n=== END MEMORIES ===`;
      }
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

  // ─── Personality overlay injection ──────────────────────────────────────────
  // Fetches the live THINKDROP LIVE STATE block (mood + traits) from personality-service.
  // Appended BEFORE screen context so the LLM sees personality state at all times.
  // Falls back gracefully if personality-service is down — no breakage.
  try {
    const http = require('http');
    const personalityOverlay = await new Promise((resolve) => {
      const body = JSON.stringify({ version: 'mcp.v1', service: 'personality-service', action: 'personality.overlay', payload: {}, requestId: 'ans_' + Date.now() });
      const req = http.request({
        hostname: '127.0.0.1',
        port: parseInt(process.env.PERSONALITY_SERVICE_PORT || '3008', 10),
        path: '/personality.overlay',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { const p = JSON.parse(raw); resolve(p && p.data && p.data.overlay ? p.data.overlay : ''); } catch (_) { resolve(''); } });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.write(body);
      req.end();
    });
    if (personalityOverlay) {
      systemInstructions += `\n\n${personalityOverlay}`;
    }
  } catch (_personalityErr) {}

  // ─── Text-signal mood event emission (fire-and-forget) ──────────────────────
  // Analyzes the user's text for emotional cues and fires a mood event so that
  // text-path interactions shape ThinkDrop's emotional state just like voice does.
  try {
    const textSignalPath = path.join(__dirname, '../../../mcp-services/personality-service/src/text-signal.cjs');
    const textSignal = require(textSignalPath);
    const textEvt = textSignal.analyze(queryMessage, conversationHistory);
    if (textEvt && textEvt.event_type) {
      const http2 = require('http');
      const evtBody = JSON.stringify({
        version: 'mcp.v1', service: 'personality-service', action: 'personality.event',
        payload: { event_type: textEvt.event_type, source: 'text', reason: textEvt.reason },
        requestId: 'ans_evt_' + Date.now(),
      });
      const evtReq = http2.request({
        hostname: '127.0.0.1',
        port: parseInt(process.env.PERSONALITY_SERVICE_PORT || '3008', 10),
        path: '/personality.event', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(evtBody) },
        timeout: 3000,
      }, () => {});
      evtReq.on('error', () => {});
      evtReq.on('timeout', () => { evtReq.destroy(); });
      evtReq.write(evtBody);
      evtReq.end();
    }
  } catch (_textSignalErr) {}

  // ─── Surface system events (skill deletions, capability changes) ────────────
  // System messages (role:'system') are extracted from the history, injected into
  // systemInstructions as highest-priority facts, and excluded from the regular
  // conversation turns passed to phi4 (prevents them appearing as 'User:...' lines).
  const systemEvents = conversationHistory.filter(m => m.role === 'system');
  if (systemEvents.length > 0) {
    const eventLines = systemEvents.slice(-5).map(m => `  • ${(m.content || '').trim()}`);
    systemInstructions += `\n\n⚠️ SYSTEM EVENTS (treat as current facts — highest priority):\n${eventLines.join('\n')}`;
  }
  const filteredConversationHistory = conversationHistory.filter(m => m.role !== 'system');

  // ─── Workspace manifest injection (lightweight self-awareness) ──────────────
  // Reads ~/.thinkdrop/manifest.json if present and injects a compact summary
  // so ThinkDrop knows about its own capabilities when answering.
  try {
    const os = require('os');
    const manifestPath = path.join(os.homedir(), '.thinkdrop', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const mLines = [
        `\n═══ WORKSPACE MANIFEST ═══`,
        `Agents: ${manifest.agents?.count || 0}${manifest.agents?.items?.length ? ' (' + manifest.agents.items.join(', ') + ')' : ''}`,
        `Skills: ${manifest.skills?.count || 0}`,
        `Context rules: ${manifest.contextRules?.count || 0}`,
        `Databases: ${(manifest.databases || []).filter(d => d.exists).map(d => d.name).join(', ') || 'none'}`,
        `Apps: ${manifest.applications?.length || 0}`,
      ];
      systemInstructions += mLines.join('\n');
    }
  } catch (_manifestErr) {}

  // Inject screen context into system instructions (not into the user query)
  if (state.context && typeof state.context === 'string') {
    const truncated = state.context.length > 6000
      ? state.context.substring(0, 6000) + '\n...(truncated)'
      : state.context;
    systemInstructions += `\n\n${truncated}`;
  }

  // Inject introspection context from executeIntrospect node
  if (state._forceAnswerContext && typeof state._forceAnswerContext === 'string') {
    systemInstructions += `\n\n${state._forceAnswerContext}`;
    systemInstructions += '\n\nIMPORTANT: Summarize the introspection data above in a helpful, conversational way. Use counts, names, and status info. Do NOT dump raw JSON.';
  }

  // Inject profile fallback from retrieveMemory (personal attribute queries)
  if (state._profileFallback && state._profileFallback.value) {
    const pf = state._profileFallback;
    systemInstructions += `\n\n## User Profile Data\nThe user's ${pf.key.replace(/_/g, ' ')} is: ${pf.value}\nAnswer their question using this profile data naturally and conversationally.`;
  }

  // ─── Anti-Hallucination Rules ───────────────────────────────────────────────
  // Prevent LLM from inventing fake URLs when real ones aren't available
  systemInstructions += `\n\n⚠️ CRITICAL ANTI-HALLUCINATION RULES:\n`;
  systemInstructions += `- If asked to provide video URLs (YouTube, etc.) but the search results/memories contain NO actual video links, you MUST say you cannot find the URLs.\n`;
  systemInstructions += `- Do NOT invent or hallucinate fake YouTube URLs like https://www.youtube.com/watch?v=dQw4w9WgXcQ or any other made-up links.\n`;
  systemInstructions += `- A honest "I couldn't find the video URLs" is infinitely better than fabricated links that lead to the wrong content.\n`;
  systemInstructions += `- Only include URLs that are actually present in the provided search results or memories above.`;

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
      conversationHistory: isCommandWithOutput ? [] : filteredConversationHistory,
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

    // ── Anti-Hallucination: Detect fake YouTube URLs ────────────────────────────
    // If answer contains YouTube URLs that weren't in web search results or memories,
    // the LLM is hallucinating. Replace with honest failure message.
    const _YOUTUBE_URL_REGEX = /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/g;
    const _answerUrls = finalAnswer.match(_YOUTUBE_URL_REGEX) || [];
    
    if (_answerUrls.length > 0) {
      // Build set of real YouTube URLs from context
      const _realUrls = new Set();
      // From web search results
      if (contextDocs && contextDocs.length > 0) {
        contextDocs.forEach(doc => {
          if (doc.url && doc.url.includes('youtube.com/watch')) {
            _realUrls.add(doc.url);
          }
          // Also check content
          const contentUrls = (doc.text || '').match(_YOUTUBE_URL_REGEX) || [];
          contentUrls.forEach(url => _realUrls.add(url));
        });
      }
      // From memories
      if (filteredMemories && filteredMemories.length > 0) {
        filteredMemories.forEach(mem => {
          const memUrls = (mem.text || '').match(_YOUTUBE_URL_REGEX) || [];
          memUrls.forEach(url => _realUrls.add(url));
        });
      }
      
      // Find hallucinated URLs (in answer but not in context)
      const _hallucinatedUrls = _answerUrls.filter(url => !_realUrls.has(url));
      
      if (_hallucinatedUrls.length > 0) {
        logger.error(`[Node:Answer] LLM hallucinated ${_hallucinatedUrls.length} fake YouTube URL(s): ${_hallucinatedUrls.join(', ')}`);
        // Replace with honest failure - but preserve any real context
        const _hasRealVideoContent = _realUrls.size > 0;
        finalAnswer = `⚠️ **Search Issue Detected**: The system found workout video titles but could not extract their actual YouTube URLs from the search results.

${_hasRealVideoContent ? 'Some video links were found, but others appear to be incorrect. ' : ''}The search results may have contained:
- YouTube's search page structure that the browser couldn't parse
- Results requiring login to view
- Dynamic content that wasn't captured

Please try asking: "help me track down the video links for each one of these workouts" to trigger browser automation that can extract the actual URLs.`;
        
        // Re-stream the corrected answer if streaming
        if (isStreaming && typeof streamCallback === 'function') {
          streamCallback('\x00REPLACE\x00' + finalAnswer);
        }
      }
    }

    // In non-streaming mode, still emit via streamCallback so UI receives it
    if (!isStreaming && typeof streamCallback === 'function' && finalAnswer) {
      streamCallback(finalAnswer);
    }

    // ── Emit search sources so ResultsWindow can render the favicon pill ─────
    // Uses the \x00SOURCES\x00 sentinel (same channel as \x00REPLACE\x00).
    // Only fires when the answer was grounded in web search results.
    if (typeof streamCallback === 'function' && contextDocs.length > 0) {
      const sources = contextDocs
        .filter(d => d.url && d.url.startsWith('http'))
        .slice(0, 10)
        .map(d => {
          let hostname = '';
          try { hostname = new URL(d.url).hostname.replace(/^www\./, ''); } catch (_) {}
          return { url: d.url, title: d.text?.split('\n')[0]?.trim() || hostname, hostname };
        });
      if (sources.length > 0) {
        streamCallback('\x00SOURCES\x00' + JSON.stringify(sources));
      }
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
      // Strip the separator + question from the displayed answer (guide offer card disabled)
      displayAnswer = finalAnswer.slice(0, finalAnswer.lastIndexOf(match[0])).trimEnd();

      // Re-emit the trimmed answer via streamCallback so UI doesn't show the question as text
      if (typeof streamCallback === 'function' && displayAnswer !== finalAnswer) {
        streamCallback('\x00REPLACE\x00' + displayAnswer);
      }
    }

    // ── Intent correction detection ───────────────────────────────────────────
    // If the user's current message is correcting a previous misclassification,
    // use the LLM to infer the correct intent and store an intent_override so
    // the same phrasing never misclassifies again.
    // Fire-and-forget — never blocks the answer from returning.
    const _CORRECTION_SIGNAL = /\b(no[,\s]+(i meant|i wanted|that should|that was supposed)|not (a |an )?(web.?search|memory|search|lookup)|i (meant|wanted you to|need you to)\s+\w|that (should|was supposed to) (be|have been))\b/i;

    if (_CORRECTION_SIGNAL.test(queryMessage) && mcpAdapter && backend && conversationHistory.length >= 2) {
      try {
        const prevUserMsgs = conversationHistory.filter(m => m.role === 'user');
        const prevPrompt = prevUserMsgs.length > 0 ? prevUserMsgs[prevUserMsgs.length - 1]?.content : null;

        if (prevPrompt && prevPrompt !== queryMessage) {
          const wrongIntent = intent?.type || null;
          // Fire-and-forget LLM call — does not block answer
          (async () => {
            try {
              const correctionPrompt = `The user is correcting a previous AI misclassification.

Previous user message: "${prevPrompt}"
Current correction: "${queryMessage}"
Previous intent classification: "${wrongIntent}"

What is the CORRECT intent for the previous message? Choose one:
- command_automate (browse, navigate, open app, run command, file operation)
- memory_retrieve (recall stored info, what did I, look up my records)
- memory_store (remember this, save this fact)
- web_search (search online, look up on web)
- general_knowledge (question, explain, what is)

Respond with ONLY valid JSON: {"correctIntent":"<intent>"}`;

              const raw = await backend.generateAnswer(correctionPrompt, {
                context: { systemInstructions: 'You are an intent classifier. Respond with ONLY valid JSON.' },
              }, { maxTokens: 30, temperature: 0, fastMode: true });

              const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
              const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
              if (!jsonMatch) return;
              const parsed = JSON.parse(jsonMatch[0]);
              const correctIntent = parsed.correctIntent;

              if (correctIntent && correctIntent !== wrongIntent) {
                logger.info(`[Node:Answer] LLM correction: "${prevPrompt.slice(0, 60)}" was ${wrongIntent} → ${correctIntent}`);
                mcpAdapter.callService('user-memory', 'intent_override.upsert', {
                  examplePrompt: prevPrompt,
                  correctIntent,
                  wrongIntent,
                  source: 'user_correction',
                }).then(() => {
                  logger.info(`[Node:Answer] Intent override stored: "${prevPrompt.slice(0, 60)}" → ${correctIntent}`);
                }).catch(e => {
                  logger.debug(`[Node:Answer] intent_override.upsert failed (non-fatal): ${e.message}`);
                });
              }
            } catch (e) {
              logger.debug(`[Node:Answer] LLM correction detection failed (non-fatal): ${e.message}`);
            }
          })();
        }
      } catch (e) {
        logger.debug(`[Node:Answer] Correction detection setup failed (non-fatal): ${e.message}`);
      }
    }

    return {
      ...state,
      answer: displayAnswer,
      _answerStreamed: isStreaming,
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

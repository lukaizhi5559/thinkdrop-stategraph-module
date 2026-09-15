'use strict';

/**
 * resolveReferencesV2
 *
 * Slim rewrite — removes all regex-based coreference logic and the Python
 * coreference service call. Single responsibility:
 *   1. Fetch conversation history from the conversation service
 *   2. Attach it to state.conversationHistory for all downstream nodes
 *   3. Run classifyTask once and attach state._taskClassification for all downstream nodes
 *   4. Pass the user message through verbatim
 *
 * Context resolution ("that folder", "it", "the result") is handled via
 * _taskClassification.followUpTarget (LLM-resolved) so no node needs regex.
 */

const { classifyTask } = require('../utils/classifyTask');

/**
 * Binary web-access confirmation — runs only when classifyTask returns
 * webAccessMode='interactive' but interactiveActions is empty (the LLM said
 * interactive without naming a single action). Returns 0 (public_read) or
 * 1 (interactive). Fails safe to 1 (keep interactive) on any error so a real
 * interactive task is never wrongly downgraded.
 *
 * Uses maxTokens:1 + temperature:0 for the most stable possible LLM output.
 */
async function _confirmWebAccessMode(userMessage, llmBackend, logger) {
  if (!llmBackend || !userMessage) return 1;
  try {
    const prompt = `Does this prompt require a browser session with login, account access, or form submission — or can it be completed with public web search/crawl?

Prompt: "${userMessage}"

Answer ONLY "0" (public_read — search, browse, read, download) or "1" (interactive — login, account, form, cart, post, send, play).`;
    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: 'Answer with a single digit: 0 or 1.' },
    }, { maxTokens: 1, temperature: 0, fastMode: true, taskType: 'classification' });
    const text = typeof raw === 'string' ? raw : (raw?.text || raw?.content || '');
    const answer = text.trim();
    logger.info(`[Node:ResolveReferencesV2] binary confirmation raw="${answer}"`);
    return answer === '0' ? 0 : 1;
  } catch (e) {
    logger.warn(`[Node:ResolveReferencesV2] binary confirmation failed: ${e.message} — keeping interactive`);
    return 1;
  }
}

function stripHtml(text) {
  return text ? text.replace(/<[^>]*>/g, '') : text;
}

// ── Fetch recent screen context from the background monitor heartbeat ───────────────────
// The user-memory monitor runs every 5s, capturing screen OCR on window change or pixel diff.
// memory.getRecentOcr returns the freshest capture within maxAgeSeconds — always current.
// Falls back to the static last-screen-context.json file if the MCP call fails.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

async function getRecentMonitorCapture(mcpAdapter, logger) {
  // Primary: live monitor via user-memory MCP (max 5s stale)
  if (mcpAdapter) {
    try {
      const result = await mcpAdapter.callService('user-memory', 'memory.getRecentOcr', {
        maxAgeSeconds: 300, // 5 minutes — generous; monitor fires every 5s
      });
      const data = result?.data || result;
      if (data?.available && data?.capture) {
        const c = data.capture;
        return {
          timestamp:   c.capturedAt   || c.created_at || new Date().toISOString(),
          appName:     c.appName      || null,
          windowTitle: c.windowTitle  || null,
          category:    c.category     || 'other',
          url:         c.url          || null,
          contextText: c.text         || null,
        };
      }
    } catch (err) {
      logger.debug(`[Node:ResolveReferencesV2] memory.getRecentOcr unavailable: ${err.message}`);
    }
  }
  // Fallback: static file written by logConversation after explicit screen_intelligence turns
  try {
    const screenFile = path.join(os.homedir(), '.thinkdrop', 'last-screen-context.json');
    if (!fs.existsSync(screenFile)) return null;
    const raw = fs.readFileSync(screenFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.timestamp) return null;
    const ageMs = Date.now() - new Date(parsed.timestamp).getTime();
    if (ageMs > 30 * 60 * 1000) return null; // 30min TTL for the fallback file
    return parsed;
  } catch (_) {
    return null;
  }
}

module.exports = async function resolveReferencesV2(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;

  // ── skill_build pass-through ───────────────────────────────────────────────
  if (state.skillBuildRequest && state.intent?.type === 'skill_build') {
    return state;
  }

  if (!mcpAdapter) {
    return { ...state, resolvedMessage: message, originalMessage: message, conversationHistory: [] };
  }

  // ── Surface progress: this is the first node in the graph, so the user sees
  // this message while we fetch conversation history + run classifyTask.
  // Skip for plan execution runs — the user already approved the plan and the UI
  // is already in 'executing' state (optimistic transition). A 'planning' event
  // here would reset the UI to "Understanding your request...".
  if (state.progressCallback && !state._planFile) {
    try { state.progressCallback({ type: 'planning', message: 'Understanding your request…' }); }
    catch (_) { /* progress callback must never block execution */ }
  }

  // ── Fetch conversation history (sliding window) ────────────────────────────
  let conversationHistory = [];
  try {
    let sessionId = context?.sessionId;

    if (!sessionId) {
      try {
        // No sessionId provided — create/route to a new session
        // (session selection via semantic matching is now done in main.js before graph execution)
        const routeResult = await mcpAdapter.callService('conversation', 'session.route', { text: message });
        sessionId = (routeResult.data || routeResult)?.sessionId || null;
        
        if (sessionId) {
          const sessionAction = (routeResult.data || routeResult)?.action || 'unknown';
          logger.info(`[Node:ResolveReferencesV2] Got session: ${sessionId} (action: ${sessionAction})`);
          if (!state.context) state.context = {};
          state.context.sessionId = sessionId;
        }
      } catch (_) {}
    } else {
      logger.info(`[Node:ResolveReferencesV2] Using pre-resolved sessionId from context: ${sessionId}`);
    }

    if (sessionId) {
      // Fetch in parallel: recent window (handles coreferences like "that"/"it")
      // + cross-session semantic matches (finds older relevant messages buried
      // under recent unrelated ones, including from rotated sessions).
      const [histResult, searchResult] = await Promise.all([
        mcpAdapter.callService('conversation', 'message.list', {
          sessionId,
          limit: 20,
          direction: 'DESC',
        }),
        mcpAdapter.callService('conversation', 'message.search', {
          sessionId,
          query: message,
          limit: 15,
          includeRecent: 0, // recent messages are already covered by message.list
          minSimilarity: 0.3,
          searchAllSessions: true,
        }).catch(() => null), // best-effort — semantic search is non-blocking
      ]);

      // Recent window (handles coreferences: "that", "it", "yes do it")
      const histData = histResult.data || histResult;
      const recentMessages = (histData.messages || [])
        .filter(msg => msg.sender !== 'system')
        .map(msg => ({
          id: msg.id,
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: stripHtml(msg.text || msg.content || ''),
          timestamp: msg.timestamp,
          source: 'recent',
        }))
        .reverse();

      // Semantic matches (older relevant messages from any session)
      let semanticMessages = [];
      if (searchResult) {
        const searchData = searchResult.data || searchResult;
        semanticMessages = (searchData.messages || [])
          .filter(msg => msg.sender !== 'system')
          .map(msg => ({
            id: msg.id,
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: stripHtml(msg.text || msg.content || ''),
            timestamp: msg.timestamp,
            source: 'semantic',
            sessionTitle: msg.sessionTitle,
          }));
      }

      // Merge: deduplicate by message ID, recent first then semantic
      const seenIds = new Set();
      conversationHistory = [...recentMessages, ...semanticMessages].filter(msg => {
        if (msg.id && seenIds.has(msg.id)) return false;
        if (msg.id) seenIds.add(msg.id);
        return true;
      });

      logger.debug(`[Node:ResolveReferencesV2] Context: ${recentMessages.length} recent + ${semanticMessages.length} semantic = ${conversationHistory.length} total`);
    }
  } catch (err) {
    logger.debug('[Node:ResolveReferencesV2] Could not fetch history, proceeding without:', err.message);
  }

  // ── Load prior screen context — prefer live monitor heartbeat, fallback to file ──────
  let _priorScreenContext = await getRecentMonitorCapture(mcpAdapter, logger);
  if (_priorScreenContext) {
    const ageMin = Math.round((Date.now() - new Date(_priorScreenContext.timestamp).getTime()) / 60000);
    logger.debug(`[Node:ResolveReferencesV2] Prior screen context available (${ageMin} min old): ${_priorScreenContext.appName || 'unknown app'}`);
  }

  // Build a compact summary string for the classifyTask LLM prompt + downstream planning nodes
  let priorScreenSummary = null;
  let _screenContextNote = null;
  if (_priorScreenContext) {
    const ageMin = Math.round((Date.now() - new Date(_priorScreenContext.timestamp).getTime()) / 60000);
    const parts = [];
    if (_priorScreenContext.appName)     parts.push(`App: ${_priorScreenContext.appName}`);
    if (_priorScreenContext.category && _priorScreenContext.category !== 'other') parts.push(`Category: ${_priorScreenContext.category}`);
    if (_priorScreenContext.windowTitle) parts.push(`Window: "${_priorScreenContext.windowTitle}"`);
    if (_priorScreenContext.url)         parts.push(`URL: ${_priorScreenContext.url}`);
    priorScreenSummary = `PRIOR SCREEN CONTEXT (captured ${ageMin} min ago): ${parts.join(', ')}`;
    _screenContextNote = `ACTIVE SCREEN (${ageMin} min ago): ${parts.join(', ')}`;
  }

  // ── Fetch canonical active-app context BEFORE classification ────────────────
  // memory.getActiveAppContext returns the current active app + open file path,
  // falling back to the previous non-overlay app when ThinkDrop/voice-companion
  // is frontmost. We fetch it BEFORE classifyTask so the classifier LLM can
  // resolve deictic references ("this file", "it") against the live active file
  // instead of stale conversation history.
  let _activeAppContext = null;
  if (mcpAdapter) {
    try {
      const ctxResult = await mcpAdapter.callService('user-memory', 'memory.getActiveAppContext', {});
      const ctxData = ctxResult?.data || ctxResult;
      const app = ctxData?.app;
      if (app) {
        _activeAppContext = app;
        const parts = [];
        if (app.appName)     parts.push(`App: ${app.appName}`);
        if (app.category && app.category !== 'other') parts.push(`Category: ${app.category}`);
        if (app.windowTitle) parts.push(`Window: "${app.windowTitle}"`);
        if (app.url)         parts.push(`URL: ${app.url}`);
        if (app.filePath)    parts.push(`File: ${app.filePath}`);
        const source = app.source || 'live';
        const ageMin = app.timestamp ? Math.round((Date.now() - new Date(app.timestamp).getTime()) / 60000) : 0;
        _screenContextNote = `ACTIVE SCREEN (${source}, ${ageMin} min ago): ${parts.join(', ')}`;
        // Also update _priorScreenContext so downstream nodes see the enriched data
        _priorScreenContext = {
          ...(_priorScreenContext || {}),
          appName: app.appName,
          category: app.category,
          windowTitle: app.windowTitle,
          url: app.url,
          filePath: app.filePath,
          timestamp: app.timestamp || (_priorScreenContext?.timestamp || new Date().toISOString()),
          source,
        };
        logger.debug(`[Node:ResolveReferencesV2] Active app context (${source}): ${app.appName} ${app.filePath ? `file=${app.filePath}` : '(no file)'}`);
      }
    } catch (err) {
      logger.debug(`[Node:ResolveReferencesV2] memory.getActiveAppContext unavailable: ${err.message}`);
    }
  }

  // ── Classify task once — all downstream nodes read from _taskClassification ──────────
  // This replaces per-node NLU regex (BYPASS_PATTERNS, _LOCAL_ACTION_VERBS, etc.)
  // Skip for plan execution runs — the plan already has all steps, so the 15+ second
  // LLM classification call is unnecessary. planExecutor/planSkills don't need it.
  // Pass _activeAppContext so the classifier can resolve "this file" → the live
  // open file path instead of a stale followUpTarget from conversation history.
  //
  // GATE: Only inject active app context when the message explicitly references a
  // file/code artifact. The classifier's "ACTIVE APP CONTEXT PRIORITY" rule resolves
  // ANY deictic reference ("it", "this", "that") to the IDE's open file — even when
  // "it" refers to a conversational subject (a folder, a result, a topic). This caused
  // task_1d44cd52 to resolve followUpTarget to skillThinking.js (the IDE's open file)
  // instead of the basement project context. Generic deictics alone are insufficient.
  const _FILE_REF_RE = /\b(?:this|that|the|open|current|active)\s+(?:file|script|code|function|class|method|component|module)\b|\b(?:this|that|the)\s+\w+\.(?:ts|js|tsx|jsx|py|cjs|mjs|md|json|sh|bash)\b|\b(?:open|current|active)\s+(?:file|tab|editor|buffer)\b/i;
  const _hasFileRef = _FILE_REF_RE.test(message || '');
  let _taskClassification;
  if (state._planFile) {
    // Plan execution: skip the expensive LLM classification, but preserve the
    // original webAccessMode (public_read/download) so downstream nodes like
    // executeCommand can still make mode-aware decisions.
    _taskClassification = {
      taskType: 'ambiguous', isFollowUp: false, followUpTarget: null,
      needsClarification: false, targetService: null, isRecurring: false,
      isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
      needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
      isImageAnalysis: false, isConversationRecall: false,
      interactiveActions: [],
      webAccessMode: state._taskClassification?.webAccessMode || null,
    };
  } else {
    _taskClassification = await classifyTask(
      message,
      conversationHistory,
      state.llmBackend || null,
      logger,
      priorScreenSummary,
      _hasFileRef ? _activeAppContext : null,
    );
  }
  logger.debug(`[Node:ResolveReferencesV2] taskClassification: ${JSON.stringify(_taskClassification)}`);

  // ── Validate classifier-resolved file paths ──────────────────────────────────
  // The classifier can hallucinate paths from chat history (e.g. a screenshot
  // timestamp that doesn't correspond to any real file). fs.existsSync-check any
  // followUpTarget that looks like a path before injecting it downstream.
  // Drop + log if it doesn't exist — never pass a hallucinated path to the planner.
  if (_taskClassification.followUpTarget && typeof _taskClassification.followUpTarget === 'string') {
    const t = _taskClassification.followUpTarget.trim();
    if (t.startsWith('/') && /\.\w{1,10}$/.test(t)) {
      try {
        if (!fs.existsSync(t)) {
          logger.warn(`[Node:ResolveReferencesV2] followUpTarget path does not exist — dropping: "${t}"`);
          _taskClassification.followUpTarget = null;
          // The screen OCR that the classifier used to set isScreenFollowUp is from
          // the same stale context — if the followUpTarget it produced doesn't exist,
          // the OCR is also stale and should not be injected by StateGraphBuilder.
          if (_taskClassification.isScreenFollowUp) {
            logger.info(`[Node:ResolveReferencesV2] Clearing isScreenFollowUp — followUpTarget was stale (file deleted), screen OCR is also stale`);
            _taskClassification.isScreenFollowUp = false;
          }
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  // ── Post-classification guard ──────────────────────────────────────────────
  // If webAccessMode is 'interactive' but the LLM couldn't name a single
  // interactive action (interactiveActions is empty), run a focused binary
  // confirmation call. The LLM sometimes sets requiresDOM:true for simple site
  // searches ("search eBay for X") — this catches that without regex.
  // Fails safe: keeps interactive on any error (never blocks a real interactive task).
  if (_taskClassification.webAccessMode === 'interactive' &&
      _taskClassification.taskType === 'browser' &&
      Array.isArray(_taskClassification.interactiveActions) &&
      _taskClassification.interactiveActions.length === 0) {
    logger.info('[Node:ResolveReferencesV2] interactive mode with no listed actions — running binary confirmation');
    const _confirm = await _confirmWebAccessMode(message, state.llmBackend || null, logger);
    if (_confirm === 0) {
      _taskClassification.webAccessMode = 'public_read';
      _taskClassification.requiresDOM = false;
      logger.info('[Node:ResolveReferencesV2] binary confirmation: 0 → downgraded to public_read');
    } else {
      logger.info('[Node:ResolveReferencesV2] binary confirmation: 1 → keeping interactive');
    }
  }

  return {
    ...state,
    resolvedMessage:        message,
    originalMessage:        message,
    conversationHistory,
    _taskClassification,
    _priorScreenContext:    _priorScreenContext || null,
    _screenContextNote:     _screenContextNote || null,
    coreferenceMethod:      'none',
    coreferenceReplacements: [],
  };
};

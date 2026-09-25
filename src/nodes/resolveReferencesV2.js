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

const { classifyTask, deriveResolution } = require('../utils/classifyTask');
// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
const { REFERENTIAL_RE, FILE_WRITE_VERB_RE } = require('../utils/textPatterns.cjs');

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

// REFERENTIAL_RE — canonical in shared/text-patterns.cjs. Deictic/referential
// words almost always point at a prior task's RESULT ("email me these addresses").

// Fetch the last assistant "result" message from each contributing session.
// Semantic message search ranks individual messages, and the task RESULT (the
// assistant synthesis carrying the actual data, e.g. store addresses) often
// never ranks — only user prompts do. Referents almost always mean the result,
// so we pull each matched session's last synthesis explicitly.
async function _collectSessionResults(mcpAdapter, sessionIds, currentSessionId, logger) {
  const uniq = [...new Set(sessionIds)]
    .filter(id => id && id !== currentSessionId)
    .slice(0, 3);
  const results = [];
  await Promise.all(uniq.map(async (sid) => {
    try {
      const res = await mcpAdapter.callService('conversation', 'message.list', {
        sessionId: sid, limit: 10, direction: 'DESC',
      });
      const msgs = ((res?.data || res)?.messages || [])
        .filter(m => m.sender === 'assistant');
      if (msgs.length === 0) return;
      const synth = msgs.find(m => /Step outputs:|\[synthesize\]:/i.test(m.text || m.content || '')) || msgs[0];
      results.push({
        id: synth.id,
        role: 'assistant',
        content: stripHtml(synth.text || synth.content || ''),
        timestamp: synth.timestamp,
        source: 'semantic-result',
        sessionId: sid,
        sessionTitle: synth.sessionTitle,
      });
    } catch (_) { /* best-effort enrichment */ }
  }));
  return results;
}

// Merge recent + semantic conversation messages into one chronological list.
// Sorting is REQUIRED: downstream consumers take slice(-N) for "recent"
// context — appending semantic matches at the tail poisons those slices with
// stale cross-session messages (observed: an "email me these addresses"
// follow-up saw 5 old-session turns and lost the actual addresses from the
// prior turn). Semantic messages keep source:'semantic' so consumers can
// also surface them under a separate labeled section.
function _mergeConversationHistory(recentMessages = [], semanticMessages = []) {
  const seenIds = new Set();
  const merged = [...recentMessages, ...semanticMessages].filter(msg => {
    if (msg.id && seenIds.has(msg.id)) return false;
    if (msg.id) seenIds.add(msg.id);
    return true;
  });
  merged.sort((a, b) =>
    (+new Date(a.timestamp || 0) || 0) - (+new Date(b.timestamp || 0) || 0)
  );
  return merged;
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

// Message rows may carry metadata as an object or a JSON string depending on
// the transport path — normalize once.
function _msgMeta(msg) {
  const md = msg?.metadata;
  if (!md) return null;
  if (typeof md === 'string') { try { return JSON.parse(md); } catch (_) { return null; } }
  return md;
}

module.exports = async function resolveReferencesV2(state) {
  const { mcpAdapter, context } = state;
  const logger = state.logger || console;
  let message = state.message;

  // ── Proactive-card reply handling ──────────────────────────────────────────
  // The renderer auto-attaches the tail Thought card as "[Thought: …]" text AND
  // sends it as structured thoughtContext. Split them: every downstream node
  // (session.route, message.search, classifyTask, webSearch, planning, logging)
  // works on the reply-only text — the card blob must never leak into search
  // queries or intent decomposition. The card itself joins conversationHistory
  // below as a LABELED turn so the classifier can weigh it against real turns.
  // [Context:] isolation wins — a message can never legitimately carry both.
  let _thoughtCtx = state._thoughtAttachment || context?.thoughtContext || null;
  const _hasContextTag = /\[Context:/.test(message || '');
  if (!_thoughtCtx && /^\s*\[Thought:/.test(message || '')) {
    // Metadata-less path (legacy input / log replay) — structural tag parse.
    const m = String(message).match(/^\s*\[Thought:([\s\S]*?)\]\s*/);
    if (m) _thoughtCtx = { id: null, text: m[1].trim(), tag: m[0] };
  }
  if (_thoughtCtx) {
    const replyOnly = _thoughtCtx.tag
      ? String(message).replace(_thoughtCtx.tag, '').trim()
      : String(message).replace(/^\s*\[Thought:[\s\S]*?\]\s*/, '').trim();
    message = replyOnly || message; // keep the tag if the reply itself is empty
    if (_hasContextTag) _thoughtCtx = null; // isolation wins — tag stripped, card ignored
  }

  // ── skill_build pass-through ───────────────────────────────────────────────
  if (state.skillBuildRequest && state.intent?.type === 'skill_build') {
    return state;
  }

  if (!mcpAdapter) {
    return { ...state, resolvedMessage: message, originalMessage: message, conversationHistory: [], semanticHistory: [] };
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
  let semanticHistory = [];
  try {
    let sessionId = context?.sessionId;
    // Isolated-context sessions (iso_* from a [Context:] chip) must not pull
    // any conversation history — isolation is the whole point. The semantic
    // search below queries ALL sessions, so it would leak prior context in.
    const _isIsolatedSession = String(sessionId || '').startsWith('iso_');

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

    if (sessionId && _isIsolatedSession) {
      logger.info(`[Node:ResolveReferencesV2] Isolated session ${sessionId} — skipping conversation history + semantic search`);
    }

    if (sessionId && !_isIsolatedSession) {
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
        .map(msg => {
          const md = _msgMeta(msg);
          // Persisted Thought cards ride in history as assistant rows — flag
          // them so the classifier renders them labeled as cards (same label
          // as the live-injected 'thought-attachment' turn).
          const isCard = msg.sender === 'assistant' && md?.source === 'thought_engine';
          return {
            id: msg.id,
            role: msg.sender === 'user' ? 'user' : 'assistant',
            content: stripHtml(msg.text || msg.content || ''),
            timestamp: msg.timestamp,
            source: 'recent',
            ...(isCard ? { isThoughtCard: true, thoughtId: md.thoughtId || null } : {}),
          };
        })
        .reverse();

      // Empty-session fallback: the routed session has no messages (new or just
      // rotated), so the immediately-preceding turn lives in another session.
      // Pull the most recent other session's tail so elliptical follow-ups
      // ("how many unread") still resolve against the real prior turn instead
      // of only stale cross-session semantic matches.
      let priorSessionMessages = [];
      if (recentMessages.length === 0) {
        try {
          const sessRes = await mcpAdapter.callService('conversation', 'session.list', { limit: 5 });
          const sessions = (sessRes?.data || sessRes)?.sessions || [];
          const prevSid = sessions
            .map(s => s.id || s.sessionId)
            .find(id => id && id !== sessionId);
          if (prevSid) {
            const res = await mcpAdapter.callService('conversation', 'message.list', {
              sessionId: prevSid, limit: 8, direction: 'DESC',
            });
            priorSessionMessages = (((res?.data || res)?.messages) || [])
              .filter(m => m.sender !== 'system')
              .map(m => {
                const md = _msgMeta(m);
                const isCard = m.sender === 'assistant' && md?.source === 'thought_engine';
                return {
                  id: m.id,
                  role: m.sender === 'user' ? 'user' : 'assistant',
                  content: stripHtml(m.text || m.content || ''),
                  timestamp: m.timestamp,
                  source: 'prior-session',
                  sessionId: prevSid,
                  ...(isCard ? { isThoughtCard: true, thoughtId: md.thoughtId || null } : {}),
                };
              })
              .reverse();
            if (priorSessionMessages.length > 0) {
              logger.debug(`[Node:ResolveReferencesV2] Empty session — pulled ${priorSessionMessages.length} prior-session message(s) from ${prevSid}`);
            }
          }
        } catch (_) { /* best-effort enrichment */ }
      }

      // Semantic matches (older relevant messages from any session)
      let semanticMessages = [];
      if (searchResult) {
        const searchData = searchResult.data || searchResult;
        semanticMessages = (searchData.messages || [])
          .filter(msg => msg.sender !== 'system')
          .map(msg => {
            const md = _msgMeta(msg);
            const isCard = msg.sender === 'assistant' && md?.source === 'thought_engine';
            return {
              id: msg.id,
              role: msg.sender === 'user' ? 'user' : 'assistant',
              content: stripHtml(msg.text || msg.content || ''),
              timestamp: msg.timestamp,
              source: 'semantic',
              sessionId: msg.sessionId,
              sessionTitle: msg.sessionTitle,
              ...(isCard ? { isThoughtCard: true, thoughtId: md.thoughtId || null } : {}),
            };
          });
      }

      // Session-result enrichment: pull each contributing session's last
      // assistant synthesis so the actual task RESULT is in context, not just
      // the matching user prompts. For referential messages with no semantic
      // matches, fall back to the immediately-previous session (covers
      // similarity-threshold misses like "email me these addresses").
      let sessionResults = await _collectSessionResults(
        mcpAdapter, semanticMessages.map(m => m.sessionId), sessionId, logger);
      if (sessionResults.length === 0 && priorSessionMessages.length === 0 && REFERENTIAL_RE.test(message || '')) {
        try {
          const sessRes = await mcpAdapter.callService('conversation', 'session.list', { limit: 5 });
          const sessions = (sessRes?.data || sessRes)?.sessions || [];
          const prevSid = sessions
            .map(s => s.id || s.sessionId)
            .find(id => id && id !== sessionId);
          if (prevSid) {
            sessionResults = await _collectSessionResults(mcpAdapter, [prevSid], sessionId, logger);
          }
        } catch (_) { /* best-effort enrichment */ }
      }
      if (sessionResults.length > 0) {
        semanticMessages = [...semanticMessages, ...sessionResults];
        logger.debug(`[Node:ResolveReferencesV2] Session-result enrichment: +${sessionResults.length} assistant result(s)`);
      }
      if (priorSessionMessages.length > 0) {
        semanticMessages = [...priorSessionMessages, ...semanticMessages];
      }

      // Merge: deduplicate by message ID, then sort chronologically.
      conversationHistory = _mergeConversationHistory(recentMessages, semanticMessages);

      // Card reply: the attached Thought was already persisted as an assistant
      // row at delivery (thought-engine writes it) — when that row is present
      // it IS the card turn (adopt its thoughtId); only inject a synthetic
      // labeled turn when the row isn't in the fetched window. Either way the
      // attached card gets `attachedToMessage` — it was on screen when the user
      // sent this message, making it the privileged referent candidate.
      if (_thoughtCtx?.text) {
        const _norm = s => String(s || '').replace(/\s+/g, ' ').trim();
        const _row = conversationHistory.find(m => m.isThoughtCard && _norm(m.content) === _norm(_thoughtCtx.text));
        if (_row) {
          _row.attachedToMessage = true;
          if (!_thoughtCtx.id && _row.thoughtId) _thoughtCtx.id = _row.thoughtId;
        } else {
          conversationHistory.push({
            role: 'assistant',
            content: _thoughtCtx.text,
            timestamp: new Date().toISOString(),
            source: 'thought-attachment',
            isThoughtCard: true,
            attachedToMessage: true,
            thoughtId: _thoughtCtx.id || null,
          });
        }
      }

      // Thought-nudge cap: silence-nudge cards pile up as persisted rows and
      // bury real turns in the context window. Keep only the newest 3 card
      // rows (always retaining the attached card); transcript is untouched —
      // this only trims the classifier/answer context.
      {
        const _cards = conversationHistory.filter(m => m.isThoughtCard && !m.attachedToMessage);
        if (_cards.length > 3) {
          const _drop = new Set(_cards.slice(0, _cards.length - 3).map(m => m.id || m));
          conversationHistory = conversationHistory.filter(m =>
            !m.isThoughtCard || m.attachedToMessage || !_drop.has(m.id || m));
        }
      }
      // Expose the semantic matches separately so consumers can show them as
      // labeled "earlier context" instead of them polluting recency slices.
      semanticHistory = conversationHistory.filter(m =>
        m.source === 'semantic' || m.source === 'semantic-result' || m.source === 'prior-session');

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
        if (app.windowId)    parts.push(`WinId: ${app.windowId}`);
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
          windowId: app.windowId || null,
          timestamp: app.timestamp || (_priorScreenContext?.timestamp || new Date().toISOString()),
          source,
        };
        logger.debug(`[Node:ResolveReferencesV2] Active app context (${source}): ${app.appName} ${app.filePath ? `file=${app.filePath}` : '(no file)'}${app.url ? ` url=${app.url}` : ''}${app.windowId ? ` winId=${app.windowId}` : ''}`);
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
  // The context is now passed UNCONDITIONALLY: the classifier's ACTIVE DOC CONTEXT
  // rule resolves doc-artifact referents ("this file", "this page", "print this")
  // into the separate `activeDocRef` field — it no longer resolves arbitrary
  // deictics into followUpTarget (the task_1d44cd52 bug: "it" → the IDE's open
  // file instead of the conversational subject). Conversational referents stay in
  // followUpTarget; the live-doc resolution is a parallel channel that cannot
  // corrupt it, and an unused context block is harmless.
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
      isThoughtReply: false,
      interactiveActions: [],
      webAccessMode: state._taskClassification?.webAccessMode || null,
      resolution: 'resolved',
    };
  } else {
    _taskClassification = await classifyTask(
      message,
      conversationHistory,
      state.llmBackend || null,
      logger,
      priorScreenSummary,
      _activeAppContext,
    );
  }
  logger.debug(`[Node:ResolveReferencesV2] taskClassification: ${JSON.stringify(_taskClassification)}`);

  // ── Ack floor: card attached + content-free ack + LLM no-resolution ────────
  // A bare "sure"/"yes"/"no thanks" carries zero topical signal — when the
  // classifier produced NO resolution at all, the only live referent is the
  // attached card (the user sent while looking at it). This floor never
  // overrides an actual LLM judgment — it fires solely in the no-resolution
  // branch whose observed outcome was a literal `WebSearch "sure"`.
  const _ACK_YES = new Set(['yes','yeah','yep','yup','sure','ok','okay','k','sounds good','go ahead','do it','please do','absolutely','of course','definitely','yes please','please']);
  const _ACK_NO  = new Set(['no','nope','nah','no thanks','not now','later','maybe later','no thank you']);
  const _ackWord = String(message || '').toLowerCase().replace(/[.!?…]+/g, '').trim();
  if (_thoughtCtx && !state._planFile &&
      !_taskClassification.isFollowUp && !_taskClassification.isThoughtReply && !_taskClassification.needsClarification &&
      (_ACK_YES.has(_ackWord) || _ACK_NO.has(_ackWord))) {
    const _affirmative = _ACK_YES.has(_ackWord);
    _taskClassification.isThoughtReply = true;
    _taskClassification.isFollowUp = _affirmative;
    _taskClassification.followUpTarget = _affirmative ? _thoughtCtx.text : null;
    logger.info(`[Node:ResolveReferencesV2] ack floor: "${_ackWord}" + attached card → isThoughtReply=true (${_affirmative ? 'accepted' : 'declined'})`);
  }

  // ── Thought-card lifecycle: report the outcome to the engine ──────────────
  // Attached-card prompts: isThoughtReply decides responded-vs-dismissed.
  // Plain prompts that resolve to a persisted card turn = delayed re-engagement
  // (recover thoughtId from the newest card row in history).
  try {
    const _isThoughtReply = _taskClassification?.isThoughtReply === true;
    let _cardId = _thoughtCtx?.id || null;
    let _outcome = null;
    if (_thoughtCtx) {
      _outcome = _isThoughtReply
        ? (_ACK_NO.has(_ackWord) ? 'user declined' : 'user responded')
        : 'dismissed — user engaged elsewhere';
    } else if (_isThoughtReply) {
      const _cardRow = [...conversationHistory].reverse().find(m => m.isThoughtCard && m.thoughtId);
      if (_cardRow) { _cardId = _cardRow.thoughtId; _outcome = 'responded (delayed)'; }
    }
    if (_cardId && _outcome) {
      mcpAdapter.callService('user-memory', 'thought.update', {
        id: _cardId,
        updates: { status: 'completed', outcomeText: _outcome },
      }).catch(() => {});
      logger.info(`[Node:ResolveReferencesV2] Thought ${_cardId} → ${_outcome}`);
    }
  } catch (_) { /* lifecycle reporting is best-effort */ }

  // ── Resolve activeDocTarget deterministically ───────────────────────────────
  // The classifier only emits the KIND of referent (activeDocRef: file/url/
  // screen). The concrete path/url is attached here from the merged live context
  // (_priorScreenContext was enriched with _activeAppContext fields above) — the
  // LLM never emits path strings, so there is no hallucination surface.
  if (_taskClassification.activeDocRef === 'file') {
    const fp = _priorScreenContext?.filePath || null;
    if (fp) {
      try {
        // The monitor derives filePath from the window title — verify it exists
        // before letting the planner treat it as a readable file.
        if (fs.existsSync(fp)) {
          _taskClassification.activeDocTarget = fp;
        } else {
          logger.info(`[Node:ResolveReferencesV2] activeDocRef=file but path missing — downgrading to screen: ${fp}`);
          _taskClassification.activeDocRef = 'screen';
        }
      } catch (_) {
        _taskClassification.activeDocTarget = fp;
      }
    } else {
      // Classifier said "file" but no live filePath exists — fall back to the
      // screen-content path rather than a targetless file plan.
      _taskClassification.activeDocRef = 'screen';
    }
  } else if (_taskClassification.activeDocRef === 'url') {
    const u = _priorScreenContext?.url || null;
    if (u) {
      _taskClassification.activeDocTarget = u;
    } else {
      _taskClassification.activeDocRef = 'screen';
    }
  }

  // ── Deixis fallback: "the file" + live document ──────────────────────────────
  // The classifier sometimes emits no referent at all on follow-ups like
  // "update the file and make it longer" (isFollowUp:false, activeDocRef:null)
  // even though a document app holds the file live. When the message uses
  // file-shaped deixis AND the live context carries a verified file path,
  // fill the null — the classifier's own resolution always wins, this only
  // fires when it produced nothing.
  if (!_taskClassification.activeDocRef) {
    const _dfp = _priorScreenContext?.filePath || null;
    if (_dfp && /\b(?:the|this|that|my)\s+(?:file|document|doc|text\s+file|note)\b/i.test(message || '')) {
      try {
        if (fs.existsSync(_dfp)) {
          _taskClassification.activeDocRef = 'file';
          _taskClassification.activeDocTarget = _dfp;
          logger.info(`[Node:ResolveReferencesV2] deixis fallback: file-referring message + live doc → activeDocTarget=${_dfp}`);
        }
      } catch (_) { /* existsSync failed — leave null */ }
    }
  }

  // ── Validate classifier-resolved file paths ──────────────────────────────────
  // The classifier can hallucinate paths from chat history (e.g. a screenshot
  // timestamp that doesn't correspond to any real file). fs.existsSync-check any
  // followUpTarget that looks like a path before injecting it downstream.
  // Drop + log if it doesn't exist — never pass a hallucinated path to the planner.
  // Destination-path exception: when the task creates/writes a file, the
  // followUpTarget path legitimately does not exist yet — it is the output
  // target, not a source. Primary signal is the classifier's expectsFileOutput
  // field (semantic — catches "drop it in three.md"); FILE_WRITE_VERB_RE is the
  // cheap fallback when the field wasn't set.
  const _pathIsDestination = _taskClassification.expectsFileOutput === true
    || FILE_WRITE_VERB_RE.test(message || '');
  if (_taskClassification.followUpTarget && typeof _taskClassification.followUpTarget === 'string') {
    const t = _taskClassification.followUpTarget.trim();
    if (t.startsWith('/') && /\.\w{1,10}$/.test(t) && !_pathIsDestination) {
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

  // ── Resolution contract — the pipeline's authoritative "do we know what this
  // is" verdict. Derived LAST, after every normalization pass above (ack floor,
  // activeDocRef, path validation, webAccess confirm) has settled the fields it
  // reads. Downstream: 'needs_clarification' → clarify gate asks the user;
  // 'declined_ack' → terminal acknowledgement; 'resolved' → normal routing.
  _taskClassification.resolution = deriveResolution(_taskClassification, message, !!_thoughtCtx);
  if (_taskClassification.resolution !== 'resolved') {
    logger.info(`[Node:ResolveReferencesV2] resolution=${_taskClassification.resolution}: "${String(message).slice(0, 60)}"`);
  }

  return {
    ...state,
    // Card replies: `message` is the reply-only text everywhere downstream —
    // the tag stays available via _thoughtAttachment.tag.
    message:                message,
    resolvedMessage:        message,
    originalMessage:        message,
    conversationHistory,
    semanticHistory,
    _taskClassification,
    _thoughtAttachment:     _thoughtCtx || null,
    _priorScreenContext:    _priorScreenContext || null,
    _screenContextNote:     _screenContextNote || null,
    coreferenceMethod:      'none',
    coreferenceReplacements: [],
  };
};

// Exported for tests — chronological merge used inside the node above.
module.exports._mergeConversationHistory = _mergeConversationHistory;
module.exports._collectSessionResults = _collectSessionResults;
module.exports.REFERENTIAL_RE = REFERENTIAL_RE;

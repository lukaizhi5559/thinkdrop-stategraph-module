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
      const histResult = await mcpAdapter.callService('conversation', 'message.list', {
        sessionId,
        limit: 20,
        direction: 'DESC',
      });
      const histData = histResult.data || histResult;
      conversationHistory = (histData.messages || [])
        .filter(msg => msg.sender !== 'system')
        .map(msg => ({
          role:      msg.sender === 'user' ? 'user' : 'assistant',
          content:   stripHtml(msg.text || msg.content || ''),
          timestamp: msg.timestamp,
        }))
        .reverse();

      logger.debug(`[Node:ResolveReferencesV2] Fetched ${conversationHistory.length} messages for context window`);
    }
  } catch (err) {
    logger.debug('[Node:ResolveReferencesV2] Could not fetch history, proceeding without:', err.message);
  }

  // ── Load prior screen context — prefer live monitor heartbeat, fallback to file ──────
  const _priorScreenContext = await getRecentMonitorCapture(mcpAdapter, logger);
  if (_priorScreenContext) {
    const ageMin = Math.round((Date.now() - new Date(_priorScreenContext.timestamp).getTime()) / 60000);
    logger.debug(`[Node:ResolveReferencesV2] Prior screen context available (${ageMin} min old): ${_priorScreenContext.appName || 'unknown app'}`);
  }

  // Build a compact summary string for the classifyTask LLM prompt when screen context exists
  let priorScreenSummary = null;
  if (_priorScreenContext) {
    const ageMin = Math.round((Date.now() - new Date(_priorScreenContext.timestamp).getTime()) / 60000);
    const parts = [];
    if (_priorScreenContext.appName)     parts.push(`App: ${_priorScreenContext.appName}`);
    if (_priorScreenContext.windowTitle) parts.push(`Window: "${_priorScreenContext.windowTitle}"`);
    if (_priorScreenContext.url)         parts.push(`URL: ${_priorScreenContext.url}`);
    priorScreenSummary = `PRIOR SCREEN CONTEXT (captured ${ageMin} min ago): ${parts.join(', ')}`;
  }

  // ── Classify task once — all downstream nodes read from _taskClassification ──────────
  // This replaces per-node NLU regex (BYPASS_PATTERNS, _LOCAL_ACTION_VERBS, etc.)
  const _taskClassification = await classifyTask(
    message,
    conversationHistory,
    state.llmBackend || null,
    logger,
    priorScreenSummary,
  );
  logger.debug(`[Node:ResolveReferencesV2] taskClassification: ${JSON.stringify(_taskClassification)}`);

  return {
    ...state,
    resolvedMessage:        message,
    originalMessage:        message,
    conversationHistory,
    _taskClassification,
    _priorScreenContext:    _priorScreenContext || null,
    coreferenceMethod:      'none',
    coreferenceReplacements: [],
  };
};

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

/**
 * Check if new prompt should continue existing session using LLM
 */
async function checkSessionContinuity(newPrompt, sessionId, mcpAdapter, llmBackend, logger) {
  logger.info(`[Node:ResolveReferencesV2] LLM continuity check started for session: ${sessionId}`);
  logger.info(`[Node:ResolveReferencesV2] Prompt: "${newPrompt}"`);
  
  if (!llmBackend) {
    logger.warn('[Node:ResolveReferencesV2] No LLM backend available, allowing new session');
    return true; // Default to allowing new session
  }

  try {
    // Get recent messages from the session
    const msgResult = await mcpAdapter.callService('conversation', 'message.list', {
      sessionId,
      limit: 3,
      direction: 'DESC',
    });
    const msgData = msgResult.data || msgResult;
    const recentMessages = (msgData.messages || [])
      .filter(msg => msg.sender !== 'system')
      .map(msg => ({
        sender: msg.sender,
        text: stripHtml(msg.text || msg.content || ''),
      }))
      .reverse();

    logger.info(`[Node:ResolveReferencesV2] Found ${recentMessages.length} recent messages`);
    recentMessages.forEach((msg, i) => {
      logger.info(`[Node:ResolveReferencesV2] Message ${i+1}: ${msg.sender}: "${msg.text.substring(0, 50)}..."`);
    });

    if (recentMessages.length === 0) {
      logger.info('[Node:ResolveReferencesV2] Session has no messages, allowing continuation');
      return true;
    }

    // Check if this prompt is already in the recent messages
    const promptExists = recentMessages.some(m => 
      m.sender === 'user' && m.text === newPrompt
    );
    
    if (promptExists) {
      logger.debug('[Node:ResolveReferencesV2] Prompt already exists in session, allowing continuation');
      return true;
    }

    // Use LLM to determine if this is a continuation
    const context = recentMessages.slice(-3).map(m => `${m.sender}: ${m.text}`).join('\n');
    
    logger.info(`[Node:ResolveReferencesV2] Context for LLM:\n${context}`);
    
    const prompt = `You are checking if a new user prompt is a continuation of an existing conversation.

Recent Context:
${context}

New Prompt: "${newPrompt}"

Is this new prompt a continuation of the existing conversation, or is it starting a new unrelated task?

Respond with ONLY:
- "continue" if it's clearly a continuation (references previous work, uses "it/that/continue", etc.)
- "new" if it's a new task (even if topically similar)`;

    logger.info(`[Node:ResolveReferencesV2] Calling LLM with prompt...`);
    const response = await llmBackend.generateAnswer(prompt, {
      temperature: 0.1,
      maxTokens: 10,
      systemInstructions: 'You are a conversation continuity checker. Respond with only "continue" or "new".'
    });
    
    const decision = response.toLowerCase().trim();
    const shouldContinue = decision.includes('continue');
    
    logger.info(`[Node:ResolveReferencesV2] LLM response: "${response}"`);
    logger.info(`[Node:ResolveReferencesV2] LLM decision: "${decision}" -> shouldContinue: ${shouldContinue}`);
    
    return shouldContinue;
  } catch (error) {
    logger.warn('[Node:ResolveReferencesV2] LLM continuity check failed:', error.message);
    return true; // Default to allowing continuation on error
  }
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
        // First, get existing session (if any)
        const routeResult = await mcpAdapter.callService('conversation', 'session.route', { text: message });
        sessionId = (routeResult.data || routeResult)?.sessionId || null;
        
        if (sessionId) {
          const sessionAction = (routeResult.data || routeResult)?.action || 'unknown';
          logger.info(`[Node:ResolveReferencesV2] Got session: ${sessionId} (action: ${sessionAction})`);
          
          // Store the resolved session ID in context for downstream nodes (especially checkPlanCache)
          if (!state.context) state.context = {};
          state.context.sessionId = sessionId;
        }
      } catch (_) {}
    }

    // ── LLM continuity check for existing sessions ───────────────────────────
    if (sessionId) {
      logger.info(`[Node:ResolveReferencesV2] Running LLM continuity check on session: ${sessionId}`);
      
      // Skip LLM check for synthetic plan_execute messages — always continue existing session
      const isPlanExecute = /^\[plan_execute:/.test(message || '');
      if (isPlanExecute) {
        logger.debug('[Node:ResolveReferencesV2] plan_execute prompt — skipping continuity check, keeping session');
      }
      
      // LLM continuity check - validate if this should continue the session
      const shouldContinue = isPlanExecute || await checkSessionContinuity(message, sessionId, mcpAdapter, state.llmBackend, logger);
      
      if (!shouldContinue) {
        logger.info(`[Node:ResolveReferencesV2] LLM detected new context, creating new session`);
        // Create new session
        const newRouteResult = await mcpAdapter.callService('conversation', 'session.route', { 
          text: message,
          forceNew: true 
        });
        sessionId = (newRouteResult.data || newRouteResult)?.sessionId || null;
        logger.debug(`[Node:ResolveReferencesV2] Created new session: ${sessionId}`);
        
        // Update context with new session ID
        if (!state.context) state.context = {};
        state.context.sessionId = sessionId;
        
        // Set flag to indicate new session was created (for parseSkill to skip semantic matching)
        state._newSessionCreated = true;
      } else {
        logger.info(`[Node:ResolveReferencesV2] LLM confirmed session continuation`);
      }
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

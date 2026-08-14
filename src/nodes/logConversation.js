/**
 * Log Conversation Node
 *
 * Persists the user message and assistant response to the conversation-service
 * for context/history. This node runs at the END of every graph execution,
 * regardless of intent type.
 *
 * Works with or without MCP adapter:
 * - With MCP: Stores both turns in conversation-service via message.add
 * - Without MCP: No-op (logs warning)
 *
 * Session handling:
 * - Uses context.sessionId if provided
 * - If no sessionId, calls session.route to auto-match or create a session
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { storePersonalProfileFact } = require('../utils/personalProfile');
const { parseLlmJson } = require('../utils/parseLlmJson');

let EXTRACT_PROMPT = null;
function loadExtractPrompt() {
  if (EXTRACT_PROMPT) return EXTRACT_PROMPT;
  try {
    EXTRACT_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/extract-personal-facts.md'), 'utf8');
  } catch (_) {
    EXTRACT_PROMPT = '';
  }
  return EXTRACT_PROMPT;
}

module.exports = async function logConversation(state) {
  const { mcpAdapter, message, answer, context, intent, llmBackend } = state;
  const logger = state.logger || console;

  logger.debug('[Node:LogConversation] Logging conversation turn...');

  // Nothing to log if no message or answer
  if (!message && !answer) {
    logger.debug('[Node:LogConversation] No message/answer to log, skipping');
    return state;
  }

  // No-op without MCP adapter
  if (!mcpAdapter) {
    logger.warn('[Node:LogConversation] No MCP adapter - conversation not logged');
    return state;
  }

  try {
    // Resolve or create session
    let sessionId = context?.sessionId;

    if (!sessionId) {
      logger.debug('[Node:LogConversation] No sessionId - routing to session...');
      try {
        const routeResult = await mcpAdapter.callService('conversation', 'session.route', {
          text: message,
          userId: context?.userId,
          hintSessionId: state.resolvedSessionId || null,
          metadata: {
            intent: intent?.type,
            source: 'thinkdrop_electron'
          }
        });
        const routeData = routeResult.data || routeResult;
        sessionId = routeData.sessionId || routeData.session?.id;
        logger.debug(`[Node:LogConversation] Routed to session: ${sessionId} (action: ${routeData.action || 'unknown'})`);
      } catch (routeErr) {
        logger.warn('[Node:LogConversation] Session routing failed, trying session.create:', routeErr.message);
        try {
          const createResult = await mcpAdapter.callService('conversation', 'session.create', {
            userId: context?.userId || 'default_user',
            metadata: { source: 'thinkdrop_electron', intent: intent?.type }
          });
          const createData = createResult.data || createResult;
          sessionId = createData.sessionId || createData.session?.id || createData.id;
          logger.debug(`[Node:LogConversation] Created new session: ${sessionId}`);
        } catch (createErr) {
          logger.error('[Node:LogConversation] Could not create session:', createErr.message);
          return state;
        }
      }
    }

    if (!sessionId) {
      logger.error('[Node:LogConversation] No sessionId resolved, skipping log');
      return state;
    }

    // Store user message and assistant response in parallel
    const logPromises = [];

    if (message) {
      logPromises.push(
        mcpAdapter.callService('conversation', 'message.add', {
          sessionId,
          text: message,
          sender: 'user',
          metadata: {
            intent: intent?.type,
            intentConfidence: intent?.confidence,
            source: 'thinkdrop_electron',
            timestamp: new Date().toISOString()
          }
        }).catch(err => {
          logger.warn('[Node:LogConversation] Failed to log user message:', err.message);
        })
      );
    }

    // For command_automate: store rich skill output so follow-up prompts have real context.
    // commandOutput contains per-step summaries with actual stdout (fs.read tree, image.analyze
    // descriptions, shell output, etc.). answer alone is usually "All N steps completed."
    // which is useless for the next turn's planSkills conversationNote.
    const skillResults = state.skillResults || [];
    let richAssistantText = answer;
    if (intent?.type === 'command_automate') {
      // For the final synthesize step: use the generated answer text (not raw stdout)
      // so that follow-up prompts like "text this to me" get the full formatted content.
      // NOTE: executeCommand sets answer:undefined after synthesize (line ~2104), so
      // state.answer is always falsy here for command_automate. Fall back to the synthesize
      // step's stdout in skillResults so the [synthesize]: entry is always written.
      const _stateAnswer = state.answer && typeof state.answer === 'string' && state.answer.trim().length > 50
        ? state.answer.trim()
        : null;
      const _synthStepStdout = (() => {
        const s = skillResults.slice().reverse().find(
          r => r.skill === 'synthesize' && r.ok !== false && r.stdout &&
               typeof r.stdout === 'string' && r.stdout.trim().length > 50
        );
        return s ? s.stdout.trim() : null;
      })();
      const synthAnswer = _stateAnswer || _synthStepStdout;
      const keyOutputs = skillResults
        .filter(r => r.ok && (
          (r.stdout && r.stdout.trim().length > 0) ||
          // shell.run with empty stdout (e.g. mv, mkdir, cp): include resolved cmd string
          // so the next turn's planner knows the exact paths used
          (r.skill === 'shell.run' && r.cmd && typeof r.cmd === 'string')
        ))
        .map((r, idx, arr) => {
          const label = r.description || r.skill;
          // Last synthesize step: store the LLM-generated answer (formatted, readable)
          // instead of raw stdout — follow-ups can use this as message body directly.
          if (r.skill === 'synthesize' && idx === arr.length - 1 && synthAnswer) {
            return `[${label}]:\n${synthAnswer.slice(0, 2000)}`;
          }
          const out = (r.stdout || '').trim();
          // shell.run with empty stdout: log the resolved cmd so planner sees exact paths
          if (!out && r.skill === 'shell.run' && r.cmd && typeof r.cmd === 'string') {
            return `[${label}]:\n(ran: ${r.cmd.trim().slice(0, 300)})`;
          }
          // For fs.read: include full tree output (filenames are critical for follow-ups)
          // For others: truncate to 500 chars
          return `[${label}]:\n${r.skill === 'fs.read' ? r.stdout.trim() : out.slice(0, 500)}`;
        });
      if (keyOutputs.length > 0) {
        // Always append the LLM-generated synthesized answer as a dedicated [synthesize]
        // entry so that follow-up messaging tasks ("text this to me") get the formatted
        // human-readable summary rather than a raw shell/JSON output snippet.
        if (synthAnswer) {
          keyOutputs.push(`[synthesize]:\n${synthAnswer.slice(0, 2000)}`);
        }
        richAssistantText = `${answer || 'Done.'}\n\nStep outputs:\n${keyOutputs.join('\n\n')}`;
      } else if (synthAnswer && skillResults.some(r => r.ok !== false)) {
        // No skill-step stdout but there's a meaningful answer — preserve for follow-up
        // prompts ("text this to me") that need prior content as message body.
        // Guard: only store as synthesis when at least one step succeeded — prevents
        // error/recovery turns from being tagged as [synthesize]: (which would corrupt
        // the body for the next SMS/email prompt in the same session).
        richAssistantText = `${answer || 'Done.'}\n\nStep outputs:\n[synthesize]:\n${synthAnswer}`;
      }
      // Append saved file paths so the next turn's planner can resolve "that file" /
      // "attach that" references to the real path — without this, savedFilePaths
      // never reaches conversationHistory and the planner hallucinates a filename.
      const _savedPaths = (state.savedFilePaths || []).filter(Boolean);
      if (_savedPaths.length > 0) {
        richAssistantText = (richAssistantText || `${answer || 'Done.'}`) +
          `\n\nSaved files:\n${_savedPaths.join('\n')}`;
      }
    }

    // For memory_retrieve: wrap the answer in Step outputs / [synthesize]: format
    // so that follow-up messaging tasks ("email this info to me") can find it via
    // planSkills.priorSynthesizedContent scan — same pattern as command_automate.
    if (intent?.type === 'memory_retrieve') {
      const _memAnswer = answer && typeof answer === 'string' && answer.trim().length > 50
        ? answer.trim()
        : null;
      if (_memAnswer) {
        richAssistantText = `${answer}\n\nStep outputs:\n[synthesize]:\n${_memAnswer.slice(0, 2000)}`;
        logger.info(`[Node:LogConversation] memory_retrieve: wrapped answer as [synthesize]: for follow-up context (${_memAnswer.length} chars)`);
      }
    }

    // Strip markdown code fences before storing — prevents ```tool_code or ```json blocks
    // from being persisted as history, which would prime the next LLM call to output code.
    if (richAssistantText && typeof richAssistantText === 'string') {
      richAssistantText = richAssistantText.replace(/^```[\w]*\r?\n?/gm, '').replace(/\r?\n?```\s*$/gm, '').trim();
    }

    // [DEBUG DIAG] Remove after BODY fix confirmed
    logger.info(`[Node:LogConversation] richText preview (${richAssistantText?.length ?? 0}): ${(richAssistantText || '').slice(0, 200).replace(/\n/g, '↵')}`);
    if (richAssistantText && typeof richAssistantText === 'string') {
      // Recovery/ASK_USER turns are system UI events — log them as role:'system' so the
      // planner's poison filter drops them from conversationNote. Logging them as
      // role:'assistant' causes prior recovery messages (e.g. "X returned a
      // navigation/welcome page") to leak into the next turn's planning context and
      // bias agent selection toward unrelated services.
      const _isRecoveryTurn = !!(state.recoveryAction || state.recoveryQuestion ||
                                 state._isAgentAskUser || state.askUser);
      const _assistantRole = _isRecoveryTurn ? 'system' : 'assistant';
      logPromises.push(
        mcpAdapter.callService('conversation', 'message.add', {
          sessionId,
          text: richAssistantText,
          sender: _assistantRole,
          metadata: {
            intent: intent?.type,
            source: 'stategraph',
            _isRecovery: _isRecoveryTurn,
            timestamp: new Date().toISOString()
          }
        }).catch(err => {
          logger.warn('[Node:LogConversation] Failed to log assistant response:', err.message);
        })
      );
    }

    await Promise.all(logPromises);

    logger.debug(`[Node:LogConversation] Logged conversation turn to session: ${sessionId}`);

    // ── Persist screen context for cross-turn/cross-session follow-ups ──────────
    // Written after every screen_intelligence turn so resolveReferencesV2 can
    // pick it up on the next prompt regardless of which session it lands in.
    if (intent?.type === 'screen_intelligence' && state.screenContext) {
      try {
        const screenFile = path.join(os.homedir(), '.thinkdrop', 'last-screen-context.json');
        const screenPayload = {
          timestamp:   new Date().toISOString(),
          appName:     state.screenContext.appName     || null,
          windowTitle: state.screenContext.windowTitle || null,
          url:         state.screenContext.url         || null,
          contextText: typeof state.context === 'string' ? state.context : null,
        };
        fs.mkdirSync(path.join(os.homedir(), '.thinkdrop'), { recursive: true });
        fs.writeFileSync(screenFile, JSON.stringify(screenPayload, null, 2), 'utf8');
        logger.info(`[Node:LogConversation] screen_intelligence: wrote last-screen-context.json (${screenPayload.contextText?.length ?? 0} chars)`);
      } catch (screenErr) {
        logger.warn(`[Node:LogConversation] Failed to write last-screen-context.json: ${screenErr.message}`);
      }
    }

    // ── Persist output contract into session context_data + update topic embedding ──
    // This enables semantic session routing: future prompts can be matched back to
    // this session using vector similarity on the topic_embedding column.
    if (sessionId && state._contract) {
      const contract = state._contract;
      // Store contract in context_data (fire-and-forget, non-blocking)
      mcpAdapter.callService('conversation', 'session.update', {
        sessionId,
        contextData: { contract },
      }).catch(err => logger.warn(`[Node:LogConversation] Failed to store contract in context_data: ${err.message}`));

      // Generate + store topic embedding from intent + answer excerpt (async, non-blocking)
      const topicText = [
        contract.intent !== 'unknown' ? contract.intent : '',
        state.message ? state.message.slice(0, 150) : '',
        contract.answer ? contract.answer.slice(0, 150) : '',
      ].filter(Boolean).join(' ').trim();

      if (topicText) {
        mcpAdapter.callService('conversation', 'session.storeEmbedding', {
          sessionId,
          text: topicText,
        }).catch(err => logger.warn(`[Node:LogConversation] Failed to store topic embedding: ${err.message}`));
      }
    }

    // ── Auto-extract personal facts from this turn (non-blocking) ─────────────
    if (llmBackend && message && answer) {
      const _isRecoveryTurn = !!(state.recoveryAction || state.recoveryQuestion ||
                                 state._isAgentAskUser || state.askUser);
      const _isMemoryStore = intent?.type === 'memory_store';
      if (!_isRecoveryTurn && !_isMemoryStore) {
        _extractAndStoreFacts(mcpAdapter, llmBackend, message, answer, context, logger).catch(err => {
          logger.warn(`[Node:LogConversation] Auto-extraction failed: ${err.message}`);
        });
      }
    }

    return {
      ...state,
      conversationLogged: true,
      resolvedSessionId: sessionId
    };

  } catch (error) {
    logger.error('[Node:LogConversation] Error:', error.message);
    // Non-fatal - return state unchanged so the answer still reaches the user
    return state;
  }
};

async function _extractAndStoreFacts(mcpAdapter, llmBackend, message, answer, context, logger) {
  const prompt = loadExtractPrompt();
  if (!prompt) return;

  const exchange = `User: ${message}\n\nAssistant: ${answer}`;
  const raw = await llmBackend.generateAnswer(
    `${prompt}\n\n---\n\n${exchange}`,
    {
      query: exchange,
      context: { systemInstructions: prompt },
      options: { maxTokens: 300, temperature: 0.1 }
    },
    { maxTokens: 300, temperature: 0.1, taskType: 'classification' }
  );
  if (!raw) return;

  let parsed;
  try {
    parsed = parseLlmJson(raw, logger, 'Node:LogConversation');
    if (!parsed) throw new Error('no JSON in response');
  } catch (e) {
    logger.warn(`[Node:LogConversation] Auto-extraction parse failed: ${e.message}`);
    return;
  }

  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  if (facts.length === 0) return;

  const userId = context?.userId || 'local_user';
  for (const fact of facts) {
    if (!fact.field || !fact.value || !fact.label) continue;
    const parsedFact = {
      memType: 'personal_profile',
      field: fact.field,
      label: fact.label,
      value: fact.value,
      entityType: fact.entityType || 'PERSON',
      memText: fact.sourceText || `My ${fact.label} is ${fact.value}`,
    };
    try {
      await storePersonalProfileFact(mcpAdapter, parsedFact, userId, context, logger, 'auto_extraction');
      logger.info(`[Node:LogConversation] Auto-extracted personal fact: ${fact.field} = ${fact.value}`);
    } catch (e) {
      logger.warn(`[Node:LogConversation] Failed to store auto-extracted fact ${fact.field}: ${e.message}`);
    }
  }
}

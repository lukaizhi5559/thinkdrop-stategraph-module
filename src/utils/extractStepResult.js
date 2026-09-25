'use strict';
/**
 * extractStepResult — shared by StateGraphBuilder (queue summary) and the
 * advanceQueue node. Extracted verbatim so both call sites use one
 * implementation.
 *
 * Extract the most useful short result string from a completed intent step.
 * Used to populate state.dataContext[N] for injection into dependent steps.
 *
 * Returns either a plain string (≤2000 chars) or an object { summary, file }
 * when the full result exceeds 2000 chars and was written to a pipeline buffer
 * file.
 */
function extractStepResult(state) {
  const intent = state.intent?.type;
  const logger = state.logger || console;

  // Debug logging
  logger.info(`[extractStepResult] intent=${intent}, filteredMemories=${Array.isArray(state.filteredMemories) ? state.filteredMemories.length : 'N/A'}`);
  if (Array.isArray(state.filteredMemories) && state.filteredMemories.length > 0) {
    logger.info(`[extractStepResult] First memory keys: ${Object.keys(state.filteredMemories[0]).join(', ')}`);
  }

  // memory_retrieve: use first memory's text (field is 'text', not 'source_text')
  if (intent === 'memory_retrieve' && Array.isArray(state.filteredMemories) && state.filteredMemories.length > 0) {
    const result = state.filteredMemories
      .slice(0, 3)
      .map(m => m.text || m.source_text || m.extracted_text || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
    logger.info(`[extractStepResult] Extracted ${result.length} chars from ${state.filteredMemories.length} memories`);
    return result;
  }

  // memory_retrieve with profile fallback (when semantic search returns nothing but profile has the data)
  if (intent === 'memory_retrieve' && state._profileFallback) {
    const result = `Profile: ${state._profileFallback.key} = ${state._profileFallback.value}`;
    logger.info(`[extractStepResult] Extracted profile fallback: ${result.slice(0, 100)}...`);
    return result;
  }

  // memory_retrieve with conversation history (when no memories but conversation has relevant info)
  if (intent === 'memory_retrieve' && Array.isArray(state.conversationHistory) && state.conversationHistory.length > 0) {
    const result = state.conversationHistory
      .slice(0, 5)
      .map(m => m.content || m.text || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
    logger.info(`[extractStepResult] Extracted ${result.length} chars from ${state.conversationHistory.length} conversation messages`);
    return result;
  }

  // web_search: use top result snippet
  if (intent === 'web_search' && Array.isArray(state.contextDocs) && state.contextDocs.length > 0) {
    return state.contextDocs
      .slice(0, 2)
      .map(d => d.snippet || d.title || '')
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000);
  }

  // command_automate: use answer or last skill stdout — buffer to file if > 2000 chars
  if (intent === 'command_automate') {
    const raw = state.answer || (() => {
      if (Array.isArray(state.skillResults)) {
        const last = state.skillResults.filter(r => r.ok && r.stdout).pop();
        return last ? last.stdout : null;
      }
      return null;
    })();
    if (raw) {
      if (raw.length <= 2000) return raw;
      // Write full content to a pipeline buffer file; return summary + file ref
      try {
        const _fs = require('fs');
        const _os = require('os');
        const _path = require('path');
        const runId  = state._runId || state.sessionId || `run_${Date.now()}`;
        const stepN  = state.intentResults ? state.intentResults.length : 0;
        const bufDir = _path.join(_os.homedir(), '.thinkdrop', 'pipeline', runId);
        _fs.mkdirSync(bufDir, { recursive: true });
        const filePath = _path.join(bufDir, `step_${stepN}.md`);
        _fs.writeFileSync(filePath, raw, 'utf8');
        return { summary: raw.slice(0, 2000), file: filePath };
      } catch (_) {
        return raw.slice(0, 2000); // fallback: truncate if file write fails
      }
    }
  }

  // memory_store: use the answer set by storeMemory node
  if (intent === 'memory_store') {
    return state.answer?.slice(0, 2000) || `Got it! I'll remember that.`;
  }

  // Default: use state.answer if available
  return state.answer?.slice(0, 2000) || state.message?.slice(0, 200) || '';
}

module.exports = extractStepResult;

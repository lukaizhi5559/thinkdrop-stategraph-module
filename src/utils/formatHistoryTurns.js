'use strict';

/**
 * Format conversation history turns for LLM prompts with timestamps and
 * conditional slicing based on whether the current task is a follow-up.
 *
 * When isFollowUp is false, only the last 1 turn is passed (the current
 * request is already in the prompt as "User request:" — history is noise
 * that can pollute plan generation with prior unrelated task context).
 *
 * When isFollowUp is true, full history up to maxTurns is passed with
 * timestamps so the LLM can resolve pronouns and understand temporal ordering.
 *
 * @param {Array} conversationHistory - array of message objects with role, content, formattedDate
 * @param {Object} opts
 * @param {boolean} opts.isFollowUp - whether the current task is a follow-up
 * @param {number} opts.maxTurns - max turns to include when isFollowUp is true
 * @returns {string} formatted turn lines joined by newlines, or empty string
 */
function formatHistoryTurns(conversationHistory, { isFollowUp, maxTurns = 5 } = {}) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return '';

  const sliceCount = isFollowUp ? maxTurns : 1;
  const turns = conversationHistory.slice(-sliceCount);

  const lines = turns
    .filter(m => m.content && m.content.trim())
    .filter(m => m.role !== 'system' && m.sender !== 'system')
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const ts = m.formattedDate?.relative || m.formattedDate?.absolute || '';
      const tsPrefix = ts ? `[${ts}] ` : '';
      const limit = m.role === 'assistant' && m.content?.includes('Step outputs:') ? 2000 : 300;
      return `${role}: ${tsPrefix}${(m.content || '').trim().substring(0, limit)}`;
    });

  return lines.length > 0 ? lines.join('\n') : '';
}

module.exports = { formatHistoryTurns };

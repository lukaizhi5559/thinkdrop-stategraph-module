'use strict';

/**
 * executeIntrospect node
 *
 * Handles system_introspect intents — calls command-service's system.introspect
 * skill to query ThinkDrop's own data stores, then passes results to the answer
 * node for natural language summarization.
 *
 * Route: enrichIntent → executeIntrospect → answer → logConversation
 */

const QUERY_MAP = {
  agent:         'agents',
  agents:        'agents',
  skill:         'skills',
  skills:        'skills',
  database:      'databases',
  databases:     'databases',
  table:         'databases',
  tables:        'databases',
  duckdb:        'databases',
  rule:          'context_rules',
  rules:         'context_rules',
  context_rules: 'context_rules',
  workspace:     'workspace',
  thinkdrop:     'workspace',
  dir:           'workspace',
  directory:     'workspace',
};

function resolveQuery(message) {
  if (!message) return 'all';
  const lower = message.toLowerCase();
  for (const [keyword, query] of Object.entries(QUERY_MAP)) {
    if (lower.includes(keyword)) return query;
  }
  return 'all';
}

module.exports = async function executeIntrospect(state) {
  const { message, mcpAdapter } = state;
  const logger = state.logger || console;

  const query = resolveQuery(message);
  logger.info(`[Node:ExecuteIntrospect] query="${query}" from message: "${(message || '').slice(0, 80)}"`);

  let introspectResult = null;
  try {
    const response = await mcpAdapter.callService('command', 'command.automate', {
      skill: 'system.introspect',
      args: { query },
    });
    introspectResult = response?.data || response;
  } catch (e) {
    logger.error(`[Node:ExecuteIntrospect] Error calling system.introspect: ${e.message}`);
    introspectResult = { ok: false, error: e.message };
  }

  // Format the result as context for the answer node
  let introspectContext = '';
  if (introspectResult?.ok && introspectResult.result) {
    introspectContext = `## System Introspection (${query})\n\n${JSON.stringify(introspectResult.result, null, 2)}`;
  } else if (introspectResult?.error) {
    introspectContext = `## System Introspection Error\n\n${introspectResult.error}`;
  } else {
    introspectContext = `## System Introspection\n\nNo data returned for query "${query}".`;
  }

  logger.debug(`[Node:ExecuteIntrospect] Result size: ${introspectContext.length} chars`);

  return {
    ...state,
    _introspectContext: introspectContext,
    _introspectQuery: query,
    _introspectResult: introspectResult,
    // Route to answer node for natural-language summarization
    _forceAnswerContext: introspectContext,
  };
};

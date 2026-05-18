/**
 * MCP Fill Gaps Node
 *
 * Pre-populates state with answers from MCP services (user_memory, conversation, web_search)
 * before asking the user. Creates a tiered approach: MCP services first, user questions only for true gaps.
 *
 * Position: Between enrichIntent and gatherContext
 * Trigger: Only runs when state._grillMode = true (high-risk operations)
 *
 * State inputs:
 *   state.message - user's automation request
 *   state.riskContext - context from risk assessment
 *   state._grillMode - boolean flag set by assessRisk
 *   state.mcpAdapter - MCP service adapter
 *   state.llmBackend - for LLM calls
 *   state.progressCallback - for UI updates
 *
 * State outputs:
 *   state.mcpFilledAnswers - { key: { value, source, confidence } }
 *   state.mcpFilledCount - number of answers filled
 */

const logger = console;

async function extractInformationNeeds(message, riskContext) {
  const needs = [];

  // Always use LLM extraction — regex fast-paths were incomplete and brittle.
  // The LLM understands the full range of information gaps from natural language.
  try {
    const extractPrompt = `What specific information does the user need to complete this task?

User request: "${message}"

Extract the missing pieces as a JSON array. Be specific about what data is needed.
Examples:
- "email me" when no email in message → { "type": "contact", "description": "email address for sending", "key": "email" }
- "my wife's name" when not provided → { "type": "personal_fact", "description": "spouse's name", "key": "spouse_name" }
- "windsurf shortcuts" → { "type": "external_knowledge", "description": "windsurf keyboard shortcuts", "key": "windsurf_shortcuts" }
- If nothing is missing, return { "needs": [] }

Return: { "needs": [{ "type": "contact|personal_fact|external_knowledge|file_scope", "description": "what is needed", "key": "identifier" }] }`;

    const llmResult = await riskContext.llmBackend?.generateAnswer?.(extractPrompt, {
      temperature: 0,
      maxTokens: 200,
    });

    if (llmResult) {
      const cleaned = llmResult.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.needs)) {
          for (const need of parsed.needs) {
            if (!needs.find(n => n.key === need.key)) needs.push(need);
          }
        }
      }
    }
  } catch (e) {
    logger.warn(`[Node:McpFillGaps] LLM extraction failed: ${e.message}`);
  }

  return needs;
}

async function queryMcpForAnswer(need, mcpClient, llmBackend) {
  const { type, description, key } = need;

  try {
    // 1. Try user profile via profile.get (replaces raw SQL /query against user_profile)
    try {
      const profileResult = await mcpClient.callService('user-memory', 'profile.get', {
        key,
      }, { timeoutMs: 3000 });
      const row = profileResult?.data || profileResult;
      if (row?.value) {
        let value = row.value;
        if (typeof value === 'string' && value.startsWith('KEYTAR:')) {
          value = `[stored securely: ${row.key || key}]`;
        }
        return {
          value,
          source: 'user_profile',
          confidence: 0.9,
          key: row.key || key,
        };
      }
    } catch (profileErr) {
      logger.debug(`[Node:McpFillGaps] profile.get failed for "${key}": ${profileErr.message}`);
    }

    // 2. Semantic search via memory.search (replaces non-existent /semanticSearch)
    try {
      const memoryResult = await mcpClient.callService('user-memory', 'memory.search', {
        query: description,
        limit: 3,
        minSimilarity: 0.5,
      }, { timeoutMs: 4000 });
      const results = memoryResult?.data?.results || memoryResult?.results || [];
      const top = results[0];
      if (top && (top.similarity || top.score || 0) > 0.5) {
        const text = top.source_text || top.content || top.text || top.value || '';
        const extracted = extractValueFromText(text, description, llmBackend);
        if (extracted) {
          return {
            value: extracted,
            source: top.type || 'memory',
            confidence: top.similarity || top.score || 0.6,
          };
        }
      }
    } catch (searchErr) {
      logger.debug(`[Node:McpFillGaps] memory.search failed for "${description}": ${searchErr.message}`);
    }

    // 3. Broader text search fallback via memory.search with lower threshold
    // (replaces non-existent raw SQL /query against memory table)
    try {
      const textResult = await mcpClient.callService('user-memory', 'memory.search', {
        query: `${description} ${key}`,
        limit: 3,
        minSimilarity: 0.2,
      }, { timeoutMs: 4000 });
      const results = textResult?.data?.results || textResult?.results || [];
      const top = results[0];
      if (top) {
        const text = top.source_text || top.content || top.text || top.value || '';
        const extracted = extractValueFromText(text, description);
        if (extracted) {
          return {
            value: extracted,
            source: top.type || 'memory',
            confidence: 0.5,
          };
        }
      }
    } catch (textErr) {
      logger.debug(`[Node:McpFillGaps] memory.search (broad) failed for "${key}": ${textErr.message}`);
    }

    // 4. Check recent conversation messages via conversation.message.list
    try {
      const convResult = await mcpClient.callService('conversation', 'message.list', {
        limit: 20,
        role: 'user',
      }, { timeoutMs: 3000 });
      const msgs = convResult?.data?.messages || convResult?.messages || [];
      const descLower = description.toLowerCase();
      const keyLower = key.toLowerCase();
      const match = msgs.find(m => {
        const c = (m.content || m.text || '').toLowerCase();
        return c.includes(descLower) || c.includes(keyLower);
      });
      if (match) {
        const extracted = extractValueFromText(match.content || match.text, description);
        if (extracted) {
          return {
            value: extracted,
            source: 'conversation',
            confidence: 0.7,
          };
        }
      }
    } catch (convErr) {
      logger.debug(`[Node:McpFillGaps] conversation.message.list failed: ${convErr.message}`);
    }

  } catch (e) {
    logger.warn(`[Node:McpFillGaps] MCP query failed for ${key}: ${e.message}`);
  }

  return null;
}

async function searchWebForNeed(need, mcpClient, llmBackend) {
  if (need.type !== 'external_knowledge') return null;
  
  try {
    // Generate search query from description
    let searchQuery = need.description;
    if (llmBackend) {
      const queryPrompt = `Convert "${need.description}" into a concise web search query (max 10 words). Return ONLY the query.`;
      searchQuery = await llmBackend.generateAnswer(queryPrompt, { temperature: 0, maxTokens: 50 });
      searchQuery = searchQuery.replace(/["']/g, '').trim();
    }
    
    const webResult = await mcpClient.callService('web-search', 'web.search', {
      query: searchQuery,
      limit: 3
    });
    
    const _webResults = webResult?.data?.results || webResult?.results || [];
    if (_webResults.length > 0) {
      const synthesized = await synthesizeWebResults(_webResults, need.description, llmBackend);
      return {
        value: synthesized,
        source: 'web_search',
        confidence: 0.75
      };
    }
  } catch (e) {
    logger.warn(`[Node:McpFillGaps] Web search failed for ${need.key}: ${e.message}`);
  }
  
  return null;
}

async function synthesizeWebResults(results, description, llmBackend) {
  if (!llmBackend) {
    // Simple concatenation if no LLM available
    return results.slice(0, 2).map(r => r.snippet || r.content).join('\n\n');
  }
  
  const synthesizePrompt = `Extract the answer to "${description}" from these web results:

${results.slice(0, 3).map((r, i) => `${i+1}. ${r.title}\n${r.snippet || r.content}`).join('\n\n')}

Provide a concise, factual answer. If multiple options exist, list them.`;
  
  return await llmBackend.generateAnswer(synthesizePrompt, { temperature: 0.3, maxTokens: 300 });
}

function extractValueFromText(text, description, llmBackend) {
  if (!text) return null;
  
  // Pattern-based extraction for common types
  const patterns = {
    email: /[\w._%+-]+@[\w.-]+\.[a-z]{2,}/i,
    phone: /\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    name: /\b(?:name is|I'm|I am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  };
  
  // Check if description matches a pattern type
  for (const [type, pattern] of Object.entries(patterns)) {
    if (description.toLowerCase().includes(type)) {
      const match = text.match(pattern);
      if (match) {
        // For name pattern, capture group 1 contains the name
        return type === 'name' ? match[1] : match[0];
      }
    }
  }
  
  // For other types, return the relevant snippet
  // This is a simplified version - could be enhanced with LLM
  const sentences = text.split(/[.!?]+/);
  for (const sentence of sentences) {
    if (sentence.toLowerCase().includes(description.toLowerCase().split(' ')[0])) {
      return sentence.trim();
    }
  }
  
  return text.slice(0, 200); // Return first 200 chars as fallback
}

function postProgress(state, event) {
  if (state.progressCallback) {
    try {
      state.progressCallback(event);
    } catch (e) {
      logger.warn(`[Node:McpFillGaps] Progress callback failed: ${e.message}`);
    }
  }
}

module.exports = async function mcpFillGaps(state) {
  if (!state._grillMode) {
    logger.debug('[Node:McpFillGaps] Grill mode not active, skipping');
    return state;
  }
  
  if (!state.mcpAdapter) {
    logger.warn('[Node:McpFillGaps] No MCP adapter available, skipping');
    return state;
  }
  
  logger.info('[Node:McpFillGaps] Starting MCP gap filling');
  postProgress(state, { type: 'mcp:fill_start', message: 'Checking memory for known information...' });
  
  const mcpClient = state.mcpAdapter;
  const llmBackend = state.llmBackend;
  
  try {
    // Extract what information is needed
    const needs = await extractInformationNeeds(state.message, {
      ...state.riskContext,
      llmBackend
    });
    
    if (needs.length === 0) {
      logger.info('[Node:McpFillGaps] No information needs extracted');
      postProgress(state, { type: 'mcp:fill_complete', filledCount: 0, remainingCount: 0 });
      return state;
    }
    
    logger.info(`[Node:McpFillGaps] Extracted ${needs.length} information needs: ${needs.map(n => n.key).join(', ')}`);
    
    const mcpFilled = {};
    
    for (const need of needs) {
      logger.info(`[Node:McpFillGaps] Searching for: ${need.description} (${need.key})`);
      
      // Try MCP services first
      let answer = await queryMcpForAnswer(need, mcpClient, llmBackend);
      
      // If not found in memory, try web for external knowledge
      if (!answer && need.type === 'external_knowledge') {
        logger.info(`[Node:McpFillGaps] Trying web search for: ${need.key}`);
        answer = await searchWebForNeed(need, mcpClient, llmBackend);
      }
      
      if (answer) {
        mcpFilled[need.key] = {
          value: answer.value,
          source: answer.source,
          confidence: answer.confidence
        };
        
        logger.info(`[Node:McpFillGaps] Found ${need.key} from ${answer.source} (confidence: ${answer.confidence})`);
        
        postProgress(state, {
          type: 'mcp:fill_found',
          key: need.key,
          source: answer.source,
          confidence: answer.confidence,
          message: `Found ${need.description} in ${answer.source}`
        });
      } else {
        logger.info(`[Node:McpFillGaps] Could not find ${need.key} in any MCP source`);
      }
    }
    
    const filledCount = Object.keys(mcpFilled).length;
    const remainingCount = needs.length - filledCount;
    
    postProgress(state, {
      type: 'mcp:fill_complete',
      filledCount,
      remainingCount,
      message: filledCount > 0 
        ? `Auto-filled ${filledCount} answers from memory` 
        : 'No previous information found'
    });
    
    logger.info(`[Node:McpFillGaps] Complete: ${filledCount}/${needs.length} filled, ${remainingCount} remaining`);
    
    return {
      ...state,
      mcpFilledAnswers: mcpFilled,
      mcpFilledCount: filledCount
    };
    
  } catch (e) {
    logger.error(`[Node:McpFillGaps] Error: ${e.message}`);
    postProgress(state, { 
      type: 'mcp:fill_error', 
      error: e.message,
      message: 'Error checking memory sources'
    });
    return state;
  }
};

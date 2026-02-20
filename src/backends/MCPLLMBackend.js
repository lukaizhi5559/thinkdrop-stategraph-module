/**
 * MCPLLMBackend - Uses local phi4 MCP service for answer generation
 * 
 * Mirrors the PRIVATE MODE path in the original answer.cjs:
 *   - Streaming: mcpClient.callServiceStream('phi4', 'general.answer.stream', ...)
 *   - Blocking:  mcpClient.callService('phi4', 'general.answer', ...)
 * 
 * The mcpAdapter must implement:
 *   - callService(service, action, payload, options)
 *   - callServiceStream(service, action, payload, onToken, onProgress)
 *   - isServiceAvailable(service)
 */

const LLMBackend = require('./LLMBackend');

class MCPLLMBackend extends LLMBackend {
  /**
   * @param {Object} mcpAdapter - MCP adapter (MockMCPAdapter or RealMCPAdapter)
   */
  constructor(mcpAdapter) {
    super();
    this.mcpAdapter = mcpAdapter;
  }

  /**
   * Generate answer via phi4 MCP service.
   * Uses streaming if onToken callback provided, blocking otherwise.
   * Falls back to blocking if streaming produces no content (mirrors answer.cjs behavior).
   */
  async generateAnswer(prompt, payload, options = {}, onToken = null) {
    const isStreaming = typeof onToken === 'function';
    const timeout = (payload.context?.webSearchResults?.length > 0) ? 60000 : 30000;

    if (isStreaming) {
      let accumulated = '';

      try {
        await this.mcpAdapter.callServiceStream(
          'phi4',
          'general.answer.stream',
          payload,
          (token) => {
            accumulated += token;
            onToken(token);
          },
          (progress) => {
            // progress events: { type: 'start' | 'done' }
          }
        );

        // If streaming produced content, return it
        if (accumulated && accumulated.trim().length > 0) {
          return accumulated;
        }

        // Streaming produced no content - fall back to blocking
        console.warn('[MCPLLMBackend] Streaming produced no content, falling back to blocking call');
      } catch (streamErr) {
        console.warn('[MCPLLMBackend] Streaming failed, falling back to blocking:', streamErr.message);
      }

      // Fallback: blocking call
      const result = await this.mcpAdapter.callService('phi4', 'general.answer', payload, { timeout });
      const data = result.data || result;
      const answer = data.answer || data.text || '';

      // Re-emit the full answer as a single token so the UI still gets it
      if (answer && onToken) {
        onToken(answer);
      }

      return answer;
    }

    // Blocking mode
    const result = await this.mcpAdapter.callService('phi4', 'general.answer', payload, { timeout });
    const data = result.data || result;
    return data.answer || data.text || 'I apologize, but I was unable to generate a response.';
  }

  async isAvailable() {
    try {
      return await this.mcpAdapter.isServiceAvailable('phi4');
    } catch {
      return false;
    }
  }

  getInfo() {
    return {
      name: 'MCP Phi4',
      type: 'mcp',
      model: 'phi-4',
      provider: 'local'
    };
  }
}

module.exports = MCPLLMBackend;

/**
 * LLMBackend - Abstract base class for pluggable LLM backends
 * 
 * Used by the answer.js node to generate responses.
 * Mirrors the existing dual-mode pattern in answer.cjs (online/private)
 * but makes it fully pluggable.
 * 
 * Implementations:
 *   - MCPLLMBackend    → phi4 via MCP callService/callServiceStream
 *   - VSCodeLLMBackend → WebSocket pass-through to VS Code Copilot
 *   - ExternalLLMBackend → HTTP endpoint (Rust/Go/Python/Node process)
 */

class LLMBackend {
  /**
   * Generate an answer from a fully-built prompt.
   * 
   * @param {string} prompt - The complete prompt (query + context already assembled)
   * @param {Object} payload - Full payload object (matches phi4 shape: { query, context, options })
   * @param {Object} options - Generation options
   * @param {number} [options.maxTokens=500] - Max tokens to generate
   * @param {number} [options.temperature=0.1] - Sampling temperature
   * @param {boolean} [options.fastMode=false] - Skip heavy system prompts
   * @param {Function|null} onToken - Streaming callback (token: string) => void, or null for blocking
   * @returns {Promise<string>} The generated answer text
   */
  async generateAnswer(prompt, payload, options = {}, onToken = null) {
    throw new Error(`${this.constructor.name}.generateAnswer() must be implemented`);
  }

  /**
   * Check if this backend is currently reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    throw new Error(`${this.constructor.name}.isAvailable() must be implemented`);
  }

  /**
   * Backend metadata for logging and UI display.
   * @returns {{ name: string, type: string, model: string, provider: string }}
   */
  getInfo() {
    throw new Error(`${this.constructor.name}.getInfo() must be implemented`);
  }
}

module.exports = LLMBackend;

/**
 * ExternalLLMBackend - HTTP endpoint for any external LLM process
 * 
 * Supports any Rust/Go/Python/Node backend that exposes an HTTP API.
 * 
 * Expected HTTP contract:
 *   POST {httpUrl}
 *   Body: { prompt, query, context, options }
 *   Response: { answer } or { text }
 * 
 * Optional streaming via Server-Sent Events (SSE):
 *   POST {httpUrl}/stream
 *   Response: text/event-stream  data: {"token":"..."}\n\n
 *                                data: [DONE]\n\n
 * 
 * Health check:
 *   GET {httpUrl}/health  → { status: 'ok' | 'healthy' }
 */

const LLMBackend = require('./LLMBackend');

class ExternalLLMBackend extends LLMBackend {
  /**
   * @param {Object} config
   * @param {string} config.httpUrl - Blocking answer endpoint (POST)
   * @param {string} [config.streamUrl] - SSE streaming endpoint (POST). Defaults to {httpUrl}/stream
   * @param {number} [config.timeoutMs=30000] - Request timeout
   * @param {Object} [config.headers={}] - Extra headers (e.g. Authorization)
   * @param {boolean} [config.supportsStreaming=false] - Whether service supports SSE streaming
   */
  constructor(config = {}) {
    super();
    if (!config.httpUrl) {
      throw new Error('[ExternalLLMBackend] config.httpUrl is required');
    }
    this.httpUrl = config.httpUrl.replace(/\/$/, ''); // strip trailing slash
    this.streamUrl = config.streamUrl
      ? config.streamUrl.replace(/\/$/, '')
      : `${this.httpUrl}/stream`;
    this.timeoutMs = config.timeoutMs || 30000;
    this.headers = { 'Content-Type': 'application/json', ...(config.headers || {}) };
    this.supportsStreaming = config.supportsStreaming || false;
  }

  async generateAnswer(prompt, payload, options = {}, onToken = null) {
    const body = JSON.stringify({
      prompt,
      query: payload.query || prompt,
      context: payload.context || {},
      options: {
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 500,
        ...options
      }
    });

    // Use SSE streaming if supported and onToken provided
    if (this.supportsStreaming && typeof onToken === 'function') {
      return this._streamAnswer(body, onToken);
    }

    // Blocking HTTP call
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetch = this._getFetch();
      const res = await fetch(this.httpUrl, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: controller.signal
      });

      clearTimeout(t);

      if (!res.ok) {
        throw new Error(`[ExternalLLMBackend] HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      return data.answer || data.text || data.response || 'I apologize, but I was unable to generate a response.';

    } catch (err) {
      clearTimeout(t);
      throw err;
    }
  }

  /**
   * SSE streaming via POST to {httpUrl}/stream
   */
  async _streamAnswer(body, onToken) {
    const fetch = this._getFetch();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.streamUrl, {
        method: 'POST',
        headers: { ...this.headers, Accept: 'text/event-stream' },
        body,
        signal: controller.signal
      });

      clearTimeout(t);

      if (!res.ok) {
        throw new Error(`[ExternalLLMBackend] Stream HTTP ${res.status}: ${res.statusText}`);
      }

      let accumulated = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();

          // Legacy string terminator
          if (raw === '[DONE]') break;

          try {
            const parsed = JSON.parse(raw);

            // Typed format: { type: 'start'|'token'|'done'|'error', token? }
            if (parsed.type === 'done' || parsed.type === 'error') break;
            if (parsed.type === 'start') continue;

            const token = parsed.token || parsed.text || parsed.chunk || '';
            if (token) {
              accumulated += token;
              onToken(token);
            }
          } catch {
            // non-JSON SSE line, skip
          }
        }
      }

      return accumulated || 'I apologize, but I was unable to generate a response.';

    } catch (err) {
      clearTimeout(t);
      throw err;
    }
  }

  async isAvailable() {
    try {
      const fetch = this._getFetch();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${this.httpUrl}/health`, {
        method: 'GET',
        headers: this.headers,
        signal: controller.signal
      });

      clearTimeout(t);

      if (!res.ok) return false;
      const data = await res.json();
      return data.status === 'ok' || data.status === 'healthy';
    } catch {
      return false;
    }
  }

  /**
   * Get fetch - works in Node.js 18+ (native) or falls back to node-fetch
   */
  _getFetch() {
    if (typeof fetch !== 'undefined') return fetch;
    try {
      return require('node-fetch');
    } catch {
      throw new Error('[ExternalLLMBackend] No fetch available. Node 18+ or install node-fetch.');
    }
  }

  getInfo() {
    return {
      name: 'External LLM',
      type: 'external',
      model: 'custom',
      provider: 'http',
      httpUrl: this.httpUrl,
      streamUrl: this.streamUrl
    };
  }
}

module.exports = ExternalLLMBackend;

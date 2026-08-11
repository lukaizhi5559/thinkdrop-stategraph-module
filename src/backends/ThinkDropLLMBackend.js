/**
 * ThinkDropLLMBackend - WebSocket pass-through to the ThinkDrop backend LLM router
 * 
 * Mirrors the ONLINE MODE path in the original answer.cjs:
 *   ws://localhost:4000/ws/stream with protocol:
 *     SEND:    { id, type: 'llm_request', payload: { prompt, provider, options, context } }
 *     RECEIVE: { type: 'llm_stream_start' }
 *              { type: 'llm_stream_chunk', payload: { chunk } }
 *              { type: 'llm_stream_end' }
 *              { type: 'error', payload: { message } }
 * 
 * Connects to the ThinkDrop backend's WebSocket LLM endpoint, which routes
 * requests to free/paid LLM providers based on taskType hints.
 */

const LLMBackend = require('./LLMBackend');

class ThinkDropLLMBackend extends LLMBackend {
  /**
   * @param {Object} config
   * @param {string} [config.wsUrl='ws://localhost:4000/ws/stream'] - WebSocket endpoint
   * @param {string} [config.apiKey=''] - API key sent as query param
   * @param {string} [config.userId='default_user'] - User ID sent as query param
   * @param {number} [config.connectTimeoutMs=5000] - Connection timeout
   * @param {number} [config.responseTimeoutMs=60000] - Response timeout
   */
  constructor(config = {}) {
    super();
    this.wsUrl = config.wsUrl || process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
    this.apiKey = config.apiKey || process.env.WEBSOCKET_API_KEY || '';
    this.userId = config.userId || 'default_user';
    this.connectTimeoutMs = config.connectTimeoutMs || 5000;
    this.responseTimeoutMs = config.responseTimeoutMs || 60000;
  }

  /**
   * Generate answer via WebSocket LLM backend.
   * Always streams - accumulates and returns full answer.
   * If onToken provided, forwards each chunk in real time.
   */
  async generateAnswer(prompt, payload, options = {}, onToken = null) {
    // Lazy require so this module works in environments without 'ws'
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch {
      throw new Error('[ThinkDropLLMBackend] "ws" package not installed. Run: npm install ws');
    }

    // Build authenticated URL
    const url = new URL(this.wsUrl);
    if (this.apiKey) url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('userId', this.userId);
    url.searchParams.set('clientId', `stategraph_${Date.now()}`);

    const ws = new WebSocket(url.toString());

    // Wait for connection
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.terminate();
        reject(new Error('[ThinkDropLLMBackend] Connection timeout'));
      }, this.connectTimeoutMs);

      ws.on('open', () => { clearTimeout(t); resolve(); });
      ws.on('error', (err) => { clearTimeout(t); reject(err); });
    });

    // Send request
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const context = payload.context || {};

    ws.send(JSON.stringify({
      id: requestId,
      type: 'llm_request',
      payload: {
        prompt: payload.query || prompt,
        provider: options.provider || 'auto',
        options: {
          temperature: options.temperature || 0.7,
          stream: true,
          taskType: options.taskType || 'planning'
        },
        context: {
          recentContext: (context.conversationHistory || []).map(msg => ({
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            formattedDate: msg.formattedDate || { absolute: msg.timestamp, relative: '' }
          })),
          sessionFacts: context.sessionFacts || [],
          sessionEntities: context.sessionEntities || [],
          memories: (context.memories || []).map(mem => ({
            ...mem,
            formattedDate: mem.formattedDate || { absolute: mem.created_at, relative: '', iso: mem.created_at }
          })),
          webSearchResults: context.webSearchResults || [],
          systemInstructions: context.systemInstructions || ''
        }
      },
      timestamp: Date.now(),
      metadata: {
        source: 'stategraph_module',
        sessionId: context.sessionId,
        userId: context.userId || this.userId
      }
    }));

    // Collect streaming response
    let accumulated = '';
    let streamStarted = false;

    await new Promise((resolve, reject) => {
      let activeTimeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('[ThinkDropLLMBackend] Response timeout'));
      }, this.responseTimeoutMs);

      const resetTimeout = () => {
        clearTimeout(activeTimeout);
        activeTimeout = setTimeout(() => {
          ws.terminate();
          reject(new Error('[ThinkDropLLMBackend] Response timeout'));
        }, this.responseTimeoutMs);
      };

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'llm_stream_start') {
            streamStarted = true;
            clearTimeout(activeTimeout);

          } else if (msg.type === 'llm_stream_fallback') {
            // Preferred provider failed — fallback in progress, keep connection alive
            resetTimeout();

          } else if (msg.type === 'llm_stream_chunk') {
            const chunk = msg.payload?.chunk || msg.payload?.text || '';
            if (chunk) {
              accumulated += chunk;
              if (onToken) onToken(chunk);
            }

          } else if (msg.type === 'llm_stream_end') {
            clearTimeout(activeTimeout);
            ws.close();
            resolve();

          } else if (msg.type === 'llm_error') {
            // Terminal error — all providers exhausted
            clearTimeout(activeTimeout);
            ws.close();
            const llmErrMsg = msg.payload?.message || 'WebSocket LLM error';
            if (/All LLM providers failed/i.test(llmErrMsg)) {
              this._resetCircuitBreaker();
            }
            reject(new Error(llmErrMsg));
          } else if (msg.type === 'error') {
            // Legacy/non-streaming error — treat as terminal
            clearTimeout(activeTimeout);
            ws.close();
            reject(new Error(msg.payload?.message || 'WebSocket LLM error'));
          }
        } catch (e) {
          // ignore parse errors on individual messages
        }
      });

      ws.on('error', (err) => {
        clearTimeout(activeTimeout);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(activeTimeout);
        if (!streamStarted) {
          reject(new Error('[ThinkDropLLMBackend] Connection closed before stream started'));
        } else {
          resolve();
        }
      });
    });

    const fallback = 'I apologize, but I was unable to generate a response.';
    if (!accumulated) {
      // Copilot returned an empty stream — emit fallback via onToken so the UI shows it
      if (onToken) onToken(fallback);
      return fallback;
    }
    return accumulated;
  }

  /**
   * Fire-and-forget: POST /api/circuit-breaker/reset to clear all stuck-open
   * provider breakers after an "All LLM providers failed" error, so the next
   * prompt succeeds without requiring a backend restart.
   */
  _resetCircuitBreaker() {
    try {
      const http = require('http');
      // Derive HTTP base from wsUrl: ws://localhost:4000/ws/stream → http://localhost:4000
      const httpBase = this.wsUrl
        .replace(/^wss?:\/\//, 'http://')
        .replace(/\/ws\/.*$/, '');
      const parsed = new URL('/api/circuit-breaker/reset', httpBase);
      const body = '{}';
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 3000,
        },
        (res) => { res.resume(); }
      );
      req.on('error', () => {});
      req.on('timeout', () => { req.destroy(); });
      req.write(body);
      req.end();
      console.log('[ThinkDropLLMBackend] Circuit breaker reset triggered');
    } catch (_) {
      // non-fatal
    }
  }

  async isAvailable() {
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      try {
        const url = new URL(this.wsUrl);
        if (this.apiKey) url.searchParams.set('apiKey', this.apiKey);
        url.searchParams.set('userId', this.userId);
        url.searchParams.set('clientId', `health_${Date.now()}`);

        const ws = new WebSocket(url.toString());
        const t = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);

        ws.on('open', () => { clearTimeout(t); ws.close(); resolve(true); });
        ws.on('error', () => { clearTimeout(t); resolve(false); });
      } catch {
        resolve(false);
      }
    });
  }

  getInfo() {
    return {
      name: 'ThinkDrop WebSocket LLM',
      type: 'thinkdrop',
      model: 'auto-routed',
      provider: 'websocket',
      wsUrl: this.wsUrl
    };
  }
}

module.exports = ThinkDropLLMBackend;

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

    // ── Persistent WebSocket connection pool ──────────────────────────────
    // Reuses WebSocket connections across generateAnswer() calls to eliminate
    // ~1-2s TCP handshake + WS upgrade overhead per call. Each connection
    // handles one request at a time; overflow requests create temporary
    // connections that are closed after use.
    this._maxPoolSize = 2;
    this._wsPool = []; // Array of { ws, busy }
  }

  /**
   * Build an authenticated WebSocket URL for a new connection.
   * @private
   */
  _buildPoolUrl() {
    const url = new URL(this.wsUrl);
    if (this.apiKey) url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('userId', this.userId);
    url.searchParams.set('clientId', `stategraph_pool_${Math.random().toString(36).slice(2, 8)}`);
    return url.toString();
  }

  /**
   * Acquire a WebSocket connection from the pool, or create a new one.
   * @private
   * @returns {Promise<{ws: WebSocket, pooled: boolean}>}
   */
  async _acquireWs() {
    let WebSocket;
    try { WebSocket = require('ws'); } catch {
      throw new Error('[ThinkDropLLMBackend] "ws" package not installed. Run: npm install ws');
    }

    // Find a free, healthy connection in the pool
    for (let i = this._wsPool.length - 1; i >= 0; i--) {
      const entry = this._wsPool[i];
      if (entry.ws.readyState !== WebSocket.OPEN) {
        // Stale/closed connection — remove from pool
        this._wsPool.splice(i, 1);
        continue;
      }
      if (!entry.busy) {
        entry.busy = true;
        // Remove only message listeners from previous requests
        entry.ws.removeAllListeners('message');
        return { ws: entry.ws, pooled: true };
      }
    }

    // No free connection — create a new one
    const ws = new WebSocket(this._buildPoolUrl());

    // Connect with timeout
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.terminate();
        reject(new Error('[ThinkDropLLMBackend] Connection timeout'));
      }, this.connectTimeoutMs);
      ws.on('open', () => { clearTimeout(t); resolve(); });
      ws.on('error', (err) => { clearTimeout(t); reject(err); });
    });

    // If pool isn't full, add to pool for reuse; otherwise it's a temporary connection
    const pooled = this._wsPool.length < this._maxPoolSize;
    if (pooled) {
      const entry = { ws, busy: true };
      this._wsPool.push(entry);
      // Permanent error/close handler — removes from pool on drop
      ws.on('error', (err) => {
        console.warn(`[ThinkDropLLMBackend] Pool connection error: ${err.message}`);
        this._wsPool = this._wsPool.filter(e => e !== entry);
      });
      ws.on('close', () => {
        this._wsPool = this._wsPool.filter(e => e !== entry);
      });
    }

    return { ws, pooled };
  }

  /**
   * Release a WebSocket connection back to the pool, or close it if temporary/errored.
   * @private
   * @param {WebSocket} ws
   * @param {boolean} errored — if true, destroy the connection
   */
  _releaseWs(ws, errored = false) {
    const entry = this._wsPool.find(e => e.ws === ws);
    if (!entry) {
      // Temporary connection (pool was full) — close it
      try { ws.close(); } catch {}
      return;
    }
    if (errored || ws.readyState !== 1) {
      // Broken connection — remove from pool and close
      this._wsPool = this._wsPool.filter(e => e !== entry);
      try { ws.close(); } catch {}
      return;
    }
    // Healthy — return to pool for reuse
    entry.busy = false;
    // Clean up per-request message listeners
    ws.removeAllListeners('message');
  }

  /**
   * Generate answer via WebSocket LLM backend.
   * Always streams - accumulates and returns full answer.
   * If onToken provided, forwards each chunk in real time.
   */
  async generateAnswer(prompt, payload, options = {}, onToken = null) {
    // Acquire a connection from the pool (reuses persistent connections)
    const { ws, pooled } = await this._acquireWs();
    let _errored = false;

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
          // command_automate planning needs paid providers (complex) — free models can't handle complex JSON
          taskType: options.taskType || (context.intent === 'command_automate' ? 'complex' : 'planning')
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

    // Dynamic timeout based on taskType — complex/super-heavy need much more time
    const _taskType = options.taskType || (context.intent === 'command_automate' ? 'complex' : 'planning');
    const _dynamicTimeoutMs = _taskType === 'complex' ? 240_000
      : _taskType === 'super-heavy' ? 180_000
      : _taskType === 'heavy' ? 90_000
      : this.responseTimeoutMs; // light/planning — keep default 60s

    try {
      await new Promise((resolve, reject) => {
        let activeTimeout = setTimeout(() => {
          _errored = true;
          ws.terminate();
          reject(new Error('[ThinkDropLLMBackend] Response timeout'));
        }, _dynamicTimeoutMs);

        const resetTimeout = () => {
          clearTimeout(activeTimeout);
          activeTimeout = setTimeout(() => {
            _errored = true;
            ws.terminate();
            reject(new Error('[ThinkDropLLMBackend] Response timeout'));
          }, _dynamicTimeoutMs);
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
              // Don't close pooled connections — release them back to the pool
              resolve();

            } else if (msg.type === 'llm_error') {
              // Terminal error — all providers exhausted
              clearTimeout(activeTimeout);
              _errored = true;
              const llmErrMsg = msg.payload?.message || 'WebSocket LLM error';
              if (/All LLM providers failed/i.test(llmErrMsg)) {
                this._resetCircuitBreaker();
              }
              reject(new Error(llmErrMsg));
            } else if (msg.type === 'error') {
              // Legacy/non-streaming error — treat as terminal
              clearTimeout(activeTimeout);
              _errored = true;
              reject(new Error(msg.payload?.message || 'WebSocket LLM error'));
            }
          } catch (e) {
            // ignore parse errors on individual messages
          }
        });

        ws.on('error', (err) => {
          clearTimeout(activeTimeout);
          _errored = true;
          reject(err);
        });

        ws.on('close', () => {
          clearTimeout(activeTimeout);
          if (!streamStarted) {
            _errored = true;
            reject(new Error('[ThinkDropLLMBackend] Connection closed before stream started'));
          } else {
            resolve();
          }
        });
      });
    } finally {
      // Release the connection back to the pool (or close if temporary/errored)
      this._releaseWs(ws, _errored);
    }

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

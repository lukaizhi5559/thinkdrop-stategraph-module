/**
 * VSCodeLLMBackend - WebSocket pass-through to VS Code Copilot (or any WebSocket LLM)
 * 
 * Mirrors the ONLINE MODE path in the original answer.cjs:
 *   ws://localhost:4000/ws/stream with protocol:
 *     SEND:    { id, type: 'llm_request', payload: { prompt, provider, options, context } }
 *     RECEIVE: { type: 'llm_stream_start' }
 *              { type: 'llm_stream_chunk', payload: { chunk } }
 *              { type: 'llm_stream_end' }
 *              { type: 'error', payload: { message } }
 * 
 * Can also be used for any WebSocket-based LLM backend (not just VS Code).
 */

const LLMBackend = require('./LLMBackend');

class VSCodeLLMBackend extends LLMBackend {
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
      throw new Error('[VSCodeLLMBackend] "ws" package not installed. Run: npm install ws');
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
        reject(new Error('[VSCodeLLMBackend] Connection timeout'));
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
        provider: options.provider || 'openai',
        options: {
          temperature: options.temperature || 0.7,
          stream: true,
          taskType: 'ask'
        },
        context: {
          recentContext: (context.conversationHistory || []).map(msg => ({
            role: msg.role,
            content: msg.content,
            timestamp: new Date().toISOString()
          })),
          sessionFacts: context.sessionFacts || [],
          sessionEntities: context.sessionEntities || [],
          memories: context.memories || [],
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
      const responseTimeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('[VSCodeLLMBackend] Response timeout'));
      }, this.responseTimeoutMs);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'llm_stream_start') {
            streamStarted = true;
            clearTimeout(responseTimeout);

          } else if (msg.type === 'llm_stream_chunk') {
            const chunk = msg.payload?.chunk || msg.payload?.text || '';
            if (chunk) {
              accumulated += chunk;
              if (onToken) onToken(chunk);
            }

          } else if (msg.type === 'llm_stream_end') {
            clearTimeout(responseTimeout);
            ws.close();
            resolve();

          } else if (msg.type === 'error') {
            clearTimeout(responseTimeout);
            ws.close();
            reject(new Error(msg.payload?.message || 'WebSocket LLM error'));
          }
        } catch (e) {
          // ignore parse errors on individual messages
        }
      });

      ws.on('error', (err) => {
        clearTimeout(responseTimeout);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(responseTimeout);
        if (!streamStarted) {
          reject(new Error('[VSCodeLLMBackend] Connection closed before stream started'));
        } else {
          resolve();
        }
      });
    });

    return accumulated || 'I apologize, but I was unable to generate a response.';
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
      name: 'VS Code / WebSocket LLM',
      type: 'vscode',
      model: 'copilot',
      provider: 'websocket',
      wsUrl: this.wsUrl
    };
  }
}

module.exports = VSCodeLLMBackend;

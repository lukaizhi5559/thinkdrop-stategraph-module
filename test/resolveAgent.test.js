'use strict';
/**
 * resolveAgent.test.js
 *
 * Unit tests for the dynamic start-URL discovery in stategraph-module/src/nodes/resolveAgent.js.
 *
 * Run from repo root with:
 *   node stategraph-module/test/resolveAgent.test.js
 */

const http = require('http');
const path = require('path');

const resolveAgent = require(path.resolve(__dirname, '..', 'src/nodes/resolveAgent.js'));
const {
  _fallbackStartUrl,
  _isParkingContent,
  _verifyDiscoveredUrl,
  _resolveStartUrlForService,
  _discoverVerifiedStartUrl,
} = resolveAgent;

let _passed = 0;
let _failed = 0;
const _failures = [];

async function it(label, fn) {
  try {
    await fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}\n     ${e.message}`);
  }
}

function section(label) {
  console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`);
}

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        handler(req, res);
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function makeMcpAdapter({ cachedUrl, discoveredUrl, writable = true }) {
  const calls = [];
  return {
    calls,
    async callService(service, action, payload, opts) {
      calls.push({ service, action, payload, opts });
      if (service === 'user-memory' && action === 'profile.get') {
        return cachedUrl ? { data: { valueRef: cachedUrl } } : { data: null };
      }
      if (service === 'user-memory' && action === 'profile.set') {
        if (!writable) throw new Error('profile.set disabled');
        return { ok: true };
      }
      if (service === 'command' && action === 'web.agent') {
        return discoveredUrl ? { data: { bestUrl: discoveredUrl } } : { ok: false, error: 'no results' };
      }
      return null;
    },
  };
}

async function runTests() {
  section('Fallback URL generation');
  await it('generates a standard www fallback', () => {
    if (_fallbackStartUrl('foo') !== 'https://www.foo.com') {
      throw new Error('fallback URL mismatch');
    }
  });
  await it('preserves normalized service key in fallback', () => {
    if (_fallbackStartUrl('openai') !== 'https://www.openai.com') {
      throw new Error('fallback URL mismatch');
    }
  });

  section('Parking content detection');
  await it('detects parking text', () => {
    if (!_isParkingContent('This domain is for sale - make an offer')) {
      throw new Error('should be parking content');
    }
  });
  await it('accepts normal page text', () => {
    if (_isParkingContent('Welcome to Gmail. Secure email for everyone.')) {
      throw new Error('should not be parking content');
    }
  });

  section('HTTP verification');
  let server;
  let serverUrl;
  try {
    const s = await startTestServer((req, res) => {
      if (req.url === '/good') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Foo Official Site</title></head><body>Welcome to Foo</body></html>');
      } else if (req.url === '/parking') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Domain is for sale</title></head><body>Buy this domain</body></html>');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/good' });
        res.end();
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server = s.server;
    serverUrl = s.url;

    await it('accepts a reachable, relevant page', async () => {
      const v = await _verifyDiscoveredUrl(`${serverUrl}/good`, 'foo');
      if (!v.ok) throw new Error(`Expected ok but got ${v.reason}`);
    });
    await it('rejects a parking page', async () => {
      const v = await _verifyDiscoveredUrl(`${serverUrl}/parking`, 'foo');
      if (v.ok) throw new Error('Expected parking-content rejection');
      if (v.reason !== 'parking-content') throw new Error(`Expected parking-content but got ${v.reason}`);
    });
    await it('follows redirects and verifies the landing page', async () => {
      const v = await _verifyDiscoveredUrl(`${serverUrl}/redirect`, 'foo');
      if (!v.ok) throw new Error(`Expected ok but got ${v.reason}`);
    });
    await it('rejects an unreachable page', async () => {
      const v = await _verifyDiscoveredUrl(`${serverUrl}/missing`, 'foo');
      if (v.ok) throw new Error('Expected rejection');
    });
    await it('rejects a domain mismatch when title/body does not contain service', async () => {
      const v = await _verifyDiscoveredUrl(`${serverUrl}/good`, 'bar');
      if (v.ok) throw new Error('Expected domain-mismatch rejection');
      if (v.reason !== 'domain-mismatch') throw new Error(`Expected domain-mismatch but got ${v.reason}`);
    });
  } finally {
    if (server) server.close();
  }

  section('Dynamic discovery with cache');
  let cacheServer;
  let cacheUrl;
  try {
    const s = await startTestServer((req, res) => {
      if (req.url === '/cached') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Foo Official Site</title></head><body>Welcome to Foo</body></html>');
      } else if (req.url === '/discovered') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Baz Official Site</title></head><body>Welcome to Baz</body></html>');
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    cacheServer = s.server;
    cacheUrl = s.url;

    await it('returns cached URL when it verifies', async () => {
      const adapter = makeMcpAdapter({ cachedUrl: `${cacheUrl}/cached`, discoveredUrl: 'http://127.0.0.1:1/no' });
      const url = await _discoverVerifiedStartUrl('foo', adapter, console);
      if (url !== `${cacheUrl}/cached`) throw new Error(`Expected cached URL, got ${url}`);
      const webCalls = adapter.calls.filter(c => c.service === 'command' && c.action === 'web.agent');
      if (webCalls.length !== 0) throw new Error('web.agent should not be called when cache hits');
    });

    await it('rediscovers and caches when the cached URL no longer verifies', async () => {
      const adapter = makeMcpAdapter({ cachedUrl: `${cacheUrl}/missing`, discoveredUrl: `${cacheUrl}/discovered` });
      const url = await _discoverVerifiedStartUrl('baz', adapter, console);
      if (url !== `${cacheUrl}/discovered`) throw new Error(`Expected discovered URL, got ${url}`);
      const setCalls = adapter.calls.filter(c => c.service === 'user-memory' && c.action === 'profile.set');
      if (setCalls.length !== 1) throw new Error('Expected one profile.set call');
      if (setCalls[0].payload.key !== 'nav-start-url:baz') throw new Error('Wrong cache key');
      if (setCalls[0].payload.valueRef !== `${cacheUrl}/discovered`) throw new Error('Wrong cached value');
    });
  } finally {
    if (cacheServer) cacheServer.close();
  }

  await it('discovers, verifies, and caches a new URL when cache is empty', async () => {
    let server2;
    let url2;
    try {
      const s = await startTestServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Qux Official Site</title></head><body>Welcome to Qux</body></html>');
      });
      server2 = s.server;
      url2 = s.url;
      const adapter = makeMcpAdapter({ cachedUrl: null, discoveredUrl: url2 });
      const url = await _discoverVerifiedStartUrl('qux', adapter, console);
      if (url !== url2) throw new Error(`Expected ${url2}, got ${url}`);
      const setCalls = adapter.calls.filter(c => c.service === 'user-memory' && c.action === 'profile.set');
      if (setCalls.length !== 1) throw new Error('Expected one profile.set call');
      if (setCalls[0].payload.key !== 'nav-start-url:qux') throw new Error('Wrong cache key');
      if (setCalls[0].payload.valueRef !== url2) throw new Error('Wrong cached value');
    } finally {
      if (server2) server2.close();
    }
  });

  await it('falls back to generated URL when discovery fails', async () => {
    const adapter = makeMcpAdapter({ cachedUrl: null, discoveredUrl: null });
    const url = await _discoverVerifiedStartUrl('quux', adapter, console);
    if (url !== 'https://www.quux.com') throw new Error(`Expected fallback, got ${url}`);
  });

  await it('falls back when discovered URL is unreachable', async () => {
    const adapter = makeMcpAdapter({ cachedUrl: null, discoveredUrl: 'http://127.0.0.1:1/no' });
    const url = await _discoverVerifiedStartUrl('corge', adapter, console);
    if (url !== 'https://www.corge.com') throw new Error(`Expected fallback, got ${url}`);
  });

  section('User-supplied bare hostname');
  await it('uses a hostname found in the user message', async () => {
    const adapter = makeMcpAdapter({});
    const url = await _resolveStartUrlForService('unknown', 'go to example.org', adapter, console);
    if (url !== 'https://example.org') throw new Error(`Expected https://example.org, got ${url}`);
    const mcpCalls = adapter.calls.filter(c => c.service === 'command' || c.service === 'user-memory');
    if (mcpCalls.length !== 0) throw new Error('Should not call discovery when user provides a hostname');
  });

  section('Cached result invalidation');
  await it('re-normalizes cached results with bare agent ids', async () => {
    const userMessage = 'send a gmail message';
    const adapter = makeMcpAdapter({});
    const llmBackend = {
      async generateAnswer(prompt, opts) {
        // This should only be called if the cache is invalidated.
        return JSON.stringify({
          agents: [{ agentId: 'gmail', role: 'send the email', exists: true, create: false }],
          reasoning: 'Task needs Gmail.',
          question: null,
        });
      },
    };
    const state = {
      intent: { type: 'command_automate' },
      message: userMessage,
      resolvedMessage: userMessage,
      llmBackend,
      mcpAdapter: adapter,
      logger: console,
      resolveAgentResult: {
        _message: userMessage,
        agents: [{ agentId: 'gmail', role: 'send the email', exists: true }],
      },
    };
    const result = await resolveAgent(state);
    const agents = result.resolveAgentResult?.agents || [];
    if (agents.length !== 1) throw new Error(`Expected 1 agent, got ${agents.length}`);
    if (agents[0].agentId !== 'gmail.agent') throw new Error(`Expected gmail.agent, got ${agents[0].agentId}`);
    const listCalls = adapter.calls.filter(c => c.service === 'command' && c.action === 'agent.list');
    if (listCalls.length !== 1) throw new Error(`Expected agent.list to be called after cache invalidation, got ${listCalls.length}`);
  });

  await it('reuses cached results with normalized agent ids', async () => {
    const userMessage = 'send a gmail message';
    const adapter = makeMcpAdapter({});
    const llmBackend = {
      async generateAnswer() { throw new Error('LLM should not be called'); },
    };
    const state = {
      intent: { type: 'command_automate' },
      message: userMessage,
      resolvedMessage: userMessage,
      llmBackend,
      mcpAdapter: adapter,
      logger: console,
      resolveAgentResult: {
        _message: userMessage,
        agents: [{ agentId: 'gmail.agent', role: 'send the email', exists: true }],
      },
    };
    const result = await resolveAgent(state);
    const agents = result.resolveAgentResult?.agents || [];
    if (agents.length !== 1) throw new Error(`Expected 1 agent, got ${agents.length}`);
    if (agents[0].agentId !== 'gmail.agent') throw new Error(`Expected gmail.agent, got ${agents[0].agentId}`);
    const listCalls = adapter.calls.filter(c => c.service === 'command' && c.action === 'agent.list');
    if (listCalls.length !== 0) throw new Error(`Expected cache hit, but agent.list was called ${listCalls.length} times`);
  });

  console.log(`\n${'─'.repeat(72)}`);
  if (_failed === 0) {
    console.log(`✅ All ${_passed} tests passed.`);
  } else {
    console.log(`❌ ${_passed} passed, ${_failed} failed.`);
    for (const f of _failures) {
      console.log(`   - ${f.label}: ${f.error}`);
    }
    process.exitCode = 1;
  }
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exitCode = 1;
});

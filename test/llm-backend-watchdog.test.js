'use strict';
/**
 * llm-backend-watchdog.test.js — ThinkDropLLMBackend stream liveness + cancel
 *
 * Regression coverage for two observed production failures:
 *   1. A stream that emitted llm_stream_start then went silent hung FOREVER —
 *      stream_start cleared the timeout and chunks never re-armed it. Seen:
 *      a plan stream stuck 13.5 minutes after user cancel.
 *   2. options.abortSignal was ignored — cancel() could not tear down an
 *      in-flight LLM request.
 *
 * Uses a real `ws` server on a random port with scripted responses.
 * Run: node stategraph-module/test/llm-backend-watchdog.test.js
 */

const { WebSocketServer } = require('ws');
const ThinkDropLLMBackend = require('../src/backends/ThinkDropLLMBackend');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

function startServer(script) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('listening', () => resolve({ wss, port: wss.address().port }));
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try { script(JSON.parse(data.toString()), ws); } catch (_) {}
      });
    });
  });
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));

async function main() {
  // ── 1. Silent-after-start stream dies via idle watchdog ────────────────────
  {
    const { wss, port } = await startServer((_req, ws) => {
      send(ws, { type: 'llm_stream_start' });
      // then silence — the watchdog must kill it
    });
    const backend = new ThinkDropLLMBackend({ wsUrl: `ws://127.0.0.1:${port}`, responseTimeoutMs: 300 });
    const t0 = Date.now();
    try {
      await backend.generateAnswer('p', { query: 'p', context: {} });
      ok(false, 'silent stream should have thrown');
    } catch (e) {
      ok(/timeout/i.test(e.message), `silent stream rejected with timeout (${e.message})`);
      ok(Date.now() - t0 < 5000, `idle watchdog fired promptly (${Date.now() - t0}ms)`);
    }
    wss.close();
  }

  // ── 2. Active stream (chunks < idle window) survives, then ends cleanly ────
  {
    const { wss, port } = await startServer((req, ws) => {
      send(ws, { type: 'llm_stream_start' });
      let n = 0;
      const iv = setInterval(() => {
        n++;
        if (n <= 6) send(ws, { type: 'llm_stream_chunk', payload: { chunk: `c${n}` } });
        else {
          clearInterval(iv);
          send(ws, { type: 'llm_stream_end' });
        }
      }, 60); // 6 chunks × 60ms = 360ms > one idle window but < gap
    });
    const backend = new ThinkDropLLMBackend({ wsUrl: `ws://127.0.0.1:${port}`, responseTimeoutMs: 200 });
    try {
      const out = await backend.generateAnswer('p', { query: 'p', context: {} });
      ok(typeof out === 'string' && out.includes('c1') && out.includes('c6'), `active stream accumulated chunks (${JSON.stringify(out)})`);
    } catch (e) {
      ok(false, `active stream should have survived — got ${e.message}`);
    }
    wss.close();
  }

  // ── 3. abortSignal aborts an in-flight silent stream immediately ───────────
  {
    const { wss, port } = await startServer((_req, ws) => {
      send(ws, { type: 'llm_stream_start' });
    });
    const backend = new ThinkDropLLMBackend({ wsUrl: `ws://127.0.0.1:${port}`, responseTimeoutMs: 60000 });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = backend.generateAnswer('p', { query: 'p', context: {} }, { abortSignal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    try {
      await p;
      ok(false, 'aborted stream should have thrown');
    } catch (e) {
      ok(e.name === 'AbortError' || /abort/i.test(e.message), `abort rejected promptly (${e.message})`);
      ok(Date.now() - t0 < 5000, `abort raced the watchdog (${Date.now() - t0}ms)`);
    }
    wss.close();
  }

  // ── 4. Pre-aborted signal rejects before sending ───────────────────────────
  {
    const { wss, port } = await startServer(() => {});
    const backend = new ThinkDropLLMBackend({ wsUrl: `ws://127.0.0.1:${port}`, responseTimeoutMs: 200 });
    const ac = new AbortController();
    ac.abort();
    try {
      await backend.generateAnswer('p', { query: 'p', context: {} }, { abortSignal: ac.signal });
      ok(false, 'pre-aborted request should have thrown');
    } catch (e) {
      ok(/abort/i.test(e.name + e.message), `pre-aborted rejected (${e.name}: ${e.message})`);
    }
    wss.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('test harness error:', e); process.exit(1); });

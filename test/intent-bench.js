#!/usr/bin/env node
/**
 * intent-bench.js — ThinkDrop Intent Classification Benchmark
 *
 * Runs every example in test/fixtures/intent-benchmark.json through the
 * parseIntent node in isolation and reports accuracy by intent, by source
 * type, a full confusion matrix, and an overall pass/fail vs threshold.
 *
 * Usage:
 *   node test/intent-bench.js                        # auto-detect phi4
 *   node test/intent-bench.js --offline              # overrides + rule-based only
 *   node test/intent-bench.js --only=web_search,greeting
 *   node test/intent-bench.js --source=voice,adversarial
 *   node test/intent-bench.js --failures             # only show failures
 *   node test/intent-bench.js --verbose              # show every case
 *   node test/intent-bench.js --threshold=90         # min accuracy % (default 80)
 *   node test/intent-bench.js --concurrency=5        # parallel calls (default 3)
 *   node test/intent-bench.js --id=mr-a03            # run one specific case
 *   node test/intent-bench.js --dataset=generated    # load intent-generated.json instead
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const parseIntentNode = require('../src/nodes/parseIntent');

// ── Load .env (walk up to project root) ───────────────────────────────────────
// Reads the nearest .env file so MCP_PHI4_API_KEY / MCP_API_KEY are available
// without the caller needing to export them manually.
(function loadDotEnv() {
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      const lines = fs.readFileSync(candidate, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
      return;
    }
    dir = path.dirname(dir);
  }
}());

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const flag    = (f)   => argv.includes(f);
const argVal  = (key) => { const a = argv.find(x => x.startsWith(`${key}=`)); return a ? a.slice(key.length + 1) : null; };

const OFFLINE      = flag('--offline');
const ONLY_FAILURES = flag('--failures') || flag('-f');
const VERBOSE      = flag('--verbose')  || flag('-v');
const THRESHOLD    = parseInt(argVal('--threshold')   || '80', 10);
const CONCURRENCY  = parseInt(argVal('--concurrency') || '3',  10);
const ONLY_INTENTS = argVal('--only')    ? argVal('--only').split(',')    : null;
const ONLY_SOURCES = argVal('--source')  ? argVal('--source').split(',')  : null;
const FILTER_ID    = argVal('--id');
const DATASET      = argVal('--dataset') || 'benchmark'; // 'benchmark' | 'generated' | 'both'

const PHI4_BASE = 'http://localhost:3009';

// ── Load fixture ──────────────────────────────────────────────────────────────
// The fixture uses JS-style // section comments for readability; strip them
// before JSON.parse so editors can keep the valuable per-section annotations.
function loadFixture(fp) {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function resolveDataset() {
  const dir = path.join(__dirname, 'fixtures');
  if (DATASET === 'generated') {
    const f = loadFixture(path.join(dir, 'intent-generated.json'));
    if (!f) { console.error('No intent-generated.json found — run: node test/gen-bench-data.js'); process.exit(1); }
    return f;
  }
  if (DATASET === 'both') {
    const a = loadFixture(path.join(dir, 'intent-benchmark.json'));
    const b = loadFixture(path.join(dir, 'intent-generated.json'));
    if (!a) { console.error('No intent-benchmark.json found'); process.exit(1); }
    const merged = { ...a, examples: [...a.examples, ...(b ? b.examples : [])] };
    if (b) console.log(`Merged: ${a.examples.length} benchmark + ${b.examples.length} generated`);
    return merged;
  }
  // default: 'benchmark'
  const f = loadFixture(path.join(dir, 'intent-benchmark.json'));
  if (!f) { console.error('No intent-benchmark.json found'); process.exit(1); }
  return f;
}

const fixture = resolveDataset();

// ── Apply filters ─────────────────────────────────────────────────────────────
let examples = fixture.examples;
if (FILTER_ID)    examples = examples.filter(e => e.id === FILTER_ID);
if (ONLY_INTENTS) examples = examples.filter(e => ONLY_INTENTS.includes(e.intent));
if (ONLY_SOURCES) examples = examples.filter(e => ONLY_SOURCES.includes(e.source));

if (examples.length === 0) {
  console.error('No examples match the given filters.');
  process.exit(1);
}

// ── Silent logger ──────────────────────────────────────────────────────────────
const silentLogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: VERBOSE ? (m, ...a) => process.stderr.write(`[ERR] ${m} ${a.join(' ')}\n`) : () => {},
};

// ── Phi4 HTTP shim ─────────────────────────────────────────────────────────────
function httpPost(urlStr, body, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port:     parseInt(u.port || '3009', 10),
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(extraHeaders || {}),
      },
    };
    if (timeoutMs) opts.timeout = timeoutMs;

    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`phi4 bad JSON: ${buf.slice(0, 120)}`)); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('phi4 request timed out')); });
    req.write(payload);
    req.end();
  });
}

function httpGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port:     parseInt(u.port || '3009', 10),
      path:     u.pathname,
      method:   'GET',
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(buf)); }
        catch (e) { resolve({ status: res.statusCode }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('health check timed out')); });
    req.end();
  });
}

async function probePhi4() {
  try {
    await httpGet(`${PHI4_BASE}/service.health`, 2000);
    return true;
  } catch (_) {
    return false;
  }
}

// The shim replaces MCPAdapter for bench purposes.
// It forwards phi4 calls over HTTP using the proper MCP envelope format with
// auth, and returns null for all other services (user-memory, conversation, etc.)
// so parseIntent gracefully skips them.
function makePhi4Shim() {
  const apiKey = process.env.MCP_PHI4_API_KEY || process.env.MCP_API_KEY || '';
  const authHeaders = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

  return {
    callService: async (service, action, params) => {
      if (service === 'phi4' && action === 'intent.parse') {
        try {
          // phi4 requires the standard MCP envelope: { version, service, action, payload }
          const body = {
            version: 'mcp.v1',
            service: 'phi4',
            action:  'intent.parse',
            payload: { message: params.message },
          };
          return await httpPost(`${PHI4_BASE}/intent.parse`, body, 8000, authHeaders);
        } catch (err) {
          silentLogger.error(`[phi4-shim] ${err.message}`);
          return null; // causes parseIntent to use rule-based fallback
        }
      }
      return null; // graceful no-op for all other services
    },
  };
}

// ── Run one test case ──────────────────────────────────────────────────────────
async function runCase(example, mcpAdapter) {
  const state = {
    message:            example.message,
    resolvedMessage:    example.message,
    context:            { userId: 'bench', sessionId: 'bench-session' },
    intent:             null,
    logger:             silentLogger,
    mcpAdapter,
    llmBackend:         null,
    conversationHistory: [],
    carriedIntent:      null,
    selectedText:       '',
  };
  const t0 = Date.now();
  try {
    const result = await parseIntentNode(state);
    return {
      id:         example.id,
      expected:   example.intent,
      actual:     result?.intent?.type     || 'unknown',
      confidence: result?.intent?.confidence ?? 0,
      parser:     result?.metadata?.parser  || '?',
      ms:         Date.now() - t0,
    };
  } catch (err) {
    return {
      id:         example.id,
      expected:   example.intent,
      actual:     'error',
      confidence: 0,
      parser:     'error',
      error:      err.message,
      ms:         Date.now() - t0,
    };
  }
}

// ── Concurrency pool ───────────────────────────────────────────────────────────
async function runWithPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Display helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',  dim:   '\x1b[2m',
  green:  '\x1b[32m', red:    '\x1b[31m', yellow: '\x1b[33m',
  cyan:   '\x1b[36m', gray:   '\x1b[90m',
};

const INTENT_LABELS = {
  memory_store:         'memory_store    ',
  memory_retrieve:      'memory_retrieve ',
  web_search:           'web_search      ',
  command_automate:     'command_automate',
  screen_intelligence:  'screen_intel    ',
  general_knowledge:    'general_knowledge',
  greeting:             'greeting        ',
  app_control_start:    'app_control     ',
  unknown:              'unknown         ',
  error:                'error           ',
  general_query:        'general_query   ',
};
const pad = (s) => (INTENT_LABELS[s] || String(s)).padEnd(18);

function pct(n, d) {
  if (d === 0) return '  — ';
  return `${((n / d) * 100).toFixed(0).padStart(3)}%`;
}

function bar(p) {
  const filled = Math.round(p / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function barColor(p) {
  return p >= 90 ? C.green : p >= 75 ? C.yellow : C.red;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  // Probe phi4
  let mcpAdapter = null;
  let mode = `offline ${C.gray}(hard overrides + rule-based fallback — no phi4)${C.reset}`;

  if (!OFFLINE) {
    process.stdout.write(`Probing phi4 at ${PHI4_BASE}...`);
    const up = await probePhi4();
    if (up) {
      mcpAdapter = makePhi4Shim();
      mode = `${C.green}online${C.reset} — phi4 DistilBERT at ${PHI4_BASE}`;
      process.stdout.write(` ${C.green}UP${C.reset}\n`);
    } else {
      process.stdout.write(` ${C.yellow}DOWN${C.reset} — falling back to offline mode\n`);
    }
  }

  console.log();
  console.log(`${C.bold}THINKDROP INTENT CLASSIFICATION BENCHMARK${C.reset}`);
  console.log(`Mode      : ${mode}`);
  console.log(`Cases     : ${examples.length}  |  Threshold: ${THRESHOLD}%  |  Concurrency: ${CONCURRENCY}`);
  if (ONLY_INTENTS) console.log(`Filter    : intents = ${ONLY_INTENTS.join(', ')}`);
  if (ONLY_SOURCES) console.log(`Filter    : sources = ${ONLY_SOURCES.join(', ')}`);
  console.log('─'.repeat(82));

  // Run all cases with progress indicator
  let done = 0;
  const total = examples.length;
  process.stdout.write(`Running 0/${total}...`);

  const rawResults = await runWithPool(examples, CONCURRENCY, async (ex) => {
    const r = await runCase(ex, mcpAdapter);
    done++;
    process.stdout.write(`\rRunning ${done}/${total}...`);
    return r;
  });

  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  // Enrich results with source/notes from fixture
  const resultById = new Map(rawResults.map(r => [r.id, r]));
  const results = examples.map(ex => ({
    ...resultById.get(ex.id),
    message: ex.message,
    source:  ex.source,
    notes:   ex.notes || '',
  }));

  // ── Verbose / full listing ──────────────────────────────────────────────────
  if (VERBOSE && !ONLY_FAILURES) {
    console.log(`${C.bold}ALL CASES${C.reset}`);
    console.log('─'.repeat(82));
    for (const r of results) {
      const ok  = r.actual === r.expected;
      const sym = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      const msg = r.message.length > 58 ? r.message.slice(0, 55) + '...' : r.message;
      console.log(
        `${sym} [${r.id.padEnd(8)}] [${r.source.padEnd(11)}] ${msg.padEnd(60)}`
        + ` → ${pad(r.actual).slice(0,16).padEnd(17)}`
        + ` ${C.dim}${(r.confidence * 100).toFixed(0).padStart(3)}% ${r.parser}${C.reset}`
      );
      if (!ok && r.notes) console.log(`   ${C.gray}↳ ${r.notes}${C.reset}`);
    }
    console.log();
  }

  // ── Failures ────────────────────────────────────────────────────────────────
  const failures = results.filter(r => r.actual !== r.expected);

  if (failures.length > 0) {
    console.log(`${C.bold}${C.red}FAILURES${C.reset}  (${failures.length} of ${total})`);
    console.log('─'.repeat(82));
    for (const r of failures) {
      const msg = r.message.length > 70 ? r.message.slice(0, 67) + '...' : r.message;
      console.log(`${C.red}✗${C.reset} [${r.id}] [${r.source}] "${msg}"`);
      console.log(
        `    expected: ${C.green}${r.expected}${C.reset}`
        + `  got: ${C.red}${r.actual}${C.reset}`
        + `  ${C.dim}(${(r.confidence * 100).toFixed(0)}% conf | parser: ${r.parser} | ${r.ms}ms)${C.reset}`
      );
      if (r.notes) console.log(`    ${C.gray}${r.notes}${C.reset}`);
      if (r.error) console.log(`    ${C.yellow}error: ${r.error}${C.reset}`);
    }
    console.log();
  }

  if (ONLY_FAILURES && failures.length === 0) {
    console.log(`${C.green}No failures!${C.reset}\n`);
    process.exit(0);
  }

  // ── Per-intent accuracy ──────────────────────────────────────────────────────
  const INTENTS = fixture.intents;

  console.log(`${C.bold}ACCURACY BY INTENT${C.reset}`);
  console.log('─'.repeat(82));
  for (const intent of INTENTS) {
    const subset  = results.filter(r => r.expected === intent);
    if (subset.length === 0) continue;
    const correct = subset.filter(r => r.actual === r.expected).length;
    const p       = (correct / subset.length) * 100;
    const col     = barColor(p);
    console.log(
      `  ${pad(intent)} ${col}${pct(correct, subset.length)}${C.reset}`
      + `  ${col}${bar(p)}${C.reset}`
      + `  ${correct.toString().padStart(3)}/${subset.length}`
    );
  }
  console.log();

  // ── Per-source accuracy ──────────────────────────────────────────────────────
  const SOURCES = ['clean', 'voice', 'edge', 'adversarial'];

  console.log(`${C.bold}ACCURACY BY SOURCE${C.reset}`);
  console.log('─'.repeat(82));
  for (const src of SOURCES) {
    const subset  = results.filter(r => r.source === src);
    if (subset.length === 0) continue;
    const correct = subset.filter(r => r.actual === r.expected).length;
    const p       = (correct / subset.length) * 100;
    const col     = barColor(p);
    console.log(
      `  ${src.padEnd(14)} ${col}${pct(correct, subset.length)}${C.reset}`
      + `  ${col}${bar(p)}${C.reset}`
      + `  ${correct.toString().padStart(3)}/${subset.length}`
    );
  }
  console.log();

  // ── Per-parser breakdown ─────────────────────────────────────────────────────
  const parsers = {};
  for (const r of results) {
    const p = r.parser || '?';
    if (!parsers[p]) parsers[p] = { correct: 0, total: 0 };
    parsers[p].total++;
    if (r.actual === r.expected) parsers[p].correct++;
  }
  const parserNames = Object.keys(parsers).sort((a, b) => parsers[b].total - parsers[a].total);

  console.log(`${C.bold}ACCURACY BY PARSER${C.reset}`);
  console.log('─'.repeat(82));
  for (const p of parserNames) {
    const s   = parsers[p];
    const pct2 = (s.correct / s.total) * 100;
    const col  = barColor(pct2);
    console.log(
      `  ${p.padEnd(32)} ${col}${pct(s.correct, s.total)}${C.reset}`
      + `  ${s.total.toString().padStart(4)} cases`
    );
  }
  console.log();

  // ── Confusion matrix ─────────────────────────────────────────────────────────
  // Only show intents that appear in the filtered result set
  const activeIntents = INTENTS.filter(i => results.some(r => r.expected === i || r.actual === i));
  // Also catch non-standard actuals (general_query, error, unknown)
  const allActuals = [...new Set(results.map(r => r.actual))];
  const extraCols  = allActuals.filter(a => !activeIntents.includes(a));
  const cols       = [...activeIntents, ...extraCols];

  // Build matrix
  const matrix = {};
  for (const exp of activeIntents) {
    matrix[exp] = {};
    for (const pred of cols) matrix[exp][pred] = 0;
  }
  for (const r of results) {
    if (matrix[r.expected]) {
      matrix[r.expected][r.actual] = (matrix[r.expected][r.actual] || 0) + 1;
    }
  }

  const SHORT = (s) => s
    .replace('memory_', 'mem_')
    .replace('_intelligence', '_intel')
    .replace('command_automate', 'cmd_auto')
    .replace('general_knowledge', 'gen_know')
    .replace('app_control_start', 'app_ctrl')
    .replace('general_query', 'gen_query')
    .slice(0, 10);

  const COL_W = 12;

  console.log(`${C.bold}CONFUSION MATRIX${C.reset}  (rows = expected, cols = predicted)`);
  console.log('─'.repeat(82));

  // Header row
  process.stdout.write('                   ');
  for (const col of cols) process.stdout.write(SHORT(col).padEnd(COL_W));
  console.log();

  // Data rows
  for (const exp of activeIntents) {
    process.stdout.write(pad(exp).slice(0, 18) + ' ');
    for (const pred of cols) {
      const v   = matrix[exp][pred] || 0;
      const str = String(v).padStart(COL_W - 1).padEnd(COL_W);
      if (exp === pred)  process.stdout.write(v > 0 ? `${C.green}${str}${C.reset}` : str);
      else               process.stdout.write(v > 0 ? `${C.red}${str}${C.reset}`   : `${C.dim}${str}${C.reset}`);
    }
    console.log();
  }
  console.log();

  // ── Overall summary ──────────────────────────────────────────────────────────
  const totalCorrect = results.filter(r => r.actual === r.expected).length;
  const overallPct   = (totalCorrect / total) * 100;
  const passCol      = overallPct >= THRESHOLD ? C.green : C.red;
  const avgMs        = results.reduce((s, r) => s + (r.ms || 0), 0) / total;

  console.log(`${C.bold}OVERALL${C.reset}`);
  console.log('─'.repeat(82));
  console.log(`  Accuracy  : ${passCol}${C.bold}${overallPct.toFixed(1)}%${C.reset}  (${totalCorrect}/${total} correct)`);
  console.log(`  Failures  : ${failures.length}`);
  console.log(`  Avg time  : ${avgMs.toFixed(0)}ms per case`);
  console.log(`  Threshold : ${THRESHOLD}%`);
  console.log(`  Status    : ${overallPct >= THRESHOLD ? `${C.green}${C.bold}PASS${C.reset}` : `${C.red}${C.bold}FAIL${C.reset}`}`);
  console.log();

  process.exit(overallPct >= THRESHOLD ? 0 : 1);
}

main().catch(err => {
  console.error(`\n${C.red}Benchmark runner error:${C.reset}`, err.message);
  if (VERBOSE) console.error(err.stack);
  process.exit(1);
});

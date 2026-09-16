#!/usr/bin/env node
/**
 * classify-bench.js — classifyTask live-LLM benchmark
 *
 * Runs every case in test/fixtures/classify-benchmark.json through the REAL
 * classifyTask → ThinkDropLLMBackend path (same backend main.js wires in
 * production) and reports accuracy by source, by field, plus a taskType
 * confusion matrix. Use --system-prompt to evaluate a pruned prompt variant
 * head-to-head against the baseline before committing to it.
 *
 * Requires the thinkdrop backend WS server (default ws://localhost:4000).
 *
 * Usage:
 *   node test/classify-bench.js                        # run all cases
 *   node test/classify-bench.js --only=boundary,production-incident
 *   node test/classify-bench.js --source=paraphrase    # alias for --only
 *   node test/classify-bench.js --id=bnd-still-talking
 *   node test/classify-bench.js --failures             # only show failures
 *   node test/classify-bench.js --verbose              # show every case
 *   node test/classify-bench.js --threshold=85         # min accuracy % (default 80)
 *   node test/classify-bench.js --concurrency=5        # parallel calls (default 3)
 *   node test/classify-bench.js --system-prompt=/path/to/alt-prompt.txt
 *   node test/classify-bench.js --dataset=generated    # load classify-generated.json
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { classifyTask, CLASSIFY_SYSTEM_PROMPT } = require('../src/utils/classifyTask');
const ThinkDropLLMBackend = require('../src/backends/ThinkDropLLMBackend');

// ── Load .env (walk up to project root) ───────────────────────────────────────
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

const ONLY_FAILURES  = flag('--failures') || flag('-f');
const VERBOSE        = flag('--verbose')  || flag('-v');
const THRESHOLD      = parseInt(argVal('--threshold')   || '80', 10);
const CONCURRENCY    = parseInt(argVal('--concurrency') || '3',  10);
const ONLY_SOURCES   = (argVal('--only') || argVal('--source'))?.split(',') || null;
const FILTER_ID      = argVal('--id');
const DATASET        = argVal('--dataset') || 'benchmark';
const PROMPT_FILE    = argVal('--system-prompt');
const DUMP_PROMPT    = argVal('--dump-prompt');

// ── --dump-prompt: write the module's live CLASSIFY_SYSTEM_PROMPT and exit ────
// Use to snapshot a baseline before prompt edits, then A/B with --system-prompt.
if (DUMP_PROMPT) {
  fs.writeFileSync(DUMP_PROMPT, CLASSIFY_SYSTEM_PROMPT, 'utf8');
  console.log(`Wrote CLASSIFY_SYSTEM_PROMPT (${CLASSIFY_SYSTEM_PROMPT.length} chars) → ${DUMP_PROMPT}`);
  process.exit(0);
}

// ── Load fixture ──────────────────────────────────────────────────────────────
function loadFixture(fp) {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

const fixtureFile = DATASET === 'benchmark' ? 'classify-benchmark.json' : `classify-${DATASET}.json`;
const fixture = loadFixture(path.join(__dirname, 'fixtures', fixtureFile));
if (!fixture) { console.error(`No ${fixtureFile} found in test/fixtures/`); process.exit(1); }

let cases = fixture.cases;
if (FILTER_ID)    cases = cases.filter(c => c.id === FILTER_ID);
if (ONLY_SOURCES) cases = cases.filter(c => ONLY_SOURCES.includes(c.source));

if (cases.length === 0) {
  console.error('No cases match the given filters.');
  process.exit(1);
}

let systemPromptOverride = null;
if (PROMPT_FILE) {
  if (!fs.existsSync(PROMPT_FILE)) { console.error(`Prompt file not found: ${PROMPT_FILE}`); process.exit(1); }
  systemPromptOverride = fs.readFileSync(PROMPT_FILE, 'utf8');
  console.log(`Using alternate system prompt: ${PROMPT_FILE} (${systemPromptOverride.length} chars)`);
}

// ── Silent logger ──────────────────────────────────────────────────────────────
const silentLogger = {
  debug: () => {},
  info:  VERBOSE ? (m) => console.log(`    [i] ${m}`) : () => {},
  warn:  () => {},
  error: (m, ...a) => process.stderr.write(`[ERR] ${m} ${a.join(' ')}\n`),
};

// ── Backend ────────────────────────────────────────────────────────────────────
const llmBackend = new ThinkDropLLMBackend({
  wsUrl:             process.env.WEBSOCKET_URL     || 'ws://localhost:4000/ws/stream',
  apiKey:            process.env.BASE_API_KEY  || process.env.WEBSOCKET_API_KEY || '',
  userId:            'classify-bench',
  connectTimeoutMs:  5000,
  responseTimeoutMs: 60000,
});

// ── Expectation matching ───────────────────────────────────────────────────────
// Exact match for enums/booleans. Special keys:
//   followUpTargetContains: substring (case-insensitive) — free-text field
//   followUpTargetNull:     true → must be null, false → must be non-null
//   interactiveActionsEmpty:         array must be []
//   interactiveActionsContains:      array must include the value
function checkExpect(result, expect) {
  const mismatches = [];
  for (const [field, wanted] of Object.entries(expect)) {
    if (field === 'followUpTargetContains') {
      const actual = result.followUpTarget || '';
      if (!actual.toLowerCase().includes(String(wanted).toLowerCase())) {
        mismatches.push(`followUpTarget ~/${wanted}/i — got ${JSON.stringify(actual)}`);
      }
    } else if (field === 'followUpTargetNull') {
      const isNull = result.followUpTarget == null;
      if (isNull !== wanted) {
        mismatches.push(`followUpTarget ${wanted ? 'null' : 'non-null'} — got ${JSON.stringify(result.followUpTarget)}`);
      }
    } else if (field === 'interactiveActionsEmpty') {
      const arr = result.interactiveActions || [];
      if (wanted && arr.length > 0) {
        mismatches.push(`interactiveActions empty — got ${JSON.stringify(arr)}`);
      }
    } else if (field === 'interactiveActionsContains') {
      const arr = result.interactiveActions || [];
      if (!arr.includes(wanted)) {
        mismatches.push(`interactiveActions contains ${wanted} — got ${JSON.stringify(arr)}`);
      }
    } else if (field === 'targetService' && typeof wanted === 'string') {
      // case- and TLD-insensitive — "Amazon"/"amazon", "x.org"/"x" are not misclassifications
      const norm = (s) => String(s || '').toLowerCase().replace(/\.(com|org|net|io|ai|co|dev)$/i, '');
      if (norm(result.targetService) !== norm(wanted)) {
        mismatches.push(`targetService: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(result.targetService)}`);
      }
    } else if (result[field] !== wanted) {
      mismatches.push(`${field}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(result[field])}`);
    }
  }
  return mismatches;
}

// ── Run one case ───────────────────────────────────────────────────────────────
async function runCase(tc) {
  const t0 = Date.now();
  try {
    const result = await classifyTask(
      tc.message,
      tc.history || [],
      llmBackend,
      silentLogger,
      tc.priorScreenSummary || null,
      tc.activeAppContext || null,
      systemPromptOverride ? { systemPrompt: systemPromptOverride } : {},
    );
    const mismatches = checkExpect(result, tc.expect || {});
    return { tc, result, mismatches, ms: Date.now() - t0, error: null };
  } catch (err) {
    return { tc, result: null, mismatches: ['threw'], ms: Date.now() - t0, error: err.message };
  }
}

// ── Concurrency pool ───────────────────────────────────────────────────────────
async function runAll(items) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await runCase(items[i]);
      if (VERBOSE) {
        const r = results[i];
        const mark = r.error ? 'ERR ' : (r.mismatches.length ? 'FAIL' : 'PASS');
        console.log(`  [${mark}] ${r.tc.id}  (${r.ms}ms)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// ── Report ────────────────────────────────────────────────────────────────────
function report(results) {
  const passed = results.filter(r => !r.error && r.mismatches.length === 0);
  const failed = results.filter(r => r.error || r.mismatches.length > 0);
  const acc = results.length ? (passed.length / results.length * 100) : 0;

  // Per-source accuracy
  const bySource = {};
  for (const r of results) {
    const s = r.tc.source || 'unknown';
    bySource[s] = bySource[s] || { pass: 0, total: 0 };
    bySource[s].total++;
    if (!r.error && r.mismatches.length === 0) bySource[s].pass++;
  }

  // Per-field accuracy — a field "failed" if it appeared in any mismatch
  const fieldStats = {};
  for (const r of results) {
    for (const field of Object.keys(r.tc.expect || {})) {
      fieldStats[field] = fieldStats[field] || { pass: 0, total: 0 };
      fieldStats[field].total++;
      const failed = r.mismatches.some(m => m.startsWith(field));
      if (!r.error && !failed) fieldStats[field].pass++;
    }
  }

  // taskType confusion matrix
  const confusion = {};
  for (const r of results) {
    if (!r.result || !r.tc.expect?.taskType) continue;
    const key = `${r.tc.expect.taskType} → ${r.result.taskType}`;
    confusion[key] = (confusion[key] || 0) + 1;
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  CLASSIFY BENCHMARK RESULTS');
  console.log('═'.repeat(70));
  console.log(`  Cases:    ${results.length}`);
  console.log(`  Passed:   ${passed.length}`);
  console.log(`  Failed:   ${failed.length}`);
  console.log(`  Accuracy: ${acc.toFixed(1)}%  (threshold ${THRESHOLD}%)`);
  console.log(`  Avg time: ${Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length)}ms`);

  console.log('\n  By source:');
  for (const [s, st] of Object.entries(bySource)) {
    console.log(`    ${s.padEnd(22)} ${st.pass}/${st.total}  (${(st.pass / st.total * 100).toFixed(0)}%)`);
  }

  console.log('\n  By expected field:');
  for (const [f, st] of Object.entries(fieldStats).sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total)) {
    console.log(`    ${f.padEnd(28)} ${st.pass}/${st.total}  (${(st.pass / st.total * 100).toFixed(0)}%)`);
  }

  const mismatched = Object.entries(confusion).filter(([k]) => k.split(' → ')[0] !== k.split(' → ')[1]);
  if (mismatched.length) {
    console.log('\n  taskType confusion (expected → actual):');
    for (const [k, n] of mismatched.sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}  ×${n}`);
    }
  }

  if (failed.length && (ONLY_FAILURES || VERBOSE || true)) {
    console.log('\n  Failures:');
    for (const r of failed) {
      console.log(`    ${r.tc.id}  "${r.tc.message.slice(0, 60)}"`);
      if (r.error) console.log(`      error: ${r.error}`);
      for (const m of r.mismatches) console.log(`      ${m}`);
    }
  }

  console.log('═'.repeat(70));
  return acc;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`classify-bench — ${cases.length} case(s), concurrency ${CONCURRENCY}`);
  process.stdout.write('  Probing backend... ');
  let up = false;
  try { up = await llmBackend.isAvailable(); } catch (_) { up = false; }
  if (!up) {
    console.log('FAILED');
    console.error('\n  ThinkDrop backend unreachable at ' +
      (process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream') +
      '\n  Start the backend server first (same one the app uses).');
    process.exit(2);
  }
  console.log('ok');

  const results = await runAll(cases);
  const acc = report(results);
  process.exit(acc >= THRESHOLD ? 0 : 1);
})().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(2);
});

'use strict';
/**
 * continue-thread-context.test.js
 *
 * Regression tests for the Continue-Thread / follow-up context fixes:
 *   - decomposePromptV2 unresolved-follow-up guard (bare affirmation with no
 *     resolvable referent routes to memory_retrieve, never web_search on the
 *     literal text — the "yes you can" → "Yes You Can!" brand bug)
 *   - decomposePromptV2 duplicate filter must not self-match the CURRENT
 *     message (comms-graph logs the user turn before the stategraph runs)
 *   - comms-graph classify offer-consent guard (affirmation + assistant offer
 *     → handoff, not general_quick chit-chat)
 *   - shell.run _looksTruncated (unterminated heredoc detection — bash -n
 *     does not reject it and would write a partial file)
 *   - executeCommand generateStepContract filePaths extraction from argv
 *     (cat > file <<EOF produces no stdout — the destination must come from
 *     the script's redirect target)
 *
 * Run from repo root with:
 *   node stategraph-module/test/continue-thread-context.test.js
 */

const path = require('path');

const decomposePromptV2 = require(path.resolve(__dirname, '..', 'src/nodes/decomposePromptV2.js'));
const { classify } = require(path.resolve(__dirname, '..', '..', 'comms-graph/src/classify.cjs'));
const { _looksTruncated } = require(path.resolve(__dirname, '..', '..', 'mcp-services/command-service/src/skills/shell.run.cjs'));
const { generateStepContract, _extractFilePathsFromArgv } = require(path.resolve(__dirname, '..', 'src/nodes/executeCommand.js'));

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

(async () => {

// ── Section 1: unresolved-follow-up guard in decomposePromptV2 ──────────────

section('decomposePromptV2 — unresolved follow-up guard');

const BABY_CLOTHES_HISTORY = [
  { role: 'user',      content: 'show me pics of baby clothes', timestamp: new Date(Date.now() - 60000).toISOString() },
  { role: 'assistant', content: "I can't display images directly, but I can help you find baby clothes online. Would you like me to search for specific styles, brands, or retailers?", timestamp: new Date(Date.now() - 55000).toISOString() },
  { role: 'user',      content: 'yes you can', timestamp: new Date().toISOString() }, // pre-logged by comms-graph
];

await it('"yes you can" + isFollowUp + null followUpTarget → memory_retrieve, not web_search', async () => {
  const result = await decomposePromptV2({
    message: 'yes you can',
    conversationHistory: BABY_CLOTHES_HISTORY,
    llmBackend: { generateAnswer: async () => '2' }, // would say web_search — must not be reached
    logger: _silentLogger,
    _taskClassification: {
      taskType: 'ambiguous', isFollowUp: true, followUpTarget: null,
      needsClarification: true, targetService: null, webAccessMode: null,
    },
  });
  assertEqual(result._decomposedBy, 'unresolved-followup-guard');
  assertEqual(result.intentPlan[0].estimatedIntent, 'memory_retrieve');
});

await it('guard does not fire when followUpTarget IS resolved', async () => {
  const result = await decomposePromptV2({
    message: 'yes you can',
    conversationHistory: BABY_CLOTHES_HISTORY,
    llmBackend: { generateAnswer: async () => '2' },
    logger: _silentLogger,
    _taskClassification: {
      taskType: 'query', isFollowUp: true, followUpTarget: 'baby clothes',
      needsClarification: false, targetService: null, webAccessMode: null,
    },
  });
  // Resolved follow-up takes the query-followup path → web_search on the target
  assert(result._decomposedBy !== 'unresolved-followup-guard', 'guard should not fire for resolved follow-up');
});

// ── Section 2: duplicate filter must not self-match the current message ─────

section('decomposePromptV2 — duplicate filter self-match exclusion');

await it('single-step sub-prompt equal to the CURRENT message survives the filter', async () => {
  const result = await decomposePromptV2({
    message: 'what is the weather in paris',
    conversationHistory: [
      { role: 'user', content: 'hello', timestamp: new Date(Date.now() - 120000).toISOString() },
      { role: 'assistant', content: 'Hi there!', timestamp: new Date(Date.now() - 115000).toISOString() },
      // current message already persisted by comms-graph/session.route:
      { role: 'user', content: 'what is the weather in paris', timestamp: new Date().toISOString() },
    ],
    llmBackend: { generateAnswer: async () => '2' }, // web_search fast decision
    logger: _silentLogger,
    _taskClassification: { taskType: 'query', isFollowUp: false, followUpTarget: null, needsClarification: false },
  });
  assert(result.intentPlan, 'expected intentPlan — sub-prompt must not be filtered as a duplicate');
  assertEqual(result.intentPlan[0].estimatedIntent, 'web_search');
});

await it('a sub-prompt repeating a GENUINELY PRIOR user message is still filtered', async () => {
  // Two identical sub-prompts where the message itself differs from history —
  // use multi-step so llmDecompose returns an array that hits the filter.
  // Stub: decision call → '7' (multi-step), decompose call → JSON.
  let calls = 0;
  const llm = {
    generateAnswer: async () => {
      calls++;
      if (calls === 1) return '7';
      return JSON.stringify({
        subPrompts: [
          { text: 'what is the weather in paris', estimatedIntent: 'web_search', order: 0 },
          { text: 'what time is it in tokyo', estimatedIntent: 'web_search', order: 1 },
        ],
      });
    },
  };
  const result = await decomposePromptV2({
    message: 'check both cities again',
    conversationHistory: [
      // "what is the weather in paris" was asked 1 min ago — a real duplicate
      { role: 'user', content: 'what is the weather in paris', timestamp: new Date(Date.now() - 60000).toISOString() },
      { role: 'assistant', content: 'It is 18°C and cloudy.', timestamp: new Date(Date.now() - 55000).toISOString() },
    ],
    llmBackend: llm,
    logger: _silentLogger,
    _taskClassification: { taskType: 'ambiguous', isFollowUp: false, followUpTarget: null, needsClarification: false },
  });
  const texts = (result.intentPlan || []).map(sp => sp.text);
  assert(!texts.includes('what is the weather in paris'), `prior-message duplicate should be filtered, got ${JSON.stringify(texts)}`);
  assert(texts.includes('what time is it in tokyo'), `non-duplicate sub-prompt should survive, got ${JSON.stringify(texts)}`);
});

// ── Section 3: comms-graph offer-consent guard ──────────────────────────────

section('comms-graph classify — offer-consent guard');

const OFFER_CONTEXT = 'User: show me pics of baby clothes\nAssistant: I can\'t display images directly, but I can help you find baby clothes online. Would you like me to search for specific styles, brands, or retailers?';
const NO_OFFER_CONTEXT = 'User: what is the capital of france\nAssistant: The capital of France is Paris.';

await it('"yes you can" after an assistant offer → handoff (offer_consent_guard)', async () => {
  const r = await classify('yes you can', OFFER_CONTEXT);
  assertEqual(r.intent, 0);
  assertEqual(r.source, 'offer_consent_guard');
});

await it('"ok" after an assistant offer → handoff (not general_quick)', async () => {
  const r = await classify('ok', OFFER_CONTEXT);
  assertEqual(r.intent, 0);
  assertEqual(r.source, 'offer_consent_guard');
});

await it('"sure" after "Shall I proceed?" → handoff', async () => {
  const r = await classify('sure', 'User: delete the tmp files\nAssistant: I found 12 tmp files. Shall I delete them?');
  assertEqual(r.intent, 0);
  assertEqual(r.source, 'offer_consent_guard');
});

await it('"ok" with NO offer in context → general_quick (bare follow-up)', async () => {
  const r = await classify('ok', NO_OFFER_CONTEXT);
  assertEqual(r.intent, 1);
  assertEqual(r.source, 'bare_followup');
});

// ── Section 4: shell.run truncation guard ───────────────────────────────────

section('shell.run — _looksTruncated heredoc detection');

await it('terminated heredoc → not truncated', async () => {
  const s = "cat > /tmp/x.md <<'EOF'\nline one\nline two\nEOF";
  assertEqual(_looksTruncated(s), null);
});

await it('unterminated heredoc (observed three.md failure) → flagged', async () => {
  const s = "cat > /Users/x/Desktop/three.md <<'EOF'\n# Three.js snow\nconst scene = new THREE.Scene();\ndocument.body.appendChild(renderer.domElement";
  const reason = _looksTruncated(s);
  assert(reason, 'expected truncation to be detected');
  assert(/unterminated heredoc/.test(reason), `expected heredoc reason, got: ${reason}`);
});

await it('no heredoc → not truncated', async () => {
  assertEqual(_looksTruncated('ls -la /tmp && echo done'), null);
});

await it('mid-line bit-shift / comparison inside heredoc body → no false positive', async () => {
  const s = "cat > /tmp/x.js <<'EOF'\nconst flags = a << b;\nEOF";
  assertEqual(_looksTruncated(s), null);
});

await it('second heredoc also validated', async () => {
  const s = "cat > /tmp/a <<'EOF'\nfoo\nEOF\ncat > /tmp/b <<'END'\nbar"; // END never closed
  const reason = _looksTruncated(s);
  assert(reason && reason.includes('END'), `expected END delimiter flagged, got: ${reason}`);
});

// ── Section 5: contract filePaths from argv redirect targets ────────────────

section('executeCommand — filePaths extraction from argv');

await it('_extractFilePathsFromArgv: cat heredoc redirect → destination path', async () => {
  const paths = _extractFilePathsFromArgv({ cmd: 'bash', argv: ['-c', "cat > /Users/x/Desktop/three.md <<'EOF'\ncontent\nEOF"] });
  assert(paths.includes('/Users/x/Desktop/three.md'), `expected /Users/x/Desktop/three.md, got ${JSON.stringify(paths)}`);
});

await it('_extractFilePathsFromArgv: ~/ expansion, >>, tee, curl -o', async () => {
  const home = require('os').homedir();
  assert(_extractFilePathsFromArgv({ argv: ['-c', 'cat > ~/Desktop/out.md <<EOF\nx\nEOF'] }).includes(path.join(home, 'Desktop/out.md')), 'tilde expansion');
  assert(_extractFilePathsFromArgv({ argv: ['-c', 'echo hi >> /tmp/log.txt'] }).includes('/tmp/log.txt'), 'append redirect');
  assert(_extractFilePathsFromArgv({ argv: ['-c', 'cmd | tee /tmp/t.txt'] }).includes('/tmp/t.txt'), 'tee');
  assert(_extractFilePathsFromArgv({ argv: ['-c', 'curl -sL -o /tmp/pic.jpg https://x/y'] }).includes('/tmp/pic.jpg'), 'curl -o');
});

await it('_extractFilePathsFromArgv: stderr/fd redirects and /dev are excluded', async () => {
  const paths = _extractFilePathsFromArgv({ argv: ['-c', 'cmd 2>/dev/null 1>&2 && echo ok'] });
  assertEqual(paths.length, 0);
});

await it('generateStepContract: shell.run heredoc write → outputs.filePaths populated', async () => {
  const contract = generateStepContract({
    skill: 'shell.run', ok: true,
    stdout: '', // heredoc produces no stdout — the original bug
    stderr: '', exitCode: 0,
    args: { cmd: 'bash', argv: ['-c', "cat > /Users/x/Desktop/three.md <<'EOF'\n# code\nEOF"] },
  }, 0);
  const paths = contract.outputs.filePaths.value;
  assert(paths.includes('/Users/x/Desktop/three.md'), `expected filePaths to contain destination, got ${JSON.stringify(paths)}`);
});

await it('generateStepContract: stdout paths still extracted alongside argv paths', async () => {
  const contract = generateStepContract({
    skill: 'shell.run', ok: true,
    stdout: 'SAVED: /Users/x/echoed.txt',
    stderr: '', exitCode: 0,
    args: { cmd: 'bash', argv: ['-c', "cat > /Users/x/written.txt <<'EOF'\nx\nEOF\necho 'SAVED: /Users/x/echoed.txt'"] },
  }, 0);
  const paths = contract.outputs.filePaths.value;
  assert(paths.includes('/Users/x/written.txt'), 'argv path');
  assert(paths.includes('/Users/x/echoed.txt'), 'stdout path');
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${_passed} passed, ${_failed} failed`);
if (_failures.length) {
  console.log('  Failures:');
  _failures.forEach(f => console.log(`   - ${f.label}: ${f.error}`));
}
console.log('═'.repeat(72));
process.exit(_failed ? 1 : 0);

})().catch(e => { console.error('FATAL:', e); process.exit(1); });

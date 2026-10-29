'use strict';
/**
 * browser-agent-auto-build.test.js — REWRITTEN for the deterministic-runtime
 * contract.
 *
 * The old version asserted the retired behavior: browser.agent auto-builds a
 * missing agent mid-run and recoverSkill replans with a build_agent splice.
 * Both are gone — runtime never fabricates agents. This suite asserts the new
 * contract:
 *
 *   1. cli.agent / browser.agent missing-agent paths return
 *      { ok:false, needsBuild:true } — no actionBuildAgent call anywhere in
 *      the run/explore paths (static source check — the skills require a full
 *      command-service environment to invoke).
 *   2. executeCommand converts a needsBuild step failure into a _needsPlan
 *      escalation (agent_not_onboarded) instead of splicing a build step.
 *   3. resolveAgent ignores malformed non-.agent pins ('video.ffmpeg') and
 *      keeps deterministic service coverage when the pin isn't registered
 *      (exists:false → preflight escalates for compile-time onboarding).
 *   4. preflightAgents scoped readiness — deterministic plans skip entirely;
 *      unregistered referenced agents escalate agent_not_onboarded; auth-less
 *      CLIs never produce an auth wall; missing PATH binaries escalate
 *      cli_not_installed.
 *   5. media_play template — "play the X video using the URL <u>" compiles to
 *      one shell.run open step; no service agent, no CLI.
 *
 * Run with: node test/browser-agent-auto-build.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop };

let _passed = 0, _failed = 0;
const _failures = [];
async function it(label, fn) {
  try { await fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push({ label, error: e.message }); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function section(label) { console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const ROOT = path.join(__dirname, '..', '..');
const CMD_SKILLS = path.join(ROOT, 'mcp-services', 'command-service', 'src', 'skills');
const preflightAgents = require('../src/nodes/preflightAgents.js');
const resolveAgent = require('../src/nodes/resolveAgent.js');
const { _thinPostFailureHandler } = require('../src/nodes/executeCommand.js');
const { TEMPLATES, _classifyDeterministic } = require('../src/utils/localPlanTemplates.js');

// Isolated auth-ledger — tests must not read/write the real ~/.thinkdrop cache.
const _tmpCache = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cache-')), 'auth.json');
process.env.THINKDROP_PREFLIGHT_AUTH_CACHE = _tmpCache;

// mcpAdapter stub — agent.list returns the registry the test seeds.
const _adapterFor = (agents) => ({
  callService: async (svc, action) => {
    if (action === 'agent.list') return { data: agents };
    return { data: null };
  },
});

const MIKE_WINGER = 'Play the Mike Winger video "The Entire Book in One Video: The Hebrews Series pt 1" using the URL https://www.youtube.com/watch?v=zq-Nx9bCBJ8';
const YT_URL = 'https://www.youtube.com/watch?v=zq-Nx9bCBJ8';

(async () => {

// ═══════════════════════════════════════════════════════════════════════════
section('1 — No runtime auto-build: skills return needsBuild, never build');

await it('cli.agent missing-agent branch returns needsBuild without building', () => {
  const src = fs.readFileSync(path.join(CMD_SKILLS, 'cli.agent.cjs'), 'utf8');
  // The lookup-miss result: _lookupCliRunAgent must return needsBuild +
  // missingAgent, and actionRun must pass it through without a build call.
  // (actionBuildAgent calls elsewhere — meta-task redirect for an explicit
  // "install X" user request, rebuilds — are different code paths.)
  const guardIdx = src.indexOf('agentResult.needsBuild && agentResult.missingAgent');
  assert(guardIdx > 0, 'missing-agent guard not found in cli.agent');
  const block = src.slice(guardIdx, guardIdx + 500);
  assert(/return agentResult/.test(block), 'missing-agent result not passed through');
  assert(!/actionBuildAgent\s*\(/.test(block), 'missing-agent block still calls actionBuildAgent');
  assert(/needsBuild:\s*true,\s*missingAgent:\s*true/.test(src), '_lookupCliRunAgent does not mark missing agents needsBuild+missingAgent');
});

await it('cli.agent run missing-agent returns needsBuild (source contract)', () => {
  const src = fs.readFileSync(path.join(CMD_SKILLS, 'cli.agent.cjs'), 'utf8');
  assert(/needsBuild:\s*true/.test(src), 'no needsBuild:true return in cli.agent');
  assert(/runtime no longer auto-builds|runtime never auto-builds|compile-time onboarding/.test(src),
    'cli.agent missing the no-autobuild log/comment marker');
});

await it('browser.agent run+explore missing-agent branches return needsBuild without building', () => {
  const src = fs.readFileSync(path.join(CMD_SKILLS, 'browser.agent.cjs'), 'utf8');
  // Every `if (!existing.found)` / `!q.found` missing-agent block must close
  // with a needsBuild return, not an actionBuildAgent call. (Seed-rebuild /
  // type self-heal rebuilds repair EXISTING registered agents — different
  // class, deliberately retained.)
  const hits = [...src.matchAll(/!\s*(existing|q|agentResult|_a|found)\.found|!\s*existing\.found/g)];
  assert(hits.length >= 2, `expected >=2 missing-agent branches, found ${hits.length}`);
});

await it('browser.agent missing-agent returns needsBuild with compile-time hint', () => {
  const src = fs.readFileSync(path.join(CMD_SKILLS, 'browser.agent.cjs'), 'utf8');
  const hits = src.match(/needsBuild:\s*true/g) || [];
  assert(hits.length >= 2, `expected >=2 needsBuild returns (run + explore), found ${hits.length}`);
  assert(/capability\.select|plan time/.test(src), 'missing compile-time onboarding hint');
});

await it('executeCommand has no build_agent splice for needsBuild or installs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'nodes', 'executeCommand.js'), 'utf8');
  // No constructed args object may carry action:'build_agent' — reads of
  // failedStep.args.action === 'build_agent' (authored build steps) are fine.
  assert(!/args:\s*\{[^}]*action:\s*'build_agent'/.test(src), 'executeCommand still constructs build_agent steps');
  assert(/agent_not_onboarded/.test(src), 'executeCommand missing agent_not_onboarded escalation');
  assert(/cli_not_installed/.test(src), 'executeCommand missing cli_not_installed escalation');
});

// ═══════════════════════════════════════════════════════════════════════════
section('2 — executeCommand: needsBuild → _needsPlan (agent_not_onboarded)');

await it('cli.agent needsBuild failure escalates, no splice', async () => {
  const state = {
    logger,
    skillPlan: [
      { skill: 'shell.run', args: { cmd: 'ls' } },
      { skill: 'cli.agent', args: { action: 'run', agentId: 'video.agent', task: 'x' } },
    ],
    skillCursor: 1,
    failedStep: {
      skill: 'cli.agent',
      args: { action: 'run', agentId: 'video.agent', task: 'play the video' },
      error: 'No agent found: video.agent',
      needsBuild: true,
      ok: false,
    },
    resolvedMessage: 'play the video',
    message: 'play the video',
  };
  const out = await _thinPostFailureHandler(state);
  assert(out && out._needsPlan, `expected _needsPlan, got: ${JSON.stringify(out && Object.keys(out))}`);
  assert(out._needsPlan.reason === 'agent_not_onboarded', `wrong reason: ${out._needsPlan.reason}`);
  assert(!out.skillPlan || !out.skillPlan.some(s => /build_agent/.test(JSON.stringify(s))), 'plan mutated with a build step');
});

await it('browser.agent needsBuild failure takes the same escalation', async () => {
  const state = {
    logger,
    skillPlan: [{ skill: 'browser.agent', args: { action: 'run', agentId: 'gemini.agent', task: 'x' } }],
    skillCursor: 0,
    failedStep: {
      skill: 'browser.agent',
      args: { action: 'run', agentId: 'gemini.agent' },
      error: 'Agent not found: gemini.agent',
      needsBuild: true,
      ok: false,
    },
    message: 'ask gemini something',
  };
  const out = await _thinPostFailureHandler(state);
  assert(out && out._needsPlan && out._needsPlan.reason === 'agent_not_onboarded',
    `expected agent_not_onboarded escalation, got: ${JSON.stringify(out?._needsPlan)}`);
});

await it('non-agent failures are NOT intercepted by the escalation', async () => {
  const state = {
    logger,
    skillPlan: [{ skill: 'shell.run', args: { cmd: 'ls' } }],
    skillCursor: 0,
    failedStep: { skill: 'shell.run', args: { cmd: 'ls' }, error: 'exit 1', needsBuild: true, ok: false },
    message: 'list files',
  };
  const out = await _thinPostFailureHandler(state);
  assert(!(out && out._needsPlan && out._needsPlan.reason === 'agent_not_onboarded'),
    'shell.run needsBuild must not claim agent_not_onboarded');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3 — resolveAgent: pin normalization + deterministic service coverage');

await it('malformed pin "video.ffmpeg" is ignored AND cleared from state', async () => {
  const state = {
    logger,
    intent: { type: 'command_automate' },
    message: 'play the video',
    resolvedMessage: 'play the video',
    _pinnedAgentId: 'video.ffmpeg',
    llmBackend: { generateAnswer: async () => '{"agents":[]}' },
    mcpAdapter: _adapterFor([{ id: 'catt.agent', type: 'cli' }]),
  };
  const out = await resolveAgent(state);
  const agents = out.resolveAgentResult?.agents || [];
  assert(!agents.some(a => a.agentId === 'video.ffmpeg'), 'malformed pin survived');
  assert(!agents.some(a => /ffmpeg|video/.test(a.agentId)), 'fabricated agent id in result');
  // The phantom must not leak downstream — it vetoed a media_play plan via
  // the classify pin-check (live run 15:00Z: "bypasses pinned agent
  // video.ffmpeg — vetoing; pin wins").
  assert(!out._pinnedAgentId, `malformed pin still in state._pinnedAgentId: ${out._pinnedAgentId}`);
  assert(out._pinnedAgentRejected && out._pinnedAgentRejected.id === 'video.ffmpeg',
    'rejected pin not recorded for logging');
});

await it('unregistered .agent pin is dropped AND cleared from state', async () => {
  const state = {
    logger,
    intent: { type: 'command_automate' },
    message: 'do the thing',
    resolvedMessage: 'do the thing',
    _pinnedAgentId: 'nonexistent.agent',
    llmBackend: { generateAnswer: async () => '{"agents":[]}' },
    mcpAdapter: _adapterFor([{ id: 'catt.agent', type: 'cli' }]),
  };
  const out = await resolveAgent(state);
  const agents = out.resolveAgentResult?.agents || [];
  assert(!agents.some(a => a.agentId === 'nonexistent.agent'), 'unregistered pin survived');
  assert(!out._pinnedAgentId, `unregistered pin still in state._pinnedAgentId: ${out._pinnedAgentId}`);
  assert(out._pinnedAgentRejected?.reason === 'not_registered',
    'not_registered rejection not recorded');
});

await it('bare stem pin "catt" normalizes to catt.agent when registered', async () => {
  const state = {
    logger,
    intent: { type: 'command_automate' },
    message: 'cast to the tv',
    resolvedMessage: 'cast to the tv',
    _pinnedAgentId: 'catt',
    llmBackend: { generateAnswer: async () => '{"agents":[]}' },
    mcpAdapter: _adapterFor([{ id: 'catt.agent', type: 'cli' }]),
  };
  const out = await resolveAgent(state);
  const agents = out.resolveAgentResult?.agents || [];
  assert(agents.length === 1 && agents[0].agentId === 'catt.agent',
    `expected catt.agent pin, got ${JSON.stringify(agents)}`);
  assert(agents[0].exists === true && agents[0].type === 'cli', 'pin lost registry truth');
});

await it('unregistered deterministic service pin keeps coverage (exists:false → escalate)', async () => {
  const state = {
    logger,
    intent: { type: 'command_automate' },
    message: 'check biblehub for x',
    resolvedMessage: 'check biblehub for x',
    _deterministicPlan: [{ skill: 'browser.agent', args: { action: 'run', agentId: 'biblehub.agent', task: 'x' } }],
    _deterministicExternal: true,
    _deterministicServiceAgent: 'biblehub.agent',
    llmBackend: { generateAnswer: async () => '{"agents":[]}' },
    mcpAdapter: _adapterFor([{ id: 'gmail.agent', type: 'browser' }]),
  };
  const out = await resolveAgent(state);
  const agents = out.resolveAgentResult?.agents || [];
  assert(agents.length === 1 && agents[0].agentId === 'biblehub.agent',
    `deterministic coverage dropped: ${JSON.stringify(agents)}`);
  assert(agents[0].exists === false, 'unregistered pin asserted as existing');
  assert(Array.isArray(out._deterministicPlan) && out._deterministicPlan.length === 1,
    'deterministic plan dropped on unregistered pin');
});

await it('registered deterministic service pin resolves exists:true with real type', async () => {
  const state = {
    logger,
    intent: { type: 'command_automate' },
    message: 'check gmail',
    resolvedMessage: 'check gmail',
    _deterministicPlan: [{ skill: 'browser.agent', args: { action: 'run', agentId: 'gmail.agent', task: 'x' } }],
    _deterministicExternal: true,
    _deterministicServiceAgent: 'gmail.agent',
    llmBackend: { generateAnswer: async () => '{"agents":[]}' },
    mcpAdapter: _adapterFor([{ id: 'gmail.agent', type: 'browser' }]),
  };
  const out = await resolveAgent(state);
  const agents = out.resolveAgentResult?.agents || [];
  assert(agents.length === 1 && agents[0].exists === true && agents[0].type === 'browser',
    `pin lost registry truth: ${JSON.stringify(agents)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('4 — preflightAgents: scoped readiness, no fabrication');

await it('deterministic plan fast-path — zero agent work', async () => {
  const out = await preflightAgents({
    logger,
    message: 'list files',
    resolvedMessage: 'list files',
    _deterministicPlan: [{ skill: 'shell.run', args: { cmd: 'ls', argv: ['-la'] } }],
    mcpAdapter: _adapterFor([]),
  });
  assert(out.preflightResult && out.preflightResult.skipped === 'deterministic',
    `expected deterministic skip, got ${JSON.stringify(out.preflightResult)}`);
  assert(!out._needsPlan, 'deterministic plan must not escalate');
});

await it('media_play plan (shell.run open) skips preflight entirely', async () => {
  const out = await preflightAgents({
    logger,
    message: MIKE_WINGER,
    resolvedMessage: MIKE_WINGER,
    _deterministicPlan: [{ skill: 'shell.run', args: { cmd: 'open', argv: [YT_URL] } }],
    _deterministicTemplate: 'media_play',
    mcpAdapter: _adapterFor([]),
  });
  assert(out.preflightResult?.skipped === 'deterministic' && !out._needsPlan,
    'media_play deterministic plan must execute without preflight');
});

await it('unregistered referenced agent → agent_not_onboarded escalation', async () => {
  const out = await preflightAgents({
    logger,
    message: 'use nylas to check mail',
    resolvedMessage: 'use nylas to check mail',
    _deterministicPlan: [{ skill: 'cli.agent', args: { action: 'run', agentId: 'video.agent', task: 'x' } }],
    _deterministicExternal: true,
    _deterministicServiceAgent: 'video.agent',
    mcpAdapter: _adapterFor([{ id: 'gmail.agent', type: 'browser' }]),
  });
  assert(out._needsPlan && out._needsPlan.reason === 'agent_not_onboarded',
    `expected agent_not_onboarded, got ${JSON.stringify(out._needsPlan)}`);
  assert((out._needsPlan.missingAgents || []).includes('video.agent'), 'missingAgents lacks video.agent');
});

await it('auth-less registered CLI passes unconditionally (no phantom auth wall)', async () => {
  // catt-style cli agent: descriptor declares NO auth surface → never gated.
  const agents = [{ id: 'catt.agent', type: 'cli', cliTool: 'catt', capabilities: ['play', 'pause'] }];
  const out = await preflightAgents({
    logger,
    message: 'cast to the tv',
    resolvedMessage: 'cast to the tv',
    _deterministicPlan: [{ skill: 'cli.agent', args: { action: 'run', agentId: 'catt.agent', task: 'cast x' } }],
    _deterministicExternal: true,
    _deterministicServiceAgent: 'catt.agent',
    mcpAdapter: _adapterFor(agents),
  });
  // catt may not be installed on this machine → cli_not_installed is the only
  // acceptable escalation; an auth_required result is the phantom wall.
  assert(!(out._needsPlan && out._needsPlan.reason === 'auth_required'),
    `phantom auth wall: ${JSON.stringify(out._needsPlan)}`);
});

await it('missing PATH binary in plan argv → cli_not_installed (never installs)', async () => {
  const out = await preflightAgents({
    logger,
    message: 'convert the video',
    resolvedMessage: 'convert the video',
    _deterministicPlan: [{ skill: 'shell.run', args: { cmd: 'definitely-not-a-real-binary-xyz', argv: ['-i', 'a'] } }],
    _deterministicExternal: true, // bypass the early deterministic skip to exercise the bin check
    mcpAdapter: _adapterFor([]),
  });
  assert(out._needsPlan && out._needsPlan.reason === 'cli_not_installed',
    `expected cli_not_installed, got ${JSON.stringify(out._needsPlan)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('5 — media_play template: the Mike Winger regression');

await it('media_play template exists and validates the exact prompt', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'media_play');
  assert(tmpl, 'media_play template missing');
  const err = tmpl.validate({ url: YT_URL }, MIKE_WINGER);
  assert(err === null, `validate rejected the exact prompt: ${err}`);
});

await it('media_play builds one shell.run open step — no agent, no CLI', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'media_play');
  const plan = tmpl.build({ url: YT_URL }, MIKE_WINGER);
  assert(plan.length === 1, `expected 1 step, got ${plan.length}`);
  assert(plan[0].skill === 'shell.run', `wrong skill: ${plan[0].skill}`);
  assert(plan[0].args.cmd === 'open', `wrong cmd: ${plan[0].args.cmd}`);
  assert(plan[0].args.argv[0] === YT_URL, `wrong url: ${plan[0].args.argv[0]}`);
});

await it('media_play rejects a URL not verbatim in the message', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'media_play');
  const err = tmpl.validate({ url: 'https://evil.example/x' }, MIKE_WINGER);
  assert(err !== null, 'non-verbatim URL accepted');
});

await it('media_play rejects cast/device intent (route, not a browser play)', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'media_play');
  const err = tmpl.validate({ url: YT_URL }, `cast the video at ${YT_URL} to the tv`);
  assert(err !== null, 'cast intent accepted');
});

await it('media_play rejects non-media URL opens (url_open owns those)', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'media_play');
  const err = tmpl.validate({ url: YT_URL }, `open ${YT_URL} for me`);
  assert(err !== null, 'no media cue — should defer to url_open');
});

await it('classify prompt advertises media_play', () => {
  const { _CLASSIFY_PROMPT } = require('../src/utils/localPlanTemplates.js');
  const prompt = _CLASSIFY_PROMPT(MIKE_WINGER, null, null, null);
  assert(/media_play/.test(prompt), 'media_play missing from classify prompt');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6 — pin veto: malformed pins never veto, real pins still do');

// Live 15:00Z regression: comms-graph pinned capability-id 'video.ffmpeg' as
// _pinnedAgentId; the classify correctly picked media_play but _accept vetoed
// it ("bypasses pinned agent video.ffmpeg — pin wins") → needs_plan → a 2m43s
// invented cast task. A pin that isn't a .agent id must never veto.
const _mediaBackend = {
  generateAnswer: async () => JSON.stringify({ n: 26, args: { url: YT_URL } }),
};

await it('media_play survives a malformed capability-id pin (video.ffmpeg)', async () => {
  const hit = await _classifyDeterministic(MIKE_WINGER, null, _mediaBackend, logger, 'video.ffmpeg');
  assert(hit && hit.template === 'media_play',
    `malformed pin vetoed media_play — got ${JSON.stringify(hit)}`);
  assert(Array.isArray(hit.skillPlan) && hit.skillPlan.length === 1,
    'media_play plan missing');
});

await it('media_play survives a bare-stem pin normalization (not an agent)', async () => {
  // 'catt' normalizes to catt.agent — a REAL pin shape. media_play isn't
  // external so a real pin still vetoes it (pin wins over generic templates).
  const hit = await _classifyDeterministic(MIKE_WINGER, null, _mediaBackend, logger, 'catt');
  assert(!hit, `bare-stem real pin should veto media_play, got ${JSON.stringify(hit)}`);
});

await it('registered-shaped .agent pin still vetoes a non-external template', async () => {
  const hit = await _classifyDeterministic(MIKE_WINGER, null, _mediaBackend, logger, 'catt.agent');
  assert(!hit, `real pin should veto media_play, got ${JSON.stringify(hit)}`);
});

await it('no pin → media_play classifies cleanly', async () => {
  const hit = await _classifyDeterministic(MIKE_WINGER, null, _mediaBackend, logger, null);
  assert(hit && hit.template === 'media_play',
    `media_play did not classify without pin — got ${JSON.stringify(hit)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('7 — capability-index: word-boundary scoring');

await it('_matchScore uses word-boundary, not substring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'capability-index.cjs'), 'utf8');
  const fnStart = src.indexOf('function _matchScore');
  const fnEnd = src.indexOf('\n}', fnStart);
  const body = src.slice(fnStart, fnEnd);
  assert(!/hay\.includes\(/.test(body), '_matchScore still uses substring includes()');
  assert(/words\.has\(/.test(body), '_matchScore missing word-set matching');
});

await it('comms-graph pin contract: only .agent ids may pin', () => {
  const src = fs.readFileSync(path.join(ROOT, 'comms-graph', 'src', 'server.cjs'), 'utf8');
  // The decision-model pin must reject capability ids — the pin returned to
  // the runtime becomes state._pinnedAgentId and must be executable.
  const pinIdx = src.indexOf('decision-model pin');
  assert(pinIdx > 0, 'decision-model pin block missing');
  const block = src.slice(Math.max(0, pinIdx - 700), pinIdx + 1200);
  assert(/endsWith\('\.agent'\)/.test(block), 'pin contract does not check .agent suffix');
});

// ═══════════════════════════════════════════════════════════════════════════
const sep = '═'.repeat(72);
console.log(`\n${sep}`);
if (_failed === 0) {
  console.log(`  Results: ${_passed} passed, ${_failed} failed  (${_passed + _failed} total)`);
} else {
  console.log(`  Results: ${_passed} passed, ${_failed} failed  (${_passed + _failed} total)\n`);
  for (const { label, error } of _failures) console.log(`  ❌ ${label}\n     ${error}`);
}
console.log(`${sep}\n`);
process.exit(_failed > 0 ? 1 : 0);
})();

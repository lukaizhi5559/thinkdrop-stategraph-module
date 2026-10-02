'use strict';
/**
 * preflightAgents.test.js
 *
 * Regression tests for the authenticate-and-block flow in
 * stategraph-module/src/nodes/preflightAgents.js.
 *
 * Run from repo root with:
 *   node stategraph-module/test/preflightAgents.test.js
 */

const fs  = require('fs');
const os  = require('os');
const path = require('path');

const preflightAgents = require(path.resolve(__dirname, '..', 'src/nodes/preflightAgents.js'));

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

function makeState({ authSequence, agents, gatherCredentialResult, gatherAnswerResult, userMessage, llmBackend } = {}) {
  const progressEvents = [];
  const calls = [];
  let authIndex = 0;

  const mcpAdapter = {
    calls,
    async callService(service, action, payload, opts) {
      calls.push({ service, action, payload, opts });
      if (service === 'command' && action === 'agent.list') {
        return { data: agents || [] };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'browser.agent' && payload?.args?.action === 'build_agent') {
        const svc = payload.args.service;
        return { data: { ok: true, agentId: `${svc}.agent`, alreadyExists: false, service: svc, startUrl: `https://${svc}.com`, capabilities: ['navigate', 'interact'] } };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [] } };
      }
      if ((service === 'command' && action === 'browser.agent' && payload?.action === 'authenticate') ||
          (service === 'command' && action === 'command.automate' && payload?.skill === 'browser.agent' && payload?.args?.action === 'authenticate')) {
        const res = authSequence[authIndex % authSequence.length];
        authIndex++;
        return res;
      }
      if (service === 'command' && action === 'ping') {
        return { ok: true };
      }
      if (service === 'user-memory' && action === 'skill.list') {
        return { data: [] };
      }
      return null;
    },
  };

  return {
    intent: { type: 'command_automate' },
    message: userMessage || 'do something with testagent',
    resolvedMessage: userMessage || 'do something with testagent',
    mcpAdapter,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    progressCallback: (ev) => progressEvents.push(ev),
    gatherCredentialCallback: async () => gatherCredentialResult || { stored: true },
    gatherAnswerCallback: async () => gatherAnswerResult || 'yes',
    confirmInstallCallback: async () => false,
    gatherOAuthCallback: async () => ({ connected: false }),
    resolveAgentResult: { agents: [] },
    llmBackend,
    _progressEvents: progressEvents,
  };
}

function _profileDirFor(serviceKey) {
  return path.join(os.homedir(), '.thinkdrop', 'browser-profiles', `${serviceKey}_agent`);
}

function _makeCookieMtime(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function _setupBrowserProfile(serviceKey, daysAgo) {
  const profileDir = _profileDirFor(serviceKey);
  const defaultDir = path.join(profileDir, 'Default');
  const cookieFile = path.join(defaultDir, 'Cookies');
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (_) {}
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(cookieFile, 'sqlite-format-3');
  const mtime = _makeCookieMtime(daysAgo);
  fs.utimesSync(cookieFile, mtime, mtime);
  return profileDir;
}

function _cleanupBrowserProfile(serviceKey) {
  try {
    fs.rmSync(_profileDirFor(serviceKey), { recursive: true, force: true });
  } catch (_) {}
}

// ── Test isolation: point the auth ledger at a temp file so tests neither
// read nor pollute the real ~/.thinkdrop/preflight-auth-cache.json.
const _TMP_AUTH_CACHE = path.join(os.tmpdir(), `pf-auth-cache-test-${process.pid}.json`);
process.env.THINKDROP_PREFLIGHT_AUTH_CACHE = _TMP_AUTH_CACHE;
function _resetLedger(entries = {}) {
  try { fs.writeFileSync(_TMP_AUTH_CACHE, JSON.stringify(entries, null, 2)); } catch (_) {}
  if (preflightAgents.clearAuthCache) { /* in-memory per-agent */ }
}
function _readLedger() {
  try { return JSON.parse(fs.readFileSync(_TMP_AUTH_CACHE, 'utf8')); } catch (_) { return {}; }
}

async function runTests() {
  _resetLedger({});
  section('Credential agent auth flow');

  await it('authenticates an api_key agent after collecting credentials', async () => {
    const state = makeState({
      agents: [
        { id: 'testagent.agent', type: 'api_key', service: 'testagent', capabilities: ['call_api'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, askUser: true, needsCredentials: true, credentialKey: 'credential:testagent.agent:PRIMARY', question: 'What API key?', authType: 'api_key' },
        { ok: true, agentId: 'testagent.agent', authed: true },
      ],
    });
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === 'testagent.agent');
    if (!agent) throw new Error('testagent.agent not in preflightResult.agents');
    if (!agent.authed) throw new Error('Expected agent to be authed');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required');
    const readyEvents = state._progressEvents.filter(e => e.type === 'preflight:agent_ready');
    if (authEvents.length < 1) throw new Error('Expected preflight:auth_required event');
    if (readyEvents.length !== 1) throw new Error(`Expected one preflight:agent_ready event, got ${readyEvents.length}`);
  });

  await it('fails auth when the credential callback returns stored:false', async () => {
    const state = makeState({
      agents: [
        { id: 'testagent.agent', type: 'api_key', service: 'testagent', capabilities: ['call_api'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, askUser: true, needsCredentials: true, credentialKey: 'credential:testagent.agent:PRIMARY', question: 'What API key?', authType: 'api_key' },
      ],
      gatherCredentialResult: { stored: false },
    });
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError due to missing credential');
    const failedEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_failed');
    if (failedEvents.length < 1) throw new Error('Expected preflight:auth_failed event');
  });

  await it('surfaces a plan error when no credential callback is provided', async () => {
    const state = makeState({
      agents: [
        { id: 'testagent.agent', type: 'api_key', service: 'testagent', capabilities: ['call_api'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, askUser: true, needsCredentials: true, credentialKey: 'credential:testagent.agent:PRIMARY', question: 'What API key?', authType: 'api_key' },
      ],
    });
    delete state.gatherCredentialCallback;
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError due to missing callback');
    if (!result.planError.includes('UI credential prompt is not available')) {
      throw new Error(`Expected explicit callback-missing message, got: ${result.planError}`);
    }
  });

  await it('marks first-contact browser agent auth-required without a probe when no LLM backend', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: 'browserfail.agent', type: 'browser', service: 'browserfail', capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, error: 'network unreachable' },
      ],
      userMessage: 'do something with browserfail',
    });
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError due to required auth');
    if (!result.planError.includes('browserfail.agent')) {
      throw new Error(`Expected agent id in planError, got: ${result.planError}`);
    }
    // No authenticate probe — the ledger classified first-contact as needs-auth.
    const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
    if (authCalls.length !== 0) throw new Error(`Expected zero authenticate calls, got ${authCalls.length}`);
    if ((_readLedger()['browserfail.agent'] || {}).needsAuth !== 1) {
      throw new Error('Expected needsAuth=1 recorded in ledger');
    }
  });

  await it('emits progress events per agent and aborts on first failure', async () => {
    const state = makeState({
      agents: [
        { id: 'first.agent', type: 'api_key', service: 'first', capabilities: ['call_api'], status: 'healthy' },
        { id: 'second.agent', type: 'api_key', service: 'second', capabilities: ['call_api'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, askUser: true, needsCredentials: true, credentialKey: 'credential:first.agent:PRIMARY', question: 'What API key?', authType: 'api_key' },
      ],
      gatherCredentialResult: { stored: false },
      userMessage: 'do something with first',
    });
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError to abort pipeline');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required');
    if (authEvents.length !== 2) throw new Error(`Expected two auth_required events (registry scan), got ${authEvents.length}`);
  });

  section('Browser profile migration verify (pre-ledger sessions)');

  await it('fires a one-time background verify for an existing profile with no ledger entry', async () => {
    _resetLedger({});
    const serviceKey = 'preflightstaletest';
    _cleanupBrowserProfile(serviceKey);
    _setupBrowserProfile(serviceKey, 8);
    try {
      const state = makeState({
        agents: [
          { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
        ],
        authSequence: [
          { ok: true, agentId: `${serviceKey}.agent`, authed: true, authVerified: true },
        ],
        userMessage: `do something with ${serviceKey}`,
      });
      const result = await preflightAgents(state);
      if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
      // The migration verify is the ONLY authenticate call — fired once via command.automate
      const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
      if (authCalls.length !== 1) throw new Error(`Expected one migration-verify authenticate call, got ${authCalls.length}`);
      const staleWarnings = state._progressEvents.filter(e => e.type === 'preflight:auth_required');
      if (staleWarnings.length !== 0) throw new Error(`Expected no auth_required after a verified profile, got ${staleWarnings.length}`);
      // Verify stamped the ledger permanently
      if ((_readLedger()[`${serviceKey}.agent`] || {}).authed !== true) {
        throw new Error('Expected ledger stamped authed:true after successful verify');
      }
    } finally {
      _cleanupBrowserProfile(serviceKey);
    }
  });

  await it('flips to auth-required + stamps authed:false when the migration verify hits a login wall', async () => {
    _resetLedger({});
    const serviceKey = 'preflightmigfail';
    _cleanupBrowserProfile(serviceKey);
    _setupBrowserProfile(serviceKey, 2);
    try {
      const state = makeState({
        agents: [
          { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
        ],
        authSequence: [
          { ok: false, authRequired: true, error: 'login wall detected' },
        ],
        userMessage: `do something with ${serviceKey}`,
      });
      const result = await preflightAgents(state);
      if (!result.planError) throw new Error('Expected planError after login-wall verify');
      const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === `${serviceKey}.agent`);
      if (authEvents.length < 1) throw new Error('Expected preflight:auth_required after login-wall verify');
      const entry = _readLedger()[`${serviceKey}.agent`] || {};
      if (entry.authed !== false || !entry.lastAuthFailedAt) {
        throw new Error(`Expected ledger authed:false + lastAuthFailedAt, got ${JSON.stringify(entry)}`);
      }
    } finally {
      _cleanupBrowserProfile(serviceKey);
    }
  });

  await it('skips auth entirely for a ledger-authed agent (no probe, no LLM)', async () => {
    const serviceKey = 'ledgerauthedtest';
    _cleanupBrowserProfile(serviceKey); // no profile — ledger alone is trusted
    _resetLedger({ [`${serviceKey}.agent`]: { authed: true, ts: Date.now() - 5 * 24 * 60 * 60 * 1000 } });
    let llmCalls = 0;
    const state = makeState({
      agents: [
        { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, error: 'authenticate must not be called for ledger-authed agent' },
      ],
      llmBackend: { generateAnswer: async () => { llmCalls++; return '1'; } },
      userMessage: `do something with ${serviceKey}`,
    });
    state.resolveAgentResult = { agents: [{ agentId: `${serviceKey}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === `${serviceKey}.agent`);
    if (!agent?.authed) throw new Error('Expected ledger-authed agent authed');
    const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
    if (authCalls.length !== 0) throw new Error(`Expected zero authenticate calls, got ${authCalls.length}`);
    if (llmCalls !== 0) throw new Error(`Expected zero LLM calls for ledger-authed agent, got ${llmCalls}`);
  });

  await it('goes straight to auth-required for a ledger-failed agent (authed:false, no probe)', async () => {
    const serviceKey = 'ledgerfailedtest';
    _resetLedger({ [`${serviceKey}.agent`]: { authed: false, lastAuthFailedAt: Date.now() - 60 * 1000, ts: Date.now() - 60 * 1000 } });
    const state = makeState({
      agents: [
        { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, error: 'authenticate must not be called for ledger-failed agent' },
      ],
      userMessage: `do something with ${serviceKey}`,
    });
    state.resolveAgentResult = { agents: [{ agentId: `${serviceKey}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError for ledger-failed agent');
    const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
    if (authCalls.length !== 0) throw new Error(`Expected zero authenticate calls, got ${authCalls.length}`);
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === `${serviceKey}.agent`);
    if (authEvents.length < 1) throw new Error('Expected preflight:auth_required for ledger-failed agent');
  });

  await it('lets a newer authed_at override an older ledger failure (re-auth wins)', async () => {
    const serviceKey = 'ledgerreauthtest';
    const failedAt = Date.now() - 24 * 60 * 60 * 1000;
    _resetLedger({ [`${serviceKey}.agent`]: { authed: false, lastAuthFailedAt: failedAt, ts: failedAt } });
    const state = makeState({
      agents: [
        { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy', authedAt: Date.now() - 60 * 1000 },
      ],
      userMessage: `do something with ${serviceKey}`,
    });
    state.resolveAgentResult = { agents: [{ agentId: `${serviceKey}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === `${serviceKey}.agent`);
    if (!agent?.authed) throw new Error('Expected authed — newer authed_at overrides stale failure');
  });

  await it('treats ledger needsAuth:0 as login-not-required without an LLM call', async () => {
    const serviceKey = 'needsnoauthtest';
    _cleanupBrowserProfile(serviceKey);
    _resetLedger({ [`${serviceKey}.agent`]: { needsAuth: 0, ts: Date.now() } });
    let llmCalls = 0;
    const state = makeState({
      agents: [
        { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      llmBackend: { generateAnswer: async () => { llmCalls++; return '1'; } },
      userMessage: `do something with ${serviceKey}`,
    });
    state.resolveAgentResult = { agents: [{ agentId: `${serviceKey}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === `${serviceKey}.agent`);
    if (!agent?.authed) throw new Error('Expected authed for needsAuth:0');
    if (llmCalls !== 0) throw new Error(`Expected zero LLM calls for needsAuth:0, got ${llmCalls}`);
  });

  // ── CLI-first preflight regression tests ───────────────────────────────────
  section('CLI-first preflight: setupInfo, routing, and blocking');

  await it('passes explicit CLI agent descriptors with setupInfo to preflight_check', async () => {
    const descriptor = [
      '---',
      'id: gcalcli.agent',
      'type: cli',
      'service: gcalcli',
      'cli_tool: gcalcli',
      '---',
      '## Setup Info',
      '- installCmd: pip install gcalcli',
      '- authCmd: gcalcli list',
      '- credentials: ["oauth"]',
      '- setupUrl: https://github.com/insanum/gcalcli',
      '## Instructions',
      'Use gcalcli for Google Calendar operations.',
    ].join('\n');

    let capturedPreflightPayload = null;
    const cliAgent = { id: 'gcalcli.agent', type: 'cli', service: 'gcalcli', cli_tool: 'gcalcli', capabilities: ['list_events'], status: 'healthy', descriptor };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'list my calendar events',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'gcalcli.agent', create: false }] };
    // Override the cli.agent preflight_check handler to capture the payload
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') {
        return { data: [cliAgent] };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        capturedPreflightPayload = payload;
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: true, authStatus: 'authenticated', authUser: 'user@test.com', agentId: 'gcalcli.agent', setupInfo: { installCmd: 'pip install gcalcli', authCmd: 'gcalcli list' } },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (!capturedPreflightPayload) throw new Error('cli.agent preflight_check was never called');
    const agents = capturedPreflightPayload.args?.agents;
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('Expected explicit agents array in preflight_check payload');
    const gcalAgent = agents.find(a => a.id === 'gcalcli.agent');
    if (!gcalAgent) throw new Error('gcalcli.agent not in explicit agents list');
    if (!gcalAgent.setupInfo) throw new Error('Expected setupInfo in explicit agent descriptor');
    if (gcalAgent.setupInfo.installCmd !== 'pip install gcalcli') throw new Error(`Expected installCmd 'pip install gcalcli', got '${gcalAgent.setupInfo.installCmd}'`);
    if (gcalAgent.setupInfo.authCmd !== 'gcalcli list') throw new Error(`Expected authCmd 'gcalcli list', got '${gcalAgent.setupInfo.authCmd}'`);
  });

  await it('CLI-first routing suppresses browser route when CLI agent is ready', async () => {
    const browserAgent = { id: 'github.agent', type: 'browser', service: 'github', capabilities: ['navigate'], status: 'healthy', authedAt: new Date().toISOString() };
    const state = makeState({
      agents: [
        { id: 'github.agent', type: 'cli', service: 'github', cli_tool: 'gh', capabilities: ['create_pr'], status: 'healthy' },
        browserAgent,
      ],
      userMessage: 'create a github pr',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'github.agent', create: false }] };
    // Override preflight_check to return CLI as installed+authed
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') {
        return { data: [
          { id: 'github.agent', type: 'cli', service: 'github', cli_tool: 'gh', capabilities: ['create_pr'], status: 'healthy' },
          browserAgent,
        ] };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'github', cli: 'gh', installed: true, authStatus: 'authenticated', authUser: 'user@test.com', agentId: 'github.agent' },
        ] } };
      }
      if (service === 'command' && action === 'browser.agent' && payload?.action === 'authenticate') {
        return { ok: true, agentId: 'github.agent', authed: true, authVerified: true };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agents = result.preflightResult?.agents || [];
    const cliAgentResult = agents.find(a => a.agentId === 'github.agent' && a.type === 'cli');
    const browserAgentResult = agents.find(a => a.agentId === 'github.agent' && a.type === 'browser');
    if (!cliAgentResult) throw new Error('Expected CLI github.agent in preflightResult');
    if (browserAgentResult) throw new Error('Expected browser github.agent to be suppressed by CLI-first routing');
  });

  await it('CLI agent not authed blocks plan with preflightAuthRequired and cli_setup auth type', async () => {
    const cliAgent = { id: 'gcalcli.agent', type: 'cli', service: 'gcalcli', cli_tool: 'gcalcli', capabilities: ['list_events'], status: 'healthy' };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'list my calendar events',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'gcalcli.agent', create: false }] };
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [cliAgent] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: true, authStatus: 'not_authenticated', authUser: null, agentId: 'gcalcli.agent', setupInfo: { installCmd: 'pip install gcalcli', authCmd: 'gcalcli list' } },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError due to unauthenticated CLI agent');
    if (!result.preflightAuthRequired) throw new Error('Expected preflightAuthRequired to be true');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'gcalcli.agent');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event for gcalcli.agent');
    if (authEvents[0].authType !== 'cli_setup') throw new Error(`Expected authType 'cli_setup', got '${authEvents[0].authType}'`);
    if (!authEvents[0].setupInfo) throw new Error('Expected setupInfo in auth_required event');
  });

  await it('_parseSetupInfo parses markdown ## Setup Info section correctly', async () => {
    const descriptor = [
      '---',
      'id: test.agent',
      'type: cli',
      '---',
      '## Setup Info',
      '- installCmd: brew install testcli',
      '- authCmd: testcli login',
      '- credentials: ["api_key", "token"]',
      '- setupUrl: https://example.com/setup',
      '- verifyCmd: testcli whoami',
      '## Instructions',
      'Use testcli for things.',
    ].join('\n');

    // Access the internal _parseSetupInfo function exported from the module
    // It's not exported, so we test indirectly via the preflight flow
    const cliAgent = { id: 'test.agent', type: 'cli', service: 'test', cli_tool: 'testcli', capabilities: ['test'], status: 'healthy', descriptor };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'run test command',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'test.agent', create: false }] };
    let capturedAgents = null;
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [cliAgent] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        capturedAgents = payload.args?.agents || [];
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    await preflightAgents(state);
    if (!capturedAgents || capturedAgents.length === 0) throw new Error('Expected agents to be passed to preflight_check');
    const testAgent = capturedAgents.find(a => a.id === 'test.agent');
    if (!testAgent) throw new Error('test.agent not found in captured agents');
    if (!testAgent.setupInfo) throw new Error('Expected setupInfo to be parsed from descriptor');
    if (testAgent.setupInfo.installCmd !== 'brew install testcli') throw new Error(`Expected installCmd 'brew install testcli', got '${testAgent.setupInfo.installCmd}'`);
    if (testAgent.setupInfo.authCmd !== 'testcli login') throw new Error(`Expected authCmd 'testcli login', got '${testAgent.setupInfo.authCmd}'`);
    if (testAgent.setupInfo.verifyCmd !== 'testcli whoami') throw new Error(`Expected verifyCmd 'testcli whoami', got '${testAgent.setupInfo.verifyCmd}'`);
    if (!Array.isArray(testAgent.setupInfo.credentials) || testAgent.setupInfo.credentials.length !== 2) {
      throw new Error(`Expected credentials array with 2 items, got ${JSON.stringify(testAgent.setupInfo.credentials)}`);
    }
  });

  await it('CLI agent not installed emits cli_setup auth_required with setupInfo', async () => {
    const state = makeState({
      agents: [],
      userMessage: 'list my calendar events with gcalcli',
    });
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: false, authStatus: 'unknown', agentId: 'gcalcli.agent', setupInfo: { installCmd: 'pip install gcalcli' } },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    // CLI discovered by keyword fallback won't be in selectedAgentIds, so planError
    // may not be set. But the auth_required event must be emitted.
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.serviceName === 'gcalcli');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event for gcalcli');
    if (authEvents[0].authType !== 'cli_setup') throw new Error(`Expected authType 'cli_setup', got '${authEvents[0].authType}'`);
    if (!authEvents[0].setupInfo || !authEvents[0].setupInfo.installCmd) throw new Error('Expected setupInfo.installCmd in auth_required event');
    // Also verify the agent is in agentReadiness with ready=false
    const cliAgentInReadiness = (result.preflightResult?.agents || []).find(a => a.agentId === 'gcalcli.agent');
    if (!cliAgentInReadiness) throw new Error('Expected gcalcli.agent in preflightResult.agents');
    if (cliAgentInReadiness.ready) throw new Error('Expected gcalcli.agent to be not ready (not installed)');
  });

  await it('enriches incomplete setupInfo via web search when CLI not installed', async () => {
    const state = makeState({ agents: [], userMessage: 'list my calendar events with gcalcli' });
    let discoverSetupCalled = false;
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: false, authStatus: 'not_installed', agentId: 'gcalcli.agent', setupInfo: { installCmd: 'pip install gcalcli' } },
        ] } };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'web.agent' && payload?.args?.action === 'discover_setup') {
        discoverSetupCalled = true;
        return { data: { ok: true, setupInfo: { authCmd: 'gcalcli auth', setupUrl: 'https://github.com/insanum/gcalcli', credentials: ['oauth'] } } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    await preflightAgents(state);
    if (!discoverSetupCalled) throw new Error('Expected web.agent discover_setup when CLI not installed');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.serviceName === 'gcalcli');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event');
    const si = authEvents[0].setupInfo;
    if (si.installCmd !== 'pip install gcalcli') throw new Error('Descriptor installCmd should be preserved');
    if (si.authCmd !== 'gcalcli auth') throw new Error('Discovered authCmd should be filled');
    if (!si.setupUrl) throw new Error('Discovered setupUrl should be filled');
  });

  await it('skips web search when --help discovery provided rich setupInfo', async () => {
    const state = makeState({ agents: [], userMessage: 'list my calendar events with gcalcli' });
    let discoverSetupCalled = false;
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: true, authStatus: 'oauth_required', agentId: 'gcalcli.agent',
            setupInfo: { initCmd: 'gcalcli init', authCmd: 'gcalcli init', credentials: ['oauth'], instructions: 'Requires OAuth client ID and secret. Run `gcalcli init` to configure.' } },
        ] } };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'web.agent' && payload?.args?.action === 'discover_setup') {
        discoverSetupCalled = true;
        return { data: { ok: true, setupInfo: { authCmd: 'should not be used' } } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    await preflightAgents(state);
    if (discoverSetupCalled) throw new Error('web.agent discover_setup should NOT be called when --help provided rich setupInfo');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.serviceName === 'gcalcli');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event');
    if (!authEvents[0].reason.includes('OAuth')) throw new Error(`Expected reason to mention OAuth, got '${authEvents[0].reason}'`);
    if (!authEvents[0].reason.includes('gcalcli init')) throw new Error(`Expected reason to include command, got '${authEvents[0].reason}'`);
    const si = authEvents[0].setupInfo;
    if (si.authCmd !== 'gcalcli init') throw new Error('--help authCmd should be preserved, not overwritten by web search');
  });

  await it('CLI agent with authStatus configured (credential file found) passes preflight', async () => {
    const cliAgent = { id: 'gcalcli.agent', type: 'cli', service: 'gcalcli', cli_tool: 'gcalcli', capabilities: ['list_events'], status: 'healthy' };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'list my calendar events',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'gcalcli.agent', create: false }] };
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [cliAgent] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: true, authStatus: 'configured', authed: true, authUser: null, agentId: 'gcalcli.agent', setupInfo: { initCmd: 'gcalcli init', credentials: ['oauth'] } },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError for configured CLI: ${result.planError}`);
    if (result.preflightAuthRequired) throw new Error('Expected preflightAuthRequired to be false for configured CLI');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'gcalcli.agent');
    if (authEvents.length > 0) throw new Error('Did not expect preflight:auth_required event for configured CLI');
    const cliAgentResult = (result.preflightResult?.agents || []).find(a => a.agentId === 'gcalcli.agent');
    if (!cliAgentResult) throw new Error('Expected gcalcli.agent in preflightResult');
    if (!cliAgentResult.authed) throw new Error('Expected gcalcli.agent authed=true for configured status');
    if (!cliAgentResult.ready) throw new Error('Expected gcalcli.agent ready=true for configured status');
  });

  await it('CLI agent with authStatus authenticated via discovered verifyCmd passes preflight', async () => {
    const cliAgent = { id: 'gcalcli.agent', type: 'cli', service: 'gcalcli', cli_tool: 'gcalcli', capabilities: ['list_events'], status: 'healthy' };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'list my calendar events',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'gcalcli.agent', create: false }] };
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [cliAgent] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: true, authStatus: 'authenticated', authed: true, authUser: null, agentId: 'gcalcli.agent', setupInfo: { verifyCmd: ['list'], initCmd: 'gcalcli init', credentials: ['oauth'] } },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError for authenticated CLI: ${result.planError}`);
    if (result.preflightAuthRequired) throw new Error('Expected preflightAuthRequired to be false for authenticated CLI');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'gcalcli.agent');
    if (authEvents.length > 0) throw new Error('Did not expect preflight:auth_required event for authenticated CLI');
  });

  await it('CLI agent with auth-failure patterns in verifyCmd output emits auth_required', async () => {
    const cliAgent = { id: 'gcalcli.agent', type: 'cli', service: 'gcalcli', cli_tool: 'gcalcli', capabilities: ['list_events'], status: 'healthy' };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'list my calendar events',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'gcalcli.agent', create: false }] };
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [cliAgent] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: true, authStatus: 'not_authenticated', authed: false, authUser: null, agentId: 'gcalcli.agent', setupInfo: { verifyCmd: ['list'], initCmd: 'gcalcli init', credentials: ['oauth'] } },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (!result.preflightAuthRequired) throw new Error('Expected preflightAuthRequired to be true for not_authenticated CLI');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'gcalcli.agent');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event for not_authenticated CLI');
  });

  await it('CLI agent with authStatus unknown and no credential files emits auth_required', async () => {
    const cliAgent = { id: 'unknowntool.agent', type: 'cli', service: 'unknowntool', cli_tool: 'unknowntool', capabilities: ['stuff'], status: 'healthy' };
    const state = makeState({
      agents: [cliAgent],
      userMessage: 'do stuff with unknowntool',
    });
    state.resolveAgentResult = { agents: [{ agentId: 'unknowntool.agent', create: false }] };
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [cliAgent] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'unknowntool', cli: 'unknowntool', installed: true, authStatus: 'unknown', authed: null, authUser: null, agentId: 'unknowntool.agent', setupInfo: null },
        ] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (!result.preflightAuthRequired) throw new Error('Expected preflightAuthRequired for unknown auth status CLI');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'unknowntool.agent');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event for unknown auth status CLI');
  });

  await it('noCli build failure soft-fails to shell.run fallback instead of planError', async () => {
    // Resolver hallucinated a CLI agent for a service that has no CLI tool.
    // cli.agent build_agent returns { ok: false, noCli: true, error: 'No CLI found...' }.
    // preflight should NOT set planError — it should warn and let planning fall back
    // to generic shell.run.
    const state = makeState({
      agents: [],
      userMessage: 'check the time on my computer',
    });
    state.resolveAgentResult = {
      agents: [{ agentId: 'system_time.agent', create: true, type: 'cli', service: 'system_time' }],
    };
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'build_agent') {
        return { data: { ok: false, noCli: true, service: 'system_time', error: 'No CLI found for "system_time". LLM lookup returned no CLI or install method.' } };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Expected no planError for noCli soft-fail, got: ${result.planError}`);
    const skipEvents = state._progressEvents.filter(e => e.type === 'preflight:agent_create_skipped');
    if (skipEvents.length === 0) throw new Error('Expected preflight:agent_create_skipped event for noCli failure');
    const warnings = result.preflightResult?.warnings || [];
    const createFailedWarnings = warnings.filter(w => w.type === 'agent_create_failed');
    if (createFailedWarnings.length === 0) throw new Error('Expected agent_create_failed warning in preflightResult');
  });

  section('App not installed fail-fast (batched QuestionCard)');

  await it('returns planError with a batched download-link question when target app is not installed', async () => {
    const preflightModulePath = path.resolve(__dirname, '..', 'src/nodes/preflightAgents.js');
    const probeDesktopPath = path.resolve(__dirname, '..', 'src/utils/probeDesktopApp.js');
    const probeTCCPath = path.resolve(__dirname, '..', 'src/utils/probeTCC.js');

    // Mock probeDesktopApp + probeTCC via require cache, then re-require preflight
    const origProbeDesktop = require.cache[probeDesktopPath];
    const origProbeTCC = require.cache[probeTCCPath];
    const origPreflight = require.cache[preflightModulePath];

    require.cache[probeDesktopPath] = {
      id: probeDesktopPath, filename: probeDesktopPath, loaded: true,
      exports: {
        probeDesktopApp: async () => ({
          installed: false, capability: 'none', applescriptSupported: false,
          loggedIn: null, evidence: 'mock: Cursor not installed', appName: null,
        }),
        _deriveAppNames: () => ['Cursor'],
      },
    };
    require.cache[probeTCCPath] = {
      id: probeTCCPath, filename: probeTCCPath, loaded: true,
      exports: { probeTCC: async () => ({ granted: true, needsPrompt: false, evidence: 'mock' }), clearTCCCache: () => {} },
    };
    delete require.cache[preflightModulePath];
    const preflightAgentsMocked = require(preflightModulePath);

    const prevGrillMode = process.env.THINKDROP_GRILL_MODE;
    process.env.THINKDROP_GRILL_MODE = '1';

    let capturedBatch = null;
    const state = makeState({
      agents: [],
      userMessage: 'In Cursor, open a new file and type a JavaScript function that adds two numbers, then save it.',
    });
    state._taskClassification = { taskType: 'app_automation', targetService: 'cursor' };
    state.gatherAnswerCallback = async (arg) => {
      capturedBatch = arg;
      return { 'app_not_installed:cursor': 'cancel' };
    };

    try {
      const result = await preflightAgentsMocked(state);
      if (!result.planError) throw new Error('Expected planError for missing Cursor app');
      if (!result.planError.includes('not installed')) throw new Error(`Expected "not installed" in planError, got: ${result.planError}`);
      if (!result.planError.includes('https://cursor.com/download')) throw new Error(`Expected download URL in planError, got: ${result.planError}`);
      if (!capturedBatch || capturedBatch.batch !== true) throw new Error('Expected gatherAnswerCallback to receive a batch object');
      const q = capturedBatch.questions && capturedBatch.questions[0];
      if (!q) throw new Error('Expected one question in the batch');
      if (!q.link || q.link.url !== 'https://cursor.com/download') throw new Error('Expected question.link.url to be the Cursor download page');
      if (!q.options || !q.options.find(o => o.value === 'open_download')) throw new Error('Expected an "open_download" option');
      if (!q.options || !q.options.find(o => o.value === 'cancel')) throw new Error('Expected a "cancel" option');
    } finally {
      process.env.THINKDROP_GRILL_MODE = prevGrillMode;
      delete require.cache[preflightModulePath];
      if (origPreflight) require.cache[preflightModulePath] = origPreflight;
      if (origProbeDesktop) require.cache[probeDesktopPath] = origProbeDesktop; else delete require.cache[probeDesktopPath];
      if (origProbeTCC) require.cache[probeTCCPath] = origProbeTCC; else delete require.cache[probeTCCPath];
    }
  });

  section('LLM login-need gate');

  // First-contact tests use a synthetic profile-less service ('firstcontacttest')
  // so they don't depend on real browser profiles on this machine.
  const FC = 'firstcontacttest';
  _cleanupBrowserProfile(FC);

  await it('first-contact LLM "no login" → authed + needsAuth=0 recorded', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: `${FC}.agent`, type: 'browser', service: FC, capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      authSequence: [
        { ok: true, agentId: `${FC}.agent`, authed: true, authVerified: true },
      ],
      userMessage: `Open ${FC} and search for 'wooden cross wall art' then click the first result`,
      llmBackend: {
        generateAnswer: async () => '0',
      },
    });
    state.resolveAgentResult = { agents: [{ agentId: `${FC}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === `${FC}.agent`);
    if (!agent) throw new Error(`${FC}.agent not in preflightResult.agents`);
    if (!agent.authed) throw new Error(`Expected ${FC}.agent to be authed when LLM says no login needed`);
    if (!agent.ready) throw new Error(`Expected ${FC}.agent to be ready when LLM says no login needed`);
    const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
    if (authCalls.length !== 0) throw new Error(`Expected zero browser.agent authenticate calls when LLM skips auth, got ${authCalls.length}`);
    const authRequiredEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === `${FC}.agent`);
    if (authRequiredEvents.length !== 0) throw new Error(`Expected zero preflight:auth_required events for ${FC}.agent, got ${authRequiredEvents.length}`);
    if ((_readLedger()[`${FC}.agent`] || {}).needsAuth !== 0) {
      throw new Error(`Expected needsAuth=0 recorded in ledger for ${FC}.agent`);
    }
  });

  await it('first-contact LLM "login required" → auth-required without probe + needsAuth=1 recorded', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: `${FC}.agent`, type: 'browser', service: FC, capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      userMessage: `Post a new listing on ${FC}`,
      llmBackend: {
        generateAnswer: async () => '1',
      },
    });
    state.resolveAgentResult = { agents: [{ agentId: `${FC}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError because auth is required');
    // Deterministic auth-required — the LLM answered once, no browser probe.
    const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
    if (authCalls.length !== 0) throw new Error(`Expected zero browser.agent authenticate calls, got ${authCalls.length}`);
    if ((_readLedger()[`${FC}.agent`] || {}).needsAuth !== 1) {
      throw new Error(`Expected needsAuth=1 recorded in ledger for ${FC}.agent`);
    }
  });

  await it('first-contact with an unexpected LLM answer defaults to auth-required', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: `${FC}.agent`, type: 'browser', service: FC, capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      userMessage: `Open ${FC} and buy a gift`,
      llmBackend: {
        generateAnswer: async () => 'maybe',
      },
    });
    state.resolveAgentResult = { agents: [{ agentId: `${FC}.agent`, create: false }] };
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError because auth is required');
    const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'command.automate' && c.payload?.skill === 'browser.agent' && c.payload?.args?.action === 'authenticate');
    if (authCalls.length !== 0) throw new Error(`Expected zero browser.agent authenticate calls, got ${authCalls.length}`);
  });

  await it('first-contact static-map service needs no LLM call (jira → needsAuth=1)', async () => {
    _resetLedger({});
    _cleanupBrowserProfile('jira'); // ensure no profile → true first contact
    let llmCalls = 0;
    const state = makeState({
      agents: [
        { id: 'jira.agent', type: 'browser', service: 'jira', capabilities: ['navigate', 'interact'], status: 'healthy' },
      ],
      userMessage: 'create a new jira ticket for the login bug',
      llmBackend: {
        generateAnswer: async () => { llmCalls++; return '0'; },
      },
    });
    state.resolveAgentResult = { agents: [{ agentId: 'jira.agent', create: false }] };
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError — jira requires auth per static map');
    if (llmCalls !== 0) throw new Error(`Expected zero LLM calls for static-map service, got ${llmCalls}`);
    if ((_readLedger()['jira.agent'] || {}).needsAuth !== 1) {
      throw new Error('Expected needsAuth=1 recorded in ledger for jira.agent');
    }
  });

  await it('honors preflightAuthBypass for a newly-created agent even when LLM says login required', async () => {
    const state = makeState({
      agents: [],
      userMessage: "Go to Walmart and search for 'school supplies bulk' then add the first result to my cart",
      authSequence: [
        { ok: false, error: 'authenticate should not be called for a bypassed agent' },
      ],
      llmBackend: {
        generateAnswer: async () => '1',
      },
    });
    state.resolveAgentResult = { agents: [{ agentId: 'walmart.agent', service: 'walmart', type: 'browser', create: true }] };
    state.preflightAuthBypass = ['walmart.agent'];
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === 'walmart.agent');
    if (!agent) throw new Error('walmart.agent not in preflightResult.agents');
    if (!agent.authed) throw new Error('Expected walmart.agent to be authed via user bypass');
    if (agent.authBypassed !== true) throw new Error('Expected authBypassed flag on walmart.agent');
    const authRequiredEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'walmart.agent');
    if (authRequiredEvents.length !== 0) throw new Error(`Expected zero preflight:auth_required events for walmart.agent, got ${authRequiredEvents.length}`);
  });

  section('Mid-run preflight decisions (live bypass / continue / unverifiable)');

  await it('clears an auth failure when "Proceed without" lands mid-run', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: 'bypassme.agent', type: 'browser', service: 'bypassme', capabilities: ['navigate'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, error: 'network unreachable' },
      ],
      userMessage: 'do something with bypassme',
    });
    state.preflightAuthBypass = [];
    // Simulate the UI "Proceed without" click landing while preflight runs —
    // main.js pushes into this same array (shared by reference into live state).
    // The push rides the guaranteed agent.list call (browser agents no longer
    // probe in the ledger model — there is no authenticate call to ride).
    const origCall = state.mcpAdapter.callService.bind(state.mcpAdapter);
    let pushed = false;
    state.mcpAdapter.callService = async (svc, action, payload, opts) => {
      const r = await origCall(svc, action, payload, opts);
      if (!pushed && action === 'agent.list') { pushed = true; state.preflightAuthBypass.push('bypassme.agent'); }
      return r;
    };
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === 'bypassme.agent');
    if (!agent) throw new Error('bypassme.agent not in preflightResult.agents');
    if (!agent.authed) throw new Error('Expected bypassme.agent authed after mid-run bypass');
    if (agent.authBypassed !== true) throw new Error('Expected authBypassed flag on bypassme.agent');
    const ready = state._progressEvents.filter(e => e.type === 'preflight:agent_ready' && e.agentId === 'bypassme.agent');
    if (ready.length < 1) throw new Error('Expected preflight:agent_ready for bypassed agent');
  });

  await it('parks persistent unverifiable browser probes as auth-required (not hard fail)', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: 'botwall.agent', type: 'browser', service: 'botwall', capabilities: ['navigate'], status: 'healthy' },
      ],
      authSequence: [
        { ok: false, unverifiable: true, error: 'page blank after hidden retry' },
      ],
      userMessage: 'do something with botwall',
    });
    const result = await preflightAgents(state);
    if (!result.planError) throw new Error('Expected planError for unverifiable auth');
    if (result.preflightAuthRequired !== true) throw new Error('Expected preflightAuthRequired=true for unverifiable probe');
    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.agentId === 'botwall.agent');
    if (authEvents.length < 1) throw new Error('Expected preflight:auth_required for unverifiable agent');
    const failedEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_failed' && e.agentId === 'botwall.agent');
    if (failedEvents.length !== 0) throw new Error(`Expected no auth_failed event for unverifiable agent, got ${failedEvents.length}`);
  });

  await it('re-verifies agents queued via mid-run auth_continue', async () => {
    _resetLedger({});
    const state = makeState({
      agents: [
        { id: 'retryagent.agent', type: 'browser', service: 'retryagent', capabilities: ['navigate'], status: 'healthy' },
      ],
      authSequence: [
        { ok: true, agentId: 'retryagent.agent', authed: true, authVerified: true },
      ],
      userMessage: 'do something with retryagent',
    });
    state._authContinueQueued = [];
    // Simulate "I've already signed in" landing mid-run — the queued re-verify
    // consumes the authSequence entry when the auth-continue block runs the
    // real _authenticateBrowserAgent probe (kept for continue/credential).
    const origCall = state.mcpAdapter.callService.bind(state.mcpAdapter);
    let pushed = false;
    state.mcpAdapter.callService = async (svc, action, payload, opts) => {
      const r = await origCall(svc, action, payload, opts);
      if (!pushed && action === 'agent.list') {
        pushed = true;
        state._authContinueQueued.push('retryagent.agent');
      }
      return r;
    };
    const result = await preflightAgents(state);
    if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
    const agent = (result.preflightResult?.agents || []).find(a => a.agentId === 'retryagent.agent');
    if (!agent?.authed) throw new Error('Expected retryagent.agent authed after queued re-verify');
    const ready = state._progressEvents.filter(e => e.type === 'preflight:agent_ready' && e.agentId === 'retryagent.agent');
    if (ready.length < 1) throw new Error('Expected preflight:agent_ready after re-verify');
  });

  console.log(`\n${'─'.repeat(72)}`);
  // ── Local-file demotion: service agents picked for a file task get dropped ──
  section('Local-file agent demotion');

  const demoteTmp = path.join(os.tmpdir(), `pf-demote-${Date.now()}.txt`);
  fs.writeFileSync(demoteTmp, 'hello world\n');

  await it('drops a service agent when a local file resolves and no service is named', async () => {
    const state = makeState({
      userMessage: 'I need you to update the file and make it longer',
      agents: [{ id: 'microsoft_word_online.agent', name: 'Word Online', service: 'microsoft_word_online' }, { id: 'gmail.agent', name: 'Gmail', service: 'gmail' }],
      llmBackend: { async generateAnswer() { return '0'; } }, // login-need check → no login
    });
    state._taskClassification = { taskType: 'ambiguous', activeDocRef: 'file', activeDocTarget: demoteTmp };
    state.resolveAgentResult = { agents: [{ agentId: 'microsoft_word_online.agent', role: 'update the file', exists: true }] };
    const result = await preflightAgents(state);
    const remaining = state.resolveAgentResult?.agents || [];
    if (remaining.length !== 0) throw new Error(`expected agents demoted, got ${JSON.stringify(remaining)}`);
    const authEvents = (state._progressEvents || []).filter(e => e.type === 'preflight:auth_required');
    if (authEvents.length) throw new Error('auth card surfaced for a local-file task');
    if (!result.preflightResult) throw new Error('no preflightResult');
  });

  await it('keeps agents when the message names a service', async () => {
    const state = makeState({
      userMessage: 'email me this file via gmail',
      agents: [{ id: 'microsoft_word_online.agent', name: 'Word Online', service: 'microsoft_word_online' }, { id: 'gmail.agent', name: 'Gmail', service: 'gmail' }],
      llmBackend: { async generateAnswer() { return '0'; } },
    });
    state._taskClassification = { taskType: 'ambiguous', activeDocRef: 'file', activeDocTarget: demoteTmp };
    state.resolveAgentResult = { agents: [{ agentId: 'microsoft_word_online.agent', role: 'update the file', exists: true }] };
    await preflightAgents(state);
    const remaining = state.resolveAgentResult?.agents || [];
    if (remaining.length === 0) throw new Error('service-named task had agents demoted');
  });

  await it('keeps agents when no file resolves', async () => {
    const state = makeState({
      userMessage: 'check my notifications',
      agents: [{ id: 'gmail.agent', name: 'Gmail', service: 'gmail' }],
      llmBackend: { async generateAnswer() { return '0'; } },
    });
    state._taskClassification = { taskType: 'browser' };
    state.resolveAgentResult = { agents: [{ agentId: 'gmail.agent', role: 'check', exists: true }] };
    await preflightAgents(state);
    const remaining = state.resolveAgentResult?.agents || [];
    if (remaining.length === 0) throw new Error('non-file task had agents demoted');
  });

  try { fs.unlinkSync(demoteTmp); } catch (_) {}

  section('Grill-Me skip + service-family canonicalization');

  await it('skips probes for a single authed browser agent and aliases routeDecision keys', async () => {
    _resetLedger({});
    process.env.THINKDROP_GRILL_MODE = '1';
    const svc = 'familysvc';
    _cleanupBrowserProfile(svc);
    try {
      const state = makeState({
        agents: [
          { id: `${svc}.agent`, type: 'browser', service: svc, capabilities: ['navigate'], status: 'healthy', authedAt: Date.now() - 3600000 },
        ],
        userMessage: `open ${svc} docs and create a file`,
      });
      // classifyTask emits a sub-service name (google_docs-style) while the
      // registered agent is the family root (google-style).
      state._taskClassification = { taskType: 'browser', targetService: `${svc}_docs` };
      state.resolveAgentResult = { agents: [{ agentId: `${svc}.agent`, create: false }] };
      const result = await preflightAgents(state);
      const rd = result.routeDecision || result.preflightResult?.routeDecision || {};
      const canonKey = `${svc}_docs`;
      if (!rd[canonKey]) throw new Error(`expected routeDecision['${canonKey}'], got keys: ${Object.keys(rd).join(',')}`);
      if (rd[canonKey].route !== 'browser') throw new Error(`expected route 'browser', got '${rd[canonKey].route}'`);
      if (!/predetermined/i.test(rd[canonKey].reason || '')) {
        throw new Error(`expected probes-skipped reason, got: ${rd[canonKey].reason}`);
      }
      // Alias under the agent's own service key so gatherPlanContext hits.
      if (!rd[svc]) throw new Error(`expected alias routeDecision['${svc}'] for gatherPlanContext, got keys: ${Object.keys(rd).join(',')}`);
    } finally {
      delete process.env.THINKDROP_GRILL_MODE;
    }
  });

  await it('runs real probes when no single authed browser agent owns the service', async () => {
    _resetLedger({});
    process.env.THINKDROP_GRILL_MODE = '1';
    const svc = 'probeplzsvc';
    _cleanupBrowserProfile(svc);
    try {
      const state = makeState({
        agents: [],
        userMessage: `use ${svc} for something`,
      });
      state._taskClassification = { taskType: 'browser', targetService: svc };
      state.resolveAgentResult = { agents: [] };
      const result = await preflightAgents(state);
      const rd = result.routeDecision || result.preflightResult?.routeDecision || {};
      // Probe ran — decision exists (route resolved by resolveRoute, likely
      // 'unknown' with no agents/desktop — just not the skip reason).
      if (!rd[svc]) throw new Error(`expected routeDecision['${svc}'], got keys: ${Object.keys(rd).join(',')}`);
      if (/predetermined/i.test(rd[svc].reason || '')) {
        throw new Error('probes were skipped even though no authed browser agent owns the service');
      }
    } finally {
      delete process.env.THINKDROP_GRILL_MODE;
    }
  });

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

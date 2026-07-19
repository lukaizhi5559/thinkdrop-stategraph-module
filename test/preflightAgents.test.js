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

function makeState({ authSequence, agents, gatherCredentialResult, gatherAnswerResult, userMessage } = {}) {
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
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [] } };
      }
      if (service === 'command' && action === 'browser.agent' && payload?.action === 'authenticate') {
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

async function runTests() {
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

  await it('handles a hard browser.agent authenticate failure', async () => {
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
    if (!result.planError) throw new Error('Expected planError due to hard auth failure');
    if (!result.planError.includes('network unreachable')) {
      throw new Error(`Expected failure reason in planError, got: ${result.planError}`);
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

  section('Browser profile always-verify behavior');

  await it('triggers authenticate for a browser profile with a cookie older than 7 days', async () => {
    const serviceKey = 'preflightstaletest';
    _cleanupBrowserProfile(serviceKey);
    _setupBrowserProfile(serviceKey, 8);
    try {
      const state = makeState({
        agents: [
          { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
        ],
        authSequence: [
          { ok: true, agentId: `${serviceKey}.agent`, authed: true },
        ],
        userMessage: `do something with ${serviceKey}`,
      });
      const result = await preflightAgents(state);
      if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
      const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'browser.agent' && c.payload?.action === 'authenticate');
      if (authCalls.length !== 1) throw new Error(`Expected one authenticate call for stale profile, got ${authCalls.length}`);
      const staleWarnings = state._progressEvents.filter(e => e.type === 'preflight:auth_required');
      if (staleWarnings.length < 1) throw new Error('Expected preflight:auth_required for stale browser session');
    } finally {
      _cleanupBrowserProfile(serviceKey);
    }
  });

  await it('always verifies a fresh-profile browser agent instead of trusting cookie age', async () => {
    const serviceKey = 'preflightfreshtest';
    _cleanupBrowserProfile(serviceKey);
    _setupBrowserProfile(serviceKey, 3);
    try {
      const state = makeState({
        agents: [
          { id: `${serviceKey}.agent`, type: 'browser', service: serviceKey, capabilities: ['navigate', 'interact'], status: 'healthy' },
        ],
        authSequence: [
          { ok: true, agentId: `${serviceKey}.agent`, authed: true },
        ],
        userMessage: `do something with ${serviceKey}`,
      });
      const result = await preflightAgents(state);
      if (result.planError) throw new Error(`Unexpected planError: ${result.planError}`);
      const agent = (result.preflightResult?.agents || []).find(a => a.agentId === `${serviceKey}.agent`);
      if (!agent) throw new Error(`${serviceKey}.agent not in preflightResult.agents`);
      if (!agent.authed) throw new Error('Expected browser agent to be authed after live verify');
      const authCalls = state.mcpAdapter.calls.filter(c => c.service === 'command' && c.action === 'browser.agent' && c.payload?.action === 'authenticate');
      if (authCalls.length !== 1) throw new Error(`Expected one authenticate call for fresh profile, got ${authCalls.length}`);
    } finally {
      _cleanupBrowserProfile(serviceKey);
    }
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

  await it('enriches incomplete setupInfo via web.agent discover_setup before emitting auth_required', async () => {
    const state = makeState({
      agents: [],
      userMessage: 'list my calendar events with gcalcli',
    });
    let discoverSetupCalled = false;
    state.mcpAdapter.callService = async function(service, action, payload, opts) {
      if (service === 'command' && action === 'agent.list') return { data: [] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'cli.agent' && payload?.args?.action === 'preflight_check') {
        return { data: { ok: true, brew: { installed: true }, curl: { installed: true }, detectedClis: [
          { service: 'gcalcli', cli: 'gcalcli', installed: false, authStatus: 'unknown', agentId: 'gcalcli.agent', setupInfo: { installCmd: 'pip install gcalcli' } },
        ] } };
      }
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'web.agent' && payload?.args?.action === 'discover_setup') {
        discoverSetupCalled = true;
        return { data: { ok: true, setupInfo: { authCmd: 'gcalcli auth', setupUrl: 'https://github.com/insanum/gcalcli#authorization', credentials: ['oauth'] }, sources: [{ url: 'https://github.com/insanum/gcalcli', title: 'gcalcli README' }] } };
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory' && action === 'skill.list') return { data: [] };
      return null;
    };
    state.mcpAdapter.calls = [];

    const result = await preflightAgents(state);
    if (!discoverSetupCalled) throw new Error('Expected web.agent discover_setup to be called for incomplete setupInfo');

    const authEvents = state._progressEvents.filter(e => e.type === 'preflight:auth_required' && e.serviceName === 'gcalcli');
    if (authEvents.length === 0) throw new Error('Expected preflight:auth_required event for gcalcli');
    if (authEvents[0].authType !== 'cli_setup') throw new Error(`Expected authType 'cli_setup', got '${authEvents[0].authType}'`);
    if (!authEvents[0].reason) throw new Error('Expected reason field in auth_required event');

    const si = authEvents[0].setupInfo;
    if (!si) throw new Error('Expected setupInfo in auth_required event');
    // Descriptor value should be preserved
    if (si.installCmd !== 'pip install gcalcli') throw new Error(`Expected descriptor installCmd 'pip install gcalcli' to be preserved, got '${si.installCmd}'`);
    // Discovered values should fill missing fields
    if (si.authCmd !== 'gcalcli auth') throw new Error(`Expected discovered authCmd 'gcalcli auth', got '${si.authCmd}'`);
    if (!si.setupUrl) throw new Error('Expected discovered setupUrl to be filled');
    if (!Array.isArray(si.credentials) || si.credentials.length === 0) throw new Error('Expected discovered credentials to be filled');
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

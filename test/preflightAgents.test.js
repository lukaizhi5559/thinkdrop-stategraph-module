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

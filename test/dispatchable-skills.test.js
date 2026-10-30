'use strict';
/**
 * dispatchable-skills.test.js — *.agent SKILL vs registry AGENT distinction
 *
 * Regression (2026-10-30): preflight treated every *.agent id as a needed
 * registry agent. A plan task pinning `edit.agent` (a real command-service
 * dispatch skill — `case 'edit.agent'` in command-service's router) hit
 * `agent_not_onboarded` → needs_plan → a 40-minute stuck run. skillIds.js
 * now unions POST /skill.list with the CONTRACTS vocabulary so known
 * dispatchable skills pass preflight and pins bind as type:'skill'.
 *
 * Run: node stategraph-module/test/dispatchable-skills.test.js
 */

const os = require('os');
const path = require('path');

// Isolate the auth ledger before preflightAgents loads.
process.env.THINKDROP_PREFLIGHT_AUTH_CACHE = path.join(os.tmpdir(), `pf-auth-disp-${process.pid}.json`);

const preflightAgents = require(path.resolve(__dirname, '..', 'src/nodes/preflightAgents.js'));
const resolveAgent = require(path.resolve(__dirname, '..', 'src/nodes/resolveAgent.js'));
const { dispatchableSkills, isContractSkill, _resetCache } = require(path.resolve(__dirname, '..', 'src/utils/skillIds.js'));

let _passed = 0, _failed = 0;
async function it(label, fn) {
  try { await fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function section(label) { console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`); }
function expect(cond, msg) { if (!cond) throw new Error(msg); }

function makeMcpAdapter({ agents = [], skills = null } = {}) {
  return {
    async callService(service, action) {
      if (service === 'command' && action === 'agent.list') return { data: agents };
      if (service === 'command' && action === 'skill.list') return skills ? { data: { skills } } : null;
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory') return { data: [] };
      return null;
    },
  };
}

function makeState(over = {}) {
  return {
    intent: { type: 'command_automate' },
    message: 'update the file',
    resolvedMessage: 'update the file',
    mcpAdapter: makeMcpAdapter(over._mcp || {}),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    progressCallback: () => {},
    gatherCredentialCallback: async () => ({ stored: true }),
    gatherAnswerCallback: async () => 'yes',
    confirmInstallCallback: async () => false,
    gatherOAuthCallback: async () => ({ connected: false }),
    resolveAgentResult: { agents: [] },
    llmBackend: { chat: async () => ({}) }, // pin path returns before LLM use
    ...over,
  };
}

async function runTests() {
  section('skillIds util — contract fallback + skill.list union');

  await it('edit.agent is a contract skill (offline fallback)', async () => {
    _resetCache();
    const ids = await dispatchableSkills(null); // no adapter → contract vocab only
    expect(ids.has('edit.agent'), 'edit.agent missing from contract fallback');
    expect(ids.has('video.agent'), 'video.agent missing from contract fallback');
  });

  await it('skill.list union adds non-contract dispatch ids', async () => {
    _resetCache();
    const adapter = makeMcpAdapter({ skills: ['exotic.skill', 'edit.agent'] });
    const ids = await dispatchableSkills(adapter);
    expect(ids.has('exotic.skill'), 'skill.list id not unioned');
    expect(ids.has('edit.agent'), 'contract id lost in union');
  });

  await it('skill.list failure still falls back to contracts', async () => {
    _resetCache();
    const ids = await dispatchableSkills({ callService: async () => { throw new Error('down'); } });
    expect(ids.has('edit.agent'), 'contract fallback lost on adapter error');
    expect(isContractSkill('edit.agent'), 'isContractSkill false for edit.agent');
    expect(!isContractSkill('madeup.agent'), 'isContractSkill true for fake id');
  });

  section('preflightAgents — plan-step *.agent skills pass readiness');

  await it('agent entry for edit.agent does NOT escalate', async () => {
    // Real RTF-failure shape: resolveAgent bound edit.agent, no deterministic
    // plan steps (deterministicPlan+!external would skip preflight entirely).
    const state = makeState({
      resolveAgentResult: { agents: [{ agentId: 'edit.agent', exists: true, type: 'skill' }] },
    });
    const out = await preflightAgents(state);
    expect(!out._needsPlan, `edit.agent escalated: ${JSON.stringify(out._needsPlan)}`);
    const ready = (out.preflightResult?.agents || []).find(a => a.agentId === 'edit.agent');
    expect(ready && ready.type === 'skill' && ready.ready === true, `readiness entry wrong: ${JSON.stringify(ready)}`);
  });

  await it('_pinnedAgentId=edit.agent (plan-task path) does NOT escalate', async () => {
    const state = makeState({ _pinnedAgentId: 'edit.agent' });
    const out = await preflightAgents(state);
    expect(!out._needsPlan, `pinned edit.agent escalated: ${JSON.stringify(out._needsPlan)}`);
  });

  await it('genuinely missing registry agent still escalates', async () => {
    const state = makeState({
      resolveAgentResult: { agents: [{ agentId: 'nonexistent.agent' }] },
    });
    const out = await preflightAgents(state);
    expect(out._needsPlan?.reason === 'agent_not_onboarded', `expected agent_not_onboarded, got ${JSON.stringify(out._needsPlan)}`);
    expect(out._needsPlan.missingAgents.includes('nonexistent.agent'), 'missingAgents lacks the fake agent');
  });

  await it('mixed pin set: skill passes, fake agent escalates', async () => {
    const state = makeState({
      resolveAgentResult: { agents: [{ agentId: 'edit.agent', type: 'skill' }, { agentId: 'notreal.agent' }] },
    });
    const out = await preflightAgents(state);
    expect(out._needsPlan?.reason === 'agent_not_onboarded', `expected escalation, got ${JSON.stringify(out._needsPlan)}`);
    expect(out._needsPlan.missingAgents.includes('notreal.agent'), 'missingAgents wrong');
    expect(!out._needsPlan.missingAgents.includes('edit.agent'), 'edit.agent wrongly listed missing');
  });

  section('resolveAgent — pinned *.agent skill binds as skill');

  await it('pinned edit.agent binds directly as dispatchable skill', async () => {
    const state = makeState({ _pinnedAgentId: 'edit.agent' });
    const out = await resolveAgent(state);
    const agent = out.resolveAgentResult?.agents?.[0];
    expect(agent?.agentId === 'edit.agent', `pin not bound: ${JSON.stringify(out.resolveAgentResult)}`);
    expect(agent?.type === 'skill', `expected type skill, got ${agent?.type}`);
    expect(agent?.exists === true, 'skill pin should not need registry existence');
  });

  await it('pinned fake agent still drops the pin', async () => {
    const state = makeState({ _pinnedAgentId: 'madeup.agent' });
    const out = await resolveAgent(state);
    const agents = out.resolveAgentResult?.agents || [];
    expect(!agents.some(a => a.agentId === 'madeup.agent'), 'fake pin should not bind');
    expect(out._pinnedAgentRejected?.id === 'madeup.agent' || out._pinnedAgentId == null, 'rejected pin not recorded');
  });

  console.log(`\n${_passed} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
}

runTests().catch(e => { console.error(e); process.exit(1); });

'use strict';
/**
 * git-refs.test.js
 *
 * Regression tests for the _gitRefs seam in preflightAgents.js — deterministic
 * hash→repo verification before planning. Covers the observed incident:
 * "amend commits 2eb157d/5b4c854" ran `git commit --amend` in the wrong repo
 * and rewrote the parent's HEAD (0628aa4). The seam must bind each hash to a
 * verified repo path (or ask — never guess) and carry the binding into
 * resolvedMessage so the planner emits `git -C` task text.
 *
 * Run: node stategraph-module/test/git-refs.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const preflightAgents = require(path.resolve(__dirname, '..', 'src/nodes/preflightAgents.js'));

let _passed = 0, _failed = 0;
async function it(label, fn) {
  try { await fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const _tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrefs-'));

function makeRepo(name, msg) {
  const dir = path.join(_tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'f.txt'), name);
  git('add', '-A');
  git('commit', '-m', msg);
  // The seam filters all-digit tokens (likely numbers, not hashes) — keep
  // amending until the short hash contains a hex letter.
  let hash = git('rev-parse', '--short', 'HEAD');
  for (let i = 0; !/[a-f]/.test(hash) && i < 40; i++) {
    git('commit', '--amend', '-q', '-m', `${msg} ${i}`);
    hash = git('rev-parse', '--short', 'HEAD');
  }
  return { dir, hash };
}

// mcpAdapter whose shell.run executes real git — the seam probes through
// command.automate, so the mock honors the same contract.
function makeState({ message, gatherAnswer }) {
  const progressEvents = [];
  const asked = [];
  const mcpAdapter = {
    async callService(service, action, payload) {
      if (service === 'command' && action === 'agent.list') return { data: [] };
      if (service === 'command' && action === 'command.automate' && payload?.skill === 'shell.run') {
        try {
          const stdout = execFileSync(payload.args.cmd, payload.args.argv || [], { encoding: 'utf8' });
          return { data: { exitCode: 0, stdout } };
        } catch (e) {
          return { data: { exitCode: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' } };
        }
      }
      if (service === 'command' && action === 'ping') return { ok: true };
      if (service === 'user-memory') return { data: [] };
      return { data: [] };
    },
  };
  return {
    state: {
      intent: { type: 'command_automate' },
      message,
      resolvedMessage: message,
      mcpAdapter,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      progressCallback: (ev) => progressEvents.push(ev),
      gatherAnswerCallback: async (q) => { asked.push(q); return gatherAnswer; },
      llmBackend: { generateAnswer: async () => '0' },
      resolveAgentResult: { agents: [] },
    },
    progressEvents,
    asked,
  };
}

(async () => {
  console.log('\n' + '─'.repeat(72) + '\n  _gitRefs — verified hash→repo bindings\n' + '─'.repeat(72));

  const repoA = makeRepo('repo-a', 'first message');
  const repoB = makeRepo('repo-b', 'second message');

  await it('binds a named hash to the repo named in the ask', async () => {
    const { state, asked } = makeState({
      message: `amend commit ${repoA.hash} in ${repoA.dir} to say "fixed message"`,
      gatherAnswer: '',
    });
    const out = await preflightAgents(state);
    assert(out._gitRefs && out._gitRefs[repoA.hash], `expected _gitRefs[${repoA.hash}], got ${JSON.stringify(out._gitRefs)}`);
    assert(out._gitRefs[repoA.hash].repoPath === repoA.dir, `expected repoPath ${repoA.dir}, got ${out._gitRefs[repoA.hash].repoPath}`);
    assert(String(out._gitRefs[repoA.hash].subject).startsWith('first message'), `expected subject, got "${out._gitRefs[repoA.hash].subject}"`);
    assert(String(out.resolvedMessage || '').includes('Verified git bindings'), 'resolvedMessage should carry the binding note');
    assert(String(out.resolvedMessage).includes(repoA.dir), 'binding note should name the repo path');
    assert(asked.length === 0, `no disambiguation question expected for a resolvable hash (asked: ${asked})`);
  });

  await it('asks (never guesses) when the hash is in no candidate repo — then binds the answered repo', async () => {
    const { state, asked, progressEvents } = makeState({
      // tmpdir repos aren't under cwd/Desktop-projects → unresolvable until answered
      message: `amend commit ${repoB.hash} to say "fixed message"`,
      gatherAnswer: repoB.dir,
    });
    const out = await preflightAgents(state);
    const askEv = progressEvents.find(e => e.type === 'ask_user' && e.viaGather);
    assert(askEv, 'expected a viaGather ask_user for the unverified hash');
    assert(asked.length === 1, `expected exactly one disambiguation question, got ${asked.length}`);
    assert(out._gitRefs && out._gitRefs[repoB.hash] && out._gitRefs[repoB.hash].repoPath === repoB.dir,
      `expected answered repo bound, got ${JSON.stringify(out._gitRefs)}`);
  });

  await it('marks hashes UNVERIFIED in the binding note when unresolvable and unanswered', async () => {
    const { state } = makeState({
      message: `amend commit deadbee to say "x"`,
      gatherAnswer: '',
    });
    const out = await preflightAgents(state);
    assert(String(out.resolvedMessage || '').includes('deadbee → UNVERIFIED'),
      `expected UNVERIFIED marker, got: ${String(out.resolvedMessage).slice(-300)}`);
    assert(!(out._gitRefs && out._gitRefs.deadbee), 'unverified hash must not be bound');
  });

  await it('does not probe on a non-git ask', async () => {
    const { state } = makeState({ message: 'what time is it in Tokyo', gatherAnswer: '' });
    const out = await preflightAgents(state);
    assert(!out._gitRefs, `expected no _gitRefs, got ${JSON.stringify(out._gitRefs)}`);
  });

  console.log(`\n${_passed} passed, ${_failed} failed.`);
  if (_failed) process.exitCode = 1;
  fs.rmSync(_tmp, { recursive: true, force: true });
})();

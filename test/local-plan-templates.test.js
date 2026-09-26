'use strict';
/**
 * local-plan-templates.test.js — coverage for the force-classified fast path:
 *
 *   1. Every template compiles a valid skillPlan when the model returns a
 *      well-formed {n, args} response.
 *   2. Fallthrough: n=0 / unknown n / malformed JSON / classify call throwing
 *      all return null (caller falls back to the LLM planner).
 *   3. Denylist & verbatim checks: invented paths, denylisted commands, and
 *      malformed args are rejected — never silently compiled.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { forceClassifyLocalPlan, TEMPLATES, DANGEROUS_CMD_RE } = require('../src/utils/localPlanTemplates.js');
const _noop = { info() {}, warn() {}, debug() {}, error() {} };

// Mock backend: returns the scripted JSON (or throws when script is a Error).
const _backend = (script) => ({
  generateAnswer: async () => {
    if (script instanceof Error) throw script;
    return typeof script === 'function' ? script() : script;
  },
});

const _hit = (message, script, tc = {}) => forceClassifyLocalPlan(message, tc, _backend(script), _noop);
const _json = (n, args) => JSON.stringify({ n, args });

// ── Happy paths ────────────────────────────────────────────────────────────

describe('template compilation', () => {
  it('file_create compiles to a single shell.run write', async () => {
    const msg = 'create a file at /tmp/e2e/hello.txt containing the text hello world';
    const hit = await _hit(msg, _json(1, { path: '/tmp/e2e/hello.txt', content: 'hello world' }));
    assert.equal(hit.template, 'file_create');
    assert.equal(hit.skillPlan.length, 1);
    assert.equal(hit.skillPlan[0].skill, 'shell.run');
    assert.match(hit.skillPlan[0].args.argv[1], /\/tmp\/e2e\/hello\.txt/);
    assert.match(hit.skillPlan[0].args.argv[1], /base64 -d/);
    assert.equal(hit.lowRisk, false);
  });

  it('file_append compiles to an append (>> not >)', async () => {
    const msg = "append the line 'second entry' to /tmp/e2e/log.txt";
    const hit = await _hit(msg, _json(2, { path: '/tmp/e2e/log.txt', content: 'second entry' }));
    assert.equal(hit.template, 'file_append');
    assert.match(hit.skillPlan[0].args.argv[1], />>\s*'\/tmp\/e2e\/log\.txt'/);
  });

  it('file_read compiles to fs.read', async () => {
    const msg = 'read the file /tmp/e2e/hello.txt and tell me what it says';
    const hit = await _hit(msg, _json(3, { path: '/tmp/e2e/hello.txt' }));
    assert.equal(hit.template, 'file_read');
    assert.equal(hit.skillPlan[0].skill, 'fs.read');
    assert.equal(hit.skillPlan[0].args.path, '/tmp/e2e/hello.txt');
    assert.equal(hit.lowRisk, true);
  });

  it('file_list compiles to ls -la', async () => {
    const hit = await _hit('list the files in /tmp/e2e', _json(4, { path: '/tmp/e2e' }));
    assert.equal(hit.template, 'file_list');
    assert.equal(hit.skillPlan[0].args.cmd, 'ls');
    assert.deepEqual(hit.skillPlan[0].args.argv, ['-la', '/tmp/e2e']);
  });

  it('file_move compiles rename and move to mv; copy to cp -R', async () => {
    const mv = await _hit('rename /tmp/e2e/a.txt to /tmp/e2e/b.txt', _json(5, { src: '/tmp/e2e/a.txt', dst: '/tmp/e2e/b.txt', op: 'rename' }));
    assert.match(mv.skillPlan[0].args.argv[1], /mv '\/tmp\/e2e\/a\.txt' '\/tmp\/e2e\/b\.txt'/);
    const cp = await _hit('copy /tmp/e2e/a.txt to /tmp/e2e/b.txt', _json(5, { src: '/tmp/e2e/a.txt', dst: '/tmp/e2e/b.txt', op: 'copy' }));
    assert.match(cp.skillPlan[0].args.argv[1], /cp -R/);
  });

  it('sys_query compiles every known kind', async () => {
    for (const kind of ['battery', 'disk', 'uptime', 'memory', 'cpu', 'processes', 'apps', 'network', 'hostname']) {
      const hit = await _hit(`check my ${kind}`, _json(6, { kind }));
      assert.equal(hit.template, 'sys_query', kind);
      assert.equal(hit.skillPlan[0].args.cmd, 'bash');
      assert.ok(hit.skillPlan[0].args.argv[1].length > 3);
    }
  });

  it('sys_control compiles volume and mute', async () => {
    const v = await _hit('set volume to 40', _json(7, { setting: 'volume', level: 40 }));
    assert.match(v.skillPlan[0].args.argv[1], /output volume 40/);
    const m = await _hit('mute my mac', _json(7, { setting: 'mute', level: 0 }));
    assert.match(m.skillPlan[0].args.argv[1], /with output muted/);
  });

  it('screenshot compiles to screen.capture', async () => {
    const hit = await _hit('take a screenshot of my screen', _json(8, {}));
    assert.equal(hit.template, 'screenshot');
    assert.equal(hit.skillPlan[0].skill, 'screen.capture');
  });

  it('app_control compiles open and quit', async () => {
    const o = await _hit('open the Notes app', _json(9, { app: 'Notes', op: 'open' }));
    assert.match(o.skillPlan[0].args.argv[1], /open -a 'Notes'/);
    const q = await _hit('quit Notes', _json(9, { app: 'Notes', op: 'quit' }));
    assert.match(q.skillPlan[0].args.argv[1], /tell application "Notes" to quit/);
  });

  it('url_open compiles to open <url>', async () => {
    const hit = await _hit('open youtube.com in my browser — https://youtube.com', _json(10, { url: 'https://youtube.com' }));
    assert.equal(hit.template, 'url_open');
    assert.deepEqual(hit.skillPlan[0].args.argv, ['https://youtube.com']);
  });

  it('shell_cmd compiles the verbatim quoted command', async () => {
    const msg = "run 'echo stage five works' in the terminal";
    const hit = await _hit(msg, _json(11, { cmd: 'echo stage five works' }));
    assert.equal(hit.template, 'shell_cmd');
    assert.equal(hit.skillPlan[0].args.argv[1], 'echo stage five works');
  });
});

// ── Fallthrough ────────────────────────────────────────────────────────────

describe('fallthrough to LLM planner', () => {
  it('n=0 returns null', async () => {
    assert.equal(await _hit('post hello to twitter', _json(0, {})), null);
  });

  it('unknown template number returns null', async () => {
    assert.equal(await _hit('read /tmp/x', _json(99, {})), null);
  });

  it('unparseable response returns null', async () => {
    assert.equal(await _hit('read /tmp/x', 'I am not sure'), null);
  });

  it('classify call throwing returns null', async () => {
    assert.equal(await _hit('read /tmp/x', new Error('provider down')), null);
  });

  it('missing backend returns null', async () => {
    assert.equal(await forceClassifyLocalPlan('read /tmp/x', {}, null, _noop), null);
  });

  it('multi-goal prompt classified n=0 falls through', async () => {
    assert.equal(await _hit('read /tmp/a.txt then post it to slack', _json(0, {})), null);
  });
});

// ── Validators / denylist ──────────────────────────────────────────────────

describe('validators reject unsafe or hallucinated output', () => {
  it('invented path (not in message, not resolved target) is rejected', async () => {
    const hit = await _hit('read the file', _json(3, { path: '/tmp/e2e/secret.txt' }));
    assert.equal(hit, null);
  });

  it('resolved followUpTarget satisfies path verbatim', async () => {
    const hit = await _hit('read that file', _json(3, { path: '/tmp/e2e/notes.txt' }), { followUpTarget: '/tmp/e2e/notes.txt' });
    assert.equal(hit.template, 'file_read');
  });

  it('missing required arg is rejected', async () => {
    assert.equal(await _hit('read /tmp/e2e/a.txt', _json(3, {})), null);
  });

  it('relative/non-absolute path arg is rejected', async () => {
    assert.equal(await _hit('read notes.txt', _json(3, { path: 'notes.txt' })), null);
  });

  it('denylisted shell command is rejected', async () => {
    const msg = "run 'sudo rm -rf /' in the terminal";
    assert.ok(DANGEROUS_CMD_RE.test('sudo rm -rf /'));
    assert.equal(await _hit(msg, _json(11, { cmd: 'sudo rm -rf /' })), null);
  });

  it('command not quoted in the message is rejected', async () => {
    const hit = await _hit('run something in the terminal', _json(11, { cmd: 'rm -rf ~' }));
    assert.equal(hit, null);
  });

  it('sys_control level outside 0–100 is rejected', async () => {
    assert.equal(await _hit('set volume to 400', _json(7, { setting: 'volume', level: 400 })), null);
  });

  it('url_open requires a message-verbatim http(s) url', async () => {
    assert.equal(await _hit('open a website', _json(10, { url: 'https://evil.example' })), null);
    assert.equal(await _hit('open https://a.com', _json(10, { url: 'ftp://a.com' })), null);
  });

  it('app_control rejects shell-injection app names', async () => {
    assert.equal(await _hit('open Notes', _json(9, { app: 'Notes"; rm -rf ~; "', op: 'open' })), null);
  });
});

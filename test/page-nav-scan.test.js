'use strict';
/**
 * page-nav-scan.test.js — the deterministic site-search nav lane:
 *
 *   "goto youtube and look for X" is the user's literal nav spec:
 *     1. shell.run `open <site-search-url>` — never url.first.agent,
 *        nav_task, or the extension lane;
 *     2. app.agent scan_page with preferOs — the just-opened tab is unbound,
 *        so session inference must not read a stale bound tab.
 *   A bound-search referent (follow-up "search for X" on a bound tab) still
 *   drives THAT session via navigate_url.
 *   reply_draft: "polish a response to this message" is scan→draft — never
 *   browser automation.
 *
 * Run from repo root with:
 *   node --test stategraph-module/test/page-nav-scan.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { forceClassifyLocalPlan } = require('../src/utils/localPlanTemplates.js');
const _noop = { info() {}, warn() {}, debug() {}, error() {} };
const _backend = (script) => ({ generateAnswer: async () => script });
const _hit = (message, script, tc = {}) => forceClassifyLocalPlan(message, tc, _backend(script), _noop);
const _json = (n, args) => JSON.stringify({ n, args });

describe('page_nav_scan — deterministic site-search nav', () => {
  it('named site compiles to shell.run open + preferOs scan_page + synthesize', async () => {
    const hit = await _hit('goto youtube and look for mike winger', _json(19, { site: 'youtube', query: 'mike winger' }));
    assert.equal(hit.template, 'page_nav_scan');
    assert.equal(hit.skillPlan.length, 3);
    const [nav, scan, synth] = hit.skillPlan;
    assert.equal(nav.skill, 'shell.run');
    assert.equal(nav.args.cmd, 'open');
    assert.equal(nav.args.argv[0], 'https://www.youtube.com/results?search_query=mike%20winger');
    assert.equal(scan.skill, 'app.agent');
    assert.equal(scan.args.action, 'scan_page');
    // The just-opened tab is unbound — session inference must not rebind to a
    // stale ext session and read the wrong tab.
    assert.equal(scan.args.preferOs, true);
    assert.equal(scan.args.sessionId, undefined);
    assert.equal(synth.skill, 'synthesize');
  });

  it('derives the search query when the model only supplies the site', async () => {
    const hit = await _hit('goto amazon and search for mechanical pencils', _json(19, { site: 'amazon' }));
    assert.equal(hit.template, 'page_nav_scan');
    assert.equal(hit.skillPlan[0].skill, 'shell.run');
    assert.equal(hit.skillPlan[0].args.argv[0], 'https://www.amazon.com/s?k=mechanical%20pencils');
  });

  it('never emits url.first.agent / nav_task / dom.act steps', async () => {
    const hit = await _hit('goto youtube and look for mike winger', _json(19, { site: 'youtube', query: 'mike winger' }));
    assert.equal(hit.template, 'page_nav_scan');
    for (const s of hit.skillPlan) {
      assert.notEqual(s.skill, 'url.first.agent');
      assert.notEqual(s.skill, 'dom.act');
      assert.notEqual(s.args?.action, 'nav_task');
    }
  });

  it('literal verbatim URL → shell.run open that URL', async () => {
    const msg = 'open https://example.com/pricing and tell me the cheapest plan';
    const hit = await _hit(msg, _json(19, { url: 'https://example.com/pricing' }));
    assert.equal(hit.template, 'page_nav_scan');
    assert.equal(hit.skillPlan[0].skill, 'shell.run');
    assert.deepEqual(hit.skillPlan[0].args.argv, ['https://example.com/pricing']);
  });

  it('resolved referent URL (not verbatim in the message) is accepted', async () => {
    // "go to the channel" — the concrete URL lives in tc.followUpTarget.
    const hit = await _hit('go to the channel', _json(19, { url: 'https://youtube.com/@mikewinger' }),
      { followUpTarget: 'https://youtube.com/@mikewinger' });
    assert.equal(hit.template, 'page_nav_scan');
    assert.deepEqual(hit.skillPlan[0].args.argv, ['https://youtube.com/@mikewinger']);
  });

  it('invented URL (not verbatim, not resolved) is rejected → LLM fallback', async () => {
    const hit = await _hit('open a website', _json(19, { url: 'https://evil.example' }));
    assert.equal(hit, null);
  });

  it('bound-search session drives navigate_url on the bound tab', async () => {
    const hit = await _hit('search for baby mittens', _json(19, { site: 'etsy', query: 'baby mittens' }),
      { _boundSearchHost: 'etsy', _boundSearchSessionId: 'ext:etsy_agent' });
    assert.equal(hit.template, 'page_nav_scan');
    const [nav, scan] = hit.skillPlan;
    assert.equal(nav.skill, 'app.agent');
    assert.equal(nav.args.action, 'navigate_url');
    assert.equal(nav.args.sessionId, 'ext:etsy_agent');
    assert.equal(nav.args.url, 'https://www.etsy.com/search?q=baby%20mittens');
    assert.equal(scan.args.sessionId, 'ext:etsy_agent');
  });

  it('named non-whitelist service (chatgpt) defers to the agent path', async () => {
    const hit = await _hit('go to chat gpt and look up vegan food', _json(19, { site: 'google', query: 'vegan food' }),
      { targetService: 'chatgpt' });
    assert.equal(hit, null);
  });

  it('named whitelist service wins over a mismatched picked site', async () => {
    const hit = await _hit('goto youtube and look for mike winger', _json(19, { site: 'google', query: 'mike winger' }),
      { targetService: 'youtube' });
    assert.equal(hit.template, 'page_nav_scan');
    assert.match(hit.skillPlan[0].args.argv[0], /youtube\.com\/results\?search_query=mike%20winger/);
  });

  it('context-free public research with an invented google site → web_search lane, not nav', async () => {
    // Observed: Gmail highlight + "tell me about the company smoothstack… do a
    // search online" → envelope public_read → the classifier picked site:
    // 'google' by default and the browser was driven to a SERP. The web_search
    // lane owns this shape.
    const hit = await _hit('tell me about the company smoothstack any issues or problems do a search online',
      _json(19, { site: 'google', query: 'smoothstack company' }),
      { taskType: 'browser', webAccessMode: 'public_read' });
    assert.equal(hit, null);
  });

  it('explicit google nav lead keeps page_nav_scan even on public_read', async () => {
    const hit = await _hit('goto google and search for smoothstack reviews',
      _json(19, { site: 'google', query: 'smoothstack reviews' }),
      { taskType: 'browser', webAccessMode: 'public_read' });
    assert.equal(hit.template, 'page_nav_scan');
    assert.match(hit.skillPlan[0].args.argv[0], /google\.com\/search\?q=smoothstack%20reviews/);
  });
});

describe('reply_draft — scan the page, draft the reply, never automate', () => {
  it('"polish this response to the message" → preferOs scan_page + draft synthesize', async () => {
    const hit = await _hit('polish this response to the message', _json(27, {}));
    assert.equal(hit.template, 'reply_draft');
    assert.equal(hit.skillPlan.length, 2);
    const [read, draft] = hit.skillPlan;
    assert.equal(read.skill, 'app.agent');
    assert.equal(read.args.action, 'scan_page');
    assert.equal(read.args.preferOs, true);
    assert.equal(draft.skill, 'synthesize');
    assert.match(draft.args.prompt, /reply|response/i);
    // The plan must not contain any browser-driving step.
    for (const s of hit.skillPlan) {
      assert.notEqual(s.skill, 'url.first.agent');
      assert.notEqual(s.skill, 'dom.act');
      assert.notEqual(s.skill, 'browser.agent');
      assert.notEqual(s.args?.action, 'nav_task');
    }
  });

  it('"help me respond to this email" → reply_draft', async () => {
    const hit = await _hit('help me respond to this email', _json(27, {}));
    assert.equal(hit.template, 'reply_draft');
    assert.equal(hit.skillPlan[0].args.action, 'scan_page');
  });

  it('send cue defers to the planner (a real mutation)', async () => {
    const hit = await _hit('draft and send a reply to this message', _json(27, {}));
    assert.equal(hit, null);
  });

  it('content creation with no referent is not a reply', async () => {
    const hit = await _hit('write me an email to my landlord about rent', _json(27, {}));
    assert.equal(hit, null);
  });

  it('resolved URL target with no live deixis → read_url instead of scan', async () => {
    const hit = await _hit('draft a reply to the announcement', _json(27, {}),
      { activeDocRef: 'url', activeDocTarget: 'https://example.com/ann' });
    assert.equal(hit.template, 'reply_draft');
    assert.equal(hit.skillPlan[0].args.action, 'read_url');
    assert.equal(hit.skillPlan[0].args.url, 'https://example.com/ann');
  });
});

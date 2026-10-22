'use strict';
/**
 * onscreen-referent.test.js — implicit on-screen referent binding in
 * resolveReferencesV2: prompts that act on the visible page but never say
 * "this page"/"on screen" must bind the live page instead of navigating away.
 *
 * Regression (the LinkedIn incident):
 *   - "in write a message come with a response to Sharmila but don't submit"
 *     while Sharmila's LinkedIn thread was bound → a linkedin url.first.agent
 *     moved the real tab to linkedin.com/feed and lost the conversation.
 *   - Fix: a named service matching a bound/live page (or a page-action verb +
 *     artifact noun with a live page) binds the page — vetoed by a different
 *     named destination (structural), a lead-away verb (lexical), or the
 *     classifier's newDestination flag (semantic).
 *
 * Run: node stategraph-module/test/onscreen-referent.test.js
 */

const { describe, it } = require('node:test');

const resolveReferencesV2 = require('../src/nodes/resolveReferencesV2');

const _logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const LI_URL = 'https://www.linkedin.com/messaging/thread/sharmila';
const LI_TITLE = 'Sharmila Suriyasekaran | LinkedIn';

// Stub mcp adapter — monitor reports the LinkedIn thread as the frontmost app.
function makeMcp({ url = LI_URL, title = LI_TITLE } = {}) {
  return {
    callService: async (_svc, method) => {
      if (method === 'session.route') return { sessionId: 'sess-1' };
      if (method === 'message.list') return { messages: [] };
      if (method === 'message.search') return { messages: [] };
      if (method === 'memory.getRecentOcr') {
        return { available: true, capture: { appName: 'Google Chrome', category: 'browser', url, windowTitle: title, capturedAt: new Date().toISOString(), text: '' } };
      }
      if (method === 'memory.getActiveAppContext') return { app: { appName: 'Google Chrome', category: 'browser', url, windowTitle: title, source: 'live', timestamp: new Date().toISOString() } };
      return {};
    },
  };
}

const BASE_CLASSIFY = {
  taskType: 'browser', isFollowUp: false, followUpTarget: null,
  needsClarification: false, targetService: null, isRecurring: false,
  isBrowseOnly: false, requiresDOM: false, isScreenFollowUp: false,
  needsFreshScreen: false, isAppUiInspection: false, isSpatialAnalysis: false,
  isImageAnalysis: false, isConversationRecall: false, isActivityQuery: false,
  webAccessMode: 'interactive', interactiveActions: [], expectsFileOutput: false,
  activeDocRef: null, newDestination: false, suggestedIntent: 'command_automate',
};

function makeLlm(payload) {
  return { generateAnswer: async () => JSON.stringify({ ...BASE_CLASSIFY, ...payload }) };
}

// Stub the ext.sessions gateway fetch — controls _extConnected + _extSessions.
const _realFetch = global.fetch;
function stubExt(sessions) {
  global.fetch = async () => ({
    json: async () => ({ connected: true, sessions }),
  });
}
function unstubExt() { global.fetch = _realFetch; }

const LI_BOUND = [{ sessionId: 'ext:linkedin_agent', url: LI_URL, title: LI_TITLE, lastSeen: 5 }];

const _resolve = (message, tc, mcp) => resolveReferencesV2({
  message, mcpAdapter: mcp || makeMcp(), llmBackend: makeLlm(tc),
  context: { sessionId: 'sess-1' }, logger: _logger, conversationHistory: [],
});

async function main() {
  try {
    await describe('resolveReferencesV2 — implicit on-screen referent', async () => {

      it('service-on-screen: named service matching the bound tab binds it', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve("in write a message come with a response to Sharmila but don't submit",
          { targetService: 'linkedin', followUpTarget: 'LinkedIn message to Sharmila', interactiveActions: ['reply'] });
        if (!out._onScreenRef) throw new Error('expected _onScreenRef');
        if (out._onScreenRef.service !== 'linkedin') throw new Error(`service=${out._onScreenRef.service}`);
        if (out._onScreenRef.sessionId !== 'ext:linkedin_agent') throw new Error(`sessionId=${out._onScreenRef.sessionId}`);
        if (out._taskClassification.activeDocRef !== 'url') throw new Error(`activeDocRef=${out._taskClassification.activeDocRef}`);
        if (out.activeBrowserSessionId !== 'ext:linkedin_agent') throw new Error(`activeBrowserSessionId=${out.activeBrowserSessionId}`);
        if (!out._extSessionHint?.sessionId) throw new Error('expected _extSessionHint');
      });

      it('service-on-screen via frontmost URL (no bound tab) → ext:open session', async () => {
        stubExt([]); // connected, nothing bound — frontmost URL is the evidence
        const out = await _resolve('write a reply to the thread',
          { targetService: 'linkedin', interactiveActions: ['reply'] });
        if (out._onScreenRef?.sessionId !== 'ext:open:linkedin_agent') throw new Error(`sessionId=${out._onScreenRef?.sessionId}`);
      });

      it('departure verb to a different service → no binding', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve('go to amazon and find wireless headphones',
          { targetService: 'amazon', interactiveActions: [] });
        if (out._onScreenRef) throw new Error(`bound ${out._onScreenRef.via} on a departure prompt`);
        if (out._extSessionHint) throw new Error('extSessionHint set on a departure prompt');
      });

      it('novel departure phrasing + named different destination → no binding', async () => {
        stubExt(LI_BOUND);
        // "hop over to" isn't in the verb regex — the named-but-unmatched
        // destination vetoes binding structurally.
        const out = await _resolve('hop over to gmail and check my inbox',
          { targetService: 'gmail', interactiveActions: ['check'] });
        if (out._onScreenRef) throw new Error(`bound ${out._onScreenRef.via} on a different-destination prompt`);
      });

      it('classifier newDestination:true → no binding even on the same service', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve('open linkedin jobs',
          { targetService: 'linkedin', newDestination: true });
        if (out._onScreenRef) throw new Error('bound despite newDestination:true');
      });

      it('page-artifact: no service named + artifact noun → ext:default', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve('fill out the message box with a thank you note but don\'t send it',
          { interactiveActions: ['fill_form'] });
        if (out._onScreenRef?.via !== 'page-artifact') throw new Error(`via=${out._onScreenRef?.via}`);
        if (out._onScreenRef?.sessionId !== 'ext:default') throw new Error(`sessionId=${out._onScreenRef?.sessionId}`);
        if (out.activeBrowserSessionId !== 'ext:default') throw new Error(`activeBrowserSessionId=${out.activeBrowserSessionId}`);
      });

      it('"open <on-page element>" is not a departure — binding survives', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve('open the reply box and type a thank you',
          { targetService: 'linkedin', interactiveActions: ['reply'] });
        if (!out._onScreenRef) throw new Error('"open the reply box" vetoed binding — false positive');
      });

      it('"go to <on-page element>" is not a departure — binding survives', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve('go to the comments and write a reply',
          { targetService: 'linkedin', interactiveActions: ['comment'] });
        if (!out._onScreenRef) throw new Error('"go to the comments" vetoed binding — false positive');
      });

      it('passive screen-intel intent still binds when a page verb is present', async () => {
        stubExt(LI_BOUND);
        const out = await _resolve('check my linkedin notifications',
          { taskType: 'query', suggestedIntent: 'web_search', targetService: 'linkedin', webAccessMode: 'none' });
        if (!out._onScreenRef) throw new Error('passive-classified page action did not bind');
        if (out._taskClassification.suggestedIntent === 'web_search') throw new Error('passive intent not demoted');
      });

      it('no live page at all → nothing binds', async () => {
        stubExt([]);
        const out = await _resolve('write a message to Sharmila',
          { targetService: 'linkedin', interactiveActions: ['reply'] },
          makeMcp({ url: null, title: null }));
        if (out._onScreenRef) throw new Error('bound with no live page');
      });
    });
    console.log('onscreen-referent.test.js — all tests passed');
  } finally {
    unstubExt();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

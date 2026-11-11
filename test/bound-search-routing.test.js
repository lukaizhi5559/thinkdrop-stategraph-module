'use strict';

/**
 * A stale live tab must not turn every new "search for X" into browser
 * automation. Only a follow-up or explicit page wording binds to the tab.
 */

const assert = require('assert');
const { classifyTask } = require('../src/utils/classifyTask.js');

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const response = JSON.stringify({
  taskType: 'browser',
  isFollowUp: false,
  followUpTarget: null,
  needsClarification: false,
  targetService: null,
  isRecurring: false,
  isBrowseOnly: true,
  requiresDOM: false,
  isScreenFollowUp: false,
  needsFreshScreen: false,
  isAppUiInspection: false,
  isSpatialAnalysis: false,
  isImageAnalysis: false,
  isConversationRecall: false,
  isActivityQuery: false,
  isThoughtReply: false,
  webAccessMode: 'public_read',
  interactiveActions: [],
  expectsFileOutput: false,
  activeDocRef: null,
  mediaListing: 'none',
  suggestedIntent: 'web_search',
});

async function classify(message) {
  return classifyTask(
    message,
    [],
    { generateAnswer: async () => response },
    logger,
    null,
    null,
    { extSessions: [{ sessionId: 'ext:amazon', url: 'https://www.amazon.com/', alive: true }] },
  );
}

(async () => {
  const standalone = await classify('search for the best pizza in brooklyn');
  assert.strictEqual(standalone.webAccessMode, 'public_read');
  assert.strictEqual(standalone.requiresDOM, false);

  const pageScoped = await classify('search for pizza on this page');
  assert.strictEqual(pageScoped.webAccessMode, 'interactive');
  assert.strictEqual(pageScoped.requiresDOM, true);

  console.log('bound-search routing: 4 passed');
})().catch(err => {
  console.error(err.stack || err);
  process.exit(1);
});

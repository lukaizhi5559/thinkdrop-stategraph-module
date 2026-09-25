'use strict';
/**
 * route-table.test.js — the deterministic taskType→intent map (Stage E).
 * Pins every rule's trigger conditions and precedence order.
 *
 * Run: node stategraph-module/test/route-table.test.js
 */

const { suggestIntent } = require('../src/utils/routeTable');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label} — expected ${expected}, got ${actual}`); failed++; }
}

// ── Rule precedence: declined_ack beats everything ───────────────────────────
eq(suggestIntent({ resolution: 'declined_ack', taskType: 'browser', webAccessMode: 'public_read' }, 'no')?.intent,
  'general_knowledge', 'declined_ack beats public-research');
eq(suggestIntent({ resolution: 'declined_ack' }, 'no thanks')?.rule, 'declined-ack', 'declined_ack rule name');

// ── media-search ─────────────────────────────────────────────────────────────
eq(suggestIntent({ mediaListing: 'image', taskType: 'browser' }, 'show me pics of dogs')?.intent,
  'web_search', 'generic image listing → web_search');
// Falls THROUGH media-search → local-short-circuit (taskType=browser) — same
// as the real guard chain ordering.
eq(suggestIntent({ mediaListing: 'image', targetService: 'amazon', taskType: 'browser' }, 'pics of baby clothes on amazon')?.intent,
  'command_automate', 'image + named site → command_automate via short-circuit');
eq(suggestIntent({ mediaListing: 'video', targetService: 'youtube', taskType: 'browser' }, 'youtube videos of cats')?.intent,
  'web_search', 'video + youtube → web_search (bot-walled site)');
eq(suggestIntent({ mediaListing: 'video', targetService: 'vimeo', taskType: 'browser' }, 'vimeo videos of cats')?.intent,
  'web_search', 'video + vimeo → web_search');
eq(suggestIntent({ mediaListing: 'video', targetService: 'hulu', taskType: 'browser' }, 'hulu videos')?.intent,
  'command_automate', 'video + non-listed platform → command_automate via short-circuit');
eq(suggestIntent({ mediaListing: 'image', webAccessMode: 'interactive', taskType: 'browser' }, 'x')?.intent,
  'command_automate', 'interactive suppresses media-search, falls to short-circuit');
eq(suggestIntent({ mediaListing: 'image', taskType: 'browser' }, 'pics of dogs and then email them'),
  null, 'multi-goal conjunction suppresses media-search');

// ── public-research ──────────────────────────────────────────────────────────
eq(suggestIntent({ webAccessMode: 'public_read', taskType: 'browser' }, 'look online for standing desks')?.intent,
  'web_search', 'public_read + no service → web_search');
eq(suggestIntent({ webAccessMode: 'public_read', targetService: 'nike', taskType: 'browser' }, 'shoes on nike')?.intent,
  'command_automate', 'public_read + named service → command_automate via short-circuit');
eq(suggestIntent({ webAccessMode: 'public_read', taskType: 'browser' }, 'research X and then email it'),
  null, 'multi-goal suppresses public-research');

// ── query-followup ───────────────────────────────────────────────────────────
const baseFollowUp = { taskType: 'query', isFollowUp: true, followUpTarget: 'Bryce Crawford' };
eq(suggestIntent(baseFollowUp, 'what genre is he')?.intent, 'web_search', 'resolved topic follow-up → web_search');
eq(suggestIntent({ ...baseFollowUp, webAccessMode: 'none' }, 'x'), null, 'webAccessMode=none suppresses');
eq(suggestIntent({ ...baseFollowUp, isScreenFollowUp: true }, 'x'), null, 'isScreenFollowUp suppresses');
eq(suggestIntent({ ...baseFollowUp, isConversationRecall: true }, 'x')?.intent,
  'memory_retrieve', 'isConversationRecall suppresses query-followup, hits recall rule');
eq(suggestIntent({ ...baseFollowUp, targetService: 'spotify' }, 'x'), null, 'targetService suppresses');
eq(suggestIntent({ ...baseFollowUp, requiresDOM: true }, 'x'), null, 'requiresDOM suppresses');
eq(suggestIntent({ ...baseFollowUp, followUpTarget: '/Users/me/notes.txt' }, 'x'), null, 'path target suppresses');
eq(suggestIntent({ ...baseFollowUp, followUpTarget: 'report.pdf' }, 'x'), null, 'file-ext target suppresses');
eq(suggestIntent({ ...baseFollowUp, isActivityQuery: true }, 'x'), null, 'isActivityQuery suppresses');
eq(suggestIntent({ ...baseFollowUp, isAppUiInspection: true }, 'x'), null, 'isAppUiInspection suppresses');
eq(suggestIntent({ ...baseFollowUp, isSpatialAnalysis: true }, 'x'), null, 'isSpatialAnalysis suppresses');
eq(suggestIntent({ ...baseFollowUp, needsFreshScreen: true }, 'x'), null, 'needsFreshScreen suppresses');

// ── local short-circuit ──────────────────────────────────────────────────────
for (const tt of ['local_file', 'local_system', 'app_automation', 'browser']) {
  eq(suggestIntent({ taskType: tt }, 'do the thing')?.intent, 'command_automate', `${tt} → command_automate`);
}
eq(suggestIntent({ taskType: 'browser', needsFreshScreen: true }, 'x'), null, 'needsFreshScreen suppresses short-circuit');
eq(suggestIntent({ taskType: 'browser' }, 'open x and then post y'), null, 'multi-goal suppresses short-circuit');
eq(suggestIntent({ taskType: 'query' }, 'what is X'), null, 'query taskType → no opinion');

// ── conversation-recall ──────────────────────────────────────────────────────
eq(suggestIntent({ isConversationRecall: true, taskType: 'query' }, 'what did I ask earlier')?.intent,
  'memory_retrieve', 'isConversationRecall → memory_retrieve');
eq(suggestIntent({ isConversationRecall: true, taskType: 'query' }, 'what did I ask and then search more'),
  null, 'multi-goal suppresses recall');

// ── unresolved-followup / needs_clarification ────────────────────────────────
eq(suggestIntent({ isFollowUp: true, taskType: 'query' }, 'yes')?.intent,
  'memory_retrieve', 'followUp without target → memory_retrieve');
eq(suggestIntent({ resolution: 'needs_clarification', taskType: 'query' }, 'sure')?.intent,
  'memory_retrieve', 'needs_clarification → memory_retrieve');
eq(suggestIntent({ isFollowUp: true, followUpTarget: 'Bryce', taskType: 'query' }, 'x')?.intent,
  'web_search', 'followUp WITH target hits query-followup, not unresolved');

// ── thought-reply (card-bound) ───────────────────────────────────────────────
eq(suggestIntent({ isThoughtReply: true, followUpTarget: 'Dee-1 is a New Orleans-born rapper', taskType: 'query' }, 'let chat about this')?.intent,
  'web_search', 'bound card reply → web_search');
eq(suggestIntent({ isThoughtReply: true, followUpTarget: 'card text', webAccessMode: 'none' }, 'tell me more')?.intent,
  'memory_retrieve', 'webAccessMode=none → memory_retrieve');
eq(suggestIntent({ isThoughtReply: true, followUpTarget: 'card', taskType: 'query' }, 'yes and then email John'),
  null, 'multi-goal suppresses thought-reply');
eq(suggestIntent({ isThoughtReply: true, followUpTarget: null }, 'no thanks'),
  null, 'no target + no isFollowUp → no opinion (decline handled upstream)');
eq(suggestIntent({ isThoughtReply: true, followUpTarget: 'card text', taskType: 'browser' }, 'x')?.intent,
  'command_automate', 'browser taskType hits short-circuit before thought-reply');

// ── null / uncovered cases ───────────────────────────────────────────────────
eq(suggestIntent(null, 'x'), null, 'null tc → null');
eq(suggestIntent({}, 'x'), null, 'empty tc → null');
eq(suggestIntent({ taskType: 'messaging', targetService: 'slack' }, 'tell John hi'),
  null, 'messaging task → no opinion (LLM decides)');

console.log(`\n${'='.repeat(60)}\n  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}\n${'='.repeat(60)}`);
process.exit(failed ? 1 : 0);

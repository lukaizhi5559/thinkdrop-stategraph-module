'use strict';

/**
 * gather-live-surface.test.js — live-surface resolution for the grill
 *
 * Regression: "sum up a couple of the good comments on this page" asked the
 * user "Which page are we summarizing comments from?" even though
 * ResolveReferencesV2 had already resolved the deictic to the live YouTube
 * tab (activeDocRef:'url' + activeDocTarget + priorScreenContext.url). The
 * grill prompts never saw the resolved surface.
 *
 * Tests:
 *   1. _liveSurface — block content + resolved flag from each state source
 *   2. _PAGE_IDENTITY_Q_RE — matches page/site/tab/URL identity questions,
 *      leaves legitimate questions alone
 *
 * Run with: node stategraph-module/test/gather-live-surface.test.js
 */

let _passed = 0, _failed = 0;

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}\n  ${label}\n${'─'.repeat(70)}`);
  fn();
}

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    _failed++;
    console.log(`  ✗ ${label}\n    → ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const { _liveSurface, _PAGE_IDENTITY_Q_RE } = require('../src/nodes/gatherPlanContext');

describe('_liveSurface — resolved-surface detection', () => {
  it('resolves from activeDocRef:url + activeDocTarget', () => {
    const s = _liveSurface({
      _taskClassification: { activeDocRef: 'url', activeDocTarget: 'https://youtube.com/watch?v=QZYW0SBqjIU' },
      _priorScreenContext: { appName: 'Google Chrome', windowTitle: '1 HOUR workout', url: 'https://youtube.com/watch?v=QZYW0SBqjIU' },
    });
    assert(s.resolved === true, 'expected resolved');
    assert(s.block.includes('youtube.com/watch?v=QZYW0SBqjIU'), 'block missing the page URL');
    assert(/NEVER ask/i.test(s.block), 'block missing the never-ask instruction');
    assert(s.block.includes('Google Chrome'), 'block missing frontmost app');
  });

  it('resolves from _extSessionHint when no doc target', () => {
    const s = _liveSurface({
      _taskClassification: {},
      _extSessionHint: { sessionId: 'ext:default', url: 'https://ebay.com/itm/123', title: 'Keyboard listing' },
    });
    assert(s.resolved === true, 'expected resolved via ext hint');
    assert(s.block.includes('ebay.com/itm/123'), 'block missing ext URL');
  });

  it('resolves from _extSessions (most recent real tab), skipping chrome:// tabs', () => {
    const s = _liveSurface({
      _taskClassification: {},
      _extSessions: [
        { sessionId: 'ext:a', url: 'chrome://extensions/', lastSeen: 200 },
        { sessionId: 'ext:b', url: 'https://amazon.com/dp/B0X', lastSeen: 100 },
      ],
    });
    assert(s.resolved === true, 'expected resolved via ext session');
    assert(s.block.includes('amazon.com/dp/B0X'), 'block should list the real tab, not chrome://');
  });

  it('resolves from _priorScreenContext.url alone', () => {
    const s = _liveSurface({
      _taskClassification: {},
      _priorScreenContext: { appName: 'Safari', url: 'https://news.ycombinator.com', windowTitle: 'Hacker News' },
    });
    assert(s.resolved === true, 'expected resolved via prior screen URL');
    assert(s.block.includes('news.ycombinator.com'), 'block missing prior URL');
  });

  it('resolves file referents from activeDocRef:file', () => {
    const s = _liveSurface({
      _taskClassification: { activeDocRef: 'file', activeDocTarget: '/tmp/notes.txt' },
    });
    assert(s.resolved === true && s.docRef === 'file', 'expected file resolution');
    assert(s.block.includes('/tmp/notes.txt'), 'block missing file path');
  });

  it('not resolved when nothing is bound or referenced', () => {
    const s = _liveSurface({ _taskClassification: {}, _priorScreenContext: { appName: 'Finder' } });
    assert(s.resolved === false, 'expected not resolved');
  });
});

describe('_PAGE_IDENTITY_Q_RE — question drop filter', () => {
  it('matches the observed failing question', () => {
    assert(_PAGE_IDENTITY_Q_RE.test('Which page are we summarizing comments from? (URL or page name)'),
      'observed question not matched');
  });

  it('matches other page-identity phrasings', () => {
    for (const q of [
      'Which page should I read?',
      'What URL is the page at?',
      'Which tab contains the comments?',
      'Which website do you mean?',
      'Provide the url to read',
    ]) {
      assert(_PAGE_IDENTITY_Q_RE.test(q), `not matched: "${q}"`);
    }
  });

  it('leaves legitimate questions alone', () => {
    for (const q of [
      'How many comments should I include?',
      'Do you want just positive comments or all?',
      'What tone should the summary use?',
      'Which delivery method for the summary?',
    ]) {
      assert(!_PAGE_IDENTITY_Q_RE.test(q), `false positive: "${q}"`);
    }
  });
});

console.log(`\n${_passed} passed, ${_failed} failed\n`);
process.exit(_failed ? 1 : 0);

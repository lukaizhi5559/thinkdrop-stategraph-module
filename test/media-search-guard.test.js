'use strict';
/**
 * media-search-guard.test.js
 *
 * Regression tests for classifier-flag media routing:
 *   - classifyTask emits mediaListing ("none" | "image" | "video")
 *   - decomposePromptV2 media-search guard routes image/video listing tasks
 *     to web_search instead of command_automate (replaces the IMAGE_REQUEST_RES
 *     regex guard)
 *   - webSearch.js applies the video query hint + higher limit for flagged
 *     video-listing queries
 *
 * Run from repo root with:
 *   node stategraph-module/test/media-search-guard.test.js
 */

// ─── Minimal test harness (matches recall-context.test.js style) ─────────────
let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  const done = () => { _passed++; console.log(`  ✅ ${label}`); };
  const fail = (e) => {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}`);
    console.log(`     ${e.message}`);
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(done, fail);
    done();
  } catch (e) { fail(e); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const _noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

const { classifyTask } = require('../src/utils/classifyTask.js');
const decomposePromptV2 = require('../src/nodes/decomposePromptV2.js');
const webSearch = require('../src/nodes/webSearch.js');
const { _shouldSkipVideoDelegation } = require('../../mcp-services/command-service/src/skills/browser.agent.cjs');

const _decompose = (message, tc, extra = {}) => decomposePromptV2({
  message,
  conversationHistory: [],
  logger: _noopLogger,
  llmBackend: { generateAnswer: async () => '0' },
  _taskClassification: tc,
  ...extra,
});

describe('classifyTask — mediaListing sanitize', () => {
  it('passes through a valid mediaListing value', async () => {
    const result = await classifyTask(
      'find videos from mike winger',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'browser', targetService: 'youtube', webAccessMode: 'public_read', mediaListing: 'video' }) },
      _noopLogger,
    );
    assertEq(result.mediaListing, 'video');
  });

  it('defaults invalid/missing mediaListing to none', async () => {
    const result = await classifyTask(
      'what time is it',
      [],
      { generateAnswer: async () => JSON.stringify({ taskType: 'local_system', mediaListing: 'hologram' }) },
      _noopLogger,
    );
    assertEq(result.mediaListing, 'none');
  });
});

describe('decomposePromptV2 — media-search guard', () => {
  it('video listing + no targetService → web_search', async () => {
    const r = await _decompose('find videos about sourdough starters', {
      taskType: 'browser', webAccessMode: 'public_read', mediaListing: 'video',
    });
    assertEq(r._decomposedIntent, 'web_search');
    assertEq(r._decomposedBy, 'media-search-guard');
    assertEq(r._mediaListing, 'video');
  });

  it('video listing + youtube targetService → web_search (Brave video handles site scope)', async () => {
    const r = await _decompose('find videos from mike winger Christ in the old testament', {
      taskType: 'browser', targetService: 'youtube', webAccessMode: 'public_read', mediaListing: 'video',
    });
    assertEq(r._decomposedIntent, 'web_search');
    assertEq(r._decomposedBy, 'media-search-guard');
  });

  it('video listing + non-video site stays command_automate', async () => {
    const r = await _decompose('find videos on amazon for product setup', {
      taskType: 'browser', targetService: 'amazon', webAccessMode: 'public_read', mediaListing: 'video',
    });
    assertEq(r._decomposedIntent, 'command_automate');
    assert(['local-short-circuit', 'site-service-guard'].includes(r._decomposedBy), `expected deterministic automation parser, got ${r._decomposedBy}`);
  });

  it('image listing + no targetService → web_search', async () => {
    const r = await _decompose('show me a picture of a red panda', {
      taskType: 'query', webAccessMode: 'public_read', mediaListing: 'image',
    });
    assertEq(r._decomposedIntent, 'web_search');
    assertEq(r._decomposedBy, 'media-search-guard');
    assertEq(r._mediaListing, 'image');
  });

  it('image listing + named site stays command_automate (product cards need SERP crawl)', async () => {
    const r = await _decompose('show pics of baby clothes for sale on amazon', {
      taskType: 'browser', targetService: 'amazon', webAccessMode: 'public_read', mediaListing: 'image',
    });
    assertEq(r._decomposedIntent, 'command_automate');
    assertEq(r._decomposedBy, 'local-short-circuit');
  });

  it('video listing + interactive mode does NOT hijack (play/watch stays automate)', async () => {
    const r = await _decompose('watch the latest mike winger video', {
      taskType: 'browser', targetService: 'youtube', webAccessMode: 'interactive', mediaListing: 'video',
    });
    assertEq(r._decomposedIntent, 'command_automate');
  });

  it('video listing + multi-goal conjunction does NOT hijack', async () => {
    const r = await _decompose('find videos about X and then email me the list', {
      taskType: 'browser', targetService: 'youtube', webAccessMode: 'public_read', mediaListing: 'video',
    });
    assert(r._decomposedIntent !== 'web_search', 'multi-goal should not be hijacked to web_search');
  });

  it('mediaListing=none + browser → command_automate short-circuit (unchanged)', async () => {
    const r = await _decompose('open youtube and play my playlist', {
      taskType: 'browser', targetService: 'youtube', webAccessMode: 'interactive', mediaListing: 'none',
    });
    assertEq(r._decomposedIntent, 'command_automate');
    assert(['local-short-circuit', 'site-service-guard'].includes(r._decomposedBy), `expected deterministic automation parser, got ${r._decomposedBy}`);
  });
});

describe('webSearch — video listing query hint + limit', () => {
  const _mkAdapter = () => {
    const calls = [];
    return {
      calls,
      callService: async (svc, action, args) => {
        calls.push({ svc, action, args });
        return { data: { results: [] } };
      },
    };
  };

  it('appends "videos" when the resolved query lacks a media keyword', async () => {
    const adapter = _mkAdapter();
    await webSearch({
      message: 'pull list with links',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'video',
      _taskClassification: { isFollowUp: true, followUpTarget: 'Mike Winger Christ in the Old Testament', mediaListing: 'video' },
    });
    const q = adapter.calls[0].args.query;
    assert(/\bvideos\b/i.test(q), `query should contain "videos" — got "${q}"`);
    assertEq(adapter.calls[0].args.maxResults, 8);
  });

  it('does not append "videos" when the query already has a video keyword', async () => {
    const adapter = _mkAdapter();
    await webSearch({
      message: 'find videos from mike winger Christ in the old testament',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'video',
      _taskClassification: { mediaListing: 'video' },
    });
    const q = adapter.calls[0].args.query;
    assert(!/videos videos/i.test(q), `query should not double the keyword — got "${q}"`);
    assertEq(adapter.calls[0].args.maxResults, 8);
  });

  it('forces provider=brave-video for video listings', async () => {
    const adapter = _mkAdapter();
    adapter.callService = async (svc, action, args) => {
      adapter.calls.push({ svc, action, args });
      return { data: { results: [{ url: 'https://youtube.com/watch?v=abc', title: 'v', type: 'video-result', metadata: { thumbnail: { src: 'https://i.ytimg.com/t.jpg' }, duration: '12:00', channel: 'ch' } }] } };
    };
    const r = await webSearch({
      message: 'find videos from mike winger',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'video',
      _taskClassification: { mediaListing: 'video' },
    });
    assertEq(adapter.calls[0].args.provider, 'brave-video');
    assertEq(adapter.calls.length, 1, 'no fallback needed when results exist');
    const doc = r.contextDocs[0];
    assertEq(doc.mediaType, 'video');
    assert(doc.imageUrl, 'video doc should carry thumbnail imageUrl');
    assertEq(doc.duration, '12:00');
    assertEq(doc.channel, 'ch');
  });

  it('retries with auto provider when brave-video returns empty', async () => {
    const adapter = _mkAdapter();
    let n = 0;
    adapter.callService = async (svc, action, args) => {
      adapter.calls.push({ svc, action, args });
      n++;
      return { data: { results: n === 1 ? [] : [{ url: 'https://x.com/v', title: 't' }] } };
    };
    await webSearch({
      message: 'find videos about X',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'video',
      _taskClassification: { mediaListing: 'video' },
    });
    assertEq(adapter.calls.length, 2, 'should retry with auto provider');
    assertEq(adapter.calls[0].args.provider, 'brave-video');
    assert(!adapter.calls[1].args.provider, 'retry must not force a provider');
  });

  it('retries with auto provider when brave-video call throws', async () => {
    const adapter = _mkAdapter();
    let n = 0;
    adapter.callService = async (svc, action, args) => {
      adapter.calls.push({ svc, action, args });
      n++;
      if (n === 1) throw new Error('Brave 429');
      return { data: { results: [{ url: 'https://x.com/v', title: 't' }] } };
    };
    await webSearch({
      message: 'find videos about X',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'video',
      _taskClassification: { mediaListing: 'video' },
    });
    assertEq(adapter.calls.length, 2, 'throw on forced provider should retry auto');
    assert(!adapter.calls[1].args.provider, 'retry must not force a provider');
  });

  it('visual follow-up keeps the resolved followUpTarget in the query', async () => {
    // Regression: "show me some pics" after a sourdough search used to search
    // the literal message text, dropping the resolved topic entirely.
    const adapter = _mkAdapter();
    await webSearch({
      message: 'show me some pics',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'image',
      _taskClassification: { isFollowUp: true, followUpTarget: 'sourdough bread', mediaListing: 'image' },
    });
    const q = adapter.calls[0].args.query;
    assert(/sourdough bread/i.test(q), `query should contain resolved topic — got "${q}"`);
    assert(/pics/i.test(q), `query should keep visual phrasing — got "${q}"`);
    assertEq(adapter.calls[0].args.provider, 'brave-image');
  });

  it('visual follow-up does not duplicate a topic already in the message', async () => {
    const adapter = _mkAdapter();
    await webSearch({
      message: 'show me sourdough bread pics',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _mediaListing: 'image',
      _taskClassification: { isFollowUp: true, followUpTarget: 'sourdough bread', mediaListing: 'image' },
    });
    const q = adapter.calls[0].args.query;
    assertEq((q.match(/sourdough bread/gi) || []).length, 1, `topic should appear once — got "${q}"`);
  });

  it('non-media queries keep limit=3, no provider, no keyword injection', async () => {
    const adapter = _mkAdapter();
    await webSearch({
      message: 'what is the capital of france',
      mcpAdapter: adapter,
      logger: _noopLogger,
      _taskClassification: {},
    });
    assertEq(adapter.calls[0].args.limit, 3);
    assert(!adapter.calls[0].args.provider, 'no provider forced for non-media');
    assert(!/videos/i.test(adapter.calls[0].args.query), 'no video keyword injected');
  });
});

describe('browser.agent — video.agent delegation guard (flag-first)', () => {
  it('mediaListing=video skips delegation even when step phrasing trips the regex', () => {
    // "watch" + "extract" would fail _isPureSearchTask, but the classifier flag wins.
    const r = _shouldSkipVideoDelegation(
      'Watch for results and extract the video list',
      { mediaListing: 'video', targetService: 'youtube' },
    );
    assertEq(r, true);
  });

  it('falls back to _isPureSearchTask when classification is absent', () => {
    assertEq(_shouldSkipVideoDelegation('search youtube for sourdough tutorials', null), true);
    assertEq(_shouldSkipVideoDelegation('watch this video and summarize it', null), false);
  });

  it('video consumption tasks still delegate when flag is not video', () => {
    assertEq(_shouldSkipVideoDelegation('find the mike winger video and extract the transcript', { mediaListing: 'none' }), false);
  });
});

setTimeout(() => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${_passed} passed, ${_failed} failed`);
  if (_failures.length) {
    for (const f of _failures) console.log(`    - ${f.label}: ${f.error}`);
  }
  console.log('═'.repeat(70));
  process.exit(_failed ? 1 : 0);
}, 500);

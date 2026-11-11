'use strict';
/**
 * screen-intelligence-degrade.test.js — a failed screen capture must never
 * become the user-facing reply.
 *
 * Observed (2026-11-11 e2e): "is this current application with the electron
 * overlays visible to an AI proctoring monitoring system" → needsFreshScreen
 * grab → screen.analyze returned HTTP 500 screen_recording_permission_denied
 * → the node set state.answer to the raw `HTTP 500: {…json…}` → the builder
 * edge routed answer→logConversation → the user saw a JSON dump, which was
 * also persisted into conversation history.
 *
 * Fix under test (screenIntelligence.js): on failure the node returns NO
 * answer — it writes a "SCREEN CAPTURE UNAVAILABLE" block into state.context
 * (friendly reason + remediation incl. the System Settings deep link) and
 * clears _needsFreshScreen so the screenIntelligence edge falls through to
 * the answer node for an honest degraded reply. The no-mcpAdapter early
 * return degrades the same way (it previously surfaced a bracketed
 * placeholder answer verbatim).
 *
 * Hermetic: mcpAdapter.callService is scripted — no live services.
 *
 * Run: node stategraph-module/test/screen-intelligence-degrade.test.js
 */

const screenIntelligence = require('../src/nodes/screenIntelligence.js');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

const PERM_BODY = JSON.stringify({
  success: false,
  error: 'screen_recording_permission_denied',
  detail: 'Command failed: screencapture -x -t png /tmp/x.png\ncould not create image from display',
  hint: 'Grant Screen Recording permission to the process running this service (System Settings → Privacy & Security → Screen Recording), then restart the service.',
});

function makeState(overrides = {}) {
  return {
    message: 'is this application visible to a proctoring monitoring system',
    context: { sessionId: 'sess-test', userId: 'u1' },
    logger: silentLogger,
    _needsFreshScreen: true,
    _postScreenIntent: 'general_knowledge',
    ...overrides,
  };
}

(async () => {
  console.log('\nscreen-intelligence degrade tests');

  // ── 1. The logged repro: permission-denied 500 → degraded context, no answer ──
  {
    const state = makeState({
      mcpAdapter: {
        callService: async () => { throw new Error(`HTTP 500: ${PERM_BODY}`); },
      },
    });
    const res = await screenIntelligence(state);
    check('permission-denied → no raw answer set', res.answer === undefined,
      `answer=${String(res.answer).slice(0, 80)}`);
    check('permission-denied → context flags capture unavailable',
      /SCREEN CAPTURE UNAVAILABLE/.test(res.context || ''));
    check('permission-denied → context carries friendly reason',
      /Screen Recording/i.test(res.context || ''));
    check('permission-denied → context relays the service remediation hint',
      /Privacy & Security → Screen Recording/.test(res.context || ''));
    check('permission-denied → context forbids claiming screen visibility',
      /Do NOT describe, quote, or claim to see on-screen content/.test(res.context || ''));
    check('permission-denied → screenContext null', res.screenContext === null);
    check('permission-denied → _needsFreshScreen cleared (edge → answer)',
      res._needsFreshScreen === false);
    check('permission-denied → raw error preserved for telemetry',
      /HTTP 500/.test(res.error || ''));
    check('permission-denied → structured screenError code',
      res.screenError && res.screenError.code === 'screen_recording_permission_denied');
    check('permission-denied → no raw HTTP dump in context',
      !/HTTP 500/.test(res.context || ''));
    // The fix-it card: choices rides state → task:complete → QuestionCard;
    // a pick resolves via _matchPlanCheckAction to the open-url action.
    check('permission-denied → choices card offered', !!res.choices);
    const opts = res.choices && res.choices.options;
    check('permission-denied → card has two options', Array.isArray(opts) && opts.length === 2);
    const fix = opts && opts.find(o => o.action);
    check('permission-denied → open-url action option',
      !!fix && fix.action.action === 'open-url'
        && /Privacy_ScreenCapture/.test(fix.action.url));
    check('permission-denied → action option is primary with a human value',
      !!fix && fix.primary === true && typeof fix.value === 'string' && fix.value.length > 0);
    check('permission-denied → dismiss option present',
      !!opts && opts.some(o => o.action && o.action.action === 'dismiss'
        && /not now/i.test(o.label || '')));
  }

  // ── 2. Permission-denied without structured body → mapped reason + deep link ──
  {
    const state = makeState({
      mcpAdapter: {
        callService: async () => { throw new Error('HTTP 500: screen_recording_permission_denied'); },
      },
    });
    const res = await screenIntelligence(state);
    check('bare denial → friendly reason + settings deep link in context',
      /Screen Recording/i.test(res.context || '')
        && /Privacy_ScreenCapture/.test(res.context || ''));
  }

  // ── 3. Service unreachable → generic degraded context, no permission hint ──
  {
    const state = makeState({
      mcpAdapter: {
        callService: async () => { throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3011'); },
      },
    });
    const res = await screenIntelligence(state);
    check('unreachable → no answer, degraded context',
      res.answer === undefined && /SCREEN CAPTURE UNAVAILABLE/.test(res.context || ''));
    check('unreachable → unreachable reason, no false permission claim',
      /unreachable/i.test(res.context || '') && !/screen_recording_permission_denied/i.test(res.context || ''));
    check('unreachable → screenError.code = service_unreachable',
      res.screenError && res.screenError.code === 'service_unreachable');
    check('unreachable → no fix-it card (not a permission failure)',
      !res.choices);
  }

  // ── 4. No mcpAdapter → degrades identically (was a bracketed answer dump) ──
  {
    const res = await screenIntelligence(makeState({ mcpAdapter: null }));
    check('no adapter → no raw placeholder answer',
      res.answer === undefined,
      `answer=${String(res.answer).slice(0, 80)}`);
    check('no adapter → degraded context for answer node',
      /SCREEN CAPTURE UNAVAILABLE/.test(res.context || '')
        && /not connected/i.test(res.context || ''));
    check('no adapter → edge contract routes to answer node',
      res._needsFreshScreen === false && res.screenContext === null);
    check('no adapter → no fix-it card',
      !res.choices);
  }

  // ── 4b. Failure block forbids presenting prior screen descriptions as current ──
  {
    const state = makeState({
      mcpAdapter: { callService: async () => { throw new Error(`HTTP 500: ${PERM_BODY}`); } },
    });
    const res = await screenIntelligence(state);
    check('failure block → staleness clause present',
      /OUTDATED/.test(res.context || '') && /switched apps or tabs/.test(res.context || ''));
  }

  // ── 4c. No prior context + live browser frontmost → read_screen rescue ──────
  // The reported bug: monitor dead (TCC) → _priorScreenContext null → the old
  // gate skipped read_screen entirely, even though the extension lane needs
  // no Screen Recording permission. Now the live frontmost check unblocks it.
  {
    const state = makeState({
      _priorScreenContext: null,
      mcpAdapter: {
        callService: async (service, method, args) => {
          if (method === 'memory.getActiveAppContext') {
            return { data: { app: { appName: 'Google Chrome', category: 'browser' } } };
          }
          if (service === 'command' && args?.args?.action === 'read_screen') {
            return { data: {
              ok: true, text: 'Angular Signals is a system that granularly tracks how and where your state is used',
              appName: 'Google Chrome', url: 'https://angular.dev/guide/signals', via: 'browser_scan',
            } };
          }
          if (method === 'memory.getRecentOcr') return { data: { available: false } };
          return { data: { text: 'OCR fallback', appName: 'Google Chrome' } };
        },
      },
    });
    const res = await screenIntelligence(state);
    check('no prior ctx + browser live → capture from read_screen',
      res.screenContext && /Angular Signals/.test(res.screenContext.text || ''),
      `screenContext=${JSON.stringify(res.screenContext).slice(0, 100)}`);
    check('no prior ctx + browser live → content block, not failure block',
      /=== SCREEN CONTENT ===/.test(res.context || '') && !/SCREEN CAPTURE UNAVAILABLE/.test(res.context || ''));
    check('no prior ctx + browser live → live url captured',
      res.screenContext && res.screenContext.url === 'https://angular.dev/guide/signals');
  }

  // ── 4d. No prior context + non-browser frontmost → read_screen skipped ──────
  {
    let readScreenTried = false;
    const state = makeState({
      _priorScreenContext: null,
      mcpAdapter: {
        callService: async (service, method, args) => {
          if (method === 'memory.getActiveAppContext') {
            return { data: { app: { appName: 'TextEdit', category: 'editor' } } };
          }
          if (service === 'command' && args?.args?.action === 'read_screen') {
            readScreenTried = true;
            return { data: { ok: false, error: 'no browser frontmost' } };
          }
          if (method === 'memory.getRecentOcr') return { data: { available: false } };
          throw new Error(`HTTP 500: ${PERM_BODY}`);
        },
      },
    });
    const res = await screenIntelligence(state);
    check('no prior ctx + non-browser live → read_screen skipped',
      readScreenTried === false);
    check('no prior ctx + non-browser live → degrades as usual',
      /SCREEN CAPTURE UNAVAILABLE/.test(res.context || '') && res._needsFreshScreen === false);
  }

  // ── 4e. getActiveAppContext fails → read_screen attempted anyway (self-detecting) ──
  {
    let readScreenTried = false;
    const state = makeState({
      _priorScreenContext: null,
      mcpAdapter: {
        callService: async (service, method, args) => {
          if (method === 'memory.getActiveAppContext') throw new Error('service down');
          if (service === 'command' && args?.args?.action === 'read_screen') {
            readScreenTried = true;
            return { data: { ok: true, text: 'Page text '.repeat(20), appName: 'Google Chrome', via: 'browser_scan' } };
          }
          if (method === 'memory.getRecentOcr') return { data: { available: false } };
          return { data: { text: 'unused' } };
        },
      },
    });
    const res = await screenIntelligence(state);
    check('ctx fetch fails → read_screen still attempted (fail-open)',
      readScreenTried === true && res.screenContext != null);
  }

  // ── 5. Success path unchanged — capture still produces screen context ──────
  {
    const state = makeState({
      _needsFreshScreen: true,
      mcpAdapter: {
        callService: async (service, method) => {
          if (method === 'memory.getRecentOcr') return { data: { available: false } };
          return {
            data: {
              text: 'ProctorU monitoring dashboard — exam in progress',
              appName: 'Google Chrome',
              windowTitle: 'Exam Session',
              url: 'https://proctoru.example.com',
              confidence: 91,
            },
          };
        },
      },
    });
    const res = await screenIntelligence(state);
    check('success → screenContext populated',
      res.screenContext && res.screenContext.appName === 'Google Chrome'
        && /ProctorU/.test(res.screenContext.text));
    check('success → context is the OCR block, not a failure block',
      /=== SCREEN CONTENT ===/.test(res.context || '')
        && !/SCREEN CAPTURE UNAVAILABLE/.test(res.context || ''));
    check('success → _needsFreshScreen preserved for preparePostScreen',
      res._needsFreshScreen === true);
    check('success → no fix-it card',
      !res.choices);
  }

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });

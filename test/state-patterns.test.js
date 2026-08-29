'use strict';
/**
 * state-patterns.test.js
 *
 * Unit tests for the state-pattern-driven tier selection system:
 *   1. Deep link type classifier (deep-link-types.cjs)
 *   2. State pattern classifier (state-patterns.cjs)
 *   3. Category config (category-config.cjs)
 *   4. Priority ordering and guard logic
 *
 * Run with: node test/state-patterns.test.js
 */

// ── Minimal test harness (same pattern as url-first-regression.test.js) ─────
let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}`);
    console.log(`     ${e.message}`);
  }
}

function expect(actual) {
  function _build(negated) {
    return {
      toBe(expected) {
        const ok = actual === expected;
        if (ok === negated)
          throw new Error(negated
            ? `Expected ${JSON.stringify(actual)} NOT to be ${JSON.stringify(expected)}`
            : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      },
      toEqual(expected) {
        const a = JSON.stringify(actual), b = JSON.stringify(expected);
        const ok = a === b;
        if (ok === negated)
          throw new Error(negated ? `Expected NOT to equal ${b}` : `Expected ${b}, got ${a}`);
      },
      toBeNull() {
        const ok = actual === null;
        if (ok === negated)
          throw new Error(negated ? `Expected NOT null` : `Expected null, got ${JSON.stringify(actual)}`);
      },
      toContain(sub) {
        const ok = String(actual).includes(sub);
        if (ok === negated)
          throw new Error(negated ? `Expected NOT to contain "${sub}"` : `Expected "${actual}" to contain "${sub}"`);
      },
      toMatch(re) {
        const ok = re.test(String(actual));
        if (ok === negated)
          throw new Error(negated ? `Expected NOT to match ${re}` : `Expected "${actual}" to match ${re}`);
      },
      toBeTruthy() {
        const ok = !!actual;
        if (ok === negated)
          throw new Error(negated ? `Expected NOT truthy` : `Expected truthy, got ${JSON.stringify(actual)}`);
      },
      toBeFalsy() {
        const ok = !actual;
        if (ok === negated)
          throw new Error(negated ? `Expected NOT falsy` : `Expected falsy, got ${JSON.stringify(actual)}`);
      },
      toBeGreaterThan(expected) {
        const ok = actual > expected;
        if (ok === negated)
          throw new Error(negated ? `Expected NOT > ${expected}` : `Expected ${actual} > ${expected}`);
      },
      toBeLessThan(expected) {
        const ok = actual < expected;
        if (ok === negated)
          throw new Error(negated ? `Expected NOT < ${expected}` : `Expected ${actual} < ${expected}`);
      },
      get not() {
        return _build(!negated);
      },
    };
  }
  return _build(false);
}

// ── Modules under test ──────────────────────────────────────────────────────
const { classifyDeepLinkType, getDeepLinkDescription } = require('../../mcp-services/command-service/src/skill-helpers/deep-link-types.cjs');
const { classifyStatePattern } = require('../../mcp-services/command-service/src/skill-helpers/state-patterns.cjs');
const { getCategoryConfig, getKnownCategories } = require('../../mcp-services/command-service/src/skill-helpers/category-config.cjs');

// ════════════════════════════════════════════════════════════════════════════
// 1. DEEP LINK TYPE CLASSIFIER
// ════════════════════════════════════════════════════════════════════════════

describe('classifyDeepLinkType', () => {

  it('notion.new → creation', () => {
    expect(classifyDeepLinkType('https://notion.new')).toBe('creation');
  });

  it('docs.new → creation', () => {
    expect(classifyDeepLinkType('https://docs.new')).toBe('creation');
  });

  it('sheets.new → creation', () => {
    expect(classifyDeepLinkType('https://sheets.new')).toBe('creation');
  });

  it('docs.google.com/document/create → creation', () => {
    expect(classifyDeepLinkType('https://docs.google.com/document/create')).toBe('creation');
  });

  it('/new path → creation', () => {
    expect(classifyDeepLinkType('https://example.com/new')).toBe('creation');
  });

  it('/create path → creation', () => {
    expect(classifyDeepLinkType('https://example.com/create')).toBe('creation');
  });

  it('gmail #inbox?compose=new → compose (NOT creation)', () => {
    expect(classifyDeepLinkType('https://mail.google.com/mail/u/0/#inbox?compose=new')).toBe('compose');
  });

  it('/compose path → compose', () => {
    expect(classifyDeepLinkType('https://mail.google.com/mail/u/0/#compose=new')).toBe('compose');
  });

  it('gmail #search/is:unread → search', () => {
    expect(classifyDeepLinkType('https://mail.google.com/mail/u/0/#search/is:unread+from:pastor')).toBe('search');
  });

  it('?q= query param → search', () => {
    expect(classifyDeepLinkType('https://example.com/search?q=hello')).toBe('search');
  });

  it('&filter= param → search', () => {
    expect(classifyDeepLinkType('https://example.com/list?filter=active')).toBe('search');
  });

  it('/settings → navigation', () => {
    expect(classifyDeepLinkType('https://example.com/settings')).toBe('navigation');
  });

  it('/dashboard → navigation', () => {
    expect(classifyDeepLinkType('https://example.com/dashboard')).toBe('navigation');
  });

  it('/calendar → navigation', () => {
    expect(classifyDeepLinkType('https://example.com/calendar')).toBe('navigation');
  });

  it('/docs/getting-started → read', () => {
    expect(classifyDeepLinkType('https://example.com/docs/getting-started')).toBe('read');
  });

  it('/view/123 → read', () => {
    expect(classifyDeepLinkType('https://example.com/view/123')).toBe('read');
  });

  it('/new-features → none (word boundary guard)', () => {
    // "new-features" should NOT match /new because the path continues with "-features"
    // The regex requires /, ?, #, or end after "new"
    expect(classifyDeepLinkType('https://example.com/new-features')).toBe('none');
  });

  it('generic URL → none', () => {
    expect(classifyDeepLinkType('https://example.com/')).toBe('none');
  });

  it('null → none', () => {
    expect(classifyDeepLinkType(null)).toBe('none');
  });

  it('empty string → none', () => {
    expect(classifyDeepLinkType('')).toBe('none');
  });

  it('invalid URL → none', () => {
    expect(classifyDeepLinkType('not-a-url')).toBe('none');
  });
});

describe('getDeepLinkDescription', () => {

  it('creation description mentions ALREADY created', () => {
    expect(getDeepLinkDescription('creation')).toContain('ALREADY');
  });

  it('search description mentions results loaded', () => {
    expect(getDeepLinkDescription('search')).toContain('results');
  });

  it('compose description mentions fields', () => {
    expect(getDeepLinkDescription('compose')).toContain('fields');
  });

  it('unknown type returns default description', () => {
    expect(getDeepLinkDescription('unknown_type')).toContain('generic URL');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. STATE PATTERN CLASSIFIER — Individual patterns
// ════════════════════════════════════════════════════════════════════════════

describe('classifyStatePattern — alert_confirmation', () => {

  it('alertActive=true → alert_confirmation, fastPath=true', () => {
    const r = classifyStatePattern({ alertActive: true, goal: 'do something' });
    expect(r.pattern).toBe('alert_confirmation');
    expect(r.fastPath).toBe(true);
  });

  it('alert wins over creation deep link', () => {
    const r = classifyStatePattern({
      alertActive: true,
      isCreationDeepLink: true,
      fillableCount: 1,
      goal: 'create a page',
    });
    expect(r.pattern).toBe('alert_confirmation');
  });

  it('alert wins over loading', () => {
    const r = classifyStatePattern({
      alertActive: true,
      isLoading: true,
      goal: 'do something',
    });
    expect(r.pattern).toBe('alert_confirmation');
  });
});

describe('classifyStatePattern — loading_state', () => {

  it('isLoading=true (no alert) → loading_state, fastPath=true', () => {
    const r = classifyStatePattern({ isLoading: true, goal: 'do something' });
    expect(r.pattern).toBe('loading_state');
    expect(r.fastPath).toBe(true);
  });
});

describe('classifyStatePattern — creation_deep_link', () => {

  it('creation deep link + no overlay + fillable=1 → fastPath=true, tier=1', () => {
    const r = classifyStatePattern({
      isCreationDeepLink: true,
      overlayActive: false,
      alertActive: false,
      fillableCount: 1,
      goal: 'create a page with a todo list',
    });
    expect(r.pattern).toBe('creation_deep_link');
    expect(r.tier).toBe(1);
    expect(r.fastPath).toBe(true);
    expect(r.guardsPassed).toBe(true);
  });

  it('creation deep link + overlay → fastPath=false (guard fails)', () => {
    const r = classifyStatePattern({
      isCreationDeepLink: true,
      overlayActive: true,
      alertActive: false,
      fillableCount: 3,
      goal: 'create a page',
    });
    expect(r.pattern).toBe('creation_deep_link');
    expect(r.fastPath).toBe(false);
    expect(r.guardsPassed).toBe(false);
    expect(r.guardReason).toContain('overlay');
  });

  it('creation deep link + fillable=0 → fastPath=false (guard fails)', () => {
    const r = classifyStatePattern({
      isCreationDeepLink: true,
      overlayActive: false,
      alertActive: false,
      fillableCount: 0,
      goal: 'create a page',
    });
    expect(r.pattern).toBe('creation_deep_link');
    expect(r.fastPath).toBe(false);
    expect(r.guardsPassed).toBe(false);
    expect(r.guardReason).toContain('no fillable');
  });

  it('creation deep link via URL (notion.new) → detected', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://notion.new',
      overlayActive: false,
      alertActive: false,
      fillableCount: 1,
      goal: 'create a page',
    });
    expect(r.pattern).toBe('creation_deep_link');
    expect(r.deepLinkType).toBe('creation');
  });
});

describe('classifyStatePattern — search_deep_link_read', () => {

  it('search URL + read-only goal → fastPath=true, tier=0', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://mail.google.com/mail/u/0/#search/is:unread',
      goal: 'count unread emails',
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('search_deep_link_read');
    expect(r.tier).toBe(0);
    expect(r.fastPath).toBe(true);
  });

  it('search URL + read-only goal + overlay → fastPath=false', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://mail.google.com/mail/u/0/#search/is:unread',
      goal: 'count unread emails',
      overlayActive: true,
      alertActive: false,
    });
    expect(r.pattern).toBe('search_deep_link_read');
    expect(r.fastPath).toBe(false);
  });

  it('search URL + non-read goal → NOT search_deep_link_read', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://mail.google.com/mail/u/0/#search/is:unread',
      goal: 'reply to the first email',
      overlayActive: false,
      alertActive: false,
      fillableCount: 0,
    });
    expect(r.pattern).not.toBe('search_deep_link_read');
  });
});

describe('classifyStatePattern — form_dialog_open / multi_step_form', () => {

  it('overlay + fillable=3 → form_dialog_open, fastPath=false, tier=4', () => {
    const r = classifyStatePattern({
      overlayActive: true,
      fillableCount: 3,
      goal: 'fill the form',
    });
    expect(r.pattern).toBe('form_dialog_open');
    expect(r.tier).toBe(4);
    expect(r.fastPath).toBe(false);
  });

  it('overlay + fillable=3 + multi-item goal → multi_step_form', () => {
    const r = classifyStatePattern({
      overlayActive: true,
      fillableCount: 3,
      goal: 'fill title and date and location',
    });
    expect(r.pattern).toBe('multi_step_form');
    expect(r.tier).toBe(4);
    expect(r.fastPath).toBe(false);
  });

  it('overlay + fillable=1 → NOT form_dialog (single field)', () => {
    const r = classifyStatePattern({
      overlayActive: true,
      fillableCount: 1,
      goal: 'type a message',
    });
    // fillable < 2, so not form_dialog_open — falls through to other patterns
    expect(r.pattern).not.toBe('form_dialog_open');
  });
});

describe('classifyStatePattern — spatial_interaction', () => {

  it('explicit drag goal + no overlay → fastPath=true, tier=5', () => {
    const r = classifyStatePattern({
      goal: 'drag the card to the done column',
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('spatial_interaction');
    expect(r.tier).toBe(5);
    expect(r.fastPath).toBe(true);
  });

  it('drag goal + overlay → fastPath=false (guard fails)', () => {
    const r = classifyStatePattern({
      goal: 'drag the card to the done column',
      overlayActive: true,
      alertActive: false,
    });
    expect(r.pattern).toBe('spatial_interaction');
    expect(r.fastPath).toBe(false);
  });

  it('vague reorder goal → fastPath=false (not explicit)', () => {
    const r = classifyStatePattern({
      goal: 'reorder the list',
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('spatial_interaction');
    expect(r.fastPath).toBe(false);
    expect(r.guardReason).toContain('not explicit');
  });
});

describe('classifyStatePattern — find_and_click_text', () => {

  it('goal mentions clicking a link → find_and_click_text, tier=2', () => {
    const r = classifyStatePattern({
      goal: 'click the Settings link',
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('find_and_click_text');
    expect(r.tier).toBe(2);
    expect(r.fastPath).toBe(false);
  });

  it('find and click with overlay → NOT find_and_click_text (overlay blocks)', () => {
    const r = classifyStatePattern({
      goal: 'click the Settings link',
      overlayActive: true,
      fillableCount: 0,
      alertActive: false,
    });
    // With overlay and 0 fillable, falls to form_dialog or no_focus
    expect(r.pattern).not.toBe('find_and_click_text');
  });
});

describe('classifyStatePattern — shortcut_available', () => {

  it('shortcut matches goal + no overlay → shortcut_available, tier=3', () => {
    const r = classifyStatePattern({
      goal: 'create a new event',
      shortcutCount: 5,
      shortcutLabels: 'c: create event\nt: today\nn: next week',
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('shortcut_available');
    expect(r.tier).toBe(3);
    expect(r.fastPath).toBe(false);
  });

  it('shortcut with overlay → NOT shortcut_available', () => {
    const r = classifyStatePattern({
      goal: 'create a new event',
      shortcutCount: 5,
      shortcutLabels: 'c: create event',
      overlayActive: true,
      fillableCount: 0,
      alertActive: false,
    });
    expect(r.pattern).not.toBe('shortcut_available');
  });
});

describe('classifyStatePattern — canvas_editing', () => {

  it('editorState.region=body + no overlay → canvas_editing, tier=1', () => {
    const r = classifyStatePattern({
      goal: 'type a paragraph',
      editorState: { region: 'body', blockIndex: 2 },
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('canvas_editing');
    expect(r.tier).toBe(1);
    expect(r.fastPath).toBe(false);
  });

  it('editorState.region=cell → canvas_editing', () => {
    const r = classifyStatePattern({
      goal: 'enter a formula',
      editorState: { region: 'cell', blockIndex: 0 },
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('canvas_editing');
  });

  it('editorState.region=body + overlay → NOT canvas_editing', () => {
    const r = classifyStatePattern({
      goal: 'type a paragraph',
      editorState: { region: 'body', blockIndex: 2 },
      overlayActive: true,
      fillableCount: 0,
      alertActive: false,
    });
    expect(r.pattern).not.toBe('canvas_editing');
  });
});

describe('classifyStatePattern — single_field_focused', () => {

  it('ai_chat + fillable=1 + no overlay → fastPath=true, tier=1', () => {
    const r = classifyStatePattern({
      pageCategory: 'ai_chat',
      fillableCount: 1,
      hasAutoFocus: true,
      overlayActive: false,
      alertActive: false,
      goal: 'ask a question',
    });
    expect(r.pattern).toBe('single_field_focused');
    expect(r.tier).toBe(1);
    expect(r.fastPath).toBe(true);
  });

  it('document_editor + fillable=1 → fastPath=false (not ai_chat)', () => {
    const r = classifyStatePattern({
      pageCategory: 'document_editor',
      fillableCount: 1,
      overlayActive: false,
      alertActive: false,
      goal: 'type a title',
    });
    expect(r.pattern).toBe('single_field_focused');
    expect(r.fastPath).toBe(false);
    expect(r.guardReason).toContain('ai_chat only');
  });

  it('ai_chat + fillable=2 → fastPath=false (multi-field)', () => {
    const r = classifyStatePattern({
      pageCategory: 'ai_chat',
      fillableCount: 2,
      overlayActive: false,
      alertActive: false,
      goal: 'ask a question',
    });
    // fillable=2 with no overlay → form_dialog_open or single_field won't match
    // Actually fillable=2 without overlay → not form_dialog (needs overlay)
    // → falls through to single_field_focused only if fillable===1
    // fillable=2 → not single_field → falls to no_focus_need_click
    expect(r.pattern).not.toBe('single_field_focused');
  });
});

describe('classifyStatePattern — list_browse', () => {

  it('read goal + no form + no overlay → list_browse', () => {
    const r = classifyStatePattern({
      goal: 'read the page content',
      fillableCount: 0,
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('list_browse');
    expect(r.fastPath).toBe(false);
  });

  it('count goal + no form → list_browse', () => {
    const r = classifyStatePattern({
      goal: 'count the items',
      fillableCount: 0,
      overlayActive: false,
      alertActive: false,
    });
    expect(r.pattern).toBe('list_browse');
  });
});

describe('classifyStatePattern — no_focus_need_click (fallback)', () => {

  it('no signals → no_focus_need_click, tier=4', () => {
    const r = classifyStatePattern({ goal: 'do something' });
    expect(r.pattern).toBe('no_focus_need_click');
    expect(r.tier).toBe(4);
    expect(r.fastPath).toBe(false);
  });

  it('empty state → no_focus_need_click (no crash)', () => {
    const r = classifyStatePattern({});
    expect(r.pattern).toBe('no_focus_need_click');
  });

  it('null state → no_focus_need_click (no crash)', () => {
    const r = classifyStatePattern(null);
    expect(r.pattern).toBe('no_focus_need_click');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. PRIORITY ORDERING
// ════════════════════════════════════════════════════════════════════════════

describe('Priority ordering', () => {

  it('alert > creation deep link', () => {
    const r = classifyStatePattern({
      alertActive: true,
      isCreationDeepLink: true,
      fillableCount: 1,
      goal: 'create a page',
    });
    expect(r.pattern).toBe('alert_confirmation');
  });

  it('alert > loading', () => {
    const r = classifyStatePattern({
      alertActive: true,
      isLoading: true,
      goal: 'do something',
    });
    expect(r.pattern).toBe('alert_confirmation');
  });

  it('loading > creation deep link (no alert)', () => {
    const r = classifyStatePattern({
      isLoading: true,
      isCreationDeepLink: true,
      fillableCount: 1,
      goal: 'create a page',
    });
    expect(r.pattern).toBe('loading_state');
  });

  it('creation deep link > form dialog (creation classified, guard fails)', () => {
    const r = classifyStatePattern({
      isCreationDeepLink: true,
      overlayActive: true,
      fillableCount: 3,
      goal: 'create a page',
    });
    // Creation is higher priority than form_dialog — classified as creation
    // but guard fails (overlay), so fastPath=false → LLM decides
    expect(r.pattern).toBe('creation_deep_link');
    expect(r.fastPath).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. CATEGORY CONFIG
// ════════════════════════════════════════════════════════════════════════════

describe('getCategoryConfig', () => {

  it('document_editor returns config with regions and notes', () => {
    const c = getCategoryConfig('document_editor');
    expect(c.regions.length).toBeGreaterThan(0);
    expect(c.notes.length).toBeGreaterThan(0);
    expect(c.commonPatterns).toContain('canvas_editing');
  });

  it('ai_chat returns config', () => {
    const c = getCategoryConfig('ai_chat');
    expect(c.regions).toContain('input');
    expect(c.commonPatterns).toContain('single_field_focused');
  });

  it('unknown app → web_generic (no crash)', () => {
    const c = getCategoryConfig('unknown_app_xyz');
    expect(c.regions).toEqual([]);
    // web_generic has commonPatterns
    expect(c.commonPatterns.length).toBeGreaterThan(0);
  });

  it('null category → web_generic (no crash)', () => {
    const c = getCategoryConfig(null);
    expect(c.commonPatterns.length).toBeGreaterThan(0);
  });

  it('empty string → web_generic (no crash)', () => {
    const c = getCategoryConfig('');
    expect(c.commonPatterns.length).toBeGreaterThan(0);
  });

  it('getKnownCategories returns non-empty array', () => {
    const cats = getKnownCategories();
    expect(cats.length).toBeGreaterThan(10);
    expect(cats).toContain('web_generic');
    expect(cats).toContain('document_editor');
    expect(cats).toContain('ai_chat');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. DEEP LINK TYPE IN STATE PATTERN
// ════════════════════════════════════════════════════════════════════════════

describe('Deep link type propagation', () => {

  it('state pattern result includes deepLinkType', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://notion.new',
      fillableCount: 1,
      goal: 'create a page',
    });
    expect(r.deepLinkType).toBe('creation');
  });

  it('search URL propagates deepLinkType=search', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://example.com/search?q=test',
      goal: 'read the results',
      fillableCount: 0,
    });
    expect(r.deepLinkType).toBe('search');
  });

  it('generic URL → deepLinkType=none', () => {
    const r = classifyStatePattern({
      currentUrl: 'https://example.com/',
      goal: 'do something',
    });
    expect(r.deepLinkType).toBe('none');
  });
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`  RESULTS: ${_passed} passed, ${_failed} failed`);
console.log(`${'═'.repeat(70)}`);

if (_failures.length > 0) {
  console.log('\nFailures:');
  for (const f of _failures) {
    console.log(`  ❌ ${f.label}: ${f.error}`);
  }
}

process.exit(_failed > 0 ? 1 : 0);

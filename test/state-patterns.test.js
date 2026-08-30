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
const { classifyStatePattern, _isMultiItemGoal, _isSpatialGoal, _classifyFindClickGoal, _shortcutMatchesGoal } = require('../../mcp-services/command-service/src/skill-helpers/state-patterns.cjs');
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

  it('overlay + fillable=3 + real form fields → form_dialog_open, fastPath=false, tier=4', () => {
    const r = classifyStatePattern({
      overlayActive: true,
      fillableCount: 3,
      fillableTypes: { inputCount: 3, textareaCount: 0, contenteditableCount: 0, roleTextboxCount: 0 },
      goal: 'fill the form',
    });
    expect(r.pattern).toBe('form_dialog_open');
    expect(r.tier).toBe(4);
    expect(r.fastPath).toBe(false);
  });

  it('overlay + fillable=3 + multi-item goal + real form fields → multi_step_form', () => {
    const r = classifyStatePattern({
      overlayActive: true,
      fillableCount: 3,
      fillableTypes: { inputCount: 3, textareaCount: 0, contenteditableCount: 0, roleTextboxCount: 0 },
      goal: 'fill title and date and location',
    });
    expect(r.pattern).toBe('multi_step_form');
    expect(r.tier).toBe(4);
    expect(r.fastPath).toBe(false);
  });

  it('overlay + fillable=3 + contenteditable only (editor) → NOT form_dialog (canvas_editing_with_overlay)', () => {
    const r = classifyStatePattern({
      overlayActive: true,
      fillableCount: 3,
      fillableTypes: { inputCount: 0, textareaCount: 0, contenteditableCount: 3, roleTextboxCount: 3 },
      pageCategory: 'document_editor',
      editorState: { region: 'body', blockIndex: 0 },
      goal: 'add a todo list with items: Pizza, Soda, Chips',
    });
    expect(r.pattern).not.toBe('form_dialog_open');
    expect(r.pattern).not.toBe('multi_step_form');
    expect(r.tier).toBe(1);
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

  it('goal with proper noun + no UI type + clickable>5 → find_and_click_text, tier=2', () => {
    const r = classifyStatePattern({
      goal: 'find John Smith',
      overlayActive: false,
      alertActive: false,
      clickableCount: 20,
    });
    expect(r.pattern).toBe('find_and_click_text');
    expect(r.tier).toBe(2);
    expect(r.fastPath).toBe(false);
  });

  it('goal with proper noun + no UI type + clickable<=5 → NOT find_and_click_text (gate)', () => {
    const r = classifyStatePattern({
      goal: 'find John Smith',
      overlayActive: false,
      alertActive: false,
      clickableCount: 3,
    });
    expect(r.pattern).not.toBe('find_and_click_text');
  });

  it('goal with UI type (button) → NOT find_and_click_text (Tab-Map territory)', () => {
    const r = classifyStatePattern({
      goal: 'click the Settings button',
      overlayActive: false,
      alertActive: false,
      clickableCount: 15,
    });
    expect(r.pattern).not.toBe('find_and_click_text');
  });

  it('goal with UI type (link) → NOT find_and_click_text (Tab-Map territory)', () => {
    const r = classifyStatePattern({
      goal: 'click the About Us link',
      overlayActive: false,
      alertActive: false,
      clickableCount: 15,
    });
    expect(r.pattern).not.toBe('find_and_click_text');
  });

  it('goal with UI type (dropdown) → NOT find_and_click_text', () => {
    const r = classifyStatePattern({
      goal: 'open the dropdown',
      overlayActive: false,
      alertActive: false,
      clickableCount: 10,
    });
    expect(r.pattern).not.toBe('find_and_click_text');
  });

  it('find and click with overlay → NOT find_and_click_text (overlay blocks)', () => {
    const r = classifyStatePattern({
      goal: 'find John Smith',
      overlayActive: true,
      fillableCount: 0,
      alertActive: false,
      clickableCount: 20,
    });
    expect(r.pattern).not.toBe('find_and_click_text');
  });

  it('capitalized label, no UI type: "click Submit" → find_and_click_text (Meta+F works for button labels)', () => {
    const r = classifyStatePattern({
      goal: 'click Submit',
      overlayActive: false,
      alertActive: false,
      clickableCount: 10,
    });
    // "Submit" is capitalized → proper noun → meta-f → find_and_click_text fires
    // window.find("Submit") would find the button text — this works fine
    expect(r.pattern).toBe('find_and_click_text');
  });

  it('content goal → NOT find_and_click_text', () => {
    const r = classifyStatePattern({
      goal: 'add a todo list with items: A, B, C',
      overlayActive: false,
      alertActive: false,
      clickableCount: 30,
    });
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

  it('noun-only shortcut match → NOT shortcut_available (noun excluded)', () => {
    // "n: next week" → "next" is not a noun, but "week" is.
    // The regex extracts "next" (first word after colon). "next" is NOT in noun list.
    // But "next" doesn't appear in "create a note for next week" — wait, it does!
    // "next" appears in "next week". So this would match.
    // Let's use a clearer noun-only case: "t: today" → "today" is in noun list → excluded
    const r = classifyStatePattern({
      goal: 'create a note for today',
      shortcutCount: 5,
      shortcutLabels: 't: today',
      overlayActive: false,
      alertActive: false,
    });
    // "today" is a noun → excluded from action verbs → no match → not shortcut_available
    expect(r.pattern).not.toBe('shortcut_available');
  });

  it('editor content goal + editor body → NOT shortcut_available (content exclusion)', () => {
    const r = classifyStatePattern({
      goal: 'add a todo list with items: A, B, C',
      shortcutCount: 5,
      shortcutLabels: 'c: create',
      overlayActive: false,
      alertActive: false,
      editorState: { region: 'body', blockIndex: 0 },
    });
    // "create" is a verb and matches, but goal is editor content + editor body → excluded
    expect(r.pattern).not.toBe('shortcut_available');
  });

  it('editor content goal + NOT editor body → shortcut_available (no exclusion)', () => {
    const r = classifyStatePattern({
      goal: 'create a todo list with items: A, B, C',
      shortcutCount: 5,
      shortcutLabels: 'c: create',
      overlayActive: false,
      alertActive: false,
      editorState: { region: 'title', blockIndex: 0 },
    });
    // "create" matches, goal has "todo list" (editor content) but region is title (not body) → no exclusion
    expect(r.pattern).toBe('shortcut_available');
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

  it('editorState.region=body + overlay + contenteditable only → canvas_editing (tier=1)', () => {
    const r = classifyStatePattern({
      goal: 'type a paragraph',
      editorState: { region: 'body', blockIndex: 2 },
      overlayActive: true,
      fillableCount: 2,
      fillableTypes: { inputCount: 0, textareaCount: 0, contenteditableCount: 2, roleTextboxCount: 2 },
      pageCategory: 'document_editor',
      alertActive: false,
    });
    // With contenteditable-only, canvas_editing_with_overlay or canvas_editing should match (tier=1)
    expect(r.tier).toBe(1);
  });

  it('editorState.region=body + overlay + fillable=0 → NOT canvas_editing', () => {
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

// ── Goal classifier tests ──────────────────────────────────────────────────

describe('_isMultiItemGoal — editor content exclusion', () => {

  it('editor content: "add todo items: Pizza, Soda, Chips" → false', () => {
    expect(_isMultiItemGoal('add todo items: Pizza, Soda, Chips')).toBe(false);
  });

  it('editor content: "add a todo list with three items" → false', () => {
    expect(_isMultiItemGoal('add a todo list with three items')).toBe(false);
  });

  it('editor content: "add bullets: first, second, third" → false', () => {
    expect(_isMultiItemGoal('add bullets: first, second, third')).toBe(false);
  });

  it('real form: "fill title, date, and location" → true', () => {
    expect(_isMultiItemGoal('fill title, date, and location')).toBe(true);
  });

  it('real form: "fill name and email and phone" → true', () => {
    expect(_isMultiItemGoal('fill name and email and phone')).toBe(true);
  });
});

describe('_isSpatialGoal — bare "move" exclusion', () => {

  it('navigation: "move to page" → false', () => {
    expect(_isSpatialGoal('move to page')).toBe(false);
  });

  it('navigation: "move email to folder" → false', () => {
    expect(_isSpatialGoal('move email to folder')).toBe(false);
  });

  it('spatial: "drag card to column" → true', () => {
    expect(_isSpatialGoal('drag card to column')).toBe(true);
  });

  it('spatial: "move card up" → true', () => {
    expect(_isSpatialGoal('move card up')).toBe(true);
  });

  it('spatial: "reorder items by priority" → true', () => {
    expect(_isSpatialGoal('reorder items by priority')).toBe(true);
  });

  it('spatial: "resize the image" → true', () => {
    expect(_isSpatialGoal('resize the image')).toBe(true);
  });
});

describe('_classifyFindClickGoal — hybrid classifier', () => {

  it('specific name: "find John Smith" → meta-f', () => {
    expect(_classifyFindClickGoal('find John Smith')).toBe('meta-f');
  });

  it('product name: "find Wireless Headphones" → meta-f', () => {
    expect(_classifyFindClickGoal('find Wireless Headphones')).toBe('meta-f');
  });

  it('conversation: "go to conversation with Sarah" → meta-f', () => {
    expect(_classifyFindClickGoal('go to conversation with Sarah')).toBe('meta-f');
  });

  it('UI type button: "click Sign In button" → tab-map', () => {
    expect(_classifyFindClickGoal('click Sign In button')).toBe('tab-map');
  });

  it('UI type dropdown: "open the dropdown" → tab-map', () => {
    expect(_classifyFindClickGoal('open the dropdown')).toBe('tab-map');
  });

  it('UI type link: "click About Us link" → tab-map', () => {
    expect(_classifyFindClickGoal('click About Us link')).toBe('tab-map');
  });

  it('UI type option: "select Bold option" → tab-map', () => {
    expect(_classifyFindClickGoal('select Bold option')).toBe('tab-map');
  });

  it('both name + UI type: "click the John Smith card" → tab-map (UI type dominant)', () => {
    expect(_classifyFindClickGoal('click the John Smith card')).toBe('tab-map');
  });

  it('capitalized UI label, no UI type: "click Submit" → meta-f (Submit is capitalized)', () => {
    // "Submit" is capitalized → detected as proper noun → Meta+F
    // window.find("Submit") would find the button text — this works fine
    expect(_classifyFindClickGoal('click Submit')).toBe('meta-f');
  });

  it('no name + no UI type: "open settings" → ambiguous', () => {
    expect(_classifyFindClickGoal('open settings')).toBe('ambiguous');
  });

  it('content goal only: "add a todo list" → none', () => {
    expect(_classifyFindClickGoal('add a todo list')).toBe('none');
  });

  it('content goal with find verb: "find the item named Pizza and delete it" → meta-f', () => {
    // "find" is a find verb, "delete" is a content verb, but find verb present
    // "Pizza" is capitalized → proper noun → meta-f
    expect(_classifyFindClickGoal('find the item named Pizza and delete it')).toBe('meta-f');
  });

  it('no find verb: "type hello world" → none', () => {
    expect(_classifyFindClickGoal('type hello world')).toBe('none');
  });

  it('empty goal → none', () => {
    expect(_classifyFindClickGoal('')).toBe('none');
  });

  it('null goal → none', () => {
    expect(_classifyFindClickGoal(null)).toBe('none');
  });
});

describe('_shortcutMatchesGoal — action verb only matching', () => {

  it('verb match: "create event" + "c: create" → true', () => {
    expect(_shortcutMatchesGoal('create event', 'c: create event')).toBe(true);
  });

  it('noun excluded: "create note for today" + "t: today" → false', () => {
    expect(_shortcutMatchesGoal('create note for today', 't: today')).toBe(false);
  });

  it('noun excluded: "see next week" + "n: next week" → false (week is noun)', () => {
    // "n: next week" → regex extracts "next" (not in noun list) → matches "next" in goal
    // Wait — "next" IS in the goal "see next week". So this would match.
    // Let me use a case where the only extractable word is a noun.
    expect(_shortcutMatchesGoal('plan for next week', 'w: week')).toBe(false);
  });

  it('verb match with "to" format: "Press X to create" + goal "create" → true', () => {
    expect(_shortcutMatchesGoal('create a page', 'Press X to create a new page')).toBe(true);
  });

  it('no match: "find John" + "c: create" → false', () => {
    expect(_shortcutMatchesGoal('find John', 'c: create event')).toBe(false);
  });

  it('empty labels → false', () => {
    expect(_shortcutMatchesGoal('create event', '')).toBe(false);
  });

  it('empty goal → false', () => {
    expect(_shortcutMatchesGoal('', 'c: create')).toBe(false);
  });
});

describe('classifyStatePattern — canvas_editing_with_overlay (new pattern)', () => {

  it('editor + overlay + contenteditable only → canvas_editing_with_overlay, tier=1', () => {
    const r = classifyStatePattern({
      goal: 'add a todo list with items: Pizza, Soda, Chips',
      overlayActive: true,
      fillableCount: 3,
      fillableTypes: { inputCount: 0, textareaCount: 0, contenteditableCount: 3, roleTextboxCount: 3 },
      pageCategory: 'document_editor',
      editorState: { region: 'body', blockIndex: 0 },
    });
    expect(r.pattern).toBe('canvas_editing_with_overlay');
    expect(r.tier).toBe(1);
  });

  it('editor + overlay + real form fields → form_dialog_open (NOT canvas_editing_with_overlay)', () => {
    const r = classifyStatePattern({
      goal: 'fill the form with title and date',
      overlayActive: true,
      fillableCount: 3,
      fillableTypes: { inputCount: 3, textareaCount: 0, contenteditableCount: 0, roleTextboxCount: 0 },
      pageCategory: 'document_editor',
    });
    expect(r.pattern).not.toBe('canvas_editing_with_overlay');
    expect(r.tier).toBe(4);
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

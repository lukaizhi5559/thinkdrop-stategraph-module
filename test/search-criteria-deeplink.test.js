'use strict';
/**
 * search-criteria-deeplink.test.js
 *
 * Regression tests for the "try again" follow-up deep-link bug.
 *
 * Root cause: preflightAgents injects "(Context from prior turn: X)" into the
 * task string for follow-ups. browser.agent._isSearchCriteriaTask ran
 * _stripTaskNoise which DELETES that marker — so "try again" saw no criteria
 * and the search-criteria URL path (is:unread from:X) was skipped. Meanwhile
 * extractServiceSearchTerm read the RAW string and leaked the wrapper's ")"
 * into the generic site-search URL → "#search/unread emails from Pastor
 * Wendal)" → Gmail "no results" page → slow dom.act UI-driven search.
 *
 * Fix: criteria detection/extraction evaluate the structured
 * taskClassification.followUpTarget (or the context clause as fallback);
 * extractServiceSearchTerm strips unbalanced trailing closers/quotes.
 *
 * Run with: node test/search-criteria-deeplink.test.js
 */

let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}\n  ${label}\n${'─'.repeat(70)}`);
  fn();
}
function it(label, fn) {
  try { fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push({ label, error: e.message }); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function expect(actual) {
  return {
    toBe(exp) { if (actual !== exp) throw new Error(`Expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual)}`); },
    toContain(s) { if (!String(actual).includes(s)) throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s) { if (String(actual).includes(s)) throw new Error(`Expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(s)}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeNull() { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
  };
}

const { extractServiceSearchTerm } = require('../../mcp-services/command-service/src/skill-helpers/site-search.cjs');
const { _CLASSIFY_PROMPT } = require('../src/utils/localPlanTemplates.js');
const ba = require('../../mcp-services/command-service/src/skills/browser.agent.cjs');

const FOLLOWUP_TASK = 'try again\n\n(Context from prior turn: Check my Gmail for unread emails from Pastor Wendal)';
const FOLLOWUP_CLS = {
  isFollowUp: true,
  followUpTarget: 'Check my Gmail for unread emails from Pastor Wendal',
  interactiveActions: ['read_account'],
};

describe('_isSearchCriteriaTask — follow-up context', () => {
  it('bare "try again" + classification.followUpTarget → criteria task', () => {
    expect(ba._isSearchCriteriaTask('try again', FOLLOWUP_CLS)).toBe(true);
  });
  it('marker-injected task + classification → criteria task', () => {
    expect(ba._isSearchCriteriaTask(FOLLOWUP_TASK, FOLLOWUP_CLS)).toBe(true);
  });
  it('marker-injected task, no classification → criteria via context-clause fallback', () => {
    expect(ba._isSearchCriteriaTask(FOLLOWUP_TASK)).toBe(true);
  });
  it('plain task with criteria → still true', () => {
    expect(ba._isSearchCriteriaTask('Check my Gmail for unread emails from pastor wendal')).toBe(true);
  });
  it('task without criteria → false', () => {
    expect(ba._isSearchCriteriaTask('open gmail')).toBe(false);
  });
  it('bare "try again" with no context at all → false', () => {
    expect(ba._isSearchCriteriaTask('try again')).toBe(false);
  });
  it('mutation classification still vetoes soft criteria', () => {
    const cls = { isFollowUp: true, followUpTarget: 'unread emails from Pastor Wendal', interactiveActions: ['send_email'] };
    expect(ba._isSearchCriteriaTask('forward it', cls)).toBe(false);
  });
});

describe('_extractSearchQueryRegex — deterministic extraction', () => {
  it('extracts gmail operators from natural language', () => {
    const r = ba._extractSearchQueryRegex('Check my Gmail for unread emails from Pastor Wendal', 'gmail');
    expect(r.hasCriteria).toBeTruthy();
    expect(r.query).toContain('is:unread');
    expect(r.query).toContain('from:Pastor Wendal');
  });
  it('no criteria → hasCriteria false', () => {
    expect(ba._extractSearchQueryRegex('open gmail', 'gmail').hasCriteria).toBeFalsy();
  });
});

describe('_followUpContextClause — marker parse', () => {
  it('extracts the injected referent', () => {
    expect(ba._followUpContextClause(FOLLOWUP_TASK)).toBe('Check my Gmail for unread emails from Pastor Wendal');
  });
  it('returns empty for tasks without the marker', () => {
    expect(ba._followUpContextClause('open gmail')).toBe('');
  });
});

describe('extractServiceSearchTerm — wrapper-punctuation sanitization', () => {
  it('strips the context-wrapper trailing ")" from captured query', () => {
    const q = extractServiceSearchTerm(FOLLOWUP_TASK, ['gmail', 'mail']);
    expect(q).toBe('unread emails from Pastor Wendal');
    expect(q).notToContain(')');
  });
  it('unquoted service search still works', () => {
    expect(extractServiceSearchTerm('search my gmail for vidangel', ['gmail', 'mail'])).toBe('vidangel');
  });
  it('strips surrounding quotes', () => {
    expect(extractServiceSearchTerm('find on github for "open issues"', ['github'])).toBe('open issues');
  });
  it('keeps balanced parens in legit queries', () => {
    expect(extractServiceSearchTerm('search amazon for (foo OR bar)', ['amazon'])).toBe('(foo OR bar)');
  });
  it('returns null when service not named', () => {
    expect(extractServiceSearchTerm('check the weather for storms', ['gmail'])).toBeNull();
  });
});

describe('_CLASSIFY_PROMPT — PRIOR TASK line', () => {
  it('includes PRIOR TASK CONTEXT when priorTask given', () => {
    const p = _CLASSIFY_PROMPT('try again', null, null, 'Check my Gmail for unread emails from Pastor Wendal');
    expect(p).toContain('PRIOR TASK CONTEXT');
    expect(p).toContain('Check my Gmail for unread emails from Pastor Wendal');
  });
  it('omits PRIOR TASK CONTEXT when no priorTask', () => {
    expect(_CLASSIFY_PROMPT('open gmail', null, null, null)).notToContain('PRIOR TASK CONTEXT');
  });
});

console.log(`\n${'─'.repeat(70)}\n  Results: ${_passed} passed, ${_failed} failed\n${'─'.repeat(70)}`);
if (_failures.length) { _failures.forEach(f => console.log(`  FAIL: ${f.label}`)); process.exit(1); }

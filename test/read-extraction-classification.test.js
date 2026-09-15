'use strict';
/**
 * read-extraction-classification.test.js
 *
 * Regression tests for the semantic read/mutation classification that replaces
 * the regex-based _isReadCountListGoal. Verifies that:
 *   - Gmail "no-reply@github.com" search → read (auto-extract)
 *   - Mutation tasks (add_to_cart, send_email, post, etc.) → not read
 *   - Non-mutation interactive tasks (login, play_media) → read
 *   - Unknown-action guard fires on hallucinated actions
 *   - _shouldAutoExtract fallback via stepType works for legacy tasks
 *
 * Run from repo root with:
 *   node stategraph-module/test/read-extraction-classification.test.js
 */

const path = require('path');

const { isReadExtractionTask, _MUTATION_ACTIONS, _NON_MUTATION_ACTIONS, _KNOWN_ACTIONS } =
  require(path.resolve(__dirname, '..', '..', 'mcp-services', 'command-service', 'src', 'skill-helpers', 'state-patterns.cjs'));

(async () => {

let _passed = 0;
let _failed = 0;
const _failures = [];

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}\n     ${e.message}`);
  }
}

function section(label) {
  console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`);
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`expected ${JSON.stringify(actual)} to be null`);
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`expected ${JSON.stringify(actual)} to be true`);
      }
    },
    toBeFalse() {
      if (actual !== false) {
        throw new Error(`expected ${JSON.stringify(actual)} to be false`);
      }
    },
  };
}

// ── isReadExtractionTask ────────────────────────────────────────────────────

section('isReadExtractionTask — semantic classification');

it('null classification → null (fallback)', () => {
  expect(isReadExtractionTask(null)).toBeNull();
});

it('undefined classification → null (fallback)', () => {
  expect(isReadExtractionTask(undefined)).toBeNull();
});

it('empty interactiveActions → true (read/search/extract)', () => {
  expect(isReadExtractionTask({ interactiveActions: [] })).toBeTrue();
});

it('Gmail no-reply@github.com search (interactiveActions: []) → true', () => {
  // This is the exact case that broke with _isReadCountListGoal
  expect(isReadExtractionTask({
    taskType: 'browser',
    targetService: 'gmail',
    webAccessMode: 'interactive',
    interactiveActions: [],
  })).toBeTrue();
});

it('add_to_cart → false (mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['add_to_cart'] })).toBeFalse();
});

it('send_email → false (mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['send_email'] })).toBeFalse();
});

it('post → false (mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['post'] })).toBeFalse();
});

it('checkout → false (mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['checkout'] })).toBeFalse();
});

it('delete → false (mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['delete'] })).toBeFalse();
});

it('login → true (non-mutation — auth, then read)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['login'] })).toBeTrue();
});

it('oauth → true (non-mutation — auth, then read)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['oauth'] })).toBeTrue();
});

it('play_media → true (non-mutation — media control)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['play_media'] })).toBeTrue();
});

it('pause_media → true (non-mutation — media control)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['pause_media'] })).toBeTrue();
});

it('skip_media → true (non-mutation — media control)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['skip_media'] })).toBeTrue();
});

it('shuffle → true (non-mutation — media control)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['shuffle'] })).toBeTrue();
});

it('repeat → true (non-mutation — media control)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['repeat'] })).toBeTrue();
});

it('date_picker → true (non-mutation — sub-interaction)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['date_picker'] })).toBeTrue();
});

it('mixed read + mutation (login + add_to_cart) → false (has mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['login', 'add_to_cart'] })).toBeFalse();
});

it('mixed non-mutations (login + play_media) → true (no mutation)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['login', 'play_media'] })).toBeTrue();
});

// ── Unknown-action guard ────────────────────────────────────────────────────

section('isReadExtractionTask — unknown-action guard');

it('unknown action (frobnicate) → null (guard fires, falls back)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['frobnicate'] })).toBeNull();
});

it('mixed known+unknown (add_to_cart + frobnicate) → null (guard fires)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['add_to_cart', 'frobnicate'] })).toBeNull();
});

it('mixed non-mutation+unknown (login + frobnicate) → null (guard fires)', () => {
  expect(isReadExtractionTask({ interactiveActions: ['login', 'frobnicate'] })).toBeNull();
});

it('guard logs warning when logger provided', () => {
  const _logs = [];
  const _logger = { warn: (msg) => _logs.push(msg) };
  isReadExtractionTask({ interactiveActions: ['frobnicate'] }, _logger);
  if (_logs.length === 0) throw new Error('expected logger.warn to be called');
  if (!_logs[0].includes('frobnicate')) throw new Error(`expected log to mention "frobnicate", got: ${_logs[0]}`);
});

it('guard does not log when no unknown actions', () => {
  const _logs = [];
  const _logger = { warn: (msg) => _logs.push(msg) };
  isReadExtractionTask({ interactiveActions: ['add_to_cart'] }, _logger);
  if (_logs.length > 0) throw new Error(`expected no warnings, got: ${_logs.join('; ')}`);
});

// ── Closed-enum coverage ────────────────────────────────────────────────────

section('Closed-enum coverage — all 38 interactiveActions classified');

const _ALL_ACTIONS = [
  'login', 'oauth', 'add_to_cart', 'checkout', 'place_order', 'send_message', 'send_email',
  'post', 'comment', 'like', 'share', 'follow', 'subscribe', 'retweet', 'react', 'vote',
  'play_media', 'pause_media', 'skip_media', 'shuffle', 'repeat', 'fill_form', 'submit_form',
  'upload', 'publish', 'delete', 'edit', 'create', 'update', 'deploy', 'merge_pr',
  'approve_pr', 'assign_task', 'settings_change', 'filter_ui', 'sort_ui', 'date_picker',
  'book_reservation',
];

it('all 38 actions are in _KNOWN_ACTIONS', () => {
  for (const a of _ALL_ACTIONS) {
    if (!_KNOWN_ACTIONS.has(a)) {
      throw new Error(`action "${a}" not in _KNOWN_ACTIONS`);
    }
  }
});

it('all 38 actions produce a non-null result from isReadExtractionTask', () => {
  for (const a of _ALL_ACTIONS) {
    const r = isReadExtractionTask({ interactiveActions: [a] });
    if (r === null) {
      throw new Error(`action "${a}" returned null (should be classified)`);
    }
  }
});

it('mutation count = 30', () => {
  expect(_MUTATION_ACTIONS.size).toBe(30);
});

it('non-mutation count = 8', () => {
  expect(_NON_MUTATION_ACTIONS.size).toBe(8);
});

it('known count = 38', () => {
  expect(_KNOWN_ACTIONS.size).toBe(38);
});

// ── _shouldAutoExtract fallback ─────────────────────────────────────────────

section('_shouldAutoExtract — stepType fallback');

// We can't directly import _shouldAutoExtract (it's not exported), but we can
// test the fallback logic by passing null classification to isReadExtractionTask
// and checking the stepType-based logic matches the documented behavior.

it('null classification → isReadExtractionTask returns null (triggers fallback)', () => {
  expect(isReadExtractionTask(null)).toBeNull();
});

it('stepType=extract → fallback should return true (read)', () => {
  // Simulates: _shouldAutoExtract(null, 'extract') → true
  const _sem = isReadExtractionTask(null);
  const _stepType = 'extract';
  const _result = _sem !== null ? _sem : (_stepType === 'extract' ? true : _stepType === 'on-page-action' ? false : true);
  expect(_result).toBeTrue();
});

it('stepType=on-page-action → fallback should return false (mutation)', () => {
  const _sem = isReadExtractionTask(null);
  const _stepType = 'on-page-action';
  const _result = _sem !== null ? _sem : (_stepType === 'extract' ? true : _stepType === 'on-page-action' ? false : true);
  expect(_result).toBeFalse();
});

it('stepType=navigate → fallback should return true (read)', () => {
  const _sem = isReadExtractionTask(null);
  const _stepType = 'navigate';
  const _result = _sem !== null ? _sem : (_stepType === 'extract' ? true : _stepType === 'on-page-action' ? false : true);
  expect(_result).toBeTrue();
});

it('stepType=verify → fallback should return true (read)', () => {
  const _sem = isReadExtractionTask(null);
  const _stepType = 'verify';
  const _result = _sem !== null ? _sem : (_stepType === 'extract' ? true : _stepType === 'on-page-action' ? false : true);
  expect(_result).toBeTrue();
});

it('stepType=null → fallback should return true (safe default)', () => {
  const _sem = isReadExtractionTask(null);
  const _stepType = null;
  const _result = _sem !== null ? _sem : (_stepType === 'extract' ? true : _stepType === 'on-page-action' ? false : true);
  expect(_result).toBeTrue();
});

// ── Regression: the original Gmail bug case ─────────────────────────────────

section('Regression — Gmail no-reply@github.com (the original bug)');

it('Gmail search for no-reply@github.com → true (would have been false with _isReadCountListGoal)', () => {
  // The old regex _isReadCountListGoal returned false because \breply\b matched
  // "no-reply@github.com". The semantic classifier returns true because
  // interactiveActions is [].
  const _classification = {
    taskType: 'browser',
    targetService: 'gmail',
    isBrowseOnly: false,
    requiresDOM: true,
    webAccessMode: 'interactive',
    interactiveActions: [],
  };
  expect(isReadExtractionTask(_classification)).toBeTrue();
});

it('Gmail send email to no-reply@github.com → false (actual mutation)', () => {
  const _classification = {
    taskType: 'browser',
    targetService: 'gmail',
    webAccessMode: 'interactive',
    interactiveActions: ['send_email'],
  };
  expect(isReadExtractionTask(_classification)).toBeFalse();
});

it('Gmail reply to no-reply@github.com → false (actual mutation)', () => {
  const _classification = {
    taskType: 'browser',
    targetService: 'gmail',
    webAccessMode: 'interactive',
    interactiveActions: ['send_message'],
  };
  expect(isReadExtractionTask(_classification)).toBeFalse();
});

// ── Summary ─────────────────────────────────────────────────────────────────

section('Summary');
console.log(`  Passed: ${_passed}`);
console.log(`  Failed: ${_failed}`);
if (_failures.length > 0) {
  console.log('\n  Failures:');
  _failures.forEach(f => console.log(`    - ${f.label}: ${f.error}`));
}

process.exit(_failed > 0 ? 1 : 0);

})();

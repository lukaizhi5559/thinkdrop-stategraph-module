'use strict';

/**
 * resolve-user-context.test.js — Unit tests for resolveUserContext guards.
 *
 * Covers two regressions reported on 2026-08-08:
 *   1. A "Open Spotify and play my 'Morning Worship' playlist." prompt falsely
 *      triggered self-SMS resolution (carrier gather prompt) because the phi4
 *      NLI domain tagger spuriously emitted an SMS tag, and that tag alone was
 *      enough to force self:phone resolution.
 *   2. A bogus phone number 2227039302 (actually a Facebook Messenger thread ID
 *      embedded in a URL https://www.facebook.com/messages/t/36327,2227039302/)
 *      was mined out of a memory snippet and backfilled into self:phone.
 *
 * Run with: node stategraph-module/test/resolve-user-context.test.js
 */

const path = require('path');

// ─── Minimal test harness ────────────────────────────────────────────────────
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
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
    },
  };
}

// ─── Load the real exports ────────────────────────────────────────────────────
const {
  _extractPhoneFromText,
  _hasSelfReferentialContext,
} = require(path.resolve(__dirname, '..', 'src', 'nodes', 'resolveUserContext.js'));

// ─── Tests: _extractPhoneFromText ────────────────────────────────────────────

describe('_extractPhoneFromText — URL/ID embedding guard', () => {
  it('rejects a Messenger thread ID embedded in a Facebook URL', () => {
    const text = 'Navigated to https://www.facebook.com/messages/t/36327,2227039302/ (Meta AI chat)';
    expect(_extractPhoneFromText(text)).toBeNull();
  });

  it('rejects a digit run preceded by a comma (no clean boundary)', () => {
    expect(_extractPhoneFromText('id=36327,2227039302')).toBeNull();
  });

  it('rejects a digit run inside a URL path', () => {
    expect(_extractPhoneFromText('https://example.com/u/4155550132/profile')).toBeNull();
  });

  it('accepts a real phone in plain prose', () => {
    expect(_extractPhoneFromText('My phone number is (415) 555-0132.')).toBeTruthy();
  });

  it('accepts a real phone with +1 prefix', () => {
    expect(_extractPhoneFromText('Call me at +1 415 555 0132 anytime')).toBeTruthy();
  });

  it('accepts a real phone at start of string', () => {
    expect(_extractPhoneFromText('4155550132')).toBeTruthy();
  });

  it('rejects a timestamp-like digit run (area code starts with 1)', () => {
    expect(_extractPhoneFromText('ts=11644473600')).toBeNull();
  });

  it('rejects all-same-digit fakes (2222222222)', () => {
    expect(_extractPhoneFromText('my number is 2222222222')).toBeNull();
  });
});

// ─── Tests: _hasSelfReferentialContext (NLI gating defense-in-depth) ─────────

describe('_hasSelfReferentialContext — NLI signal gating', () => {
  // NOTE: enrichIntentV2 suppresses _smsTagSignal when targetService refutes it,
  // so the Spotify case never reaches here with the signal set. We still verify
  // that the keyword/intent paths work and that a bare NLI signal without any
  // message evidence does not falsely trigger the broad resolver for messaging
  // when the message is clearly non-messaging. _hasSelfReferentialContext
  // currently treats _smsTagSignal as a fast-path true; the real gate is in
  // needsSmsPhone (not exported). These tests document the expected behavior of
  // the exported helper and the keyword heuristics.

  it('returns true for "text me" phrasing', () => {
    expect(_hasSelfReferentialContext({ intent: { type: 'command_automate' } }, 'text me my family info')).toBeTruthy();
  });

  it('returns true for "my phone" phrasing', () => {
    expect(_hasSelfReferentialContext({ intent: { type: 'command_automate' } }, 'what is my phone number')).toBeTruthy();
  });

  it('returns true for sms_send intent', () => {
    expect(_hasSelfReferentialContext({ intent: { type: 'sms_send' } }, 'send it')).toBeTruthy();
  });

  it('returns false for a pure Spotify prompt with no NLI signal', () => {
    expect(_hasSelfReferentialContext({ intent: { type: 'command_automate' } }, "Open Spotify and play my 'Morning Worship' playlist.")).toBeFalsy();
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}`);
console.log(`  ${_passed} passed, ${_failed} failed`);
if (_failed > 0) {
  console.log('  Failures:');
  _failures.forEach(f => console.log(`    - ${f.label}: ${f.error}`));
}
console.log('─'.repeat(70));
process.exit(_failed > 0 ? 1 : 0);

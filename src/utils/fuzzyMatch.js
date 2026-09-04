'use strict';

/**
 * fuzzyMatch.js — Shared Levenshtein distance + fuzzy string matching
 * for stategraph-module. The Levenshtein algorithm also exists in
 * command-service (instruction.runner.cjs, playwright.agent.cjs) but
 * those packages are independent and cannot share this module.
 */

/**
 * Levenshtein edit distance between two strings (1D-array optimization).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Fuzzy match: returns true if `token` likely refers to `name`.
 * Uses Levenshtein distance with a tiered threshold:
 *   - For short strings (≤ 6 chars, e.g. "gmail"): allow distance ≤ 2
 *     (handles transposition misspellings like "gmial" → "gmail" which
 *     count as 2 edits in standard Levenshtein)
 *   - For longer strings: distance < 30% of longer string length
 *     (same threshold as instruction.runner.cjs _fuzzyTextMatch)
 * @param {string} token — lowercase word from user message
 * @param {string} name — lowercase known service/agent name
 * @returns {boolean}
 */
function fuzzyMatch(token, name) {
  if (token === name) return true;
  if (!token || !name) return false;
  const longer = Math.max(token.length, name.length);
  const shorter = Math.min(token.length, name.length);
  if (shorter < longer * 0.5) return false; // length guard
  const dist = levenshtein(token, name);
  // Tiered threshold: short service names need more tolerance for transpositions
  const threshold = longer <= 6 ? 2 : longer * 0.3;
  return dist <= threshold;
}

module.exports = { levenshtein, fuzzyMatch };

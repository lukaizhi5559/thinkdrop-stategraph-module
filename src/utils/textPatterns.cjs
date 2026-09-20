'use strict';

// Resolves shared/text-patterns.cjs regardless of where this file lives:
//   - in-place dev:   <repo>/stategraph-module/src/utils  → <repo>/shared/
//   - synced package: node_modules/@thinkdrop/stategraph/src/utils → <repo>/shared/
//   - cwd fallback:   dev main process runs with cwd = repo root
// The rsync'd node_modules copy cannot reach ../../../shared/ (that resolves to
// node_modules/@thinkdrop/shared/), so require sites go through this shim.
const path = require('path');

const CANDIDATES = [
  path.resolve(__dirname, '../../../shared/text-patterns.cjs'),
  path.resolve(__dirname, '../../../../../shared/text-patterns.cjs'),
  path.resolve(process.cwd(), 'shared', 'text-patterns.cjs'),
];

let mod = null;
for (const p of CANDIDATES) {
  try { mod = require(p); break; } catch (_) {}
}
if (!mod) {
  throw new Error('Cannot locate shared/text-patterns.cjs (tried: ' + CANDIDATES.join(', ') + ')');
}

module.exports = mod;

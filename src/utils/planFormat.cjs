'use strict';

// Resolves shared/plan-format.cjs regardless of where this file lives:
//   - in-place dev:   <repo>/stategraph-module/src/utils  → <repo>/shared/
//   - synced package: node_modules/@thinkdrop/stategraph/src/utils → <repo>/shared/
//   - cwd fallback:   dev main process runs with cwd = repo root
// Same shim pattern as utils/textPatterns.cjs — the rsync'd node_modules copy
// cannot reach ../../../shared/ (resolves to node_modules/@thinkdrop/shared/).
const path = require('path');

const CANDIDATES = [
  path.resolve(__dirname, '../../../shared/plan-format.cjs'),
  path.resolve(__dirname, '../../../../../shared/plan-format.cjs'),
  path.resolve(process.cwd(), 'shared', 'plan-format.cjs'),
];

let mod = null;
for (const p of CANDIDATES) {
  try { mod = require(p); break; } catch (_) {}
}
if (!mod) {
  throw new Error('Cannot locate shared/plan-format.cjs (tried: ' + CANDIDATES.join(', ') + ')');
}

module.exports = mod;

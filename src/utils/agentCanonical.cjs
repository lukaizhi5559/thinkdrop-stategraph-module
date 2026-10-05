'use strict';

// Resolves shared/agent-canonical.cjs regardless of where this file lives.
// Same shim pattern as utils/planFormat.cjs / utils/textPatterns.cjs.
const path = require('path');

const CANDIDATES = [
  path.resolve(__dirname, '../../../shared/agent-canonical.cjs'),
  path.resolve(__dirname, '../../../../../shared/agent-canonical.cjs'),
  path.resolve(process.cwd(), 'shared', 'agent-canonical.cjs'),
];

let mod = null;
for (const p of CANDIDATES) {
  try { mod = require(p); break; } catch (_) {}
}
if (!mod) {
  throw new Error('Cannot locate shared/agent-canonical.cjs (tried: ' + CANDIDATES.join(', ') + ')');
}

module.exports = mod;

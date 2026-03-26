'use strict';

/**
 * resolveStepCredentials.js
 *
 * Resolves credential tokens and KEYTAR pointer values in skill-plan step args
 * before the step is dispatched to an MCP service.
 *
 * Two substitution layers:
 *
 *   Layer 1 — Template tokens: {{service:field}}
 *     e.g. { "action": "fill", "value": "{{gmail:username}}" }
 *     These are the canonical placeholder format that LLM-generated plans should use.
 *     Resolved by: deriving the KEYTAR key → reading macOS keychain directly.
 *
 *   Layer 2 — KEYTAR pointer values: "KEYTAR:<accountKey>"
 *     e.g. { "action": "fill", "value": "KEYTAR:GMAIL_EMAIL" }
 *     These are stored in the profile DB and need to be resolved to the actual secret.
 *     Resolved by: reading macOS keychain for -s thinkdrop -a <accountKey>.
 *
 * Security:
 *   - A deep CLONE of args is returned — the original step in skillPlan is NEVER mutated.
 *   - Resolved secrets MUST NOT be logged by callers.
 *   - Missing credentials (token not found in keychain) are LEFT AS-IS so the
 *     login sub-plan (which prepends ask_user steps) can still collect them.
 */

const { spawnSync } = require('child_process');

// Template token pattern: {{service:field}}  e.g. {{gmail:username}}, {{github:password}}
const TEMPLATE_TOKEN_RE = /\{\{([a-z0-9_.-]+):([a-z0-9_]+)\}\}/gi;

// Gathered-var token pattern: {{_varName}}  e.g. {{_2fa_code}}, {{_gathered_GMAIL_EMAIL}}
// These are resolved from state._gatheredVars (in-memory only, not keychain).
const GATHERED_VAR_TOKEN_RE = /\{\{(_[a-zA-Z0-9_]+)\}\}/g;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a secret from macOS keychain (thinkdrop service) synchronously.
 * Returns null if not found or on error.
 * NEVER logs the returned value.
 */
function readKeychain(accountKey) {
  if (!accountKey) return null;
  try {
    const r = spawnSync(
      'security',
      ['find-generic-password', '-s', 'thinkdrop', '-a', accountKey, '-w'],
      { encoding: 'utf8', timeout: 5000 }
    );
    if (r.status === 0) {
      const val = r.stdout.trim();
      return val.length > 0 ? val : null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a KEYTAR pointer value to its actual secret.
 * "KEYTAR:GMAIL_EMAIL" → read keychain for -a GMAIL_EMAIL
 * Returns the resolved secret, or the original value if it's not a KEYTAR pointer.
 */
function resolveKeytarPointer(value) {
  if (typeof value === 'string' && value.startsWith('KEYTAR:')) {
    const accountKey = value.slice('KEYTAR:'.length);
    return readKeychain(accountKey) || value; // fall back to the pointer string if not found
  }
  return value;
}

/**
 * Map a {{service:field}} token pair to the KEYTAR account key.
 *
 * Mirrors the deriveCredentialKeys() logic in buildLoginSubPlan.js so that
 * {{gmail:username}} resolves to GMAIL_EMAIL (same key that buildLoginSubPlan stores).
 */
function serviceFieldToKeytarKey(service, field) {
  const prefix = service.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  switch (field.toLowerCase()) {
    case 'username':
    case 'email':
    case 'user':
    case 'login':
      return `${prefix}_EMAIL`;
    case 'password':
    case 'pass':
    case 'pwd':
      return `${prefix}_PASSWORD`;
    case 'token':
    case 'api_key':
    case 'apikey':
      return `${prefix}_TOKEN`;
    case 'oauth_token':
      return `${prefix}_OAUTH_TOKEN`;
    default:
      return `${prefix}_${field.toUpperCase()}`;
  }
}

/**
 * Resolve all {{service:field}} tokens and {{_varName}} gathered-var tokens in a string.
 * Reads keychain for {{service:field}} tokens (cached per call via profileCache).
 * Reads gatheredVars map for {{_varName}} tokens.
 * Tokens with no resolved value are LEFT as-is.
 */
function resolveTokensInString(str, profileCache, gatheredVars) {
  // First: resolve {{_varName}} gathered-var tokens (fastest — in-memory)
  let result = str.replace(GATHERED_VAR_TOKEN_RE, (match, varName) => {
    const val = gatheredVars && gatheredVars[varName];
    return (val !== undefined && val !== null) ? String(val) : match;
  });
  // Second: resolve {{service:field}} keychain tokens
  result = result.replace(TEMPLATE_TOKEN_RE, (match, service, field) => {
    const keytarKey = serviceFieldToKeytarKey(service, field);
    if (profileCache[keytarKey] !== undefined) {
      return profileCache[keytarKey] || match;
    }
    const secret = readKeychain(keytarKey);
    profileCache[keytarKey] = secret;
    return secret || match;
  });
  return result;
}

/**
 * Deep-resolve all credential tokens and KEYTAR pointer refs in a value tree.
 * Returns a deep clone — input is never mutated.
 */
function resolveDeep(value, profileCache, gatheredVars) {
  if (typeof value === 'string') {
    // First: resolve {{_varName}} and {{service:field}} template tokens
    let resolved = resolveTokensInString(value, profileCache, gatheredVars);
    // Second: resolve KEYTAR: pointer values
    resolved = resolveKeytarPointer(resolved);
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveDeep(v, profileCache, gatheredVars));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveDeep(v, profileCache, gatheredVars);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve credential tokens and KEYTAR refs in a skill-plan step's args.
 *
 * Resolution order:
 *   1. {{_varName}} tokens  → state._gatheredVars (in-memory, collected by ask_user steps)
 *   2. {{service:field}}    → macOS keychain lookup
 *   3. KEYTAR:<key>         → macOS keychain lookup
 *
 * If an mcpAdapter is provided, also looks up credentials stored in the
 * user-memory profile DB (values starting with KEYTAR: are then resolved
 * via macOS keychain).
 *
 * @param {object}  step           Skill-plan step  { skill, args, ... }
 * @param {object}  [mcpAdapter]   MCP adapter for user-memory profile.get calls
 * @param {object}  [gatheredVars] state._gatheredVars (from ask_user steps)
 * @returns {Promise<object>}      Resolved args (deep clone, never the original)
 */
async function resolveStepCredentials(step, mcpAdapter, gatheredVars) {
  gatheredVars = gatheredVars || {};
  if (!step || !step.args || typeof step.args !== 'object') {
    return step?.args ?? {};
  }

  const profileCache = {};

  // Pre-fetch known service credentials from the profile DB (async, non-blocking).
  // This covers credentials stored as KEYTAR:<key> pointers in user-memory.
  // We infer the service from sessionId (e.g. 'gmail', 'github') or skip.
  if (mcpAdapter) {
    const sessionId  = (step.args.sessionId || '').toLowerCase();
    const serviceHint = sessionId.replace(/[^a-z0-9]/g, '');
    if (serviceHint && serviceHint !== 'default') {
      const prefix = serviceHint.toUpperCase();
      const keysToFetch = [
        `${prefix}_EMAIL`,
        `${prefix}_PASSWORD`,
        `${serviceHint}:username`,
        `${serviceHint}:password`,
      ];
      await Promise.all(keysToFetch.map(async (profileKey) => {
        try {
          const result = await mcpAdapter.callService('user-memory', 'profile.get', {
            key: profileKey,
          }, { timeoutMs: 2000 });
          if (result?.value) {
            // Resolve KEYTAR pointer to actual secret
            const secret = resolveKeytarPointer(result.value);
            if (secret && !secret.startsWith('KEYTAR:')) {
              // Normalise both forms into the cache
              profileCache[profileKey] = secret;
              const altKey = profileKey.toUpperCase().replace(/[^A-Z0-9]/g, '_');
              profileCache[altKey] = secret;
            }
          }
        } catch (_) { /* profile.get failures are non-fatal */ }
      }));
    }
  }

  return resolveDeep(step.args, profileCache, gatheredVars);
}

module.exports = {
  resolveStepCredentials,
  resolveKeytarPointer,
  readKeychain,
  serviceFieldToKeytarKey,
};

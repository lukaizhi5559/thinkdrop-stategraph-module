'use strict';

/**
 * credentialIntelligence.js
 *
 * Pre-scan a user message for known service names, then query the
 * user-memory MCP service for:
 *   1. Available credential refs (KEYTAR pointers) for those services
 *   2. Constraints that may block related actions
 *   3. CLI-managed OAuth services — identified from cli-registry.json so that
 *      planSkills.js never injects raw KEYTAR refs for them (e.g. github→gh,
 *      gcp→gcloud, azure→az all use OAuth tokens, not keychain secrets).
 *
 * Returns a credentialContext object that planSkills.js injects into the
 * LLM prompt.  Raw secrets are NEVER fetched here — only KEYTAR:<key> refs.
 *
 * The whole query has a hard 1.5 s timeout so it never slows down planning.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI registry loader — reads cli-registry.json on each call (no cache) so
// that entries written at runtime by skill-scout.cjs are immediately visible.
// The file is small (~10 KB) and this runs at most once per planning call.
// ---------------------------------------------------------------------------
function loadCliOAuthServices() {
  const result = {};
  try {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'mcp-services', 'command-service', 'src', 'cli-registry.json');
      if (fs.existsSync(candidate)) {
        const registry = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        for (const [svcName, entry] of Object.entries(registry)) {
          for (const provider of Object.values(entry.providers || {})) {
            if (provider.authType === 'oauth' && provider.tool) {
              result[svcName] = {
                tool:     provider.tool,
                tokenCmd: provider.tokenCmd || null,
              };
            }
          }
        }
        break;
      }
      dir = path.dirname(dir);
    }
  } catch (_) {
    // Registry unreadable — fail silently, planSkills will fall back to an empty set
  }
  return result;
}

const SERVICE_PATTERNS = [
  { name: 'gmail',     pattern: /\b(gmail|google\s+mail|google\s+email|my\s+email|my\s+inbox|email\s+inbox)\b/i },
  { name: 'calendar',  pattern: /\b(google\s+calendar|g\s*cal|calendar|cal\s+invite|schedule\s+event)\b/i },
  { name: 'twitter',   pattern: /\b(twitter|tweet|x\.com)\b/i },
  { name: 'slack',     pattern: /\b(slack)\b/i },
  { name: 'discord',   pattern: /\b(discord)\b/i },
  { name: 'sms',       pattern: /\b(sms|text\s+message|text\s+me|send\s+a\s+text|clicksend|twilio|whatsapp)\b/i },
  { name: 'github',    pattern: /\b(github|git\s+hub)\b/i },
  { name: 'notion',    pattern: /\b(notion)\b/i },
  { name: 'airtable',  pattern: /\b(airtable)\b/i },
  { name: 'jira',      pattern: /\b(jira)\b/i },
  { name: 'spotify',   pattern: /\b(spotify)\b/i },
  { name: 'youtube',   pattern: /\b(youtube)\b/i },
  { name: 'openai',    pattern: /\b(openai|chatgpt|gpt-?[0-9])\b/i },
  { name: 'outlook',   pattern: /\b(outlook|microsoft\s+mail|hotmail)\b/i },
  { name: 'instagram', pattern: /\b(instagram|insta)\b/i },
  { name: 'linkedin',  pattern: /\b(linkedin)\b/i },
];

// ---------------------------------------------------------------------------
// Internal MCP call (fire-and-forget safe — all errors caught)
// ---------------------------------------------------------------------------
function callMCP(action, payload) {
  const port  = parseInt(process.env.USER_MEMORY_PORT || '3001', 10);
  const token = process.env.USER_MEMORY_TOKEN || '';

  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action,
      payload,
      requestId: `ci_${Date.now()}`,
    });

    const options = {
      hostname: '127.0.0.1',
      port,
      path:     `/${action}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(1200, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect services in userMessage and query the MCP for credential refs and constraints.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {boolean} [opts.skipMcp=false]  Skip MCP calls (unit-test / offline mode)
 * @param {object}  [opts.mcpAdapter]     Injected mcpAdapter (handles auth + envelope).
 *                                        Falls back to internal callMCP if not provided.
 * @returns {Promise<CredentialContext|null>}
 *
 * @typedef {object} CredentialContext
 * @property {string[]} detectedServices
 * @property {CredentialEntry[]} availableCredentials
 * @property {string[]} hardConstraints
 * @property {string[]} softConstraints
 *
 * @typedef {object} CredentialEntry
 * @property {string}  service
 * @property {string}  key
 * @property {string}  valueRef  — 'KEYTAR:<key>' or plain value
 * @property {boolean} sensitive
 * @property {string|null} label
 */
async function gatherCredentialIntelligence(userMessage, opts = {}) {
  const { skipMcp = false, mcpAdapter = null } = opts;
  const text = String(userMessage || '');

  // Prefer mcpAdapter.callService (handles auth + MCP envelope) when available;
  // fall back to the internal callMCP helper only when no adapter is injected.
  const mcpCall = mcpAdapter
    ? (action, payload) => mcpAdapter.callService('user-memory', action, payload, { timeoutMs: 1400 }).catch(() => null)
    : callMCP;

  // 1. Detect services
  const detectedServices = SERVICE_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);

  if (detectedServices.length === 0) return null;

  let availableCredentials = [];
  let hardConstraints      = [];
  let softConstraints      = [];

  if (!skipMcp) {
    // 2. Fetch credential refs for each detected service (parallel)
    const credLookups = await Promise.all(
      detectedServices.map(service =>
        mcpCall('profile.list', { service }).catch(() => null)
      )
    );

    for (let i = 0; i < detectedServices.length; i++) {
      const service  = detectedServices[i];
      const resp     = credLookups[i];
      const entries  = resp?.data?.entries || [];
      for (const e of entries) {
        availableCredentials.push({
          service,
          key:       e.key,
          valueRef:  e.valueRef,
          sensitive: e.sensitive,
          label:     e.label || null,
        });
      }
    }

    // 3. Check constraints for detected services + common login/signup actions
    const actionPatterns = [
      ...detectedServices.map(s => `${s}.*`),
      'signup.*',
      'login.*',
      'browser.act.*',
    ];

    const constraintResp = await mcpCall('constraint.check', { actionPatterns, message: text }).catch(() => null);
    if (constraintResp?.data) {
      hardConstraints = constraintResp.data.hardBlocks   || [];
      softConstraints = constraintResp.data.softWarnings || [];
    }
  }

  return {
    detectedServices,
    availableCredentials,
    hardConstraints,
    softConstraints,
    // CLI-managed OAuth services detected in this message.
    // Each entry: { service, tool, tokenCmd } where tokenCmd is the shell
    // command to obtain a token (e.g. "gh auth token").
    // planSkills.js uses this to filter KEYTAR injection and inject the
    // correct tokenCmd hint instead — no hardcoded service list needed.
    cliAuthServices: (() => {
      const oauthMap = loadCliOAuthServices();
      return detectedServices
        .filter(s => oauthMap[s])
        .map(s => ({ service: s, tool: oauthMap[s].tool, tokenCmd: oauthMap[s].tokenCmd }));
    })(),
  };
}

module.exports = { gatherCredentialIntelligence };

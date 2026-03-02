/**
 * installSkill Node — Installer Agent
 *
 * Takes a validated skill draft and:
 *   1. Detects any required secrets/config (API keys, tokens, etc.)
 *   2. If secrets needed and not yet collected → ASK_USER for each one
 *   3. Writes the .cjs file to ~/.thinkdrop/skills/<name>/index.cjs
 *   4. Detects third-party npm packages required by the skill code
 *   5. Writes a package.json to the skill dir and runs npm install there
 *   6. Stores secrets in macOS Keychain via keytar
 *   7. Registers the skill in the user-memory service DB
 *
 * Per-skill dependency isolation:
 *   Each skill gets its own ~/.thinkdrop/skills/<name>/package.json and
 *   node_modules/. Node's module resolution walks up from the skill file,
 *   so require('twilio') inside index.cjs finds the skill-local install
 *   automatically — no changes to the command-service process needed.
 *
 * State in:
 *   skillBuildDraft     — validated .cjs source
 *   skillBuildRequest   — { name, displayName, description, category }
 *   skillBuildSecrets   — { [key]: value } collected so far
 *   skillBuildAskQueue  — [{ key, label, hint }] remaining secrets to ask
 *   pendingQuestion     — set when ASK_USER is needed
 *
 * State out (needs secret):
 *   skillBuildPhase    — 'asking'
 *   pendingQuestion    — { question, options: [] }
 *   skillBuildAskQueue — remaining items
 *
 * State out (done):
 *   skillBuildPhase    — 'done'
 *   skillBuildInstalledPath — path to installed file
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const SKILLS_BASE_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

// ── Packages always available in command-service (no per-skill install needed) ─
const COMMAND_SERVICE_PROVIDED = new Set([
  'keytar', 'node-cron',
]);

// ── Node.js built-in module names (no install needed) ─────────────────────────
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'stream/promises',
  'string_decoder', 'timers', 'timers/promises', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

// ── Known package versions for skill deps ─────────────────────────────────────
const KNOWN_VERSIONS = {
  'twilio': '^5.0.0',
  'googleapis': '^144.0.0',
  'nodemailer': '^6.9.0',
  'axios': '^1.6.0',
  '@google-cloud/storage': '^7.0.0',
  'openai': '^4.0.0',
  'aws-sdk': '^2.1500.0',
  'slack-web-api': '^7.0.0',
  '@slack/web-api': '^7.0.0',
  'discord.js': '^14.0.0',
  'node-fetch': '^2.7.0',
  'cheerio': '^1.0.0',
  'puppeteer': '^22.0.0',
  'sharp': '^0.33.0',
  'uuid': '^9.0.0',
  'lodash': '^4.17.21',
  'moment': '^2.30.0',
  'date-fns': '^3.0.0',
  'dotenv': '^16.0.0',
};
const USER_MEMORY_URL = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
const USER_MEMORY_KEY = process.env.MCP_USER_MEMORY_API_KEY || 'k7F9qLp3XzR2vH8sT1mN4bC0yW6uJ5eQG4tY9bH2wQ6nM1vS8xR3cL5pZ0kF7uDe';

// ── Detect required secrets from draft code ───────────────────────────────────

// Derive human-readable service name from skill name or secret key
// Known aliases — used to produce clean display names and normalised service keys.
// This list does NOT gate anything — if no alias matches, the service name is
// extracted directly from the skill name or secret key so every service works.
const SERVICE_ALIASES = [
  { match: ['gmail', 'googleapis', 'google'],   name: 'Google' },
  { match: ['twilio'],                           name: 'Twilio' },
  { match: ['clicksend'],                        name: 'ClickSend' },
  { match: ['sendgrid'],                         name: 'SendGrid' },
  { match: ['mailgun'],                          name: 'Mailgun' },
  { match: ['stripe'],                           name: 'Stripe' },
  { match: ['openai'],                           name: 'OpenAI' },
  { match: ['slack'],                            name: 'Slack' },
  { match: ['discord'],                          name: 'Discord' },
  { match: ['github'],                           name: 'GitHub' },
  { match: ['aws', 'amazon'],                    name: 'AWS' },
  { match: ['azure'],                            name: 'Azure' },
  { match: ['notion'],                           name: 'Notion' },
  { match: ['linear'],                           name: 'Linear' },
  { match: ['jira', 'atlassian'],                name: 'Jira' },
  { match: ['confluence'],                       name: 'Confluence' },
  { match: ['salesforce'],                       name: 'Salesforce' },
  { match: ['hubspot'],                          name: 'HubSpot' },
  { match: ['airtable'],                         name: 'Airtable' },
  { match: ['asana'],                            name: 'Asana' },
  { match: ['trello'],                           name: 'Trello' },
  { match: ['monday'],                           name: 'Monday' },
  { match: ['clickup'],                          name: 'ClickUp' },
  { match: ['figma'],                            name: 'Figma' },
  { match: ['dropbox'],                          name: 'Dropbox' },
  { match: ['box'],                              name: 'Box' },
  { match: ['zoom'],                             name: 'Zoom' },
  { match: ['calendly'],                         name: 'Calendly' },
  { match: ['typeform'],                         name: 'Typeform' },
  { match: ['mailchimp'],                        name: 'Mailchimp' },
  { match: ['intercom'],                         name: 'Intercom' },
  { match: ['zendesk'],                          name: 'Zendesk' },
  { match: ['shopify'],                          name: 'Shopify' },
  { match: ['firebase'],                         name: 'Firebase' },
  { match: ['supabase'],                         name: 'Supabase' },
  { match: ['mongodb', 'mongo'],                 name: 'MongoDB' },
  { match: ['postgres', 'postgresql'],           name: 'PostgreSQL' },
  { match: ['mysql'],                            name: 'MySQL' },
  { match: ['redis'],                            name: 'Redis' },
  { match: ['heroku'],                           name: 'Heroku' },
  { match: ['netlify'],                          name: 'Netlify' },
  { match: ['vercel'],                           name: 'Vercel' },
  { match: ['fly', 'flyio'],                     name: 'Fly.io' },
  { match: ['gcloud', 'gcp'],                    name: 'GCP' },
  { match: ['digitalocean', 'doctl'],            name: 'DigitalOcean' },
  { match: ['cloudflare'],                       name: 'Cloudflare' },
  { match: ['terraform'],                        name: 'Terraform' },
  { match: ['kubernetes', 'kubectl'],            name: 'Kubernetes' },
  { match: ['docker'],                           name: 'Docker' },
  { match: ['anthropic', 'claude'],              name: 'Anthropic' },
  { match: ['cohere'],                           name: 'Cohere' },
  { match: ['replicate'],                        name: 'Replicate' },
  { match: ['huggingface'],                      name: 'HuggingFace' },
  { match: ['pinecone'],                         name: 'Pinecone' },
  { match: ['twitch'],                           name: 'Twitch' },
  { match: ['youtube'],                          name: 'YouTube' },
  { match: ['twitter', 'x_api', 'xapi'],         name: 'Twitter/X' },
  { match: ['instagram'],                        name: 'Instagram' },
  { match: ['linkedin'],                         name: 'LinkedIn' },
  { match: ['facebook', 'meta'],                 name: 'Meta' },
  { match: ['telegram'],                         name: 'Telegram' },
  { match: ['whatsapp'],                         name: 'WhatsApp' },
  { match: ['resend'],                           name: 'Resend' },
  { match: ['postmark'],                         name: 'Postmark' },
  { match: ['brevo', 'sendinblue'],              name: 'Brevo' },
  { match: ['plaid'],                            name: 'Plaid' },
  { match: ['paypal'],                           name: 'PayPal' },
  { match: ['square'],                           name: 'Square' },
];

function deriveServiceContext(skillName, secretKey) {
  const s = (skillName + ' ' + secretKey).toLowerCase().replace(/[_\-\.]/g, ' ');

  // Fast-path: check known aliases first
  for (const alias of SERVICE_ALIASES) {
    if (alias.match.some(m => s.includes(m))) return alias.name;
  }

  // Generic fallback: extract service name from the skill name itself.
  // e.g. 'notion-watcher' → 'Notion', 'linear_sync' → 'Linear',
  //      'CALENDAR_API_KEY' → 'Calendar', 'MY_CUSTOM_TOKEN' → null (too generic)
  const skillToken = (skillName || '').toLowerCase().replace(/[_\-\.]/g, ' ').trim();

  // Strip common suffixes to get the core service word
  const stripped = skillToken
    .replace(/\b(skill|watcher|monitor|sync|fetch|send|get|post|api|token|key|secret|service|agent|integration|connector|handler|worker|job|task|cron)\b/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)[0];

  if (stripped && stripped.length > 2) {
    // Capitalise first letter
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }

  // Last resort: try the secret key itself (e.g. NOTION_API_KEY → 'Notion')
  const keyToken = (secretKey || '').toLowerCase().replace(/_/g, ' ').split(' ')[0];
  if (keyToken && keyToken.length > 2 && !['api', 'key', 'secret', 'token', 'auth', 'pass', 'pwd'].includes(keyToken)) {
    return keyToken.charAt(0).toUpperCase() + keyToken.slice(1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM-driven secret detection
// Understands any keytar usage pattern: variable service names, computed keys,
// template literals, destructured calls — not just the hardcoded literal form.
// Falls back to regex for the common literal form if LLM unavailable.
// ---------------------------------------------------------------------------

function loadSecretDetectionPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/install-skill.md'), 'utf8').trim();
  } catch (_) {
    return 'You are a code analyzer. Find all keytar secrets in the code. Output ONLY a JSON array: [{ "key": "KEY_NAME", "service": "ServiceName", "required": true, "hint": "..." }]. Return [] if none found.';
  }
}

const SECRET_DETECTION_SYSTEM_PROMPT = loadSecretDetectionPrompt();

async function detectRequiredSecrets(code, skillName, llmBackend) {
  const secrets = [];

  // --- LLM-driven path (preferred) ---
  if (llmBackend) {
    try {
      const raw = await Promise.race([
        llmBackend.generateAnswer(code, {
          query: code,
          context: {
            conversationHistory: [],
            systemInstructions: SECRET_DETECTION_SYSTEM_PROMPT,
            intent: 'general_query',
          },
          options: { maxTokens: 600, temperature: 0.1, fastMode: true },
        }, { maxTokens: 600, temperature: 0.1, fastMode: true }, null),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
      ]);

      const text = (typeof raw === 'string' ? raw : '').trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const items = JSON.parse(match[0]);
        for (const item of items) {
          if (item.key && !secrets.find(s => s.key === item.key)) {
            const serviceContext = item.service || deriveServiceContext(skillName || '', item.key);
            secrets.push({
              key: item.key,
              label: item.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              serviceContext,
              hint: item.hint || (serviceContext
                ? `Your ${serviceContext} ${item.key.replace(/_/g, ' ').toLowerCase()}. Will be stored securely in macOS Keychain.`
                : `Required by the skill. Will be stored securely in macOS Keychain.`),
              required: item.required !== false,
            });
          }
        }
        if (secrets.length > 0) return secrets;
      }
    } catch (_) {
      logger.warn(`[Node:InstallSkill] LLM secret detection failed — falling back to regex`);
    }
  }

  // --- Regex fallback: handles the canonical literal pattern + broad keytar coverage ---
  // Pattern 1: keytar.getPassword('thinkdrop', 'skill:<name>:<KEY>')
  const re1 = /keytar\.getPassword\s*\(\s*['"]thinkdrop['"]\s*,\s*['"]skill:[^'"]+:([A-Z_a-z0-9]+)['"]\s*\)/g;
  let m;
  while ((m = re1.exec(code)) !== null) {
    const key = m[1].toUpperCase();
    if (!secrets.find(s => s.key === key)) {
      const serviceContext = deriveServiceContext(skillName || '', key);
      secrets.push({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        serviceContext,
        hint: serviceContext
          ? `Your ${serviceContext} ${key.replace(/_/g, ' ').toLowerCase()}. Will be stored securely in macOS Keychain.`
          : `Required by the skill. Will be stored securely in macOS Keychain.`,
        required: true,
      });
    }
  }

  // Pattern 2: keytar.getPassword(service, key) — any form
  const re2 = /keytar\.getPassword\s*\([^)]+\)/g;
  while ((m = re2.exec(code)) !== null) {
    // Already captured above if literal; skip if no new KEY found
    const inner = m[0];
    const keyMatch = inner.match(/['"`]([A-Z_]{4,})['"`]/);
    if (keyMatch) {
      const key = keyMatch[1];
      if (!secrets.find(s => s.key === key)) {
        const serviceContext = deriveServiceContext(skillName || '', key);
        secrets.push({ key, label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), serviceContext, hint: `Required by the skill. Will be stored in macOS Keychain.`, required: true });
      }
    }
  }

  // Pattern 3: process.env.XYZ used as credentials (common in LLM-generated code)
  const re3 = /process\.env\.([A-Z_]{4,}(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API|AUTH)[A-Z_]*)/g;
  while ((m = re3.exec(code)) !== null) {
    const key = m[1];
    if (!secrets.find(s => s.key === key)) {
      const serviceContext = deriveServiceContext(skillName || '', key);
      secrets.push({ key, label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), serviceContext, hint: `${key} environment variable (will be injected from Keychain). Will be stored securely.`, required: true });
    }
  }

  return secrets;
}

// ── Register skill in user-memory service ─────────────────────────────────────

function registerSkill({ name, description, execPath, execType = 'node' }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'skill.upsert',
      payload: { name, description, execPath, execType, enabled: true },
      context: {},
      requestId: `install-skill-${Date.now()}`,
    });

    const urlParsed = new URL(USER_MEMORY_URL);
    const options = {
      hostname: urlParsed.hostname,
      port: parseInt(urlParsed.port) || 3001,
      path: '/skill.upsert',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${USER_MEMORY_KEY}`,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: parsed?.status !== 'error', data: parsed });
        } catch (_) {
          resolve({ ok: false, error: 'Failed to parse registration response' });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    setTimeout(() => { req.destroy(); resolve({ ok: false, error: 'Registration timed out' }); }, 8000);
    req.write(body);
    req.end();
  });
}

// ── Store secret in macOS Keychain via keytar ─────────────────────────────────

async function storeSecret(skillName, key, value) {
  try {
    const keytar = require('keytar');
    await keytar.setPassword('thinkdrop', `skill:${skillName}:${key}`, value);
    return { ok: true };
  } catch (err) {
    logger.warn(`[Node:InstallSkill] keytar not available or failed: ${err.message}`);
    // Fallback: warn but don't block install — secret can be set later
    return { ok: false, error: err.message };
  }
}

// ── Write skill file ──────────────────────────────────────────────────────────

function writeSkillFile(skillName, code) {
  const skillDir = path.join(SKILLS_BASE_DIR, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'index.cjs');
  fs.writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

// ── Per-skill dependency detection and installation ───────────────────────────
// Each skill gets its own package.json + node_modules in its skill directory.
// Node's module resolution walks UP from the skill file, so require('twilio')
// in ~/.thinkdrop/skills/<name>/index.cjs finds
// ~/.thinkdrop/skills/<name>/node_modules/twilio automatically.

function detectSkillDeps(code) {
  const deps = {};
  // Match all require() calls with static string arguments
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const pkg = m[1];
    // Skip: Node built-ins, relative paths, command-service-provided packages
    if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
    // Strip subpath (e.g. 'googleapis/build/...' → 'googleapis')
    const root = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
    if (NODE_BUILTINS.has(root)) continue;
    if (COMMAND_SERVICE_PROVIDED.has(root)) continue;
    if (!deps[root]) {
      deps[root] = KNOWN_VERSIONS[root] || 'latest';
    }
  }
  return deps;
}

function installSkillDeps(skillDir, deps, logger) {
  return new Promise((resolve) => {
    const pkgPath = path.join(skillDir, 'package.json');

    // Write or merge package.json
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    const merged = {
      name: path.basename(skillDir),
      version: '1.0.0',
      private: true,
      ...existing,
      dependencies: { ...(existing.dependencies || {}), ...deps },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(merged, null, 2), 'utf8');

    const pkgList = Object.keys(deps);
    if (pkgList.length === 0) {
      logger.info('[Node:InstallSkill] No third-party deps to install');
      return resolve({ ok: true });
    }

    logger.info(`[Node:InstallSkill] Installing skill deps: ${pkgList.join(', ')}`);

    const child = spawn('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: skillDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'npm install timed out after 120s' });
    }, 125000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info(`[Node:InstallSkill] npm install succeeded for: ${pkgList.join(', ')}`);
        resolve({ ok: true });
      } else {
        const errMsg = stderr.slice(0, 500) || `npm install exited with code ${code}`;
        logger.warn(`[Node:InstallSkill] npm install failed: ${errMsg}`);
        resolve({ ok: false, error: errMsg });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

// ── Smoke test — require + invoke the skill in an isolated child process ───────

const SMOKE_TIMEOUT_MS = 10000;

function runSmokeTest(skillPath, logger) {
  return new Promise((resolve) => {
    // Inline script: require the skill, call it with { dryRun: true }, print JSON result
    const script = `
      (async () => {
        try {
          const skill = require(${JSON.stringify(skillPath)});
          const fn = typeof skill === 'function' ? skill : skill.default || skill.run;
          if (typeof fn !== 'function') {
            process.stdout.write(JSON.stringify({ ok: false, error: 'exports is not a function' }));
            process.exit(0);
          }
          const result = await Promise.race([
            fn({ dryRun: true }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]);
          process.stdout.write(JSON.stringify({ ok: true, output: typeof result === 'string' ? result : JSON.stringify(result) }));
        } catch (e) {
          // Distinguish missing-secret errors (expected) from real crashes
          const msg = e.message || String(e);
          const isMissingSecret = /not set|not configured|API key|keytar|getPassword/i.test(msg);
          process.stdout.write(JSON.stringify({ ok: isMissingSecret, error: msg, expected: isMissingSecret }));
        }
        process.exit(0);
      })();
    `;

    const child = spawn(process.execPath, ['-e', script], {
      timeout: SMOKE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'Smoke test timed out after 10s' });
    }, SMOKE_TIMEOUT_MS + 500);

    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        if (parsed.ok === false && parsed.expected) {
          // Missing secrets are expected before keys are stored — treat as pass
          resolve({ ok: true, output: 'Credential check OK (secrets not yet stored)' });
        } else {
          resolve(parsed);
        }
      } catch (_) {
        const errMsg = stderr.slice(0, 300) || stdout.slice(0, 300) || 'No output from smoke test';
        resolve({ ok: false, error: errMsg });
      }
    });
  });
}

// ── cli.agent silent credential resolver ──────────────────────────────────────

const COMMAND_SERVICE_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);

function callCommandService(skill, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ payload: { skill, args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: COMMAND_SERVICE_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve((JSON.parse(raw).data) || {}); }
        catch { resolve({}); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({}); });
    req.on('error', () => resolve({}));
    req.write(body);
    req.end();
  });
}

/**
 * Attempts to silently resolve a secret via cli.agent or browser.agent.
 * Returns:
 *   string  — resolved credential value (silent success)
 *   null    — could not resolve, caller should prompt user
 *   { hintOverride: string } — agent found context but needs user input with better hint
 * Never throws — always falls back gracefully.
 */
async function tryResolveViaCliAgent(secretItem, mcpAdapter, logger) {
  const { key, serviceContext } = secretItem;
  if (!serviceContext) return null;

  try {
    // Step 1: build agent if not yet registered (LLM-driven — handles any service)
    let queryResult = await callCommandService('cli.agent', {
      action: 'query_agent',
      service: serviceContext,
    }, 8000);

    if (!queryResult?.found) {
      logger.info(`[InstallSkill] No agent for "${serviceContext}" — building…`);
      const buildResult = await callCommandService('cli.agent', {
        action: 'build_agent',
        service: serviceContext,
      }, 25000);

      // If cli.agent signals this is an OAuth service, try browser.agent
      if (buildResult?.isOAuth || buildResult?.delegateTo === 'browser.agent') {
        logger.info(`[InstallSkill] "${serviceContext}" is OAuth — delegating to browser.agent`);
        const browserBuild = await callCommandService('browser.agent', {
          action: 'build_agent',
          service: serviceContext,
        }, 30000);

        if (browserBuild?.ok) {
          // browser.agent built a descriptor — update hint so user gets the right auth URL
          const descriptor = browserBuild.descriptor || '';
          const urlLine = descriptor.match(/start_url:\s*(.+)/);
          const authUrl = urlLine ? urlLine[1].trim() : null;
          if (authUrl) {
            return {
              hintOverride: `Authenticate with ${serviceContext} at ${authUrl}. Once logged in, the session is stored for future use.`,
            };
          }
        }
        return null;
      }

      // If cli.agent built an api_key-only descriptor, surface the URL from descriptor
      if (buildResult?.isApiKey && buildResult?.descriptor) {
        const urlLine = buildResult.descriptor.match(/api_key_url:\s*(.+)/);
        const apiUrl  = urlLine ? urlLine[1].trim() : null;
        if (apiUrl) {
          return {
            hintOverride: `Get your ${serviceContext} API key at: ${apiUrl}`,
          };
        }
        return null;
      }

      // Re-query after successful build
      if (buildResult?.ok && !buildResult?.needsInstall) {
        queryResult = await callCommandService('cli.agent', {
          action: 'query_agent',
          service: serviceContext,
        }, 8000);
      }
    }

    if (!queryResult?.found) return null;

    // For api_key-type agents (no CLI), return hintOverride with URL from descriptor
    if (queryResult?.type === 'api_key' || !queryResult?.cliTool) {
      const descriptor = queryResult?.descriptor || '';
      const urlLine = descriptor.match(/api_key_url:\s*(.+)/);
      const apiUrl  = urlLine ? urlLine[1].trim() : null;
      if (apiUrl) {
        return { hintOverride: `Get your ${serviceContext} API key at: ${apiUrl}` };
      }
      return null;
    }

    // Step 2: descriptor-driven token extraction
    const descriptor = queryResult?.descriptor || '';
    const tokenArgv  = getTokenArgvFromDescriptor(descriptor, serviceContext, key);
    if (!tokenArgv) {
      logger.info(`[InstallSkill] No tokenCmd for "${serviceContext}" — cannot extract silently`);
      return null;
    }

    const runResult = await callCommandService('cli.agent', {
      action: 'run',
      service: serviceContext,
      cli: queryResult?.cliTool,
      argv: tokenArgv,
      timeoutMs: 10000,
    }, 12000);

    if (!runResult?.ok || !runResult?.stdout?.trim()) return null;

    const extracted = parseTokenFromOutput(runResult.stdout, key, serviceContext);
    return extracted || null;
  } catch (err) {
    logger.info(`[InstallSkill] agent resolution failed for "${key}": ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Descriptor-driven token extraction
// Reads tokenCmd from the agent descriptor's front-matter instead of
// a hardcoded lookup table. Falls back to a universal heuristic parser.
// ---------------------------------------------------------------------------

function getTokenArgvFromDescriptor(descriptor, serviceContext, secretKey) {
  if (descriptor) {
    // Try to read tokenCmd from descriptor front-matter
    const tcMatch = descriptor.match(/token_cmd:\s*(.+)/);
    if (tcMatch) {
      try {
        const parsed = JSON.parse(tcMatch[1].trim());
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      // Handle YAML list format:
      // token_cmd:
      //   - auth
      //   - token
      const listItems = [];
      const listMatch = descriptor.match(/token_cmd:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (listMatch) {
        for (const line of listMatch[1].split('\n')) {
          const item = line.replace(/^\s+-\s+/, '').trim();
          if (item) listItems.push(item);
        }
        if (listItems.length) return listItems;
      }
    }
  }

  // Fallback: universal read-only token commands by service key
  const svc = (serviceContext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const UNIVERSAL_TOKEN_CMDS = {
    github:      ['auth', 'token'],
    aws:         ['sts', 'get-caller-identity'],
    stripe:      ['config', '--list'],
    heroku:      ['auth:token'],
    netlify:     ['status'],
    fly:         ['auth', 'token'],
    gcloud:      ['auth', 'print-access-token'],
    firebase:    ['login:ci'],
    vercel:      ['whoami'],
    doctl:       ['auth', 'token'],
    supabase:    ['status'],
    railway:     ['whoami'],
    doppler:     ['me', '--json'],
    shopify:     ['auth', 'whoami'],
    wrangler:    ['whoami'],
    neon:        ['whoami'],
    turso:       ['auth', 'whoami'],
    planetscale: ['auth', 'whoami'],
    kubectl:     ['config', 'current-context'],
  };
  return UNIVERSAL_TOKEN_CMDS[svc] || null;
}

// Universal token parser: tries common patterns across all services.
// Ordered from most-specific to most-general to avoid false positives.
function parseTokenFromOutput(stdout, secretKey, serviceContext) {
  const svc  = (serviceContext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const text = stdout.trim();
  if (!text) return null;

  // Service-specific parsers (high confidence)
  const SERVICE_PARSERS = {
    github:   t => { const m = t.match(/^(gh[ps]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/m); return m?.[1] || (t.length > 10 && !/\s/.test(t) ? t : null); },
    heroku:   t => t.length > 10 && !t.includes('\n') ? t.trim() : null,
    fly:      t => t.length > 10 && !t.includes('\n') ? t.trim() : null,
    stripe:   t => { const m = t.match(/(sk_(?:test|live)_[A-Za-z0-9]+)/); return m?.[1] || null; },
    aws:      t => { const key = t.match(/(?:AccessKeyId|access_key)(?:\s*[:=]\s*|\s+)(\w{16,})/i); const sec = t.match(/(?:SecretAccessKey|secret_key)(?:\s*[:=]\s*|\s+)([A-Za-z0-9/+=]{30,})/i); return secretKey?.toLowerCase().includes('secret') ? (sec?.[1] || null) : (key?.[1] || null); },
    gcloud:   t => t.match(/^ya29\.[A-Za-z0-9_-]+/m)?.[0] || t.slice(0, 200).trim() || null,
    firebase: t => t.match(/([A-Za-z0-9_-]{100,})/)?.[1] || null,
    vercel:   t => t.match(/(\S+@\S+\.\S+)/)?.[1] || null,  // whoami returns email
    netlify:  t => { const m = t.match(/Logged in as\s+(\S+)/i); return m?.[1] || null; },
    doppler:  t => { try { return JSON.parse(t)?.token || null; } catch { return null; } },
    railway:  t => t.match(/([A-Za-z0-9_-]{20,})/)?.[1] || null,
    doctl:    t => t.match(/([A-Za-z0-9_-]{60,})/)?.[1] || null,
    supabase: t => { const m = t.match(/API URL:\s*(https:\/\/[^\s]+)/); return m?.[1] || null; },
  };

  if (SERVICE_PARSERS[svc]) return SERVICE_PARSERS[svc](text);

  // Universal heuristic: if output is a single token-like line, return it
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0].length > 8 && !/\s/.test(lines[0])) return lines[0];

  // Look for key=value or key: value patterns containing the secret key name
  const keyPattern = (secretKey || '').replace(/_/g, '[_\\s-]*');
  const kvMatch = text.match(new RegExp(`${keyPattern}\\s*[=:]\\s*([A-Za-z0-9_/+=\\-]{8,})`, 'i'));
  if (kvMatch) return kvMatch[1];

  return null;
}

// ── Node ──────────────────────────────────────────────────────────────────────

async function installSkill(state) {
  const logger = state.logger || console;
  const {
    skillBuildDraft,
    skillBuildRequest,
    skillBuildSecrets = {},
    skillBuildAskQueue,
    pendingQuestion: _pq,
    progressCallback,
    llmBackend,
  } = state;

  const { name, displayName, description } = skillBuildRequest || {};

  logger.info(`[Node:InstallSkill] Installing skill "${name}"`);

  if (!skillBuildDraft || !name) {
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'Missing skill draft or name.' };
  }

  // Step 1: detect required secrets — LLM-driven, regex fallback
  const allSecrets = await detectRequiredSecrets(skillBuildDraft, name, llmBackend || null);

  // Build ask queue if first time here (askQueue not yet set)
  const askQueue = skillBuildAskQueue !== undefined
    ? skillBuildAskQueue
    : allSecrets.filter(s => !(s.key in skillBuildSecrets));

  // Step 2: if there are secrets still to collect, try cli.agent first before asking user
  if (askQueue.length > 0) {
    // Attempt silent resolution via cli.agent for each pending secret
    const resolvedSecrets = { ...skillBuildSecrets };
    const stillNeeded = [];

    for (const item of askQueue) {
      const resolved = await tryResolveViaCliAgent(item, state.mcpAdapter, logger);
      if (typeof resolved === 'string' && resolved.length > 0) {
        // Silent resolution — CLI extracted the token
        resolvedSecrets[item.key] = resolved;
        logger.info(`[Node:InstallSkill] agent resolved secret "${item.key}" silently`);
      } else if (resolved && typeof resolved === 'object' && resolved.hintOverride) {
        // Agent found context but needs user input — upgrade the hint text
        stillNeeded.push({ ...item, hint: resolved.hintOverride });
      } else {
        stillNeeded.push(item);
      }
    }

    // If agent resolved everything silently, continue to install with no user prompt
    if (stillNeeded.length === 0) {
      return { ...state, skillBuildSecrets: resolvedSecrets, skillBuildAskQueue: [], pendingQuestion: null };
    }

    // Otherwise ask user for the first unresolved secret (with agent-enriched hint)
    const next = stillNeeded[0];
    const remaining = stillNeeded.slice(1);

    logger.info(`[Node:InstallSkill] Asking for secret: ${next.key}`);

    // Scan the service's login/setup page to get actual field definitions.
    // This lets the UI card render proper labelled inputs (email, password, API key, etc.)
    // instead of a single generic text field. Falls back gracefully on timeout/error.
    let scannedFields = null;
    if (next.serviceContext) {
      try {
        const scanResult = await callCommandService('browser.agent', {
          action: 'scan_page',
          service: next.serviceContext,
          secretKey: next.key,
        }, 25000);
        if (scanResult?.ok && scanResult.fields && scanResult.fields.length > 0) {
          scannedFields = scanResult.fields;
          logger.info(`[Node:InstallSkill] scan_page: got ${scannedFields.length} field(s) for ${next.serviceContext}`);
        }
      } catch (scanErr) {
        logger.warn(`[Node:InstallSkill] scan_page failed (${scanErr.message}) — using generic input`);
      }
    }

    if (progressCallback) {
      progressCallback({ type: 'skill_build_phase', phase: 'asking', skillName: name });
    }

    return {
      ...state,
      skillBuildPhase: 'asking',
      skillBuildSecrets: resolvedSecrets,
      skillBuildAskQueue: remaining,
      skillBuildCurrentSecretKey: next.key,
      pendingQuestion: {
        question: next.hint,
        keyLabel: next.label,
        serviceContext: next.serviceContext || null,
        options: [],
        scannedFields: scannedFields || null,
      },
    };
  }

  // Step 3: store collected secrets in Keychain
  for (const [key, value] of Object.entries(skillBuildSecrets)) {
    if (value) {
      const result = await storeSecret(name, key, value);
      if (!result.ok) {
        logger.warn(`[Node:InstallSkill] Could not store secret ${key} in Keychain: ${result.error}`);
      } else {
        logger.info(`[Node:InstallSkill] Stored secret "${key}" in Keychain for skill "${name}"`);
      }
    }
  }

  if (progressCallback) {
    progressCallback({ type: 'skill_build_phase', phase: 'installing', skillName: name });
  }

  // Step 4: write skill file
  let installedPath;
  const skillDir = path.join(SKILLS_BASE_DIR, name);
  try {
    installedPath = writeSkillFile(name, skillBuildDraft);
    logger.info(`[Node:InstallSkill] Wrote skill to: ${installedPath}`);
  } catch (err) {
    logger.error(`[Node:InstallSkill] Failed to write skill file: ${err.message}`);
    return { ...state, skillBuildPhase: 'error', skillBuildError: `Could not write skill file: ${err.message}` };
  }

  // Step 4a: detect + install per-skill npm dependencies
  const skillDeps = detectSkillDeps(skillBuildDraft);
  const depList = Object.keys(skillDeps);
  if (depList.length > 0) {
    logger.info(`[Node:InstallSkill] Detected skill deps: ${depList.join(', ')}`);
    if (progressCallback) {
      progressCallback({ type: 'skill_build_phase', phase: 'installing', skillName: name, detail: `Installing ${depList.join(', ')}...` });
    }
    const depsResult = await installSkillDeps(skillDir, skillDeps, logger);
    if (!depsResult.ok) {
      logger.warn(`[Node:InstallSkill] Dep install warning: ${depsResult.error} — continuing anyway`);
    }
  }

  // Step 4b: smoke test — spawn isolated Node process to require + invoke the skill safely
  const smokeResult = await runSmokeTest(installedPath, logger);
  if (progressCallback) {
    progressCallback({
      type: 'skill_smoke_test',
      skillName: name,
      ok: smokeResult.ok,
      output: smokeResult.output,
      error: smokeResult.error,
    });
  }

  if (!smokeResult.ok) {
    logger.warn(`[Node:InstallSkill] Smoke test failed: ${smokeResult.error}`);

    // Smoke failure = real runtime crash (not missing secrets — those are pre-filtered).
    // Route back to buildSkill with the error as feedback so it can fix the code.
    const currentRound = state.skillBuildRound || 1;
    const MAX_BUILD_ROUNDS = 5;
    if (currentRound < MAX_BUILD_ROUNDS) {
      const smokeFeedback = [
        `FIX [RUNTIME ERROR]: The skill crashed during smoke test with this error:`,
        `  ${smokeResult.error}`,
        ``,
        `Analyze the error above and fix the root cause in the code.`,
        `Common causes: incorrect require() path, syntax error, wrong API call shape,`,
        `missing variable declaration, or invalid module structure.`,
        `The skill was written to: ${installedPath}`,
      ].join('\n');

      if (progressCallback) {
        progressCallback({
          type: 'skill_build_phase',
          phase: 'fixing',
          skillName: name,
          round: currentRound + 1,
        });
      }

      return {
        ...state,
        skillBuildPhase: 'fixing',
        skillBuildFeedback: smokeFeedback,
        skillBuildRound: currentRound + 1,
        skillBuildError: null,
        pendingQuestion: null,
        skillBuildAskQueue: null,
        skillBuildCurrentSecretKey: null,
      };
    } else {
      logger.warn(`[Node:InstallSkill] Smoke test failed and max rounds reached — marking error`);
      return {
        ...state,
        skillBuildPhase: 'error',
        skillBuildError: `Skill installed but failed smoke test after ${MAX_BUILD_ROUNDS} rounds.\n\nError: ${smokeResult.error}`,
        skillBuildInstalledPath: installedPath,
      };
    }
  } else {
    logger.info(`[Node:InstallSkill] Smoke test passed: ${smokeResult.output || 'ok'}`);
  }

  // Step 5: register in user-memory service
  const reg = await registerSkill({
    name,
    description: description || `Skill: ${name}`,
    execPath: installedPath,
    execType: 'node',
  });

  if (!reg.ok) {
    logger.warn(`[Node:InstallSkill] Registration warning: ${reg.error || 'unknown'} — skill file is written but DB entry may be missing`);
  } else {
    logger.info(`[Node:InstallSkill] Skill "${name}" registered in user-memory DB`);
  }

  if (progressCallback) {
    progressCallback({
      type: 'skill_build_phase',
      phase: 'done',
      skillName: name,
      installedPath,
    });
    progressCallback({
      type: 'skill_build_done',
      skillName: name,
      ok: true,
      installedPath,
    });
  }

  // If this skill was built on-demand (triggered by a missing external.skill during plan execution),
  // restore the original plan so executeCommand can resume from the failed step.
  const resumePlan = state.postBuildResumePlan || null;
  const resumeCursor = state.postBuildResumeCursor != null ? state.postBuildResumeCursor : null;
  if (resumePlan) {
    logger.info(`[Node:InstallSkill] Skill built on-demand — resuming plan at step ${resumeCursor + 1}/${resumePlan.length}`);
  }

  return {
    ...state,
    skillBuildPhase: 'done',
    skillBuildInstalledPath: installedPath,
    skillBuildError: null,
    pendingQuestion: null,
    // Clear build state
    skillBuildDraft: null,
    skillBuildFeedback: null,
    skillBuildAskQueue: null,
    skillBuildCurrentSecretKey: null,
    // Restore original plan if this was an on-demand build
    ...(resumePlan ? {
      skillPlan: resumePlan,
      skillCursor: resumeCursor,
      postBuildResumePlan: null,
      postBuildResumeCursor: null,
      failedStep: null,
      skillBuiltOnDemand: true,
    } : {}),
  };
}

module.exports = { run: installSkill };

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
function deriveServiceContext(skillName, secretKey) {
  const s = (skillName + ' ' + secretKey).toLowerCase();
  if (s.includes('gmail') || s.includes('googleapis') || s.includes('google')) return 'Google / Gmail';
  if (s.includes('twilio')) return 'Twilio';
  if (s.includes('clicksend')) return 'ClickSend';
  if (s.includes('sendgrid')) return 'SendGrid';
  if (s.includes('mailgun')) return 'Mailgun';
  if (s.includes('stripe')) return 'Stripe';
  if (s.includes('openai')) return 'OpenAI';
  if (s.includes('slack')) return 'Slack';
  if (s.includes('discord')) return 'Discord';
  if (s.includes('github')) return 'GitHub';
  if (s.includes('aws') || s.includes('amazon')) return 'AWS';
  if (s.includes('azure')) return 'Azure';
  return null;
}

function detectRequiredSecrets(code, skillName) {
  const secrets = [];
  // Match: keytar.getPassword('thinkdrop', 'skill:<name>:<KEY>')
  const re = /keytar\.getPassword\s*\(\s*['"]thinkdrop['"]\s*,\s*['"]skill:[^'"]+:([A-Z_]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const key = m[1];
    if (!secrets.find(s => s.key === key)) {
      const serviceContext = deriveServiceContext(skillName || '', key);
      secrets.push({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        serviceContext,
        hint: serviceContext
          ? `Your ${serviceContext} ${key.replace(/_/g, ' ').toLowerCase()}. Will be stored securely in macOS Keychain.`
          : `Required by the skill. Will be stored securely in macOS Keychain.`,
      });
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
 * Attempts to silently resolve a secret via cli.agent.
 * Returns the resolved value string if successful, null otherwise.
 * Never throws — always falls back gracefully.
 */
async function tryResolveViaCliAgent(secretItem, mcpAdapter, logger) {
  const { key, serviceContext } = secretItem;
  if (!serviceContext) return null;

  try {
    // Step 1: check if an agent already exists for this service
    const queryResult = await callCommandService('cli.agent', {
      action: 'query_agent',
      service: serviceContext,
    }, 8000);

    // Step 2: if no agent exists, try to build one (discovers CLI, generates descriptor)
    if (!queryResult?.found) {
      logger.info(`[InstallSkill] No cli.agent found for "${serviceContext}" — attempting build`);
      const buildResult = await callCommandService('cli.agent', {
        action: 'build_agent',
        service: serviceContext,
      }, 20000);

      if (!buildResult?.ok || buildResult?.needsInstall) {
        logger.info(`[InstallSkill] cli.agent build skipped for "${serviceContext}": ${buildResult?.error || 'CLI not installed'}`);
        return null;
      }
    }

    // Step 3: try to extract the token via the CLI's tokenCmd
    const runResult = await callCommandService('cli.agent', {
      action: 'run',
      service: serviceContext,
      cli: queryResult?.cliTool,
      argv: getTokenArgv(serviceContext, key),
      timeoutMs: 10000,
    }, 12000);

    if (!runResult?.ok || !runResult?.stdout?.trim()) return null;

    const extracted = parseTokenFromOutput(runResult.stdout, key, serviceContext);
    return extracted || null;
  } catch (err) {
    logger.info(`[InstallSkill] cli.agent resolution failed for "${key}": ${err.message}`);
    return null;
  }
}

function getTokenArgv(serviceContext, secretKey) {
  const key = (serviceContext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const TOKEN_CMDS = {
    github:   ['auth', 'token'],
    aws:      ['configure', 'get', secretKey.toLowerCase().includes('secret') ? 'aws_secret_access_key' : 'aws_access_key_id'],
    stripe:   ['config', '--list'],
    heroku:   ['auth:token'],
    netlify:  ['status'],
    fly:      ['auth', 'token'],
    gcloud:   ['auth', 'print-access-token'],
    firebase: ['login:ci'],
  };
  return TOKEN_CMDS[key] || ['--version'];
}

function parseTokenFromOutput(stdout, secretKey, serviceContext) {
  const svc = (serviceContext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const text = stdout.trim();

  if (svc === 'github') {
    const match = text.match(/^(ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/m);
    return match ? match[1] : (text.length > 10 && !text.includes(' ') ? text : null);
  }
  if (svc === 'heroku' || svc === 'fly') {
    return text.length > 10 && !text.includes('\n') ? text : null;
  }
  if (svc === 'stripe') {
    const match = text.match(/test_secret_key\s*=\s*(sk_test_[A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }
  if (svc === 'aws') {
    const match = text.match(/^([A-Z0-9]{20}|[A-Za-z0-9/+=]{40})$/m);
    return match ? match[1] : null;
  }
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
  } = state;

  const { name, displayName, description } = skillBuildRequest || {};

  logger.info(`[Node:InstallSkill] Installing skill "${name}"`);

  if (!skillBuildDraft || !name) {
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'Missing skill draft or name.' };
  }

  // Step 1: detect required secrets
  const allSecrets = detectRequiredSecrets(skillBuildDraft, name);

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
      if (resolved !== null) {
        resolvedSecrets[item.key] = resolved;
        logger.info(`[Node:InstallSkill] cli.agent resolved secret "${item.key}" silently`);
      } else {
        stillNeeded.push(item);
      }
    }

    // If cli.agent resolved everything, continue to install with no user prompt
    if (stillNeeded.length === 0) {
      return { ...state, skillBuildSecrets: resolvedSecrets, skillBuildAskQueue: [], pendingQuestion: null };
    }

    // Otherwise ask user for the first unresolved secret
    const next = stillNeeded[0];
    const remaining = stillNeeded.slice(1);

    logger.info(`[Node:InstallSkill] Asking for secret: ${next.key}`);

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

/**
 * installSkill Node — Installer Agent
 *
 * Takes a validated skill draft and:
 *   1. Detects any required secrets/config (API keys, tokens, etc.)
 *   2. If secrets needed and not yet collected → ASK_USER for each one
 *   3. Writes the .cjs file to ~/.thinkdrop/skills/<name>/index.cjs
 *   4. Stores secrets in macOS Keychain via keytar
 *   5. Registers the skill in the user-memory service DB
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

const SKILLS_BASE_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');
const USER_MEMORY_URL = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
const USER_MEMORY_KEY = process.env.MCP_USER_MEMORY_API_KEY || 'k7F9qLp3XzR2vH8sT1mN4bC0yW6uJ5eQG4tY9bH2wQ6nM1vS8xR3cL5pZ0kF7uDe';

// ── Detect required secrets from draft code ───────────────────────────────────

function detectRequiredSecrets(code) {
  const secrets = [];
  // Match: keytar.getPassword('thinkdrop', 'skill:<name>:<KEY>')
  const re = /keytar\.getPassword\s*\(\s*['"]thinkdrop['"]\s*,\s*['"]skill:[^'"]+:([A-Z_]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const key = m[1];
    if (!secrets.find(s => s.key === key)) {
      secrets.push({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        hint: `Required by the skill. Will be stored securely in macOS Keychain.`,
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
  const allSecrets = detectRequiredSecrets(skillBuildDraft);

  // Build ask queue if first time here (askQueue not yet set)
  const askQueue = skillBuildAskQueue !== undefined
    ? skillBuildAskQueue
    : allSecrets.filter(s => !(s.key in skillBuildSecrets));

  // Step 2: if there are secrets still to collect → ASK_USER
  if (askQueue.length > 0) {
    const next = askQueue[0];
    const remaining = askQueue.slice(1);

    logger.info(`[Node:InstallSkill] Asking for secret: ${next.key}`);

    if (progressCallback) {
      progressCallback({ type: 'skill_build_phase', phase: 'asking', skillName: name });
    }

    return {
      ...state,
      skillBuildPhase: 'asking',
      skillBuildAskQueue: remaining,
      skillBuildCurrentSecretKey: next.key,
      pendingQuestion: {
        question: `The skill "${displayName}" needs: **${next.label}**\n${next.hint}\n\nPlease enter the value (it will be stored securely in macOS Keychain):`,
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
  try {
    installedPath = writeSkillFile(name, skillBuildDraft);
    logger.info(`[Node:InstallSkill] Wrote skill to: ${installedPath}`);
  } catch (err) {
    logger.error(`[Node:InstallSkill] Failed to write skill file: ${err.message}`);
    return { ...state, skillBuildPhase: 'error', skillBuildError: `Could not write skill file: ${err.message}` };
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
  };
}

module.exports = { run: installSkill };

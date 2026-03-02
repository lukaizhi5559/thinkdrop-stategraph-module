/**
 * buildSkill Node — Creator Agent
 *
 * Receives a skill build request (name, description, category, rawUrl from the
 * oc-mimic-skills library).  Fetches the OpenClaw SKILL.md from GitHub as a
 * template/guide, then uses the LLM to write a ThinkDrop-native .cjs skill.
 *
 * State in:
 *   skillBuildRequest  — { name, displayName, description, category, ocUrl, rawUrl }
 *   skillBuildFeedback — string | null   (validator issues from previous round)
 *   skillBuildRound    — number          (current cycle, starts at 1)
 *   skillBuildDraft    — string | null   (previous draft to fix)
 *
 * State out:
 *   skillBuildDraft    — generated .cjs source code string
 *   skillBuildPhase    — 'validating'
 *   skillBuildError    — string | null
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FETCH_TIMEOUT_MS = 8000;
const MAX_SKILL_MD_CHARS = 6000; // truncate very long SKILL.md to stay under context limits

// ── Fetch SKILL.md — from GitHub raw URL or local file:// path ───────────────

function fetchSkillMd(rawUrl) {
  return new Promise((resolve) => {
    if (!rawUrl) { resolve(null); return; }

    // Local scaffold: file:// or absolute path
    if (rawUrl.startsWith('file://') || rawUrl.startsWith('/') || rawUrl.startsWith('~')) {
      try {
        let localPath = rawUrl.startsWith('file://') ? rawUrl.slice(7) : rawUrl;
        // Expand ~ to home directory (file://~/.thinkdrop/... → /Users/xxx/.thinkdrop/...)
        if (localPath.startsWith('~')) localPath = os.homedir() + localPath.slice(1);
        const content = fs.readFileSync(localPath, 'utf8');
        resolve(content.slice(0, MAX_SKILL_MD_CHARS));
      } catch (_) {
        resolve(null);
      }
      return;
    }

    const timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);

    https.get(rawUrl, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(data.slice(0, MAX_SKILL_MD_CHARS));
      });
      res.on('error', () => { clearTimeout(timer); resolve(null); });
    }).on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// ── System prompt ─────────────────────────────────────────────────────────────

const CREATOR_SYSTEM_PROMPT = `You are ThinkDrop's Skill Creator Agent. Your job is to write a production-quality ThinkDrop skill in Node.js.

## What ThinkDrop skills are
ThinkDrop is a desktop AI assistant (Electron/macOS). Skills extend it with new capabilities.
A skill is a single CommonJS .cjs file that exports one async function:
  module.exports = async (args) => { ... return string | object; }

## Always-available modules (pre-installed in ThinkDrop runtime — no install needed)
- All Node.js built-ins: fs, path, os, http, https, crypto, child_process, util, events, stream, url, querystring, buffer
- keytar — macOS Keychain: const keytar = require('keytar')
- node-cron — cron scheduling: const cron = require('node-cron')

## Third-party packages (auto-installed per skill — use freely, installer handles it)
ThinkDrop will automatically run npm install in the skill's own directory for any packages you require.
Commonly needed ones: twilio, googleapis, nodemailer, axios, openai, node-fetch, cheerio, uuid, lodash
Example: const twilio = require('twilio') — will be installed automatically.

## Security rules (CRITICAL — validator will reject violations)
1. NEVER hardcode secrets, API keys, passwords, or tokens in the source.
2. Use keytar for secrets: const keytar = require('keytar'); await keytar.getPassword('thinkdrop', 'skill:<name>:<KEY>')
3. NEVER use eval(), new Function(), or dynamic require() with user input.
4. NEVER access paths outside the user's home directory without explicit args.
5. Validate all args before use. Return { ok: false, error: '...' } on bad input.
6. Use const http = require('http') or https for network calls — never fetch() (Node CJS).
7. All timeouts must have a default (e.g. 10000ms). Never hang indefinitely.

## Skill contract
- Export: module.exports = async (args) => string | { ok: boolean, output: string, [extras] }
- On success: return a human-readable string or { ok: true, output: '...' }
- On failure: return { ok: false, error: '...' }
- Include a comment block at the top: skill name, description, args schema, returns schema.
- Keep it focused: one skill = one capability. Do NOT bundle multiple unrelated features.

## If the skill needs an API key or credentials
Add a setup() pattern at the top of the function:
  const apiKey = await keytar.getPassword('thinkdrop', 'skill:<name>:API_KEY');
  if (!apiKey) return { ok: false, error: 'API key not set. Ask the user to provide it.' };

## Output format
Respond with ONLY the raw .cjs source code. No markdown fences. No explanation. Just the code.`;

// ── Build prompt ──────────────────────────────────────────────────────────────

function buildPrompt({ request, skillMd, feedback, draft, round }) {
  const { name, displayName, description, category } = request;

  let prompt = '';

  if (round === 1) {
    prompt += `Create a ThinkDrop skill for: "${displayName}"\n`;
    prompt += `Category: ${category}\n`;
    prompt += `Description: ${description}\n\n`;

    if (skillMd) {
      prompt += `## OpenClaw reference (use as context/guide, NOT as implementation — adapt for ThinkDrop):\n`;
      prompt += skillMd + '\n\n';
    }

    prompt += `Write the complete ThinkDrop .cjs skill now. Skill name: "${name}"`;
  } else {
    prompt += `Fix the ThinkDrop skill "${displayName}" based on validator feedback.\n\n`;
    prompt += `## Validator feedback (round ${round - 1}):\n${feedback}\n\n`;
    prompt += `## Current draft to fix:\n\`\`\`js\n${draft}\n\`\`\`\n\n`;
    prompt += `Apply ALL fixes exactly as instructed. Return the complete corrected .cjs file.`;
  }

  return prompt;
}

// ── Node ──────────────────────────────────────────────────────────────────────

async function buildSkill(state) {
  const logger = state.logger || console;
  const {
    skillBuildRequest,
    skillBuildFeedback = null,
    skillBuildRound = 1,
    skillBuildDraft = null,
    streamCallback,
    progressCallback,
  } = state;

  if (!skillBuildRequest) {
    logger.error('[Node:BuildSkill] No skillBuildRequest in state');
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'No skill build request found.' };
  }

  // If draft is already ready and phase is 'installing', skip generation — pass through to validateSkill
  // This handles: normal resume after user provides a secret, and developer edit mode
  if (state.skillBuildPhase === 'installing' && state.skillBuildDraft) {
    logger.info(`[Node:BuildSkill] Draft already ready (phase=installing) — skipping generation, passing through`);
    return { ...state };
  }

  const { name, rawUrl } = skillBuildRequest;
  logger.info(`[Node:BuildSkill] Building skill "${name}" (round ${skillBuildRound})`);

  if (progressCallback) {
    progressCallback({ type: 'skill_build_phase', phase: skillBuildRound === 1 ? 'fetching' : 'fixing', skillName: name, round: skillBuildRound });
  }

  // Step 1: fetch SKILL.md template (only on first round)
  let skillMd = null;
  if (skillBuildRound === 1 && rawUrl) {
    logger.info(`[Node:BuildSkill] Fetching SKILL.md from: ${rawUrl}`);
    skillMd = await fetchSkillMd(rawUrl);
    if (skillMd) {
      logger.info(`[Node:BuildSkill] Fetched ${skillMd.length} chars from SKILL.md`);
    } else {
      logger.warn(`[Node:BuildSkill] Could not fetch SKILL.md — proceeding with description only`);
    }
  }

  if (progressCallback) {
    progressCallback({ type: 'skill_build_phase', phase: 'building', skillName: name, round: skillBuildRound });
  }

  // Step 2: call LLM — uses injected llmBackend (same as synthesize.js pattern)
  const llm = state.llmBackend;
  if (!llm) {
    logger.warn('[Node:BuildSkill] No llmBackend in state');
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'No LLM backend available for skill generation.' };
  }
  const userPrompt = buildPrompt({
    request: skillBuildRequest,
    skillMd,
    feedback: skillBuildFeedback,
    draft: skillBuildDraft,
    round: skillBuildRound,
  });

  const buildPayload = {
    query: userPrompt,
    context: {
      systemInstructions: CREATOR_SYSTEM_PROMPT,
      sessionId: state.context?.sessionId,
      userId: state.context?.userId || 'default_user',
    },
  };

  let draft = '';
  try {
    // Do NOT stream tokens to streamCallback — the generated code should only appear
    // in the SkillBuildProgress expand/collapse view, not the ResultsWindow text area.
    draft = await llm.generateAnswer(userPrompt, buildPayload, { maxTokens: 2000, temperature: 0.2 }, null);
    draft = (draft || '').trim();

    // Strip markdown fences if the LLM wrapped the code anyway
    draft = draft.replace(/^```(?:js|javascript|cjs)?\n?/i, '').replace(/\n?```$/i, '').trim();
  } catch (err) {
    logger.error(`[Node:BuildSkill] LLM error: ${err.message}`);
    return { ...state, skillBuildPhase: 'error', skillBuildError: `Creator Agent failed: ${err.message}` };
  }

  if (!draft || draft.length < 50) {
    return { ...state, skillBuildPhase: 'error', skillBuildError: 'Creator Agent returned empty code.' };
  }

  logger.info(`[Node:BuildSkill] Draft generated: ${draft.length} chars`);

  if (progressCallback) {
    progressCallback({ type: 'skill_build_draft', skillName: name, round: skillBuildRound, draft });
  }

  return {
    ...state,
    skillBuildDraft: draft,
    skillBuildPhase: 'validating',
    skillBuildError: null,
    // Store fetched template for potential use in later rounds
    skillBuildTemplateMd: skillMd || state.skillBuildTemplateMd || null,
  };
}

module.exports = { run: buildSkill };

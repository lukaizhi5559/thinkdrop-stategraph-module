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
const http = require('http');
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

// ── System prompt — loaded from prompts/build-skill.md ───────────────────────

function loadCreatorSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/build-skill.md'), 'utf8').trim();
  } catch (_) {
    return 'You are ThinkDrop\'s Skill Creator Agent. Write a production-quality Node.js CommonJS skill. Output ONLY raw .cjs code.';
  }
}

const CREATOR_SYSTEM_PROMPT = loadCreatorSystemPrompt();

// ── Build prompt ──────────────────────────────────────────────────────────────

function buildPrompt({ request, skillMd, agentDescriptors, feedback, draft, round }) {
  const { name, displayName, description, category } = request;

  let prompt = '';

  if (round === 1) {
    prompt += `Create a ThinkDrop skill for: "${displayName}"\n`;
    prompt += `Category: ${category}\n`;
    prompt += `Description: ${description}\n\n`;

    if (agentDescriptors && agentDescriptors.length > 0) {
      prompt += `## Available Agent Descriptors (use EXACTLY these CLI commands, API patterns, and auth flows — do not invent alternatives):\n`;
      for (const ag of agentDescriptors) {
        prompt += `\n### ${ag.id} (${ag.type} agent — service: ${ag.service})\n`;
        prompt += (ag.descriptor || '').slice(0, 2000) + '\n';
      }
      prompt += '\n';
    }

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

  // Step 1b: fetch relevant agent descriptors (only on first round)
  // Find agents whose service matches keywords in the skill name or description.
  // Injects exact CLI commands and API patterns into the LLM prompt so generated
  // code uses proven patterns rather than guessing.
  let agentDescriptors = [];
  if (skillBuildRound === 1 && state.mcpAdapter) {
    try {
      const agentRes = await state.mcpAdapter.callService('command', 'command.automate', {
        skill: 'cli.agent',
        args: { action: 'list_agents' },
      }, { timeoutMs: 4000 }).catch(() => null);

      const allAgents = agentRes?.data?.agents || agentRes?.agents || [];
      const healthyAgents = allAgents.filter(a => a.status === 'healthy' || a.status === 'degraded');

      if (healthyAgents.length > 0) {
        // Match agents whose service name appears in the skill name or description
        const searchText = `${name} ${skillBuildRequest.description || ''}`.toLowerCase();
        const relevantAgents = healthyAgents.filter(a =>
          searchText.includes((a.service || '').toLowerCase()) ||
          searchText.includes((a.id || '').toLowerCase().replace('.agent', ''))
        );

        if (relevantAgents.length > 0) {
          // Fetch full descriptors for each relevant agent
          for (const agent of relevantAgents.slice(0, 3)) {
            const skillName2 = agent.type === 'browser' ? 'browser.agent' : 'cli.agent';
            const qRes = await state.mcpAdapter.callService('command', 'command.automate', {
              skill: skillName2,
              args: { action: 'query_agent', id: agent.id },
            }, { timeoutMs: 4000 }).catch(() => null);
            const descriptor = qRes?.data?.descriptor || qRes?.descriptor || null;
            if (descriptor) {
              agentDescriptors.push({ id: agent.id, type: agent.type, service: agent.service, descriptor });
            }
          }
          logger.info(`[Node:BuildSkill] Injecting ${agentDescriptors.length} agent descriptor(s): ${agentDescriptors.map(a => a.id).join(', ')}`);
        }
      }
    } catch (agentErr) {
      logger.warn(`[Node:BuildSkill] Agent descriptor fetch failed (non-fatal): ${agentErr.message}`);
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
    agentDescriptors,
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

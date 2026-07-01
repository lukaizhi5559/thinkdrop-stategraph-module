'use strict';

/**
 * preflightAgents.js — StateGraph node
 *
 * Sits between gatherPlanContext → planSkills.
 * Runs agent readiness checks BEFORE plan generation:
 *   1. Skill contract fetch (for matchedSkillName)
 *   2. CLI pre-flight (cli.agent preflight_check)
 *   3. Agent registry + trained recipes (agent.list + trainer.agent)
 *   4. Installed skills list
 *   5. Disk-scan fallback for trained recipes
 *   6. Browser agent auth check (session profile exists?)
 *   7. App agent build (app.agent build_agent — Phase 2)
 *
 * Emits progress events with agent favicon icons for visual UI feedback.
 * When auth is needed, emits preflight:auth_required so UI can route user to AgentsTab.
 *
 * State outputs:
 *   state.preflightResult = {
 *     skillContractNote,      // string for planSkills prompt
 *     shellContractMd,        // raw contract MD for fast-path
 *     shellSkillNames,        // Set of shell skill names
 *     cliPreflightNote,       // string for planSkills prompt
 *     agentContextNote,       // string for planSkills prompt
 *     preflightCliMap,        // { service: { hasCli } }
 *     registeredAgentServiceMap, // { service: agentId }
 *     trainedRecipeMap,       // { variant: { agentId, skillName, agentType } }
 *     installedSkillsList,    // array
 *     agents,                 // array of readiness info with iconUrl
 *   }
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Icon resolution ──────────────────────────────────────────────────────────

const AGENT_DOMAIN_OVERRIDES = {
  gmail: 'mail.google.com',
  google: 'google.com',
  youtube: 'youtube.com',
  ebay: 'ebay.com',
  amazon: 'amazon.com',
  reddit: 'reddit.com',
  twitter: 'twitter.com',
  x: 'x.com',
  linkedin: 'linkedin.com',
  slack: 'slack.com',
  notion: 'notion.so',
  github: 'github.com',
  perplexity: 'perplexity.ai',
  chatgpt: 'chat.openai.com',
  openai: 'openai.com',
  anthropic: 'anthropic.com',
  claude: 'anthropic.com',
  discord: 'discord.com',
  figma: 'figma.com',
  linear: 'linear.app',
  jira: 'atlassian.com',
  midjourney: 'midjourney.com',
  yt: 'youtube.com',
  ytdlp: 'youtube.com',
  gh: 'github.com',
  gcloud: 'cloud.google.com',
  aws: 'aws.amazon.com',
  azure: 'azure.microsoft.com',
  cursor: 'cursor.com',
  vscode: 'code.visualstudio.com',
  spotify: 'spotify.com',
  netflix: 'netflix.com',
  twitch: 'twitch.tv',
  whatsapp: 'whatsapp.com',
  telegram: 'telegram.org',
  zoom: 'zoom.us',
  dropbox: 'dropbox.com',
  mailgun: 'mailgun.com',
  sendgrid: 'sendgrid.com',
  twilio: 'twilio.com',
  stripe: 'stripe.com',
  docker: 'docker.com',
  kubectl: 'kubernetes.io',
  helm: 'helm.sh',
  terraform: 'terraform.io',
  pandoc: 'pandoc.org',
  imagemagick: 'imagemagick.org',
  ffmpeg: 'ffmpeg.org',
};

function agentIdToDomain(agentId) {
  const base = agentId.replace(/\.agent$/i, '').toLowerCase();
  return AGENT_DOMAIN_OVERRIDES[base] || `${base}.com`;
}

function agentIdToIconUrl(agentId) {
  const domain = agentIdToDomain(agentId);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function serviceToIconUrl(service) {
  const base = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(AGENT_DOMAIN_OVERRIDES[base] || `${base}.com`)}&sz=128`;
}

// ── Main node ─────────────────────────────────────────────────────────────────

module.exports = async function preflightAgents(state) {
  const logger = state.logger || console;
  const mcpAdapter = state.mcpAdapter;
  const progressCallback = state.progressCallback || null;
  const userMessage = state.resolvedMessage || state.message || '';
  const recoveryContext = state.recoveryContext || null;

  logger.info(`[Node:PreflightAgents] Running preflight for: "${userMessage.slice(0, 80)}"`);

  if (!mcpAdapter) {
    logger.warn('[Node:PreflightAgents] No mcpAdapter — skipping preflight');
    return { ...state, preflightResult: null, preflightDone: true };
  }

  // Emit start
  if (progressCallback) {
    progressCallback({ type: 'preflight:start', message: 'Preparing agents for your task...' });
  }

  // Initialize result containers
  let skillContractNote = '';
  let _shellContractMd = null;
  let _preflightCliMap = {};
  let cliPreflightNote = '';
  let agentContextNote = '';
  let _registeredAgentServiceMap = {};
  const shellSkillNames = new Set();
  let installedSkillsList = [];
  let _trainedRecipeMap = {};
  const agentReadiness = []; // { type, agentId, ready, authed, iconUrl, ... }

  // ── Parallel preflight fetches ──────────────────────────────────────────────
  await Promise.all([
    // ── Skill contract ────────────────────────────────────────────────────
    (async () => {
      if (!state.matchedSkillName) return;
      try {
        const scRes = await mcpAdapter.callService('user-memory', 'skill.get', { name: state.matchedSkillName }, { timeoutMs: 3000 }).catch(() => null);
        const scData = scRes?.data || scRes;
        const contractMd = scData?.contractMd || scData?.contract_md || '';
        if (contractMd?.trim()) {
          const _fmMatch = contractMd.match(/^---\s*\n([\s\S]*?)\n---/);
          const _isNodeSkill = _fmMatch && /exec_type:\s*node\b/i.test(_fmMatch[1]);
          const _isPythonSkill = _fmMatch && /exec_type:\s*python\b/i.test(_fmMatch[1]);
          const _isShellContract = !_isNodeSkill && !_isPythonSkill;
          if (_isNodeSkill || _isPythonSkill) {
            const _runtimeType = _isPythonSkill ? 'Python' : 'Node.js';
            skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. This is a ${_runtimeType} runtime skill (exec_type: ${_isPythonSkill ? 'python' : 'node'}). Generate a SINGLE step: { "skill": "external.skill", "args": { "name": "${state.matchedSkillName}" } }\n2. FORBIDDEN: Do NOT generate shell.run or curl steps.\n3. FORBIDDEN: Do NOT expand the implementation — just call external.skill.\n\n${contractMd.slice(0, 2000)}`;
          } else if (_isShellContract) {
            skillContractNote = `\n\nSKILL CONTRACT for "${state.matchedSkillName}" — CRITICAL RULES:\n1. You MUST generate shell.run steps with curl commands from the ## Commands section below.\n2. FORBIDDEN: Do NOT use "${state.matchedSkillName}" as a skill name in any step.\n3. FORBIDDEN: Do NOT use external.skill for this.\n\n${contractMd.slice(0, 3000)}`;
            _shellContractMd = contractMd;
            shellSkillNames.add(state.matchedSkillName);
          }
        }
      } catch (_) {}
    })(),

    // ── CLI pre-flight ────────────────────────────────────────────────────
    (async () => {
      if (recoveryContext) return;
      try {
        if (progressCallback) {
          progressCallback({
            type: 'preflight:building_agent',
            agentType: 'cli',
            agentId: 'cli.preflight',
            message: 'Checking CLI tools and authentication...',
            iconUrl: null, // CLI preflight is generic, no specific icon
          });
        }

        const pfRes = await mcpAdapter.callService('command', 'command.automate', { skill: 'cli.agent', args: { action: 'preflight_check', task: userMessage } }, { timeoutMs: 5000 }).catch(() => null);
        const pf = pfRes?.data || pfRes;
        if (pf?.ok) {
          const lines = [];
          if (!pf.brew?.installed) lines.push('brew: NOT INSTALLED — install first');
          else lines.push('brew: installed ✓');
          if (!pf.curl?.installed) lines.push('curl: NOT INSTALLED');
          else lines.push('curl: installed ✓');
          if (Array.isArray(pf.detectedClis)) {
            for (const c of pf.detectedClis) {
              _preflightCliMap[c.service.toLowerCase()] = { hasCli: !!c.cli };
              const iconUrl = serviceToIconUrl(c.service);

              if (!c.cli) {
                const provider = c.isOAuth ? 'OAuth-based' : c.isApiKey ? 'API key required' : 'unknown';
                lines.push(`${c.service}: ${provider} — use browser.agent { action: 'build_agent' } then { action: 'run' }`);
                agentReadiness.push({ type: 'cli', agentId: `${c.service}.agent`, ready: false, authed: false, iconUrl, service: c.service, reason: provider });
                // Surface API-key or OAuth requirements to the UI during preflight.
                if (progressCallback && (c.isApiKey || c.isOAuth)) {
                  progressCallback({
                    type: 'preflight:auth_required',
                    agentId: `${c.service}.agent`,
                    serviceName: c.service,
                    authType: c.isApiKey ? 'api_key' : 'browser_oauth',
                    iconUrl,
                    message: `${c.service} ${c.isApiKey ? 'requires an API key' : 'requires browser login'}`,
                  });
                }
                continue;
              }
              if (!c.installed) {
                const installCmd = c.installMethod === 'npm' ? `npm install -g ${c.installPkg}` : `brew install ${c.installPkg || c.cli}`;
                lines.push(`${c.service}: ${c.cli} NOT INSTALLED — install: ${installCmd}`);
                agentReadiness.push({ type: 'cli', agentId: `${c.service}.agent`, ready: false, authed: false, iconUrl, service: c.service, reason: 'not installed' });
                // Surface CLI install requirement to the UI during preflight.
                if (progressCallback) {
                  progressCallback({
                    type: 'preflight:auth_required',
                    agentId: `${c.service}.agent`,
                    serviceName: c.service,
                    authType: 'cli_install',
                    iconUrl,
                    message: `${c.service} is not installed — run: ${installCmd}`,
                  });
                }
              } else {
                const authNote = c.authUser ? ` — authenticated as ${c.authUser}` : (c.authStatus === 'authenticated' ? ' — authenticated' : '');
                lines.push(`${c.service}: ${c.cli} installed${authNote} ✓ — use cli.agent { action: 'run', agentId: '${c.service}.agent', task: '...' }`);
                const authed = !!c.authUser || c.authStatus === 'authenticated';
                agentReadiness.push({ type: 'cli', agentId: `${c.service}.agent`, ready: true, authed, iconUrl, service: c.service });

                if (!authed) {
                  // Emit auth required for CLI token
                  if (progressCallback) {
                    progressCallback({
                      type: 'preflight:auth_required',
                      agentId: `${c.service}.agent`,
                      serviceName: c.service,
                      authType: 'cli_token',
                      iconUrl,
                      message: `${c.service} requires authentication`,
                    });
                  }
                }
              }
            }
          }
          if (lines.length > 0) cliPreflightNote = `\n\nCLI PRE-FLIGHT:\n${lines.join('\n')}`;
        }
      } catch (_) {}
    })(),

    // ── Agent registry ────────────────────────────────────────────────────
    (async () => {
      try {
        const agRes = await mcpAdapter.callService('command', 'agent.list', {}, { timeoutMs: 3000 }).catch(() => null);
        const agents = agRes?.data || agRes || [];
        if (Array.isArray(agents) && agents.length > 0) {
          const agentLines = [];
          const trainedRecipeLines = [];

          for (const a of agents) {
            const baseLine = `- ${a.id}: ${a.type} agent${a.start_url ? ` (starts at ${a.start_url})` : ''}${Array.isArray(a.capabilities) ? ` — capabilities: ${a.capabilities.slice(0, 5).join(', ')}` : ''}`;
            agentLines.push(baseLine);
            const svc = (a.id || '').replace('.agent', '').toLowerCase();
            if (svc) _registeredAgentServiceMap[svc] = a.id;

            // ── Fetch trained recipes for this agent ─────────────────────
            if (a.type === 'browser' || a.type === 'cli') {
              try {
                const tsRes = await mcpAdapter.callService('command', 'command.automate', {
                  skill: 'trainer.agent',
                  args: { action: 'list_skills', agentId: svc }
                }, { timeoutMs: 3000 }).catch(() => null);
                const skills = tsRes?.data?.skills || tsRes?.skills || [];
                if (skills.length > 0) {
                  const skillNames = skills.map(s => s.name).join(', ');
                  const agentTypeSkill = a.type === 'cli' ? 'cli.agent' : 'browser.agent';
                  trainedRecipeLines.push(`- ${a.id}: [${skillNames}] → use ${agentTypeSkill} { action: "run", agentId: "${a.id}" }`);

                  // Build fuzzy matching map
                  for (const s of skills) {
                    const baseName = s.name.toLowerCase();
                    const variants = [
                      baseName,
                      baseName.replace(/_/g, '.'),
                      baseName.replace(/\./g, ' '),
                      baseName.replace(/_/g, ' '),
                      baseName.replace(/\./g, '_'),
                      baseName.replace(/^[^.]+\./, ''),
                    ];
                    for (const v of variants) {
                      if (!_trainedRecipeMap[v]) {
                        _trainedRecipeMap[v] = { agentId: a.id, skillName: s.name, agentType: a.type === 'cli' ? 'cli.agent' : 'browser.agent' };
                      }
                    }
                  }
                }
              } catch (err) {
                logger.warn(`[Node:PreflightAgents] trainer.agent call failed for ${svc}: ${err.message}`);
              }
            }

            // ── Browser agent auth check ────────────────────────────────
            if (a.type === 'browser') {
              const iconUrl = agentIdToIconUrl(a.id);
              const BROWSER_SESSIONS_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-sessions');
              const svcKey = (a.id || '').replace('.agent', '').toLowerCase();
              const profileDir = `${svcKey}_agent`;
              const hasSession = fs.existsSync(path.join(BROWSER_SESSIONS_DIR, profileDir));

              agentReadiness.push({
                type: 'browser',
                agentId: a.id,
                ready: true,
                authed: hasSession,
                iconUrl,
                startUrl: a.start_url,
                needsLogin: !hasSession,
              });

              if (!hasSession && a.start_url) {
                if (progressCallback) {
                  progressCallback({
                    type: 'preflight:auth_required',
                    agentId: a.id,
                    serviceName: svcKey,
                    authType: 'browser_oauth',
                    iconUrl,
                    message: `${a.id} requires browser login`,
                  });
                }
              }
            } else if (a.type === 'cli') {
              // CLI agents already handled in preflight_check above
            }
          }

          agentContextNote = `\n\nREGISTERED AGENTS (use browser.agent { action: "run", agentId: "<id>", task: "..." } for these — do NOT use raw browser.act navigate):\n${agentLines.join('\n')}`;

          if (trainedRecipeLines.length > 0) {
            agentContextNote += `\n\nTRAINED RECIPES (when user mentions these, use browser.agent/cli.agent — NOT external.skill):\n${trainedRecipeLines.join('\n')}`;
          }
        }
      } catch (_) {}
    })(),

    // ── Installed skills list ─────────────────────────────────────────────
    (async () => {
      try {
        const ilRes = await mcpAdapter.callService('user-memory', 'skill.list', {}, { timeoutMs: 3000 }).catch(() => null);
        const il = ilRes?.data || ilRes || [];
        if (Array.isArray(il)) installedSkillsList = il;
      } catch (_) {}
    })(),
  ]);

  // ── App agent build (Phase 2) ──────────────────────────────────────────
  // For registered app-type agents, call app.agent build_agent to ensure
  // descriptors are up-to-date with shortcuts and playbooks.
  // Runs after Promise.all so _registeredAgentServiceMap is populated.
  try {
    const appAgents = agentReadiness.filter(a => a.type === 'app');
    // Also check registered agents that might be app type
    const registeredAppEntries = Object.entries(_registeredAgentServiceMap)
      .filter(([svc, id]) => id.includes('.app.agent'));
    for (const [svc, id] of registeredAppEntries) {
      if (appAgents.some(a => a.agentId === id)) continue; // already handled
      const appName = svc;
      const iconUrl = agentIdToIconUrl(id);
      try {
        _emitProgress({ type: 'preflight:checking', agentId: id, iconUrl, message: `Building ${appName} app agent…` });
        const buildRes = await mcpAdapter.callService('command-service', 'app.agent', {
          action: 'build_agent',
          appName,
        }, { timeoutMs: 30000 }).catch(() => null);
        if (buildRes?.ok) {
          logger.info(`[Node:PreflightAgents] App agent built: ${appName}`);
          agentReadiness.push({ type: 'app', agentId: id, ready: true, authed: true, iconUrl, service: appName });
          _emitProgress({ type: 'preflight:agent_ready', agentId: id, iconUrl, message: `${appName} ready` });
        } else {
          agentReadiness.push({ type: 'app', agentId: id, ready: false, authed: true, iconUrl, service: appName, reason: buildRes?.error || 'build failed' });
        }
      } catch (buildErr) {
        logger.warn(`[Node:PreflightAgents] App agent build failed for ${appName}: ${buildErr.message}`);
        agentReadiness.push({ type: 'app', agentId: id, ready: false, authed: true, iconUrl, service: appName, reason: buildErr.message });
      }
    }
  } catch (_) {}

  // ── Disk-scan fallback: load recipes directly from filesystem ────────────────
  try {
    const skillsRoot = path.join(os.homedir(), '.thinkdrop', 'skills');
    if (fs.existsSync(skillsRoot)) {
      let diskCount = 0;
      const agentDirs = fs.readdirSync(skillsRoot).filter(d => {
        try { return fs.statSync(path.join(skillsRoot, d)).isDirectory(); } catch (_) { return false; }
      });
      for (const agentDir of agentDirs) {
        const recipeDir = path.join(skillsRoot, agentDir);
        let recipeFiles;
        try { recipeFiles = fs.readdirSync(recipeDir).filter(f => f.endsWith('.recipe.json')); }
        catch (_) { continue; }
        for (const recipeFile of recipeFiles) {
          try {
            const recipe = JSON.parse(fs.readFileSync(path.join(recipeDir, recipeFile), 'utf8'));
            if (!recipe.name) continue;
            const inferredAgentId = recipe.agentId || `${agentDir}.agent`;
            const agentType = 'browser.agent';
            const baseName = recipe.name.toLowerCase();
            const variants = [
              baseName,
              baseName.replace(/_/g, '.'),
              baseName.replace(/\./g, ' '),
              baseName.replace(/_/g, ' '),
              baseName.replace(/\./g, '_'),
              baseName.replace(/^[^.]+\./, ''),
            ];
            for (const v of variants) {
              if (!_trainedRecipeMap[v]) {
                _trainedRecipeMap[v] = { agentId: inferredAgentId, skillName: recipe.name, agentType };
                diskCount++;
              }
            }
          } catch (_) { /* skip unreadable recipe */ }
        }
      }
      if (diskCount > 0) {
        logger.info(`[Node:PreflightAgents] Disk-scan added ${diskCount} recipe variant(s)`);
      }
    }
  } catch (diskErr) {
    logger.warn(`[Node:PreflightAgents] Disk-scan fallback error: ${diskErr.message}`);
  }

  // ── Save trained recipe map to state for fast-path ──────────────────────────
  const mapSize = Object.keys(_trainedRecipeMap).length;
  logger.info(`[Node:PreflightAgents] Trained recipe map built: ${mapSize} variants`);
  if (mapSize > 0) {
    state._trainedRecipeMap = _trainedRecipeMap;
  }

  // ── Build preflightResult ───────────────────────────────────────────────────
  const preflightResult = {
    skillContractNote,
    shellContractMd: _shellContractMd,
    shellSkillNames: Array.from(shellSkillNames),
    cliPreflightNote,
    agentContextNote,
    preflightCliMap: _preflightCliMap,
    registeredAgentServiceMap: _registeredAgentServiceMap,
    trainedRecipeMap: _trainedRecipeMap,
    installedSkillsList,
    agents: agentReadiness,
  };

  // Emit complete
  if (progressCallback) {
    progressCallback({
      type: 'preflight:complete',
      agents: agentReadiness.map(a => ({
        type: a.type,
        agentId: a.agentId,
        ready: a.ready,
        authed: a.authed,
        iconUrl: a.iconUrl,
      })),
    });
  }

  logger.info(`[Node:PreflightAgents] Preflight complete: ${agentReadiness.length} agents checked, ${agentReadiness.filter(a => !a.ready).length} not ready, ${agentReadiness.filter(a => !a.authed).length} need auth`);

  return {
    ...state,
    preflightResult,
    preflightDone: true,
    _trainedRecipeMap: mapSize > 0 ? _trainedRecipeMap : state._trainedRecipeMap,
  };
};

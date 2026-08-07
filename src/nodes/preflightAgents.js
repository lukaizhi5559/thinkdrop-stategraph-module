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
 *   6. Browser agent auth check (session profile exists + cookie validity?)
 *   7. App agent build (app.agent build_agent — Phase 2)
 *   8. vet CLI presence check (secure script installer)
 *   9. Monthly CLI version validation (timestamp-gated, calls validate_agent)
 *  10. MCP service health ping
 *  11. PATH health check
 *  12. Stale agent detection (registered agent whose CLI is gone)
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
 *     vetAvailable,           // boolean — vet CLI installed?
 *     warnings,               // array of { type, message } non-fatal warnings
 *   }
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Preflight state file (monthly validation persistence) ────────────────────
const PREFLIGHT_STATE_FILE = path.join(os.homedir(), '.thinkdrop', 'preflight-state.json');
const VALIDATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BROWSER_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for cookie staleness

// ── Session-level auth cache (persists across StateGraph runs within same process) ──
// Key: agentId (lowercase)  Value: { ts, authed }
// TTL: 30 minutes — re-check filesystem after this expires
const PREFLIGHT_AUTH_CACHE_TTL_MS = 30 * 60 * 1000;
const _authCache = new Map();

function markAgentAuthed(agentId) {
  if (!agentId) return;
  _authCache.set(agentId.toLowerCase(), { ts: Date.now(), authed: true });
}

function _getCachedAuth(agentId) {
  const entry = _authCache.get(agentId.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.ts > PREFLIGHT_AUTH_CACHE_TTL_MS) {
    _authCache.delete(agentId.toLowerCase());
    return null;
  }
  return entry;
}

function _deriveAgentAuthType(descriptor) {
  const m = String(descriptor || '').match(/^type:\s*(\S+)/m);
  const type = m ? m[1].toLowerCase() : 'browser';
  if (type === 'api_key' || type === 'bearer' || type === 'basic') return type;
  return 'browser_oauth';
}

// Parse setupInfo from an agent descriptor (.md).
// Supports two formats:
// 1. YAML frontmatter: setupInfo: { installCmd, authCmd, credentials, setupUrl, ... }
// 2. Markdown section: ## Setup Info\n- installCmd: ...\n- authCmd: ...
function _parseSetupInfo(descriptor) {
  if (!descriptor || typeof descriptor !== 'string') return null;
  // Try YAML frontmatter setupInfo
  const fmMatch = descriptor.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const siMatch = fm.match(/^setupInfo:\s*\n([\s\S]*?)(?=\n[a-z]|\n---|$)/m);
    if (siMatch) {
      const block = siMatch[1];
      const info = {};
      for (const line of block.split('\n')) {
        const m = line.match(/^\s+(\w+):\s*(.+)$/);
        if (m) {
          let val = m[2].trim();
          if (val.startsWith('[') && val.endsWith(']')) {
            try { val = JSON.parse(val); } catch { val = val.slice(1, -1).split(',').map(s => s.trim()); }
          }
          info[m[1]] = val;
        }
      }
      if (Object.keys(info).length > 0) return info;
    }
    // Single-line setupInfo
    const singleMatch = fm.match(/^setupInfo:\s*(\{.+\})/m);
    if (singleMatch) {
      try { return JSON.parse(singleMatch[1]); } catch {}
    }
  }
  // Try markdown ## Setup Info section
  const mdMatch = descriptor.match(/##\s*Setup\s*Info\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (mdMatch) {
    const block = mdMatch[1];
    const info = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*[-*]\s*(\w+):\s*(.+)$/);
      if (m) {
        let val = m[2].trim();
        if (val.startsWith('[') && val.endsWith(']')) {
          try { val = JSON.parse(val); } catch { val = val.slice(1, -1).split(',').map(s => s.trim()); }
        }
        info[m[1]] = val;
      }
    }
    if (Object.keys(info).length > 0) return info;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _loadPreflightState() {
  try {
    if (fs.existsSync(PREFLIGHT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(PREFLIGHT_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastValidatedAt: null, cliVersions: {}, failedInstalls: {} };
}

function _savePrefflightState(data) {
  try {
    const dir = path.dirname(PREFLIGHT_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PREFLIGHT_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function _whichSync(cmd) {
  try {
    const { execSync } = require('child_process');
    const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
    return p || null;
  } catch (_) {
    for (const p of [
      `/usr/local/bin/${cmd}`,
      `/opt/homebrew/bin/${cmd}`,
      `/usr/bin/${cmd}`,
    ]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
}

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
  let userMessage = state.resolvedMessage || state.message || '';
  // Inject follow-up target context so preflight consumers (deep-link resolution,
  // cli preflight_check, tool.discover, agent-relevance filter) see the full task
  // context, not just a vague follow-up like "I need you to check again".
  // gatherPlanContext does the same injection later, but preflight runs BEFORE it.
  const _tc = state._taskClassification || {};
  if (_tc.isFollowUp && _tc.followUpTarget && !_tc.isScreenFollowUp) {
    userMessage = `${userMessage}\n\n(Context from prior turn: ${_tc.followUpTarget})`;
    logger.info(`[Node:PreflightAgents] Follow-up target injected: "${_tc.followUpTarget}"`);
  }
  const recoveryContext = state.recoveryContext || null;
  const confirmInstallCallback = state.confirmInstallCallback || null;
  const gatherAnswerCallback = state.gatherAnswerCallback || null;
  const gatherCredentialCallback = state.gatherCredentialCallback || null;

  // _emitProgress — safe wrapper that no-ops if progressCallback is null
  const _emitProgress = (data) => {
    if (progressCallback) progressCallback(data);
  };

  logger.info(`[Node:PreflightAgents] Running preflight for: "${userMessage.slice(0, 80)}"`);

  if (!mcpAdapter) {
    logger.warn('[Node:PreflightAgents] No mcpAdapter — skipping preflight');
    return { ...state, preflightResult: null, preflightDone: true };
  }

  // Emit start
  _emitProgress({ type: 'preflight:start', message: 'Preparing agents for your task...' });

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
  let vetAvailable = false;
  let vetPath = null;
  let discoveredToolNote = '';
  const warnings = []; // { type, message } non-fatal warnings
  let orphanedSkills = [];  // skill names registered in user-memory but missing on disk
  let orphanedSkillsNote = '';  // injected into planSkills prompt
  const _allowAutoGeneratedRecipes = process.env.THINKDROP_ALLOW_AUTOGENERATED_RECIPES === 'true';

  // ── ResolveAgent result: which agents to preflight and which to create ─────
  const resolveAgentResult = state.resolveAgentResult || null;
  const selectedAgentIds = new Set();
  const createAgentSpecs = [];
  const _resolverTypeMap = {}; // agentId (lowercase) → declared type from resolver
  if (resolveAgentResult && Array.isArray(resolveAgentResult.agents)) {
    for (const a of resolveAgentResult.agents) {
      if (!a || !a.agentId) continue;
      const idLower = a.agentId.toLowerCase();
      selectedAgentIds.add(idLower);
      if (a.type) _resolverTypeMap[idLower] = a.type;
      if (a.create) {
        createAgentSpecs.push(a);
      }
    }
  }

  // Run CLI preflight only when CLI is actually selected (or when no explicit
  // agent selection exists and discovery mode still needs capability checks).
  let _shouldRunCliPreflight = !recoveryContext;
  let _selectedCliAgents = []; // descriptors of selected CLI agents to pass explicitly
  let _isGenericPreflight = false; // true when running discovery scan without typed CLI agents
  if (!recoveryContext && selectedAgentIds.size > 0) {
    try {
      const agSnapshotRes = await mcpAdapter.callService('command', 'agent.list', {}, { timeoutMs: 3000 }).catch(() => null);
      const agSnapshot = Array.isArray(agSnapshotRes?.data) ? agSnapshotRes.data : (Array.isArray(agSnapshotRes) ? agSnapshotRes : []);
      _selectedCliAgents = agSnapshot.filter(a =>
        selectedAgentIds.has(String(a?.id || '').toLowerCase()) && a?.type === 'cli'
      );
      _shouldRunCliPreflight = _selectedCliAgents.length > 0;
      if (!_shouldRunCliPreflight) {
        // Check if any selected agent IDs are unregistered AND could be CLI.
        // Use the resolver's declared type — if the resolver explicitly said
        // type: 'browser' or type: 'app', do NOT treat it as a CLI candidate.
        const _unregisteredCliCandidates = [...selectedAgentIds].filter(id => {
          if (!id.endsWith('.agent')) return false;
          const declaredType = _resolverTypeMap[id];
          return !declaredType || declaredType === 'cli';
        });
        if (_unregisteredCliCandidates.length > 0) {
          _shouldRunCliPreflight = true;
          _isGenericPreflight = _unregisteredCliCandidates.length > 0 && _selectedCliAgents.length === 0;
          logger.info(`[Node:PreflightAgents] CLI preflight enabled for unregistered agent(s): ${_unregisteredCliCandidates.join(', ')}`);
        } else {
          _shouldRunCliPreflight = false;
          logger.info('[Node:PreflightAgents] CLI preflight skipped — selected agents are non-CLI');
        }
      }
    } catch (_) {
      // Keep safe default (run) if snapshot is unavailable.
      _shouldRunCliPreflight = true;
      _isGenericPreflight = true;
    }
  } else if (!recoveryContext && selectedAgentIds.size === 0) {
    _isGenericPreflight = true;
  }

  // ── Create any agents marked create:true by resolveAgent ───────────────────
  if (createAgentSpecs.length > 0) {
    const failedCreates = [];
    const noCliFailures = []; // CLI agent builds that failed because no CLI exists for the service
    for (const spec of createAgentSpecs) {
      const skillName = spec.type === 'cli' ? 'cli.agent' : (spec.type === 'app' ? 'app.agent' : 'browser.agent');
      try {
        _emitProgress({
          type: 'preflight:building_agent',
          agentType: spec.type,
          agentId: spec.agentId,
          message: `Building ${spec.service} agent…`,
          iconUrl: serviceToIconUrl(spec.service),
        });
        const buildArgs = {
          action: 'build_agent',
          service: spec.service,
        };
        if (spec.startUrl) buildArgs.startUrl = spec.startUrl;
        // command-service exposes skills through /command.automate, not direct /<skill> routes.
        const buildRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: skillName,
          args: buildArgs,
        }, { timeoutMs: 30000 }).catch(() => null);
        const buildPayload = buildRes?.data || buildRes || {};
        if (buildPayload?.ok) {
          if (buildPayload.agentId && buildPayload.agentId !== spec.agentId) {
            logger.warn(`[Node:PreflightAgents] Agent ID mismatch: requested "${spec.agentId}" but builder created "${buildPayload.agentId}" — using actual agentId`);
            spec.agentId = buildPayload.agentId;
          }
          logger.info(`[Node:PreflightAgents] Created ${skillName} agent: ${spec.agentId}`);
        } else {
          const errMsg = buildPayload?.error || 'unknown error';
          logger.warn(`[Node:PreflightAgents] Failed to create ${spec.agentId}: ${errMsg}`);
          const failure = { agentId: spec.agentId, error: errMsg, type: spec.type };
          failedCreates.push(failure);
          // cli.agent returns noCli: true when the LLM lookup found no CLI tool for
          // the service (e.g. a hallucinated "system_time" service). Soft-fail these
          // so planning can fall back to generic shell.run instead of hard-crashing.
          if (spec.type === 'cli' && buildPayload?.noCli === true) {
            noCliFailures.push(failure);
          }
        }
      } catch (err) {
        logger.warn(`[Node:PreflightAgents] Agent creation failed for ${spec.agentId}: ${err.message}`);
        failedCreates.push({ agentId: spec.agentId, error: err.message, type: spec.type });
      }
    }

    if (failedCreates.length > 0) {
      warnings.push({
        type: 'agent_create_failed',
        message: `Failed to create agent(s): ${failedCreates.map(c => c.agentId).join(', ')}`,
      });
      // Hard-fail only when every requested agent failed AND none of the failures
      // were noCli soft-fails. noCli failures mean the resolver hallucinated a CLI
      // service that doesn't exist — planning should fall back to generic shell.run
      // rather than aborting the whole pipeline with "Automation failed".
      const allFailed = failedCreates.length === createAgentSpecs.length;
      const allNoCli = noCliFailures.length === failedCreates.length && noCliFailures.length > 0;
      if (allFailed && !allNoCli) {
        const planError = `I couldn't create the required agent(s): ${failedCreates.map(c => `${c.agentId} (${c.error})`).join('; ')}.`;
        logger.error(`[Node:PreflightAgents] ${planError}`);
        _emitProgress({ type: 'preflight:agent_create_failed', message: planError, failures: failedCreates });
        return {
          ...state,
          preflightDone: true,
          planError,
          preflightResult: {
            warnings,
            agents: agentReadiness,
            agentContextNote: '',
          },
        };
      }
      if (noCliFailures.length > 0) {
        logger.info(`[Node:PreflightAgents] noCli soft-fail for ${noCliFailures.length} agent(s): ${noCliFailures.map(c => c.agentId).join(', ')} — falling back to generic shell.run planning`);
        _emitProgress({
          type: 'preflight:agent_create_skipped',
          message: `No CLI agent available for ${noCliFailures.map(c => c.agentId).join(', ')} — will plan with generic shell commands.`,
          failures: noCliFailures,
        });
        // Drop noCli-failed agents from the selected set so the downstream
        // readiness check ("Selected agents are not ready") doesn't block
        // planning. These agents were never built, so they have no readiness
        // state — planning should proceed with generic shell.run instead.
        for (const f of noCliFailures) {
          selectedAgentIds.delete(String(f.agentId).toLowerCase());
        }
      }
    }

  }

  // ── Pre-inject newly-created browser agents into agentReadiness ─────────────
  // The agent.list call inside Promise.all runs concurrently and may miss agents
  // that were just registered by build_agent (DB flush delay / race). Pre-populating
  // here guarantees every newly-created browser agent enters the auth loop.
  for (const spec of createAgentSpecs) {
    if (spec.type !== 'browser') continue;
    const _newAgentId = spec.agentId.endsWith('.agent') ? spec.agentId : `${spec.agentId}.agent`;
    agentReadiness.push({
      type: 'browser',
      agentId: _newAgentId,
      ready: true,
      authed: false,
      authType: 'browser_oauth',
      iconUrl: agentIdToIconUrl(_newAgentId),
      startUrl: spec.startUrl || null,
      needsLogin: true,
      sessionStale: false,
      _newlyCreated: true,
    });
  }

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
      if (!_shouldRunCliPreflight) return;
      try {
        _emitProgress({
          type: 'preflight:building_agent',
          agentType: _isGenericPreflight ? 'preflight' : 'cli',
          agentId: _isGenericPreflight ? 'preflight' : 'cli.preflight',
          message: _isGenericPreflight ? 'Checking tools and authentication...' : 'Checking CLI tools and authentication...',
          iconUrl: null,
        });

        // Helper: enrich missing setupInfo via web.agent discover_setup (fallback only)
        // --help discovery is already done in cli.agent preflight_check, so web search
        // is only needed when setupInfo is still incomplete AND the CLI isn't installed.
        const _enrichSetupInfo = async (existingSetupInfo, service, cliTool, isInstalled) => {
          // If --help already provided authCmd or initCmd + instructions, that's enough
          if (existingSetupInfo && (existingSetupInfo.authCmd || existingSetupInfo.initCmd) && existingSetupInfo.instructions) {
            return existingSetupInfo;
          }
          // Only do web search for CLIs that aren't installed (can't run --help)
          // or when --help didn't yield enough info
          if (isInstalled && existingSetupInfo && (existingSetupInfo.authCmd || existingSetupInfo.initCmd)) {
            return existingSetupInfo; // --help gave us the key commands, good enough
          }
          try {
            const dsRes = await mcpAdapter.callService('command', 'command.automate', {
              skill: 'web.agent',
              args: { action: 'discover_setup', service, cliTool },
            }, { timeoutMs: 8000 }).catch(() => null);
            const ds = dsRes?.data || dsRes;
            if (ds?.ok && ds.setupInfo) {
              // Merge: existing values take priority, fill missing from discovery
              return { ...(ds.setupInfo || {}), ...(existingSetupInfo || {}) };
            }
          } catch (_) {}
          return existingSetupInfo;
        };

        // Helper: generate specific reason message from authStatus + setupInfo
        const _buildReason = (service, cli, authStatus, setupInfo) => {
          const creds = setupInfo?.credentials || [];
          const cmd = setupInfo?.initCmd || setupInfo?.authCmd;
          if (authStatus === 'oauth_required' || creds.includes('oauth')) {
            return `${service} requires OAuth client ID and secret${cmd ? ` — run '${cmd}' to configure` : ''}`;
          }
          if (authStatus === 'api_key_required' || creds.includes('api_key')) {
            return `${service} requires API key${cmd ? ` — run '${cmd}' to configure` : ''}`;
          }
          if (authStatus === 'init_required' || setupInfo?.initCmd) {
            return `${service} needs initialization — run '${setupInfo.initCmd}' to configure`;
          }
          if (authStatus === 'not_installed') {
            return `${service} CLI tool (${cli}) is not installed`;
          }
          if (authStatus === 'not_authenticated') {
            return `${service} CLI tool (${cli}) is installed but not authenticated${cmd ? ` — run '${cmd}'` : ''}`;
          }
          if (authStatus === 'token_expired') {
            return `${service} CLI tool (${cli}) token has expired — re-authentication required${cmd ? ` — run '${cmd}'` : ''}`;
          }
          return `${service} CLI tool (${cli}) is installed but not authenticated${cmd ? ` — run '${cmd}'` : ''}`;
        };

        const pfRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'cli.agent',
          args: {
            action: 'preflight_check',
            task: userMessage,
            ...(Array.isArray(_selectedCliAgents) && _selectedCliAgents.length > 0
              ? { agents: _selectedCliAgents.map(a => ({
                  id:            a.id,
                  service:       a.service || (a.id || '').replace(/\.agent$/, ''),
                  cliTool:       a.cli_tool || a.cliTool || null,
                  setupInfo:     _parseSetupInfo(a.descriptor),
                })) }
              : {}),
          },
        }, { timeoutMs: 5000 }).catch(() => null);
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
                const _agentId = c.agentId || `${c.service}.agent`;
                const _enrichedSetupInfo = await _enrichSetupInfo(c.setupInfo, c.service, c.cli, false);
                const _reason = _buildReason(c.service, c.cli, c.authStatus, _enrichedSetupInfo);
                agentReadiness.push({ type: 'cli', agentId: _agentId, ready: false, authed: false, iconUrl, service: c.service, reason: _reason, setupInfo: _enrichedSetupInfo });
                // Surface API-key or OAuth requirements to the UI during preflight.
                if (c.isApiKey || c.isOAuth) {
                  _emitProgress({
                    type: 'preflight:auth_required',
                    agentId: _agentId,
                    serviceName: c.service,
                    authType: 'cli_setup',
                    iconUrl,
                    message: `${c.service} needs configuration`,
                    reason: _reason,
                    setupInfo: _enrichedSetupInfo,
                  });
                }
                continue;
              }
              if (!c.installed) {
                const installCmd = c.installMethod === 'npm' ? `npm install -g ${c.installPkg}` : `brew install ${c.installPkg || c.cli}`;
                lines.push(`${c.service}: ${c.cli} NOT INSTALLED — install: ${installCmd}`);
                const _agentId = c.agentId || `${c.service}.agent`;
                const _enrichedSetupInfo = await _enrichSetupInfo(c.setupInfo, c.service, c.cli, false);
                const _reason = _buildReason(c.service, c.cli, 'not_installed', _enrichedSetupInfo);
                agentReadiness.push({ type: 'cli', agentId: _agentId, ready: false, authed: false, iconUrl, service: c.service, reason: _reason, setupInfo: _enrichedSetupInfo });
                // Surface CLI install requirement to the UI during preflight.
                _emitProgress({
                  type: 'preflight:auth_required',
                  agentId: _agentId,
                  serviceName: c.service,
                  authType: 'cli_setup',
                  iconUrl,
                  message: `${c.service} needs configuration`,
                  reason: _reason,
                  setupInfo: _enrichedSetupInfo,
                });
              } else {
                const authNote = c.authUser ? ` — authenticated as ${c.authUser}` : (c.authStatus === 'authenticated' ? ' — authenticated' : (c.authStatus === 'configured' ? ' — configured' : ''));
                lines.push(`${c.service}: ${c.cli} installed${authNote} ✓ — use cli.agent { action: 'run', agentId: '${c.service}.agent', task: '...' }`);
                const authed = !!c.authUser || c.authStatus === 'authenticated' || c.authStatus === 'configured';
                const _agentId = c.agentId || `${c.service}.agent`;
                const _enrichedSetupInfo = await _enrichSetupInfo(c.setupInfo, c.service, c.cli, true);
                agentReadiness.push({ type: 'cli', agentId: _agentId, ready: true, authed, iconUrl, service: c.service, setupInfo: _enrichedSetupInfo });

                if (!authed) {
                  const _reason = _buildReason(c.service, c.cli, c.authStatus, _enrichedSetupInfo);
                  // Emit auth required for CLI setup — redirect to Agents tab
                  _emitProgress({
                    type: 'preflight:auth_required',
                    agentId: _agentId,
                    serviceName: c.service,
                    authType: 'cli_setup',
                    iconUrl,
                    message: `${c.service} agent`,
                    reason: _reason,
                    setupInfo: _enrichedSetupInfo,
                  });
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
        const allAgents = agRes?.data || agRes || [];
        // Filter to task-relevant agents only — don't check auth for agents
        // the user's task doesn't need (e.g. youtube when sending gmail).
        // If resolveAgent selected agents, always include those regardless of task text.
        const taskLower = userMessage.toLowerCase();
        const chosenSvc = (state.chosenService || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const agents = Array.isArray(allAgents) ? allAgents.filter(a => {
          if (a.type !== 'browser' && a.type !== 'cli' && a.type !== 'api_key' && a.type !== 'bearer' && a.type !== 'basic') return true; // keep non-agent entries
          const idLower = (a.id || '').toLowerCase();
          const svcKey = idLower.replace('.agent', '').replace(/[^a-z0-9]/g, '');
          if (selectedAgentIds.size > 0 && selectedAgentIds.has(idLower)) return true;
          if (chosenSvc && svcKey === chosenSvc) return true;
          if (taskLower.includes(svcKey)) return true;
          return false;
        }) : [];
        if (Array.isArray(agents) && agents.length > 0) {
          const agentLines = [];
          const trainedRecipeLines = [];

          for (const a of agents) {
            // Skip agents already pre-injected (newly created) to avoid duplicate auth checks
            if (agentReadiness.some(r => r._newlyCreated && r.agentId === a.id)) continue;
            const _agentBaseDesc = `${a.type} agent${a.start_url ? ` (starts at ${a.start_url})` : ''}${Array.isArray(a.capabilities) ? ` — capabilities: ${a.capabilities.slice(0, 5).join(', ')}` : ''}`;
            const svc = (a.id || '').replace('.agent', '').toLowerCase();
            if (svc) _registeredAgentServiceMap[svc] = a.id;

            // ── Fetch trained recipes for this agent ─────────────────────
            if (a.type === 'browser' || a.type === 'cli') {
              try {
                const tsRes = await mcpAdapter.callService('command', 'command.automate', {
                  skill: 'trainer.agent',
                  args: { action: 'list_skills', agentId: svc }
                }, { timeoutMs: 3000 }).catch(() => null);
                const allSkills = tsRes?.data?.skills || tsRes?.skills || [];
                const skills = allSkills.filter(s => _allowAutoGeneratedRecipes || s?.autoGenerated !== true);
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

            // ── Browser agent auth check (session profile + cookie validity) ──
            // NOTE: agentLines.push() is deferred to after auth is determined below
            if (a.type === 'browser') {
              const iconUrl = agentIdToIconUrl(a.id);
              const BROWSER_PROFILES_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
              const svcKey = (a.id || '').replace('.agent', '').toLowerCase();
              const profileDir = `${svcKey}_agent`;
              const profilePath = path.join(BROWSER_PROFILES_DIR, profileDir);
              const hasSession = fs.existsSync(profilePath);

              // Check cookie file age for session validity
              // Chrome persistent profiles store cookies under Default/Cookies
              let sessionStale = false;
              if (hasSession) {
                try {
                  const cookieFile = path.join(profilePath, 'Default', 'Cookies');
                  if (fs.existsSync(cookieFile)) {
                    const stat = fs.statSync(cookieFile);
                    const ageMs = Date.now() - stat.mtimeMs;
                    if (ageMs > BROWSER_SESSION_MAX_AGE_MS) {
                      sessionStale = true;
                      warnings.push({
                        type: 'browser_session_stale',
                        message: `${a.id} session cookies last modified ${Math.round(ageMs / (24*60*60*1000))}d ago — may need re-auth`,
                      });
                    }
                  }
                } catch (_) {}
              }

              // Trust the Chrome persistent profile as the source of truth.
              // If DuckDB has an authed_at record, the agent was previously authenticated
              // and the session persists until the service itself expires it (detected
              // during task execution, not during preflight). No arbitrary expiration timer.
              const _cachedAuth = _getCachedAuth(a.id);
              const authed = _cachedAuth?.authed === true || !!a.authedAt;
              const _authTag = authed ? '' : ' [NEEDS AUTH — user must authenticate before this agent can run]';
              agentLines.push(`- ${a.id}: ${_agentBaseDesc}${_authTag}`);

              const _agentAuthType = _deriveAgentAuthType(a.descriptor);
              agentReadiness.push({
                type: 'browser',
                agentId: a.id,
                ready: true,
                authed,
                authType: _agentAuthType,
                iconUrl,
                startUrl: a.start_url,
                needsLogin: !hasSession,
                sessionStale,
                authedAt: a.authedAt || null,
              });
            } else if (a.type === 'api_key' || a.type === 'bearer' || a.type === 'basic') {
              // Credential agents are not browser-authenticated; they need a stored token.
              const iconUrl = agentIdToIconUrl(a.id);
              const svcKey = (a.id || '').replace('.agent', '').toLowerCase();
              agentLines.push(`- ${a.id}: ${_agentBaseDesc} [NEEDS CREDENTIAL]`);
              agentReadiness.push({
                type: a.type,
                agentId: a.id,
                ready: true,
                authed: false,
                authType: a.type,
                iconUrl,
                startUrl: a.start_url,
                needsLogin: true,
              });
              _emitProgress({
                type: 'preflight:auth_required',
                agentId: a.id,
                serviceName: svcKey,
                authType: a.type,
                iconUrl,
                message: `${a.id} requires ${a.type} credentials before planning`,
              });
            } else if (a.type === 'cli') {
              // CLI agents already handled in preflight_check above
              // Stale agent detection: registered CLI agent whose CLI is no longer installed
              const svcKey = (a.id || '').replace('.agent', '').toLowerCase();
              const cliInfo = _preflightCliMap[svcKey];
              const _cliAuthed = cliInfo ? (!!cliInfo.authUser || cliInfo.authStatus === 'authenticated') : false;
              const _cliAuthTag = _cliAuthed ? '' : ' [NEEDS AUTH]';
              agentLines.push(`- ${a.id}: ${_agentBaseDesc}${_cliAuthTag}`);
              if (cliInfo && !cliInfo.hasCli) {
                const iconUrl = agentIdToIconUrl(a.id);
                agentReadiness.push({
                  type: 'cli',
                  agentId: a.id,
                  ready: false,
                  authed: false,
                  iconUrl,
                  service: svcKey,
                  reason: 'stale — CLI no longer installed',
                  stale: true,
                });
                warnings.push({
                  type: 'stale_agent',
                  message: `${a.id} registered but its CLI is no longer detected — consider rebuilding or removing`,
                });
              }
            } else {
              // Other agent types — push without auth tag
              agentLines.push(`- ${a.id}: ${_agentBaseDesc}`);
            }
          }

          agentContextNote = `\n\nREGISTERED AGENTS (use browser.agent { action: "run", agentId: "<id>", task: "..." } for these — do NOT use raw browser.act navigate):\n${agentLines.join('\n')}`;

          if (trainedRecipeLines.length > 0) {
            agentContextNote += `\n\nTRAINED RECIPES (when user mentions these, use browser.agent/cli.agent — NOT external.skill):\n${trainedRecipeLines.join('\n')}`;
          }
        }
      } catch (_) {}
    })(),

    // ── Installed skills list + orphan sweep ────────────────────────────
    (async () => {
      try {
        const ilRes = await mcpAdapter.callService('user-memory', 'skill.list', {}, { timeoutMs: 3000 }).catch(() => null);
        const il = ilRes?.data || ilRes || [];
        if (Array.isArray(il)) {
          installedSkillsList = il;
          // Sweep: find skills registered in user-memory that have no file on disk.
          // Checks 3 directory name forms (dot, underscore, kebab) to match external.skill.cjs.
          const SKILLS_BASE_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');
          for (const skill of installedSkillsList) {
            const name = skill.name || skill.id;
            if (!name) continue;
            const candidates = [
              name,
              name.replace(/\./g, '_'),
              name.replace(/\./g, '-'),
            ];
            const exists = candidates.some(c => {
              const d = path.join(SKILLS_BASE_DIR, c);
              return fs.existsSync(path.join(d, 'index.cjs')) ||
                     fs.existsSync(path.join(d, 'index.py')) ||
                     fs.existsSync(path.join(d, 'skill.md')) ||
                     fs.existsSync(path.join(d, 'api.json')) ||
                     fs.existsSync(path.join(d, 'cli.json'));
            });
            if (!exists) orphanedSkills.push(name);
          }
          if (orphanedSkills.length > 0) {
            warnings.push({
              type: 'orphaned_skills',
              message: `Skills registered but missing on disk: ${orphanedSkills.join(', ')}`,
            });
            orphanedSkillsNote = `\n\nORPHANED SKILLS (registered in user-memory but NO file on disk — do NOT use external.skill for these): ${orphanedSkills.join(', ')}\nFor these skills, use browser.agent or cli.agent instead of external.skill.`;
            logger.warn(`[Node:PreflightAgents] Orphaned skills detected (${orphanedSkills.length}): ${orphanedSkills.join(', ')}`);
          }
        }
      } catch (_) {}
    })(),

    // ── vet CLI presence check + auto-install ────────────────────────────
    (async () => {
      try {
        vetPath = _whichSync('vet');
        vetAvailable = !!vetPath;

        if (!vetAvailable) {
          // Check if a previous install attempt failed — skip retrying until cache expires (7 days)
          const pfState = _loadPreflightState();
          const failedInstalls = pfState.failedInstalls || {};
          const vetFailedAt = failedInstalls['vet'];
          const INSTALL_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
          if (vetFailedAt && (Date.now() - new Date(vetFailedAt).getTime()) < INSTALL_RETRY_MS) {
            logger.info(`[Node:PreflightAgents] vet install previously failed (${vetFailedAt}) — skipping retry for 7 days`);
            warnings.push({ type: 'vet_not_installed', message: 'vet CLI not installed — install with: brew tap vet-run/vet && brew install vet-run' });
            vetAvailable = false;
          } else {

          logger.info('[Node:PreflightAgents] vet CLI not found — attempting auto-install');

          // Step A: Try brew install
          const brewPath = _whichSync('brew');
          if (brewPath) {
            _emitProgress({
              type: 'preflight:building_agent',
              agentType: 'cli',
              agentId: 'vet',
              message: 'Installing vet CLI via Homebrew...',
              iconUrl: null,
            });
            try {
              const { execSync } = require('child_process');
              execSync('brew tap vet-run/vet', { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
              execSync('brew install vet-run/vet/vet-run', { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
              vetPath = _whichSync('vet');
              vetAvailable = !!vetPath;
              if (vetAvailable) {
                logger.info(`[Node:PreflightAgents] vet CLI installed via brew at ${vetPath}`);
              }
            } catch (brewErr) {
              logger.warn(`[Node:PreflightAgents] vet brew install failed: ${brewErr.message}`);
            }
          }

          // Step B: Script download + UI approval (brew unavailable or failed)
          if (!vetAvailable) {
            const { execSync } = require('child_process');
            const tmpFile = path.join(os.tmpdir(), `vet-install-${Date.now()}.sh`);
            try {
              execSync(`curl -fsSL https://getvet.sh/install.sh -o ${tmpFile}`, { encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
              const scriptContent = fs.readFileSync(tmpFile, 'utf8');

              if (confirmInstallCallback) {
                _emitProgress({
                  type: 'preflight:vet_script_review',
                  scriptContent,
                  scriptUrl: 'https://getvet.sh/install.sh',
                  tempPath: tmpFile,
                  message: 'vet CLI requires manual installation. Please review the install script below.',
                });
                const approved = await confirmInstallCallback('vet');
                if (approved) {
                  _emitProgress({
                    type: 'preflight:building_agent',
                    agentType: 'cli',
                    agentId: 'vet',
                    message: 'Installing vet CLI from reviewed script...',
                    iconUrl: null,
                  });
                  // Use INSTALL_DIR to target Homebrew's writable bin (avoids /usr/local/bin permission error on macOS)
                  const brewBin = _whichSync('brew');
                  const installDir = brewBin ? require('path').dirname(brewBin) : '/usr/local/bin';
                  execSync(`INSTALL_DIR=${installDir} sh ${tmpFile}`, { encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
                  vetPath = _whichSync('vet');
                  vetAvailable = !!vetPath;
                  if (vetAvailable) {
                    logger.info(`[Node:PreflightAgents] vet CLI installed via script at ${vetPath}`);
                  } else {
                    logger.warn('[Node:PreflightAgents] vet script install completed but vet not found in PATH');
                  }
                } else {
                  logger.info('[Node:PreflightAgents] User declined vet script install');
                }
              } else {
                // No callback available (bridge mode, etc.) — skip auto-install
                logger.info('[Node:PreflightAgents] No confirmInstallCallback — cannot prompt for vet script approval');
              }
            } catch (scriptErr) {
              logger.warn(`[Node:PreflightAgents] vet script download/install failed: ${scriptErr.message}`);
            } finally {
              try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
            }
          }

          // Step C: Fallback warning if still not installed
          if (!vetAvailable) {
            warnings.push({
              type: 'vet_not_installed',
              message: 'vet CLI not installed — secure script installation unavailable. Install with: brew tap vet-run/vet && brew install vet-run',
            });
            _emitProgress({
              type: 'preflight:auth_required',
              agentId: 'vet',
              serviceName: 'vet',
              authType: 'cli_install',
              iconUrl: null,
              message: 'vet CLI not installed — recommended for secure installations: brew tap vet-run/vet && brew install vet-run',
            });
            // Cache the install failure so we don't retry every run (7-day cooldown)
            try {
              const _pfStateCurrent = _loadPreflightState();
              _savePrefflightState({
                ..._pfStateCurrent,
                failedInstalls: { ...(_pfStateCurrent.failedInstalls || {}), vet: new Date().toISOString() },
              });
            } catch (_) {}
          }
          } // close else (not in cooldown period)
        }

        logger.info(`[Node:PreflightAgents] vet CLI: ${vetAvailable ? 'installed at ' + vetPath : 'NOT INSTALLED'}`);
      } catch (vetBlockErr) {
        logger.warn(`[Node:PreflightAgents] vet auto-install block error: ${vetBlockErr.message}`);
      }
    })(),

    // ── MCP service health check ─────────────────────────────────────────
    (async () => {
      try {
        const services = ['command', 'user-memory'];
        for (const svc of services) {
          try {
            await mcpAdapter.callService(svc, 'ping', {}, { timeoutMs: 2000 });
          } catch (_) {}
        }
      } catch (_) {}
    })(),

    // ── PATH health check ────────────────────────────────────────────────
    (async () => {
      try {
        const envPath = process.env.PATH || '';
        const criticalPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
        const missing = criticalPaths.filter(p => !envPath.includes(p));
        if (missing.length > 0) {
          warnings.push({
            type: 'path_issue',
            message: `PATH missing critical directories: ${missing.join(', ')}. Some CLIs may not be found.`,
          });
          logger.warn(`[Node:PreflightAgents] PATH missing: ${missing.join(', ')}`);
        }
      } catch (_) {}
    })(),

    // ── Monthly CLI version validation ───────────────────────────────────
    (async () => {
      if (recoveryContext) return;
      try {
        const pfState = _loadPreflightState();
        const now = Date.now();
        const lastVal = pfState.lastValidatedAt ? new Date(pfState.lastValidatedAt).getTime() : 0;
        const needsValidation = (now - lastVal) > VALIDATION_INTERVAL_MS;

        if (!needsValidation) {
          logger.info(`[Node:PreflightAgents] Monthly validation skipped — last validated ${pfState.lastValidatedAt}`);
          return;
        }

        _emitProgress({
          type: 'preflight:building_agent',
          agentType: 'cli',
          agentId: 'cli.validation',
          message: 'Monthly CLI validation running...',
          iconUrl: null,
        });

        // Get current CLI versions from preflight_check
        const pfRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'cli.agent',
          args: { action: 'preflight_check', task: userMessage },
        }, { timeoutMs: 8000 }).catch(() => null);
        const pf = pfRes?.data || pfRes;
        if (!pf?.ok || !Array.isArray(pf.detectedClis)) {
          logger.warn('[Node:PreflightAgents] Monthly validation: preflight_check returned no data');
          return;
        }

        const currentVersions = {};
        const driftedClis = [];
        for (const c of pf.detectedClis) {
          if (c.installed && c.cli && c.version) {
            const svcKey = c.service.toLowerCase();
            currentVersions[svcKey] = c.version;
            const prevVersion = pfState.cliVersions?.[svcKey];
            if (prevVersion && prevVersion !== c.version) {
              driftedClis.push({ service: svcKey, cli: c.cli, oldVersion: prevVersion, newVersion: c.version });
            }
          }
        }

        // For each drifted CLI, call validate_agent to check health
        for (const drifted of driftedClis) {
          const agentId = `${drifted.service}.agent`;
          const iconUrl = serviceToIconUrl(drifted.service);
          logger.info(`[Node:PreflightAgents] Version drift: ${drifted.cli} ${drifted.oldVersion} → ${drifted.newVersion}`);
          try {
            const valRes = await mcpAdapter.callService('command', 'command.automate', {
              skill: 'cli.agent',
              args: { action: 'validate_agent', id: agentId },
            }, { timeoutMs: 30000 }).catch(() => null);
            const val = valRes?.data || valRes;
            if (val?.verdict && val.verdict !== 'healthy') {
              _emitProgress({
                type: 'preflight:auth_required',
                agentId,
                serviceName: drifted.service,
                authType: 'cli_update_needed',
                iconUrl,
                message: `${drifted.cli} updated (${drifted.oldVersion} → ${drifted.newVersion}) — validation: ${val.verdict}`,
              });
              warnings.push({
                type: 'cli_version_drift',
                message: `${drifted.cli} (${drifted.service}): ${drifted.oldVersion} → ${drifted.newVersion} — validate_agent: ${val.verdict}`,
              });
            }
          } catch (valErr) {
            logger.warn(`[Node:PreflightAgents] validate_agent failed for ${agentId}: ${valErr.message}`);
          }
        }

        // Update state file with current versions + timestamp
        _savePrefflightState({
          lastValidatedAt: new Date().toISOString(),
          cliVersions: { ...pfState.cliVersions, ...currentVersions },
        });
        logger.info(`[Node:PreflightAgents] Monthly validation complete: ${Object.keys(currentVersions).length} CLIs checked, ${driftedClis.length} drifted`);
      } catch (valErr) {
        logger.warn(`[Node:PreflightAgents] Monthly validation error: ${valErr.message}`);
      }
    })(),

    // ── Ad-block list refresh (every N days, configurable via ADBLOCK_REFRESH_DAYS) ──
    (async () => {
      try {
        const result = await mcpAdapter.callService('command', 'adblock.refresh', {}, { timeoutMs: 30000 });
        const r = result?.data || result;
        if (r?.refreshed) {
          logger.info(`[Node:PreflightAgents] Ad-block list refreshed: ${r.count} domains (${r.source})`);
        }
      } catch (_) {}
    })(),

    // ── yt-dlp system dependency check + auto-install ────────────────────
    // video.agent uses yt-dlp to extract subtitles without downloading video.
    // Auto-install/upgrade silently so new open-source installs work out of the box.
    (async () => {
      try {
        const { execSync } = require('child_process');
        const INSTALL_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        const pfState = _loadPreflightState();
        const failedInstalls = pfState.failedInstalls || {};

        // Detect current yt-dlp state
        let ytdlpInstalled = false;
        let ytdlpStale = false;
        try {
          const verOut = execSync('yt-dlp --version 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
          // version format: "2026.06.09"
          const m = verOut.match(/(\d{4})\.(\d{2})\.(\d{2})/);
          if (m) {
            ytdlpInstalled = true;
            const vDate = new Date(`${m[1]}-${m[2]}-${m[3]}`);
            const ageDays = Math.floor((Date.now() - vDate.getTime()) / 86400000);
            ytdlpStale = ageDays > 60;
            logger.info(`[Node:PreflightAgents] yt-dlp version ${verOut} (${ageDays}d old)${ytdlpStale ? ' — stale, will upgrade' : ' ✓'}`);
          }
        } catch (_) {
          ytdlpInstalled = false;
        }

        if (!ytdlpInstalled) {
          // Check 7-day cooldown
          const ytdlpFailedAt = failedInstalls['ytdlp'];
          if (ytdlpFailedAt && (Date.now() - new Date(ytdlpFailedAt).getTime()) < INSTALL_RETRY_MS) {
            logger.info(`[Node:PreflightAgents] yt-dlp install previously failed (${ytdlpFailedAt}) — skipping retry for 7 days`);
            warnings.push({ type: 'ytdlp_not_installed', message: 'yt-dlp not installed — install with: pip3 install yt-dlp' });
            return;
          }

          logger.info('[Node:PreflightAgents] yt-dlp not found — attempting pip3 install...');
          try {
            execSync('pip3 install yt-dlp --quiet --user', { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
            logger.info('[Node:PreflightAgents] yt-dlp installed successfully via pip3');
          } catch (installErr) {
            logger.warn(`[Node:PreflightAgents] yt-dlp pip3 install failed: ${installErr.message?.slice(0, 100)}`);
            warnings.push({ type: 'ytdlp_not_installed', message: 'yt-dlp could not be installed — run: pip3 install yt-dlp' });
            // Cache the failure so we skip retrying for 7 days
            try {
              _savePrefflightState({ ...pfState, failedInstalls: { ...failedInstalls, ytdlp: new Date().toISOString() } });
            } catch (_) {}
          }
        } else if (ytdlpStale) {
          logger.info('[Node:PreflightAgents] yt-dlp is stale — upgrading via pip3...');
          try {
            execSync('pip3 install --upgrade yt-dlp --quiet', { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
            logger.info('[Node:PreflightAgents] yt-dlp upgraded successfully');
          } catch (upgradeErr) {
            logger.warn(`[Node:PreflightAgents] yt-dlp pip3 upgrade failed (non-fatal): ${upgradeErr.message?.slice(0, 100)}`);
          }
        }
      } catch (ytdlpBlockErr) {
        logger.warn(`[Node:PreflightAgents] yt-dlp check block error: ${ytdlpBlockErr.message}`);
      }
    })(),

    // ── Tool discovery pre-flight ───────────────────────────────────────
    // Assesses whether browser.agent can handle the task well; if not,
    // searches for external AI tools and injects a note for the planner.
    // Skip when resolveAgent already selected (or created) agents — avoid inventing fake tools.
    (async () => {
      if (recoveryContext) return;
      if (!userMessage || userMessage.length < 10) return;
      if (selectedAgentIds.size > 0) {
        logger.info('[Node:PreflightAgents] resolveAgent selected agents — skipping tool discovery');
        return;
      }
      try {
        // Step 1: Assess — can browser.agent do this task well?
        const assessRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'tool.discover',
          args: { action: 'assess', task: userMessage },
        }, { timeoutMs: 12000 }).catch(() => null);

        const assess = assessRes?.data || assessRes;
        if (!assess?.ok || !assess?.shouldDelegate) return;

        logger.info(`[Node:PreflightAgents] Tool discovery: shouldDelegate=true (${assess.reason})`);

        // Step 2: Recall — check for cached tool (playbook)
        const recallRes = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'tool.discover',
          args: { action: 'recall', task: userMessage },
        }, { timeoutMs: 5000 }).catch(() => null);

        const recall = recallRes?.data || recallRes;
        let bestTool = recall?.ok ? recall.tool : null;

        // Step 3: Discover — web search for best tool (if no cache)
        if (!bestTool) {
          _emitProgress({
            type: 'preflight:building_agent',
            agentType: 'tool_discover',
            agentId: 'tool.discover',
            message: 'Searching for AI tools that can help with this task...',
            iconUrl: null,
          });

          const discoverRes = await mcpAdapter.callService('command', 'command.automate', {
            skill: 'tool.discover',
            args: { action: 'discover', task: userMessage },
          }, { timeoutMs: 25000 }).catch(() => null);

          const discover = discoverRes?.data || discoverRes;
          if (!discover?.ok) return;

          // Paid tool → ASK_USER
          if (discover.askUser) {
            _emitProgress({
              type: 'preflight:tool_approval',
              tools: discover.tools,
              message: 'Only paid AI tools found — user approval needed',
            });
            // Still inject a note so the planner can surface the question
            const toolList = (discover.tools || []).map(t => `- ${t.name}: ${t.url} (${t.tier})`).join('\n');
            discoveredToolNote = `\n\nDISCOVERED AI TOOLS (PAID — user approval needed before proceeding):\n${toolList}\n\nAsk the user which tool to use, or if they want to proceed with a paid tool.`;
            return;
          }

          bestTool = discover.bestTool || null;
        }

        if (bestTool) {
          const tierLabel = bestTool.tier === 'free_no_account' ? 'free, no account'
            : bestTool.tier === 'free_account' ? 'free, account needed'
            : bestTool.tier === 'free_no_auth' ? 'free CLI, no auth'
            : bestTool.tier === 'free_api_key' ? 'free CLI, API key needed'
            : 'paid';

          const agentSkill = bestTool.type === 'cli' ? 'cli.agent' : 'browser.agent';
          discoveredToolNote = `\n\nDISCOVERED AI TOOL (use this tool for the task — browser.agent cannot do it well):\n` +
            `Tool: ${bestTool.name}\nURL: ${bestTool.url}\nType: ${bestTool.type}\nTier: ${tierLabel}\n` +
            `Usage: ${bestTool.howToUse || 'Navigate to the tool and interact with it.'}\n` +
            `Plan: ${agentSkill} { action: 'build_agent', service: '${bestTool.serviceName}' } then ${agentSkill} { action: 'run', agentId: '${bestTool.serviceName}.agent', task: '...' }`;

          _emitProgress({
            type: 'preflight:building_agent',
            agentType: bestTool.type,
            agentId: `${bestTool.serviceName}.agent`,
            message: `Found AI tool: ${bestTool.name} (${tierLabel})`,
            iconUrl: bestTool.iconUrl || null,
          });

          logger.info(`[Node:PreflightAgents] Tool discovery: found ${bestTool.name} (${bestTool.tier}) at ${bestTool.url}`);
        }
      } catch (e) {
        logger.warn(`[Node:PreflightAgents] Tool discovery error: ${e.message}`);
      }
    })(),

    // ── ffmpeg system dependency check + auto-install ─────────────────────
    // yt-dlp uses ffmpeg for subtitle conversion. Also used by video processing skills.
    // Detects both missing AND broken installs (dylib drift on macOS) and auto-fixes.
    (async () => {
      try {
        const { execSync } = require('child_process');
        const INSTALL_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        const pfState = _loadPreflightState();
        const failedInstalls = pfState.failedInstalls || {};

        // Detect current ffmpeg state: check both presence AND runtime health
        let ffmpegMissing = false;
        let ffmpegBroken = false;
        const ffmpegPath = _whichSync('ffmpeg');

        if (!ffmpegPath) {
          ffmpegMissing = true;
        } else {
          // Binary exists — test it actually runs (dylib errors show up here)
          try {
            execSync(`${ffmpegPath} -version`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
            logger.info(`[Node:PreflightAgents] ffmpeg ✓ (${ffmpegPath})`);
          } catch (testErr) {
            const errText = (testErr.stderr || testErr.message || '').toLowerCase();
            if (/library not loaded|dylib|no such file|symbol not found/i.test(errText)) {
              ffmpegBroken = true;
              logger.warn(`[Node:PreflightAgents] ffmpeg binary broken (dylib error) at ${ffmpegPath} — will reinstall`);
            } else {
              // Some other error — still log but don't attempt reinstall
              logger.warn(`[Node:PreflightAgents] ffmpeg test failed (non-dylib): ${errText.slice(0, 120)}`);
            }
          }
        }

        if (!ffmpegMissing && !ffmpegBroken) return; // healthy

        // Check 7-day cooldown
        const ffmpegFailedAt = failedInstalls['ffmpeg'];
        if (ffmpegFailedAt && (Date.now() - new Date(ffmpegFailedAt).getTime()) < INSTALL_RETRY_MS) {
          logger.info(`[Node:PreflightAgents] ffmpeg install previously failed (${ffmpegFailedAt}) — skipping retry for 7 days`);
          warnings.push({ type: 'ffmpeg_not_installed', message: 'ffmpeg not available — install with: brew install ffmpeg' });
          return;
        }

        const brewPath = _whichSync('brew');
        if (!brewPath) {
          warnings.push({ type: 'ffmpeg_not_installed', message: 'ffmpeg not available and brew not found — install Homebrew then run: brew install ffmpeg' });
          return;
        }

        const installCmd = ffmpegBroken ? 'brew reinstall ffmpeg' : 'brew install ffmpeg';
        const logVerb = ffmpegBroken ? 'Reinstalling broken' : 'Installing missing';
        logger.info(`[Node:PreflightAgents] ${logVerb} ffmpeg via: ${installCmd}`);

        try {
          execSync(installCmd, { encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
          logger.info(`[Node:PreflightAgents] ffmpeg ${ffmpegBroken ? 'reinstalled' : 'installed'} successfully`);
        } catch (installErr) {
          logger.warn(`[Node:PreflightAgents] ffmpeg ${installCmd} failed: ${installErr.message?.slice(0, 100)}`);
          warnings.push({ type: 'ffmpeg_not_installed', message: `ffmpeg could not be installed — run: ${installCmd}` });
          // Cache failure so we skip retrying for 7 days
          try {
            _savePrefflightState({ ...pfState, failedInstalls: { ...failedInstalls, ffmpeg: new Date().toISOString() } });
          } catch (_) {}
        }
      } catch (ffmpegBlockErr) {
        logger.warn(`[Node:PreflightAgents] ffmpeg check block error: ${ffmpegBlockErr.message}`);
      }
    })(),
  ]);

  // ── Route choice gate (CLI-first) ──────────────────────────────────────────
  // When multiple execution routes (CLI/API, browser, app) are available for
  // the same service, CLI takes precedence. Only surface a choice to the user
  // when CLI is not available or cannot be configured. Browser/app are fallback.
  const preflightRouteChoice = {};
  const _ROUTE_TYPE_MAP = {
    cli_api: ['cli', 'api_key', 'bearer', 'basic'],
    browser: ['browser'],
    app:     ['app'],
  };

  function _svcFromAgent(a) {
    return (a.service || (a.agentId || '').replace(/\.app\.agent$/, '').replace(/\.agent$/, '')).toLowerCase();
  }

  function _routeTypeFromAgent(a) {
    if (['cli', 'api_key', 'bearer', 'basic'].includes(a.type)) return 'cli_api';
    if (a.type === 'browser') return 'browser';
    if (a.type === 'app') return 'app';
    return null;
  }

  {
    const _candidatesByService = new Map();
    for (const a of agentReadiness) {
      if (!a.ready) continue;
      const svcKey = _svcFromAgent(a);
      if (!svcKey) continue;
      const routeType = _routeTypeFromAgent(a);
      if (!routeType) continue;
      if (!_candidatesByService.has(svcKey)) _candidatesByService.set(svcKey, []);
      _candidatesByService.get(svcKey).push({ agent: a, routeType });
    }

    for (const [svcKey, entries] of _candidatesByService) {
      const routeTypes = new Set(entries.map(e => e.routeType));
      if (routeTypes.size <= 1) continue;

      // CLI-first: if a CLI/API route exists, auto-select it and suppress browser/app
      if (routeTypes.has('cli_api')) {
        const cliAgent = entries.find(e => e.routeType === 'cli_api').agent;
        preflightRouteChoice[svcKey] = 'cli_api';
        logger.info(`[Node:PreflightAgents] CLI-first routing for ${svcKey}: auto-selected ${cliAgent.agentId} (suppressing ${[...routeTypes].filter(r => r !== 'cli_api').join(', ')})`);

        // Remove non-CLI routes for this service from agentReadiness
        const keepTypes = _ROUTE_TYPE_MAP['cli_api'] || [];
        for (let i = agentReadiness.length - 1; i >= 0; i--) {
          const a = agentReadiness[i];
          if (_svcFromAgent(a) === svcKey && !keepTypes.includes(a.type)) {
            agentReadiness.splice(i, 1);
          }
        }
        // Update selectedAgentIds
        for (const id of [...selectedAgentIds]) {
          const idSvc = id.replace(/\.app\.agent$/, '').replace(/\.agent$/, '').toLowerCase();
          if (idSvc === svcKey) {
            const stillPresent = agentReadiness.some(a => a.agentId.toLowerCase() === id);
            if (!stillPresent) selectedAgentIds.delete(id);
          }
        }
        selectedAgentIds.add(cliAgent.agentId.toLowerCase());
        continue; // Skip user route choice — CLI is authoritative
      }

      // No CLI route — surface remaining routes to user
      const iconUrl = entries[0].agent.iconUrl || serviceToIconUrl(svcKey);
      const options = [];

      if (routeTypes.has('cli_api')) {
        const c = entries.find(e => e.routeType === 'cli_api').agent;
        options.push({
          route: 'cli_api',
          label: 'CLI/API',
          recommended: true,
          description: 'More reliable, faster execution',
          agentId: c.agentId,
          authType: c.authType || (c.type === 'cli' ? 'cli_token' : c.type),
          requiresSetup: !c.authed,
        });
      }
      if (routeTypes.has('browser')) {
        const c = entries.find(e => e.routeType === 'browser').agent;
        options.push({
          route: 'browser',
          label: 'Browser Agent',
          recommended: false,
          description: 'Uses browser automation, may be slower',
          agentId: c.agentId,
          authType: c.authType || 'browser_oauth',
          requiresSetup: !c.authed,
        });
      }
      if (routeTypes.has('app')) {
        const c = entries.find(e => e.routeType === 'app').agent;
        options.push({
          route: 'app',
          label: 'Desktop App',
          recommended: false,
          description: 'Uses native app automation',
          agentId: c.agentId,
          authType: 'none',
          requiresSetup: false,
          appInstalled: true,
        });
      }

      _emitProgress({
        type: 'preflight:route_choice',
        serviceName: svcKey,
        iconUrl,
        options,
      });

      if (gatherAnswerCallback) {
        try {
          const choiceAnswer = await gatherAnswerCallback(`route_choice:${svcKey}`);
          const chosenRoute = String(choiceAnswer || '').trim().toLowerCase();

          if (chosenRoute && routeTypes.has(chosenRoute)) {
            preflightRouteChoice[svcKey] = chosenRoute;
            logger.info(`[Node:PreflightAgents] Route choice for ${svcKey}: ${chosenRoute}`);

            // Filter agentReadiness to keep only the chosen route for this service
            const keepTypes = _ROUTE_TYPE_MAP[chosenRoute] || [];
            for (let i = agentReadiness.length - 1; i >= 0; i--) {
              const a = agentReadiness[i];
              if (_svcFromAgent(a) === svcKey && !keepTypes.includes(a.type)) {
                agentReadiness.splice(i, 1);
              }
            }

            // Update selectedAgentIds: remove non-chosen, add chosen
            for (const id of [...selectedAgentIds]) {
              const idSvc = id.replace(/\.app\.agent$/, '').replace(/\.agent$/, '').toLowerCase();
              if (idSvc === svcKey) {
                const stillPresent = agentReadiness.some(a => a.agentId.toLowerCase() === id);
                if (!stillPresent) selectedAgentIds.delete(id);
              }
            }
            const chosenAgent = agentReadiness.find(a => _svcFromAgent(a) === svcKey);
            if (chosenAgent) selectedAgentIds.add(chosenAgent.agentId.toLowerCase());
          } else {
            logger.info(`[Node:PreflightAgents] No valid route choice for ${svcKey} — keeping all routes`);
          }
        } catch (choiceErr) {
          logger.warn(`[Node:PreflightAgents] Route choice gather failed for ${svcKey}: ${choiceErr.message}`);
        }
      }
    }
  }

  // ── Browser / credential agent authentication (Phase 1.5) ─────────────────
  // Any selected browser or credential agent that is not authenticated must
  // complete auth BEFORE planning. Browser agents open the browser and wait for
  // OAuth or stored credentials. Credential agents (api_key/bearer/basic) verify
  // a stored token. Planning is blocked until all agents are authenticated or
  // auth fails.
  const _AUTH_AGENT_TYPES = new Set(['browser', 'api_key', 'bearer', 'basic']);
  const browserAgentsNeedingAuth = agentReadiness.filter(
    a => _AUTH_AGENT_TYPES.has(a.type) && !a.authed
  );

  if (browserAgentsNeedingAuth.some(a => a.type === 'browser')) {
    _emitProgress({
      type: 'preflight:building_agent',
      agentType: 'browser',
      agentId: 'browser.preflight',
      message: 'Checking browser authentication sessions...',
      iconUrl: null,
    });
  }

  async function _authenticateBrowserAgent(a) {
    const svcKey = (a.agentId || '').replace(/\.agent$/, '').toLowerCase();
    const iconUrl = a.iconUrl || agentIdToIconUrl(a.agentId);
    try {
      const authRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.agent',
        args: {
          action: 'authenticate',
          agentId: a.agentId,
          task: `Authenticate to ${a.agentId}`,
          url: a.startUrl,
          manualLogin: false,
          preflightProbe: true,
        },
      }, { timeoutMs: 10 * 60 * 1000 }).catch((err) => ({
        ok: false,
        error: `auth check transport error: ${err?.message || 'unknown error'}`,
      }));
      const authPayload = authRes?.data || authRes || {};
      if (!authPayload.ok) {
        _emitProgress({
          type: 'preflight:auth_required',
          agentId: a.agentId,
          serviceName: svcKey,
          authType: a.sessionStale ? 'browser_reauth' : (a.authType || 'browser_oauth'),
          iconUrl,
          message: `${a.agentId} requires ${a.authType && a.authType !== 'browser_oauth' ? a.authType : 'login'} before planning`,
        });
      }
      return authRes;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const authFailures = [];
  for (const a of browserAgentsNeedingAuth) {
    // ── Unauthenticated agent invariant: skip probe, force auth ─────────────
    // An agent that has never been authenticated (authed_at is NULL) has no
    // browser session. This covers both newly built agents and agents built
    // in a previous session where the user cancelled before signing in.
    // The probe can only produce false positives on public landing pages.
    const _forceAuth = a._newlyCreated || !a.authedAt;
    if (_forceAuth) {
      const _svcKey = (a.agentId || '').replace(/\.agent$/, '').toLowerCase();
      const _iconUrl = a.iconUrl || agentIdToIconUrl(a.agentId);
      const _reason = a._newlyCreated ? 'newly built' : 'never authenticated';
      logger.info(`[Node:PreflightAgents] ${a.agentId} is ${_reason} — forcing auth without probe`);
      _emitProgress({
        type: 'preflight:auth_required',
        agentId: a.agentId,
        serviceName: _svcKey,
        authType: a.authType || 'browser_oauth',
        iconUrl: _iconUrl,
        message: `${a.agentId}`,
        _newlyCreated: !!a._newlyCreated,
      });
      a.authed = false;
      a.ready = false;
      a.reason = `${_reason} — authentication required`;
      authFailures.push({ agentId: a.agentId, reason: 'auth required' });
      continue;
    }

    // Emit actual agentId so main.js cancel handler can derive the correct session
    _emitProgress({
      type: 'preflight:auth_starting',
      agentId: a.agentId,
      message: `Authenticating ${a.agentId}...`,
    });
    let attempts = 0;
    let authRes = null;
    while (attempts < 2) {
      authRes = await _authenticateBrowserAgent(a);
      const authPayload = authRes?.data || authRes || {};
      if (authPayload.ok && authPayload.authVerified === true) {
        markAgentAuthed(a.agentId);
        a.authed = true;
        a.ready = true;
        _emitProgress({
          type: 'preflight:agent_ready',
          agentId: a.agentId,
          iconUrl: a.iconUrl || agentIdToIconUrl(a.agentId),
          message: `${a.agentId} authenticated`,
        });
        break;
      }

      if (authPayload.ok && authPayload.authVerified !== true) {
        authRes = { ok: false, error: 'authentication result was not verified by the selected driver' };
        break;
      }

      // Headless preflight probe detected a login wall. The preflight:auth_required
      // event is emitted by _authenticateBrowserAgent; stop retrying so the UI banner
      // can prompt the user to sign in before planning proceeds.
      if (authPayload.authRequired) {
        logger.info(`[Node:PreflightAgents] ${a.agentId} requires browser login — surfacing preflight:auth_required`);
        authRes = { ok: false, authRequired: true, error: authPayload.error || 'auth required' };
        break;
      }

      if (authPayload.askUser) {
        // Credential-style question (email / API key / bearer / basic)
        if (authPayload.needsCredentials) {
          if (!authPayload.credentialKey) {
            logger.warn(`[Node:PreflightAgents] ${a.agentId} requested credentials but did not supply a credentialKey`);
            _emitProgress({
              type: 'preflight:auth_failed',
              agentId: a.agentId,
              message: `${a.agentId} requested credentials but did not provide a storage key.`,
            });
            break;
          }
          if (!gatherCredentialCallback) {
            logger.warn(`[Node:PreflightAgents] ${a.agentId} requires credentials but no gatherCredentialCallback is available`);
            const noCallbackErr = `${a.agentId} requires a credential, but the UI credential prompt is not available.`;
            _emitProgress({
              type: 'preflight:auth_failed',
              agentId: a.agentId,
              message: noCallbackErr,
            });
            authRes = { ok: false, error: noCallbackErr };
            break;
          }
          _emitProgress({
            type: 'gather_credential',
            key: authPayload.credentialKey,
            message: authPayload.question,
          });
          let credentialStored = false;
          try {
            const credResult = await gatherCredentialCallback(authPayload.credentialKey);
            credentialStored = credResult && (credResult.stored === true || credResult.stored === undefined);
          } catch (credErr) {
            logger.warn(`[Node:PreflightAgents] Credential gather failed for ${a.agentId}: ${credErr.message}`);
          }
          if (!credentialStored) {
            logger.warn(`[Node:PreflightAgents] Credential for ${a.agentId} was not stored — aborting auth`);
            _emitProgress({
              type: 'preflight:auth_failed',
              agentId: a.agentId,
              message: `${a.agentId} credential was not provided or not stored.`,
            });
            break;
          }
          attempts++;
          continue;
        }
        // Plain question
        if (!gatherAnswerCallback) {
          logger.warn(`[Node:PreflightAgents] ${a.agentId} asks a question but no gatherAnswerCallback is available`);
          const noCallbackErr = `${a.agentId} needs input, but the UI question prompt is not available.`;
          _emitProgress({
            type: 'preflight:auth_failed',
            agentId: a.agentId,
            message: noCallbackErr,
          });
          authRes = { ok: false, error: noCallbackErr };
          break;
        }
        _emitProgress({
          type: 'ask_user',
          question: authPayload.question,
          source: 'preflightAgents',
        });
        try {
          const answer = await gatherAnswerCallback(authPayload.question);
          if (!answer) break;
        } catch (ansErr) {
          logger.warn(`[Node:PreflightAgents] Answer gather failed for ${a.agentId}: ${ansErr.message}`);
          break;
        }
        attempts++;
        continue;
      }

      // Non-OK, non-askUser result is a hard auth failure.
      break;
    }

    if (!a.authed) {
      const authPayload = authRes?.data || authRes || {};
      const failureReason = authPayload.error || 'auth did not complete';
      a.ready = false;
      a.reason = failureReason;
      // For browser login walls the preflight:auth_required banner is already shown;
      // don't also show a scary auth-failed warning. Still record the failure so planning
      // is blocked until the user authenticates.
      if (!authPayload.authRequired) {
        logger.error(`[Node:PreflightAgents] I couldn't authenticate ${a.agentId} before planning: ${failureReason}`);
        _emitProgress({
          type: 'preflight:auth_failed',
          agentId: a.agentId,
          message: `I couldn't authenticate ${a.agentId}: ${failureReason}`,
        });
      } else {
        logger.info(`[Node:PreflightAgents] ${a.agentId} auth pending — waiting for user to sign in via banner`);
      }
      authFailures.push({ agentId: a.agentId, reason: failureReason });
    }
  }

  if (authFailures.length > 0) {
    const isAuthRequired = authFailures.some(f => f.reason === 'auth required');
    const planError = `I couldn't authenticate before planning: ${authFailures
      .map(f => `${f.agentId} (${f.reason})`)
      .join('; ')}`;
    return {
      ...state,
      preflightDone: true,
      planError,
      preflightAuthRequired: isAuthRequired,
      preflightResult: {
        warnings,
        agents: agentReadiness,
        agentContextNote: '',
      },
    };
  }

  // ── Single-route mandate (post-auth) ──────────────────────────────────────
  // When a service has exactly one executable route and it is now ready+
  // authed, treat that route as authoritative. The planner is forbidden from
  // falling back to api_suggest or alternative routes for that service.
  const singleRouteMandate = {};
  {
    const _readyByService = new Map();
    for (const a of agentReadiness) {
      if (!a.ready || !a.authed) continue;
      const svcKey = _svcFromAgent(a);
      if (!svcKey) continue;
      const routeType = _routeTypeFromAgent(a);
      if (!routeType) continue;
      if (!_readyByService.has(svcKey)) _readyByService.set(svcKey, []);
      _readyByService.get(svcKey).push({ agent: a, routeType });
    }

    for (const [svcKey, entries] of _readyByService) {
      if (entries.length !== 1) continue;
      const { agent: a, routeType } = entries[0];
      singleRouteMandate[svcKey] = {
        route: routeType,
        agentId: a.agentId,
        authType: a.authType || (a.type === 'cli' ? 'cli_token' : a.type),
      };
      _emitProgress({
        type: 'preflight:single_route_mandate',
        serviceName: svcKey,
        agentId: a.agentId,
        route: routeType,
      });
      logger.info(`[Node:PreflightAgents] Single-route mandate for ${svcKey}: ${routeType} via ${a.agentId}`);
    }
  }

  // ── Task-specific deep-link resolution for authenticated browser agents ─────
  // Delegates to browser.agent's resolve_deep_link action which has the full
  // resolution chain: intent templates → authenticated eval → web.agent → web.crawl → LLM.
  // Results are cached per agentId+taskHash (5min TTL) to avoid re-resolution.
  const _deepLinkCache = new Map();
  const _DEEP_LINK_CACHE_TTL = 5 * 60 * 1000;

  async function _resolveDeepLinkForAgent(a, task) {
    if (!a.startUrl) return null;

    // Check cache
    const _cacheKey = `${a.agentId}:${task.slice(0, 100)}`;
    const _cached = _deepLinkCache.get(_cacheKey);
    if (_cached && (Date.now() - _cached.ts) < _DEEP_LINK_CACHE_TTL) {
      logger.info(`[Node:PreflightAgents] deep-link: cache hit for ${a.agentId} → ${_cached.url}`);
      return { url: _cached.url, source: _cached.source || null };
    }

    // Delegate to browser.agent resolve_deep_link
    try {
      const res = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'browser.agent',
        args: {
          action: 'resolve_deep_link',
          agentId: a.agentId,
          serviceKey: (a.agentId || '').replace(/\.agent$/, ''),
          startUrl: a.startUrl,
          task,
          sessionId: (a.agentId || '').replace(/\.agent$/, '_agent'),
        },
      }, { timeoutMs: 30000 }).catch(() => null);
      const result = res?.data || res;
      if (result?.ok && result?.deepLinkUrl) {
        _deepLinkCache.set(_cacheKey, { url: result.deepLinkUrl, source: result.deepLinkSource || null, ts: Date.now() });
        return { url: result.deepLinkUrl, source: result.deepLinkSource || null };
      }
    } catch (err) {
      logger.debug(`[Node:PreflightAgents] deep-link resolution failed for ${a.agentId}: ${err.message}`);
    }
    return null;
  }

  for (const a of agentReadiness.filter(x => x.type === 'browser' && x.authed)) {
    const deepLink = await _resolveDeepLinkForAgent(a, userMessage);
    if (deepLink) {
      a.deepLinkUrl = deepLink.url || deepLink;
      a.deepLinkSource = deepLink.source || null;
      logger.info(`[Node:PreflightAgents] Deep-link for ${a.agentId}: ${a.deepLinkUrl} (source=${a.deepLinkSource})`);
    }
  }

  // ── App agent build (Phase 2) ──────────────────────────────────────────
  // For registered app-type agents, call app.agent build_agent to ensure
  // descriptors are up-to-date with shortcuts and playbooks.
  // Runs after Promise.all so _registeredAgentServiceMap is populated.
  try {
    const appAgents = agentReadiness.filter(a => a.type === 'app');
    // Also check registered agents that might be app type
    const registeredAppEntries = Object.entries(_registeredAgentServiceMap)
      .filter(([svc, id]) => id.includes('.app.agent'));
    if (registeredAppEntries.length > 0 || appAgents.length > 0) {
      _emitProgress({
        type: 'preflight:building_agent',
        agentType: 'app',
        agentId: 'app.preflight',
        message: 'Checking app agents and shortcuts...',
        iconUrl: null,
      });
    }
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
            if (!_allowAutoGeneratedRecipes && recipe.autoGenerated === true) continue;
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

  const selectedReadinessFailures = [];
  for (const agentId of selectedAgentIds) {
    const agent = agentReadiness.find(a => String(a.agentId || '').toLowerCase() === agentId);
    if (!agent) {
      selectedReadinessFailures.push({ agentId, reason: 'selected agent did not complete preflight' });
      continue;
    }
    if (!agent.ready) {
      selectedReadinessFailures.push({ agentId, reason: agent.reason || 'agent is not ready' });
      continue;
    }
    if (['browser', 'cli', 'api_key', 'bearer', 'basic'].includes(agent.type) && !agent.authed) {
      selectedReadinessFailures.push({ agentId, reason: 'authentication is required' });
    }
  }
  if (selectedReadinessFailures.length > 0) {
    const planError = `Selected agents are not ready: ${selectedReadinessFailures.map(f => `${f.agentId} (${f.reason})`).join('; ')}`;
    logger.error(`[Node:PreflightAgents] ${planError}`);
    return {
      ...state,
      preflightDone: true,
      planError,
      preflightAuthRequired: selectedReadinessFailures.some(f => /authentication is required/i.test(f.reason)),
      preflightResult: {
        warnings,
        agents: agentReadiness,
        agentContextNote: '',
      },
    };
  }

  // ── Build preflightResult ───────────────────────────────────────────────────
  const preflightResult = {
    skillContractNote,
    shellContractMd: _shellContractMd,
    shellSkillNames: Array.from(shellSkillNames),
    cliPreflightNote,
    agentContextNote,
    discoveredToolNote,
    preflightCliMap: _preflightCliMap,
    registeredAgentServiceMap: _registeredAgentServiceMap,
    trainedRecipeMap: _trainedRecipeMap,
    installedSkillsList,
    agents: agentReadiness,
    vetAvailable,
    warnings,
    orphanedSkills,
    orphanedSkillsNote,
    routeChoice: preflightRouteChoice,
    singleRouteMandate,
  };

  // Emit complete
  _emitProgress({
    type: 'preflight:complete',
    agents: agentReadiness.map(a => ({
      type: a.type,
      agentId: a.agentId,
      ready: a.ready,
      authed: a.authed,
      iconUrl: a.iconUrl,
    })),
    warnings,
  });

  logger.info(`[Node:PreflightAgents] Preflight complete: ${agentReadiness.length} agents checked, ${agentReadiness.filter(a => !a.ready).length} not ready, ${agentReadiness.filter(a => !a.authed).length} need auth`);

  return {
    ...state,
    preflightResult,
    preflightRouteChoice,
    preflightDone: true,
    _trainedRecipeMap: mapSize > 0 ? _trainedRecipeMap : state._trainedRecipeMap,
  };
};

module.exports.markAgentAuthed = markAgentAuthed;
module.exports.clearAuthCache = function clearAuthCache(agentId) {
  if (agentId) _authCache.delete(agentId.toLowerCase());
};

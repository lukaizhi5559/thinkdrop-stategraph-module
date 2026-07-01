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
const BROWSER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for cookie staleness

// ── Helpers ───────────────────────────────────────────────────────────────────

function _loadPreflightState() {
  try {
    if (fs.existsSync(PREFLIGHT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(PREFLIGHT_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastValidatedAt: null, cliVersions: {} };
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
  const userMessage = state.resolvedMessage || state.message || '';
  const recoveryContext = state.recoveryContext || null;
  const confirmInstallCallback = state.confirmInstallCallback || null;

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
  const warnings = []; // { type, message } non-fatal warnings

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
        _emitProgress({
          type: 'preflight:building_agent',
          agentType: 'cli',
          agentId: 'cli.preflight',
          message: 'Checking CLI tools and authentication...',
          iconUrl: null, // CLI preflight is generic, no specific icon
        });

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
                if (c.isApiKey || c.isOAuth) {
                  _emitProgress({
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
                _emitProgress({
                  type: 'preflight:auth_required',
                  agentId: `${c.service}.agent`,
                  serviceName: c.service,
                  authType: 'cli_install',
                  iconUrl,
                  message: `${c.service} is not installed — run: ${installCmd}`,
                });
              } else {
                const authNote = c.authUser ? ` — authenticated as ${c.authUser}` : (c.authStatus === 'authenticated' ? ' — authenticated' : '');
                lines.push(`${c.service}: ${c.cli} installed${authNote} ✓ — use cli.agent { action: 'run', agentId: '${c.service}.agent', task: '...' }`);
                const authed = !!c.authUser || c.authStatus === 'authenticated';
                agentReadiness.push({ type: 'cli', agentId: `${c.service}.agent`, ready: true, authed, iconUrl, service: c.service });

                if (!authed) {
                  // Emit auth required for CLI token
                  _emitProgress({
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

            // ── Browser agent auth check (session profile + cookie validity) ──
            if (a.type === 'browser') {
              const iconUrl = agentIdToIconUrl(a.id);
              const BROWSER_SESSIONS_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-sessions');
              const svcKey = (a.id || '').replace('.agent', '').toLowerCase();
              const profileDir = `${svcKey}_agent`;
              const profilePath = path.join(BROWSER_SESSIONS_DIR, profileDir);
              const hasSession = fs.existsSync(profilePath);

              // Check cookie file age for session validity
              let sessionStale = false;
              if (hasSession) {
                try {
                  const cookieFile = path.join(profilePath, 'Cookies');
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

              const authed = hasSession && !sessionStale;

              agentReadiness.push({
                type: 'browser',
                agentId: a.id,
                ready: true,
                authed,
                iconUrl,
                startUrl: a.start_url,
                needsLogin: !hasSession,
                sessionStale,
              });

              if ((!hasSession || sessionStale) && a.start_url) {
                _emitProgress({
                  type: 'preflight:auth_required',
                  agentId: a.id,
                  serviceName: svcKey,
                  authType: sessionStale ? 'browser_reauth' : 'browser_oauth',
                  iconUrl,
                  message: sessionStale
                    ? `${a.id} session may have expired — re-login recommended`
                    : `${a.id} requires browser login`,
                });
              }
            } else if (a.type === 'cli') {
              // CLI agents already handled in preflight_check above
              // Stale agent detection: registered CLI agent whose CLI is no longer installed
              const svcKey = (a.id || '').replace('.agent', '').toLowerCase();
              const cliInfo = _preflightCliMap[svcKey];
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

    // ── vet CLI presence check + auto-install ────────────────────────────
    (async () => {
      try {
        vetPath = _whichSync('vet');
        vetAvailable = !!vetPath;

        if (!vetAvailable) {
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
              execSync('brew install vet-run', { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
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
                  execSync(`sh ${tmpFile}`, { encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
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
          }
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
          } catch (pingErr) {
            const isTimeout = pingErr?.message?.includes('timeout') || pingErr?.code === 'TIMEOUT';
            if (!isTimeout) {
              // Service responded with error — it's alive but unhealthy
              warnings.push({
                type: 'mcp_unhealthy',
                message: `MCP service "${svc}" responded with error: ${pingErr.message?.slice(0, 100)}`,
              });
            }
            // Timeout = service may be down — already caught by .catch(() => null) in each block
          }
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
    vetAvailable,
    warnings,
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
    preflightDone: true,
    _trainedRecipeMap: mapSize > 0 ? _trainedRecipeMap : state._trainedRecipeMap,
  };
};

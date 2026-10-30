'use strict';

/**
 * preflightAgents.js — StateGraph node
 *
 * Sits between resolveAgent → gatherPlanContext.
 * Scoped readiness check for the agents a plan/pin actually names.
 *
 * The compiler (comms-graph planning) owns capability discovery, install,
 * and onboarding (capability.probe → setup.start → capability.select). This
 * runtime node therefore only:
 *   1. resolves file references for local_file/app_automation tasks
 *   2. computes taskFacts (consumed by executeCommand/planSkills)
 *   3. evaluates guardian rules
 *   4. checks the agents the plan/pin names: registry membership + auth
 *      ledger + binary presence on PATH
 *   5. escalates via _needsPlan when a needed agent is unregistered,
 *      unauthenticated, or its binary is missing — the compiler onboards
 *      it, the runtime never repairs it
 *
 * It NEVER: LLM-extracts services from the prompt, build_agent's, probes
 * auth/CLIs, runs tool.discover/monthly validation/route mandates, or emits
 * sign-in cards (sign-in is a compile-time trigger via setup.start).
 *
 * State outputs:
 *   state.preflightResult = {
 *     cliPreflightNote,       // string for planSkills prompt ('' — no CLI scan)
 *     agentContextNote,       // string for planSkills prompt
 *     preflightCliMap,        // { service: { hasCli } } — registry-derived
 *     registeredAgentServiceMap, // { service: agentId } — registry-derived
 *     trainedRecipeMap,       // { variant: { agentId, skillName, agentType } }
 *     agents,                 // readiness info for NEEDED agents only
 *     vetAvailable,           // boolean — vet CLI installed?
 *     warnings,               // array of { type, message } non-fatal warnings
 *   }
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { extractContextRefs } = require('../utils/contextRefs.cjs');

// ── Persistent auth ledger (survives app restart) ────────────────────────────
// Key: agentId (lowercase)
// Value: { ts, authed, lastUsed, needsAuth, lastAuthFailedAt, lastAuthFailedReason }
//
// THE LEDGER MODEL: `authed === true` is trusted PERMANENTLY — no TTL. The
// entry is only invalidated when something OBSERVES auth is broken:
//   - runtime login-wall re-detection (browser.agent clears authed_at and
//     writes authed:false + lastAuthFailedAt here), or
//   - a failed one-time migration verify.
// This replaces the old 24h TTL + 7-day cookie-mtime gates, which re-verified
// sessions that were almost never actually dead. Verification now happens on
// transition edges (first contact / after logout), not per-run.
// Env-overridable so tests don't pollute the real ledger file. Resolved at
// call time so tests can set THINKDROP_PREFLIGHT_AUTH_CACHE after require.
function _authCacheFile() {
  return process.env.THINKDROP_PREFLIGHT_AUTH_CACHE
    || path.join(os.homedir(), '.thinkdrop', 'preflight-auth-cache.json');
}
const PREFLIGHT_AUTH_CACHE_TTL_MS = 30 * 60 * 1000;
const _authCache = new Map();

let _persistentAuthCache = null; // lazy-loaded
let _persistentAuthCachePath = null; // path the loaded cache belongs to
let _persistentAuthCacheMtime = 0; // mtimeMs at last load — cross-process refresh

function _loadPersistentAuthCache() {
  const file = _authCacheFile();
  // Re-read when the resolved path changes (tests override per-run) or the
  // file was rewritten since our last load — browser.agent's usage ledger is
  // written from the command-service process, so mtime is the freshness check.
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
  if (_persistentAuthCache !== null && _persistentAuthCachePath === file && _persistentAuthCacheMtime === mtime) {
    return _persistentAuthCache;
  }
  try {
    _persistentAuthCache = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : {};
  } catch (_) {
    _persistentAuthCache = {};
  }
  _persistentAuthCachePath = file;
  _persistentAuthCacheMtime = mtime;
  return _persistentAuthCache;
}

function _savePersistentAuthCache(data) {
  try {
    const file = _authCacheFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file + rename to avoid corruption on crash
    const tmpFile = `${file}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpFile, file);
    _persistentAuthCachePath = file;
    try { _persistentAuthCacheMtime = fs.statSync(file).mtimeMs; } catch (_) {}
  } catch (_) {}
}

function markAgentAuthed(agentId) {
  if (!agentId) return;
  const key = agentId.toLowerCase();
  const entry = { ts: Date.now(), authed: true };
  _authCache.set(key, entry);
  // Persist to disk
  const cache = _loadPersistentAuthCache();
  cache[key] = entry;
  _savePersistentAuthCache(cache);
}

function _getCachedAuth(agentId) {
  const key = agentId.toLowerCase();
  const entry = _authCache.get(key);
  if (entry && (Date.now() - entry.ts) < PREFLIGHT_AUTH_CACHE_TTL_MS) return entry;
  const persistent = _loadPersistentAuthCache();
  return persistent[key] || null;
}

function _getLedgerAuth(agentId) {
  return _getCachedAuth(agentId);
}

function _writeLedgerAuth(agentId, patch) {
  const key = agentId.toLowerCase();
  const cache = _loadPersistentAuthCache();
  cache[key] = { ...(cache[key] || {}), ...patch, ts: Date.now() };
  _savePersistentAuthCache(cache);
}

function markAgentAuthFailed(agentId, reason) {
  if (!agentId) return;
  const key = agentId.toLowerCase();
  const entry = { ts: Date.now(), authed: false, lastAuthFailedAt: Date.now(), lastAuthFailedReason: String(reason || 'unknown').slice(0, 200) };
  _authCache.set(key, entry);
  const cache = _loadPersistentAuthCache();
  cache[key] = { ...(cache[key] || {}), ...entry };
  _savePersistentAuthCache(cache);
}

// CLI ledger read — authed only when the last success postdates the last
// failure. Probe verdicts that mean "couldn't determine" are not failures.
function _cliLedgerAuth(agentId) {
  const ledger = _getLedgerAuth(agentId);
  if (!ledger) return { authed: false, failed: false };
  const _tsOf = (t) => (typeof t === 'number' ? t : Date.parse(t)) || 0;
  const failedAt = Math.max(ledger.lastAuthFailedAt || 0, ledger.authed === false ? _tsOf(ledger.ts) : 0);
  const authedAt = ledger.authed === true ? _tsOf(ledger.ts) : 0;
  return { authed: authedAt > failedAt, failed: failedAt > 0 && failedAt >= authedAt };
}

// Browser-profile existence check — NOT a staleness check. Existence is only
// the migration signal (pre-ledger session); it cannot prove login.
const BROWSER_PROFILES_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
function _browserProfileHasCookies(agentId) {
  const svcKey = (agentId || '').replace(/\.agent$/, '').toLowerCase();
  try {
    return fs.existsSync(path.join(BROWSER_PROFILES_DIR, `${svcKey}_agent`, 'Default', 'Cookies'));
  } catch (_) { return false; }
}

// ── Static needs-auth knowledge ──────────────────────────────────────────────
// 1 = interactive use of this service clearly requires an account.
// 0 = the service's interactive flows work anonymously.
// Unknown services with no ledger signal escalate to the compiler — first
// contact is onboarding, and setup.start verifies there.
const _SERVICE_NEEDS_AUTH = new Map(Object.entries({
  gmail: 1, google: 1, google_docs: 1, google_sheets: 1, google_calendar: 1,
  google_drive: 1, google_cloud: 1, google_maps: 1, google_photos: 1,
  slack: 1, github: 1, notion: 1, linear: 1, figma: 1, spotify: 1,
  twitter: 1, x: 1, linkedin: 1, facebook: 1, instagram: 1, discord: 1,
  netflix: 1, dropbox: 1, trello: 1, jira: 1, asana: 1, hubspot: 1,
  salesforce: 1, stripe: 1, microsoft: 1, onedrive: 1, zoom: 1, teams: 1,
  chatgpt: 1, openai: 1, claude: 1, anthropic: 1, grok: 1, perplexity: 1,
  airtable: 1, vercel: 1, netlify: 1, heroku: 1, digitalocean: 1,
  // Only clearly-anonymous services get 0 — marketplaces (etsy/amazon/ebay…)
  // are deliberately absent: browsing works anonymously but interactive tasks
  // (orders, checkout, favorites) need accounts, so first-contact asks the LLM.
  youtube: 0, reddit: 0, wikipedia: 0, imdb: 0, yelp: 0, craigslist: 0,
  weather: 0, stackoverflow: 0, stack_exchange: 0, medium: 0, hackernews: 0,
}));

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

function agentIdToDomain(agentId, startUrl) {
  if (startUrl) {
    try { return new URL(startUrl).hostname; } catch (_) {}
  }
  const base = agentId.replace(/\.agent$/i, '').toLowerCase();
  return AGENT_DOMAIN_OVERRIDES[base] || `${base}.com`;
}

function agentIdToIconUrl(agentId, startUrl) {
  const domain = agentIdToDomain(agentId, startUrl);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function serviceToIconUrl(service, startUrl) {
  if (startUrl) {
    try { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(startUrl).hostname)}&sz=128`; } catch (_) {}
  }
  const base = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(AGENT_DOMAIN_OVERRIDES[base] || `${base}.com`)}&sz=128`;
}

// ── File reference resolution (hybrid regex + LLM extraction) ────────────────
// Extracts a file/folder name from the user message, then probes the filesystem
// via shell.run to find exact or fuzzy matches. Returns:
//   { status: 'exact'|'fuzzy'|'ambiguous'|'none', path?, candidates?, matchedName? }

const _FILE_STOPWORDS = /^(?:file|folder|the|a|an|this|that|it|app|application|ai|page|window|tab|screen|menu|button|panel|area|section|bar|tool|toolbar|sidebar|header|footer|content|text|image|video|audio|link|url|address|number|name|title|description|note|comment|message|email|chat|post|tweet|song|track|album|artist|playlist|channel|user|profile|account|setting|preference|option|feature|function|method|class|object|variable|constant|property|field|column|row|table|database|query|command|statement|expression|value|result|output|input|error|warning|info|debug|log|trace|event|handler|listener|callback|promise|async|await|return|param|parameter|arg|argument|var|let|const|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|delete|typeof|instanceof|in|of|do|with|export|import|from|default|extends|implements|interface|enum|struct|union|typedef|namespace|module|package|library|framework|plugin|extension|addon|component|element|widget|gadget|control|view|model|controller|route|endpoint|api|service|server|client|request|response|header|body|status|method|get|post|put|patch|delete|head|options|connect|trace|content|type|length|encoding|charset|boundary|disposition|filename|name|value|data|json|xml|html|css|js|ts|py|rb|go|rs|c|cpp|java|kt|swift|php|pl|sh|bash|zsh|fish|ps1|bat|cmd|exe|app|dmg|pkg|deb|rpm|msi|zip|tar|gz|bz2|xz|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|rst|log|csv|tsv|yaml|yml|toml|ini|cfg|conf|env|lock|tmp|temp|cache|bak|old|orig|swp|swo|swn|swn|pid|sock|fifo|pipe|tty|dev|null|zero|random|urandom)$/i;

const _FILE_REGEX_PATTERNS = [
  // Drag-drop attachment marker: [File: /absolute/path] — try FIRST (deterministic)
  /\[File:\s*(\/[^\]]+)\]/i,
  // "open|examine|read|edit|view|show|load|find|import [me] [the] <name> file? in <app>"
  /\b(?:open|examine|read|edit|view|show|load|find|import)\s+(?:me\s+)?(?:the\s+)?([^/\s"']+?)(?:\s+file)?\s+(?:in|with|using|via)\b/i,
  // "ask the AI about <name> in <app>"
  /\bask\s+(?:the\s+)?ai\s+(?:to\s+)?(?:about\s+)?([^/\s"']+?)(?:\s+file)?\s+(?:in|with|using|via)\b/i,
  // "tell me about <name> in <app>"
  /\btell me about\s+([^/\s"']+?)(?:\s+file)?\s+(?:in|with|using|via)\b/i,
  // quoted name: open "UnifiedOverlay" in Devin
  /\b(?:open|examine|read|edit|view|show|load|find|import)\s+"([^"]+)"\s+(?:in|with|using|via)\b/i,
  // path with slashes: open /path/to/file.ext in Devin
  /\b(?:open|examine|read|edit|view|show|load|find|import)\s+(\/[^\s"']+\.\w+)\s+(?:in|with|using|via)\b/i,
  // filename with extension anywhere in message: UnifiedOverlay.tsx
  // NOTE: this is a fallback — filenames with spaces (e.g. "Screenshot 2026-09-12 at 11.10.16 PM.png")
  // will only match the last token ("PM.png"). The [File:] marker above handles
  // drag-drop attachments with full paths including spaces.
  /\b([A-Za-z_][A-Za-z0-9_-]*\.[a-zA-Z0-9]+)\b/,
];

function _extractFileCandidate(userMessage) {
  let candidate = null;
  for (const p of _FILE_REGEX_PATTERNS) {
    const m = userMessage.match(p);
    if (m && m[1]) {
      candidate = m[1].trim();
      break;
    }
  }
  if (candidate && _FILE_STOPWORDS.test(candidate)) {
    candidate = null;
  }
  return candidate;
}

async function _llmExtractFileCandidate(llmBackend, userMessage, logger) {
  if (!llmBackend) return null;
  try {
    const prompt = `Extract the file or folder name from this request. Return ONLY the file/folder name (with extension if present), nothing else. If no file/folder is referenced, return "NONE".\nRequest: "${userMessage}"`;
    const raw = await llmBackend.generateAnswer(prompt, { query: prompt }, { maxTokens: 30, temperature: 0, taskType: 'classification' });
    const text = (typeof raw === 'string' ? raw : raw?.text || raw?.content || '').trim().replace(/^["']|["']$/g, '');
    if (!text || text.toLowerCase() === 'none' || text.toLowerCase() === 'null' || text.length < 2) return null;
    if (_FILE_STOPWORDS.test(text)) return null;
    return text;
  } catch (e) {
    logger.warn(`[Node:PreflightAgents] LLM file extraction failed: ${e.message}`);
    return null;
  }
}

async function _probeFilesystem(mcpAdapter, candidate, logger) {
  if (!candidate || !mcpAdapter) return { status: 'none' };

  const path = require('path');
  const os = require('os');

  // If it's an absolute path, check directly
  if (candidate.startsWith('/')) {
    try {
      require('fs').accessSync(candidate);
      return { status: 'exact', path: candidate };
    } catch (_) {
      // Fall through to search
    }
  }

  // Strip extension for wildcard search
  const base = candidate.replace(/\.[a-zA-Z0-9]+$/, '');

  // Search roots in priority order with maxdepth to avoid timeouts
  const searchRoots = [
    { root: process.cwd(), maxdepth: 5 },
    { root: path.join(os.homedir(), 'Desktop', 'projects'), maxdepth: 5 },
    { root: path.join(os.homedir(), 'Desktop'), maxdepth: 3 },
    { root: path.join(os.homedir(), 'Documents'), maxdepth: 4 },
    { root: path.join(os.homedir(), 'Downloads'), maxdepth: 3 },
    { root: path.join(os.homedir(), '.devin'), maxdepth: 5 },
    { root: path.join(os.homedir(), '.thinkdrop'), maxdepth: 4 },
  ];

  let candidates = [];
  for (const { root, maxdepth } of searchRoots) {
    try {
      require('fs').accessSync(root);
    } catch (_) { continue; }

    const findCmd = `find "${root}" -maxdepth ${maxdepth} -type f \\( -name "${candidate}" -o -name "${base}.*" -o -iname "*${base}*" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.next/*" 2>/dev/null | head -30`;

    try {
      const res = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'shell.run',
        args: { cmd: 'bash', argv: ['-c', findCmd] },
      }, { timeoutMs: 15000 }).catch(() => null);

      const data = res?.data || res;
      const stdout = data?.stdout || data?.output || '';
      const text = (typeof stdout === 'string' ? stdout : String(stdout || '')).trim();
      if (text) {
        candidates = candidates.concat(text.split('\n').filter(Boolean));
      }
    } catch (e) {
      logger.warn(`[Node:PreflightAgents] File probe failed for ${root}: ${e.message}`);
    }

    if (candidates.length > 0) break; // Stop after first root with matches
  }

  // Deduplicate
  candidates = [...new Set(candidates)];

  if (candidates.length === 0) {
    return { status: 'none' };
  }

  if (candidates.length === 1) {
    // Check if it's an exact name match or fuzzy
    const filename = candidates[0].split('/').pop();
    if (filename === candidate || filename === `${base}.${candidate.split('.').pop()}`) {
      return { status: 'exact', path: candidates[0] };
    }
    return { status: 'fuzzy', path: candidates[0], matchedName: filename };
  }

  // Multiple candidates — score them
  const fs = require('fs');
  const scored = candidates.map(p => {
    const filename = p.split('/').pop();
    let score = 0;
    // Exact name match → highest
    if (filename === candidate) score = 100;
    // Exact base with any extension → high
    else if (filename.replace(/\.[a-zA-Z0-9]+$/, '') === base) score = 90;
    // Contains the candidate as substring → medium
    else if (filename.toLowerCase().includes(base.toLowerCase())) score = 70;
    // Fuzzy substring → lower
    else score = 50;

    // Prefer shorter paths, then more recently modified
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
    return { path: p, score, mtime, depth: p.split('/').length, filename };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.depth - b.depth) || (b.mtime - a.mtime));

  // If the top candidate has a much higher score than the rest, treat as exact
  if (scored.length > 1 && scored[0].score >= 90 && scored[1].score < 70) {
    return { status: 'exact', path: scored[0].path };
  }

  // If all candidates are the same base name with different extensions, pick the best
  const topBasename = scored[0].filename.replace(/\.[a-zA-Z0-9]+$/, '');
  const allSameBase = scored.every(s => s.filename.replace(/\.[a-zA-Z0-9]+$/, '') === topBasename);
  if (allSameBase && scored.length <= 3) {
    // Prefer common source extensions
    const extPriority = { '.tsx': 1, '.ts': 2, '.jsx': 3, '.js': 4, '.py': 5, '.md': 6 };
    scored.sort((a, b) => {
      const aExt = '.' + a.filename.split('.').pop();
      const bExt = '.' + b.filename.split('.').pop();
      return (extPriority[aExt] || 99) - (extPriority[bExt] || 99);
    });
    return { status: 'fuzzy', path: scored[0].path, matchedName: scored[0].filename };
  }

  return { status: 'ambiguous', candidates: scored.slice(0, 5).map(s => s.path) };
}

// ── Main node ─────────────────────────────────────────────────────────────────

module.exports = async function preflightAgents(state) {
  const logger = state.logger || console;
  const mcpAdapter = state.mcpAdapter;
  const progressCallback = state.progressCallback || null;

  // ── Deterministic fast-path: generic local skills need no agent preflight ──
  // _deterministicPlan steps are all catalog skills (fs.read/shell.run/schedule…)
  // — no service agents to auth, no CLI checks to run. External service
  // templates (_deterministicExternal) DO need preflight — auth is the point.
  if (Array.isArray(state._deterministicPlan) && state._deterministicPlan.length > 0 && !state._deterministicExternal) {
    logger.info(`[Node:PreflightAgents] Deterministic plan (${state._deterministicTemplate || 'template'}) — skipping agent preflight`);
    return { ...state, preflightResult: { agents: [], skipped: 'deterministic' } };
  }

  let userMessage = state.resolvedMessage || state.message || '';
  // Inject follow-up target context so preflight consumers see the full task
  // context, not just a vague follow-up like "I need you to check again".
  // gatherPlanContext does the same injection later, but preflight runs BEFORE it.
  const _tc = state._taskClassification || {};
  const _isIsoSession = String(state.context?.sessionId || state.resolvedSessionId || '').startsWith('iso_');
  if (!_isIsoSession && _tc.isFollowUp && _tc.followUpTarget && !_tc.isScreenFollowUp) {
    userMessage = `${userMessage}\n\n(Context from prior turn: ${_tc.followUpTarget})`;
    logger.info(`[Node:PreflightAgents] Follow-up target injected: "${_tc.followUpTarget}"`);
  }
  const recoveryContext = state.recoveryContext || null;

  // ── Pure in-page navigation — skip file-probe ──────────────────────────────
  // "go back for me on this page" / "reload this page" operate on the tab the
  // user is already looking at. There is no file to probe — but the
  // activeDocTarget injection ("Amazon.com product page") used to trip the
  // file-candidate gate (extracted "Amazon.com" → resolved
  // amazon_product_reviews.txt). Named-destination variants ("go back to my
  // ebay tab") still aren't in-page actions, but they need no file resolution
  // either; only skip when the prompt has no destination at all.
  const _isInPageNav = (() => {
    const p = String(userMessage || '').split('\n')[0]; // literal prompt only — not injected context
    if (!/\b(go\s+back|navigate\s+back|go\s+back\s+(?:a|one)\s+page|previous\s+page|go\s+forward|reload|refresh)\b/i.test(p)) return false;
    // Any "to <something>" phrasing names a destination — not pure history.
    if (/\b(go\s+back|return|switch|focus|bring\s+me\s+back|take\s+me|navigate|go)\s+to\b/i.test(p)) return false;
    // An explicit URL/host is a real target — resolve it normally.
    if (/https?:\/\/|\b[a-z0-9][\w-]*\.(?:com|org|net|io|dev|ai|app|co|gov|edu)\b/i.test(p)) return false;
    // Other action verbs → the nav is a fragment of a larger goal, not pure.
    const stripped = p.replace(/\b(go\s+back|navigate\s+back|go\s+forward|reload|refresh|previous\s+page|for\s+me|on\s+this\s+page|this\s+page|please)\b/gi, '');
    return !/\b(click|type|fill|search|read|get|find|create|send|open|select|buy|add|scroll|press|check|tell|watch|play|log\s*in|sign\s*in|download|upload)\b/i.test(stripped);
  })();

  // ── Auth bypass (one-run, user-chosen "proceed without") ──────────────────
  // Agent IDs the user explicitly chose to run unauthenticated. NOT persisted —
  // nothing is written to the auth cache or authed_at, so the next task that
  // truly needs auth still prompts.
  const _bypassAuth = new Set(
    (Array.isArray(state.preflightAuthBypass) ? state.preflightAuthBypass : [state.preflightAuthBypass])
      .filter(Boolean)
      .map(s => String(s).toLowerCase())
  );
  // Live re-check: main.js pushes into state.preflightAuthBypass while this
  // node is still running (mid-run "Proceed without" click). The array is
  // shared by reference into the live state, so re-reading it catches
  // bypasses that arrived after this node started.
  const _isBypassedNow = (agentId) => {
    const id = String(agentId || '').toLowerCase();
    if (_bypassAuth.has(id)) return true;
    const live = state.preflightAuthBypass;
    return Array.isArray(live) && live.some(x => String(x).toLowerCase() === id);
  };
  const gatherAnswerCallback = state.gatherAnswerCallback || null;

  // _emitProgress — safe wrapper that no-ops if progressCallback is null
  const _emitProgress = (data) => {
    if (progressCallback) progressCallback(data);
  };

  logger.info(`[Node:PreflightAgents] Running preflight for: "${userMessage.slice(0, 80)}"`);

  if (!mcpAdapter) {
    logger.warn('[Node:PreflightAgents] No mcpAdapter — skipping preflight');
    return { ...state, preflightResult: null, preflightDone: true };
  }

  // ── Phase timing instrumentation ──────────────────────────────────────────
  const _pfT0 = Date.now();
  const _pfDur = {};
  const _mark = (k) => { _pfDur[k] = Date.now() - _pfT0; };

  // ── File reference resolution (app_automation / local_file tasks) ──────────
  // Extract a file/folder name from the user message and probe the filesystem
  // BEFORE planning. This prevents app.runner from failing on an unresolved
  // bare basename and prevents the griller from wasting time asking about it.
  let _fileResolution = null;
  // The gate also fires on activeDocRef:'file'/activeDocTarget — misclassified
  // follow-ups like "update the file" (taskType:ambiguous) still refer to a
  // live local document and must resolve it before any agent planning.
  // Pure in-page nav ("go back on this page") never has a file to resolve —
  // the injected activeDocTarget ("Amazon.com product page") is a URL context,
  // not a document reference.
  if (!_isInPageNav && (_tc.taskType === 'app_automation' || _tc.taskType === 'local_file' || _tc.activeDocRef === 'file' || _tc.activeDocTarget)) {
    let candidate = _extractFileCandidate(userMessage);
    // "the file" has no literal name to extract — fall back to the resolved
    // live-document target.
    if (!candidate && _tc.activeDocTarget && /^(\/|~\/)/.test(String(_tc.activeDocTarget))) {
      candidate = String(_tc.activeDocTarget);
    }
    if (!candidate && /\b(?:open|examine|read|edit|view|show|load|find|import|ask|tell)\b/i.test(userMessage)) {
      logger.info('[Node:PreflightAgents] No regex match for file name — trying LLM extraction');
      candidate = await _llmExtractFileCandidate(state.llmBackend, userMessage, logger);
    }

    if (candidate) {
      logger.info(`[Node:PreflightAgents] File candidate extracted: "${candidate}" — probing filesystem`);
      _fileResolution = await _probeFilesystem(mcpAdapter, candidate, logger);
      logger.info(`[Node:PreflightAgents] File resolution: status=${_fileResolution.status}${_fileResolution.path ? `, path=${_fileResolution.path}` : ''}${_fileResolution.candidates ? `, candidates=${_fileResolution.candidates.length}` : ''}`);

      // Ambiguous → deterministic disambiguation first: when exactly one
      // candidate's full path appears verbatim in the conversation context
      // (e.g. the original turn's "[File: /abs/path]" attachment or a
      // "[Resolved file path: /abs/path]" note), that IS the file the user
      // means — promote to exact with no question. task_f605d60d: two
      // same-named files (current + exodus1) went ambiguous, no ask fired,
      // and the planner hallucinated an iCloud path.
      if (_fileResolution.status === 'ambiguous' && _fileResolution.candidates?.length > 0) {
        try {
          const _ctxText = `${JSON.stringify(state.conversationHistory || [])}\n${state.resolvedMessage || ''}\n${state.message || ''}`;
          const _ctxHits = _fileResolution.candidates.filter(p => _ctxText.includes(p));
          if (_ctxHits.length === 1) {
            _fileResolution = { status: 'exact', path: _ctxHits[0] };
            logger.info(`[Node:PreflightAgents] Ambiguous file resolved by conversation context: ${_ctxHits[0]}`);
          }
        } catch (_) { /* keep ambiguous */ }
      }

      // If ambiguous or not found, ask the user for disambiguation
      if (_fileResolution.status === 'ambiguous' && _fileResolution.candidates?.length > 0 && gatherAnswerCallback) {
        const question = `I found ${_fileResolution.candidates.length} files matching "${candidate}". Which one should I use?`;
        _emitProgress({
          type: 'ask_user',
          question,
          options: _fileResolution.candidates.map(p => ({
            label: p.split('/').slice(-3).join('/'),
            value: p,
          })),
          source: 'preflightAgents',
        });
        try {
          const answer = await gatherAnswerCallback(question);
          if (answer && answer.trim()) {
            _fileResolution = { status: 'exact', path: answer.trim() };
            logger.info(`[Node:PreflightAgents] User selected file: ${answer.trim()}`);
          }
        } catch (e) {
          logger.warn(`[Node:PreflightAgents] File disambiguation question failed: ${e.message}`);
        }
      } else if (_fileResolution.status === 'none' && gatherAnswerCallback) {
        const question = `I couldn't find a file matching "${candidate}". Please provide the exact file path.`;
        _emitProgress({ type: 'ask_user', question, source: 'preflightAgents' });
        try {
          const answer = await gatherAnswerCallback(question);
          if (answer && answer.trim()) {
            _fileResolution = { status: 'exact', path: answer.trim() };
            logger.info(`[Node:PreflightAgents] User provided file path: ${answer.trim()}`);
          }
        } catch (e) {
          logger.warn(`[Node:PreflightAgents] File path question failed: ${e.message}`);
        }
      }

      // Enrich resolvedMessage with the resolved path so downstream nodes can use it
      if (_fileResolution.path && _fileResolution.status === 'exact') {
        userMessage = `${userMessage}\n[Resolved file path: ${_fileResolution.path}]`;
      } else if (_fileResolution.status === 'ambiguous' && _fileResolution.candidates?.length > 0) {
        // Still ambiguous (no callback or no answer) — inject the REAL
        // candidate paths so the planner quotes them verbatim instead of
        // hallucinating a path (task_f605d60d invented an iCloud path).
        userMessage = `${userMessage}\n[Ambiguous file candidates — pick the most likely, use the path verbatim: ${_fileResolution.candidates.join(' | ')}]`;
      }
    }
  }

  // Emit start
  _emitProgress({ type: 'preflight:start', message: 'Preparing agents for your task...' });

  // Initialize result containers
  const _preflightCliMap = {};
  let cliPreflightNote = '';
  let agentContextNote = '';
  const _registeredAgentServiceMap = {};
  const _trainedRecipeMap = {};
  const agentReadiness = []; // { type, agentId, ready, authed, iconUrl, ... }
  const vetAvailable = !!_whichSync('vet');
  const warnings = []; // { type, message } non-fatal warnings
  const _allowAutoGeneratedRecipes = process.env.THINKDROP_ALLOW_AUTOGENERATED_RECIPES === 'true';

  // ── ResolveAgent result: which agents the plan/pin names ──────────────────
  const resolveAgentResult = state.resolveAgentResult || null;
  const selectedAgentIds = new Set();
  const createAgentSpecs = [];
  if (resolveAgentResult && Array.isArray(resolveAgentResult.agents)) {
    for (const a of resolveAgentResult.agents) {
      if (!a || !a.agentId) continue;
      selectedAgentIds.add(a.agentId.toLowerCase());
      if (a.create) createAgentSpecs.push(a);
    }
  }

  // ── Shared agent registry snapshot ────────────────────────────────────────
  // One agent.list call shared by all consumers.
  let _agentsSnapshot = null;
  const _fetchAgents = async () => {
    if (_agentsSnapshot) return _agentsSnapshot;
    const res = await mcpAdapter.callService('command', 'agent.list', {}, { timeoutMs: 3000 }).catch(() => null);
    _agentsSnapshot = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    return _agentsSnapshot;
  };

  // ── Dispatchable skill ids (one skill.list call, contract-vocab fallback) ──
  // *.agent ids that are command-service SKILLS (edit.agent, browser.agent, …)
  // execute through command.automate — they are NOT registry agents and must
  // never enter _notOnboarded. Observed: a plan pinning edit.agent escalated
  // needs_plan (agent_not_onboarded) and the run hung for 40min.
  let _skillIdsSnapshot = null;
  const _fetchSkillIds = async () => {
    if (_skillIdsSnapshot) return _skillIdsSnapshot;
    const { dispatchableSkills } = require('../utils/skillIds.js');
    _skillIdsSnapshot = await dispatchableSkills(mcpAdapter);
    return _skillIdsSnapshot;
  };

  // Canonical service lookup key — "google docs"/"googledocs" → google_docs so
  // taskFacts agrees with classification output.
  const _canonSvc = (s) => {
    try {
      const { _canonicalService } = require('../utils/localPlanTemplates');
      return (_canonicalService(s) || s || '').toLowerCase();
    } catch (_) { return String(s || '').toLowerCase(); }
  };

  // ── Demote misrouted service/app agents when a local file is the subject ────
  // "Update the file" can get LLM-routed to microsoft_word_online.agent or a
  // code editor before file resolution runs — then preflight surfaces auth
  // cards for services the task never needed. When an exact local file
  // resolved AND the message names no service/agent, the selected agents add
  // nothing: planSkills handles local files via edit.agent/fs.read. Service
  // mentions ("email me this file") preserve the pick.
  if (_fileResolution?.status === 'exact' && _fileResolution.path
      && selectedAgentIds.size > 0 && !_tc.targetService) {
    let _regAgents = [];
    try {
      _regAgents = (await _fetchAgents()).filter(a => a && a.id);
    } catch (_) {}
    const { _messageMentionsServiceOrAgent } = require('./resolveAgent');
    if (!_messageMentionsServiceOrAgent(userMessage, _regAgents)) {
      logger.info(`[Node:PreflightAgents] local file resolved (${_fileResolution.path}) + no service mentioned — dropping ${selectedAgentIds.size} misrouted agent(s): ${[...selectedAgentIds].join(', ')}`);
      selectedAgentIds.clear();
      createAgentSpecs.length = 0;
      state.resolveAgentResult = { ...(resolveAgentResult || {}), agents: [] };
    }
  }

  // ── taskFacts: canonical task-truth object ─────────────────────────────────
  // Facts are computed ONCE here — the earliest node holding
  // _taskClassification + agentReadiness + MCP access — then frozen on state;
  // every downstream consumer (public-web gate, planner dedup, eyes
  // postcondition) reads facts instead of re-deriving.
  const _MUTATION_TASK_RE = /\b(set|create|add|make|new|schedule|book|send|post|publish|upload|submit|reply|forward|compose|delete|edit|update|invite|share|buy|order|checkout|pay|reserve|fill|sign|register)\b[^.]{0,50}\b(event|meeting|appointment|reminder|calendar|e-?mail|message|post|comment|order|booking|reservation|doc|document|file|note|task|list|photo|video|call|form)\b/i;
  const _msgHasMutation = _MUTATION_TASK_RE.test(String(userMessage || ''));
  // The pinned/resolved agent IS a service signal when classification is thin —
  // handoff plan-tasks skip full classification so _tc.targetService is empty
  // while resolveAgent already pinned "google.agent" deterministically.
  const _pinnedSvcCanon = state._pinnedAgentId
    ? _canonSvc(String(state._pinnedAgentId).replace(/\.agent$/i, '')) : null;
  const taskFacts = {
    service: _canonSvc(_tc.targetService) || _pinnedSvcCanon || null,
    serviceHost: null,
    agentId: null,
    intent: null,                        // filled by deep-link resolution
    // Recomputed HERE, not trusted from _tc — memo-cached verdicts replay
    // (interactiveActions non-empty means the classifyTask post-guard already
    // coerced this to interactive; the lexical regex catches a raw flake).
    isMutation: !!((_tc.targetService || _pinnedSvcCanon) && _msgHasMutation)
      || !!(_tc.webAccessMode === 'interactive' && (_tc.targetService || _pinnedSvcCanon) && (_tc.interactiveActions || []).length),
    mutationAction: (() => {
      const _m = String(userMessage || '');
      return /\b(send|reply|forward|compose|e-?mail|message|dm)\b/i.test(_m) ? 'send_message'
        : /\b(book|schedule|reserve|appointment|meeting|event|reminder|calendar)\b/i.test(_m) ? 'book_reservation'
        : /\b(buy|order|checkout|pay|cart|purchase)\b/i.test(_m) ? 'add_to_cart'
        : _msgHasMutation ? 'create' : null;
    })(),
    entities: null,                      // filled from destination URL params
    destination: null,                   // { url, source, deepLinkType, expectsOverlay }
    postcondition: null,                 // { kind:'urlTransition', from:url }
  };
  logger.info(`[Node:PreflightAgents] taskFacts: service=${taskFacts.service || 'none'} isMutation=${taskFacts.isMutation} action=${taskFacts.mutationAction || 'n/a'} webAccessMode=${_tc.webAccessMode || 'n/a'}`);

  // Entities — one deterministic extraction, consumed by fill steps AND the
  // guardian-rules seam below.
  try {
    const _em = String(userMessage || '');
    const _ent = {};
    const _titled = _em.match(/\b(?:titled|named|called)\s+["']([^"']+)["']/i);
    const _saying = _em.match(/\b(?:saying|that says?|with (?:the )?body|with (?:the )?subject|message(?:\s+text)?)\s+["']([^"']+)["']/i);
    const _mailto = _em.match(/\bto\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/);
    const _quoted = _em.match(/"([^"\n]{3,})"|'([^'\n]{3,})'/);
    if (_titled) _ent.title = _titled[1].trim();
    if (_saying) _ent.body = _saying[1].trim();
    else if (_quoted) _ent.body = (_quoted[1] || _quoted[2]).trim();
    if (_mailto) _ent.to = _mailto[1];
    if (Object.keys(_ent).length) taskFacts.entities = _ent;
  } catch (_) {}

  // Guardian rules — preflight seam: service/entity-level rules evaluated on
  // resolved facts BEFORE any skill executes. `block` aborts via planError
  // (routes to logConversation — no plan, no skills). `ask` challenges for
  // the guardian passphrase inline via gatherAnswerCallback; failure aborts.
  // The comms-graph entry guard covers the prompt level; this seam covers
  // facts only resolution knows (entities, resolved service, destination).
  let _rulesMod = null;
  try {
    let _rp = __dirname;
    for (let _i = 0; _i < 6 && !_rulesMod; _i++) {
      const _cand = path.join(_rp, 'mcp-services/command-service/src/skill-helpers/rules.cjs');
      if (fs.existsSync(_cand)) _rulesMod = require(_cand);
      _rp = path.dirname(_rp);
    }
  } catch (_) {}
  if (_rulesMod) {
    try {
      const _hit = _rulesMod.firstGuardHit({
        prompt: userMessage,
        service: taskFacts.service,
        entities: taskFacts.entities || {},
        intent: taskFacts.intent,
      }, 'preflight');
      if (_hit) {
        const _act = _hit.then?.action;
        logger.warn(`[Node:PreflightAgents] guardian rule ${_hit.id} matched preflight — action=${_act}`);
        let _allowed = false;
        if (_act === 'ask' && gatherAnswerCallback && _rulesMod.hasPassphrase()) {
          _emitProgress({ type: 'ask_user', question: `Guardian rule "${_hit.id}" requires the passphrase to proceed.`, source: 'preflightAgents' });
          try {
            _allowed = _rulesMod.verifyPassphrase(await gatherAnswerCallback(`Guardian rule "${_hit.id}" requires the passphrase:`));
          } catch (_) { _allowed = false; }
        }
        if (!_allowed) {
          const _why = _hit.then?.reason || `rule ${_hit.id}`;
          return {
            ...state, taskFacts,
            planError: `Blocked by guardian rule ${_hit.id}: ${_why}`,
            preflightDone: true,
            preflightResult: { agents: [] },
          };
        }
      }
    } catch (e) {
      logger.warn(`[Node:PreflightAgents] guardian rule evaluation failed: ${e.message}`);
    }
  }
  const _isPublicWebTask = (_tc.webAccessMode === 'download' || _tc.webAccessMode === 'public_read')
    && !taskFacts.isMutation;
  // Pure query tasks (research/Q&A, no named service) take the same exit.
  const _isPureQuery = _tc.taskType === 'query' && !_tc.targetService;
  if (selectedAgentIds.size === 0 && createAgentSpecs.length === 0 && !recoveryContext &&
      (_tc.taskType === 'local_file' || _tc.taskType === 'local_system' || _isPublicWebTask || _tc.activeDocRef === 'file' || _isPureQuery)) {
    logger.info(`[Node:PreflightAgents] Fast path — no agents selected, taskType=${_tc.taskType} webAccessMode=${_tc.webAccessMode || 'n/a'} → skipping heavy preflight`);
    _emitProgress({ type: 'preflight:complete', agents: [], warnings: [] });
    return {
      ...state,
      taskFacts,
      preflightDone: true,
      preflightResult: {
        cliPreflightNote: '',
        agentContextNote: '',
        preflightCliMap: {},
        registeredAgentServiceMap: {},
        trainedRecipeMap: {},
        agents: [],
        vetAvailable,
        warnings: [],
      },
    };
  }

  // ── Scoped readiness — the compiler owns discovery/install/onboarding ──────
  //
  // comms-graph planning compiles plans and onboards capabilities
  // (capability.probe → setup.start → capability.select). This runtime node
  // therefore checks ONLY the agents the plan/pin actually names: registry
  // membership + auth ledger + binary presence on PATH. It never:
  //   - LLM-extracts services from the prompt (cli.agent preflight_check)
  //   - builds/registers agents (build_agent / createAgentSpecs)
  //   - probes auth status, CLIs, vet/yt-dlp/ffmpeg, MCP health, or PATH
  //   - runs tool.discover, monthly validation, or route mandates
  //   - emits sign-in cards — needed agents that are unregistered or
  //     unauthenticated escalate via _needsPlan so the compiler onboards them.

  const _registry = (await _fetchAgents()).filter(a => a && a.id);
  const _byId = new Map();
  for (const a of _registry) _byId.set(String(a.id).toLowerCase(), a);

  // Registry-derived maps for the live-plan path (recovery replan) — one
  // agent.list call, zero probes.
  for (const a of _registry) {
    const stem = String(a.id || '').replace(/\.agent$/, '').toLowerCase();
    const svc = String(a.service || stem).toLowerCase();
    if (svc) _registeredAgentServiceMap[svc] = a.id;
    if (stem && stem !== svc) _registeredAgentServiceMap[stem] = a.id;
    _preflightCliMap[stem] = { hasCli: !!(a.cliTool || a.cli_tool) };
  }

  // Needed agents = resolver picks ∪ pin ∪ deterministic-external service
  // agent ∪ agentIds named in plan steps. create:true specs land here too —
  // the registry check below catches them (runtime never builds agents).
  const _normAgentId = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (s.endsWith('.agent')) return s;
    if (!s.includes('.')) return `${s}.agent`;
    return null; // capability ids like 'video.ffmpeg' are not agent ids
  };
  const _neededIds = new Set();
  for (const id of selectedAgentIds) { const n = _normAgentId(id); if (n) _neededIds.add(n); }
  for (const spec of createAgentSpecs) { const n = _normAgentId(spec.agentId); if (n) _neededIds.add(n); }
  if (state._pinnedAgentId) {
    const n = _normAgentId(state._pinnedAgentId);
    if (n) _neededIds.add(n);
    else logger.warn(`[Node:PreflightAgents] Ignoring malformed pin "${state._pinnedAgentId}" — not a .agent id`);
  }
  if (state._deterministicServiceAgent) {
    const n = _normAgentId(state._deterministicServiceAgent);
    if (n) _neededIds.add(n);
  }
  const _planSteps = (Array.isArray(state._deterministicPlan) ? state._deterministicPlan : null)
    || (Array.isArray(state._skillPlan) ? state._skillPlan : null) || [];
  for (const s of _planSteps) {
    const n = _normAgentId(s?.args?.agentId);
    if (n) _neededIds.add(n);
  }
  if (createAgentSpecs.length > 0) {
    logger.info(`[Node:PreflightAgents] ${createAgentSpecs.length} create:true spec(s) — runtime never builds agents; routing through registry check`);
  }

  const _notOnboarded = [];  // needed but absent from the registry
  const _notAuthed = [];     // registered but ledger says auth required
  const _missingBins = new Set(); // required binaries absent from PATH
  const _skillIds = await _fetchSkillIds();

  for (const id of _neededIds) {
    const rec = _byId.get(id);
    const startUrl = rec?.startUrl || rec?.start_url || null;
    const iconUrl = agentIdToIconUrl(id, startUrl);
    if (!rec) {
      // Dispatchable command-service skill — executes via command.automate,
      // not the agent registry. Registry precedence: a real registered agent
      // with the same id would have matched above and kept its auth checks.
      if (_skillIds.has(id)) {
        agentReadiness.push({
          type: 'skill', agentId: id, ready: true, authed: true,
          reason: 'dispatchable command-service skill', iconUrl,
        });
        continue;
      }
      _notOnboarded.push(id);
      agentReadiness.push({
        type: 'unknown', agentId: id, ready: false, authed: false,
        reason: 'no registered agent — onboarding is a compile-time step',
        iconUrl,
      });
      continue;
    }
    const type = rec.type || 'browser';
    const bypassed = _isBypassedNow(id);
    let authed = true;
    let reason = null;
    if (['browser', 'api_key', 'bearer', 'basic'].includes(type)) {
      const svc = id.replace(/\.agent$/, '');
      const ledger = _getLedgerAuth(id) || {};
      const knownNeed = _SERVICE_NEEDS_AUTH.has(svc) ? _SERVICE_NEEDS_AUTH.get(svc)
        : (ledger.needsAuth === 0 ? 0 : ledger.needsAuth === 1 ? 1 : undefined);
      const anonymousOk = knownNeed === 0 || _isPublicWebTask;
      authed = bypassed || anonymousOk || ledger.authed === true
        || (knownNeed === undefined && _browserProfileHasCookies(id));
      if (!authed) { reason = 'authentication is required'; _notAuthed.push(id); }
    } else if (type === 'cli') {
      const bin = rec.cliTool || rec.cli_tool || id.replace(/\.agent$/, '');
      if (!_whichSync(bin)) {
        _missingBins.add(`${id} (${bin})`);
        agentReadiness.push({
          type, agentId: id, ready: false, authed: true,
          reason: `CLI binary not on PATH: ${bin}`, iconUrl, startUrl, cliTool: bin,
        });
        continue;
      }
      // Auth-gated only when the descriptor declares an auth surface —
      // setupInfo.authCmd/credentials or an 'authentication' capability.
      // Auth-less CLIs pass unconditionally: a probe that can't prove login
      // is not a wall (observed: fabricated ffmpeg agent → phantom auth gate).
      const setupInfo = _parseSetupInfo(rec.descriptor || '');
      const caps = Array.isArray(rec.capabilities) ? rec.capabilities.map(c => String(c).toLowerCase()) : [];
      const declaresAuth = !!(setupInfo?.authCmd || setupInfo?.credentials || caps.includes('authentication'));
      if (declaresAuth) {
        const la = _cliLedgerAuth(id);
        authed = la.authed || bypassed;
        if (!authed) { reason = 'authentication is required'; _notAuthed.push(id); }
      }
    }
    agentReadiness.push({
      type, agentId: id, ready: true, authed, needsLogin: !authed, reason,
      iconUrl, startUrl,
      cliTool: type === 'cli' ? (rec.cliTool || rec.cli_tool || null) : undefined,
    });
  }

  // Sanity-check binaries named in deterministic/saved plan steps — ~1ms
  // each. A saved plan can outlive the tools it was compiled against; a
  // missing binary here means the plan can't run → escalate so the compiler
  // reinstalls (or re-plans around it). Never installs, never probes.
  for (const s of _planSteps) {
    const cmd = s?.args?.cmd;
    if (s?.skill === 'shell.run' && typeof cmd === 'string'
        && /^[a-zA-Z0-9._-]+$/.test(cmd)) {
      if (!_whichSync(cmd)) _missingBins.add(`plan step (${cmd})`);
    }
  }

  const _escalate = (reason, detail) => {
    if (state._allowPlannerFallback) {
      warnings.push({ type: 'readiness', message: `${reason}: ${detail} — planner fallback active, continuing` });
      return null;
    }
    logger.warn(`[Node:PreflightAgents] Scoped readiness → needs_plan (${reason}): ${detail}`);
    _emitProgress({ type: 'preflight:complete', agents: agentReadiness, warnings });
    return {
      ...state,
      taskFacts,
      preflightDone: true,
      _needsPlan: {
        reason,
        detail,
        seedPrompt: `${userMessage}\n\n[Runtime readiness: ${reason} — ${detail}]`,
        refs: extractContextRefs(userMessage),
        gatheredContext: (state.planGatheringAnswers || []),
        missingAgents: [..._notOnboarded, ..._notAuthed],
      },
      preflightResult: {
        cliPreflightNote: '',
        agentContextNote: '',
        preflightCliMap: _preflightCliMap,
        registeredAgentServiceMap: _registeredAgentServiceMap,
        trainedRecipeMap: _trainedRecipeMap,
        agents: agentReadiness,
        vetAvailable,
        warnings,
      },
    };
  };

  if (_notOnboarded.length > 0) {
    const esc = _escalate('agent_not_onboarded', `needed agent(s) not registered: ${_notOnboarded.join(', ')}`);
    if (esc) return esc;
    // Planner-fallback mode — drop unregistered agents so planning proceeds
    // without them rather than re-escalating (user declined the planning lane).
    if (state.resolveAgentResult?.agents) {
      state.resolveAgentResult = {
        ...state.resolveAgentResult,
        agents: state.resolveAgentResult.agents.filter(a => !_notOnboarded.includes(_normAgentId(a?.agentId))),
      };
    }
  }
  if (_notAuthed.length > 0) {
    const esc = _escalate('auth_required', `needed agent(s) not authenticated: ${_notAuthed.join(', ')} — sign-in is a compile-time step (setup.start)`);
    if (esc) return esc;
  }
  if (_missingBins.size > 0) {
    const esc = _escalate('cli_not_installed', `required binaries missing from PATH: ${[..._missingBins].join(', ')}`);
    if (esc) return esc;
  }

  // Literal URL in the prompt IS the destination — no deep-link resolution.
  // (The old resolver search-wrapped the whole prompt into a YouTube search
  // URL even when the watch URL was right there.)
  const _literalUrl = (String(userMessage).match(/https?:\/\/[^\s"'<>\])}]+/i) || [])[0];
  if (_literalUrl && !taskFacts.destination) {
    taskFacts.destination = { url: _literalUrl, source: 'message', deepLinkType: null, expectsOverlay: false };
  }

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
    // Regenerate the planner-facing TRAINED RECIPES note from the final
    // disk-derived map.
    const _byAgent = {};
    const _seenSkill = new Set();
    for (const v of Object.keys(_trainedRecipeMap)) {
      const r = _trainedRecipeMap[v];
      if (!r || !r.agentId || !r.skillName) continue;
      const key = `${r.agentId}|${r.skillName}`;
      if (_seenSkill.has(key)) continue;
      _seenSkill.add(key);
      (_byAgent[r.agentId] = _byAgent[r.agentId] || []).push(r.skillName);
    }
    const _recipeLines = Object.entries(_byAgent)
      .map(([aid, names]) => `- ${aid}: [${[...new Set(names)].join(', ')}] → use browser.agent { action: "run", agentId: "${aid}" }`);
    if (_recipeLines.length > 0) {
      agentContextNote += `\n\nTRAINED RECIPES (when user mentions these, use browser.agent/cli.agent):\n${_recipeLines.join('\n')}`;
    }
  }

  // Planner-facing notes — needed-agent readiness + the registered catalog,
  // for the live-plan path (recovery replan). Deterministic runs never read
  // these. Registry-derived only — zero probes.
  if (agentReadiness.length > 0) {
    agentContextNote += `\n\nNEEDED-AGENT READINESS:\n${agentReadiness.map(a => `- ${a.agentId} [${a.type}] ready=${a.ready} authed=${a.authed}${a.reason ? ` (${a.reason})` : ''}`).join('\n')}`;
  }
  const _catalogLines = _registry
    .filter(a => ['browser', 'cli', 'api_key', 'bearer', 'basic', 'mcp', 'local'].includes(a.type))
    .slice(0, 60)
    .map(a => `- ${a.id}: type=${a.type}${(a.cliTool || a.cli_tool) ? `, cli=${a.cliTool || a.cli_tool}` : ''}${(a.startUrl || a.start_url) ? `, start=${a.startUrl || a.start_url}` : ''}${Array.isArray(a.capabilities) ? ` — capabilities: ${a.capabilities.slice(0, 5).join(', ')}` : ''}`);
  if (_catalogLines.length > 0) {
    agentContextNote += `\n\nREGISTERED AGENTS (use the matching executor — type 'cli' → cli.agent { action: "run", agentId: "<id>", task: "..." }; type 'browser' → atomic browser skills with agentId "<id>": url.first.agent opens the destination, then dom.act / turn.loop.agent steps do the on-page work):\n${_catalogLines.join('\n')}`;
  }

  // ── Build preflightResult ───────────────────────────────────────────────────
  const preflightResult = {
    cliPreflightNote,
    agentContextNote,
    discoveredToolNote: '',
    preflightCliMap: _preflightCliMap,
    registeredAgentServiceMap: _registeredAgentServiceMap,
    trainedRecipeMap: _trainedRecipeMap,
    agents: agentReadiness,
    vetAvailable,
    warnings,
    routeChoice: {},
    singleRouteMandate: {},
    durations: _pfDur,
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

  _mark('totalMs');
  logger.info(`[Node:PreflightAgents] Preflight complete (scoped): ${agentReadiness.length} needed agents checked, ${agentReadiness.filter(a => !a.ready).length} not ready, ${agentReadiness.filter(a => !a.authed).length} need auth | timings: ${JSON.stringify(_pfDur)}`);

  return {
    ...state,
    taskFacts,
    preflightResult,
    preflightRouteChoice: {},
    preflightDone: true,
    _trainedRecipeMap: mapSize > 0 ? _trainedRecipeMap : state._trainedRecipeMap,
    routeDecision: {},
    _fileResolution: _fileResolution,
    resolvedMessage: userMessage !== (state.resolvedMessage || state.message || '')
      ? userMessage
      : state.resolvedMessage,
  };
};

module.exports.markAgentAuthed = markAgentAuthed;
module.exports.markAgentAuthFailed = markAgentAuthFailed;
module.exports._getLedgerAuth = _getLedgerAuth;
module.exports._cliLedgerAuth = _cliLedgerAuth;
module.exports.clearAuthCache = function clearAuthCache(agentId) {
  if (agentId) _authCache.delete(agentId.toLowerCase());
  try {
    const cache = _loadPersistentAuthCache();
    if (agentId) delete cache[agentId.toLowerCase()];
    _savePersistentAuthCache(cache);
  } catch (_) {}
};

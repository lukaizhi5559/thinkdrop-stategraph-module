'use strict';

const { parseLlmJson } = require('./parseLlmJson');

/**
 * localPlanTemplates.js — force-classified fast-path plans for local automation.
 *
 * Replaces the 84k-prompt LLM plan call for unambiguous single-step local ops.
 * One small classify call returns { template: N, args: {...} } — the LLM
 * chooses the template AND extracts the arguments; this file validates and
 * compiles the plan with zero further inference.
 *
 * Safety invariants (any failure → caller falls back to the LLM planner):
 *   - every path arg must appear verbatim in the message OR equal the resolved
 *     followUpTarget — the model cannot invent filesystem targets
 *   - compiled commands go through a dangerous-command denylist
 *   - content args are base64-encoded into the shell command (no quoting bugs)
 *   - no rm-style hard delete exists — file_delete moves to ~/.Trash so the
 *     action is recoverable; irreversible deletes stay on the LLM plan
 *
 * Contract:
 *   const { forceClassifyLocalPlan } = require('./localPlanTemplates');
 *   const hit = await forceClassifyLocalPlan(message, tc, llmBackend, logger);
 *   // hit → { skillPlan, template, lowRisk } | null
 */

// ── Dangerous-command denylist (applied to the COMPILED command) ─────────────
const DANGEROUS_CMD_RE = /\b(?:rm\s+-(?:r|f|rf|fr)|rmdir|mkfs|dd\s+.*of=|shutdown|reboot|halt|fdisk|diskutil\s+erase|chmod\s+777|chown\s+-R|sudo\b|su\s+-\b|launchctl\s+(?:un)?load|kill(?:all)?\s+-9|>\s*\/dev\/(?:disk|sd)|mv\s+.*\s\/dev\/null)\b/i;

const _q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const _b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// Site-search URL constructors for page_nav_scan — deterministic templates,
// never model-invented. Only the verbatim query text is interpolated.
const _eq = (s) => encodeURIComponent(String(s || '').trim());
const SITE_SEARCH_URLS = {
  google:        q => `https://www.google.com/search?q=${_eq(q)}`,
  bing:          q => `https://www.bing.com/search?q=${_eq(q)}`,
  duckduckgo:    q => `https://duckduckgo.com/?q=${_eq(q)}`,
  amazon:        q => `https://www.amazon.com/s?k=${_eq(q)}`,
  ebay:          q => `https://www.ebay.com/sch/i.html?_nkw=${_eq(q)}`,
  etsy:          q => `https://www.etsy.com/search?q=${_eq(q)}`,
  youtube:       q => `https://www.youtube.com/results?search_query=${_eq(q)}`,
  wikipedia:     q => `https://en.wikipedia.org/wiki/Special:Search?search=${_eq(q)}`,
  reddit:        q => `https://www.reddit.com/search/?q=${_eq(q)}`,
  github:        q => `https://github.com/search?q=${_eq(q)}&type=repositories`,
  stackoverflow: q => `https://stackoverflow.com/search?q=${_eq(q)}`,
  yelp:          q => `https://www.yelp.com/search?find_desc=${_eq(q)}`,
  // HN's front page IS the top-stories listing — no real /search verb needed.
  hackernews:    () => `https://news.ycombinator.com/`,
  'hacker news': () => `https://news.ycombinator.com/`,
  news_ycombinator: () => `https://news.ycombinator.com/`,
  twitter:       q => `https://x.com/search?q=${_eq(q)}`,
  x:             q => `https://x.com/search?q=${_eq(q)}`,
};

// Deterministic query extraction for nav-scan when the classifier returns a
// site but no query ("goto amazon and search for mechanical pencils" →
// {url:"amazon"}). Strip nav verbs + site names + filler; the remainder is
// the search text. Empty remainder → let the LLM planner handle it.
function _extractNavQuery(message) {
  let q = ` ${String(message || '')} `;
  q = q.replace(/\b(?:go(?:\s*to)?|goto|open|navigate(?:\s+to)?|visit|search(?:\s+for)?|look\s*(?:up|for)|find|browse|check(?:\s+out)?|show\s+me|and\s+(?:then\s+)?(?:search|look|find)|tell\s+me(?:\s+about)?)\b/gi, ' ');
  for (const key of Object.keys(SITE_SEARCH_URLS)) {
    q = q.replace(new RegExp(`\\b${key}\\b`, 'gi'), ' ');
  }
  q = q.replace(/\b(?:please|the|a|an|for|on|in|and|then|to|of|me|some|any)\b/gi, ' ');
  return q.replace(/\s+/g, ' ').replace(/^[\s.,;:!?'"]+|[\s.,;:!?'"]+$/g, '').trim();
}

// Lexical pre-gate: only fire the classify call when the message could
// plausibly be a local op. This is a TRIGGER, not a decision — a miss just
// means no prefire (the decompose site still calls the classifier directly).
const _PRE_GATE_RE = /(?:^|[\s"'`(\[])(?:~?\/[^\s"'`)]+|\.\.?\/[^\s"'`)]+)|\b(?:battery|disk|uptime|volume|mute|unmute|screenshot|screen\s?shot|screen|terminal|shell|open|launch|quit|remind\w*|alarm|cancel|schedule|process|wifi|bluetooth|hostname|memory|cpu|copy|move|rename|append|write|create|read|list|file|delete|trash|remove|goto|go\s+to|visit|navigate|browse|page)\b/i;
function looksLikeLocalOp(message) {
  return _PRE_GATE_RE.test(String(message || ''));
}

// Resolve the deterministic plan for a message — uses the prefired promise
// when resolveReferencesV2 already launched the classify call in parallel
// with classifyTask (saves the serial ~2–4s). A resolved followUpTarget means
// the prefire ran with incomplete context → reclassify with the target.
async function _classifyDeterministic(message, tc, llmBackend, logger) {
  // One bounded inline retry for a failed/stalled classify — a healthy
  // provider answers this small prompt in ~2-5s, so a fresh call usually
  // lands even when the first hit a dead stream or tripped breaker.
  const retryOnce = async () => {
    const retry = await Promise.race([
      forceClassifyLocalPlan(message, tc, llmBackend, logger),
      new Promise(res => setTimeout(() => res('__timeout'), 20000)),
    ]).catch(() => '__timeout');
    return retry === '__timeout' || retry === '__error' ? null : retry;
  };
  const hasTarget = tc && typeof tc.followUpTarget === 'string' && tc.followUpTarget;
  // Templates that consume the resolved file target — only these need a
  // re-classify with full context when the prefire ran without it.
  const _TARGET_TEMPLATES = new Set(['file_create', 'file_append', 'file_read', 'file_list', 'file_move', 'file_delete']);
  if (tc && tc._detPrefirePromise) {
    // Bound the wait — a real template hit resolves in ~2-5s. A stalled
    // provider can hold the classify call for 60s+; awaiting it serializes a
    // dead call into the critical path when the right answer was n=0 anyway.
    try {
      const hit = await Promise.race([
        tc._detPrefirePromise,
        new Promise(res => setTimeout(() => res('__timeout'), 8000)),
      ]);
      if (hit === '__timeout' || hit === '__error') {
        logger?.info(`[localPlanTemplates] prefired classify ${hit === '__timeout' ? 'timed out at 8s' : 'failed'} — retrying once inline`);
        return retryOnce();
      }
      // File templates need the resolved target the prefire didn't have —
      // everything else (page_nav_scan, url_open, sys_query…) is context-
      // complete, so keep the hit rather than paying for a re-classify
      // that can return different args and fail validation on a flake.
      if (hit && (!hasTarget || !_TARGET_TEMPLATES.has(hit.template))) return hit;
      // Prefire ran before classifyTask — when it lacked the live-page context
      // (ACTIVE PAGE line + activeDocRef for template validation) its null is
      // not decisive for url-doc tasks. Re-classify with the full tc.
      if (tc.activeDocRef === 'url' || (hasTarget && (!hit || _TARGET_TEMPLATES.has(hit.template)))) {
        const hit2 = await forceClassifyLocalPlan(message, tc, llmBackend, logger);
        return hit2 === '__error' ? retryOnce() : hit2;
      }
      // Prefired classify returned null — same prompt/context, re-calling
      // would return the same. Fall through to LLM planner.
      return null;
    } catch (_) { return null; }
  }
  if (hasTarget) {
    const hit = await forceClassifyLocalPlan(message, tc, llmBackend, logger);
    return hit === '__error' ? retryOnce() : hit;
  }
  const hit = await forceClassifyLocalPlan(message, tc, llmBackend, logger);
  return hit === '__error' ? retryOnce() : hit;
}

// Every path arg must appear verbatim in the message or equal a resolved
// followUpTarget — prevents hallucinated filesystem targets.
function _pathArgOk(p, message, resolvedTarget) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const norm = p.trim().replace(/\/+$/, '');
  if (!/^(?:~?\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(norm)) return false;
  if (message.includes(norm) || message.includes(p.trim())) return true;
  if (resolvedTarget && (resolvedTarget === norm || resolvedTarget === p.trim())) return true;
  return false;
}

function _validatePaths(args, keys, message, resolvedTarget) {
  for (const k of keys) {
    if (!_pathArgOk(args[k], message, resolvedTarget)) return `arg.${k} not a message-verbatim/resolved path`;
  }
  return null;
}

const _SYS_KIND_ALIASES = [
  [/batt|power|charge/, 'battery'],
  [/disk|storage|space|drive/, 'disk'],
  [/uptime|up\s*time|running|long/, 'uptime'],
  [/mem|ram/, 'memory'],
  [/cpu|processor|load/, 'cpu'],
  [/proc/, 'processes'],
  [/app|program|open/, 'apps'],
  [/net|ip|wifi|internet/, 'network'],
  [/host|machine|device|computer|os|version|system/, 'hostname'],
];
function _normalizeSysKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (_sysQueryCmd(k)) return k;
  for (const [re, canon] of _SYS_KIND_ALIASES) if (re.test(k)) return canon;
  return null;
}

function _sysQueryCmd(kind) {
  switch ((kind || '').toLowerCase()) {
    case 'battery': return 'pmset -g batt';
    case 'disk': return 'df -h /';
    case 'uptime': return 'uptime';
    case 'memory': return 'vm_stat | head -10; echo "---"; sysctl -n hw.memsize';
    case 'cpu': return 'top -l 1 -n 0 | grep "CPU usage"';
    case 'processes': return 'ps aux -r | head -15';
    case 'apps': return `osascript -e 'tell application "System Events" to get name of (processes where background only is false)'`;
    case 'network': return 'ifconfig | grep "inet " | grep -v 127.0.0.1';
    case 'hostname': return 'hostname; sw_vers';
    default: return null;
  }
}

// ── Template catalog ─────────────────────────────────────────────────────────
// describe is what the classify call sees. build() returns the skillPlan steps.
const TEMPLATES = [
  {
    n: 1, id: 'file_create', lowRisk: false,
    describe: 'create a new file with given content — args: {path, content}',
    validate: (a, m, t) => _pathArgOk(a.path, m, t) ? (typeof a.content === 'string' ? null : 'arg.content missing') : 'arg.path not verbatim/resolved',
    build: (a) => [{ skill: 'shell.run', args: {
      cmd: 'bash', argv: ['-c', `mkdir -p ${_q(_dirname(a.path))} && printf '%s' ${_q(_b64(a.content))} | base64 -d > ${_q(a.path)}`],
    }, description: `Create ${a.path}` }],
  },
  {
    n: 2, id: 'file_append', lowRisk: false,
    describe: 'append given text/content to an existing file — args: {path, content}',
    validate: (a, m, t) => _pathArgOk(a.path, m, t) ? (typeof a.content === 'string' ? null : 'arg.content missing') : 'arg.path not verbatim/resolved',
    build: (a) => [{ skill: 'shell.run', args: {
      cmd: 'bash', argv: ['-c', `printf '%s' ${_q(_b64(a.content))} | base64 -d >> ${_q(a.path)}`],
    }, description: `Append to ${a.path}` }],
  },
  {
    n: 3, id: 'file_read', lowRisk: true,
    describe: 'read a file or answer a question about a file\'s contents ("read X", "what does this file say", "what\'s this file about", "summarize this file") — args: {path}',
    validate: (a, m, t) => _validatePaths(a, ['path'], m, t),
    build: (a) => [{ skill: 'fs.read', args: { action: 'read', path: a.path }, description: `Read ${a.path}` }],
  },
  {
    n: 4, id: 'file_list', lowRisk: true,
    describe: 'list files in a directory — args: {path}',
    validate: (a, m, t) => _validatePaths(a, ['path'], m, t),
    build: (a) => [{ skill: 'shell.run', args: { cmd: 'ls', argv: ['-la', a.path] }, description: `List ${a.path}` }],
  },
  {
    n: 5, id: 'file_move', lowRisk: false,
    describe: 'rename, move, or copy a file/dir — args: {src, dst, op: "move"|"rename"|"copy"}',
    validate: (a, m, t) => _validatePaths(a, ['src', 'dst'], m, t),
    build: (a) => {
      const op = /copy/i.test(a.op || '') ? 'cp -R' : 'mv';
      return [{ skill: 'shell.run', args: {
        cmd: 'bash', argv: ['-c', `mkdir -p ${_q(_dirname(a.dst))} && ${op} ${_q(a.src)} ${_q(a.dst)}`],
      }, description: `${op === 'mv' ? 'Move' : 'Copy'} ${a.src} → ${a.dst}` }];
    },
  },
  {
    n: 6, id: 'sys_query', lowRisk: true,
    describe: 'read local device/system state — args: {kind: "battery"|"disk"|"uptime"|"memory"|"cpu"|"processes"|"apps"|"network"|"hostname"}',
    validate: (a) => _normalizeSysKind(a.kind) ? null : 'unknown sys_query kind',
    build: (a) => {
      const kind = _normalizeSysKind(a.kind);
      return [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', _sysQueryCmd(kind)] }, description: `System query: ${kind}` }];
    },
  },
  {
    n: 7, id: 'sys_control', lowRisk: false,
    describe: 'change device setting: volume/mute — args: {setting: "volume"|"mute", level: number}',
    validate: (a) => {
      if (!/^(volume|mute)$/i.test(a.setting || '')) return 'unknown setting';
      const lv = Number(a.level);
      if (!Number.isFinite(lv) || lv < 0 || lv > 100) return 'level out of range';
      return null;
    },
    build: (a) => {
      const lv = Math.round(Number(a.level));
      const cmd = a.setting === 'mute'
        ? `osascript -e 'set volume ${lv === 0 ? 'with' : 'without'} output muted'`
        : `osascript -e 'set volume output volume ${lv}'`;
      return [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', cmd] }, description: `Set ${a.setting} to ${lv}` }];
    },
  },
  {
    n: 8, id: 'screenshot', lowRisk: true,
    describe: 'take a screenshot / capture the screen — args: {}',
    validate: () => null,
    // screencapture + file write legitimately exceeds the 10s fast-path cap
    // (observed timeout → ThinRecovery ask loop). Declared budget: 30s.
    build: () => [{ skill: 'screen.capture', args: { timeoutMs: 30000 }, description: 'Capture screenshot' }],
  },
  {
    n: 9, id: 'app_control', lowRisk: true,
    describe: 'open/launch/focus or quit a local app by name — args: {app, op: "open"|"quit"}',
    validate: (a) => {
      if (!/^(open|launch|quit)$/i.test(a.op || '')) return 'unknown op';
      if (!/^[\w .&'+-]{1,60}$/i.test(String(a.app || ''))) return 'bad app name';
      return null;
    },
    build: (a) => {
      const cmd = /quit/i.test(a.op)
        ? `osascript -e 'tell application "${String(a.app).replace(/"/g, '\\"')}" to quit'`
        : `open -a ${_q(a.app)}`;
      return [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', cmd] }, description: `${a.op} ${a.app}` }];
    },
  },
  {
    n: 10, id: 'url_open', lowRisk: true,
    describe: 'open a URL in the default browser — args: {url}',
    validate: (a, m) => {
      const raw = String(a.url || '').trim();
      if (!raw || !m.includes(raw)) return 'url not message-verbatim';
      // Accept full URLs and bare hosts ("youtube.com") — `open` handles both.
      if (/^https?:\/\//i.test(raw)) { try { new URL(raw); return null; } catch (_) { return 'bad url'; } }
      if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/?#][^\s]*)?$/i.test(raw)) return null;
      return 'bad url';
    },
    build: (a) => {
      // macOS `open` treats a bare host as a file path — add the scheme.
      const raw = String(a.url).trim();
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      return [{ skill: 'shell.run', args: { cmd: 'open', argv: [url] }, description: `Open ${url}` }];
    },
  },
  {
    n: 11, id: 'shell_cmd', lowRisk: false,
    describe: 'run the exact shell/terminal command the user quoted — args: {cmd} (verbatim, complete command)',
    validate: (a, m) => {
      const c = String(a.cmd || '').trim();
      if (!c) return 'cmd empty';
      // The command (or its quoted form) must appear in the message — prevents
      // the model synthesizing commands the user never wrote.
      if (!m.includes(c)) return 'cmd not message-verbatim';
      if (DANGEROUS_CMD_RE.test(c)) return 'cmd on denylist';
      return null;
    },
    build: (a) => [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', a.cmd] }, description: `Run: ${a.cmd.slice(0, 60)}` }],
  },
  {
    n: 12, id: 'remind_create', lowRisk: false,
    describe: 'set a one-shot reminder/alarm — args: {delayMs (number, ms from now) or time (clock time like "18:30"), label (what to remind about)}. Still pick this when the requested time is odd or in the past — the schedule step resolves and reports that at execution, planning must not route it to a calendar agent',
    validate: (a) => {
      if (typeof a.label !== 'string' || !a.label.trim()) return 'label missing';
      const d = Number(a.delayMs);
      const hasTime = typeof a.time === 'string' && /^\d{1,2}:\d{2}/.test(a.time.trim());
      if (!hasTime && !(Number.isFinite(d) && d > 0)) return 'delayMs/time missing';
      // Bound scaling errors — a wrong unit should hit the LLM planner, not
      // silently schedule days out.
      if (Number.isFinite(d) && d > 24 * 3600e3) return 'delay too large';
      return null;
    },
    build: (a) => {
      const args = a.time ? { time: String(a.time).trim(), label: a.label.trim() } : { delayMs: Number(a.delayMs), label: a.label.trim() };
      return [{ skill: 'schedule', args, description: `Remind: ${a.label.trim()}` }];
    },
  },
  {
    n: 13, id: 'schedule_cancel', lowRisk: false,
    describe: 'cancel/delete a scheduled reminder or alarm — args: {query (label words) or all:true}',
    validate: (a) => ((typeof a.query === 'string' && a.query.trim()) || a.all === true) ? null : 'query missing',
    build: (a) => [{ skill: 'schedule_cancel',
      args: a.all === true ? { query: String(a.query || '').trim(), all: true } : { query: String(a.query || '').trim() },
      description: a.all === true ? 'Cancel all pending reminders' : `Cancel reminder matching "${String(a.query || '').trim()}"` }],
  },
  {
    // External-service tier: pin the named service's browser agent and let
    // preflight handle auth/routing. Skips LLM agent selection + the full
    // planning prompt — the task text is the user's message verbatim, so the
    // model cannot invent instructions.
    n: 14, id: 'service_task', lowRisk: false, external: true,
    describe: 'action on an external service (post/send/add/search/create/play on twitter/x, gmail, todoist, slack, github, spotify, amazon, notion, reddit, linkedin, youtube, etc.) — args: {service}. Generic service nouns count: "send an email/mail" → gmail, "text message/sms" → sms, "calendar event" → google_calendar.',
    validate: (a, m) => {
      const name = _canonicalService(a.service);
      if (!name) return 'bad service name';
      // The service (or one of its aliases) must be mentioned in the message —
      // the model cannot route to a service the user didn't ask for.
      const needles = SERVICE_ALIASES[name] || [name];
      if (!needles.some(al => new RegExp(`\\b${al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m))) {
        return 'service not named in message';
      }
      return null;
    },
    build: (a, m) => {
      const name = _canonicalService(a.service);
      // No stepType — a forced 'on-page-action' makes browser.agent skip
      // deep-link resolution AND unset URL-first (browser.agent.cjs run()),
      // which breaks compose/send tasks (e.g. gmail #inbox?compose=new).
      // _isOnPageAction/classifyTaskIntent already distinguish genuine
      // on-page verbs (reply, like, add to cart) from navigation intents.
      return [
        { skill: 'browser.agent',
          args: { action: 'run', agentId: `${name}.agent`, task: m },
          description: `${name}: ${String(m).slice(0, 60)}` },
        { skill: 'synthesize', stepType: 'verify',
          args: { prompt: 'Report whether the requested action completed, in one short sentence.' },
          description: 'Report outcome' },
      ];
    },
  },
  {
    n: 15, id: 'journal_stats', lowRisk: true,
    describe: 'summarize or count the user\'s ThinkDrop task, app, or conversation activity per day / over a period (e.g. "my activity over the past week", "my task history") — args: {days? (default 7)}. Prints "Day: N" lines the caller turns into a chart or table.',
    validate: () => null,
    build: (a) => [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', _journalStatsCmd(a)] }, description: 'Summarize task activity' }],
  },
  {
    n: 16, id: 'bible_verse', lowRisk: true,
    describe: 'fetch a bible passage/verse text by reference (e.g. "john 3:16", "psalm 23", "exodus 2") — args: {ref}. Prints "Reference\\nPassage text" (bible-api.com).',
    validate: (a) => (typeof a.ref === 'string' && /^[\w .:–-]{1,40}$/i.test(a.ref.trim()) ? null : 'arg.ref missing/unsafe'),
    build: (a) => [{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', _bibleCmd(a)] }, description: `Fetch ${a.ref}` }],
  },
  {
    // Read the page already open in the user's real browser — one clipboard
    // copy through app.agent scan_page. No playwright, no bot walls, the
    // user's own sessions apply. Gated on resolveReferencesV2's url doc ref.
    n: 17, id: 'page_scan', lowRisk: true,
    describe: 'read/copy the currently open browser page and answer the user\'s question about it ("this page", "the page open", "on this page", "what does it say") — args: {}. Requires an open page (ACTIVE PAGE line below).',
    validate: (a, m, t, tc) => tc?.activeDocRef === 'url' ? null : 'no active url doc',
    build: (a, m) => [
      // timeoutMs opts out of the 10s deterministic cap — focus wait + copy
      // retries legitimately run to ~15s on a slow-loading page.
      { skill: 'app.agent', args: { action: 'scan_page', maxWaitMs: 20000, timeoutMs: 30000 }, description: 'Read the open browser page' },
      { skill: 'synthesize', stepType: 'verify', args: { prompt: `Answer the user's question using the scanned page content. User asked: "${String(m).slice(0, 300)}"` }, description: 'Answer from page content' },
    ],
  },
  {
    n: 18, id: 'page_print', lowRisk: true,
    describe: 'print the currently open browser page (Cmd+P) — args: {}. Requires an open page.',
    validate: (a, m, t, tc) => tc?.activeDocRef === 'url' ? null : 'no active url doc',
    build: () => [{ skill: 'app.agent', args: { action: 'print_page', timeoutMs: 15000 }, description: 'Print the open page' }],
  },
  {
    // "goto <site> and look up/search <query>" — navigate the real browser to
    // a deterministic site-search URL (whitelist, never model-invented), then
    // scan the loaded page. One template covers the whole lane-A corpus shape.
    n: 19, id: 'page_nav_scan', lowRisk: true,
    describe: `open a page in the browser and read/answer from it — args: {site, query} for named sites (site: one of ${Object.keys(SITE_SEARCH_URLS).join('|')}, query: verbatim search text) OR {url} only when the message contains a literal URL/host. "goto amazon and search X" → {site:"amazon",query:"X"}, never {url:"amazon"}.`,
    validate: (a, m) => {
      const raw = String(a.url || '').trim();
      const siteKey = SITE_SEARCH_URLS[raw.toLowerCase()] ? raw.toLowerCase()
        : (SITE_SEARCH_URLS[String(a.site || '').trim().toLowerCase()] ? String(a.site).trim().toLowerCase() : null);
      if (siteKey) {
        // Query: model-supplied (must be verbatim) or deterministically
        // extracted (message-derived by construction — can't invent content).
        const q = String(a.query || '').trim() || _extractNavQuery(m);
        if (q.length < 2 || q.length > 200) return 'query missing/too long';
        return null;
      }
      if (raw) {
        if (!m.includes(raw)) return 'url not message-verbatim';
        if (/^https?:\/\//i.test(raw)) { try { new URL(raw); return null; } catch (_) { return 'bad url'; } }
        if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/?#][^\s]*)?$/i.test(raw)) return null;
        return 'bad url';
      }
      return 'site not in search-url whitelist';
    },
    build: (a, m) => {
      const raw = String(a.url || '').trim();
      const siteKey = SITE_SEARCH_URLS[raw.toLowerCase()] ? raw.toLowerCase()
        : String(a.site || '').trim().toLowerCase();
      const url = raw && !SITE_SEARCH_URLS[raw.toLowerCase()]
        ? (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
        : SITE_SEARCH_URLS[siteKey](String(a.query || '').trim() || _extractNavQuery(m));
      return [
        { skill: 'app.agent', args: { action: 'navigate_url', url, timeoutMs: 15000 }, description: `Open ${url.slice(0, 70)}` },
        { skill: 'app.agent', args: { action: 'scan_page', maxWaitMs: 20000, timeoutMs: 30000 }, description: 'Read the loaded page' },
        { skill: 'synthesize', stepType: 'verify', args: { prompt: `Answer the user's request using the scanned page content. User asked: "${String(m).slice(0, 300)}"` }, description: 'Answer from page content' },
      ];
    },
  },
  {
    // Recoverable delete — mv to ~/.Trash, never rm. protectedPaths: [] opts
    // the step out of the attachment sandbox (executeCommand only injects
    // protectedPaths when the arg is absent): the attached file IS the user's
    // explicit delete target, so guarding it would deny the requested op and
    // mis-route to edit.agent. The path is still verbatim-validated.
    n: 20, id: 'file_delete', lowRisk: false,
    describe: 'delete/trash a file or folder by moving it to ~/.Trash (recoverable) — args: {path}. Pick this for delete/remove/trash of a named or attached file.',
    validate: (a, m, t) => _validatePaths(a, ['path'], m, t),
    build: (a) => {
      const base = String(a.path).replace(/\/+$/, '').split('/').pop().replace(/["`$\\;|&<>(){}]/g, '');
      return [{ skill: 'shell.run', args: {
        cmd: 'bash', argv: ['-c', `mv ${_q(a.path)} "$HOME/.Trash/${base}-$(date +%Y%m%d-%H%M%S)"`],
        protectedPaths: [],
      }, description: `Move ${a.path} to Trash` }];
    },
  },
  {
    n: 21, id: 'screen_read', lowRisk: true,
    describe: 'read or describe what is currently on the user\'s screen — visible text via OCR ("what\'s on my screen", "what am I looking at", "read my screen") — args: {}',
    validate: () => null,
    build: () => [{ skill: 'screen.capture', args: { timeoutMs: 30000 }, description: 'Read the screen' }],
  },
];

/** bible_verse — bible-api.com (free, no key). Prints "Reference" then the
 *  passage text so a screen_display step paints scripture, not JSON. */
function _bibleCmd(a) {
  const ref = String(a && a.ref || '').trim().slice(0, 40).replace(/[^\w .:–-]/g, '');
  return `curl -s --max-time 8 "https://bible-api.com/${encodeURIComponent(ref)}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);if(j.error){console.log("Could not find passage: ${ref.replace(/'/g, "")}")}else{console.log(((j.reference||"")+"\\n"+(j.text||"")).trim())}}catch(e){console.log(d.slice(0,1500))}})'`;
}

/** journal_stats gather step — buckets ~/.thinkdrop/task-journal.json entries
 *  by weekday over `days` days, printing "Mon: 4" lines. When the journal has
 *  fewer than two buckets it falls back to conversation-history message counts
 *  (conversation-service :3004) so "my activity" still resolves to real data. */
function _journalStatsCmd(a) {
  const days = Math.min(30, Math.max(1, Math.round(Number(a && a.days) || 7)));
  return `node -e '
const fs=require("fs"),os=require("os"),path=require("path"),http=require("http");
const DAYS=${days},now=Date.now(),rows={};
const bump=(ts)=>{const d=new Date(ts);if(!isNaN(d)&&now-d.getTime()<=DAYS*864e5&&d.getTime()<=now+6e4){const k=d.toDateString().slice(0,3);rows[k]=(rows[k]||0)+1;}};
const emit=()=>{const order=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];const out=order.filter(d=>rows[d]!=null).map(d=>d+": "+rows[d]);console.log(out.length?out.join("\\n"):"No recorded activity in the last "+DAYS+" days");};
try{const j=JSON.parse(fs.readFileSync(path.join(os.homedir(),".thinkdrop/task-journal.json"),"utf8"));for(const t of (Array.isArray(j)?j:[]))bump(Number(t.createdAt||t.startedAt||0));}catch(e){}
if(Object.keys(rows).length>=2){emit();}
else{
  try{
    const body=JSON.stringify({requestId:"journal_stats",payload:{startDate:new Date(now-DAYS*864e5).toISOString(),endDate:new Date(now).toISOString(),limit:500}});
    const req=http.request({host:"127.0.0.1",port:3004,path:"/message.listByDate",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)},timeout:4000},(res)=>{
      let raw="";res.on("data",c=>raw+=c);res.on("end",()=>{
        try{const env=JSON.parse(raw);const msgs=(env&&env.data&&env.data.messages)||(env&&env.messages)||[];
          for(const m of msgs){const ts=typeof m.timestamp==="number"?m.timestamp:Date.parse(m.timestamp||m.created_at||0);bump(ts);}
          emit();}catch(e){emit();}});
    });
    req.on("error",emit);req.on("timeout",()=>{req.destroy();emit();});
    req.write(body);req.end();
  }catch(e){emit();}
}'`;
}

// Service aliases — the user says "tweet"/"x"/"email", the agent is
// twitter.agent/gmail.agent. Canonical name maps to the <name>.agent registry id.
const SERVICE_ALIASES = {
  twitter:  ['twitter', 'tweet', 'x.com'],
  gmail:    ['gmail', 'email', 'e-mail', 'mail'],
  todoist:  ['todoist', 'todo'],
  slack:    ['slack'],
  github:   ['github'],
  spotify:  ['spotify'],
  amazon:   ['amazon'],
  youtube:  ['youtube', 'yt'],
  notion:   ['notion'],
  reddit:   ['reddit'],
  linkedin: ['linkedin'],
  facebook: ['facebook', 'fb'],
  linear:   ['linear'],
  sms:      ['sms', 'text message', 'imessage'],
  google_calendar: ['google calendar', 'calendar'],
  google_docs:     ['google docs'],
  google_sheets:   ['google sheets'],
};
function _canonicalService(svc) {
  const s = String(svc || '').trim().toLowerCase().replace(/\.agent$/, '').replace(/\s+/g, '_');
  if (!s) return null;
  if (SERVICE_ALIASES[s]) return s;
  if (s === 'x' || s === 'x.com') return 'twitter';
  for (const [canon, aliases] of Object.entries(SERVICE_ALIASES)) {
    if (aliases.includes(s)) return canon;
  }
  // Unknown service — still allow if it's a plausible agent name mentioned in
  // the message; validate() enforces the mention check separately.
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(s)) return null;
  return s;
}

function _dirname(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i <= 0) return '/';
  return s.slice(0, i);
}

// ── Force-classify call ──────────────────────────────────────────────────────
// Returns { template, args } | null. The prompt lists templates with arg
// schemas; the model responds {n: 0..N, args: {...}}. n=0/none → fall through.
const _CLASSIFY_PROMPT = (message, resolvedTarget, activePage) => `Pick the single template that implements the user's request, and extract its arguments. Reply with STRICT JSON only: {"n": <number>, "args": {...}} — n=0 only if NO template fits (ambiguous, or multiple independent goals like "read A then email it to B").

TEMPLATES:
${TEMPLATES.map(t => `${t.n}. ${t.id}: ${t.describe}`).join('\n')}

RULES:
- reporting the result ("tell me", "show me", "what it says") is part of the op — NOT a second goal
- path args must be copied VERBATIM from the message (or the resolved target below) — including paths inside [File: ...] attachment tags
- url must be copied verbatim from the message
- shell_cmd cmd must be the exact command the user quoted
- file_delete MOVES the file to ~/.Trash (recoverable) — it is the right pick for "delete/remove/trash this file"
- never invent paths, URLs, commands, or content

EXAMPLES:
"read /tmp/a.txt and tell me what it says" → {"n": 3, "args": {"path": "/tmp/a.txt"}}
"[File: /tmp/notes.txt] what's this about" → {"n": 3, "args": {"path": "/tmp/notes.txt"}}
"append 'milk' to ~/todo.txt" → {"n": 2, "args": {"path": "~/todo.txt", "content": "milk"}}
"what's my battery percentage" → {"n": 6, "args": {"kind": "battery"}}
"open https://a.com" → {"n": 10, "args": {"url": "https://a.com"}}
"post hello to twitter" → {"n": 14, "args": {"service": "twitter"}}
"send a slack message to #eng" → {"n": 14, "args": {"service": "slack"}}
"send an email to bob about the meeting" → {"n": 14, "args": {"service": "gmail"}}
"delete the file /tmp/old.txt" → {"n": 20, "args": {"path": "/tmp/old.txt"}}
"what's on my screen" → {"n": 21, "args": {}}
"check the weather" → {"n": 0, "args": {}}
"what's the cheapest item on this page" → {"n": 17, "args": {}} (when a page is open)
"goto amazon and search for baby clothes" → {"n": 19, "args": {"site": "amazon", "query": "baby clothes"}}
${resolvedTarget ? `RESOLVED TARGET (the file/app the user's referent points at): ${resolvedTarget}` : ''}
${activePage ? `ACTIVE PAGE: the user has a browser page open right now (${activePage}) — "this page"/"the page" refers to it, prefer template 17/18` : ''}
USER: ${message}`;

async function forceClassifyLocalPlan(message, taskClassification, llmBackend, logger) {
  if (!llmBackend || typeof llmBackend.generateAnswer !== 'function') return null;
  const resolvedTarget = (taskClassification && typeof taskClassification.followUpTarget === 'string'
    && /^(?:~?\/|\.{1,2}\/)/.test(taskClassification.followUpTarget))
    ? taskClassification.followUpTarget : null;
  // Live page in the user's real browser — lets the model pick page_scan/
  // page_print for "this page" questions instead of falling to n=0.
  const activePage = (taskClassification && taskClassification.activeDocRef === 'url'
    && typeof taskClassification.activeDocTarget === 'string')
    ? taskClassification.activeDocTarget.slice(0, 120) : null;
  try {
    const prompt = _CLASSIFY_PROMPT(message, resolvedTarget, activePage);
    // query MUST carry the full prompt — generateAnswer sends payload.query,
    // not the first arg (that param is only a fallback). Passing the raw
    // message here made the model answer the task instead of classifying it.
    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: 'You classify local automation requests into a fixed template list. Output strict JSON only.' },
    }, { maxTokens: 300, temperature: 0, fastMode: true, taskType: 'classification' });
    const text = typeof raw === 'string' ? raw : (raw?.text || raw?.content || '');
    let parsed = parseLlmJson(text, logger, 'localPlanTemplates');
    if (!parsed || typeof parsed !== 'object') {
      // Fallback: small models sometimes emit a truncated fragment then the
      // real JSON (observed: `{"n": 6{"n":6,"args":{...}}`). Retry parsing
      // from each `{"n"`/`{"template"` occurrence — take the first that yields
      // an object carrying a selection key.
      for (const m of String(text).matchAll(/\{\s*"(?:n|template)"\s*:/g)) {
        // Balanced-brace scan — args is a nested object, so indexOf('}') is wrong.
        let depth = 0, end = -1;
        for (let i = m.index; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        try {
          const cand = JSON.parse(text.slice(m.index, end + 1));
          if (cand && typeof cand === 'object' && ('n' in cand || 'template' in cand)) { parsed = cand; break; }
        } catch (_) { /* try next occurrence */ }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      logger?.debug?.(`[localPlanTemplates] no JSON in classify response: ${text.slice(0, 80)}`);
      return null;
    }
    const rawSel = parsed.n ?? parsed.template ?? 0;
    // Accept the template number OR its id string — small models often echo
    // "file_read" instead of 3.
    const tmpl = typeof rawSel === 'number' || /^\d+$/.test(String(rawSel))
      ? TEMPLATES.find(t => t.n === Number(rawSel))
      : TEMPLATES.find(t => t.id === String(rawSel));
    if (!tmpl) {
      logger?.debug?.(`[localPlanTemplates] no template match (sel=${JSON.stringify(rawSel)}): "${String(message).slice(0, 60)}"`);
      return null;
    }
    const args = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
    const err = tmpl.validate(args, message, resolvedTarget, taskClassification);
    if (err) {
      logger?.info?.(`[localPlanTemplates] ${tmpl.id} validation failed: ${err} — LLM plan fallback`);
      return null;
    }
    const skillPlan = tmpl.build(args, message).map((s, i) => ({ step: i + 1, ...s }));
    for (const s of skillPlan) {
      const cmdStr = `${s.args?.cmd || ''} ${(s.args?.argv || []).join(' ')}`;
      if (DANGEROUS_CMD_RE.test(cmdStr)) {
        logger?.warn?.(`[localPlanTemplates] compiled cmd hit denylist: ${cmdStr.slice(0, 80)}`);
        return null;
      }
    }
    logger?.info?.(`[localPlanTemplates] force-classified → ${tmpl.id} (${skillPlan.length} step, lowRisk=${tmpl.lowRisk})`);
    return {
      skillPlan, template: tmpl.id, lowRisk: tmpl.lowRisk,
      ...(tmpl.external ? { external: true, serviceAgent: `${_canonicalService(args.service)}.agent` } : {}),
    };
  } catch (err) {
    logger?.debug?.(`[localPlanTemplates] classify call failed: ${err.message}`);
    return '__error';
  }
}

module.exports = { forceClassifyLocalPlan, _classifyDeterministic, looksLikeLocalOp, TEMPLATES, DANGEROUS_CMD_RE, SITE_SEARCH_URLS };

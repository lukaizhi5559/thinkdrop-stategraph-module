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
 *   - no rm/delete templates exist — destructive ops stay on the LLM plan
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

// Lexical pre-gate: only fire the classify call when the message could
// plausibly be a local op. This is a TRIGGER, not a decision — a miss just
// means no prefire (the decompose site still calls the classifier directly).
const _PRE_GATE_RE = /(?:^|[\s"'`(\[])(?:~?\/[^\s"'`)]+|\.\.?\/[^\s"'`)]+)|\b(?:battery|disk|uptime|volume|mute|unmute|screenshot|screen\s?shot|terminal|shell|open|launch|quit|remind\w*|alarm|cancel|schedule|process|wifi|bluetooth|hostname|memory|cpu|copy|move|rename|append|write|create|read|list|file)\b/i;
function looksLikeLocalOp(message) {
  return _PRE_GATE_RE.test(String(message || ''));
}

// Resolve the deterministic plan for a message — uses the prefired promise
// when resolveReferencesV2 already launched the classify call in parallel
// with classifyTask (saves the serial ~2–4s). A resolved followUpTarget means
// the prefire ran with incomplete context → reclassify with the target.
async function _classifyDeterministic(message, tc, llmBackend, logger) {
  const hasTarget = tc && typeof tc.followUpTarget === 'string' && tc.followUpTarget;
  if (hasTarget) return forceClassifyLocalPlan(message, tc, llmBackend, logger);
  if (tc && tc._detPrefirePromise) {
    // Bound the wait — a real template hit resolves in ~2-5s. A stalled
    // provider can hold the classify call for 60s+; awaiting it serializes a
    // dead call into the critical path when the right answer was n=0 anyway.
    try {
      const hit = await Promise.race([
        tc._detPrefirePromise,
        new Promise(res => setTimeout(() => res('__timeout'), 8000)),
      ]);
      if (hit === '__timeout') {
        // One inline retry, itself bounded — a healthy provider answers this
        // small prompt in ~2-5s; if the prefire stalled mid-stream a fresh
        // call usually lands. Total added latency is capped ~28s vs the old
        // failure mode (a dead 60s call holding the critical path).
        logger?.info('[localPlanTemplates] prefired classify timed out at 8s — retrying once inline');
        const retry = await Promise.race([
          forceClassifyLocalPlan(message, tc, llmBackend, logger),
          new Promise(res => setTimeout(() => res('__timeout'), 20000)),
        ]).catch(() => null);
        if (retry === '__timeout') {
          logger?.info('[localPlanTemplates] inline classify retry timed out at 20s — falling to LLM planner');
          return null;
        }
        return retry;
      }
      if (hit) return hit;
      // Prefired classify returned null — same prompt/context, re-calling
      // would return the same. Fall through to LLM planner.
      return null;
    } catch (_) { return null; }
  }
  return forceClassifyLocalPlan(message, tc, llmBackend, logger);
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
    describe: 'read/show the contents of a file — args: {path}',
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
    describe: 'set a one-shot reminder/alarm — args: {delayMs (number, ms from now) or time (clock time like "18:30"), label (what to remind about)}',
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
    describe: 'action on a named external service the user explicitly named (post/send/add/search/create/play on twitter/x, gmail, todoist, slack, github, spotify, amazon, notion, reddit, linkedin, youtube, etc.) — args: {service}',
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
      return [
        { skill: 'browser.agent', stepType: 'on-page-action',
          args: { action: 'run', agentId: `${name}.agent`, task: m },
          description: `${name}: ${String(m).slice(0, 60)}` },
        { skill: 'synthesize', stepType: 'verify',
          args: { prompt: 'Report whether the requested action completed, in one short sentence.' },
          description: 'Report outcome' },
      ];
    },
  },
];

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
const _CLASSIFY_PROMPT = (message, resolvedTarget) => `Pick the single template that implements the user's request, and extract its arguments. Reply with STRICT JSON only: {"n": <number>, "args": {...}} — n=0 only if NO template fits (ambiguous, or multiple independent goals like "read A then email it to B").

TEMPLATES:
${TEMPLATES.map(t => `${t.n}. ${t.id}: ${t.describe}`).join('\n')}

RULES:
- reporting the result ("tell me", "show me", "what it says") is part of the op — NOT a second goal
- path args must be copied VERBATIM from the message (or the resolved target below)
- url must be copied verbatim from the message
- shell_cmd cmd must be the exact command the user quoted
- never invent paths, URLs, commands, or content

EXAMPLES:
"read /tmp/a.txt and tell me what it says" → {"n": 3, "args": {"path": "/tmp/a.txt"}}
"append 'milk' to ~/todo.txt" → {"n": 2, "args": {"path": "~/todo.txt", "content": "milk"}}
"what's my battery percentage" → {"n": 6, "args": {"kind": "battery"}}
"open https://a.com" → {"n": 10, "args": {"url": "https://a.com"}}
"post hello to twitter" → {"n": 14, "args": {"service": "twitter"}}
"send a slack message to #eng" → {"n": 14, "args": {"service": "slack"}}
"check the weather" → {"n": 0, "args": {}}
${resolvedTarget ? `RESOLVED TARGET (the file/app the user's referent points at): ${resolvedTarget}` : ''}
USER: ${message}`;

async function forceClassifyLocalPlan(message, taskClassification, llmBackend, logger) {
  if (!llmBackend || typeof llmBackend.generateAnswer !== 'function') return null;
  const resolvedTarget = (taskClassification && typeof taskClassification.followUpTarget === 'string'
    && /^(?:~?\/|\.{1,2}\/)/.test(taskClassification.followUpTarget))
    ? taskClassification.followUpTarget : null;
  try {
    const prompt = _CLASSIFY_PROMPT(message, resolvedTarget);
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
    const err = tmpl.validate(args, message, resolvedTarget);
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
    return null;
  }
}

module.exports = { forceClassifyLocalPlan, _classifyDeterministic, looksLikeLocalOp, TEMPLATES, DANGEROUS_CMD_RE };

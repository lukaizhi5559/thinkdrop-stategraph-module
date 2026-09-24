'use strict';

/**
 * planHelpers.js — shared plan utilities extracted from planSkills.js
 *
 * Contains pure helpers that have no dependency on stategraph state:
 *   - serializeSkillPlanToMd  — write a skill plan to a .md file string
 *   - buildStepDescription    — human-readable label for a plan step
 *   - parsePlan               — extract + repair JSON array from raw LLM output
 */

const { jsonrepair } = require('jsonrepair');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Serialize a JSON skill plan to a human-readable .md file.
 * Stores skill_plan_json (base64) in frontmatter so future similarity matches
 * can reuse the exact steps without re-invoking the LLM.
 * Status starts as 'pending' — only updated to 'complete' by executeCommand
 * after ALL steps succeed.
 */
function serializeSkillPlanToMd(skillPlan, originalPrompt, planId, sessionId) {
  const now = new Date().toISOString();
  const safePrompt = (originalPrompt || '').replace(/"/g, '\\"').slice(0, 300);
  const shortTitle = (originalPrompt || '').split(/\s+/).slice(0, 6).join(' ');
  const skillPlanB64 = Buffer.from(JSON.stringify(skillPlan)).toString('base64');

  const lines = [
    '---',
    `id: ${planId}`,
    `created: ${now}`,
    `status: pending`,
    `original_prompt: "${safePrompt}"`,
    `session_id: ${sessionId || 'unknown'}`,
    `skill_plan: true`,
    `skill_plan_json: '${skillPlanB64}'`,
    '---',
    '',
    `# Plan: ${shortTitle}`,
    '',
    '## Steps',
    '',
  ];

  skillPlan.forEach((step, i) => {
    const num = i + 1;
    const desc = step.description || buildStepDescription(step);
    lines.push(`### Step ${num} — ${desc}`);
    lines.push(`- **Skill**: ${step.skill}`);
    lines.push(`- **Intent**: command_automate`);
    if (step.args) {
      const argsStr = JSON.stringify(step.args, null, 0).slice(0, 200);
      lines.push(`- **Args**: \`${argsStr}\``);
    }
    lines.push(`- **Status**: ⬜ pending`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Build a human-readable description for a plan step.
 */
function buildStepDescription(step) {
  const { skill, args = {} } = step;
  if (skill === 'browser.act') {
    const action = args.action || '';
    const session = args.sessionId || '';
    const urlHost = args.url ? (() => { try { return new URL(args.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })() : '';
    const label = session || urlHost;
    return label ? `browser.act — ${action} (${label})` : `browser.act — ${action}`;
  }
  if (skill === 'shell.run') {
    const cmd = args.cmd || args.command || '';
    const argv0 = Array.isArray(args.argv) ? args.argv[0] : '';
    return cmd ? `shell.run — ${cmd}${argv0 ? ' ' + argv0 : ''}` : 'shell.run';
  }
  if (skill === 'synthesize') {
    const p = (args.prompt || '').slice(0, 40);
    return p ? `synthesize — ${p}…` : 'synthesize';
  }
  if (skill === 'browser.agent') {
    return args.task ? `browser.agent — ${args.task.slice(0, 60)}…` : `browser.agent — ${args.action} (${args.service || args.agentId || ''})`;
  }
  if (skill === 'cli.agent') {
    return args.task ? `cli.agent — ${args.task.slice(0, 60)}…` : `cli.agent — ${args.action} (${args.service || args.agentId || ''})`;
  }
  if (skill === 'playwright.agent') {
    return args.goal ? `playwright.agent — ${args.goal.slice(0, 50)}…` : 'playwright.agent';
  }
  if (skill === 'external.skill') return `external.skill — ${args.name || ''}`;

  return skill;
}

/**
 * Extract and parse a JSON array/object from raw LLM output.
 * Uses jsonrepair to handle the full spectrum of LLM JSON pathologies:
 * control characters, bad escapes, trailing commas, missing quotes,
 * truncated output, markdown fences, smart quotes, JS comments, etc.
 */
function parsePlan(raw, logger) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  const _fenceMatch = text.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\s*```/);
  if (_fenceMatch) {
    text = _fenceMatch[1].trim();
  } else {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    text = text.substring(arrayStart);
  } else if (objectStart !== -1) {
    text = text.substring(objectStart);
  } else {
    if (logger) logger.warn('[planHelpers:parsePlan] JSON parse failed: no [ or { found in output');
    return null;
  }

  try {
    const parsed = JSON.parse(jsonrepair(text));
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
      if (logger) logger.debug('[planHelpers:parsePlan] unwrapping {"steps":[...]} wrapper');
      return _validateStepSchema(parsed.steps, logger);
    }
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0]?.skill === 'string') {
          if (logger) logger.debug('[planHelpers:parsePlan] deep-scan unwrapped arbitrary object key → step array');
          return _validateStepSchema(val, logger);
        }
      }
      if (logger) logger.warn('[planHelpers:parsePlan] object has no step-array under any key — returning null');
      return null;
    }
    return _validateStepSchema(parsed, logger);
  } catch (e) {
    if (logger) logger.warn('[planHelpers:parsePlan] JSON parse failed:', e.message);
    return null;
  }
}

/**
 * Schema validation pass — marks steps where the skill's args don't match the
 * documented schema. For shell.run, requires either `goal` or `cmd` (string).
 * Marked steps get _malformed=true so _sanitizeSkillPlan can handle them
 * (convert to ask_user or fill from context). Catches LLM compliance failures
 * at parse time rather than letting them reach execution.
 */
function _validateStepSchema(steps, logger) {
  if (!Array.isArray(steps)) return steps;

  // ── Structural normalization ─────────────────────────────────────────────
  // The planner sometimes wraps steps oddly: `[{},[{s},{s}]]` (empty object +
  // nested array), or sprinkles non-object entries. Flatten one level of
  // nested arrays and drop anything that isn't a step-shaped object — a step
  // without a string `skill` would dispatch as "undefined" downstream.
  const flat = steps.flat(Infinity);
  const kept = [];
  for (const s of flat) {
    if (s && typeof s === 'object' && !Array.isArray(s) && typeof s.skill === 'string' && s.skill.length > 0) {
      kept.push(s);
    } else {
      logger?.warn?.('[planHelpers:parsePlan] dropping non-step entry:', JSON.stringify(s)?.slice(0, 120));
    }
  }
  if (kept.length === 0 && steps.length > 0) {
    if (logger) logger.warn('[planHelpers:parsePlan] all entries were non-steps — rejecting plan');
    return null;
  }
  if (kept.length !== steps.length) {
    if (logger) logger.info(`[planHelpers:parsePlan] normalized plan: ${steps.length} → ${kept.length} step(s)`);
  }
  steps = kept;

  for (const step of steps) {
    if (step?.skill === 'shell.run' && step.args) {
      const hasGoal = typeof step.args.goal === 'string' && step.args.goal.length > 0;
      const hasCmd = typeof step.args.cmd === 'string' && step.args.cmd.length > 0;
      if (!hasGoal && !hasCmd) {
        if (logger) logger.warn('[planHelpers:parsePlan] shell.run step missing required args (goal or cmd) — marking _malformed');
        step._malformed = true;
      }
    }
  }
  return steps;
}

/**
 * Deterministic plan lint for file edits.
 *
 * The prompt tells the planner "NEVER modify an existing file via synthesize
 * saveToFile — use edit.agent" — but it still emits read → synthesize →
 * saveToFile-over-existing recipes. Same lesson as the web-mode backstop in
 * planSkillsV2: soft guidance needs a deterministic rewrite.
 *
 *   - synthesize + saveToFile pointing at an EXISTING file → edit.agent step
 *     (goal = prompt minus {{…}} markers; filePath = resolved target)
 *   - skipped: paths under ~/.thinkdrop/ (skill.md contracts + drafts are
 *     system artifacts that legitimately overwrite), unresolved {{…}} targets
 *   - a TRAILING pure-confirm synthesize ("Confirm the file was saved…") is
 *     dropped — it can't inspect the file and confabulates failure reports
 *
 * Returns { plan, rewrites } — rewrites is a log-friendly list of what changed.
 */
const _CONFIRM_ONLY_RE = /^\s*(?:please\s+)?(?:confirm(?:ed|ing)?|verify|verifying|verified|check(?:ed)?|double-check)\b[\s\S]{0,200}?\b(?:saved|written|created|applied|corrected|updated|exists|duplicated|done|completed?)\b/i;

function _expandHomeDir(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ThinkDrop attachment tags — same syntax parsed in planSkillsV2 for the
// FILE CONTEXT table. Controlled markup, not free-form text scanning.
const _ATTACH_TAG_RE = /\[(?:File|Folder):\s*([^\]]+)\]/gi;

/**
 * Attached files the user explicitly handed to this run — the paths that must
 * never be modified by raw shell.run. shell.run.cjs wraps spawned commands in
 * `sandbox-exec` with a `deny file-write*` rule per resolved path, so ANY
 * write mechanism (open('w'), sed -i, >, tee, rm, mv — including indirect
 * references via cwd/env vars) fails with EPERM instead of silently rewriting
 * a user file outside edit.agent's draft/backup rails.
 *
 * Returns [{ original, resolved }] — original is the path as written (tools
 * report it in error output, e.g. "touch: /tmp/x: Operation not permitted");
 * resolved is the realpath (Seatbelt literals match canonical paths, so
 * /tmp/… must be denied as /private/tmp/…).
 */
function getProtectedPaths(message) {
  if (!message || typeof message !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const m of message.matchAll(_ATTACH_TAG_RE)) {
    const original = _expandHomeDir(m[1].trim().replace(/^['"]|['"]$/g, ''));
    if (!original || seen.has(original)) continue;
    seen.add(original);
    let resolved = original;
    try { resolved = fs.realpathSync(original); } catch (_) {
      // Nonexistent attachments can't be written-to meaningfully — skip.
      continue;
    }
    out.push({ original, resolved });
  }
  return out;
}

// app.agent actions/shortcuts that mutate document content. Keystroke-edit
// plans (Cmd+F → Cmd+C → Cmd+V …) bypass every file-edit rail and can pollute
// the user's live document — a real recovery replan once did exactly that.
// Navigation/copy/close shortcuts (Cmd+F, Cmd+G, Cmd+C, Cmd+W) stay legal.
const _APPAGENT_PASTE_RE = /\b(?:cmd|command|ctrl|control|⌘)\s*\+\s*[vx]\b|paste/i;

function _isAppAgentContentMutation(step) {
  if (step?.skill !== 'app.agent') return false;
  const a = step.args || {};
  if (a.action === 'type_text') return true;
  if (a.action === 'execute_shortcut') {
    const sc = String(a.shortcutOverride || a.shortcut || '');
    if (_APPAGENT_PASTE_RE.test(sc)) return true;
    if (a.textToType || a.insertText) return true;
  }
  return false;
}

function _lintFileEditPlan(plan, logger, ctx = {}) {
  if (!Array.isArray(plan)) return { plan, rewrites: [] };
  const rewrites = [];
  const thinkdropDir = path.join(os.homedir(), '.thinkdrop') + path.sep;
  const prot = getProtectedPaths(ctx.prompt || '');

  // ── Keystroke-edit guard ─────────────────────────────────────────────────
  // Any app.agent step that inserts/pastes/types content while the user has a
  // file attached is a file edit wearing the wrong skill. Collapse to a single
  // edit.agent step when the whole plan is about the file; drop flagged steps
  // in mixed/multi-file plans rather than guess which file they meant.
  if (prot.length > 0) {
    const flaggedIdx = [];
    plan.forEach((s, i) => { if (_isAppAgentContentMutation(s)) flaggedIdx.push(i); });
    if (flaggedIdx.length > 0) {
      const flaggedSet = new Set(flaggedIdx);
      const rest = plan.filter((_, i) => !flaggedSet.has(i));
      const FILE_RELATED = new Set(['app.agent', 'synthesize', 'fs.read', 'file.read', 'edit.agent']);
      const allFileRelated = rest.every(s => FILE_RELATED.has(s?.skill));
      if (prot.length === 1 && allFileRelated) {
        const goal = String(ctx.prompt || '')
          .replace(_ATTACH_TAG_RE, '')
          .replace(/\s+/g, ' ')
          .trim() || `Edit ${path.basename(prot[0].resolved)}`;
        rewrites.push({ index: flaggedIdx[0], kind: 'app.agent-keystroke-edit→edit.agent', filePath: prot[0].resolved });
        return {
          plan: [{ skill: 'edit.agent', args: { goal, filePath: prot[0].resolved, mode: 'draft' }, description: `Edit ${path.basename(prot[0].resolved)}` }],
          rewrites,
        };
      }
      rewrites.push({ index: flaggedIdx[0], kind: 'drop-app.agent-keystroke-edit', count: flaggedIdx.length });
      plan = rest;
    }
  }

  let steps = plan.map((step, i) => {
    if (step?.skill !== 'synthesize') return step;
    const target = step.args?.saveToFile;
    if (typeof target !== 'string' || !target.trim()) return step;
    if (/\{\{[^}]*\}\}/.test(target)) return step;
    const abs = _expandHomeDir(target.trim());
    if (abs.startsWith(thinkdropDir)) return step;
    let exists = false;
    try { exists = fs.existsSync(abs); } catch (_) {}
    if (!exists) return step;
    const goal = String(step.args.prompt || '')
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/\s+/g, ' ')
      .trim() || step.description || `Edit ${path.basename(abs)}`;
    rewrites.push({ index: i, kind: 'synthesize→edit.agent', filePath: abs });
    return {
      ...step,
      skill: 'edit.agent',
      args: { goal, filePath: abs },
      description: step.description || `Edit ${path.basename(abs)}`,
    };
  });

  // ── Draft-first default ──────────────────────────────────────────────────
  // Interactive file edits should produce a reviewable draft (diff card →
  // user clicks Apply), not an immediate in-place write. Runs after the
  // synthesize→edit.agent conversion so converted steps get the default too.
  // Explicit mode:'inplace'/'apply' is respected — only fills a missing mode.
  steps = steps.map((step, i) => {
    if (step?.skill !== 'edit.agent') return step;
    const a = step.args || {};
    if (a.mode || a.writeMode) return step;
    rewrites.push({ index: i, kind: 'edit.agent→draft-mode' });
    return { ...step, args: { ...a, mode: 'draft' } };
  });

  const last = steps[steps.length - 1];
  if (steps.length > 1 && last?.skill === 'synthesize' && !last.args?.saveToFile
      && String(last.args?.prompt || '').length < 400
      && _CONFIRM_ONLY_RE.test(String(last.args.prompt))) {
    rewrites.push({ index: steps.length - 1, kind: 'drop-confirm-step' });
    steps = steps.slice(0, -1);
  }

  if (rewrites.length && logger) {
    logger.info(`[planHelpers:lintFileEditPlan] ${rewrites.length} fix(es): ${rewrites.map(r => `${r.kind}@${r.index}`).join(', ')}`);
  }
  return { plan: steps, rewrites };
}

module.exports = { serializeSkillPlanToMd, buildStepDescription, parsePlan, lintFileEditPlan: _lintFileEditPlan, getProtectedPaths };

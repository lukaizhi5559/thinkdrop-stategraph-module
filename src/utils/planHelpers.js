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
    // Atomic on-page skills: the step description IS the goal — an emitted
    // step with no args.goal/args.task fails at runtime ("dom.act: no
    // task/goal"). Default it instead of dropping the step.
    if (_GOAL_ARG_SKILLS.has(step?.skill) && step.args
        && !step.args.goal && !step.args.task
        && typeof step.description === 'string' && step.description.trim()) {
      step.args = { ...step.args, goal: step.description.trim() };
      if (logger) logger.warn(`[planHelpers:parsePlan] ${step.skill} missing goal — defaulted from step description`);
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

// On-page atomic skills whose args carry the goal text — a step emitted
// without one is defaulted from its description rather than dropped.
const _GOAL_ARG_SKILLS = new Set([
  'dom.act', 'tab.map.agent', 'just.type.agent', 'meta.find.agent',
  'turn.loop.agent', 'gesture.agent', 'arrow.grid.agent', 'shortcut.keys.agent',
  'browser.act', 'form.fill.agent',
]);

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

// Semantic-edit verbs — when a prompt carries one of these alongside an
// attached file, the plan is a file-edit job and MUST include an edit.agent
// step. Exported for planSkillsV2's hard-constraint injection.
const FILE_EDIT_INTENT_RE = /\b(?:update|edit|change|modify|remove|rewrite|rephrase|reword|restructure|reorganize|re-organize|replace|append|insert|fix|correct|translate|annotate|sort|format|clean\s*up)\b/i;

// "delete the file" is a filesystem op, not an edit — edit.agent refuses it.
const _FILE_DELETE_RE = /\bdelete\s+(?:this|the|that|my)\s+file\b/i;

const _FILE_TAG_RE = /\[File:\s*([^\]]+)\]/gi;

/**
 * Attached regular files the user handed to this run (File-tag only — folders
 * are inputs, not edit targets). Returns [{ original, resolved }] like
 * getProtectedPaths.
 */
function getAttachedFilePaths(message) {
  if (!message || typeof message !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const m of message.matchAll(_FILE_TAG_RE)) {
    const original = _expandHomeDir(m[1].trim().replace(/^['"]|['"]$/g, ''));
    if (!original || seen.has(original)) continue;
    seen.add(original);
    let resolved = original;
    try {
      resolved = fs.realpathSync(original);
      if (!fs.statSync(resolved).isFile()) continue;
    } catch (_) {
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

  // ── Missing-edit backstop ──────────────────────────────────────────────
  // A prompt that attaches a regular file AND asks to modify it must contain
  // an edit.agent step — a doc.read/fs.read → synthesize plan that merely
  // describes the new content is a failed edit (observed: "update this file"
  // planned as doc.read → shell.run → synthesize, file untouched). Appended
  // LAST so preceding gather steps (reads, folder listings, synthesized
  // content) flow into the goal via {{PREV_OUTPUT}}.
  const _attachedFiles = getAttachedFilePaths(ctx.prompt || '');
  const _editHaystack = String(ctx.prompt || '')
    .replace(_ATTACH_TAG_RE, '')
    .replace(/\[\s*Resolved file path:[^\]]*\]/gi, '');
  if (_attachedFiles.length > 0
      && FILE_EDIT_INTENT_RE.test(_editHaystack)
      && !_FILE_DELETE_RE.test(_editHaystack)
      && !steps.some(s => s?.skill === 'edit.agent')) {
    const target = ctx.filePath || _attachedFiles[0].resolved;
    const baseGoal = _editHaystack.replace(/\s+/g, ' ').trim() || `Edit ${path.basename(target)}`;
    const goal = steps.length > 0 ? `${baseGoal}\n{{PREV_OUTPUT}}` : baseGoal;
    rewrites.push({ index: steps.length, kind: 'append-edit.agent', filePath: target });
    steps = [...steps, {
      skill: 'edit.agent',
      args: { goal, filePath: target, mode: 'draft' },
      description: `Edit ${path.basename(target)}`,
    }];
  }

  if (rewrites.length && logger) {
    logger.info(`[planHelpers:lintFileEditPlan] ${rewrites.length} fix(es): ${rewrites.map(r => `${r.kind}@${r.index}`).join(', ')}`);
  }
  return { plan: steps, rewrites };
}

// ── Atomic browser plan lint ─────────────────────────────────────────────────
// url.first.agent is navigation-only BY CONTRACT — it resolves a deep link and
// opens the automation session, performing NO on-page interaction. A lone
// url.first.agent step is therefore always a smell:
//   (a) its task still carries mutation residue ("titled X", "with columns",
//       "called Y on July 15th") → the plan is nav-only for a mutation goal —
//       splice a dom.act step after it (dom.act routes internally to the right
//       executor, including turn.loop for multi-turn goals).
//   (b) pure display-nav ("open gmail") with no same-lane action steps →
//       downgrade to app.agent navigate_url — the user's real default browser
//       is the display-only lane; burning an automation session on it is
//       heavier and can hit auth walls the user's browser wouldn't.
// "Same lane" = followers with a matching/absent agentId, scanned until the
// next url.first.agent or a non-browser step. Action-capable followers:
// dom.act + the mutating executors + turn.loop.agent (mode ≠ 'verify').
// Observe-only lane members (tab.map, meta.find, turn.loop verify, synthesize)
// do NOT satisfy the rule.

// Mutating executors — a follower with any of these skills DOES on-page work.
const _ATOMIC_ACTION_SKILLS = new Set([
  'dom.act', 'just.type.agent', 'shortcut.keys.agent', 'gesture.agent', 'arrow.grid.agent',
]);
// Observe-only lane members — legal followers but perform no mutation.
const _ATOMIC_OBSERVE_SKILLS = new Set(['tab.map.agent', 'meta.find.agent']);
// turn.loop.agent is action-capable in 'act' mode (the default), observe-only
// in 'verify' mode — handled by _isActionCapableBrowserStep below.
const _BROWSER_LANE_SKILLS = new Set([
  'url.first.agent', 'turn.loop.agent', 'browser.agent', 'browser.act', 'playwright.agent',
  ..._ATOMIC_ACTION_SKILLS, ..._ATOMIC_OBSERVE_SKILLS,
]);
const _BROWSER_NAV_ACTIONS = new Set(['navigate', 'navigate_url', 'goto', 'open', 'read_url', 'scan_page']);

function _isActionCapableBrowserStep(step) {
  const skill = step?.skill;
  if (_ATOMIC_ACTION_SKILLS.has(skill)) return true;
  if (skill === 'turn.loop.agent') return String(step.args?.mode || 'act') !== 'verify';
  if (skill === 'browser.agent') return step.args?.action === 'run';
  if (skill === 'browser.act') return !_BROWSER_NAV_ACTIONS.has(step.args?.action);
  if (skill === 'playwright.agent') return true;
  return false;
}

// Mutation/interaction verbs — a nav step whose task contains these still owes
// the plan on-page work ("create" included: a start-url landing page creates
// nothing, and dom.act's pure-create guard no-ops when a creation deep link
// already did the work).
const _UF_RESIDUE_VERB_RE = /\b(?:create|add|fill|type|enter|write|compose|send|reply|forward|post|publish|schedule|book|buy|purchase|checkout|order|delete|remove|comment|like|follow|subscribe|upload|download|attach|invite|rsvp|rename|edit|update|mark|archive|star|mute|play|read|check|search|find|look\s*up|click|submit|sign)\b/i;
// Field/constraint specifics — "titled X", "with columns", "on July 15th",
// "at 8am". A task can mention no verb yet still carry unperformed work.
const _UF_RESIDUE_FIELD_RE = /\b(?:titled?|named?|called|labelled?|subject|columns?|headers?|rows?|fields?|body\b|message\b|description|attendees?|guests?|invitees?|location|duration)\b|\bon\s+(?:the\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:on|for|due|by)\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b/i;

// Shared residue test — a task string asserts on-page work beyond navigation
// when it carries a mutation/interaction verb or field-level specifics.
// Used by the lint (plan time) and executeCommand (evidence flag at runtime).
function hasMutationResidue(text) {
  const t = String(text || '');
  return _UF_RESIDUE_VERB_RE.test(t) || _UF_RESIDUE_FIELD_RE.test(t);
}

// Display-only navigation — the task must START with a nav verb. Anything
// trailing a conjunction is captured by the residue check first.
const _NAV_ONLY_TASK_RE = /^\s*(?:please\s+)?(?:open|go\s*to|goto|visit|navigate\s+to|take\s+me\s+to|show\s+me|launch|load|pull\s+up|bring\s+up|display)\b/i;

function _stepAgentKey(step) {
  return String(step?.args?.agentId || '').toLowerCase();
}

/**
 * lintAtomicBrowserPlan — deterministic floor for atomic browser plans.
 *
 * For every url.first.agent step, scan same-lane followers and:
 *   - mutation residue + no action-capable follower → splice dom.act at i+1
 *     (same agentId, same runGroup — the lane stays sequential on one session;
 *     insertion lands BEFORE any existing verify-mode follower).
 *   - no residue, no action-capable follower, task is display-nav and a URL is
 *     resolvable → downgrade to app.agent navigate_url (real-browser lane).
 *     Skipped when other same-agentId browser steps exist (real session
 *     opener) — conservative: a url.first kept where app.agent would do is
 *     harmless, the reverse can strand follow-on work.
 *
 * Returns { plan, rewrites, navOnlyLeftover } — navOnlyLeftover lists url.first
 * steps that STILL have no action-capable follower after the lint (residue-free
 * nav steps that couldn't be downgraded). Callers with a mutation-expected
 * classification should treat a non-empty list as an untrustworthy plan.
 */
function lintAtomicBrowserPlan(plan, logger, ctx = {}) {
  if (!Array.isArray(plan) || plan.length === 0) return { plan, rewrites: [], navOnlyLeftover: [] };
  const rewrites = [];
  const navOnlyLeftover = [];
  const steps = [...plan];
  const _hasResidue = (s) => hasMutationResidue(`${s?.args?.task || ''}\n${s?.description || ''}`);

  // ── Bound-session referent context (on-screen page is the default) ───────
  // When the prompt acts on the live page/service, a url.first for that same
  // host moves the user's real tab to a start URL and abandons the page they
  // mean (observed: "write a message to Sharmila" → linkedin.com/feed while
  // her thread was bound). Rewrite same-host navs to a bound-tab select and
  // stamp followers with the bound session.
  const _hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
  const _stripSess = (sid) => String(sid || '').replace(/^(?:(?:ext|open|bg):)+/i, '').replace(/\.agent$|_agent$/i, '').toLowerCase();
  let _serviceForUrl = null;
  try { _serviceForUrl = require('../../../shared/service-map.cjs').serviceForUrl; } catch (_) {}
  const _boundHost = _hostOf(ctx.boundUrl || ctx.onScreenRef?.url || ctx.priorScreenUrl || '');
  const _boundHosts = new Set(
    [_boundHost, ...(Array.isArray(ctx.extSessions) ? ctx.extSessions : []).map(s => _hostOf(s.url))]
      .filter(Boolean));
  const _boundSvc = _stripSess(ctx.boundSession || ctx.onScreenRef?.sessionId || '');
  const _recentBoundSess = (ctx.extSessions || []).slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
  const _boundSessionId = ctx.boundSession || ctx.onScreenRef?.sessionId || _recentBoundSess?.sessionId || null;
  const _boundForSvc = (svc) => (ctx.extSessions || []).find(x =>
    x.sessionId === `ext:${svc}_agent` || x.sessionId === `ext:open:${svc}_agent` ||
    (svc && (x.url || '').toLowerCase().includes(svc)))?.sessionId || null;
  const _svcOfHost = (host) => {
    if (!host) return '';
    try {
      const hit = _serviceForUrl && _serviceForUrl(`https://${host}`);
      const s = _stripSess(String(hit?.service || hit?.agentId || ''));
      if (s) return s;
    } catch (_) {}
    return '';
  };
  const _stepSvcOf = (s) => _stripSess(String(s?.args?.agentId || s?.args?.sessionId || ''));
  // Same-host: the url.first's service/url resolves to a bound/live page.
  const _isBoundHostStep = (s) => {
    const stepUrl = typeof s?.args?.url === 'string' ? s.args.url : '';
    const stepHost = _hostOf(stepUrl);
    if (stepHost) return _boundHosts.has(stepHost) || [..._boundHosts].some(h => h.endsWith('.' + stepHost) || stepHost.endsWith('.' + h));
    const stepSvc = _stepSvcOf(s);
    if (!stepSvc || stepSvc === 'browser' || stepSvc === 'default') return false;
    if (_boundSvc && stepSvc === _boundSvc) return true;
    return [..._boundHosts].some(h => _svcOfHost(h) === stepSvc || h.includes(stepSvc));
  };
  // Departure signal for the prompt — a url.first is legitimate when the user
  // asked to leave. Mirrors resolveReferencesV2's lexical veto (kept
  // conservative: any unqualified departure verb counts).
  let _LEAD_AWAY_VERB_RE = null;
  try { _LEAD_AWAY_VERB_RE = require('../../../shared/text-patterns.cjs').LEAD_AWAY_VERB_RE; } catch (_) {}
  const _promptLeadsAway = (() => {
    const p = String(ctx.prompt || '');
    if (ctx.taskClassification?.newDestination === true) return true;
    if (!p) return false;
    if (_LEAD_AWAY_VERB_RE && _LEAD_AWAY_VERB_RE.test(p)) return true;
    // 'open <svc-or-site>' is a departure even without the shared verb set.
    const m = p.match(/\bopen\s+(?:up\s+)?(?:my\s+|the\s+|a\s+)?([a-z0-9][\w.-]{0,30})/i);
    if (m && (/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|app|co)\b/i.test(m[1]) || /^(?:site|website|app|url)\b/i.test(m[1]) || _boundHosts.size && ![..._boundHosts].some(h => h.includes(m[1].toLowerCase())))) return true;
    return false;
  })();
  // Foreign-host detector — a nav step whose url leaves the bound/live host
  // family is legitimate only when the prompt names that destination.
  const _promptLc = String(ctx.prompt || '').toLowerCase();
  const _nameRe = (s) => new RegExp(`\\b${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const _promptNamesHost = (host, svc) => {
    if (!_promptLc) return false;
    const dom = String(host || '').replace(/^www\./, '').split('.')[0];
    return (dom.length >= 3 && _nameRe(dom).test(_promptLc)) || (svc && _nameRe(svc).test(_promptLc));
  };

  // "don't submit" — a step whose only work is submitting/sending must go.
  const _NO_SUBMIT_PROMPT = /\b(?:don'?t|do\s+not|never|without)\b[^.\n]{0,40}\b(?:submit|send|post)\b|\bno\s+(?:submit|send(?:ing)?|post(?:ing)?)\b/i;
  const _SUBMIT_ACTION_RE = /\b(?:submit|send|post|press\s+(?:the\s+)?(?:send|submit)|click\s+(?:the\s+)?(?:send|submit)|hit\s+(?:the\s+)?(?:send|submit))\b/i;
  const _NEG_IN_STEP_RE = /\b(?:don'?t|do\s+not|never|without|except|before|until|instead|draft)\b/i;

  // ── GUI-typing-on-page guard ─────────────────────────────────────────────
  // The planner sometimes emits app.agent GUI steps for page-field typing:
  // "Focus the address bar" (execute_shortcut Cmd+L) + "type_text" — which
  // types into the omnibox and navigates/searches instead of filling the page
  // field (observed: "type in the ask anything field" → text went to the
  // address bar). Page-element typing is dom.act's lane — it can resolve the
  // target element and verify the mutation; blind OS-level typing can't.
  // Detect app.agent steps on a browser app whose action is GUI-level
  // (shortcut/press/type) while the step or prompt names an in-page target,
  // and rewrite the cluster to one dom.act step carrying the same goal.
  const _BROWSER_APP_RE = /\b(?:chrome|safari|edge|arc|firefox|brave|orion|dia|comet|browser)\b/i;
  const _GUI_ACTION_RE  = /^(?:execute_shortcut|shortcut|press(?:_key)?|keypress|type_text|type|focus(?:_ai)?|click)$/i;
  const _ADDRESS_BAR_RE = /\baddress\s*bar\b|\bomnibox\b|\bcmd\s*\+\s*l\b/i;
  const _PAGE_TARGET_RE = /\b(?:into|in|on)\s+(?:the|this|a|an|my)\s+[\w .-]{0,24}?\b(?:field|box|input|text\s*area|placeholder|search\s*(?:bar|box|field)|comment|compose|editor|form|page)\b|\b(?:field|box|input|placeholder)\s+(?:on|in)\s+(?:the|this|a)\s+page\b|\bon\s+(?:this|the)\s+page\b/i;
  const _URL_ENTRY_RE   = /\b(?:url|website|site|link|navigate|open|go\s*to|visit|address\s*bar)\b/i;
  const _stepText = (s) => `${s?.args?.task || ''} ${s?.args?.goal || ''} ${s?.args?.text || ''} ${s?.description || ''}`;
  const _isGuiOnBrowser = (s) => s?.skill === 'app.agent'
    && (_BROWSER_APP_RE.test(String(s?.args?.appName || '')) || _BROWSER_APP_RE.test(String(ctx.boundSession || ctx.boundUrl || '')))
    && (_GUI_ACTION_RE.test(String(s?.args?.action || '')) || _ADDRESS_BAR_RE.test(_stepText(s)));
  // Page-typing intent comes from the step text OR the prompt — the planner's
  // step descriptions often say "the active field"/"the ask anything field".
  const _wantsPageType = _PAGE_TARGET_RE.test(_promptLc)
    || _PAGE_TARGET_RE.test(steps.map(_stepText).join(' '));
  const _isPageTypeStep = (s) => _isGuiOnBrowser(s)
    && (_PAGE_TARGET_RE.test(_stepText(s)) || _wantsPageType)
    && !_URL_ENTRY_RE.test(_stepText(s));
  const _isAddrFocusStep = (s) => _isGuiOnBrowser(s) && _ADDRESS_BAR_RE.test(_stepText(s));

  if (_isPageTypeStep || _isAddrFocusStep) {
    // any() probe first — only rewrite when a page-type step exists; a bare
    // address-bar step alone is legitimate URL entry.
    const _hasPageType = steps.some(_isPageTypeStep);
    if (_hasPageType) {
      let _domGoal = '';
      const _kept = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (_isPageTypeStep(s)) {
          _domGoal = (_stepText(s) || '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Type the requested text into the target field on the page';
          rewrites.push({ index: i, kind: 'gui-type→dom.act' });
          continue;
        }
        if (_isAddrFocusStep(s)) {
          rewrites.push({ index: i, kind: 'address-bar-focus→dropped' });
          continue;
        }
        _kept.push(s);
      }
      steps.length = 0;
      steps.push(..._kept);
      // Insert the dom.act step where the first rewritten step was.
      const _insAt = Math.min(...rewrites.filter(r => r.kind === 'gui-type→dom.act').map(r => r.index), steps.length);
      steps.splice(_insAt, 0, {
        skill: 'dom.act',
        args: { goal: _domGoal || String(ctx.prompt || '').slice(0, 300), ...(ctx.boundSession ? { sessionId: ctx.boundSession } : {}) },
        description: `Type into the page field (dom.act): ${_domGoal.slice(0, 80)}`,
      });
    }
  }

  // Extension connected → app.agent real-browser steps become session-bound
  // browser-lane steps: navigate_url opens through the extension (tab binds,
  // activates, and follow-ups can find it via /ext.sessions). app.agent's OS
  // open leaves an unbound tab the next prompt can't address.
  if (ctx.extConnected) {
    // Bound hosts + referent detector for the foreign-read rewrite below.
    const _boundHosts = (Array.isArray(ctx.extSessions) ? ctx.extSessions : [])
      .map(s => { try { return new URL(s.url || '').hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })
      .filter(Boolean);
    const _PAGE_ITEM_RE = /\b(this|that|the|these|those|first|second|third|\d+(?:st|nd|rd|th)|next|previous|current|open)\s+(item|items|result|results|listing|listings|product|products|page|tab|email|message|event|option|one|ones)\b|\bthis\s+item\b|\bthe\s+page\b|\bhere\b|\bit\b/i;
    const _recentBound = (Array.isArray(ctx.extSessions) ? ctx.extSessions : [])
      .slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];

    // Pure "go back to my X tab" prompts get LLM-rephrased into steps that no
    // longer contain the words "go back" (observed: "go back to my ebay tab" →
    // step "Confirm the current product page is displayed" → url.first
    // web-searched for an ebay URL → minted a blank tab). Detect the pure form
    // from the original prompt — no other action verbs — and rewrite the first
    // browser-lane step once.
    // Bare history nav ("go back", "go back for me on this page", "go back to
    // the previous page") is history.back() on the page the user is looking
    // at — NOT a tab select. Routing it through tab-select minted a fresh
    // Amazon tab when the named session had no live binding (resolveTab →
    // createBoundTab → service-home nav). Returns 'back'|'forward'|'reload'
    // or null when the prompt names a destination or isn't pure nav.
    const _HISTORY_DEST_RE = /^\s*(?:the\s+|a\s+|one\s+)?(?:previous|last|prior|same|this|that|current|original)?\s*(?:page|tab|site|one)?\s*$/i;
    const _promptHistoryNav = (() => {
      const p = String(ctx.prompt || '');
      const m = p.match(/\b(go\s+back|navigate\s+back|go\s+forward|reload|refresh)(?:\s+(?:for\s+me\s+)?(?:a|one)\s+page)?(?:\s+to\s+([^.\n]{0,60}))?/i);
      if (!m) return null;
      const dest = String(m[2] || '');
      if (dest && !_HISTORY_DEST_RE.test(dest)) return null;
      const stripped = p.replace(m[0], '');
      if (/\b(click|type|fill|search|read|get|find|create|send|open|select|buy|add|scroll|press|check|tell|watch|play)\b/i.test(stripped)) return null;
      if (/reload|refresh/i.test(m[1])) return 'reload';
      if (/forward/i.test(m[1])) return 'forward';
      return 'back';
    })();
    const _promptGoBack = (() => {
      if (_promptHistoryNav) return false; // bare history — not a named destination
      const p = String(ctx.prompt || '');
      if (!/\b(go\s+back|return|switch|focus|bring\s+me\s+back|take\s+me)\s+to\b.{0,40}\b(tab|page|site)\b/i.test(p)) return false;
      const stripped = p.replace(/\b(go\s+back|return|switch|focus|bring\s+me\s+back|take\s+me)\s+to\b.{0,40}\b(tab|page|site)\b/gi, '');
      return !/\b(click|type|fill|search|read|get|find|create|send|open|select|buy|add|scroll|press|check|tell)\b/i.test(stripped);
    })();
    let _goBackRewritten = false;

    // Pure history nav collapses to a single browser.act on the bound/active
    // tab. ext:default resolves the active tab; a live bound session resolves
    // its tab. The extension never mints a tab for these actions.
    if (_promptHistoryNav) {
      const action = _promptHistoryNav;
      const desc = action === 'back' ? 'Navigate back in history (current tab)'
        : action === 'forward' ? 'Navigate forward in history (current tab)'
        : 'Reload the current tab';
      return {
        plan: [{ skill: 'browser.act', args: { action, sessionId: _boundSessionId || 'ext:default', timeoutMs: 10000 }, description: desc }],
        rewrites: [{ index: 0, kind: `history-nav→browser.act:${action}` }],
        navOnlyLeftover: [],
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      // Referent reads must hit the bound tab, not a foreign research URL.
      // Observed: "shipping cost for this item" → read_url google.com —
      // the planner invented a Google fetch for a question whose answer
      // lived in the bound ebay tab.
      if (s?.skill === 'app.agent' && ['read_url', 'scan_page'].includes(s?.args?.action) && typeof s.args?.url === 'string' && s.args.url && _recentBound) {
        let _host = '';
        try { _host = new URL(s.args.url).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
        const _boundMatch = _boundHosts.some(h => h === _host || h.endsWith('.' + _host) || _host.endsWith('.' + h));
        const _isReferent = _PAGE_ITEM_RE.test(`${s.args?.task || ''}\n${s.description || ''}`);
        if (_host && !_boundMatch && _isReferent) {
          steps[i] = {
            ...s,
            skill: 'browser.act',
            args: { action: 'getPageText', sessionId: _recentBound.sessionId, timeoutMs: 15000 },
            description: (s.description || 'Read the bound tab') + ' (bound tab)',
          };
          rewrites.push({ index: i, kind: 'app.agent-read_url→bound-tab-read', agentId: s.args?.agentId || null });
          continue;
        }
      }
      // F13: app.agent navigate_url stays app.agent — the planner's lane choice
      // stands; the lint no longer swaps it into the url.first lane.
    }
  }

  // ── Pre-pass: no-submit drops, bound-host web vetoes, session stamps ─────
  // These run before the url.first residue scan so a dropped submit step is
  // correctly treated as "no action-capable follower".
  const _ATOMIC_ACTION_SKILLS = new Set(['dom.act', 'form.fill.agent', 'turn.loop.agent', 'tab.map.agent', 'just.type.agent', 'meta.find.agent', 'shortcut.keys.agent', 'gesture.agent', 'arrow.grid.agent', 'browser.act']);
  const _dropNoSubmit = _NO_SUBMIT_PROMPT.test(String(ctx.prompt || ''));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s) continue;
    // A planner-emitted step whose ONLY action is submit/send/post under a
    // "don't submit" prompt → drop it (mixed steps like "type X and send" are
    // kept — the skill-layer NO_SUBMIT_GUARD prevents the send at exec).
    if (_dropNoSubmit && _ATOMIC_ACTION_SKILLS.has(s.skill)) {
      const t = `${s.args?.task || ''} ${s.args?.goal || ''} ${s.description || ''}`;
      const verbs = (t.toLowerCase().match(/\b(?:click|press|hit|tap|submit|send|post|type|write|fill|enter|select|choose|scroll|read|search|open|navigate|check|get|add|upload|attach|drag|compose|reply|draft)\b/g) || []);
      const _pureSubmit = _SUBMIT_ACTION_RE.test(t) && !_NEG_IN_STEP_RE.test(t)
        && verbs.length > 0 && verbs.every(v => ['submit', 'send', 'post', 'click', 'press', 'hit', 'tap'].includes(v));
      if (_pureSubmit) {
        steps.splice(i, 1);
        rewrites.push({ index: i, kind: 'no-submit-prompt→drop-submit-step', agentId: _stepAgentKey(s) || null });
        i--;
        continue;
      }
    }
    // Public-web steps pointed at a bound/on-screen host → read the bound tab
    // instead (the answer lives on the user's real page, not a public fetch).
    if ((s.skill === 'web.agent' || s.skill === 'web.crawl') && _boundHosts.size) {
      const stepHost = _hostOf(s.args?.url || s.args?.target || '');
      const _boundHit = stepHost && (_boundHosts.has(stepHost) || [..._boundHosts].some(h => h.endsWith('.' + stepHost) || stepHost.endsWith('.' + h)));
      if (_boundHit && _boundSessionId) {
        steps[i] = {
          ...s,
          skill: 'browser.act',
          args: { action: 'getPageText', sessionId: _boundForSvc(_svcOfHost(stepHost)) || _boundSessionId, timeoutMs: 15000 },
          description: (s.description || 'Read the bound tab') + ' (bound tab — same host)',
        };
        rewrites.push({ index: i, kind: 'web-step→bound-tab-read', agentId: _stepAgentKey(s) || null });
        continue;
      }
    }
    // Stamp the bound session onto atomic-lane steps missing it when the step
    // serves the bound service (or carries no service) and nothing leads away.
    if (_boundSessionId && !_promptLeadsAway && _ATOMIC_ACTION_SKILLS.has(s.skill) && s.args && !s.args.sessionId) {
      const stepSvc = _stepSvcOf(s);
      if (!stepSvc || stepSvc === 'browser' || stepSvc === _boundSvc || _boundForSvc(stepSvc)) {
        steps[i] = { ...s, args: { ...s.args, sessionId: _boundForSvc(stepSvc) || _boundSessionId } };
        rewrites.push({ index: i, kind: 'bound-session-stamp', agentId: stepSvc || null });
      }
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const uf = steps[i];
    if (uf?.skill !== 'url.first.agent') continue;
    const agentKey = _stepAgentKey(uf);

    // Scan the lane: same/absent agentId browser steps until the next
    // url.first.agent, a synthesize, or a non-browser step.
    const followers = [];
    for (let j = i + 1; j < steps.length; j++) {
      const s = steps[j];
      if (!s || s.skill === 'url.first.agent' || s.skill === 'synthesize') break;
      if (!_BROWSER_LANE_SKILLS.has(s.skill)) break;
      const fk = _stepAgentKey(s);
      if (agentKey && fk && fk !== agentKey) break;
      followers.push(s);
    }
    // A follower whose goal restates the SAME navigate+search the url.first
    // step just performed is redundant — the nav already landed on the results
    // page. Demote it to a results read instead of letting a turn-loop burn
    // turns re-navigating a second tab (observed: url.first →
    // youtube.com/results?search_query=lo-fi beats, then a dom.act step
    // "Navigate to YouTube and search for lo-fi beats" re-navigated → 8 turns
    // on a stolen/blank tab → ~2min + reported failure).
    const task = String(uf.args?.task || '');
    if (/\bsearch\b|\bfind\b|\blook\s+for\b/i.test(task)) {
      for (const f of followers) {
        const _ft = `${f.args?.task || ''} ${f.args?.goal || ''} ${f.description || ''}`;
        if (/\b(navigate|go|head|open|visit|load)\b[^.\n]*\b(search|find|look)\b/i.test(_ft)) {
          const _fi = steps.indexOf(f);
          steps[_fi] = {
            ...f,
            skill: 'browser.act',
            args: { action: 'getPageText', sessionId: f.args?.sessionId || uf.args?.sessionId, agentId: f.args?.agentId || uf.args?.agentId, timeoutMs: 15000 },
            description: 'Read the search results on the page',
          };
          rewrites.push({ index: _fi, kind: 'dup-nav-search→results-read', agentId: _stepAgentKey(f) || agentKey || null });
        }
      }
    }

    if (followers.some(_isActionCapableBrowserStep)) continue;
    if (_hasResidue(uf)) {
      const actStep = {
        skill: 'dom.act',
        stepType: 'on-page-action',
        description: uf.description ? `${uf.description} — perform on-page work` : `Perform on-page work for ${agentKey || 'page'}`,
        args: { task, agentId: uf.args?.agentId, sessionId: uf.args?.sessionId },
      };
      if (uf.runGroup) actStep.runGroup = uf.runGroup;
      steps.splice(i + 1, 0, actStep);
      rewrites.push({ index: i, kind: 'url.first+residue→dom.act', agentId: agentKey || null });
      i++; // skip past the inserted step
      continue;
    }

    // No residue — display-only nav. F13: the planner's url.first lane stands
    // (no downgrade to app.agent's fire-and-forget OS open, which navigated
    // real Chrome outside any session — observed: amazon → prime upsell page).
    navOnlyLeftover.push({ index: i, agentId: agentKey || null, task: task.slice(0, 120) });
  }

  // Renumber sequential .step fields after splices so plan docs stay coherent.
  if (rewrites.length) {
    steps.forEach((s, idx) => { if (s && typeof s.step === 'number') s.step = idx + 1; });
    logger?.info?.(`[planHelpers:lintAtomicBrowserPlan] ${rewrites.length} fix(es): ${rewrites.map(r => `${r.kind}@${r.index}`).join(', ')}`);
  }
  if (navOnlyLeftover.length) {
    logger?.warn?.(`[planHelpers:lintAtomicBrowserPlan] ${navOnlyLeftover.length} nav-only url.first.agent step(s) left (no residue, no URL/owning lane): ${navOnlyLeftover.map(l => `#${l.index + 1}`).join(', ')}`);
  }
  // The plan is STILL nav-only end-to-end — every browser step is a lone
  // url.first and nothing performs on-page work. Callers whose task
  // classification expects mutation should treat this as untrustworthy.
  const navOnlyPlan = steps.some(s => s?.skill === 'url.first.agent')
    && !steps.some(_isActionCapableBrowserStep);
  return { plan: steps, rewrites, navOnlyLeftover, navOnlyPlan };
}

// Runtime counterpart of the lint: does ANY browser step's RESULT carry real
// mutation evidence (actions recorded, fields filled, refs clicked, verified
// flags, or an explicit already-satisfied/mutation-applied marker)? When the
// answer is yes, residue-carrying url.first steps flagged unprovenMutation are
// informational — a sibling action step did the on-page work. When no, the
// unproven flags are the plan's verdict: navigation alone proved nothing.
function hasBrowserMutationEvidence(results) {
  if (!Array.isArray(results)) return false;
  return results.some(r => {
    if (!r || r.ok !== true || !_BROWSER_LANE_SKILLS.has(r.skill)) return false;
    if (r.skill === 'url.first.agent') return false; // nav-only by contract
    if (r.skill === 'turn.loop.agent' && String(r.args?.mode || r.raw?.mode || 'act') === 'verify') return false;
    if (r.alreadySatisfied || r.mutationApplied || r.raw?.alreadySatisfied || r.raw?.mutationApplied) return true;
    if (r.verified === true || r.goalVerified === true || r.postconditionVerified === true) return true;
    if (Array.isArray(r.actionHistory) && r.actionHistory.length) return true;
    if (Array.isArray(r.filledFields) && r.filledFields.length) return true;
    if (Array.isArray(r.clickedRefs) && r.clickedRefs.length) return true;
    return false;
  });
}

// ── F23: deterministic legal-skill candidates per plan step ─────────────────
// The policy layer. Given the task facts + step text, returns the ORDERED list
// of skills legal for that step. The filter only narrows the option space —
// it never picks for an ambiguous step: [] means "no policy opinion, keep the
// planner's pick". planSkillsV2 repairs a pick that lands OUTSIDE the set
// (single candidate → forced; N candidates → plan.skillPick typed decision).
//
// Buckets, first match wins:
//   nav step            → [url.first.agent]              (single → forced)
//   sessionish + action → [dom.act, turn.loop, meta.find, form.fill, just.type, tab.map, browser.act]
//   sessionish + read   → [browser.act, turn.loop, dom.act, meta.find]
//   sessionish + other  → broad browser lane (web.* still excluded)
//   public web, no session → [web.agent, web.crawl]
// Anything else (synthesize, edit.agent, fs.*, shell.run, cli.agent…) → [].

const _GOVERNED_STEP_SKILLS = new Set([
  ..._BROWSER_LANE_SKILLS, 'form.fill.agent', 'web.agent', 'web.crawl', 'app.agent',
]);

// "go to / open / navigate to <dest>" — but "open the first result" is an
// on-page ACTION, not navigation; the item-noun guard separates them.
const _STEP_NAV_VERB_RE = /\b(?:go\s+to|navigate\s+to|open|visit|take\s+(?:me\s+)?to|head\s+to|load|pull\s+up|bring\s+up|launch)\b/i;
const _STEP_ITEM_RE = /\b(?:first|second|third|fourth|fifth|last|top|latest|newest|oldest|next|previous|that|this|the)\b[^.]{0,60}?\b(?:result|item|message|email|thread|post|link|product|listing|option|card|article|video|row|one|story|hit|match|comment|notification|tab|window|dialog|form|menu|panel|compose|sidebar|modal|box|field)\b/i;
const _STEP_ACTION_RE = /\b(?:click|press|tap|type|fill|enter|input|submit|select|choose|check|uncheck|scroll|drag|drop|add\s+to|remove|buy|purchase|order|checkout|send|reply|forward|post|publish|compose|write|comment|delete|archive|star|mute|unmute|join|leave|accept|decline|follow|unfollow|like|save|bookmark|dismiss|expand|collapse|hover|toggle|enable|disable|apply|upload|attach|invite|schedule|book|rsvp|sign\s*in|log\s*in|log\s*out|refresh|reload|go\s+back|close|play|pause|first|second|third|\d+(?:st|nd|rd|th))\b/i;
const _STEP_READ_RE = /\b(?:read|tell\s+me|what\s+(?:does|is|are|says|happened)|list|show\s+me|summari[sz]e|extract|get\s+(?:the\s+)?(?:text|content|info|data|page)|how\s+many|count|price|cost|title|headline|confirm|verify|check\s+(?:if|whether|that)|copy)\b/i;

const _BOUND_ACTION_PICKS = ['dom.act', 'turn.loop.agent', 'meta.find.agent', 'form.fill.agent', 'just.type.agent', 'tab.map.agent', 'browser.act'];
const _BOUND_READ_PICKS = ['browser.act', 'turn.loop.agent', 'dom.act', 'meta.find.agent'];
const _PUBLIC_WEB_PICKS = ['web.agent', 'web.crawl'];
const _NAV_PICKS = ['url.first.agent'];

// Surface nouns — a dialog/modal/menu is an on-page element, never a
// destination. "Open create event dialog using shortcut" matched "open" +
// newDestination and got force-routed to url.first.agent as "single legal
// candidate" — the item-noun regex missed it because "create event dialog"
// has no determiner before "dialog". Surface nouns block the nav bucket
// deterministically.
const _STEP_SURFACE_RE = /\b(?:dialog|modal|popup|popover|popin|compose|menu|panel|drawer|sheet|shortcut(?:\s*key)?|keystroke|text\s*field|input\s*field|checkbox|button|icon|link|tab)\b/i;

// Surfaces that ARE URLs on their service — "open the create-event dialog"
// is a navigation to /r/eventedit, not a keyboard shortcut. Exiling these
// to action picks produced the 'c'-press circle: shortcut fires on the
// month view, dialog never confirms, eyes fail, replan emits the same step.
const _DEEP_LINKABLE_SURFACES = [
  [/\b(google|calendar)\b/i, /\b(event|meeting|appointment|calendar|schedule)\b/i],
  [/\b(gmail|outlook|mail)\b/i, /\b(compose|e-?mail|draft|inbox|message)\b/i],
  [/\bnotion\b/i, /\b(page|doc|note)\b/i],
  [/\b(docs?|sheets?|slides?)\b/i, /\b(doc|document|sheet|spreadsheet|slide|presentation)\b/i],
  [/\b(calendly|eventbrite|zoom|meet|teams)\b/i, /\b(event|meeting|invite|schedule)\b/i],
];
function _deepLinkableSurface(desc, targetService) {
  if (!targetService) return false;
  for (const [svcRe, surfRe] of _DEEP_LINKABLE_SURFACES) {
    if (svcRe.test(String(targetService)) && surfRe.test(desc)) return true;
  }
  return false;
}

function stepCandidates(step, ctx = {}) {
  const skill = step?.skill;
  if (!skill || !_GOVERNED_STEP_SKILLS.has(skill)) return [];
  const tc = ctx.tc || {};
  const desc = String(step.description || step.args?.task || step.args?.goal || step.args?.query || '');

  // A service/URL token makes "open X" a navigation; an item-noun makes it
  // an on-page action ("open the first result" → click, not nav).
  const mentionsDest = (ctx.targetService && new RegExp(`\\b${ctx.targetService.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(desc))
    || /https?:\/\//i.test(desc) || /\b\w+\.(?:com|org|net|io|dev|ai|co|app)\b/i.test(desc)
    // Task-level departure: when classifyTask flagged newDestination, a
    // nav-verb step IS the nav even if the service token is absent from the
    // step text ("Open ChatGPT in the browser" with targetService unset).
    || tc.newDestination === true;
  const _surfaceBlocked = _STEP_SURFACE_RE.test(desc) && !_deepLinkableSurface(desc, ctx.targetService);
  if (_STEP_NAV_VERB_RE.test(desc) && mentionsDest && !_STEP_ITEM_RE.test(desc) && !_surfaceBlocked) {
    return _NAV_PICKS;
  }

  // Sessionish = the step plausibly acts on a live/automation page: a session
  // was promoted for this task, an earlier step in this plan navigated, or the
  // task itself needs DOM interaction. web.* is never legal for those steps.
  const sessionish = !!ctx.boundSessionId || !!ctx.planHasNav
    || tc.webAccessMode === 'interactive' || tc.requiresDOM === true
    || (Array.isArray(tc.interactiveActions) && tc.interactiveActions.length > 0);
  if (sessionish) {
    // Email-compose/send goals are never legal for form.fill.agent — its
    // contract resolves profile fields and never submits; a compose+send is
    // an app workflow (dom.act's email-compose path or tab.map).
    const _isEmailWork = /\b(?:e-?mail|compose|inbox)\b/i.test(desc)
      && /\b(?:send|reply|forward|compose|draft|write|fill)\b/i.test(desc);
    // Form-fill lane: a fill-shaped step on a form surface is a deterministic
    // fill+verify job — form.fill first, not the LLM loop. submit:true when
    // the step also carries the save verb so the guard path engages.
    const _isFormWork = /\b(fill|enter|type|set)\b[^.]{0,40}\b(form|field|title|date|time|detail|name|description|event|event details)\b/i.test(desc)
      || /\bfill in\b/i.test(desc);
    const _actionPicks = _isEmailWork
      ? _BOUND_ACTION_PICKS.filter(s => s !== 'form.fill.agent')
      : _isFormWork
        ? ['form.fill.agent', ..._BOUND_ACTION_PICKS.filter(s => s !== 'form.fill.agent')]
        : _BOUND_ACTION_PICKS;
    if (_STEP_ACTION_RE.test(desc)) return _actionPicks;
    if (_STEP_READ_RE.test(desc)) return _BOUND_READ_PICKS;
    return [..._actionPicks.slice(0, 4), 'browser.act'];
  }

  if (ctx.publicWeb) return _PUBLIC_WEB_PICKS;
  return [];
}

module.exports = { serializeSkillPlanToMd, buildStepDescription, parsePlan, lintFileEditPlan: _lintFileEditPlan, getProtectedPaths, getAttachedFilePaths, FILE_EDIT_INTENT_RE, CONFIRM_ONLY_RE: _CONFIRM_ONLY_RE, lintAtomicBrowserPlan, hasMutationResidue, hasBrowserMutationEvidence, _isActionCapableBrowserStep, ATOMIC_BROWSER_SKILLS: _BROWSER_LANE_SKILLS, stepCandidates };

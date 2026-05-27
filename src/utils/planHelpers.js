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
  if (skill === 'guide.step') return `guide.step — ${(args.instruction || '').slice(0, 40)}`;
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
      return parsed.steps;
    }
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0]?.skill === 'string') {
          if (logger) logger.debug('[planHelpers:parsePlan] deep-scan unwrapped arbitrary object key → step array');
          return val;
        }
      }
      if (logger) logger.warn('[planHelpers:parsePlan] object has no step-array under any key — returning null');
      return null;
    }
    return parsed;
  } catch (e) {
    if (logger) logger.warn('[planHelpers:parsePlan] JSON parse failed:', e.message);
    return null;
  }
}

module.exports = { serializeSkillPlanToMd, buildStepDescription, parsePlan };

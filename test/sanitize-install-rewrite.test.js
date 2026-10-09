'use strict';

/**
 * sanitize-install-rewrite.test.js
 *
 * Regression test for _sanitizeSkillPlan's shell.run → cli.agent build_agent
 * rewrite. The rule exists so blind `shell.run` install steps get rerouted to
 * cli.agent's observe→adapt loop, but the verb match was too broad:
 *
 *   "…pipe output to get first 50KB of content"  →  build_agent service="first"
 *   "get a new API key"                          →  build_agent service="new"
 *   "download the pdf"                           →  build_agent service="pdf"
 *
 * A rewrite destroys the step's real work AND sends cli.agent hunting a
 * nonexistent tool ("No CLI found for 'first'"). The fix: install-shaped
 * verbs only (install / set up / setup / download), matched near the start
 * of the step text, and the captured word must not be a filler word
 * (ordinals, quantifiers, generic nouns, file extensions) or start with a
 * digit.
 *
 * USAGE: node test/sanitize-install-rewrite.test.js
 */

const { _sanitizeSkillPlan } = require('../src/nodes/planSkillsV2');

let total = 0, passed = 0, failed = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — ${detail}`); }
}

const quietState = { logger: { info() {}, warn() {}, error() {}, debug() {} } };

function sanitizeOne(step) {
  const plan = [step];
  const out = _sanitizeSkillPlan(plan, quietState);
  return out[out.length - 1]; // guard may insert steps before it; our step is last unless replaced in place
}

// ── The exact observed poison: replanned PDF step ────────────────────────────
{
  const s = sanitizeOne({
    skill: 'shell.run',
    args: { goal: 'Extract text from PDF using pdftotext CLI tool to handle the file that failed with direct read, then pipe output to get first 50KB of content' },
    description: 'Extract text from PDF using pdftotext CLI tool to handle the file that failed with direct read, then pipe output to get first 50KB of content',
  });
  check(
    '"…get first 50KB…" stays shell.run (no phantom service "first")',
    s.skill === 'shell.run' && s.args?.goal && !s.args?.service,
    JSON.stringify({ skill: s.skill, service: s.args?.service })
  );
}

// ── Preserved behavior: real install intents still rewrite ───────────────────
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Install pdftotext' }, description: 'Install pdftotext' });
  check(
    '"Install pdftotext" → cli.agent build_agent service=pdftotext',
    s.skill === 'cli.agent' && s.args?.action === 'build_agent' && s.args?.service === 'pdftotext',
    JSON.stringify({ skill: s.skill, args: s.args })
  );
}
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Set up yt-dlp for video downloads' }, description: 'Set up yt-dlp' });
  check(
    '"Set up yt-dlp" → build_agent yt-dlp',
    s.skill === 'cli.agent' && s.args?.action === 'build_agent' && s.args?.service === 'ytdlp',
    JSON.stringify({ skill: s.skill, args: s.args })
  );
}

// ── Verb narrowing: fetch/edit verbs must not trigger the rewrite ────────────
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Get a new API key for the service' } });
  check('"Get a new API key" → unchanged', s.skill === 'shell.run' && !s.args?.service, JSON.stringify(s.args));
}
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Add a column to the spreadsheet' } });
  check('"Add a column" → unchanged', s.skill === 'shell.run' && !s.args?.service, JSON.stringify(s.args));
}

// ── Filler coverage ───────────────────────────────────────────────────────────
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Download the pdf then summarize it' } });
  check('"Download the pdf" → unchanged (pdf is a document, not a service)', s.skill === 'shell.run', JSON.stringify(s.args));
}
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Download the first release from the repo page' } });
  check('"Download the first release" → unchanged (first is an ordinal)', s.skill === 'shell.run', JSON.stringify(s.args));
}
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Download the latest ffmpeg static build' } });
  // "latest" is filler — but the NEXT word would only be captured if the
  // regex skipped it; regex captures the word right after the article, so
  // this captures "latest" → filler → unchanged.
  check('"Download the latest …" → unchanged (latest is filler)', s.skill === 'shell.run', JSON.stringify(s.args));
}

// ── Position gate: a verb buried mid-pipeline must not hijack the step ───────
{
  const s = sanitizeOne({
    skill: 'shell.run',
    args: { goal: 'Extract the archive contents into ./out, then install jq if it is missing' },
  });
  check(
    '"…then install jq…" (mid-pipeline) → unchanged',
    s.skill === 'shell.run',
    JSON.stringify({ skill: s.skill, args: s.args })
  );
}

// ── Digit guard ───────────────────────────────────────────────────────────────
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Install 3rd-party drivers' } });
  check('"Install 3rd-party drivers" → unchanged (digit-leading token)', s.skill === 'shell.run', JSON.stringify(s.args));
}

// ── Auth path preserved: connect/configure without install verb → generic run
{
  const s = sanitizeOne({ skill: 'shell.run', args: { goal: 'Authenticate the github CLI with a token' } });
  check(
    '"Authenticate …" → cli.agent run (not build_agent)',
    s.skill === 'cli.agent' && s.args?.action === 'run' && !s.args?.service,
    JSON.stringify({ skill: s.skill, args: s.args })
  );
}

// ── Explicit-argv installs still rewrite with the REAL package name ──────────
{
  const s = sanitizeOne({
    skill: 'shell.run',
    args: { cmd: 'npm', argv: ['install', '-g', 'zzz-unproven-pkg-9x'] },
  });
  check(
    'argv "npm install -g zzz-unproven-pkg-9x" → build_agent service=zzzunprovenpkg9x',
    s.skill === 'cli.agent' && s.args?.action === 'build_agent' && s.args?.service === 'zzzunprovenpkg9x',
    JSON.stringify({ skill: s.skill, args: s.args })
  );
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${passed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);

'use strict';

// Regression: "update this file" with an attached file produced a
// doc.read → shell.run → synthesize plan that left the file untouched —
// partly because the filename (kids-weekly-memory-verse.rtf) false-positive
// matched the system-info keyword regex and steered the planner. The lint now
// deterministically appends an edit.agent step when a prompt attaches a
// regular file AND carries edit intent but the plan lacks edit.agent.

const { lintFileEditPlan, getAttachedFilePaths, FILE_EDIT_INTENT_RE } = require('../src/utils/planHelpers');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {} };

// A real existing file — getAttachedFilePaths skips nonexistent paths.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-edit-backstop-'));
const attachFile = path.join(dir, 'kids-weekly-memory-verse.rtf');
fs.writeFileSync(attachFile, '{\\rtf1 kids verses}\n');
const resolved = fs.realpathSync(attachFile);

console.log('\n--- getAttachedFilePaths ---');
let a = getAttachedFilePaths(`[File: ${attachFile}]\n\nupdate this file`);
check('extracts attached regular file', a.length === 1 && a[0].resolved === resolved);

a = getAttachedFilePaths(`[Folder: ${dir}]\n\nlist these`);
check('folder tags are NOT edit targets', a.length === 0);

a = getAttachedFilePaths(`[File: ${dir}/missing.txt]`);
check('nonexistent path skipped', a.length === 0);

a = getAttachedFilePaths('update the file');
check('no tag → empty', Array.isArray(a) && a.length === 0);

console.log('\n--- FILE_EDIT_INTENT_RE ---');
check('"update" matches', FILE_EDIT_INTENT_RE.test('update this file'));
check('"change" matches', FILE_EDIT_INTENT_RE.test('change the verses'));
check('"remove" matches', FILE_EDIT_INTENT_RE.test('remove the last section'));
check('"summarize" does not match', !FILE_EDIT_INTENT_RE.test('summarize this file'));
check('"read" does not match', !FILE_EDIT_INTENT_RE.test('read this file for me'));

console.log('\n--- append-edit.agent backstop ---');

// The observed failure: file attached + "update" + plan with no edit step.
const readPlan = [
  { skill: 'doc.read', args: { path: attachFile }, description: 'Read the file' },
  { skill: 'shell.run', args: { cmd: 'ls', argv: ['-1', `${dir}/worship-songs`] }, description: 'List songs' },
  { skill: 'synthesize', args: { prompt: 'Choose verses from Exodus 3 for each kid and pick songs' }, description: 'Pick content' },
];
const prompt = `[File: ${attachFile}]\n\nupdate this file for my kids from exodus 2 to exodus 3`;
let { plan: linted, rewrites } = lintFileEditPlan(readPlan.map(s => ({ ...s })), logger, { prompt });
check('edit.agent appended to read-only plan',
  linted.length === 4 && linted[3].skill === 'edit.agent',
  JSON.stringify(linted.map(s => s.skill)));
check('appended step targets the attached file', linted[3].args.filePath === resolved);
check('appended step is draft mode', linted[3].args.mode === 'draft');
check('goal carries {{PREV_OUTPUT}} so gather output flows in',
  /\{\{PREV_OUTPUT\}\}/.test(linted[3].args.goal), linted[3].args.goal);
check('goal carries the user wording',
  /exodus 3/i.test(linted[3].args.goal));
check('rewrite recorded', rewrites.some(r => r.kind === 'append-edit.agent'));
check('gather steps preserved before the edit',
  linted[0].skill === 'doc.read' && linted[1].skill === 'shell.run' && linted[2].skill === 'synthesize');

// ctx.filePath (resolved-file note) wins over tag order.
({ plan: linted } = lintFileEditPlan([{ skill: 'doc.read', args: {}, description: 'r' }], logger,
  { prompt, filePath: '/resolved/other.docx' }));
check('ctx.filePath preferred as edit target', linted[1].args.filePath === '/resolved/other.docx');

// Already contains edit.agent → untouched.
const goodPlan = [
  { skill: 'doc.read', args: { path: attachFile }, description: 'Read' },
  { skill: 'edit.agent', args: { goal: 'update', filePath: resolved, mode: 'draft' }, description: 'Edit' },
];
({ plan: linted, rewrites } = lintFileEditPlan(goodPlan.map(s => ({ ...s })), logger, { prompt }));
check('plan with edit.agent untouched',
  linted.length === 2 && !rewrites.some(r => r.kind === 'append-edit.agent'));

// No edit verb → no append (read/summarize requests stay read-only).
({ plan: linted } = lintFileEditPlan(
  [{ skill: 'doc.read', args: { path: attachFile }, description: 'Read' }],
  logger, { prompt: `[File: ${attachFile}]\n\nsummarize this for me` }));
check('summarize-only plan NOT appended', linted.length === 1 && linted[0].skill === 'doc.read');

// "delete the file" is a filesystem op, not an edit — no edit.agent.
({ plan: linted } = lintFileEditPlan(
  [{ skill: 'shell.run', args: { cmd: 'ls' }, description: 'list' }],
  logger, { prompt: `[File: ${attachFile}]\n\nupdate — actually just delete this file` }));
check('delete-the-file intent NOT appended', !linted.some(s => s.skill === 'edit.agent'));

// Empty plan + edit intent → still appended (no PREV_OUTPUT — nothing precedes it).
({ plan: linted } = lintFileEditPlan([], logger, { prompt }));
check('empty plan → lone edit.agent, no PREV_OUTPUT',
  linted.length === 1 && linted[0].skill === 'edit.agent' && !/\{\{PREV_OUTPUT\}\}/.test(linted[0].args.goal));

// Edit verb inside the attachment tag only (filename contains "update") must
// NOT trigger the append — the verb scan runs on the de-tagged prompt.
const updateNamed = path.join(dir, 'update-log.txt');
fs.writeFileSync(updateNamed, 'x\n');
({ plan: linted } = lintFileEditPlan(
  [{ skill: 'doc.read', args: { path: updateNamed }, description: 'Read' }],
  logger, { prompt: `[File: ${updateNamed}]\n\nwhat does this file say?` }));
check('verb inside filename only → NOT appended',
  linted.length === 1 && linted[0].skill === 'doc.read', JSON.stringify(linted.map(s => s.skill)));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

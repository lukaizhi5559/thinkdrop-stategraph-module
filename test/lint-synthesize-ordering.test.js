'use strict';

// Regression: lintFileEditPlan drops a trailing confirm-synthesize, but
// _ensureSynthesizeStep used to re-push one because edit.agent wasn't in
// _SYNTHESIZE_EXEMPT_SKILLS — the saved plan kept the confabulating step and the
// run ended with a chat summary instead of the draft/apply UX.

const { lintFileEditPlan, getProtectedPaths } = require('../src/utils/planHelpers');
const { _ensureSynthesizeStep } = require('../src/nodes/planSkillsV2');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {} };

// Real existing file so the lint's saveToFile→edit.agent rewrite engages.
const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-order-')), 'notes.md');
fs.writeFileSync(target, 'Meeting notes — dealine Wenesday\n');

// Original LLM plan: read → synthesize.saveToFile (rewrites an existing file —
// lint converts to edit.agent) → confirm synthesize (lint drops).
const plan = [
  { skill: 'fs.read', args: { action: 'read', path: target }, description: 'Read the file' },
  { skill: 'synthesize', args: { prompt: 'Fix the typos', saveToFile: target }, description: 'Fix spelling mistakes and save' },
  { skill: 'synthesize', args: { prompt: 'Confirm the file was saved correctly' }, description: 'Confirm the result to the user' },
];

const { plan: linted, rewrites } = lintFileEditPlan(plan, logger);
check('lint rewrote saveToFile→edit.agent', linted[1]?.skill === 'edit.agent' && linted[1]?.args?.filePath === target);
check('lint dropped confirm step', linted.length === 2 && rewrites.some(r => r.kind === 'drop-confirm-step'));

// The post-lint pipeline step that used to resurrect the confirm step.
const final = _ensureSynthesizeStep(linted, 'fix the spelling/grammar mistake in this file');
check('ensure does NOT re-add synthesize after edit.agent', final.length === 2 && final.every(s => s.skill !== 'synthesize'),
  JSON.stringify(final.map(s => s.skill)));

// Sanity: a plan ending on a non-exempt skill still gets a synthesize.
const other = _ensureSynthesizeStep([{ skill: 'shell.run', args: { cmd: 'ls' }, description: 'list' }], 'list the files');
check('ensure still adds synthesize for non-exempt endings', other.length === 2 && other[1].skill === 'synthesize');

// Flavor selection — read/question prompts get the "answer" prompt, mutations
// get "confirm/summarize", and the step is idempotent + exempt-aware.
const _readPlan = _ensureSynthesizeStep([{ skill: 'fs.read', args: { action: 'read', path: '/tmp/x' } }], "[File: /tmp/x]\n\nwhat's this about");
check('file question gets answer-flavor synthesize', _readPlan.length === 2 && /Answer the user's original question/.test(_readPlan[1].args.prompt), _readPlan[1]?.args?.prompt);

const _delPlan = _ensureSynthesizeStep([{ skill: 'shell.run', args: { cmd: 'bash', argv: ['-c', 'mv x ~/.Trash/'] } }], 'delete this file /tmp/x');
check('delete gets summarize-flavor synthesize', _delPlan.length === 2 && /Summarize what was done/.test(_delPlan[1].args.prompt), _delPlan[1]?.args?.prompt);

const _screenPlan = _ensureSynthesizeStep([{ skill: 'screen.capture', args: {} }], "what's on my screen");
check('screen read gets answer-flavor synthesize', _screenPlan.length === 2 && /Answer the user's original question/.test(_screenPlan[1].args.prompt));

const _dupPlan = _ensureSynthesizeStep([{ skill: 'shell.run', args: { cmd: 'ls' } }, { skill: 'synthesize', args: { prompt: 'x' } }], 'do a thing');
check('existing synthesize is not duplicated', _dupPlan.length === 2 && _dupPlan.filter(s => s.skill === 'synthesize').length === 1);

const _schedPlan = _ensureSynthesizeStep([{ skill: 'schedule', args: { time: '18:00', label: 'x' } }], 'remind me at 6pm');
check('schedule ending stays exempt', _schedPlan.length === 1);

// getProtectedPaths — attachment-tag extraction for the shell.run sandbox.
const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-prot-'));
const attachFile = path.join(attachDir, 'proofreading_test.txt');
fs.writeFileSync(attachFile, 'This sentense has misstakes.\n');

let prot = getProtectedPaths(`[File: ${attachFile}]\n\nfix the spelling in this file`);
check('extracts attached file', prot.length === 1 && prot[0].original === attachFile && prot[0].resolved === fs.realpathSync(attachFile));

prot = getProtectedPaths(`[Folder: ${attachDir}]`);
check('extracts attached folder', prot.length === 1 && prot[0].original === attachDir);

prot = getProtectedPaths(`[File: ${attachFile}] [File: ${attachFile}]`);
check('dedupes repeated tags', prot.length === 1);

prot = getProtectedPaths(`[File: ${attachDir}/does_not_exist.txt]`);
check('skips nonexistent paths', prot.length === 0);

prot = getProtectedPaths('fix typos in the file — no tag');
check('no tags → empty', prot.length === 0);

prot = getProtectedPaths(null);
check('null message → empty', Array.isArray(prot) && prot.length === 0);

// SANDBOX_REROUTE — a sandboxed shell.run step denied a write to the attached
// file → thin recovery substitutes edit.agent deterministically (auto_patch).
(async () => {
  const { _thinPostFailureHandler } = require('../src/nodes/executeCommand');
  const deniedStep = {
    step: 1, skill: 'shell.run',
    description: 'Fix spelling and grammar mistakes in the test file',
    args: { cmd: 'python3', argv: ['-c', 'open(path,"w")...'] },
    ok: false, error: 'Process exited with code 1',
    stderr: `PermissionError: [Errno 1] Operation not permitted: '${attachFile}'`,
    _sandboxDenied: true, _sandboxDeniedPath: attachFile,
  };
  const failState = {
    failedStep: deniedStep,
    skillPlan: [{ skill: 'shell.run', args: deniedStep.args, description: deniedStep.description }],
    skillCursor: 0, skillResults: [], patchHistory: [], stepRetryCount: 0,
    logger, llmBackend: null,
  };
  const routed = await _thinPostFailureHandler(failState);
  check('sandbox denial → edit.agent substituted',
    routed.recoveryAction === 'auto_patch'
    && routed.skillPlan[0].skill === 'edit.agent'
    && routed.skillPlan[0].args.filePath === attachFile
    && /fix spelling/i.test(routed.skillPlan[0].args.goal),
    JSON.stringify({ action: routed.recoveryAction, plan: routed.skillPlan?.[0] }));
  check('reroute recorded in patchHistory', routed.patchHistory?.some(p => p.action === 'SANDBOX_REROUTE'));

  // Second denial at the same cursor → falls through (no loop).
  const secondState = { ...failState, patchHistory: [{ action: 'SANDBOX_REROUTE', note: 'x', attempt: 1 }] };
  const second = await _thinPostFailureHandler(secondState);
  check('repeat denial does NOT re-substitute', !(second.skillPlan?.[0]?.skill === 'edit.agent' && second.recoveryAction === 'auto_patch'));

  // Denial with no resolvable path → falls through to normal recovery.
  const ambState = { ...failState, failedStep: { ...deniedStep, _sandboxDeniedPath: null } };
  const amb = await _thinPostFailureHandler(ambState);
  check('ambiguous denial falls through', !(amb.recoveryAction === 'auto_patch' && amb.skillPlan?.[0]?.skill === 'edit.agent'));

  // ── Keystroke-edit guard — the Cmd+C/Cmd+V macro plan that polluted the
  //    user's live TextEdit buffer must collapse to a single edit.agent. ────
  const prompt = `[File: ${attachFile}]\n\nUpdate Section 1 and make it better`;
  const macroPlan = [
    { skill: 'app.agent', args: { action: 'execute_shortcut', appName: 'TextEdit', shortcutOverride: 'Cmd+F', searchText: 'Section 1' }, description: 'Find section' },
    { skill: 'app.agent', args: { action: 'execute_shortcut', appName: 'TextEdit', shortcutOverride: 'Cmd+C' }, description: 'Copy text' },
    { skill: 'app.agent', args: { action: 'execute_shortcut', appName: 'TextEdit', shortcutOverride: 'Cmd+V' }, description: 'Paste to duplicate' },
    { skill: 'synthesize', args: { prompt: 'Confirmed: Section 1 content has been duplicated in the file.' }, description: 'Confirm duplication' },
  ];
  const { plan: collapsed, rewrites: rw1 } = lintFileEditPlan(macroPlan, logger, { prompt });
  check('keystroke-macro plan collapses to edit.agent',
    collapsed.length === 1 && collapsed[0].skill === 'edit.agent'
    && collapsed[0].args.filePath === fs.realpathSync(attachFile)
    && collapsed[0].args.mode === 'draft'
    && /update section 1/i.test(collapsed[0].args.goal),
    JSON.stringify(collapsed));
  check('collapse rewrite recorded', rw1.some(r => r.kind === 'app.agent-keystroke-edit→edit.agent'));

  // Benign app.agent navigation (no mutation) → the step is kept; the
  // file-edit backstop still appends edit.agent because the prompt asks to
  // "Update" an attached file and no edit step exists.
  const navPlan = [{ skill: 'app.agent', args: { action: 'execute_shortcut', appName: 'TextEdit', shortcutOverride: 'Cmd+F', searchText: 'x' } }];
  const { plan: nav } = lintFileEditPlan(navPlan, logger, { prompt });
  check('non-mutating app.agent steps pass through', nav.length === 2 && nav[0].skill === 'app.agent' && nav[1].skill === 'edit.agent', JSON.stringify(nav.map(s => s.skill)));

  // Mixed plan (non-file step present) → flagged steps dropped, others kept.
  const mixedPlan = [
    { skill: 'shell.run', args: { cmd: 'ls' }, description: 'list' },
    { skill: 'app.agent', args: { action: 'execute_shortcut', appName: 'TextEdit', shortcutOverride: 'Cmd+V' } },
  ];
  const { plan: mixed, rewrites: rw2 } = lintFileEditPlan(mixedPlan, logger, { prompt });
  check('mixed plan drops flagged app.agent step', mixed.length === 2 && mixed[0].skill === 'shell.run' && mixed[1].skill === 'edit.agent'
    && rw2.some(r => r.kind === 'drop-app.agent-keystroke-edit')
    && rw2.some(r => r.kind === 'append-edit.agent'), JSON.stringify(mixed));

  // type_text is a mutation too.
  const typePlan = [
    { skill: 'app.agent', args: { action: 'type_text', appName: 'TextEdit', text: 'replacement content' } },
    { skill: 'synthesize', args: { prompt: 'Confirm the file was updated' } },
  ];
  const { plan: typed } = lintFileEditPlan(typePlan, logger, { prompt });
  check('type_text plan collapses to edit.agent', typed.length === 1 && typed[0].skill === 'edit.agent', JSON.stringify(typed));

  // Past-tense self-confirmation synthesize is dropped by the confirm regex.
  const confirmPlan = [
    { skill: 'shell.run', args: { cmd: 'ls' } },
    { skill: 'synthesize', args: { prompt: 'Confirmed: the file was duplicated correctly.' } },
  ];
  const { plan: conf } = lintFileEditPlan(confirmPlan, logger);
  check('past-tense confirm synthesize dropped', conf.length === 1 && conf[0].skill === 'shell.run', JSON.stringify(conf));

  // Draft-first default — edit.agent without mode gets mode:'draft'.
  const editNoMode = [{ skill: 'edit.agent', args: { goal: 'fix typos', filePath: attachFile } }];
  const { plan: drafted, rewrites: rw3 } = lintFileEditPlan(editNoMode, logger, { prompt });
  check('edit.agent without mode → mode:draft injected', drafted[0].args.mode === 'draft'
    && rw3.some(r => r.kind === 'edit.agent→draft-mode'));

  // Explicit inplace is respected.
  const editInplace = [{ skill: 'edit.agent', args: { goal: 'x', filePath: attachFile, mode: 'inplace' } }];
  const { plan: inp } = lintFileEditPlan(editInplace, logger, { prompt });
  check('explicit mode:inplace untouched', inp[0].args.mode === 'inplace');

  // synthesize→edit.agent conversion also gets draft mode.
  const synPlan = [{ skill: 'synthesize', args: { prompt: 'Fix typos', saveToFile: target } }];
  const { plan: synConverted } = lintFileEditPlan(synPlan, logger);
  check('converted synthesize→edit.agent gets draft mode', synConverted[0]?.args?.mode === 'draft', JSON.stringify(synConverted[0]?.args));

  // plan-skills-file.md appendix is mandatory whenever a local file resolves —
  // including recovery/tier-3 plans whose base prompt lacks edit.agent docs.
  const { _buildSystemPrompt } = require('../src/nodes/planSkillsV2');
  const recoveryState = {
    recoveryContext: { reason: 'hollow' },
    _fileResolution: { status: 'exact', path: attachFile },
    _taskClassification: { taskType: 'local_file' },
  };
  const recoveryPrompt = _buildSystemPrompt(`[File: ${attachFile}] update section 1`, recoveryState);
  check('recovery prompt includes file-edit appendix',
    /LOCAL FILE EDITING|edit\.agent is the ONLY skill/i.test(recoveryPrompt || ''),
    `prompt len=${(recoveryPrompt || '').length}`);
  check('recovery prompt documents draft mode + keystroke ban',
    /mode:"draft"|mode:'draft'/i.test(recoveryPrompt) && /app\.agent.*keystroke|keystrokes/i.test(recoveryPrompt));

  const noFilePrompt = _buildSystemPrompt('what time is it in Tokyo', { _taskClassification: { taskType: 'query' } });
  check('non-file prompt skips file appendix', !/LOCAL FILE EDITING — MANDATORY RULES/.test(noFilePrompt || ''));

  fs.rmSync(attachDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

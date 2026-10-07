'use strict';

// Regression tests for the runGroup dispatch arg-resolution bug:
// a plan step image.analyze { filePath: "{{PREV_OUTPUT}}", runGroup: "g1" }
// dispatched the literal token — path.extname('{{PREV_OUTPUT}}') === '' —
// producing "Unsupported image format: .". Also covers the filePaths
// extraction gap for macOS screenshot names containing spaces / U+202F.

const {
  _extractFilePathsFromText,
  _resolveGroupStepArgs,
  autoInjectFromContracts,
  generateStepContract,
} = require('../src/nodes/executeCommand.js');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

// Real stdout shape from the failed run — macOS screenshot names contain a
// U+202F NARROW NO-BREAK SPACE before "PM".
const FIND_STDOUT = [
  '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 4.09.25\u202fPM.png',
  '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 7.30.48\u202fPM.png',
  '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 7.30.49\u202fPM.png',
  '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 7.31.34\u202fPM.png',
  '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 7.32.21\u202fPM.png',
].join('\n') + '\n';

console.log('\n--- _extractFilePathsFromText: spacey paths ---');
let paths = _extractFilePathsFromText(FIND_STDOUT);
check('extracts all 5 screenshot paths', paths.length === 5, JSON.stringify(paths));
check('first path intact incl. spaces', paths[0] === '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 4.09.25\u202fPM.png');

paths = _extractFilePathsFromText('/tmp/a.png\n/tmp/dir with spaces/b.jpg\nnot a path\n');
check('mixed lines → 2 paths', paths.length === 2 && paths[1] === '/tmp/dir with spaces/b.jpg', JSON.stringify(paths));

paths = _extractFilePathsFromText('no paths here at all');
check('no paths → []', Array.isArray(paths) && paths.length === 0);

console.log('\n--- generateStepContract shell.run → filePaths ---');
const contract = generateStepContract({
  skill: 'shell.run', ok: true, cmd: 'bash', exitCode: 0,
  stdout: FIND_STDOUT, stderr: '', args: { cmd: 'bash', argv: ['-c', 'find /Users/lukaizhi/Desktop -maxdepth 1 -type f 2>/dev/null | sort'] },
}, 0);
check('contract filePaths has 5 entries', contract.outputs.filePaths.value.length === 5, JSON.stringify(contract.outputs.filePaths.value));
check('contract does not contain /dev/null', !contract.outputs.filePaths.value.includes('/dev/null'));

console.log('\n--- autoInjectFromContracts → image.analyze ---');
let injected = autoInjectFromContracts({ query: 'describe' }, 'image.analyze', [contract], logger);
check('filePath = first image', injected.filePath === '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 4.09.25\u202fPM.png', injected.filePath);
check('filePaths = all 5 images', Array.isArray(injected.filePaths) && injected.filePaths.length === 5);

const singleContract = generateStepContract({
  skill: 'shell.run', ok: true, cmd: 'bash', exitCode: 0,
  stdout: '/tmp/only.png\n', args: {},
}, 0);
injected = autoInjectFromContracts({}, 'image.analyze', [singleContract], logger);
check('single image → filePath only, no filePaths', injected.filePath === '/tmp/only.png' && injected.filePaths === undefined, JSON.stringify(injected));

injected = autoInjectFromContracts({ filePath: '/explicit/x.png' }, 'image.analyze', [contract], logger);
check('explicit filePath untouched', injected.filePath === '/explicit/x.png' && injected.filePaths === undefined);

console.log('\n--- _resolveGroupStepArgs ---');
const prevResult = { skill: 'shell.run', ok: true, stdout: FIND_STDOUT, step: 1 };

// {{PREV_OUTPUT}} resolves to prior stdout
let r = _resolveGroupStepArgs({ filePath: '{{PREV_OUTPUT}}', query: 'q' }, 'image.analyze', {
  skillResults: [prevResult], priorResults: [], stepContracts: [contract], logger,
});
check('{{PREV_OUTPUT}} resolved to stdout', r.error === null && r.args.filePath === FIND_STDOUT.trim() || r.args.filePath === FIND_STDOUT, JSON.stringify(r.args.filePath).slice(0, 80));

// auto-inject fills filePath when step omits it
r = _resolveGroupStepArgs({ query: 'q' }, 'image.analyze', {
  skillResults: [prevResult], priorResults: [], stepContracts: [contract], logger,
});
check('missing filePath auto-injected', r.error === null && r.args.filePath === '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 4.09.25\u202fPM.png', JSON.stringify(r.args));

// {{CONTRACT[0].outputs.filePaths[0]}} resolves
r = _resolveGroupStepArgs({ filePath: '{{CONTRACT[0].outputs.filePaths[1]}}' }, 'image.analyze', {
  skillResults: [prevResult], priorResults: [], stepContracts: [contract], logger,
});
check('{{CONTRACT[0].outputs.filePaths[1]}} resolves', r.error === null && r.args.filePath === '/Users/lukaizhi/Desktop/Screenshot 2026-10-05 at 7.30.48\u202fPM.png', r.args.filePath);

// leftover {{...}} fails fast instead of dispatching a literal token
r = _resolveGroupStepArgs({ filePath: '{{DOES_NOT_EXIST}}' }, 'image.analyze', {
  skillResults: [prevResult], priorResults: [], stepContracts: [contract], logger,
});
check('unresolved {{...}} → error, not literal dispatch', typeof r.error === 'string' && r.error.includes('{{DOES_NOT_EXIST}}'), r.error);

// no prior results + {{PREV_OUTPUT}} → fails fast (prev is undefined → no substitution → guard catches)
r = _resolveGroupStepArgs({ filePath: '{{PREV_OUTPUT}}' }, 'image.analyze', {
  skillResults: [], priorResults: [], stepContracts: [], logger,
});
check('{{PREV_OUTPUT}} with no prior step → error', typeof r.error === 'string' && r.error.includes('{{PREV_OUTPUT}}'), r.error);

// same-lane priorResults take precedence as "prev"
const lanePrev = { skill: 'browser.act', ok: true, stdout: 'lane output' };
r = _resolveGroupStepArgs({ task: 'read {{prev_stdout}}' }, 'browser.act', {
  skillResults: [prevResult], priorResults: [lanePrev], stepContracts: [], logger,
});
check('same-lane prior wins for {{prev_stdout}}', r.error === null && r.args.task === 'read lane output', r.args.task);

// plain args pass through untouched
r = _resolveGroupStepArgs({ filePath: '/tmp/x.png' }, 'image.analyze', {
  skillResults: [prevResult], priorResults: [], stepContracts: [], logger,
});
check('no templates → passthrough', r.error === null && r.args.filePath === '/tmp/x.png');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

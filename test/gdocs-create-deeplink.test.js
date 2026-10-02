'use strict';
/**
 * gdocs-create-deeplink.test.js
 *
 * Regression tests for the Google Docs create flow failure.
 *
 * Observed run: "Open Google Docs and create a new document titled 'Q3
 * Planning Notes'" — url.first navigated to docs.google.com/document/create
 * and the doc WAS created (landed /d/<id>/edit), but:
 *   1. deepLinkType classified on the LANDED url → 'none' — downstream steps
 *      lost the "entity already created" signal → tab-map clicked "Doc home"
 *      and re-created a second doc.
 *   2. The planner emitted a redundant "create a new document" step because
 *      it never sees the resolved deep-link.
 *   3. The turn.loop verify step had no args.agentId → runGroup bucketed it
 *      into its own lane → launched in parallel with no session → derived
 *      'default_agent' → fresh about:blank browser → "unknown error".
 *
 * Fixes covered here:
 *   - url.first.agent._resolveDeepLinkType: classify the REQUESTED url first,
 *     fall back to the landed url.
 *   - dom.act._isPureCreateGoal: a pure create-goal after a creation/compose
 *     deep-link is already satisfied.
 *   - planSkillsV2._fillBrowserStepAgentIds: browser steps inherit agentId.
 *   - executeCommand._bucketGroupLanes: agentId-less browser steps join the
 *     prior browser lane instead of spawning a parallel lane.
 *
 * Run with: node test/gdocs-create-deeplink.test.js
 */

let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}\n  ${label}\n${'─'.repeat(70)}`);
  fn();
}
function it(label, fn) {
  try { fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push({ label, error: e.message }); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function expect(actual) {
  return {
    toBe(exp) { if (actual !== exp) throw new Error(`Expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual)}`); },
    toContain(s) { if (!String(actual).includes(s)) throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeNull() { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
    notToContain(s) { if (String(actual).includes(s)) throw new Error(`Expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(s)}`); },
  };
}

const { _resolveDeepLinkType } = require('../../mcp-services/command-service/src/skills/url.first.agent.cjs');
const { _isPureCreateGoal } = require('../../mcp-services/command-service/src/skills/dom.act.cjs');
const planSkillsV2 = require('../src/nodes/planSkillsV2.js');
const executeCommand = require('../src/nodes/executeCommand.js');

const CREATE_URL = 'https://docs.google.com/document/create';
const EDITOR_URL = 'https://docs.google.com/document/d/1rVbXMBnO4tcM8hfLDiDSSlKeHS80PwkvzvlobgMszK0/edit?tab=t.0';

describe('_resolveDeepLinkType — redirect-safe classification', () => {
  it('document/create → editor redirect keeps creation type', () => {
    expect(_resolveDeepLinkType(CREATE_URL, EDITOR_URL)).toBe('creation');
  });
  it('compose target keeps compose type after redirect strips the marker', () => {
    expect(_resolveDeepLinkType('https://mail.google.com/mail/u/0/#compose=new', 'https://mail.google.com/mail/u/0/#inbox')).toBe('compose');
  });
  it('search target keeps search type', () => {
    expect(_resolveDeepLinkType('https://mail.google.com/mail/u/0/#search/is%3Aunread', 'https://mail.google.com/mail/u/0/#search/is%3Aunread')).toBe('search');
  });
  it('generic startUrl + generic landed → none', () => {
    expect(_resolveDeepLinkType('https://docs.google.com', 'https://docs.google.com/document/u/0/')).toBe('none');
  });
  it('landed-url fallback when target classifies none', () => {
    expect(_resolveDeepLinkType('https://example.com', 'https://example.com/search?q=shoes')).toBe('search');
  });
  it('null inputs → none (no throw)', () => {
    expect(_resolveDeepLinkType(null, null)).toBe('none');
  });
});

describe('_isPureCreateGoal — dom.act already-satisfied gate', () => {
  it('"Create a new blank document" after creation deep-link → gate', () => {
    expect(_isPureCreateGoal('Create a new blank document', 'creation')).toBe(true);
  });
  it('"Compose a new email" after compose deep-link → gate', () => {
    expect(_isPureCreateGoal('Compose a new email', 'compose')).toBe(true);
  });
  it('no gate when priorNavType is none', () => {
    expect(_isPureCreateGoal('Create a new blank document', 'none')).toBe(false);
  });
  it('no gate when priorNavType is search', () => {
    expect(_isPureCreateGoal('Create a new blank document', 'search')).toBe(false);
  });
  it('fused goal "titled X" → NOT gated (title work remains)', () => {
    expect(_isPureCreateGoal("Create a new document titled 'Q3 Planning Notes'", 'creation')).toBe(false);
  });
  it('fused goal "and add content" → NOT gated', () => {
    expect(_isPureCreateGoal('Create a document and add meeting notes', 'creation')).toBe(false);
  });
  it('"Set document title" is not a create goal → NOT gated', () => {
    expect(_isPureCreateGoal("Set document title to 'Q3 Planning Notes'", 'creation')).toBe(false);
  });
  it('null/empty goal → NOT gated', () => {
    expect(_isPureCreateGoal('', 'creation')).toBe(false);
    expect(_isPureCreateGoal(null, 'creation')).toBe(false);
  });
});

describe('_fillBrowserStepAgentIds — planner post-pass', () => {
  const fill = planSkillsV2._fillBrowserStepAgentIds;
  it('turn.loop verify step inherits prior browser agentId', () => {
    const plan = [
      { skill: 'url.first.agent', args: { agentId: 'google.agent', task: 'Open Google Docs' } },
      { skill: 'dom.act', args: { agentId: 'google.agent', task: 'Set title' } },
      { skill: 'turn.loop.agent', args: { goal: 'Confirm doc titled', mode: 'verify' } },
      { skill: 'synthesize', args: { prompt: 'confirm' } },
    ];
    fill(plan, console);
    expect(plan[2].args.agentId).toBe('google.agent');
    expect(plan[3].args.agentId).toBe(undefined); // synthesize untouched
  });
  it('preserves explicit agentId and re-anchors the lane for later steps', () => {
    const plan = [
      { skill: 'url.first.agent', args: { agentId: 'gmail.agent' } },
      { skill: 'tab.map.agent', args: { agentId: 'other.agent' } },
      { skill: 'turn.loop.agent', args: { goal: 'check' } },
    ];
    fill(plan, console);
    expect(plan[1].args.agentId).toBe('other.agent');
    expect(plan[2].args.agentId).toBe('other.agent');
  });
  it('leading agentId-less browser step stays unset (nothing to inherit)', () => {
    const plan = [{ skill: 'turn.loop.agent', args: { goal: 'check' } }];
    fill(plan, console);
    expect(plan[0].args.agentId).toBe(undefined);
  });
  it('non-array input passes through', () => {
    expect(fill(null, console)).toBeNull();
    expect(fill({ ask: 'q' }, console).ask).toBe('q');
  });
});

describe('_bucketGroupLanes — runGroup lane bucketing', () => {
  const bucket = executeCommand._bucketGroupLanes;
  const mk = (skill, agentId, i) => ({ idx: i, step: { skill, args: agentId ? { agentId } : {} } });
  it('agentId-less turn.loop joins the google.agent lane (no parallel lane)', () => {
    const lanes = bucket([
      mk('url.first.agent', 'google.agent', 0),
      mk('dom.act', 'google.agent', 1),
      mk('dom.act', 'google.agent', 2),
      mk('turn.loop.agent', null, 3),
    ]);
    expect(lanes.size).toBe(1);
    expect(lanes.get('google.agent').length).toBe(4);
    expect(lanes.get('google.agent')[3].step.skill).toBe('turn.loop.agent');
  });
  it('agentId-less browser step with no prior browser lane keeps own bucket', () => {
    const lanes = bucket([mk('turn.loop.agent', null, 0)]);
    expect(lanes.size).toBe(1);
    expect(lanes.get('turn.loop.agent').length).toBe(1);
  });
  it('non-browser skills keep their own lanes', () => {
    const lanes = bucket([
      mk('url.first.agent', 'gmail.agent', 0),
      mk('fs.read', null, 1),
    ]);
    expect(lanes.size).toBe(2);
    expect(lanes.has('fs.read')).toBeTruthy();
  });
  it('explicit agentId on browser step creates/uses its own lane', () => {
    const lanes = bucket([
      mk('url.first.agent', 'gmail.agent', 0),
      mk('turn.loop.agent', 'docs.agent', 1),
    ]);
    expect(lanes.size).toBe(2);
    expect(lanes.get('docs.agent').length).toBe(1);
  });
});

describe('planner prompt — RESOLVED DESTINATIONS + agentId rule', () => {
  it('verify-step example carries agentId', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/nodes/planSkillsV2.js'), 'utf8');
    expect(src).toContain('"stepType": "verify", "args": { "agentId": "amazon.agent"');
  });
  it('prompt warns that steps without agentId run sessionless', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/nodes/planSkillsV2.js'), 'utf8');
    expect(src).toContain('must carry that service');
    expect(src).toContain('RESOLVED DESTINATIONS');
  });
  it('shortcut.keys hint excludes create/open goals', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/nodes/planSkillsV2.js'), 'utf8');
    expect(src).toContain('NOT for create/open/new goals');
  });
});

const pw = require('../../mcp-services/command-service/src/skills/playwright.agent.cjs');
const WRAPPED_VERIFY = `VERIFICATION ONLY — do NOT click, type, submit, or navigate. Observe the current page and report whether this condition holds: Confirm document created and titled 'Q3 Planning Notes'`;

describe('verify-mode goal sanitization (playwright.agent)', () => {
  it('entity extraction strips the VERIFICATION ONLY wrapper', () => {
    const ents = pw._extractGoalEntities(WRAPPED_VERIFY);
    expect(ents.includes('VERIFICATION')).toBeFalsy();
    expect(ents.includes('ONLY')).toBeFalsy();
    expect(ents.includes('Q3 Planning Notes')).toBeTruthy();
  });
  it('preserves real capitalized entities', () => {
    const ents = pw._extractGoalEntities('Add songs by KB and Newsboys to my playlist');
    expect(ents.includes('KB')).toBeTruthy();
    expect(ents.includes('Newsboys')).toBeTruthy();
  });
  it('verify goals skip LLM decomposition — single criterion sub-task', async () => {
    const r = await pw._decomposeGoalIntoSubTasks(WRAPPED_VERIFY, 'test_session');
    expect(r.ok).toBeTruthy();
    expect(r.subTasks.length).toBe(1);
    expect(r.subTasks[0].verification).toContain("Q3 Planning Notes");
    expect(r.subTasks[0].description).notToContain('songs');
  });
  it('non-verify goals do NOT take the deterministic verify early-return', async () => {
    const r = await pw._decomposeGoalIntoSubTasks('Add songs by KB to my Spotify playlist', 'test_session');
    // Live-LLM envs return a multi-subtask plan; offline envs return ok:false.
    // Either is fine — the assertion is that the result is NOT the single
    // deterministic "Verify: <cond>" criterion sub-task reserved for verify goals.
    const isVerifyShape = r.ok === true && Array.isArray(r.subTasks) &&
      r.subTasks.length === 1 && /^Verify:/.test(r.subTasks[0].description || '');
    expect(isVerifyShape).toBeFalsy();
  });
});

describe('_stripRedundantVerifySteps — post-pass', () => {
  const strip = planSkillsV2._stripRedundantVerifySteps;
  const plan = [
    { skill: 'url.first.agent', args: { agentId: 'google.agent' } },
    { skill: 'dom.act', args: { agentId: 'google.agent', task: "Set title" } },
    { skill: 'turn.loop.agent', stepType: 'verify', args: { agentId: 'google.agent', mode: 'verify' } },
    { skill: 'synthesize', args: { prompt: 'x' } },
  ];
  it("interactiveActions=['create'] → verify step dropped", () => {
    const out = strip(plan, { _taskClassification: { interactiveActions: ['create'] } }, console);
    expect(out.length).toBe(3);
    expect(out.some(s => s.skill === 'turn.loop.agent')).toBeFalsy();
  });
  it("interactiveActions=['add_to_cart'] → verify kept", () => {
    const out = strip(plan, { _taskClassification: { interactiveActions: ['add_to_cart'] } }, console);
    expect(out.length).toBe(4);
  });
  it('no classification → verify kept (fail-safe)', () => {
    const out = strip(plan, {}, console);
    expect(out.length).toBe(4);
  });
  it("interactiveActions=['read_account'] → verify dropped", () => {
    const out = strip(plan, { _taskClassification: { interactiveActions: ['read_account'] } }, console);
    expect(out.length).toBe(3);
  });
  it('act-mode turn.loop steps are never stripped', () => {
    const actPlan = [
      { skill: 'dom.act', args: { agentId: 'x.agent' } },
      { skill: 'turn.loop.agent', args: { agentId: 'x.agent', mode: 'act' } },
    ];
    const out = strip(actPlan, { _taskClassification: { interactiveActions: ['create'] } }, console);
    expect(out.length).toBe(2);
  });
});

// ── Second-run regression (title-typed-into-body + stall) ──────────────────
// Observed run 2: title WAS set at step level, but the cached element map
// still showed value="Untitled document" → LLM kept acting → malformed
// "Run code: <javascript>" crashed tab.map → reroute cascades → turn-loop
// typed into the focused document BODY → transient "is focused" criterion
// burned 8 turns → just.type re-typed.

const { _parseAction } = require('../../mcp-services/command-service/src/skills/lib/browserCore/actionParse.cjs');
const { deepLinkOpensOverlay } = require('../../mcp-services/command-service/src/skill-helpers/deep-link-types.cjs');
const { _mutationApplied } = require('../../mcp-services/command-service/src/skills/dom.act.cjs');

describe('actionParse — Run code placeholder handling', () => {
  it('unwraps <javascript>…</javascript> around real code', () => {
    const out = 'I will fix it.\nRun code: <javascript>\nconst r = document.querySelector("input");\nr.focus();\n</javascript>';
    const p = _parseAction(out);
    expect(p.action).toBe('run-code');
    expect(p.code).toContain('document.querySelector');
    expect(/^</.test(p.code)).toBeFalsy();
  });
  it('bare "Run code: <javascript>" is unparseable (reprompt, not eval crash)', () => {
    expect(_parseAction('Run code: <javascript>')).toBeNull();
  });
  it('plain code passes through untouched', () => {
    const p = _parseAction('Run code: document.title = "X"');
    expect(p.action).toBe('run-code');
    expect(p.code).toBe('document.title = "X"');
  });
  it('code fenced in ``` is unwrapped', () => {
    const p = _parseAction('Run code:\n```\nreturn 1+1;\n```');
    expect(p.code).toBe('return 1+1;');
  });
});

describe('deepLinkOpensOverlay — creation type narrowed to URL markers', () => {
  it('landed entity page (/d/<id>/edit) → no overlay expected', () => {
    expect(deepLinkOpensOverlay('https://docs.google.com/document/d/abc123/edit', 'creation')).toBeFalsy();
  });
  it('creation URL still showing a dialog marker (eventedit) → true', () => {
    expect(deepLinkOpensOverlay('https://calendar.google.com/calendar/u/0/r/eventedit/xyz', 'creation')).toBeTruthy();
  });
  it('creation URL with overlay param key (?create=) → true', () => {
    expect(deepLinkOpensOverlay('https://example.com/x?create=true', 'creation')).toBeTruthy();
  });
  it('compose type stays blanket-true', () => {
    expect(deepLinkOpensOverlay('https://mail.google.com/mail/u/0/#inbox?compose=new', 'compose')).toBeTruthy();
  });
  it('read type with clean URL → false', () => {
    expect(deepLinkOpensOverlay('https://example.com/docs/123', 'read')).toBeFalsy();
  });
});

describe('dom.act _mutationApplied — no re-route after a landed mutation', () => {
  const goalDq = 'Set the document title to "Q3 Planning Notes"';
  const goalSq = "Set the document title to 'Q3 Planning Notes'";
  it('filledFields carrying the quoted value → true', () => {
    const res = { ok: false, filledFields: [{ ref: 'tm-x', label: 'Rename', value: 'Q3 Planning Notes' }] };
    expect(_mutationApplied(res, goalDq)).toBeTruthy();
  });
  it('transcript with a successful reactFill of the value → true', () => {
    const res = { ok: false, transcript: ['reactFill [aria-label=Rename] "Q3 Planning Notes" → ok', 'press Enter → ok'] };
    expect(_mutationApplied(res, goalSq)).toBeTruthy();
  });
  it('failed mutation entries do NOT count', () => {
    const res = { ok: false, transcript: ['type "Q3 Planning Notes" → FAILED'] };
    expect(_mutationApplied(res, goalDq)).toBeFalsy();
  });
  it('no mutation evidence → false', () => {
    const res = { ok: false, transcript: ['click "Doc home" → ok'] };
    expect(_mutationApplied(res, goalDq)).toBeFalsy();
  });
  it('goal without a quoted value → false (conservative)', () => {
    const res = { ok: false, filledFields: [{ ref: 'x', label: 'y', value: 'v' }] };
    expect(_mutationApplied(res, 'click the save button')).toBeFalsy();
  });
  it('ok:true results short-circuit false (nothing to rescue)', () => {
    const res = { ok: true, filledFields: [{ value: 'Q3 Planning Notes' }] };
    expect(_mutationApplied(res, goalDq)).toBeFalsy();
  });
});

describe('engine-owned dispatch guards (structural)', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '../../mcp-services/command-service/src/skills');
  it("browser.act has case 'key' aliased to the press handler", () => {
    const src = fs.readFileSync(path.join(SRC, 'browser.act.cjs'), 'utf8');
    expect(/case 'key':\s*\n\s*case 'keyboard':\s*\n\s*case 'press':/.test(src)).toBeTruthy();
  });
  it('browser.act evaluate/run-code reject template placeholders', () => {
    const src = fs.readFileSync(path.join(SRC, 'browser.act.cjs'), 'utf8');
    const hits = (src.match(/unsubstituted placeholder/g) || []).length;
    expect(hits >= 2).toBeTruthy();
  });
  it('evaluate returns the engine error instead of dead cliRun on owned sessions', () => {
    const src = fs.readFileSync(path.join(SRC, 'browser.act.cjs'), 'utf8');
    expect(src).toContain('CLI fallback is ownership-blocked');
  });
});

console.log(`\n${'─'.repeat(70)}\n  Results: ${_passed} passed, ${_failed} failed\n${'─'.repeat(70)}`);
if (_failures.length) { _failures.forEach(f => console.log(`  FAIL: ${f.label}`)); process.exit(1); }
// playwright.agent holds open LLM sockets — exit explicitly on success so the
// process doesn't linger on in-flight handles.
process.exit(0);

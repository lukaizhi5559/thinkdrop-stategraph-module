'use strict';
const path = require('path');
let _p = 0, _f = 0;
const _errs = [];
async function it(l, fn) { try { await fn(); _p++; console.log(`  ✅ ${l}`); } catch (e) { _f++; _errs.push({l, e: e.message}); console.log(`  ❌ ${l}\n     ${e.message}`); } }
function section(l) { console.log(`\n${'─'.repeat(72)}\n  ${l}\n${'─'.repeat(72)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, e, m) { if (a !== e) throw new Error(m || `Expected ${e}, got ${a}`); }

const { _validatePlanSemantics } = require(path.resolve(__dirname, '..', '..', 'mcp-services', 'command-service', 'src', 'skills', 'playwright.agent.cjs'));

section('Semantic plan validation guard');

(async () => {
await it('rejects extraction-only plan for count task without search', () => {
  const v = _validatePlanSemantics('How many unread emails from Pastor Wendal?', [{action:'run-code'},{action:'return'}], 'count emails', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v !== null, 'Should detect'); assertEqual(v.violated, 'extraction_without_search');
});
await it('rejects extraction before search', () => {
  const v = _validatePlanSemantics('Find unread emails', [{action:'getPageText'},{action:'fill'},{action:'press'}], 'search then extract', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v !== null); assertEqual(v.violated, 'extraction_before_search');
});
await it('rejects thoughts-search-no-action', () => {
  const v = _validatePlanSemantics('How many unread?', [{action:'click',selector:'Refresh'},{action:'snapshot'},{action:'getPageText'}], 'I will search for unread', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v !== null); assertEqual(v.violated, 'thoughts_search_no_action');
});
await it('accepts search-before-extraction', () => {
  const v = _validatePlanSemantics('How many unread from Pastor Wendal?', [{action:'click',selector:'Search'},{action:'fill',text:'from:Pastor Wendal is:unread'},{action:'press',key:'Enter'},{action:'snapshot'},{action:'getPageText'}], 'search then read', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v === null, 'Should pass');
});
await it('accepts extraction when URL already has search query', () => {
  const v = _validatePlanSemantics('How many unread?', [{action:'getPageText'}], 'read results', 'https://mail.google.com/mail/u/0/#search/from%3APastor%20Wendal%20is%3Aunread');
  assert(v === null, 'Should pass — URL has active search');
});
await it('skips non-search tasks', () => {
  const v = _validatePlanSemantics('Compose an email to John', [{action:'getPageText'}], 'compose', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v === null, 'Should skip non-search task');
});

section('Brittle CSS selector ban');
await it('rejects run-code with tr.zA Gmail CSS selector', () => {
  const v = _validatePlanSemantics('How many unread emails from Pastor Wendal?', [
    {action:'fill',text:'is:unread from:Pastor Wendal'},
    {action:'press',key:'Enter'},
    {action:'snapshot'},
    {action:'run-code',code:'async page => { const emails = Array.from(document.querySelectorAll(\'tr.zA[aria-label*="unread"]\')).filter(e => e.textContent.includes("Pastor Wendal")); return emails.length; }'}
  ], 'search then count', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v !== null, 'Should detect brittle CSS');
  assertEqual(v.violated, 'brittle_css_selector');
});
await it('rejects run-code with .zE Gmail CSS selector', () => {
  const v = _validatePlanSemantics('Check unread emails', [
    {action:'fill',text:'is:unread'},
    {action:'press',key:'Enter'},
    {action:'snapshot'},
    {action:'run-code',code:'async page => { return await page.evaluate(() => { return document.querySelectorAll(\'tr.zE\').length; }); }'}
  ], 'search then count', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v !== null, 'Should detect .zE CSS');
  assertEqual(v.violated, 'brittle_css_selector');
});
await it('accepts getPageText for count task after search', () => {
  const v = _validatePlanSemantics('How many unread from Pastor Wendal?', [
    {action:'fill',text:'is:unread from:Pastor Wendal'},
    {action:'press',key:'Enter'},
    {action:'snapshot'},
    {action:'getPageText'}
  ], 'search then read', 'https://mail.google.com/mail/u/0/#inbox');
  assert(v === null, 'getPageText plan should pass validation');
});

section('Gmail waitForStableText change-then-stable pattern');
await it('Gmail branch no longer has immediate length>100 return', () => {
  const src = require('fs').readFileSync(path.resolve(__dirname, '..', '..', 'mcp-services', 'command-service', 'src', 'skills', 'browser.act.cjs'), 'utf8');
  const gmailBlockStart = src.indexOf('Using Gmail-optimized waitForStableText (engine)');
  const gmailBlockEnd = src.indexOf('Standard waitForStableText with engine polling');
  assert(gmailBlockStart > -1 && gmailBlockEnd > -1, 'Should find Gmail and standard blocks');
  const gmailBlock = src.slice(gmailBlockStart, gmailBlockEnd);
  assert(!/cur\.length\s*>\s*100\s*\)\s*\{?\s*return/.test(gmailBlock), 'Gmail branch must NOT have immediate length>100 return');
});
await it('Gmail branch includes baseline change-detection logic', () => {
  const src = require('fs').readFileSync(path.resolve(__dirname, '..', '..', 'mcp-services', 'command-service', 'src', 'skills', 'browser.act.cjs'), 'utf8');
  const gmailBlockStart = src.indexOf('Using Gmail-optimized waitForStableText (engine)');
  const gmailBlockEnd = src.indexOf('Standard waitForStableText with engine polling');
  const gmailBlock = src.slice(gmailBlockStart, gmailBlockEnd);
  assert(gmailBlock.includes('baselineText'), 'Gmail branch should track baselineText');
  assert(gmailBlock.includes('baselineHref'), 'Gmail branch should track baselineHref');
  assert(gmailBlock.includes('phase === 1') || gmailBlock.includes("phase === '1'"), 'Gmail branch should have phase 1 (wait for change)');
  assert(gmailBlock.includes('phase = 2') || gmailBlock.includes("phase = '2'"), 'Gmail branch should transition to phase 2 (stability)');
  assert(gmailBlock.includes('stableCount'), 'Gmail branch should track stableCount for stability');
});

section('Answer-only contradiction routing (StateGraphBuilder)');
await it('CORRECTED verdict routes to logConversation not evaluateSkills', () => {
  const src = require('fs').readFileSync(path.resolve(__dirname, '..', 'src', 'StateGraphBuilder.js'), 'utf8');
  assert(src.includes("verdict === 'CORRECTED'"), 'StateGraphBuilder should handle CORRECTED verdict');
  assert(src.includes("reviewExecution CORRECTED"), 'CORRECTED should route to logConversation');
  assert(src.includes("return 'logConversation'"), 'Should return logConversation');
});

section('Output schema regex fallback (_inferOutputSchemaFallback)');
{
  const { _inferOutputSchemaFallback } = require(path.resolve(__dirname, '..', 'src', 'nodes', 'planSkillsV2.js'));
  await it('detects INTEGER from "how many"', () => {
    const r = _inferOutputSchemaFallback('How many unread emails do I have?');
    assert(r !== null, 'Should detect'); assertEqual(r.type, 'INTEGER');
  });
  await it('detects INTEGER from "count the"', () => {
    const r = _inferOutputSchemaFallback('Count the files in the folder');
    assert(r !== null); assertEqual(r.type, 'INTEGER');
  });
  await it('detects BOOLEAN from "is there"', () => {
    const r = _inferOutputSchemaFallback('Is there a new message?');
    assert(r !== null); assertEqual(r.type, 'BOOLEAN');
  });
  await it('detects ARRAY from "list all"', () => {
    const r = _inferOutputSchemaFallback('List all files in the folder');
    assert(r !== null); assertEqual(r.type, 'ARRAY');
  });
  await it('returns null for "summarize"', () => {
    const r = _inferOutputSchemaFallback('Summarize the article for me');
    assert(r === null, 'Should not infer type for summary');
  });
  await it('returns INTEGER for multi-type prompt containing "how many" (regex is keyword-based, multi-type left to LLM)', () => {
    const r = _inferOutputSchemaFallback('How many items and list their names');
    assert(r !== null && r.type === 'INTEGER', 'Regex matches "how many" keyword — multi-type detection is LLM responsibility');
  });
}

section('Answer-type validation (validateAnswerTypes)');
{
  const evalMod = require(path.resolve(__dirname, '..', 'src', 'nodes', 'evaluateSkills.js'));
  const { validateAnswerTypes, _validateSingleType } = evalMod;

  await it('validateAnswerTypes ["INTEGER"]: "3" passes', () => {
    assert(validateAnswerTypes('3', ['INTEGER']), 'Pure number should pass');
  });
  await it('validateAnswerTypes ["INTEGER"]: long paragraph fails', () => {
    assert(!validateAnswerTypes('This is a long summary paragraph that goes on and on about things without containing any numbers at all whatsoever.', ['INTEGER']), 'Long paragraph without number should fail');
  });
  await it('validateAnswerTypes ["BOOLEAN"]: "Yes, there are" passes', () => {
    assert(validateAnswerTypes('Yes, there are 3 items', ['BOOLEAN']), 'Yes prefix should pass');
  });
  await it('validateAnswerTypes ["BOOLEAN"]: "summary" fails', () => {
    assert(!validateAnswerTypes('The results show various items', ['BOOLEAN']), 'Non-yes/no should fail');
  });
  await it('validateAnswerTypes ["ARRAY"]: bulleted list passes', () => {
    assert(validateAnswerTypes('- item1\n- item2\n- item3', ['ARRAY']), 'Bulleted list should pass');
  });
  await it('validateAnswerTypes ["ARRAY"]: paragraph fails', () => {
    assert(!validateAnswerTypes('There are several items in the list including apples oranges and bananas.', ['ARRAY']), 'Paragraph should fail');
  });
  await it('validateAnswerTypes ["INTEGER","ARRAY"]: "3\\n- a\\n- b" passes', () => {
    assert(validateAnswerTypes('3\n- a\n- b', ['INTEGER', 'ARRAY']), 'Number + list should pass both');
  });
  await it('validateAnswerTypes ["INTEGER","ARRAY"]: "3" fails (missing array)', () => {
    assert(!validateAnswerTypes('3', ['INTEGER', 'ARRAY']), 'Number alone should fail ARRAY check');
  });
  await it('validateAnswerTypes ["INTEGER","BOOLEAN","ARRAY"]: all three present passes', () => {
    assert(validateAnswerTypes('Yes\n5\n- a\n- b', ['INTEGER', 'BOOLEAN', 'ARRAY']), 'All three types present should pass');
  });
  await it('validateAnswerTypes []: always passes', () => {
    assert(validateAnswerTypes('anything', []), 'Empty types should always pass');
  });
  await it('validateAnswerTypes null: always passes', () => {
    assert(validateAnswerTypes('anything', null), 'Null types should always pass');
  });
}

section('evaluateSkills reads outputSchema from plan (_getExpectedAnswerTypes)');
{
  const evalMod = require(path.resolve(__dirname, '..', 'src', 'nodes', 'evaluateSkills.js'));
  const { _getExpectedAnswerTypes } = evalMod;

  await it('reads ["INTEGER"] from plan synthesize args.outputSchema.type string', () => {
    const plan = [{ skill: 'browser.act' }, { skill: 'synthesize', args: { outputSchema: { type: 'INTEGER' } } }];
    const r = _getExpectedAnswerTypes(plan, 'how many emails?');
    assert(Array.isArray(r) && r.length === 1 && r[0] === 'INTEGER', 'Should read INTEGER from plan');
  });
  await it('reads ["INTEGER","ARRAY"] from plan synthesize args.outputSchema.type array', () => {
    const plan = [{ skill: 'synthesize', args: { outputSchema: { type: ['INTEGER', 'ARRAY'] } } }];
    const r = _getExpectedAnswerTypes(plan, 'how many and list them');
    assert(Array.isArray(r) && r.length === 2 && r[0] === 'INTEGER' && r[1] === 'ARRAY', 'Should read array from plan');
  });
  await it('falls back to regex when plan has no outputSchema', () => {
    const plan = [{ skill: 'synthesize', args: { prompt: 'answer the question' } }];
    const r = _getExpectedAnswerTypes(plan, 'how many emails?');
    assert(Array.isArray(r) && r[0] === 'INTEGER', 'Should fall back to regex INTEGER');
  });
  await it('returns null when no pattern matches and no outputSchema', () => {
    const plan = [{ skill: 'synthesize', args: { prompt: 'summarize' } }];
    const r = _getExpectedAnswerTypes(plan, 'summarize the article');
    assert(r === null, 'Should return null for ambiguous prompt');
  });
  await it('reads from last synthesize step when multiple exist', () => {
    const plan = [
      { skill: 'synthesize', args: { outputSchema: { type: 'STRING' } } },
      { skill: 'synthesize', args: { outputSchema: { type: 'INTEGER' } } }
    ];
    const r = _getExpectedAnswerTypes(plan, 'how many?');
    assert(r[0] === 'INTEGER', 'Should read from last synthesize step');
  });
}

console.log(`\n${'═'.repeat(72)}\n  Results: ${_p} passed, ${_f} failed\n${'═'.repeat(72)}`);
if (_f > 0) { _errs.forEach(e => console.log(`  ❌ ${e.l}: ${e.e}`)); process.exit(1); }
})();

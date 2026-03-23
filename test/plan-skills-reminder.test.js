'use strict';

/**
 * plan-skills-reminder.test.js
 *
 * Benchmark test for buildReminderSkill — the deterministic reminder skill factory.
 *
 * TWO MODES:
 *
 *   Pure mode  (default): calls buildReminderSkill directly, validates output
 *                         structure against fixture expected values. No services
 *                         required. Fast (~100ms for 500 prompts).
 *
 *   Integration mode (--integration): additionally calls the real skill.install
 *                         HTTP API (port 3001) and skill.remove to confirm the
 *                         generated skill.md is accepted by skillRegistry.
 *                         Requires: user-memory-service running on port 3001.
 *
 * USAGE:
 *   node test/plan-skills-reminder.test.js
 *   node test/plan-skills-reminder.test.js --integration
 *   node test/plan-skills-reminder.test.js --failures          # show only failures
 *   node test/plan-skills-reminder.test.js --verbose           # show all results
 *   node test/plan-skills-reminder.test.js --only=notify       # filter category
 *   node test/plan-skills-reminder.test.js --only=bridge
 *   node test/plan-skills-reminder.test.js --only=no-fire
 *   node test/plan-skills-reminder.test.js --fix-fixture       # update fixture expected
 *                                                               # values to match actual
 *                                                               # output (use carefully)
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const INTEGRATION  = args.includes('--integration');
const SHOW_FAILURE = args.includes('--failures');
const VERBOSE      = args.includes('--verbose');
const FIX_FIXTURE  = args.includes('--fix-fixture');
const ONLY_FLAG    = (args.find(a => a.startsWith('--only=')) || '').replace('--only=', '') || null;

// ── Load dependencies ─────────────────────────────────────────────────────────
const { buildReminderSkill, SKILL_NAME_PATTERN } = require('../src/utils/buildReminderSkill');
const FIXTURE_PATH = path.join(__dirname, 'fixtures/reminder-benchmark.json');
const HOME_DIR = process.env.HOME || '/Users/test';

// ── Counters ──────────────────────────────────────────────────────────────────
let total = 0, passed = 0, failed = 0, skipped = 0;
const failures = [];
const categoryStats = { notify: [0,0], bridge: [0,0], 'no-fire': [0,0] };

// ── SKILL_NAME_PATTERN mirror (from skillRegistry) ───────────────────────────
const REQUIRED_FIELDS = ['name', 'description', 'exec_path', 'exec_type'];

// ── HTTP helper for integration tests ────────────────────────────────────────
function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function isServiceReachable(port) {
  return httpPost(port, '/skill.install', { payload: { contractMd: '' }, requestId: 'ping' })
    .then(() => true)
    .catch(() => false);
}

// ── Validate skill.md content ─────────────────────────────────────────────────
function validateSkillMd(skillMd, skillName) {
  const errors = [];
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) { errors.push('No frontmatter block found'); return errors; }
  const fm = fmMatch[1];

  REQUIRED_FIELDS.forEach(f => {
    if (!new RegExp(`^${f}:`, 'm').test(fm)) errors.push(`Missing required field: ${f}`);
  });

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (nameMatch && !SKILL_NAME_PATTERN.test(nameMatch[1].trim())) {
    errors.push(`Invalid skill name: "${nameMatch[1].trim()}"`);
  }

  const execTypeMatch = fm.match(/^exec_type:\s*(.+)$/m);
  if (execTypeMatch && !['node','shell'].includes(execTypeMatch[1].trim())) {
    errors.push(`Invalid exec_type: "${execTypeMatch[1].trim()}"`);
  }

  const execPathMatch = fm.match(/^exec_path:\s*(.+)$/m);
  if (execPathMatch && !execPathMatch[1].includes('.thinkdrop/skills/')) {
    errors.push(`exec_path must be inside ~/.thinkdrop/skills/`);
  }

  return errors;
}

// ── Core pure-mode assertion ───────────────────────────────────────────────────
function assertCase(entry, result) {
  const { id, message, expected } = entry;
  const errs = [];

  // fires check
  if (result.fires !== expected.fires) {
    errs.push(`fires: expected=${expected.fires} actual=${result.fires}`);
  }

  // recurring check (when explicitly specified in fixture)
  if (expected.recurring !== undefined && result.recurring !== expected.recurring) {
    errs.push(`recurring: expected=${expected.recurring} actual=${result.recurring}`);
  }

  if (expected.fires === true && result.fires === true) {
    // tier
    if (expected.tier && result.tier !== expected.tier) {
      errs.push(`tier: expected=${expected.tier} actual=${result.tier}`);
    }

    // skillNameValid
    if (expected.skillNameValid !== undefined) {
      const isValid = SKILL_NAME_PATTERN.test(result.skillName || '');
      if (isValid !== expected.skillNameValid) {
        errs.push(`skillNameValid: expected=${expected.skillNameValid} actual=${isValid} (name="${result.skillName}")`);
      }
    }

    // cronHour
    if (expected.cronHour !== undefined && result.cronHour !== expected.cronHour) {
      errs.push(`cronHour: expected=${expected.cronHour} actual=${result.cronHour}`);
    }

    // cronMinute
    if (expected.cronMinute !== undefined && result.cronMinute !== expected.cronMinute) {
      errs.push(`cronMinute: expected=${expected.cronMinute} actual=${result.cronMinute}`);
    }

    // dayOfWeek
    if (expected.dayOfWeek !== undefined && result.dayOfWeek !== expected.dayOfWeek) {
      errs.push(`dayOfWeek: expected=${expected.dayOfWeek} actual=${result.dayOfWeek}`);
    }

    // skill.md structural validity
    if (result.skillMd) {
      const mdErrs = validateSkillMd(result.skillMd, result.skillName);
      mdErrs.forEach(e => errs.push(`skillMd: ${e}`));
    }

    // skillPlan shape
    if (!Array.isArray(result.skillPlan) || result.skillPlan.length !== 3) {
      errs.push(`skillPlan: expected 3 steps, got ${result.skillPlan?.length ?? 'undefined'}`);
    } else {
      const expectedSkills = ['shell.run', 'skill.install', 'shell.run'];
      result.skillPlan.forEach((step, i) => {
        if (step.skill !== expectedSkills[i]) errs.push(`skillPlan[${i}].skill: expected=${expectedSkills[i]} actual=${step.skill}`);
      });
    }
  }

  return errs;
}

// ── Integration: call skill.install + skill.remove ────────────────────────────
async function integrationAssert(entry, result) {
  if (!result.fires) return [];
  const errs = [];

  // Write skill.md to /tmp for the install call
  const tmpDir = `/tmp/thinkdrop-test/${result.skillName}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = `${tmpDir}/skill.md`;
  fs.writeFileSync(tmpPath, result.skillMd, 'utf8');

  try {
    const installRes = await httpPost(3001, '/skill.install', {
      payload: { contractMd: result.skillMd },
      requestId: `test-${entry.id}`,
    });

    if (installRes.status !== 200) {
      errs.push(`skill.install HTTP ${installRes.status}: ${JSON.stringify(installRes.body)}`);
    } else {
      // Clean up — remove the test skill so it doesn't pollute the scheduler
      await httpPost(3001, '/skill.remove', {
        payload: { name: result.skillName },
        requestId: `test-cleanup-${entry.id}`,
      }).catch(() => {});
    }
  } catch (netErr) {
    errs.push(`skill.install network error: ${netErr.message}`);
  } finally {
    // Clean up tmp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  }

  return errs;
}

// ── Category helper ───────────────────────────────────────────────────────────
function getCategory(entry) {
  if (entry.expected.fires === false) return 'no-fire';
  return entry.expected.tier || 'notify';
}

// ── Main runner ───────────────────────────────────────────────────────────────
async function run() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  // ── Mode banner ─────────────────────────────────────────────────────────────
  let serviceAvailable = false;
  if (INTEGRATION) {
    serviceAvailable = await isServiceReachable(3001);
    if (!serviceAvailable) {
      console.warn('⚠️  --integration: user-memory-service not reachable on port 3001 — running pure-only');
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(` buildReminderSkill benchmark — ${fixture.length} prompts`);
  console.log(` Mode: ${INTEGRATION && serviceAvailable ? 'PURE + INTEGRATION' : 'PURE'}`);
  if (ONLY_FLAG) console.log(` Filter: --only=${ONLY_FLAG}`);
  console.log(`${'─'.repeat(70)}\n`);

  const updatedFixture = FIX_FIXTURE ? [...fixture] : null;

  for (const entry of fixture) {
    const category = getCategory(entry);

    // Apply --only filter
    if (ONLY_FLAG && category !== ONLY_FLAG) { skipped++; continue; }

    total++;

    let result;
    try {
      result = buildReminderSkill(entry.message, HOME_DIR);
    } catch (err) {
      failures.push({ id: entry.id, message: entry.message, category, errors: [`buildReminderSkill threw: ${err.message}`] });
      failed++;
      if (categoryStats[category]) categoryStats[category][1]++;
      continue;
    }

    const pureErrors = assertCase(entry, result);
    let integrationErrors = [];
    if (INTEGRATION && serviceAvailable) {
      integrationErrors = await integrationAssert(entry, result);
    }

    const allErrors = [...pureErrors, ...integrationErrors];

    if (allErrors.length === 0) {
      passed++;
      if (categoryStats[category]) categoryStats[category][0]++;
      if (VERBOSE) {
        const name = result.fires ? result.skillName : '(no-fire)';
        console.log(`  ✅ ${entry.id}  ${name}`);
      }
    } else {
      failed++;
      if (categoryStats[category]) categoryStats[category][1]++;
      failures.push({ id: entry.id, message: entry.message, category, errors: allErrors, actual: result });

      // If fixing fixture, update expected to match actual
      if (FIX_FIXTURE && updatedFixture) {
        const idx = updatedFixture.findIndex(e => e.id === entry.id);
        if (idx !== -1 && result !== undefined) {
          updatedFixture[idx] = {
            ...updatedFixture[idx],
            expected: {
              fires: result.fires,
              ...(result.fires ? {
                tier: result.tier,
                skillNameValid: SKILL_NAME_PATTERN.test(result.skillName || ''),
                cronHour: result.cronHour,
                cronMinute: result.cronMinute,
                dayOfWeek: result.dayOfWeek,
              } : {}),
            },
          };
        }
      }
    }
  }

  // ── Print failures ──────────────────────────────────────────────────────────
  if (failures.length > 0 && (SHOW_FAILURE || !VERBOSE)) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(` FAILURES (${failures.length})`);
    console.log(`${'─'.repeat(70)}`);
    failures.forEach(f => {
      console.log(`\n  ❌ ${f.id} [${f.category}]`);
      console.log(`     Message : "${f.message}"`);
      f.errors.forEach(e => console.log(`     Error   : ${e}`));
      if (f.actual && f.actual.fires) {
        console.log(`     Actual  : tier=${f.actual.tier} name=${f.actual.skillName} cron="${f.actual.cronExpr}" DOW=${f.actual.dayOfWeek}`);
      } else if (f.actual) {
        console.log(`     Actual  : fires=false`);
      }
    });
  }

  // ── Category breakdown ──────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(` RESULTS BY CATEGORY`);
  console.log(`${'─'.repeat(70)}`);
  for (const [cat, [p, f]] of Object.entries(categoryStats)) {
    if (ONLY_FLAG && cat !== ONLY_FLAG) continue;
    const n = p + f;
    if (n === 0) continue;
    const pct = n > 0 ? Math.round((p/n)*100) : 0;
    const bar = '█'.repeat(Math.round(pct/5)) + '░'.repeat(20 - Math.round(pct/5));
    console.log(`  ${cat.padEnd(10)} [${bar}] ${pct}%  (${p}/${n})`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  Total:   ${total + skipped}`);
  if (skipped) console.log(`  Skipped: ${skipped}`);
  console.log(`  Ran:     ${total}`);
  console.log(`  Passed:  ${passed}  ${passed === total ? '✅' : ''}`);
  console.log(`  Failed:  ${failed}  ${failed > 0 ? '❌' : ''}`);
  if (INTEGRATION && serviceAvailable) {
    console.log(`  (includes skill.install integration assertions)`);
  }
  console.log(`${'─'.repeat(70)}\n`);

  // ── Write updated fixture if --fix-fixture ───────────────────────────────────
  if (FIX_FIXTURE && updatedFixture) {
    const json = JSON.stringify(updatedFixture, null, 2)
      // Collapse single-entry objects to one line for readability (matches existing fixture style)
      .replace(/\{\n\s+"fires": false\n\s+\}/g, '{"fires":false}');
    fs.writeFileSync(FIXTURE_PATH, json, 'utf8');
    console.log(`  📝 Fixture updated: ${FIXTURE_PATH} (${failures.length} entries corrected)\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

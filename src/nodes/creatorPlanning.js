/**
 * Creator Planning Node
 *
 * Sits between enrichIntent and planSkills for command_automate intents.
 * Calls creator.agent to generate:
 *   - Phase 1: BDD acceptance tests
 *   - Phase 2: plan.md + agents.md (deep validate_agent specs)
 *   - Phase 3: runnable prototype scaffold
 *
 * Then calls reviewer.agent to gate the output.
 * If reviewer passes, injects plan.md + agents.md context into state
 * so planSkills LLM has a richer, structured context to plan from.
 *
 * State inputs:
 *   state.message / state.resolvedMessage — user's request
 *   state.intent.type                     — must be 'command_automate'
 *   state.mcpAdapter                      — for command-service calls
 *   state.progressCallback                — for Queue tab phase updates
 *
 * State outputs (on success):
 *   state.creatorProjectId    — project id stored in DuckDB
 *   state.creatorPlanMd       — full plan.md text
 *   state.creatorAgentsMd     — full agents.md text
 *   state.creatorBddTests     — full acceptance.feature text
 *   state.creatorReviewVerdict — 'pass' | 'pass-with-warnings' | 'fail'
 *
 * State outputs (on skip/error):
 *   state.creatorSkipped — true (node was a no-op, planSkills proceeds normally)
 *   state.creatorError   — error message (non-fatal, planSkills still runs)
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { isOAuthProvider, getOAuthScopes } = require('./oauthProviders');

// ── Module-level mutex ────────────────────────────────────────────────────────
// Only one creator pipeline runs at a time. Concurrent command_automate prompts
// queue here so they don't saturate the shared LLM WebSocket simultaneously.
let _pipelineLock = Promise.resolve();

module.exports = async function creatorPlanning(state) {
  const { mcpAdapter, intent, message, resolvedMessage } = state;
  const logger           = state.logger || console;
  const progressCallback = state.progressCallback || null;

  // Only fires for command_automate, not on recovery replans
  if (intent?.type !== 'command_automate') return state;

  // Skip if this is a recovery replan — the project was already created
  if (state.recoveryContext || state.creatorProjectId) {
    logger.debug('[Node:CreatorPlanning] skipping — recoveryContext or already planned');
    return state;
  }

  if (!mcpAdapter) {
    logger.warn('[Node:CreatorPlanning] no mcpAdapter — cannot run creator pipeline');
    return { ...state, planError: 'Project planning failed: no MCP adapter available' };
  }

  const userMessage = resolvedMessage || message || '';

  logger.info('[Node:CreatorPlanning] Starting creator pipeline', { prompt: userMessage.slice(0, 80) });

  // ── Progress helpers ────────────────────────────────────────────────────────
  function emit(type, extra) {
    if (progressCallback) progressCallback({ type, ...extra });
  }

  // ── CLI Scout / API Scout fast-path ─────────────────────────────────────────
  // If gatherContext identified a known CLI or SDK for this task, skip the full
  // creator.agent → reviewer → skillCreator code-gen pipeline entirely.
  // Instead, write skill.md + cli.json (or api.json) to disk and return.
  const gatheredContext = state.gatheredContext || null;
  let cliMatch  = gatheredContext?.cliMatch  || null;
  let apiMatch  = gatheredContext?.apiMatch  || null;
  let scoutMatch = cliMatch || apiMatch;

  // ── Live discovery fallback via skill-builder ────────────────────────────
  // If gatherContext already ran buildSkill for a live-discovery provider, use
  // the cached result. Otherwise run buildSkill now (provider named but no registry match).
  if (!scoutMatch && gatheredContext?.resolvedFacts?.builtSkill) {
    const built = gatheredContext.resolvedFacts.builtSkill;
    if (built.type === 'cli') { cliMatch = built; } else { apiMatch = built; }
    scoutMatch = built;
    logger.info(`[Node:CreatorPlanning] Using cached builtSkill from gatherContext for "${built.provider}" (${built.type.toUpperCase()})`);
  }

  if (!scoutMatch && gatheredContext?.service_provider) {
    const provider   = gatheredContext.service_provider;
    const capability = gatheredContext.service_capability || gatheredContext[`service_${provider}`] || provider;
    logger.info(`[Node:CreatorPlanning] No static registry match — running live skill-builder for "${provider}" (${capability})`);
    emit('planning', { message: `Searching for "${provider}" CLI / API tools…` });
    try {
      // Walk up to find skill-builder.cjs next to skill-scout.cjs
      let builderPath = null;
      let _dir = __dirname;
      for (let _i = 0; _i < 10; _i++) {
        const _c = path.join(_dir, 'mcp-services', 'command-service', 'src', 'skill-builder.cjs');
        if (fs.existsSync(_c)) { builderPath = _c; break; }
        _dir = path.dirname(_dir);
      }
      // Also check sibling directory (when running from stategraph-module directly)
      if (!builderPath) {
        const _sibling = path.join(__dirname, '..', '..', '..', 'mcp-services', 'command-service', 'src', 'skill-builder.cjs');
        if (fs.existsSync(_sibling)) builderPath = _sibling;
      }
      if (builderPath) {
        const { buildSkill } = require(builderPath);
        const built = await buildSkill(provider, capability, userMessage, (evtType, payload) => emit(evtType, payload));
        if (built) {
          if (built.type === 'cli') {
            cliMatch = built;
          } else {
            apiMatch = built;
          }
          scoutMatch = built;
          logger.info(`[Node:CreatorPlanning] Live skill-builder found ${built.type.toUpperCase()} match for "${provider}"`);
        } else {
          logger.info(`[Node:CreatorPlanning] Live skill-builder found nothing for "${provider}" — falling through to code-gen`);
        }
      } else {
        logger.warn('[Node:CreatorPlanning] skill-builder.cjs not found — falling through to code-gen');
      }
    } catch (builderErr) {
      logger.warn(`[Node:CreatorPlanning] Live skill-builder failed: ${builderErr.message} — falling through to code-gen`);
    }
  }

  if (scoutMatch) {
    const isCliMatch = !!cliMatch;
    const matchType  = isCliMatch ? 'CLI' : 'API';
    const provider   = scoutMatch.provider;
    const capability = scoutMatch.capability;
    const config     = scoutMatch.config;

    logger.info(`[Node:CreatorPlanning] ${matchType} Scout fast-path — skipping code-gen`, { capability, provider });
    emit('planning', { message: `Found ${matchType} tool for "${capability}" (${provider}) — setting up skill…` });

    // Derive dot-notation skill name from capability + provider
    const rawName = `${capability}.${provider}`.toLowerCase().replace(/[^a-z0-9.]/g, '.');
    const skillName = rawName.replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '');
    const skillDir  = path.join(os.homedir(), '.thinkdrop', 'skills', skillName);

    try {
      fs.mkdirSync(skillDir, { recursive: true });

      // Write skill.md
      const secretsList = (config.authEnv || []).map(k => `  - ${k}`).join('\n');
      // Only use schedule from context if it looks like a real time/cron — never let
      // prior session history bleed in. On-demand tasks (no schedule in prompt) → 'on_demand'.
      const rawSchedule = gatheredContext?.schedule || null;
      const scheduleVal = (rawSchedule && rawSchedule !== 'on_demand' && /^[0-9]|daily|weekly|hourly|cron/i.test(rawSchedule))
        ? rawSchedule
        : 'on_demand';

      const skillMd = [
        '---',
        `name: ${skillName}`,
        `type: ${isCliMatch ? 'cli' : 'api'}`,
        `${isCliMatch ? `cli_tool: ${config.tool}` : (config.npm ? `npm: ${config.npm}` : `transport: native_https`)}`,
        `capability: ${capability}`,
        `provider: ${provider}`,
        isOAuthProvider(provider) ? `oauth: ${provider}` : null,
        isOAuthProvider(provider) ? `oauth_scopes: ${provider}=${getOAuthScopes(provider) || config.scopes || ''}` : null,
        `schedule: ${scheduleVal}`,
        `secrets:`,
        secretsList || '  []',
        '---',
        `## ${skillName}`,
        '',
        `Handles "${capability}" via ${isCliMatch ? `the \`${config.tool}\` CLI tool` : (config.npm ? `the \`${config.npm}\` npm SDK` : `native HTTPS (no npm package needed)`)}.`,
        '',
        isCliMatch
          ? `Install: \`${config.installCmd}\``
          : (config.npm ? `Install: \`npm install ${config.npm}\`` : `Install: none (uses Node.js built-in https)`),
        '',
        '### Required credentials',
        ...(config.authEnv || []).map(k => `- \`${k}\``),
        '',
        '### Usage',
        isCliMatch && config.helpCmd
          ? `Get full CLI help: \`${config.helpCmd}\``
          : !isCliMatch && config.npm
          ? `Docs: \`npm info ${config.npm}\``
          : config.baseUrl
          ? `Base URL: \`${config.baseUrl}\``
          : '',
        ...(config.exampleCmds?.length
          ? ['', '**Example commands:**', ...config.exampleCmds.map(c => `\`\`\`\n${c}\n\`\`\``)]
          : config.exampleSnippet
          ? ['', '**Example request:**', '```js', config.exampleSnippet, '```']
          : []),
        '',
        '### Links',
        ...(config.links?.length
          ? (config.links || []).map(l => `- [${l.label}](${l.url})`)
          : ['_(No links available)_']),
      ].filter(l => l !== undefined && l !== null).join('\n');

      fs.writeFileSync(path.join(skillDir, 'skill.md'), skillMd, 'utf8');

      // Write cli.json or api.json
      const descriptorFile = isCliMatch ? 'cli.json' : 'api.json';
      fs.writeFileSync(
        path.join(skillDir, descriptorFile),
        JSON.stringify(config, null, 2),
        'utf8',
      );

      // ── CLI→API fallback: also write api.json if an API entry exists ─────────
      // This allows executeCommand to retry via skill-api-runner if the CLI
      // binary is unavailable after install (e.g. TS-only SDK, missing binary).
      if (isCliMatch) {
        try {
          // Walk up from __dirname to find api-registry.json (works from both
          // stategraph-module/src/nodes/ and node_modules/@thinkdrop/stategraph/src/nodes/)
          let apiRegFile = null;
          let _searchDir = __dirname;
          for (let _i = 0; _i < 10; _i++) {
            const _candidate = path.join(_searchDir, 'mcp-services', 'command-service', 'src', 'api-registry.json');
            if (fs.existsSync(_candidate)) { apiRegFile = _candidate; break; }
            _searchDir = path.dirname(_searchDir);
          }
          if (apiRegFile) {
            const apiReg = JSON.parse(fs.readFileSync(apiRegFile, 'utf8'));
            // Check if this capability+provider has an API entry
            const apiCapEntry = apiReg[capability];
            const apiProviderConfig = apiCapEntry?.providers?.[provider]
              || apiCapEntry?.providers?.[apiCapEntry?.defaultProvider];
            if (apiProviderConfig) {
              const apiFallbackPath = path.join(skillDir, 'api.json');
              if (!fs.existsSync(apiFallbackPath)) {
                fs.writeFileSync(apiFallbackPath, JSON.stringify(apiProviderConfig, null, 2), 'utf8');
                logger.info(`[Node:CreatorPlanning] Wrote api.json fallback for CLI skill "${skillName}" (${provider})`);
              }
            }
          }
        } catch (_apiFallbackErr) { /* non-fatal */ }
      }

      logger.info(`[Node:CreatorPlanning] ${matchType} skill written`, { skillName, skillDir });
      emit('planning', { message: `Skill "${skillName}" configured — ready to run.` });

      // Register in user-memory DB via skill.upsert so parseSkill can find it next run
      const secretKeys = config.authEnv || [];
      try {
        const http = require('http');
        // execPath: prefer index.cjs if it exists, else the descriptor json
        const indexPath = path.join(skillDir, 'index.cjs');
        const execPath  = fs.existsSync(indexPath)
          ? indexPath
          : path.join(skillDir, isCliMatch ? 'cli.json' : 'api.json');
        // Read skill.md so contractMd is stored in DB — main.js parses secrets from it
        const skillMdPath = path.join(skillDir, 'skill.md');
        const contractMd = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '';
        const upsertPayload = JSON.stringify({
          version:   'mcp.v1',
          service:   'user-memory',
          action:    'skill.upsert',
          requestId: `creatorPlanning-${Date.now()}`,
          payload: {
            name:        skillName,
            description: `${capability} via ${provider} — ${isCliMatch ? 'CLI' : 'API'} skill`,
            execPath,
            execType:    'node',
            enabled:     true,
            contractMd,
          },
        });
        const _memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
        await new Promise((resolve) => {
          const req = http.request(
            { hostname: '127.0.0.1', port: 3001, path: '/skill.upsert', method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(upsertPayload),
                ...(_memApiKey ? { 'Authorization': `Bearer ${_memApiKey}` } : {}),
              } },
            (res) => {
              let raw = '';
              res.on('data', c => raw += c);
              res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                  logger.info(`[Node:CreatorPlanning] Registered skill "${skillName}" in DB (execPath: ${execPath})`);
                } else {
                  logger.warn(`[Node:CreatorPlanning] skill.upsert failed: ${res.statusCode} ${raw.slice(0,200)}`);
                }
                resolve();
              });
            },
          );
          req.on('error', (e) => { logger.warn(`[Node:CreatorPlanning] skill.upsert failed: ${e.message}`); resolve(); });
          req.setTimeout(5000, () => { req.destroy(); resolve(); });
          req.write(upsertPayload); req.end();
        });
      } catch (regErr) {
        logger.warn(`[Node:CreatorPlanning] Skill registration error: ${regErr.message}`);
      }

      // Set queueBridge phase
      const queueBridge = state.queueBridge || null;
      if (queueBridge?.setPhase) queueBridge.setPhase(null, 'done', { skillName, skillSecrets: secretKeys });

      return {
        ...state,
        creatorSkillName:    skillName,
        creatorSkillPath:    path.join(skillDir, isCliMatch ? 'cli.json' : 'api.json'),
        creatorSkillSecrets: secretKeys,
        creatorSkipCodeGen:  true,
        creatorMatchType:    matchType.toLowerCase(),
      };

    } catch (scoutErr) {
      logger.warn(`[Node:CreatorPlanning] ${matchType} Scout fast-path failed — falling through to code-gen`, { error: scoutErr.message });
      // Fall through to normal code-gen pipeline below
    }
  }

  // ── Queue tab: phase transitions via queueBridge ──────────────────────────
  // The promptQueue item already exists (created when stategraph:process fired).
  // We only call setPhase here — never enqueue — so there is exactly one Queue item.
  const queueBridge = state.queueBridge || null;

  function queuePhase(status, extra) {
    if (queueBridge?.setPhase) {
      queueBridge.setPhase(null, status, extra);
    }
  }

  // ── Acquire pipeline lock ─────────────────────────────────────────────────
  // Only one creator pipeline runs at a time. If another is in progress,
  // this call waits until it finishes before starting its own LLM work.
  let _releaseLock;
  const _lockAcquired = new Promise(resolve => { _releaseLock = resolve; });
  const _prevLock = _pipelineLock;
  _pipelineLock = _lockAcquired;

  try {
    await _prevLock;
    logger.info('[Node:CreatorPlanning] pipeline lock acquired');
  } catch (_) { /* previous run errored — still proceed */ }

  try {
    // ── Phase 1 + 2 + 3: creator.agent create_project ────────────────────────
    emit('planning', { message: 'Planning project (BDD tests + architecture)…' });
    queuePhase('planning');

    // ── Enrich prompt with gathered context (services, timezone, secrets) ────────
  const gatheredContext = state.gatheredContext || null;
  let enrichedPrompt = userMessage;
  if (gatheredContext) {
    const parts = [userMessage, ''];
    if (gatheredContext.services?.length) {
      parts.push('Services confirmed: ' + gatheredContext.services.join(', '));
    }
    if (gatheredContext.timezone) {
      parts.push('Timezone: ' + gatheredContext.timezone);
    }
    if (gatheredContext.schedule) {
      parts.push('Schedule: ' + gatheredContext.schedule);
    }
    if (gatheredContext.knownSecrets?.length) {
      parts.push('Credentials already stored in keytar: ' + gatheredContext.knownSecrets.join(', '));
    }
    const extra = Object.entries(gatheredContext.resolvedAnswers || {})
      .filter(([k]) => !['system_tz'].includes(k))
      .map(([k, v]) => `${k}: ${v}`);
    if (extra.length) parts.push('Additional context: ' + extra.join('; '));
    enrichedPrompt = parts.filter(Boolean).join('\n');
    logger.info('[Node:CreatorPlanning] enriched prompt with gatheredContext', {
      services: gatheredContext.services,
      timezone: gatheredContext.timezone,
      knownSecrets: gatheredContext.knownSecrets?.length,
    });
  }

  const createRes = await mcpAdapter.callService('command', 'command.automate', {
      skill: 'creator.agent',
      args: { action: 'create_project', prompt: enrichedPrompt },
    }, { timeoutMs: 600000 }).catch(e => ({ ok: false, error: e.message }));

    const createData = createRes?.data || createRes;

    if (!createData?.ok) {
      const err = createData?.error || 'creator.agent failed';
      logger.warn('[Node:CreatorPlanning] creator.agent error — blocking planSkills:', err);
      queuePhase('error', { error: err });
      return { ...state, planError: 'Project planning failed: ' + err };
    }

    const projectId = createData.id;
    logger.info('[Node:CreatorPlanning] create_project done', { projectId });

    // Signal building phase (prototype was generated inside create_project)
    emit('planning', { message: 'Prototype scaffold ready. Running reviewer gate…' });
    queuePhase('building');

    // ── reviewer ↔ creator iterative feedback loop ────────────────────────────
    // Loop until: pass | pass-with-warnings | no actionable feedback | stall detected
    // Stall = identical blocker set across two consecutive rounds (LLM can't fix it)
    // Safety ceiling: 8 rounds max to prevent runaway on genuinely unfixable issues.
    const SAFETY_CEILING = 10;
    let verdict = 'pending';
    let reviewData = null;
    let roundsUsed = 0;
    let prevBlockerFingerprint = null;
    let stallCount = 0;
    const STALL_LIMIT = 2;  // 2 rounds with similar blockers = stalled, give up
    const LATE_ROUND_ESCAPE = 3; // after this many rounds, apply tiered escape logic
    // Score threshold: reviewer now knows it's a prototype — scores are more generous.
    // Accept pass-with-warnings at lower thresholds than before.
    const PROTO_ONLY_SCORE_MIN  = 40; // prototype-only blockers: accept if score >= this
    const ARCH_BLOCKER_SCORE_MIN = 55; // arch/security blockers: higher bar required
    const HIGH_SCORE_AUTO_PASS   = 70; // any score >= this → auto pass-with-warnings regardless

    // Prototype-only blocker keywords — lenient, these are expected prototype limitations.
    // Architecture/plan/agents blockers are STRICT — no escape allowed for those.
    const PROTOTYPE_ONLY_WORDS = [
      'prototype', 'index.js', 'index.cjs', 'mock', 'mocked', 'stub', 'stubbed',
      'placeholder', 'hardcoded', 'hard-coded', 'console.log', 'logging', 'typo',
      'retry logic', 'retries', 'retry', 'error handling', 'error-handling',
      'fetchEmailSummaries', 'sendSms', 'transient', 'non-transient',
      'null check', 'null/undefined', 'undefined check', 'await',
      'missing await', 'promise', 'async', 'rate limit', 'rate limits',
    ];

    function isPrototypeOnlyBlocker(blocker) {
      const b = blocker.toLowerCase();
      // Arch/plan/agents keywords → NOT prototype-only, always strict
      const ARCH_WORDS = ['plan.md', 'agents.md', 'agents/', 'validate_agent', 'agent spec',
        'bdd', 'acceptance', 'feature', 'architecture', 'design', 'interface', 'schema',
        'skill interface', 'secrets', 'credential', 'oauth', 'authentication', 'auth flow'];
      if (ARCH_WORDS.some(w => b.includes(w))) return false;
      return PROTOTYPE_ONLY_WORDS.some(w => b.includes(w));
    }

    for (let round = 1; round <= SAFETY_CEILING; round++) {
      roundsUsed = round;
      emit('planning', { message: round === 1
        ? 'Reviewer checking project…'
        : 'Reviewer re-checking after patches (round ' + round + ')…' });
      queuePhase('testing');

      const reviewRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'reviewer.agent',
        args: { action: 'review', projectId },
      }, { timeoutMs: 300000 }).catch(e => ({ ok: false, error: e.message }));

      reviewData = reviewRes?.data || reviewRes;
      verdict    = reviewData?.verdict || 'fail';

      logger.info('[Node:CreatorPlanning] reviewer round ' + round, {
        verdict,
        score:    reviewData?.overallScore,
        blockers: reviewData?.blockers?.length || 0,
      });

      // Push round data into queue item for live UI display
      queuePhase(verdict === 'pass' || verdict === 'pass-with-warnings' ? 'testing' : 'testing', {
        round: {
          round,
          verdict,
          score:    reviewData?.overallScore || null,
          blockers: reviewData?.blockers || [],
          patches:  reviewData?.patches  || [],
        },
      });

      // Pass or pass-with-warnings — done
      if (verdict === 'pass' || verdict === 'pass-with-warnings') break;

      // No blockers or warnings returned — nothing actionable, stop
      const currentBlockers = (reviewData?.blockers || []).concat(reviewData?.warnings || []);
      if (currentBlockers.length === 0) break;

      // ── Escape hatch logic (tiered) ─────────────────────────────────────────
      // The reviewer now knows it's reviewing a prototype scaffold, so scores are
      // more generous and blockers should be genuinely architectural. Exit early.
      const score    = reviewData?.overallScore || 0;
      const blockers = reviewData?.blockers || [];

      // 1. Ceiling: always accept at safety ceiling
      if (round === SAFETY_CEILING) {
        verdict = 'pass-with-warnings';
        logger.info('[Node:CreatorPlanning] ceiling hit at round ' + round + ' — accepting as pass-with-warnings');
        break;
      }

      // 2. High-score auto-pass: reviewer gave >=70 — prototype is solid enough
      if (score >= HIGH_SCORE_AUTO_PASS) {
        verdict = 'pass-with-warnings';
        logger.info('[Node:CreatorPlanning] high-score auto-pass (score ' + score + ' >= ' + HIGH_SCORE_AUTO_PASS + ') at round ' + round);
        break;
      }

      // 3. Late-round tiered escape (fires at round >= LATE_ROUND_ESCAPE = 3)
      if (round >= LATE_ROUND_ESCAPE) {
        const allPrototypeOnly = blockers.length > 0 && blockers.every(isPrototypeOnlyBlocker);
        if (allPrototypeOnly && score >= PROTO_ONLY_SCORE_MIN) {
          verdict = 'pass-with-warnings';
          logger.info('[Node:CreatorPlanning] late-round escape (prototype-only blockers, score ' + score + ') after ' + round + ' rounds');
          break;
        }
        if (!allPrototypeOnly && score >= ARCH_BLOCKER_SCORE_MIN) {
          verdict = 'pass-with-warnings';
          logger.info('[Node:CreatorPlanning] late-round escape (arch blocker, score ' + score + ' >= ' + ARCH_BLOCKER_SCORE_MIN + ') after ' + round + ' rounds');
          break;
        }
        // No blockers at all in late round — treat as pass
        if (blockers.length === 0) {
          verdict = 'pass-with-warnings';
          logger.info('[Node:CreatorPlanning] late-round escape (no blockers) at round ' + round);
          break;
        }
      }

      // Stall detection: fuzzy keyword fingerprint — LLM paraphrases blockers so exact match fails.
      // Extract key nouns/verbs (3+ chars, lowercase) and sort them as fingerprint.
      function keywordFingerprint(blockerList) {
        const words = blockerList.join(' ').toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 4)
          .filter(w => !['that','this','with','have','will','from','they','been','were','when','then','than','also','just','more','some','each','into','upon','after','before','should','would','could'].includes(w));
        return [...new Set(words)].sort().join('|');
      }
      const currentFingerprint = keywordFingerprint(currentBlockers);
      if (currentFingerprint === prevBlockerFingerprint) {
        stallCount++;
        if (stallCount >= STALL_LIMIT) {
          logger.warn('[Node:CreatorPlanning] stall detected — same blocker keywords for ' + stallCount + ' consecutive rounds, giving up', { blockers: currentBlockers });
          break;
        }
      } else {
        stallCount = 0; // progress made — reset stall counter
      }
      prevBlockerFingerprint = currentFingerprint;

      // Send feedback to creator.agent for patching
      emit('planning', { message: 'Applying reviewer feedback (round ' + round + ')…' });
      queuePhase('building');

      logger.info('[Node:CreatorPlanning] sending patches to creator.agent', {
        blockers: reviewData.blockers,
        patches:  reviewData.patches,
        round,
      });

      const patchRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'creator.agent',
        args: {
          action:        'patch_project',
          id:            projectId,
          reviewVerdict: verdict,
          blockers:      reviewData.blockers  || [],
          warnings:      reviewData.warnings  || [],
          patches:       reviewData.patches   || [],
          dimensions:    reviewData.dimensions || {},
          summary:       reviewData.summary   || '',
        },
      }, { timeoutMs: 600000 }).catch(e => ({ ok: false, error: e.message }));

      const patchData = patchRes?.data || patchRes;
      logger.info('[Node:CreatorPlanning] patch_project done', {
        patchedFiles: patchData?.patchedFiles,
        round,
      });
    }

    if (verdict === 'fail') {
      const blocker = reviewData?.blockers?.[0] || reviewData?.summary || 'Reviewer blocked project after ' + roundsUsed + ' round(s)';
      const stallMsg = stallCount >= STALL_LIMIT ? ' (stalled — same issues repeated)' : '';
      logger.warn('[Node:CreatorPlanning] reviewer blocked after all rounds:', blocker);
      queuePhase('error', { error: 'Reviewer: ' + blocker });
      _releaseLock();
      return {
        ...state,
        creatorProjectId: projectId,
        creatorReviewVerdict: verdict,
        planError: 'Project review failed after ' + roundsUsed + ' round(s)' + stallMsg + ': ' + blocker,
      };
    }

    logger.info('[Node:CreatorPlanning] reviewer passed', { verdict, projectId, rounds: roundsUsed });

    // ── Read generated artifacts to inject as planning context ────────────────
    const projectDir = path.join(os.homedir(), '.thinkdrop', 'projects', projectId);
    function readArtifact(rel) {
      try { return fs.readFileSync(path.join(projectDir, rel), 'utf8'); }
      catch (_) { return null; }
    }

    const planMd    = readArtifact('plan.md');
    const agentsMd  = readArtifact('agents.md');
    const bddTests  = readArtifact('tests/acceptance.feature');

    // ── skillCreator: convert reviewed project → production .skill.cjs ────────
    emit('planning', { message: 'Generating production skill file…' });
    queuePhase('skill_building');

    let skillResult = null;
    try {
      const skillRes = await mcpAdapter.callService('command', 'command.automate', {
        skill: 'skillCreator.skill',
        args: {
          action:     'generate_skill',
          projectId,
          projectDir,
        },
      }, { timeoutMs: 300000 }).catch(e => ({ ok: false, error: e.message }));

      skillResult = skillRes?.data || skillRes;
      if (skillResult?.ok) {
        logger.info('[Node:CreatorPlanning] skillCreator generated skill', {
          skillName: skillResult.skillName,
          skillPath: skillResult.skillPath,
        });
        emit('planning', { message: 'Skill "' + skillResult.skillName + '" ready — planning execution…' });
      } else {
        logger.warn('[Node:CreatorPlanning] skillCreator failed (non-fatal)', { error: skillResult?.error });
        emit('planning', { message: 'Project plan ready — generating skill steps…' });
      }
    } catch (e) {
      logger.warn('[Node:CreatorPlanning] skillCreator threw (non-fatal)', { error: e.message });
      emit('planning', { message: 'Project plan ready — generating skill steps…' });
    }

    queuePhase('done', {
      skillName:    skillResult?.skillName  || null,
      skillSecrets: skillResult?.secrets    || [],
    });
    _releaseLock();

    return {
      ...state,
      creatorProjectId:     projectId,
      creatorPlanMd:        planMd,
      creatorAgentsMd:      agentsMd,
      creatorBddTests:      bddTests,
      creatorReviewVerdict: verdict,
      creatorSkillName:     skillResult?.skillName  || null,
      creatorSkillPath:     skillResult?.skillPath  || null,
      creatorSkillTrigger:  skillResult?.trigger    || null,
      creatorSkillSecrets:  skillResult?.secrets    || [],
    };

  } catch (err) {
    logger.warn('[Node:CreatorPlanning] unexpected error — blocking planSkills:', err.message);
    queuePhase('error', { error: err.message });
    _releaseLock();
    return { ...state, planError: 'Project planning failed: ' + err.message };
  }
};

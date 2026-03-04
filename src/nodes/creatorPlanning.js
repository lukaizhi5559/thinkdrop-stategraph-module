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

  // ── Queue tab: enqueue item + broadcast phase transitions ───────────────────
  // The queueManager lives in main.js — we drive it via a dedicated IPC bridge
  // injected as state.queueBridge, or fall back to fire-and-forget HTTP.
  const queueBridge = state.queueBridge || null;
  let queueItemId = null;

  function queuePhase(status, extra) {
    if (queueBridge?.setPhase) {
      queueBridge.setPhase(queueItemId, status, extra);
    }
  }

  if (queueBridge?.enqueue) {
    queueItemId = queueBridge.enqueue(userMessage);
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
    const SAFETY_CEILING = 8;
    let verdict = 'pending';
    let reviewData = null;
    let roundsUsed = 0;
    let prevBlockerFingerprint = null;
    let stallCount = 0;
    const STALL_LIMIT = 2; // 2 rounds with similar blockers = stalled, give up
    const LATE_ROUND_ESCAPE = 5; // after this many rounds, accept score>=60 as pass-with-warnings

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

      // Late-round escape hatch: after LATE_ROUND_ESCAPE rounds, score>=60 = accept as pass-with-warnings
      // This prevents burning all 8 rounds on minor fixable issues the LLM keeps paraphrasing.
      if (round >= LATE_ROUND_ESCAPE && (reviewData?.overallScore || 0) >= 60) {
        verdict = 'pass-with-warnings';
        logger.info('[Node:CreatorPlanning] late-round escape: score ' + reviewData.overallScore + ' >= 60 after ' + round + ' rounds — accepting as pass-with-warnings');
        break;
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
    };

  } catch (err) {
    logger.warn('[Node:CreatorPlanning] unexpected error — blocking planSkills:', err.message);
    queuePhase('error', { error: err.message });
    _releaseLock();
    return { ...state, planError: 'Project planning failed: ' + err.message };
  }
};

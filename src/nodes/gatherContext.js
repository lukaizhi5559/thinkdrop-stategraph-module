/**
 * Gather Context Node
 *
 * Pre-flight agent that runs BEFORE creatorPlanning for command_automate intents.
 * Identifies missing information (services, credentials, timezone, schedule, etc.)
 * and conducts a back-and-forth Q&A with the user via the Queue tab before any
 * code is built.
 *
 * State inputs:
 *   state.message / state.resolvedMessage  — user's automation request
 *   state.intent.type                      — must be 'command_automate'
 *   state.llmBackend                       — for LLM analysis calls
 *   state.progressCallback                 — Queue tab event emitter
 *   state.gatherAnswerCallback             — async fn() that awaits user reply from StandalonePromptCapture
 *   state.gatherCredentialCallback         — async fn(key) that stores a secret in keytar and returns { stored: true }
 *   state.keytarCheckCallback              — async fn(key) → { found: boolean } checks keytar for existing key
 *   state.queueBridge                      — queue tab phase bridge
 *
 * State outputs:
 *   state.gatheredContext — {
 *     services: string[],
 *     timezone: string,
 *     schedule: string,
 *     resolvedFacts: Record<string, string>,
 *     knownSecrets: string[],       — keys confirmed stored in keytar
 *     links: { label, url }[],
 *     resolvedAnswers: Record<string, string>
 *   }
 *   state.gatherContextSkipped — true if node was a no-op
 */

const fs = require('fs');
const path = require('path');

const MAX_ROUNDS = 8;
const GATHER_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per answer

function loadSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/gather-context.md'), 'utf8').trim();
  } catch (_) {
    return null;
  }
}

module.exports = async function gatherContext(state) {
  const { intent, message, resolvedMessage, llmBackend, progressCallback,
    gatherAnswerCallback, gatherCredentialCallback, keytarCheckCallback } = state;

  const logger = state.logger || console;

  // Only fires for command_automate
  if (intent?.type !== 'command_automate') return state;

  // Skip on recovery replans — context was already gathered
  if (state.recoveryContext || state.gatheredContext || state.gatherContextSkipped) {
    logger.debug('[Node:GatherContext] skipping — already gathered or recovery replan');
    return state;
  }

  // Skip if no LLM backend or no answer callback — can't do back-and-forth
  if (!llmBackend) {
    logger.warn('[Node:GatherContext] no llmBackend — skipping context gathering');
    return { ...state, gatherContextSkipped: true };
  }

  const userMessage = resolvedMessage || message || '';
  const SYSTEM_PROMPT = loadSystemPrompt();

  if (!SYSTEM_PROMPT) {
    logger.warn('[Node:GatherContext] system prompt not found — skipping');
    return { ...state, gatherContextSkipped: true };
  }

  function emit(type, extra) {
    if (progressCallback) progressCallback({ type, ...extra });
  }

  logger.info('[Node:GatherContext] Starting context gathering', { prompt: userMessage.slice(0, 80) });

  // ── Get system timezone from OS ─────────────────────────────────────────────
  let systemTz = 'unknown';
  try {
    systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  } catch (_) {}

  // ── Build initial analysis prompt ───────────────────────────────────────────
  const analysisPrompt = [
    `User's automation request: "${userMessage}"`,
    '',
    `System context:`,
    `- OS timezone: ${systemTz}`,
    `- Platform: ${process.platform}`,
    '',
    'Analyze this request and return the structured JSON as described in your instructions.',
    'Be thorough — identify ALL unknowns before returning.',
  ].join('\n');

  // ── Conversation state ───────────────────────────────────────────────────────
  const resolvedFacts = { system_tz: systemTz };
  const resolvedAnswers = {};
  const knownSecrets = [];
  let links = [];
  let round = 0;

  emit('gather_start', { message: 'Gathering requirements before building…' });

  while (round < MAX_ROUNDS) {
    round++;
    logger.info(`[Node:GatherContext] Round ${round}`);

    // ── Build conversation context for LLM ────────────────────────────────────
    const contextSummary = Object.keys(resolvedAnswers).length > 0
      ? `\n\nAlready resolved:\n${Object.entries(resolvedAnswers).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : '';

    const roundPrompt = round === 1
      ? analysisPrompt
      : `${analysisPrompt}${contextSummary}\n\nContinue — identify remaining unknowns based on answers so far.`;

    // ── Call LLM ─────────────────────────────────────────────────────────────
    let raw;
    try {
      raw = await llmBackend.generateAnswer(SYSTEM_PROMPT, roundPrompt, { temperature: 0.1 });
    } catch (e) {
      logger.warn(`[Node:GatherContext] LLM call failed: ${e.message}`);
      break;
    }

    // ── Parse JSON from LLM ───────────────────────────────────────────────────
    let analysis;
    try {
      const text = (raw || '').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
      const start = text.indexOf('{');
      analysis = start !== -1 ? JSON.parse(text.slice(start)) : null;
    } catch (e) {
      logger.warn(`[Node:GatherContext] JSON parse failed: ${e.message}`);
      break;
    }

    if (!analysis) break;

    // Merge any new resolved facts from LLM
    if (analysis.resolvedFacts) {
      Object.assign(resolvedFacts, analysis.resolvedFacts);
    }
    if (analysis.links?.length) {
      links = [...links, ...analysis.links];
    }

    // ── If complete — no unknowns remain, proceed ─────────────────────────────
    if (analysis.complete) {
      logger.info('[Node:GatherContext] All context gathered — proceeding to build');
      emit('gather_complete', { message: 'All requirements gathered. Starting build…' });
      break;
    }

    // ── Process credential checks via keytar ─────────────────────────────────
    const credentialsToAsk = [];
    for (const cred of (analysis.credentials || [])) {
      if (!cred.credentialKey || knownSecrets.includes(cred.credentialKey)) continue;

      // Check keytar first
      let alreadyStored = false;
      if (keytarCheckCallback) {
        try {
          const check = await keytarCheckCallback(cred.credentialKey);
          alreadyStored = check?.found === true;
        } catch (_) {}
      }

      if (alreadyStored) {
        // Confirm with user before using existing credential
        emit('gather_confirm', {
          question: `I found existing credentials for \`${cred.credentialKey}\` in your secure keychain. Use those?`,
          credentialKey: cred.credentialKey,
          confirmId: `confirm_${cred.credentialKey}`,
        });

        if (gatherAnswerCallback) {
          try {
            const confirm = await Promise.race([
              gatherAnswerCallback(),
              new Promise(res => setTimeout(() => res('yes'), GATHER_TIMEOUT_MS)),
            ]);
            const accepted = /yes|yeah|sure|ok|y\b/i.test(confirm || 'yes');
            if (accepted) {
              knownSecrets.push(cred.credentialKey);
              resolvedAnswers[cred.credentialKey] = '[stored in keytar]';
              emit('gather_confirmed', { credentialKey: cred.credentialKey });
              continue;
            }
          } catch (_) {}
        } else {
          knownSecrets.push(cred.credentialKey);
          resolvedAnswers[cred.credentialKey] = '[stored in keytar]';
          continue;
        }
      }

      credentialsToAsk.push(cred);
    }

    // ── Ask each required credential one at a time ───────────────────────────
    for (const cred of credentialsToAsk) {
      if (!cred.required) continue;

      emit('gather_credential', {
        credentialKey: cred.credentialKey,
        question: cred.question,
        hint: cred.hint || null,
        helpUrl: cred.helpUrl || null,
      });

      if (gatherCredentialCallback) {
        try {
          const result = await Promise.race([
            gatherCredentialCallback(cred.credentialKey),
            new Promise(res => setTimeout(() => res(null), GATHER_TIMEOUT_MS)),
          ]);
          if (result?.stored) {
            knownSecrets.push(cred.credentialKey);
            resolvedAnswers[cred.credentialKey] = '[stored in keytar]';
            emit('gather_credential_stored', { credentialKey: cred.credentialKey });
          }
        } catch (e) {
          logger.warn(`[Node:GatherContext] Credential capture failed for ${cred.credentialKey}: ${e.message}`);
        }
      }
    }

    // ── Ask non-credential unknowns (one cluster at a time) ──────────────────
    const unresolvedUnknowns = (analysis.unknowns || []).filter(u =>
      u.required && !resolvedAnswers[u.id] && u.type !== 'credential'
    );

    if (unresolvedUnknowns.length === 0 && credentialsToAsk.filter(c => c.required).length === 0) {
      // Nothing left to ask — done
      emit('gather_complete', { message: 'All requirements gathered. Starting build…' });
      break;
    }

    for (const unknown of unresolvedUnknowns) {
      emit('gather_question', {
        id: unknown.id,
        question: unknown.question,
        hint: unknown.hint || null,
        type: unknown.type,
        options: unknown.options || null,
        links: links.filter(l => l),
      });

      if (!gatherAnswerCallback) {
        // No callback — can't block for user input, skip
        logger.warn(`[Node:GatherContext] No gatherAnswerCallback — skipping question "${unknown.id}"`);
        continue;
      }

      try {
        const answer = await Promise.race([
          gatherAnswerCallback(),
          new Promise(res => setTimeout(() => res(null), GATHER_TIMEOUT_MS)),
        ]);

        if (answer) {
          resolvedAnswers[unknown.id] = answer;
          resolvedFacts[unknown.id] = answer;
          emit('gather_answer_received', { id: unknown.id, answer });
          logger.info(`[Node:GatherContext] Answer received for "${unknown.id}": "${answer.slice(0, 60)}"`);
        } else {
          logger.warn(`[Node:GatherContext] Timed out waiting for answer to "${unknown.id}"`);
        }
      } catch (e) {
        logger.warn(`[Node:GatherContext] Answer callback threw: ${e.message}`);
      }
    }
  }

  // ── Build gatheredContext from resolved state ────────────────────────────────
  const services = Object.entries(resolvedFacts)
    .filter(([k]) => k.startsWith('service_'))
    .map(([, v]) => v)
    .filter(Boolean);

  const gatheredContext = {
    services,
    timezone: resolvedFacts.schedule_tz || resolvedFacts.system_tz || systemTz,
    schedule: resolvedFacts.schedule_time || resolvedFacts.schedule || null,
    resolvedFacts,
    resolvedAnswers,
    knownSecrets,
    links: [...new Map(links.map(l => [l.url, l])).values()],
  };

  logger.info('[Node:GatherContext] Context gathered', {
    services,
    timezone: gatheredContext.timezone,
    knownSecrets: knownSecrets.length,
    resolvedAnswers: Object.keys(resolvedAnswers).length,
  });

  return { ...state, gatheredContext };
};

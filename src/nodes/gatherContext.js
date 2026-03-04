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

/**
 * Pre-extract obvious facts from the user message before calling the LLM.
 * This prevents the LLM from asking questions the user already answered inline.
 */
function preExtractFacts(userMessage) {
  const facts = {};
  const msg = userMessage.toLowerCase();

  // Email service
  if (/\bgmail\b/.test(msg)) facts.service_email = 'gmail';
  else if (/\boutlook\b/.test(msg)) facts.service_email = 'outlook';
  else if (/\byahoo\s*mail\b/.test(msg)) facts.service_email = 'yahoo';
  else if (/\bicloud\s*mail\b/.test(msg)) facts.service_email = 'icloud';

  // SMS / messaging service
  if (/\btwilio\b/.test(msg)) facts.service_sms = 'twilio';
  else if (/\bimessage\b/.test(msg)) facts.service_sms = 'imessage';
  else if (/\bwhatsapp\b/.test(msg)) facts.service_sms = 'whatsapp';
  else if (/\btextbelt\b/.test(msg)) facts.service_sms = 'textbelt';
  else if (/\bclicksend\b/.test(msg)) facts.service_sms = 'clicksend';

  // Schedule time — "around 9", "at 9", "9pm", "9am", "9 at night" → HH:MM
  const timeMatch = msg.match(/\bat?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:at night|in the morning|in the evening)?/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];
    // Heuristics: "at night", "evening", or hour < 7 without am → assume pm
    const isNight = /night|evening/.test(msg);
    if (meridiem === 'pm' || (isNight && !meridiem && hour < 12)) {
      if (hour !== 12) hour += 12;
    } else if (meridiem === 'am' && hour === 12) {
      hour = 0;
    }
    facts.schedule_time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  // Schedule frequency
  if (/\bdaily\b/.test(msg)) facts.schedule_frequency = 'daily';
  else if (/\bweekly\b/.test(msg)) facts.schedule_frequency = 'weekly';
  else if (/\bhourly\b/.test(msg)) facts.schedule_frequency = 'hourly';

  // Timezone
  const tzPatterns = [
    [/\best\b|\beastern\b/, 'America/New_York'],
    [/\bcst\b|\bcentral\b/, 'America/Chicago'],
    [/\bmst\b|\bmountain\b/, 'America/Denver'],
    [/\bpst\b|\bpacific\b/, 'America/Los_Angeles'],
    [/\butc\b|\bgmt\b/, 'UTC'],
  ];
  for (const [re, tz] of tzPatterns) {
    if (re.test(msg)) { facts.schedule_tz = tz; break; }
  }

  return facts;
}

/**
 * Detect if an answer is a correction of a previously resolved fact.
 * Returns { correctedKey, correctedValue } or null.
 *
 * Handles patterns like:
 *  - "I'm not using Twilio, I want ClickSend"
 *  - "actually ClickSend"
 *  - "no, use SendGrid instead"
 *  - "not Twilio — ClickSend"
 *  - "I don't have Twilio, I'll use TextBelt"
 */
function parseCorrection(answer, resolvedFacts) {
  const text = answer.trim();
  const lower = text.toLowerCase();

  // Known service names to look for in corrections
  const SERVICE_NAMES = [
    'twilio', 'clicksend', 'textbelt', 'sendgrid', 'mailgun', 'messagebird',
    'textbase', 'vonage', 'bandwidth', 'plivo', 'gmail', 'outlook', 'yahoo',
    'icloud', 'imessage', 'whatsapp', 'slack', 'discord', 'telegram',
  ];

  // Is this answer a correction sentence? Look for negation + affirmation patterns.
  const isCorrectionPattern =
    /\b(not|don'?t|doesn'?t|no|isn'?t|never|won'?t)\b.*(use|using|have|want|need)/i.test(text) ||
    /\b(actually|instead|rather|i want|i'?ll use|i use|use)\b/i.test(text) ||
    /\bnot\s+\w+[,\s—\-]+/i.test(text);

  if (!isCorrectionPattern) return null;

  // Find which service is being affirmed (the one they WANT)
  // Strategy: find service names mentioned AFTER negation words, or after "use/want/actually"
  // The last service mentioned tends to be the affirmation
  const mentionedServices = SERVICE_NAMES.filter(s => lower.includes(s));
  if (mentionedServices.length === 0) return null;

  // Find the rejected service (if any) — appears near "not/don't/no"
  const rejectedService = SERVICE_NAMES.find(s => {
    const negPattern = new RegExp(`\\b(not|don'?t|no|isn'?t)\\b[^.]*\\b${s}\\b`, 'i');
    return negPattern.test(text);
  });

  // The affirmed service is the one NOT rejected, or the last one mentioned
  const affirmedService = mentionedServices.find(s => s !== rejectedService)
    || mentionedServices[mentionedServices.length - 1];

  if (!affirmedService) return null;

  // Find which resolved key this correction applies to
  // Match by comparing the rejected service to existing resolved values,
  // or by matching the key category (service_sms, service_email, etc.)
  let correctedKey = null;

  if (rejectedService) {
    // Find the key whose current value matches the rejected service
    correctedKey = Object.keys(resolvedFacts).find(k =>
      (resolvedFacts[k] || '').toLowerCase() === rejectedService
    );
  }

  // If no key found via rejection, guess from service type
  if (!correctedKey) {
    const emailServices = ['gmail', 'outlook', 'yahoo', 'icloud'];
    const smsServices = ['twilio', 'clicksend', 'textbelt', 'messagebird', 'textbase', 'vonage', 'bandwidth', 'plivo'];
    if (emailServices.includes(affirmedService)) correctedKey = 'service_email';
    else if (smsServices.includes(affirmedService)) correctedKey = 'service_sms';
  }

  if (!correctedKey) return null;

  return { correctedKey, correctedValue: affirmedService };
}

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

  // ── Pre-extract obvious facts from user message ───────────────────────────────
  const preExtracted = preExtractFacts(userMessage);
  if (Object.keys(preExtracted).length > 0) {
    logger.info('[Node:GatherContext] Pre-extracted facts from user message', preExtracted);
  }

  // ── Conversation state ───────────────────────────────────────────────────────
  const resolvedFacts = { system_tz: systemTz, ...preExtracted };
  const resolvedAnswers = { ...preExtracted }; // also in resolvedAnswers so LLM sees them as "already known"
  const knownSecrets = [];
  let links = [];
  let round = 0;

  emit('gather_start', { message: 'Gathering requirements before building…' });

  while (round < MAX_ROUNDS) {
    round++;
    logger.info(`[Node:GatherContext] Round ${round}`);

    // ── Build conversation context for LLM ────────────────────────────────────────────────────
    // Build a summary of ALL resolved facts (from LLM extraction + user answers).
    // ALWAYS include this — even on round 1 — so the LLM never re-asks about pre-extracted facts.
    const allResolved = { ...resolvedFacts, ...resolvedAnswers };
    const contextSummary = Object.keys(allResolved).length > 0
      ? `\n\nAlready known (do NOT ask about these — they are already resolved):\n${Object.entries(allResolved).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : '';

    // ── Build analysis prompt ─────────────────────────────────────────────────
    // The user's message IS the full task description — never ask them to repeat it.
    const analysisPrompt = [
      `User's automation request: "${userMessage}"`,
      '',
      `System context:`,
      `- OS timezone: ${systemTz}`,
      `- Platform: ${process.platform}`,
      '',
      'CRITICAL RULES:',
      '- The request above IS the complete task description. NEVER add "task_description" or "describe the task" as an unknown.',
      '- Extract every fact already stated in the request into resolvedFacts BEFORE deciding what to ask.',
      '- Do NOT ask about any service, time, or provider the user already named in their request.',
      '- Do NOT ask about anything listed in "Already known" below.',
      `${contextSummary}`,
      round === 1 ? '' : '\nContinue — only ask about what is still genuinely missing.',
    ].filter(l => l !== undefined).join('\n');

    // ── Call LLM ─────────────────────────────────────────────────────────────
    let raw;
    try {
      raw = await llmBackend.generateAnswer(SYSTEM_PROMPT, analysisPrompt, { temperature: 0.1 });
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

    // Merge LLM-inferred facts — but NEVER overwrite keys the user has already answered.
    // This prevents the LLM from hallucinating (e.g. service_sms: "iMessage") and
    // clobbering explicit user answers like "ClickSend".
    if (analysis.resolvedFacts) {
      for (const [k, v] of Object.entries(analysis.resolvedFacts)) {
        if (!resolvedAnswers[k]) {
          resolvedFacts[k] = v;
        }
      }
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
    // Build a set of confirmed service names (lowercase) from resolvedFacts so we can
    // gate credentials: only ask for credentials whose service has been chosen by the user.
    const confirmedServices = new Set(
      Object.entries({ ...resolvedFacts, ...resolvedAnswers })
        .filter(([k]) => k.startsWith('service_'))
        .map(([, v]) => (v || '').toLowerCase().trim())
        .filter(Boolean)
    );

    const credentialsToAsk = [];
    for (const cred of (analysis.credentials || [])) {
      if (!cred.credentialKey || knownSecrets.includes(cred.credentialKey)) continue;

      // Skip credentials tied to a service the user hasn't confirmed yet.
      // Detect the service name from the credentialKey (e.g. TWILIO_ACCOUNT_SID → twilio).
      // If the key contains a known service name that is NOT in confirmedServices, skip it.
      const keyLower = (cred.credentialKey || '').toLowerCase();
      const knownServiceNames = ['twilio', 'sendgrid', 'mailgun', 'clicksend', 'textbelt',
        'messagebird', 'textbase', 'vonage', 'bandwidth', 'plivo'];
      const credService = knownServiceNames.find(s => keyLower.includes(s));
      if (credService && confirmedServices.size > 0 && !confirmedServices.has(credService)) {
        logger.info(`[Node:GatherContext] Skipping credential ${cred.credentialKey} — service "${credService}" not confirmed by user`);
        continue;
      }

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
    // Client-side guard: drop any unknown the LLM should NEVER generate regardless of prompt compliance.
    // This catches hallucinated questions about things the user already stated in their request.
    const BANNED_UNKNOWN_IDS = new Set([
      'task_description', 'task_details', 'describe_task', 'automation_task',
      'specific_service_email', 'email_service', 'email_provider',
    ]);
    const allResolvedKeys = new Set(Object.keys({ ...resolvedFacts, ...resolvedAnswers }));
    const unresolvedUnknowns = (analysis.unknowns || []).filter(u => {
      if (!u.required || u.type === 'credential') return false;
      if (resolvedAnswers[u.id]) return false;           // already answered
      if (BANNED_UNKNOWN_IDS.has(u.id)) {
        logger.info(`[Node:GatherContext] Dropping banned unknown id "${u.id}"`);
        return false;
      }
      if (allResolvedKeys.has(u.id)) {
        logger.info(`[Node:GatherContext] Dropping unknown "${u.id}" — already in resolvedFacts`);
        return false;
      }
      return true;
    });

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
        inputType: unknown.type,
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
          // ── Correction detection ─────────────────────────────────────────────
          // Check if this answer is correcting a previously resolved fact
          // e.g. "I'm not using Twilio, I want ClickSend"
          const correction = parseCorrection(answer, { ...resolvedFacts, ...resolvedAnswers });
          if (correction) {
            const { correctedKey, correctedValue } = correction;
            const oldValue = resolvedFacts[correctedKey] || resolvedAnswers[correctedKey];
            resolvedFacts[correctedKey] = correctedValue;
            resolvedAnswers[correctedKey] = correctedValue;
            logger.info(`[Node:GatherContext] Correction applied: ${correctedKey} "${oldValue}" → "${correctedValue}"`);
            emit('gather_answer_received', { id: correctedKey, answer: correctedValue, corrected: true, previousValue: oldValue });
            // Also store the answer for the current question (use correctedValue as the answer)
            resolvedAnswers[unknown.id] = correctedValue;
            resolvedFacts[unknown.id] = correctedValue;
          } else {
            resolvedAnswers[unknown.id] = answer;
            resolvedFacts[unknown.id] = answer;
            emit('gather_answer_received', { id: unknown.id, answer });
          }
          logger.info(`[Node:GatherContext] Answer received for "${unknown.id}": "${answer.slice(0, 60)}"`);

          // ── Programmatic "Other" follow-up ─────────────────────────────────
          // If the user said "other" to a choice question, immediately ask what it is.
          if (/^other$/i.test(answer.trim()) && unknown.type === 'choice') {
            const followUpId = `${unknown.id}_other_specify`;
            const followUpQuestion = `You selected "Other" for ${unknown.question.replace(/\?$/, '')} — which specific service/tool do you use?`;
            emit('gather_question', {
              id: followUpId,
              question: followUpQuestion,
              hint: 'Type the name of the service or tool you use.',
              inputType: 'text',
              options: null,
              links: [],
            });
            if (gatherAnswerCallback) {
              try {
                const specifiedAnswer = await Promise.race([
                  gatherAnswerCallback(),
                  new Promise(res => setTimeout(() => res(null), GATHER_TIMEOUT_MS)),
                ]);
                if (specifiedAnswer) {
                  resolvedAnswers[unknown.id] = specifiedAnswer; // overwrite 'other' with real value
                  resolvedFacts[unknown.id] = specifiedAnswer;
                  resolvedAnswers[followUpId] = specifiedAnswer;
                  emit('gather_answer_received', { id: followUpId, answer: specifiedAnswer });
                  logger.info(`[Node:GatherContext] "Other" specified for "${unknown.id}": "${specifiedAnswer}"`);
                }
              } catch (e) {
                logger.warn(`[Node:GatherContext] Other follow-up threw: ${e.message}`);
              }
            }
          }
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

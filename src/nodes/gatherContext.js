/**
 * Gather Context Node
 *
 * Pre-flight agent that runs BEFORE creatorPlanning for command_automate intents.
 * Uses a TWO-PHASE LLM approach each round:
 *   Phase 1 — EXTRACTOR: reads user message, extracts every fact already stated
 *   Phase 2 — GAP ANALYST: given resolved facts, determines what is genuinely missing
 *
 * This eliminates brittle regex pre-extraction and leverages LLM natural language
 * understanding for both extraction and gap detection as separate focused tasks.
 *
 * State inputs:
 *   state.message / state.resolvedMessage  — user's automation request
 *   state.intent.type                      — must be 'command_automate'
 *   state.llmBackend                       — for LLM analysis calls
 *   state.progressCallback                 — Queue tab event emitter
 *   state.gatherAnswerCallback             — async fn() that awaits user reply from StandalonePromptCapture
 *   state.gatherCredentialCallback         — async fn(key) that stores a secret in keytar and returns { stored: true }
 *   state.keytarCheckCallback              — async fn(key) → { found: boolean } checks keytar for existing key
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

function loadPrompt(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts', filename), 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function parseJson(raw) {
  try {
    const text = (raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
    const start = text.indexOf('{');
    return start !== -1 ? JSON.parse(text.slice(start)) : null;
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

  if (!llmBackend) {
    logger.warn('[Node:GatherContext] no llmBackend — skipping context gathering');
    return { ...state, gatherContextSkipped: true };
  }

  const EXTRACT_PROMPT = loadPrompt('gather-extract.md');
  const GAPS_PROMPT    = loadPrompt('gather-gaps.md');

  if (!EXTRACT_PROMPT || !GAPS_PROMPT) {
    logger.warn('[Node:GatherContext] prompt files not found — skipping');
    return { ...state, gatherContextSkipped: true };
  }

  const userMessage = resolvedMessage || message || '';

  // ── CLASSIFIER: single LLM call — no regex, full natural language understanding ─
  // Decides EXECUTE (run now) vs BUILD (needs a persistent background skill).
  // Strong bias toward EXECUTE — BUILD is only for explicitly recurring/scheduled/
  // credential-backed integrations that cannot be done in a single browser session.
  const CLASSIFIER_SYS = `You are a task classifier for an AI automation assistant. Decide whether the user's request should be executed immediately (EXECUTE) or requires building a new persistent background skill (BUILD).

EXECUTE means: do it right now, in one run — browse, search, research, read, navigate, click, type, fill form, screenshot, scrape, download, compare prices, find information, save to file/folder, open apps, summarize, write reports, look up anything, answer questions, any one-time action regardless of complexity.

BUILD means: a NEW recurring background job that runs on a schedule without the user present — AND requires API credentials (like Twilio SID, Gmail OAuth, Slack bot token, Stripe key) that must be stored persistently.

Examples of EXECUTE (always EXECUTE, no matter how complex the task sounds):
- "Find all info about Jesus Christ and save to a folder on my desktop" → EXECUTE
- "Search for winter jackets on Amazon, Walmart and Target and compare prices" → EXECUTE
- "Go to Gmail and open my first email" → EXECUTE
- "Research the best laptops of 2025 and write a summary" → EXECUTE
- "Take a screenshot of apple.com" → EXECUTE
- "Look up the weather in New York and save it to a file" → EXECUTE
- "Find the CEO of Tesla and save the result to my desktop" → EXECUTE
- "Open YouTube and play a video" → EXECUTE
- "Fill in the contact form on acme.com" → EXECUTE
- "Summarize the top 5 news stories today" → EXECUTE

Examples of BUILD (only these narrow cases):
- "Send me a daily SMS summary of my Gmail at 9pm every night" → BUILD (recurring + Twilio/Gmail API credentials needed)
- "Every morning at 8am, post my calendar to Slack" → BUILD (recurring + Slack bot token needed)
- "Set up a webhook listener for Stripe payment events" → BUILD (background daemon + API credentials)
- "Text me my top 3 emails every weekday at 7am" → BUILD (recurring schedule + SMS API credentials)

Key rules:
1. If it can be done in a single browser/shell session → EXECUTE
2. Saving to a file or folder is always EXECUTE — even if the research is extensive
3. "Find info", "research", "look up", "summarize" are always EXECUTE
4. Only answer BUILD if the task is BOTH scheduled/recurring AND requires persistent API credentials
5. When in doubt → EXECUTE

Respond with ONLY valid JSON, no explanation, no markdown:
{"type":"EXECUTE"} or {"type":"BUILD"}`;

  // ── Hard validation gate: BUILD requires BOTH scheduling AND credential signals ─
  // The LLM classifier is unreliable — it sometimes hallucinates BUILD for plain
  // one-shot tasks. We validate any BUILD response against concrete textual signals
  // before trusting it. EXECUTE is the unconditional fallback.
  const SCHEDULE_SIGNALS = [
    /\bevery\s+(day|morning|night|evening|hour|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\bdaily\b/i, /\bnightly\b/i, /\bweekly\b/i, /\bhourly\b/i, /\bmonthly\b/i,
    /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
    /\bevery\s+\d+\s+(minutes?|hours?|days?)\b/i,
    /\bschedule\b/i, /\brecurring\b/i, /\bautomatically\s+(send|post|run|check)\b/i,
    /\bset\s+up\s+a\b/i,
    /\bwhenever\b/i, /\beach\s+time\b/i,
  ];
  const CREDENTIAL_SIGNALS = [
    /\bsms\b/i, /\btext\s+me\b/i, /\btwilio\b/i, /\bsendgrid\b/i, /\bmailgun\b/i,
    /\bslack\b/i, /\bdiscord\b/i, /\bwebhook\b/i, /\bstripe\b/i, /\bapi\s+key\b/i,
    /\boauth\b/i, /\bbot\s+token\b/i, /\bcalendar\s+api\b/i, /\bgmail\s+api\b/i,
    /\bnotify\s+me\b/i, /\bsend\s+me\s+a\s+(text|sms|message|notification)\b/i,
  ];

  function isBuildCandidate(text) {
    const hasSchedule = SCHEDULE_SIGNALS.some(r => r.test(text));
    const hasCredential = CREDENTIAL_SIGNALS.some(r => r.test(text));
    return hasSchedule && hasCredential;
  }

  let taskType = 'EXECUTE'; // strong default — only flip to BUILD if validated
  try {
    const classifyRaw = await llmBackend.generateAnswer(CLASSIFIER_SYS, `Task: "${userMessage}"`, { temperature: 0 });
    const classifyJson = parseJson(classifyRaw);
    if (classifyJson?.type === 'BUILD') {
      // Validate: only accept BUILD if the message has explicit schedule + credential signals
      if (isBuildCandidate(userMessage)) {
        taskType = 'BUILD';
        logger.info(`[Node:GatherContext] Task classifier → BUILD (validated) for: "${userMessage.slice(0, 80)}"`);
      } else {
        logger.info(`[Node:GatherContext] Task classifier said BUILD but no schedule+credential signals found — overriding to EXECUTE for: "${userMessage.slice(0, 80)}"`);
      }
    } else {
      logger.info(`[Node:GatherContext] Task classifier → EXECUTE for: "${userMessage.slice(0, 80)}"`);
    }
  } catch (e) {
    logger.warn(`[Node:GatherContext] Classifier failed (${e.message}) — defaulting to EXECUTE`);
  }

  if (taskType === 'EXECUTE') {
    logger.info('[Node:GatherContext] One-shot task — skipping gather, proceeding to plan');
    return { ...state, gatherContextSkipped: true };
  }

  // ── BUILD safety check: guard against duplicate skill creation ───────────────
  // parseSkill runs before gatherContext and normally catches existing skills.
  // But semantic matching can miss on unusual phrasing — if we reach BUILD here,
  // do a final check: if any installed skill plausibly covers this task, force
  // EXECUTE so planSkills can use the existing skill instead of rebuilding it.
  try {
    const mcpAdapter = state.mcpAdapter;
    if (mcpAdapter) {
      const result = await mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 3000 });
      const data = result?.data || result;
      const installedSkills = data?.results || [];
      const skillsWithDesc = installedSkills.filter(s => s.description || s.summary);

      if (skillsWithDesc.length > 0) {
        const skillMenu = skillsWithDesc
          .map(s => `- ${s.name}: ${(s.description || s.summary || '').slice(0, 120)}`)
          .join('\n');

        const DEDUP_SYS = `You are a skill-matching assistant. Given a user's request and a list of installed skills, determine if any installed skill already covers what the user wants — even partially or with different phrasing.

Return the exact skill name if there is a clear match, or null if no existing skill covers this request.
Only match if the skill's core purpose overlaps — same service, same type of action.
Respond with ONLY the skill name (e.g. "gmail.daily.summary") or the word null.`;

        const dedupPrompt = `User request: "${userMessage}"\n\nInstalled skills:\n${skillMenu}`;
        const dedupRaw = await Promise.race([
          llmBackend.generateAnswer(DEDUP_SYS, dedupPrompt, { temperature: 0 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('dedup timeout')), 5000)),
        ]);

        const candidate = (dedupRaw || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (candidate && candidate !== 'null') {
          const confirmed = installedSkills.find(s => s.name.toLowerCase() === candidate);
          if (confirmed) {
            logger.info(`[Node:GatherContext] BUILD blocked — existing skill "${confirmed.name}" covers this task. Forcing EXECUTE.`);
            return { ...state, gatherContextSkipped: true };
          }
        }
      }
    }
  } catch (e) {
    logger.warn(`[Node:GatherContext] Dedup skill check failed (${e.message}) — proceeding to BUILD`);
  }

  function emit(type, extra) {
    if (progressCallback) progressCallback({ type, ...extra });
  }

  logger.info('[Node:GatherContext] Starting context gathering', { prompt: userMessage.slice(0, 80) });

  // ── System timezone — always a hard-resolved fact, never asked ──────────────
  let systemTz = 'America/New_York';
  try {
    systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || systemTz;
  } catch (_) {}

  // ── Conversation state ───────────────────────────────────────────────────────
  // resolvedFacts: facts extracted by LLM from user message + system context
  // resolvedAnswers: facts confirmed/provided by user during Q&A
  const resolvedFacts  = { system_tz: systemTz, schedule_tz: systemTz };
  const resolvedAnswers = {};
  const knownSecrets   = [];
  let links = [];
  let round = 0;

  emit('gather_start', { message: 'Gathering requirements before building…' });

  while (round < MAX_ROUNDS) {
    round++;
    logger.info(`[Node:GatherContext] Round ${round}`);

    const allResolved = { ...resolvedFacts, ...resolvedAnswers };
    const resolvedSummary = Object.entries(allResolved)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    // ── PHASE 1: EXTRACTOR ────────────────────────────────────────────────────
    // Focused solely on extracting facts from the user message.
    // On round 1 it extracts everything. On later rounds it confirms nothing new remains.
    const extractPrompt = [
      `User's automation request: "${userMessage}"`,
      '',
      `System context:`,
      `- OS timezone: ${systemTz} (always use this as schedule_tz)`,
      `- Platform: ${process.platform}`,
      '',
      resolvedSummary ? `Already resolved (do NOT re-extract these):\n${resolvedSummary}` : '',
    ].filter(Boolean).join('\n');

    let extractRaw;
    try {
      extractRaw = await llmBackend.generateAnswer(EXTRACT_PROMPT, extractPrompt, { temperature: 0.1 });
    } catch (e) {
      logger.warn(`[Node:GatherContext] Phase 1 LLM call failed: ${e.message}`);
      break;
    }

    const extracted = parseJson(extractRaw);
    if (extracted?.resolvedFacts) {
      for (const [k, v] of Object.entries(extracted.resolvedFacts)) {
        // Never overwrite keys the user has explicitly answered
        if (!resolvedAnswers[k] && v) {
          resolvedFacts[k] = v;
          logger.info(`[Node:GatherContext] Phase 1 extracted: ${k} = ${v}`);
        }
      }
    }

    // ── PHASE 2: GAP ANALYST ──────────────────────────────────────────────────
    // Focused solely on identifying what is still genuinely missing.
    const allResolvedAfterExtract = { ...resolvedFacts, ...resolvedAnswers };
    const resolvedSummaryForGaps = Object.entries(allResolvedAfterExtract)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    const gapsPrompt = [
      `User's automation request: "${userMessage}"`,
      '',
      `Already resolved — do NOT ask about any of these:`,
      resolvedSummaryForGaps || '(none yet)',
      '',
      round === 1 ? '' : 'Continue — only identify what is still genuinely missing after user answers so far.',
    ].filter(l => l !== undefined).join('\n');

    let gapsRaw;
    try {
      gapsRaw = await llmBackend.generateAnswer(GAPS_PROMPT, gapsPrompt, { temperature: 0.1 });
    } catch (e) {
      logger.warn(`[Node:GatherContext] Phase 2 LLM call failed: ${e.message}`);
      break;
    }

    const analysis = parseJson(gapsRaw);
    if (!analysis) {
      logger.warn('[Node:GatherContext] Phase 2 JSON parse failed — ending gather');
      break;
    }

    if (analysis.links?.length) {
      links = [...links, ...analysis.links];
    }

    // ── If complete — no unknowns remain ──────────────────────────────────────
    if (analysis.complete) {
      logger.info('[Node:GatherContext] All context gathered — proceeding to build');
      emit('gather_complete', { message: 'All requirements gathered. Starting build…' });
      break;
    }

    // ── Process credential checks via keytar ──────────────────────────────────
    const confirmedServices = new Set(
      Object.entries(allResolvedAfterExtract)
        .filter(([k]) => k.startsWith('service_'))
        .map(([, v]) => (v || '').toLowerCase().trim())
        .filter(Boolean)
    );

    const credentialsToAsk = [];
    for (const cred of (analysis.credentials || [])) {
      if (!cred.credentialKey || knownSecrets.includes(cred.credentialKey)) continue;

      // Gate credentials behind confirmed service — don't ask for Twilio creds if user hasn't picked Twilio yet
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

    // ── Ask each required credential one at a time ────────────────────────────
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

    // ── Ask non-credential unknowns ───────────────────────────────────────────
    // Hard-ban list: things the gap analyst should never generate but we guard defensively
    const BANNED_UNKNOWN_IDS = new Set([
      'task_description', 'task_details', 'describe_task', 'automation_task',
      'specific_service_email', 'email_service', 'email_provider',
      'schedule_tz', 'timezone', 'user_timezone', 'time_zone',
    ]);
    // Dynamically ban IDs for facts already resolved
    const allResolvedKeys = new Set(Object.keys(allResolvedAfterExtract));
    // If schedule_time or schedule_frequency are resolved, ban their aliases too
    if (allResolvedKeys.has('schedule_time')) {
      ['schedule_time', 'time', 'run_time', 'execution_time'].forEach(k => BANNED_UNKNOWN_IDS.add(k));
    }
    if (allResolvedKeys.has('schedule_frequency')) {
      ['schedule_frequency', 'frequency'].forEach(k => BANNED_UNKNOWN_IDS.add(k));
    }

    const unresolvedUnknowns = (analysis.unknowns || []).filter(u => {
      if (!u.required || u.type === 'credential') return false;
      if (resolvedAnswers[u.id]) return false;
      if (BANNED_UNKNOWN_IDS.has(u.id)) {
        logger.info(`[Node:GatherContext] Dropping banned unknown "${u.id}"`);
        return false;
      }
      if (allResolvedKeys.has(u.id)) {
        logger.info(`[Node:GatherContext] Dropping unknown "${u.id}" — already resolved`);
        return false;
      }
      return true;
    });

    if (unresolvedUnknowns.length === 0 && credentialsToAsk.filter(c => c.required).length === 0) {
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
          resolvedFacts[unknown.id]   = answer;
          emit('gather_answer_received', { id: unknown.id, answer });
          logger.info(`[Node:GatherContext] Answer received for "${unknown.id}": "${String(answer).slice(0, 60)}"`);

          // ── "Other" follow-up ─────────────────────────────────────────────
          if (/^other$/i.test(String(answer).trim()) && unknown.type === 'choice') {
            const followUpId = `${unknown.id}_other_specify`;
            emit('gather_question', {
              id: followUpId,
              question: `You selected "Other" — which specific service or tool do you use?`,
              hint: 'Type the name of the service or tool.',
              inputType: 'text',
              options: null,
              links: [],
            });
            if (gatherAnswerCallback) {
              try {
                const specified = await Promise.race([
                  gatherAnswerCallback(),
                  new Promise(res => setTimeout(() => res(null), GATHER_TIMEOUT_MS)),
                ]);
                if (specified) {
                  resolvedAnswers[unknown.id] = specified;
                  resolvedFacts[unknown.id]   = specified;
                  resolvedAnswers[followUpId] = specified;
                  emit('gather_answer_received', { id: followUpId, answer: specified });
                  logger.info(`[Node:GatherContext] "Other" specified for "${unknown.id}": "${specified}"`);
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

  // ── Build gatheredContext output ─────────────────────────────────────────────
  const allFinal = { ...resolvedFacts, ...resolvedAnswers };
  const services = Object.entries(allFinal)
    .filter(([k]) => k.startsWith('service_'))
    .map(([, v]) => v)
    .filter(Boolean);

  const gatheredContext = {
    services,
    timezone: allFinal.schedule_tz || systemTz,
    schedule: allFinal.schedule_time || allFinal.schedule || null,
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

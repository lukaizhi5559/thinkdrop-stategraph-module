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

// ── User Memory & Personality Service Clients ──────────────────────────────────
const userMemory = require('../services/userMemoryClient');
const personality = require('../services/personalityClient');

const MAX_ROUNDS = 8;
const GATHER_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per answer

// ── CLI Scout & API Scout ─────────────────────────────────────────────────────
// Loaded lazily so gatherContext still works if command-service registries are absent.

function loadRegistry(filename) {
  // Walk up from __dirname to find the project root containing mcp-services.
  // Works from both stategraph-module/src/nodes/ and node_modules/@thinkdrop/stategraph/src/nodes/
  const candidates = [];
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'mcp-services', 'command-service', 'src', filename));
    dir = path.dirname(dir);
  }
  // Also check ~/.thinkdrop as a fallback for user-installed registries
  candidates.push(path.join(require('os').homedir(), '.thinkdrop', filename));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {}
  }
  return null;
}

/**
 * Scout a registry (CLI or API) for a match against confirmed services and the full message.
 * Returns the first matching capability entry + the winning provider config,
 * or null if nothing matches.
 *
 * @param {object} registry   parsed cli-registry.json or api-registry.json
 * @param {string[]} services confirmed service names from gatheredContext
 * @param {string} message    original user message (for keyword fallback)
 * @returns {{ capability: string, provider: string, config: object } | null}
 */

/**
 * Like scoutRegistry but ONLY matches explicit provider keys — no keyword/defaultProvider fallback.
 * Used to check if a user-chosen service (e.g. 'clicksend') exists as a provider in ANY capability
 * before falling back to keyword matching which might return a different defaultProvider.
 */
function scoutRegistryExplicitOnly(registry, services) {
  if (!registry || !services || services.length === 0) return null;
  const servicesLower = services.map(s => s.toLowerCase());
  for (const [capability, entry] of Object.entries(registry)) {
    const providers = entry.providers || {};
    for (const svc of servicesLower) {
      if (providers[svc]) {
        return { capability, provider: svc, config: providers[svc] };
      }
      const matchedKey = Object.keys(providers).find(k => svc.includes(k) || k.includes(svc));
      if (matchedKey) {
        return { capability, provider: matchedKey, config: providers[matchedKey] };
      }
    }
  }
  return null;
}

function scoutRegistry(registry, services, message) {
  if (!registry) return null;
  const msgLower = (message || '').toLowerCase();
  const servicesLower = (services || []).map(s => s.toLowerCase());

  for (const [capability, entry] of Object.entries(registry)) {
    const keywords = entry.keywords || [];
    const providers = entry.providers || {};

    // 1. Check if any confirmed service name matches a provider key
    for (const svc of servicesLower) {
      if (providers[svc]) {
        return { capability, provider: svc, config: providers[svc] };
      }
      // Partial match: provider key is substring of service or vice versa
      const matchedKey = Object.keys(providers).find(k => svc.includes(k) || k.includes(svc));
      if (matchedKey) {
        return { capability, provider: matchedKey, config: providers[matchedKey] };
      }
    }

    // 2. Keyword match against original message — use defaultProvider
    const kwMatch = keywords.some(kw => msgLower.includes(kw.toLowerCase()));
    if (kwMatch) {
      const defProvider = entry.defaultProvider;
      if (defProvider && providers[defProvider]) {
        return { capability, provider: defProvider, config: providers[defProvider] };
      }
      // First available provider
      const firstKey = Object.keys(providers)[0];
      if (firstKey) return { capability, provider: firstKey, config: providers[firstKey] };
    }
  }
  return null;
}

/**
 * Find the skill-scout.cjs path by walking up from __dirname.
 * Returns null if not found (dynamic discovery will be skipped gracefully).
 */
function findSkillScout() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'mcp-services', 'command-service', 'src', 'skill-scout.cjs');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Run CLI + API scouts and return { cliMatch, apiMatch } (either can be null).
 * Step 1: static registry lookup (fast, no I/O beyond file reads).
 * Step 2: if no match, dynamic discovery via skill-scout.cjs (npm/brew search + LLM).
 *
 * @param {string[]} services  confirmed service names (e.g. ['clicksend'])
 * @param {string}   message   original user message for keyword fallback
 * @param {object}   logger    logger instance
 * @returns {Promise<{ cliMatch: object|null, apiMatch: object|null }>}
 */
async function runScouts(services, message, logger) {
  const cliRegistry = loadRegistry('cli-registry.json');
  const apiRegistry = loadRegistry('api-registry.json');

  // ── Step 1: static registry ────────────────────────────────────────────────
  // Priority order:
  //   1a. Explicit provider key match in CLI registry (e.g. services=['twilio'] → cli sms/twilio)
  //   1b. Explicit provider key match in API registry (e.g. services=['clicksend'] → api sms/clicksend)
  //   1c. Keyword+defaultProvider fallback in CLI registry
  //   1d. Keyword+defaultProvider fallback in API registry
  // This ensures a user-chosen provider (e.g. 'clicksend') wins even when the
  // CLI registry has a different defaultProvider ('twilio') for the same capability.
  const cliExplicit = scoutRegistryExplicitOnly(cliRegistry, services);
  const apiExplicit = cliExplicit ? null : scoutRegistryExplicitOnly(apiRegistry, services);
  const explicitMatch = cliExplicit || apiExplicit;

  const cliMatch = explicitMatch
    ? (cliExplicit || null)
    : scoutRegistry(cliRegistry, services, message);
  const apiMatch = explicitMatch
    ? (apiExplicit || null)
    : (cliMatch ? null : scoutRegistry(apiRegistry, services, message));

  if (cliMatch || apiMatch) {
    // ── Step 1b: validate the static match is real before trusting it ────────
    // Runs npm info / brew info / which to confirm the package/tool exists.
    // If the tool is already installed, also fetches --help for richer context.
    // CLI→API fallback: if cliMatch fails validation, check apiRegistry for the
    // same provider before falling through to dynamic discovery.
    const scoutPath = findSkillScout();
    if (scoutPath) {
      try {
        const scout = require(scoutPath);
        if (scout.validateRegistryEntry) {
          const match = cliMatch || apiMatch;
          const type  = cliMatch ? 'cli' : 'api';
          const validation = await scout.validateRegistryEntry(type, match.config);
          if (!validation.valid) {
            logger.warn(`[Node:GatherContext] Static registry entry invalid (${match.provider}): ${validation.reason}`);

            // ── CLI→API static fallback ────────────────────────────────────
            // If the failing match was CLI, check if there's an API entry for
            // the same provider/capability before giving up to dynamic discovery.
            if (cliMatch) {
              const apiRegistry = loadRegistry('api-registry.json');
              const apiFallback = scoutRegistryExplicitOnly(apiRegistry, services)
                || scoutRegistry(apiRegistry, services, message);
              if (apiFallback) {
                const apiFallbackValidation = await scout.validateRegistryEntry('api', apiFallback.config);
                if (apiFallbackValidation.valid) {
                  logger.info(`[Node:GatherContext] CLI→API fallback: ${cliMatch.provider} CLI invalid → using API entry (${apiFallback.provider})`);
                  return { cliMatch: null, apiMatch: apiFallback };
                }
              }
            }
            logger.warn(`[Node:GatherContext] No valid fallback found — falling through to dynamic discovery`);
            // Invalidate and fall through to Step 2
          } else {
            logger.info(`[Node:GatherContext] Static registry entry verified (${match.provider}): ${validation.reason}`);
            if (validation.helpText) {
              match.config = { ...match.config, helpText: validation.helpText };
            }
            return { cliMatch, apiMatch };
          }
        } else {
          return { cliMatch, apiMatch };
        }
      } catch (e) {
        logger.warn(`[Node:GatherContext] Registry validation threw: ${e.message} — using static entry anyway`);
        return { cliMatch, apiMatch };
      }
    } else {
      return { cliMatch, apiMatch };
    }
  }

  // ── Step 2: dynamic discovery fallback ────────────────────────────────────
  // Only runs when the static registry has no match (or match failed validation).
  // Tries brew search, npm search, PATH check, and LLM validation to find a
  // suitable tool. Results are cached back to the registry for future runs.
  const scoutPath = findSkillScout();
  if (!scoutPath) {
    logger.debug('[Node:GatherContext] skill-scout.cjs not found — skipping dynamic discovery');
    return { cliMatch: null, apiMatch: null };
  }

  // Derive best service name to search: prefer explicit service answers, fall back to message
  const primaryService = (services && services.length > 0)
    ? services[0].toLowerCase().trim()
    : null;

  if (!primaryService) {
    return { cliMatch: null, apiMatch: null };
  }

  // Infer capability from the primary service name (best effort)
  const capability = primaryService;

  logger.info(`[Node:GatherContext] Static registry miss — running dynamic discovery for "${primaryService}"`);

  try {
    const scout = require(scoutPath);
    const { cliMatch: dynCli, apiMatch: dynApi } = await scout.discover(primaryService, capability);
    if (dynCli) logger.info(`[Node:GatherContext] Dynamic CLI discovery found: ${dynCli.provider} for "${primaryService}"`);
    if (dynApi) logger.info(`[Node:GatherContext] Dynamic API discovery found: ${dynApi.provider} for "${primaryService}"`);
    return { cliMatch: dynCli || null, apiMatch: dynApi || null };
  } catch (scoutErr) {
    logger.warn(`[Node:GatherContext] Dynamic discovery threw: ${scoutErr.message}`);
    return { cliMatch: null, apiMatch: null };
  }
}

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

// Providers that authenticate via OAuth rather than raw API keys.
// Loaded from shared constants — single source of truth for all nodes.
const { OAUTH_PROVIDERS } = require('./oauthProviders');


module.exports = async function gatherContext(state) {
  const { intent, message, resolvedMessage, llmBackend, progressCallback,
    gatherAnswerCallback, gatherCredentialCallback, keytarCheckCallback,
    gatherOAuthCallback } = state;

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

  // ── Explicit skill-build intent: user literally asks to create a skill ─────────
  // These phrases mean the user wants to BUILD a new persistent skill, regardless
  // of whether there are schedule or credential signals in the message.
  // Short-circuit to BUILD immediately — no LLM classifier needed.
  const SKILL_BUILD_INTENT_SIGNALS = [
    /\bi\s+need\s+a\s+skill\b/i,
    /\bbuild\s+(me\s+)?a\s+skill\b/i,
    /\bcreate\s+(me\s+)?a\s+skill\b/i,
    /\bmake\s+(me\s+)?a\s+skill\b/i,
    /\bset\s+up\s+a\s+skill\b/i,
    /\bwrite\s+(me\s+)?a\s+skill\b/i,
    /\bbuild\s+(me\s+)?a\s+new\s+skill\b/i,
    /\bcreate\s+(me\s+)?a\s+new\s+skill\b/i,
    /\bi\s+want\s+a\s+skill\b/i,
    /\bi\s+need\s+a\s+(new\s+)?skill\s+that\b/i,
    /\b(build|create|make|write)\s+(a\s+)?skill\s+that\b/i,
    /\b(build|create|make|write)\s+(a\s+)?skill\s+(for|to)\b/i,
  ];

  if (SKILL_BUILD_INTENT_SIGNALS.some(r => r.test(userMessage))) {
    logger.info(`[Node:GatherContext] Explicit skill-build intent detected — forcing BUILD mode for: "${userMessage.slice(0, 80)}"`);
    state = { ...state, forceSkillBuild: true }; // fall through to gather loop below
  }

  // ── Intelligent Agent Recommendation Engine ──────────────────────────────────
  // Uses user memory and personality data to make context-aware agent recommendations
  // instead of simple keyword matching which causes notification fatigue
  async function evaluateAgentRecommendation() {
    // Extract domain from user message
    const domainMatch = userMessage.match(/\b([a-z0-9-]+\.(?:com|org|net|io|co|ai|app))\b/i) ||
                       userMessage.match(/\b(?:goto|visit|open|on|at)\s+(?:the\s+)?([a-z0-9-]+)/i);
    const domain = domainMatch ? domainMatch[1] : null;
    
    if (!domain || state.agentRecommendationChecked) {
      return null;
    }
    
    try {
      // Query user memory for domain visit history
      const memories = await userMemory.searchByEntity(domain, 'domain');
      const visitStats = userMemory.calculateVisitFrequency(memories, domain);
      const taskSimilarity = userMemory.scoreTaskSimilarity(userMessage, memories);
      
      // Query personality profile for automation preferences
      const automationProfile = await personality.getAutomationProfile();
      const threshold = personality.getRecommendationThreshold(automationProfile);
      
      // Calculate recommendation score
      let score = 0;
      
      // Frequency factor (0-0.4) - most important
      if (visitStats.count >= 5) score += 0.4;
      else if (visitStats.count >= 3) score += 0.25;
      else if (visitStats.count >= 2) score += 0.1;
      
      // Task similarity (0-0.3)
      score += taskSimilarity * 0.3;
      
      // Recency bonus (0-0.2) - visited within last 7 days
      if (visitStats.daysSinceLast <= 7) score += 0.2;
      else if (visitStats.daysSinceLast <= 30) score += 0.1;
      
      // Pattern match bonus (0-0.1) - current prompt shows recurring intent
      const RECURRING_NEED_PATTERNS = [
        /\bi\s+(?:need|want)\s+to\s+(?:buy|shop|purchase|get|find|search|check|track|monitor)/i,
        /\bi\s+(?:always|often|frequently|regularly)\s+(?:buy|shop|visit|check)/i,
        /\bevery\s+(?:time|day|week|month)/i,
      ];
      if (RECURRING_NEED_PATTERNS.some(r => r.test(userMessage))) {
        score += 0.1;
      }
      
      const confidence = Math.min(score, 1.0);
      const shouldSuggest = personality.shouldShowSuggestion(automationProfile, confidence);
      
      logger.info(`[Node:GatherContext] Agent recommendation evaluated: domain=${domain}, visits=${visitStats.count}, confidence=${confidence.toFixed(2)}, threshold=${threshold.toFixed(2)}, suggest=${shouldSuggest}`);
      
      if (shouldSuggest && !state.suggestAgentBuild) {
        return {
          suggestAgentBuild: true,
          agentRecommendation: {
            domain,
            confidence,
            visitStats,
            taskSimilarity,
            reason: visitStats.count >= 3 
              ? `You've visited ${domain} ${visitStats.count} times recently for similar tasks`
              : `This looks like a recurring task on ${domain}`,
            automationPreference: automationProfile.automation_preference
          },
          agentRecommendationChecked: true
        };
      }
      
      return { agentRecommendationChecked: true };
    } catch (e) {
      logger.warn(`[Node:GatherContext] Agent recommendation evaluation failed: ${e.message}`);
      return { agentRecommendationChecked: true };
    }
  }
  
  // Run recommendation evaluation and update state
  const recommendationResult = await evaluateAgentRecommendation();
  if (recommendationResult) {
    state = { ...state, ...recommendationResult };
  }

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

  // forceSkillBuild is set by the router when matchedSkillName was a stub (no index.cjs).
  // The user is explicitly invoking a skill that needs to be built — skip the classifier.
  if (state.forceSkillBuild) {
    taskType = 'BUILD';
    logger.info(`[Node:GatherContext] forceSkillBuild=true (stub skill "${state.stubSkillName || 'unknown'}") — forcing BUILD mode, skipping classifier`);
  } else {
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
  }

  // ── Locate skill-builder.cjs (used by scout gate + upfront credential check) ──
  let builderPath = null;
  {
    let _bDir = __dirname;
    for (let _i = 0; _i < 10; _i++) {
      const _c = path.join(_bDir, 'mcp-services', 'command-service', 'src', 'skill-builder.cjs');
      if (fs.existsSync(_c)) { builderPath = _c; break; }
      _bDir = path.dirname(_bDir);
    }
    if (!builderPath) {
      const _s = path.join(__dirname, '..', '..', '..', 'mcp-services', 'command-service', 'src', 'skill-builder.cjs');
      if (fs.existsSync(_s)) builderPath = _s;
    }
  }

  // ── scoutProviderPreselect: provider chosen before Q&A loop (if multiple exist) ─
  let scoutProviderPreselect = null;

  if (taskType === 'EXECUTE') {
    // ── Scout gate: check if message matches a known capability (SMS, email, etc.)
    // If it does, this needs credentials + a persistent skill → upgrade to BUILD.
    // Then run skill-builder web-search discovery to find ALL provider options
    // before asking the user to pick — never auto-select from a static registry.
    const cliReg = loadRegistry('cli-registry.json');
    const apiReg = loadRegistry('api-registry.json');
    const quickCli = scoutRegistry(cliReg, [], userMessage);
    const quickApi = quickCli ? null : scoutRegistry(apiReg, [], userMessage);

    if (quickCli || quickApi) {
      // ── Early dedup guard: if an installed skill already covers this capability,
      // skip BUILD entirely — don't ask questions, don't discover providers.
      // This must run BEFORE any emit() calls so no UI cards are shown.
      try {
        const _mcpAdapter = state.mcpAdapter;
        if (_mcpAdapter) {
          const _res = await _mcpAdapter.callService('user-memory', 'skill.listNames', {}, { timeoutMs: 3000 });
          const _data = _res?.data || _res;
          const _installed = (_data?.results || []).filter(s => s.description || s.summary);
          if (_installed.length > 0) {
            const _match = (quickCli || quickApi);
            const _capabilityKeywords = [_match.capability, _match.provider].filter(Boolean).map(s => s.toLowerCase());
            const _coveringSkill = _installed.find(s => {
              const nm = (s.name || '').toLowerCase();
              const ds = (s.description || s.summary || '').toLowerCase();
              return _capabilityKeywords.some(kw => nm.includes(kw) || ds.includes(kw));
            });
            if (_coveringSkill) {
              logger.info(`[Node:GatherContext] Scout gate blocked — "${_coveringSkill.name}" already covers capability "${_match.capability}". Forcing EXECUTE.`);
              return { ...state, gatherContextSkipped: true };
            }
          }
        }
      } catch (_earlyDedupErr) {
        logger.warn(`[Node:GatherContext] Early dedup check failed (${_earlyDedupErr.message}) — proceeding`);
      }
      const match = quickCli || quickApi;
      taskType = 'BUILD';
      logger.info(`[Node:GatherContext] Scout gate: EXECUTE → BUILD for capability "${match.capability}"`);

      // ── Step 1: Prereq check via skill-builder ────────────────────────────
      emit('gather_start', { message: 'Checking prerequisites (node, npm, brew)…' });

      let prereqsOk = true;
      if (builderPath) {
        try {
          const { checkPrereqs } = require(builderPath);
          const prereqs = checkPrereqs();
          logger.info(`[Node:GatherContext] Prereqs: node=${prereqs.node} npm=${prereqs.npm} brew=${prereqs.brew}`);
          if (!prereqs.node || !prereqs.npm) {
            prereqsOk = false;
            logger.error('[Node:GatherContext] node or npm missing — cannot build skill');
          }
        } catch (e) {
          logger.warn(`[Node:GatherContext] Prereq check failed: ${e.message}`);
        }
      }

      if (!prereqsOk) {
        emit('gather_complete', { message: 'Cannot build skill: node.js or npm is not installed.' });
        return { ...state, gatherContextSkipped: true };
      }

      // ── Step 2: Build provider list (static first, web only if no static match) ──
      const cliCapEntry = cliReg?.[match.capability];
      const apiCapEntry = apiReg?.[match.capability];
      const staticProviders = [
        ...Object.keys(cliCapEntry?.providers || {}),
        ...Object.keys(apiCapEntry?.providers || {}),
      ];
      let allProviderNames = [...new Set(staticProviders)];

      // Only run web discovery if the static registry has NO providers for this capability.
      // Static entries (e.g. gh for github) are curated and should win without a web search.
      if (allProviderNames.length === 0 && builderPath) {
        emit('gather_start', { message: `Searching for the best ${match.capability} providers…` });
        try {
          const { discoverProviders } = require(builderPath);
          const discovered = await Promise.race([
            discoverProviders(match.capability, userMessage),
            new Promise(res => setTimeout(() => res([]), 20000)),
          ]);
          for (const p of (discovered || [])) {
            if (p.name && !allProviderNames.includes(p.name)) allProviderNames.push(p.name);
          }
          logger.info(`[Node:GatherContext] Provider list after web discovery: ${allProviderNames.join(', ')}`);
        } catch (e) {
          logger.warn(`[Node:GatherContext] discoverProviders failed: ${e.message} — using static list`);
        }
      } else if (allProviderNames.length > 0) {
        logger.info(`[Node:GatherContext] Using static providers: [${allProviderNames.join(', ')}] — skipping web discovery`);
      }

      // If user explicitly names a provider in the message, pre-select it
      const msgLower = userMessage.toLowerCase();
      const explicitMatch = allProviderNames.find(p => msgLower.includes(p) && p.length > 3);
      const defaultProvider = explicitMatch
        || cliCapEntry?.defaultProvider
        || apiCapEntry?.defaultProvider
        || allProviderNames[0];

      // Auto-select when only one provider exists — no need to ask the user
      const autoSelected = allProviderNames.length === 1 || !!explicitMatch;

      scoutProviderPreselect = {
        capability: match.capability,
        providers: allProviderNames,
        defaultProvider,
        registryType: (quickCli ? 'cli' : 'api'),
        autoSelected,
      };

      logger.info(`[Node:GatherContext] Provider choice: [${allProviderNames.join(', ')}] default="${defaultProvider}" autoSelected=${autoSelected}`);
    } else {
      logger.info('[Node:GatherContext] One-shot task — skipping gather, proceeding to plan');
      return { ...state, gatherContextSkipped: true };
    }
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

  // gather_start already emitted by scout gate for BUILD tasks; emit here only for BUILD tasks
  // that came directly (forceSkillBuild) without going through the scout gate's emit calls.
  if (taskType === 'BUILD' && !scoutProviderPreselect) {
    emit('gather_start', { message: 'Gathering requirements before building…' });
  }

  // ── Provider choice: ask upfront if multiple CLI/API providers are available ──
  // scoutProviderPreselect is set by the Scout gate above when it upgrades EXECUTE→BUILD.
  // If there are multiple providers, ask the user to pick before entering the Q&A loop.
  // The chosen provider is pre-seeded into resolvedFacts so the LLM never re-asks.
  if (scoutProviderPreselect && !scoutProviderPreselect.autoSelected) {
    const { capability, providers, defaultProvider } = scoutProviderPreselect;
    logger.info(`[Node:GatherContext] Provider choice: ${providers.length} options for "${capability}" — asking user`);
    emit('gather_question', {
      id: `service_${capability}`,
      question: `Which provider would you like to use for ${capability}?`,
      hint: `Recommended: ${defaultProvider}`,
      inputType: 'choice',
      options: providers,
      links: [],
    });
    if (gatherAnswerCallback) {
      try {
        const chosen = await Promise.race([
          gatherAnswerCallback(),
          new Promise(res => setTimeout(() => res(defaultProvider), GATHER_TIMEOUT_MS)),
        ]);
        const chosenProvider = (chosen || defaultProvider).toString().trim().toLowerCase();
        const validProvider = providers.find(p => p.toLowerCase() === chosenProvider) || defaultProvider;
        resolvedFacts[`service_${capability}`] = validProvider;
        resolvedFacts['service_provider'] = validProvider;
        emit('gather_answer_received', { id: `service_${capability}`, answer: validProvider });
        logger.info(`[Node:GatherContext] Provider chosen: "${validProvider}" for "${capability}"`);
      } catch (_) {
        resolvedFacts[`service_${capability}`] = defaultProvider;
        resolvedFacts['service_provider'] = defaultProvider;
        logger.info(`[Node:GatherContext] Provider choice timed out — defaulting to "${defaultProvider}"`);
      }
    } else {
      resolvedFacts[`service_${capability}`] = defaultProvider;
      resolvedFacts['service_provider'] = defaultProvider;
    }
  } else if (scoutProviderPreselect?.autoSelected) {
    // Single provider — pre-seed silently so LLM extractor doesn't ask about it
    resolvedFacts[`service_${scoutProviderPreselect.capability}`] = scoutProviderPreselect.defaultProvider;
    resolvedFacts['service_provider'] = scoutProviderPreselect.defaultProvider;
    logger.info(`[Node:GatherContext] Provider auto-selected: "${scoutProviderPreselect.defaultProvider}" for "${scoutProviderPreselect.capability}"`);
  }
  // ── End provider choice ──────────────────────────────────────────────────────

  // ── Upfront credential check: ask for provider authEnv keys before LLM loop ──
  // Once the provider is known, look up its required credentials.
  // For static registry providers: use the registry config directly.
  // For live-discovery providers: call buildSkill() now to get full config,
  // then cache it in resolvedFacts['builtSkill'] so creatorPlanning doesn't re-discover.
  {
    const chosenProvider = resolvedFacts['service_provider'] || resolvedFacts[`service_${scoutProviderPreselect?.capability}`];
    if (chosenProvider && scoutProviderPreselect) {
      const { capability } = scoutProviderPreselect;
      const cliReg  = loadRegistry('cli-registry.json');
      const apiReg  = loadRegistry('api-registry.json');
      let providerConfig =
        cliReg?.[capability]?.providers?.[chosenProvider] ||
        apiReg?.[capability]?.providers?.[chosenProvider] || null;

      // ── Live-discovery: provider not in static registry → run buildSkill now ──
      if (!providerConfig && builderPath) {
        try {
          emit('gather_start', { message: `Researching ${chosenProvider} ${capability} API…` });
          const { buildSkill } = require(builderPath);
          const builtSkill = await Promise.race([
            buildSkill(chosenProvider, capability, userMessage, (evtType, payload) => emit(evtType, payload)),
            new Promise(res => setTimeout(() => res(null), 30000)),
          ]);
          if (builtSkill) {
            providerConfig = builtSkill.config;
            resolvedFacts['builtSkill'] = builtSkill;
            logger.info(`[Node:GatherContext] Live buildSkill for "${chosenProvider}": type=${builtSkill.type} authEnv=${(builtSkill.config?.authEnv || []).join(',')}`);
          } else {
            logger.warn(`[Node:GatherContext] buildSkill returned null for "${chosenProvider}" — credentials unknown`);
          }
        } catch (e) {
          logger.warn(`[Node:GatherContext] Live buildSkill failed: ${e.message}`);
        }
      }

      const authEnvKeys = providerConfig?.authEnv || [];

      // ── OAuth provider: use gather_oauth instead of raw credential prompts ────
      // If the chosen provider authenticates via OAuth (GitHub, Microsoft, Google, etc.),
      // emit a gather_oauth event so the UI shows a Connect button in the Queue tab.
      // The OAuth token lands in keytar under oauth:<provider>:<skillName> automatically.
      if (OAUTH_PROVIDERS.has(chosenProvider)) {
        const oauthTokenKey = `oauth:${chosenProvider}:${state.creatorSkillName || chosenProvider}`;
        const globalTokenKey = `oauth:${chosenProvider}`;
        let alreadyConnected = false;
        let usedGlobalKey = globalTokenKey;
        if (keytarCheckCallback) {
          try {
            // Check global Connections-tab token first (oauth:<provider>)
            const globalCheck = await keytarCheckCallback(globalTokenKey);
            if (globalCheck?.found === true) {
              alreadyConnected = true;
            } else {
              // Fall back to per-skill token
              const check = await keytarCheckCallback(oauthTokenKey);
              alreadyConnected = check?.found === true;
              usedGlobalKey = oauthTokenKey;
            }
          } catch (_) {}
        }
        if (alreadyConnected) {
          knownSecrets.push(oauthTokenKey);
          resolvedAnswers['oauth_token'] = '[connected via OAuth]';
          logger.info(`[Node:GatherContext] ${chosenProvider} OAuth already connected — skipping`);
        } else {
          logger.info(`[Node:GatherContext] Prompting OAuth connect for provider: ${chosenProvider}`);
          emit('gather_oauth', {
            provider: chosenProvider,
            tokenKey: oauthTokenKey,
            scopes: providerConfig?.scopes || '',
            skillName: state.creatorSkillName || chosenProvider,
          });
          if (gatherOAuthCallback) {
            try {
              const result = await Promise.race([
                gatherOAuthCallback(chosenProvider, oauthTokenKey),
                new Promise(res => setTimeout(() => res(null), GATHER_TIMEOUT_MS)),
              ]);
              if (result?.connected) {
                knownSecrets.push(oauthTokenKey);
                resolvedAnswers['oauth_token'] = '[connected via OAuth]';
                emit('gather_oauth_connected', { provider: chosenProvider, tokenKey: oauthTokenKey });
                logger.info(`[Node:GatherContext] ${chosenProvider} OAuth connected successfully`);
              } else {
                logger.warn(`[Node:GatherContext] ${chosenProvider} OAuth connect timed out or was skipped`);
              }
            } catch (e) {
              logger.warn(`[Node:GatherContext] OAuth callback threw: ${e.message}`);
            }
          }
        }
      } else if (authEnvKeys.length > 0) {
        logger.info(`[Node:GatherContext] Upfront credential check for ${chosenProvider}: ${authEnvKeys.join(', ')}`);

        for (const key of authEnvKeys) {
          if (knownSecrets.includes(key)) continue;

          // Check keytar
          let alreadyStored = false;
          if (keytarCheckCallback) {
            try {
              const check = await keytarCheckCallback(key);
              alreadyStored = check?.found === true;
            } catch (_) {}
          }

          if (alreadyStored) {
            knownSecrets.push(key);
            resolvedAnswers[key] = '[stored in keytar]';
            logger.info(`[Node:GatherContext] Upfront cred: ${key} already in keytar — skipping`);
          } else {
            // Ask user to provide it now
            emit('gather_credential', {
              credentialKey: key,
              question: `Please enter your ${key} for ${chosenProvider}`,
              hint: `Required to use the ${chosenProvider} ${capability} API`,
              helpUrl: providerConfig?.links?.[0]?.url || null,
            });
            if (gatherCredentialCallback) {
              try {
                const result = await Promise.race([
                  gatherCredentialCallback(key),
                  new Promise(res => setTimeout(() => res(null), GATHER_TIMEOUT_MS)),
                ]);
                if (result?.stored) {
                  knownSecrets.push(key);
                  resolvedAnswers[key] = '[stored in keytar]';
                  emit('gather_credential_stored', { credentialKey: key });
                  logger.info(`[Node:GatherContext] Upfront cred: ${key} stored`);
                }
              } catch (e) {
                logger.warn(`[Node:GatherContext] Upfront credential capture failed for ${key}: ${e.message}`);
              }
            }
          }
        }

        // Pre-seed resolved facts so LLM Q&A loop never re-asks about credentials
        for (const key of authEnvKeys) {
          if (knownSecrets.includes(key) && !resolvedAnswers[key]) {
            resolvedAnswers[key] = '[stored in keytar]';
          }
        }
      } // end non-OAuth credential block
    }
  }
  // ── End upfront credential check ─────────────────────────────────────────────

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
    
    // Build comprehensive context from resolveUserContext
    const selfContext = state.resolvedSelfContext || {};
    const smsTarget = state.smsGatewayTarget || null;
    
    let contextInfo = [
      `System context:`,
      `- OS timezone: ${systemTz} (always use this as schedule_tz)`,
      `- Platform: ${process.platform}`,
    ];
    
    // Add self context information
    if (selfContext.email) {
      contextInfo.push(`- User email: ${selfContext.email}`);
    }
    if (selfContext.phone) {
      contextInfo.push(`- User phone: ${selfContext.phone}`);
    }
    
    // Add SMS target information
    if (smsTarget) {
      contextInfo.push(`- SMS target: ${smsTarget.name} (${smsTarget.phone})`);
    }
    
    // Add memory context
    if (selfContext.memories?.context?.length > 0) {
      contextInfo.push(`- User memories: ${selfContext.memories.context.slice(0, 3).join('; ')}`);
    }
    
    // Add conversation context
    if (selfContext.conversation?.context?.length > 0) {
      contextInfo.push(`- Recent conversation context: ${selfContext.conversation.context.slice(0, 2).join('; ')}`);
    }
    
    const extractPrompt = [
      `User's automation request: "${userMessage}"`,
      '',
      ...contextInfo,
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
      // Schedule keywords — only honour schedule extraction if the current prompt
      // actually mentions scheduling. Otherwise Phase 1 hallucinates them from
      // conversation history (e.g. a previous "every day at 9pm" bleeds in).
      const promptMentionsSchedule = /\b(every|daily|weekly|hourly|at \d|schedule|cron|remind|morning|evening|tonight|tomorrow|each day|each week)\b/i.test(userMessage);
      // When the scout gate already determined a capability, any service_* extraction
      // that names a DIFFERENT capability is a hallucination (e.g. LLM sees "twilio"
      // in repo code and emits service_sms=twilio even though task is github PR review).
      // Drop it here so it never pollutes resolvedFacts or scoutServices.
      const gateCapabilityForExtract = scoutProviderPreselect?.capability?.toLowerCase() || null;

      for (const [k, v] of Object.entries(extracted.resolvedFacts)) {
        // Never overwrite keys the user has explicitly answered
        if (resolvedAnswers[k] || !v) continue;
        // Drop schedule fields if prompt has no scheduling intent
        if (!promptMentionsSchedule && (k === 'schedule_time' || k === 'schedule_frequency' || k === 'schedule_tz')) continue;
        // Drop service_* facts that contradict the scout gate's capability.
        // e.g. gate=github → drop service_sms=twilio, service_email=gmail, etc.
        if (gateCapabilityForExtract && k.startsWith('service_') && k !== 'service_provider' && k !== 'service_capability') {
          const extractedVal = (v || '').toLowerCase();
          // Allow only if the extracted value aligns with the gate capability
          if (!extractedVal.includes(gateCapabilityForExtract) && !gateCapabilityForExtract.includes(extractedVal)) {
            logger.info(`[Node:GatherContext] Dropping "${k}=${v}" — scout gate capability is "${gateCapabilityForExtract}"`);
            continue;
          }
        }
        resolvedFacts[k] = v;
        logger.info(`[Node:GatherContext] Phase 1 extracted: ${k} = ${v}`);
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
      ...contextInfo,
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

    // ── Process credential checks via keytar ──────────────────────────────────
    // IMPORTANT: credentials are processed BEFORE the complete check so that
    // a complete:true response doesn't skip credential collection entirely.
    const confirmedServices = new Set(
      Object.entries(allResolvedAfterExtract)
        .filter(([k]) => k.startsWith('service_'))
        .map(([, v]) => (v || '').toLowerCase().trim())
        .filter(Boolean)
    );
    logger.debug(`[Node:GatherContext] confirmedServices: [${[...confirmedServices].join(', ')}]`);

    const credentialsToAsk = [];
    // Capability set by the scout gate — only ask for credentials relevant to it.
    const gateCapForCreds = scoutProviderPreselect?.capability?.toLowerCase() || null;

    for (const cred of (analysis.credentials || [])) {
      if (!cred.credentialKey || knownSecrets.includes(cred.credentialKey)) continue;

      // If the scout gate established a specific capability (e.g. 'github'), drop any
      // credential whose key name doesn't relate to that capability.
      // This prevents RECIPIENT_PHONE_NUMBER / TWILIO_* stored from old runs from
      // surfacing even via the "found in keychain — use those?" path.
      if (gateCapForCreds) {
        const keyLower = (cred.credentialKey || '').toLowerCase();
        if (!keyLower.includes(gateCapForCreds)) {
          logger.info(`[Node:GatherContext] Dropping credential "${cred.credentialKey}" — unrelated to gate capability "${gateCapForCreds}"`);
          continue;
        }
      }

      // Legacy service gate — don't ask for Twilio creds if user hasn't confirmed Twilio
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

    // ── If no gatherAnswerCallback and there are still unknowns, exit the loop ──
    // Prevents infinite 8-round cycling when the callback is not wired (e.g. recovery path).
    if (!gatherAnswerCallback && unresolvedUnknowns.length > 0) {
      logger.warn(`[Node:GatherContext] No gatherAnswerCallback and ${unresolvedUnknowns.length} unresolved unknowns — breaking loop`);
      break;
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

    // ── Complete check: exit only after credentials and unknowns are both settled ──
    // analysis.complete from the LLM is advisory — we also check ourselves whether
    // any required items remain (the LLM may wrongly set complete:true before creds).
    const hasUnresolvedCreds = credentialsToAsk.filter(c => c.required).length > 0;
    if (unresolvedUnknowns.length === 0 && !hasUnresolvedCreds) {
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

  // ── CLI Scout + API Scout ────────────────────────────────────────────────────
  // Match confirmed services (and message keywords) against registries.
  // CLI takes priority; API Scout only runs if no CLI match found.
  //
  // IMPORTANT: If the user explicitly chose a provider and buildSkill already ran
  // for that provider (builtSkill cached in resolvedFacts), skip runScouts entirely.
  // Running runScouts would let a keyword-based registry match (e.g. Twilio on PATH)
  // override the user's explicit choice.
  const chosenProvider = allFinal['service_provider'] || null;
  const cachedBuiltSkill = resolvedFacts['builtSkill'] || null;

  let cliMatch = null;
  let apiMatch = null;

  if (cachedBuiltSkill) {
    // User picked a live-discovery provider — use the cached buildSkill result directly
    if (cachedBuiltSkill.type === 'cli') {
      cliMatch = cachedBuiltSkill;
      logger.info(`[Node:GatherContext] Using cached builtSkill (CLI) for "${cachedBuiltSkill.provider}" — skipping runScouts`);
    } else {
      apiMatch = cachedBuiltSkill;
      logger.info(`[Node:GatherContext] Using cached builtSkill (API) for "${cachedBuiltSkill.provider}" — skipping runScouts`);
    }
  } else {
    // CRITICAL: if the scout gate established a specific capability (e.g. 'github'),
    // only search for the chosen provider within that capability.
    // Never let other service_* extractions from resolvedFacts (e.g. 'twilio' extracted
    // from PR code) leak into scoutServices and hijack the match.
    const gateCapability = scoutProviderPreselect?.capability || null;
    const scoutServices = gateCapability
      ? (chosenProvider ? [chosenProvider] : services.filter(s =>
          s === gateCapability || s === chosenProvider
        ))
      : (chosenProvider
          ? [chosenProvider, ...services.filter(s => s !== chosenProvider)]
          : services);
    logger.info(`[Node:GatherContext] runScouts with: [${scoutServices.join(', ')}] (gateCapability=${gateCapability})`);
    const scoutResult = await runScouts(scoutServices, userMessage, logger);
    cliMatch = scoutResult.cliMatch;
    apiMatch = scoutResult.apiMatch;
    if (cliMatch) {
      logger.info(`[Node:GatherContext] CLI Scout matched: capability="${cliMatch.capability}" provider="${cliMatch.provider}" tool="${cliMatch.config?.tool}"`);
    } else if (apiMatch) {
      logger.info(`[Node:GatherContext] API Scout matched: capability="${apiMatch.capability}" provider="${apiMatch.provider}" npm="${apiMatch.config?.npm}"`);
    } else {
      logger.info('[Node:GatherContext] No CLI/API Scout match — will use code-gen path');
    }
  }

  const gatheredContext = {
    services,
    timezone: allFinal.schedule_tz || systemTz,
    schedule: allFinal.schedule_time || allFinal.schedule || null,
    resolvedFacts,
    resolvedAnswers,
    knownSecrets,
    links: [...new Map(links.map(l => [l.url, l])).values()],
    cliMatch:  cliMatch  || null,
    apiMatch:  apiMatch  || null,
    // Top-level convenience fields for creatorPlanning → skill-builder
    service_provider:   allFinal['service_provider']   || chosenProvider || null,
    service_capability: allFinal['service_capability'] || scoutProviderPreselect?.capability || null,
    // True when the scout gate upgraded EXECUTE→BUILD — user said "I need to send texts"
    // (setup intent), not "send a text to X right now". planSkills stops after skill setup.
    // If the message has a specific recipient/target (phone number, email, content to send),
    // it's a combined "set up and run now" request — don't stop after setup.
    buildOnly: (() => {
      if (taskType !== 'BUILD') return false;
      const _hasPhoneNumber  = /\b\d{10,}\b/.test(userMessage);
      const _hasEmailTarget  = /\bto\s+[\w._%+-]+@[\w.-]+\.[a-z]{2,}/i.test(userMessage);
      const _hasSayContent   = /\bsay(ing)?\s+["']?.{3,}/i.test(userMessage);
      const _hasAndSend      = /\band\s+(send|text|email|notify|tell|say)/i.test(userMessage);
      const _isImmediateRun  = _hasPhoneNumber || _hasEmailTarget || _hasSayContent || _hasAndSend;
      return !_isImmediateRun;
    })(),
  };

  logger.info('[Node:GatherContext] Context gathered', {
    services,
    timezone: gatheredContext.timezone,
    knownSecrets: knownSecrets.length,
    resolvedAnswers: Object.keys(resolvedAnswers).length,
    cliMatch:  cliMatch  ? `${cliMatch.capability}/${cliMatch.provider}`  : null,
    apiMatch:  apiMatch  ? `${apiMatch.capability}/${apiMatch.provider}`  : null,
  });

  return { ...state, gatheredContext };
};

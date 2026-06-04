'use strict';

/**
 * enrichIntentV2
 *
 * Slim rewrite — single responsibility: extract domain tags from the user message
 * via phi4/domain.extract to populate state.domainTags for planSkills.
 *
 * Removed from original enrichIntent.js:
 *   - Entity resolution (person/place/thing memory lookup)
 *   - Pronoun resolution
 *   - Scalar profile gap detection (name, phone, email)
 *   - MODE B/C/D correction and disambiguation handlers
 *   - Profile gap Q&A loop
 *
 * What's kept:
 *   - phi4/domain.extract call → state.domainTags (services, skillHints, tags)
 *   - Messaging service auto-selection (chosenService) — real logic planSkills uses
 *   - _skillPlan fast-path skip
 *   - Maintenance scan intercept
 *   - SMS/email signal flags (_smsTagSignal, _emailTagSignal) — used by resolveUserContext
 *
 * Context resolution ("that folder", "it", "the result") is handled by planSkills
 * LLM via the conversationNote injection from resolveReferencesV2.
 */

async function extractDomainTags(message, mcpAdapter, logger) {
  try {
    const result = await mcpAdapter.callService('phi4', 'domain.extract', { message });
    const data = result?.data || result;
    if (!data || !Array.isArray(data.tags)) return null;
    return {
      tags:       data.tags     || [],
      services:   data.services || [],
      skillHints: data.skillHints || data.skill_hints || [],
    };
  } catch (e) {
    logger.debug(`[Node:EnrichIntentV2] domain.extract failed (non-fatal): ${e.message}`);
    return null;
  }
}

const MESSAGING_PROVIDERS_SEED = new Set([
  'twilio', 'clicksend', 'sinch', 'vonage', 'messagebird', 'plivo',
  'sendgrid', 'mailgun', 'ses', 'postmark', 'sparkpost', 'mailchimp',
  'pushover', 'pushbullet', 'onesignal', 'firebase', 'apns',
  'slack', 'discord', 'telegram', 'whatsapp',
  'zapier', 'make', 'n8n', 'ifttt',
]);

module.exports = async function enrichIntentV2(state) {
  const { mcpAdapter, message, resolvedMessage, intent } = state;
  const logger = state.logger || console;

  const userMessage = (resolvedMessage || message || '').trim();

  // ── Skip for non-command intents ───────────────────────────────────────────
  if (intent?.type !== 'command_automate') {
    logger.debug(`[Node:EnrichIntentV2] Non-command intent (${intent?.type}) — passthrough`);
    return state;
  }

  // ── _skillPlan fast-path: planSkills skips LLM when pre-built ─────────────
  if (state._skillPlan && Array.isArray(state._skillPlan) && state._skillPlan.length > 0) {
    logger.debug('[Node:EnrichIntentV2] _skillPlan pre-built — skipping domain.extract');
    return state;
  }

  if (!mcpAdapter) {
    logger.warn('[Node:EnrichIntentV2] No mcpAdapter — passthrough');
    return state;
  }

  // ── Maintenance scan intercept ─────────────────────────────────────────────
  const SCAN_INTENT_RE = /\b(run|start|trigger|kick\s*off|do|schedule|run\s+a)\s+(maintenance\s+scan|agent\s+scan|agents?\s+update|site\s+scan|domain\s+scan)\b|\b(scan\s+(my\s+)?(agents?|sites?|domains?))\b/i;
  if (SCAN_INTENT_RE.test(userMessage)) {
    logger.info('[Node:EnrichIntentV2] Maintenance scan intent — routing to scan.run');
    try {
      const http = require('http');
      const body = JSON.stringify({ trigger: 'user' });
      await new Promise((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port: 3007, path: '/scan.run', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 4000 }, (r) => { r.resume(); resolve(); });
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(body);
        req.end();
      });
    } catch (_) {}
    return { ...state, intent: { type: 'direct_response' }, response: 'Starting maintenance scan — I\'ll update all agent knowledge maps and show you the progress.' };
  }

  // ── Browse-verb guard: skip domain.extract for pure navigation prompts ─────
  // Read from _taskClassification (set by resolveReferencesV2) instead of regex.
  const tc = state._taskClassification || {};
  const isBrowseOnly = tc.isBrowseOnly === true || (tc.taskType === 'browser' && tc.taskType !== 'messaging');

  // ── Extract domain tags ────────────────────────────────────────────────────
  let domainTags = (state.matchedSkillName || isBrowseOnly)
    ? null
    : await extractDomainTags(userMessage, mcpAdapter, logger);

  if (isBrowseOnly) {
    logger.info(`[Node:EnrichIntentV2] Browse-verb guard — skipping domain.extract: "${userMessage.slice(0, 60)}"`);
  }

  // Signal when no domain services detected (helps downstream planning avoid false assumptions)
  const _noDomainServicesDetected = !domainTags || !domainTags.tags || domainTags.tags.length === 0;

  // ── Local recurring reminder guard: clear hallucinated service tags ─────────
  // Use _taskClassification instead of regex for scheduling/recurring detection.
  if (domainTags && tc.isRecurring && !tc.targetService) {
    logger.info(`[Node:EnrichIntentV2] Local recurring guard — clearing domain tags`);
    domainTags = null;
  }

  // ── SMS / email signal flags ────────────────────────────────────────────────
  const _SMS_NLI   = new Set(['sms', 'text-message', 'phone-call']);
  const _CHAT_NLI  = new Set(['slack', 'discord']);
  let _smsTagSignal   = false;
  let _emailTagSignal = false;
  if (domainTags?.tags) {
    const _noChatOverride = !domainTags.tags.some(t => _CHAT_NLI.has(t));
    _smsTagSignal   = _noChatOverride && domainTags.tags.some(t => _SMS_NLI.has(t));
    _emailTagSignal = domainTags.tags.includes('email');
  }

  // ── Messaging service auto-selection ──────────────────────────────────────
  let MESSAGING_PROVIDERS = new Set(MESSAGING_PROVIDERS_SEED);
  try {
    const learnedList = await mcpAdapter.callService('user-memory', 'phrase_preference.list', {});
    const learnedResults = learnedList?.results || learnedList?.data?.results || [];
    for (const pref of learnedResults) {
      if (pref.service) MESSAGING_PROVIDERS.add(pref.service.toLowerCase());
    }
    if (learnedResults.length > 0) {
      logger.debug(`[Node:EnrichIntentV2] Extended MESSAGING_PROVIDERS with ${learnedResults.length} learned service(s)`);
    }
  } catch (_) {}

  const _phi4Services = domainTags
    ? domainTags.services.filter(s => MESSAGING_PROVIDERS.has(s.toLowerCase()))
    : [];

  const _explicitMention = userMessage.match(/\b(?:via|using|with|through|on|by)\s+([A-Za-z][A-Za-z0-9._-]{2,30})\b/i);
  const _explicitService = _explicitMention ? _explicitMention[1].toLowerCase() : null;
  const _COMMON_WORDS = new Set(['email', 'text', 'message', 'phone', 'web', 'browser', 'app', 'the', 'my', 'your', 'me', 'sale', 'it']);
  const _explicitValid = _explicitService && !_COMMON_WORDS.has(_explicitService) && _phi4Services.length > 0;
  const _messagingServices = [...new Set([..._phi4Services, ...(_explicitValid ? [_explicitService] : [])])];

  let chosenService = state.chosenService || null;
  if (!chosenService && _messagingServices.length > 0) {
    try {
      const prefResult = await mcpAdapter.callService('user-memory', 'phrase_preference.search', { phrase: userMessage });
      const learnedPref = prefResult?.match || null;
      if (learnedPref?.service) {
        chosenService = learnedPref.service;
        logger.info(`[Node:EnrichIntentV2] Learned preference → "${chosenService}"`);
      }
    } catch (_) {}

    if (!chosenService && _messagingServices.length === 1) {
      chosenService = _messagingServices[0];
      logger.info(`[Node:EnrichIntentV2] Auto-selected single provider: "${chosenService}"`);
    } else if (!chosenService && _messagingServices.length > 1) {
      logger.info(`[Node:EnrichIntentV2] Multiple providers: [${_messagingServices.join(', ')}] — plan review handles selection`);
    }
  }

  logger.info(`[Node:EnrichIntentV2] No gaps detected — passthrough`);

  return {
    ...state,
    domainTags:   domainTags  || state.domainTags,
    chosenService: chosenService || state.chosenService,
    enrichmentNeeded: [],
    _smsTagSignal,
    _emailTagSignal,
    _noDomainServicesDetected,
  };
};

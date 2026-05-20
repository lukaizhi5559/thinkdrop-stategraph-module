'use strict';

const fs   = require('fs');
const path = require('path');

const INTENT_LOG_PATH = path.join(process.cwd(), 'logs', 'intent-classifier.jsonl');
function writeDecomposeLog(entry) {
  try { fs.appendFileSync(INTENT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); }
  catch (_) {}
}

/**
 * decomposePromptV2
 *
 * Slim rewrite — single LLM call to split compound prompts into ordered sub-prompts.
 * All regex fast-paths removed. The LLM decides whether to split or pass through.
 *
 * Structural fast-paths kept (not NLU):
 *   - skillBuildRequest pass-through
 *   - _planFile / _skillPlan pass-through
 *   - _gatherQuestionPending pass-through
 *
 * Outputs: state.intentPlan[], state._decomposedIntent, state._decomposedBy
 */

const DECOMPOSE_SYSTEM_PROMPT = `You decompose a user message for an LLM intent classifier. Sub-prompts are executed by a downstream intent router:
- Each sub-prompt "text" must contain exactly ONE distinct action or intent
- Valid estimatedIntent values: command_automate, screen_intelligence, web_search, memory_store, memory_retrieve, general_knowledge, greeting
- Mark isLongRunning:true ONLY for browser automation expected to take >30 seconds
- Mark dependsOn:[N] when this step requires the OUTPUT of step N
- CRITICAL: When dependsOn is non-empty, you MUST include dataTemplate with "{{result[N]}}" placeholders for each dependency index. Example: dataTemplate: "Using the result: {{result[0]}}"
- Return ONLY valid JSON — no markdown fences, no explanation
- CRITICAL: If ALL sub-prompts implement one artifact (skill, script, scheduled task), return ONE sub-prompt with the original text and estimatedIntent:'command_automate'. Only split when the user has multiple INDEPENDENT goals.
- Navigation commands (goto, navigate to, open + specific site) → command_automate, NOT web_search
- Any task that involves interacting with a specific website or web service (sending, asking, navigating, posting, filling forms, etc.) → command_automate
- PRIORITY RULE - USER INFO WITH ACTION: When the request is about USER INFO (family, profile, personal data, relationships like mom/dad/wife/cousin, phone numbers, emails, addresses, contacts) AND also requires an external action (send, email, post, fill, submit, create, share), use SINGLE command_automate step. The user.agent skill retrieves the info internally.
- PRIORITY RULE - USER INFO ONLY: When the request is ONLY asking to show/list/tell/display USER INFO with NO external action (e.g. "who is my wife", "list my family", "what is my mom's phone", "tell me about my contacts"), use SINGLE memory_retrieve step. Do NOT use command_automate for pure info lookup.
- General rule: When a request combines data retrieval with an action (e.g., "send weather info via email"), split into TWO steps: (1) retrieve the data (memory_retrieve/web_search), (2) perform the action (command_automate with dependsOn:[0]).

JSON shape: {"subPrompts":[{"text":"...","estimatedIntent":"command_automate","order":0,"dependsOn":[],"isLongRunning":false}]}`;

function collapseLinearCAChain(plan, originalMessage, logger) {
  if (!Array.isArray(plan) || plan.length <= 1) return plan;

  const caSteps    = plan.filter(sp => sp.estimatedIntent === 'command_automate');
  const nonCaSteps = plan.filter(sp => sp.estimatedIntent !== 'command_automate');

  if (caSteps.length <= 1) return plan;

  const caOrderSet = new Set(caSteps.map(sp => sp.order));
  for (const ca of caSteps) {
    const caPredCount = ca.dependsOn.filter(d => caOrderSet.has(d)).length;
    const caSuccCount = caSteps.filter(other => other.dependsOn.includes(ca.order)).length;
    if (caPredCount > 1 || caSuccCount > 1) return plan;
  }

  const sortedCa = [...caSteps].sort((a, b) => a.order - b.order);
  let isLongRunning = false;
  let dataTemplate  = null;
  const externalDeps = [];
  for (const ca of sortedCa) {
    if (ca.isLongRunning) isLongRunning = true;
    if (!dataTemplate && ca.dataTemplate) dataTemplate = ca.dataTemplate;
    for (const dep of ca.dependsOn) {
      if (!caOrderSet.has(dep) && !externalDeps.includes(dep)) externalDeps.push(dep);
    }
  }

  const collapsedText = nonCaSteps.length === 0 ? originalMessage
    : sortedCa.map(c => c.text).join(' and ');

  const collapsedStep = {
    text: collapsedText, estimatedIntent: 'command_automate',
    order: sortedCa[0].order, dependsOn: externalDeps, isLongRunning, dataTemplate,
  };

  const newPlan = [...nonCaSteps, collapsedStep].sort((a, b) => a.order - b.order);
  const oldToNew = new Map();
  newPlan.forEach((sp, i) => {
    if (sp === collapsedStep) sortedCa.forEach(ca => oldToNew.set(ca.order, i));
    else oldToNew.set(sp.order, i);
  });

  const remapped = newPlan.map((sp, i) => ({
    ...sp, order: i,
    dependsOn: [...new Set(sp.dependsOn.map(d => oldToNew.get(d)).filter(d => d !== undefined && d < i))],
  }));

  logger.info(`[Node:DecomposePromptV2] Collapsed ${caSteps.length} linear CA steps → 1`);
  return remapped;
}

// ── Normalize user info queries ─────────────────────────────────────────────
// 1. If LLM creates memory_retrieve + command_automate for a user info query WITH an action → collapse to command_automate
// 2. If LLM creates command_automate for a pure info-only user info query (no real action) → reroute to memory_retrieve
function collapseUserInfoQuery(plan, originalMessage, logger) {
  if (!Array.isArray(plan)) return plan;

  const msgLower = originalMessage.toLowerCase();
  const userInfoKeywords = [
    'family', 'wife', 'husband', 'mom', 'dad', 'mother', 'father', 'cousin', 'sibling', 'brother', 'sister',
    'my info', 'my profile', 'personal data', 'contact', 'phone', 'email', 'address'
  ];
  const actionKeywords = [
    'send', 'email', 'post', 'fill', 'submit', 'create', 'share', 'write', 'compose', 'upload', 'message', 'text'
  ];
  const isUserInfoQuery = userInfoKeywords.some(kw => msgLower.includes(kw));
  const hasExternalAction = actionKeywords.some(kw => msgLower.includes(kw));

  if (!isUserInfoQuery) return plan;

  // Case 1: multi-step (2+) retrieve + command with action → collapse to single command_automate
  if (plan.length >= 2 && hasExternalAction) {
    const hasRetrieve = plan.some(sp => sp.estimatedIntent === 'memory_retrieve');
    const hasCommand = plan.some(sp => sp.estimatedIntent === 'command_automate');
    if (hasRetrieve && hasCommand) {
      logger.info(`[Node:DecomposePromptV2] Collapsing user info+action query (${plan.length} steps) to 1-step command_automate: ${originalMessage.slice(0, 80)}`);
      return [{
        text: originalMessage,
        estimatedIntent: 'command_automate',
        confidence: 0.85,
        order: 0,
        dependsOn: [],
        isLongRunning: false,
        dataTemplate: null
      }];
    }
  }

  // Case 2: single command_automate with no real external action → reroute to memory_retrieve
  if (plan.length === 1 && plan[0].estimatedIntent === 'command_automate' && !hasExternalAction) {
    logger.info(`[Node:DecomposePromptV2] Rerouting pure user info query to memory_retrieve: ${originalMessage.slice(0, 80)}`);
    return [{
      text: originalMessage,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null
    }];
  }

  // Case 3: pure info query (no action) but LLM hallucinated multi-step plan from conversation context
  // → strip all hallucinated steps, return single memory_retrieve for the original message
  if (!hasExternalAction && plan.length > 1) {
    logger.info(`[Node:DecomposePromptV2] Collapsing hallucinated ${plan.length}-step plan to 1-step memory_retrieve: ${originalMessage.slice(0, 80)}`);
    return [{
      text: originalMessage,
      estimatedIntent: 'memory_retrieve',
      confidence: 0.85,
      order: 0,
      dependsOn: [],
      isLongRunning: false,
      dataTemplate: null
    }];
  }

  return plan;
}

async function llmDecompose(message, llmBackend, conversationHistory, logger) {
  const recentCtx = (conversationHistory || []).slice(-4)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 150)}`)
    .join('\n');
  const contextBlock = recentCtx ? `\nRecent conversation:\n${recentCtx}\n` : '';
  const userPrompt = `Decompose this user message into ordered single-intent sub-prompts.${contextBlock}\n"${message}"`;

  let raw;
  try {
    raw = await llmBackend.generateAnswer(userPrompt, {
      query: userPrompt,
      context: { systemInstructions: DECOMPOSE_SYSTEM_PROMPT },
    }, { maxTokens: 400, temperature: 0.1, fastMode: true });
  } catch (e) {
    logger.warn(`[Node:DecomposePromptV2] LLM call failed: ${e.message}`);
    return null;
  }

  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const sanitized = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
  try {
    const parsed = JSON.parse(sanitized);
    const subPrompts = parsed.subPrompts || parsed.sub_prompts;
    if (!Array.isArray(subPrompts) || subPrompts.length < 1) return null;
    return subPrompts.map((sp, i) => ({
      text:            String(sp.text || '').trim().slice(0, 300),
      estimatedIntent: sp.estimatedIntent || sp.estimated_intent || 'general_knowledge',
      confidence:      typeof sp.confidence === 'number' ? sp.confidence : 0.70,
      order:           typeof sp.order === 'number' ? sp.order : i,
      dependsOn:       Array.isArray(sp.dependsOn || sp.depends_on) ? (sp.dependsOn || sp.depends_on) : [],
      isLongRunning:   Boolean(sp.isLongRunning || sp.is_long_running),
      dataTemplate:    sp.dataTemplate || sp.data_template || null,
    }));
  } catch (e) {
    logger.warn(`[Node:DecomposePromptV2] JSON parse failed: ${e.message}`);
    return null;
  }
}

module.exports = async function decomposePromptV2(state) {
  const { message, llmBackend, conversationHistory } = state;
  const logger = state.logger || console;

  // ── Structural fast-paths (not NLU — these are pipeline control signals) ──
  if (state.skillBuildRequest || state.intentPlan || state._planFile || state._skillPlan ||
      state._gatherQuestionPending || state.pendingQuestion?._isGatherPlanQuestion) {
    logger.debug('[Node:DecomposePromptV2] Structural fast-path — skipping decomposition');
    return state;
  }

  if (!message || !llmBackend) {
    logger.debug('[Node:DecomposePromptV2] No message or llmBackend — pass-through');
    return state;
  }

  const t0 = Date.now();
  let subPrompts = await llmDecompose(message, llmBackend, conversationHistory, logger);
  
  // Force-collapse user info queries to 1-step (backup if LLM ignores prompt instruction)
  subPrompts = collapseUserInfoQuery(subPrompts, message, logger);
  
  const durationMs = Date.now() - t0;

  if (!subPrompts || subPrompts.length === 0) {
    logger.debug('[Node:DecomposePromptV2] No sub-prompts returned — pass-through');
    return state;
  }

  // Single sub-prompt that matches original → pass-through (no multi-intent)
  if (subPrompts.length === 1) {
    const sp = subPrompts[0];
    const singleText = sp.text.toLowerCase().trim();
    const origText   = message.toLowerCase().trim();
    const isSame     = singleText === origText || origText.includes(singleText) || singleText.includes(origText);

    writeDecomposeLog({
      ts: new Date().toISOString(), message, carriedHint: null,
      parser: 'llm-decompose', intent: sp.estimatedIntent,
      subPromptCount: 1, durationMs,
      subPrompts: [{ order: 0, text: sp.text, estimatedIntent: sp.estimatedIntent, dependsOn: [], isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate }],
    });

    return {
      ...state,
      _decomposedIntent: sp.estimatedIntent,
      _decomposedBy: 'llm',
      intentPlan: [sp],
    };
  }

  // Multiple sub-prompts — collapse linear CA chains
  const collapsed = collapseLinearCAChain(subPrompts, message, logger);

  writeDecomposeLog({
    ts: new Date().toISOString(), message, carriedHint: null,
    parser: 'llm-decompose', intent: collapsed[0]?.estimatedIntent,
    subPromptCount: collapsed.length, durationMs,
    subPrompts: collapsed.map(sp => ({ order: sp.order, text: sp.text, estimatedIntent: sp.estimatedIntent, dependsOn: sp.dependsOn, isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate })),
  });

  logger.info(`[Node:DecomposePromptV2] LLM decomposed into ${collapsed.length} sub-prompts in ${durationMs}ms`);
  collapsed.forEach((sp, i) => logger.info(`  [${i}] "${sp.text}" → ${sp.estimatedIntent}`));

  return {
    ...state,
    _decomposedIntent: collapsed[0]?.estimatedIntent,
    _decomposedBy: 'llm',
    intentPlan: collapsed,
  };
};

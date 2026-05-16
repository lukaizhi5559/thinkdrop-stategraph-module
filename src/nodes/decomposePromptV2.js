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
- Use dataTemplate (optional) with "{{result[N]}}" placeholder — omit if no dependency
- Return ONLY valid JSON — no markdown fences, no explanation
- CRITICAL: If ALL sub-prompts implement one artifact (skill, script, scheduled task), return ONE sub-prompt with the original text and estimatedIntent:'command_automate'. Only split when the user has multiple INDEPENDENT goals.
- Navigation commands (goto, navigate to, open + specific site) → command_automate, NOT web_search

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
  const subPrompts = await llmDecompose(message, llmBackend, conversationHistory, logger);
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

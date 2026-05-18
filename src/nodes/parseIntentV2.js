'use strict';

const fs   = require('fs');
const path = require('path');

const INTENT_LOG_PATH = path.join(process.cwd(), 'logs', 'intent-classifier.jsonl');
function writeIntentLog(entry) {
  try { fs.appendFileSync(INTENT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); }
  catch (_) {}
}

/**
 * parseIntentV2
 *
 * Slim rewrite — trusts the LLM classification from decomposePromptV2.
 * All regex hard-override guards removed. The LLM classifies intent correctly
 * when given a clean message; the planning LLM resolves ambiguity from context.
 *
 * Structural fast-paths kept (pipeline control signals, not NLU):
 *   1. recall_plan dot-syntax detection
 *   2. _planFile / _skillPlan / _planCorrectionMode / _resumeContext pass-through
 *   3. skillBuildRequest pass-through
 *   4. Multi-intent intentPlan processing (trust decomposePromptV2 estimates)
 *   5. _decomposedIntent signal from decomposePromptV2
 */

module.exports = async function parseIntentV2(state) {
  const { message, resolvedMessage, intentPlan, conversationHistory } = state;
  const logger = state.logger || console;
  const classifyMessage = resolvedMessage || message || '';

  // ── 1. Recall plan fast-path ────────────────────────────────────────────────
  if (message && typeof message === 'string') {
    const _recallRe    = /(?:^|\s)(?:run|repeat|redo|replay|recall|do)\s+([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,4})(?:\s|$)/i;
    const _recallMatch = message.match(_recallRe);
    if (_recallMatch) {
      const { isValidDotName } = require('../utils/planCacheHelpers');
      const _candidate = _recallMatch[1].toLowerCase();
      if (isValidDotName(_candidate)) {
        logger.info(`[Node:ParseIntentV2] recall_plan: "${_candidate}"`);
        return {
          ...state,
          _recallPlanName: _candidate,
          intent: { type: 'command_automate', confidence: 1.0, entities: [], requiresMemoryAccess: false },
          metadata: { parser: 'recall-plan-passthrough', processingTimeMs: 0 },
        };
      }
    }
  }

  // ── 2. Structural pass-throughs ─────────────────────────────────────────────
  if (state._planFile && typeof state._planFile === 'string') {
    return { ...state, intent: { type: 'plan_execute', confidence: 1.0, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'plan-execute-passthrough', processingTimeMs: 0 } };
  }
  if (state._skillPlan && Array.isArray(state._skillPlan)) {
    return { ...state, intent: { type: 'command_automate', confidence: 1.0, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'skill-plan-passthrough', processingTimeMs: 0 } };
  }
  if (state._planCorrectionMode) {
    return { ...state, intent: { type: 'command_automate', confidence: 1.0, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'plan-correction-override', processingTimeMs: 0 } };
  }
  if (state._resumeContext && typeof state._resumeContext === 'object') {
    const ctx = state._resumeContext;
    return { ...state, intentQueue: ctx.intentQueue || [], intentResults: ctx.intentResults || [], dataContext: ctx.dataContext || {}, isMultiIntent: !!(ctx.intentQueue?.length || ctx.intentResults?.length), _resumeContext: null };
  }
  if (state.skillBuildRequest && state.intent?.type === 'skill_build') {
    return state;
  }
  if (state._gatherQuestionPending && state._pendingIntent?.type === 'command_automate') {
    logger.info('[Node:ParseIntentV2] Gather answer resume — forcing command_automate');
    return { ...state, intent: { type: 'command_automate', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'gather-answer-resume', processingTimeMs: 0 } };
  }

  // ── 2b. Structural routing intents — StateGraphBuilder routes on these ────────
  // These are deterministic linguistic patterns, not NLU ambiguity.
  // Must run before the LLM passthrough because decomposePromptV2 doesn't know
  // about these internal routing intents.

  // Lift constraint: "remove the rule", "allow me to X again", "stop blocking me"
  if (
    /\b(remove|lift|drop|delete|clear|forget|undo)\s+(the\s+)?(rule|constraint|restriction|block|ban)\b/i.test(classifyMessage) ||
    /\b(allow|let)\s+me\s+(to\s+)?\w.{0,40}\bagain\b/i.test(classifyMessage) ||
    /\b(i\s+want\s+to\s+be\s+able\s+to)\b.{0,40}\bagain\b/i.test(classifyMessage) ||
    /\b(stop|no\s+longer)\s+(blocking|restricting)\b/i.test(classifyMessage)
  ) {
    logger.debug(`[Node:ParseIntentV2] lift_constraint detected: "${classifyMessage.slice(0, 60)}"`);
    writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'lift-constraint-override', intent: 'lift_constraint', confidence: 0.98 });
    return { ...state, intent: { type: 'lift_constraint', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'lift-constraint-override', processingTimeMs: 0 } };
  }

  // Set constraint: "never let me...", "don't let me...", "prevent me from..."
  if (
    /^(never|don'?t|do\s+not|please\s+(don'?t|never|do\s+not))\s+(let\s+me|allow\s+(me\s+to|me)|let\s+me)\s+/i.test(classifyMessage) ||
    /^(prevent|stop)\s+me\s+from\s+/i.test(classifyMessage) ||
    /\b(block|restrict|disallow|forbid)\s+(me\s+from\s+|access\s+to\s+)/i.test(classifyMessage) ||
    /\b(don'?t|do\s*not|never|not)\s+(allow|let)\s+me\s+(to\s+)?(go\s+to|goto|visit|access|browse|open|navigate)\b/i.test(classifyMessage) ||
    /\b(block|prevent|stop)\s+me\s+(from\s+)?(going|visiting|accessing|browsing|opening|navigating)\b/i.test(classifyMessage)
  ) {
    logger.debug(`[Node:ParseIntentV2] set_constraint detected: "${classifyMessage.slice(0, 60)}"`);
    writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'set-constraint-override', intent: 'set_constraint', confidence: 0.98 });
    return { ...state, intent: { type: 'set_constraint', confidence: 0.98, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'set-constraint-override', processingTimeMs: 0 } };
  }

  // App control mode: "control Slack", "turn on control mode", "exit control mode"
  const _APP_CTRL_ENTER = /\b(turn\s+on|enable|activate|enter|start|switch\s+to)\b.{0,20}\bcontrol\s*(mode)?\b|\bcontrol\s+(slack|word|chrome|safari|firefox|figma|vscode|vs\s*code|notion|gmail|zoom|this\s+app|the\s+app|current\s+app)\b|\b(control\s+mode|app\s+control)\b/i;
  const _APP_CTRL_EXIT  = /\b(exit|stop|quit|turn\s+off|disable|deactivate|leave|end|release)\b.{0,20}\bcontrol(\s+mode)?\b|\bcontrol\s+mode\s+(off|done)\b/i;
  if (_APP_CTRL_ENTER.test(classifyMessage) || _APP_CTRL_EXIT.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntentV2] app_control_start detected: "${classifyMessage.slice(0, 60)}"`);
    writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'app-control-override', intent: 'app_control_start', confidence: 0.99 });
    return { ...state, intent: { type: 'app_control_start', confidence: 0.99, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'app-control-override', processingTimeMs: 0 } };
  }

  // System introspection: "how many agents", "list my agents", "what's in the database", "show my rules"
  const _INTROSPECT_RE = /\b(how\s+many|list\s+(my|all|the)|what('s|s|\s+is)\s+(in\s+(the|my)\s+)?(database|duckdb|agents?\s*db)|show\s+(my|all|the)|count\s+(my|the))\s*(agents?|skills?|rules?|context\s*rules?|tables?|databases?|workspace|thinkdrop\s*dir)/i;
  if (_INTROSPECT_RE.test(classifyMessage)) {
    logger.debug(`[Node:ParseIntentV2] system_introspect detected: "${classifyMessage.slice(0, 60)}"`);
    writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'system-introspect-override', intent: 'system_introspect', confidence: 0.95 });
    return { ...state, intent: { type: 'system_introspect', confidence: 0.95, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'system-introspect-override', processingTimeMs: 0 } };
  }

  // ── 3. Multi-intent: process sub-prompts from decomposePromptV2 ─────────────
  if (intentPlan && Array.isArray(intentPlan) && intentPlan.length > 1) {
    logger.info(`[Node:ParseIntentV2] intentPlan (${intentPlan.length} sub-prompts) — processing multi-intent pipeline`);

    const firstSub    = intentPlan[0];
    const firstResult = await module.exports({
      ...state,
      message:         firstSub.text,
      resolvedMessage: firstSub.text,
      intentPlan:      [firstSub],
    });

    const intentQueue = intentPlan.slice(1).map(sp => ({
      ...sp,
      intent:     sp.estimatedIntent || 'command_automate',
      confidence: typeof sp.confidence === 'number' ? sp.confidence : 0.70,
    }));

    intentQueue.forEach(sp => logger.debug(`[Node:ParseIntentV2] Queue [${sp.order}] "${sp.text.slice(0, 60)}" → ${sp.intent}`));

    return { ...firstResult, intentQueue, intentResults: [], dataContext: {}, isMultiIntent: true, originalPrompt: message };
  }

  // ── 4. Trust decomposePromptV2 intentPlan (single sub-prompt) ───────────────
  if (intentPlan && Array.isArray(intentPlan) && intentPlan.length === 1) {
    const sp         = intentPlan[0];
    const finalIntent = sp.estimatedIntent || 'general_knowledge';
    const finalConf   = typeof sp.confidence === 'number' ? sp.confidence : 0.88;

    logger.debug(`[Node:ParseIntentV2] intentPlan passthrough → ${finalIntent} (${finalConf}): "${classifyMessage.slice(0, 80)}"`);
    writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'llm-decompose', intent: finalIntent, confidence: finalConf, subPromptCount: 1, durationMs: 0, subPrompts: [{ order: 0, text: sp.text, estimatedIntent: finalIntent, dependsOn: [], isLongRunning: sp.isLongRunning, dataTemplate: sp.dataTemplate }] });

    return {
      ...state,
      intent: { type: finalIntent, confidence: finalConf, entities: [], requiresMemoryAccess: finalIntent === 'memory_retrieve' },
      metadata: { parser: 'decompose-passthrough', processingTimeMs: 0 },
    };
  }

  // ── 5. _decomposedIntent signal (LLM collapsed single CA step) ─────────────
  if (state._decomposedIntent === 'command_automate') {
    logger.debug(`[Node:ParseIntentV2] _decomposedIntent passthrough → command_automate`);
    writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'decomposed-intent-passthrough', intent: 'command_automate', confidence: 0.88 });
    return { ...state, intent: { type: 'command_automate', confidence: 0.88, entities: [], requiresMemoryAccess: false }, metadata: { parser: 'decomposed-intent-passthrough', processingTimeMs: 0 } };
  }

  // ── 6. Fallback: LLM classification when decomposePrompt had no opinion ─────
  // This fires for messages that bypassed decomposePrompt (short greetings, etc.)
  // The LLM classifies from scratch using the message + recent conversation context.
  const { mcpAdapter } = state;
  if (mcpAdapter) {
    try {
      const recentCtx = (conversationHistory || []).slice(-4)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 150)}`)
        .join('\n');
      const classifyRes = await mcpAdapter.callService('phi4', 'intent.classify', {
        message: classifyMessage,
        llmIntent: null,
        llmConfidence: null,
        recentConversation: recentCtx || undefined,
      });
      if (classifyRes?.topIntent) {
        const xIntent = classifyRes.topIntent;
        const xConf   = classifyRes.topConfidence || 0.70;
        logger.debug(`[Node:ParseIntentV2] phi4 classify → ${xIntent} (${xConf.toFixed(2)}): "${classifyMessage.slice(0, 60)}"`);
        writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'phi4-classify', intent: xIntent, confidence: xConf });
        return {
          ...state,
          intent: { type: xIntent, confidence: xConf, entities: [], requiresMemoryAccess: xIntent === 'memory_retrieve' },
          metadata: { parser: 'phi4-classify', processingTimeMs: 0 },
        };
      }
    } catch (e) {
      logger.warn(`[Node:ParseIntentV2] phi4 classify failed: ${e.message}`);
    }
  }

  // ── 7. Final fallback: rule-based ───────────────────────────────────────────
  const lower = classifyMessage.toLowerCase();
  let fallbackIntent = 'general_knowledge';
  if (/\b(remember|my name is|i am|my email|note that|store that|save that)\b/.test(lower)) fallbackIntent = 'memory_store';
  else if (/\b(what did i|do you know my|recall|retrieve|look up my|what was)\b/.test(lower)) fallbackIntent = 'memory_retrieve';
  else if (/\b(goto|go to|navigate|open|close|quit|exit|minimize|hide|show|stop|kill|launch|start|visit|click|run|execute|install|send|create|rename|move|delete|download|resize|maximize|scroll|type|press|drag)\b/.test(lower)) fallbackIntent = 'command_automate';
  else if (/^(hi|hello|hey|good morning|good afternoon|howdy|sup)\b/i.test(lower)) fallbackIntent = 'greeting';

  logger.debug(`[Node:ParseIntentV2] Rule fallback → ${fallbackIntent}: "${classifyMessage.slice(0, 60)}"`);
  writeIntentLog({ ts: new Date().toISOString(), message: classifyMessage, carriedHint: null, parser: 'rule-fallback', intent: fallbackIntent, confidence: 0.60 });

  return {
    ...state,
    intent: { type: fallbackIntent, confidence: 0.60, entities: [], requiresMemoryAccess: fallbackIntent === 'memory_retrieve' },
    metadata: { parser: 'rule-fallback', processingTimeMs: 0 },
  };
};

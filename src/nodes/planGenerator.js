'use strict';

/**
 * planGenerator.js
 *
 * StateGraph node: generates a structured plan.md for command_automate intents.
 *
 * Called when shouldGeneratePlan() returns true in StateGraphBuilder enrichIntent route.
 *
 * Responsibilities:
 *   1. Check ~/.thinkdrop/plans/ for existing similar plans (happy path reuse)
 *   2. Pre-resolve isSync steps (memory_retrieve, general_knowledge) immediately
 *      so the user sees real data in the plan, not {{result[N]}} placeholders
 *   3. Call LLM to generate a structured plan.md with streaming via progressCallback
 *   4. Scan generated content for sensitive data (planScanner.scan)
 *   5. Write plan-{timestamp}.md to ~/.thinkdrop/plans/
 *   6. Set state.awaitingPlanApproval = true and state.planFile = <path>
 *   7. Emit plan:generated progress event so main.js stores the pending context
 *
 * State inputs:
 *   state.message / state.resolvedMessage — full user prompt
 *   state.intentPlan[]    — from decomposePrompt (may be set for multi-intent)
 *   state.intent          — for single-intent command_automate
 *   state.llmBackend      — streaming LLM
 *   state.mcpAdapter      — for pre-resolving sync steps
 *   state.progressCallback — for plan:chunk / plan:generated events
 *   state.context         — { sessionId, userId }
 *
 * State outputs:
 *   state.awaitingPlanApproval  — true
 *   state.planFile              — absolute path to the generated plan.md
 *   state.answer                — null (plan is the output, not a chat answer)
 *   state._planMode             — true (tells logConversation and queue runner to skip)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const planScanner = require('../utils/planScanner');

const PLANS_DIR = path.join(os.homedir(), '.thinkdrop', 'plans');

// ── Plan generation system prompt ─────────────────────────────────────────
const PLAN_SYSTEM_PROMPT = `You generate a structured plan.md for a multi-step automation task.

Output ONLY the raw markdown content — no code fences, no extra explanation.

Use this EXACT format:

---
id: {{PLAN_ID}}
created: {{CREATED_ISO}}
status: pending
original_prompt: "{{ORIGINAL_PROMPT}}"
session_id: {{SESSION_ID}}
---

# Plan: {{SHORT_TITLE}}

## Variables
- \`{{USER_EMAIL}}\` — auto-resolve: memory:user_email
- \`{{SEARCH_TOPIC}}\` = "{{TOPIC_VALUE}}"

## Steps

### Step 1 — {{Step Title}}
- **Intent**: {{intent_type}}
- **Skills**: {{skill1 | skill2}}
- **Action**: {{what to do, one sentence}}
- **Depends on**: —
- **isSync**: {{true|false}}
- **isLongRunning**: {{true|false}}
- **Status**: ⬜ pending
- **Result**: —

(repeat for each step)

Rules:
- Valid intents: command_automate, memory_retrieve, memory_store, web_search, general_knowledge, screen_intelligence
- isSync: true ONLY for memory_retrieve and general_knowledge (no side effects, fast)
- isLongRunning: true ONLY for browser automation expected to take >30 seconds
- Depends on: list step numbers this step requires the result of, e.g. "Step 1, Step 3" — use "—" if none
- Skills: browser.act for web automation, shell.run for CLI, use | to separate multiple
- Order memory_retrieve and general_knowledge steps FIRST when their results feed later steps
- Variables section: only add a variable if it is referenced with {{VAR_NAME}} in a step
- Keep Action fields concise — one sentence max
- Do NOT include markdown code fences
`;

// ── Existing plan similarity check ────────────────────────────────────────
/**
 * Returns the path of an existing plan file if a similar plan is found,
 * based on keyword overlap with the user's prompt. Returns null if no match.
 */
function findSimilarPlan(prompt, logger) {
  try {
    if (!fs.existsSync(PLANS_DIR)) return null;
    const files = fs.readdirSync(PLANS_DIR)
      .filter((f) => f.endsWith('.md') && f.startsWith('plan-'))
      .sort()
      .reverse() // most recent first
      .slice(0, 20); // check last 20 plans only

    const promptWords = new Set(
      prompt.toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4) // skip short words
    );

    for (const file of files) {
      const planPath = path.join(PLANS_DIR, file);
      try {
        const content = fs.readFileSync(planPath, 'utf8');
        // Extract title line and original_prompt from frontmatter
        const titleMatch = content.match(/^# Plan:\s*(.+)/m);
        const promptMatch = content.match(/original_prompt:\s*"([^"]+)"/);
        const planText = ((titleMatch ? titleMatch[1] : '') + ' ' + (promptMatch ? promptMatch[1] : '')).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        const planWords = new Set(planText.split(/\s+/).filter((w) => w.length > 4));

        // Jaccard similarity: intersection / union
        const intersection = [...promptWords].filter((w) => planWords.has(w));
        const union = new Set([...promptWords, ...planWords]);
        const similarity = union.size > 0 ? intersection.length / union.size : 0;

        if (similarity >= 0.3) {
          // Check it's not already completed
          const statusMatch = content.match(/^status:\s*(.+)/m);
          const status = statusMatch ? statusMatch[1].trim() : '';
          if (status === 'complete') continue; // skip completed plans

          logger.info(`[Node:PlanGenerator] Similar plan found (${Math.round(similarity * 100)}% match): ${file}`);
          return { planFile: planPath, title: titleMatch ? titleMatch[1].trim() : file, file, similarity };
        }
      } catch (_) { /* skip unreadable files */ }
    }
  } catch (err) {
    logger.warn(`[Node:PlanGenerator] Error scanning plans dir: ${err.message}`);
  }
  return null;
}

// ── Pre-resolve isSync steps ───────────────────────────────────────────────
/**
 * Pre-resolve memory_retrieve and general_knowledge steps so the plan shows
 * real data instead of {{result[N]}} placeholders.
 * Returns a Map { stepNum → resolvedText }.
 */
async function preResolveSyncSteps(intentPlan, state, logger) {
  const resolved = new Map();
  if (!Array.isArray(intentPlan)) return resolved;

  for (const step of intentPlan) {
    if (!step.isSync && step.estimatedIntent !== 'memory_retrieve' && step.estimatedIntent !== 'general_knowledge') {
      continue;
    }

    try {
      if (step.estimatedIntent === 'memory_retrieve' && state.mcpAdapter) {
        const resp = await state.mcpAdapter.callService('user-memory', 'memory.search', {
          query: step.text,
          userId: state.context?.userId || 'default_user',
          limit: 1,
        });
        const mems = resp?.data?.memories || resp?.memories || [];
        if (mems.length > 0) {
          const text = mems[0].source_text || mems[0].extracted_text || '';
          resolved.set(step.order, text.slice(0, 300));
          logger.debug(`[Node:PlanGenerator] Pre-resolved step ${step.order} (memory_retrieve): "${text.slice(0, 60)}"`);
        }
      }
    } catch (err) {
      logger.warn(`[Node:PlanGenerator] Pre-resolve failed for step ${step.order}: ${err.message}`);
    }
  }

  return resolved;
}

// ── Build plan prompt ──────────────────────────────────────────────────────
function buildPlanPrompt(message, intentPlan, preResolved, planId, sessionId) {
  const now = new Date().toISOString();
  const safePrompt = message.replace(/"/g, '\\"').slice(0, 300);

  let context = `User request: "${safePrompt}"\n`;

  if (Array.isArray(intentPlan) && intentPlan.length > 0) {
    context += `\nDecomposed steps from intent analysis:\n`;
    for (const step of intentPlan) {
      const pre = preResolved.get(step.order);
      context += `  ${step.order + 1}. [${step.estimatedIntent}] "${step.text}"`;
      if (pre) context += ` → PRE-RESOLVED: "${pre}"`;
      if (step.isLongRunning) context += ` [long-running]`;
      if (step.dependsOn && step.dependsOn.length > 0) context += ` [depends on steps: ${step.dependsOn.map((d) => d + 1).join(', ')}]`;
      context += '\n';
    }
  }

  const systemPrompt = PLAN_SYSTEM_PROMPT
    .replace('{{PLAN_ID}}', planId)
    .replace('{{CREATED_ISO}}', now)
    .replace('{{SESSION_ID}}', sessionId || 'unknown')
    .replace('{{ORIGINAL_PROMPT}}', safePrompt);

  return { systemPrompt, userPrompt: context };
}

// ── Heuristic plan builder (LLM offline fallback) ──────────────────────────
function buildHeuristicPlan(message, intentPlan, preResolved, planId, sessionId) {
  const now = new Date().toISOString();
  const safePrompt = message.replace(/"/g, '\\"').slice(0, 300);
  const shortTitle = message.split(/\s+/).slice(0, 6).join(' ');

  const lines = [
    '---',
    `id: ${planId}`,
    `created: ${now}`,
    `status: pending`,
    `original_prompt: "${safePrompt}"`,
    `session_id: ${sessionId || 'unknown'}`,
    '---',
    '',
    `# Plan: ${shortTitle}`,
    '',
    '## Variables',
    '',
    '## Steps',
    '',
  ];

  const steps = Array.isArray(intentPlan) && intentPlan.length > 0
    ? intentPlan
    : [{ text: message, estimatedIntent: 'command_automate', order: 0, dependsOn: [], isLongRunning: false }];

  for (const [i, step] of steps.entries()) {
    const num = i + 1;
    const pre = preResolved.get(step.order);
    const action = pre ? `${step.text} (pre-resolved: ${pre.slice(0, 100)})` : step.text;
    const depSteps = (step.dependsOn || []).map((d) => `Step ${d + 1}`).join(', ') || '—';
    const isSync = step.estimatedIntent === 'memory_retrieve' || step.estimatedIntent === 'general_knowledge';

    lines.push(`### Step ${num} — ${step.text.split(/\s+/).slice(0, 5).join(' ')}`);
    lines.push(`- **Intent**: ${step.estimatedIntent || 'command_automate'}`);
    lines.push(`- **Skills**: ${step.estimatedIntent === 'command_automate' ? 'browser.act | shell.run' : '—'}`);
    lines.push(`- **Action**: ${action}`);
    lines.push(`- **Depends on**: ${depSteps}`);
    lines.push(`- **isSync**: ${isSync}`);
    lines.push(`- **isLongRunning**: ${step.isLongRunning || false}`);
    lines.push(`- **Status**: ⬜ pending`);
    lines.push(`- **Result**: —`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main export ────────────────────────────────────────────────────────────
module.exports = async function planGenerator(state) {
  const logger = state.logger || console;
  const {
    message,
    resolvedMessage,
    intentPlan,
    llmBackend,
    mcpAdapter,
    progressCallback,
    context,
  } = state;

  const userMessage = resolvedMessage || message || '';
  const sessionId = context?.sessionId || null;
  const userId = context?.userId || 'default_user';

  logger.info(`[Node:PlanGenerator] Generating plan for: "${userMessage.slice(0, 80)}"`);

  // Ensure plans directory exists
  try { fs.mkdirSync(PLANS_DIR, { recursive: true }); } catch (_) {}

  // 1. Check for existing similar plan
  const existingPlan = findSimilarPlan(userMessage, logger);
  if (existingPlan) {
    logger.info(`[Node:PlanGenerator] Offering existing plan: ${existingPlan.file}`);
    if (typeof progressCallback === 'function') {
      let existingContent = '';
      try { existingContent = fs.readFileSync(existingPlan.planFile || existingPlan.file, 'utf8'); } catch (_) {}
      progressCallback({
        type: 'plan:found_existing',
        planFile: existingPlan.planFile,
        title: existingPlan.title,
        file: existingPlan.file,
        similarity: existingPlan.similarity,
        content: existingContent,
      });
    }
    // Return early — let main.js ask user if they want to reuse.
    // If user says "new" the IPC handler will re-invoke planGenerator with _forceNewPlan=true.
    if (!state._forceNewPlan) {
      return {
        ...state,
        awaitingPlanApproval: true,
        planFile: existingPlan.planFile,
        answer: null,
        _planMode: true,
      };
    }
  }

  // 2. Pre-resolve sync steps (memory_retrieve, general_knowledge)
  const preResolved = await preResolveSyncSteps(intentPlan, state, logger);

  // 3. Generate plan ID and path
  const timestamp = Date.now();
  const planId = `plan-${timestamp}`;
  const planFile = path.join(PLANS_DIR, `${planId}.md`);

  // 4. Try LLM generation with streaming
  let planContent = null;
  let generatedBy = 'heuristic';

  let llmAvailable = false;
  if (llmBackend) {
    try { llmAvailable = await llmBackend.isAvailable(); } catch (_) {}
  }

  if (llmAvailable) {
    try {
      const { systemPrompt, userPrompt } = buildPlanPrompt(userMessage, intentPlan, preResolved, planId, sessionId);
      const chunks = [];

      // Emit plan:stream_start so PlanPanel opens and shows spinner
      if (typeof progressCallback === 'function') {
        progressCallback({ type: 'plan:stream_start', planId });
      }

      await llmBackend.generateAnswer(
        userPrompt,
        systemPrompt,
        {
          maxTokens: 1200,
          temperature: 0.0,
          streamCallback: (token) => {
            chunks.push(token);
            if (typeof progressCallback === 'function') {
              progressCallback({ type: 'plan:chunk', token, planId });
            }
          },
        }
      );

      planContent = chunks.join('');
      generatedBy = 'llm';
      logger.info(`[Node:PlanGenerator] LLM generated plan (${planContent.length} chars)`);
    } catch (err) {
      logger.warn(`[Node:PlanGenerator] LLM generation failed, using heuristic: ${err.message}`);
    }
  }

  // 5. Heuristic fallback
  if (!planContent) {
    planContent = buildHeuristicPlan(userMessage, intentPlan, preResolved, planId, sessionId);
    generatedBy = 'heuristic';
    logger.info(`[Node:PlanGenerator] Heuristic plan generated (${planContent.length} chars)`);
  }

  // 6. Inject pre-resolved results into plan content as variable values
  if (preResolved.size > 0) {
    for (const [stepOrder, resolvedText] of preResolved.entries()) {
      // Replace {{result[N]}} if present in plan content
      planContent = planContent.replace(
        new RegExp(`\\{\\{result\\[${stepOrder}\\]\\}\\}`, 'g'),
        resolvedText
      );
    }
  }

  // 7. Scan for sensitive data and sanitize before writing
  const { sanitized, secrets } = planScanner.scan(planContent);
  planContent = sanitized;

  // Store secrets map as JSON sidecar (planId.secrets.json) — never in the .md file
  // The actual secret values are not stored in the sidecar; they're stored in keytar
  // by main.js after storeSecrets() is called with the real keytar API.
  if (secrets.size > 0) {
    const secretsMeta = {};
    for (const [key, info] of secrets.entries()) {
      // Only store metadata (type, name, description, storage) — NOT the value
      secretsMeta[key] = { type: info.type, name: info.name, description: info.description, storage: info.storage };
    }
    const sidecarPath = path.join(PLANS_DIR, `${planId}.secrets.json`);
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify(secretsMeta, null, 2), 'utf8');
    } catch (e) {
      logger.warn(`[Node:PlanGenerator] Could not write secrets sidecar: ${e.message}`);
    }
    // Pass secrets map back via state so main.js can call storeSecrets() with keytar
    state._pendingPlanSecrets = secrets;
  }

  // 8. Write plan file
  try {
    fs.writeFileSync(planFile, planContent, 'utf8');
    logger.info(`[Node:PlanGenerator] Plan written to: ${planFile}`);
  } catch (err) {
    logger.error(`[Node:PlanGenerator] Failed to write plan file: ${err.message}`);
    // Fall through — state.planFile will still be set so UI can show error
  }

  // 9. Validate the generated plan and log warnings
  const validation = planScanner.validate(planContent);
  if (!validation.valid) {
    logger.warn(`[Node:PlanGenerator] Plan validation errors: ${validation.errors.join('; ')}`);
  }
  if (validation.warnings.length > 0) {
    logger.debug(`[Node:PlanGenerator] Plan validation warnings: ${validation.warnings.join('; ')}`);
  }

  // 10. Emit plan:generated event with full content for UI display
  if (typeof progressCallback === 'function') {
    progressCallback({
      type: 'plan:generated',
      planFile,
      planId,
      content: planContent,
      generatedBy,
      warnings: validation.warnings,
      errors: validation.errors,
    });
  }

  logger.info(`[Node:PlanGenerator] Plan ready (${generatedBy}): ${planId}`);

  return {
    ...state,
    awaitingPlanApproval: true,
    planFile,
    answer: null,
    _planMode: true,
    _pendingPlanSecrets: state._pendingPlanSecrets || null,
  };
};

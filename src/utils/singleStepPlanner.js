/**
 * Single Step Planner
 * 
 * Generates a replacement step for single-step replan mode.
 * Uses context from prior successful steps to generate a better replacement.
 */

'use strict';

const { parseLlmJson } = require('./parseLlmJson');
const { isPlanLegalSkill, GRAPH_INTERNAL_SKILLS, dispatchableSkills } = require('./skillIds');

// Authoritative skill vocabulary — generated from shared/skill-contracts.cjs
// so the list can never drift stale again (the old hardcoded list predated
// cli.agent/app.agent, and the LLM echoed graph node names like
// 'evaluate_skills' as skill ids — which then hit 'Unknown skill' at dispatch).
function _skillVocab() {
  try {
    const { contractsVocabularyBlock } = require('../../../shared/skill-contracts.cjs');
    const block = contractsVocabularyBlock();
    if (block && block.trim()) return block;
  } catch (_) {}
  return `- shell.run: Execute shell commands. Args: { cmd, argv } OR { goal }
- fs.read: Read files/directories. Args: { path, filePath, dir, action: 'tree'|'list' }
- fs.write: Write files. Args: { path, filePath, content }
- cli.agent: CLI/terminal agentic run. Args: { action: 'run', task, agentId? }
- app.agent: Native macOS app automation. Args: { action, appName, task?|goal?|filePath+prompt }
- web.agent: Web search/navigation. Args: { action, query }
- web.crawl: Fetch readable text from a public URL. Args: { url }
- synthesize: LLM synthesis. Args: { prompt }`;
}

// Is this skill id actually dispatchable? Contract vocabulary first (sync,
// offline-safe); then the command-service dispatch table when an adapter is
// available (covers skills outside the contract list).
async function _isDispatchable(skill, mcpAdapter) {
  if (!skill) return false;
  if (GRAPH_INTERNAL_SKILLS.has(String(skill).toLowerCase())) return true;
  if (isPlanLegalSkill(skill)) return true;
  if (!mcpAdapter) return false;
  try {
    return (await dispatchableSkills(mcpAdapter)).has(String(skill).toLowerCase());
  } catch (_) {
    return false;
  }
}

// A retry of a non-dispatchable failedSkill can only fail the same way —
// signal full replan instead of splicing a dead step into the plan.
function _fullReplanSignal(reason, skill) {
  return { _needsFullReplan: true, _invalidSkill: skill || null, _reason: reason };
}

/**
 * Generate a replacement step for the failed step
 * @param {Object} options
 * @param {Object} options.failedStep - The failed step info
 * @param {string} options.failedSkill - The skill name that failed
 * @param {Object} options.failedArgs - The args that caused the failure
 * @param {string} options.suggestion - Recovery suggestion from recoverSkill
 * @param {string} options.constraint - Constraint from recoverSkill
 * @param {Array} options.priorResults - Results from prior successful steps
 * @param {string} options.userMessage - Original user request
 * @param {Object} options.llmBackend - LLM backend for generation
 * @param {Object} options.mcpAdapter - command-service adapter (dispatch table check)
 * @returns {Object} Replacement step { skill, args, description } — or
 *   { _needsFullReplan: true } when the only viable step isn't dispatchable.
 */
async function generateSingleStep({
  failedStep,
  failedSkill,
  failedArgs,
  suggestion,
  constraint,
  priorResults,
  userMessage,
  llmBackend,
  mcpAdapter
}) {
  if (!llmBackend) {
    // Fallback: return a simple modified version of the failed step
    if (!(await _isDispatchable(failedSkill, mcpAdapter))) {
      return _fullReplanSignal('failed skill is not dispatchable', failedSkill);
    }
    return {
      skill: failedSkill,
      args: { ...failedArgs, _replanAttempt: true },
      description: `Retry ${failedSkill} with adjusted approach`
    };
  }

  // Build context from prior step outputs
  const context = priorResults
    ?.filter(r => r.ok)
    ?.map(r => `Step ${r.step} (${r.skill}): ${String(r.stdout || '').slice(0, 200) || 'completed'}`)
    ?.join('\n') || 'No prior steps completed.';

  const SYSTEM_PROMPT = `You are an automation step generator. Generate a replacement step to fix a failed step.
Output ONLY valid JSON: { "skill": "skill.name", "args": {...}, "description": "..." }

Available skills (authoritative dispatchable set — ONLY these skill names are valid; names like "evaluate_skills" or "recover_skill" are graph node internals, NEVER skills):
${_skillVocab()}

Rules:
- Use shell.run with { goal } for complex shell tasks (safer than raw cmd/argv)
- Keep the same skill type as the failed step unless the suggestion says otherwise
- Use prior step outputs (context section) to inform the new step
- Output ONLY JSON, no markdown fences, no explanation`;

  const prompt = `Original request: "${userMessage || 'Execute task'}"

Previous steps completed (use these for context):
${context}

FAILED STEP (needs replacement):
  Skill: ${failedSkill}
  Args: ${JSON.stringify(failedArgs, null, 2)}
  Error: ${failedStep?.error || 'Unknown error'}
  
Recovery suggestion: ${suggestion}
${constraint ? `Constraint: ${constraint}` : ''}

Generate a replacement step that:
1. Fixes the error described
2. Uses the same skill type unless suggestion says otherwise
3. Uses context from prior steps if relevant
4. ${constraint || 'Follows best practices for this skill type'}

Output ONLY JSON:
{ "skill": "skill.name", "args": {...}, "description": "One-line description of what this step does" }`;

  try {
    const response = await llmBackend.generateAnswer(
      prompt,
      { query: prompt, context: { systemInstructions: SYSTEM_PROMPT, intent: 'command_automate' } },
      { maxTokens: 400, temperature: 0.2, taskType: 'complex' }
    );

    // Parse JSON response
    let parsed = parseLlmJson(response, console, 'SingleStepPlanner');
    if (!parsed) {
      console.error('[SingleStepPlanner] Failed to parse LLM response:', response.slice(0, 200));
      // Fallback: return modified failed step
      if (!(await _isDispatchable(failedSkill, mcpAdapter))) {
        return _fullReplanSignal('failed skill is not dispatchable', failedSkill);
      }
      return {
        skill: failedSkill,
        args: { ...failedArgs, _replanParseError: true },
        description: `Retry ${failedSkill} (parse error fallback)`
      };
    }

    // Validate required fields
    if (!parsed.skill || !parsed.args) {
      console.error('[SingleStepPlanner] Missing required fields:', parsed);
      if (!(await _isDispatchable(failedSkill, mcpAdapter))) {
        return _fullReplanSignal('failed skill is not dispatchable', failedSkill);
      }
      return {
        skill: failedSkill,
        args: { ...failedArgs, _replanMissingFields: true },
        description: `Retry ${failedSkill} (validation fallback)`
      };
    }

    // Gate: the emitted skill must be dispatchable — a graph node name or an
    // invented skill would splice a guaranteed 'Unknown skill' failure into
    // the plan (observed: replacement {skill:'evaluate_skills'} → dispatch
    // error → a second 12-turn recovery loop chasing internal vocabulary).
    if (!(await _isDispatchable(parsed.skill, mcpAdapter))) {
      console.error(`[SingleStepPlanner] LLM emitted non-dispatchable skill "${parsed.skill}" — signaling full replan`);
      return _fullReplanSignal('emitted skill is not dispatchable', parsed.skill);
    }

    return {
      skill: parsed.skill,
      args: parsed.args,
      description: parsed.description || `Replacement step for ${failedSkill}`
    };

  } catch (err) {
    console.error('[SingleStepPlanner] LLM generation failed:', err.message);
    // Fallback: return modified failed step
    if (!(await _isDispatchable(failedSkill, mcpAdapter))) {
      return _fullReplanSignal('failed skill is not dispatchable', failedSkill);
    }
    return {
      skill: failedSkill,
      args: { ...failedArgs, _replanError: true },
      description: `Retry ${failedSkill} (error fallback)`
    };
  }
}

module.exports = {
  generateSingleStep,
};

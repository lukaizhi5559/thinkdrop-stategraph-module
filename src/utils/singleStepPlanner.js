/**
 * Single Step Planner
 * 
 * Generates a replacement step for single-step replan mode.
 * Uses context from prior successful steps to generate a better replacement.
 */

'use strict';

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
 * @returns {Object} Replacement step { skill, args, description }
 */
async function generateSingleStep({
  failedStep,
  failedSkill,
  failedArgs,
  suggestion,
  constraint,
  priorResults,
  userMessage,
  llmBackend
}) {
  if (!llmBackend) {
    // Fallback: return a simple modified version of the failed step
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

Available skills:
- shell.run: Execute shell commands. Args: { cmd, argv } OR { goal }
- fs.read: Read files/directories. Args: { path, filePath, dir, action: 'tree'|'list' }
- fs.write: Write files. Args: { path, filePath, content }
- browser.act: Browser actions. Args: { action, url, sessionId }
- browser.agent: Browser automation. Args: { action, agentId, task }
- web.agent: Web search/navigation. Args: { action, query }
- synthesize: LLM synthesis. Args: { prompt }

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
    let parsed;
    try {
      // Try to extract JSON from response (might have markdown fences)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseErr) {
      console.error('[SingleStepPlanner] Failed to parse LLM response:', response.slice(0, 200));
      // Fallback: return modified failed step
      return {
        skill: failedSkill,
        args: { ...failedArgs, _replanParseError: true },
        description: `Retry ${failedSkill} (parse error fallback)`
      };
    }

    // Validate required fields
    if (!parsed.skill || !parsed.args) {
      console.error('[SingleStepPlanner] Missing required fields:', parsed);
      return {
        skill: failedSkill,
        args: { ...failedArgs, _replanMissingFields: true },
        description: `Retry ${failedSkill} (validation fallback)`
      };
    }

    return {
      skill: parsed.skill,
      args: parsed.args,
      description: parsed.description || `Replacement step for ${failedSkill}`
    };

  } catch (err) {
    console.error('[SingleStepPlanner] LLM generation failed:', err.message);
    // Fallback: return modified failed step
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

/**
 * ParseProject Node
 *
 * Runs AFTER enrichIntent routes app_control_start, BEFORE appControl.
 *
 * Purpose: detect whether the user's message targets a built project in
 * ~/.thinkdrop/projects/ and, if so, short-circuit to planSkills with a
 * pre-built projectSkillPlan (project_launch / project_stop / project_edit).
 *
 * Two-stage matching:
 *
 * 1. FAST NAME MATCH — O(n) scan of project names against the message.
 *    No LLM call. Handles "open tic-tac-toe", "stop my snake game", etc.
 *    e.g. "stop tic-tac-toe" → stops project "tic-tac-toe"
 *
 * 2. LLM FALLBACK — only when projects exist but no name was found in the
 *    message (e.g. "fix the black tiles", "close the game", follow-ups).
 *    Re-uses the same LLM prompt that was previously in parseIntent, but
 *    now only runs when intent is already app_control_start — not on every
 *    single message.
 *
 * On project match:  sets state.projectSkillPlan + intent.type='command_automate'
 *                    → StateGraphBuilder routes to planSkills.
 * On no match:       passes through unchanged → StateGraphBuilder routes to
 *                    appControl (enter/exit app control mode as before).
 *
 * Graceful degradation: no projects dir, no llmBackend → pass through to appControl.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PROJECTS_BASE = path.join(os.homedir(), '.thinkdrop', 'projects');

// Verbs that strongly suggest "launch this project"
const LAUNCH_RE = /\b(open|launch|start|run|show\s+me|pull\s+up|bring\s+up|load|fire\s+up)\b/i;
// Verbs that strongly suggest "stop this project"
const STOP_RE   = /\b(stop|close|quit|kill|exit|shut\s+(down|off)|terminate|end)\b/i;
// Verbs that strongly suggest "edit this project"
const EDIT_RE   = /\b(fix|edit|update|change|modify|tweak|make|add|remove|delete|refactor|improve|rename|move|resize|colour|color|style)\b/i;

/**
 * Return list of project directory names under PROJECTS_BASE.
 */
function listProjects() {
  try {
    return fs.readdirSync(PROJECTS_BASE).filter(d => {
      try { return fs.statSync(path.join(PROJECTS_BASE, d)).isDirectory(); } catch (_) { return false; }
    });
  } catch (_) {
    return [];
  }
}

/**
 * Fast O(n) scan: does the message contain a project name?
 * Returns { project, action } or null.
 */
function fastMatch(msgLower, projects) {
  for (const proj of projects) {
    const projLower = proj.toLowerCase();
    // Also try with spaces instead of hyphens/underscores
    const projNorm  = projLower.replace(/[-_]/g, ' ');

    if (msgLower.includes(projLower) || msgLower.includes(projNorm)) {
      // Determine action from surrounding verbs
      if (STOP_RE.test(msgLower))   return { project: proj, action: 'stop' };
      if (EDIT_RE.test(msgLower))   return { project: proj, action: 'edit' };
      return { project: proj, action: 'launch' }; // default: open it
    }
  }
  return null;
}

/**
 * LLM fallback — only runs when fast match fails and projects exist.
 */
async function llmMatch(classifyMessage, projects, conversationHistory, llmBackend, logger) {
  const recentContext = conversationHistory.length > 0
    ? conversationHistory.slice(-4).map(m => {
        const role = m.role === 'assistant' ? 'AI' : 'User';
        const text = (m.content || m.text || '').slice(0, 150);
        return `${role}: ${text}`;
      }).join('\n')
    : '';

  const prompt = `You are a project intent classifier for ThinkDrop AI.

Built projects: ${projects.join(', ')}

${recentContext ? `Recent conversation:\n${recentContext}\n\n` : ''}Current user message: "${classifyMessage}"

Classify the intent:
- **launch**: User wants to open/start/run a project (e.g., "open tic tac toe", "launch the game")
- **stop**: User wants to close/stop/kill a project (e.g., "close the game", "stop tic tac toe")
- **edit**: User wants to modify/fix/update a project (e.g., "fix the black tiles", "make Xs red", "add a score counter")
- **none**: Not project-related or ambiguous

CRITICAL: "show" in context of making something visible is EDIT, not LAUNCH.
Example: "make the Xs and Os show" → edit (fixing visibility)
Example: "show me the game" → launch (opening it)

Output JSON only:
{
  "intent": "launch" | "stop" | "edit" | "none",
  "project": "<project-name>" | null,
  "confidence": 0.0-1.0,
  "reason": "<1 sentence explanation>"
}`;

  try {
    const response = await llmBackend.generateAnswer(prompt, {
      temperature: 0.1,
      maxTokens: 100,
      systemInstructions: 'You are a JSON-only classifier. Output valid JSON with no markdown fences.'
    });

    const text = response.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const result = JSON.parse(text);

    logger.info(`[Node:ParseProject] LLM match: ${result.intent} (${result.confidence}) → ${result.project || 'null'} | ${result.reason}`);

    if (result.confidence >= 0.6 && result.project && result.intent !== 'none') {
      return { project: result.project, action: result.intent };
    }
  } catch (err) {
    logger.warn(`[Node:ParseProject] LLM fallback failed: ${err.message}`);
  }
  return null;
}

module.exports = async function parseProject(state) {
  const { message, resolvedMessage, llmBackend, conversationHistory } = state;
  const logger = state.logger || console;

  const classifyMessage = (resolvedMessage || message || '').trim();
  if (!classifyMessage) return state;

  const projects = listProjects();

  if (projects.length === 0) {
    logger.debug('[Node:ParseProject] No built projects — passing to appControl');
    return state;
  }

  // Stage 1: fast name match (no LLM)
  const msgLower = classifyMessage.toLowerCase();
  let match = fastMatch(msgLower, projects);

  if (match) {
    logger.info(`[Node:ParseProject] Fast match: "${classifyMessage}" → ${match.action}("${match.project}")`);
  } else if (llmBackend) {
    // Stage 2: LLM fallback — only runs for app_control_start messages with existing projects
    logger.debug('[Node:ParseProject] No fast name match — trying LLM fallback...');
    match = await llmMatch(classifyMessage, projects, conversationHistory || [], llmBackend, logger);
  }

  if (!match) {
    logger.debug('[Node:ParseProject] No project match — passing to appControl');
    return state;
  }

  const { project, action } = match;

  if (action === 'stop') {
    return {
      ...state,
      intent: { type: 'command_automate', confidence: 1 },
      projectSkillPlan: [{ skill: 'project_stop', description: `Stop "${project}"`, args: { projectName: project } }]
    };
  }

  if (action === 'edit') {
    return {
      ...state,
      intent: { type: 'command_automate', confidence: 1 },
      projectSkillPlan: [{ skill: 'project_edit', description: `Edit "${project}": ${classifyMessage}`, args: { projectName: project, prompt: classifyMessage } }]
    };
  }

  // launch (default)
  return {
    ...state,
    intent: { type: 'command_automate', confidence: 1 },
    projectSkillPlan: [{ skill: 'project_launch', description: `Launch "${project}"`, args: { projectName: project } }]
  };
};

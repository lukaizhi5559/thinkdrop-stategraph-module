'use strict';

/**
 * createSkillFromHistory Node
 *
 * Creates a skill from code/scripts found in conversation history.
 * Triggered when user says things like "turn that script into a skill" or "create a skill from that code".
 *
 * Flow:
 * 1. Scans conversationHistory for recent code blocks (python, node, bash)
 * 2. Uses LLM to identify which code block matches user's intent
 * 3. Generates proper skill contract (skill.md format)
 * 4. Saves to ~/.thinkdrop/skills/{skillName}/index.cjs
 * 5. Registers skill in DuckDB + user-memory MCP
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

/**
 * Extract code blocks from conversation history
 */
function extractCodeBlocks(conversationHistory) {
  const blocks = [];
  const codeFenceRegex = /```(\w+)?\n([\s\S]*?)```/g;
  
  for (const msg of conversationHistory.slice(-10)) { // Look at last 10 messages
    const content = msg.content || msg.text || '';
    let match;
    while ((match = codeFenceRegex.exec(content)) !== null) {
      const lang = match[1] || 'text';
      const code = match[2].trim();
      if (code.length > 50) { // Minimum viable code block
        blocks.push({
          lang: lang.toLowerCase(),
          code,
          timestamp: msg.timestamp,
          role: msg.role,
        });
      }
    }
  }
  
  // Return most recent first
  return blocks.reverse();
}

/**
 * Use LLM to identify target code and generate skill interface
 */
async function identifyTargetCode({ userMessage, codeBlocks, conversationHistory, llmBackend, logger }) {
  if (!llmBackend) {
    throw new Error('LLM backend unavailable for skill identification');
  }
  
  // Format code blocks for LLM
  const formattedBlocks = codeBlocks.slice(0, 5).map((b, i) => `
--- CODE BLOCK ${i + 1} [${b.lang}] ---
${b.code.slice(0, 800)}
${b.code.length > 800 ? '\n... (truncated)' : ''}
`).join('\n');

  const recentContext = conversationHistory.slice(-6)
    .map(m => `${m.role}: ${(m.content || '').slice(0, 200)}`)
    .join('\n');

  const prompt = `USER REQUEST: "${userMessage}"

RECENT CONVERSATION:
${recentContext}

AVAILABLE CODE BLOCKS:
${formattedBlocks}

TASK: Identify which code block the user wants to turn into a skill, and extract the skill interface.

Respond with ONLY valid JSON:
{
  "targetBlockIndex": 0-4, // which code block matches the request
  "skillName": "descriptive.skill.name", // dot-notation, descriptive
  "description": "One sentence describing what this skill does",
  "inputs": { "argName": "string|number|boolean" }, // detected input parameters
  "runtime": "node|python|bash", // execution runtime
  "schedule": "on_demand", // always on_demand for extracted skills
  "secrets": [] // usually empty for simple scripts
}

Rules:
- skillName must use dot notation (e.g., "extract.image.urls", "word.counter")
- Look at the code to infer inputs (function parameters, argparse, sys.argv)
- runtime: "python" for .py code, "node" for .js/.cjs, "bash" for shell scripts
- If no code blocks match, set targetBlockIndex to -1`;

  try {
    const response = await llmBackend.generateAnswer(
      prompt,
      { query: prompt, context: { systemInstructions: 'You are a skill extraction specialist. Output ONLY valid JSON.' } },
      { maxTokens: 600, temperature: 0.1 }
    );
    
    // Extract JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in LLM response');
    }
    
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    logger.warn('[Node:createSkillFromHistory] LLM identification failed:', e.message);
    throw e;
  }
}

/**
 * Wrap code in proper skill structure
 */
function wrapAsSkill(code, iface, logger) {
  const { skillName, runtime, inputs } = iface;
  const inputNames = Object.keys(inputs || {});
  
  if (runtime === 'node' || runtime === 'javascript') {
    // Wrap as Node.js CommonJS module
    return `'use strict';

/**
 * ${iface.description || skillName}
 * 
 * Inputs: ${JSON.stringify(inputs || {})}
 */

module.exports = async function run(args, context) {
  const { ${inputNames.join(', ')} } = args || {};
  const { logger } = context || {};
  
  try {
${code.split('\n').map(l => '    ' + l).join('\n')}
  } catch (error) {
    if (logger) logger.error('[${skillName}] execution failed:', error.message);
    return { ok: false, error: error.message };
  }
};
`;
  } else if (runtime === 'python') {
    // Wrap as Python script that accepts JSON args via stdin
    return `#!/usr/bin/env python3

"""
${iface.description || skillName}

Inputs: ${JSON.stringify(inputs || {})}
"""

import sys
import json

def main():
    # Read args from stdin (JSON)
    try:
        args = json.load(sys.stdin)
    except:
        args = {}
    
${code.split('\n').map(l => '    ' + l).join('\n')}

if __name__ == '__main__':
    main()
`;
  } else {
    // Bash script - pass args as environment variables
    return `#!/bin/bash

# ${iface.description || skillName}
# Inputs: ${JSON.stringify(inputs || {})}

${code}
`;
  }
}

/**
 * Register skill in DuckDB agents.db
 */
async function registerSkillInDb(db, skillName, skillPath, iface, logger) {
  if (!db) {
    logger.warn('[Node:createSkillFromHistory] No DB connection');
    return;
  }
  
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        file_path TEXT,
        project_id TEXT,
        trigger TEXT,
        schedule TEXT,
        runtime TEXT,
        secrets TEXT,
        inputs TEXT,
        outputs TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    
    await db.run(
      `INSERT INTO skills (name, file_path, project_id, trigger, schedule, runtime, secrets, inputs, outputs, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         file_path=excluded.file_path, trigger=excluded.trigger,
         schedule=excluded.schedule, status=excluded.status, updated_at=excluded.updated_at`,
      skillName,
      skillPath,
      null, // project_id
      iface.description || '',
      iface.schedule || 'on_demand',
      iface.runtime || 'node',
      JSON.stringify(iface.secrets || []),
      JSON.stringify(iface.inputs || {}),
      JSON.stringify(iface.outputs || {}),
      'ready',
      new Date().toISOString(),
      new Date().toISOString()
    );
    
    logger.info('[Node:createSkillFromHistory] Registered skill in DuckDB', { skillName });
  } catch (e) {
    logger.warn('[Node:createSkillFromHistory] DuckDB registration failed:', e.message);
  }
}

/**
 * Register skill in user-memory MCP
 */
async function registerInMemoryMcp(skillName, iface, skillPath, logger) {
  try {
    const http = require('http');
    const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
    const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
    
    // Build contractMd with YAML frontmatter
    const inputsYaml = Object.entries(iface.inputs || {})
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    
    const contractMd = `---
name: ${skillName}
description: ${iface.description || skillName}
runtime: ${iface.runtime || 'node'}
trigger: "${iface.description || ''}"
schedule: ${iface.schedule || 'on_demand'}
${iface.secrets?.length ? `secrets:\n${iface.secrets.map(s => `  - ${s}`).join('\n')}` : 'secrets: []'}
inputs:
${inputsYaml || '  # no inputs required'}
outputs:
  result: string
---

Skill file: ${skillPath}
`;
    
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'skill.install',
      payload: { contractMd },
      requestId: `skill-history-${Date.now()}`
    });
    
    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: memPort,
        path: '/skill.install',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(memApiKey ? { 'Authorization': `Bearer ${memApiKey}` } : {})
        },
        timeout: 8000,
      }, (res) => { res.resume(); res.on('end', resolve); });
      
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
    
    logger.info('[Node:createSkillFromHistory] Registered skill in user-memory MCP', { skillName });
  } catch (e) {
    logger.warn('[Node:createSkillFromHistory] MCP registration failed:', e.message);
  }
}

/**
 * Main node function
 */
module.exports = async function createSkillFromHistory(state) {
  const {
    message,
    resolvedMessage,
    conversationHistory,
    llmBackend,
    logger,
    mcpAdapter,
  } = state;
  
  const userMessage = resolvedMessage || message || '';
  logger.info('[Node:createSkillFromHistory] Creating skill from conversation history');
  
  try {
    // Step 1: Extract code blocks from conversation
    const codeBlocks = extractCodeBlocks(conversationHistory || []);
    if (codeBlocks.length === 0) {
      logger.warn('[Node:createSkillFromHistory] No code blocks found in conversation history');
      return {
        ...state,
        answer: 'I couldn\'t find any code blocks in our recent conversation to turn into a skill. Try sharing the script you\'d like to convert.',
        commandExecuted: true,
      };
    }
    
    logger.debug(`[Node:createSkillFromHistory] Found ${codeBlocks.length} code blocks`);
    
    // Step 2: Use LLM to identify target code and generate interface
    const identification = await identifyTargetCode({
      userMessage,
      codeBlocks,
      conversationHistory,
      llmBackend,
      logger,
    });
    
    if (identification.targetBlockIndex < 0 || identification.targetBlockIndex >= codeBlocks.length) {
      return {
        ...state,
        answer: 'I couldn\'t identify which code block you want to turn into a skill. Could you be more specific about which script?',
        commandExecuted: true,
      };
    }
    
    const targetBlock = codeBlocks[identification.targetBlockIndex];
    const skillName = identification.skillName || `extracted.skill.${Date.now()}`;
    
    logger.info(`[Node:createSkillFromHistory] Creating skill "${skillName}" from ${targetBlock.lang} code block`);
    
    // Step 3: Wrap code as skill
    const iface = {
      skillName,
      description: identification.description || `Skill created from ${targetBlock.lang} script`,
      runtime: identification.runtime || targetBlock.lang,
      inputs: identification.inputs || {},
      outputs: identification.outputs || { result: 'string' },
      secrets: identification.secrets || [],
      schedule: 'on_demand',
    };
    
    const skillCode = wrapAsSkill(targetBlock.code, iface, logger);
    
    // Step 4: Write to disk
    const dirName = skillName.replace(/\./g, '_');
    const skillDir = path.join(USER_SKILLS_DIR, dirName);
    const skillPath = path.join(skillDir, 'index.cjs');
    
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, skillCode, 'utf8');
    
    logger.info(`[Node:createSkillFromHistory] Wrote skill to ${skillPath}`);
    
    // Step 5: Register in databases
    const db = mcpAdapter?.db || state.db;
    await registerSkillInDb(db, skillName, skillPath, iface, logger);
    await registerInMemoryMcp(skillName, iface, skillPath, logger);
    
    // Step 6: Return success
    const inputDesc = Object.entries(iface.inputs || {})
      .map(([k, v]) => `${k} (${v})`)
      .join(', ') || 'none';
    
    return {
      ...state,
      answer: `Created skill "${skillName}" from your ${targetBlock.lang} script.\n\n**Description:** ${iface.description}\n**Inputs:** ${inputDesc}\n\nThe skill is now available via \`external.skill\` with name "${skillName}".`,
      commandExecuted: true,
      skillCreated: {
        name: skillName,
        path: skillPath,
        interface: iface,
      },
    };
    
  } catch (error) {
    logger.error('[Node:createSkillFromHistory] Failed:', error.message);
    return {
      ...state,
      answer: `Failed to create skill: ${error.message}. Please try again with more details about which script you'd like to convert.`,
      commandExecuted: true,
    };
  }
};

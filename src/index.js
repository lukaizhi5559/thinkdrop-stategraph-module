/**
 * @thinkdrop/stategraph - Standalone StateGraph Module
 *
 * Progressive workflow orchestration with optional MCP integration
 */

// Load stategraph-level .env so THINKDROP_CLI_DRIVER is set before any node module
// reads it (e.g. planSkills.js loadSystemPrompt). Uses a simple KEY=value parser so
// there is no dotenv dependency required. Does NOT override vars already set by a
// parent process (e.g. Electron main.js dotenv or shell env).
(function _loadStategraphEnv() {
  try {
    const _fs = require('fs');
    const _path = require('path');
    const _envPath = _path.join(__dirname, '../.env');
    _fs.readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  } catch (_) { /* .env optional */ }
})();

const StateGraph = require('./core/StateGraph');
const StateGraphBuilder = require('./StateGraphBuilder');

// Adapters
const MCPAdapter = require('./adapters/MCPAdapter');
const MockMCPAdapter = require('./adapters/MockMCPAdapter');
const RealMCPAdapter = require('./adapters/RealMCPAdapter');

// LLM Backends (pluggable answer generation)
const LLMBackend = require('./backends/LLMBackend');
const MCPLLMBackend = require('./backends/MCPLLMBackend');
const VSCodeLLMBackend = require('./backends/VSCodeLLMBackend');
const ExternalLLMBackend = require('./backends/ExternalLLMBackend');

// Nodes (for custom graphs)
const parseIntentNode = require('./nodes/parseIntentV2');
const answerNode = require('./nodes/answer');
const retrieveMemoryNode = require('./nodes/retrieveMemory');
const storeMemoryNode = require('./nodes/storeMemory');
const webSearchNode = require('./nodes/webSearch');
const executeCommandNode = require('./nodes/executeCommand');
const planSkillsNode = require('./nodes/planSkillsV2');
const screenIntelligenceNode = require('./nodes/screenIntelligence');
const logConversationNode = require('./nodes/logConversation');

module.exports = {
  // Core
  StateGraph,
  StateGraphBuilder,
  
  // Adapters
  MCPAdapter,
  MockMCPAdapter,
  RealMCPAdapter,

  // LLM Backends (swap the answer generation backend)
  backends: {
    LLMBackend,
    MCPLLMBackend,
    VSCodeLLMBackend,
    ExternalLLMBackend
  },
  // Also export flat for convenience
  LLMBackend,
  MCPLLMBackend,
  VSCodeLLMBackend,
  ExternalLLMBackend,
  
  // Nodes (for custom implementations)
  nodes: {
    parseIntent: parseIntentNode,
    answer: answerNode,
    retrieveMemory: retrieveMemoryNode,
    storeMemory: storeMemoryNode,
    webSearch: webSearchNode,
    executeCommand: executeCommandNode,
    planSkills: planSkillsNode,
    screenIntelligence: screenIntelligenceNode,
    logConversation: logConversationNode
  }
};

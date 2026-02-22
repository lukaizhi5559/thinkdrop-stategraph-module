/**
 * @thinkdrop/stategraph - Standalone StateGraph Module
 * 
 * Progressive workflow orchestration with optional MCP integration
 */

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
const parseIntentNode = require('./nodes/parseIntent');
const answerNode = require('./nodes/answer');
const retrieveMemoryNode = require('./nodes/retrieveMemory');
const storeMemoryNode = require('./nodes/storeMemory');
const webSearchNode = require('./nodes/webSearch');
const executeCommandNode = require('./nodes/executeCommand');
const planSkillsNode = require('./nodes/planSkills');
const recoverSkillNode = require('./nodes/recoverSkill');
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
    recoverSkill: recoverSkillNode,
    screenIntelligence: screenIntelligenceNode,
    logConversation: logConversationNode
  }
};

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

// Nodes (for custom graphs)
const parseIntentNode = require('./nodes/parseIntent');
const answerNode = require('./nodes/answer');
const retrieveMemoryNode = require('./nodes/retrieveMemory');
const storeMemoryNode = require('./nodes/storeMemory');
const webSearchNode = require('./nodes/webSearch');
const executeCommandNode = require('./nodes/executeCommand');
const screenIntelligenceNode = require('./nodes/screenIntelligence');
const visionNode = require('./nodes/vision');

module.exports = {
  // Core
  StateGraph,
  StateGraphBuilder,
  
  // Adapters
  MCPAdapter,
  MockMCPAdapter,
  RealMCPAdapter,
  
  // Nodes (for custom implementations)
  nodes: {
    parseIntent: parseIntentNode,
    answer: answerNode,
    retrieveMemory: retrieveMemoryNode,
    storeMemory: storeMemoryNode,
    webSearch: webSearchNode,
    executeCommand: executeCommandNode,
    screenIntelligence: screenIntelligenceNode,
    vision: visionNode
  }
};

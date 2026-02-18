/**
 * MockMCPAdapter - Mock implementation for testing without MCP services
 * 
 * Returns realistic mock data for all MCP service calls.
 * Useful for:
 * - Intent classification testing
 * - Workflow testing without dependencies
 * - Development without running MCP services
 */

const MCPAdapter = require('./MCPAdapter');

class MockMCPAdapter extends MCPAdapter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this.mockResponses = options.mockResponses || {};
  }

  async callService(serviceName, action, params) {
    this.logger.debug(`[MockMCP] ${serviceName}.${action}`, params);

    // Check for custom mock responses
    const mockKey = `${serviceName}.${action}`;
    if (this.mockResponses[mockKey]) {
      return this.mockResponses[mockKey](params);
    }

    // Default mock responses
    switch (serviceName) {
      case 'phi4':
        return this._mockPhi4Service(action, params);
      
      case 'conversation':
        return this._mockConversationService(action, params);
      
      case 'user-memory':
        return this._mockUserMemoryService(action, params);
      
      case 'web-search':
        return this._mockWebSearchService(action, params);
      
      case 'command':
        return this._mockCommandService(action, params);
      
      case 'screen-intelligence':
        return this._mockScreenIntelligenceService(action, params);
      
      case 'vision':
        return this._mockVisionService(action, params);
      
      case 'coreference':
        return this._mockCoreferenceService(action, params);
      
      default:
        throw new Error(`[MockMCP] Unknown service: ${serviceName}`);
    }
  }

  _mockPhi4Service(action, params) {
    switch (action) {
      case 'intent.parse':
        return this._classifyIntent(params.message);
      
      case 'chat.completion':
        return {
          data: {
            answer: `[Mock Answer] This is a mock response to: "${params.query}". MCP services not available.`,
            usage: { promptTokens: 100, completionTokens: 50 }
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown phi4 action: ${action}`);
    }
  }

  _classifyIntent(message) {
    const msg = message.toLowerCase();
    
    // Simple rule-based intent classification for testing
    if (msg.includes('remember') || msg.includes('save') || msg.includes('store')) {
      return {
        data: {
          intent: 'memory_store',
          confidence: 0.9,
          entities: [],
          metadata: { parser: 'mock' }
        }
      };
    }
    
    if (msg.includes('weather') || msg.includes('news') || msg.includes('search') || msg.includes('find')) {
      return {
        data: {
          intent: 'web_search',
          confidence: 0.85,
          entities: [],
          metadata: { parser: 'mock' }
        }
      };
    }
    
    if (msg.includes('open') || msg.includes('close') || msg.includes('launch') || msg.includes('quit')) {
      return {
        data: {
          intent: 'command_execute',
          confidence: 0.9,
          entities: [],
          metadata: { parser: 'mock' }
        }
      };
    }
    
    if (msg.includes('screen') || msg.includes('see') || msg.includes('showing')) {
      return {
        data: {
          intent: 'screen_intelligence',
          confidence: 0.85,
          entities: [],
          metadata: { parser: 'mock' }
        }
      };
    }
    
    if (msg.includes('what did i') || msg.includes('recall') || msg.includes('do i have')) {
      return {
        data: {
          intent: 'memory_retrieve',
          confidence: 0.8,
          entities: [],
          metadata: { parser: 'mock' }
        }
      };
    }
    
    if (msg.match(/^(hi|hello|hey|good morning|good afternoon)/i)) {
      return {
        data: {
          intent: 'greeting',
          confidence: 0.95,
          entities: [],
          metadata: { parser: 'mock' }
        }
      };
    }
    
    // Default to question
    return {
      data: {
        intent: 'question',
        confidence: 0.6,
        entities: [],
        metadata: { parser: 'mock' }
      }
    };
  }

  _mockConversationService(action, params) {
    switch (action) {
      case 'message.list':
        return {
          data: {
            messages: [
              { sender: 'user', text: 'Previous message', timestamp: new Date().toISOString() },
              { sender: 'assistant', text: 'Previous response', timestamp: new Date().toISOString() }
            ]
          }
        };
      
      case 'context.get':
        return {
          data: {
            facts: [],
            entities: []
          }
        };
      
      case 'message.store':
        return {
          data: {
            id: 'mock_message_id',
            success: true
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown conversation action: ${action}`);
    }
  }

  _mockUserMemoryService(action, params) {
    switch (action) {
      case 'memory.search':
        return {
          data: {
            results: [
              {
                id: 'mock_memory_1',
                text: 'Mock memory: User likes coffee',
                similarity: 0.7,
                entities: [],
                metadata: {},
                created_at: new Date().toISOString()
              }
            ]
          }
        };
      
      case 'memory.store':
        return {
          data: {
            id: 'mock_memory_id',
            success: true
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown user-memory action: ${action}`);
    }
  }

  _mockWebSearchService(action, params) {
    switch (action) {
      case 'web.search':
        return {
          data: {
            results: [
              {
                title: 'Mock Search Result 1',
                snippet: 'This is a mock search result for testing purposes.',
                url: 'https://example.com/result1'
              },
              {
                title: 'Mock Search Result 2',
                snippet: 'Another mock result with relevant information.',
                url: 'https://example.com/result2'
              }
            ]
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown web-search action: ${action}`);
    }
  }

  _mockCommandService(action, params) {
    switch (action) {
      case 'command.execute':
        return {
          data: {
            success: true,
            result: '[Mock] Command executed successfully',
            output: 'Mock command output'
          }
        };
      
      case 'command.automate':
        return {
          data: {
            success: true,
            result: '[Mock] Automation completed',
            steps: ['Step 1', 'Step 2']
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown command action: ${action}`);
    }
  }

  _mockScreenIntelligenceService(action, params) {
    switch (action) {
      case 'screen.analyze':
        return {
          data: {
            elements: [
              { type: 'button', text: 'Submit', bbox: [100, 200, 200, 250] },
              { type: 'text', text: 'Welcome', bbox: [50, 50, 150, 80] }
            ],
            context: 'Mock screen analysis'
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown screen-intelligence action: ${action}`);
    }
  }

  _mockVisionService(action, params) {
    switch (action) {
      case 'vision.analyze':
        return {
          data: {
            description: 'Mock vision analysis: The screen shows a typical application interface.',
            confidence: 0.8
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown vision action: ${action}`);
    }
  }

  _mockCoreferenceService(action, params) {
    switch (action) {
      case 'coreference.resolve':
        return {
          data: {
            resolvedMessage: params.message, // Just return original for mock
            needsContext: false,
            replacements: []
          }
        };
      
      default:
        throw new Error(`[MockMCP] Unknown coreference action: ${action}`);
    }
  }

  async isServiceAvailable(serviceName) {
    // Mock adapter always reports services as available
    return true;
  }

  async getAvailableServices() {
    // Mock adapter reports all services as available
    return ['phi4', 'conversation', 'user-memory', 'web-search', 'command', 'screen-intelligence', 'vision', 'coreference'];
  }
}

module.exports = MockMCPAdapter;

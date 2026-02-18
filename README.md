# @thinkdrop/stategraph

Standalone StateGraph workflow orchestration with progressive MCP integration.

## Features

- ✅ **Progressive Enhancement**: Start with minimal intent classification, scale to full workflow
- ✅ **Graceful Degradation**: Works with or without MCP services
- ✅ **Pluggable Nodes**: All nodes are injectable and customizable
- ✅ **Adapter Pattern**: MCP integration via adapters (mock or real)
- ✅ **Full State Trace**: Complete execution history for debugging

## Installation

```bash
npm install @thinkdrop/stategraph
```

## Quick Start: Intent Classification Only

```javascript
const { StateGraphBuilder } = require('@thinkdrop/stategraph');

// Minimal setup - intent classification only
const graph = StateGraphBuilder.minimal({
  logger: console, // Optional: custom logger
  mcpAdapter: null // No MCP needed for testing
});

const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: '123', sessionId: 'abc' }
});

console.log(result);
// {
//   intent: { type: 'web_search', confidence: 0.85 },
//   answer: '[MCP not available - intent classification only]',
//   trace: [...],
//   success: true
// }
```

## Progressive Enhancement: Add MCP Services

```javascript
const { StateGraphBuilder, RealMCPAdapter } = require('@thinkdrop/stategraph');

// Full setup with MCP integration
const mcpAdapter = new RealMCPAdapter({
  phi4Endpoint: 'http://localhost:3002',
  conversationEndpoint: 'http://localhost:3003',
  // ... other MCP service endpoints
});

const graph = StateGraphBuilder.full({
  logger: console,
  mcpAdapter: mcpAdapter,
  enabledNodes: ['parseIntent', 'retrieveMemory', 'webSearch', 'answer']
});

const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: '123', sessionId: 'abc' }
});

console.log(result);
// {
//   intent: { type: 'web_search', confidence: 0.85 },
//   searchResults: [...],
//   answer: 'The weather in NYC is currently 72°F and sunny.',
//   trace: [...],
//   success: true
// }
```

## Testing Intent Classification

```javascript
const { StateGraphBuilder } = require('@thinkdrop/stategraph');

// Test intent classification in isolation
const testCases = [
  { message: "What's the weather?", expected: 'web_search' },
  { message: "Remember my birthday is May 5th", expected: 'memory_store' },
  { message: "Open Slack", expected: 'command_execute' }
];

const graph = StateGraphBuilder.minimal();

for (const test of testCases) {
  const result = await graph.execute({ message: test.message });
  console.log(`${test.message} → ${result.intent.type} (expected: ${test.expected})`);
}
```

## Architecture

### Core Components

1. **StateGraph** - Generic workflow orchestration engine
2. **MCPAdapter** - Interface for MCP service integration (mock or real)
3. **Nodes** - Pluggable workflow steps (parseIntent, answer, etc.)
4. **StateGraphBuilder** - Factory for creating configured graphs

### Progressive Levels

| Level | Features | MCP Required |
|-------|----------|--------------|
| **Minimal** | Intent classification only | ❌ No |
| **Basic** | Intent + mock responses | ❌ No |
| **Standard** | Intent + real LLM answers | ✅ phi4 only |
| **Full** | All nodes (memory, search, commands) | ✅ All services |

## API Reference

### StateGraphBuilder

#### `StateGraphBuilder.minimal(options)`

Creates a minimal graph for intent classification testing.

**Options:**
- `logger` - Custom logger (default: console)
- `mcpAdapter` - MCP adapter (default: MockMCPAdapter)

**Returns:** Configured StateGraph instance

#### `StateGraphBuilder.full(options)`

Creates a full-featured graph with all nodes enabled.

**Options:**
- `logger` - Custom logger (required)
- `mcpAdapter` - MCP adapter (required)
- `enabledNodes` - Array of node names to enable (default: all)

**Returns:** Configured StateGraph instance

### StateGraph

#### `graph.execute(initialState)`

Executes the workflow with the given initial state.

**Parameters:**
- `initialState` - Object with `message`, `context`, etc.

**Returns:** Promise resolving to final state with:
```javascript
{
  intent: { type: string, confidence: number },
  answer: string,
  trace: Array<TraceEntry>,
  elapsedMs: number,
  success: boolean,
  // ... other state fields depending on enabled nodes
}
```

### MCPAdapter Interface

```javascript
class MCPAdapter {
  async callService(serviceName, action, params) {
    // Implement MCP service calls
    // serviceName: 'phi4', 'conversation', 'user-memory', etc.
    // action: 'intent.parse', 'message.list', 'memory.search', etc.
    // params: service-specific parameters
  }
}
```

## Node Customization

All nodes are pluggable. You can provide custom implementations:

```javascript
const graph = new StateGraph({
  parseIntent: async (state) => {
    // Your custom intent parsing logic
    return {
      ...state,
      intent: { type: 'custom_intent', confidence: 1.0 }
    };
  },
  answer: async (state) => {
    // Your custom answer generation
    return {
      ...state,
      answer: 'Custom response'
    };
  }
}, edges, { logger: console, mcpAdapter: null });
```

## Examples

See `examples/` directory for:
- `intent-testing.js` - Intent classification testing
- `progressive-enhancement.js` - Gradually enabling features
- `custom-nodes.js` - Custom node implementations
- `full-integration.js` - Complete MCP integration

## License

MIT

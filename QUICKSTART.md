# Quick Start Guide

Get started with the standalone StateGraph module in 5 minutes.

## Installation

```bash
cd stategraph-module
npm install
```

## Test Intent Classification (No MCP Required)

```bash
npm test
```

This runs 20+ test cases for intent classification without any dependencies.

## Basic Usage

### 1. Minimal Mode - Intent Testing Only

Perfect for testing and fine-tuning intent classification:

```javascript
const { StateGraphBuilder } = require('./src/index');

// Create minimal graph (no MCP required)
const graph = StateGraphBuilder.minimal();

// Test intent classification
const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: 'test', sessionId: 'test' }
});

console.log(result.intent);
// Output: { type: 'web_search', confidence: 0.8, entities: [] }

console.log(result.answer);
// Output: "[MCP not available - Intent classified as: web_search]"
```

### 2. Basic Mode - With Mock Responses

Test full workflow without MCP services:

```javascript
const { StateGraphBuilder } = require('./src/index');

// Create basic graph (uses mock MCP)
const graph = StateGraphBuilder.basic();

const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: 'test', sessionId: 'test' }
});

console.log(result.answer);
// Output: "[Mock Answer] This is a mock response..."
```

### 3. Full Mode - With Real MCP Services

Connect to your existing MCP infrastructure:

```javascript
const { StateGraphBuilder, RealMCPAdapter } = require('./src/index');
const MCPClient = require('../src/main/services/mcp/MCPClient.cjs');
const MCPConfigManager = require('../src/main/services/mcp/MCPConfigManager.cjs');

// Initialize MCP client
const mcpClient = new MCPClient(MCPConfigManager);
const mcpAdapter = new RealMCPAdapter(mcpClient, { logger: console });

// Create full graph
const graph = StateGraphBuilder.full({
  logger: console,
  mcpAdapter: mcpAdapter
});

// Execute with real services
const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: 'user_123', sessionId: 'session_456' }
});

console.log(result);
// Full response with intent, answer, memories, web results, trace, etc.
```

## Understanding the Output

Every execution returns a complete state object:

```javascript
{
  // Intent classification
  intent: {
    type: 'web_search',           // Intent type
    confidence: 0.85,              // Confidence score (0-1)
    entities: []                   // Extracted entities
  },
  
  // Generated answer
  answer: 'The weather in NYC is...',
  
  // Execution trace (for debugging)
  trace: [
    {
      node: 'parseIntent',
      duration: 45,
      timestamp: '2024-01-01T12:00:00Z',
      success: true
    },
    {
      node: 'answer',
      duration: 234,
      timestamp: '2024-01-01T12:00:00Z',
      success: true
    }
  ],
  
  // Performance metrics
  elapsedMs: 279,                  // Total execution time
  iterations: 2,                   // Number of nodes executed
  success: true,                   // Overall success status
  
  // Additional context (if available)
  conversationHistory: [...],      // Recent messages
  memories: [...],                 // Retrieved memories
  searchResults: [...],            // Web search results
  contextDocs: [...]               // Processed documents
}
```

## Examples

Run the included examples:

```bash
# Intent classification testing
node examples/intent-testing.js

# Progressive enhancement demo
node examples/progressive-enhancement.js

# Full integration guide
node examples/full-integration.js
```

## Common Use Cases

### Testing Intent Classification

```javascript
const graph = StateGraphBuilder.minimal();

const testCases = [
  "What's the weather?",           // web_search
  "Remember my birthday is May 5", // memory_store
  "Open Slack",                    // command_execute
  "What did I tell you?",          // memory_retrieve
  "Hello"                          // greeting
];

for (const message of testCases) {
  const result = await graph.execute({ message, context: {} });
  console.log(`${message} → ${result.intent.type}`);
}
```

### Custom Intent Logic

```javascript
const { StateGraph } = require('./src/index');

const customParseIntent = async (state) => {
  if (state.message.includes('urgent')) {
    return {
      ...state,
      intent: { type: 'urgent', confidence: 1.0, entities: [] }
    };
  }
  // Fallback to default
  return require('./src/nodes/parseIntent')(state);
};

const graph = new StateGraph(
  { parseIntent: customParseIntent, answer: require('./src/nodes/answer') },
  { start: 'parseIntent', parseIntent: 'answer', answer: 'end' },
  { logger: console, mcpAdapter: null }
);
```

### Debugging with Trace

```javascript
const result = await graph.execute({ message: 'test', context: {} });

// View execution trace
result.trace.forEach(step => {
  console.log(`${step.node}: ${step.duration}ms (${step.success ? '✅' : '❌'})`);
});

// Find bottlenecks
const slowSteps = result.trace.filter(s => s.duration > 100);
console.log('Slow steps:', slowSteps);
```

## Progressive Integration Path

1. **Start here**: Test intent classification with `npm test`
2. **Fine-tune**: Adjust patterns in `src/nodes/parseIntent.js`
3. **Mock test**: Use `StateGraphBuilder.basic()` for workflow testing
4. **Real integration**: Connect with `RealMCPAdapter`
5. **Add nodes**: Import your original nodes as needed

## Next Steps

- Read [INTEGRATION.md](./INTEGRATION.md) for detailed integration guide
- Read [README.md](./README.md) for complete API documentation
- Check [examples/](./examples/) for more usage patterns
- Run tests with `npm test` to validate intent classification

## Key Features

✅ **Works without MCP** - Test intent classification immediately  
✅ **Progressive enhancement** - Add features as services become available  
✅ **Graceful degradation** - Continues working even if services fail  
✅ **Full state trace** - Complete execution history for debugging  
✅ **Pluggable nodes** - Customize any part of the workflow  
✅ **Adapter pattern** - Easy integration with existing MCP infrastructure  

## Support

- Examples: `examples/` directory
- Tests: `test/` directory  
- Integration: `INTEGRATION.md`
- API docs: `README.md`

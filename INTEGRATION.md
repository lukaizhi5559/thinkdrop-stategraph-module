# Integration Guide

This guide shows how to integrate the standalone StateGraph module back into your main application.

## Quick Start: Testing Intent Classification

Before integrating, test intent classification in isolation:

```bash
cd stategraph-module
npm test
```

This runs the intent classifier test suite without any MCP dependencies.

## Progressive Integration Path

### Phase 1: Intent Testing (No MCP Required)

Test and fine-tune intent classification without running any services:

```javascript
const { StateGraphBuilder } = require('./stategraph-module/src/index');

// Create minimal graph
const graph = StateGraphBuilder.minimal();

// Test intent classification
const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: 'test', sessionId: 'test' }
});

console.log(result.intent);
// { type: 'web_search', confidence: 0.8, entities: [] }
```

**Use this phase to:**
- Test intent classification accuracy
- Fine-tune intent patterns in `src/nodes/parseIntent.js`
- Build test suite for your specific use cases
- Validate intent routing logic

### Phase 2: Mock Integration (No MCP Required)

Test full workflow with mock responses:

```javascript
const { StateGraphBuilder } = require('./stategraph-module/src/index');

// Create basic graph with mock MCP
const graph = StateGraphBuilder.basic();

const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: 'test', sessionId: 'test' }
});

console.log(result.answer);
// "[Mock Answer] This is a mock response to: ..."
```

**Use this phase to:**
- Test workflow routing
- Validate state transitions
- Debug trace output
- Test error handling

### Phase 3: Real MCP Integration

Connect to your existing MCP infrastructure:

```javascript
const { StateGraphBuilder, RealMCPAdapter } = require('./stategraph-module/src/index');
const MCPClient = require('../src/main/services/mcp/MCPClient.cjs');
const MCPConfigManager = require('../src/main/services/mcp/MCPConfigManager.cjs');

// Initialize your existing MCP client
const mcpClient = new MCPClient(MCPConfigManager);

// Wrap with RealMCPAdapter
const mcpAdapter = new RealMCPAdapter(mcpClient, { logger: console });

// Create full graph
const graph = StateGraphBuilder.full({
  logger: console,
  mcpAdapter: mcpAdapter,
  debug: true
});

// Execute with real MCP services
const result = await graph.execute({
  message: "What's the weather in NYC?",
  context: { userId: 'user_123', sessionId: 'session_456' }
});
```

## Replacing AgentOrchestrator

### Before (Original Code)

```javascript
const AgentOrchestrator = require('./src/main/services/mcp/AgentOrchestrator.cjs');

const orchestrator = new AgentOrchestrator();

const result = await orchestrator.processMessage(message, context, {
  streamCallback: (chunk) => console.log(chunk)
});
```

### After (Using StateGraph Module)

```javascript
const { StateGraphBuilder, RealMCPAdapter } = require('./stategraph-module/src/index');
const MCPClient = require('./src/main/services/mcp/MCPClient.cjs');
const MCPConfigManager = require('./src/main/services/mcp/MCPConfigManager.cjs');

// One-time setup
const mcpClient = new MCPClient(MCPConfigManager);
const mcpAdapter = new RealMCPAdapter(mcpClient, { logger: console });
const graph = StateGraphBuilder.full({ logger: console, mcpAdapter });

// Use graph instead of orchestrator
const result = await graph.execute({
  message: message,
  context: context
  // Note: streamCallback not yet supported in standalone module
  // Will be added in future version
});
```

## Customizing Nodes

You can customize any node implementation:

```javascript
const { StateGraphBuilder } = require('./stategraph-module/src/index');

// Custom intent parser
const customParseIntent = async (state) => {
  const { message } = state;
  
  // Your custom logic here
  if (message.includes('urgent')) {
    return {
      ...state,
      intent: { type: 'urgent_query', confidence: 1.0, entities: [] }
    };
  }
  
  // Fallback to default
  const parseIntent = require('./stategraph-module/src/nodes/parseIntent');
  return parseIntent(state);
};

// Build custom graph
const graph = StateGraphBuilder.custom(
  {
    parseIntent: customParseIntent,
    answer: require('./stategraph-module/src/nodes/answer')
  },
  {
    start: 'parseIntent',
    parseIntent: 'answer',
    answer: 'end'
  },
  { logger: console, mcpAdapter: null }
);
```

## Adding New Nodes

To add nodes from your original implementation:

```javascript
const { StateGraph } = require('./stategraph-module/src/index');

// Import your original nodes
const screenIntelligenceNode = require('./src/main/services/mcp/nodes/screenIntelligence.cjs');
const executeCommandNode = require('./src/main/services/mcp/nodes/executeCommand.cjs');

// Create custom graph with all nodes
const nodes = {
  parseIntent: require('./stategraph-module/src/nodes/parseIntent'),
  screenIntelligence: (state) => screenIntelligenceNode({ ...state, mcpClient: state.mcpAdapter }),
  executeCommand: (state) => executeCommandNode({ ...state, mcpClient: state.mcpAdapter }),
  answer: require('./stategraph-module/src/nodes/answer')
};

const edges = {
  start: 'parseIntent',
  parseIntent: (state) => {
    if (state.intent?.type === 'screen_intelligence') return 'screenIntelligence';
    if (state.intent?.type === 'command_execute') return 'executeCommand';
    return 'answer';
  },
  screenIntelligence: 'answer',
  executeCommand: 'answer',
  answer: 'end'
};

const graph = new StateGraph(nodes, edges, {
  logger: console,
  mcpAdapter: mcpAdapter
});
```

## Testing Strategy

### 1. Unit Test Intent Classification

```bash
npm test
```

Add your own test cases to `test/intent-classifier.test.js`.

### 2. Integration Test with Mock MCP

```javascript
const { StateGraphBuilder, MockMCPAdapter } = require('./stategraph-module/src/index');

// Custom mock responses
const mockAdapter = new MockMCPAdapter({
  logger: console,
  mockResponses: {
    'phi4.intent.parse': (params) => ({
      data: {
        intent: 'custom_intent',
        confidence: 0.95,
        entities: []
      }
    })
  }
});

const graph = StateGraphBuilder.full({
  logger: console,
  mcpAdapter: mockAdapter
});

// Test your workflow
const result = await graph.execute({ message: 'test', context: {} });
```

### 3. End-to-End Test with Real MCP

Run your existing MCP services and test with real data.

## Migration Checklist

- [ ] Run intent classification tests: `npm test`
- [ ] Fine-tune intent patterns in `src/nodes/parseIntent.js`
- [ ] Test with MockMCPAdapter (no services required)
- [ ] Test with RealMCPAdapter (services required)
- [ ] Add custom nodes if needed
- [ ] Update application code to use StateGraph
- [ ] Test full workflow end-to-end
- [ ] Monitor trace output for debugging
- [ ] Deploy to production

## Troubleshooting

### Issue: Intent classification is inaccurate

**Solution:** Fine-tune the rule-based fallback in `src/nodes/parseIntent.js` or ensure phi4 service is available for ML-based classification.

### Issue: MCP services not connecting

**Solution:** Check that RealMCPAdapter is correctly wrapping your MCPClient and that services are running.

### Issue: Missing node functionality

**Solution:** Import your original node implementations and add them to the custom graph (see "Adding New Nodes" section).

### Issue: Trace shows errors

**Solution:** Check the trace output - each step shows success/failure and duration. Use this to debug workflow issues.

## Performance Considerations

- **Minimal mode**: ~1ms (rule-based intent classification)
- **Basic mode**: ~5ms (mock MCP responses)
- **Standard mode**: ~100-500ms (real phi4 service)
- **Full mode**: ~500-2000ms (all MCP services)

Use `result.trace` to identify bottlenecks.

## Next Steps

1. Start with Phase 1 (intent testing)
2. Fine-tune intent classification
3. Progress to Phase 2 (mock integration)
4. Finally move to Phase 3 (real MCP)
5. Gradually add more nodes as needed

## Support

For issues or questions:
- Check examples in `examples/` directory
- Review test cases in `test/` directory
- See README.md for API documentation

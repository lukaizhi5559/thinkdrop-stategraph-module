/**
 * Example: Full Integration with Real MCP Services
 * 
 * Shows how to integrate the standalone StateGraph module
 * back into your existing application with real MCP services.
 */

const { StateGraphBuilder, RealMCPAdapter } = require('../src/index');

// Import your existing MCP infrastructure
// const MCPClient = require('../../src/main/services/mcp/MCPClient.cjs');
// const MCPConfigManager = require('../../src/main/services/mcp/MCPConfigManager.cjs');

async function fullIntegrationExample() {
  console.log('Full Integration Example\n');
  console.log('='.repeat(80));
  
  // Step 1: Create your existing MCP client
  console.log('\nStep 1: Initialize MCP Client');
  console.log('-'.repeat(80));
  
  // Uncomment when integrating with real MCP services:
  /*
  const mcpClient = new MCPClient(MCPConfigManager);
  await mcpClient.initialize();
  console.log('✅ MCP Client initialized');
  */
  
  // For this demo, we'll use a mock
  console.log('ℹ️  Using mock for demonstration purposes');
  console.log('   In production, initialize your real MCPClient here');
  
  // Step 2: Wrap MCP client with RealMCPAdapter
  console.log('\nStep 2: Create RealMCPAdapter');
  console.log('-'.repeat(80));
  
  // Uncomment when integrating:
  /*
  const mcpAdapter = new RealMCPAdapter(mcpClient, { logger: console });
  console.log('✅ RealMCPAdapter created');
  */
  
  console.log('ℹ️  RealMCPAdapter wraps your existing MCPClient');
  console.log('   No changes needed to your MCP infrastructure');
  
  // Step 3: Create full StateGraph
  console.log('\nStep 3: Build Full StateGraph');
  console.log('-'.repeat(80));
  
  // Uncomment when integrating:
  /*
  const graph = StateGraphBuilder.full({
    logger: console,
    mcpAdapter: mcpAdapter,
    debug: true
  });
  console.log('✅ Full StateGraph created with all nodes');
  */
  
  console.log('ℹ️  StateGraphBuilder.full() creates a graph with:');
  console.log('   - parseIntent (phi4 service)');
  console.log('   - retrieveMemory (conversation + user-memory services)');
  console.log('   - storeMemory (user-memory service)');
  console.log('   - webSearch (web-search service)');
  console.log('   - answer (phi4 service)');
  
  // Step 4: Execute workflow
  console.log('\nStep 4: Execute Workflow');
  console.log('-'.repeat(80));
  
  // Uncomment when integrating:
  /*
  const result = await graph.execute({
    message: "What's the weather in NYC?",
    context: {
      userId: 'user_123',
      sessionId: 'session_456'
    }
  });
  
  console.log('\nResult:');
  console.log('  Intent:', result.intent.type);
  console.log('  Confidence:', result.intent.confidence);
  console.log('  Answer:', result.answer);
  console.log('  Execution time:', result.elapsedMs + 'ms');
  console.log('  Success:', result.success);
  
  console.log('\nTrace:');
  result.trace.forEach(step => {
    console.log(`  - ${step.node}: ${step.duration}ms (${step.success ? '✅' : '❌'})`);
  });
  */
  
  console.log('ℹ️  Execute returns full state with:');
  console.log('   - intent: { type, confidence, entities }');
  console.log('   - answer: Generated response');
  console.log('   - trace: Full execution history');
  console.log('   - elapsedMs: Total execution time');
  console.log('   - success: Boolean status');
  
  // Step 5: Integration points
  console.log('\nStep 5: Integration Points');
  console.log('-'.repeat(80));
  console.log('\nTo integrate into your existing application:');
  console.log('\n1. Replace AgentOrchestrator usage:');
  console.log('   OLD: const orchestrator = new AgentOrchestrator();');
  console.log('   NEW: const graph = StateGraphBuilder.full({ mcpAdapter, logger });');
  console.log('\n2. Replace processMessage calls:');
  console.log('   OLD: await orchestrator.processMessage(message, context);');
  console.log('   NEW: await graph.execute({ message, context });');
  console.log('\n3. Keep your existing MCP infrastructure:');
  console.log('   - MCPClient stays the same');
  console.log('   - MCPConfigManager stays the same');
  console.log('   - All MCP services stay the same');
  console.log('   - Just wrap with RealMCPAdapter');
  
  console.log('\n' + '='.repeat(80));
  console.log('\nNext Steps:');
  console.log('  1. Test intent classification with: npm test');
  console.log('  2. Fine-tune intents in isolation');
  console.log('  3. Gradually enable MCP services');
  console.log('  4. Integrate into main application');
  console.log();
}

fullIntegrationExample().catch(console.error);

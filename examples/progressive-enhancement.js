/**
 * Example: Progressive Enhancement
 * 
 * Shows how to start with minimal features and progressively
 * enable more functionality as MCP services become available.
 */

const { StateGraphBuilder, MockMCPAdapter, RealMCPAdapter } = require('../src/index');

async function demonstrateProgression() {
  const testMessage = "What's the weather in NYC?";
  const context = { userId: 'test_user', sessionId: 'test_session' };
  
  console.log('Progressive Enhancement Demo\n');
  console.log('='.repeat(80));
  
  // Level 1: Minimal (no MCP)
  console.log('\nLevel 1: MINIMAL - Intent classification only (no MCP)');
  console.log('-'.repeat(80));
  
  const minimalGraph = StateGraphBuilder.minimal({ logger: console });
  const minimalResult = await minimalGraph.execute({ message: testMessage, context });
  
  console.log('Result:', {
    intent: minimalResult.intent.type,
    confidence: minimalResult.intent.confidence,
    answer: minimalResult.answer,
    parser: minimalResult.metadata.parser
  });
  
  // Level 2: Basic (mock MCP)
  console.log('\n\nLevel 2: BASIC - Intent + mock responses (mock MCP)');
  console.log('-'.repeat(80));
  
  const basicGraph = StateGraphBuilder.basic({ logger: console });
  const basicResult = await basicGraph.execute({ message: testMessage, context });
  
  console.log('Result:', {
    intent: basicResult.intent.type,
    confidence: basicResult.intent.confidence,
    answer: basicResult.answer.substring(0, 100) + '...',
    parser: basicResult.metadata.parser
  });
  
  // Level 3: Standard (real MCP - phi4 only)
  console.log('\n\nLevel 3: STANDARD - Intent + real LLM (requires phi4 MCP)');
  console.log('-'.repeat(80));
  console.log('Note: This requires actual MCP services running.');
  console.log('Skipping in this demo. See full-integration.js for real MCP example.');
  
  // Level 4: Full (all MCP services)
  console.log('\n\nLevel 4: FULL - All features (requires all MCP services)');
  console.log('-'.repeat(80));
  console.log('Note: This requires all MCP services running.');
  console.log('Skipping in this demo. See full-integration.js for real MCP example.');
  
  console.log('\n' + '='.repeat(80));
  console.log('\nProgression Summary:');
  console.log('  Minimal  → Intent classification only (rule-based fallback)');
  console.log('  Basic    → Intent + mock responses (MockMCPAdapter)');
  console.log('  Standard → Intent + real LLM answers (phi4 service)');
  console.log('  Full     → All nodes enabled (all MCP services)');
  console.log();
}

demonstrateProgression().catch(console.error);

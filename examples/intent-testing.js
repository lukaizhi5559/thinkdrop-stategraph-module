/**
 * Example: Intent Classification Testing
 * 
 * Shows how to test intent classification in isolation
 * without any MCP services running.
 */

const { StateGraphBuilder } = require('../src/index');

async function main() {
  console.log('Intent Classification Testing Example\n');
  
  // Create minimal graph (no MCP required)
  const graph = StateGraphBuilder.minimal({
    logger: console,
    debug: true
  });
  
  // Test messages
  const messages = [
    "What's the weather in NYC?",
    "Remember my birthday is May 5th",
    "Open Slack",
    "What did I tell you about my preferences?",
    "Hello there"
  ];
  
  console.log('Testing intent classification:\n');
  
  for (const message of messages) {
    console.log(`Message: "${message}"`);
    
    const result = await graph.execute({
      message: message,
      context: { userId: 'test_user', sessionId: 'test_session' }
    });
    
    console.log(`Intent: ${result.intent.type}`);
    console.log(`Confidence: ${(result.intent.confidence * 100).toFixed(0)}%`);
    console.log(`Parser: ${result.metadata.parser}`);
    console.log(`Answer: ${result.answer}`);
    console.log(`Execution time: ${result.elapsedMs}ms`);
    console.log();
  }
  
  // Show full trace for one example
  console.log('\nFull trace example for last message:');
  const lastResult = await graph.execute({
    message: messages[messages.length - 1],
    context: { userId: 'test_user', sessionId: 'test_session' }
  });
  
  console.log(JSON.stringify(lastResult.trace, null, 2));
}

main().catch(console.error);

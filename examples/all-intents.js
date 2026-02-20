/**
 * Example: Testing All Intent Types
 * 
 * Demonstrates all intent types supported by the StateGraph module,
 * matching the DistilBERT classifier intents.
 */

const { StateGraphBuilder } = require('../src/index');

async function testAllIntents() {
  console.log('Testing All Intent Types\n');
  console.log('='.repeat(80));
  
  // Create minimal graph (no MCP required for intent testing)
  const graph = StateGraphBuilder.minimal({
    logger: {
      debug: () => {}, // Silent
      warn: () => {},
      error: console.error
    }
  });
  
  // Test cases for all intent types
  const testCases = [
    // Memory intents
    { message: "Remember my birthday is May 5th", expected: 'memory_store' },
    { message: "What did I tell you about my preferences?", expected: 'memory_retrieve' },
    
    // Command intents
    { message: "Open Slack", expected: 'command_execute' },
    { message: "Find the Submit button and click it", expected: 'command_automate' },
    { message: "Show me how to install Node.js", expected: 'command_guide' },
    
    // Screen intelligence
    { message: "What's on my screen?", expected: 'screen_intelligence' },
    { message: "What do you see?", expected: 'screen_intelligence' },
    
    // Web search and knowledge
    { message: "What's the weather in NYC?", expected: 'web_search' },
    { message: "What is the capital of France?", expected: 'question' },
    { message: "How does photosynthesis work?", expected: 'general_knowledge' },
    
    // Greeting
    { message: "Hello", expected: 'greeting' },
    { message: "Good morning", expected: 'greeting' }
  ];
  
  console.log('\nIntent Classification Results:\n');
  
  for (const test of testCases) {
    const result = await graph.execute({
      message: test.message,
      context: { userId: 'test', sessionId: 'test' }
    });
    
    const match = result.intent.type === test.expected ? '✅' : '❌';
    const confidence = (result.intent.confidence * 100).toFixed(0);
    
    console.log(`${match} "${test.message}"`);
    console.log(`   Expected: ${test.expected}`);
    console.log(`   Got: ${result.intent.type} (${confidence}%)`);
    console.log(`   Parser: ${result.metadata.parser}`);
    console.log();
  }
  
  console.log('='.repeat(80));
  console.log('\nSupported Intent Types:');
  console.log('  - memory_store: Save information');
  console.log('  - memory_retrieve: Recall stored information');
  console.log('  - command_execute: Simple shell/OS commands');
  console.log('  - command_automate: Complex multi-step UI automation');
  console.log('  - command_guide: Educational/tutorial mode');
  console.log('  - screen_intelligence: Analyze screen content');
  console.log('  - web_search: Time-sensitive queries');
  console.log('  - general_knowledge: Factual knowledge');
  console.log('  - question: General questions');
  console.log('  - greeting: Greetings and pleasantries');
  console.log();
}

testAllIntents().catch(console.error);

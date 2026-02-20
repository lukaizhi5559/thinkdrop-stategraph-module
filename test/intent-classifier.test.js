/**
 * Intent Classification Test
 * 
 * Tests intent classification in isolation without MCP services.
 * Perfect for fine-tuning intent detection before full integration.
 */

const { StateGraphBuilder } = require('../src/index');

// Test cases for intent classification
const testCases = [
  // Memory store
  { message: "Remember my birthday is May 5th", expected: 'memory_store', description: 'Store personal info' },
  { message: "Save this for later: meeting at 3pm", expected: 'memory_store', description: 'Store reminder' },
  { message: "Keep in mind I prefer coffee over tea", expected: 'memory_store', description: 'Store preference' },
  
  // Memory retrieve
  { message: "What did I tell you about my birthday?", expected: 'memory_retrieve', description: 'Recall stored info' },
  { message: "Do I have any appointments today?", expected: 'memory_retrieve', description: 'Check calendar' },
  { message: "Did I tell you my favorite color?", expected: 'memory_retrieve', description: 'Recall preference' },
  
  // Web search
  { message: "What's the weather in NYC?", expected: 'web_search', description: 'Current weather query' },
  { message: "Find the latest news about AI", expected: 'web_search', description: 'News search' },
  { message: "Search for best restaurants nearby", expected: 'web_search', description: 'Local search' },
  
  // Command execution (simple)
  { message: "Open Slack", expected: 'command_execute', description: 'Open application' },
  { message: "Close Chrome", expected: 'command_execute', description: 'Close application' },
  { message: "Launch Terminal", expected: 'command_execute', description: 'Launch app' },
  
  // Command automation (complex multi-step)
  { message: "Find the Submit button and click it", expected: 'command_automate', description: 'Multi-step automation' },
  { message: "Open Gmail and compose a new email", expected: 'command_automate', description: 'Complex workflow' },
  { message: "Navigate to settings and enable dark mode", expected: 'command_automate', description: 'Multi-step UI task' },
  
  // Command guide (educational)
  { message: "Show me how to install Node.js", expected: 'command_guide', description: 'Educational guide' },
  { message: "Teach me how to use git", expected: 'command_guide', description: 'Tutorial request' },
  
  // Screen intelligence
  { message: "What's on my screen?", expected: 'screen_intelligence', description: 'Screen analysis' },
  { message: "What do you see?", expected: 'screen_intelligence', description: 'Visual query' },
  { message: "What's showing on the display?", expected: 'screen_intelligence', description: 'Display query' },
  
  // Greeting
  { message: "Hello", expected: 'greeting', description: 'Simple greeting' },
  { message: "Good morning", expected: 'greeting', description: 'Time-based greeting' },
  { message: "Hey there", expected: 'greeting', description: 'Casual greeting' },
  
  // Question (general)
  { message: "How does photosynthesis work?", expected: 'question', description: 'General knowledge' },
  { message: "What is the capital of France?", expected: 'question', description: 'Factual question' }
];

async function runTests() {
  console.log('='.repeat(80));
  console.log('INTENT CLASSIFICATION TEST - Minimal Mode (No MCP)');
  console.log('='.repeat(80));
  console.log();
  
  // Create minimal graph (no MCP required)
  const graph = StateGraphBuilder.minimal({
    logger: {
      debug: () => {}, // Silent logger for clean output
      warn: () => {},
      error: console.error
    }
  });
  
  let passed = 0;
  let failed = 0;
  const failures = [];
  
  for (const test of testCases) {
    try {
      const result = await graph.execute({
        message: test.message,
        context: { userId: 'test_user', sessionId: 'test_session' }
      });
      
      const actualIntent = result.intent?.type;
      const confidence = result.intent?.confidence || 0;
      const match = actualIntent === test.expected;
      
      if (match) {
        passed++;
        console.log(`✅ PASS: "${test.message}"`);
        console.log(`   Expected: ${test.expected}, Got: ${actualIntent} (${(confidence * 100).toFixed(0)}%)`);
        console.log(`   Description: ${test.description}`);
      } else {
        failed++;
        failures.push({ test, actualIntent, confidence });
        console.log(`❌ FAIL: "${test.message}"`);
        console.log(`   Expected: ${test.expected}, Got: ${actualIntent} (${(confidence * 100).toFixed(0)}%)`);
        console.log(`   Description: ${test.description}`);
      }
      console.log();
    } catch (error) {
      failed++;
      failures.push({ test, error: error.message });
      console.log(`❌ ERROR: "${test.message}"`);
      console.log(`   Error: ${error.message}`);
      console.log();
    }
  }
  
  // Summary
  console.log('='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total: ${testCases.length} tests`);
  console.log(`Passed: ${passed} (${((passed / testCases.length) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed} (${((failed / testCases.length) * 100).toFixed(1)}%)`);
  console.log();
  
  if (failures.length > 0) {
    console.log('FAILURES:');
    failures.forEach(({ test, actualIntent, confidence, error }) => {
      if (error) {
        console.log(`  - "${test.message}": ERROR - ${error}`);
      } else {
        console.log(`  - "${test.message}": Expected ${test.expected}, got ${actualIntent} (${(confidence * 100).toFixed(0)}%)`);
      }
    });
    console.log();
  }
  
  console.log('='.repeat(80));
  
  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});

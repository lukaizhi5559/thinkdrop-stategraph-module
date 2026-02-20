/**
 * Execute Command Node - Extracted with graceful degradation
 * 
 * Handles command execution intents (command_execute, command_automate, command_guide).
 * Works with or without MCP adapter:
 * - With MCP: Uses command service for execution/automation
 * - Without MCP: Returns placeholder with intent info
 */

module.exports = async function executeCommand(state) {
  const { mcpAdapter, message, resolvedMessage, intent, context } = state;
  const logger = state.logger || console;
  
  // Handle all command sub-types
  const commandTypes = ['command_execute', 'command_automate', 'command_guide'];
  if (!commandTypes.includes(intent?.type)) {
    return state;
  }
  
  logger.debug(`[Node:ExecuteCommand] Executing ${intent.type}...`);

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:ExecuteCommand] No MCP adapter - command not executed');
    return {
      ...state,
      commandExecuted: false,
      answer: `[MCP not available - Command would be executed: "${message}"]`
    };
  }

  // Use resolved message if available
  const commandMessage = resolvedMessage || message;

  try {
    // Route based on intent type
    if (intent.type === 'command_guide') {
      logger.debug('[Node:ExecuteCommand] Educational guide mode');
      
      const result = await mcpAdapter.callService('command', 'command.guide', {
        command: commandMessage,
        context: {
          os: process.platform,
          userId: context?.userId,
          sessionId: context?.sessionId
        }
      });
      
      const resultData = result.data || result;
      
      return {
        ...state,
        answer: resultData.guide || resultData.result || '[No guide generated]',
        commandExecuted: true,
        guideMode: true
      };
    }
    
    if (intent.type === 'command_automate') {
      logger.debug('[Node:ExecuteCommand] UI automation mode');
      
      const result = await mcpAdapter.callService('command', 'command.automate', {
        command: commandMessage,
        intent: 'command_automate',
        context: {
          os: process.platform,
          userId: context?.userId,
          sessionId: context?.sessionId
        }
      });
      
      const resultData = result.data || result;
      
      // Handle clarification needed
      if (resultData.needsClarification) {
        const questions = resultData.clarificationQuestions || [];
        const questionText = questions.map((q, i) => `${i + 1}. ${q.question || q.text || q}`).join('\n');
        
        return {
          ...state,
          answer: `I need clarification:\n\n${questionText}\n\nPlease provide more details.`,
          commandExecuted: false,
          needsClarification: true,
          clarificationQuestions: questions
        };
      }
      
      // Return automation plan
      if (resultData.plan) {
        return {
          ...state,
          automationPlan: resultData.plan,
          commandExecuted: true,
          answer: `Automation plan generated with ${resultData.plan.steps?.length || 0} steps.`
        };
      }
      
      return {
        ...state,
        answer: resultData.result || resultData.message || '[Automation completed]',
        commandExecuted: true
      };
    }
    
    // Standard command execution
    logger.debug('[Node:ExecuteCommand] Standard execution mode');
    
    const result = await mcpAdapter.callService('command', 'command.execute', {
      command: commandMessage,
      context: {
        os: process.platform,
        userId: context?.userId,
        sessionId: context?.sessionId
      }
    });
    
    const resultData = result.data || result;
    
    if (!resultData.success) {
      return {
        ...state,
        answer: `Command failed: ${resultData.error || 'Unknown error'}`,
        commandExecuted: false,
        commandError: resultData.error
      };
    }
    
    // Format output for display
    const output = resultData.output || resultData.result || '[No output]';
    const answer = resultData.needsInterpretation 
      ? `Command executed. Output:\n\n${output}`
      : output;
    
    return {
      ...state,
      answer: answer,
      commandExecuted: true,
      commandOutput: output,
      executedCommand: commandMessage
    };
    
  } catch (error) {
    logger.error('[Node:ExecuteCommand] Error:', error.message);
    
    return {
      ...state,
      answer: `Error executing command: ${error.message}`,
      commandExecuted: false,
      error: error.message
    };
  }
};

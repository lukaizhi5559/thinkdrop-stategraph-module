/**
 * RealMCPAdapter - Real MCP service integration
 * 
 * Connects to actual MCP services via the existing MCPClient.
 * This adapter wraps your existing MCP infrastructure.
 */

const MCPAdapter = require('./MCPAdapter');

class RealMCPAdapter extends MCPAdapter {
  constructor(mcpClient, options = {}) {
    super();
    this.mcpClient = mcpClient;
    this.logger = options.logger || console;
  }

  async callService(serviceName, action, params, options = {}) {
    const maxRetries = options.maxRetries || (serviceName === 'user-memory' ? 3 : 1);
    const baseDelayMs = options.retryDelayMs || 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.debug(`[RealMCP] Calling ${serviceName}.${action} (attempt ${attempt}/${maxRetries})`);
        
        // Delegate to existing MCPClient — pass options so timeoutMs override works
        const result = await this.mcpClient.callService(serviceName, action, params, options);
        
        return result;
      } catch (error) {
        const isECONNREFUSED = error.message?.includes('ECONNREFUSED') || error.code === 'ECONNREFUSED';
        const isUserMemory = serviceName === 'user-memory';
        
        // Retry on ECONNREFUSED for user-memory service with exponential backoff
        if (isECONNREFUSED && isUserMemory && attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          this.logger.warn(`[RealMCP] ${serviceName}.${action} connection refused, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        
        this.logger.error(`[RealMCP] Error calling ${serviceName}.${action}:`, error.message);
        throw error;
      }
    }
  }

  async isServiceAvailable(serviceName) {
    try {
      // Use MCPClient's health check if available
      if (this.mcpClient.isServiceHealthy) {
        return await this.mcpClient.isServiceHealthy(serviceName);
      }
      
      // Fallback to parent implementation
      return await super.isServiceAvailable(serviceName);
    } catch (error) {
      return false;
    }
  }
}

module.exports = RealMCPAdapter;

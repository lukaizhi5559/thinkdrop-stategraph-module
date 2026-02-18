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

  async callService(serviceName, action, params) {
    try {
      this.logger.debug(`[RealMCP] Calling ${serviceName}.${action}`);
      
      // Delegate to existing MCPClient
      const result = await this.mcpClient.callService(serviceName, action, params);
      
      return result;
    } catch (error) {
      this.logger.error(`[RealMCP] Error calling ${serviceName}.${action}:`, error.message);
      throw error;
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

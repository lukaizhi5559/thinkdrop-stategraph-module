/**
 * MCPAdapter - Abstract interface for MCP service integration
 * 
 * Implementations can be:
 * - MockMCPAdapter: Returns mock data for testing
 * - RealMCPAdapter: Connects to actual MCP services
 * - CustomMCPAdapter: Your own implementation
 */

class MCPAdapter {
  /**
   * Call an MCP service
   * @param {string} serviceName - Service name (phi4, conversation, user-memory, etc.)
   * @param {string} action - Action to perform (intent.parse, message.list, etc.)
   * @param {Object} params - Action-specific parameters
   * @returns {Promise<Object>} Service response
   */
  async callService(serviceName, action, params) {
    throw new Error('MCPAdapter.callService() must be implemented by subclass');
  }

  /**
   * Check if a service is available
   * @param {string} serviceName - Service name
   * @returns {Promise<boolean>} True if service is available
   */
  async isServiceAvailable(serviceName) {
    try {
      // Try a lightweight health check
      await this.callService(serviceName, 'health.check', {});
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get list of available services
   * @returns {Promise<Array<string>>} Array of available service names
   */
  async getAvailableServices() {
    const services = ['phi4', 'conversation', 'user-memory', 'web-search', 'command', 'screen-intelligence', 'vision', 'coreference'];
    const available = [];
    
    for (const service of services) {
      if (await this.isServiceAvailable(service)) {
        available.push(service);
      }
    }
    
    return available;
  }
}

module.exports = MCPAdapter;

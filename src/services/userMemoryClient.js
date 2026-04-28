'use strict';

/**
 * User Memory Service Client
 * 
 * Provides semantic search and retrieval of user memories for context-aware
 * agent recommendations.
 */

const MEMORY_SERVICE_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

async function mcpPost(action, payload) {
  return new Promise((resolve) => {
    const http = require('http');
    const data = JSON.stringify({ action, payload, apiKey: MEM_API_KEY });
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: MEMORY_SERVICE_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
    
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    
    req.write(data);
    req.end();
  });
}

/**
 * Search user memories semantically
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Array>} Memory results
 */
async function searchMemories(query, options = {}) {
  const { topK = 10, filters = {}, timeWindow = '30d' } = options;
  
  try {
    const result = await mcpPost('memory.search', {
      query,
      topK,
      filters,
      timeWindow
    });
    
    return result?.data?.results || [];
  } catch (e) {
    console.error('[UserMemoryClient] searchMemories failed:', e.message);
    return [];
  }
}

/**
 * Search memories by entity type
 * @param {string} domain - Domain to search for
 * @param {string} entityType - Type of entity (domain, website, action)
 * @returns {Promise<Array>} Matching memories
 */
async function searchByEntity(domain, entityType = 'domain') {
  return searchMemories(`visits to ${domain}`, {
    filters: { entityTypes: [entityType, 'website', 'action'] },
    topK: 20
  });
}

/**
 * Calculate visit frequency from memories
 * @param {Array} memories - Memory results
 * @param {string} domain - Domain to count
 * @returns {Object} Frequency stats
 */
function calculateVisitFrequency(memories, domain) {
  if (!memories || memories.length === 0) {
    return { count: 0, firstVisit: null, lastVisit: null, frequency: 'none' };
  }
  
  const domainMemories = memories.filter(m => 
    m.content?.toLowerCase().includes(domain.toLowerCase()) ||
    m.entities?.some(e => e.name?.toLowerCase() === domain.toLowerCase())
  );
  
  const count = domainMemories.length;
  const timestamps = domainMemories.map(m => new Date(m.timestamp || m.created_at)).filter(d => !isNaN(d));
  
  if (timestamps.length === 0) {
    return { count, firstVisit: null, lastVisit: null, frequency: 'unknown' };
  }
  
  timestamps.sort((a, b) => a - b);
  const firstVisit = timestamps[0];
  const lastVisit = timestamps[timestamps.length - 1];
  
  // Calculate frequency
  const daysSinceFirst = (Date.now() - firstVisit.getTime()) / (1000 * 60 * 60 * 24);
  const frequency = daysSinceFirst > 0 ? count / daysSinceFirst : count;
  
  let frequencyLabel = 'low';
  if (frequency > 0.5) frequencyLabel = 'high'; // More than once every 2 days
  else if (frequency > 0.14) frequencyLabel = 'medium'; // More than once a week
  
  return {
    count,
    firstVisit: firstVisit.toISOString(),
    lastVisit: lastVisit.toISOString(),
    frequency,
    frequencyLabel,
    daysSinceFirst: Math.round(daysSinceFirst),
    daysSinceLast: Math.round((Date.now() - lastVisit.getTime()) / (1000 * 60 * 60 * 24))
  };
}

/**
 * Score task similarity between current prompt and past memories
 * @param {string} currentPrompt - Current user message
 * @param {Array} memories - Past memories
 * @returns {number} Similarity score 0-1
 */
function scoreTaskSimilarity(currentPrompt, memories) {
  if (!memories || memories.length === 0) return 0;
  
  const currentLower = currentPrompt.toLowerCase();
  const actionKeywords = ['buy', 'shop', 'purchase', 'search', 'find', 'compare', 'check', 'track', 'monitor', 'order'];
  
  // Find which action keywords are in current prompt
  const currentActions = actionKeywords.filter(kw => currentLower.includes(kw));
  
  if (currentActions.length === 0) return 0.5; // Neutral if no clear action
  
  // Count how many past memories share similar actions
  let similarCount = 0;
  memories.forEach(memory => {
    const content = (memory.content || '').toLowerCase();
    const sharedActions = currentActions.filter(action => content.includes(action));
    if (sharedActions.length > 0) similarCount++;
  });
  
  return Math.min(similarCount / Math.min(memories.length, 5), 1.0);
}

module.exports = {
  searchMemories,
  searchByEntity,
  calculateVisitFrequency,
  scoreTaskSimilarity,
  mcpPost
};

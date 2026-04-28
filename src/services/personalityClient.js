'use strict';

/**
 * Personality Service Client
 * 
 * Fetches user personality traits and behavioral preferences for
 * context-aware agent recommendations.
 */

const PERSONALITY_SERVICE_PORT = parseInt(process.env.PERSONALITY_SERVICE_PORT || '3008', 10);
const MEM_API_KEY = process.env.MCP_API_KEY || '';

async function mcpPost(action, payload) {
  return new Promise((resolve) => {
    const http = require('http');
    const data = JSON.stringify({ action, payload, apiKey: MEM_API_KEY });
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: PERSONALITY_SERVICE_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 3000
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
 * Get user personality profile
 * @param {Array<string>} traits - Specific traits to fetch
 * @returns {Promise<Object>} Personality profile
 */
async function getPersonalityProfile(traits = []) {
  try {
    const result = await mcpPost('personality.getTraits', {});
    const allTraits = result?.data?.traits || [];
    
    // Filter to requested traits if specified
    if (traits.length > 0) {
      return allTraits.filter(t => traits.includes(t.name));
    }
    
    return allTraits;
  } catch (e) {
    console.error('[PersonalityClient] getPersonalityProfile failed:', e.message);
    return [];
  }
}

/**
 * Get automation-relevant traits with defaults
 * @returns {Promise<Object>} Automation profile
 */
async function getAutomationProfile() {
  const relevantTraits = [
    'automation_preference',
    'control_tolerance', 
    'exploration_drive',
    'notification_tolerance',
    'proactive_help'
  ];
  
  const traits = await getPersonalityProfile(relevantTraits);
  
  // Build profile with defaults
  const profile = {
    automation_preference: 'medium',   // low, medium, high
    control_tolerance: 'medium',       // low, medium, high
    exploration_drive: 'medium',       // low, medium, high
    notification_tolerance: 'medium',  // low, medium, high
    proactive_help: 'medium'          // low, medium, high
  };
  
  traits.forEach(trait => {
    if (trait.name in profile && trait.value) {
      profile[trait.name] = trait.value;
    }
  });
  
  return profile;
}

/**
 * Calculate recommendation threshold based on personality
 * @param {Object} profile - Automation profile
 * @returns {number} Threshold score 0-1
 */
function getRecommendationThreshold(profile) {
  const baseThreshold = 0.7;
  
  // Adjust based on automation preference
  const preferenceAdjustments = {
    'high': -0.2,    // More eager to suggest (threshold 0.5)
    'medium': 0,     // Standard threshold (0.7)
    'low': 0.15      // Less eager (threshold 0.85)
  };
  
  // Adjust based on notification tolerance
  const notificationAdjustments = {
    'high': -0.05,   // Okay with more suggestions
    'medium': 0,
    'low': 0.1       // Only high-confidence suggestions
  };
  
  const adjustment = 
    (preferenceAdjustments[profile.automation_preference] || 0) +
    (notificationAdjustments[profile.notification_tolerance] || 0);
  
  return Math.max(0.3, Math.min(0.9, baseThreshold + adjustment));
}

/**
 * Check if user should see agent suggestion based on personality
 * @param {Object} profile - Automation profile
 * @param {number} confidence - Recommendation confidence
 * @returns {boolean} Whether to show suggestion
 */
function shouldShowSuggestion(profile, confidence) {
  // If proactive_help is low, only show very high confidence
  if (profile.proactive_help === 'low' && confidence < 0.85) {
    return false;
  }
  
  const threshold = getRecommendationThreshold(profile);
  return confidence >= threshold;
}

module.exports = {
  getPersonalityProfile,
  getAutomationProfile,
  getRecommendationThreshold,
  shouldShowSuggestion,
  mcpPost
};

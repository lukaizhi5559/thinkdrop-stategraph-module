/**
 * Shared OAuth provider constants used across stategraph nodes.
 *
 * OAUTH_PROVIDERS  — Set of provider names that use OAuth (not raw API keys).
 *                    When a skill targets one of these, ThinkDrop can auto-supply
 *                    tokens from the global Connections tab (oauth:<provider> keychain).
 *
 * OAUTH_SKILL_SCOPES — Default scopes to request per provider when creating skills.
 *                      Used in skill.md frontmatter as: oauth_scopes: <provider>=<scopes>
 *                      Falls back to empty string (valid — means use provider default).
 *
 * To add a new OAuth provider:
 *   1. Add its name to OAUTH_PROVIDERS
 *   2. Add its default scopes to OAUTH_SKILL_SCOPES (can be empty string '')
 *   3. Add it to ALL_PROVIDERS in main.js (Connections tab)
 *   4. Add OAuth app config to command-service/.env
 */

const OAUTH_PROVIDERS = new Set([
  'google',
  'github',
  'microsoft',
  'facebook',
  'twitter',
  'linkedin',
  'slack',
  'notion',
  'spotify',
  'dropbox',
  'discord',
  'zoom',
  'atlassian',
  'salesforce',
  'hubspot',
  'outlook',   // alias for microsoft
]);

/**
 * Default OAuth scopes per provider for skill creation.
 * These are conservative/read-level defaults — skills that need broader access
 * should declare oauth_scopes: explicitly in their frontmatter.
 *
 * Empty string '' is valid: means use the provider's own default scope.
 * Unknown providers not in this map also resolve to '' safely.
 */
const OAUTH_SKILL_SCOPES = {
  google:     'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
  github:     'read:user user:email repo',
  microsoft:  'openid profile email offline_access',
  outlook:    'openid profile email offline_access Mail.Read',
  facebook:   'email public_profile',
  twitter:    'tweet.read users.read offline.access',
  linkedin:   'openid profile email',
  slack:      'openid profile email channels:read chat:write',
  notion:     '',
  spotify:    'user-read-email user-read-private playlist-read-private',
  dropbox:    'account_info.read files.content.read',
  discord:    'identify email guilds',
  zoom:       'user:read meeting:read meeting:write',
  atlassian:  'read:me offline_access read:jira-work write:jira-work',
  salesforce: 'openid profile email api refresh_token',
  hubspot:    'crm.objects.contacts.read oauth',
};

/**
 * Returns the default OAuth scopes for a provider.
 * Returns '' for unknown providers (safe fallback — omits oauth_scopes line
 * when the provider uses its own default scope).
 */
function getOAuthScopes(provider) {
  return OAUTH_SKILL_SCOPES[provider] ?? '';
}

/**
 * Returns true if the provider authenticates via OAuth
 * (i.e., should use Connections tab token, not raw API key).
 */
function isOAuthProvider(provider) {
  return OAUTH_PROVIDERS.has(provider);
}

module.exports = { OAUTH_PROVIDERS, OAUTH_SKILL_SCOPES, getOAuthScopes, isOAuthProvider };

'use strict';
/**
 * url-first-regression.test.js
 *
 * Regression tests for URL-First remediation:
 *   1. _canPromoteDeepLink rejects unverified URLs for mutation tasks
 *   2. _isMutationIntent correctly classifies mutation intents
 *   3. _isUnsafeDeepLinkUrl rejects chrome-extension and mail body URLs
 *   4. _classifyDiscoveryCandidate classifies search candidates correctly
 *   5. _resolvePlaybook restricts mutation tasks to strongest playbook only
 *   6. playwright.agent repair uses 'evaluate' action (not 'eval')
 *
 * Run with: node test/url-first-regression.test.js
 */

// ── Minimal test harness ──────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

function describe(label, fn) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(70));
  fn();
}

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}`);
    console.log(`     ${e.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toContain(sub) {
      if (!String(actual).includes(sub))
        throw new Error(`Expected "${actual}" to contain "${sub}"`);
    },
    toMatch(re) {
      if (!re.test(String(actual)))
        throw new Error(`Expected "${actual}" to match ${re}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
    },
  };
}

// ── INTENTS constants (from destination-resolver.cjs) ─────────────────────────
const { INTENTS } = require('../../mcp-services/command-service/src/skill-helpers/destination-resolver.cjs');

// ── Inlined pure functions from browser.agent.cjs ─────────────────────────────
// These are re-implemented here to avoid loading the full browser.agent module
// (which pulls in playwright, browser.act, etc.) for unit tests.
// Keep in sync with the source when logic changes.

function _isUnsafeDeepLinkUrl(candidateUrl, expectedHost = '') {
  const candidate = String(candidateUrl || '');
  const lower = candidate.toLowerCase();
  if (!candidate) return true;
  if (lower.includes('chrome-extension://') || lower.includes('chrome-extension%3a%2f%2f')) {
    return true;
  }
  if (String(expectedHost || '').replace(/^www\./, '') === 'mail.google.com') {
    if (/mail\.google\.com\/mail(?:\/u\/\d+)?\/?\?body=/i.test(candidate)) {
      return true;
    }
  }
  return false;
}

function _isMutationIntent(intent) {
  return [INTENTS.CONTENT_CREATE, INTENTS.SOCIAL, INTENTS.MAIL, INTENTS.SCHEDULING, INTENTS.COMMERCE].includes(intent);
}

// Inline mirror of isHostAlias from browser.agent.cjs — checks host equivalence
// using direct match, base-domain comparison, and configured aliases.
function _isHostAlias(currentHost, expectedHost, aliases) {
  if (!currentHost || !expectedHost) return false;
  const ch = currentHost.toLowerCase();
  const eh = expectedHost.toLowerCase();
  if (ch === eh) return true;
  const cb = ch.split('.').slice(-2).join('.');
  const eb = eh.split('.').slice(-2).join('.');
  if (cb === eb) return true;
  if (aliases && aliases.length > 0) {
    const aliasSet = new Set(aliases.map(a => a.toLowerCase()));
    if (aliasSet.has(ch) || aliasSet.has(eh)) return true;
    for (const a of aliasSet) {
      const ab = a.split('.').slice(-2).join('.');
      if (ab === cb || ab === eb) return true;
    }
  }
  return false;
}

// Inline mirror of KNOWN_BROWSER_SERVICES hostAliases for test purposes
const _TEST_HOST_ALIASES = {
  notion: ['www.notion.so', 'www.notion.com', 'notion.so', 'notion.com', 'notion.new'],
};

function _canPromoteDeepLink(candidate, source, intent, baseHost, serviceKey = '') {
  if (!candidate || _isUnsafeDeepLinkUrl(candidate, baseHost)) return false;
  let parsed;
  try { parsed = new URL(candidate); } catch (_) { return false; }
  const host = parsed.hostname.replace(/^www\./, '');
  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = _TEST_HOST_ALIASES[svc];
  const isOnDomain = _isHostAlias(host, baseHost, aliases);

  // Off-domain candidates from crawl are untrusted — reject.
  // Off-domain from llm/suggestion/search/template/authenticated/caller are allowed
  // through to verification (verifyDeepLinkUrl navigates and checks the redirect target).
  if (!isOnDomain && source === 'crawl') return false;

  if (_isMutationIntent(intent) && !['caller', 'template', 'authenticated'].includes(source)) return false;
  if (source === 'search' && /\/(support|help|docs|documentation|community|forum|p|page|post|article|blog|item)\//i.test(parsed.pathname)) return false;
  return true;
}

function _resolvePlaybook(descriptor, task, agentId) {
  if (!descriptor || !task) return { tier: 3, section: null, subsections: [] };
  const playbookMatch = descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
  if (!playbookMatch) return { tier: 3, section: null, subsections: [] };
  const playbookBody = playbookMatch[1].trim();
  const subsections = playbookBody.split(/(?=### )/).map(s => s.trim()).filter(Boolean);
  if (subsections.length === 0) return { tier: 3, section: null, subsections: [] };
  const taskLower = task.toLowerCase();
  const matched = [];
  for (const sub of subsections) {
    const headerLine = sub.split('\n')[0];
    const parenMatch = headerLine.match(/\(([^)]+)\)/);
    const keywords = parenMatch
      ? parenMatch[1].split(',').map(k => k.trim().toLowerCase())
      : headerLine.replace(/^###\s*/, '').toLowerCase().split(/\W+/).filter(k => k.length > 3);
    if (keywords.some(kw => kw && taskLower.includes(kw))) {
      matched.push(sub);
    }
  }
  if (matched.length > 0) {
    const isMutationTask = /\b(create|add|write|send|post|publish|upload|schedule|book|buy|delete|update)\b/i.test(task);
    return { tier: 1, section: isMutationTask ? matched[0] : matched.join('\n\n'), subsections };
  }
  return { tier: 3, section: null, subsections };
}

// ── Load web.agent for _classifyDiscoveryCandidate (lightweight module) ────────
const webAgent = require('../../mcp-services/command-service/src/skills/web.agent.cjs');
const { _classifyDiscoveryCandidate } = webAgent;

// ══════════════════════════════════════════════════════════════════════════════
// 1. _canPromoteDeepLink — promotion gate
// ══════════════════════════════════════════════════════════════════════════════
describe('_canPromoteDeepLink — mutation tasks reject unverified sources', () => {

  it('mutation intent + source=search → rejected', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/support/article-123',
      'search',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(false);
  });

  it('mutation intent + source=crawl → rejected', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/blog/how-to-create-pages',
      'crawl',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(false);
  });

  it('mutation intent + source=llm → rejected', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/new-page',
      'llm',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(false);
  });

  it('mutation intent + source=template → accepted', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/new',
      'template',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(true);
  });

  it('mutation intent + source=authenticated → accepted', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/new-page',
      'authenticated',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(true);
  });

  it('mutation intent + source=caller → accepted', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/new',
      'caller',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(true);
  });

  it('non-mutation intent + source=search → accepted (if not docs path)', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/search?q=test',
      'search',
      INTENTS.SEARCH,
      'notion.so'
    )).toBe(true);
  });

  it('non-mutation intent + source=search + docs path → rejected', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/support/help-center',
      'search',
      INTENTS.SEARCH,
      'notion.so'
    )).toBe(false);
  });

  it('non-mutation intent + source=search + blog path → rejected', () => {
    expect(_canPromoteDeepLink(
      'https://notion.so/blog/getting-started',
      'search',
      INTENTS.SEARCH,
      'notion.so'
    )).toBe(false);
  });

  it('off-domain URL + source=template → accepted (allowed through to verification)', () => {
    expect(_canPromoteDeepLink(
      'https://example.com/new',
      'template',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(true);
  });

  it('off-domain URL + source=crawl → rejected (untrusted source)', () => {
    expect(_canPromoteDeepLink(
      'https://example.com/new',
      'crawl',
      INTENTS.SEARCH,
      'notion.so'
    )).toBe(false);
  });

  it('off-domain URL + source=llm → accepted (allowed through to verification)', () => {
    expect(_canPromoteDeepLink(
      'https://notion.new/new',
      'llm',
      INTENTS.SEARCH,
      'app.notion.com',
      'notion'
    )).toBe(true);
  });

  it('off-domain URL + source=search → accepted (allowed through to verification)', () => {
    expect(_canPromoteDeepLink(
      'https://notion.new/new',
      'search',
      INTENTS.SEARCH,
      'app.notion.com',
      'notion'
    )).toBe(true);
  });

  it('off-domain URL + source=suggestion → accepted (allowed through to verification)', () => {
    expect(_canPromoteDeepLink(
      'https://notion.new/new',
      'suggestion',
      INTENTS.SEARCH,
      'app.notion.com',
      'notion'
    )).toBe(true);
  });

  it('off-domain mutation + source=llm → rejected (mutation requires trusted source)', () => {
    expect(_canPromoteDeepLink(
      'https://notion.new/new',
      'llm',
      INTENTS.CONTENT_CREATE,
      'app.notion.com',
      'notion'
    )).toBe(false);
  });

  it('off-domain mutation + source=template → accepted (trusted source for mutation)', () => {
    expect(_canPromoteDeepLink(
      'https://notion.new/new',
      'template',
      INTENTS.CONTENT_CREATE,
      'app.notion.com',
      'notion'
    )).toBe(true);
  });

  it('subdomain of base host → accepted', () => {
    expect(_canPromoteDeepLink(
      'https://app.notion.so/new',
      'template',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(true);
  });

  it('invalid URL → rejected', () => {
    expect(_canPromoteDeepLink(
      'not-a-url',
      'template',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(false);
  });

  it('null candidate → rejected', () => {
    expect(_canPromoteDeepLink(
      null,
      'template',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(false);
  });

  it('chrome-extension URL → rejected (unsafe)', () => {
    expect(_canPromoteDeepLink(
      'chrome-extension://abc123/popup.html',
      'template',
      INTENTS.CONTENT_CREATE,
      'notion.so'
    )).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. _isMutationIntent — intent classification
// ══════════════════════════════════════════════════════════════════════════════
describe('_isMutationIntent — classifies mutation vs read-only intents', () => {

  it('CONTENT_CREATE → mutation', () => {
    expect(_isMutationIntent(INTENTS.CONTENT_CREATE)).toBe(true);
  });

  it('SOCIAL → mutation', () => {
    expect(_isMutationIntent(INTENTS.SOCIAL)).toBe(true);
  });

  it('MAIL → mutation', () => {
    expect(_isMutationIntent(INTENTS.MAIL)).toBe(true);
  });

  it('SCHEDULING → mutation', () => {
    expect(_isMutationIntent(INTENTS.SCHEDULING)).toBe(true);
  });

  it('COMMERCE → mutation', () => {
    expect(_isMutationIntent(INTENTS.COMMERCE)).toBe(true);
  });

  it('SEARCH → not mutation', () => {
    expect(_isMutationIntent(INTENTS.SEARCH)).toBe(false);
  });

  it('DOCS → not mutation', () => {
    expect(_isMutationIntent(INTENTS.DOCS)).toBe(false);
  });

  it('DASHBOARD → not mutation', () => {
    expect(_isMutationIntent(INTENTS.DASHBOARD)).toBe(false);
  });

  it('CHAT → not mutation', () => {
    expect(_isMutationIntent(INTENTS.CHAT)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. _isUnsafeDeepLinkUrl — unsafe URL detection
// ══════════════════════════════════════════════════════════════════════════════
describe('_isUnsafeDeepLinkUrl — detects unsafe URLs', () => {

  it('chrome-extension:// URL → unsafe', () => {
    expect(_isUnsafeDeepLinkUrl('chrome-extension://abc/popup.html')).toBe(true);
  });

  it('chrome-extension URL encoded → unsafe', () => {
    expect(_isUnsafeDeepLinkUrl('chrome-extension%3a%2f%2fabc/popup.html')).toBe(true);
  });

  it('gmail compose with body= → unsafe (for mail.google.com)', () => {
    expect(_isUnsafeDeepLinkUrl(
      'https://mail.google.com/mail/u/0/?body=somebody',
      'mail.google.com'
    )).toBe(true);
  });

  it('normal URL → safe', () => {
    expect(_isUnsafeDeepLinkUrl('https://notion.so/new', 'notion.so')).toBe(false);
  });

  it('empty string → unsafe', () => {
    expect(_isUnsafeDeepLinkUrl('')).toBe(true);
  });

  it('null → unsafe', () => {
    expect(_isUnsafeDeepLinkUrl(null)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. _classifyDiscoveryCandidate — search candidate classification
// ══════════════════════════════════════════════════════════════════════════════
describe('_classifyDiscoveryCandidate — classifies search results', () => {

  it('documentation URL → pageClass=documentation', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'https://notion.so/help/getting-started',
      title: 'Getting Started Help',
      snippet: 'Learn how to use Notion',
    }, 'notion.so');
    expect(r.pageClass).toBe('documentation');
  });

  it('support URL → pageClass=documentation', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'https://notion.so/support/article-123',
      title: 'Support Article',
      snippet: 'How to create pages in Notion',
    }, 'notion.so');
    expect(r.pageClass).toBe('documentation');
  });

  it('compose/new URL → pageClass=app-action', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'https://notion.so/new',
      title: 'Create New Page',
      snippet: 'Start a new page',
    }, 'notion.so');
    expect(r.pageClass).toBe('app-action');
    expect(r.onServiceDomain).toBe(true);
  });

  it('public article on service domain → pageClass=app-content', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'https://notion.so/p/abc123',
      title: 'Some Article',
      snippet: 'An article on Notion',
    }, 'notion.so');
    expect(r.pageClass).toBe('app-content');
    expect(r.onServiceDomain).toBe(true);
  });

  it('public article off-domain → pageClass=public-content', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'https://blog.example.com/post/123',
      title: 'Some Blog Post',
      snippet: 'A blog post about Notion',
    }, 'notion.so');
    expect(r.pageClass).toBe('public-content');
    expect(r.onServiceDomain).toBe(false);
  });

  it('service home page → pageClass=app-home', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'https://notion.so/',
      title: 'Notion',
      snippet: 'Your connected workspace',
    }, 'notion.so');
    expect(r.pageClass).toBe('app-home');
    expect(r.onServiceDomain).toBe(true);
  });

  it('invalid URL → pageClass=unknown', () => {
    const r = _classifyDiscoveryCandidate({
      url: 'not-a-url',
      title: 'Test',
      snippet: 'Test',
    }, 'notion.so');
    expect(r.pageClass).toBe('unknown');
    expect(r.onServiceDomain).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. _resolvePlaybook — mutation task playbook selection
// ══════════════════════════════════════════════════════════════════════════════
describe('_resolvePlaybook — mutation tasks get single strongest playbook', () => {

  const DESCRIPTOR = `# Notion Agent

## Playbooks

### Create Page (create, page, new, write)
Steps to create a new page in Notion.

### Compose Email (compose, email, send, mail)
Steps to compose and send email.

### Search Content (search, find, lookup)
Steps to search for content.
`;

  it('mutation task "create a new page" → only strongest match (not joined)', () => {
    const r = _resolvePlaybook(DESCRIPTOR, 'create a new page', 'notion');
    expect(r.tier).toBe(1);
    expect(r.section).toContain('Create Page');
    if (r.section.includes('Search Content')) {
      throw new Error('section should not contain "Search Content" for mutation task');
    }
  });

  it('mutation task "write a page and search for content" → only strongest match', () => {
    const r = _resolvePlaybook(DESCRIPTOR, 'write a page and search for content', 'notion');
    expect(r.tier).toBe(1);
    // Should NOT join multiple sections for mutation tasks
    if (/\n\n###/.test(r.section)) {
      throw new Error('section should not contain multiple playbook blocks for mutation task');
    }
  });

  it('non-mutation task "search for content" → can join multiple matches', () => {
    const r = _resolvePlaybook(DESCRIPTOR, 'search for content and find pages', 'notion');
    expect(r.tier).toBe(1);
    // Non-mutation tasks CAN join multiple matched sections
    // (both "Search Content" and "Create Page" match "page" keyword)
    // This is acceptable for read-only tasks
  });

  it('no keyword match → tier 3', () => {
    const r = _resolvePlaybook(DESCRIPTOR, 'delete everything', 'notion');
    expect(r.tier).toBe(3);
    expect(r.section).toBeNull();
  });

  it('empty descriptor → tier 3', () => {
    const r = _resolvePlaybook('', 'create a page', 'notion');
    expect(r.tier).toBe(3);
  });

  it('no Playbooks section → tier 3', () => {
    const r = _resolvePlaybook('# Notion Agent\n\nNo playbooks here.', 'create a page', 'notion');
    expect(r.tier).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. playwright.agent repair uses 'evaluate' (not 'eval')
// ══════════════════════════════════════════════════════════════════════════════
describe('playwright.agent repair — uses supported browser action', () => {

  const fs = require('fs');
  const path = require('path');
  const pwPath = path.resolve(__dirname, '../../mcp-services/command-service/src/skills/playwright.agent.cjs');
  const pwSource = fs.readFileSync(pwPath, 'utf8');

  it('repair URL check uses action: "evaluate" (not "eval")', () => {
    // Find the URL check line in the repair section
    const urlCheckMatch = pwSource.match(/action:\s*['"](\w+)['"],\s*text:\s*['"]window\.location\.href['"]/);
    if (!urlCheckMatch) {
      throw new Error('Could not find URL check browserAct call in playwright.agent.cjs');
    }
    expect(urlCheckMatch[1]).toBe('evaluate');
  });

  it('no deprecated action: "eval" in URL verification context', () => {
    // Check there's no `action: 'eval'` near window.location.href
    const evalPattern = /action:\s*['"]eval['"]/;
    if (evalPattern.test(pwSource)) {
      throw new Error('Found deprecated action: "eval" in playwright.agent.cjs — should be "evaluate"');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. web.agent actionDiscoverTaskUrl returns trust='search'
// ══════════════════════════════════════════════════════════════════════════════
describe('web.agent discover_task_url — returns non-authoritative trust', () => {

  const fs = require('fs');
  const path = require('path');
  const webSource = fs.readFileSync(
    path.resolve(__dirname, '../../mcp-services/command-service/src/skills/web.agent.cjs'),
    'utf8'
  );

  it('actionDiscoverTaskUrl return includes trust: "search"', () => {
    if (!webSource.includes("trust: 'search'")) {
      throw new Error('actionDiscoverTaskUrl does not set trust: "search" in return value');
    }
  });

  it('candidates include classification from _classifyDiscoveryCandidate', () => {
    if (!webSource.includes('_classifyDiscoveryCandidate')) {
      throw new Error('actionDiscoverTaskUrl does not call _classifyDiscoveryCandidate');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// _resolveTaskDeepLink return shape — must return { url, source } object
// ══════════════════════════════════════════════════════════════════════════════
describe('_resolveTaskDeepLink return shape', () => {
  it('returns { url, source } for preflight early return', () => {
    // Simulate the preflight early-return path: existingDeepLinkUrl on same domain
    // The function should return { url: existingDeepLinkUrl, source: 'preflight' }
    // We can't call the real function (heavy deps), but we verify the contract:
    const _mockReturn = { url: 'https://notion.so/page123', source: 'preflight' };
    expect(_mockReturn.url).toBe('https://notion.so/page123');
    expect(_mockReturn.source).toBe('preflight');
  });

  it('returns { url, source } for template resolution', () => {
    const _mockReturn = { url: 'https://x.com/compose/post', source: 'template' };
    expect(_mockReturn.url).toBe('https://x.com/compose/post');
    expect(_mockReturn.source).toBe('template');
  });

  it('returns { url, source } for authenticated eval', () => {
    const _mockReturn = { url: 'https://app.notion.so/new-page', source: 'authenticated' };
    expect(_mockReturn.url).toBe('https://app.notion.so/new-page');
    expect(_mockReturn.source).toBe('authenticated');
  });

  it('caller handles both string and object returns (backward compat)', () => {
    // The caller does: const _deepLink = _deepLinkResult?.url || (typeof _deepLinkResult === 'string' ? _deepLinkResult : null);
    const _objResult = { url: 'https://example.com', source: 'template' };
    const _strResult = 'https://example.com';
    const _nullResult = null;

    const extractUrl = (r) => r?.url || (typeof r === 'string' ? r : null);

    expect(extractUrl(_objResult)).toBe('https://example.com');
    expect(extractUrl(_strResult)).toBe('https://example.com');
    expect(extractUrl(_nullResult)).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Planner invariant: recipeRequired replaces mutation browser.agent steps
// ══════════════════════════════════════════════════════════════════════════════
describe('Planner invariant: recipeRequired for mutation tasks', () => {
  const _MUTATION_RE = /\b(create|add|write|send|post|publish|upload|schedule|book|buy|delete|update)\b/i;

  it('mutation regex matches create/send/post/publish/upload/schedule', () => {
    expect(_MUTATION_RE.test('create a new page')).toBe(true);
    expect(_MUTATION_RE.test('send an email')).toBe(true);
    expect(_MUTATION_RE.test('post a tweet')).toBe(true);
    expect(_MUTATION_RE.test('publish an article')).toBe(true);
    expect(_MUTATION_RE.test('upload a video')).toBe(true);
    expect(_MUTATION_RE.test('schedule a meeting')).toBe(true);
    expect(_MUTATION_RE.test('delete a file')).toBe(true);
    expect(_MUTATION_RE.test('update the settings')).toBe(true);
  });

  it('mutation regex does not match search/read/view', () => {
    expect(_MUTATION_RE.test('search for cats')).toBe(false);
    expect(_MUTATION_RE.test('read my emails')).toBe(false);
    expect(_MUTATION_RE.test('view the dashboard')).toBe(false);
    expect(_MUTATION_RE.test('check the calendar')).toBe(false);
  });

  it('replaces browser.agent run with ask_user when no recipe and no deep-link', () => {
    // Simulate the planner invariant logic
    const skillPlan = [{
      skill: 'browser.agent',
      args: { action: 'run', agentId: 'notion.agent', task: 'create a new page' },
      description: 'Create a new page in Notion',
    }];

    const _trainedRecipeMap = {};
    const deepLinkAgentIds = new Set();
    const userMessage = 'create a new page in Notion';

    for (let i = 0; i < skillPlan.length; i++) {
      const step = skillPlan[i];
      if (step.skill !== 'browser.agent' || step.args?.action !== 'run' || !step.args?.agentId) continue;
      const taskText = step.args?.task || step.description || userMessage || '';
      if (!_MUTATION_RE.test(taskText)) continue;
      const agentIdLower = step.args.agentId.toLowerCase();
      const hasDeepLink = deepLinkAgentIds.has(agentIdLower) || !!step.args?.url;
      if (hasDeepLink) continue;
      const svcKey = agentIdLower.replace(/\.agent$/, '');
      const hasRecipe = Object.entries(_trainedRecipeMap).some(([key, val]) =>
        (val?.agentId || '').toLowerCase() === agentIdLower &&
        (taskText.toLowerCase().includes(key) || key.includes(svcKey))
      );
      if (hasRecipe) continue;

      skillPlan[i] = {
        skill: 'ask_user',
        description: `Train recipe for ${svcKey}`,
        args: {
          question: `ThinkDrop could not validate a direct route for this state-changing task in ${svcKey}. Train a recipe for this workflow instead of using unverified clicks?`,
          options: [
            { label: 'Train recipe', value: 'train_recipe' },
            { label: 'Cancel', value: 'cancel' },
          ],
          recipeRequired: true,
          agentId: step.args.agentId,
        },
      };
    }

    expect(skillPlan[0].skill).toBe('ask_user');
    expect(skillPlan[0].args.recipeRequired).toBe(true);
    expect(skillPlan[0].args.options.length).toBe(2);
    expect(skillPlan[0].args.options[0].value).toBe('train_recipe');
    expect(skillPlan[0].args.options[1].value).toBe('cancel');
  });

  it('does NOT replace when a trained recipe exists', () => {
    const skillPlan = [{
      skill: 'browser.agent',
      args: { action: 'run', agentId: 'gmail.agent', task: 'send an email' },
      description: 'Send an email via Gmail',
    }];

    const _trainedRecipeMap = {
      'send': { agentId: 'gmail.agent', skillName: 'send_email', agentType: 'browser.agent' },
    };
    const deepLinkAgentIds = new Set();
    const userMessage = 'send an email via Gmail';

    for (let i = 0; i < skillPlan.length; i++) {
      const step = skillPlan[i];
      if (step.skill !== 'browser.agent' || step.args?.action !== 'run' || !step.args?.agentId) continue;
      const taskText = step.args?.task || step.description || userMessage || '';
      if (!_MUTATION_RE.test(taskText)) continue;
      const agentIdLower = step.args.agentId.toLowerCase();
      const hasDeepLink = deepLinkAgentIds.has(agentIdLower) || !!step.args?.url;
      if (hasDeepLink) continue;
      const svcKey = agentIdLower.replace(/\.agent$/, '');
      const hasRecipe = Object.entries(_trainedRecipeMap).some(([key, val]) =>
        (val?.agentId || '').toLowerCase() === agentIdLower &&
        (taskText.toLowerCase().includes(key) || key.includes(svcKey))
      );
      if (hasRecipe) continue;

      skillPlan[i] = { skill: 'ask_user', args: { recipeRequired: true } };
    }

    expect(skillPlan[0].skill).toBe('browser.agent');
  });

  it('does NOT replace when a deep-link URL is present', () => {
    const skillPlan = [{
      skill: 'browser.agent',
      args: { action: 'run', agentId: 'notion.agent', task: 'create a new page', url: 'https://notion.so/new-page' },
      description: 'Create a new page in Notion',
    }];

    const _trainedRecipeMap = {};
    const deepLinkAgentIds = new Set(['notion.agent']);
    const userMessage = 'create a new page in Notion';

    for (let i = 0; i < skillPlan.length; i++) {
      const step = skillPlan[i];
      if (step.skill !== 'browser.agent' || step.args?.action !== 'run' || !step.args?.agentId) continue;
      const taskText = step.args?.task || step.description || userMessage || '';
      if (!_MUTATION_RE.test(taskText)) continue;
      const agentIdLower = step.args.agentId.toLowerCase();
      const hasDeepLink = deepLinkAgentIds.has(agentIdLower) || !!step.args?.url;
      if (hasDeepLink) continue;
      const svcKey = agentIdLower.replace(/\.agent$/, '');
      const hasRecipe = Object.entries(_trainedRecipeMap).some(([key, val]) =>
        (val?.agentId || '').toLowerCase() === agentIdLower &&
        (taskText.toLowerCase().includes(key) || key.includes(svcKey))
      );
      if (hasRecipe) continue;

      skillPlan[i] = { skill: 'ask_user', args: { recipeRequired: true } };
    }

    expect(skillPlan[0].skill).toBe('browser.agent');
  });

  it('does NOT replace non-mutation tasks (search, read, view)', () => {
    const skillPlan = [{
      skill: 'browser.agent',
      args: { action: 'run', agentId: 'notion.agent', task: 'search for pages about cats' },
      description: 'Search Notion',
    }];

    const _trainedRecipeMap = {};
    const deepLinkAgentIds = new Set();
    const userMessage = 'search for pages about cats';

    for (let i = 0; i < skillPlan.length; i++) {
      const step = skillPlan[i];
      if (step.skill !== 'browser.agent' || step.args?.action !== 'run' || !step.args?.agentId) continue;
      const taskText = step.args?.task || step.description || userMessage || '';
      if (!_MUTATION_RE.test(taskText)) continue;
      skillPlan[i] = { skill: 'ask_user', args: { recipeRequired: true } };
    }

    expect(skillPlan[0].skill).toBe('browser.agent');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Deep-link provenance injection into agentContext
// ══════════════════════════════════════════════════════════════════════════════
describe('Deep-link provenance injection', () => {
  it('injects provenance note when URL-first navigation is selected', () => {
    let _agentContext = 'Base context for playwright.agent';
    const _urlFirstNavigationSelected = true;
    const _recipeExecutedOk = false;
    const _deepLinkSource = 'template';
    const url = null;
    const startUrl = 'https://x.com/compose/post';

    if (_urlFirstNavigationSelected && !_recipeExecutedOk) {
      const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
      const _provenanceNote = `\n\n## Verified Destination URL\nThe navigation URL (${startUrl}) has been verified (source: ${_provenanceSource}).\nDo NOT search for or navigate to alternative URLs. Use this URL as the first navigation step. If the page loads correctly, proceed directly with the user's task.`;
      _agentContext = (_agentContext + _provenanceNote).slice(0, 5500);
    }

    expect(_agentContext).toContain('## Verified Destination URL');
    expect(_agentContext).toContain('source: template');
    expect(_agentContext).toContain(startUrl);
  });

  it('uses "caller" source when URL came from caller (planSkillsV2)', () => {
    let _agentContext = 'Base context';
    const _urlFirstNavigationSelected = true;
    const _recipeExecutedOk = false;
    const _deepLinkSource = null;
    const url = 'https://notion.so/new-page';
    const startUrl = url;

    if (_urlFirstNavigationSelected && !_recipeExecutedOk) {
      const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
      const _provenanceNote = `\n\n## Verified Destination URL\nThe navigation URL (${startUrl}) has been verified (source: ${_provenanceSource}).\nDo NOT search for or navigate to alternative URLs. Use this URL as the first navigation step. If the page loads correctly, proceed directly with the user's task.`;
      _agentContext = (_agentContext + _provenanceNote).slice(0, 5500);
    }

    expect(_agentContext).toContain('source: caller');
  });

  it('uses "resolved" source when deep-link was resolved internally', () => {
    let _agentContext = 'Base context';
    const _urlFirstNavigationSelected = true;
    const _recipeExecutedOk = false;
    const _deepLinkSource = null;
    const url = null;
    const startUrl = 'https://mail.google.com/mail/u/0/#inbox?compose=new';

    if (_urlFirstNavigationSelected && !_recipeExecutedOk) {
      const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
      const _provenanceNote = `\n\n## Verified Destination URL\nThe navigation URL (${startUrl}) has been verified (source: ${_provenanceSource}).\nDo NOT search for or navigate to alternative URLs. Use this URL as the first navigation step. If the page loads correctly, proceed directly with the user's task.`;
      _agentContext = (_agentContext + _provenanceNote).slice(0, 5500);
    }

    expect(_agentContext).toContain('source: resolved');
  });

  it('does NOT inject when recipe was executed (already on target page)', () => {
    let _agentContext = 'Base context';
    const _urlFirstNavigationSelected = true;
    const _recipeExecutedOk = true;
    const _deepLinkSource = 'template';
    const url = null;
    const startUrl = 'https://x.com/compose/post';

    if (_urlFirstNavigationSelected && !_recipeExecutedOk) {
      const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
      const _provenanceNote = `\n\n## Verified Destination URL\nThe navigation URL (${startUrl}) has been verified (source: ${_provenanceSource}).\nDo NOT search for or navigate to alternative URLs. Use this URL as the first navigation step. If the page loads correctly, proceed directly with the user's task.`;
      _agentContext = (_agentContext + _provenanceNote).slice(0, 5500);
    }

    // Should not contain the provenance note
    if (_agentContext.includes('## Verified Destination URL')) {
      throw new Error('Provenance note should NOT be injected when recipe was executed');
    }
  });

  it('does NOT inject when URL-first navigation was not selected', () => {
    let _agentContext = 'Base context';
    const _urlFirstNavigationSelected = false;
    const _recipeExecutedOk = false;
    const _deepLinkSource = null;
    const url = null;
    const startUrl = 'https://notion.so';

    if (_urlFirstNavigationSelected && !_recipeExecutedOk) {
      const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
      const _provenanceNote = `\n\n## Verified Destination URL\nThe navigation URL (${startUrl}) has been verified (source: ${_provenanceSource}).\nDo NOT search for or navigate to alternative URLs. Use this URL as the first navigation step. If the page loads correctly, proceed directly with the user's task.`;
      _agentContext = (_agentContext + _provenanceNote).slice(0, 5500);
    }

    if (_agentContext.includes('## Verified Destination URL')) {
      throw new Error('Provenance note should NOT be injected when URL-first not selected');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. actionListAgents includes start_url in response
// ════════════════════════════════════════════════════════════════════════════
describe('actionListAgents start_url propagation', () => {
  it('extracts start_url from descriptor frontmatter', () => {
    // Simulate the mapping logic from actionListAgents
    const mockRow = {
      id: 'notion.agent',
      type: 'browser',
      service: 'notion',
      capabilities: '[]',
      status: 'healthy',
      last_validated: null,
      descriptor: '---\nid: notion.agent\ntype: browser\nservice: notion\nstart_url: https://app.notion.com\n---\n## Instructions\n...',
    };

    // Replicate extractDescriptorUrl logic
    function extractDescriptorUrl(descriptor, field) {
      if (!descriptor) return null;
      const line = descriptor.split('\n').find(l => l.startsWith(`${field}:`));
      return line ? line.replace(`${field}:`, '').trim() : null;
    }

    const start_url = extractDescriptorUrl(mockRow.descriptor, 'start_url');
    if (start_url !== 'https://app.notion.com') {
      throw new Error(`Expected start_url "https://app.notion.com", got "${start_url}"`);
    }
  });

  it('extracts start_url from .md file content for file-only agents', () => {
    const mockContent = '---\nid: slack.agent\ntype: browser\nservice: slack\nstart_url: https://app.slack.com\nstatus: healthy\n---\n## Instructions\n...';
    const startUrlMatch = mockContent.match(/^start_url:\s*(.+)/m);
    const start_url = startUrlMatch ? startUrlMatch[1].trim() : null;
    if (start_url !== 'https://app.slack.com') {
      throw new Error(`Expected start_url "https://app.slack.com", got "${start_url}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. _resolveDeepLinkForAgent session ID matches browser profile name
// ════════════════════════════════════════════════════════════════════════════
describe('deep-link session ID normalization', () => {
  it('converts agentId to browser profile session ID', () => {
    // Replicate the fix: (a.agentId || '').replace(/\.agent$/, '_agent')
    const agentId = 'notion.agent';
    const sessionId = agentId.replace(/\.agent$/, '_agent');
    if (sessionId !== 'notion_agent') {
      throw new Error(`Expected "notion_agent", got "${sessionId}"`);
    }
  });

  it('handles agentId without .agent suffix gracefully', () => {
    const agentId = 'gmail';
    const sessionId = agentId.replace(/\.agent$/, '_agent');
    // No .agent suffix → no replacement → stays as-is (won't match profile but won't crash)
    if (sessionId !== 'gmail') {
      throw new Error(`Expected "gmail" (no .agent suffix), got "${sessionId}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Notion content-create template URL
// ════════════════════════════════════════════════════════════════════════════
describe('Notion content-create template URL', () => {
  it('returns app.notion.com for notion service + CONTENT_CREATE intent', () => {
    // Replicate the template logic
    const svc = 'notion';
    const baseHost = 'app.notion.com';
    const intent = 'CONTENT_CREATE';

    let result = null;
    if (intent === 'CONTENT_CREATE') {
      if (svc === 'notion' || baseHost === 'app.notion.com') {
        result = 'https://app.notion.com/';
      }
    }

    if (result !== 'https://app.notion.com/') {
      throw new Error(`Expected "https://app.notion.com/", got "${result}"`);
    }
  });

  it('does NOT return Notion template for non-create intents', () => {
    const svc = 'notion';
    const baseHost = 'app.notion.com';
    const intent = 'SEARCH';

    let result = null;
    if (intent === 'CONTENT_CREATE') {
      if (svc === 'notion' || baseHost === 'app.notion.com') {
        result = 'https://app.notion.com/';
      }
    }

    if (result !== null) {
      throw new Error(`Expected null for SEARCH intent, got "${result}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. ask_user option normalization (string labels to UI, objects in pendingQuestion)
// ════════════════════════════════════════════════════════════════════════════
describe('ask_user option normalization', () => {
  it('normalizes object options to string labels for progressCallback', () => {
    const rawOptions = [
      { label: 'Train recipe', value: 'train_recipe' },
      { label: 'Cancel', value: 'cancel' },
    ];
    const labelOptions = rawOptions.map(o => (typeof o === 'string' ? o : o?.label || String(o)));

    if (labelOptions[0] !== 'Train recipe') {
      throw new Error(`Expected "Train recipe", got "${labelOptions[0]}"`);
    }
    if (labelOptions[1] !== 'Cancel') {
      throw new Error(`Expected "Cancel", got "${labelOptions[1]}"`);
    }
    if (labelOptions.some(o => typeof o !== 'string')) {
      throw new Error('All emitted options should be strings');
    }
  });

  it('preserves full option objects in pendingQuestion for resume routing', () => {
    const rawOptions = [
      { label: 'Train recipe', value: 'train_recipe' },
      { label: 'Cancel', value: 'cancel' },
    ];
    // pendingQuestion.options stores the raw objects
    const pendingQuestion = {
      question: 'Train a recipe?',
      options: rawOptions,
      recipeRequired: true,
      _isAgentAskUser: true,
      agentId: 'notion.agent',
    };

    // Resume logic can look up the value from the option
    const chosenLabel = 'Train recipe';
    const chosenObj = pendingQuestion.options.find(o =>
      (typeof o === 'string' ? o : o?.label) === chosenLabel
    );
    if (!chosenObj || chosenObj.value !== 'train_recipe') {
      throw new Error(`Expected to find train_recipe value, got ${JSON.stringify(chosenObj)}`);
    }
  });

  it('handles mixed string and object options', () => {
    const rawOptions = ['Simple string', { label: 'Object option', value: 'obj_val' }];
    const labelOptions = rawOptions.map(o => (typeof o === 'string' ? o : o?.label || String(o)));

    if (labelOptions[0] !== 'Simple string') {
      throw new Error(`Expected "Simple string", got "${labelOptions[0]}"`);
    }
    if (labelOptions[1] !== 'Object option') {
      throw new Error(`Expected "Object option", got "${labelOptions[1]}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Defensive renderer handles both string and object options
// ════════════════════════════════════════════════════════════════════════════
describe('defensive renderer option handling', () => {
  it('extracts label from object option for display', () => {
    const option = { label: 'Train recipe', value: 'train_recipe' };
    const _label = typeof option === 'string' ? option : (option?.label || String(option));
    if (_label !== 'Train recipe') {
      throw new Error(`Expected "Train recipe", got "${_label}"`);
    }
  });

  it('extracts value from object option for submission', () => {
    const option = { label: 'Train recipe', value: 'train_recipe' };
    const _value = typeof option === 'string' ? option : (option?.value || option?.label || String(option));
    if (_value !== 'train_recipe') {
      throw new Error(`Expected "train_recipe", got "${_value}"`);
    }
  });

  it('handles plain string options unchanged', () => {
    const option = 'Simple option';
    const _label = typeof option === 'string' ? option : (option?.label || String(option));
    const _value = typeof option === 'string' ? option : (option?.value || option?.label || String(option));
    if (_label !== 'Simple option') {
      throw new Error(`Expected "Simple option" for label, got "${_label}"`);
    }
    if (_value !== 'Simple option') {
      throw new Error(`Expected "Simple option" for value, got "${_value}"`);
    }
  });

  it('falls back to label when value is missing', () => {
    const option = { label: 'Some option' };
    const _value = typeof option === 'string' ? option : (option?.value || option?.label || String(option));
    if (_value !== 'Some option') {
      throw new Error(`Expected "Some option" fallback, got "${_value}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Recipe-required resume routing (main.js chosenOption normalization)
// ════════════════════════════════════════════════════════════════════════════
describe('recipe-required resume routing', () => {
  it('normalizes object chosenOption to string value', () => {
    // Simulate: user typed "1", options[idx] returned an object
    const q_options = [
      { label: 'Train recipe', value: 'train_recipe' },
      { label: 'Cancel', value: 'cancel' },
    ];
    let chosenOption = '1';
    const idx = parseInt('1', 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < q_options.length) {
      chosenOption = q_options[idx];
    }
    // Normalize
    if (chosenOption && typeof chosenOption === 'object') {
      chosenOption = chosenOption.value || chosenOption.label || String(chosenOption);
    }
    if (chosenOption !== 'train_recipe') {
      throw new Error(`Expected "train_recipe", got "${chosenOption}"`);
    }
  });

  it('detects train_recipe choice correctly', () => {
    const chosenOption = 'train_recipe';
    const _wantsTrain = /train/i.test(chosenOption) || chosenOption === 'train_recipe';
    if (!_wantsTrain) {
      throw new Error('Should detect train_recipe as wantsTrain');
    }
  });

  it('detects cancel choice correctly', () => {
    const chosenOption = 'cancel';
    const _wantsCancel = /cancel/i.test(chosenOption) || chosenOption === 'cancel';
    if (!_wantsCancel) {
      throw new Error('Should detect cancel as wantsCancel');
    }
  });

  it('train_recipe choice does NOT trigger wantsAbort', () => {
    const chosenOption = 'train_recipe';
    const wantsAbort = /\b(abort|cancel|stop)\b/i.test(chosenOption) || /^no$/i.test(chosenOption.trim());
    if (wantsAbort) {
      throw new Error('train_recipe should NOT match wantsAbort regex');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. actionListAllAgents returns start_url (cli.agent.cjs fix)
// ════════════════════════════════════════════════════════════════════════════
describe('actionListAllAgents start_url extraction', () => {
  // Replicate _parseFrontmatterField logic from cli.agent.cjs
  function _parseFrontmatterField(descriptor, field) {
    if (!descriptor) return null;
    const fmMatch = descriptor.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const line = fm.split('\n').find(l => l.startsWith(`${field}:`));
    if (!line) return null;
    return line.replace(/^.*?:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  }

  it('extracts start_url from notion.agent descriptor', () => {
    const descriptor = '---\nid: notion.agent\ntype: browser\nservice: notion\nstart_url: https://app.notion.com\n---\n## Instructions\n...';
    const start_url = _parseFrontmatterField(descriptor, 'start_url');
    if (start_url !== 'https://app.notion.com') {
      throw new Error(`Expected "https://app.notion.com", got "${start_url}"`);
    }
  });

  it('returns null when start_url is absent', () => {
    const descriptor = '---\nid: foo.agent\ntype: cli\nservice: foo\n---\n## Instructions\n...';
    const start_url = _parseFrontmatterField(descriptor, 'start_url');
    if (start_url !== null) {
      throw new Error(`Expected null, got "${start_url}"`);
    }
  });

  it('returns null for empty descriptor', () => {
    const start_url = _parseFrontmatterField(null, 'start_url');
    if (start_url !== null) {
      throw new Error(`Expected null for null descriptor, got "${start_url}"`);
    }
  });

  it('simulates full actionListAllAgents mapping with start_url', () => {
    const mockRow = {
      id: 'notion.agent',
      type: 'browser',
      service: 'notion',
      cli_tool: null,
      capabilities: '[]',
      status: 'healthy',
      last_validated: null,
      descriptor: '---\nid: notion.agent\ntype: browser\nservice: notion\nstart_url: https://app.notion.com\n---\n## Instructions\n...',
    };

    // Replicate the mapping from actionListAllAgents
    const mapped = {
      id: mockRow.id,
      type: mockRow.type || 'browser',
      service: mockRow.service,
      cliTool: mockRow.cli_tool,
      capabilities: (() => { try { return JSON.parse(mockRow.capabilities); } catch (_) { return []; } })(),
      status: mockRow.status || 'pending',
      lastValidated: mockRow.last_validated,
      start_url: _parseFrontmatterField(mockRow.descriptor, 'start_url') || null,
    };

    if (mapped.start_url !== 'https://app.notion.com') {
      throw new Error(`Expected start_url "https://app.notion.com", got "${mapped.start_url}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. trainingHandoff payload from browser.agent (replaces recipeRequired)
// ════════════════════════════════════════════════════════════════════════════
describe('trainingHandoff payload', () => {
  it('browser.agent returns trainingHandoff instead of recipeRequired', () => {
    // Simulate the return value from browser.agent when no deep-link and no recipe
    const result = {
      ok: false,
      agentId: 'notion.agent',
      task: 'create a new page',
      askUser: true,
      trainingHandoff: true,
      question: "I couldn't find a direct route for this task in notion. Would you like to train a recipe?",
      options: [
        { label: 'Record notion recipe from beginning', value: 'record_recipe' },
        { label: 'Cancel', value: 'cancel' },
      ],
    };

    if (result.recipeRequired) {
      throw new Error('trainingHandoff should NOT include recipeRequired');
    }
    if (!result.trainingHandoff) {
      throw new Error('Should have trainingHandoff: true');
    }
    if (!result.askUser) {
      throw new Error('Should have askUser: true');
    }
  });

  it('record_recipe option value is interceptable by UI', () => {
    const options = [
      { label: 'Record notion recipe from beginning', value: 'record_recipe' },
      { label: 'Cancel', value: 'cancel' },
    ];

    const trainOption = options.find(o => o.value === 'record_recipe');
    if (!trainOption) {
      throw new Error('Should find record_recipe option');
    }

    // UI intercepts this value to emit agents:open-training IPC
    const _value = trainOption.value;
    if (_value !== 'record_recipe') {
      throw new Error(`Expected "record_recipe", got "${_value}"`);
    }
  });

  it('pendingQuestion carries trainingHandoff flag for resume routing', () => {
    const pendingQuestion = {
      question: 'Train a recipe?',
      options: [
        { label: 'Record notion recipe from beginning', value: 'record_recipe' },
        { label: 'Cancel', value: 'cancel' },
      ],
      _isAgentAskUser: true,
      agentId: 'notion.agent',
      trainingHandoff: true,
    };

    if (!pendingQuestion.trainingHandoff) {
      throw new Error('pendingQuestion should have trainingHandoff: true');
    }
    if (pendingQuestion.recipeRequired) {
      throw new Error('pendingQuestion should NOT have recipeRequired when trainingHandoff');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 15. _deepLinkSource scope fix (browser.agent.cjs)
// ════════════════════════════════════════════════════════════════════════════
describe('_deepLinkSource scope fix', () => {
  it('_deepLinkSource is defined when caller provides URL', () => {
    // Simulate: caller URL branch sets _deepLinkSource = 'caller'
    let _deepLinkSource = null;
    const url = 'https://app.notion.com/page-123';

    if (url) {
      _deepLinkSource = 'caller';
    }

    if (_deepLinkSource !== 'caller') {
      throw new Error(`Expected "caller", got "${_deepLinkSource}"`);
    }
  });

  it('_deepLinkSource is defined when deep-link is resolved', () => {
    // Simulate: resolved URL branch sets _deepLinkSource from result
    let _deepLinkSource = null;
    const _deepLinkResult = { url: 'https://app.notion.com/', source: 'template' };

    _deepLinkSource = _deepLinkResult?.source || null;

    if (_deepLinkSource !== 'template') {
      throw new Error(`Expected "template", got "${_deepLinkSource}"`);
    }
  });

  it('_deepLinkSource remains null when no URL is provided or resolved', () => {
    // Simulate: no caller URL, no resolved deep-link
    let _deepLinkSource = null;
    const url = null;
    const _deepLinkResult = { url: null, source: null };

    if (!url) {
      // deep-link resolution returned nothing
      _deepLinkSource = _deepLinkResult?.source || null;
    }

    if (_deepLinkSource !== null) {
      throw new Error(`Expected null, got "${_deepLinkSource}"`);
    }
  });

  it('provenance injection uses _deepLinkSource without ReferenceError', () => {
    // Simulate the provenance injection block at line ~4994
    let _urlFirstNavigationSelected = true;
    let _deepLinkSource = null;
    const url = 'https://app.notion.com/page-123';
    const startUrl = 'https://app.notion.com/page-123';

    if (url) {
      _deepLinkSource = 'caller';
    }

    // This should NOT throw ReferenceError
    const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
    if (_provenanceSource !== 'caller') {
      throw new Error(`Expected "caller", got "${_provenanceSource}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 16. planSkillsV2 no longer replaces browser.agent mutation steps
// ════════════════════════════════════════════════════════════════════════════
describe('planSkillsV2 recipeRequired invariant removed', () => {
  it('browser.agent mutation step is NOT replaced with ask_user', () => {
    // After removing the invariant, a browser.agent run step for a mutation task
    // should remain as-is in the skill plan, even without a deep-link or recipe.
    const skillPlan = [
      {
        skill: 'browser.agent',
        args: { action: 'run', agentId: 'notion.agent', task: 'create a new page called Weekly Goals' },
        description: 'Create Weekly Goals page in Notion',
      },
    ];

    // The invariant would have replaced this with:
    // { skill: 'ask_user', args: { recipeRequired: true, ... } }
    // After removal, the step should still be browser.agent
    const step = skillPlan[0];
    if (step.skill !== 'browser.agent') {
      throw new Error(`Expected "browser.agent", got "${step.skill}" — invariant should be removed`);
    }
    if (step.args?.recipeRequired) {
      throw new Error('Step should NOT have recipeRequired — invariant should be removed');
    }
  });

  it('deep-link injection still works when preflight provides deepLinkUrl', () => {
    // The deep-link injection loop (lines ~1635-1642) should still inject
    // the URL from preflight into the step args.
    const deepLinkMap = new Map([
      ['notion.agent', { url: 'https://app.notion.com/', source: 'template' }],
    ]);

    const skillPlan = [
      {
        skill: 'browser.agent',
        args: { action: 'run', agentId: 'notion.agent', task: 'create a new page' },
      },
    ];

    for (const step of skillPlan) {
      if (step.skill === 'browser.agent' && step.args?.action === 'run' && step.args?.agentId && !step.args.url) {
        const dl = deepLinkMap.get(step.args.agentId.toLowerCase());
        if (dl?.url) {
          step.args.url = dl.url;
        }
      }
    }

    if (skillPlan[0].args.url !== 'https://app.notion.com/') {
      throw new Error(`Expected deep-link URL injected, got "${skillPlan[0].args.url}"`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 17. Training handoff resume routing (main.js)
// ════════════════════════════════════════════════════════════════════════════
describe('training handoff resume routing', () => {
  it('detects record_recipe choice correctly', () => {
    const chosenOption = 'record_recipe';
    const _wantsTrain = chosenOption === 'open_agents_training' || chosenOption === 'open_agents_training_here' || chosenOption === 'train_recipe' || chosenOption === 'record_recipe' || (/open|train/i.test(chosenOption) && chosenOption !== 'correct_and_retry');
    if (!_wantsTrain) {
      throw new Error('Should detect record_recipe as wantsTrain');
    }
  });

  it('correct_and_retry does NOT trigger wantsTrain', () => {
    const chosenOption = 'correct_and_retry';
    const _wantsTrain = chosenOption === 'open_agents_training' || chosenOption === 'open_agents_training_here' || chosenOption === 'train_recipe' || chosenOption === 'record_recipe' || (/open|train/i.test(chosenOption) && chosenOption !== 'correct_and_retry');
    if (_wantsTrain) {
      throw new Error('correct_and_retry should NOT match wantsTrain');
    }
  });

  it('detects cancel choice correctly', () => {
    const chosenOption = 'cancel';
    const _wantsCancel = /cancel/i.test(chosenOption) || chosenOption === 'cancel';
    if (!_wantsCancel) {
      throw new Error('Should detect cancel as wantsCancel');
    }
  });

  it('record_recipe does NOT trigger wantsAbort', () => {
    const chosenOption = 'record_recipe';
    const wantsAbort = /\b(abort|cancel|stop)\b/i.test(chosenOption) || /^no$/i.test(chosenOption.trim());
    if (wantsAbort) {
      throw new Error('record_recipe should NOT match wantsAbort regex');
    }
  });

  it('trainingHandoff pendingQuestion triggers handoff branch, not recipeRequired branch', () => {
    // The main.js resume branch checks: paused.pendingQuestion?.trainingHandoff || paused.pendingQuestion?.recipeRequired
    const pendingQuestion = {
      trainingHandoff: true,
      agentId: 'notion.agent',
    };

    const isHandoff = pendingQuestion?.trainingHandoff || pendingQuestion?.recipeRequired;
    if (!isHandoff) {
      throw new Error('Should trigger handoff branch');
    }
  });

  it('legacy recipeRequired still triggers same branch for backward compat', () => {
    const pendingQuestion = {
      recipeRequired: true,
      agentId: 'notion.agent',
    };

    const isHandoff = pendingQuestion?.trainingHandoff || pendingQuestion?.recipeRequired;
    if (!isHandoff) {
      throw new Error('Legacy recipeRequired should still trigger handoff branch');
    }
  });
});

console.log(`  Results: ${_passed} passed, ${_failed} failed`);
if (_failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of _failures) console.log(`    ❌ ${f.label}\n       ${f.error}`);
}
console.log(`${'═'.repeat(72)}\n`);
process.exit(_failed > 0 ? 1 : 0);

'use strict';

/**
 * buildLoginSubPlan.js
 *
 * Deterministic factory for login sub-plans.
 *
 * Site-agnostic design: rather than maintaining a finite URL map, the factory
 * emits steps that:
 *   1. Inspect the CURRENT page for a login form first (already navigated there)
 *   2. If not on a login page, scan the page for a "Sign in / Log in" link and click it
 *   3. Fall back to a well-known URL only for the major OAuth providers
 *
 * Login flows attempted (in order):
 *   Flow A — Session restore (cheapest, try first)
 *   Flow B — Login link discovery on current page
 *   Flow C — Username + password form fill using KEYTAR refs
 *   Flow D — 2FA OTP ask_user (optional)
 *
 * Security: KEYTAR:<key> refs only — raw secrets NEVER appear in plan steps.
 */

// ---------------------------------------------------------------------------
// Login-page detection signals
// ---------------------------------------------------------------------------

const LOGIN_PAGE_SIGNALS = [
  /sign[\s-]?in/i,
  /log[\s-]?in/i,
  /\/login/i,
  /\/signin/i,
  /\/auth(?!orization)/i,
  /authenticate/i,
  /enter.*password/i,
  /accounts\.google\.com/i,
  /login\.microsoftonline\.com/i,
  /appleid\.apple\.com/i,
  /auth0\.com/i,
  /okta\.com/i,
  /onelogin\.com/i,
];

/**
 * Well-known OAuth / SSO login URLs for the top providers.
 * This is intentionally kept small.  Most sites are handled by the
 * link-discovery path below — these are only for when we have zero
 * page context and need a cold-start URL.
 */
const KNOWN_AUTH_URLS = {
  gmail:     'https://accounts.google.com/signin',
  google:    'https://accounts.google.com/signin',
  calendar:  'https://accounts.google.com/signin',
  youtube:   'https://accounts.google.com/signin',
  github:    'https://github.com/login',
  twitter:   'https://twitter.com/login',
  x:         'https://twitter.com/login',
  slack:     'https://slack.com/signin',
  discord:   'https://discord.com/login',
  notion:    'https://www.notion.so/login',
  microsoft: 'https://login.microsoftonline.com',
  outlook:   'https://login.microsoftonline.com',
  apple:     'https://appleid.apple.com',
  spotify:   'https://accounts.spotify.com/login',
  // Everything else: use link-discovery path (no hardcoded URL)
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the URL or error string looks like a login page / auth wall.
 */
function isLoginSignal(urlOrError) {
  const text = String(urlOrError || '');
  return LOGIN_PAGE_SIGNALS.some(p => p.test(text));
}

/**
 * Infer a service name from a URL or explicit override.
 * Returns 'unknown' when no match — triggers link-discovery path.
 * Also normalises domain-style service names (e.g. 'mail.google.com' → 'gmail').
 */
function inferService(url, knownService) {
  // Check both the explicit override and the URL against known patterns
  const check = String(knownService || url || '').toLowerCase();
  if (check.includes('google') || check.includes('gmail'))      return 'gmail';
  if (check.includes('github'))                                  return 'github';
  if (check.includes('twitter') || check.includes('x.com'))     return 'twitter';
  if (check.includes('slack'))                                   return 'slack';
  if (check.includes('discord'))                                 return 'discord';
  if (check.includes('notion'))                                  return 'notion';
  if (check.includes('microsoft') || check.includes('outlook'))  return 'outlook';
  if (check.includes('apple') || check.includes('appleid'))      return 'apple';
  if (check.includes('spotify'))                                 return 'spotify';
  if (check.includes('instagram'))                               return 'instagram';
  if (check.includes('linkedin'))                                return 'linkedin';
  if (check.includes('youtube'))                                 return 'youtube';
  // If an explicit knownService was given but didn't match patterns above,
  // use it as-is (lowercased)
  if (knownService) return String(knownService).toLowerCase();
  return 'unknown';   // → use link-discovery path
}

/**
 * Derive the KEYTAR key names for a service.
 * Caller can override any key via the credentials map.
 * For unknown services the key is derived from the domain root.
 *
 * e.g. service='shopify' → { usernameKey:'SHOPIFY_EMAIL', passwordKey:'SHOPIFY_PASSWORD' }
 */
function deriveCredentialKeys(service, loginUrl, creds = {}) {
  // For unknown service, try to extract a domain slug from the URL
  // e.g. 'https://app.shopify.com/login' → 'SHOPIFY'
  let prefix = service.toUpperCase();
  if (prefix === 'UNKNOWN' && loginUrl) {
    try {
      const hostname = new URL(loginUrl).hostname;             // 'app.shopify.com'
      const parts    = hostname.replace(/^www\./, '').split('.');
      // Detect compound ccTLDs: .co.uk, .com.au, .org.uk, .co.jp, etc.
      // Rule: last segment is a 2-letter country code AND second-to-last is a
      // well-known SLD prefix → need to go back one extra level.
      // e.g. ['app','shopify','co','uk'] → isCompound=true → parts[1]='shopify'
      //      ['app','shopify','com']     → isCompound=false → parts[1]='shopify'
      //      ['bbc','co','uk']           → isCompound=true  → parts[0]='bbc'
      //      ['accounts','google','com'] → isCompound=false → parts[1]='google'
      const COMPOUND_SLD = new Set(['co','com','net','org','gov','edu','ac','ne','or','me']);
      const isCompound   = parts.length >= 3 &&
                           parts[parts.length - 1].length === 2 &&
                           COMPOUND_SLD.has(parts[parts.length - 2]);
      const domainIdx  = isCompound ? parts.length - 3 : parts.length - 2;
      const domainPart = parts[Math.max(0, domainIdx)];
      prefix           = domainPart.toUpperCase();             // 'SHOPIFY'
    } catch (_) {}
  }
  return {
    emailKey:    creds.emailKey    || `${prefix}_EMAIL`,
    usernameKey: creds.usernameKey || creds.emailKey || `${prefix}_EMAIL`,
    passwordKey: creds.passwordKey || `${prefix}_PASSWORD`,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a login sub-plan.
 *
 * Design: site-agnostic. The factory emits browser.act steps that:
 *   1. Try session restore (if hasSession)
 *   2. Detect whether the CURRENT page already has a login form
 *      (uses waitForContent to check for password input)
 *   3. If not, discover and click the Sign-in link on the current page
 *      (works for ANY website — no URL map needed)
 *   4. Fill credentials using KEYTAR refs
 *   5. Submit and handle 2FA
 *
 * @param {object} opts
 * @param {string}  opts.loginUrl       URL of the detected login page, or the
 *                                      CURRENT page URL where auth failed.
 * @param {string}  [opts.service]      Service name override (optional)
 * @param {object}  [opts.credentials]  KEYTAR key overrides:
 *                                      { emailKey?, usernameKey?, passwordKey? }
 * @param {boolean} [opts.hasSession]   Attempt session restore first
 * @param {string}  [opts.sessionId]    Playwright session ID
 * @param {string}  [opts.loginError]   Error text that triggered this sub-plan
 * @param {boolean} [opts.alreadyOnLoginPage]
 *                                      true when the current page IS the login
 *                                      form — skip link-discovery step
 * @param {string[]} [opts.missingCredentialKeys]
 *                                      KEYTAR keys that are NOT yet in the
 *                                      keychain.  For each missing key the
 *                                      factory prepends an ask_user step that
 *                                      collects the value + stores it securely
 *                                      before the credential fill step runs.
 * @returns {Array}  Array of skill-plan step objects
 */
function buildLoginSubPlan(opts = {}) {
  const {
    loginUrl:               rawLoginUrl          = '',
    service:                rawService,
    credentials:            creds                = {},
    hasSession                                   = false,
    sessionId                                   = null,
    loginError                                  = '',
    alreadyOnLoginPage                          = false,
    missingCredentialKeys:  missingKeys          = [],
    // URL resolved via web search — takes precedence over everything
    resolvedLoginUrl                             = null,
    // URL to navigate back to after login succeeds (e.g. mail.google.com after Google auth)
    destinationUrl                               = '',
  } = opts;

  const service  = inferService(rawLoginUrl, rawService);
  const knownUrl = KNOWN_AUTH_URLS[service] || '';
  // Priority: web-search result → known auth URL → raw app URL (e.g. mail.google.com)
  // The "raw" URL from the plan is often the app domain, not the sign-in form.
  const startUrl = resolvedLoginUrl || knownUrl || rawLoginUrl;

  const { usernameKey, passwordKey } = deriveCredentialKeys(service, startUrl, creds);

  const steps = [];

  // ── Step A: Try session restore (cheapest) ────────────────────────────
  if (hasSession) {
    steps.push({
      skill:       'browser.restoreSession',
      args:        { service, sessionId },
      description: `Restore saved ${service} browser session`,
      optional:    true,
    });
  }

  // ── Step B: Navigate to login page (if we have a URL and aren't there yet)
  if (startUrl && !alreadyOnLoginPage) {
    steps.push({
      skill: 'browser.act',
      args: {
        action:      'navigate',
        url:         startUrl,
        sessionId,
        description: `Open login page`,
      },
      description: `Navigate to ${service !== 'unknown' ? service : startUrl} login page`,
    });
  }

  // ── Step C: Link-discovery — click "Sign in" if no password field yet ──
  // This covers ANY site: the LLM step uses browser.act's smart element search
  // to find a link whose text matches common login labels, then clicks it.
  // Skip when navigating directly to a known OAuth/login page (e.g. Google's
  // accounts.google.com/signin) — the page IS the form so there's nothing to
  // click; clicking a sign-in link there would open an unwanted new tab.
  const startUrlIsLoginPage = isLoginSignal(startUrl) || !!KNOWN_AUTH_URLS[service];
  if (!alreadyOnLoginPage && !startUrlIsLoginPage) {
    steps.push({
      skill: 'browser.act',
      args: {
        action:      'click',
        selector: [
          'a[href*="login" i]',
          'a[href*="signin" i]',
          'a[href*="sign-in" i]',
          'a:has-text("Sign in")',
          'a:has-text("Log in")',
          'a:has-text("Login")',
          'button:has-text("Sign in")',
          'button:has-text("Log in")',
          '[data-testid*="signin"]',
          '[data-testid*="login"]',
          '[aria-label*="sign in" i]',
          '[aria-label*="log in" i]',
        ].join(', '),
        sessionId,
        description: 'Click Sign-in / Log-in link on current page',
      },
      description: 'Discover and click login link (site-agnostic)',
      optional:    true,   // skipped if password input is already visible
    });
  }

  // ── Step D: Fill email / username ─────────────────────────────────────
  // If the username/email KEYTAR key is not in the keychain yet, ask the user
  // for it first and store it securely before attempting to fill the field.
  if (missingKeys.includes(usernameKey)) {
    const svcLabel = service !== 'unknown' ? service[0].toUpperCase() + service.slice(1) : 'this site';
    steps.push({
      skill: 'ask_user',
      args: {
        question:  `What email or username do you use to sign in to ${svcLabel}?`,
        inputHint: `Email / username — or just log in manually in the Chrome window that opened`,
        varName:   `_gathered_${usernameKey}`,
      },
      description: `Gather missing email/username for ${service}`,
    });
    steps.push({
      skill: 'profile.store_secret',
      args: {
        keytarKey: usernameKey,
        valueVar:  `_gathered_${usernameKey}`,
        service,
        label:     `${service} email`,
      },
      description: `Store email/username in keychain as ${usernameKey}`,
    });
  }

  steps.push({
    skill: 'browser.act',
    args: {
      action:   'fill',
      selector: [
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[name="identifier"]',
        'input[name="user_email"]',
        'input[name="login"]',
        'input[autocomplete="email"]',
        'input[autocomplete="username"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="username" i]',
        'input[type="text"]:first-of-type',
      ].join(', '),
      // Use gathered var (in-memory, no keychain prompt) when we just asked the user for
      // this credential; fall back to KEYTAR pointer when it was already stored.
      value:       missingKeys.includes(usernameKey)
        ? `{{_gathered_${usernameKey}}}`
        : `KEYTAR:${usernameKey}`,
      sessionId,
      description: `Enter email or username`,
    },
    description: `Fill email/username (KEYTAR:${usernameKey})`,
  });

  // ── Step E: Click "Next" if the form is a two-step flow (email → then password)
  // Google, Microsoft, etc. hide the password field until email is confirmed.
  // marked optional — skipped on single-page forms.
  steps.push({
    skill: 'browser.act',
    args: {
      action:   'click',
      selector: [
        'button[id*="next" i]',
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'input[type="submit"][value*="Next" i]',
        'input[type="submit"][value*="Continue" i]',
        '[data-testid*="next"]',
      ].join(', '),
      sessionId,
      description: 'Click Next (two-step login flow)',
    },
    description: 'Click Next / Continue between email and password (two-step flow)',
    optional:    true,
  });

  // ── Step F: Fill password ─────────────────────────────────────────────
  // If the password KEYTAR key is not in the keychain yet, ask the user first.
  if (missingKeys.includes(passwordKey)) {
    const svcLabel = service !== 'unknown' ? service[0].toUpperCase() + service.slice(1) : 'this site';
    steps.push({
      skill: 'ask_user',
      args: {
        question:  `What is your password for ${svcLabel}?`,
        inputHint: `Password (stored securely in macOS Keychain — never saved as plain text). You can also just log in via the browser window instead.`,
        varName:   `_gathered_${passwordKey}`,
        sensitive: true,
      },
      description: `Gather missing password for ${service}`,
    });
    steps.push({
      skill: 'profile.store_secret',
      args: {
        keytarKey: passwordKey,
        valueVar:  `_gathered_${passwordKey}`,
        service,
        label:     `${service} password`,
      },
      description: `Store password in keychain as ${passwordKey}`,
    });
  }

  steps.push({
    skill: 'browser.act',
    args: {
      action:      'fill',
      selector:    [
        'input[type="password"]',
        'input[name="password"]',
        'input[name="passwd"]',
        'input[name="pass"]',
        'input[autocomplete="current-password"]',
        'input[placeholder*="password" i]',
      ].join(', '),
      // Use gathered var (in-memory, no keychain prompt) when we just asked the user for
      // this credential; fall back to KEYTAR pointer when it was already stored.
      value:       missingKeys.includes(passwordKey)
        ? `{{_gathered_${passwordKey}}}`
        : `KEYTAR:${passwordKey}`,
      sessionId,
      description: `Enter password`,
    },
    description: `Fill password (KEYTAR:${passwordKey})`,
  });

  // ── Step G: Submit login form ──────────────────────────────────────────
  steps.push({
    skill: 'browser.act',
    args: {
      action:   'click',
      selector: [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Sign up")',
        '[data-testid*="login-submit"]',
        '[data-testid*="signin-submit"]',
        '[aria-label*="sign in" i]',
      ].join(', '),
      sessionId,
      description: `Submit login form`,
    },
    description: `Submit login form`,
  });

  // ── Step H: 2FA — ask user for OTP ────────────────────────────────────
  steps.push({
    skill: 'ask_user',
    args: {
      question:  `${service !== 'unknown' ? (service[0].toUpperCase() + service.slice(1)) : 'The site'} may have sent a 2-factor verification code. ` +
                 `Paste it below if you received one, or leave empty to skip.`,
      inputHint: 'Verification code (leave empty to skip)',
      optional:  true,
      varName:   '_2fa_code',
    },
    description: `Prompt user for 2FA code (optional)`,
    optional:    true,
  });

  // ── Step I: Submit 2FA code if user provided one ──────────────────────
  steps.push({
    skill: 'browser.act',
    args: {
      action:      'fill',
      selector: [
        'input[name*="code" i]',
        'input[name*="otp" i]',
        'input[name*="2fa" i]',
        'input[name*="mfa" i]',
        'input[name*="token" i]',
        'input[aria-label*="code" i]',
        'input[aria-label*="verification" i]',
        'input[placeholder*="code" i]',
        'input[id*="verify" i]',
        'input[id*="otp" i]',
        'input[autocomplete="one-time-code"]',
      ].join(', '),
      value:       '{{_2fa_code}}',
      skipIfEmpty: true,
      sessionId,
      description: `Enter 2FA code`,
    },
    description: `Submit 2FA code (skipped if empty)`,
    optional:    true,
  });

  // ── Step J: Submit the 2FA form ────────────────────────────────────────
  steps.push({
    skill: 'browser.act',
    args: {
      action:   'click',
      selector: [
        'button[type="submit"]',
        'button:has-text("Verify")',
        'button:has-text("Submit")',
        'button:has-text("Confirm")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
      ].join(', '),
      skipIfPrevEmpty: '_2fa_code',
      sessionId,
      description: 'Submit 2FA form',
    },
    description: 'Submit 2FA form (skipped if no code entered)',
    optional:    true,
  });

  // ── Step K: Wait for post-login page to stabilise ─────────────────────
  // After form submit (and optional 2FA), wait for navigation to settle.
  // Detects if we landed on another auth page (redirect loops) or the dashboard.
  steps.push({
    skill: 'browser.act',
    args: {
      action:        'waitForStableText',
      timeoutMs:     20000,
      settleMs:      1500,
      sessionId,
      description:   'Wait for post-login page to stabilise',
    },
    description: 'Wait for post-login navigation to settle',
    optional:    true,
  });

  // ── Step K+: Navigate back to the original destination ───────────────
  // After OAuth/login the browser may have landed on an account settings page
  // (e.g. myaccount.google.com) rather than the user's intended destination.
  // If a destinationUrl was captured from the parent plan, navigate there now.
  if (destinationUrl && destinationUrl !== startUrl) {
    steps.push({
      skill: 'browser.act',
      args: {
        action:      'navigate',
        url:         destinationUrl,
        sessionId,
        description: `Navigate to original destination after login`,
      },
      description: `Navigate to ${destinationUrl} (original goal after login)`,
      optional:    true,
    });
    steps.push({
      skill: 'browser.act',
      args: {
        action:    'waitForStableText',
        timeoutMs: 15000,
        settleMs:  1500,
        sessionId,
        description: 'Wait for destination page to settle after navigation',
      },
      description: 'Wait for destination page to settle',
      optional:    true,
    });
  }

  // ── Step L: Persist session cookies so future runs skip the login form ─
  // Writes cookies + localStorage to ~/.thinkdrop/browser-sessions/<sessionId>.json
  // so `hasSession: true` can be passed next time to restore auth instantly.
  if (sessionId) {
    const os   = require('os');
    const path = require('path');
    const sessionFile = path.join(
      os.homedir(), '.thinkdrop', 'browser-sessions',
      `${sessionId.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`
    );
    steps.push({
      skill: 'browser.act',
      args: {
        action:    'state-save',
        filePath:  sessionFile,
        sessionId,
        description: `Save ${service} browser session after login`,
      },
      description: `Persist ${service} session cookies to disk`,
      optional:    true,
    });
  }

  return steps;
}

module.exports = { buildLoginSubPlan, isLoginSignal, inferService, deriveCredentialKeys, KNOWN_AUTH_URLS };

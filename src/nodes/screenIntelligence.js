/**
 * Screen Intelligence Node - Extracted with graceful degradation
 * 
 * Analyzes screen content via OCR.
 * Flow:
 *   1. Check user-memory recentOcr — if a capture < 10s old exists, reuse it (skip screenshot)
 *   2. Otherwise call screen-intelligence service for a fresh capture + OCR
 *   3. Build a clean LLM context string from OCR text + window metadata
 *
 * Works with or without MCP adapter:
 * - With MCP: Uses screen-intelligence service for analysis
 * - Without MCP: Returns placeholder with intent info
 */

// Mirrors the categorization in thinkdrop-user-memory-service/src/monitor/monitorService.js
// so that freshly captured screen context can also report an app type.
const APP_CATEGORY = {
  'Google Chrome': 'browser', 'Safari': 'browser', 'Firefox': 'browser',
  'Microsoft Edge': 'browser', 'Brave Browser': 'browser',
  'Visual Studio Code': 'editor', 'Code': 'editor', 'Cursor': 'editor',
  'Windsurf': 'editor', 'Zed': 'editor', 'Sublime Text': 'editor',
  'TextEdit': 'editor', 'Devin': 'editor',
  'Slack': 'chat', 'Discord': 'chat', 'Microsoft Teams': 'chat',
  'Telegram': 'chat', 'WhatsApp': 'chat', 'Messages': 'chat',
  'Figma': 'design', 'Adobe Photoshop': 'design', 'Adobe Illustrator': 'design',
  'Sketch': 'design',
  'Terminal': 'terminal', 'iTerm': 'terminal', 'iTerm2': 'terminal',
  'Warp': 'terminal', 'Hyper': 'terminal',
  'Mail': 'email', 'Microsoft Outlook': 'email', 'Spark': 'email'
};

function getAppCategory(appName) {
  if (!appName) return null;
  return APP_CATEGORY[appName] || null;
}

// ── Failure degradation ───────────────────────────────────────────────────────
// A capture failure used to set state.answer to the raw service error — the
// builder edge then routed straight to logConversation and the user got an
// HTTP-500 JSON dump (observed: "is this app visible to a proctoring system"
// → "Error analyzing screen: HTTP 500: {…screen_recording_permission_denied…}"
// rendered verbatim and persisted into history). A failure now produces a
// failure-context block for the answer node instead — the LLM acknowledges
// the capture died, relays the fix, and answers what it can without the grab.
const SCREEN_SETTINGS_LINK = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * Map a service error (ThinkDropMCPClient throws `HTTP <status>: {<json>}`)
 * to {code, reason, fix} the answer node can relay.
 */
function _describeScreenFailure(errMsg) {
  const msg = String(errMsg || '');
  let code = null, hint = null;
  // The service returns structured {success:false, error, detail, hint} —
  // pull the code and its own remediation text out of the JSON body.
  const braceIdx = msg.indexOf('{');
  if (braceIdx >= 0) {
    try {
      const body = JSON.parse(msg.slice(braceIdx));
      code = typeof body.error === 'string' ? body.error : null;
      hint = typeof body.hint === 'string' ? body.hint : null;
    } catch (_) {}
  }
  if (!code) {
    if (/screen_recording_permission_denied/i.test(msg)) code = 'screen_recording_permission_denied';
    else if (/screenshot_capture_failed/i.test(msg)) code = 'screenshot_capture_failed';
  }
  if (code === 'screen_recording_permission_denied' || /not authorized|screen recording.*denied|permission_denied/i.test(msg)) {
    return {
      code: 'screen_recording_permission_denied',
      reason: 'macOS denied Screen Recording permission to the screen-capture service.',
      fix: hint || `Grant Screen Recording permission to "ThinkDrop Screen Helper" (System Settings → Privacy & Security → Screen Recording — it appears under its own name), then retry. Open it directly: ${SCREEN_SETTINGS_LINK}`,
    };
  }
  if (code === 'screenshot_capture_failed') {
    return {
      code,
      reason: 'The screenshot could not be captured.',
      fix: hint || 'Retry — if it keeps failing, check Screen Recording permission.',
    };
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timed?\s*out|unreachable|fetch failed|socket hang up/i.test(msg)) {
    return {
      code: 'service_unreachable',
      reason: 'The screen analysis service is unreachable.',
      fix: 'The capture service may not be running — retry after restarting ThinkDrop.',
    };
  }
  return {
    code: code || 'unknown',
    reason: `Screen capture failed (${msg.slice(0, 120)}).`,
    fix: 'Retry the request.',
  };
}

/**
 * Build the degraded context block the answer node sees when capture fails.
 * It carries the reason, the fix, and a hard rule against claiming screen
 * visibility — same directive-in-context style as other answer.js blocks.
 */
function _buildScreenFailureContext(failure) {
  return [
    '=== SCREEN CAPTURE UNAVAILABLE ===',
    `The attempt to capture the screen failed: ${failure.reason}`,
    `Fix: ${failure.fix}`,
    '',
    'Do NOT describe, quote, or claim to see on-screen content. If the request',
    'depended on the screen, say plainly that the capture failed, give the Fix',
    'line, then answer whatever the request allows without screen data.',
    '',
    'Earlier screen or page descriptions in this conversation may be OUTDATED',
    '— the user may have switched apps or tabs since they were captured. Do',
    'NOT present them as current; say plainly that the screen cannot be seen',
    'right now.',
    '=== END SCREEN STATUS ===',
  ].join('\n');
}

/** Shared degraded return shape for every capture-failure path. */
function _degradedState(state, failure, error) {
  return {
    ...state,
    screenContext: null,
    screenError: { code: failure.code, reason: failure.reason },
    context: _buildScreenFailureContext(failure),
    // Permission denial gets a clickable fix: the card rides state →
    // task:complete → plan:question → QuestionCard; a pick resolves through
    // _matchPlanCheckAction to the open-url action (never auto-opens).
    choices: failure.code === 'screen_recording_permission_denied' ? {
      question: 'Screen Recording permission is off — want me to open the settings pane so you can grant it?',
      options: [
        {
          label: 'Open Screen Recording settings',
          value: 'open screen recording settings',
          primary: true,
          action: { action: 'open-url', url: SCREEN_SETTINGS_LINK },
        },
        { label: 'Not now', value: 'not now', action: { action: 'dismiss' } },
      ],
    } : null,
    // Clear the lazy-grab flag so the screenIntelligence edge routes to the
    // answer node — never to preparePostScreen (a missing grab must not
    // blind-run an automation postIntent).
    _needsFreshScreen: false,
    error: error ? error.message : failure.reason,
  };
}

/**
 * Build a structured LLM context string from OCR capture data.
 * @param {object} capture - { text, appName, windowTitle, url, confidence }
 * @param {string} query
 */
function buildScreenContext(capture, query) {
  const lines = [];
  lines.push('=== SCREEN CONTENT ===');
  if (capture.appName)     lines.push(`App: ${capture.appName}`);
  if (capture.windowTitle) lines.push(`Window: ${capture.windowTitle}`);
  if (capture.url)         lines.push(`URL: ${capture.url}`);
  if (capture.confidence != null) lines.push(`OCR Confidence: ${Math.round(capture.confidence)}%`);
  lines.push('');
  lines.push('--- Visible Text ---');
  lines.push((capture.text || '').trim() || '[No readable text found on screen]');
  lines.push('=== END SCREEN CONTENT ===');
  return lines.join('\n');
}

module.exports = async function screenIntelligence(state) {
  const { mcpAdapter, message, context } = state;
  const logger = state.logger || console;
  
  logger.debug('[Node:ScreenIntelligence] Analyzing screen context...');

  // Check if MCP adapter is available
  if (!mcpAdapter) {
    logger.warn('[Node:ScreenIntelligence] No MCP adapter - screen analysis not available');
    return _degradedState(state, {
      code: 'service_unavailable',
      reason: 'The screen analysis service is not connected.',
      fix: 'Retry after the MCP services finish starting.',
    });
  }

  try {
    let capture = null;

    // ── Step 0: Browser frontmost → real rendered-page scan ──────────────────
    // app.agent read_screen passively detects the frontmost app and uses
    // scan_page (real page copy) when a browser is on screen — richer and far
    // faster than Tesseract OCR. Only attempted when prior context already
    // says a browser is frontmost; falls through to OCR on any failure.
    const _priorApp = state._priorScreenContext?.appName || null;
    let _tryReadScreen = state._priorScreenContext?.category === 'browser'
      || getAppCategory(_priorApp) === 'browser';
    // Monitor dead (e.g. TCC denial → zero captures) → no prior context at
    // all → the live frontmost check is the only way to spot the browser.
    // getActiveAppContext is a cheap live read; on any failure default to
    // attempting read_screen anyway — it self-detects the frontmost app and
    // returns an honest error for non-browsers. read_screen needs no Screen
    // Recording permission, so on a denied machine it is the ONLY working
    // capture path (observed: monitor dead → read_screen skipped → a stale
    // page was answered from history while the user was on a different tab).
    // A monitor that is alive-but-capture-denied leaves stale/missing prior
    // context — same empty signal as a dead monitor, so the live frontmost
    // probe runs whenever prior context hasn't already proven a browser.
    // Cost of a wrong try is one honest non-browser error from read_screen.
    if (!_tryReadScreen) {
      try {
        const ctxRes = await mcpAdapter.callService('user-memory', 'memory.getActiveAppContext', {});
        const app = (ctxRes?.data || ctxRes)?.app;
        _tryReadScreen = !!app && (app.category === 'browser' || getAppCategory(app.appName) === 'browser');
      } catch (_) { _tryReadScreen = true; }
    }
    if (_tryReadScreen) {
      try {
        const rs = await mcpAdapter.callService('command', 'command.automate', {
          skill: 'app.agent',
          args: { action: 'read_screen', timeoutMs: 30000 }
        });
        const rsData = rs.data || rs;
        if (rsData.ok && (rsData.text || rsData.content)) {
          capture = {
            text:        rsData.text || rsData.content,
            appName:     rsData.appName || _priorApp,
            windowTitle: rsData.windowTitle || null,
            url:         rsData.url || null,
            confidence:  null,
            timestamp:   new Date().toISOString(),
            category:    'browser'
          };
          logger.debug(`[Node:ScreenIntelligence] Browser frontmost — app.agent read_screen via=${rsData.via} (${capture.text.length} chars)`);
        }
      } catch (rsErr) {
        logger.debug(`[Node:ScreenIntelligence] read_screen failed, falling back to OCR: ${rsErr.message}`);
      }
    }

    // ── Step 1: Check for a recent OCR capture from user-memory monitor ──────
    // Pass activeAppName so the query only returns captures for the current app.
    // Reduces maxAgeSeconds to 3 to minimize the stale-app race window.
    const _activeAppName = state._priorScreenContext?.appName || null;
    if (!capture) try {
      const recentResult = await mcpAdapter.callService('user-memory', 'memory.getRecentOcr', {
        maxAgeSeconds: 3,
        appName: _activeAppName || undefined
      });
      const recentData = recentResult.data || recentResult;
      if (recentData.available && recentData.capture) {
        capture = recentData.capture;
        logger.debug(`[Node:ScreenIntelligence] Reusing recent OCR capture (< 3s old, app=${capture.appName})`);
      }
    } catch (ocrCheckErr) {
      logger.debug('[Node:ScreenIntelligence] recentOcr check failed, proceeding with fresh capture:', ocrCheckErr.message);
    }

    // ── Step 2: Fresh capture if no recent OCR available ─────────────────────
    if (!capture) {
      const result = await mcpAdapter.callService('screen-intelligence', 'screen.analyze', {
        query: message,
        context: {
          userId: context?.userId,
          sessionId: context?.sessionId
        }
      });

      const resultData = result.data || result;

      // screen-intelligence returns: { text, rawText, appName, windowTitle, url, confidence, elapsed, timestamp }
      capture = {
        text:        resultData.text        || resultData.rawText || '',
        appName:     resultData.appName     || null,
        windowTitle: resultData.windowTitle || null,
        url:         resultData.url         || null,
        confidence:  resultData.confidence  || resultData.ocrConfidence || null,
        timestamp:   resultData.timestamp   || new Date().toISOString(),
        category:    getAppCategory(resultData.appName) || null
      };
      logger.debug(`[Node:ScreenIntelligence] Fresh OCR capture: ${capture.text.length} chars, app=${capture.appName}`);
    }

    // ── Step 3: Build structured context string for the LLM ──────────────────
    const llmContext = buildScreenContext(capture, message);

    const screenContext = {
      appName:     capture.appName,
      windowTitle: capture.windowTitle,
      url:         capture.url,
      text:        capture.text,
      confidence:  capture.confidence || capture.ocrConfidence || null,
      timestamp:   capture.timestamp || capture.capturedAt || capture.created_at || new Date().toISOString(),
      category:    capture.category || getAppCategory(capture.appName) || null
    };

    return {
      ...state,
      screenContext,
      context: llmContext
    };

  } catch (error) {
    logger.error('[Node:ScreenIntelligence] Error:', error.message);

    return _degradedState(state, _describeScreenFailure(error.message), error);
  }
};

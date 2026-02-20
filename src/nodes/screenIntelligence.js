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
    return {
      ...state,
      answer: '[MCP not available - Screen intelligence requires MCP services]',
      screenContext: null
    };
  }

  try {
    let capture = null;

    // ── Step 1: Check for a recent OCR capture from user-memory monitor ──────
    try {
      const recentResult = await mcpAdapter.callService('user-memory', 'memory.getRecentOcr', {
        maxAgeSeconds: 10
      });
      const recentData = recentResult.data || recentResult;
      if (recentData.available && recentData.capture) {
        capture = recentData.capture;
        logger.debug('[Node:ScreenIntelligence] Reusing recent OCR capture (< 10s old)');
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

      // screen-intelligence returns: { text, rawText, appName, windowTitle, url, confidence, elapsed }
      capture = {
        text:        resultData.text        || resultData.rawText || '',
        appName:     resultData.appName     || null,
        windowTitle: resultData.windowTitle || null,
        url:         resultData.url         || null,
        confidence:  resultData.confidence  || resultData.ocrConfidence || null
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
      confidence:  capture.confidence || capture.ocrConfidence || null
    };

    return {
      ...state,
      screenContext,
      context: llmContext
    };

  } catch (error) {
    logger.error('[Node:ScreenIntelligence] Error:', error.message);

    return {
      ...state,
      answer: `Error analyzing screen: ${error.message}`,
      screenContext: null,
      error: error.message
    };
  }
};

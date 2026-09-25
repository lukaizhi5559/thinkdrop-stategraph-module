'use strict';

/**
 * screenOutput — the stategraph producer for the GhostLayer "screen output"
 * channel.
 *
 * Handles `screen_display` intents (classified via
 * _taskClassification.isScreenOutput). Posts a ScreenOutput payload to the
 * overlay-control server in main.js:
 *   action 'show'  → POST /screen/display  (renders text/emoji/effect/etc.)
 *   action 'clear' → POST /screen/clear    (dismisses one or all displays)
 *
 * Content resolution order for 'show':
 *   1. tc.screenOutputContent — literal content in the message
 *      ("show 'hello world' on the screen")
 *   2. Prior step result — multi-intent dependent step
 *      (state.intentResults / state._dataPrefix)
 *   3. Last assistant turn in state.conversationHistory
 *      ("show it on the screen" → the previous answer)
 *   4. state.synthesisAnswer / state.answer
 *
 * Returns { ...state, _forceAnswerContext } and routes to `answer` — the
 * overlay shows a brief ack while the GhostLayer paints the display.
 */

const OVERLAY_PORT = process.env.OVERLAY_CONTROL_PORT || 3010;
const BASE = `http://127.0.0.1:${OVERLAY_PORT}`;

const EFFECT_RE = /\b(emoji[\s-]?rain|fireworks?|confetti|snow|rain)\b/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

async function _post(path, body, logger) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json.ok !== false, status: res.status, json };
  } catch (err) {
    logger.warn(`[Node:ScreenOutput] POST ${path} failed: ${err.message}`);
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

/** Last assistant utterance — prefers real turns over proactive cards. */
function _lastAssistantText(history) {
  if (!Array.isArray(history)) return null;
  const real = history.filter(m => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const nonCard = real.filter(m => !m.isThoughtCard && m.source !== 'thought-attachment');
  const pick = nonCard[nonCard.length - 1] || real[real.length - 1];
  return pick ? pick.content.trim() : null;
}

function _stepResultText(state) {
  const results = Array.isArray(state.intentResults) ? state.intentResults : [];
  const last = results[results.length - 1];
  if (!last || last.result == null) return null;
  const r = last.result;
  const text = typeof r === 'string' ? r : (r.summary || '');
  return text.trim() || null;
}

module.exports = async function screenOutput(state) {
  const logger = state.logger || console;
  const tc = state._taskClassification || {};
  const message = String(state.message || '');
  const action = tc.screenOutputAction || 'show';

  logger.info(`[Node:ScreenOutput] action=${action} kind=${tc.screenOutputKind || 'auto'} msg="${message.slice(0, 80)}"`);

  // ── Clear ──────────────────────────────────────────────────────────────────
  if (action === 'clear') {
    const res = await _post('/screen/clear', {}, logger);
    return {
      ...state,
      _forceAnswerContext: res.ok
        ? '## Screen\n\nCleared the screen.'
        : `## Screen\n\nCouldn't reach the screen output (${res.error || `HTTP ${res.status}`}). Is the app fully started?`,
    };
  }

  // ── Show ───────────────────────────────────────────────────────────────────
  const kind = tc.screenOutputKind || 'text';
  const payload = { kind };

  // Structured data emitted by the classifier (chart data, deck slides, alert
  // severity) merges in first; kind-specific logic below fills any gaps.
  if (tc.screenOutputPayload && typeof tc.screenOutputPayload === 'object') {
    Object.assign(payload, tc.screenOutputPayload);
    payload.kind = kind; // kind is authoritative from the classification
  }

  if (tc.screenOutputMood) payload.mood = tc.screenOutputMood;

  switch (kind) {
    case 'effect': {
      const m = message.match(EFFECT_RE);
      payload.effect = m ? m[1].toLowerCase().replace(/\s+/g, '-') : 'confetti';
      if (payload.effect === 'firework') payload.effect = 'fireworks';
      if (payload.effect === 'emoji rain') payload.effect = 'emoji-rain';
      break;
    }
    case 'chart': {
      // Data sources: classifier payload → prior step result object.
      if (!payload.chart) {
        const results = Array.isArray(state.intentResults) ? state.intentResults : [];
        const last = results[results.length - 1];
        const r = last && last.result && typeof last.result === 'object' ? last.result : null;
        if (r && r.chart && typeof r.chart === 'object') payload.chart = r.chart;
        else if (r && Array.isArray(r.data) && r.data.length) {
          const m = message.match(/\b(pie|donut|bar|line|area|stat)\b/i);
          payload.chart = { type: m ? m[1].toLowerCase() : 'pie', data: r.data };
        }
      }
      if (!payload.chart) {
        return {
          ...state,
          _forceAnswerContext: '## Screen\n\nNo chart data on hand — give me the numbers (e.g. "pie chart: apples 5, bananas 3") or run a query first.',
        };
      }
      if (tc.screenOutputContent) payload.title = tc.screenOutputContent;
      break;
    }
    case 'deck': {
      if (!payload.deck) {
        const results = Array.isArray(state.intentResults) ? state.intentResults : [];
        const last = results[results.length - 1];
        const r = last && last.result && typeof last.result === 'object' ? last.result : null;
        if (r && r.deck && Array.isArray(r.deck.slides)) payload.deck = r.deck;
      }
      if (!payload.deck) {
        return {
          ...state,
          _forceAnswerContext: '## Screen\n\nNo slides on hand — describe the deck (e.g. "slides: Intro / Goals / Next steps") or generate the content first.',
        };
      }
      break;
    }
    case 'alert': {
      if (/block|danger|stop|inappropriate|not for children/i.test(message)) payload.severity = payload.severity || 'block';
      else if (/warn|caution|careful/i.test(message)) payload.severity = payload.severity || 'warn';
      if (payload.blocking == null) payload.blocking = true; // alerts block by default
      payload.dismiss = 'manual';
      payload.text = payload.text || tc.screenOutputContent || _stepResultText(state) || _lastAssistantText(state.conversationHistory);
      if (!payload.text && !payload.title) {
        return {
          ...state,
          _forceAnswerContext: '## Screen\n\nWhat should the alert say?',
        };
      }
      break;
    }
    case 'emoji': {
      const em = message.match(EMOJI_RE) || (tc.screenOutputContent || '').match(EMOJI_RE);
      if (em) payload.emoji = em[0];
      if (tc.screenOutputContent) payload.text = tc.screenOutputContent;
      break;
    }
    case 'image': {
      const urlM = message.match(/https?:\/\/\S+/i);
      const pathM = message.match(/(?:~?\/[\w\-./ ]+\.(?:png|jpe?g|gif|webp|svg))/i);
      if (urlM) payload.url = urlM[0];
      else if (pathM) payload.path = pathM[0];
      else {
        return {
          ...state,
          _forceAnswerContext: '## Screen\n\nNo image URL or file path found in that request. Try "show this image on the screen: <url-or-path>".',
        };
      }
      if (tc.screenOutputContent) payload.caption = tc.screenOutputContent;
      break;
    }
    default: {
      // text (and pass-through kinds whose renderers land in later stages)
      const content =
        tc.screenOutputContent ||
        _stepResultText(state) ||
        _lastAssistantText(state.conversationHistory) ||
        state.synthesisAnswer ||
        state.answer;
      if (!content) {
        return {
          ...state,
          _forceAnswerContext: '## Screen\n\nNothing on hand to show — what should I put up?',
        };
      }
      payload.text = content;
      // Long passages (a whole chapter, a document) need dwell time proportional
      // to length — the renderer auto-scrolls what doesn't fit.
      if (content.length > 400) {
        payload.durationMs = Math.min(180000, Math.max(15000, Math.round(content.length * 45)));
      }
      if (tc.followUpTarget) payload.title = String(tc.followUpTarget).slice(0, 200);
      const em = message.match(EMOJI_RE);
      if (em) payload.emoji = em[0];
      if (/big|huge|large|giant/i.test(message)) payload.fontSize = 'hero';
      break;
    }
  }

  const res = await _post('/screen/display', payload, logger);
  if (!res.ok) {
    return {
      ...state,
      _forceAnswerContext: `## Screen\n\nCouldn't put that on screen (${res.error || `HTTP ${res.status}`}). Is the app fully started?`,
    };
  }

  logger.info(`[Node:ScreenOutput] displayed id=${res.json?.id} kind=${payload.kind}`);
  return {
    ...state,
    _forceAnswerContext: kind === 'effect'
      ? `## Screen\n\nOn screen — ${payload.effect}.`
      : '## Screen\n\nOn screen.',
  };
};

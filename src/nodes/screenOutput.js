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
 * Returns { ...state, _directAnswer } and routes to `answer` — the
 * overlay shows a brief ack while the GhostLayer paints the display.
 */

const OVERLAY_PORT = process.env.OVERLAY_CONTROL_PORT || 3010;
const BASE = `http://127.0.0.1:${OVERLAY_PORT}`;

const { inferScreenOutput, SCRIPTURE_REF_RE } = require('../utils/textPatterns.cjs');

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

/** Numeric token → value: "$83,165.29" → 83165.29, "1.66T" → 1.66e12,
 *  "38.2B" → 3.82e10, "2.30%" → 2.3. Covers the stat formats real pages and
 *  answers actually use — bare `\d+(\.\d+)?` parsing missed all of these. */
function _parseNum(raw, suffix) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(/[$€£,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(suffix || '').toUpperCase()] || 1;
  return n * mult;
}

/** "Mon: 4" / "apples = 5" / "Market Cap $1.66T" pairs → chart rows. Used for
 *  the inline message tail, prior-step text, prior assistant answers, and
 *  screen OCR text (label:number formats survive OCR reasonably well). */
function _pairsToRows(text) {
  if (!text) return [];
  const pairRe = /(\w[\w .\-'()&/]{0,40}?)\s*[:=–—-]?\s*[$€£]?\s*(-?\d[\d,]*(?:\.\d+)?)\s*([KMBTkmbt])?\s*%?\s*(?=[,;\n]|$)/gm;
  const data = [];
  let pm;
  while ((pm = pairRe.exec(text)) !== null) {
    const label = pm[1].trim().replace(/[,:;=–—-]+$/, '');
    const value = _parseNum(pm[2], pm[3]);
    // Label must carry at least one letter — "500 600" is a bare number
    // sequence, not a name→value pair. "24h Volume" is a real label though.
    if (label && /[A-Za-z]/.test(label) && value != null && !/^(?:pie|donut|bar|line|area|stat|chart|graph|ocr confidence|visible text|screen content|app|window|url)$/i.test(label)) {
      data.push({ label, value });
    }
  }
  return data;
}

/** Chart type from the message — "stacked chart" degrades to 'bar' (the
 *  renderer is single-series; true stacking needs multi-key rows + isStack). */
function _chartType(message, fallback) {
  const tm = String(message || '').match(/\b(stacked|pie|donut|bar|line|area|stat)\b/i);
  if (!tm) return fallback;
  const t = tm[1].toLowerCase();
  return t === 'stacked' ? 'bar' : t;
}

function _chartFromRows(data, message, noTypeFallback) {
  if (!data || !data.length) return null;
  const type = _chartType(message, null) || (data.length === 1 ? 'stat' : (noTypeFallback || 'bar'));
  return type === 'stat'
    ? { type: 'stat', data: [{ label: data[0].label, value: data[0].value }] }
    : { type, data, xKey: 'label', yKey: 'value' };
}

const CHART_EXTRACT_SYSTEM = [
  'You extract chart data from text for a screen overlay.',
  'Output ONLY valid JSON: {"type":"pie|donut|bar|line|area|stat","data":[{"label":"name","value":0}]}.',
  'Pick ONE coherent series — prefer a group of same-unit stats or the metric the request names. Max 12 rows.',
  'Values must be plain numbers: apply $/€, thousands commas, and K/M/B/T/% scaling yourself ("$1.66T" → 1660000000000, "38.2B" → 38200000000).',
  'If the text has no chartable series, output {"data":[]}. No markdown, no explanation.',
].join('\n');

/** LLM fallback: free text (prior answer / screen OCR) → validated chart
 *  rows. Returns {type, data} or null — caller keeps the honest no-data
 *  failure when extraction comes back empty. */
async function _extractChartFromText(text, message, state, logger) {
  const llm = state.llmBackend;
  if (!llm || typeof llm.generateAnswer !== 'function' || !text) return null;
  try {
    const raw = String(await Promise.race([
      llm.generateAnswer(
        `Chart request: ${message}\n\nSource text:\n${String(text).slice(0, 6000)}`,
        { query: message, context: { systemInstructions: CHART_EXTRACT_SYSTEM, intent: 'screen_display' } },
        { maxTokens: 500, temperature: 0, taskType: 'extract' }
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('chart-extract timeout')), 15000)),
    ]) || '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const data = (Array.isArray(parsed.data) ? parsed.data : [])
      .map(r => {
        const label = String(r?.label ?? '').trim().slice(0, 60);
        let value = r?.value;
        if (typeof value === 'string') {
          const sm = value.match(/([KMBT])\s*$/i);
          value = _parseNum(value, sm ? sm[1] : null);
        } else {
          value = Number(value);
        }
        return { label, value };
      })
      .filter(r => r.label && Number.isFinite(r.value))
      .slice(0, 20);
    if (!data.length) return null;
    const type = ['pie', 'donut', 'bar', 'line', 'area', 'stat'].includes(parsed.type) ? parsed.type : null;
    return { type, data };
  } catch (e) {
    logger.warn(`[Node:ScreenOutput] chart-extract failed: ${e.message}`);
    return null;
  }
}

/** Message references content living on the screen/page — "this data",
 *  "this page", "the data on screen". Gates screen-OCR sources so ambient
 *  captures can't feed unrelated chart requests. */
const SCREEN_DATA_REF_RE = /\b(?:this|the|that)\s+(?:page|screen|data|tab|site|window|table)\b|\b(?:data|info|numbers?|stats?|values?|table|content|text|chart)\s+(?:on|from|in|of)\s+(?:this|the|my)\s+(?:page|screen|site|tab|window)\b|\b(?:from|of)\s+(?:the|my|this)\s+screen\b/i;

/** Free text → deck slides: blank lines split slides; first line of each
 *  block becomes the title, "- "/"• " lines become bullets, the rest body. */
function _textToSlides(text) {
  if (!text) return [];
  const blocks = String(text).split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).slice(0, 8);
  return blocks.map(b => {
    const lines = b.split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = lines.filter(l => /^[-•*]\s+/.test(l)).map(l => l.replace(/^[-•*]\s+/, ''));
    const rest = lines.filter(l => !/^[-•*]\s+/.test(l));
    const slide = {};
    if (rest.length) slide.title = rest[0].slice(0, 200);
    if (rest.length > 1) slide.body = rest.slice(1).join('\n').slice(0, 4000);
    if (bullets.length) slide.bullets = bullets.slice(0, 20);
    return (slide.title || slide.body || slide.bullets) ? slide : null;
  }).filter(Boolean);
}

/** Code the generated scene must never contain — the sandboxed iframe gives
 *  an opaque origin, but we still cut the obvious exfil/escape vectors. The
 *  harness (new Function) lives outside the generated body. */
const SCENE_FORBIDDEN_RE = /\b(?:import|require|fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|eval|document\.(?:write|cookie)|localStorage|sessionStorage|indexedDB|open\s*\()\b|new\s+Function|https?:\/\//i;

const SCENE_GEN_SYSTEM = [
  'You write three.js scenes for a sandboxed overlay. Output ONLY JavaScript — no markdown, no explanation.',
  'The code you write is the BODY of `function build(THREE, ctx)`.',
  'ctx = { scene, camera, renderer, width, height, canvas, onKey } — a renderer, camera (z=6), ambient + directional light already exist.',
  'Add meshes/lines/points to ctx.scene with THREE. For animation return `{ tick(t) }` — tick(t) runs every frame, t = elapsed seconds.',
  'Keep geometry under ~200k vertices. Use additive colors on transparent background. Camera starts at z=6; keep content within roughly x,y ∈ [-4,4].',
  'INTERACTION: ctx.onKey(fn) registers a key handler. Keys arrive as names: "up"|"down"|"prev"|"next" (arrow keys), "play" (spacebar), "zoom_in"|"zoom_out"|"zoom_reset" (+/−/0), "reset" (R), "key_w"|"key_a"|"key_s"|"key_d" (WASD).',
  'Pointer input reaches the canvas while the scene is interactive — use canvas.addEventListener("pointerdown"|"pointermove"|"pointerup"|"wheel", fn) for drag-orbit, click, or scroll-zoom behaviour.',
  'When the request implies control (drag, orbit, move, play, steer, fly), implement spherical camera orbit: keep { yaw, pitch, dist } state, apply camera.position.set(dist*Math.sin(yaw)*Math.cos(pitch), dist*Math.sin(pitch), dist*Math.cos(yaw)*Math.cos(pitch)); camera.lookAt(0,0,0) each frame — wire pointer drag to yaw/pitch and wheel to dist.',
  'NO imports, NO fetch/network calls, NO DOM access beyond ctx/canvas listeners, NO eval/Function. THREE only.',
].join('\n');

/** LLM-generated three.js scene → { js, libs:['three'] } for kind:'scene'.
 *  Returns null on any failure — callers fall back to a preset. */
async function _generateThreeScene(message, state, logger) {
  const llm = state.llmBackend;
  if (!llm || typeof llm.generateAnswer !== 'function') return null;
  try {
    // 'complex' routing — 'codegen' wasn't a real taskType and the 30s race
    // fired before the backend could stream (observed: every starfield
    // fallback was exactly ~30s = this timeout, not a real model failure).
    // abortSignal + totalTimeoutMs mean a real timeout terminates the pooled
    // WS request instead of abandoning it mid-stream.
    const ctrl = new AbortController();
    const genTimeout = setTimeout(() => ctrl.abort(), 120000);
    let raw;
    try {
      raw = String(await llm.generateAnswer(
        `Scene request: ${message}`,
        { query: message, context: { systemInstructions: SCENE_GEN_SYSTEM, intent: 'screen_display' } },
        { maxTokens: 2000, temperature: 0.4, taskType: 'complex', abortSignal: ctrl.signal, totalTimeoutMs: 110000 }
      ) || '');
    } finally {
      clearTimeout(genTimeout);
    }
    // Strip markdown fences if the model wrapped the code anyway.
    raw = raw.replace(/^```(?:js|javascript)?\s*/im, '').replace(/```\s*$/m, '').trim();
    // Models keep writing `import * as THREE from '...'` despite the prompt —
    // THREE is injected by the harness, so strip import/export statements
    // rather than reject the scene outright.
    raw = raw.replace(/^\s*import\s[^;]*;?\s*$/gim, '')
             .replace(/^\s*export\s+(?:default\s+)?/gim, '');
    if (!raw || raw.length > 60000 || SCENE_FORBIDDEN_RE.test(raw)) {
      logger.warn(`[Node:ScreenOutput] scene-gen rejected (len=${raw.length}, forbidden=${SCENE_FORBIDDEN_RE.test(raw)})`);
      return null;
    }
    // Sanity: the body should touch THREE/scene — a prose answer isn't a scene.
    if (!/\bTHREE\./.test(raw) && !/\bscene\./.test(raw)) {
      logger.warn('[Node:ScreenOutput] scene-gen produced no THREE/scene usage — falling back to preset');
      return null;
    }
    logger.info(`[Node:ScreenOutput] scene-gen ok (${raw.length} chars)`);
    return { js: raw, libs: ['three'] };
  } catch (e) {
    logger.warn(`[Node:ScreenOutput] scene-gen failed: ${e.message}`);
    return null;
  }
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
      _directAnswer: res.ok
        ? '## Screen\n\nCleared the screen.'
        : `## Screen\n\nCouldn't reach the screen output (${res.error || `HTTP ${res.status}`}). Is the app fully started?`,
    };
  }

  // ── Show ───────────────────────────────────────────────────────────────────
  // tc.screenOutputKind flakes to null across plan-pause/resume (the resumed
  // run rebuilds _taskClassification from scratch). The utterance carries the
  // kind lexically — inferScreenOutput fills the gap before the text default.
  const kind = tc.screenOutputKind || inferScreenOutput(message).kind || 'text';
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
      // Data sources: classifier payload → prior step result object → inline
      // "name N" pairs in the message itself ("pie chart: apples 5, bananas 3"
      // — the format the no-data error below asks for). classifyTask's
      // screenOutputPayload flakes; the inline parse is deterministic.
      if (!payload.chart) {
        const tail = message.includes(':') ? message.slice(message.lastIndexOf(':') + 1) : message;
        const data = _pairsToRows(tail);
        if (data.length >= 2) {
          payload.chart = { type: _chartType(message, 'pie'), data, xKey: 'label', yKey: 'value' };
        }
      }
      if (!payload.chart) {
        const results = Array.isArray(state.intentResults) ? state.intentResults : [];
        const last = results[results.length - 1];
        const r = last && last.result && typeof last.result === 'object' ? last.result : null;
        if (r && r.chart && typeof r.chart === 'object') payload.chart = r.chart;
        else if (r && Array.isArray(r.data) && r.data.length) {
          payload.chart = { type: _chartType(message, 'pie'), data: r.data };
        }
      }
      // Prior-step text ("Mon: 4\nTue: 7") from a gather step — journal_stats
      // and sys_query print label:number lines the pair parser turns into
      // rows. Exactly one row coerces to a stat card unless a chart type was
      // named ("a bar chart of my battery" stays a bar with one bar).
      if (!payload.chart) {
        const data = _pairsToRows(_stepResultText(state));
        if (data.length) payload.chart = _chartFromRows(data, message);
      }
      // Referential sources — "present this data as a chart" points at the
      // previous assistant answer or the content on screen, not the message
      // itself. Screen text is only consulted when the message actually
      // references the screen (ambient OCR must not feed unrelated charts);
      // the prior assistant answer is consulted either way, like the text
      // and alert kinds already do.
      if (!payload.chart) {
        const convoText = _lastAssistantText(state.conversationHistory);
        const screenText = (typeof state.screenContext?.text === 'string' && state.screenContext.text)
          || (typeof state._priorScreenContext?.contextText === 'string' && state._priorScreenContext.contextText)
          || (typeof state.context === 'string' && state.context)
          || null;
        const screenRef = SCREEN_DATA_REF_RE.test(message)
          || tc.isScreenFollowUp || tc.needsFreshScreen || tc.activeDocRef === 'screen';
        const sources = screenRef ? [screenText, convoText] : [convoText];
        for (const t of sources) {
          const data = _pairsToRows(t);
          if (data.length) {
            payload.chart = _chartFromRows(data, message);
            logger.info(`[Node:ScreenOutput] chart rows from ${t === screenText ? 'screen-context' : 'conversation'} pairs (${data.length} rows)`);
            break;
          }
        }
        // LLM extraction — prose answers ("BTC trades at $83,165, volume
        // $12.43B") and OCR tables don't survive label:number parsing.
        for (const t of sources) {
          if (payload.chart || !t) continue;
          const ext = await _extractChartFromText(t, message, state, logger);
          if (ext) {
            const type = _chartType(message, null) || ext.type || (ext.data.length === 1 ? 'stat' : 'bar');
            payload.chart = type === 'stat'
              ? { type, data: ext.data.slice(0, 1) }
              : { type, data: ext.data, xKey: 'label', yKey: 'value' };
            logger.info(`[Node:ScreenOutput] chart rows from ${t === screenText ? 'screen-context' : 'conversation'} LLM-extract (${ext.data.length} rows)`);
          }
        }
      }
      if (!payload.chart) {
        return {
          ...state,
          _directAnswer: '## Screen\n\nNo chart data on hand — give me the numbers (e.g. "pie chart: apples 5, bananas 3") or run a query first.',
        };
      }
      if (tc.screenOutputContent) payload.title = tc.screenOutputContent;
      // Interactive by default: ant-design-charts tooltips/legends need real
      // mouse events, which requires lifting click-through (blocking:true).
      // The window captures input until Esc/click-outside/clear.
      if (payload.blocking == null) payload.blocking = true;
      break;
    }
    case 'deck': {
      if (!payload.deck) {
        const results = Array.isArray(state.intentResults) ? state.intentResults : [];
        const last = results[results.length - 1];
        const r = last && last.result && typeof last.result === 'object' ? last.result : null;
        if (r && r.deck && Array.isArray(r.deck.slides)) payload.deck = r.deck;
      }
      // Free text → slides: prior gather/answer text or an inline
      // "slides: A / B / C" shape in the message itself.
      if (!payload.deck) {
        const inline = message.match(/\bslides?\b[^:\n]{0,30}:\s*(.+)$/i);
        let slides = null;
        if (inline) {
          slides = inline[1].split(/\s*\/\s*/).map(t => ({ title: t.trim() })).filter(s => s.title).slice(0, 8);
        } else {
          slides = _textToSlides(tc.screenOutputContent || _stepResultText(state));
        }
        if (slides && slides.length) {
          payload.deck = { slides, transition: 'fade', slideMs: 5000, controls: true };
        }
      }
      // Image-search gathers → slide images: a "slideshow of X pics" fetch
      // returns images[] — one slide per image when the text made no slides.
      {
        const last = (state.intentResults || [])[ (state.intentResults || []).length - 1 ];
        const r = last && last.result && typeof last.result === 'object' ? last.result : null;
        const imgs = r && Array.isArray(r.images) ? r.images : [];
        if (imgs.length) {
          if (!payload.deck) {
            payload.deck = {
              slides: imgs.slice(0, 8).map((u, i) => ({ image: u, title: `${i + 1}` })),
              transition: 'fade', slideMs: 5000, controls: true,
            };
          } else {
            // Fill slides that lack an image, front to back.
            let i = 0;
            for (const s of payload.deck.slides) {
              if (!s.image && imgs[i]) s.image = imgs[i++];
            }
          }
        }
      }
      if (!payload.deck) {
        return {
          ...state,
          _directAnswer: '## Screen\n\nNo slides on hand — describe the deck (e.g. "slides: Intro / Goals / Next steps") or generate the content first.',
        };
      }
      // Deck controls are click zones — dead without lifted click-through.
      if (payload.deck && payload.deck.controls && payload.blocking == null) payload.blocking = true;
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
          _directAnswer: '## Screen\n\nWhat should the alert say?',
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
        // Prior-step image search — extractStepResult carries
        // { summary, imageUrl, images } for web_search results that have
        // image results (brave-image). Multi-image results become a Splide
        // carousel (images[]) — "show pics of X" paints them all, not just
        // the first hit.
        const last = (state.intentResults || [])[ (state.intentResults || []).length - 1 ];
        const r = last && last.result && typeof last.result === 'object' ? last.result : null;
        const imgs = r && Array.isArray(r.images) ? r.images.filter(u => typeof u === 'string' && u) : [];
        if (imgs.length > 1) {
          payload.images = imgs.slice(0, 20);
          if (imgs[0]) payload.url = imgs[0]; // fallback src if the carousel path fails
        } else if (r && r.imageUrl) payload.url = r.imageUrl;
        else if (imgs[0]) payload.url = imgs[0];
      }
      if (!payload.url && !payload.path && !(payload.images && payload.images.length)) {
        return {
          ...state,
          _directAnswer: '## Screen\n\nNo image on hand — name a picture (e.g. "pic of the golden gate") or give me a URL/path.',
        };
      }
      // Carousel chrome (arrows/dots/drag) is real pointer input — capture
      // on hover so the rest of the screen stays click-through.
      if (payload.images && payload.images.length > 1) payload.interactive = true;
      if (tc.screenOutputContent) payload.caption = tc.screenOutputContent;
      break;
    }
    case 'three': {
      // Preset 3D scenes — deterministic parse from the message; an explicit
      // payload.three from the classifier merges over the inferred defaults.
      if (!payload.three) {
        const m = message.match(/\b(starfield|particles?|wave|cube|knot|globe)\b/i);
        const scene = m ? m[1].toLowerCase().replace(/s$/, '') : null;
        if (scene) payload.three = { scene };
        // No generic "3d → cube" mapping: requests that name a subject the
        // presets can't express ("face", "heart") must reach the generative
        // fallback below — that's the whole point of it.
      }
      // Generative path: no preset matched — an LLM writes the scene
      // body (harness provides THREE/renderer/camera/RAF) and it runs as a
      // 'scene' kind inside the sandboxed SceneScreen iframe. Generation
      // failure returns an honest error and paints nothing (user decision —
      // the starfield silent-fallback masked every generation failure).
      if (!payload.three) {
        const gen = await _generateThreeScene(message, state, logger);
        if (gen) {
          payload.kind = 'scene';
          payload.scene = gen;
          payload.title = payload.title || tc.screenOutputContent || null;
          // Stable id — re-prompts ("make it faster", "now add rings") POST
          // a fresh scene under the same id so the stage swaps it in place
          // instead of stacking a second display. That swap IS the loop.
          payload.id = 'scene:active';
          // Interactive phrasing ("let me drag/play with…") opts into
          // click-through lifting; ambient scenes stay non-interactive
          // (⌘⇧K still grabs controls live).
          if (/\b(?:drag|click|play|interact|control|orbit|move|steer|fly|drive|game)\b/i.test(message)) {
            payload.blocking = true;
          }
        } else {
          // No silent starfield: a failed generation is an honest error, not
          // a wrong display. (Old behavior painted the starfield preset and
          // reported success for the requested scene — deeply confusing.)
          return {
            ...state,
            _directAnswer: "## Screen\n\nCouldn't generate that 3D scene — the scene model timed out or returned unusable code. Try again, or name a preset (starfield, particles, wave, cube, knot, globe).",
          };
        }
      }
      // Same interactive phrasing opts preset scenes into pointer capture —
      // drag-orbit/wheel-zoom land on the canvas itself.
      if (payload.three && /\b(?:drag|click|interact|control|orbit|play with)\b/i.test(message)) {
        payload.blocking = true;
      }
      const em = message.match(EMOJI_RE);
      if (em) payload.emoji = em[0];
      if (tc.screenOutputContent && payload.three) payload.three.text = tc.screenOutputContent;
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
          _directAnswer: '## Screen\n\nNothing on hand to show — what should I put up?',
        };
      }
      payload.text = content;
      // A short literal that's a *reference* rather than content — a scripture
      // ref ("john 3:16-20"), a bare label — rendered alone at xl looks like a
      // giant orphaned heading while the actual passage sat in the prior
      // answer. Promote it to the title and use the assistant's text as the
      // body. Gated hard: no newlines, <120 chars, and the assistant text must
      // exist and not be a "Displayed …" screen ack (those start '## Screen').
      const literal = tc.screenOutputContent;
      if (literal && literal === content && literal.length < 120 && !literal.includes('\n')) {
        const prior = _lastAssistantText(state.conversationHistory);
        if (prior && prior !== literal && !prior.startsWith('## Screen')
          && (SCRIPTURE_REF_RE.test(literal) || prior.includes(literal))) {
          payload.title = payload.title || literal;
          payload.text = prior;
        }
      }
      // No auto-duration — all kinds are sticky by default (Esc or
      // /screen/clear dismisses). Long passages scroll; see TextScreen.
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
      _directAnswer: `## Screen\n\nCouldn't put that on screen (${res.error || `HTTP ${res.status}`}). Is the app fully started?`,
    };
  }

  logger.info(`[Node:ScreenOutput] displayed id=${res.json?.id} kind=${payload.kind}`);
  // Descriptive result — summarizeMultiIntent feeds this to the combine LLM;
  // "Displayed an image "mario" on screen" reads as confirmed success where
  // bare "On screen." made the LLM hedge that nothing was confirmed painted.
  const subject = payload.title || payload.text || payload.image?.alt
    || (typeof payload.three?.scene === 'string' ? payload.three.scene : null)
    || payload.effect || payload.kind;
  return {
    ...state,
    _directAnswer: `## Screen\n\nDisplayed ${payload.kind}${subject && subject !== payload.kind ? ` "${String(subject).slice(0, 80)}"` : ''} on screen.`,
  };
};

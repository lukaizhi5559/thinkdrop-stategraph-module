#!/usr/bin/env node
/**
 * gen-bench-data.js — LLM-driven benchmark dataset generator
 *
 * Uses phi4's /general.answer endpoint to generate diverse synthetic user
 * messages for each intent and writes them to fixtures/intent-generated.json
 * in the same schema as intent-benchmark.json.
 *
 * Usage:
 *   node test/gen-bench-data.js                    # 20 per intent (default)
 *   node test/gen-bench-data.js --count=50         # 50 per intent
 *   node test/gen-bench-data.js --only=web_search  # one intent only
 *   node test/gen-bench-data.js --source=voice     # one source type only
 *   node test/gen-bench-data.js --out=data.json    # custom output filename
 *
 * The phi4 service must be running at localhost:3009.
 * Generated output is merged automatically by intent-bench.js --dataset=both
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── CLI args ───────────────────────────────────────────────────────────────────
const argv   = process.argv.slice(2);
const argVal = (key) => { const a = argv.find(x => x.startsWith(`${key}=`)); return a ? a.slice(key.length + 1) : null; };

const COUNT        = parseInt(argVal('--count')  || '20', 10);
const ONLY_INTENTS = argVal('--only')   ? argVal('--only').split(',')   : null;
const ONLY_SOURCES = argVal('--source') ? argVal('--source').split(',') : null;
const OUT_FILE     = argVal('--out')    || 'intent-generated.json';

const PHI4_BASE = 'http://localhost:3009';

const ALL_INTENTS = [
  'memory_store',
  'memory_retrieve',
  'web_search',
  'command_automate',
  'screen_intelligence',
  'general_knowledge',
  'greeting',
  'app_control_start',
];

const ALL_SOURCES = ['clean', 'voice', 'edge', 'adversarial'];

// Intent descriptions help the LLM produce on-target messages
const INTENT_DESCRIPTIONS = {
  memory_store: 'storing a fact, preference, appointment, or personal detail — e.g. "My wife\'s name is Sarah", "Remember I have a dentist appointment Tuesday", "I prefer dark mode"',
  memory_retrieve: 'querying stored facts, calendar, search history, or personal info — e.g. "What\'s my dentist\'s name?", "Do I have any appointments today?", "What movies have I watched recently?"',
  web_search: 'searching the web or looking up current information — e.g. "Search for the best Italian restaurants near me", "What\'s the weather in Tokyo?", "Find the latest news on AI"',
  command_automate: 'automating a task, running a command, controlling software, or scripting an action — e.g. "Open Chrome and go to gmail.com", "Create a folder called Projects on my Desktop", "Send an email to John"',
  screen_intelligence: 'reading, analyzing, or extracting text/data from the current screen — e.g. "What does the screen say?", "Read the error message", "Summarize what\'s on screen", "OCR this"',
  general_knowledge: 'asking a factual or conceptual question not tied to personal memory or the web — e.g. "How does photosynthesis work?", "What\'s the capital of Peru?", "Explain quantum entanglement"',
  greeting: 'greetings, introductions, conversational openers, or small talk — e.g. "Hi", "Hey how are you?", "Good morning", "What can you do?"',
  app_control_start: 'launching, switching to, or interacting with a specific named desktop application — e.g. "Open Spotify", "Launch VS Code", "Switch to Slack", "Start Zoom"',
};

const SOURCE_INSTRUCTIONS = {
  clean: 'well-formed, grammatically correct, clear and direct requests',
  voice: 'voice/ASR-style input — include typos, filler words (um, uh, hey), run-ons, missing punctuation, common ASR mishearings, non-standard capitalization',
  edge: 'ambiguous, very short, or elliptical phrases that are tricky to classify — they should still be correctly classified as the given intent',
  adversarial: 'messages that look like a different intent on the surface but are actually this intent — include cross-intent confusion pairs where possible',
};

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function httpPost(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port:     parseInt(u.port || '3009', 10),
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`Bad JSON: ${buf.slice(0, 120)}`)); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function probePhi4() {
  try {
    await httpPost(`${PHI4_BASE}/service.health`, {}, 2000);
    return true;
  } catch (_) {
    try {
      // GET fallback
      return await new Promise((res) => {
        http.get(`${PHI4_BASE}/service.health`, (r) => res(r.statusCode < 500))
          .on('error', () => res(false));
      });
    } catch (_) {
      return false;
    }
  }
}

// Ask phi4 to generate message examples
async function generateMessages(intent, source, count) {
  const prompt = `You are generating training data for an intent classification model.

Generate exactly ${count} short user messages that should be classified as the intent: "${intent}".

Intent description: ${INTENT_DESCRIPTIONS[intent]}

Source type: "${source}" — generate messages that are ${SOURCE_INSTRUCTIONS[source]}.

Rules:
- Each message should be on its own line.
- Do NOT number the lines.
- Do NOT add any explanations or labels.
- Keep messages concise (typically 3–20 words).
- Only output the messages, nothing else.`;

  try {
    const response = await httpPost(`${PHI4_BASE}/general.answer`, {
      message: prompt,
      systemInstructions: 'You are a precise data generator. Follow the format exactly.',
    }, 30000);

    const text = response?.response || response?.data?.response || response?.answer || '';
    if (!text) return [];

    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 3 && !line.startsWith('#') && !line.match(/^\d+\./))
      .slice(0, count);
  } catch (err) {
    console.error(`  [gen-err] intent=${intent} source=${source}: ${err.message}`);
    return [];
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const up = await probePhi4();
  if (!up) {
    console.error(`phi4 service not reachable at ${PHI4_BASE} — start it first.`);
    process.exit(1);
  }
  console.log(`phi4 UP at ${PHI4_BASE}`);

  const targetIntents = ONLY_INTENTS || ALL_INTENTS;
  const targetSources = ONLY_SOURCES || ALL_SOURCES;

  console.log(`Generating ~${COUNT} messages × ${targetIntents.length} intents × ${targetSources.length} sources`);
  console.log(`= up to ${COUNT * targetIntents.length * targetSources.length} examples\n`);

  const examples = [];
  const counters = {};

  for (const intent of targetIntents) {
    for (const source of targetSources) {
      const key = `${intent}-${source.slice(0, 1)}`;
      process.stdout.write(`  Generating ${intent} / ${source}...`);
      const messages = await generateMessages(intent, source, COUNT);
      process.stdout.write(` ${messages.length} messages\n`);

      counters[key] = (counters[key] || 0);
      for (const msg of messages) {
        counters[key]++;
        examples.push({
          id:      `gen-${key}-${String(counters[key]).padStart(3, '0')}`,
          message: msg,
          intent,
          source,
          notes:   'LLM-generated synthetic example',
        });
      }
    }
  }

  // Write output
  const outPath = path.join(__dirname, 'fixtures', OUT_FILE);
  const output = {
    version:     '1.0',
    description: `LLM-generated synthetic benchmark data (${new Date().toISOString().slice(0, 10)}) — ${COUNT} requested per intent/source`,
    intents:     ALL_INTENTS,
    sources: {
      clean:       'Well-formed, canonical inputs',
      voice:       'Voice/ASR noise — typos, garbling, filler words, mishearing',
      edge:        'Short, context-dependent, or structurally ambiguous',
      adversarial: 'Looks like intent X but is actually intent Y',
    },
    examples,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nWrote ${examples.length} examples to ${path.relative(process.cwd(), outPath)}`);
  console.log('\nRun the benchmark against generated data:');
  console.log('  node test/intent-bench.js --dataset=generated');
  console.log('  node test/intent-bench.js --dataset=both');
}

main().catch(err => {
  console.error('Generator error:', err.message);
  process.exit(1);
});

'use strict';

const http  = require('http');
const https = require('https');

/**
 * resolveAgent.js — StateGraph node
 *
 * LLM-driven agent selection. Decides which registered agents should be used,
 * which new agents need to be created, or what question to ask the user when
 * the task is ambiguous. Replaces regex-based service selection in enrichIntentV2.
 *
 * State inputs:
 *   state.intent.type          — must be 'command_automate' to activate
 *   state.message              — original user request
 *   state.resolvedMessage      — entity-resolved request
 *   state.llmBackend           — LLM backend for the selection prompt
 *   state.mcpAdapter           — MCP adapter to fetch registered agents
 *   state.gatherAnswerCallback — async fn(question) that awaits user reply inline
 *   state.progressCallback     — optional progress callback for ask_user events
 *
 * State outputs:
 *   state.resolveAgentResult   — { agents, reasoning, question }
 *   state.resolveAgentAnswers  — accumulated [{question, answer}] pairs
 */

const MAX_ROUNDS = 3;

// Known service hostname aliases for verification. Smaller and more stable than a
// full URL map; the primary source of truth is discovered via web.agent.
const SERVICE_HOST_ALIASES = {
  gmail:     ['google.com', 'mail.google.com'],
  youtube:   ['youtube.com'],
  github:    ['github.com'],
  chatgpt:   ['chatgpt.com', 'openai.com'],
  openai:    ['openai.com', 'chatgpt.com', 'platform.openai.com'],
  claude:    ['claude.ai', 'anthropic.com'],
  anthropic: ['anthropic.com', 'claude.ai'],
  twitter:   ['twitter.com', 'x.com'],
  x:         ['x.com', 'twitter.com'],
  deepseek:  ['deepseek.com', 'chat.deepseek.com'],
  perplexity:['perplexity.ai'],
  reddit:    ['reddit.com'],
  linkedin:  ['linkedin.com'],
  facebook:  ['facebook.com'],
  instagram: ['instagram.com'],
  spotify:   ['spotify.com', 'open.spotify.com'],
  netflix:   ['netflix.com'],
  amazon:    ['amazon.com'],
  ebay:      ['ebay.com'],
  notion:    ['notion.so'],
  slack:     ['slack.com'],
  discord:   ['discord.com'],
  w3schools: ['w3schools.com'],
  google:    ['google.com'],
};

const NAV_START_URL_KEY_PREFIX = 'nav-start-url:';

function _fallbackStartUrl(serviceKey) {
  return `https://www.${serviceKey}.com`;
}

function _isParkingContent(text = '') {
  const t = text.toLowerCase();
  return /\bdomain\s+(for\s+sale|is\s+for\s+sale|available\s+for\s+sale)\b/.test(t)
    || /\bbuy\s+this\s+domain\b/.test(t)
    || /\bmake\s+an?\s+offer\b/.test(t)
    || /\bparked\s+(by|domain|page)\b/.test(t)
    || /\binquire\s+about\s+this\s+domain\b/.test(t)
    || /\bthis\s+domain\s+(may\s+be|is)\s+(for\s+sale|available)\b/.test(t)
    || /buy.*domain|domain.*sale|domain.*park|domainbroker/i.test(t);
}

async function _httpGetBody(url, maxBytes = 4096, timeoutMs = 6000, redirectDepth = 0) {
  return new Promise((resolve) => {
    if (redirectDepth > 3) return resolve({ ok: false, reason: 'too-many-redirects' });
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve({ ok: false, reason: 'invalid-url' }); }
    const protocol = parsed.protocol === 'https:' ? https : http;
    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        const loc = new URL(res.headers.location, url).toString();
        return _httpGetBody(loc, maxBytes, timeoutMs, redirectDepth + 1).then(resolve);
      }
      if (status >= 400) return resolve({ ok: false, reason: `http-${status}` });
      let body = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        body += chunk;
        bytes += chunk.length;
        if (bytes >= maxBytes) {
          try { req.destroy(); } catch (_) {}
          resolve({ ok: true, body: body.slice(0, maxBytes), finalUrl: url });
        }
      });
      res.on('end', () => resolve({ ok: true, body, finalUrl: url }));
    });
    req.on('error', () => resolve({ ok: false, reason: 'network-error' }));
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      resolve({ ok: false, reason: 'timeout' });
    });
  });
}

async function _verifyDiscoveredUrl(url, serviceKey) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return { ok: false, reason: 'invalid-url' }; }
  const probe = await _httpGetBody(url, 4096, 6000);
  if (!probe.ok) return probe;

  const titleMatch = probe.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  if (_isParkingContent(title) || _isParkingContent(probe.body)) {
    return { ok: false, reason: 'parking-content' };
  }

  const host = parsed.hostname.toLowerCase();
  const service = serviceKey.toLowerCase();
  const acceptedHosts = [service, ...(SERVICE_HOST_ALIASES[service] || [])];
  const hostMatch = acceptedHosts.some(a => host === a || host.endsWith('.' + a));
  const textMatch = title.toLowerCase().includes(service) || probe.body.toLowerCase().includes(service);
  if (!hostMatch && !textMatch) {
    return { ok: false, reason: 'domain-mismatch' };
  }

  return { ok: true, finalUrl: probe.finalUrl || url };
}

async function _discoverVerifiedStartUrl(serviceKey, mcpAdapter, logger) {
  if (!mcpAdapter) return _fallbackStartUrl(serviceKey);

  // 1. Check user-memory cache first.
  try {
    const cached = await mcpAdapter.callService('user-memory', 'profile.get', {
      key: `${NAV_START_URL_KEY_PREFIX}${serviceKey}`,
    }, { timeoutMs: 2000 }).catch(() => null);
    const cachedUrl = cached?.data?.valueRef;
    if (cachedUrl) {
      const verified = await _verifyDiscoveredUrl(cachedUrl, serviceKey);
      if (verified.ok) return cachedUrl;
      logger.info(`[Node:ResolveAgent] Cached start URL ${cachedUrl} failed verification — rediscovering ${serviceKey}`);
    }
  } catch (err) {
    logger.debug(`[Node:ResolveAgent] Cache lookup failed for ${serviceKey}: ${err.message}`);
  }

  // 2. Discover via web.agent.
  let bestUrl = null;
  try {
    const webRes = await mcpAdapter.callService('command', 'web.agent', {
      action: 'search_and_navigate',
      query: `${serviceKey} official website`,
      preferDomain: serviceKey,
    }, { timeoutMs: 12000 }).catch(() => null);
    bestUrl = webRes?.data?.bestUrl || webRes?.bestUrl || null;
  } catch (err) {
    logger.warn(`[Node:ResolveAgent] web.agent discovery failed for ${serviceKey}: ${err.message}`);
  }

  // 3. Verify and cache.
  if (bestUrl) {
    const verified = await _verifyDiscoveredUrl(bestUrl, serviceKey);
    if (verified.ok) {
      try {
        await mcpAdapter.callService('user-memory', 'profile.set', {
          key: `${NAV_START_URL_KEY_PREFIX}${serviceKey}`,
          valueRef: bestUrl,
          service: serviceKey,
        }, { timeoutMs: 3000 }).catch(() => {});
      } catch (err) {
        logger.debug(`[Node:ResolveAgent] Cache write failed for ${serviceKey}: ${err.message}`);
      }
      return bestUrl;
    }
    logger.info(`[Node:ResolveAgent] Discovered URL ${bestUrl} failed verification — using fallback for ${serviceKey}`);
  }

  return _fallbackStartUrl(serviceKey);
}

async function _resolveStartUrlForService(service, userMessage, mcpAdapter, logger) {
  if (!service) return null;
  const key = service.toLowerCase().replace(/[^a-z0-9]/g, '');
  // If the user typed a bare hostname (e.g. "w3schools.com"), use it directly.
  const hostMatch = String(userMessage || '').match(/(?:https?:\/\/)?([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i);
  if (hostMatch) {
    const host = hostMatch[1].toLowerCase();
    return `https://${host}`;
  }
  return _discoverVerifiedStartUrl(key, mcpAdapter, logger);
}

const SYSTEM_PROMPT = `You are an agent selection assistant for a desktop automation system.

Given the user's task and the list of registered agents, decide which agents should be used, which new agents need to be created, or what concise question to ask the user if the task is ambiguous.

Registered agents are tools the system can use. Each has:
- id: e.g., "gmail.agent", "github.agent", "notion.agent"
- type: "cli" (command-line/API), "browser" (web automation), "app" (desktop app), "api_key", "bearer", or "basic" (REST credential agents)
- service: the service name, e.g., "gmail", "github", "notion"
- capabilities: list of actions the agent can perform
- status: "healthy", "degraded", "needs_update", etc.

Reason top-down:
1. What kind of execution does the task need? (CLI/API, browser, app, credential REST, or a mix)
2. Which registered agents, if any, can accomplish the task or part of it? Partial fits are allowed.
3. Prefer CLI/API agents first, then browser/app agents, then credential agents, when multiple can do the same thing.
4. For any gaps where no registered agent fits and the task maps to a browser or REST service, emit create: true.
5. If the task is ambiguous and no clear service/domain can be inferred, output a concise question to ask the user.

Respond with ONLY a single valid JSON object. No markdown, no prose, no code fences, no explanation before or after. The response must be parseable by JSON.parse().

Use this exact shape:
{
  "agents": [
    { "agentId": "gmail.agent", "role": "send the email", "exists": true, "create": false },
    { "agentId": "foo.agent", "role": "fetch the report", "exists": false, "create": true, "type": "browser", "service": "foo", "startUrl": "https://www.foo.com" }
  ],
  "reasoning": "The task requires sending an email, so gmail.agent is the right fit.",
  "question": null
}

Rules:
- If the user explicitly mentions an agent, service, or provider by name (e.g., "my gmail agent", "via gmail", "use notion"), select it.
- If the task clearly maps to one or more registered agents, return them in the "agents" array and set "question" to null.
- If the task clearly maps to a browser service but no matching agent is registered, emit "create": true, "type": "browser", and include "startUrl". For REST credential services, use "type": "api_key"/"bearer"/"basic" and include "startUrl". Do NOT ask the user "Would you like to create an agent?".
- If the task is ambiguous and the service/domain cannot be inferred (e.g., "send an email" without naming a provider), return a concise question like "Which email service should I use?" and leave "agents" empty.
- Only ask the user for clarification when the service is genuinely unknown or ambiguous. Never ask for permission to create an agent.
- The question must be 15 words or fewer.
- Do not include agents that are not needed for the task.`;

// Extract the outermost balanced JSON object from a string, ignoring surrounding text.
function _extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function _stripMarkdownFences(text) {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function _parseSelectionJson(text, logger) {
  const stripped = _stripMarkdownFences(text);

  // 1. Try to parse the whole stripped response.
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  // 2. Find the outermost balanced JSON object.
  const balanced = _extractBalancedJson(stripped);
  if (balanced) {
    try {
      const parsed = JSON.parse(balanced);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      logger.warn(`[Node:ResolveAgent] Balanced JSON still failed: ${err.message}`);
    }
  }

  return null;
}

async function _callSelectionLLM(llmBackend, userMessage, registeredAgents, priorQA, logger, attempt = 1) {
  const agentBlock = registeredAgents.length > 0
    ? `\n\nREGISTERED AGENTS:\n${registeredAgents.map(a => {
      const caps = Array.isArray(a.capabilities) ? a.capabilities.join(', ') : '';
      return `- ${a.id} (type: ${a.type}, service: ${a.service || 'n/a'}, status: ${a.status || 'unknown'}, capabilities: ${caps || 'none'})`;
    }).join('\n')}`
    : '\n\nREGISTERED AGENTS: none';

  const priorBlock = priorQA.length > 0
    ? '\n\nPrior clarifications:\n' + priorQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')
    : '';

  const strictInstruction = attempt > 1
    ? '\n\nCRITICAL: Return ONLY a JSON object. No markdown fences, no explanation, no bullet points, no text outside the JSON.'
    : '';

  const prompt = `USER TASK: "${userMessage}"${agentBlock}${priorBlock}${strictInstruction}

Select the right agent(s) for this task, or ask the user if ambiguous.`;

  try {
    const raw = await llmBackend.generateAnswer(prompt, {
      query: prompt,
      context: { systemInstructions: SYSTEM_PROMPT },
    }, { maxTokens: 350, temperature: 0 });

    const text = (typeof raw === 'string' ? raw : raw?.text || raw?.content || '').trim();
    logger.info(`[Node:ResolveAgent] LLM raw response (attempt ${attempt}, ${text.length} chars): ${text.slice(0, 200).replace(/\n/g, ' ')}`);

    const parsed = _parseSelectionJson(text, logger);
    if (!parsed) {
      if (attempt === 1) {
        logger.warn(`[Node:ResolveAgent] Could not parse JSON on attempt 1 — retrying with stricter prompt`);
        return _callSelectionLLM(llmBackend, userMessage, registeredAgents, priorQA, logger, attempt + 1);
      }
      logger.warn(`[Node:ResolveAgent] Could not parse JSON after retry — treating as ambiguous`);
      return { agents: [], reasoning: 'No structured selection returned.', question: 'Which service or agent should I use?' };
    }
    if (!Array.isArray(parsed.agents)) throw new Error('missing "agents" array');
    return {
      agents: parsed.agents,
      reasoning: parsed.reasoning || '',
      question: parsed.question || null,
    };
  } catch (err) {
    logger.warn(`[Node:ResolveAgent] LLM call failed (${err.message}) — treating as ambiguous`);
    return { agents: [], reasoning: 'LLM selection failed.', question: 'Which service or agent should I use?' };
  }
}

async function _normalizeAgentResult(result, registeredAgents, userMessage, mcpAdapter, logger) {
  const normalized = { agents: [], reasoning: result.reasoning || '', question: result.question || null };
  const registeredIds = new Set((registeredAgents || []).map(a => a.id?.toLowerCase()).filter(Boolean));

  for (const a of (result.agents || [])) {
    if (!a || typeof a !== 'object') continue;
    let agentId = (a.agentId || '').toLowerCase();
    if (!agentId) continue;
    if (!agentId.endsWith('.agent')) agentId += '.agent';
    const exists = registeredIds.has(agentId);
    const service = a.service || agentId.replace(/\.agent$/, '');
    const create = !!a.create;
    const type = a.type || 'browser';
    let startUrl = a.startUrl || null;
    if (create && (type === 'browser' || type === 'api_key' || type === 'bearer' || type === 'basic') && !startUrl) {
      startUrl = await _resolveStartUrlForService(service, userMessage, mcpAdapter, logger);
    }

    normalized.agents.push({
      agentId,
      role: a.role || '',
      exists: a.exists === undefined ? exists : !!a.exists,
      create,
      type,
      service,
      startUrl,
    });
  }

  return normalized;
}

module.exports = async function resolveAgent(state) {
  const logger = state.logger || console;
  const { intent, message, resolvedMessage, llmBackend, mcpAdapter } = state;
  const progressCallback = state.progressCallback || null;
  const gatherAnswerCallback = state.gatherAnswerCallback || null;

  // ── Skip: wrong intent ─────────────────────────────────────────────────────
  if (intent?.type !== 'command_automate') {
    return { ...state, resolveAgentResult: { agents: [], reasoning: 'Non-command intent', question: null } };
  }

  // ── Skip: already resolved for this exact message ──────────────────────────
  const userMessage = (resolvedMessage || message || '').trim();
  const cachedResult = state.resolveAgentResult;
  const cachedAgents = cachedResult && Array.isArray(cachedResult.agents) ? cachedResult.agents : [];
  const hasBareAgentIds = cachedAgents.some(a => a && a.agentId && !a.agentId.toLowerCase().endsWith('.agent'));
  if (cachedResult && cachedAgents.length > 0 && cachedResult._message === userMessage && !hasBareAgentIds) {
    logger.debug('[Node:ResolveAgent] Already resolved for this message — passthrough');
    return state;
  }
  if (hasBareAgentIds) {
    logger.info('[Node:ResolveAgent] Cached result contains bare agent ids — re-normalizing');
  }

  // ── Skip: no LLM backend or MCP adapter ──────────────────────────────────────
  if (!llmBackend) {
    logger.warn('[Node:ResolveAgent] No llmBackend — passthrough');
    return { ...state, resolveAgentResult: { agents: [], reasoning: 'No LLM backend', question: null } };
  }
  if (!mcpAdapter) {
    logger.warn('[Node:ResolveAgent] No mcpAdapter — passthrough');
    return { ...state, resolveAgentResult: { agents: [], reasoning: 'No MCP adapter', question: null } };
  }

  const priorAnswers = Array.isArray(state.resolveAgentAnswers) ? [...state.resolveAgentAnswers] : [];

  // ── Fetch registered agents ──────────────────────────────────────────────────
  let registeredAgents = [];
  try {
    const agRes = await mcpAdapter.callService('command', 'agent.list', {}, { timeoutMs: 3000 }).catch(() => null);
    registeredAgents = (agRes?.data || agRes || []).filter(a => a && a.id);
  } catch (e) {
    logger.warn(`[Node:ResolveAgent] Failed to fetch agent list: ${e.message}`);
  }

  // ── Inline Q&A loop (max MAX_ROUNDS) ───────────────────────────────────────
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (progressCallback) progressCallback({ type: 'thinking', message: 'Selecting the right agent…' });
    logger.info(`[Node:ResolveAgent] Round ${round + 1}/${MAX_ROUNDS} — selecting agents for: "${userMessage.slice(0, 80)}"`);

    const result = await _callSelectionLLM(llmBackend, userMessage, registeredAgents, priorAnswers, logger);
    const normalized = await _normalizeAgentResult(result, registeredAgents, userMessage, mcpAdapter, logger);

    logger.info(`[Node:ResolveAgent] Selection: ${normalized.agents.length} agent(s), question: ${normalized.question || 'none'}`);

    // Agents selected — done
    if (normalized.agents.length > 0) {
      return { ...state, resolveAgentResult: { ...normalized, _message: userMessage }, resolveAgentAnswers: priorAnswers };
    }

    // No question to ask — treat as no agents needed
    if (!normalized.question) {
      logger.info('[Node:ResolveAgent] No agents and no question — passthrough with empty result');
      return { ...state, resolveAgentResult: { agents: [], reasoning: normalized.reasoning, question: null, _message: userMessage }, resolveAgentAnswers: priorAnswers };
    }

    // Ask the user
    const question = normalized.question;
    logger.info(`[Node:ResolveAgent] Asking Q${round + 1}: "${question}"`);
    if (progressCallback) progressCallback({ type: 'ask_user', question, source: 'resolveAgent' });

    if (!gatherAnswerCallback) {
      logger.warn('[Node:ResolveAgent] No gatherAnswerCallback — cannot ask user');
      return { ...state, resolveAgentResult: { agents: [], reasoning: normalized.reasoning, question, _message: userMessage }, resolveAgentAnswers: priorAnswers };
    }

    try {
      const answer = await gatherAnswerCallback(question);
      if (!answer) {
        logger.warn(`[Node:ResolveAgent] No answer for Q${round + 1} — proceeding`);
        break;
      }
      priorAnswers.push({ question, answer });
      logger.info(`[Node:ResolveAgent] Answer Q${round + 1}: "${String(answer).slice(0, 80)}"`);
      if (progressCallback) progressCallback({ type: 'gather_answer_received' });
    } catch (err) {
      logger.warn(`[Node:ResolveAgent] gatherAnswerCallback threw: ${err.message} — proceeding`);
      break;
    }
  }

  // ── Exhausted rounds — return empty result ───────────────────────────────────
  logger.warn('[Node:ResolveAgent] Exhausted selection rounds — returning empty result');
  return { ...state, resolveAgentResult: { agents: [], reasoning: 'Could not resolve agent after max rounds', question: null, _message: userMessage }, resolveAgentAnswers: priorAnswers };
};

// Exposed for unit tests only.
module.exports._fallbackStartUrl = _fallbackStartUrl;
module.exports._isParkingContent = _isParkingContent;
module.exports._verifyDiscoveredUrl = _verifyDiscoveredUrl;
module.exports._resolveStartUrlForService = _resolveStartUrlForService;
module.exports._discoverVerifiedStartUrl = _discoverVerifiedStartUrl;
module.exports._httpGetBody = _httpGetBody;

'use strict';
/**
 * infraFailure.js — deterministic detector for ThinkDrop *infrastructure*
 * failures (dead/hung MCP services, circuit-breaker fail-fast, agent-registry
 * unavailability) as opposed to task-level failures (site blocked, wrong
 * selector, missing user input).
 *
 * Consumers:
 *   - executeCommand.js — tags stepResult._infraError and short-circuits
 *     _thinPostFailureHandler so a dead service never burns an LLM judgment
 *     or surfaces a meaningless free-text question.
 *   - evaluateSkills.js — backstop: an ASK_USER verdict whose reason/step
 *     errors carry an infra signature emits the structured infra question
 *     instead of { options: [] }.
 *   - advanceQueue.js → renderer — kind:'infra_failure' + infra detail drive
 *     the SystemFailureCard (plain summary, retry/report/dismiss, no input).
 *
 * Detection is deliberately conservative: only errors that can only have come
 * from OUR service layer match — the [MCPClient] prefix, the circuit-open
 * sentinel/phrasing, or a loopback transport error naming 127.0.0.1/localhost.
 * A remote website returning ECONNREFUSED is a task failure, not infra.
 */

// Service → user-facing label (mirrors ThinkDropMCPClient.serviceUrls).
const SERVICE_LABELS = {
  command: 'the automation service',
  'user-memory': 'the memory service',
  'web-search': 'the search service',
  conversation: 'the conversation service',
  'screen-intelligence': 'the screen service',
  phi4: 'the local model service',
  coreference: 'the language service',
  personality: 'the personality service',
  comms: 'the routing service',
  main: 'the main service',
};

// Loopback port → service (ThinkDropMCPClient.serviceUrls defaults +
// comms-graph's own listener).
const PORT_TO_SERVICE = {
  '3001': 'user-memory',
  '3002': 'web-search',
  '3004': 'conversation',
  '3006': 'coreference',
  '3007': 'command',
  '3008': 'screen-intelligence',
  '3009': 'phi4',
  '3010': 'main',
  '3012': 'personality',
  '3015': 'comms',
};

const _TRANSPORT_RE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|ETIMEDOUT/i;
const _LOOPBACK_HOST_RE = /127\.0\.0\.1|localhost|::1/i;
const _CIRCUIT_RE = /circuit\s*(?:breaker\s+)?is\s+open|circuit\s+open/i;

function _serviceFromUrl(url) {
  const port = (String(url).match(/:(\d{2,5})/) || [])[1];
  return (port && PORT_TO_SERVICE[port]) || null;
}

function _serviceLabel(service) {
  return SERVICE_LABELS[service] || 'an internal ThinkDrop service';
}

/**
 * detectInfraFailure(errOrText) → detail | null
 *
 * @param {Error|string|object|null} input — a thrown error, an error string,
 *   or a step-result-like object ({ code?, message?|error? }).
 * @returns {null | {
 *   signature: 'circuit_open'|'mcp_timeout'|'mcp_transport'|'registry_unavailable',
 *   service: string|null, waitMs: number|null, error: string
 * }}
 */
function detectInfraFailure(input) {
  if (!input) return null;
  const code = (typeof input === 'object' && input !== null) ? input.code : null;
  const text = String(
    (typeof input === 'object' && input !== null)
      ? (input.message || input.error || '')
      : input
  );
  if (!text && !code) return null;

  // 1. Circuit-breaker sentinel — err.code on the client throw, plus the
  //    message forms "[MCPClient] Circuit open for command — failing fast
  //    (24s cooldown)" and the post-hoc "circuit breaker is open on the
  //    command service" phrasing that downstream verdicts produce.
  if (code === 'CIRCUIT_OPEN' || _CIRCUIT_RE.test(text)) {
    const svcMatch = text.match(/circuit\s+(?:breaker\s+is\s+)?open\s+(?:for|on)\s+(?:the\s+)?([a-z][\w-]*)/i);
    let service = svcMatch ? svcMatch[1] : null;
    if (service === 'service' || service === 'breaker') service = null;
    const structuredWait = (typeof input === 'object' && input !== null) ? input.retryAfterMs : null;
    const waitS = structuredWait
      ? Math.ceil(structuredWait / 1000)
      : parseInt((text.match(/\((\d+)s\s+cooldown\)/i) || [])[1] || '0', 10);
    return {
      signature: 'circuit_open',
      service: service || (typeof input === 'object' && input !== null ? input.service : null) || null,
      waitMs: waitS > 0 ? waitS * 1000 : null,
      error: text,
    };
  }

  // 2. MCP transport timeout — "[MCPClient] Request timeout after 3000ms:
  //    http://127.0.0.1:3007/agent.list". The URL reveals the service.
  const timeoutMatch = text.match(/\[MCPClient\]\s*Request timeout after\s+(\d+)ms:\s*(\S+)/i);
  if (timeoutMatch) {
    return {
      signature: 'mcp_timeout',
      service: _serviceFromUrl(timeoutMatch[2]),
      waitMs: null,
      error: text,
    };
  }

  // 3. Agent-registry unavailability — the /agent.list fail-fast answer.
  if (/agent\s+registry\s+(is\s+)?(temporarily\s+)?unavailable/i.test(text)
      || /agent\.list.*(unavailable|failed)/i.test(text)) {
    return {
      signature: 'registry_unavailable',
      service: 'command',
      waitMs: null,
      error: text,
    };
  }

  // 4. Loopback transport error — "connect ECONNREFUSED 127.0.0.1:3007" or
  //    "socket hang up" naming a loopback host. Requires the loopback marker
  //    so remote-site failures don't classify as infra.
  if (_TRANSPORT_RE.test(text) && _LOOPBACK_HOST_RE.test(text)) {
    return {
      signature: 'mcp_transport',
      service: _serviceFromUrl(text),
      waitMs: null,
      error: text,
    };
  }

  return null;
}

/**
 * humanSummary(detail) — the plain-English line shown on the failure card.
 * No internalspeak: the user reads "the automation service", never "circuit
 * breaker" or a log path.
 */
function humanSummary(detail) {
  const label = _serviceLabel(detail && detail.service);
  switch (detail && detail.signature) {
    case 'circuit_open':
      return `${cap(label)} temporarily stopped responding — ThinkDrop paused calls to it for a short cooldown.`;
    case 'mcp_timeout':
      return `${cap(label)} didn't answer in time — it may be busy or stuck.`;
    case 'mcp_transport':
      return `${cap(label)} isn't reachable right now.`;
    case 'registry_unavailable':
      return `${cap(label)} couldn't load its agent registry.`;
    default:
      return 'An internal ThinkDrop service failed.';
  }
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * buildInfraPendingQuestion({ detail, failedStep, skillCursor }) — the shared
 * pendingQuestion shape consumed by advanceQueue.emitAskUser and the
 * renderer's SystemFailureCard. Options are handled by
 * handoffRunner.answerQuestion ('try_again' re-runs the step, 'cancel'
 * aborts); 'report_issue' is consumed renderer-side and never submitted.
 */
function buildInfraPendingQuestion({ detail, failedStep = null, skillCursor = 0, uiStepIndex = null } = {}) {
  const summary = humanSummary(detail);
  return {
    kind: 'infra_failure',
    question: `${summary} This is an internal ThinkDrop issue — not something you did.`,
    options: [
      { label: 'Try again', value: 'try_again', primary: true },
      { label: 'Report issue', value: 'report_issue' },
      { label: 'Dismiss', value: 'cancel' },
    ],
    freeText: false,
    stepIndex: skillCursor ?? 0,
    uiStepIndex: uiStepIndex ?? skillCursor ?? 0,
    skill: failedStep?.skill || null,
    agentId: failedStep?.args?.agentId || failedStep?.args?.agent || null,
    originalTask: failedStep?.args?.task || failedStep?.args?.goal || null,
    infra: {
      signature: detail.signature,
      service: detail.service || null,
      waitMs: detail.waitMs ?? null,
      error: String(detail.error || '').slice(0, 400),
    },
  };
}

module.exports = { detectInfraFailure, humanSummary, buildInfraPendingQuestion, SERVICE_LABELS, PORT_TO_SERVICE };

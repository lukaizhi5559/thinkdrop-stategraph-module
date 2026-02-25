/**
 * Journal Progress Node
 *
 * Writes StateGraph execution progress to ~/.thinkdrop/voice-state.json
 * so the Voice Service can peek at what's happening without blocking the graph.
 *
 * This node is inserted as a lightweight middleware wrapper around the
 * StateGraphBuilder — it does NOT appear in the main node graph itself.
 * Instead, the StateGraphBuilder wraps each node execution with journal writes.
 *
 * Exported helpers are called directly by StateGraphBuilder:
 *   - journalStart(state)        — called before graph execution begins
 *   - journalNodeDone(nodeName, durationMs, nodeIndex, totalNodes) — after each node
 *   - journalDone(state)         — called when graph completes
 *   - journalError(state, error) — called on graph error
 *   - checkSignals()             — returns pending voice signals (cancel/pause/inject)
 *   - acknowledgeSignal(id)      — marks a signal as done
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const JOURNAL_DIR = path.join(os.homedir(), '.thinkdrop');
const JOURNAL_PATH = path.join(JOURNAL_DIR, 'voice-state.json');

const DEFAULT_STATE = {
  stategraph: {
    status: 'idle',
    intent: null,
    currentNode: null,
    nodeIndex: 0,
    totalNodes: 0,
    startedAt: null,
    lastUpdate: null,
    summary: '',
    traceSteps: [],
    sessionId: null,
  },
  signals: [],
  voiceQueue: [],
  voice: {
    status: 'idle',
    lastSpokenAt: null,
    activationMode: 'wake-word',
    detectedLanguage: 'en',
  },
};

function _ensureDir() {
  try {
    if (!fs.existsSync(JOURNAL_DIR)) {
      fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    }
  } catch (_) {}
}

function _readJournal() {
  try {
    _ensureDir();
    if (!fs.existsSync(JOURNAL_PATH)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function _writeJournal(state) {
  try {
    _ensureDir();
    const tmp = JOURNAL_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, JOURNAL_PATH);
  } catch (_) {}
}

function _patch(updates) {
  const state = _readJournal();
  const next = { ...state };
  for (const [key, val] of Object.entries(updates)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      next[key] = { ...(state[key] || {}), ...val };
    } else {
      next[key] = val;
    }
  }
  _writeJournal(next);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called when a StateGraph run starts.
 * @param {Object} graphState - The initial StateGraph state object
 */
function journalStart(graphState) {
  const intent = graphState?.intent?.type || graphState?.intent || 'unknown';
  const sessionId = graphState?.context?.sessionId || graphState?.sessionId || null;

  _patch({
    stategraph: {
      status: 'running',
      intent,
      sessionId,
      currentNode: null,
      nodeIndex: 0,
      totalNodes: 0,
      startedAt: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      summary: `Starting ${intent}...`,
      traceSteps: [],
    },
  });
}

/**
 * Called after each StateGraph node completes.
 * @param {string} nodeName
 * @param {number} durationMs
 * @param {number} nodeIndex   - 1-based index
 * @param {number} totalNodes  - total expected nodes (0 if unknown)
 * @param {string} [nodeStatus] - 'done' | 'error' | 'skipped'
 */
function journalNodeDone(nodeName, durationMs, nodeIndex, totalNodes, nodeStatus = 'done') {
  const state = _readJournal();
  const traceSteps = [...(state.stategraph?.traceSteps || [])];
  traceSteps.push({ node: nodeName, status: nodeStatus, ms: durationMs });

  _patch({
    stategraph: {
      ...(state.stategraph || {}),
      status: 'running',
      currentNode: nodeName,
      nodeIndex,
      totalNodes: totalNodes || state.stategraph?.totalNodes || 0,
      lastUpdate: new Date().toISOString(),
      summary: `Running ${nodeName} (step ${nodeIndex}${totalNodes ? ` of ${totalNodes}` : ''})`,
      traceSteps: traceSteps.slice(-30),
    },
  });
}

/**
 * Called when the StateGraph run completes successfully.
 * @param {Object} graphState - Final StateGraph state
 */
function journalDone(graphState) {
  const intent = graphState?.intent?.type || graphState?.intent || 'unknown';
  const answer = graphState?.answer || '';
  const traceLen = graphState?.trace?.length || 0;

  _patch({
    stategraph: {
      status: 'done',
      intent,
      currentNode: null,
      lastUpdate: new Date().toISOString(),
      summary: answer
        ? `${intent} completed — ${answer.substring(0, 120)}${answer.length > 120 ? '...' : ''}`
        : `${intent} completed (${traceLen} steps)`,
    },
  });
}

/**
 * Called when the StateGraph run fails.
 * @param {Object} graphState
 * @param {Error|string} error
 */
function journalError(graphState, error) {
  const intent = graphState?.intent?.type || graphState?.intent || 'unknown';
  const errMsg = error?.message || String(error);

  _patch({
    stategraph: {
      status: 'error',
      intent,
      currentNode: null,
      lastUpdate: new Date().toISOString(),
      summary: `Error in ${intent}: ${errMsg.substring(0, 200)}`,
    },
  });
}

/**
 * Check for pending voice signals. Called by StateGraph's execution loop.
 * @returns {Array<{id, type, payload, ts, status}>}
 */
function checkSignals() {
  try {
    const state = _readJournal();
    return (state.signals || []).filter(s => s.status === 'pending');
  } catch (_) {
    return [];
  }
}

/**
 * Acknowledge a signal after acting on it.
 * @param {string} signalId
 * @param {string} [status] - 'done' | 'error'
 */
function acknowledgeSignal(signalId, status = 'done') {
  try {
    const state = _readJournal();
    const now = Date.now();
    const signals = (state.signals || [])
      .map(s => s.id === signalId ? { ...s, status } : s)
      .filter(s => s.status === 'pending' || (now - new Date(s.ts).getTime()) < 60000);
    _patch({ signals });
  } catch (_) {}
}

/**
 * Reset journal to idle (called on app startup).
 */
function journalReset() {
  _patch({
    stategraph: {
      status: 'idle',
      intent: null,
      currentNode: null,
      nodeIndex: 0,
      totalNodes: 0,
      startedAt: null,
      lastUpdate: new Date().toISOString(),
      summary: '',
      traceSteps: [],
      sessionId: null,
    },
    signals: [],
  });
}

module.exports = {
  journalStart,
  journalNodeDone,
  journalDone,
  journalError,
  checkSignals,
  acknowledgeSignal,
  journalReset,
  JOURNAL_PATH,
};

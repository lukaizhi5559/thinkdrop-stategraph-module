'use strict';
/**
 * taskRunner.js
 *
 * Dispatches long-running tasks (isLongRunning: true from decomposePrompt)
 * to a background playwright-cli subprocess with a 30-minute waitForContent timeout.
 *
 * Non-blocking: returns immediately after spawning.
 * Completion / timeout is reported back via state.progressCallback IPC bridge.
 */

const { spawn }  = require('child_process');
const fs         = require('fs');
const http       = require('http');

const MEMORY_SERVICE_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY         = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || '';

// Allow test overrides via environment variable — read dynamically per call
const getTimeoutMs  = () => parseInt(process.env.LONG_TASK_TIMEOUT_MS || String(30 * 60 * 1000), 10);
const getPlaywrightCli = () => process.env.PLAYWRIGHT_CLI_BIN || '/opt/homebrew/bin/playwright-cli';

// Module-level registry: taskId → { proc, watchdog }
const _activeTasks = new Map();

// ── DuckDB helpers ─────────────────────────────────────────────────────────────

function _memRequest(action, payload) {
  return new Promise((resolve) => {
    const envelope = {
      version:   'mcp.v1',
      service:   'user-memory',
      action,
      payload:   payload || {},
      requestId: 'tr_' + Date.now(),
    };
    const body    = JSON.stringify(envelope);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (MEM_API_KEY) headers['Authorization'] = 'Bearer ' + MEM_API_KEY;
    const req = http.request(
      { hostname: '127.0.0.1', port: MEMORY_SERVICE_PORT, path: '/' + action, method: 'POST', headers, timeout: 8000 },
      (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Register task in DuckDB via user-memory service.
 */
async function registerTask(payload) {
  return _memRequest('pending_tasks.create', payload);
}

/**
 * Update task status/result in DuckDB.
 */
async function updateTask(taskId, update) {
  return _memRequest('pending_tasks.update', { id: taskId, ...update });
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

/**
 * Dispatch a long-running task.
 *
 * Non-blocking — returns immediately after spawning playwright-cli.
 * Completion / timeout is signalled via progressCallback and onComplete / onTimeout callbacks.
 *
 * @param {object} opts
 * @param {string}   opts.taskId
 * @param {string}   opts.subPrompt
 * @param {string}   opts.intent
 * @param {number}   opts.stepOrder
 * @param {string}   opts.completionArg
 * @param {string}   opts.completionSignal  - 'waitForContent' | 'waitForSelector'
 * @param {object}   opts.planContext       - { intentResults, dataContext, intentQueue }
 * @param {string}   opts.originalPrompt
 * @param {string}   opts.sessionId
 * @param {Function} opts.onComplete        - (taskId, result) called when done
 * @param {Function} opts.onTimeout         - (taskId, pendingSteps, reason) called on timeout
 * @param {Function} opts.progressCallback  - IPC bridge for real-time events
 * @param {object}   opts.logger
 */
async function dispatch(opts) {
  const {
    taskId, subPrompt, intent, stepOrder,
    completionArg, completionSignal,
    planContext, originalPrompt, sessionId,
    onComplete, onTimeout, progressCallback, logger,
  } = opts;

  const _log = logger || console;

  // Guard: verify playwright-cli binary exists before spawning
  if (!fs.existsSync(getPlaywrightCli())) {
    _log.error && _log.error(`[TaskRunner] playwright-cli not found at ${getPlaywrightCli()} — cannot dispatch task ${taskId}`);
    if (typeof progressCallback === 'function') {
      progressCallback({ type: 'long_task_error', taskId, stepOrder, reason: `playwright-cli binary not found at ${getPlaywrightCli()}` });
    }
    return;
  }

  // 1. Persist record to DuckDB
  await registerTask({
    id:               taskId,
    sub_prompt:       subPrompt,
    intent,
    step_order:       stepOrder,
    plan_context:     JSON.stringify(planContext || {}),
    status:           'running',
    completion_signal: completionSignal || 'waitForContent',
    completion_arg:   completionArg || '',
    original_prompt:  originalPrompt,
    session_id:       sessionId || null,
  });

  if (typeof progressCallback === 'function') {
    progressCallback({
      type:             'long_task_start',
      taskId,
      stepOrder,
      intent,
      subPrompt:        subPrompt.slice(0, 80),
      completionSignal: completionSignal || 'waitForContent',
      completionArg:    completionArg || '',
    });
  }

  _log.info && _log.info(`[TaskRunner] Dispatching long task ${taskId}`, { intent, stepOrder, completionArg });

  // 2. Spawn playwright-cli subprocess  
  const args = [completionSignal || 'waitForContent', completionArg || ''];
  const proc = spawn(getPlaywrightCli(), args, {
    detached: false,
    stdio:    ['ignore', 'pipe', 'pipe'],
  });

  let accumulated = '';

  proc.stdout.on('data', (chunk) => {
    const line = chunk.toString();
    accumulated += line;
    if (typeof progressCallback === 'function') {
      progressCallback({ type: 'long_task_stdout', taskId, line: line.trim() });
    }
  });

  proc.stderr.on('data', (chunk) => {
    _log.debug && _log.debug(`[TaskRunner:${taskId}] stderr: ${chunk.toString().trim()}`);
  });

  // 3. Watchdog timer
  const watchdog = setTimeout(async () => {
    _log.warn && _log.warn(`[TaskRunner] Task ${taskId} timed out after ${getTimeoutMs()}ms`);
    proc.kill('SIGTERM');
    _activeTasks.delete(taskId);
    await updateTask(taskId, { status: 'timeout', error_text: 'Exceeded waitForContent timeout' });

    if (typeof progressCallback === 'function') {
      progressCallback({
        type:         'long_task_timeout',
        taskId,
        stepOrder,
        intent,
        subPrompt:    subPrompt.slice(0, 80),
        pendingSteps: (planContext && planContext.intentQueue) ? planContext.intentQueue : [],
        reason:       `The "${completionArg}" signal was not detected within the allowed time.`,
      });
    }

    if (typeof onTimeout === 'function') {
      onTimeout(taskId, (planContext && planContext.intentQueue) || [], `"${completionArg}" not detected within allowed time`);
    }
  }, getTimeoutMs());

  _activeTasks.set(taskId, { proc, watchdog });

  // 4. Handle subprocess exit
  proc.on('close', async (code) => {
    clearTimeout(watchdog);
    _activeTasks.delete(taskId);

    if (code === 0 || accumulated.length > 0) {
      _log.info && _log.info(`[TaskRunner] Task ${taskId} completed (exit: ${code})`);
      await updateTask(taskId, {
        status:       'done',
        completed_at: new Date().toISOString(),
        result:       accumulated.slice(0, 2000),
      });
      if (typeof progressCallback === 'function') {
        progressCallback({
          type:      'long_task_done',
          taskId,
          stepOrder,
          intent,
          result:    accumulated.slice(0, 500),
        });
      }
      if (typeof onComplete === 'function') {
        onComplete(taskId, accumulated);
      }
    } else {
      _log.warn && _log.warn(`[TaskRunner] Task ${taskId} exited with code ${code}`);
      await updateTask(taskId, { status: 'error', error_text: `playwright-cli exited with code ${code}` });
      if (typeof progressCallback === 'function') {
        progressCallback({ type: 'long_task_error', taskId, stepOrder, reason: `Exit code ${code}` });
      }
    }
  });
}

// ── Control helpers ────────────────────────────────────────────────────────────

/**
 * Cancel an active task by id — kills the subprocess and clears watchdog.
 */
function cancel(taskId) {
  const entry = _activeTasks.get(taskId);
  if (entry) {
    clearTimeout(entry.watchdog);
    entry.proc.kill('SIGTERM');
    _activeTasks.delete(taskId);
  }
}

/**
 * Return all active task ids currently tracked in this process.
 */
function listActive() {
  return Array.from(_activeTasks.keys());
}

module.exports = { dispatch, cancel, listActive };

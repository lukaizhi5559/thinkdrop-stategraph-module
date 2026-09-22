'use strict';

/**
 * taskJournalSearch.cjs — Keyword search over the comms-graph task journal.
 *
 * The queue journal (~/.thinkdrop/task-journal.json) records every handoff
 * task's prompt, status, timestamps, and final result. retrieveMemory consults
 * it during recall queries ("what about that task I queued", "remember the
 * flower project") so queued/completed work is searchable alongside
 * conversation messages and memories.
 *
 * Matching is keyword overlap (no embeddings — the journal is small and the
 * dependency cost isn't justified). Query tokens are stopword-stripped; each
 * task is scored on prompt (2x) + result/error text, with a recency tiebreak.
 *
 * Fail-open: any error returns [].
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'we', 'you', 'your', 'our', 'it', 'its',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'what', 'when', 'where', 'who', 'why', 'how', 'which',
  'that', 'this', 'these', 'those', 'there', 'here', 'and', 'or', 'but', 'if',
  'of', 'at', 'to', 'in', 'on', 'for', 'with', 'about', 'from', 'by', 'as',
  'not', 'no', 'yes', 'so', 'too', 'very', 'just', 'now', 'then', 'ago',
  'remember', 'remind', 'recall', 'thinkdrop', 'tell', 'told', 'ask', 'asked',
  'say', 'said', 'talk', 'talked', 'chat', 'chatted', 'discuss', 'discussed',
  'time', 'ago', 'earlier', 'before', 'previous', 'previously', 'recently',
  'some', 'any', 'all', 'can', 'could', 'would', 'should', 'please', 'ok',
  'okay', 'yeah', 'yep', 'thing', 'stuff', 'something', 'anything',
]);

function _journalPath() {
  const envPath = process.env.TASK_JOURNAL_PATH;
  if (envPath) return envPath.replace(/^~/, os.homedir());
  return path.join(os.homedir(), '.thinkdrop', 'task-journal.json');
}

function _loadTasks() {
  try {
    const p = _journalPath();
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function _tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
    // Crude plural stem so "flower" matches "flowers" — applied consistently
    // to query and document tokens.
    .map(t => (t.length >= 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

function _formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Search the task journal for tasks matching the query.
 * @param {string} queryText - raw user message (stopwords stripped internally)
 * @param {Object} [opts]
 * @param {number} [opts.limit=8]
 * @returns {Array<{id:string,prompt:string,status:string,createdAt:number,doneAt:number|null,
 *   result:string|null,error:string|null,intent:string,sessionId:string|null,
 *   score:number,formattedDate:string}>}
 */
function searchTaskJournal(queryText, opts = {}) {
  const limit = opts.limit || 8;
  const qTokens = new Set(_tokenize(queryText));
  if (qTokens.size === 0) return [];

  const tasks = _loadTasks();
  const scored = [];

  for (const t of tasks) {
    if (!t || !t.prompt) continue;
    const promptTokens = _tokenize(t.prompt);
    const resultTokens = _tokenize(`${t.result || ''} ${t.error || ''}`);
    let score = 0;
    const matched = new Set();
    for (const tok of promptTokens) {
      if (qTokens.has(tok)) { score += 2; matched.add(tok); }
    }
    for (const tok of resultTokens) {
      if (qTokens.has(tok)) { score += 1; matched.add(tok); }
    }
    if (score === 0) continue;
    // Recency tiebreak: newer tasks rank slightly higher on equal score.
    const recency = (t.createdAt || 0) / 1e13; // ~0.17 for 2026 epoch-ms
    scored.push({ task: t, score: score + recency, matched: [...matched] });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ task, score, matched }) => ({
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    doneAt: task.doneAt || null,
    result: typeof task.result === 'string' ? task.result.slice(0, 400) : null,
    error: task.error || null,
    intent: task.intent || null,
    sessionId: task.sessionId || null,
    score: Math.round(score * 100) / 100,
    matchedTokens: matched,
    formattedDate: _formatDate(task.doneAt || task.createdAt),
  }));
}

module.exports = { searchTaskJournal, _tokenize, _journalPath };

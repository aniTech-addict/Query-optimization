/**
 * In-memory activity log.
 * MCP actions, file watcher events, highlight events, and config changes are logged here.
 * The webview polls this to show a live activity feed.
 */

const MAX_ENTRIES = 200;

let log = [];
let idCounter = 0;

/**
 * @param {'scan' | 'analysis' | 'highlight' | 'config' | 'upload' | 'error' | 'info'} type
 * @param {string} message
 * @param {object} [details]
 */
function addEntry(type, message, details = null) {
  idCounter++;
  const entry = {
    id: idCounter,
    type,
    message,
    details,
    timestamp: new Date().toISOString(),
  };
  log.push(entry);
  if (log.length > MAX_ENTRIES) {
    log = log.slice(log.length - MAX_ENTRIES);
  }
  return entry;
}

/** Get entries newer than a given id (for incremental polling). */
function getEntriesSince(sinceId = 0) {
  return log.filter(e => e.id > sinceId);
}

/** Get the full log. */
function getAll() {
  return [...log];
}

function clear() {
  log = [];
}

module.exports = { addEntry, getEntriesSince, getAll, clear };

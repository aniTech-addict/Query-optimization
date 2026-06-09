/**
 * In-memory store for highlight requests.
 * The Express server writes to this, the VS Code extension reads from it.
 */

let pendingHighlights = [];

function addHighlights(highlights) {
  pendingHighlights.push(...highlights);
}

function consumeHighlights() {
  const items = [...pendingHighlights];
  pendingHighlights = [];
  return items;
}

function clearHighlights() {
  pendingHighlights = [];
}

function getPendingCount() {
  return pendingHighlights.length;
}

module.exports = { addHighlights, consumeHighlights, clearHighlights, getPendingCount };

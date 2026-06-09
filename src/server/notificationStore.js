/**
 * In-memory store for notification messages.
 * The MCP file watcher posts notifications here, the VS Code extension consumes them.
 */

let pendingNotifications = [];

function addNotification(message, level = 'info') {
  pendingNotifications.push({ message, level, timestamp: new Date().toISOString() });
}

function consumeNotifications() {
  const items = [...pendingNotifications];
  pendingNotifications = [];
  return items;
}

function getPendingCount() {
  return pendingNotifications.length;
}

module.exports = { addNotification, consumeNotifications, getPendingCount };

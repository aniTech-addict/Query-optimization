const vscode = require('vscode');
const path = require('path');
const http = require('http');
const { startServer, stopServer } = require('./server');
const { createWebviewPanel } = require('./webview/panel');
const db = require('./db');
const highlights = require('./highlights');

const EXPRESS_PORT = 3456;
const NOTIFY_POLL_MS = 2000;

let notifyTimer = null;
let configWatcher = null;
let currentPanel = null;

/**
 * Fetch and display notifications from the Express server.
 */
function fetchNotifications() {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${EXPRESS_PORT}/api/notifications`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function startNotificationPolling() {
  if (notifyTimer) return;
  notifyTimer = setInterval(async () => {
    const items = await fetchNotifications();
    for (const item of items) {
      if (item.level === 'warning' || item.level === 'error') {
        vscode.window.showWarningMessage(`[Mongoose Optimizer] ${item.message}`);
      } else {
        vscode.window.showInformationMessage(`[Mongoose Optimizer] ${item.message}`);
      }
    }
  }, NOTIFY_POLL_MS);
}

function stopNotificationPolling() {
  if (notifyTimer) {
    clearInterval(notifyTimer);
    notifyTimer = null;
  }
}

/**
 * Post an activity entry to the Express activity log.
 */
function logActivity(type, message, details = null) {
  const data = JSON.stringify({ type, message, details });
  const req = http.request({
    hostname: '127.0.0.1',
    port: EXPRESS_PORT,
    path: '/api/activity',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  });
  req.on('error', () => {});
  req.write(data);
  req.end();
}

/**
 * Upload all files from multiple src directories to pgvector.
 */
async function uploadSrcDirectories(srcPaths, workspaceRoot) {
  const decoder = new TextDecoder();
  let totalUploaded = 0;
  let totalFailed = 0;

  for (const srcRelative of srcPaths) {
    const srcUri = vscode.Uri.joinPath(workspaceRoot, srcRelative);
    try {
      const stat = await vscode.workspace.fs.stat(srcUri);
      if (stat.type !== vscode.FileType.Directory) {
        logActivity('error', `"${srcRelative}" is not a directory. Skipping.`);
        continue;
      }
    } catch {
      logActivity('error', `Directory "${srcRelative}" not found. Skipping.`);
      continue;
    }

    const fileUris = await findAllFiles(srcUri);
    if (fileUris.length === 0) {
      logActivity('info', `No files found in "${srcRelative}".`);
      continue;
    }

    let uploaded = 0;
    let failed = 0;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Uploading files from ${srcRelative}`,
        cancellable: false,
      },
      async (progress) => {
        for (let i = 0; i < fileUris.length; i++) {
          const fileUri = fileUris[i];
          const fileName = path.basename(fileUri.fsPath);
          const filePath = vscode.workspace.asRelativePath(fileUri);
          progress.report({
            message: `${i + 1}/${fileUris.length} — ${fileName}`,
            increment: (1 / fileUris.length) * 100,
          });
          try {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            const content = decoder.decode(raw);
            await db.storeTextFile(filePath, fileName, content);
            uploaded++;
          } catch {
            failed++;
          }
        }
      }
    );
    totalUploaded += uploaded;
    totalFailed += failed;
    logActivity('upload', `Uploaded ${uploaded} file(s) from "${srcRelative}"${failed > 0 ? `, ${failed} failed` : ''}`);
  }

  const msg = `Uploaded ${totalUploaded} file(s) to database.${totalFailed > 0 ? ` ${totalFailed} file(s) failed.` : ''}`;
  vscode.window.showInformationMessage(msg);
  logActivity('upload', msg);
}

/**
 * Read and parse the config file, returns null if not found.
 */
async function readConfig(workspaceRoot) {
  const configUri = vscode.Uri.joinPath(workspaceRoot, 'mongoose-optimizer-config.json');
  try {
    const raw = await vscode.workspace.fs.readFile(configUri);
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

/**
 * Start watching the config file for changes.
 */
function watchConfigFile(context, workspaceRoot) {
  if (configWatcher) {
    configWatcher.dispose();
  }
  const pattern = new vscode.RelativePattern(workspaceRoot, 'mongoose-optimizer-config.json');
  configWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  const handleConfigChange = async () => {
    const config = await readConfig(workspaceRoot);
    if (!config) return;

    logActivity('config', 'Config file changed — re-reading src paths');
    vscode.window.showInformationMessage('[Mongoose Optimizer] Config updated. Re-uploading source files...');

    // Normalize src to array
    let srcPaths = [];
    if (Array.isArray(config.src)) {
      srcPaths = config.src;
    } else if (typeof config.src === 'string') {
      srcPaths = [config.src];
    }

    if (srcPaths.length > 0) {
      await uploadSrcDirectories(srcPaths, workspaceRoot);
    }

    // Notify the webview if open
    if (currentPanel) {
      currentPanel.webview.postMessage({ command: 'configUpdated', config });
    }
  };

  configWatcher.onDidChange(handleConfigChange);
  configWatcher.onDidCreate(handleConfigChange);
  configWatcher.onDidDelete(() => {
    logActivity('config', 'Config file deleted');
  });

  context.subscriptions.push(configWatcher);
}

/**
 * Recursively find all files under a directory URI.
 */
async function findAllFiles(dirUri) {
  const files = [];
  const entries = await vscode.workspace.fs.readDirectory(dirUri);
  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(dirUri, name);
    if (type === vscode.FileType.File) {
      files.push(childUri);
    } else if (type === vscode.FileType.Directory) {
      const nested = await findAllFiles(childUri);
      files.push(...nested);
    }
  }
  return files;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Start the Express server
  const server = startServer();

  // Register the command that creates a JSON file
  const createJsonCmd = vscode.commands.registerCommand(
    'mongooseOptimizer.createJsonFile',
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri;

      const defaultContent = {
        src: [
           "./backend/src/db/", "./backend/src/controllers/", "./backend/src/db/models/", "backend/src/services"

        ],
        context: [
            "plain text context",
            "code snippets"
        ]
      };

      const configUri = vscode.Uri.joinPath(workspaceRoot, 'mongoose-optimizer-config.json');

      // Check if config already exists
      try {
        await vscode.workspace.fs.stat(configUri);
        const overwrite = await vscode.window.showWarningMessage(
          'mongoose-optimizer-config.json already exists. Overwrite it?',
          'Overwrite',
          'Cancel'
        );
        if (overwrite !== 'Overwrite') {
          return;
        }
      } catch {
        // File doesn't exist — proceed to create
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      await vscode.workspace.fs.writeFile(
        configUri,
        encoder.encode(JSON.stringify(defaultContent, null, 2))
      );

      vscode.window.showInformationMessage(
        `Created mongoose-optimizer-config.json in workspace root.`
      );

      // Open the config file in the editor
      const doc = await vscode.workspace.openTextDocument(configUri);
      await vscode.window.showTextDocument(doc);

      logActivity('config', 'Created mongoose-optimizer-config.json');

      // Upload files from all src paths
      await uploadSrcDirectories(defaultContent.src, workspaceRoot);
    }
  );

  context.subscriptions.push(createJsonCmd);

  // Dashboard webview command
  const openPanelCmd = vscode.commands.registerCommand(
    'mongooseOptimizer.openPanel',
    () => {
      if (currentPanel) {
        currentPanel.reveal();
        return;
      }
      currentPanel = createWebviewPanel(context);
      currentPanel.onDidDispose(() => { currentPanel = null; });
    }
  );
  context.subscriptions.push(openPanelCmd);

  // Watch config file for changes
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    watchConfigFile(context, workspaceFolders[0].uri);
  }

  // Start the highlight decoration system
  highlights.register(context);

  // Start polling for proactive analysis notifications
  startNotificationPolling();

  context.subscriptions.push({
    dispose: () => {
      stopNotificationPolling();
      stopServer(server);
      db.closePool();
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

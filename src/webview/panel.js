const vscode = require('vscode');
const path = require('path');
const http = require('http');

const EXPRESS_PORT = 3456;

function httpGet(urlPath) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${EXPRESS_PORT}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function httpDelete(urlPath) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: EXPRESS_PORT,
      path: urlPath,
      method: 'DELETE',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function createWebviewPanel(context) {
  const panel = vscode.window.createWebviewPanel(
    'mongooseOptimizer',
    'Mongoose Optimizer — Dashboard',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'dist'))
      ]
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview.js'))
  );

  panel.webview.html = getWebviewContent(scriptUri, panel.webview.cspSource);

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case 'createJson':
          vscode.commands.executeCommand('mongooseOptimizer.createJsonFile');
          break;
        case 'getActivity': {
          const sinceId = message.sinceId || 0;
          const entries = await httpGet(`/api/activity?since=${sinceId}`);
          panel.webview.postMessage({ command: 'activityUpdate', entries });
          break;
        }
        case 'clearActivity':
          await httpDelete('/api/activity');
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  return panel;
}

function getWebviewContent(scriptUri, cspSource) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mongoose Queries Optimizer</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { createWebviewPanel };

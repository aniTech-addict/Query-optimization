const vscode = require('vscode');
const http = require('http');
const path = require('path');

const EXPRESS_PORT = 3456;
const POLL_INTERVAL_MS = 1500;

// Output channel for showing suggestions in a readable panel
const outputChannel = vscode.window.createOutputChannel('Mongoose Optimizer');

// Diagnostic collection — shows squiggly underlines and entries in the Problems panel
const diagnosticCollection = vscode.languages.createDiagnosticCollection('mongoose-optimizer');

// Severity icon mapping
const SEVERITY_ICONS = {
  error: '🔴',
  warning: '🟡',
  info: '🔵',
  hint: '🟢',
};

// Map severity to VS Code DiagnosticSeverity
const DIAGNOSTIC_SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

// Decoration types per severity
const decorationTypes = {
  error: vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.15)',
    isWholeLine: true,
    overviewRulerColor: 'red',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 2px 0',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 60, 60, 0.8)',
  }),
  warning: vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 200, 0, 0.15)',
    isWholeLine: true,
    overviewRulerColor: 'yellow',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 2px 0',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 200, 0, 0.8)',
  }),
  info: vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(60, 140, 255, 0.12)',
    isWholeLine: true,
    overviewRulerColor: 'dodgerblue',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 2px 0',
    borderStyle: 'solid',
    borderColor: 'rgba(60, 140, 255, 0.7)',
  }),
  hint: vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy rgba(0, 200, 100, 0.7)',
    overviewRulerColor: 'green',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  }),
};

// Active decorations per file: Map<filePath, Map<severity, DecorationOptions[]>>
const activeDecorations = new Map();

let pollTimer = null;

/**
 * Fetch pending highlights from the Express server.
 */
function fetchHighlights() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${EXPRESS_PORT}/api/highlights`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * Normalize a file path for comparison.
 */
function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Resolve a highlight file path to an absolute URI.
 */
function resolveFileUri(filePath) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return null;

  // Try each workspace folder
  for (const folder of workspaceFolders) {
    const uri = vscode.Uri.joinPath(folder.uri, filePath);
    return uri;
  }
  return null;
}

/**
 * Check if an editor's document matches a highlight file path.
 */
function editorMatchesPath(editor, filePath) {
  const editorRelPath = normalizePath(vscode.workspace.asRelativePath(editor.document.uri));
  const highlightPath = normalizePath(filePath);
  return editorRelPath === highlightPath || editorRelPath.endsWith(highlightPath) || highlightPath.endsWith(editorRelPath);
}

/**
 * Apply decoration options to a visible editor.
 */
function applyToEditor(editor, filePath) {
  const fileDecorations = activeDecorations.get(filePath);
  if (!fileDecorations) return;

  for (const [severity, options] of fileDecorations.entries()) {
    const decoType = decorationTypes[severity];
    if (decoType) {
      editor.setDecorations(decoType, options);
    }
  }
}

/**
 * Clear all decorations, diagnostics, and output.
 */
function clearAll() {
  for (const editor of vscode.window.visibleTextEditors) {
    for (const decoType of Object.values(decorationTypes)) {
      editor.setDecorations(decoType, []);
    }
  }
  activeDecorations.clear();
  diagnosticCollection.clear();
}

/**
 * Write suggestions to the Output Channel in a readable format.
 */
function writeToOutputChannel(items) {
  const timestamp = new Date().toLocaleTimeString();
  outputChannel.appendLine(`\n${'═'.repeat(70)}`);
  outputChannel.appendLine(`  Mongoose Optimizer — ${items.length} suggestion(s) found at ${timestamp}`);
  outputChannel.appendLine(`${'═'.repeat(70)}\n`);

  // Group by file
  const byFile = new Map();
  for (const item of items) {
    if (!item.filePath || !item.line) continue;
    const fp = normalizePath(item.filePath);
    if (!byFile.has(fp)) byFile.set(fp, []);
    byFile.get(fp).push(item);
  }

  for (const [filePath, highlights] of byFile.entries()) {
    outputChannel.appendLine(`  📄 ${filePath}`);
    outputChannel.appendLine(`  ${'─'.repeat(60)}`);

    // Sort by line number
    highlights.sort((a, b) => a.line - b.line);

    for (const h of highlights) {
      const icon = SEVERITY_ICONS[h.severity] || '🔵';
      const severity = (h.severity || 'info').toUpperCase().padEnd(7);
      outputChannel.appendLine(`  ${icon} Line ${String(h.line).padStart(4)}  [${severity}]  ${h.message}`);
    }
    outputChannel.appendLine('');
  }

  outputChannel.appendLine(`${'═'.repeat(70)}\n`);
  outputChannel.show(true); // show but don't steal focus
}

/**
 * Add items to VS Code's Problems panel as diagnostics.
 */
function addDiagnostics(items) {
  // Group by file
  const byFile = new Map();
  for (const item of items) {
    if (!item.filePath || !item.line) continue;
    const fp = normalizePath(item.filePath);
    if (!byFile.has(fp)) byFile.set(fp, []);
    byFile.get(fp).push(item);
  }

  for (const [filePath, highlights] of byFile.entries()) {
    const fileUri = resolveFileUri(filePath);
    if (!fileUri) continue;

    const diagnostics = highlights.map(h => {
      const lineIndex = Math.max(0, h.line - 1);
      const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
      const severity = DIAGNOSTIC_SEVERITY[h.severity] || vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(range, h.message, severity);
      diagnostic.source = 'Mongoose Optimizer';
      return diagnostic;
    });

    // Merge with existing diagnostics for this file
    const existing = diagnosticCollection.get(fileUri) || [];
    diagnosticCollection.set(fileUri, [...existing, ...diagnostics]);
  }
}

/**
 * Process a batch of highlight items from the server.
 */
function processHighlights(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  // Check for clear command
  if (items.some(i => i.action === 'clear_all')) {
    clearAll();
    return;
  }

  // 1. Always write to Output Channel (guaranteed visible)
  writeToOutputChannel(items);

  // 2. Add to Problems panel as diagnostics (squiggly underlines)
  addDiagnostics(items);

  // 3. Try to apply editor decorations (colored line backgrounds)
  const byFile = new Map();
  for (const item of items) {
    if (!item.filePath || !item.line) continue;
    const normalized = normalizePath(item.filePath);
    if (!byFile.has(normalized)) byFile.set(normalized, []);
    byFile.get(normalized).push(item);
  }

  for (const [filePath, highlights] of byFile.entries()) {
    if (!activeDecorations.has(filePath)) {
      activeDecorations.set(filePath, new Map());
    }
    const fileMap = activeDecorations.get(filePath);

    for (const h of highlights) {
      const severity = h.severity || 'info';
      const lineIndex = Math.max(0, h.line - 1);

      const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
      const decoration = {
        range,
        hoverMessage: new vscode.MarkdownString(`**${severity.toUpperCase()}**: ${h.message}`)
      };

      if (!fileMap.has(severity)) fileMap.set(severity, []);
      fileMap.get(severity).push(decoration);
    }

    // Apply to any visible editor showing this file
    let applied = false;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editorMatchesPath(editor, filePath)) {
        applyToEditor(editor, filePath);
        applied = true;

        const firstLine = Math.max(0, highlights[0].line - 1);
        editor.revealRange(
          new vscode.Range(firstLine, 0, firstLine, 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      }
    }

    // If the file isn't open, open it and apply decorations
    if (!applied) {
      const fileUri = resolveFileUri(filePath);
      if (fileUri) {
        vscode.workspace.openTextDocument(fileUri).then(doc => {
          vscode.window.showTextDocument(doc, { preserveFocus: true }).then(editor => {
            applyToEditor(editor, filePath);
            const firstLine = Math.max(0, highlights[0].line - 1);
            editor.revealRange(
              new vscode.Range(firstLine, 0, firstLine, 0),
              vscode.TextEditorRevealType.InCenterIfOutsideViewport
            );
          });
        }, err => {
          console.error(`[Highlights] Failed to open ${filePath}: ${err.message}`);
        });
      }
    }
  }
}

/**
 * Start polling the Express server for highlight requests.
 */
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const items = await fetchHighlights();
      if (items.length > 0) {
        processHighlights(items);
      }
    } catch (err) {
      console.error(`[Highlights] Poll error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Re-apply decorations when an editor becomes visible.
 */
function onEditorVisible(editor) {
  const editorRelPath = normalizePath(vscode.workspace.asRelativePath(editor.document.uri));
  for (const [filePath] of activeDecorations) {
    if (editorRelPath === filePath || editorRelPath.endsWith(filePath) || filePath.endsWith(editorRelPath)) {
      applyToEditor(editor, filePath);
    }
  }
}

/**
 * Register the highlight system with the extension context.
 */
function register(context) {
  startPolling();

  // Re-apply when switching tabs
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        onEditorVisible(editor);
      }
    })
  );

  // Register a command to clear all highlights manually
  context.subscriptions.push(
    vscode.commands.registerCommand('mongooseOptimizer.clearHighlights', () => {
      clearAll();
      vscode.window.showInformationMessage('All highlights cleared.');
    })
  );

  // Cleanup on dispose
  context.subscriptions.push({ dispose: stopPolling });
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(diagnosticCollection);
  for (const decoType of Object.values(decorationTypes)) {
    context.subscriptions.push(decoType);
  }
}

module.exports = { register, clearAll };

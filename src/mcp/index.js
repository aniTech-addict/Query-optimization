require('dotenv').config({ override: true });
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const http = require('http');
const db = require('../db');
const gemini = require('./gemini');
const instructions = require('./instructions');

const EXPRESS_PORT = 3456;
const MAX_CONTEXT_CHARS = 24000;
const MAX_FILES_PER_BATCH = 4;

/**
 * Send a POST request to the Express server running inside the VS Code extension.
 */
function postToExpress(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: EXPRESS_PORT,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve(body); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function logActivity(type, message, details = null) {
  return postToExpress('/api/activity', { type, message, details }).catch(() => {});
}

function preview(text, max = 240) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function buildFileBatches(files, maxFiles = MAX_FILES_PER_BATCH, maxChars = MAX_CONTEXT_CHARS) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const file of files) {
    const block = `--- ${file.file_path} ---\n${file.content}`;
    const blockSize = block.length + 2;
    const exceedsFileLimit = current.length >= maxFiles;
    const exceedsCharLimit = current.length > 0 && (currentChars + blockSize) > maxChars;

    if (exceedsFileLimit || exceedsCharLimit) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(file);
    currentChars += blockSize;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function renderFilesContext(files) {
  return files
    .map((r) => `--- ${r.file_path} ---\n${r.content}`)
    .join('\n\n');
}

const server = new McpServer({
  name: 'mongoose-optimizer-mcp',
  version: '0.0.1'
});

// ─── Resource: system instructions ───────────────────────────────────────────

server.registerResource(
  'instructions',
  'mongoose-optimizer://instructions',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/plain',
      text: instructions.getSystemPrompt()
    }]
  })
);

// ─── registerTool: query_files ───────────────────────────────────────────────────────
// Search stored files by keyword in content

server.registerTool(
  'query_files',
  'Search stored text files by keyword in their content',
  { keyword: z.string().describe('Keyword to search for in file contents') },
  async ({ keyword }) => {
    try {
      const pool = db.getPool();
      const res = await pool.query(
        `SELECT id, file_path, file_name,
                SUBSTRING(content FROM 1 FOR 500) AS preview
         FROM text_files
         WHERE content ILIKE $1
         ORDER BY updated_at DESC
         LIMIT 10`,
        [`%${keyword}%`]
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(res.rows, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: get_file ──────────────────────────────────────────────────────────
// Retrieve a single file's full content by path

server.registerTool(
  'get_file',
  'Get the full content of a stored file by its path',
  { filePath: z.string().describe('The relative file path to retrieve') },
  async ({ filePath }) => {
    try {
      const file = await db.getFileByPath(filePath);
      if (!file) {
        return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
      }
      return {
        content: [{
          type: 'text',
          text: `// ${file.file_path}\n\n${file.content}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: list_files ────────────────────────────────────────────────────────
// List all files in the database

server.registerTool(
  'list_files',
  'List all text files stored in the pgvector database',
  {},
  async () => {
    try {
      const files = await db.getAllFiles();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(files, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: ask_gemini ────────────────────────────────────────────────────────
// Send a prompt to Gemini with optional context from the database

server.registerTool(
  'ask_gemini',
  'Ask Google Gemini a question, optionally with context from stored files',
  {
    prompt: z.string().describe('The question or instruction for Gemini'),
    includeContext: z.boolean().optional().default(false)
      .describe('If true, fetches all stored file contents and includes them as context'),
    filePaths: z.array(z.string()).optional()
      .describe('Specific file paths to include as context (optional)')
  },
  async ({ prompt, includeContext, filePaths }) => {
    try {
      let context = '';
      const includedFiles = [];

      if (filePaths && filePaths.length > 0) {
        const fileContents = [];
        for (const fp of filePaths) {
          const file = await db.getFileByPath(fp);
          if (file) {
            fileContents.push(file);
            includedFiles.push(file.file_path);
          }
        }
        const batches = buildFileBatches(fileContents);
        context = batches.map((batch, index) => (
          `### Context Batch ${index + 1}/${batches.length}\n${renderFilesContext(batch)}`
        )).join('\n\n');
      } else if (includeContext) {
        const pool = db.getPool();
        const res = await pool.query(
          'SELECT file_path, content FROM text_files ORDER BY updated_at DESC LIMIT 20'
        );
        const batches = buildFileBatches(res.rows);
        context = batches.map((batch, index) => (
          `### Context Batch ${index + 1}/${batches.length}\n${renderFilesContext(batch)}`
        )).join('\n\n');
        includedFiles.push(...res.rows.map((r) => r.file_path));
      }

      const fullPrompt = context
        ? `${instructions.getSystemPrompt()}\n\n--- CONTEXT FROM DATABASE ---\n${context}\n\n--- USER QUERY ---\n${prompt}`
        : `${instructions.getSystemPrompt()}\n\n${prompt}`;

      await logActivity('analysis', 'Gemini optimization query sent', {
        promptPreview: preview(prompt, 180),
        includeContext: Boolean(includeContext),
        requestedFileCount: Array.isArray(filePaths) ? filePaths.length : 0,
        includedFileCount: includedFiles.length,
        includedFiles,
      });

      const result = await gemini.askWithMeta(fullPrompt);
      const response = result.text;

      await logActivity('analysis', `Gemini response received (${result.model})`, {
        model: result.model,
        attempts: result.attempts,
        responseChars: response.length,
        responsePreview: preview(response),
        includedFileCount: includedFiles.length,
        includedFiles,
      });

      return {
        content: [{
          type: 'text',
          text: `Model: ${result.model}\nAttempts: ${result.attempts}\nIncluded files: ${includedFiles.length}\n\n${response}`,
        }]
      };
    } catch (err) {
      await logActivity('error', 'Gemini optimization query failed', {
        error: err.message,
        hasFilePaths: Array.isArray(filePaths) && filePaths.length > 0,
      });
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: analyze_mongoose_models ───────────────────────────────────────────
// Use Gemini to analyze all stored mongoose model files

server.registerTool(
  'analyze_mongoose_models',
  'Analyze all stored Mongoose model files using Gemini and suggest optimizations',
  {},
  async () => {
    try {
      const pool = db.getPool();
      const res = await pool.query(
        'SELECT file_path, content FROM text_files ORDER BY file_path'
      );

      if (res.rows.length === 0) {
        return { content: [{ type: 'text', text: 'No files found in the database. Upload files first.' }] };
      }

      const batches = buildFileBatches(res.rows);
      const batchAnalyses = [];

      for (let i = 0; i < batches.length; i++) {
        const batchPrompt = `${instructions.getSystemPrompt()}\n\n` +
          `--- MONGOOSE MODEL FILES BATCH ${i + 1}/${batches.length} ---\n${renderFilesContext(batches[i])}\n\n` +
          `Analyze this batch and provide:\n` +
          `1. Model/schema summary\n` +
          `2. Query performance issues\n` +
          `3. Optimization suggestions\n` +
          `4. Anti-patterns or best-practice violations`;

        const partial = await gemini.askWithMeta(batchPrompt);
        batchAnalyses.push(`## Batch ${i + 1}/${batches.length}\nModel: ${partial.model}\nAttempts: ${partial.attempts}\n\n${partial.text}`);
      }

      const synthesisPrompt = `${instructions.getSystemPrompt()}\n\n` +
        `You are given per-batch analyses for a full codebase scan. Consolidate them into one final report without duplicate findings.\n\n` +
        `Required sections:\n` +
        `1. Executive Summary\n` +
        `2. Highest Impact Issues\n` +
        `3. Optimization Plan (ordered)\n` +
        `4. Quick Wins vs Structural Fixes\n\n` +
        `--- BATCH ANALYSES ---\n${batchAnalyses.join('\n\n')}`;

      const finalReport = await gemini.askWithMeta(synthesisPrompt);
      return {
        content: [{
          type: 'text',
          text: `Batches analyzed: ${batches.length}\nFinal model: ${finalReport.model}\nAttempts: ${finalReport.attempts}\n\n${finalReport.text}`,
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Filesystem / VS Code Tools ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: resolve and validate a path is within the workspace
function safePath(basePath, userPath) {
  const resolved = path.resolve(basePath, userPath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error('Path escapes the workspace root. Access denied.');
  }
  return resolved;
}

// Helper: recursively collect file paths
async function walkDir(dir, baseDir, results = []) {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      await walkDir(fullPath, baseDir, results);
    } else {
      results.push(relPath);
    }
  }
  return results;
}

// ─── registerTool: list_directory ────────────────────────────────────────────
// List contents of a directory on disk

server.registerTool(
  'list_directory',
  'List files and folders inside a directory on disk (relative to workspace root). Returns names with / suffix for directories.',
  {
    dirPath: z.string().default('.').describe('Relative path to the directory (default: workspace root)'),
  },
  async ({ dirPath }) => {
    try {
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      const resolved = safePath(workspaceRoot, dirPath);
      const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => e.name !== 'node_modules' && e.name !== '.git')
        .map(e => e.isDirectory() ? `${e.name}/` : e.name)
        .sort();
      return {
        content: [{
          type: 'text',
          text: `Directory: ${dirPath}\n\n${items.join('\n')}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: read_file_from_disk ───────────────────────────────────────
// Read the content of a file directly from disk

server.registerTool(
  'read_file_from_disk',
  'Read the full content of a file from disk by its relative path (relative to workspace root)',
  {
    filePath: z.string().describe('Relative path to the file to read'),
  },
  async ({ filePath }) => {
    try {
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      const resolved = safePath(workspaceRoot, filePath);
      const stat = await fsPromises.stat(resolved);
      if (!stat.isFile()) {
        return { content: [{ type: 'text', text: `Not a file: ${filePath}` }], isError: true };
      }
      if (stat.size > 1024 * 1024) {
        return { content: [{ type: 'text', text: `File too large (${(stat.size / 1024).toFixed(0)} KB). Max 1 MB.` }], isError: true };
      }
      const content = await fsPromises.readFile(resolved, 'utf-8');
      return {
        content: [{
          type: 'text',
          text: `// ${filePath} (${stat.size} bytes)\n\n${content}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: search_files ──────────────────────────────────────────────
// Search for files matching a glob/name pattern in a directory tree

server.registerTool(
  'search_files',
  'Search for files by name pattern in a directory tree on disk. Returns matching relative paths. Skips node_modules and .git.',
  {
    pattern: z.string().describe('Substring or simple pattern to match against file names (case-insensitive). E.g. ".model.js" or "schema"'),
    dirPath: z.string().default('.').describe('Relative directory to search in (default: workspace root)'),
  },
  async ({ pattern, dirPath }) => {
    try {
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      const resolved = safePath(workspaceRoot, dirPath);
      const allFiles = await walkDir(resolved, resolved);
      const lowerPattern = pattern.toLowerCase();
      const matches = allFiles.filter(f =>
        path.basename(f).toLowerCase().includes(lowerPattern) ||
        f.toLowerCase().includes(lowerPattern)
      );
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `No files matching "${pattern}" found in ${dirPath}` }] };
      }
      const displayDir = dirPath === '.' ? 'workspace root' : dirPath;
      return {
        content: [{
          type: 'text',
          text: `Found ${matches.length} file(s) matching "${pattern}" in ${displayDir}:\n\n${matches.join('\n')}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: grep_in_files ─────────────────────────────────────────────
// Search for text content inside files in a directory

server.registerTool(
  'grep_in_files',
  'Search for a text pattern inside file contents across a directory tree on disk. Returns file paths and matching lines. Skips node_modules and .git.',
  {
    searchTerm: z.string().describe('Text or regex pattern to search for inside files'),
    dirPath: z.string().default('.').describe('Relative directory to search in (default: workspace root)'),
    fileExtensions: z.array(z.string()).optional()
      .describe('Optional file extensions to filter (e.g. [".js", ".ts"]). If omitted, searches all text files.'),
  },
  async ({ searchTerm, dirPath, fileExtensions }) => {
    try {
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      const resolved = safePath(workspaceRoot, dirPath);
      const allFiles = await walkDir(resolved, resolved);

      const filtered = fileExtensions && fileExtensions.length > 0
        ? allFiles.filter(f => fileExtensions.some(ext => f.endsWith(ext)))
        : allFiles;

      let regex;
      try {
        regex = new RegExp(searchTerm, 'gi');
      } catch {
        regex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      }

      const results = [];
      for (const relFile of filtered) {
        const fullPath = path.join(resolved, relFile);
        try {
          const stat = await fsPromises.stat(fullPath);
          if (stat.size > 512 * 1024) continue; // skip files > 512KB
          const content = await fsPromises.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const matchingLines = [];
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matchingLines.push({ line: i + 1, text: lines[i].trim() });
            }
            regex.lastIndex = 0; // reset for global regex
          }
          if (matchingLines.length > 0) {
            results.push({ file: relFile, matches: matchingLines.slice(0, 10) });
          }
        } catch {
          // skip unreadable files
        }
        if (results.length >= 50) break; // cap results
      }

      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No matches for "${searchTerm}" in ${dirPath}` }] };
      }

      const output = results.map(r => {
        const matchLines = r.matches.map(m => `  L${m.line}: ${m.text}`).join('\n');
        return `${r.file}\n${matchLines}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found matches in ${results.length} file(s):\n\n${output}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: file_info ─────────────────────────────────────────────────
// Get metadata about a file or directory

server.registerTool(
  'file_info',
  'Get metadata about a file or directory on disk (size, type, modified time)',
  {
    targetPath: z.string().describe('Relative path to the file or directory'),
  },
  async ({ targetPath }) => {
    try {
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      const resolved = safePath(workspaceRoot, targetPath);
      const stat = await fsPromises.stat(resolved);
      const info = {
        path: targetPath,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? `${(stat.size / 1024).toFixed(1)} KB` : null,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      };
      if (stat.isDirectory()) {
        const entries = await fsPromises.readdir(resolved);
        info.childCount = entries.filter(e => e !== 'node_modules' && e !== '.git').length;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: directory_tree ────────────────────────────────────────────
// Get a tree view of a directory

server.registerTool(
  'directory_tree',
  'Get a tree-like view of all files and folders under a directory (recursive). Skips node_modules and .git. Useful for understanding project structure.',
  {
    dirPath: z.string().default('.').describe('Relative directory path (default: workspace root)'),
    maxDepth: z.number().optional().default(4).describe('Maximum depth to recurse (default: 4)'),
  },
  async ({ dirPath, maxDepth }) => {
    try {
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      const resolved = safePath(workspaceRoot, dirPath);
      const lines = [];

      async function buildTree(dir, prefix, depth) {
        if (depth > maxDepth) {
          lines.push(`${prefix}...`);
          return;
        }
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        const filtered = entries.filter(e => e.name !== 'node_modules' && e.name !== '.git');
        filtered.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        for (let i = 0; i < filtered.length; i++) {
          const entry = filtered[i];
          const isLast = i === filtered.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = isLast ? '    ' : '│   ';
          if (entry.isDirectory()) {
            lines.push(`${prefix}${connector}${entry.name}/`);
            await buildTree(path.join(dir, entry.name), prefix + childPrefix, depth + 1);
          } else {
            lines.push(`${prefix}${connector}${entry.name}`);
          }
        }
      }

      const displayName = dirPath === '.' ? path.basename(resolved) : dirPath;
      lines.push(`${displayName}/`);
      await buildTree(resolved, '', 1);

      return {
        content: [{ type: 'text', text: lines.join('\n') }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VS Code Editor Decoration Tools ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── registerTool: highlight_lines ───────────────────────────────────────────
// Highlight or underline specific lines in VS Code editor

server.registerTool(
  'highlight_lines',
  'Highlight or underline specific lines in a file inside the VS Code editor to show suggestions. ' +
  'The highlights appear as colored backgrounds or underlines with hover messages. ' +
  'Use this to visually point out issues, improvements, or important lines in code.',
  {
    filePath: z.string().describe('Relative file path to highlight lines in'),
    highlights: z.array(z.object({
      line: z.number().describe('1-based line number to highlight'),
      message: z.string().describe('Hover tooltip message explaining the suggestion'),
      severity: z.enum(['error', 'warning', 'info', 'hint']).optional().default('info')
        .describe('Severity level: error (red), warning (yellow), info (blue), hint (green underline)')
    })).describe('Array of line highlights with messages'),
  },
  async ({ filePath, highlights }) => {
    try {
      const formatted = highlights.map(h => ({
        filePath,
        line: h.line,
        message: h.message,
        severity: h.severity || 'info'
      }));

      const result = await postToExpress('/api/highlights', { highlights: formatted });

      const summary = highlights
        .map(h => `  L${h.line} [${h.severity || 'info'}]: ${h.message}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Queued ${highlights.length} highlight(s) for ${filePath}:\n${summary}\n\nThe highlights will appear in the VS Code editor.`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error sending highlights: ${err.message}` }], isError: true };
    }
  }
);

// ─── registerTool: clear_highlights ──────────────────────────────────────────
// Clear all active highlights from the editor

server.registerTool(
  'clear_highlights',
  'Clear all active highlight decorations from the VS Code editor',
  {},
  async () => {
    try {
      await postToExpress('/api/highlights', { highlights: [{ action: 'clear_all' }] });
      return {
        content: [{ type: 'text', text: 'Sent clear request. All highlights will be removed from the editor.' }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Start the server ────────────────────────────────────────────────────────

const fileWatcher = require('./fileWatcher');

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mongoose Optimizer MCP server running on stdio');

  // Verify AI connectivity on startup
  try {
    const reply = await gemini.ask('Respond with exactly: OK');
    console.error(`Gemini check: ${reply.trim()}`);
  } catch (err) {
    console.error(`Gemini check FAILED: ${err.message}`);
  }

  // Start proactive file watcher (polls every 60s for changes)
  fileWatcher.start();
}

main().catch((err) => {
  console.error('Fatal MCP server error:', err);
  process.exit(1);
});

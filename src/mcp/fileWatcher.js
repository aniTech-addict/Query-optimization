const fsPromises = require('fs/promises');
const path = require('path');
const http = require('http');
const gemini = require('./gemini');
const instructions = require('./instructions');
const db = require('../db');
const {
  normalizeIssueType,
  getImpactRange,
  inferModelOrCollection,
} = require('../server/issueClassifier');

const EXPRESS_PORT = 3456;
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vscode']);
const TEXT_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.json', '.mjs', '.cjs']);
const MAX_FILES_PER_ANALYSIS_CYCLE = 25;
const MAX_BATCH_FILES = 3;
const MAX_BATCH_CHARS = 22000;

// Snapshot: Map<relativePath, { mtime: number, size: number }>
let snapshot = new Map();
let pollTimer = null;
let isAnalyzing = false;

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function postJSON(endpoint, body) {
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
          'Content-Length': Buffer.byteLength(data),
        },
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

function sendNotification(message, level = 'info') {
  return postJSON('/api/notifications', { message, level }).catch(() => {});
}

function sendHighlights(highlights) {
  return postJSON('/api/highlights', { highlights }).catch(() => {});
}

function logActivity(type, message, details = null) {
  return postJSON('/api/activity', { type, message, details }).catch(() => {});
}

function preview(text, max = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

// ─── Filesystem scanning ─────────────────────────────────────────────────────

async function scanDir(dir, baseDir, results = []) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      await scanDir(fullPath, baseDir, results);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const stat = await fsPromises.stat(fullPath);
        results.push({ relPath, fullPath, mtime: stat.mtimeMs, size: stat.size });
      } catch { /* skip */ }
    }
  }
  return results;
}

function resolveWatchDirs() {
  const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
  // Try reading the config file for the src directories
  try {
    const configPath = path.join(workspaceRoot, 'mongoose-optimizer-config.json');
    const configRaw = require('fs').readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    if (config.src) {
      const srcPaths = Array.isArray(config.src) ? config.src : [config.src];
      const resolved = [];
      for (const s of srcPaths) {
        const r = path.resolve(workspaceRoot, s);
        if (r.startsWith(path.resolve(workspaceRoot))) {
          resolved.push(r);
        }
      }
      if (resolved.length > 0) return resolved;
    }
  } catch { /* no config yet */ }
  return [workspaceRoot];
}

// ─── Diff and analysis ───────────────────────────────────────────────────────

function diffSnapshots(oldSnap, currentFiles) {
  const added = [];
  const modified = [];
  const deleted = [];

  const currentMap = new Map();
  for (const f of currentFiles) {
    currentMap.set(f.relPath, f);
    if (!oldSnap.has(f.relPath)) {
      added.push(f);
    } else {
      const prev = oldSnap.get(f.relPath);
      if (f.mtime !== prev.mtime || f.size !== prev.size) {
        modified.push(f);
      }
    }
  }

  for (const [relPath] of oldSnap) {
    if (!currentMap.has(relPath)) {
      deleted.push(relPath);
    }
  }

  return { added, modified, deleted };
}

function chunkFilesForAnalysis(files, maxFilesPerBatch = MAX_BATCH_FILES, maxCharsPerBatch = MAX_BATCH_CHARS) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const file of files) {
    const approxChars = (file.content?.length || 0) + (file.path?.length || 0) + 32;
    const exceedsFileLimit = current.length >= maxFilesPerBatch;
    const exceedsCharLimit = current.length > 0 && (currentChars + approxChars) > maxCharsPerBatch;

    if (exceedsFileLimit || exceedsCharLimit) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(file);
    currentChars += approxChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function parseGeminiIssues(rawText) {
  let cleaned = String(rawText || '').trim();
  if (!cleaned) return [];

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  }

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function dedupeIssues(issues) {
  const seen = new Set();
  const deduped = [];
  for (const issue of issues) {
    const key = [
      String(issue.filePath || ''),
      Number(issue.line || 0),
      String(issue.issueType || ''),
      String(issue.severity || ''),
      String(issue.message || ''),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function inferLocalIssues(fileContents) {
  const findings = [];

  for (const file of fileContents) {
    const lines = String(file.content || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      if (/for\s*\(|forEach\s*\(|\.map\s*\(/.test(line)) {
        const nearby = lines.slice(i, i + 8).join('\n');
        if (/\.(find|findOne|findById|countDocuments|aggregate)\s*\(/.test(nearby)) {
          findings.push({
            filePath: file.path,
            line: lineNo,
            severity: 'error',
            issueType: 'n_plus_one',
            message: 'Potential N+1 pattern: query appears inside an iteration block; consider batching with $in or aggregation.',
            modelOrCollection: inferModelOrCollection(file.path, nearby),
          });
        }
      }

      if (/\.(find|findOne|findById)\s*\(/.test(line) && !/\.lean\s*\(/.test(line)) {
        const nearby = lines.slice(i, i + 5).join('\n');
        if (!/\.lean\s*\(/.test(nearby)) {
          findings.push({
            filePath: file.path,
            line: lineNo,
            severity: 'warning',
            issueType: 'missing_lean',
            message: 'Read query may be missing .lean(); add it for read-only paths to reduce hydration overhead.',
            modelOrCollection: inferModelOrCollection(file.path, line),
          });
        }
      }

      if (/\.find\s*\([^\)]*\)\s*(?:\.|$)/.test(line) && /\b(id|email|username|slug)\b/i.test(line)) {
        findings.push({
          filePath: file.path,
          line: lineNo,
          severity: 'info',
          issueType: 'find_instead_of_findone',
          message: 'This lookup appears singular; prefer findOne() over find() when expecting one document.',
          modelOrCollection: inferModelOrCollection(file.path, line),
        });
      }

      if (/\.find\s*\(\s*\{\s*\}\s*\)/.test(line)) {
        const nearby = lines.slice(i, i + 8).join('\n');
        if (!/\.limit\s*\(/.test(nearby)) {
          findings.push({
            filePath: file.path,
            line: lineNo,
            severity: 'warning',
            issueType: 'no_pagination',
            message: 'Unbounded find({}) detected; add limit/skip or cursor pagination to control result size.',
            modelOrCollection: inferModelOrCollection(file.path, line),
          });
        }
      }

      if (/\.aggregate\s*\(\s*\[/.test(line)) {
        const nearby = lines.slice(i, i + 16).join('\n');
        const hasEarlyMatch = /\[\s*\{\s*\$match\s*:/.test(nearby);
        if (!hasEarlyMatch) {
          findings.push({
            filePath: file.path,
            line: lineNo,
            severity: 'warning',
            issueType: 'unbounded_aggregation',
            message: 'Aggregation may be unbounded; place a selective $match early and consider a $limit stage.',
            modelOrCollection: inferModelOrCollection(file.path, nearby),
          });
        }
      }
    }
  }

  return dedupeIssues(findings);
}

async function analyzeChangedFiles(changedFiles) {
  if (changedFiles.length === 0) return;

  // Keep a broad but bounded analysis window and split into smaller model-safe batches.
  const toAnalyze = changedFiles.slice(0, MAX_FILES_PER_ANALYSIS_CYCLE);
  const fileContents = [];

  for (const f of toAnalyze) {
    try {
      if (f.size > 512 * 1024) continue; // skip files > 512KB
      const content = await fsPromises.readFile(f.fullPath, 'utf-8');
      fileContents.push({ path: f.relPath, content });
    } catch { /* skip unreadable */ }
  }

  if (fileContents.length === 0) return;

  const batches = chunkFilesForAnalysis(fileContents);
  const localFindings = inferLocalIssues(fileContents);
  const aiIssues = [];

  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const filesBlock = batch
        .map((f) => `--- ${f.path} ---\n${f.content}`)
        .join('\n\n');

      const prompt = `${instructions.getSystemPrompt()}

--- CHANGED FILES BATCH ${batchIndex + 1}/${batches.length} (auto-detected) ---
${filesBlock}

Analyze only this batch for Mongoose/MongoDB issues.
Respond ONLY with a valid JSON array. Each element must have:
- "filePath": relative file path (string)
- "line": 1-based line number (number)
- "severity": "error" | "warning" | "info" | "hint"
- "message": short explanation (string)
- Optional "issueType": normalized issue key
- Optional "modelOrCollection": best-effort model or collection name

If no issues are found, return an empty array: []
Do NOT include markdown fences or any text outside the JSON array.`;

      try {
        const aiResult = await gemini.askWithMeta(prompt);
        const response = aiResult.text;
        const parsedIssues = parseGeminiIssues(response);
        aiIssues.push(...parsedIssues);

        await logActivity('analysis', `Gemini watcher batch response received (${aiResult.model})`, {
          model: aiResult.model,
          attempts: aiResult.attempts,
          batch: `${batchIndex + 1}/${batches.length}`,
          analyzedFiles: batch.map((f) => f.path),
          responseChars: response.length,
          responsePreview: preview(response),
        });
      } catch (batchErr) {
        await logActivity('error', 'Gemini watcher batch failed', {
          batch: `${batchIndex + 1}/${batches.length}`,
          error: batchErr.message,
          files: batch.map((f) => f.path),
        });
      }
    }

    const issues = dedupeIssues([...aiIssues, ...localFindings]);

    // Validate and shape highlights
    const highlights = issues
      .filter(i => i.filePath && typeof i.line === 'number' && i.message)
      .map(i => ({
        filePath: i.filePath,
        line: i.line,
        message: `[Auto] ${i.message}`,
        severity: ['error', 'warning', 'info', 'hint'].includes(i.severity) ? i.severity : 'info',
      }));

    const normalizedIssues = issues
      .filter(i => i.filePath && typeof i.line === 'number' && i.message)
      .map((i) => {
        const issueType = normalizeIssueType(i.issueType, i.message);
        const impactRange = getImpactRange(issueType);
        return {
          filePath: i.filePath,
          lineNumber: i.line,
          severity: ['error', 'warning', 'info', 'hint'].includes(i.severity) ? i.severity : 'info',
          issueType,
          modelOrCollection: inferModelOrCollection(i.filePath, i.message),
          message: String(i.message),
          latencyMinPct: impactRange.latencyMin,
          latencyMaxPct: impactRange.latencyMax,
          memoryMinPct: impactRange.memoryMin,
          memoryMaxPct: impactRange.memoryMax,
        };
      });

    const analyzedFilePaths = fileContents.map((f) => f.path);

    try {
      await db.upsertIssuesForScan(normalizedIssues, analyzedFilePaths);
    } catch (dbErr) {
      console.error('[FileWatcher] Failed to persist issue metrics:', dbErr.message);
      await logActivity('error', 'Failed to persist issue metrics', { error: dbErr.message });
    }

    if (highlights.length > 0) {
      await sendHighlights(highlights);
      const fileNames = [...new Set(highlights.map(h => h.filePath))].join(', ');
      await sendNotification(
        `Proactive scan found ${highlights.length} suggestion(s) in: ${fileNames}`,
        'info'
      );
      await logActivity('highlight', `Sent ${highlights.length} highlight(s) for: ${fileNames}`, {
        count: highlights.length,
        files: [...new Set(highlights.map(h => h.filePath))],
      });
    } else {
      await logActivity('analysis', `No issues found in ${analyzedFilePaths.length} analyzed file(s)`, {
        files: analyzedFilePaths,
        batches: batches.length,
      });
    }
  } catch (err) {
    console.error('[FileWatcher] Gemini analysis error:', err.message);
  }
}

// ─── Polling loop ────────────────────────────────────────────────────────────

async function tick() {
  if (isAnalyzing) return; // skip if previous analysis is still running
  isAnalyzing = true;

  try {
    const watchDirs = resolveWatchDirs();
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();

    // Scan all src directories
    let currentFiles = [];
    for (const dir of watchDirs) {
      const files = await scanDir(dir, workspaceRoot);
      currentFiles.push(...files);
    }

    // First run — build initial snapshot and analyze all files
    if (snapshot.size === 0) {
      for (const f of currentFiles) {
        snapshot.set(f.relPath, { mtime: f.mtime, size: f.size });
      }
      await logActivity('scan', `Initial snapshot: ${snapshot.size} file(s) across ${watchDirs.length} directory(ies)`);
      console.error(`[FileWatcher] Initial snapshot: ${snapshot.size} file(s)`);

      // Run initial analysis on all files
      if (currentFiles.length > 0) {
        console.error(`[FileWatcher] Running initial analysis on ${currentFiles.length} file(s)...`);
        await sendNotification(
          `Initial scan: analyzing ${currentFiles.length} file(s)...`,
          'info'
        );
        await logActivity('analysis', `Initial analysis: sending ${currentFiles.length} file(s) to AI`);
        await analyzeChangedFiles(currentFiles);
      }

      isAnalyzing = false;
      return;
    }

    const diff = diffSnapshots(snapshot, currentFiles);

    // Update snapshot regardless
    snapshot = new Map();
    for (const f of currentFiles) {
      snapshot.set(f.relPath, { mtime: f.mtime, size: f.size });
    }

    const changedCount = diff.added.length + diff.modified.length;
    if (changedCount === 0 && diff.deleted.length === 0) {
      isAnalyzing = false;
      return;
    }

    console.error(
      `[FileWatcher] Detected: +${diff.added.length} added, ~${diff.modified.length} modified, -${diff.deleted.length} deleted`
    );
    await logActivity('scan', `Detected changes: +${diff.added.length} added, ~${diff.modified.length} modified, -${diff.deleted.length} deleted`);

    const changedFiles = [...diff.added, ...diff.modified];
    if (changedFiles.length > 0) {
      await sendNotification(
        `Analyzing ${changedFiles.length} changed file(s)...`,
        'info'
      );
      await logActivity('analysis', `Sending ${changedFiles.length} file(s) to Gemini for analysis`);
      await analyzeChangedFiles(changedFiles);
    }

    if (diff.deleted.length > 0) {
      await sendNotification(
        `${diff.deleted.length} file(s) deleted: ${diff.deleted.join(', ')}`,
        'warning'
      );
      await logActivity('scan', `${diff.deleted.length} file(s) deleted: ${diff.deleted.join(', ')}`);
    }
  } catch (err) {
    console.error('[FileWatcher] Poll error:', err.message);
  } finally {
    isAnalyzing = false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

function start() {
  if (pollTimer) return;
  console.error('[FileWatcher] Starting proactive file watcher (60s interval)');
  // Run first tick after a short delay to let Express boot up
  setTimeout(() => {
    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }, 5000);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { start, stop };

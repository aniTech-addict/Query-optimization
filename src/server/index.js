const express = require('express');
const path = require('path');
const db = require('../db');
const highlightStore = require('./highlightStore');
const notificationStore = require('./notificationStore');
const activityLog = require('./activityLog');

let serverInstance = null;
const PORT = 3456;

function formatError(err) {
  if (!err) return 'Unknown server error';
  if (typeof err === 'string') return err;
  if (err.message && String(err.message).trim().length > 0) return err.message;
  if (err.code) return `Error code: ${err.code}`;
  return 'Unexpected server error';
}

function fallbackCurrentIssues(reason) {
  return {
    totalIssues: 0,
    estimatedDegradation: {
      latencyPctRange: { min: 0, max: 0 },
      memoryPctRange: { min: 0, max: 0 },
    },
    bySeverity: [],
    byIssueType: [],
    byModelOrCollection: [],
    degraded: true,
    warning: reason,
  };
}

function fallbackPerformance(reason) {
  return {
    potential: {
      issueCount: 0,
      latencyPctRange: { min: 0, max: 0 },
      memoryPctRange: { min: 0, max: 0 },
    },
    realized: {
      issueCount: 0,
      latencyPctRange: { min: 0, max: 0 },
      memoryPctRange: { min: 0, max: 0 },
    },
    degraded: true,
    warning: reason,
  };
}

function fallbackHotspots(reason) {
  return {
    byModelOrCollection: [],
    byIssueType: [],
    degraded: true,
    warning: reason,
  };
}

function fallbackIssueDetails(reason) {
  return {
    generatedAt: new Date().toISOString(),
    sampleLimitPerType: 3,
    issueDetails: [],
    degraded: true,
    warning: reason,
  };
}

function startServer() {
  const app = express();

  app.use(express.json());

  db.ensureMetricsSchema().catch((err) => {
    console.error('[Server] Failed to initialize metrics schema:', err.message);
  });

  // Health check
  app.get('/api/health', async (_req, res) => {
    let dbOk = false;
    try {
      dbOk = await db.testConnection();
    } catch (_) {}
    res.json({ status: 'ok', database: dbOk, timestamp: new Date().toISOString() });
  });

  // Get default JSON template
  app.get('/api/template', (_req, res) => {
    res.json({
      name: 'mongoose-queries-optimizer',
      version: '1.0.0',
      queries: [],
      optimizations: [],
      createdAt: new Date().toISOString()
    });
  });

  // Simple metrics dashboard webpage for checking implementation impact.
  app.get('/dashboard/metrics', (_req, res) => {
    res.sendFile(path.join(__dirname, 'metrics-dashboard.html'));
  });

  // --- pgvector / text file routes ---

  // Store a text file
  app.post('/api/files', async (req, res) => {
    try {
      const { filePath, fileName, content } = req.body;
      if (!filePath || !fileName || !content) {
        return res.status(400).json({ error: 'filePath, fileName, and content are required.' });
      }
      const record = await db.storeTextFile(filePath, fileName, content);
      res.json(record);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all stored files
  app.get('/api/files', async (_req, res) => {
    try {
      const files = await db.getAllFiles();
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get a file by path (query param ?path=...)
  app.get('/api/files/lookup', async (req, res) => {
    try {
      const { path } = req.query;
      if (!path) {
        return res.status(400).json({ error: 'path query parameter is required.' });
      }
      const file = await db.getFileByPath(path);
      if (!file) return res.status(404).json({ error: 'File not found.' });
      res.json(file);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a file record
  app.delete('/api/files', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: 'filePath is required.' });
      }
      const deleted = await db.deleteFileByPath(filePath);
      res.json({ deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Similarity search (expects { embedding: number[] } in body)
  app.post('/api/files/search', async (req, res) => {
    try {
      const { embedding, limit } = req.body;
      if (!embedding || !Array.isArray(embedding)) {
        return res.status(400).json({ error: 'embedding array is required.' });
      }
      const results = await db.searchSimilar(embedding, limit || 5);
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Highlight / decoration routes ---

  // Accept highlight requests (called by the MCP tool)
  app.post('/api/highlights', (req, res) => {
    try {
      const { highlights } = req.body;
      if (!Array.isArray(highlights) || highlights.length === 0) {
        return res.status(400).json({ error: 'highlights array is required.' });
      }
      highlightStore.addHighlights(highlights);
      res.json({ queued: highlights.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Consume pending highlights (called by the VS Code extension)
  app.get('/api/highlights', (_req, res) => {
    const items = highlightStore.consumeHighlights();
    res.json(items);
  });

  // Clear all pending highlights
  app.delete('/api/highlights', (_req, res) => {
    highlightStore.clearHighlights();
    res.json({ cleared: true });
  });

  // --- Notification routes ---

  // Accept notifications (called by the MCP file watcher)
  app.post('/api/notifications', (req, res) => {
    try {
      const { message, level } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'message is required.' });
      }
      notificationStore.addNotification(message, level || 'info');
      res.json({ queued: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Consume pending notifications (called by the VS Code extension)
  app.get('/api/notifications', (_req, res) => {
    const items = notificationStore.consumeNotifications();
    res.json(items);
  });

  // --- Activity log routes ---

  // Log an activity entry (called by MCP / file watcher)
  app.post('/api/activity', (req, res) => {
    try {
      const { type, message, details } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'message is required.' });
      }
      const entry = activityLog.addEntry(type || 'info', message, details || null);
      res.json(entry);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get activity entries (supports ?since=id for incremental polling)
  app.get('/api/activity', (_req, res) => {
    const sinceId = parseInt(_req.query.since, 10) || 0;
    const entries = activityLog.getEntriesSince(sinceId);
    res.json(entries);
  });

  // Clear activity log
  app.delete('/api/activity', (_req, res) => {
    activityLog.clear();
    res.json({ cleared: true });
  });

  // --- Metrics routes ---

  app.get('/api/metrics/current-issues', async (_req, res) => {
    try {
      const metrics = await db.getCurrentIssuesMetrics();
      res.json(metrics);
    } catch (err) {
      const reason = formatError(err);
      console.error('[Metrics] current-issues failed:', reason);
      res.json(fallbackCurrentIssues(reason));
    }
  });

  app.get('/api/metrics/performance-improvement', async (_req, res) => {
    try {
      const metrics = await db.getPerformanceImprovementMetrics();
      res.json(metrics);
    } catch (err) {
      const reason = formatError(err);
      console.error('[Metrics] performance-improvement failed:', reason);
      res.json(fallbackPerformance(reason));
    }
  });

  app.get('/api/metrics/high-issue-areas', async (_req, res) => {
    try {
      const limit = parseInt(_req.query.limit, 10) || 10;
      const metrics = await db.getHighIssueAreasMetrics(limit);
      res.json(metrics);
    } catch (err) {
      const reason = formatError(err);
      console.error('[Metrics] high-issue-areas failed:', reason);
      res.json(fallbackHotspots(reason));
    }
  });

  app.get('/api/metrics/summary', async (_req, res) => {
    try {
      const limit = parseInt(_req.query.limit, 10) || 10;
      const metrics = await db.getMetricsSummary(limit);
      res.json(metrics);
    } catch (err) {
      const reason = formatError(err);
      console.error('[Metrics] summary failed:', reason);
      res.json({
        generatedAt: new Date().toISOString(),
        scope: 'all-time-default',
        currentIssues: fallbackCurrentIssues(reason),
        performanceImprovement: fallbackPerformance(reason),
        highIssueAreas: fallbackHotspots(reason),
        degraded: true,
        warning: reason,
      });
    }
  });

  app.get('/api/metrics/issue-details', async (_req, res) => {
    try {
      const limit = parseInt(_req.query.limit, 10) || 3;
      const metrics = await db.getIssueDetailsMetrics(limit);
      res.json(metrics);
    } catch (err) {
      const reason = formatError(err);
      console.error('[Metrics] issue-details failed:', reason);
      res.json(fallbackIssueDetails(reason));
    }
  });

  serverInstance = app.listen(PORT, () => {
    console.log(`Mongoose Optimizer Express server running on port ${PORT}`);
  });

  return serverInstance;
}

function stopServer(server) {
  const s = server || serverInstance;
  if (s) {
    s.close();
    console.log('Mongoose Optimizer Express server stopped.');
  }
}

module.exports = { startServer, stopServer };

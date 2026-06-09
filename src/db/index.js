const { Pool } = require('pg');

let pool = null;
let metricsSchemaReady = false;

const DB_CONFIG = {
  host: 'localhost',
  port: 5433,
  user: 'optimizer',
  password: 'optimizer_secret',
  database: 'mongoose_optimizer'
};

function getPool() {
  if (!pool) {
    pool = new Pool(DB_CONFIG);
  }
  return pool;
}

async function ensureMetricsSchema() {
  if (metricsSchemaReady) return;

  const query = `
    CREATE TABLE IF NOT EXISTS issues (
      id SERIAL PRIMARY KEY,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      severity TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      model_or_collection TEXT NOT NULL,
      message TEXT NOT NULL,
      latency_min_pct INTEGER NOT NULL,
      latency_max_pct INTEGER NOT NULL,
      memory_min_pct INTEGER NOT NULL,
      memory_max_pct INTEGER NOT NULL,
      first_detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      last_detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      occurrence_count INTEGER DEFAULT 1,
      resolved_at TIMESTAMP WITH TIME ZONE,
      UNIQUE(file_path, line_number, issue_type)
    );

    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues (resolved_at);
    CREATE INDEX IF NOT EXISTS idx_issues_issue_type ON issues (issue_type);
    CREATE INDEX IF NOT EXISTS idx_issues_model ON issues (model_or_collection);
    CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues (severity);
    CREATE INDEX IF NOT EXISTS idx_issues_last_detected ON issues (last_detected_at);
    CREATE INDEX IF NOT EXISTS idx_issues_file_path ON issues (file_path);
  `;

  await getPool().query(query);
  metricsSchemaReady = true;
}

async function testConnection() {
  const client = await getPool().connect();
  try {
    const res = await client.query('SELECT 1 AS ok');
    return res.rows[0].ok === 1;
  } finally {
    client.release();
  }
}

/**
 * Upsert a text file's content into the database.
 * If the file_path already exists, it updates the content.
 */
async function storeTextFile(filePath, fileName, content) {
  const query = `
    INSERT INTO text_files (file_path, file_name, content, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (file_path)
    DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
    RETURNING id, file_path, file_name, created_at, updated_at;
  `;
  const res = await getPool().query(query, [filePath, fileName, content]);
  return res.rows[0];
}

/**
 * Store a text file along with its embedding vector.
 */
async function storeTextFileWithEmbedding(filePath, fileName, content, embedding) {
  const embeddingStr = `[${embedding.join(',')}]`;
  const query = `
    INSERT INTO text_files (file_path, file_name, content, embedding, updated_at)
    VALUES ($1, $2, $3, $4::vector, NOW())
    ON CONFLICT (file_path)
    DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, updated_at = NOW()
    RETURNING id, file_path, file_name, created_at, updated_at;
  `;
  const res = await getPool().query(query, [filePath, fileName, content, embeddingStr]);
  return res.rows[0];
}

/**
 * Search for similar files by cosine similarity to a given embedding.
 */
async function searchSimilar(embedding, limit = 5) {
  const embeddingStr = `[${embedding.join(',')}]`;
  const query = `
    SELECT id, file_path, file_name, content,
           1 - (embedding <=> $1::vector) AS similarity
    FROM text_files
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
  `;
  const res = await getPool().query(query, [embeddingStr, limit]);
  return res.rows;
}

/**
 * Get all stored text files.
 */
async function getAllFiles() {
  const query = `
    SELECT id, file_path, file_name,
           LENGTH(content) AS content_length,
           created_at, updated_at
    FROM text_files
    ORDER BY updated_at DESC;
  `;
  const res = await getPool().query(query);
  return res.rows;
}

/**
 * Get a single file by path.
 */
async function getFileByPath(filePath) {
  const query = `SELECT * FROM text_files WHERE file_path = $1;`;
  const res = await getPool().query(query, [filePath]);
  return res.rows[0] || null;
}

/**
 * Delete a file record by path.
 */
async function deleteFileByPath(filePath) {
  const query = `DELETE FROM text_files WHERE file_path = $1 RETURNING id;`;
  const res = await getPool().query(query, [filePath]);
  return res.rowCount > 0;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Number(value)));
}

function getSeverityWeight(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'error':
      return 1.0;
    case 'warning':
      return 0.75;
    case 'info':
      return 0.45;
    case 'hint':
      return 0.3;
    default:
      return 0.5;
  }
}

function computeRiskAdjustedImpact(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      latencyPctRange: { min: 0, max: 0 },
      memoryPctRange: { min: 0, max: 0 },
    };
  }

  let latencyMinWeighted = 0;
  let latencyMaxWeighted = 0;
  let memoryMinWeighted = 0;
  let memoryMaxWeighted = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const severityWeight = getSeverityWeight(row.severity);
    const occurrences = Math.max(1, Number(row.occurrence_count) || 1);
    const occurrenceWeight = Math.log2(occurrences + 1);
    const weight = severityWeight * occurrenceWeight;

    totalWeight += weight;
    latencyMinWeighted += clampPercent(Number(row.latency_min_pct) || 0) * weight;
    latencyMaxWeighted += clampPercent(Number(row.latency_max_pct) || 0) * weight;
    memoryMinWeighted += clampPercent(Number(row.memory_min_pct) || 0) * weight;
    memoryMaxWeighted += clampPercent(Number(row.memory_max_pct) || 0) * weight;
  }

  if (totalWeight <= 0) {
    return {
      latencyPctRange: { min: 0, max: 0 },
      memoryPctRange: { min: 0, max: 0 },
    };
  }

  const baseLatencyMin = latencyMinWeighted / totalWeight;
  const baseLatencyMax = latencyMaxWeighted / totalWeight;
  const baseMemoryMin = memoryMinWeighted / totalWeight;
  const baseMemoryMax = memoryMaxWeighted / totalWeight;

  // Slight pressure multiplier based on issue volume, bounded to keep values interpretable.
  const pressureMultiplier = Math.min(1.35, 1 + (Math.log10(rows.length + 1) * 0.18));

  const latencyMin = clampPercent(baseLatencyMin * pressureMultiplier);
  const latencyMax = clampPercent(baseLatencyMax * pressureMultiplier);
  const memoryMin = clampPercent(baseMemoryMin * pressureMultiplier);
  const memoryMax = clampPercent(baseMemoryMax * pressureMultiplier);

  return {
    latencyPctRange: {
      min: Math.round(Math.min(latencyMin, latencyMax)),
      max: Math.round(Math.max(latencyMin, latencyMax)),
    },
    memoryPctRange: {
      min: Math.round(Math.min(memoryMin, memoryMax)),
      max: Math.round(Math.max(memoryMin, memoryMax)),
    },
  };
}

async function upsertIssuesForScan(issues, analyzedFiles) {
  await ensureMetricsSchema();

  const uniqueFiles = [...new Set((analyzedFiles || []).filter(Boolean))];
  const openKeysByFile = new Map();

  for (const issue of issues || []) {
    const key = `${issue.lineNumber}:${issue.issueType}`;
    if (!openKeysByFile.has(issue.filePath)) {
      openKeysByFile.set(issue.filePath, new Set());
    }
    openKeysByFile.get(issue.filePath).add(key);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    for (const issue of issues || []) {
      const upsertQuery = `
        INSERT INTO issues (
          file_path,
          line_number,
          severity,
          issue_type,
          model_or_collection,
          message,
          latency_min_pct,
          latency_max_pct,
          memory_min_pct,
          memory_max_pct,
          first_detected_at,
          last_detected_at,
          occurrence_count,
          resolved_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          NOW(), NOW(), 1, NULL
        )
        ON CONFLICT (file_path, line_number, issue_type)
        DO UPDATE SET
          severity = EXCLUDED.severity,
          model_or_collection = EXCLUDED.model_or_collection,
          message = EXCLUDED.message,
          latency_min_pct = EXCLUDED.latency_min_pct,
          latency_max_pct = EXCLUDED.latency_max_pct,
          memory_min_pct = EXCLUDED.memory_min_pct,
          memory_max_pct = EXCLUDED.memory_max_pct,
          last_detected_at = NOW(),
          occurrence_count = issues.occurrence_count + 1,
          resolved_at = NULL;
      `;

      await client.query(upsertQuery, [
        issue.filePath,
        issue.lineNumber,
        issue.severity,
        issue.issueType,
        issue.modelOrCollection,
        issue.message,
        issue.latencyMinPct,
        issue.latencyMaxPct,
        issue.memoryMinPct,
        issue.memoryMaxPct,
      ]);
    }

    for (const filePath of uniqueFiles) {
      const openIssuesRes = await client.query(
        `
          SELECT id, line_number, issue_type
          FROM issues
          WHERE file_path = $1 AND resolved_at IS NULL;
        `,
        [filePath]
      );

      const activeKeys = openKeysByFile.get(filePath) || new Set();
      const idsToResolve = openIssuesRes.rows
        .filter((row) => !activeKeys.has(`${row.line_number}:${row.issue_type}`))
        .map((row) => row.id);

      if (idsToResolve.length > 0) {
        await client.query(
          `
            UPDATE issues
            SET resolved_at = NOW()
            WHERE id = ANY($1::int[]);
          `,
          [idsToResolve]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getCurrentIssuesMetrics() {
  await ensureMetricsSchema();

  const [severityRes, issueTypeRes, modelRes, impactRowsRes] = await Promise.all([
    getPool().query(
      `
        SELECT severity, COUNT(*)::int AS count
        FROM issues
        WHERE resolved_at IS NULL
        GROUP BY severity
        ORDER BY count DESC;
      `
    ),
    getPool().query(
      `
        SELECT issue_type, COUNT(*)::int AS count
        FROM issues
        WHERE resolved_at IS NULL
        GROUP BY issue_type
        ORDER BY count DESC;
      `
    ),
    getPool().query(
      `
        SELECT model_or_collection, COUNT(*)::int AS count
        FROM issues
        WHERE resolved_at IS NULL
        GROUP BY model_or_collection
        ORDER BY count DESC;
      `
    ),
    getPool().query(
      `
        SELECT
          severity,
          occurrence_count,
          latency_min_pct,
          latency_max_pct,
          memory_min_pct,
          memory_max_pct
        FROM issues
        WHERE resolved_at IS NULL;
      `
    ),
  ]);

  const impact = computeRiskAdjustedImpact(impactRowsRes.rows);

  return {
    totalIssues: impactRowsRes.rows.length,
    estimatedDegradation: impact,
    bySeverity: severityRes.rows,
    byIssueType: issueTypeRes.rows,
    byModelOrCollection: modelRes.rows,
  };
}

async function getPerformanceImprovementMetrics() {
  await ensureMetricsSchema();

  const [potentialRes, realizedRes] = await Promise.all([
    getPool().query(
      `
        SELECT
          severity,
          occurrence_count,
          latency_min_pct,
          latency_max_pct,
          memory_min_pct,
          memory_max_pct
        FROM issues
        WHERE resolved_at IS NULL;
      `
    ),
    getPool().query(
      `
        SELECT
          severity,
          occurrence_count,
          latency_min_pct,
          latency_max_pct,
          memory_min_pct,
          memory_max_pct
        FROM issues
        WHERE resolved_at IS NOT NULL;
      `
    ),
  ]);

  const potentialImpact = computeRiskAdjustedImpact(potentialRes.rows);
  const realizedImpact = computeRiskAdjustedImpact(realizedRes.rows);

  return {
    potential: {
      issueCount: potentialRes.rows.length,
      latencyPctRange: potentialImpact.latencyPctRange,
      memoryPctRange: potentialImpact.memoryPctRange,
    },
    realized: {
      issueCount: realizedRes.rows.length,
      latencyPctRange: realizedImpact.latencyPctRange,
      memoryPctRange: realizedImpact.memoryPctRange,
    },
  };
}

async function getHighIssueAreasMetrics(limit = 10) {
  await ensureMetricsSchema();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 10;

  const [byModelRes, byIssueTypeRes] = await Promise.all([
    getPool().query(
      `
        SELECT
          model_or_collection,
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_count,
          COUNT(*) FILTER (WHERE severity = 'error')::int AS error_count,
          CASE
            WHEN SUM(COUNT(*) FILTER (WHERE severity = 'error')) OVER () = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE severity = 'error'))::numeric
              / SUM(COUNT(*) FILTER (WHERE severity = 'error')) OVER () * 100,
              1
            )
          END AS error_pct,
          CASE
            WHEN SUM(COUNT(*) FILTER (WHERE resolved_at IS NULL)) OVER () = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE resolved_at IS NULL))::numeric
              / SUM(COUNT(*) FILTER (WHERE resolved_at IS NULL)) OVER () * 100,
              1
            )
          END AS open_pct,
          COALESCE(SUM(latency_max_pct), 0)::int AS latency_max_pct,
          COALESCE(SUM(memory_max_pct), 0)::int AS memory_max_pct
        FROM issues
        GROUP BY model_or_collection
        ORDER BY error_count DESC, open_count DESC, total_count DESC
        LIMIT $1;
      `,
      [safeLimit]
    ),
    getPool().query(
      `
        SELECT
          issue_type,
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_count,
          COUNT(*) FILTER (WHERE severity = 'error')::int AS error_count,
          CASE
            WHEN SUM(COUNT(*) FILTER (WHERE severity = 'error')) OVER () = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE severity = 'error'))::numeric
              / SUM(COUNT(*) FILTER (WHERE severity = 'error')) OVER () * 100,
              1
            )
          END AS error_pct,
          CASE
            WHEN SUM(COUNT(*) FILTER (WHERE resolved_at IS NULL)) OVER () = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE resolved_at IS NULL))::numeric
              / SUM(COUNT(*) FILTER (WHERE resolved_at IS NULL)) OVER () * 100,
              1
            )
          END AS open_pct,
          COALESCE(SUM(latency_max_pct), 0)::int AS latency_max_pct,
          COALESCE(SUM(memory_max_pct), 0)::int AS memory_max_pct
        FROM issues
        GROUP BY issue_type
        ORDER BY error_count DESC, open_count DESC, total_count DESC
        LIMIT $1;
      `,
      [safeLimit]
    ),
  ]);

  return {
    byModelOrCollection: byModelRes.rows,
    byIssueType: byIssueTypeRes.rows,
  };
}

async function getMetricsSummary(limit = 10) {
  const [currentIssues, performanceImprovement, highIssueAreas] = await Promise.all([
    getCurrentIssuesMetrics(),
    getPerformanceImprovementMetrics(),
    getHighIssueAreasMetrics(limit),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    scope: 'all-time-default',
    currentIssues,
    performanceImprovement,
    highIssueAreas,
  };
}

async function getIssueDetailsMetrics(limitPerType = 3) {
  await ensureMetricsSchema();
  const safeLimit = Number.isFinite(limitPerType) ? Math.max(1, Math.min(10, limitPerType)) : 3;

  const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));
  const pickPriority = (score) => {
    if (score >= 80) return 'P1 - Immediate';
    if (score >= 60) return 'P2 - Near-term';
    if (score >= 35) return 'P3 - Planned';
    return 'P4 - Monitor';
  };
  const pickConfidence = (score) => {
    if (score >= 80) return 'High';
    if (score >= 55) return 'Medium';
    return 'Low';
  };

  const summaryRes = await getPool().query(
    `
      SELECT
        issue_type,
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_count,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved_count,
        COALESCE(AVG(latency_min_pct), 0)::int AS avg_latency_min_pct,
        COALESCE(AVG(latency_max_pct), 0)::int AS avg_latency_max_pct,
        COALESCE(AVG(memory_min_pct), 0)::int AS avg_memory_min_pct,
        COALESCE(AVG(memory_max_pct), 0)::int AS avg_memory_max_pct,
        COALESCE(AVG(occurrence_count), 0)::numeric(10,2) AS avg_occurrence_count,
        COUNT(DISTINCT file_path)::int AS impacted_file_count,
        COUNT(DISTINCT model_or_collection)::int AS impacted_model_count,
        COUNT(*) FILTER (
          WHERE resolved_at IS NULL
            AND first_detected_at <= (NOW() - INTERVAL '14 days')
        )::int AS aging_open_count,
        COUNT(*) FILTER (WHERE last_detected_at >= (NOW() - INTERVAL '7 days'))::int AS recent_seen_count,
        COUNT(*) FILTER (WHERE resolved_at >= (NOW() - INTERVAL '7 days'))::int AS recent_resolved_count,
        MIN(first_detected_at) AS first_seen_at,
        MAX(last_detected_at) AS last_seen_at
      FROM issues
      GROUP BY issue_type
      ORDER BY open_count DESC, total_count DESC;
    `
  );

  const issueDetails = await Promise.all(
    summaryRes.rows.map(async (row) => {
      const issueType = row.issue_type;

      const [severityRes, modelRes, examplesRes] = await Promise.all([
        getPool().query(
          `
            SELECT
              severity,
              COUNT(*)::int AS count,
              CASE
                WHEN SUM(COUNT(*)) OVER () = 0 THEN 0
                ELSE ROUND((COUNT(*)::numeric / SUM(COUNT(*)) OVER ()) * 100, 1)
              END AS pct
            FROM issues
            WHERE issue_type = $1 AND resolved_at IS NULL
            GROUP BY severity
            ORDER BY count DESC;
          `,
          [issueType]
        ),
        getPool().query(
          `
            SELECT
              model_or_collection,
              COUNT(*)::int AS count,
              CASE
                WHEN SUM(COUNT(*)) OVER () = 0 THEN 0
                ELSE ROUND((COUNT(*)::numeric / SUM(COUNT(*)) OVER ()) * 100, 1)
              END AS share_pct
            FROM issues
            WHERE issue_type = $1 AND resolved_at IS NULL
            GROUP BY model_or_collection
            ORDER BY count DESC
            LIMIT $2;
          `,
          [issueType, safeLimit]
        ),
        getPool().query(
          `
            SELECT
              file_path,
              line_number,
              severity,
              model_or_collection,
              message,
              latency_min_pct,
              latency_max_pct,
              memory_min_pct,
              memory_max_pct,
              occurrence_count,
              first_detected_at,
              last_detected_at,
              resolved_at,
              (resolved_at IS NULL) AS is_open
            FROM issues
            WHERE issue_type = $1
            ORDER BY (resolved_at IS NULL) DESC, last_detected_at DESC
            LIMIT $2;
          `,
          [issueType, safeLimit]
        ),
      ]);

      const openCount = Number(row.open_count) || 0;
      const totalCount = Number(row.total_count) || 0;
      const resolvedCount = Number(row.resolved_count) || 0;
      const avgLatencyMax = Number(row.avg_latency_max_pct) || 0;
      const avgMemoryMax = Number(row.avg_memory_max_pct) || 0;
      const avgOccurrence = Number(row.avg_occurrence_count) || 0;
      const impactedFiles = Number(row.impacted_file_count) || 0;
      const impactedModels = Number(row.impacted_model_count) || 0;
      const agingOpen = Number(row.aging_open_count) || 0;
      const recentSeen = Number(row.recent_seen_count) || 0;
      const recentResolved = Number(row.recent_resolved_count) || 0;

      const criticalCount = severityRes.rows.reduce((acc, cur) => {
        if (cur.severity === 'error') return acc + (Number(cur.count) || 0);
        return acc;
      }, 0);
      const criticalRatio = openCount > 0 ? criticalCount / openCount : 0;
      const avgImpactMax = (avgLatencyMax + avgMemoryMax) / 2;

      const priorityScore = clampScore(
        (openCount * 4)
        + (avgImpactMax * 0.85)
        + (criticalRatio * 30)
        + (agingOpen * 3)
        + (recentSeen * 1.25)
        - (recentResolved * 1.2)
      );

      const confidenceScore = clampScore(
        (Math.min(1, totalCount / 8) * 50)
        + (Math.min(1, avgOccurrence / 3) * 30)
        + (Math.min(1, impactedFiles / 5) * 20)
      );

      const resolutionRate = totalCount > 0
        ? Number(((resolvedCount / totalCount) * 100).toFixed(1))
        : 0;

      return {
        issueType,
        totalCount,
        openCount,
        resolvedCount,
        avgLatencyPctRange: {
          min: row.avg_latency_min_pct,
          max: row.avg_latency_max_pct,
        },
        avgMemoryPctRange: {
          min: row.avg_memory_min_pct,
          max: row.avg_memory_max_pct,
        },
        avgOccurrenceCount: avgOccurrence,
        impactedFileCount: impactedFiles,
        impactedModelCount: impactedModels,
        agingOpenCount: agingOpen,
        recentSeenCount: recentSeen,
        recentResolvedCount: recentResolved,
        resolutionRatePct: resolutionRate,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        severityBreakdown: severityRes.rows,
        topModels: modelRes.rows,
        scoring: {
          priorityScore,
          priorityLabel: pickPriority(priorityScore),
          confidenceScore,
          confidenceLabel: pickConfidence(confidenceScore),
        },
        recentExamples: examplesRes.rows,
      };
    })
  );

  return {
    generatedAt: new Date().toISOString(),
    sampleLimitPerType: safeLimit,
    issueDetails,
  };
}

module.exports = {
  getPool,
  testConnection,
  ensureMetricsSchema,
  storeTextFile,
  storeTextFileWithEmbedding,
  searchSimilar,
  getAllFiles,
  getFileByPath,
  deleteFileByPath,
  upsertIssuesForScan,
  getCurrentIssuesMetrics,
  getPerformanceImprovementMetrics,
  getHighIssueAreasMetrics,
  getMetricsSummary,
  getIssueDetailsMetrics,
  closePool
};

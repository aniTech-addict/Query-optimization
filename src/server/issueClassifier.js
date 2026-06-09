const path = require('path');

const ISSUE_TYPE_ALIASES = {
  n_plus_one: 'n_plus_one',
  nplusone: 'n_plus_one',
  missing_lean: 'missing_lean',
  find_instead_of_findone: 'find_instead_of_findone',
  no_pagination: 'no_pagination',
  unbounded_query: 'unbounded_query',
  unbounded_aggregation: 'unbounded_aggregation',
  missing_select: 'missing_select',
  deep_populate: 'deep_populate',
  regex_without_index: 'regex_without_index',
  missing_compound_index: 'missing_compound_index',
  sequential_queries: 'sequential_queries',
  loop_deletes: 'loop_deletes',
  loop_inserts: 'loop_inserts',
  redundant_queries: 'redundant_queries',
  missing_exec: 'missing_exec',
  fetch_modify_save: 'fetch_modify_save',
  missing_transaction: 'missing_transaction',
  schema_index_improvement: 'schema_index_improvement',
  other: 'other',
};

const ISSUE_IMPACT = {
  n_plus_one: { latencyMin: 40, latencyMax: 85, memoryMin: 10, memoryMax: 35 },
  missing_lean: { latencyMin: 10, latencyMax: 30, memoryMin: 30, memoryMax: 55 },
  find_instead_of_findone: { latencyMin: 5, latencyMax: 20, memoryMin: 5, memoryMax: 20 },
  no_pagination: { latencyMin: 20, latencyMax: 70, memoryMin: 20, memoryMax: 60 },
  unbounded_query: { latencyMin: 25, latencyMax: 80, memoryMin: 20, memoryMax: 65 },
  unbounded_aggregation: { latencyMin: 30, latencyMax: 85, memoryMin: 20, memoryMax: 55 },
  missing_select: { latencyMin: 8, latencyMax: 22, memoryMin: 10, memoryMax: 30 },
  deep_populate: { latencyMin: 15, latencyMax: 45, memoryMin: 20, memoryMax: 45 },
  regex_without_index: { latencyMin: 20, latencyMax: 75, memoryMin: 5, memoryMax: 15 },
  missing_compound_index: { latencyMin: 20, latencyMax: 70, memoryMin: 5, memoryMax: 20 },
  sequential_queries: { latencyMin: 20, latencyMax: 50, memoryMin: 0, memoryMax: 10 },
  loop_deletes: { latencyMin: 25, latencyMax: 60, memoryMin: 0, memoryMax: 10 },
  loop_inserts: { latencyMin: 20, latencyMax: 55, memoryMin: 0, memoryMax: 10 },
  redundant_queries: { latencyMin: 8, latencyMax: 30, memoryMin: 5, memoryMax: 15 },
  missing_exec: { latencyMin: 0, latencyMax: 8, memoryMin: 0, memoryMax: 5 },
  fetch_modify_save: { latencyMin: 10, latencyMax: 35, memoryMin: 2, memoryMax: 12 },
  missing_transaction: { latencyMin: 0, latencyMax: 5, memoryMin: 0, memoryMax: 5 },
  schema_index_improvement: { latencyMin: 12, latencyMax: 45, memoryMin: 0, memoryMax: 8 },
  other: { latencyMin: 0, latencyMax: 10, memoryMin: 0, memoryMax: 10 },
};

function normalizeIssueType(rawType, message) {
  const normalizedRaw = String(rawType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (ISSUE_TYPE_ALIASES[normalizedRaw]) {
    return ISSUE_TYPE_ALIASES[normalizedRaw];
  }

  const text = String(message || '').toLowerCase();
  if (text.includes('n+1') || text.includes('query inside loop')) return 'n_plus_one';
  if (text.includes('lean()') || text.includes('missing .lean')) return 'missing_lean';
  if (text.includes('findone()') && text.includes('find()')) return 'find_instead_of_findone';
  if (text.includes('pagination') || (text.includes('limit') && text.includes('skip'))) return 'no_pagination';
  if (text.includes('unbounded') && text.includes('find')) return 'unbounded_query';
  if (text.includes('unbounded') && text.includes('aggregation')) return 'unbounded_aggregation';
  if (text.includes('select()') || text.includes('fetching all fields')) return 'missing_select';
  if (text.includes('deep .populate') || text.includes('deep populate')) return 'deep_populate';
  if (text.includes('$regex') && text.includes('index')) return 'regex_without_index';
  if (text.includes('compound index')) return 'missing_compound_index';
  if (text.includes('sequential queries') || text.includes('promise.all')) return 'sequential_queries';
  if (text.includes('loop deletes') || text.includes('deletemany')) return 'loop_deletes';
  if (text.includes('loop inserts') || text.includes('insertmany')) return 'loop_inserts';
  if (text.includes('redundant quer')) return 'redundant_queries';
  if (text.includes('missing .exec') || text.includes('without .exec')) return 'missing_exec';
  if (text.includes('fetch-modify-save') || text.includes('findbyidandupdate')) return 'fetch_modify_save';
  if (text.includes('transaction')) return 'missing_transaction';
  if (text.includes('schema') && text.includes('index')) return 'schema_index_improvement';

  return 'other';
}

function getImpactRange(issueType) {
  return ISSUE_IMPACT[issueType] || ISSUE_IMPACT.other;
}

function inferModelOrCollection(filePath, message) {
  const text = String(message || '');

  const explicit = text.match(/(?:model|collection)\s+([A-Za-z0-9_]+)/i);
  if (explicit && explicit[1]) return explicit[1].toLowerCase();

  const quoted = text.match(/['"]([A-Za-z0-9_]+)['"]\s*(?:model|collection)/i);
  if (quoted && quoted[1]) return quoted[1].toLowerCase();

  const fileName = path.basename(filePath || '').toLowerCase();
  const cleaned = fileName
    .replace(/\.(controller|service|model|route|repository)\.[a-z]+$/i, '')
    .replace(/\.[a-z]+$/i, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return cleaned || 'unknown';
}

module.exports = {
  normalizeIssueType,
  getImpactRange,
  inferModelOrCollection,
};

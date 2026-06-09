-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Table to store text file contents with vector embeddings
CREATE TABLE IF NOT EXISTS text_files (
    id SERIAL PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast vector similarity search
CREATE INDEX IF NOT EXISTS idx_text_files_embedding
    ON text_files USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Index for file path lookups
CREATE INDEX IF NOT EXISTS idx_text_files_path
    ON text_files (file_path);

-- Table to store normalized issue lifecycle and impact ranges
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

CREATE INDEX IF NOT EXISTS idx_issues_status
    ON issues (resolved_at);

CREATE INDEX IF NOT EXISTS idx_issues_issue_type
    ON issues (issue_type);

CREATE INDEX IF NOT EXISTS idx_issues_model
    ON issues (model_or_collection);

CREATE INDEX IF NOT EXISTS idx_issues_severity
    ON issues (severity);

CREATE INDEX IF NOT EXISTS idx_issues_last_detected
    ON issues (last_detected_at);

CREATE INDEX IF NOT EXISTS idx_issues_file_path
    ON issues (file_path);

# Mongoose Queries Optimizer

A VS Code extension that uses **React**, **Express.js**, and a **PostgreSQL + pgvector** database to store and search text file contents using vector similarity.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Prerequisites](#prerequisites)
3. [Getting Started](#getting-started)
4. [How the Database is Set Up](#how-the-database-is-set-up)
5. [How the Code Connects to PostgreSQL](#how-the-code-connects-to-postgresql)
6. [API Endpoints](#api-endpoints)
7. [VS Code Commands](#vs-code-commands)
8. [Useful Docker Commands](#useful-docker-commands)
9. [Useful psql Commands](#useful-psql-commands)

---


### IVFFlat Index

Searching every single vector in a large table is slow. The **IVFFlat** index divides vectors into clusters (called "lists") and only searches nearby clusters:

```sql
CREATE INDEX idx_text_files_embedding
    ON text_files USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
```

- `ivfflat` = the index type (Inverted File Flat)
- `vector_cosine_ops` = tells it to use cosine distance
- `lists = 100` = number of clusters (tune this based on data size)

This makes similarity searches **much faster** at the cost of a small accuracy trade-off.

---

## Project Structure

```
mongoose_queries_optimizer/
├── package.json                  # Extension manifest + npm dependencies
├── docker-compose.yml            # Docker setup for pgvector PostgreSQL
├── webpack.config.js             # Builds the React webview
├── db/
│   └── init.sql                  # SQL that runs when the database is first created
├── src/
│   ├── extension.js              # VS Code extension entry point
│   ├── db/
│   │   └── index.js              # Node.js ↔ PostgreSQL connection & queries
│   ├── server/
│   │   └── index.js              # Express.js API server
│   └── webview/
│       ├── panel.js              # VS Code webview panel (hosts React)
│       └── app.jsx               # React UI
└── dist/
    └── webview.js                # Compiled React bundle (built by webpack)
```

---

## Prerequisites

- **Node.js** (v18+)
- **Docker** (to run PostgreSQL — no need to install Postgres locally)

---

## Getting Started

### 1. Install npm dependencies

```bash
npm install
```

### 2. Start the PostgreSQL + pgvector database

```bash
docker compose up -d
```

This pulls the `pgvector/pgvector:pg16` image and starts a container named `mongoose_optimizer_pgvector`. On the first run, it automatically executes `db/init.sql` which creates the `vector` extension and the `text_files` table.

### 3. Build the React webview

```bash
npm run build:webview
```

### 4. Run the extension

Press **F5** in VS Code to launch the Extension Development Host.

---

## How the Database is Set Up

Everything happens in `docker-compose.yml` and `db/init.sql`.

### docker-compose.yml — What Each Line Does

```yaml
services:
  pgvector:
    image: pgvector/pgvector:pg16        # PostgreSQL 16 with the pgvector extension pre-installed
    container_name: mongoose_optimizer_pgvector
    restart: unless-stopped              # Auto-restart if the container crashes
    environment:
      POSTGRES_USER: optimizer           # The username to connect with
      POSTGRES_PASSWORD: optimizer_secret # The password
      POSTGRES_DB: mongoose_optimizer    # The database name (created automatically)
    ports:
      - "5433:5432"                      # Maps container port 5432 → your machine's port 5433
    volumes:
      - pgdata:/var/lib/postgresql/data  # Persist data between container restarts
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql  # Run this SQL on first start
```

**Why port 5433?** Port 5432 is PostgreSQL's default. We use 5433 to avoid conflicts if you already have Postgres installed locally.

### db/init.sql — The Database Schema

```sql
-- 1. Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the table
CREATE TABLE IF NOT EXISTS text_files (
    id SERIAL PRIMARY KEY,           -- Auto-generated unique ID
    file_path TEXT NOT NULL UNIQUE,   -- Full path to the file (must be unique)
    file_name TEXT NOT NULL,          -- Just the filename
    content TEXT NOT NULL,            -- The actual text content of the file
    embedding vector(1536),           -- The vector embedding (nullable — set later)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_text_files_embedding
    ON text_files USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- 4. Index for fast file path lookups
CREATE INDEX IF NOT EXISTS idx_text_files_path
    ON text_files (file_path);
```

---

## How the Code Connects to PostgreSQL

The file `src/db/index.js` uses the `pg` npm package (node-postgres) to talk to the database.

### Connection Pool

Instead of opening a new connection for every query (slow), we use a **connection pool** — a set of reusable connections:

```js
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5433,            // Matches the docker-compose port mapping
  user: 'optimizer',
  password: 'optimizer_secret',
  database: 'mongoose_optimizer'
});
```

### Parameterized Queries (Preventing SQL Injection)

All queries use **$1, $2, $3** placeholders instead of string concatenation. This prevents SQL injection attacks:

```js
// SAFE — parameterized
const res = await pool.query(
  'SELECT * FROM text_files WHERE file_path = $1',
  ['/some/path.txt']
);

// DANGEROUS — never do this!
// const res = await pool.query(`SELECT * FROM text_files WHERE file_path = '${userInput}'`);
```

### Key Database Functions

| Function | What it does |
|----------|-------------|
| `storeTextFile(path, name, content)` | Saves a text file to the DB. If the path already exists, updates the content. |
| `storeTextFileWithEmbedding(...)` | Same as above, but also stores the vector embedding. |
| `searchSimilar(embedding, limit)` | Finds the most similar files to a given embedding vector. |
| `getAllFiles()` | Returns a list of all stored files (without full content, for efficiency). |
| `getFileByPath(path)` | Gets a single file by its path. |
| `deleteFileByPath(path)` | Removes a file record from the database. |

---

## API Endpoints

The Express server runs on **port 3456** when the extension activates.

| Method | Endpoint | Body / Params | Description |
|--------|----------|---------------|-------------|
| GET | `/api/health` | — | Health check (includes DB connection status) |
| GET | `/api/template` | — | Returns the default JSON config template |
| POST | `/api/files` | `{ filePath, fileName, content }` | Store a text file in the database |
| GET | `/api/files` | — | List all stored files |
| GET | `/api/files/lookup` | `?path=/some/file.txt` | Get a file by its path |
| DELETE | `/api/files` | `{ filePath }` | Delete a file record |
| POST | `/api/files/search` | `{ embedding, limit }` | Similarity search by embedding vector |
| GET | `/api/metrics/current-issues` | — | Open issues + estimated current latency/memory degradation ranges |
| GET | `/api/metrics/performance-improvement` | — | Potential (open) and realized (resolved) improvement ranges |
| GET | `/api/metrics/high-issue-areas` | `?limit=10` | Hotspots grouped by model/collection and issue type |
| GET | `/api/metrics/summary` | `?limit=10` | Single payload combining all dashboard metric groups |

### Example: Store a file via curl

```bash
curl -X POST http://localhost:3456/api/files \
  -H "Content-Type: application/json" \
  -d '{
    "filePath": "/project/models/user.js",
    "fileName": "user.js",
    "content": "const mongoose = require(\"mongoose\"); ..."
  }'
```

### Example: Fetch dashboard summary metrics

```bash
curl "http://localhost:3456/api/metrics/summary?limit=10"
```

### Metrics Webpage (quick validation UI)

Open this URL in your browser once the extension server is running:

```bash
http://localhost:3456/dashboard/metrics
```

### Example: List all stored files

```bash
curl http://localhost:3456/api/files
```

---

## VS Code Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type:

| Command | What it does |
|---------|-------------|
| **Mongoose Optimizer: Create JSON File** | Creates a `mongoose-optimizer-config.json` file in your workspace root with a default template and opens it in the editor |

---

## Useful Docker Commands

```bash
# Start the database
docker compose up -d

# Stop the database (data is preserved)
docker compose down

# Stop and delete all data
docker compose down -v

# View container logs
docker logs mongoose_optimizer_pgvector

# Check if the container is running
docker ps | grep mongoose_optimizer

# Open a psql shell inside the container
docker exec -it mongoose_optimizer_pgvector psql -U optimizer -d mongoose_optimizer
```

---

## Useful psql Commands

Once inside the psql shell (`docker exec -it mongoose_optimizer_pgvector psql -U optimizer -d mongoose_optimizer`):

```sql
-- List all tables
\dt

-- Describe the text_files table (show columns)
\d text_files

-- See all stored files
SELECT id, file_name, LENGTH(content) AS size, created_at FROM text_files;

-- Count total files
SELECT COUNT(*) FROM text_files;

-- Check if pgvector is installed
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- Delete all data (but keep the table)
TRUNCATE text_files;

-- Exit psql
\q
```

---

## Summary of the Data Flow

```
┌───────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│  VS Code      │────▶│  Express Server   │────▶│  PostgreSQL + pgvector│
│  Extension    │     │  (port 3456)      │     │  (Docker, port 5433)  │
│               │◀────│                   │◀────│                       │
└───────────────┘     └──────────────────┘     └──────────────────────┘
       │                                              │
       │  React Webview                               │  text_files table
       │  (UI in VS Code)                             │  with vector(1536)
       ▼                                              │  embedding column
┌───────────────┐                                     │
│  User clicks  │                                     │
│  "Create JSON"│─────────────────────────────────────▶
└───────────────┘
```

1. The **VS Code extension** activates and starts the Express server.
2. The **Express server** exposes API routes for storing/retrieving files.
3. The **database** (PostgreSQL with pgvector) stores file contents and optional embedding vectors.
4. The **React webview** provides a UI inside VS Code to interact with the system.
5. **Similarity search** lets you find files with related content by comparing embedding vectors using cosine distance.

# MCP Server + Gemini Agent — A Learning Guide

> **Audience:** Students who want to understand what an MCP server is, how AI agents work, and how to build one from scratch using JavaScript.

---

## Table of Contents

1. [What Are We Building?](#what-are-we-building)
2. [What is MCP? (The Big Picture)](#what-is-mcp-the-big-picture)
3. [Why MCP Matters](#why-mcp-matters)
4. [Package Breakdown — What Each Dependency Does](#package-breakdown--what-each-dependency-does)
5. [Architecture: How Everything Connects](#architecture-how-everything-connects)
6. [File-by-File Walkthrough](#file-by-file-walkthrough)
   - [src/mcp/index.js — The MCP Server](#srcmcpindexjs--the-mcp-server)
   - [src/mcp/gemini.js — The Gemini Agent](#srcmcpgeminijs--the-gemini-agent)
   - [src/mcp/instructions.js — The Instruction Set](#srcmcpinstructionsjs--the-instruction-set)
   - [.vscode/mcp.json — VS Code Configuration](#vscodemcpjson--vs-code-configuration)
7. [Core Concepts Deep Dive](#core-concepts-deep-dive)
   - [Concept 1: stdio Transport](#concept-1-stdio-transport)
   - [Concept 2: Tools](#concept-2-tools)
   - [Concept 3: Resources](#concept-3-resources)
   - [Concept 4: Schema Validation with Zod](#concept-4-schema-validation-with-zod)
   - [Concept 5: System Prompts / Instructions](#concept-5-system-prompts--instructions)
   - [Concept 6: Context Injection](#concept-6-context-injection)
8. [How to Run It](#how-to-run-it)
9. [Build It Yourself — Step by Step](#build-it-yourself--step-by-step)
10. [Common Mistakes and Debugging](#common-mistakes-and-debugging)
11. [Exercises](#exercises)

---

## What Are We Building?

We're building an **MCP server** that:

1. **Connects to our PostgreSQL + pgvector database** (where we stored text files from the VS Code extension).
2. **Wraps Google's Gemini AI** as an agent that can analyze code.
3. **Exposes tools** that any MCP-compatible client (like VS Code Copilot) can call.
4. **Uses a system instruction set** to make Gemini behave as a Mongoose query optimization expert.

When you're done, you'll be able to open VS Code, use Copilot chat, and it will have access to your database files and an AI agent — all through the MCP protocol.

---

## What is MCP? (The Big Picture)

**MCP** stands for **Model Context Protocol**. It's an open standard (created by Anthropic) that defines how AI assistants talk to external tools and data sources.

Think of it like this:

```
Without MCP:
┌──────────┐
│ AI Model │ ← can only use its training data, no access to your stuff
└──────────┘

With MCP:
┌──────────┐     MCP Protocol     ┌────────────────┐
│ AI Model │ ◄──────────────────► │ YOUR MCP Server │
└──────────┘                      │  - Database     │
                                  │  - APIs         │
                                  │  - File system  │
                                  │  - AI agents    │
                                  └────────────────┘
```

**MCP is like a USB port for AI.** Just as USB lets you plug any device into any computer, MCP lets you plug any tool/data source into any AI model.

### The Three Primitives of MCP

MCP defines three things a server can offer:

| Primitive | What it is | Real-world analogy |
|-----------|------------|-------------------|
| **Tools** | Functions the AI can call | Apps on your phone |
| **Resources** | Read-only data the AI can access | Files on a USB drive |
| **Prompts** | Pre-written prompt templates | Saved email templates |

In our project, we use **Tools** and **Resources**.

---

## Why MCP Matters

Before MCP, if you wanted an AI to talk to your database, you'd have to:
1. Write custom API integration for each AI provider
2. Handle authentication differently for each one
3. Re-do everything when you switch AI models

MCP solves this: **write your server once, and it works with any MCP-compatible AI client.** VS Code Copilot, Claude Desktop, and others all speak MCP.

---

## Package Breakdown — What Each Dependency Does

Let's go through every package we installed and understand **why** it exists.

### 1. `@modelcontextprotocol/sdk`

```bash
npm install @modelcontextprotocol/sdk
```

**What it is:** The official MCP SDK for JavaScript/TypeScript.

**What it gives us:**
- `McpServer` — A class to create an MCP server
- `StdioServerTransport` — A transport layer that communicates over stdin/stdout

**Why we need it:** Without this, you'd have to implement the entire MCP protocol from scratch — parsing JSON-RPC messages, handling the handshake, managing sessions, etc. The SDK handles all of that.

**How we use it:**

```js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer({ name: 'my-server', version: '0.0.1' });

// Register tools and resources on `server`...

const transport = new StdioServerTransport();
await server.connect(transport);  // Now it's running!
```

**Impact on project:** This is the backbone. Without it, we don't have an MCP server.

---

### 2. `zod`

```bash
npm install zod
```

**What it is:** A schema validation library for JavaScript.

**What it gives us:** A way to define and validate the shape of data at runtime.

**Why we need it:** The MCP SDK uses Zod to define tool input schemas. When the AI calls one of your tools, MCP validates the arguments against the Zod schema **before** your code runs. This prevents bad data from reaching your handlers.

**How we use it:**

```js
const { z } = require('zod');

// Define what arguments the tool accepts:
server.tool(
  'query_files',                        // tool name
  'Search files by keyword',            // description for the AI
  { keyword: z.string() },              // ← Zod schema: "keyword" must be a string
  async ({ keyword }) => { ... }        // handler function
);
```

**What happens without it:** If the AI sends `{ keyword: 123 }` instead of a string, your SQL query could fail in a confusing way. Zod catches this before your code runs and returns a clear validation error.

**Key Zod methods used in this project:**

```js
z.string()                    // Must be a string
z.boolean().optional()        // Boolean, but not required
z.boolean().default(false)    // Boolean, defaults to false if not provided
z.array(z.string())           // Array of strings
z.string().describe('...')    // Adds a description (shown to the AI so it knows what to provide)
```

**Impact on project:** Makes our tools type-safe. The AI knows exactly what arguments each tool expects.

---

### 3. `@google/generative-ai`

```bash
npm install @google/generative-ai
```

**What it is:** Google's official SDK for the Gemini family of AI models.

**What it gives us:**
- `GoogleGenerativeAI` — A client to interact with Gemini models
- Support for single prompts (`generateContent`) and multi-turn chat (`startChat`)

**Why we need it:** We want Gemini to analyze Mongoose models and suggest optimizations. This SDK lets us send prompts to Gemini and get responses.

**How we use it:**

```js
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize with your API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Get a model
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Send a prompt
const result = await model.generateContent('What is a Mongoose index?');
console.log(result.response.text());
```

**Why `gemini-2.0-flash`?** It's fast and cheap — perfect for code analysis tasks. You could swap it for `gemini-pro` or any other model if you need more capability.

**Impact on project:** This is our AI brain. Without it, we'd just be a database query tool with no intelligence.

---

### 4. `pg` (already installed)

```bash
npm install pg
```

**What it is:** The standard PostgreSQL client for Node.js (often called "node-postgres").

**Why we need it here:** Our MCP tools query the pgvector database to retrieve stored file contents and pass them as context to Gemini.

**Impact on project:** Connects the MCP server to our data layer. The `ask_gemini` and `analyze_mongoose_models` tools pull code from the database and feed it to the AI.

---

## Architecture: How Everything Connects

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code (or any MCP client)              │
│                                                             │
│   User types: "Analyze my mongoose models"                  │
│         │                                                   │
│         ▼                                                   │
│   Copilot sees available MCP tools                          │
│   Decides to call: analyze_mongoose_models                  │
│         │                                                   │
└─────────┼───────────────────────────────────────────────────┘
          │ stdin/stdout (JSON-RPC)
          ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP Server  (src/mcp/index.js)                 │
│                                                             │
│   1. Receives tool call via StdioServerTransport            │
│   2. Tool handler runs:                                     │
│      a. Queries PostgreSQL for all stored files             │
│      b. Builds a prompt with instructions + file content    │
│      c. Sends prompt to Gemini                              │
│      d. Returns Gemini's response to the client             │
│                                                             │
│   ┌──────────┐    ┌──────────────┐    ┌──────────────────┐ │
│   │ pgvector │◄──►│  Tool Logic  │───►│  Gemini Agent    │ │
│   │ Database │    │              │    │  (gemini.js)     │ │
│   │ (pg)     │    │              │◄───│                  │ │
│   └──────────┘    └──────────────┘    └──────────────────┘ │
│                          │                                  │
│                   instructions.js                           │
│                   (system prompt)                           │
└─────────────────────────────────────────────────────────────┘
```

---

## File-by-File Walkthrough

### `src/mcp/index.js` — The MCP Server

This is the main file. Let's break it down section by section.

#### Section 1: Imports and Server Creation

```js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('../db');
const gemini = require('./gemini');
const instructions = require('./instructions');

const server = new McpServer({
  name: 'mongoose-optimizer-mcp',
  version: '0.0.1'
});
```

**What's happening:**
- We import the MCP SDK, Zod for validation, our database module, Gemini agent, and instructions.
- We create a new MCP server instance with a name and version. This metadata is sent to the client during the initial handshake.

#### Section 2: Registering a Resource

```js
server.resource(
  'instructions',                        // resource name
  'mongoose-optimizer://instructions',   // URI
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/plain',
      text: instructions.getSystemPrompt()
    }]
  })
);
```

**What's happening:**
- A **resource** is read-only data that the AI client can browse.
- Here we expose our system prompt as a resource. The AI can read it to understand what this server is about.
- The URI `mongoose-optimizer://instructions` is a custom scheme — you can name it anything.

**Student note:** Resources are like files on a web server. The AI can request them by URI, but it can't modify them.

#### Section 3: Registering Tools

Each `server.tool()` call follows the same pattern:

```js
server.tool(
  'tool_name',            // 1. Name (the AI uses this to call the tool)
  'Description',          // 2. Description (the AI reads this to decide when to use it)
  { ...zodSchema },       // 3. Input schema (what arguments the tool accepts)
  async (args) => { ... } // 4. Handler (what happens when the tool is called)
);
```

**Let's look at the simplest tool — `list_files`:**

```js
server.tool(
  'list_files',
  'List all text files stored in the pgvector database',
  {},                          // ← no arguments needed
  async () => {
    const files = await db.getAllFiles();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(files, null, 2)
      }]
    };
  }
);
```

**What's happening:**
1. Tool takes no arguments (`{}` schema)
2. It calls `db.getAllFiles()` — the same function from our `src/db/index.js` module
3. It returns the result as text content

**The return format is important.** MCP tools MUST return this shape:

```js
{
  content: [
    { type: 'text', text: '...' }  // can also be 'image' or 'resource'
  ],
  isError: false  // optional, set to true for errors
}
```

**Now the most complex tool — `ask_gemini`:**

```js
server.tool(
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
    // 1. Optionally gather file content from the database
    // 2. Build a full prompt: instructions + context + user question
    // 3. Send to Gemini
    // 4. Return Gemini's response
  }
);
```

**Why three arguments?**
- `prompt` — The user's actual question ("What indexes should I add?")
- `includeContext` — A flag to dump ALL database files into the prompt (useful for full analysis)
- `filePaths` — Cherry-pick specific files to include (more targeted, uses fewer tokens)

**This is the pattern:** Database context + System instructions + User prompt → Gemini → Response.

#### Section 4: Starting the Server

```js
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mongoose Optimizer MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal MCP server error:', err);
  process.exit(1);
});
```

**What's happening:**
- We create a **stdio transport** — this means the server reads from stdin and writes to stdout.
- `server.connect(transport)` starts listening for MCP JSON-RPC messages.
- We log to **stderr** (not stdout!) because stdout is reserved for MCP protocol messages.

**Student note:** `console.log()` writes to stdout. `console.error()` writes to stderr. In an MCP stdio server, NEVER use `console.log()` — it would corrupt the protocol stream.

---

### `src/mcp/gemini.js` — The Gemini Agent

```js
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL_NAME = 'gemini-2.0-flash';

let genAI = null;  // Lazy singleton
```

**Lazy initialization pattern:**

```js
function getClient() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set.');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}
```

**Why lazy?** We don't create the client until the first time it's needed. If no one calls `ask_gemini`, we never read the API key or create a connection. This is a common pattern called **lazy initialization** or **singleton pattern**.

**Two functions we export:**

```js
// Single-shot: send a prompt, get a response
async function ask(prompt) {
  const model = getClient().getGenerativeModel({ model: MODEL_NAME });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// Multi-turn: send a conversation history + a new message
async function chat(messages, newMessage) {
  const model = getClient().getGenerativeModel({ model: MODEL_NAME });
  const chatSession = model.startChat({ history: messages });
  const result = await chatSession.sendMessage(newMessage);
  return result.response.text();
}
```

**`ask` vs `chat`:**
- `ask()` is stateless — one question, one answer. Used by our MCP tools.
- `chat()` preserves conversation history — for future multi-turn conversations.

---

### `src/mcp/instructions.js` — The Instruction Set

This file defines the **system prompt** — the personality and rules for the Gemini agent.

```js
const SYSTEM_PROMPT = `You are **Mongoose Query Optimizer**, an expert assistant...

## Your Capabilities
1. Schema Analysis
2. Query Optimization
3. Best Practices
4. Performance

## Rules
- Always base your analysis on the actual code...
- Be specific — cite file names...

## Output Format
### Summary
### Issues Found
### Optimization Suggestions
### Additional Recommendations
`;
```

**Why a separate file?** Three reasons:
1. **Separation of concerns** — The instructions aren't mixed with server logic.
2. **Easy to update** — Change the AI's behavior without touching any tool code.
3. **Reusable** — Both the `ask_gemini` tool and the `analyze_mongoose_models` tool import and use it.

**Why does the system prompt matter?** Without it, Gemini is a general-purpose AI. With it, Gemini becomes a **Mongoose specialist** that outputs structured, actionable advice. The prompt is essentially "programming the AI's behavior."

---

### `.vscode/mcp.json` — VS Code Configuration

```json
{
  "servers": {
    "mongoose-optimizer": {
      "type": "stdio",
      "command": "node",
      "args": ["src/mcp/index.js"],
      "env": {
        "GEMINI_API_KEY": "${input:geminiApiKey}"
      }
    }
  },
  "inputs": [
    {
      "id": "geminiApiKey",
      "type": "promptString",
      "description": "Enter your Gemini API key",
      "password": true
    }
  ]
}
```

**What's happening:**
- This tells VS Code: "There's an MCP server. Start it by running `node src/mcp/index.js`."
- `"type": "stdio"` — Communicate over stdin/stdout.
- `"${input:geminiApiKey}"` — VS Code will prompt you for the API key when it starts the server.
- `"password": true` — The input field will mask the characters (like a password field).

**Why this file?** Without it, you'd have to manually start the MCP server in a terminal. This file lets VS Code auto-discover and manage it.

---

## Core Concepts Deep Dive

### Concept 1: stdio Transport

**What is stdio?**
- **stdin** (standard input) — a stream where a program reads data from
- **stdout** (standard output) — a stream where a program writes data to
- **stderr** (standard error) — a stream for error/debug messages

**How MCP uses it:**

```
VS Code                    MCP Server
  │                           │
  │── JSON-RPC message ──────►│  (via stdin)
  │                           │
  │◄── JSON-RPC response ─────│  (via stdout)
  │                           │
  │   (debug logs go to stderr, ignored by protocol)
```

The messages are JSON-RPC 2.0 — a simple protocol where each message has a `method`, `params`, and `id`:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_files","arguments":{}}}
```

**Why stdio instead of HTTP?** Stdio is simpler — no ports, no networking, no CORS. The client just spawns the server as a child process and pipes data in/out.

---

### Concept 2: Tools

Tools are **functions that the AI can call**. Think of them as APIs, but the AI decides when and how to use them.

```js
server.tool(name, description, schema, handler);
```

**The AI sees:**
- The `name` — to reference the tool
- The `description` — to decide WHEN to use it
- The `schema` — to know WHAT arguments to provide

**The AI does NOT see:** your handler code. It only sees the name, description, and schema.

**This means your descriptions matter a lot!** A bad description = the AI never calls your tool or calls it at the wrong time.

```js
// BAD — too vague
server.tool('search', 'Search', { q: z.string() }, ...);

// GOOD — descriptive
server.tool(
  'query_files',
  'Search stored text files by keyword in their content. Returns up to 10 matching files with a preview.',
  { keyword: z.string().describe('Keyword to search for in file contents') },
  ...
);
```

---

### Concept 3: Resources

Resources are **read-only data** the AI can browse. Unlike tools, resources don't take arguments — they're just data you make available.

```js
server.resource(
  'instructions',                        // name
  'mongoose-optimizer://instructions',   // URI (unique identifier)
  async (uri) => ({                      // handler that returns the content
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: '...' }]
  })
);
```

**Tools vs Resources:**

| | Tools | Resources |
|---|---|---|
| What | Functions | Data |
| Arguments | Yes | No |
| Side effects | Can have (write to DB, call APIs) | Read-only |
| When used | AI decides based on user's request | AI browses available context |

---

### Concept 4: Schema Validation with Zod

Zod validates data at **runtime** (not just at compile time like TypeScript). This is critical because the AI generates arguments dynamically — you can't predict them at code-writing time.

**Without Zod:** You'd need to write manual validation:

```js
// Manual (tedious, error-prone)
async function handler(args) {
  if (typeof args.keyword !== 'string') throw new Error('keyword must be a string');
  if (args.keyword.length === 0) throw new Error('keyword cannot be empty');
  // ...
}
```

**With Zod:** Declare once, validated automatically:

```js
{ keyword: z.string().min(1) }
```

The MCP SDK runs Zod validation **before** your handler is called. If validation fails, it returns an error to the AI automatically — your handler never executes with bad data.

---

### Concept 5: System Prompts / Instructions

A system prompt is a **hidden instruction** given to the AI before the user's message. It shapes the AI's behavior.

```
┌─────────────────────────────────────┐
│ System Prompt (hidden from user):   │
│ "You are a Mongoose expert..."      │
├─────────────────────────────────────┤
│ Context (from database):            │
│ --- user.js ---                     │
│ const userSchema = new Schema({     │
│   name: String, ...                 │
│ })                                  │
├─────────────────────────────────────┤
│ User's question:                    │
│ "What indexes should I add?"        │
└─────────────────────────────────────┘
         │
         ▼
   Gemini processes all three layers
   and responds as a Mongoose expert
```

**Why separate the system prompt from the tool code?**

Imagine you want the AI to be a "security auditor" instead of a "Mongoose optimizer." With our design, you only change `instructions.js` — not a single line of tool code. This is the **single responsibility principle** in action.

---

### Concept 6: Context Injection

This is the most important pattern in the project. Here's the flow:

```
1. User asks: "What's wrong with my models?"
     │
     ▼
2. AI decides to call: analyze_mongoose_models
     │
     ▼
3. Tool handler:
   a. SELECT file_path, content FROM text_files  ← pulls code from PostgreSQL
   b. Builds prompt:
      - System instructions (from instructions.js)
      - File contents (from database)
      - Analysis request
   c. Sends to Gemini
     │
     ▼
4. Gemini responds with specific analysis of YOUR code
     │
     ▼
5. Response returned to user via MCP
```

**Why not just let the AI read the files directly?** Because:
- The files are in a database, not on disk
- We can control HOW MUCH context to send (token limits)
- We can pre-filter (only send relevant files)
- The system prompt shapes the response format

---

## How to Run It

### Option 1: Automatic (VS Code)

If you have `.vscode/mcp.json` in your project, VS Code Copilot will auto-detect the MCP server. When you use Copilot chat, it will:

1. Start the MCP server as a child process
2. Prompt you for your Gemini API key
3. Make the tools available in chat

### Option 2: Manual (Terminal)

```bash
# Set your Gemini API key
export GEMINI_API_KEY=your_key_here

# Make sure the database container is running
docker compose up -d

# Start the MCP server
npm run mcp:start
```

The server will now listen on stdin for JSON-RPC messages. (You won't see output — it's waiting for a client to connect.)

### Getting a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key

---

## Build It Yourself — Step by Step

If you wanted to recreate this from scratch, here's the order:

### Step 1: Install dependencies

```bash
npm install @modelcontextprotocol/sdk zod @google/generative-ai pg
```

### Step 2: Create the simplest possible MCP server

```js
// src/mcp/index.js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer({
  name: 'my-first-mcp',
  version: '0.0.1'
});

// One simple tool
server.tool(
  'hello',
  'Say hello',
  {},
  async () => ({
    content: [{ type: 'text', text: 'Hello from MCP!' }]
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Server running');
}

main();
```

### Step 3: Add a database tool

```js
const db = require('../db');

server.tool(
  'count_files',
  'Count how many files are stored',
  {},
  async () => {
    const files = await db.getAllFiles();
    return {
      content: [{ type: 'text', text: `${files.length} files stored.` }]
    };
  }
);
```

### Step 4: Add a Gemini tool

```js
const gemini = require('./gemini');

server.tool(
  'ask_ai',
  'Ask the AI a question',
  { question: z.string() },
  async ({ question }) => {
    const answer = await gemini.ask(question);
    return { content: [{ type: 'text', text: answer }] };
  }
);
```

### Step 5: Combine database + AI (context injection)

```js
server.tool(
  'analyze',
  'Analyze stored files with AI',
  {},
  async () => {
    const files = await db.getAllFiles();       // Get data from DB
    const prompt = `Analyze these:\n${files}`;  // Build prompt
    const answer = await gemini.ask(prompt);    // Send to AI
    return { content: [{ type: 'text', text: answer }] };
  }
);
```

### Step 6: Add the VS Code config

Create `.vscode/mcp.json` with the server definition.

That's it! Each step adds one new concept.

---

## Common Mistakes and Debugging

### 1. "Server starts but no tools appear in VS Code"

**Cause:** The `.vscode/mcp.json` file might have the wrong path in `args`.

**Fix:** Make sure the path is relative to the workspace root:
```json
"args": ["src/mcp/index.js"]  ✅
"args": ["/absolute/path/src/mcp/index.js"]  ❌
```

### 2. "GEMINI_API_KEY environment variable is not set"

**Cause:** The key isn't in the environment.

**Fix:** Either set it in your shell:
```bash
export GEMINI_API_KEY=your_key
```
Or rely on the `mcp.json` input prompt (which sets it automatically in VS Code).

### 3. "Cannot connect to database"

**Cause:** The Docker container isn't running.

**Fix:**
```bash
docker compose up -d
docker ps | grep mongoose_optimizer  # verify it's running
```

### 4. "console.log output corrupts MCP protocol"

**Cause:** Using `console.log()` in the MCP server.

**Fix:** Always use `console.error()` for debug logging in MCP servers. stdout is reserved for protocol messages.

### 5. "Tool returns but AI seems confused"

**Cause:** Bad tool description or missing `.describe()` on Zod fields.

**Fix:** Write descriptions as if explaining to a person who's never seen your code:
```js
{ keyword: z.string().describe('Keyword to search for in file contents') }
```

---

## Exercises

Test your understanding by trying these:

1. **Add a new tool** called `count_files` that returns the total number of files in the database. (Hint: `db.getAllFiles().length`)

2. **Modify the instructions** to make Gemini respond in a different format — for example, return suggestions as a numbered checklist instead of headings.

3. **Add a `delete_file` tool** that takes a `filePath` argument and removes it from the database. (Hint: `db.deleteFileByPath()`)

4. **Create a new resource** that exposes the database connection status (connected or not) as a JSON resource.

5. **Switch the Gemini model** from `gemini-2.0-flash` to `gemini-pro` in `gemini.js` and compare the output quality.

6. **Add a `chat_with_gemini` tool** that uses the `chat()` function instead of `ask()`, accepting a message history array.

---

## Quick Reference

| File | Purpose |
|------|---------|
| `src/mcp/index.js` | MCP server — registers tools, resources, handles stdio |
| `src/mcp/gemini.js` | Gemini AI client — `ask()` and `chat()` functions |
| `src/mcp/instructions.js` | System prompt — shapes Gemini's behavior |
| `.vscode/mcp.json` | VS Code integration — auto-discovers the server |
| `src/db/index.js` | PostgreSQL client — shared by MCP tools and Express |

| Package | Why |
|---------|-----|
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `zod` | Runtime schema validation for tool inputs |
| `@google/generative-ai` | Google Gemini API client |
| `pg` | PostgreSQL database driver |

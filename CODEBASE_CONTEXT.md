# CODEBASE_CONTEXT.md
> Auto-generated comprehensive reference for **open-claude-code v2** (FreeCode repository).  
> Covers all major systems, code snippets for critical logic, and known issues.

---

## Table of Contents
1. [Project Structure](#1-project-structure)
2. [Entry Point & Bootstrap](#2-entry-point--bootstrap)
3. [Core Engine](#3-core-engine)
4. [Tools](#4-tools)
5. [AI Providers](#5-ai-providers)
6. [Permissions & Security](#6-permissions--security)
7. [UI & REPL](#7-ui--repl)
8. [Configuration](#8-configuration)
9. [Agents, Skills, Plugins](#9-agents-skills-plugins)
10. [Tests](#10-tests)
11. [Known Problems](#11-known-problems)

---

## 1. Project Structure

```
FreeCode/
├── README.md
├── CODEBASE_CONTEXT.md
├── electron-app/                  # Electron desktop GUI (separate app)
│   ├── main.js                    # Electron main process
│   ├── preload.js                 # Electron preload script
│   ├── dialog-preload.js
│   ├── api-key-dialog.html
│   ├── multi-agent-orchestrator.js
│   ├── renderer/
│   │   ├── index.html
│   │   ├── chat.js
│   │   ├── chat.css
│   │   └── icon.svg
│   ├── package.json
│   └── package-lock.json
├── v2/                            # PRIMARY: CLI agent (this document covers this)
│   ├── package.json               # name: open-claude-code, bin: occ → src/index.mjs
│   ├── src/
│   │   ├── index.mjs              # Bootstrap entry point
│   │   ├── core/
│   │   │   ├── agent-loop.mjs     # *** Central async-generator loop ***
│   │   │   ├── streaming.mjs      # SSE stream parser + accumulator
│   │   │   ├── context-manager.mjs # Token tracking + compaction
│   │   │   ├── system-prompt.mjs  # CLAUDE.md loader + workspace snapshot
│   │   │   ├── session.mjs        # Session save/resume/teleport
│   │   │   ├── checkpoints.mjs    # File checkpoint (pre-edit snapshots)
│   │   │   ├── cache.mjs          # Anthropic prompt cache control
│   │   │   ├── rate-limiter.mjs   # Exponential backoff for 429/529/5xx
│   │   │   ├── providers.mjs      # Provider registry (Anthropic/OpenAI/Google/NVIDIA/Bedrock/Vertex)
│   │   │   ├── stuck-detector.mjs # Loop-detection (3 failure modes)
│   │   │   ├── verify-write.mjs   # Post-write diff verification helper
│   │   │   └── scheduler.mjs      # Cron/scheduled task scheduler
│   │   ├── tools/
│   │   │   ├── registry.mjs       # Tool registration + dispatch
│   │   │   ├── bash.mjs
│   │   │   ├── read.mjs
│   │   │   ├── read-many.mjs
│   │   │   ├── edit.mjs
│   │   │   ├── edit-utils.mjs     # Shared edit helpers
│   │   │   ├── write.mjs
│   │   │   ├── multi-edit.mjs
│   │   │   ├── glob.mjs
│   │   │   ├── grep.mjs
│   │   │   ├── ls.mjs
│   │   │   ├── lsp.mjs
│   │   │   ├── agent.mjs
│   │   │   ├── web-fetch.mjs
│   │   │   ├── web-search.mjs
│   │   │   ├── todo-write.mjs
│   │   │   ├── notebook-edit.mjs
│   │   │   ├── ask-user.mjs
│   │   │   ├── skill.mjs
│   │   │   ├── tool-search.mjs
│   │   │   ├── enter-worktree.mjs
│   │   │   ├── exit-worktree.mjs
│   │   │   ├── send-message.mjs
│   │   │   ├── remote-trigger.mjs
│   │   │   ├── cron-create.mjs
│   │   │   ├── cron-delete.mjs
│   │   │   ├── cron-list.mjs
│   │   │   └── read-mcp-resource.mjs
│   │   ├── permissions/
│   │   │   ├── checker.mjs        # 6-mode permission gate
│   │   │   ├── injection-check.mjs # Dangerous shell-pattern detection
│   │   │   ├── path-check.mjs     # Sensitive file / protected dir guard
│   │   │   ├── prompt.mjs         # Safe-tool list + readline prompt helper
│   │   │   └── sandbox.mjs        # Sandbox stub
│   │   ├── config/
│   │   │   ├── settings.mjs       # 5-layer settings merge
│   │   │   ├── env.mjs            # ~80 env var schema + reader
│   │   │   └── cli-args.mjs       # CLI flag parser
│   │   ├── ui/
│   │   │   ├── repl.mjs           # Readline REPL (fallback)
│   │   │   ├── commands.mjs       # 38 slash commands
│   │   │   ├── ink-app.mjs        # ANSI terminal helpers (Spinner, highlightCode, etc.)
│   │   │   ├── app.mjs            # Ink React TUI entry
│   │   │   ├── components.mjs     # Ink React components
│   │   │   └── markdown.mjs       # Markdown renderer
│   │   ├── agents/
│   │   │   ├── loader.mjs         # Agent definition loader (.json/.md)
│   │   │   ├── parser.mjs         # JSON/frontmatter agent parser
│   │   │   └── teams.mjs          # Multi-agent team orchestration
│   │   ├── skills/
│   │   │   ├── loader.mjs         # Skills loader (SKILL.md discovery)
│   │   │   └── runner.mjs         # Skill execution helper
│   │   ├── plugins/
│   │   │   └── loader.mjs         # Plugin loader (directory / git / npm)
│   │   ├── hooks/
│   │   │   └── engine.mjs         # Hook engine (7 event types)
│   │   ├── mcp/
│   │   │   ├── client.mjs         # MCP client (stdio/SSE/WS/sHTTP)
│   │   │   ├── transport-sse.mjs
│   │   │   ├── transport-ws.mjs
│   │   │   └── transport-shttp.mjs
│   │   ├── auth/
│   │   │   └── oauth.mjs          # Anthropic OAuth flow stub
│   │   └── telemetry/
│   │       └── index.mjs          # Telemetry stub (track/getStats)
│   └── test/
│       └── test.mjs               # 511 assertions, no external deps
└── vscode-extension/              # VS Code extension (separate deliverable)
    ├── extension.js
    ├── agent-bridge.mjs
    ├── indexer.js
    ├── media/ (chat.html/css/js)
    └── package.json
```

---

## 2. Entry Point & Bootstrap

**File:** `v2/src/index.mjs`  
**Binary:** `occ` (via `package.json` `bin` field)  
**Run:** `node src/index.mjs` or `npm start`

### Initialization Sequence

```
main()
 ├── parseArgs(process.argv.slice(2))        // CLI flags
 ├── loadSettings()                          // 5-layer JSON merge
 ├── readEnv()                               // ~80 env vars
 ├── Apply CLI overrides → settings
 ├── createToolRegistry()                    // 26 built-in tools registered
 ├── createPermissionChecker(settings.permissions)
 ├── new HookEngine(settings.hooks)
 ├── new AgentLoader()  →  agentLoader.load()   // .claude/agents/
 ├── new SkillsLoader() →  skillsLoader.load()  // .claude/skills/
 ├── Wire Skill tool ← skillsLoader
 ├── new SessionManager()
 ├── new CheckpointManager()
 ├── new PromptCache()
 ├── Connect MCP servers (settings.mcpServers) → register tools
 ├── Wire ReadMcpResource tool ← mcpClients[]
 ├── createAgentLoop({ model, tools, permissions, settings, hooks })
 ├── Attach state: _agentLoader, _skillsLoader, _mcpClients, _hooks,
 │                 _permissionMode, _sessionManager, _checkpointManager, _promptCache
 ├── telemetry.track('session.start')
 ├── SIGINT/SIGTERM → cleanup()
 └── if args.prompt:
       Non-interactive: for await event of loop.run(prompt) → stdout
       Formats: text | json | stream-json
     else:
       Interactive: import('./ui/app.mjs') → startInkApp(loop, settings)
       Fallback:   import('./ui/repl.mjs') → startRepl(loop, settings)
```

### State Object (on `loop.state`)

```js
{
  messages: [],           // conversation history (Anthropic message format)
  systemPrompt: string,   // built from CLAUDE.md + tool defs
  systemPromptStatic: string, // tool-free prefix for non-tool providers
  turnCount: 0,
  continuationDepth: 0,   // recursive tool-call nesting depth
  tokenUsage: { input: 0, output: 0 },
  model: string,          // mutable: can be switched via /model
  tools: ToolRegistry,
  _contextManager: ContextManager,
  _stuckDetector: StuckDetector,
  sessionGoal: string|null,
  sessionId: string|null,
  // Attached at boot:
  _agentLoader, _skillsLoader, _mcpClients, _hooks,
  _permissionMode, _sessionManager, _checkpointManager, _promptCache
}
```

---

## 3. Core Engine

### 3.1 agent-loop.mjs — Async Generator Loop

`createAgentLoop({ model, tools, permissions, settings, hooks })` returns `{ run, state }`.

`run(userMessage, options)` is an async generator yielding **13 event types**.

#### Event Types Emitted

| Event | Shape | When |
|-------|-------|------|
| `sessionGoal` | `{ goal }` | First user message, auto-extracted |
| `compaction` | `{ count }` | Context auto-compact triggered |
| `stream_request_start` | `{ turn }` | Before API call |
| `stream_event` | `{ text }` | Streaming text delta |
| `thinking` | `{ text }` | Thinking delta (extended thinking mode) |
| `thinking_complete` | `{ thinking }` | Full thinking block from non-streaming |
| `assistant` | `{ content }` | Full text block from AI |
| `hookPermissionResult` | `{ tool, allowed, message? }` | Hook/permission blocked tool |
| `tool_progress` | `{ tool, status, input }` | Tool about to execute |
| `tool_meta` | `{ tool, ...event }` | Metadata from async-generator tools (e.g. Bash jobId) |
| `tool_stream` | `{ tool, chunk, stream }` | Live output chunk from streaming tools |
| `result` | `{ tool, result, input, isError }` | Tool completed |
| `warning` | `{ tool, message }` | Verify-write mismatch |
| `retrying` | `{ attempt, maxAttempts, delaySeconds }` | Rate-limit retry |
| `stuck` | `{ reason, summary }` | StuckDetector fired |
| `error` | `{ message }` | Unrecoverable error |
| `stop` | `{ reason }` | End of response (end_turn, tool_use, max_turns, stuck, loop_limit, repetition_detected) |

#### Core Loop Logic (abridged)

```js
async function* run(userMessage, options = {}) {
  // 1. Append user message + reset stuck detector on new turns
  if (userMessage && !options.continuation) {
    state.messages = contextManager.addMessage(state.messages, { role: 'user', content: userMessage });
    state.turnCount++;
    state.continuationDepth = 0;
    state._stuckDetector.resetTurn();
  } else if (options.continuation) {
    state.continuationDepth++;
    if (state.continuationDepth >= (settings.maxContinuationTurns || 100)) {
      yield { type: 'error', message: 'Agent loop limit reached...' };
      yield { type: 'stop', reason: 'loop_limit' };
      return;
    }
  }

  // 2. Auto-compact if context window approaching limit
  if (contextManager.shouldCompact(state.messages)) {
    yield { type: 'compaction', count: contextManager.compactionCount + 1 };
    state.messages = contextManager.compact(state.messages, 6, state.sessionGoal);
  }

  yield { type: 'stream_request_start', turn: state.turnCount };

  // 3. Call AI provider (with retry loop for 429/5xx)
  const provider = detectProvider(state.model);
  response = await callApiStreaming(provider, model, state, tools.list(), settings);
  // ... streaming events forwarded via yield ...

  // 4. Append assistant message to history
  state.messages.push({ role: 'assistant', content: response.content });

  // 5. Process content blocks
  for (const block of response.content) {
    if (block.type === 'text')     yield { type: 'assistant', content: block.text };
    if (block.type === 'thinking') yield { type: 'thinking_complete', thinking: block.thinking };
    if (block.type === 'tool_use') toolUseBlocks.push(block);
  }

  // 6. Execute tool calls
  for (const block of toolUseBlocks) {
    // Pre-hook check → permission check → tool.call() → post-hook
    // → verify-write check → stuck-detector.record()
    // → stuck? yield { type: 'stuck' } + return
    yield { type: 'result', tool, result, isError };
    toolResults.push({ type: 'tool_result', tool_use_id, content });
  }

  if (toolUseBlocks.length > 0) {
    state.messages.push({ role: 'user', content: toolResults });
    yield* run(null, { continuation: true });  // RECURSIVE
    return;
  }

  // 7. No tool calls → check stop hooks
  yield { type: 'stop', reason: response.stop_reason || 'end_turn' };

  // 8. Persist session summary at outermost stop
  if (!options.continuation && state.sessionId) {
    contextManager.persistSession(state.messages, state.sessionId, '', state.sessionGoal);
  }
}
```

#### Tool Call Dispatch

```js
// Pre-hook
const hookResult = await hooks.runPreToolUse(block.name, block.input);
if (!hookResult.allow) { /* yield hookPermissionResult, append error result, continue */ }

// Permission check
const allowed = await permissions.check(block.name, block.input);
if (!allowed) { /* append mode-specific denial message, continue */ }

// Execute — supports both regular calls and async-generator tools
const callResult = await tools.call(block.name, block.input);
if (callResult[Symbol.asyncIterator]) {
  for await (const event of callResult) {
    if (event.type === 'chunk') yield { type: 'tool_stream', chunk: event.data };
    if (event.type === 'done')  result = event.result;
  }
} else {
  result = callResult;
}

// Post-hook
result = await hooks.runPostToolUse(block.name, result);

// Stuck detection
state._stuckDetector.record(block.name, block.input, result, isToolError);
const stuckCondition = state._stuckDetector.check();
if (stuckCondition) { yield { type: 'stuck', ... }; return; }
```

#### Repetition Detection

```js
// In the streaming loop — aborts if model output is repeating
if (detectRepetition(currentText)) {
  yield { type: 'error', message: 'repetitive output detected...' };
  yield { type: 'stop', reason: 'repetition_detected' };
  return;
}
```

#### Validation-Error Nudge

When **all** tool calls in a batch fail with `Validation error:`, the loop appends a text nudge:
```
[System: All tool call(s) above failed input validation. Review the required parameter names
for each tool and retry the tool call(s) immediately. Do not stop or summarise — keep going.]
```

#### Provider Detection

```js
function detectProvider(model) {
  if (findCustomProvider(model)) return 'custom';          // CUSTOM_PROVIDERS_JSON env
  if (model.startsWith('gpt-') || ...) return 'openai';
  if (model.startsWith('gemini'))      return 'google';
  if (isNvidiaModel(model))            return 'nvidia';    // "publisher/model" format
  return 'anthropic';                                      // default
}
```

---

### 3.2 streaming.mjs

Parses Anthropic SSE streams.

**`streamResponse(response)`** — async generator over raw SSE events:
- Reads body with `getReader()`, splits on `\n\n`
- Emits: `ping`, `done`, or parsed JSON event objects

**`accumulateStream(events)`** — collects all events into final message shape:
```js
{
  id, role: 'assistant', content: [...blocks], model,
  stop_reason, usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
}
```

Content block accumulation:
- `content_block_start` → allocates block (text/thinking/tool_use)
- `content_block_delta` → appends `text_delta`, `thinking_delta`, `input_json_delta`
- `content_block_stop` → parses `tool_use.input` from accumulated JSON string
- `message_delta` → captures `stop_reason` and `output_tokens`
- `error` → throws `Stream error: ...`

---

### 3.3 context-manager.mjs

```js
new ContextManager(maxTokens = 180000)
```

**Token estimation:** character-based heuristic — `Math.ceil(totalChars / 4)` (4 chars ≈ 1 token)

**shouldCompact(messages):** `tokenCount >= maxTokens * 0.80`

**Compaction strategy (compact):**
1. Try `microCompact()` first — only truncates stale tool results
2. If still over limit, do full compaction:
   - F9: adaptive `keepRecent` — shrinks by 2 until recent slice fits in 50% of budget
   - Builds summary text from older messages (max 8000 chars total)
   - Re-injects `sessionGoal` as prefix
   - Returns `[summaryMsg, ...recentMessages]`

**microCompact():**
- Error tool results (prefix `Error:`) → truncated to 50 chars after 2 turns  
- Large Read results → truncated to 300 chars after 10 turns

**addMessage(messages, msg, sessionGoal):** appends + auto-compacts if needed

**Session persistence:** saves summary JSON to `~/.freecode/sessions/<sessionId>.json`

Constants:
```
DEFAULT_MAX_TOKENS       = 180000
COMPACT_THRESHOLD        = 0.80
CHARS_PER_TOKEN          = 4
STALE_TOOL_RESULT_TURNS  = 10
STALE_ERROR_RESULT_TURNS = 2
MICRO_COMPACT_ERROR_CHARS = 50
MICRO_COMPACT_KEEP_CHARS = 300
MAX_MSG_SUMMARY          = 500
MAX_TOTAL_SUMMARY        = 8000
```

---

### 3.4 system-prompt.mjs

**`buildSystemPrompt({ cwd, tools, override, addDirs })`**

Loads and merges CLAUDE.md files in this order:
1. `~/.claude/CLAUDE.md` (global)
2. `<cwd>/.claude/CLAUDE.md` (project)
3. `<cwd>/CLAUDE.md` (project root)
4. Any `addDirs` entries
5. Appends current working directory + tool schemas

Returns `{ full, staticPrefix }` — `staticPrefix` is the tool-free section for providers that can't handle tool definitions in the system prompt.

**`buildWorkspaceSnapshot(cwd, maxFiles=200)`**

Builds a compact indented directory tree (capped at 200 entries). Excludes: `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `__pycache__`, `.cache`, `coverage`, `.nyc_output`, `.turbo`.

Includes select dotfiles: `.eslintrc`, `.prettierrc`, `.babelrc`, `.gitignore`, etc.

**`buildWorkspaceContent(cwd, opts)`**

For thinking models (Kimi K2.5, DeepSeek R1) that cannot call tools: builds a rich context string containing the file tree + contents of priority files (README.md, package.json, entry points, CLAUDE.md, etc.). Capped at 8192 bytes per file and 65536 bytes total.

Priority files list includes: `README.md`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `index.js/mjs/ts`, `main.py`, `CLAUDE.md`, `tsconfig.json`, `Dockerfile`, etc.

---

### 3.5 session.mjs — SessionManager

```js
new SessionManager(projectDir = process.cwd())
```

- `sessionId` — format: `sess_<timestamp>_<4hex>`
- Session files stored at: `~/.claude/projects/<sha256(projectDir)[0:16]>/session.json`

Methods:
- `save(state)` — writes messages, turnCount, tokenUsage, model to JSON
- `resume(state)` — reads and restores state; returns boolean
- `exportForTeleport(state)` → base64-encoded JSON
- `importFromTeleport(data, state)` — restores from base64
- `clear()` — deletes session file

---

### 3.6 checkpoints.mjs — CheckpointManager

```js
new CheckpointManager(baseDir = process.cwd())
```

- Checkpoint files stored at: `<baseDir>/.claude/checkpoints/ckpt_<ts>_<4hex>.json`
- Max 50 checkpoints (ring-buffer; oldest deleted)

Methods:
- `save(filePath)` — reads current file content, writes checkpoint JSON; returns ckpt ID or null
- `undo()` — pops latest checkpoint, restores file content, deletes checkpoint file
- `list(limit=10)` — returns recent checkpoints with id/file/timestamp/size
- `clear()` — empties history and deletes all checkpoint files

---

### 3.7 cache.mjs — PromptCache

Adds `cache_control: { type: 'ephemeral' }` to system prompt blocks for Anthropic's prompt caching API.

- `applyCacheControl(systemPrompt)` — wraps string or array blocks
- `updateStats(usage)` — tracks cacheHits/cacheMisses from API usage response
- `getStats()` — returns hit rate %, tokensSaved, etc.

---

### 3.8 rate-limiter.mjs — RateLimiter

```js
new RateLimiter({ maxRetries: 5, baseDelay: 1000, maxDelay: 60000 })
```

- `handleResponse(response)` — returns `'retry'` / `'ok'` / `'fail'`
  - HTTP 429 → honours `Retry-After` header or waits proportionally
  - HTTP 529, 502, 503, 504 → exponential backoff with jitter
- `calculateBackoff()` → `min(baseDelay * 2^retryCount + jitter, maxDelay)`

Used inside `callCustomProvider()`; agent-loop has its own independent retry logic (3 retries, 30s base delay).

---

### 3.9 stuck-detector.mjs — StuckDetector

Detects 3 failure modes in the tool-call loop:

```js
new StuckDetector({ volumeLimit: 20 })
```

**Reset:** `resetTurn()` — must be called on every new user message.

**Record:** `record(name, input, result, isError)` — logs each completed tool call.

**Check:** `check()` — returns `{ reason, summary }` or `null` after each record.

| Reason | Condition |
|--------|-----------|
| `SAME_CALL_LOOP` | Same tool + same args called 3× with identical result or any failure |
| `THRASHING_LOOP` | 3+ different tools all failing on the same file within last 10 calls |
| `VOLUME_LIMIT` | More than `volumeLimit` (default 20) tool calls in one turn |

Key implementation: `callKey(name, input)` uses djb2 hash for inputs > 1000 chars serialized.

---

### 3.10 verify-write.mjs

Two post-write verification functions, only active when `settings.verifyWrites === true` (default `false`):

- `verifyWrite(filePath, expectedContent)` — reads file back, diffs against expected; returns `{ match, diff }`
- `verifyEdit(filePath, oldString, newString)` — checks `new_string` present, `old_string` absent

Diff format: up to 10 differing lines with `- (expected)` / `+ (on disk)` prefixes.

---

## 4. Tools

### 4.1 Tool Registry Interface

**File:** `v2/src/tools/registry.mjs`

```js
const registry = createToolRegistry();

registry.list()          // [{name, description, input_schema}, ...]
registry.call(name, input) // validates then calls; returns string result
registry.register(tool)    // add a custom tool
registry.get(name)         // retrieve tool object
registry.has(name)         // existence check
registry.registerMcpTools(mcpTools, callFn)  // wraps MCP tools
```

Validation: each tool's `validateInput(input)` returns `string[]` of errors. On errors, `call()` returns `"Validation error: <msg>. Please correct the parameters and retry the tool call."`.

Unknown tool: throws `Error('Unknown tool: <name>')`.

---

### 4.2 All 26 Built-in Tools

#### **Bash**
- **Name:** `Bash`
- **Purpose:** Execute shell commands. Supports timeout, working directory, background jobs, stdin injection, and live streaming.
- **Input:** `{ command: string, timeout?: number, cwd?: string, stdin?: string }`
- **Output:** stdout/stderr merged, truncated to 200 lines by default
- **Async-generator:** yields `{ type: 'meta', jobId }`, `{ type: 'chunk', data, stream }`, `{ type: 'done', result }`
- **Failure modes:** command not found, permission denied, timeout exceeded

#### **Read**
- **Name:** `Read`
- **Purpose:** Read a file with line limit.
- **Input:** `{ file_path: string, limit?: number (default 2000) }`
- **Output:** file content (string), `1 | <line>` numbered lines
- **Failure modes:** file not found, path outside CWD warning, sensitive file blocked

#### **ReadMany**
- **Name:** `ReadMany`
- **Purpose:** Read multiple files in one call (batched, parallel).
- **Input:** `{ file_paths: string[], limit?: number (default 2000) }`
- **Constraints:** max 20 files per call
- **Output:** `=== <path> ===\n<content>` blocks joined by blank lines
- **Failure modes:** >20 files → validation error; individual file errors embedded

#### **Edit**
- **Name:** `Edit`
- **Purpose:** Replace exact `old_string` with `new_string` in a file.
- **Input:** `{ file_path: string, old_string: string, new_string: string, replace_all?: boolean }`
- **Output:** `File updated: <path>` on success
- **Failure modes:** `old_string` not found in file, empty `file_path`

#### **MultiEdit**
- **Name:** `MultiEdit`
- **Purpose:** Apply multiple edits to multiple files in one call.
- **Input:** `{ edits: [{ file_path, old_string, new_string, replace_all? }] }`
- **Output:** `Applied <N> edits to <M> files`
- **Failure modes:** any single edit failure surfaces as partial result

#### **Write**
- **Name:** `Write`
- **Purpose:** Create or overwrite a file with given content.
- **Input:** `{ file_path: string, content: string }`
- **Output:** `File written: <path> (<N> lines)`
- **Failure modes:** path validation failure, disk errors

#### **Glob**
- **Name:** `Glob`
- **Purpose:** Find files matching a glob pattern.
- **Input:** `{ pattern: string, cwd?: string, ignore?: string[] }`
- **Output:** matching paths, one per line
- **Failure modes:** invalid pattern, no matches

#### **Grep**
- **Name:** `Grep`
- **Purpose:** Search for regex pattern in files.
- **Input:** `{ pattern: string, path?: string, include?: string, exclude?: string, case_insensitive?: boolean }`
- **Output:** `<file>:<line>: <content>` lines
- **Failure modes:** invalid regex, no matches

#### **LS**
- **Name:** `LS`
- **Purpose:** List directory contents.
- **Input:** `{ path: string }`
- **Output:** directory listing with sizes, directories marked with `/`
- **Failure modes:** path not found

#### **LSP**
- **Name:** `LSP`
- **Purpose:** Language Server Protocol operations (diagnostics, hover, completion, definition).
- **Input:** `{ action: 'diagnostics'|'hover'|'completion'|'definition', file: string, line?: number, character?: number }`
- **Output:** LSP results as JSON or formatted text
- **Failure modes:** LSP not enabled, server not running, file not found

#### **Agent**
- **Name:** `Agent`
- **Purpose:** Launch a sub-agent (spawns a child `createAgentLoop` with full tool access).
- **Input:** `{ prompt: string, model?: string }`
- **Output:** final assistant response from sub-agent
- **Failure modes:** model not configured, token limit exceeded

#### **WebFetch**
- **Name:** `WebFetch`
- **Purpose:** Fetch a URL and return page content (text/HTML/JSON).
- **Input:** `{ url: string, timeout?: number }`
- **Validation:** URL must start with `http://` or `https://`
- **Output:** response body (truncated)
- **Failure modes:** network error, timeout, invalid URL

#### **WebSearch**
- **Name:** `WebSearch`
- **Purpose:** Search the web via Brave Search API or SearXNG.
- **Input:** `{ query: string, max_results?: number }`
- **Output:** search results with titles/snippets/URLs
- **Failure modes:** no API key configured, network error

#### **TodoWrite**
- **Name:** `TodoWrite`
- **Purpose:** Update the in-session todo list.
- **Input:** `{ todos: [{ content: string, status: 'pending'|'in_progress'|'completed', priority: 'high'|'medium'|'low', id?: string }] }`
- **Output:** `Updated N todos (X completed, Y pending, Z in_progress)`

#### **NotebookEdit**
- **Name:** `NotebookEdit`
- **Purpose:** Edit Jupyter notebook (`.ipynb`) cells.
- **Input:** `{ notebook_path: string, operation: 'insert'|'replace'|'delete', cell_index: number, cell_type?: 'code'|'markdown'|'raw', source?: string }`
- **Output:** `Notebook updated: <op> at cell <idx>`
- **Failure modes:** invalid notebook format, cell index out of range

#### **AskUser**
- **Name:** `AskUser`
- **Purpose:** Prompt the user for interactive input.
- **Input:** `{ question: string, default_value?: string }`
- **Output:** user-typed answer, or `default_value` in non-TTY environments
- **Failure modes:** empty question validation error

#### **Skill**
- **Name:** `Skill`
- **Purpose:** Invoke a named skill (runs its prompt via the agent loop).
- **Input:** `{ skill: string, args?: string }`
- **Output:** skill execution result
- **Failure modes:** skill not initialized (loader not set), unknown skill name

#### **ToolSearch**
- **Name:** `ToolSearch`
- **Purpose:** Search for available tools by name/keyword across built-in and MCP tools.
- **Input:** `{ query: string, max_results?: number }`
- **Output:** matching tools with source tag `[mcp]` or `[builtin]`

#### **EnterWorktree**
- **Name:** `EnterWorktree`
- **Purpose:** Create and switch to a git worktree branch for isolated editing.
- **Input:** `{ branch?: string, path?: string }`
- **Output:** worktree info string
- **Failure modes:** not in git repo, already in a worktree

#### **ExitWorktree**
- **Name:** `ExitWorktree`
- **Purpose:** Exit active git worktree and return to original cwd.
- **Input:** `{}` (none required)
- **Output:** confirmation or "Not currently in a worktree"

#### **SendMessage**
- **Name:** `SendMessage`
- **Purpose:** Send a message to a teammate agent (multi-agent mode). Stored in in-process `Map`.
- **Input:** `{ to: string, content: string, type?: 'request'|'response'|'notification'|'handoff' }`
- **Output:** `Message sent to "<to>" (id: ..., type: ...)`

#### **RemoteTrigger**
- **Name:** `RemoteTrigger`
- **Purpose:** Trigger remote task execution on a remote agent endpoint via HTTP POST.
- **Input:** `{ task: string, endpoint?: string, timeout?: number, async?: boolean }`
- **Output:** remote result or `No remote endpoint configured`
- **Failure modes:** no endpoint set, network error, timeout

#### **CronCreate**
- **Name:** `CronCreate`
- **Purpose:** Create a scheduled task (stored in in-process `Map`, checked by scheduler).
- **Input:** `{ name: string, schedule: string (e.g. '5m','1h'), command: string, args?: object }`
- **Output:** `Created scheduled task: <name>`

#### **CronDelete**
- **Name:** `CronDelete`
- **Purpose:** Delete a scheduled task by name.
- **Input:** `{ name: string }`
- **Output:** `Deleted: <name>` or not found message

#### **CronList**
- **Name:** `CronList`
- **Purpose:** List all scheduled tasks.
- **Input:** `{}` (none required)
- **Output:** `No scheduled tasks.` or table of task id/name/schedule/lastRun

#### **ReadMcpResource**
- **Name:** `ReadMcpResource`
- **Purpose:** Read a resource from an MCP server by URI.
- **Input:** `{ uri: string, server?: string }`
- **Output:** resource content (text or JSON)
- **Failure modes:** no MCP servers connected, resource not found

---

## 5. AI Providers

### 5.1 providers.mjs — Provider Registry

Six providers defined. Provider routing in `agent-loop.mjs`:

```js
// Model prefix routing
function detectProvider(model) {
  if (findCustomProvider(model))          return 'custom';   // CUSTOM_PROVIDERS_JSON
  if (model.startsWith('gpt-') || ...)   return 'openai';
  if (model.startsWith('gemini'))         return 'google';
  if (isNvidiaModel(model))               return 'nvidia';   // "publisher/model" format
  return 'anthropic';
}
```

### 5.2 All Providers

#### **Anthropic** (default)
- Endpoint: `https://api.anthropic.com/v1/messages`
- Auth: `x-api-key: <ANTHROPIC_API_KEY>` + `anthropic-version: 2023-06-01`
- Models: `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-6`
- Extended thinking: enabled for `opus` or `settings.thinking === true`
  ```js
  body.thinking = { type: 'enabled', budget_tokens: settings.thinkingBudget || 10000 }
  ```
- Tool format: native Anthropic `tools` array (passed as-is from registry)
- Stream: Anthropic SSE (`streamResponse` / `accumulateStream`)

#### **OpenAI**
- Endpoint: `process.env.OPENAI_BASE_URL/chat/completions` (default: `https://api.openai.com/v1`)
- Auth: `Authorization: Bearer <OPENAI_API_KEY>`
- Models: `gpt-4o`, `gpt-4o-mini`, `o1-preview`, `o1-mini`, `o3-mini`
- Tool format conversion (in `agent-loop.mjs`):
  ```js
  // Anthropic tool → OpenAI function format
  tools: toolDefs.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }))
  // Anthropic messages → OpenAI format (buildOpenAIMessages):
  //   assistant tool_use blocks → { role: 'assistant', tool_calls: [...] }
  //   user tool_result blocks  → { role: 'tool', tool_call_id, content }
  ```
- Response conversion (`convertOpenAIResponse`):
  ```js
  // tool_calls → { type: 'tool_use', id, name, input: JSON.parse(arguments) }
  stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason
  ```

#### **Google Gemini**
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<KEY>`
- Auth: API key in query string (`GOOGLE_API_KEY` or `GEMINI_API_KEY`)
- Models: `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-flash`
- Tool format:
  ```js
  // Anthropic tool → Gemini function declaration
  tools: [{ functionDeclarations: toolDefs.map(t => ({
    name: t.name, description: t.description, parameters: t.input_schema
  })) }]
  // Messages conversion:
  //   tool_use  → { functionCall: { name, args } }
  //   tool_result → { functionResponse: { name: tool_use_id, response: { output } } }
  ```
- Response conversion (`convertGoogleResponse`):
  - `functionCall` parts → `{ type: 'tool_use', id: 'tu_<nextId()>', name, input: args }`
  - Tool call IDs generated via monotonic counter (`nextId()`) since Gemini doesn't generate them

#### **NVIDIA NIM**
- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`
- Auth: `Authorization: Bearer <NVIDIA_API_KEY>`
- Models (via `isNvidiaModel()`): `moonshotai/kimi-k2.5`, `nvidia/llama-3.1-nemotron-70b-instruct`, `meta/llama-3.1-405b-instruct`, `meta/llama-3.3-70b-instruct`, `mistralai/mistral-large-2-instruct`, `mistralai/mixtral-8x22b-instruct-v0.1`, `google/gemma-3-27b-it`, `deepseek-ai/deepseek-r1`
- Tool format: OpenAI-compatible `function` format
- **Kimi K2.5 / DeepSeek R1 special handling:**
  - `NVIDIA_THINKING_CAPABLE_MODELS = { 'moonshotai/kimi-k2.5', 'deepseek-ai/deepseek-r1' }`
  - Default (NVIDIA_THINKING_MODE unset): standard tool-calling mode, all tools work
  - When `NVIDIA_THINKING_MODE=true`: adds `chat_template_kwargs: { thinking: true }`, omits tools, injects workspace snapshot instead
  - Thinking content surfaced as `{ type: 'thinking', thinking }` block
- Stream: OpenAI-style SSE (`streamOpenAIResponse`) — `data: {...}` lines ending with `data: [DONE]`

#### **AWS Bedrock** (stub)
- Dynamic endpoint: `https://bedrock-runtime.<region>.amazonaws.com/model/<model>/invoke`
- Auth: AWS SigV4 (not implemented — header stub only)
- Models: `anthropic.claude-3-sonnet`, `anthropic.claude-3-haiku`
- Env vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`

#### **Google Vertex AI** (stub)
- Dynamic endpoint: `https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/publishers/anthropic/models/<model>:rawPredict`
- Auth: GCP bearer token (not implemented — header stub only)
- Models: `claude-sonnet-4-6@anthropic`
- Env vars: `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_PROJECT`, `VERTEX_REGION`

#### **Custom Provider**
- Configured via `CUSTOM_PROVIDERS_JSON` env var (JSON array of provider configs)
- Uses `callCustomProvider()` which calls `streamOpenAIResponse` / `convertNvidiaResponse`
- Each provider object: `{ id, models, endpoint, apiKey (or envKey), headers, baseUrl }`
- Retry logic via `RateLimiter({ maxRetries: 3, baseDelay: 3000 })`

---

## 6. Permissions & Security

### 6.1 checker.mjs — 6 Permission Modes

```js
createPermissionChecker({ defaultMode, rl, promptCallback })
```

Mode priority: `config.defaultMode` → `CLAUDE_CODE_PERMISSION_MODE` env → `'default'`

**Flow for every `check(toolName, input)` call:**

```
1. Bash injection check (always)         → checkInjection(command)
2. File path validation (always)         → validatePath(file_path, { write })
3. ReadMany path array validation        → validatePath() for each path
4. WebSearch/WebFetch always allowed     → return true
5. Mode switch:
   bypassPermissions → true (allow all)
   acceptEdits       → true (allow all)
   auto              → true (AI decides)
   dontAsk           → false (deny all except WebSearch/WebFetch)
   plan              → true (allow all)
   default           → requiresPermission(toolName) ? prompt/callback : true
```

| Mode | Behavior |
|------|----------|
| `bypassPermissions` | Allow everything unconditionally |
| `acceptEdits` | Allow everything (user pre-accepted) |
| `auto` | Allow everything (AI decides autonomously) |
| `dontAsk` | Deny all except WebSearch/WebFetch |
| `plan` | Allow everything (planning only mode) |
| `default` | Safe read-only tools pass; others prompt via `promptCallback` or `rl` |

---

### 6.2 injection-check.mjs

15 dangerous shell patterns checked on every Bash command:

| Pattern | Label |
|---------|-------|
| `;\s*rm\s+-rf\s+\/` | rm -rf / |
| `\|\s*sh\b` | pipe to sh |
| `\|\s*bash\b` | pipe to bash |
| `` `[^`]+` `` | backtick execution |
| `\$\([^)]+\)` | command substitution |
| `>\s*\/etc\/` | write to /etc |
| `>\s*\/usr\/` | write to /usr |
| `curl\s.*\|\s*(bash\|sh)` | curl pipe to shell |
| `wget\s.*\|\s*(bash\|sh)` | wget pipe to shell |
| `mkfs\.` | filesystem format |
| `dd\s+if=.*of=\/dev\/` | dd to device |
| `:\(\)\s*\{.*\|.*&\s*\}` | fork bomb |
| `chmod\s+777\s+\/` | chmod 777 root |
| `>\s*\/dev\/sda` | write to disk device |
| `eval\s+"?\$` | eval variable |

Returns `{ safe: boolean, pattern?, label? }`.

---

### 6.3 path-check.mjs

**Sensitive file patterns** (block read and write):
`.env`, `.env.*`, `credentials.json`, `credentials.yaml`, `.pem`, `.key`, `id_rsa`, `id_ed25519`, `.ssh/config`, `.netrc`, `.pgpass`, `.aws/credentials`, `.docker/config.json`, `secrets.yaml`, `secrets.json`

**Protected directories** (block write only):
`/etc`, `/usr`, `/sbin`, `/boot`, `/sys`, `/proc`

**Additional checks:**
- Null bytes in path → blocked
- Path outside CWD → allowed with `warning` field set (not blocked)

Returns `{ safe, resolved, reason?, warning? }`.

---

## 7. UI & REPL

### 7.1 repl.mjs — Readline REPL (Fallback)

Used when Ink TUI fails (no TTY, missing deps).

- Tab-completion for slash commands via `getCompletions(partial)`
- On input:
  - Slash command → `executeCommand(input, state)` → print response
  - Skill invocation → `skillsLoader.get(name)` → `loop.run()` with skill prompt
  - Regular prompt → `loop.run(input)` → `renderEvent()` for each event
- Shows spinner during AI calls
- Shows status bar (`renderStatusBar()`) after each response if `settings.showTokenUsage !== false`

`renderEvent()` mapping:
- `stream_event` → `process.stdout.write(text)`
- `thinking` → dim ANSI (if `SHOW_THINKING` env set)
- `tool_progress` → yellow tool name to stderr
- `result` → tool output (if `SHOW_TOOL_RESULTS` env set)
- `assistant` → `highlightCode(content)` to stdout
- `compaction` → dim notice to stderr
- `hookPermissionResult` (blocked) → red `[blocked: <tool>]` to stderr
- `error` → red `Error: <msg>` to stderr

---

### 7.2 ink-app.mjs — ANSI Terminal Helpers

No external dependencies. Full color support via ANSI escape codes. Respects `NO_COLOR=1`.

Exports:
- **`Spinner`** — animated spinner (braille frames, 80ms interval, stderr, TTY-only)
- **`highlightCode(text)`** — detects ` ``` ` blocks and applies basic syntax colors; renders markdown bold/italic/inline-code
- **`renderToolProgress(tool, status)`** — `[tool] running...` in yellow
- **`renderStatusBar(state)`** — model / input tokens / output tokens / turns / cost estimate
- **`renderError(message)`** — red bold error line
- **`renderStuckPanel(reason, summary)`** — boxed stuck-detector notification

---

### 7.3 commands.mjs — 38 Slash Commands

All commands: `handler(args, state)` → `string` response. Exit commands return `'EXIT'`.

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/clear` | Clear conversation history (messages + turnCount) |
| `/compact` | Manually compact context (calls `_contextManager.compact()`) |
| `/cost` | Token usage + cost estimate (Haiku/Sonnet/Opus pricing) |
| `/doctor` | System health check (Node version, API key, tools, MCP servers) |
| `/fast` | Toggle between Haiku (fast) and Sonnet (default) models |
| `/model [name]` | Show or switch model |
| `/tokens` | Show token usage + context size estimate |
| `/tools` | List all registered tools |
| `/quit` | Exit REPL |
| `/exit` | Exit REPL |
| `/bug` | Link to GitHub issues |
| `/review` | `git diff --stat HEAD~1` |
| `/init` | Create `.claude/` directory + default `settings.json` |
| `/login <key>` | Set `ANTHROPIC_API_KEY` in process env |
| `/logout` | Clear `ANTHROPIC_API_KEY` |
| `/status` | Show session info (id, project, model, turns, messages) |
| `/config` | Show all non-secret env vars |
| `/memory` | Show message count, KB, estimated tokens |
| `/forget [n]` | Remove last N messages (default 2) |
| `/effort [low\|normal\|high]` | Set/show effort level |
| `/think` | Toggle extended thinking flag |
| `/plan` | Toggle plan mode flag |
| `/vim` | Toggle vim mode flag |
| `/terminal-setup` | Show TERM/columns/rows/color/unicode info |
| `/mcp` | Show MCP server connection status |
| `/permissions` | Show current permission mode |
| `/hooks` | Show configured hooks and handler counts |
| `/agents` | List loaded custom agents |
| `/skills` | List loaded skills (with `/name` invocation hint) |
| `/schedule` | List cron scheduled tasks |
| `/extra-usage` | Detailed stats (cache hit rate, telemetry events) |
| `/undo` | Restore last file checkpoint |
| `/diff` | `git diff --stat` |
| `/listen` | Toggle listening mode stub |
| `/commit [msg]` | `git add -A && git commit -m <msg>` |
| `/pr` | Link to `gh pr create --fill` |
| `/release` | Link to `gh release create` |

Tab-completion: `getCompletions(partial)` — filters `Object.keys(COMMANDS)` by prefix.

---

## 8. Configuration

### 8.1 settings.mjs — 5-Layer Settings Merge

Load order (later layers override earlier):
1. **Schema defaults** — `SETTINGS_SCHEMA` (hardcoded)
2. **User global** — `~/.claude/settings.json`
3. **Project** — `<cwd>/.claude/settings.json`
4. **Project local** — `<cwd>/.claude/settings.local.json`
5. **Env overrides** — applied via `applyEnvOverrides(merged)`

Deep-merge strategy: objects are recursively merged; arrays and primitives are replaced.

**Key schema defaults:**
```js
{
  permissions: { defaultMode: 'default', allowRules: [], denyRules: [], ... },
  hooks: { PreToolUse: [], PostToolUse: [], ... },
  model: 'claude-sonnet-4-6',
  subagentModel: null,
  fastModel: 'claude-haiku-4-5',
  maxContextTokens: 180000,
  maxOutputTokens: 16384,
  maxTokens: 16384,
  thinkingBudget: 10000,
  compactThreshold: 0.8,
  stream: true,
  mcpServers: {},
  fileCheckpointingEnabled: true,
  autoCompactEnabled: true,
  telemetryEnabled: false,
  cronEnabled: true,
  enableTeams: false,
  ...
}
```

**Env overrides applied by `applyEnvOverrides()`:**
| Env Var | Setting Modified |
|---------|-----------------|
| `ANTHROPIC_MODEL` | `model` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `subagentModel` |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `maxOutputTokens`, `maxTokens` |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `maxContextTokens` |
| `CLAUDE_CODE_BRIEF=1` | `briefMode: true` |
| `CLAUDE_CODE_DEBUG=1` | `debugMode: true` |
| `CLAUDE_CODE_PERMISSION_MODE` | `permissions.defaultMode` |
| `CLAUDE_CODE_STREAMING=0` | `stream: false` |
| `CLAUDE_CODE_THINKING=1` | `alwaysThinkingEnabled: true` |
| `CLAUDE_CODE_DISABLE_CRON=1` | `cronEnabled: false` |
| `CLAUDE_CODE_ENABLE_TASKS=1` | `enableTeams: true` |

---

### 8.2 env.mjs — ~80 Environment Variables

`readEnv()` normalizes all vars. `getEnv(key, default)` for single-var lookup. `listEnvVars()` for display.

**Key variables (grouped):**

**API Keys:**
- `ANTHROPIC_API_KEY` — required for Anthropic models
- `OPENAI_API_KEY` — for OpenAI models
- `GOOGLE_API_KEY` / `GEMINI_API_KEY` — for Gemini models
- `NVIDIA_API_KEY` — for NVIDIA NIM models
- `BRAVE_API_KEY` — for Brave Search
- `SEARXNG_URL` — for SearXNG self-hosted search
- `REMOTE_AGENT_TOKEN` — for RemoteTrigger authentication

**Model/Behavior:**
- `ANTHROPIC_MODEL` — override default model
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — default 16384
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — default 180000
- `CLAUDE_CODE_THINKING=1` / `CLAUDE_CODE_THINKING_BUDGET` — extended thinking
- `CLAUDE_CODE_STREAMING=0` — disable streaming
- `CLAUDE_CODE_EFFORT_LEVEL` — low/normal/high

**Security:**
- `CLAUDE_CODE_PERMISSION_MODE` — permission mode override
- `CLAUDE_CODE_INJECTION_CHECK=0` — disable injection checks
- `CLAUDE_CODE_PATH_CHECK=0` — disable path validation
- `CLAUDE_CODE_SANDBOX=0` — disable sandbox

**Rate Limiting:**
- `CLAUDE_CODE_MAX_RETRIES` — default 5
- `CLAUDE_CODE_RETRY_BASE_DELAY` — default 1000ms
- `CLAUDE_CODE_RETRY_MAX_DELAY` — default 60000ms

**Multi-agent:**
- `CLAUDE_CODE_ENABLE_TASKS=1` — enable team system
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — agent teams
- `AGENT_ID` — default 'main'
- `CLAUDE_CODE_TEAM_SIZE` — default 5
- `REMOTE_AGENT_URL` — remote agent endpoint

**Provider-specific:**
- `OPENAI_BASE_URL` — override OpenAI endpoint (for OpenAI-compatible proxies)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — Bedrock
- `VERTEX_PROJECT`, `VERTEX_REGION` — Vertex AI
- `NVIDIA_THINKING_MODE=true` — enable Kimi K2.5 / DeepSeek R1 thinking mode (disables tools)

**Paths:**
- `CLAUDE_CONFIG_DIR` — custom config directory
- `CLAUDE_CACHE_DIR` — custom cache directory
- `CLAUDE_CODE_PLUGIN_DIR` — custom plugin directory
- `CLAUDE_CODE_WORKTREE_DIR` — default worktree base dir

**Timeouts:**
- `CLAUDE_CODE_TOOL_TIMEOUT` — default 120000ms
- `CLAUDE_CODE_API_TIMEOUT` — default 300000ms
- `CLAUDE_CODE_MCP_TIMEOUT` — default 30000ms

**Custom Provider:**
- `CUSTOM_PROVIDERS_JSON` — JSON array of custom provider configs

---

### 8.3 cli-args.mjs — CLI Flags

```
Usage: occ [options] [prompt]

Options:
  --model, -m <model>        Model to use (default: claude-sonnet-4-6)
  --permission-mode <mode>   bypassPermissions | acceptEdits | plan | auto | dontAsk
  --print, -p <prompt>       Non-interactive mode
  --output-format <fmt>      text | json | stream-json
  --system-prompt <text>     Override system prompt
  --add-dir <dir>            Additional directory for CLAUDE.md search
  --max-turns <n>            Maximum conversation turns
  --allowedTools <tools>     Comma-separated allowed tools
  --disallowedTools <tools>  Comma-separated denied tools
  --verbose, -v              Verbose output
  --debug, -d                Debug mode
  --version                  Show version (2.0.0-alpha.1)
  --help, -h                 Show help
```

`parseArgs(args)` returns a plain object. Unknown flags with `-` prefix are silently ignored; bare arguments become `result.prompt`.

---

## 9. Agents, Skills, Plugins

### 9.1 Agents — agents/loader.mjs + agents/parser.mjs

**Discovery paths** (loaded in order):
1. `<cwd>/.claude/agents/` (project-level)
2. `~/.claude/agents/` (user-global)

**Supported formats:**
- `.json` — plain JSON object: `{ name, description, model, tools, hooks, prompt }`
- `.md` — Markdown with YAML frontmatter:
  ```
  ---
  name: my-agent
  description: Does X
  model: claude-haiku-4-5
  tools: [Bash, Read]
  ---
  You are a specialized agent for X.
  ```

**`AgentLoader` API:**
- `load(cwd?)` — scans both paths
- `get(name)` — returns agent definition or null
- `list()` — all loaded agents
- `has(name)` — existence check

Agents are surfaced via `/agents` slash command and `Agent` tool's sub-agent spawning.

---

### 9.2 Skills — skills/loader.mjs + skills/runner.mjs

**Discovery paths:**
1. `<cwd>/.claude/skills/<name>/SKILL.md`
2. `~/.claude/skills/<name>/SKILL.md`

**SKILL.md format:**
```markdown
---
name: commit
description: Create a conventional commit
aliases: [git-commit, gc]
trigger: when the user wants to commit changes
---
Create a conventional commit message following the Conventional Commits spec.
Stage all changes and commit.

$ARGUMENTS
```

**`SkillsLoader` API:**
- `load(cwd?)` — scans both paths
- `get(name)` — exact match, then prefix match, then alias match
- `list()` — all loaded skills
- `run(name, args?)` — returns `[Skill: <name>]\n<prompt>` string

**Invocation:**
- REPL: `/<skillname> [args]` (if not a registered slash command)
- Tool: `Skill` tool with `{ skill: '<name>', args: '...' }`

---

### 9.3 Plugins — plugins/loader.mjs

```js
new PluginLoader(pluginDir?)
// Default pluginDir: ~/.claude/plugins/
```

**Plugin format:** directory containing `plugin.json` manifest:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "...",
  "tools": [...],
  "agents": [...],
  "skills": [...],
  "hooks": {...}
}
```

**Loading methods:**
- `loadFromDirectory(dir?)` — scans for `<dir>/<name>/plugin.json`
- `loadFromGit(repoUrl, name?)` — clones/updates a git repo and loads its manifest
- `getInstalledPlugins()` — list all loaded plugin manifests
- `removePlugin(name)` — deletes plugin directory and removes from registry

**Note:** Plugin loader is implemented but not automatically invoked during bootstrap (no `PluginLoader` instantiation in `index.mjs`). Must be wired manually.

---

### 9.4 Hooks — hooks/engine.mjs

```js
new HookEngine(hooksConfig)
```

**7 hook events:**

| Hook | When | Return value |
|------|------|--------------|
| `PreToolUse` | Before tool execution | `{ decision: 'allow'\|'deny', message? }` |
| `PostToolUse` | After tool execution | `{ modifiedResult? }` — can replace result |
| `PreToolUseFailure` | Tool validation failed | notification |
| `PostToolUseFailure` | Tool execution threw | notification |
| `Notification` | Fire-and-forget notifications | ignored |
| `Stop` | Before agent stops | `{ preventStop: true }` to continue |
| `SessionStart` | On session start | notification |

`PreToolUse` handler signature: `async (ctx) => { ... }` where `ctx = { toolName, input, result? }`.

If `PreToolUse` returns `{ decision: 'deny' }`, the tool is blocked and the agent receives the `message` as the tool result.

If `Stop` returns `{ preventStop: true }`, the loop injects `[System: A hook prevented stopping. Please continue with the task.]` and recurses.

---

## 10. Tests

**File:** `v2/test/test.mjs`  
**Run:** `npm test` → `node test/test.mjs`  
**Size:** 2083 lines  
**Assertions:** ~511 (via custom `assert/assertEqual/assertIncludes/assertType` helpers)  
**External dependencies:** none (zero npm deps for tests)

### Test Sections

| Section | Topics Covered |
|---------|---------------|
| Tool Registry (25+ tools) | Registration, 26 expected tools, validateInput, custom tool, MCP tool |
| Tool Execution | LS, Read, ReadMany, TodoWrite, WebSearch, ToolSearch, WebFetch, AskUser, SendMessage, RemoteTrigger, CronCreate/Delete/List, Skill, LSP, ReadMcpResource, ExitWorktree |
| Permission Checker | All 6 modes (bypass, plan, dontAsk, auto, acceptEdits, default) |
| Context Manager | Token counting, shouldCompact, microCompact, full compact, auto-addMessage, array content |
| Hook Engine | Empty hooks, blocking PreToolUse, result-modifying PostToolUse, Stop hook prevention, Notification hooks |
| Streaming | Text accumulation, tool_use parsing (JSON reassembly), thinking blocks |
| Agent Loop (mock) | Loop creation, state shape, run method, system prompt |
| MCP Client | Constructor, requestId, transport detection (stdio/ws/sse/streamable-http), explicit override |
| MCP Transports | Structural tests for SseTransport, StreamableHttpTransport, WebSocketTransport |
| Session Manager | SessionId format, dir path, save/resume, teleport export/import, clear |
| Checkpoint Manager | save/undo/list/clear, actual file restoration |
| Prompt Cache | applyCacheControl, updateStats, hitRate, reset |
| Agent Parser | JSON format, Markdown with frontmatter, plain Markdown fallback |
| Agent Loader | Empty dir, unknown agent |
| Skills Loader | Empty dir, SKILL.md parsing, name/description extraction, run(), unknown skill |
| Slash Commands (39) | Count >= 38, all expected commands present, handler/description types, individual command tests |
| StuckDetector | SAME_CALL_LOOP, THRASHING_LOOP, VOLUME_LIMIT, resetTurn, djb2 hash |
| Settings Schema | loadSettings, SETTINGS_SCHEMA structure |
| Env Vars | readEnv, getEnv, listEnvVars |
| CLI Args | All flags, bare argument, defaults |
| Telemetry | track, getStats |
| Cron Store | Creation/deletion via tool calls |
| MCP Transports (detailed) | URL storage, connection state |

### Coverage Gaps

- No integration tests (all tests mock the API layer)
- `callAnthropic/callOpenAI/callGoogle/callNvidia` are never exercised (no HTTP mocking)
- `inject-check.mjs` and `path-check.mjs` lack dedicated test sections (tested implicitly through PermissionChecker)
- `EnterWorktree` functional test skipped (requires git repo)
- `hooks/engine.mjs` has limited coverage — `PreToolUseFailure`, `PostToolUseFailure`, `SessionStart` events untested
- `plugins/loader.mjs` has no tests
- `agents/teams.mjs` has no tests
- `auth/oauth.mjs` has no tests
- `ui/app.mjs` (Ink TUI) has no tests
- `verify-write.mjs` has no tests
- `core/scheduler.mjs` has no tests

---

## 11. Known Problems

### 11.1 Loop Detection — `stuck-detector.mjs`

**What it does:** Detects `SAME_CALL_LOOP`, `THRASHING_LOOP`, and `VOLUME_LIMIT`.

**Problem:** The volume limit default is **20 tool calls per turn**. Legitimate workflows (bulk renames, large multi-file edits) can hit this limit and terminate unexpectedly. The limit is configurable via `settings.volumeLimit` but:
- There is no documentation of how to set this per-project
- The `StuckDetector` is instantiated with `settings.volumeLimit` in `createAgentLoop`, but `loadSettings()` / `SETTINGS_SCHEMA` do not expose `volumeLimit` as a named setting — it must be passed as a raw property

**Problem:** `SAME_CALL_LOOP` fires on 3 identical calls where results differ only in error message. Since `sameResult = a.result === b.result && b.result === c.result` is ORed with `anyFailed`, any repeated failing call (even with non-identical errors) triggers the abort.

### 11.2 Verify-After-Write — `verify-write.mjs`

**Problem:** Gated behind `settings.verifyWrites` which defaults to `false` — not set in `SETTINGS_SCHEMA`. Must be explicitly passed:
```js
createAgentLoop({ settings: { verifyWrites: true } })
```
Without it, the Write/Edit/MultiEdit post-write verification logic is entirely skipped even though the helper code exists. Since the default is `false`, write verification provides zero protection unless the caller opts in.

### 11.3 System Prompt Tool Discipline

**Problem:** The system prompt injects all 26 tool schemas into the Anthropic `tools` array and also as text in the prompt `staticPrefix`. For providers that don't support native tools (Bedrock stub, Vertex stub, or custom providers without tools), `state.systemPromptStatic` (the tool-free prefix) is available but whether it is used depends on the `callCustomProvider()` logic correctly choosing between `state.systemPrompt` and `state.systemPromptStatic`. The current agent-loop always passes `state.systemPrompt` for standard providers, regardless of whether those providers ignore the `tools` array format.

**Problem:** NVIDIA thinking models (Kimi K2.5, DeepSeek R1) under `NVIDIA_THINKING_MODE=true` have ALL tools stripped and get a workspace snapshot injection instead. This means **no tool calls are possible** for these models in thinking mode — the model is entirely dependent on the quality of the static snapshot for information.

### 11.4 Max-Iterations Guard

**Problem:** The `maxContinuationTurns` guard (default 100) only counts **continuation turns** (recursive tool-call turns), not total turns including user messages. A session can therefore last far longer than expected if the user sends many messages each triggering 99 continuation turns.

**Problem:** The `maxTurns` check (`settings.maxTurns && state.turnCount > settings.maxTurns`) is `undefined` / `falsy` by default (not in `SETTINGS_SCHEMA`), so the hard turn limit is never enforced unless explicitly configured.

### 11.5 Tool Failure Retry Logic

**Problem:** When a tool call fails with a validation error, the loop appends a nudge message:
```
[System: All tool call(s) above failed input validation. Review the required parameter
names for each tool and retry the tool call(s) immediately. ...]
```
This nudge is appended only when **all** tool calls in the batch fail. If only some fail, no nudge is added. The model may give up and summarize rather than correcting its arguments.

**Problem:** There is no per-tool retry limit — a model can attempt the same tool with wrong arguments indefinitely (until `SAME_CALL_LOOP` fires on the 3rd identical attempt). However, `SAME_CALL_LOOP` requires **identical** inputs. If the model varies its (still-wrong) inputs each time, no stuck detection triggers.

### 11.6 API Retry Logic (Dual Implementation)

**Problem:** There are **two separate retry systems**:
1. `agent-loop.mjs` inner retry loop — 3 retries, 30s base exponential backoff
2. `rate-limiter.mjs` `RateLimiter` class — used only inside `callCustomProvider()`

The main provider callers (`callAnthropic`, `callOpenAI`, `callGoogle`, `callNvidia`) do NOT use `RateLimiter`. Their retry logic is inline in the agent loop. This means the rate limiter class exists but is only active for custom providers, not the primary providers.

### 11.7 MCP Resource Tool Wiring

The `ReadMcpResource` tool's `_mcpClients` field is populated in `index.mjs`:
```js
const mcpResourceTool = tools.get('ReadMcpResource');
if (mcpResourceTool) mcpResourceTool._mcpClients = mcpClients;
```
This works only for the top-level agent. Sub-agents created via the `Agent` tool spawn a new `createAgentLoop` but receive the same `tools` registry instance — so `ReadMcpResource._mcpClients` is shared. However, if a sub-agent spawns further sub-agents, the MCP clients may not be available depending on how the registry is passed.

### 11.8 Plugin System Not Bootstrapped

`PluginLoader` in `plugins/loader.mjs` is fully implemented (directory scan, git clone, removal) but is **never instantiated** in `index.mjs`. Plugins cannot be loaded without manual wiring. No `/plugins` slash command exists.

### 11.9 Bedrock and Vertex Stubs

AWS Bedrock and Google Vertex AI providers are defined in `providers.mjs` with valid endpoint structures but their `authHeader()` methods return stub objects without actual signing logic (no SigV4, no GCP bearer token). Attempts to use these providers will fail with authentication errors.

### 11.10 `require()` in ESM Slash Commands

Several slash command handlers in `commands.mjs` use `require()` in an ESM module (`.mjs`):
```js
const { spawnSync } = require('child_process');  // /review, /diff, /commit
const fs = require('fs');                         // /init
const { cronStore } = require('../tools/cron-create.mjs'); // /schedule
```
`require()` is not available in native ESM. These commands will throw `ReferenceError: require is not defined` at runtime when invoked.

---

*Document generated from source analysis of `v2/` (86 source files, 2083-line test suite, ~511 assertions).*

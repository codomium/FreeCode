# open-claude-code v2 — Technical Guide

## What's New in v2.6 — agent reliability & tool improvements

### Mandatory Agent Reliability Rules (`system-prompt.mjs`)

Five hard rules are now injected into every system prompt:

- **Always act via tools** — text descriptions of actions are not acceptable when a tool call is required
- **Plan → Act → Verify** — every Write/Edit must be followed by a Read-back; run linter/tests when available
- **3-attempt budget** — after 3 failed attempts emit `BLOCKED: … | root cause: … | need: …` and stop
- **Root cause before fix** — read the file, capture the exact error, fix the root cause not symptoms
- **Forbidden behaviours** — claiming success without verification, retrying identical failing calls, outputting code in chat instead of calling Write/Edit

### Infinite-Loop Guard (`agent-loop.mjs`)

The last three tool calls (by `toolName + JSON(input)` key and result value) are tracked. If all three are identical the loop stops and emits `{ type: 'stuck' }`, preventing silent infinite loops.

### Edit / MultiEdit Verification (`verify-write.mjs`, `agent-loop.mjs`)

A new `verifyEdit(filePath, oldString, newString)` function reads the file back after every `Edit` and `MultiEdit` call and checks that `new_string` is present and `old_string` is gone. A `{ type: 'warning' }` event is emitted on failure. This extends the existing `Write` verification.

### HTML → Plain Text in WebFetch (`web-fetch.mjs`)

HTML responses are automatically stripped to plain text:
- `<script\b…</script\s*>` and `<style\b…</style\s*>` blocks removed first
- Block tags converted to newlines; remaining tags stripped
- HTML entities decoded with `String.fromCodePoint` (handles astral Unicode); `&amp;` decoded last
- New `raw_html: true` parameter opt-out

### Extended Glob Exclusions (`glob.mjs`)

`walkDir` now skips: `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `__pycache__`, `.cache`, `coverage`, `.nyc_output`, `.turbo`, `.venv`, `venv`, `.tox`, `vendor`, `target`, `.gradle` — in addition to the previous `node_modules`-only exclusion.

### LS Sorted Output (`ls.mjs`)

Entries are now sorted: directories first (alphabetical), then files (alphabetical).

### PDF Reader ESM Fix (`read.mjs`)

`require('child_process')` inside an ES module replaced with a top-level `import { spawnSync }`.

---

## What's New in v2.5 (agent-loop / core)

### 🎯 Session Goal Tracking

`agent-loop.mjs` now auto-extracts a session goal from the first user message and emits a `sessionGoal` event so UIs can display a sticky goal banner.

- The goal is injected into every **context compaction summary** so it survives long sessions
- Saved to `~/.freecode/sessions/<id>.json` alongside the conversation summary
- Restored on resume via `context-manager.mjs` — `sessionGoal` is a first-class field in compaction state

### 🤖 Strict Agent Execution Protocol (`system-prompt.mjs`)

A mandatory discipline section has been added to the system prompt:

```
EXPLORE → PLAN → ACT → VERIFY → REPORT
```

| Rule | Detail |
|------|--------|
| Post-write read-back | After every file write, read the file back to confirm content |
| 3-attempt cap | If a fix fails 3 times, STOP and report the blocker with evidence |
| Loop detection | If the same action is repeated with the same outcome, propose a different approach |
| Evidence required | Never claim success without actual output (e.g. `eslint: 0 errors ✓`) |
| No placeholders | Never write `// TODO: implement this` or stub functions |

---

## What's New in v2.3 (agent-loop / core)

### Transparent 429 / Rate-Limit Retry

`agent-loop.mjs` now wraps every provider API call in an inner **retry loop**:

- Catches `429`, `503`, `502`, `504`, overload, and quota errors
- Retries up to **3 times** — conversation state is unchanged between attempts
- Exponential back-off: 30 s → 60 s → 120 s; `Retry-After` header is forwarded as `.retryAfterSeconds` on the thrown `Error` and honoured
- Emits `{ type: 'retrying', attempt, maxAttempts, delaySeconds }` so UIs can show a countdown
- Applies to all callers: `callAnthropic`, `callOpenAI`, `callGoogle`, `callNvidia`, `callCustomProvider`

### Large-File Diff Fix (`computeDiff` fallback)

The `computeDiff` helper is used by both UI front-ends (Electron and VS Code extension) to build the red/green diff view when the agent edits a file.

Previously, when `aLines.length × bLines.length > 400 000` (large files), the fallback returned `bLines.map(l => ({ type: 'add', line: l }))` — marking every line in the new file as added, even if only 3 lines changed.

The new fallback uses a **hash-based patience-diff approximation**:
1. Builds a `Map<line, positions[]>` for the new file
2. Greedily maps old-file lines to their first unused position in the new file
3. Emits `equal` for matched pairs, `remove` for unmatched old lines, `add` for unmatched new lines

This runs in O(n + m) time and produces correct context/add/remove classification.

---

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node src/index.mjs "hello"          # one-shot
node src/index.mjs                   # interactive REPL
node src/index.mjs -m claude-opus-4-6 -p "explain this"  # print mode
```

## Architecture

```
v2/src/
├── core/                    # Core engine
│   ├── agent-loop.mjs       # Async generator (13 event types, recursive)
│   ├── streaming.mjs        # SSE handler (all event types)
│   ├── context-manager.mjs  # Token tracking + compaction
│   ├── system-prompt.mjs    # CLAUDE.md loading + cache boundary
│   ├── session.mjs          # Save/resume/teleport
│   ├── checkpoints.mjs      # File checkpointing + undo
│   ├── cache.mjs            # Prompt caching
│   ├── rate-limiter.mjs     # 429/529 handling + backoff
│   ├── providers.mjs        # 5 AI providers
│   └── scheduler.mjs        # Cron task scheduling
├── tools/                   # 25 tools
│   ├── registry.mjs         # validateInput/call interface
│   ├── bash.mjs             # Shell (async-generator streaming, stdin injection, timeout, background)
│   ├── read.mjs             # File read (PDF, binary detect, line nums)
│   ├── edit.mjs             # Edit (replace_all, uniqueness check)
│   ├── write.mjs            # Write (mkdir, overwrite protection)
│   ├── glob.mjs             # Glob (proper matching, mtime sort)
│   ├── grep.mjs             # Grep (-i/-n/-A/-B/-C, ripgrep)
│   ├── agent.mjs            # Subagent (worktree, background, model)
│   ├── web-fetch.mjs        # URL fetch
│   ├── web-search.mjs       # Web search
│   ├── todo-write.mjs       # Task management
│   ├── notebook-edit.mjs    # Jupyter notebooks
│   ├── multi-edit.mjs       # Atomic multi-file edits
│   ├── ls.mjs               # Directory listing
│   ├── tool-search.mjs      # Deferred tool discovery
│   ├── ask-user.mjs         # User prompts
│   ├── skill.mjs            # Skill invocation
│   ├── send-message.mjs     # Agent team messaging
│   ├── cron-create.mjs      # Scheduled tasks
│   ├── cron-delete.mjs
│   ├── cron-list.mjs
│   ├── enter-worktree.mjs   # Git worktree
│   ├── exit-worktree.mjs
│   ├── remote-trigger.mjs   # Remote execution
│   ├── lsp.mjs              # Language server
│   └── read-mcp-resource.mjs
├── mcp/                     # MCP protocol
│   ├── client.mjs           # JSON-RPC client
│   ├── transport-sse.mjs    # SSE transport
│   ├── transport-shttp.mjs  # Streamable HTTP
│   └── transport-ws.mjs     # WebSocket
├── permissions/              # Security
│   ├── checker.mjs          # 6 modes + interactive prompts (supports promptCallback for UI integration)
│   ├── sandbox.mjs          # bubblewrap/seatbelt
│   ├── injection-check.mjs  # Command injection detection
│   ├── path-check.mjs       # File path validation
│   └── prompt.mjs           # Permission prompting
├── hooks/
│   └── engine.mjs           # PreToolUse/PostToolUse/Stop/Notification
├── agents/
│   ├── loader.mjs           # Agent definition loader
│   ├── parser.mjs           # JSON/MD frontmatter parser
│   └── teams.mjs            # Multi-agent teams
├── skills/
│   ├── loader.mjs           # Skill discovery
│   └── runner.mjs           # Skill execution
├── plugins/
│   └── loader.mjs           # Plugin discovery + git clone
├── auth/
│   └── oauth.mjs            # PKCE OAuth flow
├── config/
│   ├── settings.mjs         # 4-source deep merge
│   ├── cli-args.mjs         # All CLI flags
│   └── env.mjs              # 104 env vars
├── ui/
│   ├── repl.mjs             # Interactive REPL
│   ├── ink-app.mjs          # Rich terminal output
│   └── commands.mjs         # 40 slash commands
├── telemetry/
│   └── index.mjs            # Telemetry stub
└── index.mjs                # Entry point

test/
└── test.mjs                 # 1,581 tests
```

## Stats

| Metric | Value |
|--------|:-----:|
| Source files | 61 |
| Lines of code | 8,314 |
| Tests | 1,581 (0 failures) |
| Tools | 25 |
| Slash commands | 40 |
| MCP transports | 4 |
| AI providers | 5 |
| Env vars | 104 |
| Permission modes | 6 |

## Tests

```bash
node test/test.mjs
# Tests: 1581 total, 1581 passed, 0 failed
```

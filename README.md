# FreeCode

An open-source, **VS Code-inspired AI coding assistant** with full tool access — read files, edit code, run commands, search the web, and more.  Runs everywhere: as a VS Code extension, a standalone Windows desktop app, or a Node.js CLI.

---

## Repository layout

| Directory | What it is |
|-----------|-----------|
| [`vscode-extension/`](./vscode-extension/README.md) | VS Code extension — Cursor-style sidebar chat panel + `@claude` chat participant |
| [`electron-app/`](./electron-app/README.md) | Standalone Windows 11 desktop app built with Electron |
| [`v2/`](./v2/README.md) | Agent loop CLI library — the engine used by both front-ends |

---

## What's New in v2.2

### 🔌 Custom Providers — Add Any OpenAI-Compatible API

Open the **Settings panel** (⚙ button) and scroll to **Custom Providers** to add any OpenAI-compatible endpoint — NVIDIA NIM, OpenRouter, local LLMs, etc.

Each provider supports:
- **Provider ID** — unique internal key (e.g. `nvidia-kimi`)
- **Display Name** — shown in the model selector
- **Base URL** — e.g. `https://integrate.api.nvidia.com/v1`
- **API Key** — stored in app settings
- **Models** — one per line in `id:Display Name` format
- **Headers** — optional extra HTTP headers (e.g. `Accept:text/event-stream`)

Custom provider models appear automatically in both the header model dropdown and the settings model selector.  The agent loop routes requests to the correct endpoint without any restart.

**Example providers:**

| Provider | Base URL | Notes |
|----------|----------|-------|
| NVIDIA Kimi | `https://integrate.api.nvidia.com/v1` | `moonshotai/kimi-k2.5` |
| NVIDIA Qwen | `https://integrate.api.nvidia.com/v1` | `qwen/qwen3-coder-480b-a35b-instruct` |
| OpenRouter | `https://openrouter.ai/api/v1` | any model slug |

### 📋 Plan Board — TodoWrite Integration & Execution Enforcement

The plan board now stays in sync with the agent's own `TodoWrite` tool calls:

- **Auto-sync** — when the agent calls `TodoWrite`, the plan board updates immediately to reflect pending / in-progress / completed items
- **Execution directive** — every message that includes an active plan now injects an explicit instruction telling the agent to use `Read/Write/Edit/Bash/MultiEdit` tools for each step and call `TodoWrite` after completion — preventing the agent from narrating instead of acting

### 🤝 Multi-Agents Mode — Team-Based Collaborative Execution

The `Agent` tool now supports a **team** parameter that runs multiple specialized agents through configurable **phases**:

```json
{
  "prompt": "Add authentication to the API",
  "team": [
    { "role": "planner" },
    { "role": "coder", "model": "gpt-4o" },
    { "role": "reviewer" }
  ],
  "phases": ["planning", "implementation", "review"]
}
```

Built-in agent roles:

| Role | Behaviour |
|------|-----------|
| `coder` | Implements changes using file tools |
| `reviewer` | Reviews code for bugs and improvements |
| `researcher` | Finds and summarizes information |
| `tester` | Writes and runs tests |
| `planner` | Breaks tasks into numbered steps |
| `summarizer` | Produces concise progress summaries |
| `prompter` | Generates precise prompts for other agents |

Each agent's output is fed as shared context to the next, creating a collaborative pipeline.  Results are structured by phase so you can see exactly what each agent contributed.

### 🧠 Context Retention — Session Persistence

A new session persistence layer saves conversation summaries to `~/.freecode/sessions/`:

- **`persistSession(messages, sessionId)`** — saves a structured summary (files edited, tools used, key exchanges) to disk
- **`injectSavedContext(messages, sessionId)`** — prepends the saved summary as the first message when resuming, so the agent instantly knows what was done before
- **`buildSessionSummary(messages)`** — produces a human-readable summary from any message array, useful for hand-off between agents

### 🛡️ MultiEdit Validation Hardening

The `MultiEdit` tool now enforces **all three** invariants before writing any file:

1. Every edit must have a `file_path`
2. Every edit must have an `old_string`
3. Every edit must have a `new_string`
4. `old_string` must differ from `new_string`

This prevents silent no-ops and corrupted edits that force full-file recreation.

---

## What's New in v2.1

### 🏷️ Mode Badge in Agent Responses

Every assistant message header now shows a **color-coded mode badge** (e.g. `[plan]`, `[auto]`, `[bypass]`) next to the "Claude" name so you always know which permission mode was active when a response was generated.

### 📋 Plan Mode — Cursor-Style To-Do Board

Switching to **plan** mode reveals a persistent task board above the chat input:

- **Auto-populated** — when the agent replies with a numbered or bulleted list in plan mode, items are automatically parsed and added to the board
- **Progress tracking** — the first uncompleted item is marked *in progress* while the agent works; items are checked off when each step completes
- **Manual control** — add, check/uncheck, and remove tasks by hand at any time
- **Always-visible context** — the board persists across mode changes so you can track agent progress in real time
- Active plan items are automatically injected into every prompt so the agent stays on track

### 🔐 Default Mode — Interactive Permission Prompts

The `default` permission mode now actually asks before acting instead of silently approving everything. When the agent wants to edit a file or run a command, a **permission card** appears with:

- The tool and file/command being requested
- **✓ Allow** — lets the action proceed
- **✗ Deny** — blocks the action and tells the agent it was denied

### 📌 Persistent Mode Description Bar

The mode description bar no longer auto-dismisses after 5 seconds. It stays visible until you close it with the **✕** button, so you always have a reminder of what the current mode does. It also appears automatically on startup.

### ⌨️ `/mode` Slash Command

Type `/mode` in the chat input to see all five permission modes and their descriptions listed in the autocomplete dropdown — no more guessing what each mode does.

### 🐛 Bug Fixes

- **`acceptEdits` Bash** — Bash commands now run in `acceptEdits` mode without being blocked
- **Diff tab race condition** — agent-edited files always open a diff tab, even when the file-read response arrives after the edit completes
- **New file diffs** — when the agent creates a brand-new file it now opens in a diff tab showing the full new content

---

## What's New in v2.0

### 🗂️ 3-Column IDE Layout (Electron app)

The Electron app has been completely redesigned into a **VS Code-inspired 3-column IDE layout**:

```
┌──────────────────────────────────────────────────────────────┐
│  ✦ FreeCode  [session]  [Model ▾] [Mode ▾]  [History] [⚙]  │  ← Titlebar
├─────────────────┬──────────────────────┬─────────────────────┤
│   CHAT (left)   │  EDITOR (middle)     │  EXPLORER (right)   │
│                 │                      │                      │
│  messages       │  [tab][tab][tab ✕]   │  WORKSPACE/          │
│  ...            │  ──────────────────  │  ▶ src/              │
│  tool cards     │  syntax-highlighted  │    ├ main.js         │
│                 │  file content        │    └ preload.js      │
│  ─────────────  │  OR diff view        │  ▶ renderer/         │
│  [input area]   │                      │    ├ index.html      │
│  [stats bar]    │  [✓ Accept][✗ Reject]│    └ chat.js         │
│                 │  (on diff tabs)      │                      │
│                 │                      │  [+File][+Folder][↺] │
└─────────────────┴──────────────────────┴─────────────────────┘
   ↑ drag to resize ↑                  ↑ drag to resize ↑
```

- **Draggable resize handles** between each column (persisted across restarts)
- **Panel collapse**: `Ctrl+B` hides/shows the chat column; `Ctrl+Shift+E` toggles the explorer

### 📑 Editor Tabs (middle column)

- Click any file in the Explorer to open it in the editor panel
- Multiple tabs with **×** close buttons — `Ctrl+W` closes the active tab
- Tabs persist file content and diff state independently

### ⚡ Diff View with Accept / Reject

When the agent edits a file a **diff tab opens automatically**:

- 🔴 Removed lines in red, 🟢 added lines in green
- **✓ Accept** — keeps the new content and converts to a normal view
- **✗ Reject** — writes the original content back via `writeFile` IPC and closes the diff tab

### 🔗 Clickable File Links in Chat

File names and paths that the agent mentions in its replies are automatically rendered as **clickable links** (shown with an accent-coloured border):

- Click any inline path like `` `renderer/chat.js` `` → opens the file in the editor panel
- If the agent **just edited** that file, clicking it jumps straight to the **diff tab** so you can see exactly what changed
- Works for relative paths (resolved against the current workspace), absolute paths, and plain filenames with known extensions

### 🖱️ File Explorer Context Menu

Right-click any file or folder to get:

| Action | Description |
|--------|-------------|
| Open in Editor | Opens the file in a new editor tab |
| New File | Prompts for a name and creates an empty file |
| New Folder | Prompts for a name and creates a directory |
| Rename | Renames the entry in-place |
| Delete | Confirms then permanently deletes |
| Copy Path | Copies the absolute path to the clipboard |
| Add to Chat Context | Injects the file into the active chat prompt |

### ⌨️ New Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle chat panel (left column) |
| `Ctrl+Shift+E` | Toggle file explorer (right column) |
| `Ctrl+W` | Close the active editor tab |

---

## What's New in v1.6

### ⚙️ In-app Settings Panel (Electron app)

The Electron app now has a full **Settings Panel** accessible via the ⚙ button in the header — no more opening the raw userData folder. Configure everything from one place:

- **Workspace folder** — browse and change your project directory
- **Model & Agent** — model selector, permission mode, max turns, show/hide tool output toggle
- **API Keys** — set or update Anthropic/OpenAI/Google and NVIDIA NIM keys in-app
- **Custom Providers** — add any OpenAI-compatible endpoint with models and headers
- **About** — link to GitHub and quick access to your data folder

### 📁 File Explorer (Electron app)

A new **Files** button in the header opens a collapsible file-tree panel showing your workspace directory:

- Expand/collapse folders with a click
- Click any file to open it in the built-in file viewer
- **+** button on hover adds any file directly to the agent's context

### 👁️ File Viewer (Electron app)

Click a file in the explorer to open it in a modal viewer with:

- Full file content rendered in a monospace font
- **Add to Context** button — instantly injects the file into the current chat prompt
- 500 KB size guard to keep the UI responsive

---

## What's New in v1.5

### ✏️ Edit diff view — see every file change highlighted

When the agent edits a file the tool card **auto-expands** and shows a full red/green diff, just like VS Code's built-in diff viewer:

- 🔴 Removed lines highlighted in red with a strikethrough
- 🟢 Added lines highlighted in green
- Computed from `old_string` vs `new_string` so you always know exactly what changed

### 📄 Read tool — line-range in header

The Read tool card now shows `filename.js · lines 1–50` in the header so you can see at a glance exactly which part of a file the agent inspected.

### ⚡ Bash live streaming + interactive stdin

- **Live output** — Bash output streams token-by-token to the tool card while the process runs instead of appearing only after it finishes.
- **Interactive stdin** — while a command is running an input bar appears at the bottom of the card.  Type and press **↵ Send** (or Enter) to send text to the process's standard input — perfect for CLIs that prompt for confirmation, passwords, or answers.

---

## Quick Start

### VS Code extension

```bash
cd vscode-extension
npm install
npm run package          # builds open-claude-code-1.5.0.vsix
code --install-extension open-claude-code-1.5.0.vsix
```

Set your API key: **Open Claude Code: Set API Key** in the Command Palette.

### Standalone Windows app

```powershell
cd electron-app
npm install
npm start
```


### 🏷️ Mode Badge in Agent Responses

Every assistant message header now shows a **color-coded mode badge** (e.g. `[plan]`, `[auto]`, `[bypass]`) next to the "Claude" name so you always know which permission mode was active when a response was generated.

### 📋 Plan Mode — Cursor-Style To-Do Board

Switching to **plan** mode reveals a persistent task board above the chat input:

- **Auto-populated** — when the agent replies with a numbered or bulleted list in plan mode, items are automatically parsed and added to the board
- **Progress tracking** — the first uncompleted item is marked *in progress* while the agent works; items are checked off when each step completes
- **Manual control** — add, check/uncheck, and remove tasks by hand at any time
- **Always-visible context** — the board persists across mode changes so you can track agent progress in real time
- Active plan items are automatically injected into every prompt so the agent stays on track

### 🔐 Default Mode — Interactive Permission Prompts

The `default` permission mode now actually asks before acting instead of silently approving everything. When the agent wants to edit a file or run a command, a **permission card** appears with:

- The tool and file/command being requested
- **✓ Allow** — lets the action proceed
- **✗ Deny** — blocks the action and tells the agent it was denied

### 📌 Persistent Mode Description Bar

The mode description bar no longer auto-dismisses after 5 seconds. It stays visible until you close it with the **✕** button, so you always have a reminder of what the current mode does. It also appears automatically on startup.

### ⌨️ `/mode` Slash Command

Type `/mode` in the chat input to see all five permission modes and their descriptions listed in the autocomplete dropdown — no more guessing what each mode does.

### 🐛 Bug Fixes

- **`acceptEdits` Bash** — Bash commands now run in `acceptEdits` mode without being blocked
- **Diff tab race condition** — agent-edited files always open a diff tab, even when the file-read response arrives after the edit completes
- **New file diffs** — when the agent creates a brand-new file it now opens in a diff tab showing the full new content

---

## What's New in v2.0

### 🗂️ 3-Column IDE Layout (Electron app)

The Electron app has been completely redesigned into a **VS Code-inspired 3-column IDE layout**:

```
┌──────────────────────────────────────────────────────────────┐
│  ✦ FreeCode  [session]  [Model ▾] [Mode ▾]  [History] [⚙]  │  ← Titlebar
├─────────────────┬──────────────────────┬─────────────────────┤
│   CHAT (left)   │  EDITOR (middle)     │  EXPLORER (right)   │
│                 │                      │                      │
│  messages       │  [tab][tab][tab ✕]   │  WORKSPACE/          │
│  ...            │  ──────────────────  │  ▶ src/              │
│  tool cards     │  syntax-highlighted  │    ├ main.js         │
│                 │  file content        │    └ preload.js      │
│  ─────────────  │  OR diff view        │  ▶ renderer/         │
│  [input area]   │                      │    ├ index.html      │
│  [stats bar]    │  [✓ Accept][✗ Reject]│    └ chat.js         │
│                 │  (on diff tabs)      │                      │
│                 │                      │  [+File][+Folder][↺] │
└─────────────────┴──────────────────────┴─────────────────────┘
   ↑ drag to resize ↑                  ↑ drag to resize ↑
```

- **Draggable resize handles** between each column (persisted across restarts)
- **Panel collapse**: `Ctrl+B` hides/shows the chat column; `Ctrl+Shift+E` toggles the explorer

### 📑 Editor Tabs (middle column)

- Click any file in the Explorer to open it in the editor panel
- Multiple tabs with **×** close buttons — `Ctrl+W` closes the active tab
- Tabs persist file content and diff state independently

### ⚡ Diff View with Accept / Reject

When the agent edits a file a **diff tab opens automatically**:

- 🔴 Removed lines in red, 🟢 added lines in green
- **✓ Accept** — keeps the new content and converts to a normal view
- **✗ Reject** — writes the original content back via `writeFile` IPC and closes the diff tab

### 🔗 Clickable File Links in Chat

File names and paths that the agent mentions in its replies are automatically rendered as **clickable links** (shown with an accent-coloured border):

- Click any inline path like `` `renderer/chat.js` `` → opens the file in the editor panel
- If the agent **just edited** that file, clicking it jumps straight to the **diff tab** so you can see exactly what changed
- Works for relative paths (resolved against the current workspace), absolute paths, and plain filenames with known extensions

### 🖱️ File Explorer Context Menu

Right-click any file or folder to get:

| Action | Description |
|--------|-------------|
| Open in Editor | Opens the file in a new editor tab |
| New File | Prompts for a name and creates an empty file |
| New Folder | Prompts for a name and creates a directory |
| Rename | Renames the entry in-place |
| Delete | Confirms then permanently deletes |
| Copy Path | Copies the absolute path to the clipboard |
| Add to Chat Context | Injects the file into the active chat prompt |

### ⌨️ New Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle chat panel (left column) |
| `Ctrl+Shift+E` | Toggle file explorer (right column) |
| `Ctrl+W` | Close the active editor tab |

---

## What's New in v1.6

### ⚙️ In-app Settings Panel (Electron app)

The Electron app now has a full **Settings Panel** accessible via the ⚙ button in the header — no more opening the raw userData folder. Configure everything from one place:

- **Workspace folder** — browse and change your project directory
- **Model & Agent** — model selector, permission mode, max turns, show/hide tool output toggle
- **API Keys** — set or update Anthropic/OpenAI/Google and NVIDIA NIM keys in-app
- **About** — link to GitHub and quick access to your data folder

### 📁 File Explorer (Electron app)

A new **Files** button in the header opens a collapsible file-tree panel showing your workspace directory:

- Expand/collapse folders with a click
- Click any file to open it in the built-in file viewer
- **+** button on hover adds any file directly to the agent's context

### 👁️ File Viewer (Electron app)

Click a file in the explorer to open it in a modal viewer with:

- Full file content rendered in a monospace font
- **Add to Context** button — instantly injects the file into the current chat prompt
- 500 KB size guard to keep the UI responsive

---

## What's New in v1.5

### ✏️ Edit diff view — see every file change highlighted

When the agent edits a file the tool card **auto-expands** and shows a full red/green diff, just like VS Code's built-in diff viewer:

- 🔴 Removed lines highlighted in red with a strikethrough
- 🟢 Added lines highlighted in green
- Computed from `old_string` vs `new_string` so you always know exactly what changed

### 📄 Read tool — line-range in header

The Read tool card now shows `filename.js · lines 1–50` in the header so you can see at a glance exactly which part of a file the agent inspected.

### ⚡ Bash live streaming + interactive stdin

- **Live output** — Bash output streams token-by-token to the tool card while the process runs instead of appearing only after it finishes.
- **Interactive stdin** — while a command is running an input bar appears at the bottom of the card.  Type and press **↵ Send** (or Enter) to send text to the process's standard input — perfect for CLIs that prompt for confirmation, passwords, or answers.

---

## Quick Start

### VS Code extension

```bash
cd vscode-extension
npm install
npm run package          # builds open-claude-code-1.5.0.vsix
code --install-extension open-claude-code-1.5.0.vsix
```

Set your API key: **Open Claude Code: Set API Key** in the Command Palette.

### Standalone Windows app

```powershell
cd electron-app
npm install
npm start
```

### CLI (Node.js)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd v2
node src/index.mjs "explain this codebase"
```

---

## Supported AI Providers

| Provider | Environment variable | Notes |
|----------|---------------------|-------|
| **Anthropic** (recommended) | `ANTHROPIC_API_KEY` | All Claude models |
| **OpenAI** | `OPENAI_API_KEY` | GPT-4o, o1, o3 |
| **Google** | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Gemini 2.0 |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | Kimi K2.5, Qwen, Llama, DeepSeek R1 |
| **Custom** | Stored in settings | Any OpenAI-compatible endpoint |

Add custom providers (OpenRouter, local LLMs, NVIDIA Kimi, NVIDIA Qwen, etc.) directly from the **Settings panel** without touching environment variables.

---

## Tools

The agent has access to **25+ built-in tools**:

| Category | Tools |
|----------|-------|
| Files | Read, Write, Edit, MultiEdit, Glob, Grep, LS, NotebookEdit |
| Shell | **Bash** (live streaming, interactive stdin, background jobs) |
| Web | WebFetch, WebSearch |
| Agents | **Agent** (sub-agents, team/multi-agent, phases), Skill, SendMessage, RemoteTrigger |
| Tasks | TodoWrite, CronCreate, CronDelete, CronList |
| Dev | LSP, EnterWorktree, ExitWorktree |
| User | AskUser |
| Discovery | ToolSearch, ReadMcpResource |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  VS Code Extension / Electron App / CLI                  │
│  (chat.js + chat.css — same UI in all three front-ends)  │
└──────────────────────┬───────────────────────────────────┘
                       │  events (stream_event, tool_progress,
                       │          tool_meta, tool_stream, result, …)
                       ▼
            v2/src/core/agent-loop.mjs
            (async generator — 13 event types)
                       │
          ┌────────────┴────────────┐
          │                         │
   v2/src/tools/          v2/src/permissions/
   (25+ tools)            (6 modes + interactive prompts)
          │
   Anthropic / OpenAI / Google / NVIDIA / Custom API
```

The **VS Code extension** spawns `agent-bridge.mjs` as a Node.js subprocess.
The **Electron app** imports the agent loop in-process (no subprocess needed — the Electron binary is not Node.js).

---

## License

MIT


### 🗂️ 3-Column IDE Layout (Electron app)

The Electron app has been completely redesigned into a **VS Code-inspired 3-column IDE layout**:

```
┌──────────────────────────────────────────────────────────────┐
│  ✦ FreeCode  [session]  [Model ▾] [Mode ▾]  [History] [⚙]  │  ← Titlebar
├─────────────────┬──────────────────────┬─────────────────────┤
│   CHAT (left)   │  EDITOR (middle)     │  EXPLORER (right)   │
│                 │                      │                      │
│  messages       │  [tab][tab][tab ✕]   │  WORKSPACE/          │
│  ...            │  ──────────────────  │  ▶ src/              │
│  tool cards     │  syntax-highlighted  │    ├ main.js         │
│                 │  file content        │    └ preload.js      │
│  ─────────────  │  OR diff view        │  ▶ renderer/         │
│  [input area]   │                      │    ├ index.html      │
│  [stats bar]    │  [✓ Accept][✗ Reject]│    └ chat.js         │
│                 │  (on diff tabs)      │                      │
│                 │                      │  [+File][+Folder][↺] │
└─────────────────┴──────────────────────┴─────────────────────┘
   ↑ drag to resize ↑                  ↑ drag to resize ↑
```

- **Draggable resize handles** between each column (persisted across restarts)
- **Panel collapse**: `Ctrl+B` hides/shows the chat column; `Ctrl+Shift+E` toggles the explorer

### 📑 Editor Tabs (middle column)

- Click any file in the Explorer to open it in the editor panel
- Multiple tabs with **×** close buttons — `Ctrl+W` closes the active tab
- Tabs persist file content and diff state independently

### ⚡ Diff View with Accept / Reject

When the agent edits a file a **diff tab opens automatically**:

- 🔴 Removed lines in red, 🟢 added lines in green
- **✓ Accept** — keeps the new content and converts to a normal view
- **✗ Reject** — writes the original content back via `writeFile` IPC and closes the diff tab

### 🔗 Clickable File Links in Chat

File names and paths that the agent mentions in its replies are automatically rendered as **clickable links** (shown with an accent-coloured border):

- Click any inline path like `` `renderer/chat.js` `` → opens the file in the editor panel
- If the agent **just edited** that file, clicking it jumps straight to the **diff tab** so you can see exactly what changed
- Works for relative paths (resolved against the current workspace), absolute paths, and plain filenames with known extensions

### 🖱️ File Explorer Context Menu

Right-click any file or folder to get:

| Action | Description |
|--------|-------------|
| Open in Editor | Opens the file in a new editor tab |
| New File | Prompts for a name and creates an empty file |
| New Folder | Prompts for a name and creates a directory |
| Rename | Renames the entry in-place |
| Delete | Confirms then permanently deletes |
| Copy Path | Copies the absolute path to the clipboard |
| Add to Chat Context | Injects the file into the active chat prompt |

### ⌨️ New Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle chat panel (left column) |
| `Ctrl+Shift+E` | Toggle file explorer (right column) |
| `Ctrl+W` | Close the active editor tab |

---

## What's New in v1.6

### ⚙️ In-app Settings Panel (Electron app)

The Electron app now has a full **Settings Panel** accessible via the ⚙ button in the header — no more opening the raw userData folder. Configure everything from one place:

- **Workspace folder** — browse and change your project directory
- **Model & Agent** — model selector, permission mode, max turns, show/hide tool output toggle
- **API Keys** — set or update Anthropic/OpenAI/Google and NVIDIA NIM keys in-app
- **About** — link to GitHub and quick access to your data folder

### 📁 File Explorer (Electron app)

A new **Files** button in the header opens a collapsible file-tree panel showing your workspace directory:

- Expand/collapse folders with a click
- Click any file to open it in the built-in file viewer
- **+** button on hover adds any file directly to the agent's context

### 👁️ File Viewer (Electron app)

Click a file in the explorer to open it in a modal viewer with:

- Full file content rendered in a monospace font
- **Add to Context** button — instantly injects the file into the current chat prompt
- 500 KB size guard to keep the UI responsive

---

## What's New in v1.5

### ✏️ Edit diff view — see every file change highlighted

When the agent edits a file the tool card **auto-expands** and shows a full red/green diff, just like VS Code's built-in diff viewer:

- 🔴 Removed lines highlighted in red with a strikethrough
- 🟢 Added lines highlighted in green
- Computed from `old_string` vs `new_string` so you always know exactly what changed

### 📄 Read tool — line-range in header

The Read tool card now shows `filename.js · lines 1–50` in the header so you can see at a glance exactly which part of a file the agent inspected.

### ⚡ Bash live streaming + interactive stdin

- **Live output** — Bash output streams token-by-token to the tool card while the process runs instead of appearing only after it finishes.
- **Interactive stdin** — while a command is running an input bar appears at the bottom of the card.  Type and press **↵ Send** (or Enter) to send text to the process's standard input — perfect for CLIs that prompt for confirmation, passwords, or answers.

---

## Quick Start

### VS Code extension

```bash
cd vscode-extension
npm install
npm run package          # builds open-claude-code-1.5.0.vsix
code --install-extension open-claude-code-1.5.0.vsix
```

Set your API key: **Open Claude Code: Set API Key** in the Command Palette.

### Standalone Windows app

```powershell
cd electron-app
npm install
npm start
```

### CLI (Node.js)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd v2
node src/index.mjs "explain this codebase"
```

---

## Supported AI Providers

| Provider | Environment variable |
|----------|---------------------|
| **Anthropic** (recommended) | `ANTHROPIC_API_KEY` |
| **OpenAI** | `OPENAI_API_KEY` |
| **Google** | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |
| **NVIDIA NIM** | `NVIDIA_API_KEY` |

---

## Tools

The agent has access to **25+ built-in tools**:

| Category | Tools |
|----------|-------|
| Files | Read, Write, Edit, MultiEdit, Glob, Grep, LS, NotebookEdit |
| Shell | **Bash** (live streaming, interactive stdin, background jobs) |
| Web | WebFetch, WebSearch |
| Agents | Agent (sub-agents), Skill, SendMessage, RemoteTrigger |
| Tasks | TodoWrite, CronCreate, CronDelete, CronList |
| Dev | LSP, EnterWorktree, ExitWorktree |
| User | AskUser |
| Discovery | ToolSearch, ReadMcpResource |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  VS Code Extension / Electron App / CLI                  │
│  (chat.js + chat.css — same UI in all three front-ends)  │
└──────────────────────┬───────────────────────────────────┘
                       │  events (stream_event, tool_progress,
                       │          tool_meta, tool_stream, result, …)
                       ▼
            v2/src/core/agent-loop.mjs
            (async generator — 13 event types)
                       │
          ┌────────────┴────────────┐
          │                         │
   v2/src/tools/          v2/src/permissions/
   (25 tools)             (6 modes + hooks)
          │
   Anthropic / OpenAI / Google / NVIDIA API
```

The **VS Code extension** spawns `agent-bridge.mjs` as a Node.js subprocess.
The **Electron app** imports the agent loop in-process (no subprocess needed — the Electron binary is not Node.js).

---

## License

MIT

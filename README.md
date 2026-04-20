# freeCode

> **Freedom to code. Built for vibe coders. 🚀**  
> Professional architecture · Agentic superpowers · Better than Cursor

An open-source, **VS Code-inspired AI coding assistant** with full tool access — read files, edit code, run commands, search the web, and more.  Runs everywhere: as a VS Code extension, a standalone Windows desktop app, or a Node.js CLI.

---

## Repository layout

| Directory | What it is |
|-----------|-----------|
| [`vscode-extension/`](./vscode-extension/README.md) | VS Code extension — Cursor-style sidebar chat panel + `@claude` chat participant |
| [`electron-app/`](./electron-app/README.md) | Standalone Windows 11 desktop app built with Electron |
| [`v2/`](./v2/README.md) | Agent loop CLI library — the engine used by both front-ends |

---

## What's New in v2.4 — vibe-coder edition 🎉

### 🎤 Voice Input

Click the **🎤** mic button in the input bar to dictate your prompt using the browser's Web Speech API.

- Click once to **start recording**, click again (or wait) to stop
- **Interim transcription** streams live into the input field as you speak — you see the words appear in real time
- Pulsing **red glow animation** while recording so you always know the mic is active
- Button is automatically hidden on browsers/OSes that don't support the Speech API — no broken UI

### 📝 File-Change Watcher Toast

When any file you've opened in the editor (or added to context) is modified externally — by another process, `git pull`, or a background tool — a **toast notification** slides up from the bottom of the screen:

```
📝 server.js was modified externally   [Re-read]  [✕]
```

- **Re-read** — instantly re-adds the file to the context chips so the agent has the latest content
- Auto-dismisses after 8 seconds if you ignore it
- Zero configuration — freeCode watches the workspace continuously

### ❌ Tool Error — Inject Error as Context

When an agent tool call fails (file not found, `old_string` mismatch, shell error, etc.), the tool card now:

- Shows a **red border + `✗ failed` badge** so errors are impossible to miss
- Adds a **"↩ Retry with error context"** button that pre-fills the input:

```
Fix this error that just occurred:

[Tool Error in Edit]
old_string not found in file: src/server.ts
```

One click → the agent gets the exact error text and self-corrects automatically.

### 💾 CLAUDE.md Auto-Update Offer

After any session where the agent edited files, freeCode offers to write a project memory file:

```
💾 Update CLAUDE.md with a summary of this session?   [Yes, update]  [Not now]
```

Clicking **Yes, update** sends a structured prompt asking the agent to update (or create) `CLAUDE.md` with:
- Decisions made and architectural patterns established
- Files changed and conventions to follow in future sessions
- A concise developer-focused summary — not a chat log

This turns every coding session into **persistent project knowledge**, making future sessions smarter automatically — a feature no other AI coding tool offers out of the box.

---

## Windows Terminal — PowerShell First

On **Windows**, freeCode always runs commands through **PowerShell** (`powershell.exe`).  
WSL (Windows Subsystem for Linux) is intentionally **not used**, even when it is installed.

### Why PowerShell instead of WSL?

| Issue with WSL | How PowerShell fixes it |
|----------------|------------------------|
| Shell scripts saved with Windows line endings (`\r\n`) cause `/usr/bin/env: 'bash\r': No such file or directory` | PowerShell parses commands directly — no shebang lines, no `\r` errors |
| Windows paths (`C:\Users\...`) are invalid inside WSL's Linux filesystem | PowerShell uses native Windows paths without translation |
| Alpine/Ubuntu distro mismatch causes `No such file or directory` for packages | No WSL distro needed at all |

### POSIX shims

Because many AI-generated commands use Unix utilities (`grep`, `cat`, `touch`, `ls`, `find`, `sed`, …), freeCode automatically injects **PowerShell POSIX shims** before every command.  These thin wrappers map the most common Unix commands to their PowerShell equivalents so commands like:

```powershell
grep "error" log.txt
find . -name "*.dart"
cat pubspec.yaml
```

work out of the box inside PowerShell without any extra setup.

### Running Flutter / Dart commands

All Flutter and Dart CLI commands work exactly as expected:

```powershell
flutter analyze
flutter pub get
dart format .
```

You can also invoke them explicitly via PowerShell:

```powershell
powershell.exe -Command "flutter analyze"
```

---

## What's New in v2.3

### 🔌 Custom Providers UI — Redesigned Settings Cards

The **Custom Providers** section in Settings has been completely reworked for clarity and ease of use:

- **Provider cards** now display an auto-picked emoji icon based on the base URL (🤖 OpenAI, ⚡ NVIDIA NIM, 🌐 Google, 💻 Ollama/local, 🔌 generic)
- Model names are shown in **accent colour** beneath the base URL so you can see at a glance which models a provider exposes
- **✏ Edit** and **✕ Remove** buttons are grouped in a tidy action area on the right side of each card, with hover colours
- Cards have a subtle **hover border-colour transition** and rounded corners for a modern look
- The add/edit **form** gets an icon-prefixed title (🔌 Add Custom Provider / ✏ Edit Provider) and a top-border separator above the action buttons
- The empty-state hint now reads: *"No custom providers yet. Click + Add Provider to connect any OpenAI-compatible API."*

### 📐 Editor Line Numbers

The built-in code editor now shows **VS Code-style line numbers** in a gutter on the left:

- A dedicated line-number column appears left of the text area, styled identically to VS Code's default theme (muted colour, right-aligned)
- The gutter **scrolls in sync** with the file content as you scroll or navigate
- Line numbers **update instantly** as you type — adding or removing lines adjusts the count in real time
- Works in both the Electron app and the VS Code extension webview

### 🟩🟥 Accurate Diff View for Large Files

The diff view now **correctly shows which lines actually changed** instead of marking the entire after-file as added:

**Before (bug):** When an agent edited a large file (800+ lines), the diff showed every single line as a green `+` line — making it impossible to tell what actually changed.

**After (fixed):** Unchanged lines are shown as grey context lines; only truly added lines are green and truly removed lines are red.

The fix replaces the previous O(n²) fallback (which degenerated to "all added" for files with more than ~400 K line-pairs) with a fast **hash-based patience-diff approximation**:

1. Builds a positional index of all lines in the new file
2. Greedily maps matching lines from the old file → keeping them as context
3. Only emits red/green markers for lines that truly differ

Both the Electron app and the VS Code extension webview use the updated algorithm.

### 🔄 Agent Auto-Retry on 429 / Rate-Limit Errors

The agent no longer stops mid-task when it hits a `429 Too Many Requests` or other transient API error:

- An inner **retry loop** wraps every API call inside the agent loop generator — the HTTP request is retried up to **3 times** without re-adding the user message or corrupting conversation history
- **Exponential back-off**: 30 s → 60 s → 120 s between attempts
- Respects the `Retry-After` HTTP header returned by Anthropic, OpenAI, and Google — waits exactly as long as the provider requests
- Emits a `retrying` event that both UIs display as: `⏳ Rate limited — retrying in 30s (attempt 1/3)…`
- Covers **all providers**: Anthropic, OpenAI, Google, NVIDIA NIM, and Custom Providers
- After 3 failed retries the error is surfaced normally — the `main.js` outer retry loop remains as a final safety net

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
npm run package          # builds freecode-1.5.0.vsix
code --install-extension freecode-1.5.0.vsix
```

Set your API key: **freeCode: Set API Key** in the Command Palette.

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
npm run package          # builds freecode-1.5.0.vsix
code --install-extension freecode-1.5.0.vsix
```

Set your API key: **freeCode: Set API Key** in the Command Palette.

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
npm run package          # builds freecode-1.5.0.vsix
code --install-extension freecode-1.5.0.vsix
```

Set your API key: **freeCode: Set API Key** in the Command Palette.

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

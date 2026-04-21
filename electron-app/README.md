# freeCode — AI Coding Freedom for Vibe Coders 🚀

> **Freedom to code. Professional architecture. Agentic superpowers.**

A standalone Windows 11 desktop application that implements the **freeCode** AI coding assistant without requiring Visual Studio Code.  Dedicated to vibe coders who want a professional-grade AI coding tool that surpasses Cursor, Windsurf, and Claude Code.

Built with [Electron](https://www.electronjs.org/), it reuses the same agent loop (`v2/src`) from the VS Code extension and presents it in a full **VS Code-inspired 3-column IDE layout**.

---

## What's New in v3.0 — MultiEdit & Edit reliability on Windows 🪟🔧

### 🔁 `MultiEdit` "old_string not found" Fixed in All Modes

`MultiEdit` would always fail validation with *"old_string not found"* on Windows projects, even when the `Edit` tool succeeded on the same file.  Three root causes were fixed:

| Root cause | Fix |
|---|---|
| **CRLF leak in `Read` output** | The `Read` tool now normalises `\r\n` → `\n` before returning content to the model. The model was building `old_string` values containing `\r` from Windows files, which never matched even when `MultiEdit` also normalised internally. |
| **`MultiEdit` skipped the read-first gate** | `Edit` has always required the target file to be `Read` before it can be edited, forcing the model to work from real file content rather than memory. `MultiEdit` had no such check. It now enforces the same contract — if the file wasn't read first, the agent receives an explicit `"You must Read … before editing it. Use the Read tool first."` message. |
| **`MultiEdit` didn't call `markRead` after writing** | After a successful `MultiEdit`, any follow-up `Edit` call on the same file would fail with *"You must Read first"* because the write was not tracked. `MultiEdit` now calls `markRead` for every file it writes, keeping the read-tracking state consistent for the rest of the session. |

Together these changes make `MultiEdit` behave reliably in **every permission mode** — `default`, `acceptEdits`, `dontAsk`, and `plan` — and on both Windows (CRLF) and Unix (LF) projects.

---

## What's New in v2.9 — permission improvements 🔐

### ✏️ Edit Allowed in Plan Mode

`Edit`, `Write`, `Bash`, and all other tools are now fully allowed when the agent runs in **plan mode**. Previously plan mode used a narrow read-only allowlist that blocked edits even when the user explicitly asked for them. The mode now allows every tool so the agent can prototype and apply changes freely while planning.

### 🌐 Web Search Allowed in Every Permission Mode

`WebSearch` and `WebFetch` are now **always allowed in every permission mode**, including `dontAsk` (which previously blocked them along with everything else).

| What changed | Detail |
|---|---|
| Bypass guard in `checker.mjs` | `WebSearch` / `WebFetch` skip the mode switch — no mode can block them |
| `SAFE_TOOLS` in `prompt.mjs` | Both tools added so `default` mode never shows an interactive permission prompt for web lookups |

You can now ask the agent to search the web regardless of which permission mode is active.

---

## What's New in v2.5 — session memory & permissions 🧠🔧

### 🎯 Session Goal Memory

freeCode now tracks **what you are trying to accomplish** and keeps it visible throughout the entire session:

- A **sticky goal banner** appears below the toolbar, auto-populated from your first message
- Click the goal text to **edit it inline** — press Enter or click away to save
- Click **✕** to dismiss the banner at any time
- The goal **survives context compaction** — when long sessions are summarised to free up tokens, the goal is re-injected so the agent never loses track
- The goal is **persisted to disk** with the session history and restored when you reopen a saved session

```
┌──────────────────────────────────────────────────────────────┐
│  🎯 Build a REST API with authentication and rate limiting  ✕ │
└──────────────────────────────────────────────────────────────┘
```

### 🔄 Cross-Session Context Persistence

Session goals are saved and restored through every code path — `autoSaveSession`, `saveSession`, `updateSession`, `resumeFromHistory`, and `loadSession` — so switching between past sessions always restores the correct goal.

### 🤖 Strict Agent Execution Protocol

The agent now follows a mandatory discipline loop for every task:

1. **EXPLORE** — reads all relevant files before modifying anything
2. **PLAN** — states in ≤ 5 bullet points exactly what will change and why
3. **ACT** — executes changes using tools; never merely describes them
4. **VERIFY** — re-reads the changed file and runs the linter/build to confirm success
5. **REPORT** — states the final result with actual output (e.g. `eslint: 0 errors ✓`)

Extra guardrails cap retries at 3 attempts per fix, detect and break infinite loops, and forbid silent success claims without evidence.

### 🔐 Permission Modes — All Modes Now Work Correctly

`Edit` and `MultiEdit` were silently blocked across all modes due to four distinct bugs:

- **`default` mode hung indefinitely** — the Allow/Deny card appeared but the agent never received the answer because `resolvePermission` was missing from the bridge. It now correctly waits for and receives your approval or denial.
- **`plan` mode blocked `TodoWrite`** — `TodoWrite` is read-only task tracking and is now correctly allowed in plan mode.
- **Informative denial messages** — instead of `"Permission denied"` the agent receives a mode-aware explanation, e.g.:  
  *"Edit is not allowed in dontAsk mode."*

### 🗂️ Session Context Leak — Fixed

After switching permission modes and then creating a new chat (or deleting a history session), the agent silently inherited the previous session's conversation context and continued it without any user input.

**Fix:** The `clear` command now discards any saved bridge context, so every new chat starts completely fresh.

### 🏷️ Clearer "Blocked" UI Messages

Tool blocks now distinguish their cause:

- Hook rule → `⛔ Tool blocked by hook: Edit`
- Permission mode → `⛔ Tool blocked (permission denied): Edit`

---

## What's New in v2.4 — vibe-coder edition 🎉

### 🎤 Voice Input

Click the **🎤** mic button in the input bar to dictate your prompt using the Web Speech API.

- Click once to **start recording**, click again to stop
- **Interim transcription** streams live into the input field as you speak
- Pulsing **red glow animation** while recording
- Automatically hidden when the Speech API is unavailable

### 📝 File-Change Watcher Toast

When a file you have open or in context is modified externally — by `git pull`, another editor, or a background build tool — a **toast notification** appears:

```
📝 server.js was modified externally   [Re-read]  [✕]
```

- **Re-read** — re-adds the file to the context chips instantly
- Auto-dismisses after 8 seconds
- Requires no configuration — freeCode watches the workspace continuously and now includes the full file path in `fileWatchEvent` for accurate matching

### ❌ Tool Error — Inject Error as Context

When an agent tool call fails, the tool card now:

- Renders a **red border + `✗ failed` badge** so errors stand out clearly
- Shows a **"↩ Retry with error context"** button that pre-populates the input with the exact error message so the agent can self-correct with one click

### 💾 CLAUDE.md Auto-Update Offer

After sessions where the agent edited files, freeCode offers to create or update a `CLAUDE.md` memory file:

```
💾 Update CLAUDE.md with a summary of this session?   [Yes, update]  [Not now]
```

**Yes, update** instructs the agent to record the session's decisions, patterns, and changed files — making every future session smarter automatically.

---

## What's New in v2.3

### 🔌 Custom Providers UI — Redesigned Settings Cards

The **Custom Providers** section in Settings has been completely reworked:

- **Provider cards** display an auto-picked emoji icon derived from the base URL (🤖 OpenAI, ⚡ NVIDIA NIM, 🌐 Google, 💻 Ollama/local, 🔌 generic)
- Model names are rendered in **accent colour** so you can instantly see which models a provider exposes
- **✏ Edit** and **✕ Remove** are grouped as an action cluster on the right edge of each card, with correct hover colours
- Cards have border-colour transitions and rounded corners; the form gets icon-prefixed titles and a separator line above its buttons
- Empty state now shows a helpful hint: *"No custom providers yet. Click + Add Provider to connect any OpenAI-compatible API."*

### 📐 Editor Line Numbers

The middle-column code editor now shows **VS Code-style line numbers**:

- A gutter column appears to the left of the editable text area, right-aligned and styled in muted colour
- Gutter scroll is **locked in sync** with the textarea scroll position
- Line count **updates live** as you type, paste, or use the Tab key

### 🟩🟥 Accurate Diff View for Large Files

Agent-edited files now show **only the lines that actually changed**, not every line:

| Before | After |
|--------|-------|
| 800-line file modified in 3 places → 800 green `+` lines | ~794 grey context lines + 6 red/green changed lines |

The previous O(n²) LCS fallback for files larger than ~400 K line-pairs degraded to "mark everything as added". The new **hash-based patience-diff** algorithm correctly identifies equal lines as context rows.

### 🔄 Agent Auto-Retry on 429 / Rate-Limit Errors

The agent no longer aborts when it hits a `429 Too Many Requests` or gateway error mid-task:

- Retries the API call **up to 3 times** inside the agent loop — conversation state is untouched between retries
- **Exponential back-off**: 30 s → 60 s → 120 s; honours `Retry-After` header
- The UI shows `⏳ Rate limited — retrying in 30s (attempt 1/3)…` during the wait
- Works for all providers: Anthropic, OpenAI, Google, NVIDIA NIM, and Custom Providers

---

## What's New in v2.2

### 💬 Collapsible Long User Prompts

User messages longer than 300 characters are automatically **collapsed** to ~5 lines with a smooth fade-out gradient. A **Show more ▾ / Show less ▴** toggle lets you expand or collapse any long prompt at any time, keeping the chat tidy without losing context.

### ❓ AskUser — Interactive Agent Questions (IPC Bridge)

The agent can now call the **AskUser** tool inside the Electron app. When it does, an inline **question card** appears in the chat stream:

```
┌─────────────────────────────────────────────────┐
│ ?  Agent Question                               │
│                                                 │
│  Should I use approach A or B?                  │
│  [ Your answer…                    ] [Submit]   │
└─────────────────────────────────────────────────┘
```

The agent waits for your reply before proceeding — no more guessing or listing every option as a plan item.

### 📋 Plan Board — Smarter Item Filtering

The auto-populated plan board no longer adds **choice/option lines** (e.g. `**A)** Create a wrapper…`, `B) Use existing…`) or bare question lines as task items. Those are either skipped or the agent asks via AskUser first, so only real actionable tasks appear in the board.

### 🛠️ Full Tool Catalogue — All 25+ Tools Active

The system prompt now explicitly describes every available tool and when to use each one:

| Tool | Purpose |
|------|---------|
| WebFetch | Fetch docs, changelogs, any URL |
| WebSearch | Live web search (Brave / SearXNG) |
| AskUser | Ask clarifying questions inline |
| Agent | Spawn a sub-agent for complex tasks |
| LSP | Go-to-definition, diagnostics, hover types |
| TodoWrite | Session task tracking |
| Skill / ToolSearch / SendMessage / CronCreate … | Specialised integrations |

The agent is now guided to prefer `AskUser` over listing all options, and `WebFetch`/`WebSearch` for up-to-date documentation.

### 🗂️ Close All Editor Tabs

When two or more files are open in the editor, a **×× Close all** button appears at the right end of the tab bar. One click closes every tab and returns to the empty-editor state.

---

## What's New in v2.1

### 🏷️ Mode Badge in Agent Responses

Every assistant reply now shows a **color-coded mode badge** — `[default]`, `[auto]`, `[plan]`, `[acceptEdits]`, or `[bypass]` — next to the "Claude" name in the message header, so you always know which permission mode was active when the response was generated.

### 📋 Plan Mode — Cursor-Style To-Do Board

When you switch to **plan** mode a task board appears between the quick-actions bar and the chat area:

```
📋 Plan  ▾              [+ Add]  [✓ Clear done]  [✕]
──────────────────────────────────────────────────────
  ⟳  Set up project structure                       ✕
  ○  Install dependencies                           ✕
  ✓  Write unit tests                               ✕
──────────────────────────────────────────────────────
[New task…]  [Add]  [✕]
```

- **Auto-populated** — if the agent's reply contains a numbered or bulleted list, items are automatically parsed and added to the board
- **Progress tracking** — the first uncompleted item is marked *in progress* (⟳) while the agent runs tools; it advances to the next when complete
- **Manual control** — click ○ / ✓ to toggle items, click **+ Add** to add your own tasks, click ✕ to remove items, and **✓ Clear done** to tidy completed rows
- **Plan context injection** — active plan items are prepended to every prompt you send so the agent always has the current to-do list in context
- The board persists across mode changes so you can track execution in real time

### 🔐 Default Mode — Interactive Permission Prompts

Previously `default` mode silently approved every tool call. It now **actually asks** before the agent edits a file or runs a command.

A **Permission Required** card appears with:
- The tool name and the file path or command being requested
- **✓ Allow** — the action proceeds
- **✗ Deny** — the action is blocked and the agent is notified

### 📌 Persistent Mode Description Bar

The mode description bar no longer disappears after 5 seconds. It stays visible with a **✕** close button so you always have a reminder of what the current mode does. It also appears automatically at startup.

### ⌨️ `/mode` Slash Command

Typing `/mode` in the chat input now shows all five permission modes and their descriptions in the autocomplete dropdown.

### 🐛 Bug Fixes

| Fix | Detail |
|-----|--------|
| `acceptEdits` Bash | Bash commands now run without being blocked in `acceptEdits` mode |
| Diff tab race condition | Diff tabs open reliably even when the file-read response arrives after the edit result |
| New file diffs | When the agent creates a brand-new file it opens a diff tab showing the full new content |

---

## What's New in v2.0

### 🗂️ 3-Column IDE Layout

The entire UI has been restructured into three resizable columns:

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

- Drag either **resize handle** between columns to set custom widths — remembered across restarts
- **`Ctrl+B`** — collapse/expand the chat panel
- **`Ctrl+Shift+E`** — collapse/expand the file explorer

### 📑 Editor Tabs (middle column)

Clicking a file in the Explorer opens it in the editor panel as a tab:

- Multiple tabs open simultaneously — each shows file content in a monospace view
- **`×`** button or **`Ctrl+W`** closes the active tab
- Diff tabs are highlighted with ⚡ and show a before/after view

### ⚡ Automatic Diff View

When the AI agent edits a file a diff tab opens automatically:

- 🔴 Removed lines highlighted in red
- 🟢 Added lines highlighted in green
- **✓ Accept** — keeps the agent's changes and switches to a normal view
- **✗ Reject** — restores the original file and closes the diff tab

### 🔗 Clickable File Links in Chat

File names and paths mentioned by the agent in chat are rendered as **clickable links**:

- Click an inline path like `` `renderer/chat.js` `` → opens the file in the editor tab
- If the agent just edited that file, clicking it activates the **diff tab** so you see exactly what changed
- Supports relative paths (resolved against the workspace), absolute paths, and plain filenames

### 🖱️ File Explorer Context Menu

Right-click any file or folder in the Explorer column for quick actions:

| Action | Description |
|--------|-------------|
| Open in Editor | Opens the file in a new tab |
| New File | Creates an empty file in the same directory |
| New Folder | Creates a new directory |
| Rename | Renames the entry |
| Delete | Permanently deletes after confirmation |
| Copy Path | Copies the absolute path to clipboard |
| Add to Chat Context | Injects the file into the active prompt |

Explorer toolbar buttons also let you create files/folders at the workspace root and refresh the tree.

---

## What's New in v1.6

### ⚙️ In-app Settings Panel

Click the **⚙** button in the chat header to open a full settings panel — no more digging around in the userData folder:

- **Workspace** — browse and change the active project folder
- **Model & Agent** — model selector, permission mode, max turns, show/hide tool output toggle
- **API Keys** — set Anthropic/OpenAI/Google and NVIDIA NIM keys directly in the app
- **About** — quick link to GitHub and your data storage location

### 📁 File Explorer

A new **Files** button in the header opens a collapsible file-tree panel for your workspace:

- Expand/collapse folders with a click
- Hover a file to reveal a **+** button that adds it to the agent's context instantly
- Click a file to open it in the built-in file viewer

### 👁️ File Viewer

Click any file in the explorer to open it in a modal viewer:

- Full file content in a syntax-aware monospace view
- **Add to Context** button injects the file into the active chat prompt
- 500 KB size limit so the UI stays responsive on large files

---

## What's New in v1.5

### ✏️ Edit diff view
When the agent edits a file the tool card auto-expands and shows a red/green diff — removed lines in red, added lines in green — so you always see exactly what changed.

### 📄 Read line-range preview
The Read tool card header shows the filename and line range the agent inspected (e.g. `app.js · lines 1–50`).

### ⚡ Bash live streaming + interactive stdin
Bash output streams to the tool card in real-time as the process runs. While a command is running an input bar appears at the bottom of the card so you can type stdin input and interact with the process directly.

---

## Quick Start (Development)

### Prerequisites

- **Node.js** 18 or newer (https://nodejs.org)
- **npm** (comes with Node.js)
- An API key from Anthropic, OpenAI, Google AI Studio, or NVIDIA NIM

### Install dependencies

```powershell
cd electron-app
npm install
```

### Run in development mode

```powershell
npm start
```

The app opens a window with the familiar chat UI. On first launch, the setup guide walks you through adding an API key.

---

## Setting Your API Key

**Option A — In-app Settings Panel (recommended)**

1. Click the **⚙** button in the chat header (or press `Ctrl+Shift+K`).
2. In the **API Keys** section, click **🔑 Set API Key…**.
3. Paste your key and press Enter.
   - Anthropic: `sk-ant-api03-…`
   - OpenAI: `sk-…`
   - NVIDIA NIM: `nvapi-…`
   - Google: your Gemini API key
4. The key is encrypted with **Windows Credential Store** via Electron's `safeStorage` API.

You can also set your NVIDIA key directly in the **Settings Panel → API Keys → NVIDIA NIM API Key** field.

**Option B — Environment variable**

Set the appropriate variable before launching:

```powershell
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm start

# cmd.exe
set ANTHROPIC_API_KEY=sk-ant-...
npm start
```

---

## Opening a Workspace Folder

The agent works inside a **workspace folder** (like VS Code's open folder). By default it starts in your home directory.

**From the Settings Panel**: click **⚙** → **Workspace → Browse…**

**From the menu**: **File → Open Workspace Folder…** (`Ctrl+Shift+O`)

The file explorer automatically refreshes when you change the workspace.

---

## Using the File Explorer

The file explorer is now a **permanent right column** — always visible, no button needed.

| Action | Result |
|--------|--------|
| Click a folder | Expand/collapse |
| Click a file | Open in editor tab |
| Right-click any item | Context menu (New File, Rename, Delete, Copy Path, …) |
| `+File` button | New file at workspace root |
| `+Folder` button | New folder at workspace root |
| `↺` (refresh) button | Reload the file tree |

Folders like `node_modules`, `.git`, `dist`, and `build` are hidden automatically.

---

## Using the Settings Panel

Click the **⚙** button (gear icon) in the chat header:

| Section | What you can configure |
|---------|----------------------|
| Workspace | Browse & change active folder |
| Model | Switch between all supported AI models |
| Permission Mode | How the agent handles file/shell permissions |
| Max Turns | Maximum tool-use turns per request (default: 20) |
| Show Tool Output | Toggle tool cards in the chat |
| API Keys | Set / update Anthropic + NVIDIA keys |
| About | Open data folder · GitHub link |

---

## Permission Modes

| Mode | Description |
|------|-------------|
| `default` | **Asks before each tool use** — an Allow/Deny card appears in the chat before the agent edits a file or runs a command |
| `auto` | Automatically approves safe read-only operations; asks for writes and commands |
| `plan` | Read-only planning mode — no file writes or shell commands; auto-populates the Plan Board from agent replies |
| `acceptEdits` | Automatically applies all file edits and runs Bash commands without asking |
| `bypassPermissions` | ⚠ Skips all permission checks — full automation, use with care |

---

## Building a Windows Installer

```powershell
npm run build
```

This produces two outputs in `dist/`:

| File | Description |
|---|---|
| `freeCode Setup 1.0.0.exe` | NSIS installer with Start Menu / Desktop shortcuts |
| `freeCode-1.0.0-portable.exe` | Single-file portable executable (no install required) |

> **Note:** Building requires `electron-builder` and an internet connection on first run to download the Electron binary for Windows.

---

## Architecture

```
electron-app/
├── main.js          # Electron main process
│                    # — creates BrowserWindow
│                    # — runs agent loop (v2/src) in-process
│                    # — handles IPC: readFile, writeFile, createFile,
│                    #     createDir, renameFile, deleteFile, watchWorkspace
│                    # — permission-request/response IPC bridge (default mode)
│                    # — stores settings & history in %APPDATA%\freeCode\
├── preload.js       # Electron preload — exposes electronBridge IPC to renderer
└── renderer/
    ├── index.html   # 3-column IDE layout (chat | editor | explorer)
    │                # — plan board, permission modal
    ├── chat.js      # UI logic: tabs, diff view, plan board, permission prompts,
    │                #   mode badge, resize handles, context menu
    ├── chat.css     # UI styles: workbench layout, panels, tabs, diff colours,
    │                #   mode badge pills, plan board, permission modal
    └── icon.svg     # App icon
```

The agent loop (`v2/src/core/agent-loop.mjs`) runs **in-process** inside the Electron main process and is loaded via dynamic `import()`. This eliminates the need to spawn a Node.js subprocess and works cleanly on Windows.

---

## Data Storage

All persistent data is stored in the Electron `userData` directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\freeCode\` |

| File | Contents |
|---|---|
| `settings.json` | Model, permission mode, workspace path, max turns, etc. |
| `apikey.enc` | Encrypted API key (Windows Credential Store) |
| `history.json` | Chat session history (last 30 sessions) |
| `activeSession.json` | Current in-progress session (auto-restored on restart) |

---

## Supported Models

| Provider | Models |
|---|---|
| Anthropic | Claude Sonnet 4.6, Opus 4.6, Haiku 4.5 |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash |
| NVIDIA NIM | Kimi K2.5, Llama 3.1 405B/Nemotron 70B, Llama 3.3 70B, Mistral Large 2, Mixtral 8x22B, DeepSeek R1 |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+B` | Toggle chat panel (left column) |
| `Ctrl+Shift+E` | Toggle file explorer (right column) |
| `Ctrl+W` | Close the active editor tab |
| `Ctrl+Shift+K` | Set API Key |
| `Ctrl+Shift+O` | Open Workspace Folder |
| `Ctrl+Shift+C` | Clear Session |
| `Ctrl+F` | Search messages |
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Esc` | Stop generation |

---

## Windows 11 Compatibility Notes

- The app uses **Electron's `safeStorage`** API which integrates with the Windows Data Protection API (DPAPI) for secure API key storage.
- Shell commands run by the agent (`Bash` tool) use **`cmd.exe`** on Windows. Complex Unix-specific commands may need adjustment.
- The **Run in Terminal** feature opens a new `cmd.exe` window.

---

## License

MIT

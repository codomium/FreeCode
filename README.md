# Open Claude Code

An open-source, **Cursor-style AI coding assistant** with full tool access — read files, edit code, run commands, search the web, and more.  Runs everywhere: as a VS Code extension, a standalone Windows desktop app, or a Node.js CLI.

---

## Repository layout

| Directory | What it is |
|-----------|-----------|
| [`vscode-extension/`](./vscode-extension/README.md) | VS Code extension — Cursor-style sidebar chat panel + `@claude` chat participant |
| [`electron-app/`](./electron-app/README.md) | Standalone Windows 11 desktop app built with Electron |
| [`v2/`](./v2/README.md) | Agent loop CLI library — the engine used by both front-ends |

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

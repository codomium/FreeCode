# Open Claude Code — Standalone Windows App

A standalone Windows 11 desktop application that implements the **Open Claude Code** AI coding assistant without requiring Visual Studio Code.

Built with [Electron](https://www.electronjs.org/), it reuses the same agent loop (`v2/src`) and chat UI from the VS Code extension, adapting them to run as a native Windows app.

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

Click the **Files** button in the header to open the file tree panel:

| Action | Result |
|--------|--------|
| Click a folder | Expand/collapse |
| Click a file | Open in file viewer |
| Hover a file → **+** | Add file to agent context |
| Click ↻ (refresh) | Reload the file tree |

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

## Building a Windows Installer

```powershell
npm run build
```

This produces two outputs in `dist/`:

| File | Description |
|---|---|
| `Open Claude Code Setup 1.0.0.exe` | NSIS installer with Start Menu / Desktop shortcuts |
| `OpenClaudeCode-1.0.0-portable.exe` | Single-file portable executable (no install required) |

> **Note:** Building requires `electron-builder` and an internet connection on first run to download the Electron binary for Windows.

---

## Architecture

```
electron-app/
├── main.js          # Electron main process
│                    # — creates BrowserWindow
│                    # — runs agent loop (v2/src) in-process
│                    # — handles IPC messages from renderer
│                    # — stores settings & history in %APPDATA%\Open Claude Code\
├── preload.js       # Electron preload — exposes electronBridge IPC to renderer
└── renderer/
    ├── index.html   # Chat UI (with settings panel, file explorer, file viewer)
    ├── chat.js      # Chat UI logic (settings, explorer, viewer, acquireVsCodeApi → electronBridge)
    ├── chat.css     # Chat UI styles
    └── icon.svg     # App icon
```

The agent loop (`v2/src/core/agent-loop.mjs`) runs **in-process** inside the Electron main process and is loaded via dynamic `import()`. This eliminates the need to spawn a Node.js subprocess and works cleanly on Windows.

---

## Data Storage

All persistent data is stored in the Electron `userData` directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Open Claude Code\` |

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

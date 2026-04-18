# Open Claude Code — Standalone Windows App

A standalone Windows 11 desktop application that implements the **Open Claude Code** AI coding assistant without requiring Visual Studio Code.

Built with [Electron](https://www.electronjs.org/), it reuses the same agent loop (`v2/src`) and chat UI (`vscode-extension/media`) from the VS Code extension, adapting them to run as a native Windows app.

---

## What's New

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

**Option A — In-app dialog (recommended)**

1. Click **Agent → Set API Key…** in the menu bar (or press `Ctrl+Shift+K`).
2. Paste your key and press Enter.
   - Anthropic: `sk-ant-api03-…`
   - OpenAI: `sk-…`
   - NVIDIA NIM: `nvapi-…`
   - Google: your Gemini API key
3. The key is encrypted with **Windows Credential Store** via Electron's `safeStorage` API.

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

To change it: **File → Open Workspace Folder…** (`Ctrl+Shift+O`)

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
    ├── index.html   # Chat UI (adapted from vscode-extension/media/chat.html)
    ├── chat.js      # Chat UI logic (acquireVsCodeApi replaced with electronBridge)
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
| `settings.json` | Model, permission mode, workspace path, etc. |
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

## Windows 11 Compatibility Notes

- The app uses **Electron's `safeStorage`** API which integrates with the Windows Data Protection API (DPAPI) for secure API key storage.
- Shell commands run by the agent (`Bash` tool) use **`cmd.exe`** on Windows. Complex Unix-specific commands may need adjustment.
- The **Run in Terminal** feature opens a new `cmd.exe` window.

---

## License

MIT

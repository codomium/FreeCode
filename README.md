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

## What's New in v3.1 — Edit & Bash validation recovery 🛡️

### 🔧 Edit Tool — Parameter Name Normalization

The `Edit` tool now accepts the alternative parameter names that models sometimes use instead of the canonical ones, mirroring the behaviour already present in `Bash` and `MultiEdit`:

| Canonical | Accepted alternatives |
|---|---|
| `file_path` | `filename`, `path`, `file` |
| `old_string` | `old_content`, `original_string`, `original`, `search` |
| `new_string` | `new_content`, `replacement_string`, `replacement`, `replace` |

Previously, using any of these alternates produced `Validation error: file_path required, old_string required` and the edit was silently dropped.

### 🔧 Bash Tool — Additional Parameter Name Aliases

Three more aliases recognised for the `command` parameter: `bash`, `shell`, `code`. These join the existing set (`cmd`, `bash_command`, `shell_command`, `script`, `run`, `execute`).

### ♻️ Clearer Validation Error Messages

All tool validation errors now end with **"Please correct the parameters and retry the tool call."** This makes it unambiguous to the model that it should fix and resubmit the call rather than responding with an explanation and stopping.

### 🔄 Agent Loop — Auto-Nudge on All-Validation-Error Batches

When every tool call in a single response batch fails with a validation error, the agent loop now appends a system text block to the tool-result message:

> *"All tool call(s) above failed input validation. Review the required parameter names for each tool and retry the tool call(s) immediately. Do not stop or summarise — keep going."*

This prevents the model from giving up with a summary message when it should be retrying the failed calls.

---

## What's New in v3.0 — MultiEdit & Edit reliability on Windows 🪟🔧

### 🔁 `MultiEdit` "old_string not found" Fixed in All Modes

`MultiEdit` would always fail validation with *"old_string not found"* on Windows projects, even when the `Edit` tool succeeded on the same file.  Three root causes were fixed:

| Root cause | Fix |
|---|---|
| **CRLF leak in `Read` output** | The `Read` tool now normalises `\r\n` → `\n` before returning content to the model. The model was building `old_string` values containing `\r` from Windows files, which never matched even though `MultiEdit` also normalised internally. |
| **`MultiEdit` skipped the read-first gate** | `Edit` has always required the target file to be `Read` before it can be edited, forcing the model to work from real file content rather than memory. `MultiEdit` had no such check. It now enforces the same contract — if the file wasn't read first, the agent receives an explicit `"You must Read … before editing it. Use the Read tool first."` message. |
| **`MultiEdit` didn't call `markRead` after writing** | After a successful `MultiEdit`, any follow-up `Edit` call on the same file would fail with *"You must Read first"* because the write was not tracked. `MultiEdit` now calls `markRead` for every file it writes, keeping the read-tracking state consistent for the rest of the session. |

Together these changes make `MultiEdit` behave reliably in **every permission mode** — `default`, `acceptEdits`, `dontAsk`, and `plan` — and on both Windows (CRLF) and Unix (LF) projects.

---

## What's New in v2.9 — permission improvements 🔐

### ✏️ Edit Allowed in Plan Mode

`Edit`, `Write`, `Bash`, and all other tools are now fully allowed when the agent runs in **plan mode**. Previously plan mode used a narrow read-only allowlist (`Read`, `Glob`, `Grep`, `LS`, `TodoWrite`) that prevented the agent from performing actions the user explicitly requested while planning. The mode now returns `true` for every tool, matching the intent of letting the agent plan and prototype freely.

### 🌐 Web Search Allowed in Every Permission Mode

`WebSearch` and `WebFetch` are now **unconditionally allowed in all permission modes**, including `dontAsk` (which previously blocked every tool call).

| What changed | Detail |
|---|---|
| `checker.mjs` early-return | `WebSearch` / `WebFetch` bypass the mode switch entirely — no mode can block them |
| `SAFE_TOOLS` in `prompt.mjs` | Both tools added to the safe set so `default` mode never shows an interactive permission prompt |

This means you can always ask the agent to look something up on the web, regardless of which permission mode the project is in.

---

## What's New in v2.8 — AI power & UX supremacy 🚀

These three enhancements are present in **both** the VS Code extension and the Electron desktop app (Focus Mode is Electron-only).

### ⚡📖 Response Style Pill (both apps)

No competitor has this built-in. A compact three-state pill selector sits just above the message input in both apps:

| Pill | Effect |
|------|--------|
| **Auto** (default) | No modifier — let the model decide |
| **⚡ Brief** | Appends *"Respond concisely. Use bullet points where suitable."* |
| **📖 Thorough** | Appends *"Provide a thorough, detailed explanation with examples and reasoning."* |

Selection persists in `localStorage` across sessions. Zero friction — one click, every future message adapts.

### ⭐ Message Bookmarks / Starred Replies (both apps)

Every AI reply now has a ☆ star button in its header (visible on hover). Clicking it:

1. Marks the message with a gold ★
2. Saves the full text to `localStorage` under the current session title + timestamp
3. If the **⭐ Stars** panel (new header button) is open, it refreshes immediately

The **Stars panel** shows all saved messages with copy and remove buttons. A **🗑 Clear all** button with a confirmation dialog removes everything at once. Neither Cursor nor Windsurf offers any form of reply bookmarking.

### 🎯 Focus / Zen Mode (Electron app)

Click the **⊞ Focus** button in the header (or press **Ctrl+Shift+Z**) to hide the Explorer and Editor panels, giving the chat column the full window width. A centred max-width layout (860 px) makes long AI conversations comfortable to read. Click again or press the shortcut again to exit.

---

## What's New in v2.7 — Cursor & Windsurf killers 🎯

These three enhancements are present in **both** the VS Code extension and the Electron desktop app.

### ✏️ Inline Edit Bar (Cmd+K / Ctrl+K)

The #1 feature that makes Cursor famous is now in freeCode — and it works without any third-party subscription.

- **Electron app**: open a file in the built-in editor, select any code (or place the cursor on a line), then press **Cmd+K / Ctrl+K**. A sleek edit bar slides in at the top of the editor panel.  Type your instruction and press Enter — the selected code and your instruction are sent to the AI, which edits the file directly.
- **VS Code extension**: press **Ctrl+K** anywhere in the chat panel (when the input is not focused) to open a Quick-Edit bar. Type your instruction and press Enter — the active file is automatically added to context and the instruction is prefilled in the message box ready to send.

Esc or the ✕ button cancels without sending.

### ⭐ Custom Quick Actions (User-Saved Prompts)

Both Cursor and Windsurf ship a fixed list of slash commands. freeCode lets you **save your own prompt buttons**.

Click **⚡ Actions** to open the Quick Actions panel. Scroll to the new **⭐ My Prompts** section and click **+ Save prompt**. Enter a short label (e.g. *"Add logging"*) and a template (use `{selection}` to insert selected text). The button is saved in browser localStorage and persists across sessions. Each saved button has a **×** to delete it.

### ✗ Reject All (Electron)

The diff toolbar in the Electron app now has a **✗ Reject All** button next to **✓ Accept All**.  
Clicking it restores the original content of every open diff tab to disk and closes them in one shot — the symmetric counterpart to Accept All.

---

## What's New in v2.6 — agent reliability & tool improvements 🛡️

### 🛡️ Mandatory Agent Reliability Rules

The system prompt now enforces five hard rules that prevent the agent from silently doing the wrong thing:

- **Always act via tools** — describing an action without calling a tool is a critical failure; text like *"I would create …"* is never acceptable when the task requires a real change
- **Plan → Act → Verify** — every `Write`/`Edit` must be followed by a `Read`-back to confirm the result; linter/test commands are run if available
- **3-attempt loop budget** — after 3 failed attempts on the same step the agent emits a structured `BLOCKED: … | root cause: … | need: …` message and stops rather than looping forever
- **Root cause before fix** — the agent must read the file and capture the exact error before attempting a fix, preventing guess-and-retry spirals
- **Forbidden behaviours explicitly listed** — claiming success without verification, retrying an identical failing call, or outputting code in chat instead of calling `Write`/`Edit` are all prohibited

### 🔁 Infinite-Loop Guard

The agent loop now tracks the last three tool calls. If the same tool is called with identical arguments and produces an identical result three times in a row, the loop is stopped automatically and a `{ type: 'stuck' }` event is emitted — preventing silent CPU-burning loops when an edit can never succeed.

### ✅ Edit & MultiEdit Verification

After every `Edit` or `MultiEdit` call the agent now reads the file back and checks:

1. `new_string` is present in the file (replacement was actually applied)
2. `old_string` is no longer present (the old text is gone)

If either check fails a `{ type: 'warning' }` event is emitted so the agent can self-correct. This extends the existing `Write` verification that was already in place.

### 🌐 HTML → Plain Text in WebFetch

When the `WebFetch` tool receives an `text/html` or `application/xhtml` response it now automatically strips tags and returns clean plain text instead of raw HTML markup. This dramatically reduces the token cost of reading documentation pages.

- `<script>` and `<style>` blocks (including their content) are removed first
- Block-level elements (`<p>`, `<div>`, `<h1>`–`<h6>`, `<li>`, etc.) become newlines
- All remaining tags are stripped
- HTML entities are decoded (`&amp;`, `&lt;`, `&gt;`, `&#8230;`, `&#x2019;`, etc.)
- A new `raw_html: true` parameter is available for callers that need the original markup

### 🗂️ Smarter Glob — Fewer Noise Files

The `Glob` tool's directory walk now skips a much broader list of generated/vendor directories that are never useful to search:

| Added exclusions |
|---|
| `.git` · `dist` · `build` · `out` |
| `.next` · `.nuxt` · `__pycache__` |
| `.cache` · `coverage` · `.nyc_output` |
| `.turbo` · `.venv` · `venv` · `.tox` |
| `vendor` · `target` · `.gradle` |

### 📂 LS — Sorted Output

The `LS` tool output is now sorted: **directories first** (alphabetically), then **files** (alphabetically). Previously entries were returned in filesystem order which varies by OS and makes it harder to scan.

### 🐛 PDF Reader ESM Fix

The `Read` tool's PDF handler was calling `require('child_process')` inside an ES module, which throws a `ReferenceError` at runtime. The import is now a proper top-level `import { spawnSync }` statement.

---

## What's New in v2.5 — session memory & permissions 🧠🔧

### 🎯 Session Goal Memory

freeCode now tracks **what you're trying to accomplish** and keeps it visible throughout the entire session:

- A **sticky goal banner** appears below the toolbar, auto-populated from your very first message
- Click the goal text to **edit it inline** — press Enter or click away to save
- Click **✕** to dismiss the banner
- The goal **survives context compaction** — when the conversation history is summarised to free up tokens, the goal is re-injected so the agent never forgets it
- The goal is **persisted to disk** alongside the session history and automatically restored when you reopen a past session

```
┌──────────────────────────────────────────────────────────┐
│  🎯 Build a REST API with authentication and rate limiting │  ✕  │
└──────────────────────────────────────────────────────────┘
```

### 🔄 Cross-Session Context Persistence

Session goals round-trip through every save/load path — `autoSaveSession`, `saveSession`, `updateSession`, `resumeFromHistory`, and `loadSession` — so switching between past sessions always restores the correct goal.

### 🤖 Strict Agent Execution Protocol

The agent now follows a mandatory discipline loop for every task:

1. **EXPLORE** — reads all relevant files before touching anything
2. **PLAN** — states in ≤ 5 bullet points exactly what will change and why
3. **ACT** — executes changes using tools; never just describes them
4. **VERIFY** — re-reads the file and runs the linter/build to confirm the change worked
5. **REPORT** — states the final result with actual output (e.g. `eslint: 0 errors ✓`)

Additional guardrails prevent the agent from silently claiming success, retrying the same failed approach more than 3 times, or writing placeholder code.

### 🔐 Permission Modes — All Modes Now Work Correctly

`Edit` and `MultiEdit` were silently blocked in all modes due to four distinct bugs that have been fixed:

- **`default` mode hung indefinitely** — the Allow/Deny permission card appeared in the UI but the agent never received the answer because `resolvePermission` was missing from the bridge. The agent now correctly waits for your approval and resumes or is blocked based on your choice.
- **`plan` mode blocked `TodoWrite`** — `TodoWrite` is a read-only task-tracking tool and is now correctly allowed in plan mode alongside `Read`, `Glob`, `Grep`, and `LS`.
- **All modes: informative denial messages** — instead of a bare `"Permission denied"` result, the agent now receives a mode-specific explanation:
  - dontAsk mode → *"Edit is not allowed in dontAsk mode."*
  - Other blocked modes → *"Permission denied for Edit."*

### 🗂️ Session Context Leak — Fixed

**Problem:** After switching permission modes (which tears down and rebuilds the agent bridge), clicking **New Chat** or deleting a history session and creating a fresh one would cause the agent to silently inherit the old session's conversation context. The agent continued the previous session without any user input.

**Fix:** The `clear` command now discards any saved agent messages, so every new chat truly starts from scratch regardless of prior mode switches.

### 🏷️ "Blocked by Hook" vs "Permission Denied" — Clearer UI Messages

Previously every tool block — whether from a hook rule or from a permission mode restriction — showed `⛔ Tool blocked by hook: Edit`. The UI now distinguishes the two cases:

- Hook rule triggered → `⛔ Tool blocked by hook: Edit`
- Permission mode blocked → `⛔ Tool blocked (permission denied): Edit`

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

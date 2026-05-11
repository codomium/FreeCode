'use strict';
/**
 * main.js — freeCode Electron Main Process
 *
 * Standalone application for freeCode — AI coding freedom for vibe coders.
 * Implements the freeCode agent with professional architecture and agentic superpowers,
 * surpassing tools like Cursor, Windsurf, and Claude Code.
 * Ports the VSCode extension's functionality (extension.js) to Electron, replacing
 * VSCode-specific APIs with Electron equivalents:
 *
 *   • vscode.workspace.getConfiguration()  → JSON settings file in userData
 *   • vscode.secrets                        → Electron safeStorage
 *   • vscode.window.showOpenDialog()        → dialog.showOpenDialogSync()
 *   • vscode.env.clipboard                  → clipboard module
 *   • context.globalState                   → JSON files in userData
 *   • vscode.window.activeTextEditor        → not available (standalone app)
 *   • vscode.languages.getDiagnostics()     → not available (standalone app)
 *
 * The freeCode agent loop from v2/src runs **in-process** (imported
 * dynamically as ES modules) rather than as a subprocess. This avoids the
 * Node.js binary path issue on Windows and simplifies the architecture.
 */

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, safeStorage, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { MultiAgentOrchestrator } = require('./multi-agent-orchestrator');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SESSION_MESSAGES = 200;
const RETRY_DELAYS_MS = [3000, 8000, 20000];
const MIN_MULTI_AGENT_PROVIDERS = 3;

/** Returns true for rate-limit / server-overload errors worth retrying. */
function isRateLimitError(msg) {
    return /rate.?limit|overload|too.?many.?request|capacity|529|503|502|504|bad.?gateway|service.?unavailable|quota/i.test(msg || '');
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * Locate the v2/src directory.
 * In development: ../v2/src (sibling of electron-app/)
 * In a packaged build: resources/v2/src
 */
function findV2Src() {
    const candidates = [
        path.join(__dirname, '..', 'v2', 'src'),          // development
        path.join(process.resourcesPath || '', 'v2', 'src'), // packaged
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'core', 'agent-loop.mjs'))) return c;
    }
    throw new Error(
        'Cannot locate v2/src. Checked:\n' +
        candidates.map(c => '  ' + c).join('\n') + '\n\n' +
        'To fix this:\n' +
        '  • Development: ensure the v2/ directory exists as a sibling of electron-app/\n' +
        '  • Packaged build: re-run `npm run build` from the electron-app/ directory\n' +
        '    so that electron-builder copies v2/src into the app resources.'
    );
}

// ── Persistent storage helpers ────────────────────────────────────────────────

let _userData = null;
function getUserData() {
    if (!_userData) {
        _userData = app.getPath('userData');
        fs.mkdirSync(_userData, { recursive: true });
    }
    return _userData;
}

function readJson(name, defaultVal) {
    try {
        const p = path.join(getUserData(), name + '.json');
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return defaultVal;
    }
}

function writeJson(name, data) {
    const p = path.join(getUserData(), name + '.json');
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    model:              'claude-sonnet-4-6',
    permissionMode:     'default',
    maxTurns:           20,
    showToolOutput:     true,
    nvidiaThinkingMode: false,
    nvidiaApiKey:       '',
    autoAttachActiveFile: false,
    pinnedFiles:        [],
    workspacePath:      os.homedir(),
    defaultShell:       'auto', // 'auto' | 'powershell' | 'wsl' | 'ubuntu' | 'bash' | 'cmd'
    multiAgentEnabled:  false,
    multiAgentStrategy: 'parallel',
    multiAgentMaxProviders: 3,
    systemPromptPreset: 'expert-engineer',
    providers:          [],
    customProviders:    [],   // [{ id, name, baseUrl, apiKey, models:[{id,name}], headers:[{name,value}] }]
    mcpServers:         {},   // { serverId: { command, args } }
};

function getSettings() {
    const merged = Object.assign({}, DEFAULT_SETTINGS, readJson('settings', {}));
    const providers = Array.isArray(merged.providers)
        ? merged.providers
        : (Array.isArray(merged.customProviders) ? merged.customProviders : []);
    merged.providers = providers;
    merged.customProviders = providers;
    return merged;
}

function saveSetting(key, value) {
    const s = getSettings();
    s[key] = value;
    if (key === 'providers') s.customProviders = value;
    if (key === 'customProviders') s.providers = value;
    writeJson('settings', s);
}

// ── API-key storage (safeStorage for Windows Credential Store) ────────────────

const API_KEY_FILE = 'apikey.enc';

function storeApiKey(keyVal) {
    if (safeStorage.isEncryptionAvailable()) {
        const enc = safeStorage.encryptString(keyVal);
        fs.writeFileSync(path.join(getUserData(), API_KEY_FILE), enc);
    } else {
        // Fallback: store in plaintext settings (warns user)
        saveSetting('_apiKeyPlain', keyVal);
    }
}

function loadApiKey() {
    try {
        const filePath = path.join(getUserData(), API_KEY_FILE);
        if (fs.existsSync(filePath)) {
            const enc = fs.readFileSync(filePath);
            return safeStorage.isEncryptionAvailable()
                ? safeStorage.decryptString(enc)
                : '';
        }
    } catch { /* ignore */ }
    // Fallback: plaintext
    return getSettings()._apiKeyPlain || '';
}

function hasApiKey() {
    const storedKey = loadApiKey();
    if (storedKey) return true;
    return !!(
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY    ||
        process.env.GOOGLE_API_KEY    ||
        process.env.GEMINI_API_KEY    ||
        process.env.NVIDIA_API_KEY    ||
        getSettings().nvidiaApiKey
    );
}

// ── In-Process Agent Bridge ───────────────────────────────────────────────────
/**
 * Runs the freeCode agent loop in the Electron main process.
 * Mirrors the message protocol of agent-bridge.mjs but uses IPC instead of
 * stdin/stdout to communicate with the renderer.
 */
class InProcessAgentBridge {
    constructor() {
        this._loop        = null;
        this._isCancelled = false;
        this._ready       = false;
        this._initPromise = null;
        this._model       = null;
    }

    async _init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            const v2Src = findV2Src();
            const v2url = (rel) => pathToFileURL(path.join(v2Src, rel)).href;

            const { createAgentLoop }       = await import(v2url('core/agent-loop.mjs'));
            const { createToolRegistry }    = await import(v2url('tools/registry.mjs'));
            const { createPermissionChecker } = await import(v2url('permissions/checker.mjs'));
            const { loadSettings }          = await import(v2url('config/settings.mjs'));
            const { HookEngine }            = await import(v2url('hooks/engine.mjs'));
            const { AgentLoader }           = await import(v2url('agents/loader.mjs'));
            const { SkillsLoader }          = await import(v2url('skills/loader.mjs'));
            const { sendBashStdin }         = await import(v2url('tools/bash.mjs'));

            // Expose sendBashStdin for the IPC handler (same module instance as the tools)
            this._sendBashStdin = sendBashStdin;

            const settings = await loadSettings();

            const tools   = createToolRegistry();
            const appSettings  = getSettings();
            const permMode = appSettings.permissionMode || 'default';

            // In default mode, wire an interactive promptCallback so the renderer
            // gets a chance to approve/deny each tool use before it runs.
            const permConfig = {
                ...(settings.permissions || {}),
                defaultMode: permMode,
            };
            if (permMode === 'default') {
                permConfig.promptCallback = (toolName, input) =>
                    this._promptPermission(toolName, input);
            }

            const permissions = createPermissionChecker(permConfig);
            const hooks       = new HookEngine(settings.hooks || {});

            const agentLoader = new AgentLoader();
            agentLoader.load();
            const skillsLoader = new SkillsLoader();
            skillsLoader.load();

            const skillTool = tools.get('Skill');
            if (skillTool) skillTool._skillsLoader = skillsLoader;

            // Wire AskUser tool to forward questions to the renderer via IPC
            const askUserTool = tools.get('AskUser');
            if (askUserTool) {
                askUserTool._questionCallback = (question, defaultValue, timeout) =>
                    this._promptQuestion(question, defaultValue, timeout);
            }

            const model = this._model || appSettings.model || 'claude-sonnet-4-6';

            // Connect MCP servers saved in app settings
            const mcpClients = [];
            const appMcpServers = appSettings.mcpServers || {};
            // Merge with any in ~/.claude/settings.json (already loaded in `settings`)
            const allMcpServers = Object.assign({}, settings.mcpServers || {}, appMcpServers);
            if (Object.keys(allMcpServers).length > 0) {
                const { McpClient } = await import(v2url('mcp/client.mjs'));
                for (const [name, config] of Object.entries(allMcpServers)) {
                    try {
                        const client = new McpClient(config);
                        await client.connect();
                        const mcpTools = await client.listTools();
                        tools.registerMcpTools(mcpTools, (toolName, toolArgs) => client.callTool(toolName, toolArgs));
                        mcpClients.push(client);
                    } catch (err) {
                        console.warn(`MCP server "${name}" failed to connect: ${err.message}`);
                    }
                }
            }

            const mcpResourceTool = tools.get('ReadMcpResource');
            if (mcpResourceTool) mcpResourceTool._mcpClients = mcpClients;

            this._loop = createAgentLoop({ model, tools, permissions, settings, hooks });
            this._loop.state._agentLoader   = agentLoader;
            this._loop.state._skillsLoader  = skillsLoader;
            this._loop.state._mcpClients    = mcpClients;
            this._loop.state._hooks         = settings.hooks;
            this._loop.state._permissionMode = permMode;

            // Restore conversation context saved from a previous bridge (mode/setting change)
            if (this._pendingMessages && this._pendingMessages.length > 0) {
                this._loop.state.messages  = this._pendingMessages;
                this._loop.state.turnCount = this._pendingMessages.filter(m => m.role === 'user').length;
                this._pendingMessages = null;
            }

            this._ready = true;
        })();
        return this._initPromise;
    }

    /**
     * Send a permissionRequest to the renderer and wait for the user's response.
     * Returns a Promise<boolean> that resolves when the renderer replies.
     */
    _promptPermission(toolName, input) {
        return new Promise((resolve) => {
            if (!mainWindow || mainWindow.isDestroyed()) { resolve(true); return; }

            const reqId = crypto.randomUUID();
            // Store resolve so the IPC handler can complete it
            if (!this._permPending) this._permPending = new Map();
            this._permPending.set(reqId, resolve);

            mainWindow.webContents.send('main-message', {
                type:    'permissionRequest',
                reqId,
                tool:    toolName,
                file:    input?.file_path || input?.path || null,
                command: input?.command   || null,
                input,
            });
        });
    }

    /**
     * Send a questionRequest to the renderer and wait for the user's text answer.
     * Returns a Promise<string> that resolves when the renderer replies.
     */
    _promptQuestion(question, defaultValue, timeoutMs) {
        return new Promise((resolve) => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                resolve(defaultValue || '[window unavailable]');
                return;
            }

            const reqId = crypto.randomUUID();
            if (!this._questionPending) this._questionPending = new Map();

            // Auto-resolve on timeout so the agent isn't blocked forever
            const timer = setTimeout(() => {
                if (this._questionPending.has(reqId)) {
                    this._questionPending.delete(reqId);
                    resolve(defaultValue || '[timeout: no response]');
                }
            }, timeoutMs || 120000);

            this._questionPending.set(reqId, (answer) => {
                clearTimeout(timer);
                resolve(answer ?? defaultValue ?? '');
            });

            mainWindow.webContents.send('main-message', {
                type:    'questionRequest',
                reqId,
                question,
                defaultValue: defaultValue || '',
            });
        });
    }

    /** Called by IPC when renderer sends back permissionResponse */
    resolvePermission(reqId, allowed) {
        if (!this._permPending) return;
        const resolve = this._permPending.get(reqId);
        if (resolve) {
            this._permPending.delete(reqId);
            resolve(!!allowed);
        }
    }

    /** Called by IPC when renderer sends back questionResponse */
    resolveQuestion(reqId, answer) {
        if (!this._questionPending) return;
        const resolve = this._questionPending.get(reqId);
        if (resolve) {
            this._questionPending.delete(reqId);
            resolve(answer);
        }
    }

    async run(message, onEvent) {
        this._isCancelled = false;
        try {
            await this._init();
        } catch (err) {
            onEvent({ type: 'error', message: 'Failed to init agent: ' + err.message });
            onEvent({ type: 'stop', reason: 'error' });
            return;
        }
        try {
            for await (const event of this._loop.run(message)) {
                if (this._isCancelled) break;
                onEvent(event);
            }
            if (!this._isCancelled) {
                onEvent({ type: 'stop', reason: 'end_turn' });
            }
        } catch (err) {
            onEvent({ type: 'error', message: err.message });
            onEvent({ type: 'stop', reason: 'error' });
        }
    }

    cancel() {
        this._isCancelled = true;
    }

    reset() {
        if (this._loop) {
            this._loop.state.messages   = [];
            this._loop.state.turnCount  = 0;
            this._loop.state.tokenUsage = { input: 0, output: 0 };
        }
    }

    switchModel(model) {
        this._model = model;
        if (this._loop) {
            this._loop.state.model = model;
        }
    }

    resume(messages, sessionGoal, sessionId) {
        if (!this._loop) return;
        this._loop.state.messages = messages
            .filter(m => (m.type === 'user' || m.type === 'assistant') && m.text)
            .map(m => {
                if (m.type === 'user') return { role: 'user', content: m.text };
                return { role: 'assistant', content: [{ type: 'text', text: m.text }] };
            });
        this._loop.state.turnCount = messages.filter(m => m.type === 'user').length;
        this._loop.state.tokenUsage = { input: 0, output: 0 };
        if (sessionGoal) this._loop.state.sessionGoal = sessionGoal;
        if (sessionId) this._loop.state.sessionId = sessionId;
    }

    setGoal(goal, sessionId) {
        if (this._loop) {
            this._loop.state.sessionGoal = goal || null;
            if (sessionId) this._loop.state.sessionId = sessionId;
        }
    }

    /**
     * Reinitialise the bridge with new environment variables (after API key or mode change).
     */
    reinit() {
        // Reject any pending permission prompts before reinit
        if (this._permPending) {
            for (const resolve of this._permPending.values()) {
                resolve(false); // deny any outstanding requests
            }
            this._permPending.clear();
        }
        this._loop = null;
        this._ready = false;
        this._initPromise = null;
    }
}

// ── Global state ──────────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {InProcessAgentBridge|null} */
let agentBridge = null;

/** @type {boolean} */
let isCancelled = false;

/**
 * Messages saved from the old agent bridge before a reinit.
 * These are raw agent-loop messages (role/content objects) that will be
 * restored into the new bridge's loop state after it initialises.
 * @type {Array|null}
 */
let savedAgentMessages = null;

/**
 * Capture the current conversation messages from the running agent bridge
 * so they can be restored into the replacement bridge after a reinit.
 */
function captureAgentMessages() {
    if (agentBridge && agentBridge._loop && Array.isArray(agentBridge._loop.state.messages)) {
        savedAgentMessages = [...agentBridge._loop.state.messages];
    }
}

function getBridge() {
    if (!agentBridge) {
        const s = getSettings();
        if (s.multiAgentEnabled) {
            agentBridge = new MultiAgentOrchestrator({
                providers: Array.isArray(s.providers) ? s.providers : [],
                strategy: s.multiAgentStrategy || 'parallel',
                createBridge: () => new InProcessAgentBridge(),
            });
        } else {
            agentBridge = new InProcessAgentBridge();
        }
        // Restore conversation context that was saved before the last reinit
        if (savedAgentMessages && savedAgentMessages.length > 0) {
            // Keep raw agent-loop messages on the pending path only.
            // resume() is for renderer/UI-formatted messages ({ type, text }).
            agentBridge._pendingMessages = savedAgentMessages;
            savedAgentMessages = null;
        }
    }
    return agentBridge;
}

function applyEnvFromSettings() {
    const s = getSettings();
    const key = loadApiKey() || process.env.ANTHROPIC_API_KEY || '';
    if (key) process.env.ANTHROPIC_API_KEY = key;
    if (s.nvidiaApiKey) process.env.NVIDIA_API_KEY = s.nvidiaApiKey;
    process.env.ANTHROPIC_MODEL             = s.model || 'claude-sonnet-4-6';
    process.env.CLAUDE_CODE_PERMISSION_MODE = s.permissionMode || 'default';
    process.env.CLAUDE_CODE_MAX_TURNS       = String(s.maxTurns || 20);
    process.env.NVIDIA_THINKING_MODE        = String(s.nvidiaThinkingMode || false);
    process.env.MULTI_AGENT_ENABLED         = String(!!s.multiAgentEnabled);
    process.env.MULTI_AGENT_STRATEGY        = String(s.multiAgentStrategy || 'parallel');
    process.env.SYSTEM_PROMPT_PRESET        = String(s.systemPromptPreset || 'expert-engineer');

    // Serialize custom providers so the agent-loop can call them
    const cp = Array.isArray(s.providers) ? s.providers : [];
    process.env.CUSTOM_PROVIDERS_JSON = cp.length > 0 ? JSON.stringify(cp) : '';

    // Set cwd to workspace
    try { process.chdir(s.workspacePath || os.homedir()); } catch { /* ignore */ }
}

// ── BrowserWindow factory ─────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width:  1200,
        height: 800,
        minWidth:  600,
        minHeight: 500,
        title: 'freeCode',
        icon: path.join(__dirname, 'renderer', 'icon.ico'),
        webPreferences: {
            preload:           path.join(__dirname, 'preload.js'),
            contextIsolation:  true,   // renderer cannot access Node/Electron directly
            nodeIntegration:   false,  // renderer has no Node.js access
            // sandbox:false is required so the preload script can call require('electron')
            // to access ipcRenderer and contextBridge. contextIsolation:true above
            // is the primary security boundary between renderer and main process.
            sandbox:           false,
        },
        backgroundColor: '#1e1e1e',
        show: false,
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (process.env.OCC_DEV) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── Application menu ──────────────────────────────────────────────────────────

function buildMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open Workspace Folder…',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    async click() {
                        const result = dialog.showOpenDialogSync(mainWindow, {
                            title:      'Select workspace folder',
                            properties: ['openDirectory'],
                        });
                        if (result && result[0]) {
                            saveSetting('workspacePath', result[0]);
                            applyEnvFromSettings();
                            if (agentBridge) { agentBridge.reinit(); agentBridge = null; }
                            mainWindow && mainWindow.webContents.send('main-message', {
                                type: 'workspaceChanged',
                                path: result[0],
                            });
                        }
                    },
                },
                { type: 'separator' },
                { role: 'quit', label: 'Exit' },
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'Agent',
            submenu: [
                {
                    label: 'Set API Key…',
                    accelerator: 'CmdOrCtrl+Shift+K',
                    async click() { await handleSetApiKey(); },
                },
                {
                    label: 'Clear Session',
                    accelerator: 'CmdOrCtrl+Shift+C',
                    click() {
                        if (agentBridge) agentBridge.reset();
                        mainWindow && mainWindow.webContents.send('main-message', { type: 'sessionCleared' });
                    },
                },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Open GitHub Repository',
                    click() { shell.openExternal('https://github.com/codomium/FreeCode'); },
                },
                {
                    label: 'Anthropic Console (get API key)',
                    click() { shell.openExternal('https://console.anthropic.com/settings/keys'); },
                },
            ],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Set API key dialog ────────────────────────────────────────────────────────

async function handleSetApiKey() {
    const result = await showApiKeyDialog();
    if (result && result.trim().length > 10) {
        storeApiKey(result.trim());
        applyEnvFromSettings();
        if (agentBridge) { captureAgentMessages(); agentBridge.reinit(); agentBridge = null; }
        mainWindow && mainWindow.webContents.send('main-message', { type: 'apiKeySet' });
        dialog.showMessageBoxSync(mainWindow, {
            type:    'info',
            title:   'API Key Saved',
            message: 'API key saved successfully. The agent will use it on the next message.',
            buttons: ['OK'],
        });
    }
}

/**
 * Open a modal dialog window for API key input.
 * Returns the entered key string, or null if cancelled.
 */
function showApiKeyDialog() {
    return new Promise((resolve) => {
        const dialogWin = new BrowserWindow({
            width:       520,
            height:      230,
            parent:      mainWindow,
            modal:       true,
            show:        false,
            resizable:   false,
            minimizable: false,
            maximizable: false,
            title:       'Set API Key — freeCode',
            webPreferences: {
                preload:          path.join(__dirname, 'dialog-preload.js'),
                contextIsolation: true,
                nodeIntegration:  false,
                sandbox:          false,
            },
            backgroundColor: '#1e1e1e',
        });

        dialogWin.setMenu(null);
        dialogWin.loadFile(path.join(__dirname, 'api-key-dialog.html'));
        dialogWin.once('ready-to-show', () => dialogWin.show());

        const onSubmit = (_event, value) => {
            cleanup();
            resolve(value || null);
        };
        const onCancel = () => {
            cleanup();
            resolve(null);
        };

        ipcMain.once('dialog-submit', onSubmit);
        ipcMain.once('dialog-cancel', onCancel);

        function cleanup() {
            ipcMain.removeListener('dialog-submit', onSubmit);
            ipcMain.removeListener('dialog-cancel', onCancel);
            if (!dialogWin.isDestroyed()) dialogWin.close();
        }

        dialogWin.on('closed', () => {
            cleanup();
            resolve(null);
        });
    });
}

// ── IPC message handlers ──────────────────────────────────────────────────────

ipcMain.on('renderer-message', async (event, msg) => {
    if (!msg || typeof msg !== 'object') return;

    const send = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('main-message', data);
        }
    };

    switch (msg.type) {

        // ── Renderer ready: send initialisation data ──────────────────────────
        case 'ready': {
            const s = getSettings();
            const activeSession = readJson('activeSession', null);
            const activeMessages = (activeSession && Array.isArray(activeSession.messages) && activeSession.messages.length > 0)
                ? activeSession.messages : null;
            const activeSessionId = (activeSession && activeSession.sessionId) || null;
            const activeSessionGoal = (activeSession && activeSession.sessionGoal) || null;

            send({
                type:               'initialized',
                model:              s.model || 'claude-sonnet-4-6',
                mode:               s.permissionMode || 'default',
                thinkingMode:       !!s.nvidiaThinkingMode,
                autoAttachActiveFile: !!s.autoAttachActiveFile,
                hasApiKey:          hasApiKey(),
                activeSession:      activeMessages,
                activeSessionId,
                activeSessionGoal,
                workspacePath:      s.workspacePath || os.homedir(),
                defaultShell:       s.defaultShell || 'auto',
                // full settings for settings panel
                maxTurns:           s.maxTurns || 20,
                showToolOutput:     s.showToolOutput !== false,
                hasNvidiaKey:       !!(s.nvidiaApiKey || process.env.NVIDIA_API_KEY),
                customProviders:    Array.isArray(s.providers) ? s.providers : (Array.isArray(s.customProviders) ? s.customProviders : []),
                providers:          Array.isArray(s.providers) ? s.providers : (Array.isArray(s.customProviders) ? s.customProviders : []),
                multiAgentEnabled:  !!s.multiAgentEnabled,
                multiAgentStrategy: s.multiAgentStrategy || 'parallel',
                systemPromptPreset: s.systemPromptPreset || 'expert-engineer',
                mcpServers:         (s.mcpServers && typeof s.mcpServers === 'object') ? s.mcpServers : {},
            });

            // Report which shell the integrated terminal will use
            // (deferred so main window is already ready to receive it)
            setImmediate(() => {
                const sh = detectPreferredShell();
                send({ type: 'shellInfo', shell: sh.type });
            });

            // Auto-restore session into agent bridge
            if (activeMessages && activeMessages.length > 0) {
                await getBridge()._init().catch(() => {});
                getBridge().resume(activeMessages, activeSessionGoal, activeSessionId);
            }
            break;
        }

        // ── Send a chat message to the agent ──────────────────────────────────
        case 'send': {
            await handleRunPrompt(msg.message, msg.contextFiles, msg.fileRefs, send);
            break;
        }

        // ── Cancel current generation ─────────────────────────────────────────
        case 'cancel': {
            isCancelled = true;
            if (agentBridge) agentBridge.cancel();
            break;
        }

        // ── Interactive stdin for a running Bash job ──────────────────────────
        case 'bashStdin': {
            if (agentBridge && typeof agentBridge._sendBashStdin === 'function') {
                agentBridge._sendBashStdin(msg.jobId, msg.text || '');
            }
            break;
        }

        // ── Clear session ─────────────────────────────────────────────────────
        case 'clear': {
            if (agentBridge) agentBridge.reset();
            savedAgentMessages = null; // discard any stale context from a previous reinit
            isCancelled = false;
            send({ type: 'sessionCleared' });
            break;
        }

        // ── Permission response from renderer (default mode interactive prompts) ─
        case 'permissionResponse': {
            if (agentBridge && typeof agentBridge.resolvePermission === 'function') {
                agentBridge.resolvePermission(msg.reqId, !!msg.allowed);
            }
            break;
        }

        // ── Question response from renderer (AskUser tool IPC bridge) ──────────
        case 'questionResponse': {
            if (agentBridge && typeof agentBridge.resolveQuestion === 'function') {
                agentBridge.resolveQuestion(msg.reqId, msg.answer || '');
            }
            break;
        }

        // ── Switch model ──────────────────────────────────────────────────────
        case 'model': {
            saveSetting('model', msg.model);
            if (agentBridge) agentBridge.switchModel(msg.model);
            process.env.ANTHROPIC_MODEL = msg.model;
            send({ type: 'modelChanged', model: msg.model });
            break;
        }

        // ── Switch permission mode ────────────────────────────────────────────
        case 'mode': {
            saveSetting('permissionMode', msg.mode);
            process.env.CLAUDE_CODE_PERMISSION_MODE = msg.mode;
            if (agentBridge) { captureAgentMessages(); agentBridge.reinit(); agentBridge = null; }
            break;
        }

        // ── Toggle NVIDIA thinking mode ───────────────────────────────────────
        case 'thinkingMode': {
            saveSetting('nvidiaThinkingMode', !!msg.enabled);
            process.env.NVIDIA_THINKING_MODE = String(!!msg.enabled);
            if (agentBridge) { captureAgentMessages(); agentBridge.reinit(); agentBridge = null; }
            send({ type: 'thinkingModeChanged', enabled: !!msg.enabled });
            break;
        }

        // ── Copy text to clipboard ────────────────────────────────────────────
        case 'copyToClipboard': {
            clipboard.writeText(String(msg.text || ''));
            break;
        }

        // ── File picker ───────────────────────────────────────────────────────
        case 'pickFile': {
            const files = dialog.showOpenDialogSync(mainWindow, {
                title:      'Add file to context',
                properties: ['openFile'],
            });
            if (files && files[0]) {
                await handleAddContextFile(files[0], send);
            }
            break;
        }

        // ── Add specific file to context ──────────────────────────────────────
        case 'addContextFile': {
            if (msg.path) await handleAddContextFile(msg.path, send);
            break;
        }

        // ── File search (autocomplete) ────────────────────────────────────────
        case 'fileSearch': {
            const results = await searchFiles(msg.query || '');
            send({ type: 'fileSearchResults', files: results });
            break;
        }

        // ── Apply code to a file (with file picker) ───────────────────────────
        case 'applyCodeToFile': {
            const files = dialog.showOpenDialogSync(mainWindow, {
                title:      'Apply code to this file',
                properties: ['openFile'],
            });
            if (files && files[0]) {
                try {
                    fs.writeFileSync(files[0], msg.code || '', 'utf8');
                    send({ type: 'info', message: 'Code applied to ' + path.basename(files[0]) });
                } catch (err) {
                    send({ type: 'error', message: 'Could not write file: ' + err.message });
                }
            }
            break;
        }

        // ── Export conversation as Markdown ───────────────────────────────────
        case 'exportConversation': {
            const content     = String(msg.markdown || '');
            const defaultName = 'conversation-' + new Date().toISOString().slice(0, 10) + '.md';
            const savePath = dialog.showSaveDialogSync(mainWindow, {
                title:       'Export conversation as Markdown',
                defaultPath: path.join(getSettings().workspacePath || os.homedir(), defaultName),
                filters:     [{ name: 'Markdown', extensions: ['md'] }],
            });
            if (savePath) {
                try {
                    fs.writeFileSync(savePath, content, 'utf8');
                } catch (err) {
                    send({ type: 'error', message: 'Export failed: ' + err.message });
                }
            }
            break;
        }

        // ── Get active file content (not available in standalone app) ─────────
        case 'getActiveFileContent': {
            send({ type: 'activeFileContent', content: null, fileName: null });
            break;
        }

        // ── Add active file (not available; no editor integration) ────────────
        case 'addActiveFile': {
            // In standalone mode, prompt the user to pick a file instead
            const files = dialog.showOpenDialogSync(mainWindow, {
                title:      'Add file to context',
                properties: ['openFile'],
            });
            if (files && files[0]) {
                await handleAddContextFile(files[0], send);
            }
            break;
        }

        // ── Git context ───────────────────────────────────────────────────────
        case 'getGitContext': {
            const cwd = getSettings().workspacePath || os.homedir();
            const run = (args) => new Promise((resolve) => {
                execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
                    resolve(err ? '' : stdout.trim());
                });
            });
            const [branch, status, diffStat] = await Promise.all([
                run(['rev-parse', '--abbrev-ref', 'HEAD']),
                run(['status', '--short']),
                run(['diff', '--stat']),
            ]);
            const parts = [];
            if (branch) parts.push('Branch: ' + branch);
            parts.push(status ? 'Changed files:\n' + status : 'Working tree clean');
            if (diffStat) parts.push('Diff summary:\n' + diffStat);
            send({ type: 'gitContext', content: parts.join('\n\n'), branch: branch || '' });
            break;
        }

        // ── Folder tree for @folder context chip ─────────────────────────────
        case 'getFolderTree': {
            const rootDir = getSettings().workspacePath || os.homedir();
            const SKIP_DIRS = new Set(['node_modules','.git','dist','.next','__pycache__','.cache','.idea','.vscode','build','out','.DS_Store']);
            function buildTextTree(dir, prefix, depth) {
                if (depth > 4) return '';
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
                entries.sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                });
                let out = '';
                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
                    const isLast = i === entries.length - 1;
                    const connector = isLast ? '└── ' : '├── ';
                    const childPrefix = prefix + (isLast ? '    ' : '│   ');
                    out += prefix + connector + e.name + (e.isDirectory() ? '/' : '') + '\n';
                    if (e.isDirectory()) {
                        out += buildTextTree(path.join(dir, e.name), childPrefix, depth + 1);
                    }
                }
                return out;
            }
            const tree = path.basename(rootDir) + '/\n' + buildTextTree(rootDir, '', 0);
            send({ type: 'folderTree', content: tree });
            break;
        }

        // ── Fetch URL for @url context chip ───────────────────────────────────
        case 'fetchUrl': {
            const targetUrl = String(msg.url || '');
            if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
                send({ type: 'urlContent', url: targetUrl, content: '(invalid URL)', error: 'Invalid URL' });
                break;
            }
            // SSRF guard: block requests to loopback, private, link-local and metadata addresses
            const PRIVATE_IP_RE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc00:|fd|fe80:|0x|0177)/i;
            let reqOpts;
            try { reqOpts = new URL(targetUrl); } catch {
                send({ type: 'urlContent', url: targetUrl, content: '(malformed URL)', error: 'Malformed URL' });
                break;
            }
            const hostname = reqOpts.hostname.toLowerCase();
            if (PRIVATE_IP_RE.test(hostname) || hostname === '[::1]') {
                send({ type: 'urlContent', url: targetUrl, content: '(blocked: private/loopback addresses are not allowed)', error: 'Blocked hostname' });
                break;
            }
            const MAX_URL_CONTENT_BYTES = 20000;
            try {
                const content = await new Promise((resolve, reject) => {
                    const httpMod = targetUrl.startsWith('https://') ? require('https') : require('http');
                    const req = httpMod.get({ hostname: reqOpts.hostname, path: reqOpts.pathname + (reqOpts.search || ''),
                        port: reqOpts.port, headers: { 'User-Agent': 'freeCode/1.0 (context-fetch)', 'Accept': 'text/html,text/plain' } },
                        (res) => {
                            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                                resolve(`(redirect to ${res.headers.location} — please use the final URL directly)`);
                                return;
                            }
                            const chunks = [];
                            res.on('data', (c) => chunks.push(c));
                            res.on('end', () => {
                                let text = Buffer.concat(chunks).toString('utf8');
                                // Remove embedded scripts and styles completely (content is used as
                                // AI context text, not rendered as HTML — strip tags for readability).
                                // Use character-class negation to avoid false tag reconstruction:
                                text = text.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ');
                                text = text.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ');
                                // Remove remaining tags (non-greedy, no nesting needed for plain text)
                                text = text.replace(/<[^>]*>/g, ' ');
                                // Collapse whitespace
                                text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
                                // Limit content size
                                if (text.length > MAX_URL_CONTENT_BYTES) text = text.slice(0, MAX_URL_CONTENT_BYTES) + '\n…(truncated)';
                                resolve(text);
                            });
                        }
                    );
                    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
                    req.on('error', reject);
                });
                send({ type: 'urlContent', url: targetUrl, content });
            } catch (err) {
                send({ type: 'urlContent', url: targetUrl, content: `(failed to fetch: ${err.message})`, error: err.message });
            }
            break;
        }

        // ── Grep workspace for function/class symbols ─────────────────────────
        case 'getSymbols': {
            const wsPath = getSettings().workspacePath || os.homedir();
            const SYMBOL_EXTS = new Set(['.js','.ts','.jsx','.tsx','.mjs','.cjs','.py','.go','.rs','.java','.cpp','.c','.cs','.rb','.php','.swift','.kt']);
            const SKIP_DIRS2 = new Set(['node_modules','.git','dist','.next','__pycache__','.cache','build','out']);
            const results = [];
            function scanDir(dir, depth) {
                if (depth > 6 || results.length > 500) return;
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const e of entries) {
                    if (e.isDirectory()) {
                        if (!SKIP_DIRS2.has(e.name)) scanDir(path.join(dir, e.name), depth + 1);
                    } else {
                        const ext = path.extname(e.name).toLowerCase();
                        if (!SYMBOL_EXTS.has(ext)) continue;
                        try {
                            const relPath = path.relative(wsPath, path.join(dir, e.name));
                            const content = fs.readFileSync(path.join(dir, e.name), 'utf8');
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length && results.length < 500; i++) {
                                const line = lines[i];
                                // Match common function/class/method declarations
                                if (/^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w|^\s*(export\s+)?(abstract\s+)?class\s+\w|^\s*def\s+\w|^\s*func\s+\w|^\s*(pub\s+)?(async\s+)?fn\s+\w/
                                    .test(line)) {
                                    results.push(`${relPath}:${i + 1}: ${line.trim()}`);
                                }
                            }
                        } catch { /* skip */ }
                    }
                }
            }
            scanDir(wsPath, 0);
            const content = results.length > 0
                ? results.join('\n')
                : '(no function/class symbols found in workspace)';
            send({ type: 'symbolsContext', content });
            break;
        }

        // ── Workspace diagnostics (not available in standalone app) ──────────
        case 'getWorkspaceDiagnostics': {
            send({ type: 'workspaceDiagnostics', diagnostics: [] });
            break;
        }

        // ── Open editors (not available in standalone app) ────────────────────
        case 'getOpenEditors': {
            send({ type: 'openEditors', files: [] });
            break;
        }

        // ── Toggle auto-attach active file ────────────────────────────────────
        case 'toggleAutoAttach': {
            const next = !getSettings().autoAttachActiveFile;
            saveSetting('autoAttachActiveFile', next);
            send({ type: 'autoAttachState', enabled: next });
            break;
        }

        // ── Pinned files ──────────────────────────────────────────────────────
        case 'getPinnedFiles': {
            const pinned = (getSettings().pinnedFiles || []).filter(p => {
                try { return fs.existsSync(p); } catch { return false; }
            });
            send({
                type: 'pinnedFiles',
                files: pinned.map(p => ({ name: path.basename(p), path: p })),
            });
            break;
        }

        case 'pinFile': {
            const pinned = [...(getSettings().pinnedFiles || [])];
            if (msg.path && !pinned.includes(msg.path)) {
                pinned.push(msg.path);
                saveSetting('pinnedFiles', pinned);
            }
            break;
        }

        case 'unpinFile': {
            const pinned = (getSettings().pinnedFiles || []).filter(p => p !== msg.path);
            saveSetting('pinnedFiles', pinned);
            break;
        }

        // ── Session history ───────────────────────────────────────────────────
        case 'saveSession': {
            if (msg.messages && msg.messages.length > 0) {
                const sessions = readJson('history', []);
                const firstUser = msg.messages.find(m => m.type === 'user');
                const title = firstUser
                    ? firstUser.text.slice(0, 80).replace(/\n/g, ' ')
                    : 'Untitled conversation';
                sessions.unshift({
                    id:          Date.now().toString(),
                    title,
                    createdAt:   Date.now(),
                    messages:    msg.messages,
                    sessionGoal: msg.sessionGoal || null,
                });
                if (sessions.length > 30) sessions.length = 30;
                writeJson('history', sessions);
            }
            break;
        }

        case 'getHistory': {
            const sessions = readJson('history', []);
            send({
                type: 'historyData',
                sessions: sessions.map(s => ({
                    id:           s.id,
                    title:        s.title,
                    createdAt:    s.createdAt,
                    messageCount: s.messages ? s.messages.length : 0,
                    sessionGoal:  s.sessionGoal || null,
                })),
            });
            break;
        }

        case 'loadSession': {
            const sessions = readJson('history', []);
            const session  = sessions.find(s => s.id === msg.id);
            if (session) {
                send({ type: 'sessionData', id: session.id, messages: session.messages || [], sessionGoal: session.sessionGoal || null });
            }
            break;
        }

        case 'resumeFromHistory': {
            const sessions = readJson('history', []);
            const session  = sessions.find(s => s.id === msg.id);
            if (session) {
                send({ type: 'resumeFromHistoryData', id: session.id, messages: session.messages || [], sessionGoal: session.sessionGoal || null });
            }
            break;
        }

        case 'updateSession': {
            const sessions = readJson('history', []);
            const sess     = sessions.find(s => s.id === msg.id);
            if (sess && Array.isArray(msg.messages) && msg.messages.length > 0) {
                sess.messages     = msg.messages.slice(-MAX_SESSION_MESSAGES);
                sess.messageCount = sess.messages.length;
                const firstUser   = sess.messages.find(m => m.type === 'user');
                if (firstUser) sess.title = firstUser.text.slice(0, 80).replace(/\n/g, ' ');
                if (msg.sessionGoal) sess.sessionGoal = msg.sessionGoal;
                writeJson('history', sessions);
            }
            break;
        }

        case 'renameSession': {
            const sessions = readJson('history', []);
            const sess     = sessions.find(s => s.id === msg.id);
            if (sess && msg.title) {
                sess.title = String(msg.title).slice(0, 120);
                writeJson('history', sessions);
                send({
                    type: 'historyData',
                    sessions: sessions.map(s => ({
                        id: s.id, title: s.title, createdAt: s.createdAt,
                        messageCount: s.messages ? s.messages.length : 0,
                    })),
                });
            }
            break;
        }

        case 'deleteSession': {
            let sessions = readJson('history', []);
            sessions     = sessions.filter(s => s.id !== msg.id);
            writeJson('history', sessions);
            send({
                type: 'historyData',
                sessions: sessions.map(s => ({
                    id: s.id, title: s.title, createdAt: s.createdAt,
                    messageCount: s.messages ? s.messages.length : 0,
                })),
            });
            break;
        }

        case 'autoSaveSession': {
            if (msg.messages && msg.messages.length > 0) {
                const capped = msg.messages.slice(-MAX_SESSION_MESSAGES);
                writeJson('activeSession', {
                    messages:     capped,
                    sessionId:    msg.sessionId || null,
                    sessionGoal:  msg.sessionGoal || null,
                    savedAt:      Date.now(),
                });
            } else {
                writeJson('activeSession', null);
            }
            break;
        }

        case 'resumeSession': {
            if (msg.messages && msg.messages.length > 0) {
                try {
                    const bridge = getBridge();
                    await bridge._init();
                    bridge.resume(msg.messages, msg.sessionGoal || null, msg.sessionId || null);
                } catch (err) {
                    send({ type: 'error', message: 'Failed to resume session: ' + err.message });
                }
            }
            break;
        }

        case 'setGoal': {
            try {
                const bridge = getBridge();
                await bridge._init();
                bridge.setGoal(msg.goal || null, msg.sessionId || null);
            } catch { /* ignore */ }
            break;
        }

        // ── Command shortcuts ─────────────────────────────────────────────────
        case 'runCommand': {
            if (msg.command === 'openClaudeCode.setApiKey') {
                await handleSetApiKey();
            } else if (msg.command === 'openWorkspaceFolder') {
                // Open workspace folder dialog (triggered from settings panel)
                const result = dialog.showOpenDialogSync(mainWindow, {
                    title:      'Select workspace folder',
                    properties: ['openDirectory'],
                });
                if (result && result[0]) {
                    saveSetting('workspacePath', result[0]);
                    applyEnvFromSettings();
                    if (agentBridge) { agentBridge.reinit(); agentBridge = null; }
                    mainWindow && mainWindow.webContents.send('main-message', {
                        type: 'workspaceChanged',
                        path: result[0],
                    });
                }
            } else if (msg.command === 'workbench.action.openSettings') {
                // Legacy: renderer will now show in-app settings panel; this is a no-op fallback
            } else if (msg.command === 'vscode.open') {
                const url = Array.isArray(msg.args) ? msg.args[0] : msg.args;
                if (url && /^https?:\/\//.test(String(url))) {
                    shell.openExternal(String(url));
                }
            } else if (msg.command === 'runInTerminal') {
                handleRunInTerminal(String(msg.code || ''));
            }
            break;
        }

        // ── Run code in terminal ──────────────────────────────────────────────
        case 'runInTerminal': {
            handleRunInTerminal(String(msg.code || ''));
            break;
        }

        // ── Integrated terminal: execute a command and stream output ──────────
        case 'terminalRun': {
            handleTerminalRun(String(msg.command || ''), msg.reqId || null, send);
            break;
        }

        // ── Save a single setting ─────────────────────────────────────────────
        case 'saveSettings': {
            const allowed = ['model','permissionMode','maxTurns','showToolOutput','nvidiaApiKey','workspacePath','defaultShell','multiAgentEnabled','multiAgentStrategy','providers','systemPromptPreset'];
            if (msg.key && allowed.includes(msg.key)) {
                saveSetting(msg.key, msg.value);
                applyEnvFromSettings();
                const reinitKeys = ['permissionMode','maxTurns','nvidiaApiKey','multiAgentEnabled','multiAgentStrategy','providers','systemPromptPreset'];
                if (reinitKeys.includes(msg.key)) {
                    if (agentBridge) { captureAgentMessages(); agentBridge.reinit(); agentBridge = null; }
                }
                if (msg.key === 'model' && agentBridge) {
                    agentBridge.switchModel(msg.value);
                }
                if (msg.key === 'workspacePath') {
                    mainWindow && mainWindow.webContents.send('main-message', {
                        type: 'workspaceChanged',
                        path: msg.value,
                    });
                }
                if (msg.key === 'defaultShell') {
                    _preferredShell = null;
                    const sh = detectPreferredShell();
                    send({ type: 'shellInfo', shell: sh.type });
                }
            }
            break;
        }

        case 'detectShells': {
            const results = {};

            try {
                const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], {
                    encoding: 'utf-8', timeout: 2000, windowsHide: true,
                });
                results.powershell = r.status === 0 && String(r.stdout || '').trim() === 'ok';
            } catch {
                results.powershell = false;
            }

            try {
                const r = spawnSync('wsl.exe', ['--status'], {
                    encoding: 'utf-8', timeout: 3000, windowsHide: true,
                });
                results.wsl = r.status === 0;
            } catch {
                results.wsl = false;
            }

            try {
                const r = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--', 'echo', 'ok'], {
                    encoding: 'utf-8', timeout: 3000, windowsHide: true,
                });
                results.ubuntu = r.status === 0 && String(r.stdout || '').trim() === 'ok';
            } catch {
                results.ubuntu = false;
            }

            if (process.platform !== 'win32') {
                try {
                    const r = spawnSync('bash', ['-c', 'echo ok'], {
                        encoding: 'utf-8', timeout: 1000,
                    });
                    results.bash = r.status === 0;
                } catch {
                    results.bash = false;
                }
            } else {
                results.bash = false;
            }

            try {
                const r = spawnSync('cmd.exe', ['/c', 'echo ok'], {
                    encoding: 'utf-8', timeout: 2000, windowsHide: true,
                });
                results.cmd = r.status === 0;
            } catch {
                results.cmd = false;
            }

            send({ type: 'shellsDetected', shells: results });
            break;
        }

        // ── Save custom providers list ─────────────────────────────────────────
        case 'saveCustomProviders': {
            const providers = Array.isArray(msg.providers) ? msg.providers : [];
            const curr = getSettings();
            const multiAgentEnabled = (typeof msg.multiAgentEnabled === 'boolean')
                ? msg.multiAgentEnabled
                : !!curr.multiAgentEnabled;
            const multiAgentStrategy = msg.multiAgentStrategy || curr.multiAgentStrategy || 'parallel';
            if (multiAgentEnabled && providers.length < MIN_MULTI_AGENT_PROVIDERS) {
                send({
                    type: 'customProvidersError',
                    message: 'Multi-Agent Mode requires at least 3 configured providers.',
                });
                break;
            }
            saveSetting('providers', providers);
            saveSetting('multiAgentEnabled', multiAgentEnabled);
            saveSetting('multiAgentStrategy', multiAgentStrategy);
            applyEnvFromSettings();
            // Reinit bridge so new providers are available on the next turn
            if (agentBridge) { captureAgentMessages(); agentBridge.reinit(); agentBridge = null; }
            send({ type: 'customProvidersSaved', providers });
            break;
        }

        // ── Save MCP servers config ────────────────────────────────────────────
        case 'saveMcpServers': {
            const mcpServers = (msg.mcpServers && typeof msg.mcpServers === 'object') ? msg.mcpServers : {};
            // Write to ~/.claude/settings.json so the v2 agent-loop picks it up
            try {
                const claudeDir  = path.join(require('os').homedir(), '.claude');
                const settingsFile = path.join(claudeDir, 'settings.json');
                fs.mkdirSync(claudeDir, { recursive: true });
                let claudeSettings = {};
                try { claudeSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* new file */ }
                claudeSettings.mcpServers = mcpServers;
                fs.writeFileSync(settingsFile, JSON.stringify(claudeSettings, null, 2), 'utf8');
            } catch (err) {
                console.warn('saveMcpServers: could not write ~/.claude/settings.json:', err.message);
            }
            // Also save in app settings for persistence across restarts
            saveSetting('mcpServers', mcpServers);
            // Reinit bridge so new servers are connected on the next turn
            if (agentBridge) { captureAgentMessages(); agentBridge.reinit(); agentBridge = null; }
            send({ type: 'mcpServersSaved', mcpServers });
            break;
        }

        case 'validateProvider': {
            const p = msg.provider && typeof msg.provider === 'object' ? msg.provider : null;
            const id = p?.id || '';
            if (!p || !p.baseUrl || !p.apiKey) {
                send({ type: 'providerValidated', id, ok: false, error: 'Missing base URL or API key.' });
                break;
            }
            try {
                const headers = {
                    'Authorization': `Bearer ${p.apiKey}`,
                    'Content-Type': 'application/json',
                };
                if (Array.isArray(p.headers)) {
                    for (const h of p.headers) {
                        if (h?.name) headers[h.name] = h.value || '';
                    }
                }
                const url = String(p.baseUrl).replace(/\/+$/, '') + '/models';
                const res = await fetch(url, { method: 'GET', headers });
                if (!res.ok) {
                    send({ type: 'providerValidated', id, ok: false, error: `HTTP ${res.status}` });
                    break;
                }
                send({ type: 'providerValidated', id, ok: true, error: '' });
            } catch (err) {
                send({ type: 'providerValidated', id, ok: false, error: err.message || 'Connection failed' });
            }
            break;
        }

        // ── Open settings / userData folder in system explorer ────────────────
        case 'openSettingsFolder': {
            shell.openPath(getUserData());
            break;
        }

        // ── Directory listing for file explorer ───────────────────────────────
        case 'listDirectory': {
            const dirPath = msg.path || getSettings().workspacePath || os.homedir();
            const SKIP_DIRS = new Set(['node_modules','.git','dist','.next','__pycache__','.cache','.idea','.vscode','build','out','.DS_Store']);
            let readdirInFlight = 0;
            const MAX_READDIR_CONCURRENT = 8;
            const readdirWaiters = [];
            const acquireReaddirSlot = async () => {
                if (readdirInFlight < MAX_READDIR_CONCURRENT) {
                    readdirInFlight++;
                    return;
                }
                await new Promise((resolve) => readdirWaiters.push(resolve));
            };
            const releaseReaddirSlot = () => {
                const next = readdirWaiters.shift();
                if (next) {
                    next();
                    return;
                }
                readdirInFlight--;
            };
            // Async recursive builder — uses fs.promises.readdir so each readdir
            // yields to the event loop, keeping the main process responsive.
            const buildTree = async (dir, depth) => {
                if (depth > 5) return [];
                await acquireReaddirSlot();
                let entries;
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
                finally { releaseReaddirSlot(); }
                const items = [];
                for (const e of entries) {
                    if (e.isDirectory()) {
                        if (SKIP_DIRS.has(e.name)) continue;
                        items.push({
                            name:     e.name,
                            path:     path.join(dir, e.name),
                            type:     'dir',
                            children: await buildTree(path.join(dir, e.name), depth + 1),
                        });
                    } else {
                        items.push({ name: e.name, path: path.join(dir, e.name), type: 'file' });
                    }
                }
                items.sort((a, b) => {
                    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
                });
                return items;
            };
            try {
                const tree = await buildTree(dirPath, 0);
                send({ type: 'directoryListing', path: dirPath, tree });
            } catch (err) {
                send({ type: 'directoryListing', path: dirPath, tree: [], error: err.message });
            }
            break;
        }

        // ── Read file contents for file viewer ────────────────────────────────
        case 'readFile': {
            try {
                const MAX_BYTES = 500 * 1024; // 500 KB limit
                const stats = fs.statSync(msg.path);
                if (stats.size > MAX_BYTES) {
                    send({ type: 'fileData', path: msg.path, name: path.basename(msg.path), content: null,
                        error: `File too large to display (${Math.round(stats.size/1024)} KB)`,
                        purpose: msg.purpose || null });
                } else {
                    const content = fs.readFileSync(msg.path, 'utf8');
                    send({ type: 'fileData', path: msg.path, name: path.basename(msg.path), content, size: stats.size,
                        purpose: msg.purpose || null });
                }
            } catch (err) {
                send({ type: 'fileData', path: msg.path, name: path.basename(msg.path), content: null, error: err.message,
                    purpose: msg.purpose || null });
            }
            break;
        }

        // ── IDE file operations ───────────────────────────────────────────────
        case 'createFile': {
            try {
                const dir = path.dirname(msg.path);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(msg.path, '', 'utf8');
                send({ type: 'fileCreated', path: msg.path, name: path.basename(msg.path) });
            } catch (err) {
                send({ type: 'fileOpError', op: 'createFile', path: msg.path, error: err.message });
            }
            break;
        }

        case 'createDir': {
            try {
                fs.mkdirSync(msg.path, { recursive: true });
                send({ type: 'dirCreated', path: msg.path, name: path.basename(msg.path) });
            } catch (err) {
                send({ type: 'fileOpError', op: 'createDir', path: msg.path, error: err.message });
            }
            break;
        }

        case 'renameFile': {
            try {
                fs.renameSync(msg.oldPath, msg.newPath);
                send({ type: 'fileRenamed', oldPath: msg.oldPath, newPath: msg.newPath });
            } catch (err) {
                send({ type: 'fileOpError', op: 'renameFile', path: msg.oldPath, error: err.message });
            }
            break;
        }

        case 'deleteFile': {
            try {
                fs.rmSync(msg.path, { recursive: true, force: true });
                send({ type: 'fileDeleted', path: msg.path });
            } catch (err) {
                send({ type: 'fileOpError', op: 'deleteFile', path: msg.path, error: err.message });
            }
            break;
        }

        case 'writeFile': {
            try {
                fs.writeFileSync(msg.path, msg.content || '', 'utf8');
                send({ type: 'fileWritten', path: msg.path, purpose: msg.purpose || null });
            } catch (err) {
                send({ type: 'fileOpError', op: 'writeFile', path: msg.path, error: err.message });
            }
            break;
        }

        case 'watchWorkspace': {
            // Stop any existing watcher before starting a new one
            if (global._workspaceWatcher) {
                try { global._workspaceWatcher.close(); } catch (closeErr) {
                    console.warn('watchWorkspace: error closing previous watcher:', closeErr.message);
                }
                global._workspaceWatcher = null;
            }
            const watchPath = msg.path || currentWorkspacePath;
            if (watchPath && fs.existsSync(watchPath)) {
                try {
                    global._workspaceWatcher = fs.watch(watchPath, { recursive: true }, (event, filename) => {
                        // Include full path so the renderer can match it against open tabs
                        const fullPath = filename ? path.join(watchPath, filename) : '';
                        send({ type: 'fileWatchEvent', event, filename: filename || '', path: fullPath });
                    });
                } catch (watchErr) {
                    console.warn('watchWorkspace: fs.watch failed for', watchPath, ':', watchErr.message);
                }
            }
            break;
        }

        default:
            break;
    }
});

// ── Handle run-in-terminal ────────────────────────────────────────────────────

/**
 * Detect the preferred shell.
 * Uses explicit user preference when set; otherwise auto-detects
 * with PowerShell-first behavior on Windows.
 * Result is cached after first call.
 */
let _preferredShell = null;

const POWERSHELL_SHIMS_MODULE = `# freeCode-shims.psm1 — freeCode PowerShell POSIX compatibility shims
function which { param([string]$cmd) $r = Get-Command $cmd -ErrorAction SilentlyContinue; if ($r) { $r.Source } else { Write-Error "which: $cmd: not found"; exit 1 } }
function grep  { param([string]$pat, [Parameter(ValueFromRemainingArguments)][string[]]$f) if ($f) { Select-String -Pattern $pat -Path $f | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" } } else { $input | Select-String -Pattern $pat | ForEach-Object { $_.Line } } }
function cat   { param([Parameter(ValueFromRemainingArguments)][string[]]$paths) if ($paths) { Get-Content $paths } else { $input } }
function touch { param([string]$p) if (Test-Path $p) { (Get-Item $p).LastWriteTime = Get-Date } else { New-Item -ItemType File -Path $p -Force | Out-Null } }
function wc    { param([string]$flag="-l") $lines = @($input); switch ($flag) { "-l" { $lines.Count } "-c" { ($lines -join "\`n").Length } "-w" { ($lines -join " ").Split() | Where-Object { $_ } | Measure-Object | Select-Object -Expand Count } default { $lines.Count } } }
function head  { param([int]$n=10, [string]$file="") if ($file) { Get-Content $file -TotalCount $n } else { $input | Select-Object -First $n } }
function tail  { param([int]$n=10, [string]$file="") if ($file) { Get-Content $file -Tail $n } else { $input | Select-Object -Last $n } }
function find  { param([string]$path=".", [string]$name="*") Get-ChildItem -Path $path -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -Expand FullName }
function pwd   { (Get-Location).Path }
function ls    { param([Parameter(ValueFromRemainingArguments)][string[]]$a) Get-ChildItem @a }
function mkdir { param([Parameter(ValueFromRemainingArguments)][string[]]$a) New-Item -ItemType Directory @a -Force }
function rm    { param([switch]$r, [switch]$f, [Parameter(ValueFromRemainingArguments)][string[]]$paths) Remove-Item $paths -Recurse:$r -Force:$f -ErrorAction SilentlyContinue }
function cp    { param([string]$src, [string]$dst) Copy-Item -Path $src -Destination $dst -Recurse -Force }
function mv    { param([string]$src, [string]$dst) Move-Item -Path $src -Destination $dst -Force }
function echo  { param([Parameter(ValueFromRemainingArguments)][string[]]$a) Write-Output ($a -join " ") }
function sed   { param([string]$expr, [string]$file="") if ($expr -match "^s/(.+)/(.+)/") { $pat=$Matches[1]; $rep=$Matches[2]; if ($file) { (Get-Content $file) -replace $pat,$rep | Set-Content $file } else { $input | ForEach-Object { $_ -replace $pat,$rep } } } }
function awk   { param([string]$prog, [Parameter(ValueFromRemainingArguments)][string[]]$files) Write-Warning "awk: limited PowerShell shim — consider installing gawk via winget" }
Export-ModuleMember -Function *
`;

function resolveShellByName(name) {
    const map = {
        powershell: {
            type: 'powershell',
            exe: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-Command'],
            syntax: 'powershell',
        },
        wsl: {
            type: 'wsl',
            exe: 'wsl.exe',
            args: ['bash', '-c'],
            syntax: 'bash',
        },
        ubuntu: {
            type: 'ubuntu',
            exe: 'wsl.exe',
            args: ['-d', 'Ubuntu', '--', 'bash', '-c'],
            syntax: 'bash',
        },
        bash: {
            type: 'bash',
            exe: 'bash',
            args: ['-c'],
            syntax: 'bash',
        },
        cmd: {
            type: 'cmd',
            exe: 'cmd.exe',
            args: ['/c'],
            syntax: 'cmd',
        },
    };
    return map[name] || map.powershell;
}

function isPowerShellAvailable() {
    try {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
            encoding: 'utf-8', timeout: 2000, windowsHide: true,
        });
        return r.status === 0;
    } catch {
        return false;
    }
}

function ensurePowerShellShimsModule() {
    const modPath = path.join(getUserData(), 'freeCode-shims.psm1');
    if (!fs.existsSync(modPath)) {
        fs.writeFileSync(modPath, POWERSHELL_SHIMS_MODULE, 'utf8');
    }
    return modPath;
}

function quotePowerShellPath(p) {
    return String(p || '').replace(/'/g, "''");
}

function detectPreferredShell() {
    if (_preferredShell) return _preferredShell;

    const s = getSettings();
    const pref = s.defaultShell || 'auto';
    if (pref !== 'auto') {
        _preferredShell = resolveShellByName(pref);
        return _preferredShell;
    }

    if (process.platform !== 'win32') {
        _preferredShell = resolveShellByName('bash');
        return _preferredShell;
    }

    if (isPowerShellAvailable()) {
        _preferredShell = resolveShellByName('powershell');
        return _preferredShell;
    }

    _preferredShell = resolveShellByName('cmd');
    return _preferredShell;
}

function handleRunInTerminal(code) {
    if (!code.trim()) return;
    const cwd = getSettings().workspacePath || os.homedir();
    const { spawn } = require('child_process');
    const shell = detectPreferredShell();

    if (process.platform === 'win32') {
        if (shell.type === 'ubuntu') {
            // Open a new WSL Ubuntu window
            spawn('wsl.exe', ['-d', 'Ubuntu', '--'], {
                cwd, detached: true, stdio: 'ignore', windowsHide: false,
            });
        } else if (shell.type === 'wsl') {
            spawn('wsl.exe', [], {
                cwd, detached: true, stdio: 'ignore', windowsHide: false,
            });
        } else if (shell.type === 'cmd') {
            spawn('cmd.exe', ['/k', code], {
                cwd, detached: true, stdio: 'ignore', windowsHide: false,
            });
        } else {
            spawn('powershell.exe', [
                '-NoProfile', '-NoExit', '-Command', code,
            ], { cwd, detached: true, stdio: 'ignore', windowsHide: false });
        }
    } else {
        spawn('bash', ['-c', code], { cwd, detached: true, stdio: 'ignore' });
    }
}

// ── Integrated terminal: stream command output to renderer ────────────────────

const MAX_TERMINAL_BYTES = 512 * 1024; // 512 KB

function handleTerminalRun(command, reqId, send) {
    if (!command || !command.trim()) {
        send({ type: 'terminalOutput', reqId, stream: 'info', data: '(empty command)\n', done: true });
        return;
    }

    const cwd = getSettings().workspacePath || os.homedir();
    const shell = detectPreferredShell();

    let shellExe = shell.exe;
    let shellArgs = [...shell.args, command];
    if (shell.type === 'powershell') {
        const modulePath = ensurePowerShellShimsModule();
        const prelude = `Import-Module '${quotePowerShellPath(modulePath)}' -Force; `;
        shellArgs = [...shell.args, `${prelude}${command}`];
    } else if (shell.type === 'cmd') {
        shellExe = 'cmd.exe';
        shellArgs = ['/c', command];
    }

    const { spawn } = require('child_process');
    const proc = spawn(shellExe, shellArgs, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let totalBytes = 0;

    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    proc.stdout.on('data', (chunk) => {
        const text = stripAnsi(chunk.toString());
        totalBytes += text.length;
        if (totalBytes < MAX_TERMINAL_BYTES) {
            send({ type: 'terminalOutput', reqId, stream: 'stdout', data: text, done: false });
        }
    });

    proc.stderr.on('data', (chunk) => {
        const text = stripAnsi(chunk.toString());
        totalBytes += text.length;
        if (totalBytes < MAX_TERMINAL_BYTES) {
            send({ type: 'terminalOutput', reqId, stream: 'stderr', data: text, done: false });
        }
    });

    proc.on('close', (code) => {
        const exitMsg = code !== 0 ? `\nProcess exited with code ${code}\n` : '';
        send({ type: 'terminalOutput', reqId, stream: 'info', data: exitMsg, done: true, exitCode: code });
    });

    proc.on('error', (err) => {
        send({ type: 'terminalOutput', reqId, stream: 'stderr', data: `Error: ${err.message}\n`, done: true, exitCode: -1 });
    });
}

// ── Handle prompt run with context files ─────────────────────────────────────

async function handleRunPrompt(message, contextFilePaths, fileRefs, send) {
    isCancelled = false;

    const shellHint = detectPreferredShell();
    const basePrompt = `[Execution shell: ${shellHint.type} (${shellHint.syntax}). Generate shell commands that match this shell syntax.]\n\n${message}`;
    let fullPrompt = basePrompt;

    // Inject context file contents
    const allPaths = new Set(contextFilePaths || []);
    const cwd      = getSettings().workspacePath || os.homedir();

    if (fileRefs && fileRefs.length > 0) {
        for (const ref of fileRefs) {
            const abs = path.resolve(cwd, ref);
            if (fs.existsSync(abs)) allPaths.add(abs);
        }
    }

    if (allPaths.size > 0) {
        const fileContents = [];
        for (const fp of allPaths) {
            try {
                const content = fs.readFileSync(fp, 'utf8');
                const rel     = path.relative(cwd, fp);
                fileContents.push('\n\n--- File: ' + rel + ' ---\n' + content);
            } catch { /* skip unreadable */ }
        }
        if (fileContents.length > 0) {
            fullPrompt = basePrompt + '\n\n[Context files:]' + fileContents.join('');
        }
    }

    // Apply current settings to process env before running
    applyEnvFromSettings();
    const shouldUseMulti = String(process.env.MULTI_AGENT_ENABLED || 'false') === 'true';
    if (agentBridge) {
        const isMulti = agentBridge instanceof MultiAgentOrchestrator;
        if (isMulti !== shouldUseMulti) {
            captureAgentMessages();
            agentBridge.reinit();
            agentBridge = null;
        }
    }

    const bridge = getBridge();

    // ── Retry loop ────────────────────────────────────────────────────────────
    for (let attempt = 0; ; attempt++) {
        if (isCancelled) return;

        let retryErrorMsg = null;

        await bridge.run(fullPrompt, (event) => {
            if (isCancelled) return;
            if (event.type === 'error' && isRateLimitError(event.message)) {
                retryErrorMsg = event.message;
                return;
            }
            send(event);
        });

        if (isCancelled) return;

        if (!retryErrorMsg) {
            send({ type: 'stop' });
            return;
        }

        if (attempt >= RETRY_DELAYS_MS.length) {
            send({
                type:    'error',
                message: retryErrorMsg + ' (failed after ' + (attempt + 1) + ' attempts)',
            });
            send({ type: 'stop' });
            return;
        }

        const delaySec = Math.ceil(RETRY_DELAYS_MS[attempt] / 1000);
        send({ type: 'retrying', attempt: attempt + 1, delaySeconds: delaySec, maxAttempts: RETRY_DELAYS_MS.length });

        await new Promise((resolve) => {
            let remaining = delaySec;
            const tick = setInterval(() => {
                if (isCancelled) { clearInterval(tick); resolve(); return; }
                remaining--;
                if (remaining <= 0) { clearInterval(tick); resolve(); return; }
                send({ type: 'retrying', attempt: attempt + 1, delaySeconds: remaining, maxAttempts: RETRY_DELAYS_MS.length });
            }, 1000);
        });

        if (isCancelled) return;
    }
}

// ── Handle add-context-file ───────────────────────────────────────────────────

async function handleAddContextFile(filePath, send) {
    send({ type: 'fileContent', path: filePath, name: path.basename(filePath) });
}

// ── File search ───────────────────────────────────────────────────────────────

function searchFiles(query) {
    const cwd     = getSettings().workspacePath || os.homedir();
    const results = [];
    const q       = (query || '').toLowerCase();
    const SKIP    = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache']);
    const MAX     = 20;

    async function walk(dir, depth) {
        if (results.length >= MAX || depth > 6) return;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (results.length >= MAX) break;
            if (e.isDirectory()) {
                if (!SKIP.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
            } else if (e.isFile()) {
                if (!q || e.name.toLowerCase().includes(q)) {
                    const fullPath = path.join(dir, e.name);
                    results.push({
                        name:         e.name,
                        path:         fullPath,
                        relativePath: path.relative(cwd, fullPath),
                    });
                }
            }
        }
    }

    return walk(cwd, 0).then(() => results).catch(() => results);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const { startHeartbeat, reconnectWithBackoff } = require('./ipc/agentHandlers');

let _heartbeat = null;

app.whenReady().then(() => {
    // Apply settings to process.env before anything else
    applyEnvFromSettings();

    buildMenu();
    createWindow();

    // Start heartbeat once the main window is ready
    mainWindow && mainWindow.once('ready-to-show', () => {
        _heartbeat = startHeartbeat({
            getBridge: () => agentBridge,
            onReconnect: () => {
                reconnectWithBackoff({
                    captureMessages: captureAgentMessages,
                    reinitBridge: () => { if (agentBridge) { agentBridge.reinit(); agentBridge = null; } },
                    getBridge: getBridge,
                    notifyRenderer: (msg) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('main-message', msg),
                    log: (msg) => console.warn(msg),
                });
            },
            log: (msg) => console.warn(msg),
        });
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (_heartbeat) _heartbeat.stop();
    if (process.platform !== 'darwin') app.quit();
});

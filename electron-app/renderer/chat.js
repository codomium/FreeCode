/* eslint-disable */
/**
 * chat.js — Claude Code VS Code Webview Client
 *
 * Responsibilities:
 * - Render chat messages (markdown, code blocks with syntax highlighting)
 * - Stream assistant replies token-by-token
 * - Display tool execution cards (collapsible)
 * - @file autocomplete for context injection
 * - Apply-to-file button on code blocks
 * - Model / permission-mode selectors
 * - Stats bar (tokens, cost, elapsed time)
 */

(function () {
    'use strict';

    // ── Electron IPC adapter (replaces acquireVsCodeApi) ────────────────────
    // This shim makes chat.js work identically in both the VSCode extension
    // (acquireVsCodeApi) and the standalone Electron app (electronBridge IPC).
    const vscode = (function () {
        if (typeof window !== 'undefined' && window.electronBridge) {
            // Forward IPC messages from main process as 'message' events on
            // window so the existing window.addEventListener('message', ...)
            // handlers in this file continue to work without any changes.
            window.electronBridge.onMessage(function (data) {
                window.dispatchEvent(new MessageEvent('message', { data: data }));
            });
            return {
                postMessage: function (msg) { window.electronBridge.postMessage(msg); },
                getState:    function ()    { return {}; },
                setState:    function ()    {},
            };
        }
        // Fallback for unexpected environments
        return {
            postMessage: function () {},
            getState:    function () { return {}; },
            setState:    function () {},
        };
    }());

    // ── State ────────────────────────────────────────────────────────────────
    let isLoading = false;
    let currentStreamMsg = null; // DOM element being streamed into
    let contextFiles = [];       // { name, path, pinned?, isImage?, isCodebase? }
    let tokenStats = { input: 0, output: 0 };
    let costTotal = 0;
    let startTime = Date.now();
    let currentModel = '';
    let currentMode = 'default'; // tracks active permission mode for mode badge
    let pendingApply = null;     // { code, language }
    let activeToolCards = {};    // toolName -> dom element
    let sessionMessages = [];    // tracked messages for history saving
    let lastUserMessage = '';    // for ↑ recall and regenerate
    let autoScroll = true;       // auto-scroll while streaming
    let pinnedFiles = [];        // files pinned across sessions
    let currentSessionId = null; // null for new sessions; history entry ID when continuing a saved session
    let currentSessionTitle = ''; // first-message snippet shown in header
    let allHistorySessions = []; // full session list for filtering + welcome screen
    let historyFilterQuery = ''; // active search filter in history panel
    let streamStartTime = 0;     // timestamp when first stream token arrived
    let streamOutputChars = 0;   // approx output chars during current stream (for t/s)
    let lastStreamTps = 0;       // final t/s from last completed stream
    let autoAttachActive = false; // whether to auto-attach the active file with every send
    let msgSendTime = 0;          // timestamp when the last user message was submitted

    // ── Plan board state ─────────────────────────────────────────────────────
    let planItems = [];          // { id, text, done, inProgress }
    let planBoardVisible = false;
    let planItemCounter = 0;
    let planInsertBeforeId = null; // null = append to end; id = insert before that item

    // ── Editor tab state ─────────────────────────────────────────────────────
    let openTabs = [];           // { path, name, content, error, isDiff, beforeContent, afterContent }
    let activeTabPath = null;    // path of the currently active editor tab
    let pendingEditorRead = null;// path being read to open in editor
    let pendingDiffEdit = null;  // { path, tool, beforeContent } for diff tracking
    let ctxMenuTarget = null;    // { path, name, type: 'file'|'dir' } for context menu
    let fileWatchDebounce = null;// debounce timer for file watch events

    /** Max characters shown in the header session-title indicator */
    const SESSION_TITLE_DISPLAY_LENGTH = 55;

    /** Rough approximation: characters per token for streaming speed calculation */
    const CHARS_PER_TOKEN_ESTIMATE = 4;

    /** Minimum input characters before the char-count hint is shown */
    const CHAR_COUNT_MIN_DISPLAY = 50;

    /** Input characters at which the count turns warning color */
    const CHAR_COUNT_WARNING_THRESHOLD = 3000;

    /** Interval (approx chars) between loading-text speed updates during streaming */
    const STREAM_UPDATE_THROTTLE_CHARS = 80;

    /** Plain-English descriptions for each permission mode (shown in mode-desc-bar) */
    const MODE_DESCRIPTIONS = {
        default:           'Asks permission before making file edits or running commands — safest choice',
        auto:              'Approves safe read operations automatically; asks for writes and commands',
        plan:              'Read-only planning mode: analyzes code without making any changes',
        acceptEdits:       'Automatically applies all file edits without asking — fast but careful',
        bypassPermissions: '⚠ Skips all permission checks — full automation, use with care',
    };

    /** Regex that matches markdown numbered or bulleted list items for plan parsing */
    const PLAN_ITEM_PATTERN = /^\s*(?:\d+\.|[-*•])\s+(.+)/;

    /** Max characters shown in the plan insert position label before truncation */
    const PLAN_LABEL_MAX_CHARS = 30;

    /** Keywords that indicate a retryable rate-limit/overload error in the UI */
    const RATE_LIMIT_PATTERN = /rate.?limit|overload|too.?many.?request|capacity|529|503|502|504|bad.?gateway|service.?unavailable|quota/i;

    // ── DOM refs ─────────────────────────────────────────────────────────────
    const messagesEl   = document.getElementById('messages');
    const welcomeEl    = document.getElementById('welcome');
    const inputEl      = document.getElementById('user-input');
    const sendBtn      = document.getElementById('send-btn');
    const stopBtn      = document.getElementById('stop-btn');
    const modelSelect  = document.getElementById('model-select');
    const modeSelect   = document.getElementById('mode-select');
    const addFileBtn   = document.getElementById('add-file-btn');
    const newChatBtn   = document.getElementById('new-chat-btn');
    const contextFilesEl = document.getElementById('context-files');
    const loadingEl    = document.getElementById('loading-indicator');
    const loadingText  = document.getElementById('loading-text');
    const statsModel   = document.getElementById('stats-model');
    const statsTokens  = document.getElementById('stats-tokens');
    const statsCost    = document.getElementById('stats-cost');
    const statsTime    = document.getElementById('stats-time');
    const autocompleteEl = document.getElementById('autocomplete');
    const applyModal   = document.getElementById('apply-modal');
    const applyModalBody = document.getElementById('apply-modal-body');
    const applyConfirmBtn = document.getElementById('apply-confirm-btn');
    const applyPickBtn   = document.getElementById('apply-pick-btn');
    const applyCancelBtn = document.getElementById('apply-cancel-btn');
    const thinkingToggleEl      = document.getElementById('thinking-toggle');
    const thinkingToggleWrapper = document.getElementById('thinking-toggle-wrapper');
    const thinkingLabelEl       = document.getElementById('thinking-label');
    const settingsBtn   = document.getElementById('settings-btn');
    const historyBtn    = document.getElementById('history-btn');
    const historyPanel  = document.getElementById('history-panel');
    const historyList   = document.getElementById('history-list');
    const historySessionView = document.getElementById('history-session-view');
    const historyCloseBtn = document.getElementById('history-close-btn');
    const historyBackBtn  = document.getElementById('history-back-btn');
    const historyPanelTitle = document.getElementById('history-panel-title');

    const autoscrollBtn  = document.getElementById('autoscroll-btn');
    const exportBtn      = document.getElementById('export-btn');
    const searchBar      = document.getElementById('search-bar');
    const searchInput    = document.getElementById('search-input');
    const searchCount    = document.getElementById('search-count');
    const searchPrevBtn  = document.getElementById('search-prev');
    const searchNextBtn  = document.getElementById('search-next');
    const searchCloseBtn = document.getElementById('search-close');
    const contextBarEl   = document.getElementById('context-bar');
    const contextUsedEl  = document.getElementById('context-used');
    const contextMaxEl   = document.getElementById('context-max');
    const contextFillEl  = document.getElementById('context-bar-fill');
    const sessionIndicator  = document.getElementById('session-indicator');
    const historySearch     = document.getElementById('history-search');
    const historySearchBar  = document.getElementById('history-search-bar');
    const welcomeRecentEl   = document.getElementById('welcome-recent');
    const welcomeRecentList = document.getElementById('welcome-recent-list');
    const activeFileBtn     = document.getElementById('active-file-btn');
    const statsSpeedItem    = document.getElementById('stats-speed-item');
    const statsSpeedEl      = document.getElementById('stats-speed');
    const statsMsgsEl       = document.getElementById('stats-msgs');
    const charCountEl       = document.getElementById('char-count');
    const actionsBtn        = document.getElementById('actions-btn');
    const quickActionsPanel = document.getElementById('quick-actions');
    const modeDescBar       = document.getElementById('mode-desc-bar');
    const modeDescText      = document.getElementById('mode-desc-text');
    const modeDescCloseBtn  = document.getElementById('mode-desc-close');
    const gitBtn            = document.getElementById('git-btn');
    const errorsBtn         = document.getElementById('errors-btn');
    const autoAttachBtn     = document.getElementById('auto-attach-btn');
    const contextWarningEl  = document.getElementById('context-warning');
    const contextWarningTextEl = document.getElementById('context-warning-text');
    const contextWarningNewBtn = document.getElementById('context-warning-new');

    // ── Settings panel refs ──────────────────────────────────────────────────
    const settingsPanel        = document.getElementById('settings-panel');
    const settingsCloseBtn     = document.getElementById('settings-close-btn');
    const settingWorkspace     = document.getElementById('setting-workspace');
    const settingsPickWorkspace = document.getElementById('settings-pick-workspace');
    const settingModel         = document.getElementById('setting-model');
    const settingMode          = document.getElementById('setting-mode');
    const settingMaxTurns      = document.getElementById('setting-max-turns');
    const settingShowToolOutput = document.getElementById('setting-show-tool-output');
    const settingsSetKeyBtn    = document.getElementById('settings-set-key-btn');
    const settingNvidiaKey     = document.getElementById('setting-nvidia-key');
    const settingsSaveNvidiaBtn = document.getElementById('settings-save-nvidia-btn');
    const settingsKeyStatus    = document.getElementById('settings-key-status');
    const settingsOpenFolderBtn = document.getElementById('settings-open-folder-btn');
    const settingsGhLink       = document.getElementById('settings-gh-link');

    // ── File explorer panel refs ─────────────────────────────────────────────
    const explorerBtn          = document.getElementById('explorer-btn');   // may be null
    const explorerPanel        = document.getElementById('explorer-panel'); // may be null (removed as overlay)
    const explorerCloseBtn     = document.getElementById('explorer-close-btn'); // may be null
    const explorerRefreshBtn   = document.getElementById('explorer-refresh-btn');
    const explorerTree         = document.getElementById('explorer-tree');
    const explorerWorkspaceLabel = document.getElementById('explorer-workspace-label');

    // ── 3-column IDE panel refs ───────────────────────────────────────────────
    const panelChatEl          = document.getElementById('panel-chat');
    const panelEditorEl        = document.getElementById('panel-editor');
    const panelExplorerEl      = document.getElementById('panel-explorer');
    const editorTabsEl         = document.getElementById('editor-tabs');
    const editorContentEl      = document.getElementById('editor-content');
    const diffToolbar          = document.getElementById('diff-toolbar');
    const diffToolbarFilename  = document.getElementById('diff-toolbar-filename');
    const diffAcceptBtn        = document.getElementById('diff-accept-btn');
    const diffRejectBtn        = document.getElementById('diff-reject-btn');
    const ctxMenu              = document.getElementById('ctx-menu');
    const explorerNewFileBtn   = document.getElementById('explorer-new-file-btn');
    const explorerNewFolderBtn = document.getElementById('explorer-new-folder-btn');

    // ── File viewer modal refs ───────────────────────────────────────────────
    const fileViewerModal      = document.getElementById('file-viewer-modal');
    const fileViewerTitle      = document.getElementById('file-viewer-title');
    const fileViewerContent    = document.getElementById('file-viewer-content');
    const fileViewerAddCtxBtn  = document.getElementById('file-viewer-add-ctx-btn');
    const fileViewerCloseBtn   = document.getElementById('file-viewer-close-btn');

    // ── Plan board refs ──────────────────────────────────────────────────────
    const planBoardEl        = document.getElementById('plan-board');
    const planItemsListEl    = document.getElementById('plan-items-list');
    const planAddBtn         = document.getElementById('plan-add-btn');
    const planClearDoneBtn   = document.getElementById('plan-clear-done-btn');
    const planCloseBoardBtn  = document.getElementById('plan-close-btn');
    const planCollapseBtn    = document.getElementById('plan-board-collapse');
    const planAddRowEl       = document.getElementById('plan-add-row');
    const planAddInputEl     = document.getElementById('plan-add-input');
    const planAddConfirmBtn  = document.getElementById('plan-add-confirm');
    const planAddCancelBtn   = document.getElementById('plan-add-cancel');
    const planAddPositionLabelEl = document.getElementById('plan-add-position-label');

    // ── Permission modal refs ────────────────────────────────────────────────
    const permModalEl        = document.getElementById('permission-modal');
    const permModalTitle     = document.getElementById('permission-modal-title');
    const permModalDesc      = document.getElementById('permission-modal-desc');
    const permModalDetail    = document.getElementById('permission-modal-detail');
    const permAllowBtn       = document.getElementById('permission-allow-btn');
    const permDenyBtn        = document.getElementById('permission-deny-btn');

    // ── File explorer / viewer state ─────────────────────────────────────────
    let currentWorkspacePath  = '';   // kept in sync with settings
    let fileViewerCurrentPath = null; // path of file currently shown in viewer

    /** Tool names that perform file writes — used to trigger diff capture. */
    const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'str_replace_based_edit_tool', 'create_file', 'write_file', 'edit_file']);

    /** Models that support NVIDIA thinking mode toggle */
    const THINKING_CAPABLE_MODELS = new Set([
        'moonshotai/kimi-k2.5',
        'deepseek-ai/deepseek-r1',
    ]);

    /** Approximate max context tokens per model */
    const MODEL_CONTEXT = {
        'claude-sonnet-4-6':                           200000,
        'claude-opus-4-6':                             200000,
        'claude-haiku-4-5':                            200000,
        'gpt-4o':                                      128000,
        'gpt-4o-mini':                                 128000,
        'gemini-2.0-flash':                           1000000,
        'moonshotai/kimi-k2.5':                        128000,
        'deepseek-ai/deepseek-r1':                      64000,
        'nvidia/llama-3.1-nemotron-70b-instruct':      128000,
        'meta/llama-3.1-405b-instruct':                128000,
        'meta/llama-3.3-70b-instruct':                 128000,
        'mistralai/mistral-large-2-instruct':          128000,
        'mistralai/mixtral-8x22b-instruct-v0.1':        64000,
    };

    // ── Session indicator (header title) ─────────────────────────────────────
    function updateSessionIndicator() {
        if (!sessionIndicator) return;
        if (currentSessionTitle) {
            sessionIndicator.textContent = '— ' + currentSessionTitle;
            sessionIndicator.title = currentSessionTitle;
        } else {
            sessionIndicator.textContent = '';
            sessionIndicator.title = '';
        }
    }

    // ── Tick elapsed time ────────────────────────────────────────────────────
    setInterval(() => {
        if (!statsTime) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        statsTime.textContent = elapsed < 60
            ? `${elapsed}s`
            : `${Math.floor(elapsed/60)}m${elapsed%60}s`;
    }, 1000);

    // ── Minimal Markdown → HTML renderer ─────────────────────────────────────
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderMarkdown(text) {
        if (!text) return '';

        // Collect fenced code blocks to prevent inner processing
        const codeBlocks = [];
        let md = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang: lang.trim(), code });
            return `\x00CODE${idx}\x00`;
        });

        // Inline code
        const inlineCode = [];
        md = md.replace(/`([^`]+)`/g, (_, code) => {
            const idx = inlineCode.length;
            inlineCode.push(code);
            return `\x00INLINE${idx}\x00`;
        });

        // Escape HTML in the rest
        md = escapeHtml(md);

        // Headers
        md = md.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
            const level = hashes.length;
            return `<h${level}>${content}</h${level}>`;
        });

        // Bold + italic
        md = md.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        md = md.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        md = md.replace(/\*(.+?)\*/g, '<em>$1</em>');
        md = md.replace(/__(.+?)__/g, '<strong>$1</strong>');
        md = md.replace(/_(.+?)_/g, '<em>$1</em>');

        // Strikethrough
        md = md.replace(/~~(.+?)~~/g, '<del>$1</del>');

        // Links
        md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

        // Horizontal rules
        md = md.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr>');

        // Blockquotes (simple, single-level)
        md = md.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

        // Unordered lists (simple)
        md = md.replace(/^[\*\-]\s+(.+)$/gm, '<li>$1</li>');
        md = md.replace(/(<li>[\s\S]*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);

        // Ordered lists
        md = md.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

        // Tables
        md = md.replace(/^\|(.+)\|\s*\n\|[-| :]+\|\s*\n((?:\|.+\|\s*\n)*)/gm, (_, header, rows) => {
            const th = header.split('|').map(c => `<th>${c.trim()}</th>`).join('');
            const trs = rows.trim().split('\n').map(row => {
                const tds = row.slice(1, -1).split('|').map(c => `<td>${c.trim()}</td>`).join('');
                return `<tr>${tds}</tr>`;
            }).join('');
            return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
        });

        // Paragraphs: wrap consecutive non-empty lines
        md = md.replace(/\n\n+/g, '\n\n');
        const paragraphs = md.split('\n\n').map(chunk => {
            chunk = chunk.trim();
            if (!chunk) return '';
            if (/^<(h\d|ul|ol|table|blockquote|hr)/.test(chunk)) return chunk;
            return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
        });
        md = paragraphs.join('\n');

        // Restore inline code — wrap file-path-looking tokens as clickable file links
        md = md.replace(/\x00INLINE(\d+)\x00/g, (_, i) => {
            const raw = inlineCode[+i];
            if (looksLikeFilePath(raw)) {
                return `<span class="chat-file-link" data-path="${escapeHtml(raw)}" title="Open ${escapeHtml(raw)}"><code>${escapeHtml(raw)}</code></span>`;
            }
            return `<code>${escapeHtml(raw)}</code>`;
        });

        // Restore code blocks — rendered as interactive elements
        md = md.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
            const { lang, code } = codeBlocks[+i];
            return buildCodeBlockHtml(code, lang);
        });

        return md;
    }

    // ── File-path detection (for clickable links in chat) ─────────────────────

    const FILE_PATH_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt|scala|sh|bash|zsh|fish|ps1|css|scss|less|html|htm|xml|svg|json|yaml|yml|toml|ini|env|md|txt|log|lock|dockerfile|makefile|gitignore)$/i;

    /**
     * Returns true if `text` looks like a file path that the agent may have
     * touched — used to turn inline-code tokens into clickable file links.
     */
    function looksLikeFilePath(text) {
        if (!text || text.length > 300) return false;
        // Must not contain spaces (these are identifiers/commands, not paths)
        if (/\s/.test(text)) return false;
        const norm = text.replace(/\\/g, '/');
        // Absolute paths: /foo/bar.js or C:/foo/bar.js
        if (/^(\/|[a-zA-Z]:[\\/])/.test(text) && FILE_PATH_EXT_RE.test(norm)) return true;
        // Relative paths with at least one directory segment: src/main.js
        if (/\//.test(norm) && FILE_PATH_EXT_RE.test(norm)) return true;
        // Plain filenames with a recognised extension: main.js, config.json
        if (/^[a-zA-Z0-9_.-]+$/.test(text) && FILE_PATH_EXT_RE.test(text)) return true;
        return false;
    }

    // ── Syntax Highlighter ────────────────────────────────────────────────────

    const keywords = {
        js: ['const','let','var','function','return','if','else','for','while','do','break','continue',
             'switch','case','default','class','extends','new','this','super','import','export','from',
             'async','await','try','catch','finally','throw','typeof','instanceof','in','of','delete',
             'void','yield','static','get','set','null','undefined','true','false'],
        ts: ['const','let','var','function','return','if','else','for','while','do','break','continue',
             'switch','case','default','class','extends','new','this','super','import','export','from',
             'async','await','try','catch','finally','throw','typeof','instanceof','in','of','delete',
             'void','yield','static','get','set','null','undefined','true','false',
             'interface','type','enum','namespace','declare','abstract','implements','readonly',
             'public','private','protected','as','keyof','infer','never','any','string','number','boolean'],
        py: ['def','class','return','if','elif','else','for','while','break','continue','pass','import',
             'from','as','try','except','finally','raise','with','lambda','yield','async','await',
             'True','False','None','and','or','not','in','is','del','global','nonlocal','print'],
        go: ['func','var','const','type','struct','interface','map','chan','package','import','return',
             'if','else','for','switch','case','default','break','continue','go','defer','select',
             'nil','true','false','string','int','float64','bool','error'],
        rust: ['fn','let','mut','const','struct','enum','impl','trait','mod','use','pub','crate','super',
               'self','return','if','else','for','while','loop','match','break','continue','async','await',
               'true','false','None','Some','Ok','Err'],
        java: ['class','interface','extends','implements','new','return','if','else','for','while','do',
               'switch','case','default','break','continue','try','catch','finally','throw','throws',
               'public','private','protected','static','final','abstract','import','package',
               'null','true','false','void','int','long','double','float','boolean','String'],
        sh: ['if','then','else','elif','fi','for','do','done','while','case','esac','function',
             'return','exit','echo','export','local','readonly','shift','source',
             'true','false','null'],
    };

    function highlightCode(code, lang) {
        const l = (lang || '').toLowerCase().replace(/[^a-z0-9#+-]/g, '');

        // Map aliases
        const langMap = {
            javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
            typescript: 'ts', tsx: 'ts',
            python: 'py', py3: 'py',
            golang: 'go',
            shell: 'sh', bash: 'sh', zsh: 'sh', cmd: 'sh',
            java: 'java',
            rust: 'rust', rs: 'rust',
        };
        const normalLang = langMap[l] || l;

        const kws = keywords[normalLang] || keywords.js;
        const kwSet = new Set(kws);

        // For JSON, use a simple formatter
        if (normalLang === 'json') return highlightJson(code);

        let result = '';
        let i = 0;
        const len = code.length;

        while (i < len) {
            // Single-line comment
            if ((normalLang === 'js' || normalLang === 'ts' || normalLang === 'go' ||
                 normalLang === 'java' || normalLang === 'rust') &&
                code[i] === '/' && code[i+1] === '/') {
                const end = code.indexOf('\n', i);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end);
                result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }
            // Python/Bash comment
            if ((normalLang === 'py' || normalLang === 'sh') && code[i] === '#') {
                const end = code.indexOf('\n', i);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end);
                result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }
            // Block comment
            if ((normalLang === 'js' || normalLang === 'ts' || normalLang === 'go' ||
                 normalLang === 'java' || normalLang === 'rust') &&
                code[i] === '/' && code[i+1] === '*') {
                const end = code.indexOf('*/', i + 2);
                const comment = end === -1 ? code.slice(i) : code.slice(i, end + 2);
                result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
                i += comment.length;
                continue;
            }
            // String (double quote)
            if (code[i] === '"') {
                let j = i + 1;
                while (j < len && !(code[j] === '"' && code[j-1] !== '\\')) j++;
                const str = code.slice(i, j + 1);
                result += `<span class="tok-string">${escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }
            // String (single quote)
            if (code[i] === "'") {
                let j = i + 1;
                while (j < len && !(code[j] === "'" && code[j-1] !== '\\')) j++;
                const str = code.slice(i, j + 1);
                result += `<span class="tok-string">${escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }
            // Template literal
            if (code[i] === '`' && (normalLang === 'js' || normalLang === 'ts')) {
                let j = i + 1;
                while (j < len && !(code[j] === '`' && code[j-1] !== '\\')) j++;
                const str = code.slice(i, j + 1);
                result += `<span class="tok-string">${escapeHtml(str)}</span>`;
                i = j + 1;
                continue;
            }
            // Number
            if (/\d/.test(code[i]) && (i === 0 || /\W/.test(code[i-1]))) {
                let j = i;
                while (j < len && /[\d._xXbBoO]/.test(code[j])) j++;
                result += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
                i = j;
                continue;
            }
            // Identifier or keyword
            if (/[a-zA-Z_$]/.test(code[i])) {
                let j = i;
                while (j < len && /[\w$]/.test(code[j])) j++;
                const word = code.slice(i, j);
                if (kwSet.has(word)) {
                    result += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
                } else if (/^[A-Z]/.test(word)) {
                    result += `<span class="tok-type">${escapeHtml(word)}</span>`;
                } else if (code[j] === '(') {
                    result += `<span class="tok-function">${escapeHtml(word)}</span>`;
                } else {
                    result += `<span class="tok-variable">${escapeHtml(word)}</span>`;
                }
                i = j;
                continue;
            }
            // Operator
            if (/[=><!&|+\-*/%^~?]/.test(code[i])) {
                result += `<span class="tok-operator">${escapeHtml(code[i])}</span>`;
                i++;
                continue;
            }
            // Everything else
            result += escapeHtml(code[i]);
            i++;
        }
        return result;
    }

    function highlightJson(code) {
        return escapeHtml(code).replace(
            /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
            (m, key, str, bool, num) => {
                if (key) return `<span class="tok-attr">${key}</span>:`;
                if (str) return `<span class="tok-string">${str}</span>`;
                if (bool) return `<span class="tok-keyword">${bool}</span>`;
                if (num) return `<span class="tok-number">${num}</span>`;
                return m;
            }
        );
    }

    // ── Code block HTML builder ───────────────────────────────────────────────
    let codeBlockIdCounter = 0;
    // Store code by ID to avoid large data attributes and XSS risks
    const codeStore = new Map();

    /** Languages whose code can be sent directly to the integrated terminal */
    const RUNNABLE_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'cmd', 'batch', 'powershell', 'ps1']);

    function buildCodeBlockHtml(code, lang) {
        const id = `cb-${++codeBlockIdCounter}`;
        const highlighted = highlightCode(code, lang);
        const displayLang = lang || 'code';
        // Store code in JS Map, not in DOM attribute
        codeStore.set(id, { code, language: lang || '' });
        const isRunnable = RUNNABLE_LANGS.has((lang || '').toLowerCase());
        const runBtnHtml = isRunnable
            ? `<button class="code-btn run-btn" data-action="run" data-block-id="${id}" title="Run in integrated terminal">▷ Run</button>`
            : '';

        // Wrap each line in a <span class="line"> for CSS line numbers
        const rawLines = highlighted.split('\n');
        // Remove a single trailing empty line artifact from split
        if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
        const numberedCode = rawLines.map(l => `<span class="line">${l}</span>`).join('\n');

        return `<div class="code-block" id="${id}" data-block-id="${id}" data-lang="${escapeHtml(lang || '')}">
  <div class="code-header">
    <span class="code-lang">${escapeHtml(displayLang)}</span>
    <div class="code-actions">
      ${runBtnHtml}<button class="code-btn wrap-btn" data-action="wrap" data-block-id="${id}" title="Toggle word wrap">↔</button>
      <button class="code-btn copy-btn" data-action="copy" data-block-id="${id}">Copy</button>
      <button class="code-btn apply-btn" data-action="apply" data-block-id="${id}">Apply to file…</button>
    </div>
  </div>
  <pre><code>${numberedCode}</code></pre>
</div>`;
    }

    // ── Event delegation for code block buttons ───────────────────────────────
    // (replaces window.copyCode / window.applyCode inline onclick handlers)
    messagesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const blockId = btn.dataset.blockId;
        if (!blockId) return;
        if (action === 'copy') {
            const entry = codeStore.get(blockId);
            if (!entry) return;
            vscode.postMessage({ type: 'copyToClipboard', text: entry.code });
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } else if (action === 'apply') {
            const entry = codeStore.get(blockId);
            if (!entry) return;
            pendingApply = { code: entry.code, language: entry.language };
            // Show preview immediately; diff will arrive when extension reads active file
            showApplyModal(entry.code, null, null);
            vscode.postMessage({ type: 'getActiveFileContent' });
        } else if (action === 'run') {
            const entry = codeStore.get(blockId);
            if (!entry) return;
            vscode.postMessage({ type: 'runInTerminal', code: entry.code });
            btn.textContent = '✓ Sent';
            setTimeout(() => { btn.textContent = '▷ Run'; }, 1500);
        } else if (action === 'wrap') {
            const block = document.getElementById(blockId);
            if (!block) return;
            const pre = block.querySelector('pre');
            if (!pre) return;
            const isWrapped = pre.classList.toggle('wrapped');
            btn.classList.toggle('active', isWrapped);
            btn.title = isWrapped ? 'Word wrap: on (click to disable)' : 'Toggle word wrap';
        }
    });

    // ── Click handler for inline file-path links in chat messages ─────────────
    messagesEl.addEventListener('click', (e) => {
        const link = e.target.closest('.chat-file-link');
        if (!link) return;
        e.preventDefault();
        const rawPath = link.dataset.path || '';
        if (!rawPath) return;
        // Resolve to an absolute path using the current workspace
        let absPath = rawPath;
        if (!/^(\/|[a-zA-Z]:[\\/])/.test(rawPath) && currentWorkspacePath) {
            absPath = pathJoin(currentWorkspacePath, rawPath);
        }
        // If there is an open diff tab for this file, just activate it so the
        // user sees exactly what the agent changed.
        const diffTab = openTabs.find(t => t.path === absPath && t.isDiff);
        if (diffTab) {
            activateTab(absPath);
            return;
        }
        // Otherwise open (or focus) the file in the editor panel.
        openFileInEditor(absPath);
    });

    function decodeHtmlEntities(str) {
        // Manually reverse only the escapes produced by escapeHtml()
        return str
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    // ── Apply Modal ───────────────────────────────────────────────────────────
    function cancelApply() {
        applyModal.classList.remove('visible');
        pendingApply = null;
    }

    /**
     * LCS-based line diff. Returns array of {type:'equal'|'add'|'remove', line}.
     * Falls back to showing all new lines when files are too large.
     */
    function computeDiff(aLines, bLines) {
        if (aLines.length * bLines.length > 400000) {
            return bLines.map(l => ({ type: 'add', line: l }));
        }
        const n = aLines.length, m = bLines.length;
        const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                dp[i][j] = aLines[i - 1] === bLines[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
        const result = [];
        let i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
                result.unshift({ type: 'equal',  line: aLines[i - 1] }); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                result.unshift({ type: 'add',    line: bLines[j - 1] }); j--;
            } else {
                result.unshift({ type: 'remove', line: aLines[i - 1] }); i--;
            }
        }
        return result;
    }

    function buildDiffView(diff) {
        const container = document.createElement('div');
        container.className = 'diff-view';
        const pre = document.createElement('pre');
        for (const { type, line } of diff) {
            const span = document.createElement('span');
            span.className = 'diff-line diff-' + type;
            span.textContent = (type === 'add' ? '+ ' : type === 'remove' ? '- ' : '  ') + line;
            pre.appendChild(span);
            pre.appendChild(document.createTextNode('\n'));
        }
        container.appendChild(pre);
        return container;
    }

    function showApplyModal(newCode, oldContent, fileName) {
        const titleEl = document.getElementById('apply-modal-title');
        if (titleEl) {
            titleEl.textContent = (oldContent !== null && oldContent !== undefined)
                ? `Review changes — ${fileName || 'active file'}`
                : 'Apply code to file';
        }
        applyModalBody.innerHTML = '';
        if (oldContent !== null && oldContent !== undefined) {
            const diff = computeDiff(oldContent.split('\n'), newCode.split('\n'));
            applyModalBody.appendChild(buildDiffView(diff));
        } else {
            const preview = newCode.length > 2000 ? newCode.slice(0, 2000) + '\n…' : newCode;
            applyModalBody.innerHTML = buildCodeBlockHtml(preview, pendingApply ? pendingApply.language : '');
        }
        applyModal.classList.add('visible');
    }

    const applyCancelTopBtn = document.getElementById('apply-cancel-top');
    if (applyCancelTopBtn) {
        applyCancelTopBtn.addEventListener('click', cancelApply);
    }

    if (applyCancelBtn) {
        applyCancelBtn.addEventListener('click', cancelApply);
    }

    if (applyConfirmBtn) {
        applyConfirmBtn.addEventListener('click', () => {
            if (!pendingApply) return;
            vscode.postMessage({
                type: 'applyCode',
                code: pendingApply.code,
                language: pendingApply.language,
            });
            cancelApply();
        });
    }

    if (applyPickBtn) {
        applyPickBtn.addEventListener('click', () => {
            if (!pendingApply) return;
            vscode.postMessage({
                type: 'applyCodeToFile',
                code: pendingApply.code,
                language: pendingApply.language,
            });
            cancelApply();
        });
    }

    // ── Copy button helper ────────────────────────────────────────────────────
    function addCopyButtonToMessage(msgDiv, rawText, userPrompt) {
        const header = msgDiv.querySelector('.msg-header');
        if (!header || header.querySelector('.msg-copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'msg-copy-btn';
        btn.title = 'Copy answer';
        btn.textContent = '⎘ Copy';
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'copyToClipboard', text: rawText });
            btn.textContent = '✓ Copied';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = '⎘ Copy';
                btn.classList.remove('copied');
            }, 1500);
        });
        header.appendChild(btn);

        if (userPrompt) {
            const regenBtn = document.createElement('button');
            regenBtn.className = 'msg-regen-btn';
            regenBtn.title = 'Regenerate response';
            regenBtn.textContent = '↺';
            regenBtn.addEventListener('click', () => {
                if (isLoading) return;
                regenerateFrom(msgDiv, userPrompt);
            });
            header.appendChild(regenBtn);
        }

        // "Continue" button — sends a follow-up that asks the model to keep going.
        // Useful when the model stops mid-task (e.g. max turns reached).
        const continueBtn = document.createElement('button');
        continueBtn.className = 'msg-continue-btn';
        continueBtn.title = 'Ask the model to continue from here';
        continueBtn.textContent = '▶ Continue';
        continueBtn.addEventListener('click', () => {
            if (isLoading) return;
            setSending(true);
            setLoading(true, 'Thinking…');
            vscode.postMessage({ type: 'send', message: 'Please continue from where you left off.', contextFiles: [], fileRefs: [] });
        });
        header.appendChild(continueBtn);
    }

    // ── Message rendering ─────────────────────────────────────────────────────
    function hideWelcome() {
        if (welcomeEl && !welcomeEl.classList.contains('hidden')) {
            welcomeEl.classList.add('hidden');
        }
    }

    function scrollToBottom() {
        if (!autoScroll) return;
        requestAnimationFrame(() => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    function addUserMessage(text) {
        msgSendTime = Date.now(); // track when message was sent for per-message timing
        hideWelcome();
        currentStreamMsg = null;
        lastUserMessage = text;
        // Derive session title from the first user message
        if (sessionMessages.length === 0 && text.trim()) {
            currentSessionTitle = text.trim().slice(0, SESSION_TITLE_DISPLAY_LENGTH).replace(/\n/g, ' ');
            updateSessionIndicator();
        }
        sessionMessages.push({ type: 'user', text });

        const div = document.createElement('div');
        div.className = 'msg msg-user';
        div._sessionIdx = sessionMessages.length - 1;

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.appendChild(document.createTextNode('You'));

        const editBtn = document.createElement('button');
        editBtn.className = 'msg-edit-btn';
        editBtn.title = 'Edit message';
        editBtn.textContent = '✏';
        editBtn.addEventListener('click', () => editUserMessage(div, text));
        meta.appendChild(editBtn);

        const copyUserBtn = document.createElement('button');
        copyUserBtn.className = 'msg-user-copy-btn';
        copyUserBtn.title = 'Copy message';
        copyUserBtn.textContent = '⎘';
        copyUserBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'copyToClipboard', text });
            copyUserBtn.textContent = '✓';
            setTimeout(() => { copyUserBtn.textContent = '⎘'; }, 1500);
        });
        meta.appendChild(copyUserBtn);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        timeSpan.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        meta.appendChild(timeSpan);

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = text;   // safe — textContent

        div.appendChild(meta);
        div.appendChild(bubble);
        messagesEl.appendChild(div);
        scrollToBottom();
    }

    function getOrCreateAssistantMessage() {
        if (currentStreamMsg) return currentStreamMsg;
        hideWelcome();
        const div = document.createElement('div');
        div.className = 'msg msg-assistant';
        div._regenPrompt = lastUserMessage;    // capture for regenerate
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Whitelist known mode values for safe CSS class construction
        const safeModes = new Set(['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']);
        const safeMode  = safeModes.has(currentMode) ? currentMode : 'default';
        const modeBadgeHtml = `<span class="mode-badge mode-badge-${safeMode}">${escapeHtml(safeMode)}</span>`;
        div.innerHTML = `
            <div class="msg-header">
                <div class="msg-avatar">✦</div>
                <span class="msg-name">Claude</span>
                ${modeBadgeHtml}
                <span class="msg-time">${escapeHtml(ts)}</span>
            </div>
            <div class="msg-content streaming-cursor"></div>
        `;
        messagesEl.appendChild(div);
        currentStreamMsg = div.querySelector('.msg-content');
        scrollToBottom();
        return currentStreamMsg;
    }

    function appendStreamText(text) {
        const el = getOrCreateAssistantMessage();
        // Accumulate raw text on element, re-render markdown periodically
        el._rawText = (el._rawText || '') + text;

        // Track streaming speed
        if (!streamStartTime) streamStartTime = Date.now();
        streamOutputChars += text.length;
        // Update loading label roughly every STREAM_UPDATE_THROTTLE_CHARS to avoid too many DOM writes
        if (streamOutputChars % STREAM_UPDATE_THROTTLE_CHARS < text.length) {
            const elapsed = (Date.now() - streamStartTime) / 1000;
            const tps = elapsed > 0.5 ? Math.round(streamOutputChars / CHARS_PER_TOKEN_ESTIMATE / elapsed) : 0;
            if (tps > 0) setLoading(true, `Generating… (${tps} t/s)`);
        }

        // Throttle rendering to avoid layout thrashing
        if (!el._renderPending) {
            el._renderPending = true;
            requestAnimationFrame(() => {
                el._renderPending = false;
                if (el._rawText) {
                    el.innerHTML = renderMarkdown(el._rawText);
                    el.classList.add('streaming-cursor');
                }
                scrollToBottom();
            });
        }
    }

    function finalizeAssistantMessage(content) {
        // Compute and record final streaming speed
        if (streamStartTime && streamOutputChars > 0) {
            const elapsed = (Date.now() - streamStartTime) / 1000;
            lastStreamTps = elapsed > 0.1 ? Math.round(streamOutputChars / CHARS_PER_TOKEN_ESTIMATE / elapsed) : 0;
        }
        streamStartTime = 0;
        streamOutputChars = 0;
        // Show speed in stats bar
        if (statsSpeedItem && statsSpeedEl && lastStreamTps > 0) {
            statsSpeedEl.textContent = lastStreamTps;
            statsSpeedItem.style.display = '';
        }

        // Compute per-message response time
        let responseTimeLabel = '';
        if (msgSendTime > 0) {
            const elapsed = (Date.now() - msgSendTime) / 1000;
            responseTimeLabel = elapsed < 60
                ? `${elapsed.toFixed(1)}s`
                : `${Math.floor(elapsed / 60)}m${Math.round(elapsed % 60)}s`;
            msgSendTime = 0;
        }

        if (currentStreamMsg) {
            const raw = currentStreamMsg._rawText || content || '';
            currentStreamMsg.innerHTML = raw ? renderMarkdown(raw) : '';
            currentStreamMsg.classList.remove('streaming-cursor');
            currentStreamMsg._rawText = '';
            // Show response time in header
            if (responseTimeLabel) {
                const msgDiv = currentStreamMsg.closest('.msg-assistant');
                const timeEl = msgDiv?.querySelector('.msg-time');
                if (timeEl) timeEl.textContent = responseTimeLabel;
            }
            // Add copy + regenerate buttons + track in history
            if (raw) {
                const msgDiv = currentStreamMsg.closest('.msg-assistant');
                if (msgDiv) addCopyButtonToMessage(msgDiv, raw, msgDiv._regenPrompt);
                sessionMessages.push({ type: 'assistant', text: raw });
                // In plan mode, auto-parse list items from the response
                if (currentMode === 'plan' && planItems.length === 0) {
                    const parsed = extractPlanItems(raw);
                    if (parsed.length > 0) {
                        for (const t of parsed) addPlanItem(t);
                    }
                }
                // Advance plan progress on completion
                if (planItems.length > 0) advancePlanProgress();
            }
            currentStreamMsg = null;
        } else if (content) {
            hideWelcome();
            const div = document.createElement('div');
            div.className = 'msg msg-assistant';
            div.innerHTML = `
                <div class="msg-header">
                    <div class="msg-avatar">✦</div>
                    <span class="msg-name">Claude</span>
                    ${responseTimeLabel ? `<span class="msg-time">${escapeHtml(responseTimeLabel)}</span>` : ''}
                </div>
                <div class="msg-content">${renderMarkdown(content)}</div>
            `;
            addCopyButtonToMessage(div, content);
            sessionMessages.push({ type: 'assistant', text: content });
            messagesEl.appendChild(div);
        }
        scrollToBottom();
    }

    let toolCardCounter = 0;
    const toolCardInputs = {}; // cardId → tool input (for diff/context in updateToolCard)

    /** Return just the filename from a path string (browser-safe, no Node path module) */
    function basename(filePath) {
        return (filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
    }

    function addToolCard(toolName, input) {
        hideWelcome();
        const id = `tool-${++toolCardCounter}`;
        toolCardInputs[id] = input || {};

        // Build card using DOM API so toolName is safely set via textContent
        const msgDiv = document.createElement('div');
        msgDiv.className = 'msg';

        const card = document.createElement('div');
        card.className = 'tool-card';
        card.id = id;

        const header = document.createElement('div');
        header.className = 'tool-card-header';
        header.addEventListener('click', () => card.classList.toggle('expanded'));

        const iconSpan = document.createElement('span');
        iconSpan.className = 'tool-icon';
        // Context-aware icon per tool type
        iconSpan.textContent = toolName === 'Edit'  ? '✏️' :
                               toolName === 'Write' ? '📝' :
                               toolName === 'Read'  ? '📄' :
                               toolName === 'Bash'  ? '⚡' :
                               toolName === 'Glob'  ? '🔍' :
                               toolName === 'Grep'  ? '🔎' : '⚙';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tool-name';
        nameSpan.textContent = toolName;          // safe — textContent, not innerHTML

        const statusSpan = document.createElement('span');
        statusSpan.className = 'tool-status';
        const spinnerSpan = document.createElement('span');
        spinnerSpan.className = 'tool-spinner';
        spinnerSpan.textContent = '⟳';
        statusSpan.appendChild(spinnerSpan);
        statusSpan.appendChild(document.createTextNode(' running…'));

        const chevron = document.createElement('span');
        chevron.className = 'tool-chevron';
        chevron.textContent = '▶';

        header.appendChild(iconSpan);
        header.appendChild(nameSpan);

        // Subtitle: file path (Read/Edit/Write) or command preview (Bash)
        if (input) {
            const sub = document.createElement('span');
            sub.className = 'tool-card-subtitle';
            if ((toolName === 'Edit' || toolName === 'Write') && input.file_path) {
                sub.textContent = basename(input.file_path);
            } else if (toolName === 'Read' && input.file_path) {
                const start = (input.offset || 0) + 1;
                const end   = (input.offset || 0) + (input.limit || 2000);
                sub.textContent = `${basename(input.file_path)} · lines ${start}–${end}`;
            } else if (toolName === 'Bash' && input.command) {
                const cmd = input.command.length > 60
                    ? input.command.slice(0, 60) + '…'
                    : input.command;
                sub.textContent = cmd;
            }
            if (sub.textContent) header.appendChild(sub);
        }

        header.appendChild(statusSpan);
        header.appendChild(chevron);

        const body = document.createElement('div');
        body.className = 'tool-card-body';

        const resultDiv = document.createElement('div');
        resultDiv.className = 'tool-result';
        resultDiv.id = `${id}-result`;
        const em = document.createElement('em');
        em.textContent = 'Waiting for result…';
        resultDiv.appendChild(em);
        body.appendChild(resultDiv);

        // Bash: add live output container + interactive stdin bar
        if (toolName === 'Bash') {
            const stdinBar = document.createElement('div');
            stdinBar.className = 'bash-stdin-bar';
            stdinBar.id = `${id}-stdin`;

            const stdinInput = document.createElement('input');
            stdinInput.type = 'text';
            stdinInput.className = 'bash-stdin-input';
            stdinInput.placeholder = 'Send stdin input…';

            const stdinSend = document.createElement('button');
            stdinSend.className = 'bash-stdin-send';
            stdinSend.textContent = '↵ Send';

            const sendStdin = () => {
                const text = stdinInput.value.trim();
                if (!text) return;
                vscode.postMessage({ type: 'bashStdin', jobId: toolCardInputs[id]._jobId, text });
                // Echo the sent input to the output area
                appendToolStream(toolName, `\u276f ${text}\n`);
                stdinInput.value = '';
            };
            stdinSend.addEventListener('click', sendStdin);
            stdinInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); sendStdin(); }
            });

            stdinBar.appendChild(stdinInput);
            stdinBar.appendChild(stdinSend);
            body.appendChild(stdinBar);
        }

        card.appendChild(header);
        card.appendChild(body);
        msgDiv.appendChild(card);
        messagesEl.appendChild(msgDiv);

        // Auto-expand Edit and Bash cards so the diff/output is immediately visible
        if (toolName === 'Edit' || toolName === 'Bash') {
            card.classList.add('expanded');
        }

        activeToolCards[toolName] = id;
        scrollToBottom();
        // Mark first uncompleted plan item as in-progress when agent starts doing work
        if (planItems.length > 0) startPlanProgress();
        return id;
    }

    function updateToolCard(toolName, result, input) {
        const id = activeToolCards[toolName];
        if (!id) return;
        const card = document.getElementById(id);
        if (!card) return;
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = '';
            const doneSpan = document.createElement('span');
            doneSpan.style.color = 'var(--success)';
            doneSpan.textContent = '✓ done';
            statusEl.appendChild(doneSpan);
        }
        const resultEl = document.getElementById(`${id}-result`);
        const storedInput = toolCardInputs[id] || input || {};
        if (resultEl) {
            if (toolName === 'Edit' &&
                storedInput.old_string !== undefined &&
                storedInput.new_string !== undefined) {
                // Show inline diff: red for removed lines, green for added lines
                const diff = computeDiff(
                    storedInput.old_string.split('\n'),
                    storedInput.new_string.split('\n')
                );
                resultEl.innerHTML = '';
                resultEl.className = 'tool-result tool-result-diff';
                resultEl.appendChild(buildDiffView(diff));
            } else if (toolName === 'Bash') {
                // Bash: live output is already rendered via appendToolStream;
                // on completion just remove the waiting placeholder if still there
                const em = resultEl.querySelector('em');
                if (em) em.remove();
                // If no live output was streamed (very fast command), show result now
                if (!resultEl.querySelector('.bash-live-output') && result) {
                    const pre = document.createElement('pre');
                    pre.className = 'bash-live-output';
                    pre.textContent = result;
                    resultEl.appendChild(pre);
                }
            } else {
                // Default: plain text preview
                const preview = result && result.length > 800
                    ? result.slice(0, 800) + '\n…'
                    : (result || '');
                resultEl.textContent = preview;      // safe — textContent only
            }
        }
        // Remove stdin bar (command has finished)
        const stdinBar = document.getElementById(`${id}-stdin`);
        if (stdinBar) stdinBar.remove();

        delete activeToolCards[toolName];
        delete toolCardInputs[id];
    }

    /** Append a live output chunk to a running Bash tool card */
    function appendToolStream(toolName, chunk) {
        const id = activeToolCards[toolName];
        if (!id) return;
        const resultEl = document.getElementById(`${id}-result`);
        if (!resultEl) return;
        // Remove placeholder <em> if present
        const em = resultEl.querySelector('em');
        if (em) em.remove();
        // Find or create the live output <pre>
        let pre = resultEl.querySelector('.bash-live-output');
        if (!pre) {
            pre = document.createElement('pre');
            pre.className = 'bash-live-output';
            resultEl.appendChild(pre);
        }
        pre.textContent += chunk;
        if (autoScroll) scrollToBottom();
    }

    let thinkingCounter = 0;

    function addThinkingBlock(text) {
        hideWelcome();
        const id = `think-${++thinkingCounter}`;
        const msgDiv = document.createElement('div');
        msgDiv.className = 'msg';

        const thinkEl = document.createElement('div');
        thinkEl.className = 'msg-thinking';
        thinkEl.id = id;

        const headerEl = document.createElement('div');
        headerEl.className = 'msg-thinking-header';
        headerEl.addEventListener('click', () => thinkEl.classList.toggle('expanded'));

        const bubbleIcon = document.createElement('span');
        bubbleIcon.textContent = '💭';
        const label = document.createElement('span');
        label.textContent = 'Extended thinking';
        const hint = document.createElement('span');
        hint.style.cssText = 'margin-left:auto;font-size:10px';
        hint.textContent = 'click to expand';

        headerEl.appendChild(bubbleIcon);
        headerEl.appendChild(label);
        headerEl.appendChild(hint);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'msg-thinking-body';
        bodyEl.textContent = text || '';           // safe — textContent

        thinkEl.appendChild(headerEl);
        thinkEl.appendChild(bodyEl);
        msgDiv.appendChild(thinkEl);
        messagesEl.appendChild(msgDiv);
        scrollToBottom();
    }

    function addSystemMessage(text) {
        hideWelcome();
        const div = document.createElement('div');
        div.className = 'msg msg-system';
        div.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
        messagesEl.appendChild(div);
        scrollToBottom();
    }

    function addErrorMessage(text) {
        hideWelcome();
        currentStreamMsg = null;
        const div = document.createElement('div');
        div.className = 'msg msg-error';

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = '⚠ ' + text;    // safe — textContent

        div.appendChild(bubble);

        // Always show a retry row so the user can manually retry after any error
        const actionsRow = document.createElement('div');
        actionsRow.className = 'msg-error-actions';

        const retryBtn = document.createElement('button');
        retryBtn.className = 'msg-retry-btn';
        retryBtn.textContent = '↩ Retry';
        retryBtn.title = 'Re-send the last message';
        retryBtn.addEventListener('click', () => {
            if (isLoading || !lastUserMessage) return;
            div.remove();
            setSending(true);
            setLoading(true, 'Thinking…');
            vscode.postMessage({ type: 'send', message: lastUserMessage, contextFiles: [], fileRefs: [] });
        });
        actionsRow.appendChild(retryBtn);
        div.appendChild(actionsRow);

        messagesEl.appendChild(div);
        scrollToBottom();
    }

    // ── Edit user message ─────────────────────────────────────────────────────
    function editUserMessage(msgDiv, originalText) {
        if (isLoading) return;
        const bubble = msgDiv.querySelector('.msg-bubble');
        if (!bubble) return;

        const ta = document.createElement('textarea');
        ta.className = 'msg-user-edit-area';
        ta.value = originalText;
        ta.rows = 3;

        const actionsRow = document.createElement('div');
        actionsRow.className = 'msg-user-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn';
        cancelBtn.textContent = 'Cancel';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn primary';
        confirmBtn.textContent = '↵ Resend';

        actionsRow.appendChild(cancelBtn);
        actionsRow.appendChild(confirmBtn);

        bubble.replaceWith(ta);
        msgDiv.appendChild(actionsRow);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);

        cancelBtn.addEventListener('click', () => {
            ta.replaceWith(bubble);
            actionsRow.remove();
        });
        confirmBtn.addEventListener('click', confirmEdit);
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit(); }
            if (e.key === 'Escape') { ta.replaceWith(bubble); actionsRow.remove(); }
        });

        function confirmEdit() {
            const newText = ta.value.trim();
            if (!newText) return;

            bubble.textContent = newText;
            ta.replaceWith(bubble);
            actionsRow.remove();
            msgDiv._originalText = newText;
            // Update edit button closure
            const eb = msgDiv.querySelector('.msg-edit-btn');
            if (eb) eb.onclick = null;
            if (eb) eb.addEventListener('click', () => editUserMessage(msgDiv, newText));

            // Remove all DOM messages after this one
            let el = msgDiv.nextElementSibling;
            while (el) { const nx = el.nextElementSibling; el.remove(); el = nx; }

            // Truncate sessionMessages to this user message (inclusive)
            const idx = typeof msgDiv._sessionIdx === 'number' ? msgDiv._sessionIdx : -1;
            if (idx >= 0) sessionMessages.splice(idx);
            sessionMessages.push({ type: 'user', text: newText });
            msgDiv._sessionIdx = sessionMessages.length - 1;

            lastUserMessage = newText;
            setSending(true);
            setLoading(true, 'Thinking…');
            vscode.postMessage({ type: 'send', message: newText, contextFiles: [], fileRefs: [] });
        }
    }

    // ── Regenerate response ───────────────────────────────────────────────────
    function regenerateFrom(assistantMsgDiv, userPrompt) {
        // Remove this assistant message and everything after it from the DOM
        let el = assistantMsgDiv;
        while (el) { const nx = el.nextElementSibling; el.remove(); el = nx; }

        // Truncate sessionMessages: remove the last assistant entry(s) for this prompt
        const lastUserIdx = [...sessionMessages].reduceRight((found, m, i) =>
            found === -1 && m.type === 'user' && m.text === userPrompt ? i : found, -1);
        if (lastUserIdx >= 0) sessionMessages.splice(lastUserIdx + 1);

        lastUserMessage = userPrompt;
        setSending(true);
        setLoading(true, 'Thinking…');
        vscode.postMessage({ type: 'send', message: userPrompt, contextFiles: [], fileRefs: [] });
    }

    // ── @codebase chip ────────────────────────────────────────────────────────
    function addCodebaseContext() {
        if (contextFiles.find(f => f.isCodebase)) return;
        contextFiles.push({ name: '@codebase', path: '__codebase__', isCodebase: true });
        renderContextFiles();
    }

    // ── @git chip — inject current git status ─────────────────────────────────
    function requestGitContext() {
        vscode.postMessage({ type: 'getGitContext' });
    }
    function addGitContext(content, branch) {
        if (contextFiles.find(f => f.isGit)) {
            // Replace existing git chip with fresh one
            contextFiles = contextFiles.filter(f => !f.isGit);
        }
        contextFiles.push({
            name: branch ? `⎇ ${branch}` : '⎇ git',
            path: '__git__',
            isGit: true,
            content,
        });
        renderContextFiles();
    }

    // ── @errors chip — inject workspace diagnostics ───────────────────────────
    function requestErrorsContext() {
        vscode.postMessage({ type: 'getWorkspaceDiagnostics' });
    }
    function addErrorsContext(diagnostics) {
        if (contextFiles.find(f => f.isErrors)) {
            contextFiles = contextFiles.filter(f => !f.isErrors);
        }
        const errCount  = diagnostics.filter(d => d.severity === 'error').length;
        const warnCount = diagnostics.filter(d => d.severity === 'warning').length;
        const content = diagnostics.length > 0
            ? diagnostics.map(d =>
                `[${d.severity.toUpperCase()}] ${d.file}:${d.line}:${d.col} — ${d.message}${d.source ? ` (${d.source})` : ''}`
              ).join('\n')
            : '(no errors or warnings found)';
        contextFiles.push({
            name: diagnostics.length > 0 ? `⚠ ${errCount}E ${warnCount}W` : '⚠ no errors',
            title: diagnostics.length > 0 ? `${errCount} error(s), ${warnCount} warning(s)` : 'No errors or warnings',
            path: '__errors__',
            isErrors: true,
            content,
        });
        renderContextFiles();
    }

    // ── @openfiles — show open editor tabs in autocomplete ────────────────────
    function requestOpenFiles() {
        vscode.postMessage({ type: 'getOpenEditors' });
    }

    // ── Image paste chip ──────────────────────────────────────────────────────
    function addImageContext(name, dataUrl) {
        if (!contextFilesEl) return;
        contextFiles.push({ name, path: `__img__:${name}`, isImage: true, dataUrl });
        renderContextFiles();
    }

    // ── Toggle pin on a context file ─────────────────────────────────────────
    function togglePinFile(file) {
        file.pinned = !file.pinned;
        if (file.pinned) {
            if (!pinnedFiles.find(p => p.path === file.path))
                pinnedFiles.push({ name: file.name, path: file.path });
            vscode.postMessage({ type: 'pinFile', path: file.path });
        } else {
            pinnedFiles = pinnedFiles.filter(p => p.path !== file.path);
            vscode.postMessage({ type: 'unpinFile', path: file.path });
        }
        renderContextFiles();
    }

    // ── Context window usage bar ──────────────────────────────────────────────
    function updateContextBar() {
        if (!contextBarEl || !contextUsedEl || !contextMaxEl || !contextFillEl) return;
        const used = (tokenStats.input || 0) + (tokenStats.output || 0);
        const max  = MODEL_CONTEXT[currentModel] || 200000;
        const pct  = Math.min((used / max) * 100, 100);
        contextUsedEl.textContent = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : String(used);
        contextMaxEl.textContent  = `${(max  / 1000).toFixed(0)}k`;
        contextFillEl.style.width      = pct + '%';
        contextFillEl.style.background = pct > 95 ? 'var(--error-text)'
                                       : pct > 80 ? 'var(--warning)'
                                       : 'var(--success)';
        contextBarEl.style.display = used > 0 ? '' : 'none';

        // Context-full warning banner
        if (contextWarningEl) {
            if (pct > 85) {
                if (contextWarningTextEl) {
                    contextWarningTextEl.textContent =
                        `Context ${Math.round(pct)}% full — responses may degrade soon.`;
                }
                contextWarningEl.style.display = '';
            } else {
                contextWarningEl.style.display = 'none';
            }
        }
    }

    // ── Conversation search ───────────────────────────────────────────────────
    let searchMatches = [];
    let searchCurrentIdx = -1;

    function showSearchBar() {
        if (!searchBar) return;
        searchBar.style.display = '';
        if (searchInput) { searchInput.focus(); searchInput.select(); }
    }

    function hideSearchBar() {
        if (!searchBar) return;
        searchBar.style.display = 'none';
        clearSearchHighlights();
        if (searchInput) searchInput.value = '';
        if (searchCount) searchCount.textContent = '';
    }

    function clearSearchHighlights() {
        messagesEl.querySelectorAll('.search-match, .search-match-current').forEach(el => {
            el.classList.remove('search-match', 'search-match-current');
        });
        searchMatches = [];
        searchCurrentIdx = -1;
    }

    function performSearch(query) {
        clearSearchHighlights();
        if (!query || query.length < 2) {
            if (searchCount) searchCount.textContent = '';
            return;
        }
        const lq = query.toLowerCase();
        messagesEl.querySelectorAll('.msg-user, .msg-assistant').forEach(el => {
            if ((el.textContent || '').toLowerCase().includes(lq)) {
                el.classList.add('search-match');
                searchMatches.push(el);
            }
        });
        if (searchMatches.length > 0) {
            searchCurrentIdx = 0;
            searchMatches[0].classList.add('search-match-current');
            searchMatches[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        if (searchCount) {
            searchCount.textContent = searchMatches.length > 0
                ? `${searchCurrentIdx + 1}/${searchMatches.length}`
                : 'No results';
        }
    }

    function searchNav(dir) {
        if (searchMatches.length === 0) return;
        searchMatches[searchCurrentIdx]?.classList.remove('search-match-current');
        searchCurrentIdx = (searchCurrentIdx + dir + searchMatches.length) % searchMatches.length;
        searchMatches[searchCurrentIdx].classList.add('search-match-current');
        searchMatches[searchCurrentIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        if (searchCount) searchCount.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => performSearch(searchInput.value.trim()));
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); searchNav(e.shiftKey ? -1 : 1); }
            if (e.key === 'Escape') hideSearchBar();
        });
    }
    if (searchPrevBtn)  searchPrevBtn.addEventListener('click',  () => searchNav(-1));
    if (searchNextBtn)  searchNextBtn.addEventListener('click',  () => searchNav(1));
    if (searchCloseBtn) searchCloseBtn.addEventListener('click', hideSearchBar);

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            showSearchBar();
        }
        // Ctrl+L — focus the chat input (standard AI IDE shortcut)
        if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
            e.preventDefault();
            if (inputEl) {
                inputEl.focus();
                inputEl.select();
            }
        }
    });
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'stream_event':
                appendStreamText(msg.text || '');
                break;

            case 'assistant':
                if (msg.content && !msg._streamed) {
                    finalizeAssistantMessage(msg.content);
                } else {
                    finalizeAssistantMessage(null);
                }
                break;

            case 'thinking':
                addThinkingBlock(msg.text);
                break;

            case 'tool_progress':
                addToolCard(msg.tool, msg.input);
                setLoading(true, `Running ${msg.tool}…`);
                // Track write/edit operations for diff view
                if (FILE_WRITE_TOOLS.has(msg.tool) && msg.input) {
                    const diffPath = msg.input.file_path || msg.input.path || null;
                    if (diffPath) {
                        pendingDiffEdit = { path: diffPath, tool: msg.tool, beforeContent: null, resultReady: false };
                        vscode.postMessage({ type: 'readFile', path: diffPath, purpose: 'before_diff' });
                    }
                }
                break;

            case 'tool_meta':
                // Store metadata (e.g. bash jobId) in the active card's input map
                if (msg.jobId !== undefined) {
                    const cid = activeToolCards[msg.tool];
                    if (cid && toolCardInputs[cid]) {
                        toolCardInputs[cid]._jobId = msg.jobId;
                    }
                }
                break;

            case 'tool_stream':
                appendToolStream(msg.tool, msg.chunk || '');
                break;

            case 'result':
                updateToolCard(msg.tool, typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2), msg.input);
                if (pendingDiffEdit && pendingDiffEdit.tool === msg.tool) {
                    if (pendingDiffEdit.beforeContent !== null) {
                        // Before content is already available — trigger after read
                        vscode.postMessage({ type: 'readFile', path: pendingDiffEdit.path, purpose: 'after_diff' });
                    } else {
                        // Before read hasn't completed yet — mark result as ready so
                        // the fileData handler can trigger after read when it arrives
                        pendingDiffEdit.resultReady = true;
                    }
                }
                break;

            case 'compaction':
                addSystemMessage(`⟳ Context compacted (pass ${msg.count})`);
                break;

            case 'hookPermissionResult':
                if (!msg.allowed) {
                    addSystemMessage(`⛔ Tool blocked by hook: ${msg.tool}`);
                }
                break;

            case 'error':
                finalizeAssistantMessage(null);
                addErrorMessage(msg.message);
                setLoading(false);
                setSending(false);
                break;

            case 'retrying':
                // Rate-limit auto-retry: show countdown in loading indicator
                setLoading(true, `⏳ Rate limited — retrying in ${msg.delaySeconds}s (attempt ${msg.attempt}/${msg.maxAttempts})…`);
                break;

            case 'stop':
                finalizeAssistantMessage(null);
                setLoading(false);
                setSending(false);
                // When the agent loop hits its turn limit, nudge the user to
                // click the ▶ Continue button so the task can keep going.
                if (msg.reason === 'max_turns') {
                    addSystemMessage(
                        '⚙ Max tool-use turns reached. Use ▶ Continue on the last reply to keep going.'
                    );
                }
                // Auto-save current session after every response so VS Code restarts
                // don't lose the conversation (Cursor/Claude-style session memory).
                if (sessionMessages.length > 0) {
                    vscode.postMessage({ type: 'autoSaveSession', messages: [...sessionMessages], sessionId: currentSessionId });
                    if (currentSessionId) {
                        // Also update the history entry so it stays current when the
                        // user opens the history panel without clicking "New" first.
                        vscode.postMessage({ type: 'updateSession', id: currentSessionId, messages: [...sessionMessages] });
                    }
                }
                break;

            case 'tokenUpdate':
                tokenStats = msg.tokens || tokenStats;
                costTotal = msg.cost || costTotal;
                updateStats();
                updateContextBar();
                break;

            case 'modelChanged':
                currentModel = msg.model || currentModel;
                if (modelSelect) modelSelect.value = msg.model || '';
                syncThinkingToggleVisibility(currentModel);
                updateStats();
                updateContextBar();
                break;

            case 'sessionCleared':
                messagesEl.innerHTML = '';
                if (welcomeEl) welcomeEl.classList.remove('hidden');
                currentStreamMsg = null;
                activeToolCards = {};
                sessionMessages = [];
                currentSessionId = null;
                currentSessionTitle = '';
                updateSessionIndicator();
                tokenStats = { input: 0, output: 0 };
                costTotal = 0;
                startTime = Date.now();
                streamStartTime = 0;
                streamOutputChars = 0;
                lastStreamTps = 0;
                if (statsSpeedItem) statsSpeedItem.style.display = 'none';
                // Restore pinned files into context
                contextFiles = pinnedFiles.map(f => ({ ...f, pinned: true }));
                renderContextFiles();
                updateStats();
                updateContextBar();
                // Clear the auto-saved active session
                vscode.postMessage({ type: 'autoSaveSession', messages: [] });
                // Refresh recent sessions for the newly-visible welcome screen
                if (allHistorySessions.length > 0) {
                    updateWelcomeRecentSessions(allHistorySessions);
                } else {
                    vscode.postMessage({ type: 'getHistory' });
                }
                break;

            case 'historyData':
                allHistorySessions = msg.sessions || [];
                renderHistoryList(allHistorySessions, historyFilterQuery);
                updateWelcomeRecentSessions(allHistorySessions);
                break;

            case 'sessionData':
                renderHistorySession(msg.messages || [], msg.id || null);
                break;

            case 'resumeFromHistoryData':
                // Direct-resume (Cursor-style): triggered when user clicks a history item
                restoreSessionMessages(msg.messages || [], msg.id || null);
                break;

            case 'fileContent':
                addContextFile(msg.name, msg.path);
                break;

            case 'activeFileContent':
                // Arrives after user clicks "Apply to file…"
                if (pendingApply && applyModal.classList.contains('visible')) {
                    showApplyModal(pendingApply.code, msg.content, msg.fileName);
                }
                break;

            case 'pinnedFiles':
                pinnedFiles = (msg.files || []);
                for (const f of pinnedFiles) {
                    addContextFile(f.name, f.path, true);
                }
                break;

            case 'inlineEditRequest':
                if (inputEl && msg.selectedText) {
                    const ctx = msg.hasSelection
                        ? `Edit this code from \`${msg.fileName}\`:\n\`\`\`\n${msg.selectedText}\n\`\`\`\n\nInstruction: `
                        : `Regarding \`${msg.fileName}\`: `;
                    inputEl.value = ctx;
                    inputEl.style.height = 'auto';
                    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                    inputEl.focus();
                    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
                }
                break;

            case 'initialized':
                currentModel = msg.model || 'claude-sonnet-4-6';
                currentMode  = msg.mode  || 'default';
                if (modelSelect && msg.model) modelSelect.value = msg.model;
                if (modeSelect && msg.mode) modeSelect.value = msg.mode;
                if (thinkingToggleEl) {
                    thinkingToggleEl.checked = !!msg.thinkingMode;
                    if (thinkingLabelEl) thinkingLabelEl.classList.toggle('active', !!msg.thinkingMode);
                }
                syncThinkingToggleVisibility(currentModel);
                // Show the mode description bar on startup so users know what mode is active
                showModeDesc(currentMode);
                updatePlanBoardVisibility();
                // Restore auto-attach state from settings
                autoAttachActive = !!msg.autoAttachActiveFile;
                if (autoAttachBtn) autoAttachBtn.classList.toggle('active', autoAttachActive);
                // Populate settings panel fields
                currentWorkspacePath = msg.workspacePath || '';
                populateSettingsPanel(msg);
                updateStats();
                updateContextBar();
                // Restore active session if one was persisted (survives VS Code restarts)
                if (msg.activeSession && msg.activeSession.length > 0) {
                    restoreSessionMessages(msg.activeSession, msg.activeSessionId || null);
                } else {
                    showWelcome(!!msg.hasApiKey);
                }
                // Load pinned files from settings
                vscode.postMessage({ type: 'getPinnedFiles' });
                // Initialize permanent file explorer
                initExplorer();
                // Start workspace watcher
                if (currentWorkspacePath) {
                    vscode.postMessage({ type: 'watchWorkspace', path: currentWorkspacePath });
                }
                break;

            case 'permissionRequest':
                showPermissionModal(msg);
                break;

            case 'apiKeySet':
                showWelcome(true);
                if (settingsKeyStatus) {
                    settingsKeyStatus.textContent = '✓ API key saved';
                    settingsKeyStatus.style.color = 'var(--success)';
                }
                break;

            case 'gitContext':
                addGitContext(msg.content || '', msg.branch || '');
                break;

            case 'workspaceDiagnostics':
                addErrorsContext(msg.diagnostics || []);
                break;

            case 'openEditors':
                renderAutocomplete(msg.files || []);
                break;

            case 'autoAttachState':
                autoAttachActive = !!msg.enabled;
                if (autoAttachBtn) autoAttachBtn.classList.toggle('active', autoAttachActive);
                break;

            case 'workspaceChanged':
                currentWorkspacePath = msg.path || '';
                if (settingWorkspace) settingWorkspace.value = currentWorkspacePath;
                if (explorerWorkspaceLabel) explorerWorkspaceLabel.textContent = currentWorkspacePath;
                // Always refresh explorer tree now that it's a permanent panel
                loadExplorerTree(currentWorkspacePath);
                // Restart workspace watcher
                vscode.postMessage({ type: 'watchWorkspace', path: currentWorkspacePath });
                break;

            case 'directoryListing':
                renderExplorerTree(msg.tree || [], msg.path || '');
                break;

            case 'fileData':
                if (msg.purpose === 'before_diff') {
                    // Store before content for diff view
                    if (pendingDiffEdit && msg.path === pendingDiffEdit.path) {
                        pendingDiffEdit.beforeContent = msg.content !== null ? (msg.content || '') : '';
                        // If result already arrived while we were waiting, trigger after read now
                        if (pendingDiffEdit.resultReady) {
                            pendingDiffEdit.resultReady = false;
                            vscode.postMessage({ type: 'readFile', path: pendingDiffEdit.path, purpose: 'after_diff' });
                        }
                    }
                } else if (msg.purpose === 'after_diff') {
                    // Open diff tab — if before is empty string it's a new file
                    if (pendingDiffEdit && msg.path === pendingDiffEdit.path) {
                        const before    = pendingDiffEdit.beforeContent !== null ? pendingDiffEdit.beforeContent : '';
                        const after     = msg.content || '';
                        const diffPath  = pendingDiffEdit.path;
                        pendingDiffEdit = null;
                        openDiffTab(diffPath, before, after);
                    }
                } else if (msg.purpose === 'open_editor') {
                    addOrActivateTab(msg);
                } else {
                    // Legacy: check if pending editor read, then fall back to file viewer modal
                    if (pendingEditorRead && msg.path === pendingEditorRead) {
                        pendingEditorRead = null;
                        addOrActivateTab(msg);
                    } else {
                        showFileViewer(msg.path, msg.name, msg.content, msg.error);
                    }
                }
                break;

            case 'fileCreated':
            case 'dirCreated':
            case 'fileRenamed':
            case 'fileDeleted':
            case 'fileWritten':
                // Refresh explorer tree after any file operation
                loadExplorerTree(currentWorkspacePath);
                if (msg.type === 'fileDeleted') {
                    closeTab(msg.path);
                }
                // Clear modified indicator if this was an editor save
                if ((msg.purpose === 'editor_save' || msg.purpose === 'editor_autosave') && msg.path) {
                    markTabSaved(msg.path);
                }
                break;

            case 'fileOpError':
                addSystemMessage(`⚠ File operation failed (${msg.op}): ${msg.error}`);
                break;

            case 'fileWatchEvent':
                // Debounced tree refresh on workspace changes
                if (fileWatchDebounce) clearTimeout(fileWatchDebounce);
                fileWatchDebounce = setTimeout(() => {
                    loadExplorerTree(currentWorkspacePath);
                }, 500);
                break;

            default:
                break;
        }
    });

    // ── Welcome / onboarding ──────────────────────────────────────────────────
    const setupGuideEl    = document.getElementById('setup-guide');
    const welcomeNormalEl = document.getElementById('welcome-normal');

    function showWelcome(hasKey) {
        if (!setupGuideEl || !welcomeNormalEl) return;
        if (hasKey) {
            setupGuideEl.style.display = 'none';
            welcomeNormalEl.style.display = 'flex';
            // Pre-populate recent sessions if already loaded; otherwise fetch
            if (allHistorySessions.length > 0) {
                updateWelcomeRecentSessions(allHistorySessions);
            } else {
                vscode.postMessage({ type: 'getHistory' });
            }
        } else {
            setupGuideEl.style.display = 'flex';
            welcomeNormalEl.style.display = 'none';
            if (welcomeRecentEl) welcomeRecentEl.style.display = 'none';
        }
    }

    /**
     * Render the top-3 most recent sessions on the welcome screen so users can
     * instantly resume a conversation without opening the history panel.
     */
    function updateWelcomeRecentSessions(sessions) {
        if (!welcomeRecentEl || !welcomeRecentList) return;
        // Only show when the welcome screen is actually visible
        if (!welcomeEl || welcomeEl.classList.contains('hidden')) {
            welcomeRecentEl.style.display = 'none';
            return;
        }
        const recent = sessions.slice(0, 3);
        if (recent.length === 0) {
            welcomeRecentEl.style.display = 'none';
            return;
        }
        welcomeRecentEl.style.display = '';
        welcomeRecentList.innerHTML = '';
        for (const s of recent) {
            const item = document.createElement('button');
            item.className = 'welcome-recent-item';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'welcome-recent-title';
            titleDiv.textContent = s.title || 'Untitled conversation';

            const metaDiv = document.createElement('div');
            metaDiv.className = 'welcome-recent-meta';
            const date = new Date(s.createdAt);
            const msgCount = s.messageCount || 0;
            metaDiv.textContent = `${date.toLocaleDateString()} · ${msgCount} msg${msgCount !== 1 ? 's' : ''}`;

            item.appendChild(titleDiv);
            item.appendChild(metaDiv);
            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'resumeFromHistory', id: s.id });
            });
            welcomeRecentList.appendChild(item);
        }
    }

    // Wire provider links to open in browser via extension
    ['link-anthropic', 'link-openai', 'link-google', 'link-nvidia'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'runCommand', command: 'vscode.open', args: [el.href] });
        });
    });

    // "Set API Key" button in setup guide
    const btnSetKey = document.getElementById('btn-set-key');
    if (btnSetKey) {
        btnSetKey.addEventListener('click', () => {
            vscode.postMessage({ type: 'runCommand', command: 'openClaudeCode.setApiKey' });
        });
    }

    // "Open Settings" button
    const btnOpenSettings = document.getElementById('btn-open-settings');
    if (btnOpenSettings) {
        btnOpenSettings.addEventListener('click', () => {
            openSettingsPanel();
        });
    }

    // Example prompts (setup guide + normal welcome) — click to fill input
    ['ex-1','ex-2','ex-3','ex-w-1','ex-w-2','ex-w-3'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', () => {
            if (inputEl) {
                inputEl.value = el.textContent.trim();
                inputEl.focus();
                inputEl.dispatchEvent(new Event('input'));
            }
        });
    });

    // ── Loading / sending state ───────────────────────────────────────────────
    function setLoading(on, text) {
        isLoading = on;
        if (loadingEl) loadingEl.classList.toggle('visible', on);
        if (loadingText && text) loadingText.textContent = text;
        else if (loadingText && !on) loadingText.textContent = 'Thinking…';
    }

    function setSending(on) {
        if (sendBtn) sendBtn.disabled = on;
        if (stopBtn) stopBtn.classList.toggle('visible', on);
        if (!on) setLoading(false);
    }

    // ── Stats bar ─────────────────────────────────────────────────────────────
    function updateStats() {
        if (statsModel) statsModel.textContent = currentModel || '—';
        if (statsTokens) {
            const total = (tokenStats.input || 0) + (tokenStats.output || 0);
            statsTokens.textContent = total >= 1000 ? `${(total/1000).toFixed(1)}K` : String(total);
        }
        if (statsCost) {
            statsCost.textContent = costTotal < 0.01
                ? `$${costTotal.toFixed(4)}`
                : `$${costTotal.toFixed(3)}`;
        }
        if (statsMsgsEl) {
            // Count completed user-assistant exchange pairs (floor division)
            const msgs = Math.floor(sessionMessages.length / 2);
            statsMsgsEl.textContent = msgs > 0 ? String(msgs) : '0';
        }
    }

    // ── Context files ─────────────────────────────────────────────────────────
    function addContextFile(name, filePath, pinned = false) {
        if (contextFiles.find(f => f.path === filePath)) return;
        contextFiles.push({ name, path: filePath, pinned });
        renderContextFiles();
    }

    function removeContextFile(filePath) {
        const file = contextFiles.find(f => f.path === filePath);
        if (file && file.pinned) {
            // Unpin when removed
            pinnedFiles = pinnedFiles.filter(p => p.path !== filePath);
            vscode.postMessage({ type: 'unpinFile', path: filePath });
        }
        contextFiles = contextFiles.filter(f => f.path !== filePath);
        renderContextFiles();
        vscode.postMessage({ type: 'removeContextFile', path: filePath });
    }

    function renderContextFiles() {
        if (!contextFilesEl) return;
        contextFilesEl.innerHTML = '';
        for (const f of contextFiles) {
            const chip = document.createElement('div');
            chip.className = 'context-chip'
                + (f.pinned    ? ' pinned'      : '')
                + (f.isGit     ? ' chip-git'    : '')
                + (f.isErrors  ? ' chip-errors' : '');
            if (f.title) chip.title = f.title;

            const nameSpan = document.createElement('span');
            // Special chips carry their icon in the name; files get an icon prefix
            const icon = f.isImage ? '🖼 ' : (f.isCodebase || f.isGit || f.isErrors) ? '' : (f.pinned ? '📌 ' : '📄 ');
            nameSpan.textContent = icon + f.name;

            if (f.isImage && f.dataUrl) {
                const img = document.createElement('img');
                // dataUrl is always a data: URI from FileReader.readAsDataURL — validate before use
                if (/^data:image\/[a-z]+;base64,/.test(f.dataUrl)) {
                    img.src = f.dataUrl;
                }
                img.alt = f.name;
                chip.appendChild(img);
            }

            if (!f.isCodebase && !f.isImage && !f.isGit && !f.isErrors) {
                const pinBtn = document.createElement('button');
                pinBtn.className = 'pin-btn';
                pinBtn.title = f.pinned ? 'Unpin file' : 'Pin to all sessions';
                pinBtn.textContent = '📎';
                pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePinFile(f); });
                chip.appendChild(nameSpan);
                chip.appendChild(pinBtn);
            } else {
                chip.appendChild(nameSpan);
            }

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => removeContextFile(f.path));
            chip.appendChild(removeBtn);
            contextFilesEl.appendChild(chip);
        }
        contextFilesEl.style.display = contextFiles.length ? 'flex' : 'none';
    }

    // ── Input handling ────────────────────────────────────────────────────────
    if (inputEl) {
        inputEl.addEventListener('input', () => {
            // Auto-resize
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';

            // Character count hint
            if (charCountEl) {
                const len = inputEl.value.length;
                if (len > CHAR_COUNT_MIN_DISPLAY) {
                    charCountEl.textContent = len >= 1000 ? `${(len/1000).toFixed(1)}k chars` : `${len} chars`;
                    charCountEl.classList.toggle('warn', len > CHAR_COUNT_WARNING_THRESHOLD);
                } else {
                    charCountEl.textContent = '';
                    charCountEl.classList.remove('warn');
                }
            }

            const val = inputEl.value;
            const cursorPos = inputEl.selectionStart;
            const before = val.slice(0, cursorPos);

            // @codebase special mention — replace with chip immediately
            if (val.includes('@codebase')) {
                inputEl.value = val.replace(/@codebase\b/g, '').trim();
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                addCodebaseContext();
                hideAutocomplete();
                return;
            }

            // @git — inject git status as context chip
            if (/@git\b/.test(val)) {
                inputEl.value = val.replace(/@git\b/g, '').trim();
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                requestGitContext();
                hideAutocomplete();
                return;
            }

            // @errors — inject workspace diagnostics as context chip
            if (/@errors\b/.test(val)) {
                inputEl.value = val.replace(/@errors\b/g, '').trim();
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                requestErrorsContext();
                hideAutocomplete();
                return;
            }

            // @openfiles — show open editor tabs in autocomplete
            if (/@openfiles\b/.test(val)) {
                inputEl.value = val.replace(/@openfiles\b/g, '').trim();
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                requestOpenFiles();
                // keep autocomplete open — it will be populated when response arrives
                return;
            }

            // Slash command autocomplete (when first char is /)
            const slashMatch = val.match(/^(\/[\w]*)$/);
            if (slashMatch) {
                showSlashCommands(slashMatch[1].slice(1));
                return;
            }

            // @mention autocomplete
            const atMatch = before.match(/@([\w./\\-]*)$/);
            if (atMatch) {
                showFileAutocomplete(atMatch[1]);
            } else {
                hideAutocomplete();
            }
        });

        inputEl.addEventListener('keydown', (e) => {
            // Submit on Enter (not Shift+Enter) or Ctrl/Cmd+Enter
            if (e.key === 'Enter' && (!e.shiftKey || e.ctrlKey || e.metaKey) && !autocompleteEl.classList.contains('visible')) {
                e.preventDefault();
                submitMessage();
                return;
            }
            // Autocomplete navigation
            if (autocompleteEl.classList.contains('visible')) {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveAcSelection(1); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); moveAcSelection(-1); return; }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    selectAcItem();
                    return;
                }
                if (e.key === 'Escape') { hideAutocomplete(); return; }
            }
            // Up arrow in empty input → recall last message
            if (e.key === 'ArrowUp' && !inputEl.value && !autocompleteEl.classList.contains('visible')) {
                if (lastUserMessage) {
                    e.preventDefault();
                    inputEl.value = lastUserMessage;
                    inputEl.style.height = 'auto';
                    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
                }
                return;
            }
            // Escape cancels loading
            if (e.key === 'Escape' && isLoading) {
                vscode.postMessage({ type: 'cancel' });
                setSending(false);
            }
        });

        // Image paste
        inputEl.addEventListener('paste', (e) => {
            const items = [...(e.clipboardData?.items || [])];
            const imgItem = items.find(it => it.type.startsWith('image/'));
            if (!imgItem) return;
            e.preventDefault();
            const file = imgItem.getAsFile();
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => addImageContext(file.name || 'screenshot.png', ev.target.result);
            reader.readAsDataURL(file);
        });
    }

    // ── Drag-and-drop files onto input ────────────────────────────────────────
    const inputWrapper = document.getElementById('input-wrapper');
    if (inputWrapper) {
        const CODE_EXTS = new Set([
            'js','ts','jsx','tsx','py','go','rs','java','cpp','c','h','cs','rb',
            'php','swift','kt','scala','sh','bash','zsh','md','json','yaml','yml',
            'toml','html','css','scss','less','vue','svelte','sql','graphql','tf','txt',
        ]);
        inputWrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            inputWrapper.classList.add('drag-over');
        });
        inputWrapper.addEventListener('dragleave', () => inputWrapper.classList.remove('drag-over'));
        inputWrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            inputWrapper.classList.remove('drag-over');
            const files = [...(e.dataTransfer?.files || [])];
            for (const file of files) {
                const ext = (file.name.split('.').pop() || '').toLowerCase();
                if (CODE_EXTS.has(ext)) {
                    const filePath = file.path || file.name;
                    vscode.postMessage({ type: 'addContextFile', path: filePath, name: file.name });
                }
            }
        });
    }

    if (sendBtn) {
        sendBtn.addEventListener('click', submitMessage);
    }

    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
            setSending(false);
        });
    }

    // ── Quick Actions toggle ───────────────────────────────────────────────────
    if (actionsBtn && quickActionsPanel) {
        actionsBtn.addEventListener('click', () => {
            const visible = quickActionsPanel.style.display !== 'none';
            quickActionsPanel.style.display = visible ? 'none' : '';
            actionsBtn.classList.toggle('active', !visible);
        });
        // Wire each quick-action button → fill input with template
        quickActionsPanel.querySelectorAll('.qa-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const template = btn.dataset.template || '';
                if (!template || !inputEl) return;
                inputEl.value = template + '\n';
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                inputEl.focus();
                inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
                // Collapse the panel after selecting to give the user more space
                quickActionsPanel.style.display = 'none';
                actionsBtn.classList.remove('active');
            });
        });
    }

    // ── Mode description bar ─────────────────────────────────────────────────
    function showModeDesc(mode) {
        const desc = MODE_DESCRIPTIONS[mode];
        if (!modeDescBar || !modeDescText || !desc) return;
        modeDescText.textContent = desc;
        modeDescBar.style.display = '';
    }
    function hideModeDesc() {
        if (modeDescBar) modeDescBar.style.display = 'none';
    }
    if (modeDescCloseBtn) {
        modeDescCloseBtn.addEventListener('click', hideModeDesc);
    }
    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            currentMode = modeSelect.value;
            showModeDesc(modeSelect.value);
            // Show/hide plan board based on mode
            updatePlanBoardVisibility();
            vscode.postMessage({ type: 'mode', mode: modeSelect.value });
        });
    }

    function submitMessage() {
        if (!inputEl) return;
        const rawText = inputEl.value.trim();
        if (!rawText || isLoading) return;

        // Extract @file references from text before sending
        const fileRefs = [];
        rawText.replace(/@([\w./\\-]+)/g, (_, p) => fileRefs.push(p));

        addUserMessage(rawText);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        hideAutocomplete();
        setSending(true);
        setLoading(true, 'Thinking…');

        // Append inline content from special context chips (@git, @errors)
        const specialParts = [];
        for (const f of contextFiles) {
            if (f.isGit && f.content)    specialParts.push('\n\n[Git Context]\n' + f.content);
            if (f.isErrors && f.content) specialParts.push('\n\n[Workspace Problems]\n' + f.content);
        }
        // Inject active plan context so the agent always remembers the to-do list
        const planCtx = buildPlanContext();
        const finalMessage = rawText + specialParts.join('') + planCtx;

        // Separate file paths from image/codebase/special context entries
        const sendContextFiles = contextFiles
            .filter(f => !f.isImage && !f.isCodebase && !f.isGit && !f.isErrors)
            .map(f => f.path);
        const hasCodebase = contextFiles.some(f => f.isCodebase);

        vscode.postMessage({
            type: 'send',
            message: finalMessage,
            contextFiles: sendContextFiles,
            fileRefs,
            useCodebase: hasCodebase,
        });

        // Clear non-pinned context after send
        contextFiles = contextFiles.filter(f => f.pinned);
        renderContextFiles();
    }

    // ── File autocomplete ─────────────────────────────────────────────────────
    let acItems = [];
    let acSelectedIdx = -1;

    function showFileAutocomplete(query) {
        vscode.postMessage({ type: 'fileSearch', query });
    }

    // ── Slash command autocomplete ─────────────────────────────────────────────
    const SLASH_COMMANDS = [
        { cmd: '/clear',    desc: 'Clear conversation and start fresh' },
        { cmd: '/new',      desc: 'Start a new conversation (alias for /clear)' },
        { cmd: '/model',    desc: 'Switch AI model' },
        { cmd: '/mode',     desc: 'Switch permission mode: default · auto · plan · acceptEdits · bypass' },
        { cmd: '/export',   desc: 'Export conversation as Markdown' },
        { cmd: '/help',     desc: 'Show keyboard shortcuts' },
        { cmd: '/pin',      desc: 'Pin all current context files to every session' },
        { cmd: '/explain',  desc: 'Explain the code/file in context',      template: 'Explain what this code does in simple terms:' },
        { cmd: '/fix',      desc: 'Find and fix bugs',                      template: 'Find and fix the bugs in this code. Explain what was wrong:' },
        { cmd: '/refactor', desc: 'Refactor for clarity and maintainability', template: 'Refactor this code to be cleaner and more maintainable:' },
        { cmd: '/test',     desc: 'Write unit tests',                       template: 'Write comprehensive unit tests for this code:' },
        { cmd: '/review',   desc: 'Code review for bugs and improvements',  template: 'Review this code for potential bugs, security issues, and improvements:' },
        { cmd: '/docs',     desc: 'Generate documentation comments',        template: 'Generate clear documentation/JSDoc comments for this code:' },
        { cmd: '/commit',   desc: 'Generate a git commit message',          template: 'Generate a concise git commit message (conventional commits style) for these changes:' },
        { cmd: '/optimize', desc: 'Optimize code for performance',          template: 'Optimize this code for better performance and explain the changes:' },
    ];

    function showSlashCommands(prefix) {
        const filtered = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(prefix));
        if (!filtered.length) { hideAutocomplete(); return; }
        acItems = filtered.map(c => ({ isSlash: true, cmd: c.cmd, desc: c.desc }));
        acSelectedIdx = 0;
        autocompleteEl.innerHTML = '';
        for (let i = 0; i < filtered.length; i++) {
            const c = filtered[i];
            const item = document.createElement('div');
            item.className = 'ac-item' + (i === 0 ? ' selected' : '');
            const cmdSpan = document.createElement('span');
            cmdSpan.className = 'ac-name';
            cmdSpan.style.fontWeight = '600';
            cmdSpan.textContent = c.cmd;
            const descSpan = document.createElement('span');
            descSpan.className = 'ac-desc';
            descSpan.textContent = c.desc;
            item.appendChild(cmdSpan);
            item.appendChild(descSpan);
            item.addEventListener('click', () => { acSelectedIdx = i; selectAcItem(); });
            autocompleteEl.appendChild(item);
        }
        autocompleteEl.classList.add('visible');
    }

    function executeSlashCommand(cmd) {
        // Check for template commands first
        const slashEntry = SLASH_COMMANDS.find(c => c.cmd === cmd);
        if (slashEntry && slashEntry.template) {
            if (inputEl) {
                inputEl.value = slashEntry.template + '\n';
                inputEl.style.height = 'auto';
                inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
                inputEl.focus();
                inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
            }
            return;
        }
        switch (cmd) {
            case '/clear':
            case '/new':   newChatBtn && newChatBtn.click(); break;
            case '/model':   modelSelect && modelSelect.focus(); break;
            case '/export':  exportBtn && exportBtn.click(); break;
            case '/pin':     contextFiles.filter(f => !f.pinned).forEach(f => togglePinFile(f)); break;
            case '/help':
                addSystemMessage(
                    'Keyboard shortcuts: Enter=send · Shift+Enter=newline · @=add file · ' +
                    '@codebase=full codebase · /=commands · ↑=recall last message · ' +
                    'Ctrl+L=focus input · Ctrl+F=search · Ctrl+K=inline edit · Esc=stop\n\n' +
                    'Template commands: /explain · /fix · /refactor · /test · /review · /docs · /commit · /optimize'
                );
                break;
        }
    }

    function renderAutocomplete(files) {
        if (!files || files.length === 0) { hideAutocomplete(); return; }
        acItems = files;
        acSelectedIdx = 0;
        autocompleteEl.innerHTML = '';
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const item = document.createElement('div');
            item.className = 'ac-item' + (i === 0 ? ' selected' : '');
            item.innerHTML = `
                <span class="ac-icon">📄</span>
                <span class="ac-name">${escapeHtml(f.name)}</span>
                <span class="ac-desc">${escapeHtml(f.relativePath || '')}</span>
            `;
            item.addEventListener('click', () => {
                acSelectedIdx = i;
                selectAcItem();
            });
            autocompleteEl.appendChild(item);
        }
        autocompleteEl.classList.add('visible');
    }

    function hideAutocomplete() {
        autocompleteEl.classList.remove('visible');
        acItems = [];
        acSelectedIdx = -1;
    }

    function moveAcSelection(dir) {
        const items = autocompleteEl.querySelectorAll('.ac-item');
        if (items.length === 0) return;
        items[acSelectedIdx]?.classList.remove('selected');
        acSelectedIdx = (acSelectedIdx + dir + items.length) % items.length;
        items[acSelectedIdx]?.classList.add('selected');
    }

    function selectAcItem() {
        if (acSelectedIdx < 0 || acSelectedIdx >= acItems.length) return;
        const item = acItems[acSelectedIdx];

        // Slash command selection
        if (item.isSlash) {
            inputEl.value = '';
            inputEl.style.height = 'auto';
            hideAutocomplete();
            executeSlashCommand(item.cmd);
            return;
        }

        // File selection — replace @query in input
        const file = item;
        const val = inputEl.value;
        const cursorPos = inputEl.selectionStart;
        const before = val.slice(0, cursorPos);
        const replaced = before.replace(/@[\w./\\-]*$/, '') + `@${file.name} `;
        inputEl.value = replaced + val.slice(cursorPos);
        inputEl.setSelectionRange(replaced.length, replaced.length);
        hideAutocomplete();
        vscode.postMessage({ type: 'addContextFile', path: file.path, name: file.name });
    }

    // ── History Panel ─────────────────────────────────────────────────────────
    /**
     * Persist the current in-progress session before switching to another one.
     * - If we're continuing a history session, update that entry (no duplicate).
     * - If this is a fresh session, create a new history entry.
     */
    function saveCurrentSessionIfNeeded() {
        if (sessionMessages.length === 0) return;
        if (currentSessionId) {
            vscode.postMessage({ type: 'updateSession', id: currentSessionId, messages: [...sessionMessages] });
        } else {
            vscode.postMessage({ type: 'saveSession', messages: [...sessionMessages] });
        }
    }

    /**
     * Restore a set of saved messages into the main chat panel and re-inject them
     * into the agent bridge, so the model remembers the full conversation context
     * (Cursor/Claude-style session memory).
     *
     * @param {Array}       messages  - saved user/assistant message objects
     * @param {string|null} sessionId - history entry ID being continued; null for a new session
     */
    function restoreSessionMessages(messages, sessionId) {
        // Track which history session we are editing so we update it (not duplicate it)
        currentSessionId = sessionId !== undefined ? sessionId : null;

        // Derive header title from the first user message in this session
        const firstUser = messages.find(m => m.type === 'user');
        currentSessionTitle = firstUser ? firstUser.text.trim().slice(0, SESSION_TITLE_DISPLAY_LENGTH).replace(/\n/g, ' ') : '';
        updateSessionIndicator();

        // Clear current UI state
        messagesEl.innerHTML = '';
        sessionMessages = [];
        activeToolCards = {};
        tokenStats = { input: 0, output: 0 };
        costTotal = 0;
        startTime = Date.now();
        updateStats();
        updateContextBar();

        if (messages.length === 0) {
            showWelcome(true);
            return;
        }

        // Replay messages into the DOM (addUserMessage / finalizeAssistantMessage
        // only touch the DOM and sessionMessages — they do not send to the bridge)
        for (const m of messages) {
            if (m.type === 'user') {
                addUserMessage(m.text);
            } else if (m.type === 'assistant') {
                finalizeAssistantMessage(m.text);
            }
        }

        // Re-inject the conversation history into the agent bridge so the next
        // user message is answered with full knowledge of the entire session.
        vscode.postMessage({ type: 'resumeSession', messages });
    }

    function openHistoryPanel() {
        if (historyPanel) historyPanel.classList.add('visible');
        if (historySessionView) historySessionView.classList.remove('visible');
        if (historyList) historyList.style.display = '';
        if (historyBackBtn) historyBackBtn.style.display = 'none';
        if (historyPanelTitle) historyPanelTitle.textContent = 'Chat History';
        if (historySearchBar) historySearchBar.classList.remove('hidden');
        // Reset search when panel opens
        if (historySearch) historySearch.value = '';
        historyFilterQuery = '';
        vscode.postMessage({ type: 'getHistory' });
    }

    function closeHistoryPanel() {
        if (historyPanel) historyPanel.classList.remove('visible');
    }

    function renderHistoryList(sessions, filter) {
        if (!historyList) return;
        historyList.innerHTML = '';
        const lFilter = (filter || '').toLowerCase().trim();
        const displayed = lFilter
            ? sessions.filter(s => (s.title || '').toLowerCase().includes(lFilter))
            : sessions;
        if (displayed.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'history-empty';
            empty.textContent = lFilter
                ? 'No conversations match your search.'
                : 'No saved conversations yet.\nStart a new chat and click "New" to save it to history.';
            historyList.appendChild(empty);
            return;
        }
        for (const session of displayed) {
            const item = document.createElement('div');
            item.className = 'history-item' + (session.id === currentSessionId ? ' active' : '');

            const titleEl = document.createElement('div');
            titleEl.className = 'history-item-title';
            titleEl.textContent = session.title || 'Untitled conversation';

            const metaEl = document.createElement('div');
            metaEl.className = 'history-item-meta';
            const dateEl = document.createElement('span');
            dateEl.textContent = new Date(session.createdAt).toLocaleString();
            const countEl = document.createElement('span');
            const msgCount = session.messageCount || 0;
            countEl.textContent = `${msgCount} msg${msgCount !== 1 ? 's' : ''}`;
            metaEl.appendChild(dateEl);
            metaEl.appendChild(countEl);

            const actionsEl = document.createElement('div');
            actionsEl.className = 'history-item-actions';

            const renameBtn = document.createElement('button');
            renameBtn.className = 'history-action-btn';
            renameBtn.title = 'Rename';
            renameBtn.textContent = '✏';
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newTitle = window.prompt('Rename conversation:', session.title || '');
                if (newTitle !== null && newTitle.trim()) {
                    vscode.postMessage({ type: 'renameSession', id: session.id, title: newTitle.trim() });
                }
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'history-action-btn history-delete-btn';
            deleteBtn.title = 'Delete';
            deleteBtn.textContent = '🗑';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.confirm('Delete this conversation?')) {
                    vscode.postMessage({ type: 'deleteSession', id: session.id });
                }
            });

            actionsEl.appendChild(renameBtn);
            actionsEl.appendChild(deleteBtn);

            item.appendChild(titleEl);
            item.appendChild(metaEl);
            item.appendChild(actionsEl);
            // Cursor/Claude-style: clicking a session immediately switches to it.
            // The current session is auto-saved before switching so nothing is lost.
            item.addEventListener('click', () => {
                saveCurrentSessionIfNeeded();
                closeHistoryPanel();
                vscode.postMessage({ type: 'resumeFromHistory', id: session.id });
            });
            historyList.appendChild(item);
        }
    }

    let historyViewMessages = []; // messages of the session currently shown in history panel
    let historyViewSessionId = null; // ID of that session

    function renderHistorySession(messages, sessionId) {
        if (!historySessionView) return;
        historyViewMessages = messages;
        historyViewSessionId = sessionId || null;
        historySessionView.innerHTML = '';

        // ── Resume button ────────────────────────────────────────────────────
        if (messages.length > 0) {
            const resumeBar = document.createElement('div');
            resumeBar.className = 'history-resume-bar';

            const resumeBtn = document.createElement('button');
            resumeBtn.className = 'history-resume-btn';
            resumeBtn.textContent = '▶ Continue this conversation';
            resumeBtn.title = 'Switch to this conversation — the model will remember everything from the beginning';
            resumeBtn.addEventListener('click', () => {
                saveCurrentSessionIfNeeded();
                closeHistoryPanel();
                restoreSessionMessages(historyViewMessages, historyViewSessionId);
            });

            resumeBar.appendChild(resumeBtn);
            historySessionView.appendChild(resumeBar);
        }

        for (const m of messages) {
            if (m.type === 'user') {
                const div = document.createElement('div');
                div.className = 'msg msg-user';
                div.innerHTML = `
                    <div class="msg-meta">You</div>
                    <div class="msg-bubble">${escapeHtml(m.text)}</div>
                `;
                historySessionView.appendChild(div);
            } else if (m.type === 'assistant') {
                const div = document.createElement('div');
                div.className = 'msg msg-assistant';
                div.innerHTML = `
                    <div class="msg-header">
                        <div class="msg-avatar">✦</div>
                        <span class="msg-name">Claude</span>
                    </div>
                    <div class="msg-content">${renderMarkdown(m.text)}</div>
                `;
                addCopyButtonToMessage(div, m.text);
                historySessionView.appendChild(div);
            }
        }

        // Show session view, hide list
        if (historyList) historyList.style.display = 'none';
        historySessionView.classList.add('visible');
        if (historyBackBtn) historyBackBtn.style.display = '';
        if (historyPanelTitle) historyPanelTitle.textContent = 'Past Conversation';
        if (historySearchBar) historySearchBar.classList.add('hidden');
        historySessionView.scrollTop = 0;
    }

    if (historyBtn) historyBtn.addEventListener('click', openHistoryPanel);
    if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeHistoryPanel);

    // Filter history list as user types
    if (historySearch) {
        historySearch.addEventListener('input', () => {
            historyFilterQuery = historySearch.value.trim();
            renderHistoryList(allHistorySessions, historyFilterQuery);
        });
        historySearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                historySearch.value = '';
                historyFilterQuery = '';
                renderHistoryList(allHistorySessions, '');
            }
        });
    }
    if (historyBackBtn) {
        historyBackBtn.addEventListener('click', () => {
            if (historySessionView) historySessionView.classList.remove('visible');
            if (historyList) historyList.style.display = '';
            if (historyBackBtn) historyBackBtn.style.display = 'none';
            if (historyPanelTitle) historyPanelTitle.textContent = 'Chat History';
            if (historySearchBar) historySearchBar.classList.remove('hidden');
        });
    }

    // ── Toolbar buttons ───────────────────────────────────────────────────────
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            saveCurrentSessionIfNeeded();
            sessionMessages = [];
            currentSessionId = null;
            vscode.postMessage({ type: 'clear' });
            // Immediately restore pinned files for the new session
            contextFiles = pinnedFiles.map(f => ({ ...f, pinned: true }));
            renderContextFiles();
        });
    }

    if (addFileBtn) {
        addFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'pickFile' });
        });
    }

    if (activeFileBtn) {
        activeFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'addActiveFile' });
        });
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            openSettingsPanel();
        });
    }

    // Export conversation as Markdown
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (sessionMessages.length === 0) return;
            const lines = sessionMessages.map(m =>
                m.type === 'user'
                    ? `## You\n\n${m.text}`
                    : `## Claude\n\n${m.text}`
            );
            const markdown = lines.join('\n\n---\n\n');
            vscode.postMessage({ type: 'exportConversation', markdown });
        });
    }

    // Auto-scroll toggle
    if (autoscrollBtn) {
        autoscrollBtn.addEventListener('click', () => {
            autoScroll = !autoScroll;
            autoscrollBtn.classList.toggle('locked', !autoScroll);
            autoscrollBtn.title = autoScroll ? 'Auto-scroll: On (click to lock)' : 'Auto-scroll: Off (click to unlock)';
            if (autoScroll) scrollToBottom();
        });
    }

    // Re-enable auto-scroll when user scrolls to the bottom
    messagesEl.addEventListener('scroll', () => {
        const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
        if (atBottom && !autoScroll) {
            autoScroll = true;
            if (autoscrollBtn) {
                autoscrollBtn.classList.remove('locked');
                autoscrollBtn.title = 'Auto-scroll: On (click to lock)';
            }
        } else if (!atBottom && autoScroll && isLoading) {
            // User scrolled up while response is streaming — pause auto-scroll
            autoScroll = false;
            if (autoscrollBtn) {
                autoscrollBtn.classList.add('locked');
                autoscrollBtn.title = 'Auto-scroll: Off (click to unlock)';
            }
        }
    });

    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            vscode.postMessage({ type: 'model', model: modelSelect.value });
            currentModel = modelSelect.value;
            updateStats();
            syncThinkingToggleVisibility(modelSelect.value);
        });
    }

    // ── Thinking mode toggle (NVIDIA capable models only) ─────────────────────
    function syncThinkingToggleVisibility(model) {
        const visible = THINKING_CAPABLE_MODELS.has(model);
        const display = visible ? '' : 'none';
        if (thinkingToggleWrapper) thinkingToggleWrapper.style.display = display;
        if (thinkingLabelEl)       thinkingLabelEl.style.display       = display;
    }

    if (thinkingToggleEl) {
        thinkingToggleEl.addEventListener('change', () => {
            const enabled = thinkingToggleEl.checked;
            if (thinkingLabelEl) thinkingLabelEl.classList.toggle('active', enabled);
            vscode.postMessage({ type: 'thinkingMode', enabled });
        });
    }

    // ── Message from extension: fileSearchResults ─────────────────────────────
    window.addEventListener('message', (event) => {
        if (event.data.type === 'fileSearchResults') {
            renderAutocomplete(event.data.files || []);
        }
    });

    // ── Context inject buttons ─────────────────────────────────────────────────
    if (gitBtn) {
        gitBtn.addEventListener('click', () => requestGitContext());
    }
    if (errorsBtn) {
        errorsBtn.addEventListener('click', () => requestErrorsContext());
    }
    if (autoAttachBtn) {
        autoAttachBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'toggleAutoAttach' });
        });
    }
    if (contextWarningNewBtn) {
        contextWarningNewBtn.addEventListener('click', () => {
            newChatBtn && newChatBtn.click();
        });
    }

    // ── Settings Panel ────────────────────────────────────────────────────────

    function populateSettingsPanel(msg) {
        if (settingWorkspace)      settingWorkspace.value  = msg.workspacePath || '';
        if (settingModel)          settingModel.value       = msg.model || 'claude-sonnet-4-6';
        if (settingMode)           settingMode.value        = msg.mode || 'default';
        if (settingMaxTurns)       settingMaxTurns.value    = msg.maxTurns || 20;
        if (settingShowToolOutput) settingShowToolOutput.checked = msg.showToolOutput !== false;
        if (settingNvidiaKey)      settingNvidiaKey.placeholder = msg.hasNvidiaKey ? '••••••• (set — enter to change)' : 'nvapi-… (leave blank to clear)';
    }

    function openSettingsPanel() {
        if (!settingsPanel) return;
        settingsPanel.classList.add('visible');
    }

    function closeSettingsPanel() {
        if (!settingsPanel) return;
        settingsPanel.classList.remove('visible');
    }

    if (settingsCloseBtn) {
        settingsCloseBtn.addEventListener('click', closeSettingsPanel);
    }

    if (settingModel) {
        settingModel.addEventListener('change', () => {
            const val = settingModel.value;
            vscode.postMessage({ type: 'saveSettings', key: 'model', value: val });
            // Also sync the main controls bar
            if (modelSelect) { modelSelect.value = val; currentModel = val; updateStats(); syncThinkingToggleVisibility(val); }
        });
    }

    if (settingMode) {
        settingMode.addEventListener('change', () => {
            const val = settingMode.value;
            vscode.postMessage({ type: 'saveSettings', key: 'permissionMode', value: val });
            if (modeSelect) modeSelect.value = val;
        });
    }

    if (settingMaxTurns) {
        settingMaxTurns.addEventListener('change', () => {
            const val = parseInt(settingMaxTurns.value, 10);
            if (!isNaN(val) && val > 0) {
                vscode.postMessage({ type: 'saveSettings', key: 'maxTurns', value: val });
            }
        });
    }

    if (settingShowToolOutput) {
        settingShowToolOutput.addEventListener('change', () => {
            vscode.postMessage({ type: 'saveSettings', key: 'showToolOutput', value: settingShowToolOutput.checked });
        });
    }

    if (settingsPickWorkspace) {
        settingsPickWorkspace.addEventListener('click', () => {
            // Use existing pickFile flow indirectly; here we fire workspace open via main menu equivalent
            vscode.postMessage({ type: 'runCommand', command: 'openWorkspaceFolder' });
        });
    }

    if (settingsSetKeyBtn) {
        settingsSetKeyBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'runCommand', command: 'openClaudeCode.setApiKey' });
        });
    }

    if (settingsSaveNvidiaBtn) {
        settingsSaveNvidiaBtn.addEventListener('click', () => {
            const val = settingNvidiaKey ? settingNvidiaKey.value.trim() : '';
            vscode.postMessage({ type: 'saveSettings', key: 'nvidiaApiKey', value: val });
            if (settingsKeyStatus) {
                settingsKeyStatus.textContent = val ? '✓ NVIDIA key saved' : '✓ NVIDIA key cleared';
                settingsKeyStatus.style.color = 'var(--success)';
            }
            if (settingNvidiaKey) {
                settingNvidiaKey.value = '';
                settingNvidiaKey.placeholder = val ? '••••••• (set — enter to change)' : 'nvapi-… (leave blank to clear)';
            }
        });
    }

    if (settingsOpenFolderBtn) {
        settingsOpenFolderBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openSettingsFolder' });
        });
    }

    if (settingsGhLink) {
        settingsGhLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'runCommand', command: 'vscode.open', args: ['https://github.com/codomium/FreeCode'] });
        });
    }

    // ── File Explorer Panel ───────────────────────────────────────────────────

    function loadExplorerTree(dirPath) {
        if (explorerTree) {
            explorerTree.innerHTML = '<div class="explorer-loading">Loading…</div>';
        }
        vscode.postMessage({ type: 'listDirectory', path: dirPath || currentWorkspacePath });
    }

    function openExplorerPanel() {
        if (!explorerPanel) return;
        explorerPanel.classList.add('visible');
        if (explorerWorkspaceLabel) explorerWorkspaceLabel.textContent = currentWorkspacePath || '(home)';
        loadExplorerTree(currentWorkspacePath);
    }

    function closeExplorerPanel() {
        if (!explorerPanel) return;
        explorerPanel.classList.remove('visible');
    }

    if (explorerBtn)       explorerBtn.addEventListener('click', openExplorerPanel);
    if (explorerCloseBtn)  explorerCloseBtn.addEventListener('click', closeExplorerPanel);
    if (explorerRefreshBtn) explorerRefreshBtn.addEventListener('click', () => loadExplorerTree(currentWorkspacePath));

    /** Render the directory tree into #explorer-tree */
    function renderExplorerTree(tree, rootPath) {
        if (!explorerTree) return;
        explorerTree.innerHTML = '';
        if (!tree || tree.length === 0) {
            explorerTree.innerHTML = '<div class="explorer-empty">No files found.</div>';
            return;
        }
        explorerTree.appendChild(buildTreeNodes(tree, 0));
    }

    function buildTreeNodes(items, depth) {
        const ul = document.createElement('ul');
        ul.className = 'explorer-list';
        if (depth > 0) ul.style.paddingLeft = '14px';

        for (const item of items) {
            const li = document.createElement('li');
            li.className = 'explorer-item explorer-' + item.type;

            const row = document.createElement('div');
            row.className = 'explorer-row';
            row.setAttribute('title', item.path);

            const icon = document.createElement('span');
            icon.className = 'explorer-icon';

            if (item.type === 'dir') {
                icon.textContent = '▶';
                icon.className += ' explorer-chevron';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'explorer-name';
                nameSpan.textContent = item.name;
                row.appendChild(icon);
                row.appendChild(nameSpan);

                // Children container (collapsed by default)
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'explorer-children';
                childrenContainer.style.display = 'none';

                let expanded = false;
                let loaded = false;

                row.addEventListener('click', () => {
                    expanded = !expanded;
                    icon.classList.toggle('expanded', expanded);
                    icon.textContent = expanded ? '▼' : '▶';
                    childrenContainer.style.display = expanded ? '' : 'none';
                    if (expanded && !loaded && item.children && item.children.length > 0) {
                        childrenContainer.appendChild(buildTreeNodes(item.children, depth + 1));
                        loaded = true;
                    }
                });

                row.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtxMenu(e.clientX, e.clientY, { path: item.path, name: item.name, type: 'dir' });
                });

                li.appendChild(row);
                li.appendChild(childrenContainer);
            } else {
                const ext = (item.name.split('.').pop() || '').toLowerCase();
                icon.textContent = getFileIcon(ext);
                icon.className = 'explorer-icon explorer-file-icon';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'explorer-name';
                nameSpan.textContent = item.name;
                row.appendChild(icon);
                row.appendChild(nameSpan);

                // Right-click or click → context menu (view / add to context)
                row.addEventListener('click', () => {
                    openFileViewerFromExplorer(item.path, item.name);
                });

                row.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtxMenu(e.clientX, e.clientY, { path: item.path, name: item.name, type: 'file' });
                });

                // Show a small "add to context" button on hover
                const ctxBtn = document.createElement('button');
                ctxBtn.className = 'explorer-ctx-btn';
                ctxBtn.title = 'Add to context';
                ctxBtn.textContent = '+';
                ctxBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ type: 'addContextFile', path: item.path });
                });
                row.appendChild(ctxBtn);

                li.appendChild(row);
            }

            ul.appendChild(li);
        }
        return ul;
    }

    function getFileIcon(ext) {
        const icons = {
            js: '📄', ts: '📄', jsx: '📄', tsx: '📄',
            py: '🐍', rb: '💎', go: '🐹', rs: '🦀', java: '☕',
            html: '🌐', css: '🎨', scss: '🎨', less: '🎨',
            json: '📋', yaml: '📋', yml: '📋', toml: '📋',
            md: '📝', txt: '📝', rst: '📝',
            png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', ico: '🖼',
            sh: '⚙', bash: '⚙', zsh: '⚙', fish: '⚙',
            dockerfile: '🐳', env: '🔧',
        };
        return icons[ext] || '📄';
    }

    function openFileViewerFromExplorer(filePath, fileName) {
        // Open in editor tabs if available, fall back to modal
        if (editorContentEl) {
            openFileInEditor(filePath, fileName);
        } else {
            if (!fileViewerModal) return;
            if (fileViewerTitle) fileViewerTitle.textContent = fileName || filePath;
            if (fileViewerContent) fileViewerContent.textContent = 'Loading…';
            fileViewerCurrentPath = filePath;
            fileViewerModal.classList.add('visible');
            vscode.postMessage({ type: 'readFile', path: filePath });
        }
    }

    // ── File Viewer Modal ─────────────────────────────────────────────────────

    function showFileViewer(filePath, fileName, content, error) {
        if (!fileViewerModal) return;
        // Only update if this is for the currently-open viewer
        if (filePath && fileViewerCurrentPath && filePath !== fileViewerCurrentPath) return;
        if (fileViewerTitle) fileViewerTitle.textContent = fileName || filePath || 'File Viewer';
        if (fileViewerContent) {
            if (error) {
                fileViewerContent.textContent = 'Error: ' + error;
                fileViewerContent.style.color = 'var(--error-text)';
            } else {
                fileViewerContent.textContent = content || '';
                fileViewerContent.style.color = '';
            }
        }
        fileViewerModal.classList.add('visible');
    }

    if (fileViewerCloseBtn) {
        fileViewerCloseBtn.addEventListener('click', () => {
            if (fileViewerModal) fileViewerModal.classList.remove('visible');
            fileViewerCurrentPath = null;
        });
    }

    if (fileViewerAddCtxBtn) {
        fileViewerAddCtxBtn.addEventListener('click', () => {
            if (fileViewerCurrentPath) {
                vscode.postMessage({ type: 'addContextFile', path: fileViewerCurrentPath });
                if (fileViewerModal) fileViewerModal.classList.remove('visible');
                fileViewerCurrentPath = null;
            }
        });
    }

    // Close viewer on backdrop click
    if (fileViewerModal) {
        fileViewerModal.addEventListener('click', (e) => {
            if (e.target === fileViewerModal) {
                fileViewerModal.classList.remove('visible');
                fileViewerCurrentPath = null;
            }
        });
    }


    // ═══════════════════════════════════════════════════════════════════════════
    // PERMISSION MODAL — default-mode interactive allow/deny
    // ═══════════════════════════════════════════════════════════════════════════

    let pendingPermReqId = null;

    function showPermissionModal(msg) {
        if (!permModalEl) return;
        pendingPermReqId = msg.reqId;
        const toolLabel = msg.tool || 'unknown tool';
        if (permModalDesc) {
            permModalDesc.textContent = `The agent wants to run: ${toolLabel}`;
        }
        if (permModalDetail) {
            const detail = msg.file ? `File: ${msg.file}` : (msg.command ? `Command: ${msg.command}` : '');
            permModalDetail.textContent = detail;
            permModalDetail.style.display = detail ? '' : 'none';
        }
        permModalEl.style.display = '';
    }

    function closePermissionModal() {
        if (permModalEl) permModalEl.style.display = 'none';
        pendingPermReqId = null;
    }

    if (permAllowBtn) {
        permAllowBtn.addEventListener('click', () => {
            if (pendingPermReqId) {
                vscode.postMessage({ type: 'permissionResponse', reqId: pendingPermReqId, allowed: true });
            }
            closePermissionModal();
        });
    }
    if (permDenyBtn) {
        permDenyBtn.addEventListener('click', () => {
            if (pendingPermReqId) {
                vscode.postMessage({ type: 'permissionResponse', reqId: pendingPermReqId, allowed: false });
            }
            closePermissionModal();
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PLAN BOARD — Cursor-style task tracker
    // ═══════════════════════════════════════════════════════════════════════════

    let planBoardCollapsed = false;

    function updatePlanBoardVisibility() {
        if (!planBoardEl) return;
        const hasPlan = planItems.length > 0;
        const isPlanMode = currentMode === 'plan';
        // Show if there are plan items, OR if we're in plan mode
        if (hasPlan || isPlanMode) {
            planBoardEl.style.display = '';
            planBoardVisible = true;
        } else {
            planBoardEl.style.display = 'none';
            planBoardVisible = false;
        }
    }

    function renderPlanBoard() {
        if (!planItemsListEl) return;
        planItemsListEl.innerHTML = '';
        for (const item of planItems) {
            // Insert-before drop zone shown above each item
            const insertZone = document.createElement('div');
            insertZone.className = 'plan-insert-zone';
            const insertBtn = document.createElement('button');
            insertBtn.className = 'plan-insert-btn';
            insertBtn.title = 'Insert task before this one';
            insertBtn.textContent = '+ Insert here';
            insertBtn.addEventListener('click', () => {
                planInsertBeforeId = item.id;
                const labelText = item.text.length > PLAN_LABEL_MAX_CHARS
                    ? `${item.text.slice(0, PLAN_LABEL_MAX_CHARS)}…`
                    : item.text;
                if (planAddPositionLabelEl) planAddPositionLabelEl.textContent = `Insert before: "${labelText}"`;
                if (planAddRowEl) planAddRowEl.style.display = '';
                if (planAddInputEl) { planAddInputEl.value = ''; planAddInputEl.focus(); }
            });
            insertZone.appendChild(insertBtn);
            planItemsListEl.appendChild(insertZone);

            const row = document.createElement('div');
            row.className = 'plan-item'
                + (item.done ? ' plan-item-done' : '')
                + (item.inProgress ? ' plan-item-active' : '');
            row.dataset.id = item.id;

            const checkBtn = document.createElement('button');
            checkBtn.className = 'plan-check-btn';
            checkBtn.title = item.done ? 'Mark incomplete' : 'Mark complete';
            checkBtn.innerHTML = item.done ? '✓' : (item.inProgress ? '<span class="plan-spinner">⟳</span>' : '○');
            checkBtn.addEventListener('click', () => togglePlanItem(item.id));

            const textEl = document.createElement('span');
            textEl.className = 'plan-item-text';
            textEl.textContent = item.text;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'plan-remove-btn';
            removeBtn.title = 'Remove task';
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', () => removePlanItem(item.id));

            row.appendChild(checkBtn);
            row.appendChild(textEl);
            row.appendChild(removeBtn);
            planItemsListEl.appendChild(row);
        }
    }

    function togglePlanItem(id) {
        const item = planItems.find(p => p.id === id);
        if (!item) return;
        item.done = !item.done;
        if (item.done) item.inProgress = false;
        renderPlanBoard();
    }

    function removePlanItem(id) {
        planItems = planItems.filter(p => p.id !== id);
        renderPlanBoard();
        updatePlanBoardVisibility();
    }

    function addPlanItem(text, insertBeforeId) {
        if (!text || !text.trim()) return;
        const newItem = { id: ++planItemCounter, text: text.trim(), done: false, inProgress: false };
        if (insertBeforeId != null) {
            const idx = planItems.findIndex(p => p.id === insertBeforeId);
            if (idx !== -1) {
                planItems.splice(idx, 0, newItem);
            } else {
                planItems.push(newItem);
            }
        } else {
            planItems.push(newItem);
        }
        renderPlanBoard();
        updatePlanBoardVisibility();
    }

    /** Parse markdown list items from agent plan-mode responses */
    function extractPlanItems(text) {
        if (!text) return [];
        const lines = text.split('\n');
        const items = [];
        for (const line of lines) {
            // Match numbered lists (1. text) or bullet lists (- text / * text)
            const m = line.match(PLAN_ITEM_PATTERN);
            if (m) {
                const itemText = m[1].replace(/^\[[ x]\]\s*/, '').trim(); // strip checkbox syntax
                if (itemText) items.push(itemText);
            }
        }
        return items;
    }

    /** Mark the first in-progress item as done; mark next as in-progress */
    function advancePlanProgress() {
        const inProg = planItems.find(p => p.inProgress && !p.done);
        if (inProg) { inProg.done = true; inProg.inProgress = false; }
        const next = planItems.find(p => !p.done && !p.inProgress);
        if (next) next.inProgress = true;
        renderPlanBoard();
    }

    /** Start first uncompleted item as in-progress when agent begins tool use */
    function startPlanProgress() {
        if (!planItems.some(p => p.inProgress)) {
            const first = planItems.find(p => !p.done);
            if (first) { first.inProgress = true; renderPlanBoard(); }
        }
    }

    /** Build plan context string to inject into prompts */
    function buildPlanContext() {
        if (planItems.length === 0) return '';
        const lines = planItems.map(p =>
            `- [${p.done ? 'x' : ' '}] ${p.text}${p.inProgress && !p.done ? ' ← (in progress)' : ''}`
        );
        return '\n\n[Active Plan]\n' + lines.join('\n');
    }

    // Wire plan board controls
    if (planCollapseBtn) {
        planCollapseBtn.addEventListener('click', () => {
            planBoardCollapsed = !planBoardCollapsed;
            if (planItemsListEl) planItemsListEl.style.display = planBoardCollapsed ? 'none' : '';
            if (planAddRowEl)    planAddRowEl.style.display   = 'none';
            planCollapseBtn.textContent = planBoardCollapsed ? '▸' : '▾';
        });
    }
    if (planCloseBoardBtn) {
        planCloseBoardBtn.addEventListener('click', () => {
            planItems = [];
            planBoardEl && (planBoardEl.style.display = 'none');
            planBoardVisible = false;
        });
    }
    if (planClearDoneBtn) {
        planClearDoneBtn.addEventListener('click', () => {
            planItems = planItems.filter(p => !p.done);
            renderPlanBoard();
            updatePlanBoardVisibility();
        });
    }
    if (planAddBtn) {
        planAddBtn.addEventListener('click', () => {
            if (!planAddRowEl) return;
            planInsertBeforeId = null;
            if (planAddPositionLabelEl) planAddPositionLabelEl.textContent = 'Add to end';
            planAddRowEl.style.display = '';
            if (planAddInputEl) { planAddInputEl.value = ''; planAddInputEl.focus(); }
        });
    }
    if (planAddConfirmBtn) {
        planAddConfirmBtn.addEventListener('click', () => {
            if (planAddInputEl) {
                addPlanItem(planAddInputEl.value, planInsertBeforeId);
                planAddInputEl.value = '';
            }
            planInsertBeforeId = null;
            if (planAddPositionLabelEl) planAddPositionLabelEl.textContent = '';
            if (planAddRowEl) planAddRowEl.style.display = 'none';
        });
    }
    if (planAddCancelBtn) {
        planAddCancelBtn.addEventListener('click', () => {
            if (planAddRowEl) planAddRowEl.style.display = 'none';
        });
    }
    if (planAddInputEl) {
        planAddInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { planAddConfirmBtn && planAddConfirmBtn.click(); }
            if (e.key === 'Escape') { planAddCancelBtn && planAddCancelBtn.click(); }
        });
    }



    function initResizeHandles() {
        const resizeLeft  = document.getElementById('resize-left');
        const resizeRight = document.getElementById('resize-right');

        // Left handle: resize chat panel
        if (resizeLeft && panelChatEl) {
            resizeLeft.addEventListener('mousedown', (e) => {
                e.preventDefault();
                resizeLeft.classList.add('dragging');
                const startX = e.clientX;
                const startW = panelChatEl.getBoundingClientRect().width;
                const onMove = (e2) => {
                    const min = parseInt(getComputedStyle(panelChatEl).minWidth) || 220;
                    const max = parseInt(getComputedStyle(panelChatEl).maxWidth) || 600;
                    panelChatEl.style.width = Math.max(min, Math.min(max, startW + (e2.clientX - startX))) + 'px';
                };
                const onUp = () => {
                    resizeLeft.classList.remove('dragging');
                    localStorage.setItem('freecode_chat_width', panelChatEl.style.width);
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        // Right handle: resize explorer panel (inverted — dragging left widens explorer)
        if (resizeRight && panelExplorerEl) {
            resizeRight.addEventListener('mousedown', (e) => {
                e.preventDefault();
                resizeRight.classList.add('dragging');
                const startX = e.clientX;
                const startW = panelExplorerEl.getBoundingClientRect().width;
                const onMove = (e2) => {
                    panelExplorerEl.style.width = Math.max(160, Math.min(420, startW + (startX - e2.clientX))) + 'px';
                };
                const onUp = () => {
                    resizeRight.classList.remove('dragging');
                    localStorage.setItem('freecode_explorer_width', panelExplorerEl.style.width);
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        // Restore saved panel widths
        const savedChat     = localStorage.getItem('freecode_chat_width');
        const savedExplorer = localStorage.getItem('freecode_explorer_width');
        if (savedChat     && panelChatEl)     panelChatEl.style.width     = savedChat;
        if (savedExplorer && panelExplorerEl) panelExplorerEl.style.width = savedExplorer;
    }

    initResizeHandles();

    // ═══════════════════════════════════════════════════════════════════════════
    // 3-COLUMN IDE — EDITOR TABS
    // ═══════════════════════════════════════════════════════════════════════════

    /** Open a file in the editor (sends readFile IPC with purpose open_editor). */
    function openFileInEditor(filePath, fileName) {
        const existing = openTabs.find(t => t.path === filePath);
        if (existing) { activateTab(filePath); return; }
        pendingEditorRead = filePath;
        vscode.postMessage({ type: 'readFile', path: filePath, purpose: 'open_editor' });
    }

    /** Add a new tab or re-activate an existing one with updated content. */
    function addOrActivateTab(fileData) {
        const existing = openTabs.find(t => t.path === fileData.path);
        if (existing) {
            existing.content = fileData.content;
            existing.error   = fileData.error;
            existing.isDiff  = false;
            activateTab(fileData.path);
            return;
        }
        openTabs.push({
            path:    fileData.path,
            name:    fileData.name || pathBasename(fileData.path),
            content: fileData.content,
            error:   fileData.error,
            isDiff:  false,
        });
        renderTabBar();
        activateTab(fileData.path);
    }

    /** Open or replace a diff tab for an agent-edited file. */
    function openDiffTab(filePath, before, after) {
        const name     = pathBasename(filePath);
        const existing = openTabs.find(t => t.path === filePath);
        if (existing) {
            existing.isDiff         = true;
            existing.beforeContent  = before;
            existing.afterContent   = after;
            existing.content        = after;
        } else {
            openTabs.push({ path: filePath, name, content: after, isDiff: true, beforeContent: before, afterContent: after });
        }
        renderTabBar();
        activateTab(filePath);
    }

    /** Make a tab active and render its content. */
    function activateTab(filePath) {
        activeTabPath = filePath;
        renderTabBar();
        const tab = openTabs.find(t => t.path === filePath);
        if (tab) renderEditorContent(tab);
    }

    /** Close a tab (and show empty state if no tabs remain). */
    function closeTab(filePath) {
        const idx = openTabs.findIndex(t => t.path === filePath);
        if (idx === -1) return;
        openTabs.splice(idx, 1);
        if (activeTabPath === filePath) {
            const next = openTabs[idx] || openTabs[idx - 1];
            activeTabPath = next ? next.path : null;
        }
        renderTabBar();
        if (activeTabPath) {
            const tab = openTabs.find(t => t.path === activeTabPath);
            if (tab) renderEditorContent(tab);
        } else {
            showEditorEmptyState();
        }
    }

    /** Close the currently active tab (Ctrl+W). */
    function closeActiveTab() {
        if (activeTabPath) closeTab(activeTabPath);
    }

    function showEditorEmptyState() {
        if (!editorContentEl) return;
        editorContentEl.innerHTML = '';
        const empty = document.createElement('div');
        empty.id = 'editor-empty-state';
        empty.innerHTML =
            '<div class="editor-empty-icon">📝</div>' +
            '<div class="editor-empty-title">No file open</div>' +
            '<div class="editor-empty-hint">Click a file in the Explorer to open it here</div>';
        editorContentEl.appendChild(empty);
        if (diffToolbar) diffToolbar.style.display = 'none';
    }

    /** Rebuild the tab bar DOM from openTabs. */
    function renderTabBar() {
        if (!editorTabsEl) return;
        editorTabsEl.innerHTML = '';
        for (const tab of openTabs) {
            const tabEl   = document.createElement('div');
            tabEl.className = 'editor-tab'
                + (tab.path === activeTabPath ? ' active' : '')
                + (tab.isDiff ? ' diff-tab' : '')
                + (tab.isModified ? ' modified' : '');
            tabEl.title = tab.path;

            const iconEl = document.createElement('span');
            iconEl.className   = 'editor-tab-icon';
            iconEl.textContent = tab.isDiff
                ? '⚡'
                : getFileIcon((tab.name.split('.').pop() || '').toLowerCase());

            const nameEl = document.createElement('span');
            nameEl.className   = 'editor-tab-name';
            nameEl.textContent = tab.name + (tab.isDiff ? ' ⚡' : '');

            const dotEl = document.createElement('span');
            dotEl.className = 'editor-tab-dot';

            const closeEl = document.createElement('button');
            closeEl.className   = 'editor-tab-close';
            closeEl.textContent = '×';
            closeEl.title = 'Close tab';
            closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path); });

            tabEl.appendChild(iconEl);
            tabEl.appendChild(nameEl);
            tabEl.appendChild(dotEl);
            tabEl.appendChild(closeEl);
            tabEl.addEventListener('click', () => activateTab(tab.path));
            editorTabsEl.appendChild(tabEl);
        }
    }

    /** Render either file content or a diff view into the editor panel. */
    function renderEditorContent(tab) {
        if (!editorContentEl) return;
        editorContentEl.innerHTML = '';
        if (tab.isDiff && tab.beforeContent !== undefined && tab.afterContent !== undefined) {
            editorContentEl.appendChild(buildEditorDiffView(tab.beforeContent, tab.afterContent));
            if (diffToolbar) {
                diffToolbar.style.display = '';
                if (diffToolbarFilename) diffToolbarFilename.textContent = tab.name;
            }
        } else {
            if (diffToolbar) diffToolbar.style.display = 'none';
            if (tab.error) {
                const errEl = document.createElement('div');
                errEl.style.cssText = 'padding:16px;color:var(--error-text);font-family:var(--font-code);font-size:12px;';
                errEl.textContent = 'Error: ' + tab.error;
                editorContentEl.appendChild(errEl);
            } else {
                const textarea = document.createElement('textarea');
                textarea.id = 'editor-file-view';
                textarea.value = tab.content || '';
                textarea.spellcheck = false;
                textarea.autocomplete = 'off';
                textarea.setAttribute('autocorrect', 'off');
                textarea.setAttribute('autocapitalize', 'off');

                // Debounced auto-save timer
                let saveTimer = null;
                function scheduleAutoSave() {
                    if (saveTimer) clearTimeout(saveTimer);
                    saveTimer = setTimeout(() => {
                        vscode.postMessage({ type: 'writeFile', path: tab.path, content: textarea.value, purpose: 'editor_autosave' });
                        tab.content = textarea.value;
                        markTabSaved(tab.path);
                    }, 1000);
                }

                textarea.addEventListener('input', () => {
                    markTabModified(tab.path);
                    scheduleAutoSave();
                });

                // Ctrl+S / Cmd+S: immediate save
                textarea.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                        e.preventDefault();
                        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
                        const content = textarea.value;
                        vscode.postMessage({ type: 'writeFile', path: tab.path, content, purpose: 'editor_save' });
                        tab.content = content;
                        markTabSaved(tab.path);
                    }
                    // Tab key inserts spaces instead of focusing next element
                    if (e.key === 'Tab') {
                        e.preventDefault();
                        const start = textarea.selectionStart;
                        const end   = textarea.selectionEnd;
                        textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
                        textarea.selectionStart = textarea.selectionEnd = start + 4;
                        tab.content = textarea.value;
                        markTabModified(tab.path);
                        scheduleAutoSave();
                    }
                });

                editorContentEl.appendChild(textarea);
            }
        }
    }

    /** Mark a tab as having unsaved edits (shows the dot indicator). */
    function markTabModified(filePath) {
        const tab = openTabs.find(t => t.path === filePath);
        if (tab && !tab.isModified) {
            tab.isModified = true;
            renderTabBar();
        }
    }

    /** Clear the modified indicator after a successful save. */
    function markTabSaved(filePath) {
        const tab = openTabs.find(t => t.path === filePath);
        if (tab && tab.isModified) {
            tab.isModified = false;
            renderTabBar();
        }
    }

    /** Build a diff DOM view for the editor panel using computeDiff(). */
    function buildEditorDiffView(before, after) {
        const container   = document.createElement('div');
        container.id      = 'editor-diff-view';
        const diff        = computeDiff((before || '').split('\n'), (after || '').split('\n'));
        let beforeNum = 1, afterNum = 1;
        for (const { type, line } of diff) {
            const rowEl  = document.createElement('div');
            let oldNumText = '', newNumText = '';
            if (type === 'equal')  {
                rowEl.className = 'diff-context';
                oldNumText = String(beforeNum++);
                newNumText = String(afterNum++);
            } else if (type === 'remove') {
                rowEl.className = 'diff-removed';
                oldNumText = String(beforeNum++);
            } else {
                rowEl.className = 'diff-added';
                newNumText = String(afterNum++);
            }
            // Old line number column
            const oldNumEl = document.createElement('span');
            oldNumEl.className   = 'diff-line-num diff-line-num-old';
            oldNumEl.textContent = oldNumText;
            // New line number column
            const newNumEl = document.createElement('span');
            newNumEl.className   = 'diff-line-num diff-line-num-new';
            newNumEl.textContent = newNumText;
            const textEl = document.createElement('span');
            textEl.className   = 'diff-line-text';
            textEl.textContent = line;
            rowEl.appendChild(oldNumEl);
            rowEl.appendChild(newNumEl);
            rowEl.appendChild(textEl);
            container.appendChild(rowEl);
        }
        return container;
    }

    // ── DOM ref for Accept All button ────────────────────────────────────────
    const diffAcceptAllBtn = document.getElementById('diff-accept-all-btn');

    // Diff accept / reject
    if (diffAcceptBtn) {
        diffAcceptBtn.addEventListener('click', () => {
            if (!activeTabPath) return;
            const tab = openTabs.find(t => t.path === activeTabPath);
            if (!tab || !tab.isDiff) return;
            // Write afterContent to disk to confirm the accepted state
            const afterContent = tab.afterContent !== undefined ? tab.afterContent : (tab.content || '');
            vscode.postMessage({ type: 'writeFile', path: tab.path, content: afterContent, purpose: 'diff_accept' });
            tab.isDiff = false; tab.beforeContent = undefined; tab.afterContent = undefined;
            renderTabBar();
            renderEditorContent(tab);
        });
    }

    if (diffRejectBtn) {
        diffRejectBtn.addEventListener('click', () => {
            if (!activeTabPath) return;
            const tab = openTabs.find(t => t.path === activeTabPath);
            if (!tab || !tab.isDiff) return;
            const before = tab.beforeContent || '';
            const fp = tab.path;
            vscode.postMessage({ type: 'writeFile', path: fp, content: before, purpose: 'diff_reject' });
            closeTab(fp);
        });
    }

    // Accept All Changes: accept every open diff tab in one click
    if (diffAcceptAllBtn) {
        diffAcceptAllBtn.addEventListener('click', () => {
            const diffTabs = openTabs.filter(t => t.isDiff);
            for (const tab of diffTabs) {
                const afterContent = tab.afterContent !== undefined ? tab.afterContent : (tab.content || '');
                vscode.postMessage({ type: 'writeFile', path: tab.path, content: afterContent, purpose: 'diff_accept' });
                tab.isDiff = false;
                tab.beforeContent = undefined;
                tab.afterContent  = undefined;
            }
            renderTabBar();
            if (activeTabPath) {
                const activeTab = openTabs.find(t => t.path === activeTabPath);
                if (activeTab) renderEditorContent(activeTab);
            }
            if (diffToolbar) diffToolbar.style.display = 'none';
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3-COLUMN IDE — CONTEXT MENU
    // ═══════════════════════════════════════════════════════════════════════════

    function showCtxMenu(x, y, target) {
        ctxMenuTarget = target;
        if (!ctxMenu) return;
        const openItem   = document.getElementById('ctx-open');
        const addCtxItem = document.getElementById('ctx-add-context');
        if (openItem)   openItem.style.display   = target.type === 'file' ? '' : 'none';
        if (addCtxItem) addCtxItem.style.display = target.type === 'file' ? '' : 'none';
        ctxMenu.style.display = '';
        ctxMenu.style.left    = x + 'px';
        ctxMenu.style.top     = y + 'px';
        requestAnimationFrame(() => {
            const r = ctxMenu.getBoundingClientRect();
            if (r.right  > window.innerWidth)  ctxMenu.style.left = (x - r.width)  + 'px';
            if (r.bottom > window.innerHeight) ctxMenu.style.top  = (y - r.height) + 'px';
        });
    }

    function hideCtxMenu() {
        if (ctxMenu) ctxMenu.style.display = 'none';
        ctxMenuTarget = null;
    }

    document.addEventListener('click',      (e) => { if (!ctxMenu?.contains(e.target)) hideCtxMenu(); });
    document.addEventListener('contextmenu',(e) => { if (!e.target.closest?.('#explorer-tree')) hideCtxMenu(); });

    if (ctxMenu) {
        document.getElementById('ctx-open')?.addEventListener('click', () => {
            if (ctxMenuTarget?.type === 'file') openFileInEditor(ctxMenuTarget.path, ctxMenuTarget.name);
            hideCtxMenu();
        });
        document.getElementById('ctx-new-file')?.addEventListener('click', () => {
            const dir  = ctxMenuTarget ? (ctxMenuTarget.type === 'dir' ? ctxMenuTarget.path : pathDirname(ctxMenuTarget.path)) : currentWorkspacePath;
            const name = window.prompt('New file name:');
            if (name && name.trim()) vscode.postMessage({ type: 'createFile', path: pathJoin(dir, name.trim()) });
            hideCtxMenu();
        });
        document.getElementById('ctx-new-folder')?.addEventListener('click', () => {
            const dir  = ctxMenuTarget ? (ctxMenuTarget.type === 'dir' ? ctxMenuTarget.path : pathDirname(ctxMenuTarget.path)) : currentWorkspacePath;
            const name = window.prompt('New folder name:');
            if (name && name.trim()) vscode.postMessage({ type: 'createDir', path: pathJoin(dir, name.trim()) });
            hideCtxMenu();
        });
        document.getElementById('ctx-rename')?.addEventListener('click', () => {
            if (!ctxMenuTarget) { hideCtxMenu(); return; }
            const newName = window.prompt('Rename to:', ctxMenuTarget.name);
            if (newName && newName.trim() && newName.trim() !== ctxMenuTarget.name) {
                vscode.postMessage({ type: 'renameFile', oldPath: ctxMenuTarget.path, newPath: pathJoin(pathDirname(ctxMenuTarget.path), newName.trim()) });
            }
            hideCtxMenu();
        });
        document.getElementById('ctx-delete')?.addEventListener('click', () => {
            if (!ctxMenuTarget) { hideCtxMenu(); return; }
            if (window.confirm('Delete "' + ctxMenuTarget.name + '"?')) {
                vscode.postMessage({ type: 'deleteFile', path: ctxMenuTarget.path });
            }
            hideCtxMenu();
        });
        document.getElementById('ctx-copy-path')?.addEventListener('click', () => {
            if (ctxMenuTarget) vscode.postMessage({ type: 'copyToClipboard', text: ctxMenuTarget.path });
            hideCtxMenu();
        });
        document.getElementById('ctx-add-context')?.addEventListener('click', () => {
            if (ctxMenuTarget?.type === 'file') vscode.postMessage({ type: 'addContextFile', path: ctxMenuTarget.path });
            hideCtxMenu();
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3-COLUMN IDE — EXPLORER TOOLBAR BUTTONS
    // ═══════════════════════════════════════════════════════════════════════════

    if (explorerNewFileBtn) {
        explorerNewFileBtn.addEventListener('click', () => {
            const name = window.prompt('New file name:');
            if (name && name.trim()) vscode.postMessage({ type: 'createFile', path: pathJoin(currentWorkspacePath, name.trim()) });
        });
    }

    if (explorerNewFolderBtn) {
        explorerNewFolderBtn.addEventListener('click', () => {
            const name = window.prompt('New folder name:');
            if (name && name.trim()) vscode.postMessage({ type: 'createDir', path: pathJoin(currentWorkspacePath, name.trim()) });
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3-COLUMN IDE — EXPLORER INIT + PATH HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function initExplorer() {
        if (explorerWorkspaceLabel) explorerWorkspaceLabel.textContent = currentWorkspacePath || '(home)';
        if (currentWorkspacePath) loadExplorerTree(currentWorkspacePath);
    }

    function pathBasename(p) {
        return (p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    }

    function pathDirname(p) {
        const norm  = (p || '').replace(/\\/g, '/');
        const parts = norm.split('/').filter(Boolean);
        if (parts.length <= 1) return norm.startsWith('/') ? '/' : '.';
        parts.pop();
        return (norm.startsWith('/') ? '/' : '') + parts.join('/');
    }

    function pathJoin(...parts) {
        return parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3-COLUMN IDE — PANEL COLLAPSE + KEYBOARD SHORTCUTS
    // ═══════════════════════════════════════════════════════════════════════════

    function togglePanel(panelEl) {
        if (!panelEl) return;
        panelEl.classList.toggle('panel-collapsed');
    }

    document.addEventListener('keydown', (kbEvt) => {
        // Ctrl+B — toggle left (chat) panel
        if ((kbEvt.ctrlKey || kbEvt.metaKey) && !kbEvt.shiftKey && kbEvt.key === 'b') {
            kbEvt.preventDefault();
            togglePanel(panelChatEl);
        }
        // Ctrl+Shift+E — focus / toggle explorer panel
        if ((kbEvt.ctrlKey || kbEvt.metaKey) && kbEvt.shiftKey && kbEvt.key === 'E') {
            kbEvt.preventDefault();
            if (panelExplorerEl && panelExplorerEl.classList.contains('panel-collapsed')) {
                panelExplorerEl.classList.remove('panel-collapsed');
            } else {
                togglePanel(panelExplorerEl);
            }
        }
        // Ctrl+W — close active editor tab
        if ((kbEvt.ctrlKey || kbEvt.metaKey) && !kbEvt.shiftKey && kbEvt.key === 'w' && activeTabPath) {
            kbEvt.preventDefault();
            closeActiveTab();
        }
    });

    // ── Signal ready ──────────────────────────────────────────────────────────
    vscode.postMessage({ type: 'ready' });

}());


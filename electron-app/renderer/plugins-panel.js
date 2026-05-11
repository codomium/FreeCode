/**
 * plugins-panel.js — Plugin Manager UI for FreeCode Electron App
 *
 * Lists available plugins from the registry, shows installed status,
 * and allows install/remove via IPC to the main process.
 */

(function () {
    'use strict';

    // ── IPC bridge ────────────────────────────────────────────────────────────

    function postMessage(msg) {
        if (typeof window !== 'undefined' && window.electronBridge) {
            window.electronBridge.postMessage(msg);
        }
    }

    // ── State ─────────────────────────────────────────────────────────────────

    let _plugins = [];   // available plugins from registry
    let _installed = {}; // id → true for installed plugins

    // ── DOM helpers ───────────────────────────────────────────────────────────

    function getPanel() {
        return document.getElementById('plugins-panel');
    }

    function getList() {
        return document.getElementById('plugins-list');
    }

    function getStatus() {
        return document.getElementById('plugins-status');
    }

    function setStatus(text) {
        const el = getStatus();
        if (el) el.textContent = text;
    }

    // ── Render ────────────────────────────────────────────────────────────────

    function renderPlugins() {
        const list = getList();
        if (!list) return;
        list.innerHTML = '';

        if (_plugins.length === 0) {
            list.innerHTML = '<li class="plugins-empty">No plugins found in registry.</li>';
            return;
        }

        for (const plugin of _plugins) {
            const installed = !!_installed[plugin.id];
            const li = document.createElement('li');
            li.className = 'plugin-item' + (installed ? ' plugin-installed' : '');
            li.dataset.id = plugin.id;

            const info = document.createElement('div');
            info.className = 'plugin-info';
            info.innerHTML = `
                <span class="plugin-name">${escHtml(plugin.name || plugin.id)}</span>
                <span class="plugin-version">v${escHtml(plugin.version || '?')}</span>
                <span class="plugin-desc">${escHtml(plugin.description || '')}</span>
            `;

            const btn = document.createElement('button');
            btn.className = 'plugin-action-btn';
            if (installed) {
                btn.textContent = 'Remove';
                btn.title = 'Remove this plugin';
                btn.addEventListener('click', () => removePlugin(plugin.id));
            } else {
                btn.textContent = 'Install';
                btn.title = 'Install this plugin';
                btn.addEventListener('click', () => installPlugin(plugin.id));
            }

            li.appendChild(info);
            li.appendChild(btn);
            list.appendChild(li);
        }
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    function installPlugin(id) {
        setStatus(`Installing ${id}…`);
        postMessage({ type: 'pluginInstall', id });
    }

    function removePlugin(id) {
        setStatus(`Removing ${id}…`);
        postMessage({ type: 'pluginRemove', id });
    }

    function refreshPlugins() {
        setStatus('Fetching plugin registry…');
        postMessage({ type: 'pluginListRequest' });
    }

    // ── IPC response handler (called by chat.js message routing) ─────────────

    window._handlePluginsPanelMessage = function (msg) {
        if (msg.type === 'pluginList') {
            _plugins = Array.isArray(msg.plugins) ? msg.plugins : [];
            _installed = {};
            if (Array.isArray(msg.installed)) {
                for (const id of msg.installed) _installed[id] = true;
            }
            renderPlugins();
            setStatus('');
        } else if (msg.type === 'pluginInstallResult') {
            if (msg.success) {
                _installed[msg.id] = true;
                setStatus(`${msg.id} installed.`);
            } else {
                setStatus(`Failed to install ${msg.id}: ${msg.error || 'unknown error'}`);
            }
            renderPlugins();
        } else if (msg.type === 'pluginRemoveResult') {
            if (msg.success) {
                delete _installed[msg.id];
                setStatus(`${msg.id} removed.`);
            } else {
                setStatus(`Failed to remove ${msg.id}: ${msg.error || 'unknown error'}`);
            }
            renderPlugins();
        }
    };

    // ── Panel init ────────────────────────────────────────────────────────────

    function initPanel() {
        const panel = getPanel();
        if (!panel) return;

        // Build static structure
        panel.innerHTML = `
            <div id="plugins-panel-header">
                <span id="plugins-panel-title">🧩 Plugins</span>
                <button id="plugins-close-btn" title="Close">✕</button>
            </div>
            <div id="plugins-toolbar">
                <button id="plugins-refresh-btn">↻ Refresh</button>
                <span id="plugins-status"></span>
            </div>
            <ul id="plugins-list"></ul>
        `;

        document.getElementById('plugins-close-btn').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        document.getElementById('plugins-refresh-btn').addEventListener('click', refreshPlugins);

        // Load plugins on first open
        refreshPlugins();
    }

    // Open the panel and wire the trigger button
    function openPanel() {
        const panel = getPanel();
        if (!panel) return;
        if (panel.style.display === 'none' || !panel.style.display) {
            if (!panel.dataset.initialized) {
                initPanel();
                panel.dataset.initialized = 'true';
            }
            panel.style.display = 'flex';
            refreshPlugins();
        } else {
            panel.style.display = 'none';
        }
    }

    // Wire up the trigger button once the DOM is ready
    function wireButton() {
        const btn = document.getElementById('plugins-btn');
        if (btn) {
            btn.addEventListener('click', openPanel);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireButton);
    } else {
        wireButton();
    }
})();

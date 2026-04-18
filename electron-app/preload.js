'use strict';
/**
 * preload.js — Electron preload script
 *
 * Exposes a safe IPC bridge to the renderer process that is API-compatible
 * with the VSCode webview `acquireVsCodeApi()` pattern:
 *
 *   window.electronBridge.postMessage(obj)  — send a message to main process
 *   window.electronBridge.onMessage(fn)     — register a listener for messages
 *                                             from the main process
 *
 * The renderer's `chat.js` uses this to replace `acquireVsCodeApi()` so the
 * same chat UI code works in both VSCode and the standalone Electron app.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
    /**
     * Send a message object to the main process.
     * Equivalent to `vscode.postMessage(msg)` in a VSCode webview.
     * @param {object} msg
     */
    postMessage(msg) {
        ipcRenderer.send('renderer-message', msg);
    },

    /**
     * Register a callback to receive messages from the main process.
     * The callback will be invoked with the message data object.
     * Equivalent to `window.addEventListener('message', ...)` in a VSCode webview.
     * @param {function} callback
     */
    onMessage(callback) {
        ipcRenderer.on('main-message', (_event, data) => {
            callback(data);
        });
    },
});

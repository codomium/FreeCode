'use strict';
/**
 * webviewPanel.js — WebviewPanelManager
 *
 * Manages the lifecycle of the FreeCode sidebar chat panel.
 * Extracted from extension.js to improve modularity.
 *
 * Usage:
 *   const { WebviewPanelManager } = require('./webviewPanel');
 *   const mgr = new WebviewPanelManager(context);
 *   mgr.reveal();
 *   mgr.postMessage({ type: 'info', message: 'hello' });
 */

const vscode = require('vscode');

class WebviewPanelManager {
    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {string} [viewType='claudeCode.chatView']
     */
    constructor(context, viewType = 'claudeCode.chatView') {
        this._context  = context;
        this._viewType = viewType;
        /** @type {import('vscode').WebviewView|null} */
        this._view = null;
    }

    /**
     * Reveal (focus) the sidebar panel.
     */
    reveal() {
        vscode.commands.executeCommand(`${this._viewType}.focus`);
    }

    /**
     * Send a message to the webview.
     * @param {object} msg
     */
    postMessage(msg) {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage(msg);
        }
    }

    /**
     * Store a reference to the resolved WebviewView.
     * Called by the WebviewViewProvider once the view is ready.
     * @param {import('vscode').WebviewView} view
     */
    setView(view) {
        this._view = view;
        view.onDidDispose(() => { this._view = null; });
    }

    /**
     * Dispose the panel (no-op if not open).
     */
    dispose() {
        this._view = null;
    }
}

module.exports = { WebviewPanelManager };

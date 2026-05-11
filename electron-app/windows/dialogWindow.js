'use strict';
/**
 * dialogWindow.js — createApiKeyDialog factory.
 *
 * Extracted from electron-app/main.js for modularity.
 *
 * Usage (in main.js / apiKeyHandlers.js):
 *   const { createApiKeyDialog } = require('./windows/dialogWindow');
 *   const win = createApiKeyDialog({ parent: mainWindow, appDir: __dirname });
 */

const { BrowserWindow } = require('electron');
const path = require('path');

/**
 * Create and return the modal API-key input dialog.
 * @param {object} opts
 * @param {import('electron').BrowserWindow} opts.parent  Parent window for modal attachment
 * @param {string}  opts.appDir  __dirname of main.js
 * @returns {import('electron').BrowserWindow}
 */
function createApiKeyDialog({ parent, appDir }) {
    const win = new BrowserWindow({
        width:       520,
        height:      230,
        parent,
        modal:       true,
        show:        false,
        resizable:   false,
        minimizable: false,
        maximizable: false,
        title:       'Set API Key — freeCode',
        webPreferences: {
            preload:          path.join(appDir, 'dialog-preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
            sandbox:          false,
        },
        backgroundColor: '#1e1e1e',
    });

    win.setMenu(null);
    win.loadFile(path.join(appDir, 'api-key-dialog.html'));
    win.once('ready-to-show', () => win.show());

    return win;
}

module.exports = { createApiKeyDialog };

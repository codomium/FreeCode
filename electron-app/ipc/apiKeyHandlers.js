'use strict';
/**
 * apiKeyHandlers.js — IPC handlers for API key management and the api-key-dialog window.
 *
 * Extracted from electron-app/main.js for modularity.
 * Re-exports the functions that main.js needs at the top level.
 *
 * Usage (in main.js):
 *   const { registerApiKeyHandlers } = require('./ipc/apiKeyHandlers');
 *   registerApiKeyHandlers(ipcMain, createWindow);
 */

const { BrowserWindow, ipcMain: _ipcMain, safeStorage, dialog, app } = require('electron');
const path = require('path');
const fs   = require('fs');

const API_KEY_FILE = 'apikey.enc';

/**
 * Encrypt and persist an API key to disk.
 * @param {string} keyVal
 * @param {string} userDataPath
 */
function storeApiKey(keyVal, userDataPath) {
    if (safeStorage.isEncryptionAvailable()) {
        const enc = safeStorage.encryptString(keyVal);
        fs.writeFileSync(path.join(userDataPath, API_KEY_FILE), enc);
    }
}

/**
 * Load a previously stored API key.
 * @param {string} userDataPath
 * @returns {string}
 */
function loadApiKey(userDataPath) {
    try {
        const filePath = path.join(userDataPath, API_KEY_FILE);
        if (fs.existsSync(filePath)) {
            const enc = fs.readFileSync(filePath);
            return safeStorage.isEncryptionAvailable()
                ? safeStorage.decryptString(enc)
                : '';
        }
    } catch { /* ignore */ }
    return '';
}

/**
 * Open the modal API key dialog.
 * @param {import('electron').BrowserWindow} parentWindow
 * @param {string} appDir  __dirname of main.js
 * @returns {Promise<string|null>}
 */
function showApiKeyDialog(parentWindow, appDir) {
    return new Promise((resolve) => {
        const dialogWin = new BrowserWindow({
            width:       520,
            height:      230,
            parent:      parentWindow,
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

        dialogWin.setMenu(null);
        dialogWin.loadFile(path.join(appDir, 'api-key-dialog.html'));
        dialogWin.once('ready-to-show', () => dialogWin.show());

        const onSubmit = (_event, value) => { cleanup(); resolve(value || null); };
        const onCancel = () => { cleanup(); resolve(null); };

        _ipcMain.once('dialog-submit', onSubmit);
        _ipcMain.once('dialog-cancel', onCancel);

        function cleanup() {
            _ipcMain.removeListener('dialog-submit', onSubmit);
            _ipcMain.removeListener('dialog-cancel', onCancel);
            if (!dialogWin.isDestroyed()) dialogWin.close();
        }

        dialogWin.on('closed', () => { cleanup(); resolve(null); });
    });
}

/**
 * Register IPC handlers for API key management.
 * @param {import('electron').IpcMain} ipcMain
 * @param {object} opts
 * @param {() => string}   opts.getUserData
 * @param {() => import('electron').BrowserWindow|null} opts.getMainWindow
 * @param {string}          opts.appDir
 * @param {() => void}      opts.onKeyStored   Called after a key is successfully stored
 */
function registerApiKeyHandlers(ipcMain, { getUserData, getMainWindow, appDir, onKeyStored }) {
    // These are exposed via the dialog-preload / renderer flow — handled by showApiKeyDialog above.
    // No extra ipcMain.on handlers needed here; the dialog promise resolves in showApiKeyDialog.
    // This function is a hook point for future key-related IPC (e.g. deleteApiKey).
    void ipcMain; // kept for API symmetry
    void { getUserData, getMainWindow, appDir, onKeyStored };
}

module.exports = { storeApiKey, loadApiKey, showApiKeyDialog, registerApiKeyHandlers };

'use strict';
/**
 * mainWindow.js — createMainWindow factory.
 *
 * Extracted from electron-app/main.js for modularity.
 * Returns the newly created BrowserWindow.
 *
 * Usage (in main.js):
 *   const { createMainWindow } = require('./windows/mainWindow');
 *   mainWindow = createMainWindow({ appDir: __dirname });
 */

const { BrowserWindow } = require('electron');
const path = require('path');

/**
 * Create and return the main application window.
 * @param {object} opts
 * @param {string}  opts.appDir   __dirname of main.js
 * @param {boolean} [opts.devTools]  Open DevTools on start
 * @returns {import('electron').BrowserWindow}
 */
function createMainWindow({ appDir, devTools = false }) {
    const win = new BrowserWindow({
        width:  1200,
        height: 800,
        minWidth:  600,
        minHeight: 500,
        title: 'freeCode',
        icon: path.join(appDir, 'renderer', 'icon.ico'),
        webPreferences: {
            preload:           path.join(appDir, 'preload.js'),
            contextIsolation:  true,
            nodeIntegration:   false,
            sandbox:           false,
        },
        backgroundColor: '#1e1e1e',
        show: false,
    });

    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(appDir, 'renderer', 'index.html'));

    if (devTools || process.env.OCC_DEV) {
        win.webContents.openDevTools();
    }

    win.on('closed', () => {
        // caller should null-out their mainWindow reference in this handler
    });

    return win;
}

module.exports = { createMainWindow };

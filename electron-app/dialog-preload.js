'use strict';
/**
 * dialog-preload.js — Preload for the API key input dialog window.
 * Exposes a minimal IPC bridge so the dialog HTML can send the entered
 * value back to the main process.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialogBridge', {
    submit(value) {
        ipcRenderer.send('dialog-submit', value);
    },
    cancel() {
        ipcRenderer.send('dialog-cancel');
    },
});

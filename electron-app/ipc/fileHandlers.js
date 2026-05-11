'use strict';
/**
 * fileHandlers.js — IPC handlers for file read/write/list/watch operations.
 *
 * Extracted from electron-app/main.js for modularity.
 *
 * Usage (in main.js):
 *   const { registerFileHandlers } = require('./ipc/fileHandlers');
 *   registerFileHandlers(ipcMain, { getSettings, send });
 *
 * NOTE: These handlers are NOT registered as standalone ipcMain listeners —
 * instead they are called from the central 'renderer-message' switch inside
 * main.js. This module exports pure functions that implement the handler logic.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const MAX_READ_BYTES   = 500 * 1024;  // 500 KB
const SKIP_DIRS = new Set(['node_modules','.git','dist','.next','__pycache__','.cache','.idea','.vscode','build','out','.DS_Store']);

// ── Pure handler functions ────────────────────────────────────────────────────

/**
 * Handle 'readFile' message.
 * @param {object} msg
 * @param {Function} send
 */
function handleReadFile(msg, send) {
    try {
        const stats = fs.statSync(msg.path);
        if (stats.size > MAX_READ_BYTES) {
            send({ type: 'fileData', path: msg.path, name: path.basename(msg.path), content: null,
                error: `File too large to display (${Math.round(stats.size / 1024)} KB)`,
                purpose: msg.purpose || null });
        } else {
            const content = fs.readFileSync(msg.path, 'utf8');
            send({ type: 'fileData', path: msg.path, name: path.basename(msg.path),
                content, size: stats.size, purpose: msg.purpose || null });
        }
    } catch (err) {
        send({ type: 'fileData', path: msg.path, name: path.basename(msg.path),
            content: null, error: err.message, purpose: msg.purpose || null });
    }
}

/**
 * Handle 'writeFile' message.
 * @param {object} msg
 * @param {Function} send
 */
function handleWriteFile(msg, send) {
    try {
        fs.writeFileSync(msg.path, msg.content || '', 'utf8');
        send({ type: 'fileWritten', path: msg.path, purpose: msg.purpose || null });
    } catch (err) {
        send({ type: 'fileOpError', op: 'writeFile', path: msg.path, error: err.message });
    }
}

/**
 * Handle 'createFile' message.
 * @param {object} msg
 * @param {Function} send
 */
function handleCreateFile(msg, send) {
    try {
        const dir = path.dirname(msg.path);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(msg.path, '', 'utf8');
        send({ type: 'fileCreated', path: msg.path, name: path.basename(msg.path) });
    } catch (err) {
        send({ type: 'fileOpError', op: 'createFile', path: msg.path, error: err.message });
    }
}

/**
 * Handle 'createDir' message.
 * @param {object} msg
 * @param {Function} send
 */
function handleCreateDir(msg, send) {
    try {
        fs.mkdirSync(msg.path, { recursive: true });
        send({ type: 'dirCreated', path: msg.path, name: path.basename(msg.path) });
    } catch (err) {
        send({ type: 'fileOpError', op: 'createDir', path: msg.path, error: err.message });
    }
}

/**
 * Handle 'renameFile' message.
 * @param {object} msg
 * @param {Function} send
 */
function handleRenameFile(msg, send) {
    try {
        fs.renameSync(msg.oldPath, msg.newPath);
        send({ type: 'fileRenamed', oldPath: msg.oldPath, newPath: msg.newPath });
    } catch (err) {
        send({ type: 'fileOpError', op: 'renameFile', path: msg.oldPath, error: err.message });
    }
}

/**
 * Handle 'deleteFile' message.
 * @param {object} msg
 * @param {Function} send
 */
function handleDeleteFile(msg, send) {
    try {
        fs.rmSync(msg.path, { recursive: true, force: true });
        send({ type: 'fileDeleted', path: msg.path });
    } catch (err) {
        send({ type: 'fileOpError', op: 'deleteFile', path: msg.path, error: err.message });
    }
}

/**
 * Async directory listing.
 * @param {object} msg
 * @param {Function} send
 * @param {string} defaultPath
 */
async function handleListDirectory(msg, send, defaultPath) {
    const dirPath = msg.path || defaultPath || os.homedir();
    let readdirInFlight = 0;
    const MAX_READDIR_CONCURRENT = 8;
    const readdirWaiters = [];
    const acquireSlot = async () => {
        if (readdirInFlight < MAX_READDIR_CONCURRENT) { readdirInFlight++; return; }
        await new Promise((r) => readdirWaiters.push(r));
    };
    const releaseSlot = () => {
        const next = readdirWaiters.shift();
        if (next) { next(); return; }
        readdirInFlight--;
    };
    const buildTree = async (dir, depth) => {
        if (depth > 5) return [];
        await acquireSlot();
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
        finally { releaseSlot(); }
        const items = [];
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                items.push({ name: e.name, path: path.join(dir, e.name), type: 'dir',
                    children: await buildTree(path.join(dir, e.name), depth + 1) });
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
}

/**
 * No-op registration function — file operations are dispatched from the central
 * 'renderer-message' handler in main.js using the pure functions above.
 * @param {import('electron').IpcMain} _ipcMain
 */
function registerFileHandlers(_ipcMain) {
    // Reserved for future ipcMain.on/handle registrations.
}

module.exports = {
    registerFileHandlers,
    handleReadFile,
    handleWriteFile,
    handleCreateFile,
    handleCreateDir,
    handleRenameFile,
    handleDeleteFile,
    handleListDirectory,
};

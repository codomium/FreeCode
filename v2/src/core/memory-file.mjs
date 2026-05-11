/**
 * MemoryFile — atomic, mutex-protected CLAUDE.md writes (v4.3-C)
 *
 * Features:
 *  - Atomic write-then-rename (prevents half-written files on crash)
 *  - Async mutex to serialise concurrent writes
 *  - Optional structured JSON/TOML format alongside the Markdown content
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export class MemoryFile {
    /**
     * @param {string} filePath - absolute path to the CLAUDE.md file
     */
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        this._dir     = path.dirname(this.filePath);
        this._lock    = Promise.resolve(); // async mutex
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Read the current content (returns '' if file doesn't exist).
     * @returns {string}
     */
    read() {
        try {
            return fs.readFileSync(this.filePath, 'utf-8');
        } catch {
            return '';
        }
    }

    /**
     * Atomically write content to the file.
     * Serialises concurrent writes via an async mutex.
     * @param {string} content
     * @returns {Promise<void>}
     */
    write(content) {
        this._lock = this._lock.then(() => this._atomicWrite(content));
        return this._lock;
    }

    /**
     * Append a line to the file atomically.
     * @param {string} line
     * @returns {Promise<void>}
     */
    append(line) {
        return this.write((this.read() + '\n' + line).trim() + '\n');
    }

    /**
     * Read structured metadata stored as a JSON fence inside the file.
     * Returns null if no JSON fence is found.
     * @returns {object|null}
     */
    readMeta() {
        const content = this.read();
        const match = content.match(/```json\s*\n([\s\S]*?)\n```/);
        if (!match) return null;
        try {
            return JSON.parse(match[1]);
        } catch {
            return null;
        }
    }

    /**
     * Write structured metadata as a JSON fence in the file.
     * Replaces an existing JSON fence or appends one.
     * @param {object} meta
     * @returns {Promise<void>}
     */
    async writeMeta(meta) {
        let content = this.read();
        const fence = '```json\n' + JSON.stringify(meta, null, 2) + '\n```';
        if (/```json\s*\n[\s\S]*?\n```/.test(content)) {
            content = content.replace(/```json\s*\n[\s\S]*?\n```/, fence);
        } else {
            content = content.trimEnd() + '\n\n' + fence + '\n';
        }
        await this.write(content);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    async _atomicWrite(content) {
        fs.mkdirSync(this._dir, { recursive: true });
        const tmp = path.join(this._dir, `.${path.basename(this.filePath)}.tmp-${crypto.randomBytes(4).toString('hex')}`);
        try {
            fs.writeFileSync(tmp, content, { encoding: 'utf-8' });
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            throw err;
        }
    }
}

/**
 * Helper: locate the nearest CLAUDE.md and return a MemoryFile for it.
 * @param {string} [cwd]
 * @returns {MemoryFile}
 */
export function getProjectMemoryFile(cwd = process.cwd()) {
    const candidates = [
        path.join(cwd, 'CLAUDE.md'),
        path.join(cwd, '.claude', 'CLAUDE.md'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return new MemoryFile(c);
    }
    return new MemoryFile(candidates[0]);
}

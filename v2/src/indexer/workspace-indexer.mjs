/**
 * WorkspaceIndexer — index a workspace directory for semantic search (v4.1-A)
 *
 * Events:
 *   'index:start'    — { workspacePath }
 *   'index:progress' — { indexed, total, currentFile }
 *   'index:complete' — { indexed, skipped, duration }
 *   'index:error'    — { error }
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { EmbeddingEngine } from './embedding-engine.mjs';
import { VectorStore } from './vector-store.mjs';
import { Chunker } from './chunker.mjs';
import os from 'os';
import crypto from 'crypto';

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.cache', 'coverage', '.nyc_output', '.turbo',
    'vendor', '.venv', 'venv', 'env', 'target',
]);

const INDEXABLE_EXTS = new Set([
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'pyw',
    'go', 'rs', 'rb', 'php', 'java', 'kt', 'cs', 'cpp', 'c', 'h',
    'md', 'mdx', 'txt', 'json', 'yaml', 'yml', 'toml',
]);

const MAX_FILE_SIZE = 500 * 1024; // 500 KB
const SAVE_INTERVAL_MS = 5000;    // debounced save interval

export class WorkspaceIndexer extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {EmbeddingEngine} [options.engine]
     * @param {VectorStore}     [options.store]
     * @param {string}          [options.storeDir]   - override store directory
     */
    constructor(options = {}) {
        super();
        this.engine  = options.engine  || new EmbeddingEngine({ provider: 'local-tfidf' });
        this._chunker = new Chunker();
        this._watcher = null;
        this._saveTimer = null;
        this._store = null; // initialised in index()
        this._storeDir = options.storeDir || null;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Index (or re-index) a workspace directory.
     * @param {string} workspacePath
     * @returns {Promise<{ indexed: number, skipped: number, duration: number }>}
     */
    async index(workspacePath) {
        const absPath = path.resolve(workspacePath);
        this._initStore(absPath);
        this._store.load(); // load existing index

        const startMs = Date.now();
        this.emit('index:start', { workspacePath: absPath });

        const files = this._collectFiles(absPath);

        // Build corpus for TF-IDF IDF weights
        const docs = [];
        for (const f of files.slice(0, 500)) {
            try { docs.push(fs.readFileSync(f, 'utf-8')); } catch { /* skip */ }
        }
        this.engine.updateCorpus(docs);

        let indexed = 0, skipped = 0;

        for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            this.emit('index:progress', { indexed, total: files.length, currentFile: filePath });

            try {
                const stat = fs.statSync(filePath);
                if (!this._store.isStale(filePath, stat.mtimeMs)) {
                    skipped++;
                    continue;
                }
                const content = fs.readFileSync(filePath, 'utf-8');
                await this._indexFile(filePath, content, stat.mtimeMs);
                indexed++;
            } catch {
                skipped++;
            }
        }

        this._scheduleSave();
        const duration = Date.now() - startMs;
        this.emit('index:complete', { indexed, skipped, duration });
        return { indexed, skipped, duration };
    }

    /**
     * Start watching a workspace for changes and re-indexing modified files.
     * @param {string} workspacePath
     */
    watchAndUpdate(workspacePath) {
        const absPath = path.resolve(workspacePath);
        if (this._watcher) {
            try { this._watcher.close(); } catch { /* ignore */ }
        }
        try {
            this._watcher = fs.watch(absPath, { recursive: true }, (event, filename) => {
                if (!filename) return;
                const fullPath = path.join(absPath, filename);
                const ext = fullPath.split('.').pop() || '';
                if (!INDEXABLE_EXTS.has(ext)) return;
                setImmediate(async () => {
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.size > MAX_FILE_SIZE) return;
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        await this._indexFile(fullPath, content, stat.mtimeMs);
                        this._scheduleSave();
                    } catch {
                        this._store.deleteFile(fullPath);
                        this._scheduleSave();
                    }
                });
            });
        } catch {
            // Watch not available (e.g. WSL limitations) — silently skip
        }
    }

    /**
     * Stop the file watcher.
     */
    stopWatching() {
        if (this._watcher) {
            try { this._watcher.close(); } catch { /* ignore */ }
            this._watcher = null;
        }
    }

    /**
     * Semantic search over the indexed workspace.
     * @param {string} query
     * @param {number} [topK=20]
     * @returns {Promise<{ filePath: string, text: string, startLine: number, endLine: number, symbolName?: string, score: number }[]>}
     */
    async search(query, topK = 20) {
        if (!this._store || this._store.size === 0) return [];
        const vec = await this.engine.embed(query);
        return this._store.search(vec, topK).map(r => ({
            filePath:   r.chunk.filePath,
            text:       r.chunk.text,
            startLine:  r.chunk.startLine,
            endLine:    r.chunk.endLine,
            symbolName: r.chunk.symbolName,
            score:      r.score,
        }));
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _initStore(workspacePath) {
        if (this._store) return;
        const hash = crypto.createHash('sha1').update(workspacePath).digest('hex').slice(0, 8);
        const storeDir = this._storeDir || path.join(os.homedir(), '.freecode', 'index');
        const storagePath = path.join(storeDir, `${hash}.json`);
        this._store = new VectorStore({ storagePath });
    }

    async _indexFile(filePath, content, mtime) {
        const chunks  = this._chunker.chunkFile(filePath, content);
        if (chunks.length === 0) return;
        const vectors = await this.engine.embedBatch(chunks.map(c => c.text));
        this._store.upsertFile(filePath, chunks, vectors, mtime);
    }

    _collectFiles(dir) {
        const results = [];
        const walk = (d) => {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.') && !['md', 'json', 'yaml', 'yml'].includes(entry.name.split('.').pop())) continue;
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name)) walk(full);
                } else if (entry.isFile()) {
                    const ext = entry.name.split('.').pop() || '';
                    if (INDEXABLE_EXTS.has(ext)) {
                        try {
                            const stat = fs.statSync(full);
                            if (stat.size <= MAX_FILE_SIZE) results.push(full);
                        } catch { /* skip */ }
                    }
                }
            }
        };
        walk(dir);
        return results;
    }

    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            if (this._store) this._store.save();
        }, SAVE_INTERVAL_MS);
    }
}

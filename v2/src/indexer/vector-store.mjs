/**
 * VectorStore — in-memory vector store for semantic search (v4.1-A)
 *
 * Stores chunk embeddings keyed by file path.
 * Uses cosine similarity for nearest-neighbour search.
 *
 * Persistence: serialises to a JSON file at the given storage path.
 * (A proper SQLite backend can be substituted later without changing the API.)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { cosineSimilarity } from './embedding-engine.mjs';

/**
 * @typedef {{ chunkId: string, filePath: string, text: string, startLine: number, endLine: number, symbolName?: string, vector: Float32Array }} StoredChunk
 */

export class VectorStore {
    /**
     * @param {object}  [options]
     * @param {string}  [options.storagePath]   - path to JSON persistence file
     * @param {number}  [options.dimensions=768]
     */
    constructor(options = {}) {
        this.dimensions  = options.dimensions || 768;
        this.storagePath = options.storagePath
            || path.join(os.homedir(), '.freecode', 'index', 'vector-store.json');

        /** @type {Map<string, { mtime: number, chunks: StoredChunk[] }>} */
        this._files = new Map();

        /** Flat array for fast linear scan */
        this._chunks = [];

        this._dirty = false;
    }

    // ── Upsert / delete ───────────────────────────────────────────────────────

    /**
     * Upsert chunks for a file (replaces previous chunks for that file).
     * @param {string}   filePath
     * @param {{ text: string, startLine: number, endLine: number, symbolName?: string }[]} chunks
     * @param {Float32Array[]} vectors
     * @param {number}   [mtime] - file modification time (ms)
     */
    upsertFile(filePath, chunks, vectors, mtime = Date.now()) {
        const absPath = path.resolve(filePath);
        const stored = chunks.map((c, i) => ({
            chunkId:    `${absPath}::${c.startLine}`,
            filePath:   absPath,
            text:       c.text,
            startLine:  c.startLine,
            endLine:    c.endLine,
            symbolName: c.symbolName || null,
            vector:     vectors[i] || new Float32Array(this.dimensions),
        }));
        this._files.set(absPath, { mtime, chunks: stored });
        this._rebuildFlat();
        this._dirty = true;
    }

    /**
     * Remove all chunks for a file.
     * @param {string} filePath
     */
    deleteFile(filePath) {
        const absPath = path.resolve(filePath);
        if (this._files.delete(absPath)) {
            this._rebuildFlat();
            this._dirty = true;
        }
    }

    /**
     * Check whether the stored version of a file is stale.
     * @param {string} filePath
     * @param {number} mtime - current file mtime (ms)
     * @returns {boolean}
     */
    isStale(filePath, mtime) {
        const absPath = path.resolve(filePath);
        const entry = this._files.get(absPath);
        if (!entry) return true;
        return entry.mtime < mtime;
    }

    // ── Search ────────────────────────────────────────────────────────────────

    /**
     * Find the topK most similar chunks for a query vector.
     * @param {Float32Array} queryVector
     * @param {number} [topK=20]
     * @returns {{ filePath: string, chunk: StoredChunk, score: number }[]}
     */
    search(queryVector, topK = 20) {
        const scored = this._chunks.map(chunk => ({
            filePath: chunk.filePath,
            chunk,
            score: cosineSimilarity(queryVector, chunk.vector),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    /**
     * Save the store to disk (JSON format).
     */
    save() {
        try {
            fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
            const data = {
                version: 1,
                files: [...this._files.entries()].map(([filePath, entry]) => ({
                    filePath,
                    mtime: entry.mtime,
                    chunks: entry.chunks.map(c => ({
                        ...c,
                        vector: Array.from(c.vector), // JSON-serialisable
                    })),
                })),
            };
            fs.writeFileSync(this.storagePath, JSON.stringify(data));
            this._dirty = false;
        } catch {
            // Best-effort persistence
        }
    }

    /**
     * Load the store from disk.
     * @returns {boolean} true if loaded successfully
     */
    load() {
        try {
            const raw  = fs.readFileSync(this.storagePath, 'utf-8');
            const data = JSON.parse(raw);
            this._files.clear();
            for (const entry of (data.files || [])) {
                this._files.set(entry.filePath, {
                    mtime:  entry.mtime,
                    chunks: entry.chunks.map(c => ({
                        ...c,
                        vector: Float32Array.from(c.vector),
                    })),
                });
            }
            this._rebuildFlat();
            this._dirty = false;
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Return the number of indexed chunks.
     * @returns {number}
     */
    get size() {
        return this._chunks.length;
    }

    /**
     * Return the list of indexed file paths.
     * @returns {string[]}
     */
    indexedFiles() {
        return [...this._files.keys()];
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _rebuildFlat() {
        this._chunks = [];
        for (const { chunks } of this._files.values()) {
            this._chunks.push(...chunks);
        }
    }
}

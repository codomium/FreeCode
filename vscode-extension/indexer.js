'use strict';
/**
 * indexer.js — Content-aware TF-IDF semantic codebase indexer.
 *
 * Replaces the naive path-token-only indexer with one that:
 *   - Reads file content (first 4000 bytes, async via vscode.workspace.fs)
 *   - Extracts function/class/export symbols with regex
 *   - Builds a TF-IDF index: term frequency per file × IDF across all files
 *   - Supports incremental rebuild (onFileChanged / onFileDeleted)
 *   - Caches per-file index data keyed by mtime to skip unchanged files
 *   - Processes files in batches of 50 with a setImmediate yield to stay non-blocking
 *
 * Score formula (searchIndex):
 *   pathScore   = path token match × 3
 *   symbolScore = exact symbol match × 5
 *   tfidfScore  = TF-IDF cosine-ish sum × 2
 */

const vscode = require('vscode');
const path   = require('path');

// Regex that matches meaningful identifiers (3+ chars, no pure numbers)
const TOKEN_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

// Stopwords to ignore in TF-IDF (very common JS/TS keywords)
const STOPWORDS = new Set([
    'the', 'and', 'for', 'this', 'that', 'with', 'from', 'var', 'let',
    'const', 'function', 'class', 'return', 'import', 'export', 'default',
    'async', 'await', 'new', 'null', 'true', 'false', 'undefined', 'void',
    'typeof', 'instanceof', 'else', 'case', 'break', 'continue', 'throw',
    'catch', 'finally', 'static', 'extends', 'super', 'module', 'require',
    'object', 'string', 'number', 'boolean', 'array', 'type', 'interface',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Tokenise text — extract meaningful identifiers. */
function tokenise(text) {
    const tokens = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
        const t = m[0].toLowerCase();
        if (!STOPWORDS.has(t)) tokens.push(t);
    }
    return tokens;
}

/** Term frequency map for an array of tokens. */
function termFreq(tokens) {
    const tf = new Map();
    for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
    }
    // Normalise by document length
    const len = tokens.length || 1;
    for (const [k, v] of tf) tf.set(k, v / len);
    return tf;
}

/**
 * Extract symbol names (functions, classes, exports) from source content.
 * @param {string} content
 * @returns {string[]}
 */
function extractSymbols(content) {
    const symbols = new Set();
    const patterns = [
        /function\s+(\w+)/g,
        /class\s+(\w+)/g,
        /export\s+(?:const|function|class|async\s+function)\s+(\w+)/g,
        /(?:const|let|var)\s+(\w+)\s*=/g,
    ];
    for (const re of patterns) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(content)) !== null) {
            if (m[1] && m[1].length > 2) symbols.add(m[1]);
        }
    }
    return [...symbols];
}

/** Read up to maxBytes of a file using vscode.workspace.fs (remote-safe). */
async function readFileContent(uri, maxBytes = 4000) {
    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const slice = raw.slice(0, maxBytes);
        return Buffer.from(slice).toString('utf8');
    } catch {
        return '';
    }
}

/** Get the mtime of a file via vscode.workspace.fs.stat. */
async function getFileMtime(uri) {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.mtime;
    } catch {
        return 0;
    }
}

// ── CodebaseIndexer ───────────────────────────────────────────────────────────

class CodebaseIndexer {
    constructor() {
        /** Map<fsPath, { pathTokens: Set, contentTF: Map, symbols: string[], mtime: number }> */
        this._index    = new Map();
        /** Map<term, number> — document frequency for IDF computation */
        this._df       = new Map();
        /** Map<term, number> — cached IDF values; invalidated when _df or _numDocs changes */
        this._idfCache = new Map();
        this._numDocs  = 0;
        this._ready    = false;
        this._buildMs  = 0;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Build (or rebuild) the full index. */
    async build() {
        const t0 = Date.now();
        this._ready = false;

        const include = '**/*.{js,mjs,ts,tsx,jsx,py,go,rs,java,cpp,c,cs,rb,swift,kt,php,vue,svelte}';
        const exclude = '**/{.git,node_modules,dist,build,out,target,.next,.cache,__pycache__,coverage}/**';

        let uris;
        try {
            uris = await vscode.workspace.findFiles(include, exclude, 10000);
        } catch {
            uris = [];
        }

        // Rebuild in batches to stay non-blocking
        this._index.clear();
        this._df.clear();
        this._idfCache.clear();
        this._numDocs = 0;

        const BATCH = 50;
        for (let i = 0; i < uris.length; i += BATCH) {
            const batch = uris.slice(i, i + BATCH);
            await Promise.all(batch.map((uri) => this._indexOne(uri)));
            // Yield between batches so we don't starve the event loop
            await new Promise((r) => setImmediate(r));
        }

        this._numDocs = this._index.size;
        this._buildMs = Date.now() - t0;
        this._idfCache.clear();  // invalidate IDF cache after full rebuild
        this._ready   = true;

        return this.getStats();
    }

    /**
     * Score and return the top-N matching files for a query string.
     * @param {string} query
     * @param {number} [limit=8]
     * @returns {{ path:string, relativePath:string, name:string, score:number }[]}
     */
    searchIndex(query, limit = 8) {
        if (!this._ready || !query) return [];

        const qTokens  = tokenise(query);
        const qSymbols = query.split(/\W+/).filter((t) => t.length > 2);

        if (!qTokens.length && !qSymbols.length) return [];

        const scored = [];
        for (const [fsPath, entry] of this._index.entries()) {
            let score = 0;

            // Path token score
            for (const qt of qTokens) {
                for (const pt of entry.pathTokens) {
                    if (pt === qt) score += 3;
                    else if (pt.includes(qt)) score += 1;
                }
            }

            // Symbol exact match score
            for (const qs of qSymbols) {
                for (const sym of entry.symbols) {
                    if (sym.toLowerCase() === qs.toLowerCase()) score += 5;
                    else if (sym.toLowerCase().includes(qs.toLowerCase())) score += 2;
                }
            }

            // TF-IDF content score
            for (const qt of qTokens) {
                const tf  = entry.contentTF.get(qt) || 0;
                score += tf * this._idf(qt) * 2;
            }

            if (score > 0) scored.push({ fsPath, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((r) => ({
            path:         r.fsPath,
            relativePath: vscode.workspace.asRelativePath(r.fsPath),
            name:         path.basename(r.fsPath),
            score:        r.score,
        }));
    }

    /**
     * Incrementally update the index when a file changes.
     * @param {import('vscode').Uri} uri
     */
    async onFileChanged(uri) {
        await this._indexOne(uri);
        this._numDocs = this._index.size;
        this._idfCache.clear();
    }

    /**
     * Remove a deleted file from the index.
     * @param {import('vscode').Uri} uri
     */
    onFileDeleted(uri) {
        const fsPath = uri.fsPath;
        if (!this._index.has(fsPath)) return;
        const entry = this._index.get(fsPath);
        for (const [term] of entry.contentTF) {
            const df = this._df.get(term) || 0;
            if (df <= 1) this._df.delete(term);
            else this._df.set(term, df - 1);
        }
        this._index.delete(fsPath);
        this._numDocs = this._index.size;
        this._idfCache.clear();
    }

    /**
     * Return basic index statistics.
     * @returns {{ filesIndexed:number, totalTerms:number, buildTimeMs:number }}
     */
    getStats() {
        return {
            filesIndexed: this._index.size,
            totalTerms:   this._df.size,
            buildTimeMs:  this._buildMs,
        };
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /**
     * Compute and cache the IDF for a term.
     * @param {string} term
     * @returns {number}
     */
    _idf(term) {
        if (this._idfCache.has(term)) return this._idfCache.get(term);
        const df  = this._df.get(term) || 0;
        const idf = df > 0 ? Math.log((this._numDocs + 1) / (df + 1)) + 1 : 0;
        this._idfCache.set(term, idf);
        return idf;
    }

    async _indexOne(uri) {
        const fsPath = uri.fsPath;
        const mtime  = await getFileMtime(uri);

        // mtime cache: skip if nothing changed
        const existing = this._index.get(fsPath);
        if (existing && existing.mtime === mtime) return;

        // Remove old DF contributions before recomputing
        if (existing) {
            for (const [term] of existing.contentTF) {
                const df = this._df.get(term) || 0;
                if (df <= 1) this._df.delete(term);
                else this._df.set(term, df - 1);
            }
        }

        // Path tokens
        const rel        = vscode.workspace.asRelativePath(fsPath).toLowerCase();
        const base       = path.basename(fsPath).toLowerCase();
        const pathTokens = new Set(
            `${rel} ${base}`.split(/[^a-z0-9_./-]+/i).map((t) => t.trim()).filter(Boolean)
        );

        // File content + symbols
        const content     = await readFileContent(uri);
        const contentToks = tokenise(content);
        const contentTF   = termFreq(contentToks);
        const symbols     = extractSymbols(content);

        // Update DF and invalidate IDF cache for affected terms
        let dfChanged = false;
        for (const [term] of contentTF) {
            this._df.set(term, (this._df.get(term) || 0) + 1);
            this._idfCache.delete(term); // invalidate cached IDF for this term
            dfChanged = true;
        }
        // If numDocs changes, all IDF values shift — clear the whole cache
        if (dfChanged && this._index.size !== this._numDocs) {
            this._idfCache.clear();
        }

        this._index.set(fsPath, { pathTokens, contentTF, symbols, mtime });
    }
}

module.exports = { CodebaseIndexer };

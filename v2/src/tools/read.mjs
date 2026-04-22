/**
 * Read Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - pages parameter for PDF files
 * - Binary file detection
 * - Default 2000 line limit
 * - Line number prefix (cat -n format)
 * - Graceful file not found handling
 * - Tracks read files for Edit/Write verification
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const DEFAULT_LIMIT = 2000;
const MAX_CACHE_ENTRIES = 500; // E9: cap unbounded growth in long sessions

// Track which files have been read (used by Edit and Write tools)
const readFiles = new Set();
// Cache last rendered output by path+mtime to avoid re-reading unchanged files every turn.
// Key: resolved filePath. Only cached for default (full-file) reads — partial reads (offset/limit)
// are not cached so they never pollute the entry for the full-file view (E1).
const contentCache = new Map();

export function hasBeenRead(filePath) {
    return readFiles.has(path.resolve(filePath));
}

export function markRead(filePath) {
    readFiles.add(path.resolve(filePath));
}

export function clearReadTracking() {
    // Fix: reset stale read/edit state and cached outputs between sessions.
    readFiles.clear();
    contentCache.clear();
}

/**
 * Invalidate the cached output for a single file (E2).
 * Called by Edit, Write, and MultiEdit after a successful write so that a
 * subsequent Read always re-reads from disk rather than returning stale content.
 * @param {string} filePath - resolved absolute path
 */
export function invalidateCache(filePath) {
    contentCache.delete(path.resolve(filePath));
}

/**
 * Write a new entry into contentCache, evicting the oldest entry first if the
 * cache has grown too large (E9 — prevents unbounded growth in long sessions).
 * @param {string} key  - resolved file path (cache key)
 * @param {object} value - { mtime, output }
 */
function setCacheEntry(key, value) {
    if (contentCache.size >= MAX_CACHE_ENTRIES) {
        // Map preserves insertion order; the first key is the oldest entry.
        contentCache.delete(contentCache.keys().next().value);
    }
    contentCache.set(key, value);
}

// Binary detection: check for null bytes in first 8KB
function isBinary(buffer) {
    const len = Math.min(buffer.length, 8192);
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

export const ReadTool = {
    name: 'Read',
    description: 'Read a file from the local filesystem.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            offset: { type: 'number', description: 'Line number to start reading from (0-based)' },
            limit: { type: 'number', description: 'Number of lines to read (default 2000)' },
            pages: { type: 'string', description: 'Page range for PDF files (e.g. "1-5")' },
        },
        required: ['file_path'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.file_path) errors.push('file_path is required');
        return errors;
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);

        // Check existence
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }

        // Check if directory
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return `Error: ${filePath} is a directory, not a file. Use Bash with ls to list directory contents.`;
        }
        const mtime = stat.mtimeMs;
        // E1: only use the mtime cache for full-file (default) reads.
        // Partial reads (offset/limit specified) are not cached to avoid polluting
        // the full-file cache entry with a truncated view.
        const isDefaultRead = !input.offset && !input.limit;
        if (isDefaultRead) {
            const cached = contentCache.get(filePath);
            if (cached && cached.mtime === mtime) {
                readFiles.add(filePath);
                return cached.output;
            }
        }

        // PDF handling
        if (filePath.endsWith('.pdf')) {
            const output = readPdf(filePath, input.pages);
            readFiles.add(filePath);
            if (isDefaultRead) setCacheEntry(filePath, { mtime, output });
            return output;
        }

        // Binary detection
        try {
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(8192);
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);
            if (isBinary(buf.subarray(0, bytesRead))) {
                return `Error: ${filePath} appears to be a binary file. Cannot display binary content.`;
            }
        } catch (e) {
            return `Error: ${e.message}`;
        }

        try {
            // Normalize CRLF → LF so Windows files are presented to the model
            // with consistent line endings, preventing \r from leaking into
            // old_string context that the model uses for Edit/MultiEdit calls.
            const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const lines = content.split('\n');
            const start = input.offset || 0;
            const limit = input.limit || DEFAULT_LIMIT;
            const end = Math.min(start + limit, lines.length);

            // Track as read
            readFiles.add(filePath);

            // Handle empty files
            if (content === '' || (content.length === 0)) {
                const output = '[File exists but is empty]';
                if (isDefaultRead) setCacheEntry(filePath, { mtime, output });
                return output;
            }

            const output = lines
                .slice(start, end)
                .map((l, i) => `${start + i + 1}\t${l}`)
                .join('\n');

            if (end < lines.length) {
                const truncatedOutput = output + `\n\n[File has ${lines.length} lines total. Showing lines ${start + 1}-${end}. Use offset/limit for more.]`;
                if (isDefaultRead) setCacheEntry(filePath, { mtime, output: truncatedOutput });
                return truncatedOutput;
            }

            if (isDefaultRead) setCacheEntry(filePath, { mtime, output });
            return output;
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },
};

function readPdf(filePath, pages) {
    // PDF reading requires external tools; provide a best-effort
    // text extraction using a simple approach
    try {
        const [startPage, endPage] = pages
            ? [pages.split('-')[0], pages.split('-').pop()]
            : ['1', '20'];
        const args = ['-f', startPage, '-l', endPage, filePath, '-'];
        const result = spawnSync('pdftotext', args, {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024,
        });
        const text = result.stdout || '';
        return text || `[PDF file at ${filePath} — could not extract text. Use a PDF viewer.]`;
    } catch {
        return `[PDF file at ${filePath} — pdftotext not available. Install poppler-utils for PDF support.]`;
    }
}

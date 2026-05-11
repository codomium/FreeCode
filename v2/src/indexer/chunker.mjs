/**
 * Chunker — split source files into semantically meaningful chunks (v4.1-A)
 *
 * Strategies:
 *  - JS/TS : split by function / class / arrow-function boundaries
 *  - Python : split by def / class boundaries
 *  - Everything else : sliding window (512 tokens ≈ 2048 chars, 128 token overlap ≈ 512 chars)
 */

const WINDOW_CHARS   = 2048; // ~512 tokens at 4 chars/token
const OVERLAP_CHARS  = 512;  // ~128 token overlap

/**
 * @typedef {{ text: string, startLine: number, endLine: number, symbolName?: string }} Chunk
 */

export class Chunker {
    /**
     * Split a file's content into Chunk objects.
     * @param {string} filePath - used to detect language
     * @param {string} content
     * @returns {Chunk[]}
     */
    chunkFile(filePath, content) {
        const ext = filePath.toLowerCase().split('.').pop() || '';
        if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {
            return this._chunkJs(content);
        }
        if (['py', 'pyw'].includes(ext)) {
            return this._chunkPython(content);
        }
        return this._chunkSliding(content);
    }

    // ── JS / TS chunker ───────────────────────────────────────────────────────

    _chunkJs(content) {
        const lines = content.split('\n');
        const chunks = [];
        const boundaryRe = /^(?:export\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/;

        let start = 0;
        for (let i = 1; i < lines.length; i++) {
            if (boundaryRe.test(lines[i].trimStart()) && i > start) {
                const block = lines.slice(start, i);
                chunks.push(this._makeChunk(block, start, i - 1));
                start = i;
            }
        }
        // Remainder
        if (start < lines.length) {
            const block = lines.slice(start);
            chunks.push(this._makeChunk(block, start, lines.length - 1));
        }

        return this._filterEmpty(chunks);
    }

    // ── Python chunker ────────────────────────────────────────────────────────

    _chunkPython(content) {
        const lines = content.split('\n');
        const chunks = [];
        const boundaryRe = /^(?:def |class |async def )/;

        let start = 0;
        for (let i = 1; i < lines.length; i++) {
            if (boundaryRe.test(lines[i]) && i > start) {
                const block = lines.slice(start, i);
                chunks.push(this._makeChunk(block, start, i - 1));
                start = i;
            }
        }
        if (start < lines.length) {
            chunks.push(this._makeChunk(lines.slice(start), start, lines.length - 1));
        }
        return this._filterEmpty(chunks);
    }

    // ── Sliding window ────────────────────────────────────────────────────────

    _chunkSliding(content) {
        const chunks = [];
        const lines = content.split('\n');
        let pos = 0; // char position

        while (pos < content.length) {
            const windowText = content.slice(pos, pos + WINDOW_CHARS);
            const startLine  = content.slice(0, pos).split('\n').length - 1;
            const endLine    = startLine + windowText.split('\n').length - 1;
            chunks.push({ text: windowText, startLine, endLine });
            pos += WINDOW_CHARS - OVERLAP_CHARS;
            if (pos + OVERLAP_CHARS >= content.length) break;
        }

        // Push last chunk if there's leftover
        if (chunks.length === 0 || pos < content.length) {
            const remaining = content.slice(pos);
            if (remaining.trim().length > 0) {
                const startLine = content.slice(0, pos).split('\n').length - 1;
                const endLine   = lines.length - 1;
                chunks.push({ text: remaining, startLine, endLine });
            }
        }

        return chunks;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _makeChunk(lines, startLine, endLine) {
        const text = lines.join('\n');
        // Try to extract symbol name from the first non-empty line
        const firstLine = lines.find(l => l.trim().length > 0) || '';
        const nameMatch = firstLine.match(/(?:function|class|def|async def|const|let|var)\s+(\w+)/);
        return {
            text,
            startLine,
            endLine,
            symbolName: nameMatch ? nameMatch[1] : undefined,
        };
    }

    _filterEmpty(chunks) {
        return chunks.filter(c => c.text.trim().length > 0);
    }
}

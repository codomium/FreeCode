/**
 * MultiEdit Tool — apply multiple edits to one or more files atomically.
 *
 * Each edit is an { file_path, old_string, new_string } triple.
 * All edits are validated before any are applied.
 */

import fs from 'fs';
import path from 'path';

/** Minimum length for a trimmed line to be used as a similarity search needle */
const MIN_SEARCH_LINE_LENGTH = 4;

/**
 * Normalize line endings to LF so that CRLF files (Windows) can be matched
 * against LF-only search strings supplied by the model.
 */
function normalizeLineEndings(str) {
    return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * When old_string is not found verbatim, find lines in the file that contain
 * the first non-empty trimmed line of old_string. Returns a formatted hint
 * string (or '') to help the model self-correct.
 */
function findSimilarLinesHint(content, oldString, filePath) {
    const needle = (oldString || '').split('\n').map(l => l.trim()).find(l => l.length >= MIN_SEARCH_LINE_LENGTH);
    if (!needle) return '';
    const lines = content.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(needle)) {
            matches.push(`  line ${i + 1}: ${lines[i]}`);
            if (matches.length >= 5) break;
        }
    }
    if (matches.length === 0) return '';
    return `\nClosest match(es) in ${path.basename(filePath)}:\n${matches.join('\n')}`;
}

export const MultiEditTool = {
    name: 'MultiEdit',
    description: 'Apply multiple file edits in a single operation. All edits are validated first.',
    inputSchema: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        file_path: { type: 'string' },
                        old_string: { type: 'string' },
                        new_string: { type: 'string' },
                    },
                    required: ['file_path', 'old_string', 'new_string'],
                },
                description: 'Array of edits to apply',
            },
        },
        required: ['edits'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.edits || !Array.isArray(input.edits)) {
            errors.push('edits must be an array');
            return errors;
        }
        // Normalize common alternative key names the model may use
        for (const e of input.edits) {
            if (e.file_path === undefined || e.file_path === null) {
                e.file_path = e.filename ?? e.path ?? e.file ?? null;
            }
            if (e.old_string === undefined || e.old_string === null) {
                e.old_string = e.old_content ?? e.original_string ?? e.original ?? e.search ?? null;
            }
            if (e.new_string === undefined || e.new_string === null) {
                e.new_string = e.new_content ?? e.replacement_string ?? e.replacement ?? e.replace ?? null;
            }
        }
        for (let i = 0; i < input.edits.length; i++) {
            const e = input.edits[i];
            if (!e.file_path) errors.push(`edit[${i}]: file_path required`);
            if (e.old_string == null) errors.push(`edit[${i}]: old_string required`);
            if (e.old_string !== null && e.old_string === e.new_string) errors.push(`edit[${i}]: old_string must differ from new_string`);
        }
        return errors;
    },

    async call(input) {
        // Phase 1: Validate all edits
        // fileContents stores normalized (LF) content for matching; rawContents stores original bytes
        const fileContents = new Map(); // filePath -> normalized content (LF)
        const rawContents  = new Map(); // filePath -> original content (preserves original line endings for display)
        const errors = [];

        for (let i = 0; i < input.edits.length; i++) {
            const edit = input.edits[i];
            const filePath = path.resolve(edit.file_path);

            if (!fileContents.has(filePath)) {
                try {
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    rawContents.set(filePath, raw);
                    // Normalize CRLF → LF so Windows files match LF-only search strings
                    fileContents.set(filePath, normalizeLineEndings(raw));
                } catch (err) {
                    errors.push(`edit[${i}]: cannot read ${filePath}: ${err.message}`);
                    continue;
                }
            }

            const content = fileContents.get(filePath);
            // Normalize the search string too (model may have received CRLF content)
            const normalizedOld = normalizeLineEndings(edit.old_string);
            if (!content.includes(normalizedOld)) {
                errors.push(`edit[${i}]: old_string not found in ${edit.file_path}${findSimilarLinesHint(content, normalizedOld, filePath)}`);
            } else {
                // Store normalized old_string back so Phase 2 uses it consistently
                edit._normalizedOld = normalizedOld;
            }
        }

        if (errors.length > 0) {
            return `Validation failed:\n${errors.join('\n')}`;
        }

        // Phase 2: Apply all edits (using normalized content)
        for (const edit of input.edits) {
            const filePath = path.resolve(edit.file_path);
            let content = fileContents.get(filePath);
            const searchStr = edit._normalizedOld ?? normalizeLineEndings(edit.old_string);
            const replaceStr = normalizeLineEndings(edit.new_string);
            content = content.replace(searchStr, replaceStr);
            fileContents.set(filePath, content);
        }

        // Phase 3: Write all files (always write with LF endings for consistency)
        const applied = [];
        for (const [filePath, content] of fileContents) {
            fs.writeFileSync(filePath, content);
            applied.push(filePath);
        }

        return `Applied ${input.edits.length} edits to ${applied.length} file(s):\n${applied.join('\n')}`;
    },
};

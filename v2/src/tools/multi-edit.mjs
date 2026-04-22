/**
 * MultiEdit Tool — apply multiple edits to one or more files atomically.
 *
 * Each edit is an { file_path, old_string, new_string } triple.
 * All edits are validated before any are applied.
 */

import fs from 'fs';
import path from 'path';
import { hasBeenRead, markRead } from './read.mjs';
import {
    normalizeContent,
    normalizeLineEndings,
    findSimilarLinesHint,
    tryWhitespaceNormalizedMatch,
} from './edit-utils.mjs';

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
            if (e.new_string == null) errors.push(`edit[${i}]: new_string required`);
            if (e.old_string != null && e.new_string != null && e.old_string === e.new_string) errors.push(`edit[${i}]: old_string must differ from new_string`);
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
                // Require file was read first (same contract as the Edit tool)
                if (!hasBeenRead(filePath)) {
                    errors.push(`edit[${i}]: You must Read ${filePath} before editing it. Use the Read tool first.`);
                    continue;
                }
                try {
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    rawContents.set(filePath, raw);
                    // Strip BOM and normalize CRLF → LF so Windows files match LF-only search strings
                    fileContents.set(filePath, normalizeContent(raw));
                } catch (err) {
                    errors.push(`edit[${i}]: cannot read ${filePath}: ${err.message}`);
                    continue;
                }
            }

            const content = fileContents.get(filePath);
            // Normalize the search string too (model may have received CRLF content)
            const normalizedOld = normalizeLineEndings(edit.old_string);
            if (content.includes(normalizedOld)) {
                // Store normalized old_string back so Phase 2 uses it consistently
                edit._normalizedOld = normalizedOld;
            } else {
                // Fallback: try trailing-whitespace-insensitive line matching so that
                // minor indentation/trailing-space differences don't block the edit.
                const actualOld = tryWhitespaceNormalizedMatch(content, normalizedOld);
                if (actualOld !== null) {
                    // Store the file's actual substring (with its real trailing whitespace)
                    // so Phase 2 can replace it precisely.
                    edit._wsNormalizedOld = actualOld;
                } else {
                    errors.push(`edit[${i}]: old_string not found in ${edit.file_path}${findSimilarLinesHint(content, normalizedOld, filePath)}`);
                }
            }
        }

        if (errors.length > 0) {
            return `Validation failed:\n${errors.join('\n')}`;
        }

        // Phase 2: Apply all edits (using normalized content)
        for (const edit of input.edits) {
            const filePath = path.resolve(edit.file_path);
            let content = fileContents.get(filePath);
            // Prefer the whitespace-normalized actual substring (_wsNormalizedOld), then the
            // exact normalized string (_normalizedOld), then fall back to re-normalizing inline.
            const searchStr = edit._wsNormalizedOld ?? edit._normalizedOld ?? normalizeLineEndings(edit.old_string);
            const replaceStr = normalizeLineEndings(edit.new_string);
            content = content.replace(searchStr, replaceStr);
            fileContents.set(filePath, content);
        }

        // Phase 3: Write all files (always write with LF endings for consistency)
        const applied = [];
        for (const [filePath, content] of fileContents) {
            fs.writeFileSync(filePath, content);
            // Keep the file tracked as read so subsequent Edit calls work without re-reading
            markRead(filePath);
            applied.push(filePath);
        }

        return `Applied ${input.edits.length} edits to ${applied.length} file(s):\n${applied.join('\n')}`;
    },
};

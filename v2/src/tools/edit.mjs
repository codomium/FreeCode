/**
 * Edit Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - replace_all parameter for global replacement
 * - Verify old_string is unique (error if not)
 * - Require file was Read first (track read files)
 * - Preserve exact indentation
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

function formatEditSuccess(filePath, oldString, newString, note = '') {
    // Fix: include compact replacement preview so models don't need an immediate Read re-check.
    const oldLineCount = oldString.split('\n').length;
    const newLineCount = newString.split('\n').length;
    const preview = newString.slice(0, 300);
    const noteSuffix = note ? ` (${note})` : '';
    return `File updated: ${filePath}${noteSuffix}\nReplaced ${oldLineCount} line(s) → ${newLineCount} line(s)\nNew content preview:\n${preview}`;
}

export const EditTool = {
    name: 'Edit',
    description: 'Performs exact string replacements in files.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            old_string: { type: 'string', description: 'The text to replace' },
            new_string: { type: 'string', description: 'The replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences', default: false },
        },
        required: ['file_path', 'old_string', 'new_string'],
    },
    validateInput(input) {
        // Normalize common alternative parameter names the model may use
        if (!input.file_path) {
            input.file_path = input.filename ?? input.path ?? input.file ?? null;
        }
        if (input.old_string === undefined || input.old_string === null) {
            input.old_string = input.old_content ?? input.original_string ?? input.original ?? input.search ?? null;
        }
        if (input.new_string === undefined || input.new_string === null) {
            input.new_string = input.new_content ?? input.replacement_string ?? input.replacement ?? input.replace ?? null;
        }
        const errors = [];
        if (!input.file_path) errors.push('file_path required');
        if (!input.old_string && input.old_string !== '') errors.push('old_string required');
        if (input.old_string === input.new_string) errors.push('old_string must differ from new_string');
        return errors;
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);

        // Check file exists
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }

        // Require file was read first
        if (!hasBeenRead(filePath)) {
            return `Error: You must Read ${filePath} before editing it. Use the Read tool first.`;
        }

        let content;
        try {
            // Normalize BOM + CRLF → LF so Windows files match LF-only search strings from the model
            content = normalizeContent(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            return `Error: ${e.message}`;
        }

        const oldString = normalizeLineEndings(input.old_string);
        const newString = normalizeLineEndings(input.new_string);

        if (!content.includes(oldString)) {
            // Fallback: trailing-whitespace-insensitive line matching.
            // tryWhitespaceNormalizedMatch uses indexOf on the trimmed-end content so it
            // correctly handles old_string values that begin with empty lines.
            const actualOld = tryWhitespaceNormalizedMatch(content, oldString);
            if (actualOld !== null) {
                if (input.replace_all) {
                    const escaped = actualOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    content = content.replace(new RegExp(escaped, 'g'), newString);
                } else {
                    content = content.replace(actualOld, newString);
                }
                try {
                    fs.writeFileSync(filePath, content);
                    markRead(filePath);
                    return formatEditSuccess(filePath, oldString, newString, 'matched after whitespace normalization');
                } catch (e) {
                    return `Error writing file: ${e.message}`;
                }
            }
            return `Error: old_string not found in file. Make sure the string matches exactly, including whitespace and indentation.${findSimilarLinesHint(content, oldString, filePath)}`;
        }

        if (input.replace_all) {
            // Replace all occurrences
            const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(escaped, 'g'), newString);
        } else {
            // Check uniqueness: old_string must appear exactly once
            const firstIdx = content.indexOf(oldString);
            const secondIdx = content.indexOf(oldString, firstIdx + 1);
            if (secondIdx !== -1) {
                const count = content.split(oldString).length - 1;
                return `Error: old_string is not unique in the file (found ${count} occurrences). Provide more context to make it unique, or use replace_all to replace all occurrences.`;
            }
            content = content.replace(oldString, newString);
        }

        try {
            fs.writeFileSync(filePath, content);
            // Keep it marked as read
            markRead(filePath);
            return formatEditSuccess(filePath, oldString, newString);
        } catch (e) {
            return `Error writing file: ${e.message}`;
        }
    },
};

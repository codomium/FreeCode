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
 * string (or '' when nothing useful is found) to help the model self-correct.
 *
 * @param {string} content - full file content
 * @param {string} oldString - the old_string that was not found
 * @param {string} filePath - absolute file path (for display only)
 * @returns {string}
 */
function findSimilarLinesHint(content, oldString, filePath) {
    // Find the first non-empty, non-whitespace line of old_string as the needle
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
            // Normalize CRLF → LF so Windows files match LF-only search strings from the model
            content = normalizeLineEndings(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            return `Error: ${e.message}`;
        }

        const oldString = normalizeLineEndings(input.old_string);
        const newString = normalizeLineEndings(input.new_string);

        if (!content.includes(oldString)) {
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
            return `File updated: ${filePath}`;
        } catch (e) {
            return `Error writing file: ${e.message}`;
        }
    },
};

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
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (e) {
            return `Error: ${e.message}`;
        }

        if (!content.includes(input.old_string)) {
            // Try whitespace-normalized match as a fallback to help the agent recover
            const normalizeWs = (s) => s.split('\n').map(l => l.trimEnd()).join('\n').replace(/\r/g, '');
            const normContent = normalizeWs(content);
            const normOld = normalizeWs(input.old_string);
            if (normContent.includes(normOld)) {
                // Find the original substring that corresponds to the normalized match
                // by locating the first line of old_string in the file and extracting the block
                const firstLine = input.old_string.split('\n').find(l => l.trim().length >= MIN_SEARCH_LINE_LENGTH);
                if (firstLine) {
                    const lines = content.split('\n');
                    const startIdx = lines.findIndex(l => l.trimEnd() === firstLine.trimEnd());
                    if (startIdx !== -1) {
                        const oldLines = input.old_string.split('\n');
                        const candidateLines = lines.slice(startIdx, startIdx + oldLines.length);
                        // Verify each line matches when trailing whitespace is stripped
                        const allMatch = oldLines.every((ol, i) =>
                            candidateLines[i] !== undefined &&
                            candidateLines[i].trimEnd() === ol.trimEnd()
                        );
                        if (allMatch) {
                            const actualOld = candidateLines.join('\n');
                            // Apply the replacement using the actual (indentation-correct) old string
                            if (input.replace_all) {
                                const escaped = actualOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                content = content.replace(new RegExp(escaped, 'g'), input.new_string);
                            } else {
                                content = content.replace(actualOld, input.new_string);
                            }
                            try {
                                fs.writeFileSync(filePath, content);
                                markRead(filePath);
                                return `File updated: ${filePath} (matched after whitespace normalization)`;
                            } catch (e) {
                                return `Error writing file: ${e.message}`;
                            }
                        }
                    }
                }
            }
            return `Error: old_string not found in file. Make sure the string matches exactly, including whitespace and indentation.${findSimilarLinesHint(content, input.old_string, filePath)}`;
        }

        if (input.replace_all) {
            // Replace all occurrences
            const escaped = input.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(escaped, 'g'), input.new_string);
        } else {
            // Check uniqueness: old_string must appear exactly once
            const firstIdx = content.indexOf(input.old_string);
            const secondIdx = content.indexOf(input.old_string, firstIdx + 1);
            if (secondIdx !== -1) {
                const count = content.split(input.old_string).length - 1;
                return `Error: old_string is not unique in the file (found ${count} occurrences). Provide more context to make it unique, or use replace_all to replace all occurrences.`;
            }
            content = content.replace(input.old_string, input.new_string);
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

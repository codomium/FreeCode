/**
 * Shared utilities for the Edit and MultiEdit tools.
 */
import path from 'path';

/** Minimum length for a trimmed line to be used as a similarity search needle */
export const MIN_SEARCH_LINE_LENGTH = 4;

/**
 * Strip a UTF-8 Byte Order Mark (U+FEFF) from the start of a string.
 * Some Windows editors (e.g. Notepad, Visual Studio) prepend a BOM which
 * would cause the first line to fail to match the model's search string.
 */
export function stripBom(str) {
    return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

/**
 * Normalize line endings to LF so that CRLF files (Windows) can be matched
 * against LF-only search strings supplied by the model.
 */
export function normalizeLineEndings(str) {
    return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Normalize file content: strip BOM and normalize line endings.
 * Use this when reading a file for matching/display.
 */
export function normalizeContent(str) {
    return normalizeLineEndings(stripBom(str));
}

/**
 * When old_string is not found verbatim, find lines in the file that contain
 * the first non-empty trimmed line of old_string.  Returns a formatted hint
 * string (or '') to help the model self-correct.
 *
 * For multi-line old_string, shows the full block of lines from the file
 * starting at each match so the model can see the exact content and identify
 * the difference.
 *
 * @param {string} content  - normalized (LF, no BOM) file content
 * @param {string} oldString - the old_string that was not found
 * @param {string} filePath  - absolute file path (for display only)
 * @returns {string}
 */
export function findSimilarLinesHint(content, oldString, filePath) {
    const needle = (oldString || '')
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length >= MIN_SEARCH_LINE_LENGTH);
    if (!needle) return '';

    const lines = content.split('\n');
    const oldLineCount = Math.max((oldString || '').split('\n').length, 1);
    const matches = [];

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(needle)) {
            if (oldLineCount > 1) {
                // Show the full block corresponding to old_string's length so the
                // model can see exactly what the file contains at this location.
                const blockEnd = Math.min(i + oldLineCount, lines.length);
                const blockLines = lines
                    .slice(i, blockEnd)
                    .map((l, j) => `  line ${i + j + 1}: ${l}`);
                matches.push(blockLines.join('\n'));
            } else {
                matches.push(`  line ${i + 1}: ${lines[i]}`);
            }
            if (matches.length >= 3) break;
        }
    }

    if (matches.length === 0) return '';
    const sep = oldLineCount > 1 ? '\n---\n' : '\n';
    return `\nClosest match(es) in ${path.basename(filePath)}:\n${matches.join(sep)}`;
}

/**
 * Attempt to find `oldString` in `content` using trailing-whitespace-insensitive
 * line matching.
 *
 * Uses indexOf on the trimEnd-normalized content to find the exact line
 * boundary, which correctly handles cases where old_string begins with empty
 * lines (the original findIndex-based approach would anchor on the wrong line
 * when there are leading blank lines in old_string).
 *
 * Returns the *actual* substring from `content` (preserving the file's real
 * leading indentation and trailing whitespace characters) so it can be used
 * directly in String.prototype.replace(), or null when no match is found.
 *
 * @param {string} content   - normalized (LF) file content
 * @param {string} oldString - normalized (LF) old_string from the edit
 * @returns {string|null}
 */
export function tryWhitespaceNormalizedMatch(content, oldString) {
    const trimEndLines = (s) => s.split('\n').map(l => l.trimEnd()).join('\n');
    const normContent = trimEndLines(content);
    const normOld     = trimEndLines(oldString);

    const pos = normContent.indexOf(normOld);
    if (pos === -1) return null;

    // The match must start at a line boundary (beginning of string or after '\n')
    if (pos > 0 && normContent[pos - 1] !== '\n') return null;

    // Determine the 0-based starting line number in the (normalised) content
    const startLine    = normContent.slice(0, pos).split('\n').length - 1;
    const oldLineCount = oldString.split('\n').length;

    const lines          = content.split('\n');
    const candidateLines = lines.slice(startLine, startLine + oldLineCount);
    if (candidateLines.length < oldLineCount) return null;

    return candidateLines.join('\n');
}

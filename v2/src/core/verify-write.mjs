/**
 * Verify Write Helper — reads a file back after a Write/Edit and diffs it
 * against the expected content.  Called by the agent loop after every
 * successful Write, Edit, or MultiEdit tool call.
 *
 * Returns { match: boolean, diff: string|null }.
 * The caller is responsible for yielding a warning event when match === false.
 */
import fs from 'fs';

/**
 * Produce a compact, human-readable unified diff of up to 10 differing lines.
 * Convention: lines prefixed with '-' are from `expected` (what was written),
 * lines prefixed with '+' are from `actual` (what is on disk).
 * @param {string[]} expected - lines of expected content (what was written)
 * @param {string[]} actual   - lines of actual content on disk
 * @returns {string}
 */
function produceDiff(expected, actual) {
    const lines = [];
    const maxLines = Math.max(expected.length, actual.length);
    let diffCount = 0;
    for (let i = 0; i < maxLines && diffCount < 10; i++) {
        const e = expected[i];
        const a = actual[i];
        if (e !== a) {
            diffCount++;
            if (e !== undefined) lines.push(`- (expected) ${e}`);
            if (a !== undefined) lines.push(`+ (on disk)  ${a}`);
        }
    }
    if (diffCount >= 10) lines.push('... (more differences truncated)');
    return lines.join('\n');
}

/**
 * Verify that a file on disk matches the content that was intended to be written.
 *
 * @param {string} filePath       - absolute path to the file
 * @param {string} expectedContent - the exact content that was passed to Write
 * @returns {{ match: boolean, diff: string|null }}
 */
export function verifyWrite(filePath, expectedContent) {
    let actual;
    try {
        actual = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return { match: false, diff: `Cannot read file after write: ${e.message}` };
    }

    if (actual === expectedContent) {
        return { match: true, diff: null };
    }

    const diff = produceDiff(expectedContent.split('\n'), actual.split('\n'));
    return { match: false, diff };
}

/**
 * Verify that an Edit or MultiEdit was applied correctly by checking that
 * `new_string` is present in the file and `old_string` is no longer there
 * (unless replace_all was used, in which case we only check new_string).
 *
 * @param {string} filePath  - absolute path to the file
 * @param {string} oldString - the text that was replaced
 * @param {string} newString - the text that replaced it
 * @returns {{ match: boolean, message: string|null }}
 */
export function verifyEdit(filePath, oldString, newString) {
    let actual;
    try {
        actual = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return { match: false, message: `Cannot read file after edit: ${e.message}` };
    }

    // new_string must be present after the edit
    if (!actual.includes(newString)) {
        return {
            match: false,
            message: `Edit verification failed for ${filePath}: new_string not found in file after edit.`,
        };
    }

    // old_string should no longer appear (it was replaced).
    // Skip this check when old_string === '' (insert-only edits) or when
    // new_string happens to contain old_string (legitimate partial updates).
    if (oldString && !newString.includes(oldString) && actual.includes(oldString)) {
        return {
            match: false,
            message: `Edit verification warning for ${filePath}: old_string still found in file after edit — the replacement may have been incomplete.`,
        };
    }

    return { match: true, message: null };
}

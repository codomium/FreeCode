/**
 * Write Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - Creates parent directories if needed
 * - Requires Read first for existing file overwrites
 * - No README creation unless explicitly asked
 */
import fs from 'fs';
import path from 'path';
import { hasBeenRead, markRead, invalidateCache } from './read.mjs';
import { WriteTransaction } from '../core/write-transaction.mjs';

const MAX_WRITE_PREVIEW = 300;

function formatWriteSuccess(filePath, content) {
    const lineCount = content.split('\n').length;
    const preview = content.length > MAX_WRITE_PREVIEW
        ? `${content.slice(0, MAX_WRITE_PREVIEW)}...`
        : content;
    return `File written: ${filePath}\nWrote ${lineCount} line(s)\nContent preview:\n${preview}`;
}

export const WriteTool = {
    name: 'Write',
    description: 'Write content to a file. Creates parent dirs if needed.',
    inputSchema: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            content: { type: 'string', description: 'The content to write' },
        },
        required: ['file_path', 'content'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.file_path) errors.push('file_path required');
        return errors;
    },
    async call(input) {
        const filePath = path.resolve(input.file_path);

        // Check if file already exists — require Read first for overwrites
        if (fs.existsSync(filePath)) {
            if (!hasBeenRead(filePath)) {
                return `Error: File ${filePath} already exists. You must Read it first before overwriting.`;
            }
        }

        // Create parent directory if it doesn't exist
        const dir = path.dirname(filePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            return `Error creating directory ${dir}: ${e.message}`;
        }

        try {
            const snapshotId = WriteTransaction.begin([filePath]);
            try {
                fs.writeFileSync(filePath, input.content);
                WriteTransaction.commit(snapshotId);
            } catch (e) {
                WriteTransaction.rollback(snapshotId);
                throw e;
            }
            invalidateCache(filePath); // E2: clear stale cached Read output
            markRead(filePath); // Mark as read after writing
            return formatWriteSuccess(filePath, input.content);
        } catch (e) {
            return `Error writing file: ${e.message}`;
        }
    },
};

/**
 * ReadMany Tool — read multiple files in one round-trip to reduce tool-call churn.
 */
import { ReadTool } from './read.mjs';

const MAX_FILES = 20; // E6: cap to prevent accidental overloads

export const ReadManyTool = {
    name: 'ReadMany',
    description: 'Read multiple files in a single call. PREFER this over multiple sequential Read calls when you need to read 2 or more files. Returns each file\'s content in clearly demarcated blocks.',
    inputSchema: {
        type: 'object',
        properties: {
            file_paths: {
                type: 'array',
                items: { type: 'string' },
                description: `Array of absolute file paths to read (max ${MAX_FILES})`,
            },
            limit: {
                type: 'number',
                description: 'Max lines per file (default 2000)',
                default: 2000,
            },
        },
        required: ['file_paths'],
    },
    validateInput(input) {
        const errors = [];
        if (!Array.isArray(input.file_paths) || input.file_paths.length === 0) {
            errors.push('file_paths must be a non-empty array');
        } else if (input.file_paths.length > MAX_FILES) {
            // E6: enforce cap — model should split into batches for large sets
            errors.push(`file_paths exceeds the maximum of ${MAX_FILES} files per call. Split into multiple ReadMany calls.`);
        }
        return errors;
    },
    async call(input) {
        // E7: read all files in parallel instead of sequentially
        const entries = await Promise.all(
            input.file_paths.map(async (filePath) => {
                const content = await ReadTool.call({
                    file_path: filePath,
                    limit: input.limit ?? 2000,
                });
                return [filePath, content];
            })
        );
        return entries
            .map(([p, content]) => `=== ${p} ===\n${content}`)
            .join('\n\n');
    },
};

/**
 * ReadMany Tool — read multiple files in one round-trip to reduce tool-call churn.
 */
import { ReadTool } from './read.mjs';

export const ReadManyTool = {
    name: 'ReadMany',
    description: 'Read multiple files in a single call. Returns path-scoped blocks for each file.',
    inputSchema: {
        type: 'object',
        properties: {
            file_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of absolute file paths to read',
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
        }
        return errors;
    },
    async call(input) {
        const results = {};
        for (const filePath of input.file_paths) {
            results[filePath] = await ReadTool.call({
                file_path: filePath,
                limit: input.limit || 2000,
            });
        }
        return Object.entries(results)
            .map(([p, content]) => `=== ${p} ===\n${content}`)
            .join('\n\n');
    },
};

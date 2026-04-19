/**
 * Grep Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - Case insensitive (-i)
 * - Line numbers (-n, default true for content mode)
 * - Context lines (-A, -B, -C)
 * - output_mode: content, files_with_matches, count
 * - glob filter and type filter
 * - head_limit (default 250)
 * - multiline mode
 * - Windows support: uses 'where' for rg detection, avoids bash pipelines
 */
import { spawnSync } from 'child_process';
import path from 'path';

const IS_WINDOWS = process.platform === 'win32';

export const GrepTool = {
    name: 'Grep',
    description: 'Search file contents with regex (powered by ripgrep or grep).',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            path: { type: 'string', description: 'File or directory to search in' },
            '-i': { type: 'boolean', description: 'Case insensitive' },
            '-n': { type: 'boolean', description: 'Show line numbers (default true)' },
            '-A': { type: 'number', description: 'Lines after match' },
            '-B': { type: 'number', description: 'Lines before match' },
            '-C': { type: 'number', description: 'Context lines (before and after)' },
            context: { type: 'number', description: 'Alias for -C' },
            output_mode: {
                type: 'string',
                enum: ['content', 'files_with_matches', 'count'],
                description: 'Output mode (default: files_with_matches)',
            },
            glob: { type: 'string', description: 'Glob pattern to filter files' },
            type: { type: 'string', description: 'File type filter (e.g. js, py)' },
            head_limit: { type: 'number', description: 'Max output lines (default 250)' },
            multiline: { type: 'boolean', description: 'Enable multiline matching' },
        },
        required: ['pattern'],
    },
    validateInput(input) { return input.pattern ? [] : ['pattern required']; },
    async call(input) {
        try {
            const dir = path.resolve(input.path || '.');
            const mode = input.output_mode || 'files_with_matches';
            const limit = input.head_limit ?? 250;

            // Build grep args array — use rg first, fall back to grep
            const args = [];
            const useRg = hasRipgrep();

            if (useRg) {
                if (input['-i']) args.push('-i');
                if (input.multiline) args.push('-U', '--multiline-dotall');

                if (mode === 'files_with_matches') {
                    args.push('-l');
                } else if (mode === 'count') {
                    args.push('-c');
                } else {
                    if (input['-n'] !== false) args.push('-n');
                }

                const ctx = input['-C'] || input.context;
                if (ctx && mode === 'content') args.push('-C', String(ctx));
                if (input['-A'] && mode === 'content') args.push('-A', String(input['-A']));
                if (input['-B'] && mode === 'content') args.push('-B', String(input['-B']));

                if (input.glob) args.push('--glob', input.glob);
                if (input.type) args.push('--type', input.type);

                // '--' separates flags from pattern/path so they can't be misinterpreted
                args.push('--', input.pattern, dir);
            } else {
                args.push('-r');
                if (input['-i']) args.push('-i');

                if (mode === 'files_with_matches') {
                    args.push('-l');
                } else if (mode === 'count') {
                    args.push('-c');
                } else {
                    if (input['-n'] !== false) args.push('-n');
                }

                const ctx = input['-C'] || input.context;
                if (ctx && mode === 'content') args.push('-C', String(ctx));
                if (input['-A'] && mode === 'content') args.push('-A', String(input['-A']));
                if (input['-B'] && mode === 'content') args.push('-B', String(input['-B']));

                if (input.glob) args.push('--include', input.glob);

                args.push('--', input.pattern, dir);
            }

            // Use spawnSync with an argument array to avoid shell injection.
            // Apply head_limit in JS rather than piping through head.
            const exe = useRg ? (IS_WINDOWS ? 'rg.exe' : 'rg') : 'grep';
            const proc = spawnSync(exe, args, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30000,
            });

            // exit code 1 from grep/rg means "no matches" — still return empty
            let output = ((proc.stdout || '') + (proc.status === 0 || proc.status === 1 ? '' : '')).trim();
            if (!output && proc.status !== 0 && proc.status !== 1) {
                return 'No matches found.';
            }

            // Apply head_limit in JS
            if (limit > 0) {
                const lines = output.split('\n');
                if (lines.length > limit) output = lines.slice(0, limit).join('\n');
            }

            return output || 'No matches found.';
        } catch {
            return 'No matches found.';
        }
    },
};

let _hasRg = null;
function hasRipgrep() {
    if (_hasRg !== null) return _hasRg;
    try {
        // 'where' on Windows, 'which' on Unix — use spawnSync to avoid shell injection
        const checkExe = IS_WINDOWS ? 'where' : 'which';
        const result = spawnSync(checkExe, ['rg'], { encoding: 'utf-8', timeout: 5000 });
        _hasRg = result.status === 0;
    } catch {
        _hasRg = false;
    }
    return _hasRg;
}

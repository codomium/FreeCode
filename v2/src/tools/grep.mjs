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
 * - Windows support: uses 'where' for rg detection, avoids bash pipelines;
 *   falls back to a pure-JS implementation when neither rg nor grep is available.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/** Ripgrep executable name varies by platform. */
const RG_EXE = IS_WINDOWS ? 'rg.exe' : 'rg';

let _hasRg = null;

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

            // Build grep args array — use rg first, fall back to grep, then pure JS
            const args = [];
            const useRg = hasRipgrep();
            const useNativeGrep = !useRg && hasNativeGrep();

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
            } else if (useNativeGrep) {
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
            } else {
                // No native grep or rg available — use pure-JS implementation.
                // This is the common case on Windows without WSL or ripgrep.
                return jsGrepFallback(input.pattern, dir, input, limit);
            }

            // Use spawnSync with an argument array to avoid shell injection.
            // Apply head_limit in JS rather than piping through head.
            const exe = useRg ? RG_EXE : 'grep';
            const proc = spawnSync(exe, args, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30000,
            });

            // exit code 1 from grep/rg means "no matches" — still return empty string
            let output = (proc.stdout || '').trim();

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

function hasRipgrep() {
    if (_hasRg !== null) return _hasRg;
    try {
        // 'where' on Windows, 'which' on Unix — check for the platform-correct exe name
        const checkExe = IS_WINDOWS ? 'where' : 'which';
        const result = spawnSync(checkExe, [RG_EXE], { encoding: 'utf-8', timeout: 5000 });
        _hasRg = result.status === 0;
    } catch {
        _hasRg = false;
    }
    return _hasRg;
}

let _hasNativeGrep = null;
/** Check whether the system `grep` binary is available (not available on Windows without WSL/tools). */
function hasNativeGrep() {
    if (_hasNativeGrep !== null) return _hasNativeGrep;
    if (IS_WINDOWS) { _hasNativeGrep = false; return false; }
    try {
        const result = spawnSync('which', ['grep'], { encoding: 'utf-8', timeout: 5000 });
        _hasNativeGrep = result.status === 0;
    } catch {
        _hasNativeGrep = false;
    }
    return _hasNativeGrep;
}

/**
 * Pure-JavaScript grep fallback used when neither ripgrep nor native grep
 * is available (typical on Windows without WSL or Cygwin tools installed).
 * Walks the target path recursively, matching each line against the pattern.
 */
function jsGrepFallback(pattern, searchPath, options, limit) {
    const mode = options.output_mode || 'files_with_matches';
    const caseFlag = options['-i'] ? 'i' : '';
    let regex;
    try {
        regex = new RegExp(pattern, caseFlag);
    } catch {
        return 'No matches found.';
    }

    // Build a glob filter regex if requested
    let globRegex = null;
    if (options.glob) {
        const escaped = options.glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * ?
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        try { globRegex = new RegExp(`^${escaped}$`, 'i'); } catch { /* ignore */ }
    }

    const results = [];

    function matchFile(filePath) {
        if (results.length >= limit) return;
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let matchCount = 0;
            let fileHasMatch = false;
            const contextBefore = Number(options['-B'] || options['-C'] || options.context || 0);
            const contextAfter  = Number(options['-A'] || options['-C'] || options.context || 0);

            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    fileHasMatch = true;
                    matchCount++;
                    if (mode === 'content') {
                        // Emit context-before lines
                        for (let b = Math.max(0, i - contextBefore); b < i; b++) {
                            if (results.length < limit) results.push(`${filePath}:${b + 1}-${lines[b]}`);
                        }
                        if (results.length < limit) results.push(`${filePath}:${i + 1}:${lines[i]}`);
                        // Emit context-after lines
                        for (let a = i + 1; a <= Math.min(lines.length - 1, i + contextAfter); a++) {
                            if (results.length < limit) results.push(`${filePath}:${a + 1}-${lines[a]}`);
                        }
                    }
                    if (results.length >= limit) return;
                }
            }
            if (fileHasMatch) {
                if (mode === 'files_with_matches') results.push(filePath);
                else if (mode === 'count') results.push(`${filePath}:${matchCount}`);
            }
        } catch { /* skip unreadable files */ }
    }

    function walkDir(dirPath, depth) {
        if (results.length >= limit) return;
        if (depth > 50) return; // guard against deep recursion
        let entries;
        try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (results.length >= limit) return;
            if (entry.name.startsWith('.')) continue; // skip hidden files/dirs
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath, depth + 1);
            } else if (entry.isFile()) {
                if (globRegex && !globRegex.test(entry.name)) continue;
                matchFile(fullPath);
            }
        }
    }

    try {
        const stat = fs.statSync(searchPath);
        if (stat.isDirectory()) walkDir(searchPath, 0);
        else matchFile(searchPath);
    } catch { return 'No matches found.'; }

    if (results.length === 0) return 'No matches found.';
    let output = results.join('\n');
    if (results.length >= limit) output += `\n(truncated at ${limit} results)`;
    return output;
}

/**
 * Glob Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - Proper glob matching (not shell find)
 * - Sort by modification time
 * - path parameter for directory scoping
 */
import fs from 'fs';
import path from 'path';

/**
 * Minimal glob implementation without external dependencies.
 * Supports *, **, and ? wildcards.
 */
function globMatch(pattern, str) {
    const regex = globToRegex(pattern);
    return regex.test(str);
}

function globToRegex(pattern) {
    let regex = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                // ** matches everything including /
                regex += '.*';
                i += 2;
                if (pattern[i] === '/') i++; // skip trailing /
                continue;
            }
            regex += '[^/]*';
        } else if (ch === '?') {
            regex += '[^/]';
        } else if (ch === '.') {
            regex += '\\.';
        } else if (ch === '{') {
            regex += '(';
        } else if (ch === '}') {
            regex += ')';
        } else if (ch === ',') {
            regex += '|';
        } else {
            regex += ch;
        }
        i++;
    }
    return new RegExp('^' + regex + '$');
}

/** Directories that are always excluded when walking for glob matches. */
const GLOB_EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.cache', 'coverage', '.nyc_output', '.turbo',
    '.venv', 'venv', '.tox', 'vendor', 'target', '.gradle',
]);

function walkDir(dir, maxDepth = 20, depth = 0) {
    const results = [];
    if (depth > maxDepth) return results;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            // Skip excluded directories and hidden dirs below root
            if (GLOB_EXCLUDE_DIRS.has(entry.name)) continue;
            if (entry.name.startsWith('.') && depth > 0) continue;

            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...walkDir(full, maxDepth, depth + 1));
            } else {
                results.push(full);
            }
        }
    } catch {
        // Permission denied or other error
    }
    return results;
}

export const GlobTool = {
    name: 'Glob',
    description: 'Find files matching a glob pattern, sorted by modification time.',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.js")' },
            path: { type: 'string', description: 'Directory to search in' },
        },
        required: ['pattern'],
    },
    validateInput(input) { return input.pattern ? [] : ['pattern required']; },
    async call(input) {
        try {
            const baseDir = path.resolve(input.path || '.');
            if (!fs.existsSync(baseDir)) {
                return `Error: Directory not found: ${baseDir}`;
            }

            const allFiles = walkDir(baseDir);

            // Match against pattern
            const matches = allFiles.filter(f => {
                const rel = path.relative(baseDir, f);
                return globMatch(input.pattern, rel) || globMatch(input.pattern, path.basename(f));
            });

            if (matches.length === 0) return 'No matches found.';

            // Sort by modification time (newest first)
            matches.sort((a, b) => {
                try {
                    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
                } catch { return 0; }
            });

            return matches.join('\n');
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },
};

/**
 * LSP Tool — Language Server Protocol integration stub.
 *
 * Provides a tool interface for language server features:
 * - diagnostics (errors/warnings)
 * - completions
 * - hover information
 * - go-to-definition
 * - references
 *
 * This is a stub implementation. Full LSP would spawn an actual language
 * server process and communicate via JSON-RPC.
 */

import { spawnSync } from 'child_process';
import path from 'path';

const IS_WINDOWS = process.platform === 'win32';

export const LspTool = {
    name: 'LSP',
    description: 'Query language server for diagnostics, completions, hover, definitions, references, rename, code actions, formatting, and workspace symbols.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: [
                    'diagnostics', 'completions', 'hover', 'definition', 'references',
                    'rename', 'codeAction', 'formatting', 'workspaceSymbol',
                ],
                description: 'LSP action to perform',
            },
            file: {
                type: 'string',
                description: 'File path to query',
            },
            line: {
                type: 'number',
                description: 'Line number (0-based)',
            },
            character: {
                type: 'number',
                description: 'Character position (0-based)',
            },
            language: {
                type: 'string',
                description: 'Language ID (e.g., "typescript", "python")',
            },
            newName: {
                type: 'string',
                description: 'New name for rename operation',
            },
            query: {
                type: 'string',
                description: 'Symbol query for workspaceSymbol',
            },
        },
        required: ['action', 'file'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.action) errors.push('action is required');
        if (!input.file) errors.push('file is required');
        return errors;
    },

    async call(input) {
        const filePath = path.resolve(input.file);
        const action = input.action;

        switch (action) {
            case 'diagnostics':
                return getDiagnostics(filePath, input.language);
            case 'completions':
                return `[LSP stub] Completions at ${filePath}:${input.line}:${input.character} not yet implemented.`;
            case 'hover':
                return `[LSP stub] Hover at ${filePath}:${input.line}:${input.character} not yet implemented.`;
            case 'definition':
                return `[LSP stub] Go-to-definition at ${filePath}:${input.line}:${input.character} not yet implemented.`;
            case 'references':
                return getReferencesFallback(filePath, input.line || 0, input.character || 0);
            case 'rename':
                return `[LSP] rename: use the Refactor tool with operation='rename' for full rename support. Symbol at ${filePath}:${input.line}:${input.character}, newName=${input.newName}`;
            case 'codeAction':
                return getCodeActions(filePath, input.line || 0);
            case 'formatting':
                return formatFile(filePath, input.language);
            case 'workspaceSymbol':
                return searchWorkspaceSymbols(filePath, input.query || '');
            default:
                return `Unknown LSP action: ${action}`;
        }
    },
};

function getDiagnostics(filePath, language) {
    const ext = path.extname(filePath);
    const lang = language || extToLanguage(ext);

    try {
        switch (lang) {
            case 'typescript':
            case 'javascript': {
                // Use spawnSync with an argument array — avoids shell injection and
                // works on Windows (no `2>&1 || true` POSIX syntax needed).
                const result = spawnSync(
                    'npx', ['tsc', '--noEmit', '--pretty', 'false', filePath],
                    { encoding: 'utf-8', timeout: 15000 }
                );
                return ((result.stdout || '') + (result.stderr || '')).trim() || 'No diagnostics.';
            }
            case 'python': {
                // Use `python` on Windows, `python3` on Unix
                const pythonExe = IS_WINDOWS ? 'python' : 'python3';
                const result = spawnSync(
                    pythonExe, ['-m', 'py_compile', filePath],
                    { encoding: 'utf-8', timeout: 10000 }
                );
                return (result.stderr || '').trim() || 'No diagnostics.';
            }
            default:
                return `[LSP stub] No diagnostic provider for language: ${lang}`;
        }
    } catch (err) {
        return `Diagnostics error: ${err.message}`;
    }
}

function extToLanguage(ext) {
    const map = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
        '.py': 'python',
        '.rs': 'rust', '.go': 'go', '.java': 'java',
        '.rb': 'ruby', '.php': 'php', '.cs': 'csharp',
    };
    return map[ext] || 'unknown';
}

// ── v5.0-A: New LSP actions ────────────────────────────────────────────────────

import fs from 'fs';

/**
 * Find references via grep-based fallback.
 * @param {string} filePath
 * @param {number} line
 * @param {number} character
 * @returns {string}
 */
function getReferencesFallback(filePath, line, character) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines   = content.split('\n');
        const targetLine = lines[line] || '';
        // Extract the word at the given position
        const before = targetLine.slice(0, character);
        const after  = targetLine.slice(character);
        const wordBefore = before.match(/(\w+)$/)?.[1] || '';
        const wordAfter  = after.match(/^(\w+)/)?.[1]  || '';
        const symbol = wordBefore + wordAfter;
        if (!symbol) return `No symbol found at ${filePath}:${line}:${character}`;

        // Find all lines containing the symbol
        const refs = [];
        for (let i = 0; i < lines.length; i++) {
            if (new RegExp(`\\b${symbol}\\b`).test(lines[i])) {
                refs.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
            }
        }
        return refs.length > 0
            ? `References to '${symbol}':\n${refs.join('\n')}`
            : `No references found for '${symbol}'`;
    } catch (err) {
        return `Error finding references: ${err.message}`;
    }
}

/**
 * Provide code actions (quick fixes) for a given line.
 * @param {string} filePath
 * @param {number} line
 * @returns {string}
 */
function getCodeActions(filePath, line) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines   = content.split('\n');
        const targetLine = lines[line] || '';
        const suggestions = [];

        if (/var\s+\w+/.test(targetLine)) suggestions.push('Convert var to const/let');
        if (/\bfunction\b/.test(targetLine)) suggestions.push('Convert to arrow function');
        if (/console\.log/.test(targetLine)) suggestions.push('Remove console.log statement');
        if (/==(?!=)/.test(targetLine)) suggestions.push('Convert == to ===');
        if (/!=(?!=)/.test(targetLine)) suggestions.push('Convert != to !==');

        if (suggestions.length === 0) return `No code actions available at line ${line}`;
        return `Code actions at ${filePath}:${line}:\n${suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
    } catch (err) {
        return `Error getting code actions: ${err.message}`;
    }
}

/**
 * Format a file using available formatters.
 * @param {string} filePath
 * @param {string} [language]
 * @returns {string}
 */
function formatFile(filePath, language) {
    const ext  = path.extname(filePath);
    const lang = language || extToLanguage(ext);

    // Try Prettier for JS/TS
    if (['javascript', 'typescript'].includes(lang)) {
        const result = spawnSync(
            'npx', ['prettier', '--write', filePath],
            { encoding: 'utf-8', timeout: 15000 }
        );
        if (result.status === 0) return `Formatted ${filePath} with Prettier`;
    }

    // Try Black for Python
    if (lang === 'python') {
        const result = spawnSync('black', [filePath], { encoding: 'utf-8', timeout: 15000 });
        if (result.status === 0) return `Formatted ${filePath} with Black`;
    }

    return `[LSP] No formatter available for ${lang}. Install Prettier (JS/TS) or Black (Python).`;
}

/**
 * Search for symbols in the workspace directory.
 * @param {string} filePath - used to determine workspace root
 * @param {string} query
 * @returns {string}
 */
function searchWorkspaceSymbols(filePath, query) {
    if (!query) return 'Query required for workspaceSymbol';
    const workspaceDir = path.dirname(filePath);
    const re = new RegExp(`(?:function|class|const|let|var|def|export)\\s+(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'g');

    try {
        const results = [];
        const walk = (dir, depth = 0) => {
            if (depth > 3 || results.length > 50) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full, depth + 1); continue; }
                const ext = entry.name.split('.').pop() || '';
                if (!['js', 'ts', 'jsx', 'tsx', 'mjs', 'py'].includes(ext)) continue;
                try {
                    const content = fs.readFileSync(full, 'utf-8');
                    let m;
                    while ((m = re.exec(content)) !== null) {
                        const line = content.slice(0, m.index).split('\n').length;
                        results.push(`${full}:${line}: ${m[0]}`);
                    }
                } catch { /* skip */ }
            }
        };
        walk(workspaceDir);
        return results.length > 0
            ? `Workspace symbols matching '${query}':\n${results.join('\n')}`
            : `No symbols found matching '${query}'`;
    } catch (err) {
        return `Error searching symbols: ${err.message}`;
    }
}

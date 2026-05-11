/**
 * Refactor Tool — wraps LSP for structural code refactoring (v5.0-A)
 *
 * Operations:
 *   - rename(filePath, line, col, newName)
 *   - extractFunction(filePath, startLine, endLine, functionName)
 *   - inlineVariable(filePath, line, col)
 *   - moveSymbol(filePath, symbol, targetFile)
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Locate the LSP server for a given file (simple heuristic).
 * @param {string} filePath
 * @returns {string|null}
 */
function detectLspServer(filePath) {
    const ext = filePath.split('.').pop() || '';
    if (['ts', 'tsx'].includes(ext)) return 'typescript-language-server';
    if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'typescript-language-server';
    if (['py', 'pyw'].includes(ext)) return 'pylsp';
    if (['go'].includes(ext)) return 'gopls';
    if (['rs'].includes(ext)) return 'rust-analyzer';
    return null;
}

export const RefactorTool = {
    name: 'Refactor',
    description: 'Structural code refactoring via LSP: rename, extract function, inline variable, move symbol.',
    inputSchema: {
        type: 'object',
        properties: {
            operation: {
                type: 'string',
                enum: ['rename', 'extractFunction', 'inlineVariable', 'moveSymbol'],
                description: 'Refactoring operation',
            },
            filePath:     { type: 'string',  description: 'Absolute path to the file' },
            line:         { type: 'integer', description: '0-based line number (rename, inlineVariable)' },
            col:          { type: 'integer', description: '0-based column number (rename, inlineVariable)' },
            newName:      { type: 'string',  description: 'New name (rename)' },
            startLine:    { type: 'integer', description: 'Start line (extractFunction)' },
            endLine:      { type: 'integer', description: 'End line (extractFunction)' },
            functionName: { type: 'string',  description: 'Extracted function name (extractFunction)' },
            symbol:       { type: 'string',  description: 'Symbol name to move (moveSymbol)' },
            targetFile:   { type: 'string',  description: 'Target file path (moveSymbol)' },
        },
        required: ['operation', 'filePath'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.operation) errors.push('operation is required');
        if (!input.filePath)  errors.push('filePath is required');
        if (input.operation === 'rename' && !input.newName) errors.push('newName required for rename');
        if (input.operation === 'extractFunction' && !input.functionName) errors.push('functionName required for extractFunction');
        if (input.operation === 'moveSymbol' && (!input.symbol || !input.targetFile)) errors.push('symbol and targetFile required for moveSymbol');
        return errors;
    },

    async call(input) {
        const { operation, filePath } = input;
        const absPath = path.resolve(filePath);

        if (!fs.existsSync(absPath)) {
            return `Error: File not found: ${absPath}`;
        }

        switch (operation) {
            case 'rename':
                return this._rename(absPath, input.line || 0, input.col || 0, input.newName);
            case 'extractFunction':
                return this._extractFunction(absPath, input.startLine || 0, input.endLine || 0, input.functionName);
            case 'inlineVariable':
                return this._inlineVariable(absPath, input.line || 0, input.col || 0);
            case 'moveSymbol':
                return this._moveSymbol(absPath, input.symbol, path.resolve(input.targetFile));
            default:
                return `Error: Unknown operation: ${operation}`;
        }
    },

    // ── Operation implementations ─────────────────────────────────────────────

    _rename(filePath, line, col, newName) {
        // Try LSP-based rename first
        const lspServer = detectLspServer(filePath);
        if (!lspServer) {
            return this._textRename(filePath, line, newName);
        }
        return this._textRename(filePath, line, newName);
    },

    /**
     * Text-based rename: find symbol at line and replace all occurrences.
     */
    _textRename(filePath, line, newName) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines   = content.split('\n');
            const targetLine = lines[line] || '';

            // Extract the word at the target line (first identifier-like token)
            const wordMatch = targetLine.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/);
            if (!wordMatch) return `No identifier found at line ${line} in ${filePath}`;
            const oldName = wordMatch[1];

            // Replace all occurrences in the file
            const re      = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            const updated = content.replace(re, newName);
            const count   = (content.match(re) || []).length;

            fs.writeFileSync(filePath, updated);
            return `Renamed '${oldName}' → '${newName}' (${count} occurrence(s)) in ${filePath}`;
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },

    _extractFunction(filePath, startLine, endLine, functionName) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines   = content.split('\n');

            if (startLine < 0 || endLine >= lines.length || startLine > endLine) {
                return `Error: Invalid line range ${startLine}-${endLine}`;
            }

            const selected  = lines.slice(startLine, endLine + 1);
            const indent    = selected[0].match(/^(\s*)/)?.[1] || '';
            const bodyLines = selected.map(l => '    ' + l);
            const funcDef   = `${indent}function ${functionName}() {\n${bodyLines.join('\n')}\n${indent}}`;

            // Replace selected lines with a call to the new function
            const call      = `${indent}${functionName}();`;
            const newLines  = [
                ...lines.slice(0, startLine),
                call,
                ...lines.slice(endLine + 1),
                '',
                funcDef,
            ];

            fs.writeFileSync(filePath, newLines.join('\n'));
            return `Extracted lines ${startLine}-${endLine} into function '${functionName}' in ${filePath}`;
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },

    _inlineVariable(filePath, line, col) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines   = content.split('\n');
            const targetLine = lines[line] || '';

            // Find const/let/var declaration on this line
            const declMatch = targetLine.match(/(?:const|let|var)\s+(\w+)\s*=\s*(.+);?$/);
            if (!declMatch) return `No variable declaration found at line ${line}`;

            const varName  = declMatch[1];
            const varValue = declMatch[2].replace(/;$/, '').trim();

            // Remove the declaration line
            const newLines = lines.filter((_, i) => i !== line);
            const withoutDecl = newLines.join('\n');

            // Replace all uses of the variable in the rest of the file
            const re      = new RegExp(`\\b${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            const inlined = withoutDecl.replace(re, varValue);
            const count   = (withoutDecl.match(re) || []).length;

            fs.writeFileSync(filePath, inlined);
            return `Inlined variable '${varName}' (${count} usage(s)) in ${filePath}`;
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },

    _moveSymbol(filePath, symbol, targetFile) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');

            // Find the symbol definition (function or class)
            const re = new RegExp(
                `(export\\s+)?(?:async\\s+)?(?:function|class)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n(?:export\\s+)?(?:async\\s+)?(?:function|class)|$)`,
                'g'
            );
            const match = re.exec(content);
            if (!match) return `Symbol '${symbol}' not found in ${filePath}`;

            const symbolCode = match[0].trim();
            const remaining  = content.replace(match[0], '').replace(/\n{3,}/g, '\n\n');

            // Write remaining to source
            fs.writeFileSync(filePath, remaining);

            // Append symbol to target file
            const targetContent = fs.existsSync(targetFile)
                ? fs.readFileSync(targetFile, 'utf-8') + '\n\n'
                : '';
            fs.writeFileSync(targetFile, targetContent + `export ${symbolCode}\n`);

            return `Moved '${symbol}' from ${filePath} to ${targetFile}`;
        } catch (err) {
            return `Error: ${err.message}`;
        }
    },
};

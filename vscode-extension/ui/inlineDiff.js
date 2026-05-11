'use strict';
/**
 * inlineDiff.js — InlineDiffManager
 *
 * Manages inline diff display using VS Code's built-in diff editor.
 * Supports accept (write modified content) and reject (restore original).
 *
 * Usage:
 *   const { InlineDiffManager } = require('./inlineDiff');
 *   const mgr = new InlineDiffManager();
 *   await mgr.showDiff(original, modified, '/path/to/file.js');
 *   await mgr.accept();  // or mgr.reject()
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

class InlineDiffManager {
    constructor() {
        /** @type {{ original:string, filePath:string }|null} */
        this._pending = null;
    }

    /**
     * Open VS Code's diff editor comparing original ↔ modified content.
     * @param {string} original   Current file content
     * @param {string} modified   Proposed modified content
     * @param {string} filePath   Absolute path to the target file
     */
    async showDiff(original, modified, filePath) {
        const tmpDir  = require('os').tmpdir();
        const baseName = path.basename(filePath);
        const origUri = vscode.Uri.file(path.join(tmpDir, `freecode-orig-${baseName}`));
        const modUri  = vscode.Uri.file(path.join(tmpDir, `freecode-mod-${baseName}`));

        // Write temporary files
        const enc = new TextEncoder();
        await vscode.workspace.fs.writeFile(origUri, enc.encode(original));
        await vscode.workspace.fs.writeFile(modUri,  enc.encode(modified));

        this._pending = { original, filePath };

        await vscode.commands.executeCommand(
            'vscode.diff',
            origUri,
            modUri,
            `FreeCode Diff — ${baseName} (accept/reject below)`,
            { preview: true }
        );
    }

    /**
     * Accept the diff: write the modified content to disk.
     */
    async accept() {
        if (!this._pending) return;
        const { filePath } = this._pending;
        this._pending = null;

        // The modified content is in the right side of the diff editor.
        // Read it from the active text editor if open, otherwise no-op.
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.fsPath.includes('freecode-mod-')) {
            const content = editor.document.getText();
            try {
                fs.writeFileSync(filePath, content, 'utf8');
                vscode.window.showInformationMessage(`FreeCode: Changes applied to ${path.basename(filePath)}`);
            } catch (err) {
                vscode.window.showErrorMessage(`FreeCode: Could not write file — ${err.message}`);
            }
        }

        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }

    /**
     * Reject the diff: restore the original content.
     */
    async reject() {
        if (!this._pending) return;
        const { original, filePath } = this._pending;
        this._pending = null;

        try {
            fs.writeFileSync(filePath, original, 'utf8');
        } catch { /* file was not modified externally — no-op */ }

        vscode.window.showInformationMessage(`FreeCode: Changes rejected, original restored.`);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
}

module.exports = { InlineDiffManager };

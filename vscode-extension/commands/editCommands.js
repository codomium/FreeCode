'use strict';
/**
 * editCommands.js — VS Code command handlers for code-editing actions.
 *
 * Extracted from extension.js for modularity.
 *
 * Exported:
 *   registerEditCommands(context, deps) → void
 *
 * Where deps:
 *   { getBridge, viewProvider, logger }
 *
 * Commands registered:
 *   openClaudeCode.applyCode    — paste code into the active editor via input box
 *   openClaudeCode.inlineEdit   — Ctrl+K inline edit with diff preview
 */

const vscode = require('vscode');
const path   = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract fenced code-block content from AI response text. */
function extractCodeBlockText(text) {
    const m = String(text || '').match(/```(?:[\w+-]+)?\n([\s\S]*?)```/);
    return (m ? m[1] : text || '').trim();
}

// ── registerEditCommands ──────────────────────────────────────────────────────

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {object} deps
 * @param {() => object|null} deps.getBridge
 * @param {{ _applyCodeToActiveEditor: (code:string)=>Promise<void> }|null} deps.viewProvider
 * @param {import('../logger').FreeCodeLogger|null} [deps.logger]
 */
function registerEditCommands(context, { getBridge, viewProvider, logger }) {
    // ── Apply Code ────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.applyCode', async () => {
            const code = await vscode.window.showInputBox({
                prompt: 'Paste code to apply to the active editor',
                placeHolder: '// paste code here',
            });
            if (code && viewProvider && typeof viewProvider._applyCodeToActiveEditor === 'function') {
                await viewProvider._applyCodeToActiveEditor(code);
            }
        })
    );

    // ── Inline Edit (Ctrl+K) ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.inlineEdit', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open Claude Code: No active editor for inline edit.');
                return;
            }

            const selection      = editor.selection;
            const selectedText   = editor.document.getText(
                selection.isEmpty ? undefined : selection
            );
            const editInstruction = await vscode.window.showInputBox({
                prompt:      'Inline edit instruction',
                placeHolder: 'e.g., optimize this function and add error handling',
            });
            if (!editInstruction) return;

            let cancelled = false;
            let proposed  = '';

            await vscode.window.withProgress(
                {
                    location:    vscode.ProgressLocation.Notification,
                    title:       'Open Claude Code: generating inline edit…',
                    cancellable: true,
                },
                async (_progress, token) => {
                    token.onCancellationRequested(() => { cancelled = true; });

                    const bridge = getBridge ? await getBridge() : null;
                    if (!bridge) {
                        vscode.window.showErrorMessage('Open Claude Code: bridge not ready.');
                        cancelled = true;
                        return;
                    }

                    const prompt = [
                        'Rewrite the provided code according to the instruction.',
                        'Return only the edited code.',
                        `Instruction: ${editInstruction}`,
                        'Code:',
                        '```',
                        selectedText,
                        '```',
                    ].join('\n');

                    await bridge.run(prompt, (event) => {
                        if (cancelled) return;
                        if (event.type === 'stream_event' && event.text)               proposed += event.text;
                        if (event.type === 'assistant' && event.content && !event._streamed) proposed += event.content;
                    });
                }
            );

            if (cancelled || !proposed.trim()) return;

            const editedCode = extractCodeBlockText(proposed);
            if (!editedCode) return;

            const originalDoc = editor.document;
            const before = selectedText;
            const after  = editedCode;

            const left  = await vscode.workspace.openTextDocument({ content: before, language: originalDoc.languageId });
            const right = await vscode.workspace.openTextDocument({ content: after,  language: originalDoc.languageId });
            await vscode.commands.executeCommand(
                'vscode.diff',
                left.uri,
                right.uri,
                `Inline Edit Diff: ${path.basename(originalDoc.fileName)}`
            );

            const choice = await vscode.window.showInformationMessage(
                'Inline edit ready',
                '✅ Accept',
                '❌ Reject'
            );
            if (choice === '✅ Accept') {
                await editor.edit((eb) => {
                    const range = selection.isEmpty
                        ? new vscode.Range(
                            originalDoc.positionAt(0),
                            originalDoc.positionAt(originalDoc.getText().length)
                          )
                        : selection;
                    eb.replace(range, editedCode);
                });
                logger && logger.info('editCommands', 'Inline edit accepted', {
                    file: path.basename(originalDoc.fileName),
                });
            } else {
                logger && logger.info('editCommands', 'Inline edit rejected');
            }
        })
    );
}

module.exports = { registerEditCommands };

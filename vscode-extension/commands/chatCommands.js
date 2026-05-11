'use strict';
/**
 * chatCommands.js — VS Code command handlers for chat-related actions.
 *
 * Extracted from extension.js for modularity.  All functions return
 * Disposables so the caller (extension.js / activate) can push them
 * onto context.subscriptions.
 *
 * Exported:
 *   registerChatCommands(context, deps) → void
 *
 * Where deps:
 *   { getActiveBridge, resetBridge, viewProvider, logger }
 *
 * Note: `getActiveBridge` is a *synchronous* getter that returns the
 * current bridge instance (or null).  It does NOT create a new bridge.
 * Use the async `getBridge` factory (from extension.js) when you need
 * to ensure a bridge is running before sending a message.
 */

const vscode = require('vscode');

/**
 * Register all chat-related commands.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {object} deps
 * @param {() => object|null} deps.getActiveBridge  Sync getter for the current bridge instance.
 * @param {() => void} deps.resetBridge             Nulls the bridge reference after dispose.
 * @param {{ postMessage: (msg: object) => void }|null} deps.viewProvider
 * @param {import('../logger').FreeCodeLogger|null} [deps.logger]
 */
function registerChatCommands(context, { getActiveBridge, resetBridge, viewProvider, logger }) {
    // ── Set API Key ───────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your API key for Anthropic (sk-ant-...), OpenAI (sk-...) or any other provider',
                password: true,
                placeHolder: 'sk-ant-api03-... or sk-... or nvapi-...',
                validateInput: (v) =>
                    (v && v.trim().length > 10)
                        ? null
                        : 'API key must be at least 10 characters (e.g. sk-ant-..., sk-..., nvapi-...)',
            });
            if (key) {
                await context.secrets.store('openClaudeCode.apiKey', key.trim());
                const bridge = getActiveBridge();
                if (bridge) { bridge.dispose(); }
                resetBridge();
                vscode.window.showInformationMessage('API key saved. Bridge will restart on next message.');
                if (viewProvider) viewProvider.postMessage({ type: 'apiKeySet' });
                logger && logger.info('chatCommands', 'API key updated');
            }
        })
    );

    // ── Clear Session ─────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.clearSession', async () => {
            const bridge = getActiveBridge();
            if (bridge && bridge.isRunning) {
                await bridge.reset();
                if (viewProvider) viewProvider.postMessage({ type: 'sessionCleared' });
                vscode.window.showInformationMessage('Open Claude Code session cleared.');
                logger && logger.info('chatCommands', 'Session cleared');
            } else {
                vscode.window.showInformationMessage('No active session to clear.');
            }
        })
    );

    // ── Show Status ───────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.showStatus', async () => {
            const config         = vscode.workspace.getConfiguration('openClaudeCode');
            const model          = config.get('model') || 'claude-sonnet-4-6';
            const permissionMode = config.get('permissionMode') || 'default';
            const storedKey      = await context.secrets.get('openClaudeCode.apiKey');
            const hasKey         = !!(storedKey || process.env.ANTHROPIC_API_KEY);
            const bridge         = getActiveBridge();
            const status         = (bridge && bridge.isRunning) ? '🟢 running' : '⚪ idle';
            vscode.window.showInformationMessage(
                'Open Claude Code — bridge: ' + status +
                ' | model: ' + model +
                ' | permission: ' + permissionMode +
                ' | API key: ' + (hasKey ? '✅ set' : '❌ missing')
            );
        })
    );

    // ── Open Chat Panel ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.openChat', () => {
            vscode.commands.executeCommand('claudeCode.chatView.focus');
        })
    );
}

module.exports = { registerChatCommands };

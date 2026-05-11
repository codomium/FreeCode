'use strict';
/**
 * activate.js — Thin entry-point that wires together all FreeCode modules.
 *
 * extension.js calls `require('./activate').setupModules(context, deps)` after
 * registering the core webview provider and commands so that additional features
 * (tab autocomplete, incremental indexer watchers, structured logging) are
 * activated without bloating extension.js further.
 *
 * Exported:
 *   setupModules(context, { codeIndexer, viewProvider, logger })
 */

const vscode = require('vscode');
const { TabAutocompleteProvider } = require('./autocomplete');

/**
 * Wire up all additional modules and register them with the VS Code lifecycle.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {{ codeIndexer, viewProvider, logger }} deps
 */
function setupModules(context, { codeIndexer, viewProvider, logger }) {
    const config = vscode.workspace.getConfiguration('openClaudeCode');

    // ── Tab Autocomplete ──────────────────────────────────────────────────────
    if (config.get('enableTabComplete', true)) {
        const provider = new TabAutocompleteProvider(context, logger);
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider(
                { pattern: '**' },
                provider
            )
        );
        context.subscriptions.push({ dispose: () => provider.dispose() });

        logger && logger.info('activate', 'Tab autocomplete registered');
    }

    // ── Toggle Tab Complete command ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.toggleTabComplete', async () => {
            const cfg     = vscode.workspace.getConfiguration('openClaudeCode');
            const current = cfg.get('enableTabComplete', true);
            await cfg.update('enableTabComplete', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `FreeCode tab autocomplete ${!current ? 'enabled' : 'disabled'}.`
            );
        })
    );

    // ── Incremental index watchers ────────────────────────────────────────────
    if (codeIndexer) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{js,mjs,ts,tsx,jsx,py,go,rs,java,cpp,c,cs,rb,swift,kt,php,vue,svelte}'
        );
        watcher.onDidChange((uri) => codeIndexer.onFileChanged(uri));
        watcher.onDidCreate((uri) => codeIndexer.onFileChanged(uri));
        watcher.onDidDelete((uri) => codeIndexer.onFileDeleted(uri));
        context.subscriptions.push(watcher);

        logger && logger.info('activate', 'Incremental file watcher registered');
    }
}

module.exports = { setupModules };

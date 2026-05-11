'use strict';
/**
 * providerCommands.js — VS Code command handlers for AI provider management.
 *
 * Extracted from extension.js for modularity.
 *
 * Exported:
 *   registerProviderCommands(context, deps) → void
 *
 * Where deps:
 *   { getBridgeRef, resetBridge, logger }
 *
 * Note: `getBridgeRef` is a *synchronous* getter that returns the current
 * bridge instance reference (or null).  It does NOT create a new bridge.
 *
 * Commands registered:
 *   openClaudeCode.manageProviders   — CRUD UI for configuring AI providers
 *   openClaudeCode.toggleMultiAgent  — Enable/disable multi-agent mode
 */

const vscode = require('vscode');

// ── Provider presets ──────────────────────────────────────────────────────────

const PROVIDER_PRESETS = [
    ['anthropic',  'Anthropic (Claude)',  'https://api.anthropic.com/v1'],
    ['openai',     'OpenAI',              'https://api.openai.com/v1'],
    ['gemini',     'Google Gemini',       'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['nvidia',     'NVIDIA NIM',          'https://integrate.api.nvidia.com/v1'],
    ['groq',       'Groq',                'https://api.groq.com/openai/v1'],
    ['together',   'Together AI',         'https://api.together.xyz/v1'],
    ['openrouter', 'OpenRouter',          'https://openrouter.ai/api/v1'],
    ['mistral',    'Mistral AI',          'https://api.mistral.ai/v1'],
    ['cohere',     'Cohere',              'https://api.cohere.ai/compatibility/v1'],
    ['deepseek',   'DeepSeek',            'https://api.deepseek.com/v1'],
    ['perplexity', 'Perplexity',          'https://api.perplexity.ai'],
    ['xai',        'xAI (Grok)',          'https://api.x.ai/v1'],
    ['fireworks',  'Fireworks AI',        'https://api.fireworks.ai/inference/v1'],
    ['cerebras',   'Cerebras',            'https://api.cerebras.ai/v1'],
    ['custom',     'Custom',              ''],
];

const MIN_MULTI_AGENT_PROVIDERS = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify that a provider's /models endpoint is reachable.
 * @param {{ baseUrl?: string, apiKey?: string, name?: string, id?: string }} provider
 */
async function testProviderConnection(provider) {
    const url     = String(provider.baseUrl || '').replace(/\/+$/, '') + '/models';
    const headers = { Authorization: `Bearer ${provider.apiKey || ''}` };
    const res     = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
        const label = provider?.name || provider?.id || 'Unknown provider';
        throw new Error(`HTTP ${res.status} ${res.statusText} when testing ${label}`);
    }
    return true;
}

// ── registerProviderCommands ──────────────────────────────────────────────────

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {object} deps
 * @param {() => object|null} deps.getBridgeRef     Sync getter for the current bridge instance reference.
 * @param {() => void} deps.resetBridge             Nulls the bridge reference after dispose.
 * @param {import('../logger').FreeCodeLogger|null} [deps.logger]
 */
function registerProviderCommands(context, { getBridgeRef, resetBridge, logger }) {
    // ── Manage Providers ──────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.manageProviders', async () => {
            const key = 'openClaudeCode.providers';
            let providers = context.globalState.get(key, []);

            while (true) {
                const choice = await vscode.window.showQuickPick(
                    ['Add Provider', 'Remove Provider', 'Test Provider', 'Done'],
                    { title: `Providers configured: ${providers.length}` }
                );
                if (!choice || choice === 'Done') break;

                if (choice === 'Add Provider') {
                    const preset = await vscode.window.showQuickPick(
                        PROVIDER_PRESETS.map(([id, label, url]) => ({ label, id, url })),
                        { title: 'Select provider preset' }
                    );
                    if (!preset) continue;

                    const apiKey = await vscode.window.showInputBox({
                        prompt:   `${preset.label} API key`,
                        password: true,
                    });
                    if (!apiKey) continue;

                    let baseUrl = preset.url;
                    if (preset.id === 'custom') {
                        baseUrl = await vscode.window.showInputBox({
                            prompt: 'Custom provider base URL (OpenAI-compatible)',
                        }) || '';
                    }

                    const model = await vscode.window.showInputBox({
                        prompt: 'Default model ID for this provider',
                    });
                    if (!model) continue;

                    providers.push({
                        id:      `${preset.id}-${Date.now()}`,
                        name:    preset.label,
                        baseUrl,
                        apiKey,
                        models:  [{ id: model, name: model }],
                        headers: [],
                    });
                    await context.globalState.update(key, providers);
                    logger && logger.info('providerCommands', 'Provider added', { name: preset.label });

                } else if (choice === 'Remove Provider') {
                    if (!providers.length) {
                        vscode.window.showInformationMessage('No providers to remove.');
                        continue;
                    }
                    const pick = await vscode.window.showQuickPick(
                        providers.map((p, i) => ({ label: p.name || p.id, description: p.baseUrl, i }))
                    );
                    if (pick) {
                        const removed = providers[pick.i];
                        providers.splice(pick.i, 1);
                        await context.globalState.update(key, providers);
                        logger && logger.info('providerCommands', 'Provider removed', { name: removed.name || removed.id });
                    }

                } else if (choice === 'Test Provider') {
                    if (!providers.length) {
                        vscode.window.showInformationMessage('No providers to test.');
                        continue;
                    }
                    const pick = await vscode.window.showQuickPick(
                        providers.map((p, i) => ({ label: p.name || p.id, description: p.baseUrl, i }))
                    );
                    if (!pick) continue;
                    try {
                        await testProviderConnection(providers[pick.i]);
                        vscode.window.showInformationMessage(
                            `✅ ${providers[pick.i].name || providers[pick.i].id} connected.`
                        );
                    } catch (err) {
                        vscode.window.showErrorMessage(`❌ Provider test failed: ${err.message}`);
                    }
                }
            }
        })
    );

    // ── Toggle Multi-Agent ────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('openClaudeCode.toggleMultiAgent', async () => {
            const providers = context.globalState.get('openClaudeCode.providers', []);
            if (providers.length < MIN_MULTI_AGENT_PROVIDERS) {
                vscode.window.showErrorMessage(
                    `Configure at least ${MIN_MULTI_AGENT_PROVIDERS} providers in ` +
                    '"Open Claude Code: Manage Providers" before enabling Multi-Agent Mode.'
                );
                return;
            }
            const config = vscode.workspace.getConfiguration('openClaudeCode');
            const next   = !config.get('multiAgentEnabled');
            await config.update('multiAgentEnabled', next, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Multi-Agent Mode ${next ? 'enabled' : 'disabled'}.`);

            const bridge = getBridgeRef();
            if (bridge) { bridge.dispose(); }
            resetBridge();
            logger && logger.info('providerCommands', `Multi-agent mode ${next ? 'on' : 'off'}`);
        })
    );
}

module.exports = { registerProviderCommands, PROVIDER_PRESETS, MIN_MULTI_AGENT_PROVIDERS, testProviderConnection };

'use strict';
/**
 * autocomplete.js — Tab Autocomplete (ghost-text) provider for the FreeCode VS Code extension.
 *
 * Implements vscode.InlineCompletionItemProvider backed by the active AI provider.
 * Matches Cursor's #1 killer feature: ghost-text completions triggered on every keystroke
 * with debouncing, caching, and graceful degradation.
 *
 * Features:
 *   - 300 ms debounce to avoid hammering the API
 *   - Prefix (last 2000 chars) + suffix (next 500 chars) sent to the model
 *   - AbortController cancellation when the user types again
 *   - LRU cache (50 entries) keyed by `${uri}:${offset}:${prefixHash}`
 *   - Works with Anthropic (Messages API) and OpenAI-compatible APIs
 *   - Reads model from `openClaudeCode.autocompleteModel` (falls back to `openClaudeCode.model`)
 *   - Enabled / disabled via `openClaudeCode.enableTabComplete`
 *   - Never throws — returns [] on any error so typing is never blocked
 */

const vscode  = require('vscode');
const crypto  = require('crypto');
const { LRUCache } = require('./cache');

// ── Helpers ──────────────────────────────────────────────────────────────────

function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
}

/** Build the completion prompt sent to the AI. */
function buildPrompt(language, prefix, suffix) {
    return (
        `Complete the following ${language} code. ` +
        `Output ONLY the completion, no explanation, no markdown fences.\n` +
        `PREFIX: ${prefix}\n` +
        `SUFFIX: ${suffix}\n` +
        `COMPLETION:`
    );
}

/** Determine whether a URL looks like Anthropic's API. */
function isAnthropicUrl(url) {
    return /anthropic\.com/i.test(String(url || ''));
}

// ── Provider resolution (mirrors the logic in extension.js) ─────────────────

/**
 * Resolve the base URL, headers, and model for the completion API call.
 * Reads from VS Code configuration; falls back to Anthropic defaults.
 *
 * @param {import('vscode').ExtensionContext} context
 * @returns {{ baseUrl: string, headers: Record<string,string>, model: string, isAnthropic: boolean }}
 */
async function resolveProvider(context) {
    const config = vscode.workspace.getConfiguration('openClaudeCode');
    const mainModel    = config.get('model')            || 'claude-haiku-4-5';
    const acModel      = config.get('autocompleteModel') || mainModel;

    // Check for a configured custom provider that matches the active model
    const providers = (context && context.globalState)
        ? (context.globalState.get('openClaudeCode.providers') || [])
        : [];

    let baseUrl   = 'https://api.anthropic.com';
    let headers   = {};
    let model     = acModel;
    let isAnthropic = true;

    if (providers.length > 0) {
        const prov = providers[0]; // first active provider
        if (prov && prov.baseUrl) {
            baseUrl     = prov.baseUrl;
            isAnthropic = isAnthropicUrl(prov.baseUrl);
            model       = (prov.models && prov.models[0])
                ? (typeof prov.models[0] === 'string' ? prov.models[0] : prov.models[0].id || prov.models[0].name)
                : acModel;
            // Custom headers
            if (Array.isArray(prov.headers)) {
                for (const h of prov.headers) {
                    if (h && h.name) headers[h.name] = h.value || '';
                }
            }
            if (prov.apiKey) {
                headers['Authorization'] = `Bearer ${prov.apiKey}`;
            }
        }
    }

    // Resolve API key
    const storedKey = context
        ? (await context.secrets.get('openClaudeCode.apiKey').catch(() => '')) || ''
        : '';
    const apiKey = storedKey ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY    ||
        '';

    if (isAnthropic) {
        headers['x-api-key']         = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['content-type']      = 'application/json';
    } else {
        if (!headers['Authorization'] && apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        headers['content-type'] = 'application/json';
    }

    // Prefer a fast model for autocomplete if none explicitly configured
    if (!config.get('autocompleteModel')) {
        if (isAnthropic) model = 'claude-haiku-4-5';
    }

    return { baseUrl, headers, model, isAnthropic };
}

// ── Completion request ────────────────────────────────────────────────────────

/**
 * Call the AI API and return the raw completion string, or '' on any error.
 */
async function fetchCompletion({ baseUrl, headers, model, isAnthropic, prompt, signal }) {
    try {
        let url, body;
        if (isAnthropic) {
            url  = baseUrl.replace(/\/+$/, '') + '/v1/messages';
            body = JSON.stringify({
                model,
                max_tokens: 256,
                messages: [{ role: 'user', content: prompt }],
            });
        } else {
            url  = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
            body = JSON.stringify({
                model,
                max_tokens: 256,
                messages: [{ role: 'user', content: prompt }],
            });
        }

        const res = await fetch(url, { method: 'POST', headers, body, signal });
        if (!res.ok) return '';

        const data = await res.json();

        if (isAnthropic) {
            return data?.content?.[0]?.text || '';
        }
        return data?.choices?.[0]?.message?.content || '';
    } catch {
        return '';
    }
}

// ── TabAutocompleteProvider ───────────────────────────────────────────────────

class TabAutocompleteProvider {
    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {import('./logger').FreeCodeLogger} [logger]
     */
    constructor(context, logger) {
        this._context    = context;
        this._logger     = logger || null;
        this._cache      = new LRUCache(50, 120000);  // 50 entries, 120s (2-minute) TTL
        this._debounceTimer = null;
        this._abortCtrl  = null;
    }

    /**
     * Called by VS Code for every cursor movement / keystroke.
     * Returns ghost-text completions.
     * @param {import('vscode').TextDocument} document
     * @param {import('vscode').Position}     position
     * @param {import('vscode').InlineCompletionContext} _ctx
     * @param {import('vscode').CancellationToken}      token
     * @returns {Promise<import('vscode').InlineCompletionList>}
     */
    provideInlineCompletions(document, position, _ctx, token) {
        // Check enabled flag
        const config = vscode.workspace.getConfiguration('openClaudeCode');
        if (!config.get('enableTabComplete', true)) {
            return Promise.resolve({ items: [] });
        }

        // Cancel any in-flight request
        if (this._abortCtrl) {
            this._abortCtrl.abort();
            this._abortCtrl = null;
        }

        return new Promise((resolve) => {
            // Debounce: wait 300 ms before firing
            if (this._debounceTimer) clearTimeout(this._debounceTimer);

            this._debounceTimer = setTimeout(async () => {
                if (token.isCancellationRequested) { resolve({ items: [] }); return; }

                try {
                    const result = await this._complete(document, position, token);
                    resolve(result);
                } catch {
                    resolve({ items: [] });
                }
            }, 300);

            token.onCancellationRequested(() => {
                if (this._debounceTimer) clearTimeout(this._debounceTimer);
                resolve({ items: [] });
            });
        });
    }

    async _complete(document, position, token) {
        const offset    = document.offsetAt(position);
        const fullText  = document.getText();
        const prefix    = fullText.slice(Math.max(0, offset - 2000), offset);
        const suffix    = fullText.slice(offset, Math.min(fullText.length, offset + 500));
        const language  = document.languageId || 'code';
        const cacheKey  = `${document.uri.toString()}:${offset}:${md5(prefix)}`;

        // Cache hit
        const cached = this._cache.get(cacheKey);
        if (cached !== undefined) {
            return this._makeList(position, cached);
        }

        if (token.isCancellationRequested) return { items: [] };

        const prompt = buildPrompt(language, prefix, suffix);

        let providerInfo;
        try {
            providerInfo = await resolveProvider(this._context);
        } catch (err) {
            this._logger && this._logger.error('autocomplete', 'Failed to resolve provider', { error: err.message });
            return { items: [] };
        }

        this._abortCtrl = new AbortController();
        const { signal } = this._abortCtrl;

        // Propagate VS Code cancellation → AbortController
        token.onCancellationRequested(() => this._abortCtrl && this._abortCtrl.abort());

        const completion = await fetchCompletion({ ...providerInfo, prompt, signal });

        if (!completion || token.isCancellationRequested) return { items: [] };

        this._cache.set(cacheKey, completion);

        this._logger && this._logger.debug('autocomplete', 'Completion fetched', {
            model: providerInfo.model,
            chars: completion.length,
        });

        return this._makeList(position, completion);
    }

    _makeList(position, text) {
        if (!text) return { items: [] };
        const item = new vscode.InlineCompletionItem(text);
        item.range = new vscode.Range(position, position);
        return { items: [item] };
    }

    dispose() {
        if (this._abortCtrl) this._abortCtrl.abort();
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
    }
}

module.exports = { TabAutocompleteProvider };

'use strict';
/**
 * providerRegistry.js — Lazy-loading registry for AI provider configurations.
 *
 * Each provider factory returns:
 *   { name, baseUrl, makeHeaders(apiKey), defaultModel }
 *
 * Usage:
 *   const { ProviderRegistry } = require('./providerRegistry');
 *   const reg = new ProviderRegistry();
 *   const prov = reg.get('anthropic');
 *   const headers = prov.makeHeaders(apiKey);
 */

const PROVIDER_DEFS = {
    anthropic: {
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-sonnet-4-6',
        makeHeaders(apiKey) {
            return {
                'x-api-key':         apiKey,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json',
            };
        },
    },
    openai: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com',
        defaultModel: 'gpt-4o',
        makeHeaders(apiKey) {
            return {
                'Authorization': `Bearer ${apiKey}`,
                'content-type':  'application/json',
            };
        },
    },
    gemini: {
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        defaultModel: 'gemini-2.0-flash',
        makeHeaders(apiKey) {
            return {
                'x-goog-api-key': apiKey,
                'content-type':   'application/json',
            };
        },
    },
    nvidia: {
        name: 'NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com',
        defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
        makeHeaders(apiKey) {
            return {
                'Authorization': `Bearer ${apiKey}`,
                'content-type':  'application/json',
            };
        },
    },
    openrouter: {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api',
        defaultModel: 'openai/gpt-4o',
        makeHeaders(apiKey) {
            return {
                'Authorization': `Bearer ${apiKey}`,
                'content-type':  'application/json',
            };
        },
    },
    together: {
        name: 'Together AI',
        baseUrl: 'https://api.together.xyz',
        defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
        makeHeaders(apiKey) {
            return {
                'Authorization': `Bearer ${apiKey}`,
                'content-type':  'application/json',
            };
        },
    },
    groq: {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai',
        defaultModel: 'llama3-70b-8192',
        makeHeaders(apiKey) {
            return {
                'Authorization': `Bearer ${apiKey}`,
                'content-type':  'application/json',
            };
        },
    },
};

class ProviderRegistry {
    constructor() {
        /** @type {Map<string, object>} */
        this._cache = new Map();
    }

    /**
     * Register a custom provider definition.
     * @param {string} id
     * @param {object} factory  Provider definition object
     */
    register(id, factory) {
        this._cache.set(id, factory);
    }

    /**
     * Retrieve a provider by id.  Built-ins are lazily instantiated on first access.
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
        if (this._cache.has(id)) return this._cache.get(id);
        const def = PROVIDER_DEFS[id];
        if (!def) return null;
        this._cache.set(id, def);
        return def;
    }

    /**
     * List all registered provider ids (built-ins + custom).
     * @returns {string[]}
     */
    list() {
        const ids = new Set([...Object.keys(PROVIDER_DEFS), ...this._cache.keys()]);
        return [...ids];
    }

    /**
     * Return the first active provider or the default Anthropic provider.
     * @returns {object}
     */
    getActive() {
        return this.get('anthropic');
    }
}

module.exports = { ProviderRegistry };

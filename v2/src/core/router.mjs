/**
 * Router — per-turn model selection (v4.2-A)
 *
 * Maps TurnType → optimal provider + model combination.
 * The routing table can be overridden per-turn-type and is loaded from
 * ~/.freecode/router.json if present.
 *
 * Default routing table:
 *   planning      → claude-opus-4-5
 *   code_gen      → claude-sonnet-4-5
 *   debugging     → claude-sonnet-4-5
 *   explanation   → claude-haiku-4-5
 *   test_writing  → claude-sonnet-4-5
 *   search        → claude-haiku-4-5
 *   review        → claude-opus-4-5
 *   refactor      → claude-sonnet-4-5
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ROUTER_CONFIG_PATH = path.join(os.homedir(), '.freecode', 'router.json');

/**
 * @typedef {{ provider: string, model: string }} ModelTarget
 * @typedef {Record<string, ModelTarget>} RouteConfig
 */

const DEFAULT_ROUTES = {
    planning:        { provider: 'anthropic', model: 'claude-opus-4-5' },
    code_generation: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    debugging:       { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    explanation:     { provider: 'anthropic', model: 'claude-haiku-4-5' },
    test_writing:    { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    search:          { provider: 'anthropic', model: 'claude-haiku-4-5' },
    review:          { provider: 'anthropic', model: 'claude-opus-4-5' },
    refactor:        { provider: 'anthropic', model: 'claude-sonnet-4-5' },
};

/** Cost estimates in USD per 1 M tokens (input/output) */
const COST_TABLE = {
    'claude-opus-4-5':   { input: 15,  output: 75  },
    'claude-sonnet-4-5': { input: 3,   output: 15  },
    'claude-haiku-4-5':  { input: 0.25, output: 1.25 },
    'gpt-4o':            { input: 5,   output: 15  },
    'gpt-4o-mini':       { input: 0.15, output: 0.6  },
    'gemini-1.5-flash':  { input: 0.075, output: 0.3 },
};

export class Router {
    /**
     * @param {object} [options]
     * @param {RouteConfig} [options.config] - override defaults entirely
     */
    constructor(options = {}) {
        this._routes = { ...DEFAULT_ROUTES };

        // Load from config file if present
        const fileConfig = this._loadFileConfig();
        if (fileConfig) Object.assign(this._routes, fileConfig);

        // Constructor overrides take highest priority
        if (options.config) Object.assign(this._routes, options.config);
    }

    /**
     * Resolve the best provider + model for a given turn type.
     * Falls back to claude-sonnet-4-5 if the turn type is unknown.
     * Filters by available providers if given.
     *
     * @param {string} turnType
     * @param {string[]} [availableProviders] - provider names that are available
     * @returns {ModelTarget}
     */
    resolve(turnType, availableProviders) {
        const target = this._routes[turnType] || this._routes['code_generation'];
        if (!availableProviders || availableProviders.length === 0) return target;

        if (availableProviders.includes(target.provider)) return target;

        // Fallback: first available provider with a sensible default model
        const fallbackProvider = availableProviders[0];
        return { provider: fallbackProvider, model: this._defaultModelFor(fallbackProvider) };
    }

    /**
     * Override the route for a specific turn type.
     * @param {string} turnType
     * @param {string} provider
     * @param {string} model
     */
    override(turnType, provider, model) {
        this._routes[turnType] = { provider, model };
    }

    /**
     * Estimate the USD cost for a turn.
     * @param {string} turnType
     * @param {number} inputTokens
     * @returns {{ inputCost: number, estimatedOutputCost: number, model: string }}
     */
    estimateCost(turnType, inputTokens) {
        const { model } = this.resolve(turnType);
        const rates = COST_TABLE[model] || { input: 5, output: 15 };
        const estimatedOutputTokens = inputTokens * 0.5; // rough 1:0.5 ratio
        return {
            model,
            inputCost:             (inputTokens / 1_000_000) * rates.input,
            estimatedOutputCost:   (estimatedOutputTokens / 1_000_000) * rates.output,
        };
    }

    /**
     * Return all configured routes.
     * @returns {RouteConfig}
     */
    getRoutes() {
        return { ...this._routes };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _loadFileConfig() {
        try {
            const raw = fs.readFileSync(ROUTER_CONFIG_PATH, 'utf-8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    _defaultModelFor(provider) {
        const defaults = {
            anthropic: 'claude-sonnet-4-5',
            openai:    'gpt-4o-mini',
            google:    'gemini-1.5-flash',
        };
        return defaults[provider] || 'claude-sonnet-4-5';
    }
}

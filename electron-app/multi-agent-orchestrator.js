'use strict';

const CODE_BLOCK_BONUS = 500;
const ERROR_PENALTY = 3000;

/**
 * Score a provider result for quality ranking.
 * Higher score = preferred answer.
 * @param {{ text: string }} r
 * @returns {number}
 */
function computeResponseScore(r) {
    const errorPattern = /\b(error:|failed:|exception:|traceback:|cannot|undefined is not)\b/i;
    let s = (r.text || '').length;
    if (errorPattern.test(r.text || '')) s -= ERROR_PENALTY;
    if (/```/.test(r.text || '')) s += CODE_BLOCK_BONUS;
    return s;
}

class MultiAgentOrchestrator {
    constructor({ providers, strategy, createBridge }) {
        this.providers = Array.isArray(providers) ? providers : [];
        this.strategy = strategy || 'parallel';
        this.createBridge = createBridge;
        this._isCancelled = false;
        this._pendingMessages = null;
        /** @type {Map<string, number>} consecutive failure count per provider id */
        this._providerFailures = new Map();
    }

    get isRunning() { return true; }

    cancel() { this._isCancelled = true; }
    reinit() {}
    reset() {
        this._providerFailures.clear();
    }
    switchModel() {}
    resume(messages) { this._pendingMessages = messages; }
    async _init() { return; }

    _activeProviders() {
        return this.providers.filter((p) => {
            if (!p || !p.baseUrl || !p.apiKey || !Array.isArray(p.models) || p.models.length === 0) return false;
            // Circuit-breaker: skip providers with 3+ consecutive failures
            const failures = this._providerFailures.get(p.id || p.name) || 0;
            return failures < 3;
        });
    }

    _normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    _pickBest(results) {
        if (!results.length) return null;
        return results.slice().sort((a, b) => computeResponseScore(b) - computeResponseScore(a))[0];
    }

    /**
     * Run the provider body with a timeout guard.
     * Renames the original _runProvider body to _runProviderInner.
     */
    async _runProvider(provider, prompt, onEvent, timeoutMs = 30000) {
        const key = provider.id || provider.name || 'unknown';
        return new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Provider ${key} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            try {
                const result = await this._runProviderInner(provider, prompt, onEvent);
                clearTimeout(timer);
                // Reset failure count on success
                this._providerFailures.set(key, 0);
                resolve(result);
            } catch (err) {
                clearTimeout(timer);
                // Increment circuit-breaker counter
                const prev = this._providerFailures.get(key) || 0;
                const next = prev + 1;
                this._providerFailures.set(key, next);
                if (next >= 3) {
                    onEvent({ type: 'info', message: `⚡ Provider ${key} circuit-broken after 3 failures` });
                }
                reject(err);
            }
        });
    }

    async _runProviderInner(provider, prompt, onEvent) {
        const modelObj = provider.models?.[0];
        const model = typeof modelObj === 'string' ? modelObj : (modelObj?.id || modelObj?.name || provider.id);
        const bridge = this.createBridge();
        bridge._model = model;
        bridge._pendingMessages = this._pendingMessages;
        let text = '';
        let errored = null;
        await bridge.run(prompt, (event) => {
            if (this._isCancelled) return;
            if (event.type === 'stream_event' && event.text) text += event.text;
            if (event.type === 'assistant' && event.content && !event._streamed) text += event.content;
            if (event.type === 'error') errored = event.message || 'Unknown error';
            onEvent({
                type: 'agentResponse',
                providerName: provider.name || provider.id,
                model,
                eventType: event.type,
                text: event.text || event.content || '',
            });
        });
        if (errored) throw new Error(errored);
        return { providerName: provider.name || provider.id, model, text: text.trim() };
    }

    async run(message, onEvent) {
        this._isCancelled = false;
        const providers = this._activeProviders();
        const MIN_ACTIVE_RUNTIME_PROVIDERS = 2;
        if (providers.length < MIN_ACTIVE_RUNTIME_PROVIDERS) {
            onEvent({ type: 'error', message: 'Multi-Agent mode needs at least 2 active providers at runtime (UI setup still requires 3 configured providers).' });
            onEvent({ type: 'stop', reason: 'error' });
            return;
        }

        // Wall-clock timeout for the entire run: 120 seconds
        const OVERALL_TIMEOUT_MS = 120000;
        let overallTimer = null;
        let timedOut = false;

        const overallTimeoutPromise = new Promise((_, reject) => {
            overallTimer = setTimeout(() => {
                timedOut = true;
                reject(new Error('Multi-agent run exceeded 120 second wall-clock limit'));
            }, OVERALL_TIMEOUT_MS);
        });

        try {
            await Promise.race([
                this._runStrategies(providers, message, onEvent),
                overallTimeoutPromise,
            ]);
        } catch (err) {
            if (timedOut) {
                onEvent({ type: 'error', message: err.message });
            } else {
                onEvent({ type: 'error', message: err.message || 'Multi-agent run failed' });
            }
            onEvent({ type: 'stop', reason: 'error' });
        } finally {
            if (overallTimer) clearTimeout(overallTimer);
        }
    }

    async _runStrategies(providers, message, onEvent) {
        try {
            let results = [];
            if (this.strategy === 'sequential') {
                let rollingPrompt = message;
                for (const p of providers) {
                    const r = await this._runProvider(p, rollingPrompt, onEvent);
                    results.push(r);
                    rollingPrompt += `\n\nPrevious provider (${r.providerName}) output:\n${r.text}`;
                }
            } else if (this.strategy === 'debate') {
                const first = providers[0];
                const second = providers[1];
                const arb = providers[2] || providers[0];
                const [a, b] = await Promise.all([
                    this._runProvider(first, message, onEvent),
                    this._runProvider(second, message, onEvent),
                ]);
                const arbPrompt = `Debate between two approaches:\nA (${a.providerName}):\n${a.text}\n\nB (${b.providerName}):\n${b.text}\n\nArbitrate and provide best final answer.`;
                const c = await this._runProvider(arb, arbPrompt, onEvent);
                results = [a, b, c];
            } else if (this.strategy === 'voting') {
                results = await Promise.all(providers.map((p) => this._runProvider(p, message, onEvent)));
                const buckets = new Map();
                for (const r of results) {
                    const k = this._normalize(r.text);
                    buckets.set(k, (buckets.get(k) || 0) + 1);
                }
                results.sort((a, b) => {
                    const av = buckets.get(this._normalize(a.text)) || 0;
                    const bv = buckets.get(this._normalize(b.text)) || 0;
                    if (bv !== av) return bv - av;
                    return computeResponseScore(b) - computeResponseScore(a);
                });
            } else {
                const settled = await Promise.allSettled(providers.map((p) => this._runProvider(p, message, onEvent)));
                const failed = settled.filter((r) => r.status === 'rejected');
                if (failed.length > 0) {
                    onEvent({ type: 'info', message: `⚠ ${failed.length} provider(s) failed. Continuing with remaining providers.` });
                    for (const r of failed) {
                        onEvent({ type: 'info', message: `Provider failed: ${r.reason?.message || r.reason}` });
                    }
                }
                results = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
            }

            const best = this._pickBest(results.filter((r) => r && r.text));
            if (!best) {
                onEvent({ type: 'error', message: 'All providers failed in multi-agent mode.' });
                onEvent({ type: 'stop', reason: 'error' });
                return;
            }

            onEvent({
                type: 'agentResponse',
                providerName: best.providerName,
                model: best.model,
                bestAnswer: true,
                text: best.text,
            });
            onEvent({ type: 'stream_event', text: best.text });
            onEvent({ type: 'assistant', content: best.text });
            onEvent({ type: 'stop', reason: 'end_turn' });
        } catch (err) {
            throw err;
        }
    }
}

module.exports = { MultiAgentOrchestrator };

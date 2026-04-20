'use strict';

class MultiAgentOrchestrator {
    constructor({ providers, strategy, createBridge }) {
        this.providers = Array.isArray(providers) ? providers : [];
        this.strategy = strategy || 'parallel';
        this.createBridge = createBridge;
        this._isCancelled = false;
        this._pendingMessages = null;
    }

    get isRunning() { return true; }

    cancel() { this._isCancelled = true; }
    reinit() {}
    reset() {}
    switchModel() {}
    resume(messages) { this._pendingMessages = messages; }
    async _init() { return; }

    _activeProviders() {
        return this.providers.filter((p) => p && p.baseUrl && p.apiKey && Array.isArray(p.models) && p.models.length > 0);
    }

    _normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    _pickBest(results) {
        if (!results.length) return null;
        return results.slice().sort((a, b) => (b.text || '').length - (a.text || '').length)[0];
    }

    async _runProvider(provider, prompt, onEvent) {
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
        if (providers.length < 2) {
            onEvent({ type: 'error', message: 'Multi-Agent mode needs at least 2 active providers for fallback.' });
            onEvent({ type: 'stop', reason: 'error' });
            return;
        }
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
                    return (b.text || '').length - (a.text || '').length;
                });
            } else {
                const settled = await Promise.allSettled(providers.map((p) => this._runProvider(p, message, onEvent)));
                const failed = settled.filter((r) => r.status === 'rejected');
                if (failed.length > 0) {
                    onEvent({ type: 'info', message: `⚠ ${failed.length} provider(s) failed. Continuing with remaining providers.` });
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
            onEvent({ type: 'error', message: err.message || 'Multi-agent run failed' });
            onEvent({ type: 'stop', reason: 'error' });
        }
    }
}

module.exports = { MultiAgentOrchestrator };

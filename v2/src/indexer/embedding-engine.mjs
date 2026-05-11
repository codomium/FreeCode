/**
 * EmbeddingEngine — Local embedding provider (v4.1-A)
 *
 * Supports three provider modes:
 *   - 'ollama'            : calls a running Ollama instance
 *   - 'openai-compatible' : calls any OpenAI-compatible /embeddings endpoint
 *   - 'local-tfidf'       : pure JS fallback (TF-IDF cosine; no external deps)
 *
 * The 'local-tfidf' provider is always available and requires no installation.
 * It is the default when no provider is configured.
 */

import crypto from 'crypto';

const DEFAULT_OLLAMA_URL  = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
const DEFAULT_DIMENSIONS   = 768;

export class EmbeddingEngine {
    /**
     * @param {object} [options]
     * @param {'local-tfidf'|'ollama'|'openai-compatible'} [options.provider='local-tfidf']
     * @param {string}  [options.model]
     * @param {number}  [options.dimensions=768]
     * @param {string}  [options.baseUrl]   - base URL for ollama / openai-compatible
     * @param {string}  [options.apiKey]    - API key for openai-compatible
     */
    constructor(options = {}) {
        this.provider   = options.provider   || 'local-tfidf';
        this.model      = options.model      || DEFAULT_OLLAMA_MODEL;
        this.dimensions = options.dimensions || DEFAULT_DIMENSIONS;
        this.baseUrl    = options.baseUrl    || DEFAULT_OLLAMA_URL;
        this.apiKey     = options.apiKey     || null;

        // TF-IDF state (for local-tfidf provider)
        this._tfidf = new TfIdfIndex();
    }

    /**
     * Embed a single text string.
     * @param {string} text
     * @returns {Promise<Float32Array>}
     */
    async embed(text) {
        switch (this.provider) {
            case 'ollama':
                return this._embedOllama(text);
            case 'openai-compatible':
                return this._embedOpenAI(text);
            default:
                return this._embedTfIdf(text);
        }
    }

    /**
     * Embed multiple texts in a batch.
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embedBatch(texts) {
        if (texts.length === 0) return [];
        if (this.provider === 'local-tfidf') {
            return texts.map(t => this._embedTfIdf(t));
        }
        // For remote providers, batch sequentially (most support single requests)
        const results = [];
        for (const text of texts) {
            results.push(await this.embed(text));
        }
        return results;
    }

    // ── Ollama provider ───────────────────────────────────────────────────────

    async _embedOllama(text) {
        let res;
        try {
            res = await fetch(`${this.baseUrl}/api/embeddings`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ model: this.model, prompt: text }),
            });
        } catch {
            // Ollama not available — fall back to TF-IDF
            return this._embedTfIdf(text);
        }
        if (!res.ok) return this._embedTfIdf(text);
        const data = await res.json();
        return Float32Array.from(data.embedding || []);
    }

    // ── OpenAI-compatible provider ────────────────────────────────────────────

    async _embedOpenAI(text) {
        let res;
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
            res = await fetch(`${this.baseUrl}/v1/embeddings`, {
                method:  'POST',
                headers,
                body:    JSON.stringify({ model: this.model, input: text }),
            });
        } catch {
            return this._embedTfIdf(text);
        }
        if (!res.ok) return this._embedTfIdf(text);
        const data = await res.json();
        const embedding = data.data?.[0]?.embedding;
        if (!embedding) return this._embedTfIdf(text);
        return Float32Array.from(embedding);
    }

    // ── Local TF-IDF fallback ─────────────────────────────────────────────────

    /**
     * Build a sparse TF-IDF vector and hash-project it to `dimensions` dimensions.
     * @param {string} text
     * @returns {Float32Array}
     */
    _embedTfIdf(text) {
        const tokens = tokenize(text);
        const tf = computeTF(tokens);
        const idf = this._tfidf.getIdf(tokens);
        const vector = new Float32Array(this.dimensions);

        for (const [term, tfScore] of tf) {
            const idfScore = idf.get(term) ?? 1.0;
            const weight = tfScore * idfScore;
            // Hash the term to a dimension bucket (2 buckets per term for stability)
            const h1 = hashToBucket(term, this.dimensions);
            const h2 = hashToBucket(term + '_', this.dimensions);
            vector[h1] += weight;
            vector[h2] -= weight * 0.5;
        }

        return normalizeL2(vector);
    }

    /**
     * Update the IDF index with a corpus of documents.
     * Call this after indexing a workspace to improve embedding quality.
     * @param {string[]} documents
     */
    updateCorpus(documents) {
        this._tfidf.update(documents);
    }
}

// ── TF-IDF helpers ────────────────────────────────────────────────────────────

class TfIdfIndex {
    constructor() {
        this._df  = new Map(); // term → document frequency
        this._n   = 0;         // total documents
    }

    update(documents) {
        this._n = documents.length;
        this._df.clear();
        for (const doc of documents) {
            const terms = new Set(tokenize(doc));
            for (const term of terms) {
                this._df.set(term, (this._df.get(term) || 0) + 1);
            }
        }
    }

    getIdf(terms) {
        const idf = new Map();
        const n = Math.max(this._n, 1);
        for (const term of new Set(terms)) {
            const df = this._df.get(term) || 0;
            idf.set(term, Math.log((n + 1) / (df + 1)) + 1);
        }
        return idf;
    }
}

function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_$]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && t.length <= 40);
}

function computeTF(tokens) {
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    const total = Math.max(tokens.length, 1);
    const tf = new Map();
    for (const [term, count] of counts) tf.set(term, count / total);
    return tf;
}

function hashToBucket(term, buckets) {
    // Simple djb2-style hash
    let h = 5381;
    for (let i = 0; i < term.length; i++) {
        h = ((h << 5) + h) ^ term.charCodeAt(i);
        h = h >>> 0; // keep unsigned 32-bit
    }
    return h % buckets;
}

function normalizeL2(vec) {
    let sum = 0;
    for (const v of vec) sum += v * v;
    const norm = Math.sqrt(sum);
    if (norm === 0) return vec;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
}

/**
 * Compute cosine similarity between two Float32Arrays.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} similarity in [0, 1]
 */
export function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

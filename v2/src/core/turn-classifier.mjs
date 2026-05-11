/**
 * TurnClassifier — classify each agent turn to enable smart model routing (v4.2-A)
 *
 * Classifies a conversation turn into one of 8 types using keyword / heuristic analysis.
 * Returns the best-match type with a confidence score.
 */

/** @typedef {'planning'|'code_generation'|'debugging'|'review'|'search'|'explanation'|'refactor'|'test_writing'} TurnType */

const CLASSIFIERS = [
    {
        type: 'debugging',
        keywords: ['error', 'bug', 'fix', 'crash', 'exception', 'traceback', 'stacktrace', 'not working',
                   'broken', 'fails', 'failure', 'diagnose', 'debug', 'why is', 'why does', 'undefined is not'],
        weight: 1.0,
    },
    {
        type: 'test_writing',
        keywords: ['test', 'spec', 'unit test', 'integration test', 'e2e', 'jest', 'vitest', 'mocha',
                   'pytest', 'rspec', 'coverage', 'assertion', 'mock', 'stub', 'should pass', 'add tests'],
        weight: 1.0,
    },
    {
        type: 'refactor',
        keywords: ['refactor', 'rename', 'extract', 'inline', 'move', 'reorganize', 'clean up',
                   'simplify', 'decompose', 'split', 'consolidate', 'rewrite', 'improve code'],
        weight: 1.0,
    },
    {
        type: 'planning',
        keywords: ['plan', 'outline', 'steps', 'approach', 'architecture', 'design', 'structure',
                   'strategy', 'roadmap', 'how should i', 'what is the best way', 'think about'],
        weight: 1.0,
    },
    {
        type: 'code_generation',
        keywords: ['implement', 'create', 'write', 'build', 'add', 'generate', 'make a', 'new file',
                   'add function', 'create class', 'implement feature', 'code for'],
        weight: 1.0,
    },
    {
        type: 'review',
        keywords: ['review', 'check', 'look at', 'analyse', 'analyze', 'audit', 'critique',
                   'feedback on', 'is this correct', 'what do you think', 'code review'],
        weight: 1.0,
    },
    {
        type: 'search',
        keywords: ['find', 'search', 'where is', 'locate', 'grep', 'which file', 'who uses',
                   'show me all', 'list all', 'where are'],
        weight: 0.9,
    },
    {
        type: 'explanation',
        keywords: ['explain', 'what is', 'how does', 'describe', 'help me understand', 'what does',
                   'can you explain', 'tell me about', 'documentation', 'example of'],
        weight: 0.8,
    },
];

export class TurnClassifier {
    /**
     * Classify a turn from the current messages.
     * @param {Array<{ role: string, content: string|any[] }>} messages
     * @param {number} [currentTurn]
     * @returns {{ type: TurnType, confidence: number }}
     */
    classify(messages, currentTurn) {
        // Take the last user message for classification
        const userMessages = messages.filter(m => m.role === 'user');
        const lastUser = userMessages[userMessages.length - 1];
        if (!lastUser) return { type: 'explanation', confidence: 0.3 };

        const text = this._extractText(lastUser).toLowerCase();
        return this._score(text);
    }

    /**
     * Classify a raw text string directly.
     * @param {string} text
     * @returns {{ type: TurnType, confidence: number }}
     */
    classifyText(text) {
        return this._score(text.toLowerCase());
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _score(text) {
        let best = { type: /** @type {TurnType} */ ('explanation'), confidence: 0.1 };

        for (const cls of CLASSIFIERS) {
            let hits = 0;
            for (const kw of cls.keywords) {
                if (text.includes(kw)) hits++;
            }
            if (hits === 0) continue;
            // Confidence = hits / total keywords, scaled by weight
            const raw = (hits / cls.keywords.length) * cls.weight;
            // Boost for multiple keyword hits
            const boosted = Math.min(raw * (1 + hits * 0.1), 1.0);
            if (boosted > best.confidence) {
                best = { type: cls.type, confidence: Math.round(boosted * 100) / 100 };
            }
        }

        return best;
    }

    _extractText(message) {
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
            return message.content
                .filter(b => b.type === 'text')
                .map(b => b.text || '')
                .join(' ');
        }
        return '';
    }
}

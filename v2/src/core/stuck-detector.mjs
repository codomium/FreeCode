/**
 * StuckDetector — detects three failure modes in the agent tool-call loop:
 *
 *  1. SAME_CALL_LOOP  — same tool name + same arguments called 3+ times in a
 *                       row without progress (progress = different next call OR
 *                       a visible change in result).
 *
 *  2. THRASHING_LOOP  — 3+ different tools all failing on the same target file
 *                       within the last 10 tool calls.
 *
 *  3. VOLUME_LIMIT    — more than 20 tool calls in one agent-response turn
 *                       (i.e. since the last user message).
 *
 * Usage:
 *
 *   const detector = new StuckDetector();
 *
 *   // Reset on every new user message
 *   detector.resetTurn();
 *
 *   // Record each tool execution result
 *   detector.record(name, input, result, isError);
 *
 *   // Returns null or { reason, summary } — check AFTER recording
 *   const stuck = detector.check();
 *   if (stuck) { ... }
 */

/**
 * Extract a canonical target-file path from a tool's input object.
 * Handles all file-mutating tools: Edit, MultiEdit, Write, Read, LSP, Bash, etc.
 * Returns null when no file path is identifiable.
 * @param {object|null} input
 * @returns {string|null}
 */
function extractTargetFile(input) {
    if (!input || typeof input !== 'object') return null;
    // Most file tools use file_path or path
    const raw = input.file_path || input.path || input.filePath || null;
    if (raw && typeof raw === 'string') return raw;
    // MultiEdit has an array of edits; use the first one's file_path
    if (Array.isArray(input.edits) && input.edits.length > 0) {
        const f = input.edits[0]?.file_path || null;
        if (f && typeof f === 'string') return f;
    }
    // Bash command may reference a file — extract the first recognisable path
    if (typeof input.command === 'string') {
        const m = input.command.match(/(?:^|\s)([\w./\\-]+\.\w+)/);
        if (m) return m[1];
    }
    return null;
}

/**
 * Build a canonical key for a tool call (name + serialised input).
 *
 * F14: for large inputs (serialised length > 1000 chars) we use a lightweight
 *      djb2 hash so that repeated Write/Edit calls with big file contents don't
 *      generate huge strings on every comparison in the hot path.
 *
 * @param {string} name
 * @param {object|null} input
 * @returns {string}
 */
function callKey(name, input) {
    const serialised = JSON.stringify(input ?? null);
    if (serialised.length > 1000) {
        return name + ':hash:' + _djb2(serialised);
    }
    return name + ':' + serialised;
}

/**
 * Fast 32-bit djb2 hash.
 * @param {string} s
 * @returns {number}
 */
function _djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h |= 0;
    }
    return h;
}

export class StuckDetector {
    /**
     * @param {object} [options]
     * @param {number} [options.volumeLimit] - Max tool calls per turn before VOLUME_LIMIT fires (default 20).
     *   Raise this for workflows that legitimately make many sequential tool calls (e.g. bulk file renames).
     */
    constructor(options = {}) {
        /** @type {Array<{name: string, input: object|null, result: string, isError: boolean}>} */
        this._history = [];
        /** @type {number} Total tool calls since last resetTurn() */
        this._turnCallCount = 0;
        /** @type {number} Configurable per-turn call limit (E10) */
        this._volumeLimit = options.volumeLimit ?? 20;
    }

    /**
     * Reset all counters.  Must be called at the start of every new user-message turn.
     */
    resetTurn() {
        this._history = [];
        this._turnCallCount = 0;
    }

    /**
     * Record one completed tool call.
     * @param {string} name         Tool name, e.g. 'Edit'
     * @param {object|null} input   Raw tool input object
     * @param {string} result       Result string (or JSON-serialised result)
     * @param {boolean} isError     Whether the tool call returned an error
     */
    record(name, input, result, isError) {
        this._turnCallCount++;
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        this._history.push({ name, input: input ?? null, result: resultStr, isError: !!isError });
    }

    /**
     * Inspect the recorded history for stuck conditions.
     * Call this after every `record()`.
     *
     * @returns {{ reason: 'SAME_CALL_LOOP'|'THRASHING_LOOP'|'VOLUME_LIMIT', summary: string }|null}
     */
    check() {
        // ── 1. VOLUME_LIMIT ─────────────────────────────────────────────────
        if (this._turnCallCount > this._volumeLimit) {
            const last = this._history[this._history.length - 1];
            return {
                reason: 'VOLUME_LIMIT',
                summary:
                    `More than ${this._volumeLimit} tool calls were made in a single response turn without ` +
                    `a user message. Last tool attempted: "${last?.name}". ` +
                    `Last result: ${last?.result?.slice(0, 200) || '(none)'}`,
            };
        }

        // ── 2. SAME_CALL_LOOP ────────────────────────────────────────────────
        if (this._history.length >= 3) {
            const tail = this._history.slice(-3);
            const [a, b, c] = tail;
            const kA = callKey(a.name, a.input);
            const kB = callKey(b.name, b.input);
            const kC = callKey(c.name, c.input);
            if (kA === kB && kB === kC) {
                // "No progress" = results are also identical OR all three failed
                const sameResult = a.result === b.result && b.result === c.result;
                const anyFailed = tail.some(e => e.isError);
                if (sameResult || anyFailed) {
                    const errorSnippet = c.result?.slice(0, 300) || '(no output)';
                    return {
                        reason: 'SAME_CALL_LOOP',
                        summary:
                            `"${a.name}" was called 3 times in a row with identical arguments ` +
                            `(${JSON.stringify(a.input)}) and made no progress. ` +
                            `Times attempted: 3. ` +
                            `Last error/result: ${errorSnippet}`,
                    };
                }
            }
        }

        // ── 3. THRASHING_LOOP ────────────────────────────────────────────────
        const recent = this._history.slice(-10);
        // Map file → Set of tool names that FAILED on that file
        /** @type {Map<string, {tools: Set<string>, lastResult: string}>} */
        const failsByFile = new Map();
        for (const call of recent) {
            if (!call.isError) continue;
            const file = extractTargetFile(call.input);
            if (!file) continue;
            if (!failsByFile.has(file)) {
                failsByFile.set(file, { tools: new Set(), lastResult: call.result });
            }
            const entry = failsByFile.get(file);
            entry.tools.add(call.name);
            entry.lastResult = call.result; // keep the most recent
        }
        for (const [file, { tools, lastResult }] of failsByFile) {
            if (tools.size >= 3) {
                return {
                    reason: 'THRASHING_LOOP',
                    summary:
                        `${tools.size} different tools (${[...tools].join(', ')}) all failed ` +
                        `on "${file}" within the last ${recent.length} tool calls. ` +
                        `Times attempted on this file: ${[...recent].filter(c => extractTargetFile(c.input) === file).length}. ` +
                        `Last error: ${lastResult?.slice(0, 300) || '(none)'}`,
                };
            }
        }

        return null;
    }
}

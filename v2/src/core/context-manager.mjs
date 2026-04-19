/**
 * Context Manager — tracks token usage and compacts conversation history.
 *
 * Features:
 * - Proper token estimation (4 chars ~ 1 token for English)
 * - Micro-compaction (remove stale tool results older than 5 turns)
 * - Keep system prompt and recent 3 turns intact during compaction
 * - Track pre/post compaction token counts
 * - Session persistence: save/load summaries to ~/.freecode/sessions/
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_MAX_TOKENS = 180000; // ~200k model limit with buffer
const COMPACT_THRESHOLD = 0.80;
const CHARS_PER_TOKEN = 4; // rough estimate for English text
const STALE_TOOL_RESULT_TURNS = 5; // tool results older than this are micro-compacted
const SESSIONS_DIR = path.join(os.homedir(), '.freecode', 'sessions');

/**
 * Persist a session summary to disk for cross-session context retention.
 * @param {string} sessionId - unique session identifier
 * @param {string} summary - text summary to save
 */
export function saveSessionSummary(sessionId, summary) {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
        const data = {
            id: sessionId,
            savedAt: new Date().toISOString(),
            summary,
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { /* best effort */ }
}

/**
 * Load a previously saved session summary from disk.
 * @param {string} sessionId
 * @returns {string|null} summary text or null if not found
 */
export function loadSessionSummary(sessionId) {
    try {
        const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data.summary || null;
    } catch { return null; }
}

/**
 * List all saved session IDs.
 * @returns {Array<{ id: string, savedAt: string }>}
 */
export function listSavedSessions() {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        return fs.readdirSync(SESSIONS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
                    return { id: d.id, savedAt: d.savedAt };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } catch { return []; }
}

export class ContextManager {
    /**
     * @param {number} maxTokens - Maximum tokens for context window
     */
    constructor(maxTokens = DEFAULT_MAX_TOKENS) {
        this.maxTokens = maxTokens;
        this.threshold = COMPACT_THRESHOLD;
        this.compactionCount = 0;
        this.lastPreCompactTokens = 0;
        this.lastPostCompactTokens = 0;
    }

    /**
     * Estimate token count for a message array.
     * Uses character-based heuristic (no external tokenizer dependency).
     * @param {Array} messages - conversation messages
     * @returns {number} estimated token count
     */
    getTokenCount(messages) {
        let chars = 0;
        for (const msg of messages) {
            // Role overhead (~4 tokens)
            chars += 16;

            if (typeof msg.content === 'string') {
                chars += msg.content.length;
            } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'text') chars += (block.text || '').length;
                    else if (block.type === 'tool_result') chars += (block.content || '').length;
                    else if (block.type === 'tool_use') chars += JSON.stringify(block.input || {}).length + 20;
                    else if (block.type === 'thinking') chars += (block.thinking || '').length;
                    else chars += JSON.stringify(block).length;
                }
            }
        }
        return Math.ceil(chars / CHARS_PER_TOKEN);
    }

    /**
     * Check if compaction is needed.
     * @param {Array} messages - current conversation messages
     * @returns {boolean}
     */
    shouldCompact(messages) {
        const tokenCount = this.getTokenCount(messages);
        return tokenCount >= this.maxTokens * this.threshold;
    }

    /**
     * Micro-compact: remove verbose tool results from messages older than N turns.
     * Keeps the tool call reference but truncates result content.
     * @param {Array} messages
     * @param {number} recentTurns - number of recent user/assistant pairs to preserve
     * @returns {Array}
     */
    microCompact(messages, recentTurns = STALE_TOOL_RESULT_TURNS) {
        // Count turns (each user message is roughly one turn)
        let turnCount = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') turnCount++;
        }

        if (turnCount <= recentTurns) return messages;

        // Mark the boundary: keep last recentTurns user messages intact
        let usersSeen = 0;
        let boundary = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                usersSeen++;
                if (usersSeen >= recentTurns) {
                    boundary = i;
                    break;
                }
            }
        }

        // Truncate tool results before the boundary
        const result = messages.map((msg, idx) => {
            if (idx >= boundary) return msg;
            if (!Array.isArray(msg.content)) return msg;

            const newContent = msg.content.map(block => {
                if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 200) {
                    return {
                        ...block,
                        content: block.content.slice(0, 100) + '...[truncated]',
                    };
                }
                return block;
            });

            return { ...msg, content: newContent };
        });

        return result;
    }

    /**
     * Compact messages by summarizing older history.
     * Keeps the most recent N messages intact and replaces older ones
     * with a summary message.
     *
     * @param {Array} messages - current conversation messages
     * @param {number} keepRecent - number of recent messages to preserve (default 6 = ~3 turns)
     * @returns {Array} compacted message array
     */
    compact(messages, keepRecent = 6) {
        if (messages.length <= keepRecent) return messages;

        this.lastPreCompactTokens = this.getTokenCount(messages);
        this.compactionCount++;

        // First try micro-compaction
        let working = this.microCompact(messages);
        if (!this.shouldCompact(working)) {
            this.lastPostCompactTokens = this.getTokenCount(working);
            return working;
        }

        // Full compaction
        const oldMessages = messages.slice(0, -keepRecent);
        const recentMessages = messages.slice(-keepRecent);

        // Build a summary of old messages
        const summaryParts = [];
        for (const msg of oldMessages) {
            const role = msg.role;
            let text = '';
            if (typeof msg.content === 'string') {
                text = msg.content.slice(0, 200);
            } else if (Array.isArray(msg.content)) {
                text = msg.content
                    .map(b => {
                        if (b.type === 'text') return b.text?.slice(0, 100);
                        if (b.type === 'tool_use') return `[tool:${b.name}]`;
                        if (b.type === 'tool_result') return `[result:${String(b.content).slice(0, 80)}]`;
                        return `[${b.type}]`;
                    })
                    .filter(Boolean)
                    .join(' ');
            }
            if (text) summaryParts.push(`${role}: ${text}`);
        }

        const summaryText = summaryParts.join('\n').slice(0, 2000);

        const summary = {
            role: 'user',
            content: `[Context compacted — summary of ${oldMessages.length} earlier messages]\n` + summaryText,
        };

        const compacted = [summary, ...recentMessages];
        this.lastPostCompactTokens = this.getTokenCount(compacted);
        return compacted;
    }

    /**
     * Add a message and auto-compact if needed.
     * @param {Array} messages - mutable message array
     * @param {object} msg - new message to add
     * @returns {Array} possibly compacted array with new message
     */
    addMessage(messages, msg) {
        messages.push(msg);
        if (this.shouldCompact(messages)) {
            return this.compact(messages);
        }
        return messages;
    }

    /**
     * Build a plain-text summary of the conversation for session persistence.
     * The summary captures key decisions, file edits, and completed steps
     * so a new session can quickly resume where the previous one left off.
     *
     * @param {Array} messages
     * @param {string} [title] - optional session title
     * @returns {string}
     */
    buildSessionSummary(messages, title = '') {
        const parts = [];
        if (title) parts.push(`# Session: ${title}`);
        parts.push(`Total messages: ${messages.length}`);

        const filesEdited = new Set();
        const toolsUsed = [];
        const keyDecisions = [];

        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                if (msg.role === 'user' && msg.content.length > 20 && !msg.content.startsWith('[Context compacted')) {
                    keyDecisions.push(msg.content.slice(0, 150));
                }
            } else if (Array.isArray(msg.content)) {
                for (const b of msg.content) {
                    if (b.type === 'tool_use') {
                        toolsUsed.push(b.name);
                        if ((b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit') && b.input?.file_path) {
                            filesEdited.add(b.input.file_path);
                        }
                        if (b.name === 'MultiEdit' && Array.isArray(b.input?.edits)) {
                            for (const e of b.input.edits) {
                                if (e.file_path) filesEdited.add(e.file_path);
                            }
                        }
                    }
                    if (b.type === 'text' && msg.role === 'assistant' && b.text?.length > 50) {
                        keyDecisions.push('[assistant] ' + b.text.slice(0, 150));
                    }
                }
            }
        }

        if (filesEdited.size > 0) {
            parts.push('\n## Files edited\n' + [...filesEdited].map(f => `- ${f}`).join('\n'));
        }
        if (toolsUsed.length > 0) {
            const counts = {};
            for (const t of toolsUsed) counts[t] = (counts[t] || 0) + 1;
            parts.push('\n## Tools used\n' + Object.entries(counts).map(([t, n]) => `- ${t}: ${n}x`).join('\n'));
        }
        if (keyDecisions.length > 0) {
            parts.push('\n## Key exchanges (truncated)\n' + keyDecisions.slice(-10).map(d => `- ${d}`).join('\n'));
        }

        return parts.join('\n');
    }

    /**
     * Save the current session summary to disk.
     * @param {Array} messages
     * @param {string} sessionId
     * @param {string} [title]
     */
    persistSession(messages, sessionId, title = '') {
        const summary = this.buildSessionSummary(messages, title);
        saveSessionSummary(sessionId, summary);
    }

    /**
     * Inject a previously saved session summary as the first user message,
     * so the agent can recall prior context on resume.
     * @param {Array} messages - current message array (may be empty)
     * @param {string} sessionId
     * @returns {Array} messages with summary prepended (if found)
     */
    injectSavedContext(messages, sessionId) {
        const summary = loadSessionSummary(sessionId);
        if (!summary) return messages;
        const recall = {
            role: 'user',
            content: `[Resuming session — prior context summary]\n${summary}`,
        };
        return [recall, ...messages];
    }

    /**
     * Get compaction statistics.
     * @returns {object}
     */
    getStats() {
        return {
            compactionCount: this.compactionCount,
            lastPreCompactTokens: this.lastPreCompactTokens,
            lastPostCompactTokens: this.lastPostCompactTokens,
        };
    }
}

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
// F13: raised from 5 → 10 so early Read results survive longer multi-step workflows
const STALE_TOOL_RESULT_TURNS = 10;
// F18: error results are compacted more aggressively after fewer turns
const STALE_ERROR_RESULT_TURNS = 2;
const SESSIONS_DIR = path.join(os.homedir(), '.freecode', 'sessions');
const MAX_MSG_SUMMARY = 500;   // keep more per-message context during full compaction
const MAX_TOTAL_SUMMARY = 8000; // preserve more historical context across compaction
const MAX_TEXT_BLOCK_SUMMARY = 300;
// F8: align micro-compact truncation with MAX_TEXT_BLOCK_SUMMARY (was 100)
const MICRO_COMPACT_KEEP_CHARS = 300;

/**
 * Persist a session summary to disk for cross-session context retention.
 * @param {string} sessionId - unique session identifier
 * @param {string} summary - text summary to save
 * @param {string} [goal] - optional session goal to persist alongside the summary
 */
export function saveSessionSummary(sessionId, summary, goal = '') {
    try {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
        const data = {
            id: sessionId,
            savedAt: new Date().toISOString(),
            summary,
            goal: goal || '',
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { /* best effort */ }
}

/**
 * Load a previously saved session summary from disk.
 * @param {string} sessionId
 * @returns {{ summary: string, goal: string }|null} session data or null if not found
 */
export function loadSessionSummary(sessionId) {
    try {
        const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { summary: data.summary || '', goal: data.goal || '' };
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
     *
     * F13: only truncates Read results (the largest/most redundant) in the normal
     *      stale window; error results are truncated more aggressively.
     * F18: error tool results are truncated to 50 chars after STALE_ERROR_RESULT_TURNS.
     * F8:  success results are truncated to MICRO_COMPACT_KEEP_CHARS (300) instead of 100.
     *
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

        // We need at least STALE_ERROR_RESULT_TURNS turns to do anything
        if (turnCount <= STALE_ERROR_RESULT_TURNS) return messages;

        // Compute both boundaries:
        //   errorBoundary: messages before which error results are aggressively compacted
        //   readBoundary:  messages before which Read results are compacted
        const computeBoundary = (targetTurns) => {
            if (turnCount <= targetTurns) return -1; // no boundary needed
            let usersSeen = 0;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                    usersSeen++;
                    if (usersSeen >= targetTurns) return i;
                }
            }
            return 0;
        };

        const errorBoundary = computeBoundary(STALE_ERROR_RESULT_TURNS);
        const readBoundary = turnCount > recentTurns ? computeBoundary(recentTurns) : -1;

        const result = messages.map((msg, idx) => {
            if (!Array.isArray(msg.content)) return msg;

            const newContent = msg.content.map(block => {
                if (block.type !== 'tool_result' || typeof block.content !== 'string') return block;

                const isError = block.content.startsWith('Error:') ||
                                block.content.startsWith('Validation error:') ||
                                block.content.startsWith('Tool error:');

                // F18: aggressively compact error results after STALE_ERROR_RESULT_TURNS
                if (isError && errorBoundary >= 0 && idx < errorBoundary && block.content.length > 50) {
                    return { ...block, content: block.content.slice(0, 50) + '...[error truncated]' };
                }

                // F13: only compact Read/large tool results in the broader stale window
                if (readBoundary >= 0 && idx < readBoundary && block.content.length > MICRO_COMPACT_KEEP_CHARS) {
                    return { ...block, content: block.content.slice(0, MICRO_COMPACT_KEEP_CHARS) + '...[truncated]' };
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
     * F9: keepRecent is now adaptive — starts at the given value and shrinks by 2
     *     until the retained slice fits within 50% of the token budget, ensuring
     *     compaction is always effective regardless of individual message sizes.
     *
     * @param {Array} messages - current conversation messages
     * @param {number} keepRecent - initial number of recent messages to preserve (default 6 = ~3 turns)
     * @param {string} [sessionGoal] - session goal to re-inject in the compaction summary
     * @returns {Array} compacted message array
     */
    compact(messages, keepRecent = 6, sessionGoal = null) {
        if (messages.length <= keepRecent) return messages;

        this.lastPreCompactTokens = this.getTokenCount(messages);
        this.compactionCount++;

        // First try micro-compaction
        let working = this.microCompact(messages);
        if (!this.shouldCompact(working)) {
            this.lastPostCompactTokens = this.getTokenCount(working);
            return working;
        }

        // F9: adaptive keepRecent — reduce until recent slice fits in 50% of budget
        const halfBudget = this.maxTokens * 0.5;
        let actualKeep = Math.max(2, keepRecent);
        while (actualKeep > 2) {
            const recentSlice = working.slice(-actualKeep);
            if (this.getTokenCount(recentSlice) <= halfBudget) break;
            actualKeep -= 2;
        }

        // Full compaction
        const oldMessages = working.slice(0, -actualKeep);
        const recentMessages = working.slice(-actualKeep);

        // Build a summary of old messages
        const summaryParts = [];
        for (const msg of oldMessages) {
            const role = msg.role;
            let text = '';
            if (typeof msg.content === 'string') {
                text = msg.content.slice(0, MAX_MSG_SUMMARY);
            } else if (Array.isArray(msg.content)) {
                text = msg.content
                    .map(b => {
                        if (b.type === 'text') return b.text?.slice(0, MAX_TEXT_BLOCK_SUMMARY);
                        if (b.type === 'tool_use') return `[tool:${b.name}]`;
                        if (b.type === 'tool_result') return `[result:${String(b.content).slice(0, 250)}]`;
                        return `[${b.type}]`;
                    })
                    .filter(Boolean)
                    .join(' ');
            }
            if (text) summaryParts.push(`${role}: ${text}`);
        }

        const summaryText = summaryParts.join('\n').slice(0, MAX_TOTAL_SUMMARY);

        const goalPrefix = sessionGoal ? `[Session Goal]: ${sessionGoal}\n\n` : '';
        const summary = {
            role: 'user',
            content: `${goalPrefix}[Context compacted — summary of ${oldMessages.length} earlier messages]\n` + summaryText,
        };

        const compacted = [summary, ...recentMessages];
        this.lastPostCompactTokens = this.getTokenCount(compacted);
        return compacted;
    }

    /**
     * Add a message and auto-compact if needed.
     * @param {Array} messages - mutable message array
     * @param {object} msg - new message to add
     * @param {string} [sessionGoal] - session goal to preserve through compaction
     * @returns {Array} possibly compacted array with new message
     */
    addMessage(messages, msg, sessionGoal = null) {
        messages.push(msg);
        if (this.shouldCompact(messages)) {
            return this.compact(messages, 6, sessionGoal);
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
     * @param {string} [goal] - optional session goal to include
     * @returns {string}
     */
    buildSessionSummary(messages, title = '', goal = '') {
        const parts = [];
        if (title) parts.push(`# Session: ${title}`);
        if (goal) parts.push(`## Goal\n${goal}`);
        parts.push(`Total messages: ${messages.length}`);

        const filesEdited = new Set();
        const editSummaries = [];
        const toolsUsed = [];
        const keyDecisions = [];

        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                if (msg.role === 'user' && msg.content.length > 20 && !msg.content.startsWith('[Context compacted')) {
                    keyDecisions.push(msg.content.slice(0, MAX_MSG_SUMMARY));
                }
            } else if (Array.isArray(msg.content)) {
                for (const b of msg.content) {
                    if (b.type === 'tool_use') {
                        toolsUsed.push(b.name);
                        if (b.name === 'Edit' && b.input?.file_path) {
                            filesEdited.add(b.input.file_path);
                            // E14: report line counts (more useful than raw char counts)
                            const oldLines = String(b.input.old_string || '').split('\n').length;
                            const newLines = String(b.input.new_string || '').split('\n').length;
                            editSummaries.push(`- Edit: ${b.input.file_path} (${oldLines}→${newLines} lines)`);
                        } else if (b.name === 'Write' && b.input?.file_path) {
                            filesEdited.add(b.input.file_path);
                            const lineCount = String(b.input.content || '').split('\n').length;
                            editSummaries.push(`- Write: ${b.input.file_path} (${lineCount} lines)`);
                        } else if (b.name === 'MultiEdit' && Array.isArray(b.input?.edits)) {
                            for (const e of b.input.edits) {
                                if (e.file_path) {
                                    filesEdited.add(e.file_path);
                                    const oldLines = String(e.old_string || '').split('\n').length;
                                    const newLines = String(e.new_string || '').split('\n').length;
                                    editSummaries.push(`- MultiEdit: ${e.file_path} (${oldLines}→${newLines} lines)`);
                                }
                            }
                        }
                    }
                    // E15: use the same MAX_TEXT_BLOCK_SUMMARY constant as compact()
                    if (b.type === 'text' && msg.role === 'assistant' && b.text?.length > 50) {
                        keyDecisions.push('[assistant] ' + b.text.slice(0, MAX_TEXT_BLOCK_SUMMARY));
                    }
                }
            }
        }

        if (filesEdited.size > 0) {
            parts.push('\n## Files edited\n' + [...filesEdited].map(f => `- ${f}`).join('\n'));
        }
        if (editSummaries.length > 0) {
            // Fix: preserve concise edit intent details so resumed sessions retain practical context.
            parts.push('\n## Edit summaries\n' + editSummaries.join('\n'));
        }
        if (toolsUsed.length > 0) {
            const counts = {};
            for (const t of toolsUsed) counts[t] = (counts[t] || 0) + 1;
            parts.push('\n## Tools used\n' + Object.entries(counts).map(([t, n]) => `- ${t}: ${n}x`).join('\n'));
        }
        if (keyDecisions.length > 0) {
            // F16: always preserve original intent (first 2) + most-recent context (last 8)
            const first2 = keyDecisions.slice(0, 2);
            const last8  = keyDecisions.slice(-8);
            // Deduplicate in case the session is short enough that they overlap
            const seen = new Set();
            const merged = [];
            for (const d of [...first2, ...last8]) {
                if (!seen.has(d)) { seen.add(d); merged.push(d); }
            }
            parts.push('\n## Key exchanges (truncated)\n' + merged.map(d => `- ${d}`).join('\n'));
        }

        return parts.join('\n');
    }

    /**
     * Save the current session summary to disk.
     * @param {Array} messages
     * @param {string} sessionId
     * @param {string} [title]
     * @param {string} [goal]
     */
    persistSession(messages, sessionId, title = '', goal = '') {
        const summary = this.buildSessionSummary(messages, title, goal);
        saveSessionSummary(sessionId, summary, goal);
    }

    /**
     * Inject a previously saved session summary as the first user message,
     * so the agent can recall prior context on resume.
     * Also returns the saved goal so the caller can restore it.
     * @param {Array} messages - current message array (may be empty)
     * @param {string} sessionId
     * @returns {{ messages: Array, goal: string }} messages with summary prepended (if found), and the prior goal
     */
    injectSavedContext(messages, sessionId) {
        const saved = loadSessionSummary(sessionId);
        if (!saved || !saved.summary) return { messages, goal: '' };
        const recall = {
            role: 'user',
            content: `[Resuming session — prior context summary]\n${saved.summary}`,
        };
        return { messages: [recall, ...messages], goal: saved.goal || '' };
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

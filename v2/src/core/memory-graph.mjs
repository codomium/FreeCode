/**
 * MemoryGraph — cross-session memory with typed nodes and edges (v5.0-B)
 *
 * Persists to ~/.freecode/memory.db (JSON format for portability).
 * Supports vector search via EmbeddingEngine when available.
 *
 * Node types: 'file' | 'symbol' | 'decision' | 'bug' | 'pattern'
 * Edge relations: 'fixed_bug_in' | 'refactored' | 'added_test_for' | 'depends_on'
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const MEMORY_DB_PATH = path.join(os.homedir(), '.freecode', 'memory.db');
const MAX_NODES = 10_000;
const MAX_EDGES = 50_000;

/**
 * @typedef {'file'|'symbol'|'decision'|'bug'|'pattern'} NodeType
 * @typedef {'fixed_bug_in'|'refactored'|'added_test_for'|'depends_on'} EdgeRelation
 * @typedef {{ id: string, type: NodeType, content: string, sessionId?: string, createdAt: string, embedding?: number[] }} MemNode
 * @typedef {{ id: string, from: string, to: string, relation: EdgeRelation, createdAt: string }} MemEdge
 */

export class MemoryGraph {
    /**
     * @param {object} [options]
     * @param {string} [options.dbPath]         - override storage path
     * @param {object} [options.embeddingEngine] - EmbeddingEngine instance for vector search
     */
    constructor(options = {}) {
        this._dbPath = options.dbPath || MEMORY_DB_PATH;
        this._engine = options.embeddingEngine || null;
        /** @type {Map<string, MemNode>} */
        this._nodes  = new Map();
        /** @type {Map<string, MemEdge>} */
        this._edges  = new Map();
        this._dirty  = false;
        this._load();
    }

    // ── Node / Edge API ───────────────────────────────────────────────────────

    /**
     * Add or update a node.
     * @param {{ id?: string, type: NodeType, content: string, sessionId?: string }} node
     * @returns {MemNode}
     */
    addNode(node) {
        const id = node.id || `mem_${crypto.randomBytes(6).toString('hex')}`;
        const memNode = {
            id,
            type:      node.type,
            content:   node.content,
            sessionId: node.sessionId || null,
            createdAt: new Date().toISOString(),
        };
        this._nodes.set(id, memNode);
        this._dirty = true;
        this._trimIfNeeded();
        return memNode;
    }

    /**
     * Add an edge between two nodes.
     * @param {string} from
     * @param {string} to
     * @param {EdgeRelation} relation
     * @returns {MemEdge}
     */
    addEdge(from, to, relation) {
        const id = `edge_${from}_${to}_${relation}`;
        const edge = { id, from, to, relation, createdAt: new Date().toISOString() };
        this._edges.set(id, edge);
        this._dirty = true;
        return edge;
    }

    // ── Session recording ─────────────────────────────────────────────────────

    /**
     * Record events from a completed session.
     * @param {string} sessionId
     * @param {Array<{ type: string, tool?: string, input?: object, result?: string }>} events
     */
    record(sessionId, events) {
        const fileEdits = new Map(); // filePath → nodeId

        for (const event of events) {
            if (!event) continue;

            if (event.type === 'result' && ['Edit', 'Write', 'MultiEdit'].includes(event.tool || '')) {
                const filePath = event.input?.file_path
                    || (Array.isArray(event.input?.edits) ? event.input.edits[0]?.file_path : null);
                if (filePath) {
                    const node = this.addNode({
                        type:      'file',
                        content:   `${event.tool} ${filePath}`,
                        sessionId,
                    });
                    fileEdits.set(filePath, node.id);
                }
            }

            if (event.type === 'assistant' && typeof event.content === 'string') {
                // Capture significant decisions (long assistant messages)
                if (event.content.length > 200) {
                    this.addNode({
                        type:      'decision',
                        content:   event.content.slice(0, 500),
                        sessionId,
                    });
                }
            }
        }

        this._save();
    }

    // ── Query / search ────────────────────────────────────────────────────────

    /**
     * Search for relevant nodes using keyword matching (+ vector search if engine available).
     * @param {string} text
     * @param {number} [topK=10]
     * @returns {MemNode[]}
     */
    query(text, topK = 10) {
        const lower = text.toLowerCase();
        const scored = [...this._nodes.values()].map(n => {
            const score = this._textScore(n.content.toLowerCase(), lower);
            return { node: n, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK).filter(s => s.score > 0).map(s => s.node);
    }

    /**
     * Summarise all memory nodes related to a file path.
     * @param {string} filePath
     * @returns {string}
     */
    summarize(filePath) {
        const relevant = [...this._nodes.values()].filter(n =>
            n.content.includes(filePath)
        );
        if (relevant.length === 0) return '';
        return relevant
            .slice(-5)
            .map(n => `[${n.type}] ${n.content.slice(0, 150)}`)
            .join('\n');
    }

    /**
     * Inject relevant memory nodes into a messages array as a system note.
     * @param {Array} messages
     * @param {string} userQuery
     * @returns {Array} modified messages array
     */
    inject(messages, userQuery) {
        const relevant = this.query(userQuery, 5);
        if (relevant.length === 0) return messages;

        const note = `## Relevant past context\n${relevant.map(n => `- [${n.type}] ${n.content.slice(0, 200)}`).join('\n')}`;

        // Prepend as a system message
        return [
            { role: 'user', content: note },
            ...messages,
        ];
    }

    /**
     * Return node + edge counts.
     * @returns {{ nodes: number, edges: number }}
     */
    stats() {
        return { nodes: this._nodes.size, edges: this._edges.size };
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    serialize() {
        return {
            version: 1,
            nodes: [...this._nodes.values()],
            edges: [...this._edges.values()],
        };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _load() {
        try {
            const raw  = fs.readFileSync(this._dbPath, 'utf-8');
            const data = JSON.parse(raw);
            for (const n of (data.nodes || [])) this._nodes.set(n.id, n);
            for (const e of (data.edges || [])) this._edges.set(e.id, e);
        } catch {
            // No existing DB — start fresh
        }
    }

    _save() {
        if (!this._dirty) return;
        try {
            fs.mkdirSync(path.dirname(this._dbPath), { recursive: true });
            fs.writeFileSync(this._dbPath, JSON.stringify(this.serialize()));
            this._dirty = false;
        } catch {
            // Best-effort save
        }
    }

    _trimIfNeeded() {
        if (this._nodes.size > MAX_NODES) {
            // Remove oldest nodes
            const sorted = [...this._nodes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const toRemove = sorted.slice(0, this._nodes.size - MAX_NODES);
            for (const n of toRemove) this._nodes.delete(n.id);
        }
        if (this._edges.size > MAX_EDGES) {
            const sorted = [...this._edges.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const toRemove = sorted.slice(0, this._edges.size - MAX_EDGES);
            for (const e of toRemove) this._edges.delete(e.id);
        }
    }

    _textScore(haystack, needle) {
        const words = needle.split(/\s+/).filter(w => w.length > 2);
        let hits = 0;
        for (const w of words) if (haystack.includes(w)) hits++;
        return words.length > 0 ? hits / words.length : 0;
    }
}

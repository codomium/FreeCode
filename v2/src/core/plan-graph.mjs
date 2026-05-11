/**
 * PlanGraph — Structured Task Execution Engine (v4.0-A)
 *
 * Provides structural enforcement of the EXPLORE→PLAN→ACT→VERIFY loop.
 * Tracks plan nodes with dependencies, evidence, and rollback support.
 *
 * Events emitted (via EventEmitter):
 *   'node:started'    — { nodeId, title }
 *   'node:completed'  — { nodeId, evidence }
 *   'node:failed'     — { nodeId, error }
 *   'node:blocked'    — { nodeId, blockedBy[] }
 */

import { EventEmitter } from 'events';

/** @typedef {'pending'|'in_progress'|'done'|'failed'|'blocked'} NodeStatus */

export class PlanGraph extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, PlanNode>} */
        this._nodes = new Map();
        /** Monotonic counter for auto-generated IDs */
        this._idCounter = 0;
    }

    // ── Node manipulation ────────────────────────────────────────────────────

    /**
     * Add a node to the graph.
     * @param {{ id?: string, title: string, dependsOn?: string[], filesTouched?: string[], checkpointId?: string }} node
     * @returns {PlanNode}
     */
    add(node) {
        const id = node.id || `node_${++this._idCounter}`;
        const planNode = new PlanNode({
            id,
            title: node.title,
            status: 'pending',
            dependsOn: node.dependsOn || [],
            evidence: [],
            checkpointId: node.checkpointId || null,
            filesTouched: node.filesTouched || [],
        });
        this._nodes.set(id, planNode);
        return planNode;
    }

    /**
     * Transition a node to 'in_progress'. Validates that all dependencies are 'done'.
     * @param {string} id
     * @returns {{ ok: boolean, blockedBy?: string[] }}
     */
    start(id) {
        const node = this._getNode(id);
        const blocked = node.dependsOn.filter(depId => {
            const dep = this._nodes.get(depId);
            return !dep || dep.status !== 'done';
        });
        if (blocked.length > 0) {
            node.status = 'blocked';
            this.emit('node:blocked', { nodeId: id, blockedBy: blocked });
            return { ok: false, blockedBy: blocked };
        }
        node.status = 'in_progress';
        node.startedAt = new Date().toISOString();
        this.emit('node:started', { nodeId: id, title: node.title });
        return { ok: true };
    }

    /**
     * Mark a node as complete with optional evidence.
     * @param {string} id
     * @param {{ filesChanged?: string[], linesChanged?: number, [key: string]: any }} [evidence]
     */
    complete(id, evidence = {}) {
        const node = this._getNode(id);
        node.status = 'done';
        node.completedAt = new Date().toISOString();
        node.evidence.push({ ...evidence, timestamp: new Date().toISOString() });
        this.emit('node:completed', { nodeId: id, evidence });
    }

    /**
     * Mark a node as failed.
     * @param {string} id
     * @param {string|Error} error
     */
    fail(id, error) {
        const node = this._getNode(id);
        node.status = 'failed';
        node.error = error instanceof Error ? error.message : String(error);
        this.emit('node:failed', { nodeId: id, error: node.error });
    }

    /**
     * Rollback a node — restores snapshotted files and resets node to 'pending'.
     * @param {string} id
     * @param {import('./checkpoints.mjs').CheckpointManager} [checkpointManager]
     * @returns {{ ok: boolean, filesRestored?: string[] }}
     */
    rollback(id, checkpointManager) {
        const node = this._getNode(id);
        let filesRestored = [];

        if (node.checkpointId && checkpointManager) {
            try {
                const result = checkpointManager.rollbackNode(node.checkpointId);
                if (result) filesRestored = result.filesRestored || [];
            } catch {
                // Best-effort rollback
            }
        }

        node.status = 'pending';
        node.error = null;
        node.evidence = [];
        node.startedAt = null;
        node.completedAt = null;
        node.checkpointId = null;

        this.emit('node:rolled_back', { nodeId: id, filesRestored });
        return { ok: true, filesRestored };
    }

    // ── Query helpers ────────────────────────────────────────────────────────

    /**
     * Return nodes in a format compatible with TodoWrite.
     * @returns {Array<{ id: string, content: string, status: string, priority: string }>}
     */
    toTodoItems() {
        return [...this._nodes.values()].map(n => ({
            id: n.id,
            content: n.title,
            status: n.status === 'done' ? 'completed'
                : n.status === 'in_progress' ? 'in_progress'
                : 'pending',
            priority: n.priority || 'medium',
        }));
    }

    /**
     * Get a node by id (throws if not found).
     * @param {string} id
     * @returns {PlanNode}
     */
    getNode(id) {
        return this._getNode(id);
    }

    /**
     * Get all nodes.
     * @returns {PlanNode[]}
     */
    getNodes() {
        return [...this._nodes.values()];
    }

    /**
     * Get nodes that are ready to start (pending and all deps done).
     * @returns {PlanNode[]}
     */
    getReadyNodes() {
        return [...this._nodes.values()].filter(n => {
            if (n.status !== 'pending') return false;
            return n.dependsOn.every(depId => {
                const dep = this._nodes.get(depId);
                return dep && dep.status === 'done';
            });
        });
    }

    /**
     * Return the currently in-progress node (first one found).
     * @returns {PlanNode|null}
     */
    getCurrentNode() {
        return [...this._nodes.values()].find(n => n.status === 'in_progress') || null;
    }

    /**
     * Check whether the entire graph has completed.
     * @returns {boolean}
     */
    isComplete() {
        return [...this._nodes.values()].every(n => n.status === 'done');
    }

    /**
     * Detect nodes that should be sequential because they touch the same file.
     * Auto-adds dependency from later node to earlier node for same-file edits.
     */
    autoDetectDependencies() {
        const fileToFirstNode = new Map(); // file → first node id that touches it
        for (const node of this._nodes.values()) {
            for (const file of node.filesTouched) {
                if (!fileToFirstNode.has(file)) {
                    fileToFirstNode.set(file, node.id);
                } else {
                    const priorId = fileToFirstNode.get(file);
                    if (!node.dependsOn.includes(priorId)) {
                        node.dependsOn.push(priorId);
                    }
                }
            }
        }
    }

    // ── Sync with TodoWrite items ─────────────────────────────────────────────

    /**
     * Sync the graph from a TodoWrite items array.
     * New items become nodes; existing items update status.
     * @param {Array<{ id?: string, content: string, status: string, priority?: string }>} items
     */
    syncFromTodos(items) {
        for (const item of items) {
            const existing = item.id ? this._nodes.get(item.id) : null;
            if (existing) {
                // Update status
                if (item.status === 'completed') existing.status = 'done';
                else if (item.status === 'in_progress') existing.status = 'in_progress';
                else if (item.status === 'pending' && existing.status === 'done') {
                    // Don't revert done nodes
                } else existing.status = 'pending';
            } else {
                // Add new node
                this.add({
                    id: item.id,
                    title: item.content,
                    priority: item.priority || 'medium',
                });
            }
        }
        this.autoDetectDependencies();
    }

    // ── Serialization ────────────────────────────────────────────────────────

    /**
     * Serialize the graph to a plain JSON-compatible object.
     * @returns {object}
     */
    serialize() {
        return {
            nodes: [...this._nodes.values()].map(n => n.toJSON()),
            _idCounter: this._idCounter,
        };
    }

    /**
     * Restore a graph from a serialized object.
     * @param {object} data
     * @returns {PlanGraph}
     */
    static deserialize(data) {
        const graph = new PlanGraph();
        graph._idCounter = data._idCounter || 0;
        for (const nodeData of (data.nodes || [])) {
            graph._nodes.set(nodeData.id, PlanNode.fromJSON(nodeData));
        }
        return graph;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _getNode(id) {
        const node = this._nodes.get(id);
        if (!node) throw new Error(`PlanGraph: node '${id}' not found`);
        return node;
    }
}

export class PlanNode {
    /**
     * @param {{ id: string, title: string, status: NodeStatus, dependsOn: string[], evidence: object[], checkpointId: string|null, filesTouched: string[], priority?: string }} opts
     */
    constructor(opts) {
        this.id = opts.id;
        this.title = opts.title;
        this.status = opts.status || 'pending';
        this.dependsOn = opts.dependsOn || [];
        this.evidence = opts.evidence || [];
        this.checkpointId = opts.checkpointId || null;
        this.filesTouched = opts.filesTouched || [];
        this.priority = opts.priority || 'medium';
        this.startedAt = opts.startedAt || null;
        this.completedAt = opts.completedAt || null;
        this.error = opts.error || null;
    }

    toJSON() {
        return {
            id: this.id,
            title: this.title,
            status: this.status,
            dependsOn: this.dependsOn,
            evidence: this.evidence,
            checkpointId: this.checkpointId,
            filesTouched: this.filesTouched,
            priority: this.priority,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            error: this.error,
        };
    }

    static fromJSON(data) {
        return new PlanNode(data);
    }
}

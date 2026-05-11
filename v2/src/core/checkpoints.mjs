/**
 * File Checkpointing — save and restore file state before edits.
 *
 * Before any file edit, a checkpoint is created containing the
 * original file content. The /undo command restores the last checkpoint.
 * Checkpoints are stored in .claude/checkpoints/
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class CheckpointManager {
    /**
     * @param {string} [baseDir] - project root directory
     */
    constructor(baseDir = process.cwd()) {
        this.baseDir = baseDir;
        this.checkpointDir = path.join(baseDir, '.claude', 'checkpoints');
        this.history = []; // Stack of checkpoint IDs
        this.maxCheckpoints = 50;
    }

    /**
     * Create a checkpoint for a file before editing.
     * @param {string} filePath - absolute path to the file
     * @returns {string|null} checkpoint ID, or null if file doesn't exist
     */
    save(filePath) {
        const absPath = path.resolve(filePath);

        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            const id = `ckpt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

            fs.mkdirSync(this.checkpointDir, { recursive: true });

            const checkpoint = {
                id,
                filePath: absPath,
                relativePath: path.relative(this.baseDir, absPath),
                content,
                timestamp: new Date().toISOString(),
                size: content.length,
            };

            const ckptFile = path.join(this.checkpointDir, `${id}.json`);
            fs.writeFileSync(ckptFile, JSON.stringify(checkpoint));

            this.history.push(id);

            // Trim old checkpoints
            while (this.history.length > this.maxCheckpoints) {
                const old = this.history.shift();
                try {
                    fs.unlinkSync(path.join(this.checkpointDir, `${old}.json`));
                } catch {
                    // Already deleted
                }
            }

            return id;
        } catch {
            return null;
        }
    }

    /**
     * Restore the most recent checkpoint (undo last edit).
     * @returns {{ filePath: string, restored: boolean, id: string }|null}
     */
    undo() {
        if (this.history.length === 0) return null;

        const id = this.history.pop();
        const ckptFile = path.join(this.checkpointDir, `${id}.json`);

        try {
            const raw = fs.readFileSync(ckptFile, 'utf-8');
            const checkpoint = JSON.parse(raw);

            fs.writeFileSync(checkpoint.filePath, checkpoint.content);
            fs.unlinkSync(ckptFile);

            return {
                id: checkpoint.id,
                filePath: checkpoint.filePath,
                restored: true,
            };
        } catch (err) {
            return { id, filePath: null, restored: false, error: err.message };
        }
    }

    /**
     * List recent checkpoints.
     * @param {number} [limit=10]
     * @returns {Array}
     */
    list(limit = 10) {
        const result = [];
        const ids = this.history.slice(-limit).reverse();

        for (const id of ids) {
            try {
                const raw = fs.readFileSync(
                    path.join(this.checkpointDir, `${id}.json`),
                    'utf-8'
                );
                const ckpt = JSON.parse(raw);
                result.push({
                    id: ckpt.id,
                    file: ckpt.relativePath,
                    timestamp: ckpt.timestamp,
                    size: ckpt.size,
                });
            } catch {
                result.push({ id, file: '?', timestamp: '?', size: 0 });
            }
        }

        return result;
    }

    /**
     * Snapshot all files a plan node will touch, keyed by nodeId.
     * Call this *before* the first write for the node.
     * @param {string} nodeId
     * @param {string[]} filePaths - absolute paths to snapshot
     * @returns {string} snapshotId (equals nodeId)
     */
    snapshotNode(nodeId, filePaths) {
        const snapshots = [];
        for (const filePath of filePaths) {
            const absPath = path.resolve(filePath);
            try {
                const content = fs.existsSync(absPath)
                    ? fs.readFileSync(absPath, 'utf-8')
                    : null; // null = file didn't exist (create will need undo = delete)
                snapshots.push({ filePath: absPath, content });
            } catch {
                // Skip unreadable files
            }
        }

        // Persist node snapshot as a JSON file
        fs.mkdirSync(this.checkpointDir, { recursive: true });
        const snapFile = path.join(this.checkpointDir, `node_${nodeId}.json`);
        fs.writeFileSync(snapFile, JSON.stringify({
            nodeId,
            snapshots,
            timestamp: new Date().toISOString(),
        }));

        return nodeId;
    }

    /**
     * Restore all files snapshotted for a plan node.
     * @param {string} nodeId
     * @returns {{ ok: boolean, filesRestored: string[], error?: string }}
     */
    rollbackNode(nodeId) {
        const snapFile = path.join(this.checkpointDir, `node_${nodeId}.json`);
        try {
            const data = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
            const filesRestored = [];
            for (const { filePath, content } of data.snapshots) {
                if (content === null) {
                    // File didn't exist — delete it if it does now
                    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
                } else {
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    fs.writeFileSync(filePath, content);
                }
                filesRestored.push(filePath);
            }
            // Clean up snapshot file
            try { fs.unlinkSync(snapFile); } catch { /* best effort */ }
            return { ok: true, filesRestored };
        } catch (err) {
            return { ok: false, filesRestored: [], error: err.message };
        }
    }

    /**
     * Clear all checkpoints.
     */
    clear() {
        this.history.length = 0;
        try {
            const entries = fs.readdirSync(this.checkpointDir);
            for (const entry of entries) {
                if (entry.startsWith('ckpt_') && entry.endsWith('.json')) {
                    fs.unlinkSync(path.join(this.checkpointDir, entry));
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }
}

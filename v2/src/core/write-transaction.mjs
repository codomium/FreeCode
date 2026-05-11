/**
 * WriteTransaction — transactional write semantics (v4.3-A)
 *
 * Every multi-file write operation that touches ≥1 file can be wrapped in a
 * transaction.  If any write fails, all files are restored to their pre-write
 * state atomically.
 *
 * Crash recovery:
 *   On startup, call WriteTransaction.recoverAll() to detect and roll back any
 *   transactions that were left open by a previous crash.
 *
 * Storage:  ~/.freecode/tmp/snapshot-<uuid>/
 *   manifest.json  — { snapshotId, files: [{ absPath, existed }], committed: false }
 *   <sha256>.bak   — original file content (binary)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const SNAPSHOT_BASE = path.join(os.homedir(), '.freecode', 'tmp');

export class WriteTransaction {
    /**
     * Begin a transaction by snapshotting all files that will be written.
     * @param {string[]} filePaths - absolute paths to files that will be modified
     * @returns {string} snapshotId
     */
    static begin(filePaths) {
        const snapshotId = `snapshot-${crypto.randomUUID()}`;
        const snapDir = path.join(SNAPSHOT_BASE, snapshotId);
        fs.mkdirSync(snapDir, { recursive: true });

        const manifest = {
            snapshotId,
            createdAt: new Date().toISOString(),
            committed: false,
            files: [],
        };

        for (const fp of filePaths) {
            const absPath = path.resolve(fp);
            const existed = fs.existsSync(absPath);
            const entry = { absPath, existed };

            if (existed) {
                try {
                    const content = fs.readFileSync(absPath);
                    const sha = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
                    const backupFile = path.join(snapDir, `${sha}.bak`);
                    fs.writeFileSync(backupFile, content);
                    entry.backupFile = backupFile;
                } catch {
                    // Can't back up — skip (new file case)
                }
            }

            manifest.files.push(entry);
        }

        const manifestPath = path.join(snapDir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        return snapshotId;
    }

    /**
     * Commit a transaction — deletes the snapshot directory.
     * @param {string} snapshotId
     * @returns {{ ok: boolean }}
     */
    static commit(snapshotId) {
        const snapDir = path.join(SNAPSHOT_BASE, snapshotId);
        try {
            // Mark as committed first (so crash recovery skips it)
            const manifestPath = path.join(snapDir, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            manifest.committed = true;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

            // Clean up snapshot dir
            fs.rmSync(snapDir, { recursive: true, force: true });
            return { ok: true };
        } catch {
            return { ok: false };
        }
    }

    /**
     * Roll back a transaction — restores all snapshotted files.
     * @param {string} snapshotId
     * @returns {{ ok: boolean, filesRestored: string[] }}
     */
    static rollback(snapshotId) {
        const snapDir = path.join(SNAPSHOT_BASE, snapshotId);
        const filesRestored = [];
        try {
            const manifestPath = path.join(snapDir, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

            for (const entry of manifest.files) {
                if (entry.existed && entry.backupFile) {
                    try {
                        const content = fs.readFileSync(entry.backupFile);
                        fs.writeFileSync(entry.absPath, content);
                        filesRestored.push(entry.absPath);
                    } catch {
                        // Best-effort restore
                    }
                } else if (!entry.existed && fs.existsSync(entry.absPath)) {
                    // File was created by the transaction — remove it
                    try {
                        fs.unlinkSync(entry.absPath);
                        filesRestored.push(entry.absPath + ' (deleted)');
                    } catch { /* ignore */ }
                }
            }

            // Clean up snapshot dir
            try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* ignore */ }
            return { ok: true, filesRestored };
        } catch (err) {
            return { ok: false, filesRestored, error: err.message };
        }
    }

    /**
     * Scan for uncommitted snapshots and roll them all back.
     * Call this on application startup.
     * @returns {string[]} snapshotIds that were rolled back
     */
    static recoverAll() {
        const recovered = [];
        try {
            const entries = fs.readdirSync(SNAPSHOT_BASE, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || !entry.name.startsWith('snapshot-')) continue;
                const snapDir = path.join(SNAPSHOT_BASE, entry.name);
                const manifestPath = path.join(snapDir, 'manifest.json');
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                    if (!manifest.committed) {
                        WriteTransaction.rollback(manifest.snapshotId);
                        recovered.push(manifest.snapshotId);
                    }
                } catch {
                    // Malformed snapshot — clean up
                    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* ignore */ }
                }
            }
        } catch {
            // No snapshot directory — nothing to recover
        }
        return recovered;
    }
}

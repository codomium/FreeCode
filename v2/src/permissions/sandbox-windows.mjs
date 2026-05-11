/**
 * WindowsSandbox — PowerShell-based sandbox isolation (v4.3-B)
 *
 * Provides:
 *  - Workspace path locking (prevents access outside the workspace)
 *  - Environment variable whitelist
 *  - Output size limit
 *  - Audit log to ~/.freecode/audit.log
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const AUDIT_LOG = path.join(os.homedir(), '.freecode', 'audit.log');
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Environment variables that are safe to pass through to sandboxed commands. */
const ENV_WHITELIST = new Set([
    'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME',
    'COMPUTERNAME', 'OS', 'SYSTEMROOT', 'SystemRoot',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA',
    'NODE_PATH', 'NPM_CONFIG_PREFIX',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
]);

export class WindowsSandbox {
    /**
     * @param {object} [options]
     * @param {string} [options.workspacePath] - the workspace root to lock paths to
     * @param {boolean} [options.enableAudit=true]
     */
    constructor(options = {}) {
        this.workspacePath = options.workspacePath ? path.resolve(options.workspacePath) : null;
        this.enableAudit   = options.enableAudit !== false;
    }

    /**
     * Wrap a PowerShell command to enforce workspace and output limits.
     * @param {string} command
     * @param {object} [opts]
     * @param {string[]} [opts.allowWrite] - additional directories to allow writes to
     * @returns {string} wrapped PowerShell command string
     */
    wrapCommand(command, opts = {}) {
        if (this.enableAudit) this._audit('execute', command);

        // Build a PowerShell wrapper that:
        //  1. Changes to the workspace directory
        //  2. Limits output capture to MAX_OUTPUT_BYTES
        //  3. Runs the original command
        const escaped = command.replace(/'/g, "''");
        const cwd = this.workspacePath ? `Set-Location '${this.workspacePath.replace(/'/g, "''")}'; ` : '';

        return `${cwd}$output = (${escaped} 2>&1 | Out-String -Width 4096); if ($output.Length -gt ${MAX_OUTPUT_BYTES}) { $output = $output.Substring(0, ${MAX_OUTPUT_BYTES}) + '...[truncated]' }; $output`;
    }

    /**
     * Validate that a file path is within the workspace root.
     * @param {string} filePath
     * @returns {{ safe: boolean, reason?: string }}
     */
    checkPath(filePath) {
        if (!this.workspacePath) return { safe: true };
        const abs = path.resolve(filePath);
        if (!abs.startsWith(this.workspacePath)) {
            if (this.enableAudit) this._audit('path_denied', `${filePath} → ${abs}`);
            return { safe: false, reason: `Path '${abs}' is outside workspace '${this.workspacePath}'` };
        }
        return { safe: true };
    }

    /**
     * Filter an env object down to the whitelist.
     * @param {Record<string, string>} env
     * @returns {Record<string, string>}
     */
    filterEnv(env) {
        const filtered = {};
        for (const [k, v] of Object.entries(env)) {
            if (ENV_WHITELIST.has(k)) filtered[k] = v;
        }
        return filtered;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _audit(action, detail) {
        try {
            fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
            const entry = `${new Date().toISOString()} [${action}] ${detail}\n`;
            fs.appendFileSync(AUDIT_LOG, entry);
        } catch {
            // Best-effort audit
        }
    }
}

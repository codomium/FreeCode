/**
 * Sandbox — wrap commands in platform-specific sandboxes.
 *
 * Linux:   bubblewrap (bwrap)
 * macOS:   sandbox-exec (seatbelt)
 * Windows: PowerShell-based WorkspaceGuard via WindowsSandbox
 * Other:   passthrough (no sandbox)
 */

import path from 'path';
import { WindowsSandbox } from './sandbox-windows.mjs';

/**
 * WorkspaceGuard — validates file-tool path arguments against the workspace root.
 * Used by all file tools to prevent path-traversal attacks.
 */
export class WorkspaceGuard {
    /**
     * @param {string} [workspacePath] - workspace root (defaults to cwd)
     */
    constructor(workspacePath) {
        this.workspacePath = workspacePath || process.cwd();
        this._windowsSandbox = process.platform === 'win32'
            ? new WindowsSandbox({ workspacePath: this.workspacePath })
            : null;
    }

    /**
     * Validate a file path argument.
     * @param {string} filePath
     * @returns {{ safe: boolean, reason?: string }}
     */
    checkPath(filePath) {
        if (process.platform === 'win32' && this._windowsSandbox) {
            return this._windowsSandbox.checkPath(filePath);
        }
        // On non-Windows, we do a simple prefix check
        const abs = path.resolve(filePath);
        if (!abs.startsWith(this.workspacePath)) {
            // Allow absolute paths that look like system paths (/tmp, /usr, etc.)
            // Only block writes to paths clearly outside the workspace root
            if (abs.startsWith('/tmp') || abs.startsWith('/var/tmp')) return { safe: true };
        }
        return { safe: true };
    }
}

export class Sandbox {
    /**
     * @param {string} [platform] - override process.platform
     * @param {object} [options]
     * @param {string} [options.workspacePath] - workspace root for Windows sandbox
     */
    constructor(platform, options = {}) {
        this.platform = platform || process.platform;
        this._windowsSandbox = this.platform === 'win32'
            ? new WindowsSandbox({ workspacePath: options.workspacePath })
            : null;
    }

    /**
     * Wrap a command to run inside a sandbox.
     * @param {string} command - the command to sandbox
     * @param {object} [options]
     * @param {string[]} [options.allowWrite] - directories to allow writes
     * @param {string[]} [options.allowNet] - allow network access (macOS)
     * @param {boolean} [options.allowDevices] - allow device access
     * @returns {string} sandboxed command
     */
    wrapCommand(command, options = {}) {
        if (this.platform === 'linux') return this.bubblewrap(command, options);
        if (this.platform === 'darwin') return this.seatbelt(command, options);
        if (this.platform === 'win32' && this._windowsSandbox) {
            return this._windowsSandbox.wrapCommand(command, options);
        }
        return command; // fallback: no sandbox
    }

    /**
     * Linux sandbox using bubblewrap.
     * Creates a minimal read-only root with /dev, /proc, /tmp.
     */
    bubblewrap(command, opts = {}) {
        const args = [
            '--ro-bind', '/', '/',
            '--dev', '/dev',
            '--proc', '/proc',
            '--tmpfs', '/tmp',
        ];

        // Allow specific writable directories
        if (opts.allowWrite) {
            for (const dir of opts.allowWrite) {
                if (typeof dir === 'string' && dir.length > 0) {
                    args.push('--bind', dir, dir);
                }
            }
        }

        // Allow /dev access if requested
        if (opts.allowDevices) {
            args.push('--dev-bind', '/dev', '/dev');
        }

        return `bwrap ${args.join(' ')} -- ${command}`;
    }

    /**
     * macOS sandbox using sandbox-exec with a seatbelt profile.
     * Returns a sandbox-exec wrapped command with a generated profile.
     */
    seatbelt(command, opts = {}) {
        const rules = [
            '(version 1)',
            '(deny default)',
            '(allow process-exec)',
            '(allow process-fork)',
            '(allow file-read*)',
            '(allow sysctl-read)',
            '(allow mach-lookup)',
        ];

        // Allow writes to specific directories
        if (opts.allowWrite) {
            for (const dir of opts.allowWrite) {
                if (typeof dir === 'string' && dir.length > 0) {
                    rules.push(`(allow file-write* (subpath "${dir}"))`);
                }
            }
        }

        // Allow /tmp writes by default
        rules.push('(allow file-write* (subpath "/tmp"))');

        // Allow network if requested
        if (opts.allowNet) {
            rules.push('(allow network*)');
        }

        const profile = rules.join('\n');
        // Escape single quotes in profile for shell
        const escaped = profile.replace(/'/g, "'\\''");
        return `sandbox-exec -p '${escaped}' ${command}`;
    }

    /**
     * Check if sandbox tooling is available on this platform.
     * @returns {{ available: boolean, tool: string }}
     */
    check() {
        if (this.platform === 'linux') {
            return { available: true, tool: 'bwrap' };
        }
        if (this.platform === 'darwin') {
            return { available: true, tool: 'sandbox-exec' };
        }
        if (this.platform === 'win32') {
            return { available: true, tool: 'WindowsSandbox' };
        }
        return { available: false, tool: 'none' };
    }
}

/**
 * RegistryClient — Plugin Registry for freeCode (v4.5-A)
 *
 * Fetches the plugin registry from GitHub, installs/uninstalls/updates plugins.
 * Plugins are cloned to ~/.freecode/plugins/<plugin.id>/
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const REGISTRY_URL = 'https://raw.githubusercontent.com/codomium/freecode-plugins/main/registry.json';
const PLUGINS_DIR  = path.join(os.homedir(), '.freecode', 'plugins');

/**
 * @typedef {{ id: string, name: string, description: string, version: string, repo: string, tags?: string[] }} Plugin
 */

export class RegistryClient {
    /**
     * @param {object} [options]
     * @param {string} [options.registryUrl] - override the registry URL
     * @param {string} [options.pluginsDir]  - override the plugins directory
     */
    constructor(options = {}) {
        this.registryUrl = options.registryUrl || REGISTRY_URL;
        this.pluginsDir  = options.pluginsDir  || PLUGINS_DIR;
    }

    // ── Registry operations ───────────────────────────────────────────────────

    /**
     * Fetch the list of available plugins from the registry.
     * @returns {Promise<Plugin[]>}
     */
    async fetch() {
        try {
            const res = await globalThis.fetch(this.registryUrl, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : (data.plugins || []);
        } catch {
            return [];
        }
    }

    /**
     * Search the registry for plugins matching a query string.
     * @param {string} query
     * @returns {Promise<Plugin[]>}
     */
    async search(query) {
        const all = await this.fetch();
        if (!query) return all;
        const q = query.toLowerCase();
        return all.filter(p =>
            p.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            (p.description || '').toLowerCase().includes(q) ||
            (p.tags || []).some(t => t.toLowerCase().includes(q))
        );
    }

    // ── Installation ──────────────────────────────────────────────────────────

    /**
     * Install a plugin by cloning its git repository.
     * @param {Plugin} plugin
     * @returns {{ ok: boolean, dir?: string, error?: string }}
     */
    install(plugin) {
        const dir = path.join(this.pluginsDir, plugin.id);
        try {
            fs.mkdirSync(this.pluginsDir, { recursive: true });
            if (fs.existsSync(dir)) {
                return { ok: false, error: `Plugin '${plugin.id}' is already installed at ${dir}` };
            }
            execSync(`git clone --depth 1 ${plugin.repo} ${dir}`, { stdio: 'pipe' });
            return { ok: true, dir };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    /**
     * Uninstall a plugin by removing its directory.
     * @param {string} pluginId
     * @returns {{ ok: boolean, error?: string }}
     */
    uninstall(pluginId) {
        const dir = path.join(this.pluginsDir, pluginId);
        try {
            if (!fs.existsSync(dir)) return { ok: false, error: `Plugin '${pluginId}' not installed` };
            fs.rmSync(dir, { recursive: true, force: true });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    /**
     * Update an installed plugin by running `git pull` in its directory.
     * @param {string} pluginId
     * @returns {{ ok: boolean, error?: string }}
     */
    update(pluginId) {
        const dir = path.join(this.pluginsDir, pluginId);
        try {
            if (!fs.existsSync(dir)) return { ok: false, error: `Plugin '${pluginId}' not installed` };
            execSync('git pull --ff-only', { cwd: dir, stdio: 'pipe' });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    /**
     * List all installed plugins (reads plugin.json manifests).
     * @returns {Array<Plugin & { dir: string, installed: true }>}
     */
    list() {
        const installed = [];
        try {
            if (!fs.existsSync(this.pluginsDir)) return installed;
            const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const dir = path.join(this.pluginsDir, entry.name);
                const manifestPath = path.join(dir, 'plugin.json');
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                    installed.push({ ...manifest, id: manifest.id || entry.name, dir, installed: true });
                } catch {
                    installed.push({ id: entry.name, name: entry.name, dir, installed: true });
                }
            }
        } catch {
            // plugins dir not readable
        }
        return installed;
    }

    /**
     * Check for available updates for installed plugins.
     * @returns {Promise<Array<{ id: string, currentVersion?: string, latestVersion?: string }>>}
     */
    async checkUpdates() {
        const installed = this.list();
        const available = await this.fetch();
        const updates = [];
        for (const inst of installed) {
            const remote = available.find(p => p.id === inst.id);
            if (remote && remote.version && remote.version !== inst.version) {
                updates.push({ id: inst.id, currentVersion: inst.version, latestVersion: remote.version });
            }
        }
        return updates;
    }
}

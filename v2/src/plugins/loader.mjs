/**
 * Plugin Loader — load plugins from directory, git, npm, or the freeCode registry.
 *
 * Plugins can provide: tools, agents, skills, hooks.
 * Plugin format: a directory with a plugin.json manifest.
 *
 * v4.5-A: Added loadFromRegistry() with hot-reload support.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { pathToFileURL } from 'url';
import { RegistryClient } from './registry-client.mjs';

export class PluginLoader {
    /**
     * @param {string} [pluginDir] - directory to scan for plugins
     */
    constructor(pluginDir) {
        this.pluginDir = pluginDir ||
            path.join(os.homedir(), '.claude', 'plugins');
        this.plugins = new Map();
        this._liveModules = new Map(); // pluginId → live ES module export
        this._watchers    = new Map(); // pluginId → fs.FSWatcher
    }

    /**
     * Load plugins from the plugin directory.
     * @returns {Array<object>} loaded plugin manifests
     */
    async loadFromDirectory(dir) {
        const targetDir = dir || this.pluginDir;
        const loaded = [];

        try {
            if (!fs.existsSync(targetDir)) return loaded;

            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const manifestPath = path.join(targetDir, entry.name, 'plugin.json');
                if (!fs.existsSync(manifestPath)) continue;

                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                    manifest._dir = path.join(targetDir, entry.name);
                    manifest._name = entry.name;
                    this.plugins.set(manifest.name || entry.name, manifest);
                    loaded.push(manifest);
                } catch {
                    // Skip malformed plugins
                }
            }
        } catch {
            // Directory not readable
        }

        return loaded;
    }

    /**
     * Clone a plugin from a git repo and load it.
     * @param {string} repoUrl - git repository URL
     * @param {string} [name] - plugin name (default: repo name)
     * @returns {object|null} loaded manifest
     */
    async loadFromGit(repoUrl, name) {
        const pluginName = name || repoUrl.split('/').pop()?.replace('.git', '') || 'plugin';
        const targetDir = path.join(this.pluginDir, pluginName);

        try {
            fs.mkdirSync(this.pluginDir, { recursive: true });

            if (fs.existsSync(targetDir)) {
                // Update existing
                execSync('git pull', { cwd: targetDir, stdio: 'pipe' });
            } else {
                // Clone new
                execSync(`git clone --depth 1 ${repoUrl} ${targetDir}`, { stdio: 'pipe' });
            }

            const manifestPath = path.join(targetDir, 'plugin.json');
            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                manifest._dir = targetDir;
                manifest._name = pluginName;
                this.plugins.set(manifest.name || pluginName, manifest);
                return manifest;
            }
        } catch {
            // Git operation failed
        }

        return null;
    }

    /**
     * Get all installed plugins.
     * @returns {Array<object>}
     */
    getInstalledPlugins() {
        return [...this.plugins.values()];
    }

    /**
     * Get a plugin by name.
     * @param {string} name
     * @returns {object|undefined}
     */
    getPlugin(name) {
        return this.plugins.get(name);
    }

    /**
     * Remove a plugin by name.
     * @param {string} name
     * @returns {boolean}
     */
    removePlugin(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) return false;

        try {
            if (plugin._dir && fs.existsSync(plugin._dir)) {
                fs.rmSync(plugin._dir, { recursive: true, force: true });
            }
        } catch {
            // Best effort
        }

        return this.plugins.delete(name);
    }

    /**
     * Load plugins from the freeCode plugin registry.
     * Installs any registry-listed plugins not yet present, then loads all.
     * @param {object} [options]
     * @param {boolean} [options.hotReload=false] - watch plugin files for changes
     * @returns {Promise<Array<object>>} loaded plugin manifests
     */
    async loadFromRegistry(options = {}) {
        const client = new RegistryClient({ pluginsDir: this.pluginDir });
        const available = await client.fetch();
        const loaded = [];

        for (const plugin of available) {
            const dir = path.join(this.pluginDir, plugin.id);
            if (!fs.existsSync(dir)) continue; // only load already-installed plugins

            const manifestPath = path.join(dir, 'plugin.json');
            if (!fs.existsSync(manifestPath)) continue;

            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                manifest._dir  = dir;
                manifest._name = plugin.id;
                this.plugins.set(manifest.name || plugin.id, manifest);

                // Load the plugin's ES module index if present
                const indexPath = path.join(dir, 'index.mjs');
                if (fs.existsSync(indexPath)) {
                    try {
                        const mod = await import(pathToFileURL(indexPath).href);
                        this._liveModules.set(plugin.id, mod.default || mod);
                        manifest._module = this._liveModules.get(plugin.id);

                        if (options.hotReload) {
                            this._watchPlugin(plugin.id, dir);
                        }
                    } catch {
                        // Module load failed — plugin still registered by manifest
                    }
                }

                loaded.push(manifest);
            } catch {
                // Skip malformed plugins
            }
        }

        return loaded;
    }

    /**
     * Get the live module export for a plugin (if loaded via loadFromRegistry).
     * @param {string} pluginId
     * @returns {object|null}
     */
    getLiveModule(pluginId) {
        return this._liveModules.get(pluginId) || null;
    }

    /**
     * Stop watching all plugins.
     */
    stopWatching() {
        for (const watcher of this._watchers.values()) {
            try { watcher.close(); } catch { /* ignore */ }
        }
        this._watchers.clear();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    async _watchPlugin(pluginId, dir) {
        const indexPath = path.join(dir, 'index.mjs');
        if (this._watchers.has(pluginId)) return;
        try {
            const watcher = fs.watch(dir, { recursive: true }, async (event, filename) => {
                if (!filename || !filename.endsWith('.mjs')) return;
                try {
                    // Re-import with cache-bust via URL query param
                    const url = pathToFileURL(indexPath).href + '?t=' + Date.now();
                    const mod = await import(url);
                    this._liveModules.set(pluginId, mod.default || mod);
                    const plugin = this.plugins.get(pluginId) || this.plugins.get(
                        [...this.plugins.values()].find(p => p._name === pluginId)?.name
                    );
                    if (plugin) plugin._module = this._liveModules.get(pluginId);
                } catch { /* hot-reload failed silently */ }
            });
            this._watchers.set(pluginId, watcher);
        } catch { /* watching not supported */ }
    }

    /**
     * Get plugin count.
     * @returns {number}
     */
    count() {
        return this.plugins.size;
    }
}

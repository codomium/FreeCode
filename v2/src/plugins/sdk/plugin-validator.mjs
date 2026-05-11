/**
 * plugin-validator.mjs — validates plugin manifests and index files (v4.5-B)
 */

const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'version', 'description'];

/**
 * Validate a plugin manifest object.
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object') {
        return { valid: false, errors: ['manifest must be an object'] };
    }
    for (const field of REQUIRED_MANIFEST_FIELDS) {
        if (!manifest[field]) errors.push(`Missing required field: ${field}`);
    }
    if (manifest.id && !/^[a-z0-9-_]+$/.test(manifest.id)) {
        errors.push('id must be lowercase alphanumeric with hyphens/underscores');
    }
    if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        errors.push('version must follow semver (e.g. 1.0.0)');
    }
    return { valid: errors.length === 0, errors };
}

/**
 * Validate a plugin index module export.
 * @param {object} pluginExport - the default export from a plugin's index.mjs
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePluginExport(pluginExport) {
    const errors = [];
    if (!pluginExport || typeof pluginExport !== 'object') {
        return { valid: false, errors: ['plugin export must be an object'] };
    }

    if (pluginExport.tools !== undefined) {
        if (!Array.isArray(pluginExport.tools)) {
            errors.push('tools must be an array');
        } else {
            for (let i = 0; i < pluginExport.tools.length; i++) {
                const tool = pluginExport.tools[i];
                if (!tool.name)        errors.push(`tools[${i}]: name required`);
                if (!tool.description) errors.push(`tools[${i}]: description required`);
                if (!tool.call)        errors.push(`tools[${i}]: call function required`);
            }
        }
    }

    if (pluginExport.skills !== undefined && !Array.isArray(pluginExport.skills)) {
        errors.push('skills must be an array');
    }

    if (pluginExport.systemPromptAdditions !== undefined &&
        typeof pluginExport.systemPromptAdditions !== 'string') {
        errors.push('systemPromptAdditions must be a string');
    }

    return { valid: errors.length === 0, errors };
}

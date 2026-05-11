/**
 * tool-builder.mjs — SDK helper for building freeCode plugin tools (v4.5-B)
 *
 * Provides a fluent builder API that validates the plugin tool definition
 * and produces a tool descriptor compatible with createToolRegistry.
 */

export class ToolBuilder {
    constructor() {
        this._name        = null;
        this._description = null;
        this._properties  = {};
        this._required    = [];
        this._handler     = null;
        this._validator   = null;
    }

    /** @param {string} name */
    name(name) { this._name = name; return this; }

    /** @param {string} desc */
    description(desc) { this._description = desc; return this; }

    /**
     * Add an input parameter.
     * @param {string} name
     * @param {{ type: string, description?: string, enum?: string[] }} schema
     * @param {boolean} [required=false]
     */
    param(name, schema, required = false) {
        this._properties[name] = schema;
        if (required) this._required.push(name);
        return this;
    }

    /**
     * Set a custom validator function.
     * @param {(input: object) => string[]} fn - return array of error messages
     */
    validator(fn) { this._validator = fn; return this; }

    /**
     * Set the tool handler function.
     * @param {(input: object) => Promise<string>} fn
     */
    handler(fn) { this._handler = fn; return this; }

    /**
     * Build and return the tool descriptor.
     * @returns {{ name, description, inputSchema, validateInput, call }}
     */
    build() {
        if (!this._name)        throw new Error('ToolBuilder: name is required');
        if (!this._description) throw new Error('ToolBuilder: description is required');
        if (!this._handler)     throw new Error('ToolBuilder: handler is required');

        const self = this;
        return {
            name:        this._name,
            description: this._description,
            inputSchema: {
                type:       'object',
                properties: this._properties,
                required:   this._required,
            },
            validateInput(input) {
                if (self._validator) return self._validator(input);
                const errors = [];
                for (const req of self._required) {
                    if (input[req] == null) errors.push(`${req} is required`);
                }
                return errors;
            },
            async call(input) {
                return self._handler(input);
            },
        };
    }
}

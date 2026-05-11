'use strict';
/**
 * logger.js — Structured JSON logger for the FreeCode VS Code extension.
 *
 * All log lines are written as single-line JSON to a VS Code OutputChannel so
 * they can be inspected in the "Output" panel under "FreeCode".
 *
 * Usage:
 *   const { FreeCodeLogger } = require('./logger');
 *   const logger = new FreeCodeLogger(vscode.window.createOutputChannel('FreeCode'));
 *   logger.info('autocomplete', 'Provider request succeeded', { model: 'claude-haiku' });
 *   logger.error('bridge', 'Bridge crashed', { error: err.message });
 */

class FreeCodeLogger {
    /**
     * @param {import('vscode').OutputChannel} outputChannel
     */
    constructor(outputChannel) {
        this.channel = outputChannel;
        /** 'debug' | 'info' | 'warn' | 'error' */
        this.level = 'info';
    }

    /**
     * Emit a structured log entry.
     * @param {'debug'|'info'|'warn'|'error'} level
     * @param {string} component  Short component name, e.g. 'autocomplete'
     * @param {string} message    Human-readable message
     * @param {object} [meta]     Optional key-value metadata
     */
    log(level, component, message, meta = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            component,
            message,
            ...meta,
        };
        const line = JSON.stringify(entry);
        this.channel.appendLine(line);
        if (level === 'error') console.error(line);
    }

    debug(component, msg, meta) {
        if (this.level === 'debug') this.log('debug', component, msg, meta);
    }

    info(component, msg, meta) {
        this.log('info', component, msg, meta);
    }

    warn(component, msg, meta) {
        this.log('warn', component, msg, meta);
    }

    error(component, msg, meta) {
        this.log('error', component, msg, meta);
    }
}

module.exports = { FreeCodeLogger };

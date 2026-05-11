'use strict';
/**
 * agent-worker.js — Electron Worker Thread for the Agent Loop (v4.0-B)
 *
 * Runs in a Worker Thread via `worker_threads`.
 * Imports v2/src/core/agent-loop.mjs dynamically.
 *
 * Communication protocol (structured clone over parentPort):
 *   Main → Worker:  { type: 'run', userMessage, settings, tools, permissions }
 *                   { type: 'tool_result', toolUseId, result }
 *                   { type: 'abort' }
 *   Worker → Main:  All agent-loop events (assistant, tool_progress, result, stop, error, …)
 *                   { type: 'ready' }   — worker is initialized and idle
 *                   { type: 'worker_error', message } — unhandled worker crash
 */

const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const { pathToFileURL } = require('url');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

let agentLoopModule = null;
let activeGenerator = null;

/** Post a structured message back to the main thread. */
function post(msg) {
    try {
        parentPort.postMessage(msg);
    } catch (err) {
        // If the port is closed, swallow the error gracefully
        if (!/closed/i.test(err.message)) throw err;
    }
}

/** Load the v2 agent-loop module (ES module, loaded once). */
async function loadAgentLoop() {
    if (agentLoopModule) return agentLoopModule;
    // Locate v2/src — same strategy as main.js findV2Src()
    const candidates = [
        path.join(__dirname, '..', 'v2', 'src'),
        path.join(process.resourcesPath || '', 'v2', 'src'),
    ];
    let v2Src = null;
    const fs = require('fs');
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'core', 'agent-loop.mjs'))) {
            v2Src = c;
            break;
        }
    }
    if (!v2Src) throw new Error('agent-worker: cannot locate v2/src');

    const moduleUrl = pathToFileURL(path.join(v2Src, 'core', 'agent-loop.mjs')).href;
    agentLoopModule = await import(moduleUrl);
    return agentLoopModule;
}

// ── Message handler ───────────────────────────────────────────────────────────

parentPort.on('message', async (msg) => {
    if (msg.type === 'run') {
        await handleRun(msg);
    } else if (msg.type === 'abort') {
        handleAbort();
    }
});

/** Handle a 'run' message: execute the agent loop and stream events back. */
async function handleRun(msg) {
    const { userMessage, settings = {}, toolsConfig, permissionsConfig } = msg;

    try {
        const mod = await loadAgentLoop();

        // Dynamically import tool registry and permission checker
        const v2Src = path.join(__dirname, '..', 'v2', 'src');
        const registryMod = await import(pathToFileURL(path.join(v2Src, 'tools', 'registry.mjs')).href);
        const permsMod    = await import(pathToFileURL(path.join(v2Src, 'permissions', 'checker.mjs')).href);

        const tools       = registryMod.createToolRegistry(toolsConfig);
        const permissions = permsMod.createPermissionChecker(permissionsConfig || { defaultMode: 'auto' });

        const loop = mod.createAgentLoop({
            model:       settings.model || 'claude-opus-4-5',
            tools,
            permissions,
            settings:    settings.agentSettings || {},
            hooks:       null,
        });

        activeGenerator = loop.run(userMessage);

        for await (const event of activeGenerator) {
            post(event);
            if (event.type === 'stop' || event.type === 'error') break;
        }

        activeGenerator = null;
        post({ type: 'ready' });
    } catch (err) {
        activeGenerator = null;
        post({ type: 'worker_error', message: err.message, stack: err.stack });
        post({ type: 'ready' });
    }
}

/** Abort the current run. */
function handleAbort() {
    if (activeGenerator && typeof activeGenerator.return === 'function') {
        activeGenerator.return(undefined);
        activeGenerator = null;
    }
    post({ type: 'ready' });
}

// ── Signal readiness ──────────────────────────────────────────────────────────

// Emit 'ready' once the worker event loop is running
setImmediate(() => post({ type: 'ready' }));

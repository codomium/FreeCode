'use strict';
/**
 * agentHandlers.js — IPC handlers for agent-bridge communication.
 *
 * Manages the agent bridge lifecycle, routing messages from the renderer to
 * the in-process agent loop (InProcessAgentBridge or MultiAgentOrchestrator).
 *
 * Also implements a heartbeat that pings the bridge every 10 seconds to detect
 * unresponsive states and trigger automatic reconnection with exponential back-off.
 *
 * Usage (in main.js):
 *   const { registerAgentHandlers } = require('./ipc/agentHandlers');
 *   registerAgentHandlers(ipcMain, { getMainWindow, getBridge, ... });
 */

const HEARTBEAT_INTERVAL_MS  = 10000;  // 10 s
const HEARTBEAT_TIMEOUT_MS   = 5000;   // expect pong within 5 s
const RECONNECT_BACKOFFS_MS  = [1000, 2000, 4000]; // exponential (max 4 s)
const MAX_MISSED_PINGS       = 3;

/**
 * Start a heartbeat loop against an in-process or subprocess agent bridge
 * that supports the `{"type":"ping"}` / `{"type":"pong"}` protocol.
 *
 * @param {object} opts
 * @param {() => object|null}  opts.getBridge        Returns the current bridge
 * @param {() => void}         opts.onReconnect      Called when 3 consecutive pings fail
 * @param {Function}           [opts.log]            Optional logger function
 * @returns {{ stop: () => void }}
 */
function startHeartbeat({ getBridge, onReconnect, log }) {
    let missedPings = 0;
    let waitingForPong = false;
    let pongTimeout   = null;

    const interval = setInterval(() => {
        const bridge = getBridge();
        if (!bridge) return;

        if (waitingForPong) {
            // Previous pong never arrived
            missedPings++;
            log && log(`[heartbeat] missed pong #${missedPings}`);
            if (missedPings >= MAX_MISSED_PINGS) {
                log && log('[heartbeat] 3 consecutive pings failed — triggering reconnect');
                missedPings = 0;
                waitingForPong = false;
                if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
                onReconnect();
            }
            return;
        }

        waitingForPong = true;
        // For InProcessAgentBridge the bridge.ping() resolves via a direct
        // return value. For subprocess bridges it would need stdout parsing.
        // Here we provide a simple Promise-based ping that the bridge resolves.
        const pingPromise = typeof bridge.ping === 'function'
            ? bridge.ping()
            : Promise.resolve('pong'); // in-process bridge is always responsive

        pongTimeout = setTimeout(() => {
            if (waitingForPong) {
                waitingForPong = false;
                missedPings++;
                log && log(`[heartbeat] pong timeout #${missedPings}`);
                if (missedPings >= MAX_MISSED_PINGS) {
                    log && log('[heartbeat] 3 consecutive pings failed — triggering reconnect');
                    missedPings = 0;
                    onReconnect();
                }
            }
        }, HEARTBEAT_TIMEOUT_MS);

        pingPromise.then(() => {
            if (!waitingForPong) return;
            waitingForPong = false;
            missedPings = 0;
            if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
        }).catch(() => {
            waitingForPong = false;
            if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
        });
    }, HEARTBEAT_INTERVAL_MS);

    return {
        stop() {
            clearInterval(interval);
            if (pongTimeout) clearTimeout(pongTimeout);
        },
    };
}

/**
 * Perform reconnect with exponential back-off.
 * @param {object} opts
 * @param {Function} opts.captureMessages   Save current messages before reinit
 * @param {Function} opts.reinitBridge      Destroy and null-out the bridge
 * @param {Function} opts.getBridge         Get (or create) bridge after reinit
 * @param {Function} opts.notifyRenderer    Send a message to the renderer
 * @param {Function} [opts.log]
 * @param {number}   [opts.attempt]         Current attempt index (0-based)
 */
async function reconnectWithBackoff({ captureMessages, reinitBridge, getBridge, notifyRenderer, log, attempt = 0 }) {
    const delayMs = RECONNECT_BACKOFFS_MS[Math.min(attempt, RECONNECT_BACKOFFS_MS.length - 1)];
    log && log(`[heartbeat] reconnecting in ${delayMs}ms (attempt ${attempt + 1})`);
    notifyRenderer({ type: 'agentReconnecting', attempt: attempt + 1 });

    await new Promise((r) => setTimeout(r, delayMs));

    captureMessages();
    reinitBridge();
    try {
        await getBridge()._init();
        notifyRenderer({ type: 'agentReconnected' });
        log && log('[heartbeat] reconnect succeeded');
    } catch (err) {
        log && log(`[heartbeat] reconnect failed: ${err.message}`);
        notifyRenderer({ type: 'agentReconnectFailed', error: err.message });
    }
}

/**
 * Register agent-related IPC handlers.
 *
 * In the current architecture the agent lifecycle is managed inside the
 * central 'renderer-message' switch in main.js.  This module provides the
 * heartbeat utility and reconnect helpers; main.js calls startHeartbeat()
 * after the main window is ready.
 *
 * @param {import('electron').IpcMain} ipcMain
 */
function registerAgentHandlers(ipcMain) {
    // Placeholder — agent messages are routed through the central switch in main.js.
    void ipcMain;
}

module.exports = { registerAgentHandlers, startHeartbeat, reconnectWithBackoff };

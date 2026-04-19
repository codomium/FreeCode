/**
 * Bash Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - Timeout with SIGTERM -> SIGKILL escalation
 * - run_in_background option
 * - description parameter
 * - 1MB output limit
 * - ANSI code stripping by default
 * - Live streaming output via async generator
 * - Interactive stdin via sendBashStdin(jobId, text)
 * - Windows support: uses PowerShell when bash is unavailable
 */
import { spawn } from 'child_process';

/** Detect the best available shell on this platform. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Return [shell, args] for executing a command string.
 * On Windows uses PowerShell (preferred) or cmd.exe.
 * On Unix uses bash.
 */
function getShellArgs(command) {
    if (IS_WINDOWS) {
        // PowerShell gives better POSIX-like behaviour than cmd.exe
        return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]];
    }
    return ['bash', ['-c', command]];
}

// Strip ANSI escape sequences
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

// Active interactive bash processes keyed by job ID (for stdin injection)
const activeBashStdins = new Map(); // jobId -> WritableStream (proc.stdin)
let bashJobCounter = 0;

/**
 * Send stdin text to a running interactive Bash job.
 * A newline is automatically appended.
 * @param {number} jobId
 * @param {string} text
 */
export function sendBashStdin(jobId, text) {
    const stdin = activeBashStdins.get(jobId);
    if (stdin && !stdin.destroyed) {
        stdin.write(text + '\n');
    }
}

export const BashTool = {
    name: 'Bash',
    description: 'Execute a bash command and return its output.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The command to execute' },
            timeout: { type: 'number', description: 'Timeout in ms (max 600000)', default: 120000 },
            description: { type: 'string', description: 'Description of what this command does' },
            run_in_background: { type: 'boolean', description: 'Run in background', default: false },
        },
        required: ['command'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.command) errors.push('command is required');
        return errors;
    },

    /**
     * Returns an AsyncGenerator that yields:
     *   { type: 'meta', jobId }          — once, immediately
     *   { type: 'chunk', stream, data }  — for each stdout/stderr chunk
     *   { type: 'done', result }         — once, when the process exits
     *
     * This allows the agent loop to stream output to the UI in real time
     * and to provide interactive stdin via sendBashStdin(jobId, text).
     */
    async *call(input) {
        const timeout = Math.min(input.timeout || 120000, 600000);

        if (input.run_in_background) {
            yield { type: 'done', result: runBackground(input.command) };
            return;
        }

        const jobId = ++bashJobCounter;

        // Queue-based bridge between event callbacks and the async generator.
        // Events pushed here are consumed by the while-loop below.
        const queue = [];
        let queueResolve = null; // called when new events are pushed

        const push = (item) => {
            queue.push(item);
            if (queueResolve) { const r = queueResolve; queueResolve = null; r(); }
        };

        const waitForPush = () => new Promise((resolve) => {
            if (queue.length > 0) { resolve(); return; }
            queueResolve = resolve;
        });

        let stdout = '';
        let stderr = '';
        let killed = false;
        let finalResult = '';

        const [shell, shellArgs] = getShellArgs(input.command);
        const proc = spawn(shell, shellArgs, {
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Keep stdin open for interactive input
        activeBashStdins.set(jobId, proc.stdin);

        proc.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            if (stdout.length < MAX_OUTPUT_BYTES) {
                stdout += text;
                push({ type: 'chunk', stream: 'stdout', data: stripAnsi(text) });
            }
        });

        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            if (stderr.length < MAX_OUTPUT_BYTES) {
                stderr += text;
                push({ type: 'chunk', stream: 'stderr', data: stripAnsi(text) });
            }
        });

        // Timeout: SIGTERM first, SIGKILL after 5 s
        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already exited */ } }, 5000);
        }, timeout);

        proc.on('close', (code) => {
            clearTimeout(timer);
            activeBashStdins.delete(jobId);

            let out = stdout.slice(0, MAX_OUTPUT_BYTES);
            let err = stderr.slice(0, MAX_OUTPUT_BYTES);
            out = stripAnsi(out);
            err = stripAnsi(err);

            if (killed) {
                finalResult = `Error: Command timed out after ${timeout}ms\n${out}\n${err}`.trim();
            } else {
                const combined = (out + (err ? '\n' + err : '')).trim();
                finalResult = code !== 0
                    ? `Exit code: ${code}\n${combined}`.trim()
                    : combined || '(no output)';
            }

            push({ type: 'done' });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            activeBashStdins.delete(jobId);
            finalResult = `Error: ${err.message}`;
            push({ type: 'done' });
        });

        // Yield job metadata first so the UI can associate stdin with this job
        yield { type: 'meta', jobId };

        // Drain the event queue until 'done' is received
        while (true) {
            await waitForPush();
            while (queue.length > 0) {
                const item = queue.shift();
                if (item.type === 'done') {
                    yield { type: 'done', result: finalResult };
                    return;
                }
                yield item;
            }
        }
    },
};

// Background jobs store
const backgroundJobs = new Map();
let bgJobId = 0;

function runBackground(command) {
    const id = ++bgJobId;
    const [shell, shellArgs] = getShellArgs(command);
    const proc = spawn(shell, shellArgs, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const job = { id, pid: proc.pid, command, status: 'running', stdout: '', stderr: '' };
    backgroundJobs.set(id, job);

    proc.on('close', (code) => {
        job.status = code === 0 ? 'completed' : `exited(${code})`;
        job.stdout = stripAnsi(stdout.slice(0, MAX_OUTPUT_BYTES));
        job.stderr = stripAnsi(stderr.slice(0, MAX_OUTPUT_BYTES));
    });

    proc.unref();
    return `Background job started: id=${id}, pid=${proc.pid}`;
}

export { backgroundJobs, activeBashStdins };

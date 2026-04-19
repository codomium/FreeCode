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
 * - Windows support:
 *     1. Tries WSL (wsl.exe) first — works on Windows 11 with WSL installed.
 *     2. Falls back to PowerShell if WSL is not available.
 */
import { spawn, spawnSync } from 'child_process';

/** Detect platform once at module load time. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Check whether WSL is available on this Windows machine.
 * Runs `wsl.exe --status` synchronously and caches the result.
 * Returns false on non-Windows platforms.
 */
let _wslAvailable = null;
function isWslAvailable() {
    if (!IS_WINDOWS) return false;
    if (_wslAvailable !== null) return _wslAvailable;
    try {
        // `wsl.exe --status` exits 0 if WSL is installed and functional.
        const result = spawnSync('wsl.exe', ['--status'], {
            encoding: 'utf-8',
            timeout: 5000,
            // Suppress the console window that would flash on Windows
            windowsHide: true,
        });
        _wslAvailable = result.status === 0;
    } catch {
        _wslAvailable = false;
    }
    return _wslAvailable;
}

/**
 * Return [shell, args] for executing a command string.
 *
 * Priority on Windows:
 *   1. WSL  — `wsl.exe bash -c "<command>"`  (preferred; full POSIX bash)
 *   2. PowerShell — `powershell.exe -NoProfile -NonInteractive -Command "<command>"`
 *      Prepends POSIX compatibility shims so that common Unix commands like
 *      `which`, `grep`, `cat`, and `touch` work correctly without WSL.
 *
 * On Unix / macOS: `bash -c "<command>"`
 */

/**
 * Minimal POSIX-compatibility shims injected before every PowerShell command.
 * These replace the most-common Unix utilities that PowerShell lacks natively.
 */
const POWERSHELL_POSIX_SHIMS = [
    // which → resolve binary path via Get-Command
    'function which { param([string]$cmd) $r = Get-Command $cmd -ErrorAction SilentlyContinue; if ($r) { $r.Source } else { Write-Error "which: $cmd not found" } }',
    // grep → thin wrapper around Select-String; handles both piped and file input
    'function grep { param([string]$pattern, [Parameter(ValueFromRemainingArguments)][string[]]$paths) if ($paths) { Select-String -Pattern $pattern -Path $paths | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" } } else { $input | Select-String -Pattern $pattern | ForEach-Object { $_.Line } } }',
    // cat → print file contents
    'function cat { param([Parameter(ValueFromRemainingArguments)][string[]]$paths) Get-Content $paths }',
    // touch → create or update file timestamp
    'function touch { param([string]$path) if (Test-Path $path) { (Get-Item $path).LastWriteTime = Get-Date } else { New-Item -ItemType File -Path $path -Force | Out-Null } }',
    // wc -l shim: count lines from stdin
    'function wc { param([string]$flag) if ($flag -eq "-l") { $c = 0; $input | ForEach-Object { $c++ }; $c } }',
].join('; ');

function getShellArgs(command) {
    if (IS_WINDOWS) {
        if (isWslAvailable()) {
            // Run the command inside the default WSL distro's bash shell.
            // `wsl.exe bash -c "..."` passes the command string directly to bash.
            return ['wsl.exe', ['bash', '-c', command]];
        }
        // WSL not available — fall back to PowerShell with POSIX shims prepended.
        // Note: PowerShell is available on every modern Windows install.
        const wrapped = `${POWERSHELL_POSIX_SHIMS}; ${command}`;
        return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped]];
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

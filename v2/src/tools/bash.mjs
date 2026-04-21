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
 *     Always uses PowerShell (powershell.exe) on Windows.
 *     POSIX compatibility shims are injected so that common Unix commands
 *     like `which`, `grep`, `cat`, and `touch` work inside PowerShell.
 *     WSL is intentionally skipped to avoid line-ending (\r\n) issues and
 *     path-translation errors that occur when mixing Windows and WSL paths.
 */
import { spawn } from 'child_process';

/** Detect platform once at module load time. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Return the name of the active shell for display purposes.
 * Used by UI components to show "PowerShell" (Windows) or "bash" (Unix/macOS).
 */
export function getActiveShellName() {
    return IS_WINDOWS ? 'PowerShell' : 'bash';
}

/**
 * Return [shell, args] for executing a command string.
 *
 * On Windows: always uses PowerShell (`powershell.exe -NoProfile -NonInteractive -Command ...`).
 *   POSIX compatibility shims are prepended so that common Unix commands work
 *   without requiring WSL.  WSL is intentionally bypassed to prevent
 *   `bash\r` line-ending errors and Windows-path / WSL-path mismatches.
 *
 * On Unix / macOS: `bash -c "<command>"`
 */

/**
 * Minimal POSIX-compatibility shims injected before every PowerShell command.
 * These replace the most-common Unix utilities that PowerShell lacks natively.
 */
const POWERSHELL_POSIX_SHIMS = [
    // which: resolve a binary's full path via Get-Command (mirrors `which cmd`)
    'function which { param([string]$cmd)' +
        ' $r = Get-Command $cmd -ErrorAction SilentlyContinue;' +
        ' if ($r) { $r.Source } else { Write-Error "which: $cmd not found" } }',

    // grep: thin wrapper around Select-String.
    //   - With file args: grep <pattern> <file…> → path:line:text
    //   - Without file args (piped): … | grep <pattern> → matching lines
    'function grep { param([string]$pattern, [Parameter(ValueFromRemainingArguments)][string[]]$paths)' +
        ' if ($paths) {' +
        '   Select-String -Pattern $pattern -Path $paths |' +
        '   ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }' +
        ' } else {' +
        '   $input | Select-String -Pattern $pattern | ForEach-Object { $_.Line }' +
        ' } }',

    // cat: print one or more files (mirrors `cat file…`)
    'function cat { param([Parameter(ValueFromRemainingArguments)][string[]]$paths)' +
        ' Get-Content $paths }',

    // touch: create file if missing, or update its timestamp (mirrors `touch path`)
    'function touch { param([string]$path)' +
        ' if (Test-Path $path) { (Get-Item $path).LastWriteTime = Get-Date }' +
        ' else { New-Item -ItemType File -Path $path -Force | Out-Null } }',

    // wc -l / wc -c / wc -w: count lines/chars/words from piped stdin
    'function wc { param([string]$flag)' +
        ' $lines = @($input);' +
        ' if ($flag -eq "-l") { $lines.Count }' +
        ' elseif ($flag -eq "-c") { ($lines -join "`n").Length }' +
        ' elseif ($flag -eq "-w") { ($lines | ForEach-Object { ($_ -split "\\s+" | Where-Object { $_ -ne "" }).Count } | Measure-Object -Sum).Sum }' +
        ' else { $lines.Count } }',

    // ls: list directory contents (mirrors `ls [-la] [path]`)
    'function ls { param([string]$flags="", [string]$p=".")' +
        ' $showHidden = $flags -match "a";' +
        ' $long = $flags -match "l";' +
        ' $items = Get-ChildItem -Path $p -Force:$showHidden;' +
        ' if ($long) { $items | Format-Table Mode,LastWriteTime,Length,Name -AutoSize }' +
        ' else { $items | ForEach-Object { $_.Name } } }',

    // mkdir -p: create directory tree without error if exists
    'function mkdir { param([string]$flag="", [Parameter(ValueFromRemainingArguments)][string[]]$paths)' +
        ' $allPaths = if ($flag -ne "-p" -and $flag -ne "") { @($flag) + $paths } else { $paths };' +
        ' foreach ($d in $allPaths) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }',

    // rm: remove files/directories (supports -rf)
    'function rm { param([string]$flags="", [Parameter(ValueFromRemainingArguments)][string[]]$paths)' +
        ' $allPaths = if ($flags -notmatch "^-") { @($flags) + $paths } else { $paths };' +
        ' $recurse = $flags -match "r";' +
        ' $force = $flags -match "f";' +
        ' foreach ($p in $allPaths) {' +
        '   if (Test-Path $p) { Remove-Item -Path $p -Recurse:$recurse -Force:$force } } }',

    // mv: move/rename files
    'function mv { param([string]$src, [string]$dst)' +
        ' Move-Item -Path $src -Destination $dst -Force }',

    // cp: copy files (supports -r for recursive)
    'function cp { param([string]$flags="", [string]$src="", [string]$dst="")' +
        ' if ($flags -notmatch "^-") { $dst = $src; $src = $flags; $flags = "" };' +
        ' $recurse = $flags -match "r";' +
        ' Copy-Item -Path $src -Destination $dst -Recurse:$recurse -Force }',

    // head: first N lines (default 10) from file or piped stdin
    'function head { param([string]$flag="", [string]$file="")' +
        ' $n = 10;' +
        ' if ($flag -match "^-n$" -or $flag -match "^-\\d") {' +
        '   if ($flag -match "^-(\\d+)$") { $n = [int]$Matches[1] }' +
        '   elseif ($flag -eq "-n") { $n = [int]$file; $file = "" }' +
        ' } elseif ($flag -ne "") { $file = $flag }' +
        ' if ($file) { Get-Content $file | Select-Object -First $n }' +
        ' else { $input | Select-Object -First $n } }',

    // tail: last N lines (default 10) from file or piped stdin
    'function tail { param([string]$flag="", [string]$file="")' +
        ' $n = 10;' +
        ' if ($flag -match "^-n$" -or $flag -match "^-\\d") {' +
        '   if ($flag -match "^-(\\d+)$") { $n = [int]$Matches[1] }' +
        '   elseif ($flag -eq "-n") { $n = [int]$file; $file = "" }' +
        ' } elseif ($flag -ne "") { $file = $flag }' +
        ' if ($file) { Get-Content $file | Select-Object -Last $n }' +
        ' else { $input | Select-Object -Last $n } }',

    // sort: sort lines; -r for reverse, -u for unique
    'function sort { param([string]$flags="", [Parameter(ValueFromRemainingArguments)][string[]]$extra)' +
        ' $rev = $flags -match "r";' +
        ' $uniq = $flags -match "u";' +
        ' $lines = if ($flags -notmatch "^-") { @($flags) + $extra | ForEach-Object { $_ } }' +
        '          else { $input };' +
        ' $sorted = $lines | Sort-Object { $_ } -Descending:$rev;' +
        ' if ($uniq) { $sorted | Select-Object -Unique } else { $sorted } }',

    // uniq: deduplicate consecutive lines
    'function uniq { param([Parameter(ValueFromPipeline=$true)][string]$line)' +
        ' begin { $prev = $null }' +
        ' process { if ($line -ne $prev) { $line; $prev = $line } } }',

    // find: simplified find (mirrors `find <path> -name <pattern>`)
    'function find { param([string]$basePath=".", [string]$nameFlag="", [string]$namePattern="*")' +
        ' if ($nameFlag -ne "-name") { $namePattern = $nameFlag }' +
        ' Get-ChildItem -Path $basePath -Recurse -Filter $namePattern -Force |' +
        ' ForEach-Object { $_.FullName } }',

    // echo: print text (already exists in PS but alias may conflict)
    'function echo { param([Parameter(ValueFromRemainingArguments)][string[]]$args)' +
        ' Write-Output ($args -join " ") }',

    // diff: basic line diff between two files
    'function diff { param([string]$file1, [string]$file2)' +
        ' $a = Get-Content $file1; $b = Get-Content $file2;' +
        ' Compare-Object $a $b | ForEach-Object {' +
        '   $sign = if ($_.SideIndicator -eq "<=") { "<" } else { ">" };' +
        '   "$sign $($_.InputObject)" } }',

    // sed: very basic sed -i s/old/new/g substitute on a file
    'function sed { param([string]$expr, [string]$file="")' +
        ' if ($expr -match "^s/(.+)/(.+)/") {' +
        '   $from = $Matches[1]; $to = $Matches[2];' +
        '   if ($file) {' +
        '     (Get-Content $file) -replace $from,$to | Set-Content $file' +
        '   } else {' +
        '     $input -replace $from,$to' +
        '   }' +
        ' } }',

    // pwd: print working directory
    'function pwd { (Get-Location).Path }',

    // env: print environment variables
    'function env { Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" } }',
].join('; ');

function getShellArgs(command) {
    if (IS_WINDOWS) {
        // Always use PowerShell on Windows — no WSL, no bash.
        // Prepend POSIX shims so common Unix utilities work out of the box.
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
        // Normalize common alternative parameter names the model may use
        if (!input.command) {
            input.command = input.cmd ?? input.bash_command ?? input.shell_command ??
                            input.script ?? input.run ?? input.execute ??
                            input.bash ?? input.shell ?? input.code ?? null;
        }
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

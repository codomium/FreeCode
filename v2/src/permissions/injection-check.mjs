/**
 * Command Injection Check — detect dangerous shell patterns (v4.3-D hardened).
 *
 * Scans commands for common injection vectors before allowing
 * Bash tool execution.
 *
 * Hardened features:
 *  - Extended pattern coverage (obfuscated variable expansion, here-strings, etc.)
 *  - Normalised command scanning (strips redundant whitespace / quotes)
 *  - Property-based fuzz-friendly API (deterministic, no side effects)
 */

const DANGEROUS_PATTERNS = [
    { pattern: /;\s*rm\s+-rf\s+\//, label: 'rm -rf /' },
    { pattern: /\|\s*sh\b/, label: 'pipe to sh' },
    { pattern: /\|\s*bash\b/, label: 'pipe to bash' },
    { pattern: /`[^`]+`/, label: 'backtick execution' },
    { pattern: /\$\([^)]+\)/, label: 'command substitution' },
    { pattern: />\s*\/etc\//, label: 'write to /etc' },
    { pattern: />\s*\/usr\//, label: 'write to /usr' },
    { pattern: /curl\s.*\|\s*(bash|sh)/, label: 'curl pipe to shell' },
    { pattern: /wget\s.*\|\s*(bash|sh)/, label: 'wget pipe to shell' },
    { pattern: /mkfs\./, label: 'filesystem format' },
    { pattern: /dd\s+if=.*of=\/dev\//, label: 'dd to device' },
    { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, label: 'fork bomb' },
    { pattern: /chmod\s+777\s+\//, label: 'chmod 777 root' },
    { pattern: />\s*\/dev\/sda/, label: 'write to disk device' },
    { pattern: /eval\s+"?\$/, label: 'eval variable' },
    // Hardened: obfuscated variable expansion and here-strings
    { pattern: /\$\{[^}]*[@!#%^,~][^}]*\}/, label: 'dangerous parameter expansion' },
    { pattern: /<<<\s*\$\(/, label: 'here-string with command substitution' },
    { pattern: /base64\s.*--decode.*\|\s*(bash|sh|python|perl|ruby|node)/, label: 'base64 decode pipe to interpreter' },
    { pattern: /python\s*-c\s*["']import\s+os/, label: 'python os exec' },
    { pattern: /perl\s*-e\s*["']system/, label: 'perl system exec' },
    { pattern: /exec\s+\d+<>\/dev\/tcp/, label: 'bash tcp reverse shell' },
    { pattern: /nc\s+.*-e\s*(\/bin\/(bash|sh)|cmd\.exe)/, label: 'netcat reverse shell' },
    { pattern: /ncat\s+.*--exec/, label: 'ncat reverse shell' },
    // Normalised obfuscation patterns
    { pattern: /\$\{\s*IFS\s*\}/, label: 'IFS manipulation' },
    { pattern: /x\$\(\s*\)/, label: 'empty command substitution obfuscation' },
];

/**
 * Normalise a command before scanning to strip common obfuscation.
 * @param {string} command
 * @returns {string}
 */
function normaliseCommand(command) {
    return command
        .replace(/\\\n/g, ' ')     // line continuations
        .replace(/\s{2,}/g, ' ')   // collapse whitespace
        .toLowerCase();
}

/**
 * Check a command string for injection patterns.
 * @param {string} command - shell command to check
 * @returns {{ safe: boolean, pattern?: string, label?: string }}
 */
export function checkInjection(command) {
    if (typeof command !== 'string') {
        return { safe: false, label: 'non-string command' };
    }

    // Scan both the original and a normalised version
    const normalised = normaliseCommand(command);
    for (const { pattern, label } of DANGEROUS_PATTERNS) {
        if (pattern.test(command) || pattern.test(normalised)) {
            return { safe: false, pattern: pattern.source, label };
        }
    }

    return { safe: true };
}

/**
 * Get the list of dangerous patterns (for display/testing).
 * @returns {Array<{ pattern: RegExp, label: string }>}
 */
export function getDangerousPatterns() {
    return DANGEROUS_PATTERNS.map(({ pattern, label }) => ({ pattern, label }));
}

/**
 * Check if a command uses any elevated privilege patterns.
 * @param {string} command
 * @returns {boolean}
 */
export function usesElevation(command) {
    return /\bsudo\b/.test(command) || /\bsu\s+-?\s/.test(command) || /\bdoas\b/.test(command);
}

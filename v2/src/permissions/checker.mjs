/**
 * Permission Checker — 6 modes from decompiled Claude Code.
 *
 * Integrates with prompt system for interactive permission in default mode,
 * injection checking for Bash commands, and path validation for file ops.
 */

import { requiresPermission } from './prompt.mjs';
import { checkInjection } from './injection-check.mjs';
import { validatePath } from './path-check.mjs';

export function createPermissionChecker(config = {}) {
    const mode = config.defaultMode || process.env.CLAUDE_CODE_PERMISSION_MODE || 'default';
    const rl = config.rl || null; // readline interface for prompts
    // Optional async callback for interactive permission prompts (e.g. from Electron UI).
    // Signature: promptCallback(toolName, input) => Promise<boolean>
    const promptCallback = config.promptCallback || null;

    return {
        mode,
        async check(toolName, input) {
            // Always run injection check on Bash commands
            if (toolName === 'Bash' && input?.command) {
                const injection = checkInjection(input.command);
                if (!injection.safe) {
                    return false; // block dangerous commands
                }
            }

            // Always validate file paths for file operations
            if (['Edit', 'Write', 'Read', 'MultiEdit'].includes(toolName) && input?.file_path) {
                const pathResult = validatePath(input.file_path, { write: toolName !== 'Read' });
                if (!pathResult.safe) {
                    return false; // block unsafe paths
                }
            }

            // WebSearch and WebFetch are always allowed in every mode, including dontAsk.
            // SAFE_TOOLS in prompt.mjs covers default mode (no prompt); this guard covers
            // dontAsk mode which would otherwise block all tools unconditionally.
            if (['WebSearch', 'WebFetch'].includes(toolName)) return true;

            switch (mode) {
                case 'bypassPermissions': return true;
                case 'acceptEdits':
                    // Allow file ops and Bash in acceptEdits mode — user accepted all edits
                    return true;
                case 'auto': return true; // AI decides
                case 'dontAsk': return false; // deny everything not pre-approved
                case 'plan': return true; // All tools are allowed in plan mode
                case 'default':
                default:
                    // In default mode, safe read-only tools pass through without asking
                    if (!requiresPermission(toolName)) return true;
                    // If a UI callback is provided, use it to ask the user interactively
                    if (promptCallback) {
                        try {
                            return await promptCallback(toolName, input);
                        } catch (err) {
                            console.error('[PermissionChecker] promptCallback error:', err);
                            return false; // deny on error
                        }
                    }
                    // Without readline or callback (headless), allow by default
                    if (!rl) return true;
                    // With rl, would call promptPermission — allow for now
                    return true;
            }
        },
    };
}

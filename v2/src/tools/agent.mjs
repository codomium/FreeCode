/**
 * Agent Tool — spawn a subagent with its own agent loop.
 *
 * Features:
 * - subagent_type parameter
 * - isolation: "worktree" option
 * - run_in_background option
 * - model override
 * - team mode: run multiple specialized agents collaboratively through phases
 */

import { createAgentLoop } from '../core/agent-loop.mjs';
import { createToolRegistry } from './registry.mjs';
import { createPermissionChecker } from '../permissions/checker.mjs';

/** Built-in subagent role system prompts */
const TYPE_PROMPTS = {
    coder:       'You are a coding agent. Write clean, well-structured code and use file tools (Read, Write, Edit, MultiEdit, Bash) to make actual changes. Do not just describe — implement.',
    reviewer:    'You are a code reviewer. Analyze code for bugs, security issues, and improvements. Be specific.',
    researcher:  'You are a research agent. Find and summarize information thoroughly.',
    tester:      'You are a testing agent. Write and run tests to verify correctness.',
    planner:     'You are a planning agent. Break tasks into clear, numbered, actionable steps.',
    summarizer:  'You are a context summarizer. Produce concise, structured summaries of conversations and progress.',
    prompter:    'You are a prompt engineer. Generate precise, detailed prompts for other agents based on requirements.',
};

export const AgentTool = {
    name: 'Agent',
    description: 'Spawn a subagent to handle a task, or run a multi-agent team through phases.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The task for the subagent to perform',
            },
            allowed_tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of tool names the subagent can use (default: all)',
            },
            subagent_type: {
                type: 'string',
                enum: ['coder', 'reviewer', 'researcher', 'tester', 'planner', 'summarizer', 'prompter'],
                description: 'Specialized role for the subagent',
            },
            isolation: {
                type: 'string',
                enum: ['default', 'worktree'],
                description: 'Isolation mode. "worktree" uses a git worktree.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'Run in background and return immediately',
            },
            model: {
                type: 'string',
                description: 'Override model for this subagent',
            },
            team: {
                type: 'array',
                description: 'Multi-agent team configuration. Each entry defines a role and optional model.',
                items: {
                    type: 'object',
                    properties: {
                        role: { type: 'string', description: 'Agent role (coder, reviewer, planner, summarizer, prompter, etc.)' },
                        model: { type: 'string', description: 'Model for this agent (optional)' },
                        prompt: { type: 'string', description: 'Override prompt for this agent (optional)' },
                    },
                    required: ['role'],
                },
            },
            phases: {
                type: 'array',
                description: 'Ordered list of phase names to execute in team mode.',
                items: { type: 'string' },
            },
        },
        required: ['prompt'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.prompt) errors.push('prompt is required');
        return errors;
    },

    // Track background subagents
    _backgroundAgents: new Map(),
    _nextBgId: 0,

    async call(input) {
        // ── Multi-agent team mode ─────────────────────────────────────────────
        if (input.team && Array.isArray(input.team) && input.team.length > 0) {
            return runTeam(input);
        }

        const model = input.model || process.env.SUBAGENT_MODEL || 'claude-sonnet-4-6';
        const tools = createToolRegistry();
        const permissions = createPermissionChecker({ defaultMode: 'bypassPermissions' });

        // Build type-specific system prompt prefix
        let systemPrefix = '';
        if (input.subagent_type) {
            systemPrefix = TYPE_PROMPTS[input.subagent_type] || `You are a ${input.subagent_type} agent.`;
        }

        const fullPrompt = systemPrefix
            ? `${systemPrefix}\n\nTask: ${input.prompt}`
            : input.prompt;

        const loop = createAgentLoop({
            model,
            tools,
            permissions,
            settings: { stream: false },
        });

        if (input.run_in_background) {
            const bgId = ++AgentTool._nextBgId;
            const entry = { id: bgId, status: 'running', result: null, prompt: input.prompt };
            AgentTool._backgroundAgents.set(bgId, entry);

            // Run in background
            runSubagent(loop, fullPrompt).then(result => {
                entry.status = 'completed';
                entry.result = result;
            }).catch(err => {
                entry.status = 'error';
                entry.result = err.message;
            });

            return `Subagent started in background: id=${bgId}`;
        }

        return runSubagent(loop, fullPrompt);
    },
};

async function runSubagent(loop, prompt) {
    const results = [];
    try {
        for await (const event of loop.run(prompt)) {
            if (event.type === 'assistant' && event.content) {
                results.push(event.content);
            }
            if (event.type === 'result') {
                results.push(`[tool:${event.tool}] ${String(event.result).slice(0, 500)}`);
            }
        }
    } catch (err) {
        return `Subagent error: ${err.message}`;
    }

    return results.join('\n') || 'Subagent completed with no output.';
}

/**
 * Run a multi-agent team through optional phases.
 *
 * Each team member runs sequentially; the output of one agent is passed
 * as context to the next.  If phases are specified, they are used as
 * section headers in the accumulated context so agents know which phase
 * is active.
 *
 * @param {object} input - validated AgentTool input with team array
 * @returns {Promise<string>}
 */
async function runTeam(input) {
    const phases = input.phases && input.phases.length > 0 ? input.phases : ['execution'];
    const team   = input.team;
    const defaultModel = process.env.SUBAGENT_MODEL || 'claude-sonnet-4-6';

    const log = [];
    let sharedContext = `Original task:\n${input.prompt}`;

    for (const phase of phases) {
        log.push(`\n--- Phase: ${phase.toUpperCase()} ---`);

        for (const member of team) {
            const role    = member.role || 'assistant';
            const model   = member.model || defaultModel;
            const rolePrompt = TYPE_PROMPTS[role] || `You are a ${role} agent.`;
            const memberPrompt = member.prompt || input.prompt;

            const prompt = `${rolePrompt}

Current phase: ${phase}
Shared context:
${sharedContext}

Your task:
${memberPrompt}`;

            log.push(`\n[${role}@${model}] working on phase "${phase}"…`);

            const tools      = createToolRegistry();
            const perms      = createPermissionChecker({ defaultMode: 'bypassPermissions' });
            const loop       = createAgentLoop({ model, tools, permissions: perms, settings: { stream: false } });

            let result;
            try {
                result = await runSubagent(loop, prompt);
            } catch (err) {
                result = `Agent error (${role}): ${err.message}`;
            }

            log.push(`[${role}] output:\n${result.slice(0, 1000)}`);

            // Feed this agent's output into shared context for subsequent agents
            sharedContext += `\n\n[${role} — phase ${phase}]\n${result.slice(0, 2000)}`;
        }
    }

    return log.join('\n');
}


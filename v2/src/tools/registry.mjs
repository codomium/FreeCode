/**
 * Tool Registry — validateInput/call interface.
 * Mirrors Claude Code's tool dispatch system.
 * Registers all 25+ built-in tools.
 */

import { BashTool } from './bash.mjs';
import { ReadTool } from './read.mjs';
import { ReadManyTool } from './read-many.mjs';
import { EditTool } from './edit.mjs';
import { WriteTool } from './write.mjs';
import { GlobTool } from './glob.mjs';
import { GrepTool } from './grep.mjs';
import { AgentTool } from './agent.mjs';
import { WebFetchTool } from './web-fetch.mjs';
import { WebSearchTool } from './web-search.mjs';
import { TodoWriteTool } from './todo-write.mjs';
import { NotebookEditTool } from './notebook-edit.mjs';
import { MultiEditTool } from './multi-edit.mjs';
import { LsTool } from './ls.mjs';
import { ToolSearchTool } from './tool-search.mjs';
import { AskUserTool } from './ask-user.mjs';
import { EnterWorktreeTool } from './enter-worktree.mjs';
import { ExitWorktreeTool } from './exit-worktree.mjs';
import { SkillTool } from './skill.mjs';
import { SendMessageTool } from './send-message.mjs';
import { RemoteTriggerTool } from './remote-trigger.mjs';
import { CronCreateTool } from './cron-create.mjs';
import { CronDeleteTool } from './cron-delete.mjs';
import { CronListTool } from './cron-list.mjs';
import { LspTool } from './lsp.mjs';
import { ReadMcpResourceTool } from './read-mcp-resource.mjs';

const BUILTIN_TOOLS = [
    BashTool,
    ReadTool,
    ReadManyTool,
    EditTool,
    WriteTool,
    GlobTool,
    GrepTool,
    AgentTool,
    WebFetchTool,
    WebSearchTool,
    TodoWriteTool,
    NotebookEditTool,
    MultiEditTool,
    LsTool,
    ToolSearchTool,
    AskUserTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    SkillTool,
    SendMessageTool,
    RemoteTriggerTool,
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
    LspTool,
    ReadMcpResourceTool,
];

export function createToolRegistry() {
    const tools = new Map();
    for (const Tool of BUILTIN_TOOLS) {
        tools.set(Tool.name, Tool);
    }

    // Cached tool definitions list — rebuilt whenever new tools are registered.
    // tools.list() is called on every API turn; avoiding the O(n) map+rebuild
    // on each call shaves a small but consistent amount of latency.
    let _listCache = null;
    // Cached OpenAI-format tool definitions (type:'function' wrappers).
    // Rebuilt alongside _listCache so both stay in sync.
    let _listOpenAICache = null;
    function invalidateListCache() { _listCache = null; _listOpenAICache = null; }

    const registry = {
        list() {
            if (_listCache) return _listCache;
            _listCache = [...tools.values()].map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
            }));
            _listOpenAICache = null; // reset so listOpenAI() rebuilds from new _listCache
            return _listCache;
        },

        /**
         * Return tool definitions pre-formatted for OpenAI-compatible providers.
         * Cached alongside list() — only rebuilt when tools are registered/deregistered.
         * Avoids a toolDefs.map() allocation on every API call in callOpenAI/callNvidia/callCustomProvider.
         */
        listOpenAI() {
            if (_listOpenAICache) return _listOpenAICache;
            const base = this.list();
            _listOpenAICache = base.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input_schema },
            }));
            return _listOpenAICache;
        },

        async call(name, input) {
            const tool = tools.get(name);
            if (!tool) throw new Error(`Unknown tool: ${name}`);
            const errors = tool.validateInput?.(input) || [];
            if (errors.length > 0) return `Validation error: ${errors.join(', ')}. Please correct the parameters and retry the tool call.`;
            return tool.call(input);
        },

        register(tool) {
            tools.set(tool.name, tool);
            invalidateListCache();
        },

        get(name) {
            return tools.get(name);
        },

        has(name) {
            return tools.has(name);
        },

        registerMcpTools(mcpTools, callFn) {
            ToolSearchTool._mcpTools = mcpTools;

            for (const mcpTool of mcpTools) {
                const wrapper = {
                    name: mcpTool.name,
                    description: mcpTool.description || '',
                    inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
                    validateInput() { return []; },
                    async call(input) { return callFn(mcpTool.name, input); },
                };
                tools.set(mcpTool.name, wrapper);
            }
            invalidateListCache();
        },
    };

    ToolSearchTool._registry = registry;
    return registry;
}

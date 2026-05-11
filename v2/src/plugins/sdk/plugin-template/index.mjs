/**
 * Plugin template — index.mjs
 *
 * A minimal freeCode plugin. Export { tools, skills, systemPromptAdditions }.
 *
 * Tools:    Array of tool descriptors (name, description, inputSchema, call)
 * Skills:   Array of skill descriptors (name, description, run)
 * systemPromptAdditions: Extra instructions injected into the system prompt
 */

export default {
    /** Custom tools provided by this plugin. */
    tools: [
        {
            name: 'MyPluginTool',
            description: 'An example tool provided by my-plugin.',
            inputSchema: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'Message to echo' },
                },
                required: ['message'],
            },
            validateInput(input) {
                return input.message ? [] : ['message is required'];
            },
            async call(input) {
                return `MyPlugin says: ${input.message}`;
            },
        },
    ],

    /** Custom skills (prompt-based shortcuts) provided by this plugin. */
    skills: [],

    /** Text appended to the system prompt when this plugin is active. */
    systemPromptAdditions: '',
};

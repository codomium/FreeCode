/**
 * plugin-template/test/test.mjs — basic tests for the plugin template
 */

import { default as plugin } from '../index.mjs';
import { validatePluginExport } from '../../plugin-validator.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) { cond ? passed++ : (failed++, console.error('FAIL:', msg)); }

// Validate export shape
const { valid, errors } = validatePluginExport(plugin);
assert(valid, `Plugin export valid — errors: ${errors.join(', ')}`);
assert(Array.isArray(plugin.tools), 'tools is array');
assert(plugin.tools.length >= 1, 'at least one tool');

// Call the example tool
const tool = plugin.tools[0];
assert(tool.name === 'MyPluginTool', 'tool name correct');
const result = await tool.call({ message: 'hello' });
assert(result.includes('hello'), 'tool returns echo');

// Validation
const valErrors = tool.validateInput({});
assert(valErrors.length > 0, 'validates missing message');

console.log(`\nPlugin template tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * Agent Loop — async generator yielding 13+ event types.
 * Handles streaming, tool calls, thinking, auto-compaction, hooks, multi-provider.
 *
 * v4.0: PlanGraph integration, turn-classifier, smart routing, reasoning log.
 * v5.0: MemoryGraph integration.
 */
import { streamResponse, accumulateStream } from './streaming.mjs';
import { ContextManager } from './context-manager.mjs';
import { buildSystemPrompt, buildWorkspaceSnapshot, buildWorkspaceContent, buildThinkingModelSystemPrompt, toCacheBlocks } from './system-prompt.mjs';
import { verifyWrite, verifyEdit } from './verify-write.mjs';
import { isNvidiaModel } from './providers.mjs';
import { RateLimiter } from './rate-limiter.mjs';
import { StuckDetector } from './stuck-detector.mjs';
import { PlanGraph } from './plan-graph.mjs';
import { TurnClassifier } from './turn-classifier.mjs';
import { Router } from './router.mjs';
import fs from 'fs';
import path from 'path';
import { checkInjection } from '../permissions/injection-check.mjs';

// Monotonic counter for generating unique IDs within this process (e.g. Gemini tool-call IDs).
let _idCounter = 0;
function nextId() { return ++_idCounter; }

// ── Module-level RateLimiter instances (one per provider) ──────────────────
// Hoisted out of the per-call API functions so the objects are reused across
// turns rather than being allocated fresh on every API request.  The reset()
// call at the start of each function restores a clean retry state without
// creating GC pressure.
const _rlAnthropic = new RateLimiter({ maxRetries: 5, baseDelay: 5000 });
const _rlOpenAI    = new RateLimiter({ maxRetries: 5, baseDelay: 5000 });
const _rlGoogle    = new RateLimiter({ maxRetries: 5, baseDelay: 5000 });
const _rlNvidia    = new RateLimiter({ maxRetries: 5, baseDelay: 5000 });
const _rlCustom    = new RateLimiter({ maxRetries: 3, baseDelay: 3000 });

// ── CUSTOM_PROVIDERS_JSON parse cache ───────────────────────────────────────
// Parsing the env string on every turn (up to 3× per turn) is wasteful.
// We cache the result and re-parse only when the env value changes.
let _customProvidersCache = null;   // parsed Array or null
let _customProvidersJson  = null;   // the env string that produced the cache

// ── Provider base-URL cache ──────────────────────────────────────────────────
// Evaluated once at module load; refreshed only when the env var is absent
// (empty string → default) so changes in long-lived processes are still
// picked up without paying repeated string ops on every API call.
function _resolveAnthropicBaseUrl() {
    return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
}
// Snapshot at load time — process.env.ANTHROPIC_BASE_URL is effectively
// static in normal usage (set before the process starts).
let _anthropicBaseUrl = _resolveAnthropicBaseUrl();

/**
 * Find a custom provider definition (from CUSTOM_PROVIDERS_JSON) that owns
 * the given model ID.  Returns the provider object or null.
 */
function findCustomProvider(model) {
    const json = process.env.CUSTOM_PROVIDERS_JSON;
    if (!json) return null;
    // Re-parse only when the env value has changed (e.g. dynamic reconfiguration).
    if (json !== _customProvidersJson) {
        try {
            const parsed = JSON.parse(json);
            _customProvidersCache = Array.isArray(parsed) ? parsed : null;
        } catch {
            _customProvidersCache = null;
        }
        _customProvidersJson = json;
    }
    if (!_customProvidersCache) return null;
    for (const p of _customProvidersCache) {
        const models = p.models || [];
        if (models.some(m => (typeof m === 'string' ? m : m.id) === model)) return p;
    }
    return null;
}

// ── OpenAI tool-definition format cache ──────────────────────────────────────
// callOpenAI / callNvidia / callCustomProvider all convert toolDefs to the
// OpenAI `{type:'function', function:{...}}` format on every API call.
// Since tools.list() returns a stable cached array, we can cache the
// converted result keyed by that array identity and avoid repeated map()s.
let _openAIToolDefsRef  = null;   // the toolDefs array from the last conversion
let _openAIToolDefsOut  = null;   // the converted result

/**
 * Return toolDefs converted to OpenAI function-calling format.
 * Result is cached by array identity — no re-allocation unless tools change.
 * @param {Array} toolDefs
 * @returns {Array}
 */
function toOpenAITools(toolDefs) {
    if (toolDefs === _openAIToolDefsRef) return _openAIToolDefsOut;
    _openAIToolDefsRef = toolDefs;
    _openAIToolDefsOut = toolDefs.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    return _openAIToolDefsOut;
}

/**
 * Extract the function/tool name from a Gemini call ID.
 *
 * Gemini does not provide stable call IDs; we generate them as
 * `${functionName}_${counter}` (see convertGoogleResponse / accumulateGoogleStream).
 * When building a functionResponse we need the original function name, which
 * is recovered by stripping the trailing `_<digits>` counter suffix.
 *
 * @param {string} toolUseId — e.g. "Read_1", "Bash_42", "my_tool_runner_7"
 * @returns {string} — e.g. "Read", "Bash", "my_tool_runner"
 */
function extractGoogleToolName(toolUseId) {
    if (!toolUseId) return '';
    // Strip a trailing `_<pure-digits>` suffix.
    // String.replace() always returns a string, so no fallback is needed.
    return toolUseId.replace(/_\d+$/, '');
}

/**
 * NVIDIA NIM models that support extended reasoning (thinking mode).
 *
 * standard tool-calling mode: Read, Write, Bash, Grep, etc. all work.
 *
 * When NVIDIA_THINKING_MODE=true tools are omitted (NVIDIA NIM rejects
 * the combination of thinking + tool-calling), falling back to workspace
 * snapshot injection.
 *
 * NOTE: Do NOT send chat_template_kwargs in the request body. The NVIDIA
 * NIM backend serialises request parameters using Python's hash mechanism;
 * a dict value (i.e. the chat_template_kwargs object) is unhashable and
 * causes a server-side HTTP 500 "unhashable type: 'dict'" error.
 *
 * kimi-k2.5 and deepseek-r1 support standard tool-calling by default;
 * thinking mode is only activated when NVIDIA_THINKING_MODE=true.
 * kimi-k2.6 ALWAYS operates in thinking mode on NVIDIA NIM and never
 * accepts tool definitions — see NVIDIA_ALWAYS_DISABLE_TOOLS below.
 */
const NVIDIA_THINKING_CAPABLE_MODELS = new Set([
    'moonshotai/kimi-k2.5',
    'deepseek-ai/deepseek-r1',
]);

/**
 * Models that ALWAYS require tools to be omitted regardless of
 * NVIDIA_THINKING_MODE.  kimi-k2.6 runs exclusively in thinking mode on
 * NVIDIA NIM; sending tool definitions causes an HTTP 500
 * "unhashable type: 'dict'" error in the Python backend.
 *
 * nvModelBase() is used so that both the namespaced form
 * ("moonshotai/kimi-k2.6") and any short-name alias ("kimi-k2.6") match.
 */
const NVIDIA_ALWAYS_DISABLE_TOOLS = new Set([
    'moonshotai/kimi-k2.6',
]);

/**
 * Strip the "publisher/" namespace prefix from an NVIDIA NIM model ID so
 * that short-name aliases ("kimi-k2.6") match the same set entries as the
 * fully-qualified form ("moonshotai/kimi-k2.6").
 *
 * @param {string} model
 * @returns {string}
 */
function nvModelBase(model) {
    if (!model) return '';
    const slash = model.indexOf('/');
    return slash !== -1 ? model.slice(slash + 1) : model;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export function createAgentLoop({ model, tools, permissions, settings, hooks }) {
    const contextManager = new ContextManager(settings.maxContextTokens || 160000);

    // Build system prompt using the new builder
    const promptResult = buildSystemPrompt({
        cwd: process.cwd(),
        tools: tools.list?.() || [],
        override: settings.systemPromptOverride,
        addDirs: settings.addDirs,
    });

    // v4.0: PlanGraph, TurnClassifier, Router
    const planGraph     = new PlanGraph();
    const turnClassifier = new TurnClassifier();
    const router        = new Router(settings.routerConfig ? { config: settings.routerConfig } : {});

    const state = {
        messages: [],
        systemPrompt: promptResult.full,
        systemPromptStatic: promptResult.staticPrefix,  // tool-free prefix for providers that don't use tools
        turnCount: 0,
        continuationDepth: 0,  // incremented each recursive tool-result turn; reset on new user message
        tokenUsage: { input: 0, output: 0 },
        model,
        tools,
        _contextManager: contextManager,
        _stuckDetector: new StuckDetector({ volumeLimit: settings.volumeLimit }), // loop-detection (E10: configurable limit)
        sessionGoal: settings.sessionGoal || null,  // sticky goal that survives compaction
        sessionId: settings.sessionId || null,       // opaque ID for cross-session summary persistence
        planGraph,           // v4.0-A: structured task execution graph
        _reasoningLog: [],   // v4.0-C: per-turn reasoning log
    };

    async function* run(userMessage, options = {}) {
        // Injection check on new user messages
        if (userMessage && !options.continuation) {
            const injectionResult = checkInjection(userMessage);
            if (!injectionResult.safe) {
                yield {
                    type: 'injection_detected',
                    severity: 'high',
                    details: injectionResult.label || injectionResult.pattern || 'suspicious input',
                };
                return;
            }
        }

        // Add user message (skip for continuation turns)
        if (userMessage && !options.continuation) {
            // Auto-extract session goal from the very first user message when none is set
            if (!state.sessionGoal && state.turnCount === 0 && state.messages.length === 0) {
                const firstLine = userMessage.split('\n')[0].trim();
                state.sessionGoal = firstLine.slice(0, 120) || null;
                if (state.sessionGoal) {
                    yield { type: 'sessionGoal', goal: state.sessionGoal };
                }
            }

            state.messages = contextManager.addMessage(state.messages, {
                role: 'user',
                content: userMessage,
            }, state.sessionGoal);
            state.turnCount++;
            state.continuationDepth = 0; // reset per new user message
            state._stuckDetector.resetTurn(); // reset loop-detection on new user message
        } else if (options.continuation) {
            // Guard against infinite tool-call loops
            state.continuationDepth++;
            const maxContinuation = settings.maxContinuationTurns || 100;
            if (state.continuationDepth >= maxContinuation) {
                yield {
                    type: 'error',
                    message: `Agent loop limit reached (${maxContinuation} continuation turns). The agent may be stuck. Please start a new message.`,
                };
                yield { type: 'stop', reason: 'loop_limit' };
                return;
            }
        }

        // Check max turns — emit pre_pause_summary before stopping (v4.4-C)
        if (settings.maxTurns && state.turnCount > settings.maxTurns) {
            const currentNode = state.planGraph.getCurrentNode();
            yield {
                type: 'pre_pause_summary',
                completedNodes: state.planGraph.getNodes().filter(n => n.status === 'done').map(n => n.title),
                inProgressNode: currentNode ? currentNode.title : null,
                pendingNode: state.planGraph.getReadyNodes()[0]?.title || null,
                planGraph: state.planGraph.serialize(),
            };
            yield { type: 'error', message: `Max turns (${settings.maxTurns}) reached.` };
            yield { type: 'max_turns_reached', suggestion: 'Continue from where you left off' };
            yield { type: 'stop', reason: 'max_turns' };
            return;
        }

        // Auto-compact if needed (pass session goal so it's re-injected in compaction summary).
        // For new user-message turns, addMessage() above already ran shouldCompact() and
        // compacted if necessary.  Only run it again on continuation turns (tool-result
        // pushes bypass addMessage and may have grown the array past the threshold).
        if (options.continuation && contextManager.shouldCompact(state.messages)) {
            yield { type: 'compaction', count: contextManager.compactionCount + 1 };
            state.messages = contextManager.compact(state.messages, 6, state.sessionGoal);
        }

        yield { type: 'stream_request_start', turn: state.turnCount };

        // v4.2-A: Classify turn type and resolve best model/provider
        const turnClassification = turnClassifier.classify(state.messages, state.turnCount);
        const routeTarget = router.resolve(turnClassification.type);
        // Only switch model if smart routing is enabled in settings
        const currentModel = settings.smartRouting
            ? routeTarget.model
            : state.model;
        if (settings.smartRouting && currentModel !== state.model) {
            yield { type: 'model_selected', turnType: turnClassification.type, provider: routeTarget.provider, model: currentModel };
        }

        // Detect provider and call API — read state.model so that model
        // switches (via handleModelSwitch) take effect on the next turn.
        const provider = detectProvider(currentModel);
        let response;

        // Retry loop — handles 429 / 5xx rate-limit errors transparently.
        // The loop only retries the HTTP call itself; streaming events are not
        // replayed. The conversation state is unchanged between retries.
        const MAX_API_RETRIES = 3;
        const RETRY_BASE_DELAY_MS = 30000;
        let apiAttempt = 0;
        while (true) {
            try {
                if (settings.stream !== false) {
                    // Streaming mode
                    response = await callApiStreaming(provider, currentModel, state, tools.list(), settings);
                    const collectedContent = [];
                    let currentText = '';
                    let currentThinking = '';
                    let repetitionDetected = false;
                    // Only run the expensive repetition check every 50 chars of
                    // new text (not on every token) to keep the streaming hot path lean.
                    let textLenAtLastRepCheck = 0;

                    for await (const event of response.events) {
                        if (event.type === 'content_block_start') {
                            if (event.content_block?.type === 'thinking') {
                                currentThinking = '';
                            }
                        } else if (event.type === 'content_block_delta') {
                            if (event.delta?.type === 'text_delta') {
                                currentText += event.delta.text;
                                yield { type: 'stream_event', text: event.delta.text };
                                // Abort stream if the model is stuck repeating itself.
                                // Throttled: only check after 50+ new chars to avoid
                                // O(n²) substring work on every single streaming token.
                                if (currentText.length - textLenAtLastRepCheck >= 50) {
                                    textLenAtLastRepCheck = currentText.length;
                                    if (detectRepetition(currentText)) {
                                        repetitionDetected = true;
                                        break;
                                    }
                                }
                            } else if (event.delta?.type === 'thinking_delta') {
                                currentThinking += event.delta.thinking;
                                yield { type: 'thinking', text: event.delta.thinking };
                            }
                        } else if (event.type === 'ping') {
                            // Keepalive, ignore
                        }
                    }

                    // Final trailing check: catch repetition in the last <50 chars
                    // that the throttled in-loop check may have skipped.
                    if (!repetitionDetected && currentText.length > textLenAtLastRepCheck) {
                        if (detectRepetition(currentText)) {
                            repetitionDetected = true;
                        }
                    }

                    if (repetitionDetected) {
                        yield {
                            type: 'error',
                            message: 'Agent stopped: repetitive output detected. The model appears to be stuck. Please start a new message or refine your request.',
                        };
                        yield { type: 'stop', reason: 'repetition_detected' };
                        return;
                    }

                    // Use the accumulated message
                    response = response.accumulated;
                } else {
                    // Non-streaming mode
                    response = await callApi(provider, currentModel, state, tools.list(), settings);
                }
                // Success — reset retry counter and exit the retry loop
                state._autoRetryCount = 0;
                break;
            } catch (err) {
                // Detect rate-limit / overload errors and auto-retry with back-off
                const isRetryable = /rate.?limit|overload|too.?many.?request|capacity|429|529|500|503|502|504|bad.?gateway|service.?unavailable|quota/i.test(err.message || '');
                if (isRetryable && apiAttempt < MAX_API_RETRIES) {
                    apiAttempt++;
                    // Honour Retry-After if the error carries it; otherwise exponential back-off
                    const delaySec = err.retryAfterSeconds
                        || Math.min(30 * Math.pow(2, apiAttempt - 1), 120);
                    yield {
                        type: 'retrying',
                        attempt: apiAttempt,
                        maxAttempts: MAX_API_RETRIES,
                        delaySeconds: delaySec,
                    };
                    await new Promise(r => setTimeout(r, delaySec * 1000));
                    continue; // retry the API call without mutating messages
                }
                // Non-retryable error or retries exhausted
                state._autoRetryCount = 0;
                yield { type: 'error', message: err.message };
                return;
            }
        }

        // Track token usage
        if (response.usage) {
            state.tokenUsage.input += response.usage.input_tokens || 0;
            state.tokenUsage.output += response.usage.output_tokens || 0;
        }

        // Build assistant message for history
        const assistantMessage = { role: 'assistant', content: response.content };
        state.messages.push(assistantMessage);

        // Process content blocks
        const toolUseBlocks = [];

        for (const block of response.content || []) {
            if (block.type === 'text') {
                yield { type: 'assistant', content: block.text };
            }

            if (block.type === 'thinking') {
                yield { type: 'thinking_complete', thinking: block.thinking };
            }

            if (block.type === 'tool_use') {
                toolUseBlocks.push(block);
            }
        }

        // Process tool calls
        if (toolUseBlocks.length > 0) {
            const toolResults = [];

            // ── Phase 1: sequential pre-checks (hooks + permissions) ──────────
            // Permission dialogs may require user interaction, so these must run
            // one at a time.  We collect the blocks that are approved for execution.
            const approvedBlocks = [];
            for (const block of toolUseBlocks) {
                // Run pre-tool hooks
                if (hooks) {
                    const hookResult = await hooks.runPreToolUse(block.name, block.input);
                    if (!hookResult.allow) {
                        yield { type: 'hookPermissionResult', tool: block.name, allowed: false, message: hookResult.message };
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: `Blocked by hook: ${hookResult.message}`,
                        });
                        continue;
                    }
                }

                // Check permission
                const allowed = await permissions.check(block.name, block.input);
                if (!allowed) {
                    yield { type: 'hookPermissionResult', tool: block.name, allowed: false };
                    const mode = permissions.mode;
                    const modeReason = mode === 'dontAsk'
                        ? `${block.name} is not allowed in dontAsk mode.`
                        : `Permission denied for ${block.name}.`;
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: modeReason,
                    });
                    continue;
                }

                yield { type: 'tool_progress', tool: block.name, status: 'running', input: block.input };
                approvedBlocks.push(block);
            }

            // ── Phase 2: execute all approved tools in parallel ───────────────
            // For streaming tools (e.g. Bash), we buffer the events so they can
            // be yielded in deterministic order in Phase 3.
            const execResults = await Promise.all(approvedBlocks.map(async (block) => {
                const streamEvents = []; // buffered tool_meta / tool_stream events
                let result;
                let isToolError = false;
                try {
                    const callResult = await tools.call(block.name, block.input);
                    // Detect async-generator tools (e.g. Bash with live streaming)
                    if (callResult !== null && typeof callResult === 'object' && typeof callResult[Symbol.asyncIterator] === 'function') {
                        for await (const event of callResult) {
                            if (event.type === 'meta' || event.type === 'chunk') {
                                streamEvents.push(event);
                            } else if (event.type === 'done') {
                                result = event.result;
                            }
                        }
                    } else {
                        result = callResult;
                    }
                } catch (err) {
                    result = `Tool error: ${err.message}`;
                    isToolError = true;
                }

                // Run post-tool hooks
                if (hooks) {
                    result = await hooks.runPostToolUse(block.name, result);
                }

                // Compute verifyWrites data while we're still in the parallel phase
                // (reads are cheap and don't mutate shared state)
                const verifyWarnings = [];
                if (settings.verifyWrites && !isToolError && typeof result === 'string') {
                    if (block.name === 'Write' && result.startsWith('File written:')) {
                        const filePath = block.input?.file_path ? path.resolve(block.input.file_path) : null;
                        if (filePath && typeof block.input?.content === 'string') {
                            const { match, diff } = verifyWrite(filePath, block.input.content);
                            if (!match) {
                                verifyWarnings.push(`Write verification failed for ${filePath} — on-disk content differs from what was written:\n${diff}`);
                            }
                        }
                    } else if (block.name === 'Edit' && result.startsWith('File updated:')) {
                        const filePath = block.input?.file_path ? path.resolve(block.input.file_path) : null;
                        if (filePath && typeof block.input?.new_string === 'string') {
                            const { match, message } = verifyEdit(filePath, block.input.old_string || '', block.input.new_string);
                            if (!match) verifyWarnings.push(message);
                        }
                    } else if (block.name === 'MultiEdit' && result.startsWith('Applied')) {
                        const edits = Array.isArray(block.input?.edits) ? block.input.edits : [];
                        for (const edit of edits) {
                            if (!edit.file_path || typeof edit.new_string !== 'string') continue;
                            const filePath = path.resolve(edit.file_path);
                            const { match, message } = verifyEdit(filePath, edit.old_string || '', edit.new_string);
                            if (!match) verifyWarnings.push(message);
                        }
                    }
                }

                return { block, result, isToolError, streamEvents, verifyWarnings };
            }));

            // ── Phase 3: yield events + post-process in original order ────────
            // Stateful operations (stuck detector, PlanGraph, reasoning log) run
            // sequentially here so their ordering remains deterministic.
            for (const execResult of execResults) {
                const { block, streamEvents, verifyWarnings } = execResult;
                let { result, isToolError } = execResult;

                // Replay buffered streaming events (tool_meta / tool_stream)
                for (const event of streamEvents) {
                    if (event.type === 'meta') {
                        yield { type: 'tool_meta', tool: block.name, ...event };
                    } else if (event.type === 'chunk') {
                        yield { type: 'tool_stream', tool: block.name, chunk: event.data, stream: event.stream };
                    }
                }

                // Also treat result strings that are tool-error messages as errors
                if (!isToolError && typeof result === 'string' &&
                    (result.startsWith('Tool error:') || result.startsWith('Error:') ||
                     result.includes('not found in file') || result.includes('does not exist'))) {
                    isToolError = true;
                }

                // Emit any verifyWrites warnings collected during parallel execution
                for (const msg of verifyWarnings) {
                    yield { type: 'warning', tool: block.name, message: msg };
                }

                // Loop-detection: record this tool call and check for stuck conditions.
                state._stuckDetector.record(block.name, block.input, result, isToolError);
                const stuckCondition = state._stuckDetector.check();
                if (stuckCondition) {
                    yield {
                        type: 'stuck',
                        reason: stuckCondition.reason,
                        summary: stuckCondition.summary,
                    };
                    yield { type: 'stop', reason: 'stuck' };
                    return;
                }

                // v4.0-A: PlanGraph sync
                if (block.name === 'TodoWrite' && !isToolError && Array.isArray(block.input?.todos)) {
                    state.planGraph.syncFromTodos(block.input.todos);
                    yield { type: 'plan_graph', graph: state.planGraph.serialize() };
                }

                // v4.0-A: Complete plan node on successful file write/edit
                if (!isToolError && ['Edit', 'Write', 'MultiEdit'].includes(block.name)) {
                    const filePaths = block.name === 'MultiEdit'
                        ? (block.input?.edits || []).map(e => e.file_path).filter(Boolean)
                        : [block.input?.file_path].filter(Boolean);
                    const currentNode = state.planGraph.getCurrentNode();
                    if (currentNode) {
                        currentNode.filesTouched.push(...filePaths);
                        state.planGraph.complete(currentNode.id, { filesChanged: filePaths });
                        yield { type: 'node_completed', nodeId: currentNode.id, evidence: { filesChanged: filePaths } };
                    }
                    // v4.4-A: Emit diff annotation for file edits
                    for (const fp of filePaths) {
                        let linesChanged = 0;
                        try {
                            const fileContent = fs.readFileSync(fp, 'utf8');
                            linesChanged = fileContent.split('\n').length;
                        } catch { /* file may not exist yet */ }
                        yield {
                            type: 'diff_annotation',
                            file: fp,
                            linesChanged,
                            summary: `+${linesChanged} lines to ${path.basename(fp)}`,
                        };
                    }
                }

                // v4.0-C: Record reasoning log entry
                state._reasoningLog.push({
                    turn: state.turnCount,
                    decision: block.name,
                    filesInvolved: block.name === 'MultiEdit'
                        ? (block.input?.edits || []).map(e => e.file_path)
                        : [block.input?.file_path || block.input?.path || null].filter(Boolean),
                    outcomeType: isToolError ? 'error' : 'success',
                });
                // Keep only last 20 entries
                if (state._reasoningLog.length > 20) state._reasoningLog.shift();

                yield { type: 'result', tool: block.name, result, input: block.input, isError: !!isToolError };

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }

            // If every tool call in this batch failed with a validation error, append a
            // text nudge so the model retries rather than giving up with a summary message.
            // (A text block is valid inside a user content array for all supported providers.)
            const validationErrorCount = toolResults.filter(r =>
                typeof r.content === 'string' && r.content.startsWith('Validation error:')).length;
            if (validationErrorCount > 0 && validationErrorCount === toolResults.length) {
                toolResults.push({
                    type: 'text',
                    text: '[System: All tool call(s) above failed input validation. Review the required parameter names for each tool and retry the tool call(s) immediately. Do not stop or summarise — keep going.]',
                });
            }

            // Add tool results as a single user message
            state.messages.push({ role: 'user', content: toolResults });

            // Recursive: continue the loop after tool execution
            yield* run(null, { continuation: true });
            return;
        }

        // No tool calls — check stop hooks
        if (hooks) {
            const allowStop = await hooks.runStop();
            if (!allowStop) {
                // Hook prevented stopping — continue with a nudge
                state.messages = contextManager.addMessage(state.messages, {
                    role: 'user',
                    content: '[System: A hook prevented stopping. Please continue with the task.]',
                }, state.sessionGoal);
                yield* run(null, { continuation: true });
                return;
            }
        }

        yield { type: 'stop', reason: response.stop_reason || 'end_turn' };

        // Persist session summary for cross-session context recall.
        // Only runs at the outermost stop (continuationDepth === 0) to avoid
        // redundant writes on every tool-call round-trip.
        if (!options.continuation && state.sessionId) {
            contextManager.persistSession(
                state.messages,
                state.sessionId,
                '',
                state.sessionGoal || '',
                state._reasoningLog || [],
            );

            // v5.0-B: Record completed session events in memory graph (if enabled)
            if (settings.memoryGraph) {
                try {
                    const events = state.messages.flatMap(m => {
                        if (m.role === 'assistant') return [{ type: 'assistant', content: typeof m.content === 'string' ? m.content : '' }];
                        return [];
                    });
                    settings.memoryGraph.record(state.sessionId, events);
                } catch {
                    // Best-effort memory recording
                }
            }
        }
    }

    return { run, state };
}

function detectProvider(model) {
    // Check user-configured custom providers first.
    // findCustomProvider is now cached — calling it once here is cheap.
    if (findCustomProvider(model)) return 'custom';
    // OpenAI GPT family and reasoning series (o1, o3, o4, o5…).
    // Use /^o\d+(-|$)/ rather than /^o\d/ to avoid false-positives like
    // 'output-formatter' or 'optimization-v2' matching the OpenAI branch.
    if (model.startsWith('gpt-') || /^o\d+(-|$)/.test(model)) return 'openai';
    if (model.startsWith('gemini')) return 'google';
    if (isNvidiaModel(model)) return 'nvidia';
    return 'anthropic';
}

/**
 * Resolve provider + custom config once and pass both into the caller,
 * so each call path doesn't need to repeat findCustomProvider().
 */
async function callApi(provider, model, state, toolDefs, settings) {
    if (provider === 'custom') {
        return callCustomProvider(findCustomProvider(model), model, state, toolDefs, settings, false);
    }
    const callers = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle, nvidia: callNvidia };
    const caller = callers[provider] || callers.anthropic;
    return caller(model, state, toolDefs, settings, false);
}

async function callApiStreaming(provider, model, state, toolDefs, settings) {
    if (provider === 'custom') {
        return callCustomProvider(findCustomProvider(model), model, state, toolDefs, settings, true);
    }
    const callers = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle, nvidia: callNvidia };
    const caller = callers[provider] || callers.anthropic;
    return caller(model, state, toolDefs, settings, true);
}

async function callAnthropic(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const body = {
        model,
        max_tokens: resolveMaxOutputTokens(settings),
        messages: state.messages,
        ...(state.systemPrompt && {
            system: toCacheBlocks(state.systemPromptStatic || state.systemPrompt, state.systemPromptDynamic || ''),
        }),
        ...(toolDefs.length > 0 && { tools: toolDefs }),
        ...(stream && { stream: true }),
    };

    // Enable extended thinking if model supports it
    if (model.includes('opus') || settings.thinking) {
        body.thinking = { type: 'enabled', budget_tokens: settings.thinkingBudget || 10000 };
    }

    const rateLimiter = _rlAnthropic;
    rateLimiter.reset();
    let res;
    for (;;) {
        res = await fetch(`${_anthropicBaseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                // Enable prompt caching so cache_control blocks on the system
                // prompt are honoured.  Without this header Anthropic silently
                // ignores cache_control and re-processes the full system prompt
                // on every turn, adding hundreds of ms to TTFT in multi-turn sessions.
                'anthropic-beta': 'prompt-caching-2024-07-31',
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const action = await rateLimiter.handleResponse(res);
            if (action === 'retry') {
                process.stderr.write(
                    `[open-claude-code] Anthropic API ${res.status} - retrying (attempt ${rateLimiter.retryCount}/${rateLimiter.maxRetries})...\n`
                );
                continue;
            }
            const retryAfter = res.headers?.get?.('retry-after');
            const err = await res.text();
            const errMsg = `Anthropic API error ${res.status}: ${err}`;
            if (retryAfter) throw Object.assign(new Error(errMsg), { retryAfterSeconds: parseInt(retryAfter, 10) });
            throw new Error(errMsg);
        }
        break;
    }

    if (stream) {
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateFromCollected(collected);
            },
        };
    }

    return res.json();
}

async function callOpenAI(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    // Use the shared message builder so multi-turn tool conversations are
    // correctly serialised for OpenAI-compatible APIs:
    //   • assistant turns with tool_use blocks → {role:'assistant', tool_calls:[…]}
    //   • user turns with tool_result blocks  → {role:'tool', tool_call_id:…}
    // The old inline builder emitted only tool_result messages and omitted the
    // preceding assistant tool_calls, which OpenAI rejects (400 Bad Request).
    const messages = buildOpenAIMessages(state);

    const tools = toOpenAITools(toolDefs);

    const body = {
        model,
        messages,
        max_tokens: resolveMaxOutputTokens(settings),
        ...(stream && { stream: true }),
        // Request usage data in the final chunk when streaming so token
        // counts are available for cost tracking and context management.
        ...(stream && { stream_options: { include_usage: true } }),
        ...(tools.length > 0 && { tools }),
    };

    const reqHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(stream && { 'Accept': 'text/event-stream' }),
    };

    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const rateLimiter = _rlOpenAI;
    rateLimiter.reset();
    let res;
    for (;;) {
        res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const action = await rateLimiter.handleResponse(res);
            if (action === 'retry') {
                process.stderr.write(
                    `[open-claude-code] OpenAI API ${res.status} - retrying (attempt ${rateLimiter.retryCount}/${rateLimiter.maxRetries})...\n`
                );
                continue;
            }
            const retryAfter = res.headers?.get?.('retry-after');
            const err = await res.text();
            const errMsg = `OpenAI API error ${res.status}: ${err}`;
            if (retryAfter) throw Object.assign(new Error(errMsg), { retryAfterSeconds: parseInt(retryAfter, 10) });
            throw new Error(errMsg);
        }
        break;
    }

    if (stream) {
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamOpenAIResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateOpenAIStream(collected);
            },
        };
    }

    const data = await res.json();
    return convertOpenAIResponse(data);
}

async function callGoogle(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY not set');

    // F4: convert all message types including tool_use / tool_result
    const contents = [];
    for (const msg of state.messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        if (typeof msg.content === 'string') {
            contents.push({ role, parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
            const parts = [];
            for (const block of msg.content) {
                if (block.type === 'text') {
                    parts.push({ text: block.text || '' });
                } else if (block.type === 'tool_use') {
                    // assistant called a tool → Gemini functionCall part
                    parts.push({ functionCall: { name: block.name, args: block.input ?? {} } });
                } else if (block.type === 'tool_result') {
                    // user returned tool result → Gemini functionResponse part.
                    // Gemini requires functionResponse.name to equal the
                    // functionCall.name (the tool name), not the call ID.
                    const fnName = extractGoogleToolName(block.tool_use_id);
                    const responseContent = typeof block.content === 'string'
                        ? block.content
                        : JSON.stringify(block.content);
                    parts.push({
                        functionResponse: {
                            name: fnName,
                            response: { output: responseContent },
                        },
                    });
                }
            }
            if (parts.length > 0) {
                contents.push({ role, parts });
            }
        }
    }

    // F4: pass tool definitions as Gemini function declarations
    const googleTools = toolDefs.length > 0
        ? [{
            functionDeclarations: toolDefs.map(t => ({
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} },
            })),
        }]
        : undefined;

    const body = {
        contents,
        ...(state.systemPrompt && {
            systemInstruction: { parts: [{ text: state.systemPrompt }] },
        }),
        ...(googleTools && { tools: googleTools }),
        // Without generationConfig.maxOutputTokens, Gemini defaults to ~8192
        // tokens and silently truncates long agent responses / thinking output.
        // Setting it explicitly to the configured limit lets agents complete
        // large tasks without hitting the model's conservative default.
        generationConfig: {
            maxOutputTokens: resolveMaxOutputTokens(settings),
        },
    };

    const rateLimiter = _rlGoogle;
    rateLimiter.reset();
    let res;
    for (;;) {
        res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }
        );

        if (!res.ok) {
            const action = await rateLimiter.handleResponse(res);
            if (action === 'retry') {
                process.stderr.write(
                    `[open-claude-code] Google API ${res.status} - retrying (attempt ${rateLimiter.retryCount}/${rateLimiter.maxRetries})...\n`
                );
                continue;
            }
            const retryAfter = res.headers?.get?.('retry-after') || res.headers?.get?.('x-ratelimit-reset-requests');
            const err = await res.text();
            const errMsg = `Google API error ${res.status}: ${err}`;
            if (retryAfter) throw Object.assign(new Error(errMsg), { retryAfterSeconds: parseInt(retryAfter, 10) });
            throw new Error(errMsg);
        }
        break;
    }

    if (stream) {
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamGoogleResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateGoogleStream(collected);
            },
        };
    }

    const data = await res.json();
    return convertGoogleResponse(data);
}

/**
 * Parse a Gemini SSE stream (`streamGenerateContent?alt=sse`) into agent-loop
 * events that the existing streaming handler understands.
 *
 * Gemini SSE lines look like:
 *   data: { "candidates": [{ "content": { "parts": [...] }, "finishReason": "STOP" }], ... }
 *
 * Each data chunk may contain text parts, functionCall parts, or a finishReason.
 *
 * @param {Response} response - fetch Response with streaming body
 * @yields {object} Agent-loop-compatible events
 */
async function* streamGoogleResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /**
     * Parse a single Gemini SSE data payload and yield agent-loop events.
     * @param {string} raw - JSON string after the "data:" prefix
     */
    async function* yieldChunkEvents(raw) {
        if (!raw || raw === '[DONE]') {
            yield { type: 'done' };
            return;
        }
        let chunk;
        try { chunk = JSON.parse(raw); } catch { return; }
        if (chunk.error) {
            throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate) return;
        for (const part of candidate.content?.parts || []) {
            if (part.text) {
                // Gemini 2.5 models mark internal reasoning with part.thought === true.
                // Route these as thinking_delta events so the agent loop displays them
                // correctly and doesn't confuse thinking with response text.
                if (part.thought) {
                    yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: part.text } };
                } else {
                    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: part.text } };
                }
            }
            if (part.functionCall) {
                yield { type: 'google_function_call', functionCall: part.functionCall };
            }
        }
        if (candidate.finishReason) {
            yield {
                type: 'message_delta',
                delta: { stop_reason: candidate.finishReason === 'STOP' ? 'end_turn' : candidate.finishReason },
            };
        }
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete last line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
                const raw = trimmed.slice(5).trim();
                for await (const event of yieldChunkEvents(raw)) {
                    if (event.type === 'done') return;
                    yield event;
                }
            }
        }

        // Flush any remaining buffer content
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
            const raw = trimmed.slice(5).trim();
            for await (const event of yieldChunkEvents(raw)) {
                if (event.type === 'done') return;
                yield event;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Accumulate streamed Gemini events (from streamGoogleResponse) into the
 * same internal message shape used by the rest of the agent loop.
 *
 * @param {Array} events - collected events from streamGoogleResponse
 * @returns {object} Internal message with content array and stop_reason
 */
function accumulateGoogleStream(events) {
    const message = {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };

    let textContent = '';
    let thinkingContent = '';

    for (const event of events) {
        if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
                textContent += event.delta.text || '';
            } else if (event.delta?.type === 'thinking_delta') {
                // Gemini 2.5 thinking tokens arrive as thinking_delta events
                thinkingContent += event.delta.thinking || '';
            }
        } else if (event.type === 'google_function_call') {
            const fc = event.functionCall;
            message.content.push({
                type: 'tool_use',
                id: `${fc.name}_${nextId()}`,
                name: fc.name,
                input: fc.args ?? {},
            });
        } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) {
                message.stop_reason = event.delta.stop_reason;
            }
        }
    }

    if (thinkingContent) {
        message.content.unshift({ type: 'thinking', thinking: thinkingContent });
    }
    if (textContent) {
        // Insert text after any thinking block but before tool_use blocks
        const insertAt = message.content.findIndex(b => b.type !== 'thinking');
        if (insertAt === -1) {
            message.content.push({ type: 'text', text: textContent });
        } else {
            message.content.splice(insertAt, 0, { type: 'text', text: textContent });
        }
    }

    if (!message.stop_reason) message.stop_reason = 'end_turn';
    return message;
}

/**
 * NVIDIA NIM — OpenAI-compatible chat completions endpoint.
 *
 * Uses the same message format as OpenAI but targets
 * https://integrate.api.nvidia.com/v1/chat/completions.
 *
 * For thinking-capable models (kimi-k2.5, deepseek-r1) extended
 * reasoning is activated by setting NVIDIA_THINKING_MODE=true, which omits
 * tool definitions (NVIDIA NIM rejects thinking + tools together).
 * kimi-k2.6 always runs in thinking mode and never accepts tool definitions.
 *
 * NOTE: chat_template_kwargs must NOT be sent — its dict value causes a
 * server-side HTTP 500 "unhashable type: 'dict'" in NVIDIA's Python backend.
 *
 * Streaming uses the standard OpenAI SSE format (data: {...} / data: [DONE]).
 * The thinking content is surfaced as a "thinking" text block so the existing
 * agent-loop thinking display works without modification.
 */
async function callNvidia(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new Error('NVIDIA_API_KEY not set');

    // Thinking mode is opt-in: only enabled when NVIDIA_THINKING_MODE=true.
    // By default, capable models (kimi-k2.5, deepseek-r1) use standard
    // function-calling mode — tools work exactly as in any other provider.
    const thinkingEnabled = process.env.NVIDIA_THINKING_MODE === 'true';
    const supportsThinking = thinkingEnabled && NVIDIA_THINKING_CAPABLE_MODELS.has(model);

    // kimi-k2.6 always requires tools to be omitted (it runs exclusively in
    // thinking mode on NVIDIA NIM regardless of NVIDIA_THINKING_MODE).
    const nvBase = nvModelBase(model);
    const alwaysDisableTools = NVIDIA_ALWAYS_DISABLE_TOOLS.has(model) || NVIDIA_ALWAYS_DISABLE_TOOLS.has(nvBase);

    // When thinking mode (or always-disable-tools) is active, swap in a
    // special system prompt with a rich workspace snapshot instead of the
    // normal tool-list suffix (NVIDIA NIM rejects tools + thinking together).
    let systemPrompt = state.systemPrompt;
    if (supportsThinking || alwaysDisableTools) {
        if (!state.systemPromptStatic) {
            process.stderr.write('[open-claude-code] Warning: systemPromptStatic missing - falling back to full system prompt for ' + model + '\n');
        }
        const base = state.systemPromptStatic || state.systemPrompt;
        const workspaceContent = buildWorkspaceContent(process.cwd());
        systemPrompt = buildThinkingModelSystemPrompt(base, workspaceContent.summary);
    }
    const effectiveState = (supportsThinking || alwaysDisableTools)
        ? { ...state, systemPrompt }
        : state;

    // Build OpenAI-style messages
    const messages = buildOpenAIMessages(effectiveState);

    const body = {
        model,
        messages,
        max_tokens: resolveMaxOutputTokens(settings),
        temperature: 1.00,
        top_p: 1.00,
        stream: !!stream,
        // Include tools unless thinking mode is active or the model always
        // disables tools (e.g. kimi-k2.6 — NVIDIA NIM rejects thinking + tools).
        ...(!supportsThinking && !alwaysDisableTools && toolDefs.length > 0 && {
            tools: toOpenAITools(toolDefs),
        }),
    };

    const rateLimiter = _rlNvidia;
    rateLimiter.reset();

    let res;
    for (;;) {
        res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': stream ? 'text/event-stream' : 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const action = await rateLimiter.handleResponse(res);
            if (action === 'retry') {
                process.stderr.write(
                    `[open-claude-code] NVIDIA API ${res.status} - retrying (attempt ${rateLimiter.retryCount}/${rateLimiter.maxRetries})...\n`
                );
                continue;
            }
            const err = await res.text();
            throw new Error(`NVIDIA API error ${res.status}: ${err}`);
        }
        break; // success
    }

    if (stream) {
        // Stream with the generic OpenAI-style SSE parser
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamOpenAIResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateOpenAIStream(collected);
            },
        };
    }

    const data = await res.json();
    return convertNvidiaResponse(data);
}

/**
 * Custom Provider — generic OpenAI-compatible endpoint.
 *
 * Reads configuration from a provider object (stored in CUSTOM_PROVIDERS_JSON):
 *   { id, name, baseUrl, apiKey, models, headers }
 *
 * Supports streaming and non-streaming modes, tools (function calling),
 * and arbitrary extra HTTP headers (e.g. Accept: text/event-stream).
 */
async function callCustomProvider(providerCfg, model, state, toolDefs, settings, stream) {
    if (!providerCfg) throw new Error('Custom provider not found for model: ' + model);

    const apiKey  = providerCfg.apiKey || process.env[`CUSTOM_${providerCfg.id.toUpperCase().replace(/-/g, '_')}_API_KEY`];
    const baseUrl = (providerCfg.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error(`Custom provider "${providerCfg.id}": baseUrl is required`);
    if (!apiKey)  throw new Error(`Custom provider "${providerCfg.id}": apiKey is required`);

    // kimi-k2.5 / deepseek-r1 on the NVIDIA NIM backend support extended
    // thinking. When NVIDIA_THINKING_MODE=true we exclude tools because
    // NVIDIA NIM rejects the combination of thinking + tool-calling.
    // kimi-k2.6 ALWAYS requires tools to be omitted — it runs exclusively in
    // thinking mode on NVIDIA NIM.  We match both the fully-qualified form
    // ("moonshotai/kimi-k2.6") and any short-name alias ("kimi-k2.6").
    // Do NOT send chat_template_kwargs — its dict value causes a server-side
    // HTTP 500 "unhashable type: 'dict'" error in NVIDIA's Python backend.
    // Also respect an explicit providerCfg.disableTools flag.
    const baseModel = nvModelBase(model);
    const isNvidiaThinkingModel = NVIDIA_THINKING_CAPABLE_MODELS.has(model) || NVIDIA_THINKING_CAPABLE_MODELS.has(baseModel);
    const isAlwaysNoTools = NVIDIA_ALWAYS_DISABLE_TOOLS.has(model) || NVIDIA_ALWAYS_DISABLE_TOOLS.has(baseModel);
    const thinkingEnabled = process.env.NVIDIA_THINKING_MODE === 'true';
    const disableTools = providerCfg.disableTools || isAlwaysNoTools || (isNvidiaThinkingModel && thinkingEnabled);

    const messages = buildOpenAIMessages(state);

    // Some OpenAI-compatible providers (notably several OpenRouter free models)
    // reject explicit sampling fields and require provider defaults instead.
    // Send temperature/top_p only when explicitly configured for this provider.
    const customTemperature = typeof providerCfg.temperature === 'number'
        ? providerCfg.temperature
        : null;
    const customTopP = typeof providerCfg.top_p === 'number'
        ? providerCfg.top_p
        : (typeof providerCfg.topP === 'number' ? providerCfg.topP : null);

    const body = {
        model,
        messages,
        max_tokens: resolveMaxOutputTokens(settings),
        ...(customTemperature !== null && { temperature: customTemperature }),
        ...(customTopP !== null && { top_p: customTopP }),
        stream: !!stream,
        ...(toolDefs.length > 0 && !disableTools && {
            tools: toOpenAITools(toolDefs),
        }),
    };

    // Build headers: start with mandatory auth + content-type, then add custom headers
    const reqHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
    if (stream) {
        reqHeaders['Accept'] = 'text/event-stream';
    }
    for (const h of (providerCfg.headers || [])) {
        if (h.name && h.value !== undefined) {
            reqHeaders[h.name] = h.value;
        }
    }

    const rateLimiter = _rlCustom;
    rateLimiter.reset();
    let res;
    for (;;) {
        res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const action = await rateLimiter.handleResponse(res);
            if (action === 'retry') continue;
            const err = await res.text();
            throw new Error(`Custom provider "${providerCfg.id}" error ${res.status}: ${err}`);
        }
        break;
    }

    if (stream) {
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamOpenAIResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateOpenAIStream(collected);
            },
        };
    }

    const data = await res.json();
    return convertNvidiaResponse(data); // reuse OpenAI-compatible converter
}

/**
 * Build an OpenAI-style messages array from agent loop state.
 *
 * F3: assistant content arrays that contain tool_use blocks now emit a proper
 *     { role:'assistant', tool_calls:[...] } message so that OpenAI-compatible
 *     APIs can correctly correlate assistant tool calls with their results.
 * F7: all text blocks in the same assistant message are merged into a single
 *     content string to avoid exploding the turn count.
 */
function buildOpenAIMessages(state) {
    const messages = [];
    if (state.systemPrompt) {
        messages.push({ role: 'system', content: state.systemPrompt });
    }
    for (const msg of state.messages) {
        if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
            if (msg.role === 'assistant') {
                // F3 + F7: merge text blocks; emit tool_calls list for tool_use blocks
                const textParts = [];
                const toolCalls = [];
                for (const block of msg.content) {
                    if (block.type === 'text') {
                        textParts.push(block.text || '');
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input ?? {}),
                            },
                        });
                    }
                    // thinking blocks are not forwarded to OpenAI-style providers
                }
                if (textParts.length > 0 || toolCalls.length > 0) {
                    const assistantMsg = { role: 'assistant' };
                    if (textParts.length > 0) assistantMsg.content = textParts.join('');
                    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
                    messages.push(assistantMsg);
                }
            } else {
                // user role: emit tool_result blocks as 'tool' role messages,
                // then any text blocks as a regular user message
                const toolResults = [];
                const textParts = [];
                for (const block of msg.content) {
                    if (block.type === 'tool_result') {
                        toolResults.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: typeof block.content === 'string'
                                ? block.content
                                : JSON.stringify(block.content),
                        });
                    } else if (block.type === 'text') {
                        textParts.push(block.text || '');
                    }
                }
                for (const tr of toolResults) messages.push(tr);
                if (textParts.length > 0) {
                    messages.push({ role: 'user', content: textParts.join('') });
                }
            }
        }
    }
    return messages;
}

/**
 * Convert a non-streaming NVIDIA response to the internal format.
 * NVIDIA NIM returns the same shape as OpenAI, but may include a
 * "thinking" field directly on the message for supported models.
 */
function convertNvidiaResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No choices in NVIDIA response');

    const content = [];

    // Some NVIDIA models surface thinking as a separate message field
    const thinkingText = choice.message?.thinking || choice.message?.reasoning_content;
    if (thinkingText) {
        content.push({ type: 'thinking', thinking: thinkingText });
    }

    if (choice.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: (() => {
                    try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; }
                })(),
            });
        }
    }

    return {
        content,
        stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : (choice.finish_reason || 'end_turn'),
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
        },
    };
}

/**
 * Parse an OpenAI-style SSE stream into events.
 * Each line has the format "data: {json}" or "data: [DONE]".
 * Thinking content in delta is surfaced as a synthetic
 * content_block_delta with type "thinking_delta" so the agent loop
 * can display it without changes.
 */
async function* streamOpenAIResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let thinkingBuffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete last line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === ':') continue;
                if (!trimmed.startsWith('data:')) continue;

                const raw = trimmed.slice(5).trim();
                if (raw === '[DONE]') {
                    yield { type: 'done' };
                    return;
                }

                let chunk;
                try { chunk = JSON.parse(raw); } catch { continue; }

                // Surface API errors returned inside the SSE stream (HTTP 200 with error body)
                if (chunk.error) {
                    throw new Error(chunk.error.message || JSON.stringify(chunk.error));
                }

                // Usage-only chunk produced by stream_options:{include_usage:true}.
                // These have an empty choices array and a populated usage object.
                // The check is: choices is missing or empty AND usage is present.
                const hasChoices = Array.isArray(chunk.choices) && chunk.choices.length > 0;
                if (!hasChoices && chunk.usage) {
                    yield {
                        type: 'usage',
                        input_tokens: chunk.usage.prompt_tokens || 0,
                        output_tokens: chunk.usage.completion_tokens || 0,
                    };
                    continue;
                }

                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;

                // Thinking token (deepseek-r1 / kimi-k2.5)
                const thinkingDelta = delta.reasoning_content || delta.thinking;
                if (thinkingDelta) {
                    thinkingBuffer += thinkingDelta;
                    yield {
                        type: 'content_block_delta',
                        delta: { type: 'thinking_delta', thinking: thinkingDelta },
                    };
                }

                // Regular text content
                if (delta.content) {
                    // If we have accumulated thinking, emit block boundaries once
                    if (thinkingBuffer) {
                        thinkingBuffer = '';
                    }
                    yield {
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: delta.content },
                    };
                }

                // Tool calls
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        yield {
                            type: 'content_block_delta',
                            delta: {
                                type: 'tool_call_delta',
                                index: tc.index,
                                id: tc.id,
                                name: tc.function?.name,
                                partial_json: tc.function?.arguments || '',
                            },
                        };
                    }
                }

                // Finish reason
                const finishReason = chunk.choices?.[0]?.finish_reason;
                if (finishReason) {
                    yield {
                        type: 'message_delta',
                        delta: { stop_reason: finishReason === 'stop' ? 'end_turn' : finishReason },
                    };
                }
            }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data:')) {
                const raw = trimmed.slice(5).trim();
                if (raw && raw !== '[DONE]') {
                    try {
                        const chunk = JSON.parse(raw);
                        if (chunk.error) {
                            throw new Error(chunk.error.message || JSON.stringify(chunk.error));
                        }
                        const hasChoices = Array.isArray(chunk.choices) && chunk.choices.length > 0;
                        if (!hasChoices && chunk.usage) {
                            yield {
                                type: 'usage',
                                input_tokens: chunk.usage.prompt_tokens || 0,
                                output_tokens: chunk.usage.completion_tokens || 0,
                            };
                        } else {
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.reasoning_content || delta?.thinking) {
                                yield {
                                    type: 'content_block_delta',
                                    delta: { type: 'thinking_delta', thinking: delta.reasoning_content || delta.thinking },
                                };
                            }
                            if (delta?.content) {
                                yield {
                                    type: 'content_block_delta',
                                    delta: { type: 'text_delta', text: delta.content },
                                };
                            }
                            if (delta?.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    yield {
                                        type: 'content_block_delta',
                                        delta: {
                                            type: 'tool_call_delta',
                                            index: tc.index,
                                            id: tc.id,
                                            name: tc.function?.name,
                                            partial_json: tc.function?.arguments || '',
                                        },
                                    };
                                }
                            }
                            const finishReason = chunk.choices?.[0]?.finish_reason;
                            if (finishReason) {
                                yield {
                                    type: 'message_delta',
                                    delta: { stop_reason: finishReason === 'stop' ? 'end_turn' : finishReason },
                                };
                            }
                        }
                    } catch {
                        // ignore malformed final chunk
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Accumulate streamed OpenAI-style events into an internal message object.
 */
function accumulateOpenAIStream(events) {
    const message = {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };

    let textContent = '';
    let thinkingContent = '';
    const toolCallMap = {}; // index -> { id, name, arguments }

    for (const event of events) {
        if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking_delta') {
                thinkingContent += event.delta.thinking || '';
            } else if (event.delta?.type === 'text_delta') {
                textContent += event.delta.text || '';
            } else if (event.delta?.type === 'tool_call_delta') {
                const idx = event.delta.index ?? 0;
                if (!toolCallMap[idx]) {
                    toolCallMap[idx] = { id: event.delta.id || `call_${idx}`, name: event.delta.name || '', arguments: '' };
                }
                if (event.delta.name) toolCallMap[idx].name = event.delta.name;
                if (event.delta.id) toolCallMap[idx].id = event.delta.id;
                toolCallMap[idx].arguments += event.delta.partial_json || '';
            }
        } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
        } else if (event.type === 'usage') {
            // Produced when stream_options:{include_usage:true} is set.
            // Overwrite the zero placeholders with the real token counts.
            message.usage.input_tokens = event.input_tokens;
            message.usage.output_tokens = event.output_tokens;
        }
    }

    if (thinkingContent) {
        message.content.push({ type: 'thinking', thinking: thinkingContent });
    }
    if (textContent) {
        message.content.push({ type: 'text', text: textContent });
    }
    for (const tc of Object.values(toolCallMap)) {
        let input = {};
        try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
        message.content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }

    if (!message.stop_reason) message.stop_reason = 'end_turn';
    return message;
}

function convertOpenAIResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No choices in OpenAI response');

    const content = [];
    if (choice.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
            let input = {};
            try {
                input = JSON.parse(tc.function.arguments || '{}');
            } catch (e) {
                // Truncate raw args to avoid accidentally logging secrets or PII.
                const preview = (tc.function.arguments || '').slice(0, 80);
                process.stderr.write(
                    `[open-claude-code] Warning: could not parse tool arguments for "${tc.function.name}": ${e.message} — args (truncated): ${preview}\n`
                );
            }
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input,
            });
        }
    }

    return {
        content,
        stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason,
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
        },
    };
}

function convertGoogleResponse(data) {
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No candidates in Google response');

    const content = [];
    for (const part of candidate.content?.parts || []) {
        // Gemini 2.5 models return internal reasoning as parts with
        // part.thought === true.  Promote these to thinking blocks so
        // the agent loop can display them correctly rather than treating
        // them as regular response text.
        if (part.thought && part.text) {
            content.push({ type: 'thinking', thinking: part.text });
        } else if (part.text) {
            content.push({ type: 'text', text: part.text });
        }
        // F4: surface function calls (tool_use) from Gemini responses
        if (part.functionCall) {
            content.push({
                type: 'tool_use',
                // Gemini doesn't provide stable call IDs; use a monotonic process-scoped
                // counter to guarantee uniqueness even for same-millisecond parallel calls.
                id: `${part.functionCall.name}_${nextId()}`,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
            });
        }
    }

    return {
        content,
        stop_reason: candidate.finishReason === 'STOP' ? 'end_turn' : (candidate.finishReason || 'end_turn'),
        usage: {
            input_tokens: data.usageMetadata?.promptTokenCount || 0,
            output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        },
    };
}

function accumulateFromCollected(events) {
    const message = {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };

    let currentBlock = null;

    for (const event of events) {
        switch (event.type) {
            case 'message_start':
                if (event.message?.usage) {
                    message.usage.input_tokens = event.message.usage.input_tokens || 0;
                }
                break;
            case 'content_block_start':
                currentBlock = { ...event.content_block };
                if (currentBlock.type === 'text') currentBlock.text = '';
                if (currentBlock.type === 'thinking') currentBlock.thinking = '';
                if (currentBlock.type === 'tool_use') currentBlock.input = '';
                message.content.push(currentBlock);
                break;
            case 'content_block_delta':
                if (!currentBlock) break;
                if (event.delta?.type === 'text_delta') currentBlock.text += event.delta.text;
                else if (event.delta?.type === 'thinking_delta') currentBlock.thinking += event.delta.thinking;
                else if (event.delta?.type === 'input_json_delta') currentBlock.input += event.delta.partial_json;
                break;
            case 'content_block_stop':
                if (currentBlock?.type === 'tool_use' && typeof currentBlock.input === 'string') {
                    try { currentBlock.input = JSON.parse(currentBlock.input || '{}'); } catch { currentBlock.input = {}; }
                }
                currentBlock = null;
                break;
            case 'message_delta':
                if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
                if (event.usage) message.usage.output_tokens = event.usage.output_tokens || 0;
                break;
            case 'ping':
                break;
        }
    }

    return message;
}

/**
 * Detect repetitive output patterns in streamed text.
 *
 * Returns true when the model appears to be stuck generating repeated phrases.
 *
 * Two detection passes:
 *  1. (tuned) Look for any phrase of length 40–300 chars that appears ≥6 times
 *     in the most recent 800 characters — catches tight word-for-word loops.
 *  2. (F11) Rolling-window hash pass — divide the last 4000 chars into 500-char
 *     windows and compare their djb2 hashes. If the same hash appears ≥3 times
 *     the model is repeating a large block (slow drift loops).
 *
 * @param {string} text - accumulated streamed text so far
 * @returns {boolean}
 */
function detectRepetition(text) {
    if (text.length < 200) return false;

    // ── Pass 1: tight phrase repetition (original algorithm) ────────────────
    const tail = text.slice(-800);
    for (let phraseLen = 40; phraseLen <= 300; phraseLen += 10) {
        if (phraseLen >= tail.length) break;
        const phrase = tail.slice(-phraseLen);
        let count = 0;
        let pos = 0;
        while ((pos = tail.indexOf(phrase, pos)) !== -1) {
            count++;
            pos += phraseLen;
            if (count >= 6) return true;
        }
    }

    // ── Pass 2: F11 — rolling-window hash for slow drift loops ──────────────
    if (text.length >= 2000) {
        const WINDOW = 500;
        const STEP   = 1000;
        const big = text.slice(-4000);
        const hashCounts = new Map();
        for (let i = 0; i + WINDOW <= big.length; i += STEP) {
            const h = djb2Hash(big.slice(i, i + WINDOW));
            const c = (hashCounts.get(h) || 0) + 1;
            if (c >= 3) return true;
            hashCounts.set(h, c);
        }
    }

    return false;
}

function resolveMaxOutputTokens(settings) {
    // Precedence: maxOutputTokens (new) -> maxTokens (legacy alias) -> default.
    // Keep maxTokens as a backward-compatible fallback for older configs.
    const configured = Number(settings?.maxOutputTokens ?? settings?.maxTokens);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Fast 32-bit djb2 hash for repetition detection.
 * @param {string} s
 * @returns {number}
 */
function djb2Hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h |= 0; // keep 32-bit
    }
    return h;
}

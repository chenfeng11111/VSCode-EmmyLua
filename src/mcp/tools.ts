import * as vscode from 'vscode';
import { z } from 'zod';
import type { SessionManager } from './sessionManager';

let _stopMcp: (() => void) | undefined;

export function setStopMcpCallback(fn: () => void): void {
    _stopMcp = fn;
}

interface ToolDef {
    name: string;
    description: string;
    inputSchema: object;
    handler: (args: any, sm: SessionManager) => Promise<{ content: { type: string; text: string }[] }>;
}

function activeSession(): vscode.DebugSession {
    const s = vscode.debug.activeDebugSession;
    if (!s) throw new Error('No active debug session — user must start an emmylua_new debug session first (press F5 or call the launch tool)');
    return s;
}

function requestWithTimeout(session: vscode.DebugSession, command: string, args?: any, timeoutMs = 10000): Promise<any> {
    return Promise.race([
        session.customRequest(command, args),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`DAP request '${command}' timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
}

const tools: ToolDef[] = [
    {
        name: 'list_supported_languages',
        description: 'List the programming languages supported by this debugger',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ languages: ['lua'] }) }],
        }),
    },
    {
        name: 'get_active_sessions',
        description: 'List all active debug sessions — if empty, no debug session is running',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async (_a, sm) => ({
            content: [{ type: 'text', text: JSON.stringify(sm.getActiveSessions().map(s => ({
                id: s.session.id, name: s.session.name, type: s.session.type,
                startedAt: s.startedAt.toISOString(),
            }))) }],
        }),
    },
    {
        name: 'threads',
        description: '[Requires active debug session] Get all threads in the active debug session',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
            const r = await requestWithTimeout(activeSession(), 'threads');
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'stack_trace',
        description: '[Requires active debug session] Get stack trace for a thread',
        inputSchema: {
            type: 'object',
            properties: {
                threadId: { type: 'number', description: 'Thread ID' },
                startFrame: { type: 'number', description: 'Start frame index (optional)' },
                levels: { type: 'number', description: 'Number of levels (optional)' },
            },
            required: ['threadId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'stackTrace', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'scopes',
        description: '[Requires active debug session] Get scopes for a stack frame',
        inputSchema: {
            type: 'object',
            properties: { frameId: { type: 'number', description: 'Stack frame ID' } },
            required: ['frameId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'scopes', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'variables',
        description: '[Requires active debug session] Get variables for a scope or variable reference',
        inputSchema: {
            type: 'object',
            properties: {
                variablesReference: { type: 'number', description: 'Variable reference ID' },
                filter: { type: 'string', description: 'Optional filter (indexed, named)' },
                start: { type: 'number', description: 'Start index (optional)' },
                count: { type: 'number', description: 'Count (optional)' },
            },
            required: ['variablesReference'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'variables', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'evaluate',
        description: '[Requires active debug session] Evaluate an expression in a stack frame context',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: 'Expression to evaluate' },
                frameId: { type: 'number', description: 'Stack frame ID' },
            },
            required: ['expression', 'frameId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'evaluate', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'set_variable',
        description: '[Requires active debug session] Set the value of a variable or expression',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: 'Variable name or expression' },
                value: { type: 'string', description: 'New value' },
                frameId: { type: 'number', description: 'Stack frame ID' },
            },
            required: ['expression', 'value', 'frameId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'setExpression', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'list_breakpoints',
        description: 'List all breakpoints in the workspace',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async (_a, sm) => {
            return { content: [{ type: 'text', text: JSON.stringify(sm.getAllBreakpoints()) }] };
        },
    },
    {
        name: 'set_breakpoints',
        description: 'Set breakpoints in a source file',
        inputSchema: {
            type: 'object',
            properties: {
                source: {
                    type: 'object',
                    description: 'Source file',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        name: { type: 'string', description: 'File name' },
                    },
                    required: ['path'],
                },
                breakpoints: {
                    type: 'array',
                    description: 'Breakpoints',
                    items: {
                        type: 'object',
                        properties: {
                            line: { type: 'number', description: 'Line number (1-based)' },
                            column: { type: 'number', description: 'Column (optional)' },
                            condition: { type: 'string', description: 'Condition (optional)' },
                            hitCondition: { type: 'string', description: 'Hit condition (optional)' },
                            logMessage: { type: 'string', description: 'Log message (optional)' },
                        },
                        required: ['line'],
                    },
                },
            },
            required: ['source', 'breakpoints'],
        },
        handler: async (a, sm) => {
            const sourcePath = a.source?.path || '';
            const doc = await vscode.workspace.openTextDocument(sourcePath);
            const newBps = (a.breakpoints || []).map((bp: any) => new vscode.SourceBreakpoint(
                new vscode.Location(doc.uri, new vscode.Position(bp.line - 1, (bp.column || 1) - 1)),
                bp.condition, bp.hitCondition, bp.logMessage,
            ));
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
            vscode.debug.addBreakpoints(newBps);
            sm.addBreakpoints(sourcePath, a.breakpoints);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
    },
    {
        name: 'remove_breakpoints',
        description: 'Remove specific breakpoints by ID, or all breakpoints in a source file',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'string' }, description: 'Breakpoint IDs to remove (from list_breakpoints)' },
                source: { type: 'string', description: 'Source file path — removes all breakpoints in this file' },
            },
        },
        handler: async (a) => {
            const ids = a.ids as string[] | undefined;
            const source = a.source as string | undefined;
            const toRemove = vscode.debug.breakpoints.filter(bp => {
                if (ids?.length) return ids.includes(bp.id);
                if (source) {
                    const sbp = bp as any;
                    const src = sbp._source?.path || sbp.source?.path || sbp.uri?.fsPath || sbp.uri?.toString();
                    return src === source;
                }
                return false;
            });
            vscode.debug.removeBreakpoints(toRemove);
            return { content: [{ type: 'text', text: JSON.stringify({ removed: toRemove.length }) }] };
        },
    },
    {
        name: 'clear_breakpoints',
        description: 'Remove all breakpoints',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
            vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
    },
    {
        name: 'continue',
        description: 'Continue execution of a thread',
        inputSchema: {
            type: 'object',
            properties: { threadId: { type: 'number', description: 'Thread ID' } },
            required: ['threadId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'continue', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'pause',
        description: 'Pause a running thread',
        inputSchema: {
            type: 'object',
            properties: { threadId: { type: 'number', description: 'Thread ID' } },
            required: ['threadId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'pause', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'step_over',
        description: 'Step over (next line) in a thread',
        inputSchema: {
            type: 'object',
            properties: { threadId: { type: 'number', description: 'Thread ID' } },
            required: ['threadId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'next', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'step_in',
        description: 'Step into a function call',
        inputSchema: {
            type: 'object',
            properties: { threadId: { type: 'number', description: 'Thread ID' } },
            required: ['threadId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'stepIn', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'step_out',
        description: 'Step out of the current function',
        inputSchema: {
            type: 'object',
            properties: { threadId: { type: 'number', description: 'Thread ID' } },
            required: ['threadId'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'stepOut', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'source',
        description: 'Get source code by sourceReference',
        inputSchema: {
            type: 'object',
            properties: {
                sourceReference: { type: 'number', description: 'Source reference from stack frame' },
            },
            required: ['sourceReference'],
        },
        handler: async (a) => {
            const r = await requestWithTimeout(activeSession(), 'source', a);
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'disconnect',
        description: 'Disconnect and terminate the debug session',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
            const r = await requestWithTimeout(activeSession(), 'disconnect');
            return { content: [{ type: 'text', text: JSON.stringify(r ?? {}) }] };
        },
    },
    {
        name: 'launch',
        description: 'Start a new debug session (emmylua_new)',
        inputSchema: {
            type: 'object',
            properties: {
                host: { type: 'string', description: 'Debugger host (default: localhost)' },
                port: { type: 'number', description: 'Debugger port (default: 9544)' },
                ext: { type: 'array', items: { type: 'string' }, description: 'File extensions to support (default: [".lua",".lua.txt",".lua.bytes"])' },
                ideConnectDebugger: { type: 'boolean', description: 'IDE connects to debugger (default: true)' },
            },
            required: [],
        },
        handler: async (a) => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) throw new Error('No workspace folder open');
            const config: vscode.DebugConfiguration = {
                type: 'emmylua_new',
                request: 'launch',
                name: 'EmmyLua New Debug',
                host: a.host ?? 'localhost',
                port: a.port ?? 9544,
                ext: a.ext ?? ['.lua', '.lua.txt', '.lua.bytes'],
                ideConnectDebugger: a.ideConnectDebugger ?? true,
            };
            const success = await vscode.debug.startDebugging(workspaceFolder, config);
            if (!success) {
                _stopMcp?.();
            }
            return { content: [{ type: 'text', text: JSON.stringify({ success }) }] };
        },
    },
];

export function registerTools(server: any, sessionManager: SessionManager): void {
    server.setRequestHandler(
        z.object({ method: z.literal('tools/list') }),
        () => ({
            tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            })),
        }),
    );

    server.setRequestHandler(
        z.object({
            method: z.literal('tools/call'),
            params: z.object({
                name: z.string(),
                arguments: z.any().optional(),
            }),
        }),
        async (request: any) => {
            const { name, arguments: args } = request.params;
            const tool = tools.find(t => t.name === name);
            if (!tool) {
                throw new Error(`Unknown tool: ${name}`);
            }
            try {
                return await tool.handler(args || {}, sessionManager);
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                    isError: true,
                };
            }
        },
    );
}

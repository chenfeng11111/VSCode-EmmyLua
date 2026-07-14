import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerTools, setStopMcpCallback } from './tools';
import { SessionManager } from './sessionManager';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8827;

let mcpServer: any;
let httpServer: any;
let sessionManager: SessionManager | undefined;
let transport: StreamableHTTPServerTransport | undefined;
const sseTransports = new Map<string, SSEServerTransport>();

function createMcpServer(): any {
    const server = new Server(
        { name: 'emmylua-mcp', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );
    registerTools(server, sessionManager!);
    return server;
}
export const mcpOutput = vscode.window.createOutputChannel('EmmyLua MCP');

function log(msg: string): void {
    mcpOutput.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function corsWrap(res: any): void {
    const orig = res.writeHead.bind(res);
    res.writeHead = function (this: any, status: number, ...args: any[]) {
        if (!this.hasHeader('Access-Control-Allow-Origin')) {
            this.setHeader('Access-Control-Allow-Origin', '*');
            this.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
            this.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
            this.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
        }
        return orig(status, ...args);
    };
}

function tryListen(host: string, startPort: number, maxRetries: number): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const attempt = (i: number) => {
            if (i >= maxRetries) {
                reject(new Error(`All ports ${startPort}-${startPort + maxRetries - 1} in use`));
                return;
            }
            const p = startPort + i;
            const s = http.createServer(async (req, res) => {
                corsWrap(res);
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                if (url.pathname === '/mcp' && transport) {
                    try {
                        await transport.handleRequest(req, res);
                    } catch (e: any) {
                        if (!res.headersSent) {
                            try { res.writeHead(400).end(e.message); } catch {}
                        }
                    }
                } else if (url.pathname === '/sse') {
                    try {
                        const sseTransport = new SSEServerTransport('/messages', res);
                        sseTransports.set(sseTransport.sessionId, sseTransport);
                        res.on('close', () => {
                            sseTransports.delete(sseTransport.sessionId);
                        });
                        const sseServer = createMcpServer();
                        await sseServer.connect(sseTransport);
                    } catch (e: any) {
                        if (!res.headersSent) {
                            try { res.writeHead(500).end(e.message); } catch {}
                        }
                    }
                } else if (url.pathname === '/messages' && req.method === 'POST') {
                    const sessionId = url.searchParams.get('sessionId');
                    if (!sessionId) {
                        res.writeHead(400).end('Missing sessionId parameter');
                        return;
                    }
                    const sseTransport = sseTransports.get(sessionId);
                    if (!sseTransport) {
                        res.writeHead(404).end('Session not found');
                        return;
                    }
                    try {
                        await sseTransport.handlePostMessage(req, res);
                    } catch (e: any) {
                        if (!res.headersSent) {
                            try { res.writeHead(500).end(e.message); } catch {}
                        }
                    }
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
            s.once('error', (e: any) => {
                s.close();
                if (e.code === 'EADDRINUSE') {
                    attempt(i + 1);
                } else {
                    reject(e);
                }
            });
            s.listen(p, host, () => {
                resolve({ server: s, port: p });
            });
        };
        attempt(0);
    });
}

export async function startMcpServer(host?: string, port?: number): Promise<void> {
    const resolvedHost = host || process.env['EMMY_MCP_HOST'] || DEFAULT_HOST;
    const resolvedPort = port || parseInt(process.env['EMMY_MCP_PORT'] || '', 10) || DEFAULT_PORT;

    sessionManager = new SessionManager();
    setStopMcpCallback(stopMcpServer);

    const mcpServerInstance = createMcpServer();
    transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
    });
    await mcpServerInstance.connect(transport);
    mcpServer = mcpServerInstance;

    try {
        const { server: httpSrv, port: actualPort } = await tryListen(resolvedHost, resolvedPort, 10);
        httpServer = httpSrv;
        log(`MCP server started at http://${host}:${actualPort}/mcp (Streamable HTTP) and /sse (SSE)`);
    } catch (e: any) {
        log(`Failed to start: ${e.message}`);
    }
}

export function stopMcpServer(): void {
    sessionManager?.dispose();
    for (const [, st] of sseTransports) {
        st.close().catch(() => {});
    }
    sseTransports.clear();
    if (mcpServer) {
        mcpServer.close().catch(() => {});
    }
    if (transport) {
        transport.close().catch(() => {});
    }
    if (httpServer) {
        httpServer.close();
    }
    mcpServer = undefined;
    httpServer = undefined;
    sessionManager = undefined;
    transport = undefined;
}

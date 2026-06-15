import * as vscode from 'vscode';
import * as path from 'path';

interface SessionInfo {
    session: vscode.DebugSession;
    startedAt: Date;
}

interface StoredBreakpoint {
    id: string;
    enabled: boolean;
    source?: string;
    line?: number;
    column?: number;
}

export class SessionManager implements vscode.Disposable {
    private sessions = new Map<string, SessionInfo>();
    private breakpoints = new Map<string, StoredBreakpoint>();
    private mcpBps = new Map<string, StoredBreakpoint>();
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession(session => {
                this.sessions.set(session.id, { session, startedAt: new Date() });
            }),
            vscode.debug.onDidTerminateDebugSession(session => {
                this.sessions.delete(session.id);
            }),
            vscode.debug.onDidChangeBreakpoints(e => {
                for (const bp of e.added) this.cacheBreakpoint(bp);
                for (const bp of e.removed) {
                    this.breakpoints.delete(bp.id);
                    const sbp = bp as any;
                    const loc = sbp.location;
                    const line = loc?.line !== undefined ? loc.line + 1 : loc?.range?.start?.line !== undefined ? loc.range.start.line + 1 : undefined;
                    const src = this.norm(sbp._source?.path || sbp.source?.path || sbp.uri?.fsPath || sbp.uri?.toString() || loc?.uri?.fsPath || loc?.uri?.toString());
                    if (src && line !== undefined) this.mcpBps.delete(`${src}:${line}`);
                }
                for (const bp of e.changed) this.cacheBreakpoint(bp);
            }),
        );
        for (const bp of vscode.debug.breakpoints) this.cacheBreakpoint(bp);
    }

    private norm(s: string | undefined): string | undefined {
        return s ? path.normalize(s) : undefined;
    }

    private cacheBreakpoint(bp: vscode.Breakpoint): void {
        if (this.breakpoints.has(bp.id)) return;
        const sbp = bp as any;
        let line: number | undefined;
        let column: number | undefined;
        const loc = sbp.location;
        if (loc) {
            if (loc.line !== undefined) {
                line = loc.line + 1;
                column = loc.character;
            } else if (loc.range) {
                line = loc.range.start.line + 1;
                column = loc.range.start.character;
            }
        }
        let source = this.norm(sbp._source?.path || sbp.source?.path || sbp.uri?.fsPath || sbp.uri?.toString());
        if (!source && loc?.uri) source = this.norm(loc.uri.fsPath || loc.uri.toString());
        if (!source) {
            const editor = vscode.window.activeTextEditor;
            if (editor) source = this.norm(editor.document.uri.fsPath);
        }
        this.breakpoints.set(bp.id, { id: bp.id, enabled: bp.enabled, source, line, column });
    }

    addBreakpoints(source: string, breakpoints: { id?: string; line: number; column?: number }[]): void {
        const src = this.norm(source) || source;
        for (const bp of breakpoints) {
            const key = `${src}:${bp.line}`;
            this.mcpBps.set(key, { id: key, enabled: true, source: src, line: bp.line, column: bp.column });
        }
    }

    getAllBreakpoints(): StoredBreakpoint[] {
        const result = Array.from(this.breakpoints.values());
        for (const mbp of this.mcpBps.values()) {
            if (!result.some(r => this.norm(r.source) === this.norm(mbp.source) && r.line === mbp.line)) {
                result.push(mbp);
            }
        }
        return result;
    }

    getActiveSessions(): SessionInfo[] {
        return Array.from(this.sessions.values());
    }

    getSession(id: string): SessionInfo | undefined {
        return this.sessions.get(id);
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.sessions.clear();
        this.breakpoints.clear();
        this.mcpBps.clear();
    }
}

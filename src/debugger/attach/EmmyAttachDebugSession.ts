import * as net from "net";
import * as cp from "child_process";
import * as proto from "../base/EmmyDebugProto";
import { EmmyDebugSession } from "../base/EmmyDebugSession";
import { OutputEvent } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";


interface EmmyAttachDebugArguments extends DebugProtocol.AttachRequestArguments {
    extensionPath: string;
    sourcePaths: string[];
    ext: string[];
    pid: number;
    captureLog?: boolean;
}

enum WinArch {
    X86, X64
}

export class EmmyAttachDebugSession extends EmmyDebugSession {

    private pid = 0;
    private captureLog?: boolean;

    private getPort(pid: number): number {
        var port = pid;
        while (port > 0xffff) { port -= 0xffff; }
        while (port < 0x400) { port += 0x400; }
        return port;
    }

    async attachRequest(response: DebugProtocol.AttachResponse, args: EmmyAttachDebugArguments) {
        this.extensionPath = args.extensionPath;
        this.ext = args.ext;
        this.pid = args.pid;
        this.captureLog = args.captureLog;

        await this.attach();

        // send resp
        const client = net.connect(this.getPort(this.pid), "localhost")
            .on('connect', () => {
                this.sendResponse(response);
                this.onConnect(client);
                this.readClient(client);
                this.sendMessage({ cmd: proto.MessageCMD.StartHookReq });
            })
            .on('error', err => {
                response.success = false;
                response.message = `${err}`;
                this.sendResponse(response);
            });
        this.client = client;
    }

    private async detectArch(): Promise<WinArch> {
        const cwd = `${this.extensionPath}/debugger/emmy/windows/x86`;
        const args = [
            `${cwd}/emmy_tool.exe`,
            'arch_pid',
            `${this.pid}`
        ];

        // 获取stdout输出
        return new Promise<WinArch>((r, c) => {
            cp.exec(args.join(" "), (err, stdout, stderr) => {
                if (err) {
                    c(err);
                }
                else {
                    const arch = Number(stdout.trim());
                    if (arch === 0) {
                        r(WinArch.X64);
                    }
                    else {
                        r(WinArch.X86);
                    }
                }
            });
        });
    }

    private async attach(): Promise<void> {
        const arch = await this.detectArch();
        const archName = arch === WinArch.X64 ? 'x64' : 'x86';
        const cwd = `${this.extensionPath}/debugger/emmy/windows/${archName}`;
        const args = [
            `${cwd}/emmy_tool.exe`,
            'attach',
            '-p',
            `${this.pid}`,
            '-dir',
            `"${cwd}"`,
            '-dll',
            'emmy_hook.dll'
        ];
        if (this.captureLog) {
            args.push("-capture-log");
        }

        return new Promise<void>((r, c) => {
            cp.exec(args.join(" "), { cwd: cwd }, (err, stdout, stderr) => {
                this.sendEvent(new OutputEvent(stdout));
            })
                .on('error', (err) => {
                    console.error(`detectArch error: ${err}`);
                })
                .on('close', (code) => {
                    if (code === 0) {
                        if (this.captureLog) {
                            const captureArgs = [
                                "emmy_tool.exe",
                                "receive_log",
                                "-p",
                                `${this.pid}`,
                            ]
                            cp.spawn(`wt`, captureArgs, {
                                cwd: cwd
                            });
                        }
                        r();
                    }
                    else {
                        c(`Exit code = ${code}`);
                    }
                });
        });
    }

    protected handleDebugMessage(cmd: proto.MessageCMD, msg: any) {
        switch (cmd) {
            case proto.MessageCMD.AttachedNotify:
                const n: number = msg.state;
                this.sendEvent(new OutputEvent(`Attached to lua state 0x${n.toString(16)}\n`));
                break;
            case proto.MessageCMD.LogNotify:
                this.sendEvent(new OutputEvent(`${msg.message}\n`));
                break;
        }
        super.handleDebugMessage(cmd, msg);
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import { DebugConfigurationBase } from "../base/DebugConfigurationBase";
import { DebuggerProvider } from "../base/DebuggerProvider";

export interface EmmyLaunchDebugConfiguration extends DebugConfigurationBase {
    program: string;
    arguments: string[];
    workingDir: string;
    blockOnExit: boolean;
    useWindowsTerminal: boolean;
}


export class EmmyLaunchDebuggerProvider extends DebuggerProvider {
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, configuration: EmmyLaunchDebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
        const resolvedProgram = this.resolveProgramPath(configuration.program);
        const resolvedWorkingDir = this.resolveWorkingDirectory(folder, configuration.workingDir, resolvedProgram);

        if (this.isNullOrEmpty(resolvedProgram)) {
            vscode.window.showErrorMessage('EmmyLua launch debug requires a Lua entry file. Open a Lua file or set the program field in launch.json.');
            return undefined;
        }

        configuration.extensionPath = this.context.extensionPath;
        configuration.sourcePaths = this.getSourceRoots();
        configuration.ext = this.getExt();
        configuration.request = 'launch';
        configuration.type = 'emmylua_launch';
        configuration.program = resolvedProgram;
        configuration.workingDir = resolvedWorkingDir;
        configuration.arguments = configuration.arguments ?? [];
        return configuration;
    }

    private resolveProgramPath(configuredProgram?: string): string {
        if (!this.isNullOrEmpty(configuredProgram)) {
            return configuredProgram!.trim();
        }

        const activeDocument = vscode.window.activeTextEditor?.document;
        if (activeDocument?.languageId === 'lua' && activeDocument.uri.scheme === 'file') {
            return activeDocument.uri.fsPath;
        }

        return '';
    }

    private resolveWorkingDirectory(
        folder: vscode.WorkspaceFolder | undefined,
        configuredWorkingDir: string | undefined,
        resolvedProgram: string
    ): string {
        if (!this.isNullOrEmpty(configuredWorkingDir)) {
            return configuredWorkingDir!.trim();
        }

        if (folder) {
            return folder.uri.fsPath;
        }

        if (!this.isNullOrEmpty(resolvedProgram)) {
            return path.dirname(resolvedProgram);
        }

        const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
        return firstWorkspaceFolder?.uri.fsPath ?? '';
    }
}

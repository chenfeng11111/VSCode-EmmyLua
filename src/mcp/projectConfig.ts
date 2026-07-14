import * as fs from 'fs';
import * as path from 'path';

const EMMYLUA_MCP_SERVER_NAME = 'emmylua';

interface McpServerEntry {
    type: 'http';
    url: string;
}

interface McpJsonContent {
    mcpServers?: Record<string, McpServerEntry>;
}

/**
 * Read .mcp.json from workspace root.
 * Returns parsed content, or null if the file doesn't exist.
 */
async function readMcpJson(workspaceRoot: string): Promise<McpJsonContent | null> {
    const filePath = path.join(workspaceRoot, '.mcp.json');
    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(raw) as McpJsonContent;
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            return null;
        }
        throw e;
    }
}

/**
 * Write content to .mcp.json in workspace root.
 */
async function writeMcpJson(workspaceRoot: string, content: McpJsonContent): Promise<void> {
    const filePath = path.join(workspaceRoot, '.mcp.json');
    const json = JSON.stringify(content, null, 2);
    await fs.promises.writeFile(filePath, json, 'utf8');
}

/**
 * Build the MCP URL for the emmylua server.
 */
function buildEmmyluaMcpUrl(host: string, port: number): string {
    return `http://${host}:${port}/mcp`;
}

/**
 * Add or update the emmylua MCP server entry in the project's .mcp.json.
 * Returns 'added' if a new entry was created, 'updated' if an existing one was modified.
 */
export async function addOrUpdateEmmyluaMcpConfig(
    workspaceRoot: string,
    host: string,
    port: number,
): Promise<'added' | 'updated'> {
    let content = await readMcpJson(workspaceRoot);
    if (!content) {
        content = {};
    }

    const url = buildEmmyluaMcpUrl(host, port);
    const existing = content.mcpServers?.[EMMYLUA_MCP_SERVER_NAME];

    if (!content.mcpServers) {
        content.mcpServers = {};
    }

    content.mcpServers[EMMYLUA_MCP_SERVER_NAME] = { type: 'http', url };
    await writeMcpJson(workspaceRoot, content);

    return existing ? 'updated' : 'added';
}

/**
 * Remove the emmylua MCP server entry from the project's .mcp.json.
 * Returns true if an entry was removed, false if none existed.
 */
export async function removeEmmyluaMcpConfig(workspaceRoot: string): Promise<boolean> {
    const content = await readMcpJson(workspaceRoot);
    if (!content?.mcpServers?.[EMMYLUA_MCP_SERVER_NAME]) {
        return false;
    }

    delete content.mcpServers[EMMYLUA_MCP_SERVER_NAME];

    // Clean up empty mcpServers object
    if (Object.keys(content.mcpServers).length === 0) {
        delete content.mcpServers;
    }

    await writeMcpJson(workspaceRoot, content);
    return true;
}

import * as vscode from 'vscode';
import { SYNC_COMMAND, SYNC_COMMAND_PATTERN, SYNC_COMMAND_VERSION } from './syncCommand';

const MCP_SERVER_NAME = 'overleaf';

async function readText(uri: vscode.Uri) {
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return undefined; }
        throw error;
    }
}

/**
 * Registers the tools with assistants that read `.mcp.json`, such as Claude Code. The paths depend on this
 * machine and this version of the extension, so they are refreshed each time the project opens.
 * VS Code's own executable runs the server, so that Node.js does not have to be installed.
 */
async function writeMcpConfig(workspaceRoot: vscode.Uri, extensionPath: string, log: (message: string) => void) {
    const uri = vscode.Uri.joinPath(workspaceRoot, '.mcp.json');
    const text = await readText(uri);
    let config: { mcpServers?: { [name: string]: unknown } } = {};
    if (text !== undefined) {
        try {
            config = JSON.parse(text);
        } catch {
            log('.mcp.json is not valid JSON, so it was left alone and the tools are not registered.');
            return;
        }
    }
    const entry = {
        type: 'stdio',
        command: process.execPath,
        args: [vscode.Uri.joinPath(vscode.Uri.file(extensionPath), 'out', 'ai', 'mcpServer.js').fsPath, workspaceRoot.fsPath],
        // eslint-disable-next-line @typescript-eslint/naming-convention
        env: { ELECTRON_RUN_AS_NODE: '1' },
    };
    if (JSON.stringify(config.mcpServers?.[MCP_SERVER_NAME]) === JSON.stringify(entry)) { return; }
    config.mcpServers = { ...config.mcpServers, [MCP_SERVER_NAME]: entry };
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'));
}

/** Installs `/sync`. A file without the marker, or with a newer one, belongs to the user and is left alone. */
async function writeSyncCommand(workspaceRoot: vscode.Uri) {
    const uri = vscode.Uri.joinPath(workspaceRoot, '.claude', 'commands', 'sync.md');
    const text = await readText(uri);
    if (text !== undefined) {
        const version = SYNC_COMMAND_PATTERN.exec(text)?.[1];
        if (version === undefined || Number(version) >= SYNC_COMMAND_VERSION) { return; }
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(SYNC_COMMAND));
}

/** The project's state folder holds a token and copies of the manuscript, none of which belongs in version control. */
async function keepStateOutOfGit(projectFolder: vscode.Uri) {
    const uri = vscode.Uri.joinPath(projectFolder, '.overleaf', '.gitignore');
    if (await readText(uri) === undefined) {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('*\n'));
    }
}

export async function setUpForAssistants(workspaceRoot: vscode.Uri, projectFolder: vscode.Uri, extensionPath: string, log: (message: string) => void) {
    await keepStateOutOfGit(projectFolder);
    await writeMcpConfig(workspaceRoot, extensionPath, log);
    await writeSyncCommand(workspaceRoot);
}

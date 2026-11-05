import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as net from 'net';
import { BRIDGE_FILE } from './tools';

export type ToolHandlers = { [tool: string]: (args: any) => Promise<unknown> };

const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Lets the MCP server reach this window. It listens only on the local machine, and accepts only requests
 * with the token from the bridge file, which is as private as the project's own files.
 */
export class AiBridge implements vscode.Disposable {
    private server?: net.Server;
    private readonly token = crypto.randomBytes(24).toString('hex');
    private readonly bridgeUri: vscode.Uri;

    constructor(projectFolder: vscode.Uri, private readonly handlers: ToolHandlers) {
        this.bridgeUri = vscode.Uri.joinPath(projectFolder, '.overleaf', BRIDGE_FILE);
    }

    async start() {
        const server = net.createServer((socket) => this.serve(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const { port } = server.address() as net.AddressInfo;
        await vscode.workspace.fs.writeFile(this.bridgeUri, new TextEncoder().encode(JSON.stringify({ port, token: this.token })));
    }

    private serve(socket: net.Socket) {
        let received = '';
        socket.setEncoding('utf8');
        socket.on('error', () => {});
        socket.on('data', (chunk: string) => {
            received += chunk;
            if (received.length > MAX_REQUEST_BYTES) {
                socket.destroy();
                return;
            }
            const end = received.indexOf('\n');
            if (end < 0) { return; }
            const line = received.slice(0, end);
            socket.removeAllListeners('data');
            this.answer(line).then((reply) => socket.end(JSON.stringify(reply) + '\n'));
        });
    }

    private async answer(line: string): Promise<{ result?: unknown, error?: string }> {
        let request: { token?: unknown, tool?: unknown, args?: unknown };
        try {
            request = JSON.parse(line);
        } catch {
            return { error: 'Malformed request.' };
        }
        if (!this.isAuthorized(request.token)) { return { error: 'Not authorized.' }; }

        const handler = typeof request.tool === 'string' && Object.prototype.hasOwnProperty.call(this.handlers, request.tool)
            ? this.handlers[request.tool] : undefined;
        if (!handler) { return { error: `Unknown tool: ${request.tool}` }; }
        try {
            return { result: (await handler(request.args ?? {})) ?? {} };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }

    private isAuthorized(token: unknown) {
        if (typeof token !== 'string') { return false; }
        const given = Buffer.from(token);
        const expected = Buffer.from(this.token);
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    }

    dispose() {
        this.server?.close();
        this.server = undefined;
        vscode.workspace.fs.delete(this.bridgeUri).then(undefined, () => {});
    }
}

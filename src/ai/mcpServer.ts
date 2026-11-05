/**
 * A small MCP server over stdio that an AI assistant starts by itself. It has no state: each tool call
 * is passed to the VS Code window that has the project open, through the address in `bridge.json`.
 * It runs outside VS Code, so it must not import `vscode`. Argument: the workspace folder.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as readline from 'readline';
import { BRIDGE_FILE, TOOLS } from './tools';

const SERVER_INFO = { name: 'overleaf-workshop-ai', version: '1' };
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 180000;
const NOT_RUNNING = 'The project is not connected: open the workspace folder in VS Code with Overleaf Workshop AI enabled, and try again.';

const workspaceRoot = process.argv[2] ?? process.cwd();

function findBridge(): { port: number, token: string } | undefined {
    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
        try {
            return JSON.parse(fs.readFileSync(path.join(workspaceRoot, entry.name, '.overleaf', BRIDGE_FILE), 'utf8'));
        } catch {
            // not a linked project folder
        }
    }
    return undefined;
}

function callBridge(tool: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const bridge = findBridge();
        if (!bridge) {
            reject(new Error(NOT_RUNNING));
            return;
        }
        let received = '';
        const socket = net.connect(bridge.port, '127.0.0.1', () => {
            socket.write(JSON.stringify({ token: bridge.token, tool, args }) + '\n');
        });
        socket.setEncoding('utf8');
        socket.setTimeout(CALL_TIMEOUT_MS, () => socket.destroy(new Error(`${tool} did not finish in time.`)));
        socket.on('data', (chunk: string) => {
            received += chunk;
            const end = received.indexOf('\n');
            if (end < 0) { return; }
            socket.end();
            // A bridge file left by a window that closed can point at a port some other program now uses.
            let reply: { result?: unknown, error?: string };
            try {
                reply = JSON.parse(received.slice(0, end));
            } catch {
                reject(new Error(NOT_RUNNING));
                return;
            }
            if (reply.error !== undefined) {
                reject(new Error(reply.error));
            } else {
                resolve(reply.result);
            }
        });
        socket.on('error', (error: NodeJS.ErrnoException) => {
            reject(error.code === 'ECONNREFUSED' ? new Error(NOT_RUNNING) : error);
        });
    });
}

async function respond(message: { method: string, params?: any }): Promise<object | undefined> {
    switch (message.method) {
        case 'initialize':
            return {
                protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
            };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: TOOLS };
        case 'tools/call': {
            const { name, arguments: args } = message.params ?? {};
            if (!TOOLS.some((tool) => tool.name === name)) {
                throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
            }
            // A failed tool is a result the assistant can read and act on, not a protocol error.
            try {
                const result = await callBridge(name, args ?? {});
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
            } catch (error) {
                return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
            }
        }
        default:
            throw Object.assign(new Error(`Unknown method: ${message.method}`), { code: -32601 });
    }
}

function send(reply: object) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...reply }) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let message: any;
    try {
        message = JSON.parse(line);
    } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        return;
    }
    // A message without an id is a notification, which gets no reply.
    if (message.id === undefined) { return; }
    respond(message).then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
    );
});

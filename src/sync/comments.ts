import * as vscode from 'vscode';
import { CommentThreadSchema, DocRangesSchema } from '../api/base';
import { OUTPUT_FOLDER_NAME } from '../consts';
import { decodeText } from './merge';

export const COMMENTS_FILE_NAME = 'comments.md';

const REFRESH_DELAY_MS = 500;
const RELOCATE_DELAY_MS = 800;
/** Reading comments makes Overleaf save the project, which typing in a commented paragraph should not do at every pause. */
const CHANGED_QUOTE_REFRESH_DELAY_MS = 5000;

export interface CommentMessage {
    author: string;
    text: string;
    time: number;
}

export interface OnlineComment {
    threadId: string;
    path: string;
    /** The commented text. */
    quote: string;
    /** Its offset in the document, in UTF-16 units of text with LF line endings. */
    offset: number;
    resolved: boolean;
    messages: CommentMessage[];
}

export interface CommentSource {
    readonly onDidChangeComments: vscode.Event<void>;
    readComments(): Promise<OnlineComment[]>;
}

/** Overleaf keeps where comments are and what was said apart. A comment with nothing said yet is still being created. */
export function joinComments(docRanges: DocRangesSchema[], threads: {[threadId: string]: CommentThreadSchema}, pathsById: Map<string, string>) {
    const comments: OnlineComment[] = [];
    for (const doc of docRanges) {
        const path = pathsById.get(doc.id);
        if (path === undefined) { continue; }
        for (const { op } of doc.ranges?.comments ?? []) {
            const thread = threads[op.t];
            if (!thread?.messages?.length) { continue; }
            comments.push({
                threadId: op.t,
                path,
                quote: op.c,
                offset: op.p,
                resolved: !!thread.resolved,
                messages: thread.messages.map((message) => ({
                    author: [message.user?.first_name, message.user?.last_name].filter(Boolean).join(' ') || message.user?.email || '(unknown)',
                    text: message.content,
                    time: message.timestamp,
                })),
            });
        }
    }
    return comments.sort((a, b) => a.path.localeCompare(b.path) || a.offset - b.offset);
}

/** Where a comment's text is now, or undefined if it is gone. An offset from Overleaf can be behind the local text. */
export function locateQuote(text: string, quote: string, offset: number): number | undefined {
    if (quote === '') { return Math.min(offset, text.length); }
    if (text.startsWith(quote, offset)) { return offset; }
    const after = text.indexOf(quote, offset);
    const before = text.lastIndexOf(quote, offset);
    if (after < 0) { return before < 0 ? undefined : before; }
    if (before < 0) { return after; }
    return after - offset < offset - before ? after : before;
}

function positionAt(text: string, offset: number) {
    const before = text.slice(0, offset);
    return new vscode.Position(before.split('\n').length - 1, offset - (before.lastIndexOf('\n') + 1));
}

function formatTime(time: number) {
    const date = new Date(time);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface PlacedComment extends OnlineComment {
    /** Undefined until the file is on the disk. */
    range?: vscode.Range;
    /** The commented text is no longer in the local file, so the range is only near where it was. */
    moved: boolean;
}

function describeComment(comment: PlacedComment) {
    const where = !comment.range ? comment.path
        : comment.moved ? `${comment.path}, near line ${comment.range.start.line + 1} (the commented text has changed)`
        : `${comment.path}, line ${comment.range.start.line + 1}`;
    const quote = comment.quote === '' ? '(the commented text was deleted)' : comment.quote;
    const messages = comment.messages.map((message) =>
        `- ${message.author} (${formatTime(message.time)}): ${message.text.replace(/\n/g, '\n  ')}`,
    );
    return [`### ${where}`, '', ...quote.split('\n').map((line) => `> ${line}`), '', ...messages, ''];
}

function renderCommentsFile(projectName: string, comments: PlacedComment[]) {
    const open = comments.filter((comment) => !comment.resolved);
    const resolved = comments.filter((comment) => comment.resolved);
    const lines = [
        `# Overleaf comments: ${projectName}`,
        '',
        'Kept up to date from the online project. Changing this file changes nothing on Overleaf.',
        '',
        `## Open (${open.length})`,
        '',
        ...open.flatMap(describeComment),
        `## Resolved (${resolved.length})`,
        '',
        ...resolved.flatMap(describeComment),
    ];
    return lines.join('\n');
}

/** Shows a project's comments on their lines in the editor, and keeps them in a plain file for any tool to read. */
export class ProjectComments implements vscode.Disposable {
    private readonly controller = vscode.comments.createCommentController('overleaf-workshop-ai.comments', 'Overleaf');
    private readonly shown = new Map<string, {thread: vscode.CommentThread, said: string}>();
    private readonly disposables: vscode.Disposable[] = [this.controller];
    private readonly outputFolder: vscode.Uri;
    private comments: PlacedComment[] = [];
    private written?: string;
    private refreshTimer?: NodeJS.Timeout;
    private relocateTimer?: NodeJS.Timeout;
    private changedQuoteTimer?: NodeJS.Timeout;
    private refreshing = false;
    private refreshAgain = false;
    private disposed = false;

    constructor(
        private readonly folder: vscode.Uri,
        private readonly projectName: string,
        private readonly source: CommentSource,
        private readonly log: (message: string) => void,
    ) {
        this.outputFolder = vscode.Uri.joinPath(folder, OUTPUT_FOLDER_NAME);
    }

    async start() {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
        const onFile = (uri: vscode.Uri) => {
            if (this.hasComments(uri)) { this.scheduleRelocate(); }
        };
        this.disposables.push(
            watcher,
            watcher.onDidCreate(onFile),
            watcher.onDidChange(onFile),
            watcher.onDidDelete(onFile),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.contentChanges.length > 0) { onFile(e.document.uri); }
            }),
            this.source.onDidChangeComments(() => this.scheduleRefresh()),
        );
        await this.refresh();
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.relocateTimer);
        clearTimeout(this.changedQuoteTimer);
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    private pathOf(uri: vscode.Uri) {
        const root = `${this.folder.path}/`;
        return uri.scheme === 'file' && uri.path.toLowerCase().startsWith(root.toLowerCase()) ? uri.path.slice(root.length) : undefined;
    }

    private uriOf(path: string) {
        return vscode.Uri.joinPath(this.folder, ...path.split('/'));
    }

    private hasComments(uri: vscode.Uri) {
        const path = this.pathOf(uri);
        return path !== undefined && this.comments.some((comment) => comment.path === path);
    }

    private scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), REFRESH_DELAY_MS);
    }

    private scheduleRelocate() {
        clearTimeout(this.relocateTimer);
        this.relocateTimer = setTimeout(() => this.relocate(), RELOCATE_DELAY_MS);
    }

    private async refresh() {
        if (this.refreshing) {
            this.refreshAgain = true;
            return;
        }
        this.refreshing = true;
        try {
            const comments = await this.source.readComments();
            if (this.disposed) { return; }
            this.comments = comments.map((comment) => ({...comment, moved: false}));
            await this.place();
            this.log(`Comments: ${comments.filter((comment) => !comment.resolved).length} open, ${comments.filter((comment) => comment.resolved).length} resolved`);
        } catch (error) {
            // Whatever is showing is still the best there is. Syncing does not depend on comments.
            this.log(`Could not read the comments: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.refreshing = false;
            if (this.refreshAgain) {
                this.refreshAgain = false;
                this.scheduleRefresh();
            }
        }
    }

    /** Follows the local text. If a comment's text has changed, only Overleaf knows what the comment now covers. */
    private async relocate() {
        if (this.disposed) { return; }
        try {
            await this.place();
            clearTimeout(this.changedQuoteTimer);
            if (this.comments.some((comment) => comment.moved)) {
                this.changedQuoteTimer = setTimeout(() => this.refresh(), CHANGED_QUOTE_REFRESH_DELAY_MS);
            }
        } catch (error) {
            this.log(`Could not update the comments: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async place() {
        const texts = new Map<string, string | undefined>();
        for (const path of new Set(this.comments.map((comment) => comment.path))) {
            texts.set(path, await this.readText(path));
        }
        if (this.disposed) { return; }
        for (const comment of this.comments) {
            const text = texts.get(comment.path);
            if (text === undefined) {
                comment.range = undefined;
                continue;
            }
            const offset = locateQuote(text, comment.quote, comment.offset);
            comment.moved = offset === undefined;
            if (offset === undefined) {
                const near = positionAt(text, Math.min(comment.offset, text.length));
                comment.range = new vscode.Range(near, near);
            } else {
                comment.offset = offset;
                comment.range = new vscode.Range(positionAt(text, offset), positionAt(text, offset + comment.quote.length));
            }
        }
        this.showThreads();
        await this.writeFile();
    }

    /** What a tool sees on the disk may not be what the user sees: an open file can hold unsaved typing. */
    private async readText(path: string) {
        const uri = this.uriOf(path);
        const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.path.toLowerCase() === uri.path.toLowerCase());
        if (open) { return open.getText().replace(/\r\n/g, '\n'); }
        try {
            return decodeText(await vscode.workspace.fs.readFile(uri));
        } catch {
            return undefined;
        }
    }

    /** As on Overleaf's page, a resolved comment leaves the text. */
    private showThreads() {
        const wanted = new Map(this.comments.filter((comment) => !comment.resolved && comment.range).map((comment) => [comment.threadId, comment]));
        for (const [threadId, { thread }] of this.shown) {
            const comment = wanted.get(threadId);
            if (!comment || thread.uri.path !== this.uriOf(comment.path).path) {
                thread.dispose();
                this.shown.delete(threadId);
            }
        }
        for (const [threadId, comment] of wanted) {
            let entry = this.shown.get(threadId);
            if (!entry) {
                const thread = this.controller.createCommentThread(this.uriOf(comment.path), comment.range!, []);
                thread.canReply = false;
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
                entry = {thread, said: ''};
                this.shown.set(threadId, entry);
            } else if (!entry.thread.range?.isEqual(comment.range!)) {
                entry.thread.range = comment.range!;
            }
            const said = JSON.stringify(comment.messages);
            if (entry.said !== said) {
                entry.said = said;
                entry.thread.comments = comment.messages.map((message) => ({
                    author: {name: message.author},
                    body: message.text,
                    mode: vscode.CommentMode.Preview,
                    timestamp: new Date(message.time),
                }));
            }
        }
    }

    private async writeFile() {
        const content = renderCommentsFile(this.projectName, this.comments);
        if (content === this.written) { return; }
        await vscode.workspace.fs.createDirectory(this.outputFolder);
        // Comments are collaborators' words, which should not reach a repository the folder happens to be in.
        const ignore = vscode.Uri.joinPath(this.outputFolder, '.gitignore');
        try {
            await vscode.workspace.fs.stat(ignore);
        } catch {
            await vscode.workspace.fs.writeFile(ignore, new TextEncoder().encode('*\n'));
        }
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.outputFolder, COMMENTS_FILE_NAME), new TextEncoder().encode(content));
        this.written = content;
    }
}

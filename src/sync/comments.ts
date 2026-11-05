import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { CommentThreadSchema, DocRangesSchema } from '../api/base';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { decodeText } from './merge';

export const COMMENTS_FILE_NAME = 'comments.md';

const THREAD_LABEL = 'Overleaf 批注';
/** Marks a comment that this user can edit and delete, for the menus in package.json. */
const MINE = 'mine';
const RETRY = '重试';

const REFRESH_DELAY_MS = 500;
const RELOCATE_DELAY_MS = 800;
/** Reading comments makes Overleaf save the project, which typing in a commented paragraph should not do at every pause. */
const CHANGED_QUOTE_REFRESH_DELAY_MS = 5000;
/** Overleaf can take a while to list a comment that it has accepted. */
const LISTING_GRACE_MS = 60000;
const LISTING_RECHECK_MS = 3000;

export interface CommentMessage {
    /** Undefined until Overleaf has listed the message. */
    id?: string;
    authorId?: string;
    author: string;
    text: string;
    time: number;
}

export interface OnlineComment {
    threadId: string;
    docId: string;
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
    currentUser(): Promise<{id: string, name: string}>;
    setCommentResolved(comment: OnlineComment, resolved: boolean): Promise<void>;
    /** Starts a comment on text that the server has, and returns the id of its document. */
    addComment(threadId: string, path: string, quote: string, offset: number, text: string): Promise<string>;
    addReply(comment: OnlineComment, text: string): Promise<void>;
    editMessage(comment: OnlineComment, messageId: string, text: string): Promise<void>;
    deleteMessage(comment: OnlineComment, messageId: string): Promise<void>;
    deleteComment(comment: OnlineComment): Promise<void>;
}

function authorName(user: NonNullable<CommentThreadSchema['messages']>[number]['user']) {
    return [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || '(unknown)';
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
                docId: doc.id,
                path,
                quote: op.c,
                offset: op.p,
                resolved: !!thread.resolved,
                messages: thread.messages.map((message) => ({
                    id: message.id,
                    authorId: message.user_id,
                    author: authorName(message.user),
                    text: message.content,
                    time: message.timestamp,
                })),
            });
        }
    }
    return comments.sort(inDocumentOrder);
}

function inDocumentOrder(a: OnlineComment, b: OnlineComment) {
    return a.path.localeCompare(b.path) || a.offset - b.offset;
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
    /** For a comment made here: until when it stays, though Overleaf does not list it yet. */
    keepUntil?: number;
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

function renderCommentsFile(projectName: string, comments: PlacedComment[], outOfDate?: string) {
    const open = comments.filter((comment) => !comment.resolved);
    const resolved = comments.filter((comment) => comment.resolved);
    const lines = [
        `# Overleaf comments: ${projectName}`,
        '',
        outOfDate ?? 'Kept up to date from the online project. Changing this file changes nothing on Overleaf.',
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

/** A comment as VS Code shows it. VS Code hands this same object back to the buttons on it. */
class ThreadComment implements vscode.Comment {
    readonly author: vscode.CommentAuthorInformation;
    readonly timestamp: Date;
    readonly messageId?: string;
    readonly contextValue?: string;
    body: string | vscode.MarkdownString;
    mode = vscode.CommentMode.Preview;

    constructor(readonly threadId: string, message: CommentMessage, mine: boolean) {
        this.author = {name: message.author};
        this.timestamp = new Date(message.time);
        this.messageId = message.id;
        this.body = message.text;
        // A message has no id to refer to it by until Overleaf has listed it, which is moments after sending.
        this.contextValue = mine && message.id ? MINE : undefined;
    }
}

interface ShownThread {
    thread: vscode.CommentThread;
    said: string;
    /** While the user is writing in a comment's box, replacing the comments would lose what they wrote. */
    editing: boolean;
}

/** A change the user made here: shown first and sent afterwards. */
interface CommentChange {
    apply(): void;
    undo(): void;
    send(): Promise<void>;
    failure: string;
}

/** Shows a project's comments on their lines in the editor, and keeps them in a plain file for any tool to read. */
export class ProjectComments implements vscode.Disposable {
    private readonly controller = vscode.comments.createCommentController('overleaf-workshop-ai.comments', 'Overleaf');
    private readonly shown = new Map<string, ShownThread>();
    private readonly disposables: vscode.Disposable[] = [this.controller];
    private readonly outputFolder: vscode.Uri;
    private comments: PlacedComment[] = [];
    private me?: {id: string, name: string};
    private written?: string;
    private outOfDate?: string;
    private refreshTimer?: NodeJS.Timeout;
    private relocateTimer?: NodeJS.Timeout;
    private changedQuoteTimer?: NodeJS.Timeout;
    private refreshing = false;
    private refreshAgain = false;
    private disposed = false;
    private sending: Promise<void> = Promise.resolve();
    private unsentChanges = 0;
    private changesShown = 0;

    constructor(
        private readonly folder: vscode.Uri,
        private readonly projectName: string,
        private readonly source: CommentSource,
        private readonly log: (message: string) => void,
        /** Brings local changes to the server, as a new comment is placed on the server's text. */
        private readonly sendLocalChanges: () => Promise<void>,
    ) {
        this.outputFolder = vscode.Uri.joinPath(folder, OUTPUT_FOLDER_NAME);
        this.controller.options = {prompt: '回复…', placeHolder: '写下内容'};
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                const path = this.pathOf(document.uri);
                if (path === undefined || path.split('/').some((part) => part.startsWith('.'))) { return []; }
                return [new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)];
            },
        };
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
        try {
            this.me = await this.source.currentUser();
        } catch (error) {
            this.log(`Could not tell who the user is: ${error instanceof Error ? error.message : error}`);
        }
        await this.refresh();
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.relocateTimer);
        clearTimeout(this.changedQuoteTimer);
        this.disposables.forEach((disposable) => disposable.dispose());
        vscode.commands.executeCommand('setContext', `${ROOT_NAME}.hasResolvedComments`, false);
    }

    /**
     * Shows a change at once and sends it afterwards, one at a time, so that what the user does never waits for
     * the server. Callers return without waiting for the sending, as VS Code keeps a comment's box full until they
     * do. If Overleaf refuses a change, it is taken back and the user is told, with a way to try again.
     */
    private act(change: CommentChange) {
        change.apply();
        this.changesShown++;
        this.render();
        this.unsentChanges++;
        this.sending = this.sending.then(async () => {
            try {
                await change.send();
            } catch (error) {
                change.undo();
                this.changesShown++;
                this.render();
                this.showError(`${change.failure}：${error instanceof Error ? error.message : String(error)}`, () => this.act(change));
            } finally {
                this.unsentChanges--;
                if (this.unsentChanges === 0 && !this.disposed) { this.scheduleRefresh(); }
            }
        });
    }

    /** Resolves when everything shown has been sent. */
    whenSent() {
        return this.sending;
    }

    private render() {
        if (this.disposed) { return; }
        this.showThreads();
        this.writeFile().catch((error) => this.log(`Could not write the comments file: ${error instanceof Error ? error.message : error}`));
    }

    private commentOf(thread: vscode.CommentThread) {
        const threadId = [...this.shown].find(([, entry]) => entry.thread === thread)?.[0];
        return this.comments.find((comment) => comment.threadId === threadId);
    }

    private newMessage(text: string): CommentMessage {
        return {authorId: this.me?.id, author: this.me?.name ?? '我', text, time: Date.now()};
    }

    /** For the button on a thread in the editor. A resolved comment leaves the text, so it asks first. */
    async resolve(thread: vscode.CommentThread) {
        const comment = this.commentOf(thread);
        if (comment && await this.confirmResolve()) { this.setResolved(comment, true); }
    }

    private async confirmResolve() {
        const answer = await vscode.window.showInformationMessage(
            '解决这条批注？',
            {modal: true, detail: '它会从正文和批注面板中隐藏。记录会保留，可以用批注面板上方的按钮重新打开。'},
            '解决',
        );
        return answer === '解决';
    }

    /** A resolved comment shows nowhere in the editor, so a mistaken click is undone from a list. */
    async reopen() {
        const comment = await this.pickComment(this.comments.filter((candidate) => candidate.resolved));
        if (comment) { this.setResolved(comment, false); }
    }

    private async pickComment(comments: PlacedComment[]) {
        const picked = await vscode.window.showQuickPick(comments.map((comment) => ({
            label: comment.messages[0].text.split('\n')[0],
            description: `${comment.messages[0].author} · ${comment.path}`,
            detail: comment.quote.split('\n')[0],
            comment,
        })), {title: '重新打开已解决的批注'});
        return picked?.comment;
    }

    private setResolved(comment: PlacedComment, resolved: boolean) {
        this.act({
            apply: () => { comment.resolved = resolved; },
            undo: () => { comment.resolved = !resolved; },
            send: () => this.source.setCommentResolved(comment, resolved),
            failure: `无法${resolved ? '解决' : '重新打开'}这条批注`,
        });
    }

    /** For the button under a comment's box: a reply to a comment, or in a new thread the comment itself. */
    async submit({ thread, text }: vscode.CommentReply) {
        const content = text.trim();
        if (!content) { return; }
        const comment = this.commentOf(thread);
        if (comment) {
            this.reply(comment, content);
        } else {
            await this.startComment(thread, content);
        }
    }

    private reply(comment: PlacedComment, text: string) {
        const message = this.newMessage(text);
        this.act({
            apply: () => { comment.messages = [...comment.messages, message]; },
            undo: () => { comment.messages = comment.messages.filter((candidate) => candidate !== message); },
            send: () => this.source.addReply(comment, text),
            failure: `无法发送回复“${text}”`,
        });
    }

    private async startComment(thread: vscode.CommentThread, text: string) {
        const path = this.pathOf(thread.uri);
        if (path === undefined) {
            this.showError('无法添加批注：这个文件不在 Overleaf 项目里');
            return;
        }
        const document = await vscode.workspace.openTextDocument(thread.uri);
        // A click in the margin gives a place on a line, and a selection gives the text.
        const range = thread.range.isEmpty ? document.lineAt(thread.range.start.line).range : thread.range;
        const quote = document.getText(range).replace(/\r\n/g, '\n');
        if (!quote) {
            this.showError('无法添加批注：这一行没有文字可以批注');
            return;
        }
        const offset = document.getText(new vscode.Range(new vscode.Position(0, 0), range.start)).replace(/\r\n/g, '\n').length;
        const threadId = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex');
        const comment: PlacedComment = {threadId, docId: '', path, quote, offset, resolved: false, messages: [this.newMessage(text)], range, moved: false};
        this.act({
            // The box stays where it is and becomes the comment.
            apply: () => {
                comment.keepUntil = Date.now() + LISTING_GRACE_MS;
                thread.label = THREAD_LABEL;
                this.shown.set(threadId, {thread, said: '', editing: false});
                this.comments = [...this.comments, comment].sort(inDocumentOrder);
            },
            undo: () => {
                this.comments = this.comments.filter((candidate) => candidate !== comment);
                this.shown.delete(threadId);
                thread.comments = [];
            },
            send: async () => {
                await this.sendLocalChanges();
                comment.docId = await this.source.addComment(threadId, path, quote, offset, text);
            },
            failure: `无法添加批注“${text}”`,
        });
    }

    /** For the edit button on a comment: VS Code turns it into a box holding its text. */
    startEditing(comment: ThreadComment) {
        const entry = this.shown.get(comment.threadId);
        if (!entry) { return; }
        entry.editing = true;
        comment.mode = vscode.CommentMode.Editing;
        entry.thread.comments = [...entry.thread.comments];
    }

    cancelEditing(comment: ThreadComment) {
        const entry = this.shown.get(comment.threadId);
        if (!entry) { return; }
        entry.editing = false;
        entry.said = '';
        this.render();
    }

    /** VS Code has put what the user wrote into the comment's body by now. */
    saveEditing(comment: ThreadComment) {
        const parent = this.comments.find((candidate) => candidate.threadId === comment.threadId);
        const message = parent?.messages.find((candidate) => candidate.id === comment.messageId);
        const entry = this.shown.get(comment.threadId);
        const text = (typeof comment.body === 'string' ? comment.body : comment.body.value).trim();
        if (!parent || !message || !entry || !text || text === message.text) {
            this.cancelEditing(comment);
            return;
        }
        const original = message.text;
        this.act({
            apply: () => {
                message.text = text;
                entry.editing = false;
            },
            undo: () => { message.text = original; },
            send: () => this.source.editMessage(parent, message.id!, text),
            failure: `无法把批注改为“${text}”`,
        });
    }

    /** The first message is the comment itself, and as on Overleaf's page deleting it deletes the whole comment. */
    async delete(comment: ThreadComment) {
        const parent = this.comments.find((candidate) => candidate.threadId === comment.threadId);
        if (!parent || !comment.messageId) { return; }
        const isFirst = parent.messages[0].id === comment.messageId;
        const others = isFirst ? parent.messages.length - 1 : 0;
        const question = isFirst ? '删除这条批注？' : '删除这条回复？';
        const detail = others > 0 ? `它的 ${others} 条回复也会一起删除，无法恢复。` : '删除后无法恢复。';
        if (!await this.confirmDelete(question, detail)) { return; }

        if (isFirst) {
            this.act({
                apply: () => { this.comments = this.comments.filter((candidate) => candidate !== parent); },
                undo: () => { this.comments = [...this.comments, parent].sort(inDocumentOrder); },
                send: () => this.source.deleteComment(parent),
                failure: '无法删除这条批注',
            });
        } else {
            const messages = parent.messages;
            this.act({
                apply: () => { parent.messages = messages.filter((candidate) => candidate.id !== comment.messageId); },
                undo: () => { parent.messages = messages; },
                send: () => this.source.deleteMessage(parent, comment.messageId!),
                failure: '无法删除这条回复',
            });
        }
    }

    private async confirmDelete(question: string, detail: string) {
        return await vscode.window.showWarningMessage(question, {modal: true, detail}, '删除') === '删除';
    }

    private showError(message: string, retry?: () => void) {
        vscode.window.showErrorMessage(message, ...(retry ? [RETRY] : [])).then((choice) => {
            if (choice === RETRY) { retry?.(); }
        });
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

    private scheduleRefresh(delay = REFRESH_DELAY_MS) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), delay);
    }

    private scheduleRelocate() {
        clearTimeout(this.relocateTimer);
        this.relocateTimer = setTimeout(() => this.relocate(), RELOCATE_DELAY_MS);
    }

    private async refresh() {
        // What Overleaf says now does not include what is still being sent. Sending ends with a refresh.
        if (this.unsentChanges > 0) { return; }
        if (this.refreshing) {
            this.refreshAgain = true;
            return;
        }
        this.refreshing = true;
        const changesBefore = this.changesShown;
        try {
            const comments = await this.source.readComments();
            if (this.disposed) { return; }
            if (this.changesShown !== changesBefore) {
                this.refreshAgain = true; // this answer is from before a change that is showing now
                return;
            }
            const now = Date.now();
            const unlisted = this.comments.filter((comment) => comment.keepUntil !== undefined && comment.keepUntil > now && !comments.some((listed) => listed.threadId === comment.threadId));
            this.comments = [...comments.map((comment) => ({...comment, moved: false})), ...unlisted].sort(inDocumentOrder);
            await this.place();
            this.log(`Comments: ${comments.filter((comment) => !comment.resolved).length} open, ${comments.filter((comment) => comment.resolved).length} resolved`);
            if (unlisted.length > 0) { this.scheduleRefresh(LISTING_RECHECK_MS); }
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
        vscode.commands.executeCommand('setContext', `${ROOT_NAME}.hasResolvedComments`, this.comments.some((comment) => comment.resolved));
        const wanted = new Map(this.comments.filter((comment) => !comment.resolved && comment.range).map((comment) => [comment.threadId, comment]));
        for (const [threadId, { thread }] of this.shown) {
            const comment = wanted.get(threadId);
            if (!comment || thread.uri.path.toLowerCase() !== this.uriOf(comment.path).path.toLowerCase()) {
                thread.dispose();
                this.shown.delete(threadId);
            }
        }
        for (const [threadId, comment] of wanted) {
            let entry = this.shown.get(threadId);
            if (!entry) {
                const thread = this.controller.createCommentThread(this.uriOf(comment.path), comment.range!, []);
                thread.label = THREAD_LABEL;
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
                entry = {thread, said: '', editing: false};
                this.shown.set(threadId, entry);
            } else if (!entry.thread.range?.isEqual(comment.range!)) {
                entry.thread.range = comment.range!;
            }
            const said = JSON.stringify(comment.messages);
            if (entry.said !== said && !entry.editing) {
                entry.said = said;
                entry.thread.comments = comment.messages.map((message) => new ThreadComment(threadId, message, message.authorId === this.me?.id));
            }
        }
    }

    /** Says in the plain file that it is no longer being kept up to date, as a tool reading it could not tell. */
    async markOutOfDate(reason: string | undefined) {
        this.outOfDate = reason;
        await this.writeFile().catch(() => {});
    }

    private async writeFile() {
        if (this.disposed) { return; }
        const content = renderCommentsFile(this.projectName, this.comments, this.outOfDate);
        if (content === this.written) { return; }
        // Writing creates whatever folders are missing, which would bring back a project folder just deleted.
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.outputFolder, '..'));
        } catch {
            return;
        }
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

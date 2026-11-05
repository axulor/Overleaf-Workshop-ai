import * as vscode from 'vscode';
import { OUTPUT_FOLDER_NAME } from '../consts';
import { FileRefEntity, RemoteFileSystemProvider, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { CommentSource, OnlineComment, joinComments } from './comments';
import { RemoteEntry, RemoteSide } from './folderSync';

/** The online side of a folder sync: an Overleaf project, through the extension's virtual file system. */
export class VfsRemoteSide implements RemoteSide, CommentSource, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
    private readonly connectEmitter = new vscode.EventEmitter<void>();
    private readonly disconnectEmitter = new vscode.EventEmitter<void>();
    private readonly commentsEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;
    readonly onDidConnect = this.connectEmitter.event;
    readonly onDidDisconnect = this.disconnectEmitter.event;
    readonly onDidChangeComments = this.commentsEmitter.event;
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly vfs: VirtualFileSystem, provider: RemoteFileSystemProvider) {
        this.disposables = [
            this.changeEmitter, this.connectEmitter, this.disconnectEmitter, this.commentsEmitter,
            provider.onDidChangeFile((events) => this.onRemoteEvents(events)),
            EventBus.on('commentsChangedEvent', ({ projectId }) => {
                if (projectId === this.vfs.projectId) { this.commentsEmitter.fire(); }
            }),
            EventBus.on('projectJoinedEvent', ({ projectId }) => {
                if (projectId === this.vfs.projectId) {
                    this.connectEmitter.fire();
                    this.commentsEmitter.fire(); // anything may have happened while disconnected
                }
            }),
            EventBus.on('projectDisconnectedEvent', ({ projectId }) => {
                if (projectId === this.vfs.projectId) { this.disconnectEmitter.fire(); }
            }),
        ];
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    private onRemoteEvents(events: vscode.FileChangeEvent[]) {
        const prefix = `${this.vfs.origin.path}/`;
        for (const event of events) {
            if (event.uri.query !== this.vfs.origin.query || !event.uri.path.startsWith(prefix)) { continue; }
            const path = event.uri.path.slice(prefix.length);
            if (path === OUTPUT_FOLDER_NAME || path.startsWith(`${OUTPUT_FOLDER_NAME}/`)) { continue; }
            this.changeEmitter.fire(event.type === vscode.FileChangeType.Changed ? path : undefined);
        }
    }

    private uri(path: string) {
        return this.vfs.pathToUri(...path.split('/'));
    }

    async list(): Promise<RemoteEntry[]> {
        await this.vfs.init();
        return this.vfs.walk((entity) => entity._type === 'doc' || entity._type === 'file').map(({ entity, path }) => {
            const kind = entity._type === 'doc' ? 'doc' : 'file';
            return {
                path: path.replace(/^\//, ''),
                kind,
                version: kind === 'doc' ? entity._id : `${entity._id}:${(entity as FileRefEntity).created}`,
            } as RemoteEntry;
        }).filter((entry) => !entry.path.split('/').includes('..'));
    }

    async readDoc(path: string) {
        return new TextDecoder().decode(await this.vfs.openFile(this.uri(path)));
    }

    async readFile(path: string) {
        const content = await this.vfs.openFile(this.uri(path));
        // The virtual file system returns nothing when a download fails. Treating that as the file's
        // content would overwrite the local copy with an empty file.
        if (content.length === 0) { throw new Error(`Could not download ${path}.`); }
        return content;
    }

    async writeDoc(path: string, text: string) {
        await this.vfs.replaceDocContent(this.uri(path), text);
    }

    async writeFile(path: string, content: Uint8Array) {
        await this.ensureFolder(path);
        await this.vfs.createFile(this.uri(path), content, true);
        if (!(await this.list()).some((entry) => entry.path === path)) {
            throw new Error(`Overleaf did not accept ${path}.`);
        }
    }

    async remove(path: string) {
        await this.vfs.remove(this.uri(path), false);
    }

    async readComments() {
        await this.vfs.init();
        const { docRanges, threads } = await this.vfs.getComments();
        const docs = this.vfs.walk((entity) => entity._type === 'doc');
        return joinComments(docRanges, threads, new Map(docs.map(({ entity, path }) => [entity._id, path.replace(/^\//, '')])));
    }

    async setCommentResolved(comment: OnlineComment, resolved: boolean) {
        await this.vfs.setCommentResolved(comment.docId, comment.threadId, resolved);
    }

    private async ensureFolder(path: string) {
        const folders = path.split('/').slice(0, -1);
        for (let depth = 1; depth <= folders.length; depth++) {
            const uri = this.vfs.pathToUri(...folders.slice(0, depth));
            const { fileType } = await this.vfs._resolveUri(uri);
            if (fileType === undefined) { await this.vfs.mkdir(uri); }
        }
    }
}

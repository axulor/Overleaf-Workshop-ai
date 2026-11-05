import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';
import { decide, decodeText, fingerprint, mergeText } from './merge';

export type RemoteKind = 'doc' | 'file';

export interface RemoteEntry {
    /** Relative to the project root, with forward slashes: `main.tex`, `figures/a.png`. */
    path: string;
    kind: RemoteKind;
    /** Changes whenever a non-text file is replaced, so that it need not be downloaded to compare it. */
    version: string;
}

/** The online project, as the engine needs it. Implemented over Overleaf in `vfsRemoteSide`. */
export interface RemoteSide {
    list(): Promise<RemoteEntry[]>;
    readDoc(path: string): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    /** Makes an existing document hold this text. */
    writeDoc(path: string, text: string): Promise<void>;
    /** Creates a file or document, or replaces a non-text file. */
    writeFile(path: string, content: Uint8Array): Promise<void>;
    remove(path: string): Promise<void>;
    /** Fires a path when one file's content changed, or undefined when files may have appeared, gone or moved. */
    readonly onDidChange: vscode.Event<string | undefined>;
    readonly onDidConnect: vscode.Event<void>;
    readonly onDidDisconnect: vscode.Event<void>;
}

export interface FolderSyncOptions {
    /** Asks whether files deleted locally should also be deleted online. */
    confirmRemoteDelete(paths: string[]): Promise<boolean>;
    onConflict?(path: string, reason: ConflictReason): void;
    log?(message: string): void;
    ignorePatterns?: string[];
    /** How long a path must stay quiet before it is synced. */
    debounceMs?: number;
}

export type ConflictReason = 'sameRegion' | 'bothNew' | 'deletedOnOneSide' | 'emptied' | 'notMergeable';

export interface SyncStatus {
    connected: boolean;
    pending: number;
    conflicts: { path: string, reason: ConflictReason }[];
    failed: string[];
}

interface BaseEntry {
    kind: RemoteKind;
    hash: string;
    remoteVersion?: string;
}

interface Manifest {
    version: 1;
    files: { [path: string]: BaseEntry };
}

export const DEFAULT_IGNORE_PATTERNS = [
    '**/.*', '**/.*/**',
    '**/*.aux', '**/__latexindent*', '**/*.bbl', '**/*.bcf', '**/*.blg', '**/*.fdb_latexmk', '**/*.fls',
    '**/*.git', '**/*.lof', '**/*.log', '**/*.lot', '**/*.out', '**/*.run.xml', '**/*.synctex(busy)',
    '**/*.synctex.gz', '**/*.toc', '**/*.xdv', '**/main.pdf', '**/output.pdf',
    // what tools leave behind while saving
    '**/*.tmp', '**/*.tmp.*', '**/*~',
];

const TEXT_EXTENSIONS = new Set([
    'tex', 'latex', 'sty', 'cls', 'bst', 'bib', 'bibtex', 'txt', 'tikz', 'mtx', 'rtex', 'md', 'asy', 'lbx', 'bbx',
    'cbx', 'm', 'lco', 'dtx', 'ins', 'ist', 'def', 'clo', 'ldf', 'rmd', 'lua', 'gv', 'mf', 'yml', 'yaml', 'lhs', 'mk', 'xmpdata', 'cfg', 'rnw', 'ltx', 'inc',
]);

const DEFAULT_DEBOUNCE_MS = 300;
const RETRY_MS = 3000;
const MAX_RETRY_MS = 60000;
const SAVE_ATTEMPTS = 5;
const SAVE_RETRY_MS = 500;
const FLUSH_RETRIES = 3;
const FLUSH_RETRY_MS = 300;
const MANIFEST_READ_ATTEMPTS = 10;
const MANIFEST_READ_RETRY_MS = 100;
const DELETE_PROMPT_DELAY_MS = 500;
const EMPTY_FILE_RECHECK_MS = 500;
const FULL_SCAN_DELAY_MS = 300;
const EMPTY_HASH = fingerprint('');

function isFileNotFound(error: unknown) {
    return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

/**
 * Keeps a local folder and an online project in step, in both directions, as changes happen.
 *
 * It compares content with a stored base rather than following events, so any tool can edit the
 * folder in any way, and nothing depends on seeing every event: a missed one is corrected by the
 * next scan, and syncing the same file twice does nothing. The base is on disk, so this also holds
 * across restarts.
 */
export class FolderSync implements vscode.Disposable {
    private readonly stateDir: vscode.Uri;
    private readonly manifestUri: vscode.Uri;
    private readonly debounceMs: number;
    private readonly ignorePatterns: string[];
    private readonly disposables: vscode.Disposable[] = [];
    private readonly stateEmitter = new vscode.EventEmitter<SyncStatus>();
    readonly onDidChangeStatus = this.stateEmitter.event;
    private readonly receiveEmitter = new vscode.EventEmitter<string>();
    /** Fires a project path when an online change has reached the local file. */
    readonly onDidReceive = this.receiveEmitter.event;

    private manifest: Manifest = { version: 1, files: {} };
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly saveTimers = new Map<string, NodeJS.Timeout>();
    private readonly dirty = new Set<string>();
    private readonly failed = new Set<string>();
    private readonly conflicts = new Map<string, ConflictReason>();
    private readonly problems = new Set<string>();
    private readonly pendingDeletes = new Set<string>();
    private readonly emptyAcknowledged = new Set<string>();
    private readonly lastErrors = new Map<string, string>();
    private manifestChanged = false;
    private retryMs = RETRY_MS;
    private deletePromptTimer?: NodeJS.Timeout;
    private retryTimer?: NodeJS.Timeout;
    private scanTimer?: NodeJS.Timeout;
    private scanning?: Promise<void>;
    private loop?: Promise<void>;
    private connected = true;
    private disposed = false;

    constructor(
        readonly root: vscode.Uri,
        private readonly remote: RemoteSide,
        private readonly options: FolderSyncOptions,
    ) {
        this.stateDir = vscode.Uri.joinPath(root, '.overleaf', 'sync');
        this.manifestUri = vscode.Uri.joinPath(this.stateDir, 'manifest.json');
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
    }

    async start() {
        await vscode.workspace.fs.createDirectory(this.stateDir);
        await this.loadManifest();

        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
        this.disposables.push(
            watcher,
            this.stateEmitter,
            this.receiveEmitter,
            watcher.onDidCreate((uri) => this.onLocalChange(uri)),
            watcher.onDidChange((uri) => this.onLocalChange(uri)),
            watcher.onDidDelete((uri) => this.onLocalDelete(uri)),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.contentChanges.length > 0) { this.onBufferChange(e.document); }
            }),
            vscode.workspace.onDidSaveTextDocument((document) => {
                const path = this.toPath(document.uri);
                if (path !== undefined) { this.schedule(path); }
            }),
            this.remote.onDidChange((path) => {
                if (path === undefined) {
                    this.scheduleFullScan();
                } else if (!this.isIgnored(path)) {
                    this.markDirty(path);
                }
            }),
            this.remote.onDidConnect(() => {
                this.connected = true;
                this.fireStatus();
                this.scheduleFullScan();
            }),
            this.remote.onDidDisconnect(() => {
                this.connected = false;
                this.fireStatus();
            }),
        );
        await this.flush();
    }

    dispose() {
        this.disposed = true;
        for (const timer of [...this.timers.values(), ...this.saveTimers.values()]) { clearTimeout(timer); }
        for (const timer of [this.deletePromptTimer, this.retryTimer, this.scanTimer]) {
            if (timer) { clearTimeout(timer); }
        }
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    /** Stops after finishing what is in progress, so that another engine can safely take over the folder. */
    async stop() {
        this.dispose();
        await this.scanning;
        while (this.loop) { await this.loop; }
        await this.saveManifest();
    }

    get status(): SyncStatus {
        return {
            connected: this.connected,
            pending: this.dirty.size + this.timers.size + this.saveTimers.size,
            conflicts: [...this.conflicts].map(([path, reason]) => ({ path, reason })),
            failed: [...this.failed],
        };
    }

    /** Sends every change made so far. A compile runs on the server's copy, so it needs this first. */
    async flush() {
        for (const [path, timer] of this.saveTimers) {
            clearTimeout(timer);
            this.saveTimers.delete(path);
            await this.saveBuffer(path);
        }
        for (const [path, timer] of this.timers) {
            clearTimeout(timer);
            this.timers.delete(path);
            this.dirty.add(path);
        }
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = undefined;
        }
        // Scan instead of trusting events: a file written a moment ago may not have reported yet.
        await this.fullScan();
        while (this.loop) { await this.loop; }

        // A file just written can be briefly held by another program, which on Windows fails a read.
        for (let attempt = 0; attempt < FLUSH_RETRIES && this.failed.size > 0 && this.connected && !this.disposed; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, FLUSH_RETRY_MS));
            this.failed.forEach((path) => this.dirty.add(path));
            this.kick();
            while (this.loop) { await this.loop; }
        }
    }

    /** Settles a conflict by choosing one side, which then spreads to the other like any other change. */
    async resolveConflict(path: string, keep: 'local' | 'online') {
        const entry = await this.findRemote(path);
        const kind = entry?.kind ?? this.manifest.files[path]?.kind ?? this.guessKind(path);
        this.conflicts.delete(path);
        this.emptyAcknowledged.add(path); // choosing a side includes choosing an empty file
        if (keep === 'local') {
            if (!entry) {
                await this.clearBase(path);
            } else if (kind === 'doc') {
                const text = await this.remote.readDoc(path);
                await this.setBase(path, 'doc', fingerprint(text), text, entry.version);
            } else {
                await this.setBase(path, 'file', fingerprint(await this.remote.readFile(path)), undefined, entry.version);
            }
        } else {
            const bytes = await this.readLocal(path);
            if (bytes === undefined) {
                await this.clearBase(path);
            } else if (kind === 'doc') {
                const text = decodeText(bytes) ?? '';
                await this.setBase(path, 'doc', fingerprint(text), text);
            } else {
                await this.setBase(path, 'file', fingerprint(bytes));
            }
        }
        await this.saveManifest();
        this.markDirty(path);
        await this.flush();
    }

    /** Where the online version of a conflicted file was saved, for comparing it with the local one. */
    conflictCopyUri(path: string) {
        return vscode.Uri.joinPath(this.stateDir, 'conflicts', `${path}.online`);
    }

    // ---- changes coming in ----

    private onLocalChange(uri: vscode.Uri) {
        const path = this.toPath(uri);
        if (path === undefined) { return; }
        this.schedule(path);
        // A folder that appears, for example by a move, reports only the folder and not what is inside it.
        vscode.workspace.fs.stat(uri).then((stat) => {
            if (stat.type & vscode.FileType.Directory) { this.scheduleFullScan(); }
        }, () => {});
    }

    private onLocalDelete(uri: vscode.Uri) {
        const path = this.toPath(uri);
        if (path === undefined) { return; }
        this.schedule(path);
        for (const known of Object.keys(this.manifest.files)) {
            if (known.startsWith(`${path}/`)) { this.schedule(known); }
        }
    }

    /** Typing in the editor reaches the disk, and so Overleaf, after a short pause, with no need to save. */
    private onBufferChange(document: vscode.TextDocument) {
        // The document's dirty flag may not be set yet at this point, so saveBuffer is what checks it.
        const path = this.toPath(document.uri);
        if (path === undefined) { return; }
        const timer = this.saveTimers.get(path);
        if (timer) { clearTimeout(timer); }
        this.saveTimers.set(path, setTimeout(() => {
            this.saveTimers.delete(path);
            this.saveBuffer(path);
        }, this.debounceMs));
        this.fireStatus();
    }

    private async saveBuffer(path: string, attempt: number = 1) {
        const document = this.openDocument(path);
        if (document?.isDirty && !await document.save() && document.isDirty) {
            // VS Code drops a save if typing continues during it. Typing must still reach the disk in the end.
            if (attempt < SAVE_ATTEMPTS) {
                this.saveTimers.set(path, setTimeout(() => {
                    this.saveTimers.delete(path);
                    this.saveBuffer(path, attempt + 1);
                }, SAVE_RETRY_MS));
            } else {
                this.report(`VS Code could not save ${path}.`);
            }
        }
        this.schedule(path);
    }

    private schedule(path: string) {
        if (this.disposed || this.isIgnored(path)) { return; }
        const timer = this.timers.get(path);
        if (timer) { clearTimeout(timer); }
        this.timers.set(path, setTimeout(() => {
            this.timers.delete(path);
            this.markDirty(path);
        }, this.debounceMs));
        this.fireStatus();
    }

    private markDirty(path: string) {
        if (this.disposed) { return; }
        this.dirty.add(path);
        this.kick();
    }

    private scheduleFullScan() {
        if (this.disposed || this.scanTimer) { return; }
        this.scanTimer = setTimeout(() => {
            this.scanTimer = undefined;
            this.fullScan();
        }, FULL_SCAN_DELAY_MS);
    }

    private fullScan() {
        this.scanning = this.scanning ?? (async () => {
            try {
                const paths = new Set<string>(Object.keys(this.manifest.files));
                (await this.remote.list()).forEach((entry) => paths.add(entry.path));
                (await this.listLocal()).forEach((path) => paths.add(path));
                paths.forEach((path) => { if (!this.isIgnored(path)) { this.dirty.add(path); } });
                this.kick();
            } catch (error) {
                this.report(`Could not list the project: ${error}`);
                this.retryLater();
            } finally {
                this.scanning = undefined;
            }
        })();
        return this.scanning;
    }

    private retryLater() {
        if (this.disposed || this.retryTimer) { return; }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.failed.forEach((path) => this.dirty.add(path));
            this.kick();
        }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    }

    // ---- the work queue ----

    private kick() {
        if (this.loop || this.disposed || !this.connected || this.dirty.size === 0) {
            this.fireStatus();
            return;
        }
        this.loop = this.drain().finally(() => {
            this.loop = undefined;
            this.fireStatus();
            this.kick();
        });
    }

    private async drain() {
        while (this.dirty.size > 0 && !this.disposed && this.connected) {
            const path = this.dirty.values().next().value as string;
            this.dirty.delete(path);
            try {
                await this.reconcile(path);
                this.failed.delete(path);
                this.lastErrors.delete(path);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                if (this.lastErrors.get(path) !== reason) {
                    this.lastErrors.set(path, reason);
                    this.report(`Could not sync ${path}: ${reason}`);
                }
                this.failed.add(path);
                this.retryLater();
            }
            this.fireStatus();
        }
        if (this.failed.size === 0) { this.retryMs = RETRY_MS; }
    }

    // ---- syncing one file ----

    private async reconcile(path: string) {
        if (this.pendingDeletes.has(path)) { return; }

        const entry = await this.findRemote(path);
        const base = this.manifest.files[path];
        const bytes = await this.readLocal(path);
        if (!entry && !base && bytes === undefined) {
            this.clearConflict(path);
            return;
        }
        const kind = entry?.kind ?? base?.kind ?? this.guessKind(path);
        if (kind === 'doc') {
            await this.reconcileDoc(path, entry, base, bytes);
        } else {
            await this.reconcileFile(path, entry, base, bytes);
        }
        await this.saveManifest();
    }

    private async reconcileDoc(path: string, entry: RemoteEntry | undefined, base: BaseEntry | undefined, bytes: Uint8Array | undefined) {
        let localText: string | undefined;
        if (bytes !== undefined) {
            localText = decodeText(bytes);
            if (localText === undefined) {
                // Decoding it would corrupt the online copy, so it stays out of sync until someone fixes it.
                if (!this.problems.has(path)) {
                    this.problems.add(path);
                    this.report(`${path} is not valid UTF-8, so it is not synced.`);
                }
                return;
            }
            this.problems.delete(path);
        }
        const remoteText = entry ? await this.remote.readDoc(path) : undefined;
        const baseHash = base?.hash;
        const localHash = localText === undefined ? undefined : fingerprint(localText);
        const remoteHash = remoteText === undefined ? undefined : fingerprint(remoteText);

        const decision = decide(baseHash, localHash, remoteHash);
        if (decision === 'none') {
            this.clearConflict(path);
            if (localText === undefined) {
                await this.clearBase(path);
            } else if (baseHash !== localHash) {
                await this.setBase(path, 'doc', localHash!, localText, entry?.version);
            }
            return;
        }

        // A file that suddenly has nothing in it is more likely a tool caught mid-write or a failed
        // download than a decision, and spreading it would wipe the other side.
        const baseHadContent = baseHash !== undefined && baseHash !== EMPTY_HASH;
        if (decision === 'push' && localText === '' && baseHadContent && !this.emptyAcknowledged.has(path)) {
            await new Promise((resolve) => setTimeout(resolve, EMPTY_FILE_RECHECK_MS));
            const again = await this.readLocal(path);
            if (again === undefined || again.length > 0) {
                this.markDirty(path);
                return;
            }
            await this.markConflict(path, 'emptied', remoteText);
            return;
        }
        if (decision === 'pull' && remoteText === '' && baseHadContent && !this.emptyAcknowledged.has(path)) {
            await this.markConflict(path, 'emptied', remoteText);
            return;
        }

        switch (decision) {
            case 'pull':
                await this.writeLocalText(path, remoteText!);
                await this.settleDoc(path, remoteText!);
                this.report(`Received ${path}`);
                this.receiveEmitter.fire(path);
                break;
            case 'push':
                if (entry) {
                    await this.remote.writeDoc(path, localText!);
                } else {
                    await this.remote.writeFile(path, new TextEncoder().encode(localText!));
                }
                await this.settleDoc(path, localText!);
                this.report(`Sent ${path}`);
                break;
            case 'deleteLocal':
                await this.moveLocalToTrash(path);
                await this.clearBase(path);
                this.clearConflict(path);
                break;
            case 'deleteRemote':
                this.askToDeleteRemote(path);
                break;
            case 'merge': {
                const baseText = await this.readBaseText(path);
                const merged = baseText === undefined ? undefined : mergeText(baseText, localText!, remoteText!);
                if (merged?.ok) {
                    if (merged.text !== localText) { await this.writeLocalText(path, merged.text); }
                    if (merged.text !== remoteText) { await this.remote.writeDoc(path, merged.text); }
                    await this.settleDoc(path, merged.text);
                    this.report(`Merged ${path}`);
                    this.receiveEmitter.fire(path);
                } else {
                    await this.markConflict(path, 'sameRegion', remoteText);
                }
                break;
            }
            case 'conflict':
                await this.markConflict(path, base === undefined ? 'bothNew' : 'deletedOnOneSide', remoteText);
                break;
        }
    }

    private async settleDoc(path: string, text: string) {
        this.emptyAcknowledged.delete(path);
        this.clearConflict(path);
        await this.setBase(path, 'doc', fingerprint(text), text, (await this.findRemote(path))?.version);
    }

    private async reconcileFile(path: string, entry: RemoteEntry | undefined, base: BaseEntry | undefined, bytes: Uint8Array | undefined) {
        const localHash = bytes === undefined ? undefined : fingerprint(bytes);
        let remoteBytes: Uint8Array | undefined;
        let remoteHash: string | undefined;
        if (entry) {
            if (base?.remoteVersion === entry.version) {
                remoteHash = base.hash;
            } else {
                remoteBytes = await this.remote.readFile(path);
                remoteHash = fingerprint(remoteBytes);
            }
        }

        const settle = async (hash: string) => {
            this.clearConflict(path);
            await this.setBase(path, 'file', hash, undefined, (await this.findRemote(path))?.version);
        };

        const decision = decide(base?.hash, localHash, remoteHash);
        switch (decision) {
            case 'none':
                if (localHash === undefined) {
                    await this.clearBase(path);
                    this.clearConflict(path);
                } else if (base?.hash !== localHash || base?.remoteVersion !== entry?.version) {
                    await settle(localHash);
                }
                break;
            case 'pull':
                remoteBytes = remoteBytes ?? await this.remote.readFile(path);
                await this.writeLocalBytes(path, remoteBytes);
                await settle(remoteHash!);
                this.report(`Received ${path}`);
                break;
            case 'push':
                await this.remote.writeFile(path, bytes!);
                await settle(localHash!);
                this.report(`Sent ${path}`);
                break;
            case 'deleteLocal':
                await this.moveLocalToTrash(path);
                await this.clearBase(path);
                this.clearConflict(path);
                break;
            case 'deleteRemote':
                this.askToDeleteRemote(path);
                break;
            default:
                await this.markConflict(path, base === undefined ? 'bothNew' : (bytes && entry ? 'notMergeable' : 'deletedOnOneSide'), remoteBytes ?? (entry ? await this.remote.readFile(path) : undefined));
                break;
        }
    }

    // ---- conflicts and deletions ----

    private async markConflict(path: string, reason: ConflictReason, onlineContent: string | Uint8Array | undefined) {
        const copy = this.conflictCopyUri(path);
        if (onlineContent !== undefined) {
            await this.writeRaw(copy, typeof onlineContent === 'string' ? new TextEncoder().encode(onlineContent) : onlineContent);
        }
        const known = this.conflicts.get(path) === reason;
        this.conflicts.set(path, reason);
        if (!known) {
            this.report(`Conflict in ${path}: ${reason}`);
            this.options.onConflict?.(path, reason);
        }
    }

    private clearConflict(path: string) {
        this.conflicts.delete(path);
    }

    private askToDeleteRemote(path: string) {
        this.pendingDeletes.add(path);
        if (this.deletePromptTimer) { return; }
        // Deleting a folder deletes many files at once, and they should share one question.
        this.deletePromptTimer = setTimeout(async () => {
            this.deletePromptTimer = undefined;
            const paths = [...this.pendingDeletes];
            const confirmed = await this.options.confirmRemoteDelete(paths);
            for (const each of paths) {
                this.pendingDeletes.delete(each);
                try {
                    if (confirmed) { await this.remote.remove(each); }
                    await this.clearBase(each); // if not confirmed, with no base and no local file, the file comes back
                } catch (error) {
                    this.report(`Could not delete ${each} online: ${error}`);
                }
                this.dirty.add(each);
            }
            await this.saveManifest();
            this.kick();
        }, DELETE_PROMPT_DELAY_MS);
    }

    // ---- local files ----

    private async listLocal(folder: string = ''): Promise<string[]> {
        const results: string[] = [];
        const uri = folder ? vscode.Uri.joinPath(this.root, folder) : this.root;
        for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
            const path = folder ? `${folder}/${name}` : name;
            if (this.isIgnored(path) || type & vscode.FileType.SymbolicLink) { continue; }
            if (type & vscode.FileType.Directory) {
                results.push(...await this.listLocal(path));
            } else {
                results.push(path);
            }
        }
        return results;
    }

    /** The file's current content: the editor's if it has unsaved changes, otherwise the disk's. */
    private async readLocal(path: string): Promise<Uint8Array | undefined> {
        const document = this.openDocument(path);
        if (document?.isDirty) { return new TextEncoder().encode(document.getText()); }
        try {
            const uri = this.toUri(path);
            if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) { return undefined; }
            return await vscode.workspace.fs.readFile(uri);
        } catch (error) {
            if (isFileNotFound(error)) { return undefined; }
            throw error;
        }
    }

    private async writeLocalText(path: string, text: string) {
        const document = this.openDocument(path);
        if (document?.isDirty) {
            await this.applyToBuffer(document, text);
            return;
        }
        // A file with Windows line endings keeps them, so that syncing does not touch every line of it.
        const existing = await this.readLocal(path);
        const usesCrlf = existing !== undefined && new TextDecoder().decode(existing).includes('\r\n');
        await this.writeLocalBytes(path, new TextEncoder().encode(usesCrlf ? text.replace(/\n/g, '\r\n') : text));
    }

    /** Applies a change to an editor with unsaved typing, touching only what differs so the cursor stays put. */
    private async applyToBuffer(document: vscode.TextDocument, text: string) {
        const target = document.eol === vscode.EndOfLine.CRLF ? text.replace(/\n/g, '\r\n') : text;
        const dmp = new DiffMatchPatch();
        const diffs = dmp.diff_main(document.getText(), target);
        dmp.diff_cleanupSemantic(diffs);

        const edit = new vscode.WorkspaceEdit();
        let offset = 0;
        for (const [operation, part] of diffs) {
            if (operation === 0) {
                offset += part.length;
            } else if (operation === -1) {
                edit.delete(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + part.length)));
                offset += part.length;
            } else {
                edit.insert(document.uri, document.positionAt(offset), part);
            }
        }
        if (!await vscode.workspace.applyEdit(edit)) {
            throw new Error(`The editor refused an update to ${document.fileName}.`);
        }
        await document.save();
    }

    private async writeLocalBytes(path: string, content: Uint8Array) {
        await this.writeRaw(this.toUri(path), content);
    }

    private async writeRaw(uri: vscode.Uri, content: Uint8Array) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, content);
    }

    /** A file removed by someone online is kept here, in case it was a mistake. */
    private async moveLocalToTrash(path: string) {
        const target = vscode.Uri.joinPath(this.stateDir, 'trash', `${Date.now()}`, path);
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
            await vscode.workspace.fs.rename(this.toUri(path), target, { overwrite: true });
        } catch (error) {
            if (!isFileNotFound(error)) { throw error; }
        }
    }

    private openDocument(path: string) {
        const target = this.toUri(path).fsPath.toLowerCase();
        return vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.fsPath.toLowerCase() === target);
    }

    private toUri(path: string) {
        return vscode.Uri.joinPath(this.root, ...path.split('/'));
    }

    /** The path of a local file, or undefined if it is outside the folder or not synced. */
    private toPath(uri: vscode.Uri): string | undefined {
        const rootPath = this.root.path.endsWith('/') ? this.root.path : `${this.root.path}/`;
        if (uri.scheme !== 'file' || !uri.path.toLowerCase().startsWith(rootPath.toLowerCase())) { return undefined; }
        const path = uri.path.slice(rootPath.length);
        return path === '' || this.isIgnored(path) ? undefined : path;
    }

    private isIgnored(path: string) {
        return this.ignorePatterns.some((pattern) => minimatch(path, pattern, { dot: true }));
    }

    private guessKind(path: string): RemoteKind {
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        return TEXT_EXTENSIONS.has(extension) ? 'doc' : 'file';
    }

    private async findRemote(path: string) {
        return (await this.remote.list()).find((entry) => entry.path === path);
    }

    // ---- the stored base ----

    private baseTextUri(path: string) {
        return vscode.Uri.joinPath(this.stateDir, 'base', ...path.split('/'));
    }

    private async readBaseText(path: string) {
        try {
            return decodeText(await vscode.workspace.fs.readFile(this.baseTextUri(path)));
        } catch (error) {
            // Anything else may be passing, like a file briefly held by another program, and is worth a retry.
            if (isFileNotFound(error)) { return undefined; }
            throw error;
        }
    }

    private async setBase(path: string, kind: RemoteKind, hash: string, text?: string, remoteVersion?: string) {
        if (text !== undefined) {
            await this.writeRaw(this.baseTextUri(path), new TextEncoder().encode(text));
        }
        this.manifest.files[path] = { kind, hash, remoteVersion };
        this.manifestChanged = true;
    }

    private async clearBase(path: string) {
        delete this.manifest.files[path];
        this.manifestChanged = true;
        try {
            await vscode.workspace.fs.delete(this.baseTextUri(path));
        } catch {
            // There is no text stored for non-text files.
        }
    }

    private async loadManifest() {
        for (let attempt = 1; ; attempt++) {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.manifestUri)));
                if (parsed?.version === 1 && typeof parsed.files === 'object') {
                    this.manifest = parsed;
                    return;
                }
                throw new Error('unexpected content');
            } catch (error) {
                // No manifest means nothing has been synced yet. Files that differ are then reported, not overwritten.
                if (isFileNotFound(error)) { return; }
                // Anything else may just be a moment when the file is being replaced, and is not a loss of history.
                if (attempt >= MANIFEST_READ_ATTEMPTS) {
                    this.report(`The sync history could not be read and starts over: ${error}`);
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, MANIFEST_READ_RETRY_MS));
            }
        }
    }

    private async saveManifest() {
        if (!this.manifestChanged) { return; }
        const temporary = vscode.Uri.joinPath(this.stateDir, 'manifest.json.saving');
        await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(this.manifest, null, 1)));
        await vscode.workspace.fs.rename(temporary, this.manifestUri, { overwrite: true });
        this.manifestChanged = false;
    }

    private report(message: string) {
        this.options.log?.(message);
    }

    private fireStatus() {
        if (!this.disposed) { this.stateEmitter.fire(this.status); }
    }
}

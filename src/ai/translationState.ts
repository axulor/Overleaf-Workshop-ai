import * as vscode from 'vscode';
import { decodeText, fingerprint } from '../sync/merge';
import { unifiedDiff } from './lineDiff';

const MANUSCRIPT_PATTERN = /\.(md|markdown)$/i;
const IMAGE_PATTERN = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|pdf|eps)$/i;
const LATEX_PATTERN = /\.tex$/i;

export interface FileChange {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    diff?: string;
}

export interface TranslationChanges {
    initialized: boolean;
    chineseFolder: string;
    projectFolder: string;
    chinese: FileChange[];
    english: FileChange[];
    images: FileChange[];
}

interface Snapshot {
    /** Workspace-relative path to content fingerprint. */
    files: { [path: string]: string };
}

/**
 * Remembers the versions of the Chinese manuscript and the English LaTeX files that were last known to
 * correspond. This is separate from the sync's base, which is about local versus online: it is what keeps
 * a translation from being taken for a new change and translated back.
 */
export class TranslationState {
    private readonly stateDir: vscode.Uri;
    private readonly stateUri: vscode.Uri;
    private readonly chineseFolder: vscode.Uri;
    /** What the assistant was last shown, to recognize later changes it did not make. */
    private shown?: Snapshot;
    private readonly receivedSinceShown = new Set<string>();

    constructor(private readonly workspaceRoot: vscode.Uri, private readonly projectFolder: vscode.Uri) {
        this.stateDir = vscode.Uri.joinPath(projectFolder, '.overleaf', 'translation');
        this.stateUri = vscode.Uri.joinPath(this.stateDir, 'state.json');
        this.chineseFolder = vscode.Uri.joinPath(workspaceRoot, 'zh');
    }

    private relative(uri: vscode.Uri) {
        return uri.path.slice(this.workspaceRoot.path.length + 1);
    }

    private get projectPrefix() {
        return `${this.relative(this.projectFolder)}/`;
    }

    /** Called when an online change arrives in the project folder. */
    noteReceived(projectPath: string) {
        this.receivedSinceShown.add(`${this.projectPrefix}${projectPath}`);
    }

    private async walk(folder: vscode.Uri, keep: RegExp, found: string[] = []) {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(folder);
        } catch {
            return found;
        }
        for (const [name, type] of entries) {
            if (name.startsWith('.')) { continue; }
            const uri = vscode.Uri.joinPath(folder, name);
            if (type & vscode.FileType.Directory) {
                await this.walk(uri, keep, found);
            } else if (keep.test(name)) {
                found.push(this.relative(uri));
            }
        }
        return found;
    }

    private uriOf(path: string) {
        return vscode.Uri.joinPath(this.workspaceRoot, ...path.split('/'));
    }

    private isText(path: string) {
        return MANUSCRIPT_PATTERN.test(path) || LATEX_PATTERN.test(path);
    }

    /** Fingerprints of everything tracked. Text is normalized, so line endings alone are not a change. */
    private async snapshot(): Promise<Snapshot> {
        const chinese = await this.walk(this.chineseFolder, new RegExp(`${MANUSCRIPT_PATTERN.source}|${IMAGE_PATTERN.source}`, 'i'));
        const english = await this.walk(this.projectFolder, LATEX_PATTERN);
        const files: { [path: string]: string } = {};
        for (const path of [...chinese, ...english]) {
            const bytes = await vscode.workspace.fs.readFile(this.uriOf(path));
            files[path] = fingerprint(this.isText(path) ? (decodeText(bytes) ?? bytes) : bytes);
        }
        return { files };
    }

    private async readState(): Promise<Snapshot | undefined> {
        try {
            return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.stateUri)));
        } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return undefined; }
            throw error;
        }
    }

    private baseTextUri(path: string) {
        return vscode.Uri.joinPath(this.stateDir, 'base', ...path.split('/'));
    }

    private async baseText(path: string) {
        try {
            return decodeText(await vscode.workspace.fs.readFile(this.baseTextUri(path))) ?? '';
        } catch {
            return '';
        }
    }

    async changes(): Promise<TranslationChanges> {
        const state = await this.readState();
        const current = await this.snapshot();
        this.shown = current;
        this.receivedSinceShown.clear();

        const result: TranslationChanges = {
            initialized: state !== undefined,
            chineseFolder: this.relative(this.chineseFolder),
            projectFolder: this.relative(this.projectFolder),
            chinese: [], english: [], images: [],
        };
        const paths = new Set([...Object.keys(state?.files ?? {}), ...Object.keys(current.files)]);
        for (const path of [...paths].sort()) {
            const before = state?.files[path];
            const after = current.files[path];
            if (before === after) { continue; }
            const change: FileChange = {
                path,
                status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
            };
            if (this.isText(path) && state) {
                const oldText = await this.baseText(path);
                const newText = after === undefined ? '' : decodeText(await vscode.workspace.fs.readFile(this.uriOf(path))) ?? '';
                change.diff = unifiedDiff(oldText, newText);
            }
            if (MANUSCRIPT_PATTERN.test(path)) {
                result.chinese.push(change);
            } else if (LATEX_PATTERN.test(path)) {
                result.english.push(change);
            } else {
                result.images.push(change);
            }
        }
        return result;
    }

    /**
     * Records the current versions as corresponding, file by file. A file that changed since the assistant
     * looked, for a reason other than its own edit, keeps its old base, so the next round shows that change.
     */
    async markSynced(edited: string[]) {
        const shown = this.shown;
        if (!shown) { throw new Error('Call translation_changes first.'); }

        const claimed = new Set(edited.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')));
        const previous = (await this.readState())?.files ?? {};
        const current = await this.snapshot();
        const next: { [path: string]: string } = {};
        const marked: string[] = [];
        const notMarked: { path: string, reason: string }[] = [];

        for (const path of new Set([...Object.keys(previous), ...Object.keys(current.files)])) {
            const now = current.files[path];
            const unchangedSinceShown = shown.files[path] === now;
            let reason: string | undefined;
            if (!unchangedSinceShown) {
                if (this.receivedSinceShown.has(path)) {
                    reason = 'A collaborator changed it online during this round.';
                } else if (!claimed.has(path)) {
                    reason = 'It changed during this round, and not by your edit.';
                }
            }
            if (reason) {
                notMarked.push({ path, reason });
                if (previous[path] !== undefined) { next[path] = previous[path]; }
                continue;
            }
            if (now === undefined) {
                await vscode.workspace.fs.delete(this.baseTextUri(path)).then(undefined, () => {});
                continue;
            }
            next[path] = now;
            marked.push(path);
            if (this.isText(path)) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseTextUri(path), '..'));
                await vscode.workspace.fs.copy(this.uriOf(path), this.baseTextUri(path), { overwrite: true });
            }
        }

        await vscode.workspace.fs.writeFile(this.stateUri, new TextEncoder().encode(JSON.stringify({ files: next }, null, 1)));
        this.shown = undefined;
        return { marked: marked.sort(), notMarked };
    }
}

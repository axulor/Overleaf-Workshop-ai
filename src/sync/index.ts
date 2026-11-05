import * as vscode from 'vscode';
import { CompileManager } from '../compile/compileManager';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { CompileOutcome, RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { ProjectComments } from './comments';
import { ConflictReason, DEFAULT_IGNORE_PATTERNS, FolderSync, SyncProblem, SyncStatus } from './folderSync';
import { VfsRemoteSide } from './vfsRemoteSide';

const CONFLICT_REASONS: {[reason in ConflictReason]: string} = {
    sameRegion: '本地和线上改到了同一处',
    bothNew: '本地和线上都有这个文件，内容不同',
    deletedOnOneSide: '一边修改了这个文件，另一边删除了它',
    emptied: '文件内容被清空了',
    olderCopy: '这个文件缺少线上刚到的修改，可能是工具根据旧副本写入的',
    notMergeable: '本地和线上都改了这个非文本文件',
};

const KEEP_LOCAL = '保留本地版本';
const KEEP_ONLINE = '保留线上版本';
const COMPARE = '查看差异';

/** Connects the project in a folder of the open workspace, named `overleaf-<project>` when created, to its online copy. */
export class FolderSyncManager {
    private sync?: FolderSync;
    private remote?: VfsRemoteSide;
    private comments?: ProjectComments;
    private readonly log = vscode.window.createOutputChannel('Overleaf Workshop AI Sync', {log: true});
    private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);

    constructor(private readonly provider: RemoteFileSystemProvider) {
        this.statusItem.command = `${ROOT_NAME}.sync.showStatus`;
    }

    get triggers(): vscode.Disposable[] {
        return [
            this.log,
            this.statusItem,
            { dispose: () => this.stop() },
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.linkProject`, (item) => this.linkProject(item)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.showStatus`, () => this.showStatus()),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.resolveComment`, (thread: vscode.CommentThread) => this.comments?.resolve(thread)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.reopenComment`, () => this.comments?.reopen()),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.addComment`, (reply: vscode.CommentReply) => this.comments?.submit(reply)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.replyComment`, (reply: vscode.CommentReply) => this.comments?.submit(reply)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.addCommentOnSelection`, () => vscode.commands.executeCommand('workbench.action.addComment')),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.editComment`, (comment) => this.comments?.startEditing(comment)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.saveEditedComment`, (comment) => this.comments?.saveEditing(comment)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.cancelEditingComment`, (comment) => this.comments?.cancelEditing(comment)),
            vscode.commands.registerCommand(`${ROOT_NAME}.sync.deleteComment`, (comment) => this.comments?.delete(comment)),
        ];
    }

    /** Starts syncing if the open folder already has a linked project. */
    async resume() {
        const root = this.workspaceFolder();
        if (!root) { return; }
        if (await this.isSyncedFolder(root)) {
            this.warnAboutOpeningFromInside(root);
            return;
        }
        const folder = await LocalReplicaSCMProvider.findProjectFolder(root);
        if (!folder) { return; }
        const settings = await this.readJson(this.settingsUri(folder));
        if (settings?.uri) {
            this.warnAboutOtherLinks(root, folder);
            await this.start(folder, vscode.Uri.parse(settings.uri));
        }
    }

    /** Whether this engine has synced this folder itself, rather than a folder inside it. */
    private async isSyncedFolder(folder: vscode.Uri) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, '.overleaf', 'sync', 'manifest.json'));
            return true;
        } catch {
            return false;
        }
    }

    /** Opened from inside, nothing would sync, though the panel and compiling still seem to work. */
    private async warnAboutOpeningFromInside(folder: vscode.Uri) {
        const open = '打开上一级文件夹';
        const answer = await vscode.window.showWarningMessage('这个文件夹本身是同步文件夹，这样打开不会同步。请打开它的上一级文件夹。', open);
        if (answer === open) { await this.openFolder(vscode.Uri.joinPath(folder, '..')); }
    }

    private async warnAboutOtherLinks(root: vscode.Uri, used: vscode.Uri) {
        const others: string[] = [];
        for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
            const each = vscode.Uri.joinPath(root, name);
            if (type & vscode.FileType.Directory && each.path !== used.path && (await this.readJson(this.settingsUri(each)))?.uri) {
                others.push(name);
            }
        }
        if (others.length > 0) {
            vscode.window.showWarningMessage(`这里有多个同步文件夹，只有“${used.path.slice(used.path.lastIndexOf('/') + 1)}”在同步。这些不会同步：${others.join('、')}。`);
        }
    }

    private workspaceFolder() {
        const folders = vscode.workspace.workspaceFolders;
        return folders?.length === 1 && folders[0].uri.scheme === 'file' ? folders[0].uri : undefined;
    }

    private settingsUri(folder: vscode.Uri) {
        return vscode.Uri.joinPath(folder, '.overleaf', 'settings.json');
    }

    private async linkProject(item: {uri: string, label: string}) {
        // A window showing an online project or no folder has nowhere to sync to, so one is chosen and opened.
        const current = this.workspaceFolder();
        if (current && await this.isSyncedFolder(current)) {
            this.warnAboutOpeningFromInside(current);
            return;
        }
        const parent = current ?? await this.pickParentFolder(item.label);
        if (!parent) { return; }

        const uri = vscode.Uri.parse(item.uri);
        const {serverName, projectName, projectId} = parseUri(uri);

        const linked = await LocalReplicaSCMProvider.findProjectFolder(parent);
        const existing = linked && await this.readJson(this.settingsUri(linked));
        if (existing?.uri && parseUri(vscode.Uri.parse(existing.uri)).projectId !== projectId) {
            vscode.window.showErrorMessage(`这个文件夹已经在同步“${existing.projectName}”，一个文件夹只能同步一个项目。`);
            return;
        }

        const folderName = `overleaf-${LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName)}`;
        const folder = linked ?? vscode.Uri.joinPath(parent, folderName);
        if (!await this.confirmLink(item.label, folder)) { return; }

        if (!linked) {
            const settings = {uri: uri.toString(), serverName, projectName, enableCompileNPreview: true};
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, '.overleaf'));
            await vscode.workspace.fs.writeFile(this.settingsUri(folder), new TextEncoder().encode(JSON.stringify(settings, null, 4)));
            LocalReplicaSCMProvider.forgetProjectRoot();
        }
        if (current) {
            await this.start(folder, uri);
        } else {
            await this.openFolder(parent); // the window reloads into the folder, and syncing resumes there
        }
    }

    private async pickParentFolder(projectName: string) {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: `选择“${projectName}”的本地位置`,
            openLabel: '选择这个文件夹',
        });
        return picked?.[0];
    }

    private async confirmLink(projectName: string, folder: vscode.Uri) {
        let hasFiles = false;
        try {
            hasFiles = (await vscode.workspace.fs.readDirectory(folder)).some(([name]) => name !== '.overleaf');
        } catch {
            // The folder does not exist yet.
        }
        const answer = await vscode.window.showInformationMessage(
            `同步“${projectName}”到本地？`,
            {modal: true, detail: `位置：${folder.fsPath}\n之后本地和线上的修改会自动互相同步。${hasFiles ? '\n文件夹里已有的文件不会被覆盖，但线上没有的文件会上传到 Overleaf。' : ''}`},
            '开始同步',
        );
        return answer === '开始同步';
    }

    private async openFolder(folder: vscode.Uri) {
        await vscode.commands.executeCommand('vscode.openFolder', folder, false);
    }

    private async readJson(uri: vscode.Uri) {
        try {
            return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        } catch {
            return undefined;
        }
    }

    /**
     * In a synced project LaTeX Workshop sees real .tex files. It would build them locally on every change,
     * which fails with an error popup where no TeX is installed, and it would take the compile shortcuts.
     * Only this workspace is changed, and a value already set here is left alone.
     */
    private async leaveCompilingToOverleaf() {
        if (!vscode.extensions.getExtension('James-Yu.latex-workshop')) { return; }
        const settings: [section: string, key: string, value: unknown][] = [
            ['latex-workshop.latex.autoBuild', 'run', 'never'],
            ['latex-workshop.bind.altKeymap', 'enabled', true],
        ];
        for (const [section, key, value] of settings) {
            try {
                const config = vscode.workspace.getConfiguration(section);
                if (config.inspect(key)?.workspaceValue === undefined) {
                    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
                }
            } catch (error) {
                this.log.warn(`Could not set ${section}.${key}: ${error instanceof Error ? error.message : error}`);
            }
        }
    }

    private async start(folder: vscode.Uri, projectUri: vscode.Uri) {
        await this.leaveCompilingToOverleaf();
        const previous = this.sync;
        this.stop();
        await previous?.stop();
        try {
            const vfs = await this.provider.prefetch(projectUri);
            await vfs.init();
            vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
            vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, true);

            this.remote = new VfsRemoteSide(vfs, this.provider);
            this.sync = new FolderSync(folder, this.remote, {
                confirmRemoteDelete: (paths) => this.confirmRemoteDelete(paths),
                onConflict: (path, reason) => this.showConflict(path, reason),
                onProblem: (path, problem) => this.showProblem(path, problem),
                log: (message) => this.log.info(message),
                ignorePatterns: (await this.readJson(this.settingsUri(folder)))?.['ignore-patterns'] ?? DEFAULT_IGNORE_PATTERNS,
            });
            this.sync.onDidChangeStatus((status) => this.renderStatus(status));
            this.renderStatus(this.sync.status);
            this.statusItem.show();

            // A compile runs on the server's copy, so everything has to get there first.
            CompileManager.beforeCompile = async () => {
                await this.sync?.flush();
                const failed = this.sync?.status.failed ?? [];
                const refused = this.sync?.status.refused ?? [];
                const passing = failed.filter((path) => !refused.includes(path));
                if (passing.length > 0) {
                    throw new Error(`${passing.join('、')} 还没有同步到 Overleaf，编译结果不会包含最新的修改`);
                }
                // These wait for someone to change them, which is no reason to stop compiling everything else.
                if (refused.length > 0) {
                    vscode.window.showWarningMessage(`${refused.join('、')} 没有同步，这次编译不包含它们的最新修改。`);
                }
            };
            CompileManager.afterCompile = (vfsAfter, outcome) => this.saveOutputs(folder, vfsAfter, outcome);

            await this.sync.start();
            this.log.info(`Syncing ${folder.fsPath} with ${parseUri(projectUri).projectName}`);
            this.comments = new ProjectComments(folder, parseUri(projectUri).projectName, this.remote, (message) => this.log.info(message), async () => {
                await vscode.workspace.saveAll(false);
                await this.sync?.flush();
            });
            await this.comments.start();
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log.error(`Could not start syncing: ${reason}`);
            vscode.window.showErrorMessage(`无法开始同步：${reason}。请确认已在 Overleaf Workshop AI 面板登录。`);
        }
    }

    private stop() {
        this.comments?.dispose();
        this.sync?.dispose();
        this.remote?.dispose();
        this.comments = undefined;
        this.sync = undefined;
        this.remote = undefined;
        CompileManager.beforeCompile = undefined;
        CompileManager.afterCompile = undefined;
    }

    /** Keeps a copy of the PDF and log with the project, where other tools can read them. */
    private async saveOutputs(folder: vscode.Uri, vfs: VirtualFileSystem, outcome: CompileOutcome) {
        const names = [outcome.hasPdf && 'output.pdf', outcome.hasLog && 'output.log'].filter(Boolean) as string[];
        for (const name of names) {
            const content = await vfs.openFile(vfs.pathToUri(OUTPUT_FOLDER_NAME, name));
            if (content.length > 0) {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, OUTPUT_FOLDER_NAME, name), content);
            }
        }
    }

    private async confirmRemoteDelete(paths: string[]) {
        const listed = paths.slice(0, 8).join('\n') + (paths.length > 8 ? `\n……共 ${paths.length} 个文件` : '');
        const answer = await vscode.window.showWarningMessage(
            `本地删除了 ${paths.length} 个文件，要同时从 Overleaf 删除吗？`,
            {modal: true, detail: `${listed}\n\n这些文档上的批注也会一起删除。如果取消，这些文件会从线上恢复到本地。`},
            '从 Overleaf 删除',
        );
        return answer === '从 Overleaf 删除';
    }

    private showProblem(path: string, problem: SyncProblem) {
        vscode.window.showWarningMessage(problem.kind === 'notUtf8'
            ? `${path} 不是 UTF-8 编码。转换编码之前，这个文件不会同步。`
            : `${path} 第 ${problem.line} 行的“${problem.character}”无法保存到 Overleaf。替换这个字符之前，这个文件不会同步。`);
    }

    private async showConflict(path: string, reason: ConflictReason) {
        const scope = reason === 'sameRegion' ? '你的选择只决定冲突的地方，其他修改都会保留。'
            : reason === 'olderCopy' ? '保留本地版本会覆盖线上这些修改。' : '';
        const choice = await vscode.window.showWarningMessage(`${path}：${CONFLICT_REASONS[reason]}。在你选择之前，这个文件不会同步。${scope}`, COMPARE, KEEP_LOCAL, KEEP_ONLINE);
        await this.actOnConflict(path, choice);
    }

    private async actOnConflict(path: string, choice: string | undefined) {
        if (!this.sync || !choice) { return; }
        if (choice === COMPARE) {
            const local = vscode.Uri.joinPath(this.sync.root, ...path.split('/'));
            await vscode.commands.executeCommand('vscode.diff', this.sync.conflictCopyUri(path), local, `${path}（线上 ↔ 本地）`);
            const next = await vscode.window.showWarningMessage(`${path}：要保留哪个版本？`, KEEP_LOCAL, KEEP_ONLINE);
            await this.actOnConflict(path, next);
        } else {
            await this.sync.resolveConflict(path, choice === KEEP_LOCAL ? 'local' : 'online');
        }
    }

    private async showStatus() {
        const conflicts = this.sync?.status.conflicts ?? [];
        if (conflicts.length === 0) {
            this.log.show();
            return;
        }
        const picked = await vscode.window.showQuickPick(
            conflicts.map(({path, reason}) => ({label: path, description: CONFLICT_REASONS[reason]})),
            {placeHolder: '选择要处理的冲突'},
        );
        if (picked) {
            const choice = await vscode.window.showQuickPick([COMPARE, KEEP_LOCAL, KEEP_ONLINE], {placeHolder: picked.label});
            await this.actOnConflict(picked.label, choice);
        }
    }

    private renderStatus(status: SyncStatus) {
        this.statusItem.backgroundColor = undefined;
        if (!status.connected) {
            this.statusItem.text = '$(cloud-offline) Overleaf：离线';
            this.statusItem.tooltip = '修改已保存在本地，重新连接后会自动同步。';
        } else if (status.conflicts.length > 0) {
            this.statusItem.text = `$(warning) Overleaf：${status.conflicts.length} 个冲突`;
            this.statusItem.tooltip = '单击处理冲突。';
            this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (status.failed.length > 0) {
            this.statusItem.text = `$(error) Overleaf：${status.failed.length} 个文件未同步`;
            this.statusItem.tooltip = '正在重试。单击查看记录。';
            this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (status.pending > 0) {
            this.statusItem.text = '$(sync~spin) Overleaf：同步中';
            this.statusItem.tooltip = undefined;
        } else {
            this.statusItem.text = '$(cloud) Overleaf：已同步';
            this.statusItem.tooltip = '单击查看同步记录。';
        }
    }
}

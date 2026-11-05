import * as vscode from 'vscode';
import { CompileManager } from '../compile/compileManager';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { CompileOutcome, ProjectStanding, RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ProjectManagerProvider } from '../core/projectManagerProvider';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { ProjectComments } from './comments';
import { ConflictReason, DEFAULT_IGNORE_PATTERNS, FolderSync, SyncProblem, SyncStatus, isFileNotFound } from './folderSync';
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

/** How often to ask Overleaf about the project, as moving it to the trash on the website sends no message. */
const STANDING_CHECK_MS = 60 * 1000;
/** Coming back to the window is when it most likely changed, having been in the browser. */
const STANDING_CHECK_ON_FOCUS_MS = 10 * 1000;
const TICK_MS = 2000;
const LOOK_FOR_LINK_MS = 6000;

const AWAY_NAMES: {[standing in 'trashed' | 'archived']: string} = {trashed: '回收站', archived: '归档'};

/** Connects the project in a folder of the open workspace, named `overleaf-<project>` when created, to its online copy. */
export class FolderSyncManager {
    private sync?: FolderSync;
    private remote?: VfsRemoteSide;
    private comments?: ProjectComments;
    /** The linked folder this window looks after, whether it is syncing it or has paused. */
    private folder?: vscode.Uri;
    private projectUri?: vscode.Uri;
    private paused?: 'trashed' | 'archived';
    private loggedOut = false;
    private lastStandingCheck = 0;
    private lastLookForLink = 0;
    private checkingStanding = false;
    private checkAgain = false;
    private starting?: Promise<void>;
    private ticking = false;
    private ticker?: NodeJS.Timeout;
    private readonly log = vscode.window.createOutputChannel('Overleaf Workshop AI Sync', {log: true});
    private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);

    constructor(private readonly provider: RemoteFileSystemProvider) {
        this.statusItem.command = `${ROOT_NAME}.sync.showStatus`;
    }

    /** Whether this window has a linked folder to look after, whatever state it is in. */
    get hasLinkedFolder() {
        return this.folder !== undefined;
    }

    get triggers(): vscode.Disposable[] {
        return [
            this.log,
            this.statusItem,
            { dispose: () => { this.stop(); this.stopTicking(); } },
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused && Date.now() - this.lastStandingCheck >= STANDING_CHECK_ON_FOCUS_MS) { this.checkStanding(); }
            }),
            EventBus.on('projectStandingChangedEvent', ({projectId}) => {
                if (this.projectUri && (!projectId || parseUri(this.projectUri).projectId === projectId)) { this.checkStanding(); }
            }),
            EventBus.on('projectDisconnectedEvent', ({projectId}) => {
                // A project deleted, or access to it taken away, shows first as the connection dropping.
                if (this.projectUri && parseUri(this.projectUri).projectId === projectId) { this.checkStanding(); }
            }),
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
        ProjectManagerProvider.beforeLeavingProject = (projectId) => this.sendBeforeLeaving(projectId);
        this.startTicking();
        await this.closeEndedProjects(root);
        if (await this.isSyncedFolder(root)) {
            // Nothing syncs from here, and connecting could bring back a project that is in the trash.
            LocalReplicaSCMProvider.detached = true;
            this.warnAboutOpeningFromInside(root);
            return;
        }
        const folder = await LocalReplicaSCMProvider.findProjectFolder(root);
        if (!folder) { return; }
        const settings = await this.readJson(this.settingsUri(folder));
        if (settings?.uri) {
            this.warnAboutOtherLinks(root, folder);
            await this.follow(folder, vscode.Uri.parse(settings.uri));
        }
    }

    /** A tab left open on a project that has ended would otherwise keep trying to reach it. */
    private async closeEndedProjects(root: vscode.Uri) {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
            const settings = type & vscode.FileType.Directory ? await this.readJson(this.settingsUri(vscode.Uri.joinPath(root, name))) : undefined;
            if (settings?.ended === true && settings.uri) { this.provider.setGate(vscode.Uri.parse(settings.uri), Promise.resolve(false)); }
        }
    }

    /** Takes on a linked folder. Its project is asked about first, as connecting would bring a project in the trash back to life. */
    private async follow(folder: vscode.Uri, projectUri: vscode.Uri) {
        this.folder = folder;
        this.projectUri = projectUri;
        LocalReplicaSCMProvider.detached = true;
        this.lastStandingCheck = Date.now();
        // A PDF tab being restored waits for the answer below.
        let answer: (open: boolean) => void = () => {};
        this.provider.setGate(projectUri, new Promise((resolve) => { answer = resolve; }));
        this.statusItem.text = '$(sync~spin) Overleaf：连接中';
        this.statusItem.tooltip = undefined;
        this.statusItem.show();
        await this.leaveCompilingToOverleaf(); // whatever the project's standing, even before logging in
        const standing = await this.standingOf(projectUri);
        answer(standing !== 'gone' && standing !== 'trashed' && standing !== 'archived');
        if (this.folder !== folder) { return; }
        if (standing === 'gone') {
            await this.endLink();
        } else if (standing === 'trashed' || standing === 'archived') {
            this.pauseQuietly(standing);
        } else if (standing === 'loggedOut') {
            this.loggedOut = true;
            this.showLoggedOut();
        } else if (standing === 'offline') {
            // Trying to connect would only fail, with messages about it. Once Overleaf answers, it starts by itself.
            this.showOffline();
        } else {
            LocalReplicaSCMProvider.detached = false;
            await this.start(folder, projectUri);
        }
    }

    private async standingOf(projectUri: vscode.Uri): Promise<ProjectStanding> {
        try {
            return await this.provider.projectStanding(projectUri);
        } catch {
            return 'unknown';
        }
    }

    /** Follows what happened to the project online. Nothing happens while that cannot be told. */
    private async checkStanding() {
        const {folder, projectUri} = this;
        if (!folder || !projectUri) { return; }
        // A check under way may have asked before what this one is about, so another one follows it.
        if (this.checkingStanding) {
            this.checkAgain = true;
            return;
        }
        this.checkingStanding = true;
        this.lastStandingCheck = Date.now();
        try {
            await this.starting;
            await this.actOnStanding(folder, projectUri, await this.standingOf(projectUri));
        } finally {
            this.checkingStanding = false;
        }
        if (this.checkAgain) {
            this.checkAgain = false;
            await this.checkStanding();
        }
    }

    private async actOnStanding(folder: vscode.Uri, projectUri: vscode.Uri, standing: ProjectStanding) {
        if (this.folder !== folder || standing === 'unknown') { return; }
        const {projectName} = parseUri(projectUri);
        if (standing === 'gone') {
            await this.endLink();
        } else if (standing === 'loggedOut') {
            this.loggedOut = true;
            if (!this.paused) { this.showLoggedOut(); }
        } else if (standing === 'offline') {
            if (!this.sync && !this.paused && !this.loggedOut) { this.showOffline(); }
        } else if (standing === 'active') {
            const wasPaused = this.paused !== undefined;
            const wasLoggedOut = this.loggedOut;
            this.loggedOut = false;
            if (wasPaused) {
                vscode.window.showInformationMessage(`“${projectName}”已恢复，继续同步，这段时间两边的修改会自动合并。`);
            }
            // A connection made with the old login, or one that has stopped trying, will not come back on its own.
            if (wasLoggedOut || this.remote?.hasGivenUp) {
                await this.leaveProject();
                if (this.folder !== folder) { return; }
            }
            if (wasPaused || !this.sync) {
                await this.start(folder, projectUri);
            }
        } else if (this.paused !== standing) {
            await this.leaveProject('Syncing is paused, as the project is in the trash or archive on Overleaf, so this may be out of date.');
            if (this.folder !== folder) { return; }
            this.pauseQuietly(standing);
            vscode.window.showInformationMessage(`“${projectName}”在 Overleaf 的${AWAY_NAMES[standing]}里，同步已暂停。本地文件还在，恢复项目后会自动继续同步。`);
        }
    }

    private showOffline() {
        this.statusItem.backgroundColor = undefined;
        this.statusItem.text = '$(cloud-offline) Overleaf：离线';
        this.statusItem.tooltip = '连不上 Overleaf。修改都在本地，连上后会自动同步。';
        this.statusItem.show();
    }

    private showLoggedOut() {
        this.statusItem.text = '$(account) Overleaf：需要重新登录';
        this.statusItem.tooltip = '登录已过期。修改都在本地，在 Overleaf Workshop AI 面板重新登录后会自动同步。';
        this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusItem.show();
    }

    private pauseQuietly(standing: 'trashed' | 'archived') {
        this.paused = standing;
        LocalReplicaSCMProvider.detached = true;
        if (this.projectUri) { this.provider.setGate(this.projectUri, Promise.resolve(false)); }
        this.statusItem.backgroundColor = undefined;
        this.statusItem.text = '$(debug-pause) Overleaf：已暂停';
        this.statusItem.tooltip = `项目在 Overleaf 的${AWAY_NAMES[standing]}里。本地文件现在是普通文件，恢复项目后会自动继续同步。`;
        this.statusItem.show();
    }

    /** Stops syncing and disconnects from the project, so that this window has nothing more to do with it. */
    private async leaveProject(outOfDate?: string) {
        // First, so that a compile finishing in the meantime cannot connect again.
        if (this.projectUri) { this.provider.setGate(this.projectUri, Promise.resolve(false)); }
        if (outOfDate) { await this.comments?.markOutOfDate(outOfDate); }
        const previous = this.sync;
        this.stop();
        // Finishing up saves the engine's records, which must not bring back a folder that was deleted.
        if (this.folder && await this.exists(this.settingsUri(this.folder))) { await previous?.stop(); }
        if (this.projectUri) { this.provider.forget(this.projectUri); }
        CompileManager.hideStatus?.();
        vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
        vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
    }

    /** The project no longer exists for this user. The folder stays, as an ordinary one. */
    private async endLink() {
        const {folder, projectUri} = this;
        if (!folder || !projectUri) { return; }
        await this.leaveProject('Syncing has ended, as the project is no longer on Overleaf for this account, so this will not change again.');
        const settings = await this.readJson(this.settingsUri(folder));
        if (settings) {
            await vscode.workspace.fs.writeFile(this.settingsUri(folder), new TextEncoder().encode(JSON.stringify({...settings, ended: true}, null, 4)));
        }
        this.letGoOfFolder();
        vscode.window.showWarningMessage(`“${parseUri(projectUri).projectName}”已不在你的 Overleaf 项目里（被彻底删除，或你被移出了项目）。本地文件都还在，现在是一个普通文件夹。`);
    }

    /** The local folder is gone: deleted, or moved away. That is no business of the online project. */
    private async forgetFolder() {
        const projectUri = this.projectUri;
        await this.leaveProject();
        this.letGoOfFolder();
        if (projectUri) {
            this.provider.setGate(projectUri, Promise.resolve(true)); // the project itself is as it was
            vscode.window.showInformationMessage(`“${parseUri(projectUri).projectName}”的本地同步文件夹不在了，同步已断开。线上项目没有变化。`);
        }
    }

    private letGoOfFolder() {
        this.folder = undefined;
        this.projectUri = undefined;
        this.paused = undefined;
        this.loggedOut = false;
        LocalReplicaSCMProvider.detached = false;
        LocalReplicaSCMProvider.forgetProjectRoot();
        this.statusItem.hide();
    }

    private async sendBeforeLeaving(projectId: string) {
        if (!this.sync || !this.projectUri || parseUri(this.projectUri).projectId !== projectId) { return true; }
        await this.sync.flush();
        const status = this.sync?.status;
        if (!status || (status.connected && status.failed.length === 0 && status.pending === 0)) { return true; }
        const answer = await vscode.window.showWarningMessage(
            `${status.failed.length > 0 ? status.failed.join('、') : '有些修改'} 还没有发送到 Overleaf，仍要继续吗？`,
            {modal: true, detail: '继续的话，这些修改只留在本地文件里。'},
            '继续',
        );
        return answer === '继续';
    }

    private startTicking() {
        this.ticker = this.ticker ?? setInterval(() => this.tick(), TICK_MS);
    }

    private stopTicking() {
        clearInterval(this.ticker);
        this.ticker = undefined;
    }

    /** Looks for the local folder going or coming back, which no watcher reports reliably, and asks about the project. */
    private async tick() {
        if (this.ticking || this.starting) { return; }
        this.ticking = true;
        try {
            if (this.folder) {
                if (!await this.exists(this.settingsUri(this.folder))) {
                    await this.forgetFolder();
                } else if (Date.now() - this.lastStandingCheck >= STANDING_CHECK_MS) {
                    await this.checkStanding();
                }
            } else if (Date.now() - this.lastLookForLink >= LOOK_FOR_LINK_MS) {
                this.lastLookForLink = Date.now();
                const root = this.workspaceFolder();
                if (root && !await this.isSyncedFolder(root) && await LocalReplicaSCMProvider.findProjectFolder(root)) { await this.resume(); }
            }
        } catch (error) {
            this.log.warn(`Could not check on the project: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.ticking = false;
        }
    }

    /** Only a definite "not there" counts: a passing failure to look must not read as the folder being deleted. */
    private async exists(uri: vscode.Uri) {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            return !isFileNotFound(error);
        }
    }

    /** Whether this engine has synced this folder itself, rather than a folder inside it. */
    private async isSyncedFolder(folder: vscode.Uri) {
        return await this.exists(vscode.Uri.joinPath(folder, '.overleaf', 'sync', 'manifest.json'))
            && (await this.readJson(this.settingsUri(folder)))?.ended !== true;
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
            const settings = type & vscode.FileType.Directory && each.path !== used.path ? await this.readJson(this.settingsUri(each)) : undefined;
            if (settings?.uri && settings.ended !== true) { others.push(name); }
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
        ProjectManagerProvider.beforeLeavingProject = (projectId) => this.sendBeforeLeaving(projectId);
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
            // A folder left from a project that ended remembers that project's files. They would look deleted from this one.
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, '.overleaf', 'sync', 'manifest.json')).then(undefined, () => {});
            LocalReplicaSCMProvider.forgetProjectRoot();
        }
        if (current) {
            this.startTicking();
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

    /** Only one at a time, as two engines on one folder would each take the other's writes for edits. */
    private start(folder: vscode.Uri, projectUri: vscode.Uri) {
        this.starting = this.starting ?? this.startSyncing(folder, projectUri).finally(() => { this.starting = undefined; });
        return this.starting;
    }

    private async startSyncing(folder: vscode.Uri, projectUri: vscode.Uri) {
        this.folder = folder;
        this.projectUri = projectUri;
        this.paused = undefined;
        LocalReplicaSCMProvider.detached = false;
        this.provider.setGate(projectUri, Promise.resolve(true));
        this.lastStandingCheck = Date.now();
        await this.leaveCompilingToOverleaf();
        const previous = this.sync;
        this.stop();
        await previous?.stop();
        try {
            const vfs = await this.provider.prefetch(projectUri);
            await vfs.init();
            // Connecting can take a while. The folder may have gone meanwhile, and starting would bring parts of it back.
            if (this.folder !== folder || !await this.exists(this.settingsUri(folder))) { return; }
            vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
            vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, true);

            this.remote = new VfsRemoteSide(vfs, this.provider);
            this.sync = new FolderSync(folder, this.remote, {
                confirmRemoteDelete: (paths) => this.confirmRemoteDelete(paths),
                onConflict: (path, reason) => this.showConflict(path, reason),
                onProblem: (path, problem) => this.showProblem(path, problem),
                onOnlineDelete: (paths) => this.showOnlineDelete(paths),
                stillLinked: () => this.exists(this.settingsUri(folder)),
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
            if (!this.sync) {
                // A connection that never got going does not retry, so the next attempt needs a new one.
                this.provider.forget(projectUri);
                this.showOffline();
            }
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
            // Writing creates whatever folders are missing, which would bring back a project folder just deleted.
            if (content.length > 0 && await this.exists(this.settingsUri(folder))) {
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, OUTPUT_FOLDER_NAME, name), content);
            }
        }
    }

    private showOnlineDelete(paths: string[]) {
        const listed = paths.slice(0, 3).join('、') + (paths.length > 3 ? ` 等 ${paths.length} 个文件` : '');
        vscode.window.showInformationMessage(`${listed} 在线上被删除了，本地副本已移到 .overleaf/sync/trash/。`);
    }

    private async confirmRemoteDelete(paths: string[]) {
        const listed = paths.slice(0, 8).join('\n') + (paths.length > 8 ? `\n……共 ${paths.length} 个文件` : '');
        const onlineCount = (await this.remote?.list().catch(() => undefined))?.length;
        // Emptying the project is a different size of decision, so keeping the files is what Enter does.
        if (onlineCount !== undefined && paths.length >= onlineCount) {
            const keep = '恢复到本地';
            const empty = '清空线上项目';
            const choice = await vscode.window.showWarningMessage(
                `本地删除了全部 ${paths.length} 个文件，这会清空线上项目。确定吗？`,
                {modal: true, detail: `${listed}\n\n这些文档上的批注也会一起删除。如果是想断开同步、保留线上项目，请删除整个同步文件夹。`},
                keep, empty,
            );
            return choice === empty;
        }
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
        if (this.loggedOut) {
            this.showLoggedOut();
            return;
        }
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

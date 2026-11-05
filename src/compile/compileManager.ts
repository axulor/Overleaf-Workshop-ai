import * as vscode from 'vscode';
import { CompileOutcome, RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ROOT_NAME, ELEGANT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

// Match the document class in the tex file
const documentClassRegex = new RegExp(/\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/);

const RECOMPILE_FROM_SCRATCH = '从零重新编译';

// Overleaf does not document its statuses. An unknown one is shown as it is.
/* eslint-disable @typescript-eslint/naming-convention */
const COMPILE_STATUS_MESSAGES: {[status:string]: string} = {
    'failure': 'LaTeX 有错误，没有生成 PDF。错误已列在“问题”面板中。',
    'timedout': '编译超时，超过了 Overleaf 的编译时限（免费版为 10 秒）。',
    'too-recently-compiled': '编译太频繁，Overleaf 要求稍等片刻再编译。',
    'autocompile-backoff': 'Overleaf 暂时限制了自动编译，请手动编译或稍后再试。',
    'compile-in-progress': '上一次编译还在进行中。',
    'terminated': '编译被中止了。',
    'stopped': '编译被中止了。',
    'project-too-large': '项目太大，超过了 Overleaf 的编译限制。',
    'validation-problems': '项目文件有问题，Overleaf 拒绝编译。',
    'unavailable': 'Overleaf 的编译服务暂时不可用，请稍后再试。',
    'clsi-maintenance': 'Overleaf 的编译服务正在维护，请稍后再试。',
    'no-root-doc': '没有找到主文档。请点状态栏里的编译器名称，在 Setting: Main Document 中选择。',
    'request-failed': '编译请求失败。',
};
/* eslint-enable @typescript-eslint/naming-convention */

const pdfViewRecord: {
    [key: string]: {
        [key: string]: { doc: PdfDocument, webviewPanel: vscode.WebviewPanel }
    }
} = {};

interface CompileLogSummary {
    available: boolean;
    errors: string[];
    warningCount: number;
}

class CompileDiagnosticProvider {
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    constructor(private readonly vfsm: RemoteFileSystemProvider) {};

    private async getRange(log: ErrorSchema, path: string, vfs: any) {
        let textDoc: vscode.TextDocument;
        try {
            textDoc = (await vscode.workspace.openTextDocument(vfs.pathToUri(path)));
        }
        catch (error) {
            return null;
        }
        if (log.line !== null) {
            const _range = new vscode.Range(
                new vscode.Position(log.line - 1, 0),
                new vscode.Position(log.line, 0),
            );
            const lineContent = textDoc.getText(_range);
            const lineMatch = lineContent.match(/^\s*(.*?)\s*$/)?.[1] || '';
            const lineStart = lineContent.indexOf(lineMatch);
            const lineEnd = lineStart + lineMatch.length;
            return new vscode.Range(
                new vscode.Position(log.line - 1, lineStart),
                new vscode.Position(log.line - 1, lineEnd),
            );
        }
        else {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(1, 0),
            );
        }
    }
    private validatePath(path: string) {
        const outputRegex = new RegExp(/\.\/(output.(aux|bbl|toc|lof|lot|bbl|bst|ttt|fff))\b/);
        const match = outputRegex.exec(path);
        if (match) {
            return path.replace(match[0], `${OUTPUT_FOLDER_NAME}/${match[1]}`);
        }
        return path;
    }

    async updateDiagnostics(uri: vscode.Uri): Promise<CompileLogSummary> {
        this.diagnosticCollection.clear();
        const vfs = await this.vfsm.prefetch(uri);
        const logPath = `${OUTPUT_FOLDER_NAME}/output.log`;
        const _uri = vfs.pathToUri(logPath);
        let content ='';
        try {
            content = new TextDecoder().decode(await vfs.openFile(_uri));
        } catch (error) {
            content = '';
        }
        // A log that could not be downloaded says nothing about the manuscript.
        if (content === '') {
            return {available: false, errors: [], warningCount: 0};
        }
        const logs = new LatexParser(content).parse();
        if (logs === undefined) {
            return {available: true, errors: [], warningCount: 0};
        }
        const errors: string[] = [];
        let warningCount = 0;
        const diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] } = {};
        for (const log of logs.all) {
            if (log.level === 'error') {
                errors.push(`${log.file}:${log.line} ${log.message}`);
            } else if (log.level === 'warning') {
                warningCount++;
            }
            if (!log.file.startsWith('./')) { continue; }
            const path = this.validatePath(log.file);
            const range = await this.getRange(log, path, vfs);
            if (range === null) {
                continue;
            }
            if (!diagnosticsRecorder[path]) {
                diagnosticsRecorder[path] = [];
            }
            const diagnostic = new vscode.Diagnostic(range, log.message, severityMap[log.level]);
            diagnostic.source = vscode.l10n.t('Compile Checker');
            diagnosticsRecorder[path].push(diagnostic);
        }
        for (const file in diagnosticsRecorder) {
            const diagnostics = diagnosticsRecorder[file];
            const _uri = vfs.pathToUri(file);
            this.diagnosticCollection.set(_uri, diagnostics);
        }
        return {available: true, errors, warningCount};
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, async (uri) => {
                return await this.updateDiagnostics(uri);
            }),
        ];
    }
}

export class CompileManager {
    /** Run by a folder sync, to send pending changes first and to keep a local copy of the results. */
    static beforeCompile?: () => Promise<void>;
    static afterCompile?: (vfs: VirtualFileSystem, outcome: CompileOutcome) => Promise<void>;

    readonly status: vscode.StatusBarItem;
    public inCompiling: boolean = false;
    private diagnosticProvider: CompileDiagnosticProvider;
    private compileAsDraft: boolean = false;
    private compileStopOnFirstError: boolean = false;
    private log = vscode.window.createOutputChannel('Overleaf Workshop AI', {log: true});

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        // listen pdf open event
        EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {identifier,pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
            }
        });
    }

    static async check(uri?: vscode.Uri) {
        // check if supported vfs
        uri = uri || vscode.window.activeTextEditor?.document.uri;
        uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme === ROOT_NAME) {
            return uri;
        }
        // check if supported local replica
        const localSetting = await LocalReplicaSCMProvider.readSettings();
        if (localSetting?.uri && localSetting?.enableCompileNPreview===true) {
            return vscode.Uri.parse(localSetting.uri);
        }
        // otherwise return undefined
        return undefined;
    }

    async update(status: 'success'|'hasErrors'|'compiling'|'failed'|'alert') {
        const uri = await CompileManager.check();
        if (uri) {
            this.inCompiling = status === 'compiling';
            this.vfsm.prefetch(uri).then((vfs) => {
                const rootDocName = vfs.getRootDocName().slice(1);
                const compilerName = vfs.getCompiler()?.name || '';
                this.status.tooltip = new vscode.MarkdownString();
                switch (status) {
                    case 'success':
                        this.status.text = `${compilerName}`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Success')}**`);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'hasErrors':
                        // Like Overleaf's own page: LaTeX carried on past the errors, so there is a PDF to look at.
                        this.status.text = `${compilerName} $(warning)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **已生成 PDF，但日志里有 LaTeX 错误，详情见“问题”面板**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                        break;
                    case 'compiling':
                        this.status.text = `${compilerName} $(sync~spin)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compiling')}**`);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'failed':
                        this.status.text = `${compilerName} $(x)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Failed')}**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                        break;
                    case 'alert':
                        this.status.text = `$(alert)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Not Connected')}**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                        break;
                }
                this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage compile settings.')}*`);
                this.status.show();
            });
        } else {
            this.status.hide();
        }
        return uri;
    }

    async compile(force:boolean=false) {
        if (this.inCompiling) { return; }
        await vscode.workspace.saveAll(); // save all dirty files

        const uri = await this.update('compiling');
        if (!uri) { return; }

        try {
            await CompileManager.beforeCompile?.();
            const vfs = await this.vfsm.prefetch(uri);
            const rootDocId = await this.detectRootDoc(vfs, uri);
            const outcome = await vfs.compile(force, this.compileAsDraft, this.compileStopOnFirstError, rootDocId);
            if (outcome===undefined) {
                await this.update('success');
                return;
            }

            const logSummary = outcome.hasLog ? await this.diagnosticProvider.updateDiagnostics(uri) : undefined;
            this.report(outcome, force, logSummary);
            if (outcome.status==='request-failed') {
                await this.update('alert');
                return;
            }
            if (outcome.status!=='success') {
                await this.update('failed');
            } else {
                await this.update(logSummary?.errors.length ? 'hasErrors' : 'success');
            }
            await CompileManager.afterCompile?.(vfs, outcome).catch((error) => {
                this.log.warn(`Could not save the compile output locally: ${error}`);
            });
            if (outcome.hasPdf) {
                const { identifier } = parseUri(uri);
                pdfViewRecord[identifier] && Object.values(pdfViewRecord[identifier]).forEach(
                    (record) => record.doc.refresh()
                );
                // A manual compile is a request to see the result, as on Overleaf's own page.
                if (force && !this.isPdfOpen(uri)) {
                    await this.openPdf(true);
                }
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log.error(`Compile stopped by an error: ${reason}`);
            if (force) {
                this.showCompileProblem(`编译时出错：${reason}`);
            }
            await this.update('failed');
        } finally {
            // Whatever happened, a later compile must not be ignored as "already compiling".
            this.inCompiling = false;
        }
    }

    /** The active document is the main document if it has \documentclass; anything else uses the project's setting. */
    private async detectRootDoc(vfs: VirtualFileSystem, uri: vscode.Uri) {
        const { fileType, fileId } = await vfs._resolveUri(uri);
        if (fileType!=='doc') { return undefined; }
        const content = new TextDecoder().decode( await vfs.openFile(uri) );
        return documentClassRegex.test(content) ? fileId : undefined;
    }

    private isPdfOpen(uri: vscode.Uri) {
        const { identifier } = parseUri(uri);
        return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
            const input = tab.input;
            return input instanceof vscode.TabInputCustom
                && input.viewType===`${ROOT_NAME}.pdfViewer`
                && parseUri(input.uri).identifier===identifier;
        }));
    }

    private report(outcome: CompileOutcome, manual: boolean, logSummary?: CompileLogSummary) {
        let summary = `${manual ? 'Manual' : 'Auto'} compile of ${outcome.rootResourcePath ?? '(no main document)'}: `
            + `${outcome.status}, ${outcome.elapsedMs} ms, log ${outcome.hasLog}, pdf ${outcome.hasPdf}`
            + (outcome.message ? `, ${outcome.message}` : '');
        if (logSummary && !logSummary.available) {
            summary += ', the log could not be downloaded';
        } else if (logSummary) {
            summary += `, LaTeX errors ${logSummary.errors.length}, warnings ${logSummary.warningCount}`;
            if (logSummary.errors.length > 0) {
                summary += `, first error: ${logSummary.errors[0]}`;
            }
        }
        if (outcome.status==='success') {
            this.log.info(summary);
            return;
        }
        this.log.warn(summary);
        if (manual) {
            const explanation = COMPILE_STATUS_MESSAGES[outcome.status] ?? `编译没有成功，Overleaf 返回的状态是 ${outcome.status}。`;
            this.showCompileProblem(outcome.message ? `${explanation}（${outcome.message}）` : explanation);
        }
    }

    private showCompileProblem(message: string) {
        const viewRecord = '查看记录';
        vscode.window.showErrorMessage(message, viewRecord).then((choice) => {
            if (choice===viewRecord) { this.log.show(); }
        });
    }

    async stopCompile() {
        const uri = await CompileManager.check();
        if (uri && this.inCompiling) {
            const vfs = await this.vfsm.prefetch(uri);
            await vfs.stopCompile();
            await this.update('failed');
        }
    }

    async openPdf(preserveFocus:boolean=false) {
        const uri = await CompileManager.check();
        if (uri) {
            const rootPath = uri.path.split('/', 2)[1];
            const pdfUri = uri.with({
                path: `/${rootPath}/${OUTPUT_FOLDER_NAME}/output.pdf`,
            });
            vscode.commands.executeCommand('vscode.openWith', pdfUri,
                `${ROOT_NAME}.pdfViewer`,
                { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus }
            );
        }
    }

    async syncCode() {
        const uri = await CompileManager.check();
        if (uri && vscode.window.activeTextEditor) {
            const { identifier, pathParts } = parseUri(uri);
            const startPoint = vscode.window.activeTextEditor.selection.start;
            const filePath = pathParts.join('/');
            const line = startPoint.line;
            const column = startPoint.character;
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncCode(filePath, line, column))
                .then((res) => {
                    if (res) {
                        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
                        const webview = pdfViewRecord[identifier][pdfPath].webviewPanel.webview;
                        // get page
                        webview.postMessage({
                            type: 'syncCode',
                            content: res
                        });
                    }
                });
        }
    }

    private _revealSelectionInEditor(editor: vscode.TextEditor, targetLine: number, identifier: string) {
        const _identifier = identifier.replace(/\s+/g, '\\s+');
        // targetLine is 1-based from the syncTeX result
        const lineIndex = targetLine - 1;

        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
            console.warn(`${ELEGANT_NAME}: Invalid line number ${targetLine} for revealing in editor. Document has ${editor.document.lineCount} lines.`);
            // Optionally, just focus the editor if the line is invalid
            vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            return;
        }

        const lineText = editor.document.lineAt(lineIndex).text;
        const match = lineText.match(_identifier);
        const matchIndex = match?.index ?? 0;

        let newSelections: vscode.Selection[];
        const newSelection = new vscode.Selection(lineIndex, matchIndex, lineIndex, matchIndex);
        if (editor.selections.length > 0) {
            newSelections = editor.selections.map((sel, index) =>
                index === 0 ? newSelection : sel
            );
        } else {
            newSelections = [newSelection];
        }
        editor.selections = newSelections;

        editor.revealRange(new vscode.Range(lineIndex, matchIndex, lineIndex, matchIndex), vscode.TextEditorRevealType.InCenter);
    }

    async syncPdf(r: { page: number, h: number, v: number, identifier: string }) {
        const uri = await CompileManager.check();
        if (uri) {
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncPdf(r.page, r.h, r.v))
                .then((res) => {
                    if (res) {
                        const { projectName } = parseUri(uri);
                        const { file, line, column } = res;
                        const _file = file.match(/output\.[^\.]+$/) ? `${OUTPUT_FOLDER_NAME}/${file}` : file;
                        const fileUri = uri.with({ path: `/${projectName}/${_file}` });

                        let viewColumnToUse: vscode.ViewColumn | undefined;
                        const existingEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === fileUri.toString()
                        );

                        if (existingEditor) {
                            viewColumnToUse = existingEditor.viewColumn;
                        } else {
                            viewColumnToUse = vscode.window.visibleTextEditors.at(-1)?.viewColumn || vscode.ViewColumn.Beside;
                        }

                        vscode.window.showTextDocument(fileUri, { viewColumn: viewColumnToUse, preserveFocus: false })
                            .then(
                                (openedEditor) => {
                                    if (openedEditor) {
                                        this._revealSelectionInEditor(openedEditor, line, r.identifier);
                                    }
                                },
                                (error) => {
                                    console.error(`${ELEGANT_NAME}: Failed to open document ${fileUri.fsPath} for syncPdf:`, error);
                                }
                            );
                    }
                })
                .catch(error => {
                    console.error(`${ELEGANT_NAME}: Error in syncPdf promise chain:`, error);
                });
        }
    }

    async setCompiler() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const compilers = vfs?.getAllCompilers();
        compilers && vscode.window.showQuickPick(compilers.map((item) => {
            return {
                label: item.name,
                description: item.code,
                picked: item.code === currentCompiler?.code,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Compiler'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ compiler: option.description }) && this.compile(true);
        });
    }

    async setRootDoc() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentRootDoc = vfs?.getRootDocName();
        const rootDocs = vfs?.getValidMainDocs();
        rootDocs && vscode.window.showQuickPick(rootDocs.map((item) => {
            return {
                id: item.entity._id,
                label: item.path,
                picked: item.path === currentRootDoc,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Main Document'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ rootDocId: option.id }) && this.compile(true);
        });
    }

    async compileSettings() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const currentRootDoc = vfs?.getRootDocName();

        const currentDraftMode = this.compileAsDraft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = this.compileStopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: RECOMPILE_FROM_SCRATCH, description: '清空 Overleaf 上的编译缓存后再编译，耗时更长'},
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        if (this.inCompiling) {
            settingItems.unshift({label: vscode.l10n.t('Stop compilation'), description: undefined});
        }

        const setting = await vscode.window.showQuickPick(settingItems);
        switch (setting?.label) {
            case RECOMPILE_FROM_SCRATCH:
                if (vfs) {
                    await vfs.clearCompileCache();
                    this.compile(true);
                }
                break;
            case vscode.l10n.t('Setting: Compiler'):
                this.setCompiler();
                break;
            case vscode.l10n.t('Setting: Main Document'):
                this.setRootDoc();
                break;
            case vscode.l10n.t('Stop compilation'):
                this.stopCompile();
                break;
            case vscode.l10n.t('Compile Mode'):
                this.compileAsDraft = !this.compileAsDraft;
                this.compileSettings();
                break;
            case vscode.l10n.t('Compile Error Handling'):
                this.compileStopOnFirstError = !this.compileStopOnFirstError;
                this.compileSettings();
                break;
            default:
                break;
        }
    }

    get triggers() {
        return [
            // register status bar
            this.status,
            this.log,
            // register compile commands
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, () => this.compile(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileQuietly`, () => this.compile(false)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.viewPdf`, () =>  this.openPdf()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncCode`, () => this.syncCode()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncPdf`, (r) => this.syncPdf(r)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compilerManager.settings`, ()=> this.compileSettings()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setCompiler`, () => this.setCompiler()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setRootDoc`, () => this.setRootDoc()),
            // register compile conditions
            vscode.workspace.onDidSaveTextDocument(async (e) => {
                // A folder sync saves every few moments while typing, which must not compile each time.
                if (e.uri.scheme!==ROOT_NAME) { return; }
                const uri = await CompileManager.check.bind(this)(e.uri);
                const vfs = uri && await this.vfsm.prefetch(uri);
                const compileCondition = vscode.workspace.getConfiguration(`${ROOT_NAME}.compileOnSave`).get('enabled', true);
                const postfixCondition = e.fileName.match(/\.tex$|\.sty$|\.cls$|\.bib$/i);
                if (compileCondition && postfixCondition && vfs?.isInvisibleMode===false) {
                    this.compile();
                }
            }),
            EventBus.on('compilerUpdateEvent', () => {
                this.compile(true);
            }),
            EventBus.on('rootDocUpdateEvent', () => {
                this.compile(true);
            }),
            // register diagnostics triggers
            ...this.diagnosticProvider.triggers,
        ];
    }
}

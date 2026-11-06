// Runs inside an isolated VS Code. Exercises compiling with fake Overleaf responses, so it needs no account.
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');

const here = process.env.OVERLEAF_AI_TEST_DIR;
// OVERLEAF_AI_TEST_OUT points at another build, for instance to confirm that the tests catch the old behavior.
const out = process.env.OVERLEAF_AI_TEST_OUT || path.join(__dirname, '..', 'out');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG_WITH_ERROR = [
  'This is pdfTeX',
  '(./main.tex',
  '! Undefined control sequence.',
  'l.3 \\badcommand',
  '',
  'Here is how much of TeX\'s memory you used:',
].join('\n');

const outputFile = (name) => ({ path: name, url: `/project/p1/user/u1/build/b1-c1/output/${name}`, type: name.split('.').pop(), build: 'b1-c1' });
const compileOk = (files) => ({ type: 'success', compile: { status: 'success', compileGroup: 'standard', clsiServerId: 'srv', pdfDownloadDomain: 'https://cdn.example', outputFiles: files } });
const compileStatus = (status, files = []) => ({ type: 'success', compile: { status, compileGroup: 'standard', outputFiles: files } });
const ORIGIN = vscode.Uri.parse('overleaf-workshop://www.overleaf.com/Test?user=u1&project=p1');

function fakeVfs(VirtualFileSystem, response, overrides = {}) {
  const calls = { compile: [], deleted: 0 };
  const vfs = Object.create(VirtualFileSystem.prototype);
  Object.assign(vfs, {
    context: {},
    serverName: 'www.overleaf.com',
    projectId: 'p1',
    projectName: 'Test',
    origin: ORIGIN,
    isDirty: true,
    notify: () => {},
    root: {
      rootDoc_id: 'doc1',
      rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'doc1', name: 'main.tex' }], fileRefs: [], folders: [] }],
    },
    api: {
      compile: async (...args) => { calls.compile.push(args); return response; },
      deleteAuxFiles: async () => { calls.deleted++; return { type: 'success' }; },
    },
  }, overrides);
  vfs.init = async () => vfs.root;
  return { vfs, calls };
}

async function testApi(BaseAPI) {
  const urls = [];
  const server = http.createServer((req, res) => {
    urls.push(req.url);
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'success', outputFiles: [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = new BaseAPI(`http://127.0.0.1:${server.address().port}/`);
  const identity = { cookies: 'x=y', csrfToken: 't' };
  const manual = await api.compile(identity, 'p1', 'main.tex', false, false, false);
  await api.compile(identity, 'p1', 'main.tex', false, false, true);
  server.close();
  check('api: a compile reaches the server and parses', manual.type === 'success' && manual.compile.status === 'success', JSON.stringify(manual));
  check('api: a manual compile is not marked as auto', urls[0] === '/project/p1/compile', urls[0]);
  check('api: an auto compile is marked as auto', urls[1] === '/project/p1/compile?auto_compile=true', urls[1]);
}

async function testVfs(VirtualFileSystem) {
  // the cause suspected for permanent failures: every failed compile cleared the cache and started over
  let { vfs, calls } = fakeVfs(VirtualFileSystem, compileStatus('timedout', [outputFile('output.log')]));
  let outcome = await vfs.compile(true);
  check('a timeout reports its real status', outcome.status === 'timedout', JSON.stringify(outcome));
  check('a compile never clears the cache by itself', calls.deleted === 0);
  outcome = await vfs.compile(true);
  check('a second compile after a timeout does not clear it either', calls.deleted === 0);
  check('a timeout keeps the log', outcome.hasLog === true);
  check('the kept log is listed in the output folder', vfs.root.rootFolder[0].folders.some((f) => f.outputs && f.outputs.some((o) => o.name === 'output.log')));

  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileStatus('failure', [outputFile('output.log')])));
  outcome = await vfs.compile(true);
  check('a LaTeX failure reports its status and log', outcome.status === 'failure' && outcome.hasLog && !outcome.hasPdf, JSON.stringify(outcome));

  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileStatus('too-recently-compiled')));
  outcome = await vfs.compile(true);
  check('a status without output files does not crash', outcome.status === 'too-recently-compiled' && !outcome.hasLog);

  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileOk([outputFile('output.log'), outputFile('output.pdf')])));
  outcome = await vfs.compile(true);
  check('success reports the PDF', outcome.status === 'success' && outcome.hasPdf && outcome.hasLog);
  check('success stores the download details', vfs.clsiServerId === 'srv' && vfs.pdfDownloadDomain === 'https://cdn.example');
  check('the main document path is sent', calls.compile[0][2] === 'main.tex', String(calls.compile[0][2]));
  check('a forced compile is sent as manual', calls.compile[0][5] === false);

  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileOk([outputFile('output.pdf')])));
  await vfs.compile(false);
  check('a compile on save is sent as auto', calls.compile[0][5] === true);
  outcome = await vfs.compile(false);
  check('with no new changes a compile on save does nothing', outcome === undefined && calls.compile.length === 1);

  ({ vfs, calls } = fakeVfs(VirtualFileSystem, { type: 'error', message: '500: boom' }));
  outcome = await vfs.compile(true);
  check('a failed request reports its reason', outcome.status === 'request-failed' && outcome.message === '500: boom', JSON.stringify(outcome));

  // no main document set on the project
  const noRoot = (docs) => ({ root: { rootFolder: [{ _id: 'root', name: 'rootFolder', docs, fileRefs: [], folders: [] }] } });
  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileOk([]), noRoot([{ _id: 'a', name: 'paper.tex' }, { _id: 'b', name: 'main.tex' }])));
  await vfs.compile(true);
  check('without a main document, main.tex is used', calls.compile[0][2] === 'main.tex', String(calls.compile[0][2]));
  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileOk([]), noRoot([{ _id: 'a', name: 'paper.tex' }])));
  await vfs.compile(true);
  check('without a main document, a single tex file is used', calls.compile[0][2] === 'paper.tex', String(calls.compile[0][2]));
  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileOk([]), noRoot([{ _id: 'a', name: 'one.tex' }, { _id: 'b', name: 'two.tex' }])));
  outcome = await vfs.compile(true);
  check('an ambiguous main document asks instead of sending a bad request', outcome.status === 'no-root-doc' && calls.compile.length === 0, JSON.stringify(outcome));

  ({ vfs, calls } = fakeVfs(VirtualFileSystem, compileOk([])));
  await vfs.clearCompileCache();
  check('recompiling from scratch clears the cache', calls.deleted === 1);
}

async function testManager(CompileManager) {
  CompileManager.check = async () => ORIGIN;

  const makeVfs = (compile, resolved = { fileType: 'folder' }, logText = '') => {
    const calls = { compile: [], openFile: 0 };
    return {
      calls,
      getRootDocName: () => '/main.tex',
      getCompiler: () => ({ name: 'pdfLaTeX' }),
      isInvisibleMode: false,
      _resolveUri: async () => resolved,
      openFile: async (uri) => {
        if (uri.path.endsWith('output.log')) return new TextEncoder().encode(logText);
        calls.openFile++;
        return new TextEncoder().encode(resolved.text || '');
      },
      pathToUri: (...parts) => ORIGIN.with({ path: `/Test/${parts.join('/')}` }),
      compile: async (...args) => { calls.compile.push(args); return compile(calls.compile.length); },
    };
  };
  const outcome = (status, extra = {}) => ({ status, rootResourcePath: 'main.tex', elapsedMs: 5, hasLog: false, hasPdf: false, ...extra });
  const managerFor = (vfs) => new CompileManager({ prefetch: async () => vfs });

  // the "stuck forever" suspect
  let vfs = makeVfs((n) => { if (n === 1) throw new Error('socket closed'); return outcome('success'); });
  let manager = managerFor(vfs);
  await manager.compile(true);
  check('an error during a compile does not leave it stuck', manager.inCompiling === false);
  await manager.compile(true);
  check('the next compile runs after an error', vfs.calls.compile.length === 2, `${vfs.calls.compile.length} calls`);

  // a project root, which is what a local folder compiles from
  vfs = makeVfs(() => outcome('success'));
  manager = managerFor(vfs);
  await manager.compile(true);
  check('compiling from the project root does not try to download a folder', vfs.calls.openFile === 0);
  check('compiling from the project root uses the project setting', vfs.calls.compile[0][3] === undefined);

  // the active document decides the main document only if it has \documentclass
  vfs = makeVfs(() => outcome('success'), { fileType: 'doc', fileId: 'doc9', text: '\\documentclass{article}\n' });
  await managerFor(vfs).compile(true);
  check('an active file with \\documentclass is the main document', vfs.calls.compile[0][3] === 'doc9', String(vfs.calls.compile[0][3]));
  vfs = makeVfs(() => outcome('success'), { fileType: 'doc', fileId: 'doc9', text: '\\section{Intro}\n' });
  await managerFor(vfs).compile(true);
  check('an active section file is not the main document', vfs.calls.compile[0][3] === undefined);

  // status bar, diagnostics, the compile record and the PDF
  const watched = (manager) => {
    const record = [];
    const opened = [];
    const log = (line) => record.push(line);
    manager.log = { info: log, warn: log, error: log, show() {}, dispose() {} };
    manager.openPdf = async (preserveFocus) => { opened.push(preserveFocus); };
    manager.isPdfOpen = () => false;
    return { record, opened };
  };

  vfs = makeVfs(() => outcome('failure', { hasLog: true }), { fileType: 'folder' }, LOG_WITH_ERROR);
  manager = managerFor(vfs);
  let seen = watched(manager);
  await manager.compile(true);
  await sleep(100);
  check('a compile without a PDF shows as failed', manager.status.text.includes('$(x)'), manager.status.text);
  check('a failed compile is not stuck', manager.inCompiling === false);
  check('a failed compile opens no PDF', seen.opened.length === 0);

  // the case behind "it still fails": Overleaf succeeded and made a PDF, and the log has a LaTeX error
  vfs = makeVfs(() => outcome('success', { hasLog: true, hasPdf: true }), { fileType: 'folder' }, LOG_WITH_ERROR);
  manager = managerFor(vfs);
  seen = watched(manager);
  await manager.compile(true);
  await sleep(100);
  check('a PDF with LaTeX errors does not show as failed', !manager.status.text.includes('$(x)'), manager.status.text);
  check('a PDF with LaTeX errors shows a warning', manager.status.text.includes('$(warning)'), manager.status.text);
  check('the record counts the LaTeX errors', seen.record.some((l) => l.includes('LaTeX errors 1')), JSON.stringify(seen.record));
  check('the record names the first error', seen.record.some((l) => l.includes('Undefined control sequence')), JSON.stringify(seen.record));

  check('a PDF with LaTeX errors still opens', seen.opened.length === 1);

  vfs = makeVfs(() => outcome('success', { hasLog: true, hasPdf: true }), { fileType: 'folder' }, 'clean log\n');
  manager = managerFor(vfs);
  seen = watched(manager);
  await manager.compile(true);
  await sleep(100);
  check('a clean compile shows as success', !manager.status.text.includes('$(x)') && !manager.status.text.includes('$(warning)') && !manager.status.text.includes('spin'), manager.status.text);
  check('a manual compile opens the PDF', seen.opened.length === 1);
  check('opening the PDF keeps the keyboard in the editor', seen.opened[0] === true);

  manager.isPdfOpen = () => true;
  await manager.compile(true);
  check('a PDF that is already open is not opened again', seen.opened.length === 1);

  vfs = makeVfs(() => outcome('success', { hasLog: true, hasPdf: true }), { fileType: 'folder' }, 'clean log\n');
  manager = managerFor(vfs);
  seen = watched(manager);
  await manager.compile(false);
  check('a compile on save does not open the PDF', seen.opened.length === 0);

  // a log that cannot be downloaded must not look like a problem in the manuscript
  vfs = makeVfs(() => outcome('success', { hasLog: true, hasPdf: true }), { fileType: 'folder' }, '');
  manager = managerFor(vfs);
  seen = watched(manager);
  await manager.compile(true);
  await sleep(100);
  check('an empty log does not show as an error', !manager.status.text.includes('$(x)') && !manager.status.text.includes('$(warning)'), manager.status.text);
  check('the record says the log was not available', seen.record.some((l) => l.includes('could not be downloaded')), JSON.stringify(seen.record));

  vfs = makeVfs(() => outcome('success', { hasLog: true, hasPdf: true }));
  const openFile = vfs.openFile;
  vfs.openFile = async (uri) => { if (uri.path.endsWith('output.log')) throw new Error('network down'); return openFile(uri); };
  manager = managerFor(vfs);
  seen = watched(manager);
  await manager.compile(true);
  await sleep(100);
  check('a failed log download does not fail the compile', !manager.status.text.includes('$(x)') && seen.opened.length === 1, manager.status.text);

  // a folder sync sends its changes before a compile and keeps a copy of the results after it
  const order = [];
  vfs = makeVfs(() => { order.push('compile'); return outcome('success', { hasLog: true, hasPdf: true }); }, { fileType: 'folder' }, 'clean log\n');
  manager = managerFor(vfs);
  watched(manager);
  CompileManager.beforeCompile = async () => { order.push('flush'); };
  CompileManager.afterCompile = async (_, finished) => { order.push(`saved ${finished.status}`); };
  await manager.compile(true);
  check('pending changes are sent before compiling', order.join() === 'flush,compile,saved success', order.join());

  CompileManager.beforeCompile = async () => { throw new Error('offline'); };
  vfs = makeVfs(() => outcome('success'));
  manager = managerFor(vfs);
  await manager.compile(true);
  check('if they cannot be sent, stale text is not compiled', vfs.calls.compile.length === 0);
  check('and compiling is not stuck', manager.inCompiling === false);

  CompileManager.beforeCompile = undefined;
  CompileManager.afterCompile = async () => { throw new Error('disk full'); };
  vfs = makeVfs(() => outcome('success', { hasLog: true, hasPdf: true }), { fileType: 'folder' }, 'clean log\n');
  manager = managerFor(vfs);
  seen = watched(manager);
  await manager.compile(true);
  await sleep(100);
  check('failing to keep a local copy does not fail the compile', !manager.status.text.includes('$(x)') && seen.opened.length === 1, manager.status.text);
  check('but is recorded', seen.record.some((l) => l.includes('disk full')), JSON.stringify(seen.record));
  CompileManager.afterCompile = undefined;

  vfs = makeVfs(() => outcome('request-failed', { message: '500: boom' }));
  manager = managerFor(vfs);
  await manager.compile(true);
  await sleep(100);
  check('a failed request shows a connection alert', manager.status.text.includes('$(alert)'), manager.status.text);

  vfs = makeVfs(() => undefined);
  manager = managerFor(vfs);
  await manager.compile(false);
  check('nothing to compile leaves it ready', manager.inCompiling === false);
}

/** Jumping between the code and the PDF from a synced folder. Runs first, before anything opens an online file. */
async function testJumps(CompileManager, LocalReplicaSCMProvider, EventBus) {
  // Opening a .tex file wakes the plugin itself, whose sync finds this folder, sees no login and holds connections
  // back. That is right for it, and says nothing about jumping, so here the folder stays available.
  Object.defineProperty(LocalReplicaSCMProvider, 'detached', { configurable: true, get: () => false, set: () => {} });
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const folder = path.join(root, 'overleaf-Test');
  const main = path.join(folder, 'main.tex');
  const part = path.join(folder, 'sections', 'part two.tex');
  fs.mkdirSync(path.join(folder, '.overleaf'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'sections'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.overleaf', 'settings.json'), JSON.stringify({ uri: ORIGIN.toString(), enableCompileNPreview: true }));
  fs.writeFileSync(main, 'first\nsecond\nthird\nfourth\n');
  fs.writeFileSync(part, 'one\ntwo\nthree\n');
  LocalReplicaSCMProvider.forgetProjectRoot();
  const same = (a, b) => a?.toLowerCase() === b.toLowerCase();

  const asked = [];
  const posted = [];
  const revealed = [];
  let position = [{ page: 3, h: 100, v: 200 }];
  let target = { file: 'main.tex', line: 2, column: 0 };
  const vfs = {
    syncCode: async (...args) => { asked.push(args); return position; },
    syncPdf: async () => target,
    pathToUri: (...parts) => vscode.Uri.joinPath(ORIGIN, ...parts),
    openFile: async () => new TextEncoder().encode(LOG_WITH_ERROR),
  };
  const manager = new CompileManager({ prefetch: async () => vfs });
  const pdfUri = vscode.Uri.joinPath(ORIGIN, '.output', 'output.pdf');
  let closePanel;
  const openPanel = () => EventBus.fire('pdfWillOpenEvent', {
    uri: pdfUri,
    doc: {},
    webviewPanel: {
      viewColumn: 2,
      webview: { postMessage: async (message) => { posted.push(message); return true; } },
      reveal: (column, preserveFocus) => { revealed.push({ column, preserveFocus }); },
      onDidDispose: (listener) => { closePanel = listener; },
    },
  });
  openPanel();

  const inEditor = async (file, line, character = 0) => {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    editor.selection = new vscode.Selection(line, character, line, character);
    return editor;
  };

  // from the code to the PDF
  await inEditor(main, 2, 1);
  await manager.syncCode();
  check('to the PDF: from a local file, it names that file', asked.at(-1)?.[0] === 'main.tex', JSON.stringify(asked.at(-1)));
  check('to the PDF: counting lines from 1, as the server does', asked.at(-1)?.[1] === 3 && asked.at(-1)?.[2] === 1, JSON.stringify(asked.at(-1)));
  check('to the PDF: the PDF is told where to go', posted.at(-1)?.type === 'syncCode' && posted.at(-1)?.content === position);
  check('to the PDF: it is brought to the front without taking the keyboard', revealed.at(-1)?.column === 2 && revealed.at(-1)?.preserveFocus === true, JSON.stringify(revealed));

  await inEditor(part, 1);
  await manager.syncCode();
  check('to the PDF: from a file in a folder, with a space in its name', asked.at(-1)?.[0] === 'sections/part two.tex' && asked.at(-1)?.[1] === 2, JSON.stringify(asked.at(-1)));

  // a file next to the project
  const beside = path.join(root, 'beside.tex');
  fs.writeFileSync(beside, 'not in the project\n');
  const askedBefore = asked.length;
  const postedBefore = posted.length;
  await inEditor(beside, 0);
  await manager.syncCode();
  check('to the PDF: a file next to the project is not asked about', asked.length === askedBefore && posted.length === postedBefore);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  fs.rmSync(beside);

  // nothing found, or the request failing
  await inEditor(main, 0);
  position = [];
  await manager.syncCode();
  check('to the PDF: with no such place, the PDF stays where it is', posted.length === postedBefore);
  position = undefined;
  await manager.syncCode();
  check('to the PDF: with a failed request too', posted.length === postedBefore);
  position = [{ page: 3, h: 100, v: 200 }];

  // the PDF closed
  closePanel();
  const opened = [];
  const realOpen = manager.openPdf;
  manager.openPdf = async (preserveFocus) => { opened.push(preserveFocus); openPanel(); };
  await manager.syncCode();
  check('to the PDF: a closed PDF is opened, without taking the keyboard', opened.length === 1 && opened[0] === true, JSON.stringify(opened));
  check('to the PDF: and is told where to go', posted.length === postedBefore + 1);
  await manager.syncCode();
  check('to the PDF: one already open is not opened again', opened.length === 1);
  manager.openPdf = realOpen;

  // from the PDF to the code
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  target = { file: 'main.tex', line: 2, column: 0 };
  await manager.syncPdf({ page: 1, h: 1, v: 1, identifier: 'second' });
  let landed = vscode.window.activeTextEditor;
  check('to the code: opens the real local file', landed?.document.uri.scheme === 'file' && same(landed?.document.uri.fsPath, main), landed?.document.uri.toString());
  check('to the code: at the line the server named', landed?.selection.active.line === 1, String(landed?.selection.active.line));

  target = { file: 'sections/part two.tex', line: 3, column: 0 };
  await manager.syncPdf({ page: 1, h: 1, v: 1, identifier: 'three' });
  landed = vscode.window.activeTextEditor;
  check('to the code: opens another local file', landed?.document.uri.scheme === 'file' && same(landed?.document.uri.fsPath, part), landed?.document.uri.toString());
  check('to the code: at its line', landed?.selection.active.line === 2, String(landed?.selection.active.line));

  await vscode.window.showTextDocument(vscode.Uri.file(main));
  target = { file: 'main.tex', line: 4, column: 0 };
  await manager.syncPdf({ page: 1, h: 1, v: 1, identifier: 'fourth' });
  const tabsOnMain = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && same(t.input.uri.fsPath, main));
  check('to the code: a file already open is not opened twice', tabsOnMain.length === 1, String(tabsOnMain.length));
  check('to the code: nothing online was opened', vscode.window.tabGroups.all.flatMap((g) => g.tabs).every((t) => !(t.input instanceof vscode.TabInputText) || t.input.uri.scheme === 'file'));

  // compile errors
  const summary = await manager.diagnosticProvider.updateDiagnostics(ORIGIN);
  check('a compile error: reported', summary.errors.length === 1, JSON.stringify(summary));
  const onLocal = vscode.languages.getDiagnostics(vscode.Uri.file(main));
  check('a compile error: shown on the real local file', onLocal.some((d) => /Undefined control sequence/.test(d.message)), JSON.stringify(onLocal.map((d) => d.message)));
  check('a compile error: at its line', onLocal.find((d) => /Undefined control sequence/.test(d.message))?.range.start.line === 2);
  check('a compile error: not on an online copy', vscode.languages.getDiagnostics().every(([uri, list]) => uri.scheme === 'file' || list.length === 0));
  manager.diagnosticProvider.diagnosticCollection.clear();

  closePanel(); // the record of open PDFs is shared, and a later compile would refresh this pretend one
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  fs.rmSync(folder, { recursive: true, force: true });
  LocalReplicaSCMProvider.forgetProjectRoot();
  Object.defineProperty(LocalReplicaSCMProvider, 'detached', { configurable: true, writable: true, value: false });
}

exports.run = async function () {
  try {
    const { BaseAPI } = require(path.join(out, 'api', 'base.js'));
    const provider = require(path.join(out, 'core', 'remoteFileSystemProvider.js'));
    const { GlobalStateManager } = require(path.join(out, 'utils', 'globalStateManager.js'));
    const { CompileManager } = require(path.join(out, 'compile', 'compileManager.js'));
    GlobalStateManager.authenticate = async () => ({ cookies: 'x=y', csrfToken: 't' });

    await testJumps(CompileManager, require(path.join(out, 'scm', 'localReplicaSCM.js')).LocalReplicaSCMProvider, require(path.join(out, 'utils', 'eventBus.js')).EventBus);
    await testApi(BaseAPI);
    await testVfs(provider.VirtualFileSystem);
    await testManager(CompileManager);
  } catch (e) {
    results.push(`ERROR ${e && e.stack}`);
  } finally {
    fs.writeFileSync(path.join(here, 'results.txt'), results.join('\n') + '\n', 'utf8');
  }
};

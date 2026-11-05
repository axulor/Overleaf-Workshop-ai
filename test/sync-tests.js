// Runs inside an isolated VS Code, with a real disk, file watcher and editors, and a fake Overleaf.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const here = process.env.OVERLEAF_AI_TEST_DIR;
const out = path.join(__dirname, '..', 'out');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(condition, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(50);
  }
  return false;
}
const SETTLE_MS = 1500;
const { EventBus } = require(path.join(out, 'utils', 'eventBus.js'));

/** An in-memory Overleaf project that records everything done to it. */
class FakeRemote {
  constructor(docs = {}, files = {}) {
    this.docs = new Map(Object.entries(docs));
    this.files = new Map(Object.entries(files).map(([p, c]) => [p, { content: Buffer.from(c), version: 1 }]));
    this.writes = [];
    this.removed = [];
    this.fileReads = 0;
    this.failWrites = false;
    this.changed = new vscode.EventEmitter();
    this.connected = new vscode.EventEmitter();
    this.disconnected = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.onDidConnect = this.connected.event;
    this.onDidDisconnect = this.disconnected.event;
  }
  async list() {
    return [
      ...[...this.docs.keys()].map((p) => ({ path: p, kind: 'doc', version: `doc:${p}` })),
      ...[...this.files].map(([p, f]) => ({ path: p, kind: 'file', version: `${p}:${f.version}` })),
    ];
  }
  async readDoc(p) { return this.docs.get(p); }
  async readFile(p) { this.fileReads++; return new Uint8Array(this.files.get(p).content); }
  async writeDoc(p, text) {
    if (this.failWrites) throw new Error('offline');
    this.writes.push({ path: p, text });
    this.docs.set(p, text);
  }
  async writeFile(p, content) {
    if (this.failWrites) throw new Error('offline');
    const text = Buffer.from(content).toString();
    this.writes.push({ path: p, text, created: true });
    if (/\.(tex|bib)$/.test(p)) {
      this.docs.set(p, text.replace(/\r\n/g, '\n'));
    } else {
      const previous = this.files.get(p);
      this.files.set(p, { content: Buffer.from(content), version: (previous?.version ?? 0) + 1 });
    }
  }
  async remove(p) { this.removed.push(p); this.docs.delete(p); this.files.delete(p); }
  // what a collaborator does
  edit(p, text) { this.docs.set(p, text); this.changed.fire(p); }
  replaceFile(p, content) { this.files.set(p, { content: Buffer.from(content), version: this.files.get(p).version + 1 }); this.changed.fire(undefined); }
  deleteOnline(p) { this.docs.delete(p); this.files.delete(p); this.changed.fire(undefined); }
  addOnline(p, text) { this.docs.set(p, text); this.changed.fire(undefined); }
}

let caseNumber = 0;
const workspaceRoot = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

/** A fresh folder and engine. Pre-existing local files can be given. */
async function setup(FolderSync, remote, localFiles = {}, optionsOverride = {}) {
  const root = path.join(workspaceRoot(), `case-${++caseNumber}`, 'overleaf');
  fs.mkdirSync(root, { recursive: true });
  for (const [p, content] of Object.entries(localFiles)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), content);
  }
  const context = { root, remote, asked: [], answer: false, conflicts: [], logs: [] };
  context.make = () => new FolderSync(vscode.Uri.file(root), remote, {
    confirmRemoteDelete: async (paths) => { context.asked.push(paths); return context.answer; },
    onConflict: (p, reason) => context.conflicts.push({ path: p, reason }),
    log: (m) => context.logs.push(m),
    ...optionsOverride,
  });
  context.sync = context.make();
  await context.sync.start();
  context.read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  context.exists = (p) => fs.existsSync(path.join(root, p));
  context.write = (p, content) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), content);
  };
  context.remove = (p) => fs.rmSync(path.join(root, p), { recursive: true });
  return context;
}

function testMerge({ decide, mergeText, decodeText }) {
  check('decide: nothing changed', decide('b', 'b', 'b') === 'none');
  check('decide: both made the same change', decide('b', 'x', 'x') === 'none');
  check('decide: changed online', decide('b', 'b', 'r') === 'pull');
  check('decide: changed locally', decide('b', 'l', 'b') === 'push');
  check('decide: both changed', decide('b', 'l', 'r') === 'merge');
  check('decide: deleted online', decide('b', 'b', undefined) === 'deleteLocal');
  check('decide: deleted locally', decide('b', undefined, 'b') === 'deleteRemote');
  check('decide: changed locally, deleted online', decide('b', 'l', undefined) === 'conflict');
  check('decide: deleted locally, changed online', decide('b', undefined, 'r') === 'conflict');
  check('decide: new online', decide(undefined, undefined, 'r') === 'pull');
  check('decide: new locally', decide(undefined, 'l', undefined) === 'push');
  check('decide: different new files', decide(undefined, 'l', 'r') === 'conflict');

  const base = 'First sentence. Second sentence.\n\nA second paragraph here.\n';
  let m = mergeText(base, 'First sentence, edited. Second sentence.\n\nA second paragraph here.\n', 'First sentence. Second sentence.\n\nA second paragraph, edited too.\n');
  check('merge: different paragraphs', m.ok && m.text === 'First sentence, edited. Second sentence.\n\nA second paragraph, edited too.\n', JSON.stringify(m));
  m = mergeText(base, 'First sentence, edited. Second sentence.\n\nA second paragraph here.\n', 'First sentence. Second sentence, changed.\n\nA second paragraph here.\n');
  check('merge: different sentences on one line', m.ok && m.text.includes('First sentence, edited.') && m.text.includes('Second sentence, changed.'), JSON.stringify(m));
  m = mergeText(base, 'One version. Second sentence.\n\nA second paragraph here.\n', 'Another version. Second sentence.\n\nA second paragraph here.\n');
  check('merge: same region is a conflict', !m.ok, JSON.stringify(m));
  m = mergeText(base, base.replace('First', 'Same'), base.replace('First', 'Same'));
  check('merge: the same edit twice', m.ok && m.text === base.replace('First', 'Same'));
  m = mergeText('abc', 'abXc', 'abYc');
  check('merge: two insertions at one point are a conflict', !m.ok);
  m = mergeText('疫苗接种率的变化。感染人数下降。', '疫苗接种率的明显变化。感染人数下降。', '疫苗接种率的变化。感染人数迅速下降。');
  check('merge: Chinese text', m.ok && m.text === '疫苗接种率的明显变化。感染人数迅速下降。', JSON.stringify(m));

  // whatever the texts, one-sided changes must come through exactly
  const words = ['alpha ', 'beta ', 'gamma\n', '$R_0$ ', '\\cite{a} ', '疫苗 ', '\n\n'];
  const pick = (n) => Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join('');
  let exact = true;
  for (let i = 0; i < 300 && exact; i++) {
    const b = pick(40), a = pick(40);
    const one = mergeText(b, a, b), two = mergeText(b, b, a);
    exact = one.ok && one.text === a && two.ok && two.text === a;
  }
  check('merge: a change on one side always comes through exactly (300 random texts)', exact);

  check('text: line endings and byte order mark are normalized', decodeText(Buffer.from('﻿a\r\nb\n')) === 'a\nb\n');
  check('text: invalid UTF-8 is refused', decodeText(Buffer.from([0x66, 0xff, 0xfe])) === undefined);
}

async function testSync(FolderSync) {
  // ---- first sync ----
  let c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'hello\n', 'sections/intro.tex': 'intro\n' }, { 'figures/a.png': 'PNGDATA' }));
  check('first sync: documents arrive', c.read('main.tex') === 'hello\n' && c.read('sections/intro.tex') === 'intro\n');
  check('first sync: files arrive', c.read('figures/a.png') === 'PNGDATA');
  check('first sync: nothing is written online', c.remote.writes.length === 0);
  check('first sync: the state folder stays out of git', c.read('.overleaf/.gitignore') === '*\n');

  // ---- no echo: syncing what just arrived must do nothing ----
  await sleep(SETTLE_MS);
  check('no echo after pulling', c.remote.writes.length === 0, JSON.stringify(c.remote.writes));
  check('an unchanged binary is not downloaded again', c.remote.fileReads === 1, `${c.remote.fileReads} reads`);

  // ---- local edits, as an AI tool makes them ----
  c.write('main.tex', 'hello world\n');
  check('a disk edit reaches Overleaf', await until(() => c.remote.docs.get('main.tex') === 'hello world\n'));
  await sleep(SETTLE_MS);
  check('it is sent exactly once', c.remote.writes.length === 1, JSON.stringify(c.remote.writes));

  // atomic save: temp file, then rename over the target
  const tempName = 'main.tex.tmp.1234.5678';
  c.write(tempName, 'atomic\n');
  fs.renameSync(path.join(c.root, tempName), path.join(c.root, 'main.tex'));
  check('an atomic save reaches Overleaf', await until(() => c.remote.docs.get('main.tex') === 'atomic\n'));
  await sleep(SETTLE_MS);
  check('its temp file does not', !c.remote.writes.some((w) => w.path.includes('.tmp')), JSON.stringify(c.remote.writes.map((w) => w.path)));

  // a tool that truncates and then writes
  const before = c.remote.writes.length;
  c.write('main.tex', '');
  await sleep(100);
  c.write('main.tex', 'rewritten\n');
  check('truncate then write reaches Overleaf', await until(() => c.remote.docs.get('main.tex') === 'rewritten\n'));
  check('the empty moment never does', !c.remote.writes.slice(before).some((w) => w.text === ''), JSON.stringify(c.remote.writes.slice(before)));

  // flush, as a compile does: nothing pending may be left behind
  c.write('main.tex', 'flushed\n');
  await c.sync.flush();
  check('flush sends a change made just before it', c.remote.docs.get('main.tex') === 'flushed\n', c.remote.docs.get('main.tex'));

  // ---- a collaborator's edits ----
  const writesBefore = c.remote.writes.length;
  c.remote.edit('main.tex', 'from a collaborator\n');
  check('an online edit reaches the disk', await until(() => c.read('main.tex') === 'from a collaborator\n'));
  await sleep(SETTLE_MS);
  check('and is not echoed back', c.remote.writes.length === writesBefore);
  c.remote.addOnline('new/online.tex', 'new online\n');
  check('a new online file arrives', await until(() => c.exists('new/online.tex') && c.read('new/online.tex') === 'new online\n'));
  c.remote.replaceFile('figures/a.png', 'NEWPNG');
  check('a replaced online binary arrives', await until(() => c.read('figures/a.png') === 'NEWPNG'));
  c.sync.dispose();

  // ---- editors ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'Alpha sentence. Beta sentence.\n' }));
  const uri = vscode.Uri.file(path.join(c.root, 'main.tex'));
  const editor = await vscode.window.showTextDocument(uri);
  c.remote.edit('main.tex', 'Alpha sentence. Beta sentence. Gamma.\n');
  check('an open file shows an online edit', await until(() => editor.document.getText() === 'Alpha sentence. Beta sentence. Gamma.\n'), JSON.stringify(editor.document.getText()));

  await sleep(SETTLE_MS); // a late file event from the online edit must not be what carries the typing along
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'Typed. '));
  check('typing reaches Overleaf without saving', await until(() => c.remote.docs.get('main.tex') === 'Typed. Alpha sentence. Beta sentence. Gamma.\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  check('typing is saved automatically', await until(() => !editor.document.isDirty), JSON.stringify(c.logs));
  check('so the disk has it for other tools', c.read('main.tex') === 'Typed. Alpha sentence. Beta sentence. Gamma.\n', JSON.stringify(c.read('main.tex')));

  // an online edit arriving while there is unsaved typing
  await sleep(SETTLE_MS);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'More. '));
  check('setup: the editor has unsaved typing', editor.document.isDirty);
  c.remote.edit('main.tex', 'Typed. Alpha sentence. Beta sentence. Gamma. Delta.\n');
  const both = 'More. Typed. Alpha sentence. Beta sentence. Gamma. Delta.\n';
  check('an online edit during typing merges into the editor', await until(() => editor.document.getText() === both), JSON.stringify(editor.document.getText()));
  check('and both reach Overleaf', await until(() => c.remote.docs.get('main.tex') === both), JSON.stringify(c.remote.docs.get('main.tex')));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  c.sync.dispose();

  // VS Code drops a save if typing continues during it, and typing must still reach the disk
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n' }));
  let saveCalls = 0;
  const flaky = { isDirty: true, getText: () => 'x\n', save: async () => { saveCalls++; if (saveCalls < 3) return false; flaky.isDirty = false; return true; } };
  c.sync.openDocument = () => flaky;
  await c.sync.saveBuffer('main.tex');
  check('a dropped save is tried again', await until(() => saveCalls === 3 && !flaky.isDirty), `${saveCalls} calls`);
  check('and is not reported as a problem if it then works', !c.logs.some((l) => l.includes('could not save')), JSON.stringify(c.logs));
  let doomedCalls = 0;
  const doomed = { isDirty: true, getText: () => 'x\n', save: async () => { doomedCalls++; return false; } };
  c.sync.openDocument = () => doomed;
  await c.sync.saveBuffer('main.tex');
  check('a save that keeps failing is reported, not retried forever', await until(() => c.logs.some((l) => l.includes('could not save'))), `${doomedCalls} calls`);
  await sleep(800);
  check('it stops after a few attempts', doomedCalls === 5, `${doomedCalls} calls`);
  doomed.isDirty = false;
  c.sync.dispose();

  // ---- offline, and restarts ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'One. Two.\n\nThree.\n' }));
  c.remote.disconnected.fire();
  await until(() => !c.sync.status.connected);
  c.write('main.tex', 'One changed. Two.\n\nThree.\n');
  await sleep(SETTLE_MS);
  check('offline: nothing is sent', c.remote.writes.length === 0);
  check('offline: the status says so', c.sync.status.connected === false);
  c.remote.docs.set('main.tex', 'One. Two.\n\nThree changed.\n');
  c.remote.connected.fire();
  const merged = 'One changed. Two.\n\nThree changed.\n';
  check('reconnecting merges both sides on the disk', await until(() => c.read('main.tex') === merged), JSON.stringify(c.read('main.tex')));
  check('reconnecting merges both sides online', await until(() => c.remote.docs.get('main.tex') === merged), JSON.stringify(c.remote.docs.get('main.tex')));
  await c.sync.stop();

  // edits while nothing is running: the original extension overwrites these with the online version
  c.write('main.tex', 'One changed while stopped. Two.\n\nThree changed.\n');
  c.sync = c.make();
  await c.sync.start();
  check('a restart keeps and sends edits made while stopped', c.remote.docs.get('main.tex') === 'One changed while stopped. Two.\n\nThree changed.\n' && c.read('main.tex').includes('while stopped'), JSON.stringify(c.remote.docs.get('main.tex')));
  await c.sync.stop();
  c.write('main.tex', 'Local again. Two.\n\nThree changed.\n');
  c.remote.docs.set('main.tex', 'One changed while stopped. Two.\n\nOnline again.\n');
  c.sync = c.make();
  await c.sync.start();
  check('a restart merges edits from both sides', c.read('main.tex') === 'Local again. Two.\n\nOnline again.\n' && c.remote.docs.get('main.tex') === 'Local again. Two.\n\nOnline again.\n', JSON.stringify([c.read('main.tex'), c.remote.docs.get('main.tex'), c.sync.status, c.logs]));
  c.sync.dispose();

  // the history survives a moment when its file cannot be read
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'History.\n' }));
  await c.sync.stop();
  const manifest = path.join(c.root, '.overleaf', 'sync', 'manifest.json');
  const history = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, '{ half written');
  setTimeout(() => fs.writeFileSync(manifest, history), 250);
  c.write('main.tex', 'History, edited while stopped.\n');
  c.sync = c.make();
  await c.sync.start();
  check('a history file caught mid-write is read again, not treated as lost', c.sync.status.conflicts.length === 0 && c.remote.docs.get('main.tex') === 'History, edited while stopped.\n', JSON.stringify([c.sync.status, c.logs]));
  await c.sync.stop();

  // and if it really is damaged, nothing is overwritten
  fs.writeFileSync(manifest, 'not json at all');
  c.write('main.tex', 'Local, with the history gone.\n');
  c.sync = c.make();
  await c.sync.start();
  check('a damaged history is reported', c.logs.some((l) => l.includes('could not be read')), JSON.stringify(c.logs));
  check('and nothing is overwritten on either side', c.read('main.tex') === 'Local, with the history gone.\n' && c.remote.docs.get('main.tex') === 'History, edited while stopped.\n' && c.sync.status.conflicts.length === 1, JSON.stringify(c.sync.status));
  await c.sync.stop();

  // ---- conflicts ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'Base sentence.\n' }));
  c.remote.docs.set('main.tex', 'Online version.\n');
  c.write('main.tex', 'Local version.\n');
  c.remote.changed.fire('main.tex');
  check('the same region: a conflict is reported', await until(() => c.sync.status.conflicts.length === 1), JSON.stringify(c.sync.status));
  check('the same region: the local file is untouched', c.read('main.tex') === 'Local version.\n');
  check('the same region: the online file is untouched', c.remote.docs.get('main.tex') === 'Online version.\n');
  check('the online version is saved for comparing', fs.readFileSync(c.sync.conflictCopyUri('main.tex').fsPath, 'utf8') === 'Online version.\n');
  await c.sync.flush();
  c.remote.changed.fire('main.tex');
  await sleep(500);
  check('it is reported only once', c.conflicts.length === 1, JSON.stringify(c.conflicts));
  await c.sync.resolveConflict('main.tex', 'online');
  check('choosing online updates the disk', await until(() => c.read('main.tex') === 'Online version.\n'));
  check('choosing clears the conflict', c.sync.status.conflicts.length === 0);
  c.remote.docs.set('main.tex', 'Online 2.\n');
  c.write('main.tex', 'Local 2.\n');
  c.remote.changed.fire('main.tex');
  await until(() => c.sync.status.conflicts.length === 1);
  await c.sync.resolveConflict('main.tex', 'local');
  check('choosing local updates Overleaf', await until(() => c.remote.docs.get('main.tex') === 'Local 2.\n'));
  check('and the disk stays as it was', c.read('main.tex') === 'Local 2.\n');

  // a file left empty is not spread to everyone
  const writes = c.remote.writes.length;
  c.write('main.tex', '');
  check('a file left empty is a conflict', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'emptied')), JSON.stringify(c.sync.status));
  check('and is not sent', c.remote.writes.length === writes && c.remote.docs.get('main.tex') === 'Local 2.\n');
  await c.sync.resolveConflict('main.tex', 'online');
  check('it can be restored from online', await until(() => c.read('main.tex') === 'Local 2.\n'));
  c.remote.edit('main.tex', '');
  check('a file emptied online is a conflict too', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'emptied')));
  check('and does not wipe the local file', c.read('main.tex') === 'Local 2.\n');
  await c.sync.resolveConflict('main.tex', 'online');
  check('unless that is chosen', await until(() => c.read('main.tex') === ''));
  c.sync.dispose();

  // a folder that already has different content, with no history
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'online\n', 'same.tex': 'same\n' }), { 'main.tex': 'local\n', 'same.tex': 'same\n', 'extra.tex': 'extra\n' });
  check('linking a folder never overwrites a different file', c.read('main.tex') === 'local\n' && c.remote.docs.get('main.tex') === 'online\n');
  check('and reports it', c.sync.status.conflicts.length === 1 && c.sync.status.conflicts[0].reason === 'bothNew', JSON.stringify(c.sync.status.conflicts));
  check('an identical file is simply in step', !c.sync.status.conflicts.some((x) => x.path === 'same.tex'));
  check('a file only on the disk is sent', c.remote.docs.get('extra.tex') === 'extra\n');
  c.sync.dispose();

  // ---- encodings and line endings ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'a\nb\n', 'crlf.tex': 'c\nd\n' }), { 'main.tex': 'a\r\nb\r\n', 'crlf.tex': 'c\r\nd\r\n' });
  await sleep(SETTLE_MS);
  check('CRLF alone is not a change', c.remote.writes.length === 0 && c.sync.status.conflicts.length === 0, JSON.stringify(c.remote.writes));
  c.write('main.tex', 'a\r\nchanged\r\n');
  check('a real change in a CRLF file is sent with LF', await until(() => c.remote.docs.get('main.tex') === 'a\nchanged\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  c.remote.edit('crlf.tex', 'c\nd\ne\n');
  check('a CRLF file keeps CRLF when an online edit arrives', await until(() => c.read('crlf.tex') === 'c\r\nd\r\ne\r\n'), JSON.stringify(c.read('crlf.tex')));
  c.write('main.tex', '﻿a\r\nchanged\r\n');
  await sleep(SETTLE_MS);
  check('a byte order mark alone is not a change', c.remote.docs.get('main.tex') === 'a\nchanged\n');
  const count = c.remote.writes.length;
  c.write('main.tex', Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
  await sleep(SETTLE_MS);
  check('invalid UTF-8 is not sent', c.remote.writes.length === count && c.remote.docs.get('main.tex') === 'a\nchanged\n');
  check('and is reported', c.logs.some((l) => l.includes('not valid UTF-8')), JSON.stringify(c.logs));
  c.sync.dispose();

  // ---- new files and ignored files ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n' }));
  c.write('sections/new.tex', 'new section\n');
  check('a new local document reaches Overleaf', await until(() => c.remote.docs.get('sections/new.tex') === 'new section\n'));
  c.write('figures/plot.png', 'BINARY');
  check('a new local file reaches Overleaf', await until(() => c.remote.files.has('figures/plot.png')));
  c.write('figures/plot.png', 'BINARY2');
  check('a changed local file reaches Overleaf', await until(() => Buffer.from(c.remote.files.get('figures/plot.png').content).toString() === 'BINARY2'));
  c.write('main.aux', 'aux'); c.write('.output/output.pdf', 'pdf'); c.write('.overleaf/settings.json', '{}'); c.write('notes~', 'backup');
  await sleep(SETTLE_MS);
  const names = c.remote.writes.map((w) => w.path);
  check('build files and hidden folders stay local', !names.some((n) => /aux$|output|settings|~$/.test(n)), JSON.stringify(names));
  // a folder moved in reports only the folder
  fs.mkdirSync(path.join(workspaceRoot(), `moved-${caseNumber}`));
  fs.writeFileSync(path.join(workspaceRoot(), `moved-${caseNumber}`, 'inside.tex'), 'inside\n');
  fs.renameSync(path.join(workspaceRoot(), `moved-${caseNumber}`), path.join(c.root, 'moved'));
  check('a folder moved in reaches Overleaf with its contents', await until(() => c.remote.docs.get('moved/inside.tex') === 'inside\n'), JSON.stringify([...c.remote.docs.keys()]));
  c.sync.dispose();

  // ---- deleting ----
  c = await setup(FolderSync, new FakeRemote({ 'a.tex': 'a\n', 'sub/b.tex': 'b\n', 'sub/c.tex': 'c\n', 'keep.tex': 'keep\n', 'gone.tex': 'gone\n', 'edited.tex': 'edited\n' }));
  c.answer = false;
  c.remove('a.tex');
  check('deleting locally asks first', await until(() => c.asked.length === 1), JSON.stringify(c.asked));
  check('declining keeps it online', c.remote.docs.has('a.tex') && c.remote.removed.length === 0);
  check('declining brings it back', await until(() => c.exists('a.tex') && c.read('a.tex') === 'a\n'));
  c.answer = true;
  c.remove('sub');
  check('deleting a folder asks once, for all of it', await until(() => c.asked.length === 2) && c.asked[1].length === 2, JSON.stringify(c.asked));
  check('accepting deletes online', await until(() => !c.remote.docs.has('sub/b.tex') && !c.remote.docs.has('sub/c.tex')), JSON.stringify(c.remote.removed));
  await sleep(SETTLE_MS);
  check('and it stays deleted locally', !c.exists('sub/b.tex'));
  check('nothing else was deleted', c.remote.docs.has('keep.tex'));
  c.remote.deleteOnline('gone.tex');
  check('a file deleted online leaves the folder', await until(() => !c.exists('gone.tex')));
  const trash = path.join(c.root, '.overleaf', 'sync', 'trash');
  const kept = fs.existsSync(trash) && fs.readdirSync(trash).some((stamp) => fs.existsSync(path.join(trash, stamp, 'gone.tex')));
  check('but is kept in the trash', kept);
  c.write('edited.tex', 'edited locally\n');
  await c.sync.flush();
  c.remote.docs.delete('edited.tex');
  c.write('edited.tex', 'edited locally again\n');
  c.remote.changed.fire(undefined);
  check('edited here and deleted online is a conflict', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'deletedOnOneSide')), JSON.stringify(c.sync.status));
  check('and the edit is kept', c.read('edited.tex') === 'edited locally again\n');
  c.sync.dispose();

  // ---- failures ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n' }));
  c.remote.failWrites = true;
  c.write('main.tex', 'y\n');
  check('a failed send is reported', await until(() => c.sync.status.failed.includes('main.tex')), JSON.stringify(c.sync.status));
  check('and logged', c.logs.some((l) => l.includes('Could not sync main.tex')));
  c.remote.failWrites = false;
  check('and retried until it works', await until(() => c.remote.docs.get('main.tex') === 'y\n', 9000), JSON.stringify(c.sync.status));
  check('then the failure clears', await until(() => c.sync.status.failed.length === 0));

  // a compile needs to know that a change did not get through
  c.remote.failWrites = true;
  c.write('main.tex', 'z\n');
  await c.sync.flush();
  check('flush tries a few times and then reports what failed', c.sync.status.failed.includes('main.tex'), JSON.stringify(c.sync.status));
  c.remote.failWrites = false;
  await c.sync.flush();
  check('flush gets it through once it can', c.remote.docs.get('main.tex') === 'z\n' && c.sync.status.failed.length === 0, JSON.stringify(c.sync.status));
  c.sync.dispose();
}

// ---- writing to Overleaf: the real class with a fake connection ----

async function testReplaceDocContent(VirtualFileSystem, GlobalStateManager) {
  GlobalStateManager.authenticate = async () => ({ cookies: 'x=y', csrfToken: 't' });
  const ORIGIN = vscode.Uri.parse('overleaf-workshop://www.overleaf.com/Test?user=u1&project=p1');
  const DOC_URI = ORIGIN.with({ path: '/Test/main.tex' });
  const applyOps = (text, op) => {
    let result = text;
    for (const o of op) {
      if (o.i !== undefined) result = result.slice(0, o.p) + o.i + result.slice(o.p);
      if (o.d !== undefined) {
        if (result.slice(o.p, o.p + o.d.length) !== o.d) throw new Error('a delete does not match the text');
        result = result.slice(0, o.p) + result.slice(o.p + o.d.length);
      }
      if (o.c !== undefined && result.slice(o.p, o.p + o.c.length) !== o.c) throw new Error('a comment does not match the text');
    }
    return result;
  };
  const make = (server) => {
    const vfs = Object.create(VirtualFileSystem.prototype);
    const doc = { _id: 'doc1', name: 'main.tex' };
    const sent = [];
    const notified = [];
    const handlers = {};
    Object.assign(vfs, {
      context: {}, serverName: 'www.overleaf.com', projectId: 'p1', projectName: 'Test', origin: ORIGIN, isDirty: false,
      notify: (events) => notified.push(...events),
      root: { rootDoc_id: 'doc1', rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [doc], fileRefs: [], folders: [] }] },
      socket: {
        updateEventHandlers: (h) => Object.assign(handlers, h),
        joinDoc: async () => { sent.push('join'); return { docLines: server.text.split('\n'), version: server.version }; },
        applyOtUpdate: async (id, update) => {
          sent.push(update);
          if (server.beforeAck) await server.beforeAck(update);
          if (server.fail) throw 'timeout';
          server.text = applyOps(server.text, update.op);
          server.version++;
          if (!server.ackLater) { handlers.onFileChanged({ doc: id, v: update.v }); } // the acknowledgement carries no op
        },
      },
    });
    vfs.init = async () => vfs.root;
    vfs.remoteWatch();
    return { vfs, doc, sent, notified, handlers };
  };

  let server = { text: 'Hello world.\n疫苗接种。\n', version: 5 };
  let t = make(server);
  await t.vfs.replaceDocContent(DOC_URI, 'Hello brave world.\n疫苗接种率。\n');
  check('write: it joins the document first instead of silently doing nothing', t.sent[0] === 'join', JSON.stringify(t.sent[0]));
  check('write: the server ends up with exactly the text', server.text === 'Hello brave world.\n疫苗接种率。\n', JSON.stringify(server.text));
  check('write: only the difference is sent', t.sent[1].op.every((o) => (o.i ?? o.d).length < 10), JSON.stringify(t.sent[1].op));
  check('write: the version is sent', t.sent[1].v === 5);
  check('write: the cache follows', t.doc.remoteCache === server.text);
  check('write: the version moves on with the acknowledgement', t.doc.version === 6, String(t.doc.version));

  const count = t.sent.length;
  await t.vfs.replaceDocContent(DOC_URI, server.text);
  check('write: no change sends nothing, as the server drops the connection over it', t.sent.length === count);

  // someone else's edit arrives while ours is on its way
  server = { text: 'Base.\n', version: 1 };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  server.beforeAck = async () => {
    server.text = 'Base. Theirs.\n';
    server.version++;
    t.handlers.onFileChanged({ doc: 'doc1', v: 1, op: [{ p: 5, i: ' Theirs.' }] });
    server.beforeAck = undefined;
  };
  await t.vfs.replaceDocContent(DOC_URI, 'Ours. Base.\n').catch(() => {});
  check('concurrent edit: the stale cache is dropped', t.doc.remoteCache === undefined, JSON.stringify(t.doc.remoteCache));
  check('concurrent edit: the sync is told to look again', t.notified.some((e) => e.uri.path === '/Test/main.tex'));

  // the update may or may not have been applied
  server = { text: 'Base.\n', version: 1, fail: true };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  let thrown = false;
  await t.vfs.replaceDocContent(DOC_URI, 'Changed.\n').catch(() => { thrown = true; });
  check('failed send: the error is passed on', thrown);
  check('failed send: the cache is dropped so the next read asks the server', t.doc.remoteCache === undefined);
  server.fail = false;
  await t.vfs.replaceDocContent(DOC_URI, 'Changed.\n');
  check('failed send: the next write works from the server\'s text', server.text === 'Changed.\n', JSON.stringify(server.text));

  // out of step with the server
  server = { text: 'Base.\n', version: 7 };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  t.handlers.onFileChanged({ doc: 'doc1', v: 99, op: [{ p: 0, i: 'x' }] });
  check('out of step: the cache is dropped', t.doc.remoteCache === undefined);
  check('out of step: the sync is told to look again', t.notified.some((e) => e.uri.path === '/Test/main.tex'));

  // the server replies when it has queued an update, and acknowledges later
  server = { text: 'Base.\n', version: 3, ackLater: true };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  let finished = false;
  const writing = t.vfs.replaceDocContent(DOC_URI, 'Base one.\n').then(() => { finished = true; });
  await sleep(200);
  check('acknowledgement: a write waits for it', !finished);
  t.handlers.onFileChanged({ doc: 'doc1', v: 3 });
  await writing;
  check('acknowledgement: then the write is done', finished && t.doc.version === 4 && t.doc.remoteCache === 'Base one.\n', `${t.doc.version} ${JSON.stringify(t.doc.remoteCache)}`);
  const joinsBefore = t.sent.filter((s) => s === 'join').length;
  const nextWrite = t.vfs.replaceDocContent(DOC_URI, 'Base one two.\n');
  await sleep(50);
  check('acknowledgement: the next write uses the version it brought', t.sent[t.sent.length - 1].v === 4, JSON.stringify(t.sent[t.sent.length - 1]));
  t.handlers.onFileChanged({ doc: 'doc1', v: 4 });
  await nextWrite;
  check('acknowledgement: no reason to join the document again', t.sent.filter((s) => s === 'join').length === joinsBefore);

  server = { text: 'Base.\n', version: 3, ackLater: true };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  thrown = false;
  await t.vfs.replaceDocContent(DOC_URI, 'Never acknowledged.\n').catch(() => { thrown = true; });
  check('no acknowledgement: the write fails', thrown);
  check('no acknowledgement: the next read asks the server', t.doc.remoteCache === undefined);

  // what collaborators send: plain text, not the encoded lines of joinDoc
  const hashOf = (text) => require('crypto').createHash('sha1').update('blob ' + text.length + '\x00' + text).digest('hex');
  server = { text: 'one 中文Ã©–é end\n', version: 2 };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  t.handlers.onFileChanged({ doc: 'doc1', v: 2, op: [{ p: 3, d: ' 中文Ã©–é end' }] });
  check('receiving: a deletion of non-ASCII text removes exactly that text', t.doc.remoteCache === 'one\n', JSON.stringify(t.doc.remoteCache));
  t.handlers.onFileChanged({ doc: 'doc1', v: 3, op: [{ p: 3, i: ' 疫苗é' }], hash: hashOf('one 疫苗é\n') });
  check('receiving: an insertion arrives as it is, and its hash agrees', t.doc.remoteCache === 'one 疫苗é\n' && t.doc.version === 4, `${JSON.stringify(t.doc.remoteCache)} ${t.doc.version}`);
  t.handlers.onFileChanged({ doc: 'doc1', v: 4, op: [{ p: 0, i: 'x' }], hash: 'something else' });
  check('receiving: a hash that disagrees drops the cache', t.doc.remoteCache === undefined);

  server = { text: 'Commented text.\n', version: 2 };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  let commentEvents = 0;
  const listening = EventBus.on('commentsChangedEvent', () => { commentEvents++; });
  t.handlers.onFileChanged({ doc: 'doc1', v: 2, op: [{ c: 'Commented', p: 0, t: 'thread1' }] });
  check('receiving: a new comment leaves the text alone', t.doc.remoteCache === 'Commented text.\n' && t.doc.version === 3);
  check('receiving: a new comment is announced', commentEvents === 1, String(commentEvents));
  t.handlers.onCommentsChanged();
  check('receiving: so is a change to a thread', commentEvents === 2, String(commentEvents));
  listening.dispose();

  // marking where a comment is
  server = { text: 'Some 疫苗 text.\n', version: 2 };
  t = make(server);
  await t.vfs.addCommentRange(DOC_URI, 'thread1', '疫苗', 5);
  const lastSent = t.sent[t.sent.length - 1];
  check('comment place: only the mark is sent', lastSent.op.length === 1 && lastSent.op[0].c === '疫苗' && lastSent.op[0].p === 5 && lastSent.op[0].t === 'thread1' && lastSent.v === 2, JSON.stringify(lastSent));
  check('comment place: the text stays, and the version moves on', server.text === 'Some 疫苗 text.\n' && t.doc.remoteCache === server.text && t.doc.version === 3, `${JSON.stringify(t.doc.remoteCache)} ${t.doc.version}`);
  const sentBeforeRefusal = t.sent.length;
  thrown = false;
  await t.vfs.addCommentRange(DOC_URI, 'thread2', 'not in the text', 0).catch(() => { thrown = true; });
  check('comment place: text that is not there is refused here, as the server would drop the connection', thrown && t.sent.length === sentBeforeRefusal);

  // the sync and a comment can want to send at the same moment
  server = { text: 'Base.\n', version: 3, ackLater: true };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  const updates = () => t.sent.filter((s) => s !== 'join');
  const firstUpdate = t.vfs.replaceDocContent(DOC_URI, 'Base one.\n');
  await sleep(50);
  const secondUpdate = t.vfs.addCommentRange(DOC_URI, 'thread1', 'Base', 0);
  await sleep(100);
  check('in turn: an update waits while another is on its way', updates().length === 1, JSON.stringify(updates()));
  t.handlers.onFileChanged({ doc: 'doc1', v: 3 });
  await firstUpdate;
  await sleep(50);
  check('in turn: then it goes, with the version the first one brought', updates().length === 2 && updates()[1].v === 4, JSON.stringify(updates()));
  t.handlers.onFileChanged({ doc: 'doc1', v: 4 });
  await secondUpdate;

  server = { text: 'Base.\n', version: 3, fail: true };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  await t.vfs.replaceDocContent(DOC_URI, 'Fails.\n').catch(() => {});
  server.fail = false;
  await t.vfs.replaceDocContent(DOC_URI, 'Works.\n');
  check('in turn: a failed update does not hold up the next', server.text === 'Works.\n', JSON.stringify(server.text));

  // handlers survive a new socket, as overleaf.com refuses the first kind of connection
  let registered = 0, recreated = 0;
  const vfs = Object.create(VirtualFileSystem.prototype);
  vfs.socket = { needsReinit: false, init() { recreated++; this.needsReinit = false; }, updateEventHandlers: () => { registered++; } };
  vfs.prepareSocket();
  vfs.socket.needsReinit = true;
  vfs.prepareSocket();
  check('a new socket does not register the handlers a second time', registered === 1 && recreated === 1, `${registered} registered, ${recreated} recreated`);
}

// ---- the project living in overleaf/, next to other folders ----

async function testProjectFolder(LocalReplicaSCMProvider) {
  const root = workspaceRoot();
  const folder = path.join(root, 'overleaf-Test');
  const settings = path.join(folder, '.overleaf', 'settings.json');
  LocalReplicaSCMProvider.forgetProjectRoot();
  check('setup: no project yet', await LocalReplicaSCMProvider.readSettings() === undefined);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ uri: 'overleaf-workshop://www.overleaf.com/T?user=u&project=p', enableCompileNPreview: true }));
  LocalReplicaSCMProvider.forgetProjectRoot();
  const found = await LocalReplicaSCMProvider.readSettings();
  check('the project is found in its folder', found?.enableCompileNPreview === true, JSON.stringify(found));
  const inside = vscode.Uri.file(path.join(folder, 'sections', 'a.tex'));
  check('a file in the folder maps to its project path', await LocalReplicaSCMProvider.uriToPath(inside) === '/sections/a.tex', String(await LocalReplicaSCMProvider.uriToPath(inside)));
  const outside = vscode.Uri.file(path.join(root, 'zh', 'manuscript.md'));
  check('the Chinese manuscript is not part of the project', await LocalReplicaSCMProvider.uriToPath(outside) === undefined);
  const mapped = await LocalReplicaSCMProvider.pathToUri('/main.tex');
  check('a project path maps into the folder', mapped?.fsPath.toLowerCase() === path.join(folder, 'main.tex').toLowerCase(), mapped?.fsPath);

  fs.renameSync(folder, path.join(root, 'my renamed folder'));
  LocalReplicaSCMProvider.forgetProjectRoot();
  const renamed = await LocalReplicaSCMProvider.pathToUri('/main.tex');
  check('renaming the folder keeps the link', renamed?.fsPath.toLowerCase() === path.join(root, 'my renamed folder', 'main.tex').toLowerCase(), renamed?.fsPath);
  fs.rmSync(path.join(root, 'my renamed folder'), { recursive: true });
  LocalReplicaSCMProvider.forgetProjectRoot();

  check('a project name becomes a safe folder name', LocalReplicaSCMProvider.sanitizeProjectFolderName('A/B: 论文?') === 'A_B_ 论文_', LocalReplicaSCMProvider.sanitizeProjectFolderName('A/B: 论文?'));
}

// ---- comments ----

async function testComments({ ProjectComments, joinComments, locateQuote }) {
  // the shapes are what overleaf.com returned for a real comment
  const message = (content, overrides = {}) => ({ id: 'm', content, timestamp: 1793865710628, user_id: 'u', user: { id: 'u', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }, ...overrides });
  const docRange = (id, ...comments) => ({ id, ranges: { comments: comments.map(([t, c, p]) => ({ id: t, op: { c, p, t }, metadata: { user_id: 'u', ts: '2026-11-05T08:01:52.837Z' } })) } });
  const paths = new Map([['d1', 'main.tex'], ['d2', 'sections/a.tex']]);
  let joined = joinComments(
    [docRange('d2', ['t3', 'later', 9]), docRange('d1', ['t2', 'second', 20], ['t1', 'first', 5]), docRange('gone', ['t4', 'x', 0]), { id: 'd1', ranges: {} }],
    { t1: { messages: [message('这里要改')] }, t2: { messages: [message('ok')], resolved: true }, t3: { messages: [message('hi', { user: { id: 'u', email: 'only@example.com' } })] }, t4: { messages: [message('x')] } },
    paths,
  );
  check('join: comments are in document order, by file', joined.map((c) => c.threadId).join() === 't1,t2,t3', JSON.stringify(joined.map((c) => c.threadId)));
  check('join: what was said, by whom, and where', joined[0].path === 'main.tex' && joined[0].docId === 'd1' && joined[0].quote === 'first' && joined[0].offset === 5 && joined[0].messages[0].text === '这里要改' && joined[0].messages[0].author === 'Ada Lovelace', JSON.stringify(joined[0]));
  check('join: a resolved thread is marked', joined[1].resolved === true && joined[0].resolved === false);
  check('join: a person without a name shows as their email', joined[2].messages[0].author === 'only@example.com');
  joined = joinComments([docRange('d1', ['t1', 'x', 0])], { t1: { messages: [] } }, paths);
  check('join: a comment with nothing said yet is left out', joined.length === 0);
  joined = joinComments([docRange('d1', ['t1', 'x', 0])], {}, paths);
  check('join: so is one whose thread is gone', joined.length === 0);

  check('locate: where it was', locateQuote('a target b', 'target', 2) === 2);
  check('locate: moved later', locateQuote('xx a target b', 'target', 2) === 5);
  check('locate: moved earlier', locateQuote('target b', 'target', 4) === 0);
  check('locate: the nearest of several', locateQuote('target ......... target ...', 'target', 12) === 17 && locateQuote('target ...... target ...........', 'target', 3) === 0);
  check('locate: gone', locateQuote('nothing here', 'target', 2) === undefined);
  check('locate: a comment on deleted text stays where it was', locateQuote('short', '', 3) === 3 && locateQuote('short', '', 99) === 5);

  // the real class, with real files and editors
  const folder = path.join(workspaceRoot(), 'with comments');
  fs.mkdirSync(path.join(folder, 'sections'), { recursive: true });
  const main = path.join(folder, 'main.tex');
  const later = path.join(folder, 'sections', 'later.tex');
  const output = path.join(folder, '.output', 'comments.md');
  const put = (file, text) => fs.writeFileSync(file, text, 'utf8');
  const listing = () => (fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '');
  const comment = (threadId, quote, offset, overrides = {}) => ({ threadId, docId: 'doc-of-main', path: 'main.tex', quote, offset, resolved: false, messages: [{ author: 'Ada Lovelace', text: '这里要改', time: 1793865710628 }], ...overrides });
  const emitter = new vscode.EventEmitter();
  const source = {
    onDidChangeComments: emitter.event,
    comments: [],
    reads: 0,
    failing: false,
    async readComments() {
      this.reads++;
      if (this.failing) throw new Error('no connection');
      return this.comments;
    },
    changes: [],
    refuse: false,
    async setCommentResolved(target, resolved) {
      if (this.refuse) throw new Error('403: not allowed');
      this.changes.push({ threadId: target.threadId, docId: target.docId, resolved });
    },
    added: [],
    replies: [],
    async addComment(file, quote, offset, text) {
      if (this.refuse) throw new Error('403: not allowed');
      this.added.push({ file, quote, offset, text });
      return 'new-thread';
    },
    async addReply(target, text) {
      if (this.refuse) throw new Error('403: not allowed');
      this.replies.push({ threadId: target.threadId, text });
    },
  };
  const logged = [];
  put(main, 'first line\nb 疫苗 target here\n');
  source.comments = [comment('t1', 'target', 'first line\nb 疫苗 '.length)];
  let localChangesSent = 0;
  const comments = new ProjectComments(vscode.Uri.file(folder), 'My Paper', source, (m) => logged.push(m), async () => { localChangesSent++; });
  await comments.start();
  const thread = (id) => comments.shown.get(id)?.thread;
  const rangeIs = (id, startLine, startCharacter, endLine, endCharacter) => {
    const range = thread(id)?.range;
    return !!range && range.start.line === startLine && range.start.character === startCharacter && range.end.line === endLine && range.end.character === endCharacter;
  };
  const shownRange = (id) => JSON.stringify(thread(id)?.range);

  check('comments: shown on the commented text, counting Chinese as the editor does', rangeIs('t1', 1, 5, 1, 11), shownRange('t1'));
  check('comments: they can be replied to', thread('t1').canReply !== false);
  check('comments: collapsed, so they do not push the text apart', thread('t1').collapsibleState === vscode.CommentThreadCollapsibleState.Collapsed);
  check('comments: the thread shows who said what', thread('t1').comments.length === 1 && thread('t1').comments[0].author.name === 'Ada Lovelace' && thread('t1').comments[0].body === '这里要改');
  let text = listing();
  check('comments: a plain file names the project', text.includes('# Overleaf comments: My Paper'), text);
  check('comments: and gives the place, the text and the words', text.includes('### main.tex, line 2') && text.includes('> target') && text.includes('Ada Lovelace') && text.includes('这里要改'), text);
  check('comments: the file does not carry email addresses', !text.includes('@'), text);
  check('comments: the output folder stays out of git', fs.readFileSync(path.join(folder, '.output', '.gitignore'), 'utf8') === '*\n');

  // any tool editing the file
  const readsAtStart = source.reads;
  put(main, 'new line\nfirst line\nb 疫苗 target here\n');
  check('comments: an edit on the disk moves the comment', await until(() => rangeIs('t1', 2, 5, 2, 11)), shownRange('t1'));
  check('comments: and the plain file', await until(() => listing().includes('### main.tex, line 3')), listing());
  check('comments: following the text needs no request', source.reads === readsAtStart, String(source.reads));
  put(main, 'first line\r\nnew\r\nb 疫苗 target here\r\n');
  await until(() => rangeIs('t1', 2, 5, 2, 11));
  check('comments: a file with CRLF line endings counts the same', rangeIs('t1', 2, 5, 2, 11), shownRange('t1'));

  // typing that has not been saved
  put(main, 'first line\nb 疫苗 target here\n');
  await until(() => rangeIs('t1', 1, 5, 1, 11));
  const document = await vscode.workspace.openTextDocument(main);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), 'typed\n');
  await vscode.workspace.applyEdit(edit);
  check('comments: unsaved typing moves the comment', await until(() => rangeIs('t1', 2, 5, 2, 11)), shownRange('t1'));
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => {});
  const undo = new vscode.WorkspaceEdit();
  undo.delete(document.uri, new vscode.Range(0, 0, 1, 0));
  await vscode.workspace.applyEdit(undo);
  await document.save();
  await until(() => rangeIs('t1', 1, 5, 1, 11));

  // what only Overleaf knows
  const readsBefore = source.reads;
  source.comments = [comment('t1', 'tar', 'first line\nb 疫苗 '.length)];
  put(main, 'first line\nb 疫苗 tar here\n');
  check('comments: when the commented text changes, Overleaf is asked again', await until(() => source.reads > readsBefore, 12000), String(source.reads));
  check('comments: and what it says is shown', await until(() => rangeIs('t1', 1, 5, 1, 8)), shownRange('t1'));
  source.comments = [comment('t1', 'gone', 3)];
  emitter.fire();
  check('comments: if the text is not found the file says so', await until(() => listing().includes('near line 1 (the commented text has changed)')), listing());
  check('comments: and the comment stays near where it was', await until(() => rangeIs('t1', 0, 3, 0, 3)), shownRange('t1'));

  // changes on Overleaf
  source.comments = [
    comment('t1', 'tar', 'first line\nb 疫苗 '.length, { messages: [{ author: 'Ada Lovelace', text: 'one', time: 1 }, { author: 'Bob', text: 'two', time: 2 }] }),
    comment('t2', 'first', 0),
  ];
  emitter.fire();
  check('comments: a new comment appears', await until(() => !!thread('t2')));
  check('comments: a reply appears', await until(() => thread('t1')?.comments.length === 2 && thread('t1').comments[1].body === 'two'));
  source.comments = [comment('t1', 'tar', 'first line\nb 疫苗 '.length), comment('t2', 'first', 0, { resolved: true })];
  emitter.fire();
  check('comments: a resolved comment leaves the text', await until(() => !thread('t2')));
  check('comments: and is listed as resolved', await until(() => listing().includes('## Open (1)') && listing().includes('## Resolved (1)')), listing());
  source.comments = [comment('t1', 'tar', 'first line\nb 疫苗 '.length)];
  emitter.fire();
  check('comments: a deleted comment is gone', await until(() => listing().includes('## Resolved (0)')), listing());

  // a file that has not arrived yet
  source.comments = [comment('t3', 'arrives', 2, { path: 'sections/later.tex' })];
  emitter.fire();
  check('comments: a comment in a file not here yet is listed by its file', await until(() => listing().includes('### sections/later.tex\n')), listing());
  check('comments: but cannot be shown yet', !thread('t3'));
  put(later, 'x arrives\n');
  check('comments: it is shown when the file arrives', await until(() => rangeIs('t3', 0, 2, 0, 9)), shownRange('t3'));
  check('comments: the file is linked to the right path', thread('t3').uri.path.endsWith('/sections/later.tex'), thread('t3').uri.path);

  put(later, '\nx arrives\n');
  source.comments = [comment('t3', '', 0, { path: 'sections/later.tex' })];
  emitter.fire();
  check('comments: a comment at the very start of a file that begins with an empty line', await until(() => rangeIs('t3', 0, 0, 0, 0)), shownRange('t3'));

  // resolving here
  const errors = [];
  comments.showError = (m) => errors.push(m);
  source.comments = [comment('t1', 'tar', 'first line\nb 疫苗 '.length), comment('t2', 'first', 0)];
  emitter.fire();
  await until(() => !!thread('t1') && !!thread('t2'));
  const threadOne = thread('t1');
  await comments.resolve(threadOne);
  check('resolving: Overleaf is told which comment, in which document', source.changes.length === 1 && source.changes[0].threadId === 't1' && source.changes[0].docId === 'doc-of-main' && source.changes[0].resolved === true, JSON.stringify(source.changes));
  check('resolving: the comment leaves the text at once', !thread('t1') && !!thread('t2'));
  check('resolving: and is listed as resolved', listing().includes('## Open (1)') && listing().includes('## Resolved (1)'), listing());

  // Overleaf announces it too, and what it says then still holds
  source.comments = [comment('t1', 'tar', 'first line\nb 疫苗 '.length, { resolved: true }), comment('t2', 'first', 0)];
  emitter.fire();
  await sleep(SETTLE_MS);
  check('resolving: the announcement changes nothing more', !thread('t1') && !!thread('t2'));

  comments.pickComment = async (candidates) => {
    source.offered = candidates.map((c) => c.threadId);
    return candidates[0];
  };
  await comments.reopen();
  check('reopening: only resolved comments are offered', source.offered.join() === 't1', JSON.stringify(source.offered));
  check('reopening: Overleaf is told', source.changes.length === 2 && source.changes[1].threadId === 't1' && source.changes[1].resolved === false, JSON.stringify(source.changes));
  check('reopening: the comment is back on the text', !!thread('t1') && rangeIs('t1', 1, 5, 1, 8), shownRange('t1'));
  source.comments = [comment('t1', 'tar', 'first line\nb 疫苗 '.length), comment('t2', 'first', 0)];
  emitter.fire();
  await until(() => listing().includes('## Resolved (0)'));

  comments.pickComment = async () => undefined;
  const changesBefore = source.changes.length;
  await comments.reopen();
  check('reopening: closing the list changes nothing', source.changes.length === changesBefore);

  source.refuse = true;
  await comments.resolve(thread('t2'));
  check('refused: the comment stays', !!thread('t2'));
  check('refused: and the user is told why', errors.length === 1 && errors[0].includes('403'), JSON.stringify(errors));
  source.refuse = false;

  // replying here
  const repliedReads = source.reads;
  await comments.submit({ thread: thread('t2'), text: '  同意  ' });
  check('replying: Overleaf is told which comment, and the words without stray spaces', source.replies.length === 1 && source.replies[0].threadId === 't2' && source.replies[0].text === '同意', JSON.stringify(source.replies));
  check('replying: the thread is read again, to show the reply', source.reads > repliedReads);
  await comments.submit({ thread: thread('t2'), text: '   ' });
  check('replying: nothing written, nothing sent', source.replies.length === 1);
  errors.length = 0;
  source.refuse = true;
  await comments.submit({ thread: thread('t2'), text: 'no' });
  source.refuse = false;
  check('replying: a refusal is explained', errors.length === 1 && errors[0].includes('403'), JSON.stringify(errors));

  // adding here, the way VS Code offers it: an empty thread on a place, with a box
  const provider = comments.controller.commentingRangeProvider;
  const token = new vscode.CancellationTokenSource().token;
  const opened = await vscode.workspace.openTextDocument(main);
  const offered = provider.provideCommentingRanges(opened, token);
  check('adding: a project file can be commented on as a whole', offered.length === 1 && offered[0].start.line === 0 && offered[0].end.line === opened.lineCount - 1, JSON.stringify(offered));
  check('adding: the comments file cannot', provider.provideCommentingRanges(await vscode.workspace.openTextDocument(output), token).length === 0);
  const outsideFile = path.join(workspaceRoot(), 'outside.tex');
  put(outsideFile, 'outside\n');
  check('adding: a file outside the project cannot', provider.provideCommentingRanges(await vscode.workspace.openTextDocument(outsideFile), token).length === 0);
  fs.rmSync(outsideFile, { force: true });

  const documentShows = (text) => until(async () => (await vscode.workspace.openTextDocument(main)).getText().replace(/\r\n/g, '\n') === text);
  const newThread = (...range) => comments.controller.createCommentThread(vscode.Uri.file(main), new vscode.Range(...range), []);
  const lastAdded = () => source.added[source.added.length - 1];
  put(main, 'first line\r\nb 疫苗 tar here\r\n\r\nlast\r\n');
  await documentShows('first line\nb 疫苗 tar here\n\nlast\n');

  const sentBefore = localChangesSent;
  let box = newThread(1, 2, 1, 4);
  source.comments = [comment('new-thread', '疫苗', 'first line\nb '.length)];
  await comments.submit({ thread: box, text: ' 看这里 ' });
  check('adding: the selected text, counted without CRLF, and the words', lastAdded()?.file === 'main.tex' && lastAdded()?.quote === '疫苗' && lastAdded()?.offset === 'first line\nb '.length && lastAdded()?.text === '看这里', JSON.stringify(lastAdded()));
  check('adding: local changes go first, as the place is on the server\'s text', localChangesSent === sentBefore + 1);
  check('adding: the box becomes the comment', thread('new-thread') === box && box.comments.length === 1 && box.comments[0].body === '这里要改');
  check('adding: and sits on the text', rangeIs('new-thread', 1, 2, 1, 4), shownRange('new-thread'));
  check('adding: it has the same label as any other', box.label === 'Overleaf 批注', box.label);

  box = newThread(0, 6, 1, 1);
  await comments.submit({ thread: box, text: 'two lines' });
  check('adding: a selection over lines keeps LF', lastAdded().quote === 'line\nb' && lastAdded().offset === 6, JSON.stringify(lastAdded()));
  box.dispose();

  box = newThread(1, 0, 1, 0);
  await comments.submit({ thread: box, text: 'whole line' });
  check('adding: a click in the margin comments on the line', lastAdded().quote === 'b 疫苗 tar here' && lastAdded().offset === 'first line\n'.length, JSON.stringify(lastAdded()));
  box.dispose();

  errors.length = 0;
  let addedBefore = source.added.length;
  box = newThread(2, 0, 2, 0);
  await comments.submit({ thread: box, text: 'empty line' });
  check('adding: an empty line has nothing to comment on', source.added.length === addedBefore && errors.length === 1 && errors[0].includes('没有文字'), JSON.stringify(errors));
  check('adding: and the box stays', box.comments.length === 0);
  box.dispose();

  errors.length = 0;
  source.refuse = true;
  box = newThread(3, 0, 3, 4);
  await comments.submit({ thread: box, text: 'refused' });
  source.refuse = false;
  check('adding: a refusal is explained', errors.length === 1 && errors[0].includes('403'), JSON.stringify(errors));
  box.dispose();

  addedBefore = source.added.length;
  box = newThread(3, 0, 3, 4);
  await comments.submit({ thread: box, text: '   ' });
  check('adding: nothing written, nothing sent', source.added.length === addedBefore);
  box.dispose();

  source.comments = [comment('t3', '', 0, { path: 'sections/later.tex' })];
  emitter.fire();
  await until(() => !!thread('t3') && !thread('new-thread'));

  // no connection
  source.failing = true;
  emitter.fire();
  await until(() => logged.some((m) => m.includes('no connection')));
  check('comments: a failed read is recorded', logged.some((m) => m.includes('Could not read the comments: no connection')), JSON.stringify(logged));
  check('comments: and what is showing stays', !!thread('t3'));
  source.failing = false;

  comments.dispose();
  const finalText = listing();
  put(later, 'y\nx arrives\n');
  source.comments = [];
  emitter.fire();
  await sleep(SETTLE_MS);
  check('comments: nothing is written after stopping', listing() === finalText);
  emitter.dispose();
  fs.rmSync(folder, { recursive: true, force: true });
}

// ---- working next to LaTeX Workshop ----

async function testLatexWorkshop(FolderSyncManager) {
  const AUTO_BUILD = ['latex-workshop.latex.autoBuild', 'run'];
  const ALT_KEYMAP = ['latex-workshop.bind.altKeymap', 'enabled'];
  const inWorkspace = ([section, key]) => vscode.workspace.getConfiguration(section).inspect(key)?.workspaceValue;
  const setInWorkspace = ([section, key], value) => vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Workspace);
  const manager = new FolderSyncManager({});

  check('setup: the stand-in for LaTeX Workshop is loaded', !!vscode.extensions.getExtension('James-Yu.latex-workshop'));
  await manager.leaveCompilingToOverleaf();
  check('LaTeX Workshop stops building on every change', inWorkspace(AUTO_BUILD) === 'never', String(inWorkspace(AUTO_BUILD)));
  check('LaTeX Workshop gives up the compile shortcuts', inWorkspace(ALT_KEYMAP) === true, String(inWorkspace(ALT_KEYMAP)));

  await setInWorkspace(AUTO_BUILD, 'onSave');
  await setInWorkspace(ALT_KEYMAP, false);
  await manager.leaveCompilingToOverleaf();
  check('a choice already made in this workspace is kept', inWorkspace(AUTO_BUILD) === 'onSave' && inWorkspace(ALT_KEYMAP) === false, `${inWorkspace(AUTO_BUILD)} ${inWorkspace(ALT_KEYMAP)}`);

  await setInWorkspace(AUTO_BUILD, undefined);
  await setInWorkspace(ALT_KEYMAP, undefined);
}

// ---- linking a project, from any kind of window ----

async function testLinking(FolderSyncManager, LocalReplicaSCMProvider) {
  const root = workspaceRoot();
  const PROJECT = 'overleaf-workshop://www.overleaf.com/My%20Test?user=u&project=p';
  const item = { uri: PROJECT, label: 'My Test' };
  const projectUri = vscode.Uri.parse(PROJECT).toString();
  const FOLDER = 'overleaf-My Test';
  const make = (overrides = {}) => {
    const seen = { started: [], opened: [], picked: 0, confirmed: [] };
    const manager = new FolderSyncManager({});
    Object.assign(manager, {
      start: async (folder, uri) => { seen.started.push({ folder: folder.fsPath, uri: uri.toString() }); },
      openFolder: async (folder) => { seen.opened.push(folder.fsPath); },
      pickParentFolder: async () => { seen.picked++; return undefined; },
      confirmLink: async (name, folder) => { seen.confirmed.push(folder.fsPath); return true; },
    }, overrides);
    return { manager, seen };
  };
  const settingsIn = (parent, name = FOLDER) => path.join(parent, name, '.overleaf', 'settings.json');
  const same = (a, b) => a?.toLowerCase() === b.toLowerCase();
  const namesIn = (folder) => fs.readdirSync(folder);

  // a window with a local folder: sync right here, in a folder named after the project
  let { manager, seen } = make();
  await manager.linkProject(item);
  check('in a local folder: the project gets a folder named after it', seen.picked === 0 && seen.started.length === 1 && same(seen.started[0].folder, path.join(root, FOLDER)), JSON.stringify(seen));
  check('the confirmation shows that folder', same(seen.confirmed[0], path.join(root, FOLDER)), JSON.stringify(seen.confirmed));
  check('in a local folder: the window stays', seen.opened.length === 0);
  check('in a local folder: the link is written', fs.existsSync(settingsIn(root)));
  const written = JSON.parse(fs.readFileSync(settingsIn(root), 'utf8'));
  check('the link can compile and preview', written.enableCompileNPreview === true);
  check('the link names the project', vscode.Uri.parse(written.uri).toString() === projectUri, written.uri);
  check('compiling finds the new link at once', (await LocalReplicaSCMProvider.readSettings())?.projectName === 'My Test');

  // the case that went wrong: a window showing an online project
  const parent = path.join(root, 'chosen-parent');
  fs.mkdirSync(parent, { recursive: true });
  ({ manager, seen } = make({ workspaceFolder: () => undefined, pickParentFolder: async () => vscode.Uri.file(parent) }));
  await manager.linkProject(item);
  check('with no local folder: the project goes in the chosen folder', fs.existsSync(settingsIn(parent)));
  check('with no local folder: the window opens that folder', seen.opened.length === 1 && same(seen.opened[0], parent), JSON.stringify(seen.opened));
  check('with no local folder: syncing waits for the reload', seen.started.length === 0);

  // changing one's mind
  const untouched = path.join(root, 'untouched');
  fs.mkdirSync(untouched, { recursive: true });
  ({ manager, seen } = make({ workspaceFolder: () => undefined }));
  await manager.linkProject(item);
  check('cancelling the folder choice does nothing', seen.opened.length === 0 && seen.started.length === 0 && seen.confirmed.length === 0);
  ({ manager, seen } = make({ workspaceFolder: () => undefined, pickParentFolder: async () => vscode.Uri.file(untouched), confirmLink: async () => false }));
  await manager.linkProject(item);
  check('declining the confirmation creates nothing', seen.opened.length === 0 && namesIn(untouched).length === 0, JSON.stringify(namesIn(untouched)));

  // a folder already linked
  const content = fs.readFileSync(settingsIn(root), 'utf8');
  ({ manager, seen } = make());
  await manager.linkProject({ uri: 'overleaf-workshop://www.overleaf.com/Other?user=u&project=other', label: 'Other' });
  check('a second project in the same folder is refused', seen.started.length === 0 && seen.confirmed.length === 0 && !fs.existsSync(settingsIn(root, 'overleaf-Other')));
  ({ manager, seen } = make());
  await manager.linkProject(item);
  check('linking the same project again just syncs', seen.started.length === 1 && fs.readFileSync(settingsIn(root), 'utf8') === content);
  fs.renameSync(path.join(root, FOLDER), path.join(root, 'renamed'));
  ({ manager, seen } = make());
  await manager.linkProject({ uri: 'overleaf-workshop://www.overleaf.com/Renamed%20Online?user=u&project=p', label: 'Renamed Online' });
  check('the same project under a new name keeps its folder', seen.started.length === 1 && same(seen.started[0].folder, path.join(root, 'renamed')) && !fs.existsSync(path.join(root, 'overleaf-Renamed Online')), JSON.stringify(seen.started));

  // reopening the folder later
  ({ manager, seen } = make());
  await manager.resume();
  check('reopening a linked folder resumes syncing', seen.started.length === 1 && seen.started[0].uri === projectUri && same(seen.started[0].folder, path.join(root, 'renamed')), JSON.stringify(seen.started));
  fs.rmSync(path.join(root, 'renamed'), { recursive: true });
  ({ manager, seen } = make());
  await manager.resume();
  check('a folder with no link does not sync', seen.started.length === 0);

  // a replica of the original extension's kind, in the root of the folder, is left alone
  fs.mkdirSync(path.join(root, '.overleaf'), { recursive: true });
  fs.writeFileSync(path.join(root, '.overleaf', 'settings.json'), JSON.stringify({ uri: PROJECT }));
  LocalReplicaSCMProvider.forgetProjectRoot();
  check('setup: a replica in the root is found', !!(await LocalReplicaSCMProvider.readSettings()));
  ({ manager, seen } = make());
  await manager.resume();
  check('a replica in the root is not synced by this engine', seen.started.length === 0);
  fs.rmSync(path.join(root, '.overleaf'), { recursive: true });
  LocalReplicaSCMProvider.forgetProjectRoot();
}

exports.run = async function () {
  try {
    await testProjectFolder(require(path.join(out, 'scm', 'localReplicaSCM.js')).LocalReplicaSCMProvider);
    await testLinking(require(path.join(out, 'sync', 'index.js')).FolderSyncManager, require(path.join(out, 'scm', 'localReplicaSCM.js')).LocalReplicaSCMProvider);
    await testLatexWorkshop(require(path.join(out, 'sync', 'index.js')).FolderSyncManager);
    const merge = require(path.join(out, 'sync', 'merge.js'));
    const { FolderSync } = require(path.join(out, 'sync', 'folderSync.js'));
    const { VirtualFileSystem } = require(path.join(out, 'core', 'remoteFileSystemProvider.js'));
    const { GlobalStateManager } = require(path.join(out, 'utils', 'globalStateManager.js'));
    testMerge(merge);
    await testReplaceDocContent(VirtualFileSystem, GlobalStateManager);
    await testComments(require(path.join(out, 'sync', 'comments.js')));
    await testSync(FolderSync);
  } catch (e) {
    results.push(`ERROR ${e && e.stack}`);
  } finally {
    fs.writeFileSync(path.join(here, 'results.txt'), results.join('\n') + '\n', 'utf8');
  }
};

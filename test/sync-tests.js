// Runs inside an isolated VS Code, with a real disk, file watcher and editors, and a fake Overleaf.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const here = process.env.OVERLEAF_AI_TEST_DIR;
const out = path.join(__dirname, '..', 'out');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  fs.appendFileSync(path.join(here, 'progress.txt'), `${results[results.length - 1]}\n`); // to show where a run got stuck
};
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
    this.renames = [];
    this.fileReads = 0;
    this.failWrites = false;
    this.folders = new Set();
    this.foldersCreated = [];
    this.foldersRemoved = [];
    this.changed = new vscode.EventEmitter();
    this.connected = new vscode.EventEmitter();
    this.disconnected = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.onDidConnect = this.connected.event;
    this.onDidDisconnect = this.disconnected.event;
  }
  async list() {
    return [
      ...[...this.docs.keys()].map((p) => ({ path: p, kind: 'doc', version: `doc:${this.moved?.get(p) ?? p}` })),
      ...[...this.files].map(([p, f]) => ({ path: p, kind: 'file', version: `${p}:${f.version}` })),
    ];
  }
  async listFolders() {
    // As on Overleaf, a folder stays after its files have gone.
    for (const p of [...this.docs.keys(), ...this.files.keys()]) {
      const parts = p.split('/');
      for (let depth = 1; depth < parts.length; depth++) this.folders.add(parts.slice(0, depth).join('/'));
    }
    return [...this.folders];
  }
  async createFolder(p) {
    if (this.failWrites || this.refusedFolder === p) throw new Error('offline');
    this.foldersCreated.push(p);
    this.folders.add(p);
  }
  async removeFolder(p) {
    if (this.failWrites) throw new Error('offline');
    this.foldersRemoved.push(p);
    this.folders.delete(p);
  }
  // what a collaborator does to folders
  addFolderOnline(p) { this.folders.add(p); this.changed.fire(undefined); }
  removeFolderOnline(p) {
    for (const each of [...this.folders]) { if (each === p || each.startsWith(`${p}/`)) this.folders.delete(each); }
    for (const store of [this.docs, this.files]) {
      for (const each of [...store.keys()]) { if (each.startsWith(`${p}/`)) store.delete(each); }
    }
    this.changed.fire(undefined);
  }
  /** A move online keeps the file's identity, which a fake version number has to say explicitly. */
  moveOnline(from, to) {
    this.moved = this.moved ?? new Map();
    this.moved.set(to, this.moved.get(from) ?? from);
    this.moved.delete(from);
    for (const store of [this.docs, this.files]) {
      if (store.has(from)) { store.set(to, store.get(from)); store.delete(from); }
    }
    this.changed.fire(undefined);
  }
  async readDoc(p) {
    const text = this.docs.get(p);
    const afterRead = this.afterRead;
    this.afterRead = undefined;
    if (afterRead) await afterRead(p); // something happening between reading the text and acting on it
    return text;
  }
  async readFile(p) { this.fileReads++; return new Uint8Array(this.files.get(p).content); }
  async writeDoc(p, text, basedOn) {
    if (this.failWrites) throw new Error('offline');
    if (basedOn !== undefined && this.docs.get(p) !== basedOn) return false;
    this.writes.push({ path: p, text });
    this.docs.set(p, text);
    return true;
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
  async remove(p) {
    // On the real thing this takes a moment, and what it says about the file tree makes the engine look at everything.
    if (this.removeDelayMs) { this.changed.fire(undefined); await sleep(this.removeDelayMs); }
    this.removed.push(p);
    this.docs.delete(p);
    this.files.delete(p);
  }
  async rename(from, to) {
    if (this.failWrites) throw new Error('offline');
    if (this.renameDelayMs) await sleep(this.renameDelayMs);
    this.renames.push({ from, to });
    for (const store of [this.docs, this.files]) {
      if (store.has(from)) { store.set(to, store.get(from)); store.delete(from); }
    }
  }
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

  // an edit that arrived after the caller read the text
  server = { text: 'Base.\n', version: 3 };
  t = make(server);
  await t.vfs.openFile(DOC_URI);
  let sentCount = t.sent.length;
  check('based on: the text it was based on is still there, so it is sent', await t.vfs.replaceDocContent(DOC_URI, 'Base one.\n', 'Base.\n') === true && server.text === 'Base one.\n' && t.sent.length === sentCount + 1);
  sentCount = t.sent.length;
  check('based on: if the text has moved on, nothing is sent', await t.vfs.replaceDocContent(DOC_URI, 'Other.\n', 'Base.\n') === false && server.text === 'Base one.\n' && t.sent.length === sentCount, JSON.stringify(server.text));

  // files
  server = { text: 'Base.\n', version: 3 };
  t = make(server);
  const fileUri = ORIGIN.with({ path: '/Test/figure.png' });
  const rootFolder = t.vfs.root.rootFolder[0];
  rootFolder.fileRefs.push({ _id: 'old-file', name: 'figure.png' });
  t.vfs.api = { uploadFile: async () => ({ type: 'error', message: '422: too big' }) };
  let refused;
  await t.vfs.createFile(fileUri, new Uint8Array([1]), true).catch((e) => { refused = e; });
  check('uploading: a refusal is an error for the caller, not a quiet nothing', refused?.message === '422: too big', String(refused));
  check('uploading: and the old file stays listed', rootFolder.fileRefs.length === 1 && rootFolder.fileRefs[0]._id === 'old-file');
  t.vfs.api = { uploadFile: async () => ({ type: 'success', entity: { _id: 'new-file', _type: 'file', name: 'figure.png' } }) };
  await t.vfs.createFile(fileUri, new Uint8Array([1]), true);
  check('uploading: a replaced file is listed once, under its new id', rootFolder.fileRefs.length === 1 && rootFolder.fileRefs[0]._id === 'new-file', JSON.stringify(rootFolder.fileRefs));
  t.handlers.onFileCreated('root', 'file', { _id: 'new-file', name: 'figure.png' });
  check('uploading: and the server announcing it changes nothing', rootFolder.fileRefs.length === 1, JSON.stringify(rootFolder.fileRefs));

  // folders on Overleaf
  server = { text: 'Base.\n', version: 3 };
  t = make(server);
  const projectRoot = t.vfs.root.rootFolder[0];
  projectRoot.folders.push({ _id: 'folder1', name: 'sections', docs: [{ _id: 'doc2', name: 'a.tex' }], fileRefs: [], folders: [] });
  const found = t.vfs._resolveById('folder1');
  check('folders: a folder is found with its parent', found.parentFolder === projectRoot && found.fileType === 'folder' && found.fileEntity.name === 'sections', JSON.stringify(found.path));
  projectRoot.folders.push({ _id: 'folder2', name: 'target', docs: [], fileRefs: [], folders: [] });
  t.handlers.onFileMoved('doc2', 'folder2');
  const target = projectRoot.folders.find((f) => f._id === 'folder2');
  check('moves: a file moves to the other folder', target.docs.length === 1 && t.vfs._resolveById('doc2').parentFolder === target);
  t.handlers.onFileMoved('doc2', 'folder2');
  check('moves: and stays there when the server announces a move already applied', target.docs.length === 1, JSON.stringify(target.docs));
  t.handlers.onFileRemoved('folder1');
  check('folders: deleted online, it leaves the list', !projectRoot.folders.some((f) => f._id === 'folder1'), JSON.stringify(projectRoot.folders));

  const { VfsRemoteSide } = require(path.join(out, 'sync', 'vfsRemoteSide.js'));
  const quiet = () => ({ dispose() {} });
  const side = new VfsRemoteSide({ pathToUri: () => DOC_URI, openFile: async () => new TextEncoder().encode('\uFEFFwith a mark\n') }, { onDidChangeFile: quiet });
  check('a byte order mark online is read as it is, as writes state the text they were based on', await side.readDoc('main.tex') === '\uFEFFwith a mark\n', JSON.stringify(await side.readDoc('main.tex')));
  side.dispose();

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
  check('join: what was said, by whom, and where', joined[0].path === 'main.tex' && joined[0].docId === 'd1' && joined[0].quote === 'first' && joined[0].offset === 5 && joined[0].messages[0].text === '这里要改' && joined[0].messages[0].author === 'Ada Lovelace' && joined[0].messages[0].id === 'm' && joined[0].messages[0].authorId === 'u', JSON.stringify(joined[0]));
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
  // Behaves like a small Overleaf: what it is told shows in what it answers. A read answers with what it had when asked.
  const source = {
    onDidChangeComments: emitter.event,
    comments: [],
    reads: 0,
    failing: false,
    refuse: false,
    listNewComments: true,
    nextId: 100,
    changes: [],
    added: [],
    replies: [],
    edits: [],
    deletedMessages: [],
    deletedComments: [],
    sentOrder: [],
    async currentUser() { return { id: 'me', name: '我自己' }; },
    async readComments() {
      this.reads++;
      if (this.failing) throw new Error('no connection');
      const answer = JSON.parse(JSON.stringify(this.comments));
      if (this.holdRead) await this.holdRead;
      return answer;
    },
    async gate(name) {
      if (this.hold) await this.hold;
      if (this.refuse) throw new Error('403: not allowed');
      this.sentOrder.push(name);
    },
    listed(threadId) { return this.comments.find((c) => c.threadId === threadId); },
    newMessage(text) { return { id: `m${this.nextId++}`, authorId: 'me', author: '我自己', text, time: 1793865710628 }; },
    async setCommentResolved(target, resolved) {
      await this.gate('resolve');
      this.changes.push({ threadId: target.threadId, docId: target.docId, resolved });
      const listed = this.listed(target.threadId);
      if (listed) listed.resolved = resolved;
    },
    async addComment(threadId, file, quote, offset, text) {
      await this.gate('add');
      this.added.push({ threadId, file, quote, offset, text });
      if (this.listNewComments) this.comments.push({ threadId, docId: 'doc-of-main', path: file, quote, offset, resolved: false, messages: [this.newMessage(text)] });
      return 'doc-of-main';
    },
    async addReply(target, text) {
      await this.gate('reply');
      this.replies.push({ threadId: target.threadId, text });
      this.listed(target.threadId)?.messages.push(this.newMessage(text));
    },
    async editMessage(target, messageId, text) {
      await this.gate('edit');
      this.edits.push({ threadId: target.threadId, messageId, text });
      const message = this.listed(target.threadId)?.messages.find((m) => m.id === messageId);
      if (message) message.text = text;
    },
    async deleteMessage(target, messageId) {
      await this.gate('deleteMessage');
      this.deletedMessages.push({ threadId: target.threadId, messageId });
      const listed = this.listed(target.threadId);
      if (listed) listed.messages = listed.messages.filter((m) => m.id !== messageId);
    },
    async deleteComment(target) {
      await this.gate('deleteComment');
      this.deletedComments.push({ threadId: target.threadId, docId: target.docId });
      this.comments = this.comments.filter((c) => c.threadId !== target.threadId);
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

  // ---- what the user does shows at once, and is sent afterwards ----
  const errors = [];
  const retries = [];
  comments.showError = (m, retry) => { errors.push(m); retries.push(retry); };
  const clearErrors = () => { errors.length = 0; retries.length = 0; };
  let release = () => {};
  const hold = () => { source.hold = new Promise((resolve) => { release = () => { source.hold = undefined; resolve(); }; }); };
  const firstOfT = (id) => source.comments.find((c) => c.threadId === id);
  const bodies = (id) => thread(id)?.comments.map((c) => c.body);
  const mine = (id, text) => ({ id, authorId: 'me', author: '我自己', text, time: 1793865710628 });
  const theirs = (id, text) => ({ id, authorId: 'them', author: 'Bob', text, time: 1793865710628 });
  const tarOffset = 'first line\nb 疫苗 '.length;
  const refreshed = async () => {
    const before = source.reads;
    emitter.fire();
    await until(() => source.reads > before);
    await sleep(100);
  };
  source.comments = [
    comment('t1', 'tar', tarOffset, { messages: [mine('m1', 'one')] }),
    comment('t2', 'first', 0, { messages: [theirs('m2', 'two')] }),
  ];
  await refreshed();
  check('setup: two comments are showing', !!thread('t1') && !!thread('t2'));

  // resolving
  const resolveAsked = [];
  let resolveAnswer = false;
  comments.confirmResolve = async () => { resolveAsked.push(thread('t1') ? 't1' : 'gone'); return resolveAnswer; };
  await comments.resolve(thread('t1'));
  check('resolving: it asks first, as the comment leaves the text', resolveAsked.length === 1);
  check('resolving: saying no changes nothing', !!thread('t1') && source.changes.length === 0);
  resolveAnswer = true;
  hold();
  await comments.resolve(thread('t1'));
  check('resolving: the comment leaves the text at once, while the server has not answered', !thread('t1') && !!thread('t2') && source.changes.length === 0, JSON.stringify(source.changes));
  check('resolving: the plain file follows', await until(() => listing().includes('## Open (1)') && listing().includes('## Resolved (1)')), listing());
  release();
  await comments.whenSent();
  check('resolving: then Overleaf is told which comment, in which document', source.changes.length === 1 && source.changes[0].threadId === 't1' && source.changes[0].docId === 'doc-of-main' && source.changes[0].resolved === true, JSON.stringify(source.changes));
  await refreshed();
  check('resolving: what Overleaf says afterwards changes nothing more', !thread('t1') && !!thread('t2'));

  // reopening
  comments.pickComment = async (candidates) => {
    source.offered = candidates.map((c) => c.threadId);
    return candidates[0];
  };
  hold();
  await comments.reopen();
  check('reopening: only resolved comments are offered', source.offered.join() === 't1', JSON.stringify(source.offered));
  check('reopening: the comment is back on the text at once', !!thread('t1') && rangeIs('t1', 1, 5, 1, 8) && source.changes.length === 1, shownRange('t1'));
  release();
  await comments.whenSent();
  check('reopening: then Overleaf is told', source.changes.length === 2 && source.changes[1].threadId === 't1' && source.changes[1].resolved === false, JSON.stringify(source.changes));
  comments.pickComment = async () => undefined;
  await refreshed();
  firstOfT('t1').resolved = true;
  await refreshed();
  await comments.reopen();
  await comments.whenSent();
  check('reopening: closing the list changes nothing', source.changes.length === 2 && !thread('t1'));
  firstOfT('t1').resolved = false;
  await refreshed();

  // what Overleaf said before a change must not undo it
  let answerHeld;
  source.holdRead = new Promise((resolve) => { answerHeld = resolve; });
  let reads = source.reads;
  emitter.fire();
  await until(() => source.reads > reads);
  await comments.resolve(thread('t1'));
  await comments.whenSent();
  answerHeld();
  source.holdRead = undefined;
  await sleep(200);
  check('a slow read: an answer from before a change does not undo it', !thread('t1'));
  check('a slow read: and the comments are read again', await until(() => source.reads > reads + 1), String(source.reads));

  // a read while something is being sent would not include it
  firstOfT('t1').resolved = false;
  await refreshed();
  hold();
  await comments.resolve(thread('t1'));
  reads = source.reads;
  emitter.fire();
  await sleep(800);
  check('while sending: comments are not read', source.reads === reads, `${source.reads} ${reads}`);
  check('while sending: and the change stays', !thread('t1'));
  release();
  await comments.whenSent();
  check('after sending: comments are read', await until(() => source.reads > reads), String(source.reads));
  firstOfT('t1').resolved = false;
  await refreshed();

  // Overleaf refusing
  clearErrors();
  source.refuse = true;
  await comments.resolve(thread('t1'));
  check('refused: at first the comment leaves', !thread('t1'));
  await comments.whenSent();
  check('refused: then it comes back', !!thread('t1'));
  check('refused: and the user is told why, with a way to try again', errors.length === 1 && errors[0].includes('403') && typeof retries[0] === 'function', JSON.stringify(errors));
  source.refuse = false;
  retries[0]();
  check('refused: trying again shows it at once', !thread('t1'));
  await comments.whenSent();
  check('refused: and goes through', firstOfT('t1').resolved === true);
  firstOfT('t1').resolved = false;
  await refreshed();

  // ---- replying ----
  hold();
  await comments.submit({ thread: thread('t2'), text: '  同意  ' });
  check('replying: the button returns while the server has not answered, so the box clears at once', source.replies.length === 0);
  check('replying: the reply shows at once, without stray spaces', bodies('t2').join() === 'two,同意', JSON.stringify(bodies('t2')));
  check('replying: under the user\'s own name', thread('t2').comments[1].author.name === '我自己', thread('t2').comments[1].author.name);
  check('replying: it cannot be edited until Overleaf has given it an id', thread('t2').comments[1].contextValue === undefined);
  release();
  await comments.whenSent();
  check('replying: then Overleaf is told', source.replies.length === 1 && source.replies[0].threadId === 't2' && source.replies[0].text === '同意', JSON.stringify(source.replies));
  check('replying: and when it is listed it can be edited', await until(() => thread('t2').comments[1]?.contextValue === 'mine'), String(thread('t2').comments[1]?.contextValue));
  check('replying: someone else\'s comment cannot', thread('t2').comments[0].contextValue === undefined);
  const repliesBefore = source.replies.length;
  await comments.submit({ thread: thread('t2'), text: '   ' });
  check('replying: nothing written, nothing sent', source.replies.length === repliesBefore && bodies('t2').length === 2);
  clearErrors();
  source.refuse = true;
  await comments.submit({ thread: thread('t2'), text: '发不出去' });
  check('replying refused: at first it shows', bodies('t2').includes('发不出去'));
  await comments.whenSent();
  check('replying refused: then it is gone', !bodies('t2').includes('发不出去'));
  check('replying refused: and what was written is in the message', errors.length === 1 && errors[0].includes('发不出去') && errors[0].includes('403'), JSON.stringify(errors));
  source.refuse = false;
  await refreshed();

  // ---- editing ----
  const myReply = () => thread('t2').comments.find((c) => c.messageId === source.comments.find((s) => s.threadId === 't2').messages[1].id);
  let target = myReply();
  comments.startEditing(target);
  check('editing: the comment turns into a box', myReply().mode === vscode.CommentMode.Editing);
  firstOfT('t2').messages[0].text = 'two, changed by Bob';
  await refreshed();
  check('editing: news from Overleaf does not take the box away', thread('t2').comments.includes(target) && target.mode === vscode.CommentMode.Editing);
  target.body = '改过的';
  hold();
  comments.saveEditing(target);
  check('editing: the new words show at once, while the server has not answered', bodies('t2')[1] === '改过的' && thread('t2').comments[1].mode === vscode.CommentMode.Preview && source.edits.length === 0, JSON.stringify(bodies('t2')));
  check('editing: and what came meanwhile too', bodies('t2')[0] === 'two, changed by Bob', JSON.stringify(bodies('t2')));
  check('editing: the plain file follows', await until(() => listing().includes('改过的')), listing());
  release();
  await comments.whenSent();
  check('editing: then Overleaf is told', source.edits.length === 1 && source.edits[0].threadId === 't2' && source.edits[0].text === '改过的' && source.edits[0].messageId === target.messageId, JSON.stringify(source.edits));
  await refreshed();

  target = myReply();
  comments.startEditing(target);
  target.body = '不要了';
  comments.cancelEditing(target);
  check('editing: cancelling brings back the words', bodies('t2')[1] === '改过的' && thread('t2').comments[1].mode === vscode.CommentMode.Preview, JSON.stringify(bodies('t2')));
  target = myReply();
  comments.startEditing(target);
  comments.saveEditing(target);
  target = myReply();
  comments.startEditing(target);
  target.body = '   ';
  comments.saveEditing(target);
  await comments.whenSent();
  check('editing: saving the same words, or none, sends nothing', source.edits.length === 1 && bodies('t2')[1] === '改过的', JSON.stringify(source.edits));

  clearErrors();
  source.refuse = true;
  target = myReply();
  comments.startEditing(target);
  target.body = '改不了';
  comments.saveEditing(target);
  check('editing refused: at first it shows', bodies('t2')[1] === '改不了');
  await comments.whenSent();
  check('editing refused: then the old words are back', bodies('t2')[1] === '改过的', JSON.stringify(bodies('t2')));
  check('editing refused: and the user is told', errors.length === 1 && errors[0].includes('改不了'), JSON.stringify(errors));
  source.refuse = false;
  await refreshed();

  // ---- deleting ----
  const asked = [];
  let answer = false;
  comments.confirmDelete = async (question, detail) => { asked.push({ question, detail }); return answer; };
  target = myReply();
  await comments.delete(target);
  check('deleting: it asks first, as it cannot be undone', asked.length === 1 && asked[0].question.includes('回复'), JSON.stringify(asked));
  check('deleting: saying no changes nothing', bodies('t2').length === 2 && source.deletedMessages.length === 0);

  answer = true;
  clearErrors();
  source.refuse = true;
  await comments.delete(target);
  check('deleting refused: at first it is gone', bodies('t2').length === 1);
  await comments.whenSent();
  check('deleting refused: then it is back in its place', bodies('t2').join() === 'two, changed by Bob,改过的', JSON.stringify(bodies('t2')));
  check('deleting refused: and the user is told', errors.length === 1 && errors[0].includes('403'), JSON.stringify(errors));
  source.refuse = false;
  await refreshed();

  target = myReply();
  hold();
  await comments.delete(target);
  check('deleting a reply: it is gone at once, while the server has not answered', bodies('t2').length === 1 && source.deletedMessages.length === 0, JSON.stringify(bodies('t2')));
  release();
  await comments.whenSent();
  check('deleting a reply: then Overleaf is told which', source.deletedMessages.length === 1 && source.deletedMessages[0].threadId === 't2' && source.deletedMessages[0].messageId === target.messageId, JSON.stringify(source.deletedMessages));
  await refreshed();
  check('deleting a reply: the comment stays', !!thread('t2') && bodies('t2').length === 1);

  firstOfT('t1').messages.push(theirs('m9', 'a reply by Bob'));
  await refreshed();
  asked.length = 0;
  target = thread('t1').comments[0];
  hold();
  await comments.delete(target);
  check('deleting a comment: the question says its replies go too', asked[0].question.includes('批注') && asked[0].detail.includes('1 条回复'), JSON.stringify(asked));
  check('deleting a comment: it is gone at once', !thread('t1') && source.deletedComments.length === 0);
  check('deleting a comment: the plain file follows', await until(() => !listing().includes('a reply by Bob')), listing());
  release();
  await comments.whenSent();
  check('deleting a comment: then Overleaf is told which, in which document', source.deletedComments.length === 1 && source.deletedComments[0].threadId === 't1' && source.deletedComments[0].docId === 'doc-of-main', JSON.stringify(source.deletedComments));
  await refreshed();
  check('deleting a comment: and it stays gone', !thread('t1'));

  source.comments.push(comment('t8', 'tar', tarOffset, { messages: [mine('m8', 'deleted, or not')] }));
  await refreshed();
  clearErrors();
  source.refuse = true;
  await comments.delete(thread('t8').comments[0]);
  check('deleting a comment refused: at first it is gone', !thread('t8'));
  await comments.whenSent();
  check('deleting a comment refused: then it is back', !!thread('t8') && errors.length === 1, JSON.stringify(errors));
  source.refuse = false;

  // ---- adding, the way VS Code offers it: an empty thread on a place, with a box ----
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
  const threadIdOf = (box) => [...comments.shown].find(([, entry]) => entry.thread === box)?.[0];
  put(main, 'first line\r\nb 疫苗 tar here\r\n\r\nlast\r\n');
  await documentShows('first line\nb 疫苗 tar here\n\nlast\n');

  const sentBefore = localChangesSent;
  let box = newThread(1, 2, 1, 4);
  hold();
  await comments.submit({ thread: box, text: ' 看这里 ' });
  check('adding: the button returns while the server has not answered, so the box clears at once', source.added.length === 0);
  check('adding: the box becomes the comment at once', threadIdOf(box) !== undefined && box.comments.length === 1 && box.comments[0].body === '看这里', JSON.stringify(box.comments));
  check('adding: under the user\'s own name and the same label as any other', box.comments[0].author.name === '我自己' && box.label === 'Overleaf 批注', box.label);
  const addedId = threadIdOf(box);
  check('adding: its id has the form Overleaf uses', /^[0-9a-f]{24}$/.test(addedId), addedId);
  check('adding: the plain file follows', await until(() => listing().includes('看这里')), listing());
  release();
  await comments.whenSent();
  check('adding: the selected text, counted without CRLF, and the words', lastAdded()?.threadId === addedId && lastAdded()?.file === 'main.tex' && lastAdded()?.quote === '疫苗' && lastAdded()?.offset === 'first line\nb '.length && lastAdded()?.text === '看这里', JSON.stringify(lastAdded()));
  check('adding: local changes go first, as the place is on the server\'s text', localChangesSent === sentBefore + 1 && source.sentOrder.indexOf('add') >= 0);
  check('adding: and when it is listed it is the same box', await until(() => box.comments[0]?.contextValue === 'mine'), String(box.comments[0]?.contextValue));
  check('adding: it sits on the text', rangeIs(addedId, 1, 2, 1, 4), shownRange(addedId));

  // Overleaf is slow to list what it has accepted
  source.listNewComments = false;
  box = newThread(0, 0, 0, 5);
  await comments.submit({ thread: box, text: 'not listed yet' });
  await comments.whenSent();
  const unlistedId = threadIdOf(box);
  await refreshed();
  check('adding: a comment Overleaf does not list yet stays', thread(unlistedId) === box && box.comments[0].body === 'not listed yet');
  check('adding: and Overleaf is asked again', await until(() => source.reads > reads + 2, 5000));
  comments.comments.find((c) => c.threadId === unlistedId).keepUntil = 0;
  await refreshed();
  check('adding: but not for ever', !thread(unlistedId));
  source.listNewComments = true;
  box.dispose();

  // quick changes reach Overleaf in order, and later ones know what the earlier ones found out
  source.sentOrder.length = 0;
  source.changes.length = 0;
  box = newThread(0, 0, 0, 5);
  hold();
  await comments.submit({ thread: box, text: 'quick' });
  await comments.submit({ thread: box, text: 'quick reply' });
  await comments.resolve(box);
  check('in order: all of it shows at once', !thread(threadIdOf(box) ?? 'none'));
  release();
  await comments.whenSent();
  check('in order: it reaches Overleaf in order', source.sentOrder.join() === 'add,reply,resolve', source.sentOrder.join());
  check('in order: resolving knows the document the comment was added to', source.changes[0].docId === 'doc-of-main', JSON.stringify(source.changes));
  box.dispose();

  box = newThread(0, 6, 1, 1);
  await comments.submit({ thread: box, text: 'two lines' });
  await comments.whenSent();
  check('adding: a selection over lines keeps LF', lastAdded().quote === 'line\nb' && lastAdded().offset === 6, JSON.stringify(lastAdded()));
  box.dispose();

  box = newThread(1, 0, 1, 0);
  await comments.submit({ thread: box, text: 'whole line' });
  await comments.whenSent();
  check('adding: a click in the margin comments on the line', lastAdded().quote === 'b 疫苗 tar here' && lastAdded().offset === 'first line\n'.length, JSON.stringify(lastAdded()));
  box.dispose();

  clearErrors();
  let addedBefore = source.added.length;
  box = newThread(2, 0, 2, 0);
  await comments.submit({ thread: box, text: 'empty line' });
  await comments.whenSent();
  check('adding: an empty line has nothing to comment on', source.added.length === addedBefore && errors.length === 1 && errors[0].includes('没有文字'), JSON.stringify(errors));
  check('adding: and the box stays', box.comments.length === 0);
  box.dispose();

  clearErrors();
  source.refuse = true;
  box = newThread(3, 0, 3, 4);
  await comments.submit({ thread: box, text: '加不上' });
  check('adding refused: at first it shows', box.comments.length === 1);
  await comments.whenSent();
  check('adding refused: then the box is empty again', box.comments.length === 0 && threadIdOf(box) === undefined);
  check('adding refused: and what was written is in the message', errors.length === 1 && errors[0].includes('加不上') && errors[0].includes('403'), JSON.stringify(errors));
  source.refuse = false;
  retries[0]();
  check('adding refused: trying again puts it back at once', box.comments.length === 1 && box.comments[0].body === '加不上');
  await comments.whenSent();
  check('adding refused: and goes through', lastAdded().text === '加不上');
  await refreshed();
  box.dispose();

  addedBefore = source.added.length;
  box = newThread(3, 0, 3, 4);
  await comments.submit({ thread: box, text: '   ' });
  await comments.whenSent();
  check('adding: nothing written, nothing sent', source.added.length === addedBefore);
  box.dispose();

  source.comments = [comment('t3', '', 0, { path: 'sections/later.tex' })];
  await refreshed();
  await until(() => !!thread('t3'));

  // no connection
  source.failing = true;
  emitter.fire();
  await until(() => logged.some((m) => m.includes('no connection')));
  check('comments: a failed read is recorded', logged.some((m) => m.includes('Could not read the comments: no connection')), JSON.stringify(logged));
  check('comments: and what is showing stays', !!thread('t3'));
  source.failing = false;

  // no longer being kept up to date is said in the file, as a tool reading it could not tell
  await comments.markOutOfDate('This has stopped being updated.');
  check('comments: the plain file says when it has stopped being updated', listing().includes('This has stopped being updated.') && !listing().includes('Kept up to date'), listing().split('\n')[2]);
  await comments.markOutOfDate(undefined);

  // the folder being deleted is noticed a moment later, and writing in that moment must not bring it back
  const away = `${folder} moved away`;
  fs.renameSync(folder, away);
  source.comments = [...source.comments, comment('t-late', 'nothing', 0, { messages: [{ author: 'Ada Lovelace', text: 'late', time: 1793865710629 }] })];
  emitter.fire();
  await sleep(SETTLE_MS);
  check('comments: writing does not bring back a deleted folder', !fs.existsSync(folder));
  fs.renameSync(away, folder);

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

// ---- what must not happen to a shared manuscript ----

async function testSafety(FolderSync, { mergeText, findUnsupportedCharacter }) {
  // choosing a side decides only the places that overlap
  const lines = 'The first sentence stays as it is.\nThe second sentence is what both change.\nThe third sentence stays as it is.\nThe fourth sentence stays as it is.\n';
  const mine = lines.replace('first', 'FIRST').replace('second sentence', 'second line, mine');
  const theirs = lines.replace('fourth', 'FOURTH').replace('second sentence', 'second line, theirs');
  let m = mergeText(lines, mine, theirs, 'local');
  check('choice: the local side wins where they overlap, and changes elsewhere stay', m.ok && m.text === lines.replace('first', 'FIRST').replace('second sentence', 'second line, mine').replace('fourth', 'FOURTH'), JSON.stringify(m));
  m = mergeText(lines, mine, theirs, 'online');
  check('choice: the online side wins where they overlap, and changes elsewhere stay', m.ok && m.text === lines.replace('first', 'FIRST').replace('second sentence', 'second line, theirs').replace('fourth', 'FOURTH'), JSON.stringify(m));
  const wide = mergeText('aaa bbb ccc ddd eee', 'aaa XXXXXXXXXXX eee', 'aaa B ccc D eee', 'local');
  check('choice: one wide edit against two small ones is decided as a whole', wide.ok && wide.text === 'aaa XXXXXXXXXXX eee', JSON.stringify(wide));
  const wideOnline = mergeText('aaa bbb ccc ddd eee', 'aaa XXXXXXXXXXX eee', 'aaa B ccc D eee', 'online');
  check('choice: and from the other side too', wideOnline.ok && wideOnline.text === 'aaa B ccc D eee', JSON.stringify(wideOnline));
  check('choice: without a preference it stays a conflict', !mergeText('one\n', 'ONE mine\n', 'ONE theirs\n').ok);

  check('characters: ordinary text and Chinese are fine', findUnsupportedCharacter('疫苗 é – x\n') === undefined);
  const emoji = findUnsupportedCharacter('one\ntwo 😀 three\n');
  check('characters: an emoji is found, with its line', emoji?.character === '😀' && emoji.line === 2, JSON.stringify(emoji));

  // ---- someone's edit arrives just after the text was read ----
  let c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'one\ntwo\nthree\n' }));
  c.remote.afterRead = (p) => { c.remote.docs.set(p, 'one\ntwo\nthree\nfour from Bob\n'); };
  c.write('main.tex', 'ONE\ntwo\nthree\n');
  check('arriving late: a push does not remove their edit', await until(() => c.remote.docs.get('main.tex') === 'ONE\ntwo\nthree\nfour from Bob\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  check('arriving late: and the local file has both', await until(() => c.read('main.tex') === 'ONE\ntwo\nthree\nfour from Bob\n'), JSON.stringify(c.read('main.tex')));
  c.sync.dispose();

  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'one\ntwo\nthree\n' }));
  c.sync.options.confirmRemoteDelete = async () => false;
  c.remote.docs.set('main.tex', 'one\ntwo\nthree\nabc\n');
  c.remote.afterRead = (p) => { c.remote.docs.set(p, 'one\ntwo\nthree\nabcd\n'); };
  c.write('main.tex', 'ONE\ntwo\nthree\n');
  await until(() => c.remote.docs.get('main.tex') === 'ONE\ntwo\nthree\nabcd\n');
  check('arriving late: a merge does not remove their newest typing', c.remote.docs.get('main.tex') === 'ONE\ntwo\nthree\nabcd\n', JSON.stringify(c.remote.docs.get('main.tex')));
  check('arriving late: someone who keeps typing causes no false conflict', c.sync.status.conflicts.length === 0, JSON.stringify(c.sync.status.conflicts));
  check('arriving late: and the local file has everything', await until(() => c.read('main.tex') === 'ONE\ntwo\nthree\nabcd\n'), JSON.stringify(c.read('main.tex')));
  c.sync.dispose();

  // ---- typing at the moment an online edit is applied ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'one\ntwo\nthree\n' }));
  let document = await vscode.workspace.openTextDocument(path.join(c.root, 'main.tex'));
  await vscode.window.showTextDocument(document);
  c.remote.docs.set('main.tex', 'one\ntwo\nthree\nfrom Bob\n');
  c.remote.afterRead = async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'typed ');
    await vscode.workspace.applyEdit(edit);
  };
  c.remote.changed.fire('main.tex');
  check('typing: what was typed while an edit arrived is not lost', await until(() => c.remote.docs.get('main.tex') === 'typed one\ntwo\nthree\nfrom Bob\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  check('typing: and the editor shows both', await until(() => document.getText().replace(/\r\n/g, '\n') === 'typed one\ntwo\nthree\nfrom Bob\n'), JSON.stringify(document.getText()));
  c.remote.edit('main.tex', 'typed one\ntwo\nthree\nfrom Bob\nmore\n');
  check('an open file: an online edit reaches the editor at once, not after a reload', await until(() => document.getText().replace(/\r\n/g, '\n').endsWith('more\n')), JSON.stringify(document.getText()));
  check('an open file: and it is saved', await until(() => !document.isDirty && c.read('main.tex').replace(/\r\n/g, '\n').endsWith('more\n')));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  c.sync.dispose();

  // ---- a tool writing a file it read some time ago: held, and the user decides ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'first line\nsecond line\nthird line\n' }));
  c.remote.edit('main.tex', 'first line\nsecond line by Bob\nthird line\n');
  await until(() => c.read('main.tex').includes('by Bob'));
  await sleep(SETTLE_MS);
  let writesHere = c.remote.writes.length;
  const oldCopy = 'first line\nsecond line\nthird line\na line from a tool\n';
  c.write('main.tex', oldCopy);
  check('an old copy: it is held, not sent', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'olderCopy')), JSON.stringify(c.sync.status.conflicts));
  check('an old copy: the online edit is untouched', c.remote.writes.length === writesHere && c.remote.docs.get('main.tex').includes('by Bob'), JSON.stringify(c.remote.docs.get('main.tex')));
  check('an old copy: the tool\'s file is untouched', c.read('main.tex') === oldCopy);
  check('an old copy: the user is asked once', c.conflicts.filter((x) => x.reason === 'olderCopy').length === 1, JSON.stringify(c.conflicts));
  c.sync.lastReceived.get('main.tex').at = 0;
  await c.sync.flush();
  await sleep(SETTLE_MS);
  check('an old copy: it stays held however long the choice takes', c.remote.writes.length === writesHere && c.sync.status.conflicts.some((x) => x.reason === 'olderCopy'), JSON.stringify(c.remote.writes));
  c.remote.edit('main.tex', 'first line\nsecond line by Bob\nthird line\nmore by Bob\n');
  await sleep(SETTLE_MS);
  check('an old copy: further online edits do not overwrite it', c.read('main.tex') === oldCopy);
  await c.sync.stop();
  c.conflicts.length = 0;
  c.sync = c.make();
  await c.sync.start();
  await sleep(SETTLE_MS);
  check('an old copy: reloading the window does not send it', c.remote.writes.length === writesHere && c.read('main.tex') === oldCopy, JSON.stringify(c.remote.writes));
  check('an old copy: and the user is asked again', c.sync.status.conflicts.some((x) => x.reason === 'olderCopy') && c.conflicts.some((x) => x.reason === 'olderCopy'), JSON.stringify(c.sync.status));
  await c.sync.resolveConflict('main.tex', 'online');
  check('an old copy: choosing online brings the online text', c.read('main.tex') === 'first line\nsecond line by Bob\nthird line\nmore by Bob\n', JSON.stringify(c.read('main.tex')));
  check('an old copy: and the tool\'s version is kept', fs.readFileSync(c.sync.discardedCopyUri('main.tex').fsPath, 'utf8') === oldCopy);
  check('an old copy: it is settled', c.sync.status.conflicts.length === 0);
  await sleep(SETTLE_MS);
  const afterChoice = c.read('main.tex');
  c.write('main.tex', `${afterChoice}a change after choosing\n`);
  check('an old copy: after choosing online, the next change just goes', await until(() => c.remote.docs.get('main.tex') === `${afterChoice}a change after choosing\n`) && c.sync.status.conflicts.length === 0, JSON.stringify(c.sync.status));
  await sleep(SETTLE_MS);
  c.write('main.tex', afterChoice);
  await until(() => c.remote.docs.get('main.tex') === afterChoice);
  await sleep(SETTLE_MS);

  c.remote.edit('main.tex', 'first line\nsecond line by Bob, again\nthird line\nmore by Bob\n');
  await until(() => c.read('main.tex').includes('again'));
  await sleep(SETTLE_MS);
  c.write('main.tex', 'an old copy kept on purpose\n');
  await until(() => c.sync.status.conflicts.some((x) => x.reason === 'olderCopy'));
  await c.sync.resolveConflict('main.tex', 'local');
  check('an old copy: choosing local sends it', c.remote.docs.get('main.tex') === 'an old copy kept on purpose\n', JSON.stringify(c.remote.docs.get('main.tex')));
  await sleep(SETTLE_MS);
  c.write('main.tex', 'and later changes just go\n');
  check('an old copy: and nothing is held after that', await until(() => c.remote.docs.get('main.tex') === 'and later changes just go\n'), JSON.stringify(c.sync.status));
  await c.sync.stop();
  c.sync = c.make();
  await c.sync.start();
  await sleep(SETTLE_MS);
  c.write('main.tex', 'and after a reload too\n');
  check('an old copy: not after a reload either', await until(() => c.remote.docs.get('main.tex') === 'and after a reload too\n'), JSON.stringify(c.sync.status));
  c.sync.dispose();

  // written at the very moment an edit arrived: nothing is lost, and nobody needs asking
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'first line\nsecond line\nthird line\n' }));
  c.remote.edit('main.tex', 'first line\nsecond line by Bob\nthird line\n');
  await until(() => c.read('main.tex').includes('by Bob'));
  c.write('main.tex', 'first line\nsecond line\nthird line\nfrom a tool\n');
  check('just missed: both edits are kept', await until(() => c.remote.docs.get('main.tex') === 'first line\nsecond line by Bob\nthird line\nfrom a tool\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  check('just missed: and the local file has both', await until(() => c.read('main.tex') === 'first line\nsecond line by Bob\nthird line\nfrom a tool\n'), JSON.stringify(c.read('main.tex')));
  check('just missed: nobody is asked', c.sync.status.conflicts.length === 0 && c.conflicts.length === 0, JSON.stringify(c.sync.status));
  c.sync.dispose();

  // lacking the edit before as well is no moment's overlap, however new the last one is
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'first line\nsecond line\nthird line\nfourth line\n' }));
  c.remote.edit('main.tex', 'first line by Bob\nsecond line\nthird line\nfourth line\n');
  await until(() => c.read('main.tex').includes('first line by Bob'));
  await sleep(SETTLE_MS);
  c.remote.edit('main.tex', 'first line by Bob\nsecond line\nthird line\nfourth line by Bob\n');
  await until(() => c.read('main.tex').includes('fourth line by Bob'));
  writesHere = c.remote.writes.length;
  c.write('main.tex', 'first line\nsecond line from a tool\nthird line\nfourth line\n');
  check('not just missed: an older copy is held however new the last edit is', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'olderCopy')), JSON.stringify(c.sync.status));
  check('not just missed: and nothing is sent', c.remote.writes.length === writesHere, JSON.stringify(c.remote.writes));
  c.sync.dispose();

  // ...while someone keeps typing, which makes it a merge rather than a push
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'paragraph A here\nparagraph B here\nparagraph C here\n' }));
  c.remote.edit('main.tex', 'paragraph A here\nparagraph B by Bob\nparagraph C here\n');
  await until(() => c.read('main.tex').includes('B by Bob'));
  await sleep(SETTLE_MS);
  c.remote.docs.set('main.tex', 'paragraph A here\nparagraph B by Bob\nparagraph C by Bob\n');
  c.write('main.tex', 'paragraph A by a tool\nparagraph B here\nparagraph C here\n');
  check('an old copy while someone types: it is held too', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'olderCopy')), JSON.stringify(c.sync.status));
  check('an old copy while someone types: their edits are untouched', c.remote.docs.get('main.tex') === 'paragraph A here\nparagraph B by Bob\nparagraph C by Bob\n', JSON.stringify(c.remote.docs.get('main.tex')));
  c.sync.dispose();

  // ...with the file open, where edits arriving also save it
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'first line\nsecond line\nthird line\n' }));
  document = await vscode.workspace.openTextDocument(path.join(c.root, 'main.tex'));
  await vscode.window.showTextDocument(document);
  c.remote.edit('main.tex', 'first line\nsecond line by Bob\nthird line\n');
  await until(() => document.getText().replace(/\r\n/g, '\n').includes('by Bob') && !document.isDirty);
  await sleep(SETTLE_MS);
  writesHere = c.remote.writes.length;
  c.write('main.tex', 'first line\nsecond line\nthird line\nfrom a tool\n');
  check('an old copy over an open file: it is held too', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'olderCopy')), JSON.stringify(c.sync.status));
  check('an old copy over an open file: the online edit is untouched', c.remote.writes.length === writesHere, JSON.stringify(c.remote.writes));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  c.sync.dispose();

  // what a tool normally does
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'first line\nsecond line\nthird line\nfourth line\n' }));
  await sleep(SETTLE_MS);
  c.write('main.tex', 'first line\nsecond line\nthird line\nfourth line\na sentence of mine\n');
  await until(() => c.remote.docs.get('main.tex').includes('a sentence of mine'));
  await sleep(SETTLE_MS);
  c.remote.edit('main.tex', 'first line by Bob\nsecond line\nthird line\nfourth line\na sentence of mine\n');
  await until(() => c.read('main.tex').includes('by Bob'));
  await sleep(SETTLE_MS);
  c.write('main.tex', 'first line by Bob\nsecond line\nthird line by a tool\nfourth line\na sentence of mine\n');
  check('an up-to-date copy is just a change', await until(() => c.remote.docs.get('main.tex').includes('by a tool')) && c.sync.status.conflicts.length === 0, JSON.stringify(c.sync.status));
  await sleep(SETTLE_MS);
  c.write('main.tex', 'first line by Bob\nsecond line\nthird line by a tool\nfourth line\n');
  check('removing: my own text can be removed with a collaborator around', await until(() => c.remote.docs.get('main.tex') === 'first line by Bob\nsecond line\nthird line by a tool\nfourth line\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  await sleep(SETTLE_MS);
  check('removing: and is not put back', c.read('main.tex') === 'first line by Bob\nsecond line\nthird line by a tool\nfourth line\n' && c.sync.status.conflicts.length === 0, JSON.stringify(c.sync.status));
  c.write('main.tex', 'first line\nsecond line\nthird line by a tool\nfourth line\n');
  check('removing what just arrived: the user is asked', await until(() => c.sync.status.conflicts.some((x) => x.reason === 'olderCopy')), JSON.stringify(c.sync.status));
  await c.sync.resolveConflict('main.tex', 'local');
  check('removing what just arrived: and it goes if they say so', c.remote.docs.get('main.tex') === 'first line\nsecond line\nthird line by a tool\nfourth line\n', JSON.stringify(c.remote.docs.get('main.tex')));
  c.sync.dispose();

  // taking out someone's text in the editor is a decision, and later versions need not have it
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'a\nb\nc\n' }));
  document = await vscode.workspace.openTextDocument(path.join(c.root, 'main.tex'));
  await vscode.window.showTextDocument(document);
  c.remote.edit('main.tex', 'a\nb from Bob\nc\n');
  await until(() => document.getText().replace(/\r\n/g, '\n') === 'a\nb from Bob\nc\n');
  await sleep(SETTLE_MS);
  const removal = new vscode.WorkspaceEdit();
  removal.delete(document.uri, new vscode.Range(1, 1, 1, 'b from Bob'.length));
  await vscode.workspace.applyEdit(removal);
  check('in the editor: removing someone\'s text is a decision, and reaches Overleaf', await until(() => c.remote.docs.get('main.tex') === 'a\nb\nc\n'), JSON.stringify(c.remote.docs.get('main.tex')));
  await sleep(SETTLE_MS);
  check('in the editor: nobody is asked', document.getText().replace(/\r\n/g, '\n') === 'a\nb\nc\n' && c.sync.status.conflicts.length === 0, JSON.stringify(c.sync.status));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await sleep(300);
  c.write('main.tex', 'a\nb\nc\nd from a tool\n');
  check('in the editor: and a tool editing after that is not held', await until(() => c.remote.docs.get('main.tex') === 'a\nb\nc\nd from a tool\n') && c.sync.status.conflicts.length === 0, JSON.stringify(c.sync.status));
  c.sync.dispose();

  // ---- Windows line endings in an open file ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'one\n\ntwo\n' }), {});
  c.sync.dispose();
  fs.writeFileSync(path.join(c.root, 'main.tex'), 'one\r\n\r\ntwo\r\n');
  c.sync = c.make();
  await c.sync.start();
  document = await vscode.workspace.openTextDocument(path.join(c.root, 'main.tex'));
  await vscode.window.showTextDocument(document);
  await until(() => document.eol === vscode.EndOfLine.CRLF);
  c.remote.edit('main.tex', 'one\nnew line by Bob\n\ntwo\n');
  check('line endings: an edit before an empty line adds no extra line', await until(() => document.getText() === 'one\r\nnew line by Bob\r\n\r\ntwo\r\n'), JSON.stringify(document.getText()));
  await sleep(SETTLE_MS);
  check('line endings: and nothing extra goes online', c.remote.docs.get('main.tex') === 'one\nnew line by Bob\n\ntwo\n', JSON.stringify(c.remote.docs.get('main.tex')));
  check('line endings: the file keeps them', c.read('main.tex') === 'one\r\nnew line by Bob\r\n\r\ntwo\r\n', JSON.stringify(c.read('main.tex')));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  c.sync.dispose();

  // ---- choosing a side in a conflict ----
  const conflicted = async () => {
    const each = await setup(FolderSync, new FakeRemote({ 'main.tex': 'one\ntwo\nthree\nfour\n' }));
    await each.sync.flush();
    each.sync.dispose();
    fs.writeFileSync(path.join(each.root, 'main.tex'), 'ONE\ntwo mine\nthree\nfour\n');
    each.remote.docs.set('main.tex', 'one\ntwo theirs\nthree\nFOUR\n');
    each.sync = each.make();
    await each.sync.start();
    await until(() => each.sync.status.conflicts.length === 1);
    return each;
  };
  c = await conflicted();
  check('choice: setup is a conflict', c.sync.status.conflicts[0]?.reason === 'sameRegion', JSON.stringify(c.sync.status.conflicts));
  await c.sync.resolveConflict('main.tex', 'local');
  check('choice: keeping local takes it where they overlap and leaves their other edits', c.remote.docs.get('main.tex') === 'ONE\ntwo mine\nthree\nFOUR\n' && c.read('main.tex') === 'ONE\ntwo mine\nthree\nFOUR\n', JSON.stringify(c.remote.docs.get('main.tex')));
  check('choice: it is settled', c.sync.status.conflicts.length === 0);
  c.sync.dispose();

  c = await conflicted();
  await c.sync.resolveConflict('main.tex', 'online');
  check('choice: keeping online takes it where they overlap and leaves your other edits', c.remote.docs.get('main.tex') === 'ONE\ntwo theirs\nthree\nFOUR\n' && c.read('main.tex') === 'ONE\ntwo theirs\nthree\nFOUR\n', JSON.stringify(c.read('main.tex')));
  check('choice: the local version is kept in case that was a mistake', fs.readFileSync(c.sync.discardedCopyUri('main.tex').fsPath, 'utf8') === 'ONE\ntwo mine\nthree\nfour\n');
  c.sync.dispose();

  // ---- what Overleaf cannot take ----
  const problems = [];
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'one\ntwo\n' }), {}, { onProblem: (p, problem) => problems.push({ p, problem }) });
  const writesBefore = c.remote.writes.length;
  c.write('main.tex', 'one\ntwo 😀\n');
  await until(() => c.sync.status.failed.includes('main.tex'));
  check('an emoji: the file shows as not synced', c.sync.status.failed.includes('main.tex'), JSON.stringify(c.sync.status));
  check('an emoji: nothing is sent, as Overleaf would drop the connection and lose the edit', c.remote.writes.length === writesBefore && c.remote.docs.get('main.tex') === 'one\ntwo\n');
  check('an emoji: the user is told what and where, once', problems.length === 1 && problems[0].problem.character === '😀' && problems[0].problem.line === 2, JSON.stringify(problems));
  check('an emoji: the local file is left alone', c.read('main.tex') === 'one\ntwo 😀\n');
  c.write('main.tex', 'one\ntwo smile\n');
  check('an emoji: once it is gone the file syncs', await until(() => c.remote.docs.get('main.tex') === 'one\ntwo smile\n' && c.sync.status.failed.length === 0), JSON.stringify(c.sync.status));
  problems.length = 0;
  c.write('main.tex', Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  await until(() => c.sync.status.failed.includes('main.tex'));
  check('another encoding: the file shows as not synced', c.sync.status.failed.includes('main.tex'));
  check('another encoding: and the user is told', problems.length === 1 && problems[0].problem.kind === 'notUtf8', JSON.stringify(problems));
  check('another encoding: nothing is sent', c.remote.docs.get('main.tex') === 'one\ntwo smile\n');
  c.write('main.tex', 'one\ntwo smile\n');
  await until(() => c.sync.status.failed.length === 0);
  c.sync.dispose();

  // ---- a failed upload is not a success ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n' }, { 'figures/a.png': 'OLD' }));
  c.remote.failWrites = true;
  c.write('figures/a.png', 'NEW');
  await until(() => c.sync.status.failed.includes('figures/a.png'));
  check('a failed replacement shows as not synced', c.sync.status.failed.includes('figures/a.png'), JSON.stringify(c.sync.status));
  c.remote.failWrites = false;
  check('and is sent once it can be', await until(() => Buffer.from(c.remote.files.get('figures/a.png').content).toString() === 'NEW', 10000));
  c.sync.dispose();

  // ---- renaming ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n', 'old name.tex': 'the section\n' }, { 'figures/a.png': 'PNG' }));
  await sleep(SETTLE_MS);
  let writes = c.remote.writes.length;
  c.remove('old name.tex');
  c.write('new name.tex', 'the section\n');
  check('renaming: the document is renamed online, keeping its comments', await until(() => c.remote.renames.some((r) => r.from === 'old name.tex' && r.to === 'new name.tex')), JSON.stringify(c.remote.renames));
  await sleep(SETTLE_MS);
  check('renaming: nothing is uploaded', c.remote.writes.length === writes, JSON.stringify(c.remote.writes));
  check('renaming: and nobody is asked about deleting', c.asked.length === 0 && c.remote.removed.length === 0, JSON.stringify(c.asked));
  // a rename slower than the question about deleting
  c.answer = true;
  c.remote.renameDelayMs = 1500;
  c.remove('new name.tex');
  c.write('slow name.tex', 'the section\n');
  check('renaming slowly: it is still renamed', await until(() => c.remote.renames.some((r) => r.to === 'slow name.tex'), 8000), JSON.stringify(c.remote.renames));
  await sleep(SETTLE_MS);
  check('renaming slowly: and the document is not deleted while that happens', c.remote.removed.length === 0 && c.remote.docs.has('slow name.tex'), JSON.stringify([c.remote.removed, [...c.remote.docs.keys()]]));
  check('renaming slowly: nobody is asked', c.asked.length === 0, JSON.stringify(c.asked));
  c.answer = false;
  c.remote.renameDelayMs = 0;
  c.remove('slow name.tex');
  c.write('new name.tex', 'the section\n');
  await until(() => c.remote.docs.has('new name.tex'));
  await sleep(SETTLE_MS);

  c.write('new name.tex', 'the section, edited\n');
  check('renaming: later edits go to the renamed document', await until(() => c.remote.docs.get('new name.tex') === 'the section, edited\n'));
  c.remove('figures/a.png');
  c.write('elsewhere/a.png', 'PNG');
  check('renaming: moving a file to another folder under its name is followed too', await until(() => c.remote.renames.some((r) => r.to === 'elsewhere/a.png')), JSON.stringify(c.remote.renames));
  await sleep(SETTLE_MS);
  c.answer = true;
  writes = c.remote.writes.length;
  c.remove('new name.tex');
  c.write('other/different.tex', 'the section, edited\n');
  check('renaming: moved and renamed at once is an upload and a delete', await until(() => c.remote.docs.get('other/different.tex') === 'the section, edited\n' && !c.remote.docs.has('new name.tex'), 8000), JSON.stringify([...c.remote.docs.keys()]));
  check('renaming: and the delete is asked about', c.asked.length === 1, JSON.stringify(c.asked));
  c.asked.length = 0;
  writes = c.remote.writes.length;
  c.write('copy.tex', 'x\n');
  await until(() => c.remote.docs.has('copy.tex'));
  check('renaming: a copy is not a rename', c.remote.renames.every((r) => r.to !== 'copy.tex') && c.remote.docs.get('main.tex') === 'x\n');
  c.sync.dispose();

  // renaming a folder arrives file by file, and the question about deleting must wait for all of it
  c = await setup(FolderSync, new FakeRemote({ 'part/a.tex': 'text of a\n', 'part/b.tex': 'text of b\n', 'part/c.tex': 'text of c\n', 'main.tex': 'x\n' }));
  await sleep(SETTLE_MS);
  c.remote.renameDelayMs = 700;
  fs.renameSync(path.join(c.root, 'part'), path.join(c.root, 'moved'));
  check('renaming a folder: every file is renamed', await until(() => ['a', 'b', 'c'].every((n) => c.remote.docs.has(`moved/${n}.tex`)), 15000), JSON.stringify([...c.remote.docs.keys()]));
  await sleep(SETTLE_MS);
  check('renaming a folder: nobody is asked about deleting along the way', c.asked.length === 0 && c.remote.removed.length === 0, JSON.stringify(c.asked));
  c.remote.renameDelayMs = 0;
  c.sync.dispose();

  // a second problem in the same file is told too
  const told = [];
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n' }), {}, { onProblem: (p, problem) => told.push(problem.character) });
  c.write('main.tex', 'x 😀\n');
  await until(() => told.length === 1);
  c.write('main.tex', 'x 🎉\n');
  check('a second bad character is told as well', await until(() => told.length === 2, 12000), JSON.stringify(told));
  check('the status lists it as waiting for a change', c.sync.status.refused.includes('main.tex'), JSON.stringify(c.sync.status));
  c.write('main.tex', 'x\n');
  check('and not once it is fixed', await until(() => c.sync.status.refused.length === 0 && c.sync.status.failed.length === 0, 12000), JSON.stringify(c.sync.status));
  c.sync.dispose();

  // ---- the engine's own files ----
  c = await setup(FolderSync, new FakeRemote({ 'main.tex': 'x\n' }), {}, { ignorePatterns: ['**/*.aux'] });
  await sleep(SETTLE_MS);
  writes = c.remote.writes.length;
  c.write('.output/output.log', 'log');
  c.write('.git/HEAD', 'ref');
  c.write('.overleaf/settings.json', '{}');
  c.write('notes.aux', 'aux');
  await c.sync.flush();
  await sleep(SETTLE_MS);
  check('own patterns: the engine\'s folders still stay out of the project', c.remote.writes.length === writes, JSON.stringify(c.remote.writes));
  c.sync.dispose();
}

async function testConnection(SocketIOAPI) {
  const listeners = {};
  const socket = {
    on(name, fn) { (listeners[name] = listeners[name] ?? []).push(fn); },
    emit() {},
    removeAllListeners() { for (const name of Object.keys(listeners)) delete listeners[name]; },
    disconnect() {},
  };
  const fire = (name, ...args) => (listeners[name] ?? []).forEach((fn) => fn(...args));
  const api = new SocketIOAPI('https://www.overleaf.com/', { _initSocketV0: () => socket }, { cookies: '', csrfToken: '' }, 'p1');
  api.scheme = 'v2';
  api.init();
  fire('joinProjectResponse', { publicId: 'a', project: { name: 'first' } });
  check('a connection: the project comes with its answer', (await api.joinProject('p1')).name === 'first');
  fire('disconnect');
  let settled = false;
  const pending = api.joinProject('p1').then((project) => { settled = true; return project; });
  await sleep(100);
  check('after a drop: the old answer is not used, as it describes an ended session', !settled);
  fire('joinProjectResponse', { publicId: 'b', project: { name: 'second' } });
  check('after a drop: the new connection\'s answer is', (await pending).name === 'second');
  check('after a drop: and it stays until the next drop', (await api.joinProject('p1')).name === 'second');

  // leaving also stops any waiting to reconnect, which a plain disconnect does not
  let reconnected = false;
  let closedConnection = 0;
  const waiting = {
    options: { reconnect: true },
    reconnecting: true,
    reconnectionTimer: setTimeout(() => { reconnected = true; }, 80),
  };
  const leaving = new SocketIOAPI('https://www.overleaf.com/', { _initSocketV0: () => ({ ...socket, socket: waiting, disconnect() { closedConnection++; } }) }, { cookies: '', csrfToken: '' }, 'p1');
  leaving.scheme = 'v2';
  leaving.init();
  closedConnection = 0;
  leaving.close();
  await sleep(200);
  check('closing: a reconnect that was waiting does not happen', !reconnected && waiting.reconnecting === false);
  check('closing: and none starts later', waiting.options.reconnect === false);
  check('closing: the connection itself is closed', closedConnection === 1);
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
    const manager = new FolderSyncManager({ setGate() {}, forget() {} });
    Object.assign(manager, {
      startTicking: () => {},
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

/** Folders exist in their own right: an empty one syncs, and one emptied on one side goes on the other. */
async function testFolders(FolderSync) {
  const settle = async (t) => { await t.sync.flush(); await sleep(SETTLE_MS); await t.sync.flush(); };

  let remote = new FakeRemote({ 'main.tex': 'a\n' });
  let t = await setup(FolderSync, remote);
  fs.mkdirSync(path.join(t.root, 'figures', 'plots'), { recursive: true });
  await until(() => remote.foldersCreated.includes('figures/plots'));
  await settle(t);
  check('a new empty local folder appears online', remote.folders.has('figures/plots'), JSON.stringify(remote.foldersCreated));
  check('and the folder above it', remote.folders.has('figures'));

  remote.addFolderOnline('tables/raw');
  await until(() => t.exists('tables/raw'));
  check('a new empty online folder appears locally', t.exists('tables/raw'));
  check('nothing else was created online for it', !remote.foldersCreated.includes('tables/raw'), JSON.stringify(remote.foldersCreated));

  remote.foldersRemoved.length = 0;
  const askedBefore = t.asked.length;
  fs.rmdirSync(path.join(t.root, 'figures', 'plots'));
  await until(() => remote.foldersRemoved.includes('figures/plots'));
  await settle(t);
  check('an empty folder deleted locally goes online', !remote.folders.has('figures/plots') && remote.foldersRemoved.includes('figures/plots'), JSON.stringify(remote.foldersRemoved));
  check('an empty folder needs no question', t.asked.length === askedBefore);
  check('its parent stays', remote.folders.has('figures') && t.exists('figures'));

  remote.removeFolderOnline('tables/raw');
  await until(() => !t.exists('tables/raw'));
  check('an empty folder deleted online goes locally', !t.exists('tables/raw'));
  check('its parent stays locally', t.exists('tables'));
  t.sync.dispose();

  // a folder with files in it, deleted locally
  remote = new FakeRemote({ 'main.tex': 'a\n', 'sec/one.tex': 'one\n', 'sec/two.tex': 'two\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  fs.rmSync(path.join(t.root, 'sec'), { recursive: true });
  await until(() => t.asked.length > 0);
  await settle(t);
  check('deleting a folder with files asks, once, about all of them', t.asked.length === 1 && t.asked[0].length === 2, JSON.stringify(t.asked));
  check('answering no brings the files back', t.read('sec/one.tex') === 'one\n' && t.read('sec/two.tex') === 'two\n');
  check('answering no leaves online alone', remote.docs.has('sec/one.tex') && remote.foldersRemoved.length === 0, JSON.stringify(remote.foldersRemoved));

  t.answer = true;
  fs.rmSync(path.join(t.root, 'sec'), { recursive: true });
  await until(() => t.asked.length > 1);
  await until(() => remote.foldersRemoved.includes('sec'));
  await settle(t);
  check('answering yes deletes the files online', !remote.docs.has('sec/one.tex') && !remote.docs.has('sec/two.tex'));
  check('answering yes is the end of the question', t.asked.length === 2, JSON.stringify(t.asked));
  check('and then the folder', remote.foldersRemoved.includes('sec'), JSON.stringify(remote.foldersRemoved));
  check('the local folder stays deleted', !t.exists('sec'));
  check('the rest of the project is untouched', remote.docs.get('main.tex') === 'a\n' && t.read('main.tex') === 'a\n');
  t.sync.dispose();

  // deleting takes time, and the question must not come round again in the meantime
  remote = new FakeRemote({ 'main.tex': 'a\n', 'sec/one.tex': 'one\n', 'sec/two.tex': 'two\n', 'sec/three.tex': 'three\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  remote.removeDelayMs = 700;
  t.answer = true;
  fs.rmSync(path.join(t.root, 'sec'), { recursive: true });
  await until(() => t.asked.length > 0);
  await until(() => remote.removed.length === 3, 10000);
  await sleep(SETTLE_MS * 2);
  check('a slow delete online asks only once', t.asked.length === 1, JSON.stringify(t.asked));
  check('and every file went', remote.removed.length === 3 && !remote.docs.has('sec/one.tex'), JSON.stringify(remote.removed));
  check('none deleted twice', new Set(remote.removed).size === 3);
  t.sync.dispose();

  // a folder with files in it, deleted online
  remote = new FakeRemote({ 'main.tex': 'a\n', 'sec/one.tex': 'one\n' });
  const deletedOnline = [];
  t = await setup(FolderSync, remote, {}, { onOnlineDelete: (paths) => deletedOnline.push(...paths) });
  await settle(t);
  remote.removeFolderOnline('sec');
  await until(() => !t.exists('sec'));
  await until(() => deletedOnline.length > 0);
  check('a folder deleted online goes locally, files and all', !t.exists('sec'));
  check('deleting online is mentioned', deletedOnline.join() === 'sec/one.tex', JSON.stringify(deletedOnline));
  check('nobody is asked about what already happened online', t.asked.length === 0);
  const trash = path.join(t.root, '.overleaf', 'sync', 'trash');
  check('the local copy can still be found', fs.existsSync(trash) && fs.readdirSync(trash, { recursive: true }).some((name) => String(name).endsWith('one.tex')));
  t.sync.dispose();

  // several deletions at once are one notice
  remote = new FakeRemote({ 'a.tex': '1\n', 'b.tex': '2\n', 'c.tex': '3\n' });
  const notices = [];
  t = await setup(FolderSync, remote, {}, { onOnlineDelete: (paths) => notices.push([...paths]) });
  await settle(t);
  remote.docs.delete('a.tex'); remote.docs.delete('b.tex'); remote.changed.fire(undefined);
  await until(() => notices.length > 0);
  await sleep(1200);
  check('several deleted together make one notice', notices.length === 1 && notices[0].length === 2, JSON.stringify(notices));
  t.sync.dispose();

  // an empty folder inside one being deleted goes with the answer about the files
  remote = new FakeRemote({ 'main.tex': 'a\n', 'fig/one.tex': 'one\n' });
  remote.folders.add('fig/sub');
  let answerIt;
  t = await setup(FolderSync, remote, {}, { confirmRemoteDelete: (paths) => new Promise((resolve) => { t.asked.push(paths); answerIt = resolve; }) });
  await settle(t);
  check('setup: the empty folder arrived', t.exists('fig/sub'));
  fs.rmSync(path.join(t.root, 'fig'), { recursive: true });
  await until(() => answerIt);
  await sleep(SETTLE_MS);
  remote.changed.fire(undefined);
  await sleep(SETTLE_MS);
  check('while the question is open, no folder goes online', remote.foldersRemoved.length === 0, JSON.stringify(remote.foldersRemoved));
  answerIt(false);
  await until(() => t.exists('fig/one.tex') && t.exists('fig/sub'));
  check('answering no brings back the empty folder too', t.exists('fig/sub') && t.exists('fig/one.tex'));
  await settle(t);
  check('and nothing went online', remote.foldersRemoved.length === 0 && remote.removed.length === 0, JSON.stringify(remote.foldersRemoved));
  answerIt = undefined;
  fs.rmSync(path.join(t.root, 'fig'), { recursive: true });
  await until(() => answerIt);
  answerIt(true);
  await until(() => remote.foldersRemoved.includes('fig'));
  await settle(t);
  check('answering yes takes the empty folder too', remote.foldersRemoved.includes('fig/sub') && remote.foldersRemoved.includes('fig'), JSON.stringify(remote.foldersRemoved));
  check('and they stay gone', !t.exists('fig'));
  t.sync.dispose();

  // what is worth creating online
  remote = new FakeRemote({ 'main.tex': 'a\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  t.write('build/x.aux', 'ignored');
  fs.mkdirSync(path.join(t.root, 'nested', 'deep'), { recursive: true });
  t.write('onlybuild/inner/y.aux', 'ignored');
  await until(() => remote.folders.has('nested/deep'));
  await settle(t);
  check('a folder holding only what does not sync stays local', !remote.foldersCreated.includes('build') && t.exists('build/x.aux'), JSON.stringify(remote.foldersCreated));
  check('however deep', !remote.foldersCreated.some((p) => p.startsWith('onlybuild')), JSON.stringify(remote.foldersCreated));
  check('an empty folder inside others is created', remote.folders.has('nested/deep'));
  t.write('build/real.tex', 'real\n');
  await until(() => remote.docs.has('build/real.tex'));
  check('once it has something that syncs, it goes online', remote.docs.get('build/real.tex') === 'real\n');
  t.sync.dispose();

  // one folder refused
  remote = new FakeRemote({ 'main.tex': 'a\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  remote.refusedFolder = 'bad';
  fs.mkdirSync(path.join(t.root, 'bad'));
  fs.mkdirSync(path.join(t.root, 'good'));
  fs.mkdirSync(path.join(t.root, 'zgood'));
  await until(() => remote.folders.has('good') && remote.folders.has('zgood'));
  check('a folder that is refused does not stop the others', remote.folders.has('good') && remote.folders.has('zgood') && !remote.folders.has('bad'), JSON.stringify(remote.foldersCreated));
  check('and it stays locally', t.exists('bad'));
  remote.refusedFolder = undefined;
  remote.changed.fire(undefined);
  await until(() => remote.folders.has('bad'));
  check('and is tried again', remote.folders.has('bad'));
  t.sync.dispose();

  // a folder holding something that does not sync is not deleted with it
  remote = new FakeRemote({ 'main.tex': 'a\n' });
  remote.folders.add('keep');
  t = await setup(FolderSync, remote);
  await settle(t);
  check('setup: the folder arrived', t.exists('keep'));
  t.write('keep/.note', 'local only');
  await settle(t);
  check('setup: that file does not sync', ![...remote.docs.keys(), ...remote.files.keys()].includes('keep/.note'));
  remote.removeFolderOnline('keep');
  await sleep(SETTLE_MS * 2);
  await settle(t);
  check('a local file that does not sync survives its folder being deleted online', t.exists('keep/.note'));
  t.sync.dispose();

  // a failure is not recorded as having worked
  remote = new FakeRemote({ 'main.tex': 'a\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  remote.failWrites = true;
  fs.mkdirSync(path.join(t.root, 'later'));
  await sleep(SETTLE_MS);
  await settle(t);
  check('a folder that could not be created is still there locally', t.exists('later'));
  remote.failWrites = false;
  remote.changed.fire(undefined);
  await until(() => remote.folders.has('later'));
  check('and is created once that works', remote.folders.has('later'));
  t.sync.dispose();

  // folders survive a restart, and the first run with an older record loses nothing
  remote = new FakeRemote({ 'main.tex': 'a\n' });
  remote.folders.add('both');
  t = await setup(FolderSync, remote, { 'localonly/x.tex': 'x\n' });
  await settle(t);
  await t.sync.stop();
  check('setup: agreed folders are recorded', JSON.parse(fs.readFileSync(path.join(t.root, '.overleaf', 'sync', 'manifest.json'), 'utf8')).folders.includes('both'));
  fs.rmdirSync(path.join(t.root, 'both'));
  t.sync = t.make();
  await t.sync.start();
  await until(() => remote.foldersRemoved.includes('both'));
  check('a folder deleted while nothing was running goes online too', remote.foldersRemoved.includes('both'));
  t.sync.dispose();
}

/** Renames and moves online follow through, rather than looking like a deletion and a new file. */
async function testOnlineRename(FolderSync) {
  const settle = async (t) => { await t.sync.flush(); await sleep(SETTLE_MS); await t.sync.flush(); };
  const noticed = [];
  let remote = new FakeRemote({ 'old.tex': 'text\n', 'main.tex': 'm\n' });
  let t = await setup(FolderSync, remote, {}, { onOnlineDelete: (paths) => noticed.push(...paths) });
  await settle(t);

  remote.moveOnline('old.tex', 'new.tex');
  await until(() => t.exists('new.tex') && !t.exists('old.tex'));
  await settle(t);
  check('a rename online renames the local file', t.exists('new.tex') && !t.exists('old.tex') && t.read('new.tex') === 'text\n');
  check('with no notice of a deletion', noticed.length === 0, JSON.stringify(noticed));
  check('with nothing sent back', remote.writes.length === 0 && remote.renames.length === 0 && remote.removed.length === 0, JSON.stringify(remote.writes));
  const trash = path.join(t.root, '.overleaf', 'sync', 'trash');
  check('and nothing in the trash folder', !fs.existsSync(trash) || fs.readdirSync(trash).length === 0);

  remote.moveOnline('new.tex', 'sec/deep/new.tex');
  await until(() => t.exists('sec/deep/new.tex'));
  await settle(t);
  check('a move online into a new folder moves the local file', t.read('sec/deep/new.tex') === 'text\n' && !t.exists('new.tex'));

  // a tab open on it follows, and a later edit reaches the right file
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(t.root, 'sec', 'deep', 'new.tex')));
  await vscode.window.showTextDocument(document);
  remote.moveOnline('sec/deep/new.tex', 'final.tex');
  await until(() => t.exists('final.tex'));
  await settle(t);
  const open = vscode.window.activeTextEditor?.document.uri.fsPath;
  check('a tab open on the file follows it', open && path.basename(open) === 'final.tex', open);
  t.write('final.tex', 'text\nmore\n');
  await until(() => remote.docs.get('final.tex') === 'text\nmore\n');
  check('an edit after the move reaches the moved file', remote.docs.get('final.tex') === 'text\nmore\n', JSON.stringify(remote.docs.get('final.tex')));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // a local edit nobody has sent yet moves with the file
  t.sync.dispose();
  remote = new FakeRemote({ 'old.tex': 'one\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  await t.sync.stop();
  t.write('old.tex', 'one\nlocal\n');
  remote.docs.delete('old.tex');
  remote.docs.set('moved.tex', 'one\n');
  remote.moved = new Map([['moved.tex', 'old.tex']]);
  t.sync = t.make();
  await t.sync.start();
  await settle(t);
  check('an unsent local edit moves with the file', t.exists('moved.tex') && t.read('moved.tex') === 'one\nlocal\n' && !t.exists('old.tex'), t.exists('moved.tex') ? t.read('moved.tex') : 'missing');
  check('and is then sent', remote.docs.get('moved.tex') === 'one\nlocal\n', JSON.stringify(remote.docs.get('moved.tex')));
  t.sync.dispose();

  // an old copy being held moves with the file, and is not sent because of the move
  remote = new FakeRemote({ 'held.tex': 'one\n' });
  t = await setup(FolderSync, remote);
  await settle(t);
  const oldCopy = t.read('held.tex');
  remote.edit('held.tex', 'one\nby Bob\n');
  await until(() => t.read('held.tex').includes('by Bob'));
  await sleep(1300);
  t.write('held.tex', oldCopy);
  await until(() => t.sync.status.conflicts.some((x) => x.reason === 'olderCopy'));
  check('setup: an old copy is held', t.sync.status.conflicts.some((x) => x.reason === 'olderCopy'), JSON.stringify(t.sync.status));
  remote.moveOnline('held.tex', 'held-moved.tex');
  await until(() => t.exists('held-moved.tex'));
  await settle(t);
  check('a held file moved online moves locally', t.exists('held-moved.tex') && !t.exists('held.tex'));
  check('it is not sent, which would remove the online edit', remote.docs.get('held-moved.tex') === 'one\nby Bob\n' && remote.writes.length === 0, JSON.stringify(remote.docs.get('held-moved.tex')));
  check('it is still held, under its new name', t.sync.status.conflicts.some((x) => x.path === 'held-moved.tex' && x.reason === 'olderCopy'), JSON.stringify(t.sync.status.conflicts));
  t.sync.dispose();

  // where case does not count, a change of case is a rename and nothing else
  if (process.platform === 'win32') {
    const namesIn = (...parts) => fs.readdirSync(path.join(t.root, ...parts));
    remote = new FakeRemote({ 'Main.tex': 'main\n', 'Figs/a.tex': 'a\n', 'Figs/b.tex': 'b\n', 'Local.tex': 'l\n', 'Mine/x.tex': 'x\n', 'other.tex': 'o\n' });
    const noted = [];
    t = await setup(FolderSync, remote, {}, { onOnlineDelete: (paths) => noted.push(...paths) });
    await settle(t);

    remote.moveOnline('Main.tex', 'main.tex');
    await until(() => namesIn().includes('main.tex'));
    await settle(t);
    check('case changed online: the local name changes', namesIn().includes('main.tex') && !namesIn().includes('Main.tex'), namesIn().join());
    check('case changed online: the content stays', t.read('main.tex') === 'main\n');
    check('case changed online: not reported deleted', noted.length === 0, JSON.stringify(noted));
    check('case changed online: nothing is asked', t.asked.length === 0, JSON.stringify(t.asked));
    check('case changed online: nothing is sent back', remote.writes.length === 0 && remote.removed.length === 0 && remote.renames.length === 0, JSON.stringify(remote.writes));

    remote.folders.delete('Figs');
    remote.folders.add('figs');
    remote.moveOnline('Figs/a.tex', 'figs/a.tex');
    remote.moveOnline('Figs/b.tex', 'figs/b.tex');
    await until(() => namesIn().includes('figs'));
    await settle(t);
    check('a folder\'s case changed online: the local name changes', namesIn().includes('figs') && !namesIn().includes('Figs'), namesIn().join());
    check('a folder\'s case changed online: its files stay', namesIn('figs').sort().join() === 'a.tex,b.tex', namesIn('figs').join());
    check('a folder\'s case changed online: nothing is duplicated', [...remote.docs.keys()].filter((p) => p.toLowerCase().startsWith('figs/')).length === 2 && remote.writes.length === 0, JSON.stringify([...remote.docs.keys()]));
    check('a folder\'s case changed online: nothing is reported or asked', noted.length === 0 && t.asked.length === 0, JSON.stringify(noted));
    t.write('figs/a.tex', 'a\nedited\n');
    await until(() => remote.docs.get('figs/a.tex') === 'a\nedited\n');
    check('and an edit after it reaches the right file', remote.docs.get('figs/a.tex') === 'a\nedited\n');

    fs.renameSync(path.join(t.root, 'Local.tex'), path.join(t.root, 'local.tex'));
    await until(() => remote.docs.has('local.tex'));
    await settle(t);
    check('case changed locally: renamed online', remote.renames.some((r) => r.from === 'Local.tex' && r.to === 'local.tex'), JSON.stringify(remote.renames));
    check('case changed locally: no second document', !remote.docs.has('Local.tex') && remote.docs.get('local.tex') === 'l\n', JSON.stringify([...remote.docs.keys()]));
    check('case changed locally: nothing is asked', t.asked.length === 0, JSON.stringify(t.asked));

    fs.renameSync(path.join(t.root, 'Mine'), path.join(t.root, 'mine'));
    await until(() => remote.docs.has('mine/x.tex'));
    await settle(t);
    check('a folder\'s case changed locally: its file is renamed online', !remote.docs.has('Mine/x.tex') && remote.docs.get('mine/x.tex') === 'x\n', JSON.stringify([...remote.docs.keys()]));
    check('a folder\'s case changed locally: nothing is asked', t.asked.length === 0);
    check('a folder\'s case changed locally: the file stays', namesIn().includes('mine') && namesIn('mine').join() === 'x.tex');
    t.sync.dispose();
  }

  // a real deletion plus a real new file are not taken for a move
  remote = new FakeRemote({ 'a.tex': 'same\n' });
  const deleted = [];
  t = await setup(FolderSync, remote, {}, { onOnlineDelete: (paths) => deleted.push(...paths) });
  await settle(t);
  remote.docs.delete('a.tex');
  remote.docs.set('b.tex', 'same\n');
  remote.changed.fire(undefined);
  await until(() => t.exists('b.tex') && deleted.length > 0);
  check('a new file with the same text is not a move', deleted.join() === 'a.tex' && t.exists('b.tex'), JSON.stringify(deleted));
  t.sync.dispose();
}

/** The engine's records are saved from several places, which may coincide. */
async function testSavingRecords(FolderSync) {
  const t = await setup(FolderSync, new FakeRemote({ 'main.tex': 'a\n' }));
  await t.sync.flush();
  await sleep(SETTLE_MS);
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(t.root, '.overleaf', 'sync', 'manifest.json'), 'utf8'));

  let failure;
  for (let round = 0; round < 20; round++) {
    t.sync.manifestChanged = true;
    const first = t.sync.saveManifest();
    t.sync.manifestChanged = true;
    const second = t.sync.saveManifest();
    await Promise.all([first, second, t.sync.saveManifest()]).catch((e) => { failure = e; });
  }
  check('saving the records twice at once does not fail', failure === undefined, String(failure));
  check('and leaves them readable', !!onDisk().files['main.tex']);

  // a change while a save is under way
  t.sync.manifest.files['before.tex'] = { kind: 'doc', hash: 'x' };
  t.sync.manifestChanged = true;
  const saving = t.sync.saveManifest();
  await sleep(0);
  t.sync.manifest.files['during.tex'] = { kind: 'doc', hash: 'y' };
  t.sync.manifestChanged = true;
  await saving;
  await t.sync.saveManifest();
  check('a change made during a save is saved too', !!onDisk().files['during.tex'] && !!onDisk().files['before.tex'], JSON.stringify(Object.keys(onDisk().files)));
  delete t.sync.manifest.files['before.tex'];
  delete t.sync.manifest.files['during.tex'];

  // a save that fails is not the end of saving: here its folder is, for the moment, not a place anything can be written
  const realStateDir = t.sync.stateDir;
  t.sync.stateDir = vscode.Uri.file(path.join(t.root, 'main.tex', 'not-a-folder'));
  t.sync.manifest.files['retried.tex'] = { kind: 'doc', hash: 'z' };
  t.sync.manifestChanged = true;
  const refused = await t.sync.saveManifest().then(() => false, () => true);
  check('a save that fails reports it', refused);
  check('and is still to be done', t.sync.manifestChanged === true);
  t.sync.stateDir = realStateDir;
  await t.sync.saveManifest();
  check('and the next one works', !!onDisk().files['retried.tex'], JSON.stringify(Object.keys(onDisk().files)));
  delete t.sync.manifest.files['retried.tex'];
  t.sync.dispose();
}

/** Deleting the local folder is no statement about the online project. */
async function testFolderDeleted(FolderSync) {
  let linked = true;
  const remote = new FakeRemote({ 'main.tex': 'a\n', 'sec/one.tex': 'one\n' });
  const t = await setup(FolderSync, remote, {}, { stillLinked: async () => linked });
  await t.sync.flush();
  await sleep(SETTLE_MS);

  linked = false;
  fs.rmSync(t.root, { recursive: true, force: true });
  await sleep(SETTLE_MS * 2);
  check('deleting the whole folder asks nothing', t.asked.length === 0, JSON.stringify(t.asked));
  check('and deletes nothing online', remote.removed.length === 0 && remote.foldersRemoved.length === 0 && remote.docs.size === 2);
  remote.edit('main.tex', 'a\nfrom a collaborator\n');
  await sleep(SETTLE_MS);
  await t.sync.flush();
  check('a later online edit does not bring the folder back', !fs.existsSync(t.root), fs.existsSync(t.root) ? fs.readdirSync(t.root).join() : '');
  check('still nothing asked or deleted', t.asked.length === 0 && remote.removed.length === 0);
  t.sync.dispose();

  // a deletion answered while the folder goes
  linked = true;
  const remote2 = new FakeRemote({ 'main.tex': 'a\n', 'two.tex': 'two\n' });
  let answering;
  const t2 = await setup(FolderSync, remote2, {}, {
    stillLinked: async () => linked,
    confirmRemoteDelete: (paths) => new Promise((resolve) => { answering = () => resolve(true); t2.asked.push(paths); }),
  });
  await t2.sync.flush();
  await sleep(SETTLE_MS);
  t2.remove('two.tex');
  await until(() => answering);
  linked = false;
  fs.rmSync(t2.root, { recursive: true, force: true });
  answering();
  await sleep(SETTLE_MS);
  check('a yes given after the folder went deletes nothing', remote2.removed.length === 0 && remote2.docs.has('two.tex'), JSON.stringify(remote2.removed));
  check('and brings back nothing', !fs.existsSync(t2.root));
  t2.sync.dispose();

  // an engine told to stop writes nothing more
  const remote3 = new FakeRemote({ 'main.tex': 'a\n' });
  const t3 = await setup(FolderSync, remote3);
  await t3.sync.flush();
  await sleep(SETTLE_MS);
  fs.rmSync(t3.root, { recursive: true, force: true });
  t3.sync.dispose();
  await t3.sync.saveManifest();
  check('a stopped engine does not recreate its records', !fs.existsSync(t3.root));
}

/** What the project's standing on Overleaf does to a linked folder. */
async function testStanding(FolderSyncManager, LocalReplicaSCMProvider) {
  const PROJECT = 'overleaf-workshop://www.overleaf.com/Paper?user=u&project=p9';
  const parent = path.join(workspaceRoot(), 'standing');
  const folder = path.join(parent, 'overleaf-Paper');
  const settingsFile = path.join(folder, '.overleaf', 'settings.json');
  const make = () => {
    const seen = { started: 0, forgotten: 0, standing: 'active' };
    const manager = new FolderSyncManager({
      projectStanding: async () => { if (seen.standing === 'throws') throw new Error('offline'); return seen.standing; },
      forget: () => { seen.forgotten++; },
      setGate: (uri, open) => { seen.gate = open; },
    });
    Object.assign(manager, {
      startTicking: () => {},
      workspaceFolder: () => vscode.Uri.file(parent),
      warnAboutOtherLinks: async () => {},
      start: async (f, u) => {
        seen.started++;
        manager.folder = f; manager.projectUri = u; manager.paused = undefined;
        LocalReplicaSCMProvider.detached = false;
        manager.sync = { dispose() {}, stop: async () => {}, status: { connected: true, conflicts: [], failed: [], refused: [], pending: 0 } };
      },
    });
    return { manager, seen };
  };
  const reset = () => {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.mkdirSync(path.join(folder, '.overleaf'), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ uri: PROJECT, projectName: 'Paper', enableCompileNPreview: true }));
    fs.writeFileSync(path.join(folder, 'main.tex'), 'keep me\n');
  };

  // opening the window
  reset();
  let { manager, seen } = make();
  await manager.resume();
  check('active: syncing starts', seen.started === 1 && !LocalReplicaSCMProvider.detached);

  seen.standing = 'trashed';
  await manager.checkStanding();
  check('moved to the trash: syncing pauses', manager.paused === 'trashed' && !manager.sync);
  check('moved to the trash: the connection is closed', seen.forgotten === 1);
  check('moved to the trash: nothing can reconnect by itself', LocalReplicaSCMProvider.detached === true && (await LocalReplicaSCMProvider.readSettings()) === undefined);
  check('moved to the trash: the status bar says so', /已暂停/.test(manager.statusItem.text), manager.statusItem.text);
  check('moved to the trash: the files stay', fs.readFileSync(path.join(folder, 'main.tex'), 'utf8') === 'keep me\n');
  await manager.checkStanding();
  check('still in the trash: nothing more happens', seen.started === 1 && seen.forgotten === 1);

  seen.standing = 'active';
  await manager.checkStanding();
  check('restored: syncing continues by itself', seen.started === 2 && !manager.paused && !LocalReplicaSCMProvider.detached);

  seen.standing = 'archived';
  await manager.checkStanding();
  check('archived: syncing pauses too', manager.paused === 'archived' && !manager.sync && LocalReplicaSCMProvider.detached === true);
  seen.standing = 'active';
  await manager.checkStanding();
  check('unarchived: syncing continues', seen.started === 3 && !manager.paused);

  // what cannot be told changes nothing
  for (const each of ['unknown', 'throws']) {
    seen.standing = each;
    await manager.checkStanding();
    check(`${each}: syncing carries on`, !!manager.sync && !manager.paused && seen.started === 3);
  }
  const syncing = manager.sync;

  // a lapsed login
  seen.standing = 'loggedOut';
  await manager.checkStanding();
  check('login expired: syncing is not ended', manager.sync === syncing && manager.folder !== undefined);
  check('login expired: the status bar says what to do', /登录/.test(manager.statusItem.text), manager.statusItem.text);
  check('login expired: the link is not marked as ended', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ended === undefined);
  manager.renderStatus(syncing.status);
  check('login expired: a status update does not hide it', /登录/.test(manager.statusItem.text), manager.statusItem.text);
  seen.standing = 'active';
  const forgottenBefore = seen.forgotten;
  await manager.checkStanding();
  check('logged in again: connects anew, with the new login', seen.started === 4 && seen.forgotten === forgottenBefore + 1);

  // a connection that stopped trying
  manager.remote = { hasGivenUp: true, dispose() {} };
  await manager.checkStanding();
  check('a connection that gave up is started again once the project answers', seen.started === 5, String(seen.started));
  manager.remote = undefined;

  // the project being gone
  seen.standing = 'gone';
  await manager.checkStanding();
  check('gone: this window lets go', !manager.hasLinkedFolder && !manager.sync);
  check('gone: the files stay', fs.readFileSync(path.join(folder, 'main.tex'), 'utf8') === 'keep me\n');
  check('gone: the link is marked as ended, not deleted', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ended === true);
  check('gone: an ended folder is not looked for again', (await LocalReplicaSCMProvider.findProjectFolder(vscode.Uri.file(parent))) === undefined);
  const startedAtEnd = seen.started;
  await manager.resume();
  check('gone: a later reopening starts nothing', seen.started === startedAtEnd && !manager.hasLinkedFolder);
  check('gone: nothing pretends to be connected', !LocalReplicaSCMProvider.detached);

  // a new link next to it, and over it
  const fresh = make();
  fresh.manager.confirmLink = async () => true;
  await fresh.manager.linkProject({ uri: 'overleaf-workshop://www.overleaf.com/Other?user=u&project=p10', label: 'Other' });
  check('gone: another project can be linked here', fresh.seen.started === 1);
  fs.rmSync(path.join(parent, 'overleaf-Other'), { recursive: true });
  LocalReplicaSCMProvider.forgetProjectRoot();
  const syncRecords = path.join(folder, '.overleaf', 'sync');
  fs.mkdirSync(syncRecords, { recursive: true });
  fs.writeFileSync(path.join(syncRecords, 'manifest.json'), JSON.stringify({ version: 1, files: { 'main.tex': { kind: 'doc', hash: 'x', remoteVersion: 'old' } } }));
  const again = make();
  again.manager.confirmLink = async () => true;
  await again.manager.linkProject({ uri: PROJECT, label: 'Paper' });
  check('a new project of the same name can take over the folder', again.seen.started === 1 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ended === undefined);
  check('without the old project\'s records making its files look deleted', !fs.existsSync(path.join(syncRecords, 'manifest.json')));
  check('and keeping the files', fs.readFileSync(path.join(folder, 'main.tex'), 'utf8') === 'keep me\n');

  // opening a window onto a project that is away
  reset();
  ({ manager, seen } = make());
  seen.standing = 'trashed';
  await manager.resume();
  check('opened while in the trash: never connects', seen.started === 0 && seen.forgotten === 0);
  check('opened while in the trash: says so', manager.paused === 'trashed' && /已暂停/.test(manager.statusItem.text));
  check('opened while in the trash: nothing else can connect', (await LocalReplicaSCMProvider.readSettings()) === undefined);
  seen.standing = 'active';
  await manager.checkStanding();
  check('opened while in the trash: starts once restored', seen.started === 1);

  reset();
  ({ manager, seen } = make());
  seen.standing = 'gone';
  await manager.resume();
  check('opened once gone: never connects, and lets go', seen.started === 0 && !manager.hasLinkedFolder && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ended === true);

  reset();
  ({ manager, seen } = make());
  seen.standing = 'loggedOut';
  await manager.resume();
  check('opened logged out: does not try to connect', seen.started === 0 && /登录/.test(manager.statusItem.text));
  seen.standing = 'active';
  await manager.checkStanding();
  check('opened logged out: starts once logged in', seen.started === 1);

  reset();
  ({ manager, seen } = make());
  seen.standing = 'unknown';
  await manager.resume();
  check('opened offline: tries to connect as usual, offline being no reason to stop', seen.started === 1);

  reset();
  ({ manager, seen } = make());
  seen.standing = 'offline';
  await manager.resume();
  check('opened with no connection: does not try, which would only fail with messages', seen.started === 0 && /离线/.test(manager.statusItem.text), manager.statusItem.text);
  await manager.checkStanding();
  check('opened with no connection: still waiting', seen.started === 0 && manager.hasLinkedFolder);
  seen.standing = 'active';
  await manager.checkStanding();
  check('opened with no connection: starts once Overleaf answers', seen.started === 1);

  // what may connect to the project
  reset();
  ({ manager, seen } = make());
  let answered;
  manager.provider.projectStanding = () => new Promise((resolve) => { answered = resolve; });
  const opening = manager.resume();
  await until(() => answered);
  let gateOpen;
  seen.gate.then((open) => { gateOpen = open; });
  await sleep(50);
  check('a tab restored while opening waits for the answer', gateOpen === undefined);
  answered('active');
  await opening;
  await sleep(10);
  check('and may connect once the project is there', gateOpen === true);
  seen.standing = 'trashed';
  manager.provider.projectStanding = async () => seen.standing;
  await manager.checkStanding();
  check('in the trash: nothing may connect', (await seen.gate) === false);
  seen.standing = 'gone';
  await manager.checkStanding();
  check('gone: nothing may connect', (await seen.gate) === false);
  const later = make();
  later.seen.gate = undefined;
  await later.manager.resume();
  check('gone, and the window reopened: nothing may connect', (await later.seen.gate) === false);

  // opening from inside
  reset();
  fs.mkdirSync(path.join(folder, '.overleaf', 'sync'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.overleaf', 'sync', 'manifest.json'), '{"version":1,"files":{}}');
  ({ manager, seen } = make());
  manager.workspaceFolder = () => vscode.Uri.file(folder);
  manager.warnAboutOpeningFromInside = async () => { seen.warned = true; };
  await manager.resume();
  check('opened from inside: says so', seen.warned === true);
  check('opened from inside: nothing connects, as the project may be in the trash', LocalReplicaSCMProvider.detached === true && (await LocalReplicaSCMProvider.readSettings()) === undefined);
  LocalReplicaSCMProvider.detached = false;

  // a connection that never got going
  reset();
  ({ manager, seen } = make());
  delete manager.start;
  manager.provider.prefetch = async () => { throw new Error('no connection'); };
  manager.leaveCompilingToOverleaf = async () => {};
  await manager.resume();
  check('connecting fails: the connection is thrown away, as it does not retry', seen.forgotten === 1 && !manager.sync, String(seen.forgotten));
  check('connecting fails: the status bar says offline', /离线/.test(manager.statusItem.text), manager.statusItem.text);
  check('connecting fails: this window keeps looking after the folder', manager.hasLinkedFolder);

  // the folder going while connecting
  reset();
  ({ manager, seen } = make());
  delete manager.start;
  manager.provider.prefetch = async () => ({ init: async () => { fs.rmSync(folder, { recursive: true, force: true }); } });
  manager.leaveCompilingToOverleaf = async () => {};
  await manager.resume();
  check('the folder deleted while connecting: it is not brought back', !fs.existsSync(folder), fs.existsSync(folder) ? fs.readdirSync(folder).join() : '');
  check('the folder deleted while connecting: syncing does not start', !manager.sync);

  // sending what is pending before the project goes away
  const realWarning = vscode.window.showWarningMessage;
  const warnings = [];
  let warningAnswer;
  vscode.window.showWarningMessage = async (message) => { warnings.push(message); return warningAnswer; };
  reset();
  ({ manager, seen } = make());
  await manager.resume();
  const status = { connected: true, conflicts: [], failed: [], refused: [], pending: 0 };
  let flushed = 0;
  manager.sync = { dispose() {}, stop: async () => {}, flush: async () => { flushed++; }, status };
  check('leaving with everything sent: no question', (await manager.sendBeforeLeaving('p9')) === true && warnings.length === 0 && flushed === 1);
  check('leaving another project: not this one\'s concern', (await manager.sendBeforeLeaving('other')) === true && flushed === 1);
  status.connected = false;
  status.pending = 2;
  check('leaving with no connection: asks, and no answer means stay', (await manager.sendBeforeLeaving('p9')) === false && warnings.length === 1, JSON.stringify(warnings));
  warningAnswer = '继续';
  check('leaving with no connection: going on is allowed', (await manager.sendBeforeLeaving('p9')) === true);
  status.connected = true;
  status.pending = 0;
  status.failed = ['main.tex'];
  warnings.length = 0;
  await manager.sendBeforeLeaving('p9');
  check('leaving with a file not sent: names it', warnings.length === 1 && warnings[0].includes('main.tex'), JSON.stringify(warnings));

  // emptying the project asks in its own way, with keeping the files as the default
  const shown = [];
  vscode.window.showWarningMessage = async (message, options, ...items) => { shown.push({ message, modal: options?.modal, items }); return shown.answer; };
  manager.remote = { list: async () => [{ path: 'a.tex' }, { path: 'b.tex' }], dispose() {} };
  shown.answer = undefined;
  check('deleting everything: dismissing keeps the files', (await manager.confirmRemoteDelete(['a.tex', 'b.tex'])) === false);
  check('deleting everything: says it empties the project', /清空线上项目/.test(shown[0].message) && shown[0].modal === true, shown[0].message);
  check('deleting everything: the default button keeps the files', shown[0].items[0] === '恢复到本地' && shown[0].items[1] === '清空线上项目', JSON.stringify(shown[0].items));
  shown.answer = '恢复到本地';
  check('deleting everything: keeping is keeping', (await manager.confirmRemoteDelete(['a.tex', 'b.tex'])) === false);
  shown.answer = '清空线上项目';
  check('deleting everything: it can be done', (await manager.confirmRemoteDelete(['a.tex', 'b.tex'])) === true);
  shown.length = 0;
  shown.answer = '从 Overleaf 删除';
  check('deleting some: the plain question', (await manager.confirmRemoteDelete(['a.tex'])) === true && !/清空/.test(shown[0].message), shown[0].message);
  vscode.window.showWarningMessage = realWarning;

  // a check asked for while one is under way is not lost
  reset();
  ({ manager, seen } = make());
  await manager.resume();
  let release;
  const realStanding = manager.provider.projectStanding;
  manager.provider.projectStanding = () => new Promise((resolve) => { release = () => resolve('active'); });
  const first = manager.checkStanding();
  await until(() => release);
  manager.provider.projectStanding = async () => 'trashed';
  manager.checkStanding();
  release();
  await first;
  check('a check asked for during another still happens', manager.paused === 'trashed');
  manager.provider.projectStanding = realStanding;

  // a project folder opened directly, once ended, is an ordinary folder there too
  const rootSettings = path.join(workspaceRoot(), '.overleaf', 'settings.json');
  fs.mkdirSync(path.dirname(rootSettings), { recursive: true });
  fs.writeFileSync(rootSettings, JSON.stringify({ uri: PROJECT, ended: true }));
  LocalReplicaSCMProvider.forgetProjectRoot();
  check('an ended link in the open folder reads as no link', (await LocalReplicaSCMProvider.readSettings()) === undefined);
  fs.rmSync(path.dirname(rootSettings), { recursive: true, force: true });
  LocalReplicaSCMProvider.forgetProjectRoot();

  // the local folder going, and coming back
  reset();
  ({ manager, seen } = make());
  await manager.resume();
  const moved = `${parent}-moved`;
  fs.rmSync(moved, { recursive: true, force: true });
  fs.renameSync(parent, moved);
  fs.mkdirSync(parent);
  manager.lastStandingCheck = Date.now();
  await manager.tick();
  check('folder deleted: this window lets go', !manager.hasLinkedFolder && !manager.sync);
  check('folder deleted: the connection is closed', seen.forgotten === 1);
  check('folder deleted: nothing is recreated', fs.readdirSync(parent).length === 0, fs.readdirSync(parent).join());
  check('folder deleted: not paused or waiting', !LocalReplicaSCMProvider.detached);
  fs.rmSync(parent, { recursive: true });
  fs.renameSync(moved, parent);
  manager.lastLookForLink = 0;
  await manager.tick();
  check('folder restored from the recycle bin: syncing resumes', seen.started === 2 && manager.hasLinkedFolder, String(seen.started));

  // a passing failure to look is not the folder being gone
  const realStat = Object.getOwnPropertyDescriptor(manager, 'exists');
  check('setup: exists is on the prototype', realStat === undefined);
  check('a definite not-found reads as missing', (await manager.exists(vscode.Uri.file(path.join(parent, 'nothing-here')))) === false);
  manager.stopTicking();

  // paused, and the folder is deleted
  reset();
  ({ manager, seen } = make());
  seen.standing = 'trashed';
  await manager.resume();
  fs.rmSync(folder, { recursive: true });
  await manager.tick();
  check('folder deleted while paused: this window lets go', !manager.hasLinkedFolder && !manager.paused && !LocalReplicaSCMProvider.detached);
  check('folder deleted while paused: it stays deleted', !fs.existsSync(folder));

  fs.rmSync(parent, { recursive: true, force: true });
  LocalReplicaSCMProvider.detached = false;
  LocalReplicaSCMProvider.forgetProjectRoot();
}

/** How the answers from the server are read. Everything uncertain has to come out as "cannot tell". */
async function testProjectStanding(RemoteFileSystemProvider, BaseAPI) {
  const uri = vscode.Uri.parse('overleaf-workshop://www.overleaf.com/Paper?user=me&project=p1');
  const persists = (login) => ({ 'www.overleaf.com': { name: 'www.overleaf.com', url: 'https://www.overleaf.com/', login } });
  const standing = async ({ list, fallback, entities, login = { userId: 'me', identity: {} } }) => {
    const saved = { ...BaseAPI.prototype };
    const calls = [];
    BaseAPI.prototype.getProjectsJson = async () => { calls.push('list'); return list; };
    BaseAPI.prototype.userProjectsJson = async () => { calls.push('fallback'); return fallback ?? { type: 'error', message: '404: ' }; };
    BaseAPI.prototype.projectEntitiesJson = async () => { calls.push('entities'); return entities ?? { type: 'success', entities: [] }; };
    const provider = Object.create(RemoteFileSystemProvider.prototype);
    provider.context = { globalState: { get: () => persists(login), update: async () => {} } };
    try {
      return await provider.projectStanding(uri);
    } finally {
      Object.assign(BaseAPI.prototype, { getProjectsJson: saved.getProjectsJson, userProjectsJson: saved.userProjectsJson, projectEntitiesJson: saved.projectEntitiesJson });
    }
  };
  const listing = (...projects) => ({ type: 'success', projects });
  const other = { id: 'p2' };

  check('in the list: active', await standing({ list: listing({ id: 'p1' }, other) }) === 'active');
  check('flagged trashed', await standing({ list: listing({ id: 'p1', trashed: true }) }) === 'trashed');
  check('flagged archived', await standing({ list: listing({ id: 'p1', archived: true }) }) === 'archived');
  check('absent and refused: gone', await standing({ list: listing(other), entities: { type: 'error', message: '403: Forbidden' } }) === 'gone');
  check('absent and not found: gone', await standing({ list: listing(other), entities: { type: 'error', message: '404: Not found' } }) === 'gone');
  check('absent but still readable: cannot tell', await standing({ list: listing(other) }) === 'unknown');
  check('absent and a server error: cannot tell', await standing({ list: listing(other), entities: { type: 'error', message: '500: oops' } }) === 'unknown');
  check('absent and offline: cannot tell', await standing({ list: listing(other), entities: { type: 'error', message: 'fetch failed' } }) === 'unknown');
  check('an empty list alone is not enough', await standing({ list: listing() }) === 'unknown');
  check('no connection: says so', await standing({ list: { type: 'error', message: 'fetch failed' }, fallback: { type: 'error', message: 'fetch failed' } }) === 'offline');
  check('a server error: cannot tell', await standing({ list: { type: 'error', message: '500: oops' } }) === 'unknown');
  check('the older list works too', await standing({ list: { type: 'error', message: '404: ' }, fallback: listing({ id: 'p1' }) }) === 'active');
  check('the older list leaves out the trash, which must not read as gone', await standing({ list: { type: 'error', message: '404: ' }, fallback: listing(other) }) === 'unknown');
  check('a redirect to log in: logged out', await standing({ list: { type: 'error', message: '302: Found' } }) === 'loggedOut');
  check('a redirect while checking the project: logged out', await standing({ list: listing(other), entities: { type: 'error', message: '302: Found' } }) === 'loggedOut');
  check('no login: logged out', await standing({ list: listing(), login: null }) === 'loggedOut');
  check('another account logged in: logged out, not gone', await standing({ list: listing(other), login: { userId: 'someone-else', identity: {} }, entities: { type: 'error', message: '403: ' } }) === 'loggedOut');

  // the gate in front of connecting
  const gated = Object.create(RemoteFileSystemProvider.prototype);
  Object.assign(gated, { context: {}, vfss: { [uri.query]: { itIs: 'the connection' } }, gates: new Map() });
  check('with no gate, connecting goes ahead', (await gated.prefetch(uri)).itIs === 'the connection');
  gated.setGate(uri, Promise.resolve(false));
  const refused = await gated.prefetch(uri).then(() => false, () => true);
  check('with a closed gate, it is refused', refused);
  gated.setGate(uri, Promise.resolve(true));
  check('with an open gate, it goes ahead', (await gated.prefetch(uri)).itIs === 'the connection');
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
    await testSafety(FolderSync, merge);
    await testFolders(FolderSync);
    await testOnlineRename(FolderSync);
    await testSavingRecords(FolderSync);
    await testFolderDeleted(FolderSync);
    await testStanding(require(path.join(out, 'sync', 'index.js')).FolderSyncManager, require(path.join(out, 'scm', 'localReplicaSCM.js')).LocalReplicaSCMProvider);
    await testProjectStanding(require(path.join(out, 'core', 'remoteFileSystemProvider.js')).RemoteFileSystemProvider, require(path.join(out, 'api', 'base.js')).BaseAPI);
    await testConnection(require(path.join(out, 'api', 'socketio.js')).SocketIOAPI);
  } catch (e) {
    results.push(`ERROR ${e && e.stack}`);
  } finally {
    fs.writeFileSync(path.join(here, 'results.txt'), results.join('\n') + '\n', 'utf8');
  }
};

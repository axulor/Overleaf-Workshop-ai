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
    this.renames = [];
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
  async remove(p) { this.removed.push(p); this.docs.delete(p); this.files.delete(p); }
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
    await testSafety(FolderSync, merge);
    await testConnection(require(path.join(out, 'api', 'socketio.js')).SocketIOAPI);
  } catch (e) {
    results.push(`ERROR ${e && e.stack}`);
  } finally {
    fs.writeFileSync(path.join(here, 'results.txt'), results.join('\n') + '\n', 'utf8');
  }
};

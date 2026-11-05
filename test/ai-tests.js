// Runs inside an isolated VS Code. The MCP server runs as a real child process, spoken to over its real protocol.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');

const here = process.env.OVERLEAF_AI_TEST_DIR;
const out = path.join(__dirname, '..', 'out');
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const workspaceRoot = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

function testLineDiff({ unifiedDiff }) {
  check('diff: identical texts give nothing', unifiedDiff('a\nb\n', 'a\nb\n') === '');
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', ''].join('\n');
  let diff = unifiedDiff(before, before.replace('five', 'FIVE'));
  check('diff: a change shows both versions', diff.includes('-five') && diff.includes('+FIVE'), JSON.stringify(diff));
  check('diff: with context around it', diff.includes(' four') && diff.includes(' six'), JSON.stringify(diff));
  check('diff: but not the whole file', !diff.includes('one') && !diff.includes('ten'), JSON.stringify(diff));
  check('diff: with the right line numbers', diff.startsWith('@@ -3,5 +3,5 @@'), JSON.stringify(diff.split('\n')[0]));
  diff = unifiedDiff(before, before.replace('two', 'TWO').replace('nine', 'NINE'));
  check('diff: distant changes get separate hunks', diff.split('\n').filter((l) => l.startsWith('@@')).length === 2, JSON.stringify(diff));
  check('diff: the second hunk has the right numbers', diff.split('\n').filter((l) => l.startsWith('@@'))[1].startsWith('@@ -7,'), JSON.stringify(diff));
  diff = unifiedDiff('a\n', 'a\nb\n');
  check('diff: an added line', diff.includes('+b'), JSON.stringify(diff));
  diff = unifiedDiff('', '第一段\n');
  check('diff: Chinese text', diff.includes('+第一段'), JSON.stringify(diff));
}

async function testTranslationState({ TranslationState }) {
  const root = path.join(workspaceRoot(), 'translation-case');
  const project = path.join(root, 'overleaf-Paper');
  const zh = path.join(root, 'zh');
  const write = (p, content) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), content); };
  write('overleaf-Paper/main.tex', '\\section{Intro}\nEnglish one.\n');
  write('overleaf-Paper/.overleaf/settings.json', '{}');
  write('overleaf-Paper/.overleaf/hidden.tex', 'not part of the paper');
  write('zh/01-引言.md', '# 引言\n\n中文一。\n');
  write('zh/notes.txt', 'not a manuscript');
  const make = () => new TranslationState(vscode.Uri.file(root), vscode.Uri.file(project));
  let state = make();
  const TEX = 'overleaf-Paper/main.tex', MD = 'zh/01-引言.md';

  let thrown = false;
  await state.markSynced([]).catch(() => { thrown = true; });
  check('marking before looking is refused', thrown);

  // the first round
  let changes = await state.changes();
  check('first round: not initialized', changes.initialized === false);
  check('first round: lists both languages', changes.chinese.length === 1 && changes.english.length === 1 && changes.chinese[0].path === MD && changes.english[0].path === TEX, JSON.stringify(changes));
  check('first round: names the folders', changes.chineseFolder === 'zh' && changes.projectFolder === 'overleaf-Paper');
  check('first round: no diffs, since there is no base', changes.chinese[0].diff === undefined);
  check('hidden folders and other files are not tracked', ![...changes.chinese, ...changes.english, ...changes.images].some((c) => /hidden|notes/.test(c.path)));
  let marked = await state.markSynced([]);
  check('marking records everything', marked.marked.length === 2 && marked.notMarked.length === 0, JSON.stringify(marked));

  changes = await state.changes();
  check('after marking: initialized and nothing to do', changes.initialized && changes.chinese.length === 0 && changes.english.length === 0, JSON.stringify(changes));
  await state.markSynced([]);

  // a new instance, as after restarting VS Code
  state = make();
  changes = await state.changes();
  check('it survives a restart', changes.initialized && changes.chinese.length === 0);

  // Chinese to English, without bouncing back
  write(MD, '# 引言\n\n中文一，修改过。\n');
  changes = await state.changes();
  check('a Chinese edit is listed with a diff', changes.chinese.length === 1 && changes.chinese[0].status === 'modified' && changes.chinese[0].diff.includes('+中文一，修改过。') && changes.chinese[0].diff.includes('-中文一。'), JSON.stringify(changes.chinese));
  check('the English side is not', changes.english.length === 0);
  write(TEX, '\\section{Intro}\nEnglish one, edited.\n');
  marked = await state.markSynced([TEX]);
  check('a translation can be marked', marked.notMarked.length === 0 && marked.marked.includes(TEX), JSON.stringify(marked));
  changes = await state.changes();
  check('the translation is not taken for a new English change', changes.english.length === 0 && changes.chinese.length === 0, JSON.stringify(changes));
  await state.markSynced([]);

  // English to Chinese
  write(TEX, '\\section{Intro}\nEnglish one, polished by a collaborator.\n');
  changes = await state.changes();
  check('an English edit is listed with a diff', changes.english.length === 1 && changes.english[0].diff.includes('+English one, polished by a collaborator.'), JSON.stringify(changes.english));
  write(MD, '# 引言\n\n中文一，已同步。\n');
  marked = await state.markSynced([MD]);
  changes = await state.changes();
  check('that translation is not taken for a new Chinese change', changes.chinese.length === 0 && changes.english.length === 0, JSON.stringify(changes));
  await state.markSynced([]);

  // the trap: a collaborator edits online while the assistant is translating
  write(MD, '# 引言\n\n中文一，再改。\n');
  await state.changes();
  write(TEX, '\\section{Intro}\nEnglish translated.\n');
  state.noteReceived('main.tex');
  write(TEX, '\\section{Intro}\nEnglish translated, and a collaborator was here.\n');
  marked = await state.markSynced([TEX]);
  check('a file a collaborator changed meanwhile is not marked', marked.notMarked.length === 1 && marked.notMarked[0].path === TEX && marked.notMarked[0].reason.includes('collaborator'), JSON.stringify(marked));
  check('the other side still is', marked.marked.includes(MD));
  changes = await state.changes();
  check('so the next round shows that file again', changes.english.length === 1 && changes.english[0].diff.includes('a collaborator was here'), JSON.stringify(changes.english));
  await state.markSynced([]);

  // the same trap: the user keeps writing during a round
  await state.changes();
  write(MD, '# 引言\n\n用户在同步期间写的。\n');
  marked = await state.markSynced([]);
  check('a file the user changed meanwhile is not marked', marked.notMarked.some((n) => n.path === MD), JSON.stringify(marked));
  changes = await state.changes();
  check('so the next round shows it', changes.chinese.length === 1 && changes.chinese[0].diff.includes('用户在同步期间写的'));
  await state.markSynced([]);

  // new and deleted files
  await state.changes();
  write('zh/02-方法.md', '# 方法\n');
  write('overleaf-Paper/sections/methods.tex', '\\section{Methods}\n');
  marked = await state.markSynced(['overleaf-Paper/sections/methods.tex']);
  check('a new file you made is marked', marked.marked.includes('overleaf-Paper/sections/methods.tex'), JSON.stringify(marked));
  check('a new file you did not make is not', marked.notMarked.some((n) => n.path === 'zh/02-方法.md'), JSON.stringify(marked));
  changes = await state.changes();
  check('and shows up next as added', changes.chinese.length === 1 && changes.chinese[0].status === 'added', JSON.stringify(changes.chinese));
  await state.markSynced([]);
  fs.rmSync(path.join(root, 'zh/02-方法.md'));
  changes = await state.changes();
  check('a deleted file is listed', changes.chinese.length === 1 && changes.chinese[0].status === 'deleted' && changes.chinese[0].diff.includes('-# 方法'), JSON.stringify(changes.chinese));
  marked = await state.markSynced([]);
  changes = await state.changes();
  check('and is gone once marked', changes.chinese.length === 0, JSON.stringify(changes.chinese));
  await state.markSynced([]);

  // line endings alone are not a change
  write(TEX, fs.readFileSync(path.join(root, TEX), 'utf8').replace(/\n/g, '\r\n'));
  changes = await state.changes();
  check('line endings alone are not a change', changes.english.length === 0, JSON.stringify(changes.english));
  await state.markSynced([]);

  // Windows-style paths from an assistant
  await state.changes();
  write(TEX, '\\section{Intro}\nBackslash path.\n');
  marked = await state.markSynced(['overleaf-Paper\\main.tex']);
  check('a path with backslashes still counts', marked.notMarked.length === 0, JSON.stringify(marked));

  // images
  await state.changes();
  await state.markSynced([]);
  write('zh/images/fig1.png', 'PNG1');
  changes = await state.changes();
  check('a new image is listed', changes.images.length === 1 && changes.images[0].path === 'zh/images/fig1.png' && changes.images[0].status === 'added', JSON.stringify(changes.images));
  check('with no diff', changes.images[0].diff === undefined);
  await state.markSynced([]);
  write('zh/images/fig1.png', 'PNG2');
  changes = await state.changes();
  check('a changed image is listed', changes.images.length === 1 && changes.images[0].status === 'modified', JSON.stringify(changes.images));
  await state.markSynced([]);
}

function spawnServer(root) {
  const child = cp.spawn(process.execPath, [path.join(out, 'ai', 'mcpServer.js'), root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const all = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    all.push(message);
    const resolve = waiting.get(message.id);
    if (resolve) { waiting.delete(message.id); resolve(message); }
  });
  let nextId = 1;
  return {
    child, all,
    rpc(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => reject(new Error(`no reply to ${method}`)), 15000);
      });
    },
    raw(text) { child.stdin.write(text + '\n'); },
  };
}

async function testMcp({ AiBridge }, { TOOLS }) {
  const root = path.join(workspaceRoot(), 'mcp-case');
  const project = path.join(root, 'overleaf-Paper');
  fs.mkdirSync(path.join(project, '.overleaf'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const seen = [];
  const bridge = new AiBridge(vscode.Uri.file(project), {
    status: async () => ({ connected: true, 中文: '可以' }),
    compile: async (args) => { seen.push(args); throw new Error('the compile broke'); },
    // eslint-disable-next-line camelcase
    translation_mark_synced: async (args) => { seen.push(args); return { marked: args.edited }; },
    translation_changes: async () => undefined,
  });
  await bridge.start();
  const bridgeFile = path.join(project, '.overleaf', 'bridge.json');
  check('the bridge file is written', fs.existsSync(bridgeFile));

  const server = spawnServer(root);
  const init = await server.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('mcp: initialize answers with the client\'s version', init.result?.protocolVersion === '2025-03-26', JSON.stringify(init));
  check('mcp: it offers tools', init.result?.capabilities?.tools !== undefined);
  server.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const count = server.all.length;
  check('mcp: ping works', (await server.rpc('ping')).result !== undefined);
  check('mcp: a notification gets no reply', server.all.length === count + 1);

  const list = await server.rpc('tools/list');
  check('mcp: the tools are listed', list.result.tools.map((t) => t.name).join() === TOOLS.map((t) => t.name).join(), JSON.stringify(list.result.tools.map((t) => t.name)));
  check('mcp: every tool describes itself', list.result.tools.every((t) => t.description.length > 20 && t.inputSchema.type === 'object'));

  let call = await server.rpc('tools/call', { name: 'status', arguments: {} });
  check('mcp: a tool call reaches VS Code', !call.result.isError && JSON.parse(call.result.content[0].text).connected === true, JSON.stringify(call));
  check('mcp: Chinese comes through intact', JSON.parse(call.result.content[0].text).中文 === '可以');
  call = await server.rpc('tools/call', { name: 'translation_mark_synced', arguments: { edited: ['zh/文件.md'] } });
  check('mcp: arguments come through', seen[0]?.edited?.[0] === 'zh/文件.md', JSON.stringify(seen));
  call = await server.rpc('tools/call', { name: 'translation_changes' });
  check('mcp: a tool with no result still answers', !call.result.isError, JSON.stringify(call));
  call = await server.rpc('tools/call', { name: 'compile' });
  check('mcp: a failing tool reports it for the assistant to read', call.result.isError === true && call.result.content[0].text === 'the compile broke', JSON.stringify(call));
  call = await server.rpc('tools/call', { name: 'no_such_tool' });
  check('mcp: an unknown tool is a protocol error', call.error?.code === -32602, JSON.stringify(call));
  call = await server.rpc('no/such/method');
  check('mcp: an unknown method is a protocol error', call.error?.code === -32601, JSON.stringify(call));
  const before = server.all.length;
  server.raw('this is not json');
  await sleep(300);
  check('mcp: malformed input gets an error and does not stop the server', server.all[before]?.error?.code === -32700 && (await server.rpc('ping')).result !== undefined, JSON.stringify(server.all[before]));

  // only requests with the token are accepted
  const { port, token } = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
  const direct = (request) => new Promise((resolve) => {
    let text = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(JSON.stringify(request) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', (d) => { text += d; });
    socket.on('close', () => resolve(JSON.parse(text)));
  });
  check('bridge: a wrong token is refused', (await direct({ token: 'wrong', tool: 'status' })).error === 'Not authorized.');
  check('bridge: a missing token is refused', (await direct({ tool: 'status' })).error === 'Not authorized.');
  check('bridge: the right token works', (await direct({ token, tool: 'status' })).result?.connected === true);
  check('bridge: inherited names are not tools', (await direct({ token, tool: 'constructor' })).error?.includes('Unknown tool'));
  check('bridge: it listens only on this machine', bridge.server.address().address === '127.0.0.1', bridge.server.address().address);

  // the window closes
  bridge.dispose();
  await sleep(300);
  check('closing removes the bridge file', !fs.existsSync(bridgeFile));
  call = await server.rpc('tools/call', { name: 'status' });
  check('mcp: with no window, the tool says what to do', call.result.isError === true && call.result.content[0].text.includes('open the workspace folder'), JSON.stringify(call));
  fs.writeFileSync(bridgeFile, JSON.stringify({ port, token }));
  call = await server.rpc('tools/call', { name: 'status' });
  check('mcp: with a stale bridge file, too', call.result.isError === true && call.result.content[0].text.includes('open the workspace folder'), JSON.stringify(call));
  server.child.stdin.end();
  const exited = await new Promise((resolve) => { server.child.on('exit', () => resolve(true)); setTimeout(() => resolve(false), 5000); });
  check('mcp: the server exits when the assistant goes away', exited);
}

async function testProjectSetup({ setUpForAssistants }, { SYNC_COMMAND, SYNC_COMMAND_MARKER }) {
  const root = path.join(workspaceRoot(), 'setup-case');
  const project = path.join(root, 'overleaf-Paper');
  fs.mkdirSync(path.join(project, '.overleaf'), { recursive: true });
  const logs = [];
  const run = () => setUpForAssistants(vscode.Uri.file(root), vscode.Uri.file(project), 'C:\\ext\\path', (m) => logs.push(m));
  const mcp = path.join(root, '.mcp.json');
  const command = path.join(root, '.claude', 'commands', 'sync.md');
  await run();
  let config = JSON.parse(fs.readFileSync(mcp, 'utf8'));
  const entry = config.mcpServers.overleaf;
  check('setup: the tools are registered', entry?.type === 'stdio' && entry.args[0].endsWith(path.join('out', 'ai', 'mcpServer.js')), JSON.stringify(entry));
  check('setup: with the workspace folder', entry.args[1].toLowerCase() === root.toLowerCase(), JSON.stringify(entry.args));
  check('setup: run by VS Code itself, so Node.js is not needed', entry.command === process.execPath && entry.env.ELECTRON_RUN_AS_NODE === '1');
  check('setup: /sync is installed', fs.readFileSync(command, 'utf8') === SYNC_COMMAND);
  check('setup: the state folder stays out of Git', fs.readFileSync(path.join(project, '.overleaf', '.gitignore'), 'utf8').trim() === '*');

  // other tools' settings stay
  config.mcpServers.other = { command: 'other' };
  config.keep = 1;
  fs.writeFileSync(mcp, JSON.stringify(config));
  await run();
  config = JSON.parse(fs.readFileSync(mcp, 'utf8'));
  check('setup: other servers and settings stay', config.mcpServers.other?.command === 'other' && config.keep === 1 && !!config.mcpServers.overleaf);
  const written = fs.statSync(mcp).mtimeMs;
  await sleep(50);
  await run();
  check('setup: an unchanged configuration is not rewritten', fs.statSync(mcp).mtimeMs === written);
  config.mcpServers.overleaf.args[0] = 'C:\\old\\version\\mcpServer.js';
  fs.writeFileSync(mcp, JSON.stringify(config));
  await run();
  check('setup: a path from an older version is refreshed', JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers.overleaf.args[0].endsWith(path.join('out', 'ai', 'mcpServer.js')));
  fs.writeFileSync(mcp, '{ broken');
  await run();
  check('setup: a broken configuration is left alone', fs.readFileSync(mcp, 'utf8') === '{ broken');
  check('setup: and reported', logs.some((l) => l.includes('.mcp.json')), JSON.stringify(logs));

  // the user's own version of the command
  fs.writeFileSync(command, 'my own instructions');
  await run();
  check('setup: a command the user wrote is kept', fs.readFileSync(command, 'utf8') === 'my own instructions');
  fs.writeFileSync(command, SYNC_COMMAND.replace(SYNC_COMMAND_MARKER, '<!-- overleaf-workshop-ai:sync:v0 -->'));
  await run();
  check('setup: an older version of ours is updated', fs.readFileSync(command, 'utf8') === SYNC_COMMAND);
  const future = SYNC_COMMAND.replace(SYNC_COMMAND_MARKER, '<!-- overleaf-workshop-ai:sync:v99 -->');
  fs.writeFileSync(command, future);
  await run();
  check('setup: a newer version is not downgraded', fs.readFileSync(command, 'utf8') === future);
}

async function testTypora({ unsavedFromTitles, listUnsavedTyporaFiles }) {
  check('typora: an unsaved title is recognized', unsavedFromTitles(['paper.md• - Typora']).join() === 'paper.md');
  check('typora: Chinese names and spaces', unsavedFromTitles(['01 引言.md• - Typora']).join() === '01 引言.md');
  check('typora: a saved file is not reported', unsavedFromTitles(['paper.md - Typora']).length === 0);
  check('typora: other windows are not reported', unsavedFromTitles(['paper.md• - Visual Studio Code', 'Typora', '', 'a• - Typora - Notes']).length === 0);
  const listed = await listUnsavedTyporaFiles();
  check('typora: listing the real windows works', Array.isArray(listed), JSON.stringify(listed));
}

exports.run = async function () {
  try {
    testLineDiff(require(path.join(out, 'ai', 'lineDiff.js')));
    await testTranslationState(require(path.join(out, 'ai', 'translationState.js')));
    await testMcp(require(path.join(out, 'ai', 'bridge.js')), require(path.join(out, 'ai', 'tools.js')));
    await testProjectSetup(require(path.join(out, 'ai', 'projectSetup.js')), require(path.join(out, 'ai', 'syncCommand.js')));
    await testTypora(require(path.join(out, 'ai', 'typora.js')));
  } catch (e) {
    results.push(`ERROR ${e && e.stack}`);
  } finally {
    fs.writeFileSync(path.join(here, 'results.txt'), results.join('\n') + '\n', 'utf8');
  }
};

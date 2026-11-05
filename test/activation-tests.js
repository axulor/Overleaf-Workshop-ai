// The workspace is prepared before VS Code starts: opening a folder holding a linked project must wake the extension.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const here = process.env.OVERLEAF_AI_TEST_DIR;
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  try {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    check('setup: the linked folder exists', fs.existsSync(path.join(root, 'overleaf-My Paper', '.overleaf', 'settings.json')));
    const extension = vscode.extensions.getExtension('axulor.overleaf-workshop-ai');
    const end = Date.now() + 20000;
    while (Date.now() < end && !extension.isActive) { await sleep(100); }
    check('opening a folder with a linked project activates the extension', extension.isActive);
    check('the command for linking is there', (await vscode.commands.getCommands(true)).includes('overleaf-workshop.sync.linkProject'));
  } catch (e) {
    results.push(`ERROR ${e && e.stack}`);
  } finally {
    fs.writeFileSync(path.join(here, 'results.txt'), results.join('\n') + '\n', 'utf8');
  }
};

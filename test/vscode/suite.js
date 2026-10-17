// Läuft im Extension Host eines echten VS Code (siehe run.js).
// Dialoge werden durch vorbereitete Antworten ersetzt; alles andere ist echt:
// Aktivierung, Befehle, Statusleiste, Einstellungen, Webview-Panel, Dateien.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const pkg = require('../../package.json');

const CLAUDE = process.env.CLAUDE_CONFIG_DIR;
const WORKSPACE = process.env.TT_WORKSPACE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appendAssistant(output) {
  const file = path.join(CLAUDE, 'projects', 'rea', 's1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = `msg_${Date.now()}_${output}`;
  const line = {
    type: 'assistant',
    sessionId: 's1',
    cwd: WORKSPACE,
    timestamp: new Date().toISOString(),
    uuid: id,
    message: {
      id,
      model: 'claude-opus-5-5',
      role: 'assistant',
      usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
}

// Ersetzt Dialoge der vscode-API durch vorbereitete Antworten.
function answerDialogs(answers) {
  const w = vscode.window;
  const orig = { qp: w.showQuickPick, ib: w.showInputBox, warn: w.showWarningMessage, info: w.showInformationMessage };
  w.showQuickPick = async (items, opts) => answers.shift()(await items, opts);
  w.showInputBox = async (opts) => answers.shift()(undefined, opts);
  w.showWarningMessage = async (msg, ...rest) => rest.filter((r) => typeof r === 'string').pop();
  w.showInformationMessage = async () => undefined;
  return () => Object.assign(w, { showQuickPick: orig.qp, showInputBox: orig.ib, showWarningMessage: orig.warn, showInformationMessage: orig.info });
}

let api;

const tests = [
  ['Extension aktiviert sich und meldet ihre Test-API', async () => {
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    assert.ok(ext, 'Extension nicht gefunden');
    api = await ext.activate();
    assert.equal(api.state().state, null);
    assert.equal(api.state().statusText, '$(play) Tokens');
  }],

  ['alle Befehle aus package.json sind registriert', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of pkg.contributes.commands) assert.ok(all.includes(c.command), `fehlt: ${c.command}`);
  }],

  ['Start → Pause → Einstellung ändern → Stopp', async () => {
    const restore = answerDialogs([
      (items) => items.find((i) => i.scope === 'workspace'),
      () => 'Echter Test #vscode',
      (items) => items.find((i) => i.label.includes('Ab jetzt')),
    ]);
    try {
      await vscode.commands.executeCommand('tokenTracker.start');
      assert.equal(api.state().state, 'running');
      assert.equal(api.state().session.scope, 'workspace');
      assert.equal(api.state().session.project, path.basename(WORKSPACE));

      await sleep(10);
      appendAssistant(1500);
      await vscode.commands.executeCommand('tokenTracker.pause');
      assert.equal(api.state().state, 'paused');
      assert.match(api.state().statusText, /^\$\(debug-pause\) Echter Test: 1,5 k Tokens · \$0,030 \(pausiert\)$/);

      // Einstellung ändern -> Statusleiste reagiert
      const cfg = vscode.workspace.getConfiguration('tokenTracker');
      await cfg.update('showCost', false, vscode.ConfigurationTarget.Global);
      await sleep(200);
      assert.doesNotMatch(api.state().statusText, /\$0/);
      await cfg.update('showCost', undefined, vscode.ConfigurationTarget.Global);

      await vscode.commands.executeCommand('tokenTracker.resume');
      appendAssistant(500);
      await vscode.commands.executeCommand('tokenTracker.stop');
      assert.equal(api.state().state, null);
      const [e] = api.history();
      assert.equal(e.name, 'Echter Test');
      assert.deepEqual(e.tags, ['vscode']);
      assert.equal(e.models['claude-opus-5-5'].output, 2000);
    } finally {
      restore();
    }
  }],

  ['Panel öffnet sich als Webview-Tab', async () => {
    await vscode.commands.executeCommand('tokenTracker.showPanel');
    await sleep(500);
    assert.ok(api.state().panelOpen);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(tabs.some((t) => t.label === 'Token Tracker'), `Tabs: ${tabs.map((t) => t.label)}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }],

  ['Claude-Code-Statuszeile einrichten', async () => {
    const restore = answerDialogs([]);
    try {
      await vscode.commands.executeCommand('tokenTracker.setupStatusLine');
    } finally {
      restore();
    }
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
    assert.match(settings.statusLine.command, /token-tracker\/statusline\.js"$/);
    assert.ok(fs.existsSync(path.join(CLAUDE, 'token-tracker', 'statusline.js')));
  }],
];

exports.run = async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failed++;
      console.error(`not ok - ${name}\n${e.stack || e}`);
    }
  }
  console.log(`# VS Code ${vscode.version}: ${tests.length - failed}/${tests.length} bestanden`);
  if (failed) throw new Error(`${failed} von ${tests.length} VS-Code-Tests fehlgeschlagen`);
};

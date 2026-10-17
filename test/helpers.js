// Hilfen für die Tests: ein temporäres ~/.claude mit Transkripten im Format
// von Claude Code und eine nachgebaute vscode-API.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let counter = 0;

// Legt ein leeres CLAUDE_CONFIG_DIR an und setzt die Umgebungsvariable darauf.
function tmpClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-'));
  fs.mkdirSync(path.join(dir, 'projects'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Pfad der Transkriptdatei einer Sitzung (oder eines Subagents dieser Sitzung).
function transcript(dir, sessionId, { project = 'proj', agent } = {}) {
  const base = path.join(dir, 'projects', project);
  const file = agent ? path.join(base, sessionId, 'subagents', `agent-${agent}.jsonl`) : path.join(base, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

// Eine Assistant-Zeile, wie Claude Code sie schreibt.
function assistant({
  id = `msg_${++counter}`,
  sessionId = 's1',
  cwd = 'C:/work/REA',
  t = Date.now(),
  model = 'claude-opus-5-5',
  input = 10,
  output = 100,
  cacheWrite = 0,
  cacheWrite1h = 0,
  cacheRead = 0,
  speed,
} = {}) {
  return {
    parentUuid: null,
    type: 'assistant',
    sessionId,
    cwd,
    timestamp: new Date(t).toISOString(),
    uuid: `uuid-${++counter}`,
    requestId: `req_${id}`,
    message: {
      id,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        cache_creation: { ephemeral_1h_input_tokens: cacheWrite1h, ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h },
        ...(speed ? { speed } : {}),
      },
    },
  };
}

function append(file, ...entries) {
  fs.appendFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e) + '\n')).join(''));
}

function mkSession(overrides = {}) {
  return {
    scope: 'all',
    scopeLabel: 'Alle',
    workspacePaths: [],
    sessionIds: [],
    awaitNew: false,
    createdAt: Date.now(),
    windows: [{ start: Date.now() - 3600e3, end: null }],
    autoPausedAt: null,
    offsets: {},
    models: {},
    days: {},
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- nachgebaute vscode-API ----------

let currentStub = null;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    if (!currentStub) throw new Error('vscode-Stub nicht initialisiert');
    return currentStub;
  }
  return origLoad.call(this, request, ...rest);
};

// answers: Funktionen, die nacheinander showQuickPick/showInputBox beantworten.
// confirm: modale Rückfragen mit dem angebotenen Button bestätigen.
// onInfo(msg, buttons): Antwort auf Info-Meldungen (Standard: keine)
// saveTo: Pfad, den der „Speichern unter"-Dialog zurückgibt
function createVscode({ folders = [], config = {}, answers = [], confirm = true, onInfo, saveTo } = {}) {
  const commands = {};
  const items = [];
  const messages = [];
  const panels = [];
  const executed = [];
  const next = async (kind, arg, opts) => {
    const answer = answers.shift();
    if (!answer) throw new Error(`Unerwartete Abfrage (${kind}): ${opts?.title || opts?.prompt || ''}`);
    return answer(arg, opts);
  };
  const settings = { statusBarMetric: 'noCacheRead', showCost: true, idlePauseMinutes: 15, prices: {}, ...config };
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    ProgressLocation: { Window: 10, Notification: 15 },
    QuickPickItemKind: { Separator: -1 },
    ViewColumn: { Active: -1 },
    Uri: { file: (p) => ({ fsPath: p }) },
    MarkdownString: class {
      constructor() {
        this.value = '';
      }
      appendMarkdown(s) {
        this.value += s;
        return this;
      }
    },
    window: {
      createStatusBarItem: (id) => {
        const item = { id, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
        items.push(item);
        return item;
      },
      showQuickPick: async (list, opts) => next('QuickPick', await list, opts),
      showInputBox: async (opts) => next('InputBox', undefined, opts),
      showInformationMessage: async (msg, ...buttons) => {
        messages.push({ level: 'info', msg });
        return onInfo ? onInfo(msg, buttons) : undefined;
      },
      showWarningMessage: async (msg, ...rest) => {
        messages.push({ level: 'warn', msg });
        const buttons = rest.filter((r) => typeof r === 'string');
        return confirm ? buttons[buttons.length - 1] : undefined;
      },
      showErrorMessage: async (msg) => {
        messages.push({ level: 'error', msg });
      },
      withProgress: async (_opts, fn) => fn(),
      showSaveDialog: async () => (saveTo ? { fsPath: saveTo } : undefined),
      showTextDocument: async () => {},
      createWebviewPanel: () => {
        const panel = {
          posted: [],
          handler: null,
          reveal() {},
          onDidDispose() {},
          webview: {
            html: '',
            cspSource: 'vscode-resource:',
            postMessage: async (m) => panel.posted.push(m),
            onDidReceiveMessage: (fn) => (panel.handler = fn),
          },
          // Nachricht so schicken, als käme sie aus dem Panel
          send: (msg) => panel.handler(msg),
          lastState: () => panel.posted.filter((m) => m.type === 'state').at(-1),
        };
        panels.push(panel);
        return panel;
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        commands[id] = fn;
        return { dispose() {} };
      },
      // eingebaute VS-Code-Befehle nur protokollieren
      executeCommand: async (id, ...args) => (commands[id] ? commands[id](...args) : executed.push([id, ...args])),
    },
    workspace: {
      workspaceFolders: folders.map((f) => ({ name: path.basename(f), uri: { fsPath: f } })),
      getConfiguration: () => ({ get: (k) => settings[k] }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  };
  currentStub = vscode;
  return { vscode, commands, items, messages, answers, panels, executed };
}

// Lädt extension.js frisch (Modulzustand zurückgesetzt) und aktiviert sie.
// globalStorage liegt in claudeDir/global-storage.
function activateExtension({ claudeDir, workspaceState = {} }) {
  const file = require.resolve(path.join(ROOT, 'extension.js'));
  delete require.cache[file];
  const ext = require(file);
  const store = { ...workspaceState };
  const ctx = {
    subscriptions: [],
    extensionPath: ROOT,
    globalStorageUri: { fsPath: path.join(claudeDir, 'global-storage') },
    workspaceState: {
      get: (k) => store[k],
      update: async (k, v) => {
        store[k] = v;
      },
    },
  };
  const api = ext.activate(ctx);
  return { ext, store, api, history: () => api.history() };
}

// Antwort-Helfer für QuickPicks
const pick = (pred) => (items) => items.find(pred);
const type = (text) => (_arg, opts) => (typeof text === 'function' ? text(opts) : text);

module.exports = { ROOT, tmpClaude, transcript, assistant, append, mkSession, sleep, createVscode, activateExtension, pick, type };

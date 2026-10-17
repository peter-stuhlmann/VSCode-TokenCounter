// Token Tracker for Claude Code – VS-Code-Teil: Statusleiste, Befehle, Dialoge, Panel, Speicherung.
// Das eigentliche Zählen steckt in core.js (ohne VS-Code-Abhängigkeit, direkt testbar),
// die Preise in prices.js, die Anzeige für die Claude-Code-Statuszeile in statusline.js.
//
// Abschnitte:
//   Persistenz        laufende Messung (workspaceState) und Verlauf (eine Datei pro Eintrag)
//   Statuszeile       Live-Datei und Einrichtung der Claude-Code-Statuszeile
//   Zustand/Tracking  Lesedurchläufe, Dateiüberwachung, Leerlauf, Start/Pause/Stopp
//   Verlauf           Bearbeiten, Zusammenführen, Löschen, Fortsetzen
//   Statusleiste      Text, Tooltip, Buttons
//   Panel             Webview und CSV-Export
//   Aktivierung

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const core = require('./core');
const { PRICES_AS_OF } = require('./prices');

const POLL_MS = 3000; // Takt der Lesedurchläufe während einer Messung
const SESSION_KEY = 'tokenTracker.session';

let ctx;
let session = null;
let seen = new Map(); // message-id -> gezählter Stand, siehe core.ingest
let timer = null;
let inflight = null; // laufender Lesedurchlauf
let sbMain, sbPause, sbStop, sbHistory;
let panel = null;
let formatProblem = null; // Pfad des Transkripts, dessen Format nicht erkannt wurde
const formatStats = { recognized: 0, unrecognized: 0 };

const cfg = () => vscode.workspace.getConfiguration('tokenTracker');

// ---------- Persistenz ----------

// Jeder Verlaufseintrag ist eine eigene Datei. So überschreiben sich zwei
// Fenster, die gleichzeitig stoppen oder bearbeiten, nicht gegenseitig.
function historyDir() {
  return path.join(ctx.globalStorageUri.fsPath, 'history');
}

function entryFile(id) {
  return path.join(historyDir(), `${String(id).replace(/[^\w-]/g, '')}.json`);
}

function saveEntry(e) {
  fs.mkdirSync(historyDir(), { recursive: true });
  const tmp = `${entryFile(e.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e, null, 2));
  fs.renameSync(tmp, entryFile(e.id)); // atomar: nie eine halb geschriebene Datei
}

function removeEntry(id) {
  try {
    fs.unlinkSync(entryFile(id));
  } catch {}
}

// Neueste zuerst (zuletzt gespeichert). Unlesbare Dateien werden übersprungen,
// fehlende Felder mit Standardwerten aufgefüllt.
function loadHistory() {
  let files = [];
  try {
    files = fs.readdirSync(historyDir()).filter((f) => f.endsWith('.json'));
  } catch {}
  const list = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(historyDir(), f), 'utf8'));
      list.push({ project: '', tags: [], days: {}, ...e, models: core.normalizeModels(e.models) });
    } catch {}
  }
  return list.sort((a, b) => (b.savedAt ?? b.end) - (a.savedAt ?? a.end));
}

// Gespeicherte laufende Messung laden. Ohne gültige Zeitfenster ist sie unbrauchbar
// und wird verworfen; fehlende Felder werden mit Standardwerten aufgefüllt.
function restoreSession(s) {
  if (!s || !Array.isArray(s.windows) || !s.windows.length) return null;
  return {
    tags: [],
    workspacePaths: [],
    sessionIds: [],
    awaitNew: false,
    autoPausedAt: null,
    offsets: {},
    days: {},
    ...s,
    models: core.normalizeModels(s.models),
  };
}

// Zählerstände höchstens alle 15 s speichern (der Zustand ist mehrere 100 KB groß).
// Zustandswechsel werden sofort gespeichert. Geht bei einem Absturz etwas verloren,
// liest die Extension ab dem letzten gespeicherten Stand neu – Offsets, Zähler und
// seen passen immer zusammen, es wird also nichts doppelt oder gar nicht gezählt.
const PERSIST_MS = 15000;
let lastPersist = 0;

function persistSession() {
  lastPersist = Date.now();
  seen = core.recentSeen(seen); // nur die letzten Minuten behalten, siehe core.recentSeen
  if (session) session.seen = Object.fromEntries(seen);
  return ctx.workspaceState.update(SESSION_KEY, session || undefined);
}

// seen aus dem Speicher: nur gültige Einträge ({ t, model, … } je message-id) übernehmen
function restoreSeen(stored) {
  const valid = ([, v]) => v && typeof v === 'object' && Number.isFinite(v.t);
  return new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}).filter(valid));
}

// ---------- Live-Datei für die Claude-Code-Statuszeile ----------

const trackerDir = () => path.join(core.claudeDir(), 'token-tracker');
let liveKey = 'none';
let lastLive = '';
let lastLiveWrite = 0;

function liveFile() {
  return path.join(trackerDir(), 'live', `${liveKey}.json`);
}

function writeLive() {
  try {
    if (!session) {
      if (fs.existsSync(liveFile())) fs.unlinkSync(liveFile());
      lastLive = '';
      return;
    }
    const t = core.sumModels(session.models);
    const data = {
      name: session.name,
      project: session.project,
      state: state(),
      tokens: metricValue(session.models),
      cost: t.cost,
      scope: session.scope,
      sessionIds: session.sessionIds,
      awaitNew: !!session.awaitNew,
      workspacePaths: session.workspacePaths,
    };
    const json = JSON.stringify(data);
    if (json === lastLive && Date.now() - lastLiveWrite < 60000) return;
    fs.mkdirSync(path.dirname(liveFile()), { recursive: true });
    fs.writeFileSync(liveFile(), JSON.stringify({ ...data, updatedAt: Date.now() }));
    lastLive = json;
    lastLiveWrite = Date.now();
  } catch {}
}

function installStatusLineScript() {
  try {
    fs.mkdirSync(trackerDir(), { recursive: true });
    fs.copyFileSync(path.join(ctx.extensionPath, 'statusline.js'), path.join(trackerDir(), 'statusline.js'));
  } catch {}
}

async function setupStatusLine() {
  installStatusLineScript();
  const settingsPath = path.join(core.claudeDir(), 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      // Niemals eine unlesbare Datei überschreiben – sonst wären alle anderen Einstellungen weg.
      vscode.window.showErrorMessage(
        `${settingsPath} ist kein gültiges JSON und wird nicht verändert. Bitte die Datei prüfen und es dann noch einmal versuchen.`
      );
      return;
    }
  }
  const command = `${core.nodeCommand()} "${path.join(trackerDir(), 'statusline.js').replace(/\\/g, '/')}"`;
  if (settings.statusLine?.command === command) {
    vscode.window.showInformationMessage('Die Claude-Code-Statuszeile ist bereits eingerichtet.');
    return;
  }
  const msg = settings.statusLine
    ? `In ${settingsPath} ist schon eine Statuszeile eingerichtet („${settings.statusLine.command}"). Ersetzen?`
    : `Token-Tracking in der Claude-Code-Statuszeile anzeigen? Dafür wird ${settingsPath} ergänzt.`;
  const ok = await vscode.window.showWarningMessage(msg, { modal: true }, 'Einrichten');
  if (!ok) return;
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.token-tracker.bak');
  else fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  settings.statusLine = { type: 'command', command };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  vscode.window.showInformationMessage('Eingerichtet. Wirkt in neuen Claude-Code-Sitzungen.');
}

// ---------- Zustand ----------

function lastWindow() {
  return session.windows[session.windows.length - 1];
}

// 'running' | 'idle' (automatisch pausiert) | 'paused' | null
function state() {
  if (!session) return null;
  if (lastWindow().end == null) return 'running';
  return session.autoPausedAt != null ? 'idle' : 'paused';
}

function metricValue(models) {
  const t = core.sumModels(models);
  switch (cfg().get('statusBarMetric')) {
    case 'total':
      return core.bucketTotal(t);
    case 'output':
      return t.output;
    default:
      return t.input + t.output + t.cacheWrite;
  }
}

// ---------- Tracking ----------

// ---------- Dateiüberwachung ----------
// Statt alle 3 s jedes Transkript zu prüfen (bei ~600 Dateien ≈ 3 % eines CPU-Kerns),
// meldet das Betriebssystem geänderte Dateien. Nur diese werden gelesen. Ein voller
// Durchlauf alle 30 s – und bei Pause/Stopp – fängt verpasste Meldungen ab. Ist keine
// Überwachung möglich, läuft jeder Durchlauf voll wie bisher.

const FULL_SCAN_MS = 30000;
let watcher = null;
const dirty = new Set(); // gemeldete, noch nicht gelesene Dateien
let lastFullScan = 0;

function startWatcher() {
  if (watcher) return;
  const root = core.projectsDir();
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (name && String(name).endsWith('.jsonl')) dirty.add(path.join(root, String(name)));
    });
    watcher.on('error', stopWatcher);
  } catch {
    watcher = null; // z. B. Ordner fehlt oder rekursive Überwachung nicht unterstützt
  }
}

function stopWatcher() {
  try {
    watcher?.close();
  } catch {}
  watcher = null;
  dirty.clear();
}

// Regelmäßige Durchläufe überspringen, wenn noch einer läuft. Pause/Stopp
// (force) warten ihn ab und lesen danach noch einmal vollständig, damit nichts fehlt.
async function tick(force = false) {
  while (inflight) {
    if (!force) return;
    await inflight;
  }
  if (!session) return;
  inflight = (async () => {
    const s = session;
    s.priceOverrides = cfg().get('prices') || {};
    const full = force || !watcher || Date.now() - lastFullScan >= FULL_SCAN_MS;
    const only = full ? null : [...dirty];
    dirty.clear();
    let counted = false;
    if (full || only.length) counted = await core.scan(s, seen, formatStats, only);
    if (full) lastFullScan = Date.now();
    if (session !== s) return; // inzwischen gestoppt oder verworfen
    if (formatStats.unrecognized >= 5 && !formatStats.recognized) warnFormat();
    let stateChanged = false;
    if (s.activityTimes) {
      splitRetroWindow();
      stateChanged = true;
    }
    if (s.adoptedSession) {
      notifyAdopted(s.adoptedSession);
      delete s.adoptedSession;
      stateChanged = true;
    }
    warnUnpriced();
    stateChanged = checkIdle() || stateChanged;
    if (stateChanged || force || (counted && Date.now() - lastPersist >= PERSIST_MS)) await persistSession();
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
  render();
}

// Claude Code hat sein Transkript-Format geändert: lieber laut warnen als still falsch zählen.
async function warnFormat(file) {
  if (formatProblem) return;
  formatProblem = file || true;
  render();
  const choice = await vscode.window.showWarningMessage(
    'Token Tracker: Das Transkript-Format von Claude Code wird nicht erkannt – vermutlich nach einem ' +
      'Claude-Code-Update. Tokens werden eventuell nicht oder unvollständig gezählt.',
    ...(typeof formatProblem === 'string' ? ['Transkript öffnen'] : [])
  );
  if (choice) vscode.window.showTextDocument(vscode.Uri.file(formatProblem));
}

// Rückwirkender Start: Lücken ohne Aktivität, die länger als die Leerlauf-Grenze
// sind, nachträglich als Pausen behandeln, damit sie nicht als aktive Zeit zählen.
function splitRetroWindow() {
  const times = session.activityTimes;
  delete session.activityTimes;
  const minutes = cfg().get('idlePauseMinutes');
  if (minutes > 0 && session.windows.length === 1) {
    session.windows = core.splitByIdle(session.windows[0].start, times, minutes * 60000);
  }
}

// „Nächste neue Sitzung": sagen, welche Sitzung übernommen wurde, und Wechsel anbieten.
async function notifyAdopted({ id, file }) {
  let title = id.slice(0, 8);
  try {
    title = (await core.sessionInfoFromFile(file)).title;
  } catch {}
  const name = session?.name;
  const choice = await vscode.window.showInformationMessage(
    `Neue Claude-Sitzung erkannt: „${title}". Sie wird ab jetzt für „${name}" gezählt.`,
    'Andere Sitzung wählen'
  );
  if (choice) await switchSession();
}

async function switchSession() {
  if (!session || session.scope !== 'session') return;
  if (session.continues) {
    // Neu zählen würde die Werte der fortgesetzten Messung verwerfen.
    vscode.window.showWarningMessage('Bei einer fortgesetzten Messung lässt sich die Sitzung nicht wechseln.');
    return;
  }
  const pick = await pickSession(vscode.workspace.workspaceFolders || []);
  if (!pick || !session) return;
  while (inflight) await inflight; // keinen Durchlauf mitten im Umbau weiterlaufen lassen
  if (!session) return;
  if (pick.awaitNew) {
    // die bisher übernommene Sitzung nicht noch einmal übernehmen
    session.excludeSessions = [...(session.excludeSessions || []), ...session.sessionIds];
    session.sessionIds = [];
    session.awaitNew = true;
    session.scopeLabel = 'Nächste neue Sitzung';
    await recount({ fromNow: true });
  } else {
    session.sessionIds = [pick.s.id];
    session.awaitNew = false;
    session.scopeLabel = `Sitzung: ${pick.s.title}`;
    await recount({ fromNow: false });
  }
}

// Zählt neu, z. B. nach einem Sitzungswechsel.
//   fromNow: false -> den bisherigen Zeitraum komplett neu einlesen
//   fromNow: true  -> „Nächste neue Sitzung" wie beim Start: ab jetzt, mit frischer Baseline
async function recount({ fromNow }) {
  while (inflight) await inflight;
  const now = Date.now();
  session.models = {};
  session.days = {};
  session.lastActivity = undefined;
  session.newFiles = [];
  seen = new Map();
  if (fromNow) {
    const wasRunning = state() === 'running';
    session.createdAt = now;
    session.windows = [{ start: now, end: wasRunning ? null : now }];
    session.autoPausedAt = null;
    session.offsets = await core.baselineOffsets();
  } else {
    session.offsets = {};
  }
  await persistSession();
  await tick(true);
}

const warnedModels = new Set();

// Modelle ohne hinterlegten Preis: einmal pro Modell darauf hinweisen.
function warnUnpriced() {
  for (const [m, b] of Object.entries(session.models)) {
    if (!b.unpriced || warnedModels.has(m)) continue;
    warnedModels.add(m);
    vscode.window
      .showWarningMessage(
        `Für das Modell „${m}" ist kein Preis hinterlegt – der API-Preis ist deshalb zu niedrig (im Panel mit „≥" markiert).`,
        'Preis eintragen'
      )
      .then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'tokenTracker.prices'));
  }
}

// Pausiert automatisch, wenn eine Weile keine Tokens kamen. Das Fenster endet
// bei der letzten Aktivität, damit die Leerlaufzeit nicht mitzählt.
function checkIdle() {
  const minutes = cfg().get('idlePauseMinutes');
  if (state() !== 'running' || !minutes) return false;
  const w = lastWindow();
  const ref = Math.max(session.lastActivity || 0, w.start);
  if (Date.now() - ref < minutes * 60000) return false;
  w.end = ref;
  session.autoPausedAt = ref;
  return true;
}

function startTimer() {
  stopTimer();
  startWatcher();
  lastFullScan = 0; // erster Durchlauf ist immer vollständig
  timer = setInterval(() => tick(), POLL_MS);
  return tick();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  stopWatcher();
}

function parseTags(text) {
  const tags = [...text.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]);
  const name = text.replace(/#[\p{L}\p{N}_-]+/gu, '').replace(/\s+/g, ' ').trim();
  return { name, tags: [...new Set(tags)] };
}

function relTime(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  if (min < 24 * 60) return `vor ${Math.round(min / 60)} h`;
  return `vor ${Math.round(min / 1440)} T`;
}

const fmtClock = (t) => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

// Uhrzeit „14:30" (heute, sonst gestern) oder „15.10. 14:30".
function parseTime(text) {
  const m = text.trim().match(/^(?:(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?\s+)?(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const now = new Date();
  const d = new Date(now);
  if (m[1]) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
    d.setFullYear(year, +m[2] - 1, +m[1]);
  }
  d.setHours(+m[4], +m[5], 0, 0);
  if (!m[1] && d > now) d.setDate(d.getDate() - 1);
  return d > now ? null : d.getTime();
}

async function pickSession(folders) {
  const sessions = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Lese Claude-Sitzungen…' },
    () => core.listSessions()
  );
  const roots = core.withRealPaths(folders.map((f) => f.uri.fsPath));
  const inWs = (s) => core.pathInside(s.cwd, roots);
  const toItem = (s) => ({
    label: s.title,
    description: `${relTime(s.mtime)} · ${s.cwd ? path.basename(s.cwd) : ''}`,
    detail: s.lastPrompt ? `Zuletzt: ${s.lastPrompt.replace(/\s+/g, ' ').slice(0, 110)}` : undefined,
    s,
  });
  const items = [];
  if (folders.length) {
    items.push({
      label: '$(add) Nächste neue Sitzung in diesem Workspace',
      detail: 'Zählt die erste Claude-Sitzung, die du ab jetzt hier startest',
      awaitNew: true,
    });
    const here = sessions.filter(inWs);
    if (here.length) items.push({ label: 'In diesem Workspace', kind: vscode.QuickPickItemKind.Separator }, ...here.map(toItem));
  }
  const other = sessions.filter((s) => !folders.length || !inWs(s));
  if (other.length) items.push({ label: 'Andere Ordner', kind: vscode.QuickPickItemKind.Separator }, ...other.map(toItem));
  return vscode.window.showQuickPick(items, {
    title: 'Welche Claude-Sitzung?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
}

async function pickStartTime(sessionStart) {
  const now = Date.now();
  const ago = (min) => now - min * 60000;
  const midnight = new Date().setHours(0, 0, 0, 0);
  const items = [{ label: '$(play) Ab jetzt', t: now }];
  if (sessionStart) items.push({ label: '$(history) Ab Beginn der Sitzung', description: fmtClock(sessionStart), t: sessionStart });
  items.push(
    { label: 'Vor 15 Minuten', t: ago(15) },
    { label: 'Vor 30 Minuten', t: ago(30) },
    { label: 'Vor 1 Stunde', t: ago(60) },
    { label: 'Vor 2 Stunden', t: ago(120) },
    { label: 'Heute ab 0:00', t: midnight },
    { label: '$(edit) Uhrzeit eingeben…', custom: true }
  );
  const pick = await vscode.window.showQuickPick(items, { title: 'Ab wann zählen?' });
  if (!pick || !pick.custom) return pick?.t;
  const text = await vscode.window.showInputBox({
    title: 'Ab wann zählen?',
    prompt: 'Uhrzeit (14:30 = heute bzw. gestern) oder Datum + Uhrzeit (15.10. 14:30)',
    validateInput: (v) => (parseTime(v) ? null : 'Format: 14:30 oder 15.10. 14:30, nicht in der Zukunft'),
  });
  return text === undefined ? undefined : parseTime(text);
}

async function start() {
  if (session) {
    if (state() !== 'running') return resume();
    vscode.window.showInformationMessage(`Tracking „${session.name}" läuft bereits.`);
    return;
  }
  const check = await core.checkFormat();
  if (check.status === 'no-dir') {
    const go = await vscode.window.showWarningMessage(
      `Keine Claude-Code-Transkripte gefunden (${core.projectsDir()}). Trotzdem starten?`,
      'Starten'
    );
    if (!go) return;
  } else if (check.status === 'unknown-format') {
    warnFormat(check.file);
  }

  const folders = vscode.workspace.workspaceFolders || [];
  const wsNames = folders.map((f) => f.name).join(', ');

  const scopeItems = [
    { label: '$(comment-discussion) Eine bestimmte Claude-Sitzung…', detail: 'Nur diese eine Unterhaltung (inkl. Subagents)', scope: 'session' },
  ];
  if (folders.length) scopeItems.push({ label: '$(folder) Nur dieser Workspace', description: wsNames, detail: 'Alle Claude-Sitzungen in diesem Ordner', scope: 'workspace' });
  scopeItems.push({ label: '$(globe) Alle Claude-Code-Sitzungen', detail: 'Egal in welchem Ordner', scope: 'all' });
  const scopePick = await vscode.window.showQuickPick(scopeItems, { title: 'Was soll gezählt werden?' });
  if (!scopePick) return;

  const s = {
    scope: scopePick.scope,
    workspacePaths: core.withRealPaths(folders.map((f) => f.uri.fsPath)),
    sessionIds: [],
    awaitNew: false,
  };
  let suggestedName = folders[0]?.name || '';
  let project = folders[0]?.name || '';
  let sessionStart = null;

  if (s.scope === 'session') {
    const pick = await pickSession(folders);
    if (!pick) return;
    if (pick.awaitNew) {
      s.awaitNew = true;
      s.scopeLabel = 'Nächste neue Sitzung';
    } else {
      s.sessionIds = [pick.s.id];
      s.scopeLabel = `Sitzung: ${pick.s.title}`;
      suggestedName = pick.s.title;
      if (pick.s.cwd) project = path.basename(pick.s.cwd);
      sessionStart = pick.s.start;
    }
  } else {
    s.scopeLabel = s.scope === 'workspace' ? wsNames : 'Alle Sitzungen';
  }

  const text = await vscode.window.showInputBox({
    title: 'Name für Projekt / Aufgabe',
    prompt: `Mit #tags ergänzen, z. B. „Login-Bug #bugfix". Projekt: ${project || '–'} (im Panel änderbar)`,
    value: suggestedName,
  });
  if (text === undefined) return;
  const { name, tags } = parseTags(text);

  const startTime = s.awaitNew ? Date.now() : await pickStartTime(sessionStart);
  if (startTime === undefined) return;
  const retro = startTime < Date.now() - 5000;

  session = {
    ...s,
    id: crypto.randomUUID(),
    name: name || 'Ohne Namen',
    project,
    tags,
    createdAt: Date.now(),
    windows: [{ start: startTime, end: null }],
    autoPausedAt: null,
    offsets: retro ? {} : await core.baselineOffsets(),
    models: {},
    days: {},
    ...(retro ? { activityTimes: [] } : {}), // für splitRetroWindow
  };
  seen = new Map();
  await persistSession();
  if (retro) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Zähle rückwirkend ab ${fmtClock(startTime)}…` },
      () => startTimer()
    );
  } else {
    await startTimer();
  }
}

// Setzt ein abgeschlossenes Tracking fort: Zähler und Zeit laufen weiter,
// beim Stopp wird der Verlaufseintrag ersetzt.
async function continueEntry(id) {
  if (session) {
    vscode.window.showWarningMessage('Erst das laufende Tracking stoppen.');
    return;
  }
  const e = loadHistory().find((x) => x.id === id);
  if (!e) return;
  const days = e.days || {};
  session = {
    id: e.id,
    continues: e.id,
    name: e.name,
    project: e.project || '',
    tags: e.tags || [],
    scope: e.scope || 'all',
    scopeLabel: e.scopeLabel,
    workspacePaths: e.workspacePaths || [],
    sessionIds: e.sessionIds || [],
    awaitNew: false,
    createdAt: Date.now(),
    firstStart: e.start,
    priorMs: e.activeMs,
    windows: [{ start: Date.now(), end: null }],
    autoPausedAt: null,
    offsets: await core.baselineOffsets(),
    models: core.mergeModels(e.models),
    days: core.mergeDays(days),
    // Stand beim Fortsetzen: Beim Stopp wird nur der Teil darüber hinaus verbucht –
    // auf den dann aktuellen Eintrag (falls ein anderes Fenster ihn inzwischen geändert hat).
    base: { models: core.mergeModels(e.models), days: core.mergeDays(days), activeMs: e.activeMs },
  };
  // Antworten, die kurz vor dem Stopp begannen, nicht doppelt zählen, wenn ihr
  // Endstand erst jetzt geschrieben wird.
  seen = restoreSeen(e.recentSeen);
  await persistSession();
  await startTimer();
}

async function pause() {
  if (state() !== 'running') return;
  await tick(true);
  // Lief kurz vorher die Leerlauf-Pause an, wird daraus jetzt eine echte Pause:
  // Eine echte Pause zählt nicht von selbst weiter.
  if (state() === 'running') lastWindow().end = Date.now();
  session.autoPausedAt = null;
  stopTimer();
  await persistSession();
  render();
}

async function resume() {
  if (!session || state() === 'running') return;
  session.windows.push({ start: Date.now(), end: null });
  session.autoPausedAt = null;
  await persistSession();
  await startTimer();
}

async function togglePause() {
  if (!session) return start();
  return state() === 'running' ? pause() : resume();
}

async function stop() {
  if (!session) return;
  // Immer ein letztes Mal einlesen – auch im pausierten Zustand: Der Endstand einer
  // Antwort, die vor der Pause begann, kann erst danach geschrieben worden sein.
  await tick(true);
  if (state() === 'running') lastWindow().end = Date.now();
  stopTimer();
  const s = session;
  const entry = {
    id: s.continues || s.id,
    name: s.name,
    project: s.project,
    tags: s.tags,
    scope: s.scope,
    scopeLabel: s.scopeLabel,
    workspacePaths: s.workspacePaths,
    sessionIds: s.sessionIds,
    start: s.firstStart ?? s.windows[0].start,
    end: lastWindow().end,
    activeMs: core.activeMs(s),
    models: s.models,
    days: s.days,
    // für ein späteres „Fortsetzen": Antworten der letzten Minuten nicht doppelt zählen
    recentSeen: Object.fromEntries(core.recentSeen(seen)),
    savedAt: Date.now(),
  };
  saveEntry(s.continues && s.base ? continuedEntry(s, entry) : entry);
  session = null;
  seen = new Map();
  await persistSession();
  render();

  const t = core.sumModels(entry.models);
  const choice = await vscode.window.showInformationMessage(
    `„${entry.name}" gespeichert: ${core.fmtShort(t.input + t.output + t.cacheWrite)} Tokens ` +
      `(+${core.fmtShort(t.cacheRead)} Cache-Read), ${core.fmtUsd(t.cost)} API-Preis, ${core.fmtDuration(entry.activeMs)} aktiv.`,
    'Details'
  );
  if (choice) showPanel();
}

// Fortgesetzte Messung speichern: Nur der Teil seit dem Fortsetzen wird auf den
// *aktuellen* Eintrag gebucht. Hat ein anderes Fenster den Eintrag inzwischen
// bearbeitet, zusammengeführt oder ebenfalls fortgesetzt, geht davon nichts verloren
// und nichts wird doppelt gezählt. Gibt es den Eintrag nicht mehr, wird der neue
// Teil ein eigener Eintrag.
function continuedEntry(s, entry) {
  const added = {
    models: core.subtractModels(s.models, s.base.models),
    days: core.subtractDays(s.days, s.base.days),
    activeMs: entry.activeMs - s.base.activeMs,
  };
  const current = loadHistory().find((e) => e.id === s.continues);
  if (!current) {
    vscode.window.showInformationMessage(
      `Der ursprüngliche Eintrag „${s.name}" wurde inzwischen gelöscht oder zusammengeführt – die Fortsetzung wird als eigener Eintrag gespeichert.`
    );
    return { ...entry, id: crypto.randomUUID(), start: s.windows[0].start, ...added };
  }
  return {
    ...current,
    ...entry,
    start: Math.min(current.start, entry.start),
    sessionIds: [...new Set([...(current.sessionIds || []), ...(entry.sessionIds || [])])],
    activeMs: current.activeMs + added.activeMs,
    models: core.mergeModels(current.models, added.models),
    days: core.mergeDays(current.days || { [core.dayKey(current.start)]: current.models }, added.days),
  };
}

async function discard() {
  if (!session) return;
  const msg = session.continues
    ? `Fortsetzung von „${session.name}" verwerfen? Der ursprüngliche Eintrag bleibt erhalten.`
    : `Tracking „${session.name}" verwerfen, ohne zu speichern?`;
  const ok = await vscode.window.showWarningMessage(msg, { modal: true }, 'Verwerfen');
  if (!ok) return;
  stopTimer();
  session = null;
  seen = new Map();
  await persistSession();
  render();
}

// ---------- Verlauf bearbeiten ----------

// Nachrichten aus dem Panel werden geprüft, bevor sie Daten verändern.
async function editEntry({ id, name, project, tags }) {
  const patch = {
    name: String(name ?? '').trim() || 'Ohne Namen',
    project: String(project ?? '').trim(),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
  };
  if (id === 'current' && session) {
    Object.assign(session, patch);
    await persistSession();
  } else {
    const e = loadHistory().find((x) => x.id === id);
    if (e) saveEntry({ ...e, ...patch });
  }
  render();
}

async function mergeEntries(ids) {
  if (!Array.isArray(ids)) return;
  const history = loadHistory();
  const parts = history.filter((e) => ids.includes(e.id));
  if (parts.length < 2) return;
  const ok = await vscode.window.showWarningMessage(
    `${parts.length} Einträge zu „${parts[0].name}" zusammenführen?`,
    { modal: true, detail: parts.map((p) => `• ${p.name}`).join('\n') },
    'Zusammenführen'
  );
  if (!ok) return;
  const base = parts[0];
  const merged = {
    ...base,
    tags: [...new Set(parts.flatMap((p) => p.tags || []))],
    sessionIds: [...new Set(parts.flatMap((p) => p.sessionIds || []))],
    scopeLabel: [...new Set(parts.map((p) => p.scopeLabel))].join(' + '),
    start: Math.min(...parts.map((p) => p.start)),
    end: Math.max(...parts.map((p) => p.end)),
    activeMs: parts.reduce((ms, p) => ms + p.activeMs, 0),
    models: core.mergeModels(...parts.map((p) => p.models)),
    days: core.mergeDays(...parts.map((p) => p.days || { [core.dayKey(p.start)]: p.models })),
  };
  saveEntry(merged);
  for (const p of parts) if (p.id !== base.id) removeEntry(p.id);
  postPanel();
}

async function deleteEntry(id) {
  const ok = await vscode.window.showWarningMessage('Eintrag löschen?', { modal: true }, 'Löschen');
  if (!ok) return;
  removeEntry(id);
  postPanel();
}

// ---------- Statusleiste ----------

const STATE_LABEL = {
  running: '$(record) läuft',
  idle: '$(watch) inaktiv – zählt weiter, sobald neue Tokens kommen',
  paused: '$(debug-pause) pausiert',
};

// Nutzertext sicher in Markdown mit HTML einsetzen
function escMd(s) {
  return String(s ?? '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    .replace(/[\\`*_[\]#|~]/g, '\\$&');
}

// Tooltip der Statusleiste: Kopf, Kennzahlen, Tabelle pro Modell (HTML-Tabelle,
// damit die Zahlen sauber rechtsbündig stehen), Hinweis zum Klicken.
function tooltip() {
  const md = new vscode.MarkdownString('', true);
  md.supportHtml = true;
  if (!session) {
    md.appendMarkdown('**Token Tracker for Claude Code**\n\n');
    md.appendMarkdown('$(play) Klicken, um eine Messung zu starten  \n$(graph) Ältere Messungen über „Verlauf" daneben');
    return md;
  }
  const t = core.sumModels(session.models);
  const tags = (session.tags || []).map((g) => `#${g}`).join(' ');
  const head = [`**${escMd(session.name)}**`, session.project && escMd(session.project), tags && escMd(tags)].filter(Boolean);
  md.appendMarkdown(`${head.join(' &nbsp;·&nbsp; ')}\n\n`);
  md.appendMarkdown(
    `${STATE_LABEL[state()]} &nbsp;·&nbsp; ${core.fmtDuration(core.activeMs(session))} aktiv &nbsp;·&nbsp; ${escMd(session.scopeLabel)}\n\n---\n\n`
  );

  const rows = Object.entries(session.models).sort((a, b) => b[1].cost - a[1].cost);
  if (!rows.length) {
    md.appendMarkdown('_Noch keine Tokens gezählt._\n\n');
  } else {
    const approx = t.unpriced ? '≥ ' : '';
    md.appendMarkdown(
      `**${approx}${core.fmtUsd(t.cost)}** API-Preis &nbsp;·&nbsp; ` +
        `**${core.fmtShort(t.input + t.output + t.cacheWrite)}** Tokens ohne Cache-Read &nbsp;·&nbsp; ` +
        `**${t.requests.toLocaleString('de-DE')}** Requests\n\n`
    );
    // Hover-Tooltips erlauben kein CSS – Abstand zwischen den Spalten per Geviert-Leerzeichen
    const num = (v) => `<td align="right">&emsp;${v}</td>`;
    const row = (label, b, bold) => {
      const w = (s) => (bold ? `<b>${s}</b>` : s);
      return (
        `<tr><td>${w(label)}</td>` +
        [b.input, b.output, b.cacheWrite, b.cacheRead].map((v) => num(w(core.fmtShort(v)))).join('') +
        num(w(`${b.unpriced ? '≥ ' : ''}${core.fmtUsd(b.cost)}`)) +
        '</tr>'
      );
    };
    const th = (s, right = true) => (right ? `<th align="right">&emsp;${s}</th>` : `<th align="left">${s}</th>`);
    // ohne Leerzeilen, sonst endet der HTML-Block im Markdown
    md.appendMarkdown(
      '<table><thead><tr>' +
        th('Modell', false) + th('Input') + th('Output') + th('Cache-Write') + th('Cache-Read') + th('API-Preis') +
        '</tr></thead><tbody>' +
        rows.map(([m, b]) => row(escMd(core.prettyModel(m)), b)).join('') +
        (rows.length > 1 ? row('Summe', t, true) : '') +
        '</tbody></table>\n\n'
    );
  }
  md.appendMarkdown('---\n\n$(graph) Klicken für Details und Verlauf');
  return md;
}

function render() {
  const st = state();
  if (!session) {
    sbMain.text = '$(play) Tokens';
    sbMain.command = 'tokenTracker.start';
    sbMain.backgroundColor = undefined;
    sbPause.hide();
    sbStop.hide();
    sbHistory.show(); // ohne laufendes Tracking der Weg zu älteren Messungen
  } else {
    const t = core.sumModels(session.models);
    const icon = { running: '$(record)', idle: '$(watch)', paused: '$(debug-pause)' }[st];
    const suffix = { running: '', idle: ' (inaktiv)', paused: ' (pausiert)' }[st];
    const cost = cfg().get('showCost') ? ` · ${core.fmtUsd(t.cost)}` : '';
    sbMain.text = `${icon} ${session.name}: ${core.fmtShort(metricValue(session.models))} Tokens${cost}${suffix}`;
    sbMain.command = 'tokenTracker.showPanel';
    // Gleicher Hintergrund für alle drei, damit sie als zusammengehöriger Block erkennbar sind.
    const bg = st === 'running' ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    sbMain.backgroundColor = sbPause.backgroundColor = sbStop.backgroundColor = bg;
    sbPause.text = st === 'running' ? '$(debug-pause) Pause' : '$(debug-start) Weiter';
    sbPause.tooltip = st === 'running' ? 'Token-Tracking pausieren' : 'Token-Tracking fortsetzen';
    sbPause.show();
    sbStop.show();
    sbHistory.hide(); // Klick auf den Namen öffnet das Panel
  }
  sbMain.tooltip = tooltip();
  if (formatProblem) {
    sbMain.text = `$(warning) ${sbMain.text}`;
    sbMain.tooltip.appendMarkdown('\n\n---\n\n⚠️ Transkript-Format nicht erkannt – Zählung evtl. unvollständig.');
  }
  sbMain.show();
  writeLive();
  postPanel();
}

// ---------- Panel ----------

const PANEL_COMMANDS = ['start', 'togglePause', 'stop', 'discard'];

function showPanel() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('tokenTracker', 'Token Tracker', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [], // das Panel lädt keine Dateien nach
  });
  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = fs
    .readFileSync(path.join(ctx.extensionPath, 'panel.html'), 'utf8')
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{csp\}\}/g, panel.webview.cspSource);
  panel.onDidDispose(() => (panel = null));
  panel.webview.onDidReceiveMessage((msg) => {
    switch (msg.type) {
      case 'ready':
        return postPanel();
      case 'command':
        // nur die Befehle, die das Panel wirklich braucht
        if (PANEL_COMMANDS.includes(msg.command)) return vscode.commands.executeCommand(`tokenTracker.${msg.command}`);
        return;
      case 'edit':
        return editEntry(msg);
      case 'delete':
        return deleteEntry(msg.id);
      case 'merge':
        return mergeEntries(msg.ids);
      case 'continue':
        return continueEntry(msg.id);
      case 'export':
        return exportCsv();
    }
  });
}

function postPanel() {
  if (!panel) return;
  panel.webview.postMessage({
    type: 'state',
    current: session && {
      id: 'current',
      continues: session.continues || null,
      name: session.name,
      project: session.project,
      tags: session.tags,
      scopeLabel: session.scopeLabel,
      state: state(),
      start: session.firstStart ?? session.windows[0].start,
      activeMs: core.activeMs(session),
      models: session.models,
      days: session.days,
    },
    history: loadHistory().filter((e) => e.id !== session?.continues),
    pricesAsOf: PRICES_AS_OF,
  });
}

async function exportCsv() {
  const header =
    'Name;Projekt;Tags;Bereich;Start;Ende;Aktiv (min);Modell;Requests;Input;Output;Cache-Write;Cache-Read;Gesamt;API-Preis (USD)';
  // Text in Anführungszeichen. Beginnt er mit = + - @ (oder Tab/CR), würde Excel ihn
  // als Formel ausführen (CSV-Injection) – dann ein ' voranstellen.
  const q = (s) => {
    const v = String(s ?? '');
    return `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  };
  const lines = [header];
  for (const e of loadHistory()) {
    for (const [m, b] of Object.entries(e.models)) {
      lines.push(
        [
          q(e.name),
          q(e.project),
          q((e.tags || []).join(', ')),
          q(e.scopeLabel),
          new Date(e.start).toISOString(),
          new Date(e.end).toISOString(),
          Math.round(e.activeMs / 60000),
          m,
          b.requests,
          b.input,
          b.output,
          b.cacheWrite,
          b.cacheRead,
          core.bucketTotal(b),
          (b.cost || 0).toFixed(4).replace('.', ','),
        ].join(';')
      );
    }
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-tokens.csv')),
    filters: { CSV: ['csv'] },
  });
  if (!uri) return;
  fs.writeFileSync(uri.fsPath, '﻿' + lines.join('\r\n'));
  vscode.window.showInformationMessage(`Exportiert: ${uri.fsPath}`);
}

// ---------- Aktivierung ----------

function activate(context) {
  ctx = context;
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath.toLowerCase()).join('|');
  liveKey = crypto.createHash('sha1').update(folders || 'no-workspace').digest('hex').slice(0, 12);
  installStatusLineScript();

  sbMain = vscode.window.createStatusBarItem('tokenTracker.main', vscode.StatusBarAlignment.Left, 100);
  sbMain.name = 'Token Tracker for Claude Code';
  sbPause = vscode.window.createStatusBarItem('tokenTracker.pause', vscode.StatusBarAlignment.Left, 99);
  sbPause.name = 'Token Tracker: Pause';
  sbPause.command = 'tokenTracker.togglePause';
  sbStop = vscode.window.createStatusBarItem('tokenTracker.stop', vscode.StatusBarAlignment.Left, 98);
  sbStop.name = 'Token Tracker: Stopp';
  sbStop.text = '$(debug-stop) Stopp';
  sbStop.tooltip = 'Token-Tracking stoppen & speichern';
  sbStop.command = 'tokenTracker.stop';
  sbHistory = vscode.window.createStatusBarItem('tokenTracker.history', vscode.StatusBarAlignment.Left, 99);
  sbHistory.name = 'Token Tracker: Verlauf';
  sbHistory.text = '$(graph) Verlauf';
  sbHistory.tooltip = 'Ältere Messungen und Auswertungen anzeigen';
  sbHistory.command = 'tokenTracker.showPanel';

  const cmds = { start, pause, resume, togglePause, stop, discard, showPanel, setupStatusLine, switchSession };
  for (const [name, fn] of Object.entries(cmds)) {
    context.subscriptions.push(vscode.commands.registerCommand(`tokenTracker.${name}`, fn));
  }
  context.subscriptions.push(
    sbMain,
    sbPause,
    sbStop,
    sbHistory,
    { dispose: stopTimer },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tokenTracker') && render())
  );

  session = restoreSession(context.workspaceState.get(SESSION_KEY));
  seen = restoreSeen(session?.seen);
  // Läuft oder wartet auf Aktivität -> weiter beobachten
  if (session && state() !== 'paused') startTimer();
  render();
  core.checkFormat().then((r) => r.status === 'unknown-format' && warnFormat(r.file), () => {});

  // Für Integrationstests im echten VS Code
  return {
    state: () => ({ state: state(), session, statusText: sbMain.text, panelOpen: !!panel }),
    history: loadHistory,
  };
}

// Beim Schließen des Fensters automatisch pausieren; kommen später neue Tokens,
// zählt das Tracking von selbst weiter. Immer speichern – die Zählerstände werden
// im Betrieb nur alle 15 s gesichert.
function deactivate() {
  stopTimer();
  if (!session) return;
  if (state() === 'running') {
    const now = Date.now();
    lastWindow().end = now;
    session.autoPausedAt = now;
    writeLive();
  }
  return persistSession();
}

module.exports = { activate, deactivate };

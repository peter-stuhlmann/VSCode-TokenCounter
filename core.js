// Liest die lokalen Claude-Code-Transkripte (~/.claude/projects/**/*.jsonl)
// und summiert die Token-Nutzung pro Modell und Tag. Ohne vscode-Abhängigkeit,
// damit es auch direkt mit node getestet werden kann.
//
// Das Transkript-Format ist laut Claude-Code-Doku intern und kann sich mit jedem
// Release ändern. Was hier erwartet wird, steht in isUsageEntry; passt es nicht
// mehr, warnt die Extension (checkFormat), statt still falsch zu zählen.
//
// Abschnitte: Dateien · Zähler · Zeitfenster · Filter · Einlesen · Sitzungsliste ·
// Node für die Statuszeile · Formatierung

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { costOf } = require('./prices');

// Große Transkripte (>100 MB) werden blockweise gelesen, um Speicher zu sparen.
let chunkSize = 8 * 1024 * 1024;

// Linux setzt Datei-Zeitstempel mit einer groben Uhr, die Date.now() um einige ms
// hinterherlaufen kann. Vergleiche von Dateizeiten mit dem Startzeitpunkt bekommen
// deshalb Spielraum; ob eine Antwort zählt, entscheidet ohnehin ihr eigener Zeitstempel.
const FS_CLOCK_SLACK = 1000;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

// Alle Transkripte rekursiv: Hauptdateien <projekt>/<sitzung>.jsonl und
// Subagents <projekt>/<sitzung>/subagents/*.jsonl.
async function listJsonl(dir = projectsDir(), out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Merkt sich die aktuelle Größe aller Dateien: alles davor gehört nicht zur Messung.
async function baselineOffsets() {
  const offsets = {};
  for (const f of await listJsonl()) {
    try {
      offsets[f] = (await fsp.stat(f)).size;
    } catch {}
  }
  return offsets;
}

// ---------- Zähler ----------

function emptyBucket() {
  return { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, unpriced: 0 };
}

const KEYS = Object.keys(emptyBucket());

function addBucket(target, b) {
  for (const k of KEYS) target[k] += b[k] || 0;
  return target;
}

function sumModels(models) {
  const t = emptyBucket();
  for (const b of Object.values(models)) addBucket(t, b);
  return t;
}

// Addiert {model: bucket}-Maps.
function mergeModels(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [model, b] of Object.entries(m || {})) addBucket((out[model] ||= emptyBucket()), b);
  }
  return out;
}

// Addiert {tag: {model: bucket}}-Maps.
function mergeDays(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [day, models] of Object.entries(m || {})) out[day] = mergeModels(out[day], models);
  }
  return out;
}

// a − b je Modell bzw. je Tag und Modell. Für „Fortsetzen": nur den neu hinzugekommenen
// Teil verbuchen. Modelle/Tage ohne Unterschied fallen weg.
function subtractModels(a, b) {
  const out = {};
  for (const [model, x] of Object.entries(a || {})) {
    const y = (b || {})[model] || emptyBucket();
    const d = emptyBucket();
    for (const k of KEYS) d[k] = (x[k] || 0) - (y[k] || 0);
    if (KEYS.some((k) => d[k])) out[model] = d;
  }
  return out;
}

function subtractDays(a, b) {
  const out = {};
  for (const [day, models] of Object.entries(a || {})) {
    const d = subtractModels(models, (b || {})[day]);
    if (Object.keys(d).length) out[day] = d;
  }
  return out;
}

// Gespeicherte Zähler einlesen: fehlende Felder mit 0 auffüllen, damit Summen und
// Anzeige nie an einem undefined scheitern.
function normalizeModels(models) {
  const out = {};
  for (const [m, b] of Object.entries(models || {})) out[m] = { ...emptyBucket(), ...b };
  return out;
}

function bucketTotal(b) {
  return b.input + b.output + b.cacheWrite + b.cacheRead;
}

// Lokaler Kalendertag als JJJJ-MM-TT (für das Diagramm im Panel)
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Zeitfenster ----------

function activeMs(session, now = Date.now()) {
  return session.windows.reduce((ms, w) => ms + ((w.end ?? now) - w.start), session.priorMs || 0);
}

function inWindows(session, t) {
  return session.windows.some((w) => t >= w.start && t < (w.end ?? Infinity));
}

// Nach einer automatischen Pause (Leerlauf) setzt die nächste passende Antwort
// das Tracking von selbst fort – mit ihrem eigenen Zeitstempel als Start.
function autoResume(session, t) {
  const at = session.autoPausedAt;
  if (at == null || t < at) return false;
  const last = session.windows[session.windows.length - 1];
  if (last.end != null) {
    session.windows.push({ start: t, end: null, auto: true });
    return true;
  }
  if (last.auto && t < last.start) {
    last.start = t; // später gelesene, aber frühere Antwort (z. B. Subagent)
    return true;
  }
  return false;
}

// ---------- Filter ----------

// Windows und macOS ignorieren standardmäßig Groß-/Kleinschreibung in Pfaden, Linux nicht.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function normPath(p) {
  const r = path.resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

// Liegt cwd in einem der Ordner (oder ist es einer davon)?
function pathInside(cwd, roots) {
  if (!cwd) return false;
  const c = normPath(cwd);
  return roots.some((root) => {
    const rel = path.relative(normPath(root), c);
    // „..\x" heißt außerhalb – ein Ordner, der nur mit „.." beginnt (z. B. „..cache"), nicht
    const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
    return !outside;
  });
}

// Ordner plus ihr echter Pfad. Claude Code speichert als cwd den echten Pfad (z. B.
// /private/var/… unter macOS), VS Code kennt den Ordner evtl. über einen Symlink.
function withRealPaths(paths) {
  const out = new Set(paths);
  for (const p of paths) {
    try {
      out.add(fs.realpathSync.native(p));
    } catch {}
  }
  return [...out];
}

function inWorkspace(session, cwd) {
  return pathInside(cwd, session.workspacePaths);
}

function inScope(session, entry, file) {
  switch (session.scope) {
    case 'workspace':
      return inWorkspace(session, entry.cwd);
    case 'session':
      if (session.sessionIds.includes(entry.sessionId)) return true;
      // „Nächste neue Sitzung": die erste nach dem Start angelegte Sitzung im Workspace übernehmen
      if (
        session.awaitNew &&
        file.isNewSession &&
        inWorkspace(session, entry.cwd) &&
        !(session.excludeSessions || []).includes(entry.sessionId)
      ) {
        session.sessionIds.push(entry.sessionId);
        session.awaitNew = false;
        session.adoptedSession = { id: entry.sessionId, file: file.path }; // für den Hinweis in VS Code
        // Subagent-Dateien dieser Sitzung, die schon vorher (abgelehnt) gelesen wurden,
        // noch einmal von vorn lesen – seen verhindert Doppelzählung.
        const subDir = path.join(path.dirname(file.path), entry.sessionId) + path.sep;
        for (const f of Object.keys(session.offsets)) if (f.startsWith(subDir)) delete session.offsets[f];
        return true;
      }
      return false;
    default:
      return true;
  }
}

// ---------- Einlesen ----------

// Das Transkript-Format ist keine offizielle Schnittstelle von Claude Code.
// Diese Prüfung beschreibt, was die Extension erwartet; passt nichts mehr
// dazu, warnt die Extension statt still falsch zu zählen.
function isUsageEntry(e) {
  const m = e?.message;
  const u = m?.usage;
  return (
    e?.type === 'assistant' &&
    typeof m?.model === 'string' &&
    typeof u?.input_tokens === 'number' &&
    typeof u?.output_tokens === 'number' &&
    !Number.isNaN(Date.parse(e.timestamp))
  );
}

// Sieht nach einer Antwort mit Token-Zählern aus (aber vielleicht in neuem Format)?
// Nutzer-Nachrichten, in deren Text nur das Wort „usage" vorkommt, zählen nicht.
function isUsageCandidate(e) {
  return e?.type === 'assistant' || (e?.message?.usage != null && typeof e.message.usage === 'object');
}

function countFormat(stats, entry) {
  if (isUsageEntry(entry)) stats.recognized++;
  else if (isUsageCandidate(entry)) stats.unrecognized++;
}

// Claude Code schreibt eine API-Antwort pro Content-Block als eigene Zeile, alle mit
// derselben message.id. Die usage wächst dabei mit: Frühe Zeilen enthalten einen
// Zwischenstand des Outputs, die letzte den Endstand (gemessen: ~14 % der Antworten,
// ~16 % der Output-Tokens). `seen` merkt sich deshalb je Antwort, was schon gezählt
// wurde ({ model, t, day, input, output, cacheWrite, cacheRead, cost }), und spätere
// Zeilen zählen nur den Zuwachs nach.
function ingest(session, seen, entry, file) {
  if (!isUsageEntry(entry) || entry.message.model === '<synthetic>') return false;
  const m = entry.message;
  if (!inScope(session, entry, file)) return false;
  // Ohne jede ID lässt sich nichts zusammenführen: dann einzeln zählen (kommt in echten
  // Transkripten nicht vor, soll aber nicht alle ID-losen Zeilen zu einer verschmelzen).
  const id = m.id || entry.requestId || entry.uuid || null;
  const prev = id ? seen.get(id) : undefined;

  if (prev === undefined) {
    // Neue Antwort: zählt nur, wenn sie in einem aktiven Zeitfenster liegt.
    const t = Date.parse(entry.timestamp);
    if (!inWindows(session, t) && !autoResume(session, t)) return false;
    session.lastActivity = Math.max(session.lastActivity || 0, t);
    if (session.activityTimes) session.activityTimes.push(t);
    return countUsage(session, seen, id, m, t, null);
  }
  // Weitere Zeile einer bereits gezählten Antwort: Zuwachs nachzählen, auch wenn
  // inzwischen pausiert wurde – die Antwort hat im aktiven Zeitraum begonnen.
  return countUsage(session, seen, id, m, prev.t, prev);
}

// Bucht den Stand einer Antwort (bzw. den Zuwachs gegenüber prev) auf Modell und Tag.
// t = Zeitstempel der ersten Zeile der Antwort (bestimmt den Tag im Diagramm).
function countUsage(session, seen, id, m, t, prev) {
  const day = prev?.day ?? dayKey(t);
  const u = m.usage;
  const now = {
    input: Math.max(prev?.input ?? 0, u.input_tokens || 0),
    output: Math.max(prev?.output ?? 0, u.output_tokens || 0),
    cacheWrite: Math.max(prev?.cacheWrite ?? 0, u.cache_creation_input_tokens || 0),
    cacheRead: Math.max(prev?.cacheRead ?? 0, u.cache_read_input_tokens || 0),
  };
  const cost = costOf(
    m.model,
    { ...u, input_tokens: now.input, output_tokens: now.output, cache_creation_input_tokens: now.cacheWrite, cache_read_input_tokens: now.cacheRead },
    session.priceOverrides
  );
  const add = {
    requests: prev ? 0 : 1,
    input: now.input - (prev?.input ?? 0),
    output: now.output - (prev?.output ?? 0),
    cacheWrite: now.cacheWrite - (prev?.cacheWrite ?? 0),
    cacheRead: now.cacheRead - (prev?.cacheRead ?? 0),
    cost: (cost ?? 0) - (prev?.cost ?? 0),
    unpriced: !prev && cost == null ? 1 : 0,
  };
  if (prev && !add.input && !add.output && !add.cacheWrite && !add.cacheRead && !add.cost) return false;
  if (id) seen.set(id, { model: m.model, t, day, ...now, cost: cost ?? 0 });
  addBucket((session.models[m.model] ||= emptyBucket()), add);
  const dayBucket = (session.days[day] ||= {});
  addBucket((dayBucket[m.model] ||= emptyBucket()), add);
  return true;
}

// Weitere Zeilen derselben Antwort kommen innerhalb von Sekunden bis wenigen Minuten
// (gemessen: Median 2,7 s, Maximum 5 min). Ältere Einträge in seen braucht es nicht
// mehr – die Offsets verhindern, dass Zeilen erneut gelesen werden. So bleibt der
// gespeicherte Zustand klein, auch an Tagen mit Tausenden Antworten.
const SEEN_KEEP_MS = 15 * 60000;

function recentSeen(seen, now = Date.now()) {
  const out = new Map();
  for (const [id, v] of seen) if (v && v.t >= now - SEEN_KEEP_MS) out.set(id, v);
  return out;
}

// Teilt einen rückwirkenden Zeitraum an Lücken ohne Aktivität, die länger als
// idleMs sind, in Zeitfenster auf. Das letzte Fenster bleibt offen.
function splitByIdle(start, times, idleMs) {
  const windows = [];
  let cur = start;
  let prev = start;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t - prev > idleMs) {
      if (prev > cur) windows.push({ start: cur, end: prev });
      cur = t;
    }
    prev = Math.max(prev, t);
  }
  windows.push({ start: cur, end: null });
  return windows;
}

// Liest [from, to) in Blöcken, verarbeitet nur vollständige Zeilen und gibt
// den Offset hinter der letzten vollständigen Zeile zurück.
async function readNew(file, from, to, onLine) {
  const fh = await fsp.open(file, 'r');
  let pos = from;
  let next = from;
  let pending = Buffer.alloc(0);
  try {
    while (pos < to) {
      const buf = Buffer.alloc(Math.min(chunkSize, to - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl < 0) {
        pending = data;
        continue;
      }
      for (const line of data.toString('utf8', 0, lastNl).split('\n')) onLine(line);
      next = pos - (data.length - lastNl - 1);
      pending = data.subarray(lastNl + 1);
    }
  } finally {
    await fh.close();
  }
  return next;
}

function sessionFileId(root, f) {
  // Hauptdatei einer Sitzung: <projects>/<ordner>/<sessionId>.jsonl
  return path.dirname(path.dirname(f)) === root ? path.basename(f, '.jsonl') : null;
}

// Liest alle seit dem letzten Aufruf angehängten Zeilen. Gibt true zurück,
// wenn sich die Zähler geändert haben.
//   seen:  Map message-id -> gezählter Stand (siehe ingest)
//   stats: zählt erkannte und nicht erkannte Antwort-Zeilen (für die Format-Warnung)
//   only:  optional nur diese Dateien prüfen (von der Dateiüberwachung gemeldet);
//          ohne Angabe werden alle Transkripte geprüft
async function scan(session, seen, stats = { recognized: 0, unrecognized: 0 }, only = null) {
  const root = projectsDir();
  const start = session.windows[0].start;
  let files = only ? only.filter((f) => f.endsWith('.jsonl')) : await listJsonl(root);
  if (session.scope === 'session' && !session.awaitNew) {
    files = files.filter((f) => session.sessionIds.some((id) => f.includes(id)));
  }
  // Hauptdateien vor Subagent-Dateien: Bei „Nächste neue Sitzung" muss die Sitzung
  // übernommen sein, bevor ihre Subagents gelesen werden.
  const depth = (f) => f.split(path.sep).length;
  files.sort((a, b) => depth(a) - depth(b));
  let changed = false;
  for (const f of files) {
    let st;
    try {
      st = await fsp.stat(f);
    } catch {
      continue;
    }
    let off = session.offsets[f];
    if (off === undefined) {
      // Nicht in der Baseline: alter Stand -> überspringen, sonst von vorn lesen.
      const isNew = st.mtimeMs >= start - FS_CLOCK_SLACK;
      off = isNew ? 0 : st.size;
      session.offsets[f] = off;
      // Eine Sitzungsdatei, die beim Start noch nicht existierte, ist eine neue Sitzung.
      // (Nicht über die Erstellungszeit: die fehlt auf manchen Linux-Dateisystemen.)
      if (isNew && session.awaitNew && sessionFileId(root, f)) (session.newFiles ||= []).push(f);
    }
    if (st.size < off) off = 0; // Datei wurde neu geschrieben; seen verhindert Doppelzählung
    if (st.size === off) continue;
    const file = {
      path: f,
      isNewSession: (session.newFiles || []).includes(f),
    };
    try {
      session.offsets[f] = await readNew(f, off, st.size, (line) => {
        if (!line.includes('"usage"')) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          return; // kaputte Zeile o. Ä.
        }
        countFormat(stats, entry);
        if (ingest(session, seen, entry, file)) changed = true;
      });
    } catch {}
  }
  return changed;
}

// ---------- Sitzungsliste ----------

async function readSlice(file, pos, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function sessionInfo(s) {
  const head = await readSlice(s.file, 0, Math.min(s.size, 256 * 1024));
  const tail = s.size > 256 * 1024 ? await readSlice(s.file, Math.max(0, s.size - 512 * 1024), 512 * 1024) : '';
  let customTitle, aiTitle, lastPrompt, firstPrompt;
  for (const line of (head + '\n' + tail).split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!s.start && e.timestamp) s.start = Date.parse(e.timestamp);
    if (!s.cwd && e.cwd) s.cwd = e.cwd;
    if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle;
    if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
    if (!firstPrompt && e.type === 'user') firstPrompt = promptText(e.message?.content);
  }
  const prompt = lastPrompt || firstPrompt || '';
  s.title = customTitle || aiTitle || (prompt ? prompt.replace(/\s+/g, ' ').slice(0, 60) : s.id.slice(0, 8));
  s.lastPrompt = prompt;
  return s;
}

// Text einer Nutzer-Nachricht (ohne Tool-Ergebnisse)
function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find((c) => c.type === 'text')?.text || '';
  return '';
}

async function sessionInfoFromFile(file) {
  const st = await fsp.stat(file);
  return sessionInfo({ id: path.basename(file, '.jsonl'), file, size: st.size, mtime: st.mtimeMs });
}

// Die zuletzt aktiven Claude-Code-Sitzungen, neueste zuerst.
async function listSessions({ maxAgeDays = 14, limit = 40, info = true } = {}) {
  const root = projectsDir();
  const since = Date.now() - maxAgeDays * 864e5;
  const found = [];
  let dirs = [];
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try {
      files = await fsp.readdir(path.join(root, d.name));
    } catch {}
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, d.name, name);
      try {
        const st = await fsp.stat(file);
        if (st.mtimeMs >= since) found.push({ id: name.slice(0, -6), file, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const top = found.slice(0, limit);
  return info ? Promise.all(top.map(sessionInfo)) : top;
}

// Prüft am neuesten Transkript, ob das Format noch passt.
// 'ok' | 'no-dir' (kein Claude Code gefunden) | 'no-data' (noch nichts zum Prüfen)
// | 'unknown-format' (Antworten vorhanden, aber nicht erkennbar)
async function checkFormat() {
  try {
    await fsp.access(projectsDir());
  } catch {
    return { status: 'no-dir' };
  }
  const [latest] = await listSessions({ maxAgeDays: 3650, limit: 1, info: false });
  if (!latest) return { status: 'no-data' };
  const text = await readSlice(latest.file, Math.max(0, latest.size - 2 * 1024 * 1024), 2 * 1024 * 1024);
  const stats = { recognized: 0, unrecognized: 0 };
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      countFormat(stats, JSON.parse(line));
    } catch {}
  }
  if (stats.recognized) return { status: 'ok', file: latest.file };
  return { status: stats.unrecognized ? 'unknown-format' : 'no-data', file: latest.file };
}

// ---------- Node für die Claude-Code-Statuszeile ----------

// Auf macOS/Linux kennen aus Dock bzw. Menü gestartete Programme den PATH der
// Login-Shell oft nicht (Node über Homebrew oder nvm). Deshalb dort den absoluten
// Pfad zu node liefern, wie ihn die Shell des Nutzers findet.
function nodeCommand(platform = process.platform, shell = process.env.SHELL || '/bin/sh') {
  if (platform === 'win32') return 'node';
  for (const flags of ['-lc', '-ic']) {
    try {
      const out = require('child_process').execFileSync(shell, [flags, 'command -v node'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const p = out.trim().split('\n').pop();
      if (p && path.isAbsolute(p) && fs.existsSync(p)) return `"${p}"`;
    } catch {}
  }
  return 'node';
}

// ---------- Formatierung ----------

// Deutsche Schreibweise, überall gleich (Statusleiste, Tooltip, Panel, Claude-Code-Statuszeile):
// 291,6 k · 1,23 Mio. · 2,10 Mrd.
function fmtShort(n = 0) {
  const dec = (v, d) => v.toFixed(d).replace('.', ',');
  if (n >= 1e9) return `${dec(n / 1e9, 2)} Mrd.`;
  if (n >= 1e6) return `${dec(n / 1e6, 2)} Mio.`;
  if (n >= 1e3) return `${dec(n / 1e3, 1)} k`;
  return String(Math.round(n));
}

// $0 · $0,036 · $4,73 · $1.652
function fmtUsd(n = 0) {
  if (n === 0) return '$0';
  if (n >= 100) return '$' + Math.round(n).toLocaleString('de-DE');
  return '$' + n.toFixed(n >= 1 ? 2 : 3).replace('.', ',');
}

// 12 min · 1 h 05 min
function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}

// claude-opus-5-5 -> Opus 5.5, claude-sonnet-4-5-20250929 -> Sonnet 4.5, …[1m] -> (1M)
function prettyModel(m) {
  let s = m.replace(/^claude-/, '');
  const big = /\[1m\]$/i.test(s);
  s = s.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  const mm = s.match(/^([a-z]+)-([\d-]+)$/) || s.match(/^([\d-]+)-([a-z]+)$/);
  if (mm) {
    const [fam, ver] = /^\d/.test(mm[1]) ? [mm[2], mm[1]] : [mm[1], mm[2]];
    s = fam[0].toUpperCase() + fam.slice(1) + ' ' + ver.replace(/-/g, '.');
  }
  return s + (big ? ' (1M)' : '');
}

module.exports = {
  projectsDir,
  claudeDir,
  listJsonl,
  baselineOffsets,
  scan,
  recentSeen,
  splitByIdle,
  listSessions,
  sessionInfoFromFile,
  checkFormat,
  isUsageEntry,
  pathInside,
  withRealPaths,
  nodeCommand,
  // nur für Tests: kleine Blöcke, um Blockgrenzen zu prüfen
  _setChunkSize: (n) => (chunkSize = n),
  emptyBucket,
  sumModels,
  normalizeModels,
  mergeModels,
  mergeDays,
  subtractModels,
  subtractDays,
  bucketTotal,
  activeMs,
  dayKey,
  fmtShort,
  fmtUsd,
  fmtDuration,
  prettyModel,
};

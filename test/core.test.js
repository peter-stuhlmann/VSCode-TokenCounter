const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpClaude, transcript, assistant, append, mkSession, sleep } = require('./helpers');
const core = require('../core');
const { costOf } = require('../prices');

let tmp;
beforeEach(() => (tmp = tmpClaude()));
afterEach(() => {
  core._setChunkSize(8 * 1024 * 1024);
  tmp.cleanup();
});

const MIN = 60000;
const total = (s) => core.sumModels(s.models);

test('zählt pro Modell und dedupliziert mehrfach geschriebene Antworten', async () => {
  const f = transcript(tmp.dir, 's1');
  const a = assistant({ output: 100 });
  // Claude Code schreibt eine Antwort pro Content-Block als eigene Zeile, mit derselben usage
  append(f, a, a, a, assistant({ model: 'claude-haiku-5-5', output: 7 }));
  const s = mkSession();
  await core.scan(s, new Map());
  assert.equal(s.models['claude-opus-5-5'].requests, 1);
  assert.equal(s.models['claude-opus-5-5'].output, 100);
  assert.equal(s.models['claude-haiku-5-5'].output, 7);
});

test('wachsender Output einer Antwort: es zählt der Endstand, nicht die erste Zeile', async () => {
  // So schreibt Claude Code gestreamte Antworten: gleiche message.id, Output wächst
  const id = 'msg_wachsend';
  append(
    transcript(tmp.dir, 's1'),
    assistant({ id, output: 10, cacheWrite: 39412, cacheWrite1h: 39412 }),
    assistant({ id, output: 10, cacheWrite: 39412, cacheWrite1h: 39412 }),
    assistant({ id, output: 357, cacheWrite: 39412, cacheWrite1h: 39412 })
  );
  const s = mkSession();
  await core.scan(s, new Map());
  const b = s.models['claude-opus-5-5'];
  assert.equal(b.requests, 1);
  assert.equal(b.output, 357);
  assert.equal(b.cacheWrite, 39412); // nicht dreifach
  const final = assistant({ id, output: 357, cacheWrite: 39412, cacheWrite1h: 39412 }).message.usage;
  assert.ok(Math.abs(b.cost - costOf('claude-opus-5-5', final)) < 1e-12);
  // Tageswerte stimmen mit den Modellsummen überein
  assert.deepEqual(Object.values(s.days)[0]['claude-opus-5-5'], b);
});

test('Endstand einer Antwort zählt auch, wenn er erst nach der Pause geschrieben wird', async () => {
  const now = Date.now();
  const f = transcript(tmp.dir, 's1');
  const s = mkSession({ windows: [{ start: now - 60 * MIN, end: now - 5 * MIN }] });
  const seen = new Map();
  append(f, assistant({ id: 'm1', t: now - 6 * MIN, output: 10 }));
  await core.scan(s, seen);
  append(f, assistant({ id: 'm1', t: now - 4 * MIN, output: 900 })); // nach dem Pausieren geschrieben
  append(f, assistant({ id: 'm2', t: now - 4 * MIN, output: 5 })); // neue Antwort in der Pause
  await core.scan(s, seen);
  assert.equal(total(s).output, 900);
  assert.equal(total(s).requests, 1);
});

test('bereits gezählte Antworten werden beim erneuten Lesen nicht doppelt gezählt', async () => {
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ id: 'a', output: 50 }), assistant({ id: 'b', output: 7 }));
  const s = mkSession();
  const seen = new Map();
  await core.scan(s, seen);
  s.offsets = {}; // z. B. Neuzählung bei unverändertem seen
  await core.scan(s, seen);
  assert.equal(total(s).output, 57);
  assert.equal(total(s).requests, 2);
});

test('scan mit Dateiliste prüft nur die gemeldeten Dateien', async () => {
  const a = transcript(tmp.dir, 'a');
  const b = transcript(tmp.dir, 'b');
  append(a, assistant({ output: 1 }));
  append(b, assistant({ output: 10 }));
  const s = mkSession();
  const seen = new Map();
  await core.scan(s, seen, undefined, [a, path.join(tmp.dir, 'kein-transkript.txt')]);
  assert.equal(total(s).output, 1);
  await core.scan(s, seen); // voller Durchlauf holt den Rest
  assert.equal(total(s).output, 11);
});

test('übernimmt alle vier Token-Arten und den Preis', async () => {
  const f = transcript(tmp.dir, 's1');
  const a = assistant({ input: 1000, output: 2000, cacheWrite: 3000, cacheWrite1h: 1000, cacheRead: 10000 });
  append(f, a);
  const s = mkSession();
  await core.scan(s, new Map());
  const b = s.models['claude-opus-5-5'];
  assert.deepEqual([b.input, b.output, b.cacheWrite, b.cacheRead], [1000, 2000, 3000, 10000]);
  assert.equal(b.cost, costOf('claude-opus-5-5', a.message.usage));
  assert.equal(b.unpriced, 0);
});

test('ignoriert alles vor der Baseline', async () => {
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ output: 1 }));
  const s = mkSession({ offsets: await core.baselineOffsets() });
  append(f, assistant({ output: 2 }));
  await core.scan(s, new Map());
  assert.equal(total(s).output, 2);
});

test('zählt nur Antworten aus aktiven Zeitfenstern (Pause)', async () => {
  const now = Date.now();
  const s = mkSession({
    windows: [
      { start: now - 60 * MIN, end: now - 40 * MIN },
      { start: now - 20 * MIN, end: null },
    ],
  });
  append(
    transcript(tmp.dir, 's1'),
    assistant({ t: now - 50 * MIN, output: 1 }), // aktiv
    assistant({ t: now - 30 * MIN, output: 10 }), // Pause
    assistant({ t: now - 10 * MIN, output: 100 }), // aktiv
    assistant({ t: now - 90 * MIN, output: 1000 }) // vor dem Start
  );
  await core.scan(s, new Map());
  assert.equal(total(s).output, 101);
});

test('liest halb geschriebene Zeilen erst, wenn sie vollständig sind', async () => {
  const f = transcript(tmp.dir, 's1');
  const s = mkSession();
  const seen = new Map();
  append(f, assistant({ output: 1 }));
  append(f, JSON.stringify(assistant({ output: 2 }))); // noch ohne Zeilenumbruch
  await core.scan(s, seen);
  assert.equal(total(s).output, 1);
  append(f, '\n');
  await core.scan(s, seen);
  assert.equal(total(s).output, 3);
  assert.equal(s.offsets[f], fs.statSync(f).size);
});

test('Blockgrenzen beim Lesen großer Dateien ändern nichts am Ergebnis', async () => {
  const f = transcript(tmp.dir, 's1');
  for (let i = 1; i <= 50; i++) append(f, assistant({ output: i, model: i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5' }));
  const big = mkSession();
  await core.scan(big, new Map());
  core._setChunkSize(37); // kleiner als eine Zeile
  const small = mkSession();
  await core.scan(small, new Map());
  assert.deepEqual(small.models, big.models);
  assert.equal(total(small).output, (50 * 51) / 2);
});

test('Workspace-Filter: Unterordner zählen, Nachbarordner nicht', async () => {
  const root = path.join(tmp.dir, 'work', 'REA'); // echter Pfad des Systems
  append(
    transcript(tmp.dir, 's1'),
    assistant({ cwd: root, output: 1 }),
    assistant({ cwd: path.join(root, 'src', 'app'), output: 10 }),
    assistant({ cwd: `${root}-2`, output: 1000 }),
    assistant({ cwd: path.join(tmp.dir, 'other'), output: 10000 })
  );
  const s = mkSession({ scope: 'workspace', workspacePaths: [root] });
  await core.scan(s, new Map());
  assert.equal(total(s).output, 11);
});

test('Workspace-Filter: Groß-/Kleinschreibung wie das Betriebssystem', async () => {
  const root = path.join(tmp.dir, 'work', 'REA');
  const other = path.join(tmp.dir, 'work', 'rea');
  append(transcript(tmp.dir, 's1'), assistant({ cwd: other, output: 1 }));
  const s = mkSession({ scope: 'workspace', workspacePaths: [root] });
  await core.scan(s, new Map());
  // Windows und macOS: derselbe Ordner. Linux: ein anderer.
  const sameFolder = process.platform === 'win32' || process.platform === 'darwin';
  assert.equal(total(s).output, sameFolder ? 1 : 0);
  if (process.platform === 'win32') {
    // unter Windows auch mit Backslashes und kleinem Laufwerksbuchstaben
    assert.ok(core.pathInside(root.replace(/\//g, '\\').toLowerCase() + '\\src', [root]));
  }
});

test('Sitzungs-Filter: nur diese Sitzung inklusive Subagents', async () => {
  append(transcript(tmp.dir, 's1'), assistant({ sessionId: 's1', output: 1 }));
  append(transcript(tmp.dir, 's1', { agent: 'a1' }), assistant({ sessionId: 's1', output: 10 }));
  append(transcript(tmp.dir, 's2'), assistant({ sessionId: 's2', output: 100 }));
  const s = mkSession({ scope: 'session', sessionIds: ['s1'] });
  await core.scan(s, new Map());
  assert.equal(total(s).output, 11);
});

test('„Nächste neue Sitzung" übernimmt die erste neue Sitzung im Workspace', async () => {
  const old = transcript(tmp.dir, 's-old');
  append(old, assistant({ sessionId: 's-old', output: 1 }));
  await sleep(1100); // länger als der Spielraum für grobe Datei-Uhren (1 s)
  const s = mkSession({
    scope: 'session',
    awaitNew: true,
    workspacePaths: ['C:/work/REA'],
    createdAt: Date.now(),
    windows: [{ start: Date.now(), end: null }],
    offsets: await core.baselineOffsets(),
  });
  await sleep(20);
  const seen = new Map();
  // neue Subagent-Datei einer alten Sitzung ist keine neue Sitzung
  append(transcript(tmp.dir, 's-old', { agent: 'x' }), assistant({ sessionId: 's-old', output: 10 }));
  append(old, assistant({ sessionId: 's-old', output: 100 }));
  // neue Sitzung in einem anderen Ordner zählt nicht
  append(transcript(tmp.dir, 's-elsewhere', { project: 'other' }), assistant({ sessionId: 's-elsewhere', cwd: 'C:/other', output: 1000 }));
  await core.scan(s, seen);
  assert.equal(total(s).output, 0);
  assert.equal(s.awaitNew, true);

  append(transcript(tmp.dir, 's-new'), assistant({ sessionId: 's-new', output: 5 }));
  await core.scan(s, seen);
  assert.deepEqual(s.sessionIds, ['s-new']);
  assert.equal(s.awaitNew, false);

  append(transcript(tmp.dir, 's-new2'), assistant({ sessionId: 's-new2', output: 50 }));
  append(transcript(tmp.dir, 's-new', { agent: 'y' }), assistant({ sessionId: 's-new', output: 500 }));
  await core.scan(s, seen);
  assert.equal(total(s).output, 505);
});

test('nach automatischer Pause setzt die nächste Antwort das Tracking fort', async () => {
  const now = Date.now();
  const pausedAt = now - 30 * MIN;
  const s = mkSession({ windows: [{ start: now - 60 * MIN, end: pausedAt }], autoPausedAt: pausedAt });
  const seen = new Map();
  append(transcript(tmp.dir, 's1'), assistant({ t: now - 10 * MIN, output: 1 }));
  await core.scan(s, seen);
  assert.equal(s.windows.length, 2);
  assert.equal(s.windows[1].start, now - 10 * MIN);
  assert.equal(s.windows[1].end, null);

  // später gelesene, aber frühere Antwort (z. B. aus einer Subagent-Datei) zieht den Start vor
  append(transcript(tmp.dir, 's1', { agent: 'a' }), assistant({ t: now - 20 * MIN, output: 10 }));
  await core.scan(s, seen);
  assert.equal(s.windows[1].start, now - 20 * MIN);
  assert.equal(total(s).output, 11);
});

test('nach manueller Pause zählt nichts von selbst weiter', async () => {
  const now = Date.now();
  const s = mkSession({ windows: [{ start: now - 60 * MIN, end: now - 30 * MIN }], autoPausedAt: null });
  append(transcript(tmp.dir, 's1'), assistant({ t: now - 10 * MIN, output: 1 }));
  await core.scan(s, new Map());
  assert.equal(total(s).output, 0);
  assert.equal(s.windows.length, 1);
});

test('verteilt Tokens auf Kalendertage', async () => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const yesterday = today.getTime() - 24 * 60 * MIN;
  const s = mkSession({ windows: [{ start: yesterday - MIN, end: null }] });
  append(transcript(tmp.dir, 's1'), assistant({ t: yesterday, output: 1 }), assistant({ t: today.getTime(), output: 2 }));
  await core.scan(s, new Map());
  assert.equal(s.days[core.dayKey(yesterday)]['claude-opus-5-5'].output, 1);
  assert.equal(s.days[core.dayKey(today.getTime())]['claude-opus-5-5'].output, 2);
});

test('listSessions liest Titel, Start und Ordner', async () => {
  const f = transcript(tmp.dir, 'abc');
  append(
    f,
    { type: 'queue-operation', timestamp: '2026-10-15T10:00:00.000Z', sessionId: 'abc' },
    { type: 'user', cwd: 'C:/work/REA', sessionId: 'abc', timestamp: '2026-10-15T10:00:01.000Z', message: { role: 'user', content: 'Hallo' } },
    { type: 'ai-title', aiTitle: 'KI-Titel', sessionId: 'abc' },
    { type: 'custom-title', customTitle: 'Mein Titel', sessionId: 'abc' },
    { type: 'last-prompt', lastPrompt: 'Mach mal', sessionId: 'abc' }
  );
  const [s] = await core.listSessions();
  assert.equal(s.id, 'abc');
  assert.equal(s.title, 'Mein Titel');
  assert.equal(s.cwd, 'C:/work/REA');
  assert.equal(s.start, Date.parse('2026-10-15T10:00:00.000Z'));
  assert.equal(s.lastPrompt, 'Mach mal');
});

test('checkFormat erkennt bekanntes, unbekanntes und fehlendes Format', async () => {
  const f = transcript(tmp.dir, 's1');
  assert.equal((await core.checkFormat()).status, 'no-data');

  // Nutzer-Nachricht, deren Text nur die Wörter enthält: kein Alarm
  append(f, { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'zeig "usage" vom "assistant"' } });
  assert.equal((await core.checkFormat()).status, 'no-data');

  // Antwort, deren Token-Zähler umbenannt wurden
  append(f, { type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'x', usage: { in: 1, out: 2 } } });
  assert.equal((await core.checkFormat()).status, 'unknown-format');

  append(f, assistant());
  assert.equal((await core.checkFormat()).status, 'ok');

  process.env.CLAUDE_CONFIG_DIR = path.join(tmp.dir, 'gibt-es-nicht');
  assert.equal((await core.checkFormat()).status, 'no-dir');
});

test('scan zählt erkannte und nicht erkannte Antwort-Zeilen', async () => {
  append(
    transcript(tmp.dir, 's1'),
    assistant(),
    { type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'x', usage: { tokens: 5 } } }
  );
  const stats = { recognized: 0, unrecognized: 0 };
  await core.scan(mkSession(), new Map(), stats);
  assert.deepEqual(stats, { recognized: 1, unrecognized: 1 });
});

test('splitByIdle schneidet lange Lücken als Pausen heraus', () => {
  const m = (x) => x * MIN;
  // Start bei 0, Aktivität 5, 10 | Lücke | 40, 42; Grenze 15 min
  assert.deepEqual(core.splitByIdle(0, [m(42), m(5), m(10), m(40)], m(15)), [
    { start: 0, end: m(10) },
    { start: m(40), end: null },
  ]);
  // erste Aktivität erst nach langer Zeit: Fenster beginnt dort
  assert.deepEqual(core.splitByIdle(0, [m(30)], m(15)), [{ start: m(30), end: null }]);
  // keine Aktivität: ein offenes Fenster ab Start
  assert.deepEqual(core.splitByIdle(0, [], m(15)), [{ start: 0, end: null }]);
});

test('„Nächste neue Sitzung" überspringt ausgeschlossene Sitzungen', async () => {
  const s = mkSession({
    scope: 'session',
    awaitNew: true,
    workspacePaths: ['C:/work/REA'],
    createdAt: Date.now() - 1000,
    excludeSessions: ['s-a'],
  });
  append(transcript(tmp.dir, 's-a'), assistant({ sessionId: 's-a', output: 1 }));
  append(transcript(tmp.dir, 's-b'), assistant({ sessionId: 's-b', output: 10 }));
  await core.scan(s, new Map());
  assert.deepEqual(s.sessionIds, ['s-b']);
  assert.equal(total(s).output, 10);
  assert.equal(s.adoptedSession.id, 's-b');
});

test('Sitzungstitel: ohne Titel die erste Nutzer-Nachricht', async () => {
  append(transcript(tmp.dir, 'neu'), {
    type: 'user',
    sessionId: 'neu',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'Baue einen   Login' }] },
  });
  const [s] = await core.listSessions();
  assert.equal(s.title, 'Baue einen Login');
});

test('Statuszeile: Node-Aufruf passend zum Betriebssystem', () => {
  assert.equal(core.nodeCommand('win32'), 'node');
  if (process.platform !== 'win32') {
    // macOS/Linux: absoluter Pfad aus der Shell, in Anführungszeichen
    const cmd = core.nodeCommand();
    assert.match(cmd, /^"\/.+node"$/);
    assert.ok(fs.existsSync(cmd.slice(1, -1)));
    // Shell ohne node -> Rückfall auf „node"
    assert.equal(core.nodeCommand('linux', '/bin/false'), 'node');
  }
});

test('normalizeModels füllt fehlende Felder mit 0 und lässt vorhandene stehen', () => {
  const n = core.normalizeModels({ 'claude-opus-5-5': { output: 1000, cost: 1.5 } })['claude-opus-5-5'];
  assert.deepEqual(n, { requests: 0, input: 0, output: 1000, cacheWrite: 0, cacheRead: 0, cost: 1.5, unpriced: 0 });
  assert.deepEqual(core.normalizeModels(undefined), {});
});

test('Workspace über Symlink/Junction: echter Pfad aus Claude Code wird erkannt', async () => {
  const real = path.join(tmp.dir, 'echt', 'REA');
  const link = path.join(tmp.dir, 'link-REA');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link, 'junction'); // Junction: unter Windows ohne Adminrechte möglich
  // ohne Auflösung: Claude-Code-cwd (echter Pfad) liegt nicht im verlinkten Ordner
  assert.equal(core.pathInside(path.join(real, 'src'), [link]), false);
  const roots = core.withRealPaths([link]);
  assert.deepEqual(roots, [link, fs.realpathSync.native(link)]);
  assert.equal(core.pathInside(path.join(real, 'src'), roots), true);
  assert.deepEqual(core.withRealPaths(['/gibt/es/nicht']), ['/gibt/es/nicht']);
});

test('neue Sitzung mit Subagent – beide werden gezählt, egal in welcher Reihenfolge gelesen', async () => {
  const s = mkSession({ scope: 'session', awaitNew: true, workspacePaths: ['C:/work/REA'], offsets: await core.baselineOffsets() });
  // Subagent-Datei zuerst anlegen (unter Windows liefert readdir sie oft vor der Hauptdatei)
  append(transcript(tmp.dir, 'neu', { agent: 'x' }), assistant({ sessionId: 'neu', output: 1000 }));
  append(transcript(tmp.dir, 'neu'), assistant({ sessionId: 'neu', output: 1 }));
  await core.scan(s, new Map());
  assert.equal(total(s).output, 1001);
});

test('wurde eine Subagent-Datei vor der Übernahme abgelehnt, wird sie danach neu gelesen', async () => {
  const s = mkSession({ scope: 'session', awaitNew: true, workspacePaths: ['C:/work/REA'], offsets: await core.baselineOffsets() });
  const seen = new Map();
  const sub = transcript(tmp.dir, 'neu', { agent: 'x' });
  append(sub, assistant({ sessionId: 'neu', output: 1000 }));
  await core.scan(s, seen, undefined, [sub]); // nur der Subagent gemeldet: noch nichts übernommen
  assert.equal(total(s).output, 0);
  append(transcript(tmp.dir, 'neu'), assistant({ sessionId: 'neu', output: 1 }));
  await core.scan(s, seen);
  assert.equal(total(s).output, 1001);
});

test('eine schon vorhandene Sitzung mit neuen Zeilen wird nicht als „neu" übernommen', async () => {
  const old = transcript(tmp.dir, 'alt');
  append(old, assistant({ sessionId: 'alt', output: 1 }));
  const s = mkSession({ scope: 'session', awaitNew: true, workspacePaths: ['C:/work/REA'], windows: [{ start: Date.now(), end: null }], offsets: await core.baselineOffsets() });
  append(old, assistant({ sessionId: 'alt', output: 50 }));
  await core.scan(s, new Map());
  assert.equal(s.awaitNew, true);
  assert.equal(total(s).output, 0);
});

test('Antworten ganz ohne ID werden einzeln gezählt, nicht zu einer verschmolzen', async () => {
  const noId = (output) => { const a = assistant({ output }); delete a.message.id; delete a.requestId; delete a.uuid; return a; };
  append(transcript(tmp.dir, 's1'), noId(1), noId(10), noId(100));
  const s = mkSession();
  await core.scan(s, new Map());
  assert.equal(total(s).output, 111);
  assert.equal(total(s).requests, 3);
});

test('Ordner, deren Name mit „.." beginnt, liegen im Workspace', () => {
  const root = path.join(tmp.dir, 'work');
  assert.equal(core.pathInside(path.join(root, '..cache', 'x'), [root]), true);
  assert.equal(core.pathInside(path.join(root, '..'), [root]), false);
  assert.equal(core.pathInside(path.join(root, '..', 'nachbar'), [root]), false);
});

test('seen behält nur die letzten Minuten', () => {
  const now = Date.now();
  const seen = new Map([
    ['frisch', { t: now - 60000 }],
    ['alt', { t: now - 60 * 60000 }],
    ['unbekannt', null],
  ]);
  assert.deepEqual([...core.recentSeen(seen, now).keys()], ['frisch']);
});

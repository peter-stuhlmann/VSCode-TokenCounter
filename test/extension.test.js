// Testet den Ablauf in VS Code (Start-Dialog, Pause, Stopp, Leerlauf, Verlauf, Sicherheit)
// mit einer nachgebauten vscode-API.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpClaude, transcript, assistant, append, sleep, createVscode, activateExtension, pick, type } = require('./helpers');

const MIN = 60000;
let tmp;
let active;
beforeEach(() => (tmp = tmpClaude()));
afterEach(async () => {
  await active?.ext.deactivate(); // Timer stoppen
  active = null;
  tmp.cleanup();
});

const statusText = (items) => items.find((i) => i.id === 'tokenTracker.main').text;
const cmd = (commands, name) => commands[`tokenTracker.${name}`]();

test('Start → Pause → Weiter → Stopp speichert Name, Tags, Projekt, Tokens und Preis', async () => {
  const vs = createVscode({
    folders: ['C:/work/REA'],
    answers: [
      pick((i) => i.scope === 'all'),
      type('Login-Bug #bugfix #frontend'),
      pick((i) => i.label.includes('Ab jetzt')),
    ],
  });
  active = activateExtension({ claudeDir: tmp.dir });
  assert.equal(statusText(vs.items), '$(play) Tokens');

  await cmd(vs.commands, 'start');
  await sleep(5);
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ output: 1000, cacheWrite: 2000, cacheWrite1h: 2000 }));
  await cmd(vs.commands, 'pause'); // liest vor dem Pausieren noch ein
  assert.match(statusText(vs.items), /^\$\(debug-pause\) Login-Bug: 3,0 k Tokens · \$0,036 \(pausiert\)$/);

  append(f, assistant({ output: 99 })); // während der Pause: zählt nicht
  await sleep(5);
  await cmd(vs.commands, 'resume');
  append(f, assistant({ output: 1 }));
  await cmd(vs.commands, 'stop');

  assert.equal(statusText(vs.items), '$(play) Tokens');
  const [e] = active.history();
  assert.equal(e.name, 'Login-Bug');
  assert.deepEqual(e.tags, ['bugfix', 'frontend']);
  assert.equal(e.project, 'REA');
  assert.equal(e.models['claude-opus-5-5'].requests, 2);
  assert.equal(e.models['claude-opus-5-5'].output, 1001);
  assert.ok(e.models['claude-opus-5-5'].cost > 0);
  assert.ok(Object.keys(e.days).length === 1);
  assert.equal(vs.answers.length, 0, 'alle Dialoge wurden abgefragt');
});

test('rückwirkender Start, Leerlauf-Pause und automatisches Weiterzählen', async () => {
  const now = Date.now();
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ t: now - 40 * MIN, output: 1000 }), assistant({ t: now - 20 * MIN, output: 1 }));
  const vs = createVscode({
    answers: [pick((i) => i.scope === 'all'), type('Rückwirkend'), pick((i) => i.label === 'Vor 30 Minuten')],
  });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');

  // nur die Antwort von vor 20 min zählt; seitdem 20 min Ruhe -> inaktiv
  assert.match(statusText(vs.items), /^\$\(watch\) Rückwirkend: 11 Tokens .*\(inaktiv\)$/);

  append(f, assistant({ t: Date.now(), output: 5 }));
  await cmd(vs.commands, 'stop'); // liest noch ein -> setzt automatisch fort

  const [e] = active.history();
  assert.equal(e.models['claude-opus-5-5'].output, 6);
  // aktiv: 30 → 20 min vor jetzt, plus wenige ms nach der Wiederaufnahme
  assert.ok(Math.abs(e.activeMs - 10 * MIN) < 5000, `activeMs = ${e.activeMs}`);
});

test('bestimmte Sitzung auswählen: Titel als Name, ab Sitzungsbeginn', async () => {
  const now = Date.now();
  const f1 = transcript(tmp.dir, 's1');
  append(
    f1,
    { type: 'user', cwd: 'C:/work/REA', sessionId: 's1', timestamp: new Date(now - 50 * MIN).toISOString(), message: { role: 'user', content: 'x' } },
    { type: 'ai-title', aiTitle: 'Teams Landingpage', sessionId: 's1' },
    assistant({ sessionId: 's1', t: now - 45 * MIN, output: 7 })
  );
  append(transcript(tmp.dir, 's2'), assistant({ sessionId: 's2', t: now - 45 * MIN, output: 1000 }));

  let nameDefault;
  const vs = createVscode({
    folders: ['C:/work/REA'],
    answers: [
      pick((i) => i.scope === 'session'),
      pick((i) => i.s?.id === 's1'),
      type((opts) => (nameDefault = opts.value)),
      pick((i) => i.label.includes('Ab Beginn der Sitzung')),
    ],
  });
  active = activateExtension({ claudeDir: tmp.dir, });
  await cmd(vs.commands, 'start');
  await cmd(vs.commands, 'stop');

  assert.equal(nameDefault, 'Teams Landingpage');
  const [e] = active.history();
  assert.equal(e.name, 'Teams Landingpage');
  assert.deepEqual(e.sessionIds, ['s1']);
  assert.equal(e.models['claude-opus-5-5'].output, 7);
});

test('„Verlauf"-Button: sichtbar ohne Tracking, öffnet das Panel; ausgeblendet während einer Messung', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('X'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  const item = (id) => vs.items.find((i) => i.id === `tokenTracker.${id}`);

  assert.equal(item('history').visible, true);
  assert.equal(item('history').text, '$(graph) Verlauf');
  assert.equal(item('pause').visible, false);
  await vs.commands[item('history').command]();
  assert.equal(vs.panels.length, 1);

  await cmd(vs.commands, 'start');
  assert.equal(item('history').visible, false);
  assert.equal(item('pause').visible, true);
  assert.equal(item('main').command, 'tokenTracker.showPanel');

  await cmd(vs.commands, 'stop');
  assert.equal(item('history').visible, true);
});

test('Tooltip der Statusleiste: Kopf, Kennzahlen, rechtsbündige Tabelle pro Modell, sichere Namen', async () => {
  const vs = createVscode({
    folders: ['C:/work/REA'],
    answers: [pick((i) => i.scope === 'all'), type('<b>Böse</b> *Name* #tag'), pick((i) => i.label.includes('Ab jetzt'))],
  });
  active = activateExtension({ claudeDir: tmp.dir });
  const tip = () => vs.items.find((i) => i.id === 'tokenTracker.main').tooltip;
  assert.match(tip().value, /Klicken, um eine Messung zu starten/);

  await cmd(vs.commands, 'start');
  await sleep(5);
  append(
    transcript(tmp.dir, 's1'),
    assistant({ model: 'claude-opus-5-5', input: 76, output: 96598, cacheWrite: 194944, cacheWrite1h: 194944, cacheRead: 5110282 }),
    assistant({ model: 'claude-haiku-5-5', input: 1200, output: 8400 })
  );
  await cmd(vs.commands, 'pause');
  const md = tip();
  assert.equal(md.supportHtml, true);
  // Nutzereingaben werden nicht als HTML/Markdown interpretiert
  assert.match(md.value, /\*\*&lt;b&gt;Böse&lt;\/b&gt; \\\*Name\\\*\*\*/);
  assert.doesNotMatch(md.value, /<b>Böse/);
  assert.match(md.value, /\\#tag/);
  assert.match(md.value, /\$\(debug-pause\) pausiert/);
  // Kennzahlen und Tabelle, teuerstes Modell zuerst, Summenzeile
  // Opus: 76×4 + 96.598×20 + 194.944×8 (1-h-Cache) + 5.110.282×0,2 = $4,514; Haiku: $0,004
  assert.match(md.value, /\*\*\$4,52\*\* API-Preis/);
  assert.match(md.value, /<table>.*<\/table>/s);
  assert.ok(md.value.indexOf('Opus 5.5') < md.value.indexOf('Haiku 5.5'));
  assert.match(md.value, /<td align="right">&emsp;5,11 Mio\.<\/td>/);
  assert.match(md.value, /<td><b>Summe<\/b><\/td>/);
  assert.doesNotMatch(md.value.match(/<table>.*<\/table>/s)[0], /\n\s*\n/, 'keine Leerzeile in der Tabelle');
});

test('regulärer Durchlauf über die Dateiüberwachung zählt neue Antworten (ohne Pause/Stopp)', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Watch'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ t: Date.now() - 60 * MIN, output: 1 })); // Datei existiert schon vor dem Start
  await cmd(vs.commands, 'start'); // erster, voller Durchlauf
  await sleep(50);
  append(f, assistant({ output: 4321 }));
  await sleep(3500); // nächster regulärer Durchlauf: nur gemeldete Dateien
  assert.match(statusText(vs.items), /Watch: 4,3 k Tokens/);
});

test('Sicherheit: Panel darf nur freigegebene Befehle auslösen', async () => {
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'showPanel');
  const panel = vs.panels[0];
  let setupCalled = false;
  const orig = vs.commands['tokenTracker.setupStatusLine'];
  vs.commands['tokenTracker.setupStatusLine'] = () => (setupCalled = true);
  await panel.send({ type: 'command', command: 'setupStatusLine' }); // nicht freigegeben
  await panel.send({ type: 'command', command: '../../workbench.action.quit' });
  assert.equal(setupCalled, false);
  vs.commands['tokenTracker.setupStatusLine'] = orig;
});

test('Sicherheit: CSV-Export entschärft Formeln (CSV-Injection)', async () => {
  const storage = path.join(tmp.dir, 'global-storage', 'history');
  fs.mkdirSync(storage, { recursive: true });
  const evil = { id: 'x', name: '=HYPERLINK("http://böse")', project: '+SUM(1)', tags: ['@cmd'], scopeLabel: '-1', start: 1, end: 2, activeMs: 60000,
    models: { 'claude-opus-5-5': { requests: 1, input: 1, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0.5, unpriced: 0 } } };
  fs.writeFileSync(path.join(storage, 'x.json'), JSON.stringify(evil));
  const out = path.join(tmp.dir, 'export.csv');
  const vs = createVscode({ saveTo: out });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'showPanel');
  await vs.panels[0].send({ type: 'export' });
  const row = fs.readFileSync(out, 'utf8').split('\r\n')[1];
  assert.match(row, /^"'=HYPERLINK\(""http:\/\/böse""\)";"'\+SUM\(1\)";"'@cmd";"'-1";/);
  assert.match(row, /;0,5000$/); // deutsches Dezimalkomma für Excel
});

test('Statuszeile einrichten: unlesbare settings.json wird nicht überschrieben', async () => {
  const settings = path.join(tmp.dir, 'settings.json');
  const broken = '{ "model": "opus", // Kommentar macht es ungültig\n }';
  fs.writeFileSync(settings, broken);
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'setupStatusLine');
  assert.equal(fs.readFileSync(settings, 'utf8'), broken);
  assert.ok(vs.messages.some((m) => m.level === 'error' && m.msg.includes('kein gültiges JSON')));
});

test('Statuszeile einrichten: vorhandene Einstellungen bleiben erhalten, Backup wird angelegt', async () => {
  const settings = path.join(tmp.dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }));
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'setupStatusLine');
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] });
  assert.equal(after.statusLine.type, 'command');
  assert.ok(fs.existsSync(settings + '.token-tracker.bak'));
});

test('Stopp im pausierten Zustand zählt den Endstand einer Antwort nach', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Nachtrag'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(5);
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ id: 'm', output: 10 }));
  await cmd(vs.commands, 'pause');
  await sleep(5);
  append(f, assistant({ id: 'm', output: 800 })); // Endstand nach dem Pausieren
  append(f, assistant({ id: 'neu', output: 5 })); // neue Antwort in der Pause: zählt nicht
  await cmd(vs.commands, 'stop');
  const [e] = active.history();
  assert.equal(e.models['claude-opus-5-5'].output, 800);
  assert.equal(e.models['claude-opus-5-5'].requests, 1);
});

test('Schließen des Fensters speichert auch eine pausierte Messung', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Zu'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(5);
  append(transcript(tmp.dir, 's1'), assistant({ id: 'm', output: 10 }));
  await cmd(vs.commands, 'pause');
  append(transcript(tmp.dir, 's1'), assistant({ id: 'm', output: 99 }));
  await cmd(vs.commands, 'resume'); // liest den Nachtrag ein (gedrosselt, noch nicht gespeichert)
  await cmd(vs.commands, 'pause');
  await active.ext.deactivate();
  const saved = active.store['tokenTracker.session'];
  assert.equal(saved.models['claude-opus-5-5'].output, 99);
  assert.equal(saved.seen.m.output, 99);
  active = null; // schon deaktiviert
});

test('zurück zu „Nächste neue Sitzung" zählt erst ab jetzt', async () => {
  const vs = createVscode({
    folders: ['C:/work/REA'],
    onInfo: (msg) => (msg.startsWith('Neue Claude-Sitzung erkannt') ? 'Andere Sitzung wählen' : undefined),
    answers: [
      pick((i) => i.scope === 'session'),
      pick((i) => i.awaitNew),
      type('Neu'),
      pick((i) => i.awaitNew), // nach dem Hinweis: doch wieder „Nächste neue Sitzung"
    ],
  });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(20);
  append(transcript(tmp.dir, 'A'), assistant({ sessionId: 'A', output: 1 })); // wird übernommen …
  append(transcript(tmp.dir, 'B'), assistant({ sessionId: 'B', output: 10 })); // … B entstand vor dem Wechsel
  await cmd(vs.commands, 'pause'); // liest ein -> A übernommen -> Hinweis -> Wechsel
  await sleep(1300); // länger als der Spielraum für grobe Datei-Uhren
  await cmd(vs.commands, 'resume');
  await sleep(5);
  append(transcript(tmp.dir, 'A'), assistant({ sessionId: 'A', output: 1000 }));
  append(transcript(tmp.dir, 'B'), assistant({ sessionId: 'B', output: 1000 }));
  append(transcript(tmp.dir, 'C'), assistant({ sessionId: 'C', output: 7 })); // erst nach dem Wechsel neu
  await cmd(vs.commands, 'stop');
  const [e] = active.history();
  assert.deepEqual(e.sessionIds, ['C']);
  assert.equal(e.models['claude-opus-5-5'].output, 7);
});

test('„Fortsetzen" kurz nach „Stopp" zählt eine noch laufende Antwort nicht doppelt', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Weiter'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(5);
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ id: 'm', output: 10, cacheRead: 5000 }));
  await cmd(vs.commands, 'stop');
  const [first] = active.history();
  await cmd(vs.commands, 'showPanel');
  await vs.panels[0].send({ type: 'continue', id: first.id });
  append(f, assistant({ id: 'm', output: 500, cacheRead: 5000 })); // Endstand derselben Antwort
  await cmd(vs.commands, 'stop');
  const [e] = active.history();
  const b = e.models['claude-opus-5-5'];
  assert.equal(b.requests, 1);
  assert.equal(b.output, 500);
  assert.equal(b.cacheRead, 5000); // nicht doppelt
});

test('Pause bleibt Pause, auch wenn im selben Moment die Leerlauf-Pause greift', async () => {
  // Leerlauf-Grenze 0,5 s: Beim Klick auf Pause ist sie gerade überschritten
  const vs = createVscode({
    config: { idlePauseMinutes: 0.5 / 60 },
    answers: [pick((i) => i.scope === 'all'), type('P'), pick((i) => i.label.includes('Ab jetzt'))],
  });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(700);
  await cmd(vs.commands, 'pause'); // der Durchlauf in pause() würde auf „inaktiv" schalten
  assert.match(statusText(vs.items), /\(pausiert\)$/);
  // eine echte Pause beendet sich nicht von selbst
  append(transcript(tmp.dir, 's1'), assistant({ output: 50 }));
  await sleep(3500);
  assert.match(statusText(vs.items), /: 0 Tokens.*\(pausiert\)$/);
});

test('Fortsetzung, während ein anderes Fenster den Eintrag zusammenführt oder ändert', async () => {
  const storage = path.join(tmp.dir, 'global-storage', 'history');
  fs.mkdirSync(storage, { recursive: true });
  const b = (output) => ({ 'claude-opus-5-5': { requests: 1, input: 0, output, cacheWrite: 0, cacheRead: 0, cost: 0, unpriced: 0 } });
  const write = (e) => fs.writeFileSync(path.join(storage, `${e.id}.json`), JSON.stringify(e));
  write({ id: 'X', name: 'X', start: 1000, end: 2000, savedAt: 2000, activeMs: 60000, models: b(100), days: { '2026-10-15': b(100) } });
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'showPanel');

  // a) anderes Fenster ergänzt X inzwischen (z. B. eigene Fortsetzung): nichts geht verloren
  await vs.panels[0].send({ type: 'continue', id: 'X' });
  append(transcript(tmp.dir, 's1'), assistant({ output: 5 }));
  write({ id: 'X', name: 'X', start: 1000, end: 3000, savedAt: 3000, activeMs: 120000, models: b(200), days: { '2026-10-15': b(200) } });
  await cmd(vs.commands, 'stop');
  let x = active.history().find((e) => e.id === 'X');
  assert.equal(x.models['claude-opus-5-5'].output, 205); // 200 vom anderen Fenster + 5 neu
  assert.ok(x.activeMs >= 120000);

  // b) anderes Fenster führt X in Y zusammen (X gelöscht): neuer Teil wird ein eigener Eintrag
  await vs.panels[0].send({ type: 'continue', id: 'X' });
  append(transcript(tmp.dir, 's1'), assistant({ output: 7 }));
  fs.unlinkSync(path.join(storage, 'X.json'));
  write({ id: 'Y', name: 'Y', start: 1000, end: 4000, savedAt: 4000, activeMs: 1, models: b(205) });
  await cmd(vs.commands, 'stop');
  const hist = active.history();
  assert.equal(hist.find((e) => e.id === 'X'), undefined, 'X darf nicht wieder auftauchen');
  const part = hist.find((e) => e.id !== 'Y');
  assert.equal(part.models['claude-opus-5-5'].output, 7);
  assert.ok(vs.messages.some((m) => m.msg.includes('als eigener Eintrag gespeichert')));
});

test('Abbrechen im Dialog startet nichts', async () => {
  const vs = createVscode({ answers: [() => undefined] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  assert.equal(statusText(vs.items), '$(play) Tokens');
  assert.equal(active.store['tokenTracker.session'], undefined);
});

test('gespeicherte laufende Messung läuft nach einem Neustart weiter', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Neustart'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(5);
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ id: 'm', output: 10 }));
  await cmd(vs.commands, 'pause');
  await cmd(vs.commands, 'resume');
  await active.ext.deactivate(); // Fenster schließen

  // neues Fenster mit dem gespeicherten Zustand; Endstand der Antwort kam inzwischen
  append(f, assistant({ id: 'm', output: 300 }));
  const vs2 = createVscode();
  active = activateExtension({ claudeDir: tmp.dir, workspaceState: active.store });
  assert.match(statusText(vs2.items), /^\$\(\w+\) Neustart: /);
  await cmd(vs2.commands, 'stop');
  const [e] = active.history();
  assert.equal(e.models['claude-opus-5-5'].output, 300);
  assert.equal(e.models['claude-opus-5-5'].requests, 1);
});

test('unbrauchbarer gespeicherter Zustand wird verworfen bzw. bereinigt', async () => {
  // ohne Zeitfenster: verworfen
  let vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir, workspaceState: { 'tokenTracker.session': { name: 'Kaputt', models: {} } } });
  assert.equal(statusText(vs.items), '$(play) Tokens');
  await active.ext.deactivate();

  // ungültige seen-Einträge werden ignoriert, fehlende Felder aufgefüllt
  vs = createVscode();
  active = activateExtension({
    claudeDir: tmp.dir,
    workspaceState: {
      'tokenTracker.session': {
        name: 'Teilweise',
        scope: 'all',
        scopeLabel: 'Alle',
        windows: [{ start: Date.now() - MIN, end: null }],
        seen: { a: 'kaputt', b: null, c: { t: 'gestern' } },
        models: { 'claude-opus-5-5': { output: 1000 } },
      },
    },
  });
  assert.match(statusText(vs.items), /Teilweise: 1,0 k Tokens/);
  append(transcript(tmp.dir, 's1'), assistant({ output: 5 }));
  await cmd(vs.commands, 'stop');
  assert.equal(active.history()[0].models['claude-opus-5-5'].output, 1005);
});

test('warnt, wenn das Transkript-Format nicht erkannt wird', async () => {
  append(transcript(tmp.dir, 's1'), {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { model: 'claude-opus-6', usage: { tokens_in: 1, tokens_out: 2 } },
  });
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await sleep(100);
  assert.ok(vs.messages.some((m) => m.level === 'warn' && m.msg.includes('Transkript-Format')));
  assert.match(statusText(vs.items), /^\$\(warning\) /);
});

test('kein Fehlalarm bei normalem Format', async () => {
  append(transcript(tmp.dir, 's1'), assistant());
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await sleep(100);
  assert.deepEqual(vs.messages, []);
});

test('rückwirkend: lange Lücken zählen nicht als aktive Zeit', async () => {
  const now = Date.now();
  append(
    transcript(tmp.dir, 's1'),
    assistant({ t: now - 55 * MIN }),
    assistant({ t: now - 50 * MIN }),
    // 30 min Lücke
    assistant({ t: now - 20 * MIN }),
    assistant({ t: now - 18 * MIN })
  );
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Mit Lücken'), pick((i) => i.label === 'Vor 1 Stunde')] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await cmd(vs.commands, 'stop');
  const [e] = active.history();
  // 60 → 50 min und 20 → 18 min vor jetzt
  assert.ok(Math.abs(e.activeMs - 12 * MIN) < 5000, `activeMs = ${e.activeMs / MIN} min`);
  assert.equal(e.models['claude-opus-5-5'].requests, 4);
});

test('„Nächste neue Sitzung": Hinweis mit Titel und Wechsel zu einer anderen Sitzung', async () => {
  let switchOffered = false;
  const vs = createVscode({
    folders: ['C:/work/REA'],
    onInfo: (msg, buttons) => {
      if (!msg.startsWith('Neue Claude-Sitzung erkannt')) return undefined;
      switchOffered = buttons.includes('Andere Sitzung wählen');
      return 'Andere Sitzung wählen';
    },
    answers: [
      pick((i) => i.scope === 'session'),
      pick((i) => i.awaitNew),
      type('Neue Aufgabe'),
      // nach dem Hinweis: Wechsel zur zweiten Sitzung
      pick((i) => i.s?.id === 's-zwei'),
    ],
  });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  await sleep(20);
  const one = transcript(tmp.dir, 's-eins');
  append(one, { type: 'user', sessionId: 's-eins', cwd: 'C:/work/REA', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Erste Sitzung' } });
  append(one, assistant({ sessionId: 's-eins', output: 1000 }));
  append(transcript(tmp.dir, 's-zwei'), assistant({ sessionId: 's-zwei', output: 7 }));
  await cmd(vs.commands, 'pause'); // liest ein -> übernimmt s-eins -> Hinweis -> Wechsel
  await sleep(100);

  assert.ok(vs.messages.some((m) => m.msg.includes('„Erste Sitzung"')));
  assert.ok(switchOffered);
  await cmd(vs.commands, 'stop');
  const [e] = active.history();
  assert.deepEqual(e.sessionIds, ['s-zwei']);
  assert.equal(e.models['claude-opus-5-5'].output, 7);
});

test('warnt einmal pro Modell ohne Preis', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('X'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  const f = transcript(tmp.dir, 's1');
  append(f, assistant({ model: 'claude-zukunft-9' }));
  await cmd(vs.commands, 'pause');
  append(f, assistant({ model: 'claude-zukunft-9' }));
  await cmd(vs.commands, 'resume');
  await cmd(vs.commands, 'pause');
  const warnings = vs.messages.filter((m) => m.msg.includes('kein Preis hinterlegt'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /claude-zukunft-9/);
  await sleep(10);
  assert.deepEqual(vs.executed, [['workbench.action.openSettings', 'tokenTracker.prices']]);
});

test('Verlauf: eine Datei pro Eintrag, neueste zuerst; Unlesbares wird übersprungen', async () => {
  const storage = path.join(tmp.dir, 'global-storage', 'history');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'alt.json'), JSON.stringify({ id: 'alt', name: 'Alt', start: 1, end: 2, savedAt: 1000, activeMs: 1, models: {} }));
  fs.writeFileSync(path.join(storage, 'neu.json'), JSON.stringify({ id: 'neu', name: 'Neu', start: 1, end: 2, savedAt: 2000, activeMs: 1, models: { 'claude-opus-5-5': { output: 5 } } }));
  fs.writeFileSync(path.join(storage, 'kaputt.json'), '{ nicht json');
  createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  const hist = active.history();
  assert.deepEqual(hist.map((e) => e.name), ['Neu', 'Alt']);
  // fehlende Felder sind aufgefüllt
  assert.deepEqual(hist[0].models['claude-opus-5-5'], { requests: 0, input: 0, output: 5, cacheWrite: 0, cacheRead: 0, cost: 0, unpriced: 0 });
  assert.deepEqual([hist[0].project, hist[0].tags, hist[0].days], ['', [], {}]);
});

test('Panel: Bearbeiten, Zusammenführen, Löschen und Fortsetzen', async () => {
  const storage = path.join(tmp.dir, 'global-storage', 'history');
  fs.mkdirSync(storage, { recursive: true });
  const entry = (id, name, savedAt, output) => ({
    id, name, project: 'P', tags: ['a'], scope: 'all', scopeLabel: 'Alle', workspacePaths: [], sessionIds: [id],
    start: savedAt - 1000, end: savedAt, savedAt, activeMs: 60000,
    models: { 'claude-opus-5-5': { requests: 1, input: 0, output, cacheWrite: 0, cacheRead: 0, cost: output / 1e6 * 20, unpriced: 0 } },
    days: { '2026-10-15': { 'claude-opus-5-5': { requests: 1, output } } },
  });
  for (const e of [entry('a', 'A', 3000, 1), entry('b', 'B', 2000, 10), entry('c', 'C', 1000, 100)]) {
    fs.writeFileSync(path.join(storage, `${e.id}.json`), JSON.stringify(e));
  }
  const vs = createVscode();
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'showPanel');
  const panel = vs.panels[0];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await panel.send({ type: 'ready' });
  assert.deepEqual(panel.lastState().history.map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(panel.lastState().pricesAsOf, '2026-10-16');

  await panel.send({ type: 'edit', id: 'c', name: 'C neu', project: 'Q', tags: ['x', 'y'] });
  let c = active.history().find((e) => e.id === 'c');
  assert.deepEqual([c.name, c.project, c.tags], ['C neu', 'Q', ['x', 'y']]);

  await panel.send({ type: 'merge', ids: ['a', 'b'] });
  const hist = active.history();
  assert.deepEqual(hist.map((e) => e.id), ['a', 'c']);
  const merged = hist[0];
  assert.equal(merged.name, 'A');
  assert.equal(merged.models['claude-opus-5-5'].output, 11);
  assert.equal(merged.activeMs, 120000);
  assert.deepEqual(merged.sessionIds, ['a', 'b']);

  await panel.send({ type: 'delete', id: 'c' });
  assert.deepEqual(active.history().map((e) => e.id), ['a']);

  // Fortsetzen: Zähler laufen weiter, beim Stopp wird derselbe Eintrag ersetzt
  await panel.send({ type: 'continue', id: 'a' });
  assert.equal(panel.lastState().current.continues, 'a');
  assert.deepEqual(panel.lastState().history, []); // fortgesetzter Eintrag ausgeblendet
  append(transcript(tmp.dir, 'a'), assistant({ sessionId: 'a', output: 1000 }));
  await cmd(vs.commands, 'stop');
  const [cont] = active.history();
  assert.equal(cont.id, 'a');
  assert.equal(cont.models['claude-opus-5-5'].output, 1011);
  assert.ok(cont.activeMs >= 120000);
  assert.equal(active.history().length, 1);
});

test('Verwerfen speichert nichts, Statuszeilen-Datei wird entfernt', async () => {
  const vs = createVscode({ answers: [pick((i) => i.scope === 'all'), type('Weg damit'), pick((i) => i.label.includes('Ab jetzt'))] });
  active = activateExtension({ claudeDir: tmp.dir });
  await cmd(vs.commands, 'start');
  const liveDir = path.join(tmp.dir, 'token-tracker', 'live');
  assert.equal(fs.readdirSync(liveDir).length, 1);
  await cmd(vs.commands, 'discard');
  assert.deepEqual(active.history(), []);
  assert.equal(fs.readdirSync(liveDir).length, 0);
});

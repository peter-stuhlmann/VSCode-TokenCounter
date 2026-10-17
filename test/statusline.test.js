const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpClaude, ROOT } = require('./helpers');

let tmp;
beforeEach(() => {
  tmp = tmpClaude();
  fs.mkdirSync(path.join(tmp.dir, 'token-tracker', 'live'), { recursive: true });
});
afterEach(() => tmp.cleanup());

const live = (name, data) =>
  fs.writeFileSync(path.join(tmp.dir, 'token-tracker', 'live', `${name}.json`), JSON.stringify({ sessionIds: [], workspacePaths: [], ...data }));

const run = (input) =>
  execFileSync(process.execPath, [path.join(ROOT, 'statusline.js')], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmp.dir },
  })
    .toString()
    .replace(/\x1b\[[0-9;]*m/g, ''); // Farben entfernen

test('zeigt das Tracking der passenden Sitzung', () => {
  live('a', { name: 'REA', state: 'running', tokens: 126300, cost: 3.2, scope: 'session', sessionIds: ['abc'] });
  assert.equal(run({ session_id: 'abc', cwd: 'C:/x' }), '● REA: 126,3 k Tokens · $3,20');
  assert.equal(run({ session_id: 'zzz', cwd: 'C:/x' }), '');
});

test('Workspace-Tracking gilt für Unterordner, nicht für Nachbarordner', () => {
  live('a', { name: 'REA', state: 'idle', tokens: 5e6, cost: 120, scope: 'workspace', workspacePaths: ['C:/work/REA'] });
  assert.equal(run({ session_id: 'x', workspace: { current_dir: 'C:/work/REA/src' } }), '◷ REA: 5,00 Mio. Tokens · $120 (inaktiv)');
  assert.equal(run({ session_id: 'x', cwd: 'C:/work/REA-2' }), '');
});

test('„nächste neue Sitzung" zeigt sich im Workspace, mehrere Trackings nebeneinander', () => {
  live('a', { name: 'Neu', state: 'paused', tokens: 0, cost: 0, scope: 'session', awaitNew: true, workspacePaths: ['C:/work/REA'] });
  live('b', { name: 'Alles', state: 'running', tokens: 10, cost: 0.001, scope: 'all' });
  const out = run({ session_id: 'x', cwd: 'C:/work/REA' });
  assert.match(out, /❚❚ Neu: 0 Tokens · \$0 \(pausiert\)/);
  assert.match(out, /● Alles: 10 Tokens/);
});

test('ohne Tracking oder mit kaputter Eingabe: leere Ausgabe statt Fehler', () => {
  assert.equal(run({}), '');
  live('kaputt', {});
  fs.writeFileSync(path.join(tmp.dir, 'token-tracker', 'live', 'x.json'), '{nicht json');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'statusline.js')], {
    input: 'auch kein json',
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmp.dir },
  }).toString();
  assert.equal(typeof out, 'string');
});

test('Statuszeilen-Skript formatiert genau wie core.js', () => {
  const core = require('../core');
  const src = fs.readFileSync(path.join(ROOT, 'statusline.js'), 'utf8');
  // Formatierer aus dem eigenständigen Skript laden, ohne es auszuführen
  const own = new Function(`${src.match(/function fmtShort[\s\S]*?\n}\n/)[0]}${src.match(/function fmtUsd[\s\S]*?\n}\n/)[0]}return { fmtShort, fmtUsd };`)();
  for (const n of [0, 7, 999, 1000, 126300, 999999, 5e6, 2.1e9]) assert.equal(own.fmtShort(n), core.fmtShort(n), `fmtShort(${n})`);
  for (const n of [0, 0.0004, 0.036, 1, 4.725, 99.99, 100, 1652.4]) assert.equal(own.fmtUsd(n), core.fmtUsd(n), `fmtUsd(${n})`);
});

test('Sicherheit: Steuerzeichen im Namen landen nicht im Terminal', () => {
  live('a', { name: 'Böse\u001b]0;gekapert\u0007\u001b[2J Name', state: 'running', tokens: 1, cost: 0, scope: 'all' });
  const raw = execFileSync(process.execPath, [path.join(ROOT, 'statusline.js')], {
    input: '{}',
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmp.dir },
  }).toString();
  // nur die eigenen Farbcodes bleiben übrig
  const withoutOwnColors = raw.replace(/\u001b\[(0|2|31|33)m/g, '');
  assert.doesNotMatch(withoutOwnColors, /[\u0000-\u001f]/);
  assert.match(withoutOwnColors, /Böse\]0;gekapert\[2J Name/);
});

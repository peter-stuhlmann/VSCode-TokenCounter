#!/usr/bin/env node
// Statuszeile für Claude Code: zeigt das laufende Token-Tracking aus VS Code an.
// Claude Code übergibt per stdin JSON mit session_id und cwd.
// Wird von der Extension nach ~/.claude/token-tracker/statusline.js kopiert.

const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'token-tracker', 'live');

// Wie fmtShort/fmtUsd in core.js (dieses Skript läuft eigenständig, ohne core.js).
// test/statusline.test.js prüft, dass beide gleich formatieren.
function fmtShort(n = 0) {
  const dec = (v, d) => v.toFixed(d).replace('.', ',');
  if (n >= 1e9) return `${dec(n / 1e9, 2)} Mrd.`;
  if (n >= 1e6) return `${dec(n / 1e6, 2)} Mio.`;
  if (n >= 1e3) return `${dec(n / 1e3, 1)} k`;
  return String(Math.round(n));
}

function fmtUsd(n = 0) {
  if (n === 0) return '$0';
  if (n >= 100) return '$' + Math.round(n).toLocaleString('de-DE');
  return '$' + n.toFixed(n >= 1 ? 2 : 3).replace('.', ',');
}

// Windows und macOS ignorieren standardmäßig Groß-/Kleinschreibung in Pfaden, Linux nicht.
const norm = (p) => {
  const r = path.resolve(p) + path.sep;
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};

function inside(cwd, roots) {
  if (!cwd) return false;
  return roots.some((r) => norm(cwd).startsWith(norm(r)));
}

function matches(t, input) {
  const cwd = input.workspace?.current_dir || input.cwd;
  switch (t.scope) {
    case 'session':
      return t.sessionIds.includes(input.session_id) || (t.awaitNew && inside(cwd, t.workspacePaths));
    case 'workspace':
      return inside(cwd, t.workspacePaths);
    default:
      return true;
  }
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {}
  const parts = [];
  for (const f of files) {
    let t;
    try {
      t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!t || !t.name || !matches({ sessionIds: [], workspacePaths: [], ...t }, input)) continue;
    const icon = { running: '\x1b[31m●\x1b[0m', idle: '\x1b[33m◷\x1b[0m', paused: '\x1b[33m❚❚\x1b[0m' }[t.state] || '•';
    const suffix = { idle: ' (inaktiv)', paused: ' (pausiert)' }[t.state] || '';
    // Steuerzeichen entfernen: der Name landet direkt im Terminal (keine Escape-Sequenzen einschleusen)
    const name = String(t.name).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    parts.push(`${icon} ${name}: ${fmtShort(t.tokens)} Tokens · ${fmtUsd(t.cost)}\x1b[2m${suffix}\x1b[0m`);
  }
  process.stdout.write(parts.join('  │  '));
});

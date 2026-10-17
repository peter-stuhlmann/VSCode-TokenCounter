// Testet panel.html im echten Browser (Edge oder Chrome über playwright-core),
// mit derselben Content-Security-Policy wie in VS Code.

const { test: nodeTest, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {}

let browser;
let page;
let errors;

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  return null;
}

before(async () => {
  browser = chromium && (await launch());
});
after(async () => browser?.close());

// panel.html wie in VS Code vorbereiten, plus nachgebaute acquireVsCodeApi
function pageHtml(theme = 'vscode-dark') {
  const vars =
    '--vscode-font-family:Segoe UI;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;' +
    '--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#3c3c3c;--vscode-badge-background:#616161;' +
    '--vscode-badge-foreground:#fff;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;' +
    '--vscode-list-hoverBackground:#2a2d2e;--vscode-editorHoverWidget-background:#202020';
  const stub = `<script nonce="test">
    window.__posted = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.__posted.push(m),
      getState: () => null,
      setState: () => {},
    });
  </script><style nonce="test">body{${vars}}</style>`;
  return fs
    .readFileSync(path.join(ROOT, 'panel.html'), 'utf8')
    .replace(/\{\{nonce\}\}/g, 'test')
    .replace(/\{\{csp\}\}/g, "'self'")
    .replace('</head>', `${stub}</head>`)
    .replace('<body>', `<body class="${theme}">`);
}

// ---------- Testdaten ----------
const DAY = 864e5;
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const bucket = (output, cost, extra = {}) => ({ requests: 1, input: 10, output, cacheWrite: 100, cacheRead: 1000, cost, unpriced: 0, ...extra });

function entry(id, name, project, tags, daysAgo, models) {
  const t = Date.now() - daysAgo * DAY;
  return {
    id, name, project, tags, scopeLabel: 'Alle', start: t - 3600e3, end: t, savedAt: t, activeMs: 3600e3, models,
    days: { [dayKey(t)]: models },
  };
}

function state(overrides = {}) {
  return {
    type: 'state',
    pricesAsOf: '2026-10-16',
    current: {
      id: 'current', continues: null, name: 'Läuft gerade', project: 'REA', tags: [], scopeLabel: 'Alle', state: 'running',
      start: Date.now() - 600e3, activeMs: 600e3,
      models: { 'claude-opus-5-5': bucket(500, 1.5) },
      days: { [dayKey(Date.now())]: { 'claude-opus-5-5': bucket(500, 1.5) } },
    },
    history: [
      entry('h1', 'Login-Bug', 'REA', ['bugfix'], 1, { 'claude-opus-5-5': bucket(1000, 2), 'claude-fable-5-1': bucket(50, 3) }),
      entry('h2', 'Landingpage', 'seo', ['feature'], 3, { 'claude-sonnet-5-5': bucket(2000, 0.5) }),
      entry('h3', 'Alt ohne Tage', 'seo', [], 10, { 'claude-unbekannt': bucket(10, 0, { unpriced: 1 }) }),
    ],
    ...overrides,
  };
}

async function open(data = state(), theme) {
  errors = [];
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.setContent(pageHtml(theme));
  if (data) await send(data);
}

const send = (data) => page.evaluate((d) => window.postMessage(d, '*'), data).then(() => page.waitForTimeout(30));
const posted = () => page.evaluate(() => window.__posted);
const text = (sel) => page.locator(sel).innerText();
const historyNames = () => page.locator('#history .title').allInnerTexts();

beforeEach(async () => {
  await page?.close();
});

// Ohne Edge/Chrome (z. B. in einem schlanken Container) überspringen statt scheitern
const test = (name, fn) => nodeTest(name, async (t) => (browser ? fn(t) : t.skip('Kein Edge/Chrome gefunden')));

// ---------- Tests ----------

test('rendert ohne Fehler und meldet sich mit „ready"', async () => {
  await open();
  assert.deepEqual(errors, []);
  assert.deepEqual((await posted())[0], { type: 'ready' });
  assert.match(await text('#current'), /Läuft gerade/);
  assert.deepEqual(await historyNames(), ['Login-Bug', 'Landingpage', 'Alt ohne Tage']);
  const footer = (await text('footer')).replace(/\s+/g, ' ');
  assert.equal(footer, 'Entwickelt mit von Peter R. Stuhlmann und Claude Code, Modellpreise Stand 16.10.2026');
});

test('Summen und „≥" bei Modellen ohne Preis', async () => {
  await open();
  // 1,5 + 2 + 3 + 0,5 + 0 = 7 USD; ein Modell ohne Preis -> „≥"
  assert.match(await text('#summary'), /≥ \$7,00/);
  assert.match(await text('#history'), /≥ \$0/);
});

test('Filter nach Projekt, Tag, Suche und Klick in der Projekttabelle', async () => {
  await open();
  await page.selectOption('#fProject', 'seo');
  assert.deepEqual(await historyNames(), ['Landingpage', 'Alt ohne Tage']);
  await page.selectOption('#fProject', '');
  await page.selectOption('#fTag', 'bugfix');
  assert.deepEqual(await historyNames(), ['Login-Bug']);
  await page.selectOption('#fTag', '');
  await page.fill('#fSearch', 'land');
  assert.deepEqual(await historyNames(), ['Landingpage']);
  await page.fill('#fSearch', '');
  await page.click('tr[data-project="REA"]');
  assert.equal(await page.inputValue('#fProject'), 'REA');
  assert.deepEqual(await historyNames(), ['Login-Bug']);
});

test('Zeitraum-Filter blendet ältere Einträge aus', async () => {
  await open();
  await page.selectOption('#fPeriod', '7');
  assert.deepEqual(await historyNames(), ['Login-Bug', 'Landingpage']);
});

test('Diagramm: Tage, Wochen, Tooltip und Tabellenansicht', async () => {
  await open();
  await page.selectOption('#fPeriod', '30');
  assert.equal(await page.locator('#chart .hit').count(), 30);
  assert.match(await text('#legend'), /Opus 5\.5.*Fable 5\.1|Fable 5\.1.*Opus 5\.5/s);

  // Tooltip über dem heutigen Tag (letzte Spalte)
  await page.locator('#chart .hit').last().hover();
  const tip = await text('#tip');
  assert.match(tip, /Opus 5\.5/);
  assert.match(tip, /Summe/);

  await page.click('#tGrain button[data-v=week]');
  const weeks = await page.locator('#chart .hit').count();
  assert.ok(weeks >= 5 && weeks <= 6, `Wochen: ${weeks}`);

  await page.click('#tView button[data-v=table]');
  assert.equal(await page.locator('#chart svg').count(), 0);
  assert.match(await text('#chart .scroll table'), /KW \d+/);

  await page.click('#tMetric button[data-v=tokens]');
  assert.match(await text('#chart .scroll table'), /\d/);
  assert.deepEqual(errors, []);
});

test('Bearbeiten: Eingabe überlebt Live-Updates, Tags werden bereinigt', async () => {
  await open();
  await page.locator('#history [data-editbtn="h1"]').click();
  await page.fill('form.edit input[name=name]', 'Login-Bug gefixt');
  await page.fill('form.edit input[name=tags]', '#bugfix, frontend , ');
  await send(state()); // Update vom laufenden Tracking während der Eingabe
  assert.equal(await page.inputValue('form.edit input[name=name]'), 'Login-Bug gefixt');
  await page.click('form.edit button[type=submit]');
  const edit = (await posted()).find((m) => m.type === 'edit');
  assert.deepEqual(edit, { type: 'edit', id: 'h1', name: 'Login-Bug gefixt', project: 'REA', tags: ['bugfix', 'frontend'] });
});

test('Escape bricht das Bearbeiten ab', async () => {
  await open();
  await page.locator('#history [data-editbtn="h2"]').click();
  assert.equal(await page.locator('form.edit').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('form.edit').count(), 0);
});

test('Zusammenführen: Auswahl in Verlaufsreihenfolge', async () => {
  await open();
  await page.check('[data-sel="h3"]');
  assert.equal(await page.locator('[data-merge]').count(), 0); // erst ab zwei
  await page.check('[data-sel="h1"]');
  assert.match(await text('#bulk'), /2 ausgewählt/);
  await page.click('[data-merge]');
  assert.deepEqual((await posted()).find((m) => m.type === 'merge'), { type: 'merge', ids: ['h1', 'h3'] });
});

test('Buttons schicken die passenden Befehle', async () => {
  await open();
  await page.click('#current [data-cmd="togglePause"]');
  await page.click('#current [data-cmd="stop"]');
  await page.click('[data-continue="h2"]');
  await page.click('[data-del="h3"]');
  await page.click('#export');
  const msgs = (await posted()).slice(1);
  assert.deepEqual(msgs, [
    { type: 'command', command: 'togglePause' },
    { type: 'command', command: 'stop' },
    { type: 'continue', id: 'h2' },
    { type: 'delete', id: 'h3' },
    { type: 'export' },
  ]);
});

test('pausiertes Tracking zeigt „Weiter", Fortsetzung ist markiert', async () => {
  await open(state({ current: { ...state().current, state: 'idle', continues: 'h9' } }));
  assert.match(await text('#current'), /inaktiv/);
  assert.match(await text('#current'), /Fortsetzung/);
  assert.equal(await text('#current [data-cmd="togglePause"]'), 'Weiter');
});

test('Modellfarben kommen trotz CSP an (Legende, Tabelle, Balken)', async () => {
  await open();
  const colors = await page.evaluate(() => ({
    swatches: [...document.querySelectorAll('.sw')].map((e) => getComputedStyle(e).backgroundColor),
    bars: [...document.querySelectorAll('#chart path, #chart rect:not(.hit)')].map((e) => getComputedStyle(e).fill),
  }));
  assert.ok(colors.swatches.length > 0 && colors.bars.length > 0);
  for (const c of [...colors.swatches, ...colors.bars]) {
    assert.ok(!/rgba\(0, 0, 0, 0\)|^none$|^rgb\(0, 0, 0\)$/.test(c), `ungefärbt: ${c}`);
  }
  // Opus 5.5 (größter Verbrauch) bekommt immer die erste Farbe
  const first = await page.evaluate(() => getComputedStyle(document.querySelector('#legend .sw')).backgroundColor);
  assert.equal(first, 'rgb(57, 135, 229)'); // #3987e5, dunkles Theme
  assert.deepEqual(errors, []);
});

test('leerer Zustand', async () => {
  await open(state({ current: null, history: [] }));
  assert.match(await text('#current'), /Kein Tracking aktiv/);
  assert.match(await text('#chart'), /Keine Daten im Zeitraum/);
  assert.match(await text('#history'), /Keine abgeschlossenen Trackings/);
  await page.click('#current [data-cmd="start"]');
  assert.deepEqual((await posted()).at(-1), { type: 'command', command: 'start' });
  assert.deepEqual(errors, []);
});

test('Nutzereingaben werden nicht als HTML ausgeführt', async () => {
  const evil = entry('x', '<img src=x onerror="window.__pwned=1">', '<b>P</b>', ['<i>t</i>'], 1, { 'claude-opus-5-5': bucket(1, 0) });
  await open(state({ history: [evil] }));
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#history img').count(), 0);
  assert.match(await text('#history'), /<img src=x/);
});

test('helles Theme rendert ebenfalls fehlerfrei', async () => {
  await open(state(), 'vscode-light');
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#chart svg').count(), 1);
});

test('Footer: bei kurzer Seite am unteren Fensterrand, bei langer am Ende', async () => {
  await open(state({ current: null, history: [] }));
  const vh = page.viewportSize().height;
  const shortBox = await page.locator('footer').boundingBox();
  assert.ok(Math.abs(shortBox.y + shortBox.height - (vh - 16)) < 2, `Footer endet bei ${shortBox.y + shortBox.height}, Fenster ${vh}`);

  const many = Array.from({ length: 12 }, (_, i) => entry(`e${i}`, `Eintrag ${i}`, 'P', [], 1, { 'claude-opus-5-5': bucket(1, 0.1) }));
  await send(state({ history: many }));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const longBox = await page.locator('footer').boundingBox();
  assert.ok(pageHeight > vh, 'Seite sollte scrollen');
  assert.ok(longBox.y > (await page.locator('#history').boundingBox()).y, 'Footer unter dem Verlauf');
});

test('Footer-Icons wechseln alle 5 Sekunden weich durch', async () => {
  await open();
  const anim = await page.evaluate(() =>
    [...document.querySelectorAll('.icons svg')].map((s) => {
      const cs = getComputedStyle(s);
      return { name: cs.animationName, duration: cs.animationDuration, delay: cs.animationDelay, iterations: cs.animationIterationCount };
    })
  );
  assert.equal(anim.length, 3);
  for (const a of anim) assert.deepEqual([a.name, a.duration, a.iterations], ['icon-cycle', '15s', 'infinite']);
  // je 5 s versetzt
  assert.deepEqual(anim.map((a) => parseFloat(a.delay)), [-0.75, 4.25, 9.25]);

  // zu jedem Zeitpunkt ist genau ein Icon (fast) voll sichtbar – geprüft an der Animation selbst
  const visible = await page.evaluate(async () => {
    const svgs = [...document.querySelectorAll('.icons svg')];
    const out = [];
    for (const t of [1, 3, 6, 8, 11, 13]) {
      // currentTime = Sekunden seit Seitenstart; die Verzögerung rechnet der Browser selbst ab
      for (const s of svgs) s.getAnimations()[0].currentTime = t * 1000;
      await new Promise(requestAnimationFrame);
      out.push(svgs.map((s) => Math.round(parseFloat(getComputedStyle(s).opacity))));
    }
    return out;
  });
  assert.deepEqual(visible, [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]]);
});

test('Live-Updates verschieben die Scroll-Position nicht – auch ganz unten bei wenigen Einträgen', async () => {
  for (const view of ['chart', 'table']) {
    await page?.close();
    await open(state());
    if (view === 'table') await page.click('#tView button[data-v=table]');
    await page.mouse.move(500, 400);
    await page.mouse.wheel(0, 99999);
    await page.waitForTimeout(100);
    const bottom = await page.evaluate(() => scrollY);
    assert.ok(bottom > 100, 'Seite sollte scrollbar sein');
    const firstCard = await page.evaluateHandle(() => document.querySelector('#history .card'));
    for (let n = 1; n <= 3; n++) {
      const s = state();
      s.current = { ...s.current, activeMs: s.current.activeMs + n * 3000, models: { 'claude-opus-5-5': bucket(500 + n, 1.5 + n / 100) } };
      await send(s);
      assert.equal(await page.evaluate(() => scrollY), bottom, `${view}: Update ${n} hat gescrollt`);
    }
    // unveränderter Verlauf wird nicht neu geschrieben
    assert.ok(await page.evaluate((el) => el === document.querySelector('#history .card'), firstCard), `${view}: Verlauf neu gerendert`);
  }
});

test('Footer-Icons sind einfarbig in der Textfarbe des Footers', async () => {
  for (const theme of ['vscode-dark', 'vscode-light']) {
    await page?.close();
    await open(state(), theme);
    const { text, fills } = await page.evaluate(() => ({
      text: getComputedStyle(document.querySelector('footer')).color,
      fills: [...document.querySelectorAll('.icons path')].map((p) => getComputedStyle(p).fill),
    }));
    assert.equal(fills.length, 3);
    assert.deepEqual(fills, [text, text, text], theme);
  }
});

test('Footer bei „Bewegung reduzieren": nur das Herz, keine Animation', async () => {
  await open();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const opacities = await page.evaluate(() => [...document.querySelectorAll('.icons svg')].map((s) => getComputedStyle(s).opacity));
  assert.deepEqual(opacities, ['1', '0', '0']);
});

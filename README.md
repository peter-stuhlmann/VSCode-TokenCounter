# Claude Token Tracker

VS-Code-Extension, die zählt, wie viele Claude-Code-Tokens du für ein Projekt, eine Aufgabe oder eine einzelne Claude-Sitzung verbrauchst – mit Start, Pause und Stopp, aufgeschlüsselt nach Modell und mit theoretischem API-Preis.

## Bedienung

Unten links in der Statusleiste:

| Zustand | Anzeige |
|---|---|
| Aus | `▶ Tokens` `📈 Verlauf` → Start bzw. Panel mit älteren Messungen |
| Läuft | `⏺ Name: 126,3 k Tokens · $3,20` `⏸ Pause` `⏹ Stopp` |
| Inaktiv (orange) | `◷ … (inaktiv)` – automatisch pausiert, zählt von selbst weiter, sobald neue Tokens kommen |
| Pausiert (orange) | `⏸ … (pausiert)` `▶ Weiter` `⏹ Stopp` |

Klick auf den Namen öffnet das Panel. Alle Befehle gibt es auch in der Befehlspalette unter „Token Tracker".

### Start

1. **Was zählen?**
   - *Eine bestimmte Claude-Sitzung* – nur diese Unterhaltung inkl. Subagents. Auswahl aus den letzten Sitzungen mit Titel, oder „Nächste neue Sitzung in diesem Workspace".
   - *Nur dieser Workspace* – alle Claude-Sitzungen, die in diesem Ordner laufen.
   - *Alle Claude-Code-Sitzungen*.
2. **Name** – mit `#tags`, z. B. `Login-Bug #bugfix #frontend`. Das Projekt wird automatisch auf den Ordnernamen gesetzt und ist im Panel änderbar.
3. **Ab wann?** – ab jetzt, ab Beginn der gewählten Sitzung, vor 15/30/60/120 Minuten, heute ab 0:00 oder eine Uhrzeit (`14:30`, `15.10. 14:30`). Rückwirkend wird aus den vorhandenen Transkripten nachgezählt.

### Panel

- Aktuelles Tracking mit Pause/Weiter/Stopp/Verwerfen
- Filter nach Projekt, Tag, Zeitraum und Name
- Diagramm: Verbrauch pro Tag oder Woche, gestapelt nach Modell, wahlweise API-Preis oder Tokens; Tooltip beim Überfahren; Tabellenansicht
- Projektübersicht (Klick auf ein Projekt filtert)
- Verlauf: bearbeiten (Name, Projekt, Tags), fortsetzen, löschen, mehrere auswählen und zusammenführen
- CSV-Export (Semikolon-getrennt, öffnet direkt in Excel)

### Claude-Code-Statuszeile

`Token Tracker: In der Claude-Code-Statuszeile anzeigen` trägt in `~/.claude/settings.json` eine Statuszeile ein. Sie zeigt im Claude-Code-Terminal das Tracking, das zur jeweiligen Sitzung bzw. zum Ordner gehört. Eine vorhandene Statuszeile wird nur nach Rückfrage ersetzt, vorher wird ein Backup angelegt.

## Woher kommen die Zahlen?

Claude Code schreibt jede Unterhaltung als JSONL nach `~/.claude/projects/<ordner>/<sitzungs-id>.jsonl` (bzw. `$CLAUDE_CONFIG_DIR/projects`), Subagents in einen Unterordner. Jede Assistant-Antwort enthält `model`, `timestamp`, `sessionId`, `cwd` und `usage`. Die Extension

- merkt sich beim Start die Größe aller Dateien und liest danach nur neu angehängte Zeilen (rückwirkend: die Dateien ab dem gewählten Zeitpunkt),
- zählt nur Antworten, die in einem aktiven Zeitfenster beginnen,
- führt die Zeilen einer Antwort über die Message-ID zusammen: Claude Code schreibt eine Antwort pro Content-Block als eigene Zeile, und der Output wächst dabei mit. Gezählt wird der Endstand (siehe unten),
- filtert nach Sitzungs-ID bzw. `cwd` (inklusive echtem Pfad hinter Symlinks).

Das Transkript-Format ist laut Claude-Code-Dokumentation intern und kann sich mit jedem Release ändern. Die Extension prüft deshalb beim Start und beim Zählen, ob die Antworten noch das erwartete Format haben (`isUsageEntry` in `core.js`). Wenn nicht, erscheint eine Warnung und ein ⚠ in der Statusleiste, statt still falsch zu zählen.

### Genauigkeit

Geprüft an echten Transkripten (14 Tage, rund 34.000 Antworten):

- Bei etwa 14 % der Antworten enthalten die ersten Zeilen nur einen Zwischenstand des Outputs, erst die letzte den Endstand – im Schnitt 3 s, höchstens 5 min später.
- Zwei Sitzungen wurden unabhängig nachgerechnet (Höchststand je Antwort aus allen Zeilen): Output und Anzahl der Requests stimmen exakt überein, auch bei 16.441 Antworten.
- `/branch` bzw. `--fork-session` kopieren den Verlauf mit denselben Message-IDs in eine neue Datei – solche Kopien werden nicht doppelt gezählt.

### Leistung

- Ohne laufende Messung: keine Hintergrundarbeit.
- Während einer Messung meldet das Betriebssystem geänderte Transkripte (Dateiüberwachung); nur diese werden gelesen. Ein voller Durchlauf alle 30 s (und bei Pause/Stopp) fängt verpasste Meldungen ab. Gemessen bei ~600 Transkripten: etwa 0,3 % eines CPU-Kerns (ohne Überwachung waren es 2,7 %).
- Der Zustand der Messung wird höchstens alle 15 s gespeichert, Zustandswechsel sofort.
- Große Transkripte (>100 MB) werden blockweise gelesen; eine 155-MB-Datei rückwirkend in ca. 2 s.

### Sicherheit und Datenschutz

- Die Extension liest nur lokal und sendet nichts. Aus den Transkripten übernimmt sie nur Zahlen, Modell, Zeit, Sitzung und Ordner – keine Inhalte. Für die Sitzungsauswahl liest sie Titel und letzte Eingabe einer Sitzung, speichert aber nur den Titel.
- Das Panel läuft mit strenger Content-Security-Policy (keine Inline-Skripte/-Styles, kein Dateizugriff); alle Nutzertexte werden maskiert, und das Panel darf nur eine feste Liste von Befehlen auslösen.
- CSV-Export: Werte, die Excel als Formel ausführen würde (`=`, `+`, `-`, `@`), werden entschärft.
- Claude-Code-Statuszeile: Steuerzeichen in Namen werden entfernt. Die Einrichtung ändert `~/.claude/settings.json` nur nach Rückfrage, legt vorher ein Backup an und lässt eine unlesbare Datei unangetastet.
- Läuft im eingeschränkten Modus von VS Code (es wird kein Code aus dem Arbeitsordner ausgeführt) und bei Remote-Verbindungen (WSL, SSH, Container) auf der Seite, auf der auch Claude Code läuft.

### Token-Arten und Preis

- **Input**: neue, nicht gecachte Eingabe-Tokens
- **Output**: generierte Tokens (inkl. Thinking)
- **Cache-Write**: Kontext, der neu in den Prompt-Cache geschrieben wird
- **Cache-Read**: Kontext aus dem Cache – meist über 95 % der Menge, aber sehr günstig

Der **API-Preis** ist, was dieselbe Nutzung über die Anthropic-API kosten würde (Preise Stand 16.10.2026, geprüft gegen die offizielle Preisseite, in `prices.js`: Input, Output, Cache-Write 1,25× bzw. 2× Input für 5 min/1 h, Cache-Read, Fast Mode, Haiku-5.5-Aufpreis über 100K Prompt, Websuche). Mit dem Abo zahlst du nicht pro Token – der Wert macht Aufgaben aber gut vergleichbar. Fehlende Modelle lassen sich über `tokenTracker.prices` ergänzen; nicht bepreiste Modelle werden mit „≥" markiert.

## Einstellungen

| Einstellung | Standard | |
|---|---|---|
| `tokenTracker.statusBarMetric` | `noCacheRead` | Token-Zahl in der Statusleiste: `noCacheRead`, `total`, `output` |
| `tokenTracker.showCost` | `true` | API-Preis in der Statusleiste |
| `tokenTracker.idlePauseMinutes` | `15` | Automatisch pausieren nach so vielen Minuten ohne Tokens (0 = aus) |
| `tokenTracker.prices` | `{}` | Eigene Preise pro Modell |

## Hinweise

- Das laufende Tracking gehört zum jeweiligen VS-Code-Fenster und überlebt Neustarts. Beim Schließen des Fensters wird es automatisch pausiert und zählt weiter, sobald wieder passende Tokens kommen.
- Bei einer Leerlauf-Pause endet die aktive Zeit bei der letzten Antwort; Wartezeit zählt nicht mit. Tokens gehen dabei nie verloren. Beim rückwirkenden Start werden längere Lücken ebenso herausgerechnet.
- „Nächste neue Sitzung" übernimmt die erste neue Claude-Sitzung im Workspace und sagt per Hinweis, welche. Falls es die falsche ist: „Andere Sitzung wählen" (auch als Befehl) zählt den Zeitraum für die richtige Sitzung neu.
- Der Verlauf liegt im globalen Speicher der Extension (eine Datei pro Eintrag) und ist in allen Fenstern gleich. Bei Updates der Extension bleiben Verlauf und laufendes Tracking erhalten. Vor einer Deinstallation besser per CSV exportieren.
- Rückwirkend geht es nur so weit, wie Claude Code Transkripte aufbewahrt – standardmäßig 30 Tage (Claude-Code-Einstellung `cleanupPeriodDays`). Der gespeicherte Verlauf ist davon nicht betroffen.
- Eigene Preise (`tokenTracker.prices`) brauchen Zahlen für `input` und `output`; unvollständige Angaben werden ignoriert.

## Plattformen

Windows, macOS und Linux. Claude Code legt die Transkripte überall unter `~/.claude/projects` ab.

- **Windows:** täglich im Einsatz; alle Tests laufen lokal, inklusive Panel (Edge) und echtem VS Code.
- **Linux:** Kern-, Preis-, Statuszeilen- und Extension-Tests laufen in einem Linux-Container (`node:22-slim`) grün; Panel und echtes VS Code prüft der GitHub-Workflow (`ubuntu-latest`, mit `xvfb`).
- **macOS:** wird vom GitHub-Workflow (`macos-latest`) mit allen Tests geprüft.

Plattformunterschiede, die die Extension berücksichtigt:

- Groß-/Kleinschreibung in Ordnernamen: unter Windows und macOS egal, unter Linux nicht.
- Claude-Code-Statuszeile: Unter macOS/Linux wird der absolute Pfad zu `node` eingetragen (aus der Login-Shell ermittelt), weil aus Dock/Menü gestartete Programme Homebrew- oder nvm-Pfade oft nicht kennen.
- Grobe Datei-Uhr unter Linux: Zeitvergleiche mit Dateien haben 1 s Spielraum. Ob eine Sitzung „neu" ist, entscheidet nicht die Erstellungszeit der Datei (fehlt auf manchen Linux-Dateisystemen), sondern ob es sie beim Start schon gab.
- Symlinks: Claude Code speichert den echten Pfad (unter macOS z. B. `/private/var/…`); die Extension vergleicht deshalb auch mit dem echten Pfad des Workspace-Ordners.

## Installieren / Entwickeln

```sh
npm install                # Test-Werkzeuge, richtet auch den Git-Hook ein
npx @vscode/vsce package
code --install-extension claude-token-tracker-0.1.0.vsix
```

Zum Entwickeln den Ordner in VS Code öffnen und `F5` drücken.

## Tests

```sh
npm test                   # schnell (~2 s): Kern, Preise, Statuszeile, Extension-Ablauf, Panel
npm run test:vscode        # im echten VS Code (lädt beim ersten Mal VS Code nach .vscode-test/)
```

`npm test` nutzt den in Node eingebauten Test-Runner. Die Tests legen ein temporäres `~/.claude` mit Transkripten im Format von Claude Code an:

- `test/core.test.js` – Zählen, Deduplizieren, Zeitfenster, Teilzeilen, Blockgrenzen, Workspace-/Sitzungs-Filter, „nächste neue Sitzung", automatisches Weiterzählen, Lücken beim rückwirkenden Start, Tage, Sitzungsliste, Format-Erkennung
- `test/prices.test.js` – Preisberechnung inkl. Cache, Fast Mode, Haiku-Aufpreis, Websuche, eigene Preise
- `test/statusline.test.js` – Claude-Code-Statuszeile
- `test/extension.test.js` – Ablauf in VS Code mit nachgebauter vscode-API: Start-Dialoge, Pause, Stopp, rückwirkend, Leerlauf, Sitzungsauswahl und -wechsel, Preiswarnung, Verlauf (Bearbeiten, Zusammenführen, Löschen, Fortsetzen – auch mit mehreren Fenstern), Format-Warnung, Sicherheit
- `test/panel.test.js` – `panel.html` im Browser (Edge/Chrome über `playwright-core`) mit derselben Content-Security-Policy wie in VS Code: Filter, Diagramm, Tooltip, Tabellenansicht, Bearbeiten, Zusammenführen, Farben, Schutz vor HTML in Nutzereingaben
- `test/vscode/` – Integrationstest im echten, isolierten VS Code: Aktivierung, Befehle, Start/Pause/Stopp, Einstellungen, Webview-Panel, Statuszeilen-Einrichtung

Automatisch laufen die Tests

- vor jedem Commit (Git-Hook in `.githooks/`, im Notfall `git commit --no-verify`),
- vor jedem Paketieren (`vscode:prepublish`),
- auf GitHub bei jedem Push (`.github/workflows/test.yml`, inklusive Test im echten VS Code).

## Entstehung

Diese Extension habe ich zusammen mit Claude Code entwickelt – passenderweise mit genau dem Werkzeug, dessen Token-Verbrauch sie misst.

## Lizenz

MIT © 2026 Peter R. Stuhlmann – siehe Datei `LICENSE`.

Die Icons im Footer des Panels (Herz, Cannabisblatt, Flasche) stammen aus [Material Design Icons](https://pictogrammers.com/library/mdi/) von Pictogrammers und stehen unter der Apache-2.0-Lizenz.

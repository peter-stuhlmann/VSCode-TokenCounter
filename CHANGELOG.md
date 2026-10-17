# Changelog

## 0.1.0

Erste Version.

- Start, Pause und Stopp in der Statusleiste; „Verlauf"-Button, solange nichts gezählt wird. Tooltip mit Kennzahlen und Tabelle pro Modell.
- Was gezählt wird: eine bestimmte Claude-Sitzung (inkl. Subagents und „Nächste neue Sitzung" mit Wechselmöglichkeit), der Workspace oder alle Sitzungen.
- Rückwirkender Start (ab Sitzungsbeginn, vor X Minuten, ab Uhrzeit); automatische Pause bei Leerlauf, die von selbst weiterzählt, sobald neue Tokens kommen.
- Genaue Zählung: Antworten, die Claude Code in mehreren Zeilen mit wachsendem Output schreibt, zählen mit ihrem Endstand – auch wenn er erst nach Pause oder Stopp geschrieben wird.
- Theoretischer API-Preis pro Antwort (Preise Stand 16.10.2026) inkl. Cache-Write 5 min/1 h, Cache-Read, Fast Mode, Haiku-5.5-Aufpreis, Verarbeitung nur in den USA und Websuche; eigene Preise per Einstellung; Warnung bei Modellen ohne Preis.
- Panel: Filter nach Projekt, Tag, Zeitraum und Name; Diagramm pro Tag/Woche nach Modell; Projektübersicht; Verlauf bearbeiten, zusammenführen, fortsetzen, löschen; CSV-Export; Footer mit Preisstand.
- Anzeige in der Claude-Code-Statuszeile (Einrichtung per Befehl, mit Backup der Einstellungen).
- Verlauf als eine Datei pro Eintrag, sicher bei mehreren VS-Code-Fenstern.
- Warnung, wenn sich das Transkript-Format von Claude Code ändert.
- Leistung: Dateiüberwachung statt Prüfung aller Transkripte; ohne laufende Messung keine Hintergrundarbeit.
- Sicherheit: strenge Content-Security-Policy im Panel, feste Befehlsliste, geprüfte Panel-Nachrichten, CSV-Export ohne Formel-Ausführung, keine Steuerzeichen im Terminal.
- Windows, macOS und Linux; eingeschränkter Modus und Remote (WSL/SSH/Container).
- Tests für Kern, Preise, Statuszeile, Extension-Ablauf, Panel (im Browser) und im echten VS Code; Git-Hook vor jedem Commit; GitHub-Workflow für alle drei Systeme.

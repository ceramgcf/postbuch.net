# Scanner Webhooks

Host: `http://<scanner-host>:8080`

Alle Endpunkte sind einfache GET-Requests mit Query-Parametern. Standardwerte: `dpi=300`, `mode=gray`.

Ausgabeordner im Container: `/scans` (auf Host gemountet als `./scans_raw`).

## Übersicht

- ADF Simplex (ADF bis leer)
  - GET: http://<scanner-host>:8080/scan/adf/simplex
  - Beispiel (600 DPI, Farbe): http://<scanner-host>:8080/scan/adf/simplex?dpi=600&mode=color

- ADF Duplex (ADF bis leer, duplex scan)
  - GET: http://<scanner-host>:8080/scan/adf/duplex
  - Beispiel (600 DPI, Farbe): http://<scanner-host>:8080/scan/adf/duplex?dpi=600&mode=color

- ADF Stapel-Import (mehrere Blätter gleichzeitig einlegen, jedes Blatt = 1 Dokument)
  - GET: http://<scanner-host>:8080/scan/adf/batch/duplex
  - Anders als bei den Endpunkten oben entsteht **nicht eine** PDF mit allen Seiten,
    sondern **eine PDF pro Blatt**: Vorder- und Rückseite je Blatt. Eine leere
    Rückseite wird von der nachgelagerten Cleaner-Pipeline automatisch entfernt,
    das Dokument bleibt dann einseitig. Bricht der ADF mitten im Stapel ab
    (z. B. Papierstau), werden
    die bereits fertig gescannten Blätter trotzdem als eigenständige Dokumente
    übernommen (`status: "partial"`).
  - Der frühere Endpunkt `/scan/adf/batch/simplex` bleibt ausschließlich zur
    technischen Rückwärtskompatibilität erhalten und wird in der Import-UI
    nicht angeboten.

- Flachbett Einzelscan (eine Seite)
  - GET: http://<scanner-host>:8080/scan/flatbed/single?size=<SIZE>&dpi=<DPI>&mode=<MODE>
  - `size` = `a4` (Default) | `a5` | `a6`
  - Beispiel A4, 300dpi, Graustufe: http://<scanner-host>:8080/scan/flatbed/single?size=a4&dpi=300&mode=gray

- Kalibrierungs-Testscan (interner App-Workflow, keine Dokumentpipeline)
  - GET: http://<scanner-host>:8080/scan/test/single?slot=1&size=a4&dpi=300&mode=gray
  - `slot` ist 1, 2 oder 3. Die PDF wird atomar im separaten Testverzeichnis
    gespeichert und erzeugt weder Cleaner-Import noch PostID.

- Flachbett Mehrseitiger Scan (Session-basiert, singleton)
  - **Kombinierter Start/Add-Endpunkt** *(empfohlen – ein Knopf für alles)*:
    - GET: http://<scanner-host>:8080/scan/flatbed/session/scan?size=<SIZE>&dpi=<DPI>&mode=<MODE>
    - Kein Scan aktiv → startet neue Session + scannt erste Seite.
    - Session aktiv → fügt weitere Seite hinzu.
    - `dpi`/`mode`/`size` werden nur beim ersten Aufruf (Start) übernommen.
  - Session-Start + erste Seite (explizit): http://<scanner-host>:8080/scan/flatbed/session/start?size=a4&dpi=300&mode=gray
  - Weitere Seite hinzufügen (explizit):    http://<scanner-host>:8080/scan/flatbed/session/add
  - Session abschließen → PDF:              http://<scanner-host>:8080/scan/flatbed/session/finish
  - Session abbrechen:                      http://<scanner-host>:8080/scan/flatbed/session/abort

  Hinweise zur Session-Logik:
  - Es kann nur eine aktive Session gleichzeitig existieren (Singleton).
  - `/start` (bzw. der erste `/scan`-Aufruf) legt `dpi`, `mode` und `size` für die gesamte Session fest; `size` = `a3` | `a4` (Default) | `a5` | `a6`.
  - Ein neuer `/start` während einer laufenden Session bricht die alte automatisch ab (kein PDF wird erzeugt).
  - Nach jeder `/add` wird die Session-Idle-Timeout neu gestartet.
  - Idle-Timeout: 60 Sekunden Inaktivität → automatische `finish` und PDF-Erzeugung.
  - PDF wird erst beim `finish` (manuell oder automatisch) in den Ausgabeordner geschrieben.

- Legacy (Rückwärtskompatibel)
  - GET: http://<scanner-host>:8080/scan
  - Beispiel für ADF Duplex: http://<scanner-host>:8080/scan?source=adf&duplex=true&dpi=300&mode=gray

## Beispiel-Aufrufe (curl)

- ADF Simplex, Farbe, 300dpi

```bash
curl -sS "http://<scanner-host>:8080/scan/adf/simplex?dpi=300&mode=color"
```

- Mehrseitiger Flachbettscan mit kombiniertem Endpunkt: Scan → Scan → Scan → Finish

```bash
# Erster Scan: startet Session + scannt erste Seite ({"action":"started","pages":1})
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/scan?dpi=300&mode=gray"
# warte, lege neue Seite auf das Glas
# Zweiter Scan: fügt Seite hinzu ({"action":"added","pages":2})
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/scan"
# warte, lege nächste Seite auf das Glas
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/scan"
# fertig → PDF erzeugen
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/finish"
```

- Mehrseitiger Flachbettscan: Start → Add → Add → Finish

```bash
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/start?dpi=300&mode=gray"
# warte, lege neue Seite auf das Glas
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/add"
# warte, lege nächste Seite auf das Glas
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/add"
# fertig
curl -sS "http://<scanner-host>:8080/scan/flatbed/session/finish"
```

## Fehlerfälle / Rückgaben

Die Endpunkte geben JSON zurück, z.B.

- Erfolg: `{"status":"ok","file":"adf_simplex_20250401_123000.pdf","pages":5}`
- Fehler:  `{"status":"error","msg":"...","stderr":"..."}`

Der ADF-Stapel-Endpunkt `/scan/adf/batch/duplex` liefert statt `file` ein
`files`-Array (ein Dateiname pro Blatt) sowie `sheets` (Anzahl Blätter):

- Erfolg: `{"status":"ok","files":["adf_duplex_batch_20250401_123000_001.pdf","adf_duplex_batch_20250401_123000_002.pdf"],"sheets":2,"pages":4}`
- Teilerfolg nach ADF-Fehler: `{"status":"partial","files":[...],"sheets":2,"pages":3,"msg":"...","stderr":"..."}`
- Fehler (keine einzige Seite gescannt): `{"status":"error","msg":"...","stderr":"..."}`

## Hinweise

- Scanner-Device: konfiguriert über `SCANNER_DEVICE_URL` (z. B. `http://192.168.1.100:80/eSCL`).
- PDFs landen im Container-`/scans` (Host: `./scans_raw`). Die nachgelagerte `cleaner`/`onedrive`-Pipeline verschiebt/archiviert weiter nach `scans_done` und synchronisiert extern.
- Wenn du andere IP/Host möchtest, passe die URL entsprechend an und redeploye den Container:

```bash
cd /path/to/postbuch-unified
docker compose up -d --build scanner
```

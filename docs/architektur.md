# Architektur

Dieses Kapitel beschreibt, wie postbuch.net intern aufgebaut ist. Es ist nicht
nötig, um die Software zu benutzen – hilfreich ist es, wenn man Fehler sucht,
den Server umbaut oder wissen will, wo die eigenen Daten tatsächlich liegen.

## Die Dienste

postbuch.net ist ein Docker-Compose-Verbund aus wenigen Containern. Drei davon
laufen immer; Scanner, Cleaner und Caddy werden über Compose-Profile zugeschaltet.

| Dienst | Basis | Rolle | Port auf dem Host |
|---|---|---|---|
| `postgres` | PostgreSQL 16 + pgvector | Alle Daten außer den PDFs selbst | `127.0.0.1:5433` – nur lokal |
| `app` | Node.js 22, Express 5 | API, Dokumenten-Pipeline, Hintergrundjobs | keiner |
| `web` | nginx + gebautes React-Bundle | Weboberfläche, Reverse-Proxy vor `app` | `3420` (konfigurierbar) |
| `scanner` | Python | eSCL-Webhook zum Netzwerkscanner | `${SCANNER_PORT}` (Profil `scanner`) |
| `cleaner` | Python | OCR und Bildbereinigung der Scans | keiner (Profil `scanner`) |
| `caddy` | Caddy | HTTPS-Terminierung mit automatischem Zertifikat | `80`, `443` (Profil `caddy`) |

Zwei Details daran sind Absicht und keine Nachlässigkeit:

- **`app` hat keinen Host-Port.** Die API ist ausschließlich über nginx im
  `web`-Container erreichbar. Das ist die Stelle, an der interne Routen
  geblockt und Proxy-Header gesetzt werden – es gibt keinen Weg daran vorbei.
- **PostgreSQL hört nur auf `127.0.0.1`.** Die Datenbank ist aus dem Netz
  nicht erreichbar, auch nicht aus dem eigenen LAN. Wer mit `psql` von außen
  ran will, tunnelt über SSH.

Alle Basis-Images sind per Digest festgenagelt – PostgreSQL, Node, nginx,
Python, die OCR-Basis und Caddy. Ein Rebuild zieht damit nicht unbemerkt eine
andere Version herein.

## Weg eines Dokuments durch die Pipeline

Jedes Dokument durchläuft dieselbe Kette, egal wie es hereinkommt. Es gibt
genau zwei Eingänge: eine Datei, die bereits in der Dateiablage liegt (Upload,
überwachter Ordner), oder ein PDF direkt im Speicher (Scanner). Ab Phase 1
sind beide Wege identisch.

| Phase | Was passiert | Wenn es schiefgeht |
|---|---|---|
| 0 | Upload in die Dateiablage (nur beim Scanner-Weg) | Retry mit wachsendem Abstand, alle 5 Minuten |
| 1 | Datei aus der Dateiablage laden | Job scheitert, Datei bleibt liegen |
| 2 | KI-Analyse: Typ, Absender, Betreff, Datum, Beträge | siehe [KI-Anbieter](ki-provider.md) |
| 3 | Duplikatprüfung gegen den Bestand (berechnet dabei das Embedding) | – |
| 4 | Duplikat-Entscheidung | Job wird ausgesetzt und wartet auf dich |
| 5 | Einsortieren in den Zielordner der Dateiablage | – |
| 6 | Push und experimentelle Discord-Benachrichtigung, falls eingerichtet | wird übersprungen |
| 7 | PDF-Rotation (Seiten aufrichten) | – |
| 8 | Anlegen des Datensatzes in der Datenbank, Embedding wird mit gespeichert | Schlug das Embedding in Phase 3 fehl, entsteht der Datensatz trotzdem – er ist dann nur noch nicht semantisch suchbar |
| 9 | PDF im Cache ablegen | wird protokolliert, hält die Pipeline aber nicht auf |

Der Fortschritt ist während des Laufs im Import-Bereich sichtbar; die
Oberfläche fragt den Zustand laufend ab. Phase 4 ist die einzige, die auf eine
menschliche Entscheidung wartet – solche Jobs bleiben sichtbar stehen, bis du
entscheidest oder die Frist abläuft (siehe
[Dokumente importieren](dokumente-importieren.md)).

**Serialisiert wird über eine Warteschlange.** Es laufen höchstens
`pipeline_max_parallel` Pipelines gleichzeitig (Standard 3, einstellbar 1–10),
alles Weitere wartet in der Reihenfolge des Eingangs. Ein zweiter Import
derselben Datei wird erkannt und nicht doppelt gestartet. Während eines
Dateiablage-Umzugs pausiert die Queue vollständig: Jobs werden angenommen, aber
nicht gestartet, damit keine Datei noch schnell im alten Backend landet.

Nach einem Neustart wird die Pipeline abgeglichen: angefangene, aber nicht
beendete Jobs werden anhand der Journalzeilen wieder aufgenommen. Dieser
Abgleich wiederholt sich alle fünf Minuten, damit auch eine vorübergehend
gestörte Dateiablage nicht dauerhaft Jobs liegen lässt.

## Hintergrundjobs

Beim Start der App laufen mehrere Zeitgeber an. Sie erklären die meisten
Log-Zeilen, die ohne dein Zutun erscheinen:

| Job | Takt | Zweck |
|---|---|---|
| OneDrive-Token-Keep-Alive | erster Lauf nach etwa 1 Stunde, danach alle 24 Stunden | hält das Refresh-Token aktiv – nur bei aktivem OneDrive |
| Dateiablage-Polling | einstellbar | findet neue Dateien im überwachten Ordner |
| Backup | Cron, Standard 04:00 | Datenbank-Dump in die Dateiablage |
| DR-Fingerprints | sonntags 03:00 | Prüfsummen für die Notfallwiederherstellung |
| Duplikat-Sweeper | laufend | löst abgelaufene Duplikat-Entscheidungen auf |
| Erinnerungen | stündlich, liefert aber je Person nur zur eingestellten Uhrzeit | Wiedervorlagen und fällige Zahlungen als Push |
| Scan-Retry | alle 5 Min | wiederholt fehlgeschlagene Scanner-Uploads |
| Pipeline-Abgleich | alle 5 Min | nimmt hängengebliebene Jobs wieder auf |
| Update-Prüfung | täglich | holt das Release-Manifest der Bezugsquelle |
| Hilfe-Embedding | bei App-Start und Providerwechsel, idempotent | gleicht die ausgelieferte Anwenderhilfe mit der aktiven Embedding-Signatur ab |
| Discord-Gateway (experimentell) | laufend | nimmt Klicks auf Discord-Buttons entgegen, falls bewusst eingerichtet |

## Konfiguration liegt in der Datenbank

Beim **ersten** Start werden die fachlichen Werte aus der `.env` in die Tabelle
`_settings` übernommen; danach liest die App die meisten Einstellungen von
dort. Die Bezugsquelle für Release-Feeds (`POSTBUCH_FEED_BASE_URL` und
`POSTBUCH_FEED_AUTH`) ist die tatsächliche Ausnahme: Sie kommt dauerhaft
direkt aus der `.env` und wird erst nach einem Neustart wirksam.

Dauerhaft aus der Umgebung kommen die Postgres-Verbindung, `PORT`, `NODE_ENV`,
`TZ`, das Admin-Passwort und der genannte Laufzeitwert. Dateiablage, KI-Anbieter
und Modelle (auch Bedrock), Backup-Zeitplan, Push-Benachrichtigungen und
Scanner werden in der Weboberfläche gepflegt. Die experimentelle
Discord-Anbindung wird dort nach einer Risikobestätigung freigeschaltet; für
Benachrichtigungen ist PWA-/Browser-Push empfohlen.

Das hat eine praktische Konsequenz: **ein Datenbank-Backup enthält die
komplette Konfiguration samt Zugangsdaten.** Siehe
[Backup und Wiederherstellung](backup-wiederherstellung.md).

## Zwei Abstraktionen, die man kennen sollte

**Dateiablage.** Kein Teil der Anwendung spricht direkt mit OneDrive oder
Nextcloud. Dazwischen liegt eine Adapter-Schicht mit einer schmalen
Schnittstelle (herunterladen, hochladen, verschieben, Ordner anlegen,
auflisten). Jede Dokumentzeile merkt sich, in welchem Backend ihre Datei
liegt. Deshalb ist ein halb umgezogener Bestand ein funktionierender Zustand
und kein Defekt – Details im Kapitel [Dateiablage-Backends](storage-backends.md).

**KI.** Ebenso für Sprachmodelle: eine Registry kennt Anbieter, deren Adresse,
Schlüssel und Fähigkeiten. Ob ein Anbieter PDFs direkt lesen kann oder
stattdessen den lokal extrahierten Text bekommt, ist eine deklarierte
Eigenschaft und wird nicht ausprobiert. Jede ausgehende Verbindung mit
konfigurierbarer Adresse läuft durch eine Schutzschicht, die Weiterleitungen
und Ziele im privaten Netz kontrolliert (siehe [Sicherheit](sicherheit.md)).

## Datenmodell in Stichworten

Rund fünfzig Tabellen im Schema `postbuch`. Die tragenden:

- **`postbuch`** – der Dokumentenbestand. Eine Zeile pro Dokument: Absender,
  Betreff, Datum, Lebensbereich und Dokumentart, Verbleib des Papieroriginals,
  Wiedervorlage, Verweis auf die Datei in der Dateiablage, Embedding-Vektor.
- **`mensch`** – jede Person genau einmal, ob mit Zugang oder ohne. Fachliche
  Angaben (PKV-Satz, Beihilfesatz, Farbe) und der optionale Login stehen in
  derselben Zeile.
- **`akte`** – Vorgangsklammer über mehrere Dokumente.
- **Abrechnung** – Arztrechnungen mit Einzelpositionen, Erstattungsbescheide
  mit ihren Positionen, Einreichungsperioden. Das ist der umfangreichste
  Teilbereich; siehe [PKV, Beihilfe und Abrechnung](abrechnung-pkv-beihilfe.md).
- **Technische Tabellen** mit führendem Unterstrich: Einstellungen, Sitzungen,
  Pipeline-Journal, ausgesetzte Jobs, fehlgeschlagene Dokumente,
  Backup-Metadaten, Fingerprint-Sitzungen, MCP-Tokens, Text- und Bild-Caches
  sowie die atomar umgeschalteten Hilfekorpora.

Dokumente sind mit Menschen über den **Kurznamen als Text** verknüpft, nicht
über einen Fremdschlüssel. Wer einen Kurznamen ändert, löst damit eine
Umbenennung im gesamten Bestand aus – das erledigt die Anwendung, aber es
erklärt, warum die Umbenennung einen Moment dauert.

**Die PDFs liegen dauerhaft nicht in der Datenbank.** Sie liegen in der Dateiablage;
die Datenbank hält nur den Verweis (`storage_id`). Das ist der Grund, warum ein
Datenbank-Backup allein kein vollständiges Backup ist.

Eine einzige Ausnahme ist `post_files`: ein reiner Lese-Cache, der die
rohen PDF-Bytes der **100 zuletzt geöffneten oder verarbeiteten Dokumente**
vorhält (`service/document-retriever.js`), damit wiederholtes Anzeigen desselben
Dokuments nicht jedes Mal erneut aus der Dateiablage heruntergeladen werden muss. Ein
Trigger löscht bei jedem Einfügen automatisch alles außer den 100 neuesten
Zeilen; verloren geht dabei nichts, ein Cache-Miss lädt beim nächsten Zugriff
einfach erneut aus der Dateiablage nach. Genau deshalb ist `post_files` auch bewusst
von jedem Datenbank-Backup ausgenommen (`jobs/backup-policy.js`) – er ist
jederzeit aus der Dateiablage regenerierbar und würde ein Backup nur unnötig
aufblähen.

## Schema-Pflege ohne Migrationstool

postbuch.net hat kein Migrationswerkzeug. Stattdessen:

1. `base_schema.sql` beschreibt den **Ist-Zustand von heute** und läuft bei
   **jedem** Start der App. Jede Anweisung darin ist idempotent, das Schema
   also beliebig oft anwendbar, ohne bestehende Daten zu verändern.
2. Alles, was nur dazu diente, eine ältere Datenbank nachzuziehen, steht
   eingefroren in `app/schema/legacy-bis-<version>.sql`. Diese Skripte werden
   nie wieder angefasst und laufen je Instanz höchstens einmal.
3. Eine Verwaltungstabelle `_schema_historie` merkt sich, was bereits gelaufen
   ist. Ausgelöst wird am Zustand der Datenbank, nicht an einer
   Versionsnummer – die Datenbank weiß nicht, welche App-Version sie zuletzt
   gesehen hat.
4. Bei einer Erstinstallation wird die Legacy-Kette übersprungen und als
   „übersprungen" verbucht: das Vollschema erzeugt den Zielzustand ohnehin.

Für den Betrieb heißt das: **ein Update ändert das Schema beim ersten Start
der neuen App-Version von selbst.** Es gibt keinen Migrationsbefehl, den man
vergessen könnte, und ein Rückschritt auf eine ältere Version ist kein
vorgesehener Weg.

## Weboberfläche

React 19 mit react-router und TanStack Query, gebaut mit Vite, gestaltet mit
Tailwind. Das Ergebnis ist ein statisches Bundle, das nginx ausliefert; im
selben Container proxyt nginx `/api/` an die App.

Die Oberfläche ist eine **PWA** und lässt sich als App installieren. Der
Service-Worker ist bewusst schmal: er nimmt Push-Benachrichtigungen entgegen
und öffnet beim Antippen die richtige Seite. Er speichert nichts für den
Offline-Betrieb zwischen – ohne Verbindung zum Server ist die Anwendung leer.
Die Cache-Regeln in nginx sind so gesetzt, dass `index.html`, Service-Worker und Manifest nie
zwischengespeichert werden, die versionierten Bundles dagegen schon. Ein
Deployment kommt darum zeitnah auf den Geräten an, ohne den Cache zu leeren.
Siehe [Mobil und PWA](mobil-und-pwa.md).

## Versionierung und Auslieferung

Eine einzige Datei `VERSION` gilt für den ganzen Verbund und landet in beiden
Images. Ein Release ist ein signiertes Tarball plus Manifest; der Installer
prüft die Signatur, bevor er irgendetwas auspackt, und bricht bei einer
Abweichung ab. Eine einmal veröffentlichte Version wird nie neu gebaut –
geänderter Code bedeutet eine neue Versionsnummer. Was ein Update konkret tut,
steht in [Betrieb und Troubleshooting](betrieb-troubleshooting.md).

---

Weiter: [Betrieb und Troubleshooting](betrieb-troubleshooting.md) · [Zurück zur Übersicht](README.md)

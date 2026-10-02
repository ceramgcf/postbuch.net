# Changelog

Diese Datei ist die **Quelle der Wahrheit** für Release-Notizen. Aus ihr erzeugt
`scripts/gen-latest-json.mjs` das öffentliche Release-Manifest (`latest.json`),
das jede Instanz beim Update-Check liest. Ein Artefakt für Repo, Homepage und
Manifest – drei gepflegte Listen wären drei Stände.

**Format, an das sich der Generator hält:**

```
## <version> – <YYYY-MM-DD>

- Stichpunkt (max. 200 Zeichen, kein Markup, keine Links)
- …
```

Die Stichpunkte gehen wörtlich ins Manifest und werden im GUI jeder Instanz
angezeigt. Sie sind an Endnutzer gerichtet, nicht an Entwickler.

---

## 2.10.0 – 2026-10-02

- Erste öffentliche Version.
- Neues Bild der Hauptansicht in der Projektbeschreibung.

## 2.9.0 – 2026-10-02

- Neuer Schalter „Vorabversionen erhalten“ unter Einstellungen → Allgemein: Eingeschaltet bietet die Instanz neue Versionen schon an, bevor sie als stabil gelten.
- Schlägt die Update-Prüfung fehl, zeigt die Update-Karte keinen veralteten Stand mehr an.

## 2.8.34 – 2026-10-01

- Scheitert die OneDrive-Verbindung mit Client-Secret, erklären Popup und Einstellungen jetzt, ob das Secret abgelaufen oder ungültig ist und wie man erneut verbindet.
- Vor „TLS aktivieren“ prüfen Assistent und Installer, ob die DuckDNS-Domain auf diesen Server zeigt und der Router sie auflöst, und nennen sonst den Grund.
- Ein bloßer DuckDNS-Name wie „meinpostbuch“ wird automatisch zu „meinpostbuch.duckdns.org“ ergänzt.
- Bei der Anmeldung werden Leerzeichen um den Benutzernamen ignoriert, und „Admin“ funktioniert in jeder Schreibweise.
- Aktualisierte KI-Modellempfehlungen.

## 2.8.33 – 2026-09-30

- Die Docker-Einrichtung zeigt nur noch Hinweise, die für den Installationslauf nötig sind.
- Der Installer meldet sich während langer Image-Builds regelmäßig, damit ein langsamer Build nicht wie ein Hänger wirkt.
- Anmeldenamen unterscheiden nicht mehr zwischen Groß- und Kleinschreibung und können nicht in anderer Schreibweise doppelt vergeben werden.
- Ein Restore beendet alle bestehenden Anmeldungen, und Backups enthalten keine Web-Sitzungen mehr.
- Nach einem Restore zeigt die Wartemeldung nach zwei Minuten „Erneut prüfen“ und „Zur Anmeldung“, statt endlos zu warten.
- Die Seite zum Einspielen eines Backups bei der Installation bietet jetzt auch „Ohne Backup neu einrichten“.
- Ein abgebrochener OneDrive-Gerätecode wird sofort verworfen; eine ungültige Client-ID wird als solche gemeldet statt als abgelaufene Anmeldung.
- Fehlende Nextcloud-Berechtigungen werden nicht mehr als falsches App-Passwort gemeldet.
- Nach dem Abschalten von TLS zeigt der Einrichtungsassistent keine DuckDNS-Domain mehr an.
- Scanner-Kalibrierung, Duplikat-Entscheidung und Einstellungen zeigen bei Serverfehlern einen Fehler mit „Erneut laden“ statt endlos zu laden.
- Das Backup-Passwort bleibt auch dann gültig, wenn eine Passwortänderung und ein Backup gleichzeitig laufen.

## 2.8.32 – 2026-09-29

- Nach der automatischen Docker-Installation setzt der Installer die Einrichtung im selben Lauf mit sudo fort. Bereits eingegebene Angaben gehen dadurch nicht mehr verloren.

## 2.8.31 – 2026-09-29

- Lesezugriff lässt sich auf eigene Dokumente beschränken. Dokumentliste, Suche und PDF-Zugriff beachten die Grenze; andere Bereiche sind für diese Konten gesperrt.
- Die Dateiablage kann wahlweise nach Person vor Lebensbereich und Dokumentart gegliedert werden. Die Umstellung verschiebt vorhandene Dokumente und lässt sich fortsetzen.
- Dokumente ohne Person erscheinen über den Filter „(ohne)“ und liegen bei der Personenablage im Ordner „Gemeinsam“.
- Ändert sich die Personenzuordnung oder der Kurzname, folgt die Ablage. Nach dem Löschen einer Person werden verbleibende Dokumente und leere Ordner aufgeräumt.
- Der Ablageumzug behandelt gleichzeitig angelegte Nextcloud-Ordner und XML-kodierte Dateinamen zuverlässiger.
- Der Installer findet Docker Compose auch auf Debian 13 über das Paket docker-compose.

## 2.8.30 – 2026-09-27

- Der Personenfilter in der Dokumentliste vergleicht den Kurznamen exakt: Ein Filter auf „Jona“ zeigt keine Dokumente von „Jonas“ mehr.
- Die Personenzuordnung beim Import einer Dokumentenübergabe zeigt keinen irreführenden Hinweis zu Abrechnungsperioden mehr; übergebene Dokumente werden nie einer Periode zugeordnet.

## 2.8.29 – 2026-09-27

- Der Installer findet eine Instanz auch außerhalb von ~/postbuch: im eigenen Verzeichnis, im aktuellen Verzeichnis und über die Merkdatei ~/.postbuch-installdir.
- Update, Deinstallation, Rollback und Adminpasswort funktionieren damit für jedes Installationsverzeichnis ohne zusätzliche Angabe von --install-dir.
- Der Installer legt keine zweite Instanz auf demselben Rechner an.

## 2.8.28 – 2026-09-26

- Backups bleiben über Passwortwechsel und Ab-/Wiedereinschalten der Verschlüsselung hinweg mit demselben Schlüssel lesbar; die Schlüsseldatei im Backup-Ordner trägt alle bekannten Schlüssel.
- Beim Wiederherstellen und Neuaufsetzen genügt jetzt das aktuelle Backup-Passwort zusammen mit der Schlüsseldatei schluessel.json.
- Verschlüsselte Backup-Dateien lassen sich mit einem mitgelieferten Werkzeug auch auf der Kommandozeile entschlüsseln.
- Beim Einspielen einer Dokumentenübergabe ordnest du die Personen aus dem Paket vor dem Import den Menschen dieser Instanz zu, mit Vorschlägen und direktem Neuanlegen.
- Nennt die KI eine behandelte Person, die keinem erfassten Menschen eindeutig entspricht, bleibt das Feld leer und das Dokument geht in den Review.
- Der Admin kann Push-Benachrichtigungen für die ganze Instanz abschalten; der Cloudfrei-Check zeigt, wer Push gerade nutzt.
- Die Hilfe ist während der Einrichtung erreichbar und öffnet sich aus dem Assistenten in einem eigenen Tab; der Dateiablage-Selbsttest ist dort nur noch empfohlen.
- Telekommunikationsverträge und -rechnungen werden dem Lebensbereich Versorgung zugeordnet.
- Der Installer zeigt die Zugriffsadressen am Ende direkt über den nächsten Schritten.

## 2.8.27 – 2026-09-24

- Zu jedem Sprachmodell lassen sich jetzt eigene Preise für Cache-Write und Cache-Read hinterlegen; bestehende Preise werden einmalig mit der üblichen Staffel vorbelegt.
- Modell-Kurznamen und datierte Modellversionen werden sauber zugeordnet; ähnlich benannte, aber andere Modelle bekommen keinen fremden Preis und keine falsche Verfügbarkeit mehr.
- Die Warnung zu nicht mehr gelisteten KI-Modellen steht weiter oben im Dashboard, nennt die betroffenen Modellklassen und verweist Nicht-Admins an einen Admin.
- Beim Scannen über den Einzug wählst du Vorderseite oder Beidseitig jetzt als eigenen Schalter, auch für den Stapelmodus.
- Aktualisierte Modellempfehlungen mit Cache-Preisen.

## 2.8.26 – 2026-09-18

- Rechnungen, Prüfvormerkungen und Anpinnungen, die nach dem PDF-Bau einer Periode noch dazukommen, werden beim Bestätigen sichtbar in die nächste Periode verschoben statt lautlos übernommen.
- Der Cloud-Speicher (OneDrive/Nextcloud) heißt in Oberfläche und Dokumentation jetzt konsistent Dateiablage, zur Unterscheidung vom Verbleib der Papierablagen.

## 2.8.25 – 2026-09-17

- Im Einrichtungsassistenten lässt sich eine zuvor abgelehnte Backup-Verschlüsselung nachträglich per Klick doch noch einrichten.
- Der Import zeigt den Scan-Weg nur noch an, wenn auf der Instanz tatsächlich ein Scanner eingerichtet ist.
- Der Scanner hat keine vorbelegte Geräteadresse mehr; die Netzwerksuche findet das Gerät im eigenen Netz.
- Ein eingerichteter Scanner lässt sich in den Einstellungen jetzt auch wieder vollständig entfernen.
- Ein erfolgreich getesteter oder gelöschter Scanner schaltet sein Docker-Profil jetzt automatisch mit ein bzw. aus.

## 2.8.24 – 2026-09-17

- Ein erfolgreich getesteter Scanner übernimmt seine Ausstattung (ADF, ADF-Duplex, A3) jetzt automatisch – auch im Einrichtungsassistenten, ohne manuelle Bestätigung.

## 2.8.23 – 2026-09-17

- Notfall-Korrektur: Ein Update oder eine Neuinstallation ab 2.8.21 schlug beim Bauen des Backend-Images zuverlässig fehl; der laufende Stack blieb dabei unangetastet.

## 2.8.22 – 2026-09-17

- Ein interner Wartungslauf konnte laufende oder bereits fertig verarbeitete Dokumente fälschlich als fehlgeschlagen markieren und ihre Datei verschieben – das ist jetzt behoben.
- Nach „Erneut verarbeiten“ bei einem fehlgeschlagenen Dokument zeigt die Karte jetzt sofort „Wird erneut verarbeitet …“, statt regungslos stehen zu bleiben.
- Ein erneuter Verarbeitungsversuch einer bereits abgelegten Datei löst keine unnötige Neuanalyse und keine Duplikatwarnung mehr aus; eine falsch abgelegte Datei wird automatisch zurückgeholt.
- FAQ, Benachrichtigungs-Hilfe und Installer weisen jetzt darauf hin: Push-Benachrichtigungen brauchen den Hostnamen mit https, DNS-Rebind-Schutz im Router kann das im Heimnetz blockieren.
- Der Push-Hinweis erkennt jetzt, ob eine unverschlüsselte Verbindung oder eine reine IP-Adresse die Ursache ist, statt pauschal „Browser nicht unterstützt“ zu melden.
- Der KI-Provider-Bereich weist jetzt direkt darauf hin, wenn nur noch der OpenAI-API-Key fehlt, statt ein verwirrendes Duplikat über „Hinzufügen“ nahezulegen.
- Der Einrichtungsassistent zeigt bei einem doppelt gestarteten Host-Agent-Auftrag jetzt einen Warte-Hinweis statt einer Fehlermeldung.

## 2.8.21 – 2026-09-17

- Die Erkennung leerer und zuzuschneidender Scan-Seiten wurde neu kalibriert: weniger übersehene Inhalte, weniger fälschlich verworfene Randnotizen
- Rechnungen und Berichte werden jetzt auf vollständige Pflichtangaben geprüft; eine unvollständige KI-Antwort löst automatisch einen neuen Versuch aus statt eines lückenhaften Eintrags

## 2.8.20 – 2026-08-29

- Die Umzugskarte prüft jetzt auf Wunsch, ob seit dem Trockenlauf weitere Dokumente in der alten Ablage ankamen, und nimmt sie auf Knopfdruck in denselben Lauf auf, statt sie dort liegen zu lassen
- Der Fortschrittsdialog beim Ändern von Scanner-Modul, Port oder DuckDNS sprach fälschlich von „Update“ statt von „Host-Konfiguration“ und zeigte danach unnötig den Hinweis zum Neuladen der Seite an

## 2.8.19 – 2026-08-29

- Nach einem erfolgreich abgeschlossenen Umzug sprang die Umzugskarte fälschlich zurück auf den Trockenlauf-Einstieg, statt Umschalten und Aufräumen anzubieten
- Der Zielordner beim Anlegen der Ordnerstruktur für den Umzug war fest auf „postbuch“ verdrahtet; er ist jetzt editierbar und mit dem tatsächlich eingerichteten Ordner vorbelegt
- Die DuckDNS-Anleitung im Installer führt jetzt Schritt für Schritt durch die DuckDNS-Weboberfläche und zeigt die LAN-Adresse des Servers deutlicher an

## 2.8.18 – 2026-08-29

- Der Umzug auf eine zweite Ablage startet jetzt über einen großen Knopf direkt in der Karte der zweiten Ablage statt über einen kleinen Aufklapp-Pfeil weiter unten
- Die Umzugskarte erkennt eine frisch verbundene zweite Ablage sofort und meldet nicht länger „keine zweite Ablage verbunden“, bis die Seite neu geladen wurde
- Beim Umzug zurück nach OneDrive wurde für die Freigabe fälschlich der WebDAV-Speicher geprüft; maßgeblich ist jetzt die tatsächliche Zielablage
- Ein laufender oder unterbrochener Umzug öffnet sich von selbst und bleibt nicht hinter der zugeklappten Karte verborgen
- Wird die anfängliche Ablage-Wahl im Einrichtungsassistenten zurückgenommen, werden auch angefangene WebDAV-Zugangsdaten entfernt; der Assistent bleibt nicht auf der falschen Ablage stehen
- Im Einrichtungsassistenten stehen OneDrive und WebDAV-Speicher gleichwertig nebeneinander, und der Backup-Schritt hebt die getroffene Entscheidung hervor

## 2.8.17 – 2026-08-29

- Nach einer Clean-Neuinstallation zeigt der Installer wieder die eingerichtete Domain an und nicht nur die lokalen Adressen
- Der Link zum Einspielen eines Backups wird zusätzlich über die eingerichtete Domain angezeigt
- Der Installer legt sich als install.sh ins Installationsverzeichnis; Deinstallation, Rollback, Adminpasswort und Stack-Steuerung laufen damit ohne Internetzugang

## 2.8.16 – 2026-08-29

- Der Einrichtungsassistent springt nach dem ersten Abschluss nicht mehr zum Anfang zurück; auch Überspringen und „Trotzdem ansehen“ verlassen ihn zuverlässig

## 2.8.15 – 2026-08-29

- Nach dem Speichern des Embedding-Modells bleiben die KI-Stufen des Einrichtungsassistenten entsperrt, weil der Provider sofort neu geprüft wird
- Das Verbinden von OneDrive aktiviert nicht mehr ungefragt das automatische Backup; die Entscheidung fällt ausschließlich im Backup-Schritt
- Ein bereits aktives, aber nie bewusst bestätigtes Backup gilt im offenen Assistenten nicht mehr als erledigte Entscheidung
- Die Importhilfe beschreibt für Android genauer, wie eine geteilte PDF mit der Cloud-App in den Eingangsordner gelegt wird

## 2.8.14 – 2026-08-28

- Das erste Dokument einer neu eingerichteten Instanz bekommt jetzt die Postnummer P000001; bisher begann die Zählung bei P000002
- Der Einrichtungsassistent erkennt eine verbundene Ablage sofort: die Statuszeile blieb bisher rot, obwohl die Karte darunter schon „Verbunden als …“ meldete
- Das Embedding-Modell lässt sich bei der Ersteinrichtung wieder auswählen und übernehmen; ohne gespeicherte Wahl blieb das Modellfeld leer und „Übernehmen“ scheiterte
- „Modellempfehlungen alle übernehmen“ aktualisiert die Embedding-Karte und die Statuszeilen des Assistenten sofort, ohne dass die KI erneut getestet werden muss
- Beim Umschalten des Scannerprofils sagt der Assistent, dass die Arbeit im Hintergrund läuft und man nicht warten muss
- Vor dem ersten Anlegen der Ordnerstruktur steht dort „Die Ordnerstruktur ist noch nicht angelegt“ statt „0 von 21 Ablage-Zuordnungen sind konfiguriert“
- Die Statuszeilen eines Schritts stehen in derselben Reihenfolge wie die Abschnitte darunter
- Die Azure-Anleitung sagt deutlicher, dass die Client-ID aus einer eigenen App-Registrierung stammt

## 2.8.13 – 2026-08-28

- Der Einrichtungsassistent lässt sich wieder benutzen: seit 2.8.12 blieb die Seite beim Weiterklicken vom Willkommensschritt zu jedem weiteren Schritt weiß
- Gesperrte Stufen im KI-Schritt zeichnen nun tatsächlich keine Trennlinie mehr unter die Überschrift

## 2.8.12 – 2026-08-28

- Datenbanksicherungen enthalten den jederzeit neu aufbaubaren semantischen Hilfekorpus nicht mehr; nach einer Wiederherstellung wird er beim App-Start automatisch neu erzeugt
- Selbst ausgelöste Sicherungen liegen jetzt im Unterordner „_backup/user“, werden nie automatisch gelöscht und sind in der Backup-Liste als „Von Hand“ gekennzeichnet
- „Jetzt sichern“ zeigt den Fortschritt der Sicherung an und nennt am Ende den Dateinamen, statt nur den Start zu melden
- Vor jedem Wiederherstellen über die Oberfläche wird der aktuelle Stand zwingend gesichert; erst danach gibt postbuch.net den Restore frei
- Schlägt diese Sicherung fehl, ist ein Wiederherstellen nur nach ausdrücklicher Warnung möglich, dass der aktuelle Stand unwiederbringlich verloren geht
- Neue Seite „Importiere dein erstes Dokument“ zeigt alle sechs Eingangswege mit den echten Ordnerpfaden und dem Abrufintervall; sie erscheint nach der Einrichtung und ist beim Importieren verlinkt
- Das Handbuchkapitel zum Importieren beschreibt jetzt alle sechs Wege und begründet, warum nur PDF und Papier angenommen werden
- Der Backup-Schritt der Einrichtung nennt den Zielordner der Sicherung und erklärt, dass die Datenbank gesichert wird, die Dokumente aber in der Ablage bleiben
- MagentaCLOUD lässt sich unter „Eigene Nextcloud / WebDAV“ mit einem Klick als Ablage vorbelegen
- Ein in der Netzsuche ausgewählter Scanner wird sofort gespeichert und getestet, ohne zusätzlichen Klick
- Die Werkseinstellung der Sprachmodelle entspricht nicht mehr den Modellempfehlungen; „Modellempfehlungen alle übernehmen“ richtet damit auch das Embedding-Modell mit ein, solange keines gewählt ist
- Für das Embedding-Modell gibt es keine Vorbelegung mehr; bestehende Instanzen behalten ihr bisher benutztes Modell samt vorhandener Vektoren
- Die Karte „Modellempfehlungen“ kommt ohne den doppelten Erklärkasten aus
- Der Einrichtungsassistent nennt die Herkunft der DuckDNS-Domain wieder richtig und behauptet bei einer Neuinstallation keine Ableitung mehr
- Gesperrte Stufen im KI-Schritt zeichnen keine Trennlinie mehr unter die Überschrift

## 2.8.11 – 2026-08-27

- Behebt bei einem eigenen WebDAV-Speicher den Fehler „Pfadprüfung: Ziel liegt außerhalb des konfigurierten Ablage-Ordners“, an dem jeder Download scheiterte
- Der Ablageordner wird nur noch an einer Stelle festgelegt – beim Anlegen der Ordnerstruktur. Die Verbindungskarte zeigt ihn an, statt einen abweichenden Namen vorzuschlagen
- Beim Start gleicht postbuch.net den gespeicherten Ablageordner mit dem tatsächlich benutzten ab und korrigiert ihn, wenn beide auseinanderlaufen

## 2.8.10 – 2026-08-27

- Der Instanz-Schritt des Assistenten zeigt die vom Installer gesetzten Werte nur noch an; geändert wird erst nach Klick auf „Ändern“, ein hinterlegtes DuckDNS-Token wird als vorhanden ausgewiesen
- Eine versehentlich gewählte Ablage lässt sich im Assistenten wieder zurücknehmen, solange nichts verbunden, kein Ordner angelegt und kein Dokument abgelegt ist
- Der KI-Schritt baut sich stufenweise auf: erst der Provider, dann Modellempfehlungen und Aufgabenzuordnung, zuletzt das Embedding-Modell
- Sprachmodell und Embedding sind getrennte Pflichtprüfungen mit eigenen Hinweisen; alle zehn Aufgaben müssen einem nutzbaren Modell zugeordnet sein
- Die Werkseinstellung für jedes Modell stammt jetzt aus den mitgelieferten Modellempfehlungen statt aus fest verdrahteten alten Modellnamen
- „Modellempfehlungen alle übernehmen“ steht hervorgehoben am Anfang der Karte, die Erklärungen darunter sind zu einem Block zusammengefasst
- Jede Änderung an einem KI-Provider aktualisiert die davon abhängigen Karten sofort
- Die Scannersuche startet erst auf Klick statt von selbst; ein bestandener Scannertest schaltet das Scannerprofil automatisch ein
- Das Scannerprofil lässt sich nur noch in den Einstellungen abschalten, und nur nach ausdrücklicher Rückfrage
- Im Abschluss-Schritt führt jede Statuszeile in den zuständigen Schritt; „Weiter“ stößt die Prüfung samt KI-Test selbst an
- Das Dashboard meldet eine fehlende Ablage für das tatsächlich verwendete Backend, statt immer OneDrive zu nennen
- Der automatische Abruf aus dem Eingangsordner läuft jetzt auch nach einer Erstinstallation und mit Nextcloud

## 2.8.9 – 2026-08-26

- Die Ersteinrichtung findet jetzt weitgehend im Web-Assistenten statt; der Installer fragt nur noch Werte ab, die vor dem ersten Start auf dem Host feststehen müssen
- OneDrive verwendet bei neuen Instanzen standardmäßig den Gerätecode mit eigener Azure-App ohne Client-Secret; bestehende Verbindungen bleiben unverändert
- Ordneranlage, Dokumentumzug und Ablage-Selbsttest zeigen ihren Fortschritt an, statt bei längeren Vorgängen scheinbar stehenzubleiben
- Der Assistent prüft nun alle benötigten Pipeline-Modelle und das Embedding-Modell und bietet die manuelle Modellwahl direkt im KI-Schritt an
- Offene Pflichtschritte halten die normale Oberfläche zurück; Admins können sie für die laufende Sitzung bewusst trotzdem ansehen
- Beim bisherigen OneDrive-Weg mit Client-Secret werden Ablaufdatum und typische Secret-Fehler sichtbar; eine optionale Erinnerung warnt 60 Tage vorher

## 2.8.8 – 2026-08-26

- Der Einrichtungsassistent weist darauf hin, wenn Basisadresse und DuckDNS-Domain auseinanderlaufen, und bietet an, das jeweils andere Feld zu übernehmen
- Eine im Assistenten eingetragene, aber noch nicht angewendete Basisadresse ist als solche gekennzeichnet, samt Angabe, welcher Knopf sie wohin schreibt
- Die Anwenderhilfe erklärt den Umzug einer laufenden Instanz auf eine andere Adresse: Reihenfolge der Schritte, Redirect-URI in Azure und Neuinstallation der App auf den Geräten

## 2.8.7 – 2026-08-26

- Der Einrichtungsassistent verlangt den Ablage-Selbsttest jetzt im Schritt „Ordner“, in dem er sich auch auslösen lässt; Schritt „Ablage“ prüft nur noch die Verbindung
- Nach einem eingespielten Backup prüft der Assistent die KI-Provider beim Öffnen selbst nach und meldet eine längst arbeitende Instanz nicht mehr als unvollständig
- Die Modellempfehlungen enthalten jetzt auch ein Embedding-Modell (OpenAI text-embedding-3-large). Es wird nur einzeln und nach ausdrücklicher Bestätigung übernommen, nie über „Alle übernehmen“

## 2.8.6 – 2026-08-26

- Datenbank-Sicherungen werden langfristig gestaffelt aufbewahrt: zunächst vollständig, später wöchentlich, monatlich und dauerhaft halbjährlich

## 2.8.5 – 2026-08-26

- Vorübergehende DNS-, Netzwerk- und Docker-Hub-Fehler brechen Installation und Update nicht mehr sofort ab, sondern werden automatisch erneut versucht

## 2.8.4 – 2026-08-26

- Der Einrichtungsassistent führt jetzt vollständig durch Betrieb, Ablage, KI, Scanner und Sicherheit und übernimmt vorhandene Werte direkt aus der Instanz
- Ein geänderter Ablage-Wurzelordner wird nicht mehr still übernommen: Vor dem Umzug des gesamten Dokumentenbestands ist eine ausdrückliche Bestätigung nötig
- Der Büroassistent kann jetzt die mitgelieferte Anwenderhilfe durchsuchen und verwendete Hilfeabschnitte als direkt anklickbare Quellen anzeigen
- Ersetzte Arzt-, Handwerker- und allgemeine Rechnungen lassen sich kontrolliert invalidieren und als Korrespondenz neu verarbeiten
- Archivierte Rechnungen bleiben in Steuer- und Abrechnungsauswertungen enthalten und werden dort sichtbar als archiviert gekennzeichnet
- PWA- und Browser-Push sind jetzt der empfohlene Benachrichtigungsweg; Discord ist als experimentell gekennzeichnet und verlangt eine Risikobestätigung
- Beim Löschen wird jetzt korrekt erklärt, dass Dateien im eigenen Ordner „_trash“ der Ablage landen und dort nicht automatisch entfernt werden

## 2.8.3 – 2026-08-25

- Der Lohnanteil einer Handwerkerrechnung wird jetzt korrekt ermittelt: alles außer Material zählt mit, also auch Anfahrt, Maschinen- und Gerätekosten
- Der Lohnanteil wird jetzt als Bruttobetrag inklusive Mehrwertsteuer ausgewiesen – das ist der Wert, der in der Steuererklärung nach § 35a EStG zählt
- Weist eine Rechnung den Lohnanteil selbst aus, wird dieser unverändert übernommen; ist er nicht ermittelbar, bleibt das Feld leer statt 0,00 €
- Die Anwenderdokumentation erklärt jetzt, wie der Lohnanteil zustande kommt

## 2.8.2 – 2026-08-25

- Neu: eine vollständige Anwenderdokumentation direkt in der App unter „Hilfe" – sie liegt auf der eigenen Instanz und ist auch ohne Internet lesbar
- Die Seitenleiste hat einen festen Fußbereich mit Hilfe, Einstellungen und Abmelden; eingeklappt stehen die Symbole jetzt sauber mittig
- Im Dokumentkopf öffnet ein Wolkensymbol neben der Postnummer die Originaldatei in der Ablage; der frühere OneDrive-Link weiter unten entfällt
- Die Angaben im Dokumentkopf sind jetzt gruppiert, und aus „Confidence" wird „QdE" (Qualität der Extraktion)
- „? Verbleib" heißt jetzt „? Original" – gemeint war immer der Verbleib des Papieroriginals
- Beim Verbinden von OneDrive wird jetzt klar gewarnt, dass postbuch.net Vollzugriff auf das gesamte Laufwerk erhält, nicht nur auf den postbuch-Ordner
- Derselbe Hinweis steht jetzt auch im Installer und präziser in der Backup-Warnung, weil das Zugangs-Token im Klartext in jeder Sicherung liegt

## 2.8.1 – 2026-08-19

- Der Chat-Assistent antwortet jetzt laufend statt am Stück und braucht dadurch spürbar weniger Zeit bis zur ersten sichtbaren Antwort
- Das interne Nachdenken des Assistenten wird jetzt sichtbar mitverfolgt und automatisch eingeklappt, sobald die eigentliche Antwort beginnt
- Die Dokumentensuche im Assistenten liefert schlankere Ergebnisse und lädt Details erst bei Bedarf nach, was Anfragen günstiger macht
- Volltext-Abrufe können jetzt gezielt nach einer Frage filtern, statt bei langen Dokumenten nur den Anfang zu liefern
- Reasoning-fähige OpenAI-kompatible Modelle (z.B. GPT-5) lernen ihre unterstützte Denktiefe jetzt einmalig und merken sie sich dauerhaft, statt bei jedem Neustart erneut zu raten

## 2.8.0 – 2026-08-19

- Das Datenbankschema wurde grundlegend aufgeräumt: die Beschreibung des aktuellen Stands ist von den historischen Umbauschritten getrennt, ohne dass sich an den Daten etwas ändert
- Upgrades von älteren Versionen laufen weiterhin ohne Zutun; ältere Umbauschritte werden automatisch und genau einmal nachgeholt und dabei nachvollziehbar protokolliert
- Der Installer kann den Stack jetzt direkt starten, neu starten, stoppen und den Autostart umschalten
- Lange Updates verlieren die Administratorrechte nicht mehr mitten im Lauf

## 2.7.2 – 2026-08-18

- Interne Aufräumarbeiten nach Abschluss der Umstellung auf Lebensbereich/Dokumentart: nicht mehr benötigter Migrationscode entfernt, keine sichtbaren Änderungen

## 2.7.1 – 2026-08-18

- Die Personenverwaltung nennt das Namensfeld jetzt korrekt "Vollname" statt "Anzeigename"
- Die Menschen/Tiere-Auswahl bei Abrechnungsperioden nutzt jetzt das einheitliche Tab-Design der App
- Der fachliche Abgleich eines Erstattungsbescheids erscheint jetzt als eigener Eintrag in der Aufgabenleiste, solange er noch läuft
- Ein frisch eingegangener Erstattungsbescheid zeigt einen Ladehinweis, solange der Abgleich mit den eingereichten Rechnungen noch läuft
- Die KI-Auswertung von Erstattungsbescheiden und die Dokumentklassifikation kennen jetzt den erwarteten Beihilfe-/PKV-Satz je Person und erkennen dadurch seltener fälschlich Kürzungen

## 2.7.0 – 2026-08-16

- Die KI-Klassifikation von Dokumenten wurde neu strukturiert: zuverlässigere Zuordnung zu Lebensbereich und Dokumentart, speziell bei einfacheren KI-Modellen
- Der "Typ" in der Arztrechnungs-Detailansicht zeigt jetzt immer eine lesbare Bezeichnung statt eines internen Codes, auch bei älteren Dokumenten
- Der Filter "L×D-Bestätigung offen" wurde entfernt, da er nicht mehr gebraucht wird
- Fehler behoben, durch den eine archivierte Markierung beim erneuten Verarbeiten eines Dokuments verloren ging
- Der Start einer Wiederverarbeitung bei einer L×D-Änderung wird jetzt zuverlässig angestoßen und in der Aufgabenleiste angezeigt, statt ohne sichtbare Rückmeldung zu bleiben
- Arztrechnungs-Detailansicht: die Überschrift zeigt jetzt den genauen Typ (z.B. "Laborrechnung", "Tier-Rezept") statt eines separaten, nicht mehr frei änderbaren "Typ"-Felds
- Fehler behoben, durch den Tier-Dokumente ohne im System als Mensch registriertes Haustier fälschlich als Humanmedizin beschriftet wurden

## 2.6.11 – 2026-08-16

- Fehler behoben, durch den die Detailansicht bei Rechnungen, Berichten und sonstigen Dokumenten ohne Arztrechnungs-Datensatz leer blieb

## 2.6.10 – 2026-08-16

- Tierarztrechnungen, Tierarztbefunde und Tier-PKV-Erstattungen werden mit denselben Detailblöcken wie medizinische Dokumente verarbeitet
- GOT-, PZN- und kennungslose Tierarztpositionen werden vollständig erfasst und für Erstattungen abgeglichen
- Abrechnungsperioden und Sammelabrechnungen trennen Menschen und Tiere zuverlässig

## 2.6.9 – 2026-08-16

- Die Einreichungsbestätigung erscheint jetzt direkt vor dem Abschluss und ist deutlich hervorgehoben

## 2.6.8 – 2026-08-16

- Der Installer bietet bei inaktivem Backup jetzt an, es direkt einzuschalten, statt nur auf die Web-Oberfläche zu verweisen

## 2.6.7 – 2026-08-16

- Der Installer-Hinweis auf ein inaktives Backup erscheint jetzt bei jedem interaktiven Update-Lauf, auch wenn dieselbe Version erneut installiert oder die Neuinstallation abgelehnt wird

## 2.6.6 – 2026-08-16

- Deutlicher Warnhinweis oben auf dem Dashboard, solange kein automatisches Backup aktiv ist
- Vor einem Update wird bei fehlendem Backup ausdrücklich nachgefragt, mit der Möglichkeit, es direkt zu aktivieren
- Der Installer empfiehlt bei jedem interaktiven Lauf dringend, ein fehlendes Backup zu aktivieren
- KI-Statushinweise auf dem Dashboard warnen nur noch vor Anbietern, die auch tatsächlich genutzt werden, nicht mehr vor unbenutzten oder deaktivierten

## 2.6.5 – 2026-08-16

- Die Embedding-Einstellungskarte hängt sich nicht mehr fest, wenn der zuletzt genutzte Provider entfernt wurde
- Provider-Wechsel bei Embeddings übernehmen nie mehr den Modellnamen des vorherigen Providers, sodass ein Zurückwechseln keine unnötige Neuberechnung mehr auslöst

## 2.6.4 – 2026-08-15

- Die Updateanzeige bietet die bereits installierte Version nicht mehr erneut als Update an
- Die Aufforderung zum Neuladen erscheint erst nach Abschluss des tatsächlich gestarteten Updates

## 2.6.3 – 2026-08-15

- Browser speichern API-Antworten und Weiterleitungen nicht mehr über Updates oder Rollbacks hinweg

## 2.6.2 – 2026-08-14

- Automatische Updates lassen Backups und andere persistente Laufzeitdateien im Besitz des Installationsnutzers
- Der Rollback-Dialog verwechselt nicht lesbare root-eigene Sicherungen nicht mehr mit fehlenden Datenbank-Dumps
- Datenbank-Rollbacks ersetzen den neueren Datenbankstand vollständig und brechen bei jedem Importfehler atomar ab
- Rollbacks liefern auch für alte Versionen einen sicheren Push-Service-Worker aus, der Netzfehler nicht als 503 maskiert

## 2.6.1 – 2026-08-14

- Automatische Updates behalten Versionsanzeige und Bezugsquelle auf aktualisierten Instanzen zuverlässig bei
- Der Update-Dialog erkennt einen erfolgreichen Abschluss auch nach einem längeren Container-Neustart
- Die L×D-Bestandsmigration verwendet die konfigurierten Modelle über deren richtigen Provider und meldet kein nicht unterstütztes OpenAI-Abo mehr

## 2.6.0 – 2026-08-14

- Dokumente werden unabhängig nach Lebensbereich und Dokumentart eingeordnet, gefiltert und in der Ablage strukturiert
- Dashboard, Dokumentenarchiv und Detailansicht zeigen und bearbeiten die neue L×D-Einordnung mit übersichtlichen Badges
- Medizinische Rechnungen, Befunde und Erstattungsbescheide behalten ihre spezialisierten Detail- und Abrechnungsfunktionen
- Bestehende Installationen werden beim Update automatisch, wiederaufnehmbar und mit sicherer Fehlerkennzeichnung migriert
- Dateiablage, Overlay-Bedienung und die Behandlung fehlgeschlagener Dokumentimporte wurden robuster gemacht

## 2.5.0 – 2026-08-10

- Neue geführte Einrichtung für Netzwerk, Ablage, Scanner und weitere Systemfunktionen
- Personen und Benutzer werden in einer gemeinsamen Verwaltung zusammengeführt
- Scanner im lokalen Netzwerk können automatisch gefunden und eingerichtet werden
- Nextcloud-/ownCloud-Unterstützung sowie automatische Updates wurden erweitert

## 2.4.13 – 2026-08-09

- Fehler behoben: Updates aus der Oberfläche behalten Besitzer und Zugriffsrechte der Installation bei
- Fehler behoben: Logo, App-Symbole und Manifest bleiben nach Installation oder Update im Webserver lesbar

## 2.4.12 – 2026-08-09

- Jede Instanz konfiguriert ihre eigene Bezugsquelle für Updates und Modellempfehlungen; ohne Konfiguration bleibt der Abruf deaktiviert
- Der Installer übernimmt die Bezugsquelle einmalig bei bestehenden Installationen und fragt sie bei späteren Updates nicht erneut ab
- Release-Archive liegen künftig unter einem versionierten, unveränderlichen Pfad an der konfigurierten Bezugsquelle

## 2.4.11 – 2026-08-08

- Neuer optionaler OneDrive-Verbindungsweg per Gerätecode: es genügt eine eigene Client-ID, kein Client Secret und keine Redirect-URI
- Der Verbindungsweg ist in den Ablage-Einstellungen wählbar; der bisherige Weg mit eigener App bleibt Standard und unverändert

## 2.4.10 – 2026-08-02

- Der Update-Fortschritt zeigt keine Protokolle vorheriger Läufe mehr an
- Admins sehen verfügbare Updates jetzt direkt im Dashboard und gelangen mit einem Klick zu den Update-Einstellungen

## 2.4.9 – 2026-08-02

- Test-Release zur abschließenden Prüfung des Updates direkt aus der Postbuch-Oberfläche

## 2.4.8 – 2026-08-02

- Der Update-Agent wird bei jedem erfolgreichen manuellen Update automatisch mit aktualisiert
- Fehlende Rechte beim Aktualisieren des Update-Agenten werden jetzt klar angezeigt

## 2.4.7 – 2026-08-02

- Fehler behoben: Updates aus der Oberfläche starten auch ohne gesetzte Systemumgebung zuverlässig

## 2.4.6 – 2026-08-02

- Fehler behoben: GUI-Updates funktionieren auch auf Systemen mit geschütztem temporären Verzeichnis zuverlässig

## 2.4.5 – 2026-08-01

- Test-Release zur Prüfung des Updates direkt aus der Postbuch-Oberfläche

## 2.4.4 – 2026-08-01

- Fehler behoben: Updates aus der Oberfläche werden vom Update-Agenten wieder vollständig ausgeführt
- Der Update-Dialog zeigt nun verständlich, ob er noch auf den Agenten wartet oder bereits arbeitet
- Laufphasen und das Protokoll machen den Fortschritt eines Updates wieder nachvollziehbar

## 2.4.3 – 2026-08-01

- Sicherungen enthalten jetzt prüfbare Angaben zu Programm-, Datenbank- und Schema-Stand
- Die KI-Einstellungen machen kuratierte Modellempfehlungen transparenter und leichter steuerbar
- Die Unterstützung für OpenAI-Abonnements sowie der Büroassistent wurden weiter verbessert
- Installation, Update und Veröffentlichungsseite wurden robuster und verständlicher gestaltet

## 2.4.2 – 2026-08-01

- Der PDF-Viewer lädt Dokumente wieder zuverlässig direkt im Browser
- Die OneDrive-Anbindung wurde technisch aktualisiert; bestehende Verbindungen bleiben erhalten
- Der Installer schreibt bei jeder Ausführung ein ausführliches, geschütztes Log zur Fehleranalyse
- Interne Paketabhängigkeiten wurden aktualisiert und bereinigt
- Die Prüfung von Release-Paketen bricht nun zuverlässig ab, falls eine Sicherheitsprüfung nicht ausgeführt werden kann

## 2.4.0 – 2026-08-01

- Abrechnungen führen jetzt klar durch Prüfen, externes Einreichen und den abschließenden Periodenabschluss
- PDF-Dateien für PKV und Beihilfe sind im Einreichschritt deutlich nach Kostenträger, Person und Periode gekennzeichnet
- Rechnungen können vollständig oder teilweise bestritten werden; nur der unbestrittene Rest bleibt fällig
- Die Erstellung großer Abrechnungs-PDFs zeigt korrekten Fortschritt und verständlichere Fehlerhinweise

## 2.3.3 – 2026-08-01

- Der geführte Installer bietet die Einrichtung von Updates aus der Web-Oberfläche jetzt auch bei Aufruf über `curl | bash` an

## 2.3.2 – 2026-08-01

- Updates sind robuster bei kurzzeitig nicht erreichbaren Paketquellen; spätere Update-Abbrüche vor dem Containerwechsel stellen den alten Quellcode automatisch wieder her

## 2.3.1 – 2026-08-01

- Fehler behoben: Der geführte Installer startet wieder zuverlässig ohne zusätzliche Optionen

## 2.3.0 – 2026-07-31

- Updates werden jetzt kryptografisch signiert und beim Installieren geprüft
- Der Schutz greift schonend: erst wenn einmal eine gültige Signatur geprüft wurde, sind unsignierte Updates gesperrt
- Ein Rückschritt auf eine ältere Version wird nicht mehr angeboten
- Die Einstellungen zeigen an, ob Updates auf diesem System signaturgeprüft werden

## 2.2.0 – 2026-07-31

- Update-Anzeige im GUI: Postbuch meldet, wenn eine neue Version vorliegt, und zeigt die Änderungen
- Updates lassen sich per Klick auslösen, sofern auf dem Server ein Update-Agent eingerichtet ist
- Kuratierte Modellempfehlungen je Modellklasse, inklusive Preisangaben – freiwillig und abschaltbar
- Empfehlungen wahlweise automatisch übernehmen, mit gesichertem Rückweg
- Cloudfrei-Check zeigt beide neuen Verbindungen einzeln an
- Installer ohne Zugangspasswort: die Veröffentlichung braucht keine Schranke mehr
- Postbuch steht jetzt unter der AGPL-3.0 und darf frei genutzt, geändert und weitergegeben werden
- Interne Fehlerbehebungen und Aufräumarbeiten

## 2.1.2 – 2026-07-28

- Kompatibilität mit OpenAI-Abo verbessert
- Dauerhafte Fehler brechen die Wiederholungsschleife jetzt sofort ab
- Titelvergabe im Büroassistenten robuster

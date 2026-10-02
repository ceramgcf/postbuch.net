# Zu postbuch.net beitragen

Danke, dass du postbuch.net verbessern möchtest. Dieses Repository zeigt bewusst
nur stabile, öffentlich freigegebene Quellstände. Die vollständige Entwicklung
findet in einem privaten Haupt-Repository statt. Öffentliche Beiträge werden
dort geprüft und übernommen und erscheinen anschließend mit einem stabilen
Release wieder hier.

## Der Ablauf in einfachen Worten

1. Klicke auf GitHub auf **Fork**. Damit erhältst du eine eigene Kopie des
   öffentlichen Repositories.
2. Erstelle in deinem Fork einen neuen Branch, zum Beispiel
   `fix/falsches-datum` oder `feature/besserer-export`.
3. Nimm deine Änderung vor und erstelle einen oder mehrere verständliche
   Commits.
4. Prüfe die Änderung und notiere, wie du sie getestet hast.
5. Öffne einen Pull Request gegen `main` dieses Repositories.

Ein Pull Request ist zunächst nur ein Vorschlag. Er kann besprochen,
überarbeitet, angenommen oder abgelehnt werden. Er gewährt keinen Zugriff auf
private Entwicklungsdaten oder betriebene postbuch.net-Instanzen.

## Was in einen guten Pull Request gehört

- eine kurze Beschreibung des Problems;
- die Begründung für die gewählte Lösung;
- eine möglichst kleine, zusammenhängende Änderung;
- die ausgeführten Tests und deren Ergebnis;
- Screenshots bei sichtbaren Änderungen;
- ein Hinweis auf mögliche Auswirkungen für Updates oder bestehende Daten.

Bitte vermische keine unabhängigen Umbauten mit einer Fehlerkorrektur. Größere
Ideen sollten zuerst als Feature-Issue besprochen werden.

## Datenschutz und Secrets

postbuch.net verarbeitet potenziell sehr persönliche Dokumente. Veröffentliche
deshalb niemals:

- echte Briefe, Rechnungen, Bescheide oder Scans;
- Namen, Adressen, Versicherungs- oder Aktenzeichen realer Personen;
- `.env`-Dateien, Datenbank-Dumps oder Backups;
- Passwörter, API-Schlüssel, OAuth-Daten, Tokens oder Webhook-URLs;
- Logs oder Screenshots, bevor sie vollständig anonymisiert wurden.

Nutze für reproduzierbare Beispiele ausschließlich künstliche Daten. Ein
Secret, das einmal in einem Commit oder Issue stand, muss beim jeweiligen
Anbieter gesperrt beziehungsweise rotiert werden; bloßes Löschen genügt nicht.

## Sicherheitslücken

Sicherheitslücken gehören **nicht** in ein öffentliches Issue. Verwende die in
`SECURITY.md` beschriebene private Meldung über GitHubs
**Report a vulnerability**. So bleibt Zeit für eine koordinierte Korrektur,
bevor Details öffentlich werden.

## Tests und technische Leitplanken

- Beschreibe jeden tatsächlich ausgeführten Test. „Nicht getestet“ ist eine
  zulässige Angabe, aber kein erfolgreiches Testergebnis.
- Produktionsdaten dürfen niemals als Testmaterial dienen.
- Änderungen an Installation, Updates, Datenbank oder Authentifizierung
  brauchen eine nachvollziehbare Rückwärtskompatibilitäts- und
  Sicherheitsbetrachtung.
- Bereits veröffentlichte Versionsarchive werden niemals neu gebaut oder
  ersetzt.
- Die Domänensprache in Anwendung und Code ist überwiegend Deutsch und soll
  konsistent bleiben.

## Was nach dem Pull Request passiert

Angenommene Änderungen werden unter Erhalt der Autorenschaft in das private
Haupt-Repository übernommen und dort gegen den aktuellen Entwicklungsstand
geprüft. Der öffentliche Pull Request kann deshalb bis zum nächsten stabilen
Release offen bleiben. Wurde die Lösung intern wesentlich angepasst, wird das
transparent im Pull Request erklärt und die Mitwirkung in den Release-Notizen
genannt.

## Lizenz der Beiträge

Das Projekt steht unter der **GNU Affero General Public License v3.0
(AGPL-3.0)**. Mit dem Einreichen eines Beitrags bestätigst du,

1. dass du den Beitrag selbst erstellt hast oder ihn rechtmäßig einreichen
   darfst, und
2. dass dein Beitrag unter derselben AGPL-3.0-Lizenz veröffentlicht werden
   darf wie das übrige Projekt.

Es wird mit dieser Regel keine zusätzliche Rechteübertragung und keine
pauschale Erlaubnis zur späteren proprietären Umlizenzierung verlangt.

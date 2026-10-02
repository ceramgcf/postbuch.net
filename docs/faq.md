# FAQ

Fragen, die immer wieder kommen – kurz beantwortet, mit Verweis auf das
Kapitel, das ins Detail geht.

## Betrieb

**Was ist der einfachste Weg, postbuch.net zu betreiben?**
Ein Raspberry Pi mit mindestens 2 GB RAM, ein Konto bei einem KI-Anbieter mit
etwas Guthaben, und eine Dateiablage (OneDrive oder ein eigener WebDAV-Speicher).
Der Installer richtet den Rest ein, der Einrichtungsassistent führt danach
durch KI-Zugang und Dateiablage. Siehe [Voraussetzungen](voraussetzungen.md) und
[Installation](installation.md).

**Muss es ein Raspberry Pi sein?**
Nein. Jeder Linux-Rechner mit Docker genügt – NAS, Mini-PC, virtuelle
Maschine. `arm64` und `amd64` werden unterstützt. Der Pi ist nur die
günstigste Empfehlung, auf die die Anleitung zugeschnitten ist.

**Brauche ich Programmierkenntnisse?**
Nein, aber etwas Terminal-Grundwissen: per SSH auf den Server verbinden, einen
Befehl einfügen, gelegentlich `docker compose ps` tippen. Die Installation ist
geführt, sie bleibt aber eine Installation.

**Muss der Server durchlaufen?**
Praktisch ja. Überwachter Ordner, Backup, Fristen-Erinnerungen und die
Erneuerung des Dateiablage-Tokens sind zeitgesteuerte Hintergrundjobs. Ein
zeitweise abgeschalteter Server verliert nichts, holt aber Verpasstes nicht
vollständig nach.

**Kann ich postbuch.net aus dem Internet erreichbar machen?**
Möglich ist es, empfohlen ist es nicht. Die Anwendung gehört ins eigene Netz
oder hinter ein VPN. Wer sie trotzdem veröffentlicht, braucht zwingend HTTPS
(dafür gibt es das Caddy-Profil) und ein starkes Admin-Passwort. Siehe
[Sicherheit](sicherheit.md).

**Warum funktioniert meine DuckDNS-Subdomain in meinem Netzwerk nicht?**
Über die reine IP-Adresse geht es, über den Hostnamen (z. B.
`deinname.duckdns.org`) nicht – das ist meist **DNS-Rebind-Schutz**. Der
Router lehnt es ab, einen öffentlichen Domainnamen zu einer privaten IP-Adresse
aufzulösen, weil genau dieses Muster (öffentlicher Name → privates Ziel) auch
bei einem Angriff auftritt. Für den eigenen DuckDNS-Namen ist das aber
gewollt, deshalb braucht der Router dafür eine Ausnahme. Bei einer Fritz!Box:
`http://fritz.box` → **Heimnetz → Netzwerk → Netzwerkeinstellungen** →
DNS-Rebind-Schutz-Ausnahme für die eigene Domain eintragen. Andere Router
nennen die Einstellung ähnlich (oft „DNS Rebind Protection" oder „NAT
Reflection"). Ohne diese Ausnahme bleibt der direkte IP-Zugriff im eigenen
Netz als Ausweichmöglichkeit, HTTPS mit gültigem Zertifikat funktioniert dann
aber nur über den Hostnamen – das betrifft auch [Push-Benachrichtigungen](benachrichtigungen.md#browser-push).

## Kosten

**Ist das wirklich kostenlos?**
Die Software ja – quelloffen unter der AGPL-3.0, kein Konto, kein Abo, keine
kostenpflichtige Variante. Kosten entstehen bei den externen Diensten, die du
dazuschaltest: dem KI-Anbieter und gegebenenfalls dem Cloud-Speicher.

**Wie viel kostet die KI im Monat?**
Das hängt am Volumen und am gewählten Modell. Ein Dokumentimport liegt grob bei
**1–20 Eurocent**, eine Assistentenantwort häufig bei **1–15 Eurocent**; lange
Dokumente, teure Modelle, Fallbacks und PDF-Vision können darüber liegen.
Embeddings sind einzeln meist viel billiger, können sich bei einer vollständigen
Neuberechnung aber summieren. Die genaue Liste aller Auslöser und Beispiele
steht unter [KI-Anbieter → Kosten und kostenpflichtige Aufrufe](ki-provider.md#kosten-und-kostenpflichtige-aufrufe).

Die eigene Messung steht unter ![Logs-Symbol](icons/scroll-text.svg) **Logs → Token-Kosten**. Fehlt dort für ein
Modell der Preis oder meldet der Provider keine Token, ist die angezeigte Summe
unvollständig; endgültig maßgeblich ist die Abrechnung des KI-Anbieters.

**Kann ich die Kosten senken?**
Ja, an drei Stellen: eine günstigere Modellstufe für einfache Dokumente, der
Cache-Mode beim Massenimport, und ein selbst betriebenes Modell. Alle drei
sind in [KI-Anbieter](ki-provider.md) beschrieben.

## Daten und Datenschutz

**Bekommt der KI-Anbieter meine Post zu sehen?**
Wenn du ein Cloud-Modell nutzt: ja. Damit ein Brief eingeordnet werden kann,
muss er gelesen werden – dafür wird er an den Anbieter übertragen, den du
ausgewählt hast. Auch die Arztrechnung, der Kontoauszug, das Anwaltsschreiben.
Was dort damit geschieht, regeln dessen Datenschutzbestimmungen.

Nicht übertragen werden: deine Datenbank, deine Fristen, die Suche, das ganze
Drumherum. Und es geht immer nur das gerade bearbeitete Dokument hinaus, nicht
der Bestand am Stück. Die Ausnahme ist der Chat, der zu einer Frage die
passenden Belege dazulädt.

**Und wenn ich das nicht will?**
Dann betreibst du das Modell selbst. postbuch.net spricht mit jedem
OpenAI-kompatiblen Endpunkt, auch im eigenen Netz; zusammen mit einem eigenen
WebDAV-Speicher verlässt dann kein Dokument das Haus. Das kostet
Erkennungsqualität und braucht passende Hardware. Der ![Cloudfrei-Symbol](icons/shield-check.svg) **Cloudfrei-Check** in
den Einstellungen prüft, ob wirklich nichts mehr nach draußen geht.

**Geht es ganz ohne KI?**
Nein. Die Klassifikation ist der Kern der Anwendung – ohne erreichbares Modell
scheitert die Verarbeitung eines Dokuments. Was du danach an den Ergebnissen
änderst, bleibt selbstverständlich dir überlassen.

**Nimmt postbuch.net von sich aus Verbindung nach draußen auf?**
Ja, abhängig von deiner Konfiguration: für die Dokumentverarbeitung und
Embeddings zum gewählten KI-Anbieter, für den Zugriff auf die gewählte Dateiablage,
für aktivierte Push- oder Discord-Benachrichtigungen, für DuckDNS sowie für die
tägliche Abfrage des Release-Manifests bei der eingetragenen Bezugsquelle.
Telemetrie und Nutzungsstatistiken werden nicht übertragen.

**Wo liegen meine PDFs?**
In deiner Dateiablage, in normalen Ordnern mit sprechenden Dateinamen – dauerhaft
nicht in der Datenbank und nicht in einem eigenen Format (eine begrenzte,
regenerierbare Zwischenkopie kürzlich geöffneter PDFs kann kurzzeitig dort
liegen). Siehe [Dateiablage-Backends](storage-backends.md).

**Warum will postbuch.net Zugriff auf mein ganzes OneDrive?**
Weil genau das die Voraussetzung dafür ist, dass die Antwort auf die vorige
Frage stimmt. Die Berechtigung `Files.ReadWrite.All` erlaubt Zugriff auf alle
Ordner des Kontos; die engere Alternative wäre ein abgeschotteter App-Ordner,
in dem deine Dokumente ohne postbuch.net nicht mehr sinnvoll zugänglich wären.
Die Kehrseite: Das Token liegt unverschlüsselt in der Datenbank und in jedem
Backup – wer Server, Datenbank oder Backup-Datei hat, hat dein komplettes
OneDrive. Wer das nicht möchte, nimmt ein separates Microsoft-Konto nur für
postbuch.net oder einen eigenen WebDAV-Speicher. Einzelheiten:
[Sicherheit](sicherheit.md#der-zugriff-auf-die-dateiablage-ist-ein-vollzugriff).

**Was passiert, wenn das OneDrive-Client-Secret abläuft?**
Neue Instanzen verwenden standardmäßig den Gerätecode und haben gar kein
Secret. Beim Legacy-Weg erkennt postbuch.net ein abgelaufenes Secret gesondert;
du erzeugst in Azure ein neues, trägst Wert und Ablaufdatum in den
![Einstellungen-Symbol](icons/settings.svg) Dateiablage-Einstellungen ein und verbindest einmal neu. Details:
[OneDrive-App registrieren](onedrive-app-registrierung.md).

## Benutzung

**Können mehrere Personen die Instanz benutzen?**
Ja. Es gibt genau einen Administrator pro Instanz; weitere Zugänge werden in
der Oberfläche angelegt, mit Voll- oder Lesezugriff. Personen ohne eigenen
Zugang können trotzdem als Betroffene an Dokumenten hängen – für Kinder oder
Angehörige ist das der Normalfall. Siehe [Sicherheit](sicherheit.md).

**Sehen alle Nutzer alle Dokumente?**
Nicht zwingend. Ein Lesezugriff lässt sich auf die eigenen Dokumente
beschränken – etwa für Kinder, die nur ihre eigene Post sehen sollen. Wer
Vollzugriff hat, sieht dagegen immer den gesamten Bestand. Siehe
[Lesezugriff auf die eigenen Dokumente beschränken](sicherheit.md#lesezugriff-auf-die-eigenen-dokumente-beschränken).

**Gibt es eine App für iOS oder Android?**
Nein, und es braucht auch keine: Die Weboberfläche lässt sich als PWA
installieren und verhält sich danach wie eine App, inklusive
Push-Benachrichtigungen. Erprobt ist das unter Android und Windows; auf iPhone
und iPad ist es mangels Testgerät ungeprüft. Installationsweg je Plattform:
[Mobil und PWA](mobil-und-pwa.md#als-app-installieren-pwa).

**Muss ich mein Papier wegwerfen?**
Nein. postbuch.net hält im Gegenteil fest, wo das Original geblieben ist, und
druckt auf Wunsch ein Etikett für den Ordner. Der Vorschlag ist, alle
Originale chronologisch in *einen* Ordner zu legen statt in ein Rubrikensystem
– gesucht wird ohnehin digital. Siehe
[Akten, Verbleib und Wiedervorlagen](akten-und-organisation.md) und
[Etiketten drucken](etiketten-drucken.md).

**Kann ich meine Dokumente wieder herausbekommen?**
Ja, auf mehreren Wegen: als Akte gebündelt für Dritte, als Tabelle für die
Auswertung, oder als vollständiges Paket, das eine andere postbuch.net-Instanz
wieder einlesen kann. Siehe [Export und Import](export-import.md).

**Kann ich postbuch.net von einem anderen Programm aus benutzen?**
Ja, über den eingebauten MCP-Server. Damit greifen Claude, ChatGPT und andere
Werkzeuge lesend auf den Bestand zu, mit einem widerrufbaren Token. Siehe
[MCP-Zugriff](mcp.md).

## Auf lange Sicht

**Was ist, wenn ich aufhöre?**
Dann bleiben deine Dokumente, wo sie sind: in deinem eigenen Speicher, als
PDF, in lesbaren Ordnern. Du löschst die Container und hast weiterhin alles.

**Was, wenn das Projekt nicht weiterentwickelt wird?**
Am Bestand ändert das nichts – die Originale sind offene PDFs, die Metadaten
liegen in einer gewöhnlichen PostgreSQL-Datenbank. Der Code ist quelloffen;
wer will, entwickelt weiter.

**Wie sicher ist ein Update?**
Vor jedem Update legt der Installer eine Sicherung aus Quellbaum und
Datenbank-Dump an, und ein Rollback ist ein einzelner Befehl. Das Release
selbst wird vor dem Auspacken gegen eine Signatur geprüft. Siehe
[Betrieb und Troubleshooting](betrieb-troubleshooting.md).

**Und wenn die Festplatte stirbt?**
Dann brauchst du zwei Dinge: den Datenbank-Dump *und* die Dokumente. Der Dump
läuft automatisch, um die Dokumente musst du dich einmal selbst kümmern – das
ist der wichtigste Handgriff im ganzen Betrieb und steht in
[Backup und Wiederherstellung](backup-wiederherstellung.md).

---

Zurück zur [Kapitelübersicht](README.md)

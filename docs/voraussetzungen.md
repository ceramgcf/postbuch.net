# Voraussetzungen

## Sprache und Land

postbuch.net ist auf Deutschland zugeschnitten. Oberfläche und Dokumentation
gibt es nur auf Deutsch, und die KI wertet deine Dokumente auf Deutsch aus. Die
abrechnungsnahen Funktionen setzen deutsche Verhältnisse voraus: private
Krankenversicherung und Beihilfe, GOÄ/GOZ/GOT bei Arztrechnungen, der
Steuerabzug für Handwerkerleistungen sowie deutsche IBANs und Datumsformate.

Die allgemeine Dokumentenverwaltung – Eingang, KI-Auswertung, Dateiablage, Suche,
Akten, Fristen – funktioniert auch mit Dokumenten aus anderen Ländern. Die
Kapitel [PKV und Beihilfe](abrechnung-pkv-beihilfe.md) und die
Handwerkerfunktionen sind außerhalb Deutschlands dagegen ohne Nutzen.

## Server

- **Ein Linux-Server mit `sudo`-Rechten.** Ein Raspberry Pi mit **mindestens 2
  GB RAM** reicht für einen Privathaushalt. Getestet und betrieben wird
  postbuch.net auf einem Raspberry Pi 5 mit Raspberry Pi OS Lite Trixie.
- **Docker mit Compose-Plugin.** Auf Debian-/Ubuntu-artigen Systemen richtet der
  Installer Docker bei Bedarf selbst ein.
- **Architektur:** `arm64` und `amd64`.
- **Cloud-Speicherplatz:** Die PDFs liegen in der Cloud-Dateiablage, nicht auf dem
  Server. Lokal belegt werden im Wesentlichen die Docker-Images (rund 2 GB), die
  PostgreSQL-Datenbank (wächst mit Metadaten und Embeddings, typischerweise
  einige hundert MB) sowie kurzlebige Zwischendateien während der Verarbeitung.
- **Der Server sollte durchlaufen.** Überwachte Cloud-Ordner, Backup-Lauf,
  Fristen-Erinnerungen und Token-Erneuerung sind zeitgesteuerte Hintergrundjobs.
  Außerdem möchtest du von verschiedenen Geräten (z. B. deinem Smartphone, Tablet
  und Notebook) nahtlos auf die Anwendung zugreifen können.

> [!IMPORTANT]
>
> postbuch.net gehört ins eigene Netz oder hinter ein VPN – nicht offen ins
> Internet. Siehe [Sicherheit](sicherheit.md).

## Dateiablage: OneDrive **oder** Nextcloud

Eine funktionsfähige Dateiablage ist **Pflicht**. Ohne sie hat postbuch.net keine
Dokumentenfunktion. Genau eine Dateiablage ist zu einer Zeit aktiv; beide Wege sind
gleichwertig unterstützt, ein Wechsel ist später möglich (siehe
[Dateiablage-Backends](storage-backends.md)).

**OneDrive** Ein Microsoft-Konto plus eine eigene, kostenlose _Azure App
Registration_. Der Web-Assistent führt nach dem ersten Login durch die
Registrierung. Standard ist der Gerätecode mit `Files.ReadWrite.All`,
`User.Read` und `offline_access`; er braucht weder Secret noch Callback-URL.
Siehe [OneDrive-App registrieren](onedrive-app-registrierung.md).

> [!WARNING]
>
> `Files.ReadWrite.All` ist Vollzugriff auf **alle** Ordner dieses
> Microsoft-Kontos, nicht nur auf den postbuch-Ordner – nötig, damit die
> Dokumente im gewöhnlichen Dateibaum liegen und auch ohne postbuch.net
> erreichbar bleiben. Das Token liegt anschließend unverschlüsselt in der
> Datenbank und in jedem Backup: Wer Server, Datenbank oder Backup-Datei hat,
> hat dein komplettes OneDrive. Wer das nicht will, nimmt ein separates
> Microsoft-Konto oder eine eigene Nextcloud. Einzelheiten:
> [Sicherheit](sicherheit.md#der-zugriff-auf-die-dateiablage-ist-ein-vollzugriff).

**Nextcloud / ownCloud** Ein eigener Server oder ein kommerzieller Anbieter auf
Nextcloud-Basis (z. B. MagentaCLOUD). Hier ist in der `.env` **nichts**
einzutragen – Adresse und Anmeldung erfolgen nach dem ersten Login in der
Oberfläche über den Nextcloud-Login-Flow, der ein eigenes App-Passwort erzeugt.
Dein Nextcloud-Hauptpasswort sieht postbuch.net nie. Auch dieses App-Passwort
gilt allerdings für alle Dateien des Kontos und liegt unverschlüsselt in der
Datenbank – es lässt sich in der Cloud aber jederzeit einzeln widerrufen.

> [!TIP]
>
> Keine Lust auf eine eigene Azure-App-Registrierung? Ein Konto bei
> **MagentaCLOUD** lässt sich stattdessen mit wenigen Klicks verbinden – ein
> gewöhnliches Benutzerkonto genügt, eine App-Registrierung entfällt komplett.
> Details unter [Dateiablage-Backends](storage-backends.md#eigener-webdav-speicher).

## KI-Anbieter

Die Dokumentverarbeitung nutzt **zwei** Fähigkeiten:

| Fähigkeit          | Wofür                                        |
| ------------------ | -------------------------------------------- |
| Sprachmodell (LLM) | Dokumente lesen, Metadaten extrahieren, Chat |
| Embeddings         | semantische Suche, Duplikatprüfung           |

Beides aus einer Hand bietet z. B. OpenAI. **Anthropic bietet keine Embeddings**
– ein Anthropic-Key allein reicht nicht. Ebenfalls möglich: AWS Bedrock, jeder
OpenAI-kompatible Endpunkt und lokal gehostete Modelle über Ollama oder LM
Studio.

Details, Modellempfehlungen und der cloudfreie Betrieb stehen in
[KI-Anbieter](ki-provider.md).

> [!CAUTION]
>
> Der gewählte KI-Anbieter bekommt den vollen Inhalt deiner Dokumente zu sehen.
> Wähle bewusst.

## Netz und Domain

- **Empfohlen: eine Domain mit automatischem HTTPS.** Eine kostenlose
  DuckDNS-Subdomain reicht; alternativ eine eigene Domain mit DNS bei Cloudflare
  (DNS-01-Challenge, API-Token mit `Zone:Read` + `DNS:Edit`). Der mitgelieferte
  Caddy-Container besorgt das Zertifikat selbst.
- **Für die dauerhaft installierte PWA (d. h. die Smartphone-App) ist eine
  gleichbleibend erreichbare HTTPS-Adresse erforderlich.** Installation, Service
  Worker und Push setzen einen sicheren Browser-Kontext voraus; außerdem bleibt
  eine installierte PWA an ihre Adresse gebunden. Nach einem Adresswechsel muss
  sie neu installiert werden.
- **Beim OneDrive-Browser-Redirect** muss der Browser die exakt in Azure
  registrierte Callback-URL während der Kontoverknüpfung oder einer späteren
  Neuverknüpfung erreichen. Dafür genügen entweder eine HTTPS-Adresse oder
  `http://localhost` mit einem
  [SSH-Tunnel vom Browser-Rechner](installation.md#localhost-tunnel-von-einem-anderen-rechner).
  Beim Gerätecode entfällt die Callback-URL ganz.
- **Ports:** Die Oberfläche liegt auf `3420` (per `WEB_PORT` änderbar), Caddy
  auf `80`/`443`, der Scanner-Webhook auf `8080` (per `SCANNER_PORT`). Die
  Datenbank wird bewusst nur an `127.0.0.1:5433` gebunden und ist von außen
  nicht erreichbar.

## Optionale Hardware

**Netzwerkscanner (eSCL/AirScan)** Nahezu jeder moderne Scanner oder
Multifunktionsdrucker mit Netzwerkanschluss. Die Scanner-Anbindung läuft über
das Compose-Profil `scanner` und ist komplett optional – Uploads im Browser
funktionieren immer.

**Niimbot D110 Etikettendrucker** Der einzige unterstützte Etikettendrucker. Er
wird direkt aus dem Browser oder aus der Android-App per Web Bluetooth
angesprochen, ohne Treiber und ohne Server-Beteiligung. Siehe
[Etiketten drucken](etiketten-drucken.md).

## Browser

Die Oberfläche braucht einen aktuellen Browser. Zwei Funktionen stellen
zusätzliche Anforderungen:

| Funktion                | Anforderung                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Etikettendruck          | Web Bluetooth – Chrome, Edge oder Brave unter Android und Windows. Kein Safari, kein Firefox, kein iOS. |
| Push-Benachrichtigungen | Web Push; unter iOS erst, wenn die App als PWA auf den Homescreen gelegt wurde.                         |

Alles andere – inklusive PDF-Anzeige, Querformat-Sperre und PWA-Installation –
funktioniert plattformübergreifend. Praktisch erprobt sind **Android und
Windows**; die Nutzung auf **iPhone und iPad ist mangels Testgerät ungeprüft**
und gilt als experimentell. Der Installationsweg für jede Plattform steht in
[Mobil und PWA](mobil-und-pwa.md#als-app-installieren-pwa).

---

Weiter: [Installation](installation.md) · [Zurück zur Übersicht](README.md)

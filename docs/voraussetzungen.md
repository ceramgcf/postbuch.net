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
- **Oder ein Windows-PC:** 64 Bit, Windows 10 ab Version 2004 oder Windows 11,
  Virtualisierung im BIOS/UEFI eingeschaltet. postbuch.net läuft dort in einer
  eigenen Linux-Umgebung (WSL 2), die der
  [Installer für Windows](installation.md#unter-windows) einrichtet. Zugriff von
  anderen Geräten im Heimnetz, etwa vom Handy, gibt es erst ab Windows 11
  Version 22H2. Getestet ist Windows 11.
- **Docker mit Compose-Plugin.** Auf Debian-/Ubuntu-artigen Systemen richtet der
  Installer Docker bei Bedarf selbst ein.
- **Architektur:** `arm64` und `amd64`.
- **Speicherplatz:** Mit einer Cloud-Dateiablage liegen die PDFs in der Cloud,
  nicht auf dem Server. Lokal belegt werden im Wesentlichen die Docker-Images (rund 2 GB, mit
  den Scanner-Diensten gut 3 GB), die
  PostgreSQL-Datenbank (wächst mit Metadaten und Embeddings, typischerweise
  einige hundert MB) sowie kurzlebige Zwischendateien während der Verarbeitung.
  Bei der Betriebsart [Komplett lokal](installation.md#komplett-lokal) kommen
  die Originale selbst hinzu und für die eingebaute KI rund 10 GB für das Modell.
- **Der Server sollte durchlaufen.** Überwachte Cloud-Ordner, Backup-Lauf,
  Fristen-Erinnerungen und Token-Erneuerung sind zeitgesteuerte Hintergrundjobs.
  Außerdem möchtest du von verschiedenen Geräten (z. B. deinem Smartphone, Tablet
  und Notebook) nahtlos auf die Anwendung zugreifen können. Ein PC, der nachts
  ausgeschaltet ist oder schläft, geht auch: Während der Pause ist postbuch.net
  nicht erreichbar, danach arbeitet es Liegengebliebenes ab und holt eine
  verpasste automatische Sicherung nach.

> [!IMPORTANT]
>
> postbuch.net gehört ins eigene Netz oder hinter ein VPN – nicht offen ins
> Internet. Siehe [Sicherheit](sicherheit.md).

## Dateiablage: OneDrive, Nextcloud **oder** ein Ordner auf dem Rechner

Eine funktionsfähige Dateiablage ist **Pflicht**. Ohne sie hat postbuch.net keine
Dokumentenfunktion. Genau eine Dateiablage ist zu einer Zeit aktiv; ein Wechsel
zwischen OneDrive und Nextcloud ist später möglich (siehe
[Dateiablage-Backends](storage-backends.md)).

**Ordner auf diesem Rechner** Ohne Konto bei einem Anbieter: Die Originale liegen
als gewöhnliche PDF-Dateien in einem Ordner des Rechners, auf dem postbuch.net
läuft. Den Ordner musst du dann selbst auf ein anderes Laufwerk oder in eine
Cloud deiner Wahl sichern. Siehe
[Ordner auf diesem Rechner](storage-backends.md#ordner-auf-diesem-rechner).

**OneDrive** Ein Microsoft-Konto plus eine eigene, kostenlose _Azure App
Registration_. Der Web-Assistent führt nach dem ersten Login durch die
Registrierung. Standard ist der Gerätecode mit `Files.ReadWrite.AppFolder`,
`User.Read` und `offline_access`; er braucht weder Secret noch Callback-URL.
Siehe [OneDrive-App registrieren](onedrive-app-registrierung.md).

> [!NOTE]
>
> `Files.ReadWrite.AppFolder` beschränkt postbuch.net auf seinen eigenen
> App-Ordner unter `Apps/`. Du siehst ihn wie jeden anderen Ordner in deinem
> OneDrive. Das Token liegt in der Datenbank und in jedem verschlüsselten
> Backup. Einzelheiten:
> [Sicherheit](sicherheit.md#wie-weit-der-zugriff-auf-die-dateiablage-reicht).

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
| Embeddings         | Suche nach dem Inhalt, Duplikatprüfung       |

Für die Embeddings bringt postbuch.net einen
[eigenen Dienst](ki-provider.md#der-eingebaute-embedding-dienst) mit, der auf
dem Server selbst rechnet. Mitbringen musst du nur einen Anbieter für das
Sprachmodell, z. B. OpenAI, Anthropic, AWS Bedrock, einen OpenAI-kompatiblen
Endpunkt oder ein lokal gehostetes Modell über Ollama oder LM Studio.

Ganz ohne Cloud geht es mit der [eingebauten lokalen KI](ki-provider.md#eingebaute-lokale-ki).
Sie braucht einen PC mit **NVIDIA-Grafikkarte, am besten mit 12 GB
Grafikspeicher**. Arbeitsspeicher und Grafikspeicher müssen zusammen
**mindestens 24 GB** ergeben, sonst lässt sich die lokale KI nicht einrichten.
Unter 8 GB Grafikspeicher läuft sie extrem langsam, ohne NVIDIA-Karte nur auf
dem Prozessor und dann viele Minuten je Dokument. Für das Modell müssen rund
9 GB Platz frei sein und danach noch 5 GB übrig bleiben. Unter Windows zählt
nur der Arbeitsspeicher, den WSL bekommt, standardmäßig die Hälfte; mehr lässt
sich einstellen. Im Leerlauf entlädt sich das Modell nach 5 Minuten und gibt
seinen Speicher frei. Wie viel es während der Arbeit belegt, steht unter
[Wie viel Arbeitsspeicher die lokale KI belegt](ki-provider.md#wie-viel-arbeitsspeicher-die-lokale-ki-belegt).

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
- **Von unterwegs** greifst du über ein VPN ins Heimnetz zu, etwa per
  FRITZ!Box oder Tailscale; eine Portfreigabe für postbuch.net ist nicht
  nötig. Siehe [Zugriff von unterwegs](zugriff-von-unterwegs.md).
- **Beim OneDrive-Browser-Redirect** muss der Browser die exakt in Azure
  registrierte Callback-URL während der Kontoverknüpfung oder einer späteren
  Neuverknüpfung erreichen. Dafür genügen entweder eine HTTPS-Adresse oder
  `http://localhost` mit einem
  [SSH-Tunnel vom Browser-Rechner](installation.md#localhost-tunnel-von-einem-anderen-rechner).
  Beim Gerätecode entfällt die Callback-URL ganz.
- **Ports:** Die Oberfläche liegt auf `3420`, Caddy auf `80`/`443`; alle drei
  sind frei wählbar (siehe [Ports ändern](installation.md#ports-ändern)). Der
  Scanner-Webhook auf `8080` (per `SCANNER_PORT`). Die
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

Alles andere – inklusive PDF-Anzeige, Mobilansicht und PWA-Installation –
funktioniert plattformübergreifend. Praktisch erprobt sind **Android und
Windows**; die Nutzung auf **iPhone und iPad ist mangels Testgerät ungeprüft**
und gilt als experimentell. Der Installationsweg für jede Plattform steht in
[Mobil und PWA](mobil-und-pwa.md#als-app-installieren-pwa).

---

Weiter: [Installation](installation.md) · [Zurück zur Übersicht](README.md)

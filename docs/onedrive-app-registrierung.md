# OneDrive-App registrieren

postbuch.net verwendet bewusst keine gemeinsame Microsoft-App. Jede Instanz
bekommt eine eigene App-Registrierung; die **Anwendungs-ID (Client-ID)** ist
kein Geheimnis. Der empfohlene Gerätecode braucht weder Client-Secret noch
Redirect-URI.

> [!WARNING]
>
> Die delegierte Berechtigung `Files.ReadWrite.All` erlaubt Zugriff auf alle
> Ordner des verbundenen OneDrive-Kontos. Ein separates Microsoft-Konto nur
> für postbuch.net begrenzt diesen Zugriff am wirksamsten.

> [!TIP]
>
> Wer sich die Azure-App-Registrierung ganz sparen will: **MagentaCLOUD**
> (Nextcloud-basiert) lässt sich mit wenigen Klicks verbinden – ein
> gewöhnliches Benutzerkonto genügt. Siehe
> [Dateiablage-Backends](storage-backends.md#eigener-webdav-speicher).

## Empfohlen: Gerätecode ohne Secret

1. Öffne im [Azure-Portal die App-Registrierungen](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   und wähle **Neue Registrierung**.
2. Vergib einen Namen wie `postbuch`. Für ein privates OneDrive wählst du
   **Persönliche Microsoft-Konten** und verwendest später den Tenant
   `consumers`. Soll dieselbe Registrierung auch Geschäfts-/Schulkonten
   zulassen, wähle stattdessen **Konten in allen Entra-ID-Mandanten und
   persönliche Microsoft-Konten** und trage in postbuch.net `common` ein. Eine
   Umleitungs-URI bleibt leer.
3. Öffne **Authentifizierung**, setze **Öffentliche Clientflows zulassen** auf
   **Ja** und speichere. Ohne diese Einstellung kann Microsoft keinen
   Gerätecode ausgeben.
4. Füge unter **API-Berechtigungen → Microsoft Graph → Delegierte
   Berechtigungen** `Files.ReadWrite.All`, `User.Read` und `offline_access`
   hinzu.
5. Kopiere auf der Übersichtsseite die **Anwendungs-ID (Client)**. Trage sie im
   ![Dateiablage-Symbol](icons/folder-open.svg) Einrichtungsassistenten ein, speichere und starte die Verbindung.
6. Öffne den angezeigten Microsoft-Link, kopiere den Code mit einem Klick und
   bestätige die Anmeldung. Der Assistent wartet im selben Tab auf das Ergebnis.

Der häufigste Startfehler ist ein nicht aktivierter öffentlicher Clientflow.
Kontrolliere dann zuerst Schritt 3.

## Alternative: Browser-Redirect mit Client-Secret

Dieser Bestandsweg ist für Firmen-Tenants oder bestehende Registrierungen
weiter verfügbar:

1. Lege die App wie oben an, füge aber unter **Authentifizierung → Web** die im
   Assistenten angezeigte Redirect-URI ein.
2. Füge dieselben delegierten Graph-Berechtigungen hinzu.
3. Erzeuge unter **Zertifikate & Geheimnisse** ein Client-Secret. Kopiere den
   angezeigten **Wert**, nicht die geheime ID.
4. Notiere das Ablaufdatum und trage es zusammen mit Client-ID und Secret in
   postbuch.net ein. Azure erlaubt bei normalen App-Registrierungen höchstens
   24 Monate. postbuch.net erinnert 60 Tage vorher, wenn das Datum hinterlegt
   ist.
5. Beim ![Verbinden-Symbol](icons/link-2.svg) Verbinden öffnet postbuch.net Microsoft in einem Popup. Nach Erfolg
   schließt es sich und der Assistent bleibt an derselben Stelle. Blockiert der
   Browser Popups, läuft der Rückweg im Vollfenster auf den Dateiablage-Schritt.

Scheitert die Verbindung, bleibt das Popup mit einer Erklärung stehen, und die
OneDrive-Karte zeigt denselben Fehler an. Unterschieden werden:

- **Client-Secret abgelaufen** (`AADSTS7000222`): in Azure ein neues Secret
  erzeugen, Wert und Ablaufdatum eintragen, speichern.
- **Client-Secret ungültig** (`AADSTS7000215`): meist wurde die geheime ID statt
  des Werts kopiert oder der Wert ist unvollständig. Den Wert eines gültigen
  Secrets eintragen und speichern.
- **App-Registrierung ungültig**: Client-ID und Mandant prüfen und speichern.
- **Anmeldung abgebrochen**: die Anmeldung oder Zustimmung wurde bei Microsoft
  nicht abgeschlossen.

Danach das Popup schließen und erneut auf ![Verbinden-Symbol](icons/link-2.svg)
**Mit Microsoft verbinden** klicken. Ein bloßer erneuter Login mit dem alten
Secret hilft nicht. In keinem dieser Fälle wird eine Verbindung gespeichert.

## Verbindungsweg wechseln

Token-Caches sind an Client-ID und Anwendungstyp gebunden. Deshalb gibt es
keinen automatischen Wechsel: bestehende Verbindung bewusst trennen,
**Gerätecode** auswählen und einmal neu verbinden. Die Dateien im OneDrive
werden dabei nicht verändert.

Weiter: [Dateiablage-Backends](storage-backends.md) · [Installation](installation.md)

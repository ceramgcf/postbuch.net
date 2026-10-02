# MCP-Zugriff

Über das **Model Context Protocol** (MCP) kann ein externer KI-Agent – Claude
Desktop, ChatGPT, ein Editor-Assistent, ein eigenes Skript – dein postbuch.net
als Wissensquelle benutzen. Du fragst dann nicht mehr _in_ postbuch.net nach
deinen Unterlagen, sondern dort, wo du ohnehin gerade arbeitest, und die Antwort
stützt sich auf deine echten Dokumente statt auf Vermutungen.

Der Zugriff ist **ausschließlich lesend**. Es gibt keinen Weg, über MCP etwas zu
ändern, anzulegen oder zu löschen.

## Das Prinzip: nur zwei Werkzeuge für alles

Der Connector stellt dem fremden Agenten bewusst nur zwei Werkzeuge bereit:

| Werkzeug      | Aufgabe                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `askPostbuch` | Eine Frage in natürlicher Sprache stellen → fertige Antwort samt Quellenliste |
| `getDocument` | Das PDF eines bestimmten Dokuments per PostID nachladen                       |

Die eigentliche Recherche macht **dein eigener**
[Assistent](suche-und-assistent.md) hinter der Wand: derselbe Agent, dieselben
Suchwerkzeuge, dieselben Konventionen zu Lebensbereichen, Akten und Fristen. Der
fremde Agent muss von Dokumentarten, Kostenträgern und Wiedervorlagen nichts
wissen – er stellt eine Frage und bekommt Prosa plus Quellen zurück.

Das ist eine bewusste Entscheidung gegen den üblichen Zuschnitt, bei dem ein
MCP-Server ein Dutzend Rohwerkzeuge (`searchDocuments`, `listAkten`,
`getMetadata` …) exportiert. Vorteile:

- **Weniger Angriffsfläche.** Zwei schmale Eingänge statt vieler Abfragen mit
  freien Parametern.
- **Bessere Antworten.** Der interne Agent kennt die Datenstruktur und kann
  mehrstufig nachfassen; ein fremdes Modell mit Rohwerkzeugen rät.
- **Stabilität.** Ändert sich intern etwas, bleibt die MCP-Schnittstelle gleich.

Der Preis ist, dass jede `askPostbuch`-Anfrage eine vollständige Agenten-Runde
auslöst – sie dauert damit einige Sekunden und verbraucht
[KI-Kontingent](ki-provider.md) auf deiner Seite.

## Zugang einrichten

![Einstellungen-Symbol](icons/settings.svg) **Einstellungen → MCP-Zugriff.** Der
Bereich steht allen schreibberechtigten Nutzern offen, nicht nur Administratoren
– Tokens sind persönlich.

### 1. Server-Adresse

Die Adresse steht oben im Bereich und richtet sich nach der Adresse, unter der
postbuch.net gerade erreichbar ist – bei einer lokalen HTTP-Installation also
`http://…`, sonst `https://…`:

```
<protokoll>://<deine-postbuch-adresse>/api/mcp
```

Sie muss **von dem Gerät aus erreichbar sein, auf dem der KI-Agent läuft**. Bei
Claude Desktop auf deinem Laptop im selben Heimnetz reicht die LAN-Adresse.

> [!WARNING]
>
> postbuch.net sollte für den MCP-Zugriff niemals direkt ins offene Internet
> geöffnet werden. Ein Cloud-Dienst als MCP-Client braucht zwar eine von außen
> erreichbare Adresse, dafür aber einen eigens abgesicherten Weg (z. B.
> Reverse-Proxy mit zusätzlicher Zugriffskontrolle) statt eines einfach
> weitergeleiteten Ports – mit allen Konsequenzen, siehe
> [Sicherheit](sicherheit.md).

### 2. Token erzeugen

1. ![Bearbeiten-Symbol](icons/pencil.svg) **Beschreibung** eintragen (z. B.
   „Claude Desktop (Laptop)") – sie hilft später beim Widerrufen.
2. Optional ein **Ablaufdatum** setzen. Für Tokens, die auf fremder Hardware
   liegen, ist das dringend zu empfehlen.
3. ![Schlüssel-Symbol](icons/key-round.svg) **Token erzeugen**.

Das Token hat die Form `pb_` gefolgt von 43 Zeichen (256 Bit Zufall). Es wird
**genau einmal angezeigt**; in der Datenbank liegt nur sein SHA-256-Hashwert.
Verlierst du es, erzeugst du ein neues und widerrufst das alte – zurückholen
lässt es sich nicht.

![Token erzeugen](screenshots/mcp-token.jpg)

### 3. Im Client eintragen

In **Claude Desktop** als _Custom Connector_ (Remote/HTTP) mit obiger URL
anlegen und das Token als **Bearer-Token** hinterlegen. Das geht nur von Hand
über die claude_desktop_config.json, die in Claude Desktop unter
`Einstellungen → Entwickler → Konfiguration bearbeiten` erreichbar ist. In die
JSON-Datei muss in der Sektion `mcpServers` ein Eintrag wie folgt:

```json
{
  "mcpServers": {
    "postbuch.net": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "mcp-remote",
        "https://<URL_ZU_DEINER_INSTANZ>/api/mcp",
        "--header",
        "Authorization: Bearer pb_HierDeinBearerTokenEinfuegen"
      ]
    }
  }
}
```

Andere MCP-fähige Clients erwarten dieselben zwei Angaben; der Transport ist
Standard-HTTP (StreamableHTTP, zustandslos, JSON – kein SSE, keine
Server-Sitzung).

Technisch geht jede Anfrage als `POST` an `/api/mcp` mit dem Kopfzeilenfeld:

```
Authorization: Bearer pb_…
```

`GET` und `DELETE` beantwortet der Server bewusst mit _405 Method not allowed_ –
der zustandslose Betrieb kennt keine offenen Streams.

> [!TIP]
>
> Damit der Client postbuch.net proaktiv anfragt, empfiehlt es sich, eine
> generelle Anweisung (bei Claude Desktop z. B. über
> `Einstellungen → Allgemein → Anweisungen für Claude`) zu geben, die wie folgt
> lauten könnte:
>
> > Bei jeder Frage, die meine eigenen Angelegenheiten, Unterlagen oder meine
> > persönliche Lage betrifft, konsultiere zuerst den Connector postbuch.net,
> > bevor du generisch antwortest.

## Wer darf was?

Ein Token trägt die Identität des Nutzers, der es erzeugt hat, und **erbt dessen
Rolle bei jeder einzelnen Anfrage neu**. Das hat drei praktische Folgen:

- Ändert sich die Rolle eines Nutzers, wirkt das sofort auf sein Token.
- Wird der Nutzer gelöscht oder deaktiviert, sind seine Tokens umgehend ungültig
  – auch ohne sie einzeln zu widerrufen.
- Selbst ein Token des Administrators kann über MCP **nicht** schreiben; der
  Read-only-Modus wird beim Aufruf erzwungen, nicht über die Rolle.

Tokens sind persönlich: Du siehst und widerrufst nur deine eigenen. Der
Administrator sieht alle Tokens aller Nutzer – mit Nutzername, Erstellungsdatum
und letzter Nutzung – und kann jedes widerrufen. Das ist die Aufsichtsfunktion
für den Fall, dass jemand ein Token auf einem verlorenen Gerät liegen hat.

**Widerruf wirkt sofort**, weil bei jeder Anfrage gegen die Datenbank geprüft
wird. Ein widerrufenes Token bleibt in der Liste stehen (als „widerrufen"),
damit die Historie nachvollziehbar bleibt.

Die Spalte **„Zuletzt genutzt"** ist dein Frühwarnsystem: Zeigt ein Token
Aktivität, von der du nichts weißt, widerrufe es.

## Was der externe Agent tatsächlich sieht

`askPostbuch` liefert Text – die Antwort des internen Assistenten – und daran
angehängt eine Quellenliste mit PostIDs bzw. AkteIDs. Der fremde Agent bekommt
also **keinen Datenbankzugriff und keine Rohtabellen**, sondern das, was auch im
Assistenten auf dem Bildschirm stünde. Diese Kapselung hat den Vorteil, dass der
externe Agent nicht wissen muss, wie die Daten intern strukturiert sind oder wie
interne Tools funktionieren und effizient orchestriert werden. Diese Intelligenz
verbleibt in postbuch.net.

`getDocument` gibt das PDF eines Dokuments als Base64 zurück, zusammen mit dem
Dateinamen und der Größe. Die PostID wird streng auf das Format `P` plus sechs
Ziffern geprüft. Das PDF kommt aus demselben Cache, den auch die Weboberfläche
benutzt; liegt es dort nicht, wird es aus der [Dateiablage](storage-backends.md)
nachgeladen. So kann der externe Agent ein Dokument gezielt und komplett in
seinen Kontext laden, wenn er es selbst prüfen will.

Damit ist der Umfang klar umrissen – aber er ist nicht klein: **Wer ein gültiges
Token hat, kann jedes Dokument deines Archivs im Volltext abrufen.** Behandle
das Token wie ein Passwort.

Der interne Assistent zeigt seine Denkschritte über MCP nicht an; das fragende
Modell denkt bereits selbst, ein zweiter Gedankenstrom wäre nur Rauschen. Bricht
der Client die Verbindung ab, wird eine laufende Recherche abgebrochen, statt im
Hintergrund weiterzulaufen.

## Typische Anwendungen

- **Beim Schreiben nachschlagen.** „Wann lief mein Mietvertrag an und was steht
  zur Kaution drin?" – der Agent holt die Antwort samt Quelle, ohne dass du die
  Akte suchst.
- **Fristen im Blick behalten.** „Habe ich in den nächsten vier Wochen etwas
  offen?" beantwortet der interne Agent aus Wiedervorlagen und Fälligkeiten.
- **Dokument gezielt in den Kontext ziehen.** Erst `askPostbuch` fragen, dann
  die gelieferte PostID an `getDocument` geben und das PDF direkt besprechen
  lassen.

Für reines Weltwissen ohne Bezug zu deinen Unterlagen soll der Agent den
Connector nicht aufrufen – das steht so in seiner Werkzeugbeschreibung.

## Grenzen und Fehlerbilder

| Symptom                                               | Ursache                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `401` mit „Ungültiges oder fehlendes Bearer-Token"    | Token falsch, widerrufen oder abgelaufen                                                            |
| `401` mit „Zugehöriger Benutzer existiert nicht mehr" | Der Nutzer wurde gelöscht oder deaktiviert                                                          |
| `405 Method not allowed`                              | Der Client versucht `GET`/`DELETE` – er erwartet einen Sitzungs-Transport, der hier nicht existiert |
| Antwort dauert lange                                  | Normal: hinter jeder Frage steckt eine vollständige Agenten-Runde                                   |
| „Dokument … konnte nicht geladen werden"              | Falsche PostID, oder die Dateiablage ist gerade nicht erreichbar                                         |

Der MCP-Endpunkt liegt bewusst **vor** dem Sitzungs-Gate der übrigen API und
bringt seine eigene Authentifizierung mit – wie die
[Webhooks](dokumente-importieren.md). Anders als diese ist er aber nicht per
Webserver-Regel blockiert, sondern soll erreichbar sein. Wer das nicht will,
erzeugt schlicht kein Token: Ohne Token gibt es keinen Zugang.

---

Weiter: [Benachrichtigungen](benachrichtigungen.md) ·
[Zurück zur Übersicht](README.md)

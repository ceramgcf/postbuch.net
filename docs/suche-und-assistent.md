# Suche und Assistent

Zwei Wege führen zu einem Dokument: die ![Suche-Symbol](icons/search.svg)
**Suche** (du weißt ungefähr, wonach du suchst) und der
![Assistent-Symbol](icons/bot.svg) **Assistent** (du hast eine Frage, deren
Antwort in mehreren Dokumenten steckt).

## Suche

Erreichbar über die Sidebar, aus dem Dokumentenarchiv oder aus dem
Aktenverzeichnis. Das Ergebnis ist in zwei Registerkarten geteilt:
![Dokumente-Symbol](icons/file-text.svg) **Dokumente** und
![Akten-Symbol](icons/folder-open.svg) **Akten** – beide werden bei jeder Suche
parallel abgefragt, die Trefferzahl steht am Reiter.

### Wie die Suche findet

Jede Suche läuft auf zwei Wegen zugleich. Das Ergebnis ist eine gemeinsame
Liste, die relevantesten Treffer stehen oben:

- **Wortlaut:** Die Suchwörter werden in Betreff, Zusammenfassung, Kontakt,
  Schlagwörtern, fremdem Zeichen und Notiz gesucht – nach Wortstamm
  („Rechnungen“ findet „Rechnung“) und ab drei Buchstaben auch als Wortteil
  („Versicherung“ findet „Hausratversicherung“). Es müssen nicht alle Wörter
  vorkommen. Seltene Wörter zählen mehr als häufige: Bei „Rechnung Zahnarzt“
  wiegt „Zahnarzt“ viel mehr, weil fast jedes zweite Dokument „Rechnung“
  enthält. Gezählt wird über Dokumente und Akten zusammen, ein Wort wiegt in
  beiden Registerkarten gleich. Füllwörter wie „der“ oder „mein“ zählen
  nicht. Wörter, die weder in Dokumenten noch in Akten vorkommen, drücken den
  Wert anteilig: Sind zwei von drei
  Suchwörtern nirgends zu finden, erreicht ein Treffer höchstens 33 %. Steht
  die ganze Eingabe genau so im Dokument, etwa ein Aktenzeichen, kommt er ganz
  nach vorn.
- **Inhalt:** Die Bedeutung der Anfrage wird mit der Bedeutung der Dokumente
  verglichen. So erscheinen auch Dokumente, die das Thema mit anderen Worten
  beschreiben.

#### Reihenfolge und Trefferwerte

Unter jedem Treffer stehen bis zu drei Werte als kleine Pillen; ein Balken
füllt sie entsprechend dem Prozentwert:

- ![Übereinstimmung-Symbol](icons/target.svg) **Übereinstimmung:** wie gut der
  Treffer insgesamt zur Anfrage passt, aus Wörtern und Inhalt zusammen. Die
  Liste ist danach sortiert; die Pille steht ganz links und hat den kräftigsten
  Balken. Was auf beiden Wegen passt, steht oben. Stimmen nur die Wörter, das
  Dokument handelt aber von etwas anderem, bleibt die Übereinstimmung deutlich
  unter 100 %. Steht eine Eingabe aus mehreren Teilen genau so im Dokument,
  etwa ein Aktenzeichen, sind es 100 %.
- **Wörter:** welcher Anteil der Suchwörter im Dokument vorkommt, auch als
  Wortteil, gewichtet nach Seltenheit. Enthält ein Dokument bei „Unfall 2024“
  nur das seltene „Unfall“, steht dort etwa „Wörter 87 %“. Steht die ganze
  Eingabe genau so im Dokument, sind es 100 %. Kommt keines vor, steht dort
  ausgegraut „keine Wörter“.
- ![Inhalt-Symbol](icons/sparkles.svg) **Inhalt:** wie ähnlich die Bedeutung
  des Dokuments der Anfrage ist, auf der Skala des Modells: 0 % entspricht
  der Ähnlichkeit, die das Modell auch für sinnlose Anfragen liefert, 100 %
  einem sehr gut passenden Treffer. Für die empfohlenen Embedding-Modelle sind
  die Eckwerte gemessen (aus den [Empfehlungen](ki-provider.md#empfehlungen)),
  für andere gelten Startwerte, die sich unter
  [Embeddings](ki-provider.md#suchschwellen) anpassen lassen. Liegt die
  Ähnlichkeit so niedrig wie bei sinnlosen Anfragen, ist die Pille
  ausgegraut.

Je Registerkarte zeigt die Suche zunächst die gut passenden Treffer,
höchstens 50; gibt es mehr, steht am Reiter zum Beispiel „50+“. Beim Scrollen
ans Listenende lädt sie weitere nach. Unter der Linie „Weniger passende
Treffer“ folgen Dokumente mit geringerer Übereinstimmung. Die Liste endet, wo
die Treffer nicht mehr zur Anfrage passen. Eine Anfrage ohne Sinn liefert
deshalb gar keine inhaltlichen Treffer.

Beide Wege arbeiten mit den **Metadaten** des Dokuments, nicht mit dem
PDF-Inhalt: Ein Wort, das nur mitten im gescannten Brief steht und weder in
Betreff noch Zusammenfassung auftaucht, findet die Suche nicht.

> [!CAUTION]
>
> Die Suche nach dem Inhalt setzt ein eingerichtetes **Embedding** voraus,
> standardmäßig den
> [eingebauten Dienst](ki-provider.md#der-eingebaute-embedding-dienst). Ist es
> nicht verfügbar, zeigt die Suche nur Treffer mit passendem Wortlaut und sagt
> das über der Liste. Außerdem werden über den Inhalt nur Dokumente gefunden,
> deren Embedding mit dem _aktuell_ eingestellten Modell erzeugt wurde – nach
> einem Modellwechsel muss neu eingebettet werden.

> [!TIP]
>
> ![Archiv-Symbol](icons/archive.svg) **Historische** Dokumente und Akten sind
> standardmäßig ausgeblendet; ein Schalter über der Ergebnisliste nimmt sie mit
> auf.

### Nummer eingeben = direkt zu Dokument/Akte springen

Tippst du `P000123`, `p123`, `#A45` oder Ähnliches ein, erkennt die Suche das
als Nummerneingabe:

- Der exakte Treffer wird oben hervorgehoben.
- Ein **Countdown-Ring** läuft drei Sekunden – danach springt die Ansicht
  automatisch auf die Detailseite.
- Abbrechen: ![Abbrechen-Symbol](icons/x.svg) Ring anklicken, `Esc` drücken oder
  irgendwo klicken/scrollen. Dann bleibst du in der Ergebnisliste.
- Wer „reduzierte Bewegung" im Betriebssystem eingestellt hat, bekommt den Ring
  ohne Animation, der Countdown läuft trotzdem.
- Eine `A`-Nummer schaltet automatisch auf die Registerkarte
  ![Akten-Symbol](icons/folder-open.svg) **Akten** um.

Bei einer Nummerneingabe wird der ![Archiv-Symbol](icons/archive.svg)
Historisch-Filter bewusst ignoriert und die Suche nach dem Inhalt gar nicht
erst angestoßen: Wer eine Nummer eintippt, will genau dieses Objekt sehen.

Kommst du über den ![Zurück-Symbol](icons/arrow-left.svg) Zurück-Button in die
Suche zurück, springt sie **nicht** erneut automatisch weiter – sonst säßest du
in einer Schleife fest.

![Suche nach einer Postnummer](screenshots/suche-nummer.png)

### Aktenmodus

Fügst du aus einer Akte heraus Dokumente hinzu, öffnet sich dieselbe Suche im
**Aktenmodus**: Ein Banner nennt die Ziel-Akte, und jeder Treffer bekommt einen
Direktbutton ![Akte-hinzufügen-Symbol](icons/folder-plus.svg) „zur Akte
hinzufügen". Die Zuordnung ist über die Rückgängig-Funktion der Oberfläche
sofort widerrufbar. Über ![Zurück-Symbol](icons/arrow-left.svg) „Zur Akte" geht
es zurück in die Akte.

## Assistent

Der ![Assistent-Symbol](icons/bot.svg) **Assistent** ist ein Chat, der **deine
Dokumente und die mit dieser Version ausgelieferte Hilfe lesen kann** – z. B.
diesen Text, den du gerade liest. Er beantwortet Fragen, die sich nicht aus
einer Trefferliste ablesen lassen, sondern nur wenn man ein oder mehrere
Dokumente liest und Beziehungen zwischen ihnen herstellt. Beispiele:

- „Was habe ich 2025 insgesamt an Zahnarztkosten gehabt, und wie viel davon ist
  erstattet?"
- „Welche Rechnung gehört zu diesem Erstattungsbescheid?"
- „Steht in meinem Mietvertrag etwas zur Kaution?"
- "Welche Versicherungen habe ich aktuell und was kosten sie mich?"
- "Wie hat sich mein Bruttogehalt über die letzten 10 Jahre entwickelt?"
- „Wie lange läuft mein aktueller Gasvertrag noch?"

aber auch:

- „Wie archiviere ich eine Akte?" oder
- „Wo richte ich den Scanner ein?"

### Wie er arbeitet

Der Assistent bekommt nicht deine ganze Datenbank vorgelegt, sondern
**Werkzeuge**, mit denen er sich selbst holt, was er braucht:

- **Recherchieren** – Dokumente mit derselben Suche wie im Suchfeld finden,
  Metadaten eines Dokuments abrufen, Akten durchsuchen, eine Akte samt
  Dokumentliste laden, Wiedervorlagen und Fälligkeiten auflisten.
- **Bedienung erklären** – passende Abschnitte der eingebauten Hilfe semantisch
  finden. Verwendete Hilfeabschnitte stehen als klickbare Quellen unter der
  Antwort und öffnen direkt das betreffende Kapitel.
- **Hineinschauen** – den extrahierten Volltext eines Dokuments laden, oder bei
  tabellenlastigen Dokumenten (Gehaltsabrechnung, Kontoauszug, Steuerbescheid)
  das PDF selbst per Vision-Modell ansehen. Letzteres geht nur bei PDFs mit
  höchstens **acht Seiten**; bei längeren bleibt ihm der Volltext.

Das läuft in Runden: suchen, Ergebnisse bewerten, gezielt nachladen, antworten.
Pro Antwort sind maximal **12 Runden** und **10 Dokument-Ladungen** erlaubt –
danach muss er aus dem berichten, was er hat, und Lücken benennen. Diese Grenzen
bremsen Kosten und verhindern Endlosschleifen; bei sehr breiten Fragen („zeig
mir alles zu…") kann es sein, dass er einschränken muss. Dann ist eine präzisere
Frage die bessere Antwort.

Die Hilfe wird dabei nicht vollständig in jede Anfrage geladen. Der Assistent
sucht erst nach wenigen passenden Abschnitten und bekommt nur diese in den
Kontext. Ist der semantische Hilfekorpus noch nicht fertig oder der
Embedding-Provider vorübergehend nicht erreichbar, bleibt eine lokale Textsuche
als Rückfall erhalten.

Der Assistent nutzt **zwei Modelle**: ein schnelles, günstiges für die
Rechercherunden und ein starkes für die Schlussantwort. Beide werden getrennt
unter ![Einstellungen-Symbol](icons/settings.svg) `Einstellungen → KI` als
eigene Modellklassen „Assistent: Recherche" und „Assistent: Antwort" gewählt
(siehe [KI-Provider](ki-provider.md)).

### Dokumente direkt referenzieren

Mit `#P000123` (Dokument) oder `#A000045` (Akte) in der Nachricht hängst du das
Objekt direkt an die Frage an – der Inhalt wird geladen, _bevor_ der Assistent
loslegt, er muss also nicht erst danach suchen.

Zur Schreibweise: Das Rautezeichen ist Pflicht, und die Nummer muss
**sechsstellig** sein. `#P000123` funktioniert, `#P123` nicht – anders als im
Suchfeld, das kurze Eingaben verzeiht. Groß- und Kleinschreibung ist egal
(`#p000123` geht auch). Der schnellste Weg zu einer korrekten Referenz ist der
Knopf ![Chat-Symbol](icons/message-circle.svg) **Im Chat besprechen** auf der
Detailseite eines Dokuments: Er öffnet den Assistenten mit der fertigen Referenz
im Eingabefeld. Sonst kopiert man die Nummer aus der Kopfzeile des Dokuments
oder der Akte.

Grenzen: maximal **fünf** Referenzen pro Nachricht – weitere werden ignoriert,
mit einem Hinweis darauf, welche –, und Volltexte werden bei **8000 Zeichen**
gekappt. Mehrfachnennungen desselben Objekts zählen einmal.

Was mitkommt: bei einem **Dokument** die Metadaten (Datum, Art, Kontakt, Status,
Person, fremdes Zeichen), Zusammenfassung, Schlagwörter, Notiz und der
extrahierte Volltext; archivierte Dokumente sind ausdrücklich als `ARCHIVIERT`
gekennzeichnet. Bei einer **Akte** kommen Betreff, Beschreibung, Schlagwörter,
Notiz und die Liste der enthaltenen Dokumente mit – nicht deren Volltexte; die
lädt der Assistent bei Bedarf selbst nach. Bei Dokumenten ohne extrahierbaren
Text (reine Scans) kommen nur die Metadaten mit, und der Assistent kann
entscheiden, ob er das PDF ansehen will.

In deiner abgeschickten Nachricht werden die Referenzen als klickbare Chips
dargestellt, in der Antwort genannte Dokumente ebenso. Der Zurück-Weg führt in
den Chat zurück.

### Bearbeiten-Modus

Standardmäßig **liest** der Assistent nur. Das
![Bearbeiten-Symbol](icons/pencil.svg) Stift-Symbol schaltet den
Bearbeiten-Modus für den jeweiligen Chat ein; dann darf er zusätzlich Akten
anlegen und pflegen sowie Schlagwörter und Notiz eines Dokuments ändern. Zwei
unabhängige Sperren:

1. **Rolle.** Wer nur `lesezugriff` hat, kann den Modus nicht einschalten – die
   Schreibwerkzeuge werden dem Modell gar nicht erst angeboten.
2. **Schalter.** Auch mit Schreibrechten ist der Modus pro Chat aus, bis du ihn
   aktivierst. Er wird beim Wechsel in einen anderen Chat wieder zurückgesetzt.

Braucht der Assistent Schreibrechte, führt er die Aktion nicht einfach aus,
sondern fragt: „Bearbeiten-Modus nötig" – mit einem Knopf, der ihn einschaltet
und die Antwort fortsetzt.

Was dann passieren darf, ist gestaffelt:

| Art der Aktion | Beispiele                                                                                                                                           | Verhalten                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Additiv**    | Akte anlegen, Dokument zur Akte hinzufügen, Reihenfolge der Dokumente ändern, Akte auf historisch setzen (wahlweise samt der enthaltenen Dokumente) | wird sofort ausgeführt, mit ![Rückgängig-Symbol](icons/refresh-cw.svg) **Rückgängig**-Knopf an der Antwort              |
| **Bedingt**    | Betreff, Beschreibung, Schlagwörter oder Notiz einer **Akte** ändern; Schlagwörter oder Notiz eines **Dokuments** ändern                            | füllt es nur ein leeres Feld, läuft es durch; würde es Vorhandenes **überschreiben**, wird es zur Bestätigung vorgelegt |
| **Destruktiv** | Dokument aus Akte entfernen, Akte löschen                                                                                                           | **immer** bestätigungspflichtig                                                                                         |

Vorgelegte Aktionen erscheinen als Karte unter der Antwort mit
![Bestätigen-Symbol](icons/check.svg) **Bestätigen** und
![Verwerfen-Symbol](icons/x.svg) **Verwerfen**. Bestätigen führt alle offenen
Aktionen in _einer_ Transaktion aus – entweder alle oder keine. Ausgeführte
Aktionen behalten ihre inverse Operation;
![Rückgängig-Symbol](icons/refresh-cw.svg) **Rückgängig** spielt sie in
umgekehrter Reihenfolge zurück, ebenfalls transaktional. Pro Antwort sind
höchstens 50 Schreibaktionen möglich.

Was er **nicht** ändern kann – die Werkzeuge dafür existieren schlicht nicht:

- **Dokumente** löschen, hochladen, ersetzen oder wiederverarbeiten, und keine
  Datei in der Dateiablage verschieben.
- Von einem Dokument alles außer Schlagwörtern und Notiz: Betreff, Briefdatum,
  Dokumentart, Kontakt, Person, Richtung, Status, Beträge, Fälligkeit und
  „bezahlt am" bleiben ihm verschlossen. Ein einzelnes Dokument archivieren kann
  er nicht.
- Wiedervorlagen anlegen oder abhaken: das liest er nur.
- Abrechnungsperioden, Kostenträger-Profile, Menschen, Einstellungen, Backups
  und der Verbleib eines Dokuments – dieser ganze Bereich ist für ihn
  unsichtbar, weder lesend noch schreibend.

Sein schreibender Zugriff endet also bei der Aktenpflege und den beiden
Dokumentfeldern Schlagwörter und Notiz.

![Aktenlage per Chat mit dem Assistenten](screenshots/assistent-aktenanlage.jpg)

### Chats verwalten

Links liegt die Liste der Unterhaltungen. Titel werden automatisch aus der
ersten Frage erzeugt und lassen sich per ![Bearbeiten-Symbol](icons/pencil.svg)
Stift umbenennen; ![Löschen-Symbol](icons/trash-2.svg) Löschen entfernt den Chat
samt Verlauf. Jeder Nutzer sieht ausschließlich seine eigenen Chats – auch der
Admin kann fremde Chatlisten und -inhalte nicht einsehen. Lediglich das Löschen
fremder Chats ist dem Admin vorbehalten.

Eine laufende Antwort lässt sich mit dem ![Stopp-Symbol](icons/square.svg)
Stopp-Knopf abbrechen. Bereits ausgeführte additive Aktionen bleiben dann
bestehen und sind über Rückgängig zurücknehmbar.

## Was wähle ich wann?

- **Nummer bekannt** → Suchfeld, Nummer eintippen, drei Sekunden warten.
- **Stichwort oder Thema bekannt** → Suche; sie findet beides in einer Liste.
- **Frage statt Suche** → Assistent. Er ist langsamer und kostet KI-Aufrufe,
  aber er liest die Dokumente wirklich.
- **Große Akte anlegen** → Assistent, weil er die Dokumente für dich automatisch
  finden und hinzufügen kann.

---

Weiter: [PKV, Beihilfe und Abrechnung](abrechnung-pkv-beihilfe.md) ·
[Zurück zur Übersicht](README.md)

# Analyse

Vier Auswertungsseiten liegen unter
**Analyse** in der Navigation: offene Rechnungen, Handwerkerkosten fürs
Finanzamt, ein Fristenkalender und frei definierbare Saldenkonten.

![Unbezahlt-Symbol](icons/circle-alert.svg) **Unbezahlt** – alle offenen
Rechnungen quer über Arztrechnungen, Handwerkerrechnungen und generische
Rechnungen, sortiert nach Fälligkeit, mit Kennzeichnung des Überfälligen.
Bestrittene Anteile sind abgezogen; historische Dokumente bleiben draußen.

![Ubezahlte Rechnungen](screenshots/unbezahlt.png)

![Handwerker-Symbol](icons/wrench.svg) **Handwerker** – Handwerkerrechnungen
nach Leistungsjahr, mit getrennter Summe der **Lohnkosten**. Das ist genau die
Zahl, die in der Steuererklärung für haushaltsnahe Dienstleistungen und
Handwerkerleistungen gebraucht wird; die KI liest sie aus der Rechnung mit aus.

![Übersicht Handwerkerrechnungen](screenshots/handwerker.png)

Anders als die Liste „Unbezahlt" zählt diese Auswertung **archivierte Rechnungen
mit**. Archivieren heißt weggeräumt, nicht ungültig – ein bezahlter und
abgeschlossener Handwerkervorgang ist der Normalfall für das Archiv, und sein
Lohnanteil bleibt für das Leistungsjahr trotzdem absetzbar. Damit die Summen
nachvollziehbar bleiben, sind archivierte Rechnungen deutlich gekennzeichnet:
Die Zeile trägt ein Kästchen **Archiviert**, in der Kopfzeile des Jahres steht,
wie viele es sind und welcher Lohnanteil auf sie entfällt, und über der Seite
steht dieselbe Angabe für die gewählten Jahre zusammengefasst. Soll eine
Rechnung wirklich nicht mehr mitzählen, gehört nicht sie archiviert, sondern ihr
[Rechnungsblock entfernt](dokumentansicht.md#sonderfall-korrekturrechnung) –
dann ist sie keine Rechnung mehr.

![Kalender-Symbol](icons/calendar-clock.svg) **Kalender** – alle Wiedervorlagen
und Fälligkeiten in einer Zeitachse (siehe
[Akten, Verbleib und Wiedervorlagen](akten-und-organisation.md)).

![Kalenderansicht mit Wiedervorlagen und Fälligkeiten](screenshots/kalender.png)

![Salden-Symbol](icons/scale.svg) **Salden** – frei definierbare Konten, um
Beträge im Blick zu behalten, die keinem einzelnen Dokument gehören
(Selbstbehalte, ein Darlehen an die Tochter, ein Kautionskonto). Ein Saldo hat
manuelle Buchungen und optional **SQL-Quellen**: gespeicherte Abfragen, die – an
ein einzelnes Dokument oder an eine ganze Dokumentklasse gebunden – automatisch
Buchungen liefern. Sie laufen strikt lesend (`SELECT`/`WITH`, ein Statement, 5
Sekunden Zeitlimit, Read-only-Transaktion) und dürfen nur vom Admin angelegt
werden. Salden lassen sich in der Navigation ausblenden, wenn du sie nicht
brauchst.

> [!WARNING]
>
> SQL-Quellen sind ein Entwicklerfeature und in der App auch so gekennzeichnet.
> Sie sind ab Werk abgeschaltet, müssen in den Einstellungen unter Allgemein
> bewusst freigeschaltet werden und setzen Datenbank- und SQL-Kenntnisse voraus.
> Ein fehlerhaftes Statement führt zu falschen Salden.

---

Weiter: [Export und Import](export-import.md) ·
[Zurück zur Übersicht](README.md)

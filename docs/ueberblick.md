# Überblick

postbuch.net ist ein **selbstgehostetes Dokumentenarchiv für private Post** und
ähnliche Dokumente. Ein Dokument kommt herein – vom Scanner, per Upload oder
aus einem überwachten Cloud-Ordner –, eine KI liest es, trägt die Metadaten in
eine Datenbank ein, und die Datei landet mit sprechendem Namen in einer
aufgeräumten Ordnerstruktur in deiner Cloud-Dateiablage. So, dass du auch ohne die
Anwendung jederzeit auf deine Dokumente zugreifen kannst.

Was postbuch.net von einer Ordnerstruktur unterscheidet, in die du selbst deine
Scans einpflegst, ist die Datenbank dahinter: Jedes Dokument hat eine Nummer,
einen Absender, ein Datum, eine Zusammenfassung, Schlagwörter und – je nach
Dokumentart – strukturierte Fachdaten wie Rechnungspositionen oder
Erstattungsbeträge. Diese sogenannten Metadaten können auch andere
Dokumentenmanagementsysteme verwalten. Die Besonderheit bei postbuch.net: Du
musst die Metadaten nicht selbst einfüllen. Die KI erledigt das vollautomatisch.

## Grundbegriffe

Diese Begriffe tauchen in der Oberfläche und in dieser Dokumentation ständig
auf. Wer sie einmal gelesen hat, versteht den Rest schneller.

**Dokument (Postnummer, `P000123`)** Eine PDF-Datei plus alles, was postbuch.net
darüber weiß. Die Postnummer wird beim Import vergeben, ist eindeutig und bleibt
für immer. Sie steht im Dateinamen, im Etikett auf dem Papieroriginal und in
jedem Export.

**Akte (Aktennummer, `A000123`)** Eine geordnete Sammlung von Dokumenten zu
einem Vorgang – der Autounfall, der Hauskauf, der Streit mit dem Vermieter, die
Unterlagen für die diesjährige Steuererklärung. Ein Dokument kann in mehreren
Akten liegen; die Reihenfolge innerhalb einer Akte ist frei sortierbar.

**Lebensbereich × Dokumentart** Danach klassifiziert postbuch.net jedes einzelne
Dokument. Jedes Dokument hat diese zwei Kerneigenschaften: _wohin es im Leben
gehört_ (Lebensbereich, z. B. `Gesundheit`, `Wohnen`, `Mobilität`) und _was es
ist_ (Dokumentart, z. B. `Rechnung`, `Vertrag`, `Bescheid`). Beide Listen kommen
fest mit dem Release – 12 Lebensbereiche und 18 Dokumentarten –, und **jede**
Kombination aus beiden ist zulässig. Aus der Kombination ergibt sich auch der
Dateiablageordner.

**Spezial-Pipelines** Einige Dokumentarten werden tiefer ausgewertet als der
Rest: Arztrechnung, Laborrechnung, Rezept und Hilfsmittelrechnung
(Einzelpositionen mit GOÄ/GOZ/PZN/...-Ziffern), Erstattungsbescheid
(Erstattungs- und Kürzungspositionen), Arztbericht (Norm- und pathologische
Befunde) und Handwerkerrechnung (Lohnanteil für die Steuererklärung). Alle
übrigen Arten laufen durch die generische Auswertung.

**Mensch** Eine Person in deinem Haushalt. Ein Mensch trägt fachliche Angaben
(Kurzname, Anzeigename, PKV-/Beihilfe-Sätze, Farbe) und **optional** einen
Zugang zur Oberfläche. Ihm können Dokumente zugeordnet werden, wenn er z. B. als
Absender, Empfänger oder behandelte Person genannt wird. Nicht jeder Mensch
braucht ein Login, und ein Login ist nichts anderes als ein Mensch mit
Anmeldenamen.

**Verbleib** Wo das **Papier** liegt, nachdem es gescannt wurde: „Ordner
Versicherungen", „Dokumentenmappe", „vernichtet". Rein digital geführte
Dokumente brauchen das nicht – für alles, was du aufheben musst, ist es die
Brücke zwischen Datenbank und Aktenschrank. Siehe
[Akten, Verbleib und Wiedervorlagen](akten-und-organisation.md).

**Wiedervorlage** Ein Datum mit Notiz an einem Dokument oder einer Akte:
erinnere mich am 3. Juli an die Kündigungsfrist. Wiedervorlagen erscheinen im
Kalender, auf dem Dashboard und melden sich per PWA-/Browser-Push.

**Dateiablage (Storage-Backend)** Der Cloud-Speicher, in dem die PDFs tatsächlich
liegen: OneDrive oder eine Nextcloud. postbuch.net speichert die Dateien (mit
Ausnahme eines beschränkten Caches) **nicht** lokal auf dem Server.

## Wie ein Dokument durch das System läuft

```
Scanner / Upload / Cloud-Ordner
    → KI-Analyse
        → Duplikatprüfung
            → Dateiablage in der Cloud
                → Datenbankeintrag + Embedding
                    → sichtbar in Dokumente, Suche und Assistent
```

Der Ablauf ist in [Dokumente importieren](dokumente-importieren.md) im Detail
beschrieben, die technische Seite in [Architektur](architektur.md).

## Worauf du dich einlässt

Die wichtigsten Rahmenbedingungen sind:

- **Deine Dokumente verlassen in der Standardkonfiguration dein Netz.** Sie
  gehen an den KI-Anbieter, den du auswählst, und an den Cloud-Speicher, den du
  auswählst. Ein cloudfreier Betrieb ist möglich, aber aufwendig – siehe
  [KI-Anbieter](ki-provider.md).
- **Nur für den privaten Gebrauch.** Für Unternehmen, Selbstständige und Vereine
  ist postbuch.net nicht gebaut und bietet nichts, was dort nötig wäre (kein
  AVV, keine Mandantentrennung, keine revisionssichere Dateiablage).
- **Nicht offen ins Internet stellen.** Die Instanz gehört ins eigene Netz oder
  hinter ein VPN. HTTPS verschlüsselt den Transportweg, ersetzt aber keine
  Absicherung der Anwendung.
- **Der Code ist maßgeblich mit KI-Werkzeugen entstanden** und nicht vollständig
  menschlich gegengeprüft. Es gibt keine Garantie auf Funktion, Sicherheit oder
  Datenschutz und keinen Support.
- **Nur PDF.** postbuch.net ist ein Archiv für abgeschlossene Dokumente, kein
  Editor und keine Entwurfsverwaltung.

## Was postbuch.net nicht ist

- Kein Cloud-Dienst. Es gibt keinen Server des Projekts, auf dem deine Daten
  liegen.
- Kein Ersatz für ein Backup. Die Datenbank sichert postbuch.net selbst, die
  Dokumente sicherst du über deine Dateiablage – siehe
  [Backup und Wiederherstellung](backup-wiederherstellung.md).
- Kein Mehrmandantensystem. Eine Instanz ist für einen Haushalt gedacht – und
  auch das nur, wenn alle einverstanden sind. Denn: Wer Dokumente bearbeitet,
  sieht alles, auch die Post der anderen. Nur ein Lesezugriff lässt sich auf
  die eigenen Dokumente beschränken.

---

Weiter: [Voraussetzungen](voraussetzungen.md) ·
[Zurück zur Übersicht](README.md)

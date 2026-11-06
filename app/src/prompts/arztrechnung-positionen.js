/**
 * prompts/arztrechnung-positionen.js — Einzelpositionen einer Arztrechnung
 *
 * Eigener Schritt nach der Klassifikation: Die Klassifikation liefert Kopf-
 * daten (Datum, Arzt, Gesamtbetrag), dieser Aufruf liest das ganze Dokument
 * noch einmal mit nur einer Aufgabe — jede Position vollständig, Begründungen
 * im Volltext, auch wenn die Rechnung sie über eine Legende oder Fußnote
 * verweist.
 *
 * Verwendet von: service/arztrechnung-positionen.js
 *
 * Zwei Prompts:
 *   1. buildPositionenPrompt(kontext)                 — Erstlesung
 *   2. buildNachlesePrompt(kontext, befunde, vorher)  — erneute Lesung, wenn
 *      eine Plausibilitätsprüfung gescheitert ist
 */

const AUSGABE = `{
  "einzelpositionen": [
    {
      "behandlungsDatum": "YYYY-MM-DD oder null",
      "ziffer": "GOÄ-/GOZ-/GOT-Ziffer, PZN oder sonstige Kennung; ohne Kennung null",
      "leistung": "Leistungsbeschreibung wie auf der Rechnung",
      "begruendung": "Begründung im vollen Wortlaut oder null",
      "faktor": "Zahl oder null, wenn die Position keinen Faktor ausweist",
      "betrag": 0.00,
      "zusatzangaben": "weitere Spalten als \\"Bezeichnung: Wert; …\\" oder null",
      "abschnitt": "Abschnitt mit eigener Zwischensumme oder null",
      "belegzeilen": [
        {
          "beleg": "Art und Nummer des Belegs, z. B. Fremdlaborrechnung FL-123",
          "nummer": "BEL-/BEB-Nummer, Artikelnummer o. ä. oder null",
          "leistung": "Bezeichnung der Belegzeile",
          "menge": "Zahl oder null",
          "einzelpreis": "Zahl oder null",
          "betrag": 0.00
        }
      ]
    }
  ],
  "kontrollsummen": {
    "rechnungsbetrag": 0.00,
    "zwischensummen": [ { "abschnitt": "Bezeichnung wie auf der Rechnung", "betrag": 0.00 } ]
  }
}`;

function kopfzeilen({ nameArzt, rechnungsdatum, gesamtbetrag, istTier, dokumentart }) {
  const z = [];
  if (dokumentart) z.push(`Dokumentart: ${dokumentart}`);
  if (nameArzt) z.push(`Leistungserbringer: ${nameArzt}`);
  if (rechnungsdatum) z.push(`Rechnungsdatum: ${rechnungsdatum}`);
  if (gesamtbetrag != null) z.push(`Rechnungsbetrag laut Klassifikation: ${gesamtbetrag} €`);
  if (istTier) z.push('Behandelt wurde ein Tier (GOT).');
  return z.length ? `BEKANNT AUS DER KLASSIFIKATION\n${z.join('\n')}\n\n` : '';
}

const REGELN = `REGELN

P1. Vollständigkeit: Lies JEDE Seite des Dokuments und gib JEDE Position aus,
    die auf der Rechnung einen eigenen Betrag trägt — in der Reihenfolge der
    Rechnung. Überspringe nichts, fasse nichts zusammen, kürze nichts ab.
    Zwischensummen, Überträge, Seitensummen und Endsummen sind keine
    Positionen. Das gilt auch für eine Zeile, die wie eine Position aussieht,
    deren Betrag aber die Summe einzeln aufgeführter Zeilen ist (z. B.
    "Kosten für Auslagen …" unter einer Auslagentabelle).
P2. betrag: der Betrag der Zeile, wie ihn die Rechnung ausweist (bei einer
    Anzahl > 1 also der Zeilenbetrag, nicht der Einzelpreis). Minderungen,
    Abzüge und Gutschriften (z. B. Minderung nach § 6a GOÄ) sind eigene
    Positionen mit NEGATIVEM Betrag.
P3. begruendung: im vollen Wortlaut. Verweist die Rechnung nur auf eine
    Begründung, die an anderer Stelle steht (Legende, Fußnote, Kennbuchstabe,
    Nummer, „s. Begründung 3“, Sternchen), schlage sie dort nach und schreibe
    den VOLLEN Text der Begründung in dieses Feld, buchstabengetreu und ohne
    Korrekturen. Gib nie einen bloßen Verweis aus. Führt die Rechnung eine
    Verweisspalte (z. B. "Bgr."), löse JEDES gesetzte Kennzeichen auf, auch
    bei Positionen mit niedrigem Faktor. Treffen mehrere Begründungen zu, übernimm alle, getrennt durch
    " | ". Hat die Position keine Begründung, null.
P4. Bei menschlichen GOÄ-/GOZ-Positionen mit Faktor über 2,3 sorgfältig nach
    der Begründung suchen; sie ist dort Pflicht und steht oft gesammelt am
    Ende der Rechnung. Bei Tieren (GOT) besteht diese Pflicht nicht; eine
    vorhandene Begründung trotzdem übernehmen.
P5. zusatzangaben: alle weiteren Angaben der Position, die die Rechnung in
    eigenen Spalten oder Zusätzen führt und die in keinem anderen Feld stehen
    (z. B. Zahn/Region, Anzahl, Seite, Uhrzeit, Kennzeichen). Format
    "Bezeichnung: Wert; Bezeichnung: Wert" mit den Spaltenüberschriften der
    Rechnung als Bezeichnung, z. B. "Region: 13; Anzahl: 2". Eine
    Verweisspalte auf Begründungen gehört nicht hierher, ihr Inhalt steht
    aufgelöst in begruendung. Keine weiteren Angaben → null.
P6. ziffer: Kennung wie auf der Rechnung mit allen Zeichen, z. B. "1", "3",
    "250", "Ä0001", "PZN12345",
    "GOZ 1010", "GOT 12", eine BEB-/BEL-Nummer. Medikamente, Material und
    sonstige Positionen ohne Kennung bleiben null.
P7. Beigefügte Belege sind eigene Schriftstücke mit eigenem Kopf hinter der
    Rechnung (Fremdlaborrechnung, Praxislaborbeleg, Materialbeleg). Führt die
    Rechnung die Summe eines oder mehrerer solcher Belege als eigene Zeile
    (z. B. "Auslagen gemäß Fremdlaborrechnung"), ist genau diese Zeile die
    Position, auch wenn sie mehrere Belege zusammenfasst. Die Zeilen der
    Belege sind dann KEINE Positionen: Gib JEDE Belegzeile mit eigenem Betrag
    in "belegzeilen" dieser Position aus; "beleg" nennt je Zeile ihren Beleg.
    Weist ein Beleg Mehrwertsteuer, Versand oder Rabatte gesondert aus, ist
    jede davon eine eigene Belegzeile (z. B. leistung "MwSt", ohne
    nummer), sodass alle Belegzeilen zusammen exakt den Betrag der Position
    ergeben. betrag einer Belegzeile ist ihr Zeilenbetrag (Menge ×
    Einzelpreis); Zwischen- und Endsummen eines Belegs sind keine Belegzeilen.
    Davon zu unterscheiden sind Auslagen, Material und Medikamente, die die
    Rechnung SELBST Zeile für Zeile mit Betrag aufführt: Das sind einzelne
    Positionen (P1) ohne Belegzeilen, ihre Summenzeile ist keine Position.
    Positionen ohne beigefügten Beleg haben "belegzeilen": [].
P8. abschnitt: Weist die Rechnung Zwischensummen für Abschnitte aus (z. B.
    "Honorar", "Material- und Laborkosten"), trägt jede Position den Namen
    ihres Abschnitts genau so, wie er in kontrollsummen.zwischensummen steht.
    Ohne Abschnitte null und zwischensummen leer.
P9. kontrollsummen.rechnungsbetrag: der Endbetrag der Rechnung, den der
    Patient zahlen soll.
P10. Rezept: Positionen sind ausschließlich die Medikamente aus dem
    Apothekenbeleg (tatsächlich abgegeben); verordnete, aber nicht abgegebene
    Medikamente entfallen. Weicht die taxierte PZN im Apothekenbeleg von der
    PZN der Verordnung ab, verwende die PZN aus dem Apothekenbeleg und setze
    der Arzneimittelbezeichnung das Präfix "[GENERIKUM] " voran.
P11. Zahlen als JSON-Zahl mit Punkt als Dezimaltrenner, Datumsangaben als
    YYYY-MM-DD.`;

/**
 * @param {object} kontext - { nameArzt, rechnungsdatum, gesamtbetrag, istTier, dokumentart }
 */
export function buildPositionenPrompt(kontext = {}) {
  return `Du liest die Einzelpositionen einer medizinischen Rechnung vollständig aus.

${kopfzeilen(kontext)}${REGELN}

Antworte ausschließlich mit einem JSON-Objekt in dieser Form:
${AUSGABE}`;
}

/**
 * @param {object}   kontext
 * @param {string[]} befunde - gescheiterte Prüfungen der vorigen Lesung
 * @param {object}   vorher  - Ergebnis der vorigen Lesung (geparstes JSON) oder null
 */
export function buildNachlesePrompt(kontext = {}, befunde = [], vorher = null) {
  const vorherText = vorher
    ? `\nVORIGE LESUNG (nur zum Abgleich, NICHT als Vorlage abschreiben):\n${JSON.stringify(vorher)}\n`
    : '';
  return `Du liest die Einzelpositionen einer medizinischen Rechnung vollständig aus.
Eine vorige Lesung ist an folgenden Prüfungen gescheitert:
${befunde.map((b) => `- ${b}`).join('\n')}
${vorherText}
Lies das GANZE Dokument Seite für Seite erneut und sorgfältig. Typische
Ursachen: übersprungene Positionen (oft auf Folgeseiten oder nach einem
Seitenumbruch), Minderungen ohne negatives Vorzeichen, Zwischensummen als
Position gezählt, Belegzeilen statt der Sammelzeile übernommen, Belegzeilen
unvollständig oder ohne die Mehrwertsteuerzeile des Belegs, eine Begründung
nur als Verweis statt im Volltext.

${kopfzeilen(kontext)}${REGELN}

Antworte ausschließlich mit einem JSON-Objekt in dieser Form:
${AUSGABE}`;
}

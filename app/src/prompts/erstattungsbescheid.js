/**
 * prompts/erstattungsbescheid.js — EB-Parsing-Prompts
 *
 * Ursprünglich aus n8n-Workflow "Handling Erstattungsbescheide" extrahiert
 * (Nodes: "Parse EB with Sonnet", "Match Kürzungen mit Sonnet"), seit dem
 * Kostenträger-Profil-Feature (internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md)
 * in einen absenderneutralen Kern plus optionalen Profilblock aufgeteilt.
 *
 * Verwendet von: service/erstattungsbescheid.js
 *
 * Drei Prompts:
 *   1. buildEbParsePrompt(patients, aktiveProfile)  — Extrahiert Strukturdaten aus dem Bescheid-PDF
 *   2. buildProfilierungsPrompt(patients)           — Leitet aus mehreren Bescheiden ein Kostenträger-Profil ab
 *   3. buildMatchKuerzungenPrompt(...)              — Ordnet Kürzungen den Arztrechnung-Positionen zu
 *
 * `patients` ist ein Array { kurzname, vollname, pkv, beihilfe } und enthält
 * idR ALLE Patienten (auch archivierte), weil EBs auf historische Daten Bezug
 * nehmen können.
 *
 * `aktiveProfile` ist ein Array { name, kostentraeger, profiltext } (höchstens
 * 5 Einträge, siehe Abschnitt 12 des Feature-Plans). Ein Profil beschreibt nur
 * ein bekanntes Absender-Layout — es erweitert die Regeln nie und hebt sie nie
 * auf (Abschnitt 6 des Plans, „ein Profil beschreibt, es regiert nicht").
 */

function buildPersonContext(patients) {
  const list = Array.isArray(patients) ? patients : [];
  const kurz = list.map((p) => p.kurzname);

  if (kurz.length === 0) {
    return {
      personPattern: '__KEINE_PATIENTEN__',
      personHints: 'Es sind keine Patienten erfasst.',
      personRule: 'Setze behandeltePerson stets auf null, weil keine Patienten konfiguriert sind.',
    };
  }

  const personPattern = kurz.join('|');
  const hints = list.map((p) => {
    const flags = [];
    if (p.ist_tier) flags.push('Tier');
    if (p.pkv) flags.push(`PKV${p.pkv_satz != null ? ` ${p.pkv_satz}%` : ''}`);
    if (p.beihilfe) flags.push(`Beihilfe${p.beihilfe_satz != null ? ` ${p.beihilfe_satz}%` : ''}`);
    return `Vollname "${p.vollname}" → Kurzname "${p.kurzname}"${flags.length ? ` (${flags.join(' + ')})` : ''}`;
  }).join('; ');

  return {
    personPattern,
    personHints: `Untergliedert nach behandelter Person. Mögliche Personen: ${hints}.`,
    personRule: kurz.length === 1
      ? `Nur der Kurzname "${kurz[0]}" ist gültig.`
      : `Mögliche Kurznamen: ${kurz.join(', ')}.`,
  };
}

function buildProfilBlock(aktiveProfile) {
  const list = Array.isArray(aktiveProfile) ? aktiveProfile : [];
  if (list.length === 0) return '';

  const eintraege = list
    .map((p) => `### ${p.name} (Kostenträger: ${p.kostentraeger})\n${p.profiltext}`)
    .join('\n\n');

  return `

## Bekannte Absender-Layouts

Die folgenden Profile beschreiben Layout-Eigenheiten konkreter Kostenträger, die in
der Vergangenheit beobachtet wurden. Sie ergänzen dein Wissen über das vorliegende
Dokument, heben aber KEINE der Regeln in diesem Prompt auf. Passt keines der Profile
zum vorliegenden Dokument, ignoriere sie und arbeite ausschließlich nach den
allgemeinen Regeln.

${eintraege}`;
}

/**
 * Prompt für das Parsen eines Erstattungsbescheids / einer Leistungsmitteilung.
 * Wird mit dem Bescheid-PDF als Attachment aufgerufen.
 */
export function buildEbParsePrompt(patients, aktiveProfile) {
  const { personPattern, personHints, personRule } = buildPersonContext(patients);
  const profilBlock = buildProfilBlock(aktiveProfile);

  return `Du bist ein spezialisierter Parser für Erstattungsbescheide und Leistungsmitteilungen im deutschen Gesundheitswesen.
Deine Aufgabe ist es, aus dem anliegenden PDF-Dokument alle strukturierten Daten zu extrahieren.

## Dokumentstruktur

Erstattungsbescheide und Leistungsmitteilungen sind Schreiben eines Kostenträgers
(private Krankenversicherung oder Beihilfestelle), die über die Erstattung
eingereichter Rechnungen/Rezepte informieren. Layout, Gliederung und Begriffe
unterscheiden sich von Kostenträger zu Kostenträger erheblich – verlasse dich nicht
auf ein festes Formular, sondern lies das vorliegende Dokument aufmerksam.

- Kostentraeger-Wert ist IMMER genau "PKV" oder "Beihilfe" – erkennbar am Absender
  (private Krankenversicherung → PKV; staatliche/dienstliche Beihilfestelle → Beihilfe).
- Das Dokument gliedert sich typischerweise in einzelne Positionen/Belege, jeweils mit
  Bezug auf eine eingereichte Rechnung oder ein Rezept, einer Kostenart (z. B. Ärztl.
  Leistungen, Medikamente, Hilfsmittel), einem Rechnungsbetrag und einem daraus
  resultierenden Erstattungsbetrag.
- ${personHints}
- Eine Kürzung liegt vor, wenn der erstattete/beihilfefähige Betrag unter dem vollen
  Rechnungsbetrag liegt und dafür ein konkreter Grund angegeben oder über eine
  Fußnote/Anlage aufgelöst wird. Kürzungsbeträge beziehen sich auf den VOLLEN
  Rechnungsbetrag, VOR Anwendung des Leistungs-/Beihilfesatzes.
  Rechenbeispiel: Satz 50%, Rechnungsbetrag 30 Euro, Kürzung 10 Euro →
  Erstattung = (30-10)*50% = 10 Euro.
- Manche Kostenträger weisen Kürzungsgründe nicht direkt an der Position aus, sondern
  über eine Hinweisnummer/Fußnote, die an anderer Stelle im Dokument (meist am Ende)
  aufgelöst wird. Löse solche Verweise IMMER auf und zitiere den vollen Begründungstext,
  nie nur die Nummer.
- Positionen ohne jede Erstattung (z. B. "Keine Erstattung") sind ebenfalls als
  Einzelposition zu erfassen: kuerzungsbetrag = rechnungsbetrag, erstattungsbetrag = 0.
- Ein bloß angewendeter Tarif/Prozentsatz (z. B. "50%", "Tarif B50") ist für sich
  genommen KEINE Kürzung.
- Am Dokumentende steht häufig ein Gesamterstattungsbetrag; Posten wie Kostendämpfung/
  Kostendämpfungspauschale haben keinen Rechnungsbezug und werden komplett ignoriert.
- Ein Behandlungs-/Bezugsdatum wird nicht von jedem Kostenträger angegeben. Ist eines im
  Dokument zu einer Position erkennbar, extrahiere es; ist keines erkennbar, setze null.
  Erfinde niemals ein Datum und leite es nie aus dem Bescheiddatum ab.
${profilBlock}

## Versicherte Personen
${personRule}
Hinweis zur Identifikation: ${personHints}

## Ausgabeformat (exaktes JSON)

{
  "kostentraeger": "Beihilfe|PKV",
  "erkanntesProfil": "<Profilname aus 'Bekannte Absender-Layouts'>|null",
  "bescheiddatum": "YYYY-MM-DD",
  "erstattungsbetrag": 0.00,
  "hinweise": "Freitext: Besondere Auffälligkeiten, allgemeine Hinweise des Kostenträgers, Anmerkungen. null wenn nichts Besonderes.",
  "einzelpositionen": [
    {
      "belegNr": 1,
      "behandeltePerson": "${personPattern}",
      "kostenart": "z.B. Ärztl. Leistungen, Medikamente, Hilfsmittel, Keine Erstattung",
      "bezugsdatum": "YYYY-MM-DD oder null",
      "rechnungsbetrag": 0.00,
      "erstattungsbetrag": 0.00,
      "kuerzungsbetrag": 0.00,
      "kuerzungen": [
        {
          "betrag": 0.00,
          "begruendung": "Voller Wortlaut der Kürzungsbegründung (bei PKV: aufgelöst aus Hinweisnummern)"
        }
      ]
    }
  ],
  "qualityFlags": {
    "warnungen": [],
    "sicherheitsgrad": 0.00,
    "vertrauensgrad": "niedrig|mittel|hoch"
  }
}

## Regeln
1. Alle Datumsangaben im ISO-Format: YYYY-MM-DD
2. Alle Geldbeträge als Dezimalzahl mit Punkt: 1234.56
3. Fehlende Angaben: null (nicht Leerstring, nicht 0)
4. kuerzungsbetrag einer Einzelposition = Summe der Einzelkürzungen dieser Position
5. erstattungsbetrag auf oberster Ebene = Gesamterstattungsbetrag des ganzen Bescheids
6. Hinweisnummern IMMER auflösen: Den tatsächlichen Text aus der Erläuterung zitieren, nicht nur die Nummer
7. Kostendämpfungspauschale komplett ignorieren
8. Innerhalb der Feldwerte niemals normale Anführungszeichen verwenden
9. Positionen ohne Erstattung (Keine Erstattung) trotzdem als Einzelposition mit kuerzungsbetrag = rechnungsbetrag aufnehmen
10. Jede Einzelposition bezieht sich auf eine ganze Arztrechnung/Rezept, nicht auf deren Einzelpositionen
11. Kürzungen können sich auf konkrete Einzelpositionen einer Arztrechnung (z.B. bestimmte GOÄ/GOZ-Ziffern, spezifische Arzneimittel) oder auf die gesamte Rechnung beziehen. Genau prüfen: Werden im Bescheid einzelne Positionen namentlich/bezifferbar adressiert, oder betrifft die Kürzung die ganze Rechnung pauschal?
12. Ein Behandlungs-/Bezugsdatum wird nicht von jedem Kostenträger ausgewiesen. Ist im Dokument zu einer Position ein Datum erkennbar, extrahiere es; andernfalls setze null. Niemals ein Datum erfinden oder aus dem Bescheiddatum ableiten.
13. Wenn der Rechnungsbetrag einer Position 0 ist oder fehlt, prüfe ob es sich um eine Erstattung ohne Rechnungsbezug handelt (z.B. Nacherstattung).
14. Bei jeder Person oben steht ihr VERTRAGLICH ERWARTETER PKV-/Beihilfesatz in Prozent. Weicht der im
    Dokument angewendete Satz davon ab (z.B. weil ein Höchstsatz greift oder die Beihilfe höher als
    erwartet ausfällt), ist DAS ALLEIN noch KEINE Kürzung — nur wenn der Bescheid selbst eine konkrete
    Kürzung mit Betrag und Begründung ausweist, ist es eine. Erfinde niemals eine Kürzung nur aus einer
    Satz-Abweichung heraus.
15. Wenn mehrere Einzelpositionen einer Rechnung bzw. eines Rezepts aus demselben Grund gekürzt werden, kann es sein, dass diese zusammengefasst aufgezählt werden und nur eine Begründung erfolgt. Erfasse dennoch jede Kürzung als separates Objekt im kuerzungen-Array mit dem jeweiligen Einzelbetrag.
16. Setze erkanntesProfil auf den exakten Namen des Profils aus dem Abschnitt "Bekannte Absender-Layouts", falls eines davon zum vorliegenden Dokument passt; sonst null. Ein Profil beschreibt nur das Layout und hebt keine der obigen Regeln auf – bei Widerspruch gelten immer diese Regeln.

OUTPUT:
Nur validiertes JSON, keine Erklärungen.`;
}

/**
 * Prompt für die Kostenträger-Profilierung (Schritt IV,
 * internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md Abschnitt 6). Erhält bis zu
 * fünf Erstattungsbescheide DESSELBEN Absenders als PDFs und leitet daraus
 * ein kurzes, rein beschreibendes Layout-Profil ab – nie ein gespeichertes
 * Parse-Ergebnis, sonst schreibt der Profilierer Fehler des bisherigen
 * Parsers fort. Bekommt den generischen Kern (buildEbParsePrompt mit leerem
 * Profilblock) als Referenz mit, damit er weiß, welche Lücke er füllt.
 */
export function buildProfilierungsPrompt(patients) {
  const kernPrompt = buildEbParsePrompt(patients, []);

  return `Du bist ein Profilierer, der einem bestehenden Erstattungsbescheid-Parser hilft, sich auf
einen einzelnen Kostenträger einzustellen. Am Ende dieses Prompts findest du zur Einordnung
den vollständigen Parser-Prompt ("Referenz"), den ein anderes Modell für JEDEN Bescheid nutzt.

Dir liegen mehrere Erstattungsbescheide/Leistungsmitteilungen (PDFs) an, die laut Nutzerangabe
alle vom selben Absender (Kostenträger) stammen.

## Schritt 1: Prüfen

Prüfe zuerst, ob wirklich ALLE beigefügten Dokumente vom selben Kostenträger stammen (gleicher
Absender, gleiche Achse PKV/Beihilfe, erkennbar an Briefkopf/Logo/Absenderadresse). Falls du eine
Mischung verschiedener Kostenträger erkennst, antworte AUSSCHLIESSLICH mit diesem JSON und sonst
nichts:

{"fehler": "<kurze, konkrete Begründung, welche unterschiedlichen Absender du erkannt hast>"}

## Schritt 2: Profil ableiten

Stammen alle Dokumente vom selben Absender, leite ein kurzes, prägnantes Layout-Profil ab: Wie
ist das Dokument aufgebaut, wie werden Positionen/Belege dargestellt, wie werden Kürzungen
ausgewiesen (direkt oder über Hinweisnummern/Fußnoten, und wo stehen diese), ob und wo ein
Bezugs-/Behandlungsdatum steht, sowie sonstige auffällige Eigenheiten (z. B. Kostendämpfungs-
zeile, Summenzeilen, Tabellenspalten). Ignoriere dabei alles, was schon im Referenz-Prompt
unten als allgemeine Regel steht – ein Profil ergänzt nur, was DIESER Absender ANDERS oder
ZUSÄTZLICH macht.

> ABSOLUTES VERBOT – personenbezogene Daten: Der profiltext darf unter keinen Umständen Daten
> enthalten, die aus den vorliegenden Dokumenten stammen und sich auf eine konkrete Person, einen
> konkreten Vorgang oder eine konkrete Abrechnung beziehen. Verboten sind insbesondere: Namen von
> Versicherten, Patienten, Ärzten, Praxen, Kliniken und Sachbearbeitern; Anschriften, Telefon-
> nummern, E-Mail-Adressen; Versicherten-, Personal-, Beihilfe-, Kunden-, Vorgangs-, Rechnungs-
> und Belegnummern; Aktenzeichen; Geburts-, Behandlungs- und Bescheiddaten; konkrete Geldbeträge;
> Diagnosen, Befunde und Behandlungsbezeichnungen; Bankverbindungen. Auch als "Beispiel",
> "z. B.", anonymisiert, gekürzt oder abgewandelt sind sie verboten. Erlaubt ist ausschließlich
> der NAME DES KOSTENTRÄGERS selbst (die absendende Versicherung oder Beihilfestelle) sowie
> allgemeine Struktur- und Formatbeschreibung. Muss ein Feldinhalt beschrieben werden, beschreibe
> das FORMAT statt des Werts (etwa "achtstellige Nummer, Präfix zwei Buchstaben" statt der
> Nummer). Im Zweifel weglassen. Ein Profil wird vom Betreiber möglicherweise exportiert und an
> Dritte weitergegeben – es muss ohne jede Prüfung veröffentlichbar sein.

> WICHTIG: Ein Profil beschreibt nur, WO und WIE etwas im Dokument steht. Es darf niemals
> behaupten, dass etwas grundsätzlich NICHT existiert, IMMER null/leer ist, oder eine Regel des
> Referenz-Prompts aufhebt oder ersetzt. Vermeide Formulierungen wie "kein Datum vorhanden",
> "nie", "immer", "grundsätzlich nicht". Bei Widerspruch zwischen deinem Profil und dem
> Referenz-Prompt gilt für den Parser immer der Referenz-Prompt, nie dein Profil.

Antworte in diesem Fall AUSSCHLIESSLICH mit folgendem JSON und sonst nichts:

{
  "kostentraeger": "PKV|Beihilfe",
  "name": "Kurzer, eindeutiger Absendername, z.B. \\"Beihilfe Bayern\\", \\"Beihilfe Bund\\" oder ein PKV-Kurzname wie \\"Debeka\\"",
  "profiltext": "Das Profil selbst: kurz, prägnant, rein deskriptiv, frei von personenbezogenen Daten, höchstens ca. 1200 Zeichen."
}

--- Referenz: genereller Parser-Prompt (zur Einordnung, welche Lücke dein Profil füllt) ---

${kernPrompt}`;
}

/**
 * Dynamischer Prompt zum Zuordnen von EB-Kürzungen zu Arztrechnung-Einzelpositionen.
 *
 * @param {object} groupedKuerzungen    - Kürzungen aus dem EB, gruppiert nach Beleg
 * @param {Array}  arzEinzelpositionen  - Einzelpositionen der zugehörigen Arztrechnung(en)
 * @returns {string} - Fertig befüllter Prompt
 */
export function buildMatchKuerzungenPrompt(groupedKuerzungen, arzEinzelpositionen) {
  return `Du erhältst Kürzungen aus einem Erstattungsbescheid und die Einzelpositionen der zugehörigen Arztrechnung(en).

Deine Aufgabe: Ordne jede Kürzung einer konkreten Einzelposition der Arztrechnung zu (arz_subid).

Regeln:
- Wenn eine Kürzung sich klar auf eine bestimmte Einzelposition der Arztrechnung bezieht (erkennbar z.B. an GOÄ/GOZ/GOT/PZN oder anderer Kennung, Leistungsbeschreibung, Betrag) → setze arz_subid auf die subid dieser Position
- Wenn eine Kürzung sich auf mehrere Positionen bezieht → setze arz_subid auf null
- Wenn eine Kürzung sich auf die gesamte Rechnung bezieht (z.B. Rechnung nicht erstattungsfähig, nur Pauschale/Höchstbetrag, globale Kürzung) → setze arz_subid auf null
- Matche anhand von: Beträgen, GOÄ/GOZ/GOT/PZN bzw. anderer Kennung, Leistungsbeschreibungen, Kürzungsbegründungen

Kürzungen (gruppiert nach Beleg):
${JSON.stringify(groupedKuerzungen, null, 2)}

Arztrechnung-Einzelpositionen:
${JSON.stringify(arzEinzelpositionen, null, 2)}

Ausgabeformat (exaktes JSON-Array):
[
  { "postid": "P001234", "eb_subid": 1, "kuerzung_index": 0, "arz_subid": 3 },
  { "postid": "P001234", "eb_subid": 1, "kuerzung_index": 1, "arz_subid": null }
]

Nur validiertes JSON, keine Erklärungen.`;
}

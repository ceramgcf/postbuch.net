/**
 * Statischer Katalog der mit postbuch.net mitgelieferten Kostenträger-Profile
 * (Layoutwissen für den generischen EB-Parse-Prompt, siehe
 * prompts/erstattungsbescheid.js und internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md).
 *
 * Diese Einträge sind reiner Code, keine Datenbankzeilen. Erst wenn ein Admin
 * einen Eintrag im UI aktiviert, wird er einmalig als Zeile in
 * postbuch.kostentraeger_profil materialisiert (quelle='mitgeliefert',
 * katalog_schluessel = schluessel, katalog_version = version). Ein
 * App-Update darf eine bereits materialisierte, aktive Zeile nie stillschweigend
 * überschreiben — der Vergleich der eigenen `version` gegen die auf der Zeile
 * gespeicherte `katalog_version` entscheidet, ob dem Admin ein Update angeboten
 * wird (service/kostentraeger-profil.js, listKatalog()).
 *
 * `version` bei jeder inhaltlichen Änderung von `profiltext` hochzählen.
 * `schluessel` ist stabil und darf sich nie ändern (Fremdschlüssel-Ersatz für
 * bereits materialisierte Zeilen); ein neuer Kostenträger bekommt einen neuen
 * Eintrag, kein Wiederverwenden eines alten schluessel.
 */

export const KOSTENTRAEGER_PROFIL_KATALOG = Object.freeze([
  Object.freeze({
    schluessel: 'debeka',
    name: 'Debeka',
    kostentraeger: 'PKV',
    version: 1,
    profiltext:
      'Debeka-Leistungsmitteilung (Briefkopf Debeka Krankenversicherungsverein a. G., Leistungszentrum 56078 Koblenz, Service-Nr. rechts oben, darunter das Bescheiddatum). Einleitung: "Ihren Leistungsauftrag speicherten wir am TT.MM.JJJJ" (Eingangsdatum, nicht das Bescheiddatum). Danach je versicherter Person ein grau hinterlegter Namensblock mit eigener Tabelle: Spalten Kostenart | Rechnungsbetrag(EUR) | Behandlungs-/Bezugsdatum | Leistungsbetrag(EUR) | Tarif | Kürzung (EUR) | Hinweis. Die Kostenart steht nur in der ersten Zeile einer Gruppe; Folgezeilen erben sie (leere Kostenart-Zelle). Jede Zeile ist ein eigener Beleg mit eigenem Bezugsdatum. In der Tarif-Spalte steht ein kurzes Tarifkürzel aus Buchstabe und Zahl, teils mehrere durch Schrägstrich verbunden. Nicht erstattete Belege erscheinen als Kostenart "Keine Erstattung" mit leerem Leistungsbetrag und einer Ziffer in der Hinweis-Spalte; diese Ziffern werden am Dokumentende unter der Überschrift "Erläuterung der Hinweise" als nummerierte Liste aufgelöst. Pro Person eine Zeile "Zwischensumme", am Ende "Gesamtsumme" (Rechnungssumme und Leistungssumme). Darunter Zahlungstabelle (Kontoinhaber, Betrag, BIC, IBAN) mit dem ausgezahlten Gesamtbetrag. Der Leistungsmitteilung kann ein separates Anschreiben zur Beitragsrückerstattung (BRE) vorangestellt sein; dessen Beträge gehören nicht zu den Einzelpositionen.',
  }),
  Object.freeze({
    schluessel: 'beihilfe-saarland-pbeakk',
    name: 'Beihilfe Saarland (PBeaKK)',
    kostentraeger: 'Beihilfe',
    version: 1,
    profiltext:
      'Absender: Postbeamtenkrankenkasse / Beihilfedienste Saarland für das Landesamt für Zentrale Dienste. Seite 1: Anschreiben mit Bescheiddatum rechts im Kopf (neben Beihilfenr. und "Seite 1"), Vorgangsnummer, Eingangsdatum der Belege, Summe der Aufwendungen sowie Block "Beihilfe X EUR", ggf. Zeile "Abzug Kostendämpfungspauschale" und Gesamtbetrag der Überweisung. Danach folgt die Tabelle "Erstattungsübersicht" mit Spalten Beleg / Art / Rechnung / Auszahlung / Differenz und Summenzeile; Zwischenzeilen "Abzug Kostendämpfung" stehen unter einzelnen Belegen. Anschließend Abschnitt "Begründungen": je Beleg ein Block mit Belegnummer, Art und Rechnungsbetrag in der Kopfzeile, darunter der Name der behandelten Person, dann eine oder mehrere Zeilen "Beihilfe (X % von beihilfefähigen Y Euro): Betrag", ggf. "Abzüglich Kostendämpfung: -Betrag", und "Summe:". Kürzungsbegründungen stehen als Freitext direkt unter dem jeweiligen Belegblock, oft eingeleitet durch einen Präparatnamen mit Betrag (Muster: Arzneimittelname, Betragsart, Betrag in Euro) oder als Auflistung mehrerer nicht beihilfefähiger Arzneimittel mit Einzelbeträgen, gefolgt vom Erläuterungstext; Hinweisnummern werden nicht verwendet. Die abgesenkte "beihilfefähige" Basis gegenüber dem Rechnungsbetrag zeigt die Kürzungshöhe. Am Dokumentende: Abschnitt "Information zur Kostendämpfungspauschale" mit Jahrestabelle. Zusätzlich möglich: "Allgemeine Hinweise" zur Belegaufbewahrung und Werbetext zu PBeaKKDirekt.',
  }),
]);

export function findKatalogEintrag(schluessel) {
  return KOSTENTRAEGER_PROFIL_KATALOG.find((e) => e.schluessel === schluessel) || null;
}

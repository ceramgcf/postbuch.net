/**
 * service/perioden-sperre.js — Sperrhierarchie für Abrechnungsperioden und
 * Bescheidzuordnungen.
 *
 * Mehrere Erstattungsbescheide desselben Kostenträgers können gleichzeitig
 * eingehen (die EB-Verarbeitung läuft als eigener Hintergrundjob neben der
 * Pipeline-Queue), dazu kommen Abrechnungssessions, manuelle
 * Periodenoperationen und neue Arztrechnungen. Alle diese Wege lesen und
 * verändern dieselben Perioden. Damit kein Weg auf einem veralteten Stand
 * entscheidet, gilt eine feste Reihenfolge — wer sie einhält, kann nicht in
 * eine Verklemmung mit einem anderen Weg geraten:
 *
 *   1. Bescheidzuordnung je Kostenträger (`sperreBescheidzuordnung`)
 *      Serialisiert alles, was Rechnungen einem Bescheid zuordnet oder diese
 *      Zuordnung samt Periodenwirkung zurücknimmt: Matching einer
 *      EB-Verarbeitung, manuelle Zuordnung, Löschen/Ersetzen eines Bescheids.
 *      Ohne sie lesen zwei parallele Bescheide denselben eingereichten
 *      Rechnungsbestand und verbuchen dieselbe Rechnung doppelt, während eine
 *      baugleiche zweite Rechnung offen bleibt.
 *   2. Perioden je Person und Kostenträger (`sperrePerioden`)
 *      Serialisiert Statuswechsel, Periodenanlage (MAX+1) und das Umbuchen von
 *      Rechnungen zwischen Perioden. Der Arztrechnungs-Trigger
 *      `set_abrechnungsperioden_from_buch` nimmt dieselbe Sperre geteilt, damit
 *      eine neue Rechnung nie in eine Periode fällt, die gerade eingereicht wird.
 *   3. Zeilensperren (`FOR UPDATE`) auf den Periodenzeilen.
 *
 * Beide Sperren sind transaktionsgebunden (`pg_advisory_xact_lock`) und enden
 * mit COMMIT/ROLLBACK. Sie wirken nur innerhalb einer offenen Transaktion.
 */

const KOSTENTRAEGER = ['Beihilfe', 'PKV'];

/**
 * Sperrt die Bescheidzuordnung für die angegebenen Kostenträger. Unbekannte
 * oder leere Werte sperren vorsichtshalber beide Kostenträger, weil dann nicht
 * feststeht, welche Perioden der Bescheid berührt.
 *
 * @param {import('pg').PoolClient} client  Client mit offener Transaktion
 * @param {Array<string|null|undefined>} kostentraegerListe
 */
export async function sperreBescheidzuordnung(client, kostentraegerListe) {
  const gewuenscht = new Set();
  for (const kt of kostentraegerListe) {
    if (KOSTENTRAEGER.includes(kt)) gewuenscht.add(kt);
    else KOSTENTRAEGER.forEach((k) => gewuenscht.add(k));
  }
  // Feste Reihenfolge, damit zwei Bescheide mit unterschiedlichem alten und
  // neuen Kostenträger sich nicht über Kreuz blockieren.
  for (const kt of KOSTENTRAEGER) {
    if (!gewuenscht.has(kt)) continue;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('postbuch.bescheidzuordnung/' || $1::text, 0))`,
      [kt],
    );
  }
}

/**
 * Sperrt die Perioden der angegebenen (Person, Kostenträger)-Paare exklusiv —
 * dedupliziert und in fester Reihenfolge. Der Schlüssel kommt aus derselben
 * SQL-Funktion, die auch der Arztrechnungs-Trigger benutzt.
 *
 * @param {import('pg').PoolClient} client  Client mit offener Transaktion
 * @param {Array<{person: string, kostentraeger: string}>} paare
 */
export async function sperrePerioden(client, paare) {
  await sperre(client, paare, 'pg_advisory_xact_lock');
}

/**
 * Geteilte Variante für Wege, die Periodenzuordnungen nur lesen und
 * übernehmen, etwa das Ersetzen einer Arztrechnung. Sie wartet laufende
 * exklusive Periodenoperationen ab und hält neue auf, bis die eigene
 * Transaktion endet; untereinander blockieren sich geteilte Sperren nicht.
 */
export async function sperrePeriodenGeteilt(client, paare) {
  await sperre(client, paare, 'pg_advisory_xact_lock_shared');
}

async function sperre(client, paare, funktion) {
  const eindeutig = new Map();
  for (const { person, kostentraeger } of paare) {
    if (person == null || kostentraeger == null) continue;
    eindeutig.set(`${kostentraeger}\u0000${person}`, { person, kostentraeger });
  }
  const sortiert = [...eindeutig.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, paar]) => paar);
  for (const { person, kostentraeger } of sortiert) {
    // `funktion` stammt ausschließlich aus den beiden Exporten oben.
    await client.query(
      `SELECT ${funktion}(postbuch.perioden_sperrschluessel($1, $2))`,
      [person, kostentraeger],
    );
  }
}

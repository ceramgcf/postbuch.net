/**
 * service/abrechnung-paket.js — reine PDF-Assembly für die Abrechnungssession
 *
 * Bewusst OHNE Zugriff auf die Session-Tabellen (_abrechnung_session_ziel/
 * _abrechnung_sessions) und ohne eigenen Storage-Upload: nimmt Dokument-
 * Metadaten/-Buffer entgegen, liefert fertige PDF-Buffer zurück. Das Hochladen
 * und das Registrieren als Artefakt übernimmt abrechnung-session.js selbst —
 * nur dort ist bekannt, dass jeder Upload sofort einen Heartbeat (Zeile +
 * session.updated_at) hinterlassen muss, damit der Cleaner ein Paket nicht
 * mitten im Lauf für tot erklärt.
 *
 * buildPruefblockBuffers()/buildPinBlockBuffers() lesen den Blockinhalt live
 * aus den fachlichen Tabellen (nicht aus den Session-Tabellen) — geschützt ist
 * das gegen Veränderung bestehender Zeilen durch die Trigger
 * fn_block_bkpp_write_during_session / fn_block_kuerzung_write_during_session
 * in base_schema.sql, die jede betroffene Vormerkung sperren, solange die
 * Session, die ihr Zieltripel reserviert hat, noch läuft. Diese Trigger
 * decken aber nur UPDATE/DELETE ab — eine brandneue Vormerkung/Anpinnung kann
 * währenddessen trotzdem entstehen (Prüfvormerkung aus frisch verarbeitetem
 * Erstattungsbescheid, manuelles Anpinnen). Beide Funktionen geben deshalb
 * zusätzlich `snapshotByTarget` zurück — die Schlüssel der Zeilen, die
 * tatsächlich in den Block eingeflossen sind, je Zieltripel. abrechnung-
 * session.js persistiert das in _abrechnung_session_ziel; confirm() vergleicht
 * beim Bestätigen live gegen diesen Snapshot statt gegen einen erneuten
 * Blockinhalt, um verspätet dazugekommene Zeilen zu erkennen.
 */

import pool from '../db.js';
import { mergePdfs, convertToGrayscale, kennzeichnePruefanlage, selectPages } from '../lib/pdf.js';
import { retrieveDocument } from './document-retriever.js';
import { generateVorblatt } from '../lib/pkv-beihilfe-vorblatt.js';
import { generatePinVorblatt } from '../lib/dokument-pin-vorblatt.js';
import { appLog } from '../app-log.js';

const PIN_HINWEIS = [
  'Beigefügte Unterlage – keine reguläre Einreichung',
  'Nur zur Kenntnisnahme beigefügt',
];

const CHUNK_LIMIT_BYTES = 3 * 1024 * 1024; // 3 MB — Kostenträger-Upload-Limit

/**
 * Berechnet Chunk-Grenzen an Dokumentgrenzen (nie mitten im Dokument schneiden).
 * @param {number[]} docSizes
 * @returns {number[][] | null}
 */
export function computeDocChunks(docSizes) {
  const total = docSizes.reduce((a, b) => a + b, 0);
  if (total <= CHUNK_LIMIT_BYTES) return null;

  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (let i = 0; i < docSizes.length; i++) {
    const s = docSizes[i];
    if (currentSize + s > CHUNK_LIMIT_BYTES && current.length > 0) {
      chunks.push(current);
      current = [i];
      currentSize = s;
    } else {
      current.push(i);
      currentSize += s;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks.length > 1 ? chunks : null;
}

/**
 * Lädt ein Dokument und filtert es beim Zusammenstellen auf den
 * Einreichungsbereich (Feature "Einreichungsseiten" — Deckblatt/Duplikat
 * bleiben so aus dem Kostenträger-Upload heraus, ohne dass das gespeicherte
 * Original angetastet wird). Ersetzt retrieveDocument + convertToGrayscale an
 * allen drei Assembly-Pfaden dieser Datei.
 *
 * Ein unparsbarer/leerer/außerhalb liegender Bereich fällt auf das ganze
 * Dokument zurück und schreibt eine appLog-Warnung — eine unvollständige
 * Einreichung wäre der teurere Fehler (siehe Feature-Dokument Abschnitt 3.5).
 * @param {string} postid
 * @param {'a4'|'a6'} [format]
 * @returns {Promise<Buffer>}
 */
async function ladeEinreichungsPdf(postid, format = 'a4') {
  const { pdf } = await retrieveDocument(postid);
  // LEFT-Match über arztrechnung: nur Arztrechnungen kennen einen
  // Einreichungsbereich (0 Zeilen für jeden anderen Dokumenttyp, z. B. Rezept
  // oder Erstattungsbescheid in der Prüfanlage — dann bleibt es beim ganzen
  // Dokument, ohne dass diese Funktion den Dokumenttyp selbst kennen muss).
  const r = await pool.query(
    `SELECT einreichung_seite_von, einreichung_seite_bis FROM postbuch.arztrechnung WHERE postid = $1`,
    [postid],
  );
  const von = r.rows[0]?.einreichung_seite_von;
  const bis = r.rows[0]?.einreichung_seite_bis;
  let gefiltert = pdf;
  if (von != null && bis != null) {
    try {
      gefiltert = await selectPages(pdf, von, bis);
    } catch (e) {
      appLog('WARN', 'abrechnung-paket',
        `Einreichungsseiten ${von}-${bis} für ${postid} außerhalb der Seitenzahl, verwende ganzes Dokument: ${e.message}`,
        { entity: 'postbuch', entityId: postid });
    }
  }
  return convertToGrayscale(gefiltert, format);
}

/**
 * Lädt + konvertiert eine Liste von Dokumenten sequentiell (echter Fortschritt).
 * Das Ergebnis hängt nur von postid und Format ab. Über `cache` (eine Map, die
 * der Aufrufer über alle Kostenträger-Gruppen einer Session weiterreicht) wird
 * ein Dokument, das z. B. für PKV UND Beihilfe eingereicht wird, nur einmal
 * konvertiert. Die Puffer werden danach nur gelesen (qpdf), Teilen ist sicher.
 * @param {Array<{postid:string, art:string}>} docs
 * @param {(index:number, total:number, postid:string, fromCache:boolean) => void} onDocProgress
 * @param {Map<string, Buffer>} [cache]
 * @returns {Promise<Buffer[]>} Puffer in derselben Reihenfolge wie docs
 */
export async function convertDocuments(docs, onDocProgress = () => {}, cache = new Map()) {
  const buffers = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const format = d.art === 'rezept' ? 'a6' : 'a4';
    const key = `${d.postid}|${format}`;
    const fromCache = cache.has(key);
    onDocProgress(i, docs.length, d.postid, fromCache);
    if (!fromCache) cache.set(key, await ladeEinreichungsPdf(d.postid, format));
    buffers.push(cache.get(key));
  }
  return buffers;
}

/** Merged eine Liste bereits konvertierter PDF-Puffer zu einem Gesamt-PDF. */
export async function mergeGroupPdf(buffers) {
  return mergePdfs(buffers);
}

/**
 * Baut, falls nötig, die Kostenträger-Upload-Chunks (je ≤3 MB, nie mitten im
 * Dokument geschnitten). Gibt null zurück, wenn kein Chunking nötig ist.
 * @param {Buffer[]} buffers
 * @returns {Promise<Array<{pdf:Buffer, documentCount:number}> | null>}
 */
export async function buildChunkPdfs(buffers) {
  const chunkIndexGroups = computeDocChunks(buffers.map((b) => b.length));
  if (!chunkIndexGroups) return null;

  const chunks = [];
  for (const idxs of chunkIndexGroups) {
    const chunkBuffers = idxs.map((i) => buffers[i]);
    const pdf = await mergePdfs(chunkBuffers);
    chunks.push({ pdf, documentCount: idxs.length });
  }
  return chunks;
}

/**
 * Live-Query der offenen (VORGEMERKT) PKV-Prüfvormerkungen eines Zieltripels,
 * eine Zeile je Bescheidposition (mehrere Kürzungen derselben Position werden
 * zu einer Zeile zusammengefasst, ihr Kürzungsbetrag aber korrekt aufsummiert
 * — nur der Kürzungsgrund steht nicht auf dem Vorblatt, siehe dort).
 */
async function ladeVorgemerktePruefpositionen(person, periode) {
  const r = await pool.query(
    // DISTINCT ON fasst mehrere vorgemerkte Kürzungen derselben Bescheidposition
    // zu einer Vorblattzeile zusammen; die SUM-Fensterfunktion summiert dabei
    // trotzdem korrekt über ALLE dieser Kürzungen (nicht nur die zufällig
    // ausgewählte DISTINCT-ON-Zeile).
    `SELECT DISTINCT ON (b.eb_postid, b.eb_subid)
            b.eb_postid, b.eb_subid, b.erlaeuterung, k.arz_postid, ep.beleg_nr,
            e.bescheiddatum, a.rechnungsdatum, a.gesamtbetrag AS rechnungsbetrag,
            SUM(k.kuerzungsbetrag) OVER (PARTITION BY b.eb_postid, b.eb_subid) AS kuerzungsbetrag
     FROM beihilfe_kuerzung_pkv_pruefung b
     JOIN erstattungsbescheid_kuerzung k
       ON k.postid = b.eb_postid AND k.eb_subid = b.eb_subid AND k.kuerzung_id = b.kuerzung_id
     JOIN erstattungsbescheid_einzelposition ep ON ep.postid = b.eb_postid AND ep.subid = b.eb_subid
     JOIN erstattungsbescheid e ON e.postid = b.eb_postid
     LEFT JOIN arztrechnung a ON a.postid = k.arz_postid
     WHERE b.person = $1 AND b.kostentraeger = 'PKV' AND b.periode = $2 AND b.status = 'VORGEMERKT'
     ORDER BY b.eb_postid, b.eb_subid`,
    [person, periode]
  );
  return r.rows;
}

/**
 * Baut den Prüfblock (Vorblatt + gekennzeichnete Beihilfebescheide/Rechnungen)
 * für die PKV-Zielperioden einer Session. `buffers` ist [], wenn keine der
 * Zielperioden offene Prüfvormerkungen hat. `pruefungCount` (= Vorblatt-
 * Zeilen) und `bescheidCount`/`rechnungCount` (= Anzahl gekennzeichneter
 * Anlagen) gehen an den Aufrufer, damit die Session diese Zahlen (z. B. für
 * eine "Prüffälle"-Badge im Abrechnungsassistenten) weiterreichen kann.
 * @param {Array<{person:string, periode:number}>} pkvTargets
 * @returns {Promise<{buffers:Buffer[], pruefungCount:number, bescheidCount:number, rechnungCount:number, snapshotByTarget:Array<{person:string, periode:number, keys:string[]}>}>}
 */
export async function buildPruefblockBuffers(pkvTargets) {
  const zeilen = [];
  const ebIds = new Set();
  const arzIds = new Set();
  const snapshotByTarget = [];

  for (const t of pkvTargets) {
    const rows = await ladeVorgemerktePruefpositionen(t.person, t.periode);
    for (const row of rows) {
      zeilen.push({
        person: t.person,
        rechnungsdatum: row.rechnungsdatum,
        rechnungsbetrag: row.rechnungsbetrag,
        bescheiddatum: row.bescheiddatum,
        bescheidposition: row.beleg_nr || String(row.eb_subid),
        kuerzungsbetrag: row.kuerzungsbetrag,
        erlaeuterung: row.erlaeuterung || null,
      });
      ebIds.add(row.eb_postid);
      if (row.arz_postid) arzIds.add(row.arz_postid);
    }

    // Primärschlüssel-genauer Snapshot dessen, was JETZT als VORGEMERKT für
    // dieses Zieltripel gilt — bewusst eine eigene Abfrage statt aus `rows`
    // abgeleitet, weil ladeVorgemerktePruefpositionen per DISTINCT ON mehrere
    // Kürzungen derselben Bescheidposition zu einer Vorblattzeile zusammenfasst
    // und dabei den einzelnen kuerzung_id nicht mehr ausweist.
    const schluessel = await pool.query(
      `SELECT eb_postid, eb_subid, kuerzung_id FROM beihilfe_kuerzung_pkv_pruefung
       WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 AND status = 'VORGEMERKT'`,
      [t.person, t.periode]
    );
    snapshotByTarget.push({
      person: t.person,
      periode: t.periode,
      keys: schluessel.rows.map((r) => `${r.eb_postid}|${r.eb_subid}|${r.kuerzung_id}`),
    });
  }

  if (zeilen.length === 0) return { buffers: [], pruefungCount: 0, bescheidCount: 0, rechnungCount: 0, snapshotByTarget };

  const buffers = [await generateVorblatt({ zeilen })];
  for (const postid of [...ebIds, ...arzIds]) {
    const grau = await ladeEinreichungsPdf(postid, 'a4');
    buffers.push(await kennzeichnePruefanlage(grau));
  }
  return { buffers, pruefungCount: zeilen.length, bescheidCount: ebIds.size, rechnungCount: arzIds.size, snapshotByTarget };
}

/**
 * Live-Query der offenen (VORGEMERKT) Anpinnungen eines Zieltripels
 * (Person/Kostenträger/Periode).
 */
async function ladeVorgemerkteDokumentPins(person, kostentraeger, periode) {
  const r = await pool.query(
    `SELECT dp.postid, dp.grund, p.betreff, p.briefdatum
       FROM dokument_pin dp
       JOIN postbuch p ON p.postid = dp.postid
      WHERE dp.person = $1 AND dp.kostentraeger = $2 AND dp.periode = $3 AND dp.status = 'VORGEMERKT'
      ORDER BY dp.id`,
    [person, kostentraeger, periode]
  );
  return r.rows;
}

/**
 * Baut den Pin-Block (Vorblatt + gekennzeichnete Anlagen) für die Zielperioden
 * EINES Kostenträgers einer Session — anders als der PKV-Prüfblock gibt es
 * ihn für PKV UND Beihilfe. `buffers` ist [], wenn keine der Zielperioden
 * offene Anpinnungen hat.
 * @param {Array<{person:string, kostentraeger:string, periode:number}>} pinTargets
 * @returns {Promise<{buffers:Buffer[], pinCount:number, snapshotByTarget:Array<{person:string, kostentraeger:string, periode:number, postids:string[]}>}>}
 */
export async function buildPinBlockBuffers(pinTargets) {
  const zeilen = [];
  const postids = new Set();
  const snapshotByTarget = [];

  for (const t of pinTargets) {
    const rows = await ladeVorgemerkteDokumentPins(t.person, t.kostentraeger, t.periode);
    for (const row of rows) {
      zeilen.push({ person: t.person, betreff: row.betreff, briefdatum: row.briefdatum, grund: row.grund });
      postids.add(row.postid);
    }
    snapshotByTarget.push({
      person: t.person,
      kostentraeger: t.kostentraeger,
      periode: t.periode,
      postids: rows.map((r) => r.postid),
    });
  }

  if (zeilen.length === 0) return { buffers: [], pinCount: 0, snapshotByTarget };

  const buffers = [await generatePinVorblatt({ zeilen })];
  for (const postid of postids) {
    const grau = await ladeEinreichungsPdf(postid, 'a4');
    buffers.push(await kennzeichnePruefanlage(grau, { hinweisZeilen: PIN_HINWEIS }));
  }
  return { buffers, pinCount: zeilen.length, snapshotByTarget };
}

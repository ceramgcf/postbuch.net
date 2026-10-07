/**
 * lib/parallel.js — begrenzte Parallelität für Ablage-Massenoperationen
 *
 * Jede WebDAV-/Graph-Anfrage kostet einen vollen Roundtrip (bei Nextcloud auf
 * kleiner Hardware 0,2–0,6 s), unabhängig von der Dateigröße. Strikt
 * nacheinander summiert sich das bei Gesamtläufen zu Minuten; wenige
 * gleichzeitige Anfragen verkürzen das, ohne die Gegenstelle zu überlasten.
 */

/**
 * Ruft fn für jedes Element auf, höchstens `anzahl` gleichzeitig.
 * fn sollte selbst nicht werfen; tut es das doch, endet der Durchlauf mit
 * diesem Fehler, nachdem die bereits laufenden Aufrufe fertig sind.
 *
 * @template T
 * @param {T[]} elemente
 * @param {number} anzahl
 * @param {(element:T, index:number) => Promise<void>} fn
 * @param {{signal?: AbortSignal}} [opts]  Abgebrochen: kein weiteres Element
 *   wird begonnen, bereits laufende werden noch fertig.
 */
export async function fuerJedesBegrenzt(elemente, anzahl, fn, { signal } = {}) {
  let naechstes = 0;
  const worker = async () => {
    while (naechstes < elemente.length && !signal?.aborted) {
      const i = naechstes++;
      await fn(elemente[i], i);
    }
  };
  const ergebnisse = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(anzahl, elemente.length)) }, worker),
  );
  const fehler = ergebnisse.find((r) => r.status === 'rejected');
  if (fehler) throw fehler.reason;
}

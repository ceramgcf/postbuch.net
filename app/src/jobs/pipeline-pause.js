/**
 * jobs/pipeline-pause.js – wer hält die Pipeline gerade an?
 *
 * Mehrere Vorgänge halten die Pipeline unabhängig voneinander an: der
 * Ablage-Umzug, der Backend-Wechsel und die Umstellung des OneDrive-Zugriffs.
 * Jeder trägt seinen Grund ein und nimmt nur den eigenen wieder heraus. Die
 * Pipeline läuft erst weiter, wenn kein Grund mehr eingetragen ist. Mit einem
 * einzigen Schalter hätte das Ende des einen Vorgangs die Pause eines anderen
 * aufgehoben, der noch mitten in der Arbeit steckt.
 */
export function neuePausen() {
  const gruende = new Set();
  return {
    /** @returns {boolean} true, wenn dieser Grund neu eingetragen wurde */
    setzen(grund) {
      const g = String(grund || '').trim();
      if (!g) throw new Error('Pause ohne Grund');
      if (gruende.has(g)) return false;
      gruende.add(g);
      return true;
    },
    /** @returns {boolean} true, wenn damit die letzte Pause gefallen ist */
    aufheben(grund) {
      const g = String(grund || '').trim();
      if (!g || !gruende.delete(g)) return false;
      return gruende.size === 0;
    },
    aktiv(grund) {
      return grund === undefined ? gruende.size > 0 : gruende.has(String(grund).trim());
    },
    /** Der am längsten bestehende Grund, für die Anzeige. */
    grund() {
      return gruende.values().next().value ?? null;
    },
  };
}

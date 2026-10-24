// Gerätebezogene Vorgabe „Automatisch folgen beim Import“: Nach einem
// Dateiimport bzw. einem in der App gestarteten Scan wechselt postbuch.net zu
// Logs → Jobs und öffnet das fertige Dokument (siehe JobsMonitor). Geteilte
// PDFs folgen immer und hängen nicht an dieser Vorgabe.
const SCHLUESSEL = 'postbuch.importFolgen';
const VORGABE = { datei: true, scan: true };

export function leseImportFolgen() {
  try {
    const roh = JSON.parse(localStorage.getItem(SCHLUESSEL) || 'null');
    return {
      datei: typeof roh?.datei === 'boolean' ? roh.datei : VORGABE.datei,
      scan: typeof roh?.scan === 'boolean' ? roh.scan : VORGABE.scan,
    };
  } catch {
    return { ...VORGABE };
  }
}

export function schreibeImportFolgen(wert) {
  try { localStorage.setItem(SCHLUESSEL, JSON.stringify(wert)); } catch { /* ohne Speicher gilt die Wahl nur bis zum Neuladen */ }
}

/** Ziel-URL der Jobs-Ansicht, die die übergebenen Jobs bzw. Scan-Dateien verfolgt. */
export function folgenUrl({ jobIds = [], scanDateien = [] }) {
  const p = new URLSearchParams();
  for (const id of jobIds) p.append('folgen', id);
  for (const datei of scanDateien) p.append('scan', datei);
  return `/logs?${p.toString()}`;
}

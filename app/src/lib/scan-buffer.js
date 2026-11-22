import fs from 'node:fs/promises';
import path from 'node:path';

export const SCAN_BUFFER_DIR = '/data/scan_buffer';

// Job-IDs stammen aus tracker.create() (randomUUID). Alles andere würde aus
// dem Pufferverzeichnis hinausführen können und wird abgewiesen.
const JOB_ID_MUSTER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pufferPfad(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_MUSTER.test(jobId)) {
    throw new Error(`Ungültige Job-ID für den Scan-Puffer: ${String(jobId).slice(0, 40)}`);
  }
  return path.join(SCAN_BUFFER_DIR, `${jobId}.pdf`);
}

/**
 * Schreibt eine Datei dauerhaft: erst in eine Temporärdatei, fsync, dann
 * atomar umbenennen und das Verzeichnis synchronisieren. Wer danach eine
 * Zusage gibt (HTTP-Antwort, DB-Zeile), verliert die Datei auch bei
 * Stromausfall nicht. Ein vorhandenes Ziel wird ersetzt.
 *
 * @param {string} verzeichnis  absolutes Zielverzeichnis (wird angelegt)
 * @param {string} name         Dateiname ohne Pfadanteile
 */
export async function schreibeDauerhaft(verzeichnis, name, inhalt) {
  if (!name || name !== path.basename(name) || name.startsWith('.')) {
    throw new Error(`Ungültiger Dateiname: ${String(name).slice(0, 40)}`);
  }
  const filePath = path.join(verzeichnis, name);
  const tmpPath = `${filePath}.tmp`;
  await fs.mkdir(verzeichnis, { recursive: true });
  const fh = await fs.open(tmpPath, 'w');
  try {
    await fh.writeFile(inhalt);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, filePath);
  const dir = await fs.open(verzeichnis, 'r').catch(() => null);
  if (dir) await dir.sync().catch(() => {}).finally(() => dir.close());
  return filePath;
}

/** Puffer eines Pipeline-Auftrags dauerhaft schreiben (siehe schreibeDauerhaft). */
export async function saveScanBuffer(jobId, pdfBuffer) {
  return schreibeDauerhaft(SCAN_BUFFER_DIR, path.basename(pufferPfad(jobId)), pdfBuffer);
}

export async function deleteScanBuffer(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_MUSTER.test(jobId)) return;
  await fs.unlink(pufferPfad(jobId)).catch(() => {});
}

export async function readScanBuffer(jobId) {
  return fs.readFile(pufferPfad(jobId));
}

/** true, wenn für den Job noch eine gepufferte Scan-Datei existiert. */
export async function scanBufferVorhanden(jobId) {
  try {
    await fs.access(pufferPfad(jobId));
    return true;
  } catch {
    return false;
  }
}

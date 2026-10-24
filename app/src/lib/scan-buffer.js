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

export async function saveScanBuffer(jobId, pdfBuffer) {
  const filePath = pufferPfad(jobId);
  await fs.mkdir(SCAN_BUFFER_DIR, { recursive: true });
  await fs.writeFile(filePath, pdfBuffer);
  return filePath;
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

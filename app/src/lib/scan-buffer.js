import fs from 'node:fs/promises';
import path from 'node:path';

export const SCAN_BUFFER_DIR = '/data/scan_buffer';

export async function saveScanBuffer(jobId, pdfBuffer) {
  await fs.mkdir(SCAN_BUFFER_DIR, { recursive: true });
  const filePath = path.join(SCAN_BUFFER_DIR, `${jobId}.pdf`);
  await fs.writeFile(filePath, pdfBuffer);
  return filePath;
}

export async function deleteScanBuffer(jobId) {
  const filePath = path.join(SCAN_BUFFER_DIR, `${jobId}.pdf`);
  await fs.unlink(filePath).catch(() => {});
}

export async function readScanBuffer(jobId) {
  const filePath = path.join(SCAN_BUFFER_DIR, `${jobId}.pdf`);
  return fs.readFile(filePath);
}

import { NiimbotBluetoothClient, ImageEncoder, LabelType } from '@mmote/niimbluelib';

export async function connectPrinter() {
  const client = new NiimbotBluetoothClient();
  const info = await client.connect();
  return { client, deviceName: info.deviceName ?? 'D110' };
}

export async function disconnectPrinter(client) {
  await client.disconnect();
}

export async function printLabel(client, canvas) {
  // "left" rotiert 90° im Uhrzeigersinn: 320×96 (Querformat) → 96 Spalten × 320 Zeilen
  // = 12mm Druckkopfbreite × 40mm Etikett-Länge – passt exakt für D110 12×40mm
  const encoded = ImageEncoder.encodeCanvas(canvas, 'left');

  // Ermittle den optimalen PrintTask-Typ vom Drucker (D110 oder D110M_V4)
  const taskName = client.getPrintTaskType() ?? 'D110';
  const printTask = client.abstraction.newPrintTask(taskName, {
    totalPages: 1,
    labelType: LabelType.WithGaps,
    density: 3,
  });

  try {
    await printTask.printInit();
    await printTask.printPage(encoded, 1);
    await printTask.waitForPageFinished();
    await printTask.waitForFinished();
  } finally {
    await client.abstraction.printEnd();
  }
}

import { NiimbotBluetoothClient, ImageEncoder, LabelType, PageColorType } from '@mmote/niimbluelib';

export async function connectPrinter() {
  const client = new NiimbotBluetoothClient();
  const info = await client.connect();
  return { client, deviceName: info.deviceName ?? 'D110' };
}

export async function disconnectPrinter(client) {
  await client.disconnect();
}

/** Ein Etikett (Canvas) oder mehrere hintereinander in einem Druckauftrag. */
export async function printLabel(client, canvasOderListe) {
  const seiten = Array.isArray(canvasOderListe) ? canvasOderListe : [canvasOderListe];
  // "left" rotiert 90° im Uhrzeigersinn: 320×96 (Querformat) → 96 Spalten × 320 Zeilen
  // = 12mm Druckkopfbreite × 40mm Etikett-Länge – passt exakt für D110 12×40mm
  // Einfarbig (SingleColor) ist auch der Standard des PrintTasks; beide müssen übereinstimmen.
  const encoded = seiten.map((c) => ImageEncoder.encodeCanvas(c, PageColorType.SingleColor, 'left'));

  // Ermittle den optimalen PrintTask-Typ vom Drucker (D110 oder D110M_V4)
  const taskName = client.getPrintTaskType() ?? 'D110';
  const printTask = client.protocol.newPrintTask(taskName, {
    totalPages: encoded.length,
    labelType: LabelType.WithGaps,
    density: 3,
  });

  try {
    await printTask.printInit();
    for (const seite of encoded) {
      await printTask.printPage(seite, 1);
      await printTask.waitForPageFinished();
    }
    await printTask.waitForFinished();
  } finally {
    await client.protocol.printEnd();
  }
}

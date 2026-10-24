// Schlanker PDF-Schreiber für den Kamerascanner: eine Seite je Bild, ohne
// Bibliothek. Farbe und Graustufen kommen als JPEG (DCTDecode) hinein,
// Schwarzweiß als 1-Bit-Raster mit Flate-Kompression – das hält
// Textseiten klein. Die kurze Seite wird auf DIN-A4-Breite gesetzt, die
// lange folgt dem Seitenverhältnis des Bilds.

const A4_KURZ_PT = 595.28;

const enc = new TextEncoder();

/**
 * Baut die PDF.
 * @param {Array<{art: 'jpeg'|'bits', daten: Uint8Array, breite: number, hoehe: number, grau?: boolean}>} seiten
 *   `jpeg`: fertige JPEG-Datei; `grau` kennzeichnet ein Graustufen-JPEG.
 *   `bits`: zlib-komprimiertes 1-Bit-Raster (Zeilen auf Bytegrenzen, 1 = weiß).
 * @returns {Uint8Array}
 */
export function erstellePdf(seiten, { titel = 'Kamerascan' } = {}) {
  const teile = [];
  let laenge = 0;
  const offsets = [];
  const schreibe = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    teile.push(b);
    laenge += b.length;
  };
  const objekt = (nr, kopf, strom) => {
    offsets[nr] = laenge;
    schreibe(`${nr} 0 obj\n${kopf}\n`);
    if (strom) {
      schreibe('stream\n');
      schreibe(strom);
      schreibe('\nendstream\n');
    }
    schreibe('endobj\n');
  };

  // Objektnummern: 1 Katalog, 2 Seitenbaum, 3 Info, dann je Seite 3 Objekte.
  const seitenNr = seiten.map((_, i) => 4 + i * 3);
  schreibe('%PDF-1.4\n');
  // Binärmarker als echte Bytes > 127, damit Werkzeuge die Datei als binär erkennen
  schreibe(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  objekt(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objekt(2, `<< /Type /Pages /Kids [${seitenNr.map((n) => `${n} 0 R`).join(' ')}] /Count ${seiten.length} >>`);
  objekt(3, `<< /Title (${titel.replace(/[()\\]/g, '')}) /Producer (postbuch.net) >>`);

  seiten.forEach((s, i) => {
    const nr = seitenNr[i];
    const kurz = Math.min(s.breite, s.hoehe);
    const faktor = A4_KURZ_PT / kurz;
    const w = +(s.breite * faktor).toFixed(2);
    const h = +(s.hoehe * faktor).toFixed(2);
    const inhalt = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    objekt(nr, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${nr + 2} 0 R >> >> /Contents ${nr + 1} 0 R >>`);
    objekt(nr + 1, `<< /Length ${inhalt.length} >>`, inhalt);
    const bild = s.art === 'jpeg'
      ? `<< /Type /XObject /Subtype /Image /Width ${s.breite} /Height ${s.hoehe} /ColorSpace /${s.grau ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${s.daten.length} >>`
      : `<< /Type /XObject /Subtype /Image /Width ${s.breite} /Height ${s.hoehe} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${s.daten.length} >>`;
    objekt(nr + 2, bild, s.daten);
  });

  const anzahl = 4 + seiten.length * 3;
  const xref = laenge;
  let tabelle = `xref\n0 ${anzahl}\n0000000000 65535 f \n`;
  for (let nr = 1; nr < anzahl; nr++) tabelle += `${String(offsets[nr]).padStart(10, '0')} 00000 n \n`;
  schreibe(tabelle);
  schreibe(`trailer\n<< /Size ${anzahl} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const pdf = new Uint8Array(laenge);
  let pos = 0;
  for (const t of teile) { pdf.set(t, pos); pos += t.length; }
  return pdf;
}

/**
 * Packt ein Graubild (1 Kanal, 0…255) als 1-Bit-Raster: Bit 1 = weiß
 * (DeviceGray ohne Decode-Array), Zeilen auf volle Bytes aufgefüllt.
 */
export function packeBits(grau, breite, hoehe, schwelle = 128) {
  const proZeile = Math.ceil(breite / 8);
  const out = new Uint8Array(proZeile * hoehe);
  for (let y = 0; y < hoehe; y++) {
    const zeile = y * breite;
    const ziel = y * proZeile;
    for (let x = 0; x < breite; x++) {
      if (grau[zeile + x] >= schwelle) out[ziel + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** zlib-Kompression (FlateDecode) über die Compression-Streams-API. */
export async function deflate(daten) {
  const strom = new Blob([daten]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(strom).arrayBuffer());
}

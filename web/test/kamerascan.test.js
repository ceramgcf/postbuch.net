import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { ordneEcken, zielGroesse, langeSeiteFuerDpi, istKonvex, eckBewegung, hinweisAufFoto } from '../src/lib/kamerascan/geometrie.js';
import { erstellePdf, packeBits, deflate } from '../src/lib/kamerascan/pdfSchreiber.js';
import { erstelleAusloeser } from '../src/lib/kamerascan/ausloeser.js';
import { etikettAusQr, etikettPfad } from '../src/lib/kamerascan/postbuchQr.js';

const a4 = (b) => [{ x: 0, y: 0 }, { x: b, y: 0 }, { x: b, y: b * Math.SQRT2 }, { x: 0, y: b * Math.SQRT2 }];

test('ordneEcken sortiert beliebige Reihenfolge nach TL, TR, BR, BL', () => {
  const e = ordneEcken([{ x: 90, y: 110 }, { x: 10, y: 5 }, { x: 5, y: 100 }, { x: 100, y: 0 }]);
  assert.deepEqual(e, [{ x: 10, y: 5 }, { x: 100, y: 0 }, { x: 90, y: 110 }, { x: 5, y: 100 }]);
  assert.ok(istKonvex(e));
});

test('zielGroesse rastet nahe √2 auf DIN A ein', () => {
  const { breite, hoehe } = zielGroesse([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1380 }, { x: 0, y: 1380 }], 1e9);
  assert.equal(breite, 1000);
  assert.equal(hoehe, 1414);
});

test('PDF-Seiten werden auf höchstens 200 dpi bei A4 begrenzt', () => {
  // großes A4-Foto → 1654 × 2339
  assert.equal(langeSeiteFuerDpi(a4(2800)), 2339);
  // kleines bleibt, wie es ist (kein Hochrechnen)
  assert.equal(langeSeiteFuerDpi(a4(1000)), 1414);
  // Querformat: kurze Seite ist die Höhe
  const quer = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2828 }, { x: 0, y: 2828 }];
  assert.equal(langeSeiteFuerDpi(quer), 2339);
  // langer Kassenzettel: lange Seite auf das Vierfache gedeckelt
  const zettel = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 8000 }, { x: 0, y: 8000 }];
  assert.equal(langeSeiteFuerDpi(zettel), 6616);
});

test('packeBits setzt weiße Pixel als 1-Bits, Zeilen auf Bytegrenze', () => {
  const grau = Uint8Array.from([255, 0, 255, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const bits = packeBits(grau, 9, 2);
  assert.deepEqual([...bits], [0b10100000, 0b10000000, 0, 0]);
});

test('erstellePdf schreibt gültige Struktur mit korrekter xref', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const bits = await deflate(packeBits(new Uint8Array(16 * 4).fill(255), 16, 4));
  assert.deepEqual([...inflateSync(bits)], new Array(8).fill(255));
  const pdf = erstellePdf([
    { art: 'jpeg', daten: jpeg, breite: 1654, hoehe: 2339 },
    { art: 'bits', daten: bits, breite: 16, hoehe: 4 },
  ]);
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  // A4-Breite, Höhe im Seitenverhältnis
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.\d+\]/);
  assert.match(text, /\/BitsPerComponent 1 \/Filter \/FlateDecode/);
  // Jeder xref-Eintrag zeigt exakt auf "<nr> 0 obj"
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
  const zeilen = text.slice(startxref).split('\n');
  const anzahl = Number(zeilen[1].split(' ')[1]);
  for (let nr = 1; nr < anzahl; nr++) {
    const offset = Number(zeilen[2 + nr].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${nr} 0 obj`.length), `${nr} 0 obj`);
  }
});

function ablauf(ausloeser, bilder) {
  return bilder.map((b, i) => ausloeser.schritt({ breite: 1000, hoehe: 1000, jetzt: i * 200, sicherheit: 1, ...b }).zustand);
}

test('Auto-Auslöser löst erst bei ruhigem, scharfem Blatt genau einmal aus', () => {
  const ruhig = { ecken: a4(500), schaerfe: 0.6 };
  const z = ablauf(erstelleAusloeser(), new Array(10).fill(ruhig));
  assert.equal(z[0], 'bewegt');
  assert.equal(z.filter((x) => x === 'ausloesen').length, 1);
  assert.ok(z.indexOf('ausloesen') >= 4, 'nicht vor Ablauf der Ruhezeit');
});

test('Auto-Auslöser wartet bei Unschärfe und Bewegung', () => {
  const aus = erstelleAusloeser();
  const unscharf = ablauf(aus, new Array(10).fill({ ecken: a4(500), schaerfe: 0.2 }));
  assert.ok(!unscharf.includes('ausloesen'));
  const wackelt = ablauf(erstelleAusloeser(), new Array(10).fill(0).map((_, i) => ({
    ecken: a4(500).map((p) => ({ x: p.x + (i % 2) * 30, y: p.y })), schaerfe: 0.6,
  })));
  assert.ok(!wackelt.includes('ausloesen'));
});

test('nach einer Aufnahme wird dieselbe Seite nicht noch einmal ausgelöst', () => {
  const aus = erstelleAusloeser();
  const ruhig = { ecken: a4(500), schaerfe: 0.6 };
  const z = ablauf(aus, new Array(40).fill(ruhig));
  assert.equal(z.filter((x) => x === 'ausloesen').length, 1);
  assert.equal(z.at(-1), 'wechsel');
  // Blatt verschwindet kurz (neues wird aufgelegt) → wieder bereit
  const weiter = new Array(4).fill({ ecken: null }).concat(new Array(10).fill(ruhig))
    .map((b, i) => aus.schritt({ breite: 1000, hoehe: 1000, jetzt: 10000 + i * 200, sicherheit: 1, ...b }).zustand);
  assert.ok(weiter.includes('ausloesen'));
});

test('eckBewegung ist relativ zur Diagonale', () => {
  const a = a4(100);
  const b = a.map((p) => ({ x: p.x + 3, y: p.y + 4 }));
  assert.equal(eckBewegung(a, b, 300, 400), 5 / 500);
});

test('hinweisAufFoto überträgt Live-Ecken maßstabsgerecht', () => {
  const ecken = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 300 }, { x: 100, y: 300 }];
  const e = hinweisAufFoto({ ecken, breite: 480, hoehe: 640 }, 1440, 1920);
  assert.deepEqual(e[2], { x: 600, y: 900 });
  // Lage passt nicht (Video hoch, Foto quer) → kein Hinweis
  assert.equal(hinweisAufFoto({ ecken, breite: 480, hoehe: 640 }, 1920, 1440), null);
});

test('etikettAusQr liest nur Etiketten dieser Instanz', () => {
  const regel = { host: 'beispiel.postbuch.net' };
  assert.equal(etikettAusQr('beispiel.postbuch.net/postbuch/P000123', regel), 'P000123');
  assert.equal(etikettAusQr(' https://Beispiel.postbuch.net/postbuch/p000123/ ', regel), 'P000123');
  assert.equal(etikettAusQr('192.168.1.5:3420/postbuch/P000123', { host: '192.168.1.5:3420' }), 'P000123');
  // fremde Instanz, falsche Pfade, andere QR-Inhalte → Papier
  assert.equal(etikettAusQr('andere.postbuch.net/postbuch/P000123', regel), null);
  assert.equal(etikettAusQr('192.168.1.5:3420/postbuch/P000123', regel), null);
  assert.equal(etikettAusQr('https://beispiel.postbuch.net/postbuch/P000123?x=1', regel), null);
  assert.equal(etikettAusQr('https://beispiel.postbuch.net/akten/P000123', regel), null);
  assert.equal(etikettAusQr('BCD\n002\n1\nSCT', regel), null);
  assert.equal(etikettAusQr(null, regel), null);
  assert.equal(etikettAusQr('beispiel.postbuch.net/postbuch/P000123', { host: '' }), null);
});

test('etikettAusQr: Aliase und beliebige Adresse', () => {
  const regel = { host: 'beispiel.postbuch.net', aliase: ['192.168.1.5:3420', 'alt.example.org'] };
  assert.equal(etikettAusQr('192.168.1.5:3420/postbuch/P000123', regel), 'P000123');
  assert.equal(etikettAusQr('https://ALT.example.org/postbuch/P000124', regel), 'P000124');
  assert.equal(etikettAusQr('192.168.1.6:3420/postbuch/P000123', regel), null);
  // alleAdressen: nur der hintere Teil zählt, der Rest bleibt streng
  const alle = { host: 'beispiel.postbuch.net', alleAdressen: true };
  assert.equal(etikettAusQr('irgendwo.example/postbuch/P000125', alle), 'P000125');
  assert.equal(etikettAusQr('irgendwo.example/postbuch/P000125?x=1', alle), null);
  assert.equal(etikettAusQr('irgendwo.example/akten/P000125', alle), null);
  assert.equal(etikettAusQr('https://bank.example/zahlung', alle), null);
});

test('etikettAusQr: Etiketten von Sammelmappen (S-Nummer)', () => {
  const regel = { host: 'beispiel.postbuch.net' };
  assert.equal(etikettAusQr('beispiel.postbuch.net/mappe/S000007', regel), 'S000007');
  assert.equal(etikettAusQr('https://beispiel.postbuch.net/mappe/s000007/', regel), 'S000007');
  assert.equal(etikettAusQr('andere.postbuch.net/mappe/S000007', regel), null);
  // Präfix und Pfad müssen zusammenpassen
  assert.equal(etikettAusQr('beispiel.postbuch.net/mappe/P000007', regel), null);
  assert.equal(etikettAusQr('beispiel.postbuch.net/postbuch/S000007', regel), null);
  assert.equal(etikettPfad('S000007'), '/mappe/S000007');
  assert.equal(etikettPfad('P000123'), '/postbuch/P000123');
});

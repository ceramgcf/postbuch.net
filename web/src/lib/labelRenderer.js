import QRCode from 'qrcode';

const W = 320, H = 96;
const LOGO_INSET = 10;                 // Logo 76×76, Mittelpunkt bleibt bei (48,48)
const LOGO_SIZE = H - 2 * LOGO_INSET;  // 76
const NUM_RIGHT = 178;                 // rechte Kante: Postnummer + Instanzname
const ROW1_CY = 27, ROW2_CY = 56;      // vertikale Mitten der beiden Zifferngruppen
const QR_CX = 230;                     // horizontale Mitte des QR-Codes
const MAX_QR_PX = 76;                  // max Kantenlänge → ≥10px Rand oben/unten
const ICON_CX = 296;                   // Mitte der Icon-Spalte rechts vom QR
const ICON_SIZE = 26;
const ICON_SPACING = 32;               // vertikaler Abstand der Icons zueinander
const STRIP_BASELINE = 83;             // Grundlinie des Instanznamen-Streifens

function floydSteinberg(imageData) {
  const d = imageData.data;
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      const i = (y * imageData.width + x) * 4;
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const newVal = gray < 128 ? 0 : 255;
      const err = gray - newVal;
      d[i] = d[i + 1] = d[i + 2] = newVal;
      const spread = (dx, dy, w) => {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < imageData.width && ny < imageData.height) {
          const ni = (ny * imageData.width + nx) * 4;
          const v = d[ni] + err * w;
          d[ni] = d[ni + 1] = d[ni + 2] = Math.max(0, Math.min(255, v));
        }
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return imageData;
}

// Macht das gesamte Label echt 1-bittig (scharfe Kanten statt grauem Anti-Aliasing)
function thresholdCanvas(ctx) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = gray < 128 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function svgToImage(svg) {
  return loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
}

function neueLeinwand() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  return { canvas, ctx };
}

// Logo links – 76×76 monochrom gedithert, Mittelpunkt bei (48,48)
async function zeichneLogo(ctx) {
  const logo = await loadImage('/Postbuch-Logo192.png');
  const tmp = document.createElement('canvas');
  tmp.width = LOGO_SIZE;
  tmp.height = LOGO_SIZE;
  const tCtx = tmp.getContext('2d');
  tCtx.fillStyle = '#fff';
  tCtx.fillRect(0, 0, LOGO_SIZE, LOGO_SIZE);
  tCtx.drawImage(logo, 0, 0, LOGO_SIZE, LOGO_SIZE);
  tCtx.putImageData(floydSteinberg(tCtx.getImageData(0, 0, LOGO_SIZE, LOGO_SIZE)), 0, 0);
  ctx.drawImage(tmp, LOGO_INSET, LOGO_INSET);
}

// Nummer (2×3 Ziffern) rechtsbündig an `right`
function zeichneZiffern(ctx, digits, right) {
  ctx.fillStyle = '#000';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 38px monospace';
  ctx.fillText(digits.slice(0, 3), right, ROW1_CY);
  ctx.fillText(digits.slice(3, 6), right, ROW2_CY);
  return Math.max(ctx.measureText(digits.slice(0, 3)).width, ctx.measureText(digits.slice(3, 6)).width);
}

// QR-Code – pixelgenau ins Druckraster: 1 QR-Modul = scale² Druckpixel (scale ∈ {1,2,3}),
// horizontal um `cx` zentriert, vertikal zentriert → Rand ≥10px
function zeichneQr(ctx, text, cx) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const count = qr.modules.size;
  const matrix = qr.modules.data; // Uint8Array, 1 = dunkles Modul
  const scale = Math.max(1, Math.min(3, Math.floor(MAX_QR_PX / count)));
  const qrPx = count * scale;
  const qrX = Math.round(cx - qrPx / 2);
  const qrY = Math.round((H - qrPx) / 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(qrX, qrY, qrPx, qrPx);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (matrix[r * count + c]) {
        ctx.fillRect(qrX + c * scale, qrY + r * scale, scale, scale);
      }
    }
  }
}

// Instanzname – NACH dem Threshold (anti-aliased), sonst bekommen einzelne
// Vertikalstriche doppelte Dicke. Rechtsbündig an `right`, darf ins Logo ragen.
function zeichneInstanzname(ctx, instanceName, right) {
  if (!instanceName) return;
  let fs = 13;
  ctx.font = `${fs}px sans-serif`;
  const maxW = right - 2;
  while (fs > 8 && ctx.measureText(instanceName).width > maxW) {
    fs -= 1;
    ctx.font = `${fs}px sans-serif`;
  }
  const tw = ctx.measureText(instanceName).width;
  // weißer Hintergrund für Lesbarkeit, wo der Name das Logo überlagert
  ctx.fillStyle = '#fff';
  ctx.fillRect(right - tw - 3, STRIP_BASELINE - fs, tw + 6, fs + 6);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(instanceName, right, STRIP_BASELINE);
}

/** Inhalt des Etiketten-QR-Codes; der Kamerascan erkennt genau diese Form (postbuchQr.js). */
export function etikettQrText(id) {
  const pfad = id.startsWith('S') ? 'mappe' : 'postbuch';
  return `${window.location.host}/${pfad}/${id}`;
}

export async function renderLabelCanvas(postid, opts = {}) {
  const { verbleibIconSvg = null, urkundeIconSvg = null, instanceName = '' } = opts;
  const { canvas, ctx } = neueLeinwand();

  await zeichneLogo(ctx);
  zeichneZiffern(ctx, postid.replace(/^P/, '').padStart(6, '0'), NUM_RIGHT);
  zeichneQr(ctx, etikettQrText(postid), QR_CX);

  // Icons rechts vom QR-Code – Größe/Abstand unverändert, Gruppe vertikal zentriert
  const iconSvgs = [];
  if (urkundeIconSvg) iconSvgs.push(urkundeIconSvg);
  if (verbleibIconSvg) iconSvgs.push(verbleibIconSvg);
  const n = iconSvgs.length;
  for (let i = 0; i < n; i++) {
    const cy = (H / 2) + (i - (n - 1) / 2) * ICON_SPACING; // 2 Icons → 32/64, 1 Icon → 48
    ctx.drawImage(
      await svgToImage(iconSvgs[i]),
      ICON_CX - ICON_SIZE / 2,
      cy - ICON_SIZE / 2,
      ICON_SIZE,
      ICON_SIZE
    );
  }

  thresholdCanvas(ctx);
  zeichneInstanzname(ctx, instanceName, NUM_RIGHT);

  return canvas;
}

// ── Etiketten für Sammelmappen (Papierablage) ───────────────────────────────
// Technisches Etikett wie bei Dokumenten, aber ohne Symbolspalte: Der QR-Code
// rückt an den rechten Rand, die Nummer bekommt ein großes „S“ vorangestellt,
// damit sie nicht mit einer PostID verwechselt wird.
const ABLAGE_QR_CX = W - 10 - MAX_QR_PX / 2;   // QR bündig 10px vom rechten Rand
const ABLAGE_NUM_RIGHT = ABLAGE_QR_CX - MAX_QR_PX / 2 - 16;
const ABLAGE_PREFIX_GAP = 8;

// Titel-Etikett: Kategoriesymbol in voller Höhe, rechts daneben der Name
const TITEL_RAND = 4;
const TITEL_ICON = H - 2 * TITEL_RAND;          // 88
const TITEL_X = TITEL_RAND + TITEL_ICON + 12;   // Textspalte beginnt hier
const TITEL_MAX_FS = 72, TITEL_MIN_FS = 9;
const TITEL_ZEILE = 1.1;                        // Zeilenhöhe in Schriftgrößen

async function renderAblageTechnisch(ablageid, instanceName) {
  const { canvas, ctx } = neueLeinwand();
  await zeichneLogo(ctx);
  const zifferBreite = zeichneZiffern(ctx, ablageid.slice(1), ABLAGE_NUM_RIGHT);
  ctx.font = 'bold 58px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(ablageid[0], ABLAGE_NUM_RIGHT - zifferBreite - ABLAGE_PREFIX_GAP, (ROW1_CY + ROW2_CY) / 2 + 2);
  zeichneQr(ctx, etikettQrText(ablageid), ABLAGE_QR_CX);
  thresholdCanvas(ctx);
  zeichneInstanzname(ctx, instanceName, ABLAGE_NUM_RIGHT);
  return canvas;
}

// Wörter an Leerzeichen trennen, zusätzlich hinter Binde- und Schrägstrichen
// umbrechbar machen. `luecke` = vor dem Stück steht ein Leerzeichen.
function titelStuecke(text) {
  const stuecke = [];
  for (const wort of text.trim().split(/\s+/).filter(Boolean)) {
    wort.split(/(?<=[-/])/).forEach((teil, i) => stuecke.push({ teil, luecke: i === 0 }));
  }
  return stuecke;
}

// Gierig in Zeilen der Breite `breite` umbrechen. Ohne `hart` scheitert der
// Umbruch (null), sobald ein einzelnes Stück zu breit ist; mit `hart` wird
// es zeichenweise geteilt.
function umbrechen(ctx, stuecke, breite, hart) {
  const zeilen = [];
  let zeile = '';
  const passt = (t) => ctx.measureText(t).width <= breite;
  for (const { teil, luecke } of stuecke) {
    const kandidat = zeile ? zeile + (luecke ? ' ' : '') + teil : teil;
    if (passt(kandidat)) { zeile = kandidat; continue; }
    if (zeile) zeilen.push(zeile);
    if (passt(teil)) { zeile = teil; continue; }
    if (!hart) return null;
    zeile = '';
    for (const z of teil) {
      if (zeile && !passt(zeile + z)) { zeilen.push(zeile); zeile = ''; }
      zeile += z;
    }
  }
  if (zeile) zeilen.push(zeile);
  return zeilen;
}

// Größte Schrift, bei der der Titel umbrochen in die Textspalte passt.
function titelEinpassen(ctx, text, breite, hoehe) {
  const stuecke = titelStuecke(text);
  for (const hart of [false, true]) {
    for (let fs = TITEL_MAX_FS; fs >= TITEL_MIN_FS; fs--) {
      ctx.font = `bold ${fs}px sans-serif`;
      const zeilen = umbrechen(ctx, stuecke, breite, hart);
      if (zeilen && zeilen.length * fs * TITEL_ZEILE <= hoehe) return { fs, zeilen };
    }
  }
  ctx.font = `bold ${TITEL_MIN_FS}px sans-serif`;
  return { fs: TITEL_MIN_FS, zeilen: umbrechen(ctx, stuecke, breite, true) };
}

async function renderAblageTitel(name, iconSvg) {
  const { canvas, ctx } = neueLeinwand();
  if (iconSvg) ctx.drawImage(await svgToImage(iconSvg), TITEL_RAND, TITEL_RAND, TITEL_ICON, TITEL_ICON);
  thresholdCanvas(ctx);

  const breite = W - TITEL_RAND - TITEL_X;
  const hoehe = H - 2 * TITEL_RAND;
  const { fs, zeilen } = titelEinpassen(ctx, name, breite, hoehe);
  const zh = fs * TITEL_ZEILE;
  const oben = (H - zeilen.length * zh) / 2;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  zeilen.forEach((z, i) => ctx.fillText(z, TITEL_X, oben + zh * (i + 0.5)));
  return canvas;
}

/**
 * Beide Etiketten einer Sammelmappe, in Druckreihenfolge:
 * technisches Etikett (Nummer, Logo, Instanzname, QR) und Titel-Etikett.
 * @param {{ ablageid: string, name: string }} ablage
 * @param {{ iconSvg?: string|null, instanceName?: string }} [opts]
 */
export async function renderAblageLabels(ablage, { iconSvg = null, instanceName = '' } = {}) {
  return [
    await renderAblageTechnisch(ablage.ablageid, instanceName),
    await renderAblageTitel(ablage.name, iconSvg),
  ];
}

// Mehrere Etiketten landen untereinander in einer Datei (Vorschau/Fallback).
export function downloadLabelPng(canvasOderListe, name) {
  const liste = Array.isArray(canvasOderListe) ? canvasOderListe : [canvasOderListe];
  let canvas = liste[0];
  if (liste.length > 1) {
    const LUECKE = 12;
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = liste.length * H + (liste.length - 1) * LUECKE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    liste.forEach((c, i) => ctx.drawImage(c, 0, i * (H + LUECKE)));
  }
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etikett-${name}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 'image/png');
}

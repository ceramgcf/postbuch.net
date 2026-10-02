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

export async function renderLabelCanvas(postid, opts = {}) {
  const { verbleibIconSvg = null, urkundeIconSvg = null, instanceName = '' } = opts;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Logo links – 76×76 monochrom gedithert, Mittelpunkt bei (48,48)
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

  // Postnummer (2×3 Ziffern) – links neben dem QR-Code, rechtsbündig
  const digits = postid.replace(/^P/, '').padStart(6, '0');
  ctx.fillStyle = '#000';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 38px monospace';
  ctx.fillText(digits.slice(0, 3), NUM_RIGHT, ROW1_CY);
  ctx.fillText(digits.slice(3, 6), NUM_RIGHT, ROW2_CY);

  // QR-Code – pixelgenau ins Druckraster: 1 QR-Modul = scale² Druckpixel (scale ∈ {1,2,3})
  const qr = QRCode.create(`${window.location.host}/postbuch/${postid}`, {
    errorCorrectionLevel: 'L',
  });
  const count = qr.modules.size;
  const matrix = qr.modules.data; // Uint8Array, 1 = dunkles Modul
  const scale = Math.max(1, Math.min(3, Math.floor(MAX_QR_PX / count)));
  const qrPx = count * scale;
  const qrX = Math.round(QR_CX - qrPx / 2);
  const qrY = Math.round((H - qrPx) / 2); // vertikal zentriert → Rand ≥10px
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

  // Instanzname – NACH dem Threshold (anti-aliased), sonst bekommen einzelne
  // Vertikalstriche doppelte Dicke. Rechtsbündig zur Postnummer, darf ins Logo ragen.
  if (instanceName) {
    let fs = 13;
    ctx.font = `${fs}px sans-serif`;
    const maxW = NUM_RIGHT - 2;
    while (fs > 8 && ctx.measureText(instanceName).width > maxW) {
      fs -= 1;
      ctx.font = `${fs}px sans-serif`;
    }
    const tw = ctx.measureText(instanceName).width;
    // weißer Hintergrund für Lesbarkeit, wo der Name das Logo überlagert
    ctx.fillStyle = '#fff';
    ctx.fillRect(NUM_RIGHT - tw - 3, STRIP_BASELINE - fs, tw + 6, fs + 6);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(instanceName, NUM_RIGHT, STRIP_BASELINE);
  }

  return canvas;
}

export function downloadLabelPng(canvas, postid) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etikett-${postid}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 'image/png');
}

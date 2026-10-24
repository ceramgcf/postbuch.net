// Bildverarbeitung des Kamerascanners auf OpenCV.js. Jede Funktion bekommt
// `cv` übergeben und gibt selbst angelegte Mats wieder frei (OpenCV.js hat
// keine Garbage Collection für Mats). Läuft im Scanner-Worker, im Test unter
// Node gegen dieselbe opencv.js.
import { ordneEcken, flaeche, istKonvex, zielGroesse, skaliereEcken, klemme } from './geometrie.js';

/** Freigabe mehrerer Mats/Vektoren, null-tolerant. */
/**
 * Rechteckigen Ausschnitt als eigenständiges, lückenloses Bild kopieren.
 * In OpenCV.js liefert `roi().clone()` einen Mat mit der Zeilenbreite des
 * Ursprungsbilds; `mat.data` ist dann zeilenweise verschoben. `copyTo` legt
 * dagegen einen kompakten Speicherblock an.
 */
export function ausschnitt(cv, src, rect) {
  const roi = src.roi(rect);
  const kopie = new cv.Mat();
  roi.copyTo(kopie);
  roi.delete();
  return kopie;
}

function frei(...objekte) {
  for (const o of objekte) {
    if (o && typeof o.delete === 'function' && !o.isDeleted?.()) o.delete();
  }
}

function perzentil(daten, anteile, schritt = 1) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < daten.length; i += schritt) { hist[daten[i]]++; n++; }
  return anteile.map((anteil) => {
    const ziel = anteil * n;
    let summe = 0;
    for (let v = 0; v < 256; v++) {
      summe += hist[v];
      if (summe >= ziel) return v;
    }
    return 255;
  });
}

function matZuEcken(mat) {
  const p = [];
  for (let i = 0; i < mat.rows; i++) p.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
  return p;
}

// Aus einem Kanten- oder Binärbild alle plausiblen Vierecke sammeln.
function sammleVierecke(cv, bin, modus, minFlaeche, kandidaten, quelle) {
  const konturen = new cv.MatVector();
  const hierarchie = new cv.Mat();
  cv.findContours(bin, konturen, hierarchie, modus, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < konturen.size(); i++) {
    const kontur = konturen.get(i);
    const huelle = new cv.Mat();
    cv.convexHull(kontur, huelle, false, true);
    const huellFlaeche = cv.contourArea(huelle);
    if (huellFlaeche >= minFlaeche) {
      const umfang = cv.arcLength(huelle, true);
      const approx = new cv.Mat();
      for (const eps of [0.015, 0.025, 0.04, 0.06]) {
        cv.approxPolyDP(huelle, approx, eps * umfang, true);
        if (approx.rows <= 4) break;
      }
      if (approx.rows === 4) {
        const ecken = ordneEcken(matZuEcken(approx));
        const a = flaeche(ecken);
        // Wie gut füllt die Kontur das Viereck? Abgeschnittene oder runde
        // Formen (Hand, Tasse) fallen so heraus.
        const fuellung = a > 0 ? Math.min(1, huellFlaeche / a) : 0;
        if (istKonvex(ecken) && fuellung > 0.88) kandidaten.push({ ecken, flaeche: a, fuellung, quelle });
      }
      frei(approx);
    }
    frei(huelle, kontur);
  }
  frei(konturen, hierarchie);
}

// Normalform x·cosθ + y·sinθ = ρ; θ in [0, π)
function alsGerade(x1, y1, x2, y2) {
  let theta = Math.atan2(x2 - x1, -(y2 - y1));
  if (theta < 0) theta += Math.PI;
  if (theta >= Math.PI) theta -= Math.PI;
  return { theta, rho: x1 * Math.cos(theta) + y1 * Math.sin(theta) };
}

function schnitt(a, b) {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
  };
}

/**
 * Vierecke aus Geraden: Hough-Segmente werden zu Geraden gebündelt, je zwei
 * eher waagerechte und zwei eher senkrechte geschnitten. Das findet ein Blatt
 * auch, wenn eine Schattenkante den Umriss auftrennt oder eine Ecke vom
 * Finger verdeckt ist.
 */
function vierecksAusGeraden(cv, kanten, minFlaeche, kandidaten) {
  const b = kanten.cols;
  const h = kanten.rows;
  const segmente = new cv.Mat();
  cv.HoughLinesP(kanten, segmente, 1, Math.PI / 180, 40, Math.min(b, h) * 0.2, 8);
  const buendel = [];
  // Je nach OpenCV-Version liegen die Segmente als Zeilen oder als Spalten
  // vor; die Rohdaten sind in beiden Fällen x1 y1 x2 y2 hintereinander.
  const roh = segmente.data32S;
  for (let i = 0; i + 3 < roh.length; i += 4) {
    const [x1, y1, x2, y2] = roh.subarray(i, i + 4);
    const g = alsGerade(x1, y1, x2, y2);
    const laenge = Math.hypot(x2 - x1, y2 - y1);
    const treffer = buendel.find((z) => {
      let dt = Math.abs(z.theta - g.theta);
      if (dt > Math.PI / 2) dt = Math.PI - dt;
      // Bei θ nahe 0/π kippt das Vorzeichen von ρ
      const drho = Math.abs(z.theta - g.theta) > Math.PI / 2 ? Math.abs(z.rho + g.rho) : Math.abs(z.rho - g.rho);
      return dt < 0.05 && drho < 6;
    });
    if (treffer) {
      treffer.gewicht += laenge;
    } else {
      buendel.push({ ...g, gewicht: laenge });
    }
  }
  frei(segmente);
  buendel.sort((x, y) => y.gewicht - x.gewicht);
  // waagerecht: Normale zeigt nach oben/unten (θ nahe π/2)
  const waag = buendel.filter((g) => Math.abs(g.theta - Math.PI / 2) < Math.PI / 4).slice(0, 10);
  const senk = buendel.filter((g) => Math.abs(g.theta - Math.PI / 2) >= Math.PI / 4).slice(0, 10);
  const yBei = (g) => { const p = schnitt(g, { theta: 0, rho: b / 2 }); return p ? p.y : 0; };
  const xBei = (g) => { const p = schnitt(g, { theta: Math.PI / 2, rho: h / 2 }); return p ? p.x : 0; };
  const randX = b * 0.03;
  const randY = h * 0.03;
  for (let i = 0; i < waag.length; i++) {
    for (let j = i + 1; j < waag.length; j++) {
      const [oben, unten] = yBei(waag[i]) < yBei(waag[j]) ? [waag[i], waag[j]] : [waag[j], waag[i]];
      for (let k = 0; k < senk.length; k++) {
        for (let l = k + 1; l < senk.length; l++) {
          const [links, rechts] = xBei(senk[k]) < xBei(senk[l]) ? [senk[k], senk[l]] : [senk[l], senk[k]];
          const ecken = [schnitt(oben, links), schnitt(oben, rechts), schnitt(unten, rechts), schnitt(unten, links)];
          if (ecken.some((p) => !p || p.x < -randX || p.y < -randY || p.x > b + randX || p.y > h + randY)) continue;
          if (!istKonvex(ecken)) continue;
          const a = flaeche(ecken);
          if (a >= minFlaeche) kandidaten.push({ ecken, flaeche: a, fuellung: 1, quelle: 'geraden' });
        }
      }
    }
  }
}

/**
 * Wie gut liegt das Viereck auf echten Blatträndern? Entlang jeder Seite wird
 * geprüft, ob dort eine Kante verläuft und das Innere heller ist als das
 * Äußere (bei sehr kräftigen Kanten genügt die Kante). Zurück kommt der Anteil der schwächsten Seite (0…1) – zufällige
 * Vierecke aus Holzmaserung oder Schattenkanten haben mindestens eine
 * schwache Seite. Punkte außerhalb des Bilds zählen halb.
 */
function kantenStuetze(ecken, grad, grau) {
  const b = grau.cols;
  const h = grau.rows;
  const mx = ecken.reduce((s, p) => s + p.x, 0) / 4;
  const my = ecken.reduce((s, p) => s + p.y, 0) / 4;
  const wert = (m, x, y) => m.data[Math.round(y) * b + Math.round(x)];
  const drin = (x, y) => x >= 0 && y >= 0 && x <= b - 1 && y <= h - 1;
  let schwaechste = 1;
  for (let i = 0; i < 4; i++) {
    const a = ecken[i];
    const c = ecken[(i + 1) % 4];
    const laenge = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    // Normale zur Seite, nach außen gerichtet
    let nx = -(c.y - a.y) / laenge;
    let ny = (c.x - a.x) / laenge;
    if (nx * ((a.x + c.x) / 2 - mx) + ny * ((a.y + c.y) / 2 - my) < 0) { nx = -nx; ny = -ny; }
    const proben = 24;
    let treffer = 0;
    for (let k = 1; k <= proben; k++) {
      const t = k / (proben + 1);
      const px = a.x + (c.x - a.x) * t;
      const py = a.y + (c.y - a.y) * t;
      const ix = px - nx * 4;
      const iy = py - ny * 4;
      const ax = px + nx * 4;
      const ay = py + ny * 4;
      if (!drin(ax, ay) || !drin(px, py)) { treffer += 0.5; continue; }
      if (!drin(ix, iy)) continue;
      let kante = 0;
      for (let d = -2; d <= 2; d++) {
        const qx = px + nx * d;
        const qy = py + ny * d;
        if (drin(qx, qy)) kante = Math.max(kante, wert(grad, qx, qy));
      }
      // Normale Kante: innen heller. Sehr kräftige Kanten zählen auch ohne
      // diese Richtung (Schrift oder Farbbalken direkt am Blattrand).
      if ((kante >= 12 && wert(grau, ix, iy) > wert(grau, ax, ay) + 4) || kante >= 40) treffer++;
    }
    schwaechste = Math.min(schwaechste, treffer / proben);
  }
  return schwaechste;
}

/**
 * Sucht das Dokument im Bild. Liefert { ecken, sicherheit } in Koordinaten
 * des übergebenen Bilds oder null. `analyseLang` legt die Rechenauflösung fest
 * (lange Seite in Pixeln). `minAnteil` ist die kleinste Blattfläche relativ
 * zum Bild; die Live-Vorschau und damit der Auto-Auslöser nutzen den Standard.
 * `hinweis` sind
 * ungefähre Ecken (in Koordinaten von `src`), etwa aus der Live-Vorschau: Sie
 * gehen selbst als Kandidat ins Rennen und bevorzugen nahe Kandidaten.
 */
export function erkenneDokument(cv, src, { analyseLang = 512, minAnteil = 0.12, hinweis = null } = {}) {
  const faktor = Math.min(1, analyseLang / Math.max(src.cols, src.rows));
  const klein = new cv.Mat();
  cv.resize(src, klein, new cv.Size(Math.round(src.cols * faktor), Math.round(src.rows * faktor)), 0, 0, cv.INTER_AREA);
  const grau = new cv.Mat();
  cv.cvtColor(klein, grau, klein.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  const weich = new cv.Mat();
  cv.GaussianBlur(grau, weich, new cv.Size(5, 5), 0);

  const bw = grau.cols;
  const bh = grau.rows;
  const bildFlaeche = bw * bh;
  const minFlaeche = bildFlaeche * minAnteil;
  const kandidaten = [];
  const hinweisKlein = hinweis ? hinweis.map((p) => ({ x: p.x * faktor, y: p.y * faktor })) : null;
  if (hinweisKlein && istKonvex(hinweisKlein) && flaeche(hinweisKlein) >= minFlaeche) {
    kandidaten.push({ ecken: hinweisKlein, flaeche: flaeche(hinweisKlein), fuellung: 1, quelle: 'hinweis' });
  }

  // Weg 1: Kanten. Mehrere Schwellenpaare, weil ein weißes Blatt auf hellem
  // Tisch nur schwache Kanten hat, auf Holz dagegen die Maserung stört.
  const [median] = perzentil(weich.data, [0.5], 4);
  const kanten = new cv.Mat();
  const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  for (const [lo, hi] of [[15, 45], [35, 100], [Math.max(10, 0.5 * median), Math.max(30, 1.2 * median)]]) {
    cv.Canny(weich, kanten, lo, hi);
    cv.dilate(kanten, kanten, kern);
    sammleVierecke(cv, kanten, cv.RETR_LIST, minFlaeche, kandidaten, 'kanten');
  }

  // Weg 2: Geraden. Vorher Schrift wegschließen – Textzeilen ergeben sonst
  // lauter lange waagerechte Geraden, die echten Blattränder gehen unter.
  const ohneSchrift = new cv.Mat();
  const kernSchrift = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.morphologyEx(weich, ohneSchrift, cv.MORPH_CLOSE, kernSchrift);
  cv.Canny(ohneSchrift, kanten, 15, 45);
  vierecksAusGeraden(cv, kanten, minFlaeche, kandidaten);
  frei(ohneSchrift, kernSchrift);

  // Weg 3: Helligkeit – Papier ist fast immer heller als der Untergrund.
  const bin = new cv.Mat();
  cv.threshold(weich, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const kernGross = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernGross);
  sammleVierecke(cv, bin, cv.RETR_EXTERNAL, minFlaeche, kandidaten, 'hell');

  // Gradientenbetrag (8 Bit) für die Kantenstütze
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(weich, gx, cv.CV_32F, 1, 0, 3, 0.25);
  cv.Sobel(weich, gy, cv.CV_32F, 0, 1, 3, 0.25);
  const betrag = new cv.Mat();
  cv.magnitude(gx, gy, betrag);
  const grad = new cv.Mat();
  betrag.convertTo(grad, cv.CV_8U);
  for (const k of kandidaten) k.stuetze = kantenStuetze(k.ecken, grad, weich);

  frei(klein, grau, weich, kanten, kern, bin, kernGross, gx, gy, betrag, grad);

  // Das Bild selbst (alle Ecken am Rand) ist kein Dokument.
  const rand = 3;
  const amRand = (p) => p.x <= rand || p.y <= rand || p.x >= bw - 1 - rand || p.y >= bh - 1 - rand;
  const gueltig = kandidaten.filter((k) => !k.ecken.every(amRand)
    && k.flaeche < bildFlaeche * 0.98 && k.stuetze >= 0.5);
  if (gueltig.length === 0) return null;

  // Groß und auf allen vier Seiten gut gestützt gewinnt; mit Hinweis zählt
  // zusätzlich die Nähe zu ihm (mittlerer Eckabstand relativ zur Diagonale).
  const diagonale = Math.hypot(bw, bh);
  const naehe = (k) => {
    if (!hinweisKlein) return 1;
    const d = k.ecken.reduce((s, p, i) => s + Math.hypot(p.x - hinweisKlein[i].x, p.y - hinweisKlein[i].y), 0) / 4;
    return 0.15 + 0.85 * Math.exp(-((d / (diagonale * 0.06)) ** 2));
  };
  const punkte = (k) => (k.flaeche / bildFlaeche) * k.stuetze * k.stuetze * naehe(k);
  gueltig.sort((a, b) => punkte(b) - punkte(a));
  const best = gueltig[0];
  return {
    ecken: skaliereEcken(best.ecken, 1 / faktor),
    sicherheit: best.stuetze,
  };
}

/**
 * Wo liegt ein Vorschaubild (Videobild beim Auslösen) im Foto? Das Foto zeigt
 * oft einen größeren Sensorausschnitt als der Videostrom. Gesucht wird per
 * Schablonenvergleich über mehrere Maßstäbe. Liefert { s, dx, dy } für
 * Foto = Vorschau · s + d, oder null, wenn kein Maßstab überzeugt.
 */
export function vorschauImFoto(cv, foto, vorschau, { lang = 360, minTreffer = 0.55 } = {}) {
  const f = Math.min(1, lang / Math.max(foto.cols, foto.rows));
  const fotoKlein = new cv.Mat();
  cv.resize(foto, fotoKlein, new cv.Size(Math.round(foto.cols * f), Math.round(foto.rows * f)), 0, 0, cv.INTER_AREA);
  const fotoGrau = new cv.Mat();
  cv.cvtColor(fotoKlein, fotoGrau, cv.COLOR_RGBA2GRAY);
  const vGrau = new cv.Mat();
  cv.cvtColor(vorschau, vGrau, vorschau.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  const s0 = Math.min(fotoGrau.cols / vGrau.cols, fotoGrau.rows / vGrau.rows);
  const schablone = new cv.Mat();
  const ergebnis = new cv.Mat();
  let best = null;
  for (let k = 1; k >= 0.55; k -= 0.025) {
    const b = Math.floor(vGrau.cols * s0 * k);
    const h = Math.floor(vGrau.rows * s0 * k);
    if (b < 16 || h < 16 || b > fotoGrau.cols || h > fotoGrau.rows) continue;
    cv.resize(vGrau, schablone, new cv.Size(b, h), 0, 0, cv.INTER_AREA);
    cv.matchTemplate(fotoGrau, schablone, ergebnis, cv.TM_CCOEFF_NORMED);
    const { maxVal, maxLoc } = cv.minMaxLoc(ergebnis);
    if (!best || maxVal > best.wert) best = { wert: maxVal, s: (b / vGrau.cols), dx: maxLoc.x, dy: maxLoc.y };
  }
  frei(fotoKlein, fotoGrau, vGrau, schablone, ergebnis);
  if (!best || best.wert < minTreffer) return null;
  return { s: best.s / f, dx: best.dx / f, dy: best.dy / f, wert: best.wert };
}

/**
 * Verfeinert grob erkannte Ecken auf höherer Auflösung: Entlang jeder Seite
 * wird quer zur Kante nach dem stärksten Helligkeitssprung gesucht (Papier
 * innen heller als außen bevorzugt), durch die Treffer eine Gerade gelegt und
 * die Ecken als Schnittpunkte neu bestimmt. Die Live-Erkennung rechnet auf
 * 512 Pixeln; auf einem 12-Megapixel-Foto wären ihre Ecken sonst um dutzende
 * Pixel ungenau. Liefert Ecken in Koordinaten von `src`.
 */
export function verfeinereEcken(cv, src, ecken, { lang = 1600 } = {}) {
  const faktor = Math.min(1, lang / Math.max(src.cols, src.rows));
  const klein = new cv.Mat();
  cv.resize(src, klein, new cv.Size(Math.round(src.cols * faktor), Math.round(src.rows * faktor)), 0, 0, cv.INTER_AREA);
  const grau = new cv.Mat();
  cv.cvtColor(klein, grau, klein.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  cv.GaussianBlur(grau, grau, new cv.Size(3, 3), 0);
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(grau, gx, cv.CV_32F, 1, 0, 3, 0.25);
  cv.Sobel(grau, gy, cv.CV_32F, 0, 1, 3, 0.25);
  const b = grau.cols;
  const h = grau.rows;
  const dx = gx.data32F;
  const dy = gy.data32F;
  frei(klein, grau);

  const e = skaliereEcken(ecken, faktor);
  const mx = (e[0].x + e[1].x + e[2].x + e[3].x) / 4;
  const my = (e[0].y + e[1].y + e[2].y + e[3].y) / 4;
  // Suchweite: ungefähr der Fehler der groben Erkennung, bei kleinen Blättern
  // (Visitenkarte) zusätzlich nach der Blattgröße begrenzt – sonst greift die
  // Suche auf Logos oder Farbflächen nahe am Rand über.
  const kurzeSeite = Math.min(...e.map((p, i) => Math.hypot(e[(i + 1) % 4].x - p.x, e[(i + 1) % 4].y - p.y)));
  const reichweite = Math.max(6, Math.round(Math.min(Math.hypot(b, h) * 0.012, kurzeSeite * 0.04)));
  const geraden = [];
  for (let i = 0; i < 4; i++) {
    const p = e[i];
    const q = e[(i + 1) % 4];
    const laenge = Math.hypot(q.x - p.x, q.y - p.y);
    const tx = (q.x - p.x) / laenge;
    const ty = (q.y - p.y) / laenge;
    // Normale nach außen (vom Schwerpunkt weg)
    let nx = -ty;
    let ny = tx;
    if (nx * ((p.x + q.x) / 2 - mx) + ny * ((p.y + q.y) / 2 - my) < 0) { nx = -nx; ny = -ny; }
    const treffer = [];
    const proben = 48;
    for (let k = 0; k < proben; k++) {
      const t = 0.08 + (0.84 * k) / (proben - 1);
      const bx = p.x + (q.x - p.x) * t;
      const by = p.y + (q.y - p.y) * t;
      let best = 0;
      let bestS = null;
      for (let sv = -reichweite; sv <= reichweite; sv++) {
        const x = Math.round(bx + nx * sv);
        const y = Math.round(by + ny * sv);
        if (x < 1 || y < 1 || x >= b - 1 || y >= h - 1) continue;
        const j = y * b + x;
        const quer = dx[j] * nx + dy[j] * ny; // < 0: nach außen dunkler
        const wert = Math.max(-quer, 0.5 * Math.abs(quer));
        if (wert > best) { best = wert; bestS = sv; }
      }
      if (bestS != null && best >= 6) treffer.push({ x: bx + nx * bestS, y: by + ny * bestS });
    }
    geraden.push(passeGerade(treffer));
  }
  frei(gx, gy);

  const neu = [];
  for (let i = 0; i < 4; i++) {
    // Ecke i liegt zwischen Seite i-1 (davor) und Seite i
    const g1 = geraden[(i + 3) % 4];
    const g2 = geraden[i];
    const s = g1 && g2 ? schneideGeraden(g1, g2) : null;
    neu.push(s && Math.hypot(s.x - e[i].x, s.y - e[i].y) <= reichweite * 2 ? s : e[i]);
  }
  const ergebnis = istKonvex(neu) ? neu : e;
  return skaliereEcken(ergebnis.map((pt) => klemme(pt, b, h)), 1 / faktor);
}

/** Ausgleichsgerade (Hauptachse) mit zwei Runden Ausreißer-Abwurf. */
function passeGerade(punkte) {
  let rest = punkte;
  let g = null;
  for (let runde = 0; runde < 3; runde++) {
    if (rest.length < 8) return g;
    const n = rest.length;
    let sx = 0, sy = 0;
    for (const p of rest) { sx += p.x; sy += p.y; }
    const cx = sx / n;
    const cy = sy / n;
    let xx = 0, xy = 0, yy = 0;
    for (const p of rest) {
      const ax = p.x - cx;
      const ay = p.y - cy;
      xx += ax * ax; xy += ax * ay; yy += ay * ay;
    }
    const winkel = 0.5 * Math.atan2(2 * xy, xx - yy);
    g = { cx, cy, vx: Math.cos(winkel), vy: Math.sin(winkel) };
    const abst = (p) => Math.abs((p.x - g.cx) * g.vy - (p.y - g.cy) * g.vx);
    rest = rest.filter((p) => abst(p) <= (runde === 0 ? 3 : 1.5));
  }
  return g;
}

function schneideGeraden(a, b) {
  const nenner = a.vx * b.vy - a.vy * b.vx;
  if (Math.abs(nenner) < 1e-6) return null;
  const t = ((b.cx - a.cx) * b.vy - (b.cy - a.cy) * b.vx) / nenner;
  return { x: a.cx + a.vx * t, y: a.cy + a.vy * t };
}

/**
 * Perspektivisch entzerren; `drehung` in Vierteldrehungen im Uhrzeigersinn.
 * `beschnitt` schneidet ringsum diesen Anteil ab – die erkannten Ecken sitzen
 * oft einen Hauch außerhalb des Blatts, sonst bliebe ein Streifen Tisch stehen.
 */
export function entzerre(cv, src, ecken, { maxLang = 3508, drehung = 0, beschnitt = 0 } = {}) {
  const { breite, hoehe } = zielGroesse(ecken, maxLang);
  const quelle = cv.matFromArray(4, 1, cv.CV_32FC2, ecken.flatMap((p) => [p.x, p.y]));
  const ziel = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, breite, 0, breite, hoehe, 0, hoehe]);
  const m = cv.getPerspectiveTransform(quelle, ziel);
  let dst = new cv.Mat();
  cv.warpPerspective(src, dst, m, new cv.Size(breite, hoehe), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  frei(quelle, ziel, m);
  if (beschnitt > 0) {
    const dx = Math.round(breite * beschnitt);
    const dy = Math.round(hoehe * beschnitt);
    if (breite - 2 * dx > 8 && hoehe - 2 * dy > 8) {
      const kopie = ausschnitt(cv, dst, new cv.Rect(dx, dy, breite - 2 * dx, hoehe - 2 * dy));
      frei(dst);
      dst = kopie;
    }
  }
  const viertel = ((drehung % 4) + 4) % 4;
  if (viertel === 0) return dst;
  const gedreht = new cv.Mat();
  cv.rotate(dst, gedreht, [null, cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE][viertel]);
  frei(dst);
  return gedreht;
}

/**
 * Schärfe des ganzen Blatts: Das Dokument wird klein entzerrt und in Kacheln
 * zerlegt. Je Kachel mit Inhalt zählt das Verhältnis aus Laplace- und
 * Gradientenstärke. Für eine Kante mit Unschärfe σ fällt der Gradient mit 1/σ,
 * der Laplace mit 1/σ² – das Verhältnis hängt deshalb kaum von Kontrast,
 * Textmenge oder Farbflächen ab, sondern fast nur von der Unschärfe.
 * Maßgeblich ist die schlechteste Inhaltskachel: Ein Blatt, das nur in der
 * Mitte scharf ist, gilt als unscharf.
 */
export function bewerteSchaerfe(cv, src, ecken, { spalten = 3, zeilen = 4, maxLang = 720 } = {}) {
  const blatt = entzerre(cv, src, ecken, { maxLang, beschnitt: 0.02 });
  const grau = new cv.Mat();
  cv.cvtColor(blatt, grau, blatt.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  const lap = new cv.Mat();
  cv.Laplacian(grau, lap, cv.CV_32F, 1);
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(grau, gx, cv.CV_32F, 1, 0, 3, 0.25);
  cv.Sobel(grau, gy, cv.CV_32F, 0, 1, 3, 0.25);
  const grad = new cv.Mat();
  cv.magnitude(gx, gy, grad);
  const kw = Math.floor(grau.cols / spalten);
  const kh = Math.floor(grau.rows / zeilen);
  const werte = [];
  const mittel = new cv.Mat();
  const streu = new cv.Mat();
  const rms = (m) => {
    cv.meanStdDev(m, mittel, streu);
    return Math.hypot(mittel.data64F[0], streu.data64F[0]);
  };
  for (let zy = 0; zy < zeilen; zy++) {
    for (let zx = 0; zx < spalten; zx++) {
      const r = new cv.Rect(zx * kw, zy * kh, kw, kh);
      const g = grad.roi(r);
      const l = lap.roi(r);
      const gradient = rms(g);
      // Unter dieser Gradientenstärke ist die Kachel leeres Papier.
      werte.push(gradient >= 4 ? rms(l) / gradient : null);
      frei(g, l);
    }
  }
  frei(blatt, grau, lap, gx, gy, grad, mittel, streu);
  const inhalt = werte.filter((w) => w != null);
  return {
    kacheln: werte,
    minimum: inhalt.length ? Math.min(...inhalt) : 0,
    inhalt: inhalt.length,
  };
}

/** Bild in RGBA wandeln (für die Ausgabe auf einem Canvas). */
function alsRgba(cv, mat) {
  const out = new cv.Mat();
  const code = mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : mat.channels() === 3 ? cv.COLOR_RGB2RGBA : null;
  if (code == null) mat.copyTo(out); else cv.cvtColor(mat, out, code);
  return out;
}

/**
 * Pull-Push-Interpolation: füllt in `werte` (Float32, b×h) alle Stellen mit
 * Gewicht 0 aus der Umgebung auf. Grobe Stufen mitteln die gültigen Werte,
 * feine Stufen übernehmen sie dort, wo eigene Werte fehlen.
 */
function fuelleLuecken(werte, gewichte, b, h) {
  if (b <= 1 && h <= 1) return;
  const b2 = Math.ceil(b / 2);
  const h2 = Math.ceil(h / 2);
  const w2 = new Float32Array(b2 * h2);
  const g2 = new Float32Array(b2 * h2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < b; x++) {
      const i = y * b + x;
      const j = (y >> 1) * b2 + (x >> 1);
      w2[j] += werte[i] * gewichte[i];
      g2[j] += gewichte[i];
    }
  }
  for (let j = 0; j < w2.length; j++) {
    if (g2[j] > 0) w2[j] /= g2[j];
    g2[j] = Math.min(1, g2[j]);
  }
  fuelleLuecken(w2, g2, b2, h2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < b; x++) {
      const i = y * b + x;
      const g = Math.min(1, gewichte[i]);
      if (g >= 1) continue;
      // Bilinear aus der groben Stufe, sonst entstehen sichtbare Blöcke.
      const gx = Math.min(b2 - 1, Math.max(0, (x - 0.5) / 2));
      const gy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(b2 - 1, x0 + 1);
      const y1 = Math.min(h2 - 1, y0 + 1);
      const fx = gx - x0;
      const fy = gy - y0;
      const grob = (w2[y0 * b2 + x0] * (1 - fx) + w2[y0 * b2 + x1] * fx) * (1 - fy)
        + (w2[y1 * b2 + x0] * (1 - fx) + w2[y1 * b2 + x1] * fx) * fy;
      werte[i] = g * werte[i] + (1 - g) * grob;
    }
  }
}

/**
 * Beleuchtung des Blatts schätzen (Grauwert-Mat in voller Größe). Schrift
 * entfernt ein morphologisches Schließen; farbige Flächen (Logos, Stempel,
 * Textmarker) zählen nicht als Papier und werden aus ihrer Umgebung
 * aufgefüllt, sonst würden sie zu Weiß „korrigiert“.
 */
function schaetzeLicht(cv, src, grau) {
  const f = Math.min(1, 640 / Math.max(grau.cols, grau.rows));
  const groesse = new cv.Size(Math.max(1, Math.round(grau.cols * f)), Math.max(1, Math.round(grau.rows * f)));
  const klein = new cv.Mat();
  cv.resize(grau, klein, groesse, 0, 0, cv.INTER_AREA);
  const kern = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11));
  cv.morphologyEx(klein, klein, cv.MORPH_CLOSE, kern);

  // Sättigung je Pixel (klein) als Maske: bunt → kein Papier.
  const farbeKlein = new cv.Mat();
  cv.resize(src, farbeKlein, groesse, 0, 0, cv.INTER_AREA);
  const hsv = new cv.Mat();
  cv.cvtColor(farbeKlein, hsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
  const kanaele = new cv.MatVector();
  cv.split(hsv, kanaele);
  const satt = kanaele.get(1);
  const maske = new cv.Mat();
  cv.threshold(satt, maske, 55, 255, cv.THRESH_BINARY);
  cv.dilate(maske, maske, kern);

  const n = klein.cols * klein.rows;
  const werte = new Float32Array(n);
  const gewichte = new Float32Array(n);
  let papierAnteil = 0;
  for (let i = 0; i < n; i++) {
    werte[i] = klein.data[i];
    gewichte[i] = maske.data[i] ? 0 : 1;
    papierAnteil += gewichte[i];
  }
  // Fast alles bunt (Farbfoto, farbiges Papier): dann keine Maske.
  if (papierAnteil > n * 0.15) fuelleLuecken(werte, gewichte, klein.cols, klein.rows);
  for (let i = 0; i < n; i++) klein.data[i] = Math.max(0, Math.min(255, Math.round(werte[i])));
  cv.medianBlur(klein, klein, 5);

  // Große dunkle, unbunte Flächen (Graufotos, Balken) nicht zu Papier
  // aufhellen: Die Beleuchtung darf nicht unter die Hälfte des Papierweiß fallen.
  const [papier] = perzentil(klein.data, [0.95]);
  const boden = new cv.Mat(klein.rows, klein.cols, cv.CV_8UC1, new cv.Scalar(Math.max(1, Math.round(papier * 0.5))));
  cv.max(klein, boden, klein);
  const licht = new cv.Mat();
  cv.resize(klein, licht, new cv.Size(grau.cols, grau.rows), 0, 0, cv.INTER_LINEAR);
  frei(klein, kern, farbeKlein, hsv, kanaele, satt, maske, boden);
  return licht;
}

/**
 * Bildverbesserung für ein entzerrtes Blatt (RGBA). `modus`: 'farbe' | 'grau'
 * | 'sw'. Gemeinsamer Kern: Die Beleuchtung wird herausgerechnet – Schatten
 * und Farbstiche des Lichts verschwinden, das Papier wird weiß. Danach spreizt
 * eine Tonwertkurve den Kontrast. Liefert eine RGBA-Mat.
 */
export function verbessere(cv, src, modus) {
  const grau = new cv.Mat();
  cv.cvtColor(src, grau, cv.COLOR_RGBA2GRAY);
  const licht = schaetzeLicht(cv, src, grau);
  const norm = new cv.Mat();
  cv.divide(grau, licht, norm, 255);

  let ergebnis;
  if (modus === 'sw') {
    // Schwarz, wenn deutlich dunkler als Papier – oder lokal dunkler und
    // zumindest leicht grau (feine, blasse Schrift).
    const block = Math.max(15, Math.round(Math.max(norm.cols, norm.rows) / 70) | 1);
    const adaptiv = new cv.Mat();
    cv.adaptiveThreshold(norm, adaptiv, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 14);
    const hart = new cv.Mat();
    cv.threshold(norm, hart, 165, 255, cv.THRESH_BINARY);
    const weich = new cv.Mat();
    cv.threshold(norm, weich, 232, 255, cv.THRESH_BINARY);
    // weiß = hart weiß UND (adaptiv weiß ODER weich weiß)
    cv.bitwise_or(adaptiv, weich, adaptiv);
    cv.bitwise_and(adaptiv, hart, adaptiv);
    ergebnis = alsRgba(cv, adaptiv);
    frei(adaptiv, hart, weich);
  } else {
    // Tonwertkurve: dunkelste Schrift → schwarz, Papier → weiß, Mitten etwas
    // dunkler, damit dünne Schrift kräftiger wirkt.
    const [lo, hi] = perzentil(norm.data, [0.01, 0.9], 7);
    const unten = Math.min(lo, 110);
    const oben = Math.max(Math.min(hi, 250), unten + 60);
    const lutDaten = [];
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v - unten) / (oben - unten)));
      lutDaten.push(Math.round(255 * Math.pow(t, 1.25)));
    }
    const lut = cv.matFromArray(1, 256, cv.CV_8UC1, lutDaten);
    if (modus === 'grau') {
      const aus = new cv.Mat();
      cv.LUT(norm, lut, aus);
      ergebnis = alsRgba(cv, aus);
      frei(aus);
    } else {
      // Farbe: jeden Kanal durch dieselbe Beleuchtung teilen, dann dieselbe Kurve.
      const kanaele = new cv.MatVector();
      cv.split(src, kanaele);
      const neu = new cv.MatVector();
      for (let k = 0; k < 3; k++) {
        const kanal = kanaele.get(k);
        const geteilt = new cv.Mat();
        cv.divide(kanal, licht, geteilt, 255);
        cv.LUT(geteilt, lut, geteilt);
        neu.push_back(geteilt);
        frei(kanal, geteilt);
      }
      const alpha = new cv.Mat(src.rows, src.cols, cv.CV_8UC1, new cv.Scalar(255));
      neu.push_back(alpha);
      ergebnis = new cv.Mat();
      cv.merge(neu, ergebnis);
      frei(kanaele, neu, alpha);
    }
    frei(lut);
  }
  frei(grau, licht, norm);
  return ergebnis;
}

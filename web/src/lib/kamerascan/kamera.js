// Kamerazugriff für den Kamerascan: Rückkamera mit hoher Auflösung, Fotos
// bevorzugt über ImageCapture (volle Sensorauflösung), sonst ein Standbild
// aus dem Videostrom. Taschenlampe und Dauerfokus, wo das Gerät sie anbietet.

export function kameraVerfuegbar() {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && (typeof window === 'undefined' || window.isSecureContext);
}

/** Verständliche Meldung zu einem getUserMedia-Fehler. */
export function kameraFehlertext(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Der Kamerazugriff wurde nicht erlaubt. Bitte in den Website- bzw. App-Einstellungen die Kamera für postbuch.net freigeben.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Auf diesem Gerät wurde keine passende Kamera gefunden.';
    case 'NotReadableError':
      return 'Die Kamera wird gerade von einer anderen App benutzt.';
    default:
      return err?.message || 'Die Kamera ließ sich nicht starten.';
  }
}

// Angeforderter Videostrom. Standard ist das Maximum, das das Gerät liefert:
// Kleinere Ströme schneiden auf manchen Geräten nur die Sensormitte aus, dann
// zeigt das Livebild weniger als das Foto. Wem das zu träge läuft, wählt im
// Debug-Modus über das Zahnrad des Kamerascans einen kleineren Strom; die Wahl
// gilt nur für diesen Browser und bleibt auch nach dem Debug-Modus bestehen.
export const STROM_OPTIONEN = [
  { id: 'maximal', name: 'Maximal (Standard)', text: 'Volle Sensorgröße, voller Bildwinkel. Braucht am meisten Rechenleistung.', breite: 4096, hoehe: 3072 },
  { id: '2560x1920', name: '2560×1920', breite: 2560, hoehe: 1920 },
  { id: '1920x1440', name: '1920×1440', breite: 1920, hoehe: 1440 },
  { id: '1440x1080', name: '1440×1080', breite: 1440, hoehe: 1080 },
  { id: '1280x960', name: '1280×960', breite: 1280, hoehe: 960 },
];
const STROM_KEY = 'postbuch.kameraStrom';

export function leseKameraStrom() {
  let id = null;
  try { id = localStorage.getItem(STROM_KEY); } catch { /* ohne Speicher */ }
  return STROM_OPTIONEN.find((o) => o.id === id) ?? STROM_OPTIONEN[0];
}

export function schreibeKameraStrom(id) {
  try {
    if (id === STROM_OPTIONEN[0].id) localStorage.removeItem(STROM_KEY);
    else localStorage.setItem(STROM_KEY, id);
  } catch { /* ohne Speicher */ }
}

// Rückkamera. Chrome wählt bei bloßem facingMode die Kamera, die die
// gewünschte Größe am besten trifft, bei Gleichstand die zuerst gelistete –
// auf Handys mit mehreren Objektiven oft das Weitwinkel. Deshalb wird die
// Kamera selbst bestimmt: die gespeicherte Wahl dieses Browsers, sonst die
// Rückkamera mit der kleinsten Nummer („camera 0, facing back“), unter
// Android üblicherweise die Hauptkamera.
const KAMERA_KEY = 'postbuch.kameraGeraet';
const RUECKSEITE = /back|rear|environment|rück/i;

export function leseKameraWahl() {
  try { return localStorage.getItem(KAMERA_KEY); } catch { return null; }
}

export function schreibeKameraWahl(label) {
  try {
    if (label) localStorage.setItem(KAMERA_KEY, label);
    else localStorage.removeItem(KAMERA_KEY);
  } catch { /* ohne Speicher */ }
}

/** Kameras des Geräts, Rückkameras zuerst. Namen gibt es erst nach einer Kamerafreigabe. */
export async function kameraListe() {
  let geraete = [];
  try {
    geraete = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch { /* ohne Liste */ }
  const nummer = (d) => Number(d.label.match(/camera\s*(\d+)/i)?.[1] ?? 999);
  return geraete
    .map((d) => ({ deviceId: d.deviceId, label: d.label, hinten: RUECKSEITE.test(d.label) }))
    .sort((a, b) => (b.hinten - a.hinten) || (nummer(a) - nummer(b)));
}

function waehleKamera(liste) {
  if (!liste.some((d) => d.label)) return null;
  const wahl = leseKameraWahl();
  return liste.find((d) => wahl && d.label === wahl) ?? liste.find((d) => d.hinten) ?? null;
}

export async function starteKamera(video, { breite, hoehe, resizeMode } = leseKameraStrom()) {
  const oeffne = (deviceId) => navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: breite },
      height: { ideal: hoehe },
      ...(resizeMode ? { resizeMode: { ideal: resizeMode } } : {}),
    },
  });
  let ziel = waehleKamera(await kameraListe());
  let strom;
  try {
    strom = await oeffne(ziel?.deviceId);
  } catch (err) {
    // Gemerkte Kamera nicht mehr vorhanden o. Ä.: Chrome wählen lassen.
    if (!ziel) throw err;
    ziel = null;
    strom = await oeffne(null);
  }
  if (!ziel) {
    // Erster Start: Namen kennt erst die Liste nach der Freigabe. Liefert
    // Chrome nicht die gewünschte Kamera, einmal mit ihr neu öffnen.
    ziel = waehleKamera(await kameraListe());
    const aktuell = strom.getVideoTracks()[0]?.getSettings?.().deviceId;
    if (ziel && aktuell && ziel.deviceId !== aktuell) {
      strom.getTracks().forEach((t) => t.stop());
      strom = await oeffne(ziel.deviceId);
    }
  }
  const spur = strom.getVideoTracks()[0];
  const faehig = spur.getCapabilities?.() ?? {};
  if (Array.isArray(faehig.focusMode) && faehig.focusMode.includes('continuous')) {
    spur.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  video.srcObject = strom;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  // eslint-disable-next-line no-undef
  const erfassung = typeof ImageCapture === 'function' ? new ImageCapture(spur) : null;
  let lampeAn = false;

  return {
    geraetId: spur.getSettings?.().deviceId ?? null,
    hatLampe: !!faehig.torch,
    get lampeAn() { return lampeAn; },
    async lampe(an) {
      if (!faehig.torch) return;
      await spur.applyConstraints({ advanced: [{ torch: !!an }] });
      lampeAn = !!an;
    },

    /** Kleines Vorschaubild für die Analyse (lange Seite `lang`). */
    async vorschaubild(lang = 960) {
      const b = video.videoWidth;
      const h = video.videoHeight;
      if (!b || !h) return null;
      const f = Math.min(1, lang / Math.max(b, h));
      return createImageBitmap(video, {
        resizeWidth: Math.round(b * f),
        resizeHeight: Math.round(h * f),
        resizeQuality: 'medium',
      });
    },

    /** Foto als Blob in bestmöglicher Auflösung. */
    async foto() {
      if (erfassung) {
        try {
          const blob = await erfassung.takePhoto();
          // Manche Geräte schalten die Lampe beim Foto ab – wiederherstellen.
          if (lampeAn) spur.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
          if (blob && blob.size > 0) return blob;
        } catch {
          // Rückfall auf das Standbild aus dem Videostrom
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Foto fehlgeschlagen'))), 'image/jpeg', 0.92);
      });
    },

    /** Kenndaten von Videostrom und Fotofunktion für die Kamera-Diagnose (Debug-Modus). */
    async diagnose() {
      const e = spur.getSettings?.() ?? {};
      const bereich = (r) => (r ? `${r.min}–${r.max}` : '–');
      let foto = null;
      try {
        const pc = await erfassung?.getPhotoCapabilities();
        const ps = await erfassung?.getPhotoSettings?.();
        if (pc) foto = { breite: bereich(pc.imageWidth), hoehe: bereich(pc.imageHeight), aktuell: ps ? `${ps.imageWidth}×${ps.imageHeight}` : '–' };
      } catch (err) { foto = { fehler: err?.message }; }
      let kameras = [];
      try {
        kameras = (await kameraListe())
          .map((d) => `${d.deviceId === e.deviceId ? '► ' : ''}${d.label || d.deviceId.slice(0, 8)}`);
      } catch { /* ohne Liste */ }
      const { deviceId, groupId, ...einstellungen } = e;
      return {
        geraet: spur.label,
        gewaehlt: leseKameraWahl() ?? 'automatisch',
        kameras,
        einstellungen,
        strom: `${e.width}×${e.height}`,
        video: `${video.videoWidth}×${video.videoHeight}`,
        seitenverhaeltnis: e.aspectRatio?.toFixed?.(3),
        resizeMode: e.resizeMode,
        zoom: e.zoom,
        faehig: { breite: bereich(faehig.width), hoehe: bereich(faehig.height), zoom: bereich(faehig.zoom), resizeMode: faehig.resizeMode },
        imageCapture: !!erfassung,
        foto,
      };
    },

    stopp() {
      for (const s of strom.getTracks()) s.stop();
      video.srcObject = null;
    },
  };
}

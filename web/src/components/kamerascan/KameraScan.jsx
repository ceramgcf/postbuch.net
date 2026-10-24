import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import {
  Camera, Check, Copy, Crop, Flashlight, FlashlightOff, Loader2, Plus, RefreshCw, RotateCw, Settings, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useZurueckSchliesst } from '@/hooks/useBackButtonGuard';
import { erstelleScanner } from '@/lib/kamerascan/scannerClient';
import {
  starteKamera, kameraFehlertext, leseKameraStrom, schreibeKameraStrom, schreibeKameraWahl,
} from '@/lib/kamerascan/kamera';
import { erstelleAusloeser } from '@/lib/kamerascan/ausloeser';
import { skaliereEcken } from '@/lib/kamerascan/geometrie';
import { erstellePdf } from '@/lib/kamerascan/pdfSchreiber';
import { etikettAusQr, istSammelmappe, erstelleNativenQrLeser } from '@/lib/kamerascan/postbuchQr';
import { AutoForwardRing } from '@/components/ui/auto-forward-ring';
import { useDebugModus } from '@/hooks/useDebugModus';
import EckenEditor, { WerkzeugKnopf } from './EckenEditor';
import KameraEinstellungen from './KameraEinstellungen';

const SPEICHER = 'postbuch.kamerascan';
const MODI = [
  { wert: 'farbe', label: 'Farbe' },
  { wert: 'grau', label: 'Grau' },
  { wert: 'sw', label: 'SW' },
];

function leseVorgaben() {
  try {
    const roh = JSON.parse(localStorage.getItem(SPEICHER) || 'null');
    return {
      modus: MODI.some((m) => m.wert === roh?.modus) ? roh.modus : 'farbe',
      auto: typeof roh?.auto === 'boolean' ? roh.auto : true,
    };
  } catch {
    return { modus: 'farbe', auto: true };
  }
}

function schreibeVorgaben(wert) {
  try { localStorage.setItem(SPEICHER, JSON.stringify(wert)); } catch { /* gilt dann nur bis zum Neuladen */ }
}

const STATUS = {
  laden: 'Bildverarbeitung wird geladen …',
  suche: 'Blatt ins Bild halten',
  bewegt: 'Ruhig halten …',
  unscharf: 'Wird scharf gestellt – ruhig halten',
  bereit: 'Gleich wird ausgelöst',
  gesperrt: '',
  wechsel: 'Nächstes Blatt auflegen',
  manuell: 'Auslöser antippen',
};

let naechsteSeitenId = 1;

function blobZuDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const leser = new FileReader();
    leser.onerror = () => reject(leser.error || new Error('Lesefehler'));
    leser.onload = () => resolve(leser.result);
    leser.readAsDataURL(blob);
  });
}

function dateiname() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `Kamerascan_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}.pdf`;
}

/**
 * Vollflächiger Kamerascan. Bleibt dauerhaft gemountet und wird per
 * display:none ausgeblendet; Kamera und Worker laufen nur, solange `offen`.
 * `onFertig({ dataB64, dateiname, seiten, groesse })` lädt hoch und wirft bei
 * Fehlern – dann bleibt der Scan erhalten.
 */
export default function KameraScan({ offen, onSchliessen, onFertig, zielText = 'Hochladen', diagnose = false, onPostbuchQr }) {
  const [vorgaben, setVorgaben] = useState(leseVorgaben);
  const { modus, auto } = vorgaben;
  const [phase, setPhase] = useState('kamera'); // kamera | vorschau | ecken | senden
  const [seiten, setSeiten] = useState([]);
  const [aktiv, setAktiv] = useState(0);
  const [ersetzeIndex, setErsetzeIndex] = useState(null);
  const [ladeAnteil, setLadeAnteil] = useState(0);
  const [scannerBereit, setScannerBereit] = useState(false);
  const [kamera, setKamera] = useState(null);
  const [kameraDiagnose, setKameraDiagnose] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [hinweis, setHinweis] = useState(null);
  const [live, setLive] = useState(null); // { ecken, breite, hoehe }
  const liveRef = useRef(null);
  const [autoStatus, setAutoStatus] = useState({ zustand: 'suche', fortschritt: 0 });
  const [blitz, setBlitz] = useState(false);
  const [verwerfenFrage, setVerwerfenFrage] = useState(false);
  const [lampeAn, setLampeAn] = useState(false);
  // Zahnrad im Livebild: Kamerawahl wirkt sofort, `kameraLauf` startet den Strom neu.
  const [einstellungen, setEinstellungen] = useState(false);
  const einstellungenRef = useRef(false);
  einstellungenRef.current = einstellungen;
  const [kameraLauf, setKameraLauf] = useState(0);
  const debugModus = useDebugModus();

  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const ausloeserRef = useRef(null);
  const seitenRef = useRef(seiten);
  seitenRef.current = seiten;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const aufnahmeRef = useRef(false);
  const auftraege = useRef(new Map());
  const stromRef = useRef(null);
  const kameraStartRef = useRef(Promise.resolve());
  // Etiketten-QR im Livebild: Treffer läuft 3 s als Countdown, dann öffnet
  // sich das Dokument bzw. die Sammelmappe. Abgebrochene Kennungen bleiben für diese Sitzung stumm.
  const [qrTreffer, setQrTreffer] = useState(null);
  const qrRef = useRef(null);
  qrRef.current = qrTreffer;
  const qrIgnoriert = useRef(new Set());
  const qrLeserRef = useRef(undefined);
  const onPostbuchQrRef = useRef(onPostbuchQr);
  onPostbuchQrRef.current = onPostbuchQr;
  // Admin-Regel für erkannte Etiketten-Adressen (Einstellungen → Drucker)
  const { data: oeffentlich } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    enabled: offen && !!onPostbuchQr,
    staleTime: 60_000,
  });
  const qrRegelRef = useRef({});
  qrRegelRef.current = oeffentlich?.etikett_qr_erkennung?.value ?? {};

  const setzeVorgabe = (teil) => setVorgaben((alt) => {
    const neu = { ...alt, ...teil };
    schreibeVorgaben(neu);
    return neu;
  });

  // ── Lebenszyklus: Worker und Kamera nur, solange offen ─────────────────────
  useEffect(() => {
    if (!offen) return undefined;
    let beendet = false;
    qrIgnoriert.current.clear();
    setQrTreffer(null);
    setEinstellungen(false);
    if (qrLeserRef.current === undefined) erstelleNativenQrLeser().then((l) => { qrLeserRef.current = l; });
    setScannerBereit(false);
    setLadeAnteil(0);
    const scanner = erstelleScanner({ beiFortschritt: (a) => !beendet && setLadeAnteil(a) });
    scannerRef.current = scanner;
    ausloeserRef.current = erstelleAusloeser();
    scanner.bereit
      .then(() => { if (!beendet) setScannerBereit(true); })
      .catch((err) => { if (!beendet) setFehler(`Die Bildverarbeitung ließ sich nicht laden: ${err.message}`); });

    return () => {
      beendet = true;
      qrRef.current = null;
      setQrTreffer(null);
      scanner.beenden();
      scannerRef.current = null;
    };
  }, [offen]);

  // Kamera getrennt vom Worker, damit ein Kamerawechsel nur den Strom neu startet.
  useEffect(() => {
    if (!offen) return undefined;
    let beendet = false;
    setFehler(null);
    let kameraObjekt = null;
    stromRef.current = leseKameraStrom();
    // Erst starten, wenn ein noch laufender Start (schnelles Umschalten) fertig
    // und wieder gestoppt ist – zwei offene Ströme lehnen viele Geräte ab.
    const start = kameraStartRef.current
      .then(() => (beendet ? null : starteKamera(videoRef.current, stromRef.current)))
      .then((k) => {
        if (!k) return;
        if (beendet) { k.stopp(); return; }
        kameraObjekt = k;
        setKamera(k);
      })
      .catch((err) => { if (!beendet) setFehler(kameraFehlertext(err)); });
    kameraStartRef.current = start;

    return () => {
      beendet = true;
      kameraObjekt?.stopp();
      setKamera(null);
      setLampeAn(false);
      setLive(null);
      liveRef.current = null;
    };
  }, [offen, kameraLauf]);

  const kameraNeuStarten = () => {
    ausloeserRef.current?.sperren(performance.now());
    setKameraLauf((n) => n + 1);
  };

  const aufraeumen = useCallback(() => {
    for (const s of seitenRef.current) {
      if (s.vorschauUrl) URL.revokeObjectURL(s.vorschauUrl);
      if (s.fotoUrl) URL.revokeObjectURL(s.fotoUrl);
    }
    auftraege.current.clear();
    setSeiten([]);
    setAktiv(0);
    setErsetzeIndex(null);
    setPhase('kamera');
    setHinweis(null);
    setLive(null);
    liveRef.current = null;
  }, []);

  const schliessen = useCallback(() => {
    setVerwerfenFrage(false);
    aufraeumen();
    onSchliessen();
  }, [aufraeumen, onSchliessen]);

  const versucheSchliessen = useCallback(() => {
    if (phase === 'senden') return;
    if (seitenRef.current.length > 0) setVerwerfenFrage(true);
    else schliessen();
  }, [phase, schliessen]);

  useZurueckSchliesst(offen, versucheSchliessen);
  useZurueckSchliesst(offen && phase === 'ecken', () => setPhase('vorschau'));
  useZurueckSchliesst(offen && einstellungen, () => setEinstellungen(false));

  // ── Seiten rechnen ─────────────────────────────────────────────────────────
  const aendere = useCallback((id, teil) => {
    setSeiten((alt) => alt.map((s) => (s.id === id ? { ...s, ...(typeof teil === 'function' ? teil(s) : teil) } : s)));
  }, []);

  const rechne = useCallback(async (seite, mitModus) => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    const nr = (auftraege.current.get(seite.id) ?? 0) + 1;
    auftraege.current.set(seite.id, nr);
    aendere(seite.id, { rechnet: true, fehler: null });
    try {
      await scanner.bereit;
      const r = await scanner.seite(seite.foto, { ecken: seite.ecken, hinweis: seite.liveHinweis, modus: mitModus, drehung: seite.drehung });
      if (auftraege.current.get(seite.id) !== nr) return;
      const url = URL.createObjectURL(r.vorschau);
      aendere(seite.id, (alt) => {
        if (alt.vorschauUrl) URL.revokeObjectURL(alt.vorschauUrl);
        // Auf den Live-Ausschnitt zugeschnittenes Foto ersetzt das Original.
        const fotoTeil = r.foto ? { foto: r.foto, fotoUrl: URL.createObjectURL(r.foto) } : {};
        if (r.foto && alt.fotoUrl) URL.revokeObjectURL(alt.fotoUrl);
        return {
          ...fotoTeil,
          vorschauUrl: url,
          pdf: r.pdf,
          ecken: r.ecken,
          erkannt: alt.ecken ? alt.erkannt : r.erkannt,
          erkannteEcken: alt.erkannteEcken ?? r.ecken,
          fotoBreite: r.fotoBreite,
          fotoHoehe: r.fotoHoehe,
          diagnose: r.diagnose,
          rechnet: false,
        };
      });
    } catch (err) {
      if (auftraege.current.get(seite.id) !== nr) return;
      aendere(seite.id, { rechnet: false, fehler: err.message });
    }
  }, [aendere]);

  const aufnehmen = useCallback(async () => {
    if (!kamera || aufnahmeRef.current) return;
    aufnahmeRef.current = true;
    setBlitz(true);
    setTimeout(() => setBlitz(false), 180);
    try {
      // Ecken der Live-Vorschau als Hinweis für die Erkennung auf dem Foto
      // samt Videobild, damit der Worker den Ausschnitt des Fotos zuordnen kann
      const zuletzt = liveRef.current;
      const bild = zuletzt ? await kamera.vorschaubild(480).catch(() => null) : null;
      const liveHinweis = zuletzt ? { ...zuletzt, bild } : null;
      const foto = await kamera.foto();
      if (diagnose) {
        kamera.diagnose().then((d) => setKameraDiagnose({ angefordert: stromRef.current?.name, ...d }), (err) => setKameraDiagnose({ fehler: err?.message }));
      }
      const seite = {
        id: naechsteSeitenId++,
        foto,
        liveHinweis,
        fotoUrl: URL.createObjectURL(foto),
        ecken: null,
        erkannt: true,
        drehung: 0,
        rechnet: true,
        vorschauUrl: null,
        pdf: null,
      };
      const neu = seitenRef.current.slice();
      let index;
      if (ersetzeIndex != null && ersetzeIndex < neu.length) {
        const weg = neu[ersetzeIndex];
        if (weg.vorschauUrl) URL.revokeObjectURL(weg.vorschauUrl);
        if (weg.fotoUrl) URL.revokeObjectURL(weg.fotoUrl);
        auftraege.current.delete(weg.id);
        neu[ersetzeIndex] = seite;
        index = ersetzeIndex;
      } else {
        neu.push(seite);
        index = neu.length - 1;
      }
      seitenRef.current = neu;
      setSeiten(neu);
      setAktiv(index);
      setErsetzeIndex(null);
      setPhase('vorschau');
      ausloeserRef.current?.neuesBlattAbwarten();
      rechne(seite, modus);
    } catch (err) {
      setHinweis(`Aufnahme fehlgeschlagen: ${err.message}`);
    } finally {
      aufnahmeRef.current = false;
    }
  }, [kamera, ersetzeIndex, rechne, modus, diagnose]);

  const aufnehmenRef = useRef(aufnehmen);
  aufnehmenRef.current = aufnehmen;

  // ── Live-Analyse ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!offen || phase !== 'kamera' || !kamera || !scannerBereit) return undefined;
    let laeuft = true;
    const video = videoRef.current;
    if (video?.paused) video.play().catch(() => {});
    let runde = 0;
    // Nur solange noch keine Seite aufgenommen ist: Wer schon scannt, will
    // nicht mitten im Stapel weggeführt werden.
    const sucheQr = async (scanner) => {
      if (!onPostbuchQrRef.current || qrRef.current || seitenRef.current.length > 0) return;
      const nativ = qrLeserRef.current;
      // Nativ jede zweite Runde, mit OpenCV (teurer) jede vierte.
      if (runde % (nativ ? 2 : 4) !== 0) return;
      let texte = [];
      try {
        if (nativ) texte = await nativ(video);
        else {
          const bild = await kamera.vorschaubild(1280);
          if (bild) texte = (await scanner.qr(bild)).texte;
        }
      } catch { return; }
      const kennung = texte.map((t) => etikettAusQr(t, { aliase: qrRegelRef.current.aliase, alleAdressen: qrRegelRef.current.alleAdressen })).find((p) => p && !qrIgnoriert.current.has(p));
      if (kennung && laeuft) {
        qrRef.current = kennung;
        setQrTreffer(kennung);
      }
    };
    (async () => {
      while (laeuft) {
        runde += 1;
        const scanner = scannerRef.current;
        let bild = null;
        try { bild = await kamera.vorschaubild(960); } catch { /* Video noch nicht bereit */ }
        if (!bild || !scanner) {
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }
        let r;
        try {
          r = await scanner.analyse(bild, { schaerfe: autoRef.current });
        } catch {
          break;
        }
        if (!laeuft) break;
        liveRef.current = r.ecken ? { ecken: r.ecken, breite: r.breite, hoehe: r.hoehe } : null;
        setLive(r.ecken ? r : null);
        if (scanner) await sucheQr(scanner);
        if (!laeuft) break;
        if (autoRef.current && !aufnahmeRef.current && !qrRef.current && !einstellungenRef.current) {
          const s = ausloeserRef.current.schritt({ ...r, jetzt: performance.now() });
          setAutoStatus(s);
          if (s.zustand === 'ausloesen') aufnehmenRef.current();
        }
      }
    })();
    return () => { laeuft = false; };
  }, [offen, phase, kamera, scannerBereit]);

  // Antippen der Live-Ansicht bricht eine laufende Automatik ab.
  const liveAngetippt = () => {
    if (qrRef.current) { qrAbbrechen(); return; }
    if (auto && autoStatus.zustand === 'bereit') {
      ausloeserRef.current?.sperren(performance.now());
      setAutoStatus({ zustand: 'gesperrt', fortschritt: 0 });
    }
  };

  function qrAbbrechen() {
    if (qrRef.current) qrIgnoriert.current.add(qrRef.current);
    qrRef.current = null;
    setQrTreffer(null);
  }

  // Treffer vor dem Springen löschen: Sonst bliebe er stehen, und jedes neue
  // onSchliessen der Elternkomponente (neue Funktion je Render) startete den
  // Countdown erneut – nach jeder Navigation ginge es zurück ins Dokument.
  const qrOeffnen = () => {
    const kennung = qrRef.current;
    if (!kennung) return;
    qrRef.current = null;
    setQrTreffer(null);
    schliessen();
    onPostbuchQrRef.current?.(kennung);
  };
  const qrOeffnenRef = useRef(qrOeffnen);
  qrOeffnenRef.current = qrOeffnen;

  useEffect(() => {
    if (!qrTreffer) return undefined;
    const t = setTimeout(() => qrOeffnenRef.current(), 3000);
    return () => clearTimeout(t);
  }, [qrTreffer]);

  // ── Aktionen der Vorschau ─────────────────────────────────────────────────
  const aktuelle = seiten[aktiv];

  const modusWechseln = (neu) => {
    if (neu === modus) return;
    setzeVorgabe({ modus: neu });
    for (const s of seitenRef.current) rechne(s, neu);
  };

  const drehen = () => {
    if (!aktuelle) return;
    const neu = { ...aktuelle, drehung: (aktuelle.drehung + 1) % 4 };
    aendere(aktuelle.id, { drehung: neu.drehung });
    rechne(neu, modus);
  };

  const entfernen = (index = aktiv) => {
    const s = seiten[index];
    if (!s) return;
    if (s.vorschauUrl) URL.revokeObjectURL(s.vorschauUrl);
    if (s.fotoUrl) URL.revokeObjectURL(s.fotoUrl);
    auftraege.current.delete(s.id);
    const rest = seiten.filter((_, i) => i !== index);
    setSeiten(rest);
    if (rest.length === 0) {
      setAktiv(0);
      setPhase('kamera');
    } else {
      setAktiv(Math.min(index, rest.length - 1));
    }
  };

  const neuAufnehmen = () => {
    setErsetzeIndex(aktiv);
    setPhase('kamera');
  };

  const seiteHinzufuegen = () => {
    setErsetzeIndex(null);
    setPhase('kamera');
  };

  const eckenUebernehmen = (ecken) => {
    if (!aktuelle) return;
    const neu = { ...aktuelle, ecken };
    aendere(aktuelle.id, { ecken });
    setPhase('vorschau');
    rechne(neu, modus);
  };

  const alleFertig = seiten.length > 0 && seiten.every((s) => !s.rechnet && s.pdf);

  const abschliessen = async () => {
    if (!alleFertig) return;
    setPhase('senden');
    setHinweis(null);
    try {
      const pdf = erstellePdf(seiten.map((s) => s.pdf));
      const blob = new Blob([pdf], { type: 'application/pdf' });
      const dataB64 = await blobZuDataUrl(blob);
      await onFertig({ dataB64, dateiname: dateiname(), seiten: seiten.length, groesse: blob.size });
      aufraeumen();
      onSchliessen();
    } catch (err) {
      setHinweis(err.message || 'Hochladen fehlgeschlagen');
      setPhase('vorschau');
    }
  };

  // ── Darstellung ───────────────────────────────────────────────────────────
  const status0 = !scannerBereit
    ? STATUS.laden
    : !auto ? (live ? STATUS.manuell : STATUS.suche) : STATUS[autoStatus.zustand];
  const status = status0 === STATUS.suche && onPostbuchQr && seiten.length === 0 ? 'Blatt oder Etikett ins Bild halten' : status0;
  const liveEcken = live && kamera && videoRef.current?.videoWidth
    ? skaliereEcken(live.ecken, videoRef.current.videoWidth / live.breite, videoRef.current.videoHeight / live.hoehe)
    : null;
  const vb = videoRef.current;

  return createPortal(
    <div
      className="fixed inset-0 z-[900] flex flex-col bg-black text-white"
      style={{ display: offen ? 'flex' : 'none' }}
      role="dialog"
      aria-modal="true"
      aria-label="Mit Kamera scannen"
    >
      {/* Kopfzeile */}
      <div className="flex items-center gap-2 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button type="button" onClick={versucheSchliessen} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10" aria-label="Kamerascan schließen">
          <X className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {phase === 'ecken' ? 'Ecken anpassen'
            : phase === 'kamera' ? (ersetzeIndex != null ? `Seite ${ersetzeIndex + 1} neu aufnehmen` : `Seite ${seiten.length + 1}`)
              : `Seite ${aktiv + 1} von ${seiten.length}`}
        </div>
        {phase !== 'ecken' && (
          <div className="flex rounded-full bg-white/10 p-0.5" role="radiogroup" aria-label="Farbmodus">
            {MODI.map((m) => (
              <button
                key={m.wert}
                type="button"
                role="radio"
                aria-checked={modus === m.wert}
                disabled={phase === 'senden'}
                onClick={() => modusWechseln(m.wert)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${modus === m.wert ? 'bg-white text-black' : 'text-white/80'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        {phase === 'kamera' && kamera?.hatLampe && (
          <button
            type="button"
            onClick={async () => { await kamera.lampe(!lampeAn).catch(() => {}); setLampeAn(kamera.lampeAn); }}
            className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10"
            aria-label={lampeAn ? 'Licht aus' : 'Licht an'}
            aria-pressed={lampeAn}
          >
            {lampeAn ? <Flashlight className="h-5 w-5 text-amber-300" /> : <FlashlightOff className="h-5 w-5" />}
          </button>
        )}
      </div>

      {/* Live-Ansicht – bleibt gemountet, damit der Videostrom weiterläuft */}
      <div className="relative min-h-0 flex-1" style={{ display: phase === 'kamera' ? 'block' : 'none' }} onClick={liveAngetippt}>
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" playsInline muted autoPlay />
        {vb?.videoWidth > 0 && (
          <svg
            viewBox={`0 0 ${vb.videoWidth} ${vb.videoHeight}`}
            preserveAspectRatio="xMidYMid meet"
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            {liveEcken && (
              <polygon
                points={liveEcken.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={autoStatus.zustand === 'bereit' ? 'rgba(34,197,94,0.22)' : 'rgba(139,92,246,0.2)'}
                stroke={autoStatus.zustand === 'bereit' ? 'rgb(34,197,94)' : 'rgb(167,139,250)'}
                strokeWidth={Math.max(vb.videoWidth, vb.videoHeight) * 0.005}
                strokeLinejoin="round"
              />
            )}
          </svg>
        )}
        {blitz && <div className="pointer-events-none absolute inset-0 bg-white/70" />}
        {qrTreffer && (
          <div className="absolute inset-x-3 bottom-3 z-10 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-neutral-900/95 p-3 shadow-lg" onClick={(e) => e.stopPropagation()} role="alert">
            <AutoForwardRing onCancel={qrAbbrechen} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Etikett {qrTreffer} erkannt</p>
              <p className="text-xs text-white/70">{istSammelmappe(qrTreffer) ? 'Die Sammelmappe wird geöffnet.' : 'Das Dokument wird geöffnet.'}</p>
            </div>
            <Button size="sm" onClick={qrOeffnen}>Öffnen</Button>
          </div>
        )}
        {status && !fehler && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-black/65 px-4 py-1.5 text-sm" role="status" aria-live="polite">
              {status}
              {!scannerBereit && ladeAnteil > 0 && ` ${Math.round(ladeAnteil * 100)} %`}
            </span>
          </div>
        )}
        {einstellungen && (
          <KameraEinstellungen
            geraetId={kamera?.geraetId}
            mitLivebild={debugModus}
            onKamera={(label) => { schreibeKameraWahl(label || null); kameraNeuStarten(); }}
            onStrom={(id) => { schreibeKameraStrom(id); kameraNeuStarten(); }}
            onSchliessen={() => setEinstellungen(false)}
          />
        )}
        {fehler && (
          <div className="absolute inset-x-4 top-1/3 rounded-xl bg-neutral-900 p-4 text-sm">
            <p>{fehler}</p>
            <Button className="mt-3" variant="secondary" onClick={schliessen}>Schließen</Button>
          </div>
        )}
      </div>

      {/* Vorschau der aktuellen Seite */}
      {phase === 'vorschau' && aktuelle && (
        <div className="relative min-h-0 flex-1">
          {/* Kamera-Diagnose (Debug-Modus, Knopf auf der Importseite) */}
          {diagnose && kameraDiagnose && (
            <DiagnoseAnzeige text={JSON.stringify({ kamera: kameraDiagnose, seite: aktuelle.diagnose }, null, 1)} />
          )}
          {aktuelle.vorschauUrl && (
            <img src={aktuelle.vorschauUrl} alt={`Seite ${aktiv + 1}`} className="absolute inset-0 h-full w-full object-contain p-3" />
          )}
          {aktuelle.rechnet && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Seite wird aufbereitet …
              </span>
            </div>
          )}
          {!aktuelle.rechnet && !aktuelle.erkannt && (
            <p className="absolute inset-x-4 top-3 rounded-lg bg-amber-500/90 px-3 py-2 text-center text-sm text-black">
              Kein Blatt erkannt – bitte die Ecken anpassen.
            </p>
          )}
          {aktuelle.fehler && (
            <p className="absolute inset-x-4 top-3 rounded-lg bg-red-600/90 px-3 py-2 text-center text-sm">{aktuelle.fehler}</p>
          )}
        </div>
      )}

      {phase === 'ecken' && aktuelle?.fotoBreite && (
        <div className="min-h-0 flex-1">
          <EckenEditor
            fotoUrl={aktuelle.fotoUrl}
            breite={aktuelle.fotoBreite}
            hoehe={aktuelle.fotoHoehe}
            ecken={aktuelle.ecken}
            erkannt={aktuelle.erkannt}
            onUebernehmen={eckenUebernehmen}
            onAbbrechen={() => setPhase('vorschau')}
          />
        </div>
      )}

      {phase === 'senden' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm">
          <Loader2 className="h-8 w-8 animate-spin" />
          PDF mit {seiten.length} {seiten.length === 1 ? 'Seite' : 'Seiten'} wird hochgeladen …
        </div>
      )}

      {hinweis && phase !== 'senden' && (
        <div className="mx-3 mb-2 rounded-lg bg-red-600/90 px-3 py-2 text-sm" role="alert">{hinweis}</div>
      )}

      {/* Seitenleiste */}
      {(phase === 'vorschau' || (phase === 'kamera' && seiten.length > 0)) && (
        <div className="flex gap-2 overflow-x-auto px-3 py-2" aria-label="Seiten">
          {seiten.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { setAktiv(i); setErsetzeIndex(null); setPhase('vorschau'); }}
              className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-md border-2 bg-white/10 ${phase === 'vorschau' && i === aktiv ? 'border-violet-400' : 'border-transparent'}`}
              aria-label={`Seite ${i + 1}`}
            >
              {s.vorschauUrl && <img src={s.vorschauUrl} alt="" className="h-full w-full object-cover" />}
              {s.rechnet && <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin" />}
              <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[10px]">{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      {/* Fußleiste */}
      {phase === 'kamera' && (
        <div className="grid grid-cols-3 items-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
          <div>
            {seiten.length > 0 && (
              <button type="button" onClick={() => { setErsetzeIndex(null); setPhase('vorschau'); }} className="rounded-full px-3 py-2 text-sm font-medium hover:bg-white/10">
                Fertig ({seiten.length})
              </button>
            )}
          </div>
          <div className="flex justify-center">
            <Ausloeser
              onClick={() => aufnehmen()}
              disabled={!kamera || !!fehler}
              fortschritt={auto ? autoStatus.fortschritt : 0}
              bereit={auto && autoStatus.zustand === 'bereit'}
            />
          </div>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setEinstellungen((an) => !an)}
              className={`flex h-10 w-10 items-center justify-center rounded-full ${einstellungen ? 'bg-white/20' : 'hover:bg-white/10'}`}
              aria-label="Kamera-Einstellungen"
              aria-expanded={einstellungen}
            >
              <Settings className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => { setzeVorgabe({ auto: !auto }); ausloeserRef.current?.sperren(performance.now()); }}
              className={`rounded-full px-3 py-2 text-sm font-semibold ${auto ? 'bg-violet-500/30 text-violet-200' : 'bg-white/10 text-white/80'}`}
              aria-pressed={auto}
            >
              {auto ? 'Auto' : 'Manuell'}
            </button>
          </div>
        </div>
      )}

      {phase === 'vorschau' && aktuelle && (
        <div className="px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-4 gap-1">
            <WerkzeugKnopf icon={Crop} label="Ecken" onClick={() => setPhase('ecken')} disabled={aktuelle.rechnet || !aktuelle.fotoBreite} />
            <WerkzeugKnopf icon={RotateCw} label="Drehen" onClick={drehen} disabled={aktuelle.rechnet} />
            <WerkzeugKnopf icon={RefreshCw} label="Neu aufnehmen" onClick={neuAufnehmen} />
            <WerkzeugKnopf icon={Trash2} label="Entfernen" onClick={() => entfernen()} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="secondary" className="h-12" onClick={seiteHinzufuegen}>
              <Plus className="h-4 w-4" /> Seite hinzufügen
            </Button>
            <Button className="h-12" onClick={abschliessen} disabled={!alleFertig}>
              <Check className="h-4 w-4" /> {zielText} ({seiten.length})
            </Button>
          </div>
        </div>
      )}

      <Dialog open={verwerfenFrage} onOpenChange={setVerwerfenFrage} size="sm">
        <DialogTitle>Scan verwerfen?</DialogTitle>
        <DialogDescription>
          {seiten.length === 1 ? 'Die aufgenommene Seite geht verloren.' : `Die ${seiten.length} aufgenommenen Seiten gehen verloren.`}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setVerwerfenFrage(false)}>Weiter scannen</Button>
          <Button variant="destructive" onClick={schliessen}>Verwerfen</Button>
        </DialogFooter>
      </Dialog>
    </div>,
    document.body,
  );
}

function Ausloeser({ onClick, disabled, fortschritt, bereit }) {
  const umfang = 2 * Math.PI * 34;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      className="relative flex h-[76px] w-[76px] items-center justify-center rounded-full disabled:opacity-40"
      aria-label="Seite aufnehmen"
    >
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 76 76" aria-hidden>
        <circle cx="38" cy="38" r="34" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="4" />
        {fortschritt > 0 && (
          <circle
            cx="38" cy="38" r="34" fill="none"
            stroke={bereit ? 'rgb(34,197,94)' : 'rgb(167,139,250)'}
            strokeWidth="4" strokeLinecap="round"
            strokeDasharray={umfang} strokeDashoffset={umfang * (1 - fortschritt)}
            style={{ transition: 'stroke-dashoffset 180ms linear' }}
          />
        )}
      </svg>
      <span className="flex h-[60px] w-[60px] items-center justify-center rounded-full bg-white text-black">
        <Camera className="h-6 w-6" />
      </span>
    </button>
  );
}

// Kamera-Diagnose als JSON, mit Knopf zum Kopieren in die Zwischenablage.
function DiagnoseAnzeige({ text }) {
  const [kopiert, setKopiert] = useState(false);
  const kopieren = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    }, () => {});
  };
  return (
    <div className="absolute inset-x-1 top-1 z-10 max-h-[70%] overflow-auto rounded bg-black/80">
      <button
        type="button"
        onClick={kopieren}
        className="sticky top-1 float-right m-1 flex items-center gap-1 rounded bg-white/15 px-2 py-1 text-xs text-white hover:bg-white/25"
      >
        {kopiert ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {kopiert ? 'Kopiert' : 'Kopieren'}
      </button>
      <pre className="whitespace-pre-wrap p-2 text-[10px] leading-tight text-lime-300">{text}</pre>
    </div>
  );
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { leseImportFolgen, folgenUrl } from '@/lib/importFolgen';
import { etikettPfad } from '@/lib/kamerascan/postbuchQr';
import { STAPEL_EREIGNIS, stapelInfo, stapelLeeren } from '@/lib/kamerascan/stapelSpeicher';
import KameraScan from './KameraScan';

const Kontext = createContext(null);

function umfangText(seiten, groesse) {
  const groessenText = groesse < 1024 * 1024
    ? `${Math.max(1, Math.round(groesse / 1024))} KB`
    : `${(groesse / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
  return `${seiten} ${seiten === 1 ? 'Seite' : 'Seiten'}, ${groessenText}`;
}

/**
 * Der eine Seitenstapel der App: Kamerascan, Galerie-Fotos, geteilte Fotos
 * und Bilder aus dem Datei-Upload landen im selben Scan. Liegt über allen
 * Seiten, damit ein offener Scan Seitenwechsel übersteht.
 *
 * `oeffnen({ fotos, diagnose, ersetzen, onErsetzt, folgen })`:
 * - `fotos` hängt Bilddateien an (bzw. beginnt damit einen Scan),
 * - `ersetzen` (PostID) lädt die fertige PDF als neue Datei dieses Eintrags
 *   hoch – ohne den gespeicherten Stapel anzufassen,
 * - `folgen` erzwingt nach dem Hochladen die Jobs-Ansicht (geteilte Fotos).
 */
export function SeitenstapelProvider({ children }) {
  const { canWrite } = useAuth();
  const navigate = useNavigate();
  const [sitzung, setSitzung] = useState(null);
  const [info, setInfo] = useState(null); // { anzahl, zeit } des gespeicherten Stapels
  const [meldung, setMeldung] = useState(null);

  useEffect(() => {
    if (!canWrite) return undefined;
    const aktualisieren = () => stapelInfo().then(setInfo);
    aktualisieren();
    const beiSichtbar = () => { if (document.visibilityState === 'visible') aktualisieren(); };
    window.addEventListener(STAPEL_EREIGNIS, aktualisieren);
    document.addEventListener('visibilitychange', beiSichtbar);
    return () => {
      window.removeEventListener(STAPEL_EREIGNIS, aktualisieren);
      document.removeEventListener('visibilitychange', beiSichtbar);
    };
  }, [canWrite]);

  useEffect(() => {
    if (!meldung) return undefined;
    const t = setTimeout(() => setMeldung(null), 5000);
    return () => clearTimeout(t);
  }, [meldung]);

  const oeffnen = useCallback((optionen = {}) => {
    if (!canWrite) return;
    setMeldung(null);
    setSitzung((alt) => {
      // Ein offener Scan nimmt weitere Fotos auf, statt neu zu beginnen.
      if (alt && !alt.ersetzen && !optionen.ersetzen) {
        return { ...alt, fotos: optionen.fotos?.length ? optionen.fotos : alt.fotos, folgen: alt.folgen || !!optionen.folgen };
      }
      return { ...optionen };
    });
  }, [canWrite]);

  const verwerfen = useCallback(() => stapelLeeren(), []);

  const hochladen = useCallback(async ({ dokumente, beiHochgeladen }) => {
    if (sitzung?.ersetzen) {
      const [d] = dokumente;
      const res = await api.postbuch.replacePdf(sitzung.ersetzen, { dataB64: d.dataB64 });
      beiHochgeladen(0);
      sitzung.onErsetzt?.(res);
      setMeldung(`PDF ersetzt (${umfangText(d.seiten, d.groesse)}).`);
      return;
    }
    const jobIds = [];
    for (const [i, d] of dokumente.entries()) {
      const res = await api.import.upload(d.dateiname, d.dataB64);
      jobIds.push(res.jobId);
      beiHochgeladen(i);
    }
    if (sitzung?.folgen || leseImportFolgen().scan) {
      navigate(folgenUrl({ jobIds }));
      return;
    }
    const [erstes] = dokumente;
    setMeldung(dokumente.length === 1
      ? `Scan hochgeladen (${umfangText(erstes.seiten, erstes.groesse)}) · Job ${String(jobIds[0]).slice(0, 8)}…`
      : `${dokumente.length} Dokumente hochgeladen.`);
  }, [sitzung, navigate]);

  const wert = useMemo(() => ({
    verfuegbar: canWrite,
    offen: !!sitzung,
    // Gespeicherter Stapel, solange er nicht gerade bearbeitet wird
    offenerScan: sitzung || !canWrite ? null : info,
    oeffnen,
    verwerfen,
  }), [canWrite, sitzung, info, oeffnen, verwerfen]);

  return (
    <Kontext.Provider value={wert}>
      {children}
      {canWrite && (
        <KameraScan
          offen={!!sitzung}
          fotos={sitzung?.fotos ?? null}
          dauerhaft={!sitzung?.ersetzen}
          einzelnErlaubt={!sitzung?.ersetzen}
          diagnose={!!sitzung?.diagnose}
          onSchliessen={() => setSitzung(null)}
          onFertig={hochladen}
          zielText={sitzung?.ersetzen ? `${sitzung.ersetzen} ersetzen` : 'Hochladen'}
          onPostbuchQr={sitzung?.ersetzen ? undefined : (kennung) => navigate(etikettPfad(kennung))}
        />
      )}
      {meldung && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center gap-2 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          {meldung}
        </div>
      )}
    </Kontext.Provider>
  );
}

export function useSeitenstapel() {
  const wert = useContext(Kontext);
  if (!wert) throw new Error('useSeitenstapel außerhalb von SeitenstapelProvider');
  return wert;
}

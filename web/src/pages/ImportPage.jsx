import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Progress } from '@/components/ui/progress';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import {
  Upload, Scan, FileText, Trash2, Play, X, CheckCircle2, AlertTriangle, AlertCircle,
  ArrowUp, ArrowDown, Layers, Inbox, Loader2, StopCircle, GripVertical,
  FileUp, ArrowLeft, Copy, Check, Info, Coins, PackageOpen, Lightbulb, ArrowRight,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import PersonenZuordnung, { KEINE } from '@/components/import/PersonenZuordnung';
import { MenschDialog } from '@/components/settings/MenschenCard';

// ── Scanner-Konfiguration ───────────────────────────────────────────────────

const SOURCE_OPTIONS = [
  { id: 'adf',           label: 'ADF',                   desc: 'Mehrere Seiten durch Einzug, ein Dokument',  session: false, size: false, requiresAdf: true },
  { id: 'adf-batch',     label: 'ADF Stapel',            desc: 'Jedes Blatt wird ein eigenes Dokument; bei Beidseitig entfallen leere Rückseiten automatisch', session: false, size: false, requiresAdf: true, batch: true },
  { id: 'flatbed-single',label: 'Flachbett Einzelseite',desc: 'Eine Seite vom Flachbett',                   endpoint: 'flatbed/single',    session: false, size: true  },
  { id: 'flatbed-multi', label: 'Flachbett Mehrseitig', desc: 'Mehrseitig vom Flachbett (Session)',         endpoint: 'flatbed/session/scan', session: true, size: true },
];

/** Vorderseite/Beidseitig-Optionen für den ADF-Seitenschalter. */
const DUPLEX_OPTIONS = [
  { id: 'simplex', label: 'Vorderseite', desc: 'Nur die Vorderseite jedes Blatts' },
  { id: 'duplex',  label: 'Beidseitig',  desc: 'Vorder- und Rückseite jedes Blatts' },
];

const MODE_LABELS = { gray: 'Graustufen', color: 'Farbe', bw: 'Schwarzweiß' };

// Stand vor der Fähigkeitsermittlung. Greift, solange `scanner_capabilities`
// fehlt – ein Update zwingt damit niemanden, erst etwas zu ermitteln.
// Gegenstück zu STANDARD_QUELLE in app/src/lib/scanner-capabilities.js; beide
// Seiten müssen dieselben Werte nennen.
const STANDARD_QUELLE = { aufloesungen: [300, 600], modi: ['gray', 'color'] };

/** Ordnet eine Quelle + Seitenwahl dem tatsächlichen Scan-Endpunkt zu. */
function endpunktFuerQuelle(sourceOpt, duplex) {
  if (!sourceOpt) return undefined;
  if (sourceOpt.id === 'adf') return duplex ? 'adf/duplex' : 'adf/simplex';
  if (sourceOpt.id === 'adf-batch') return duplex ? 'adf/batch/duplex' : 'adf/batch/simplex';
  return sourceOpt.endpoint;
}

/** Ordnet einen Scan-Endpunkt der Quelle zu, deren Fähigkeiten für ihn gelten. */
function quelleFuerEndpunkt(endpunkt) {
  const e = String(endpunkt);
  if (!e.startsWith('adf/')) return 'flatbed';
  // Deckt sowohl 'adf/duplex' als auch 'adf/batch/duplex' ab.
  return e.endsWith('duplex') ? 'adf-duplex' : 'adf';
}

const SIZE_OPTIONS = [
  { id: 'a3', label: 'A3', requiresA3: true },
  { id: 'a4', label: 'A4' },
  { id: 'a5', label: 'A5' },
  { id: 'a6', label: 'A6' },
];

const SCANNER_SETTINGS_LINK = '/einstellungen?tab=scanner';

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader-Fehler'));
    reader.onload = () => {
      const result = reader.result;
      // result ist data:application/pdf;base64,XXXX – Backend schneidet das ab
      resolve(typeof result === 'string' ? result : '');
    };
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes) {
  if (!bytes) return '–';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

// Baut symmetrische Undo/Redo-Funktionen für einen Replace-Vorgang.
// `result` hat die Form { postid, parentId, filename, old, new } wie sie der
// Backend-Endpunkt zurückgibt.
function buildReplaceUndoRedo(postid, result) {
  const { parentId, filename, old, new: nw } = result;
  return {
    description: `PDF ersetzt für ${postid}`,
    undo: async () => {
      await api.postbuch.restoreReplacedPdf(postid, {
        activeOnedriveId: nw.onedriveId,
        restoreOnedriveId: old.onedriveId,
        parentId, filename,
        restoreSha256: old.sha256,
        restoreOnedriveModified: old.onedriveModified,
      });
    },
    redo: async () => {
      await api.postbuch.restoreReplacedPdf(postid, {
        activeOnedriveId: old.onedriveId,
        restoreOnedriveId: nw.onedriveId,
        parentId, filename,
        restoreSha256: nw.sha256,
        restoreOnedriveModified: nw.onedriveModified,
      });
    },
  };
}

// Wartet bis ein Backend-Replace-Job für die gegebene postid auftaucht und
// abgeschlossen ist; gibt das gespeicherte payload zurück (enthält old/new
// State für Undo). Wird im Scanner-Replace-Pfad genutzt, da der eigentliche
// PDF-Tausch erst nach OCR im Webhook passiert.
async function pollScannerReplaceResult(postid, { timeoutMs = 8 * 60 * 1000 } = {}) {
  const POLL_INTERVAL = 3000;
  const deadline = Date.now() + timeoutMs;
  let foundJobId = null;

  while (Date.now() < deadline) {
    if (!foundJobId) {
      const list = await api.jobs.list().catch(() => null);
      const labelPrefix = `Ersetzen ${postid}:`;
      const candidates = [
        ...((list?.active) || []),
        ...((list?.recent) || []),
      ].filter(j => j.type === 'doc-replace' && (j.label || '').startsWith(labelPrefix));
      if (candidates.length > 0) {
        // Neuester Eintrag (active läuft noch, recent ist nach completed_at sortiert)
        foundJobId = candidates[0].id;
      }
    }

    if (foundJobId) {
      const job = await api.jobs.get(foundJobId).catch(() => null);
      if (job) {
        if (job.status === 'done') {
          const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
          return payload;
        }
        if (job.status === 'failed') {
          throw new Error(job.error_message || 'PDF-Austausch fehlgeschlagen');
        }
        if (job.status === 'cancelled') {
          throw new Error('PDF-Austausch wurde abgebrochen');
        }
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error('Zeitüberschreitung beim Warten auf den PDF-Austausch');
}

// Wartet auf den Abschluss eines bereits bekannten Jobs (per jobId) und liefert
// dessen payload zurück. Ruft optional onStep(step, totalSteps) für den
// Fortschritt während der Verarbeitung auf. Der Archiv-Import kann bei sehr
// großen Übergaben Stunden dauern — deshalb kein fester Timeout.
async function pollJobResult(jobId, { onStep } = {}) {
  const POLL_INTERVAL = 2000;
  for (;;) {
    const job = await api.jobs.get(jobId).catch(() => null);
    if (job) {
      if (onStep) onStep(job.step, job.total_steps ?? job.totalSteps);
      if (job.status === 'done') {
        return typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      }
      if (job.status === 'failed') {
        throw new Error(job.error_message || job.errorMessage || 'Import fehlgeschlagen');
      }
      if (job.status === 'cancelled') {
        throw new Error('Import wurde abgebrochen');
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// ── Toggle-Group (radio) ────────────────────────────────────────────────────

function OptionGroup({ options, value, onChange, disabled }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => {
        const active = opt.id === value;
        const optionDisabled = disabled || !!opt.disabled;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={optionDisabled}
            onClick={() => onChange(opt.id)}
            className={[
              'inline-flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-all',
              active
                ? 'border-primary bg-primary/10 text-primary shadow-sm shadow-primary/10'
                : 'border-border/60 bg-background hover:border-primary/40 hover:bg-primary/5',
              optionDisabled ? 'opacity-50 pointer-events-none' : '',
            ].join(' ')}
          >
            <span className="font-medium">{opt.label}</span>
            {opt.desc && <span className="text-xs text-muted-foreground">{opt.desc}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── Webhook-URL-Feld ─────────────────────────────────────────────────────────

function WebhookUrlField({ source, dpi, mode, size }) {
  const [copied, setCopied] = useState(false);

  const { data: portData } = useQuery({
    queryKey: ['scanner-port'],
    queryFn: () => api.import.scannerPort(),
    staleTime: Infinity,
    retry: false,
  });

  const url = useMemo(() => {
    if (!source || !dpi || !mode || !portData?.port) return '';
    const base = `http://${window.location.hostname}:${portData.port}/scan/${source.endpoint}`;
    const params = new URLSearchParams();
    params.set('dpi', String(dpi));
    params.set('mode', mode);
    if (source.size && size) params.set('size', size);
    return `${base}?${params.toString()}`;
  }, [source, dpi, mode, size, portData?.port]);

  const handleCopy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Webhook-URL</label>
        <div className="relative group">
          <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
          <div className="absolute left-0 bottom-full mb-1.5 z-50 w-80 rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-muted-foreground shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none">
            Über diese URL kann ein Scan jederzeit auch außerhalb dieser Anwendung ausgelöst werden, sofern der Aufruf aus demselben Netzwerk erfolgt. Sie bildet eine Schnittstelle für andere Anwendungen (z. B. Heimautomatisierung oder Skripte).
            {source?.session && (
              <>
                <br /><br />
                <span className="font-medium text-foreground">Hinweis:</span> Mehrseitige Flachbett-Scans erfordern mehrere Aufrufe – je Seite <code className="font-mono">/session/scan</code>, dann <code className="font-mono">/session/finish</code> zum Abschließen.
              </>
            )}
            {source?.batch && (
              <>
                <br /><br />
                <span className="font-medium text-foreground">Hinweis:</span> Ein einzelner Aufruf scannt den ganzen Stapel und liefert mehrere Dokumente zurück, ein PDF je Blatt.
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          className="flex-1 min-w-0 rounded-md border border-border/40 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground font-mono cursor-text focus:outline-none focus:ring-1 focus:ring-border"
        />
        <button
          type="button"
          onClick={handleCopy}
          title="URL kopieren"
          className="flex-shrink-0 flex items-center justify-center rounded-md border border-border/40 bg-background p-1.5 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

// ── Scanner-Card ─────────────────────────────────────────────────────────────

function ScannerCard({ replaceForPostId = null, onReplaceComplete }) {
  const { isAdmin } = useAuth();
  const { data: settings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    retry: false,
    staleTime: 30_000,
  });
  const { data: importwege, isLoading: importwegeLaedt } = useQuery({
    queryKey: ['importwege'],
    queryFn: () => api.settingsPublic.importwege(),
    retry: false,
  });

  const scannerCaps = useMemo(() => {
    const hasAdf = parseBool(settings?.scanner_has_adf?.value, false);
    const supportsA3 = parseBool(settings?.scanner_supports_a3?.value, false);
    const adfDuplex = parseBool(settings?.scanner_adf_duplex?.value, false);
    return { hasAdf, supportsA3, adfDuplex };
  }, [settings]);

  const sourceOptions = useMemo(() => {
    // ADF-Stapel erzeugt mehrere Dokumente aus einem Scan-Vorgang — das passt
    // nicht zum Ersetzen-Modus (genau eine Ziel-Datei für einen Eintrag).
    return SOURCE_OPTIONS
      .filter((opt) => !(opt.batch && replaceForPostId))
      .map((opt) => {
        const unavailableReason = opt.requiresAdf && !scannerCaps.hasAdf
          ? 'ADF in Scanner-Settings deaktiviert'
          : null;
        return { ...opt, disabled: !!unavailableReason, unavailableReason };
      });
  }, [scannerCaps, replaceForPostId]);

  const sizeOptions = useMemo(() => {
    return SIZE_OPTIONS.map((opt) => {
      const unavailableReason = opt.requiresA3 && !scannerCaps.supportsA3
        ? 'A3 in Scanner-Settings deaktiviert'
        : null;
      return { ...opt, disabled: !!unavailableReason, unavailableReason };
    });
  }, [scannerCaps.supportsA3]);

  const [source, setSource] = useState('adf');
  const [size, setSize] = useState('a4');
  // Vorderseite/Beidseitig – nur relevant für ADF-Quellen und nur sichtbar,
  // wenn der Scanner laut Einstellungen duplexfähig ist. Default: beidseitig.
  const [duplex, setDuplex] = useState(true);

  const [dpi, setDpi] = useState(300);
  const [colorMode, setColorMode] = useState('gray');
  // Vorauswahl aus den Scanner-Einstellungen, sobald sie geladen sind. Nur
  // einmalig – eine spätere Auswahl des Nutzers darf das nicht zurücksetzen.
  const defaultsApplied = useRef(false);

  // Flachbett-Session-State
  const [session, setSession] = useState({ active: false, pages: 0 });
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState(null);
  const [lastSuccess, setLastSuccess] = useState(null);
  const [lastWarning, setLastWarning] = useState(null);
  const [waitingForReplace, setWaitingForReplace] = useState(false);
  const [hinweisDialog, setHinweisDialog] = useState(null); // null | 'simple' | 'batch' | 'finish'
  const [hinweisText, setHinweisText] = useState('');

  const sourceOpt = sourceOptions.find(o => o.id === source);
  // Der ADF-Seitenschalter ist nur sichtbar, wenn der Scanner laut
  // Einstellungen duplexfähig ist – sonst zählt immer Vorderseite.
  const duplexSchalterSichtbar = !!sourceOpt?.requiresAdf && scannerCaps.adfDuplex;
  const effectiveDuplex = duplexSchalterSichtbar && duplex;
  const endpoint = endpunktFuerQuelle(sourceOpt, effectiveDuplex);

  // Auflösung und Farbmodus hängen an der Quelle: der ADF eines Geräts kann
  // deutlich weniger als sein Flachbett (oft 300 statt 600 dpi). Ohne
  // ermittelte Fähigkeiten gilt der bisherige Stand.
  const quelleCaps = useMemo(() => {
    const ermittelt = settings?.scanner_capabilities?.value?.quellen;
    const fuerQuelle = ermittelt?.[quelleFuerEndpunkt(endpoint)];
    if (fuerQuelle?.aufloesungen?.length && fuerQuelle?.modi?.length) return fuerQuelle;
    return STANDARD_QUELLE;
  }, [settings, endpoint]);

  const dpiOptions = useMemo(
    () => quelleCaps.aufloesungen.map(d => ({ id: d, label: `${d} dpi` })),
    [quelleCaps],
  );
  const modeOptions = useMemo(
    () => quelleCaps.modi.map(m => ({ id: m, label: MODE_LABELS[m] || m })),
    [quelleCaps],
  );

  const hasDisabledSourceOptions = sourceOptions.some((opt) => opt.disabled);
  const hasDisabledSizeOptions = sourceOpt?.size ? sizeOptions.some((opt) => opt.disabled) : false;
  const hasCapabilityLimitations = hasDisabledSourceOptions || hasDisabledSizeOptions;

  useEffect(() => {
    const selected = sourceOptions.find((opt) => opt.id === source);
    if (!selected || selected.disabled) {
      const firstAvailable = sourceOptions.find((opt) => !opt.disabled);
      if (firstAvailable && firstAvailable.id !== source) {
        setSource(firstAvailable.id);
      }
    }
  }, [source, sourceOptions]);

  // Vorauswahl aus den Einstellungen übernehmen, sobald sie da ist.
  useEffect(() => {
    if (defaultsApplied.current || !settings) return;
    defaultsApplied.current = true;
    const vorgabeDpi = Number(settings.scanner_default_dpi?.value);
    if (Number.isFinite(vorgabeDpi) && vorgabeDpi > 0) setDpi(vorgabeDpi);
    const vorgabeModus = settings.scanner_default_mode?.value;
    if (vorgabeModus) setColorMode(vorgabeModus);
  }, [settings]);

  // Beim Quellenwechsel kann die bisherige Auswahl wegfallen (ADF kann kein
  // 600 dpi). Dann auf den höchsten noch möglichen Wert zurückfallen, statt
  // einen Wert stehen zu lassen, den das Backend ablehnt.
  useEffect(() => {
    if (!quelleCaps.aufloesungen.includes(dpi)) {
      setDpi(quelleCaps.aufloesungen[quelleCaps.aufloesungen.length - 1]);
    }
    if (!quelleCaps.modi.includes(colorMode)) {
      setColorMode(quelleCaps.modi[0]);
    }
  }, [quelleCaps, dpi, colorMode]);

  useEffect(() => {
    if (!sourceOpt?.size) return;
    const selected = sizeOptions.find((opt) => opt.id === size);
    if (!selected || selected.disabled) {
      const firstAvailable = sizeOptions.find((opt) => !opt.disabled);
      if (firstAvailable && firstAvailable.id !== size) {
        setSize(firstAvailable.id);
      }
    }
  }, [size, sizeOptions, sourceOpt?.size]);

  const reset = () => { setLastError(null); setLastSuccess(null); setLastWarning(null); };

  async function callScan(endpoint, payloadExtra = {}, hinweis = '') {
    setBusy(true);
    reset();
    try {
      const body = {
        endpoint,
        dpi: payloadExtra.dpi || String(dpi),
        mode: payloadExtra.mode || colorMode,
      };
      if (payloadExtra.size) body.size = payloadExtra.size;
      if (hinweis && !replaceForPostId) body.hinweis = hinweis;
      const res = replaceForPostId
        ? await api.import.scanReplace(replaceForPostId, body)
        : await api.import.scan(body);
      return res;
    } finally {
      setBusy(false);
    }
  }

  // Nach erfolgreich abgeschlossenem Scanner-Replace warten wir auf das Ergebnis
  // des doc-replace-Jobs (entsteht erst nach OCR + Webhook), um Undo zu registrieren.
  async function awaitReplaceResult() {
    if (!replaceForPostId) return;
    setWaitingForReplace(true);
    try {
      const payload = await pollScannerReplaceResult(replaceForPostId);
      onReplaceComplete?.(payload);
    } catch (err) {
      setLastError(`PDF-Austausch fehlgeschlagen: ${err.message}`);
    } finally {
      setWaitingForReplace(false);
    }
  }

  // Start-Button-Logik je nach Quelle
  async function startSimple(hinweis = '') {
    try {
      const extra = sourceOpt.size ? { size } : {};
      const r = await callScan(endpoint, extra, hinweis);
      const verb = replaceForPostId ? 'wird ausgetauscht' : 'wird verarbeitet';
      setLastSuccess(`Scan OK · ${r.file || ''} (${r.pages || 1} Seite${(r.pages || 1) !== 1 ? 'n' : ''}) · ${verb}`);
      if (replaceForPostId) awaitReplaceResult();
    } catch (err) {
      setLastError(err.message);
    }
  }

  // ADF-Stapel: eigener Handler statt startSimple(), da die Antwort ein
  // files-Array statt eines einzelnen Dateinamens liefert und ein Papierstau
  // mitten im Stapel einen dritten Zustand braucht (Teilerfolg, keine
  // reine Erfolgs- oder Fehlermeldung).
  async function startBatch(hinweis = '') {
    try {
      const r = await callScan(endpoint, {}, hinweis);
      const anzahl = r.files?.length ?? r.sheets ?? 0;
      if (r.status === 'partial') {
        setLastWarning(
          `${r.msg || 'Teilweise erfolgreich.'} ${anzahl} Dokument${anzahl !== 1 ? 'e' : ''} werden verarbeitet.`,
        );
      } else {
        setLastSuccess(`Scan OK · ${anzahl} Dokument${anzahl !== 1 ? 'e' : ''} aus ${r.pages || 0} Seite${(r.pages || 0) !== 1 ? 'n' : ''} · wird verarbeitet`);
      }
    } catch (err) {
      setLastError(err.message);
    }
  }

  async function sessionScan() {
    try {
      // size wird nur beim Session-Start berücksichtigt, ist ab der zweiten
      // Seite serverseitig fix – schadet aber nicht, ihn immer mitzuschicken.
      const extra = sourceOpt.size ? { size } : {};
      const r = await callScan('flatbed/session/scan', extra);
      setSession({ active: true, pages: r.pages });
    } catch (err) {
      setLastError(err.message);
    }
  }

  async function sessionFinish(hinweis = '') {
    try {
      const r = await callScan('flatbed/session/finish', {}, hinweis);
      setSession({ active: false, pages: 0 });
      const verb = replaceForPostId ? 'wird ausgetauscht' : 'wird verarbeitet';
      setLastSuccess(`Scan abgeschlossen · ${r.file || ''} (${r.pages || 0} Seiten) · ${verb}`);
      if (replaceForPostId) awaitReplaceResult();
    } catch (err) {
      setLastError(err.message);
    }
  }

  async function sessionAbort() {
    try {
      await callScan('flatbed/session/abort');
      setSession({ active: false, pages: 0 });
      setLastSuccess('Session abgebrochen · kein PDF gespeichert');
    } catch (err) {
      setLastError(err.message);
    }
  }

  // Ohne eingerichteten Scanner (`scanner_device_url` leer) gibt es nichts
  // aufzurufen – die Karte böte dann nur Optionen für ein Gerät, das es aus
  // Sicht der App nicht gibt. Während des ersten Ladens (importwege === undefined)
  // wird noch nichts entschieden, um kein Aufblitzen zu erzeugen.
  if (!importwegeLaedt && importwege && !importwege.scannerKonfiguriert) {
    return (
      <Card>
        <CardContent className="flex items-start gap-2.5 pt-6 text-sm text-muted-foreground">
          <Scan className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Auf dieser Instanz ist noch kein Scanner eingerichtet.
            {isAdmin ? (
              <>
                {' '}
                <Link to={SCANNER_SETTINGS_LINK} className="font-medium text-foreground underline underline-offset-2 hover:opacity-80">
                  Scanner einrichten
                </Link>
                {' '}oder Dokumente per Datei-Upload hereinbringen.
              </>
            ) : ' Dokumente lassen sich per Datei-Upload hereinbringen.'}
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Scan className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Scanner</CardTitle>
        </div>
        <CardDescription className="text-xs">
          {replaceForPostId
            ? `Der Scan ersetzt nach OCR die OneDrive-Datei von ${replaceForPostId}. Keine KI-Analyse, keine Metadaten-Änderung.`
            : 'Aufruf über vorkonfigurierte Webhooks. Nach Abschluss läuft der Scan automatisch durch die Pipeline.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Quelle */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quelle</label>
          <OptionGroup options={sourceOptions} value={source} onChange={setSource} disabled={session.active || busy} />
        </div>

        {/* Auflösung + Farbe – alle Kombinationen frei wählbar. Welche Werte
            zur Wahl stehen, hängt an der Quelle und an den ermittelten
            Gerätefähigkeiten. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Auflösung</label>
            <OptionGroup options={dpiOptions} value={dpi} onChange={setDpi} disabled={session.active || busy} />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Farbe</label>
            <OptionGroup options={modeOptions} value={colorMode} onChange={setColorMode} disabled={session.active || busy} />
          </div>
        </div>

        {/* Vorderseite/Beidseitig – nur bei ADF-Quellen und nur, wenn der
            Scanner laut Einstellungen duplexfähig ist. */}
        {duplexSchalterSichtbar && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Seiten</label>
            <OptionGroup
              options={DUPLEX_OPTIONS}
              value={duplex ? 'duplex' : 'simplex'}
              onChange={(id) => setDuplex(id === 'duplex')}
              disabled={session.active || busy}
            />
          </div>
        )}

        {/* Papierformat (Flachbett Einzelseite und Mehrseitig; bei ADF fix A4) */}
        {sourceOpt?.size && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Papierformat</label>
            <OptionGroup options={sizeOptions} value={size} onChange={setSize} disabled={busy || session.active} />
            {session.active && (
              <p className="text-xs text-muted-foreground">Gilt für die ganze Session – nach der ersten Seite nicht mehr änderbar.</p>
            )}
          </div>
        )}

        {hasCapabilityLimitations && (
          <div className="rounded-lg border border-amber-300/70 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-900/30 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            Nicht verfügbare Optionen sind ausgegraut. Diese Features können in den Scanner-Settings (sofern vom Gerät unterstützt) aktiviert werden:{' '}
            <Link to={SCANNER_SETTINGS_LINK} className="font-semibold underline underline-offset-2 hover:opacity-80">
              Scanner-Settings öffnen
            </Link>
            .
          </div>
        )}

        {/* Webhook-URL */}
        {!replaceForPostId && (
          <WebhookUrlField source={sourceOpt && { ...sourceOpt, endpoint }} dpi={dpi} mode={colorMode} size={size} />
        )}

        {/* Aktionsleiste */}
        <div className="pt-2 border-t border-border/40">
          {!sourceOpt?.session ? (
            // Einfacher Scan: ADF simplex/duplex oder Flachbett-Einzel
            <div className="flex items-center gap-3">
              <Button onClick={() => replaceForPostId ? startSimple() : setHinweisDialog(sourceOpt?.batch ? 'batch' : 'simple')} disabled={busy} size="sm">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {busy ? 'Scanne …' : 'Scan starten'}
              </Button>
              {busy && <span className="text-xs text-muted-foreground">Der Scan kann bis zu 5 Minuten dauern.</span>}
            </div>
          ) : (
            // Flachbett-Session: mehrseitig
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Button onClick={sessionScan} disabled={busy} size="sm">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scan className="h-4 w-4" />}
                  {session.active ? (busy ? 'Scanne Seite …' : 'Nächste Seite scannen') : (busy ? 'Starte Session …' : 'Session starten (erste Seite)')}
                </Button>
                {session.active && (
                  <>
                    <Button onClick={() => replaceForPostId ? sessionFinish() : setHinweisDialog('finish')} disabled={busy || session.pages === 0} variant="secondary" size="sm">
                      <CheckCircle2 className="h-4 w-4" />
                      Abschließen &amp; Verarbeiten
                    </Button>
                    <Button onClick={sessionAbort} disabled={busy} variant="outline" size="sm">
                      <StopCircle className="h-4 w-4" />
                      Abbrechen
                    </Button>
                  </>
                )}
              </div>
              {session.active && (
                <div className="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm">
                  Aktive Session: <span className="font-semibold text-primary">{session.pages}</span> Seite{session.pages !== 1 ? 'n' : ''} gescannt.
                  <div className="text-xs text-muted-foreground mt-0.5">Nach 60s Inaktivität wird die Session automatisch abgeschlossen.</div>
                </div>
              )}
            </div>
          )}

          {/* Feedback */}
          {lastError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
              <span className="text-destructive">{lastError}</span>
            </div>
          )}
          {lastSuccess && !lastError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
              <span className="text-emerald-700 dark:text-emerald-400">{lastSuccess}</span>
            </div>
          )}
          {lastWarning && !lastError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <span className="text-amber-700 dark:text-amber-400">{lastWarning}</span>
            </div>
          )}
          {waitingForReplace && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary flex-shrink-0 mt-0.5" />
              <span className="text-primary">
                Warte auf Abschluss von OCR und PDF-Austausch …
              </span>
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={!!hinweisDialog} onOpenChange={(open) => { if (!open && !busy) { setHinweisDialog(null); } }}>
        <DialogTitle>
          Hinweis für die KI{' '}
          <span className="text-muted-foreground font-normal text-sm">(optional)</span>
        </DialogTitle>
        <DialogDescription>
          Du kannst der KI eine Erläuterung oder einen Kontext mitgeben – das verbessert Klassifizierung und Extraktion. Das Feld kann auch leer bleiben.
          {hinweisDialog === 'batch' && ' Bei einem ADF-Stapel gilt der Hinweis für jedes der resultierenden Dokumente.'}
        </DialogDescription>
        <textarea
          className="mt-3 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
          rows={4}
          placeholder={'z. B. „Arztrechnung für Anna vom letzten Quartal" oder „Handwerkerrechnung Badezimmer-Renovierung"'}
          value={hinweisText}
          onChange={(e) => setHinweisText(e.target.value)}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setHinweisDialog(null)}>Abbrechen</Button>
          <Button onClick={() => {
            const h = hinweisText.trim();
            const action = hinweisDialog;
            setHinweisDialog(null);
            setHinweisText('');
            if (action === 'simple') startSimple(h);
            else if (action === 'batch') startBatch(h);
            else sessionFinish(h);
          }}>
            {hinweisDialog === 'finish' ? 'Abschließen & Verarbeiten' : 'Scan starten'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

// ── Drag-Drop-Liste (Sammlung) ──────────────────────────────────────────────

function CollectionItem({ item, index, count, onRemove, onMoveUp, onMoveDown, onDragStart, onDragOver, onDrop, isDragOver }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      className={[
        'flex items-center gap-2 rounded-lg border px-2 py-2 text-sm select-none',
        isDragOver ? 'border-primary bg-primary/10' : 'border-border/60 bg-background',
      ].join(' ')}
    >
      <div className="flex flex-col items-center text-muted-foreground cursor-grab active:cursor-grabbing">
        <GripVertical className="h-4 w-4" />
      </div>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <FileText className="h-4 w-4 text-primary flex-shrink-0" />
        <span className="truncate font-mono text-xs">{item.name}</span>
        <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{formatSize(item.size)}</span>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={index === 0}
          onClick={() => onMoveUp(index)}
          title="Nach oben"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={index === count - 1}
          onClick={() => onMoveDown(index)}
          title="Nach unten"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:bg-destructive/10"
          onClick={() => onRemove(index)}
          title="Entfernen"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Upload-Card ──────────────────────────────────────────────────────────────

function UploadCard({ replaceForPostId = null, onReplaceComplete }) {
  // Im Replace-Modus ist nur die Sammlung sinnvoll (eine neue PDF, ggf. aus
  // mehreren Quellen gemergt). Batch (jede PDF eigenständig in die Pipeline)
  // ergibt für einen bestehenden Eintrag keinen Sinn und wird ausgeblendet.
  const [mode, setMode] = useState('collection'); // 'collection' | 'batch'
  const [items, setItems] = useState([]);         // [{ id, file, name, size }]
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'error'|'success', msg }
  const [progress, setProgress] = useState(null); // { current, total }
  const [mergedFilename, setMergedFilename] = useState('');
  const [hinweisDialog, setHinweisDialog] = useState(false);
  const [hinweisText, setHinweisText] = useState('');
  const fileInputRef = useRef(null);

  // Drag-state
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const addFiles = useCallback((fileList) => {
    const pdfs = Array.from(fileList || []).filter(f =>
      f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    );
    if (pdfs.length === 0) return;
    setItems(prev => {
      const existing = new Set(prev.map(i => `${i.name}|${i.size}`));
      const fresh = pdfs
        .filter(f => !existing.has(`${f.name}|${f.size}`))
        .map(f => ({
          id: `${f.name}_${f.size}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          file: f,
          name: f.name,
          size: f.size,
        }));
      return [...prev, ...fresh];
    });
    setFeedback(null);
  }, []);

  const onFileInputChange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  const onDropZone = (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };

  const removeAt = (idx) => setItems(prev => prev.filter((_, i) => i !== idx));
  const clearAll = () => { setItems([]); setFeedback(null); setProgress(null); };

  const moveUp = (idx) => {
    if (idx === 0) return;
    setItems(prev => {
      const next = prev.slice();
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };
  const moveDown = (idx) => {
    setItems(prev => {
      if (idx >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      return next;
    });
  };

  // HTML5 Drag-Drop-Reorder
  const handleDragStart = (e, idx) => {
    setDragIndex(idx);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs dataTransfer data to initiate drag
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch {}
  };
  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== idx) setDragOverIndex(idx);
  };
  const handleDrop = (e, idx) => {
    e.preventDefault();
    const from = dragIndex;
    setDragIndex(null);
    setDragOverIndex(null);
    if (from == null || from === idx) return;
    setItems(prev => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(idx, 0, moved);
      return next;
    });
  };

  // ── Sammlung: mergen & Pipeline ───────────────────────────────────────────

  async function submitCollection(hinweis = '') {
    if (items.length === 0) return;
    setBusy(true);
    setFeedback(null);
    setProgress(null);
    try {
      const files = [];
      for (let i = 0; i < items.length; i++) {
        setProgress({ current: i, total: items.length, phase: 'Lese Dateien' });
        const dataB64 = await fileToBase64(items[i].file);
        files.push({ name: items[i].name, dataB64 });
      }
      setProgress({ current: items.length, total: items.length, phase: 'Sende an Server …' });

      if (replaceForPostId) {
        // Replace-Modus: eine oder mehrere PDFs werden serverseitig gemergt
        // und ersetzen die OneDrive-Datei des bestehenden Eintrags.
        const payload = files.length === 1 ? { dataB64: files[0].dataB64 } : { files };
        const res = await api.postbuch.replacePdf(replaceForPostId, payload);
        setFeedback({
          type: 'success',
          msg: `PDF ersetzt · ${files.length} Datei(en) für ${replaceForPostId}.`,
        });
        setItems([]);
        onReplaceComplete?.(res);
        return;
      }

      const payloadName = (mergedFilename || '').trim() ||
        (items.length === 1 ? items[0].name : `merged_${items.length}_docs.pdf`);
      const res = await api.import.uploadMerged(payloadName, files, hinweis);
      setFeedback({ type: 'success', msg: `Merge erfolgreich · ${res.mergedCount} Datei(en) → ${res.filename} · Job ${res.jobId.slice(0, 8)}…` });
      setItems([]);
      setMergedFilename('');
    } catch (err) {
      setFeedback({ type: 'error', msg: err.message });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ── Batch: jede Datei einzeln in die Pipeline ────────────────────────────

  async function submitBatch(hinweis = '') {
    if (items.length === 0) return;
    setBusy(true);
    setFeedback(null);
    setProgress(null);
    let ok = 0;
    let fail = 0;
    const failures = [];
    try {
      for (let i = 0; i < items.length; i++) {
        setProgress({ current: i, total: items.length, phase: `Lade ${items[i].name}` });
        try {
          const dataB64 = await fileToBase64(items[i].file);
          // Gesamtanzahl mitgeben → Auto-Cache springt schon bei der ersten Datei an.
          await api.import.upload(items[i].name, dataB64, hinweis, items.length);
          ok++;
        } catch (err) {
          fail++;
          failures.push(`${items[i].name}: ${err.message}`);
        }
      }
      if (fail === 0) {
        setFeedback({ type: 'success', msg: `${ok} Datei(en) in die Pipeline gegeben.` });
        setItems([]);
      } else {
        setFeedback({
          type: 'error',
          msg: `${ok} erfolgreich, ${fail} fehlgeschlagen:\n${failures.slice(0, 5).join('\n')}`,
        });
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const totalSize = items.reduce((sum, i) => sum + (i.size || 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">
            {replaceForPostId ? 'PDF-Upload (Ersatz)' : 'PDF-Upload'}
          </CardTitle>
        </div>
        <CardDescription className="text-xs">
          {replaceForPostId
            ? `Lade eine PDF – oder mehrere, die in der gewählten Reihenfolge zu einer Datei zusammengeführt werden – als Ersatz für ${replaceForPostId} hoch. Keine Pipeline, keine KI.`
            : 'Eine oder mehrere PDFs direkt in die Pipeline geben – entweder als Sammlung (in eine Datei gemergt) oder als Batch (jede einzeln).'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Modus-Toggle (im Replace-Modus deaktiviert: nur Sammlung sinnvoll) */}
        {!replaceForPostId && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('collection')}
              disabled={busy}
              className={[
                'flex-1 rounded-lg border px-3 py-2 text-left transition-all',
                mode === 'collection'
                  ? 'border-primary bg-primary/10 text-primary shadow-sm shadow-primary/10'
                  : 'border-border/60 bg-background hover:border-primary/40 hover:bg-primary/5',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 font-medium text-sm">
                <Layers className="h-4 w-4" />
                Sammlung
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Reihenfolge festlegen, zu einem PDF mergen und verarbeiten
              </div>
            </button>
            <button
              type="button"
              onClick={() => setMode('batch')}
              disabled={busy}
              className={[
                'flex-1 rounded-lg border px-3 py-2 text-left transition-all',
                mode === 'batch'
                  ? 'border-primary bg-primary/10 text-primary shadow-sm shadow-primary/10'
                  : 'border-border/60 bg-background hover:border-primary/40 hover:bg-primary/5',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 font-medium text-sm">
                <Inbox className="h-4 w-4" />
                Batch
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Jede PDF einzeln in die Pipeline geben (kein Merge)
              </div>
            </button>
          </div>
        )}

        {/* Drop-Zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={onDropZone}
          className="rounded-xl border-2 border-dashed border-border/60 p-6 text-center hover:border-primary/40 hover:bg-primary/[0.02] transition-colors"
        >
          <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium">PDFs hierher ziehen</p>
          <p className="text-xs text-muted-foreground mt-1">oder</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            Dateien auswählen
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={onFileInputChange}
          />
        </div>

        {/* Dateiliste */}
        {items.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{items.length} Datei{items.length !== 1 ? 'en' : ''} · {formatSize(totalSize)}</span>
              <button
                type="button"
                onClick={clearAll}
                disabled={busy}
                className="hover:text-destructive transition-colors"
              >
                Liste leeren
              </button>
            </div>
            <div
              className="space-y-1.5"
              onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setDragOverIndex(null);
              }}
            >
              {items.map((it, idx) => (
                <CollectionItem
                  key={it.id}
                  item={it}
                  index={idx}
                  count={items.length}
                  onRemove={removeAt}
                  onMoveUp={moveUp}
                  onMoveDown={moveDown}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  isDragOver={mode === 'collection' && dragOverIndex === idx && dragIndex !== idx}
                />
              ))}
            </div>
          </div>
        )}

        {/* Merge-Dateiname (nur normale Sammlung – im Replace-Modus wird der
            Original-OneDrive-Name beibehalten) */}
        {!replaceForPostId && mode === 'collection' && items.length > 1 && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Dateiname des Merge (optional)
            </label>
            <input
              type="text"
              value={mergedFilename}
              onChange={(e) => setMergedFilename(e.target.value)}
              placeholder={`merged_${items.length}_docs.pdf`}
              className="w-full h-9 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              disabled={busy}
            />
          </div>
        )}

        {/* Aktion */}
        {items.length > 0 && (
          <div className="pt-2 border-t border-border/40 flex items-center gap-3">
            {replaceForPostId ? (
              <Button onClick={submitCollection} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                {busy
                  ? 'Wird ersetzt …'
                  : (items.length === 1
                      ? `PDF von ${replaceForPostId} ersetzen`
                      : `${items.length} PDFs mergen & ${replaceForPostId} ersetzen`)}
              </Button>
            ) : mode === 'collection' ? (
              <Button onClick={() => setHinweisDialog(true)} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
                {busy ? 'Wird verarbeitet …' : (items.length === 1 ? 'In Pipeline geben' : `Zu einem PDF mergen & verarbeiten (${items.length})`)}
              </Button>
            ) : (
              <Button onClick={() => setHinweisDialog(true)} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />}
                {busy ? 'Wird verarbeitet …' : `Alle ${items.length} in Pipeline geben`}
              </Button>
            )}
            {progress && (
              <span className="text-xs text-muted-foreground">
                {progress.phase} · {progress.current}/{progress.total}
              </span>
            )}
          </div>
        )}

        {/* Feedback */}
        {feedback && (
          <div className={[
            'rounded-lg border px-3 py-2 text-sm flex items-start gap-2',
            feedback.type === 'error'
              ? 'bg-destructive/10 border-destructive/30 text-destructive'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400',
          ].join(' ')}>
            {feedback.type === 'error'
              ? <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              : <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />}
            <span className="whitespace-pre-line">{feedback.msg}</span>
          </div>
        )}
      </CardContent>

      <Dialog open={hinweisDialog} onOpenChange={(open) => { if (!busy) setHinweisDialog(open); }}>
        <DialogTitle>
          Hinweis für die KI{' '}
          <span className="text-muted-foreground font-normal text-sm">(optional)</span>
        </DialogTitle>
        <DialogDescription>
          Du kannst der KI eine Erläuterung oder einen Kontext mitgeben – das verbessert Klassifizierung und Extraktion. Das Feld kann auch leer bleiben.
        </DialogDescription>
        <textarea
          className="mt-3 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
          rows={4}
          placeholder={'z. B. „Arztrechnung für Anna vom letzten Quartal" oder „Handwerkerrechnung Badezimmer-Renovierung"'}
          value={hinweisText}
          onChange={(e) => setHinweisText(e.target.value)}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setHinweisDialog(false)}>Abbrechen</Button>
          <Button onClick={() => {
            const h = hinweisText.trim();
            setHinweisDialog(false);
            setHinweisText('');
            if (mode === 'collection') submitCollection(h);
            else submitBatch(h);
          }}>
            {mode === 'collection'
              ? (items.length === 1 ? 'In Pipeline geben' : `Mergen & verarbeiten (${items.length})`)
              : `Alle ${items.length} in Pipeline geben`}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

// ── Dokumentenübergabe-Import (ZIP ohne Instanzkontext) ──────────────────────

const CONFLICT_OPTIONS = [
  { id: 'skip',      label: 'Vorhandene überspringen', desc: 'Gleiche sha256 → überspringen (Standard)' },
  { id: 'createNew', label: 'Immer neu anlegen',       desc: 'Neue ID, kann Duplikate erzeugen' },
];

function ArchivImportCard() {
  const [collapsed, setCollapsed] = useState(true);
  const [file, setFile] = useState(null);
  const [conflictMode, setConflictMode] = useState('skip');
  const [busy, setBusy] = useState(false);
  // null | 'upload' | 'pruefung' | 'zuordnung' | 'verarbeitung'
  const [phase, setPhase] = useState(null);
  const [uploadAnteil, setUploadAnteil] = useState(0);
  const [step, setStep] = useState(null); // { fertig, gesamt }
  const [token, setToken] = useState(null);
  const [pruefung, setPruefung] = useState(null); // Payload der Vorprüfung
  const [zuordnung, setZuordnung] = useState({});
  const [neuFuer, setNeuFuer] = useState(null); // Person aus dem Paket, für die ein Mensch angelegt wird
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const { data: menschenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    enabled: phase === 'zuordnung',
  });
  const menschen = menschenData?.data || [];

  const waehleDatei = (f) => { setFile(f); setReport(null); setError(null); };
  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (f) waehleDatei(f);
    e.target.value = '';
  };

  function zuruecksetzen() {
    setPhase(null);
    setToken(null);
    setPruefung(null);
    setZuordnung({});
    setStep(null);
  }

  async function pruefen() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setReport(null);
    setUploadAnteil(0);
    setStep(null);
    setPhase('upload');
    try {
      const { jobId, token: neuesToken } = await api.import.archivVorpruefung(file, setUploadAnteil);
      setToken(neuesToken);
      setPhase('pruefung');
      const ergebnis = await pollJobResult(jobId, {
        onStep: (fertig, gesamt) => setStep({ fertig: fertig ?? 0, gesamt: gesamt || 1 }),
      });
      setPruefung(ergebnis);
      setZuordnung(Object.fromEntries(
        (ergebnis.personen || [])
          .filter((p) => p.vorschlag?.kurzname)
          .map((p) => [p.name, p.vorschlag.kurzname]),
      ));
      setPhase('zuordnung');
    } catch (err) {
      setError(err.message);
      zuruecksetzen();
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  async function verwerfen() {
    const alt = token;
    zuruecksetzen();
    if (alt) await api.import.archivVerwerfen(alt).catch(() => {});
  }

  const personen = pruefung?.personen || [];
  const offen = personen.filter((p) => !zuordnung[p.name]).length;

  async function importieren() {
    setBusy(true);
    setError(null);
    try {
      const personenZuordnung = Object.fromEntries(
        personen.map((p) => [p.name, zuordnung[p.name] === KEINE ? null : zuordnung[p.name]]),
      );
      const { jobId } = await api.import.archivStart(token, { conflictMode, personenZuordnung });
      setPhase('verarbeitung');
      const rep = await pollJobResult(jobId, {
        onStep: (fertig, gesamt) => setStep({ fertig: fertig ?? 0, gesamt: gesamt || 1 }),
      });
      setReport(rep);
      setFile(null);
      zuruecksetzen();
    } catch (err) {
      setError(err.message);
      // 400 (z. B. Zielperson inzwischen gelöscht): Zuordnung bleibt offen und
      // lässt sich korrigieren. Sonst ist die vorbereitete Übergabe verbraucht.
      if (err.status === 400) setPhase('zuordnung');
      else zuruecksetzen();
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const imZuordnungsschritt = phase === 'zuordnung';
  const dateiGesperrt = busy || imZuordnungsschritt;

  return (
    <Card>
      <CardHeader className="pb-3 cursor-pointer select-none" onClick={() => setCollapsed(c => !c)}>
        <div className="flex items-center gap-2">
          <PackageOpen className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Dokumentenübergabe importieren</CardTitle>
          <span className="ml-auto text-muted-foreground text-xs">{collapsed ? '▸ Aufklappen' : '▾ Einklappen'}</span>
        </div>
        {!collapsed && (
          <CardDescription className="text-xs">
            Übernimmt ein ZIP mit PDF und Fachdaten ohne neue KI-Verarbeitung. Vor dem Import ordnest du
            die Personen aus dem Paket den Menschen dieser Instanz zu. Abrechnungsperioden, Akten,
            Wiedervorlagen, Salden und PKV-Prüfungen werden bewusst nicht übertragen. Beziehungen zu nicht
            enthaltenen Dokumenten werden gelöst und im Ergebnis ausgewiesen.
          </CardDescription>
        )}
      </CardHeader>
      {!collapsed && <CardContent className="space-y-4">
        {/* Datei-Auswahl */}
        <div
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !dateiGesperrt) waehleDatei(f); }}
          className="rounded-xl border-2 border-dashed border-border/60 p-6 text-center hover:border-primary/40 hover:bg-primary/[0.02] transition-colors"
        >
          <PackageOpen className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          {file ? (
            <p className="text-sm font-medium font-mono break-all">{file.name} <span className="text-muted-foreground">({formatSize(file.size)})</span></p>
          ) : (
            <p className="text-sm font-medium">Archiv-ZIP hierher ziehen</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">oder</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => fileInputRef.current?.click()} disabled={dateiGesperrt}>
            ZIP auswählen
          </Button>
          <input ref={fileInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={onPick} />
        </div>

        {/* Konflikt-Modus */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Bei bereits vorhandenen Dokumenten</label>
          <OptionGroup options={CONFLICT_OPTIONS} value={conflictMode} onChange={setConflictMode} disabled={busy} />
        </div>

        {/* Schritt 2: Personenzuordnung */}
        {imZuordnungsschritt && (
          <div className="space-y-3 pt-2 border-t border-border/40">
            <div>
              <p className="text-sm font-medium">Personen zuordnen</p>
              <p className="text-xs text-muted-foreground">
                {pruefung.total} Dokument{pruefung.total !== 1 ? 'e' : ''} geprüft. Exakte Treffer und eindeutige
                Vorschläge sind vorausgewählt – prüfe sie und entscheide die offenen Namen.
              </p>
            </div>
            <PersonenZuordnung
              personen={personen}
              zuordnung={zuordnung}
              onChange={(name, wert) => setZuordnung((alt) => ({ ...alt, [name]: wert }))}
              menschen={menschen}
              onNeuAnlegen={setNeuFuer}
              disabled={busy}
            />
          </div>
        )}

        {/* Aktion */}
        <div className="pt-2 border-t border-border/40 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {imZuordnungsschritt ? (
              <>
                <Button onClick={importieren} disabled={busy || offen > 0}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                  Import starten
                </Button>
                <Button variant="outline" onClick={verwerfen} disabled={busy}>Abbrechen</Button>
                {offen > 0 && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    Noch {offen} Person{offen !== 1 ? 'en' : ''} ohne Entscheidung
                  </span>
                )}
              </>
            ) : (
              <Button onClick={pruefen} disabled={busy || !file}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                {busy ? (phase === 'verarbeitung' ? 'Importiere …' : 'Prüfe …') : 'Übergabe prüfen'}
              </Button>
            )}
            {phase === 'upload' && (
              <span className="text-xs text-muted-foreground">Lädt hoch … {Math.round(uploadAnteil * 100)}%</span>
            )}
            {phase === 'pruefung' && (
              <span className="text-xs text-muted-foreground">
                Prüft das Paket{step ? ` ${step.fertig}/${step.gesamt}` : ' …'}
              </span>
            )}
            {phase === 'verarbeitung' && (
              <span className="text-xs text-muted-foreground">
                Verarbeitet{step ? ` ${step.fertig}/${step.gesamt}` : ' …'} – lädt PDFs in die Dateiablage, das kann dauern.
              </span>
            )}
          </div>
          {phase === 'upload' && <Progress value={uploadAnteil * 100} />}
          {(phase === 'pruefung' || phase === 'verarbeitung') && (
            <Progress value={step ? (step.fertig / step.gesamt) * 100 : 0} indeterminate={!step} />
          )}
        </div>

        {/* Fehler */}
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm flex items-start gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span className="whitespace-pre-line">{error}</span>
          </div>
        )}

        {/* Report */}
        {report && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm space-y-1">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Import abgeschlossen
            </div>
            <p className="text-xs text-muted-foreground">
              {report.imported} importiert · {report.skipped} übersprungen · {report.failed} Fehler (von {report.total})
            </p>
            {report.personenZuordnung?.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Personen: {report.personenZuordnung.map(({ quelle, ziel }) => `${quelle} → ${ziel ?? 'keine'}`).join(', ')}
              </p>
            )}
            {report.omittedRelations?.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {report.omittedRelations.length} externe Dokumentverknüpfung{report.omittedRelations.length !== 1 ? 'en' : ''} bewusst gelöst
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Abrechnungskontext, Akten, Wiedervorlagen, Salden und PKV-Prüfungen werden nicht importiert.
            </p>
            {report.failed > 0 && (
              <ul className="text-xs text-destructive list-disc list-inside max-h-32 overflow-auto">
                {(report.failedItems || []).slice(0, 10).map((i, idx) => (
                  <li key={idx}><span className="font-mono">{i.file}</span>: {i.error}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>}

      {neuFuer && (
        <MenschDialog
          open
          onOpenChange={(offenDialog) => { if (!offenDialog) setNeuFuer(null); }}
          vorlage={{
            kurzname: neuFuer.name,
            anmeldename: neuFuer.name,
            anzeigename: neuFuer.legende?.anzeigename || '',
            ist_tier: !!neuFuer.legende?.istTier,
          }}
          onGespeichert={(kurzname) => setZuordnung((alt) => ({ ...alt, [neuFuer.name]: kurzname }))}
        />
      )}
    </Card>
  );
}

// ── Seite ────────────────────────────────────────────────────────────────────

const POSTID_RE = /^P\d{6}$/;

// ── Cache-Mode-Panel ─────────────────────────────────────────────────────────
// Globaler Batch-Modus mit providerabhängigem Prompt-Caching und fixem
// Klassifikationsmodell. Wirkt auf ALLE Eingänge (Scanner, OneDrive, extern),
// nicht nur auf diese Seite. Reset nach 15 Min Inaktivität.

const TIER_LABEL = { leicht: 'Leicht', mittel: 'Mittel', schwierig: 'Schwer' };
const TIER_HEALTH_KEY = { leicht: 'leicht', mittel: 'mittel', schwierig: 'schwierig' };

function CacheModePanel() {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ['cache-mode'],
    queryFn: () => api.settingsPublic.ai.cacheMode.get(),
    refetchInterval: 20_000,
    retry: false,
  });
  const { data: health } = useQuery({
    queryKey: ['ai-health-public'],
    queryFn: () => api.settingsPublic.ai.health(),
    staleTime: 2 * 60 * 1000,
    retry: false,
  });

  const [tier, setTier] = useState('mittel');
  useEffect(() => { if (status?.tier) setTier(status.tier); }, [status?.tier]);

  const mutation = useMutation({
    mutationFn: ({ active, tier }) => api.settingsPublic.ai.cacheMode.set({ active, tier }),
    onSuccess: (data) => qc.setQueryData(['cache-mode'], data),
  });

  if (!status?.enabled) return null; // In KI-Optionen nicht freigeschaltet → Panel ausblenden

  const active = status.active === true;
  const tierModelName = (t) => health?.models?.[TIER_HEALTH_KEY[t]]?.model || '–';
  const expiresLabel = (() => {
    if (!active || !status.expiresAt) return null;
    const mins = Math.max(0, Math.round((new Date(status.expiresAt).getTime() - Date.now()) / 60000));
    return `Auto-Reset in ~${mins} Min ohne neue Verarbeitung`;
  })();

  return (
    <Card className={active ? 'border-primary/50 bg-primary/5' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Cache-Mode (Batch-Verarbeitung)</CardTitle>
          {active && <span className="ml-auto text-[11px] font-medium text-primary bg-primary/10 rounded px-2 py-0.5">{status.source === 'auto' ? 'Aktiv (automatisch)' : 'Aktiv'}</span>}
        </div>
        <CardDescription className="text-xs">
          Bündelt mehrere Dokumente auf ein fixes Modell mit Prompt-Caching. Gilt global
          für alle Eingänge (auch Scanner, OneDrive, externe Verarbeitung). Lange Dokumente (&gt;10 Seiten)
          laufen weiterhin über die normale Kette.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Fixes Klassifikationsmodell</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              disabled={active || mutation.isPending}
              className="h-9 text-sm rounded-md border border-input bg-background px-2 cursor-pointer disabled:opacity-60 block"
            >
              {['leicht', 'mittel', 'schwierig'].map((t) => (
                <option key={t} value={t}>{TIER_LABEL[t]} ({tierModelName(t)})</option>
              ))}
            </select>
          </div>
          {!active ? (
            <Button size="sm" className="h-9" disabled={mutation.isPending} onClick={() => mutation.mutate({ active: true, tier })}>
              {mutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
              Cache-Mode starten
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-9" disabled={mutation.isPending} onClick={() => mutation.mutate({ active: false })}>
              {mutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <StopCircle className="h-3.5 w-3.5 mr-1.5" />}
              Beenden
            </Button>
          )}
        </div>
        {active && (
          <div className="flex items-start gap-2 rounded-lg bg-primary/10 border border-primary/20 px-3 py-2">
            <Info className="h-3.5 w-3.5 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-xs text-primary/90">
              Aktiv mit <strong>{TIER_LABEL[status.tier]} ({status.tierModel || tierModelName(status.tier)})</strong>.
              {expiresLabel ? ` ${expiresLabel}.` : ''}
            </p>
          </div>
        )}
        {mutation.isError && <p className="text-xs text-destructive">{mutation.error?.message}</p>}
      </CardContent>
    </Card>
  );
}

export default function ImportPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { pushAction } = useUndoHistory();
  const { isAdmin } = useAuth();

  const replaceParam = searchParams.get('replace') || '';
  const replaceForPostId = POSTID_RE.test(replaceParam) ? replaceParam : null;

  // Nur für die Banner-Formulierung: ist die bisherige Datei bereits als
  // fehlend bekannt (storage_id genullt)? Dann gibt es beim Ersetzen weder
  // eine "alte Version" zu verschieben noch etwas zum Rückgängigmachen.
  const bestehendesDokument = useQuery({
    queryKey: ['postbuch', 'detail', replaceForPostId],
    queryFn: () => api.postbuch.get(replaceForPostId),
    enabled: !!replaceForPostId,
  });
  const hatPdf = bestehendesDokument.data?.postbuch?.hatPdf ?? true;

  const handleReplaceComplete = useCallback((result) => {
    if (!result || !result.postid) return;
    // Fehlte die alte Datei bereits (Reimport), gibt es nichts zum
    // Rückgängigmachen — old.onedriveId ist dann null und restorePdf() würde
    // mit "Restore-Parameter unvollständig" scheitern.
    if (result.old?.onedriveId) {
      const { description, undo, redo } = buildReplaceUndoRedo(result.postid, result);
      pushAction(description, undo, redo);
    }
    // Direkt zurück zum Dokument – der Erfolgsbanner würde sonst nur kurz auftauchen
    navigate(`/postbuch/${result.postid}`);
  }, [navigate, pushAction]);

  if (replaceForPostId) {
    return (
      <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
        <div className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-900/40 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <FileUp className="h-5 w-5 text-amber-700 dark:text-amber-300" />
            <h1 className="text-xl font-semibold text-amber-900 dark:text-amber-50">
              {hatPdf ? `PDF ersetzen für ${replaceForPostId}` : `Fehlende PDF reimportieren für ${replaceForPostId}`}
            </h1>
          </div>
          <p className="text-sm text-amber-900 dark:text-amber-50/95">
            {hatPdf
              ? 'Der nächste Scan oder Upload ersetzt nur die OneDrive-Datei dieses Eintrags – die alte Version wandert in den Papierkorb.'
              : 'Die bisherige Datei ist in der Dateiablage nicht mehr vorhanden. Der nächste Scan oder Upload legt eine neue Datei für diesen Eintrag an.'}
            {' '}Es findet weder eine KI-Analyse
            noch eine Pipeline-Verarbeitung statt; alle Detail-Tabellen, Notizen und
            Aktenzuordnungen bleiben unverändert.
          </p>
          <div>
            <Link
              to={`/postbuch/${replaceForPostId}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-amber-800 hover:text-amber-900 underline-offset-2 hover:underline dark:text-amber-100 dark:hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Zurück zum Dokument (Replace abbrechen)
            </Link>
          </div>
        </div>

        <ScannerCard
          replaceForPostId={replaceForPostId}
          onReplaceComplete={handleReplaceComplete}
        />
        <UploadCard
          replaceForPostId={replaceForPostId}
          onReplaceComplete={handleReplaceComplete}
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Upload className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Dokumentenimport</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Neue Dokumente per Scanner oder Datei-Upload in die Verarbeitungs-Pipeline geben. Laufende Jobs sind im Task-Monitor in der Seitenleiste sichtbar.
      </p>

      {/* Diese Seite ist nur einer von sechs Eingangswegen – der überwachte
          Cloud-Ordner und der Handy-Scan kommen ohne sie aus. */}
      <Link
        to="/importwege"
        className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/[0.06] px-3.5 py-2.5 text-sm transition-colors hover:bg-primary/10"
      >
        <Lightbulb className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0">
          <span className="font-medium text-foreground">Es gibt sechs Wege, ein Dokument hereinzubekommen</span>
          <span className="text-muted-foreground"> – nicht jeder führt über diese Seite.</span>
        </span>
        <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-primary" />
      </Link>

      <CacheModePanel />
      <ScannerCard />
      <UploadCard />
      {isAdmin && <ArchivImportCard />}
    </div>
  );
}

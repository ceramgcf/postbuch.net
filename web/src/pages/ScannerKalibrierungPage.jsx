import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, Crop, FileScan, RotateCcw,
  AlertTriangle, RefreshCw, ScanLine, SlidersHorizontal, Trash2, Undo2, X,
} from 'lucide-react';
import { api } from '@/api/client';
import { Logo } from '@/components/ui/Logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner, EmptyState } from '@/components/ui/spinner';
import { Testergebnis } from '@/components/ui/testergebnis';

const SCHRITTE = [
  { id: 'testscans', label: 'Test-Scans', icon: ScanLine, title: 'Grenzfälle einscannen', subtitle: 'Bis zu drei einseitige Testseiten – ohne PostID und ohne Dokumentpipeline.' },
  { id: 'tuning', label: 'Parametertuning', icon: SlidersHorizontal, title: 'Erkennung live abstimmen', subtitle: 'Leerseitenentscheidung und Cropbox werden für alle Testseiten neu berechnet.' },
  { id: 'abschluss', label: 'Übernehmen', icon: CheckCircle2, title: 'Kalibrierung prüfen und übernehmen', subtitle: 'Statische Kontrolle der Werte und Ergebnisse.' },
];

const PARAMETER = [
  { key: 'blankMeanMin', label: 'ADF-Helligkeit min.', min: 200, max: 255, step: 1, standard: 240, bereich: 'Leerseite', up: 'strengere Hürde – weniger Seiten gelten als leer', down: 'lockerere Hürde – mehr Seiten gelten als leer' },
  { key: 'blankStddevMax', label: 'ADF-Varianz max.', min: 0, max: 30, step: 0.5, standard: 12, bereich: 'Leerseite', up: 'erlaubt mehr Bildrauschen – auch unruhigere Seiten gelten als leer', down: 'verlangt ruhigeres Bild – weniger Seiten gelten als leer' },
  { key: 'blankContentThreshold', label: 'Nutzinhaltsschwelle', min: 100, max: 255, step: 1, standard: 200, bereich: 'Leerseite', up: 'erkennt auch blasseren Druck als Inhalt', down: 'ignoriert schwaches Durchscheinen der Vorderseite' },
  { key: 'blankMaskMaxContentPx', label: 'Nutzpixel max.', min: 0, max: 5000, step: 10, standard: 200, bereich: 'Leerseite', hinweis: 'Bezugsgröße bei 100 DPI – wird automatisch mit der Erkennungs-DPI skaliert.', up: 'toleriert mehr Druckspuren – Seite wird trotzdem entfernt', down: 'toleriert weniger Druckspuren – Seite bleibt eher erhalten' },
  { key: 'contentThreshold', label: 'Crop-Inhaltsschwelle', min: 100, max: 255, step: 1, standard: 200, bereich: 'Crop', up: 'größere, sicherere Zuschnittbox', down: 'engere Zuschnittbox – Risiko, blassen Text abzuschneiden' },
  { key: 'contentDenoiseMinPx', label: 'Störpunkte-Höchstgröße', min: 0, max: 20, step: 1, standard: 10, bereich: 'Beides', hinweis: 'Bezugsgröße bei 100 DPI – wird automatisch mit der Erkennungs-DPI skaliert.', up: 'filtert auch größere Flecken – Risiko, echten Inhalt mitzuverlieren', down: 'nur winzige Flecken gelten als Störung – Schmutz bleibt eher stehen' },
  { key: 'detectDpi', label: 'Erkennungs-DPI', min: 50, max: 300, step: 5, standard: 75, bereich: 'Beides', hinweis: 'Skaliert automatisch die Störpunkte-Höchstgröße und die Nutzpixel-Grenze mit.', up: 'präziser, aber langsamer', down: 'schneller, aber ungenauer' },
];

const BEREICH_STIL = {
  Leerseite: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
  Crop: 'bg-sky-500/12 text-sky-700 dark:text-sky-400',
  Beides: 'bg-violet-500/12 text-violet-700 dark:text-violet-400',
};

// Fixe Thumb-Breite (1rem), damit die Standard-Marke exakt mit der Reglerposition
// übereinstimmt: native Slider laufen inset um den halben Thumb, eine reine
// Prozent-Position ohne diese Korrektur landet an den Rändern sichtbar daneben.
const THUMB_KLASSEN = '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4';

function ParameterKarte({ label, bereich, hinweis, children }) {
  return (
    <div className="rounded-xl border bg-card px-3.5 py-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BEREICH_STIL[bereich]}`}>{bereich}</span>
      </div>
      {hinweis && <p className="mt-0.5 text-[11px] italic text-muted-foreground/80">{hinweis}</p>}
      {children}
    </div>
  );
}

function ParameterRegler({ definition, value, onChange }) {
  const { key, label, bereich, hinweis, min, max, step, standard, up, down } = definition;
  const fraction = (standard - min) / (max - min);
  const atStandard = value === standard;
  return (
    <ParameterKarte label={label} bereich={bereich} hinweis={hinweis}>
      <div className="mt-2.5 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span
            className="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground/30"
            style={{ left: `calc(0.5rem + (100% - 1rem) * ${fraction})` }}
            title={`Standard: ${standard}`}
          />
          <input
            type="range" min={min} max={max} step={step} value={value}
            onChange={(event) => onChange(key, Number(event.target.value))}
            className={`relative z-10 h-4 w-full cursor-pointer accent-primary ${THUMB_KLASSEN}`}
            aria-label={`${label}, Standard ${standard}`}
          />
        </div>
        <Input
          type="number" min={min} max={max} step={step} value={value}
          onChange={(event) => onChange(key, Number(event.target.value))}
          className="h-8 w-[4.5rem] shrink-0 px-2 text-right font-mono text-xs"
        />
        <Button
          type="button" size="icon" variant="ghost"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          onClick={() => onChange(key, standard)}
          disabled={atStandard}
          title={`Auf Standard zurücksetzen (${standard})`}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        <p className="flex items-start gap-1.5"><ArrowUp className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />{up}</p>
        <p className="flex items-start gap-1.5"><ArrowDown className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />{down}</p>
      </div>
    </ParameterKarte>
  );
}

function ErgebnisKarte({ page, result, rawPreview, loading, onScan, onDelete, scanPending, deletePending }) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden min-w-0">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <p className="text-sm font-semibold">Testseite {page.slot}</p>
          <p className="text-[11px] text-muted-foreground">{page.exists ? new Date(page.updatedAt).toLocaleString('de-DE') : 'noch nicht belegt'}</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onScan(page.slot)} disabled={scanPending}>
            {scanPending ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
            <span className="hidden xl:inline ml-1">{page.exists ? 'Austauschen' : 'Scannen'}</span>
          </Button>
          {page.exists && <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => onDelete(page.slot)} disabled={deletePending}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
      <div className="relative aspect-[210/297] bg-muted/40 grid place-items-center">
        {result?.previewVersion ? (
          <img src={api.scannerTuning.previewUrl(page.slot, result.previewVersion)} alt={`Analyse Testseite ${page.slot}`} className="h-full w-full object-contain" />
        ) : rawPreview?.previewVersion ? (
          <img src={api.scannerTuning.rawPreviewUrl(page.slot, rawPreview.previewVersion)} alt={`Rohscan Testseite ${page.slot}`} className="h-full w-full object-contain" />
        ) : (
          <div className="text-center text-muted-foreground"><FileScan className="mx-auto h-10 w-10 opacity-40" /><p className="mt-2 text-xs">{page.exists ? 'Rohvorschau wird erstellt' : 'Kein Test-Scan'}</p></div>
        )}
        {loading && <div className="absolute inset-0 grid place-items-center bg-background/70 backdrop-blur-[1px]"><Spinner className="h-7 w-7" /></div>}
      </div>
      {result && (
        <div className="space-y-2 border-t p-3 text-xs">
          <div className={`rounded-md px-2 py-1.5 font-semibold ${result.blank ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'}`}>
            {result.blank ? 'Würde als Leerseite entfernt' : 'Würde als Inhaltsseite behalten'}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
            <span>Helligkeit</span><span className="text-right font-mono text-foreground">{result.mean}</span>
            <span>Varianz</span><span className="text-right font-mono text-foreground">{result.stddev}</span>
            <span>Nutzpixel</span><span className="text-right font-mono text-foreground">{result.contentPixels}</span>
            <span>Cropbox</span><span className="text-right text-foreground">{result.cropBox ? 'rote Umrandung' : 'kein Zuschnitt'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ScannerKalibrierungPage() {
  const { schritt } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const index = SCHRITTE.findIndex((item) => item.id === schritt);
  const aktuell = index < 0 ? 0 : index;
  const definition = SCHRITTE[aktuell];
  const status = useQuery({ queryKey: ['scanner-tuning'], queryFn: api.scannerTuning.status, retry: false });
  const [parameters, setParameters] = useState(null);
  const [results, setResults] = useState([]);
  const [rawPreviews, setRawPreviews] = useState([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [finished, setFinished] = useState(false);
  const analysisGeneration = useRef(0);
  const [scanOptions, setScanOptions] = useState({ dpi: 300, mode: 'gray', size: 'a4' });

  useEffect(() => {
    if (!status.data || parameters) return;
    setParameters(status.data.parameters);
    setScanOptions({
      dpi: status.data.scanner.resolutions.includes(Number(status.data.scanner.defaultDpi)) ? Number(status.data.scanner.defaultDpi) : status.data.scanner.resolutions[0],
      mode: status.data.scanner.modes.includes(status.data.scanner.defaultMode) ? status.data.scanner.defaultMode : status.data.scanner.modes[0],
      size: 'a4',
    });
  }, [status.data, parameters]);

  const pages = status.data?.pages || [1, 2, 3].map((slot) => ({ slot, exists: false }));
  const existingCount = pages.filter((page) => page.exists).length;
  const resultBySlot = useMemo(() => Object.fromEntries(results.map((result) => [result.slot, result])), [results]);
  const rawBySlot = useMemo(() => Object.fromEntries(rawPreviews.map((result) => [result.slot, result])), [rawPreviews]);

  async function analyze(values = parameters) {
    if (!values || existingCount === 0) { setResults([]); return; }
    const generation = ++analysisGeneration.current;
    setAnalysisLoading(true);
    setAnalysisError('');
    try {
      const data = await api.scannerTuning.analyze(values);
      if (generation === analysisGeneration.current) setResults(data.results || []);
    } catch (err) {
      if (generation === analysisGeneration.current) setAnalysisError(err.message);
    } finally {
      if (generation === analysisGeneration.current) setAnalysisLoading(false);
    }
  }

  useEffect(() => {
    if (schritt !== 'tuning' || !parameters || existingCount === 0) return undefined;
    const timer = setTimeout(() => analyze(parameters), 450);
    return () => clearTimeout(timer);
    // Der serialisierte Wert macht jede Feldänderung debounce-fähig.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt, existingCount, JSON.stringify(parameters)]);

  useEffect(() => {
    if (schritt === 'abschluss' && parameters && existingCount > 0 && results.length === 0) analyze(parameters);
    // Nur beim Eintritt bzw. Reload einmal rechnen – Schritt 3 bleibt danach statisch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt, !!parameters, existingCount]);

  const renderRaw = useMutation({
    mutationFn: api.scannerTuning.render,
    onSuccess: (data) => setRawPreviews(data.results || []),
  });

  useEffect(() => {
    if (schritt === 'testscans' && existingCount > 0 && rawPreviews.length !== existingCount && !renderRaw.isPending) {
      renderRaw.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schritt, existingCount, rawPreviews.length]);

  const scan = useMutation({
    mutationFn: (slot) => api.scannerTuning.scan(slot, scanOptions),
    onSuccess: async () => {
      setResults([]);
      setRawPreviews([]);
      await qc.invalidateQueries({ queryKey: ['scanner-tuning'] });
      await status.refetch();
      if (schritt !== 'testscans') navigate('/scanner-kalibrierung/tuning');
    },
  });
  const remove = useMutation({
    mutationFn: (slot) => api.scannerTuning.remove(slot),
    onSuccess: async () => {
      setResults([]);
      setRawPreviews([]);
      await qc.invalidateQueries({ queryKey: ['scanner-tuning'] });
      await status.refetch();
      if (schritt === 'abschluss') navigate('/scanner-kalibrierung/tuning');
    },
  });
  const apply = useMutation({
    mutationFn: () => api.scannerTuning.apply(parameters),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); setFinished(true); },
  });
  const removeAll = useMutation({
    mutationFn: api.scannerTuning.removeAll,
    onSuccess: () => navigate('/einstellungen?tab=scanner'),
  });

  if (index < 0) return <Navigate to="/scanner-kalibrierung/testscans" replace />;
  if (status.isError && !parameters) return (
    <div className="min-h-screen grid place-items-center px-4">
      <EmptyState icon={AlertTriangle} title="Kalibrierung konnte nicht geladen werden" description={status.error?.message || 'Der Scanner-Status ist gerade nicht abrufbar.'}>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => status.refetch()} disabled={status.isFetching}>{status.isFetching ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}Erneut laden</Button>
          <Button variant="outline" onClick={() => navigate('/einstellungen?tab=scanner')}><X className="h-4 w-4" />Schließen</Button>
        </div>
      </EmptyState>
    </div>
  );
  if (status.isLoading || !parameters) return <div className="min-h-screen grid place-items-center"><Spinner className="h-8 w-8" /></div>;

  const cards = (showResults) => (
    <div className="grid gap-4 md:grid-cols-3">
      {pages.map((page) => <ErgebnisKarte key={page.slot} page={page} result={showResults ? resultBySlot[page.slot] : null} rawPreview={!showResults ? rawBySlot[page.slot] : null} loading={page.exists && (showResults ? analysisLoading : renderRaw.isPending)} onScan={(slot) => scan.mutate(slot)} onDelete={(slot) => remove.mutate(slot)} scanPending={scan.isPending && scan.variables === page.slot} deletePending={remove.isPending && remove.variables === page.slot} />)}
    </div>
  );

  function content() {
    if (schritt === 'testscans') return (
      <div className="space-y-5">
        <div className="rounded-lg border border-primary/20 bg-primary/[0.04] p-4 text-sm leading-relaxed">
          Scanne möglichst unterschiedliche Grenzfälle: eine wirklich leere Seite, eine Seite mit hellem Durchscheinen und einen blassen Thermobeleg oder eine sparsam bedruckte Rückseite. Die Testseiten werden dauerhaft lokal gespeichert, aber nie als Dokument importiert und erhalten keine PostID.
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium">Auflösung<select className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={scanOptions.dpi} onChange={(e) => setScanOptions({ ...scanOptions, dpi: Number(e.target.value) })}>{status.data.scanner.resolutions.map((v) => <option key={v} value={v}>{v} DPI</option>)}</select></label>
          <label className="text-xs font-medium">Modus<select className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={scanOptions.mode} onChange={(e) => setScanOptions({ ...scanOptions, mode: e.target.value })}>{status.data.scanner.modes.map((v) => <option key={v} value={v}>{v === 'gray' ? 'Graustufen' : v === 'color' ? 'Farbe' : 'Schwarzweiß'}</option>)}</select></label>
          <label className="text-xs font-medium">Format<select className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={scanOptions.size} onChange={(e) => setScanOptions({ ...scanOptions, size: e.target.value })}>{status.data.scanner.sizes.map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}</select></label>
        </div>
        {cards(false)}
        {renderRaw.isError && <Testergebnis status="fehler">{renderRaw.error.message}</Testergebnis>}
        {scan.isError && <Testergebnis status="fehler">{scan.error.message}</Testergebnis>}
        {remove.isError && <Testergebnis status="fehler">{remove.error.message}</Testergebnis>}
      </div>
    );
    if (schritt === 'tuning') return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {PARAMETER.map((definition) => <ParameterRegler key={definition.key} definition={definition} value={parameters[definition.key]} onChange={(key, value) => setParameters({ ...parameters, [key]: value })} />)}
        </div>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5"><Crop className="h-3.5 w-3.5" /><strong className="text-foreground">Wirkung:</strong> Leerseite entscheidet über Behalten/Entfernen, Crop nur über die rote Box, Beides wirkt auf beide Auswertungen.</p>
        {cards(true)}
        {analysisError && <Testergebnis status="fehler">{analysisError}</Testergebnis>}
      </div>
    );
    if (finished) return (
      <div className="mx-auto max-w-xl space-y-4 text-center py-8">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
        <h2 className="text-xl font-semibold">Kalibrierungswerte übernommen</h2>
        <p className="text-sm text-muted-foreground">Die Testseiten dürfen für spätere Nachkalibrierungen gespeichert bleiben. Möchtest du sie jetzt aufräumen?</p>
        <div className="flex flex-wrap justify-center gap-2"><Button variant="destructive" onClick={() => removeAll.mutate()} disabled={removeAll.isPending}>{removeAll.isPending && <Spinner className="h-4 w-4" />}Testseiten löschen und schließen</Button><Button variant="outline" onClick={() => navigate('/einstellungen?tab=scanner')}>Testseiten behalten und schließen</Button></div>
      </div>
    );
    return (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{PARAMETER.map(({ key, label, bereich }) => <div key={key} className="rounded-lg border px-3 py-2"><p className="text-[11px] text-muted-foreground">{label} · {bereich}</p><p className="font-mono text-sm font-semibold">{parameters[key]}</p></div>)}</div>
        {cards(true)}
        {analysisError && <Testergebnis status="fehler">{analysisError}</Testergebnis>}
        {apply.isError && <Testergebnis status="fehler">{apply.error.message}</Testergebnis>}
      </div>
    );
  }

  const nextDisabled = (schritt === 'testscans' && existingCount === 0) || (schritt === 'tuning' && (analysisLoading || results.length === 0 || !!analysisError));
  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/40 to-background">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-2.5 sm:px-6"><Logo size={34} /><div><p className="text-sm font-semibold">Scanner kalibrieren</p><p className="text-[11px] text-muted-foreground">Schritt {aktuell + 1} von 3</p></div><Button variant="ghost" size="sm" className="ml-auto" onClick={() => navigate('/einstellungen?tab=scanner')}><X className="h-4 w-4 mr-1" />Schließen</Button></div><div className="h-0.5 bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${((aktuell + 1) / 3) * 100}%` }} /></div></header>
      <div className="mx-auto max-w-7xl gap-6 px-3 py-5 sm:px-6 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav className="mb-4 lg:mb-0"><ol className="flex gap-1.5 overflow-x-auto lg:flex-col">{SCHRITTE.map((item, i) => <li key={item.id} className="shrink-0"><button type="button" onClick={() => navigate(`/scanner-kalibrierung/${item.id}`)} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${i === aktuell ? 'bg-primary/10 font-semibold' : 'text-muted-foreground hover:bg-muted'}`}><span className={`grid h-7 w-7 place-items-center rounded-full border ${i < aktuell ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600' : i === aktuell ? 'border-primary text-primary' : ''}`}>{i < aktuell ? <Check className="h-3.5 w-3.5" /> : <item.icon className="h-3.5 w-3.5" />}</span>{item.label}</button></li>)}</ol></nav>
        <main className="min-w-0"><Card><CardHeader className="border-b bg-muted/20"><CardTitle className="text-lg">{definition.title}</CardTitle><CardDescription>{definition.subtitle}</CardDescription></CardHeader><CardContent className="pt-5">{content()}</CardContent></Card>{!finished && <footer className="mt-4 flex justify-between gap-2"><Button variant="outline" disabled={aktuell === 0} onClick={() => navigate(`/scanner-kalibrierung/${SCHRITTE[aktuell - 1]?.id}`)}><ArrowLeft className="h-4 w-4 mr-1" />Zurück</Button>{schritt === 'abschluss' ? <Button onClick={() => apply.mutate()} disabled={apply.isPending || analysisLoading || results.length === 0}>{apply.isPending ? <Spinner className="h-4 w-4 mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}Werte übernehmen</Button> : <Button disabled={nextDisabled} onClick={() => navigate(`/scanner-kalibrierung/${SCHRITTE[aktuell + 1].id}`)}>Weiter<ArrowRight className="h-4 w-4 ml-1" /></Button>}</footer>}</main>
      </div>
    </div>
  );
}

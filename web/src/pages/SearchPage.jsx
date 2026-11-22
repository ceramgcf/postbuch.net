import { useState, useEffect, useRef } from 'react';
import { useZurueckZiel } from '@/hooks/useBackButtonGuard';
import { useSearchParams, Link, useNavigate, useNavigationType, useLocation } from 'react-router';
import { useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { VERLAUF } from '@/components/layout/Marke';
import { api } from '@/api/client';
import { useAddDocumentToAkte } from '@/hooks/useAkten';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArtBadge } from '@/components/postbuch/ArtBadge';
import { LebensbereichBadge } from '@/components/postbuch/LebensbereichBadge';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Search, Sparkles, TextSearch, Target, X, FolderPlus, ArrowLeft, FolderOpen, Archive, FileText, Folder, Info } from 'lucide-react';
import { AutoForwardRing } from '@/components/ui/auto-forward-ring';

// Erkennt eine vollständige Nummern-Eingabe (mit Buchstabe), z.B. "P000123", "a123".
// Nur dann ist das Autoforward-Ziel eindeutig (P → Dokumente, A → Akten).
function parseClientIdQuery(q) {
  const m = (q || '').trim().match(/^#?\s*([PpAa])\s*[-.]?\s*(\d{1,6})$/);
  return m ? { kind: m[1].toUpperCase() } : null;
}

function prozent(wert) {
  return `${Math.round(Math.max(0, Math.min(1, wert)) * 100)} %`;
}

// Pille mit dezentem Füllbalken (Markenverlauf) entsprechend dem Wert.
// Ausgegraut, wenn der Wert nichts aussagt (keine Wörter, Rauschen). Die
// Hauptpille (Übereinstimmung) trägt einen kräftigeren Balken.
function WertPille({ icon: Icon, text, wert, grau, title, haupt = false }) {
  const breite = Math.round(Math.max(0, Math.min(1, wert ?? 0)) * 100);
  const farbe = grau ? 'text-muted-foreground/60 grayscale opacity-70'
    : haupt ? 'text-foreground font-medium' : 'text-muted-foreground';
  return (
    <span
      title={title}
      className={`relative inline-flex items-center gap-1 overflow-hidden rounded-full border ${haupt ? 'border-primary/40' : 'border-border/70'} bg-muted/40 px-2 py-0.5 ${farbe}`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 ${haupt ? 'opacity-45' : 'opacity-20'}`}
        style={{
          width: `${breite}%`,
          backgroundImage: VERLAUF,
          // Der Verlauf der Wortmarke spannt immer die ganze Pille: Ein kurzer
          // Balken zeigt nur Lila, Türkis erscheint erst bei sehr guten Werten.
          backgroundSize: breite > 0 ? `${10000 / breite}% 100%` : undefined,
          backgroundRepeat: 'no-repeat',
        }}
      />
      <Icon className="relative h-3 w-3" />
      <span className="relative tabular-nums">{text}</span>
    </span>
  );
}

// Kennzahlen je Treffer: die Übereinstimmung (danach ist sortiert), wie viele
// Suchwörter im Text vorkommen und wie ähnlich der Inhalt der Anfrage ist. Ein
// Wert fehlt, wenn er nicht bestimmbar ist (Nummernsuche, kein Embedding).
// Unter der Unsinnsschwelle des aktiven Modells ist die Ähnlichkeit Rauschen
// und wird ausgegraut.
//
// Kosinuswerte sind modellabhängig. Kennt die kuratierte Liste das Modell,
// zeigt die Pille die Ähnlichkeit auf dessen Skala: 0 % = so ähnlich wie bei
// einer sinnlosen Anfrage, 100 % = sehr eng verwandt (aehnlichkeitVoll).
function inhaltAnzeige(aehnlichkeit, unsinnsschwelle, aehnlichkeitVoll) {
  if (aehnlichkeit == null) return null;
  if (aehnlichkeitVoll == null) return aehnlichkeit;
  const u = unsinnsschwelle ?? 0;
  return Math.max(0, Math.min(1, (aehnlichkeit - u) / (aehnlichkeitVoll - u)));
}

function Trefferwerte({ treffer, unsinnsschwelle, aehnlichkeitVoll }) {
  const { anteilWoertlich, aehnlichkeit, uebereinstimmung } = treffer;
  if (anteilWoertlich == null && aehnlichkeit == null && uebereinstimmung == null) return null;
  const keineWoerter = anteilWoertlich != null && anteilWoertlich <= 0;
  const rauschen = aehnlichkeit != null && unsinnsschwelle != null && aehnlichkeit < unsinnsschwelle;
  const inhalt = inhaltAnzeige(aehnlichkeit, unsinnsschwelle, aehnlichkeitVoll);
  const skaliert = aehnlichkeitVoll != null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs mt-1.5">
      {uebereinstimmung != null && (
        <WertPille
          haupt
          icon={Target}
          text={`Übereinstimmung ${prozent(uebereinstimmung)}`}
          wert={uebereinstimmung}
          title="Wie gut der Treffer insgesamt zur Anfrage passt – aus Wörtern und Inhalt zusammen. Danach ist die Liste sortiert."
        />
      )}
      {/* Wörter und Inhalt bilden eine Gruppe: Wird es eng, bricht die Zeile
          nach „Übereinstimmung“ um, nie zwischen Wörtern und Inhalt. */}
      <span className="flex flex-wrap items-center gap-1.5">
        {anteilWoertlich != null && (
          <WertPille
            icon={TextSearch}
            text={keineWoerter ? 'keine Wörter' : `Wörter ${prozent(anteilWoertlich)}`}
            wert={anteilWoertlich}
            grau={keineWoerter}
            title="Anteil der Suchwörter, die im Text vorkommen (auch als Wortteil)"
          />
        )}
        {aehnlichkeit != null && (
          <WertPille
            icon={Sparkles}
            text={`Inhalt ${prozent(inhalt)}`}
            wert={inhalt}
            grau={rauschen}
            title={rauschen
              ? 'Inhaltliche Ähnlichkeit zur Anfrage – so niedrig, dass das Modell sie auch für sinnlose Anfragen liefert'
              : skaliert
                ? `Inhaltliche Ähnlichkeit zur Anfrage auf der Skala des Modells (Kosinus ${aehnlichkeit.toFixed(2).replace('.', ',')})`
                : 'Inhaltliche Ähnlichkeit zur Anfrage (Kosinus-Ähnlichkeit des Embedding-Modells)'}
          />
        )}
      </span>
    </p>
  );
}

// Lädt die nächste Seite, sobald das Listenende in Sichtweite kommt.
function NachladeMarke({ query }) {
  const ref = useRef(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasNextPage) return undefined;
    const beobachter = new IntersectionObserver((eintraege) => {
      if (eintraege[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage();
    }, { rootMargin: '400px' });
    beobachter.observe(el);
    return () => beobachter.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  if (!hasNextPage) return null;
  return (
    <div ref={ref} className="text-xs text-muted-foreground text-center py-3">
      {isFetchingNextPage ? 'Weitere Treffer werden geladen …' : (
        <button type="button" className="underline-offset-2 hover:underline" onClick={() => fetchNextPage()}>
          Weitere Treffer laden
        </button>
      )}
    </div>
  );
}

// Trenner vor dem ersten Treffer der zweiten Stufe (geringere Übereinstimmung,
// aber noch über der Untergrenze).
function StufenTrenner({ liste, idx }) {
  if (liste[idx]?.stufe !== 2 || (idx > 0 && liste[idx - 1]?.stufe === 2)) return null;
  return (
    <div className="flex items-center gap-2 pt-3 pb-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>Weniger passende Treffer</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// Treffer aller geladenen Seiten; ändert sich der Bestand zwischen zwei Seiten,
// kann ein Eintrag doppelt kommen – dann zählt das erste Vorkommen.
function alleSeiten(query, schluessel) {
  const gesehen = new Set();
  return (query.data?.pages || []).flatMap((s) => s.data || [])
    .filter((t) => !gesehen.has(t[schluessel]) && gesehen.add(t[schluessel]));
}

// Seitenweise Suche: erste Seite 50 Treffer, weitere beim Scrollen.
function useSuchSeiten(art, q, showHistorisch, enabled) {
  return useInfiniteQuery({
    queryKey: ['search', art, q, showHistorisch],
    queryFn: ({ pageParam }) => api.search[art](q, {
      ...(showHistorisch ? { historisch: 'all' } : {}),
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (letzte) => (letzte?.hasMore ? letzte.naechsterOffset : undefined),
    enabled,
  });
}

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialQ = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQ);
  const eingabeRef = useRef(null);
  const [showHistorisch, setShowHistorisch] = useState(false);
  const [activeTab, setActiveTab] = useState('dokumente');

  // Aktenmodus: carried via URL params so back-navigation preserves context
  const aktenmodusAkteId = searchParams.get('aktenmodusAkteId') || null;
  const aktenmodusBetreff = searchParams.get('aktenmodusBetreff') || null;
  const aktenmodusBackTo = searchParams.get('aktenmodusBackTo') || null;
  useZurueckZiel(!!aktenmodusAkteId, () => navigate(aktenmodusBackTo || `/akten/${aktenmodusAkteId}`));

  // Add-to-akte
  const addDocMutation = useAddDocumentToAkte();
  const [confirmAddPostId, setConfirmAddPostId] = useState(null);
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  // Nur eigene Dokumente: Akten sind für diese Konten gesperrt.
  const { istEingeschraenkt } = useAuth();

  // Eine Suche, zwei Wege: Der Server führt wörtliche und inhaltliche Treffer
  // zu einer Liste zusammen (service/suche.js).
  const docQuery = useSuchSeiten('dokumente', initialQ, showHistorisch, !!initialQ);
  const aktenQuery = useSuchSeiten('akten', initialQ, showHistorisch, !!initialQ && !istEingeschraenkt);
  const docErste = docQuery.data?.pages?.[0];
  const aktenErste = aktenQuery.data?.pages?.[0];

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      const params = { q: query.trim() };
      if (aktenmodusAkteId) {
        params.aktenmodusAkteId = aktenmodusAkteId;
        if (aktenmodusBetreff) params.aktenmodusBetreff = aktenmodusBetreff;
        if (aktenmodusBackTo) params.aktenmodusBackTo = aktenmodusBackTo;
      }
      setSearchParams(params);
    }
  };

  const currentSearchUrl = '/search?' + searchParams.toString();

  const docResults = alleSeiten(docQuery, 'postid');
  const aktenResults = alleSeiten(aktenQuery, 'akteid');
  const docGesamt = docErste?.gesamt ?? docResults.length;
  const aktenGesamt = aktenErste?.gesamt ?? aktenResults.length;
  // Ohne Embedding-Dienst liefert der Server nur wörtliche Treffer.
  const inhaltlichFehlt = docErste?.inhaltlichVerfuegbar === false;

  // --- Autoforward bei exakter Nummerneingabe -------------------------------
  // Nach 3 s automatisch zum exakten Treffer; abbrechbar per Ring-Klick, ESC/
  // beliebiger Taste, Scroll oder Touch. Kein Start bei Back-Navigation (POP
  // per Browser-zurück, oder skipAutoforward-State per In-App-Zurück-Link –
  // sonst Redirect-Schleife Detailseite→zurück→forward), bei verstecktem Tab
  // oder wenn für diese Query bereits abgebrochen/weitergeleitet wurde.
  const navigationType = useNavigationType();
  const location = useLocation();
  const clientIdq = parseClientIdQuery(initialQ);
  const [forwardTarget, setForwardTarget] = useState(null); // { url, id, state }
  const armedForQueryRef = useRef(null); // Query, für die schon gearmt wurde
  const cancelForward = () => {
    armedForQueryRef.current = initialQ;
    setForwardTarget(null);
  };

  // A-Nummer eingegeben → Akten-Tab zeigen (der Treffer liegt dort)
  useEffect(() => {
    if (clientIdq) setActiveTab(clientIdq.kind === 'A' ? 'akten' : 'dokumente');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  useEffect(() => {
    if (!clientIdq) return;
    if (navigationType === 'POP') return;
    if (location.state?.skipAutoforward) return;
    if (armedForQueryRef.current === initialQ) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    let target = null;
    if (clientIdq.kind === 'P') {
      const idx = docResults.findIndex((x) => x.exact);
      if (idx >= 0) {
        target = {
          url: `/postbuch/${docResults[idx].postid}`,
          id: docResults[idx].postid,
          state: {
            from: currentSearchUrl,
            navList: docResults.map((x) => ({ postid: x.postid, betreff: x.betreff || x.kontakt, art: x.art })),
            navIndex: idx,
          },
        };
      }
    } else {
      const a = aktenResults.find((x) => x.exact);
      if (a) target = { url: `/akten/${a.akteid}`, id: a.akteid, state: {} };
    }
    if (target) {
      armedForQueryRef.current = initialQ;
      setForwardTarget(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ, docResults, aktenResults]);

  useEffect(() => {
    if (!forwardTarget) return;
    const timer = setTimeout(() => {
      setForwardTarget(null);
      navigate(forwardTarget.url, { state: forwardTarget.state });
    }, 3000);
    const onInteract = () => cancelForward();
    window.addEventListener('scroll', onInteract, { passive: true });
    window.addEventListener('touchstart', onInteract, { passive: true });
    window.addEventListener('mousedown', onInteract);
    window.addEventListener('keydown', onInteract);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onInteract);
      window.removeEventListener('touchstart', onInteract);
      window.removeEventListener('mousedown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwardTarget]);
  // --------------------------------------------------------------------------

  const zaehler = (n, gesamt) => (gesamt > n ? `${n}+` : String(n));

  const handleBackToPostbuch = () => {
    const params = new URLSearchParams({ sort: 'postid', order: 'desc' });
    if (aktenmodusAkteId) {
      params.set('aktenmodusAkteId', aktenmodusAkteId);
      if (aktenmodusBetreff) params.set('aktenmodusBetreff', aktenmodusBetreff);
      if (aktenmodusBackTo) params.set('aktenmodusBackTo', aktenmodusBackTo);
    }
    navigate(`/postbuch?${params.toString()}`);
  };

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-5 max-w-4xl">
      <div>
        <GlowHeading>Suche</GlowHeading>
        <p className="text-muted-foreground mt-1">Findet Dokumente und Akten nach Stichwort und Inhalt.</p>
      </div>

      {/* Aktenmodus banner */}
      {aktenmodusAkteId && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20 flex-wrap">
          <FolderOpen className="h-4 w-4 text-primary flex-shrink-0" />
          <Badge className="bg-primary/10 text-primary border-primary/30">Aktenmodus</Badge>
          <span className="text-sm text-muted-foreground">
            Zur Akte <span className="font-semibold">„{aktenmodusBetreff}"</span> hinzufügen
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleBackToPostbuch}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Dokumentenarchiv
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(aktenmodusBackTo || `/akten/${aktenmodusAkteId}`)}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Zur Akte
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Suchbegriff..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            ref={eingabeRef}
            className={`pl-9 h-10${query ? ' pr-10' : ''}`}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); eingabeRef.current?.focus(); }}
              title="Eingabe leeren"
              aria-label="Eingabe leeren"
              className="absolute right-1 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button type="submit" className="h-10">Suchen</Button>
      </form>

      <div className="flex gap-2 items-center">
        <button
          onClick={() => setShowHistorisch(!showHistorisch)}
          title={showHistorisch ? 'Archivierte Einträge ausblenden' : 'Archivierte Einträge einblenden'}
          className={`ml-auto flex-shrink-0 p-1.5 rounded-md transition-colors ${showHistorisch ? 'text-primary bg-primary/10' : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'}`}
        >
          <Archive className="h-4 w-4" />
        </button>
      </div>

      {!initialQ ? (
        <EmptyState icon={Search} title="Suchbegriff eingeben" description="Gib einen Suchbegriff ein, um Dokumente und Akten zu finden." />
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            <button
              onClick={() => setActiveTab('dokumente')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'dokumente'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              Dokumente
              {initialQ && (
                <span className={`inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full text-xs font-semibold ${
                  activeTab === 'dokumente' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}>
                  {docQuery.isLoading ? '…' : zaehler(docResults.length, docGesamt)}
                </span>
              )}
            </button>
            {!istEingeschraenkt && <button
              onClick={() => setActiveTab('akten')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'akten'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Folder className="h-3.5 w-3.5" />
              Akten
              {initialQ && (
                <span className={`inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full text-xs font-semibold ${
                  activeTab === 'akten' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}>
                  {aktenQuery.isLoading ? '…' : zaehler(aktenResults.length, aktenGesamt)}
                </span>
              )}
            </button>}
          </div>

          {inhaltlichFehlt && (
            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>Die inhaltliche Suche ist gerade nicht verfügbar. Angezeigt werden Treffer mit passendem Wortlaut.</span>
            </div>
          )}

          {/* Dokumente tab */}
          {activeTab === 'dokumente' && (
            docQuery.isLoading ? (
              <PageLoader />
            ) : docQuery.error ? (
              <p className="text-destructive text-sm">{docQuery.error.message}</p>
            ) : docResults.length === 0 ? (
              <EmptyState icon={Search} title="Keine Ergebnisse" description={`Keine Dokumente für „${initialQ}".`} />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{zaehler(docResults.length, docGesamt)} Ergebnisse</p>
                {docResults.map((r, idx) => (
                  <div key={r.postid}>
                  <StufenTrenner liste={docResults} idx={idx} />
                  <div className="relative">
                    <Link
                      to={`/postbuch/${r.postid}`}
                      state={{
                        from: currentSearchUrl,
                        navList: docResults.map(x => ({ postid: x.postid, betreff: x.betreff || x.kontakt, art: x.art })),
                        navIndex: idx,
                        ...(aktenmodusAkteId ? { aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo } : {}),
                      }}
                      className="block"
                    >
                      <Card className={`search-result-card transition-all cursor-pointer card-hover${r.historisch ? ' opacity-50' : ''}${r.exact ? ' ring-2 ring-primary/60 bg-primary/[0.03]' : ''}`}>
                        <CardContent className={`p-4${aktenmodusAkteId ? ' pr-12' : ''}${r.exact && forwardTarget?.id === r.postid ? ' pr-16' : ''}`}>
                          <div className="flex items-center gap-3 mb-1">
                            <span className="font-mono text-xs text-muted-foreground">{r.postid}</span>
                            {r.exact && (
                              <Badge className="bg-primary text-primary-foreground text-xs">Exakter Treffer</Badge>
                            )}
                            <LebensbereichBadge lebensbereich={r.lebensbereich} compact />
                            <ArtBadge art={r.dokumentart || r.art} />
                            <span className="text-xs text-muted-foreground ml-auto">{formatDate(r.briefdatum)}</span>
                          </div>
                          <p className="text-sm font-medium">
                            <span className="subject search-highlight">{r.betreff || r.kontakt || '–'}</span>
                          </p>
                          {r.zusammenfassung && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.zusammenfassung}</p>
                          )}
                          {r.betrag && (
                            <span className="text-sm font-mono mt-1 inline-block">{formatCurrency(r.betrag)}</span>
                          )}
                          <Trefferwerte treffer={r} unsinnsschwelle={docErste?.unsinnsschwelle} aehnlichkeitVoll={docErste?.aehnlichkeitVoll} />
                        </CardContent>
                      </Card>
                    </Link>
                    {aktenmodusAkteId && (
                      <button
                        onClick={() => setConfirmAddPostId(r.postid)}
                        className="absolute top-1/2 -translate-y-1/2 right-3 z-10 flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 hover:bg-primary/25 text-primary transition-colors"
                        title="Zur Akte hinzufügen"
                      >
                        <FolderPlus className="h-4 w-4" />
                      </button>
                    )}
                    {forwardTarget?.id === r.postid && (
                      <AutoForwardRing onCancel={cancelForward} className="absolute top-3 right-3 z-10" />
                    )}
                  </div>
                  {idx === 0 && r.exact && docResults.length > 1 && (
                    <p className="text-xs text-muted-foreground px-1 pt-2">Weitere Treffer mit dieser Nummer:</p>
                  )}
                  </div>
                ))}
                <NachladeMarke query={docQuery} />
              </div>
            )
          )}

          {/* Akten tab */}
          {activeTab === 'akten' && !istEingeschraenkt && (
            aktenQuery.isLoading ? (
              <PageLoader />
            ) : aktenQuery.error ? (
              <p className="text-destructive text-sm">{aktenQuery.error.message}</p>
            ) : aktenResults.length === 0 ? (
              <EmptyState icon={Search} title="Keine Ergebnisse" description={`Keine Akten für „${initialQ}".`} />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{zaehler(aktenResults.length, aktenGesamt)} Ergebnisse</p>
                {aktenResults.map((a, idx) => (
                  <div key={a.akteid}>
                  <StufenTrenner liste={aktenResults} idx={idx} />
                  <div className="relative">
                  <Link to={`/akten/${a.akteid}`} className="block">
                    <Card className={`search-result-card transition-all cursor-pointer card-hover${a.historisch ? ' opacity-50' : ''}${a.exact ? ' ring-2 ring-primary/60 bg-primary/[0.03]' : ''}`}>
                      <CardContent className={`p-4${a.exact && forwardTarget?.id === a.akteid ? ' pr-16' : ''}`}>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="font-mono text-xs text-muted-foreground">{a.akteid}</span>
                          {a.exact && (
                            <Badge className="bg-primary text-primary-foreground text-xs">Exakter Treffer</Badge>
                          )}
                          <span className="text-xs text-muted-foreground ml-auto">
                            {a.dok_count} {a.dok_count === 1 ? 'Dokument' : 'Dokumente'}
                          </span>
                        </div>
                        <p className="text-sm font-medium">{a.betreff || '–'}</p>
                        {a.beschreibung && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{a.beschreibung}</p>
                        )}
                        {a.schlagwoerter?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {a.schlagwoerter.map(sw => (
                              <Badge key={sw} variant="outline" className="text-xs px-1.5 py-0">{sw}</Badge>
                            ))}
                          </div>
                        )}
                        <Trefferwerte treffer={a} unsinnsschwelle={aktenErste?.unsinnsschwelle} aehnlichkeitVoll={aktenErste?.aehnlichkeitVoll} />
                      </CardContent>
                    </Card>
                  </Link>
                  {forwardTarget?.id === a.akteid && (
                    <AutoForwardRing onCancel={cancelForward} className="absolute top-3 right-3 z-10" />
                  )}
                  </div>
                  {idx === 0 && a.exact && aktenResults.length > 1 && (
                    <p className="text-xs text-muted-foreground px-1 pt-2">Weitere Treffer mit dieser Nummer:</p>
                  )}
                  </div>
                ))}
                <NachladeMarke query={aktenQuery} />
              </div>
            )
          )}
        </>
      )}

      {/* Add-to-akte confirmation dialog */}
      <Dialog open={!!confirmAddPostId} onOpenChange={() => setConfirmAddPostId(null)}>
        <DialogTitle>Dokument zur Akte hinzufügen?</DialogTitle>
        <DialogDescription>
          Soll <span className="font-mono font-semibold">{confirmAddPostId}</span> zur Akte
          <span className="font-semibold"> „{aktenmodusBetreff}"</span> hinzugefügt werden?
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmAddPostId(null)}>Abbrechen</Button>
          <Button
            onClick={async () => {
              try {
                const postIdToAdd = confirmAddPostId;
                const akteId = aktenmodusAkteId;
                await addDocMutation.mutateAsync({ akteid: akteId, postid: postIdToAdd });
                setConfirmAddPostId(null);
                pushAction(
                  `Dokument ${postIdToAdd} zur Akte hinzugefügt`,
                  async () => { await api.akten.removeDocument(akteId, postIdToAdd); qc.invalidateQueries({ queryKey: ['akten'] }); },
                  async () => { await api.akten.addDocument(akteId, postIdToAdd); qc.invalidateQueries({ queryKey: ['akten'] }); },
                );
              } catch (err) {
                console.error('Add to akte error:', err);
              }
            }}
            disabled={addDocMutation.isPending}
          >
            {addDocMutation.isPending ? 'Wird hinzugefügt…' : 'Hinzufügen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

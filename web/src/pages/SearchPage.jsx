import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link, useNavigate, useNavigationType, useLocation } from 'react-router';
import { useQueryClient, useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { useFulltextSearch } from '@/hooks/usePostbuch';
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
import { Search, Sparkles, FolderPlus, ArrowLeft, FolderOpen, Archive, FileText, Folder, X } from 'lucide-react';

const SIMILARITY_THRESHOLD = 0.6;

// Erkennt eine vollständige Nummern-Eingabe (mit Buchstabe), z.B. "P000123", "a123".
// Nur dann ist das Autoforward-Ziel eindeutig (P → Dokumente, A → Akten).
function parseClientIdQuery(q) {
  const m = (q || '').trim().match(/^#?\s*([PpAa])\s*[-.]?\s*(\d{1,6})$/);
  return m ? { kind: m[1].toUpperCase() } : null;
}

// Countdown-Ring am exakten Treffer: 44px-Button, SVG-Ring läuft in 3s ab,
// Klick bricht die automatische Weiterleitung ab. Bei reduced-motion Zahlen-Countdown.
function AutoForwardRing({ onCancel }) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [remaining, setRemaining] = useState(3);
  useEffect(() => {
    const iv = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}
      aria-label="Weiterleitung abbrechen"
      title="Weiterleitung abbrechen"
      className="absolute top-3 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-background/90 backdrop-blur-sm border border-border/60 shadow-sm text-primary transition-opacity"
    >
      {reduced ? (
        <span className="text-sm font-semibold tabular-nums">{remaining}</span>
      ) : (
        <>
          <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
            <circle
              cx="22" cy="22" r="17" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeDasharray="106.8" className="animate-countdown-drain"
            />
          </svg>
          <X className="h-4 w-4" />
        </>
      )}
      <span role="timer" aria-live="assertive" className="sr-only">
        Weiterleitung in {remaining} Sekunden
      </span>
    </button>
  );
}

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialQ = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQ);
  const [mode, setMode] = useState('fulltext');
  const [showHistorisch, setShowHistorisch] = useState(false);
  const [activeTab, setActiveTab] = useState('dokumente');

  // Aktenmodus: carried via URL params so back-navigation preserves context
  const aktenmodusAkteId = searchParams.get('aktenmodusAkteId') || null;
  const aktenmodusBetreff = searchParams.get('aktenmodusBetreff') || null;
  const aktenmodusBackTo = searchParams.get('aktenmodusBackTo') || null;

  // Add-to-akte
  const addDocMutation = useAddDocumentToAkte();
  const [confirmAddPostId, setConfirmAddPostId] = useState(null);
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  const histOpts = showHistorisch ? { historisch: 'all' } : {};
  // Nur eigene Dokumente: Akten sind für diese Konten gesperrt.
  const { istEingeschraenkt } = useAuth();

  // Dokument-Suche
  const fulltextQuery = useFulltextSearch(mode === 'fulltext' ? initialQ : null, histOpts);
  const semanticInfiniteQuery = useInfiniteQuery({
    queryKey: ['search', 'semantic', initialQ, showHistorisch],
    queryFn: ({ pageParam = 0 }) => api.search.semantic(initialQ, { ...histOpts, offset: pageParam }),
    enabled: mode === 'semantic' && !!initialQ,
    getNextPageParam: (lastPage) => lastPage.hasMore ? (lastPage.offset + 20) : undefined,
    initialPageParam: 0,
  });

  // Akten-Suche
  const aktenFulltextQuery = useQuery({
    queryKey: ['search', 'akten', 'fulltext', initialQ, showHistorisch],
    queryFn: () => api.search.aktenFulltext(initialQ, histOpts),
    enabled: mode === 'fulltext' && !!initialQ && !istEingeschraenkt,
  });
  const aktenSemanticInfiniteQuery = useInfiniteQuery({
    queryKey: ['search', 'akten', 'semantic', initialQ, showHistorisch],
    queryFn: ({ pageParam = 0 }) => api.search.aktenSemantic(initialQ, { ...histOpts, offset: pageParam }),
    enabled: mode === 'semantic' && !!initialQ && !istEingeschraenkt,
    getNextPageParam: (lastPage) => lastPage.hasMore ? (lastPage.offset + 20) : undefined,
    initialPageParam: 0,
  });

  const semanticQuery = {
    isLoading: semanticInfiniteQuery.isLoading,
    error: semanticInfiniteQuery.error,
    data: { data: semanticInfiniteQuery.data?.pages.flatMap(p => p.data) ?? [] },
    hasNextPage: semanticInfiniteQuery.hasNextPage,
    fetchNextPage: () => semanticInfiniteQuery.fetchNextPage(),
    isFetchingNextPage: semanticInfiniteQuery.isFetchingNextPage,
  };
  const aktenSemanticQuery = {
    isLoading: aktenSemanticInfiniteQuery.isLoading,
    error: aktenSemanticInfiniteQuery.error,
    data: { data: aktenSemanticInfiniteQuery.data?.pages.flatMap(p => p.data) ?? [] },
    hasNextPage: aktenSemanticInfiniteQuery.hasNextPage,
    fetchNextPage: () => aktenSemanticInfiniteQuery.fetchNextPage(),
    isFetchingNextPage: aktenSemanticInfiniteQuery.isFetchingNextPage,
  };

  const activeDocQuery = mode === 'fulltext' ? fulltextQuery : semanticQuery;
  const activeAktenQuery = mode === 'fulltext' ? aktenFulltextQuery : aktenSemanticQuery;

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

  const docResults = activeDocQuery.data?.data || [];
  const aktenResults = activeAktenQuery.data?.data || [];

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

  // Badge counts: semantic → items with similarity >= threshold; fulltext → total
  const docBadgeCount = mode === 'semantic'
    ? docResults.filter(r => r.similarity != null && r.similarity >= SIMILARITY_THRESHOLD).length
    : docResults.length;
  const aktenBadgeCount = mode === 'semantic'
    ? aktenResults.filter(r => r.similarity != null && r.similarity >= SIMILARITY_THRESHOLD).length
    : aktenResults.length;

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
        <p className="text-muted-foreground mt-1">Volltext- oder semantische Suche über Dokumente und Akten.</p>
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
            className="pl-9 h-10"
          />
        </div>
        <Button type="submit" className="h-10">Suchen</Button>
      </form>

      <div className="flex gap-2 items-center">
        <Button
          variant={mode === 'fulltext' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('fulltext')}
          className="gap-1.5"
        >
          <Search className="h-3 w-3" />
          Volltext
        </Button>
        <Button
          variant={mode === 'semantic' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('semantic')}
          className="gap-1.5"
        >
          <Sparkles className="h-3 w-3" />
          Semantisch
        </Button>
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
                  {activeDocQuery.isLoading ? '…' : docBadgeCount}
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
                  {activeAktenQuery.isLoading ? '…' : aktenBadgeCount}
                </span>
              )}
            </button>}
          </div>

          {/* Dokumente tab */}
          {activeTab === 'dokumente' && (
            activeDocQuery.isLoading ? (
              <PageLoader />
            ) : activeDocQuery.error ? (
              <p className="text-destructive text-sm">{activeDocQuery.error.message}</p>
            ) : docResults.length === 0 ? (
              <EmptyState icon={Search} title="Keine Ergebnisse" description={`Keine Dokumente für „${initialQ}".`} />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{docResults.length} Ergebnisse</p>
                {docResults.map((r, idx) => (
                  <div key={r.postid}>
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
                      <Card className={`search-result-card transition-all cursor-pointer card-hover${r.historisch ? ' opacity-50' : ''}${r.exact ? ' ring-2 ring-primary/60 bg-primary/[0.03]' : r.similarity != null && r.similarity >= SIMILARITY_THRESHOLD ? ' ring-1 ring-emerald-500/30' : ''}`}>
                        <CardContent className={`p-4${aktenmodusAkteId ? ' pr-12' : ''}${r.exact && forwardTarget?.id === r.postid ? ' pr-16' : ''}`}>
                          <div className="flex items-center gap-3 mb-1">
                            <span className="font-mono text-xs text-muted-foreground">{r.postid}</span>
                            {r.exact && (
                              <Badge className="bg-primary text-primary-foreground text-xs">Exakter Treffer</Badge>
                            )}
                            <LebensbereichBadge lebensbereich={r.lebensbereich} compact />
                            <ArtBadge art={r.dokumentart || r.art} />
                            {r.similarity != null && (
                              <Badge variant="secondary" className={`text-xs${r.similarity >= SIMILARITY_THRESHOLD ? ' bg-emerald-500/15 text-emerald-600 border-emerald-500/30' : ''}`}>
                                {Math.round(r.similarity * 100)}% match
                              </Badge>
                            )}
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
                      <AutoForwardRing onCancel={cancelForward} />
                    )}
                  </div>
                  {idx === 0 && r.exact && docResults.length > 1 && (
                    <p className="text-xs text-muted-foreground px-1 pt-2">Weitere Treffer mit dieser Nummer:</p>
                  )}
                  </div>
                ))}
                {mode === 'semantic' && activeDocQuery.hasNextPage && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={activeDocQuery.fetchNextPage}
                      disabled={activeDocQuery.isFetchingNextPage}
                      className="gap-1.5"
                    >
                      {activeDocQuery.isFetchingNextPage ? (
                        <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Weitere Ergebnisse laden
                    </Button>
                  </div>
                )}
              </div>
            )
          )}

          {/* Akten tab */}
          {activeTab === 'akten' && !istEingeschraenkt && (
            activeAktenQuery.isLoading ? (
              <PageLoader />
            ) : activeAktenQuery.error ? (
              <p className="text-destructive text-sm">{activeAktenQuery.error.message}</p>
            ) : aktenResults.length === 0 ? (
              <EmptyState icon={Search} title="Keine Ergebnisse" description={`Keine Akten für „${initialQ}".`} />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{aktenResults.length} Ergebnisse</p>
                {aktenResults.map((a, idx) => (
                  <div key={a.akteid}>
                  <div className="relative">
                  <Link to={`/akten/${a.akteid}`} className="block">
                    <Card className={`search-result-card transition-all cursor-pointer card-hover${a.historisch ? ' opacity-50' : ''}${a.exact ? ' ring-2 ring-primary/60 bg-primary/[0.03]' : a.similarity != null && a.similarity >= SIMILARITY_THRESHOLD ? ' ring-1 ring-emerald-500/30' : ''}`}>
                      <CardContent className={`p-4${a.exact && forwardTarget?.id === a.akteid ? ' pr-16' : ''}`}>
                        <div className="flex items-center gap-3 mb-1">
                          <span className="font-mono text-xs text-muted-foreground">{a.akteid}</span>
                          {a.exact && (
                            <Badge className="bg-primary text-primary-foreground text-xs">Exakter Treffer</Badge>
                          )}
                          {a.similarity != null && (
                            <Badge variant="secondary" className={`text-xs${a.similarity >= SIMILARITY_THRESHOLD ? ' bg-emerald-500/15 text-emerald-600 border-emerald-500/30' : ''}`}>
                              {Math.round(a.similarity * 100)}% match
                            </Badge>
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
                      </CardContent>
                    </Card>
                  </Link>
                  {forwardTarget?.id === a.akteid && (
                    <AutoForwardRing onCancel={cancelForward} />
                  )}
                  </div>
                  {idx === 0 && a.exact && aktenResults.length > 1 && (
                    <p className="text-xs text-muted-foreground px-1 pt-2">Weitere Treffer mit dieser Nummer:</p>
                  )}
                  </div>
                ))}
                {mode === 'semantic' && activeAktenQuery.hasNextPage && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={activeAktenQuery.fetchNextPage}
                      disabled={activeAktenQuery.isFetchingNextPage}
                      className="gap-1.5"
                    >
                      {activeAktenQuery.isFetchingNextPage ? (
                        <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Weitere Ergebnisse laden
                    </Button>
                  </div>
                )}
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

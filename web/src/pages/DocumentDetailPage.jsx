import { useEffect, useState } from 'react';
import { useParams, useOutletContext, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePostbuchDetail, useCollectingPerioden, usePins, usePinDokument, useUnpinDokument } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { api } from '@/api/client';
import { useAktenByPostId, useRecentAkten, useAddDocumentToAkte, useRemoveDocumentFromAkte, useSemanticAktenSuggestions, useCreateAkte } from '@/hooks/useAkten';
import { PostbuchSection } from '@/components/detail/PostbuchSection';
import { ArztrechnungDetail } from '@/components/detail/ArztrechnungDetail';
import { ErstattungsbescheidDetail } from '@/components/detail/ErstattungsbescheidDetail';
import { HandwerkerrechnungDetail } from '@/components/detail/HandwerkerrechnungDetail';
import { GenRechnungDetail } from '@/components/detail/GenRechnungDetail';
import { ArztberichtDetail } from '@/components/detail/ArztberichtDetail';
import { ActionBar } from '@/components/detail/ActionBar';
import { NoteSection } from '@/components/detail/NoteSection';
import { WiedervorlageSection } from '@/components/detail/WiedervorlageSection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader } from '@/components/ui/spinner';
import { ArrowLeft, ChevronLeft, ChevronRight, FolderOpen, FolderPlus, Plus, Sparkles, Search, X, Pin, Pencil, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router';
import { useIsMobile } from '@/hooks/useIsMobile';
import { lockLandscape, unlockOrientation, useIsPortrait } from '@/hooks/useOrientationLock';
import { MobilePdfOverlay } from '@/components/layout/MobilePdfOverlay';
import { useAllowPortrait } from '@/hooks/usePortraitAllowed';
import { useAuth } from '@/hooks/useAuth';

const routeLabels = {
  '/': 'Dashboard',
  '/postbuch': 'Dokumente',
  '/akten': 'Aktenverzeichnis',
  '/analyse/wiedervorlagen': 'Kalender',
  '/wiedervorlagen': 'Kalender',
  '/search': 'Suche',
  '/analyse/unbezahlt': 'Unbezahlt',
  '/analyse/kuerzungen': 'Kürzungen',
  '/analyse/perioden': 'Abrechnungsperioden',
  '/analyse/handwerker': 'Handwerker',
  '/assistent': 'Zurück zum Chat',
};

function getBackLabel(from) {
  if (!from) return 'Dokumente';
  const path = from.split('?')[0];
  if (path.startsWith('/akten/')) return 'Zurück zur Akte';
  return routeLabels[path] || 'Dokumente';
}

function NavButton({ item, index, navList, backTo, direction, extraState }) {
  const navigate = useNavigate();
  const label = item.betreff || item.kontakt || item.art || item.postid;
  return (
    <button
      onClick={() => navigate(`/postbuch/${item.postid}`, {
        state: { from: backTo, navList, navIndex: index, ...extraState },
      })}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-2 py-1 transition-colors max-w-[180px]"
      title={`${item.postid} – ${label}`}
    >
      {direction === 'prev' && <ChevronLeft className="h-3.5 w-3.5 flex-shrink-0" />}
      <span className="font-mono text-[11px] flex-shrink-0">{item.postid}</span>
      <span className="truncate hidden sm:inline">{label}</span>
      {direction === 'next' && <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
    </button>
  );
}

// ── EmbeddingWarningBadge ────────────────────────────────────────────────────
// Zeigt eine Warnung wenn das Dokument kein semantisches Embedding hat.
// Bietet Retry-Button, der das Embedding sofort nachholt.

function EmbeddingWarningBadge({ postid, embeddingFailedAt, embeddingError }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.actions.retryMissingEmbeddings(),
    onSuccess: () => {
      // Nach 4 Sekunden Detailansicht neu laden (Embedding braucht einen Moment)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['postbuch', postid] });
        queryClient.invalidateQueries({ queryKey: ['missing-embeddings'] });
      }, 4000);
    },
    onError: (err) => alert(`Embedding-Retry fehlgeschlagen: ${err.message}`),
  });

  const lastAttempt = embeddingFailedAt
    ? new Date(embeddingFailedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
    : null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/8 px-4 py-3">
      <svg className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
          Semantisches Embedding fehlt
        </p>
        <p className="mt-0.5 text-xs text-amber-600/80 dark:text-amber-400/80">
          Semantische Suche und Duplikat-Erkennung sind für dieses Dokument nicht verfügbar.
          {lastAttempt && (
            <span> · Letzter Versuch: {lastAttempt}</span>
          )}
        </p>
        {embeddingError && (
          <p className="mt-0.5 text-xs text-amber-600/70 dark:text-amber-400/60 font-mono break-all">
            {embeddingError.slice(0, 120)}{embeddingError.length > 120 ? '…' : ''}
          </p>
        )}
      </div>
      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || mutation.isSuccess}
        className="text-xs text-amber-600 dark:text-amber-400 underline underline-offset-2 whitespace-nowrap flex-shrink-0 mt-0.5 hover:text-amber-500 disabled:opacity-50 disabled:cursor-wait"
      >
        {mutation.isPending ? 'Wird gestartet…' : mutation.isSuccess ? 'Gestartet ✓' : 'Embedding nachholen'}
      </button>
    </div>
  );
}

export default function DocumentDetailPage() {
  const { postid } = useParams();
  const { showPdf, closePdf, refreshPdf } = useOutletContext();
  const location = useLocation();
  const navigate = useNavigate();
  const backTo = location.state?.from || '/postbuch';
  const backLabel = getBackLabel(location.state?.from);
  const navList = location.state?.navList ?? [];
  const navIndex = location.state?.navIndex ?? -1;
  const prevItem = navIndex > 0 ? navList[navIndex - 1] : null;
  const nextItem = navIndex >= 0 && navIndex < navList.length - 1 ? navList[navIndex + 1] : null;

  // Aktenmodus state (when browsing docs from an Akte)
  const aktenmodusAkteId = location.state?.aktenmodusAkteId;
  const aktenmodusBetreff = location.state?.aktenmodusBetreff;
  const aktenmodusBackTo = location.state?.aktenmodusBackTo;
  const extraNavState = aktenmodusAkteId ? { aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo } : {};

  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();

  // Teilt der AppShell mit, dass Hochformat in der Dokumentendetailansicht erlaubt ist.
  // Dadurch re-triggert AppShell's useEffect mit portraitAllowed=true und ruft
  // unlockOrientation() auf – das behebt die Race Condition bei Direktaufruf (Deep Link):
  // ohne diesen Aufruf würde AppShell's Effect (der nach Child-Effects läuft) auf dem
  // initialen Mount lockLandscape() aufrufen und den Unlock unten überschreiben.
  useAllowPortrait(isMobile);

  // Orientation-Lock aufheben wenn Dokumentendetailansicht aktiv ist,
  // damit der Nutzer für den PDF-Vollbild-Viewer ins Portrait drehen kann.
  // Desktop: isMobile = false → kein Effekt.
  // isPortrait wird reaktiv von useIsPortrait() geliefert – kein manuelles setIsPortrait nötig.
  // Hinweis: Der eigentliche Unlock bei Direktaufruf wird durch AppShell (via
  // portraitAllowed-State) sichergestellt; dieser Effect dient als Belt-and-Suspenders.
  useEffect(() => {
    if (!isMobile) return;
    unlockOrientation();
    return () => {
      lockLandscape();
    };
  }, [isMobile]);

  const { data, isLoading, error } = usePostbuchDetail(postid);
  const { data: linkedAkten = [] } = useAktenByPostId(postid);
  const { data: recentAkten = [] } = useRecentAkten();
  const addToAkteMutation = useAddDocumentToAkte();
  const removeFromAkteMutation = useRemoveDocumentFromAkte();
  const createAkte = useCreateAkte();
  const { data: collectingPerioden } = useCollectingPerioden();
  const { data: pins } = usePins(postid);
  const pinMutation = usePinDokument();
  const unpinMutation = useUnpinDokument();
  const { pushAction } = useUndoHistory();

  const [showAktenMenu, setShowAktenMenu] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [newAkteMode, setNewAkteMode] = useState(false);
  const [newAkteBetreff, setNewAkteBetreff] = useState('');
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [editingPin, setEditingPin] = useState(null); // {person, kostentraeger} beim Bearbeiten, sonst null (= neue Anpinnung)
  const [pinPerson, setPinPerson] = useState('');
  const [pinKostentraeger, setPinKostentraeger] = useState('');
  const [pinGrund, setPinGrund] = useState('');

  // ── Bearbeitungsschutz: kein Portrait-PDF-Overlay während der Nutzer tippt oder ein Dialog offen ist ──
  // isInputFocused: wird true, wenn ein <input>/<textarea>/<select> den Fokus hat.
  // Ein 200ms Debounce auf focusout verhindert, dass kurzes Fokus-Wandern (z. B. beim Drehen) fälschlicherweise
  // den Schutz deaktiviert, bevor das Orientation-Event greift.
  const [isInputFocused, setIsInputFocused] = useState(false);
  useEffect(() => {
    function onFocusIn(e) {
      const tag = e.target?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        setIsInputFocused(true);
      }
    }
    function onFocusOut() {
      setTimeout(() => {
        const tag = document.activeElement?.tagName?.toUpperCase();
        setIsInputFocused(!!(tag && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')));
      }, 200);
    }
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // hasOpenDialog: beobachtet per MutationObserver, ob irgendein [role="dialog"] im DOM vorhanden ist.
  // Deckt sowohl lokale Dialoge (Akte hinzufügen/entfernen) als auch Dialoge in Kindkomponenten ab.
  const [hasOpenDialog, setHasOpenDialog] = useState(false);
  useEffect(() => {
    const check = () => setHasOpenDialog(document.querySelector('[role="dialog"]') !== null);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const semanticSuggestions = useSemanticAktenSuggestions(postid, showAktenMenu);

  useEffect(() => {
    if (data?.postbuch?.hatPdf || data?.postbuch?.onedrive_id) {
      showPdf(postid);
    }
    return () => closePdf();
  }, [postid, data?.postbuch?.hatPdf, data?.postbuch?.onedrive_id]);

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;
  if (!data) return null;

  const { postbuch, arztrechnung, erstattungsbescheid, erstattungsbescheidAusstehend, handwerkerrechnung, generischeRechnung, arztbericht } = data;
  const hasRechnung = !!arztrechnung || !!handwerkerrechnung || !!generischeRechnung;
  const bezahltAm = arztrechnung?.bezahlt_am || handwerkerrechnung?.bezahlt_am || generischeRechnung?.bezahlt_am;
  const isBezahlt = !!bezahltAm;

  // ── Portrait-PDF-Modus (nur Mobile, nur Hochformat) ──────────────────────────
  // Wenn der Nutzer sein Smartphone hochkant dreht: nur den PDF-Viewer anzeigen.
  // Rückdrehen ins Landscape schließt den Viewer automatisch.
  // Desktop: isMobile = false → dieser Block wird nie ausgeführt.
  // Ausnahme: läuft gerade eine Bearbeitung (Feld wird editiert oder Dialog ist offen),
  // wird der PDF-Overlay unterdrückt, damit keine laufende Eingabe unterbrochen wird.
  const suppressPortraitPdf = isInputFocused || hasOpenDialog;
  if (isMobile && isPortrait && !suppressPortraitPdf) {
    return (
      <MobilePdfOverlay
        postid={postid}
        hasPdf={!!(postbuch.hatPdf || postbuch.onedrive_id)}
      />
    );
  }

  const linkedIds = new Set(linkedAkten.map(a => a.akteid));
  const availableAkten = recentAkten.filter(a => !linkedIds.has(a.akteid));
  const { canWrite, istEingeschraenkt } = useAuth();

  // Personen mit mindestens einer offenen COLLECTING-Periode, und welche
  // Kostenträger dafür bei der gewählten Person überhaupt offen sind (eine
  // Person ohne Beihilfe hat dort schlicht keine Zeile).
  const pinPersonen = [...new Set((collectingPerioden?.data || []).map((p) => p.person))].sort();
  const pinKostentraegerOptionen = (collectingPerioden?.data || [])
    .filter((p) => p.person === pinPerson)
    .map((p) => p.kostentraeger);

  function handlePinOpenNew() {
    setEditingPin(null);
    setPinPerson('');
    setPinKostentraeger('');
    setPinGrund('');
    setPinDialogOpen(true);
  }

  function handlePinOpenEdit(pin) {
    setEditingPin(pin);
    setPinPerson(pin.person);
    setPinKostentraeger(pin.kostentraeger);
    setPinGrund(pin.grund);
    setPinDialogOpen(true);
  }

  async function handlePinSubmit() {
    if (!pinPerson || !pinKostentraeger || !pinGrund.trim()) return;
    const grund = pinGrund.trim();
    const wasEditing = !!editingPin;
    const oldGrund = editingPin?.grund ?? null;
    await pinMutation.mutateAsync({ postid, person: pinPerson, kostentraeger: pinKostentraeger, grund });
    setPinDialogOpen(false);
    pushAction(
      wasEditing ? 'Anpinnung bearbeitet' : 'Dokument angepinnt',
      () => wasEditing
        ? pinMutation.mutateAsync({ postid, person: pinPerson, kostentraeger: pinKostentraeger, grund: oldGrund })
        : unpinMutation.mutateAsync({ postid, person: pinPerson, kostentraeger: pinKostentraeger }),
      () => pinMutation.mutateAsync({ postid, person: pinPerson, kostentraeger: pinKostentraeger, grund }),
    );
  }

  function handleUnpin(person, kostentraeger) {
    const oldGrund = pins?.data?.find((p) => p.person === person && p.kostentraeger === kostentraeger)?.grund ?? '';
    unpinMutation.mutate({ postid, person, kostentraeger }, {
      onSuccess: () => {
        pushAction(
          'Anpinnung gelöst',
          () => pinMutation.mutateAsync({ postid, person, kostentraeger, grund: oldGrund }),
          () => unpinMutation.mutateAsync({ postid, person, kostentraeger }),
        );
      },
    });
  }

  function addToAkte(akteid) {
    addToAkteMutation.mutate({ akteid, postid }, {
      onSuccess: () => {
        pushAction(
          'Zu Akte hinzugefügt',
          () => removeFromAkteMutation.mutateAsync({ akteid, postid }),
          () => addToAkteMutation.mutateAsync({ akteid, postid }),
        );
      },
    });
  }

  function handleAddToAkte(akteid) {
    addToAkte(akteid);
    setShowAktenMenu(false);
  }

  function handleRemoveFromAkte() {
    if (!confirmRemove) return;
    const { akteid } = confirmRemove;
    removeFromAkteMutation.mutate({ akteid, postid }, {
      onSuccess: () => {
        pushAction(
          'Aus Akte entfernt',
          () => addToAkteMutation.mutateAsync({ akteid, postid }),
          () => removeFromAkteMutation.mutateAsync({ akteid, postid }),
        );
      },
    });
    setConfirmRemove(null);
  }

  function startAktenwahlmodus() {
    setShowAktenMenu(false);
    navigate('/akten', {
      state: { aktenwahlPostId: postid, aktenwahlBackTo: location.pathname },
    });
  }

  async function handleCreateAkte() {
    if (!newAkteBetreff.trim()) return;
    try {
      const newAkte = await createAkte.mutateAsync({ betreff: newAkteBetreff.trim() });
      await addToAkteMutation.mutateAsync({ akteid: newAkte.akteid, postid });
      setShowAktenMenu(false);
      setNewAkteMode(false);
      setNewAkteBetreff('');
      navigate(`/akten/${newAkte.akteid}`, { state: { from: location.pathname } });
    } catch (err) {
      console.error('Create akte error:', err);
    }
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Aktenmodus banner */}
      {aktenmodusAkteId && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2">
          <FolderOpen className="h-4 w-4 text-primary" />
          <span className="text-sm">
            Aktenmodus – <span className="font-medium">{aktenmodusAkteId}</span> {aktenmodusBetreff}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {linkedIds.has(aktenmodusAkteId) ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <FolderOpen className="h-3.5 w-3.5 text-green-500" />
                Bereits in Akte
              </span>
            ) : (
              canWrite && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={addToAkteMutation.isPending}
                onClick={() => addToAkte(aktenmodusAkteId)}
              >
                <Plus className="h-3.5 w-3.5" />
                {addToAkteMutation.isPending ? 'Wird hinzugefügt…' : 'Zur Akte hinzufügen'}
              </Button>
              )
            )}
            <Link to={aktenmodusBackTo || `/akten/${aktenmodusAkteId}`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" />
                Zurück zur Akte
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* Navigation row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link to={backTo} state={{ skipAutoforward: true }}>
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Button>
        </Link>
        <span className="text-sm text-muted-foreground font-mono">{postid}</span>

        {(prevItem || nextItem) && (
          <div className="flex items-center gap-1 ml-auto">
            {prevItem && (
              <NavButton item={prevItem} index={navIndex - 1} navList={navList} backTo={backTo} direction="prev" extraState={extraNavState} />
            )}
            <span className="text-[11px] text-muted-foreground/50 tabular-nums px-1">
              {navIndex + 1} / {navList.length}
            </span>
            {nextItem && (
              <NavButton item={nextItem} index={navIndex + 1} navList={navList} backTo={backTo} direction="next" extraState={extraNavState} />
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <ActionBar
        key={postid}
        postid={postid}
        currentStatus={postbuch.status}
        art={postbuch.art}
        hasRechnung={hasRechnung}
        isBezahlt={isBezahlt}
        isHistorisch={!!postbuch.historisch}
        hatPdf={!!postbuch.hatPdf}
        onReprocessComplete={() => refreshPdf(postid)}
        backTo={backTo}
      />

      {/* Warn-Badge: fehlendes semantisches Embedding */}
      {canWrite && !postbuch.hasEmbedding && (
        <EmbeddingWarningBadge
          postid={postid}
          embeddingFailedAt={postbuch.embedding_failed_at}
          embeddingError={postbuch.embedding_error}
        />
      )}

      {/* Postbuch Basis */}
      <PostbuchSection data={{ ...postbuch, erstattungsbescheid }} />

      {/* Benutzernotiz */}
      <NoteSection postid={postid} notiz={postbuch.notiz} />

      {/* Wiedervorlagen */}
      {/* Wiedervorlagen, Akten und Anpinnungen: für Konten mit eingeschränktem
          Lesebereich gesperrt – sie verweisen auf fremde Dokumente. */}
      {!istEingeschraenkt && <WiedervorlageSection postid={postid} />}

      {/* Akten – linked dossiers */}
      {!istEingeschraenkt && <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Akten</h3>
          <div className="ml-auto flex items-center gap-2">
            {postbuch.hasEmbedding && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  const params = new URLSearchParams({
                    similarToPostId: postid,
                    similarToBetreff: postbuch.betreff || postid,
                    sort: 'similarity',
                    order: 'desc',
                  });
                  navigate(`/postbuch?${params.toString()}`);
                }}
              >
                <Search className="h-3.5 w-3.5" />
                Ähnliche Dokumente
              </Button>
            )}
            {canWrite && pinPersonen.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handlePinOpenNew}>
                <Pin className="h-3.5 w-3.5" />
                An PKV-/Beihilfeperiode anheften
              </Button>
            )}
            {canWrite && (
              <div className="relative">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setShowAktenMenu(v => !v); setNewAkteMode(false); setNewAkteBetreff(''); }}>
                <Plus className="h-3.5 w-3.5" />
                Zu Akte hinzufügen
              </Button>
            {showAktenMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-md border bg-popover shadow-md overflow-hidden">
                {newAkteMode ? (
                  <div className="p-2">
                    <p className="px-1 py-0.5 text-xs font-semibold text-muted-foreground mb-1.5">Neue Akte anlegen</p>
                    <input
                      autoFocus
                      value={newAkteBetreff}
                      onChange={e => setNewAkteBetreff(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newAkteBetreff.trim()) handleCreateAkte();
                        if (e.key === 'Escape') { setNewAkteMode(false); setNewAkteBetreff(''); }
                      }}
                      placeholder="Betreff der neuen Akte…"
                      className="w-full px-2 py-1.5 text-sm rounded border border-input bg-background mb-1.5 focus:outline-none focus:ring-1 focus:ring-ring/50"
                    />
                    <div className="flex gap-1">
                      <button
                        className="flex-1 text-xs py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                        disabled={!newAkteBetreff.trim() || createAkte.isPending}
                        onClick={handleCreateAkte}
                      >
                        {createAkte.isPending ? 'Wird angelegt…' : 'Anlegen & öffnen'}
                      </button>
                      <button
                        className="px-2 text-xs py-1 rounded border hover:bg-accent transition-colors"
                        onClick={() => { setNewAkteMode(false); setNewAkteBetreff(''); }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-1">
                    {(() => {
                      const filteredSemantic = (semanticSuggestions.data || []).filter(a => !linkedIds.has(a.akteid));
                      return filteredSemantic.length > 0 && (
                      <>
                        <div className="flex items-center gap-1 px-2 py-1">
                          <Sparkles className="h-2.5 w-2.5 text-violet-500" />
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-500">KI-Vorschläge</span>
                        </div>
                        {filteredSemantic.map(a => (
                          <button
                            key={a.akteid}
                            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent text-left"
                            onClick={() => handleAddToAkte(a.akteid)}
                          >
                            <span className="font-mono text-xs text-muted-foreground">{a.akteid}</span>
                            <span className="truncate flex-1">{a.betreff}</span>
                            <span className="text-[10px] text-violet-400 flex-shrink-0">{Math.round(a.similarity * 100)}%</span>
                          </button>
                        ))}
                        <div className="border-t my-1" />
                      </>
                      );
                    })()}
                    {semanticSuggestions.isLoading && (
                      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
                        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                        KI-Vorschläge laden…
                      </div>
                    )}
                    {(() => {
                      const semanticIds = new Set((semanticSuggestions.data || []).map(a => a.akteid));
                      const filteredRecent = availableAkten.filter(a => !semanticIds.has(a.akteid));
                      return filteredRecent.length > 0 ? (
                        filteredRecent.map(a => (
                          <button
                            key={a.akteid}
                            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent text-left"
                            onClick={() => handleAddToAkte(a.akteid)}
                          >
                            <span className="font-mono text-xs text-muted-foreground">{a.akteid}</span>
                            <span className="truncate">{a.betreff}</span>
                          </button>
                        ))
                      ) : !semanticSuggestions.data?.length && !semanticSuggestions.isLoading ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">Keine Akten verfügbar</p>
                      ) : null;
                    })()}
                    <div className="border-t my-1" />
                    <button
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent text-left text-primary"
                      onClick={startAktenwahlmodus}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Akte wählen…
                    </button>
                    <button
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent text-left text-primary"
                      onClick={() => setNewAkteMode(true)}
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      Neue Akte anlegen…
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          )}
          </div>
        </div>
        {linkedAkten.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {linkedAkten.map(a => (
              <Link key={a.akteid} to={`/akten/${a.akteid}`} state={{ from: location.pathname }}>
                <Badge variant="secondary" className="gap-1.5 pr-1 hover:bg-accent cursor-pointer">
                  <FolderOpen className="h-3 w-3" />
                  {a.akteid} – {a.betreff}
                  {canWrite && (
                  <button
                    className="ml-1 rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmRemove({ akteid: a.akteid, betreff: a.betreff }); }}
                    title="Aus Akte entfernen"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  )}
                </Badge>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Dieses Dokument ist keiner Akte zugeordnet.</p>
        )}
        {pins?.data?.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {pins.data.map((p) => (
              <div key={`${p.person}-${p.kostentraeger}`} className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                <div>
                  <div className="font-medium flex items-center gap-1.5">
                    <Pin className="h-3.5 w-3.5 text-muted-foreground" />
                    {p.person} · {p.kostentraeger} · Periode {p.periode}
                  </div>
                  <div className="text-xs text-muted-foreground">{p.grund}</div>
                  {p.status === 'EINGEREICHT' && (
                    <div className="text-xs text-muted-foreground italic">bereits eingereicht</div>
                  )}
                </div>
                {canWrite && p.status === 'VORGEMERKT' && (
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => handlePinOpenEdit(p)} title="Anpinnung bearbeiten">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleUnpin(p.person, p.kostentraeger)} disabled={unpinMutation.isPending} title="Anpinnung lösen">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>}

      {/* Typ-spezifische Details */}
      <ArztrechnungDetail data={arztrechnung} istTier={postbuch.lebensbereich === 'tier'} />
      <ErstattungsbescheidDetail data={erstattungsbescheid} ausstehend={erstattungsbescheidAusstehend} />
      <HandwerkerrechnungDetail data={handwerkerrechnung} />
      <GenRechnungDetail data={generischeRechnung} art={postbuch.art} />
      <ArztberichtDetail data={arztbericht} />

      {/* Remove from Akte confirmation dialog */}
      <Dialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
        <DialogTitle>Aus Akte entfernen?</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Dokument <span className="font-mono">{postid}</span> aus Akte{' '}
          <span className="font-medium">{confirmRemove?.akteid} – {confirmRemove?.betreff}</span> entfernen?
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmRemove(null)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleRemoveFromAkte}>Entfernen</Button>
        </DialogFooter>
      </Dialog>

      {/* An PKV-/Beihilfeperiode anheften */}
      <Dialog open={pinDialogOpen} onOpenChange={setPinDialogOpen}>
        <DialogTitle>{editingPin ? 'Anpinnung bearbeiten' : 'An PKV-/Beihilfeperiode anheften'}</DialogTitle>
        <DialogDescription>
          Dieses Dokument wird zusätzlich, ganz hinten, in das Abrechnungspaket einer PKV- oder
          Beihilfe-Einreichung gehängt – als Zusatzanlage, nicht als Teil der regulären Einreichung.
        </DialogDescription>
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
          <span>
            Beihilfestellen lehnen formale Widersprüche über diesen informellen Weg erfahrungsgemäß ab –
            dafür ist ein eigenständiges Widerspruchsschreiben nötig.
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Person</label>
            <select
              className="w-full p-2 border rounded-md text-sm disabled:opacity-60"
              value={pinPerson}
              disabled={!!editingPin}
              onChange={(e) => { setPinPerson(e.target.value); setPinKostentraeger(''); }}
            >
              <option value="">– wählen –</option>
              {pinPersonen.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {pinPerson && (
            <div>
              <label className="text-sm font-medium mb-1 block">Kostenträger</label>
              <div className="flex gap-3">
                {pinKostentraegerOptionen.map((kt) => (
                  <label key={kt} className={`flex items-center gap-1.5 text-sm ${editingPin ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                    <input type="radio" name="pinKostentraeger" disabled={!!editingPin} checked={pinKostentraeger === kt} onChange={() => setPinKostentraeger(kt)} />
                    {kt}
                  </label>
                ))}
                {pinKostentraegerOptionen.length === 0 && (
                  <span className="text-xs text-muted-foreground">Keine offene COLLECTING-Periode für diese Person.</span>
                )}
              </div>
            </div>
          )}
          <div>
            <label className="text-sm font-medium mb-1 block">Grund (Pflichtfeld)</label>
            <textarea
              className="w-full p-2 border rounded-md text-sm min-h-[70px] resize-y"
              placeholder="Warum wird dieses Dokument beigefügt?"
              value={pinGrund}
              onChange={(e) => setPinGrund(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setPinDialogOpen(false)}>Schließen</Button>
          <Button onClick={handlePinSubmit} disabled={!pinPerson || !pinKostentraeger || !pinGrund.trim() || pinMutation.isPending}>
            <Pin className="h-4 w-4 mr-1" />
            {pinMutation.isPending ? 'Speichere...' : editingPin ? 'Speichern' : 'Anheften'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

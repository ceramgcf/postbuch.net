import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation, useOutletContext, Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAkteDetail, useUpdateAkte, useDeleteAkte,
  useAddDocumentToAkte, useRemoveDocumentFromAkte, useReorderDocuments,
  useKiVorschlag, useSetAkteHistorisch,
} from '@/hooks/useAkten';
import { NoteSection } from '@/components/detail/NoteSection';
import { WiedervorlageSection } from '@/components/detail/WiedervorlageSection';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader } from '@/components/ui/spinner';
import { ArtBadge } from '@/components/postbuch/ArtBadge';
import { LebensbereichBadge } from '@/components/postbuch/LebensbereichBadge';
import { StatusBadge } from '@/components/postbuch/StatusBadge';
import { ExportDialog } from '@/components/ExportDialog';
import { formatDate, formatCurrency } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useExportJob } from '@/hooks/useExportJob';
import { api } from '@/api/client';
import {
  ArrowLeft, Plus, Trash2, Eye, GripVertical,
  Pencil, X, Check, FileText, Sparkles, Download, Archive,
  MessageCircle,
} from 'lucide-react';
import { useUndoHistory } from '@/hooks/useUndoHistory';

function EditableField({ label, value, onSave, multiline, highlight }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const { canWrite } = useAuth();

  useEffect(() => { setDraft(value ?? ''); }, [value]);

  const save = () => {
    onSave(draft || null);
    setEditing(false);
  };

  if (editing) {
    const InputEl = multiline ? 'textarea' : 'input';
    return (
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground font-medium">{label}</label>
        <InputEl
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !multiline) save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-full px-2 py-1.5 text-sm rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring/50"
          rows={multiline ? 3 : undefined}
        />
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={save}>
            <Check className="h-3 w-3 mr-1" /> Speichern
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            <X className="h-3 w-3 mr-1" /> Abbrechen
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <label className="text-xs text-muted-foreground font-medium">{label}</label>
        <p className="text-sm mt-0.5 break-words">
          {value
            ? (highlight ? <span className="highlight font-semibold">{value}</span> : value)
            : <span className="text-muted-foreground/50 italic">–</span>}
        </p>
      </div>
      {canWrite && (
        <button
          onClick={() => setEditing(true)}
          className="mt-3 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function TagEditor({ tags, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tags || []);
  const [newTag, setNewTag] = useState('');
  const { canWrite } = useAuth();

  useEffect(() => { setDraft(tags || []); }, [tags]);

  const addTag = () => {
    const t = newTag.trim();
    if (t && !draft.includes(t)) {
      setDraft([...draft, t]);
      setNewTag('');
    }
  };

  const removeTag = (idx) => {
    setDraft(draft.filter((_, i) => i !== idx));
  };

  const save = () => {
    onSave(draft.length > 0 ? draft : null);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">Schlagwörter</label>
        <div className="flex flex-wrap gap-1.5">
          {draft.map((tag, i) => (
            <Badge key={i} variant="secondary" className="text-xs gap-1">
              {tag}
              <button onClick={() => removeTag(i)} className="hover:text-destructive">
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            placeholder="Neues Schlagwort…"
            className="h-7 text-xs flex-1"
          />
          <Button size="sm" variant="ghost" onClick={addTag}>+</Button>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={save}>
            <Check className="h-3 w-3 mr-1" /> Speichern
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(tags || []); }}>
            <X className="h-3 w-3 mr-1" /> Abbrechen
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <label className="text-xs text-muted-foreground font-medium">Schlagwörter</label>
        <div className="flex flex-wrap gap-1 mt-1">
          {(tags || []).length > 0 ? tags.map((tag, i) => (
            <Badge key={i} variant="outline" className="text-xs">{tag}</Badge>
          )) : <span className="text-xs text-muted-foreground/50 italic">–</span>}
        </div>
      </div>
      {canWrite && (
        <button
          onClick={() => setEditing(true)}
          className="mt-3 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function DraggableDocRow({ dok, index, onDragStart, onDragOver, onDrop, onShowPdf, onViewDoc, onRemove, selectionMode, isSelected, onToggleSelect, isDragDisabled }) {
  const dragHandlePressed = useRef(false);
  const { canWrite } = useAuth();

  return (
    <TableRow
      draggable={!isDragDisabled}
      onDragStart={isDragDisabled ? undefined : (e) => {
        if (!dragHandlePressed.current) {
          e.preventDefault();
          return;
        }
        onDragStart(e, index);
      }}
      onDragEnd={isDragDisabled ? undefined : () => { dragHandlePressed.current = false; }}
      onDragOver={isDragDisabled ? undefined : (e) => onDragOver(e, index)}
      onDrop={isDragDisabled ? undefined : (e) => onDrop(e, index)}
      className={`cursor-pointer ${isSelected ? 'bg-primary/8' : ''}`}
      onClick={() => {
        if (selectionMode) { onToggleSelect?.(dok.postid); return; }
        onViewDoc(dok.postid);
      }}
    >
      <TableCell
        className={`w-8 ${isDragDisabled ? 'text-transparent' : 'text-muted-foreground/40 cursor-grab active:cursor-grabbing'}`}
        onMouseDown={() => { if (!isDragDisabled) dragHandlePressed.current = true; }}
        onMouseUp={() => { dragHandlePressed.current = false; }}
        onClick={(e) => e.stopPropagation()}
      >
        {selectionMode ? (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect?.(dok.postid)}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
        ) : !isDragDisabled ? (
          <GripVertical className="h-4 w-4" />
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs">{dok.postid}</TableCell>
      <TableCell className="whitespace-nowrap text-xs">{formatDate(dok.briefdatum)}</TableCell>
      <TableCell><div className="flex items-center gap-1.5"><LebensbereichBadge lebensbereich={dok.lebensbereich} compact /><ArtBadge art={dok.dokumentart || dok.art} /></div></TableCell>
      <TableCell className="truncate max-w-[250px] text-sm">{dok.betreff || dok.kontakt || '–'}</TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-sm">
        {formatCurrency(dok.betrag)}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-[14px]">
          <button
            onClick={(e) => { e.stopPropagation(); onShowPdf(dok.postid); }}
            className="hidden sm:block text-muted-foreground hover:text-primary transition-colors"
            title="PDF anzeigen"
          >
            <Eye className="h-4 w-4" />
          </button>
          {canWrite && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(dok.postid); }}
              className="text-muted-foreground hover:text-destructive transition-colors"
              title="Aus Akte entfernen"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

const backRouteLabels = {
  '/': 'Dashboard',
  '/akten': 'Aktenverzeichnis',
  '/analyse/wiedervorlagen': 'Kalender',
  '/wiedervorlagen': 'Kalender',
  '/search': 'Suche',
  '/assistent': 'Zurück zum Chat',
};

function getBackLabel(from) {
  const path = (from || '').split('?')[0];
  if (path.startsWith('/postbuch/')) return 'Dokument';
  return backRouteLabels[path] || 'Aktenverzeichnis';
}

export default function AkteDetailPage() {
  const { akteid } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { showPdf, closePdf } = useOutletContext();

  // Aktenwahlmodus: if we arrived here with a postid to insert
  const aktenwahlPostId = location.state?.aktenwahlPostId || null;
  const aktenwahlBackTo = location.state?.aktenwahlBackTo || null;
  const backLabel = getBackLabel(location.state?.from);

  const { data, isLoading, error } = useAkteDetail(akteid);
  const updateAkte = useUpdateAkte();
  const deleteAkteMutation = useDeleteAkte();
  const addDocMutation = useAddDocumentToAkte();
  const removeDocMutation = useRemoveDocumentFromAkte();
  const reorderMutation = useReorderDocuments();
  const kiVorschlag = useKiVorschlag();
  const setAkteHistorisch = useSetAkteHistorisch();
  const { canWrite } = useAuth();
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [removingPostId, setRemovingPostId] = useState(null);
  const [confirmInsertDialog, setConfirmInsertDialog] = useState(false);
  const [kiError, setKiError] = useState(null);

  // Archive dialog state
  const [archiveDialog, setArchiveDialog] = useState(null); // { historisch: bool, betroffeneDoks: number }
  const [archiveAlsoDocs, setArchiveAlsoDocs] = useState(false);

  // Export state
  const [showExportDialog, setShowExportDialog]   = useState(false);
  const [exportPhase, setExportPhase]             = useState('scope');
  const [exportScope, setExportScope]             = useState(null);
  const [selectionMode, setSelectionMode]         = useState(false);
  const [selectedExportIds, setSelectedExportIds] = useState(() => new Set());
  const { isExporting, exportProgress, runExport } = useExportJob();

  const handleExportScopeChosen = (scope) => {
    if (scope === 'selection') {
      setSelectionMode(true);
      setSelectedExportIds(new Set());
      setShowExportDialog(false);
    } else {
      setExportScope(scope);
      setExportPhase('format');
    }
  };

  const handleToggleExportSelect = (postid) => {
    setSelectedExportIds(prev => {
      const next = new Set(prev);
      if (next.has(postid)) next.delete(postid);
      else next.add(postid);
      return next;
    });
  };

  const handleExport = async (format) => {
    await runExport({
      format,
      akteid,
      resolvePostIds: async () => (exportScope === 'selection'
        ? [...selectedExportIds]
        : displayDocs.map(d => d.postid)),
    });
    setShowExportDialog(false);
  };

  // Drag state
  const dragIdx = useRef(null);
  const [dokOrder, setDokOrder] = useState([]);
  const [dokSortMode, setDokSortMode] = useState('custom');

  const displayDocs = useMemo(() => {
    if (dokSortMode === 'briefdatum') {
      return [...dokOrder].sort((a, b) => {
        const da = a.briefdatum ? new Date(a.briefdatum) : new Date(0);
        const db = b.briefdatum ? new Date(b.briefdatum) : new Date(0);
        return db - da;
      });
    }
    return dokOrder;
  }, [dokOrder, dokSortMode]);

  const handleDokSortChange = (mode) => {
    setDokSortMode(mode);
    updateAkte.mutate({ akteid, data: { dok_sort_mode: mode } });
  };

  useEffect(() => {
    if (data?.dokumente) {
      setDokOrder(data.dokumente);
    }
  }, [data?.dokumente]);

  useEffect(() => {
    if (data?.akte?.dok_sort_mode) {
      setDokSortMode(data.akte.dok_sort_mode);
    }
  }, [data?.akte?.dok_sort_mode]);

  useEffect(() => {
    return () => closePdf();
  }, [akteid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;
  if (!data) return null;

  const { akte } = data;

  const handleUpdateField = (field, value) => {
    const oldValue = akte[field];
    const fieldLabels = { betreff: 'Betreff', beschreibung: 'Beschreibung', schlagwoerter: 'Schlagwörter', notiz: 'Notiz' };
    const label = fieldLabels[field] || field;
    updateAkte.mutate({ akteid, data: { [field]: value } }, {
      onSuccess: () => {
        pushAction(
          `Akte ${label} geändert`,
          async () => { await api.akten.update(akteid, { [field]: oldValue }); qc.invalidateQueries({ queryKey: ['akten'] }); },
          async () => { await api.akten.update(akteid, { [field]: value }); qc.invalidateQueries({ queryKey: ['akten'] }); },
        );
      },
    });
  };

  const handleToggleArchive = async () => {
    const newHistorisch = !akte.historisch;
    // Check how many documents would be affected
    try {
      const check = await api.akten.historischCheck(akteid, newHistorisch);
      if (check.count > 0) {
        setArchiveAlsoDocs(false);
        setArchiveDialog({ historisch: newHistorisch, betroffeneDoks: check.count });
      } else {
        // No documents to affect – set directly without dialog
        setAkteHistorisch.mutate({ akteid, historisch: newHistorisch, auch_dokumente: false });
      }
    } catch {
      setAkteHistorisch.mutate({ akteid, historisch: newHistorisch, auch_dokumente: false });
    }
  };

  const handleArchiveConfirm = () => {
    setAkteHistorisch.mutate(
      { akteid, historisch: archiveDialog.historisch, auch_dokumente: archiveAlsoDocs },
      { onSuccess: () => setArchiveDialog(null) }
    );
  };

  const handleDelete = async () => {
    try {
      // Capture snapshot before deleting (for undo)
      const snapshot = await api.akten.snapshot(akteid);
      await deleteAkteMutation.mutateAsync(akteid);
      pushAction(
        `Akte „${akte.betreff}" gelöscht`,
        async () => {
          await api.akten.restore(snapshot);
          qc.invalidateQueries({ queryKey: ['akten'] });
          qc.invalidateQueries({ queryKey: ['stats'] });
          navigate(`/akten/${akteid}`);
        },
        async () => {
          await api.akten.delete(akteid);
          qc.invalidateQueries({ queryKey: ['akten'] });
          qc.invalidateQueries({ queryKey: ['stats'] });
          navigate('/akten');
        },
      );
      navigate('/akten');
    } catch (err) {
      console.error('Delete akte error:', err);
    }
  };

  const handleAddDocuments = () => {
    // Start Aktenmodus: put akte context in URL so sorting/filtering doesn't lose it
    const backTo = `/akten/${akteid}`;
    const params = new URLSearchParams({
      aktenmodusAkteId: akteid,
      aktenmodusBetreff: akte.betreff,
      aktenmodusBackTo: backTo,
      // Only sort by similarity when the akte actually has an embedding
      sort: akte.has_embedding ? 'similarity' : 'postid',
      order: 'desc',
    });
    navigate(`/postbuch?${params.toString()}`);
  };

  const handleShowPdf = (postid) => {
    showPdf(postid, { closeable: true });
  };

  const handleViewDoc = (postid) => {
    navigate(`/postbuch/${postid}`, {
      state: {
        from: `/akten/${akteid}`,
        akteId: akteid,
        akteBetreff: akte.betreff,
      },
    });
  };

  const handleRemoveConfirm = async () => {
    if (!removingPostId) return;
    const postIdToRemove = removingPostId;
    try {
      await removeDocMutation.mutateAsync({ akteid, postid: postIdToRemove });
      setRemovingPostId(null);
      pushAction(
        `Dokument ${postIdToRemove} aus Akte entfernt`,
        async () => { await api.akten.addDocument(akteid, postIdToRemove); qc.invalidateQueries({ queryKey: ['akten'] }); },
        async () => { await api.akten.removeDocument(akteid, postIdToRemove); qc.invalidateQueries({ queryKey: ['akten'] }); },
      );
    } catch (err) {
      console.error('Remove document error:', err);
    }
  };

  // Drag & Drop handlers
  const handleDragStart = (e, idx) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, idx) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    const items = [...dokOrder];
    const [dragged] = items.splice(dragIdx.current, 1);
    items.splice(idx, 0, dragged);
    dragIdx.current = idx;
    setDokOrder(items);
  };

  const handleDrop = (e, idx) => {
    e.preventDefault();
    dragIdx.current = null;
    // Persist new order
    const order = dokOrder.map((d) => d.postid);
    reorderMutation.mutate({ akteid, order });
  };

  // Aktenwahlmodus: insert document
  const handleInsertDocument = async () => {
    if (!aktenwahlPostId) return;
    try {
      await addDocMutation.mutateAsync({ akteid, postid: aktenwahlPostId });
      setConfirmInsertDialog(false);
      pushAction(
        `Dokument ${aktenwahlPostId} zur Akte hinzugefügt`,
        async () => { await api.akten.removeDocument(akteid, aktenwahlPostId); qc.invalidateQueries({ queryKey: ['akten'] }); },
        async () => { await api.akten.addDocument(akteid, aktenwahlPostId); qc.invalidateQueries({ queryKey: ['akten'] }); },
      );
      if (aktenwahlBackTo) {
        navigate(aktenwahlBackTo);
      } else {
        navigate(`/postbuch/${aktenwahlPostId}`);
      }
    } catch (err) {
      console.error('Insert document error:', err);
    }
  };

  return (
    <div className="flex h-full">
      {/* Left panel: metadata + documents */}
      <div className="flex-1 overflow-auto p-6 lg:p-8 space-y-6">
        {/* Navigation */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={location.state?.from || '/akten'} state={{ skipAutoforward: true }}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              {backLabel}
            </Button>
          </Link>
          <span className="text-sm text-muted-foreground font-mono">{akteid}</span>
        </div>

        {/* Aktenwahlmodus banner */}
        {aktenwahlPostId && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
            <Badge className="bg-primary/10 text-primary border-primary/30">Aktenwahlmodus</Badge>
            <span className="text-sm text-muted-foreground">
              Dokument <span className="font-mono font-semibold">{aktenwahlPostId}</span> einfügen?
            </span>
            <Button size="sm" onClick={() => setConfirmInsertDialog(true)}>
              Dokument hier einfügen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => {
              if (aktenwahlBackTo) navigate(aktenwahlBackTo);
              else navigate(`/postbuch/${aktenwahlPostId}`);
            }}>
              Abbrechen
            </Button>
          </div>
        )}

        {/* Action buttons – Schreibaktionen nur für Schreib-Rollen, der
            Chat-Einstieg auch für Lesezugriff (Chat funktioniert read-only) */}
        <div className="flex items-center justify-between gap-x-3 gap-y-2 flex-wrap">
          {/* Gruppe 1 – Diskussion: Chat */}
          <div className="flex items-center flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate('/assistent', { state: { prefill: `#${akteid} ` } })}
              className="gap-1.5"
              title="Assistenten-Chat mit Referenz auf diese Akte starten"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              Im Chat besprechen
            </Button>
          </div>
        {canWrite && (
          <>
            {/* Gruppe 2 – primäre Aktion: Dokument hinzufügen */}
            <div className="flex items-center flex-wrap">
              <Button size="sm" onClick={handleAddDocuments} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Dokument hinzufügen
              </Button>
            </div>
            {/* Gruppe 3 – Lifecycle: Archivieren */}
            <div className="flex items-center flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={handleToggleArchive}
                disabled={setAkteHistorisch.isPending}
                className={akte.historisch ? 'gap-1.5 border-primary text-primary' : 'gap-1.5'}
                title={akte.historisch ? 'Historisch-Markierung entfernen' : 'Als historisch archivieren'}
              >
                <Archive className="h-3.5 w-3.5" />
                {akte.historisch ? 'Historisch' : 'Archivieren'}
              </Button>
            </div>
            {/* Gruppe 4 – destruktiv: Löschen */}
            <div className="flex items-center flex-wrap">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setShowDeleteDialog(true)}
                className="gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Akte löschen
              </Button>
            </div>
          </>
        )}
        </div>

        {/* Metadata Card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-base font-semibold flex items-center gap-3 flex-wrap">
                <span className="font-mono text-lg font-bold tabular-nums leading-6">{akteid}</span>
                {akte.historisch && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Archive className="h-3 w-3" />
                    Archiviert
                  </Badge>
                )}
              </CardTitle>
              {/* KI-Button: nur ab 2 Dokumenten und mit Schreibrechten */}
              {canWrite && dokOrder.length >= 2 && (
                <button
                  disabled={kiVorschlag.isPending}
                  onClick={() => {
                    setKiError(null);
                    kiVorschlag.mutate(akteid, {
                      onSuccess: (vorschlag) => {
                        if (vorschlag.betreff) updateAkte.mutate({ akteid, data: { betreff: vorschlag.betreff } });
                        if (vorschlag.beschreibung) updateAkte.mutate({ akteid, data: { beschreibung: vorschlag.beschreibung } });
                        if (vorschlag.schlagwoerter?.length) updateAkte.mutate({ akteid, data: { schlagwoerter: vorschlag.schlagwoerter } });
                      },
                      onError: (err) => setKiError(err.message || 'KI-Vorschlag fehlgeschlagen'),
                    });
                  }}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold
                    bg-gradient-to-r from-violet-500 via-purple-500 to-cyan-500
                    text-white shadow-md hover:shadow-lg hover:opacity-90
                    disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200
                    hover:from-violet-400 hover:via-purple-400 hover:to-cyan-400"
                  title="KI-Vorschlag für Metadaten generieren"
                >
                  {kiVorschlag.isPending ? (
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  KI
                </button>
              )}
            </div>
          </CardHeader>
          {kiError && (
            <div className="mx-4 mb-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-1.5 text-xs text-destructive flex items-center justify-between">
              {kiError}
              <button onClick={() => setKiError(null)} className="ml-2 opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>
            </div>
          )}
          <CardContent className="space-y-4">
            <EditableField
              label="Betreff"
              value={akte.betreff}
              onSave={(v) => handleUpdateField('betreff', v)}
              highlight
            />
            <EditableField
              label="Beschreibung"
              value={akte.beschreibung}
              onSave={(v) => handleUpdateField('beschreibung', v)}
              multiline
            />
            <TagEditor
              tags={akte.schlagwoerter}
              onSave={(v) => handleUpdateField('schlagwoerter', v)}
            />
            <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/40">
              <div>
                <label className="text-xs text-muted-foreground font-medium">Angelegt</label>
                <p className="text-sm mt-0.5">{formatDate(akte.created_at)}</p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground font-medium">Aktualisiert</label>
                <p className="text-sm mt-0.5">{formatDate(akte.updated_at)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notiz */}
        <NoteSection
          notiz={akte.notiz}
          onSave={(notiz) => updateAkte.mutate({ akteid, data: { notiz } })}
          isPending={updateAkte.isPending}
        />

        {/* Wiedervorlagen */}
        <WiedervorlageSection akteid={akteid} />

        {/* Documents list */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Dokumente ({dokOrder.length})
              {dokOrder.length > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  {/* Sort toggle */}
                  <div className="flex items-center bg-muted rounded-full p-0.5 text-xs shrink-0">
                    <button
                      onClick={() => handleDokSortChange('custom')}
                      className={`px-2.5 py-0.5 rounded-full transition-all ${
                        dokSortMode === 'custom'
                          ? 'bg-background shadow text-foreground font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Eigene
                    </button>
                    <button
                      onClick={() => handleDokSortChange('briefdatum')}
                      className={`px-2.5 py-0.5 rounded-full transition-all ${
                        dokSortMode === 'briefdatum'
                          ? 'bg-background shadow text-foreground font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Briefdatum
                    </button>
                  </div>
                  <button
                    onClick={() => { setExportPhase('scope'); setExportScope(null); setShowExportDialog(true); }}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-all"
                    title="Dokumente dieser Akte exportieren"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export
                  </button>
                </div>
              )}
            </CardTitle>
            {/* Selection mode toolbar */}
            {selectionMode && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <Badge className="bg-primary/10 text-primary border-primary/30">Auswahlmodus</Badge>
                <span className="text-muted-foreground text-xs">
                  {selectedExportIds.size > 0
                    ? <>{selectedExportIds.size} ausgewählt</>
                    : 'Zeilen anklicken zum Auswählen'}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => { setExportScope('selection'); setExportPhase('format'); setShowExportDialog(true); }}
                    disabled={selectedExportIds.size === 0}
                    className="gap-1.5 h-7 px-2.5 text-xs"
                  >
                    <Download className="h-3 w-3" />
                    Exportieren ({selectedExportIds.size})
                  </Button>
                  <button
                    onClick={() => { setSelectionMode(false); setSelectedExportIds(new Set()); }}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    title="Auswahlmodus beenden"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {dokOrder.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-sm">
                Noch keine Dokumente in dieser Akte.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="w-[80px]">ID</TableHead>
                    <TableHead className="w-[90px]">Datum</TableHead>
                    <TableHead className="w-[110px]">Typ</TableHead>
                    <TableHead>Betreff</TableHead>
                    <TableHead className="w-[100px] text-right">Betrag</TableHead>
                    <TableHead className="w-[70px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayDocs.map((dok, idx) => (
                    <DraggableDocRow
                      key={dok.postid}
                      dok={dok}
                      index={idx}
                      akteid={akteid}
                      onDragStart={handleDragStart}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                      onShowPdf={handleShowPdf}
                      onViewDoc={handleViewDoc}
                      onRemove={setRemovingPostId}
                      selectionMode={selectionMode}
                      isSelected={selectedExportIds.has(dok.postid)}
                      onToggleSelect={handleToggleExportSelect}
                      isDragDisabled={dokSortMode === 'briefdatum'}
                    />
                  ))}
                  {(() => {
                    const rechnungen = dokOrder.filter(d => d.betrag != null);
                    if (rechnungen.length === 0) return null;
                    const total = rechnungen.reduce((sum, d) => sum + parseFloat(d.betrag), 0);
                    return (
                      <TableRow className="border-t-2 font-semibold bg-muted/30">
                        <TableCell colSpan={5} className="text-right text-sm pr-4">Gesamtsumme</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(total)}</TableCell>
                        <TableCell />
                      </TableRow>
                    );
                  })()}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Archive Dialog */}
      <Dialog open={!!archiveDialog} onOpenChange={(o) => { if (!o) setArchiveDialog(null); }}>
        <DialogTitle>
          {archiveDialog?.historisch ? 'Akte archivieren?' : 'Historisch-Markierung entfernen?'}
        </DialogTitle>
        <DialogDescription>
          {archiveDialog?.historisch
            ? `Die Akte „${akte.betreff}" wird als historisch archiviert. Es gibt ${archiveDialog.betroffeneDoks} Dokument${archiveDialog.betroffeneDoks !== 1 ? 'e' : ''} in dieser Akte, die noch nicht historisch sind.`
            : `Die historisch-Markierung der Akte „${akte.betreff}" wird entfernt. Es gibt ${archiveDialog?.betroffeneDoks} Dokument${archiveDialog?.betroffeneDoks !== 1 ? 'e' : ''} in dieser Akte, die noch historisch markiert sind.`
          }
        </DialogDescription>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            id="archive-also-docs"
            checked={archiveAlsoDocs}
            onChange={(e) => setArchiveAlsoDocs(e.target.checked)}
            className="h-4 w-4 rounded border border-input"
          />
          <label htmlFor="archive-also-docs" className="text-sm cursor-pointer">
            {archiveDialog?.historisch
              ? 'Auch alle Dokumente archivieren'
              : 'Historisch-Markierung auch bei allen Dokumenten entfernen'}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setArchiveDialog(null)}>Abbrechen</Button>
          <Button onClick={handleArchiveConfirm} disabled={setAkteHistorisch.isPending}>
            {setAkteHistorisch.isPending ? 'Wird gespeichert…' : 'Bestätigen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogTitle>Akte endgültig löschen?</DialogTitle>
        <DialogDescription>
          Die Akte <span className="font-semibold">„{akte.betreff}"</span> wird unwiderruflich gelöscht.
          Die enthaltenen Dokumente bleiben erhalten, nur die Verknüpfungen werden aufgelöst.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteAkteMutation.isPending}>
            {deleteAkteMutation.isPending ? 'Wird gelöscht…' : 'Endgültig löschen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Remove Document Confirmation Dialog */}
      <Dialog open={!!removingPostId} onOpenChange={() => setRemovingPostId(null)}>
        <DialogTitle>Dokument aus Akte entfernen?</DialogTitle>
        <DialogDescription>
          <span className="font-mono font-semibold">{removingPostId}</span> wird aus dieser Akte
          entfernt. Das Dokument selbst wird nicht gelöscht.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRemovingPostId(null)}>Abbrechen</Button>
          <Button onClick={handleRemoveConfirm} disabled={removeDocMutation.isPending}>
            {removeDocMutation.isPending ? 'Wird entfernt…' : 'Entfernen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Aktenwahlmodus Insert Confirmation */}
      <Dialog open={confirmInsertDialog} onOpenChange={setConfirmInsertDialog}>
        <DialogTitle>Dokument in Akte einfügen?</DialogTitle>
        <DialogDescription>
          Soll <span className="font-mono font-semibold">{aktenwahlPostId}</span> in die Akte
          <span className="font-semibold"> „{akte.betreff}"</span> eingefügt werden?
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmInsertDialog(false)}>Abbrechen</Button>
          <Button onClick={handleInsertDocument} disabled={addDocMutation.isPending}>
            {addDocMutation.isPending ? 'Wird eingefügt…' : 'Einfügen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Export Dialog */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => { if (!isExporting) setShowExportDialog(false); }}
        phase={exportPhase}
        pageCount={dokOrder.length}
        totalCount={dokOrder.length}
        selectionCount={selectedExportIds.size}
        exportCount={exportScope === 'selection' ? selectedExportIds.size : dokOrder.length}
        allowPageScope={false}
        isAkte
        onScopeChosen={handleExportScopeChosen}
        onExport={handleExport}
        isExporting={isExporting}
        exportProgress={exportProgress}
      />
    </div>
  );
}

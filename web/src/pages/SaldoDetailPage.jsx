import { useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  useSaldoDetail, useUpdateSaldo, useAddBuchung, useEditBuchung,
  useDeleteBuchung, useAddQuelle, useEditQuelle, useDeleteQuelle, useTestSQL,
} from '@/hooks/useSalden';
import { api } from '@/api/client';
import { usePerPage } from '@/hooks/usePerPage';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Pagination } from '@/components/ui/Pagination';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import {
  ArrowLeft, Plus, Pencil, Trash2, Database, Play,
  TrendingUp, TrendingDown, AlertTriangle, ExternalLink, Save, X, Lock,
} from 'lucide-react';
import { renderRichText } from '@/lib/richText';

// ── Inline-editable saldo title + description ──────────────────────────────────
function SaldoHeader({ saldo, onUpdate }) {
  const [editName, setEditName] = useState(false);
  const [editBeschr, setEditBeschr] = useState(false);
  const [name, setName] = useState(saldo.name);
  const [beschreibung, setBeschreibung] = useState(saldo.beschreibung || '');
  const { canWrite } = useAuth();

  const saveName = () => {
    if (name.trim() && name !== saldo.name) {
      onUpdate({ name: name.trim() });
    }
    setEditName(false);
  };
  const saveBeschr = () => {
    if (beschreibung !== (saldo.beschreibung || '')) {
      onUpdate({ beschreibung: beschreibung || null });
    }
    setEditBeschr(false);
  };

  const val = parseFloat(saldo.aktueller_saldo) || 0;
  const isPositive = val >= 0;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {editName ? (
            <div className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveName()}
                autoFocus className="text-2xl font-bold h-10" />
              <Button size="icon" variant="ghost" onClick={saveName}><Save className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" onClick={() => { setEditName(false); setName(saldo.name); }}><X className="h-4 w-4" /></Button>
            </div>
          ) : (
            <GlowHeading>
              {canWrite ? (
                <span className="cursor-pointer" onClick={() => setEditName(true)} title="Klicken zum Bearbeiten">
                  {saldo.name}
                </span>
              ) : saldo.name}
            </GlowHeading>
          )}

          {editBeschr ? (
            <div className="flex items-start gap-2 mt-1">
              <textarea
                value={beschreibung}
                onChange={(e) => setBeschreibung(e.target.value)}
                autoFocus
                className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <Button size="icon" variant="ghost" onClick={saveBeschr}><Save className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" onClick={() => { setEditBeschr(false); setBeschreibung(saldo.beschreibung || ''); }}><X className="h-4 w-4" /></Button>
            </div>
          ) : (
            <p
              className={`text-muted-foreground mt-1${canWrite ? ' cursor-pointer hover:text-foreground transition-colors' : ''}`}
              onClick={canWrite ? () => setEditBeschr(true) : undefined}
              title={canWrite ? 'Klicken zum Bearbeiten' : undefined}
            >
              {saldo.beschreibung || (canWrite ? 'Keine Beschreibung – klicken zum Hinzufügen' : '')}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end flex-shrink-0">
          <span className="text-sm text-muted-foreground">Aktueller Saldo</span>
          <span className={`text-3xl font-bold tabular-nums ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatCurrency(val)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Manual booking form dialog ─────────────────────────────────────────────────
function BuchungDialog({ open, onOpenChange, initial, onSubmit, isPending }) {
  const d = new Date();
  const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [datum, setDatum] = useState((initial?.datum ?? '').slice(0, 10) || todayStr);
  const [zweck, setZweck] = useState(initial?.zweck || '');
  const [betrag, setBetrag] = useState(initial?.betrag != null ? String(initial.betrag) : '');
  const [saldoArt, setSaldoArt] = useState(initial?.saldo_art || 'positiv');

  const handleSubmit = () => {
    if (!datum || !zweck.trim() || !betrag) return;
    onSubmit({ datum, zweck: zweck.trim(), betrag: parseFloat(betrag), saldo_art: saldoArt });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle>{initial ? 'Buchung bearbeiten' : 'Neue manuelle Buchung'}</DialogTitle>
      <DialogDescription>
        {initial ? 'Änderungen sind nur 24h nach Erstellung möglich.' : 'Neuen Posten zum Saldo hinzufügen.'}
      </DialogDescription>
      <div className="mt-4 space-y-3">
        <div>
          <label className="text-sm font-medium">Datum *</label>
          <Input type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
        </div>
        <div>
          <label className="text-sm font-medium">Zweck / Betreff *</label>
          <Input value={zweck} onChange={(e) => setZweck(e.target.value)}
            placeholder="z. B. Überweisung auf Familienkonto" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Betrag (€) *</label>
            <Input type="number" step="0.01" min="0" value={betrag}
              onChange={(e) => setBetrag(e.target.value)} placeholder="0,00" />
          </div>
          <div>
            <label className="text-sm font-medium">Saldo-Art *</label>
            <Select value={saldoArt} onChange={(e) => setSaldoArt(e.target.value)}>
              <option value="positiv">Positiv (+)</option>
              <option value="negativ">Negativ (−)</option>
            </Select>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button>
        <Button onClick={handleSubmit} disabled={!datum || !zweck.trim() || !betrag || isPending}>
          {isPending ? 'Speichere…' : initial ? 'Speichern' : 'Hinzufügen'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── SQL source form dialog ────────────────────────────────────────────────────
function QuelleDialog({ open, onOpenChange, initial, onSubmit, isPending }) {
  const [name, setName] = useState(initial?.name || '');
  const [beschreibung, setBeschreibung] = useState(initial?.beschreibung || '');
  const [sql, setSql] = useState(initial?.buchungen_sql || '');
  const [saldoArt, setSaldoArt] = useState(initial?.saldo_art || 'positiv');
  const [postid, setPostid] = useState(initial?.postid || '');

  const testMutation = useTestSQL();
  const [testResult, setTestResult] = useState(null);

  const handleTest = async () => {
    setTestResult(null);
    try {
      const res = await testMutation.mutateAsync(sql);
      setTestResult({ ok: true, data: res.data, count: res.count });
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    }
  };

  const handleSubmit = () => {
    if (!name.trim() || !sql.trim()) return;
    onSubmit({
      name: name.trim(),
      beschreibung: beschreibung || null,
      buchungen_sql: sql.trim(),
      saldo_art: saldoArt,
      postid: postid || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <div className="max-w-xl">
        <DialogTitle>{initial ? 'SQL-Quelle aktualisieren' : 'Neue SQL-Quelle'}</DialogTitle>
        <DialogDescription>
          Das SQL muss Spalten zurückgeben: datum, zweck, betrag, postid (optional).
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium">Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Erstattungen Jane" />
          </div>
          <div>
            <label className="text-sm font-medium">Beschreibung</label>
            <Input value={beschreibung} onChange={(e) => setBeschreibung(e.target.value)}
              placeholder="Optionale Erläuterung…" />
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Nur für Entwickler: Dieses Feature ist bewusst nicht in der Nutzerdoku beschrieben. Du
              brauchst Datenbank- und SQL-Kenntnisse, um das Statement selbst zu schreiben; ein
              fehlerhaftes Statement führt zu falschen Salden.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium">PostID (Dokument)</label>
            <Input value={postid} onChange={(e) => setPostid(e.target.value)}
              placeholder="P000123" pattern="^P\d{6}$" />
            <p className="text-xs text-muted-foreground mt-1">Optional. Nur relevant, wenn die Quelle an genau ein Dokument gebunden ist.</p>
          </div>
          <div>
            <label className="text-sm font-medium">Saldo-Art *</label>
            <Select value={saldoArt} onChange={(e) => setSaldoArt(e.target.value)}>
              <option value="positiv">Positiv (+)</option>
              <option value="negativ">Negativ (−)</option>
            </Select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">SQL-Statement *</label>
              <Button variant="outline" size="sm" onClick={handleTest}
                disabled={!sql.trim() || testMutation.isPending} className="h-6 text-xs">
                <Play className="h-3 w-3 mr-1" />
                {testMutation.isPending ? 'Teste…' : 'Testen'}
              </Button>
            </div>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder={`SELECT eb.bescheiddatum AS datum,\n       'Erstattung' AS zweck,\n       ep.erstattungsbetrag AS betrag,\n       eb.postid\nFROM postbuch.erstattungsbescheid_einzelposition ep\nJOIN postbuch.erstattungsbescheid eb ON eb.postid = ep.postid\nWHERE ep.behandelte_person = 'Jane'`}
              className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono shadow-sm min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/40"
            />
          </div>

          {/* Test result preview */}
          {testResult && (
            <div className={`rounded-lg border p-3 text-xs ${testResult.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
              {testResult.ok ? (
                <>
                  <p className="font-medium text-emerald-700 mb-1">✓ {testResult.count} Zeile{testResult.count !== 1 ? 'n' : ''} zurückgegeben</p>
                  {testResult.data.length > 0 && (
                    <div className="overflow-auto max-h-[150px]">
                      <table className="w-full text-xs">
                        <thead>
                          <tr>
                            {Object.keys(testResult.data[0]).map(k => (
                              <th key={k} className="text-left px-1 py-0.5 font-medium text-emerald-800 border-b border-emerald-200">{k}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {testResult.data.slice(0, 10).map((row, i) => (
                            <tr key={i}>
                              {Object.values(row).map((v, j) => (
                                <td key={j} className="px-1 py-0.5 text-emerald-900">{v != null ? String(v) : '–'}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {testResult.count > 10 && (
                        <p className="text-emerald-600 mt-1 italic">…und {testResult.count - 10} weitere</p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-red-700">✗ {testResult.error}</p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || !sql.trim() || isPending}>
            {isPending ? 'Speichere…' : initial ? 'Aktualisieren' : 'Hinzufügen'}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

// ── Main detail page ──────────────────────────────────────────────────────────
export default function SaldoDetailPage() {
  const { canWrite, isAdmin } = useAuth();
  const { id } = useParams();
  const saldoId = parseInt(id, 10);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, isLoading, error } = useSaldoDetail(id);
  // Admin-only-Endpunkt, aber diese Seite ist ohnehin nur für isAdmin sichtbar
  // (siehe unten) — der Aufruf schlägt für Nicht-Admins serverseitig fehl.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), enabled: isAdmin });
  const quellenErlaubt = settings?.salden_quellen_aktiv?.value === true;
  const updateMutation = useUpdateSaldo();
  const addBuchungMutation = useAddBuchung();
  const editBuchungMutation = useEditBuchung();
  const deleteBuchungMutation = useDeleteBuchung();
  const addQuelleMutation = useAddQuelle();
  const editQuelleMutation = useEditQuelle();
  const deleteQuelleMutation = useDeleteQuelle();

  const [perPageRaw, setPerPage] = usePerPage();
  // 'auto' is the default – resolve to a sensible number for simple table pagination
  const perPage = typeof perPageRaw === 'number' ? perPageRaw : 50;
  const urlPage = parseInt(searchParams.get('page') || '1', 10);
  const [page, setPageState] = useState(urlPage);

  const [showBuchungDialog, setShowBuchungDialog] = useState(false);
  const [editingBuchung, setEditingBuchung] = useState(null);
  const [showQuelleDialog, setShowQuelleDialog] = useState(false);
  const [editingQuelle, setEditingQuelle] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const handlePageChange = (p) => {
    setPageState(p);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (p <= 1) next.delete('page');
      else next.set('page', String(p));
      return next;
    }, { replace: true });
  };

  const handlePerPageChange = (value) => {
    setPerPage(value);
    handlePageChange(1);
  };

  const handleUpdate = useCallback((fields) => {
    updateMutation.mutate({ id, data: fields });
  }, [updateMutation, id]);

  const handleAddBuchung = async (buchungData) => {
    await addBuchungMutation.mutateAsync({ saldoId: id, data: buchungData });
    setShowBuchungDialog(false);
  };

  const handleEditBuchung = async (buchungData) => {
    await editBuchungMutation.mutateAsync({ saldoId: id, buchungId: editingBuchung.buchung_id, data: buchungData });
    setEditingBuchung(null);
  };

  const handleDeleteBuchung = async () => {
    if (!deleteConfirm) return;
    await deleteBuchungMutation.mutateAsync({ saldoId: id, buchungId: deleteConfirm.buchung_id });
    setDeleteConfirm(null);
  };

  const handleAddQuelle = async (quelleData) => {
    await addQuelleMutation.mutateAsync({ saldoId: id, data: quelleData });
    setShowQuelleDialog(false);
  };

  const handleEditQuelle = async (quelleData) => {
    await editQuelleMutation.mutateAsync({ saldoId: id, quelleId: editingQuelle.quelle_id, data: quelleData });
    setEditingQuelle(null);
    setShowQuelleDialog(false);
  };

  const handleDeleteQuelle = async (quelle) => {
    await deleteQuelleMutation.mutateAsync({ saldoId: id, quelleId: quelle.quelle_id });
  };

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const { saldo, quellen, buchungen } = data;

  const total = buchungen.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);
  const pagedBuchungen = buchungen.slice((safePage - 1) * perPage, safePage * perPage);

  const showPagination = total > perPage;

  const paginationProps = {
    page: safePage,
    totalPages,
    perPage,
    perPageRaw,
    total,
    onPageChange: handlePageChange,
    onPerPageChange: handlePerPageChange,
  };

  const is24hEditable = (createdAt) => {
    return (Date.now() - new Date(createdAt).getTime()) <= 24 * 60 * 60 * 1000;
  };

  const fromPath = location.pathname + location.search;

  return (
    <div className="p-6 lg:p-8 space-y-5">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={() => navigate('/analyse/salden')}
        className="text-muted-foreground hover:text-foreground -ml-2">
        <ArrowLeft className="h-4 w-4 mr-1" />
        Zurück zu Salden
      </Button>

      {/* Header */}
      <SaldoHeader saldo={saldo} onUpdate={handleUpdate} />

      {/* SQL Sources section */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              Datenquellen ({quellen.length})
              <Badge variant="outline" className="border-amber-400 text-amber-700 font-normal">
                Nur für Entwickler
              </Badge>
            </CardTitle>
            {isAdmin && (
              quellenErlaubt ? (
                <Button size="sm" variant="outline" onClick={() => { setEditingQuelle(null); setShowQuelleDialog(true); }}>
                  <Plus className="h-3 w-3 mr-1" />
                  Quelle
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled
                  title="SQL-Quellen sind deaktiviert (Einstellungen → Allgemein)">
                  <Lock className="h-3 w-3 mr-1" />
                  Quelle
                </Button>
              )
            )}
          </div>
        </CardHeader>
        <CardContent>
          {quellen.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              Keine SQL-Quellen definiert. Salden funktionieren ohne sie – Buchungen trägst du
              unten von Hand ein.
            </p>
          ) : (
            <div className="space-y-2">
              {quellen.map((q) => (
                <div key={q.quelle_id} className="flex items-start justify-between gap-3 p-3 rounded-lg border bg-muted/20">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{q.name}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${q.saldo_art === 'positiv' ? 'text-emerald-700 border-emerald-300' : 'text-red-700 border-red-300'}`}
                      >
                        {q.saldo_art === 'positiv' ? '+' : '−'}
                      </Badge>
                      {q.postid && (
                        <Badge variant="secondary" className="text-[10px] font-mono">{q.postid}</Badge>
                      )}
                    </div>
                    {q.beschreibung && <p className="text-xs text-muted-foreground mt-0.5">{q.beschreibung}</p>}
                    <pre className="text-[10px] font-mono text-muted-foreground mt-1 max-h-[60px] overflow-auto whitespace-pre-wrap break-all bg-muted/40 rounded px-2 py-1">
                      {q.buchungen_sql}
                    </pre>
                  </div>
                  {isAdmin && (
                    <div className="flex gap-1 flex-shrink-0">
                      {!quellenErlaubt ? (
                        <Button size="icon" variant="ghost" className="h-7 w-7" disabled
                          title="SQL-Quellen sind deaktiviert (Einstellungen → Allgemein)">
                          <Lock className="h-3 w-3" />
                        </Button>
                      ) : (
                        <Button size="icon" variant="ghost" className="h-7 w-7"
                          onClick={() => { setEditingQuelle(q); setShowQuelleDialog(true); }}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500 hover:text-red-700 hover:bg-red-50"
                        onClick={() => handleDeleteQuelle(q)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bookings section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Alle Buchungen ({total})</h2>
          {canWrite && (
            <Button size="sm" onClick={() => { setEditingBuchung(null); setShowBuchungDialog(true); }}>
              <Plus className="h-3 w-3 mr-1" />
              Manuelle Buchung
            </Button>
          )}
        </div>

        {total === 0 ? (
          <EmptyState title="Keine Buchungen" description="Trage unten eine Buchung von Hand ein." />
        ) : (
          <>
            {showPagination && <Pagination {...paginationProps} />}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Datum</TableHead>
                  <TableHead>Zweck</TableHead>
                  <TableHead className="w-[100px]">Quelle</TableHead>
                  <TableHead className="w-[80px]">Dokument</TableHead>
                  <TableHead className="text-right w-[120px]">Betrag</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedBuchungen.map((b, idx) => {
                  const isManuell = b.quelle_typ === 'manuell';
                  const canEdit = isManuell && b.created_at && is24hEditable(b.created_at);

                  return (
                    <TableRow key={`${b.quelle_typ}-${b.buchung_id || idx}`} className={b.error ? 'bg-red-50' : ''}>
                      <TableCell className="whitespace-nowrap text-sm">{formatDate(b.datum)}</TableCell>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-1.5">
                          {b.error && <AlertTriangle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />}
                          <span className={b.error ? 'text-red-700' : ''}>{renderRichText(b.zweck, navigate, fromPath)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {isManuell ? (
                          <Badge variant="secondary" className="text-[10px]">Manuell</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]" title={b.quelle_name}>{b.quelle_name}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {b.postid ? (
                          <span
                            className="text-xs font-mono text-primary cursor-pointer hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/postbuch/${b.postid}`, { state: { from: fromPath } });
                            }}
                          >
                            {b.postid}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 text-xs">–</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={`font-mono text-sm font-medium ${b.saldo_art === 'positiv' ? 'text-emerald-600' : 'text-red-600'}`}>
                          {b.saldo_art === 'positiv' ? '+' : '−'}{formatCurrency(Math.abs(b.betrag))}
                        </span>
                      </TableCell>
                      <TableCell>
                        {canWrite && canEdit && (
                          <div className="flex gap-0.5">
                            <Button size="icon" variant="ghost" className="h-6 w-6"
                              onClick={() => setEditingBuchung(b)} title="Bearbeiten (24h)">
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500 hover:text-red-700"
                              onClick={() => setDeleteConfirm(b)} title="Löschen (24h)">
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {showPagination && <Pagination {...paginationProps} />}
          </>
        )}
      </div>

      {/* Dialogs */}
      {showBuchungDialog && (
        <BuchungDialog
          open={showBuchungDialog}
          onOpenChange={setShowBuchungDialog}
          onSubmit={handleAddBuchung}
          isPending={addBuchungMutation.isPending}
        />
      )}

      {editingBuchung && (
        <BuchungDialog
          open={!!editingBuchung}
          onOpenChange={() => setEditingBuchung(null)}
          initial={editingBuchung}
          onSubmit={handleEditBuchung}
          isPending={editBuchungMutation.isPending}
        />
      )}

      {showQuelleDialog && (
        <QuelleDialog
          key={editingQuelle ? editingQuelle.quelle_id : 'new'}
          open={showQuelleDialog}
          onOpenChange={(v) => { if (!v) { setShowQuelleDialog(false); setEditingQuelle(null); } }}
          initial={editingQuelle}
          onSubmit={editingQuelle ? handleEditQuelle : handleAddQuelle}
          isPending={editingQuelle ? editQuelleMutation.isPending : addQuelleMutation.isPending}
        />
      )}

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogTitle>Buchung löschen?</DialogTitle>
        <DialogDescription>
          „{deleteConfirm?.zweck}" vom {formatDate(deleteConfirm?.datum)} wird unwiderruflich gelöscht.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleDeleteBuchung}
            disabled={deleteBuchungMutation.isPending}>
            {deleteBuchungMutation.isPending ? 'Lösche…' : 'Löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { useWiedervorlagen, useCreateWiedervorlage, useUpdateWiedervorlage, useDeleteWiedervorlage } from '@/hooks/useWiedervorlagen';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import { CalendarClock, Plus, Check, Trash2, RotateCcw, Pencil } from 'lucide-react';

function WvStatusLabel({ wv }) {
  const d = new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()); // local midnight
  // Parse faellig_am as local midnight – new Date("YYYY-MM-DD") is UTC midnight which in
  // CET (UTC+1) becomes the previous day, causing off-by-one errors.
  const [y, mo, day] = wv.faellig_am.slice(0, 10).split('-').map(Number);
  const due = new Date(y, mo - 1, day); // local midnight
  const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

  if (wv.erledigt) {
    return <span className="text-xs font-medium text-emerald-600/60">Erledigt</span>;
  }
  if (diffDays < 0) {
    return <span className="text-xs font-bold text-red-600">Überfällig seit {Math.abs(diffDays)} {Math.abs(diffDays) === 1 ? 'Tag' : 'Tagen'}</span>;
  }
  if (diffDays === 0) {
    return <span className="text-xs font-bold text-amber-600">Heute fällig</span>;
  }
  if (diffDays <= 7) {
    return <span className="text-xs font-medium text-amber-500">In {diffDays} {diffDays === 1 ? 'Tag' : 'Tagen'}</span>;
  }
  // Far future: show rough relative time instead of duplicating the date
  const weeks = Math.round(diffDays / 7);
  const months = Math.round(diffDays / 30);
  const years = Math.round(diffDays / 365);
  let label;
  if (diffDays < 14) label = `in ${diffDays} Tagen`;
  else if (weeks < 8) label = `in ${weeks} Wochen`;
  else if (months < 18) label = `in ${months} Monaten`;
  else label = `in ${years === 1 ? 'einem Jahr' : `${years} Jahren`}`;
  return <span className="text-xs text-muted-foreground/60">{label}</span>;
}

export function WiedervorlageSection({ postid, akteid }) {
  const { canWrite } = useAuth();
  const params = postid ? { postid } : { akteid };
  const { data: wvList = [], isLoading } = useWiedervorlagen(params);
  const createWv = useCreateWiedervorlage();
  const updateWv = useUpdateWiedervorlage();
  const deleteWv = useDeleteWiedervorlage();
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [newAktion, setNewAktion] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [editDate, setEditDate] = useState('');
  const [editAktion, setEditAktion] = useState('');

  const handleCreate = async () => {
    if (!newDate || !newAktion.trim()) return;
    const created = await createWv.mutateAsync({
      postid: postid || null,
      akteid: akteid || null,
      faellig_am: newDate,
      aktion: newAktion.trim(),
    });
    const createdId = created?.wv_id ?? created?.id;
    const createdAktion = newAktion.trim();
    const createdDate = newDate;
    if (createdId != null) {
      const idHolder = { current: createdId };
      pushAction(
        `Wiedervorlage erstellt: "${createdAktion}"`,
        async () => {
          await api.wiedervorlagen.delete(idHolder.current);
          qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
        },
        async () => {
          const r = await api.wiedervorlagen.create({ postid: postid || null, akteid: akteid || null, faellig_am: createdDate, aktion: createdAktion });
          idHolder.current = r?.wv_id ?? r?.id;
          qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
        },
      );
    }
    setShowCreate(false);
    setNewDate('');
    setNewAktion('');
  };

  const handleToggleErledigt = (wv) => {
    const wasErledigt = wv.erledigt;
    updateWv.mutate(
      { id: wv.wv_id, data: { erledigt: !wasErledigt } },
      {
        onSuccess: () => {
          pushAction(
            wasErledigt ? 'Wiedervorlage als offen markiert' : 'Wiedervorlage als erledigt markiert',
            async () => {
              await api.wiedervorlagen.update(wv.wv_id, { erledigt: wasErledigt });
              qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
            },
            async () => {
              await api.wiedervorlagen.update(wv.wv_id, { erledigt: !wasErledigt });
              qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
            },
          );
        },
      },
    );
  };

  const openEdit = (wv) => {
    setEditTarget(wv);
    setEditDate(wv.faellig_am ? wv.faellig_am.slice(0, 10) : '');
    setEditAktion(wv.aktion);
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editDate || !editAktion.trim()) return;
    const oldAktion = editTarget.aktion;
    const oldDate = editTarget.faellig_am ? editTarget.faellig_am.slice(0, 10) : '';
    await updateWv.mutateAsync(
      { id: editTarget.wv_id, data: { faellig_am: editDate, aktion: editAktion.trim() } },
    );
    pushAction(
      `Wiedervorlage bearbeitet: "${editAktion.trim()}"`,
      async () => {
        await api.wiedervorlagen.update(editTarget.wv_id, { faellig_am: oldDate, aktion: oldAktion });
        qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      },
      async () => {
        await api.wiedervorlagen.update(editTarget.wv_id, { faellig_am: editDate, aktion: editAktion.trim() });
        qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      },
    );
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const wvSnapshot = { ...deleteConfirm };
    await deleteWv.mutateAsync(wvSnapshot.wv_id);
    const idHolder = { current: wvSnapshot.wv_id };
    pushAction(
      `Wiedervorlage gelöscht: "${wvSnapshot.aktion}"`,
      async () => {
        const r = await api.wiedervorlagen.create({
          postid: wvSnapshot.postid || null,
          akteid: wvSnapshot.akteid || null,
          faellig_am: wvSnapshot.faellig_am,
          aktion: wvSnapshot.aktion,
        });
        const newId = r?.wv_id ?? r?.id;
        idHolder.current = newId;
        // create() kennt keinen erledigt-Status – bei einer erledigten Wiedervorlage
        // muss das Undo den Status per separatem update() nachziehen, sonst geht er verloren.
        if (wvSnapshot.erledigt) {
          await api.wiedervorlagen.update(newId, { erledigt: true });
        }
        qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      },
      async () => {
        await api.wiedervorlagen.delete(idHolder.current);
        qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      },
    );
    setDeleteConfirm(null);
  };

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            Wiedervorlagen ({wvList.filter(w => !w.erledigt).length})
          </CardTitle>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={() => setShowCreate(true)} className="gap-1.5 h-7 text-xs">
              <Plus className="h-3 w-3" />
              Neue WV
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {wvList.length === 0 ? (
          <p className="text-sm text-muted-foreground/50 italic">Keine Wiedervorlagen</p>
        ) : (
          <div className="space-y-1.5">
            {wvList.map((wv) => (
              <div
                key={wv.wv_id}
                className={`flex items-center gap-3 px-2.5 py-2 rounded-lg border transition-colors ${
                  wv.erledigt
                    ? 'bg-emerald-50/50 border-emerald-200/50 opacity-60'
                    : wv.faellig_am.slice(0, 10) < (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })()
                      ? 'bg-red-50/50 border-red-200/60'
                      : 'border-border/50 hover:bg-primary/[0.02]'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">{formatDate(wv.faellig_am)}</span>
                    <WvStatusLabel wv={wv} />
                  </div>
                  <p className={`text-sm mt-0.5 ${wv.erledigt ? 'line-through text-muted-foreground' : ''}`}>
                    {wv.aktion}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleToggleErledigt(wv)}
                      className={`p-1 rounded transition-colors ${
                        wv.erledigt
                          ? 'text-muted-foreground hover:text-amber-600'
                          : 'text-muted-foreground hover:text-emerald-600'
                      }`}
                      title={wv.erledigt ? 'Als offen markieren' : 'Als erledigt markieren'}
                    >
                      {wv.erledigt ? <RotateCcw className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={() => openEdit(wv)}
                      className="p-1 rounded text-muted-foreground hover:text-primary transition-colors"
                      title="Wiedervorlage bearbeiten"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(wv)}
                      className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                      title="Wiedervorlage löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogTitle>Neue Wiedervorlage</DialogTitle>
        <DialogDescription>
          Wiedervorlage-Datum und Aktion festlegen.
        </DialogDescription>
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Fällig am</label>
            <Input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Aktion</label>
            <Input
              value={newAktion}
              onChange={(e) => setNewAktion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="z.B. Vertrag kündigen"
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowCreate(false)}>Abbrechen</Button>
          <Button onClick={handleCreate} disabled={!newDate || !newAktion.trim() || createWv.isPending}>
            {createWv.isPending ? 'Erstelle...' : 'Erstellen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogTitle>Wiedervorlage bearbeiten</DialogTitle>
        <DialogDescription>
          Datum und Beschreibung anpassen.
        </DialogDescription>
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Fällig am</label>
            <Input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Aktion</label>
            <Input
              value={editAktion}
              onChange={(e) => setEditAktion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); }}
              placeholder="z.B. Vertrag kündigen"
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditTarget(null)}>Abbrechen</Button>
          <Button onClick={handleSaveEdit} disabled={!editDate || !editAktion.trim() || updateWv.isPending}>
            {updateWv.isPending ? 'Speichere...' : 'Speichern'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogTitle>Wiedervorlage löschen?</DialogTitle>
        <DialogDescription>
          Die Wiedervorlage &quot;{deleteConfirm?.aktion}&quot; ({formatDate(deleteConfirm?.faellig_am)}) wird unwiderruflich gelöscht.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteWv.isPending}>
            {deleteWv.isPending ? 'Lösche...' : 'Endgültig löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

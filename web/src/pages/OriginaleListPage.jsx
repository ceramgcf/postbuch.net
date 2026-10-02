import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import * as LucideIcons from 'lucide-react';
import { Archive, ArchiveRestore, Plus, Pencil, Check, X, Trash2, FolderOpen, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { useVerbleibAblagen, useCreateVerbleibAblage, useUpdateVerbleibAblage, useArchiveVerbleibAblage, useAufloesen, useDeleteVerbleibAblage, useLoeseKategorieAuf } from '@/hooks/useVerbleibAblagen';
import { useVerbleibKategorien } from '@/hooks/useVerbleib';

const FALLBACK_ICON = LucideIcons.HelpCircle;
function KatIcon({ name, className }) {
  const Icon = LucideIcons[name] ?? FALLBACK_ICON;
  return <Icon className={className} />;
}

const FILTER_OPTS = [
  { value: 'false', label: 'Aktiv' },
  { value: 'true',  label: 'Archiviert' },
  { value: 'all',   label: 'Alle' },
];

function NewAblageRow({ kategorien, onSave, onCancel }) {
  const [kategorieId, setKategorieId] = useState('');
  const [name, setName] = useState('');
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  const activeKats = kategorien.filter((k) => !k.archived && k.id !== 1);

  function handleSave() {
    if (!kategorieId || !name.trim()) return;
    onSave({ kategorie_id: parseInt(kategorieId, 10), name: name.trim() });
  }

  return (
    <TableRow className="bg-primary/5">
      <TableCell colSpan={4} className="py-2">
        <div className="flex items-center gap-2">
          <select
            value={kategorieId}
            onChange={(e) => setKategorieId(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Obergruppe wählen…</option>
            {activeKats.map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name der Ablage"
            className="h-8 text-sm w-60"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
          />
          <Button size="sm" variant="default" onClick={handleSave} disabled={!kategorieId || !name.trim()}>
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EditableNameCell({ ablage, kategorien, onSave, onCancel }) {
  const [name, setName] = useState(ablage.name);
  const [kategorieId, setKategorieId] = useState(String(ablage.kategorie_id));
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const activeKats = kategorien.filter((k) => !k.archived && k.id !== 1);

  function handleSave() {
    const updates = {};
    if (name.trim() !== ablage.name) updates.name = name.trim();
    if (parseInt(kategorieId, 10) !== ablage.kategorie_id) updates.kategorie_id = parseInt(kategorieId, 10);
    if (Object.keys(updates).length) onSave(updates);
    else onCancel();
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={kategorieId}
        onChange={(e) => setKategorieId(e.target.value)}
        className="h-7 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {activeKats.map((k) => (
          <option key={k.id} value={k.id}>{k.name}</option>
        ))}
      </select>
      <Input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 text-sm w-48"
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
      />
      <button onClick={handleSave} className="p-1 text-primary hover:text-primary/70 transition-colors">
        <Check className="h-3.5 w-3.5" />
      </button>
      <button onClick={onCancel} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function DeleteConfirmModal({ ablage, onConfirm, onClose, isPending }) {
  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogTitle>Ablage löschen: „{ablage.name}"</DialogTitle>
      <DialogDescription>
        Diese Ablage ist leer und wird dauerhaft gelöscht. Dieser Vorgang kann nicht rückgängig gemacht werden.
      </DialogDescription>
      <DialogFooter className="mt-4">
        <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
        <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
          {isPending ? 'Wird gelöscht…' : 'Dauerhaft löschen'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AufloesModal({ target, ablagen, onConfirm, onClose }) {
  const isLoose = target.type === 'loose';
  const defaultAction = isLoose ? 'redirect' : 'kategorie';
  const [action, setAction] = useState(defaultAction);
  const [redirectId, setRedirectId] = useState('');

  const zielAblagen = ablagen.filter((a) => a.type === 'ablage' && !a.archived && a.id !== target.id);

  function handleConfirm() {
    onConfirm({
      action,
      redirectToId: action === 'redirect' ? parseInt(redirectId, 10) : undefined,
    });
  }

  const canConfirm = action !== 'redirect' || (redirectId && parseInt(redirectId, 10) > 0);

  const options = isLoose ? [
    {
      value: 'redirect',
      label: 'Zu einem Ordner zuweisen',
      desc: 'Alle Dokumente werden einem konkreten Ordner zugeordnet.',
    },
    {
      value: 'unknown',
      label: 'Verbleib auf „Unbekannt" setzen',
      desc: 'Der Verbleib aller Dokumente wird auf „Unbekannt" zurückgesetzt.',
    },
  ] : [
    {
      value: 'kategorie',
      label: 'Obergruppe beibehalten, Ablage-Zuordnung entfernen',
      desc: `Dokumente bleiben in der Kategorie „${target.kategorie_name}", aber ohne konkreten Ordner.`,
    },
    {
      value: 'unknown',
      label: 'Verbleib auf „Unbekannt" setzen',
      desc: 'Verbleib aller Dokumente wird vollständig auf „Unbekannt" zurückgesetzt.',
    },
    {
      value: 'redirect',
      label: 'Zu anderer Ablage umziehen',
      desc: 'Alle Dokumente werden einer anderen, aktiven Ablage zugeordnet.',
    },
  ];

  return (
    <Dialog open onOpenChange={() => onClose()} size="lg">
      <DialogTitle>
        {isLoose
          ? `Lose Dokumente in „${target.kategorie_name}" zuordnen`
          : `Ablage auflösen: „${target.name}"`}
      </DialogTitle>
      <DialogDescription>
        {isLoose
          ? `${target.doc_count} Dokument${target.doc_count !== 1 ? 'e haben' : ' hat'} die Kategorie „${target.kategorie_name}" ohne konkreten Ordner. Bitte neu zuordnen.`
          : `${target.doc_count} Dokument${target.doc_count !== 1 ? 'e sind' : ' ist'} dieser Ablage zugeordnet. Was soll damit passieren? Die Ablage wird danach dauerhaft gelöscht.`}
      </DialogDescription>

      <div className="mt-4 space-y-2">
        {options.map(({ value, label, desc }) => (
          <label key={value} className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5 transition-colors">
            <input
              type="radio"
              name="aufloesAction"
              value={value}
              checked={action === value}
              onChange={() => { setAction(value); if (value !== 'redirect') setRedirectId(''); }}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
              {value === 'redirect' && action === 'redirect' && (
                <select
                  value={redirectId}
                  onChange={(e) => setRedirectId(e.target.value)}
                  className="mt-2 h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring w-full"
                >
                  <option value="">Ziel-Ablage wählen…</option>
                  {zielAblagen.map((a) => (
                    <option key={a.id} value={a.id}>{a.kategorie_name} – {a.name}</option>
                  ))}
                </select>
              )}
            </div>
          </label>
        ))}
      </div>

      <DialogFooter className="mt-6">
        <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
        <Button variant="destructive" onClick={handleConfirm} disabled={!canConfirm}>
          {isLoose ? 'Zuordnen' : 'Auflösen & löschen'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export default function OriginaleListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('false');
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [aufloesTarget, setAufloesTarget] = useState(null);
  const [deleteAblage, setDeleteAblage] = useState(null);
  const [error, setError] = useState(null);

  const { data: ablagenData, isLoading } = useVerbleibAblagen({ archived: filter });
  const { data: katData } = useVerbleibKategorien();
  const ablagen = ablagenData?.data ?? [];
  const kategorien = katData?.data ?? [];

  const createAblage = useCreateVerbleibAblage();
  const updateAblage = useUpdateVerbleibAblage();
  const archiveAblage = useArchiveVerbleibAblage();
  const aufloesen = useAufloesen();
  const deleteAblageM = useDeleteVerbleibAblage();
  const loeseKategorieAuf = useLoeseKategorieAuf();

  function handleCreate(data) {
    setError(null);
    createAblage.mutate(data, {
      onSuccess: () => setNewFormOpen(false),
      onError: (err) => setError(err.message ?? 'Fehler beim Anlegen'),
    });
  }

  function handleUpdate(id, data) {
    setError(null);
    updateAblage.mutate({ id, ...data }, {
      onSuccess: () => setEditId(null),
      onError: (err) => setError(err.message ?? 'Fehler beim Speichern'),
    });
  }

  function handleArchive(id) {
    setError(null);
    archiveAblage.mutate(id, {
      onError: (err) => setError(err.message ?? 'Fehler'),
    });
  }

  function showDocuments(ablage) {
    if (ablage.type === 'loose') {
      const params = new URLSearchParams({
        verbleib_kategorie_id: String(ablage.kategorie_id),
        verbleib_ohne_ablage: 'true',
        verbleibBackTo: '/akten/originale',
        verbleibLabel: `${ablage.kategorie_name} (ohne Ordner)`,
      });
      navigate(`/postbuch?${params.toString()}`);
    } else {
      const params = new URLSearchParams({
        verbleib_ablage_id: String(ablage.id),
        verbleibBackTo: '/akten/originale',
        verbleibLabel: ablage.name,
      });
      navigate(`/postbuch?${params.toString()}`);
    }
  }

  function handleTrash(ablage) {
    setError(null);
    if (ablage.type === 'loose') {
      setAufloesTarget(ablage);
    } else if (ablage.doc_count === 0) {
      setDeleteAblage(ablage);
    } else {
      setAufloesTarget(ablage);
    }
  }

  function handleAufloesConfirm({ action, redirectToId }) {
    setError(null);
    if (aufloesTarget.type === 'loose') {
      loeseKategorieAuf.mutate(
        { kategorie_id: aufloesTarget.kategorie_id, action, redirectToId },
        {
          onSuccess: () => setAufloesTarget(null),
          onError: (err) => setError(err.message ?? 'Fehler beim Auflösen'),
        }
      );
    } else {
      aufloesen.mutate(
        { id: aufloesTarget.id, action, redirectToId },
        {
          onSuccess: () => setAufloesTarget(null),
          onError: (err) => setError(err.message ?? 'Fehler beim Auflösen'),
        }
      );
    }
  }

  function handleDeleteConfirm() {
    setError(null);
    deleteAblageM.mutate(deleteAblage.id, {
      onSuccess: () => setDeleteAblage(null),
      onError: (err) => setError(err.message ?? 'Fehler beim Löschen'),
    });
  }

  return (
    <div className="px-5 pt-4 pb-6">
      <div className="flex items-center justify-between mb-4">
        {/* Filter-Toggle */}
        <div className="flex gap-1">
          {FILTER_OPTS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-3 py-1 text-sm rounded-full border transition-colors ${
                filter === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => { setNewFormOpen(true); setEditId(null); }}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Neue Ablage
        </Button>
      </div>

      {error && (
        <div className="mb-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {isLoading ? (
        <PageLoader />
      ) : ablagen.length === 0 && !newFormOpen ? (
        <EmptyState
          icon={FolderOpen}
          title="Keine Ablagen"
          description={filter === 'false' ? 'Noch keine aktiven Ablagen angelegt.' : 'Keine Ablagen in dieser Ansicht.'}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ablage</TableHead>
              <TableHead>Dokumente</TableHead>
              <TableHead className="w-[110px]">Status</TableHead>
              <TableHead className="w-[160px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {newFormOpen && (
              <NewAblageRow
                kategorien={kategorien}
                onSave={handleCreate}
                onCancel={() => setNewFormOpen(false)}
              />
            )}
            {ablagen.map((ablage) => {
              const isLoose = ablage.type === 'loose';
              const rowKey = isLoose ? `loose-${ablage.kategorie_id}` : ablage.id;
              const canClick = isLoose || editId !== ablage.id;
              return (
                <TableRow
                  key={rowKey}
                  className={`${ablage.archived ? 'opacity-60' : ''} ${canClick ? 'cursor-pointer' : ''}`}
                  onClick={canClick ? () => showDocuments(ablage) : undefined}
                  title={canClick ? 'Dokumente anzeigen' : undefined}
                >
                  <TableCell>
                    {!isLoose && editId === ablage.id ? (
                      <EditableNameCell
                        ablage={ablage}
                        kategorien={kategorien}
                        onSave={(data) => handleUpdate(ablage.id, data)}
                        onCancel={() => setEditId(null)}
                      />
                    ) : isLoose ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1 font-medium text-sm">
                          <KatIcon name={ablage.kategorie_icon} className="h-3.5 w-3.5" />
                          {ablage.kategorie_name}
                        </span>
                        <span className="text-xs text-muted-foreground italic ml-5">ohne konkrete Zuordnung</span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-sm">{ablage.name}</span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <KatIcon name={ablage.kategorie_icon} className="h-3 w-3" />
                          {ablage.kategorie_name}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1 text-sm">
                      {ablage.doc_count}
                      {ablage.urkunden_count > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 ml-2 text-amber-600"
                          title={`${ablage.urkunden_count} Urkunde${ablage.urkunden_count !== 1 ? 'n' : ''}`}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {ablage.urkunden_count}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    {!isLoose && (ablage.archived
                      ? <Badge variant="secondary" className="text-xs">Archiviert</Badge>
                      : <Badge variant="outline" className="text-xs text-green-600 border-green-600/40">Aktiv</Badge>
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1 justify-end">
                      {!isLoose && !ablage.archived && editId !== ablage.id && (
                        <button
                          title="Bearbeiten"
                          onClick={() => { setEditId(ablage.id); setNewFormOpen(false); }}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {!isLoose && (
                        <button
                          title={ablage.archived ? 'Reaktivieren' : 'Archivieren'}
                          onClick={() => handleArchive(ablage.id)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          {ablage.archived
                            ? <ArchiveRestore className="h-3.5 w-3.5" />
                            : <Archive className="h-3.5 w-3.5" />
                          }
                        </button>
                      )}
                      {(isLoose || !ablage.archived) && (
                        <button
                          title={isLoose ? 'Dokumente neu zuordnen' : ablage.doc_count === 0 ? 'Löschen' : 'Auflösen & löschen'}
                          onClick={() => handleTrash(ablage)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {aufloesTarget && (
        <AufloesModal
          target={aufloesTarget}
          ablagen={ablagen}
          onConfirm={handleAufloesConfirm}
          onClose={() => setAufloesTarget(null)}
        />
      )}
      {deleteAblage && (
        <DeleteConfirmModal
          ablage={deleteAblage}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteAblage(null)}
          isPending={deleteAblageM.isPending}
        />
      )}
    </div>
  );
}

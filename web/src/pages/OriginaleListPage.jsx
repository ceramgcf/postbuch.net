import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import * as LucideIcons from 'lucide-react';
import { Archive, ArchiveRestore, Plus, Pencil, Check, X, Trash2, FolderOpen, ShieldCheck, FileText, Printer } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { useVerbleibAblagen, useCreateVerbleibAblage, useUpdateVerbleibAblage, useArchiveVerbleibAblage, useAufloesen, useDeleteVerbleibAblage, useLoeseKategorieAuf } from '@/hooks/useVerbleibAblagen';
import { useVerbleibKategorien } from '@/hooks/useVerbleib';
import { useDarstellung } from '@/hooks/useDarstellung';
import { KartenListe } from '@/components/listen/DataView';
import { api } from '@/api/client';
import { usePrinter } from '@/contexts/PrinterContext';
import { renderAblageLabels } from '@/lib/labelRenderer';
import { etikettIconSvg } from '@/lib/etikettIcon';
import { EtikettAuswahlDialog } from '@/components/EtikettAuswahlDialog';

const FALLBACK_ICON = LucideIcons.HelpCircle;
function KatIcon({ name, className }) {
  const Icon = LucideIcons[name] ?? FALLBACK_ICON;
  return <Icon className={className} />;
}

// Mappennummer einer Sammelmappe (S000123), wie die PostID in Monospace
function AblageNr({ nr }) {
  if (!nr) return null;
  return <span className="whitespace-nowrap font-mono">{nr}</span>;
}

const FILTER_OPTS = [
  { value: 'false', label: 'Aktiv' },
  { value: 'true',  label: 'Archiviert' },
  { value: 'all',   label: 'Alle' },
];

function NewAblageRow(props) {
  return (
    <TableRow className="bg-primary/5">
      <TableCell colSpan={5} className="py-2">
        <NewAblageForm {...props} />
      </TableCell>
    </TableRow>
  );
}

function NewAblageForm({ kategorien, onSave, onCancel }) {
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
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kategorieId}
            onChange={(e) => setKategorieId(e.target.value)}
            className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring max-sm:w-full"
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
            placeholder="Name der Sammelmappe"
            className="h-8 text-sm w-60 max-sm:w-auto max-sm:flex-1 max-sm:min-w-0"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
          />
          <Button size="sm" variant="default" onClick={handleSave} disabled={!kategorieId || !name.trim()}>
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
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
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={kategorieId}
        onChange={(e) => setKategorieId(e.target.value)}
        className="h-7 min-w-0 max-sm:w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {activeKats.map((k) => (
          <option key={k.id} value={k.id}>{k.name}</option>
        ))}
      </select>
      <Input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 text-sm w-48 max-sm:w-auto max-sm:flex-1 max-sm:min-w-0"
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
      <DialogTitle>Sammelmappe löschen: „{ablage.name}"</DialogTitle>
      <DialogDescription>
        Diese Sammelmappe ist leer und wird dauerhaft gelöscht. Dieser Vorgang kann nicht rückgängig gemacht werden.
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
      label: 'Einer Sammelmappe zuweisen',
      desc: 'Alle Dokumente werden einer konkreten Sammelmappe zugeordnet.',
    },
    {
      value: 'unknown',
      label: 'Verbleib auf „Unbekannt" setzen',
      desc: 'Der Verbleib aller Dokumente wird auf „Unbekannt" zurückgesetzt.',
    },
  ] : [
    {
      value: 'kategorie',
      label: 'Obergruppe beibehalten, Zuordnung zur Sammelmappe entfernen',
      desc: `Dokumente bleiben in der Kategorie „${target.kategorie_name}", aber ohne konkrete Sammelmappe.`,
    },
    {
      value: 'unknown',
      label: 'Verbleib auf „Unbekannt" setzen',
      desc: 'Verbleib aller Dokumente wird vollständig auf „Unbekannt" zurückgesetzt.',
    },
    {
      value: 'redirect',
      label: 'In andere Sammelmappe umziehen',
      desc: 'Alle Dokumente werden einer anderen, aktiven Sammelmappe zugeordnet.',
    },
  ];

  return (
    <Dialog open onOpenChange={() => onClose()} size="lg">
      <DialogTitle>
        {isLoose
          ? `Lose Dokumente in „${target.kategorie_name}" zuordnen`
          : `Sammelmappe auflösen: „${target.name}"`}
      </DialogTitle>
      <DialogDescription>
        {isLoose
          ? `${target.doc_count} Dokument${target.doc_count !== 1 ? 'e haben' : ' hat'} die Kategorie „${target.kategorie_name}" ohne konkrete Sammelmappe. Bitte neu zuordnen.`
          : `${target.doc_count} Dokument${target.doc_count !== 1 ? 'e sind' : ' ist'} dieser Sammelmappe zugeordnet. Was soll damit passieren? Die Sammelmappe wird danach dauerhaft gelöscht.`}
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
                  <option value="">Ziel-Sammelmappe wählen…</option>
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
  const { istMobil } = useDarstellung();
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
  const { printOrDownload, isPrinting } = usePrinter();
  const { data: appSettings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    staleTime: 5 * 60 * 1000,
  });

  const [druckAuswahl, setDruckAuswahl] = useState(null);

  // Zwei Etiketten: technisches (Nummer + QR) und Titel mit großem
  // Kategoriesymbol. Strichstärke 2 hält das Symbol in voller Etikettenhöhe
  // kräftig, ohne dass Details zulaufen. Welche Teile gedruckt werden, fragt
  // der Auswahldialog ab.
  async function handlePrint(ablage) {
    setError(null);
    try {
      const [technisch, titel] = await renderAblageLabels(ablage, {
        iconSvg: etikettIconSvg(ablage.kategorie_icon, { strokeWidth: 2 }),
        instanceName: appSettings?.instance_name?.value?.trim() ?? '',
      });
      setDruckAuswahl({
        ablageid: ablage.ablageid,
        etiketten: [
          { canvas: technisch, name: 'Nummer mit QR-Code' },
          { canvas: titel, name: 'Titel mit Kategoriesymbol' },
        ],
      });
    } catch (err) {
      setError(err.message ?? 'Etiketten konnten nicht erstellt werden');
    }
  }

  async function druckeAuswahl(canvases) {
    const { ablageid } = druckAuswahl;
    setDruckAuswahl(null);
    try {
      await printOrDownload(canvases, ablageid);
    } catch (err) {
      setError(err.message ?? 'Etiketten konnten nicht gedruckt werden');
    }
  }

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
        verbleibLabel: `${ablage.kategorie_name} (ohne Sammelmappe)`,
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

  const zeilenKey = (ablage) => (ablage.type === 'loose' ? `loose-${ablage.kategorie_id}` : ablage.id);

  function nameZelle(ablage) {
    const isLoose = ablage.type === 'loose';
    if (!isLoose && editId === ablage.id) {
      return (
        <EditableNameCell
          ablage={ablage}
          kategorien={kategorien}
          onSave={(data) => handleUpdate(ablage.id, data)}
          onCancel={() => setEditId(null)}
        />
      );
    }
    return isLoose ? (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1 font-medium text-sm">
          <KatIcon name={ablage.kategorie_icon} className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{ablage.kategorie_name}</span>
        </span>
        <span className="text-xs text-muted-foreground italic ml-5">ohne konkrete Zuordnung</span>
      </div>
    ) : (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-sm">{ablage.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <KatIcon name={ablage.kategorie_icon} className="h-3 w-3 shrink-0" />
          <span className="truncate">{ablage.kategorie_name}</span>
        </span>
      </div>
    );
  }

  function anzahlZelle(ablage) {
    return (
      <span className="inline-flex items-center gap-1 text-sm whitespace-nowrap" title="Dokumente">
        {istMobil && <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
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
    );
  }

  function statusZelle(ablage) {
    if (ablage.type === 'loose') return null;
    return ablage.archived
      ? <Badge variant="secondary" className="text-xs">Archiviert</Badge>
      : <Badge variant="outline" className="text-xs text-green-600 border-green-600/40">Aktiv</Badge>;
  }

  function aktionenZelle(ablage) {
    const isLoose = ablage.type === 'loose';
    const knopf = istMobil ? 'p-2 -m-0.5' : 'p-1.5';
    const icon = istMobil ? 'h-4 w-4' : 'h-3.5 w-3.5';
    return (
      <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
        {!isLoose && (
          <button
            title="Etiketten drucken"
            onClick={() => handlePrint(ablage)}
            disabled={isPrinting}
            className={`${knopf} rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50`}
          >
            <Printer className={icon} />
          </button>
        )}
        {!isLoose && !ablage.archived && editId !== ablage.id && (
          <button
            title="Bearbeiten"
            onClick={() => { setEditId(ablage.id); setNewFormOpen(false); }}
            className={`${knopf} rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors`}
          >
            <Pencil className={icon} />
          </button>
        )}
        {!isLoose && (
          <button
            title={ablage.archived ? 'Reaktivieren' : 'Archivieren'}
            onClick={() => handleArchive(ablage.id)}
            className={`${knopf} rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors`}
          >
            {ablage.archived
              ? <ArchiveRestore className={icon} />
              : <Archive className={icon} />
            }
          </button>
        )}
        {(isLoose || !ablage.archived) && (
          <button
            title={isLoose ? 'Dokumente neu zuordnen' : ablage.doc_count === 0 ? 'Löschen' : 'Auflösen & löschen'}
            onClick={() => handleTrash(ablage)}
            className={`${knopf} rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors`}
          >
            <Trash2 className={icon} />
          </button>
        )}
      </div>
    );
  }

  // Mobil: Karten in drei Zeilen – oben Nummer · Obergruppe und die Anzahlen,
  // dann der Name, unten Status und Aktionen. Bearbeiten öffnet das Formular
  // in der Karte selbst (ohne Klick-Weiterleitung).
  const mobilSpalten = [
    { key: 'ablageid', mobil: 'meta', zelle: (a) => a.ablageid && <AblageNr nr={a.ablageid} /> },
    { key: 'kategorie', mobil: 'meta', zelle: (a) => (
      a.type === 'loose'
        ? <span className="italic">ohne konkrete Zuordnung</span>
        : <span className="flex min-w-0 items-center gap-1"><KatIcon name={a.kategorie_icon} className="h-3 w-3 shrink-0" /><span className="truncate">{a.kategorie_name}</span></span>
    ) },
    { key: 'name', mobil: 'titel', zelle: (a) => {
      if (a.type === 'loose') {
        return <span className="flex min-w-0 items-center gap-1.5"><KatIcon name={a.kategorie_icon} className="h-4 w-4 shrink-0" /><span className="truncate">{a.kategorie_name}</span></span>;
      }
      return editId === a.id
        ? <div className="whitespace-normal font-normal" onClick={(e) => e.stopPropagation()}>{nameZelle(a)}</div>
        : a.name;
    } },
    { key: 'anzahl', mobil: 'rechts', zelle: anzahlZelle },
    { key: 'status', mobil: 'badges', zelle: statusZelle },
    { key: 'aktionen', mobil: 'aktion', zelle: aktionenZelle },
  ];

  return (
    <div className="px-5 pt-4 pb-6 max-sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
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
        <Button size="sm" onClick={() => { setNewFormOpen(true); setEditId(null); }} title="Neue Sammelmappe">
          <Plus className="h-3.5 w-3.5 mr-1.5 max-sm:mr-0" />
          <span className="max-sm:sr-only">Neue Sammelmappe</span>
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
          title="Keine Sammelmappen"
          description={filter === 'false' ? 'Noch keine aktiven Sammelmappen angelegt.' : 'Keine Sammelmappen in dieser Ansicht.'}
        />
      ) : istMobil ? (
        <div className="space-y-2">
          {newFormOpen && (
            <div className="rounded-2xl border border-primary/40 bg-primary/5 px-3.5 py-3">
              <NewAblageForm
                kategorien={kategorien}
                onSave={handleCreate}
                onCancel={() => setNewFormOpen(false)}
              />
            </div>
          )}
          <KartenListe
            spalten={mobilSpalten}
            daten={ablagen.map((a) => ({ ...a, _key: zeilenKey(a) }))}
            zeilenKey="_key"
            onZeile={(a) => { if (a.type === 'loose' || editId !== a.id) showDocuments(a); }}
            zeilenKlasse={(a) => (a.archived ? 'opacity-60' : '')}
            leerText="Keine Sammelmappen in dieser Ansicht."
          />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[96px]">ID</TableHead>
              <TableHead>Sammelmappe</TableHead>
              <TableHead>Dokumente</TableHead>
              <TableHead className="w-[110px]">Status</TableHead>
              <TableHead className="w-[190px]" />
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
              const canClick = ablage.type === 'loose' || editId !== ablage.id;
              return (
                <TableRow
                  key={zeilenKey(ablage)}
                  className={`${ablage.archived ? 'opacity-60' : ''} ${canClick ? 'cursor-pointer' : ''}`}
                  onClick={canClick ? () => showDocuments(ablage) : undefined}
                  title={canClick ? 'Dokumente anzeigen' : undefined}
                >
                  <TableCell className="text-sm text-muted-foreground"><AblageNr nr={ablage.ablageid} /></TableCell>
                  <TableCell>{nameZelle(ablage)}</TableCell>
                  <TableCell>{anzahlZelle(ablage)}</TableCell>
                  <TableCell>{statusZelle(ablage)}</TableCell>
                  <TableCell>{aktionenZelle(ablage)}</TableCell>
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

      {druckAuswahl && (
        <EtikettAuswahlDialog
          etiketten={druckAuswahl.etiketten}
          onDrucken={druckeAuswahl}
          onAbbrechen={() => setDruckAuswahl(null)}
        />
      )}
    </div>
  );
}

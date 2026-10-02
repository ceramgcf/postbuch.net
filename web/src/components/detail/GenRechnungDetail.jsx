import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { formatDate, formatCurrency, formatIban } from '@/lib/utils';
import { Pencil, Check, X, Trash2, AlertTriangle } from 'lucide-react';
import { useMarkPaid, useUpdateGenRechnung, useDeleteGenRechnungsblock } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { CopyableField } from './CopyableField';
import { GiroCode } from './GiroCode';
import { useAuth } from '@/hooks/useAuth';
import { DisputeAction, DisputeStatus } from './DisputeField';
import { InvalidateRechnungAction } from './InvalidateRechnungAction';

// Dokumenttypen, bei denen der Rechnungsblock zwingend erforderlich ist
const PFLICHTTYPEN = ['rechnung', 'kaufbeleg'];

function BezahldatumField({ postid, bezahlt_am }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { mutate: markPaid, mutateAsync: markPaidAsync, isPending } = useMarkPaid();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  function startEdit() {
    setDraft(bezahlt_am ? bezahlt_am.split('T')[0] : '');
    setEditing(true);
  }
  function save() {
    const oldDate = bezahlt_am ? bezahlt_am.split('T')[0] : null;
    const newDate = draft || null;
    markPaid({ postid, date: newDate }, {
      onSuccess: () => {
        setEditing(false);
        pushAction('Bezahldatum geändert', () => markPaidAsync({ postid, date: oldDate }), () => markPaidAsync({ postid, date: newDate }));
      },
    });
  }
  function remove() {
    const oldDate = bezahlt_am ? bezahlt_am.split('T')[0] : null;
    markPaid({ postid, date: null }, {
      onSuccess: () => {
        setEditing(false);
        pushAction('Als offen markiert', () => markPaidAsync({ postid, date: oldDate }), () => markPaidAsync({ postid, date: null }));
      },
    });
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <dt className="text-muted-foreground">Bezahlt am</dt>
        {!editing && canWrite && (
          <button onClick={startEdit} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title="Bezahldatum bearbeiten">
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <Input type="date" value={draft} onChange={e => setDraft(e.target.value)} className="h-7 text-sm w-[160px]" />
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={isPending} className="h-6 px-2.5 text-xs gap-1">
              <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" />Abbrechen
            </Button>
            <Button variant="ghost" size="sm" onClick={remove} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-destructive/60 hover:text-destructive ml-auto" title="Als offen markieren">
              <Trash2 className="h-3 w-3" />Entfernen
            </Button>
          </div>
        </div>
      ) : (
        <dd className="font-medium">
          {bezahlt_am
            ? <span className="text-green-600">{formatDate(bezahlt_am)}</span>
            : <span className="text-amber-600">Offen</span>
          }
        </dd>
      )}
    </div>
  );
}

/**
 * Inline-Editor für ein Feld der generischen Rechnung.
 */
function EditableField({
  label, value, postid, field,
  type = 'text',
  format,
  mono = false,
  emphasized = false,
  placeholder,
  inputClassName,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { mutate, mutateAsync, isPending } = useUpdateGenRechnung();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  function startEdit() {
    if (type === 'date') {
      setDraft(value ? String(value).split('T')[0] : '');
    } else if (type === 'number') {
      setDraft(value != null && value !== '' ? String(value) : '');
    } else {
      setDraft(value != null ? String(value) : '');
    }
    setEditing(true);
  }

  function commit(payload) {
    const oldPayload = value === null || value === undefined || value === '' ? null : String(value);
    mutate({ postid, [field]: payload }, {
      onSuccess: () => {
        setEditing(false);
        pushAction(
          `${label} geändert`,
          () => mutateAsync({ postid, [field]: oldPayload }),
          () => mutateAsync({ postid, [field]: payload }),
        );
      },
    });
  }

  function save() {
    let payload;
    if (type === 'number') {
      const trimmed = draft.trim();
      payload = trimmed === '' ? null : trimmed.replace(',', '.');
    } else {
      payload = draft.trim() === '' ? null : draft;
    }
    commit(payload);
  }

  function clear() {
    commit(null);
  }

  const displayValue = (() => {
    if (value === null || value === undefined || value === '') return '–';
    if (format) return format(value) ?? '–';
    return String(value);
  })();

  const displayClass = [
    'font-medium',
    mono ? 'font-mono text-xs' : '',
    emphasized ? 'text-lg' : '',
  ].filter(Boolean).join(' ');

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <dt className="text-muted-foreground">{label}</dt>
        {!editing && canWrite && (
          <button onClick={startEdit} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title={`${label} bearbeiten`}>
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <Input
            type={type === 'number' ? 'text' : type}
            inputMode={type === 'number' ? 'decimal' : undefined}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={placeholder}
            className={`h-7 text-sm ${inputClassName || (type === 'date' ? 'w-[160px]' : 'w-full max-w-[260px]')}`}
            autoFocus
          />
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={isPending} className="h-6 px-2.5 text-xs gap-1">
              <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" />Abbrechen
            </Button>
            {value != null && value !== '' && (
              <Button variant="ghost" size="sm" onClick={clear} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-destructive/60 hover:text-destructive ml-auto" title="Wert leeren">
                <Trash2 className="h-3 w-3" />Leeren
              </Button>
            )}
          </div>
        </div>
      ) : (
        <dd className={displayClass}>{displayValue}</dd>
      )}
    </div>
  );
}

export function GenRechnungDetail({ data, art }) {
  const { canWrite } = useAuth();
  const { mutate: deleteBlock, isPending: isDeleting } = useDeleteGenRechnungsblock();
  const { clearHistory } = useUndoHistory();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (!data) return null;

  // Bei Pflichttypen hängt der Block an der Dokumentart: dort ist nicht Löschen
  // der Weg, sondern die Invalidierung (Umschaltung auf Korrespondenz + Reprocess).
  const istPflichttyp = PFLICHTTYPEN.includes(art);
  const canDelete = canWrite && !istPflichttyp;

  function handleDelete() {
    deleteBlock(data.postid, {
      onSuccess: () => {
        setShowDeleteConfirm(false);
        clearHistory();
      },
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base">Rechnungsdetails</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <DisputeAction postid={data.postid} gesamtbetrag={data.gesamtbetrag} bestritten_betrag={data.bestritten_betrag} />
              {istPflichttyp && <InvalidateRechnungAction postid={data.postid} />}
              {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                onClick={() => setShowDeleteConfirm(true)}
                title="Rechnungsblock löschen"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Rechnungsblock löschen
              </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <EditableField
              label="Absender"
              postid={data.postid}
              field="absender"
              value={data.absender}
              type="text"
            />
            <EditableField
              label="Re-Nr."
              postid={data.postid}
              field="re_nr"
              value={data.re_nr}
              type="text"
              mono
            />
            <EditableField
              label="Rechnungsdatum"
              postid={data.postid}
              field="rechnungsdatum"
              value={data.rechnungsdatum}
              type="date"
              format={formatDate}
            />
            <EditableField
              label="Fälligkeit"
              postid={data.postid}
              field="faelligkeit"
              value={data.faelligkeit}
              type="date"
              format={formatDate}
            />
            <EditableField
              label="Gesamtbetrag"
              postid={data.postid}
              field="gesamtbetrag"
              value={data.gesamtbetrag}
              type="number"
              format={formatCurrency}
              emphasized
            />
            <BezahldatumField postid={data.postid} bezahlt_am={data.bezahlt_am} />
            <DisputeStatus gesamtbetrag={data.gesamtbetrag} bestritten_betrag={data.bestritten_betrag} />
            <EditableField
              label="IBAN"
              postid={data.postid}
              field="iban"
              value={data.iban}
              type="text"
              format={formatIban}
              mono
            />
            <EditableField
              label="Zahlungsempfänger"
              postid={data.postid}
              field="kontoinhaber"
              value={data.kontoinhaber}
              type="text"
            />
            <div className="col-span-2">
              <EditableField
                label="Verwendungszweck"
                postid={data.postid}
                field="verwendungszweck"
                value={data.verwendungszweck}
                type="text"
                inputClassName="w-full max-w-full"
              />
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Zahlung – nur bei offenen Rechnungen */}
      {!data.bezahlt_am && Number(data.gesamtbetrag || 0) > Number(data.bestritten_betrag || 0) && (data.iban || data.kontoinhaber || data.absender) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Zahlung</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-6 items-start">
              <dl className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <CopyableField
                  label="Zahlungsempfänger"
                  value={data.kontoinhaber || data.absender}
                  highlight
                />
                <CopyableField
                  label="IBAN"
                  value={formatIban(data.iban)}
                  copyValue={data.iban}
                  mono
                  highlight
                />
                <CopyableField
                  label="Betrag"
                  value={data.gesamtbetrag
                    ? (parseFloat(data.gesamtbetrag) - parseFloat(data.bestritten_betrag || 0)).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : null}
                  highlight
                />
                {data.verwendungszweck && (
                  <CopyableField
                    label="Verwendungszweck"
                    value={data.verwendungszweck}
                    className="sm:col-span-2"
                    highlight
                  />
                )}
              </dl>
              <GiroCode
                iban={data.iban}
                name={data.kontoinhaber || data.absender}
                amount={parseFloat(data.gesamtbetrag) - parseFloat(data.bestritten_betrag || 0)}
                reference={data.verwendungszweck}
                size={150}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bestätigungsdialog: Rechnungsblock löschen */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />
          Rechnungsblock unwiderruflich löschen?
        </DialogTitle>
        <DialogDescription className="mt-2 space-y-2">
          <p>
            Der Rechnungsblock dieses Dokuments wird <strong>dauerhaft gelöscht</strong>.
            Diese Aktion kann <strong>nicht rückgängig gemacht</strong> werden.
          </p>
          <p>
            Soll der Rechnungsblock später wieder angelegt werden, muss das Dokument
            erneut verarbeitet werden (Wiederverarbeitung).
          </p>
          <p>Der gesamte Undo-Verlauf wird dabei gelöscht.</p>
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting ? 'Wird gelöscht…' : 'Endgültig löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

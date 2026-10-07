import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate, formatCurrency, formatIban } from '@/lib/utils';
import { Pencil, Check, X, Trash2 } from 'lucide-react';
import { useUpdateHandwerker } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { CopyableField } from './CopyableField';
import { GiroCode } from './GiroCode';
import { ZahlungField, offenerRestbetrag } from './ZahlungField';
import { useAuth } from '@/hooks/useAuth';
import { DisputeStatus } from './DisputeField';
import { RechnungMenu, ErsetzungHinweis } from './RechnungMenu';

/**
 * Inline-Editor für ein Feld der Handwerkerrechnung.
 * type: 'text' | 'date' | 'number' | 'textarea'
 * format: optionale Anzeige-Formatierungsfunktion (z.B. formatDate, formatCurrency)
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
  const { mutate, mutateAsync, isPending, error, reset } = useUpdateHandwerker();
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
    reset();
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
          {type === 'textarea' ? (
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder={placeholder}
              className={`w-full p-2 border rounded-md text-sm min-h-[64px] resize-y ${inputClassName || ''}`}
              autoFocus
            />
          ) : (
            <Input
              type={type === 'number' ? 'text' : type}
              inputMode={type === 'number' ? 'decimal' : undefined}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder={placeholder}
              className={`h-7 text-sm ${inputClassName || (type === 'date' ? 'w-[160px]' : 'w-full max-w-[260px]')}`}
              autoFocus
            />
          )}
          {error && <p className="text-xs text-destructive">{error.message}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
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

/**
 * § 35a EStG: Der Nutzer schließt eine Rechnung ausdrücklich von der
 * steuerlichen Auswertung aus. Die KI setzt das nie; Standard ist „relevant".
 */
function Estg35aAusschluss({ postid, value }) {
  const { mutate, mutateAsync, isPending, error } = useUpdateHandwerker();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();
  const ausgeschlossen = value === true;

  function setze(neu) {
    mutate({ postid, estg35a_irrelevant: neu }, {
      onSuccess: () => pushAction(
        neu ? '§ 35a-Ausschluss gesetzt' : '§ 35a-Ausschluss aufgehoben',
        () => mutateAsync({ postid, estg35a_irrelevant: !neu }),
        () => mutateAsync({ postid, estg35a_irrelevant: neu }),
      ),
    });
  }

  return (
    <div>
      <label className={`inline-flex items-start gap-2 ${canWrite ? 'cursor-pointer' : 'cursor-default'}`}>
        <input
          type="checkbox"
          checked={ausgeschlossen}
          disabled={!canWrite || isPending}
          onChange={(e) => setze(e.target.checked)}
          className="mt-0.5 accent-primary"
        />
        <span>
          <span className="font-medium">Für § 35a EStG nicht relevant</span>
          <span className="block text-xs text-muted-foreground">
            Schließt die Rechnung aus der Auswertung Analyse → Handwerker aus.
          </span>
        </span>
      </label>
      {error && <p className="mt-1 text-xs text-destructive">{error.message}</p>}
    </div>
  );
}

export function HandwerkerrechnungDetail({ data }) {
  if (!data) return null;

  return (
    <div className="space-y-4">
      <ErsetzungHinweis postid={data.postid} ersetzung={data.ersetzung} />
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 flex-wrap space-y-0">
          <CardTitle className="text-base">Handwerkerrechnung</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <RechnungMenu data={data} />
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <EditableField
              label="Unternehmen"
              postid={data.postid}
              field="name_unternehmen"
              value={data.name_unternehmen}
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
              label="Leistungsjahr"
              postid={data.postid}
              field="leistungsjahr"
              value={data.leistungsjahr}
              type="number"
              placeholder="z.B. 2025"
            />
            <EditableField
              label="Leistungsdatum"
              postid={data.postid}
              field="leistungsdatum"
              value={data.leistungsdatum}
              type="text"
              placeholder="z.B. 2025 oder 03/2025"
            />
            <EditableField
              label="Fälligkeit"
              postid={data.postid}
              field="faelligkeit"
              value={data.faelligkeit}
              type="date"
              format={formatDate}
            />
            <ZahlungField postid={data.postid} bezahlt_am={data.bezahlt_am} zahlung={data.zahlung} ersetzung={data.ersetzung} />
            <DisputeStatus gesamtbetrag={data.gesamtbetrag} bestritten_betrag={data.bestritten_betrag} offen={offenerRestbetrag(data)} />
            <EditableField
              label="Gesamtbetrag"
              postid={data.postid}
              field="gesamtbetrag"
              value={data.gesamtbetrag}
              type="number"
              format={formatCurrency}
              emphasized
            />
            <EditableField
              label="Lohnkosten"
              postid={data.postid}
              field="lohnkosten"
              value={data.lohnkosten}
              type="number"
              format={formatCurrency}
            />
            <EditableField
              label="IBAN"
              postid={data.postid}
              field="iban"
              value={data.iban}
              type="text"
              format={formatIban}
              mono
            />
            <div className="col-span-2 md:col-span-3">
              <EditableField
                label="Leistung"
                postid={data.postid}
                field="leistung"
                value={data.leistung}
                type="textarea"
                inputClassName="w-full"
              />
            </div>
            <div className="col-span-2 md:col-span-3">
              <EditableField
                label="Verwendungszweck"
                postid={data.postid}
                field="verwendungszweck"
                value={data.verwendungszweck}
                type="text"
                inputClassName="w-full max-w-full"
              />
            </div>
            <div className="col-span-2 md:col-span-3">
              <Estg35aAusschluss postid={data.postid} value={data.estg35a_irrelevant} />
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Zahlung – nur bei offenen Rechnungen */}
      {offenerRestbetrag(data) > 0 && (data.iban || data.name_unternehmen) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Zahlung</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-6 items-start">
              <dl className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <CopyableField
                  label="Zahlungsempfänger"
                  value={data.name_unternehmen}
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
                  value={offenerRestbetrag(data).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                name={data.name_unternehmen}
                amount={offenerRestbetrag(data)}
                reference={data.verwendungszweck}
                size={150}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { formatDate, formatCurrency, formatIban, cn } from '@/lib/utils';
import { Pencil, Check, X, Trash2, Plus } from 'lucide-react';
import { useCollectingPerioden, useSetArztrechnungAP, useSetArztrechnungSatz, useUpdateArztrechnung, useSetErstattungZuordnung } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { CopyableField } from './CopyableField';
import { GiroCode } from './GiroCode';
import { ZahlungField, offenerRestbetrag } from './ZahlungField';
import { useAuth } from '@/hooks/useAuth';
import { SymLinkButton } from './SymLinkButton';
import { ErstattungAttachDialog } from './ErstattungAttachDialog';
import { DisputeStatus } from './DisputeField';
import { RechnungMenu, ErsetzungHinweis } from './RechnungMenu';
import { rechnungToken } from '@/lib/erstattung';
import { getDokumentartMeta } from '@/components/postbuch/ArtBadge';
import { KuerzungStatusActions } from './KuerzungStatusActions';
import { ArztPositionenCard } from './ArztPositionenCard';
import { PERIODEN_STATUS_STYLE, periodenStatusLabel } from '@/lib/periodenStatus';

/**
 * Inline-Editor für ein Feld der Arztrechnung.
 * type: 'text' | 'date' | 'number'
 * format: optionale Anzeige-Formatierungsfunktion
 * options: [{ value, label }] – statt Freitext eine Auswahlliste
 */
function EditableField({
  label, value, postid, field,
  type = 'text',
  format,
  mono = false,
  emphasized = false,
  placeholder,
  inputClassName,
  options,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { mutate, mutateAsync, isPending, error, reset } = useUpdateArztrechnung();
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
          {options ? (
            <select
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="h-7 w-full max-w-[260px] rounded-md border border-input bg-background px-2 text-sm"
              autoFocus
            >
              <option value="">– keine Angabe –</option>
              {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : <Input
            type={type === 'number' ? 'text' : type}
            inputMode={type === 'number' ? 'decimal' : undefined}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={placeholder}
            className={`h-7 text-sm ${inputClassName || (type === 'date' ? 'w-[160px]' : 'w-full max-w-[260px]')}`}
            autoFocus
          />}
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
 * Status der Abrechnungsperiode, in der die Rechnung bei einem Kostenträger
 * steht. Ohne Periodenzuordnung erscheint „nicht zugeordnet", damit eine
 * vergessene Einreichung sofort auffällt.
 */
function PeriodenStatusBadge({ kostentraeger, periode, status, mitKostentraeger = false }) {
  const zugeordnet = periode != null;
  const text = zugeordnet
    ? (status ? periodenStatusLabel(status) : 'unbekannt')
    : 'nicht zugeordnet';
  const titel = zugeordnet
    ? `${kostentraeger}: Abrechnungsperiode ${periode}${status ? ` – ${periodenStatusLabel(status)}` : ''}`
    : `${kostentraeger}: keiner Abrechnungsperiode zugeordnet`;
  return (
    <Badge
      variant="outline"
      title={titel}
      className={cn(
        'text-[10px] px-1.5 py-0 font-medium',
        zugeordnet && status
          ? PERIODEN_STATUS_STYLE[status]
          : 'text-red-700 bg-red-50 border-red-200 border-dashed',
      )}
    >
      {mitKostentraeger && `${kostentraeger} `}
      {mitKostentraeger && zugeordnet && `#${periode} `}
      {text}
    </Badge>
  );
}

/**
 * Zeigt eine AP-Zelle (PKV oder Beihilfe) mit optionalem Lösen- (🗑️) oder Zuordnen-Button (+).
 * Lösen: nur sichtbar wenn die zugeordnete Periode noch COLLECTING ist.
 * Zuordnen: nur sichtbar wenn keine Periode zugeordnet ist und eine COLLECTING-Periode existiert.
 */
function APField({ label, kostentraeger, periode, status, versichert, person, collectingPerioden, setAPMutation, onConfirmDetach, postid }) {
  const periodeNum = periode != null ? Number(periode) : null;
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  function assign(targetPeriode) {
    setAPMutation.mutate(
      { postid, kostentraeger, periode: targetPeriode },
      {
        onSuccess: () => {
          pushAction(
            `${label} zugeordnet`,
            () => setAPMutation.mutateAsync({ postid, kostentraeger, periode: null }),
            () => setAPMutation.mutateAsync({ postid, kostentraeger, periode: targetPeriode }),
          );
        },
      }
    );
  }

  // Ist die aktuell zugeordnete Periode noch COLLECTING?
  const isCurrentCollecting = periodeNum !== null &&
    collectingPerioden.some(p =>
      p.person === person && p.kostentraeger === kostentraeger && Number(p.periode) === periodeNum
    );

  // Gibt es eine COLLECTING-Periode zum Zuordnen (wenn keine zugeordnet)?
  const collectingTarget = periodeNum === null
    ? collectingPerioden.find(p => p.person === person && p.kostentraeger === kostentraeger)
    : null;

  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium flex items-center gap-1.5">
        <span>{periodeNum ?? '–'}</span>
        {(periodeNum !== null || versichert) && (
          <PeriodenStatusBadge kostentraeger={kostentraeger} periode={periodeNum} status={status} />
        )}
        {isCurrentCollecting && canWrite && (
          <button
            title={`Von ${label} lösen`}
            onClick={() => onConfirmDetach({ kostentraeger, periode: periodeNum, postid })}
            disabled={setAPMutation.isPending}
            className="text-destructive/40 hover:text-destructive transition-colors disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {collectingTarget && canWrite && (
          <button
            title={`${label} ${collectingTarget.periode} zuordnen`}
            onClick={() => assign(Number(collectingTarget.periode))}
            disabled={setAPMutation.isPending}
            className="text-green-600/60 hover:text-green-600 transition-colors disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </dd>
    </div>
  );
}

/**
 * Editierbarer Erstattungssatz für eine Rechnung (Override der Personenkonfiguration).
 * NULL = kein Override, Personensatz greift → wird grau als Platzhalter angezeigt.
 */
function SatzOverrideField({ label, field, overrideValue, personSatz, postid }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { mutate: setSatz, mutateAsync: setSatzAsync, isPending } = useSetArztrechnungSatz();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  function startEdit() {
    setDraft(overrideValue != null ? String(overrideValue) : '');
    setEditing(true);
  }

  function commit(val) {
    const oldVal = overrideValue != null ? parseFloat(overrideValue) : null;
    setSatz({ postid, [field]: val }, {
      onSuccess: () => {
        setEditing(false);
        pushAction(
          `${label} geändert`,
          () => setSatzAsync({ postid, [field]: oldVal }),
          () => setSatzAsync({ postid, [field]: val }),
        );
      },
    });
  }

  function save() {
    commit(draft.trim() === '' ? null : parseFloat(draft));
  }

  function remove() {
    commit(null);
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <dt className="text-muted-foreground">{label}</dt>
        {!editing && canWrite && (
          <button onClick={startEdit} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title="Satz anpassen">
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Input
              type="number" min="0" max="100" step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={personSatz != null ? String(personSatz) : '–'}
              className="h-7 text-sm w-[120px]"
              autoFocus
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Leer lassen = Standardsatz aus Personenkonfiguration
            {personSatz != null ? ` (${personSatz} %)` : ' (nicht konfiguriert)'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={isPending} className="h-6 px-2.5 text-xs gap-1">
              <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" />Abbrechen
            </Button>
            {overrideValue != null && (
              <Button variant="ghost" size="sm" onClick={remove} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-destructive/60 hover:text-destructive ml-auto" title="Override entfernen">
                <Trash2 className="h-3 w-3" />Entfernen
              </Button>
            )}
          </div>
        </div>
      ) : (
        <dd className="font-medium">
          {overrideValue != null
            ? <span>{parseFloat(overrideValue).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %</span>
            : <span className="text-muted-foreground/50 text-sm">{personSatz != null ? `${parseFloat(personSatz).toLocaleString('de-DE', { maximumFractionDigits: 2 })} % (Standard)` : '–'}</span>
          }
        </dd>
      )}
    </div>
  );
}

/**
 * Editierbarer Einreichungsbereich (Feature "Rechnungsteile"): welcher
 * Seitenbereich des gespeicherten Originals beim Zusammenstellen von
 * Kostenträger-Einreichungen verwendet wird. Zwei Ganzzahlfelder statt eines
 * "von-bis"-Strings — vermeidet Parserprobleme beim Bearbeiten.
 */
function EinreichungSeitenField({ postid, von, bis }) {
  const [editing, setEditing] = useState(false);
  const [draftVon, setDraftVon] = useState('');
  const [draftBis, setDraftBis] = useState('');
  const { mutate, mutateAsync, isPending } = useUpdateArztrechnung();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();

  function startEdit() {
    setDraftVon(von != null ? String(von) : '');
    setDraftBis(bis != null ? String(bis) : '');
    setEditing(true);
  }

  function commit(payloadVon, payloadBis) {
    const oldVon = von ?? null;
    const oldBis = bis ?? null;
    mutate({ postid, einreichung_seite_von: payloadVon, einreichung_seite_bis: payloadBis }, {
      onSuccess: () => {
        setEditing(false);
        pushAction(
          'Einreichungsseiten geändert',
          () => mutateAsync({ postid, einreichung_seite_von: oldVon, einreichung_seite_bis: oldBis }),
          () => mutateAsync({ postid, einreichung_seite_von: payloadVon, einreichung_seite_bis: payloadBis }),
        );
      },
    });
  }

  const vonTrim = draftVon.trim();
  const bisTrim = draftBis.trim();
  const beideLeer = vonTrim === '' && bisTrim === '';
  const vonNum = parseInt(vonTrim, 10);
  const bisNum = parseInt(bisTrim, 10);
  const beideGueltig = vonTrim !== '' && bisTrim !== ''
    && Number.isInteger(vonNum) && Number.isInteger(bisNum) && vonNum >= 1 && bisNum >= vonNum;
  const gueltig = beideLeer || beideGueltig;

  function save() {
    if (!gueltig) return;
    commit(beideLeer ? null : vonNum, beideLeer ? null : bisNum);
  }

  function remove() {
    commit(null, null);
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <dt className="text-muted-foreground">Einreichungsseiten</dt>
        {!editing && canWrite && (
          <button onClick={startEdit} className="text-muted-foreground/30 hover:text-muted-foreground transition-colors" title="Einreichungsseiten bearbeiten">
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              type="number" min="1" step="1"
              value={draftVon}
              onChange={(e) => setDraftVon(e.target.value)}
              placeholder="von"
              className="h-7 text-sm w-[70px]"
              autoFocus
            />
            <span className="text-sm text-muted-foreground">–</span>
            <Input
              type="number" min="1" step="1"
              value={draftBis}
              onChange={(e) => setDraftBis(e.target.value)}
              placeholder="bis"
              className="h-7 text-sm w-[70px]"
            />
          </div>
          {!gueltig && (
            <p className="text-[11px] text-destructive">Beide Felder leer (= ganzes Dokument) oder beide gültig, "bis" ≥ "von"</p>
          )}
          <p className="text-[11px] text-muted-foreground">Leer lassen = ganzes Dokument wird eingereicht</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={isPending || !gueltig} className="h-6 px-2.5 text-xs gap-1">
              <Check className="h-3 w-3" />{isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-muted-foreground">
              <X className="h-3 w-3" />Abbrechen
            </Button>
            {(von != null || bis != null) && (
              <Button variant="ghost" size="sm" onClick={remove} disabled={isPending} className="h-6 px-2 text-xs gap-1 text-destructive/60 hover:text-destructive ml-auto" title="Auf ganzes Dokument zurücksetzen">
                <Trash2 className="h-3 w-3" />Entfernen
              </Button>
            )}
          </div>
        </div>
      ) : (
        <dd className="font-medium">
          {von != null && bis != null
            ? (von === bis ? `Seite ${von}` : `Seiten ${von}–${bis}`)
            : <span className="text-muted-foreground/50 text-sm">ganzes Dokument</span>}
        </dd>
      )}
    </div>
  );
}

export function ArztrechnungDetail({ data, istTier: istTierProp = false }) {
  const location = useLocation();
  const { data: collectingPeriodenResult } = useCollectingPerioden();
  const collectingPerioden = collectingPeriodenResult?.data ?? [];
  const setAPMutation = useSetArztrechnungAP();
  const setErstattungZuordnung = useSetErstattungZuordnung();
  const { pushAction } = useUndoHistory();
  const { canWrite } = useAuth();
  // confirmDetach: { kostentraeger, periode, postid } oder null
  const [confirmDetach, setConfirmDetach] = useState(null);
  const [attachOpen, setAttachOpen] = useState(false);
  // confirmErstattungDetach: { eb_postid, eb_subid } oder null
  const [confirmErstattungDetach, setConfirmErstattungDetach] = useState(null);
  const { data: personenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
  });

  if (!data) return null;

  // Tier-Erkennung folgt der LxD-Einordnung des Dokuments (lebensbereich),
  // nicht dem Mensch-Datensatz des Patienten – der ist bei nicht als Mensch
  // registrierten Haustieren gar nicht vorhanden.
  const istTier = istTierProp;
  const typLabel = getDokumentartMeta(String(data.typ || '').toLowerCase())?.label || data.typ || 'Arztrechnung';
  const titel = istTier ? (data.typ === 'arztrechnung' ? 'Tierarztrechnung' : `Tier-${typLabel}`) : typLabel;

  // Behandelt werden kann jeder erfasste Mensch und jedes Tier, auch ohne
  // Versicherung; Archivierte nur, wenn sie schon eingetragen sind.
  const behandeltOptionen = (personenData?.data || [])
    .filter((p) => !p.archiviert || p.kurzname === data.behandelte_person)
    .map((p) => ({ value: p.kurzname, label: p.ist_tier ? `${p.kurzname} (Tier)` : p.kurzname }));
  if (data.behandelte_person && !behandeltOptionen.some((o) => o.value === data.behandelte_person)) {
    behandeltOptionen.unshift({ value: data.behandelte_person, label: data.behandelte_person });
  }

  // Abrechnungsstatus je Kostenträger: relevant, wenn die behandelte Person
  // (oder das Tier) dort versichert ist oder die Rechnung bereits einer
  // Periode zugeordnet wurde. Tiere haben keine Beihilfe.
  const pkvRelevant = data.personen_pkv === true || data.abrechnungsperiode_pkv != null;
  const beihilfeRelevant = !istTier && (data.personen_beihilfe === true || data.abrechnungsperiode_beihilfe != null);

  // Einzelpositionen, die von einer Kürzung betroffen sind
  const affectedSubids = new Set(
    (data.erstattungen || [])
      .flatMap(eb => eb.kuerzungen || [])
      .map(k => k.arz_subid)
      .filter(id => id != null)
  );

  // Gesamtstatistik über alle Erstattungen
  const distinctKostentraeger = new Set((data.erstattungen || []).map(eb => eb.kostentraeger));
  const totalErstattet = (data.erstattungen || []).reduce(
    (sum, eb) => sum + (parseFloat(eb.erstattungsbetrag) || 0), 0
  );
  const differenz = (parseFloat(data.gesamtbetrag) || 0) - totalErstattet;

  return (
    <div className="space-y-4">
      <ErsetzungHinweis postid={data.postid} ersetzung={data.ersetzung} />
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 flex-wrap space-y-0">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            {titel}
            <span className="font-mono text-xs text-muted-foreground font-normal">{data.postid}</span>
            <SymLinkButton token={rechnungToken(data.postid)} title="Rechnungs-SymLink kopieren" />
            {pkvRelevant && (
              <PeriodenStatusBadge kostentraeger="PKV" periode={data.abrechnungsperiode_pkv} status={data.abrechnungsperiode_pkv_status} mitKostentraeger />
            )}
            {beihilfeRelevant && (
              <PeriodenStatusBadge kostentraeger="Beihilfe" periode={data.abrechnungsperiode_beihilfe} status={data.abrechnungsperiode_beihilfe_status} mitKostentraeger />
            )}
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <RechnungMenu data={data} />
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <EditableField
              label={istTier ? 'Tierarzt / Praxis' : 'Arzt'}
              postid={data.postid}
              field="name_arzt"
              value={data.name_arzt}
              type="text"
            />
            <EditableField
              label={istTier ? 'Tier' : 'Patient'}
              postid={data.postid}
              field="behandelte_person"
              value={data.behandelte_person}
              type="text"
              options={behandeltOptionen}
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
            <ZahlungField postid={data.postid} bezahlt_am={data.bezahlt_am} zahlung={data.zahlung} ersetzung={data.ersetzung} />
            <DisputeStatus gesamtbetrag={data.gesamtbetrag} bestritten_betrag={data.bestritten_betrag} offen={offenerRestbetrag(data)} />
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
            <EinreichungSeitenField
              postid={data.postid}
              von={data.einreichung_seite_von}
              bis={data.einreichung_seite_bis}
            />
            <APField
              label="AP PKV"
              kostentraeger="PKV"
              periode={data.abrechnungsperiode_pkv}
              status={data.abrechnungsperiode_pkv_status}
              versichert={pkvRelevant}
              person={data.behandelte_person}
              postid={data.postid}
              collectingPerioden={collectingPerioden}
              setAPMutation={setAPMutation}
              onConfirmDetach={setConfirmDetach}
            />
            {!istTier && <APField
              label="AP Beihilfe"
              kostentraeger="Beihilfe"
              periode={data.abrechnungsperiode_beihilfe}
              status={data.abrechnungsperiode_beihilfe_status}
              versichert={beihilfeRelevant}
              person={data.behandelte_person}
              postid={data.postid}
              collectingPerioden={collectingPerioden}
              setAPMutation={setAPMutation}
              onConfirmDetach={setConfirmDetach}
            />}
            {(data.abrechnungsperiode_pkv != null || data.pkv_satz_override != null || data.personen_pkv_satz != null) && (
              <SatzOverrideField
                label="PKV-Satz"
                field="pkv_satz_override"
                overrideValue={data.pkv_satz_override}
                personSatz={data.personen_pkv_satz}
                postid={data.postid}
              />
            )}
            {!istTier && (data.abrechnungsperiode_beihilfe != null || data.beihilfe_satz_override != null || data.personen_beihilfe_satz != null) && (
              <SatzOverrideField
                label="Beihilfe-Satz"
                field="beihilfe_satz_override"
                overrideValue={data.beihilfe_satz_override}
                personSatz={data.personen_beihilfe_satz}
                postid={data.postid}
              />
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Zahlung – nur bei offenen Rechnungen */}
      {offenerRestbetrag(data) > 0 && (data.iban || data.kontoinhaber || data.name_arzt) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Zahlung</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-6 items-start">
              <dl className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <CopyableField
                  label="Zahlungsempfänger"
                  value={data.kontoinhaber || data.name_arzt}
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
                name={data.kontoinhaber || data.name_arzt}
                amount={offenerRestbetrag(data)}
                reference={data.verwendungszweck}
                size={150}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Einzelpositionen */}
      <ArztPositionenCard
        postid={data.postid}
        positionen={data.einzelpositionen || []}
        istTier={istTier}
        affectedSubids={affectedSubids}
      />

      {/* Verknüpfte Erstattungen */}
      {(data.erstattungen?.length > 0 || canWrite) && (
        <Card>
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Erstattungen</CardTitle>
            {canWrite && (
              <Button size="sm" variant="ghost" onClick={() => setAttachOpen(true)}
                className="h-7 px-2 text-xs gap-1 text-green-600/70 hover:text-green-600">
                <Plus className="h-3.5 w-3.5" />Erstattung zuordnen
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!data.erstattungen?.length && (
              <p className="text-sm text-muted-foreground">Keine Erstattungen zugeordnet.</p>
            )}
            <div className="space-y-3">
              {(data.erstattungen || []).map((eb, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/postbuch/${eb.eb_postid}`} state={{ from: location.state?.from }} className="text-primary hover:underline font-mono text-sm">
                      {eb.eb_postid}{eb.eb_subid != null ? <span className="text-muted-foreground"> · Pos. {eb.eb_subid}</span> : null}
                    </Link>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{eb.kostentraeger}</Badge>
                      {canWrite && eb.eb_subid != null && (
                        <button
                          type="button"
                          title="Zuordnung lösen"
                          onClick={() => setConfirmErstattungDetach({ eb_postid: eb.eb_postid, eb_subid: eb.eb_subid })}
                          disabled={setErstattungZuordnung.isPending}
                          className="text-destructive/40 hover:text-destructive transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-4 text-sm flex-wrap">
                    <span>Bescheid: {formatDate(eb.bescheiddatum)}</span>
                    <span className="text-green-600">
                      Erstattet: {formatCurrency(eb.erstattungsbetrag)}
                      {(parseFloat(data.gesamtbetrag) || 0) > 0 && (
                        <span className="text-green-600/70 text-xs ml-1">
                          ({Math.round((parseFloat(eb.erstattungsbetrag) || 0) / parseFloat(data.gesamtbetrag) * 100)} %)
                        </span>
                      )}
                    </span>
                    {eb.kuerzungsbetrag > 0 && (() => {
                      const satz = eb.kostentraeger === 'Beihilfe'
                        ? (parseFloat(data.beihilfe_satz_override ?? data.personen_beihilfe_satz) || null)
                        : (parseFloat(data.pkv_satz_override ?? data.personen_pkv_satz) || null);
                      const effectiveKuerzung = satz != null
                        ? (parseFloat(eb.kuerzungsbetrag) || 0) * satz / 100
                        : (parseFloat(eb.kuerzungsbetrag) || 0);
                      return (
                        <span className="text-red-600">
                          Gekürzt: {formatCurrency(effectiveKuerzung)}
                          {satz != null && (
                            <span className="text-red-400 text-xs ml-1">({formatCurrency(eb.kuerzungsbetrag)} × {satz}%)</span>
                          )}
                        </span>
                      );
                    })()}
                  </div>
                  {eb.kuerzungen?.length > 0 && (() => {
                    const satz = eb.kostentraeger === 'Beihilfe'
                      ? (parseFloat(data.beihilfe_satz_override ?? data.personen_beihilfe_satz) || null)
                      : (parseFloat(data.pkv_satz_override ?? data.personen_pkv_satz) || null);
                    return (
                      <div className="mt-2 pl-4 border-l-2 border-red-200 space-y-1">
                        {eb.kuerzungen.map((k, j) => {
                          const effectiveBetrag = satz != null
                            ? (parseFloat(k.betrag) || 0) * satz / 100
                            : (parseFloat(k.betrag) || 0);
                          return (
                            <div key={j} className="text-sm">
                              <span className="text-red-600 font-mono">{formatCurrency(effectiveBetrag)}</span>
                              {satz != null && (
                                <span className="text-red-400 text-xs ml-1">({formatCurrency(k.betrag)} × {satz}%)</span>
                              )}
                              {' – '}
                              <span className="text-muted-foreground">{k.begruendung || 'Keine Begründung'}</span>
                              <div className="mt-1">
                                <KuerzungStatusActions
                                  ebPostid={eb.eb_postid}
                                  ebSubid={eb.eb_subid}
                                  kuerzungId={k.kuerzung_id}
                                  kostentraeger={eb.kostentraeger}
                                  gesehenAm={k.gesehen_am}
                                  pkvStatus={k.pkv_pruefung_status}
                                  pkvPeriode={k.pkv_pruefung_periode}
                                  pkvErlaeuterung={k.pkv_pruefung_erlaeuterung}
                                  arzPostid={data.postid}
                                  canWrite={canWrite}
                                  compact
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              ))}
              {distinctKostentraeger.size > 1 && (
                <div className="mt-2 pt-3 border-t space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Gesamt erstattet</span>
                    <span className="font-medium text-green-600">
                      {formatCurrency(totalErstattet)}
                      {(parseFloat(data.gesamtbetrag) || 0) > 0 && (
                        <span className="text-green-600/70 text-xs ml-1.5">
                          ({Math.round(totalErstattet / parseFloat(data.gesamtbetrag) * 100)} %)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Differenz zur Rechnungssumme</span>
                    <span className={`font-medium ${differenz > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {formatCurrency(differenz)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bestätigungsdialog: AP-Zuordnung lösen */}
      <Dialog open={!!confirmDetach} onOpenChange={() => setConfirmDetach(null)}>
        <DialogTitle>Von Abrechnungsperiode lösen?</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Dokument <span className="font-mono">{data.postid}</span> aus{' '}
          <span className="font-medium">
            AP {confirmDetach?.kostentraeger} {confirmDetach?.periode}
          </span>{' '}
          lösen? Diese Aktion kann durch erneutes Zuordnen rückgängig gemacht werden.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmDetach(null)}>Abbrechen</Button>
          <Button
            variant="destructive"
            disabled={setAPMutation.isPending}
            onClick={() => {
              if (!confirmDetach) return;
              const { postid: dPostid, kostentraeger, periode: oldPeriode } = confirmDetach;
              setAPMutation.mutate(
                { postid: dPostid, kostentraeger, periode: null },
                {
                  onSuccess: () => {
                    setConfirmDetach(null);
                    pushAction(
                      `AP ${kostentraeger} gelöst`,
                      () => setAPMutation.mutateAsync({ postid: dPostid, kostentraeger, periode: oldPeriode }),
                      () => setAPMutation.mutateAsync({ postid: dPostid, kostentraeger, periode: null }),
                    );
                  },
                }
              );
            }}
          >
            {setAPMutation.isPending ? 'Wird gelöst…' : 'Lösen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Erstattung dieser Rechnung zuordnen (Bescheid → Position) */}
      <ErstattungAttachDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        invoicePostid={data.postid}
      />

      {/* Bestätigungsdialog: Erstattungs-Zuordnung lösen */}
      <Dialog open={!!confirmErstattungDetach} onOpenChange={() => setConfirmErstattungDetach(null)}>
        <DialogTitle>Erstattungs-Zuordnung lösen?</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Position {confirmErstattungDetach?.eb_subid} von Bescheid{' '}
          <span className="font-mono">{confirmErstattungDetach?.eb_postid}</span> wird von dieser Rechnung gelöst.
          Zugehörige Kürzungen verlieren ihren Positions-Bezug.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmErstattungDetach(null)}>Abbrechen</Button>
          <Button
            variant="destructive"
            disabled={setErstattungZuordnung.isPending}
            onClick={() => {
              if (!confirmErstattungDetach) return;
              const { eb_postid, eb_subid } = confirmErstattungDetach;
              const oldArzPostid = data.postid;
              setErstattungZuordnung.mutate(
                { postid: eb_postid, subid: eb_subid, arzPostid: null },
                {
                  onSuccess: (res) => {
                    setConfirmErstattungDetach(null);
                    pushAction(
                      'Erstattungs-Zuordnung gelöst',
                      () => setErstattungZuordnung.mutateAsync({ postid: eb_postid, subid: eb_subid, arzPostid: oldArzPostid, restoreKuerzungenArzSubid: res.prev_kuerzungen_arz_subid }),
                      () => setErstattungZuordnung.mutateAsync({ postid: eb_postid, subid: eb_subid, arzPostid: null }),
                    );
                  },
                }
              );
            }}
          >
            {setErstattungZuordnung.isPending ? 'Wird gelöst…' : 'Lösen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

import { useState, useRef, useEffect } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/utils';
import { ArtBadgeEditor } from '@/components/postbuch/ArtBadgeEditor';
import { StatusBadge } from '@/components/postbuch/StatusBadge';
import { ChevronDown, ChevronUp, Pencil, Check, X, Plus, Trash2, User, Inbox, Send, Cloud, QrCode, ExternalLink } from 'lucide-react';
import { VerbleibBadge } from '@/components/detail/VerbleibBadge';
import { useUpdatePostbuch } from '@/hooks/usePostbuch';
import { useAuth } from '@/hooks/useAuth';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';

/** Erste GiroCode-/EPC-QR-Zeilen (Empfänger, Betrag) als Kurzfassung; Format
 *  siehe girocode.de – Zeile 6 = Empfänger, Zeile 8 = Betrag ("EUR12.34"). */
function girocodeSummary(inhalt) {
  const lines = (inhalt || '').split(/\r\n|\r|\n/);
  const empfaenger = lines[5]?.trim();
  const betrag = lines[7]?.trim();
  const teile = [empfaenger, betrag].filter(Boolean);
  return teile.length ? teile.join(' · ') : null;
}

/** Ein QR-Code-Eintrag: Name/Seite als Kopf, Inhalt je nach Typ verlinkt,
 *  zusammengefasst oder gekürzt+ausklappbar. Niemals der Inhalt in appLog o.ä.
 *  – hier nur die reine Anzeige, s. Plan Abschnitt 4.7. */
function QrCodeEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const inhalt = entry.inhalt || '';
  const isLink = /^https?:\/\//i.test(inhalt);
  let host = null;
  if (isLink) {
    try { host = new URL(inhalt).host; } catch { /* keine gültige URL, kein Link */ }
  }
  const summary = entry.typ === 'girocode' ? girocodeSummary(inhalt) : null;

  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
        <QrCode className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium text-foreground">{entry.name}</span>
        <span className="text-muted-foreground/50">· Seite {entry.seite}</span>
      </div>
      {isLink && host ? (
        <a
          href={inhalt}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 pl-4 text-primary hover:underline break-all"
        >
          {host}
          <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" />
        </a>
      ) : summary ? (
        <div className="pl-4 text-muted-foreground/80">
          <span>{summary}</span>
          {!open ? (
            <button onClick={() => setOpen(true)} className="ml-1.5 text-primary hover:underline">Details</button>
          ) : (
            <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-muted-foreground/70 font-mono">{inhalt}</pre>
          )}
        </div>
      ) : (
        <div className="pl-4 text-muted-foreground/70 break-all whitespace-pre-wrap">{inhalt}</div>
      )}
    </div>
  );
}

/** Fuß der Stammdaten-Karte: QR-Liste + Nachrüst-Knopf. Bewusst NICHT in der
 *  ActionBar (Plan Abschnitt 4.5) – kein Massen-Backfill, nur je Dokument. */
function QrCodesFooter({ data }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const { mutate: scan, isPending } = useMutation({
    mutationFn: () => api.postbuch.qrScan(data.postid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', data.postid] });
    },
  });

  const codes = Array.isArray(data.qr_codes) ? data.qr_codes : [];
  const wurdeGescannt = data.qr_codes !== null && data.qr_codes !== undefined;

  if (codes.length === 0 && !canWrite) return null;

  return (
    <div className="mt-4 pt-3 border-t border-border/60">
      {codes.length > 0 && (
        <div className="space-y-2 mb-2">
          {codes.map((c, i) => <QrCodeEntry key={i} entry={c} />)}
        </div>
      )}
      {canWrite && (
        wurdeGescannt ? (
          <button
            onClick={() => scan()}
            disabled={isPending}
            className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors disabled:opacity-50"
          >
            {isPending ? 'Suche…' : 'QR-Codes erneut suchen'}
          </button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => scan()}
            disabled={isPending}
            className="h-6 px-2 text-xs gap-1 text-muted-foreground"
          >
            <QrCode className="h-3 w-3" />
            {isPending ? 'Suche…' : 'QR-Codes suchen'}
          </Button>
        )
      )}
    </div>
  );
}

/** Anzeigename des Dateiablage-Backends für Tooltip/Screenreader.
 *  Der nextcloud-Adapter bedient auch ownCloud – daher der neutrale Zusatz. */
const ABLAGE_NAMEN = {
  onedrive: 'OneDrive',
  nextcloud: 'Nextcloud/ownCloud',
};

/** Icon-Link auf die Originaldatei in der Cloud-Dateiablage.
 *  Steht bewusst direkt neben der Postnummer – die Datei ist die Postnummer. */
function AblageLink({ link, backend }) {
  if (!link) return null;
  const name = ABLAGE_NAMEN[backend || 'onedrive'] || 'der Dateiablage';
  const label = `Dokument in ${name} öffnen`;
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/60 hover:text-primary hover:bg-accent transition-colors"
    >
      <Cloud className="h-4 w-4" />
    </a>
  );
}

/** Label row with an optional inline pencil icon to enter edit mode.
 *  Reads canWrite from auth context – no prop needed. */
function FieldLabel({ label, field, editingField, onEdit }) {
  const { canWrite } = useAuth();
  return (
    <div className="flex items-center gap-1.5 mb-1">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      {canWrite && editingField !== field && (
        <button
          onClick={() => onEdit(field)}
          className="text-muted-foreground/30 hover:text-muted-foreground transition-colors"
          title={`${label} bearbeiten`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Shared Save / Cancel button row */
function SaveCancelRow({ field, onSave, onCancel, onRemove, isPending, saveDisabled = false }) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (confirmRemove) {
    return (
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className="text-xs text-destructive font-medium">Wirklich entfernen?</span>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onRemove(field)}
          disabled={isPending}
          className="h-6 px-2.5 text-xs gap-1"
        >
          <Trash2 className="h-3 w-3" />
          {isPending ? 'Entferne…' : 'Ja, entfernen'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmRemove(false)}
          disabled={isPending}
          className="h-6 px-2 text-xs gap-1 text-muted-foreground"
        >
          <X className="h-3 w-3" />
          Abbrechen
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-2">
      <Button
        size="sm"
        onClick={() => onSave(field)}
        disabled={isPending || saveDisabled}
        className="h-6 px-2.5 text-xs gap-1"
      >
        <Check className="h-3 w-3" />
        {isPending ? 'Speichern…' : 'Speichern'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        disabled={isPending}
        className="h-6 px-2 text-xs gap-1 text-muted-foreground"
      >
        <X className="h-3 w-3" />
        Abbrechen
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmRemove(true)}
        disabled={isPending}
        className="h-6 px-2 text-xs gap-1 text-destructive/60 hover:text-destructive ml-auto"
        title="Feld leeren (NULL setzen)"
      >
        <Trash2 className="h-3 w-3" />
        Entfernen
      </Button>
    </div>
  );
}

export function PostbuchSection({ data }) {
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [aiModelOpen, setAiModelOpen] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [draft, setDraft] = useState('');
  const [draftTags, setDraftTags] = useState([]);
  const [newTagInput, setNewTagInput] = useState('');
  const inputRef = useRef(null);

  const { mutate: updateField, isPending } = useUpdatePostbuch();
  const { canWrite } = useAuth();
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  const { data: personenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
  });
  const personOptions = (personenData?.data || []).map((p) => ({ kurzname: p.kurzname, farbe: p.farbe }));

  const meta = Array.isArray(data.metadata) ? data.metadata[0] : data.metadata;
  const warnungen = meta?.qualityFlags?.warnungen ?? [];
  const hasWarnungen = warnungen.length > 0;

  // Focus the primary input whenever edit mode opens
  useEffect(() => {
    if (editingField && inputRef.current) {
      inputRef.current.focus();
      const type = inputRef.current.type;
      if (type !== 'date' && type !== 'time' && typeof inputRef.current.setSelectionRange === 'function') {
        const len = inputRef.current.value?.length ?? 0;
        inputRef.current.setSelectionRange(len, len);
      }
    }
  }, [editingField]);

  function startEdit(field) {
    if (!canWrite) return;
    if (field === 'schlagwoerter') {
      setDraftTags([...(data.schlagwoerter || [])]);
      setNewTagInput('');
    } else if (field === 'briefdatum') {
      // HTML date input requires YYYY-MM-DD
      setDraft(data.briefdatum ? data.briefdatum.split('T')[0] : '');
    } else if (field === 'kontakt') {
      setDraft(data.kontakt || '');
    } else if (field === 'familienmitglied') {
      setDraft(data.familienmitglied || '');
    } else {
      setDraft(data[field] || '');
    }
    setEditingField(field);
  }

  function cancelEdit() {
    setEditingField(null);
    setDraft('');
    setDraftTags([]);
    setNewTagInput('');
  }

  function saveField(field) {
    let payload;
    if (field === 'schlagwoerter') {
      payload = { schlagwoerter: draftTags };
    } else if (field === 'kontakt') {
      payload = { kontakt: draft.trim() || null };
    } else if (field === 'familienmitglied') {
      payload = { familienmitglied: draft.trim() || null };
    } else if (field === 'briefdatum') {
      payload = { briefdatum: draft || null };
    } else {
      payload = { [field]: draft.trim() || null };
    }

    // Capture old value for undo BEFORE the update
    let oldPayload;
    if (field === 'schlagwoerter') {
      oldPayload = { schlagwoerter: data.schlagwoerter || [] };
    } else if (field === 'kontakt') {
      oldPayload = { kontakt: data.kontakt || null };
    } else if (field === 'familienmitglied') {
      oldPayload = { familienmitglied: data.familienmitglied || null };
    } else if (field === 'briefdatum') {
      oldPayload = { briefdatum: data.briefdatum || null };
    } else {
      oldPayload = { [field]: data[field] ?? null };
    }

    const FIELD_LABELS = { betreff: 'Betreff', briefdatum: 'Briefdatum', kontakt: 'Kontakt', familienmitglied: 'Familienmitglied', schlagwoerter: 'Schlagwörter', notiz: 'Notiz', richtung: 'Richtung' };
    const label = FIELD_LABELS[field] || field;

    updateField(
      { postid: data.postid, data: payload },
      {
        onSuccess: () => {
          pushAction(
            `${label} geändert`,
            async () => {
              await api.postbuch.update(data.postid, oldPayload);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
            async () => {
              await api.postbuch.update(data.postid, payload);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
          );
          cancelEdit();
        },
      },
    );
  }

  function removeField(field) {
    let payload;
    if (field === 'kontakt') {
      payload = { kontakt: null };
    } else if (field === 'familienmitglied') {
      payload = { familienmitglied: null };
    } else if (field === 'schlagwoerter') {
      payload = { schlagwoerter: [] };
    } else {
      payload = { [field]: null };
    }

    // Capture old value for undo
    let oldPayload;
    if (field === 'kontakt') {
      oldPayload = { kontakt: data.kontakt || null };
    } else if (field === 'familienmitglied') {
      oldPayload = { familienmitglied: data.familienmitglied || null };
    } else if (field === 'schlagwoerter') {
      oldPayload = { schlagwoerter: data.schlagwoerter || [] };
    } else {
      oldPayload = { [field]: data[field] ?? null };
    }

    const FIELD_LABELS = { betreff: 'Betreff', briefdatum: 'Briefdatum', kontakt: 'Kontakt', familienmitglied: 'Familienmitglied', schlagwoerter: 'Schlagwörter', notiz: 'Notiz' };
    const label = FIELD_LABELS[field] || field;

    updateField(
      { postid: data.postid, data: payload },
      {
        onSuccess: () => {
          pushAction(
            `${label} entfernt`,
            async () => {
              await api.postbuch.update(data.postid, oldPayload);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
            async () => {
              await api.postbuch.update(data.postid, payload);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
          );
          cancelEdit();
        },
      },
    );
  }

  function addTag() {
    const t = newTagInput.trim();
    if (t && !draftTags.includes(t)) {
      setDraftTags((prev) => [...prev, t]);
    }
    setNewTagInput('');
    // Keep focus on the tag input
    if (inputRef.current) inputRef.current.focus();
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        {/* Kopfzeile: Postnummer steht fest, die Badge-Leiste daneben ist ein
            eigener flex-1-Container. Bricht sie um, beginnt die nächste Zeile
            am Container-Rand – also hinter der Postnummer auf Höhe des
            Cloud-Symbols, nicht am Kartenrand. Gruppierung und justify-between
            entsprechen der ActionBar weiter unten. */}
        <div className="flex items-start gap-3">
          <span className="font-mono text-lg font-bold tabular-nums leading-6 flex-shrink-0">{data.postid}</span>

          <div className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            {/* Gruppe 1 – Verbleib: Link auf die Datei in der Dateiablage + Verbleib des Originals */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <AblageLink link={data.link} backend={data.storage_backend} />
              <VerbleibBadge data={data} />
            </div>

            {/* Gruppe 2 – Einordnung: Lebensbereich × Dokumentart */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <ArtBadgeEditor
                postid={data.postid}
                currentArt={data.art}
                currentL={data.lebensbereich}
                currentD={data.dokumentart}
                onChanged={() => qc.invalidateQueries({ queryKey: ['postbuch', 'detail', data.postid] })}
              />
            </div>

            {/* Gruppe 3 – KI-Analyse: Modell und Qualität der Extraktion */}
            {(data.ai_model || data.confidence != null) && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {data.ai_model && (
                  <Badge
                    variant="outline"
                    className="text-xs font-mono tabular-nums cursor-pointer select-none flex items-center gap-1 hover:bg-accent"
                    onClick={() => setAiModelOpen((o) => !o)}
                    title="KI-Verarbeitungsdetails anzeigen"
                  >
                    {data.ai_model}
                    {aiModelOpen
                      ? <ChevronUp className="h-3 w-3 flex-shrink-0" />
                      : <ChevronDown className="h-3 w-3 flex-shrink-0" />}
                  </Badge>
                )}
                {data.confidence != null && (
                  hasWarnungen ? (
                    <Badge
                      variant="outline"
                      className="text-xs tabular-nums cursor-pointer select-none flex items-center gap-1 hover:bg-accent"
                      onClick={() => setWarningsOpen((o) => !o)}
                      title="QdE – Qualität der Extraktion. Klicken für Warnungen"
                    >
                      QdE {Math.round(data.confidence * 100)}%
                      {warningsOpen
                        ? <ChevronUp className="h-3 w-3 flex-shrink-0" />
                        : <ChevronDown className="h-3 w-3 flex-shrink-0" />}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-xs tabular-nums"
                      title="QdE – Qualität der Extraktion"
                    >
                      QdE {Math.round(data.confidence * 100)}%
                    </Badge>
                  )
                )}
              </div>
            )}

            {/* Gruppe 4 – Freigabe */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <StatusBadge status={data.status} />
            </div>
          </div>
        </div>
        {hasWarnungen && warningsOpen && (
          <div className="mt-3 overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-muted-foreground font-medium py-1 px-2 border-b border-border w-6">#</th>
                  <th className="text-left text-muted-foreground font-medium py-1 px-2 border-b border-border">Warnung</th>
                </tr>
              </thead>
              <tbody>
                {warnungen.map((w, i) => (
                  <tr key={i} className={i % 2 === 0 ? 'bg-muted/40' : ''}>
                    <td className="py-1.5 px-2 align-top text-muted-foreground">{i + 1}</td>
                    <td className="py-1.5 px-2 leading-snug break-words whitespace-normal">{w}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.ai_model && aiModelOpen && (
          <div className="mt-3 overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-muted-foreground font-medium py-1 px-2 border-b border-border">Phase</th>
                  <th className="text-left text-muted-foreground font-medium py-1 px-2 border-b border-border">Modell</th>
                  <th className="text-right text-muted-foreground font-medium py-1 px-2 border-b border-border">Input-Token</th>
                  <th className="text-right text-muted-foreground font-medium py-1 px-2 border-b border-border">Output-Token</th>
                  <th className="text-right text-muted-foreground font-medium py-1 px-2 border-b border-border">Kosten</th>
                </tr>
              </thead>
              <tbody>
                {data.ai_pre_model && (
                  <tr className="bg-muted/40">
                    <td className="py-1.5 px-2 text-muted-foreground">Vorverarbeitung</td>
                    <td className="py-1.5 px-2 font-mono">{data.ai_pre_model}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.ai_pre_tokens_in != null ? data.ai_pre_tokens_in.toLocaleString('de-DE') : '–'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.ai_pre_tokens_out != null ? data.ai_pre_tokens_out.toLocaleString('de-DE') : '–'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.ai_pre_cost_usd != null ? `${(data.ai_pre_cost_usd * 100).toFixed(2)} ¢` : '–'}</td>
                  </tr>
                )}
                <tr>
                  <td className="py-1.5 px-2 text-muted-foreground">Klassifizierung</td>
                  <td className="py-1.5 px-2 font-mono">{data.ai_model}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{data.ai_tokens_in != null ? data.ai_tokens_in.toLocaleString('de-DE') : '–'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{data.ai_tokens_out != null ? data.ai_tokens_out.toLocaleString('de-DE') : '–'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{data.ai_cost_usd != null ? `${(data.ai_cost_usd * 100).toFixed(2)} ¢` : '–'}</td>
                </tr>
                {data.erstattungsbescheid?.ai_eb_model && (
                  <tr className="bg-muted/20">
                    <td className="py-1.5 px-2 text-muted-foreground">EB-Parsing</td>
                    <td className="py-1.5 px-2 font-mono">{data.erstattungsbescheid.ai_eb_model}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.erstattungsbescheid.ai_eb_tokens_in != null ? Number(data.erstattungsbescheid.ai_eb_tokens_in).toLocaleString('de-DE') : '–'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.erstattungsbescheid.ai_eb_tokens_out != null ? Number(data.erstattungsbescheid.ai_eb_tokens_out).toLocaleString('de-DE') : '–'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.erstattungsbescheid.ai_eb_cost_usd != null ? `${(Number(data.erstattungsbescheid.ai_eb_cost_usd) * 100).toFixed(2)} ¢` : '–'}</td>
                  </tr>
                )}
                {data.erstattungsbescheid?.ai_kuerzung_model && (
                  <tr className="bg-muted/20">
                    <td className="py-1.5 px-2 text-muted-foreground">Kürzungs-Matching</td>
                    <td className="py-1.5 px-2 font-mono">{data.erstattungsbescheid.ai_kuerzung_model}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.erstattungsbescheid.ai_kuerzung_tokens_in != null ? Number(data.erstattungsbescheid.ai_kuerzung_tokens_in).toLocaleString('de-DE') : '–'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.erstattungsbescheid.ai_kuerzung_tokens_out != null ? Number(data.erstattungsbescheid.ai_kuerzung_tokens_out).toLocaleString('de-DE') : '–'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{data.erstattungsbescheid.ai_kuerzung_cost_usd != null ? `${(Number(data.erstattungsbescheid.ai_kuerzung_cost_usd) * 100).toFixed(2)} ¢` : '–'}</td>
                  </tr>
                )}
                {(data.ai_cost_usd != null || data.ai_pre_cost_usd != null) && (
                  <tr className="border-t border-border font-medium">
                    <td className="py-1.5 px-2 text-muted-foreground" colSpan={4}>Gesamt</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {((Number(data.ai_cost_usd ?? 0) + Number(data.ai_pre_cost_usd ?? 0) + Number(data.erstattungsbescheid?.ai_eb_cost_usd ?? 0) + Number(data.erstattungsbescheid?.ai_kuerzung_cost_usd ?? 0)) * 100).toFixed(2)} ¢
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardHeader>

      <CardContent>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">

          {/* ── Briefdatum ── */}
          <div>
            <FieldLabel label="Briefdatum" field="briefdatum" editingField={editingField} onEdit={startEdit} />
            {editingField === 'briefdatum' ? (
              <div>
                <input
                  ref={inputRef}
                  type="date"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                  disabled={isPending}
                  className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
                             focus-visible:border-primary/40 disabled:opacity-50"
                />
                <SaveCancelRow field="briefdatum" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="font-medium">{formatDate(data.briefdatum)}</dd>
            )}
          </div>

          {/* ── Erfassungsdatum (readonly) ── */}
          <div>
            <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Erfassungsdatum</dt>
            <dd className="font-medium">{formatDate(data.erfassungsdatum)}</dd>
          </div>

          {/* ── Richtung ── */}
          <div>
            <FieldLabel label="Richtung" field="richtung" editingField={editingField} onEdit={startEdit} />
            {editingField === 'richtung' ? (
              <div>
                <select
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                  disabled={isPending}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
                             focus-visible:border-primary/40 disabled:opacity-50"
                >
                  <option value="eingang">Eingangspost</option>
                  <option value="ausgang">Ausgangspost</option>
                </select>
                <div className="flex items-center gap-1.5 mt-2">
                  <Button
                    size="sm"
                    onClick={() => saveField('richtung')}
                    disabled={isPending}
                    className="h-6 px-2.5 text-xs gap-1"
                  >
                    <Check className="h-3 w-3" />
                    {isPending ? 'Speichern…' : 'Speichern'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelEdit}
                    disabled={isPending}
                    className="h-6 px-2 text-xs gap-1 text-muted-foreground"
                  >
                    <X className="h-3 w-3" />
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <dd className="font-medium flex items-center gap-2">
                {data.richtung === 'ausgang' ? (
                  <>
                    <Send className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Ausgangspost</span>
                  </>
                ) : (
                  <>
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Eingangspost</span>
                  </>
                )}
              </dd>
            )}
          </div>

          {/* ── Familienmitglied ── */}
          <div>
            <FieldLabel label="Familienmitglied" field="familienmitglied" editingField={editingField} onEdit={startEdit} />
            {editingField === 'familienmitglied' ? (
              <div>
                <select
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
                  disabled={isPending}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
                             focus-visible:border-primary/40 disabled:opacity-50"
                >
                  <option value="">– kein Familienmitglied –</option>
                  {personOptions.map((p) => (
                    <option key={p.kurzname} value={p.kurzname}>{p.kurzname}</option>
                  ))}
                </select>
                <SaveCancelRow field="familienmitglied" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="font-medium flex items-center gap-2">
                {data.familienmitglied ? (
                  <>
                    <span
                      className="inline-flex items-center justify-center flex-shrink-0"
                      style={{ color: data.familienmitglied_farbe || '#6b7280' }}
                      title={`${data.richtung === 'ausgang' ? 'Absender' : 'Adressat'}: ${data.familienmitglied}`}
                    >
                      <User className="h-4 w-4" fill="currentColor" stroke="none" />
                    </span>
                    <span>{data.familienmitglied}</span>
                  </>
                ) : (
                  '–'
                )}
              </dd>
            )}
          </div>

          {/* ── Kontakt ── */}
          <div>
            <FieldLabel label="Kontakt" field="kontakt" editingField={editingField} onEdit={startEdit} />
            {editingField === 'kontakt' ? (
              <div>
                <Input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveField('kontakt');
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  disabled={isPending}
                  className="h-8 text-sm"
                />
                <SaveCancelRow field="kontakt" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="font-medium">{data.kontakt || '–'}</dd>
            )}
          </div>

          {/* ── Fremdes Zeichen ── */}
          <div>
            <FieldLabel label="Fremdes Zeichen" field="fremdes_zeichen" editingField={editingField} onEdit={startEdit} />
            {editingField === 'fremdes_zeichen' ? (
              <div>
                <Input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveField('fremdes_zeichen');
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  disabled={isPending}
                  className="h-8 text-sm"
                />
                <SaveCancelRow field="fremdes_zeichen" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="font-medium">{data.fremdes_zeichen || '–'}</dd>
            )}
          </div>

          {/* ── Betreff ── */}
          <div className="col-span-2">
            <FieldLabel label="Betreff" field="betreff" editingField={editingField} onEdit={startEdit} />
            {editingField === 'betreff' ? (
              <div>
                <Input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveField('betreff');
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  disabled={isPending}
                  className="h-8 text-sm font-semibold"
                />
                <SaveCancelRow field="betreff" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="font-medium">
                {data.betreff
                  ? <span className="highlight font-semibold">{data.betreff}</span>
                  : '–'}
              </dd>
            )}
          </div>

          {/* ── Zusammenfassung ── */}
          <div className="col-span-2">
            <FieldLabel label="Zusammenfassung" field="zusammenfassung" editingField={editingField} onEdit={startEdit} />
            {editingField === 'zusammenfassung' ? (
              <div>
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveField('zusammenfassung');
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  disabled={isPending}
                  rows={4}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
                             focus-visible:border-primary/40 disabled:opacity-50 min-h-[80px]"
                />
                <div className="text-[11px] text-muted-foreground/50 mt-0.5">Strg+Enter zum Speichern · Esc zum Abbrechen</div>
                <SaveCancelRow field="zusammenfassung" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="font-medium whitespace-pre-wrap leading-relaxed">{data.zusammenfassung || '–'}</dd>
            )}
          </div>

          {/* ── Schlagwörter ── */}
          <div className="col-span-2">
            <FieldLabel label="Schlagwörter" field="schlagwoerter" editingField={editingField} onEdit={startEdit} />
            {editingField === 'schlagwoerter' ? (
              <div>
                {/* Existing tags with delete buttons */}
                <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
                  {draftTags.map((tag, i) => (
                    <Badge key={i} variant="secondary" className="text-xs flex items-center gap-1 pr-1">
                      {tag}
                      <button
                        onClick={() => setDraftTags((prev) => prev.filter((_, j) => j !== i))}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Entfernen"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                  {draftTags.length === 0 && (
                    <span className="text-xs text-muted-foreground/50 self-center">Keine Schlagwörter</span>
                  )}
                </div>
                {/* Add new tag */}
                <div className="flex gap-1.5">
                  <Input
                    ref={inputRef}
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    placeholder="Neues Schlagwort…"
                    disabled={isPending}
                    className="h-7 text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addTag}
                    disabled={!newTagInput.trim() || isPending}
                    className="h-7 px-2"
                    title="Hinzufügen"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <SaveCancelRow field="schlagwoerter" onSave={saveField} onCancel={cancelEdit} onRemove={removeField} isPending={isPending} />
              </div>
            ) : (
              <dd className="flex flex-wrap gap-1.5">
                {data.schlagwoerter?.length > 0
                  ? data.schlagwoerter.map((tag, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">{tag}</Badge>
                    ))
                  : <span className="text-muted-foreground">–</span>}
              </dd>
            )}
          </div>

        </dl>

        <QrCodesFooter data={data} />
      </CardContent>
    </Card>
  );
}

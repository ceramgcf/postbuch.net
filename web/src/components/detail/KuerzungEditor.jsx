import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import {
  useAddKuerzung, useUpdateKuerzung, useDeleteKuerzung, usePostbuchDetail,
  useSetKuerzungGesehen, useVormerkenPkvPruefung,
} from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { positionToken } from '@/lib/erstattung';
import { SymLinkButton } from './SymLinkButton';
import { KuerzungStatusActions } from './KuerzungStatusActions';

// Beschriftung einer Arztrechnung-Einzelposition für Select/Anzeige.
function positionLabel(pos) {
  const teile = [`#${pos.subid}`];
  if (pos.goa_goz_gebueh_pzn) teile.push(pos.goa_goz_gebueh_pzn);
  if (pos.leistung) teile.push(pos.leistung.length > 40 ? pos.leistung.slice(0, 40) + '…' : pos.leistung);
  let label = teile.join(' · ');
  if (pos.betrag != null) label += ` (${formatCurrency(pos.betrag)})`;
  return label;
}

// Formular-Dialog zum Anlegen/Bearbeiten einer Kürzung.
function KuerzungFormDialog({ open, onOpenChange, ebPostid, ep, kuerzung }) {
  const isEdit = !!kuerzung;
  const { mutate: add, mutateAsync: addAsync, isPending: addPending } = useAddKuerzung();
  const { mutate: update, mutateAsync: updateAsync, isPending: updatePending } = useUpdateKuerzung();
  const { mutateAsync: delAsync } = useDeleteKuerzung();
  const { pushAction } = useUndoHistory();
  const isPending = addPending || updatePending;

  const [betrag, setBetrag] = useState(kuerzung ? String(kuerzung.kuerzungsbetrag ?? '') : '');
  const [begruendung, setBegruendung] = useState(kuerzung?.begruendung ?? '');
  const [arzSubid, setArzSubid] = useState(kuerzung?.arz_subid != null ? String(kuerzung.arz_subid) : '');
  const [error, setError] = useState(null);

  // Positionen der verknüpften Rechnung nur laden, wenn der Dialog offen ist.
  const { data: arzData } = usePostbuchDetail(open && ep.arz_postid ? ep.arz_postid : null);
  const positionen = arzData?.arztrechnung?.einzelpositionen ?? [];

  function save() {
    setError(null);
    const betragNum = parseFloat(String(betrag).replace(',', '.'));
    if (!Number.isFinite(betragNum)) { setError('Bitte einen gültigen Betrag angeben.'); return; }
    const data = {
      kuerzungsbetrag: betragNum,
      begruendung: begruendung.trim() || null,
      arz_subid: arzSubid === '' ? null : Number(arzSubid),
    };
    if (isEdit) {
      const oldData = {
        kuerzungsbetrag: kuerzung.kuerzungsbetrag,
        begruendung: kuerzung.begruendung ?? null,
        arz_subid: kuerzung.arz_subid ?? null,
      };
      const kuerzungId = kuerzung.kuerzung_id;
      update({ postid: ebPostid, kuerzungId, data }, {
        onSuccess: () => {
          onOpenChange(false);
          pushAction(
            'Kürzung geändert',
            () => updateAsync({ postid: ebPostid, kuerzungId, data: oldData }),
            () => updateAsync({ postid: ebPostid, kuerzungId, data }),
          );
        },
        onError: (e) => setError(e.message || 'Speichern fehlgeschlagen'),
      });
    } else {
      add({ postid: ebPostid, subid: ep.subid, data }, {
        onSuccess: (res) => {
          onOpenChange(false);
          const idHolder = { current: res.kuerzung_id };
          pushAction(
            'Kürzung hinzugefügt',
            () => delAsync({ postid: ebPostid, kuerzungId: idHolder.current }),
            async () => {
              const r = await addAsync({ postid: ebPostid, subid: ep.subid, data });
              idHolder.current = r.kuerzung_id;
            },
          );
        },
        onError: (e) => setError(e.message || 'Speichern fehlgeschlagen'),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md">
      <DialogTitle>{isEdit ? 'Kürzung bearbeiten' : 'Kürzung hinzufügen'}</DialogTitle>
      <DialogDescription>
        Betrag ist der Basis-Kürzungsbetrag (vor Anwendung des Leistungssatzes).
      </DialogDescription>

      <div className="mt-4 space-y-3 text-sm">
        <div>
          <label className="text-muted-foreground text-xs mb-1 block">Kürzungsbetrag (€)</label>
          <Input
            type="text" inputMode="decimal" value={betrag}
            onChange={(e) => setBetrag(e.target.value)}
            placeholder="0,00" className="h-8 w-[160px]" autoFocus
          />
        </div>
        <div>
          <label className="text-muted-foreground text-xs mb-1 block">Begründung</label>
          <Input value={begruendung} onChange={(e) => setBegruendung(e.target.value)}
            placeholder="z. B. Höchstsatz überschritten" className="h-8" />
        </div>
        <div>
          <label className="text-muted-foreground text-xs mb-1 block">Betroffene Einzelposition</label>
          {ep.arz_postid ? (
            <select
              value={arzSubid}
              onChange={(e) => setArzSubid(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">– keine (ganze Rechnung) –</option>
              {positionen.map((pos) => (
                <option key={pos.subid} value={pos.subid}>{positionLabel(pos)}</option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Erst eine Rechnung zuordnen, dann kann eine Einzelposition gewählt werden.
            </p>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>Abbrechen</Button>
        <Button size="sm" onClick={save} disabled={isPending}>
          {isPending ? 'Speichern…' : 'Speichern'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// Editor für die Kürzungen einer Erstattungsbescheid-Position (EBP):
// Anlegen, Bearbeiten (Betrag/Begründung/Position), Löschen. EBP.kuerzungsbetrag
// wird backend-seitig automatisch als Summe neu berechnet.
export function KuerzungEditor({ ebPostid, ep, kostentraeger }) {
  const { canWrite } = useAuth();
  const { mutate: del, mutateAsync: delAsync, isPending: delPending } = useDeleteKuerzung();
  const { mutateAsync: addAsync } = useAddKuerzung();
  const { mutateAsync: setGesehenAsync } = useSetKuerzungGesehen();
  const { mutateAsync: vormerkenAsync } = useVormerkenPkvPruefung();
  const { pushAction } = useUndoHistory();
  const [formFor, setFormFor] = useState(null); // { kuerzung } | { add: true } | null
  const [confirmDel, setConfirmDel] = useState(null); // kuerzung | null

  const kuerzungen = ep.kuerzungen ?? [];
  const satz = ep.leistungssatz != null ? parseFloat(ep.leistungssatz) : null;
  const effektiv = (basis) => (satz != null ? (parseFloat(basis) || 0) * satz / 100 : (parseFloat(basis) || 0));
  const summeEffektiv = effektiv(ep.kuerzungsbetrag);

  const hasKuerzungen = kuerzungen.length > 0;

  return (
    <div className={hasKuerzungen ? 'mt-2 pl-4 border-l-2 border-red-200' : 'mt-2'}>
      <div className="flex items-center justify-between gap-2 mb-1">
        {hasKuerzungen ? (
          <p className="text-xs font-semibold text-red-600">
            Kürzungen ({formatCurrency(summeEffektiv)} effektiv
            {satz != null && (
              <span className="font-normal text-red-400 ml-1">= {formatCurrency(ep.kuerzungsbetrag)} × {satz}%</span>
            )})
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Keine Kürzungen</p>
        )}
        {canWrite && (
          <Button size="sm" variant="ghost" onClick={() => setFormFor({ add: true })}
            className="h-6 px-2 text-xs gap-1 text-red-600/70 hover:text-red-600">
            <Plus className="h-3.5 w-3.5" />Kürzung
          </Button>
        )}
      </div>

      {hasKuerzungen && (
        <div className="space-y-1">
          {kuerzungen.map((k) => (
            <div key={k.kuerzung_id} className="flex items-start gap-2 rounded-md bg-red-50/50 dark:bg-red-950/20 px-2 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-red-600 font-medium">
                    {formatCurrency(effektiv(k.kuerzungsbetrag))}
                    {satz != null && <span className="text-red-400 ml-1">({formatCurrency(k.kuerzungsbetrag)} Basis)</span>}
                  </span>
                  {k.arz_subid != null ? (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      → Pos. {k.arz_subid}
                      {k.arz_ziffer ? ` · ${k.arz_ziffer}` : ''}
                      {k.arz_leistung ? ` · ${k.arz_leistung}` : ''}
                      <SymLinkButton token={positionToken(ep.arz_postid, k.arz_subid)} title="Positions-SymLink kopieren" />
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60 italic">keine Position</span>
                  )}
                </div>
                {k.begruendung && <div className="text-muted-foreground mt-0.5">{k.begruendung}</div>}
                <div className="mt-1">
                  <KuerzungStatusActions
                    ebPostid={ebPostid}
                    ebSubid={ep.subid}
                    kuerzungId={k.kuerzung_id}
                    kostentraeger={kostentraeger}
                    gesehenAm={k.gesehen_am}
                    pkvStatus={k.pkv_pruefung_status}
                    pkvPeriode={k.pkv_pruefung_periode}
                    pkvErlaeuterung={k.pkv_pruefung_erlaeuterung}
                    arzPostid={ep.arz_postid}
                    canWrite={canWrite}
                    compact
                  />
                </div>
              </div>
              {canWrite && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button type="button" onClick={() => setFormFor({ kuerzung: k })} title="Kürzung bearbeiten"
                    className="text-muted-foreground/40 hover:text-primary transition-colors">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => setConfirmDel(k)} title="Kürzung löschen"
                    className="text-destructive/40 hover:text-destructive transition-colors">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {formFor && (
        <KuerzungFormDialog
          open={!!formFor}
          onOpenChange={(v) => { if (!v) setFormFor(null); }}
          ebPostid={ebPostid}
          ep={ep}
          kuerzung={formFor.kuerzung}
        />
      )}

      <Dialog open={!!confirmDel} onOpenChange={(v) => { if (!v) setConfirmDel(null); }} size="sm">
        <DialogTitle>Kürzung löschen?</DialogTitle>
        <DialogDescription>
          {confirmDel && `${formatCurrency(confirmDel.kuerzungsbetrag)} Basis`}
          {confirmDel?.begruendung ? ` – ${confirmDel.begruendung}` : ''}.
          Der Gesamt-Kürzungsbetrag der Position wird neu berechnet.
          {confirmDel?.pkv_pruefung_status === 'VORGEMERKT' && (
            <span className="block mt-1.5 text-amber-700 font-medium">
              Diese Kürzung ist für die PKV-Prüfung vorgemerkt. Die Vormerkung entfällt beim Löschen.
            </span>
          )}
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDel(null)} disabled={delPending}>Abbrechen</Button>
          <Button variant="destructive" size="sm" disabled={delPending}
            onClick={() => {
              const kId = confirmDel.kuerzung_id;
              const oldData = {
                kuerzungsbetrag: confirmDel.kuerzungsbetrag,
                begruendung: confirmDel.begruendung ?? null,
                arz_subid: confirmDel.arz_subid ?? null,
              };
              const wasGesehen = !!confirmDel.gesehen_am;
              const wasVorgemerkt = confirmDel.pkv_pruefung_status === 'VORGEMERKT';
              const alteErlaeuterung = confirmDel.pkv_pruefung_erlaeuterung ?? null;
              del({ postid: ebPostid, kuerzungId: kId }, {
                onSuccess: () => {
                  setConfirmDel(null);
                  const idHolder = { current: kId };
                  pushAction(
                    'Kürzung gelöscht',
                    async () => {
                      const r = await addAsync({ postid: ebPostid, subid: ep.subid, data: oldData });
                      idHolder.current = r.kuerzung_id;
                      // Gesehen-Status und PKV-Prüfvormerkung sind eigene Tabellen/Zeilen und
                      // werden vom Löschen mit entfernt – nach dem Wiederanlegen (neue kuerzung_id)
                      // separat restaurieren, sonst verliert das Undo diese Metadaten.
                      if (wasGesehen) {
                        await setGesehenAsync({ postid: ebPostid, kuerzungId: r.kuerzung_id, ebSubid: ep.subid, gesehen: true });
                      }
                      if (wasVorgemerkt) {
                        await vormerkenAsync({ postid: ebPostid, kuerzungId: r.kuerzung_id, ebSubid: ep.subid, erlaeuterung: alteErlaeuterung });
                      }
                    },
                    () => delAsync({ postid: ebPostid, kuerzungId: idHolder.current }),
                  );
                },
              });
            }}>
            {delPending ? 'Löschen…' : 'Löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

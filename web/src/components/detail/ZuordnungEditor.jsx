import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Pencil, Trash2, Plus, Check, Undo2, AlertTriangle } from 'lucide-react';
import { useSetErstattungZuordnung, useSetOhneRechnungsbezug } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { ARZTRECHNUNG_ARTEN } from '@/lib/erstattung';
import { DocumentPicker } from './DocumentPicker';

// Editor für die Zuordnung einer Erstattungsbescheid-Position (EBP) zu einer
// (ganzen) Arztrechnung. Zeigt den aktuellen Link mit Lösen-/Ändern-Aktion.
// Ist keine Rechnung zugeordnet, kann die Position stattdessen als "ohne
// Rechnungsbezug" geprüft/markiert werden (Abschnitt 8.6 des Featureplans).
export function ZuordnungEditor({ ebPostid, ep }) {
  const location = useLocation();
  const { canWrite } = useAuth();
  const { mutate, mutateAsync, isPending } = useSetErstattungZuordnung();
  const { mutate: setOhneBezug, mutateAsync: setOhneBezugAsync, isPending: ohneBezugPending } = useSetOhneRechnungsbezug();
  const { pushAction } = useUndoHistory();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);

  const arzPostid = ep.arz_postid;
  const ohneBezugBestaetigt = !!ep.ohne_rechnungsbezug_bestaetigt_am;

  function assign(arzToken) {
    const oldArzPostid = arzPostid ?? null;
    mutate(
      { postid: ebPostid, subid: ep.subid, arzPostid: arzToken },
      {
        onSuccess: (res) => {
          setPickerOpen(false);
          pushAction(
            'Rechnung zugeordnet',
            () => mutateAsync({ postid: ebPostid, subid: ep.subid, arzPostid: oldArzPostid, restoreKuerzungenArzSubid: res.prev_kuerzungen_arz_subid }),
            () => mutateAsync({ postid: ebPostid, subid: ep.subid, arzPostid: arzToken }),
          );
        },
      }
    );
  }
  function detach() {
    const oldArzPostid = arzPostid;
    mutate(
      { postid: ebPostid, subid: ep.subid, arzPostid: null },
      {
        onSuccess: (res) => {
          setConfirmDetach(false);
          pushAction(
            'Zuordnung gelöst',
            () => mutateAsync({ postid: ebPostid, subid: ep.subid, arzPostid: oldArzPostid, restoreKuerzungenArzSubid: res.prev_kuerzungen_arz_subid }),
            () => mutateAsync({ postid: ebPostid, subid: ep.subid, arzPostid: null }),
          );
        },
      }
    );
  }
  function setOhneRechnungsbezug(bestaetigt) {
    setOhneBezug(
      { postid: ebPostid, subid: ep.subid, bestaetigt },
      {
        onSuccess: () => {
          pushAction(
            bestaetigt ? 'Als „ohne Rechnungsbezug" bestätigt' : 'Prüfung zurückgenommen',
            () => setOhneBezugAsync({ postid: ebPostid, subid: ep.subid, bestaetigt: !bestaetigt }),
            () => setOhneBezugAsync({ postid: ebPostid, subid: ep.subid, bestaetigt }),
          );
        },
      }
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      {arzPostid ? (
        <>
          <Link
            to={`/postbuch/${arzPostid}`}
            state={{ from: location.state?.from }}
            className="text-primary hover:underline font-mono"
          >
            → {arzPostid}{ep.arz_betreff ? ` (${ep.arz_betreff})` : ''}
          </Link>
          {canWrite && (
            <>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={isPending}
                title="Rechnung ändern"
                className="text-muted-foreground/40 hover:text-primary transition-colors disabled:opacity-40"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setConfirmDetach(true)}
                disabled={isPending}
                title="Zuordnung lösen"
                className="text-destructive/40 hover:text-destructive transition-colors disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </>
      ) : ohneBezugBestaetigt ? (
        <>
          <Badge variant="outline" className="text-slate-600 border-slate-200 bg-slate-50">
            Geprüft · ohne Rechnungsbezug
          </Badge>
          {canWrite && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)} disabled={isPending || ohneBezugPending}
                className="h-6 px-2 text-xs gap-1 text-green-600/70 hover:text-green-600">
                <Plus className="h-3.5 w-3.5" />Doch Rechnung zuordnen
              </Button>
              <Button size="sm" variant="ghost" disabled={ohneBezugPending}
                onClick={() => setOhneRechnungsbezug(false)}
                className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground">
                <Undo2 className="h-3.5 w-3.5" />Prüfung zurücknehmen
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <span className="inline-flex items-center gap-1 text-orange-700">
            <AlertTriangle className="h-3.5 w-3.5" />Keine Rechnung zugeordnet
          </span>
          {canWrite && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)} disabled={isPending || ohneBezugPending}
                className="h-6 px-2 text-xs gap-1 text-green-600/70 hover:text-green-600">
                <Plus className="h-3.5 w-3.5" />Rechnung zuordnen
              </Button>
              <Button size="sm" variant="ghost" disabled={ohneBezugPending}
                onClick={() => setOhneRechnungsbezug(true)}
                title="Bestätigen, dass diese Position keiner Rechnung zugeordnet werden muss"
                className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground">
                <Check className="h-3.5 w-3.5" />Keine Rechnungszuordnung erforderlich
              </Button>
            </>
          )}
        </>
      )}

      <DocumentPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        arten={ARZTRECHNUNG_ARTEN}
        title={`Rechnung für Position ${ep.subid} zuordnen`}
        description="Arztrechnung suchen oder SymLink (Postnummer) einfügen."
        onSelect={assign}
        isPending={isPending}
      />

      <Dialog open={confirmDetach} onOpenChange={setConfirmDetach} size="sm">
        <DialogTitle>Zuordnung lösen?</DialogTitle>
        <DialogDescription>
          Die Verknüpfung von Position {ep.subid} zu Rechnung {arzPostid} wird entfernt.
          Zugehörige Kürzungen verlieren dabei ihren Positions-Bezug.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDetach(false)} disabled={isPending}>Abbrechen</Button>
          <Button variant="destructive" size="sm" onClick={detach} disabled={isPending}>
            {isPending ? 'Lösen…' : 'Lösen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

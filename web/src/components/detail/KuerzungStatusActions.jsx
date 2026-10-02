import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, BookmarkPlus, BookmarkX, Pencil } from 'lucide-react';
import {
  useSetKuerzungGesehen, useVormerkenPkvPruefung, useEntfernePkvPruefung,
  useSetPkvPruefungErlaeuterung,
} from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';

/**
 * Einheitliche Status-/Aktionskomponente für eine einzelne Kürzung: Gesehen
 * setzen/zurücknehmen sowie – bei Beihilfe-Kürzungen – PKV-Prüfvormerkung
 * setzen/entfernen, inkl. optionaler Erläuterung. Wird an allen vier in
 * Abschnitt 8.1 des Featureplans genannten Stellen eingesetzt
 * (Kürzungsübersicht, Kürzungseditor im Beihilfebescheid, Kürzungsanzeige an
 * der Rechnung, Prüffallliste der PKV-Periode), damit Beschriftung und
 * Verhalten überall identisch sind.
 *
 * @param {string} ebPostid Erstattungsbescheid-PostID
 * @param {number} ebSubid Position im Erstattungsbescheid
 * @param {number} kuerzungId
 * @param {string} kostentraeger 'PKV' | 'Beihilfe' des Erstattungsbescheids
 * @param {string|null} gesehenAm
 * @param {string|null} pkvStatus 'VORGEMERKT' | 'EINGEREICHT' | undefined
 * @param {number|null} pkvPeriode
 * @param {string|null} pkvErlaeuterung optionale Erläuterung zur Vormerkung
 * @param {string|null} arzPostid verknüpfte Rechnung, für gezielte Cache-Invalidierung
 * @param {boolean} canWrite
 * @param {boolean} compact enge Darstellung (z. B. im Kürzungseditor)
 */
export function KuerzungStatusActions({
  ebPostid, ebSubid, kuerzungId, kostentraeger,
  gesehenAm, pkvStatus, pkvPeriode, pkvErlaeuterung, arzPostid,
  canWrite, compact = false,
}) {
  const gesehenMutation = useSetKuerzungGesehen();
  const vormerkenMutation = useVormerkenPkvPruefung();
  const entfernenMutation = useEntfernePkvPruefung();
  const erlaeuterungMutation = useSetPkvPruefungErlaeuterung();
  const { pushAction } = useUndoHistory();

  // null = Editor zu, sonst aktueller Textinhalt des Erläuterungs-Editors
  const [editErlaeuterung, setEditErlaeuterung] = useState(null);

  const istGesehen = !!gesehenAm;
  const btnSize = compact ? undefined : 'sm';
  // Feste Höhe/whitespace-nowrap der Button-Basis passt nicht zu Beschriftungen
  // wie „Für PKV-Prüfung vormerken" in schmalen Tabellenspalten – dort muss der
  // Text umbrechen dürfen statt seitlich aus der Zelle zu laufen.
  const btnCls = compact
    ? 'h-auto min-h-6 px-2 py-1 text-xs gap-1 whitespace-normal text-left'
    : 'h-auto min-h-8 px-3 py-1.5 whitespace-normal text-left';
  const iconCls = compact ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const pkvBadge = pkvStatus === 'VORGEMERKT'
    ? (
      <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50">
        PKV-Prüfung vorgemerkt{pkvPeriode != null ? ` (${pkvPeriode})` : ''}
      </Badge>
    )
    : pkvStatus === 'EINGEREICHT'
      ? (
        <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">
          Bei PKV eingereicht{pkvPeriode != null ? ` · Periode ${pkvPeriode}` : ''}
        </Badge>
      )
      : null;

  if (!canWrite) {
    return (
      <div className="flex flex-col gap-1 items-start">
        <div className="flex items-center gap-1.5 flex-wrap">
          {istGesehen && <Badge variant="outline">Gesehen</Badge>}
          {pkvBadge}
        </div>
        {pkvErlaeuterung && <p className="text-xs text-muted-foreground">{pkvErlaeuterung}</p>}
      </div>
    );
  }

  const bestaetigen = () => {
    const wert = editErlaeuterung.trim() || null;
    if (pkvStatus === 'VORGEMERKT') {
      const oldWert = pkvErlaeuterung ?? null;
      erlaeuterungMutation.mutate({ postid: ebPostid, kuerzungId, ebSubid, erlaeuterung: wert, arzPostid }, {
        onSuccess: () => {
          setEditErlaeuterung(null);
          pushAction(
            'Erläuterung geändert',
            () => erlaeuterungMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, erlaeuterung: oldWert, arzPostid }),
            () => erlaeuterungMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, erlaeuterung: wert, arzPostid }),
          );
        },
      });
    } else {
      vormerkenMutation.mutate({ postid: ebPostid, kuerzungId, ebSubid, erlaeuterung: wert, arzPostid }, {
        onSuccess: () => {
          setEditErlaeuterung(null);
          pushAction(
            'Für PKV-Prüfung vorgemerkt',
            () => entfernenMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, arzPostid }),
            () => vormerkenMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, erlaeuterung: wert, arzPostid }),
          );
        },
      });
    }
  };

  return (
    <div className="flex flex-col gap-1.5 items-start">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          size={btnSize}
          variant="outline"
          className={btnCls}
          disabled={gesehenMutation.isPending}
          onClick={() => {
            const newVal = !istGesehen;
            gesehenMutation.mutate({ postid: ebPostid, kuerzungId, ebSubid, gesehen: newVal, arzPostid }, {
              onSuccess: () => {
                pushAction(
                  newVal ? 'Als gesehen markiert' : 'Gesehen zurückgenommen',
                  () => gesehenMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, gesehen: istGesehen, arzPostid }),
                  () => gesehenMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, gesehen: newVal, arzPostid }),
                );
              },
            });
          }}
          title={istGesehen ? 'Gesehen zurücknehmen' : 'Als gesehen markieren'}
        >
          {istGesehen ? <EyeOff className={iconCls} /> : <Eye className={iconCls} />}
          {istGesehen ? 'Gesehen' : 'Ungesehen'}
        </Button>

        {kostentraeger === 'Beihilfe' && !pkvStatus && editErlaeuterung === null && (
          <Button
            size={btnSize}
            variant="outline"
            className={btnCls}
            onClick={() => setEditErlaeuterung('')}
            title="Für PKV-Prüfung gegen den Beihilfeergänzungstarif vormerken"
          >
            <BookmarkPlus className={iconCls} />
            Für PKV-Prüfung vormerken
          </Button>
        )}

        {pkvStatus === 'VORGEMERKT' && editErlaeuterung === null && (
          <>
            <Button
              size={btnSize}
              variant="outline"
              className={btnCls}
              onClick={() => setEditErlaeuterung(pkvErlaeuterung || '')}
              title="Erläuterung bearbeiten"
            >
              <Pencil className={iconCls} />
              Erläuterung
            </Button>
            <Button
              size={btnSize}
              variant="outline"
              className={btnCls}
              disabled={entfernenMutation.isPending}
              onClick={() => {
                const oldWert = pkvErlaeuterung ?? null;
                entfernenMutation.mutate({ postid: ebPostid, kuerzungId, ebSubid, arzPostid }, {
                  onSuccess: () => {
                    pushAction(
                      'PKV-Prüfvormerkung entfernt',
                      () => vormerkenMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, erlaeuterung: oldWert, arzPostid }),
                      () => entfernenMutation.mutateAsync({ postid: ebPostid, kuerzungId, ebSubid, arzPostid }),
                    );
                  },
                });
              }}
              title="PKV-Prüfvormerkung entfernen"
            >
              <BookmarkX className={iconCls} />
              Vormerkung entfernen
            </Button>
          </>
        )}
      </div>

      {editErlaeuterung !== null && (kostentraeger === 'Beihilfe' && !pkvStatus || pkvStatus === 'VORGEMERKT') && (
        <div className="flex flex-col gap-1 w-full max-w-md">
          <textarea
            className="w-full p-2 border rounded-md text-xs min-h-[60px] resize-y"
            placeholder="Erläuterung (optional)"
            value={editErlaeuterung}
            onChange={(e) => setEditErlaeuterung(e.target.value)}
            autoFocus
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={vormerkenMutation.isPending || erlaeuterungMutation.isPending}
              onClick={bestaetigen}
            >
              {pkvStatus === 'VORGEMERKT' ? 'Speichern' : 'Vormerken'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditErlaeuterung(null)}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {pkvBadge}
      {pkvStatus === 'VORGEMERKT' && editErlaeuterung === null && pkvErlaeuterung && (
        <p className="text-xs text-muted-foreground">{pkvErlaeuterung}</p>
      )}
    </div>
  );
}

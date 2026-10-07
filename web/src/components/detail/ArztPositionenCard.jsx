import { useState, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { formatDate, formatCurrency, cn } from '@/lib/utils';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { useAddArztPosition, useUpdateArztPosition, useDeleteArztPosition } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { SymLinkButton } from './SymLinkButton';
import { positionToken } from '@/lib/erstattung';

const FELDER = ['behandlungs_datum', 'goa_goz_gebueh_pzn', 'leistung', 'faktor', 'betrag', 'begruendung'];

// Server-Zeile → Formularwerte (alles Strings, Dezimalkomma wie bei der Eingabe)
function zuEntwurf(pos) {
  const zahl = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));
  return {
    behandlungs_datum: pos?.behandlungs_datum ? String(pos.behandlungs_datum).split('T')[0] : '',
    goa_goz_gebueh_pzn: pos?.goa_goz_gebueh_pzn ?? '',
    leistung: pos?.leistung ?? '',
    faktor: zahl(pos?.faktor),
    betrag: zahl(pos?.betrag),
    begruendung: pos?.begruendung ?? '',
  };
}

// Formularwerte → API-Payload (leere Felder als null)
function zuPayload(entwurf) {
  const out = {};
  for (const f of FELDER) {
    const s = String(entwurf[f] ?? '').trim();
    // „1.234,56" → 1234.56; ohne Komma gilt ein Punkt als Dezimaltrenner.
    const zahl = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
    out[f] = s === '' ? null : (f === 'faktor' || f === 'betrag' ? zahl : s);
  }
  return out;
}

// Werte einer bestehenden Zeile im API-Format (für Undo/Wiederherstellen)
function zeilenPayload(pos) {
  const out = {};
  for (const f of FELDER) out[f] = pos[f] == null ? null : String(pos[f]);
  return out;
}

function PositionDialog({ offen, titel, entwurf, setEntwurf, fehler, pending, onSpeichern, onSchliessen, istTier }) {
  const set = (f) => (e) => setEntwurf((d) => ({ ...d, [f]: e.target.value }));
  const feld = (label, f, props = {}) => (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input value={entwurf[f]} onChange={set(f)} className="h-8" {...props} />
    </label>
  );
  return (
    <Dialog open={offen} onOpenChange={onSchliessen} size="lg">
      <DialogTitle>{titel}</DialogTitle>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => { e.preventDefault(); onSpeichern(); }}
      >
        <div className="grid grid-cols-2 gap-3">
          {feld('Datum', 'behandlungs_datum', { type: 'date' })}
          {feld(istTier ? 'GOT / PZN' : 'Ziffer', 'goa_goz_gebueh_pzn', { className: 'h-8 font-mono' })}
        </div>
        {feld('Leistung', 'leistung')}
        <div className="grid grid-cols-2 gap-3">
          {feld('Faktor', 'faktor', { inputMode: 'decimal', placeholder: 'z. B. 2,3' })}
          {feld('Betrag (€)', 'betrag', { inputMode: 'decimal', required: true, className: 'h-8 font-mono' })}
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Begründung</span>
          <textarea
            value={entwurf.begruendung}
            onChange={set('begruendung')}
            rows={2}
            className="w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        {fehler && <p className="text-sm text-destructive">{fehler}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onSchliessen} disabled={pending}>Abbrechen</Button>
          <Button type="submit" disabled={pending}>{pending ? 'Speichern…' : 'Speichern'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Einzelpositionen einer Arztrechnung mit Bearbeiten, Hinzufügen und Löschen.
 * Die Zeile „automatisch ermittelter Differenzbetrag" (ist_differenz) pflegt
 * der Server selbst; sie steht immer am Ende und hat keine Aktionen.
 */
export function ArztPositionenCard({ postid, positionen = [], istTier, affectedSubids }) {
  const { canWrite } = useAuth();
  const { pushAction } = useUndoHistory();
  const addMut = useAddArztPosition();
  const updMut = useUpdateArztPosition();
  const delMut = useDeleteArztPosition();

  // dialog: { modus: 'neu' } | { modus: 'bearbeiten', pos } | null
  const [dialog, setDialog] = useState(null);
  const [entwurf, setEntwurf] = useState(zuEntwurf(null));
  const [fehler, setFehler] = useState(null);
  const [loeschen, setLoeschen] = useState(null);
  const [loeschFehler, setLoeschFehler] = useState(null);

  const regulaer = positionen.filter((p) => !p.ist_differenz);
  const differenz = positionen.filter((p) => p.ist_differenz);
  const sortiert = [...regulaer, ...differenz];
  const summe = positionen.reduce((s, p) => s + (parseFloat(p.betrag) || 0), 0);

  if (positionen.length === 0 && !canWrite) return null;

  function oeffne(modus, pos = null) {
    setEntwurf(zuEntwurf(pos));
    setFehler(null);
    setDialog({ modus, pos });
  }

  // Neu angelegte bzw. wiederhergestellte Positionen bekommen eine neue subid;
  // Undo/Redo merken sich deshalb die jeweils aktuelle Nummer.
  function undoFuerNeu(label, subid, payload) {
    let aktuell = subid;
    pushAction(
      label,
      () => delMut.mutateAsync({ postid, subid: aktuell }),
      async () => { aktuell = (await addMut.mutateAsync({ postid, ...payload })).subid; },
    );
  }

  async function speichern() {
    const payload = zuPayload(entwurf);
    if (payload.betrag == null) { setFehler('Bitte einen Betrag angeben.'); return; }
    try {
      if (dialog.modus === 'neu') {
        const res = await addMut.mutateAsync({ postid, ...payload });
        undoFuerNeu(`Position ${res.subid} hinzugefügt`, res.subid, payload);
      } else {
        const { subid } = dialog.pos;
        const alt = zeilenPayload(dialog.pos);
        await updMut.mutateAsync({ postid, subid, ...payload });
        pushAction(
          `Position ${subid} geändert`,
          () => updMut.mutateAsync({ postid, subid, ...alt }),
          () => updMut.mutateAsync({ postid, subid, ...payload }),
        );
      }
      setDialog(null);
    } catch (err) {
      setFehler(err.message || 'Speichern fehlgeschlagen');
    }
  }

  async function loescheBestaetigt() {
    const pos = loeschen;
    const payload = zeilenPayload(pos);
    try {
      await delMut.mutateAsync({ postid, subid: pos.subid });
      let aktuell = null;
      pushAction(
        `Position ${pos.subid} gelöscht`,
        async () => { aktuell = (await addMut.mutateAsync({ postid, ...payload })).subid; },
        () => delMut.mutateAsync({ postid, subid: aktuell }),
      );
      setLoeschen(null);
    } catch (err) {
      setLoeschFehler(err.message || 'Löschen fehlgeschlagen');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Einzelpositionen</CardTitle>
        {canWrite && (
          <Button size="sm" variant="ghost" onClick={() => oeffne('neu')}
            className="h-7 px-2 text-xs gap-1 text-primary/70 hover:text-primary">
            <Plus className="h-3.5 w-3.5" />Position hinzufügen
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {positionen.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine Einzelpositionen erfasst.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Datum</TableHead>
                <TableHead>{istTier ? 'GOT / PZN' : 'Ziffer'}</TableHead>
                <TableHead>Leistung</TableHead>
                <TableHead>Faktor</TableHead>
                <TableHead className="text-right">Betrag</TableHead>
                <TableHead className="w-8"><span className="sr-only">Aktionen</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortiert.map((pos) => {
                const gekuerzt = affectedSubids.has(pos.subid);
                if (pos.ist_differenz) {
                  return (
                    <TableRow key={pos.subid} className={cn('italic text-muted-foreground', gekuerzt && 'text-red-600')}
                      title="Die Summe der Positionen weicht vom Rechnungsbetrag ab. Diese Zeile gleicht den Unterschied aus und passt sich automatisch an.">
                      <TableCell>{pos.subid}</TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell>{pos.leistung}</TableCell>
                      <TableCell />
                      <TableCell className="text-right font-mono">{formatCurrency(pos.betrag)}</TableCell>
                      <TableCell className="text-right">
                        <SymLinkButton token={positionToken(postid, pos.subid)} title="Positions-SymLink kopieren" />
                      </TableCell>
                    </TableRow>
                  );
                }
                return (
                  <Fragment key={pos.subid}>
                    <TableRow className={cn('group', pos.begruendung && 'border-0', gekuerzt && 'text-red-600')}>
                      <TableCell className={gekuerzt ? 'text-red-400' : 'text-muted-foreground'}>{pos.subid}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(pos.behandlungs_datum)}</TableCell>
                      <TableCell className="font-mono text-xs">{pos.goa_goz_gebueh_pzn || '–'}</TableCell>
                      <TableCell>{pos.leistung || '–'}</TableCell>
                      <TableCell>{pos.faktor ? `${pos.faktor}×` : '–'}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(pos.betrag)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {canWrite && (
                            <>
                              <button type="button" onClick={() => oeffne('bearbeiten', pos)}
                                title={`Position ${pos.subid} bearbeiten`}
                                className="text-muted-foreground/30 hover:text-muted-foreground transition-colors">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button type="button"
                                onClick={() => { setLoeschFehler(null); setLoeschen(pos); }}
                                disabled={gekuerzt}
                                title={gekuerzt ? 'Mit einer Kürzung verknüpft – nicht löschbar' : `Position ${pos.subid} löschen`}
                                className="text-destructive/30 hover:text-destructive transition-colors disabled:opacity-30 disabled:hover:text-destructive/30 disabled:cursor-not-allowed">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                          <SymLinkButton token={positionToken(postid, pos.subid)} title="Positions-SymLink kopieren" />
                        </div>
                      </TableCell>
                    </TableRow>
                    {pos.begruendung && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={6} className="pt-0 text-xs text-muted-foreground align-top">
                          <span className="font-medium text-foreground/70">{istTier ? 'Begründung: ' : 'Begründung (Faktor > 2,3): '}</span>
                          {pos.begruendung}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              <TableRow className="hover:bg-transparent font-medium">
                <TableCell />
                <TableCell colSpan={4}>Summe</TableCell>
                <TableCell className="text-right font-mono">{formatCurrency(summe)}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        )}
      </CardContent>

      <PositionDialog
        offen={!!dialog}
        titel={dialog?.modus === 'neu' ? 'Position hinzufügen' : `Position ${dialog?.pos?.subid} bearbeiten`}
        entwurf={entwurf}
        setEntwurf={setEntwurf}
        fehler={fehler}
        pending={addMut.isPending || updMut.isPending}
        onSpeichern={speichern}
        onSchliessen={() => setDialog(null)}
        istTier={istTier}
      />

      <Dialog open={!!loeschen} onOpenChange={() => setLoeschen(null)}>
        <DialogTitle>Position {loeschen?.subid} löschen?</DialogTitle>
        <DialogDescription>
          {loeschen?.leistung || 'Position'} über {formatCurrency(loeschen?.betrag)} wird entfernt.
          Weicht die Summe danach vom Rechnungsbetrag ab, gleicht der automatisch ermittelte Differenzbetrag sie aus.
        </DialogDescription>
        {loeschFehler && <p className="text-sm text-destructive mt-3">{loeschFehler}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setLoeschen(null)}>Abbrechen</Button>
          <Button variant="destructive" disabled={delMut.isPending} onClick={loescheBestaetigt}>
            {delMut.isPending ? 'Löschen…' : 'Löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

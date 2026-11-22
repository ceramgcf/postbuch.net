import { useState, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { formatDate, formatCurrency, cn } from '@/lib/utils';
import { Pencil, Trash2, Plus, ChevronRight } from 'lucide-react';
import { useAddArztPosition, useUpdateArztPosition, useDeleteArztPosition } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { useDarstellung } from '@/hooks/useDarstellung';
import { ListenZeile, ListenGruppe } from '@/components/listen/ListenZeile';
import { SymLinkButton } from './SymLinkButton';
import { positionToken } from '@/lib/erstattung';

const FELDER = ['behandlungs_datum', 'goa_goz_gebueh_pzn', 'leistung', 'faktor', 'betrag', 'begruendung', 'zusatzangaben'];

const BELEG_FELDER = [
  { feld: 'beleg', label: 'Belegname' },
  { feld: 'nummer', label: 'Nummer' },
  { feld: 'leistung', label: 'Leistung' },
  { feld: 'menge', label: 'Menge', dezimal: true },
  { feld: 'einzelpreis', label: 'Einzelpreis (€)', dezimal: true },
  { feld: 'betrag', label: 'Betrag (€)', dezimal: true },
];

function dezimalPayload(wert) {
  const s = String(wert ?? '').trim();
  if (!s.includes(',')) return s || null;
  const deutsch = /^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+|),\d+$/;
  return deutsch.test(s) ? s.replaceAll('.', '').replace(',', '.') : s;
}

function zuEntwurf(pos) {
  const entwurf = Object.fromEntries(FELDER.map(f => [f, pos?.[f] == null ? '' : String(pos[f])]));
  entwurf.behandlungs_datum = entwurf.behandlungs_datum.split('T')[0];
  return entwurf;
}

function zuPayload(entwurf) {
  return Object.fromEntries(FELDER.map(f => [
    f, f === 'faktor' || f === 'betrag' ? dezimalPayload(entwurf[f]) : entwurf[f].trim() || null,
  ]));
}

function belegPayload(zeilen) {
  return zeilen.map(z => ({
    zeile: z.zeile,
    ...Object.fromEntries(BELEG_FELDER.map(({ feld, dezimal }) => [
      feld, dezimal ? dezimalPayload(z[feld]) : String(z[feld] ?? '').trim() || null,
    ])),
  }));
}

function BelegzeilenEditor({ zeilen, onChange, pending }) {
  function hinzufuegen() {
    const zeile = Math.max(0, ...zeilen.map(z => z.zeile)) + 1;
    onChange([...zeilen, { zeile }]);
  }

  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">Belegzeilen ({zeilen.length})</summary>
      <div className="mt-3 space-y-3">
        {zeilen.map(z => (
          <fieldset key={z.zeile} className="space-y-2 border-t pt-2" disabled={pending}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Belegzeile {z.zeile}</span>
              <Button type="button" variant="ghost" size="sm" aria-label={`Belegzeile ${z.zeile} entfernen`}
                onClick={() => onChange(zeilen.filter(andere => andere.zeile !== z.zeile))}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {BELEG_FELDER.map(({ feld, label, dezimal }) => (
                <label key={feld} className="block min-w-0 space-y-1">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <Input className="h-8" value={z[feld] ?? ''} inputMode={dezimal ? 'decimal' : undefined}
                    onChange={e => {
                      const wert = e.target.value;
                      onChange(zeilen.map(andere => andere.zeile === z.zeile ? { ...andere, [feld]: wert } : andere));
                    }} />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={hinzufuegen}>
          <Plus className="h-3.5 w-3.5" />Belegzeile hinzufügen
        </Button>
      </div>
    </details>
  );
}

function PositionDialog({ offen, titel, entwurf, setEntwurf, fehler, pending, onSpeichern, onSchliessen, istTier, belegzeilen, setBelegzeilen }) {
  const set = (f) => (e) => setEntwurf((d) => ({ ...d, [f]: e.target.value }));
  const feld = (label, f, props = {}) => (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input value={entwurf[f]} onChange={set(f)} className="h-8" {...props} />
    </label>
  );
  return (
    <Dialog open={offen} onOpenChange={pending ? undefined : onSchliessen} size="lg">
      <DialogTitle>{titel}</DialogTitle>
      <form
        className="mt-4 space-y-3 min-[1024px]:max-h-[75dvh] min-[1024px]:overflow-y-auto min-[1024px]:px-1"
        onSubmit={(e) => { e.preventDefault(); onSpeichern(); }}
      >
        <div className="grid grid-cols-2 gap-3">
          {feld('Datum', 'behandlungs_datum', { type: 'date' })}
          {feld(istTier ? 'GOT / PZN' : 'Ziffer', 'goa_goz_gebueh_pzn', { className: 'h-8 font-mono' })}
        </div>
        {feld('Leistung', 'leistung')}
        {feld('Weitere Angaben', 'zusatzangaben', { placeholder: 'z. B. Region: 13; Anzahl: 2' })}
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
        <BelegzeilenEditor zeilen={belegzeilen} onChange={setBelegzeilen} pending={pending} />
        {fehler && <p role="alert" className="text-sm text-destructive">{fehler}</p>}
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
 * `abweichung` (Rechnungsbetrag minus Positionssumme) berechnet der Server beim
 * Laden; sie wird unter der Summe angezeigt und nirgends gespeichert.
 */
// Zeilen eines beigefügten Belegs (Fremd-/Praxislabor, Material), dessen Summe
// die Position ist. Reine Aufschlüsselung: Summen und Kürzungen rechnen mit dem
// Positionsbetrag, die Belegzeilen zählen nicht zusätzlich.
function Belegzeilen({ zeilen }) {
  if (!zeilen?.length) return null;
  const belege = [...new Set(zeilen.map((z) => z.beleg).filter(Boolean))].join(', ');
  return (
    <details className="group/beleg text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open/beleg:rotate-90" />
        {belege || 'Beleg'}: {zeilen.length} {zeilen.length === 1 ? 'Zeile' : 'Zeilen'}
      </summary>
      <ul className="mt-1 space-y-0.5 border-l pl-3 ml-1.5">
        {zeilen.map((z) => (
          <li key={`${z.pos_subid}-${z.zeile}`} className="flex gap-2">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {z.nummer && <span className="font-mono mr-1.5">{z.nummer}</span>}
              {z.leistung || '–'}
              {z.menge != null && Number(z.menge) !== 1 && z.einzelpreis != null && (
                <span className="ml-1.5 whitespace-nowrap">({Number(z.menge).toLocaleString('de-DE')} × {formatCurrency(z.einzelpreis)})</span>
              )}
            </span>
            <span className="shrink-0 font-mono">{formatCurrency(z.betrag)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ArztPositionenCard({ postid, positionen = [], abweichung, istTier, affectedSubids }) {
  const { canWrite } = useAuth();
  const { istMobil } = useDarstellung();
  const { pushAction } = useUndoHistory();
  const addMut = useAddArztPosition();
  const updMut = useUpdateArztPosition();
  const delMut = useDeleteArztPosition();

  // dialog: { modus: 'neu' } | { modus: 'bearbeiten', pos } | null
  const [dialog, setDialog] = useState(null);
  const [entwurf, setEntwurf] = useState(zuEntwurf(null));
  const [belegzeilen, setBelegzeilen] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [loeschen, setLoeschen] = useState(null);
  const [loeschFehler, setLoeschFehler] = useState(null);

  const abweichungBetrag = parseFloat(abweichung) || 0;
  const summe = positionen.reduce((s, p) => s + (parseFloat(p.betrag) || 0), 0);

  if (positionen.length === 0 && !canWrite) return null;

  function oeffne(modus, pos = null) {
    setEntwurf(zuEntwurf(pos));
    setBelegzeilen(null);
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
    if (belegzeilen !== null) payload.belegzeilen = belegPayload(belegzeilen);
    if (payload.betrag == null) { setFehler('Bitte einen Betrag angeben.'); return; }
    try {
      if (dialog.modus === 'neu') {
        const res = await addMut.mutateAsync({ postid, ...payload });
        undoFuerNeu(`Position ${res.subid} hinzugefügt`, res.subid, payload);
      } else {
        const { subid } = dialog.pos;
        const alt = zuPayload(zuEntwurf(dialog.pos));
        if (belegzeilen !== null) alt.belegzeilen = belegPayload(dialog.pos.belegzeilen ?? []);
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
    const payload = { ...zuPayload(zuEntwurf(pos)), belegzeilen: belegPayload(pos.belegzeilen ?? []) };
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

  const aktionen = (pos, gekuerzt) => (
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
  );

  // Mobil: je Position eine ListenZeile – Leistung und Betrag oben,
  // Kennzahlen und Aktionen darunter, ggf. die Begründung.
  const mobilListe = (
    <ListenGruppe>
      {positionen.map((pos) => {
        const gekuerzt = affectedSubids.has(pos.subid);
        const kennzahlen = [
          `#${pos.subid}`,
          formatDate(pos.behandlungs_datum),
          pos.goa_goz_gebueh_pzn,
          pos.faktor && `${pos.faktor}×`,
        ].filter(Boolean).join(' · ');
        return (
          <ListenZeile
            key={pos.subid} umbrechen
            className={gekuerzt ? 'text-red-600' : ''}
            oben={pos.leistung || '–'}
            obenRechts={<span className="text-sm font-mono">{formatCurrency(pos.betrag)}</span>}
            unten={<span className={cn('truncate font-mono', gekuerzt && 'text-red-400')}>{kennzahlen}</span>}
            untenRechts={aktionen(pos, gekuerzt)}
          >
            {pos.zusatzangaben && (
              <p className="text-xs text-muted-foreground">{pos.zusatzangaben}</p>
            )}
            {pos.begruendung && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground/70">{istTier ? 'Begründung: ' : 'Begründung (Faktor > 2,3): '}</span>
                {pos.begruendung}
              </p>
            )}
            {pos.belegzeilen?.length > 0 && <Belegzeilen zeilen={pos.belegzeilen} />}
          </ListenZeile>
        );
      })}
      <ListenZeile oben="Summe" obenRechts={<span className="text-sm font-mono">{formatCurrency(summe)}</span>} />
      {abweichungBetrag !== 0 && (
        <ListenZeile
          className="italic text-muted-foreground"
          oben="Abweichung zum Rechnungsbetrag"
          obenRechts={<span className="text-sm font-mono">{formatCurrency(abweichungBetrag)}</span>}
        />
      )}
    </ListenGruppe>
  );

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
        ) : istMobil ? mobilListe : (
          // Die Tabelle erst, wenn die Karte breit genug ist, dass die
          // Leistung neben den festen Spalten vernünftig Platz hat; schmaler
          // (z. B. neben dem PDF) dieselbe Kartenliste wie mobil.
          <div className="@container">
            <div className="@4xl:hidden">{mobilListe}</div>
            <div className="hidden @4xl:block">
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
                  {positionen.map((pos) => {
                    const gekuerzt = affectedSubids.has(pos.subid);
                    return (
                      <Fragment key={pos.subid}>
                        <TableRow className={cn('group', (pos.begruendung || pos.belegzeilen?.length) && 'border-0', gekuerzt && 'text-red-600')}>
                          <TableCell className={gekuerzt ? 'text-red-400' : 'text-muted-foreground'}>{pos.subid}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDate(pos.behandlungs_datum)}</TableCell>
                          <TableCell className="font-mono text-xs">{pos.goa_goz_gebueh_pzn || '–'}</TableCell>
                          <TableCell className="hyphens-auto">
                            {pos.leistung || '–'}
                            {pos.zusatzangaben && (
                              <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{pos.zusatzangaben}</span>
                            )}
                          </TableCell>
                          <TableCell>{pos.faktor ? `${pos.faktor}×` : '–'}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(pos.betrag)}</TableCell>
                          <TableCell className="text-right">
                            {aktionen(pos, gekuerzt)}
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
                        {pos.belegzeilen?.length > 0 && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell />
                            <TableCell colSpan={6} className="pt-0 align-top">
                              <Belegzeilen zeilen={pos.belegzeilen} />
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
                  {abweichungBetrag !== 0 && (
                    <TableRow className="hover:bg-transparent italic text-muted-foreground"
                      title="Rechnungsbetrag minus Summe der Positionen, z. B. Mehrwertsteuer oder eine Minderung, die nicht als eigene Position erfasst ist.">
                      <TableCell />
                      <TableCell colSpan={4}>Abweichung zum Rechnungsbetrag</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(abweichungBetrag)}</TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
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
        belegzeilen={belegzeilen ?? dialog?.pos?.belegzeilen ?? []}
        setBelegzeilen={setBelegzeilen}
      />

      <Dialog open={!!loeschen} onOpenChange={delMut.isPending ? undefined : () => setLoeschen(null)}>
        <DialogTitle>Position {loeschen?.subid} löschen?</DialogTitle>
        <DialogDescription>
          {loeschen?.leistung || 'Position'} über {formatCurrency(loeschen?.betrag)} wird entfernt.
        </DialogDescription>
        {loeschFehler && <p className="text-sm text-destructive mt-3">{loeschFehler}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={delMut.isPending} onClick={() => setLoeschen(null)}>Abbrechen</Button>
          <Button variant="destructive" disabled={delMut.isPending} onClick={loescheBestaetigt}>
            {delMut.isPending ? 'Löschen…' : 'Löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Trash2, Unlink } from 'lucide-react';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

// Muss zur serverseitigen Prüfung in service/mensch-loeschung.js passen. Der
// Server entscheidet, das hier ist nur Live-Feedback beim Tippen.
function normalisiere(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function Warnbox({ children }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Zahlenblock({ vorschau }) {
  const { referenzen, dokumente } = vorschau;
  const zeilen = [
    [referenzen.arz, 'Arztrechnung(en)'],
    [referenzen.ab, 'Arztbericht(e)'],
    [referenzen.eb, 'Erstattungsposition(en)'],
    [referenzen.adr, 'Dokument(e) als Kontakt/Adressat'],
  ].filter(([n]) => n > 0);
  return (
    <div className="rounded-lg border bg-muted/25 p-3 text-sm">
      <p className="font-medium">{dokumente.gesamt} Dokument(e) betroffen</p>
      {zeilen.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {zeilen.map(([n, text]) => <li key={text}>· {n} {text}</li>)}
        </ul>
      )}
      {dokumente.misch > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Davon {dokumente.misch} Dokument(e) mit weiteren beteiligten Personen – diese bleiben in jedem Fall erhalten.
        </p>
      )}
    </div>
  );
}

/** Aufklappbare Options-Karte. Die gefährliche Variante trägt roten Rahmen. */
function Option({ titel, icon, gefaehrlich, gewaehlt, onWaehlen, badge, children }) {
  const rahmen = gefaehrlich
    ? 'border-red-300/70 bg-red-50/50 dark:border-red-500/40 dark:bg-red-500/10'
    : 'border-border/60';
  return (
    <div className={`rounded-lg border p-3 ${rahmen} ${gewaehlt ? '' : 'opacity-90'}`}>
      <div className="flex items-start justify-between gap-2">
        <p className={`flex items-center gap-1.5 text-sm font-medium ${gefaehrlich ? 'text-red-700 dark:text-red-300' : ''}`}>
          {icon}{titel}
        </p>
        {badge}
      </div>
      <div className="mt-1.5 space-y-2 text-xs text-muted-foreground">{children}</div>
      {!gewaehlt && (
        <Button
          size="sm"
          variant="outline"
          className={`mt-2.5 ${gefaehrlich ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-500/50 dark:text-red-300 dark:hover:bg-red-500/15' : ''}`}
          onClick={onWaehlen}
        >
          Diese Option wählen
        </Button>
      )}
    </div>
  );
}

export default function MenschLoeschenDialog({ mensch, open, onOpenChange }) {
  const qc = useQueryClient();
  const [modus, setModus] = useState(null);
  const [verstanden, setVerstanden] = useState(false);
  const [periodenOk, setPeriodenOk] = useState(false);
  const [eingabe, setEingabe] = useState('');

  const { data: vorschau, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['mensch-loesch-vorschau', mensch.id],
    queryFn: () => api.menschen.loeschVorschau(mensch.id),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  const loeschen = useMutation({
    mutationFn: (daten) => (daten.modus
      ? api.menschen.loeschen(mensch.id, daten)
      : api.menschen.delete(mensch.id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menschen'] });
      qc.invalidateQueries({ queryKey: ['personen'] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      onOpenChange(false);
    },
  });

  const satz = vorschau?.bestaetigungssatz ?? '';
  const stimmt = useMemo(
    () => satz.length > 0 && normalisiere(eingabe) === normalisiere(satz),
    [eingabe, satz],
  );
  const offenePerioden = vorschau?.offenePerioden?.length ?? 0;
  const periodenGate = offenePerioden === 0 || periodenOk;

  const schliessen = () => { if (!loeschen.isPending) onOpenChange(false); };

  return (
    <Dialog open={open} onOpenChange={schliessen} size="lg">
      <DialogTitle>{mensch.anzeigename} endgültig löschen?</DialogTitle>

      {isLoading && (
        <p className="py-6 text-sm text-muted-foreground">
          <Spinner className="mr-2 inline h-4 w-4" />Prüfe Verknüpfungen…
        </p>
      )}

      {isError && (
        <>
          <p className="py-4 text-sm text-destructive">{error.message}</p>
          <DialogFooter>
            <Button variant="outline" onClick={schliessen}>Abbrechen</Button>
            <Button onClick={() => refetch()}>Erneut versuchen</Button>
          </DialogFooter>
        </>
      )}

      {vorschau && !vorschau.hatBezuege && (
        <>
          <DialogDescription>
            Es sind keine Dokumente und keine Abrechnungsperioden mehr mit {mensch.anzeigename} verknüpft.
            Der Personendatensatz wird vollständig entfernt – das lässt sich nicht rückgängig machen.
          </DialogDescription>
          {loeschen.isError && <p className="mt-3 text-sm font-medium text-destructive">{loeschen.error.message}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={schliessen} disabled={loeschen.isPending}>Abbrechen</Button>
            <Button variant="destructive" onClick={() => loeschen.mutate({})} disabled={loeschen.isPending}>
              {loeschen.isPending ? 'Lösche…' : 'Endgültig löschen'}
            </Button>
          </DialogFooter>
        </>
      )}

      {vorschau && vorschau.hatBezuege && (
        <div className="space-y-3">
          <DialogDescription>
            {mensch.anzeigename} ist noch mit Daten in postbuch.net verknüpft. Wähle, was damit geschehen soll.
          </DialogDescription>

          <Zahlenblock vorschau={vorschau} />

          {offenePerioden > 0 && (
            <Warnbox>
              <p className="font-medium">
                {offenePerioden} bereits eingereichte Abrechnungsperiode(n) betroffen
              </p>
              <p>
                {vorschau.offenePerioden.map((p) => `${p.kostentraeger} ${p.periode}`).join(', ')} –
                {' '}diese Perioden werden in beiden Fällen mitgelöscht. Eine laufende Erstattung lässt sich
                danach nicht mehr über postbuch.net nachvollziehen.
              </p>
            </Warnbox>
          )}

          {vorschau.saldoQuellen.length > 0 && (
            <Warnbox>
              <p className="font-medium">Saldo-Quellen nennen {mensch.kurzname} direkt in ihrer Abfrage</p>
              <p>
                {vorschau.saldoQuellen.map((q) => q.name).join(', ')} – diese Quellen müssen nach dem Löschen
                von Hand angepasst werden, sonst liefern sie stillschweigend falsche Salden.
              </p>
            </Warnbox>
          )}

          <Option
            titel="Bezüge lösen"
            icon={<Unlink className="h-4 w-4" />}
            gewaehlt={modus === 'bezuege'}
            onWaehlen={() => { setModus('bezuege'); setVerstanden(false); }}
            badge={<Badge variant="outline">Dokumente bleiben</Badge>}
          >
            <p>
              Alle {vorschau.dokumente.gesamt} Dokument(e) bleiben vollständig erhalten – Datei, Beträge und
              übrige Angaben ändern sich nicht. Entfernt wird nur die Zuordnung zu {mensch.anzeigename};
              die Dokumente erscheinen danach ohne Person.
            </p>
            <p>Die gelöste Zuordnung lässt sich nicht automatisch wiederherstellen.</p>
            {modus === 'bezuege' && (
              <div className="space-y-2 pt-1">
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={verstanden} onChange={(e) => setVerstanden(e.target.checked)} />
                  <span>
                    Mir ist bewusst, dass {vorschau.dokumente.gesamt} Dokument(e) ihre Zuordnung zu {mensch.anzeigename} verlieren.
                  </span>
                </label>
                {offenePerioden > 0 && (
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={periodenOk} onChange={(e) => setPeriodenOk(e.target.checked)} />
                    <span>Mir ist bewusst, dass {offenePerioden} eingereichte Abrechnungsperiode(n) mitgelöscht werden.</span>
                  </label>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!verstanden || !periodenGate || loeschen.isPending}
                  onClick={() => loeschen.mutate({ modus: 'bezuege' })}
                >
                  {loeschen.isPending ? 'Lösche…' : 'Bezüge lösen und Person löschen'}
                </Button>
              </div>
            )}
          </Option>

          <Option
            titel="Alle Dokumente löschen"
            icon={<Trash2 className="h-4 w-4" />}
            gefaehrlich
            gewaehlt={modus === 'dokumente'}
            onWaehlen={() => { setModus('dokumente'); setEingabe(''); }}
            badge={<Badge variant="destructive">Nicht umkehrbar</Badge>}
          >
            <p>
              {vorschau.dokumente.loeschbar} Dokument(e), bei denen {mensch.anzeigename} die einzige
              beteiligte Person ist, werden vollständig aus postbuch.net entfernt. Die Datenbankeinträge
              sind danach unwiederbringlich weg; die Dateien landen im Ordner{' '}
              <span className="font-mono">&lt;Wurzelordner&gt;/_trash</span>. Dieser eigene Papierkorb
              von postbuch.net wird weder von postbuch.net noch von OneDrive oder Nextcloud automatisch geleert.
            </p>
            {vorschau.dokumente.misch > 0 && (
              <p>
                {vorschau.dokumente.misch} Dokument(e) mit weiteren beteiligten Personen bleiben erhalten.
                Dort werden nur die Positionen und Bezüge von {mensch.anzeigename} entfernt – die
                ausgewiesene Gesamtsumme solcher Bescheide passt danach nicht mehr zur Summe ihrer Positionen.
              </p>
            )}
            {vorschau.fremdePerioden.length > 0 && (
              <p className="font-medium text-amber-700 dark:text-amber-300">
                Achtung: {vorschau.fremdePerioden.length} Abrechnungsperiode(n) anderer Personen
                ({[...new Set(vorschau.fremdePerioden.map((p) => p.person))].join(', ')}) verweisen auf
                Bescheide, die hier gelöscht werden. Deren Status fällt auf „eingereicht" zurück.
              </p>
            )}
            {modus === 'dokumente' && (
              <div className="space-y-2 pt-1">
                {vorschau.dokumente.beispiele.length > 0 && (
                  <p className="text-[11px]">
                    Betroffen u. a.: {vorschau.dokumente.beispiele.map((d) => d.postid).join(', ')}
                    {vorschau.dokumente.loeschbar > vorschau.dokumente.beispiele.length && ' …'}
                  </p>
                )}
                {offenePerioden > 0 && (
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={periodenOk} onChange={(e) => setPeriodenOk(e.target.checked)} />
                    <span>Mir ist bewusst, dass {offenePerioden} eingereichte Abrechnungsperiode(n) mitgelöscht werden.</span>
                  </label>
                )}
                <p className="text-xs">
                  Tippe zur Bestätigung genau diesen Satz ein (Groß-/Kleinschreibung und Satzzeichen sind egal):
                </p>
                <code className="block select-all rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">{satz}</code>
                <Input
                  value={eingabe}
                  onChange={(e) => setEingabe(e.target.value)}
                  placeholder="Bestätigungssatz eintippen"
                  autoComplete="off"
                  className={stimmt ? 'border-emerald-500 ring-1 ring-emerald-500/30' : ''}
                />
                {stimmt && (
                  <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />Stimmt überein
                  </p>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!stimmt || !periodenGate || loeschen.isPending}
                  onClick={() => loeschen.mutate({ modus: 'dokumente', bestaetigung: eingabe })}
                >
                  {loeschen.isPending ? 'Lösche…' : 'Endgültig alle Dokumente löschen'}
                </Button>
              </div>
            )}
          </Option>

          {loeschen.isError && <p className="text-sm font-medium text-destructive">{loeschen.error.message}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={schliessen} disabled={loeschen.isPending}>Abbrechen</Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  );
}

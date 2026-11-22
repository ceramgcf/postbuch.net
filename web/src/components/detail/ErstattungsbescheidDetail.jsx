import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate, formatCurrency } from '@/lib/utils';
import { ZuordnungEditor } from './ZuordnungEditor';
import { KuerzungEditor } from './KuerzungEditor';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useAuth } from '@/hooks/useAuth';
import { ListenZeile } from '@/components/listen/ListenZeile';
import { BescheidBearbeitenDialog } from './BescheidBearbeitenDialog';

/** Laufender Hintergrundabgleich eines Bescheids; die Ansicht lädt bis zum Ende selbst nach. */
export function AbgleichLaeuftHinweis({ children }) {
  return (
    <Card className="border-sky-500/30 bg-sky-500/5">
      <CardContent className="flex items-center gap-3 py-4 text-sm">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" />
        <span className="text-foreground/90">{children}</span>
      </CardContent>
    </Card>
  );
}

export function ErstattungsbescheidDetail({ postid, data, ausstehend, kuerzungenAusstehend, istTier }) {
  const { istMobil } = useDarstellung();
  const { canWrite } = useAuth();
  const [editor, setEditor] = useState(null);
  const schliessen = () => setEditor(null);
  if (!data) {
    if (ausstehend) return (
      <AbgleichLaeuftHinweis>
        Erstattungsbescheid wird noch abgeglichen – Positionen und Zuordnung erscheinen hier automatisch, sobald der Abgleich fertig ist.
      </AbgleichLaeuftHinweis>
    );
    return null;
  }

  const bearbeitbar = canWrite && !kuerzungenAusstehend;
  function positionsAktionen(ep) {
    if (!bearbeitbar) return null;
    const loeschsperre = ep.arz_postid ? 'Zuerst die Rechnungszuordnung lösen'
      : ep.kuerzungen?.length ? 'Zuerst die Kürzungen entfernen' : '';
    return (
      <div className="flex items-center gap-1">
        <Button size="icon" variant="ghost" title="Position bearbeiten" aria-label={`Position ${ep.subid} bearbeiten`}
          onClick={() => setEditor({ position: true, datensatz: ep })}>
          <Pencil className="h-4 w-4" />
        </Button>
        <span title={loeschsperre || undefined}>
          <Button size="icon" variant="ghost" title={loeschsperre || 'Position löschen'} aria-label={`Position ${ep.subid} löschen`}
            disabled={!!loeschsperre} onClick={() => setEditor({ position: true, datensatz: ep, loeschen: true })}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {kuerzungenAusstehend && (
        <AbgleichLaeuftHinweis>
          Kürzungen werden noch den Rechnungspositionen zugeordnet – das kann bei langen Rechnungen einige Minuten dauern. Sie erscheinen hier automatisch.
        </AbgleichLaeuftHinweis>
      )}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="text-base">Erstattungsbescheid</CardTitle>
          {bearbeitbar && (
            <Button size="sm" variant="ghost" onClick={() => setEditor({ datensatz: data })}>
              <Pencil className="h-4 w-4" /> Bearbeiten
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Kostenträger</dt>
              <dd className="font-medium">{data.kostentraeger || '–'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bescheiddatum</dt>
              <dd className="font-medium">{formatDate(data.bescheiddatum)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Erstattungsbetrag</dt>
              <dd className="font-medium text-lg text-green-600">{formatCurrency(data.erstattungsbetrag)}</dd>
            </div>
            {data.hinweise && (
              <div className="col-span-3">
                <dt className="text-muted-foreground">Hinweise</dt>
                <dd className="font-medium whitespace-pre-wrap">{data.hinweise}</dd>
              </div>
            )}
            {data.matching_summary && (
              <div className="col-span-3">
                <dt className="text-muted-foreground">Matching-Zusammenfassung</dt>
                <dd className="font-medium whitespace-pre-wrap text-xs bg-muted p-2 rounded">{data.matching_summary}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Einzelpositionen */}
      {(bearbeitbar || data.einzelpositionen?.length > 0) && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
            <CardTitle className="text-base">Einzelpositionen</CardTitle>
            {bearbeitbar && (
              <Button size="sm" variant="outline" onClick={() => setEditor({ position: true })}>
                <Plus className="h-4 w-4" /> Position hinzufügen
              </Button>
            )}
          </CardHeader>
          <CardContent className={istMobil ? 'divide-y divide-border/60' : 'space-y-4'}>
            {data.einzelpositionen?.map((ep) => istMobil ? (
              // Mobil: ListenZeile, Zuordnung und Kürzungen darunter
              <ListenZeile
                key={ep.subid}
                oben={ep.name_arzt || '–'}
                obenRechts={<span className="text-sm font-mono">{formatCurrency(ep.rechnungsbetrag)}</span>}
                unten={<span className="truncate">#{ep.subid}{ep.behandelte_person && ` · ${ep.behandelte_person}`}</span>}
                untenRechts={<span className="font-mono text-green-600">erstattet {formatCurrency(ep.erstattungsbetrag)}</span>}
              >
                <div className="flex flex-wrap items-center justify-between gap-x-2">
                  <ZuordnungEditor ebPostid={data.postid} ep={ep} gesperrt={kuerzungenAusstehend} />
                  {positionsAktionen(ep)}
                </div>
                <Positionsbeleg ep={ep} />
                <KuerzungEditor ebPostid={data.postid} ep={ep} kostentraeger={data.kostentraeger} gesperrt={kuerzungenAusstehend} />
              </ListenZeile>
            ) : (
              <div key={ep.subid} className="border rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">Position {ep.subid}</span>
                  <ZuordnungEditor ebPostid={data.postid} ep={ep} gesperrt={kuerzungenAusstehend} />
                  {positionsAktionen(ep)}
                </div>
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground text-xs">Person</dt>
                    <dd>{ep.behandelte_person || '–'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Arzt</dt>
                    <dd>{ep.name_arzt || '–'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Rechnungsbetrag</dt>
                    <dd className="font-mono">{formatCurrency(ep.rechnungsbetrag)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">Erstattet</dt>
                    <dd className="font-mono text-green-600">{formatCurrency(ep.erstattungsbetrag)}</dd>
                  </div>
                </dl>

                <Positionsbeleg ep={ep} />
                <KuerzungEditor ebPostid={data.postid} ep={ep} kostentraeger={data.kostentraeger} gesperrt={kuerzungenAusstehend} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {editor && <BescheidBearbeitenDialog postid={postid} istTier={data.ist_tier ?? istTier} {...editor} schliessen={schliessen} />}
    </div>
  );
}

function Positionsbeleg({ ep }) {
  const angaben = [ep.kostenart, ep.bezugsdatum && formatDate(ep.bezugsdatum), ep.beleg_nr && `Beleg ${ep.beleg_nr}`].filter(Boolean);
  if (!angaben.length) return null;
  return <p className="text-xs text-muted-foreground">{angaben.join(' · ')}</p>;
}

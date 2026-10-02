import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatCurrency } from '@/lib/utils';
import { ZuordnungEditor } from './ZuordnungEditor';
import { KuerzungEditor } from './KuerzungEditor';

export function ErstattungsbescheidDetail({ data, ausstehend }) {
  if (!data) {
    if (!ausstehend) return null;
    return (
      <Card className="border-sky-500/30 bg-sky-500/5">
        <CardContent className="flex items-center gap-3 py-4 text-sm">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" />
          <span className="text-foreground/90">
            Erstattungsbescheid wird noch abgeglichen – Positionen und Zuordnung erscheinen hier automatisch, sobald der Abgleich fertig ist.
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Erstattungsbescheid</CardTitle>
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
      {data.einzelpositionen?.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Einzelpositionen</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.einzelpositionen.map((ep) => (
              <div key={ep.subid} className="border rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">Position {ep.subid}</span>
                  <ZuordnungEditor ebPostid={data.postid} ep={ep} />
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

                <KuerzungEditor ebPostid={data.postid} ep={ep} kostentraeger={data.kostentraeger} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

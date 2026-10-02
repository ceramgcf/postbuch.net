import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function ArztberichtDetail({ data }) {
  if (!data) return null;

  const hasNorm = !!data.norm_befunde;
  const hasPath = !!data.pathologische_befunde;
  const hasBefunde = hasNorm || hasPath;
  const istTier = !!data.behandelte_person_ist_tier;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{istTier ? 'Tierarztbericht' : 'Arztbericht'}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            {/* Metadaten: gestapelt (vertikal) */}
            <dl className="grid grid-cols-1 gap-y-3">
              {data.behandelte_person && (
                <div>
                  <dt className="text-muted-foreground">{istTier ? 'Behandeltes Tier' : 'Behandelte Person'}</dt>
                  <dd className="font-medium">{data.behandelte_person}</dd>
                </div>
              )}
              {data.anlass && (
                <div>
                  <dt className="text-muted-foreground">Anlass</dt>
                  <dd className="font-medium">{data.anlass}</dd>
                </div>
              )}
            </dl>

            {/* Befunde: zwei Spalten nebeneinander */}
            {hasBefunde && (
              <div>
                <h4 className="font-semibold text-foreground mb-2">Befunde</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <h5 className="font-medium mb-1">Normbefunde</h5>
                    {hasNorm ? (
                      <p className="whitespace-pre-wrap leading-relaxed text-foreground/80">
                        {data.norm_befunde}
                      </p>
                    ) : (
                      <p className="text-muted-foreground italic">Keine Normbefunde erfasst</p>
                    )}
                  </div>

                  <div>
                    <h5 className="font-medium text-red-600 mb-1">Pathologische Befunde</h5>
                    {hasPath ? (
                      <p className="whitespace-pre-wrap leading-relaxed text-red-600">
                        {data.pathologische_befunde}
                      </p>
                    ) : (
                      <p className="text-muted-foreground italic">Keine pathologischen Befunde</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

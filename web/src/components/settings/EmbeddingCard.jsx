/**
 * EmbeddingCard – Embedding-Modell und Bestandszustand
 *
 * Bis Phase 5 gab es zu `GET/PUT /api/settings/ai/embedding` überhaupt keine
 * Oberfläche; das Modell war nur über die DB änderbar.
 *
 * Der wichtige Teil ist nicht das Dropdown, sondern die Bestandsanzeige: Jede
 * Zeile trägt eine `embedding_signature`, und Suche wie Duplikatprüfung
 * berücksichtigen **ausschließlich** Zeilen mit der aktiven Signatur.
 * Umschalten heißt deshalb, dass die semantische Suche schlagartig weniger
 * findet, bis der Neuberechnungslauf durch ist. Genau das muss hier stehen –
 * sonst wirkt es wie ein Defekt.
 *
 * Die Dimension wird NICHT eingegeben: der Server ermittelt sie mit einem
 * einzigen `embed("test")`-Aufruf, und dieses Ergebnis ist autoritativ. Eine
 * erfundene Zahl in der Signatur würde die Vektorsuche still vergiften.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Binary, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';

export default function EmbeddingCard({ providers, onChanged }) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [fehler, setFehler] = useState('');

  const { data: emb, isLoading } = useQuery({
    queryKey: ['ai-embedding'],
    queryFn: () => api.settings.ai.embedding.get(),
    retry: false,
    refetchInterval: (query) => ['ausstehend', 'wird_erstellt'].includes(query.state.data?.hilfe?.status)
      ? 3000
      : false,
  });

  // Nur Provider, die als embedding-fähig deklariert sind – das Backend lehnt
  // andere ohnehin ab, und ein Dropdown, dessen Einträge 400 liefern, ist eine
  // Falle statt einer Auswahl.
  const kandidaten = (providers || []).filter((p) => p.aktiv !== false && p.caps?.embeddings);

  // Der gespeicherte Provider kann inzwischen gelöscht (force-delete) oder
  // deaktiviert worden sein – dann steht er nicht mehr in `kandidaten`. Ohne
  // diesen Fallback bliebe die Karte in einer Sackgasse hängen: Modell-Dropdown
  // verschwindet (leere Liste), und gibt es nur noch einen Kandidaten, feuert
  // das Provider-<select> beim Klick auf die einzige sichtbare Option kein
  // onChange (kein "echter" Wechsel aus Browsersicht) – der State bliebe für
  // immer auf der toten ID stehen.
  const gespeicherterProviderGueltig = !emb?.providerId || kandidaten.some((p) => p.id === emb.providerId);
  // Auf einer frischen Instanz ist `emb.providerId` null (EMBEDDING_DEFAULT hat
  // bewusst keine Werkseinstellung). Ohne den Fallback auf den ersten Kandidaten
  // blieb `aktuellerProvider` leer – das <select> zeigte trotzdem die erste
  // Option, weil ein Wert ohne passende Option im Browser so gerendert wird.
  // Folge: kein `prov`, also kein Modell-Dropdown und kein Empfehlungshinweis,
  // und „Übernehmen" schickte providerId:"" los → 400 „"providerId" und "model"
  // sind erforderlich."
  const defaultProviderId = (gespeicherterProviderGueltig ? emb?.providerId : null)
    || kandidaten[0]?.id
    || '';
  const aktuellerProvider = providerId || defaultProviderId || '';
  const prov = kandidaten.find((p) => p.id === aktuellerProvider);
  const modellliste = prov?.embeddingModels || [];

  // emb.model gehört zum ZULETZT GESPEICHERTEN Provider. Sobald effektiv ein
  // anderer Provider aktiv ist – sei es durch bewusste Nutzerwahl oder durch
  // den Fallback oben –, darf dessen Modellname nicht übernommen werden: das
  // war exakt der zweite gemeldete Bug (A→B→A speichert am Ende "A" mit B's
  // Modellstring, weil das Modell-Feld beim Providerwechsel auf emb.model
  // zurückfiel statt auf ein Modell des NEUEN Providers).
  const modellDarfUebernommenWerden = aktuellerProvider === emb?.providerId;
  const aktuellesModell = model
    || (modellDarfUebernommenWerden ? emb?.model : '')
    || modellliste[0]?.id
    || '';
  const providerWurdeErsetzt = !gespeicherterProviderGueltig && !providerId;

  // Die Empfehlung kommt aus den ausgelieferten Modellempfehlungen, nicht aus
  // hier einkodierten Modellnamen: die veralteten mit jedem Release, während
  // die Empfehlungsdatei mit ihm mitwandert. Passt ein Kandidat zum gewählten
  // Provider, wird genau der genannt – sonst die Kandidaten der Klasse
  // insgesamt, denn ein Modell zu empfehlen, das dieser Provider gar nicht
  // anbietet, wäre eine Empfehlung für eine nicht existierende Option.
  const { data: empfehlungen } = useQuery({
    queryKey: ['llm-empfehlungen'],
    queryFn: () => api.settings.ai.empfehlungen.get(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const embKandidaten = (empfehlungen?.klassen || []).find((k) => k.art === 'embedding')?.kandidaten || [];
  const passend = embKandidaten.find((k) => k.providerId && k.providerId === aktuellerProvider);
  const empfehlungsHinweis = !prov || embKandidaten.length === 0 ? null
    : passend
      ? <>Empfohlen: <span className="font-mono">{passend.model}</span>{passend.notiz ? ` – ${passend.notiz}` : ''}</>
      : <>Empfohlen für deutschsprachige Dokumente:{' '}
          {embKandidaten.map((k, i) => (
            <span key={`${k.providerId || k.providerTyp}-${k.model}`}>
              {i > 0 ? ' oder ' : ''}<span className="font-mono">{k.model}</span>
            </span>
          ))}.</>;

  const mSpeichern = useMutation({
    mutationFn: () => api.settings.ai.embedding.set(aktuellerProvider, aktuellesModell),
    onSuccess: async () => {
      setFehler(''); setProviderId(''); setModel('');
      await qc.invalidateQueries({ queryKey: ['ai-embedding'] });
      // Das neue Modell ändert die signierte KI-Konfiguration und entwertet
      // damit zu Recht den alten Testnachweis. Im Einrichtungsassistenten muss
      // unmittelbar ein frischer Nachweis folgen; ein bloßes GET würde sonst
      // alle Folgestufen wieder sperren. In den normalen Einstellungen reicht
      // die Invalidierung, der Assistent prüft beim nächsten Öffnen selbst.
      if (onChanged) await onChanged();
      else await qc.invalidateQueries({ queryKey: ['einrichtung'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-embedding'] }), 3000);
    },
    onError: (e) => setFehler(e.message),
  });

  const mRebuild = useMutation({
    mutationFn: () => api.settings.ai.embedding.rebuild(false),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-embedding'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-embedding'] }), 5000);
    },
    onError: (e) => setFehler(e.message),
  });

  const bestand = emb?.bestand;
  const veraltet = bestand?.veraltet ?? 0;
  const hilfe = emb?.hilfe;
  const hilfeAktuell = hilfe?.aktuell === true;
  const rebuildNoetig = veraltet > 0 || (hilfe && !hilfeAktuell && hilfe.status !== 'wartet_auf_provider');
  const prozent = bestand?.gesamt > 0 ? Math.round((bestand.passend / bestand.gesamt) * 100) : 100;
  // Ohne gespeichertes Modell ist die Vorauswahl selbst die Änderung: sonst
  // bliebe der Knopf auf einer frischen Instanz genau dann gesperrt, wenn der
  // Nutzer die vorgeschlagene Kombination unverändert übernehmen will.
  const nochNichtsGespeichert = !emb?.model;
  const geaendert = (providerId && providerId !== emb?.providerId)
    || (model && model !== emb?.model)
    || providerWurdeErsetzt
    || (nochNichtsGespeichert && !!aktuellesModell);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Binary className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Embeddings</CardTitle>
          {emb && (
            <Badge variant={veraltet > 0 || (hilfe && !hilfeAktuell) ? 'outline' : 'secondary'}
                   className={`ml-auto text-[10px] ${veraltet > 0 || (hilfe && !hilfeAktuell) ? 'border-amber-500/50 text-amber-600' : ''}`}>
              {veraltet > 0 ? `${veraltet} veraltet` : (hilfe && !hilfeAktuell ? 'Hilfe ausstehend' : 'vollständig')}
            </Badge>
          )}
        </div>
        <CardDescription className="text-xs pt-1">
          Grundlage für semantische Suche, Duplikaterkennung und die Hilfe des Assistenten.{empfehlungsHinweis ? ' ' : ''}
          {empfehlungsHinweis}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />Lade…
          </div>
        ) : kandidaten.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
            <span>Kein embedding-fähiger Provider konfiguriert. Provider mit Embedding-Fähigkeit unter
              „KI-Provider" anlegen oder aktivieren.</span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Provider</label>
                <select value={aktuellerProvider}
                        onChange={(e) => { setProviderId(e.target.value); setModel(''); }}
                        className="h-8 text-xs rounded-md border border-input bg-background px-2 cursor-pointer">
                  {kandidaten.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Modell</label>
                {modellliste.length > 0 ? (
                  <select value={aktuellesModell} onChange={(e) => setModel(e.target.value)}
                          className="h-8 max-w-[260px] text-xs rounded-md border border-input bg-background px-2 cursor-pointer">
                    {aktuellesModell && !modellliste.some((m) => m.id === aktuellesModell) && (
                      <option value={aktuellesModell}>{aktuellesModell}</option>
                    )}
                    {modellliste.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                ) : (
                  <input value={aktuellesModell} onChange={(e) => setModel(e.target.value)}
                         placeholder="Modell-ID eingeben…"
                         className="h-8 w-[220px] text-xs rounded-md border border-input bg-background px-2 font-mono" />
                )}
              </div>
              <Button size="sm" disabled={!geaendert || mSpeichern.isPending || !aktuellesModell}
                      onClick={() => { setFehler(''); mSpeichern.mutate(); }}>
                {mSpeichern.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
                Übernehmen
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              {emb?.signature
                ? <>Aktiv: <span className="font-mono">{emb.signature}</span></>
                : 'Noch kein Embedding-Modell gespeichert – Ähnlichkeitssuche, Duplikatprüfung und die Anwenderhilfe arbeiten so ohne Vektoren.'}
              {emb?.signature && emb?.dim ? ` · ${emb.dim} Dimensionen` : ''}
              {emb?.signature && emb?.dim && emb.dim < emb.storageDim
                ? ` (auf ${emb.storageDim} genullt gespeichert – mathematisch ohne Einfluss auf die Ähnlichkeit)`
                : ''}
            </p>

            {providerWurdeErsetzt && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                <span>
                  Der bisher konfigurierte Embedding-Provider existiert nicht mehr (gelöscht oder deaktiviert).
                  <span className="font-mono"> {prov?.label || aktuellerProvider}</span> mit{' '}
                  <span className="font-mono">{aktuellesModell}</span> wurde als Ersatz vorausgewählt –
                  bitte prüfen und bei Bedarf ein anderes Modell wählen, bevor gespeichert wird.
                </span>
              </div>
            )}

            {/* „Umstellen" setzt voraus, dass es etwas umzustellen GIBT. Bei der
                Ersteinrichtung ist weder ein Modell gespeichert noch ein Vektor
                vorhanden (0/0) – die Warnung vor dem Entwerten des Bestands war
                dort schlicht falsch. */}
            {geaendert && !nochNichtsGespeichert && (bestand?.gesamt ?? 0) > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                <span>
                  Nach dem Umstellen zählen alle bisherigen Embeddings als „nicht vorhanden",
                  bis sie neu berechnet sind. Die Suche findet so lange deutlich weniger.
                  Das Umstellen selbst löscht nichts und ist umkehrbar.
                </span>
              </div>
            )}

            {bestand && (
              <div className="space-y-1.5">
                <Progress value={prozent} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{bestand.passend} / {bestand.gesamt} mit aktueller Signatur</span>
                  {veraltet > 0 && <span className="text-amber-600">{veraltet} neu zu berechnen</span>}
                </div>
              </div>
            )}

            {hilfe && (
              <div className={`rounded-lg border px-3 py-2 text-xs ${hilfeAktuell
                ? 'border-emerald-500/30 bg-emerald-500/5'
                : 'border-amber-500/40 bg-amber-500/10'}`}>
                <div className="flex items-center gap-1.5 font-medium">
                  {hilfeAktuell
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
                  Assistenten-Hilfe: {hilfeAktuell
                    ? `${hilfe.erwartet} Abschnitte aktuell`
                    : hilfe.status === 'wartet_auf_provider'
                      ? 'wartet auf einen Embedding-Provider'
                      : hilfe.status === 'fehlgeschlagen'
                        ? 'Neuberechnung fehlgeschlagen'
                        : 'Neuberechnung ausstehend'}
                </div>
                {hilfe.fehler && <p className="mt-1 text-destructive">{hilfe.fehler}</p>}
              </div>
            )}

            {rebuildNoetig && (
              <div className="space-y-1.5">
                <Button size="sm" variant="outline" disabled={mRebuild.isPending}
                        onClick={() => { setFehler(''); mRebuild.mutate(); }}>
                  {mRebuild.isPending ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Embeddings einschließlich Hilfe neu berechnen
                </Button>
                {mRebuild.isSuccess && (
                  <p className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Lauf gestartet – Fortschritt steht in der Job-Anzeige.
                  </p>
                )}
              </div>
            )}

            {fehler && <p className="text-xs text-destructive">{fehler}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

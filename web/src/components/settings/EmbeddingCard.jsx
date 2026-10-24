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
 *
 * Vorsilben (Anweisungen vor Anfrage bzw. Dokument, die manche offenen Modelle
 * erwarten) belegt der Server aus seinem Katalog vor. Gespeichert wird genau
 * das, was die Karte anzeigt – eine Änderung entwertet wie ein Modellwechsel
 * den Bestand, weil sie in die Signatur eingeht.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Binary, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { EINGEBAUT_ID } from '@/lib/embedding-eingebaut';
import EingebauterEmbeddingDienst from './EingebauterEmbeddingDienst';

export default function EmbeddingCard({ providers, onChanged }) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [fehler, setFehler] = useState('');
  // null = nicht von Hand geändert; dann gilt gespeicherter Wert bzw. Vorschlag.
  const [vorsilbenEdit, setVorsilbenEdit] = useState(null);
  const [wechselFrage, setWechselFrage] = useState(false);

  const { data: emb, isLoading } = useQuery({
    queryKey: ['ai-embedding'],
    queryFn: () => api.settings.ai.embedding.get(),
    retry: false,
    refetchInterval: (query) => (['ausstehend', 'wird_erstellt'].includes(query.state.data?.hilfe?.status)
      || query.state.data?.neuberechnung?.laeuft)
      ? 3000
      : false,
  });

  // Nur Provider, die als embedding-fähig deklariert sind – das Backend lehnt
  // andere ohnehin ab, und ein Dropdown, dessen Einträge 400 liefern, ist eine
  // Falle statt einer Auswahl.
  // Der eingebaute Dienst wird im eigenen Baustein darüber gewählt, nicht hier.
  const kandidaten = (providers || []).filter((p) => p.aktiv !== false && p.caps?.embeddings
    && (p.id !== EINGEBAUT_ID || emb?.providerId === EINGEBAUT_ID));

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

  const wieGespeichert = aktuellerProvider === emb?.providerId && aktuellesModell === emb?.model;
  const { data: vorsilbenVorschlag } = useQuery({
    queryKey: ['ai-embedding-vorsilben', aktuellesModell],
    queryFn: () => api.settings.ai.embedding.vorsilbenVorschlag(aktuellesModell),
    enabled: !!aktuellesModell && !wieGespeichert,
    retry: false,
    staleTime: Infinity,
  });
  const gespeicherteVorsilben = emb?.vorsilben || { anfrage: '', dokument: '' };
  const vorsilben = vorsilbenEdit
    || (wieGespeichert ? gespeicherteVorsilben : vorsilbenVorschlag)
    || null;
  const vorsilbenGeaendert = !!vorsilbenEdit
    && (vorsilbenEdit.anfrage !== gespeicherteVorsilben.anfrage
      || vorsilbenEdit.dokument !== gespeicherteVorsilben.dokument);
  const setzeVorsilbe = (rolle, wert) => setVorsilbenEdit({
    ...(vorsilben || { anfrage: '', dokument: '' }), [rolle]: wert,
  });
  const vorsilbenKurz = !vorsilben ? '…'
    : !vorsilben.anfrage && !vorsilben.dokument ? 'keine'
      : [vorsilben.anfrage && 'vor Suchanfragen', vorsilben.dokument && 'vor Dokumenten']
        .filter(Boolean).join(' und ');

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

  // Nach jeder gespeicherten Wahl, auch der aus dem Baustein „Eingebauter Dienst“.
  const nachWahl = async () => {
    setFehler(''); setProviderId(''); setModel(''); setVorsilbenEdit(null);
    await qc.invalidateQueries({ queryKey: ['ai-embedding'] });
    // Die Wahl kann das Embedding-Profil abschalten (routes/settings.js).
    qc.invalidateQueries({ queryKey: ['updates'] });
    // Das neue Modell ändert die signierte KI-Konfiguration und entwertet
    // damit zu Recht den alten Testnachweis. Im Einrichtungsassistenten muss
    // unmittelbar ein frischer Nachweis folgen; ein bloßes GET würde sonst
    // alle Folgestufen wieder sperren. In den normalen Einstellungen reicht
    // die Invalidierung, der Assistent prüft beim nächsten Öffnen selbst.
    if (onChanged) await onChanged();
    else await qc.invalidateQueries({ queryKey: ['einrichtung'] });
    setTimeout(() => qc.invalidateQueries({ queryKey: ['ai-embedding'] }), 3000);
  };

  const mSpeichern = useMutation({
    // Ist der Vorschlag noch nicht geladen, bleibt `vorsilben` leer und der
    // Server belegt selbst aus demselben Katalog.
    mutationFn: () => api.settings.ai.embedding.set(aktuellerProvider, aktuellesModell, vorsilben || undefined),
    onSuccess: nachWahl,
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
  const neuberechnungLaeuft = emb?.neuberechnung?.laeuft === true;
  const rebuildNoetig = !neuberechnungLaeuft
    && (veraltet > 0 || (hilfe && !hilfeAktuell && !['wartet_auf_provider', 'ausstehend', 'wird_erstellt'].includes(hilfe.status)));
  const prozent = bestand?.gesamt > 0 ? Math.round((bestand.passend / bestand.gesamt) * 100) : 100;
  // Ohne gespeichertes Modell ist die Vorauswahl selbst die Änderung: sonst
  // bliebe der Knopf auf einer frischen Instanz genau dann gesperrt, wenn der
  // Nutzer die vorgeschlagene Kombination unverändert übernehmen will.
  const nochNichtsGespeichert = !emb?.model;
  const geaendert = (providerId && providerId !== emb?.providerId)
    || (model && model !== emb?.model)
    || vorsilbenGeaendert
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
        ) : (
          <>
          <EingebauterEmbeddingDienst gewaehlt={emb?.providerId === EINGEBAUT_ID}
                                      bestand={bestand?.gesamt ?? 0} onGewaehlt={nachWahl} />
          {kandidaten.length === 0 ? (
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
                        onChange={(e) => { setProviderId(e.target.value); setModel(''); setVorsilbenEdit(null); }}
                        className="h-8 text-xs rounded-md border border-input bg-background px-2 cursor-pointer">
                  {kandidaten.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Modell</label>
                {modellliste.length > 0 ? (
                  <select value={aktuellesModell} onChange={(e) => { setModel(e.target.value); setVorsilbenEdit(null); }}
                          className="h-8 max-w-[260px] text-xs rounded-md border border-input bg-background px-2 cursor-pointer">
                    {aktuellesModell && !modellliste.some((m) => m.id === aktuellesModell) && (
                      <option value={aktuellesModell}>{aktuellesModell}</option>
                    )}
                    {modellliste.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                ) : (
                  <input value={aktuellesModell} onChange={(e) => { setModel(e.target.value); setVorsilbenEdit(null); }}
                         placeholder="Modell-ID eingeben…"
                         className="h-8 w-[220px] text-xs rounded-md border border-input bg-background px-2 font-mono" />
                )}
              </div>
              <Button size="sm" disabled={!geaendert || mSpeichern.isPending || !aktuellesModell}
                      onClick={() => {
                        setFehler('');
                        // Mit Bestand bestätigt der Nutzer Wechsel und Neuberechnung gemeinsam.
                        if (!nochNichtsGespeichert && (bestand?.gesamt ?? 0) > 0) setWechselFrage(true);
                        else mSpeichern.mutate();
                      }}>
                {mSpeichern.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
                Übernehmen
              </Button>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">
                Vorsilben: {vorsilbenKurz}
              </summary>
              <div className="mt-2 space-y-2">
                <p className="text-muted-foreground">
                  Manche offenen Modelle erwarten eine feste Anweisung vor Suchanfragen oder vor
                  gespeicherten Texten. Für bekannte Modelle ist sie vorbelegt; OpenAI und Mistral
                  brauchen keine. Eine Änderung wirkt wie ein Modellwechsel.
                </p>
                {[['anfrage', 'Vor Suchanfragen'], ['dokument', 'Vor Dokumenten']].map(([rolle, label]) => (
                  <div key={rolle} className="space-y-1">
                    <label className="font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
                    <textarea value={vorsilben?.[rolle] ?? ''} rows={2} maxLength={500}
                              disabled={!vorsilben}
                              onChange={(e) => setzeVorsilbe(rolle, e.target.value)}
                              placeholder="keine"
                              className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs" />
                  </div>
                ))}
              </div>
            </details>

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
                  Nach dem Umstellen werden alle {bestand.gesamt} vorhandenen Embeddings automatisch
                  im Hintergrund neu berechnet. Bis der Lauf fertig ist, findet die Suche weniger.
                </span>
              </div>
            )}

            {bestand && (
              <div className="space-y-1.5">
                <Progress value={prozent} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{bestand.passend} / {bestand.gesamt} mit aktueller Signatur</span>
                  {veraltet > 0 && (
                    <span className="text-amber-600 flex items-center gap-1">
                      {neuberechnungLaeuft && <Spinner className="h-3 w-3" />}
                      {neuberechnungLaeuft ? `wird neu berechnet, noch ${veraltet}` : `${veraltet} neu zu berechnen`}
                    </span>
                  )}
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
                  Fehlende Embeddings nachberechnen
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

            <Dialog open={wechselFrage} onOpenChange={(o) => { if (!o) setWechselFrage(false); }}>
              <DialogTitle>Embedding-Modell wechseln?</DialogTitle>
              <DialogDescription className="mt-3">
                {emb?.model || '–'} → {aktuellesModell}. Danach werden die {bestand?.gesamt ?? 0} vorhandenen
                Embeddings automatisch im Hintergrund neu berechnet; bis dahin findet die Suche weniger.
                {aktuellerProvider !== EINGEBAUT_ID && ' Bei einem Cloud-Anbieter kostet das je nach Bestand Geld.'}
              </DialogDescription>
              <DialogFooter>
                <Button variant="outline" onClick={() => setWechselFrage(false)}>Abbrechen</Button>
                <Button onClick={() => { setWechselFrage(false); mSpeichern.mutate(); }}>
                  Wechseln und neu berechnen
                </Button>
              </DialogFooter>
            </Dialog>
          </>
          )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

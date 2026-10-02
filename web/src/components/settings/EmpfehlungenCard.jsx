/**
 * EmpfehlungenCard – kuratierte Modellempfehlungen (KI-Tab, admin-only)
 *
 * Steht bewusst **vor** der Modell-Konfiguration: wer die Klassen einstellt,
 * soll die Empfehlung sehen, bevor er von Hand wählt – nicht danach.
 *
 * Im aktuellen Release-Modus wird die Liste lokal mit der App ausgeliefert
 * und bewusst nur manuell angewendet. Der fruehere Online-Pfad bleibt hinter
 * `onlineVerfuegbar` vollstaendig im UI erhalten:
 *
 * Zwei getrennte, freiwillige Schalter im Online-Modus:
 *   1. **Abo** – holt die Empfehlungen. Aus ⇒ null ausgehender Verkehr.
 *   2. **Automatisch anwenden** – nur sichtbar bei aktivem Abo. Eine
 *      Komfortfunktion für Instanzen, die Empfehlungen ohne Handarbeit aktuell
 *      halten möchten.
 *
 * Übersprungene Kandidaten werden **mit Grund** gezeigt („#1 Claude Sonnet 5 –
 * Provider nicht konfiguriert"). Wer die Empfehlung nicht bekommt, will wissen
 * warum – sonst wirkt das Feature kaputt statt ehrlich.
 *
 * Die Zeile mit `art === 'embedding'` ist ein Sonderfall: „Alle übernehmen"
 * richtet sie ein, solange kein Modell gewählt ist, wechselt aber nie ein
 * bereits gewähltes (das entscheidet der Server). Der Wechsel läuft über einen
 * eigenen Bestätigungsdialog, weil er den gesamten vorhandenen Vektorbestand
 * entwertet, bis er neu berechnet ist.
 *
 * Alles, was der Nutzer über Herkunft, Auswahlregel und Verbindlichkeit der
 * Liste wissen muss, steht **einmal** im Absatz unter der Überschrift. Vorher
 * stand dasselbe zusätzlich in einem Hinweiskästchen, im Feed-Hinweis und
 * unter dem Knopf – vier Formulierungen derselben zwei Sätze.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Sparkles, RefreshCw, Undo2, ChevronDown, ChevronRight, Check } from 'lucide-react';

/**
 * Der Hinweis trennt klar Instanz und Herausgeber des Feeds. Er bleibt beim
 * Aktivieren sichtbar und erscheint erneut vor der Vollautomatik.
 */
export const RISIKOHINWEIS = (
  <>
    Das postbuch.net-Entwicklerteam stellt diese kuratierte Liste bereit. Modellwahl und Nutzung
    erfolgen auf eigenes Risiko. Preise können sich ändern; maßgeblich sind die Angaben des
    jeweiligen KI-Anbieters.
  </>
);

const STATUS_LABEL = {
  ok:                  { text: 'verfügbar',           farbe: 'text-emerald-600 dark:text-emerald-500' },
  nicht_konfiguriert:  { text: 'Provider fehlt',      farbe: 'text-muted-foreground' },
  kein_zugriff:        { text: 'kein Zugriff',        farbe: 'text-muted-foreground' },
  nicht_verifizierbar: { text: 'nicht prüfbar',       farbe: 'text-amber-600 dark:text-amber-500' },
};

function preisText(k) {
  if (k.preisIn == null || k.preisOut == null) return null;
  const cache = k.preisCacheWrite != null || k.preisCacheRead != null
    ? ` · Cache $${k.preisCacheWrite ?? '–'}/$${k.preisCacheRead ?? '–'}`
    : '';
  return `$${k.preisIn}/$${k.preisOut}${cache} je 1M`;
}

/**
 * `llmGesperrt` / `embeddingGesperrt` blenden Zeilen nicht aus, sondern legen
 * sie still: Der Einrichtungsassistent baut die KI-Seite stufenweise auf, und
 * eine Empfehlung, die mangels Provider gar nicht übernommen werden kann, soll
 * sichtbar bleiben – mit Grund, statt einfach zu fehlen.
 */
export default function EmpfehlungenCard({ llmGesperrt = false, embeddingGesperrt = false, onChanged }) {
  const qc = useQueryClient();
  const [offen, setOffen] = useState({});          // classKey → Kandidaten aufgeklappt
  const [autoDialog, setAutoDialog] = useState(false);
  const [embeddingDialog, setEmbeddingDialog] = useState(null);
  const [meldung, setMeldung] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['llm-empfehlungen'],
    queryFn: () => api.settings.ai.empfehlungen.get(),
    retry: false,
  });

  function nachAenderung() {
    qc.invalidateQueries({ queryKey: ['llm-empfehlungen'] });
    qc.invalidateQueries({ queryKey: ['settings'] });
    qc.invalidateQueries({ queryKey: ['ai-health'] });
    qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
    // „Alle übernehmen" richtet auch den Embedding-Slot ein, solange keiner
    // gewählt ist. Ohne diese Invalidierung stand die Embedding-Karte daneben
    // weiter auf „Noch kein Embedding-Modell gespeichert" – mit leerem Feld.
    qc.invalidateQueries({ queryKey: ['ai-embedding'] });
    // Der Einrichtungsassistent reicht hier seine Istprüfung nach; ohne sie
    // blieben die Statuszeilen oben rot, bis der Nutzer „KI neu testen" drückt.
    onChanged?.();
  }

  const setzeAbo = useMutation({
    mutationFn: async (an) => {
      if (an) return api.settings.ai.empfehlungen.abonnieren();
      await api.settings.update('llm_empfehlungen_abo', false);
      // Abo aus ⇒ Automatik zwingend aus. Ein aktiver Auto-Schalter ohne Abo
      // wäre ein stiller Zustand, der beim nächsten Einschalten überrascht.
      await api.settings.update('llm_empfehlungen_auto', false);
      return null;
    },
    onSuccess: (d) => {
      if (d) qc.setQueryData(['llm-empfehlungen'], d);
      nachAenderung();
    },
    // Bei einem vorübergehenden Abrufproblem bleibt das Abo aktiv. Die erneute
    // Abfrage zeigt diesen Zustand samt gespeichertem Fehler nachvollziehbar.
    onError: nachAenderung,
  });

  const setzeAuto = useMutation({
    mutationFn: (an) => an
      ? api.settings.ai.empfehlungen.automatik()
      : api.settings.update('llm_empfehlungen_auto', false),
    onSuccess: (d) => {
      if (d?.ergebnis) {
        const n = d.ergebnis.angewendet.length;
        setMeldung(n ? `${n} Klasse(n) sofort übernommen.` : 'Automatik aktiviert – aktuell gab es nichts zu ändern.');
        setTimeout(() => setMeldung(null), 5000);
      }
      if (d?.klassen) qc.setQueryData(['llm-empfehlungen'], d);
      setAutoDialog(false);
      nachAenderung();
    },
  });

  const pruefen = useMutation({
    mutationFn: () => api.settings.ai.empfehlungen.pruefen(),
    onSuccess: (d) => qc.setQueryData(['llm-empfehlungen'], d),
  });

  const anwenden = useMutation({
    mutationFn: (klassen) => api.settings.ai.empfehlungen.anwenden(klassen),
    onSuccess: (r) => {
      setMeldung(
        r.angewendet.length
          ? `${r.angewendet.length} Klasse(n) übernommen.`
          : 'Nichts geändert – es gab nichts zu übernehmen.',
      );
      setTimeout(() => setMeldung(null), 5000);
      setEmbeddingDialog(null);
      nachAenderung();
    },
  });

  const zuruecksetzen = useMutation({
    mutationFn: () => api.settings.ai.empfehlungen.zuruecksetzen(),
    onSuccess: () => { setMeldung('Auf den Stand vor der ersten Empfehlung zurückgesetzt.'); nachAenderung(); },
  });

  const abo = !!data?.abo;
  const online = !!data?.onlineVerfuegbar;
  // Nur ein BEREITS gewähltes Embedding-Modell ist vom Sammelknopf ausgenommen.
  // Ist keins gesetzt, richtet „Alle übernehmen" es mit ein.
  const embeddingGesetzt = (data?.klassen || []).some((k) => k.art === 'embedding' && k.gesetzt);
  const empfehlungenSichtbar = !!data && (!online || abo);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">Modellempfehlungen</CardTitle>
            {data?.stand && <Badge variant="secondary" className="text-[10px]">Stand {new Date(data.stand).toLocaleDateString('de-DE')}</Badge>}
            {isLoading && <Spinner className="h-3.5 w-3.5 ml-auto" />}
          </div>
          <CardDescription className="text-xs pt-1">
            {online
              ? 'Das postbuch.net-Entwicklerteam pflegt diese Liste bewährter Modelle je Aufgabe samt Preisen. '
              : 'Diese Liste bewährter Modelle je Aufgabe kam mit der installierten Version. '}
            Übernommen wird das höchstplatzierte Modell, auf das diese Instanz nachweislich Zugriff hat;
            Preise in USD je 1 Million Token. Modellwahl und Nutzung erfolgen auf eigenes Risiko –
            maßgeblich sind die Angaben des jeweiligen KI-Anbieters.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-0 space-y-4">
          {/* Der Regelweg steht oben, nicht am Ende der Liste. Wer die Karte
              öffnet, will in aller Regel genau das – und nicht erst zehn Zeilen
              lesen, um unten einen unscheinbaren Knopf zu finden. Derselbe
              Knopf steht weiterhin auch unter der Liste. */}
          {empfehlungenSichtbar && (
            <div className="space-y-2">
              <Button
                className="btn-gradient h-11 w-full text-white font-semibold"
                onClick={() => anwenden.mutate('alle')}
                disabled={anwenden.isPending || llmGesperrt}
              >
                <Sparkles className="h-4 w-4 mr-2" />
                {anwenden.isPending ? 'Wird übernommen…' : 'Modellempfehlungen alle übernehmen'}
              </Button>
              {embeddingGesetzt && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Das bereits gewählte Embedding-Modell bleibt dabei unangetastet – ein Wechsel wird
                  einzeln bestätigt.
                </p>
              )}
            </div>
          )}

          {/* ── Schalter 1: Abo ── */}
          {online && <div className="flex items-center justify-between">
            <div className="min-w-0 pr-3">
              <p className="text-sm font-medium">Empfehlungen abonnieren</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {abo ? 'Beim Einschalten sofort, danach täglich von postbuch.net.' : 'Aus – es geht kein Request nach draußen.'}
              </p>
            </div>
            <Switch
              checked={abo}
              onCheckedChange={(an) => setzeAbo.mutate(an)}
              disabled={setzeAbo.isPending}
              label="Empfehlungen abonnieren"
            />
          </div>}

          {empfehlungenSichtbar && (
            <>
              {/* ── Schalter 2: Automatik ── */}
              {online && <div className="flex items-center justify-between border-t border-border pt-3">
                <div className="min-w-0 pr-3">
                  <p className="text-sm font-medium">Empfehlungen automatisch anwenden</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {data?.auto
                      ? 'Holt neue Empfehlungen täglich und übernimmt passende Modelle automatisch.'
                      : 'Komfortfunktion: übernimmt passende neue Empfehlungen automatisch.'}
                  </p>
                </div>
                <Switch
                  checked={!!data?.auto}
                  onCheckedChange={(an) => (an ? setAutoDialog(true) : setzeAuto.mutate(false))}
                  disabled={setzeAuto.isPending}
                  label="Empfehlungen automatisch anwenden"
                />
              </div>}


              {/* Der Feed-Hinweis wird bewusst nicht angezeigt: er sagt dasselbe
                  wie der Absatz unter der Überschrift. Ein fehlgeschlagener
                  Abruf ist dagegen ein Zustand, kein Text – der bleibt. */}
              {data?.fehler && (
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-500">
                  Letzter Abruf: {data.fehler}
                </p>
              )}

              {/* ── Klassenliste ── */}
              <div className="divide-y divide-border/50 border-t border-border">
                {(data?.klassen || []).map((kl) => {
                  const g = kl.gewaehlt;
                  const aufgeklappt = !!offen[kl.key];
                  // Nur Kandidaten VOR dem gewählten Treffer wurden tatsächlich
                  // übersprungen. Nachrangige Alternativen bleiben Alternativen.
                  const gewaehlterIndex = g ? kl.kandidaten.findIndex((k) => k.rang === g.rang) : -1;
                  const uebersprungen = gewaehlterIndex >= 0
                    ? kl.kandidaten.slice(0, gewaehlterIndex).filter((k) => k.status !== 'ok')
                    : kl.kandidaten.filter((k) => k.status !== 'ok');
                  const istEmbedding = kl.art === 'embedding';
                  const gesperrt = istEmbedding ? embeddingGesperrt : llmGesperrt;
                  return (
                    <div key={kl.key} className={`py-2.5 ${gesperrt ? 'opacity-50' : ''}`}>
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{kl.label}</p>
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {kl.aktuell?.model || '–'}
                            {g && <span className="font-sans"> → </span>}
                            {g && <span className="text-foreground">{g.model}</span>}
                          </p>
                          {g && (
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              #{g.rang} {g.label}
                              {preisText(g) && <> · {preisText(g)}</>}
                              {g.notiz && <> · {g.notiz}</>}
                            </p>
                          )}
                          {!g && (
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {kl.kandidaten.length ? 'Kein Kandidat mit Zugriff.' : 'Keine Empfehlung.'}
                            </p>
                          )}
                          {istEmbedding && !kl.bereitsAktiv && kl.gesetzt && g && (
                            <p className="text-[11px] text-amber-700 dark:text-amber-500 mt-0.5">
                              Ein Wechsel entwertet alle vorhandenen Embeddings, bis sie neu berechnet
                              sind. „Alle übernehmen" fasst diese Zeile deshalb nicht an.
                            </p>
                          )}
                        </div>
                        <div className="shrink-0">
                          {gesperrt
                            ? <span className="text-[11px] text-muted-foreground">
                                {istEmbedding ? 'Embedding-Provider fehlt' : 'Sprachmodell-Provider fehlt'}
                              </span>
                            : kl.bereitsAktiv
                              ? <span className="text-[11px] text-emerald-600 dark:text-emerald-500 flex items-center gap-1"><Check className="h-3.5 w-3.5" />aktiv</span>
                              : g && (
                                <Button
                                  size="sm" variant="outline" className="h-7 text-xs"
                                  onClick={() => (istEmbedding && kl.gesetzt ? setEmbeddingDialog(kl) : anwenden.mutate([kl.key]))}
                                  disabled={anwenden.isPending}
                                >Übernehmen{istEmbedding && kl.gesetzt ? '…' : ''}</Button>
                              )}
                        </div>
                      </div>

                      {!!uebersprungen.length && (
                        <button
                          type="button"
                          className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                          onClick={() => setOffen((o) => ({ ...o, [kl.key]: !o[kl.key] }))}
                        >
                          {aufgeklappt ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          {uebersprungen.length} übersprungen
                        </button>
                      )}
                      {aufgeklappt && (
                        <ul className="mt-1 space-y-0.5 pl-4">
                          {uebersprungen.map((k) => (
                            <li key={`${k.rang}-${k.model}`} className="text-[11px] text-muted-foreground">
                              <span className="font-mono">#{k.rang} {k.label}</span>
                              {' – '}
                              <span className={STATUS_LABEL[k.status]?.farbe}>{STATUS_LABEL[k.status]?.text}</span>
                              {k.grund && <>: {k.grund}</>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>

              {meldung && <p className="text-xs text-emerald-600 dark:text-emerald-500">{meldung}</p>}
              {(anwenden.isError || pruefen.isError || zuruecksetzen.isError || setzeAuto.isError) && (
                <p className="text-sm text-destructive">
                  {(anwenden.error || pruefen.error || zuruecksetzen.error || setzeAuto.error)?.message}
                </p>
              )}

              <div className="flex items-center gap-2 flex-wrap border-t border-border pt-3">
                {online && <Button size="sm" variant="outline" onClick={() => pruefen.mutate()} disabled={pruefen.isPending}>
                  {pruefen.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                  Jetzt prüfen
                </Button>}
                <Button size="sm" onClick={() => anwenden.mutate('alle')} disabled={anwenden.isPending || llmGesperrt}>
                  Alle übernehmen
                </Button>
                {embeddingGesetzt && (
                  <span className="text-[11px] text-muted-foreground">ohne Embedding-Modell</span>
                )}
                {data?.snapshotVorhanden && (
                  <Button size="sm" variant="ghost" onClick={() => zuruecksetzen.mutate()} disabled={zuruecksetzen.isPending}>
                    <Undo2 className="h-3.5 w-3.5 mr-1.5" />Zurücksetzen
                  </Button>
                )}
                {online && data?.geholtAm && (
                  <span className="text-[11px] text-muted-foreground">
                    geholt: {new Date(data.geholtAm).toLocaleString('de-DE')}
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Eigener Bestätigungsdialog für die Automatik – der Schalter ändert
          laufende Kosten ohne weitere Rückfrage. */}
      {online && <Dialog open={autoDialog} onOpenChange={setAutoDialog} size="lg">
        <DialogTitle>Empfehlungen automatisch anwenden?</DialogTitle>
        <DialogDescription>
          postbuch.net übernimmt die aktuellen Empfehlungen jetzt und künftig täglich ohne Rückfrage.
        </DialogDescription>
        <ul className="mt-3 space-y-1.5 text-sm list-disc pl-5">
          <li>Ein Wechsel des Modells <strong>ändert deine laufenden Kosten</strong>.</li>
          <li>Vor der ersten Übernahme wird der Vorzustand gesichert – „Zurücksetzen" stellt ihn her.</li>
          <li>Modelle, deren Verfügbarkeit sich nicht prüfen lässt, werden automatisch <strong>nie</strong> übernommen.</li>
          <li>Jede automatische Änderung landet im Log und nur bei bewusst eingerichteter experimenteller Anbindung zusätzlich in Discord.</li>
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground rounded-md bg-muted/40 p-2">
          {RISIKOHINWEIS}
        </p>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setAutoDialog(false)}>Abbrechen</Button>
          <Button size="sm" onClick={() => setzeAuto.mutate(true)} disabled={setzeAuto.isPending}>
            Automatik einschalten
          </Button>
        </DialogFooter>
      </Dialog>}

      {/* Embedding-Wechsel: eigene, ausdrückliche Bestätigung. Die Folge trifft
          nicht die nächste Anfrage, sondern den gesamten vorhandenen Bestand. */}
      <Dialog open={!!embeddingDialog} onOpenChange={(o) => !o && setEmbeddingDialog(null)} size="lg">
        <DialogTitle>Empfohlenes Embedding-Modell übernehmen?</DialogTitle>
        <DialogDescription>
          {embeddingDialog?.aktuell?.model || '–'} → {embeddingDialog?.gewaehlt?.model}
          {embeddingDialog?.gewaehlt?.providerId && <> ({embeddingDialog.gewaehlt.providerId})</>}
        </DialogDescription>
        <ul className="mt-3 space-y-1.5 text-sm list-disc pl-5">
          <li>
            Alle bereits gespeicherten Embeddings gelten danach als <strong>veraltet</strong>: Ähnlichkeitssuche,
            Duplikaterkennung und die Anwenderhilfe finden bis zur Neuberechnung deutlich weniger.
          </li>
          <li>
            Die Neuberechnung startest du unter <strong>Einstellungen → KI → Embeddings</strong>
            („Embeddings einschließlich Hilfe neu berechnen"). Sie kostet je nach Bestand Zeit und Geld.
          </li>
          <li>Die Dimension wird nicht übernommen, sondern mit einer Testanfrage an deinem Provider ermittelt.</li>
          <li>Vor der ersten Übernahme wird der Vorzustand gesichert – „Zurücksetzen" stellt ihn her.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setEmbeddingDialog(null)}>Abbrechen</Button>
          <Button
            size="sm"
            onClick={() => anwenden.mutate([embeddingDialog.key])}
            disabled={anwenden.isPending}
          >Modell wechseln</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

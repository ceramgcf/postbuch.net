/**
 * ModelSelector – eine Zeile „Modellklasse → Provider · Modell"
 *
 * Zwei Entscheidungen, die vom ursprünglichen Plan abweichen:
 *
 * 1. **Ein `<select>` mit `<optgroup>` je Provider statt zwei Dropdowns.**
 *    Der Plan sah „ab ~5 Providern ein kombiniertes Such-Dropdown" vor. Ein
 *    UI, das bei Provider Nr. 5 die Interaktionsform wechselt, ist für den
 *    Nutzer ein unangekündigter Bruch – und es gäbe in `components/ui/` weder
 *    Combobox noch Popover, das wäre also neue Infrastruktur statt
 *    Wiederverwendung. Ein natives `<select>` bringt Typeahead von sich aus
 *    mit und ist auf Touch-Geräten ohnehin die bessere Bedienung.
 *
 * 2. **Freitext-Fallback.** Ein Provider, dessen `/models` klemmt oder gar
 *    keins hat (Claude-Abo), hätte sonst ein leeres Dropdown und wäre
 *    überhaupt nicht mehr konfigurierbar.
 *
 * Der angezeigte Provider kommt aus `health.models[cls.key]` – also aus der
 * serverseitigen Auflösung von `resolveModelConfig`. Im Frontend wird nie
 * wieder aus dem Modellnamen auf den Provider geraten.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { AlertCircle, AlertTriangle, CheckCircle2, Pencil, ListRestart } from 'lucide-react';
import { gleichesModell, istSnapshotVon } from '@/lib/modellId';

const TRENNZEICHEN = '\u0000';

// Preise in USD je 1 Mio. Token. Cache-Token rechnet das Backend mit den
// beiden Cache-Preisen; ein leeres Cache-Feld zählt wie normaler Input.
const PREISFELDER = [
  { feld: 'in',         label: 'In',          titel: 'Input-Token' },
  { feld: 'out',        label: 'Out',         titel: 'Output-Token' },
  { feld: 'cacheWrite', label: 'Cache-Write', titel: 'Schreiben in den Prompt-Cache. Leer = Input-Preis.' },
  { feld: 'cacheRead',  label: 'Cache-Read',  titel: 'Lesen aus dem Prompt-Cache. Leer = Input-Preis.' },
];

/**
 * Listeneintrag, für den eine gespeicherte Modell-ID steht: exakt, sonst ein
 * Snapshot des Alias (siehe lib/modellId.js). Mehrere Snapshots desselben
 * Alias ergeben bewusst keinen Treffer – dann lieber die Roh-ID zeigen als
 * einen willkürlich gewählten Eintrag.
 */
function aliasZuListeneintrag(modelle, model) {
  if (!model) return null;
  const exakt = modelle.find((m) => m.id === model);
  if (exakt) return exakt;
  const snapshots = modelle.filter((m) => istSnapshotVon(m.id, model));
  return snapshots.length === 1 ? snapshots[0] : null;
}

export default function ModelSelector({
  cls, wert, aufgeloest, providers, costValue, onChange, onCostChange, laedt, kostenGeteilt,
  zeigeKosten = true,
}) {
  // `wert` = lokale, noch nicht gespeicherte Änderung ({providerId, model}).
  // `aufgeloest` = health.models[cls.key], die serverseitige Wahrheit.
  const providerId = wert?.providerId ?? aufgeloest?.providerId ?? '';
  const model      = wert?.model      ?? aufgeloest?.model      ?? '';

  const aktiveProvider = (providers || []).filter((p) => p.aktiv !== false);
  const prov = aktiveProvider.find((p) => p.id === providerId);

  // Kennt irgendein Provider dieses Modell? Nur dann darf gewarnt werden.
  const listeVorhanden = aktiveProvider.some((p) => (p.models || []).length > 0);
  const modelleDesProviders = prov?.models || [];
  const kennenwert = `${providerId}${TRENNZEICHEN}${model}`;

  // Ein leeres Listing kann nichts widerlegen (Claude-Abo, Provider offline).
  const verfuegbar = !model || !modelleDesProviders.length
    ? null
    : modelleDesProviders.some((m) => gleichesModell(m.id, model));

  // Gespeichert kann ein Alias ohne Datums-Suffix sein ("claude-haiku-4-5",
  // so steht er in den Modellempfehlungen), während der Provider nur den
  // Snapshot listet ("claude-haiku-4-5-20251001"). Das <select> zeigt dann
  // den Listeneintrag des Snapshots als ausgewählt an. Gespeichert wird dabei
  // nichts: onChange feuert nur bei einer echten Auswahl, der Alias bleibt.
  // Ohne diese Abbildung hätte keine <option> den value, und der Browser
  // würde stillschweigend die erste Option der Liste selektieren.
  const liveEintrag = aliasZuListeneintrag(modelleDesProviders, model);
  const auswahlwert = liveEintrag ? `${providerId}${TRENNZEICHEN}${liveEintrag.id}` : kennenwert;

  // Freitext automatisch, wenn der Provider keine Liste hat – sonst auf Klick.
  const [freitext, setFreitext] = useState(false);
  const brauchtFreitext = freitext || (!!providerId && modelleDesProviders.length === 0);

  const costIn         = costValue?.input_usd_per_1m       ?? '';
  const costOut        = costValue?.output_usd_per_1m      ?? '';
  const costCacheWrite = costValue?.cache_write_usd_per_1m ?? '';
  const costCacheRead  = costValue?.cache_read_usd_per_1m  ?? '';

  const werte = { in: costIn, out: costOut, cacheWrite: costCacheWrite, cacheRead: costCacheRead };

  function handleAuswahl(raw) {
    const [pid, mid] = raw.split(TRENNZEICHEN);
    onChange(cls.key, { providerId: pid, model: mid });
  }
  function handleFreitext(pid, mid) {
    onChange(cls.key, { providerId: pid, model: mid });
  }
  function handleCostChange(feld, roh) {
    if (!model) return;
    const num = roh === '' ? null : Number(roh);
    onCostChange(model, {
      input_usd_per_1m:       feld === 'in'         ? num : (costValue?.input_usd_per_1m       ?? null),
      output_usd_per_1m:      feld === 'out'        ? num : (costValue?.output_usd_per_1m      ?? null),
      cache_write_usd_per_1m: feld === 'cacheWrite' ? num : (costValue?.cache_write_usd_per_1m ?? null),
      cache_read_usd_per_1m:  feld === 'cacheRead'  ? num : (costValue?.cache_read_usd_per_1m  ?? null),
      // Ein von Hand geänderter Preis ist ab sofort „manuell" – die
      // Empfehlungs-Übernahme überschreibt einen solchen Wert nie, sondern
      // meldet ihn als übersprungen. Ohne diese Markierung wäre die einzige
      // Alternative, Feed-Preise gar nicht zu schreiben.
      quelle: 'manuell',
    });
  }

  return (
    <div className="py-3 border-b border-border/40 last:border-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium">{cls.label}</p>
          <p className="text-xs text-muted-foreground">{cls.desc}</p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          {laedt ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Spinner className="h-3.5 w-3.5" />Lade…
            </div>
          ) : brauchtFreitext ? (
            <>
              <select
                value={providerId}
                onChange={(e) => {
                  const pid = e.target.value;
                  // Modell-Text nur behalten, wenn der Provider gleich bleibt –
                  // sonst gehört er zum vorherigen Provider (siehe Analyse in
                  // EmbeddingCard.jsx, derselbe Bug: Modellname eines anderen
                  // Providers wird sonst stillschweigend mit übernommen).
                  handleFreitext(pid, pid === providerId ? model : '');
                }}
                className="h-8 text-xs rounded-md border border-input bg-background px-2 py-0 cursor-pointer"
              >
                {!providerId && <option value="">Provider wählen…</option>}
                {aktiveProvider.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <input
                value={model}
                onChange={(e) => handleFreitext(providerId, e.target.value)}
                placeholder="Modell-ID eingeben…"
                className="h-8 w-[220px] text-xs rounded-md border border-input bg-background px-2 font-mono"
              />
              {modelleDesProviders.length > 0 && (
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Aus Liste wählen"
                        onClick={() => setFreitext(false)}>
                  <ListRestart className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          ) : (
            <>
              <select
                value={auswahlwert}
                onChange={(e) => handleAuswahl(e.target.value)}
                className="h-8 max-w-[300px] text-xs rounded-md border border-input bg-background px-2 py-0 cursor-pointer"
              >
                {/* Gespeicherter Wert, den keine Liste kennt (auch nicht als
                    Alias): sichtbar halten, statt ihn beim ersten Rendern
                    still durch die erste Option zu ersetzen. */}
                {model && !liveEintrag && (
                  <option value={kennenwert}>
                    {prov?.label ?? providerId} · {model}{verfuegbar === false ? ' (nicht verfügbar)' : ''}
                  </option>
                )}
                {!model && <option value={kennenwert}>Modell wählen…</option>}
                {aktiveProvider.map((p) => (
                  (p.models || []).length > 0 && (
                    <optgroup key={p.id} label={p.label}>
                      {p.models.map((m) => (
                        <option key={`${p.id}${TRENNZEICHEN}${m.id}`} value={`${p.id}${TRENNZEICHEN}${m.id}`}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </optgroup>
                  )
                ))}
              </select>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Modell-ID von Hand eintragen"
                      onClick={() => setFreitext(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          {model && !laedt && listeVorhanden && (
            verfuegbar === false
              ? <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" title="Modell nicht verfügbar" />
              : verfuegbar === true
                ? <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" title="Modell verfügbar" />
                : null
          )}
        </div>
      </div>

      {model && !laedt && verfuegbar === false && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">
            Der Provider <strong>{prov?.label ?? providerId}</strong> listet{' '}
            <strong className="font-mono">{model}</strong> nicht. Bitte ein anderes Modell wählen.
          </p>
        </div>
      )}

      {/* Text-Degrade: bewusst amber, nicht destructive. Das ist eine
          Konfigurationseigenschaft, kein Fehler – destructive ist oben für
          „Modell nicht verfügbar" reserviert. Eine Warnung, ein Ort: derselbe
          Hinweis erscheint nirgends sonst nochmal. */}
      {!laedt && aufgeloest?.textOnly && !wert && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Dieser Provider verarbeitet keine PDFs. Postbuch schickt stattdessen den lokal
            extrahierten Text – die vorhandene Textebene wird dann nie entfernt, und ein
            reiner Scan ohne OCR läuft in den Fallback statt zu raten.
          </p>
        </div>
      )}

      {model && zeigeKosten && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <span className="font-mono text-[10px] text-muted-foreground/60 select-none">$/1M</span>
          {PREISFELDER.map((f) => (
            <label key={f.feld} className="flex items-center gap-1" title={f.titel}>
              <span>{f.label}</span>
              <input type="number" min="0" step="0.001" placeholder="–" value={werte[f.feld]}
                     onChange={(e) => handleCostChange(f.feld, e.target.value)}
                     className="w-20 h-6 rounded border border-input bg-background px-1.5 text-xs tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
            </label>
          ))}
          {/* Der Preis hängt an der Modell-ID, nicht am Provider (Setting
              llm_cost_<modelId>). Solange dieselbe ID nur bei einem Provider
              vorkommt, ist das unsichtbar – sonst muss es dastehen, statt im
              UI etwas anderes zu behaupten als gespeichert wird. */}
          {costValue?.quelle === 'feed' && (
            <span className="text-[10px] text-muted-foreground/70" title="Preis stammt aus den Modellempfehlungen von postbuch.net">
              aus Feed
            </span>
          )}
          {kostenGeteilt && (
            <span className="text-[10px] text-muted-foreground/70">
              gilt für alle Provider mit dieser Modell-ID
            </span>
          )}
        </div>
      )}
    </div>
  );
}

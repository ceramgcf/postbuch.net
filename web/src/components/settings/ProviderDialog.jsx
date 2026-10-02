/**
 * ProviderDialog – Anlegen und Bearbeiten eines KI-Providers
 *
 * Auflagen, die hier eingelöst werden:
 *
 *  • Geschrieben wird ausschließlich über `PUT /ai/providers/:id` bzw.
 *    `.../key`, nie über den generischen `PUT /api/settings/:key`. Der
 *    generische Weg überspringt die URL-Validierung, das Verbot von
 *    `user:pass@` und die Typ-Sperre für Built-ins – deshalb steht
 *    `llm_providers` gar nicht erst in ALLOWED_SETTING_KEYS.
 *  • Der Key kommt nie vom Server zurück; hier gibt es nur ein Schreibfeld.
 *    Beim Schließen wird der lokale State ausdrücklich geleert, damit der
 *    Klartext-Key den Dialog nicht überlebt.
 *  • „Darf ins Heimnetz" erscheint nur, wenn die eingetragene Adresse
 *    tatsächlich privat wirkt. Eine immer sichtbare Checkbox wird vorsorglich
 *    angehakt – und dann erbt jeder später angelegte Provider den
 *    aufgeweiteten Guard.
 *  • Löschen ist zweistufig: der erste Versuch läuft ohne `force` und liefert
 *    bei Verwendung ein 409 mit `benutztVon`. Erst danach gibt es den zweiten
 *    Knopf. `force=1` im ersten Versuch gäbe es nicht.
 */

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { wirktPrivat } from '@/lib/net-heuristics';
import { Eye, EyeOff, AlertTriangle, ShieldAlert, Trash2, CheckCircle2 } from 'lucide-react';

export const CAP_LABEL = {
  pdf:         'PDF-Dokumente direkt verarbeiten',
  vision:      'Bilder verstehen (PDF wird für dieses Modell gerastert)',
  tools:       'Werkzeuge/Tool-Calling',
  streaming:   'Antworten streamen',
  promptCache: 'Prompt-Caching',
  embeddings:  'Embeddings erzeugen',
};

/** Aus einem Label eine gültige, freie Provider-ID ableiten. */
function idAusLabel(label, vergeben) {
  const basis = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider';
  if (!vergeben.includes(basis)) return basis;
  // Ohne Suffix überschriebe ein zweites „Ollama" das erste lautlos.
  for (let i = 2; i < 100; i++) if (!vergeben.includes(`${basis}-${i}`)) return `${basis}-${i}`;
  return `${basis}-${Date.now().toString(36)}`;
}

export default function ProviderDialog({
  open, onClose, provider, presets, capKeys, builtinIds, vergebeneIds,
  allowPrivateGlobal, rasterDefault = 8, rasterGrenze = 32,
  maxOutMin = 256, maxOutGrenze = 200000, onSaved,
}) {
  const neu = !provider;
  const builtin = !!provider && builtinIds.includes(provider.id);

  const [label, setLabel]     = useState('');
  const [typ, setTyp]         = useState('openai-compatible');
  const [dialekt, setDialekt] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [aktiv, setAktiv]     = useState(true);
  const [caps, setCaps]       = useState({});
  const [rasterMax, setRasterMax] = useState('');   // leer = Standard
  const [maxOut, setMaxOut]   = useState('');       // leer = kein eigenes Limit
  const [privat, setPrivat]   = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [zeigeKey, setZeigeKey] = useState(false);
  const [region, setRegion]     = useState('');
  const [fehler, setFehler]     = useState('');
  const [benutztVon, setBenutztVon] = useState(null);

  // Beim Öffnen aus dem Provider befüllen, beim Schließen alles leeren –
  // insbesondere den Klartext-Key.
  useEffect(() => {
    if (!open) {
      setKeyInput(''); setZeigeKey(false); setFehler(''); setBenutztVon(null);
      return;
    }
    setLabel(provider?.label ?? '');
    setTyp(provider?.typ ?? 'openai-compatible');
    setDialekt(provider?.dialekt ?? 'openai');
    setBaseUrl(provider?.baseUrl ?? '');
    setAktiv(provider?.aktiv !== false);
    setCaps({ ...(provider?.caps ?? {}) });
    setRasterMax(provider?.rasterMaxSeiten != null ? String(provider.rasterMaxSeiten) : '');
    setMaxOut(provider?.maxOutputTokens != null ? String(provider.maxOutputTokens) : '');
    setPrivat(provider?.erlaubtPrivateZiele === true);
    setKeyInput(''); setZeigeKey(false); setFehler(''); setBenutztVon(null);
  }, [open, provider]);

  function presetAnwenden(p) {
    setLabel((l) => l || p.label);
    setTyp(p.typ);
    setDialekt(p.dialekt);
    setBaseUrl(p.baseUrl ?? '');
    if (p.caps) setCaps({ ...p.caps });
  }

  const mSpeichern = useMutation({
    mutationFn: async () => {
      const id = provider?.id ?? idAusLabel(label.trim() || 'provider', vergebeneIds);
      await api.settings.ai.providers.save(id, {
        label: label.trim(), typ, dialekt, baseUrl: baseUrl.trim() || null,
        aktiv, caps, erlaubtPrivateZiele: privat,
        // Auch mitschicken, wenn das Feld gerade ausgeblendet ist (PDF wieder
        // angehakt): sonst verlöre ein Speichern den Wert still.
        rasterMaxSeiten: rasterMax.trim() === '' ? null : Number(rasterMax),
        maxOutputTokens: maxOut.trim() === '' ? null : Number(maxOut),
      });
      // Key getrennt – er geht nie durch dieselbe Route wie die Identität.
      if (keyInput.trim()) await api.settings.ai.providers.setKey(id, keyInput.trim());
      // Bedrock trägt seine Region außerhalb des Provider-Schemas.
      if (typ === 'bedrock' && region.trim()) {
        await api.settings.ai.setKey('bedrock', keyInput.trim(), region.trim());
      }
      return id;
    },
    onSuccess: () => { onSaved?.(); onClose(); },
    onError: (e) => setFehler(e.message),
  });

  const mLoeschen = useMutation({
    mutationFn: (force) => api.settings.ai.providers.remove(provider.id, force),
    onSuccess: () => { onSaved?.(); onClose(); },
    onError: (e) => {
      // 409 mit benutztVon: Klartext zeigen, statt still zu erzwingen.
      const liste = e?.payload?.benutztVon;
      if (Array.isArray(liste) && liste.length) setBenutztVon(liste);
      else setFehler(e.message);
    },
  });

  const urlPrivat = wirktPrivat(baseUrl);
  const brauchtUrl = typ === 'openai-compatible';
  // Der mit Abstand häufigste Tippfehler: baseUrl ohne /v1. Der Server
  // antwortet dann je nach Produkt mit 404 oder – LM Studio – mit HTTP 200 und
  // einem Fehlerobjekt, die Modell-Liste bliebe leer. Nur ein Hinweis, keine
  // Sperre: LiteLLM & Co. dürfen durchaus unter / laufen.
  const urlOhneV1 = brauchtUrl && baseUrl.trim() !== '' && !/\/v1\/*$/.test(baseUrl.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} size="lg">
      <DialogTitle>{neu ? 'KI-Provider hinzufügen' : `${provider.label} bearbeiten`}</DialogTitle>
      <DialogDescription>
        {builtin
          ? 'Eingebauter Provider – Typ und Kennung liegen fest, alles andere ist änderbar.'
          : 'Ein OpenAI-kompatibler Endpunkt: Ollama, LM Studio, vLLM, LiteLLM, OpenRouter und viele mehr.'}
      </DialogDescription>

      <div className="mt-4 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
        {neu && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Vorlage</label>
            <div className="flex flex-wrap gap-1.5">
              {(presets || []).map((p) => (
                <button key={p.key} type="button" onClick={() => presetAnwenden(p)}
                        className="rounded-full border border-border/70 px-2.5 py-1 text-xs hover:bg-accent transition-colors">
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)}
                 placeholder="z. B. Ollama (Keller-PC)" className="h-9 text-sm" />
          <p className="text-xs text-muted-foreground">
            Wird auch Nicht-Administratoren angezeigt – also besser kein Hostname darin.
          </p>
        </div>

        {!builtin && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Typ</label>
              <select value={typ} onChange={(e) => setTyp(e.target.value)}
                      className="h-9 w-full text-sm rounded-md border border-input bg-background px-2">
                <option value="openai-compatible">OpenAI-kompatibel</option>
                <option value="anthropic">Anthropic</option>
                <option value="bedrock">AWS Bedrock</option>
              </select>
            </div>
            {typ === 'openai-compatible' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Dialekt</label>
                <select value={dialekt} onChange={(e) => setDialekt(e.target.value)}
                        className="h-9 w-full text-sm rounded-md border border-input bg-background px-2">
                  <option value="openai">OpenAI (Standard)</option>
                  <option value="ollama">Ollama</option>
                  <option value="lmstudio">LM Studio</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Ollama will <span className="font-mono">format</span> statt{' '}
                  <span className="font-mono">response_format</span>. LM Studio verlangt bei
                  Bild-Uploads rohes Base64 statt einer data:-URL.
                </p>
              </div>
            )}
          </div>
        )}

        {(brauchtUrl || baseUrl) && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Basis-URL</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                   placeholder="http://host.docker.internal:11434/v1"
                   className="h-9 text-sm font-mono" spellCheck={false} />
            {urlOhneV1 && (
              <p className="text-xs text-muted-foreground">
                Endet nicht auf <span className="font-mono">/v1</span> – LM Studio, Ollama und
                vLLM erwarten den Pfad genau so. Fehlt er, bleibt die Modell-Liste leer.
              </p>
            )}
            {urlPrivat && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                <div className="space-y-1.5 text-xs">
                  <p>Diese Adresse liegt in deinem Heimnetz. postbuch.net verbindet sich dorthin
                     nur, wenn du es hier ausdrücklich erlaubst.</p>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={privat} className="mt-0.5"
                           onChange={(e) => setPrivat(e.target.checked)} />
                    <span>Dieser Anbieter darf Adressen in meinem Heimnetz erreichen</span>
                  </label>
                  {allowPrivateGlobal && (
                    <p className="text-muted-foreground">
                      Hinweis: Der globale Schalter für private Ziele ist bereits aktiv –
                      diese Einzelfreigabe ändert dann nichts mehr.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {provider?.hatKey ? 'Neuer API-Key (leer = unverändert)' : 'API-Key'}
          </label>
          <div className="relative">
            <Input type={zeigeKey ? 'text' : 'password'} value={keyInput}
                   onChange={(e) => setKeyInput(e.target.value)}
                   placeholder={provider?.hatKey
                     ? '••••••••••••••••'
                     : (urlPrivat ? 'Bei lokalen Servern meist nicht nötig' : 'Erforderlich')}
                   className="h-9 text-sm font-mono pr-9" autoComplete="new-password" />
            <button type="button" onClick={() => setZeigeKey(!zeigeKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {zeigeKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {typ === 'bedrock' && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">AWS-Region</label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)}
                   placeholder="eu-central-1" className="h-9 text-sm font-mono" />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Fähigkeiten</label>
          <p className="text-xs text-muted-foreground">
            Werden nicht geprüft, sondern geglaubt: ein Modell nimmt einen PDF-Block auch
            dann entgegen, wenn es ihn nicht lesen kann – und halluziniert dann, statt zu
            scheitern. Im Zweifel aus lassen.
          </p>
          <p className="text-xs text-muted-foreground">
            Maßgeblich für Dokumente ist zuerst <span className="font-mono">PDF</span>: der
            PDF-Datei-Block ist eine OpenAI-Eigenheit, lokale Server wie LM Studio lehnen ihn
            ab. Ohne PDF-Häkchen, aber mit <span className="font-mono">Vision</span>, werden
            die Seiten lokal zu Bildern gerendert und als Bild-Blöcke geschickt. Ohne beides
            bekommt der Provider nur den lokal ausgelesenen Text.
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1">
            {(capKeys || []).map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={caps[k] === true}
                       onChange={(e) => setCaps((c) => ({ ...c, [k]: e.target.checked }))} />
                <span>{CAP_LABEL[k] || k}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Nur sichtbar, wenn der Rasterpfad überhaupt greift – dieselbe
            Bedingung wie im Backend (makeDocPreparer: vision, kein PDF, und
            der Bild-Block existiert nur im OpenAI-kompatiblen Adapter). */}
        {typ === 'openai-compatible' && caps.vision === true && caps.pdf !== true && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Seitenlimit beim Rastern
            </label>
            <Input type="number" min="1" max={rasterGrenze} value={rasterMax}
                   onChange={(e) => setRasterMax(e.target.value)}
                   placeholder={`${rasterDefault} (Standard)`}
                   className="h-9 w-28 text-sm" />
            <p className="text-xs text-muted-foreground">
              Jede gerasterte Seite kostet grob 1000–2000 Tokens – bei kleinen lokalen
              Kontextfenstern (4k–8k) sprengen mehr als ein paar Seiten das Fenster, bevor
              der Prompt überhaupt Platz hat. Bei der Klassifikation bricht ein Überschreiten
              hart ab (das nächste Modell der Kette übernimmt), bei der Voranalyse wird still
              gekürzt.
            </p>
            <p className="text-xs text-muted-foreground">
              Leer lassen für den Standard. Mehr als {rasterGrenze} sind nicht möglich, und
              schon davor greift oft die Größenbremse: passen die Bilder zusammen nicht in
              12&nbsp;MB, wird die Auflösung halbiert und andernfalls abgebrochen.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Limit für Antwort-Tokens
          </label>
          <Input type="number" min={maxOutMin} max={maxOutGrenze} value={maxOut}
                 onChange={(e) => setMaxOut(e.target.value)}
                 placeholder="kein Limit"
                 className="h-9 w-32 text-sm" />
          <p className="text-xs text-muted-foreground">
            Wie viele Tokens dieser Anbieter in einer Antwort höchstens liefern darf. Leer lassen,
            solange nichts dagegen spricht – postbuch.net fordert dann so viel an, wie die jeweilige
            Aufgabe braucht. Lehnt der Anbieter das ab, wiederholt postbuch.net den Aufruf einmal mit
            einem kleinen Wert und schreibt eine Warnung ins Protokoll; hier eingetragen, entfällt
            dieser Umweg.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={aktiv} onChange={(e) => setAktiv(e.target.checked)} />
          <span>Aktiv (steht in der Modellauswahl zur Verfügung)</span>
        </label>

        {fehler && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{fehler}</span>
          </div>
        )}

        {benutztVon && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
            <p className="font-medium">Dieser Provider wird noch verwendet von:</p>
            <div className="flex flex-wrap gap-1">
              {benutztVon.map((b) => <Badge key={b} variant="outline" className="text-[10px]">{b}</Badge>)}
            </div>
            <p>Löschst du ihn trotzdem, fallen diese Stufen auf ihren Standard zurück.</p>
            <Button variant="destructive" size="sm" className="h-7 text-xs"
                    onClick={() => mLoeschen.mutate(true)} disabled={mLoeschen.isPending}>
              Trotzdem löschen
            </Button>
          </div>
        )}
      </div>

      <DialogFooter className="justify-between">
        <div>
          {!neu && !builtin && !benutztVon && (
            <Button variant="ghost" size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => mLoeschen.mutate(false)} disabled={mLoeschen.isPending}>
              <Trash2 className="h-3.5 w-3.5" /> Löschen
            </Button>
          )}
          {builtin && (
            <span className="text-xs text-muted-foreground self-center">
              Eingebaute Provider lassen sich deaktivieren, aber nicht löschen.
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Abbrechen</Button>
          <Button size="sm" disabled={mSpeichern.isPending || !label.trim()}
                  onClick={() => { setFehler(''); mSpeichern.mutate(); }}>
            {mSpeichern.isPending ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Speichern
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

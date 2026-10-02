/**
 * ProviderCard – die Liste der KI-Provider
 *
 * Ersetzt die drei festen ApiKeyCards (OpenAI/Anthropic/Bedrock). Ein
 * Bestandsnutzer sieht danach dieselben drei Anbieter als Zeilen statt als
 * Karten – gleiche Status-Symbolik (`ShieldCheck`/`ShieldX`), keine
 * Neukonfiguration, weil die Built-ins ihre Alt-Keys weiter lesen.
 *
 * Capabilities stehen als sechs kleine Icons mit Tooltip in der Zeile (an/aus
 * per Opazität), nicht als Checkbox-Tabelle – sonst sieht die Seite aus wie
 * ein Router-Konfigurationsmenü. Die echten Checkboxen liegen im Dialog.
 *
 * Die `baseUrl` wird als Text gerendert, nie als `<a href>`: das Protokoll
 * wird nur in der dedizierten Schreibroute geprüft, und ein gespeichertes
 * `javascript:` wäre sonst Stored XSS im Admin-UI.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Testergebnis } from '@/components/ui/testergebnis';
import ProviderDialog, { CAP_LABEL } from './ProviderDialog';
import {
  Cpu, Plus, Settings2, PlayCircle, ShieldCheck, ShieldX,
  FileText, Image, Wrench, Zap, Database, Binary, Sparkles,
} from 'lucide-react';

// Reihenfolge = CAP_KEYS aus lib/llm/registry.js.
// `Image` statt `Eye`: Eye ist im UI durchgehend für „Passwort anzeigen"
// vergeben, eine Doppelverwendung würde die Bedeutung verwischen.
const CAP_ICON = {
  pdf: FileText, vision: Image, tools: Wrench,
  streaming: Zap, promptCache: Database, embeddings: Binary,
};

const TYP_LABEL = {
  'openai-compatible': 'OpenAI-kompatibel',
  anthropic: 'Anthropic',
  bedrock: 'Bedrock',
  subscription: 'Abo',
};

function ProviderRow({ p, health, capKeys, onEdit, onTested }) {
  const [testFehler, setTestFehler] = useState('');
  const [testOk, setTestOk] = useState(null);

  const mTest = useMutation({
    mutationFn: () => api.settings.ai.providers.test(p.id),
    onSuccess: (r) => { setTestFehler(''); setTestOk(r.models?.length ?? 0); onTested?.(); },
    onError: (e) => { setTestOk(null); setTestFehler(e.message); },
  });

  const h = health?.providers?.[p.id];
  const konfiguriert = h?.configured ?? p.hatKey;
  const laeuft = h?.working;

  return (
    <div className="py-3 border-b border-border/40 last:border-0">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{p.label}</span>
            <Badge variant="outline" className="text-[10px]">{TYP_LABEL[p.typ] || p.typ}</Badge>
            {p.builtin && <Badge variant="secondary" className="text-[10px]">eingebaut</Badge>}
            {p.aktiv === false && <Badge variant="secondary" className="text-[10px]">inaktiv</Badge>}
          </div>
          {p.baseUrl && (
            <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">{p.baseUrl}</p>
          )}
        </div>

        {/* Capabilities */}
        <div className="flex items-center gap-1.5">
          {(capKeys || []).map((k) => {
            const Icon = CAP_ICON[k];
            if (!Icon) return null;
            const an = p.caps?.[k] === true;
            return (
              <Icon key={k}
                    className={`h-3.5 w-3.5 ${an ? 'text-foreground/70' : 'text-muted-foreground/25'}`}
                    title={`${CAP_LABEL[k] || k}: ${an ? 'unterstützt' : 'nicht unterstützt'}`} />
            );
          })}
        </div>

        {/* Status */}
        <div className="flex items-center gap-1.5 w-[130px] justify-end">
          {!konfiguriert ? (
            <span className="text-[11px] text-muted-foreground">nicht konfiguriert</span>
          ) : laeuft ? (
            <><ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400">erreichbar</span></>
          ) : (
            <><ShieldX className="h-3.5 w-3.5 text-destructive" />
              <span className="text-[11px] text-destructive">Fehler</span></>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Verbindung testen"
                  disabled={mTest.isPending} onClick={() => mTest.mutate()}>
            {mTest.isPending ? <Spinner className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Bearbeiten" onClick={onEdit}>
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Der Fehlertext ist serverseitig bereits entschärft (clientSafeError):
          bei einem privaten Ziel steht hier nie die Antwort der Gegenstelle. */}
      {(h?.error || testFehler) && (
        <Testergebnis status="fehler">{testFehler || h.error}</Testergebnis>
      )}
      {testOk !== null && !testFehler && (
        <Testergebnis status="erfolg">Verbindung steht – {testOk} Modell(e) gefunden.</Testergebnis>
      )}
    </div>
  );
}

export default function ProviderCard({ health, onChanged }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState(null);   // { provider } | { neu: true } | null

  const { data, isLoading } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => api.settings.ai.providers.list(),
    retry: false,
  });

  const providers = data?.providers || [];
  const openaiProvider = providers.find((p) => p.id === 'openai');
  const openaiKonfiguriert = health?.providers?.openai?.configured ?? openaiProvider?.hatKey;

  function nachAenderung() {
    qc.invalidateQueries({ queryKey: ['ai-providers'] });
    onChanged?.();
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">KI-Provider</CardTitle>
          <Button size="sm" variant="outline" className="ml-auto h-7 text-xs"
                  onClick={() => setDialog({ neu: true })}>
            <Plus className="h-3.5 w-3.5" /> Hinzufügen
          </Button>
        </div>
        <CardDescription className="text-xs pt-1">
          Cloud-Anbieter und lokale Server (Ollama, LM Studio, …) nebeneinander. Welches
          Modell welche Aufgabe übernimmt, wird darunter festgelegt.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Der mit Abstand häufigste Einstieg: OpenAI ist schon als Zeile da,
            geht darin aber unter — "Hinzufügen" legt sonst ein funktionsarmes
            Duplikat an, statt den Nutzer zum Bearbeiten-Symbol der bestehenden
            Zeile zu führen. */}
        {!isLoading && openaiProvider && !openaiKonfiguriert && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="h-4 w-4 shrink-0 text-primary" />
              <p className="text-xs text-foreground/90">
                <span className="font-medium">Noch kein KI-Provider eingerichtet.</span> OpenAI ist
                bereits als eingebauter Provider vorhanden – nur der API-Key fehlt noch.
              </p>
            </div>
            <Button size="sm" className="h-7 text-xs shrink-0"
                    onClick={() => setDialog({ provider: openaiProvider })}>
              OpenAI einrichten
            </Button>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />Lade…
          </div>
        ) : (
          providers.map((p) => (
            <ProviderRow key={p.id} p={p} health={health} capKeys={data.capKeys}
                         onEdit={() => setDialog({ provider: p })}
                         onTested={nachAenderung} />
          ))
        )}
      </CardContent>

      {dialog && (
        <ProviderDialog
          open={!!dialog}
          onClose={() => setDialog(null)}
          provider={dialog.provider}
          presets={data?.presets}
          capKeys={data?.capKeys}
          builtinIds={data?.builtinIds || []}
          vergebeneIds={providers.map((p) => p.id)}
          allowPrivateGlobal={data?.allowPrivateGlobal}
          rasterDefault={data?.rasterMaxSeitenDefault}
          rasterGrenze={data?.rasterMaxSeitenGrenze}
          maxOutMin={data?.maxOutputTokensMin}
          maxOutGrenze={data?.maxOutputTokensGrenze}
          onSaved={nachAenderung}
        />
      )}
    </Card>
  );
}

import { useId, useState, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDashboardStats } from '@/hooks/usePostbuch';
import { useSaldenList } from '@/hooks/useSalden';
import { useWiedervorlagenDashboard } from '@/hooks/useWiedervorlagen';
import { useAuth } from '@/hooks/useAuth';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArtBadge } from '@/components/postbuch/ArtBadge';
import { LebensbereichBadge } from '@/components/postbuch/LebensbereichBadge';
import { PageLoader } from '@/components/ui/spinner';
import { formatCurrency, formatDate } from '@/lib/utils';
import { api } from '@/api/client';
import { ablageLabel } from '@/lib/ablage';
import { empfohlenerSchritt, offeneReste } from '@/pages/AblageUmzugPage';
import PendingDecisionsCard from '@/components/dashboard/PendingDecisionsCard';
import FailedDocumentsCard from '@/components/dashboard/FailedDocumentsCard';
import PersonenFilter, { useDashboardPersonenFilter } from '@/components/dashboard/PersonenFilter';
import { MODEL_CLASSES } from '@/components/settings/modelClasses';

function BackupBanner() {
  const { isAdmin } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['backup-status-public'],
    queryFn: () => api.settingsPublic.backupStatus(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (isLoading || !data || data.enabled) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
      <svg className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-destructive">Kein Backup aktiv</p>
        <p className="mt-0.5 text-xs text-destructive/80">
          Ohne aktives Backup gehen Dokumente und Daten bei einem Ausfall unwiederbringlich verloren.
          {!isAdmin && ' Bitte einen Admin, es zu aktivieren.'}
        </p>
      </div>
      {isAdmin && (
        <Link to="/einstellungen?tab=backup" className="text-xs text-destructive underline underline-offset-2 whitespace-nowrap shrink-0 mt-0.5">
          Jetzt aktivieren →
        </Link>
      )}
    </div>
  );
}

function UpdateBanner() {
  const { isAdmin } = useAuth();
  const { data: update, isLoading } = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    enabled: isAdmin,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  if (!isAdmin || isLoading || !update?.updateVerfuegbar) return null;
  const sicherheit = update.sicherheitsrelevant === true;

  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
      sicherheit
        ? 'border-amber-500/40 bg-amber-500/8'
        : 'border-primary/30 bg-primary/5'
    }`}>
      <svg className={`h-4 w-4 shrink-0 mt-0.5 ${sicherheit ? 'text-amber-500' : 'text-primary'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5M12 15V3" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{sicherheit ? 'Sicherheitsupdate verfügbar' : 'Update verfügbar'}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Version {update.verfuegbar} kann installiert werden.</p>
      </div>
      <Link to="/einstellungen?tab=allgemein" className="text-xs text-primary underline underline-offset-2 whitespace-nowrap shrink-0 mt-0.5">
        Zu Updates →
      </Link>
    </div>
  );
}

function AiHealthBanner() {
  const { isAdmin } = useAuth();
  const { data: health, isLoading } = useQuery({
    queryKey: ['ai-health-public'],
    queryFn: () => api.settingsPublic.ai.health(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (isLoading || !health) return null;

  // Seit Phase 5 providergetrieben statt auf OpenAI/Anthropic verdrahtet.
  // Vorher galt „OpenAI-Key fehlt" als harter Fehler – auf einer bewusst
  // cloudfreien Instanz wäre das ein Dauer-Alarm. Und der Modell-Filter hing an
  // `openai?.working || anthropic?.working`, sodass eine reine Ollama-Installation
  // über nicht verfügbare Modelle gar nicht mehr informiert worden wäre.
  //
  // Gemeldet wird nur, was auch benutzt wird (`benutzt`, von ai-health.js
  // anhand der Modellklassen-Zuweisungen ermittelt) – ein Key "auf Vorrat"
  // oder ein bewusst deaktivierter Provider soll hier keinen Alarm auslösen.
  const issues = [];
  const providerBerichte = Object.values(health.providers || {}).filter((p) => p.benutzt);

  for (const p of providerBerichte) {
    if (p.configured && !p.working) {
      issues.push(`${p.label}: ${p.error || 'nicht erreichbar'}`);
    }
  }

  // Nur melden, wenn der zuständige Provider erreichbar ist – ein offline
  // Provider kann kein Modell widerlegen, das wäre eine Folgemeldung.
  // Gruppiert je Modell, damit ein von mehreren Klassen genutztes Modell nur
  // einmal erscheint – mit den betroffenen Klassen dahinter.
  const nichtVerfuegbar = new Map();
  for (const cls of MODEL_CLASSES) {
    const m = health.models?.[cls.key];
    if (!m?.model || !health.providers?.[m.providerId]?.working || m.available !== false) continue;
    const name = `${m.providerLabel || m.providerId}: ${m.model}`;
    nichtVerfuegbar.set(name, [...(nichtVerfuegbar.get(name) || []), cls.label]);
  }
  for (const [name, klassen] of nichtVerfuegbar) {
    issues.push(`Modell ${name} wird vom Provider nicht mehr gelistet (${klassen.join(', ')}).`);
  }

  // Gar kein erreichbarer Provider ⇒ die Pipeline kann nichts klassifizieren.
  // Nur relevant, wenn überhaupt ein Provider benutzt wird.
  if (providerBerichte.length > 0 && !providerBerichte.some((p) => p.working)) {
    issues.push('Kein KI-Provider erreichbar – Dokumente können nicht analysiert werden.');
  }

  if (issues.length === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3">
      <svg className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-destructive">KI-Konfiguration fehlerhaft</p>
        <ul className="mt-1 space-y-0.5">
          {issues.map((msg, i) => <li key={i} className="text-xs text-destructive/80">{msg}</li>)}
        </ul>
      </div>
      {isAdmin ? (
        <Link to="/einstellungen?tab=ki" className="text-xs text-destructive underline underline-offset-2 whitespace-nowrap flex-shrink-0 mt-0.5">
          Zu den KI-Einstellungen →
        </Link>
      ) : (
        <span className="text-xs text-destructive/80 flex-shrink-0 mt-0.5">Bitte einen Admin informieren.</span>
      )}
    </div>
  );
}

// ── FailedDocumentsBanner ─────────────────────────────────────────────────────
// Erscheint oben auf dem Dashboard, solange es neue fehlgeschlagene Dokumente
// seit dem letzten Besuch der Logs/Jobs-Seite gibt. Persistiert dank localStorage.

export const FAILED_DOCS_LAST_SEEN_KEY = 'failed_docs_last_seen';

function FailedDocumentsBanner() {
  const { data: failed = [], isLoading } = useQuery({
    queryKey: ['failed-documents'],
    queryFn: () => api.failedDocuments.list(),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading || !failed.length) return null;

  const lastSeen = parseInt(localStorage.getItem(FAILED_DOCS_LAST_SEEN_KEY) || '0', 10);
  const hasNew = failed.some(d => new Date(d.failed_at).getTime() > lastSeen);
  if (!hasNew) return null;

  const hasQuotaError = failed.some(d =>
    /quota|Guthaben|aufgebraucht|rate.?limit|billing|credit/i.test(d.reason || '')
  );
  const count = failed.length;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/8 px-4 py-3">
      <svg className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
          {count === 1
            ? '1 Dokument konnte nicht verarbeitet werden'
            : `${count} Dokumente konnten nicht verarbeitet werden`}
        </p>
        {hasQuotaError ? (
          <p className="mt-0.5 text-xs text-amber-600/80 dark:text-amber-400/80">
            API-Guthaben möglicherweise aufgebraucht – Guthaben prüfen, dann Dokumente in Logs/Jobs wiederholen.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-amber-600/80 dark:text-amber-400/80">
            Details und Wiederholung in Logs/Jobs.
          </p>
        )}
      </div>
      <Link
        to="/logs?tab=jobs"
        className="text-xs text-amber-600 dark:text-amber-400 underline underline-offset-2 whitespace-nowrap flex-shrink-0 mt-0.5"
      >
        Zu Logs/Jobs →
      </Link>
    </div>
  );
}

// ── MissingEmbeddingsBanner ───────────────────────────────────────────────────
// Erscheint wenn mindestens ein Dokument ohne semantisches Embedding existiert.
// Zeigt Anzahl, letzten Fehlerzeitpunkt + Fehlermeldung sowie Retry-Button.

function MissingEmbeddingsBanner() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['missing-embeddings'],
    queryFn: () => api.postbuch.missingEmbeddings(),
    staleTime: 60_000,
    retry: false,
  });

  const retryMutation = useMutation({
    mutationFn: () => api.actions.retryMissingEmbeddings(),
    onSuccess: () => {
      // Nach 5 Sekunden neu abfragen ob Embeddings jetzt vorhanden
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['missing-embeddings'] }), 5000);
    },
    onError: (err) => alert(`Fehler: ${err.message}`),
  });

  if (isLoading || !data?.count) return null;

  const count = data.count;
  // Neuester fehlgeschlagener Versuch (nach embedding_failed_at sortiert, NULLS LAST)
  const lastFailed = data.docs.find(d => d.embedding_failed_at);
  const lastAttempt = lastFailed
    ? new Date(lastFailed.embedding_failed_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
    : null;
  const lastError = lastFailed?.embedding_error;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/8 px-4 py-3">
      <svg className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
          {count === 1
            ? '1 Dokument ohne semantisches Embedding'
            : `${count} Dokumente ohne semantisches Embedding`}
        </p>
        <p className="mt-0.5 text-xs text-amber-600/80 dark:text-amber-400/80">
          Semantische Suche und Duplikat-Erkennung sind für diese Dokumente eingeschränkt.
          {lastAttempt && <span> · Letzter Versuch: {lastAttempt}</span>}
        </p>
        {lastError && (
          <p className="mt-0.5 text-xs text-amber-600/60 dark:text-amber-400/50 font-mono break-all">
            {lastError.slice(0, 100)}{lastError.length > 100 ? '…' : ''}
          </p>
        )}
      </div>
      <button
        onClick={() => retryMutation.mutate()}
        disabled={retryMutation.isPending || retryMutation.isSuccess}
        className="text-xs text-amber-600 dark:text-amber-400 underline underline-offset-2 whitespace-nowrap flex-shrink-0 mt-0.5 hover:text-amber-500 disabled:opacity-50 disabled:cursor-wait"
      >
        {retryMutation.isPending
          ? 'Wird gestartet…'
          : retryMutation.isSuccess
          ? 'Gestartet ✓'
          : 'Fehlende Embeddings nachholen'}
      </button>
    </div>
  );
}

// ── ScanRetryBanner ───────────────────────────────────────────────────────────
// Gelb: Scans warten auf Upload (automatischer Retry läuft).
// Rot:  Scans konnten nach max. Retries nicht hochgeladen werden → manuelle Aktion nötig.

function ScanRetryBanner() {
  const { data, isLoading } = useQuery({
    queryKey: ['scan-retry-queue'],
    queryFn: () => api.stats.scanRetryQueue(),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading || !data) return null;

  const { pending, manual_only } = data;

  if (manual_only > 0) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3">
        <svg className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive">
            {manual_only === 1
              ? '1 Scan konnte nicht hochgeladen werden – manuelle Aktion erforderlich'
              : `${manual_only} Scans konnten nicht hochgeladen werden – manuelle Aktion erforderlich`}
          </p>
          <p className="mt-0.5 text-xs text-destructive/80">
            Die maximale Anzahl automatischer Wiederholungsversuche wurde erreicht. Das PDF liegt lokal in
            <code className="mx-1 font-mono">/data/scan_buffer</code>und muss manuell erneut eingespielt werden.
          </p>
        </div>
        <a href="/logs?tab=jobs" className="text-xs text-destructive underline underline-offset-2 whitespace-nowrap flex-shrink-0 mt-0.5">
          Zu Logs/Jobs →
        </a>
      </div>
    );
  }

  if (pending > 0) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/8 px-4 py-3">
        <svg className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            {pending === 1
              ? '1 Scan wartet auf Upload – automatischer Retry läuft'
              : `${pending} Scans warten auf Upload – automatischer Retry läuft`}
          </p>
          <p className="mt-0.5 text-xs text-amber-600/80 dark:text-amber-400/80">
            Das PDF ist lokal gesichert. Sobald die Dateiablage wieder erreichbar ist, wird der Upload automatisch wiederholt.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Warnbanner zur Dateiablage.
 *
 * Fragt bewusst den **aktiven** Speicher ab und nicht mehr stur OneDrive: auf
 * einer Nextcloud-Instanz meldete der Banner sonst „OneDrive ist nicht
 * verbunden", obwohl die Dateiablage einwandfrei lief. Gemeckert wird nur, wenn das
 * tatsächlich benutzte Backend nicht konfiguriert oder nicht erreichbar ist.
 */
function AblageBanner() {
  const { data: status, isLoading } = useQuery({
    queryKey: ['ablage-status'],
    queryFn: () => api.storage.status(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (isLoading || !status) return null;
  if (status.verbunden) return null;

  const label = status.label || 'Die Dateiablage';
  const titel = status.problem === 'client_secret_abgelaufen'
    ? `${label}-Client-Secret abgelaufen`
    : status.problem === 'app_konfiguration_ungueltig'
      ? `${label}-App-Registrierung ungültig`
    : !status.konfiguriert
      ? `${label} ist noch nicht eingerichtet`
      : `${label} nicht erreichbar`;
  const msg = !status.konfiguriert
    ? `Es ist keine funktionierende Dateiablage eingerichtet. Ohne sie hat postbuch.net keine Dokumentenfunktion: Dokumente können weder aufgenommen, verarbeitet, geöffnet noch gesichert werden.`
    : status.problem === 'client_secret_abgelaufen'
      ? 'Das Client-Secret ist abgelaufen. Erzeuge in Azure ein neues Secret, trage es in den Dateiablage-Einstellungen ein und verbinde OneDrive danach neu.'
      : status.problem === 'app_konfiguration_ungueltig'
        ? 'Microsoft erkennt die eingetragene App-Registrierung nicht. Prüfe Client-ID und Mandant in den Dateiablage-Einstellungen und verbinde OneDrive danach neu.'
      : status.backend === 'nextcloud'
        ? `Die Nextcloud antwortet nicht${status.meldung ? `: ${status.meldung}` : '.'}`
        : 'Die Microsoft-Anmeldung ist abgelaufen. Bitte OneDrive neu verbinden.';

  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3">
      <svg className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-destructive">{titel}</p>
        <p className="mt-0.5 text-xs text-destructive/80">{msg}</p>
      </div>
      <Link to="/einstellungen?tab=onedrive" className="text-xs text-destructive underline underline-offset-2 whitespace-nowrap flex-shrink-0 mt-0.5">
        Zu den Dateiablage-Einstellungen →
      </Link>
    </div>
  );
}

/**
 * Warnbanner bei Mischbestand: Dokumente liegen noch im alten Backend, ein
 * Dateiablage-Umzug wurde begonnen, aber nicht abgeschlossen. Der Zustand ist
 * technisch unkritisch (beide Backends bleiben lesbar/schreibbar), soll aber
 * nicht unbemerkt bestehen bleiben — deshalb eigener Banner statt stiller
 * Duldung, mit direktem Link zum Fortsetzen des Umzugs.
 */
function StorageMischbestandBanner() {
  const { isAdmin } = useAuth();
  const { data: status, isLoading } = useQuery({
    queryKey: ['ablage-status'],
    queryFn: () => api.storage.status(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  // Läuft der Migrationsassistent noch an einem Lauf, übernimmt
  // AktivMigrationBanner die Meldung inklusive Link zum passenden Schritt –
  // sonst würden zwei Banner dasselbe Problem doppelt erklären.
  const { data: run, isLoading: runLoading } = useQuery({
    queryKey: ['migration', 'aktuell'],
    queryFn: () => api.migration.aktuell(),
    enabled: isAdmin,
    staleTime: 30_000,
    retry: false,
  });

  if (isLoading || (isAdmin && runLoading) || !status?.mischbestand) return null;
  // Nur zurücktreten, solange AktivMigrationBanner noch etwas zu melden hat –
  // ein bereits aufgeräumter Lauf (run.cleaned_at) zählt für getOffenenLauf()
  // im Backend bewusst weiter als „relevant" (siehe dortiger Kommentar), hier
  // aber nicht mehr als „läuft noch", sonst würde ein echter Mischbestand nach
  // einem abgeschlossenen Umzug stillschweigend verschwiegen.
  if (isAdmin && run && !run.cleaned_at) return null;

  const { fremdAnzahl, fremdBackends } = status.mischbestand;
  const fremdListe = fremdBackends.map((b) => `${b.anzahl} in ${b.label}`).join(', ');
  // Direkt auf den Schritt verlinken, wo sich der Rest tatsächlich auflösen
  // lässt: Läuft noch ein Lauf mit offenen Resten, ist das immer „kopieren"
  // (dort leben Restliste + die Sammelaktionen), unabhängig davon, wie weit
  // der Lauf sonst schon ist (auch nach „Trotzdem abschließen" oder einem
  // bereits umgeschalteten/aufgeräumten Lauf). Ohne fassbaren Lauf bleibt nur
  // der allgemeine Sprung in die Dateiablage-Einstellungen.
  const ziel = run
    ? (offeneReste(run) > 0 ? '/ablage-umzug/kopieren' : `/ablage-umzug/${empfohlenerSchritt(run)}`)
    : '/einstellungen?tab=onedrive';

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/8 px-4 py-3">
      <svg className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">Dateiablage-Umzug nicht abgeschlossen</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Aktive Dateiablage ist {status.label}, aber {fremdAnzahl === 1 ? 'noch ein Dokument liegt' : `noch ${fremdAnzahl} Dokumente liegen`} in
          einem anderen Backend ({fremdListe}). Setze den Umzug fort, um ihn abzuschließen.
        </p>
      </div>
      <Link to={ziel} className="text-xs text-amber-600 dark:text-amber-400 underline underline-offset-2 whitespace-nowrap shrink-0 mt-0.5">
        Umzug fortsetzen →
      </Link>
    </div>
  );
}

/**
 * Solange ein Migrationslauf des Assistenten offen ist (egal in welchem
 * Schritt), bleibt das für Admins sichtbar – mit direktem Sprung zurück in den
 * dafür passenden Assistentenschritt (empfohlenerSchritt, dieselbe Logik wie
 * beim Öffnen des Assistenten selbst). Ton unterscheidet sich bewusst: ein noch
 * laufender Umzug ist eine echte Erinnerung (amber), ein bereits umgeschalteter
 * Lauf mit nur noch offenem Aufräumen ist rein informativ (neutral).
 */
function AktivMigrationBanner() {
  const { isAdmin } = useAuth();
  const { data: run, isLoading } = useQuery({
    queryKey: ['migration', 'aktuell'],
    queryFn: () => api.migration.aktuell(),
    enabled: isAdmin,
    staleTime: 30_000,
    retry: false,
  });

  // run.cleaned_at heißt: inhaltlich fertig, nur die Erfolgsseite im
  // Assistenten bleibt erreichbar (siehe getOffenenLauf()-Kommentar im
  // Backend) – dafür braucht es hier keine Erinnerung mehr.
  if (!isAdmin || isLoading || !run || run.cleaned_at) return null;

  const nurAufraeumenOffen = !!run.switched_at && !run.cleaned_at;
  const ziel = empfohlenerSchritt(run);
  const farbe = nurAufraeumenOffen ? 'text-muted-foreground' : 'text-amber-500';

  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
      nurAufraeumenOffen ? 'border-border bg-muted/40' : 'border-amber-500/40 bg-amber-500/8'
    }`}>
      <svg className={`h-4 w-4 shrink-0 mt-0.5 ${farbe}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${nurAufraeumenOffen ? '' : 'text-amber-600 dark:text-amber-400'}`}>
          {nurAufraeumenOffen ? 'Dateiablage-Umzug: Quelle aufräumen offen' : 'Dateiablage-Umzug im Gange'}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {nurAufraeumenOffen
            ? `${ablageLabel(run.dst_backend)} ist bereits die aktive Dateiablage. Die kopierten Quelldateien in ${ablageLabel(run.src_backend)} lassen sich jetzt optional aufräumen.`
            : `Umzug von ${ablageLabel(run.src_backend)} nach ${ablageLabel(run.dst_backend)} ist noch nicht abgeschlossen.`}
        </p>
      </div>
      <Link to={`/ablage-umzug/${ziel}`} className={`text-xs underline underline-offset-2 whitespace-nowrap shrink-0 mt-0.5 ${
        nurAufraeumenOffen ? 'text-primary' : 'text-amber-600 dark:text-amber-400'}`}>
        {nurAufraeumenOffen ? 'Zum Aufräumen →' : 'Umzug fortsetzen →'}
      </Link>
    </div>
  );
}

// ── Exact Lucide SVG path data (lucide-react v0.468) ─────────────────────────
const ICON_PATHS = {
  FileText: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  Banknote: (
    <>
      <rect width="20" height="12" x="2" y="6" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  Scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </>
  ),
  BarChart3: (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </>
  ),
  Clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
  TriangleAlert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  FolderOpen: (
    <>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </>
  ),
  Scale: (
    <>
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10" />
      <path d="M12 3v18" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </>
  ),
  CalendarClock: (
    <>
      <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h5" />
      <circle cx="16" cy="16" r="6" />
      <path d="M16 14v2l1 1" />
    </>
  ),
};

const ICON_STOPS = {
  FileText:     ['#7c3aed', '#0d9488'],
  Banknote:     ['#6d28d9', '#0891b2'],
  Scissors:     ['#2cc5dd', '#9333ea'],
  BarChart3:    ['#7c3aed', '#0d9488'],
  Clock:        ['#2cc5dd', '#9333ea'],
  TriangleAlert:['#8b5cf6', '#14b8a6'],
  FolderOpen:   ['#7c3aed', '#2cc5dd'],
  Scale:        ['#7c3aed', '#0d9488'],
  CalendarClock: ['#7c3aed', '#0d9488'],
};

/**
 * Two overlaid SVG layers (blur glow + sharp) with gradient defs inlined per-SVG.
 * This avoids cross-SVG url() references and ensures all paths render correctly.
 */
function GradientIconDouble({ iconKey, svgClass, glowOpacity = 0.55, sharpOpacity = 0.30, blurPx = 10 }) {
  const uid = useId().replace(/:/g, '');
  const [c1, c2] = ICON_STOPS[iconKey];
  const glowId = `gi-g-${iconKey}-${uid}`;
  const sharpId = `gi-s-${iconKey}-${uid}`;
  const base = { viewBox: '0 0 24 24', fill: 'none', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' };
  const grad = (id) => (
    <defs>
      <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
        <stop offset="0%" stopColor={c1} />
        <stop offset="100%" stopColor={c2} />
      </linearGradient>
    </defs>
  );
  return (
    <>
      <svg {...base} stroke={`url(#${glowId})`} className={svgClass}
        style={{ opacity: glowOpacity, filter: `blur(${blurPx}px)` }} aria-hidden>
        {grad(glowId)}{ICON_PATHS[iconKey]}
      </svg>
      <svg {...base} stroke={`url(#${sharpId})`} className={svgClass}
        style={{ opacity: sharpOpacity }} aria-hidden>
        {grad(sharpId)}{ICON_PATHS[iconKey]}
      </svg>
    </>
  );
}

function FaelligkeitHint({ faelligkeit }) {
  if (!faelligkeit) return null;
  const due = new Date(faelligkeit);
  due.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return (
      <p className="text-xs font-bold text-red-600 mt-1">
        Überfällig seit {Math.abs(diffDays)} {Math.abs(diffDays) === 1 ? 'Tag' : 'Tagen'}
      </p>
    );
  }
  if (diffDays <= 7) {
    return (
      <p className="text-xs font-bold text-amber-600 mt-1">
        {diffDays === 0 ? 'Heute fällig!' : `Fällig in ${diffDays} ${diffDays === 1 ? 'Tag' : 'Tagen'}`}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground mt-1">
      Nächste Fälligkeit: {formatDate(faelligkeit)}
    </p>
  );
}

function StatCard({ iconKey, label, value, sub, to, valueClass, children }) {
  return (
    <Link to={to} className="group flex h-full">
      <Card className="card-hover relative overflow-hidden cursor-pointer flex flex-col w-full h-full">
        {/* Bottom-right double-layer gradient icon */}
        <div className="absolute -right-5 -bottom-5 pointer-events-none w-28 h-28" aria-hidden>
          <GradientIconDouble
            iconKey={iconKey}
            svgClass="absolute inset-0 w-full h-full"
            glowOpacity={0.55}
            sharpOpacity={0.30}
            blurPx={10}
          />
        </div>
        <CardHeader className="pb-2 relative">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        </CardHeader>
        <CardContent className="relative flex-1 flex flex-col justify-between">
          <div>
            <div className={`text-3xl font-bold tracking-tight ${valueClass || ''}`}>{value}</div>
            {sub && <p className="text-sm text-muted-foreground mt-0.5">{sub}</p>}
            {children}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const personenFilter = useDashboardPersonenFilter();
  const personenAuswahl = personenFilter.auswahl.length ? personenFilter.auswahl : null;
  const { data, isLoading, error } = useDashboardStats(personenAuswahl, personenFilter.bereit);
  const { data: appSettings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: personenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: saldenData } = useSaldenList();
  const showSalden = isAdmin || appSettings?.nav_visibility?.value?.salden !== false;
  const salden = showSalden ? (saldenData?.data || []) : [];
  const { data: wvDashboard = [] } = useWiedervorlagenDashboard(personenAuswahl, personenFilter.bereit);
  const instanceName = appSettings?.instance_name?.value?.trim();
  // Auch archivierte Versicherte halten die PKV-/Beihilfe-Historie sichtbar.
  const hasInsuredPerson = (personenData?.data ?? []).some((p) => p.pkv || p.beihilfe);

  const [sortMode, setSortMode] = useState(
    () => localStorage.getItem('dashboard-letzte-sort') || 'postid'
  );
  const [selectedLebensbereich, setSelectedLebensbereich] = useState(null);
  const [selectedDokumentart, setSelectedDokumentart] = useState(null);

  const stats = data;
  const maxEintraege = 8;
  const sortedEintraege = useMemo(() => {
    if (!stats) return [];
    let entries = [...(stats.letzteEintraege || [])];
    if (sortMode === 'briefdatum') {
      entries = entries.filter(e => e.briefdatum);
      entries.sort((a, b) => new Date(b.briefdatum) - new Date(a.briefdatum));
    } else {
      // sort by numeric PostID descending
      entries.sort((a, b) => {
        const na = parseInt(String(a.postid).replace(/\D/g, ''), 10);
        const nb = parseInt(String(b.postid).replace(/\D/g, ''), 10);
        return nb - na;
      });
    }
    return entries.slice(0, maxEintraege);
  }, [stats, sortMode, maxEintraege]);

  const dokumentartenFuerLebensbereich = useMemo(() => {
    if (!selectedLebensbereich) return [];
    return (stats?.nachLxd || []).filter((row) => row.lebensbereich === selectedLebensbereich);
  }, [stats, selectedLebensbereich]);

  const lebensbereicheFuerDokumentart = useMemo(() => {
    if (!selectedDokumentart) return [];
    return (stats?.nachLxd || []).filter((row) => row.dokumentart === selectedDokumentart);
  }, [stats, selectedDokumentart]);

  // Die Personenauswahl reist in Folgeansichten mit, die einen Personenfilter
  // kennen: Postbuch-Liste (Rolle Adressat, wie die Dashboard-Zählung) und
  // Kürzungen (behandelte Person). Leere Auswahl = kein Filter.
  const postbuchLink = (filter = {}) => {
    const params = new URLSearchParams(filter);
    if (personenAuswahl) {
      params.set('person', personenAuswahl.join(','));
      params.set('person_as_adressat', 'true');
      params.set('person_as_patient', 'false');
    }
    const qs = params.toString();
    return qs ? `/postbuch?${qs}` : '/postbuch';
  };
  const kuerzungenLink = personenAuswahl
    ? `/analyse/kuerzungen?${new URLSearchParams({ person: personenAuswahl.join(',') })}`
    : '/analyse/kuerzungen';

  const openPostbuch = ({ lebensbereich, dokumentart }) => {
    const filter = {};
    if (lebensbereich) filter.lebensbereich = lebensbereich;
    if (dokumentart) filter.dokumentart = dokumentart;
    navigate(postbuchLink(filter));
  };

  const handleSortChange = (mode) => {
    setSortMode(mode);
    localStorage.setItem('dashboard-letzte-sort', mode);
  };

  if (error && !data) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;
  // Ohne Daten auch dann laden, wenn die Abfrage noch auf die Personenliste wartet.
  if (isLoading || !data) return <PageLoader />;

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-8 max-w-6xl">
      {/* Page header */}
      <div>
        <GlowHeading>{instanceName ? `Dashboard ${instanceName}` : 'Dashboard'}</GlowHeading>
        <p className="text-muted-foreground mt-1">Übersicht über alle Dokumente und Aktivitäten.</p>
      </div>

      {/* Personenfilter: wirkt nur auf die Kennzahlen und Listen dieses Dashboards */}
      <PersonenFilter filter={personenFilter} />

      {/* Backup-Warnung: ganz oben, für alle Rollen sichtbar (Datenverlustrisiko) */}
      <BackupBanner />

      {/* KI-Warnung: Provider nicht erreichbar oder konfiguriertes Modell nicht
          mehr gelistet – früh, bevor die ersten Dokumente fehlschlagen */}
      <AiHealthBanner />

      {/* Fehler-Warnung (Banner): Neue fehlgeschlagene Dokumente seit letztem Logs-Besuch */}
      <UpdateBanner />

      <FailedDocumentsBanner />

      {/* Embedding-Warnung: Dokumente ohne semantisches Embedding */}
      <MissingEmbeddingsBanner />

      {/* Scan-Retry-Warnung: ausstehende oder dauerhaft fehlgeschlagene Uploads */}
      <ScanRetryBanner />

      {/* Duplikat-Entscheidungen + fehlgeschlagene Dokumente (sichtbar nur wenn vorhanden) */}
      <PendingDecisionsCard />
      <FailedDocumentsCard />

      {/* Dateiablage erreichbar?? Backend-agnostisch. */}
      <AblageBanner />

      {/* Migrationsassistent: offener Lauf (in Arbeit oder nur noch Aufräumen offen) */}
      <AktivMigrationBanner />

      {/* Mischbestand-Fallback: Reste in einem Fremd-Backend ohne aktiven Lauf */}
      <StorageMischbestandBanner />

      {/* Stat Cards */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 ${hasInsuredPerson ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-5 items-stretch`}>
        <StatCard
          iconKey="FileText"
          label="Dokumente gesamt"
          value={stats.totalDokumente}
          to={postbuchLink()}
        />
        <StatCard
          iconKey="Banknote"
          label="Unbezahlte Rechnungen"
          value={stats.unbezahlteRechnungen}
          sub={formatCurrency(stats.summeUnbezahlt)}
          to="/analyse/unbezahlt"
          valueClass="text-amber-600"
        >
          <FaelligkeitHint faelligkeit={stats.naechsteFaelligkeit} />
        </StatCard>
        {hasInsuredPerson && (
          <StatCard
            iconKey="Scissors"
            label="Kürzungen gesamt"
            value={formatCurrency(stats.kuerzungenGesamt)}
            to={kuerzungenLink}
            valueClass="text-red-500"
          />
        )}
        <StatCard
          iconKey="TriangleAlert"
          label="Reviews ausstehend"
          value={stats.nachStatus?.NeedsUserReview || 0}
          to={postbuchLink({ status: 'NeedsUserReview' })}
        />
      </div>

      {/* Wiedervorlagen (überfällig + fällig + 7 Tage) */}
      {wvDashboard.length > 0 && (
        <Card className="relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
            <GradientIconDouble
              iconKey="CalendarClock"
              svgClass="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4"
              glowOpacity={0.22}
              sharpOpacity={0.11}
              blurPx={15}
            />
          </div>
          <CardHeader className="pb-3 relative">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold">
                Wiedervorlagen ({wvDashboard.length})
              </CardTitle>
              <Link to="/analyse/wiedervorlagen" className="text-xs text-primary hover:underline">Alle WV →</Link>
            </div>
          </CardHeader>
          <CardContent className="relative">
            <div className="space-y-0">
              {wvDashboard.map((wv) => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const due = new Date(wv.faellig_am);
                due.setHours(0, 0, 0, 0);
                const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));
                const isOverdue = diffDays < 0;
                const isDueToday = diffDays === 0;
                const refId = wv.postid || wv.akteid;
                const linkTo = wv.postid ? `/postbuch/${wv.postid}` : `/akten/${wv.akteid}`;
                const betreff = wv.post_betreff || wv.akte_betreff || '–';

                return (
                  <Link
                    key={wv.wv_id}
                    to={linkTo}
                    className={`flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors ${
                      isOverdue ? 'bg-red-50/50' : isDueToday ? 'bg-amber-50/50' : ''
                    }`}
                  >
                    <span className={`font-mono text-xs w-20 tabular-nums flex-shrink-0 ${
                      isOverdue ? 'text-red-600 font-bold' : isDueToday ? 'text-amber-600 font-bold' : 'text-muted-foreground'
                    }`}>{formatDate(wv.faellig_am)}</span>
                    <span className="font-mono text-xs text-muted-foreground w-16 tabular-nums flex-shrink-0">{refId}</span>
                    <span className="text-sm truncate flex-1">{betreff}</span>
                    <span className="text-xs text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 truncate max-w-[200px] flex-shrink-0">{wv.aktion}</span>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Letzte Einträge: volle Breite, damit Betreff und beide LxD-Achsen lesbar bleiben. */}
      <Card className="relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
          <GradientIconDouble
            iconKey="Clock"
            svgClass="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1/2 h-full"
            glowOpacity={0.18}
            sharpOpacity={0.08}
            blurPx={15}
          />
        </div>
        <CardHeader className="pb-3 relative">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base font-semibold">Letzte Einträge</CardTitle>
            <div className="flex items-center bg-muted rounded-full p-0.5 text-xs shrink-0">
              <button onClick={() => handleSortChange('postid')} className={`px-2.5 py-0.5 rounded-full transition-all ${sortMode === 'postid' ? 'bg-background shadow text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}>nach PostID</button>
              <button onClick={() => handleSortChange('briefdatum')} className={`px-2.5 py-0.5 rounded-full transition-all ${sortMode === 'briefdatum' ? 'bg-background shadow text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}>Briefdatum</button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="relative">
          <div className="space-y-0">
            {sortedEintraege.map((entry, idx) => (
              <Link key={entry.postid} to={`/postbuch/${entry.postid}`} state={{ from: location.pathname, navList: sortedEintraege, navIndex: idx }} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                <span className="font-mono text-xs text-muted-foreground w-16 tabular-nums shrink-0">{entry.postid}</span>
                <LebensbereichBadge lebensbereich={entry.lebensbereich} compact />
                <ArtBadge art={entry.dokumentart || entry.art} />
                <span className="text-sm truncate flex-1">{entry.betreff || entry.kontakt || '–'}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(entry.briefdatum)}</span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Nach Lebensbereich */}
        <Card className="relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
            <GradientIconDouble iconKey="FolderOpen" svgClass="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4" glowOpacity={0.22} sharpOpacity={0.11} blurPx={15} />
          </div>
          <CardHeader className="pb-3 relative">
            <div className="flex min-h-8 items-center gap-3">
              <CardTitle className="text-base font-semibold">Nach Lebensbereich</CardTitle>
              {selectedLebensbereich && (
                <button type="button" onClick={() => setSelectedLebensbereich(null)} title="Auswahl zurücksetzen" className="rounded-md transition-transform hover:scale-[1.03]">
                  <LebensbereichBadge lebensbereich={selectedLebensbereich} large back />
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="relative">
            {!selectedLebensbereich ? (
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-0">
                {Object.entries(stats.nachLebensbereich || {}).map(([lebensbereich, count]) => (
                  <button type="button" key={lebensbereich} onClick={() => setSelectedLebensbereich(lebensbereich)} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                    <LebensbereichBadge lebensbereich={lebensbereich} />
                    <span className="text-sm font-mono font-semibold tabular-nums">{count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-0">
                <button type="button" onClick={() => openPostbuch({ lebensbereich: selectedLebensbereich })} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                  <span className="inline-flex h-6 items-center rounded-md border border-zinc-950 bg-zinc-950 px-2.5 text-xs font-semibold text-white">Alle Dokumenttypen</span>
                  <span className="text-sm font-mono font-semibold tabular-nums">{stats.nachLebensbereich?.[selectedLebensbereich] || 0}</span>
                </button>
                {dokumentartenFuerLebensbereich.map(({ dokumentart, count }) => (
                  <button type="button" key={dokumentart} onClick={() => openPostbuch({ lebensbereich: selectedLebensbereich, dokumentart })} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                    <ArtBadge art={dokumentart} />
                    <span className="text-sm font-mono font-semibold tabular-nums">{count}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Nach Dokumentart */}
        <Card className="relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
            <GradientIconDouble
              iconKey="BarChart3"
              svgClass="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4"
              glowOpacity={0.22}
              sharpOpacity={0.11}
              blurPx={15}
            />
          </div>
          <CardHeader className="pb-3 relative">
            <div className="flex min-h-8 items-center gap-3">
              <CardTitle className="text-base font-semibold">Nach Dokumenttyp</CardTitle>
              {selectedDokumentart && (
                <button type="button" onClick={() => setSelectedDokumentart(null)} title="Auswahl zurücksetzen" className="rounded-md transition-transform hover:scale-[1.03]">
                  <ArtBadge art={selectedDokumentart} large back />
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="relative">
            {!selectedDokumentart ? (
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-0">
                {Object.entries(stats.nachArt || {}).map(([art, count]) => (
                  <button type="button" key={art} onClick={() => setSelectedDokumentart(art)} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                    <ArtBadge art={art} />
                    <span className="text-sm font-mono font-semibold tabular-nums">{count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-0">
                <button type="button" onClick={() => openPostbuch({ dokumentart: selectedDokumentart })} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                  <span className="inline-flex h-6 items-center rounded-md border border-zinc-950 bg-zinc-950 px-2.5 text-xs font-semibold text-white">Alle Lebensbereiche</span>
                  <span className="text-sm font-mono font-semibold tabular-nums">{stats.nachArt?.[selectedDokumentart] || 0}</span>
                </button>
                {lebensbereicheFuerDokumentart.map(({ lebensbereich, count }) => (
                  <button type="button" key={lebensbereich} onClick={() => openPostbuch({ lebensbereich, dokumentart: selectedDokumentart })} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors">
                    <LebensbereichBadge lebensbereich={lebensbereich} />
                    <span className="text-sm font-mono font-semibold tabular-nums">{count}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

      </div>

      {/* Salden */}
      {salden.length > 0 && (
        <Card className="relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
            <GradientIconDouble
              iconKey="Scale"
              svgClass="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4"
              glowOpacity={0.22}
              sharpOpacity={0.11}
              blurPx={15}
            />
          </div>
          <CardHeader className="pb-3 relative">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold">Salden</CardTitle>
              <Link to="/analyse/salden" className="text-xs text-primary hover:underline">Alle Salden →</Link>
            </div>
          </CardHeader>
          <CardContent className="relative">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {salden.map((s) => {
                const val = parseFloat(s.aktueller_saldo) || 0;
                const isPos = val >= 0;
                return (
                  <Link
                    key={s.saldo_id}
                    to={`/analyse/salden/${s.saldo_id}`}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border/50 hover:bg-primary/[0.04] hover:border-primary/30 transition-all"
                  >
                    <span className="text-sm truncate">{s.name}</span>
                    <span className={`font-mono text-sm font-semibold tabular-nums flex-shrink-0 ${
                      isPos ? 'text-emerald-600' : 'text-red-600'
                    }`}>{formatCurrency(val)}</span>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Letzte Akten */}
      {stats.letzteAkten?.length > 0 && (
        <Card className="relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
            <GradientIconDouble
              iconKey="FolderOpen"
              svgClass="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4"
              glowOpacity={0.22}
              sharpOpacity={0.11}
              blurPx={15}
            />
          </div>
          <CardHeader className="pb-3 relative">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold">Letzte Akten</CardTitle>
              <Link to="/akten" className="text-xs text-primary hover:underline">Alle Akten →</Link>
            </div>
          </CardHeader>
          <CardContent className="relative">
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-0">
              {stats.letzteAkten.map((akte) => (
                <Link
                  key={akte.akteid}
                  to={`/akten/${akte.akteid}`}
                  className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-primary/[0.04] transition-colors"
                >
                  <span className="font-mono text-xs text-muted-foreground w-16 tabular-nums">{akte.akteid}</span>
                  <span className="text-sm truncate flex-1">{akte.betreff}</span>
                  <span className="text-sm font-mono font-semibold tabular-nums">{akte.dok_count}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(akte.updated_at)}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

